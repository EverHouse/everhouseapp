import { schedulerTracker } from '../core/schedulerTracker';
import { getPacificDateParts } from '../utils/dateUtils';
import { logger } from '../core/logger';

const CLEANUP_DAY = 0;
const CLEANUP_HOUR = 3;
let lastCleanupWeek = -1;
let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function checkAndRunCleanup(): Promise<void> {
  if (isRunning) {
    logger.info('[Cleanup] Skipping weekly cleanup — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    const parts = getPacificDateParts();
    const pacificDate = new Date(parts.year, parts.month - 1, parts.day);
    const currentDay = pacificDate.getDay();
    const currentHour = parts.hour;
    const currentWeek = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    
    if (currentDay === CLEANUP_DAY && currentHour >= CLEANUP_HOUR && currentHour < CLEANUP_HOUR + 3 && currentWeek !== lastCleanupWeek) {
      logger.info('[Cleanup] Starting weekly cleanup...');
      
      const { runScheduledCleanup } = await import('../core/databaseCleanup');
      await runScheduledCleanup();
      
      const { runSessionCleanup } = await import('../core/sessionCleanup');
      await runSessionCleanup();
      
      lastCleanupWeek = currentWeek;
      logger.info('[Cleanup] Weekly cleanup completed');
      schedulerTracker.recordRun('Weekly Cleanup', true);
    }
  } catch (err: unknown) {
    logger.error('[Cleanup] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Weekly Cleanup', false, String(err));
  } finally {
    isRunning = false;
  }
}

export function startWeeklyCleanupScheduler(): NodeJS.Timeout {
  stopWeeklyCleanupScheduler();
  intervalId = setInterval(checkAndRunCleanup, 60 * 60 * 1000);
  logger.info('[Startup] Weekly cleanup scheduler enabled (runs Sundays at 3am)');
  return intervalId;
}

export function stopWeeklyCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
