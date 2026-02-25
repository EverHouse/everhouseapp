import { schedulerTracker } from '../core/schedulerTracker';
import { pool } from '../core/db';
import type { PoolClient } from 'pg';
import { getStripeClient } from '../core/stripe';
import { PaymentStatusService } from '../core/billing/PaymentStatusService';
import { getErrorMessage, getErrorCode } from '../utils/errorUtils';
import { logger } from '../core/logger';

const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const STALE_THRESHOLD_MINUTES = 5;

async function reconcilePendingSnapshots(): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;
  
  let client: PoolClient | null = null;
  let released = false;
  try {
    const connectPromise = pool.connect();
    const connectTimeout = new Promise<never>((_, reject) => 
      setTimeout(() => {
        connectPromise.then(c => { released = true; c.release(); }).catch(() => {});
        reject(new Error('DB connection timeout after 10s'));
      }, 10000)
    );
    client = await Promise.race([connectPromise, connectTimeout]) as PoolClient;
    await client.query('SET statement_timeout = 30000');
    
    const staleSnapshots = await client.query(
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
    
    logger.info(`[Fee Snapshot Reconciliation] Found ${staleSnapshots.rows.length} pending snapshots to check`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
    
    const stripe = await getStripeClient();
    
    for (const snapshot of staleSnapshots.rows) {
      try {
        const pi = await stripe.paymentIntents.retrieve(snapshot.stripe_payment_intent_id);
        
        if (pi.status === 'succeeded') {
          const result = await PaymentStatusService.markPaymentSucceeded({
            paymentIntentId: snapshot.stripe_payment_intent_id,
            bookingId: snapshot.booking_id,
            sessionId: snapshot.session_id,
            staffEmail: 'system',
            staffName: 'Reconciliation'
          });
          
          if (result.success) {
            logger.info(`[Fee Snapshot Reconciliation] Synced succeeded payment ${snapshot.stripe_payment_intent_id} for booking ${snapshot.booking_id}`);
            schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
            synced++;
          } else {
            logger.error(`[Fee Snapshot Reconciliation] Failed to sync ${snapshot.stripe_payment_intent_id}:`, { extra: { error: result.error } });
            schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, result.error);
            errors++;
          }
        } else if (pi.status === 'canceled') {
          await PaymentStatusService.markPaymentCancelled({
            paymentIntentId: snapshot.stripe_payment_intent_id
          });
          logger.info(`[Fee Snapshot Reconciliation] Synced cancelled payment ${snapshot.stripe_payment_intent_id}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          synced++;
        }
        
      } catch (err: unknown) {
        if (getErrorCode(err) === 'resource_missing') {
          await client.query(
            `UPDATE booking_fee_snapshots SET status = 'cancelled' WHERE id = $1`,
            [snapshot.id]
          );
          logger.info(`[Fee Snapshot Reconciliation] Marked orphan snapshot ${snapshot.id} as cancelled (PI not found)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          synced++;
        } else {
          logger.error(`[Fee Snapshot Reconciliation] Error checking ${snapshot.stripe_payment_intent_id}:`, { extra: { errorMessage: getErrorMessage(err) } });
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(err));
          errors++;
        }
      }
    }
    
    return { synced, errors };
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    if (msg.includes('timeout')) {
      logger.warn('[Fee Snapshot Reconciliation] Skipped due to DB connection timeout — will retry next cycle');
    } else {
      logger.error('[Fee Snapshot Reconciliation] Scheduler error:', { error: error as Error });
    }
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(error));
    return { synced, errors: errors + 1 };
  } finally {
    if (client && !released) { try { client.release(); } catch {} }
  }
}

