import { Router } from 'express';
import { db } from '../../db';
import { pool } from '../../core/db';
import { bookingRequests, resources, users, bookingMembers, bookingGuests, bookingParticipants, notifications } from '../../../shared/schema';
import { eq, and, or, ne, desc, sql } from 'drizzle-orm';
import { sendPushNotification } from '../push';
import { checkDailyBookingLimit, getMemberTierByEmail, getTierLimits, getDailyBookedMinutes } from '../../core/tierService';
import { notifyAllStaff } from '../../core/notificationService';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour, createPacificDate } from '../../utils/dateUtils';
import { logAndRespond } from '../../core/logger';
import { bookingEvents } from '../../core/bookingEvents';
import { broadcastAvailabilityUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { cancelPaymentIntent, getStripeClient } from '../../core/stripe';
import { logFromRequest, logMemberAction } from '../../core/auditLog';
import { getCalendarNameForBayAsync, isStaffOrAdminCheck } from './helpers';
import { isStaffOrAdmin } from '../../core/middleware';
import { getCalendarIdByName, deleteCalendarEvent } from '../../core/calendar/index';
import { getGuestPassesRemaining } from '../guestPasses';
import { computeFeeBreakdown, getEffectivePlayerCount, applyFeeBreakdownToParticipants } from '../../core/billing/unifiedFeeService';
import { PRICING } from '../../core/billing/pricingConfig';
import { createGuestPassHold, releaseGuestPassHold } from '../../core/billing/guestPassHoldService';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { getErrorMessage } from '../../utils/errorUtils';

const router = Router();

router.get('/api/booking-requests', async (req, res) => {
  try {
    const { user_email, status, include_all, limit: limitParam, offset: offsetParam, page: pageParam } = req.query;
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestedEmail = (user_email as string)?.toLowerCase();
    
    const isStaffRequest = include_all === 'true';
    
    if (isStaffRequest) {
      const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
      if (!hasStaffAccess) {
        return res.status(403).json({ error: 'Staff access required to view all requests' });
      }
    } else if (user_email) {
      if (requestedEmail !== sessionEmail) {
        const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
        if (!hasStaffAccess) {
          return res.status(403).json({ error: 'You can only view your own booking requests' });
        }
      }
    } else {
      return res.status(400).json({ error: 'user_email or include_all parameter required' });
    }
    
    const conditions: any[] = [];
    
    conditions.push(
      or(
        eq(bookingRequests.isUnmatched, false),
        sql`${bookingRequests.isUnmatched} IS NULL`
      )
    );
    
    if (user_email && !include_all) {
      const userEmailLower = (user_email as string).toLowerCase();
      conditions.push(
        or(
          sql`LOWER(${bookingRequests.userEmail}) = ${userEmailLower}`,
          sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_members WHERE LOWER(user_email) = ${userEmailLower})`
        )
      );
    }
    
    if (status) {
      conditions.push(eq(bookingRequests.status, status as string));
    }
    
    const limit = limitParam ? Math.min(parseInt(limitParam as string), 500) : undefined;
    const page = pageParam ? Math.max(1, parseInt(pageParam as string)) : undefined;
    const offset = page && limit ? (page - 1) * limit : (offsetParam ? parseInt(offsetParam as string) : undefined);
    
    const isPaginated = !!page;
    
    let query = db.select({
      id: bookingRequests.id,
      user_email: bookingRequests.userEmail,
      user_name: bookingRequests.userName,
      resource_id: bookingRequests.resourceId,
      resource_preference: bookingRequests.resourcePreference,
      request_date: bookingRequests.requestDate,
      start_time: bookingRequests.startTime,
      duration_minutes: bookingRequests.durationMinutes,
      end_time: bookingRequests.endTime,
      notes: bookingRequests.notes,
      status: bookingRequests.status,
      staff_notes: bookingRequests.staffNotes,
      suggested_time: bookingRequests.suggestedTime,
      reviewed_by: bookingRequests.reviewedBy,
      reviewed_at: bookingRequests.reviewedAt,
      created_at: bookingRequests.createdAt,
      updated_at: bookingRequests.updatedAt,
      calendar_event_id: bookingRequests.calendarEventId,
      reschedule_booking_id: bookingRequests.rescheduleBookingId,
      resource_name: resources.name,
      resource_type: resources.type,
      tier: users.tier,
      guest_count: bookingRequests.guestCount,
      trackman_player_count: bookingRequests.trackmanPlayerCount,
      declared_player_count: bookingRequests.declaredPlayerCount,
      member_notes: bookingRequests.memberNotes,
      session_id: bookingRequests.sessionId,
      guardian_name: bookingRequests.guardianName,
      guardian_relationship: bookingRequests.guardianRelationship,
      guardian_phone: bookingRequests.guardianPhone,
      guardian_consent_at: bookingRequests.guardianConsentAt,
      overage_minutes: bookingRequests.overageMinutes,
      overage_fee_cents: bookingRequests.overageFeeCents,
      overage_paid: bookingRequests.overagePaid,
      is_unmatched: bookingRequests.isUnmatched,
      request_participants: bookingRequests.requestParticipants
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .leftJoin(users, sql`LOWER(${bookingRequests.userEmail}) = LOWER(${users.email})`)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(bookingRequests.createdAt));
    
    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }
    if (offset !== undefined && offset > 0) {
      query = query.offset(offset) as typeof query;
    }
    
    let totalCount = 0;
    if (isPaginated) {
      const countResult = await db.select({
        count: sql<number>`count(*)::int`
      })
      .from(bookingRequests)
      .leftJoin(users, sql`LOWER(${bookingRequests.userEmail}) = LOWER(${users.email})`)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
      totalCount = countResult[0]?.count || 0;
    }
    
    const result = await query;
    
    if (result.length === 0) {
      if (isPaginated) {
        return res.json({
          data: [],
          pagination: {
            total: 0,
            page: page || 1,
            limit: limit || 0,
            totalPages: 0,
            hasMore: false
          }
        });
      }
      return res.json([]);
    }
    
    const bookingIds = result.map(b => b.id);
    const requestingUserEmail = (user_email as string)?.toLowerCase();
    
    const memberSlotsCounts = await db.select({
      bookingId: bookingMembers.bookingId,
      totalSlots: sql<number>`count(*)::int`,
      filledSlots: sql<number>`count(${bookingMembers.userEmail})::int`
    })
    .from(bookingMembers)
    .where(sql`${bookingMembers.bookingId} IN (${sql.join(bookingIds.map(id => sql`${id}`), sql`, `)})`)
    .groupBy(bookingMembers.bookingId);
    
    const guestCounts = await db.select({
      bookingId: bookingGuests.bookingId,
      count: sql<number>`count(*)::int`
    })
    .from(bookingGuests)
    .where(sql`${bookingGuests.bookingId} IN (${sql.join(bookingIds.map(id => sql`${id}`), sql`, `)})`)
    .groupBy(bookingGuests.bookingId);
    
    const memberDetails = await db.select({
      bookingId: bookingMembers.bookingId,
      userEmail: bookingMembers.userEmail,
      isPrimary: bookingMembers.isPrimary,
      firstName: users.firstName,
      lastName: users.lastName
    })
    .from(bookingMembers)
    .leftJoin(users, sql`LOWER(${bookingMembers.userEmail}) = LOWER(${users.email})`)
    .where(sql`${bookingMembers.bookingId} IN (${sql.join(bookingIds.map(id => sql`${id}`), sql`, `)})`);
    
    const guestDetails = await db.select({
      bookingId: bookingGuests.bookingId,
      guestName: bookingGuests.guestName
    })
    .from(bookingGuests)
    .where(sql`${bookingGuests.bookingId} IN (${sql.join(bookingIds.map(id => sql`${id}`), sql`, `)})`);
    
    let inviteStatusMap = new Map<string, string>();
    if (requestingUserEmail && !isStaffRequest) {
      const sessionIds = result.filter(b => b.session_id).map(b => String(b.session_id));
      if (sessionIds.length > 0) {
        const inviteStatuses = await db.select({
          sessionId: bookingParticipants.sessionId,
          inviteStatus: bookingParticipants.inviteStatus
        })
        .from(bookingParticipants)
        .innerJoin(users, eq(bookingParticipants.userId, users.id))
        .where(and(
          sql`${bookingParticipants.sessionId} IN (${sql.join(sessionIds.map(id => sql`${id}`), sql`, `)})`,
          sql`LOWER(${users.email}) = ${requestingUserEmail}`
        ));
        
        for (const row of inviteStatuses) {
          if (row.sessionId) {
            inviteStatusMap.set(String(row.sessionId), row.inviteStatus || '');
          }
        }
      }
    }
    
    const memberCountsMap = new Map(memberSlotsCounts.map(m => [m.bookingId, { total: m.totalSlots, filled: m.filledSlots }]));
    const guestCountsMap = new Map(guestCounts.map(g => [g.bookingId, g.count]));
    
    const pendingBookings = result.filter(b => b.status === 'pending' || b.status === 'pending_approval');
    const conflictMap = new Map<number, { hasConflict: boolean; conflictingName: string | null }>();
    
    if (pendingBookings.length > 0) {
      const pendingPairs = pendingBookings
        .filter(b => b.resource_id)
        .map(b => ({ resourceId: b.resource_id!, date: b.request_date, startTime: b.start_time, endTime: b.end_time, id: b.id }));
      
      if (pendingPairs.length > 0) {
        const uniqueDates = [...new Set(pendingPairs.map(p => p.date))];
        const uniqueResourceIds = [...new Set(pendingPairs.map(p => p.resourceId))];
        
        const confirmedBookings = await db.select({
          id: bookingRequests.id,
          resourceId: bookingRequests.resourceId,
          requestDate: bookingRequests.requestDate,
          startTime: bookingRequests.startTime,
          endTime: bookingRequests.endTime,
          userName: bookingRequests.userName
        })
        .from(bookingRequests)
        .where(and(
          sql`${bookingRequests.resourceId} IN (${sql.join(uniqueResourceIds.map(id => sql`${id}`), sql`, `)})`,
          sql`${bookingRequests.requestDate} IN (${sql.join(uniqueDates.map(d => sql`${d}`), sql`, `)})`,
          or(
            eq(bookingRequests.status, 'approved'),
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'attended')
          )
        ));
        
        for (const pending of pendingPairs) {
          const conflicts = confirmedBookings.filter(confirmed => 
            confirmed.resourceId === pending.resourceId &&
            confirmed.requestDate === pending.date &&
            confirmed.id !== pending.id &&
            pending.startTime < confirmed.endTime &&
            pending.endTime > confirmed.startTime
          );
          
          if (conflicts.length > 0) {
            conflictMap.set(pending.id, { 
              hasConflict: true, 
              conflictingName: conflicts[0].userName || null 
            });
          }
        }
      }
    }
    
    const memberDetailsMap = new Map<number, Array<{ name: string; type: 'member'; isPrimary: boolean }>>();
    for (const m of memberDetails) {
      if (!memberDetailsMap.has(m.bookingId)) {
        memberDetailsMap.set(m.bookingId, []);
      }
      if (m.userEmail) {
        const fullName = [m.firstName, m.lastName].filter(Boolean).join(' ');
        memberDetailsMap.get(m.bookingId)!.push({
          name: fullName || m.userEmail,
          type: 'member',
          isPrimary: m.isPrimary || false
        });
      }
    }
    
    const guestDetailsMap = new Map<number, Array<{ name: string; type: 'guest' }>>();
    for (const g of guestDetails) {
      if (!guestDetailsMap.has(g.bookingId)) {
        guestDetailsMap.set(g.bookingId, []);
      }
      guestDetailsMap.get(g.bookingId)!.push({
        name: g.guestName || 'Guest',
        type: 'guest'
      });
    }
    
    const enrichedResult = result.map((booking) => {
      const memberCounts = memberCountsMap.get(booking.id) || { total: 0, filled: 0 };
      const actualGuestCount = guestCountsMap.get(booking.id) || 0;
      
      const legacyGuestCount = booking.guest_count || 0;
      const trackmanPlayerCount = booking.trackman_player_count;
      
      let totalPlayerCount: number;
      if (trackmanPlayerCount && trackmanPlayerCount > 0) {
        totalPlayerCount = trackmanPlayerCount;
      } else if (memberCounts.total > 0) {
        totalPlayerCount = memberCounts.total + actualGuestCount;
      } else {
        totalPlayerCount = Math.max(legacyGuestCount + 1, 1);
      }
      
      const isPrimaryBooker = booking.user_email?.toLowerCase() === requestingUserEmail;
      const isLinkedMember = !isPrimaryBooker && !!requestingUserEmail;
      const primaryBookerName = isLinkedMember ? (booking.user_name || booking.user_email) : null;
      
      const inviteStatus = (isLinkedMember && booking.session_id) 
        ? (inviteStatusMap.get(String(booking.session_id)) || null)
        : null;
      
      const members = memberDetailsMap.get(booking.id) || [];
      const guests = guestDetailsMap.get(booking.id) || [];
      const nonPrimaryMembers = members.filter(m => !m.isPrimary);
      const participants: Array<{ name: string; type: 'member' | 'guest' }> = [
        ...nonPrimaryMembers.map(m => ({ name: m.name, type: 'member' as const })),
        ...guests.map(g => ({ name: g.name, type: 'guest' as const }))
      ];
      
      const conflictInfo = conflictMap.get(booking.id);
      
      return {
        ...booking,
        linked_member_count: memberCounts.filled,
        guest_count: actualGuestCount,
        total_player_count: totalPlayerCount,
        is_linked_member: isLinkedMember || false,
        primary_booker_name: primaryBookerName,
        invite_status: inviteStatus,
        participants,
        has_conflict: conflictInfo?.hasConflict || false,
        conflicting_booking_name: conflictInfo?.conflictingName || null
      };
    });
    
    if (isPaginated) {
      const totalPages = limit ? Math.ceil(totalCount / limit) : 1;
      const currentPage = page || 1;
      res.json({
        data: enrichedResult,
        pagination: {
          total: totalCount,
          page: currentPage,
          limit: limit || enrichedResult.length,
          totalPages,
          hasMore: currentPage < totalPages
        }
      });
    } else {
      res.json(enrichedResult);
    }
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch booking requests', error);
  }
});

router.post('/api/booking-requests', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { 
      user_email, user_name, resource_id, resource_preference, request_date, start_time, 
      duration_minutes, notes, user_tier, declared_player_count, member_notes,
      guardian_name, guardian_relationship, guardian_phone, guardian_consent, request_participants,
      conference_prepayment_id
    } = req.body;
    
    if (!user_email || !request_date || !start_time || !duration_minutes) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const parsedDate = new Date(request_date + 'T00:00:00');
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    
    const [year, month, day] = request_date.split('-').map((n: string) => parseInt(n, 10));
    const validatedDate = new Date(year, month - 1, day);
    if (validatedDate.getFullYear() !== year || 
        validatedDate.getMonth() !== month - 1 || 
        validatedDate.getDate() !== day) {
      return res.status(400).json({ error: 'Invalid date - date does not exist (e.g., Feb 30)' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestEmail = user_email.toLowerCase();
    
    if (sessionEmail !== requestEmail) {
      const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
      if (!hasStaffAccess) {
        return res.status(403).json({ error: 'You can only create booking requests for yourself' });
      }
    }
    
    const isStaffRequest = await isStaffOrAdminCheck(sessionEmail);
    const isViewAsMode = isStaffRequest && sessionEmail !== requestEmail;
    
    if (typeof duration_minutes !== 'number' || !Number.isInteger(duration_minutes) || duration_minutes <= 0 || duration_minutes > 480) {
      return res.status(400).json({ error: 'Invalid duration. Must be a whole number between 1 and 480 minutes.' });
    }
    
    const [hours, mins] = start_time.split(':').map(Number);
    const totalMins = hours * 60 + mins + duration_minutes;
    const endHours = Math.floor(totalMins / 60);
    const endMins = totalMins % 60;
    const end_time = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    
    // Reject cross-midnight bookings (club closes at 10 PM latest)
    // This prevents end_time from wrapping past 24:00
    if (endHours >= 24) {
      return res.status(400).json({ error: 'Booking cannot extend past midnight. Please choose an earlier start time or shorter duration.' });
    }
    
    const client = await pool.connect();
    let row: any;
    // Declare resourceType outside try block so it's available for notifications after transaction
    let resourceType = 'simulator';
    try {
      await client.query('BEGIN');
      
      // Look up resource type FIRST so pending check and linked email check can use it
      if (resource_id) {
        const resourceResult = await client.query(
          `SELECT type FROM resources WHERE id = $1`,
          [resource_id]
        );
        resourceType = resourceResult.rows[0]?.type || 'simulator';
      }
      
      if (!isStaffRequest || isViewAsMode) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          [requestEmail]
        );
        // Skip pending check for conference rooms since they auto-confirm
        if (resourceType !== 'conference_room') {
          const pendingCheck = await client.query(
            `SELECT COUNT(*)::int AS cnt FROM booking_requests
             WHERE LOWER(user_email) = LOWER($1) AND status = 'pending'`,
            [requestEmail]
          );
          if (pendingCheck.rows[0].cnt > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'You already have a pending request. Please wait for it to be approved or denied before requesting another slot.'
            });
          }
        }
      }
      
      await client.query(
        `SELECT id FROM booking_requests 
         WHERE LOWER(user_email) = LOWER($1) 
         AND request_date = $2 
         AND status IN ('pending', 'approved', 'confirmed')
         FOR UPDATE`,
        [user_email, request_date]
      );
      
      const linkedEmailCheck = await client.query(
        `SELECT br.id, br.user_email FROM booking_requests br
         WHERE br.request_date = $1
         AND br.status IN ('pending', 'approved', 'confirmed')
         AND LOWER(br.user_email) != LOWER($2)
         AND EXISTS (
           SELECT 1 FROM resources r2 WHERE r2.id = br.resource_id AND r2.type = $3
         )
         AND EXISTS (
           SELECT 1 FROM users u 
           WHERE LOWER(u.email) = LOWER($2)
           AND (
             LOWER(u.trackman_email) = LOWER(br.user_email)
             OR COALESCE(u.linked_emails, '[]'::jsonb) @> to_jsonb(LOWER(br.user_email)::text)
             OR COALESCE(u.manually_linked_emails, '[]'::jsonb) @> to_jsonb(LOWER(br.user_email)::text)
           )
         )
         LIMIT 1`,
        [request_date, user_email, resourceType]
      );

      if (linkedEmailCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'You already have a booking on this date under a linked account. Please cancel it first or choose a different date.'
        });
      }
      
      // Check for time slot overlap
      if (resource_id) {
        const overlapCheck = await client.query(
          `SELECT id FROM booking_requests 
           WHERE resource_id = $1 
           AND request_date = $2 
           AND status IN ('pending', 'approved', 'confirmed', 'attended')
           AND (
             (start_time < $4 AND end_time > $3) OR
             (end_time < start_time AND (start_time < $4 OR end_time > $3))
           )
           FOR UPDATE`,
          [resource_id, request_date, start_time, end_time]
        );
        
        if (overlapCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This time slot is already booked' });
        }
      }
      
      const limitCheck = await checkDailyBookingLimit(user_email, request_date, duration_minutes, user_tier, resourceType);
      if (!limitCheck.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ 
          error: limitCheck.reason,
          remainingMinutes: limitCheck.remainingMinutes
        });
      }
      
      let sanitizedParticipants: any[] = [];
      if (request_participants && Array.isArray(request_participants)) {
        sanitizedParticipants = request_participants
          .slice(0, 3)
          .map((p: any) => ({
            // Keep email if provided (for new guests entered by email)
            email: typeof p.email === 'string' ? p.email.toLowerCase().trim() : '',
            type: p.type === 'member' ? 'member' : 'guest',
            // CRITICAL: Also store userId and name for directory-selected participants
            // Without this, guests selected from directory were being lost entirely
            userId: typeof p.userId === 'string' ? p.userId : undefined,
            name: typeof p.name === 'string' ? p.name.trim() : undefined
          }))
          // Keep participant if they have email OR userId (directory selection)
          .filter((p: any) => p.email || p.userId);
      }
      
      // FIX: Lookup userId for participants with email but no userId
      // This prevents paid members from being charged guest fees when added by email
      for (const participant of sanitizedParticipants) {
        if (participant.email && !participant.userId) {
          try {
            const [existingUser] = await db.select({ id: users.id }).from(users)
              .where(eq(sql`LOWER(${users.email})`, participant.email.toLowerCase()))
              .limit(1);
            if (existingUser) {
              participant.userId = existingUser.id;
            }
          } catch (err: unknown) {
            console.error(`[Booking] Failed to lookup user for email ${participant.email}:`, err);
          }
        }
        
        // FIX: Also resolve email and name when userId is provided but email is missing
        // This happens when members are selected from the directory (userId set, email undefined)
        if (participant.userId && !participant.email) {
          try {
            const [existingUser] = await db.select({ 
              email: users.email, 
              firstName: users.firstName,
              lastName: users.lastName,
              name: (users as any).name
            }).from(users)
              .where(eq(users.id, participant.userId))
              .limit(1);
            if (existingUser) {
              participant.email = existingUser.email?.toLowerCase() || '';
              // Also set name if not already set
              if (!participant.name) {
                participant.name = (existingUser as any).name || 
                  `${existingUser.firstName || ''} ${existingUser.lastName || ''}`.trim() || 
                  existingUser.email;
              }
              console.log(`[Booking] Resolved email for directory-selected participant: ${participant.email}`);
            }
          } catch (err: unknown) {
            console.error(`[Booking] Failed to lookup email for userId ${participant.userId}:`, err);
          }
        }
      }
      
      for (const participant of sanitizedParticipants) {
        if (participant.userId) {
          const statusCheck = await db.select({ 
            membershipStatus: users.membershipStatus,
            email: users.email,
            name: (users as any).name
          }).from(users)
            .where(eq(users.id, participant.userId))
            .limit(1);
          if (statusCheck.length > 0 && (statusCheck[0].membershipStatus === 'inactive' || statusCheck[0].membershipStatus === 'cancelled')) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
              error: `${statusCheck[0].name || statusCheck[0].email || 'A participant'} has an inactive membership and cannot be added to bookings.`
            });
          }
        }
      }
      
      const seenEmails = new Set<string>();
      const seenUserIds = new Set<string>();
      seenEmails.add(user_email.toLowerCase());
      sanitizedParticipants = sanitizedParticipants.filter((p: any) => {
        if (p.userId && seenUserIds.has(p.userId)) return false;
        if (p.email && seenEmails.has(p.email.toLowerCase())) return false;
        if (p.userId) seenUserIds.add(p.userId);
        if (p.email) seenEmails.add(p.email.toLowerCase());
        return true;
      });
      
      // Conference rooms auto-confirm (no staff approval needed), simulators stay pending
      const isConferenceRoom = resourceType === 'conference_room';
      let initialStatus: 'pending' | 'confirmed' = isConferenceRoom ? 'confirmed' : 'pending';
      let linkedPrepaymentId: number | null = null;
      
      // For conference rooms with overage fees, validate prepayment before confirming
      if (isConferenceRoom) {
        // Calculate overage fees for conference room
        const { getMemberTierByEmail, getTierLimits, getDailyBookedMinutes } = await import('../../core/tierService');
        const { calculateOverageCents } = await import('../../core/billing/pricingConfig');
        
        const tierName = await getMemberTierByEmail(user_email.toLowerCase());
        if (tierName) {
          const tierLimits = await getTierLimits(tierName);
          const dailyAllowance = tierLimits.daily_conf_room_minutes || 0;
          const usedToday = await getDailyBookedMinutes(user_email.toLowerCase(), request_date, 'conference_room');
          const remainingAllowance = Math.max(0, dailyAllowance - usedToday);
          const overageMinutes = Math.max(0, duration_minutes - remainingAllowance);
          const totalCents = calculateOverageCents(overageMinutes);
          
          if (totalCents > 0) {
            // Overage fees apply - require prepayment
            if (!conference_prepayment_id) {
              await client.query('ROLLBACK');
              return res.status(402).json({ 
                error: 'Payment required for conference room overage fees',
                overageMinutes,
                totalCents,
                feeDollars: (totalCents / 100).toFixed(2)
              });
            }
            
            // Validate the prepayment was successful and matches expected amount
            const prepaymentCheck = await client.query(
              `SELECT id, status, amount_cents, duration_minutes FROM conference_prepayments 
               WHERE id = $1 AND member_email = $2 AND booking_date = $3`,
              [conference_prepayment_id, user_email.toLowerCase(), request_date]
            );
            
            if (prepaymentCheck.rows.length === 0) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'Prepayment not found' });
            }
            
            const prepayment = prepaymentCheck.rows[0];
            // Accept both 'succeeded' (credit payment) and 'completed' (card payment after confirm)
            if (prepayment.status !== 'succeeded' && prepayment.status !== 'completed') {
              await client.query('ROLLBACK');
              return res.status(402).json({ error: 'Prepayment not completed. Please complete payment first.' });
            }
            
            // Verify prepayment amount matches expected fee
            if (prepayment.amount_cents < totalCents) {
              await client.query('ROLLBACK');
              return res.status(402).json({ 
                error: 'Prepayment amount insufficient for this booking duration',
                prepaidCents: prepayment.amount_cents,
                requiredCents: totalCents
              });
            }
            
            linkedPrepaymentId = prepayment.id;
          }
        }
      }
      
      const insertResult = await client.query(
        `INSERT INTO booking_requests (
          user_email, user_name, resource_id, resource_preference, 
          request_date, start_time, duration_minutes, end_time, notes,
          declared_player_count, member_notes,
          guardian_name, guardian_relationship, guardian_phone, guardian_consent_at,
          request_participants, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
        RETURNING *`,
        [
          user_email.toLowerCase(),
          user_name,
          resource_id || null,
          resource_preference || null,
          request_date,
          start_time,
          duration_minutes,
          end_time,
          notes || null,
          declared_player_count && declared_player_count >= 1 && declared_player_count <= 4 ? declared_player_count : null,
          member_notes ? String(member_notes).slice(0, 280) : null,
          guardian_consent && guardian_name ? guardian_name : null,
          guardian_consent && guardian_relationship ? guardian_relationship : null,
          guardian_consent && guardian_phone ? guardian_phone : null,
          guardian_consent ? new Date() : null,
          sanitizedParticipants.length > 0 ? JSON.stringify(sanitizedParticipants) : '[]',
          initialStatus
        ]
      );
      
      const guestCount = sanitizedParticipants.filter((p: any) => p.type === 'guest').length;
      if (guestCount > 0) {
        const bookingId = insertResult.rows[0].id;
        const holdResult = await createGuestPassHold(
          user_email.toLowerCase(),
          bookingId,
          guestCount,
          client
        );
        if (!holdResult.success) {
          console.log(`[Booking] Guest pass hold not created (non-blocking): ${holdResult.error}`);
        }
      }
      
      // Link prepayment to booking if conference room with overage fees
      if (linkedPrepaymentId) {
        // Update conference_prepayments with booking_id and get payment references
        const prepaymentUpdate = await client.query(
          `UPDATE conference_prepayments SET booking_id = $1 WHERE id = $2 
           RETURNING credit_reference_id, payment_intent_id`,
          [insertResult.rows[0].id, linkedPrepaymentId]
        );
        
        // Also update stripe_payment_intents so cancellation cascade can find it for refunds
        // credit_reference_id is used for credit payments (balance-xxx), payment_intent_id for card payments (pi_xxx)
        const stripeRef = prepaymentUpdate.rows[0]?.credit_reference_id || prepaymentUpdate.rows[0]?.payment_intent_id;
        if (stripeRef) {
          await client.query(
            `UPDATE stripe_payment_intents SET booking_id = $1, updated_at = NOW() 
             WHERE stripe_payment_intent_id = $2`,
            [insertResult.rows[0].id, stripeRef]
          );
        }
        
        console.log(`[Booking] Linked prepayment ${linkedPrepaymentId} to conference room booking ${insertResult.rows[0].id}`);
      }
      
      await client.query('COMMIT');
      
      const dbRow = insertResult.rows[0];
      row = {
        id: dbRow.id,
        userEmail: dbRow.user_email,
        userName: dbRow.user_name,
        resourceId: dbRow.resource_id,
        resourcePreference: dbRow.resource_preference,
        requestDate: dbRow.request_date,
        startTime: dbRow.start_time,
        durationMinutes: dbRow.duration_minutes,
        endTime: dbRow.end_time,
        notes: dbRow.notes,
        status: dbRow.status,
        rescheduleBookingId: dbRow.reschedule_booking_id,
        declaredPlayerCount: dbRow.declared_player_count,
        memberNotes: dbRow.member_notes,
        guardianName: dbRow.guardian_name,
        guardianRelationship: dbRow.guardian_relationship,
        guardianPhone: dbRow.guardian_phone,
        guardianConsentAt: dbRow.guardian_consent_at,
        requestParticipants: dbRow.request_participants || [],
        createdAt: dbRow.created_at,
        updatedAt: dbRow.updated_at
      };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      try { client.release(); } catch (_) {}
    }
    
    // Ensure session exists for auto-confirmed conference room bookings
    // ensureSessionForBooking handles retries and writes staff_notes on failure internally
    if (resourceType === 'conference_room' && row.resourceId) {
      await ensureSessionForBooking({
        bookingId: row.id,
        resourceId: row.resourceId,
        sessionDate: request_date,
        startTime: start_time,
        endTime: row.endTime || end_time,
        ownerEmail: user_email.toLowerCase(),
        ownerName: user_name || undefined,
        source: 'member_request',
        createdBy: 'conference_room_auto_confirm'
      });
    }

    let resourceName = 'Bay';
    if (row.resourceId) {
      try {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, row.resourceId));
        if (resource?.name) {
          resourceName = resource.name;
        }
      } catch (e: unknown) {
        console.error('[Bookings] Failed to fetch resource name:', e);
      }
    }
    
    // Use the original request_date string (row.requestDate is a Date object from Postgres)
    const dateStr = typeof row.requestDate === 'string' 
      ? row.requestDate 
      : request_date;
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const formattedTime12h = formatTime12Hour(row.startTime?.substring(0, 5) || start_time.substring(0, 5));
    
    const durationMins = row.durationMinutes || duration_minutes;
    let durationDisplay = '';
    if (durationMins) {
      if (durationMins < 60) {
        durationDisplay = `${durationMins} min`;
      } else {
        const hours = durationMins / 60;
        durationDisplay = hours === Math.floor(hours) ? `${hours} hr${hours > 1 ? 's' : ''}` : `${hours.toFixed(1)} hrs`;
      }
    }
    
    const playerCount = declared_player_count && declared_player_count > 1 ? ` (${declared_player_count} players)` : '';
    
    // Conference rooms are auto-confirmed so say "Booking" not "Request"
    const isConfRoom = resourceType === 'conference_room';
    const staffTitle = isConfRoom ? 'New Conference Room Booking' : 'New Golf Booking Request';
    const staffMessage = `${row.userName || row.userEmail}${playerCount} - ${resourceName} on ${formattedDate} at ${formattedTime12h} for ${durationDisplay}`;
    
    // Send response FIRST before any post-commit async operations
    // This ensures the client gets a success response even if notifications fail
    res.status(201).json({
      id: row.id,
      user_email: row.userEmail,
      user_name: row.userName,
      resource_id: row.resourceId,
      resource_preference: row.resourcePreference,
      request_date: row.requestDate,
      start_time: row.startTime,
      duration_minutes: row.durationMinutes,
      end_time: row.endTime,
      notes: row.notes,
      status: row.status,
      staff_notes: row.staffNotes,
      suggested_time: row.suggestedTime,
      reviewed_by: row.reviewedBy,
      reviewed_at: row.reviewedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      calendar_event_id: row.calendarEventId,
      reschedule_booking_id: row.rescheduleBookingId
    });
    
    // All post-commit operations are now AFTER the response is sent
    // Wrap in try/catch so any failures don't crash the server
    try {
      notifyAllStaff(
        staffTitle,
        staffMessage,
        'booking',
        {
          relatedId: row.id,
          relatedType: 'booking_request',
          url: '/admin/bookings',
          sendPush: true
        }
      ).catch(err => console.error('Staff notification failed:', err));
      
      bookingEvents.publish('booking_created', {
        bookingId: row.id,
        memberEmail: row.userEmail,
        memberName: row.userName || undefined,
        resourceId: row.resourceId || undefined,
        resourceName: resourceName,
        bookingDate: row.requestDate,
        startTime: row.startTime,
        durationMinutes: durationMins,
        playerCount: declared_player_count || undefined,
        status: row.status || 'pending',
        actionBy: 'member'
      }, { notifyMember: false, notifyStaff: true }).catch(err => console.error('Booking event publish failed:', err));
      
      broadcastAvailabilityUpdate({
        resourceId: row.resourceId || undefined,
        resourceType: resourceType === 'conference_room' ? 'conference_room' : 'simulator',
        date: row.requestDate,
        action: 'booked'
      });
    } catch (postCommitError: unknown) {
      console.error('[BookingRequest] Post-commit operations failed:', postCommitError);
    }
  } catch (error: unknown) {
    const { isConstraintError } = await import('../../core/db');
    const constraint = isConstraintError(error);
    if (constraint.type === 'unique') {
      return res.status(409).json({ error: 'This time slot may have just been booked. Please refresh and try again.' });
    }
    if (constraint.type === 'foreign_key') {
      return res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
    }
    logAndRespond(req, res, 500, 'Failed to create booking request', error);
  }
});

router.get('/api/booking-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id, 10);
    
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
      user_name: bookingRequests.userName,
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

router.put('/api/booking-requests/:id/member-cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const rawSessionEmail = getSessionUser(req)?.email;
    const sessionUserRole = getSessionUser(req)?.role;
    const userEmail = rawSessionEmail?.toLowerCase();
    
    const actingAsEmail = req.body?.acting_as_email?.toLowerCase();
    const isAdminViewingAs = (sessionUserRole === 'admin' || sessionUserRole === 'staff') && actingAsEmail;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const bookingId = parseInt(id, 10);
    
    const [existing] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      status: bookingRequests.status,
      calendarEventId: bookingRequests.calendarEventId,
      resourceId: bookingRequests.resourceId,
      trackmanBookingId: bookingRequests.trackmanBookingId,
      overagePaymentIntentId: bookingRequests.overagePaymentIntentId,
      overagePaid: bookingRequests.overagePaid,
      staffNotes: bookingRequests.staffNotes
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const bookingEmail = existing.userEmail?.toLowerCase();
    
    const isOwnBooking = bookingEmail === userEmail;
    const isValidViewAs = isAdminViewingAs && bookingEmail === actingAsEmail;
    
    let isLinkedEmail = false;
    if (!isOwnBooking && !isValidViewAs && bookingEmail && userEmail) {
      const linkedCheck = await pool.query(
        `SELECT 1 FROM users 
         WHERE LOWER(email) = $1 
         AND (
           LOWER(trackman_email) = $2
           OR COALESCE(linked_emails, '[]'::jsonb) @> to_jsonb($2::text)
           OR COALESCE(manually_linked_emails, '[]'::jsonb) @> to_jsonb($2::text)
         )
         LIMIT 1`,
        [userEmail, bookingEmail]
      );
      isLinkedEmail = (linkedCheck.rowCount ?? 0) > 0;
    }
    
    if (!isOwnBooking && !isValidViewAs && !isLinkedEmail) {
      console.warn('[Member Cancel] Email mismatch:', { 
        bookingId, 
        bookingEmail: existing.userEmail, 
        sessionEmail: rawSessionEmail,
        actingAsEmail: actingAsEmail || 'none'
      });
      return res.status(403).json({ error: 'You can only cancel your own bookings' });
    }
    
    if (existing.status === 'cancelled' || existing.status === 'declined') {
      return res.status(400).json({ error: 'Booking is already cancelled' });
    }
    
    if (existing.status === 'cancellation_pending') {
      return res.status(400).json({ error: 'Cancellation is already in progress' });
    }
    
    const wasApproved = existing.status === 'approved';
    const isTrackmanLinked = !!existing.trackmanBookingId;
    const needsPendingCancel = wasApproved && isTrackmanLinked;
    
    if (needsPendingCancel) {
      await db.update(bookingRequests)
        .set({
          status: 'cancellation_pending',
          cancellationPendingAt: new Date(),
          staffNotes: existing.staffNotes 
            ? `${existing.staffNotes}\n[Member requested cancellation - awaiting Trackman cancellation]`
            : '[Member requested cancellation - awaiting Trackman cancellation]',
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, bookingId));
      
      logFromRequest(req, 'cancellation_requested', 'booking', id, undefined, {
        member_email: existing.userEmail,
        trackman_booking_id: existing.trackmanBookingId
      });
      
      const memberName = existing.userName || existing.userEmail;
      const bookingDate = existing.requestDate;
      const bookingTime = existing.startTime?.substring(0, 5) || '';
      let bayName = 'Simulator';
      if (existing.resourceId) {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
        if (resource?.name) bayName = resource.name;
      }
      
      const staffMessage = `${memberName} wants to cancel their booking on ${bookingDate} at ${bookingTime} (${bayName}). Please cancel in Trackman to complete the cancellation.`;
      
      notifyAllStaff(
        'Cancellation Request - Cancel in Trackman',
        staffMessage,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/admin/bookings'
        }
      ).catch(err => console.error('Staff cancellation notification failed:', err));
      
      await db.insert(notifications).values({
        userEmail: existing.userEmail || '',
        title: 'Cancellation Request Submitted',
        message: `Your cancellation request for ${bookingDate} at ${bookingTime} has been submitted. You'll be notified once it's fully processed.`,
        type: 'cancellation_pending',
        relatedId: bookingId,
        relatedType: 'booking_request'
      });
      
      await logMemberAction({
        memberEmail: existing.userEmail || '',
        action: 'cancellation_requested',
        resourceType: 'booking',
        resourceId: String(bookingId),
        resourceName: `${bayName} on ${bookingDate}`,
        details: {
          booking_date: bookingDate,
          start_time: bookingTime,
          bay: bayName,
          trackman_booking_id: existing.trackmanBookingId
        }
      });
      
      return res.json({ 
        success: true, 
        status: 'cancellation_pending',
        message: 'Cancellation request submitted. You will be notified once it is fully processed.'
      });
    }
    
    // Calculate time until booking starts using Pacific timezone
    const bookingStart = createPacificDate(existing.requestDate, existing.startTime?.substring(0, 5) || '00:00');
    const nowPacific = new Date();
    const hoursUntilStart = (bookingStart.getTime() - nowPacific.getTime()) / (1000 * 60 * 60);
    const shouldSkipRefund = hoursUntilStart < 1;
    
    let staffNotes = '';
    if (existing.trackmanBookingId) {
      staffNotes = '[Cancelled in app - needs Trackman cancellation]';
    }
    
    const [updated] = await db.update(bookingRequests)
      .set({
        status: 'cancelled',
        staffNotes: staffNotes || undefined,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    await releaseGuestPassHold(bookingId);
    
    logFromRequest(req, 'cancel_booking', 'booking', id, undefined, {
      member_email: existing.userEmail
    });
    
    let refundedAmountCents = 0;
    let refundType: 'none' | 'overage' | 'guest_fees' | 'both' = 'none';
    let refundSkippedDueToLateCancel = false;
    
    let sessionResult: any = null;
    try {
      sessionResult = await pool.query(
        `SELECT bs.id as session_id FROM booking_sessions bs 
         JOIN booking_requests br ON bs.booking_id = br.id
         WHERE br.id = $1`,
        [bookingId]
      );
    } catch (sessionErr: unknown) {
      console.error('[Member Cancel] Failed to fetch session (non-blocking):', sessionErr);
    }
    
    if (!shouldSkipRefund && existing.overagePaymentIntentId) {
      try {
        if (existing.overagePaid) {
          const stripe = await getStripeClient();
          const paymentIntent = await stripe.paymentIntents.retrieve(existing.overagePaymentIntentId);
          if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
            const refund = await stripe.refunds.create({
              charge: paymentIntent.latest_charge as string,
              reason: 'requested_by_customer'
            }, {
              idempotencyKey: `refund_cancel_${bookingId}_${existing.overagePaymentIntentId}`
            });
            refundedAmountCents += refund.amount;
            refundType = 'overage';
            console.log(`[Member Cancel] Refunded overage payment ${existing.overagePaymentIntentId} for booking ${bookingId}, refund: ${refund.id}`);
          }
        } else {
          await cancelPaymentIntent(existing.overagePaymentIntentId);
          console.log(`[Member Cancel] Cancelled overage payment intent ${existing.overagePaymentIntentId} for booking ${bookingId}`);
        }
        await db.update(bookingRequests)
          .set({ overagePaymentIntentId: null, overageFeeCents: 0, overageMinutes: 0 })
          .where(eq(bookingRequests.id, bookingId));
      } catch (paymentErr: unknown) {
        console.error('[Member Cancel] Failed to handle overage payment (non-blocking):', paymentErr);
      }
    }
    
    // Cancel pending payment intents from stripe_payment_intents table
    try {
      const pendingIntents = await pool.query(
        `SELECT stripe_payment_intent_id 
         FROM stripe_payment_intents 
         WHERE booking_id = $1 AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`,
        [bookingId]
      );
      if (pendingIntents.rows.length > 0) {
        for (const row of pendingIntents.rows) {
          try {
            await cancelPaymentIntent(row.stripe_payment_intent_id);
            console.log(`[Member Cancel] Cancelled payment intent ${row.stripe_payment_intent_id} for booking ${bookingId}`);
          } catch (cancelErr: unknown) {
            console.error(`[Member Cancel] Failed to cancel payment intent ${row.stripe_payment_intent_id}:`, getErrorMessage(cancelErr));
          }
        }
      }
    } catch (cancelIntentsErr: unknown) {
      console.error('[Member Cancel] Failed to cancel pending payment intents (non-blocking):', cancelIntentsErr);
    }
    
    // Refund participant payments (guest fees paid via Stripe)
    // Skip refunds if within 1 hour of booking start time (late cancellation policy)
    if (!shouldSkipRefund) {
      try {
        if (sessionResult?.rows[0]?.session_id) {
          const paidParticipants = await pool.query(
            `SELECT id, stripe_payment_intent_id, cached_fee_cents, display_name
             FROM booking_participants 
             WHERE session_id = $1 
             AND payment_status = 'paid' 
             AND stripe_payment_intent_id IS NOT NULL 
             AND stripe_payment_intent_id != ''
             AND stripe_payment_intent_id NOT LIKE 'balance-%'`,
            [sessionResult.rows[0].session_id]
          );
          
          if (paidParticipants.rows.length > 0) {
            const stripe = await getStripeClient();
            for (const participant of paidParticipants.rows) {
              try {
                const pi = await stripe.paymentIntents.retrieve(participant.stripe_payment_intent_id);
                if (pi.status === 'succeeded' && pi.latest_charge) {
                  const refund = await stripe.refunds.create({
                    charge: pi.latest_charge as string,
                    reason: 'requested_by_customer',
                    metadata: {
                      type: 'booking_cancelled',
                      bookingId: bookingId.toString(),
                      participantId: participant.id.toString()
                    }
                  }, {
                    idempotencyKey: `refund_cancel_participant_${bookingId}_${participant.stripe_payment_intent_id}`
                  });
                  refundedAmountCents += refund.amount;
                  refundType = refundType === 'overage' ? 'both' : 'guest_fees';
                  console.log(`[Member Cancel] Refunded guest fee for ${participant.display_name}: $${(participant.cached_fee_cents / 100).toFixed(2)}, refund: ${refund.id}`);
                }
              } catch (refundErr: unknown) {
                console.error(`[Member Cancel] Failed to refund participant ${participant.id}:`, getErrorMessage(refundErr));
              }
            }
          }
        }
      } catch (participantRefundErr: unknown) {
        console.error('[Member Cancel] Failed to process participant refunds (non-blocking):', participantRefundErr);
      }
    } else {
      refundSkippedDueToLateCancel = true;
    }
    
    // Clear pending fees for cancelled booking
    try {
      if (sessionResult?.rows[0]?.session_id) {
        await pool.query(
          `UPDATE booking_participants 
           SET cached_fee_cents = 0, payment_status = 'waived'
           WHERE session_id = $1 
           AND payment_status = 'pending'`,
          [sessionResult.rows[0].session_id]
        );
        console.log(`[Member Cancel] Cleared pending fees for session ${sessionResult.rows[0].session_id}`);
      }
    } catch (feeCleanupErr: unknown) {
      console.error('[Member Cancel] Failed to clear pending fees (non-blocking):', feeCleanupErr);
    }
    
    if (wasApproved) {
      const memberName = existing.userName || existing.userEmail;
      const bookingDate = existing.requestDate;
      const bookingTime = existing.startTime?.substring(0, 5) || '';
      const staffMessage = `${memberName} has cancelled their booking for ${bookingDate} at ${bookingTime}.`;
      
      notifyAllStaff(
        'Booking Cancelled by Member',
        staffMessage,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/admin/bookings'
        }
      ).catch(err => console.error('Staff cancellation notification failed:', err));
      
      if (existing.trackmanBookingId) {
        let bayName = 'Bay';
        if (existing.resourceId) {
          const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
          if (resource?.name) {
            bayName = resource.name;
          }
        }
        
        const trackmanReminderMessage = `Reminder: ${memberName}'s booking on ${bookingDate} at ${bookingTime} (${bayName}) was cancelled - please also cancel in Trackman`;
        
        notifyAllStaff(
          'Trackman Cancellation Required',
          trackmanReminderMessage,
          'booking_cancelled',
          {
            relatedId: bookingId,
            relatedType: 'booking_request',
            url: '/admin/bookings'
          }
        ).catch(err => console.error('Staff trackman cancellation notification failed:', err));
      }
      
      if (existing.calendarEventId) {
        try {
          const calendarName = await getCalendarNameForBayAsync(existing.resourceId);
          if (calendarName) {
            const calendarId = await getCalendarIdByName(calendarName);
            if (calendarId) {
              await deleteCalendarEvent(existing.calendarEventId, calendarId);
            }
          }
        } catch (calError: unknown) {
          console.error('Failed to delete calendar event (non-blocking):', calError);
        }
      }
      
      broadcastAvailabilityUpdate({
        resourceId: existing.resourceId || undefined,
        resourceType: 'simulator',
        date: existing.requestDate,
        action: 'cancelled'
      });
    }
    
    let bayNameForLog = 'Simulator';
    if (existing.resourceId) {
      const [resourceForLog] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
      if (resourceForLog?.name) {
        bayNameForLog = resourceForLog.name;
      }
    }
    
    const bookingDate = existing.requestDate;
    const bookingTime = existing.startTime?.substring(0, 5) || '';
    
    await logMemberAction({
      memberEmail: existing.userEmail || '',
      action: 'booking_cancelled_member',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Booking on ${bookingDate} at ${bookingTime}`,
      details: {
        source: 'member_dashboard',
        booking_date: bookingDate,
        booking_time: existing.startTime,
        bay_name: bayNameForLog,
        had_trackman_booking: !!existing.trackmanBookingId,
        refund_amount_cents: refundedAmountCents || 0,
        refund_type: refundType || 'none'
      },
      req
    });
    
    if (refundSkippedDueToLateCancel) {
      res.json({ 
        success: true, 
        message: 'Booking cancelled successfully. Fees were forfeited due to cancellation within 1 hour of booking start time.',
        refundSkipped: true
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Booking cancelled successfully',
        refundSkipped: false
      });
    }
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to cancel booking', error);
  }
});

// Shared fee calculation logic - uses Unified Fee Service for consistency
async function calculateFeeEstimate(params: {
  ownerEmail: string;
  durationMinutes: number;
  guestCount: number;
  requestDate: string;
  playerCount: number;
  sessionId?: number;
  bookingId?: number;
  resourceType?: string;
  guestsWithInfo?: number;
  memberEmails?: string[];
}) {
  const { ownerEmail, durationMinutes, guestCount, requestDate, playerCount, sessionId, bookingId, resourceType } = params;
  
  const ownerTier = await getMemberTierByEmail(ownerEmail);
  const tierLimits = ownerTier ? await getTierLimits(ownerTier) : null;
  
  // Use conference room minutes for conference room bookings, simulator minutes otherwise
  const isConferenceRoom = resourceType === 'conference_room';
  const dailyAllowance = isConferenceRoom 
    ? (tierLimits?.daily_conf_room_minutes || 0)
    : (tierLimits?.daily_sim_minutes || 0);
  const isUnlimitedTier = dailyAllowance >= 999;
  const isSocialTier = !isConferenceRoom && (tierLimits?.daily_sim_minutes || 0) === 0;
  
  const usedMinutesToday = requestDate ? await getDailyBookedMinutes(ownerEmail, requestDate, isConferenceRoom ? 'conference_room' : 'simulator') : 0;
  const perPersonMins = Math.floor(durationMinutes / playerCount);
  
  // Build participants array for fee computation
  const participants: Array<{
    userId?: string;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
  }> = [
    { email: ownerEmail, displayName: 'Owner', participantType: 'owner' }
  ];
  
  // Add additional members (other club members in the booking)
  // This prevents them from being counted as empty slots (which would charge extra guest fees)
  const memberEmails = params.memberEmails || [];
  const inferredMemberCount = Math.max(0, playerCount - guestCount - 1);
  const memberCount = memberEmails.length > 0 ? memberEmails.length : inferredMemberCount;
  for (let i = 0; i < memberCount; i++) {
    const memberEmail = memberEmails[i] || undefined;
    participants.push({ 
      email: memberEmail, 
      displayName: memberEmail ? `Member ${i + 1}` : `Estimated Member ${i + 1}`, 
      participantType: 'member' 
    });
  }
  
  // Add guests based on count. Guests with actual info entered (name/email) use
  // "Estimated Guest N" naming so passes CAN apply. Empty guest slots (no info)
  // use plain "Guest N" naming which triggers the placeholder check in the billing
  // service, ensuring they are always charged $25 with no guest pass applied.
  // When guestsWithInfo is undefined (staff/session paths), default to all guests
  // being eligible for passes (existing behavior).
  const namedGuestCount = params.guestsWithInfo ?? guestCount;
  for (let i = 0; i < guestCount; i++) {
    if (i < namedGuestCount) {
      participants.push({ displayName: `Estimated Guest ${i + 1}`, participantType: 'guest' });
    } else {
      participants.push({ displayName: `Guest ${i + 1}`, participantType: 'guest' });
    }
  }
  
  try {
    console.log('[FeeEstimate] Calculating for:', {
      ownerEmail,
      ownerTier,
      durationMinutes,
      playerCount,
      perPersonMins,
      dailyAllowance,
      usedMinutesToday,
      isConferenceRoom,
      isUnlimitedTier,
      guestCount,
      requestDate
    });
    
    // Use unified fee service for actual calculation
    // Only use sessionId lookup for existing sessions - use direct params otherwise
    // This handles: 1) member preview (no session), 2) staff checking booking without session
    const breakdown = await computeFeeBreakdown(
      sessionId 
        ? { sessionId, declaredPlayerCount: playerCount, source: 'preview' as const, isConferenceRoom, excludeSessionFromUsage: true }
        : {
            sessionDate: requestDate,
            sessionDuration: durationMinutes,
            declaredPlayerCount: playerCount,
            hostEmail: ownerEmail,
            participants,
            source: 'preview' as const,
            isConferenceRoom,
            bookingId
          }
    );

    if (sessionId && bookingId) {
      try {
        await applyFeeBreakdownToParticipants(sessionId, breakdown);
      } catch (syncErr: unknown) {
        console.warn('[FeeEstimate] Non-blocking cache sync failed:', syncErr);
      }
    }
    
    console.log('[FeeEstimate] Unified breakdown result:', {
      overageCents: breakdown.totals.overageCents,
      guestCents: breakdown.totals.guestCents,
      totalCents: breakdown.totals.totalCents,
      participants: breakdown.participants.map(p => ({
        type: p.participantType,
        tierName: p.tierName,
        dailyAllowance: p.dailyAllowance,
        usedMinutesToday: p.usedMinutesToday,
        minutesAllocated: p.minutesAllocated,
        overageCents: p.overageCents,
        guestCents: p.guestCents
      }))
    });
    
    // Map unified breakdown to legacy response format for backward compatibility
    const overageFee = Math.round(breakdown.totals.overageCents / 100);
    const guestFees = Math.round(breakdown.totals.guestCents / 100);
    const guestsUsingPasses = breakdown.totals.guestPassesUsed;
    const guestsCharged = Math.max(0, guestCount - guestsUsingPasses);
    
    // Calculate overage minutes from the breakdown
    const ownerLineItem = breakdown.participants.find(p => p.participantType === 'owner');
    const overageMinutes = ownerLineItem?.overageCents ? Math.ceil((ownerLineItem.overageCents / 100) / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES : 0;
    
    return {
      ownerEmail,
      ownerTier,
      durationMinutes,
      playerCount,
      perPersonMins,
      tierInfo: {
        dailyAllowance,
        usedMinutesToday,
        remainingMinutes: Math.max(0, dailyAllowance - usedMinutesToday),
        isSocialTier,
        isUnlimitedTier
      },
      feeBreakdown: {
        overageMinutes,
        overageFee,
        guestCount,
        guestPassesRemaining: breakdown.totals.guestPassesAvailable,
        guestsUsingPasses,
        guestsCharged,
        guestFees,
        guestFeePerUnit: Math.round(PRICING.GUEST_FEE_CENTS / 100),
        overageRatePerBlock: Math.round(PRICING.OVERAGE_RATE_CENTS / 100),
      },
      totalFee: Math.round(breakdown.totals.totalCents / 100),
      note: isSocialTier 
        ? 'Social tier pays for all simulator time'
        : isUnlimitedTier 
          ? 'Unlimited access - no overage fees' 
          : overageFee > 0 
            ? `${overageMinutes} min over daily allowance`
            : 'Within daily allowance',
      unifiedBreakdown: breakdown
    };
  } catch (error: unknown) {
    // Do NOT use fallback - this could show incorrect prices
    console.error('[FeeEstimate] Unified service error:', error);
    throw new Error('Unable to calculate fee estimate. Please try again.');
  }
}

// Unified fee estimate endpoint - works for both members (with params) and staff (with booking ID)
router.get('/api/fee-estimate', async (req, res) => {
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
    
    // If bookingId is provided, look up the booking (staff only)
    const bookingId = req.query.bookingId ? parseInt(req.query.bookingId as string) : null;
    
    if (bookingId) {
      if (!isStaff) {
        return res.status(403).json({ error: 'Staff access required' });
      }
      
      const booking = await db.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId)).limit(1);
      if (!booking.length) {
        return res.status(404).json({ error: 'Booking request not found' });
      }
      
      const request = booking[0];
      const declaredPlayerCount = (request as any).declaredPlayerCount || 1;
      
      // Get resource type to determine if this is a conference room booking
      let resourceType = 'simulator';
      if (request.resourceId) {
        const resourceResult = await pool.query(
          `SELECT type FROM resources WHERE id = $1`,
          [request.resourceId]
        );
        resourceType = resourceResult.rows[0]?.type || 'simulator';
      }
      
      // If booking has a session, use actual participant count for accuracy
      let effectivePlayerCount = declaredPlayerCount;
      let guestCount = Math.max(0, declaredPlayerCount - 1);
      
      if ((request as any).sessionId) {
        const participantResult = await pool.query(
          `SELECT 
            COUNT(*) FILTER (WHERE participant_type = 'guest') as guest_count,
            COUNT(*) as total_count
           FROM booking_participants 
           WHERE session_id = $1`,
          [(request as any).sessionId]
        );
        const actualTotal = parseInt(participantResult.rows[0]?.total_count || '0');
        const actualGuests = parseInt(participantResult.rows[0]?.guest_count || '0');
        
        // Use the greater of declared vs actual (staff may have added more players)
        effectivePlayerCount = Math.max(declaredPlayerCount, actualTotal);
        guestCount = actualGuests;
      }
      
      const estimate = await calculateFeeEstimate({
        ownerEmail: request.userEmail?.toLowerCase() || '',
        durationMinutes: request.durationMinutes || 60,
        guestCount,
        requestDate: request.requestDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
        playerCount: effectivePlayerCount,
        sessionId: (request as any).sessionId ? parseInt((request as any).sessionId) : undefined,
        bookingId,
        resourceType
      });
      
      return res.json(estimate);
    }
    
    // Otherwise, use query params (for member preview)
    const durationMinutes = parseInt(req.query.durationMinutes as string) || 60;
    const guestCount = parseInt(req.query.guestCount as string) || 0;
    const playerCount = parseInt(req.query.playerCount as string) || 1;
    const requestDate = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const resourceType = (req.query.resourceType as string) || 'simulator';
    const guestsWithInfo = parseInt(req.query.guestsWithInfo as string) || 0;
    const memberEmailsParam = req.query.memberEmails as string | undefined;
    const memberEmails = memberEmailsParam ? memberEmailsParam.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) : [];
    
    // Members can only check their own fees
    const ownerEmail = isStaff && req.query.email 
      ? (req.query.email as string).toLowerCase() 
      : sessionEmail;
    
    const estimate = await calculateFeeEstimate({
      ownerEmail,
      durationMinutes,
      guestCount,
      requestDate,
      playerCount,
      resourceType,
      memberEmails,
      guestsWithInfo
    });
    
    res.json({ ...estimate, _ts: Date.now() });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to calculate fee estimate', error);
  }
});

// Staff-only endpoint to get fee estimate for existing booking request
router.get('/api/booking-requests/:id/fee-estimate', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const isStaff = await isStaffOrAdminCheck(sessionUser.email?.toLowerCase() || '');
    if (!isStaff) {
      return res.status(403).json({ error: 'Staff access required' });
    }
    
    const bookingId = parseInt(req.params.id);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    const booking = await db.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId)).limit(1);
    if (!booking.length) {
      return res.status(404).json({ error: 'Booking request not found' });
    }
    
    const request = booking[0];
    const declaredPlayerCount = (request as any).declaredPlayerCount || 1;
    
    // Get resource type to determine if this is a conference room booking
    let resourceType = 'simulator';
    if (request.resourceId) {
      const resourceResult = await pool.query(
        `SELECT type FROM resources WHERE id = $1`,
        [request.resourceId]
      );
      resourceType = resourceResult.rows[0]?.type || 'simulator';
    }
    
    // If booking has a session, use actual participant count for accuracy
    let effectivePlayerCount = declaredPlayerCount;
    let guestCount = Math.max(0, declaredPlayerCount - 1);
    
    if ((request as any).sessionId) {
      const participantResult = await pool.query(
        `SELECT 
          COUNT(*) FILTER (WHERE participant_type = 'guest') as guest_count,
          COUNT(*) as total_count
         FROM booking_participants 
         WHERE session_id = $1`,
        [(request as any).sessionId]
      );
      const actualTotal = parseInt(participantResult.rows[0]?.total_count || '0');
      const actualGuests = parseInt(participantResult.rows[0]?.guest_count || '0');
      
      // Use the greater of declared vs actual (staff may have added more players)
      effectivePlayerCount = Math.max(declaredPlayerCount, actualTotal);
      guestCount = actualGuests;
    }
    
    const estimate = await calculateFeeEstimate({
      ownerEmail: request.userEmail?.toLowerCase() || '',
      durationMinutes: request.durationMinutes || 60,
      guestCount,
      requestDate: request.requestDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
      playerCount: effectivePlayerCount,
      sessionId: (request as any).sessionId ? parseInt((request as any).sessionId) : undefined,
      bookingId,
      resourceType
    });
    
    res.json(estimate);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to calculate fee estimate', error);
  }
});

export default router;
