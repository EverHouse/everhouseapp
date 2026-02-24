import Stripe from 'stripe';
import { getStripeSync, getStripeClient } from './client';
import { syncCompanyToHubSpot, queuePaymentSyncToHubSpot, queueDayPassSyncToHubSpot, handleTierChange, queueTierSync, handleMembershipCancellation } from '../hubspot';
import { pool } from '../db';
import { db } from '../../db';
import { groupMembers } from '../../../shared/models/hubspot-billing';
import { eq, sql, lt } from 'drizzle-orm';
import { webhookProcessedEvents } from '../../../shared/models/system';
import { notifyPaymentSuccess, notifyPaymentFailed, notifyStaffPaymentFailed, notifyMember, notifyAllStaff } from '../notificationService';
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from '../../emails/paymentEmails';
import { sendMembershipRenewalEmail, sendMembershipFailedEmail } from '../../emails/membershipEmails';
import { sendPassWithQrEmail } from '../../emails/passEmails';
import { sendTrialWelcomeWithQrEmail } from '../../emails/trialWelcomeEmail';
import { broadcastBillingUpdate, broadcastDayPassUpdate, sendNotificationToUser } from '../websocket';
import { recordDayPassPurchaseFromWebhook } from '../../routes/dayPasses';
import { handlePrimarySubscriptionCancelled } from './groupBilling';
import { computeFeeBreakdown } from '../billing/unifiedFeeService';
import { logPaymentFailure, logWebhookFailure } from '../monitoring';
import { sendErrorAlert } from '../errorAlerts';
import { logSystemAction, logPaymentAudit } from '../auditLog';
import { finalizeInvoicePaidOutOfBand } from './invoices';
import { queueJobInTransaction } from '../jobQueue';
import { pullTierFeaturesFromStripe, pullCafeItemsFromStripe } from './products';
import { clearTierCache } from '../tierService';
import { updateFamilyDiscountPercent, updateOverageRate, updateGuestFee } from '../billing/pricingConfig';
import type { PoolClient } from 'pg';
import { getErrorMessage } from '../../utils/errorUtils';
import { normalizeTierName } from '../../utils/tierUtils';

import { logger } from '../logger';
const EVENT_DEDUP_WINDOW_DAYS = 7;

type DeferredAction = () => Promise<void>;

interface StripeSubscriptionWithPeriods extends Stripe.Subscription {
  current_period_start: number;
  current_period_end: number;
}

type StripeProductWithMarketingFeatures = Stripe.Product & {
  marketing_features?: Array<{ name: string }>;
};

type InvoiceWithLegacyFields = Stripe.Invoice & {
  payment_intent?: string | Stripe.PaymentIntent | null;
  subscription?: string | Stripe.Subscription | null;
};

interface SubscriptionPreviousAttributes {
  items?: { data: Array<{ id: string; metadata?: Record<string, string> }> };
  status?: string;
  cancel_at_period_end?: boolean;
  [key: string]: unknown;
}

interface WebhookProcessingResult {
  processed: boolean;
  reason?: 'duplicate' | 'out_of_order' | 'error';
  deferredActions: DeferredAction[];
}

function extractResourceId(event: Stripe.Event): string | null {
  const obj = event.data?.object as unknown as Record<string, unknown> | undefined;
  if (!obj || !obj.id) return null;
  
  if (event.type.startsWith('payment_intent.')) return obj.id as string;
  if (event.type.startsWith('invoice.')) return obj.id as string;
  if (event.type.startsWith('customer.subscription.')) return obj.id as string;
  if (event.type.startsWith('checkout.session.')) return obj.id as string;
  if (event.type.startsWith('charge.')) return (obj.payment_intent as string) || (obj.id as string);
  if (event.type.startsWith('setup_intent.')) return obj.id as string;
  
  return null;
}

async function tryClaimEvent(
  client: PoolClient,
  eventId: string,
  eventType: string,
  eventTimestamp: number,
  resourceId: string | null
): Promise<{ claimed: boolean; reason?: 'duplicate' | 'out_of_order' }> {
  const claimed = await client.query(
    `INSERT INTO webhook_processed_events (event_id, event_type, resource_id, processed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType, resourceId]
  );

  if (claimed.rowCount === 0) {
    return { claimed: false, reason: 'duplicate' };
  }

  return { claimed: true };
}

async function checkResourceEventOrder(
  client: PoolClient,
  resourceId: string,
  eventType: string,
  eventTimestamp: number
): Promise<boolean> {
  const EVENT_PRIORITY: Record<string, number> = {
    // Payment intent lifecycle
    'payment_intent.created': 1,
    'payment_intent.processing': 2,
    'payment_intent.requires_action': 3,
    'payment_intent.succeeded': 10,
    'payment_intent.payment_failed': 10,
    'payment_intent.canceled': 10,
    'charge.succeeded': 11,
    'charge.refunded': 20,
    'charge.dispute.created': 25,
    'charge.dispute.updated': 25,
    'charge.dispute.closed': 26,
    // Invoice lifecycle
    'invoice.created': 1,
    'invoice.finalized': 2,
    'invoice.payment_action_required': 5,
    'invoice.payment_succeeded': 10,
    'invoice.payment_failed': 10,
    'invoice.paid': 11,
    'invoice.overdue': 15,
    'invoice.voided': 20,
    'invoice.marked_uncollectible': 20,
    // Checkout session lifecycle
    'checkout.session.completed': 10,
    'checkout.session.expired': 20,
    'checkout.session.async_payment_succeeded': 15,
    'checkout.session.async_payment_failed': 15,
    // Setup intent lifecycle
    'setup_intent.succeeded': 10,
    'setup_intent.setup_failed': 10,
    // Subscription lifecycle (prevents cancelled user reactivation)
    'customer.subscription.created': 1,
    'customer.subscription.updated': 5,
    'customer.subscription.paused': 8,
    'customer.subscription.resumed': 9,
    'customer.subscription.deleted': 20,
  };

  const currentPriority = EVENT_PRIORITY[eventType] || 5;

  const result = await client.query(
    `SELECT event_type, processed_at FROM webhook_processed_events 
     WHERE resource_id = $1 AND event_type != $2
     ORDER BY processed_at DESC LIMIT 1`,
    [resourceId, eventType]
  );

  if (result.rows.length === 0) {
    return true;
  }

  const lastEventType = result.rows[0].event_type;
  const lastPriority = EVENT_PRIORITY[lastEventType] || 5;

  if (lastPriority > currentPriority) {
    if (eventType === 'customer.subscription.created') {
      if (lastEventType === 'customer.subscription.deleted') {
        logger.info(`[Stripe Webhook] Blocking stale subscription.created after subscription.deleted for resource ${resourceId} — preventing ghost reactivation`);
        return false;
      }
      logger.info(`[Stripe Webhook] Out-of-order event: ${eventType} (priority ${currentPriority}) after ${lastEventType} (priority ${lastPriority}) for resource ${resourceId} — allowing through because subscription creation should never be skipped`);
      return true;
    }
    logger.info(`[Stripe Webhook] Out-of-order event: ${eventType} (priority ${currentPriority}) after ${lastEventType} (priority ${lastPriority}) for resource ${resourceId}`);
    return false;
  }

  return true;
}

async function executeDeferredActions(actions: DeferredAction[]): Promise<void> {
  for (const action of actions) {
    try {
      await action();
    } catch (err: unknown) {
      logger.error('[Stripe Webhook] Deferred action failed (non-critical):', { error: err });
    }
  }
}

interface CacheTransactionParams {
  stripeId: string;
  objectType: 'payment_intent' | 'charge' | 'invoice' | 'refund';
  amountCents: number;
  currency?: string;
  status: string;
  createdAt: Date;
  customerId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  description?: string | null;
  metadata?: Record<string, string> | null;
  source?: 'webhook' | 'backfill';
  paymentIntentId?: string | null;
  chargeId?: string | null;
  invoiceId?: string | null;
}

export async function upsertTransactionCache(params: CacheTransactionParams): Promise<void> {
  try {
    await db.execute(
      sql`INSERT INTO stripe_transaction_cache 
       (stripe_id, object_type, amount_cents, currency, status, created_at, updated_at, 
        customer_id, customer_email, customer_name, description, metadata, source, 
        payment_intent_id, charge_id, invoice_id)
       VALUES (${params.stripeId}, ${params.objectType}, ${params.amountCents}, ${params.currency || 'usd'}, ${params.status}, ${params.createdAt}, NOW(), ${params.customerId || null}, ${params.customerEmail || null}, ${params.customerName || null}, ${params.description || null}, ${params.metadata ? JSON.stringify(params.metadata) : null}, ${params.source || 'webhook'}, ${params.paymentIntentId || null}, ${params.chargeId || null}, ${params.invoiceId || null})
       ON CONFLICT (stripe_id) DO UPDATE SET
         status = EXCLUDED.status,
         amount_cents = EXCLUDED.amount_cents,
         customer_email = COALESCE(EXCLUDED.customer_email, stripe_transaction_cache.customer_email),
         customer_name = COALESCE(EXCLUDED.customer_name, stripe_transaction_cache.customer_name),
         description = COALESCE(EXCLUDED.description, stripe_transaction_cache.description),
         metadata = COALESCE(EXCLUDED.metadata, stripe_transaction_cache.metadata),
         updated_at = NOW()`
    );
  } catch (err: unknown) {
    logger.error('[Stripe Cache] Error upserting transaction cache:', { error: err });
  }
}

async function cleanupOldProcessedEvents(): Promise<void> {
  try {
    const result = await db.delete(webhookProcessedEvents)
      .where(lt(webhookProcessedEvents.processedAt, sql`NOW() - INTERVAL '7 days'`))
      .returning({ id: webhookProcessedEvents.id });
    if (result.length > 0) {
      logger.info(`[Stripe Webhook] Cleaned up ${result.length} old processed events (>${EVENT_DEDUP_WINDOW_DAYS} days)`);
    }
  } catch (err: unknown) {
    logger.error('[Stripe Webhook] Error cleaning up old events:', { error: err });
  }
}

export async function processStripeWebhook(
  payload: Buffer,
  signature: string
): Promise<void> {
  if (!Buffer.isBuffer(payload)) {
    throw new Error(
      'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
      'Received type: ' + typeof payload + '. ' +
      'This usually means express.json() parsed the body before reaching this handler.'
    );
  }

  const sync = await getStripeSync() as { processWebhook: (payload: Buffer, signature: string) => Promise<void> };
  await sync.processWebhook(payload, signature);

  const payloadString = payload.toString('utf8');
  const event = JSON.parse(payloadString);

  const resourceId = extractResourceId(event);
  const client = await pool.connect();
  let deferredActions: DeferredAction[] = [];

  try {
    await client.query('BEGIN');

    const claimResult = await tryClaimEvent(client, event.id, event.type, event.created, resourceId);
    
    if (!claimResult.claimed) {
      await client.query('ROLLBACK');
      logger.info(`[Stripe Webhook] Skipping ${claimResult.reason} event: ${event.id} (${event.type})`);
      return;
    }

    if (resourceId) {
      const orderOk = await checkResourceEventOrder(client, resourceId, event.type, event.created);
      if (!orderOk) {
        await client.query('ROLLBACK');
        logger.info(`[Stripe Webhook] Skipping out-of-order event: ${event.id} (${event.type}) for resource ${resourceId}`);
        return;
      }
    }

    logger.info(`[Stripe Webhook] Processing event: ${event.id} (${event.type})`);

    if (event.type === 'payment_intent.processing' || event.type === 'payment_intent.requires_action') {
      deferredActions = await handlePaymentIntentStatusUpdate(client, event.data.object);
    } else if (event.type === 'payment_intent.succeeded') {
      deferredActions = await handlePaymentIntentSucceeded(client, event.data.object);
    } else if (event.type === 'payment_intent.payment_failed') {
      deferredActions = await handlePaymentIntentFailed(client, event.data.object);
    } else if (event.type === 'payment_intent.canceled') {
      deferredActions = await handlePaymentIntentCanceled(client, event.data.object);
    } else if (event.type === 'charge.refunded') {
      deferredActions = await handleChargeRefunded(client, event.data.object);
    } else if (event.type === 'invoice.payment_succeeded') {
      deferredActions = await handleInvoicePaymentSucceeded(client, event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      deferredActions = await handleInvoicePaymentFailed(client, event.data.object);
    } else if (event.type === 'invoice.created' || event.type === 'invoice.finalized' || event.type === 'invoice.updated') {
      deferredActions = await handleInvoiceLifecycle(client, event.data.object, event.type);
    } else if (event.type === 'invoice.voided' || event.type === 'invoice.marked_uncollectible') {
      deferredActions = await handleInvoiceVoided(client, event.data.object, event.type);
    } else if (event.type === 'checkout.session.completed') {
      deferredActions = await handleCheckoutSessionCompleted(client, event.data.object);
    } else if (event.type === 'customer.subscription.created') {
      deferredActions = await handleSubscriptionCreated(client, event.data.object);
    } else if (event.type === 'customer.subscription.updated') {
      deferredActions = await handleSubscriptionUpdated(client, event.data.object, event.data.previous_attributes);
    } else if (event.type === 'customer.subscription.paused') {
      deferredActions = await handleSubscriptionPaused(client, event.data.object);
    } else if (event.type === 'customer.subscription.resumed') {
      deferredActions = await handleSubscriptionResumed(client, event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      deferredActions = await handleSubscriptionDeleted(client, event.data.object);
    } else if (event.type === 'charge.dispute.created') {
      deferredActions = await handleChargeDisputeCreated(client, event.data.object);
    } else if (event.type === 'charge.dispute.closed') {
      deferredActions = await handleChargeDisputeClosed(client, event.data.object);
    } else if (event.type === 'product.updated') {
      deferredActions = await handleProductUpdated(client, event.data.object as StripeProductWithMarketingFeatures);
    } else if (event.type === 'product.created') {
      deferredActions = await handleProductCreated(client, event.data.object as StripeProductWithMarketingFeatures);
    } else if (event.type === 'product.deleted') {
      deferredActions = await handleProductDeleted(client, event.data.object);
    } else if (event.type === 'price.updated' || event.type === 'price.created') {
      deferredActions = await handlePriceChange(client, event.data.object);
    } else if (event.type === 'coupon.updated' || event.type === 'coupon.created') {
      const coupon = event.data.object as Stripe.Coupon;
      if (coupon.id === 'FAMILY20' && coupon.percent_off) {
        updateFamilyDiscountPercent(coupon.percent_off);
        logger.info(`[Stripe Webhook] FAMILY20 coupon ${event.type}: ${coupon.percent_off}% off`);
      }
    } else if (event.type === 'coupon.deleted') {
      const coupon = event.data.object as Stripe.Coupon;
      if (coupon.id === 'FAMILY20') {
        logger.info('[Stripe Webhook] FAMILY20 coupon deleted - will be recreated on next use');
      }
    } else if (event.type === 'credit_note.created') {
      deferredActions = await handleCreditNoteCreated(client, event.data.object as Stripe.CreditNote);
    } else if (event.type === 'customer.updated') {
      deferredActions = await handleCustomerUpdated(client, event.data.object as Stripe.Customer);
    } else if (event.type === 'customer.subscription.trial_will_end') {
      deferredActions = await handleTrialWillEnd(client, event.data.object as Stripe.Subscription);
    } else if (event.type === 'payment_method.attached') {
      deferredActions = await handlePaymentMethodAttached(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'customer.created') {
      deferredActions = await handleCustomerCreated(client, event.data.object as Stripe.Customer);
    } else if (event.type === 'customer.deleted') {
      deferredActions = await handleCustomerDeleted(client, event.data.object as Stripe.Customer);
    } else if (event.type === 'payment_method.detached') {
      deferredActions = await handlePaymentMethodDetached(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'payment_method.updated') {
      deferredActions = await handlePaymentMethodUpdated(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'payment_method.automatically_updated') {
      deferredActions = await handlePaymentMethodAutoUpdated(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'charge.dispute.updated') {
      deferredActions = await handleChargeDisputeUpdated(client, event.data.object as Stripe.Dispute);
    } else if (event.type === 'checkout.session.expired') {
      deferredActions = await handleCheckoutSessionExpired(client, event.data.object as Stripe.Checkout.Session);
    } else if (event.type === 'checkout.session.async_payment_failed') {
      deferredActions = await handleCheckoutSessionAsyncPaymentFailed(client, event.data.object as Stripe.Checkout.Session);
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      deferredActions = await handleCheckoutSessionAsyncPaymentSucceeded(client, event.data.object as Stripe.Checkout.Session);
    } else if (event.type === 'invoice.payment_action_required') {
      deferredActions = await handleInvoicePaymentActionRequired(client, event.data.object as InvoiceWithLegacyFields);
    } else if (event.type === 'invoice.overdue') {
      deferredActions = await handleInvoiceOverdue(client, event.data.object as InvoiceWithLegacyFields);
    } else if (event.type === 'setup_intent.succeeded') {
      deferredActions = await handleSetupIntentSucceeded(client, event.data.object as Stripe.SetupIntent);
    } else if (event.type === 'setup_intent.setup_failed') {
      deferredActions = await handleSetupIntentFailed(client, event.data.object as Stripe.SetupIntent);
    }

    await client.query('COMMIT');
    logger.info(`[Stripe Webhook] Event ${event.id} committed successfully`);

    await executeDeferredActions(deferredActions);

    if (Math.random() < 0.05) {
      cleanupOldProcessedEvents().catch(err => 
        logger.warn('[Stripe Webhook] Background cleanup failed:', { error: err })
      );
    }

  } catch (handlerError: unknown) {
    await client.query('ROLLBACK');
    logger.error(`[Stripe Webhook] Handler failed for ${event.type} (${event.id}), rolled back:`, { error: handlerError });
    throw handlerError;
  } finally {
    client.release();
  }
}

export async function replayStripeEvent(
  eventId: string,
  forceReplay: boolean = false
): Promise<{ success: boolean; eventType: string; message: string }> {
  const stripe = await getStripeClient();
  const event = await stripe.events.retrieve(eventId);

  const resourceId = extractResourceId(event);
  const client = await pool.connect();
  let deferredActions: DeferredAction[] = [];

  try {
    await client.query('BEGIN');

    if (!forceReplay) {
      const claimResult = await tryClaimEvent(client, event.id, event.type, event.created, resourceId);

      if (!claimResult.claimed) {
        await client.query('ROLLBACK');
        logger.info(`[Stripe Webhook Replay] Skipping ${claimResult.reason} event: ${event.id} (${event.type})`);
        return { success: false, eventType: event.type, message: `Event already processed (${claimResult.reason}). Use forceReplay=true to override.` };
      }
    }

    if (resourceId) {
      const orderOk = await checkResourceEventOrder(client, resourceId, event.type, event.created);
      if (!orderOk) {
        await client.query('ROLLBACK');
        logger.info(`[Stripe Webhook Replay] Skipping out-of-order event: ${event.id} (${event.type}) for resource ${resourceId}`);
        return { success: false, eventType: event.type, message: `Event is out of order for resource ${resourceId}` };
      }
    }

    logger.info(`[Stripe Webhook Replay] Processing event: ${event.id} (${event.type})`);

    if (event.type === 'payment_intent.processing' || event.type === 'payment_intent.requires_action') {
      deferredActions = await handlePaymentIntentStatusUpdate(client, event.data.object);
    } else if (event.type === 'payment_intent.succeeded') {
      deferredActions = await handlePaymentIntentSucceeded(client, event.data.object);
    } else if (event.type === 'payment_intent.payment_failed') {
      deferredActions = await handlePaymentIntentFailed(client, event.data.object);
    } else if (event.type === 'payment_intent.canceled') {
      deferredActions = await handlePaymentIntentCanceled(client, event.data.object);
    } else if (event.type === 'charge.refunded') {
      deferredActions = await handleChargeRefunded(client, event.data.object);
    } else if (event.type === 'invoice.payment_succeeded') {
      deferredActions = await handleInvoicePaymentSucceeded(client, event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      deferredActions = await handleInvoicePaymentFailed(client, event.data.object);
    } else if (event.type === 'invoice.created' || event.type === 'invoice.finalized' || event.type === 'invoice.updated') {
      deferredActions = await handleInvoiceLifecycle(client, event.data.object, event.type);
    } else if (event.type === 'invoice.voided' || event.type === 'invoice.marked_uncollectible') {
      deferredActions = await handleInvoiceVoided(client, event.data.object, event.type);
    } else if (event.type === 'checkout.session.completed') {
      deferredActions = await handleCheckoutSessionCompleted(client, event.data.object);
    } else if (event.type === 'customer.subscription.created') {
      deferredActions = await handleSubscriptionCreated(client, event.data.object);
    } else if (event.type === 'customer.subscription.updated') {
      deferredActions = await handleSubscriptionUpdated(client, event.data.object, event.data.previous_attributes);
    } else if (event.type === 'customer.subscription.paused') {
      deferredActions = await handleSubscriptionPaused(client, event.data.object);
    } else if (event.type === 'customer.subscription.resumed') {
      deferredActions = await handleSubscriptionResumed(client, event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      deferredActions = await handleSubscriptionDeleted(client, event.data.object);
    } else if (event.type === 'charge.dispute.created') {
      deferredActions = await handleChargeDisputeCreated(client, event.data.object);
    } else if (event.type === 'charge.dispute.closed') {
      deferredActions = await handleChargeDisputeClosed(client, event.data.object);
    } else if (event.type === 'product.updated') {
      deferredActions = await handleProductUpdated(client, event.data.object as StripeProductWithMarketingFeatures);
    } else if (event.type === 'product.created') {
      deferredActions = await handleProductCreated(client, event.data.object as StripeProductWithMarketingFeatures);
    } else if (event.type === 'product.deleted') {
      deferredActions = await handleProductDeleted(client, event.data.object);
    } else if (event.type === 'price.updated' || event.type === 'price.created') {
      deferredActions = await handlePriceChange(client, event.data.object);
    } else if (event.type === 'coupon.updated' || event.type === 'coupon.created') {
      const coupon = event.data.object as Stripe.Coupon;
      if (coupon.id === 'FAMILY20' && coupon.percent_off) {
        updateFamilyDiscountPercent(coupon.percent_off);
        logger.info(`[Stripe Webhook Replay] FAMILY20 coupon ${event.type}: ${coupon.percent_off}% off`);
      }
    } else if (event.type === 'coupon.deleted') {
      const coupon = event.data.object as Stripe.Coupon;
      if (coupon.id === 'FAMILY20') {
        logger.info('[Stripe Webhook Replay] FAMILY20 coupon deleted - will be recreated on next use');
      }
    } else if (event.type === 'credit_note.created') {
      deferredActions = await handleCreditNoteCreated(client, event.data.object as Stripe.CreditNote);
    } else if (event.type === 'customer.updated') {
      deferredActions = await handleCustomerUpdated(client, event.data.object as Stripe.Customer);
    } else if (event.type === 'customer.subscription.trial_will_end') {
      deferredActions = await handleTrialWillEnd(client, event.data.object as Stripe.Subscription);
    } else if (event.type === 'payment_method.attached') {
      deferredActions = await handlePaymentMethodAttached(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'customer.created') {
      deferredActions = await handleCustomerCreated(client, event.data.object as Stripe.Customer);
    } else if (event.type === 'customer.deleted') {
      deferredActions = await handleCustomerDeleted(client, event.data.object as Stripe.Customer);
    } else if (event.type === 'payment_method.detached') {
      deferredActions = await handlePaymentMethodDetached(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'payment_method.updated') {
      deferredActions = await handlePaymentMethodUpdated(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'payment_method.automatically_updated') {
      deferredActions = await handlePaymentMethodAutoUpdated(client, event.data.object as Stripe.PaymentMethod);
    } else if (event.type === 'charge.dispute.updated') {
      deferredActions = await handleChargeDisputeUpdated(client, event.data.object as Stripe.Dispute);
    } else if (event.type === 'checkout.session.expired') {
      deferredActions = await handleCheckoutSessionExpired(client, event.data.object as Stripe.Checkout.Session);
    } else if (event.type === 'checkout.session.async_payment_failed') {
      deferredActions = await handleCheckoutSessionAsyncPaymentFailed(client, event.data.object as Stripe.Checkout.Session);
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      deferredActions = await handleCheckoutSessionAsyncPaymentSucceeded(client, event.data.object as Stripe.Checkout.Session);
    } else if (event.type === 'invoice.payment_action_required') {
      deferredActions = await handleInvoicePaymentActionRequired(client, event.data.object as InvoiceWithLegacyFields);
    } else if (event.type === 'invoice.overdue') {
      deferredActions = await handleInvoiceOverdue(client, event.data.object as InvoiceWithLegacyFields);
    } else if (event.type === 'setup_intent.succeeded') {
      deferredActions = await handleSetupIntentSucceeded(client, event.data.object as Stripe.SetupIntent);
    } else if (event.type === 'setup_intent.setup_failed') {
      deferredActions = await handleSetupIntentFailed(client, event.data.object as Stripe.SetupIntent);
    }

    await client.query('COMMIT');
    logger.info(`[Stripe Webhook Replay] Event ${event.id} committed successfully`);

    await executeDeferredActions(deferredActions);

    if (Math.random() < 0.05) {
      cleanupOldProcessedEvents().catch(err => 
        logger.warn('[Stripe Webhook] Background cleanup failed:', { error: err })
      );
    }

    return { success: true, eventType: event.type, message: `Successfully replayed event ${event.id} (${event.type})` };
  } catch (handlerError: unknown) {
    await client.query('ROLLBACK');
    logger.error(`[Stripe Webhook Replay] Handler failed for ${event.type} (${event.id}), rolled back:`, { error: handlerError });
    throw handlerError;
  } finally {
    client.release();
  }
}

async function handleCreditNoteCreated(client: PoolClient, creditNote: Stripe.CreditNote): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  
  const { id, number, invoice, customer, total, currency, status, created, reason, memo, lines } = creditNote;
  
  logger.info(`[Stripe Webhook] Credit note created: ${id} (${number}), total: $${(total / 100).toFixed(2)}, reason: ${reason || 'none'}`);
  
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const invoiceId = typeof invoice === 'string' ? invoice : invoice?.id;
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'refund',
      amountCents: total,
      currency: currency || 'usd',
      status: status || 'issued',
      createdAt: new Date(created * 1000),
      customerId,
      invoiceId,
      description: memo || `Credit note ${number}`,
      metadata: { type: 'credit_note', reason, number },
      source: 'webhook',
    });
  });
  
  if (customerId) {
    const memberResult = await client.query(
      `SELECT email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );
    
    if (memberResult.rows.length > 0) {
      const member = memberResult.rows[0];
      const amountStr = `$${(total / 100).toFixed(2)}`;
      
      deferredActions.push(async () => {
        try {
          await db.execute(
            sql`INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
             VALUES (${member.email.toLowerCase()}, ${'Credit Applied'}, ${`A credit of ${amountStr} has been applied to your account${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}.`}, ${'billing'}, ${'payment'}, NOW())`
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to create credit note notification:', { error: err });
        }
      });
      
      logger.info(`[Stripe Webhook] Credit note ${id} for member ${member.email}: ${amountStr}`);
    }
  }
  
  return deferredActions;
}

