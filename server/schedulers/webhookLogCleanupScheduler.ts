import { schedulerTracker } from '../core/schedulerTracker';
import { getPacificHour } from '../utils/dateUtils';

async function scheduleWebhookLogCleanup(): Promise<void> {
  try {
    const { cleanupOldWebhookLogs } = await import('../routes/trackman/index');
    await cleanupOldWebhookLogs();
    schedulerTracker.recordRun('Webhook Log Cleanup', true);
  } catch (err) {
    console.error('[Webhook Cleanup] Scheduler error:', err);
    schedulerTracker.recordRun('Webhook Log Cleanup', false, String(err));
  }
}

export function startWebhookLogCleanupScheduler(): void {
  setInterval(async () => {
    try {
      if (getPacificHour() === 4) {
        await scheduleWebhookLogCleanup();
      }
    } catch (err) {
      console.error('[Webhook Cleanup] Check error:', err);
    }
  }, 60 * 60 * 1000);
  
  console.log('[Startup] Webhook log cleanup scheduler enabled (runs daily at 4am Pacific, deletes logs older than 30 days)');
}
