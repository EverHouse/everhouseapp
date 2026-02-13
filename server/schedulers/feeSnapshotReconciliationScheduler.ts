import { schedulerTracker } from '../core/schedulerTracker';
import { pool } from '../core/db';
import { getStripeClient } from '../core/stripe';
import { PaymentStatusService } from '../core/billing/PaymentStatusService';
import { getErrorMessage, getErrorCode } from '../utils/errorUtils';

const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const STALE_THRESHOLD_MINUTES = 5;

async function reconcilePendingSnapshots(): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;
  
  try {
    // Find pending fee snapshots older than 5 minutes with payment intents
    const staleSnapshots = await pool.query(
      `SELECT bfs.id, bfs.stripe_payment_intent_id, bfs.booking_id, bfs.session_id, bfs.total_cents
       FROM booking_fee_snapshots bfs
       WHERE bfs.status = 'pending'
       AND bfs.stripe_payment_intent_id IS NOT NULL
       AND bfs.created_at < NOW() - INTERVAL '5 minutes'
       ORDER BY bfs.created_at ASC
       LIMIT 50`,
      []
    );
    
    if (staleSnapshots.rows.length === 0) {
      return { synced: 0, errors: 0 };
    }
    
    console.log(`[Fee Snapshot Reconciliation] Found ${staleSnapshots.rows.length} pending snapshots to check`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
    
    const stripe = await getStripeClient();
    
    for (const snapshot of staleSnapshots.rows) {
      try {
        const pi = await stripe.paymentIntents.retrieve(snapshot.stripe_payment_intent_id);
        
        if (pi.status === 'succeeded') {
          // Payment succeeded but we didn't get the webhook - sync it
          const result = await PaymentStatusService.markPaymentSucceeded({
            paymentIntentId: snapshot.stripe_payment_intent_id,
            bookingId: snapshot.booking_id,
            sessionId: snapshot.session_id,
            staffEmail: 'system',
            staffName: 'Reconciliation'
          });
          
          if (result.success) {
            console.log(`[Fee Snapshot Reconciliation] Synced succeeded payment ${snapshot.stripe_payment_intent_id} for booking ${snapshot.booking_id}`);
            schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
            synced++;
          } else {
            console.error(`[Fee Snapshot Reconciliation] Failed to sync ${snapshot.stripe_payment_intent_id}:`, result.error);
            schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, result.error);
            errors++;
          }
        } else if (pi.status === 'canceled') {
          // Payment was cancelled in Stripe - sync it
          await PaymentStatusService.markPaymentCancelled({
            paymentIntentId: snapshot.stripe_payment_intent_id
          });
          console.log(`[Fee Snapshot Reconciliation] Synced cancelled payment ${snapshot.stripe_payment_intent_id}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          synced++;
        }
        // For other statuses (requires_payment_method, etc.), leave as pending
        
      } catch (err: unknown) {
        if (getErrorCode(err) === 'resource_missing') {
          await pool.query(
            `UPDATE booking_fee_snapshots SET status = 'cancelled' WHERE id = $1`,
            [snapshot.id]
          );
          console.log(`[Fee Snapshot Reconciliation] Marked orphan snapshot ${snapshot.id} as cancelled (PI not found)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          synced++;
        } else {
          console.error(`[Fee Snapshot Reconciliation] Error checking ${snapshot.stripe_payment_intent_id}:`, getErrorMessage(err));
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(err));
          errors++;
        }
      }
    }
    
    return { synced, errors };
  } catch (error) {
    console.error('[Fee Snapshot Reconciliation] Scheduler error:', error);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(error));
    return { synced, errors: errors + 1 };
  }
}

