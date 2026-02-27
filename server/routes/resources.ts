import { Router } from 'express';
import { bookingRateLimiter } from '../middleware/rateLimiting';
import { isAuthenticated, isStaffOrAdmin } from '../core/middleware';
import { logAndRespond, logger } from '../core/logger';
import { getSessionUser } from '../types/session';
import { logFromRequest } from '../core/auditLog';
import { getErrorMessage, getErrorCode, getErrorStatusCode } from '../utils/errorUtils';
import {
  fetchAllResources,
  checkExistingBookings,
  checkExistingBookingsForStaff,
  fetchBookings,
  fetchPendingBookings,
  approveBooking,
  declineBooking,
  assignMemberToBooking,
  resolveOwnerEmail,
  checkIsInstructor,
  getBookingDataForTrackman,
  convertToInstructorBlock,
  linkTrackmanToMember,
  linkEmailToMember,
  fetchOverlappingNotices,
  markBookingAsEvent,
  assignWithPlayers,
  changeBookingOwner,
  createBookingRequest,
  getCascadePreview,
  deleteBooking,
  memberCancelBooking,
  createManualBooking,
  isStaffOrAdminEmail,
} from '../core/resourceService';
import { normalizeToISODate } from '../utils/dateNormalize';

interface ServiceError extends Error {
  error?: string;
  bookingType?: string;
  remainingMinutes?: number;
  detail?: string;
  constraint?: string;
  _logData?: Record<string, unknown>;
  unpaidParticipants?: unknown[];
}

const router = Router();

router.get('/api/resources', async (req, res) => {
  try {
    const result = await fetchAllResources();
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch resources', error, 'RESOURCES_ERROR');
  }
});

router.get('/api/bookings/check-existing', async (req, res) => {
  try {
    const { user_email, date, resource_type } = req.query;
    
    const sessionUser = getSessionUser(req);
    const effectiveEmail = (user_email as string)?.trim()?.toLowerCase() || sessionUser?.email?.toLowerCase();
    
    if (!effectiveEmail || !date) {
      return res.status(400).json({ error: 'Missing required parameters: user_email, date' });
    }
    
    const result = await checkExistingBookings(
      effectiveEmail,
      date as string,
      (resource_type as string) || 'simulator'
    );
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to check existing bookings', error, 'CHECK_EXISTING_ERROR');
  }
});

router.get('/api/bookings/check-existing-staff', isStaffOrAdmin, async (req, res) => {
  try {
    const { member_email, date, resource_type } = req.query;
    
    if (!member_email || !date || !resource_type) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const result = await checkExistingBookingsForStaff(
      (member_email as string).trim().toLowerCase(),
      date as string,
      resource_type as string
    );
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to check existing bookings', error, 'CHECK_EXISTING_STAFF_ERROR');
  }
});

router.get('/api/bookings', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { date, resource_id, status, user_email, include_all, include_archived } = req.query;
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestEmail = (user_email as string)?.trim()?.toLowerCase();
    
    let includeAll = include_all === 'true';
    let isStaffUser = false;
    
    if (requestEmail && sessionEmail !== requestEmail) {
      isStaffUser = await isStaffOrAdminEmail(sessionEmail);
      if (!isStaffUser) {
        return res.status(403).json({ error: 'You can only view your own bookings' });
      }
      includeAll = true;
    } else if (!requestEmail) {
      isStaffUser = await isStaffOrAdminEmail(sessionEmail);
      if (isStaffUser) {
        includeAll = true;
      }
    }
    
    const effectiveEmail = requestEmail || (isStaffUser ? null : sessionEmail);
    
    const result = await fetchBookings({
      userEmail: effectiveEmail,
      date: date as string | null,
      resourceId: resource_id as string | null,
      status: status as string | null,
      includeAll,
      includeArchived: include_archived === 'true',
    });
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch bookings', error, 'BOOKINGS_ERROR');
  }
});

