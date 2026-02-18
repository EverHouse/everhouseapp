import { schedulerTracker } from '../core/schedulerTracker';
import { getPacificHour } from '../utils/dateUtils';
import { logger } from '../core/logger';

export function startSessionCleanupScheduler(): void {
  setInterval(async () => {
    try {
      if (getPacificHour() === 2) {
        const { runSessionCleanup } = await import('../core/sessionCleanup');
        await runSessionCleanup();
        schedulerTracker.recordRun('Session Cleanup', true);
      }
    } catch (err) {
      logger.error('[Session Cleanup] Scheduler error:', { error: err as Error });
      schedulerTracker.recordRun('Session Cleanup', false, String(err));
    }
  }, 60 * 60 * 1000);
  
  logger.info('[Startup] Session cleanup scheduler enabled (runs daily at 2am Pacific)');
}