async function handleChargeRefunded(client: PoolClient, charge: Stripe.Charge): Promise<DeferredAction[]> {
  const { id, amount, amount_refunded, currency, customer, payment_intent, created, refunded } = charge;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Charge refunded: ${id}, refunded amount: $${(amount_refunded / 100).toFixed(2)}`);
  
  const status = refunded ? 'refunded' : 'partially_refunded';
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const paymentIntentId = typeof payment_intent === 'string' ? payment_intent : payment_intent?.id;
  
  const refunds = charge.refunds?.data || [];
  
  if (refunds.length > 0) {
    for (const refund of refunds) {
      if (refund?.id && refund?.amount) {
        deferredActions.push(async () => {
          await upsertTransactionCache({
            stripeId: refund.id,
            objectType: 'refund',
            amountCents: refund.amount,
            currency: refund.currency || currency || 'usd',
            status: refund.status || 'succeeded',
            createdAt: new Date(refund.created ? refund.created * 1000 : Date.now()),
            customerId,
            paymentIntentId,
            chargeId: id,
            source: 'webhook',
          });
        });
      }
    }
    logger.info(`[Stripe Webhook] Cached ${refunds.length} refund(s) for charge ${id}`);
  } else {
    logger.warn(`[Stripe Webhook] No refund objects found in charge.refunded event for charge ${id}`);
  }
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'charge',
      amountCents: amount,
      currency: currency || 'usd',
      status,
      createdAt: new Date(created * 1000),
      customerId,
      paymentIntentId,
      chargeId: id,
      source: 'webhook',
    });
  });
  
  if (paymentIntentId) {
    await client.query(
      `UPDATE stripe_payment_intents SET status = $1, updated_at = NOW() WHERE stripe_payment_intent_id = $2`,
      [status, paymentIntentId]
    );
    
    deferredActions.push(async () => {
      await upsertTransactionCache({
        stripeId: paymentIntentId,
        objectType: 'payment_intent',
        amountCents: amount,
        currency: currency || 'usd',
        status,
        createdAt: new Date(created * 1000),
        customerId,
        paymentIntentId,
        chargeId: id,
        source: 'webhook',
      });
    });
    
    const participantUpdate = await client.query(
      `UPDATE booking_participants 
       SET payment_status = 'refunded', refunded_at = NOW()
       WHERE stripe_payment_intent_id = $1 AND payment_status = 'paid'
       RETURNING id, session_id, user_email`,
      [paymentIntentId]
    );
    
    if (participantUpdate.rowCount && participantUpdate.rowCount > 0) {
      logger.info(`[Stripe Webhook] Marked ${participantUpdate.rowCount} participant(s) as refunded for PI ${paymentIntentId}`);
      
      for (const row of participantUpdate.rows) {
        const bookingLookup = await client.query(
          `SELECT br.id FROM booking_sessions bs JOIN booking_requests br ON br.trackman_booking_id = bs.trackman_booking_id WHERE bs.id = $1 LIMIT 1`,
          [row.session_id]
        );
        const auditBookingId = bookingLookup.rows[0]?.id;
        if (auditBookingId) {
          await logPaymentAudit({
            bookingId: auditBookingId,
            sessionId: row.session_id,
            participantId: row.id,
            action: 'refund_processed',
            staffEmail: 'system',
            staffName: 'Stripe Webhook',
            amountAffected: 0,
            paymentMethod: 'stripe',
            metadata: { stripePaymentIntentId: paymentIntentId },
          });
        }
        
        // Send refund notification to member
        if (row.user_email) {
          await client.query(
            `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [row.user_email.toLowerCase(), 'Payment Refunded', `Your booking payment of $${(amount_refunded / 100).toFixed(2)} has been refunded. It may take 5-10 business days to appear on your statement.`, 'billing', 'payment']
          );
          
          deferredActions.push(async () => {
            sendNotificationToUser(row.user_email, {
              type: 'notification',
              title: 'Payment Refunded',
              message: `Your booking payment of $${(amount_refunded / 100).toFixed(2)} has been refunded. It may take 5-10 business days to appear on your statement.`,
              data: { sessionId: row.session_id, eventType: 'payment_refunded' }
            }, { action: 'payment_refunded', sessionId: row.session_id, triggerSource: 'webhooks.ts' } as Record<string, unknown>);
          });
        }
      }
    }
  }
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({ action: 'payment_refunded', status, amount: amount_refunded });
  });

  if (paymentIntentId) {
    const terminalPaymentResult = await client.query(
      `UPDATE terminal_payments 
       SET status = $1, refunded_at = NOW(), refund_amount_cents = GREATEST(COALESCE(refund_amount_cents, 0), $2), updated_at = NOW()
       WHERE stripe_payment_intent_id = $3 AND status IN ('succeeded', 'partially_refunded')
       RETURNING id, user_id, user_email, stripe_subscription_id, amount_cents`,
      [status, amount_refunded, paymentIntentId]
    );
    
    if (terminalPaymentResult.rowCount && terminalPaymentResult.rowCount > 0) {
      const terminalPayment = terminalPaymentResult.rows[0];
      logger.info(`[Stripe Webhook] Terminal payment refunded for user ${terminalPayment.user_email}`);
      
      if (refunded) {
        const refundUserCheck = await client.query(
          `SELECT billing_provider FROM users WHERE id = $1`,
          [terminalPayment.user_id]
        );
        const refundBillingProvider = refundUserCheck.rows[0]?.billing_provider;

        if (refundBillingProvider && refundBillingProvider !== '' && refundBillingProvider !== 'stripe') {
          logger.info(`[Stripe Webhook] Skipping charge.refunded for ${terminalPayment.user_email} — billing_provider is '${refundBillingProvider}', not 'stripe'`);
        } else {
          logger.info(`[Stripe Webhook] Terminal payment fully refunded for user ${terminalPayment.user_id} — flagging for admin review (not auto-suspending)`);

          deferredActions.push(async () => {
            await notifyAllStaff(
              'Terminal Payment Refunded — Review Required',
              `A Terminal payment of $${(terminalPayment.amount_cents / 100).toFixed(2)} for ${terminalPayment.user_email} has been fully refunded ($${(amount_refunded / 100).toFixed(2)}). Please review whether membership status should be changed.`,
              'terminal_refund',
              { sendPush: true }
            );

            await logSystemAction({
              action: 'terminal_payment_refunded',
              resourceType: 'user',
              resourceId: terminalPayment.user_id,
              resourceName: terminalPayment.user_email,
              details: {
                source: 'stripe_webhook',
                stripe_payment_intent_id: paymentIntentId,
                stripe_subscription_id: terminalPayment.stripe_subscription_id,
                amount_cents: terminalPayment.amount_cents,
                refund_amount_cents: amount_refunded,
                membership_action: 'flagged_for_review'
              }
            });
          });
        }
      }
    }
  }

  // Audit log for refunds
  const isPartialRefund = amount_refunded < amount;
  const memberEmail = charge.billing_details?.email || charge.receipt_email || 'unknown';
  for (const refund of refunds) {
    if (refund?.id) {
      deferredActions.push(async () => {
        await logSystemAction({
          action: isPartialRefund ? 'payment_refund_partial' : 'payment_refunded',
          resourceType: 'payment',
          resourceId: refund.id,
          resourceName: `Refund for ${memberEmail}`,
          details: {
            source: 'stripe_webhook',
            stripe_refund_id: refund.id,
            stripe_payment_intent_id: paymentIntentId,
            amount_cents: refund.amount,
            refund_reason: refund.reason || 'not_specified',
            member_email: memberEmail,
            is_partial: isPartialRefund
          }
        });
      });
    }
  }

  return deferredActions;
}

async function handleChargeDisputeCreated(client: PoolClient, dispute: Stripe.Dispute): Promise<DeferredAction[]> {
  const { id, amount, currency, charge, payment_intent, reason, status } = dispute;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Dispute created: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${reason}`);
  
  const paymentIntentId = typeof payment_intent === 'string' ? payment_intent : payment_intent?.id;
  
  if (paymentIntentId) {
    const terminalPaymentResult = await client.query(
      `UPDATE terminal_payments 
       SET disputed_at = NOW(), dispute_id = $1, dispute_status = $2, status = 'disputed', updated_at = NOW()
       WHERE stripe_payment_intent_id = $3 AND status IN ('succeeded', 'partially_refunded')
       RETURNING id, user_id, user_email, stripe_subscription_id, amount_cents`,
      [id, status, paymentIntentId]
    );
    
    if (terminalPaymentResult.rowCount && terminalPaymentResult.rowCount > 0) {
      const terminalPayment = terminalPaymentResult.rows[0];
      logger.info(`[Stripe Webhook] Terminal payment disputed for user ${terminalPayment.user_email}`);
      
      const disputeUserCheck = await client.query(
        `SELECT billing_provider FROM users WHERE id = $1`,
        [terminalPayment.user_id]
      );
      const disputeBillingProvider = disputeUserCheck.rows[0]?.billing_provider;

      if (disputeBillingProvider && disputeBillingProvider !== '' && disputeBillingProvider !== 'stripe') {
        logger.info(`[Stripe Webhook] Skipping charge.dispute.created for ${terminalPayment.user_email} — billing_provider is '${disputeBillingProvider}', not 'stripe'`);
      } else {
        await client.query(
          `UPDATE users SET membership_status = 'suspended', billing_provider = 'stripe', updated_at = NOW() WHERE id = $1`,
          [terminalPayment.user_id]
        );
        logger.info(`[Stripe Webhook] Suspended membership for user ${terminalPayment.user_id} due to payment dispute`);
      
        await client.query(
          `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            terminalPayment.user_email.toLowerCase(), 
            'Membership Suspended', 
            'Your membership has been suspended due to a payment dispute. Please contact staff immediately to resolve this issue.',
            'billing',
            'membership'
          ]
        );
      }
      
      deferredActions.push(async () => {
        await notifyAllStaff(
          'URGENT: Payment Dispute Received',
          `A payment dispute has been filed for ${terminalPayment.user_email}. Amount: $${(amount / 100).toFixed(2)}. Reason: ${reason || 'not specified'}. Membership has been suspended.`,
          'terminal_dispute',
          { sendPush: true }
        );
        
        await logSystemAction({
          action: 'terminal_payment_disputed',
          resourceType: 'user',
          resourceId: terminalPayment.user_id,
          resourceName: terminalPayment.user_email,
          details: {
            source: 'stripe_webhook',
            dispute_id: id,
            dispute_reason: reason,
            dispute_status: status,
            stripe_payment_intent_id: paymentIntentId,
            stripe_subscription_id: terminalPayment.stripe_subscription_id,
            amount_cents: terminalPayment.amount_cents,
            disputed_amount_cents: amount,
            membership_action: 'suspended'
          }
        });
      });
    }
  }
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({ action: 'payment_failed', status, amount });
  });
  
  return deferredActions;
}

