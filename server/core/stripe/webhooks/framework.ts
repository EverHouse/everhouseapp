import Stripe from 'stripe';
import { db } from '../../../db';
import { sql, lt } from 'drizzle-orm';
import { webhookProcessedEvents } from '../../../../shared/models/system';
import { logger } from '../../logger';
import { getErrorMessage } from '../../../utils/errorUtils';
import type { PoolClient } from 'pg';
import type { DeferredAction, StripeEventObject, CacheTransactionParams } from './types';

const EVENT_DEDUP_WINDOW_DAYS = 7;

export function extractResourceId(event: Stripe.Event): string | null {
  const obj = event.data?.object as unknown as StripeEventObject | undefined;
  if (!obj || !obj.id) return null;
  
  if (event.type.startsWith('payment_intent.')) return obj.id;
  if (event.type.startsWith('invoice.')) return obj.id;
  if (event.type.startsWith('customer.subscription.')) return obj.id;
  if (event.type.startsWith('checkout.session.')) return obj.id;
  if (event.type.startsWith('charge.')) return obj.payment_intent || obj.id;
  if (event.type.startsWith('setup_intent.')) return obj.id;
  
  return null;
}

export async function tryClaimEvent(
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

export async function checkResourceEventOrder(
  client: PoolClient,
  resourceId: string,
  eventType: string,
  _eventTimestamp: number
): Promise<boolean> {
  const EVENT_PRIORITY: Record<string, number> = {
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
    'invoice.created': 1,
    'invoice.finalized': 2,
    'invoice.payment_action_required': 5,
    'invoice.payment_succeeded': 10,
    'invoice.payment_failed': 10,
    'invoice.paid': 11,
    'invoice.overdue': 15,
    'invoice.voided': 20,
    'invoice.marked_uncollectible': 20,
    'checkout.session.completed': 10,
    'checkout.session.expired': 20,
    'checkout.session.async_payment_succeeded': 15,
    'checkout.session.async_payment_failed': 15,
    'setup_intent.succeeded': 10,
    'setup_intent.setup_failed': 10,
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

export async function executeDeferredActions(actions: DeferredAction[], eventContext?: { eventId: string; eventType: string }): Promise<void> {
  let failedCount = 0;
  const failedIndices: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    try {
      await actions[i]();
    } catch (err: unknown) {
      failedCount++;
      failedIndices.push(i);
      logger.error(`[Stripe Webhook] Deferred action ${i + 1}/${actions.length} failed (non-critical):`, { 
        error: getErrorMessage(err),
        extra: eventContext ? { eventId: eventContext.eventId, eventType: eventContext.eventType } : undefined
      });
    }
  }
  if (failedCount > 0) {
    logger.warn(`[Stripe Webhook] ${failedCount}/${actions.length} deferred actions failed for event ${eventContext?.eventId || 'unknown'} (${eventContext?.eventType || 'unknown'})`);
    try {
      await db.execute(sql`
        INSERT INTO system_alerts (severity, category, message, details, created_at)
        VALUES (
          'critical',
          'deferred_action_failure',
          ${`${failedCount}/${actions.length} deferred actions failed after webhook commit for event ${eventContext?.eventId || 'unknown'} (${eventContext?.eventType || 'unknown'}). Side-effects (emails, HubSpot sync, notifications) may not have executed.`},
          ${JSON.stringify({ eventId: eventContext?.eventId, eventType: eventContext?.eventType, failedCount, totalCount: actions.length, failedIndices })}::text,
          NOW()
        )
        ON CONFLICT DO NOTHING
      `);
    } catch (alertErr: unknown) {
      logger.error('[Stripe Webhook] Failed to record deferred action failure alert:', { error: getErrorMessage(alertErr) });
    }
  }
}

export async function upsertTransactionCache(params: CacheTransactionParams): Promise<void> {
  try {
    if (params.customerId) {
      const known = await db.execute(
        sql`SELECT 1 FROM users WHERE stripe_customer_id = ${params.customerId} LIMIT 1`
      );
      if (known.rows.length === 0) {
        logger.debug('[Stripe Cache] Skipping cache for unknown customer', { extra: { customerId: params.customerId, stripeId: params.stripeId } });
        return;
      }
    }

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
    logger.error('[Stripe Cache] Error upserting transaction cache:', { error: getErrorMessage(err) });
  }
}

export async function cleanupOldProcessedEvents(): Promise<void> {
  try {
    const result = await db.delete(webhookProcessedEvents)
      .where(lt(webhookProcessedEvents.processedAt, sql`NOW() - INTERVAL '7 days'`))
      .returning({ id: webhookProcessedEvents.id });
    if (result.length > 0) {
      logger.info(`[Stripe Webhook] Cleaned up ${result.length} old processed events (>${EVENT_DEDUP_WINDOW_DAYS} days)`);
    }
  } catch (err: unknown) {
    logger.error('[Stripe Webhook] Error cleaning up old events:', { error: getErrorMessage(err) });
  }
}
