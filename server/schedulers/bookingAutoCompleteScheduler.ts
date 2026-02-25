import { schedulerTracker } from '../core/schedulerTracker';
import { queryWithRetry } from '../core/db';
import { getTodayPacific, formatTimePacific } from '../utils/dateUtils';
import { notifyAllStaff } from '../core/notificationService';
import { ensureSessionForBooking } from '../core/bookingService/sessionManager';
import { logger } from '../core/logger';

interface AutoCompletedBookingResult {
  id: number;
  userEmail: string;
  userName: string | null;
  requestDate: string;
  startTime: string;
  endTime: string;
  resourceId: number | null;
  sessionId: number | null;
  trackmanBookingId: string | null;
}

async function autoCompletePastBookings(): Promise<void> {
  try {
    const now = new Date();
    const todayStr = getTodayPacific();
    const currentTimePacific = formatTimePacific(now);

    logger.info(`[Booking Auto-Complete] Running auto-complete check at ${todayStr} ${currentTimePacific}`);

    const markedBookings = await queryWithRetry<AutoCompletedBookingResult>(
      `UPDATE booking_requests 
       SET status = 'attended',
           staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto checked-in: booking time passed]',
           updated_at = NOW(),
           reviewed_at = NOW(),
           reviewed_by = 'system-auto-checkin'
       WHERE status IN ('approved', 'confirmed')
         AND status NOT IN ('attended', 'checked_in')
         AND is_relocating IS NOT TRUE
         AND (
           request_date < $1::date - INTERVAL '1 day'
           OR (request_date = $1::date - INTERVAL '1 day' AND end_time < $2::time)
         )
         AND id NOT IN (
           SELECT DISTINCT br.id FROM booking_requests br
           JOIN booking_sessions bs ON br.session_id = bs.id
           JOIN booking_participants bp ON bp.session_id = bs.id
           WHERE bs.updated_at > NOW() - INTERVAL '10 minutes'
           AND bp.payment_status IN ('paid', 'waived')
         )
       RETURNING id, user_email AS "userEmail", user_name AS "userName", request_date AS "requestDate", 
                 start_time AS "startTime", end_time AS "endTime", resource_id AS "resourceId",
                 session_id AS "sessionId", trackman_booking_id AS "trackmanBookingId"`,
      [todayStr, currentTimePacific]
    );

    const markedCount = markedBookings.rows.length;

    if (markedCount === 0) {
      logger.info('[Booking Auto-Complete] No past approved/confirmed bookings found');
      schedulerTracker.recordRun('Booking Auto-Complete', true);
      return;
    }

    let sessionsCreated = 0;
    let sessionErrors = 0;

    for (const booking of markedBookings.rows) {
      logger.info(
        `[Booking Auto-Complete] Auto checked-in request #${booking.id}: ` +
        `${booking.userName || booking.userEmail} for ${booking.requestDate} ${booking.startTime}`
      );

      if (!booking.sessionId && booking.resourceId) {
        try {
          const result = await ensureSessionForBooking({
            bookingId: booking.id,
            resourceId: booking.resourceId,
            sessionDate: typeof booking.requestDate === 'object' 
              ? (booking.requestDate as Date).toISOString().split('T')[0] 
              : String(booking.requestDate),
            startTime: booking.startTime,
            endTime: booking.endTime,
            ownerEmail: booking.userEmail,
            ownerName: booking.userName || undefined,
            trackmanBookingId: booking.trackmanBookingId || undefined,
            source: 'auto-complete',
            createdBy: 'system-auto-checkin'
          });
          if (result.created) {
            sessionsCreated++;
            logger.info(`[Booking Auto-Complete] Created session ${result.sessionId} for booking #${booking.id}`);
          } else {
            logger.info(`[Booking Auto-Complete] Linked existing session ${result.sessionId} to booking #${booking.id}`);
          }
        } catch (err) {
          sessionErrors++;
          logger.error(`[Booking Auto-Complete] Failed to create session for booking #${booking.id}:`, { error: err as Error });
        }
      }
    }

    if (sessionsCreated > 0 || sessionErrors > 0) {
      logger.info(`[Booking Auto-Complete] Session backfill: ${sessionsCreated} created, ${sessionErrors} errors`);
    }

    logger.info(`[Booking Auto-Complete] Auto checked-in ${markedCount} past booking(s)`);
    schedulerTracker.recordRun('Booking Auto-Complete', true);

    if (markedCount >= 2) {
      const summary = markedBookings.rows
        .slice(0, 5)
        .map(b => `• ${b.userName || b.userEmail} - ${b.requestDate} ${b.startTime}`)
        .join('\n');

      const moreText = markedCount > 5 ? `\n...and ${markedCount - 5} more` : '';

      await notifyAllStaff(
        'Bookings Auto Checked-In',
        `${markedCount} approved/confirmed booking(s) were auto checked-in because their scheduled time passed:\n\n${summary}${moreText}`,
        'system',
        { sendPush: false }
      );
    }

  } catch (error: unknown) {
    logger.error('[Booking Auto-Complete] Error auto-completing bookings:', { error: error as Error });
    schedulerTracker.recordRun('Booking Auto-Complete', false, String(error));
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startBookingAutoCompleteScheduler(): void {
  if (intervalId) {
    logger.info('[Booking Auto-Complete] Scheduler already running');
    return;
  }

  logger.info('[Startup] Booking auto-complete scheduler enabled (runs every 2 hours)');

  intervalId = setInterval(() => {
    autoCompletePastBookings().catch((err: unknown) => {
      logger.error('[Booking Auto-Complete] Uncaught error:', { error: err as Error });
    });
  }, 2 * 60 * 60 * 1000);

  setTimeout(() => {
    autoCompletePastBookings().catch((err: unknown) => {
      logger.error('[Booking Auto-Complete] Initial run error:', { error: err as Error });
    });
  }, 120000);
}

export function stopBookingAutoCompleteScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Booking Auto-Complete] Scheduler stopped');
  }
}

