import { schedulerTracker } from '../core/schedulerTracker';
import { getPacificHour } from '../utils/dateUtils';
import { logger } from '../core/logger';

async function scheduleWebhookLogCleanup(): Promise<void> {
  try {
    const { cleanupOldWebhookLogs } = await import('../routes/trackman/index');
    await cleanupOldWebhookLogs();
    schedulerTracker.recordRun('Webhook Log Cleanup', true);
  } catch (err: unknown) {
    logger.error('[Webhook Cleanup] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Webhook Log Cleanup', false, String(err));
  }
}

export function startWebhookLogCleanupScheduler(): NodeJS.Timeout {
  logger.info('[Startup] Webhook log cleanup scheduler enabled (runs daily at 4am Pacific, deletes logs older than 30 days)');
  return setInterval(async () => {
    try {
      if (getPacificHour() === 4) {
        await scheduleWebhookLogCleanup();
      }
    } catch (err: unknown) {
      logger.error('[Webhook Cleanup] Check error:', { error: err as Error });
    }
  }, 60 * 60 * 1000);
}
