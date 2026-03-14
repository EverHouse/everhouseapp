import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { cancelPaymentIntent } from '../stripe';
import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { queueJob } from '../jobQueue';

export async function cancelPendingPaymentIntentsForBooking(bookingId: number): Promise<void> {
  try {
    const pendingIntents = await db.execute(
      sql`SELECT stripe_payment_intent_id 
       FROM stripe_payment_intents 
       WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')`
    );
    for (const row of pendingIntents.rows) {
      try {
        await cancelPaymentIntent(row.stripe_payment_intent_id as string);
        logger.info(`Cancelled payment intent ${row.stripe_payment_intent_id}`);
      } catch (cancelErr: unknown) {
        logger.warn(`Failed to cancel payment intent ${row.stripe_payment_intent_id}: ${getErrorMessage(cancelErr)}`);
      }
    }
  } catch (e: unknown) {
    logger.warn('[Payment Intent Cleanup] Non-critical cleanup failed:', { error: e });
  }
}

export async function refundSucceededPaymentIntentsForBooking(bookingId: number): Promise<number> {
  let refundCount = 0;
  try {
    const succeededIntents = await db.execute(sql`SELECT stripe_payment_intent_id, amount_cents, stripe_customer_id
       FROM stripe_payment_intents
       WHERE booking_id = ${bookingId} AND status = 'succeeded'`);

    for (const row of succeededIntents.rows as unknown as { stripe_payment_intent_id: string; amount_cents: number | null; stripe_customer_id: string | null }[]) {
      const claimResult = await db.execute(sql`UPDATE stripe_payment_intents 
           SET status = 'refunding', updated_at = NOW() 
           WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id} AND status = 'succeeded'
           RETURNING stripe_payment_intent_id`);

      if ((claimResult as unknown as { rowCount: number }).rowCount === 0) {
        logger.info('[PI Cleanup] Payment already claimed or refunded, skipping', {
          extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
        });
        continue;
      }

      try {
        if (row.stripe_payment_intent_id.startsWith('balance-')) {
          if (row.stripe_customer_id) {
            await queueJob('stripe_balance_refund', {
              stripeCustomerId: row.stripe_customer_id,
              amountCents: row.amount_cents as number,
              description: `Refund for cancelled booking #${bookingId}`,
              balanceRecordId: row.stripe_payment_intent_id,
              bookingId,
              idempotencyKey: `balance_refund_cleanup_${bookingId}_${row.stripe_payment_intent_id}`,
            }, { maxRetries: 5 });
          } else {
            await db.execute(sql`UPDATE stripe_payment_intents 
               SET status = 'succeeded', updated_at = NOW() 
               WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id} AND status = 'refunding'`);
            logger.warn('[PI Cleanup] Cannot refund balance - no customer ID, reverted to succeeded', {
              extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
            });
            continue;
          }
        } else {
          const idempotencyKey = `refund-booking-${bookingId}-${row.stripe_payment_intent_id}`;
          await queueJob('stripe_auto_refund', {
            paymentIntentId: row.stripe_payment_intent_id,
            reason: 'requested_by_customer',
            metadata: {
              reason: 'booking_cancellation',
              bookingId: bookingId.toString(),
            },
            amountCents: row.amount_cents || undefined,
            idempotencyKey,
          }, { maxRetries: 5 });
        }

        refundCount++;
        logger.info('[PI Cleanup] Queued payment refund', {
          extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id, amountCents: row.amount_cents }
        });
      } catch (refundErr: unknown) {
        await db.execute(sql`UPDATE stripe_payment_intents 
           SET status = 'succeeded', updated_at = NOW() 
           WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id} AND status = 'refunding'`);
        logger.warn('[PI Cleanup] Failed to queue refund, reverted status', {
          extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id, error: getErrorMessage(refundErr) }
        });
      }
    }
  } catch (e: unknown) {
    logger.warn('[PI Cleanup] Non-critical refund cleanup failed:', { error: e });
  }
  return refundCount;
}
