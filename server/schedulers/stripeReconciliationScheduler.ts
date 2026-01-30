import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { reconcileDailyPayments, reconcileSubscriptions } from '../core/stripe/reconciliation';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';

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
  } catch (err) {
    console.error('[Stripe Reconciliation] Database error:', err);
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
        console.log('[Stripe Reconciliation] Starting scheduled reconciliation...');
        
        try {
          const paymentResults = await reconcileDailyPayments();
          console.log('[Stripe Reconciliation] Payment reconciliation complete:', paymentResults);
          
          const subscriptionResults = await reconcileSubscriptions();
          console.log('[Stripe Reconciliation] Subscription reconciliation complete:', subscriptionResults);
        } catch (error) {
          console.error('[Stripe Reconciliation] Error running reconciliation:', error);
          
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
  } catch (error) {
    console.error('[Stripe Reconciliation] Scheduler error:', error);
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startStripeReconciliationScheduler(): void {
  if (intervalId) {
    console.log('[Stripe Reconciliation] Scheduler already running');
    return;
  }

  console.log(`[Startup] Stripe reconciliation scheduler enabled (runs at 5am Pacific)`);
  
  intervalId = setInterval(() => {
    checkAndRunReconciliation().catch(err => {
      console.error('[Stripe Reconciliation] Uncaught error:', err);
    });
  }, 60 * 60 * 1000);
}

export function stopStripeReconciliationScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Stripe Reconciliation] Scheduler stopped');
  }
}
