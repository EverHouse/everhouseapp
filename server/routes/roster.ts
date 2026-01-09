import { Router, Request, Response } from 'express';
import { db } from '../db';
import { pool } from '../core/db';
import { 
  bookingRequests, 
  bookingParticipants, 
  bookingSessions,
  guests,
  users
} from '../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logAndRespond, logger } from '../core/logger';
import { getSessionUser } from '../types/session';
import { isStaffOrAdmin } from '../core/middleware';
import { 
  createOrFindGuest, 
  linkParticipants, 
  getSessionParticipants,
  createSession,
  linkBookingRequestToSession,
  type ParticipantInput 
} from '../core/bookingService/sessionManager';
import { 
  enforceSocialTierRules, 
  getMemberTier,
  getGuestPassesRemaining,
  getRemainingMinutes,
  type ParticipantForValidation 
} from '../core/bookingService/tierRules';
import { 
  computeUsageAllocation,
  calculateOverageFee,
  type Participant as UsageParticipant
} from '../core/bookingService/usageCalculator';
import { getTierLimits, getMemberTierByEmail } from '../core/tierService';

const router = Router();

async function isStaffOrAdminCheck(email: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
  const isAdmin = await isAdminEmail(email);
  if (isAdmin) return true;
  
  const authPool = getAuthPool();
  if (!authPool) return false;
  
  try {
    const result = await queryWithRetry(
      authPool,
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

async function getBookingWithSession(bookingId: number) {
  const result = await pool.query(
    `SELECT 
      br.id as booking_id,
      br.user_email as owner_email,
      br.user_name as owner_name,
      br.request_date,
      br.start_time,
      br.end_time,
      br.duration_minutes,
      br.declared_player_count,
      br.status,
      br.session_id,
      br.resource_id,
      r.name as resource_name,
      u.tier as owner_tier
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
    WHERE br.id = $1`,
    [bookingId]
  );
  return result.rows[0] || null;
}

router.get('/api/bookings/:bookingId/participants', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isOwner = booking.owner_email?.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isOwner && !isStaff) {
      const participantCheck = await pool.query(
        `SELECT 1 FROM booking_participants bp
         JOIN booking_sessions bs ON bp.session_id = bs.id
         JOIN booking_requests br ON br.session_id = bs.id
         WHERE br.id = $1 AND bp.user_id = $2
         LIMIT 1`,
        [bookingId, sessionUser.id || userEmail]
      );
      if (participantCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    let participants: any[] = [];
    if (booking.session_id) {
      const participantRows = await db
        .select({
          id: bookingParticipants.id,
          sessionId: bookingParticipants.sessionId,
          userId: bookingParticipants.userId,
          guestId: bookingParticipants.guestId,
          participantType: bookingParticipants.participantType,
          displayName: bookingParticipants.displayName,
          slotDuration: bookingParticipants.slotDuration,
          paymentStatus: bookingParticipants.paymentStatus,
          inviteStatus: bookingParticipants.inviteStatus,
          createdAt: bookingParticipants.createdAt,
        })
        .from(bookingParticipants)
        .where(eq(bookingParticipants.sessionId, booking.session_id));
      
      participants = participantRows;
    }

    const declaredCount = booking.declared_player_count || 1;
    // Check if owner is already in participants (bookings with sessions have owner as participant)
    const ownerInParticipants = participants.some(p => p.participantType === 'owner');
    // If owner is in participants, just use participants.length; otherwise add 1 for the owner
    const currentCount = ownerInParticipants ? participants.length : (1 + participants.length);
    const remainingSlots = Math.max(0, declaredCount - currentCount);

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);
    let guestPassesRemaining = 0;
    let remainingMinutes = 0;
    
    if (ownerTier) {
      guestPassesRemaining = await getGuestPassesRemaining(booking.owner_email);
      remainingMinutes = await getRemainingMinutes(booking.owner_email, ownerTier, booking.request_date);
    }

    const guestCount = participants.filter(p => p.participantType === 'guest').length;

    res.json({
      booking: {
        id: booking.booking_id,
        ownerEmail: booking.owner_email,
        ownerName: booking.owner_name,
        requestDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        durationMinutes: booking.duration_minutes,
        resourceId: booking.resource_id,
        resourceName: booking.resource_name,
        status: booking.status,
        sessionId: booking.session_id,
      },
      declaredPlayerCount: declaredCount,
      currentParticipantCount: currentCount, // Includes owner (1) + added participants
      remainingSlots,
      participants, // Does NOT include owner - only explicitly added members/guests
      ownerTier,
      guestPassesRemaining,
      guestPassesUsed: guestCount,
      remainingMinutes,
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch participants', error);
  }
});

router.post('/api/bookings/:bookingId/participants', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { type, userId, guest } = req.body;
    
    if (!type || !['member', 'guest'].includes(type)) {
      return res.status(400).json({ error: 'Invalid participant type. Must be "member" or "guest"' });
    }

    if (type === 'member' && !userId) {
      return res.status(400).json({ error: 'userId is required for member participants' });
    }

    if (type === 'guest' && (!guest || !guest.name)) {
      return res.status(400).json({ error: 'Guest name is required' });
    }

    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isOwner = booking.owner_email?.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Only the booking owner or staff can add participants' });
    }

    let sessionId = booking.session_id;
    
    if (!sessionId) {
      logger.info('[roster] Creating session for booking without session_id', {
        extra: { bookingId, ownerEmail: booking.owner_email }
      });
      
      const { session } = await createSession(
        {
          resourceId: booking.resource_id,
          sessionDate: booking.request_date,
          startTime: booking.start_time,
          endTime: booking.end_time,
          createdBy: userEmail
        },
        [],
        'staff_manual'
      );
      
      await linkBookingRequestToSession(bookingId, session.id);
      sessionId = session.id;
      
      logger.info('[roster] Session created and linked to booking', {
        extra: { bookingId, sessionId }
      });
    }

    const existingParticipants = await getSessionParticipants(sessionId);
    const declaredCount = booking.declared_player_count || 1;
    
    // Check if owner is already in participants (sessions may or may not have owner as participant)
    const ownerInParticipants = existingParticipants.some(p => p.participantType === 'owner');
    // Effective count: if owner isn't in participants, add 1 for them
    const effectiveCount = ownerInParticipants ? existingParticipants.length : (1 + existingParticipants.length);
    
    if (effectiveCount >= declaredCount) {
      return res.status(400).json({ 
        error: 'Cannot add more participants. Maximum slot limit reached.',
        declaredPlayerCount: declaredCount,
        currentCount: effectiveCount
      });
    }

    let memberInfo: { id: string; email: string; firstName: string; lastName: string } | null = null;
    
    if (type === 'member') {
      // Look up member first to get both ID and email for duplicate checking
      const memberResult = await pool.query(
        `SELECT id, email, first_name, last_name FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
        [userId]
      );
      
      if (memberResult.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found' });
      }
      
      memberInfo = {
        id: memberResult.rows[0].id,
        email: memberResult.rows[0].email,
        firstName: memberResult.rows[0].first_name,
        lastName: memberResult.rows[0].last_name
      };
      
      // Check for duplicates using both ID and email (handles legacy data stored as email)
      const existingMember = existingParticipants.find(p => 
        p.userId === memberInfo!.id || 
        p.userId?.toLowerCase() === memberInfo!.email?.toLowerCase()
      );
      if (existingMember) {
        return res.status(400).json({ error: 'This member is already a participant' });
      }
    }

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);
    
    if (type === 'guest' && ownerTier) {
      const participantsForValidation: ParticipantForValidation[] = [
        ...existingParticipants.map(p => ({ 
          type: p.participantType as 'owner' | 'member' | 'guest', 
          displayName: p.displayName 
        })),
        { type: 'guest', displayName: guest.name }
      ];
      
      const socialCheck = await enforceSocialTierRules(ownerTier, participantsForValidation);
      
      if (!socialCheck.allowed) {
        return res.status(403).json({ 
          error: socialCheck.reason || 'Social tier members cannot bring guests',
          errorType: 'social_tier_blocked'
        });
      }
    }

    let participantInput: ParticipantInput;
    
    if (type === 'member' && memberInfo) {
      const displayName = [memberInfo.firstName, memberInfo.lastName].filter(Boolean).join(' ') || memberInfo.email;
      
      participantInput = {
        userId: memberInfo.id,
        participantType: 'member',
        displayName,
      };
    } else {
      const guestId = await createOrFindGuest(
        guest.name, 
        guest.email, 
        undefined, 
        sessionUser.id || userEmail
      );
      
      participantInput = {
        guestId,
        participantType: 'guest',
        displayName: guest.name,
      };
    }

    const [newParticipant] = await linkParticipants(sessionId, [participantInput]);

    logger.info('[roster] Participant added', {
      extra: {
        bookingId,
        sessionId,
        participantType: type,
        participantId: newParticipant.id,
        addedBy: userEmail
      }
    });

    res.status(201).json({
      success: true,
      participant: newParticipant,
      message: `${type === 'member' ? 'Member' : 'Guest'} added successfully`
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to add participant', error);
  }
});

router.delete('/api/bookings/:bookingId/participants/:participantId', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId);
    const participantId = parseInt(req.params.participantId);
    
    if (isNaN(bookingId) || isNaN(participantId)) {
      return res.status(400).json({ error: 'Invalid booking ID or participant ID' });
    }

    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!booking.session_id) {
      return res.status(400).json({ error: 'Booking does not have an active session' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isOwner = booking.owner_email?.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Only the booking owner or staff can remove participants' });
    }

    const [participant] = await db
      .select()
      .from(bookingParticipants)
      .where(and(
        eq(bookingParticipants.id, participantId),
        eq(bookingParticipants.sessionId, booking.session_id)
      ))
      .limit(1);

    if (!participant) {
      return res.status(404).json({ error: 'Participant not found' });
    }

    if (participant.participantType === 'owner') {
      return res.status(400).json({ error: 'Cannot remove the booking owner' });
    }

    await db
      .delete(bookingParticipants)
      .where(eq(bookingParticipants.id, participantId));

    logger.info('[roster] Participant removed', {
      extra: {
        bookingId,
        sessionId: booking.session_id,
        participantId,
        participantType: participant.participantType,
        removedBy: userEmail
      }
    });

    res.json({
      success: true,
      message: 'Participant removed successfully'
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to remove participant', error);
  }
});

router.post('/api/bookings/:bookingId/participants/preview-fees', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.bookingId);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isOwner = booking.owner_email?.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { provisionalParticipants = [] } = req.body || {};

    let existingParticipants: any[] = [];
    if (booking.session_id) {
      existingParticipants = await getSessionParticipants(booking.session_id);
    }

    const allParticipants = [...existingParticipants];
    for (const prov of provisionalParticipants) {
      if (prov && prov.type && prov.name) {
        allParticipants.push({
          participantType: prov.type,
          displayName: prov.name
        });
      }
    }

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);
    const durationMinutes = booking.duration_minutes || 60;

    let dailyAllowance = 60;
    let guestPassesPerMonth = 0;
    let remainingMinutesToday = 0;
    
    if (ownerTier) {
      const tierLimits = await getTierLimits(ownerTier);
      if (tierLimits) {
        dailyAllowance = tierLimits.daily_sim_minutes;
        guestPassesPerMonth = tierLimits.guest_passes_per_month;
      }
      remainingMinutesToday = await getRemainingMinutes(booking.owner_email, ownerTier, booking.request_date);
    }

    const usageParticipants: UsageParticipant[] = allParticipants.length > 0 
      ? allParticipants.map(p => ({
          userId: p.userId,
          guestId: p.guestId,
          participantType: p.participantType as 'owner' | 'member' | 'guest',
          displayName: p.displayName
        }))
      : [{
          participantType: 'owner' as const,
          displayName: booking.owner_name || booking.owner_email
        }];

    const allocations = computeUsageAllocation(durationMinutes, usageParticipants);

    const guestCount = allParticipants.filter(p => p.participantType === 'guest').length;
    const memberCount = allParticipants.filter(p => p.participantType === 'member').length;
    const ownerMinutes = allocations.find(a => a.participantType === 'owner')?.minutesAllocated || durationMinutes;
    const guestMinutes = allocations
      .filter(a => a.participantType === 'guest')
      .reduce((sum, a) => sum + a.minutesAllocated, 0);
    
    const totalOwnerResponsibleMinutes = ownerMinutes + guestMinutes;
    
    let overageFee = 0;
    let overageMinutes = 0;
    let minutesWithinAllowance = 0;
    
    if (dailyAllowance > 0 && dailyAllowance < 999) {
      const overageResult = calculateOverageFee(totalOwnerResponsibleMinutes, remainingMinutesToday);
      overageFee = overageResult.overageFee;
      overageMinutes = overageResult.overageMinutes;
      minutesWithinAllowance = Math.max(0, totalOwnerResponsibleMinutes - overageMinutes);
    } else if (dailyAllowance >= 999) {
      minutesWithinAllowance = totalOwnerResponsibleMinutes;
    }

    const guestPassesRemaining = ownerTier 
      ? await getGuestPassesRemaining(booking.owner_email) 
      : 0;

    res.json({
      booking: {
        id: booking.booking_id,
        durationMinutes,
        startTime: booking.start_time,
        endTime: booking.end_time,
      },
      participants: {
        total: allParticipants.length,
        members: memberCount,
        guests: guestCount,
        owner: 1,
      },
      timeAllocation: {
        totalMinutes: durationMinutes,
        minutesPerParticipant: allParticipants.length > 0 ? Math.floor(durationMinutes / allParticipants.length) : durationMinutes,
        allocations: allocations.map(a => ({
          displayName: a.displayName,
          type: a.participantType,
          minutes: a.minutesAllocated,
        })),
      },
      ownerFees: {
        tier: ownerTier,
        dailyAllowance,
        remainingMinutesToday,
        ownerMinutesUsed: ownerMinutes,
        guestMinutesCharged: guestMinutes,
        totalMinutesResponsible: totalOwnerResponsibleMinutes,
        minutesWithinAllowance,
        overageMinutes,
        estimatedOverageFee: overageFee,
      },
      guestPasses: {
        monthlyAllowance: guestPassesPerMonth,
        remaining: guestPassesRemaining,
        usedThisBooking: guestCount,
        afterBooking: Math.max(0, guestPassesRemaining - guestCount),
      },
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to preview fees', error);
  }
});

export default router;
