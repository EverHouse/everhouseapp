import { Router, Request, Response } from 'express';
import { logAndRespond, logger } from '../core/logger';
import { getSessionUser } from '../types/session';
import { isStaffOrAdmin } from '../core/middleware';
import { checkMemberAvailability } from '../core/bookingService/conflictDetection';
import {
  isStaffOrAdminCheck,
  getBookingWithSession,
  getBookingParticipants as getBookingParticipantsService,
  previewRosterFees,
  addParticipant,
  removeParticipant,
  initiateGuestFeeCheckout,
  confirmGuestPayment,
  cancelGuestPayment,
  updateDeclaredPlayerCount,
} from '../core/bookingService/rosterService';

const router = Router();

function mapServiceError(res: Response, error: unknown): Response | void {
  const statusCode = (error as { statusCode?: number }).statusCode;
  const extra = (error as { extra?: Record<string, unknown> }).extra;
  const message = error instanceof Error ? error.message : 'An error occurred';

  if (statusCode) {
    return res.status(statusCode).json({ error: message, ...extra });
  }
}

async function handleConstraintAndRespond(
  req: Request, res: Response, error: unknown, fallbackMessage: string
): Promise<void> {
  const mapped = mapServiceError(res, error);
  if (mapped) return;

  const { isConstraintError } = await import('../core/db');
  const constraint = isConstraintError(error);
  if (constraint.type === 'unique') {
    res.status(409).json({ error: 'This operation may have already been completed. Please refresh and try again.' });
    return;
  }
  if (constraint.type === 'foreign_key') {
    res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
    return;
  }
  logAndRespond(req, res, 500, fallbackMessage, error);
}

router.get('/api/bookings/conflicts', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { memberEmail, date, startTime, endTime, excludeBookingId } = req.query;

    if (!memberEmail || typeof memberEmail !== 'string') {
      return res.status(400).json({ error: 'memberEmail query parameter is required' });
    }
    if (!date || typeof date !== 'string') {
      return res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD format)' });
    }
    if (!startTime || typeof startTime !== 'string') {
      return res.status(400).json({ error: 'startTime query parameter is required (HH:MM format)' });
    }
    if (!endTime || typeof endTime !== 'string') {
      return res.status(400).json({ error: 'endTime query parameter is required (HH:MM format)' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isTargetSelf = memberEmail.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isTargetSelf && !isStaff) {
      return res.status(403).json({ error: 'You can only check conflicts for yourself unless you are staff' });
    }

    const excludeId = excludeBookingId ? parseInt(excludeBookingId as string) : undefined;

    const result = await checkMemberAvailability(
      memberEmail,
      date,
      startTime,
      endTime,
      excludeId
    );

    res.json({
      memberEmail,
      date,
      startTime,
      endTime,
      available: result.available,
      conflictCount: result.conflicts.length,
      conflicts: result.conflicts
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to check booking conflicts', error);
  }
});

router.get('/api/bookings/:bookingId/participants', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const result = await getBookingParticipantsService(bookingId, sessionUser);
    res.json(result);
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404) return res.status(404).json({ error: 'Booking not found' });
    if (statusCode === 403) return res.status(403).json({ error: 'Access denied' });
    logAndRespond(req, res, 500, 'Failed to fetch participants', error);
  }
});

