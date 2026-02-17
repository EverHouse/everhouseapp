import { Router, Request, Response } from 'express';
import { db } from '../db';
import { pool } from '../core/db';
import { PoolClient } from 'pg';
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
  ensureSessionForBooking,
  linkBookingRequestToSession,
  type ParticipantInput 
} from '../core/bookingService/sessionManager';
import { createPacificDate } from '../utils/dateUtils';
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
import { useGuestPass, refundGuestPass, ensureGuestPassRecord } from './guestPasses';
import { 
  findConflictingBookings, 
  checkMemberAvailability,
  type ConflictingBooking 
} from '../core/bookingService/conflictDetection';
import { notifyMember } from '../core/notificationService';
import { getStripeClient } from '../core/stripe/client';
import { getOrCreateStripeCustomer } from '../core/stripe/customers';
import { createBalanceAwarePayment } from '../core/stripe/payments';
import { computeFeeBreakdown, getEffectivePlayerCount, invalidateCachedFees, recalculateSessionFees } from '../core/billing/unifiedFeeService';
import { PRICING } from '../core/billing/pricingConfig';
import { createPrepaymentIntent } from '../core/billing/prepaymentService';
import { getErrorMessage } from '../utils/errorUtils';

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
  } catch (error: unknown) {
    console.error('[isStaffOrAdminCheck] DB error, defaulting to false:', (error as Error).message);
    return false;
  }
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
      br.notes,
      br.staff_notes,
      br.roster_version,
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

    const bookingId = parseInt(req.params.bookingId as string);
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
    
    // Get resource type to correctly calculate remaining minutes
    let resourceTypeForRoster = 'simulator';
    if (booking.resource_id) {
      const resourceResult = await pool.query(
        'SELECT type FROM resources WHERE id = $1',
        [booking.resource_id]
      );
      resourceTypeForRoster = resourceResult.rows[0]?.type || 'simulator';
    }
    
    if (ownerTier) {
      // Fetch guest passes and remaining minutes in parallel to reduce latency
      [guestPassesRemaining, remainingMinutes] = await Promise.all([
        getGuestPassesRemaining(booking.owner_email),
        getRemainingMinutes(booking.owner_email, ownerTier, booking.request_date, resourceTypeForRoster)
      ]);
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
        notes: booking.notes || null,
        staffNotes: booking.staff_notes || null,
      },
      declaredPlayerCount: declaredCount,
      currentParticipantCount: currentCount, // Includes owner (1) + added participants
      remainingSlots,
      participants, // Does NOT include owner - only explicitly added members/guests
      ownerTier,
      guestPassesRemaining,
      guestPassesUsed: guestCount,
      remainingMinutes,
      rosterVersion: booking.roster_version ?? 0,
    });
  } catch (error: unknown) {
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

    const client = await pool.connect();
    let newRosterVersion: number;
    
    try {
      await client.query('BEGIN');
      
      const lockedBooking = await client.query(
        `SELECT roster_version FROM booking_requests WHERE id = $1 FOR UPDATE`,
        [bookingId]
      );
      
      if (!lockedBooking.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      const currentVersion = lockedBooking.rows[0].roster_version ?? 0;
      
      if (rosterVersion !== undefined && currentVersion !== rosterVersion) {
        await client.query('ROLLBACK');
        return res.status(409).json({ 
          error: 'Roster was modified by another user',
          code: 'ROSTER_CONFLICT',
          currentVersion
        });
      }

    let sessionId = booking.session_id;
    
    if (!sessionId) {
      logger.info('[roster] Creating session for booking without session_id', {
        extra: { bookingId, ownerEmail: booking.owner_email }
      });
      
      // Pass the existing transaction client to ensureSessionForBooking so the session
      // creation happens within the same transaction as the roster lock
      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id,
        sessionDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: booking.owner_email,
        source: 'staff_manual',
        createdBy: userEmail
      }, client);
      
      sessionId = sessionResult.sessionId || null;
      
      if (!sessionId || sessionResult.error) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Failed to create billing session for this booking. Staff has been notified.' });
      }
      
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
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Cannot add more participants. Maximum slot limit reached.',
        declaredPlayerCount: declaredCount,
        currentCount: effectiveCount
      });
    }

    let memberInfo: { id: string; email: string; firstName: string; lastName: string } | null = null;
    let matchingGuestId: number | null = null;
    let matchingGuestName: string | null = null;
    
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

      // Check if there's a guest with an exactly matching name - will auto-replace after successful member add
      const memberFullName = `${memberInfo.firstName || ''} ${memberInfo.lastName || ''}`.trim().toLowerCase();
      const normalize = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();
      const normalizedMember = normalize(memberFullName);
      
      // Pattern to identify placeholder guests (e.g., "Guest 2", "Guest 3", "Guest (info pending)")
      // IMPORTANT: Only match explicit system-generated patterns, not a real guest named "Guest"
      const isPlaceholderGuest = (name: string | null): boolean => {
        if (!name) return false;
        const normalized = name.trim().toLowerCase();
        // Match "guest 2", "guest 3", etc. (must have a number)
        // Or "guest (info pending)" style patterns
        return /^guest\s+\d+$/.test(normalized) || 
               /^guest\s*\(.*pending.*\)$/i.test(normalized);
      };
      
      // Store matching guest ID for deletion AFTER successful member add (hoisted to broader scope)
      // First try exact name match
      let matchingGuest = existingParticipants.find(p => {
        if (p.participantType !== 'guest') return false;
        const normalizedGuest = normalize(p.displayName || '');
        return normalizedGuest === normalizedMember;
      });
      
      // If no exact match, look for placeholder guests to replace
      if (!matchingGuest) {
        matchingGuest = existingParticipants.find(p => {
          if (p.participantType !== 'guest') return false;
          return isPlaceholderGuest(p.displayName);
        });
        
        if (matchingGuest) {
          logger.info('[roster] Found placeholder guest to replace with member', {
            extra: {
              bookingId,
              placeholderName: matchingGuest.displayName,
              memberName: memberFullName,
              memberEmail: memberInfo.email
            }
          });
        }
      }
      
      if (matchingGuest) {
        matchingGuestId = matchingGuest.id;
        matchingGuestName = matchingGuest.displayName;
      }

      // Check for time conflicts with other bookings
      const conflictResult = await findConflictingBookings(
        memberInfo.email,
        booking.request_date,
        booking.start_time,
        booking.end_time,
        bookingId
      );
      
      if (conflictResult.hasConflict) {
        const conflict = conflictResult.conflicts[0];
        logger.warn('[roster] Conflict detected when adding member', {
          extra: {
            bookingId,
            memberEmail: memberInfo.email,
            conflictingBookingId: conflict.bookingId,
            conflictType: conflict.conflictType,
            date: booking.request_date
          }
        });
        
        return res.status(409).json({
          error: `This member has a scheduling conflict with another booking on ${booking.request_date}`,
          errorType: 'booking_conflict',
          conflict: {
            id: conflict.bookingId,
            bookingId: conflict.bookingId,
            date: booking.request_date,
            resourceName: conflict.resourceName,
            startTime: conflict.startTime,
            endTime: conflict.endTime,
            ownerName: conflict.ownerName,
            conflictType: conflict.conflictType
          }
        });
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
      
      const bookingStartTime = createPacificDate(booking.request_date, booking.start_time);
      const inviteExpiresAt = new Date(bookingStartTime.getTime() - 30 * 60 * 1000);
      
      participantInput = {
        userId: memberInfo.id,
        participantType: 'member',
        displayName,
        invitedAt: new Date(),
        inviteExpiresAt,
      };
    } else {
      // Ensure guest pass record exists and decrement guest pass
      await ensureGuestPassRecord(booking.owner_email, ownerTier || undefined);
      
      const guestPassResult = await useGuestPass(booking.owner_email, guest.name, true);
      if (!guestPassResult.success) {
        return res.status(400).json({ 
          error: guestPassResult.error || 'No guest passes remaining',
          errorType: 'no_guest_passes'
        });
      }
      
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
      
      logger.info('[roster] Guest pass decremented', {
        extra: { 
          bookingId, 
          ownerEmail: booking.owner_email, 
          guestName: guest.name,
          remainingPasses: guestPassResult.remaining 
        }
      });
    }

    const [newParticipant] = await linkParticipants(sessionId, [participantInput]);

    // For guests, mark the payment_status as 'paid' (via guest pass)
    let guestPassesRemaining: number | undefined;
    if (type === 'guest' && newParticipant) {
      // Use transaction client for participant update
      await client.query(
        `UPDATE booking_participants SET payment_status = 'paid' WHERE id = $1`,
        [newParticipant.id]
      );
      
      // Get updated guest pass count for response (using transaction client)
      const passResult = await client.query(
        `SELECT passes_total - passes_used as remaining FROM guest_passes WHERE LOWER(member_email) = LOWER($1)`,
        [booking.owner_email]
      );
      guestPassesRemaining = passResult.rows[0]?.remaining ?? 0;
    }

    // For members, also add to booking_members so the booking shows on their schedule
    if (type === 'member' && memberInfo) {
      // Get the next available slot number (using transaction client)
      const slotResult = await client.query(
        `SELECT COALESCE(MAX(slot_number), 0) + 1 as next_slot FROM booking_members WHERE booking_id = $1`,
        [bookingId]
      );
      const nextSlot = slotResult.rows[0]?.next_slot || 2;
      
      // Insert into booking_members (this makes the booking appear on member's schedule)
      // Check if member already exists for this booking to avoid duplicate key errors (using transaction client)
      const existingMember = await client.query(
        `SELECT id FROM booking_members WHERE booking_id = $1 AND LOWER(user_email) = LOWER($2)`,
        [bookingId, memberInfo.email]
      );
      
      if (existingMember.rows.length === 0) {
        await client.query(
          `INSERT INTO booking_members (booking_id, user_email, slot_number, is_primary, linked_at, linked_by, created_at)
           VALUES ($1, $2, $3, false, NOW(), $4, NOW())`,
          [bookingId, memberInfo.email.toLowerCase(), nextSlot, userEmail]
        );
      }
      
      logger.info('[roster] Member linked to booking_members', {
        extra: { bookingId, memberEmail: memberInfo.email, slotNumber: nextSlot }
      });
      
      // Send notification to invited member
      try {
        const { notifyMember } = await import('../core/notificationService');
        const formattedDate = booking.request_date || 'upcoming date';
        const formattedTime = booking.start_time ? booking.start_time.substring(0, 5) : '';
        const timeDisplay = formattedTime ? ` at ${formattedTime}` : '';
        
        await notifyMember({
          userEmail: memberInfo.email.toLowerCase(),
          type: 'booking_invite',
          title: 'You\'ve been added to a booking',
          message: `${booking.owner_name || 'A member'} has added you to their simulator booking on ${formattedDate}${timeDisplay}`,
          relatedId: bookingId
        });
        
        logger.info('[roster] Invite notification sent', {
          extra: { bookingId, invitedMember: memberInfo.email }
        });
      } catch (notifError: unknown) {
        logger.warn('[roster] Failed to send invite notification (non-blocking)', {
          error: notifError as Error,
          extra: { bookingId, memberEmail: memberInfo.email }
        });
      }
      
      // After member is successfully added, remove any matching guest to prevent duplicates
      if (matchingGuestId !== null) {
        // Re-verify the guest still exists and belongs to this session before deleting (using transaction client)
        const guestCheckResult = await client.query(
          `SELECT id, display_name, used_guest_pass FROM booking_participants 
           WHERE id = $1 AND session_id = $2 AND participant_type = 'guest' LIMIT 1`,
          [matchingGuestId, sessionId]
        );
        
        if (guestCheckResult.rows.length > 0) {
          const guestToRemove = guestCheckResult.rows[0];
          logger.info('[roster] Removing matching guest after successful member add', {
            extra: {
              bookingId,
              sessionId,
              guestParticipantId: guestToRemove.id,
              guestName: guestToRemove.display_name,
              memberEmail: memberInfo.email
            }
          });
          
          // Use transaction client for guest deletion
          await client.query(
            `DELETE FROM booking_participants WHERE id = $1`,
            [guestToRemove.id]
          );
          
          // Only refund if guest pass was actually used for this participant
          if (guestToRemove.used_guest_pass === true) {
            const refundResult = await refundGuestPass(
              booking.owner_email,
              guestToRemove.display_name || undefined,
              true
            );
            
            if (refundResult.success) {
              logger.info('[roster] Guest pass refunded when replacing guest with member', {
                extra: { 
                  bookingId, 
                  ownerEmail: booking.owner_email,
                  guestName: guestToRemove.display_name,
                  remainingPasses: refundResult.remaining 
                }
              });
            }
          }
        } else {
          logger.info('[roster] Matching guest already removed or changed, skipping delete', {
            extra: { bookingId, sessionId, originalGuestId: matchingGuestId }
          });
        }
      }
    }

    logger.info('[roster] Participant added', {
      extra: {
        bookingId,
        sessionId,
        participantType: type,
        participantId: newParticipant.id,
        addedBy: userEmail
      }
    });

    // Invalidate and recalculate session fees after adding participant
    try {
      // Get all participant IDs for this session
      const allParticipants = await getSessionParticipants(sessionId);
      const participantIds = allParticipants.map(p => p.id);
      
      // Invalidate cached fees for all participants (roster changed)
      await invalidateCachedFees(participantIds, 'participant_added');
      
      const recalcResult = await recalculateSessionFees(sessionId, 'roster_update');
      logger.info('[roster] Session fees recalculated after adding participant', {
        extra: {
          sessionId,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.billingResult.totalFees,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });
      
      // Create prepayment intent if there are fees after adding participant
      if (recalcResult.billingResult.totalFees > 0) {
        try {
          // Get owner info from booking
          const ownerResult = await pool.query(
            `SELECT u.id, u.email, u.first_name, u.last_name 
             FROM users u 
             WHERE LOWER(u.email) = LOWER($1)
             LIMIT 1`,
            [booking.owner_email]
          );
          
          const owner = ownerResult.rows[0];
          const ownerUserId = owner?.id || null;
          const ownerName = owner ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || booking.owner_email : booking.owner_email;
          
          // Calculate fee breakdown
          const feeResult = await pool.query(`
            SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                   SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                   SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
            FROM booking_participants
            WHERE session_id = $1
          `, [sessionId]);
          
          const totalCents = parseInt(feeResult.rows[0]?.total_cents || '0');
          const overageCents = parseInt(feeResult.rows[0]?.overage_cents || '0');
          const guestCents = parseInt(feeResult.rows[0]?.guest_cents || '0');
          
          if (totalCents > 0) {
            const prepayResult = await createPrepaymentIntent({
              sessionId,
              bookingId,
              userId: ownerUserId,
              userEmail: booking.owner_email,
              userName: ownerName,
              totalFeeCents: totalCents,
              feeBreakdown: { overageCents, guestCents }
            });
            
            if (prepayResult?.paidInFull) {
              await pool.query(
                `UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = $1 AND payment_status = 'pending'`,
                [sessionId]
              );
              logger.info('[roster] Prepayment fully covered by credit', {
                extra: { sessionId, bookingId, totalCents }
              });
            } else {
              logger.info('[roster] Created prepayment intent after adding participant', {
                extra: { sessionId, bookingId, totalCents }
              });
            }
          }
        } catch (prepayError: unknown) {
          logger.warn('[roster] Failed to create prepayment intent (non-blocking)', {
            error: prepayError as Error,
            extra: { sessionId, bookingId }
          });
        }
      }
    } catch (recalcError: unknown) {
      logger.warn('[roster] Failed to recalculate session fees (non-blocking)', {
        error: recalcError as Error,
        extra: { sessionId, bookingId }
      });
    }

      await client.query(
        `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`,
        [bookingId]
      );
      
      newRosterVersion = (lockedBooking.rows[0].roster_version ?? 0) + 1;
      
      await client.query('COMMIT');

    res.status(201).json({
      success: true,
      participant: newParticipant,
      message: `${type === 'member' ? 'Member' : 'Guest'} added successfully`,
      ...(type === 'guest' && { guestPassesRemaining }),
      newRosterVersion
    });
    } catch (txError: unknown) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const { isConstraintError } = await import('../core/db');
    const constraint = isConstraintError(error);
    if (constraint.type === 'unique') {
      return res.status(409).json({ error: 'This participant may have already been added. Please refresh and try again.' });
    }
    if (constraint.type === 'foreign_key') {
      return res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
    }
    logAndRespond(req, res, 500, 'Failed to add participant', error);
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

    // Get the participant first so we can check if user is removing themselves
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

    // Check if user is removing themselves (allow self-removal)
    let isSelf = false;
    if (participant.userId) {
      // Check if participant.userId matches current user
      const userResult = await pool.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [userEmail]
      );
      if (userResult.rows.length > 0 && userResult.rows[0].id === participant.userId) {
        isSelf = true;
      }
    }

    // Allow removal if: owner, staff, or user removing themselves
    if (!isOwner && !isStaff && !isSelf) {
      return res.status(403).json({ error: 'Only the booking owner, staff, or the participant themselves can remove this participant' });
    }

    if (participant.participantType === 'owner') {
      return res.status(400).json({ error: 'Cannot remove the booking owner' });
    }

    const client = await pool.connect();
    let newRosterVersion: number;
    
    try {
      await client.query('BEGIN');
      
      const lockedBooking = await client.query(
        `SELECT roster_version FROM booking_requests WHERE id = $1 FOR UPDATE`,
        [bookingId]
      );
      
      if (!lockedBooking.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      const currentVersion = lockedBooking.rows[0].roster_version ?? 0;
      
      if (rosterVersion !== undefined && currentVersion !== rosterVersion) {
        await client.query('ROLLBACK');
        return res.status(409).json({ 
          error: 'Roster was modified by another user',
          code: 'ROSTER_CONFLICT',
          currentVersion
        });
      }

    // If removing a guest, refund the guest pass to the booking owner
    let guestPassesRemaining: number | undefined;
    if (participant.participantType === 'guest') {
      const refundResult = await refundGuestPass(
        booking.owner_email, 
        participant.displayName || undefined,
        true
      );
      
      if (refundResult.success) {
        guestPassesRemaining = refundResult.remaining;
        logger.info('[roster] Guest pass refunded on participant removal', {
          extra: { 
            bookingId, 
            ownerEmail: booking.owner_email, 
            guestName: participant.displayName,
            remainingPasses: refundResult.remaining 
          }
        });
      } else {
        logger.warn('[roster] Failed to refund guest pass (non-blocking)', {
          extra: { 
            bookingId, 
            ownerEmail: booking.owner_email,
            error: refundResult.error 
          }
        });
      }
    }

    // Use transaction client for participant deletion
    await client.query(
      `DELETE FROM booking_participants WHERE id = $1`,
      [participantId]
    );

    // If it was a member, also remove from booking_members
    if (participant.participantType === 'member' && participant.userId) {
      // Get member email from userId (could be UUID or email for legacy data)
      const memberResult = await client.query(
        `SELECT email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
        [participant.userId]
      );
      
      if (memberResult.rows.length > 0) {
        const memberEmail = memberResult.rows[0].email.toLowerCase();
        // Use LOWER() on both sides to ensure case-insensitive matching
        await client.query(
          `DELETE FROM booking_members WHERE booking_id = $1 AND LOWER(user_email) = LOWER($2)`,
          [bookingId, memberEmail]
        );
        
        logger.info('[roster] Member removed from booking_members', {
          extra: { bookingId, memberEmail }
        });
      }
    }

    logger.info('[roster] Participant removed', {
      extra: {
        bookingId,
        sessionId: booking.session_id,
        participantId,
        participantType: participant.participantType,
        removedBy: userEmail
      }
    });

    // Invalidate and recalculate session fees after removing participant
    try {
      // Get remaining participant IDs for this session
      const remainingParticipants = await getSessionParticipants(booking.session_id);
      const participantIds = remainingParticipants.map(p => p.id);
      
      // Invalidate cached fees for all remaining participants (roster changed)
      await invalidateCachedFees(participantIds, 'participant_removed');
      
      const recalcResult = await recalculateSessionFees(booking.session_id, 'roster_update');
      logger.info('[roster] Session fees recalculated after removing participant', {
        extra: {
          sessionId: booking.session_id,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.billingResult.totalFees,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });
    } catch (recalcError: unknown) {
      logger.warn('[roster] Failed to recalculate session fees (non-blocking)', {
        error: recalcError as Error,
        extra: { sessionId: booking.session_id, bookingId }
      });
    }

      await client.query(
        `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`,
        [bookingId]
      );
      
      newRosterVersion = (lockedBooking.rows[0].roster_version ?? 0) + 1;
      
      await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Participant removed successfully',
      ...(participant.participantType === 'guest' && guestPassesRemaining !== undefined && { guestPassesRemaining }),
      newRosterVersion
    });
    } catch (txError: unknown) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const { isConstraintError } = await import('../core/db');
    const constraint = isConstraintError(error);
    if (constraint.type === 'unique') {
      return res.status(409).json({ error: 'This operation may have already been completed. Please refresh and try again.' });
    }
    if (constraint.type === 'foreign_key') {
      return res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
    }
    logAndRespond(req, res, 500, 'Failed to remove participant', error);
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
          displayName: prov.name,
          email: prov.email
        });
      }
    }

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);
    const durationMinutes = booking.duration_minutes || 60;
    const declaredPlayerCount = booking.declared_player_count || 1;
    
    // Get resource capacity and type as an upper bound for time allocation
    let resourceCapacity: number | null = null;
    let isConferenceRoom = false;
    if (booking.resource_id) {
      const resourceResult = await pool.query(
        'SELECT capacity, type FROM resources WHERE id = $1',
        [booking.resource_id]
      );
      if (resourceResult.rows[0]?.capacity) {
        resourceCapacity = resourceResult.rows[0].capacity;
      }
      isConferenceRoom = resourceResult.rows[0]?.type === 'conference_room';
    }
    
    // Count actual participants (owner + added participants)
    const ownerInAll = allParticipants.some(p => p.participantType === 'owner');
    const actualParticipantCount = ownerInAll ? allParticipants.length : (1 + allParticipants.length);
    
    // Use unified service's getEffectivePlayerCount
    const effectivePlayerCount = getEffectivePlayerCount(declaredPlayerCount, actualParticipantCount);
    
    // Total slots = effective player count (capped by resource capacity if available)
    const totalSlots = resourceCapacity 
      ? Math.max(1, Math.min(effectivePlayerCount, resourceCapacity))
      : Math.max(1, effectivePlayerCount);

    let dailyAllowance = 60;
    let guestPassesPerMonth = 0;
    let remainingMinutesToday = 0;
    
    if (ownerTier) {
      const tierLimits = await getTierLimits(ownerTier);
      if (tierLimits) {
        // Use conference room minutes for conference room bookings, simulator minutes otherwise
        dailyAllowance = isConferenceRoom 
          ? tierLimits.daily_conf_room_minutes 
          : tierLimits.daily_sim_minutes;
        guestPassesPerMonth = tierLimits.guest_passes_per_month;
      }
      // Pass resource type to get correct remaining minutes for conference room vs simulator
      const resourceTypeForRemaining = isConferenceRoom ? 'conference_room' : 'simulator';
      remainingMinutesToday = await getRemainingMinutes(booking.owner_email, ownerTier, booking.request_date, resourceTypeForRemaining);
    }

    // Build participant list for unified fee service
    const ownerInParticipants = allParticipants.some(p => p.participantType === 'owner');
    const participantsForFeeCalc: Array<{
      userId?: string;
      email?: string;
      displayName: string;
      participantType: 'owner' | 'member' | 'guest';
    }> = [];
    
    // Always add owner first
    if (!ownerInParticipants) {
      participantsForFeeCalc.push({
        email: booking.owner_email,
        displayName: booking.owner_name || booking.owner_email,
        participantType: 'owner'
      });
    }
    
    // Add existing participants
    for (const p of allParticipants) {
      participantsForFeeCalc.push({
        userId: p.userId,
        email: p.email,
        displayName: p.displayName,
        participantType: p.participantType as 'owner' | 'member' | 'guest'
      });
    }

    // Use unified fee service for fee calculation
    let breakdown;
    try {
      breakdown = await computeFeeBreakdown(
        booking.session_id 
          ? {
              sessionId: booking.session_id,
              declaredPlayerCount: effectivePlayerCount,
              source: 'roster_update' as const,
              excludeSessionFromUsage: true,
              isConferenceRoom
            }
          : {
              sessionDate: booking.request_date,
              sessionDuration: durationMinutes,
              declaredPlayerCount: effectivePlayerCount,
              hostEmail: booking.owner_email,
              participants: participantsForFeeCalc,
              source: 'roster_update' as const,
              isConferenceRoom
            }
      );
    } catch (feeError: unknown) {
      logger.warn('[roster] Failed to compute unified fee breakdown, using fallback', {
        error: feeError as Error,
        extra: { bookingId, sessionId: booking.session_id }
      });
      
      // Fallback to legacy calculation if unified service fails
      const allocations = computeUsageAllocation(durationMinutes, participantsForFeeCalc.map(p => ({
        participantType: p.participantType,
        displayName: p.displayName
      })), {
        declaredSlots: totalSlots,
        assignRemainderToOwner: true
      });
      
      const guestCount = allParticipants.filter(p => p.participantType === 'guest').length;
      const memberCount = allParticipants.filter(p => p.participantType === 'member').length;
      const minutesPerPlayer = Math.floor(durationMinutes / totalSlots);
      const ownerAllocation = allocations.find(a => a.participantType === 'owner');
      const baseOwnerMinutes = ownerAllocation?.minutesAllocated || minutesPerPlayer;
      const filledSlots = participantsForFeeCalc.length;
      const unfilledSlots = Math.max(0, totalSlots - filledSlots);
      const unfilledMinutes = unfilledSlots * minutesPerPlayer;
      const ownerMinutes = baseOwnerMinutes + unfilledMinutes;
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
      
      return res.json({
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
          declaredPlayerCount,
          actualParticipantCount,
          effectivePlayerCount,
          totalSlots,
          minutesPerParticipant: minutesPerPlayer,
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
    }

    // Map unified breakdown to response format
    const guestCount = allParticipants.filter(p => p.participantType === 'guest').length;
    const memberCount = allParticipants.filter(p => p.participantType === 'member').length;
    const minutesPerPlayer = Math.floor(durationMinutes / totalSlots);
    
    // Calculate owner and guest minutes from breakdown
    const ownerLineItem = breakdown.participants.find(p => p.participantType === 'owner');
    const ownerMinutes = ownerLineItem?.minutesAllocated || breakdown.metadata.sessionDuration;
    const guestMinutes = breakdown.participants
      .filter(p => p.participantType === 'guest')
      .reduce((sum, p) => sum + p.minutesAllocated, 0);
    const totalOwnerResponsibleMinutes = ownerMinutes + guestMinutes;
    
    // Calculate overage details
    const overageFee = Math.round(breakdown.totals.overageCents / 100);
    const overageMinutes = overageFee > 0 ? Math.ceil(overageFee / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES : 0;
    const minutesWithinAllowance = Math.max(0, totalOwnerResponsibleMinutes - overageMinutes);

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
        declaredPlayerCount,
        actualParticipantCount,
        effectivePlayerCount: breakdown.metadata.effectivePlayerCount,
        totalSlots,
        minutesPerParticipant: minutesPerPlayer,
        allocations: breakdown.participants.map(p => ({
          displayName: p.displayName,
          type: p.participantType,
          minutes: p.minutesAllocated,
          feeCents: p.totalCents,
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
        estimatedGuestFees: Math.round(breakdown.totals.guestCents / 100),
        estimatedTotalFees: Math.round(breakdown.totals.totalCents / 100),
      },
      guestPasses: {
        monthlyAllowance: guestPassesPerMonth,
        remaining: breakdown.totals.guestPassesAvailable,
        usedThisBooking: breakdown.totals.guestPassesUsed,
        afterBooking: Math.max(0, breakdown.totals.guestPassesAvailable - guestCount),
      },
      unifiedBreakdown: breakdown,
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to preview fees', error);
  }
});

// Accept an invite to a booking
router.post('/api/bookings/:id/invite/accept', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    // Support "View As" mode: admin can accept on behalf of a member
    const { onBehalfOf } = req.body || {};
    let userEmail = sessionUser.email?.toLowerCase() || '';
    
    if (onBehalfOf && typeof onBehalfOf === 'string') {
      // Only admins can act on behalf of others
      if (sessionUser.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can accept invites on behalf of others' });
      }
      userEmail = onBehalfOf.toLowerCase();
      logger.info('[Invite Accept] Admin acting on behalf of member', {
        extra: { adminEmail: sessionUser.email, targetEmail: userEmail, bookingId }
      });
    }
    
    // Get booking with session
    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    if (!booking.session_id) {
      return res.status(400).json({ error: 'Booking has no session - cannot accept invite' });
    }

    // Find the participant record - join with users table since userId is a UUID
    // This allows finding participants by their email address
    const participantResult = await db
      .select({
        id: bookingParticipants.id,
        sessionId: bookingParticipants.sessionId,
        userId: bookingParticipants.userId,
        inviteStatus: bookingParticipants.inviteStatus,
        displayName: bookingParticipants.displayName,
        participantType: bookingParticipants.participantType
      })
      .from(bookingParticipants)
      .innerJoin(users, eq(bookingParticipants.userId, users.id))
      .where(and(
        eq(bookingParticipants.sessionId, booking.session_id),
        sql`LOWER(${users.email}) = ${userEmail}`
      ))
      .limit(1);

    if (!participantResult[0]) {
      return res.status(404).json({ error: 'You are not a participant on this booking' });
    }

    const participant = participantResult[0];
    
    if (participant.inviteStatus === 'accepted') {
      return res.json({ success: true, message: 'Invite already accepted' });
    }

    // Check for time conflicts with other bookings before accepting
    const conflictResult = await findConflictingBookings(
      userEmail,
      booking.request_date,
      booking.start_time,
      booking.end_time,
      bookingId
    );
    
    if (conflictResult.hasConflict) {
      const conflict = conflictResult.conflicts[0];
      logger.warn('[Invite Accept] Conflict detected when accepting invite', {
        extra: {
          bookingId,
          userEmail,
          conflictingBookingId: conflict.bookingId,
          conflictType: conflict.conflictType,
          date: booking.request_date
        }
      });
      
      return res.status(409).json({
        error: `Cannot accept invite: you have a scheduling conflict with another booking on ${booking.request_date}`,
        errorType: 'booking_conflict',
        conflict: {
          id: conflict.bookingId,
          bookingId: conflict.bookingId,
          date: booking.request_date,
          resourceName: conflict.resourceName,
          startTime: conflict.startTime,
          endTime: conflict.endTime,
          ownerName: conflict.ownerName,
          conflictType: conflict.conflictType
        }
      });
    }

    // Update invite status to accepted
    await db
      .update(bookingParticipants)
      .set({ 
        inviteStatus: 'accepted',
        respondedAt: new Date()
      })
      .where(eq(bookingParticipants.id, participant.id));

    logger.info('[Invite Accept] Member accepted invite', {
      extra: { bookingId, userEmail, sessionId: booking.session_id }
    });

    // Notify the booking owner that invite was accepted
    const invitedMemberName = participant.displayName || userEmail;
    await notifyMember({
      userEmail: booking.user_email || booking.owner_email,
      title: 'Invite Accepted',
      message: `${invitedMemberName} accepted your invite to the booking on ${booking.request_date}`,
      type: 'booking_invite',
      relatedId: bookingId,
      relatedType: 'booking',
      url: '/sims'
    });

    res.json({ success: true, message: 'Invite accepted successfully' });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to accept invite', error);
  }
});

// Decline an invite to a booking
router.post('/api/bookings/:id/invite/decline', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    // Support "View As" mode: admin can decline on behalf of a member
    const { onBehalfOf } = req.body || {};
    let userEmail = sessionUser.email?.toLowerCase() || '';
    
    if (onBehalfOf && typeof onBehalfOf === 'string') {
      // Only admins can act on behalf of others
      if (sessionUser.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can decline invites on behalf of others' });
      }
      userEmail = onBehalfOf.toLowerCase();
      logger.info('[Invite Decline] Admin acting on behalf of member', {
        extra: { adminEmail: sessionUser.email, targetEmail: userEmail, bookingId }
      });
    }
    
    // Get booking with session
    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    if (!booking.session_id) {
      return res.status(400).json({ error: 'Booking has no session - cannot decline invite' });
    }

    // Find the participant record - join with users table since userId is a UUID
    const participantResult = await db
      .select({
        id: bookingParticipants.id,
        sessionId: bookingParticipants.sessionId,
        userId: bookingParticipants.userId,
        inviteStatus: bookingParticipants.inviteStatus,
        displayName: bookingParticipants.displayName,
        participantType: bookingParticipants.participantType
      })
      .from(bookingParticipants)
      .innerJoin(users, eq(bookingParticipants.userId, users.id))
      .where(and(
        eq(bookingParticipants.sessionId, booking.session_id),
        sql`LOWER(${users.email}) = ${userEmail}`
      ))
      .limit(1);

    if (!participantResult[0]) {
      return res.status(404).json({ error: 'You are not a participant on this booking' });
    }

    const participant = participantResult[0];
    
    // Import bookingMembers for removal
    const { bookingMembers } = await import('../../shared/schema');
    
    // Remove from booking_members table (so it no longer shows on schedule)
    await db
      .delete(bookingMembers)
      .where(and(
        eq(bookingMembers.bookingId, bookingId),
        sql`LOWER(${bookingMembers.userEmail}) = ${userEmail}`
      ));

    // Delete the participant record (release the slot)
    await db
      .delete(bookingParticipants)
      .where(eq(bookingParticipants.id, participant.id));

    logger.info('[Invite Decline] Member declined invite', {
      extra: { bookingId, userEmail, sessionId: booking.session_id, participantId: participant.id }
    });

    // Notify the booking owner that invite was declined
    const declinedMemberName = participant.displayName || userEmail;
    await notifyMember({
      userEmail: booking.user_email || booking.owner_email,
      title: 'Invite Declined',
      message: `${declinedMemberName} declined your invite to the booking on ${booking.request_date}`,
      type: 'booking_invite',
      relatedId: bookingId,
      relatedType: 'booking',
      url: '/sims'
    });

    res.json({ success: true, message: 'Invite declined successfully' });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to decline invite', error);
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

    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isOwner = booking.owner_email?.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Only the booking owner or staff can add guests' });
    }

    let sessionId = booking.session_id;

    if (!sessionId) {
      logger.info('[roster] Creating session for guest fee checkout', {
        extra: { bookingId, ownerEmail: booking.owner_email }
      });

      await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id,
        sessionDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: booking.owner_email,
        source: 'staff_manual',
        createdBy: userEmail
      });

      const updatedBooking = await db.select({ session_id: bookingRequests.sessionId })
        .from(bookingRequests)
        .where(eq(bookingRequests.id, bookingId))
        .limit(1);
      sessionId = updatedBooking[0]?.session_id ?? null;

      if (!sessionId) {
        return res.status(500).json({ error: 'Failed to create billing session for this booking. Staff has been notified.' });
      }
    }

    const existingParticipants = await getSessionParticipants(sessionId);
    const declaredCount = booking.declared_player_count || 1;
    const ownerInParticipants = existingParticipants.some(p => p.participantType === 'owner');
    const effectiveCount = ownerInParticipants ? existingParticipants.length : (1 + existingParticipants.length);

    if (effectiveCount >= declaredCount) {
      return res.status(400).json({
        error: 'Cannot add more participants. Maximum slot limit reached.',
        declaredPlayerCount: declaredCount,
        currentCount: effectiveCount
      });
    }

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);

    if (ownerTier) {
      const participantsForValidation: ParticipantForValidation[] = [
        ...existingParticipants.map(p => ({
          type: p.participantType as 'owner' | 'member' | 'guest',
          displayName: p.displayName
        })),
        { type: 'guest', displayName: guestName.trim() }
      ];

      const socialCheck = await enforceSocialTierRules(ownerTier, participantsForValidation);

      if (!socialCheck.allowed) {
        return res.status(403).json({
          error: socialCheck.reason || 'Social tier members cannot bring guests',
          errorType: 'social_tier_blocked'
        });
      }
    }

    const guestId = await createOrFindGuest(
      guestName.trim(),
      guestEmail.trim(),
      undefined,
      sessionUser.id || userEmail
    );

    const participantInput: ParticipantInput = {
      guestId,
      participantType: 'guest',
      displayName: guestName.trim(),
    };

    const [newParticipant] = await linkParticipants(sessionId, [participantInput]);

    if (!newParticipant) {
      return res.status(500).json({ error: 'Failed to add guest participant' });
    }

    const guestFeeCents = PRICING.GUEST_FEE_CENTS;

    await db.update(bookingParticipants)
      .set({ 
        paymentStatus: 'pending',
        cachedFeeCents: guestFeeCents
      })
      .where(eq(bookingParticipants.id, newParticipant.id));

    const ownerUserResult = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [booking.owner_email]
    );
    const ownerUserId = ownerUserResult.rows[0]?.id?.toString() || booking.owner_email;

    const customer = await getOrCreateStripeCustomer(
      ownerUserId,
      booking.owner_email,
      booking.owner_name || undefined
    );

    const paymentResult = await createBalanceAwarePayment({
      stripeCustomerId: customer.customerId,
      userId: ownerUserId,
      email: booking.owner_email,
      memberName: booking.owner_name || booking.owner_email.split('@')[0],
      amountCents: guestFeeCents,
      purpose: 'guest_fee',
      description: `Guest fee for ${guestName.trim()} - Booking #${bookingId}`,
      bookingId,
      sessionId,
      metadata: {
        participantId: newParticipant.id.toString(),
        guestName: guestName.trim(),
        guestEmail: guestEmail.trim(),
        ownerEmail: booking.owner_email
      }
    });

    if (paymentResult.error) {
      throw new Error(paymentResult.error);
    }

    if (paymentResult.paidInFull) {
      await db.update(bookingParticipants)
        .set({ paymentStatus: 'paid' })
        .where(eq(bookingParticipants.id, newParticipant.id));

      logger.info('[roster] Guest fee fully covered by account credit', {
        extra: {
          bookingId,
          sessionId,
          participantId: newParticipant.id,
          guestName: guestName.trim(),
          amount: guestFeeCents,
          balanceApplied: paymentResult.balanceApplied
        }
      });

      return res.json({
        success: true,
        paidInFull: true,
        paymentRequired: false,
        amount: guestFeeCents,
        balanceApplied: paymentResult.balanceApplied,
        participantId: newParticipant.id
      });
    }

    logger.info('[roster] Guest fee checkout initiated', {
      extra: {
        bookingId,
        sessionId,
        participantId: newParticipant.id,
        guestName: guestName.trim(),
        amount: guestFeeCents,
        paymentIntentId: paymentResult.paymentIntentId,
        balanceApplied: paymentResult.balanceApplied
      }
    });

    res.json({
      success: true,
      paidInFull: false,
      clientSecret: paymentResult.clientSecret,
      paymentIntentId: paymentResult.paymentIntentId,
      amount: guestFeeCents,
      balanceApplied: paymentResult.balanceApplied,
      remainingCents: paymentResult.remainingCents,
      participantId: newParticipant.id
    });
  } catch (error: unknown) {
    const { isConstraintError } = await import('../core/db');
    const constraint = isConstraintError(error);
    if (constraint.type === 'unique') {
      return res.status(409).json({ error: 'This participant may have already been added. Please refresh and try again.' });
    }
    if (constraint.type === 'foreign_key') {
      return res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
    }
    logAndRespond(req, res, 500, 'Failed to initiate guest fee checkout', error);
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

    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isOwner = booking.owner_email?.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Only the booking owner or staff can confirm payment' });
    }

    const participantCheck = await pool.query(
      `SELECT bp.id, bp.session_id FROM booking_participants bp WHERE bp.id = $1`,
      [participantId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Participant not found' });
    }

    if (booking.session_id && participantCheck.rows[0].session_id !== booking.session_id) {
      return res.status(403).json({ error: 'Participant does not belong to this booking' });
    }

    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: 'Payment not yet confirmed',
        status: paymentIntent.status
      });
    }

    const piBookingId = paymentIntent.metadata?.bookingId;
    const piParticipantId = paymentIntent.metadata?.participantId;
    const piOwnerEmail = paymentIntent.metadata?.ownerEmail;

    if (piBookingId !== bookingId.toString() || piParticipantId !== participantId.toString()) {
      return res.status(400).json({ error: 'Payment intent does not match this booking/participant' });
    }

    if (piOwnerEmail && piOwnerEmail.toLowerCase() !== booking.owner_email?.toLowerCase()) {
      return res.status(403).json({ error: 'Payment intent owner does not match booking owner' });
    }

    await db.update(bookingParticipants)
      .set({
        paymentStatus: 'paid'
      })
      .where(eq(bookingParticipants.id, participantId));

    await pool.query(
      `INSERT INTO legacy_purchases 
        (user_id, member_email, item_name, item_category, item_price_cents, quantity, subtotal_cents, 
         discount_percent, discount_amount_cents, tax_cents, item_total_cents, 
         payment_method, sale_date, linked_booking_session_id, is_comp, is_synced, stripe_payment_intent_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())`,
      [
        null,
        booking?.owner_email?.toLowerCase(),
        `Guest Fee - ${paymentIntent.metadata?.guestName || 'Guest'}`,
        'guest_fee',
        paymentIntent.amount || PRICING.GUEST_FEE_CENTS,
        1,
        paymentIntent.amount || PRICING.GUEST_FEE_CENTS,
        0,
        0,
        0,
        paymentIntent.amount || PRICING.GUEST_FEE_CENTS,
        'stripe',
        new Date(),
        booking?.session_id,
        false,
        false,
        paymentIntentId
      ]
    );

    logger.info('[roster] Guest fee payment confirmed', {
      extra: {
        bookingId,
        participantId,
        paymentIntentId,
        guestName: paymentIntent.metadata?.guestName
      }
    });

    res.json({ success: true, message: 'Guest fee payment confirmed' });
  } catch (error: unknown) {
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

    const booking = await getBookingWithSession(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const userEmail = sessionUser.email?.toLowerCase() || '';
    const isOwner = booking.owner_email?.toLowerCase() === userEmail;
    const isStaff = await isStaffOrAdminCheck(userEmail);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Only the booking owner or staff can cancel guest payment' });
    }

    const participantResult = await pool.query(
      `SELECT bp.id, bp.session_id, bp.payment_status, bp.guest_id, bp.display_name
       FROM booking_participants bp WHERE bp.id = $1`,
      [participantId]
    );

    if (participantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Participant not found' });
    }

    const participant = participantResult.rows[0];

    if (booking.session_id && participant.session_id !== booking.session_id) {
      return res.status(403).json({ error: 'Participant does not belong to this booking' });
    }

    if (participant.payment_status === 'paid') {
      return res.status(400).json({ error: 'Cannot cancel a paid participant' });
    }

    await db.delete(bookingParticipants)
      .where(eq(bookingParticipants.id, participantId));

    if (paymentIntentId) {
      try {
        const stripe = await getStripeClient();
        await stripe.paymentIntents.cancel(paymentIntentId);
      } catch (stripeErr: unknown) {
        logger.warn('[roster] Failed to cancel Stripe payment intent', {
          extra: { paymentIntentId, error: getErrorMessage(stripeErr) }
        });
      }
    }

    logger.info('[roster] Guest fee payment cancelled, participant removed', {
      extra: {
        bookingId,
        participantId,
        guestName: participant.display_name
      }
    });

    res.json({ success: true, message: 'Guest payment cancelled' });
  } catch (error: unknown) {
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

    const bookingResult = await pool.query(`
      SELECT br.id, br.declared_player_count, br.session_id, br.user_email, br.status
      FROM booking_requests br
      WHERE br.id = $1
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    const previousCount = booking.declared_player_count || 1;

    await pool.query(`
      UPDATE booking_requests 
      SET declared_player_count = $1
      WHERE id = $2
    `, [playerCount, bookingId]);

    if (playerCount > previousCount) {
      const slotResult = await pool.query(
        `SELECT COALESCE(MAX(slot_number), 0) as max_slot, COUNT(*) as count FROM booking_members WHERE booking_id = $1`,
        [bookingId]
      );
      const maxSlot = parseInt(slotResult.rows[0].max_slot) || 0;
      const currentMemberCount = parseInt(slotResult.rows[0].count) || 0;
      const slotsToCreate = playerCount - currentMemberCount;
      
      if (slotsToCreate > 0) {
        await pool.query(`
          INSERT INTO booking_members (booking_id, slot_number, user_email, is_primary, created_at)
          SELECT $1, slot_num, NULL, false, NOW()
          FROM generate_series($2, $3) AS slot_num
          ON CONFLICT (booking_id, slot_number) DO NOTHING
        `, [bookingId, maxSlot + 1, maxSlot + slotsToCreate]);
        logger.info('[roster] Created empty booking member slots', {
          extra: { bookingId, slotsCreated: slotsToCreate, previousCount, newCount: playerCount }
        });
      }
    } else if (playerCount < previousCount) {
      const deleted = await pool.query(`
        DELETE FROM booking_members 
        WHERE booking_id = $1 
          AND slot_number > $2 
          AND is_primary = false 
          AND (user_email IS NULL OR user_email = '')
      `, [bookingId, playerCount]);
      if (deleted.rowCount && deleted.rowCount > 0) {
        logger.info('[roster] Cleaned up empty slots after player count decrease', {
          extra: { bookingId, slotsRemoved: deleted.rowCount, previousCount, newCount: playerCount }
        });
      }
    }

    if (booking.session_id) {
      await recalculateSessionFees(booking.session_id, 'staff_action' as any);
    }

    const { logFromRequest } = await import('../core/auditLog');
    await logFromRequest(req, {
      action: 'update_booking',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Booking ${bookingId}`,
      details: { 
        previousCount, 
        newCount: playerCount,
        memberEmail: booking.user_email 
      }
    });

    logger.info('[roster] Player count updated', {
      extra: { bookingId, previousCount, newCount: playerCount, staffEmail }
    });

    res.json({ 
      success: true, 
      previousCount, 
      newCount: playerCount,
      feesRecalculated: !!booking.session_id
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update player count', error);
  }
});

export default router;
