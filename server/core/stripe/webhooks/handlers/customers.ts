import Stripe from 'stripe';
import { getStripeClient } from '../../client';
import { db } from '../../../../db';
import { sql } from 'drizzle-orm';
import { notifyMember, notifyAllStaff } from '../../../notificationService';
import { logger } from '../../../logger';
import { logSystemAction } from '../../../auditLog';
import type { PoolClient } from 'pg';
import type { DeferredAction } from '../types';
import { getErrorMessage } from '../../../../utils/errorUtils';

export async function handleCustomerUpdated(client: PoolClient, customer: Stripe.Customer): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const stripeCustomerId = customer.id;
    const stripeEmail = customer.email?.toLowerCase();
    const stripeName = customer.name;

    if (!stripeEmail) {
      logger.warn(`[Stripe Webhook] customer.updated: customer ${stripeCustomerId} has no email — skipping sync`);
      return deferredActions;
    }

    const result = await client.query(
      `SELECT id, email, first_name, last_name, archived_at, membership_status, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [stripeCustomerId]
    );

    if (result.rows.length === 0) {
      logger.info(`[Stripe Webhook] customer.updated: no local user for Stripe customer ${stripeCustomerId}`);
      return deferredActions;
    }

    const user = result.rows[0];
    const currentEmail = user.email?.toLowerCase();
    const updates: string[] = [];

    if ((currentEmail && currentEmail.includes('.merged.')) || user.archived_at || user.membership_status === 'merged') {
      await client.query('UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1', [user.id]);
      logger.info(`[Stripe Webhook] customer.updated: cleared stripe_customer_id from archived/merged user ${currentEmail} (${stripeCustomerId})`);
      return deferredActions;
    }

    if (currentEmail && stripeEmail !== currentEmail) {
      const activeMatch = await client.query(
        `SELECT id, email, stripe_customer_id FROM users WHERE LOWER(email) = $1 AND archived_at IS NULL AND membership_status NOT IN ('merged', 'terminated') LIMIT 2`,
        [stripeEmail]
      );

      const stripeEmailUser = activeMatch.rows.find((r: { email: string }) => r.email.toLowerCase() === stripeEmail);
      const stripeEmailUserOwnsThisCustomer = stripeEmailUser?.stripe_customer_id === stripeCustomerId;

      if (stripeEmailUserOwnsThisCustomer) {
        logger.info(`[Stripe Webhook] customer.updated: Stripe email ${stripeEmail} belongs to user who owns this customer ${stripeCustomerId}. This is the rightful owner — clearing stale link from ${currentEmail}.`);
        await client.query('UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE stripe_customer_id = $1 AND LOWER(email) != $2', [stripeCustomerId, stripeEmail]);
        updates.push(`stale_link_cleared (${currentEmail} → rightful owner ${stripeEmail})`);

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Stripe Customer Reassigned',
              `Stripe customer ${stripeCustomerId} was incorrectly linked to ${currentEmail} but belongs to ${stripeEmail}. The stale link has been cleared automatically.`,
              'billing_alert',
              { sendPush: true }
            );
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to send reassignment notification:', { error: getErrorMessage(err) });
          }
        });
      } else if (stripeEmailUser && (!stripeEmailUser.stripe_customer_id || stripeEmailUser.stripe_customer_id === stripeCustomerId)) {
        logger.warn(`[Stripe Webhook] customer.updated: Stripe email change for ${stripeCustomerId} matches existing unlinked user ${stripeEmailUser.email}. Auto-reassignment BLOCKED — flagging for manual review.`);
        
        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Stripe Customer Email Change — Action Required',
              `Stripe customer ${stripeCustomerId} (currently ${currentEmail}) changed their email to ${stripeEmail}, which matches existing member ${stripeEmailUser.email} (no Stripe customer linked). Auto-reassignment was blocked for security. Please verify and update manually if this is legitimate.`,
              'billing_alert',
              { sendPush: true }
            );
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to send reassignment alert:', { error: getErrorMessage(err) });
          }
        });
        updates.push(`auto_reassignment_blocked (stripe_email=${stripeEmail} matches unlinked ${stripeEmailUser.email})`);
      } else if (activeMatch.rows.length > 1) {
        logger.warn(`[Stripe Webhook] customer.updated: multiple active users match Stripe email ${stripeEmail} — skipping all auto-actions, notifying staff`);
        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Stripe Customer Email Change — Multiple Matches Found',
              `Stripe customer ${stripeCustomerId} (currently ${currentEmail}) changed their email to ${stripeEmail}, but multiple active users share that email. No automatic action was taken. Please investigate and resolve manually.`,
              'billing_alert',
              { sendPush: true }
            );
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to send multiple-match alert:', { error: getErrorMessage(err) });
          }
        });
        updates.push(`multi_match_blocked (stripe_email=${stripeEmail})`);
        return deferredActions;
      } else {
        logger.warn(`[Stripe Webhook] customer.updated: email mismatch for customer ${stripeCustomerId}: Stripe has ${stripeEmail}, app has ${currentEmail}. No matching user for Stripe email — auto-correcting Stripe to match app.`);
        
        deferredActions.push(async () => {
          try {
            const stripeClient = await getStripeClient();
            await stripeClient.customers.update(stripeCustomerId, { email: currentEmail });
            logger.info(`[Stripe Webhook] Auto-corrected Stripe customer ${stripeCustomerId} email from ${stripeEmail} to ${currentEmail}`);
            await notifyAllStaff(
              'Stripe Email Auto-Corrected',
              `Member ${user.display_name || currentEmail} had a different email in Stripe (${stripeEmail}). It has been automatically corrected to match the app email (${currentEmail}).`,
              'billing_alert',
              { sendPush: false }
            );
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to auto-correct Stripe email:', { error: getErrorMessage(err) });
            try {
              await notifyAllStaff(
                'Stripe Email Mismatch — Auto-Correct Failed',
                `Member ${user.display_name || currentEmail} has a different email in Stripe (${stripeEmail}) than in the app (${currentEmail}). Auto-correction failed — please update manually.`,
                'billing_alert',
                { sendPush: true }
              );
            } catch (notifyErr: unknown) {
              logger.error('[Stripe Webhook] Failed to send email mismatch fallback notification', { error: getErrorMessage(notifyErr) });
            }
          }
        });
        updates.push(`email_auto_corrected (stripe=${stripeEmail} → app=${currentEmail})`);
      }
    }

    if (stripeName && !stripeName.includes('@')) {
      const nameParts = stripeName.split(' ');
      const stripeFirst = nameParts[0] || '';
      const stripeLast = nameParts.slice(1).join(' ') || '';
      const currentDisplayName = user.display_name || `${user.first_name || ''} ${user.last_name || ''}`.trim();
      
      if (stripeName !== currentDisplayName) {
        const updateFields: string[] = ['updated_at = NOW()'];
        const updateValues: (string | null)[] = [];
        let paramIdx = 1;

        if (stripeFirst && stripeFirst !== user.first_name) {
          updateFields.push(`first_name = $${paramIdx}`);
          updateValues.push(stripeFirst);
          paramIdx++;
        }
        if (stripeLast !== (user.last_name || '')) {
          updateFields.push(`last_name = $${paramIdx}`);
          updateValues.push(stripeLast || null);
          paramIdx++;
        }

        if (updateValues.length > 0) {
          updateValues.push(user.id);
          await client.query(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`,
            updateValues
          );
        }
        updates.push(`name synced: "${currentDisplayName}" → "${stripeName}"`);
      }
    }

    if (updates.length > 0) {
      logger.info(`[Stripe Webhook] customer.updated for ${stripeCustomerId}: ${updates.join(', ')}`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling customer.updated:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handlePaymentMethodAttached(client: PoolClient, paymentMethod: Stripe.PaymentMethod): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof paymentMethod.customer === 'string' ? paymentMethod.customer : paymentMethod.customer?.id;
    if (!customerId) return deferredActions;

    logger.info(`[Stripe Webhook] Payment method attached: ${paymentMethod.id} (${paymentMethod.type}) to customer ${customerId}`);

    const retryResult = await client.query(
      `SELECT stripe_payment_intent_id FROM stripe_payment_intents 
       WHERE stripe_customer_id = $1 
         AND requires_card_update = TRUE 
         AND status IN ('requires_payment_method', 'requires_action', 'failed')`,
      [customerId]
    );

    if (retryResult.rowCount && retryResult.rowCount > 0) {
      logger.info(`[Stripe Webhook] Found ${retryResult.rowCount} payment intents to retry for customer ${customerId}`);
      
      for (const row of retryResult.rows) {
        deferredActions.push(async () => {
          try {
            const { getStripeClient } = await import('../../client');
            const stripe = await getStripeClient();
            const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, { expand: ['invoice'] });
            if (pi.status === 'requires_payment_method') {
              const invoiceObj = (pi as unknown as { invoice: string | { id: string } | null }).invoice;
              const invoiceId = typeof invoiceObj === 'string' ? invoiceObj : invoiceObj?.id;

              let retrySucceeded = false;
              if (invoiceId) {
                const invoice = await stripe.invoices.retrieve(invoiceId);
                if (invoice.status === 'open') {
                  const paidInvoice = await stripe.invoices.pay(invoiceId, {
                    payment_method: paymentMethod.id,
                  });
                  retrySucceeded = paidInvoice.status === 'paid';
                  logger.info(`[Stripe Webhook] Auto-retried invoice payment ${row.stripe_payment_intent_id} via invoices.pay`, { extra: { invoiceId, result: paidInvoice.status } });
                } else {
                  logger.warn(`[Stripe Webhook] Cannot auto-retry invoice ${invoiceId} — status is ${invoice.status}`);
                }
              } else {
                const confirmed = await stripe.paymentIntents.confirm(row.stripe_payment_intent_id, {
                  payment_method: paymentMethod.id,
                });
                retrySucceeded = confirmed.status === 'succeeded' || confirmed.status === 'processing';
                if (!retrySucceeded) {
                  logger.warn(`[Stripe Webhook] Auto-retry of ${row.stripe_payment_intent_id} resulted in status: ${confirmed.status}, keeping requires_card_update flag`);
                }
              }

              if (retrySucceeded) {
                await db.execute(sql`UPDATE stripe_payment_intents SET requires_card_update = FALSE, updated_at = NOW() WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id}`);
                logger.info(`[Stripe Webhook] Auto-retried payment ${row.stripe_payment_intent_id} successfully, cleared requires_card_update`);
              }
            }
          } catch (retryErr: unknown) {
            logger.error(`[Stripe Webhook] Failed to auto-retry payment ${row.stripe_payment_intent_id}:`, { error: getErrorMessage(retryErr) });
            try {
              await db.execute(sql`
                INSERT INTO system_alerts (severity, category, message, details, created_at)
                VALUES (
                  'critical',
                  'payment',
                  ${`Auto-retry of payment ${row.stripe_payment_intent_id} failed for customer ${customerId}. Manual recovery required.`},
                  ${JSON.stringify({ paymentIntentId: row.stripe_payment_intent_id, customerId, paymentMethodId: paymentMethod.id, error: getErrorMessage(retryErr) })}::text,
                  NOW()
                )
                ON CONFLICT DO NOTHING
              `);
            } catch (alertErr: unknown) {
              logger.error('[Stripe Webhook] Failed to record payment retry failure alert', { error: getErrorMessage(alertErr) });
            }
          }
        });
      }
    }

    const memberResult = await client.query(
      `SELECT email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (memberResult.rows.length > 0 && retryResult.rowCount && retryResult.rowCount > 0) {
      const member = memberResult.rows[0];
      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail: member.email,
            title: 'Payment Method Updated',
            message: 'Your new payment method has been added successfully. Any pending payments will be retried automatically.',
            type: 'billing',
          }, { sendPush: false });
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to send payment method notification:', { error: getErrorMessage(err) });
        }
      });
    }

    if (memberResult.rows.length > 0) {
      const memberForMigration = memberResult.rows[0];
      const billingCheck = await client.query(
        `SELECT billing_provider FROM users WHERE stripe_customer_id = $1 AND billing_provider = 'mindbody' LIMIT 1`,
        [customerId]
      );
      if (billingCheck.rows.length > 0) {
        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'MindBody Member Card Saved',
              `MindBody member ${memberForMigration.display_name} now has a card on file — eligible for Stripe migration`,
              'billing_migration'
            );
            logger.info('[Stripe Webhook] Notified staff: MindBody member card saved via payment_method.attached', { extra: { email: memberForMigration.email } });
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to notify staff about MindBody member card save:', { error: getErrorMessage(err) });
          }
        });
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling payment_method.attached:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleCustomerCreated(client: PoolClient, customer: Stripe.Customer): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const email = customer.email?.toLowerCase();
    if (!email) {
      logger.info(`[Stripe Webhook] customer.created ${customer.id} has no email, skipping user lookup`);
      return deferredActions;
    }

    const userResult = await client.query(
      `SELECT id, email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name, stripe_customer_id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] customer.created ${customer.id} - no matching user for ${email} (may be created before checkout completes)`);
      return deferredActions;
    }

    const user = userResult.rows[0];

    if (!user.stripe_customer_id) {
      const isAuthenticatedCustomer = customer.metadata?.source === 'app' || customer.metadata?.userId;
      if (!isAuthenticatedCustomer) {
        logger.warn(`[Stripe Webhook] Blocking unauthenticated Stripe customer link for user ${user.id} (${user.email}) — customer ${customer.id} was created without app authentication. Notifying staff.`);
        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Unauthenticated Stripe Customer Link Blocked',
              `A Stripe customer (${customer.id}) was created with email ${user.email} via a public checkout, but auto-linking was blocked for security. If this is legitimate, manually link the customer in the admin panel.`,
              'billing'
            );
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to notify staff about blocked customer link:', { error: getErrorMessage(err) });
          }
        });
      } else {
        const linkResult = await client.query(
          `UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL RETURNING id`,
          [customer.id, user.id]
        );
        if (linkResult.rowCount === 0) {
          logger.warn(`[Stripe Webhook] Race condition: user ${user.id} already has a stripe_customer_id (concurrent link). Skipping.`);
          return deferredActions;
        }
        logger.info(`[Stripe Webhook] Linked Stripe customer ${customer.id} to user ${user.id} (${user.email})`);

        deferredActions.push(async () => {
          try {
            await logSystemAction({
              action: 'stripe_customer_linked',
              resourceType: 'user',
              resourceId: user.id,
              details: { stripeCustomerId: customer.id, email: user.email },
            });
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to log stripe_customer_linked:', { error: getErrorMessage(err) });
          }
        });
      }
    } else if (user.stripe_customer_id !== customer.id) {
      logger.warn(`[Stripe Webhook] Duplicate Stripe customer detected for user ${user.id} (${user.email}): existing=${user.stripe_customer_id}, new=${customer.id}`);

      deferredActions.push(async () => {
        try {
          await notifyAllStaff(
            'Duplicate Stripe Customer Detected',
            `User ${user.display_name || user.email} already has Stripe customer ${user.stripe_customer_id}, but a new customer ${customer.id} was created with the same email. Please investigate.`,
            'billing'
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify staff about duplicate customer:', { error: getErrorMessage(err) });
        }
      });

      deferredActions.push(async () => {
        try {
          await logSystemAction({
            action: 'stripe_customer_linked',
            resourceType: 'user',
            resourceId: user.id,
            details: { stripeCustomerId: customer.id, existingCustomerId: user.stripe_customer_id, duplicate: true, email: user.email },
          });
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to log duplicate customer action:', { error: getErrorMessage(err) });
        }
      });
    } else {
      logger.info(`[Stripe Webhook] customer.created ${customer.id} - user ${user.id} already linked to this customer`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling customer.created:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleCustomerDeleted(client: PoolClient, customer: Stripe.Customer): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = customer.id;
    logger.info(`[Stripe Webhook] customer.deleted ${customerId} (deleted flag: ${'deleted' in customer ? true : false})`);

    const userResult = await client.query(
      `SELECT id, email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] customer.deleted ${customerId} - no matching user found`);
      return deferredActions;
    }

    const user = userResult.rows[0];

    await client.query(
      `UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL, billing_provider = NULL WHERE id = $1`,
      [user.id]
    );

    logger.info(`[Stripe Webhook] Cleared billing fields for user ${user.id} (${user.email}) after Stripe customer deletion`);

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Stripe Customer Deleted',
          `${user.display_name || user.email} - their Stripe customer was deleted externally. Billing is now disconnected.`,
          'billing',
          { sendPush: true }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about customer deletion:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'stripe_customer_deleted',
          resourceType: 'user',
          resourceId: user.id,
          details: { stripeCustomerId: customerId, email: user.email, displayName: user.display_name },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log customer deletion:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling customer.deleted:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handlePaymentMethodDetached(client: PoolClient, paymentMethod: Stripe.PaymentMethod): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof paymentMethod.customer === 'string'
      ? paymentMethod.customer
      : paymentMethod.customer?.id;

    if (!customerId) {
      logger.info(`[Stripe Webhook] payment_method.detached ${paymentMethod.id} - no customer associated`);
      return deferredActions;
    }

    const userResult = await client.query(
      `SELECT id, email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] payment_method.detached ${paymentMethod.id} - no matching user for customer ${customerId}`);
      return deferredActions;
    }

    const user = userResult.rows[0];

    let hasRemainingMethods = true;
    try {
      const stripe = await getStripeClient();
      const methods = await Promise.race([
        stripe.paymentMethods.list({ customer: customerId, limit: 1 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stripe paymentMethods.list timed out after 5s')), 5000))
      ]) as Stripe.ApiList<Stripe.PaymentMethod>;
      hasRemainingMethods = methods.data.length > 0;
    } catch (stripeErr: unknown) {
      logger.error('[Stripe Webhook] Failed to check remaining payment methods:', { error: getErrorMessage(stripeErr) });
    }

    if (!hasRemainingMethods) {
      await client.query(
        `UPDATE users SET requires_card_update = true WHERE id = $1`,
        [user.id]
      );
      logger.info(`[Stripe Webhook] No remaining payment methods for user ${user.id} (${user.email}), set requires_card_update = true`);

      deferredActions.push(async () => {
        try {
          await notifyAllStaff(
            'Payment Method Removed - No Methods Remaining',
            `${user.display_name || user.email} has no remaining payment methods after detachment of ${paymentMethod.id}. They have been flagged for card update.`,
            'billing'
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify staff about payment method detach:', { error: getErrorMessage(err) });
        }
      });
    }

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: user.email,
          title: 'Payment Method Removed',
          message: 'Your payment method was removed. Please add a new one to avoid billing issues.',
          type: 'payment_method_update',
        }, { sendPush: false });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify member about payment method detach:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling payment_method.detached:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handlePaymentMethodUpdated(client: PoolClient, paymentMethod: Stripe.PaymentMethod): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof paymentMethod.customer === 'string'
      ? paymentMethod.customer
      : paymentMethod.customer?.id;

    if (!customerId) {
      logger.info(`[Stripe Webhook] payment_method.updated ${paymentMethod.id} - no customer associated`);
      return deferredActions;
    }

    const userResult = await client.query(
      `SELECT id, email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] payment_method.updated ${paymentMethod.id} - no matching user for customer ${customerId}`);
      return deferredActions;
    }

    const user = userResult.rows[0];

    if (paymentMethod.type === 'card' && paymentMethod.card) {
      const { exp_month, exp_year, last4 } = paymentMethod.card;
      const now = new Date();
      const expiryDate = new Date(exp_year, exp_month - 1);
      const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      if (expiryDate <= thirtyDaysFromNow) {
        deferredActions.push(async () => {
          try {
            await notifyMember({
              userEmail: user.email,
              title: 'Card Expiring Soon',
              message: `Your card ending in ${last4} expires soon. Please update your payment method.`,
              type: 'card_expiring',
            }, { sendPush: false });
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to notify member about expiring card:', { error: getErrorMessage(err) });
          }
        });

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Member Card Expiring Soon',
              `${user.display_name || user.email}'s card ending in ${last4} expires soon (${exp_month}/${exp_year}).`,
              'billing'
            );
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to notify staff about expiring card:', { error: getErrorMessage(err) });
          }
        });
      }
    }

    logger.info(`[Stripe Webhook] payment_method.updated ${paymentMethod.id} for user ${user.id} (${user.email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling payment_method.updated:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handlePaymentMethodAutoUpdated(client: PoolClient, paymentMethod: Stripe.PaymentMethod): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof paymentMethod.customer === 'string'
      ? paymentMethod.customer
      : paymentMethod.customer?.id;

    if (!customerId) {
      logger.info(`[Stripe Webhook] payment_method auto-updated ${paymentMethod.id} - no customer associated`);
      return deferredActions;
    }

    const userResult = await client.query(
      `SELECT id, email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name, requires_card_update FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] payment_method auto-updated ${paymentMethod.id} - no matching user for customer ${customerId}`);
      return deferredActions;
    }

    const user = userResult.rows[0];

    if (user.requires_card_update) {
      await client.query(
        `UPDATE users SET requires_card_update = false WHERE id = $1`,
        [user.id]
      );
      logger.info(`[Stripe Webhook] Cleared requires_card_update for user ${user.id} after auto-update`);
    }

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: user.email,
          title: 'Card Details Auto-Updated',
          message: 'Your card details were automatically updated by your bank. No action needed.',
          type: 'billing_alert',
        }, { sendPush: false });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify member about auto-updated card:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'payment_method_auto_updated',
          resourceType: 'user',
          resourceId: user.id,
          details: { paymentMethodId: paymentMethod.id, stripeCustomerId: customerId, email: user.email },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log auto-updated payment method:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Payment Method Auto-Updated',
          `${user.display_name || user.email}'s card was automatically updated by their bank (payment method ${paymentMethod.id}).`,
          'billing'
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about auto-updated card:', { error: getErrorMessage(err) });
      }
    });

    logger.info(`[Stripe Webhook] payment_method auto-updated ${paymentMethod.id} for user ${user.id} (${user.email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling payment_method auto-updated:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleSetupIntentSucceeded(client: PoolClient, setupIntent: Stripe.SetupIntent): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id || null;
    if (!customerId) {
      logger.info(`[Stripe Webhook] setup_intent.succeeded ${setupIntent.id} has no customer, skipping`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Setup intent succeeded: ${setupIntent.id}, customer: ${customerId}`);

    const userResult = await client.query(
      `SELECT id, email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name, requires_card_update FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] setup_intent.succeeded — no user found for customer ${customerId}`);
      return deferredActions;
    }

    const user = userResult.rows[0];

    if (user.requires_card_update) {
      await client.query(
        `UPDATE users SET requires_card_update = false, updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      logger.info(`[Stripe Webhook] Cleared requires_card_update for user ${user.email} (setup intent succeeded)`);
    }

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: user.email,
          title: 'Payment Method Saved',
          message: 'Your payment method has been saved successfully.',
          type: 'billing_alert',
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify member about setup intent success:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'setup_intent_succeeded',
          resourceType: 'setup_intent',
          resourceId: setupIntent.id,
          details: {
            email: user.email,
            customerId,
            clearedCardUpdate: user.requires_card_update || false,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log setup intent success:', { error: getErrorMessage(err) });
      }
    });

  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling setup_intent.succeeded:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleSetupIntentFailed(client: PoolClient, setupIntent: Stripe.SetupIntent): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id || null;
    if (!customerId) {
      logger.info(`[Stripe Webhook] setup_intent.setup_failed ${setupIntent.id} has no customer, skipping`);
      return deferredActions;
    }

    const errorMessage = setupIntent.last_setup_error?.message || 'Unknown error';

    logger.info(`[Stripe Webhook] Setup intent failed: ${setupIntent.id}, customer: ${customerId}, error: ${errorMessage}`);

    const userResult = await client.query(
      `SELECT email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    const userEmail = userResult.rows[0]?.email;
    const displayEmail = userEmail || customerId;

    if (userEmail) {
      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail,
            title: 'Payment Method Failed',
            message: `We couldn't save your payment method: ${errorMessage}. Please try again.`,
            type: 'payment_failed',
          });
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify member about setup intent failure:', { error: getErrorMessage(err) });
        }
      });
    }

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Setup Intent Failed',
          `Payment method setup failed for ${displayEmail}. Error: ${errorMessage}. Setup Intent: ${setupIntent.id}`,
          'billing',
          { sendPush: false }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about setup intent failure:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'setup_intent_failed',
          resourceType: 'setup_intent',
          resourceId: setupIntent.id,
          details: {
            email: displayEmail,
            customerId,
            error: errorMessage,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log setup intent failure:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling setup_intent.setup_failed:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}