router.post('/api/bookings/:bookingId/participants', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { type, userId, guest, rosterVersion } = req.body;

    if (!type || !['member', 'guest'].includes(type)) {
      return res.status(400).json({ error: 'Invalid participant type. Must be "member" or "guest"' });
    }
    if (type === 'member' && !userId) {
      return res.status(400).json({ error: 'userId is required for member participants' });
    }
    if (type === 'guest' && (!guest || !guest.name)) {
      return res.status(400).json({ error: 'Guest name is required' });
    }
    if (type === 'guest' && (!guest.email || !guest.email.trim())) {
      return res.status(400).json({ error: 'Guest email is required' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const result = await addParticipant({
      bookingId,
      type,
      userId,
      guest,
      rosterVersion,
      userEmail,
      sessionUserId: sessionUser.id || userEmail
    });

    res.status(201).json({ success: true, ...result });
  } catch (error: unknown) {
    await handleConstraintAndRespond(req, res, error, 'Failed to add participant');
  }
});

router.delete('/api/bookings/:bookingId/participants/:participantId', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    const participantId = parseInt(req.params.participantId as string);
    const rosterVersion = req.body?.rosterVersion;

    if (isNaN(bookingId) || isNaN(participantId)) {
      return res.status(400).json({ error: 'Invalid booking ID or participant ID' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const result = await removeParticipant({
      bookingId,
      participantId,
      rosterVersion,
      userEmail,
      sessionUserId: sessionUser.id || userEmail
    });

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    await handleConstraintAndRespond(req, res, error, 'Failed to remove participant');
  }
});

router.post('/api/bookings/:bookingId/participants/preview-fees', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { provisionalParticipants = [] } = req.body || {};

    const result = await previewRosterFees(bookingId, provisionalParticipants, sessionUser);
    res.json(result);
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404) return res.status(404).json({ error: 'Booking not found' });
    if (statusCode === 403) return res.status(403).json({ error: 'Access denied' });
    logAndRespond(req, res, 500, 'Failed to preview fees', error);
  }
});

router.post('/api/bookings/:bookingId/guest-fee-checkout', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { guestName, guestEmail } = req.body;
    if (!guestName?.trim()) {
      return res.status(400).json({ error: 'Guest name is required' });
    }
    if (!guestEmail?.trim()) {
      return res.status(400).json({ error: 'Guest email is required' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const result = await initiateGuestFeeCheckout({
      bookingId,
      guestName,
      guestEmail,
      userEmail,
      sessionUserId: sessionUser.id || userEmail
    });

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    await handleConstraintAndRespond(req, res, error, 'Failed to initiate guest fee checkout');
  }
});

router.post('/api/bookings/:bookingId/confirm-guest-payment', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { paymentIntentId, participantId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment intent ID is required' });
    }
    if (!participantId) {
      return res.status(400).json({ error: 'Participant ID is required' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const result = await confirmGuestPayment({
      bookingId,
      paymentIntentId,
      participantId,
      userEmail
    });

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    const mapped = mapServiceError(res, error);
    if (mapped) return;
    logAndRespond(req, res, 500, 'Failed to confirm guest payment', error);
  }
});

router.post('/api/bookings/:bookingId/cancel-guest-payment', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { participantId, paymentIntentId } = req.body;
    if (!participantId) {
      return res.status(400).json({ error: 'Participant ID is required' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const result = await cancelGuestPayment({
      bookingId,
      participantId,
      paymentIntentId,
      userEmail
    });

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    const mapped = mapServiceError(res, error);
    if (mapped) return;
    logAndRespond(req, res, 500, 'Failed to cancel guest payment', error);
  }
});

router.patch('/api/admin/booking/:bookingId/player-count', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.bookingId as string, 10);
    const { playerCount } = req.body;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email?.toLowerCase() || 'unknown';

    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    if (typeof playerCount !== 'number' || playerCount < 1 || playerCount > 4) {
      return res.status(400).json({ error: 'Player count must be between 1 and 4' });
    }

    const result = await updateDeclaredPlayerCount({
      bookingId,
      playerCount,
      staffEmail
    });

    const { logFromRequest } = await import('../core/auditLog');
    await logFromRequest(req, {
      action: 'update_booking',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Booking ${bookingId}`,
      details: {
        previousCount: result.previousCount,
        newCount: result.newCount,
        memberEmail: staffEmail
      }
    });

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    const mapped = mapServiceError(res, error);
    if (mapped) return;
    logAndRespond(req, res, 500, 'Failed to update player count', error);
  }
});

export default router;
