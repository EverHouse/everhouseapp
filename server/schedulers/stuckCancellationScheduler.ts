import { schedulerTracker } from '../core/schedulerTracker';
import { queryWithRetry } from '../core/db';
import { notifyAllStaff } from '../core/notificationService';
import { logger } from '../core/logger';

interface StuckCancellationResult {
  id: number;
  user_email: string;
  user_name: string | null;
  request_date: string;
  start_time: string;
  cancellation_pending_at: string;
  resource_name: string | null;
}

async function checkStuckCancellations(): Promise<void> {
  try {
    const stuckBookings = await queryWithRetry<StuckCancellationResult>(
      `SELECT br.id, br.user_email, br.user_name, br.request_date, br.start_time, 
              br.cancellation_pending_at, r.name as resource_name
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.status = 'cancellation_pending'
       AND br.cancellation_pending_at < NOW() - INTERVAL '4 hours'
       ORDER BY br.cancellation_pending_at ASC`
    );

    if (stuckBookings.rows.length === 0) {
      logger.info('[Stuck Cancellations] No stuck cancellation pending bookings found');
      return;
    }

    logger.info(`[Stuck Cancellations] Found ${stuckBookings.rows.length} stuck cancellation(s)`);

    const recentlyAlerted = await queryWithRetry(
      `SELECT DISTINCT related_id FROM notifications 
       WHERE type = 'cancellation_stuck'
       AND related_type = 'booking_request'
       AND created_at > NOW() - INTERVAL '4 hours'
       AND related_id = ANY($1::int[])`,
      [stuckBookings.rows.map(b => b.id)]
    );
    
    const alreadyAlertedIds = new Set(recentlyAlerted.rows.map(r => r.related_id));
    const newStuckBookings = stuckBookings.rows.filter(b => !alreadyAlertedIds.has(b.id));
    
    if (newStuckBookings.length === 0) {
      logger.info('[Stuck Cancellations] All stuck bookings already alerted recently, skipping');
      return;
    }

    logger.info(`[Stuck Cancellations] ${newStuckBookings.length} new stuck cancellation(s) to alert`);

    // Build summary notification for staff
    const summary = newStuckBookings
      .slice(0, 10)
      .map((booking) => {
        const memberName = booking.user_name || booking.user_email || 'Unknown';
        const bookingDate = booking.request_date;
        const bookingTime = booking.start_time?.substring(0, 5) || '';
        const bayName = booking.resource_name || 'Simulator';
        const hoursStuck = Math.round((Date.now() - new Date(booking.cancellation_pending_at).getTime()) / (1000 * 60 * 60));
        
        return `• ${memberName} - ${bookingDate} at ${bookingTime} (${bayName}) - ${hoursStuck}+ hours stuck`;
      })
      .join('\n');

    const moreText = newStuckBookings.length > 10 ? `\n...and ${newStuckBookings.length - 10} more` : '';
    const message = `${newStuckBookings.length} booking(s) stuck in cancellation pending for 4+ hours. Please resolve in Trackman or complete manually:\n\n${summary}${moreText}`;

    await notifyAllStaff(
      'URGENT: Stuck Cancellation Pending Bookings',
      message,
      'cancellation_stuck',
      { sendPush: true }
    );

  } catch (error) {
    logger.error('[Stuck Cancellations] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('Stuck Cancellation', false, String(error));
    logger.error('Failed to check stuck cancellation bookings', { error: error as Error, extra: { context: 'stuck_cancellation_scheduler' } });
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startStuckCancellationScheduler(): void {
  if (intervalId) {
    logger.info('[Stuck Cancellations] Scheduler already running');
    return;
  }

  logger.info('[Startup] Stuck cancellation check scheduler enabled (runs every 2 hours)');

  intervalId = setInterval(() => {
    checkStuckCancellations().catch(err => {
      logger.error('[Stuck Cancellations] Uncaught error:', { error: err as Error });
      schedulerTracker.recordRun('Stuck Cancellation', false, String(err));
    });
  }, 2 * 60 * 60 * 1000);

  // Run initial check after 1 minute
  setTimeout(() => {
    checkStuckCancellations().catch(err => {
      logger.error('[Stuck Cancellations] Initial run error:', { error: err as Error });
      schedulerTracker.recordRun('Stuck Cancellation', false, String(err));
    });
  }, 60 * 1000);
}

export function stopStuckCancellationScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Stuck Cancellations] Scheduler stopped');
  }
}