async function reconcileStalePaymentIntents(): Promise<{ reconciled: number; errors: number }> {
  let reconciled = 0;
  let errors = 0;

  try {
    const staleIntents = await pool.query(
      `SELECT spi.id, spi.stripe_payment_intent_id, spi.booking_id, spi.status
       FROM stripe_payment_intents spi
       WHERE spi.status = 'pending'
       AND spi.created_at < NOW() - INTERVAL '7 days'
       ORDER BY spi.created_at ASC
       LIMIT 20`,
      []
    );

    if (staleIntents.rows.length === 0) {
      return { reconciled: 0, errors: 0 };
    }

    console.log(`[Payment Intent Reconciliation] Found ${staleIntents.rows.length} stale pending payment intents to check`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);

    const stripe = await getStripeClient();

    for (const spi of staleIntents.rows) {
      try {
        if (spi.booking_id == null) {
          await pool.query(
            `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
            ['Auto-reconciled: orphan payment intent with no linked booking', spi.id]
          );
          console.log(`[Payment Intent Reconciliation] Canceled orphan payment intent ${spi.stripe_payment_intent_id} (no linked booking)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
          continue;
        }

        const bookingResult = await pool.query(
          `SELECT status FROM booking_requests WHERE id = $1`,
          [spi.booking_id]
        );

        if (bookingResult.rows.length === 0) {
          await pool.query(
            `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
            ['Auto-reconciled: orphan payment intent with no linked booking', spi.id]
          );
          console.log(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (booking ${spi.booking_id} not found)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
          continue;
        }

        const bookingStatus = bookingResult.rows[0].status;

        if (['cancelled', 'declined', 'expired'].includes(bookingStatus)) {
          await pool.query(
            `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
            ['Auto-reconciled: linked booking was cancelled/declined/expired', spi.id]
          );
          console.log(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (booking ${spi.booking_id} status: ${bookingStatus})`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
        } else if (['attended', 'confirmed'].includes(bookingStatus)) {
          try {
            const pi = await stripe.paymentIntents.retrieve(spi.stripe_payment_intent_id);

            if (pi.status === 'succeeded') {
              await pool.query(
                `UPDATE stripe_payment_intents SET status = 'succeeded' WHERE id = $1`,
                [spi.id]
              );
              console.log(`[Payment Intent Reconciliation] Marked payment intent ${spi.stripe_payment_intent_id} as succeeded (confirmed by Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            } else if (pi.status === 'canceled') {
              await pool.query(
                `UPDATE stripe_payment_intents SET status = 'canceled' WHERE id = $1`,
                [spi.id]
              );
              console.log(`[Payment Intent Reconciliation] Marked payment intent ${spi.stripe_payment_intent_id} as canceled (confirmed by Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            }
          } catch (stripeErr: unknown) {
            if (getErrorCode(stripeErr) === 'resource_missing') {
              await pool.query(
                `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
                ['Auto-reconciled: payment intent not found in Stripe', spi.id]
              );
              console.log(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (not found in Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            } else {
              console.error(`[Payment Intent Reconciliation] Stripe error for ${spi.stripe_payment_intent_id}:`, getErrorMessage(stripeErr));
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(stripeErr));
              errors++;
            }
          }
        }
      } catch (err: unknown) {
        console.error(`[Payment Intent Reconciliation] Error processing ${spi.stripe_payment_intent_id}:`, getErrorMessage(err));
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(err));
        errors++;
      }
    }

    return { reconciled, errors };
  } catch (error) {
    console.error('[Payment Intent Reconciliation] Scheduler error:', error);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(error));
    return { reconciled, errors: errors + 1 };
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startFeeSnapshotReconciliationScheduler(): void {
  if (intervalId) {
    console.log('[Fee Snapshot Reconciliation] Scheduler already running');
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
    return;
  }

  console.log(`[Startup] Fee snapshot reconciliation scheduler enabled (runs every 15 minutes)`);
  schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
  
  // Run first check after 2 minutes (give server time to start)
  setTimeout(() => {
    reconcilePendingSnapshots()
      .then(result => {
        if (result.synced > 0 || result.errors > 0) {
          console.log(`[Fee Snapshot Reconciliation] Initial run: synced=${result.synced}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch(err => {
        console.error('[Fee Snapshot Reconciliation] Initial run error:', err);
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });

    reconcileStalePaymentIntents()
      .then(result => {
        if (result.reconciled > 0 || result.errors > 0) {
          console.log(`[Payment Intent Reconciliation] Initial run: reconciled=${result.reconciled}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch(err => {
        console.error('[Payment Intent Reconciliation] Initial run error:', err);
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });
  }, 2 * 60 * 1000);
  
  intervalId = setInterval(() => {
    reconcilePendingSnapshots()
      .then(result => {
        if (result.synced > 0 || result.errors > 0) {
          console.log(`[Fee Snapshot Reconciliation] Run complete: synced=${result.synced}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch(err => {
        console.error('[Fee Snapshot Reconciliation] Uncaught error:', err);
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });

    reconcileStalePaymentIntents()
      .then(result => {
        if (result.reconciled > 0 || result.errors > 0) {
          console.log(`[Payment Intent Reconciliation] Run complete: reconciled=${result.reconciled}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch(err => {
        console.error('[Payment Intent Reconciliation] Uncaught error:', err);
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopFeeSnapshotReconciliationScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Fee Snapshot Reconciliation] Scheduler stopped');
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
  }
}
