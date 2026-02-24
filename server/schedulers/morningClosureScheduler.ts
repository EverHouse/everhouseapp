import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { sendMorningClosureNotifications } from '../routes/push';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';

const MORNING_HOUR = 8;
const MORNING_SETTING_KEY = 'last_morning_closure_notification_date';

async function tryClaimMorningSlot(todayStr: string): Promise<boolean> {
  try {
    const result = await db
      .insert(systemSettings)
      .values({
        key: MORNING_SETTING_KEY,
        value: todayStr,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: todayStr,
          updatedAt: new Date(),
        },
        where: sql`${systemSettings.value} IS DISTINCT FROM ${todayStr}`,
      })
      .returning({ key: systemSettings.key });
    
    return result.length > 0;
  } catch (err: unknown) {
    logger.error('[Morning Closures] Database error:', { error: err as Error });
    schedulerTracker.recordRun('Morning Closure', false, String(err));
    return false;
  }
}

async function checkAndSendMorningNotifications(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour === MORNING_HOUR) {
      const claimed = await tryClaimMorningSlot(todayStr);
      
      if (claimed) {
        logger.info('[Morning Closures] Starting morning closure notifications...');
        
        try {
          const result = await sendMorningClosureNotifications();
          logger.info(`[Morning Closures] Completed: ${result.message}`);
          schedulerTracker.recordRun('Morning Closure', true);
        } catch (err: unknown) {
          logger.error('[Morning Closures] Send failed:', { error: err as Error });
          schedulerTracker.recordRun('Morning Closure', false, String(err));
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[Morning Closures] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Morning Closure', false, String(err));
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startMorningClosureScheduler(): void {
  if (intervalId) {
    logger.info('[Morning Closures] Scheduler already running');
    return;
  }

  intervalId = setInterval(checkAndSendMorningNotifications, 30 * 60 * 1000);
  logger.info('[Startup] Morning closure notification scheduler enabled (runs at 8am)');
}

export function stopMorningClosureScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Morning Closures] Scheduler stopped');
  }
}
