import { schedulerTracker } from '../core/schedulerTracker';
import { queryWithRetry } from '../core/db';
import { getStripeClient } from '../core/stripe/client';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';

async function cleanupPendingUsers(): Promise<void> {
  try {
    const pendingUsers = await queryWithRetry(
      `SELECT id, email, stripe_customer_id, created_at
       FROM users
       WHERE membership_status = 'pending'
       AND billing_provider = 'stripe'
       AND created_at < NOW() - INTERVAL '48 hours'
       AND stripe_subscription_id IS NULL
       ORDER BY created_at ASC
       LIMIT 50`
    );

    if (pendingUsers.rows.length === 0) {
      logger.info('[Pending User Cleanup] No expired pending users found');
      schedulerTracker.recordRun('Pending User Cleanup', true);
      return;
    }

    logger.info(`[Pending User Cleanup] Found ${pendingUsers.rows.length} expired pending user(s) to clean up`);
    schedulerTracker.recordRun('Pending User Cleanup', true);

    let deleted = 0;
    let stripeCleanedUp = 0;
    let errors = 0;

    for (const user of pendingUsers.rows) {
      try {
        let stripeCleanupFailed = false;
        if (user.stripe_customer_id) {
          try {
            const stripe = await getStripeClient();

            const subscriptions = await stripe.subscriptions.list({
              customer: user.stripe_customer_id,
              limit: 100,
            });

            const cancellableStatuses = ['active', 'trialing', 'past_due', 'incomplete'];
            for (const sub of subscriptions.data) {
              if (cancellableStatuses.includes(sub.status)) {
                await stripe.subscriptions.cancel(sub.id);
                logger.info(`[Pending User Cleanup] Cancelled subscription ${sub.id} (status: ${sub.status}) for ${user.email}`);
              }
            }

            await stripe.customers.del(user.stripe_customer_id);
            logger.info(`[Pending User Cleanup] Deleted Stripe customer ${user.stripe_customer_id} for ${user.email}`);
            schedulerTracker.recordRun('Pending User Cleanup', true);
            stripeCleanedUp++;
          } catch (stripeErr: unknown) {
            stripeCleanupFailed = true;
            logger.error(`[Pending User Cleanup] Stripe cleanup failed for ${user.email} — skipping user deletion to avoid orphaned billing:`, { extra: { errorMessage: getErrorMessage(stripeErr) } });
            schedulerTracker.recordRun('Pending User Cleanup', false, String(stripeErr));
          }
        }

        if (stripeCleanupFailed) {
          errors++;
          continue;
        }

        await queryWithRetry('DELETE FROM users WHERE id = $1', [user.id]);
        deleted++;
        logger.info(`[Pending User Cleanup] Deleted pending user ${user.email} (id: ${user.id})`);
        schedulerTracker.recordRun('Pending User Cleanup', true);
      } catch (err: unknown) {
        errors++;
        logger.error(`[Pending User Cleanup] Error cleaning up user ${user.email}:`, { extra: { errorMessage: getErrorMessage(err) } });
        schedulerTracker.recordRun('Pending User Cleanup', false, String(err));
      }
    }

    logger.info(`[Pending User Cleanup] Summary: deleted=${deleted}, stripeCleanedUp=${stripeCleanedUp}, errors=${errors}`);
    schedulerTracker.recordRun('Pending User Cleanup', true);
  } catch (error) {
    logger.error('[Pending User Cleanup] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Pending User Cleanup', false, String(error));
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startPendingUserCleanupScheduler(): void {
  if (intervalId) {
    logger.info('[Pending User Cleanup] Scheduler already running');
    return;
  }

  logger.info('[Startup] Pending user cleanup scheduler enabled (runs every 6 hours)');

  intervalId = setInterval(() => {
    cleanupPendingUsers().catch(err => {
      logger.error('[Pending User Cleanup] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Pending User Cleanup', false, String(err));
    });
  }, 6 * 60 * 60 * 1000);

  setTimeout(() => {
    cleanupPendingUsers().catch(err => {
      logger.error('[Pending User Cleanup] Initial run error:', { error: err as Error });
      schedulerTracker.recordRun('Pending User Cleanup', false, String(err));
    });
  }, 60 * 1000);
}

export function stopPendingUserCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Pending User Cleanup] Scheduler stopped');
  }
}