export async function runManualBookingAutoComplete(): Promise<{ markedCount: number; sessionsCreated: number }> {
  logger.info('[Booking Auto-Complete] Running manual auto-complete check...');

  const todayStr = getTodayPacific();
  const currentTimePacific = formatTimePacific(new Date());

  const result = await queryWithRetry<AutoCompletedBookingResult>(
    `UPDATE booking_requests 
     SET status = 'attended',
         staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto checked-in: booking time passed]',
         updated_at = NOW(),
         reviewed_at = NOW(),
         reviewed_by = 'system-auto-checkin'
     WHERE status IN ('approved', 'confirmed')
       AND status NOT IN ('attended', 'checked_in')
       AND is_relocating IS NOT TRUE
       AND (
         request_date < $1::date - INTERVAL '1 day'
         OR (request_date = $1::date - INTERVAL '1 day' AND end_time < $2::time)
       )
       AND id NOT IN (
         SELECT DISTINCT br.id FROM booking_requests br
         JOIN booking_sessions bs ON br.session_id = bs.id
         JOIN booking_participants bp ON bp.session_id = bs.id
         WHERE bs.updated_at > NOW() - INTERVAL '10 minutes'
         AND bp.payment_status IN ('paid', 'waived')
       )
     RETURNING id, user_email AS "userEmail", user_name AS "userName", request_date AS "requestDate",
               start_time AS "startTime", end_time AS "endTime", resource_id AS "resourceId",
               session_id AS "sessionId", trackman_booking_id AS "trackmanBookingId"`,
    [todayStr, currentTimePacific]
  );

  const markedCount = result.rows.length;
  let sessionsCreated = 0;

  for (const booking of result.rows) {
    if (!booking.sessionId && booking.resourceId) {
      try {
        const sessionResult = await ensureSessionForBooking({
          bookingId: booking.id,
          resourceId: booking.resourceId,
          sessionDate: typeof booking.requestDate === 'object'
            ? (booking.requestDate as Date).toISOString().split('T')[0]
            : String(booking.requestDate),
          startTime: booking.startTime,
          endTime: booking.endTime,
          ownerEmail: booking.userEmail,
          ownerName: booking.userName || undefined,
          trackmanBookingId: booking.trackmanBookingId || undefined,
          source: 'manual-auto-complete',
          createdBy: 'system-auto-checkin'
        });
        if (sessionResult.created) sessionsCreated++;
      } catch (err) {
        logger.error(`[Booking Auto-Complete] Manual: failed to create session for booking #${booking.id}:`, { error: err as Error });
      }
    }
  }

  logger.info(`[Booking Auto-Complete] Manual run auto checked-in ${markedCount} booking(s), created ${sessionsCreated} session(s)`);

  return { markedCount, sessionsCreated };
}