async function handleChargeDisputeClosed(client: PoolClient, dispute: Stripe.Dispute): Promise<DeferredAction[]> {
  const { id, amount, payment_intent, reason, status } = dispute;
  const deferredActions: DeferredAction[] = [];
  
  const disputeWon = status === 'won';
  logger.info(`[Stripe Webhook] Dispute closed: ${id}, status: ${status}, won: ${disputeWon}`);
  
  const paymentIntentId = typeof payment_intent === 'string' ? payment_intent : payment_intent?.id;
  
  if (paymentIntentId) {
    const terminalPaymentResult = await client.query(
      `UPDATE terminal_payments 
       SET dispute_status = $1, dispute_id = $2, disputed_at = COALESCE(disputed_at, NOW()), 
           status = $3, updated_at = NOW()
       WHERE stripe_payment_intent_id = $4 AND status IN ('succeeded', 'partially_refunded', 'disputed')
       RETURNING id, user_id, user_email, stripe_subscription_id, amount_cents`,
      [status, id, disputeWon ? 'succeeded' : 'disputed_lost', paymentIntentId]
    );
    
    if (terminalPaymentResult.rowCount && terminalPaymentResult.rowCount > 0) {
      const terminalPayment = terminalPaymentResult.rows[0];
      logger.info(`[Stripe Webhook] Terminal payment dispute closed for user ${terminalPayment.user_email}: ${status}`);
      
      if (disputeWon) {
        const disputeClosedUserCheck = await client.query(
          `SELECT billing_provider FROM users WHERE id = $1`,
          [terminalPayment.user_id]
        );
        const disputeClosedBillingProvider = disputeClosedUserCheck.rows[0]?.billing_provider;

        if (disputeClosedBillingProvider && disputeClosedBillingProvider !== '' && disputeClosedBillingProvider !== 'stripe') {
          logger.info(`[Stripe Webhook] Skipping charge.dispute.closed for ${terminalPayment.user_email} — billing_provider is '${disputeClosedBillingProvider}', not 'stripe'`);
        } else {
          await client.query(
            `UPDATE users SET membership_status = 'active', billing_provider = 'stripe', updated_at = NOW() WHERE id = $1`,
            [terminalPayment.user_id]
          );
          logger.info(`[Stripe Webhook] Reactivated membership for user ${terminalPayment.user_id} - dispute won`);
        
          await client.query(
            `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
              terminalPayment.user_email.toLowerCase(), 
              'Membership Reactivated', 
              'Your membership has been reactivated. The payment dispute has been resolved in your favor.',
              'billing',
              'membership'
            ]
          );
        }
      }
      
      deferredActions.push(async () => {
        await notifyAllStaff(
          disputeWon ? 'Dispute Won - Membership Reactivated' : 'Dispute Lost - Membership Remains Suspended',
          `Payment dispute for ${terminalPayment.user_email} has been closed. Status: ${status}. Amount: $${(amount / 100).toFixed(2)}.${disputeWon ? ' Membership has been reactivated.' : ' Membership remains suspended.'}`,
          'terminal_dispute_closed',
          { sendPush: true }
        );
        
        await logSystemAction({
          action: 'terminal_dispute_closed',
          resourceType: 'user',
          resourceId: terminalPayment.user_id,
          resourceName: terminalPayment.user_email,
          details: {
            source: 'stripe_webhook',
            dispute_id: id,
            dispute_status: status,
            dispute_won: disputeWon,
            stripe_payment_intent_id: paymentIntentId,
            stripe_subscription_id: terminalPayment.stripe_subscription_id,
            amount_cents: terminalPayment.amount_cents,
            disputed_amount_cents: amount,
            membership_action: disputeWon ? 'reactivated' : 'remained_suspended'
          }
        });
      });
    }
  }
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({ action: 'payment_succeeded', status, amount });
  });
  
  return deferredActions;
}

async function handlePaymentIntentSucceeded(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, metadata, amount, currency, customer, receipt_email, description, created } = paymentIntent;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Payment succeeded: ${id}, amount: $${(amount / 100).toFixed(2)}`);

  const customerEmail = typeof customer === 'object' ? (customer as Stripe.Customer)?.email : receipt_email || metadata?.email;
  const customerName = typeof customer === 'object' ? (customer as Stripe.Customer)?.name : metadata?.memberName;
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'payment_intent',
      amountCents: amount,
      currency: currency || 'usd',
      status: 'succeeded',
      createdAt: new Date(created * 1000),
      customerId,
      customerEmail,
      customerName,
      description: description || metadata?.productName || 'Stripe payment',
      metadata,
      source: 'webhook',
      paymentIntentId: id,
    });
  });

  await client.query(
    `UPDATE stripe_payment_intents 
     SET status = 'succeeded', updated_at = NOW() 
     WHERE stripe_payment_intent_id = $1`,
    [id]
  );

  const sessionId = metadata?.sessionId ? parseInt(metadata.sessionId, 10) : NaN;
  const bookingId = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;
  const amountDollars = (amount / 100).toFixed(2);
  
  interface ParticipantFee { id: number; amountCents: number; }
  let participantFees: ParticipantFee[] = [];
  let validatedParticipantIds: number[] = [];
  const feeSnapshotId = metadata?.feeSnapshotId ? parseInt(metadata.feeSnapshotId, 10) : NaN;
  
  if (!isNaN(feeSnapshotId)) {
    // Query fee snapshot directly - it already has booking_id and session_id
    const snapshotResult = await client.query(
      `SELECT bfs.*
       FROM booking_fee_snapshots bfs
       WHERE bfs.id = $1 AND bfs.stripe_payment_intent_id = $2 AND bfs.status = 'pending'
       FOR UPDATE OF bfs`,
      [feeSnapshotId, id]
    );
    
    if (snapshotResult.rows.length === 0) {
      logger.error(`[Stripe Webhook] Fee snapshot ${feeSnapshotId} not found, already used, or locked by another process`);
      return deferredActions;
    }
    
    const snapshot = snapshotResult.rows[0];
    
    if (Math.abs(snapshot.total_cents - amount) > 1) {
      logger.error(`[Stripe Webhook] CRITICAL: Amount mismatch: snapshot=${snapshot.total_cents}, payment=${amount} - flagging for review`);
      await client.query(
        `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
        [`Amount mismatch: expected ${snapshot.total_cents} cents, received ${amount} cents from Stripe`, snapshot.session_id]
      );
    }
    
    // Full fee recalculation verification - detect potential fee drift
    try {
      const currentFees = await computeFeeBreakdown({ 
        sessionId: snapshot.session_id, 
        source: 'stripe' 
      });
      
      // Compare totals with tolerance (allow up to $1.00 difference for rounding)
      if (Math.abs(currentFees.totals.totalCents - snapshot.total_cents) > 100) {
        logger.error(`[Stripe Webhook] Fee snapshot mismatch - potential drift detected`, { extra: { detail: {
          sessionId: snapshot.session_id,
          snapshotTotal: snapshot.total_cents,
          currentTotal: currentFees.totals.totalCents,
          difference: currentFees.totals.totalCents - snapshot.total_cents
        } } });
        // Don't reject payment but log for investigation
        // The payment already succeeded via Stripe, so we handle this gracefully
      }
    } catch (verifyError: unknown) {
      logger.warn(`[Stripe Webhook] Could not verify fee breakdown for session ${snapshot.session_id}:`, { error: verifyError });
      // Continue processing - verification is non-blocking
    }
    
    const snapshotFees: ParticipantFee[] = snapshot.participant_fees;
    const participantIds = snapshotFees.map(pf => pf.id);
    
    const statusCheck = await client.query(
      `SELECT id, payment_status FROM booking_participants WHERE id = ANY($1::int[]) FOR UPDATE`,
      [participantIds]
    );
    
    const statusMap = new Map<number, string>();
    for (const row of statusCheck.rows) {
      statusMap.set(row.id, row.payment_status || 'pending');
    }
    
    for (const pf of snapshotFees) {
      const status = statusMap.get(pf.id);
      if (status === 'paid' || status === 'waived') {
        logger.warn(`[Stripe Webhook] Participant ${pf.id} already ${status} - skipping`);
        continue;
      }
      participantFees.push(pf);
      validatedParticipantIds.push(pf.id);
    }
    
    const unpaidTotal = participantFees.reduce((sum, pf) => sum + pf.amountCents, 0);
    if (amount > unpaidTotal + 1 && participantFees.length < snapshotFees.length) {
      const alreadyPaidCount = snapshotFees.length - participantFees.length;
      const overpaymentCents = amount - unpaidTotal;
      logger.error(`[Stripe Webhook] CRITICAL: Potential overpayment detected`, { extra: { detail: {
        sessionId: snapshot.session_id,
        paymentAmount: amount,
        unpaidTotal,
        overpaymentCents,
        alreadyPaidCount,
        message: `Payment of ${amount} cents received but only ${unpaidTotal} cents was owed. ${alreadyPaidCount} participant(s) already paid separately.`
      } } });
      await client.query(
        `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
        [`Potential overpayment: received ${amount} cents but only ${unpaidTotal} cents was owed. ${alreadyPaidCount} participant(s) had already paid ${overpaymentCents} cents separately.`, snapshot.session_id]
      );
    }
    
    await client.query(
      `UPDATE booking_fee_snapshots SET status = 'completed', used_at = NOW() WHERE id = $1`,
      [feeSnapshotId]
    );
    
    if (validatedParticipantIds.length > 0) {
      // Update participants directly by ID - we already validated them from the snapshot
      await client.query(
        `UPDATE booking_participants
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
         WHERE id = ANY($1::int[])`,
        [validatedParticipantIds, id]
      );
      logger.info(`[Stripe Webhook] Updated ${validatedParticipantIds.length} participant(s) to paid within transaction`);
      
      for (const pf of participantFees) {
        await logPaymentAudit({
          bookingId,
          sessionId: isNaN(sessionId) ? null : sessionId,
          participantId: pf.id,
          action: 'payment_confirmed',
          staffEmail: 'system',
          staffName: 'Stripe Webhook',
          amountAffected: pf.amountCents / 100,
          paymentMethod: 'stripe',
          metadata: { stripePaymentIntentId: id },
        });
      }
      
      const localBookingId = bookingId;
      const localSessionId = sessionId;
      const localAmount = amount;
      deferredActions.push(async () => {
        broadcastBillingUpdate({
          action: 'booking_payment_updated',
          bookingId: localBookingId,
          sessionId: isNaN(localSessionId) ? undefined : localSessionId,
          amount: localAmount
        });
      });
    }
    
    logger.info(`[Stripe Webhook] Snapshot ${feeSnapshotId} processed (validation + payment update + audit)`);
    validatedParticipantIds = [];
    participantFees = [];
  } else if (metadata?.participantFees) {
    logger.warn(`[Stripe Webhook] No snapshot ID - falling back to DB cached fee validation`);
    let clientFees: ParticipantFee[];
    try {
      clientFees = JSON.parse(metadata.participantFees);
    } catch (parseErr: unknown) {
      logger.error(`[Stripe Webhook] Failed to parse participantFees metadata for PI ${id} - marking for review`, { error: parseErr });
      await client.query(
        `INSERT INTO audit_log (action, resource_type, resource_id, details, created_at)
         VALUES ('parse_error', 'payment', $1, $2, NOW())`,
        [id, JSON.stringify({ error: 'Failed to parse participantFees metadata', raw: metadata.participantFees?.substring(0, 200) })]
      );
      clientFees = [];
    }
    if (clientFees.length === 0 && metadata?.participantFees) {
      logger.warn(`[Stripe Webhook] Empty or unparseable participantFees for PI ${id} - skipping participant updates`);
    }
    const participantIds = clientFees.map(pf => pf.id);
    
    // Query participants directly by ID - simpler and more reliable
    const dbResult = await client.query(
      `SELECT bp.id, bp.payment_status, bp.cached_fee_cents
       FROM booking_participants bp
       WHERE bp.id = ANY($1::int[])
       FOR UPDATE`,
      [participantIds]
    );
    
    const dbFeeMap = new Map<number, number>();
    const statusMap = new Map<number, string>();
    for (const row of dbResult.rows) {
      dbFeeMap.set(row.id, row.cached_fee_cents || 0);
      statusMap.set(row.id, row.payment_status || 'pending');
    }
    
    for (const pf of clientFees) {
      const cachedFee = dbFeeMap.get(pf.id);
      if (cachedFee === undefined) {
        logger.warn(`[Stripe Webhook] Fallback: participant ${pf.id} not in booking - skipping`);
        continue;
      }
      const status = statusMap.get(pf.id);
      if (status === 'paid' || status === 'waived') {
        logger.warn(`[Stripe Webhook] Fallback: participant ${pf.id} already ${status} - skipping`);
        continue;
      }
      if (cachedFee <= 0) {
        logger.warn(`[Stripe Webhook] Fallback: participant ${pf.id} has no cached fee - skipping`);
        continue;
      }
      participantFees.push({ id: pf.id, amountCents: cachedFee });
      validatedParticipantIds.push(pf.id);
    }
    
    const dbTotal = participantFees.reduce((sum, pf) => sum + pf.amountCents, 0);
    if (Math.abs(dbTotal - amount) > 1) {
      logger.error(`[Stripe Webhook] CRITICAL: Fallback total mismatch: db=${dbTotal}, payment=${amount} - flagging for review`);
      if (sessionId) {
        await client.query(
          `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
          [`Fallback amount mismatch: expected ${dbTotal} cents, received ${amount} cents from Stripe`, sessionId]
        );
      }
    }
    
    logger.info(`[Stripe Webhook] Fallback validated ${validatedParticipantIds.length} participants using DB cached fees`);
  }

  if (validatedParticipantIds.length === 0 && !isNaN(bookingId) && metadata?.paymentType === 'booking_fee') {
    logger.warn(`[Stripe Webhook] No snapshot or participantFees metadata for booking_fee PI ${id} — attempting booking-fee fallback`);
    const fallbackResult = await client.query(
      `SELECT bp.id, bp.cached_fee_cents FROM booking_participants bp
       WHERE bp.session_id = (SELECT session_id FROM booking_requests WHERE id = $1)
       AND bp.payment_status = 'pending' AND bp.cached_fee_cents > 0
       AND bp.stripe_payment_intent_id IS NULL`,
      [bookingId]
    );

    if (fallbackResult.rows.length > 0) {
      const fallbackTotal = fallbackResult.rows.reduce((sum: number, r: { cached_fee_cents: number }) => sum + r.cached_fee_cents, 0);
      const tolerance = 50;

      if (Math.abs(fallbackTotal - amount) <= tolerance) {
        for (const row of fallbackResult.rows) {
          participantFees.push({ id: row.id, amountCents: row.cached_fee_cents });
          validatedParticipantIds.push(row.id);
        }
        logger.info(`[Stripe Webhook] Booking-fee fallback: matched ${validatedParticipantIds.length} participant(s) for booking ${bookingId} (pending=${fallbackTotal}, paid=${amount})`);
      } else {
        logger.warn(`[Stripe Webhook] Booking-fee fallback: amount mismatch for booking ${bookingId} (pending=${fallbackTotal}, paid=${amount}, tolerance=${tolerance}) — skipping auto-update`);
        if (!isNaN(sessionId)) {
          await client.query(
            `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
            [`Booking-fee fallback amount mismatch: pending fees ${fallbackTotal} cents vs payment ${amount} cents`, sessionId]
          );
        }
      }
    } else {
      logger.info(`[Stripe Webhook] Booking-fee fallback: no pending participants found for booking ${bookingId}`);
    }
  }

  if (validatedParticipantIds.length > 0) {
    // Update participants directly by ID - we already validated them
    const updateResult = await client.query(
      `UPDATE booking_participants
       SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
       WHERE id = ANY($1::int[])
       RETURNING id`,
      [validatedParticipantIds, id]
    );
    logger.info(`[Stripe Webhook] Updated ${updateResult.rowCount} participant(s) to paid and cleared cached fees with intent ${id}`);
    
    const localBookingId = bookingId;
    const localSessionId = sessionId;
    const localAmount = amount;
    deferredActions.push(async () => {
      broadcastBillingUpdate({
        action: 'booking_payment_updated',
        bookingId: localBookingId,
        sessionId: isNaN(localSessionId) ? undefined : localSessionId,
        amount: localAmount
      });
    });
  }

  if (!isNaN(bookingId) && bookingId > 0) {
    if (participantFees.length > 0) {
      for (const pf of participantFees) {
        await logPaymentAudit({
          bookingId,
          sessionId: isNaN(sessionId) ? null : sessionId,
          participantId: pf.id,
          action: 'payment_confirmed',
          staffEmail: 'system',
          staffName: 'Stripe Webhook',
          amountAffected: pf.amountCents / 100,
          paymentMethod: 'stripe',
          metadata: { stripePaymentIntentId: id },
        });
      }
      logger.info(`[Stripe Webhook] Created ${participantFees.length} audit record(s) for booking ${bookingId}`);
    } else {
      await logPaymentAudit({
        bookingId,
        sessionId: isNaN(sessionId) ? null : sessionId,
        participantId: null,
        action: 'payment_confirmed',
        staffEmail: 'system',
        staffName: 'Stripe Webhook',
        amountAffected: parseFloat(amountDollars),
        paymentMethod: 'stripe',
        metadata: { stripePaymentIntentId: id },
      });
      logger.info(`[Stripe Webhook] Created payment audit record for booking ${bookingId}`);
    }
  }

  // Process pending credit refund if exists (legacy path for backwards compatibility with in-flight payments)
  const pendingCreditRefund = metadata?.pendingCreditRefund ? parseInt(metadata.pendingCreditRefund, 10) : 0;
  if (pendingCreditRefund > 0 && customerId) {
    await queueJobInTransaction(client, 'stripe_credit_refund', {
      paymentIntentId: id,
      amountCents: pendingCreditRefund,
      email: metadata?.email || ''
    }, { webhookEventId: id, priority: 2, maxRetries: 5 });
    logger.info(`[Stripe Webhook] Queued credit refund of $${(pendingCreditRefund / 100).toFixed(2)} for ${metadata?.email || 'unknown'}`);
  }

  // Process credit consumption if exists (new path: card charged reduced amount, consume credit from balance)
  const creditToConsume = metadata?.creditToConsume ? parseInt(metadata.creditToConsume, 10) : 0;
  if (creditToConsume > 0 && customerId) {
    await queueJobInTransaction(client, 'stripe_credit_consume', {
      customerId,
      paymentIntentId: id,
      amountCents: creditToConsume,
      email: metadata?.email || ''
    }, { webhookEventId: id, priority: 2, maxRetries: 5 });
    logger.info(`[Stripe Webhook] Queued credit consumption of $${(creditToConsume / 100).toFixed(2)} for ${metadata?.email || 'unknown'}`);
  }

  if (metadata?.draftInvoiceId) {
    const draftInvoiceId = metadata.draftInvoiceId;
    deferredActions.push(async () => {
      try {
        const result = await finalizeInvoicePaidOutOfBand(draftInvoiceId);
        if (result.success) {
          logger.info(`[Stripe Webhook] Draft invoice ${draftInvoiceId} finalized and marked paid out-of-band for terminal PI ${id}`);
        } else {
          logger.error(`[Stripe Webhook] Failed to finalize draft invoice ${draftInvoiceId}: ${result.error}`);
        }
      } catch (invoiceErr: unknown) {
        logger.error(`[Stripe Webhook] Error finalizing draft invoice ${draftInvoiceId}:`, { error: invoiceErr });
      }
    });
  }

  // Audit log for successful payment
  const paymentMemberEmail = metadata?.email || customerEmail || 'unknown';
  const paymentDescription = description || metadata?.productName || 'Stripe payment';
  deferredActions.push(async () => {
    await logSystemAction({
      action: 'payment_succeeded',
      resourceType: 'payment',
      resourceId: id,
      resourceName: `Payment from ${paymentMemberEmail}`,
      details: {
        source: 'stripe_webhook',
        amount_cents: amount,
        member_email: paymentMemberEmail,
        description: paymentDescription
      }
    });
  });

  if (metadata?.email && metadata?.purpose) {
    const email = metadata.email;
    const desc = paymentIntent.description || `Stripe payment: ${metadata.purpose}`;
    const localBookingId = bookingId;
    const localAmount = amount;
    const localId = id;
    
    const userResult = await client.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
    const memberName = userResult.rows[0] 
      ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
      : email;

    await queueJobInTransaction(client, 'sync_to_hubspot', {
      email,
      amountCents: localAmount,
      purpose: metadata.purpose,
      description: desc,
      paymentIntentId: localId
    }, { webhookEventId: localId, priority: 1 });

    await queueJobInTransaction(client, 'send_payment_receipt', {
      to: email,
      memberName,
      amount: localAmount / 100,
      description: desc,
      date: new Date().toISOString(),
      paymentMethod: 'card'
    }, { webhookEventId: localId, priority: 2 });

    await queueJobInTransaction(client, 'notify_payment_success', {
      userEmail: email,
      amount: localAmount / 100,
      description: desc
    }, { webhookEventId: localId, priority: 1 });

    await queueJobInTransaction(client, 'notify_all_staff', {
      title: 'Payment Received',
      message: `${memberName} (${email}) made a payment of $${(localAmount / 100).toFixed(2)} for: ${desc}`,
      type: 'payment_success'
    }, { webhookEventId: localId, priority: 0 });

    await queueJobInTransaction(client, 'broadcast_billing_update', {
      action: 'payment_succeeded',
      memberEmail: email,
      memberName,
      amount: localAmount / 100
    }, { webhookEventId: localId, priority: 0 });

    logger.info(`[Stripe Webhook] Queued ${5} jobs for payment ${localId} to ${email}`);
  }

  return deferredActions;
}

