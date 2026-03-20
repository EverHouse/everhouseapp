import Stripe from 'stripe';
import { getStripeSync, getStripeClient } from '../client';
import { updateFamilyDiscountPercent } from '../../billing/pricingConfig';
import { pool, safeRelease } from '../../db';
import { logger } from '../../logger';
import type { DeferredAction, StripeProductWithMarketingFeatures, InvoiceWithLegacyFields } from './types';
import {
  extractResourceId,
  tryClaimEvent,
  checkResourceEventOrder,
  executeDeferredActions,
  cleanupOldProcessedEvents,
} from './framework';
export { upsertTransactionCache } from './framework';

import {
  handlePaymentIntentSucceeded,
  handlePaymentIntentFailed,
  handlePaymentIntentCanceled,
  handlePaymentIntentStatusUpdate,
  handleChargeRefunded,
  handleChargeDisputeCreated,
  handleChargeDisputeClosed,
  handleChargeDisputeUpdated,
  handleCreditNoteCreated,
} from './handlers/payments';

import {
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleInvoiceLifecycle,
  handleInvoiceVoided,
  handleInvoicePaymentActionRequired,
  handleInvoiceOverdue,
} from './handlers/invoices';

import {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionPaused,
  handleSubscriptionResumed,
  handleSubscriptionDeleted,
  handleTrialWillEnd,
} from './handlers/subscriptions';

import {
  handleCheckoutSessionCompleted,
  handleCheckoutSessionExpired,
  handleCheckoutSessionAsyncPaymentFailed,
  handleCheckoutSessionAsyncPaymentSucceeded,
} from './handlers/checkout';

import {
  handleProductUpdated,
  handleProductCreated,
  handleProductDeleted,
  handlePriceChange,
  handlePriceDeleted,
} from './handlers/catalog';

import {
  handleCustomerUpdated,
  handleCustomerCreated,
  handleCustomerDeleted,
  handlePaymentMethodAttached,
  handlePaymentMethodDetached,
  handlePaymentMethodUpdated,
  handlePaymentMethodAutoUpdated,
  handleSetupIntentSucceeded,
  handleSetupIntentFailed,
} from './handlers/customers';