router.get('/api/pending-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await fetchPendingBookings();
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch pending bookings', error, 'PENDING_BOOKINGS_ERROR');
  }
});

router.put('/api/bookings/:id/approve', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });
    
    const result = await approveBooking(bookingId);
    
    logFromRequest(req, 'approve_booking', 'booking', id as string, result.userEmail, {
      bay: result.resourceId,
      time: result.startTime
    });
    
    res.json(result);
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ 
        error: (error as ServiceError).error, 
        message: getErrorMessage(error) 
      });
    }
    logAndRespond(req, res, 500, 'Failed to approve booking', error, 'APPROVE_BOOKING_ERROR');
  }
});

router.put('/api/bookings/:id/decline', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });
    
    const result = await declineBooking(bookingId, req.body.reason);
    
    logFromRequest(req, 'decline_booking', 'booking', id as string, result.userEmail, {
      member_email: result.userEmail,
      reason: req.body.reason || 'Not specified'
    });
    
    res.json(result);
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logAndRespond(req, res, 500, 'Failed to decline booking', error, 'DECLINE_BOOKING_ERROR');
  }
});

router.post('/api/bookings/:id/assign-member', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });
    const { member_email: raw_member_email, member_name, member_id } = req.body;
    const member_email = raw_member_email?.trim()?.toLowerCase();
    
    if (!member_email || !member_name) {
      return res.status(400).json({ error: 'Missing required fields: member_email, member_name' });
    }
    
    const result = await assignMemberToBooking(bookingId, member_email, member_name, member_id);
    
    logFromRequest(req, 'assign_member_to_booking', 'booking', id as string, member_email, {
      member_email,
      member_name,
      was_unmatched: true
    });
    
    res.json(result);
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logAndRespond(req, res, 500, 'Failed to assign member to booking', error, 'ASSIGN_MEMBER_ERROR');
  }
});