async function handlePaymentIntentStatusUpdate(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, status, amount, currency, customer, metadata, created } = paymentIntent;
  const deferredActions: DeferredAction[] = [];

  logger.info(`[Stripe Webhook] Payment intent status update: ${id} → ${status}`);

  await client.query(
    `UPDATE stripe_payment_intents SET status = $2, updated_at = NOW() WHERE stripe_payment_intent_id = $1`,
    [id, status]
  );

  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const customerEmail = typeof customer === 'object' ? (customer as Stripe.Customer)?.email : metadata?.email;
  const customerName = typeof customer === 'object' ? (customer as Stripe.Customer)?.name : metadata?.memberName;

  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'payment_intent',
      amountCents: amount,
      currency: currency || 'usd',
      status,
      createdAt: new Date(created * 1000),
      customerId,
      customerEmail,
      customerName,
      description: metadata?.description || `Payment ${status}`,
      metadata,
      source: 'webhook',
      paymentIntentId: id,
    });
  });

  return deferredActions;
}

const MAX_RETRY_ATTEMPTS = 3;

async function handlePaymentIntentFailed(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, metadata, amount, last_payment_error, customer } = paymentIntent;
  const reason = last_payment_error?.message || 'Payment could not be processed';
  const errorCode = last_payment_error?.code || 'unknown';
  const declineCode = last_payment_error?.decline_code;
  
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Payment failed: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${reason}, code: ${errorCode}${declineCode ? `, decline_code: ${declineCode}` : ''}`);
  
  logPaymentFailure({
    paymentIntentId: id,
    customerId: typeof customer === 'string' ? customer : customer?.id,
    userEmail: metadata?.email,
    amountCents: amount,
    errorMessage: reason,
    errorCode
  });

  const existingResult = await client.query(
    `SELECT retry_count FROM stripe_payment_intents WHERE stripe_payment_intent_id = $1`,
    [id]
  );
  const currentRetryCount = existingResult.rows[0]?.retry_count || 0;
  
  const newRetryCount = currentRetryCount + 1;
  const requiresCardUpdate = newRetryCount >= MAX_RETRY_ATTEMPTS;

  await client.query(
    `UPDATE stripe_payment_intents 
     SET status = 'failed', 
         updated_at = NOW(),
         retry_count = $2,
         last_retry_at = NOW(),
         failure_reason = $3,
         dunning_notified_at = NOW(),
         requires_card_update = $4
     WHERE stripe_payment_intent_id = $1`,
    [id, newRetryCount, reason, requiresCardUpdate]
  );

  await client.query(
    `UPDATE booking_fee_snapshots SET status = 'failed' WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
    [id]
  );
  
  logger.info(`[Stripe Webhook] Updated payment ${id}: retry ${newRetryCount}/${MAX_RETRY_ATTEMPTS}, requires_card_update=${requiresCardUpdate}`);

  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const customerEmail = typeof customer === 'object' ? (customer as Stripe.Customer)?.email : metadata?.email;
  const customerName = typeof customer === 'object' ? (customer as Stripe.Customer)?.name : metadata?.memberName;
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'payment_intent',
      amountCents: amount,
      currency: paymentIntent.currency || 'usd',
      status: 'failed',
      createdAt: new Date(paymentIntent.created * 1000),
      customerId,
      customerEmail,
      customerName,
      description: metadata?.description || `Failed payment - ${reason}`,
      metadata,
      source: 'webhook',
      paymentIntentId: id,
    });
  });

  const failedPaymentEmail = metadata?.email || customerEmail || 'unknown';
  deferredActions.push(async () => {
    await logSystemAction({
      action: 'payment_failed',
      resourceType: 'payment',
      resourceId: id,
      resourceName: `Failed payment from ${failedPaymentEmail}`,
      details: {
        source: 'stripe_webhook',
        amount_cents: amount,
        member_email: failedPaymentEmail,
        failure_reason: reason,
        error_code: errorCode,
        decline_code: declineCode || null,
        retry_count: newRetryCount,
        requires_card_update: requiresCardUpdate
      }
    });
  });

  deferredActions.push(async () => {
    try {
      await sendErrorAlert({
        type: 'payment_failure',
        title: requiresCardUpdate
          ? `Payment failed ${newRetryCount}x — card update needed`
          : `Payment failed (attempt ${newRetryCount})`,
        message: `PaymentIntent ${id} for ${failedPaymentEmail}: $${(amount / 100).toFixed(2)} — ${reason}${declineCode ? ` (decline: ${declineCode})` : ''}`,
        userEmail: failedPaymentEmail !== 'unknown' ? failedPaymentEmail : undefined,
        details: {
          paymentIntentId: id,
          amount_cents: amount,
          error_code: errorCode,
          decline_code: declineCode || null,
          retry_count: newRetryCount,
          requires_card_update: requiresCardUpdate
        }
      });
    } catch (alertErr: unknown) {
      logger.error('[Stripe Webhook] Error alert send failed (non-blocking):', { error: alertErr });
    }
  });

  const email = metadata?.email;
  if (!email) {
    logger.warn('[Stripe Webhook] No email in metadata for failed payment - cannot send notifications');
    return deferredActions;
  }

  const bookingId = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;
  const localAmount = amount;
  const localReason = reason;
  const localRequiresCardUpdate = requiresCardUpdate;
  const localRetryCount = newRetryCount;
  const localErrorCode = errorCode;
  const localDeclineCode = declineCode;

  deferredActions.push(async () => {
    try {
      const userResult = await db.execute(sql`SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1`);
      const memberName = userResult.rows[0] 
        ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
        : email;

      const memberMessage = localRequiresCardUpdate
        ? `Your payment of $${(localAmount / 100).toFixed(2)} failed after ${MAX_RETRY_ATTEMPTS} attempts. Please update your payment method.`
        : `Your payment of $${(localAmount / 100).toFixed(2)} could not be processed. Reason: ${localReason}`;

      await notifyPaymentFailed(email, localAmount / 100, memberMessage, { 
        sendEmail: false, 
        bookingId: !isNaN(bookingId) ? bookingId : undefined 
      });

      await sendPaymentFailedEmail(email, { 
        memberName, 
        amount: localAmount / 100, 
        reason: localRequiresCardUpdate 
          ? `Payment failed after ${MAX_RETRY_ATTEMPTS} attempts. Please update your card.`
          : localReason
      });

      logger.info(`[Stripe Webhook] Payment failed notifications sent to ${email} (retry=${localRetryCount}, requires_card_update=${localRequiresCardUpdate})`);

      const staffMessage = localRequiresCardUpdate
        ? `${memberName} (${email}) payment failed ${localRetryCount}x — card update required. Code: ${localErrorCode}${localDeclineCode ? ` / ${localDeclineCode}` : ''}`
        : `Payment of $${(localAmount / 100).toFixed(2)} failed for ${memberName} (${email}). Attempt ${localRetryCount}/${MAX_RETRY_ATTEMPTS}. Reason: ${localReason}`;
      
      await notifyStaffPaymentFailed(email, memberName, localAmount / 100, staffMessage);

      broadcastBillingUpdate({
        action: 'payment_failed',
        memberEmail: email,
        memberName,
        amount: localAmount / 100,
      });

      logger.info(`[Stripe Webhook] Staff notified about payment failure for ${email}`);
    } catch (error: unknown) {
      logger.error('[Stripe Webhook] Error sending payment failed notifications:', { error: error });
    }
  });

  return deferredActions;
}

