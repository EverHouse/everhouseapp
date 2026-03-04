import Stripe from 'stripe';
import { getStripeSync, getStripeClient } from '../client';
import { updateFamilyDiscountPercent } from '../../billing/pricingConfig';
import { pool } from '../../db';
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
