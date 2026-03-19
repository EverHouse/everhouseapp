import { schedulerTracker } from '../core/schedulerTracker';
import { pool, safeRelease } from '../core/db';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';
import { logger } from '../core/logger';

const CLEANUP_HOUR = 4;
let lastCleanupDate = '';
let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function cleanupDuplicateTrackmanBookings(): Promise<{ deletedCount: number }> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const duplicateResult = await client.query(`
      WITH ranked AS (
        SELECT 
          id,
          trackman_booking_id,
          ROW_NUMBER() OVER (PARTITION BY trackman_booking_id ORDER BY created_at ASC) as rn
        FROM booking_requests
        WHERE trackman_booking_id IS NOT NULL
      )
      SELECT id, trackman_booking_id
      FROM ranked
      WHERE rn > 1
    `);
    
    const idsToDelete = duplicateResult.rows.map(r => r.id);
    
    if (idsToDelete.length === 0) {
      await client.query('COMMIT');
      return { deletedCount: 0 };
    }
    
    logger.info(`[Duplicate Cleanup] Found ${idsToDelete.length} duplicate bookings to remove`);
    
    await client.query(
      `DELETE FROM admin_audit_log WHERE resource_type = 'payment' AND resource_id = ANY(SELECT id::text FROM unnest($1::int[]) AS id)`,
      [idsToDelete]
    );
    await client.query(
      `DELETE FROM booking_fee_snapshots WHERE booking_id = ANY($1)`,
      [idsToDelete]
    );
    await client.query(
      `DELETE FROM booking_requests WHERE id = ANY($1)`,
      [idsToDelete]
    );
    
    await client.query('COMMIT');
    
    logger.info(`[Duplicate Cleanup] Successfully removed ${idsToDelete.length} duplicate bookings`);
    return { deletedCount: idsToDelete.length };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    safeRelease(client);
  }
}

async function checkAndRunCleanup(): Promise<void> {
  if (isRunning) {
    logger.info('[Duplicate Cleanup] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour >= CLEANUP_HOUR && currentHour < CLEANUP_HOUR + 3 && lastCleanupDate !== todayStr) {
      logger.info('[Duplicate Cleanup] Running scheduled cleanup...');
      const result = await cleanupDuplicateTrackmanBookings();
      lastCleanupDate = todayStr;
      if (result.deletedCount > 0) {
        logger.info(`[Duplicate Cleanup] Completed: removed ${result.deletedCount} duplicates`);
      }
      schedulerTracker.recordRun('Duplicate Cleanup', true);
    }
  } catch (error: unknown) {
    logger.error('[Duplicate Cleanup] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Duplicate Cleanup', false, String(error));
    lastCleanupDate = '';
  } finally {
    isRunning = false;
  }
}

export function startDuplicateCleanupScheduler(): NodeJS.Timeout {
  stopDuplicateCleanupScheduler();
  logger.info('[Startup] Duplicate cleanup scheduler enabled (startup-only — unique constraint prevents new duplicates)');
  
  setTimeout(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      logger.info('[Duplicate Cleanup] Running startup cleanup check...');
      const result = await cleanupDuplicateTrackmanBookings();
      if (result.deletedCount > 0) {
        logger.info(`[Duplicate Cleanup] Startup cleanup removed ${result.deletedCount} duplicates`);
        schedulerTracker.recordRun('Duplicate Cleanup', true);
      } else {
        logger.info('[Duplicate Cleanup] No duplicates found');
        schedulerTracker.recordRun('Duplicate Cleanup', true);
      }
    } catch (error: unknown) {
      logger.error('[Duplicate Cleanup] Startup cleanup error:', { error: error as Error });
      schedulerTracker.recordRun('Duplicate Cleanup', false, String(error));
    } finally {
      isRunning = false;
    }
  }, 30000);
  
  intervalId = setInterval(() => {
    checkAndRunCleanup().catch((err) => {
      logger.error('[Duplicate Cleanup] Uncaught error:', { error: err as Error });
    });
  }, 24 * 60 * 60 * 1000);
  return intervalId;
}

export function stopDuplicateCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export { cleanupDuplicateTrackmanBookings };
