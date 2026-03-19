import { schedulerTracker } from '../core/schedulerTracker';
import { pool, safeRelease } from '../core/db';
import type { PoolClient } from 'pg';
import { getStripeClient, cancelPaymentIntent } from '../core/stripe';
import { PaymentStatusService } from '../core/billing/PaymentStatusService';
import { getErrorMessage, getErrorCode, isStripeResourceMissing } from '../utils/errorUtils';
import { logger } from '../core/logger';

const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const _STALE_THRESHOLD_MINUTES = 5;

async function connectWithTimeout(timeoutMs = 10000): Promise<PoolClient> {
  let released = false;
  const connectPromise = pool.connect();
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`DB connection timeout after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  try {
    const client = await Promise.race([connectPromise, timeoutPromise]) as PoolClient;
    clearTimeout(timeoutId!);
    await client.query('SET statement_timeout = 30000');
    return client;
  } catch (err) {
    clearTimeout(timeoutId!);
    connectPromise.then(c => {
      if (!released) {
        released = true;
        safeRelease(c);
      }
    }).catch((releaseErr: unknown) => { logger.warn('[FeeReconciliation] Failed to release connection on error', { extra: { error: getErrorMessage(releaseErr) } }); });
    throw err;
  }
}

async function reconcilePendingSnapshots(): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;
  
  try {
    let snapshotRows: Array<{ id: number; stripe_payment_intent_id: string; booking_id: number; session_id: number; total_cents: number }>;
    {
      const client = await connectWithTimeout();
      try {
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
        snapshotRows = staleSnapshots.rows;
      } finally {
        safeRelease(client);
      }
    }
    
    if (snapshotRows.length === 0) {
      return { synced: 0, errors: 0 };
    }
    
    logger.info(`[Fee Snapshot Reconciliation] Found ${snapshotRows.length} pending snapshots to check`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
    
    const stripe = await getStripeClient();
    
    for (const snapshot of snapshotRows) {
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
        if (isStripeResourceMissing(err)) {
          const updateClient = await connectWithTimeout();
          try {
            await updateClient.query(
              `UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
              [snapshot.id]
            );
          } finally {
            safeRelease(updateClient);
          }
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
  }
}

