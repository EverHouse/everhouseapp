import { schedulerTracker } from '../core/schedulerTracker';
import { queryWithRetry } from '../core/db';
import { getTodayPacific, formatTimePacific } from '../utils/dateUtils';
import { notifyAllStaff } from '../core/notificationService';
import { logger } from '../core/logger';

interface AutoCompletedBookingResult {
  id: number;
  userEmail: string;
  userName: string | null;
  requestDate: string;
  startTime: string;
  resourceId: number | null;
}

async function autoCompletePastBookings(): Promise<void> {
  try {
    const now = new Date();
    const todayStr = getTodayPacific();
    const currentTimePacific = formatTimePacific(now);

    logger.info(`[Booking Auto-Complete] Running auto-complete check at ${todayStr} ${currentTimePacific}`);

    const completedBookings = await queryWithRetry<AutoCompletedBookingResult>(
      `UPDATE booking_requests 
       SET status = 'completed',
           staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto-completed: booking time passed without check-in]',
           updated_at = NOW(),
           reviewed_at = NOW(),
           reviewed_by = 'system-auto-complete'
       WHERE status IN ('approved', 'confirmed')
         AND is_relocating IS NOT TRUE
         AND (
           request_date < $1::date - INTERVAL '1 day'
           OR (request_date = $1::date - INTERVAL '1 day' AND end_time < $2::time)
         )
       RETURNING id, user_email AS "userEmail", user_name AS "userName", request_date AS "requestDate", start_time AS "startTime", resource_id AS "resourceId"`,
      [todayStr, currentTimePacific]
    );

    const completedCount = completedBookings.rows.length;

    if (completedCount === 0) {
      logger.info('[Booking Auto-Complete] No past approved/confirmed bookings found');
      return;
    }

    for (const booking of completedBookings.rows) {
      logger.info(
        `[Booking Auto-Complete] Completed request #${booking.id}: ` +
        `${booking.userName || booking.userEmail} for ${booking.requestDate} ${booking.startTime}`
      );
    }

    logger.info(`[Booking Auto-Complete] Auto-completed ${completedCount} past booking(s)`);
    schedulerTracker.recordRun('Booking Auto-Complete', true);

    if (completedCount >= 2) {
      const summary = completedBookings.rows
        .slice(0, 5)
        .map(b => `• ${b.userName || b.userEmail} - ${b.requestDate} ${b.startTime}`)
        .join('\n');

      const moreText = completedCount > 5 ? `\n...and ${completedCount - 5} more` : '';

      await notifyAllStaff(
        'Bookings Auto-Completed',
        `${completedCount} approved/confirmed booking(s) were auto-completed because their scheduled time passed without check-in:\n\n${summary}${moreText}`,
        'system',
        { sendPush: false }
      );
    }

  } catch (error: unknown) {
    logger.error('[Booking Auto-Complete] Error auto-completing bookings:', { error: error as Error });
    schedulerTracker.recordRun('Booking Auto-Complete', false, String(error));
    logger.error('Failed to auto-complete past bookings', { error: error as Error, extra: { context: 'booking_auto_complete_scheduler' } });
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

export async function runManualBookingAutoComplete(): Promise<{ completedCount: number }> {
  logger.info('[Booking Auto-Complete] Running manual auto-complete check...');

  const todayStr = getTodayPacific();
  const currentTimePacific = formatTimePacific(new Date());

  const result = await queryWithRetry(
    `UPDATE booking_requests 
     SET status = 'completed',
         staff_notes = COALESCE(staff_notes || E'\n', '') || '[Auto-completed: booking time passed without check-in]',
         updated_at = NOW(),
         reviewed_at = NOW(),
         reviewed_by = 'system-auto-complete'
     WHERE status IN ('approved', 'confirmed')
       AND is_relocating IS NOT TRUE
       AND (
         request_date < $1::date - INTERVAL '1 day'
         OR (request_date = $1::date - INTERVAL '1 day' AND end_time < $2::time)
       )
     RETURNING id`,
    [todayStr, currentTimePacific]
  );

  const completedCount = result.rows.length;
  logger.info(`[Booking Auto-Complete] Manual run completed ${completedCount} booking(s)`);

  return { completedCount };
}
