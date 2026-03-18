import cron from 'node-cron';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../core/logger';
import { schedulerTracker } from '../core/schedulerTracker';
import { getSettingValue, isSchedulerEnabled } from '../core/settingsHelper';

let cronTask: cron.ScheduledTask | null = null;
let isRunning = false;

async function cleanupNotificationTables(): Promise<void> {
  const startTime = Date.now();
  try {
    const enabled = await isSchedulerEnabled('Notification_Cleanup');
    if (!enabled) {
      schedulerTracker.recordSkipped('Notification Cleanup');
      logger.info('[Notification Cleanup] Skipped — disabled via settings');
      return;
    }

    const retentionDaysStr = await getSettingValue('cleanup.notification_retention_days', '30');
    const retentionDays = Math.max(1, parseInt(retentionDaysStr, 10) || 30);

    const notificationsResult = await db.execute(
      sql`DELETE FROM notifications WHERE created_at < NOW() - CAST(${retentionDays + ' days'} AS INTERVAL)`
    );

    const pushSubscriptionsResult = await db.execute(
      sql`DELETE FROM push_subscriptions WHERE created_at < NOW() - CAST(${retentionDays + ' days'} AS INTERVAL)`
    );

    const dismissedNoticesResult = await db.execute(
      sql`DELETE FROM user_dismissed_notices WHERE dismissed_at < NOW() - CAST(${retentionDays + ' days'} AS INTERVAL)`
    );

    const durationMs = Date.now() - startTime;
    logger.info(`[Notification Cleanup] Completed in ${durationMs}ms — deleted ${notificationsResult.rowCount} notifications, ${pushSubscriptionsResult.rowCount} push subscriptions, ${dismissedNoticesResult.rowCount} dismissed notices (retention: ${retentionDays} days)`);
    schedulerTracker.recordRun('Notification Cleanup', true, undefined, durationMs);
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    logger.error('[Notification Cleanup] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Notification Cleanup', false, String(error), durationMs);
  }
}

async function guardedCleanup(): Promise<void> {
  if (isRunning) {
    logger.info('[Notification Cleanup] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await cleanupNotificationTables();
  } finally {
    isRunning = false;
  }
}

export function startNotificationCleanupScheduler(): void {
  if (cronTask) {
    logger.info('[Notification Cleanup] Scheduler already running');
    return;
  }

  logger.info('[Startup] Notification cleanup scheduler enabled (runs daily at midnight, configurable retention)');

  cronTask = cron.schedule('0 0 * * *', () => {
    guardedCleanup().catch((err: unknown) => {
      logger.error('[Notification Cleanup] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Notification Cleanup', false, String(err));
    });
  });
}

export function stopNotificationCleanupScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    logger.info('[Notification Cleanup] Scheduler stopped');
  }
}