router.post('/api/bookings/link-trackman-to-member', isStaffOrAdmin, async (req, res) => {
  try {
    const { trackman_booking_id, owner, additional_players, member_email: raw_member_email, member_name, member_id, rememberEmail, originalEmail } = req.body;
    const member_email = raw_member_email?.trim()?.toLowerCase();
    
    if (!trackman_booking_id) {
      return res.status(400).json({ error: 'Missing required field: trackman_booking_id' });
    }
    
    const ownerEmail = owner?.email || member_email;
    const ownerName = owner?.name || member_name;
    const ownerId = owner?.member_id || member_id;
    
    if (!ownerEmail || !ownerName) {
      return res.status(400).json({ error: 'Missing required owner fields: email, name' });
    }
    
    const additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string; email?: string; name?: string; guest_name?: string }> = additional_players || [];
    const totalPlayerCount = 1 + additionalPlayers.filter(p => p.type === 'member' || p.type === 'guest_placeholder').length;
    const guestCount = additionalPlayers.filter(p => p.type === 'guest_placeholder').length;
    
    const resolvedOwnerEmail = await resolveOwnerEmail(ownerEmail);
    const isInstructor = await checkIsInstructor(resolvedOwnerEmail);
    
    if (isInstructor) {
      logger.info('[link-trackman-to-member] Detected golf instructor, converting to availability block', {
        extra: { trackman_booking_id, ownerEmail, ownerName }
      });
      
      const { bookingData, existingBooking } = await getBookingDataForTrackman(trackman_booking_id);
      
      if (!bookingData || !bookingData.resourceId || !bookingData.requestDate || !bookingData.startTime) {
        return res.status(400).json({ error: 'Cannot find booking data to create availability block' });
      }
      
      const staffEmail = getSessionUser(req)?.email || 'staff_link';
      const closure = await convertToInstructorBlock(
        trackman_booking_id, ownerName, ownerEmail, bookingData, existingBooking, staffEmail
      );
      
      logFromRequest(req, 'create_closure', 'closure', closure.id.toString(), ownerName, {
        trackman_booking_id,
        instructor_email: ownerEmail,
        instructor_name: ownerName,
        resource_id: bookingData.resourceId,
        date: bookingData.requestDate,
        start_time: bookingData.startTime,
        end_time: bookingData.endTime
      });
      
      return res.json({
        success: true,
        convertedToAvailabilityBlock: true,
        closureId: closure.id,
        instructorName: ownerName,
        message: `Converted to lesson block for instructor ${ownerName}`
      });
    }
    
    const staffEmail = getSessionUser(req)?.email || 'staff';
    const result = await linkTrackmanToMember(
      trackman_booking_id, ownerEmail, ownerName, ownerId,
      additionalPlayers, totalPlayerCount, guestCount, staffEmail
    );
    
    let emailLinked = false;
    if (rememberEmail && originalEmail && originalEmail.toLowerCase() !== ownerEmail.toLowerCase()) {
      emailLinked = await linkEmailToMember(ownerEmail, originalEmail);
    }
    
    logFromRequest(req, 'link_trackman_to_member', 'booking', result.booking.id.toString(), ownerEmail, {
      trackman_booking_id,
      owner_email: ownerEmail,
      owner_name: ownerName,
      total_players: totalPlayerCount,
      guest_count: guestCount,
      was_created: result.created,
      fees_recalculated: !!result.sessionId,
      email_linked: emailLinked ? originalEmail : null
    });
    
    res.json({ 
      success: true, 
      booking: result.booking, 
      created: result.created,
      totalPlayers: totalPlayerCount,
      guestCount,
      feesRecalculated: !!result.sessionId,
      emailLinked
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logAndRespond(req, res, 500, 'Failed to link Trackman booking to member', error, 'LINK_TRACKMAN_ERROR');
  }
});

router.get('/api/resources/overlapping-notices', isStaffOrAdmin, async (req, res) => {
  try {
    const { startDate, endDate, startTime, endTime, sameDayOnly } = req.query;
    
    if (!startDate || !startTime || !endTime) {
      return res.status(400).json({ error: 'Missing required parameters: startDate, startTime, endTime' });
    }
    
    const result = await fetchOverlappingNotices({
      startDate: startDate as string,
      endDate: endDate as string | undefined,
      startTime: startTime as string,
      endTime: endTime as string,
      sameDayOnly: sameDayOnly === 'true',
    });
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch overlapping notices', error, 'OVERLAPPING_NOTICES_ERROR');
  }
});

router.post('/api/bookings/mark-as-event', isStaffOrAdmin, async (req, res) => {
  try {
    const { booking_id, trackman_booking_id, existingClosureId } = req.body;
    
    if (!booking_id && !trackman_booking_id) {
      return res.status(400).json({ error: 'Missing required field: booking_id or trackman_booking_id' });
    }
    
    const staffEmail = req.session?.user?.email || 'staff';
    
    const result = await markBookingAsEvent({
      bookingId: booking_id,
      trackmanBookingId: trackman_booking_id,
      existingClosureId,
      staffEmail,
    });
    
    logFromRequest(req, 'update_booking', 'booking', result.primaryBooking.id.toString(), `Private Event: ${result.eventTitle}`, {
      booking_id: result.primaryBooking.id,
      trackman_booking_id,
      grouped_booking_count: result.convertedBookingIds.length,
      resource_ids: result.resourceIds,
      closure_id: result.closureId,
      linked_to_existing: result.linkedToExisting,
      new_blocks_created: result.newBlocksCreated
    });
    
    res.json({ 
      success: true, 
      message: result.message,
      closureId: result.closureId,
      convertedBookingIds: result.convertedBookingIds,
      resourceIds: result.resourceIds,
      linkedToExisting: result.linkedToExisting,
      newBlocksCreated: result.newBlocksCreated
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logAndRespond(req, res, 500, 'Failed to mark booking as event', error, 'MARK_EVENT_ERROR');
  }
});

router.put('/api/bookings/:id/assign-with-players', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    const { owner, additional_players, rememberEmail, originalEmail } = req.body;
    
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    if (!owner?.email || !owner?.name) {
      return res.status(400).json({ error: 'Missing required owner fields: email, name' });
    }
    
    const additionalPlayers: Array<{ type: 'member' | 'guest_placeholder'; member_id?: string; email?: string; name?: string; guest_name?: string }> = additional_players || [];
    const staffEmail = getSessionUser(req)?.email || 'staff';
    
    const result = await assignWithPlayers(bookingId, owner, additionalPlayers, staffEmail);
    
    let emailLinked = false;
    if (rememberEmail && originalEmail && originalEmail.toLowerCase() !== owner.email.toLowerCase()) {
      emailLinked = await linkEmailToMember(owner.email, originalEmail);
    }
    
    logFromRequest(req, 'assign_member_to_booking', 'booking', bookingId.toString(), owner.email, {
      owner_email: owner.email,
      owner_name: owner.name,
      total_players: result.totalPlayerCount,
      guest_count: result.guestCount,
      fees_recalculated: !!result.sessionId,
      email_linked: emailLinked ? originalEmail : null
    });
    
    res.json({ 
      success: true, 
      booking: result.booking,
      totalPlayers: result.totalPlayerCount,
      guestCount: result.guestCount,
      feesRecalculated: !!result.sessionId,
      emailLinked
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logger.error('[assign-with-players] Database error details', {
      extra: {
        bookingId: req.params.id,
        owner: req.body.owner,
        errorMessage: getErrorMessage(error),
        errorCode: getErrorCode(error),
        errorDetail: (error as ServiceError).detail,
        errorConstraint: (error as ServiceError).constraint,
        errorStack: (error instanceof Error ? error.stack : '')?.split('\n').slice(0, 5).join('\n')
      }
    });
    logAndRespond(req, res, 500, 'Failed to assign players to booking', error, 'ASSIGN_PLAYERS_ERROR');
  }
});

router.put('/api/bookings/:id/change-owner', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    const { new_email: raw_new_email, new_name, member_id } = req.body;
    const new_email = raw_new_email?.trim()?.toLowerCase();
    
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    if (!new_email || !new_name) {
      return res.status(400).json({ error: 'Missing required fields: new_email, new_name' });
    }
    
    const result = await changeBookingOwner(bookingId, new_email, new_name, member_id);
    
    logFromRequest(req, 'change_booking_owner', 'booking', bookingId.toString(), new_email, {
      previous_owner: result.previousOwner,
      new_email,
      new_name
    });
    
    res.json({ 
      success: true, 
      booking: result.booking
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logAndRespond(req, res, 500, 'Failed to change booking owner', error, 'CHANGE_OWNER_ERROR');
  }
});

router.post('/api/bookings', bookingRateLimiter, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { resource_id, user_email: raw_user_email, booking_date, start_time, end_time, notes } = req.body;
    const user_email = raw_user_email?.trim()?.toLowerCase();
    
    if (!resource_id || !user_email || !booking_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Missing required fields: resource_id, user_email, booking_date, start_time, end_time' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestEmail = user_email.toLowerCase();
    
    if (sessionEmail !== requestEmail) {
      const isStaff = await isStaffOrAdminEmail(sessionEmail);
      if (!isStaff) {
        return res.status(403).json({ error: 'You can only create bookings for yourself' });
      }
    }
    
    const result = await createBookingRequest({
      resourceId: resource_id,
      userEmail: user_email,
      bookingDate: booking_date,
      startTime: start_time,
      endTime: end_time,
      notes,
    });
    
    res.status(201).json({
      ...result,
      message: 'Request sent! Concierge will confirm shortly.'
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      const err = error as ServiceError;
      return res.status(getErrorStatusCode(error)).json({ 
        error: err.error,
        ...(err.bookingType && { bookingType: err.bookingType }),
        ...(err.message && { message: err.message }),
        ...(err.remainingMinutes !== undefined && { remainingMinutes: err.remainingMinutes }),
      });
    }
    logAndRespond(req, res, 500, 'Failed to submit booking request', error, 'BOOKING_REQUEST_ERROR');
  }
});

router.get('/api/bookings/:id/cascade-preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });
    
    const result = await getCascadePreview(bookingId);
    res.json(result);
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logAndRespond(req, res, 500, 'Failed to fetch cascade preview', error, 'CASCADE_PREVIEW_ERROR');
  }
});

router.delete('/api/bookings/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string);
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });
    const sessionUser = getSessionUser(req);
    const archivedBy = sessionUser?.email || 'unknown';
    const hardDelete = req.query.hard_delete === 'true';
    
    const result = await deleteBooking(bookingId, archivedBy, hardDelete);
    
    res.json({ 
      success: true,
      ...result
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      return res.status(getErrorStatusCode(error)).json({ error: (error as ServiceError).error });
    }
    logAndRespond(req, res, 500, 'Failed to delete booking', error, 'BOOKING_DELETE_ERROR');
  }
});

