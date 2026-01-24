import { pool } from '../core/db';
import { db } from '../db';
import { systemSettings } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { notifyAllStaff } from '../core/notificationService';
import { getPacificHour, getTodayPacific } from '../utils/dateUtils';

const UNRESOLVED_TRACKMAN_CHECK_HOUR = 9;
const UNRESOLVED_TRACKMAN_SETTING_KEY = 'last_unresolved_trackman_check_date';

async function tryClaimUnresolvedTrackmanSlot(todayStr: string): Promise<boolean> {
  try {
    const result = await db
      .insert(systemSettings)
      .values({
        key: UNRESOLVED_TRACKMAN_SETTING_KEY,
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
  } catch (err) {
    console.error('[Unresolved Trackman Check] Database error:', err);
    return false;
  }
}

async function checkUnresolvedTrackmanBookings(): Promise<void> {
  try {
    const currentHour = getPacificHour();
    const todayStr = getTodayPacific();
    
    if (currentHour === UNRESOLVED_TRACKMAN_CHECK_HOUR) {
      const claimed = await tryClaimUnresolvedTrackmanSlot(todayStr);
      
      if (claimed) {
        console.log('[Unresolved Trackman Check] Starting scheduled check...');
        
        try {
          const result = await pool.query(
            `SELECT created_at
             FROM booking_requests
             WHERE (origin = 'trackman_webhook' OR origin = 'trackman_import')
               AND user_id IS NULL
               AND (status = 'pending' OR status = 'unmatched')
               AND created_at < NOW() - INTERVAL '24 hours'
             ORDER BY created_at ASC`
          );
          
          const unresolved = result.rows;
          
          if (unresolved.length > 0) {
            const oldestDate = new Date(unresolved[0].created_at).toLocaleDateString('en-US', {
              timeZone: 'America/Los_Angeles',
              month: 'short',
              day: 'numeric',
              year: 'numeric'
            });
            
            const message = `Found ${unresolved.length} unresolved Trackman booking${unresolved.length !== 1 ? 's' : ''} older than 24 hours. Oldest: ${oldestDate}`;
            
            console.log(`[Unresolved Trackman Check] ${message}`);
            
            await notifyAllStaff(
              'Unresolved Trackman Bookings',
              message,
              'system',
              { sendPush: true }
            );
          } else {
            console.log('[Unresolved Trackman Check] No unresolved bookings found');
          }
        } catch (err) {
          console.error('[Unresolved Trackman Check] Check failed:', err);
        }
      }
    }
  } catch (err) {
    console.error('[Unresolved Trackman Check] Scheduler error:', err);
  }
}

export function startUnresolvedTrackmanScheduler(): void {
  setInterval(checkUnresolvedTrackmanBookings, 15 * 60 * 1000);
  console.log('[Startup] Unresolved Trackman check scheduler enabled (runs at 9am Pacific)');
}
