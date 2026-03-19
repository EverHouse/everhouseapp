import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { sendDailyReminders } from '../routes/push';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';
import { getSettingValue } from '../core/settingsHelper';

const DEFAULT_REMINDER_HOUR = 18;
const REMINDER_SETTING_KEY = 'last_daily_reminder_date';

const STALE_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

async function tryClaimReminderSlot(todayStr: string): Promise<boolean> {
  try {
    const runningValue = `running:${todayStr}`;
    const completedValue = `completed:${todayStr}`;
    const staleThreshold = new Date(Date.now() - STALE_RUNNING_TIMEOUT_MS);
    const result = await db
      .insert(systemSettings)
      .values({
        key: REMINDER_SETTING_KEY,
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
    logger.error('[Daily Reminders] Database error:', { error: err as Error });
    schedulerTracker.recordRun('Daily Reminder', false, String(err));
    return false;
  }
}

async function markReminderSlotCompleted(todayStr: string): Promise<void> {
  try {
    await db.update(systemSettings).set({ value: `completed:${todayStr}`, updatedAt: new Date() }).where(sql`${systemSettings.key} = ${REMINDER_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Daily Reminders] Failed to mark slot as completed:', { error: err as Error });
  }
}

async function markReminderSlotFailed(todayStr: string): Promise<void> {
  try {
    await db.update(systemSettings).set({ value: `failed:${todayStr}`, updatedAt: new Date() }).where(sql`${systemSettings.key} = ${REMINDER_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Daily Reminders] Failed to mark slot as failed:', { error: err as Error });
  }
}

async function checkAndSendReminders(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    const reminderHour = Number(await getSettingValue('scheduling.daily_reminder_hour', String(DEFAULT_REMINDER_HOUR)));
    if (currentHour >= reminderHour && currentHour < reminderHour + 2) {
      const claimed = await tryClaimReminderSlot(todayStr);
      
      if (claimed) {
        logger.info('[Daily Reminders] Starting scheduled reminder job...');
        
        try {
          const result = await sendDailyReminders();
          logger.info(`[Daily Reminders] Completed: ${result.message}`);
          schedulerTracker.recordRun('Daily Reminder', true);
          await markReminderSlotCompleted(todayStr);
        } catch (err: unknown) {
          logger.error('[Daily Reminders] Send failed:', { error: err as Error });
          schedulerTracker.recordRun('Daily Reminder', false, String(err));
          await markReminderSlotFailed(todayStr);
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[Daily Reminders] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Daily Reminder', false, String(err));
  }
}

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function guardedCheckAndSendReminders(): Promise<void> {
  if (isRunning) {
    logger.info('[Daily Reminders] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await checkAndSendReminders();
  } finally {
    isRunning = false;
  }
}

export function startDailyReminderScheduler(): void {
  if (intervalId) {
    logger.info('[Daily Reminders] Scheduler already running');
    return;
  }

  intervalId = setInterval(() => {
    guardedCheckAndSendReminders().catch((err: unknown) => {
      logger.error('[Daily Reminders] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Daily Reminder', false, String(err));
    });
  }, 30 * 60 * 1000);
  logger.info('[Startup] Daily reminder scheduler enabled (runs at 6pm)');
}

export function stopDailyReminderScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Daily Reminders] Scheduler stopped');
  }
}