async function handlePaymentIntentCanceled(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, metadata, amount, cancellation_reason } = paymentIntent;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Payment canceled: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${cancellation_reason || 'not specified'}`);
  
  if (metadata?.paymentType === 'subscription_terminal') {
    const email = metadata?.email;
    const subscriptionId = metadata?.subscriptionId;
    
    await client.query(
      `INSERT INTO terminal_payments (
        user_id, user_email, stripe_payment_intent_id, stripe_subscription_id,
        amount_cents, currency, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET 
        status = 'canceled', updated_at = NOW()`,
      [
        metadata?.userId || null,
        email || 'unknown',
        id,
        subscriptionId || null,
        amount,
        paymentIntent.currency || 'usd',
        'canceled'
      ]
    );
    
    logger.info(`[Stripe Webhook] Terminal payment canceled/abandoned: ${id} for ${email || 'unknown'}`);
    
    deferredActions.push(async () => {
      await notifyAllStaff(
        'Terminal Payment Canceled',
        `A card reader payment was canceled or timed out. Email: ${email || 'unknown'}, Amount: $${(amount / 100).toFixed(2)}, Subscription: ${subscriptionId || 'N/A'}`,
        'terminal_payment_canceled',
        { sendPush: true }
      );
      
      await logSystemAction({
        action: 'terminal_payment_canceled',
        resourceType: 'payment',
        resourceId: id,
        resourceName: email || 'Unknown',
        details: {
          source: 'stripe_webhook',
          cancellation_reason: cancellation_reason,
          stripe_payment_intent_id: id,
          stripe_subscription_id: subscriptionId,
          amount_cents: amount
        }
      });
    });
  }
  
  return deferredActions;
}

async function handleInvoicePaymentSucceeded(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
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

  await client.query(
    `UPDATE hubspot_deals 
     SET last_payment_status = 'current',
         last_payment_check = NOW(),
         last_sync_error = NULL,
         updated_at = NOW()
     WHERE LOWER(member_email) = LOWER($1)`,
    [email]
  );

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

  if (currentPeriodEnd) {
    await client.query(
      `UPDATE users SET stripe_current_period_end = $1, updated_at = NOW()
       WHERE LOWER(email) = LOWER($2)`,
      [nextBillingDate, email]
    );
  }

  const localEmail = email;
  const localMemberName = memberName;
  const localAmountPaid = amountPaid;
  const localPlanName = planName;
  const localNextBillingDate = nextBillingDate;
  const localUserId = userId;
  const localPaymentIntent = (typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id) || invoice.id;

  deferredActions.push(async () => {
    try {
      await queuePaymentSyncToHubSpot({
        paymentIntentId: localPaymentIntent,
        email: localEmail,
        amountCents: localAmountPaid,
        description: `Membership Renewal: ${localPlanName}`,
        purpose: 'membership_renewal',
      });
      logger.info(`[Stripe Webhook] Queued invoice payment HubSpot sync for ${localEmail}`);
    } catch (hubspotError: unknown) {
      logger.error('[Stripe Webhook] Failed to queue HubSpot sync for invoice payment:', { error: hubspotError });
    }
  });

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

async function handleInvoicePaymentFailed(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
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
  
  // Guard: Only apply past_due penalty if invoice's subscription matches user's current subscription
  // This prevents late-arriving failed invoices from old/cancelled subscriptions from downgrading
  // active members who have since started a new subscription
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
      const { syncMemberToHubSpot } = await import('../hubspot/stages');
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

async function handleInvoiceLifecycle(client: PoolClient, invoice: InvoiceWithLegacyFields, eventType: string): Promise<DeferredAction[]> {
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

async function handleInvoiceVoided(client: PoolClient, invoice: InvoiceWithLegacyFields, eventType: string): Promise<DeferredAction[]> {
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
  const localInvoiceId = invoice.id;
  const localStatus = status;
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({
      action: 'invoice_failed',
      memberEmail: localInvoiceEmail,
    });
  });

  return deferredActions;
}

async function handleCheckoutSessionCompleted(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    // Handle add_funds checkout - credit customer balance
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

      // NOTE: Must stay in transaction - user balance is financial state
      const stripe = await getStripeClient();
      const transaction = await Promise.race([
        stripe.customers.createBalanceTransaction(
          customerId,
          { amount: -amountCents, currency: 'usd', description: `Account balance top-up via checkout (${session.id})` },
          { idempotencyKey: `add_funds_${session.id}` }
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Balance transaction timed out after 5s')), 5000))
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
          logger.error(`[Stripe Webhook] Deferred notification failed for add_funds ${deferredMemberEmail}:`, { extra: { detail: getErrorMessage(notifyError) } });
        }
      });

      return deferredActions;
    }
    
    // Handle corporate membership company sync if company_name is present
    const companyName = session.metadata?.company_name;
    const userEmail = session.metadata?.purchaser_email || session.customer_email;
    
    if (companyName && userEmail) {
      logger.info(`[Stripe Webhook] Processing company sync for "${companyName}" (${userEmail})`);
      
      // NOTE: Must stay in transaction - result (hubspotCompanyId) needed for DB writes to users and billing_groups
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
        logger.error('[Stripe Webhook] Error syncing company to HubSpot (will queue retry):', { error: companyError });
        deferredActions.push(async () => {
          try {
            const { enqueueHubSpotSync } = await import('../hubspot/queue');
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
            logger.error('[Stripe Webhook] Failed to queue HubSpot company sync retry:', { error: queueErr });
          }
        });
      }
    }

    // Handle activation link checkout - activate pending user after payment completion
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
              stripe_customer_id = COALESCE(stripe_customer_id, $1),
              stripe_subscription_id = $2,
              billing_provider = 'stripe',
              tier = COALESCE($3, tier),
              join_date = COALESCE(join_date, NOW()),
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
                stripe_customer_id = COALESCE(stripe_customer_id, $1),
                stripe_subscription_id = $2,
                billing_provider = 'stripe',
                tier = COALESCE($3, tier),
                join_date = COALESCE(join_date, NOW()),
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
              try {
                const stripe = await getStripeClient();
                const coupon = await stripe.coupons.retrieve(couponApplied);
                const couponName = coupon.name || couponApplied;
                await client.query(
                  `UPDATE users SET discount_code = $1, updated_at = NOW() WHERE id = $2`,
                  [couponName, updateResult.rows[0].id]
                );
                logger.info(`[Stripe Webhook] Set discount_code="${couponName}" for activated user ${updatedEmail}`);
              } catch (couponErr: unknown) {
                logger.warn('[Stripe Webhook] Failed to set discount_code from coupon:', { extra: { couponApplied, error: getErrorMessage(couponErr) } });
              }
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

            deferredActions.push(async () => {
              try {
                const { findOrCreateHubSpotContact } = await import('../hubspot/members');
                await findOrCreateHubSpotContact(
                  deferredUpdatedEmail,
                  deferredFirstName,
                  deferredLastName,
                  deferredPhone
                );
              } catch (contactErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot contact sync failed for activation link:', { error: contactErr });
              }
            });

            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../hubspot/stages');
                await syncMemberToHubSpot({
                  email: deferredUpdatedEmail,
                  status: 'active',
                  billingProvider: 'stripe',
                  tier: deferredTierNameMeta,
                  memberSince: new Date(),
                  billingGroupRole: 'Primary',
                });
              } catch (hubspotError: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for activation link checkout:', { error: hubspotError });
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

    // Handle staff-initiated membership invites - auto-create user on checkout completion
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
      
      // Check if user exists via linked email resolution
      const { resolveUserByEmail } = await import('../stripe/customers');
      const resolved = await resolveUserByEmail(email);
      if (resolved) {
        // User exists via linked email (or direct match) - update their Stripe customer ID
        logger.info(`[Stripe Webhook] User found via ${resolved.matchType} for ${email} -> ${resolved.primaryEmail}, updating Stripe customer ID`);
        const preUpdateCheck = await client.query('SELECT archived_at FROM users WHERE id = $1', [resolved.userId]);
        await client.query(
          `UPDATE users SET stripe_customer_id = $1, membership_status = 'active', billing_provider = 'stripe', archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = $2`,
          [customerId, resolved.userId]
        );
        if (preUpdateCheck.rows[0]?.archived_at) {
          logger.info(`[Auto-Unarchive] User ${resolved.primaryEmail} unarchived after receiving Stripe customer ID`);
        }
        
        const deferredResolvedEmail = resolved.primaryEmail;
        deferredActions.push(async () => {
          try {
            const { syncMemberToHubSpot } = await import('../hubspot/stages');
            await syncMemberToHubSpot({ email: deferredResolvedEmail, status: 'active', billingProvider: 'stripe', memberSince: new Date(), billingGroupRole: 'Primary' });
            logger.info(`[Stripe Webhook] Synced existing user ${deferredResolvedEmail} to HubSpot`);
          } catch (hubspotError: unknown) {
            logger.error('[Stripe Webhook] HubSpot sync failed for existing user:', { error: hubspotError });
          }
        });
      } else {
        // Check if user already exists by exact email match
        const existingUser = await client.query(
          'SELECT id, status FROM users WHERE LOWER(email) = LOWER($1)',
          [email]
        );
        
        if (existingUser.rows.length > 0) {
          // User exists - update their Stripe customer ID, status, and billing provider
          logger.info(`[Stripe Webhook] User ${email} exists, updating Stripe customer ID and billing provider`);
          const preUpdateCheckDirect = await client.query('SELECT archived_at FROM users WHERE LOWER(email) = LOWER($1)', [email]);
          await client.query(
            `UPDATE users SET stripe_customer_id = $1, membership_status = 'active', billing_provider = 'stripe', archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE LOWER(email) = LOWER($2)`,
            [customerId, email]
          );
          if (preUpdateCheckDirect.rows[0]?.archived_at) {
            logger.info(`[Auto-Unarchive] User ${email} unarchived after receiving Stripe customer ID`);
          }
          
          const deferredDirectEmail = email;
          deferredActions.push(async () => {
            try {
              const { syncMemberToHubSpot } = await import('../hubspot/stages');
              await syncMemberToHubSpot({ email: deferredDirectEmail, status: 'active', billingProvider: 'stripe', memberSince: new Date(), billingGroupRole: 'Primary' });
              logger.info(`[Stripe Webhook] Synced existing user ${deferredDirectEmail} to HubSpot`);
            } catch (hubspotError: unknown) {
              logger.error('[Stripe Webhook] HubSpot sync failed for existing user:', { error: hubspotError });
            }
          });
        } else {
        // Create new user
        logger.info(`[Stripe Webhook] Creating new user from staff invite: ${email}`);
        
        const exclusionCheck = await client.query('SELECT 1 FROM sync_exclusions WHERE email = $1', [email.toLowerCase()]);
        if (exclusionCheck.rows.length > 0) {
          logger.info(`[Stripe Webhook] Skipping user creation for ${email} — permanently deleted (sync_exclusions)`);
        } else {
        // Get tier slug from tier ID
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
        
        await client.query(
          `INSERT INTO users (email, first_name, last_name, tier, membership_status, stripe_customer_id, billing_provider, join_date, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', $5, 'stripe', NOW(), NOW(), NOW())
           ON CONFLICT (email) DO UPDATE SET 
             stripe_customer_id = EXCLUDED.stripe_customer_id,
             billing_provider = 'stripe',
             membership_status = 'active',
             role = 'member',
             join_date = COALESCE(users.join_date, NOW()),
             tier = COALESCE(EXCLUDED.tier, users.tier),
             updated_at = NOW()`,
          [email, firstName || '', lastName || '', tierSlug, customerId]
        );
        
        logger.info(`[Stripe Webhook] Created user ${email} with tier ${tierSlug || 'none'}`);
        }
        }
      }
      
      const deferredStaffEmail = email;
      const deferredStaffFirstName = firstName || '';
      const deferredStaffLastName = lastName || '';
      const deferredStaffTierName = tierName || undefined;

      deferredActions.push(async () => {
        try {
          const { findOrCreateHubSpotContact } = await import('../hubspot/members');
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          
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
          });
          logger.info(`[Stripe Webhook] Synced ${deferredStaffEmail} to HubSpot: status=active, tier=${deferredStaffTierName}, billing=stripe, memberSince=now`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for staff invite:', { error: hubspotError });
        }
      });
      
      try {
        await client.query(
          `UPDATE form_submissions SET status = 'converted', updated_at = NOW() WHERE form_type = 'membership' AND LOWER(email) = LOWER($1) AND status = 'invited'`,
          [email]
        );
        logger.info(`[Stripe Webhook] Marked membership application as converted for ${email}`);
      } catch (convErr: unknown) {
        logger.error('[Stripe Webhook] Failed to mark application as converted:', { error: convErr });
      }
      
      logger.info(`[Stripe Webhook] Staff invite checkout completed for ${email}`);
      return deferredActions;
    }

    // Only handle day pass purchases
    if (session.metadata?.purpose !== 'day_pass') {
      logger.info(`[Stripe Webhook] Skipping checkout session ${session.id} (not a day_pass or staff_invite)`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Processing day pass checkout session: ${session.id}`);

    // Extract metadata
    const productSlug = session.metadata?.product_slug;
    const email = session.metadata?.purchaser_email;
    const firstName = session.metadata?.purchaser_first_name;
    const lastName = session.metadata?.purchaser_last_name;
    const phone = session.metadata?.purchaser_phone;
    const amountCents = session.amount_total || 0;

    // Get payment_intent_id
    let paymentIntentId: string | null = null;
    if (session.payment_intent) {
      paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent.id;
    }

    if (!productSlug || !email || !paymentIntentId) {
      logger.error(`[Stripe Webhook] Missing required data for day pass: productSlug=${productSlug}, email=${email}, paymentIntentId=${paymentIntentId}`);
      return deferredActions;
    }

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;

    // Record the day pass purchase
    const result = await recordDayPassPurchaseFromWebhook({
      productSlug,
      email,
      firstName,
      lastName,
      phone,
      amountCents,
      paymentIntentId,
      customerId
    });

    if (!result.success) {
      logger.error(`[Stripe Webhook] Failed to record day pass purchase:`, { error: result.error });
      throw new Error(`Failed to record day pass: ${result.error}`); // Throw so Stripe retries
    }

    logger.info(`[Stripe Webhook] Day pass purchase recorded: ${result.purchaseId}`);

    broadcastDayPassUpdate({
      action: 'day_pass_purchased',
      passId: result.purchaseId!,
      purchaserEmail: email,
      purchaserName: [firstName, lastName].filter(Boolean).join(' ') || email,
      productType: productSlug,
      remainingUses: result.remainingUses ?? 1,
      quantity: result.quantity ?? 1,
      purchasedAt: new Date().toISOString(),
    });

    const deferredDayPassEmail = email;
    const deferredProductSlug = productSlug;
    const deferredPurchaseId = result.purchaseId;
    const deferredFirstName = firstName;
    const deferredLastName = lastName;
    const deferredPhone = phone;
    const deferredDayPassAmountCents = amountCents;
    const deferredPaymentIntentId = paymentIntentId;
    const purchaserName = [firstName, lastName].filter(Boolean).join(' ') || email;
    const deferredPurchaserName = purchaserName;

    deferredActions.push(async () => {
      try {
        await sendPassWithQrEmail(deferredDayPassEmail, {
          passId: parseInt(deferredPurchaseId!, 10),
          type: deferredProductSlug,
          quantity: 1,
          purchaseDate: new Date()
        });
        logger.info(`[Stripe Webhook] QR pass email sent to ${deferredDayPassEmail}`);
      } catch (emailError: unknown) {
        logger.error('[Stripe Webhook] Failed to send QR pass email:', { error: emailError });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Day Pass Purchased',
          `${deferredPurchaserName} (${deferredDayPassEmail}) purchased a ${deferredProductSlug} day pass.`,
          'day_pass',
          { sendPush: false, sendWebSocket: true }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff of day pass:', { error: notifyErr });
      }
    });

    deferredActions.push(async () => {
      try {
        await queueDayPassSyncToHubSpot({
          email: deferredDayPassEmail,
          firstName: deferredFirstName,
          lastName: deferredLastName,
          phone: deferredPhone,
          productSlug: deferredProductSlug,
          amountCents: deferredDayPassAmountCents,
          paymentIntentId: deferredPaymentIntentId,
          purchaseId: deferredPurchaseId
        });
      } catch (hubspotError: unknown) {
        logger.error('[Stripe Webhook] Failed to queue HubSpot sync for day pass:', { error: hubspotError });
      }
    });

    deferredActions.push(async () => {
      try {
        await upsertTransactionCache({
          stripeId: deferredPaymentIntentId!,
          objectType: 'payment_intent',
          amountCents: deferredDayPassAmountCents,
          currency: 'usd',
          status: 'succeeded',
          createdAt: new Date(),
          customerId,
          customerEmail: deferredDayPassEmail,
          customerName: [deferredFirstName, deferredLastName].filter(Boolean).join(' ') || null,
          description: `Day Pass: ${deferredProductSlug}`,
          metadata: session.metadata || undefined,
          source: 'webhook',
          paymentIntentId: deferredPaymentIntentId,
        });
      } catch (cacheErr: unknown) {
        logger.error('[Stripe Webhook] Failed to cache day pass transaction:', { error: cacheErr });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling checkout session completed:', { error: error });
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionCreated(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const planName = subscription.items?.data?.[0]?.price?.nickname || 
                     subscription.items?.data?.[0]?.plan?.nickname || 
                     'Membership';
    const subscriptionPeriodEnd = (subscription as StripeSubscriptionWithPeriods).current_period_end 
      ? new Date((subscription as StripeSubscriptionWithPeriods).current_period_end * 1000) 
      : null;

    // First try to find user by stripe_customer_id
    let userResult = await client.query(
      'SELECT email, first_name, last_name, tier, membership_status, billing_provider FROM users WHERE stripe_customer_id = $1 LIMIT 1',
      [customerId]
    );
    
    // If not found by customer ID, try by email from subscription metadata
    const purchaserEmail = subscription.metadata?.purchaser_email?.toLowerCase();
    if (userResult.rows.length === 0 && purchaserEmail) {
      logger.info(`[Stripe Webhook] No user found by customer ID, trying by email from metadata: ${purchaserEmail}`);
      userResult = await client.query(
        'SELECT email, first_name, last_name, tier, membership_status, billing_provider FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [purchaserEmail]
      );
    }

    let email: string;
    let first_name: string | null;
    let last_name: string | null;
    let currentTier: string | null;
    let currentStatus: string | null;

    if (userResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] No user found for Stripe customer ${customerId}, creating user from Stripe data`);
      
      // NOTE: Must stay in transaction - result needed for DB writes (customerEmail, name used for user creation)
      const stripe = await getStripeClient();
      const customer = await Promise.race([
        stripe.customers.retrieve(String(customerId)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stripe customer retrieve timed out after 5s')), 5000))
      ]) as Stripe.Customer | Stripe.DeletedCustomer;
      
      if (!customer || (customer as Stripe.DeletedCustomer).deleted) {
        logger.error(`[Stripe Webhook] Customer ${customerId} not found or deleted`);
        return deferredActions;
      }
      
      const customerEmail = (customer as Stripe.Customer).email?.toLowerCase();
      if (!customerEmail) {
        logger.error(`[Stripe Webhook] No email found for Stripe customer ${customerId}`);
        return deferredActions;
      }
      
      // Read name from subscription metadata first (set during checkout), fallback to customer name
      const metadataFirstName = subscription.metadata?.first_name;
      const metadataLastName = subscription.metadata?.last_name;
      const metadataPhone = subscription.metadata?.phone;
      
      let firstName: string;
      let lastName: string;
      
      if (metadataFirstName || metadataLastName) {
        firstName = metadataFirstName || '';
        lastName = metadataLastName || '';
        logger.info(`[Stripe Webhook] Using name from subscription metadata: ${firstName} ${lastName}`);
      } else {
        // Fallback to customer name
        const customerName = (customer as Stripe.Customer).name || '';
        const nameParts = customerName.split(' ');
        firstName = nameParts[0] || '';
        lastName = nameParts.slice(1).join(' ') || '';
        logger.info(`[Stripe Webhook] Using name from customer object: ${firstName} ${lastName}`);
      }
      
      let tierSlug: string | null = null;
      let tierName: string | null = null;
      
      // First check subscription metadata for tier info (supports both snake_case and camelCase keys)
      const metadataTierSlug = subscription.metadata?.tier_slug || subscription.metadata?.tierSlug;
      const metadataTierName = subscription.metadata?.tier_name || subscription.metadata?.tier;
      
      if (metadataTierSlug) {
        // Look up tier by slug from metadata
        const tierResult = await client.query(
          'SELECT slug, name FROM membership_tiers WHERE slug = $1',
          [metadataTierSlug]
        );
        if (tierResult.rows.length > 0) {
          tierSlug = tierResult.rows[0].slug;
          tierName = tierResult.rows[0].name;
          logger.info(`[Stripe Webhook] Found tier from subscription metadata: ${tierSlug} (${tierName})`);
        } else if (metadataTierName) {
          // Use the tier name from metadata if slug lookup fails
          tierSlug = metadataTierSlug;
          tierName = normalizeTierName(metadataTierName);
          logger.info(`[Stripe Webhook] Using tier from metadata (no DB match): ${tierSlug} (${tierName})`);
        }
      }
      
      // Fallback to price ID lookup if no metadata
      if (!tierSlug && priceId) {
        const tierResult = await client.query(
          'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );
        if (tierResult.rows.length > 0) {
          tierSlug = tierResult.rows[0].slug;
          tierName = tierResult.rows[0].name;
          logger.info(`[Stripe Webhook] Found tier from price ID: ${tierSlug} (${tierName})`);
        }
      }
      
      const statusMap: Record<string, string> = {
        'active': 'active',
        'trialing': 'trialing',
        'past_due': 'past_due',
        'incomplete': 'pending',
        'incomplete_expired': 'pending',
        'canceled': 'cancelled',
        'unpaid': 'past_due',
        'paused': 'frozen'
      };
      const actualStatus = statusMap[subscription.status] || 'pending';
      if (subscription.status === 'incomplete' || subscription.status === 'incomplete_expired') {
        logger.info(`[Stripe Webhook] Subscription ${subscription.id} has status '${subscription.status}' - member will stay pending until payment completes`);
      }
      
      // Check if this email resolves to an existing user via linked email
      const { resolveUserByEmail: resolveSubEmail } = await import('../stripe/customers');
      const resolvedSub = await resolveSubEmail(customerEmail);
      if (resolvedSub && resolvedSub.matchType !== 'direct') {
        // This email is a linked email for an existing user — update the existing user instead
        logger.info(`[Stripe Webhook] Email ${customerEmail} resolved to existing user ${resolvedSub.primaryEmail} via ${resolvedSub.matchType}`);
        await client.query(
          `UPDATE users SET 
            stripe_customer_id = $1, stripe_subscription_id = $2, membership_status = $3,
            billing_provider = 'stripe', stripe_current_period_end = COALESCE($4, stripe_current_period_end),
            tier = COALESCE($5, tier), join_date = COALESCE(join_date, NOW()), updated_at = NOW()
           WHERE id = $6`,
          [customerId, subscription.id, actualStatus, subscriptionPeriodEnd, tierName, resolvedSub.userId]
        );
        logger.info(`[Stripe Webhook] Updated existing user ${resolvedSub.primaryEmail} via linked email with tier ${tierName || 'none'}, subscription ${subscription.id}`);
      } else {
        const exclusionCheck = await client.query('SELECT 1 FROM sync_exclusions WHERE email = $1', [customerEmail.toLowerCase()]);
        if (exclusionCheck.rows.length > 0) {
          logger.info(`[Stripe Webhook] Skipping user creation for ${customerEmail} — permanently deleted (sync_exclusions)`);
        } else {
          const existingUser = await client.query(
            'SELECT id, stripe_customer_id, billing_provider, membership_status FROM users WHERE LOWER(email) = LOWER($1)',
            [customerEmail]
          );
          
          if (existingUser.rows.length > 0 && existingUser.rows[0].stripe_customer_id && existingUser.rows[0].stripe_customer_id !== String(customerId)) {
            logger.warn(`[Stripe Webhook] subscription.created: user ${customerEmail} already has stripe_customer_id=${existingUser.rows[0].stripe_customer_id}, incoming=${customerId}. Skipping overwrite — flagging for review.`);
            deferredActions.push(async () => {
              try {
                await notifyAllStaff(
                  'Stripe Customer Conflict',
                  `Subscription ${subscription.id} created for ${customerEmail}, but this user already has a different Stripe customer ID (${existingUser.rows[0].stripe_customer_id} vs ${customerId}). Please verify manually.`,
                  'billing_alert',
                  { sendPush: true }
                );
              } catch (err: unknown) {
                logger.error('[Stripe Webhook] Failed to send customer conflict alert:', { error: err });
              }
            });
          } else {
            await client.query(
              `INSERT INTO users (email, first_name, last_name, phone, tier, membership_status, stripe_customer_id, stripe_subscription_id, billing_provider, stripe_current_period_end, join_date, created_at, updated_at)
               VALUES ($1, $2, $3, $8, $4, $7, $5, $6, 'stripe', $9, NOW(), NOW(), NOW())
               ON CONFLICT (email) DO UPDATE SET 
                 stripe_customer_id = EXCLUDED.stripe_customer_id,
                 stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                 membership_status = CASE WHEN users.billing_provider IS NULL OR users.billing_provider = '' OR users.billing_provider = 'stripe' THEN $7 ELSE users.membership_status END,
                 billing_provider = CASE WHEN users.billing_provider IS NULL OR users.billing_provider = '' OR users.billing_provider = 'stripe' THEN 'stripe' ELSE users.billing_provider END,
                 stripe_current_period_end = COALESCE($9, users.stripe_current_period_end),
                 tier = COALESCE(EXCLUDED.tier, users.tier),
                 role = 'member',
                 join_date = COALESCE(users.join_date, NOW()),
                 first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), users.first_name),
                 last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), users.last_name),
                 phone = COALESCE(NULLIF(EXCLUDED.phone, ''), users.phone),
                 updated_at = NOW()`,
              [customerEmail, firstName, lastName, tierName, customerId, subscription.id, actualStatus, metadataPhone || '', subscriptionPeriodEnd]
            );
            
            logger.info(`[Stripe Webhook] Created user ${customerEmail} with tier ${tierName || 'none'}, phone ${metadataPhone || 'none'}, subscription ${subscription.id}`);
          }
        }
      }
      
      const deferredCustomerEmail = customerEmail;
      const deferredFirstName = firstName;
      const deferredLastName = lastName;
      const deferredMetadataPhone = metadataPhone || undefined;
      const deferredTierName = tierName;
      const deferredActualStatus = actualStatus;
      const deferredCustomerId = String(customerId);
      const deferredPricingInterval = subscription.items?.data?.[0]?.price?.recurring?.interval || undefined;

      deferredActions.push(async () => {
        try {
          const { findOrCreateHubSpotContact } = await import('../hubspot/members');
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          const contactResult = await findOrCreateHubSpotContact(
            deferredCustomerEmail,
            deferredFirstName,
            deferredLastName,
            deferredMetadataPhone,
            deferredTierName || undefined
          );
          
          if (contactResult?.contactId) {
            await syncMemberToHubSpot({
              email: deferredCustomerEmail,
              status: deferredActualStatus,
              billingProvider: 'stripe',
              tier: deferredTierName || undefined,
              memberSince: new Date(),
              stripeCustomerId: deferredCustomerId,
              stripePricingInterval: deferredPricingInterval,
              billingGroupRole: 'Primary',
            });
            logger.info(`[Stripe Webhook] Synced ${deferredCustomerEmail} to HubSpot contact: status=${deferredActualStatus}, tier=${deferredTierName}, billing=stripe`);
            
            if (deferredTierName) {
              const hubspotResult = await handleTierChange(
                deferredCustomerEmail,
                'None',
                deferredTierName,
                'stripe-webhook',
                'Stripe Subscription'
              );
              
              if (!hubspotResult.success && hubspotResult.error) {
                logger.warn(`[Stripe Webhook] HubSpot deal sync failed for new member ${deferredCustomerEmail}, queuing for retry`);
                await queueTierSync({
                  email: deferredCustomerEmail,
                  newTier: deferredTierName,
                  oldTier: 'None',
                  changedBy: 'stripe-webhook',
                  changedByName: 'Stripe Subscription'
                });
              } else {
                logger.info(`[Stripe Webhook] Created HubSpot deal line item for ${deferredCustomerEmail} tier=${deferredTierName}`);
              }
            }
          }
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for subscription user creation:', { extra: { detail: getErrorMessage(hubspotError) } });
          if (deferredTierName) {
            try {
              await queueTierSync({
                email: deferredCustomerEmail,
                newTier: deferredTierName,
                oldTier: 'None',
                changedBy: 'stripe-webhook',
                changedByName: 'Stripe Subscription'
              });
            } catch (queueErr: unknown) {
              logger.error('[Stripe Webhook] Failed to queue tier sync retry:', { error: queueErr });
            }
          }
        }
      });
      
      email = customerEmail;
      first_name = firstName;
      last_name = lastName;
      currentTier = tierSlug;
      currentStatus = 'active';
    } else {
      email = userResult.rows[0].email;
      first_name = userResult.rows[0].first_name;
      last_name = userResult.rows[0].last_name;
      currentTier = userResult.rows[0].tier;
      currentStatus = userResult.rows[0].membership_status;

      const existingBillingProvider = userResult.rows[0].billing_provider;
      if (existingBillingProvider && existingBillingProvider !== 'stripe') {
        logger.info(`[Stripe Webhook] Skipping subscription created for ${email} — billing_provider is '${existingBillingProvider}', not 'stripe'`);
        return deferredActions;
      }

      const statusMap: Record<string, string> = {
        'active': 'active',
        'trialing': 'trialing',
        'past_due': 'past_due',
        'incomplete': 'pending',
        'incomplete_expired': 'pending',
        'canceled': 'cancelled',
        'unpaid': 'past_due',
        'paused': 'frozen'
      };
      const mappedStatus = statusMap[subscription.status] || 'pending';
      const shouldActivate = ['pending', 'inactive', 'non-member', null].includes(currentStatus) && 
                              (subscription.status === 'active' || subscription.status === 'trialing');

      await client.query(
        `UPDATE users SET 
          stripe_subscription_id = $1,
          stripe_customer_id = COALESCE(stripe_customer_id, $5),
          stripe_current_period_end = COALESCE($2, stripe_current_period_end),
          billing_provider = 'stripe',
          membership_status = CASE 
            WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member') THEN $3
            ELSE membership_status 
          END,
          join_date = CASE WHEN join_date IS NULL AND $3 = 'active' THEN NOW() ELSE join_date END,
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($4)`,
        [subscription.id, subscriptionPeriodEnd, mappedStatus, email, customerId]
      );
      logger.info(`[Stripe Webhook] Updated existing user ${email}: subscription=${subscription.id}, customerId=${customerId}, status=${mappedStatus} (stripe: ${subscription.status}), shouldActivate=${shouldActivate}`);
    }

    try {
      const subDiscounts = subscription.discounts?.filter((d): d is Stripe.Discount => typeof d !== 'string');
      let subCoupon = subDiscounts?.[0]?.coupon;
      if (!subCoupon) {
        for (const item of (subscription.items?.data || [])) {
          const itemDiscounts = (item as any).discounts?.filter((d: any): d is Stripe.Discount => typeof d === 'object' && d !== null && 'coupon' in d);
          if (itemDiscounts?.[0]?.coupon) {
            subCoupon = itemDiscounts[0].coupon;
            break;
          }
        }
      }
      if (subCoupon) {
        const couponName = typeof subCoupon === 'string' ? subCoupon : (subCoupon.name || subCoupon.id);
        await client.query(
          'UPDATE users SET discount_code = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)',
          [couponName, email]
        );
        logger.info(`[Stripe Webhook] Set discount_code="${couponName}" for new subscription user ${email}`);
      }
    } catch (discountErr: unknown) {
      logger.warn('[Stripe Webhook] Failed to set discount_code from subscription coupon', { extra: { error: getErrorMessage(discountErr) } });
    }

    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const deferredNotifyEmail = email;
    const deferredNotifyMemberName = memberName;
    const deferredPlanName = planName;

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: deferredNotifyEmail,
          title: 'Subscription Started',
          message: `Your ${deferredPlanName} subscription has been activated. Welcome!`,
          type: 'membership_renewed',
        });
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: notifyErr });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          '🎉 New Member Joined',
          `${deferredNotifyMemberName} (${deferredNotifyEmail}) has subscribed to ${deferredPlanName}.`,
          'new_member',
          { sendPush: true, url: '/admin/members' }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: notifyErr });
      }
    });

    broadcastBillingUpdate({
      action: 'subscription_created',
      memberEmail: email,
      memberName,
      planName
    });

    // Closed-loop activation: Look up tier from metadata first, then price ID
    let activationTierSlug: string | null = null;
    let activationTierName: string | null = null;
    
    // First check subscription metadata for tier info (supports both snake_case and camelCase keys)
    const metadataTierSlug = subscription.metadata?.tier_slug || subscription.metadata?.tierSlug;
    const metadataTierName = subscription.metadata?.tier_name || subscription.metadata?.tier;
    
    if (metadataTierSlug) {
      const tierResult = await client.query(
        'SELECT slug, name FROM membership_tiers WHERE slug = $1',
        [metadataTierSlug]
      );
      if (tierResult.rows.length > 0) {
        activationTierSlug = tierResult.rows[0].slug;
        activationTierName = tierResult.rows[0].name;
        logger.info(`[Stripe Webhook] Found activation tier from subscription metadata: ${activationTierSlug} (${activationTierName})`);
      } else if (metadataTierName) {
        activationTierSlug = metadataTierSlug;
        activationTierName = metadataTierName;
        logger.info(`[Stripe Webhook] Using activation tier from metadata (no DB match): ${activationTierSlug} (${activationTierName})`);
      }
    }
    
    // Fallback to price ID lookup
    if (!activationTierSlug && priceId) {
      const tierResult = await client.query(
        'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
        [priceId]
      );
      if (tierResult.rows.length > 0) {
        activationTierSlug = tierResult.rows[0].slug;
        activationTierName = tierResult.rows[0].name;
        logger.info(`[Stripe Webhook] Found activation tier from price ID: ${activationTierSlug} (${activationTierName})`);
      }
    }
    
    if (activationTierSlug) {
      try {
        const tierSlug = activationTierSlug;
        const tierName = activationTierName;
          
        // Update user's tier, billing_provider, and conditionally activate if membership_status is pending/inactive/null/non-member
        const updateResult = await client.query(
          `UPDATE users SET 
            tier = $1, 
            billing_provider = 'stripe',
            stripe_customer_id = COALESCE(stripe_customer_id, $3),
            stripe_subscription_id = COALESCE(stripe_subscription_id, $4),
            stripe_current_period_end = COALESCE($5, stripe_current_period_end),
            membership_status = CASE 
              WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member') THEN $6
              ELSE membership_status 
            END, 
            updated_at = NOW() 
          WHERE LOWER(email) = LOWER($2) 
          RETURNING id`,
          [tierName || tierSlug, email, customerId, subscription.id, subscriptionPeriodEnd, (subscription.status === 'active' || subscription.status === 'trialing') ? 'active' : 'pending']
        );
          
          if (updateResult.rowCount && updateResult.rowCount > 0) {
            logger.info(`[Stripe Webhook] User activation: ${email} tier updated to ${tierSlug}, membership_status conditionally set to ${(subscription.status === 'active' || subscription.status === 'trialing') ? 'active' : 'pending'} (subscription status: ${subscription.status})`);
            
            const deferredActivationEmail = email;
            const deferredActivationTierName = tierName;
            const deferredActivationStatus = subscription.status;
            const deferredActivationCustomerId = String(customerId);
            const deferredActivationInterval = subscription.items?.data?.[0]?.price?.recurring?.interval || undefined;

            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../hubspot/stages');
                await syncMemberToHubSpot({
                  email: deferredActivationEmail,
                  status: deferredActivationStatus,
                  billingProvider: 'stripe',
                  tier: deferredActivationTierName,
                  memberSince: new Date(),
                  stripeCustomerId: deferredActivationCustomerId,
                  stripePricingInterval: deferredActivationInterval,
                  billingGroupRole: 'Primary',
                });
                logger.info(`[Stripe Webhook] Synced existing user ${deferredActivationEmail} to HubSpot: tier=${deferredActivationTierName}, status=${deferredActivationStatus}, billing=stripe, memberSince=now`);
              } catch (hubspotError: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for existing user subscription:', { error: hubspotError });
              }
            });
            
            // Auto-create corporate billing group for volume pricing purchases
            const quantity = subscription.items?.data?.[0]?.quantity || 1;
            const companyName = subscription.metadata?.company_name;
            const tierType = subscription.metadata?.tier_type;
            
            if (tierType === 'corporate' && quantity > 1 && companyName) {
              try {
                const { createCorporateBillingGroupFromSubscription } = await import('./groupBilling');
                const groupResult = await createCorporateBillingGroupFromSubscription({
                  primaryEmail: email,
                  companyName: companyName,
                  quantity: quantity,
                  stripeCustomerId: String(customerId),
                  stripeSubscriptionId: subscription.id,
                });
                if (groupResult.success) {
                  logger.info(`[Stripe Webhook] Auto-created corporate billing group for ${email}: ${companyName} with ${quantity} seats`);
                } else {
                  logger.warn(`[Stripe Webhook] Failed to auto-create corporate billing group: ${groupResult.error}`);
                }
              } catch (groupError: unknown) {
                logger.error('[Stripe Webhook] Error auto-creating corporate billing group:', { error: groupError });
              }
            }
          } else {
            logger.info(`[Stripe Webhook] User activation: ${email} - no update performed`);
          }

          // Update hubspot deal status
          try {
            const dealUpdateResult = await client.query(
              `UPDATE hubspot_deals SET last_payment_status = 'current', last_payment_check = NOW() WHERE LOWER(member_email) = LOWER($1) RETURNING id`,
              [email]
            );
            
            if (dealUpdateResult.rowCount && dealUpdateResult.rowCount > 0) {
              logger.info(`[Stripe Webhook] User activation: ${email} HubSpot deal updated to current payment status`);
            }
          } catch (hubspotError: unknown) {
            logger.error('[Stripe Webhook] Error updating HubSpot deal:', { error: hubspotError });
          }
      } catch (tierActivationError: unknown) {
        logger.error('[Stripe Webhook] Error during tier activation:', { error: tierActivationError });
      }
    } else {
      const productId = subscription.items?.data?.[0]?.price?.product;
      if (productId) {
        const deferredEmail = email;
        const deferredProductId = typeof productId === 'string' ? productId : productId.id;
        const deferredSubscriptionPeriodEnd = subscriptionPeriodEnd;
        const deferredSubscriptionStatus = subscription.status;
        deferredActions.push(async () => {
          try {
            const stripe = await getStripeClient();
            const product = await stripe.products.retrieve(deferredProductId);
            const productName = product.name?.toLowerCase() || '';

            const tierKeywords = ['vip', 'premium', 'corporate', 'core', 'social'];
            for (const keyword of tierKeywords) {
              if (productName.includes(keyword)) {
                const deferredClient = await pool.connect();
                try {
                  const keywordTierResult = await deferredClient.query(
                    'SELECT slug, name FROM membership_tiers WHERE LOWER(slug) = $1 OR LOWER(name) = $1',
                    [keyword]
                  );
                  if (keywordTierResult.rows.length > 0) {
                    const { name: tierName } = keywordTierResult.rows[0];

                    const updateResult = await deferredClient.query(
                      `UPDATE users SET 
                        tier = $1, 
                        membership_status = CASE 
                          WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member') THEN $4
                          ELSE membership_status 
                        END,
                        billing_provider = 'stripe',
                        stripe_current_period_end = COALESCE($3, stripe_current_period_end),
                        updated_at = NOW() 
                      WHERE email = $2 
                      RETURNING id`,
                      [tierName, deferredEmail, deferredSubscriptionPeriodEnd, (deferredSubscriptionStatus === 'active' || deferredSubscriptionStatus === 'trialing') ? 'active' : 'pending']
                    );

                    if (updateResult.rowCount && updateResult.rowCount > 0) {
                      logger.info(`[Stripe Webhook] User activation (product name match): ${deferredEmail} tier updated to ${tierName} from product "${product.name}"`);

                      try {
                        const { syncMemberToHubSpot } = await import('../hubspot/stages');
                        await syncMemberToHubSpot({
                          email: deferredEmail,
                          status: deferredSubscriptionStatus,
                          billingProvider: 'stripe',
                          tier: tierName,
                          memberSince: new Date(),
                          billingGroupRole: 'Primary',
                        });
                        logger.info(`[Stripe Webhook] Synced ${deferredEmail} to HubSpot: tier=${tierName}, status=${deferredSubscriptionStatus}, billing=stripe, memberSince=now`);
                      } catch (hubspotError: unknown) {
                        logger.error('[Stripe Webhook] HubSpot sync failed for product name match:', { error: hubspotError });
                      }
                    }
                    break;
                  }
                } finally {
                  deferredClient.release();
                }
              }
            }
          } catch (productError: unknown) {
            logger.error('[Stripe Webhook] Error fetching product for name match:', { error: productError });
          }
        });
      } else {
        logger.warn(`[Stripe Webhook] No tier found for price ID ${priceId}`);
      }
    }

    try {
      let restoreTierClause = '';
      let queryParams: (string | number | null)[] = [email];
      
      if (priceId) {
        const tierResult = await client.query(
          'SELECT slug FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );
        if (tierResult.rows.length > 0) {
          restoreTierClause = ', tier = COALESCE(tier, $2)';
          queryParams = [email, tierResult.rows[0].slug];
        }
      }
      
      await client.query(
        `UPDATE users SET 
          grace_period_start = NULL,
          grace_period_email_count = 0,
          billing_provider = 'stripe'${restoreTierClause},
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)`,
        queryParams
      );
      logger.info(`[Stripe Webhook] Cleared grace period and set billing_provider for ${email}`);
    } catch (gracePeriodError: unknown) {
      logger.error('[Stripe Webhook] Error clearing grace period:', { error: gracePeriodError });
    }

    if (subscription.status === 'trialing') {
      const userIdResult = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (userIdResult.rows.length > 0) {
        const userId = userIdResult.rows[0].id;
        const trialEndDate = subscription.trial_end 
          ? new Date(subscription.trial_end * 1000) 
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const couponCode = subscription.discounts?.[0] && typeof subscription.discounts[0] !== 'string' ? ((subscription.discounts[0] as unknown as { coupon?: { id: string } }).coupon?.id) : subscription.metadata?.coupon_code || undefined;

        deferredActions.push(async () => {
          try {
            await sendTrialWelcomeWithQrEmail(email, {
              firstName: first_name || undefined,
              userId,
              trialEndDate,
              couponCode
            });
            logger.info(`[Stripe Webhook] Trial welcome QR email sent to ${email}`);
          } catch (emailError: unknown) {
            logger.error(`[Stripe Webhook] Failed to send trial welcome email to ${email}:`, { error: emailError });
          }
        });
      }
    }

    logger.info(`[Stripe Webhook] New subscription created for ${memberName} (${email}): ${planName}`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription created:', { error: error });
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionUpdated(client: PoolClient, subscription: Stripe.Subscription, previousAttributes?: SubscriptionPreviousAttributes): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const status = subscription.status;
    const currentPriceId = subscription.items?.data?.[0]?.price?.id;
    if (subscription.items?.data?.length === 0) {
      logger.warn('[Stripe Webhook] subscription.updated has empty items array, tier update skipped', { extra: { subscriptionId: subscription.id, customerId: String(customerId) } });
    }
    const subscriptionPeriodEnd = (subscription as StripeSubscriptionWithPeriods).current_period_end 
      ? new Date((subscription as StripeSubscriptionWithPeriods).current_period_end * 1000) 
      : null;

    if (previousAttributes?.items?.data) {
      const { handleSubscriptionItemsChanged } = await import('./groupBilling');
      const currentItems = subscription.items?.data?.map((i: Stripe.SubscriptionItem) => ({
        id: i.id,
        metadata: i.metadata,
      })) || [];
      const previousItems = previousAttributes.items.data.map((i: { id: string; metadata?: Record<string, string> }) => ({
        id: i.id,
        metadata: i.metadata,
      }));
      
      try {
        await handleSubscriptionItemsChanged(
          subscription.id,
          currentItems,
          previousItems,
        );
      } catch (itemsErr: unknown) {
        logger.error('[Stripe Webhook] handleSubscriptionItemsChanged failed (non-fatal):', { error: getErrorMessage(itemsErr) });
      }
    }

    const userResult = await client.query(
      'SELECT id, email, first_name, last_name, tier, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return deferredActions;
    }

    const { id: userId, email, first_name, last_name, tier: currentTier } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription updated for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    if (currentPriceId) {
      let tierResult = await client.query(
        'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
        [currentPriceId]
      );
      
      let newTierName: string | null = null;
      let matchMethod = 'price_id';
      
      if (tierResult.rows.length > 0) {
        newTierName = tierResult.rows[0].name;
      } else {
        // Fallback: try to match by product name
        // NOTE: Must stay in transaction - result needed for DB writes (product name used for tier matching)
        const productId = subscription.items?.data?.[0]?.price?.product;
        if (productId) {
          try {
            const stripe = await getStripeClient();
            const product = await Promise.race([
              stripe.products.retrieve(typeof productId === 'string' ? productId : productId.id),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stripe product retrieve timed out after 5s')), 5000))
            ]) as Stripe.Product;
            const productName = product.name?.toLowerCase() || '';
            
            const tierKeywords = ['vip', 'premium', 'corporate', 'core', 'social'];
            for (const keyword of tierKeywords) {
              if (productName.includes(keyword)) {
                const keywordTierResult = await client.query(
                  'SELECT slug, name FROM membership_tiers WHERE LOWER(slug) = $1 OR LOWER(name) = $1',
                  [keyword]
                );
                if (keywordTierResult.rows.length > 0) {
                  newTierName = keywordTierResult.rows[0].name;
                  matchMethod = 'product_name';
                  logger.info(`[Stripe Webhook] Tier matched by product name "${product.name}" -> ${newTierName}`);
                  break;
                }
              }
            }
          } catch (productError: unknown) {
            logger.error('[Stripe Webhook] Error fetching product for name match:', { error: productError });
          }
        }
      }
      
      // Compare names (users.tier stores the display name like 'Social', not slug)
      if (newTierName && newTierName !== currentTier) {
        await client.query(
          'UPDATE users SET tier = $1, billing_provider = $3, stripe_current_period_end = COALESCE($4, stripe_current_period_end), updated_at = NOW() WHERE id = $2',
          [newTierName, userId, 'stripe', subscriptionPeriodEnd]
        );
        
        logger.info(`[Stripe Webhook] Tier updated via Stripe for ${email}: ${currentTier} -> ${newTierName} (matched by ${matchMethod})`);
        
        const deferredTierEmail = email;
        const deferredOldTier = currentTier || 'None';
        const deferredNewTierName = newTierName;

        deferredActions.push(async () => {
          try {
            const hubspotResult = await handleTierChange(
              deferredTierEmail,
              deferredOldTier,
              deferredNewTierName,
              'stripe-webhook',
              'Stripe Subscription'
            );
            
            if (!hubspotResult.success && hubspotResult.error) {
              logger.warn(`[Stripe Webhook] HubSpot tier sync failed for ${deferredTierEmail}, queuing for retry: ${hubspotResult.error}`);
              await queueTierSync({
                email: deferredTierEmail,
                newTier: deferredNewTierName,
                oldTier: deferredOldTier,
                changedBy: 'stripe-webhook',
                changedByName: 'Stripe Subscription'
              });
            } else {
              logger.info(`[Stripe Webhook] Synced ${deferredTierEmail} tier=${deferredNewTierName} to HubSpot (deal line items updated)`);
            }
          } catch (hubspotError: unknown) {
            logger.error('[Stripe Webhook] HubSpot sync failed for tier change, queuing for retry:', { extra: { detail: getErrorMessage(hubspotError) } });
            try {
              await queueTierSync({
                email: deferredTierEmail,
                newTier: deferredNewTierName,
                oldTier: deferredOldTier,
                changedBy: 'stripe-webhook',
                changedByName: 'Stripe Subscription'
              });
            } catch (queueErr: unknown) {
              logger.error('[Stripe Webhook] Failed to queue tier sync retry:', { error: queueErr });
            }
          }
        });
        
        deferredActions.push(async () => {
          try {
            await notifyMember({
              userEmail: deferredTierEmail,
              title: 'Membership Updated',
              message: `Your membership has been changed to ${deferredNewTierName}.`,
              type: 'system',
            });
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });
      }
    }

    if (status === 'active') {
      await client.query(
        `UPDATE users SET membership_status = 'active', billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end), updated_at = NOW() 
         WHERE id = $1 
         AND (membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'past_due'))
         AND COALESCE(membership_status, '') NOT IN ('cancelled', 'suspended', 'terminated')`,
        [userId, subscriptionPeriodEnd]
      );
      logger.info(`[Stripe Webhook] Membership status set to active for ${email}`);

      const reactivationStatuses = ['past_due', 'unpaid', 'suspended'];
      if (previousAttributes?.status && reactivationStatuses.includes(previousAttributes.status)) {
        const deferredReactivationMemberName = memberName;
        const deferredReactivationEmail = email;
        const deferredPreviousStatus = previousAttributes.status;

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Member Reactivated',
              `${deferredReactivationMemberName} (${deferredReactivationEmail}) membership has been reactivated (was ${deferredPreviousStatus}).`,
              'member_status_change',
              { sendPush: true, url: '/admin/members' }
            );
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });
      }
      
      // Reactivate sub-members (family/corporate employees) if they were suspended/past_due
      try {
        const groupResult = await client.query(
          `SELECT bg.id, bg.group_name, bg.type FROM billing_groups bg 
           WHERE LOWER(bg.primary_email) = LOWER($1) AND bg.is_active = true`,
          [email]
        );
        
        if (groupResult.rows.length > 0) {
          const group = groupResult.rows[0];
          
          // Reactivate all sub-members that were suspended/past_due due to billing issues
          // Guard: only update sub-members whose billing_provider is stripe or unset (protect mindbody/manual members)
          const subMembersResult = await client.query(
            `UPDATE users u SET membership_status = 'active', billing_provider = 'stripe', updated_at = NOW()
             FROM group_members gm
             WHERE gm.billing_group_id = $1 
             AND gm.is_active = true
             AND LOWER(u.email) = LOWER(gm.member_email)
             AND u.membership_status IN ('past_due', 'suspended')
             AND (u.billing_provider IS NULL OR u.billing_provider = '' OR u.billing_provider = 'stripe' OR u.billing_provider = 'family_addon')
             RETURNING u.email`,
            [group.id]
          );
          
          const affectedCount = subMembersResult.rows.length;
          if (affectedCount > 0) {
            logger.info(`[Stripe Webhook] Reactivated ${affectedCount} sub-members for group ${group.group_name}`);
            
            const deferredReactivatedSubEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                for (const subEmail of deferredReactivatedSubEmails) {
                  await notifyMember({
                    userEmail: subEmail,
                    title: 'Membership Restored',
                    message: 'Your membership access has been restored. Welcome back!',
                    type: 'system',
                  }, { sendPush: true });
                }
              } catch (notifyErr: unknown) {
                logger.error('[Stripe Webhook] Sub-member reactivation notification failed (non-fatal):', { error: notifyErr });
              }
            });
            
            // Defer HubSpot sync for reactivated sub-members (runs after transaction commits)
            const reactivatedEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../hubspot/stages');
                for (const subEmail of reactivatedEmails) {
                  await syncMemberToHubSpot({ email: subEmail, status: 'active', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
                }
                logger.info(`[Stripe Webhook] Synced ${reactivatedEmails.length} reactivated sub-members to HubSpot`);
              } catch (hubspotErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for reactivated sub-members:', { error: hubspotErr });
              }
            });
          }
        }
      } catch (groupErr: unknown) {
        logger.error('[Stripe Webhook] Error reactivating sub-members:', { error: groupErr });
      }
      
      const deferredActiveEmail = email;
      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredActiveEmail, status: 'active', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredActiveEmail} status=active to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status active:', { error: hubspotError });
        }
      });
    } else if (status === 'past_due') {
      await client.query(
        `UPDATE users SET membership_status = 'past_due', billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end), updated_at = NOW() WHERE id = $1`,
        [userId, subscriptionPeriodEnd]
      );

      const statusActuallyChanged = previousAttributes?.status && previousAttributes.status !== 'past_due';

      if (statusActuallyChanged) {
        const deferredPastDueEmail = email;
        const deferredPastDueMemberName = memberName;

        deferredActions.push(async () => {
          try {
            await notifyMember({
              userEmail: deferredPastDueEmail,
              title: 'Membership Past Due',
              message: 'Your membership payment is past due. Please update your payment method to avoid service interruption.',
              type: 'membership_past_due',
            }, { sendPush: true });
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Membership Past Due',
              `${deferredPastDueMemberName} (${deferredPastDueEmail}) subscription payment is past due.`,
              'membership_past_due',
              { sendPush: true, sendWebSocket: true }
            );
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });

        logger.info(`[Stripe Webhook] Past due notification deferred for ${email}`);
      } else {
        logger.info(`[Stripe Webhook] Skipping past_due notification for ${email} — status was already past_due`);
      }
      
      // Propagate past_due status to sub-members (family/corporate employees)
      try {
        const groupResult = await client.query(
          `SELECT bg.id, bg.group_name, bg.type FROM billing_groups bg 
           WHERE LOWER(bg.primary_email) = LOWER($1) AND bg.is_active = true`,
          [email]
        );
        
        if (groupResult.rows.length > 0) {
          const group = groupResult.rows[0];
          
          // Update all active sub-members to past_due status
          // Guard: only update sub-members whose billing_provider is stripe or unset (protect mindbody/manual members)
          const subMembersResult = await client.query(
            `UPDATE users u SET membership_status = 'past_due', billing_provider = 'stripe', updated_at = NOW()
             FROM group_members gm
             WHERE gm.billing_group_id = $1 
             AND gm.is_active = true
             AND LOWER(u.email) = LOWER(gm.member_email)
             AND u.membership_status NOT IN ('cancelled', 'terminated')
             AND (u.billing_provider IS NULL OR u.billing_provider = '' OR u.billing_provider = 'stripe' OR u.billing_provider = 'family_addon')
             RETURNING u.email`,
            [group.id]
          );
          
          const affectedCount = subMembersResult.rows.length;
          if (affectedCount > 0) {
            logger.info(`[Stripe Webhook] Set ${affectedCount} sub-members to past_due for group ${group.group_name}`);
            
            const deferredPastDueSubEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                for (const subEmail of deferredPastDueSubEmails) {
                  await notifyMember({
                    userEmail: subEmail,
                    title: 'Membership Payment Issue',
                    message: 'Your membership access may be affected by a billing issue with your group account.',
                    type: 'membership_past_due',
                  }, { sendPush: true });
                }
              } catch (notifyErr: unknown) {
                logger.error('[Stripe Webhook] Sub-member past_due notification failed (non-fatal):', { error: notifyErr });
              }
            });
            
            // Defer HubSpot sync for past_due sub-members (runs after transaction commits)
            const pastDueEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../hubspot/stages');
                for (const subEmail of pastDueEmails) {
                  await syncMemberToHubSpot({ email: subEmail, status: 'past_due', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
                }
                logger.info(`[Stripe Webhook] Synced ${pastDueEmails.length} past_due sub-members to HubSpot`);
              } catch (hubspotErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for past_due sub-members:', { error: hubspotErr });
              }
            });
          }
        }
      } catch (groupErr: unknown) {
        logger.error('[Stripe Webhook] Error propagating past_due to sub-members:', { error: groupErr });
      }
      
      const deferredPastDueSyncEmail = email;
      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredPastDueSyncEmail, status: 'past_due', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredPastDueSyncEmail} status=past_due to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status past_due:', { error: hubspotError });
        }
      });
    } else if (status === 'canceled') {
      logger.info(`[Stripe Webhook] Subscription canceled for ${email} - handled by subscription.deleted webhook`);
    } else if (status === 'unpaid') {
      await client.query(
        `UPDATE users SET membership_status = 'suspended', billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end), updated_at = NOW() WHERE id = $1`,
        [userId, subscriptionPeriodEnd]
      );

      const deferredUnpaidEmail = email;
      const deferredUnpaidMemberName = memberName;

      deferredActions.push(async () => {
        try {
          await notifyMember({
            userEmail: deferredUnpaidEmail,
            title: 'Membership Unpaid',
            message: 'Your membership is unpaid. Please update your payment method to restore access.',
            type: 'membership_past_due',
          }, { sendPush: true });
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }
      });

      deferredActions.push(async () => {
        try {
          await notifyAllStaff(
            'Membership Suspended - Unpaid',
            `${deferredUnpaidMemberName} (${deferredUnpaidEmail}) subscription is unpaid and has been suspended.`,
            'membership_past_due',
            { sendPush: true, sendWebSocket: true }
          );
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }
      });

      logger.info(`[Stripe Webhook] Unpaid notifications deferred for ${email}`);
      
      // Propagate suspension to sub-members (family/corporate employees)
      try {
        const groupResult = await client.query(
          `SELECT bg.id, bg.group_name, bg.type FROM billing_groups bg 
           WHERE LOWER(bg.primary_email) = LOWER($1) AND bg.is_active = true`,
          [email]
        );
        
        if (groupResult.rows.length > 0) {
          const group = groupResult.rows[0];
          
          // Suspend all active sub-members
          // Guard: only update sub-members whose billing_provider is stripe or unset (protect mindbody/manual members)
          const subMembersResult = await client.query(
            `UPDATE users u SET membership_status = 'suspended', billing_provider = 'stripe', updated_at = NOW()
             FROM group_members gm
             WHERE gm.billing_group_id = $1 
             AND gm.is_active = true
             AND LOWER(u.email) = LOWER(gm.member_email)
             AND u.membership_status NOT IN ('cancelled', 'terminated')
             AND (u.billing_provider IS NULL OR u.billing_provider = '' OR u.billing_provider = 'stripe' OR u.billing_provider = 'family_addon')
             RETURNING u.email`,
            [group.id]
          );
          
          const affectedCount = subMembersResult.rows.length;
          if (affectedCount > 0) {
            logger.info(`[Stripe Webhook] Suspended ${affectedCount} sub-members for group ${group.group_name}`);
            
            const deferredSuspendedSubEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                for (const subEmail of deferredSuspendedSubEmails) {
                  await notifyMember({
                    userEmail: subEmail,
                    title: 'Membership Suspended',
                    message: 'Your membership has been suspended due to an unpaid balance on your group account.',
                    type: 'membership_past_due',
                  }, { sendPush: true });
                }
              } catch (notifyErr: unknown) {
                logger.error('[Stripe Webhook] Sub-member suspension notification failed (non-fatal):', { error: notifyErr });
              }
            });
            
            // Defer HubSpot sync for suspended sub-members (runs after transaction commits)
            const suspendedEmails = subMembersResult.rows.map((r: { email: string }) => r.email);
            deferredActions.push(async () => {
              try {
                const { syncMemberToHubSpot } = await import('../hubspot/stages');
                for (const subEmail of suspendedEmails) {
                  await syncMemberToHubSpot({ email: subEmail, status: 'suspended', billingProvider: 'stripe', billingGroupRole: 'Sub-member' });
                }
                logger.info(`[Stripe Webhook] Synced ${suspendedEmails.length} suspended sub-members to HubSpot`);
              } catch (hubspotErr: unknown) {
                logger.error('[Stripe Webhook] HubSpot sync failed for suspended sub-members:', { error: hubspotErr });
              }
            });
          }
        }
      } catch (groupErr: unknown) {
        logger.error('[Stripe Webhook] Error propagating suspension to sub-members:', { error: groupErr });
      }
      
      const deferredSuspendedSyncEmail = email;
      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredSuspendedSyncEmail, status: 'suspended', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredSuspendedSyncEmail} status=suspended to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status suspended:', { error: hubspotError });
        }
      });
    }

    try {
      const updatedDiscounts = subscription.discounts?.filter((d): d is Stripe.Discount => typeof d !== 'string');
      let currentCoupon = updatedDiscounts?.[0]?.coupon;
      if (!currentCoupon) {
        for (const item of (subscription.items?.data || [])) {
          const itemDiscounts = (item as any).discounts?.filter((d: any): d is Stripe.Discount => typeof d === 'object' && d !== null && 'coupon' in d);
          if (itemDiscounts?.[0]?.coupon) {
            currentCoupon = itemDiscounts[0].coupon;
            break;
          }
        }
      }
      const newDiscountCode = currentCoupon
        ? (typeof currentCoupon === 'string' ? currentCoupon : (currentCoupon.name || currentCoupon.id))
        : null;
      await client.query(
        'UPDATE users SET discount_code = $1, updated_at = NOW() WHERE id = $2',
        [newDiscountCode, userId]
      );
      if (newDiscountCode) {
        logger.info(`[Stripe Webhook] Synced discount_code="${newDiscountCode}" for ${email}`);
      }
    } catch (discountErr: unknown) {
      logger.warn('[Stripe Webhook] Failed to sync discount_code from subscription', { extra: { error: getErrorMessage(discountErr) } });
    }

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: email,
      memberName,
      status
    });

    logger.info(`[Stripe Webhook] Subscription status changed to '${status}' for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription updated:', { error: error });
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionPaused(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

    const userResult = await client.query(
      'SELECT id, email, first_name, last_name, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId} (subscription.paused)`);
      return deferredActions;
    }

    const { id: userId, email, first_name, last_name } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription paused for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    await client.query(
      `UPDATE users SET membership_status = 'frozen', billing_provider = 'stripe', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    logger.info(`[Stripe Webhook] Subscription paused: ${email} membership_status set to frozen`);

    const deferredEmail = email;
    const deferredMemberName = memberName;

    deferredActions.push(async () => {
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await syncMemberToHubSpot({ email: deferredEmail, status: 'frozen', billingProvider: 'stripe', billingGroupRole: 'Primary' });
        logger.info(`[Stripe Webhook] Synced ${deferredEmail} status=frozen to HubSpot`);
      } catch (hubspotError: unknown) {
        logger.error('[Stripe Webhook] HubSpot sync failed for status frozen:', { extra: { detail: getErrorMessage(hubspotError) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: deferredEmail,
          title: 'Membership Paused',
          message: 'Your membership has been paused. You can resume anytime to restore full access.',
          type: 'system',
        });
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Membership Paused',
          `${deferredMemberName} (${deferredEmail}) membership has been paused (frozen).`,
          'member_status_change',
          { sendPush: true, sendWebSocket: true }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: email,
      memberName,
      status: 'frozen'
    });

    deferredActions.push(async () => {
      await logSystemAction({
        action: 'subscription_paused' as 'subscription_created',
        resourceType: 'subscription',
        resourceId: subscription.id,
        resourceName: `${memberName} (${email})`,
        details: {
          source: 'stripe_webhook',
          member_email: email,
          stripe_subscription_id: subscription.id,
          new_status: 'frozen'
        }
      });
    });

    logger.info(`[Stripe Webhook] Subscription paused processed for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription paused:', { extra: { detail: getErrorMessage(error) } });
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionResumed(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const subscriptionPeriodEnd = (subscription as StripeSubscriptionWithPeriods).current_period_end
      ? new Date((subscription as StripeSubscriptionWithPeriods).current_period_end * 1000)
      : null;

    const userResult = await client.query(
      'SELECT id, email, first_name, last_name, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId} (subscription.resumed)`);
      return deferredActions;
    }

    const { id: userId, email, first_name, last_name } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription resumed for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    await client.query(
      `UPDATE users SET membership_status = 'active', billing_provider = 'stripe', stripe_current_period_end = COALESCE($2, stripe_current_period_end), updated_at = NOW() WHERE id = $1`,
      [userId, subscriptionPeriodEnd]
    );
    logger.info(`[Stripe Webhook] Subscription resumed: ${email} membership_status set to active`);

    const deferredEmail = email;
    const deferredMemberName = memberName;

    deferredActions.push(async () => {
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await syncMemberToHubSpot({ email: deferredEmail, status: 'active', billingProvider: 'stripe', billingGroupRole: 'Primary' });
        logger.info(`[Stripe Webhook] Synced ${deferredEmail} status=active to HubSpot`);
      } catch (hubspotError: unknown) {
        logger.error('[Stripe Webhook] HubSpot sync failed for status active:', { extra: { detail: getErrorMessage(hubspotError) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyMember({
          userEmail: deferredEmail,
          title: 'Membership Resumed',
          message: 'Your membership has been resumed. Welcome back!',
          type: 'membership_renewed',
        });
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Membership Resumed',
          `${deferredMemberName} (${deferredEmail}) membership has been resumed.`,
          'member_status_change',
          { sendPush: true, sendWebSocket: true }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { extra: { detail: getErrorMessage(notifyErr) } });
      }
    });

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: email,
      memberName,
      status: 'active'
    });

    deferredActions.push(async () => {
      await logSystemAction({
        action: 'subscription_resumed' as 'subscription_created',
        resourceType: 'subscription',
        resourceId: subscription.id,
        resourceName: `${memberName} (${email})`,
        details: {
          source: 'stripe_webhook',
          member_email: email,
          stripe_subscription_id: subscription.id,
          new_status: 'active'
        }
      });
    });

    logger.info(`[Stripe Webhook] Subscription resumed processed for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription resumed:', { extra: { detail: getErrorMessage(error) } });
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionDeleted(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const subscriptionId = subscription.id;

    // CRITICAL: Handle group billing cancellation via centralized function
    // This ensures sub-members lose access when primary cancels
    try {
      await handlePrimarySubscriptionCancelled(subscriptionId);
    } catch (groupErr: unknown) {
      logger.error('[Stripe Webhook] Error in handlePrimarySubscriptionCancelled:', { error: groupErr });
      // Don't throw - continue to process other cancellation logic
    }

    const userResult = await client.query(
      'SELECT email, first_name, last_name, membership_status, billing_provider FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return deferredActions;
    }

    const { email, first_name, last_name, membership_status: previousStatus } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    const userBillingProvider = userResult.rows[0].billing_provider;
    if (userBillingProvider && userBillingProvider !== 'stripe') {
      logger.info(`[Stripe Webhook] Skipping subscription deleted for ${email} — billing_provider is '${userBillingProvider}', not 'stripe'`);
      return deferredActions;
    }

    const wasTrialing = previousStatus === 'trialing';

    if (wasTrialing) {
      const pauseResult = await client.query(
        `UPDATE users SET 
          membership_status = 'paused',
          billing_provider = 'stripe',
          stripe_subscription_id = NULL,
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($1) AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)`,
        [email, subscriptionId]
      );

      if (pauseResult.rowCount === 0) {
        logger.info(`[Stripe Webhook] Skipping pause for ${email} - subscription ${subscriptionId} is not their current subscription`);
        return deferredActions;
      }

      logger.info(`[Stripe Webhook] Trial ended for ${email} - membership paused (account preserved, booking blocked)`);

      const deferredEmail = email;
      const deferredMemberName = memberName;

      deferredActions.push(async () => {
        try {
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          await syncMemberToHubSpot({ email: deferredEmail, status: 'paused', billingProvider: 'stripe', billingGroupRole: 'Primary' });
          logger.info(`[Stripe Webhook] Synced ${deferredEmail} status=paused to HubSpot`);
        } catch (hubspotError: unknown) {
          logger.error('[Stripe Webhook] HubSpot sync failed for status paused:', { error: hubspotError });
        }

        try {
          await notifyMember({
            userEmail: deferredEmail,
            title: 'Trial Ended',
            message: 'Your free trial has ended. Your account is still here - renew anytime to pick up where you left off!',
            type: 'membership_failed',
          });
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }

        try {
          await notifyAllStaff(
            'Trial Expired',
            `${deferredMemberName} (${deferredEmail}) trial has ended. Membership paused (account preserved).`,
            'trial_expired',
            { sendPush: true, sendWebSocket: true }
          );
        } catch (notifyErr: unknown) {
          logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
        }
      });

      broadcastBillingUpdate({
        action: 'subscription_updated',
        memberEmail: email,
        memberName
      });

      return deferredActions;
    }

    // Check if there was a billing group and notify staff of orphaned members
    const billingGroupResult = await client.query(
      `SELECT bg.id, bg.group_name, bg.is_active
       FROM billing_groups bg
       WHERE LOWER(bg.primary_email) = LOWER($1)`,
      [email]
    );

    if (billingGroupResult.rows.length > 0) {
      const billingGroup = billingGroupResult.rows[0];
      
      // Get count of members that were just deactivated for notification
      const deactivatedMembersResult = await client.query(
        `SELECT gm.member_email
         FROM group_members gm
         WHERE gm.billing_group_id = $1 AND gm.is_active = false 
         AND gm.removed_at >= NOW() - INTERVAL '1 minute'`,
        [billingGroup.id]
      );

      if (deactivatedMembersResult.rows.length > 0) {
        const orphanedEmails = deactivatedMembersResult.rows.map((m: Record<string, unknown>) => m.member_email);
        
        logger.warn(`[Stripe Webhook] ORPHAN BILLING WARNING: Primary member ${memberName} (${email}) ` +
          `subscription cancelled with ${orphanedEmails.length} group members deactivated: ${orphanedEmails.join(', ')}`);

        const deferredOrphanMemberName = memberName;
        const deferredOrphanEmail = email;
        const deferredOrphanedEmails = [...orphanedEmails];

        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Orphan Billing Alert',
              `Primary member ${deferredOrphanMemberName} (${deferredOrphanEmail}) subscription was cancelled. ` +
                `${deferredOrphanedEmails.length} group member(s) have been automatically deactivated: ${deferredOrphanedEmails.join(', ')}.`,
              'billing_alert',
              { sendPush: true }
            );
          } catch (notifyErr: unknown) {
            logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
          }
        });
      }

      // Deactivate the billing group itself
      if (billingGroup.is_active) {
        await client.query(
          `UPDATE billing_groups SET is_active = false, updated_at = NOW() WHERE id = $1`,
          [billingGroup.id]
        );
        logger.info(`[Stripe Webhook] Deactivated billing group ${billingGroup.id} for cancelled primary member`);
      }
    }

    const cancelResult = await client.query(
      `UPDATE users SET 
        last_tier = tier,
        tier = NULL,
        membership_status = 'cancelled',
        billing_provider = 'stripe',
        stripe_subscription_id = NULL,
        grace_period_start = NULL,
        grace_period_email_count = 0,
        updated_at = NOW()
      WHERE LOWER(email) = LOWER($1) AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)`,
      [email, subscriptionId]
    );

    if (cancelResult.rowCount === 0) {
      logger.info(`[Stripe Webhook] Skipping cancellation for ${email} - subscription ${subscriptionId} is not their current subscription`);
      return deferredActions;
    }

    logger.info(`[Stripe Webhook] Updated ${email} membership_status to cancelled, tier cleared`);

    deferredActions.push(async () => {
      try {
        const { getTodayPacific, formatTimePacific } = await import('../../utils/dateUtils');
        const todayStr = getTodayPacific();
        const nowTimePacific = formatTimePacific(new Date());
        const futureBookingsResult = await pool.query(
          `SELECT id, request_date, start_time, status FROM booking_requests 
           WHERE LOWER(user_email) = LOWER($1) 
           AND status IN ('pending', 'pending_approval', 'approved', 'confirmed', 'cancellation_pending')
           AND (request_date > $2 OR (request_date = $2 AND start_time > $3))`,
          [email, todayStr, nowTimePacific]
        );

        if (futureBookingsResult.rows.length > 0) {
          const { BookingStateService } = await import('../bookingService/bookingStateService');
          let cancelledCount = 0;
          const errors: string[] = [];

          for (const booking of futureBookingsResult.rows) {
            try {
              await BookingStateService.cancelBooking({
                bookingId: booking.id,
                source: 'system',
                staffNotes: 'Auto-cancelled: membership subscription ended',
              });
              cancelledCount++;
            } catch (cancelErr: unknown) {
              errors.push(`Booking #${booking.id}: ${getErrorMessage(cancelErr)}`);
            }
          }

          logger.info(`[Stripe Webhook] Auto-cancelled ${cancelledCount}/${futureBookingsResult.rows.length} future bookings for cancelled member ${email}`);

          if (cancelledCount > 0) {
            try {
              await notifyAllStaff(
                'Future Bookings Auto-Cancelled',
                `${cancelledCount} future booking(s) for ${memberName} (${email}) were automatically cancelled due to membership cancellation.`,
                'booking_cancelled',
                { sendPush: true }
              );
            } catch (notifyErr: unknown) {
              logger.warn('[Stripe Webhook] Failed to notify staff about auto-cancelled bookings:', { error: getErrorMessage(notifyErr) });
            }
          }

          if (errors.length > 0) {
            logger.error(`[Stripe Webhook] Failed to cancel ${errors.length} future bookings for ${email}:`, { extra: { errors } });
          }
        }
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Error auto-cancelling future bookings for cancelled member:', { error: getErrorMessage(err) });
      }
    });

    const deferredCancelEmail = email;
    const deferredCancelMemberName = memberName;

    deferredActions.push(async () => {
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await syncMemberToHubSpot({ email: deferredCancelEmail, status: 'cancelled', billingProvider: 'stripe', billingGroupRole: 'Primary' });
        logger.info(`[Stripe Webhook] Synced ${deferredCancelEmail} status=cancelled to HubSpot`);
      } catch (hubspotError: unknown) {
        logger.error('[Stripe Webhook] HubSpot sync failed for status cancelled:', { error: hubspotError });
      }

      try {
        const cancellationResult = await handleMembershipCancellation(deferredCancelEmail, 'stripe-webhook', 'Stripe Subscription');
        if (cancellationResult.success) {
          logger.info(`[Stripe Webhook] HubSpot cancellation processed: ${cancellationResult.lineItemsRemoved} line items removed, deal moved to lost: ${cancellationResult.dealMovedToLost}`);
        } else {
          logger.error(`[Stripe Webhook] HubSpot cancellation failed: ${cancellationResult.error}`);
        }
      } catch (cancellationError: unknown) {
        logger.error('[Stripe Webhook] HubSpot cancellation handling failed:', { error: cancellationError });
      }

      try {
        await notifyMember({
          userEmail: deferredCancelEmail,
          title: 'Membership Cancelled',
          message: 'Your membership has been cancelled. We hope to see you again soon.',
          type: 'membership_cancelled',
        });
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
      }

      try {
        await notifyAllStaff(
          'Membership Cancelled',
          `${deferredCancelMemberName} (${deferredCancelEmail}) has cancelled their membership.`,
          'membership_cancelled',
          { sendPush: true, sendWebSocket: true }
        );
      } catch (notifyErr: unknown) {
        logger.error('[Stripe Webhook] Notification failed (non-fatal):', { error: getErrorMessage(notifyErr) });
      }
    });

    broadcastBillingUpdate({
      action: 'subscription_cancelled',
      memberEmail: email,
      memberName
    });

    logger.info(`[Stripe Webhook] Membership cancellation processed for ${memberName} (${email})`);
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling subscription deleted:', { error: error });
    throw error;
  }
  return deferredActions;
}