async function cancelAbandonedPaymentIntents(): Promise<{ cancelled: number; errors: number }> {
  let cancelled = 0;
  let errors = 0;

  let client: PoolClient | null = null;
  let released = false;
  try {
    const connectPromise = pool.connect();
    const connectTimeout = new Promise<never>((_, reject) => 
      setTimeout(() => {
        connectPromise.then(c => { released = true; c.release(); }).catch(() => {});
        reject(new Error('DB connection timeout after 10s'));
      }, 10000)
    );
    client = await Promise.race([connectPromise, connectTimeout]) as PoolClient;
    await client.query('SET statement_timeout = 30000');
    
    const abandonedIntents = await client.query(
      `SELECT spi.id, spi.stripe_payment_intent_id, spi.booking_id
       FROM stripe_payment_intents spi
       WHERE spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')
       AND spi.created_at < NOW() - INTERVAL '2 hours'
       ORDER BY spi.created_at ASC
       LIMIT 30`,
      []
    );

    if (abandonedIntents.rows.length === 0) {
      return { cancelled: 0, errors: 0 };
    }

    logger.info(`[Abandoned PI Cleanup] Found ${abandonedIntents.rows.length} abandoned payment intents to cancel`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);

    const stripe = await getStripeClient();

    for (const spi of abandonedIntents.rows) {
      try {
        try {
          await stripe.paymentIntents.cancel(spi.stripe_payment_intent_id);
          logger.info(`[Abandoned PI Cleanup] Cancelled payment intent ${spi.stripe_payment_intent_id} in Stripe`);
        } catch (stripeErr: unknown) {
          const errorCode = getErrorCode(stripeErr);
          
          if (errorCode === 'resource_missing') {
            logger.info(`[Abandoned PI Cleanup] Payment intent ${spi.stripe_payment_intent_id} not found in Stripe, marking as cancelled`);
          } else if (errorCode === 'payment_intent_unexpected_state') {
            try {
              const pi = await stripe.paymentIntents.retrieve(spi.stripe_payment_intent_id);
              logger.info(`[Abandoned PI Cleanup] Payment intent ${spi.stripe_payment_intent_id} already in state: ${pi.status}, syncing status`);
              
              await client.query('BEGIN');
              try {
                await client.query(
                  `UPDATE stripe_payment_intents SET status = $1, updated_at = NOW() WHERE id = $2`,
                  [pi.status, spi.id]
                );
                if (pi.status !== 'succeeded') {
                  await client.query(
                    `UPDATE booking_fee_snapshots SET status = 'cancelled' WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
                    [spi.stripe_payment_intent_id]
                  );
                }
                await client.query('COMMIT');
              } catch (txErr: unknown) {
                await client.query('ROLLBACK');
                throw txErr;
              }
              cancelled++;
              continue;
            } catch (retrieveErr: unknown) {
              logger.error(`[Abandoned PI Cleanup] Failed to retrieve PI status for ${spi.stripe_payment_intent_id}:`, { extra: { errorMessage: getErrorMessage(retrieveErr) } });
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(retrieveErr));
              errors++;
              continue;
            }
          } else {
            logger.error(`[Abandoned PI Cleanup] Stripe error cancelling ${spi.stripe_payment_intent_id}:`, { extra: { errorMessage: getErrorMessage(stripeErr) } });
            schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(stripeErr));
            errors++;
            continue;
          }
        }

        await client.query('BEGIN');
        try {
          await client.query(
            `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = 'Auto-cancelled: abandoned after 2 hours', updated_at = NOW() WHERE id = $1`,
            [spi.id]
          );
          await client.query(
            `UPDATE booking_fee_snapshots SET status = 'cancelled' WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
            [spi.stripe_payment_intent_id]
          );
          await client.query('COMMIT');
        } catch (txErr: unknown) {
          await client.query('ROLLBACK');
          throw txErr;
        }

        // Void associated booking invoice if it exists
        if (spi.booking_id) {
          try {
            const { voidBookingInvoice, recreateDraftInvoiceFromBooking } = await import('../core/billing/bookingInvoiceService');
            await voidBookingInvoice(spi.booking_id);
            await recreateDraftInvoiceFromBooking(spi.booking_id);
            logger.info(`[Abandoned PI Cleanup] Voided invoice and re-created draft for booking ${spi.booking_id}`);
          } catch (invoiceErr: unknown) {
            logger.warn(`[Abandoned PI Cleanup] Failed to void/recreate invoice for booking ${spi.booking_id}`, { extra: { error: String(invoiceErr) } });
          }
        }

        logger.info(`[Abandoned PI Cleanup] Cancelled and cleaned up payment intent ${spi.stripe_payment_intent_id}`);
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        cancelled++;
      } catch (err: unknown) {
        logger.error(`[Abandoned PI Cleanup] Error processing ${spi.stripe_payment_intent_id}:`, { extra: { errorMessage: getErrorMessage(err) } });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(err));
        errors++;
      }
    }

    return { cancelled, errors };
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    if (msg.includes('timeout')) {
      logger.warn('[Abandoned PI Cleanup] Skipped due to DB connection timeout — will retry next cycle');
    } else {
      logger.error('[Abandoned PI Cleanup] Scheduler error:', { error: error as Error });
    }
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(error));
    return { cancelled, errors: errors + 1 };
  } finally {
    if (client && !released) { try { client.release(); } catch {} }
  }
}

async function reconcileStalePaymentIntents(): Promise<{ reconciled: number; errors: number }> {
  let reconciled = 0;
  let errors = 0;

  let client: PoolClient | null = null;
  let released = false;
  try {
    const connectPromise = pool.connect();
    const connectTimeout = new Promise<never>((_, reject) => 
      setTimeout(() => {
        connectPromise.then(c => { released = true; c.release(); }).catch(() => {});
        reject(new Error('DB connection timeout after 10s'));
      }, 10000)
    );
    client = await Promise.race([connectPromise, connectTimeout]) as PoolClient;
    await client.query('SET statement_timeout = 30000');
    
    const staleIntents = await client.query(
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

    logger.info(`[Payment Intent Reconciliation] Found ${staleIntents.rows.length} stale pending payment intents to check`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);

    const stripe = await getStripeClient();

    for (const spi of staleIntents.rows) {
      try {
        if (spi.booking_id == null) {
          await client.query(
            `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
            ['Auto-reconciled: orphan payment intent with no linked booking', spi.id]
          );
          logger.info(`[Payment Intent Reconciliation] Canceled orphan payment intent ${spi.stripe_payment_intent_id} (no linked booking)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
          continue;
        }

        const bookingResult = await client.query(
          `SELECT status FROM booking_requests WHERE id = $1`,
          [spi.booking_id]
        );

        if (bookingResult.rows.length === 0) {
          await client.query(
            `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
            ['Auto-reconciled: orphan payment intent with no linked booking', spi.id]
          );
          logger.info(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (booking ${spi.booking_id} not found)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
          continue;
        }

        const bookingStatus = bookingResult.rows[0].status;

        if (['cancelled', 'declined', 'expired'].includes(bookingStatus)) {
          await client.query(
            `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
            ['Auto-reconciled: linked booking was cancelled/declined/expired', spi.id]
          );
          logger.info(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (booking ${spi.booking_id} status: ${bookingStatus})`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
        } else if (['attended', 'confirmed'].includes(bookingStatus)) {
          try {
            const pi = await stripe.paymentIntents.retrieve(spi.stripe_payment_intent_id);

            if (pi.status === 'succeeded') {
              await client.query(
                `UPDATE stripe_payment_intents SET status = 'succeeded' WHERE id = $1`,
                [spi.id]
              );
              logger.info(`[Payment Intent Reconciliation] Marked payment intent ${spi.stripe_payment_intent_id} as succeeded (confirmed by Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            } else if (pi.status === 'canceled') {
              await client.query(
                `UPDATE stripe_payment_intents SET status = 'canceled' WHERE id = $1`,
                [spi.id]
              );
              logger.info(`[Payment Intent Reconciliation] Marked payment intent ${spi.stripe_payment_intent_id} as canceled (confirmed by Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            }
          } catch (stripeErr: unknown) {
            if (getErrorCode(stripeErr) === 'resource_missing') {
              await client.query(
                `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
                ['Auto-reconciled: payment intent not found in Stripe', spi.id]
              );
              logger.info(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (not found in Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            } else {
              logger.error(`[Payment Intent Reconciliation] Stripe error for ${spi.stripe_payment_intent_id}:`, { extra: { errorMessage: getErrorMessage(stripeErr) } });
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(stripeErr));
              errors++;
            }
          }
        }
      } catch (err: unknown) {
        logger.error(`[Payment Intent Reconciliation] Error processing ${spi.stripe_payment_intent_id}:`, { extra: { errorMessage: getErrorMessage(err) } });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(err));
        errors++;
      }
    }

    return { reconciled, errors };
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    if (msg.includes('timeout')) {
      logger.warn('[Payment Intent Reconciliation] Skipped due to DB connection timeout — will retry next cycle');
    } else {
      logger.error('[Payment Intent Reconciliation] Scheduler error:', { error: error as Error });
    }
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(error));
    return { reconciled, errors: errors + 1 };
  } finally {
    if (client && !released) { try { client.release(); } catch {} }
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startFeeSnapshotReconciliationScheduler(): void {
  if (intervalId) {
    logger.info('[Fee Snapshot Reconciliation] Scheduler already running');
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
    return;
  }

  logger.info(`[Startup] Fee snapshot reconciliation scheduler enabled (runs every 15 minutes)`);
  schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
  
  // Run first check after 2 minutes (give server time to start)
  setTimeout(() => {
    reconcilePendingSnapshots()
      .then(result => {
        if (result.synced > 0 || result.errors > 0) {
          logger.info(`[Fee Snapshot Reconciliation] Initial run: synced=${result.synced}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch((err: unknown) => {
        logger.error('[Fee Snapshot Reconciliation] Initial run error:', { error: err as Error });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });

    reconcileStalePaymentIntents()
      .then(result => {
        if (result.reconciled > 0 || result.errors > 0) {
          logger.info(`[Payment Intent Reconciliation] Initial run: reconciled=${result.reconciled}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch((err: unknown) => {
        logger.error('[Payment Intent Reconciliation] Initial run error:', { error: err as Error });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });

    cancelAbandonedPaymentIntents()
      .then(result => {
        if (result.cancelled > 0 || result.errors > 0) {
          logger.info(`[Abandoned PI Cleanup] Initial run: cancelled=${result.cancelled}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch((err: unknown) => {
        logger.error('[Abandoned PI Cleanup] Initial run error:', { error: err as Error });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });
  }, 2 * 60 * 1000);
  
  intervalId = setInterval(() => {
    reconcilePendingSnapshots()
      .then(result => {
        if (result.synced > 0 || result.errors > 0) {
          logger.info(`[Fee Snapshot Reconciliation] Run complete: synced=${result.synced}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch((err: unknown) => {
        logger.error('[Fee Snapshot Reconciliation] Uncaught error:', { error: err as Error });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });

    reconcileStalePaymentIntents()
      .then(result => {
        if (result.reconciled > 0 || result.errors > 0) {
          logger.info(`[Payment Intent Reconciliation] Run complete: reconciled=${result.reconciled}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch((err: unknown) => {
        logger.error('[Payment Intent Reconciliation] Uncaught error:', { error: err as Error });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });

    cancelAbandonedPaymentIntents()
      .then(result => {
        if (result.cancelled > 0 || result.errors > 0) {
          logger.info(`[Abandoned PI Cleanup] Run complete: cancelled=${result.cancelled}, errors=${result.errors}`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .catch((err: unknown) => {
        logger.error('[Abandoned PI Cleanup] Uncaught error:', { error: err as Error });
        schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, String(err));
      });
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopFeeSnapshotReconciliationScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Fee Snapshot Reconciliation] Scheduler stopped');
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
  }
}