router.put('/api/bookings/:id/member-cancel', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const rawSessionEmail = getSessionUser(req)?.email;
    const sessionUserRole = getSessionUser(req)?.role;
    const userEmail = rawSessionEmail?.toLowerCase();
    const actingAsEmail = req.body?.acting_as_email?.toLowerCase();
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const bookingId = parseInt(id as string);
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });
    
    const result = await memberCancelBooking(bookingId, userEmail, sessionUserRole, actingAsEmail);
    
    if (result.isPending) {
      logFromRequest(req, 'cancellation_requested', 'booking', id as string, undefined, {
        member_email: result.existing.userEmail,
        trackman_booking_id: result.existing.trackmanBookingId
      });
      
      return res.json({ 
        success: true, 
        status: 'cancellation_pending',
        message: result.message
      });
    }
    
    logFromRequest(req, 'cancel_booking', 'booking', id as string, result.existing.userEmail, {
      member_email: result.existing.userEmail,
      cancelled_by: 'member',
      cascade_participants: result.cascadeResult?.participantsNotified,
      cascade_guest_passes: result.cascadeResult?.guestPassesRefunded,
      cascade_prepayments: result.cascadeResult?.prepaymentRefunds
    });
    
    res.json({ 
      success: true, 
      message: result.message,
      cascade: result.cascade
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      const err = error as ServiceError;
      if (err._logData) {
        logger.warn('Member cancel email mismatch', err._logData);
      }
      return res.status(getErrorStatusCode(error)).json({ error: err.error });
    }
    logAndRespond(req, res, 500, 'Failed to cancel booking', error, 'BOOKING_CANCEL_ERROR');
  }
});

