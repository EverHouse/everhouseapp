import { Router } from 'express';
import { db } from '../../db';
import { bookingRequests, resources, users } from '../../../shared/schema';
import { eq, sql, inArray } from 'drizzle-orm';
import { calculateFeeEstimate } from './booking-shared';
import { logAndRespond, logger } from '../../core/logger';
import { getSessionUser } from '../../types/session';
import { isStaffOrAdminCheck } from './helpers';
import { isAuthenticated } from '../../core/middleware';
import { normalizeToISODate } from '../../utils/dateNormalize';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';
import { getErrorMessage } from '../../utils/errorUtils';

const router = Router();

router.get('/api/booking-requests/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id as string, 10);
    if (isNaN(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });
    
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const result = await db.select({
      id: bookingRequests.id,
      user_email: bookingRequests.userEmail,
      user_name: sql<string>`COALESCE(
        NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
        ${bookingRequests.userName}
      )`.as('user_name'),
      resource_id: bookingRequests.resourceId,
      request_date: bookingRequests.requestDate,
      start_time: bookingRequests.startTime,
      end_time: bookingRequests.endTime,
      duration_minutes: bookingRequests.durationMinutes,
      notes: bookingRequests.notes,
      status: bookingRequests.status,
      staff_notes: bookingRequests.staffNotes,
      trackman_booking_id: bookingRequests.trackmanBookingId,
      trackman_player_count: bookingRequests.trackmanPlayerCount,
      declared_player_count: bookingRequests.declaredPlayerCount,
      created_at: bookingRequests.createdAt,
      bay_name: resources.name
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .leftJoin(users, sql`LOWER(${bookingRequests.userEmail}) = LOWER(${users.email})`)
    .where(eq(bookingRequests.id, bookingId))
    .limit(1);
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = result[0];
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const bookingEmail = booking.user_email?.toLowerCase() || '';
    
    if (sessionEmail !== bookingEmail) {
      const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
      if (!hasStaffAccess) {
        return res.status(403).json({ error: 'You can only view your own booking requests' });
      }
    }
    
    res.json(booking);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch booking request', error);
  }
});

const feeEstimateQuerySchema = z.object({
  bookingId: z.string().regex(/^\d+$/, 'bookingId must be a number').optional(),
  durationMinutes: z.string().regex(/^\d+$/).optional(),
  guestCount: z.string().regex(/^\d+$/).optional(),
  playerCount: z.string().regex(/^\d+$/).optional(),
  date: z.string().optional(),
  resourceType: z.string().optional(),
  guestsWithInfo: z.string().regex(/^\d+$/).optional(),
  memberEmails: z.string().optional(),
  memberUserIds: z.string().optional(),
  email: z.string().optional(),
}).passthrough();

router.get('/api/fee-estimate', isAuthenticated, validateQuery(feeEstimateQuerySchema), async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.removeHeader('ETag');
  res.set('ETag', '');
  
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const isStaff = await isStaffOrAdminCheck(sessionEmail);
    
    const vq = (req as unknown as { validatedQuery: z.infer<typeof feeEstimateQuerySchema> }).validatedQuery;
    
    let bookingId: number | null = null;
    if (vq.bookingId) {
      bookingId = parseInt(vq.bookingId, 10);
      if (isNaN(bookingId)) {
        return res.status(400).json({ error: 'Invalid bookingId parameter' });
      }
    }
    
    if (bookingId) {
      if (!isStaff) {
        return res.status(403).json({ error: 'Staff access required' });
      }
      
      const booking = await db.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId)).limit(1);
      if (!booking.length) {
        return res.status(404).json({ error: 'Booking request not found' });
      }
      
      const request = booking[0];
      const declaredPlayerCount = request.declaredPlayerCount || 1;
      
      let resourceType = 'simulator';
      if (request.resourceId) {
        const resourceResult = await db.execute(sql`SELECT type FROM resources WHERE id = ${request.resourceId}`);
        resourceType = (resourceResult.rows[0] as { type: string })?.type || 'simulator';
      }
      
      let effectivePlayerCount = declaredPlayerCount;
      let guestCount = Math.max(0, declaredPlayerCount - 1);
      
      if (request.sessionId) {
        const participantResult = await db.execute(sql`SELECT 
            COUNT(*) FILTER (WHERE participant_type = 'guest') as guest_count,
            COUNT(*) as total_count
           FROM booking_participants 
           WHERE session_id = ${request.sessionId}`);
        const actualTotal = parseInt((participantResult.rows[0] as { total_count: string; guest_count: string })?.total_count || '0', 10);
        const actualGuests = parseInt((participantResult.rows[0] as { total_count: string; guest_count: string })?.guest_count || '0', 10);
        
        effectivePlayerCount = Math.max(declaredPlayerCount, actualTotal);
        guestCount = actualGuests;
      }
      
      const estimate = await calculateFeeEstimate({
        ownerEmail: request.userEmail?.toLowerCase() || '',
        durationMinutes: request.durationMinutes || 60,
        guestCount,
        requestDate: request.requestDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
        playerCount: effectivePlayerCount,
        sessionId: request.sessionId ? request.sessionId : undefined,
        bookingId,
        resourceType
      });
      
      if (request.sessionId && estimate.totalFee === 0) {
        try {
          await db.execute(sql`UPDATE booking_participants 
             SET cached_fee_cents = 0 
             WHERE session_id = ${request.sessionId} AND payment_status = 'pending' AND cached_fee_cents > 0`);
        } catch (syncErr: unknown) {
          logger.error('[Fee Estimate] Failed to sync cached fee cents', { extra: { syncErr, bookingId } });
        }
      }
      
      return res.json(estimate);
    }
    
    const durationMinutes = parseInt(vq.durationMinutes || '', 10) || 60;
    const guestCount = parseInt(vq.guestCount || '', 10) || 0;
    const playerCount = parseInt(vq.playerCount || '', 10) || 1;
    const requestDate = normalizeToISODate(vq.date as string);
    const resourceType = vq.resourceType || 'simulator';
    const guestsWithInfo = parseInt(vq.guestsWithInfo || '', 10) || 0;
    const memberEmailsParam = vq.memberEmails;
    const memberEmails = memberEmailsParam ? memberEmailsParam.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) : [];
    
    const memberUserIdsParam = vq.memberUserIds;
    const memberUserIds = memberUserIdsParam ? memberUserIdsParam.split(',').map(id => id.trim()).filter(Boolean) : [];
    
    const memberEmailToUserId = new Map<string, string>();
    if (memberUserIds.length > 0) {
      try {
        const resolvedUsers = await db.select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, memberUserIds));
        const existingSet = new Set(memberEmails);
        for (const u of resolvedUsers) {
          const email = u.email?.toLowerCase();
          if (email) {
            memberEmailToUserId.set(email, u.id);
            if (!existingSet.has(email)) {
              memberEmails.push(email);
              existingSet.add(email);
            }
          }
        }
      } catch (err: unknown) {
        logger.error('[FeeEstimate] Failed to resolve member user IDs to emails', { error: new Error(getErrorMessage(err)) });
      }
    }
    
    const ownerEmail = isStaff && vq.email 
      ? vq.email.trim().toLowerCase() 
      : sessionEmail;
    
    const estimate = await calculateFeeEstimate({
      ownerEmail,
      durationMinutes,
      guestCount,
      requestDate,
      playerCount,
      resourceType,
      memberEmails,
      memberEmailToUserId,
      guestsWithInfo
    });
    
    res.json({ ...estimate, _ts: Date.now() });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to calculate fee estimate', error);
  }
});

export default router;
