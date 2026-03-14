import Stripe from 'stripe';
import { getStripeClient } from '../../client';
import { notifyMember, notifyAllStaff } from '../../../notificationService';
import { sendMembershipRenewalEmail, sendMembershipFailedEmail } from '../../../../emails/membershipEmails';
import { broadcastBillingUpdate } from '../../../websocket';

import { logPaymentFailure } from '../../../monitoring';
import { sendErrorAlert } from '../../../errorAlerts';
import { logSystemAction } from '../../../auditLog';
import { logger } from '../../../logger';
import type { PoolClient } from 'pg';
import type { DeferredAction, InvoiceWithLegacyFields } from '../types';
import { upsertTransactionCache } from '../framework';
import { getErrorMessage } from '../../../../utils/errorUtils';

export async function handleInvoicePaymentSucceeded(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceEmail = invoice.customer_email;
  const invoiceAmountPaid = invoice.amount_paid || 0;
  const invoiceCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const invoiceCustomerName = typeof invoice.customer === 'object' ? (invoice.customer as Stripe.Customer)?.name : undefined;
  
  const invoiceLineDescriptions = (invoice.lines?.data || [])
    .map(line => line.description)
    .filter((d): d is string => !!d);
  const rawDescription = invoiceLineDescriptions.length > 0
    ? invoiceLineDescriptions.join(', ')
    : (invoice.description || 'Invoice payment');
  const invoiceDescription = rawDescription.length > 480
    ? rawDescription.substring(0, 477) + '...'
    : rawDescription;

  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: invoiceAmountPaid,
      currency: invoice.currency || 'usd',
      status: 'paid',
      createdAt: new Date(invoice.created * 1000),
      customerId: invoiceCustomerId,
      customerEmail: invoiceEmail,
      customerName: invoiceCustomerName,
      description: invoiceDescription,
      metadata: invoice.metadata as Record<string, string>,
      source: 'webhook',
      invoiceId: invoice.id,
      paymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id,
    });
  });

  const invoicePiId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id;
  if (invoicePiId) {
    deferredActions.push(async () => {
      try {
        const stripe = await getStripeClient();
        await stripe.paymentIntents.update(invoicePiId, {
          description: `Payment for: ${invoiceDescription}`,
        });
        logger.info(`[Stripe Webhook] Updated payment intent ${invoicePiId} description to: ${invoiceDescription}`);
      } catch (piUpdateErr: unknown) {
        logger.warn(`[Stripe Webhook] Failed to update payment intent description for ${invoicePiId}`, { error: piUpdateErr });
      }
    });
  }
  
  if (!invoice.subscription) {
    logger.info(`[Stripe Webhook] Skipping one-time invoice ${invoice.id} (no subscription)`);
    return deferredActions;
  }

  const email = invoice.customer_email;
  const amountPaid = invoice.amount_paid || 0;
  const planName = invoice.lines?.data?.[0]?.description || 'Membership';
  const currentPeriodEnd = invoice.lines?.data?.[0]?.period?.end;
  const nextBillingDate = currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : new Date();

  if (!email) {
    logger.warn(`[Stripe Webhook] No customer email on invoice ${invoice.id}`);
    return deferredActions;
  }

  const userResult = await client.query(
    'SELECT id, first_name, last_name, billing_provider FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );

  if (userResult.rows.length === 0 && invoice.subscription) {
    logger.warn(`[Stripe Webhook] Payment succeeded for customer ${invoiceCustomerId} but no matching user found in database. Subscription may need manual cancellation.`);
  }

  const memberName = userResult.rows[0]
    ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
    : email;
  const userId = userResult.rows[0]?.id;

  const invoiceUserBillingProvider = userResult.rows[0]?.billing_provider;
  if (invoiceUserBillingProvider && invoiceUserBillingProvider !== 'stripe') {
    logger.info(`[Stripe Webhook] Skipping billing_provider/grace-period update for ${email} — billing_provider is '${invoiceUserBillingProvider}', not 'stripe' (invoice.payment_succeeded)`);
    return deferredActions;
  }

  const priceId = (invoice.lines?.data?.[0] as unknown as { price?: { id: string } })?.price?.id;
  let restoreTierClause = '';
  let queryParams: (string | number | null)[] = [email];
  
  if (priceId) {
    const tierResult = await client.query(
      'SELECT name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
      [priceId]
    );
    if (tierResult.rows.length > 0) {
      restoreTierClause = ', tier = COALESCE(tier, $2)';
      queryParams = [email, tierResult.rows[0].name];
    }
  }
  
  await client.query(
    `UPDATE users SET 
      grace_period_start = NULL,
      grace_period_email_count = 0,
      billing_provider = CASE WHEN billing_provider IS NULL OR billing_provider = '' OR billing_provider = 'stripe' THEN 'stripe' ELSE billing_provider END${restoreTierClause},
      updated_at = NOW()
    WHERE LOWER(email) = LOWER($1)`,
    queryParams
  );
  logger.info(`[Stripe Webhook] Cleared grace period and set billing_provider for ${email}`);

  await client.query(
    `UPDATE hubspot_deals 
     SET last_payment_status = 'current',
         last_payment_check = NOW(),
         last_sync_error = NULL,
         updated_at = NOW()
     WHERE LOWER(member_email) = LOWER($1)`,
    [email]
  );

  if (currentPeriodEnd) {
    const invoiceSubscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    if (invoiceSubscriptionId) {
      await client.query(
        `UPDATE users SET stripe_current_period_end = $1, updated_at = NOW()
         WHERE LOWER(email) = LOWER($2) AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $3)`,
        [nextBillingDate, email, invoiceSubscriptionId]
      );
    } else {
      await client.query(
        `UPDATE users SET stripe_current_period_end = $1, updated_at = NOW()
         WHERE LOWER(email) = LOWER($2)`,
        [nextBillingDate, email]
      );
    }
  }

  const localEmail = email;
  const localMemberName = memberName;
  const localAmountPaid = amountPaid;
  const localPlanName = planName;
  const localNextBillingDate = nextBillingDate;
  const _localUserId = userId;
  const _localPaymentIntent = (typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id) || invoice.id;

  deferredActions.push(async () => {
    await notifyMember({
      userEmail: localEmail,
      title: 'Membership Renewed',
      message: `Your ${localPlanName} has been renewed successfully.`,
      type: 'membership_renewed',
    });

    await sendMembershipRenewalEmail(localEmail, {
      memberName: localMemberName,
      amount: localAmountPaid / 100,
      planName: localPlanName,
      nextBillingDate: localNextBillingDate,
    });

    await notifyAllStaff(
      'Membership Renewed',
      `${localMemberName} (${localEmail}) membership renewed: ${localPlanName} - $${(localAmountPaid / 100).toFixed(2)}`,
      'membership_renewed',
      { sendPush: true }
    );

    broadcastBillingUpdate({
      action: 'invoice_paid',
      memberEmail: localEmail,
      memberName: localMemberName,
      amount: localAmountPaid / 100,
      planName: localPlanName
    });

    logger.info(`[Stripe Webhook] Membership renewal processed for ${localEmail}, amount: $${(localAmountPaid / 100).toFixed(2)}`);
  });

  return deferredActions;
}

