import { schedulerTracker } from '../core/schedulerTracker';
import { queryWithRetry } from '../core/db';
import { getTodayPacific, getPacificHour, formatTimePacific, createPacificDate } from '../utils/dateUtils';
import { notifyAllStaff } from '../core/notificationService';
import { logger } from '../core/logger';

interface ExpiredBookingResult {
  id: number;
  userEmail: string;
  userName: string | null;
  requestDate: string;
  startTime: string;
  resourceId: number | null;
}

async function expireStaleBookingRequests(): Promise<void> {
  try {
    const now = new Date();
    const todayStr = getTodayPacific();
    const currentTimePacific = formatTimePacific(now);
    
    logger.info(`[Booking Expiry] Running stale booking check at ${todayStr} ${currentTimePacific}`);

    const expiredBookings = await queryWithRetry<ExpiredBookingResult>(
      `UPDATE booking_requests 
       SET status = 'expired',
           staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto-expired: booking time passed without confirmation]',
           updated_at = NOW(),
           reviewed_at = NOW(),
           reviewed_by = 'system-auto-expiry'
       WHERE status = 'pending'
         AND (
           request_date < $1
           OR (request_date = $1 AND start_time < $2)
         )
       RETURNING id, user_email, user_name, request_date, start_time, resource_id`,
      [todayStr, currentTimePacific]
    );

    const expiredCount = expiredBookings.rows.length;

    if (expiredCount === 0) {
      logger.info('[Booking Expiry] No stale pending bookings found');
      return;
    }

    for (const booking of expiredBookings.rows) {
      logger.info(
        `[Booking Expiry] Expired request #${booking.id}: ` +
        `${booking.userName || booking.userEmail} for ${booking.requestDate} ${booking.startTime}`
      );
    }

    logger.info(`[Booking Expiry] Auto-expired ${expiredCount} stale booking request(s)`);
    schedulerTracker.recordRun('Booking Expiry', true);

    if (expiredCount >= 2) {
      const summary = expiredBookings.rows
        .slice(0, 5)
        .map(b => `• ${b.userName || b.userEmail} - ${b.requestDate} ${b.startTime}`)
        .join('\n');
      
      const moreText = expiredCount > 5 ? `\n...and ${expiredCount - 5} more` : '';

      await notifyAllStaff(
        'Booking Requests Auto-Expired',
        `${expiredCount} pending booking request(s) were auto-expired because their scheduled time passed without confirmation:\n\n${summary}${moreText}`,
        'system',
        { sendPush: false }
      );
    }

  } catch (error) {
    logger.error('[Booking Expiry] Error expiring stale bookings:', { error: error as Error });
    schedulerTracker.recordRun('Booking Expiry', false, String(error));
    logger.error('Failed to expire stale booking requests', { error: error as Error, extra: { context: 'booking_expiry_scheduler' } });
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startBookingExpiryScheduler(): void {
  if (intervalId) {
    logger.info('[Booking Expiry] Scheduler already running');
    return;
  }

  logger.info('[Startup] Booking expiry scheduler enabled (runs every hour)');

  intervalId = setInterval(() => {
    expireStaleBookingRequests().catch(err => {
      logger.error('[Booking Expiry] Uncaught error:', { error: err as Error });
    });
  }, 60 * 60 * 1000);
  
  setTimeout(() => {
    expireStaleBookingRequests().catch(err => {
      logger.error('[Booking Expiry] Initial run error:', { error: err as Error });
    });
  }, 60 * 1000);
}

export function stopBookingExpiryScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Booking Expiry] Scheduler stopped');
  }
}

export async function runManualBookingExpiry(): Promise<{ expiredCount: number }> {
  logger.info('[Booking Expiry] Running manual expiry check...');
  
  const todayStr = getTodayPacific();
  const currentTimePacific = formatTimePacific(new Date());
  
  const result = await queryWithRetry(
    `UPDATE booking_requests 
     SET status = 'expired',
         staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto-expired: booking time passed without confirmation]',
         updated_at = NOW(),
         reviewed_at = NOW(),
         reviewed_by = 'system-manual-expiry'
     WHERE status = 'pending'
       AND (
         request_date < $1
         OR (request_date = $1 AND start_time < $2)
       )
     RETURNING id`,
    [todayStr, currentTimePacific]
  );
  
  const expiredCount = result.rows.length;
  logger.info(`[Booking Expiry] Manual run expired ${expiredCount} booking(s)`);
  
  return { expiredCount };
}
