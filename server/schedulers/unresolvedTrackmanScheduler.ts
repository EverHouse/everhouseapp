import { schedulerTracker } from '../core/schedulerTracker';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { queryWithRetry } from '../core/db';
import { notifyAllStaff } from '../core/notificationService';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';

const UNRESOLVED_TRACKMAN_CHECK_HOUR = 9;
const UNRESOLVED_TRACKMAN_SETTING_KEY = 'last_unresolved_trackman_check_date';

const STALE_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

async function tryClaimUnresolvedTrackmanSlot(todayStr: string): Promise<boolean> {
  try {
    const runningValue = `running:${todayStr}`;
    const completedValue = `completed:${todayStr}`;
    const staleThreshold = new Date(Date.now() - STALE_RUNNING_TIMEOUT_MS);
    const result = await db
      .insert(systemSettings)
      .values({
        key: UNRESOLVED_TRACKMAN_SETTING_KEY,
        value: runningValue,
        category: 'scheduler',
        updatedBy: 'system',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: runningValue,
          updatedAt: new Date(),
        },
        where: sql`${systemSettings.value} IS DISTINCT FROM ${completedValue} AND ${systemSettings.value} IS DISTINCT FROM ${todayStr} AND (${systemSettings.value} IS DISTINCT FROM ${runningValue} OR ${systemSettings.updatedAt} < ${staleThreshold})`,
      })
      .returning({ key: systemSettings.key });
    
    return result.length > 0;
  } catch (err: unknown) {
    logger.error('[Unresolved Trackman Check] Database error:', { error: err as Error });
    schedulerTracker.recordRun('Unresolved Trackman', false, String(err));
    return false;
  }
}

async function markTrackmanSlotCompleted(todayStr: string): Promise<void> {
  try {
    await db.update(systemSettings).set({ value: `completed:${todayStr}`, updatedAt: new Date() }).where(sql`${systemSettings.key} = ${UNRESOLVED_TRACKMAN_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Unresolved Trackman Check] Failed to mark slot as completed:', { error: err as Error });
  }
}

async function markTrackmanSlotFailed(todayStr: string): Promise<void> {
  try {
    await db.update(systemSettings).set({ value: `failed:${todayStr}`, updatedAt: new Date() }).where(sql`${systemSettings.key} = ${UNRESOLVED_TRACKMAN_SETTING_KEY}`);
  } catch (err: unknown) {
    logger.error('[Unresolved Trackman Check] Failed to mark slot as failed:', { error: err as Error });
  }
}

async function checkUnresolvedTrackmanBookings(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour === UNRESOLVED_TRACKMAN_CHECK_HOUR) {
      const claimed = await tryClaimUnresolvedTrackmanSlot(todayStr);
      
      if (claimed) {
        logger.info('[Unresolved Trackman Check] Starting scheduled check...');
        
        try {
          const result = await queryWithRetry(
            `SELECT created_at
             FROM booking_requests
             WHERE (origin = 'trackman_webhook' OR origin = 'trackman_import')
               AND user_id IS NULL
               AND (status = 'pending' OR status = 'unmatched')
               AND created_at < NOW() - INTERVAL '24 hours'
             ORDER BY created_at ASC`,
            [],
            3
          );
          
          const unresolved = result.rows;
          
          if (unresolved.length > 0) {
            const oldestDate = new Date(unresolved[0].created_at as string).toLocaleDateString('en-US', {
              timeZone: 'America/Los_Angeles',
              month: 'short',
              day: 'numeric',
              year: 'numeric'
            });
            
            const message = `Found ${unresolved.length} unresolved Trackman booking${unresolved.length !== 1 ? 's' : ''} older than 24 hours. Oldest: ${oldestDate}`;
            
            logger.info(`[Unresolved Trackman Check] ${message}`);
            
            await notifyAllStaff(
              'Unresolved Trackman Bookings',
              message,
              'trackman_unmatched',
              { sendPush: true, url: '/admin/trackman' }
            );
          } else {
            logger.info('[Unresolved Trackman Check] No unresolved bookings found');
          }
          await markTrackmanSlotCompleted(todayStr);
        } catch (err: unknown) {
          logger.error('[Unresolved Trackman Check] Check failed:', { error: err as Error });
          schedulerTracker.recordRun('Unresolved Trackman', false, String(err));
          await markTrackmanSlotFailed(todayStr);
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[Unresolved Trackman Check] Scheduler error:', { error: err as Error });
    schedulerTracker.recordRun('Unresolved Trackman', false, String(err));
  }
}

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function guardedCheckUnresolvedTrackmanBookings(): Promise<void> {
  if (isRunning) {
    logger.info('[Unresolved Trackman] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await checkUnresolvedTrackmanBookings();
  } finally {
    isRunning = false;
  }
}

export function startUnresolvedTrackmanScheduler(): void {
  if (intervalId) {
    logger.info('[Unresolved Trackman] Scheduler already running');
    return;
  }

  intervalId = setInterval(() => {
    guardedCheckUnresolvedTrackmanBookings().catch((err: unknown) => {
      logger.error('[Unresolved Trackman] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Unresolved Trackman', false, String(err));
    });
  }, 15 * 60 * 1000);
  logger.info('[Startup] Unresolved Trackman check scheduler enabled (runs at 9am Pacific)');
}

export function stopUnresolvedTrackmanScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Unresolved Trackman] Scheduler stopped');
  }
}
