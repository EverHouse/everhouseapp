import { schedulerTracker } from '../core/schedulerTracker';
import { getPacificHour } from '../utils/dateUtils';
import { logger } from '../core/logger';

let isRunning = false;

export function startSessionCleanupScheduler(): NodeJS.Timeout {
  logger.info('[Startup] Session cleanup scheduler enabled (runs daily at 2am Pacific)');
  return setInterval(async () => {
    if (isRunning) {
      logger.info('[Session Cleanup] Skipping run — previous run still in progress');
      return;
    }
    try {
      if (getPacificHour() === 2) {
        isRunning = true;
        const { runSessionCleanup } = await import('../core/sessionCleanup');
        await runSessionCleanup();
        schedulerTracker.recordRun('Session Cleanup', true);
      }
    } catch (err: unknown) {
      logger.error('[Session Cleanup] Scheduler error:', { error: err as Error });
      schedulerTracker.recordRun('Session Cleanup', false, String(err));
    } finally {
      isRunning = false;
    }
  }, 60 * 60 * 1000);
}