async function handleProductUpdated(client: PoolClient, product: StripeProductWithMarketingFeatures): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    logger.info(`[Stripe Webhook] Product updated: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      const tierId = tierMatch.rows[0].id;
      const tierName = tierMatch.rows[0].name;
      logger.info(`[Stripe Webhook] Product ${product.id} matches tier "${tierName}", deferring feature pull`);

      if (Array.isArray(product.marketing_features) && product.marketing_features.length > 0) {
        const featureNames = product.marketing_features
          .map((f: { name: string }) => f.name)
          .filter((n: string) => n && n.trim());
        if (featureNames.length > 0) {
          await client.query(
            'UPDATE membership_tiers SET highlighted_features = $1, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(featureNames), tierId]
          );
          logger.info(`[Stripe Webhook] Updated highlighted features for "${tierName}" from ${featureNames.length} marketing features`);
        } else {
          logger.info(`[Stripe Webhook] Skipping highlighted_features update for "${tierName}" — marketing_features present but all empty names`);
        }
      } else {
        logger.info(`[Stripe Webhook] Skipping highlighted_features update for "${tierName}" — no marketing_features in webhook payload`);
      }

      deferredActions.push(async () => {
        await pullTierFeaturesFromStripe();
      });
      return deferredActions;
    }

    if (product.metadata?.config_type === 'corporate_volume_pricing') {
      const { pullCorporateVolumePricingFromStripe } = await import('./products');
      deferredActions.push(async () => {
        await pullCorporateVolumePricingFromStripe();
      });
    }

    if (product.metadata?.cafe_item_id) {
      const cafeItemId = parseInt(product.metadata.cafe_item_id, 10) || -1;
      const imageUrl = product.images?.[0] || null;
      const category = product.metadata?.category || undefined;

      await client.query(
        `UPDATE cafe_items SET
          name = $1, description = $2,
          image_url = COALESCE($3, image_url),
          category = COALESCE($4, category)
        WHERE stripe_product_id = $5 OR id = $6`,
        [product.name, product.description || null, imageUrl, category, product.id, cafeItemId]
      );
      logger.info(`[Stripe Webhook] Updated cafe item from product ${product.id}`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.updated:', { error: error });
  }

  return deferredActions;
}

async function handleProductCreated(client: PoolClient, product: Stripe.Product): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    logger.info(`[Stripe Webhook] Product created: ${product.id} (${product.name})`);

    if (product.metadata?.source === 'ever_house_app') {
      logger.info(`[Stripe Webhook] Skipping app-created product ${product.id}`);
      return deferredActions;
    }

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      logger.info(`[Stripe Webhook] New product ${product.id} matches tier "${tierMatch.rows[0].name}", deferring feature pull`);
      deferredActions.push(async () => {
        await pullTierFeaturesFromStripe();
      });
    } else {
      logger.info(`[Stripe Webhook] New product ${product.id} created in Stripe. Use "Pull from Stripe" button to import if needed.`);
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.created:', { error: error });
  }

  return deferredActions;
}

async function handleProductDeleted(client: PoolClient, product: Stripe.Product): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    logger.info(`[Stripe Webhook] Product deleted: ${product.id} (${product.name})`);

    const tierMatch = await client.query(
      'SELECT id, name FROM membership_tiers WHERE stripe_product_id = $1 LIMIT 1',
      [product.id]
    );

    if (tierMatch.rows.length > 0) {
      logger.warn(`[Stripe Webhook] WARNING: Tier product deleted in Stripe for tier "${tierMatch.rows[0].name}" (${product.id}). Tier data preserved in app.`);
      await client.query(
        'UPDATE membership_tiers SET stripe_product_id = NULL, stripe_price_id = NULL WHERE id = $1',
        [tierMatch.rows[0].id]
      );
      logger.info(`[Stripe Webhook] Cleared Stripe references for tier "${tierMatch.rows[0].name}" after product deletion`);
      clearTierCache();
      return deferredActions;
    }

    const cafeResult = await client.query(
      'UPDATE cafe_items SET is_active = false WHERE stripe_product_id = $1 AND is_active = true RETURNING id, name',
      [product.id]
    );

    if (cafeResult.rowCount && cafeResult.rowCount > 0) {
      for (const row of cafeResult.rows) {
        logger.info(`[Stripe Webhook] Deactivated cafe item "${row.name}" (id: ${row.id}) due to Stripe product deletion`);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling product.deleted:', { error: error });
  }

  return deferredActions;
}

async function handlePriceChange(client: PoolClient, price: Stripe.Price): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const productId = typeof price.product === 'string' ? price.product : price.product?.id;
    if (!productId) return deferredActions;

    logger.info(`[Stripe Webhook] Price changed: ${price.id} for product ${productId}`);

    const priceCents = price.unit_amount || 0;
    const priceDecimal = (priceCents / 100).toFixed(2);

    const result = await client.query(
      `UPDATE cafe_items SET price = $1, stripe_price_id = $2
       WHERE stripe_product_id = $3
       RETURNING id, name`,
      [priceDecimal, price.id, productId]
    );

    if (result.rowCount && result.rowCount > 0) {
      for (const row of result.rows) {
        logger.info(`[Stripe Webhook] Updated price for cafe item "${row.name}" to $${priceDecimal}`);
      }
    }

    const tierResult = await client.query(
      `UPDATE membership_tiers SET price_cents = $1, stripe_price_id = $2
       WHERE stripe_product_id = $3
       RETURNING id, name`,
      [priceCents, price.id, productId]
    );

    if (tierResult.rowCount && tierResult.rowCount > 0) {
      for (const row of tierResult.rows) {
        logger.info(`[Stripe Webhook] Updated tier "${row.name}" price to ${priceCents} cents ($${priceDecimal})`);
      }
      clearTierCache();

      const slugResult = await client.query(
        `SELECT slug FROM membership_tiers WHERE stripe_product_id = $1`, [productId]
      );
      const slug = slugResult.rows[0]?.slug;
      if (slug === 'simulator-overage-30min') {
        updateOverageRate(priceCents);
      } else if (slug === 'guest-pass') {
        updateGuestFee(priceCents);
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling price change:', { error: error });
  }

  return deferredActions;
}

async function handleCustomerUpdated(client: PoolClient, customer: Stripe.Customer): Promise<DeferredAction[]> {
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
        `SELECT id, email FROM users WHERE LOWER(email) = $1 AND archived_at IS NULL AND membership_status NOT IN ('merged', 'terminated') AND stripe_customer_id IS NULL LIMIT 2`,
        [stripeEmail]
      );
      if (activeMatch.rows.length === 1) {
        logger.warn(`[Stripe Webhook] customer.updated: Stripe email change for ${stripeCustomerId} matches existing user ${activeMatch.rows[0].email}. Auto-reassignment BLOCKED — flagging for manual review.`);
        
        deferredActions.push(async () => {
          try {
            await notifyAllStaff(
              'Stripe Customer Email Change — Action Required',
              `Stripe customer ${stripeCustomerId} (currently ${currentEmail}) changed their email to ${stripeEmail}, which matches existing member ${activeMatch.rows[0].email}. Auto-reassignment was blocked for security. Please verify and update manually if this is legitimate.`,
              'billing_alert',
              { sendPush: true }
            );
          } catch (err: unknown) {
            logger.error('[Stripe Webhook] Failed to send reassignment alert:', { error: err });
          }
        });
        updates.push(`auto_reassignment_blocked (stripe_email=${stripeEmail} matches ${activeMatch.rows[0].email})`);
      } else if (activeMatch.rows.length > 1) {
        logger.warn(`[Stripe Webhook] customer.updated: multiple active users match Stripe email ${stripeEmail} — skipping auto-reassignment, sending mismatch alert`);
      }

      logger.warn(`[Stripe Webhook] customer.updated: email changed in Stripe for customer ${stripeCustomerId}: ${currentEmail} → ${stripeEmail}. NOT auto-syncing email (requires manual verification).`);
      
      deferredActions.push(async () => {
        try {
          await notifyAllStaff(
            'Stripe Email Mismatch',
            `Member ${user.display_name || currentEmail} has a different email in Stripe (${stripeEmail}) than in the app (${currentEmail}). Please verify and update manually if needed.`,
            'billing_alert',
            { sendPush: false }
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to send email mismatch notification:', { error: err });
        }
      });
      updates.push(`email_mismatch_notified (stripe=${stripeEmail}, app=${currentEmail})`);
    }

    if (stripeName) {
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
    logger.error('[Stripe Webhook] Error handling customer.updated:', { error });
  }

  return deferredActions;
}

async function handleTrialWillEnd(client: PoolClient, subscription: Stripe.Subscription): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (!customerId) return deferredActions;

    const trialEnd = subscription.trial_end;
    if (!trialEnd) return deferredActions;

    const trialEndDate = new Date(trialEnd * 1000);
    const daysLeft = Math.max(0, Math.ceil((trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

    const memberResult = await client.query(
      `SELECT id, email, first_name, last_name, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name, stripe_customer_id FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );

    if (memberResult.rows.length === 0) {
      logger.info(`[Stripe Webhook] trial_will_end: no local user for customer ${customerId}`);
      return deferredActions;
    }

    const member = memberResult.rows[0];
    const memberName = member.display_name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
    const memberEmail = member.email;
    const trialEndStr = trialEndDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });

    logger.info(`[Stripe Webhook] Trial ending in ${daysLeft} days for ${memberEmail} (${customerId})`);

    deferredActions.push(async () => {
      try {
        await notifyMember(
          memberEmail,
          'Trial Ending Soon',
          `Your trial membership ends on ${trialEndStr}. After that, your membership will automatically continue with regular billing. Visit your billing page to review your plan.`,
          'trial_ending',
          { sendPush: true }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to send trial ending notification:', { error: err });
      }
    });

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Member Trial Ending',
          `${memberName} (${memberEmail}) trial ends on ${trialEndStr} (${daysLeft} days).`,
          'trial_ending',
          { sendPush: false }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to send staff trial ending notification:', { error: err });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling trial_will_end:', { error });
  }

  return deferredActions;
}

