import { schedulerTracker } from '../core/schedulerTracker';
import { clearStaleRelocations } from '../routes/bays/reschedule';
import { logger } from '../core/logger';

export function startRelocationCleanupScheduler(): NodeJS.Timeout {
  logger.info('[Startup] Relocation cleanup scheduler enabled (runs every 5 minutes)');
  return setInterval(async () => {
    try {
      await clearStaleRelocations();
    } catch (err: unknown) {
      logger.error('[Relocation Cleanup] Scheduler error:', { error: err as Error });
      schedulerTracker.recordRun('Relocation Cleanup', false, String(err));
    }
  }, 5 * 60 * 1000);
}