router.post('/api/staff/bookings/manual', isStaffOrAdmin, async (req, res) => {
  try {
    const { 
      member_email, 
      resource_id, 
      booking_date, 
      start_time, 
      duration_minutes, 
      guest_count = 0, 
      booking_source, 
      notes,
      staff_notes,
      trackman_booking_id
    } = req.body;

    const staffEmail = getSessionUser(req)?.email;
    if (!staffEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!member_email || !resource_id || !booking_date || !start_time || !duration_minutes || !booking_source) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await createManualBooking({
      memberEmail: member_email,
      resourceId: resource_id,
      bookingDate: booking_date,
      startTime: start_time,
      durationMinutes: duration_minutes,
      guestCount: guest_count,
      bookingSource: booking_source,
      notes,
      staffNotes: staff_notes,
      trackmanBookingId: trackman_booking_id,
      staffEmail,
    });

    res.status(201).json({
      success: true,
      booking: result.booking,
      message: 'Booking created successfully'
    });
  } catch (error: unknown) {
    if (getErrorStatusCode(error)) {
      const err = error as ServiceError;
      return res.status(getErrorStatusCode(error)).json({ 
        error: err.error,
        ...(err.message && { message: err.message }),
      });
    }
    logAndRespond(req, res, 500, 'Failed to create manual booking', error, 'MANUAL_BOOKING_ERROR');
  }
});

export default router;
