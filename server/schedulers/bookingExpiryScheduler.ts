import { schedulerTracker } from '../core/schedulerTracker';
import { queryWithRetry } from '../core/db';
import { getTodayPacific, getPacificHour, formatTimePacific, createPacificDate } from '../utils/dateUtils';
import { notifyAllStaff } from '../core/notificationService';
import { broadcastAvailabilityUpdate } from '../core/websocket';
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

    const trackmanLinked = await queryWithRetry<ExpiredBookingResult>(
      `UPDATE booking_requests 
       SET status = 'cancellation_pending',
           cancellation_pending_at = NOW(),
           staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto-expired: booking time passed — routed to cancellation_pending for Trackman cleanup]',
           updated_at = NOW(),
           reviewed_at = NOW(),
           reviewed_by = 'system-auto-expiry'
       WHERE status IN ('pending', 'pending_approval')
         AND trackman_booking_id IS NOT NULL
         AND (
           request_date < $1
           OR (request_date = $1 AND start_time < ($2::time - interval '20 minutes'))
         )
       RETURNING id, user_email AS "userEmail", user_name AS "userName", request_date AS "requestDate", start_time AS "startTime", resource_id AS "resourceId"`,
      [todayStr, currentTimePacific]
    );

    for (const booking of trackmanLinked.rows) {
      logger.info(
        `[Booking Expiry] Trackman-linked request #${booking.id} → cancellation_pending: ` +
        `${booking.userName || booking.userEmail} for ${booking.requestDate} ${booking.startTime}`
      );
      if (booking.resourceId) {
        broadcastAvailabilityUpdate({
          resourceId: booking.resourceId,
          date: booking.requestDate,
          action: 'updated'
        });
      }
    }

    const expiredBookings = await queryWithRetry<ExpiredBookingResult>(
      `UPDATE booking_requests 
       SET status = 'expired',
           staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto-expired: booking time passed without confirmation]',
           updated_at = NOW(),
           reviewed_at = NOW(),
           reviewed_by = 'system-auto-expiry'
       WHERE status IN ('pending', 'pending_approval')
         AND trackman_booking_id IS NULL
         AND (
           request_date < $1
           OR (request_date = $1 AND start_time < ($2::time - interval '20 minutes'))
         )
       RETURNING id, user_email AS "userEmail", user_name AS "userName", request_date AS "requestDate", start_time AS "startTime", resource_id AS "resourceId"`,
      [todayStr, currentTimePacific]
    );

    const trackmanCount = trackmanLinked.rows.length;
    const expiredCount = expiredBookings.rows.length;
    const totalCount = trackmanCount + expiredCount;

    if (totalCount === 0) {
      logger.info('[Booking Expiry] No stale pending bookings found');
      return;
    }

    for (const booking of expiredBookings.rows) {
      logger.info(
        `[Booking Expiry] Expired request #${booking.id}: ` +
        `${booking.userName || booking.userEmail} for ${booking.requestDate} ${booking.startTime}`
      );
      if (booking.resourceId) {
        broadcastAvailabilityUpdate({
          resourceId: booking.resourceId,
          date: booking.requestDate,
          action: 'cancelled'
        });
      }
    }

    logger.info(`[Booking Expiry] Processed ${totalCount} stale booking(s): ${expiredCount} expired, ${trackmanCount} → cancellation_pending`);
    schedulerTracker.recordRun('Booking Expiry', true);

    if (totalCount >= 2) {
      const allBookings = [...trackmanLinked.rows, ...expiredBookings.rows];
      const summary = allBookings
        .slice(0, 5)
        .map(b => `• ${b.userName || b.userEmail} - ${b.requestDate} ${b.startTime}`)
        .join('\n');
      
      const moreText = totalCount > 5 ? `\n...and ${totalCount - 5} more` : '';
      const trackmanNote = trackmanCount > 0 ? `\n\n⚠️ ${trackmanCount} booking(s) had Trackman links and were set to cancellation_pending for hardware cleanup.` : '';

      await notifyAllStaff(
        'Booking Requests Auto-Expired',
        `${totalCount} pending booking request(s) were auto-expired because their scheduled time passed without confirmation:\n\n${summary}${moreText}${trackmanNote}`,
        'system',
        { sendPush: false }
      );
    }

  } catch (error: unknown) {
    logger.error('[Booking Expiry] Error expiring stale bookings:', { error: error as Error });
    schedulerTracker.recordRun('Booking Expiry', false, String(error));
    logger.error('Failed to expire stale booking requests', { error: error as Error, extra: { context: 'booking_expiry_scheduler' } });
  }
}

let intervalId: NodeJS.Timeout | null = null;
let initialTimeoutId: NodeJS.Timeout | null = null;

export function startBookingExpiryScheduler(): void {
  if (intervalId) {
    logger.info('[Booking Expiry] Scheduler already running');
    return;
  }

  logger.info('[Startup] Booking expiry scheduler enabled (runs every hour)');

  intervalId = setInterval(() => {
    expireStaleBookingRequests().catch((err: unknown) => {
      logger.error('[Booking Expiry] Uncaught error:', { error: err as Error });
    });
  }, 60 * 60 * 1000);
  
  initialTimeoutId = setTimeout(() => {
    initialTimeoutId = null;
    expireStaleBookingRequests().catch((err: unknown) => {
      logger.error('[Booking Expiry] Initial run error:', { error: err as Error });
    });
  }, 60 * 1000);
}

export function stopBookingExpiryScheduler(): void {
  if (initialTimeoutId) {
    clearTimeout(initialTimeoutId);
    initialTimeoutId = null;
  }
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
     WHERE status IN ('pending', 'pending_approval')
       AND (
         request_date < $1
         OR (request_date = $1 AND start_time < ($2::time - interval '20 minutes'))
       )
     RETURNING id`,
    [todayStr, currentTimePacific]
  );
  
  const expiredCount = result.rows.length;
  logger.info(`[Booking Expiry] Manual run expired ${expiredCount} booking(s)`);
  
  return { expiredCount };
}
