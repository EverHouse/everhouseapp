import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { reconcileDailyPayments, reconcileSubscriptions, reconcileDailyRefunds } from '../core/stripe/reconciliation';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';

const RECONCILIATION_HOUR = 5;
const RECONCILIATION_SETTING_KEY = 'last_stripe_reconciliation_date';

async function tryClaimReconciliationSlot(todayStr: string): Promise<boolean> {
  try {
    const result = await db
      .insert(systemSettings)
      .values({
        key: RECONCILIATION_SETTING_KEY,
        value: todayStr,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: todayStr,
          updatedAt: new Date(),
        },
        where: sql`${systemSettings.value} IS DISTINCT FROM ${todayStr}`,
      })
      .returning({ key: systemSettings.key });
    
    return result.length > 0;
  } catch (err: unknown) {
    logger.error('[Stripe Reconciliation] Database error:', { error: err as Error });
    schedulerTracker.recordRun('Stripe Reconciliation', false, String(err));
    return false;
  }
}

async function checkAndRunReconciliation(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour === RECONCILIATION_HOUR) {
      const claimed = await tryClaimReconciliationSlot(todayStr);
      
      if (claimed) {
        logger.info('[Stripe Reconciliation] Starting scheduled reconciliation...');
        schedulerTracker.recordRun('Stripe Reconciliation', true);
        
        try {
          const paymentResults = await reconcileDailyPayments();
          logger.info('[Stripe Reconciliation] Payment reconciliation complete:', { extra: { results: paymentResults } });
          schedulerTracker.recordRun('Stripe Reconciliation', true);
          
          const subscriptionResults = await reconcileSubscriptions();
          logger.info('[Stripe Reconciliation] Subscription reconciliation complete:', { extra: { results: subscriptionResults } });
          schedulerTracker.recordRun('Stripe Reconciliation', true);
          
          const refundResults = await reconcileDailyRefunds();
          logger.info('[Stripe Reconciliation] Refund reconciliation complete:', { extra: { results: refundResults } });
          schedulerTracker.recordRun('Stripe Reconciliation', true);
        } catch (error: unknown) {
          logger.error('[Stripe Reconciliation] Error running reconciliation:', { error: error as Error });
          schedulerTracker.recordRun('Stripe Reconciliation', false, String(error));
          
          // Alert staff so financial discrepancies don't go unnoticed
          const { alertOnScheduledTaskFailure } = await import('../core/dataAlerts');
          await alertOnScheduledTaskFailure(
            'Daily Stripe Reconciliation',
            error instanceof Error ? error : new Error(String(error)),
            { context: 'Scheduled reconciliation at 5am Pacific' }
          );
        }
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Reconciliation] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Stripe Reconciliation', false, String(error));
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startStripeReconciliationScheduler(): void {
  if (intervalId) {
    logger.info('[Stripe Reconciliation] Scheduler already running');
    schedulerTracker.recordRun('Stripe Reconciliation', true);
    return;
  }

  logger.info(`[Startup] Stripe reconciliation scheduler enabled (runs at 5am Pacific)`);
  schedulerTracker.recordRun('Stripe Reconciliation', true);
  
  intervalId = setInterval(() => {
    checkAndRunReconciliation().catch((err: unknown) => {
      logger.error('[Stripe Reconciliation] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Stripe Reconciliation', false, String(err));
    });
  }, 60 * 60 * 1000);
}

export function stopStripeReconciliationScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Stripe Reconciliation] Scheduler stopped');
    schedulerTracker.recordRun('Stripe Reconciliation', true);
  }
}
