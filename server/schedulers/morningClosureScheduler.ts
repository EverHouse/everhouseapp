import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { sendMorningClosureNotifications } from '../routes/push';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';
import { getSettingValue } from '../core/settingsHelper';

const DEFAULT_MORNING_HOUR = 8;
const MORNING_SETTING_KEY = 'last_morning_closure_notification_date';

const STALE_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

async function tryClaimMorningSlot(todayStr: string): Promise<boolean> {
  try {
    const runningValue = `running:${todayStr}`;
    const completedValue = `completed:${todayStr}`;
    const staleThreshold = new Date(Date.now() - STALE_RUNNING_TIMEOUT_MS);
    const result = await db
      .insert(systemSettings)
      .values({
        key: MORNING_SETTING_KEY,
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
    logger.error('[Morning Closures] Database error:', { error: err as Error });
    schedulerTracker.recordRun('Morning Closure', false, String(err));
    return false;
  }
}

async function markMorningSlotCompleted(todayStr: string): Promise<void> {
  try {
    await db.update(systemSettings).set({ value: `completed:${todayStr}`, updatedAt: new Date() }).where(sql`${systemSettings.key} = ${MORNING_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Morning Closures] Failed to mark slot as completed:', { error: err as Error });
  }
}

async function markMorningSlotFailed(todayStr: string): Promise<void> {
  try {
    await db.update(systemSettings).set({ value: `failed:${todayStr}`, updatedAt: new Date() }).where(sql`${systemSettings.key} = ${MORNING_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Morning Closures] Failed to mark slot as failed:', { error: err as Error });
  }
}

async function checkAndSendMorningNotifications(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    const morningHour = Number(await getSettingValue('scheduling.morning_closure_hour', String(DEFAULT_MORNING_HOUR)));
    if (currentHour >= morningHour && currentHour < morningHour + 2) {
      const claimed = await tryClaimMorningSlot(todayStr);
      
      if (claimed) {
        logger.info('[Morning Closures] Starting morning closure notifications...');
        
        try {
          const result = await sendMorningClosureNotifications();
          logger.info(`[Morning Closures] Completed: ${result.message}`);
          schedulerTracker.recordRun('Morning Closure', true);
          await markMorningSlotCompleted(todayStr);
        } catch (err: unknown) {
          logger.error('[Morning Closures] Send failed:', { error: err as Error });
          schedulerTracker.recordRun('Morning Closure', false, String(err));
          await markMorningSlotFailed(todayStr);
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[Morning Closures] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Morning Closure', false, String(err));
  }
}

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function guardedCheckAndSendMorningNotifications(): Promise<void> {
  if (isRunning) {
    logger.info('[Morning Closures] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await checkAndSendMorningNotifications();
  } finally {
    isRunning = false;
  }
}

export function startMorningClosureScheduler(): void {
  if (intervalId) {
    logger.info('[Morning Closures] Scheduler already running');
    return;
  }

  intervalId = setInterval(() => {
    guardedCheckAndSendMorningNotifications().catch((err: unknown) => {
      logger.error('[Morning Closures] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Morning Closure', false, String(err));
    });
  }, 30 * 60 * 1000);
  logger.info('[Startup] Morning closure notification scheduler enabled (runs at 8am)');
}

export function stopMorningClosureScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Morning Closures] Scheduler stopped');
  }
}
