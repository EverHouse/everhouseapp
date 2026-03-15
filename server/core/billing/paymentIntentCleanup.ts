import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { cancelPaymentIntent } from '../stripe';
import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { getStripeClient } from '../stripe/client';
import { markPaymentRefunded } from './PaymentStatusService';

export async function cancelPendingPaymentIntentsForBooking(bookingId: number, options?: { skipSnapshotUpdate?: boolean }): Promise<void> {
  try {
    const pendingIntents = await db.execute(
      sql`SELECT stripe_payment_intent_id 
       FROM stripe_payment_intents 
       WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')`
    );
    const piIdsFromSPI = new Set<string>();
    for (const row of pendingIntents.rows) {
      piIdsFromSPI.add(row.stripe_payment_intent_id as string);
    }

    const snapshotPIs = await db.execute(
      sql`SELECT stripe_payment_intent_id 
       FROM booking_fee_snapshots 
       WHERE booking_id = ${bookingId} AND stripe_payment_intent_id IS NOT NULL AND status IN ('pending', 'requires_action')`
    );
    for (const row of snapshotPIs.rows) {
      piIdsFromSPI.add(row.stripe_payment_intent_id as string);
    }

    const cancelledPiIds: string[] = [];
    for (const piId of piIdsFromSPI) {
      try {
        const result = await cancelPaymentIntent(piId);
        if (result.success) {
          cancelledPiIds.push(piId);
          logger.info(`Cancelled payment intent ${piId}`);
        } else {
          logger.warn(`Failed to cancel payment intent ${piId}: ${result.error}`);
        }
      } catch (cancelErr: unknown) {
        logger.warn(`Failed to cancel payment intent ${piId}: ${getErrorMessage(cancelErr)}`);
      }
    }

    if (!options?.skipSnapshotUpdate && cancelledPiIds.length > 0) {
      for (const piId of cancelledPiIds) {
        await db.execute(
          sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE stripe_payment_intent_id = ${piId} AND status IN ('pending', 'requires_action')`
        );
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
            const stripe = await getStripeClient();
            const balanceTxn = await stripe.customers.createBalanceTransaction(
              row.stripe_customer_id,
              {
                amount: -(row.amount_cents as number),
                currency: 'usd',
                description: `Refund for cancelled booking #${bookingId}`,
              },
              { idempotencyKey: `balance_refund_cleanup_${bookingId}_${row.stripe_payment_intent_id}` }
            );
            await markPaymentRefunded({
              paymentIntentId: row.stripe_payment_intent_id,
              refundId: balanceTxn.id,
              amountCents: row.amount_cents as number,
            });
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
          const stripe = await getStripeClient();
          const refundParams: { payment_intent: string; reason: 'requested_by_customer'; metadata: Record<string, string>; amount?: number } = {
            payment_intent: row.stripe_payment_intent_id,
            reason: 'requested_by_customer',
            metadata: {
              reason: 'booking_cancellation',
              bookingId: bookingId.toString(),
            },
          };
          if (row.amount_cents) {
            refundParams.amount = row.amount_cents as number;
          }
          const refund = await stripe.refunds.create(refundParams, { idempotencyKey });
          try {
            await markPaymentRefunded({
              paymentIntentId: row.stripe_payment_intent_id,
              refundId: refund.id,
              amountCents: row.amount_cents as number | undefined,
            });
          } catch (statusErr: unknown) {
            logger.warn('[PI Cleanup] Non-blocking: failed to mark payment refunded', { extra: { paymentIntentId: row.stripe_payment_intent_id, error: getErrorMessage(statusErr) } });
          }
        }

        refundCount++;
        logger.info('[PI Cleanup] Refund issued', {
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
