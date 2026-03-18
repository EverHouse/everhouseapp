import Stripe from 'stripe';
import { getStripeClient } from '../../client';
import { syncCompanyToHubSpot } from '../../../hubspot';
import { db } from '../../../../db';
import { sql } from 'drizzle-orm';
import { notifyMember, notifyAllStaff } from '../../../notificationService';
import { sendPaymentReceiptEmail } from '../../../../emails/paymentEmails';
import { sendPassWithQrEmail } from '../../../../emails/passEmails';
import { broadcastBillingUpdate, broadcastDayPassUpdate } from '../../../websocket';
import { recordDayPassPurchaseFromWebhook } from '../../../../routes/dayPasses';
import { logSystemAction } from '../../../auditLog';
import { logger } from '../../../logger';
import { getErrorMessage } from '../../../../utils/errorUtils';
import type { PoolClient } from 'pg';
import type { DeferredAction } from '../types';
import { upsertTransactionCache } from '../framework';
import { normalizeTierName } from '../../../../utils/tierUtils';
import { sendPassUpdateForMemberByEmail } from '../../../../walletPass/apnPushService';

export async function handleCheckoutSessionCompleted(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    if (session.metadata?.purpose === 'add_funds') {
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
      const amountCents = parseInt(session.metadata.amountCents || '0', 10);
      const memberEmail = session.metadata.memberEmail;
      const amountDollars = amountCents / 100;
      
      logger.info(`[Stripe Webhook] Processing add_funds checkout: $${amountDollars.toFixed(2)} for ${memberEmail} (session: ${session.id})`);
      
      if (!customerId) {
        logger.error(`[Stripe Webhook] add_funds failed: No customer ID in session ${session.id}`);
        return deferredActions;
      }
      
      if (amountCents <= 0) {
        logger.error(`[Stripe Webhook] add_funds failed: Invalid amount ${amountCents} in session ${session.id}`);
        return deferredActions;
      }
      
      if (!memberEmail) {
        logger.error(`[Stripe Webhook] add_funds failed: No memberEmail in session ${session.id}`);
        return deferredActions;
      }
      
      const userResult = await client.query(
        'SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)',
        [memberEmail]
      );
      const memberName = userResult.rows[0]
        ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || memberEmail
        : memberEmail;

      const stripe = await getStripeClient();
      const transaction = await Promise.race([
        stripe.customers.createBalanceTransaction(
          customerId,
          { amount: -amountCents, currency: 'usd', description: `Account balance top-up via checkout (${session.id})` },
          { idempotencyKey: `add_funds_${session.id}` }
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stripe balance transaction timed out after 5s')), 5000))
      ]);
      const newBalanceDollars = Math.abs(transaction.ending_balance) / 100;
      logger.info(`[Stripe Webhook] Successfully added $${amountDollars.toFixed(2)} to balance for ${memberEmail}. New balance: $${newBalanceDollars.toFixed(2)}`);

      const deferredAmountDollars = amountDollars;
      const deferredMemberEmail = memberEmail;
      const deferredMemberName = memberName;
      const deferredSessionId = session.id;
      const deferredAmountCents = amountCents;
      const deferredNewBalance = transaction.ending_balance;

      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail: deferredMemberEmail,
            title: 'Funds Added Successfully',
            message: `$${deferredAmountDollars.toFixed(2)} has been added to your account balance. New balance: $${newBalanceDollars.toFixed(2)}`,
            type: 'funds_added',
          }, { sendPush: true });

          await notifyAllStaff(
            'Member Added Funds',
            `${deferredMemberName} (${deferredMemberEmail}) added $${deferredAmountDollars.toFixed(2)} to their account balance.`,
            'funds_added',
            { sendPush: true }
          );

          await sendPaymentReceiptEmail(deferredMemberEmail, {
            memberName: deferredMemberName,
            amount: deferredAmountDollars,
            description: 'Account Balance Top-Up',
            date: new Date(),
            transactionId: deferredSessionId
          });

          logger.info(`[Stripe Webhook] All notifications sent for add_funds: ${deferredMemberEmail}`);

          broadcastBillingUpdate({
            action: 'balance_updated',
            memberEmail: deferredMemberEmail,
            amountCents: deferredAmountCents,
            newBalance: deferredNewBalance
          });
        } catch (notifyError: unknown) {
          logger.error(`[Stripe Webhook] Deferred add_funds notifications failed for ${deferredMemberEmail}:`, { extra: { detail: getErrorMessage(notifyError) } });
        }
      });

      return deferredActions;
    }
    
    const companyName = session.metadata?.company_name;
    const userEmail = session.metadata?.purchaser_email || session.customer_email;
    
    if (companyName && userEmail) {
      logger.info(`[Stripe Webhook] Processing company sync for "${companyName}" (${userEmail})`);
      
      try {
        const companyResult = await Promise.race([
          syncCompanyToHubSpot({
            companyName,
            userEmail
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('HubSpot company sync timed out after 5s')), 5000))
        ]);

        if (companyResult.success && companyResult.hubspotCompanyId) {
          logger.info(`[Stripe Webhook] Company synced to HubSpot: ${companyResult.hubspotCompanyId} (created: ${companyResult.created})`);
          
          await client.query(
            `UPDATE users SET hubspot_company_id = $1, company_name = $2, updated_at = NOW() WHERE email = $3`,
            [companyResult.hubspotCompanyId, companyName, userEmail.toLowerCase()]
          );
          
          await client.query(
            `UPDATE billing_groups SET hubspot_company_id = $1, company_name = $2, updated_at = NOW() WHERE primary_email = $3`,
            [companyResult.hubspotCompanyId, companyName, userEmail.toLowerCase()]
          );
          
          logger.info(`[Stripe Webhook] Updated user and billing_group with HubSpot company ID`);
        } else if (!companyResult.success) {
          logger.error(`[Stripe Webhook] Company sync failed: ${companyResult.error}`);
        }
      } catch (companyError: unknown) {
        logger.error('[Stripe Webhook] Error syncing company to HubSpot (will queue retry):', { error: getErrorMessage(companyError) });
        deferredActions.push(async () => {
          try {
            const { enqueueHubSpotSync } = await import('../../../hubspot/queue');
            await enqueueHubSpotSync('sync_company', {
              companyName,
              userEmail,
              retryReason: 'checkout_timeout'
            }, {
              idempotencyKey: `company_sync_checkout_${userEmail}_${session.id}`,
              priority: 3
            });
            logger.info(`[Stripe Webhook] Queued HubSpot company sync retry for ${companyName} (${userEmail})`);
          } catch (queueErr: unknown) {
            logger.error('[Stripe Webhook] Failed to queue HubSpot company sync retry:', { error: getErrorMessage(queueErr) });
          }
        });
      }
    }

    if (session.metadata?.source === 'activation_link') {
      const userId = session.metadata?.userId;
      const memberEmail = session.metadata?.memberEmail?.toLowerCase();
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
      const tierSlugMeta = session.metadata?.tierSlug;
      const tierNameMeta = session.metadata?.tier;

      logger.info(`[Stripe Webhook] Processing activation_link checkout: session=${session.id}, user=${userId}, email=${memberEmail}, subscription=${subscriptionId}`);

      if (userId && memberEmail) {
        try {
          let updateResult = await client.query(
            `UPDATE users SET 
              membership_status = 'active',
              membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END,
              stripe_customer_id = COALESCE(stripe_customer_id, $1),
              stripe_subscription_id = $2,
              billing_provider = 'stripe',
              tier = COALESCE($3, tier),
              join_date = COALESCE(join_date, NOW()),
              archived_at = NULL, archived_by = NULL,
              updated_at = NOW()
            WHERE id = $4
            RETURNING id, email`,
            [customerId, subscriptionId, normalizeTierName(tierNameMeta || tierSlugMeta), userId]
          );

          if (updateResult.rowCount === 0 && memberEmail) {
            logger.warn(`[Stripe Webhook] Activation link: user not found by id=${userId}, falling back to email=${memberEmail}`);
            updateResult = await client.query(
              `UPDATE users SET 
                membership_status = 'active',
                membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END,
                stripe_customer_id = COALESCE(stripe_customer_id, $1),
                stripe_subscription_id = $2,
                billing_provider = 'stripe',
                tier = COALESCE($3, tier),
                join_date = COALESCE(join_date, NOW()),
                archived_at = NULL, archived_by = NULL,
                updated_at = NOW()
              WHERE LOWER(email) = LOWER($4) AND stripe_customer_id IS NULL
              RETURNING id, email`,
              [customerId, subscriptionId, normalizeTierName(tierNameMeta || tierSlugMeta), memberEmail]
            );
          }

          if (updateResult.rowCount && updateResult.rowCount > 0) {
            const updatedEmail = updateResult.rows[0].email;
            logger.info(`[Stripe Webhook] Activation link checkout: activated user ${updatedEmail} with subscription ${subscriptionId}`);

            const couponApplied = session.metadata?.couponApplied;
            if (couponApplied) {
              const deferredCouponUserId = updateResult.rows[0].id;
              const deferredCouponEmail = updatedEmail;

              deferredActions.push(async () => {
                try {
                  const stripe = await getStripeClient();
                  const coupon = await stripe.coupons.retrieve(couponApplied);
                  const couponName = coupon.name || couponApplied;
                  await db.execute(sql`UPDATE users SET discount_code = ${couponName}, updated_at = NOW() WHERE id = ${deferredCouponUserId}`);
                  logger.info(`[Stripe Webhook] Set discount_code="${couponName}" for activated user ${deferredCouponEmail}`);
                } catch (couponErr: unknown) {
                  logger.warn('[Stripe Webhook] Failed to set discount_code from coupon:', { extra: { couponApplied, error: getErrorMessage(couponErr) } });
                }
              });
            }

            const userInfo = await client.query(
              'SELECT first_name, last_name, phone FROM users WHERE id = $1',
              [updateResult.rows[0].id]
            );
            const deferredUpdatedEmail = updatedEmail;
            const deferredTierNameMeta = tierNameMeta;
            const deferredFirstName = userInfo.rows[0]?.first_name || '';
            const deferredLastName = userInfo.rows[0]?.last_name || '';
            const deferredPhone = userInfo.rows[0]?.phone || undefined;
            const deferredCustomerId = customerId;

            deferredActions.push(async () => {
              try {
                const { findOrCreateHubSpotContact } = await import('../../../hubspot/members');
                await findOrCreateHubSpotContact(
                  deferredUpdatedEmail,
                  deferredFirstName,
                  deferredLastName,
                  deferredPhone
                );
              } catch (contactErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot contact sync failed for activation link:', { error: getErrorMessage(contactErr) });
              }
            });

            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
                await syncMemberToHubSpot({
                  email: deferredUpdatedEmail,
                  status: 'active',
                  billingProvider: 'stripe',
                  tier: deferredTierNameMeta,
                  memberSince: new Date(),
                  billingGroupRole: 'Primary',
                  stripeCustomerId: deferredCustomerId || undefined,
                });
              } catch (hubspotError: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for activation link checkout:', { error: getErrorMessage(hubspotError) });
              }
            });

            deferredActions.push(async () => {
              try {
                await sendPassUpdateForMemberByEmail(deferredUpdatedEmail);
              } catch (pushErr: unknown) {
                logger.warn('[Stripe Webhook] Wallet pass push failed for activation (non-fatal):', { extra: { email: deferredUpdatedEmail, error: getErrorMessage(pushErr) } });
              }
            });
          } else {
            logger.error(`[Stripe Webhook] Activation link checkout: user not found for userId=${userId} email=${memberEmail}`);
          }
        } catch (activationError: unknown) {
          logger.error(`[Stripe Webhook] Error processing activation link checkout:`, { extra: { detail: getErrorMessage(activationError) } });
        }
      }
    }

    if (session.metadata?.source === 'staff_invite') {
      logger.info(`[Stripe Webhook] Processing staff invite checkout: ${session.id}`);
      
      const email = session.customer_email?.toLowerCase();
      const firstName = session.metadata?.firstName;
      const lastName = session.metadata?.lastName;
      const tierId = session.metadata?.tierId ? parseInt(session.metadata.tierId, 10) : null;
      const tierName = session.metadata?.tierName;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
      
      if (!email || !customerId) {
        logger.error(`[Stripe Webhook] Missing email or customer ID for staff invite: ${session.id}`);
        return deferredActions;
      }
      
      const { resolveUserByEmail } = await import('../../customers');
      const resolved = await resolveUserByEmail(email);
      if (resolved) {
        logger.info(`[Stripe Webhook] User found via ${resolved.matchType} for ${email} -> ${resolved.primaryEmail}, updating Stripe customer ID`);
        const preUpdateCheck = await client.query('SELECT archived_at, stripe_customer_id FROM users WHERE id = $1', [resolved.userId]);
        const existingStripeId = preUpdateCheck.rows[0]?.stripe_customer_id;
        if (existingStripeId && existingStripeId !== customerId) {
          logger.error(`[Stripe Webhook] CONFLICT: Staff invite checkout attempted to overwrite stripe_customer_id for user ${resolved.primaryEmail}. Existing: ${existingStripeId}, Incoming: ${customerId}. Refusing update.`);
          return deferredActions;
        }
        const updateResult = await client.query(
          `UPDATE users SET stripe_customer_id = $1, membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, billing_provider = 'stripe', archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = $2 AND (stripe_customer_id IS NULL OR stripe_customer_id = $1) AND (membership_status IS NULL OR membership_status NOT IN ('cancelled', 'archived'))`,
          [customerId, resolved.userId]
        );
        if (updateResult.rowCount === 0) {
          logger.error(`[Stripe Webhook] CONFLICT: Concurrent stripe_customer_id update detected for user ${resolved.primaryEmail}. Incoming: ${customerId}. Refusing update.`);
          return deferredActions;
        }
        if (preUpdateCheck.rows[0]?.archived_at) {
          logger.info(`[Auto-Unarchive] User ${resolved.primaryEmail} unarchived after receiving Stripe customer ID`);
        }
        
        const deferredResolvedEmail = resolved.primaryEmail;
        const deferredResolvedCustomerId = customerId;
        deferredActions.push(async () => {
          try {
            const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
            await syncMemberToHubSpot({ email: deferredResolvedEmail, status: 'active', billingProvider: 'stripe', memberSince: new Date(), billingGroupRole: 'Primary', stripeCustomerId: deferredResolvedCustomerId || undefined });
            logger.info(`[Stripe Webhook] Synced existing user ${deferredResolvedEmail} to HubSpot`);
          } catch (hubspotError: unknown) {
            logger.error('[Stripe Webhook] HubSpot sync failed for existing user:', { error: getErrorMessage(hubspotError) });
          }
        });
      } else {
        const existingUser = await client.query(
          'SELECT id, status, stripe_customer_id FROM users WHERE LOWER(email) = LOWER($1)',
          [email]
        );
        
        if (existingUser.rows.length > 0) {
          const existingStripeIdDirect = existingUser.rows[0].stripe_customer_id;
          if (existingStripeIdDirect && existingStripeIdDirect !== customerId) {
            logger.error(`[Stripe Webhook] CONFLICT: Staff invite checkout attempted to overwrite stripe_customer_id for user ${email}. Existing: ${existingStripeIdDirect}, Incoming: ${customerId}. Refusing update.`);
            return deferredActions;
          }
          logger.info(`[Stripe Webhook] User ${email} exists, updating Stripe customer ID and billing provider`);
          const preUpdateCheckDirect = await client.query('SELECT archived_at FROM users WHERE LOWER(email) = LOWER($1)', [email]);
          const updateResultDirect = await client.query(
            `UPDATE users SET stripe_customer_id = $1, membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, billing_provider = 'stripe', archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE LOWER(email) = LOWER($2) AND (stripe_customer_id IS NULL OR stripe_customer_id = $1) AND (membership_status IS NULL OR membership_status NOT IN ('cancelled', 'archived'))`,
            [customerId, email]
          );
          if (updateResultDirect.rowCount === 0) {
            logger.error(`[Stripe Webhook] CONFLICT: Concurrent stripe_customer_id update detected for user ${email}. Incoming: ${customerId}. Refusing update.`);
            return deferredActions;
          }
          if (preUpdateCheckDirect.rows[0]?.archived_at) {
            logger.info(`[Auto-Unarchive] User ${email} unarchived after receiving Stripe customer ID`);
          }
          
          const deferredDirectEmail = email;
          const deferredDirectCustomerId = customerId;
          deferredActions.push(async () => {
            try {
              const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
              await syncMemberToHubSpot({ email: deferredDirectEmail, status: 'active', billingProvider: 'stripe', memberSince: new Date(), billingGroupRole: 'Primary', stripeCustomerId: deferredDirectCustomerId || undefined });
              logger.info(`[Stripe Webhook] Synced existing user ${deferredDirectEmail} to HubSpot`);
            } catch (hubspotError: unknown) {
              logger.error('[Stripe Webhook] HubSpot sync failed for existing user:', { error: getErrorMessage(hubspotError) });
            }
          });
        } else {
        logger.info(`[Stripe Webhook] Creating new user from staff invite: ${email}`);
        
        const exclusionCheck = await client.query('SELECT 1 FROM sync_exclusions WHERE email = $1', [email.toLowerCase()]);
        if (exclusionCheck.rows.length > 0) {
          logger.info(`[Stripe Webhook] Skipping user creation for ${email} — permanently deleted (sync_exclusions)`);
        } else {
        let tierSlug = null;
        if (tierId) {
          const tierResult = await client.query(
            'SELECT slug FROM membership_tiers WHERE id = $1',
            [tierId]
          );
          if (tierResult.rows.length > 0) {
            tierSlug = tierResult.rows[0].slug;
          }
        }
        
        const upsertResult = await client.query(
          `INSERT INTO users (email, first_name, last_name, tier, membership_status, stripe_customer_id, billing_provider, join_date, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', $5, 'stripe', NOW(), NOW(), NOW())
           ON CONFLICT (email) DO UPDATE SET 
             stripe_customer_id = EXCLUDED.stripe_customer_id,
             billing_provider = 'stripe',
             membership_status = 'active',
             membership_status_changed_at = CASE WHEN users.membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE users.membership_status_changed_at END,
             role = 'member',
             archived_at = NULL,
             archived_by = NULL,
             join_date = COALESCE(users.join_date, NOW()),
             tier = COALESCE(EXCLUDED.tier, users.tier),
             updated_at = NOW()
           WHERE users.stripe_customer_id IS NULL OR users.stripe_customer_id = EXCLUDED.stripe_customer_id`,
          [email, firstName || '', lastName || '', tierSlug, customerId]
        );
        if (upsertResult.rowCount === 0) {
          logger.error(`[Stripe Webhook] CONFLICT: Staff invite upsert refused — user ${email} already has a different stripe_customer_id. Incoming: ${customerId}. Refusing update.`);
          return deferredActions;
        }
        
        logger.info(`[Stripe Webhook] Created user ${email} with tier ${tierSlug || 'none'}`);
        }
        }
      }
      
      const deferredStaffEmail = email;
      const deferredStaffFirstName = firstName || '';
      const deferredStaffLastName = lastName || '';
      const deferredStaffTierName = tierName || undefined;
      const deferredStaffCustomerId = customerId;

      deferredActions.push(async () => {
        try {
          const { findOrCreateHubSpotContact } = await import('../../../hubspot/members');
          const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
          
          await findOrCreateHubSpotContact(
            deferredStaffEmail,
            deferredStaffFirstName,
            deferredStaffLastName,
            undefined,
            deferredStaffTierName
          );
          
          await syncMemberToHubSpot({
            email: deferredStaffEmail,
            status: 'active',
            billingProvider: 'stripe',
            tier: deferredStaffTierName,
            memberSince: new Date(),
            billingGroupRole: 'Primary',
            stripeCustomerId: deferredStaffCustomerId || undefined,
          });
          logger.info(`[Stripe Webhook] Synced ${deferredStaffEmail} to HubSpot: status=active, tier=${deferredStaffTierName}, billing=stripe, memberSince=now`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for staff invite:', { error: getErrorMessage(hubspotError) });
        }
      });
      
      try {
        await client.query(
          `UPDATE form_submissions SET status = 'converted', updated_at = NOW() WHERE form_type = 'membership' AND LOWER(email) = LOWER($1) AND status = 'invited'`,
          [email]
        );
        logger.info(`[Stripe Webhook] Marked membership application as converted for ${email}`);
      } catch (convErr: unknown) {
        logger.error('[Stripe Webhook] Failed to mark application as converted:', { error: getErrorMessage(convErr) });
      }
      
      deferredActions.push(async () => {
        try {
          await sendPassUpdateForMemberByEmail(email!.toLowerCase());
        } catch (pushErr: unknown) {
          logger.warn('[Stripe Webhook] Wallet pass push failed for staff invite activation (non-fatal):', { extra: { email, error: getErrorMessage(pushErr) } });
        }
      });

      logger.info(`[Stripe Webhook] Staff invite checkout completed for ${email}`);
      return deferredActions;
    }

    if (session.metadata?.purpose !== 'day_pass') {
      logger.info(`[Stripe Webhook] Skipping checkout session ${session.id} (not a day_pass or staff_invite)`);
      return deferredActions;
    }

    if (session.payment_status === 'unpaid') {
      logger.info(`[Stripe Webhook] Day pass checkout session ${session.id} has payment_status=unpaid (async payment method) — deferring fulfillment to async_payment_succeeded`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Processing day pass checkout session: ${session.id}`);

    const productSlug = session.metadata?.product_slug;
    const email = session.metadata?.purchaser_email;
    const firstName = session.metadata?.purchaser_first_name;
    const lastName = session.metadata?.purchaser_last_name;
    const phone = session.metadata?.purchaser_phone;
    const amountCents = session.amount_total || 0;

    let paymentIntentId: string | null = null;
    if (session.payment_intent) {
      paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent.id;
    }

    if (!paymentIntentId && amountCents === 0) {
      paymentIntentId = `free_checkout_${session.id}`;
      logger.info(`[Stripe Webhook] Day pass checkout with $0 total (100% discount) — using synthetic paymentIntentId: ${paymentIntentId}`);
    }

    if (!productSlug || !email || !paymentIntentId) {
      logger.error(`[Stripe Webhook] Missing required data for day pass: productSlug=${productSlug}, email=${email}, paymentIntentId=${paymentIntentId}`);
      return deferredActions;
    }

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
    const purchaserName = [firstName, lastName].filter(Boolean).join(' ') || email;

    const dayPassResult = await recordDayPassPurchaseFromWebhook({
      productSlug,
      email,
      firstName,
      lastName,
      phone,
      amountCents,
      paymentIntentId,
      customerId
    });

    if (!dayPassResult.success) {
      throw new Error(`Failed to record day pass purchase: ${dayPassResult.error}`);
    }

    logger.info(`[Stripe Webhook] Day pass purchase recorded: ${dayPassResult.purchaseId}`);

    const deferredDayPassResult = dayPassResult;
    const deferredPurchaserName = purchaserName;
    const deferredDayPassEmail = email;
    const deferredProductSlug = productSlug;

    deferredActions.push(async () => {
      try {
        broadcastDayPassUpdate({
          action: 'day_pass_purchased',
          passId: deferredDayPassResult.purchaseId!,
          purchaserEmail: deferredDayPassEmail,
          purchaserName: deferredPurchaserName,
          productType: deferredProductSlug,
          remainingUses: deferredDayPassResult.remainingUses ?? 1,
          quantity: deferredDayPassResult.quantity ?? 1,
          purchasedAt: new Date().toISOString(),
        });

        try {
          await sendPassWithQrEmail(deferredDayPassEmail, {
            passId: parseInt(deferredDayPassResult.purchaseId!, 10),
            type: deferredProductSlug,
            quantity: 1,
            purchaseDate: new Date()
          });
          logger.info(`[Stripe Webhook] QR pass email sent to ${deferredDayPassEmail}`);
        } catch (emailError: unknown) {
          logger.error('[Stripe Webhook] Failed to send QR pass email:', { error: getErrorMessage(emailError) });
        }

        try {
          await notifyAllStaff(
            'Day Pass Purchased',
            `${deferredPurchaserName} (${deferredDayPassEmail}) purchased a ${deferredProductSlug} day pass.`,
            'day_pass',
            { sendPush: false, sendWebSocket: true }
          );
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Failed to notify staff of day pass:', { error: getErrorMessage(notifyErr) });
        }

      } catch (recordErr: unknown) {
        logger.error('[Stripe Webhook] Day pass deferred recording failed:', { error: getErrorMessage(recordErr) });
      }
    });

    deferredActions.push(async () => {
      try {
        await upsertTransactionCache({
          stripeId: paymentIntentId!,
          objectType: 'payment_intent',
          amountCents,
          currency: 'usd',
          status: 'succeeded',
          createdAt: new Date(),
          customerId,
          customerEmail: email,
          customerName: [firstName, lastName].filter(Boolean).join(' ') || null,
          description: `Day Pass: ${productSlug}`,
          metadata: session.metadata || undefined,
          source: 'webhook',
          paymentIntentId,
        });
      } catch (cacheErr: unknown) {
        logger.error('[Stripe Webhook] Failed to cache day pass transaction:', { error: getErrorMessage(cacheErr) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling checkout session completed:', { error: getErrorMessage(error) });
    throw error;
  }
  return deferredActions;
}

export async function handleCheckoutSessionExpired(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const email = session.customer_email?.toLowerCase() || null;
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
    const metadata = session.metadata || {};
    const purpose = metadata.purpose || 'unknown';
    const source = metadata.source || '';
    const tierSlug = metadata.tier_slug || '';

    let userEmail = email;
    if (!userEmail && customerId) {
      const userResult = await client.query(
        `SELECT email FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
        [customerId]
      );
      if (userResult.rows.length > 0) {
        userEmail = userResult.rows[0].email;
      }
    }

    if (!userEmail) {
      userEmail = metadata.email?.toLowerCase() || metadata.user_email?.toLowerCase() || null;
    }

    if (!userEmail && customerId) {
      try {
        const stripe = await getStripeClient();
        const customer = await stripe.customers.retrieve(customerId);
        if (customer && !customer.deleted) {
          userEmail = customer.email?.toLowerCase() || null;
        }
      } catch (_err: unknown) {
      }
    }

    const displayEmail = userEmail || email || customerId || 'unknown';
    logger.info(`[Stripe Webhook] Checkout session expired: ${session.id}, email: ${displayEmail}, purpose: ${purpose}, source: ${source}, tier: ${tierSlug}`);

    if (purpose === 'day_pass') {
      deferredActions.push(async () => {
        try {
          await notifyAllStaff(
            'Day Pass Checkout Expired',
            `Day pass checkout expired for ${displayEmail}. Session: ${session.id}`,
            'billing',
            { sendPush: false }
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify staff about expired day pass checkout:', { error: getErrorMessage(err) });
        }
      });
    }

    if (source === 'staff_invite' || source === 'activation_link') {
      deferredActions.push(async () => {
        try {
          await notifyAllStaff(
            'Signup Checkout Expired',
            `Signup checkout expired for ${displayEmail} — they may need a new link. Source: ${source}, Session: ${session.id}`,
            'billing',
            { sendPush: true }
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify staff about expired signup checkout:', { error: getErrorMessage(err) });
        }
      });
    }

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'checkout_session_expired',
          resourceType: 'checkout',
          resourceId: session.id,
          details: {
            email: displayEmail,
            purpose,
            source,
            tierSlug,
            customerId,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log checkout session expired:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling checkout.session.expired:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleCheckoutSessionAsyncPaymentFailed(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const email = session.customer_email?.toLowerCase() || null;
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
    const metadata = session.metadata || {};
    const purpose = metadata.purpose || 'unknown';
    const description = metadata.description || purpose;

    let userEmail = email;
    if (!userEmail && customerId) {
      const userResult = await client.query(
        `SELECT email FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
        [customerId]
      );
      if (userResult.rows.length > 0) {
        userEmail = userResult.rows[0].email;
      }
    }

    if (!userEmail) {
      userEmail = metadata.email?.toLowerCase() || metadata.user_email?.toLowerCase() || null;
    }

    if (!userEmail && customerId) {
      try {
        const stripe = await getStripeClient();
        const customer = await stripe.customers.retrieve(customerId);
        if (customer && !customer.deleted) {
          userEmail = customer.email?.toLowerCase() || null;
        }
      } catch (_err: unknown) {
      }
    }

    const displayEmail = userEmail || email || customerId || 'unknown';
    logger.info(`[Stripe Webhook] Checkout session async payment failed: ${session.id}, email: ${displayEmail}, purpose: ${purpose}`);

    if (userEmail) {
      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail: userEmail!,
            title: 'Payment Failed',
            message: `Your payment for ${description} could not be completed. Please try again or use a different payment method.`,
            type: 'payment_failed',
          });
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify member about async payment failure:', { error: getErrorMessage(err) });
        }
      });
    }

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Async Payment Failed',
          `Async payment failed for ${displayEmail}. Purpose: ${purpose}, Session: ${session.id}`,
          'billing',
          { sendPush: true }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about async payment failure:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'checkout_async_payment_failed',
          resourceType: 'checkout_session',
          resourceId: session.id,
          details: {
            email: displayEmail,
            purpose,
            customerId,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log async payment failure:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling checkout.session.async_payment_failed:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleCheckoutSessionAsyncPaymentSucceeded(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const email = session.customer_email?.toLowerCase() || null;
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
    const metadata = session.metadata || {};
    const purpose = metadata.purpose || 'unknown';
    const amountTotal = session.amount_total || 0;

    let userEmail = email;
    let userName = '';
    if (!userEmail && customerId) {
      const userResult = await client.query(
        `SELECT email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
        [customerId]
      );
      if (userResult.rows.length > 0) {
        userEmail = userResult.rows[0].email;
        userName = userResult.rows[0].display_name || '';
      }
    } else if (userEmail) {
      const userResult = await client.query(
        `SELECT COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE LOWER(email) = $1 LIMIT 1`,
        [userEmail]
      );
      if (userResult.rows.length > 0) {
        userName = userResult.rows[0].display_name || '';
      }
    }

    const displayEmail = userEmail || email || customerId || 'unknown';
    logger.info(`[Stripe Webhook] Checkout session async payment succeeded: ${session.id}, email: ${displayEmail}, purpose: ${purpose}, amount: $${(amountTotal / 100).toFixed(2)}`);

    if (purpose === 'day_pass') {
      const productSlug = metadata.product_slug;
      const dayPassEmail = userEmail || session.customer_email?.toLowerCase() || metadata.email;
      const firstName = metadata.first_name || '';
      const lastName = metadata.last_name || '';
      const phone = metadata.phone || '';
      const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;

      if (!productSlug || !dayPassEmail || !paymentIntentId) {
        logger.error(`[Stripe Webhook] Missing required data for async day pass: productSlug=${productSlug}, email=${dayPassEmail}, paymentIntentId=${paymentIntentId}`);
      } else {
        const result = await recordDayPassPurchaseFromWebhook({
          productSlug,
          email: dayPassEmail,
          firstName,
          lastName,
          phone,
          amountCents: amountTotal,
          paymentIntentId,
          customerId
        });

        if (!result.success) {
          throw new Error(`Failed to record async day pass: ${result.error}`);
        }
        logger.info(`[Stripe Webhook] Recorded day pass purchase from async payment for ${dayPassEmail}: ${result.purchaseId}`);
      }
    } else {
      logger.info(`[Stripe Webhook] Async payment succeeded for non-day-pass purpose '${purpose}' — subscription handler likely already activated membership`);
    }

    if (userEmail) {
      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail: userEmail!,
            title: 'Payment Confirmed',
            message: 'Your payment has been confirmed!',
            type: 'payment_success',
          });
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify member about async payment success:', { error: getErrorMessage(err) });
        }
      });
    }

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Async Payment Succeeded',
          `Async payment confirmed for ${displayEmail}. Purpose: ${purpose}, Amount: $${(amountTotal / 100).toFixed(2)}, Session: ${session.id}`,
          'billing',
          { sendPush: false }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about async payment success:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'checkout_async_payment_succeeded',
          resourceType: 'checkout_session',
          resourceId: session.id,
          details: {
            email: displayEmail,
            purpose,
            amount: amountTotal / 100,
            customerId,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log async payment success:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await upsertTransactionCache({
          stripeId: session.id,
          objectType: 'payment_intent',
          amountCents: amountTotal,
          currency: session.currency || 'usd',
          status: 'succeeded',
          createdAt: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000),
          customerId,
          customerEmail: userEmail || email,
          customerName: userName || null,
          description: `Async payment: ${purpose}`,
          metadata,
          source: 'webhook',
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to cache async payment transaction:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling checkout.session.async_payment_succeeded:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}
