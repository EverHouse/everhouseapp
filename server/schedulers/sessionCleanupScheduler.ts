import { schedulerTracker } from '../core/schedulerTracker';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

export function startSessionCleanupScheduler(): NodeJS.Timeout {
  stopSessionCleanupScheduler();
  logger.info('[Startup] Session cleanup scheduler enabled (runs daily at 2am Pacific)');
  intervalId = setInterval(async () => {
    if (isRunning) {
      logger.info('[Session Cleanup] Skipping run — previous run still in progress');
      return;
    }
    try {
      const currentHour = getPacificHour();
      const today = getTodayPacific();
      if (currentHour >= 2 && currentHour < 5 && lastRunDate !== today) {
        isRunning = true;
        lastRunDate = today;
        const { runSessionCleanup } = await import('../core/sessionCleanup');
        await runSessionCleanup();
        schedulerTracker.recordRun('Session Cleanup', true);
      }
    } catch (err: unknown) {
      logger.error('[Session Cleanup] Scheduler error:', { error: err as Error });
      schedulerTracker.recordRun('Session Cleanup', false, String(err));
      lastRunDate = null;
    } finally {
      isRunning = false;
    }
  }, 60 * 60 * 1000);
  return intervalId;
}

export function stopSessionCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
