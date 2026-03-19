import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { reconcileDailyPayments, reconcileSubscriptions, reconcileDailyRefunds } from '../core/stripe/reconciliation';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';
import { getErrorMessage } from '../utils/errorUtils';

const RECONCILIATION_HOUR = 5;
const RECONCILIATION_SETTING_KEY = 'last_stripe_reconciliation_date';

const STALE_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

async function tryClaimReconciliationSlot(todayStr: string): Promise<boolean> {
  try {
    const runningValue = `running:${todayStr}`;
    const completedValue = `completed:${todayStr}`;
    const staleThreshold = new Date(Date.now() - STALE_RUNNING_TIMEOUT_MS);
    const result = await db
      .insert(systemSettings)
      .values({
        key: RECONCILIATION_SETTING_KEY,
        value: runningValue,
        category: 'scheduler',
        updatedBy: 'system',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: runningValue,
          updatedAt: new Date(),
        },
        where: sql`${systemSettings.value} IS DISTINCT FROM ${completedValue} AND ${systemSettings.value} IS DISTINCT FROM ${todayStr} AND (${systemSettings.value} IS DISTINCT FROM ${runningValue} OR ${systemSettings.updatedAt} < ${staleThreshold})`,
      })
      .returning({ key: systemSettings.key });
    
    return result.length > 0;
  } catch (err: unknown) {
    logger.error('[Stripe Reconciliation] Database error:', { error: err as Error });
    schedulerTracker.recordRun('Stripe Reconciliation', false, getErrorMessage(err));
    return false;
  }
}

async function markReconciliationSlotCompleted(todayStr: string): Promise<void> {
  try {
    await db
      .update(systemSettings)
      .set({ value: `completed:${todayStr}`, updatedAt: new Date() })
      .where(sql`${systemSettings.key} = ${RECONCILIATION_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Stripe Reconciliation] Failed to mark slot as completed:', { error: err as Error });
  }
}

async function markReconciliationSlotFailed(todayStr: string): Promise<void> {
  try {
    await db
      .update(systemSettings)
      .set({ value: `failed:${todayStr}`, updatedAt: new Date() })
      .where(sql`${systemSettings.key} = ${RECONCILIATION_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Stripe Reconciliation] Failed to mark slot as failed:', { error: err as Error });
  }
}

async function checkAndRunReconciliation(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour >= RECONCILIATION_HOUR && currentHour < RECONCILIATION_HOUR + 2) {
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
          await markReconciliationSlotCompleted(todayStr);
        } catch (error: unknown) {
          logger.error('[Stripe Reconciliation] Error running reconciliation:', { error: error as Error });
          schedulerTracker.recordRun('Stripe Reconciliation', false, getErrorMessage(error));
          await markReconciliationSlotFailed(todayStr);
          
          const { alertOnScheduledTaskFailure } = await import('../core/dataAlerts');
          await alertOnScheduledTaskFailure(
            'Daily Stripe Reconciliation',
            error instanceof Error ? error : new Error(getErrorMessage(error)),
            { context: 'Scheduled reconciliation at 5am Pacific' }
          );
        }
      }
    }
  } catch (error: unknown) {
    logger.error('[Stripe Reconciliation] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Stripe Reconciliation', false, getErrorMessage(error));
  }
}

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function guardedCheckAndRunReconciliation(): Promise<void> {
  if (isRunning) {
    logger.info('[Stripe Reconciliation] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await checkAndRunReconciliation();
  } finally {
    isRunning = false;
  }
}

export function startStripeReconciliationScheduler(): void {
  if (intervalId) {
    logger.info('[Stripe Reconciliation] Scheduler already running');
    schedulerTracker.recordRun('Stripe Reconciliation', true);
    return;
  }

  logger.info(`[Startup] Stripe reconciliation scheduler enabled (runs at 5am Pacific)`);
  schedulerTracker.recordRun('Stripe Reconciliation', true);
  
  guardedCheckAndRunReconciliation().catch((err: unknown) => {
    logger.error('[Stripe Reconciliation] Initial check error:', { error: err as Error });
    schedulerTracker.recordRun('Stripe Reconciliation', false, getErrorMessage(err));
  });
  
  intervalId = setInterval(() => {
    guardedCheckAndRunReconciliation().catch((err: unknown) => {
      logger.error('[Stripe Reconciliation] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Stripe Reconciliation', false, getErrorMessage(err));
    });
  }, 5 * 60 * 1000);
}

export function stopStripeReconciliationScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Stripe Reconciliation] Scheduler stopped');
    schedulerTracker.recordRun('Stripe Reconciliation', true);
  }
}
