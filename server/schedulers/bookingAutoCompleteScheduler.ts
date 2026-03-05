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

    const stuckPendingPayments = await queryWithRetry<{ id: number; userEmail: string; userName: string | null; requestDate: string; startTime: string }>(
      `SELECT br.id, br.user_email AS "userEmail", br.user_name AS "userName", 
              br.request_date AS "requestDate", br.start_time AS "startTime"
       FROM booking_requests br
       WHERE br.status IN ('approved', 'confirmed')
         AND br.request_date < $1::date
         AND br.session_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM booking_participants bp
           WHERE bp.session_id = br.session_id
             AND bp.cached_fee_cents > 0
             AND bp.payment_status = 'pending'
         )`,
      [todayStr]
    );

    if (stuckPendingPayments.rows.length > 0) {
      const stuckSummary = stuckPendingPayments.rows
        .slice(0, 5)
        .map(b => `• #${b.id} ${b.userName || b.userEmail} - ${b.requestDate} ${b.startTime}`)
        .join('\n');
      const stuckMore = stuckPendingPayments.rows.length > 5 ? `\n...and ${stuckPendingPayments.rows.length - 5} more` : '';
      logger.warn(`[Booking Auto-Complete] ${stuckPendingPayments.rows.length} booking(s) stuck with unpaid fees, skipped auto-complete`);

      const stuckIds = stuckPendingPayments.rows.map(b => b.id).sort((a, b) => a - b).join(',');
      const recentDup = await queryWithRetry<{ id: number }>(
        `SELECT id FROM notifications
         WHERE title = 'Bookings Stuck — Unpaid Fees'
           AND created_at > NOW() - INTERVAL '6 hours'
         LIMIT 1`
      );

      if (recentDup.rows.length === 0) {
        await notifyAllStaff(
          'Bookings Stuck — Unpaid Fees',
          `${stuckPendingPayments.rows.length} past booking(s) cannot be auto checked-in because they have unpaid fees. Please collect payment or waive fees:\n\n${stuckSummary}${stuckMore}`,
          'system',
          { sendPush: false }
        );
      } else {
        logger.info(`[Booking Auto-Complete] Skipping duplicate stuck-fees notification — sent within last 6h (bookings: ${stuckIds})`);
      }
    }

    const markedBookings = await queryWithRetry<AutoCompletedBookingResult>(
      `UPDATE booking_requests 
       SET status = 'attended',
           staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto checked-in: booking time passed]',
           updated_at = NOW(),
           reviewed_at = NOW(),
           reviewed_by = 'system-auto-checkin'
       WHERE status IN ('approved', 'confirmed')
         AND status NOT IN ('attended', 'checked_in')
         AND (
           request_date < $1::date - INTERVAL '1 day'
           OR (
             request_date = $1::date - INTERVAL '1 day'
             AND CASE
               WHEN end_time IS NOT NULL AND end_time < start_time
                 THEN $2::time >= '00:30:00'::time AND end_time <= ($2::time - interval '30 minutes')
               WHEN end_time IS NOT NULL
                 THEN true
               ELSE true
             END
           )
           OR (
             request_date = $1::date
             AND end_time IS NOT NULL
             AND end_time >= start_time
             AND $2::time >= '00:30:00'::time
             AND end_time <= ($2::time - interval '30 minutes')
           )
         )
         AND (
           session_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM booking_participants bp
             WHERE bp.session_id = booking_requests.session_id
               AND bp.cached_fee_cents > 0
               AND bp.payment_status = 'pending'
           )
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
          if (result.error || result.sessionId === 0) {
            sessionErrors++;
            logger.error(`[Booking Auto-Complete] Session creation failed for booking #${booking.id}: ${result.error || 'sessionId=0'}`);
          } else if (result.created) {
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
let initialTimeoutId: NodeJS.Timeout | null = null;
let isRunning = false;

async function guardedAutoComplete(): Promise<void> {
  if (isRunning) {
    logger.info('[Booking Auto-Complete] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await autoCompletePastBookings();
  } finally {
    isRunning = false;
  }
}

export function startBookingAutoCompleteScheduler(): void {
  if (intervalId) {
    logger.info('[Booking Auto-Complete] Scheduler already running');
    return;
  }

  logger.info('[Startup] Booking auto-complete scheduler enabled (runs every 60 minutes)');

  intervalId = setInterval(() => {
    guardedAutoComplete().catch((err: unknown) => {
      logger.error('[Booking Auto-Complete] Uncaught error:', { error: err as Error });
    });
  }, 60 * 60 * 1000);

  initialTimeoutId = setTimeout(() => {
    initialTimeoutId = null;
    guardedAutoComplete().catch((err: unknown) => {
      logger.error('[Booking Auto-Complete] Initial run error:', { error: err as Error });
    });
  }, 30000);
}

export function stopBookingAutoCompleteScheduler(): void {
  if (initialTimeoutId) {
    clearTimeout(initialTimeoutId);
    initialTimeoutId = null;
  }
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
       AND (
         request_date < $1::date - INTERVAL '1 day'
         OR (
           request_date = $1::date - INTERVAL '1 day'
           AND CASE
             WHEN end_time IS NOT NULL AND end_time < start_time
               THEN $2::time >= '00:30:00'::time AND end_time <= ($2::time - interval '30 minutes')
             WHEN end_time IS NOT NULL
               THEN true
             ELSE true
           END
         )
         OR (
           request_date = $1::date
           AND end_time IS NOT NULL
           AND end_time >= start_time
           AND $2::time >= '00:30:00'::time
           AND end_time <= ($2::time - interval '30 minutes')
         )
       )
       AND (
         session_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM booking_participants bp
           WHERE bp.session_id = booking_requests.session_id
             AND bp.cached_fee_cents > 0
             AND bp.payment_status = 'pending'
         )
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
        if (sessionResult.error || sessionResult.sessionId === 0) {
          logger.error(`[Booking Auto-Complete] Manual: session creation failed for booking #${booking.id}: ${sessionResult.error || 'sessionId=0'}`);
        } else if (sessionResult.created) {
          sessionsCreated++;
        }
      } catch (err) {
        logger.error(`[Booking Auto-Complete] Manual: failed to create session for booking #${booking.id}:`, { error: err as Error });
      }
    }
  }

  logger.info(`[Booking Auto-Complete] Manual run auto checked-in ${markedCount} booking(s), created ${sessionsCreated} session(s)`);

  return { markedCount, sessionsCreated };
}
