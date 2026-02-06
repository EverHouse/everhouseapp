import { Router } from 'express';
import { pool } from '../../core/db';
import { isStaffOrAdmin } from '../../core/middleware';
import { logFromRequest } from '../../core/auditLog';
import { logger } from '../../core/logger';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { getStripeClient } from '../../core/stripe/client';
import { broadcastAvailabilityUpdate } from '../../core/websocket';
import { sendPushNotification } from '../push';
import { formatTime12Hour } from '../../utils/dateUtils';

const router = Router();

router.post('/api/admin/booking/:id/reschedule/start', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const result = await pool.query(
      `SELECT br.id, br.user_email, br.user_name, br.status, br.resource_id,
              br.request_date, br.start_time, br.end_time, br.duration_minutes,
              br.notes, br.staff_notes, br.trackman_booking_id, br.is_relocating,
              br.declared_player_count, br.guest_count, br.session_id,
              r.name as resource_name
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.id = $1`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = result.rows[0];

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot reschedule a cancelled booking' });
    }

    const now = new Date();
    const pacificDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const pacificTimeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' });

    const bookingDate = booking.request_date;
    const bookingStartTime = booking.start_time;

    if (bookingDate < pacificDateStr || (bookingDate === pacificDateStr && bookingStartTime < pacificTimeStr)) {
      return res.status(400).json({ error: 'Cannot reschedule a booking that has already started or is in the past' });
    }

    await pool.query(
      `UPDATE booking_requests SET is_relocating = true, relocating_started_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [bookingId]
    );

    return res.json({
      success: true,
      booking: {
        id: booking.id,
        user_email: booking.user_email,
        user_name: booking.user_name,
        resource_id: booking.resource_id,
        resource_name: booking.resource_name,
        request_date: booking.request_date,
        start_time: booking.start_time,
        end_time: booking.end_time,
        duration_minutes: booking.duration_minutes,
        notes: booking.notes,
        staff_notes: booking.staff_notes,
        trackman_booking_id: booking.trackman_booking_id,
        declared_player_count: booking.declared_player_count,
        guest_count: booking.guest_count,
        session_id: booking.session_id,
      }
    });
  } catch (err) {
    logger.error('[Reschedule] Failed to start reschedule', { error: err as Error });
    return res.status(500).json({ error: 'Failed to start reschedule' });
  }
});

router.post('/api/admin/booking/:id/reschedule/confirm', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { resource_id, request_date, start_time, end_time, duration_minutes, trackman_booking_id } = req.body;

    if (!resource_id || !request_date || !start_time || !end_time || !duration_minutes || !trackman_booking_id) {
      return res.status(400).json({ error: 'Missing required fields: resource_id, request_date, start_time, end_time, duration_minutes, trackman_booking_id' });
    }

    const bookingResult = await pool.query(
      `SELECT br.id, br.user_email, br.user_name, br.status, br.resource_id,
              br.request_date, br.start_time, br.end_time, br.duration_minutes,
              br.is_relocating, br.trackman_booking_id,
              r.name as resource_name
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot reschedule a cancelled booking' });
    }

    if (!booking.is_relocating) {
      return res.status(400).json({ error: 'Booking is not in reschedule mode. Please start the reschedule first.' });
    }

    const conflictResult = await pool.query(
      `SELECT id FROM booking_requests
       WHERE resource_id = $1
         AND request_date = $2
         AND status IN ('approved', 'confirmed', 'attended')
         AND id != $3
         AND (
           (start_time <= $4 AND end_time > $4)
           OR (start_time < $5 AND end_time >= $5)
           OR (start_time >= $4 AND end_time <= $5)
         )`,
      [resource_id, request_date, bookingId, start_time, end_time]
    );

    if (conflictResult.rows.length > 0) {
      return res.status(409).json({ error: 'Time slot conflicts with existing booking' });
    }

    const originalResourceId = booking.resource_id;
    const originalStartTime = booking.start_time;
    const originalEndTime = booking.end_time;
    const originalDate = booking.request_date;
    const originalBayName = booking.resource_name;

    const updateResult = await pool.query(
      `UPDATE booking_requests
       SET resource_id = $1,
           request_date = $2,
           start_time = $3,
           end_time = $4,
           duration_minutes = $5,
           trackman_booking_id = $6,
           original_resource_id = $7,
           original_start_time = $8,
           original_end_time = $9,
           original_booked_date = $10,
           is_relocating = false,
           relocating_started_at = NULL,
           updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [resource_id, request_date, start_time, end_time, duration_minutes, trackman_booking_id,
       originalResourceId, originalStartTime, originalEndTime, originalDate, bookingId]
    );

    const updated = updateResult.rows[0];

    if (updated.session_id) {
      try {
        await pool.query(
          `UPDATE booking_sessions 
           SET resource_id = $1, session_date = $2, start_time = $3, end_time = $4,
               trackman_booking_id = $5, updated_at = NOW()
           WHERE id = $6`,
          [resource_id, request_date, start_time, end_time, trackman_booking_id, updated.session_id]
        );
        logger.info('[Reschedule] Updated booking session', {
          extra: { bookingId, sessionId: updated.session_id, newResourceId: resource_id, newDate: request_date }
        });

        try {
          await recalculateSessionFees(updated.session_id, 'reschedule');
          logger.info('[Reschedule] Recalculated session fees after reschedule', {
            extra: { bookingId, sessionId: updated.session_id }
          });
        } catch (feeErr) {
          logger.warn('[Reschedule] Fee recalculation failed (non-blocking)', {
            extra: { bookingId, sessionId: updated.session_id, error: (feeErr as Error).message }
          });
        }

        try {
          const staleIntents = await pool.query(
            `SELECT id, stripe_payment_intent_id FROM stripe_payment_intents
             WHERE session_id = $1
               AND purpose = 'prepayment'
               AND status NOT IN ('canceled', 'cancelled', 'refunded', 'failed', 'succeeded')`,
            [updated.session_id]
          );

          if (staleIntents.rows.length > 0) {
            const stripe = await getStripeClient();
            for (const intent of staleIntents.rows) {
              try {
                await stripe.paymentIntents.cancel(intent.stripe_payment_intent_id);
                await pool.query(
                  `UPDATE stripe_payment_intents SET status = 'canceled', updated_at = NOW() WHERE id = $1`,
                  [intent.id]
                );
                logger.info('[Reschedule] Canceled stale prepayment intent after reschedule', {
                  extra: { bookingId, sessionId: updated.session_id, paymentIntentId: intent.stripe_payment_intent_id }
                });
              } catch (cancelErr) {
                logger.warn('[Reschedule] Failed to cancel prepayment intent (non-blocking)', {
                  extra: { bookingId, paymentIntentId: intent.stripe_payment_intent_id, error: (cancelErr as Error).message }
                });
              }
            }
          }
        } catch (intentErr) {
          logger.warn('[Reschedule] Failed to query stale prepayment intents (non-blocking)', {
            extra: { bookingId, sessionId: updated.session_id, error: (intentErr as Error).message }
          });
        }
      } catch (sessionErr) {
        logger.warn('[Reschedule] Failed to update session (non-blocking)', {
          extra: { bookingId, sessionId: updated.session_id, error: (sessionErr as Error).message }
        });
      }
    }

    const newBayResult = await pool.query(
      `SELECT name FROM resources WHERE id = $1`,
      [resource_id]
    );
    const newBayName = newBayResult.rows[0]?.name || 'Unknown';

    logFromRequest(req, {
      action: 'booking_rescheduled',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Booking for ${booking.user_email}`,
      details: {
        originalBay: originalBayName,
        newBay: newBayName,
        originalDate: originalDate,
        newDate: request_date,
        originalTime: `${originalStartTime} - ${originalEndTime}`,
        newTime: `${start_time} - ${end_time}`,
      }
    });

    try {
      broadcastAvailabilityUpdate({
        resourceId: originalResourceId,
        resourceType: 'simulator',
        date: originalDate,
        action: 'updated'
      });
      if (resource_id !== originalResourceId || request_date !== originalDate) {
        broadcastAvailabilityUpdate({
          resourceId: resource_id,
          resourceType: 'simulator',
          date: request_date,
          action: 'updated'
        });
      }
    } catch {
    }

    if (booking.user_email) {
      const displayDate = new Date(request_date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles'
      });
      const notifMessage = `Your booking has been rescheduled to ${displayDate} at ${formatTime12Hour(start_time)} – ${formatTime12Hour(end_time)} (${newBayName}).`;

      pool.query(
        `INSERT INTO notifications (user_email, title, message, type, related_id, related_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [booking.user_email, 'Booking Rescheduled', notifMessage, 'booking_rescheduled', bookingId, 'booking']
      ).catch(() => {});

      sendPushNotification(booking.user_email, {
        title: 'Booking Rescheduled',
        body: notifMessage,
        url: '/sims'
      }).catch(() => {});
    }

    return res.json({
      success: true,
      booking: updated
    });
  } catch (err) {
    logger.error('[Reschedule] Failed to confirm reschedule', { error: err as Error });
    return res.status(500).json({ error: 'Failed to confirm reschedule' });
  }
});

router.post('/api/admin/booking/:id/reschedule/cancel', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    await pool.query(
      `UPDATE booking_requests SET is_relocating = false, relocating_started_at = NULL, updated_at = NOW() WHERE id = $1`,
      [bookingId]
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error('[Reschedule] Failed to cancel reschedule', { error: err as Error });
    return res.status(500).json({ error: 'Failed to cancel reschedule' });
  }
});

export async function clearStaleRelocations(): Promise<number> {
  try {
    const result = await pool.query(
      `UPDATE booking_requests 
       SET is_relocating = false, relocating_started_at = null,
           staff_notes = COALESCE(staff_notes, '') || ' [Reschedule abandoned - auto-cleared after 30m]'
       WHERE is_relocating = true 
       AND relocating_started_at < NOW() - INTERVAL '30 minutes'`
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      logger.info(`[Reschedule] Auto-cleared ${count} stale relocating booking(s)`);
    }
    return count;
  } catch (err) {
    logger.error('[Reschedule] Failed to clear stale relocations', { error: err as Error });
    return 0;
  }
}

export default router;
