import { pool } from '../core/db';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';

const CLEANUP_HOUR = 4;
let lastCleanupDate = '';

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
    
    console.log(`[Duplicate Cleanup] Found ${idsToDelete.length} duplicate bookings to remove`);
    
    await client.query(
      `DELETE FROM booking_payment_audit WHERE booking_id = ANY($1)`,
      [idsToDelete]
    );
    await client.query(
      `DELETE FROM booking_fee_snapshots WHERE booking_id = ANY($1)`,
      [idsToDelete]
    );
    await client.query(
      `DELETE FROM booking_members WHERE booking_id = ANY($1)`,
      [idsToDelete]
    );
    await client.query(
      `DELETE FROM booking_requests WHERE id = ANY($1)`,
      [idsToDelete]
    );
    
    await client.query('COMMIT');
    
    console.log(`[Duplicate Cleanup] Successfully removed ${idsToDelete.length} duplicate bookings`);
    return { deletedCount: idsToDelete.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkAndRunCleanup(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour === CLEANUP_HOUR && lastCleanupDate !== todayStr) {
      lastCleanupDate = todayStr;
      console.log('[Duplicate Cleanup] Running scheduled cleanup...');
      const result = await cleanupDuplicateTrackmanBookings();
      if (result.deletedCount > 0) {
        console.log(`[Duplicate Cleanup] Completed: removed ${result.deletedCount} duplicates`);
      }
    }
  } catch (error) {
    console.error('[Duplicate Cleanup] Scheduler error:', error);
  }
}

export function startDuplicateCleanupScheduler(): void {
  console.log('[Startup] Duplicate cleanup scheduler enabled (runs at 4am Pacific and on startup)');
  
  setTimeout(async () => {
    try {
      console.log('[Duplicate Cleanup] Running startup cleanup check...');
      const result = await cleanupDuplicateTrackmanBookings();
      if (result.deletedCount > 0) {
        console.log(`[Duplicate Cleanup] Startup cleanup removed ${result.deletedCount} duplicates`);
      } else {
        console.log('[Duplicate Cleanup] No duplicates found');
      }
    } catch (error) {
      console.error('[Duplicate Cleanup] Startup cleanup error:', error);
    }
  }, 10000);
  
  setInterval(checkAndRunCleanup, 60 * 60 * 1000);
}

export { cleanupDuplicateTrackmanBookings };