export async function handleInvoicePaymentFailed(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const invoiceCustomerName = typeof invoice.customer === 'object' ? (invoice.customer as Stripe.Customer)?.name : undefined;
  const attemptCount = invoice.attempt_count || 1;
  
  logPaymentFailure({
    paymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id,
    customerId: invoiceCustomerId,
    userEmail: invoice.customer_email,
    amountCents: invoice.amount_due,
    errorMessage: `Invoice payment failed: ${invoice.id} (attempt ${attemptCount})`,
    errorCode: 'invoice_payment_failed'
  });
  
  logger.info(`[Stripe Webhook] Invoice payment failed: ${invoice.id}, attempt_count: ${attemptCount}, customer: ${invoice.customer_email || invoiceCustomerId}`);
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: invoice.amount_due || 0,
      currency: invoice.currency || 'usd',
      status: 'payment_failed',
      createdAt: new Date(invoice.created * 1000),
      customerId: invoiceCustomerId,
      customerEmail: invoice.customer_email,
      customerName: invoiceCustomerName,
      description: invoice.lines?.data?.[0]?.description || 'Invoice payment failed',
      metadata: invoice.metadata as Record<string, string>,
      source: 'webhook',
      invoiceId: invoice.id,
      paymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id,
    });
  });
  
  if (!invoice.subscription) {
    logger.info(`[Stripe Webhook] Skipping one-time invoice ${invoice.id} (no subscription)`);
    return deferredActions;
  }

  const email = invoice.customer_email;
  const amountDue = invoice.amount_due || 0;
  const planName = invoice.lines?.data?.[0]?.description || 'Membership';
  const reason = invoice.last_finalization_error?.message || 'Payment declined';

  if (!email) {
    logger.warn(`[Stripe Webhook] No customer email on failed invoice ${invoice.id}`);
    return deferredActions;
  }

  const userResult = await client.query(
    'SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  const memberName = userResult.rows[0]
    ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
    : email;

  const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  
  const subMatchCheck = await client.query(
    `SELECT membership_status, stripe_subscription_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  if (subMatchCheck.rows.length > 0) {
    const userSubId = subMatchCheck.rows[0].stripe_subscription_id;
    const userStatus = subMatchCheck.rows[0].membership_status;
    
    if (['cancelled', 'inactive'].includes(userStatus)) {
      logger.info(`[Stripe Webhook] Skipping grace period for ${email} — membership already ${userStatus} (subscription ${subscriptionId})`);
      return deferredActions;
    }
    
    if (userSubId && userSubId !== subscriptionId) {
      logger.info(`[Stripe Webhook] Skipping grace period for ${email} — invoice subscription ${subscriptionId} does not match current subscription ${userSubId} (stale invoice from old subscription)`);
      return deferredActions;
    }
  }

  const userStatusCheck = await client.query(
    'SELECT membership_status, billing_provider FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  const currentStatus = userStatusCheck.rows[0]?.membership_status;
  if (currentStatus && ['cancelled', 'suspended'].includes(currentStatus)) {
    logger.info(`[Stripe Webhook] Skipping grace period for ${email} — user already ${currentStatus}`);
    return deferredActions;
  }

  const failedInvoiceBillingProvider = userStatusCheck.rows[0]?.billing_provider;
  if (failedInvoiceBillingProvider && failedInvoiceBillingProvider !== 'stripe') {
    logger.info(`[Stripe Webhook] Skipping grace period for ${email} — billing_provider is '${failedInvoiceBillingProvider}', not 'stripe' (invoice.payment_failed)`);
    return deferredActions;
  }

  await client.query(
    `UPDATE hubspot_deals 
     SET last_payment_status = 'failed',
         last_payment_check = NOW(),
         last_sync_error = $2,
         updated_at = NOW()
     WHERE LOWER(member_email) = LOWER($1)`,
    [email, `Payment failed: ${reason} (attempt ${attemptCount})`]
  );

  const gracePeriodResult = await client.query(
    `UPDATE users SET 
      grace_period_start = COALESCE(grace_period_start, NOW()),
      billing_provider = CASE WHEN billing_provider IS NULL OR billing_provider = '' OR billing_provider = 'stripe' THEN 'stripe' ELSE billing_provider END,
      membership_status = CASE 
        WHEN membership_status = 'active' THEN 'past_due'
        ELSE membership_status 
      END,
      updated_at = NOW()
    WHERE LOWER(email) = LOWER($1) AND grace_period_start IS NULL`,
    [email]
  );

  if (gracePeriodResult.rowCount === 0) {
    logger.info(`[Stripe Webhook] Grace period already active for ${email}, skipping grace period setup but still notifying (attempt ${attemptCount})`);
  } else {
    logger.info(`[Stripe Webhook] Started grace period and set past_due status for ${email} (attempt ${attemptCount})`);
  }

  const localEmail = email;
  const localMemberName = memberName;
  const localAmountDue = amountDue;
  const localPlanName = planName;
  const localReason = reason;
  const localAttemptCount = attemptCount;

  const actualStatusResult = await client.query(
    'SELECT membership_status FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  const actualStatus = actualStatusResult.rows[0]?.membership_status || 'past_due';

  deferredActions.push(async () => {
    try {
      const { syncMemberToHubSpot } = await import('../../../hubspot/stages');
      await syncMemberToHubSpot({ email: localEmail, status: actualStatus, billingProvider: 'stripe', billingGroupRole: 'Primary' });
      logger.info(`[Stripe Webhook] Synced ${localEmail} payment failure status to HubSpot (actual status: ${actualStatus})`);
    } catch (hubspotError: unknown) {
      logger.error('[Stripe Webhook] HubSpot sync failed for payment failure:', { error: hubspotError });
    }
  });

  deferredActions.push(async () => {
    const urgencyPrefix = localAttemptCount >= 3 ? '🚨 URGENT: ' : localAttemptCount >= 2 ? '⚠️ ' : '';

    await notifyMember({
      userEmail: localEmail,
      title: 'Membership Payment Failed',
      message: `We were unable to process your ${localPlanName} payment (attempt ${localAttemptCount}). Please update your payment method.`,
      type: 'membership_failed',
    }, { sendPush: true });

    await sendMembershipFailedEmail(localEmail, {
      memberName: localMemberName,
      amount: localAmountDue / 100,
      planName: localPlanName,
      reason: localReason,
    });

    await notifyAllStaff(
      `${urgencyPrefix}Membership Payment Failed`,
      `${localMemberName} (${localEmail}) membership payment of $${(localAmountDue / 100).toFixed(2)} failed (attempt ${localAttemptCount}): ${localReason}`,
      'membership_failed',
      { sendPush: true }
    );

    broadcastBillingUpdate({
      action: 'invoice_failed',
      memberEmail: localEmail,
      memberName: localMemberName,
      amount: localAmountDue / 100,
      planName: localPlanName
    });

    logger.info(`[Stripe Webhook] Membership payment failure processed for ${localEmail}, amount: $${(localAmountDue / 100).toFixed(2)}, attempt: ${localAttemptCount}`);
  });

  deferredActions.push(async () => {
    try {
      await sendErrorAlert({
        type: 'payment_failure',
        title: 'Membership Payment Failed',
        message: `Invoice ${invoice.id} payment failed for ${localEmail} ($${(localAmountDue / 100).toFixed(2)}, attempt ${localAttemptCount}): ${localReason}`,
        context: 'stripe',
        details: {
          invoiceId: invoice.id,
          subscriptionId: typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id,
          attemptCount: localAttemptCount,
          amountCents: localAmountDue,
          planName: localPlanName,
        },
        userEmail: localEmail,
      });
    } catch (alertErr: unknown) {
      logger.warn('[Stripe Webhook] Failed to send error alert for payment failure:', { error: alertErr });
    }
  });

  return deferredActions;
}

export async function handleInvoiceLifecycle(client: PoolClient, invoice: InvoiceWithLegacyFields, eventType: string): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceEmail = invoice.customer_email;
  const amountDue = invoice.amount_due || 0;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const customerName = typeof invoice.customer === 'object' ? (invoice.customer as Stripe.Customer)?.name : undefined;
  
  logger.info(`[Stripe Webhook] Invoice ${eventType}: ${invoice.id}, status: ${invoice.status}, amount: $${(amountDue / 100).toFixed(2)}`);
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: amountDue,
      currency: invoice.currency || 'usd',
      status: invoice.status,
      createdAt: new Date(invoice.created * 1000),
      customerId,
      customerEmail: invoiceEmail,
      customerName,
      description: invoice.lines?.data?.[0]?.description || `Invoice ${invoice.number || invoice.id}`,
      metadata: invoice.metadata as Record<string, string>,
      source: 'webhook',
      invoiceId: invoice.id,
      paymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id,
    });
  });
  
  if (invoice.status === 'open' && invoice.due_date) {
    const dueDate = new Date(invoice.due_date * 1000);
    const now = new Date();
    if (dueDate < now) {
      deferredActions.push(async () => {
        broadcastBillingUpdate({
          action: 'invoice_failed',
          memberEmail: invoiceEmail,
          amount: amountDue / 100,
        });
      });
    }
  }

  return deferredActions;
}

export async function handleInvoiceVoided(client: PoolClient, invoice: InvoiceWithLegacyFields, eventType: string): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceEmail = invoice.customer_email;
  const amountDue = invoice.amount_due || 0;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  
  const status = eventType === 'invoice.voided' ? 'void' : 'uncollectible';
  logger.info(`[Stripe Webhook] Invoice ${status}: ${invoice.id}, removing from active invoices`);
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: amountDue,
      currency: invoice.currency || 'usd',
      status,
      createdAt: new Date(invoice.created * 1000),
      customerId,
      customerEmail: invoiceEmail,
      description: invoice.lines?.data?.[0]?.description || `Invoice ${invoice.number || invoice.id}`,
      metadata: invoice.metadata,
      source: 'webhook',
      invoiceId: invoice.id,
    });
  });
  
  const localInvoiceEmail = invoiceEmail;
  const _localInvoiceId = invoice.id;
  const _localStatus = status;
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({
      action: 'invoice_failed',
      memberEmail: localInvoiceEmail,
    });
  });

  return deferredActions;
}

export async function handleInvoicePaymentActionRequired(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null;
    if (!customerId) {
      logger.info(`[Stripe Webhook] invoice.payment_action_required ${invoice.id} has no customer, skipping`);
      return deferredActions;
    }

    const userResult = await client.query(
      `SELECT email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    const userEmail = userResult.rows[0]?.email;
    const displayEmail = userEmail || customerId;

    logger.info(`[Stripe Webhook] Invoice payment action required: ${invoice.id}, customer: ${customerId}, email: ${displayEmail}`);

    if (userEmail) {
      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail,
            title: 'Payment Authentication Required',
            message: 'Your payment requires additional authentication. Please click the link in your email or visit your billing portal to complete the payment.',
            type: 'billing_alert',
          });
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to notify member about payment action required:', { error: getErrorMessage(err) });
        }
      });
    }

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Payment Authentication Required',
          `Payment for ${displayEmail} requires 3D Secure authentication. Invoice: ${invoice.id}`,
          'billing',
          { sendPush: false }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about payment action required:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'invoice_payment_action_required',
          resourceType: 'invoices',
          resourceId: invoice.id,
          details: {
            email: displayEmail,
            customerId,
            hostedInvoiceUrl: invoice.hosted_invoice_url || null,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log payment action required:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling invoice.payment_action_required:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handleInvoiceOverdue(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null;
    if (!customerId) {
      logger.info(`[Stripe Webhook] invoice.overdue ${invoice.id} has no customer, skipping`);
      return deferredActions;
    }

    const amountDue = invoice.amount_due || 0;

    const userResult = await client.query(
      `SELECT email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name, billing_provider FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] invoice.overdue ${invoice.id} — no user found for customer ${customerId}`);
      return deferredActions;
    }

    const user = userResult.rows[0];
    const userEmail = user.email;
    const billingProvider = user.billing_provider;

    if (billingProvider && billingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping invoice.overdue for ${userEmail} — billing_provider is '${billingProvider}', not 'stripe'`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Invoice overdue: ${invoice.id}, email: ${userEmail}, amount: $${(amountDue / 100).toFixed(2)}`);

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail,
          title: 'Overdue Invoice',
          message: `You have an overdue invoice of $${(amountDue / 100).toFixed(2)}. Please update your payment method to avoid service interruption.`,
          type: 'outstanding_balance',
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify member about overdue invoice:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Overdue Invoice',
          `Overdue invoice for ${userEmail}: $${(amountDue / 100).toFixed(2)}. Invoice ${invoice.id}`,
          'billing',
          { sendPush: true }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about overdue invoice:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'invoice_overdue',
          resourceType: 'invoices',
          resourceId: invoice.id,
          details: {
            email: userEmail,
            amount: amountDue / 100,
            customerId,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log overdue invoice:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling invoice.overdue:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}