async function dispatchWebhookEvent(
  client: import('pg').PoolClient,
  eventType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dataObject: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  previousAttributes?: any
): Promise<DeferredAction[]> {
  if (eventType === 'payment_intent.processing' || eventType === 'payment_intent.requires_action') {
    return handlePaymentIntentStatusUpdate(client, dataObject);
  } else if (eventType === 'payment_intent.succeeded') {
    return handlePaymentIntentSucceeded(client, dataObject);
  } else if (eventType === 'payment_intent.payment_failed') {
    return handlePaymentIntentFailed(client, dataObject);
  } else if (eventType === 'payment_intent.canceled') {
    return handlePaymentIntentCanceled(client, dataObject);
  } else if (eventType === 'charge.refunded') {
    return handleChargeRefunded(client, dataObject);
  } else if (eventType === 'invoice.payment_succeeded') {
    return handleInvoicePaymentSucceeded(client, dataObject);
  } else if (eventType === 'invoice.payment_failed') {
    return handleInvoicePaymentFailed(client, dataObject);
  } else if (eventType === 'invoice.created' || eventType === 'invoice.finalized' || eventType === 'invoice.updated') {
    return handleInvoiceLifecycle(client, dataObject, eventType);
  } else if (eventType === 'invoice.voided' || eventType === 'invoice.marked_uncollectible') {
    return handleInvoiceVoided(client, dataObject, eventType);
  } else if (eventType === 'checkout.session.completed') {
    return handleCheckoutSessionCompleted(client, dataObject);
  } else if (eventType === 'customer.subscription.created') {
    return handleSubscriptionCreated(client, dataObject);
  } else if (eventType === 'customer.subscription.updated') {
    return handleSubscriptionUpdated(client, dataObject, previousAttributes);
  } else if (eventType === 'customer.subscription.paused') {
    return handleSubscriptionPaused(client, dataObject);
  } else if (eventType === 'customer.subscription.resumed') {
    return handleSubscriptionResumed(client, dataObject);
  } else if (eventType === 'customer.subscription.deleted') {
    return handleSubscriptionDeleted(client, dataObject);
  } else if (eventType === 'charge.dispute.created') {
    return handleChargeDisputeCreated(client, dataObject);
  } else if (eventType === 'charge.dispute.closed') {
    return handleChargeDisputeClosed(client, dataObject);
  } else if (eventType === 'product.updated') {
    return handleProductUpdated(client, dataObject as StripeProductWithMarketingFeatures);
  } else if (eventType === 'product.created') {
    return handleProductCreated(client, dataObject as StripeProductWithMarketingFeatures);
  } else if (eventType === 'product.deleted') {
    return handleProductDeleted(client, dataObject);
  } else if (eventType === 'price.updated' || eventType === 'price.created') {
    return handlePriceChange(client, dataObject);
  } else if (eventType === 'price.deleted') {
    return handlePriceDeleted(client, dataObject as Stripe.Price);
  } else if (eventType === 'coupon.updated' || eventType === 'coupon.created') {
    const coupon = dataObject as Stripe.Coupon;
    if (coupon.id === 'FAMILY20' && coupon.percent_off) {
      updateFamilyDiscountPercent(coupon.percent_off);
      logger.info(`[Stripe Webhook] FAMILY20 coupon ${eventType}: ${coupon.percent_off}% off`);
    }
  } else if (eventType === 'coupon.deleted') {
    const coupon = dataObject as Stripe.Coupon;
    if (coupon.id === 'FAMILY20') {
      logger.info('[Stripe Webhook] FAMILY20 coupon deleted - will be recreated on next use');
    }
  } else if (eventType === 'credit_note.created') {
    return handleCreditNoteCreated(client, dataObject as Stripe.CreditNote);
  } else if (eventType === 'customer.updated') {
    return handleCustomerUpdated(client, dataObject as Stripe.Customer);
  } else if (eventType === 'customer.subscription.trial_will_end') {
    return handleTrialWillEnd(client, dataObject as Stripe.Subscription);
  } else if (eventType === 'payment_method.attached') {
    return handlePaymentMethodAttached(client, dataObject as Stripe.PaymentMethod);
  } else if (eventType === 'customer.created') {
    return handleCustomerCreated(client, dataObject as Stripe.Customer);
  } else if (eventType === 'customer.deleted') {
    return handleCustomerDeleted(client, dataObject as Stripe.Customer);
  } else if (eventType === 'payment_method.detached') {
    return handlePaymentMethodDetached(client, dataObject as Stripe.PaymentMethod);
  } else if (eventType === 'payment_method.updated') {
    return handlePaymentMethodUpdated(client, dataObject as Stripe.PaymentMethod);
  } else if (eventType === 'payment_method.automatically_updated') {
    return handlePaymentMethodAutoUpdated(client, dataObject as Stripe.PaymentMethod);
  } else if (eventType === 'charge.dispute.updated') {
    return handleChargeDisputeUpdated(client, dataObject as Stripe.Dispute);
  } else if (eventType === 'checkout.session.expired') {
    return handleCheckoutSessionExpired(client, dataObject as Stripe.Checkout.Session);
  } else if (eventType === 'checkout.session.async_payment_failed') {
    return handleCheckoutSessionAsyncPaymentFailed(client, dataObject as Stripe.Checkout.Session);
  } else if (eventType === 'checkout.session.async_payment_succeeded') {
    return handleCheckoutSessionAsyncPaymentSucceeded(client, dataObject as Stripe.Checkout.Session);
  } else if (eventType === 'invoice.payment_action_required') {
    return handleInvoicePaymentActionRequired(client, dataObject as InvoiceWithLegacyFields);
  } else if (eventType === 'invoice.overdue') {
    return handleInvoiceOverdue(client, dataObject as InvoiceWithLegacyFields);
  } else if (eventType === 'setup_intent.succeeded') {
    return handleSetupIntentSucceeded(client, dataObject as Stripe.SetupIntent);
  } else if (eventType === 'setup_intent.setup_failed') {
    return handleSetupIntentFailed(client, dataObject as Stripe.SetupIntent);
  }

  logger.warn(`[Stripe Webhook] Received unhandled event type: ${eventType} — consider adding a handler or removing this event from the Stripe webhook endpoint configuration`);
  return [];
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
  let event: Stripe.Event;
  try {
    event = JSON.parse(payloadString) as Stripe.Event;
  } catch (parseErr) {
    logger.error('[Stripe Webhook] Failed to parse payload JSON', {
      error: parseErr instanceof Error ? parseErr : new Error(String(parseErr)),
    });
    throw new Error('Invalid JSON payload');
  }

  const resourceId = extractResourceId(event);
  const client = await pool.connect();

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

    const deferredActions = await dispatchWebhookEvent(client, event.type, event.data.object, event.data.previous_attributes);

    await client.query('COMMIT');
    logger.info(`[Stripe Webhook] Event ${event.id} committed successfully`);

    await executeDeferredActions(deferredActions, { eventId: event.id, eventType: event.type });

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
    safeRelease(client);
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

    const deferredActions = await dispatchWebhookEvent(client, event.type, event.data.object, event.data.previous_attributes);

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
    safeRelease(client);
  }
}
