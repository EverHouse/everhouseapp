import { Router, Request, Response } from 'express';
import { logAndRespond, logger } from '../core/logger';
import { db } from '../db';
import { sql } from 'drizzle-orm';
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
  updateDeclaredPlayerCount,
  applyRosterBatch,
} from '../core/bookingService/rosterService';
import { getSessionParticipants } from '../core/bookingService/sessionManager';
import { invalidateCachedFees, recalculateSessionFees } from '../core/billing/unifiedFeeService';

interface OwnerRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

interface FeeRow {
  total_cents: string | null;
  overage_cents: string | null;
  guest_cents: string | null;
}

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
    const isTargetSelf = memberEmail.trim().toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isTargetSelf && !isStaff) {
      return res.status(403).json({ error: 'You can only check conflicts for yourself unless you are staff' });
    }

    const excludeId = excludeBookingId ? parseInt(excludeBookingId as string) : undefined;

    const result = await checkMemberAvailability(
      memberEmail.trim().toLowerCase(),
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
      sessionUserId: sessionUser.id || userEmail,
      deferFeeRecalc: req.body.deferFeeRecalc === true,
      useGuestPass: req.body.useGuestPass
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
      sessionUserId: sessionUser.id || userEmail,
      deferFeeRecalc: req.query.deferFeeRecalc === 'true'
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
      staffEmail,
      deferFeeRecalc: req.body.deferFeeRecalc === true
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

router.post('/api/admin/booking/:bookingId/roster/batch', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { rosterVersion, operations } = req.body;

    if (typeof rosterVersion !== 'number') {
      return res.status(400).json({ error: 'rosterVersion must be a number' });
    }

    if (!Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ error: 'operations must be a non-empty array' });
    }

    const staffEmail = sessionUser.email?.toLowerCase() || '';

    const result = await applyRosterBatch({
      bookingId,
      rosterVersion,
      operations,
      staffEmail
    });

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    await handleConstraintAndRespond(req, res, error, 'Failed to apply batch roster update');
  }
});

router.post('/api/admin/booking/:bookingId/recalculate-fees', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ error: 'Authentication required' });

    const bookingId = parseInt(String(req.params.bookingId));
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });

    const booking = await getBookingWithSession(bookingId);
    if (!booking || !booking.session_id) {
      return res.status(404).json({ error: 'Booking or session not found' });
    }

    const allParticipants = await getSessionParticipants(booking.session_id);
    const participantIds = allParticipants.map(p => p.id);

    await invalidateCachedFees(participantIds, 'batch_recalc');
    const recalcResult = await recalculateSessionFees(booking.session_id, 'roster_update');

    let prepaymentCreated = false;
    const totalCents = recalcResult.totals?.totalCents || 0;
    if (totalCents > 0) {
      try {
        const ownerResult = await db.execute(
          sql`SELECT u.id, u.email, u.first_name, u.last_name 
           FROM users u 
           WHERE LOWER(u.email) = LOWER(${booking.owner_email})
           LIMIT 1`
        );

        const owner = ownerResult.rows[0] as unknown as OwnerRow | undefined;
        const ownerUserId = owner?.id || null;
        const ownerName = owner ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || booking.owner_email : booking.owner_email;

        const feeResult = await db.execute(sql`
          SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                 SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                 SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
          FROM booking_participants
          WHERE session_id = ${booking.session_id}
        `);

        const feeRow = feeResult.rows[0] as unknown as FeeRow | undefined;
        const feeTotalCents = parseInt(feeRow?.total_cents || '0');
        const overageCents = parseInt(feeRow?.overage_cents || '0');
        const guestCents = parseInt(feeRow?.guest_cents || '0');

        if (feeTotalCents > 0) {
          const { createPrepaymentIntent } = await import('../core/billing/prepaymentService');
          const prepayResult = await createPrepaymentIntent({
            sessionId: booking.session_id,
            bookingId,
            userId: ownerUserId,
            userEmail: booking.owner_email,
            userName: ownerName,
            totalFeeCents: feeTotalCents,
            feeBreakdown: { overageCents, guestCents }
          });

          if (prepayResult?.paidInFull) {
            await db.execute(
              sql`UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = ${booking.session_id} AND payment_status = 'pending'`
            );
          }
          prepaymentCreated = true;
        }
      } catch (prepayError: unknown) {
        logger.warn('[recalculate-fees] Failed to create prepayment intent (non-blocking)', {
          error: prepayError as Error,
          extra: { sessionId: booking.session_id, bookingId }
        });
      }
    }

    res.json({
      success: true,
      feesRecalculated: true,
      totalFees: recalcResult.totals?.totalCents || 0,
      participantsUpdated: recalcResult.participants?.length || 0,
      prepaymentCreated
    });
  } catch (error: unknown) {
    await handleConstraintAndRespond(req, res, error, 'Failed to recalculate fees');
  }
});

export default router;