async function handlePaymentMethodAttached(client: PoolClient, paymentMethod: Stripe.PaymentMethod): Promise<DeferredAction[]> {
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
            const { getStripeClient } = await import('./client');
            const stripe = await getStripeClient();
            const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
            if (pi.status === 'requires_payment_method') {
              const confirmed = await stripe.paymentIntents.confirm(row.stripe_payment_intent_id, {
                payment_method: paymentMethod.id,
              });
              if (confirmed.status === 'succeeded' || confirmed.status === 'processing') {
                await db.execute(sql`UPDATE stripe_payment_intents SET requires_card_update = FALSE, updated_at = NOW() WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id}`);
                logger.info(`[Stripe Webhook] Auto-retried payment ${row.stripe_payment_intent_id} successfully, cleared requires_card_update`);
              } else {
                logger.warn(`[Stripe Webhook] Auto-retry of ${row.stripe_payment_intent_id} resulted in status: ${confirmed.status}, keeping requires_card_update flag`);
              }
            }
          } catch (retryErr: unknown) {
            logger.error(`[Stripe Webhook] Failed to auto-retry payment ${row.stripe_payment_intent_id}:`, { error: retryErr });
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
          await notifyMember(
            member.email,
            'Payment Method Updated',
            'Your new payment method has been added successfully. Any pending payments will be retried automatically.',
            'billing',
            { sendPush: false }
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to send payment method notification:', { error: err });
        }
      });
    }
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling payment_method.attached:', { error });
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
      await client.query(
        `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
        [customer.id, user.id]
      );
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
      `UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL, billing_provider = '' WHERE id = $1`,
      [user.id]
    );

    logger.info(`[Stripe Webhook] Cleared billing fields for user ${user.id} (${user.email}) after Stripe customer deletion`);

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Stripe Customer Deleted',
          `${user.display_name || user.email} - their Stripe customer was deleted externally. Billing is now disconnected.`,
          'billing',
          { urgent: true }
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

    // NOTE: Must stay in transaction - result needed for DB write (requires_card_update flag)
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
        await notifyMember(
          user.email,
          'Payment Method Removed',
          'Your payment method was removed. Please add a new one to avoid billing issues.',
          'payment_method_update',
          { sendPush: false }
        );
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
            await notifyMember(
              user.email,
              'Card Expiring Soon',
              `Your card ending in ${last4} expires soon. Please update your payment method.`,
              'card_expiring',
              { sendPush: false }
            );
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
        await notifyMember(
          user.email,
          'Card Details Auto-Updated',
          'Your card details were automatically updated by your bank. No action needed.',
          'billing_alert',
          { sendPush: false }
        );
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

export async function handleChargeDisputeUpdated(client: PoolClient, dispute: Stripe.Dispute): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const { id, amount, payment_intent, reason, status, evidence_details } = dispute;

    const paymentIntentId = typeof payment_intent === 'string'
      ? payment_intent
      : payment_intent?.id || null;

    if (paymentIntentId) {
      await client.query(
        `UPDATE terminal_payments SET dispute_status = $1 WHERE stripe_payment_intent_id = $2`,
        [status, paymentIntentId]
      );
    }

    const statusDescriptions: Record<string, string> = {
      'needs_response': 'Needs Response',
      'under_review': 'Under Review',
      'won': 'Won',
      'lost': 'Lost',
      'warning_needs_response': 'Warning - Needs Response',
      'warning_under_review': 'Warning - Under Review',
      'warning_closed': 'Warning - Closed',
      'charge_refunded': 'Charge Refunded',
    };

    const statusDescription = statusDescriptions[status] || status;

    logger.info(`[Stripe Webhook] Dispute ${id} updated: status=${status} (${statusDescription}), amount=$${(amount / 100).toFixed(2)}, reason=${reason}`);

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Dispute Status Updated',
          `Dispute ${id} status changed to ${statusDescription}. Amount: $${(amount / 100).toFixed(2)}. Reason: ${reason || 'unknown'}.${paymentIntentId ? ` Payment Intent: ${paymentIntentId}` : ''}`,
          'billing',
          { urgent: status === 'needs_response' || status === 'warning_needs_response' }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about dispute update:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'charge_dispute_updated',
          resourceType: 'dispute',
          resourceId: id,
          details: {
            status,
            statusDescription,
            amount: amount / 100,
            reason,
            paymentIntentId,
            evidenceDueBy: evidence_details?.due_by ? new Date(evidence_details.due_by * 1000).toISOString() : null,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log dispute update:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling charge.dispute.updated:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

// --- Checkout, Invoice & Setup Intent Handlers ---

async function handleCheckoutSessionExpired(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
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

async function handleCheckoutSessionAsyncPaymentFailed(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
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

async function handleCheckoutSessionAsyncPaymentSucceeded(client: PoolClient, session: Stripe.Checkout.Session): Promise<DeferredAction[]> {
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

async function handleInvoicePaymentActionRequired(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
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
          resourceType: 'invoice',
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

async function handleInvoiceOverdue(client: PoolClient, invoice: InvoiceWithLegacyFields): Promise<DeferredAction[]> {
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
          { urgent: true, sendPush: true }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about overdue invoice:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'invoice_overdue',
          resourceType: 'invoice',
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

async function handleSetupIntentSucceeded(client: PoolClient, setupIntent: Stripe.SetupIntent): Promise<DeferredAction[]> {
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

async function handleSetupIntentFailed(client: PoolClient, setupIntent: Stripe.SetupIntent): Promise<DeferredAction[]> {
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
