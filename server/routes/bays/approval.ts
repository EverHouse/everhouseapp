import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { logAndRespond, logger } from '../../core/logger';
import { logFromRequest } from '../../core/auditLog';
import { getSessionUser } from '../../types/session';
import { getErrorStatusCode, getErrorMessage } from '../../utils/errorUtils';
import {
  validateTrackmanId,
  approveBooking,
  declineBooking,
  cancelBooking,
  handlePendingCancellation,
  handleCancelPostTransaction,
  updateGenericStatus,
  checkinBooking,
  devConfirmBooking,
  completeCancellation,
  formatBookingRow
} from '../../core/bookingService/approvalService';

const router = Router();

router.put('/api/booking-requests/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, staff_notes, suggested_time, reviewed_by, resource_id, trackman_booking_id, trackman_external_id, pending_trackman_sync } = req.body;
    const bookingId = parseInt(id as string, 10);

    if (trackman_booking_id !== undefined && trackman_booking_id !== null && trackman_booking_id !== '') {
      const validation = await validateTrackmanId(trackman_booking_id, bookingId);
      if (!validation.valid) {
        return res.status(validation.statusCode!).json({ error: validation.error });
      }
    }

    if (status === 'approved') {
      const { updated } = await approveBooking({
        bookingId,
        status,
        staff_notes,
        suggested_time,
        reviewed_by,
        resource_id,
        trackman_booking_id,
        trackman_external_id,
        pending_trackman_sync
      });

      return res.json(formatBookingRow(updated));
    }

    if (status === 'declined') {
      const { updated } = await declineBooking({
        bookingId,
        staff_notes,
        suggested_time,
        reviewed_by
      });

      return res.json(formatBookingRow(updated));
    }

    if (status === 'cancelled') {
      const { cancelled_by } = req.body;

      const { updated, bookingData, pushInfo, overageRefundResult, isConferenceRoom: isConfRoom, isPendingCancel, alreadyPending } = await cancelBooking({
        bookingId,
        staff_notes,
        cancelled_by
      });

      if (isPendingCancel) {
        if (alreadyPending) {
          return res.json({ success: true, status: 'cancellation_pending' });
        }

        await handlePendingCancellation(bookingId, bookingData, pushInfo);

        logFromRequest(req, 'cancellation_requested', 'booking', id.toString(), undefined, {
          member_email: bookingData.userEmail,
          trackman_booking_id: bookingData.trackmanBookingId,
          initiated_by: 'staff'
        });

        return res.json({ success: true, status: 'cancellation_pending' });
      }

      await handleCancelPostTransaction(bookingId, bookingData, pushInfo, overageRefundResult, isConfRoom);

      logFromRequest(req, 'cancel_booking', 'booking', id as string, undefined, {
        member_email: bookingData.userEmail,
        member_name: bookingData.userName,
        booking_date: bookingData.requestDate,
        start_time: bookingData.startTime,
        refund_result: overageRefundResult
      });

      return res.json(formatBookingRow(updated));
    }

    const result = await updateGenericStatus(bookingId, status, staff_notes);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking request not found' });
    }

    res.json(formatBookingRow(result[0]));
  } catch (error: unknown) {
    const statusCode = getErrorStatusCode(error);
    if (statusCode) {
      return res.status(statusCode).json({
        error: error && typeof error === 'object' && 'error' in error ? (error as { error: unknown }).error : undefined,
        message: getErrorMessage(error)
      });
    }
    const { isConstraintError } = await import('../../core/db');
    const constraint = isConstraintError(error);
    if (constraint.type === 'unique') {
      return res.status(409).json({ error: 'This booking may have already been processed. Please refresh and try again.' });
    }
    if (constraint.type === 'foreign_key') {
      return res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
    }
    logAndRespond(req, res, 500, 'Failed to update booking request', error);
  }
});

router.put('/api/bookings/:id/checkin', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status: targetStatus, confirmPayment, skipPaymentCheck, skipRosterCheck } = req.body;
    const bookingId = parseInt(id as string, 10);
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'unknown';
    const staffName = sessionUser?.name || null;

    const result = await checkinBooking({
      bookingId,
      targetStatus,
      confirmPayment,
      skipPaymentCheck,
      skipRosterCheck,
      staffEmail,
      staffName
    });

    if (result.error && result.statusCode) {
      const { error, statusCode, ...rest } = result;
      return res.status(statusCode).json({ error, ...rest });
    }

    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update booking status', error);
  }
});

router.post('/api/admin/bookings/:id/dev-confirm', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const result = await devConfirmBooking({
      bookingId,
      staffEmail: getSessionUser(req)?.email || 'unknown'
    });

    if (result.error && result.statusCode) {
      return res.status(result.statusCode).json({ error: result.error });
    }

    await logFromRequest(req, {
      action: 'booking_dev_confirm',
      resourceType: 'booking',
      resourceId: bookingId.toString(),
      resourceName: `Booking #${bookingId}`,
      details: { sessionId: result.sessionId, totalFeeCents: result.totalFeeCents }
    });

    res.json({
      success: true,
      bookingId,
      sessionId: result.sessionId,
      totalFeeCents: result.totalFeeCents,
      message: 'Booking confirmed'
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to confirm booking', error);
  }
});

router.put('/api/booking-requests/:id/complete-cancellation', isStaffOrAdmin, async (req, res) => {
  try {
    const staffEmail = getSessionUser(req)?.email;
    if (!staffEmail) return res.status(401).json({ error: 'Authentication required' });

    const bookingId = parseInt(req.params.id as string, 10);

    const result = await completeCancellation({ bookingId, staffEmail });

    if (result.error && result.statusCode) {
      return res.status(result.statusCode).json({ error: result.error });
    }

    logFromRequest(req, 'complete_cancellation', 'booking', req.params.id as string, staffEmail, {
      member_email: result.existing?.userEmail,
      trackman_booking_id: result.existing?.trackmanBookingId,
      completed_manually: true,
      cleanup_errors: result.cleanup_errors
    });

    return res.json({
      success: result.success,
      status: result.status,
      message: result.message,
      cleanup_errors: result.cleanup_errors
    });
  } catch (err: unknown) {
    logger.error('[Complete Cancellation] Error', { extra: { err } });
    return res.status(500).json({ error: 'Failed to complete cancellation' });
  }
});

export default router;
