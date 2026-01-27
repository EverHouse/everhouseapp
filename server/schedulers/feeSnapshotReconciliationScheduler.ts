import { pool } from '../core/db';
import { getStripeClient } from '../core/stripe';
import { PaymentStatusService } from '../core/billing/PaymentStatusService';

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
       AND bfs.created_at < NOW() - INTERVAL '${STALE_THRESHOLD_MINUTES} minutes'
       ORDER BY bfs.created_at ASC
       LIMIT 50`,
      []
    );
    
    if (staleSnapshots.rows.length === 0) {
      return { synced: 0, errors: 0 };
    }
    
    console.log(`[Fee Snapshot Reconciliation] Found ${staleSnapshots.rows.length} pending snapshots to check`);
    
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
            synced++;
          } else {
            console.error(`[Fee Snapshot Reconciliation] Failed to sync ${snapshot.stripe_payment_intent_id}:`, result.error);
            errors++;
          }
        } else if (pi.status === 'canceled') {
          // Payment was cancelled in Stripe - sync it
          await PaymentStatusService.markPaymentCancelled({
            paymentIntentId: snapshot.stripe_payment_intent_id
          });
          console.log(`[Fee Snapshot Reconciliation] Synced cancelled payment ${snapshot.stripe_payment_intent_id}`);
          synced++;
        }
        // For other statuses (requires_payment_method, etc.), leave as pending
        
      } catch (err: any) {
        if (err.code === 'resource_missing') {
          // Payment intent doesn't exist in Stripe - mark as cancelled
          await pool.query(
            `UPDATE booking_fee_snapshots SET status = 'cancelled' WHERE id = $1`,
            [snapshot.id]
          );
          console.log(`[Fee Snapshot Reconciliation] Marked orphan snapshot ${snapshot.id} as cancelled (PI not found)`);
          synced++;
        } else {
          console.error(`[Fee Snapshot Reconciliation] Error checking ${snapshot.stripe_payment_intent_id}:`, err.message);
          errors++;
        }
      }
    }
    
    return { synced, errors };
  } catch (error) {
    console.error('[Fee Snapshot Reconciliation] Scheduler error:', error);
    return { synced, errors: errors + 1 };
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startFeeSnapshotReconciliationScheduler(): void {
  if (intervalId) {
    console.log('[Fee Snapshot Reconciliation] Scheduler already running');
    return;
  }

  console.log(`[Startup] Fee snapshot reconciliation scheduler enabled (runs every 15 minutes)`);
  
  // Run first check after 2 minutes (give server time to start)
  setTimeout(() => {
    reconcilePendingSnapshots()
      .then(result => {
        if (result.synced > 0 || result.errors > 0) {
          console.log(`[Fee Snapshot Reconciliation] Initial run: synced=${result.synced}, errors=${result.errors}`);
        }
      })
      .catch(err => {
        console.error('[Fee Snapshot Reconciliation] Initial run error:', err);
      });
  }, 2 * 60 * 1000);
  
  intervalId = setInterval(() => {
    reconcilePendingSnapshots()
      .then(result => {
        if (result.synced > 0 || result.errors > 0) {
          console.log(`[Fee Snapshot Reconciliation] Run complete: synced=${result.synced}, errors=${result.errors}`);
        }
      })
      .catch(err => {
        console.error('[Fee Snapshot Reconciliation] Uncaught error:', err);
      });
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopFeeSnapshotReconciliationScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Fee Snapshot Reconciliation] Scheduler stopped');
  }
}
