import { schedulerTracker } from '../core/schedulerTracker';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';
import { getErrorMessage } from '../utils/errorUtils';

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

async function scheduleWebhookLogCleanup(): Promise<void> {
  try {
    const { cleanupOldWebhookLogs } = await import('../routes/trackman/index');
    await cleanupOldWebhookLogs();
    schedulerTracker.recordRun('Webhook Log Cleanup', true);
  } catch (err: unknown) {
    logger.error('[Webhook Cleanup] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Webhook Log Cleanup', false, getErrorMessage(err));
    throw err;
  }
}

export function startWebhookLogCleanupScheduler(): NodeJS.Timeout {
  stopWebhookLogCleanupScheduler();
  logger.info('[Startup] Webhook log cleanup scheduler enabled (runs daily at 4am Pacific, deletes logs older than 30 days)');
  intervalId = setInterval(async () => {
    if (isRunning) {
      logger.info('[Webhook Cleanup] Skipping run — previous run still in progress');
      return;
    }
    try {
      const currentHour = getPacificHour();
      const today = getTodayPacific();
      if (currentHour >= 4 && currentHour < 7 && lastRunDate !== today) {
        isRunning = true;
        lastRunDate = today;
        await scheduleWebhookLogCleanup();
      }
    } catch (err: unknown) {
      logger.error('[Webhook Cleanup] Check error:', { error: err as Error });
      lastRunDate = null;
    } finally {
      isRunning = false;
    }
  }, 60 * 60 * 1000);
  return intervalId;
}

export function stopWebhookLogCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