async function cancelAbandonedPaymentIntents(): Promise<{ cancelled: number; errors: number }> {
  let cancelled = 0;
  let errors = 0;

  try {
    let intentRows: Array<{ id: number; stripe_payment_intent_id: string; booking_id: number | null }>;
    {
      const client = await connectWithTimeout();
      try {
        const abandonedIntents = await client.query(
          `SELECT spi.id, spi.stripe_payment_intent_id, spi.booking_id
           FROM stripe_payment_intents spi
           WHERE spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')
           AND spi.created_at < NOW() - INTERVAL '2 hours'
           ORDER BY spi.created_at ASC
           LIMIT 30`,
          []
        );
        intentRows = abandonedIntents.rows;
      } finally {
        safeRelease(client);
      }
    }

    if (intentRows.length === 0) {
      return { cancelled: 0, errors: 0 };
    }

    logger.info(`[Abandoned PI Cleanup] Found ${intentRows.length} abandoned payment intents to cancel`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);

    const stripe = await getStripeClient();

    for (const spi of intentRows) {
      try {
        const cancelResult = await cancelPaymentIntent(spi.stripe_payment_intent_id);
        if (cancelResult.success) {
          logger.info(`[Abandoned PI Cleanup] Cancelled payment intent ${spi.stripe_payment_intent_id} in Stripe`);
        } else {
          const errMsg = cancelResult.error || '';
          if (errMsg.includes('No such PaymentIntent') || errMsg.includes('resource_missing')) {
            logger.info(`[Abandoned PI Cleanup] Payment intent ${spi.stripe_payment_intent_id} not found in Stripe, marking as cancelled`);
          } else {
            try {
              const pi = await stripe.paymentIntents.retrieve(spi.stripe_payment_intent_id);
              logger.info(`[Abandoned PI Cleanup] Payment intent ${spi.stripe_payment_intent_id} in state: ${pi.status}, syncing status`);
              
              const txClient = await connectWithTimeout();
              try {
                await txClient.query('BEGIN');
                try {
                  await txClient.query(
                    `UPDATE stripe_payment_intents SET status = $1, updated_at = NOW() WHERE id = $2`,
                    [pi.status, spi.id]
                  );
                  if (pi.status === 'succeeded') {
                    await txClient.query(
                      `UPDATE booking_fee_snapshots SET status = 'completed', updated_at = NOW() WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
                      [spi.stripe_payment_intent_id]
                    );
                    logger.info(`[Abandoned PI Cleanup] PI ${spi.stripe_payment_intent_id} succeeded — synced snapshot to completed`);
                  } else {
                    await txClient.query(
                      `UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
                      [spi.stripe_payment_intent_id]
                    );
                  }
                  await txClient.query('COMMIT');
                } catch (txErr: unknown) {
                  await txClient.query('ROLLBACK');
                  throw txErr;
                }
              } finally {
                safeRelease(txClient);
              }
              cancelled++;
              continue;
            } catch (retrieveErr: unknown) {
              logger.error(`[Abandoned PI Cleanup] Failed to retrieve PI status for ${spi.stripe_payment_intent_id}:`, { extra: { errorMessage: getErrorMessage(retrieveErr) } });
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, getErrorMessage(retrieveErr));
              errors++;
              continue;
            }
          }
        }

        {
          const txClient = await connectWithTimeout();
          try {
            await txClient.query('BEGIN');
            try {
              await txClient.query(
                `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = 'Auto-cancelled: abandoned after 2 hours', updated_at = NOW() WHERE id = $1`,
                [spi.id]
              );
              await txClient.query(
                `UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
                [spi.stripe_payment_intent_id]
              );
              await txClient.query('COMMIT');
            } catch (txErr: unknown) {
              await txClient.query('ROLLBACK');
              throw txErr;
            }
          } finally {
            safeRelease(txClient);
          }
        }

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
  }
}

async function reconcileStalePaymentIntents(): Promise<{ reconciled: number; errors: number }> {
  let reconciled = 0;
  let errors = 0;

  try {
    let intentRows: Array<{ id: number; stripe_payment_intent_id: string; booking_id: number | null; status: string }>;
    {
      const client = await connectWithTimeout();
      try {
        const staleIntents = await client.query(
          `SELECT spi.id, spi.stripe_payment_intent_id, spi.booking_id, spi.status
           FROM stripe_payment_intents spi
           WHERE spi.status = 'pending'
           AND spi.created_at < NOW() - INTERVAL '7 days'
           ORDER BY spi.created_at ASC
           LIMIT 20`,
          []
        );
        intentRows = staleIntents.rows;
      } finally {
        safeRelease(client);
      }
    }

    if (intentRows.length === 0) {
      return { reconciled: 0, errors: 0 };
    }

    logger.info(`[Payment Intent Reconciliation] Found ${intentRows.length} stale pending payment intents to check`);
    schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);

    const stripe = await getStripeClient();

    for (const spi of intentRows) {
      try {
        if (spi.booking_id == null) {
          const updateClient = await connectWithTimeout();
          try {
            await updateClient.query(
              `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
              ['Auto-reconciled: orphan payment intent with no linked booking', spi.id]
            );
          } finally {
            safeRelease(updateClient);
          }
          logger.info(`[Payment Intent Reconciliation] Canceled orphan payment intent ${spi.stripe_payment_intent_id} (no linked booking)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
          continue;
        }

        let bookingStatus: string | null = null;
        {
          const lookupClient = await connectWithTimeout();
          try {
            const bookingResult = await lookupClient.query(
              `SELECT status FROM booking_requests WHERE id = $1`,
              [spi.booking_id]
            );
            bookingStatus = bookingResult.rows.length > 0 ? bookingResult.rows[0].status : null;
          } finally {
            safeRelease(lookupClient);
          }
        }

        if (bookingStatus === null) {
          const updateClient = await connectWithTimeout();
          try {
            await updateClient.query(
              `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
              ['Auto-reconciled: orphan payment intent with no linked booking', spi.id]
            );
          } finally {
            safeRelease(updateClient);
          }
          logger.info(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (booking ${spi.booking_id} not found)`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
          continue;
        }

        if (['cancelled', 'declined', 'expired'].includes(bookingStatus)) {
          const updateClient = await connectWithTimeout();
          try {
            await updateClient.query(
              `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
              ['Auto-reconciled: linked booking was cancelled/declined/expired', spi.id]
            );
          } finally {
            safeRelease(updateClient);
          }
          logger.info(`[Payment Intent Reconciliation] Canceled payment intent ${spi.stripe_payment_intent_id} (booking ${spi.booking_id} status: ${bookingStatus})`);
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
          reconciled++;
        } else if (['attended', 'confirmed', 'approved'].includes(bookingStatus)) {
          try {
            const pi = await stripe.paymentIntents.retrieve(spi.stripe_payment_intent_id);

            if (pi.status === 'succeeded') {
              const updateClient = await connectWithTimeout();
              try {
                await updateClient.query(
                  `UPDATE stripe_payment_intents SET status = 'succeeded' WHERE id = $1`,
                  [spi.id]
                );
              } finally {
                safeRelease(updateClient);
              }
              logger.info(`[Payment Intent Reconciliation] Marked payment intent ${spi.stripe_payment_intent_id} as succeeded (confirmed by Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            } else if (pi.status === 'canceled') {
              const updateClient = await connectWithTimeout();
              try {
                await updateClient.query(
                  `UPDATE stripe_payment_intents SET status = 'canceled' WHERE id = $1`,
                  [spi.id]
                );
              } finally {
                safeRelease(updateClient);
              }
              logger.info(`[Payment Intent Reconciliation] Marked payment intent ${spi.stripe_payment_intent_id} as canceled (confirmed by Stripe)`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            } else if (['requires_payment_method', 'requires_action', 'requires_confirmation'].includes(pi.status)) {
              const txClient = await connectWithTimeout();
              try {
                await txClient.query('BEGIN');
                try {
                  await txClient.query(
                    `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1, updated_at = NOW() WHERE id = $2`,
                    [`Auto-reconciled: stale PI in ${pi.status} state for 7+ days`, spi.id]
                  );
                  await txClient.query(
                    `UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
                    [spi.stripe_payment_intent_id]
                  );
                  await txClient.query('COMMIT');
                } catch (txErr: unknown) {
                  await txClient.query('ROLLBACK');
                  throw txErr;
                }
              } finally {
                safeRelease(txClient);
              }
              const staleCancelResult = await cancelPaymentIntent(spi.stripe_payment_intent_id);
              if (!staleCancelResult.success) {
                logger.warn(`[Payment Intent Reconciliation] Could not cancel stale PI in Stripe (non-blocking)`, {
                  extra: { piId: spi.stripe_payment_intent_id, errorMessage: staleCancelResult.error }
                });
              }
              logger.info(`[Payment Intent Reconciliation] Reconciled stale ${pi.status} payment intent ${spi.stripe_payment_intent_id}`);
              schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
              reconciled++;
            }
          } catch (stripeErr: unknown) {
            if (isStripeResourceMissing(stripeErr)) {
              const updateClient = await connectWithTimeout();
              try {
                await updateClient.query(
                  `UPDATE stripe_payment_intents SET status = 'canceled', failure_reason = $1 WHERE id = $2`,
                  ['Auto-reconciled: payment intent not found in Stripe', spi.id]
                );
              } finally {
                safeRelease(updateClient);
              }
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
  }
}

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

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
    if (isRunning) {
      logger.info('[Fee Snapshot Reconciliation] Skipping initial run — previous run still in progress');
      return;
    }
    isRunning = true;

    Promise.allSettled([
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
      }),

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
      }),

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
      }),
    ])
      .then(results => {
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          for (const f of failed) {
            logger.error('[Fee Snapshot Reconciliation] Initial task failed:', { error: (f as PromiseRejectedResult).reason as Error });
          }
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, `${failed.length} initial task(s) failed`);
        } else {
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .finally(() => { isRunning = false; });
  }, 2 * 60 * 1000);
  
  intervalId = setInterval(() => {
    if (isRunning) {
      logger.info('[Fee Snapshot Reconciliation] Skipping run — previous run still in progress');
      return;
    }
    isRunning = true;

    Promise.allSettled([
      reconcilePendingSnapshots()
        .then(result => {
          if (result.synced > 0 || result.errors > 0) {
            logger.info(`[Fee Snapshot Reconciliation] Run complete: synced=${result.synced}, errors=${result.errors}`);
          }
        }),
      reconcileStalePaymentIntents()
        .then(result => {
          if (result.reconciled > 0 || result.errors > 0) {
            logger.info(`[Payment Intent Reconciliation] Run complete: reconciled=${result.reconciled}, errors=${result.errors}`);
          }
        }),
      cancelAbandonedPaymentIntents()
        .then(result => {
          if (result.cancelled > 0 || result.errors > 0) {
            logger.info(`[Abandoned PI Cleanup] Run complete: cancelled=${result.cancelled}, errors=${result.errors}`);
          }
        }),
    ])
      .then(results => {
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          for (const f of failed) {
            logger.error('[Fee Snapshot Reconciliation] Task failed:', { error: (f as PromiseRejectedResult).reason as Error });
          }
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', false, `${failed.length} task(s) failed`);
        } else {
          schedulerTracker.recordRun('Fee Snapshot Reconciliation', true);
        }
      })
      .finally(() => { isRunning = false; });
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
