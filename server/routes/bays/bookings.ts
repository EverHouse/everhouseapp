import { Router } from 'express';
import { db } from '../../db';
import { pool } from '../../core/db';
import { bookingRequests, resources, users, bookingMembers, bookingGuests, bookingParticipants, notifications } from '../../../shared/schema';
import { eq, and, or, ne, desc, sql } from 'drizzle-orm';
import { sendPushNotification, sendPushNotificationToStaff } from '../push';
import { checkDailyBookingLimit, getMemberTierByEmail, getTierLimits, getDailyBookedMinutes } from '../../core/tierService';
import { notifyAllStaff } from '../../core/notificationService';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour, createPacificDate } from '../../utils/dateUtils';
import { logAndRespond } from '../../core/logger';
import { bookingEvents } from '../../core/bookingEvents';
import { broadcastAvailabilityUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { cancelPaymentIntent, getStripeClient } from '../../core/stripe';
import { logFromRequest } from '../../core/auditLog';
import { getCalendarNameForBayAsync, isStaffOrAdminCheck } from './helpers';
import { getCalendarIdByName, deleteCalendarEvent } from '../../core/calendar/index';
import { getGuestPassesRemaining } from '../guestPasses';
import { computeFeeBreakdown, getEffectivePlayerCount } from '../../core/billing/unifiedFeeService';

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
      const sessionIds = result.filter(b => b.session_id).map(b => b.session_id as string);
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
            inviteStatusMap.set(row.sessionId, row.inviteStatus || '');
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
        ? (inviteStatusMap.get(booking.session_id) || null)
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
  } catch (error: any) {
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
      duration_minutes, notes, user_tier, reschedule_booking_id, declared_player_count, member_notes,
      guardian_name, guardian_relationship, guardian_phone, guardian_consent, request_participants
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
    
    if (typeof duration_minutes !== 'number' || !Number.isInteger(duration_minutes) || duration_minutes <= 0 || duration_minutes > 480) {
      return res.status(400).json({ error: 'Invalid duration. Must be a whole number between 1 and 480 minutes.' });
    }
    
    let originalBooking: any = null;
    
    if (reschedule_booking_id) {
      const [origBooking] = await db.select()
        .from(bookingRequests)
        .where(eq(bookingRequests.id, reschedule_booking_id));
      
      if (!origBooking) {
        return res.status(400).json({ error: 'Original booking not found' });
      }
      
      if (origBooking.userEmail.toLowerCase() !== requestEmail) {
        return res.status(400).json({ error: 'Original booking does not belong to you' });
      }
      
      const validStatuses = ['approved', 'confirmed', 'pending_approval'];
      if (!validStatuses.includes(origBooking.status || '')) {
        return res.status(400).json({ error: 'Original booking cannot be rescheduled (already cancelled, declined, attended, or no-show)' });
      }
      
      const bookingDateStr = origBooking.requestDate;
      const bookingTimeStr = origBooking.startTime?.substring(0, 5) || '00:00';
      
      const bookingDateTime = createPacificDate(bookingDateStr, bookingTimeStr);
      const now = new Date();
      
      if (bookingDateTime.getTime() <= now.getTime()) {
        return res.status(400).json({ error: 'Cannot reschedule a booking that has already started or passed' });
      }
      
      const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000);
      if (bookingDateTime.getTime() <= thirtyMinutesFromNow.getTime()) {
        return res.status(400).json({ error: 'Cannot reschedule a booking within 30 minutes of its start time' });
      }
      
      const existingReschedule = await db.select({ id: bookingRequests.id, status: bookingRequests.status })
        .from(bookingRequests)
        .where(and(
          eq(bookingRequests.rescheduleBookingId, reschedule_booking_id),
          ne(bookingRequests.status, 'declined'),
          ne(bookingRequests.status, 'cancelled')
        ));
      
      if (existingReschedule.length > 0) {
        return res.status(400).json({ error: 'A reschedule request already exists for this booking' });
      }
      
      originalBooking = origBooking;
    }
    
    const [hours, mins] = start_time.split(':').map(Number);
    const totalMins = hours * 60 + mins + duration_minutes;
    const endHours = Math.floor(totalMins / 60);
    const endMins = totalMins % 60;
    const end_time = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    
    const client = await pool.connect();
    let row: any;
    try {
      await client.query('BEGIN');
      
      await client.query(
        `SELECT id FROM booking_requests 
         WHERE LOWER(user_email) = LOWER($1) 
         AND request_date = $2 
         AND status IN ('pending', 'approved', 'confirmed')
         FOR UPDATE`,
        [user_email, request_date]
      );
      
      if (resource_id) {
        const overlapCheck = await client.query(
          `SELECT id FROM booking_requests 
           WHERE resource_id = $1 
           AND request_date = $2 
           AND status IN ('pending', 'approved', 'confirmed', 'attended')
           AND (
             (start_time < $4 AND end_time > $3)
           )
           FOR UPDATE`,
          [resource_id, request_date, start_time, end_time]
        );
        
        if (overlapCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(409).json({ error: 'This time slot is already booked' });
        }
      }
      
      if (!reschedule_booking_id) {
        const limitCheck = await checkDailyBookingLimit(user_email, request_date, duration_minutes, user_tier);
        if (!limitCheck.allowed) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(403).json({ 
            error: limitCheck.reason,
            remainingMinutes: limitCheck.remainingMinutes
          });
        }
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
      
      const insertResult = await client.query(
        `INSERT INTO booking_requests (
          user_email, user_name, resource_id, resource_preference, 
          request_date, start_time, duration_minutes, end_time, notes,
          reschedule_booking_id, declared_player_count, member_notes,
          guardian_name, guardian_relationship, guardian_phone, guardian_consent_at,
          request_participants, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending', NOW(), NOW())
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
          reschedule_booking_id || null,
          declared_player_count && declared_player_count >= 1 && declared_player_count <= 4 ? declared_player_count : null,
          member_notes ? String(member_notes).slice(0, 280) : null,
          guardian_consent && guardian_name ? guardian_name : null,
          guardian_consent && guardian_relationship ? guardian_relationship : null,
          guardian_consent && guardian_phone ? guardian_phone : null,
          guardian_consent ? new Date() : null,
          sanitizedParticipants.length > 0 ? JSON.stringify(sanitizedParticipants) : '[]'
        ]
      );
      
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
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
    let resourceName = 'Bay';
    if (row.resourceId) {
      try {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, row.resourceId));
        if (resource?.name) {
          resourceName = resource.name;
        }
      } catch (e) {
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
    
    let staffMessage: string;
    let staffTitle: string;
    
    if (originalBooking) {
      const origFormattedDate = formatDateDisplayWithDay(originalBooking.requestDate);
      const origFormattedTime = formatTime12Hour(originalBooking.startTime?.substring(0, 5) || '');
      staffTitle = 'Reschedule Request';
      staffMessage = `${row.userName || row.userEmail}${playerCount} - ${resourceName} moving from ${origFormattedDate} at ${origFormattedTime} to ${formattedDate} at ${formattedTime12h} for ${durationDisplay}`;
      
      db.insert(notifications).values({
        userEmail: row.userEmail,
        title: 'Reschedule Request Submitted',
        message: `${resourceName} on ${formattedDate} at ${formattedTime12h} for ${durationDisplay}`,
        type: 'booking',
        relatedId: row.id,
        relatedType: 'booking_request'
      }).catch(err => console.error('Member notification failed:', err));
    } else {
      staffTitle = 'New Golf Booking Request';
      staffMessage = `${row.userName || row.userEmail}${playerCount} - ${resourceName} on ${formattedDate} at ${formattedTime12h} for ${durationDisplay}`;
    }
    
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
          url: '/#/admin'
        }
      ).catch(err => console.error('Staff in-app notification failed:', err));
      
      sendPushNotificationToStaff({
        title: staffTitle,
        body: staffMessage,
        url: '/#/admin'
      }).catch(err => console.error('Staff push notification failed:', err));
      
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
        resourceType: 'simulator',
        date: row.requestDate,
        action: 'booked'
      });
    } catch (postCommitError) {
      console.error('[BookingRequest] Post-commit operations failed:', postCommitError);
    }
  } catch (error: any) {
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
  } catch (error: any) {
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
      overagePaid: bookingRequests.overagePaid
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
    
    const wasApproved = existing.status === 'approved';
    
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
    
    logFromRequest(req, 'cancel_booking', 'booking', id, {
      member_email: existing.userEmail
    });
    
    if (existing.overagePaymentIntentId) {
      try {
        if (existing.overagePaid) {
          const stripe = await getStripeClient();
          const paymentIntent = await stripe.paymentIntents.retrieve(existing.overagePaymentIntentId);
          if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
            const refund = await stripe.refunds.create({
              charge: paymentIntent.latest_charge as string,
              reason: 'requested_by_customer'
            });
            console.log(`[Member Cancel] Refunded overage payment ${existing.overagePaymentIntentId} for booking ${bookingId}, refund: ${refund.id}`);
          }
        } else {
          await cancelPaymentIntent(existing.overagePaymentIntentId);
          console.log(`[Member Cancel] Cancelled overage payment intent ${existing.overagePaymentIntentId} for booking ${bookingId}`);
        }
        await db.update(bookingRequests)
          .set({ overagePaymentIntentId: null, overageFeeCents: 0, overageMinutes: 0 })
          .where(eq(bookingRequests.id, bookingId));
      } catch (paymentErr) {
        console.error('[Member Cancel] Failed to handle overage payment (non-blocking):', paymentErr);
      }
    }
    
    // Refund participant payments (guest fees paid via Stripe)
    try {
      const sessionResult = await pool.query(
        `SELECT bs.id as session_id FROM booking_sessions bs 
         JOIN booking_requests br ON bs.booking_id = br.id
         WHERE br.id = $1`,
        [bookingId]
      );
      
      if (sessionResult.rows[0]?.session_id) {
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
                });
                console.log(`[Member Cancel] Refunded guest fee for ${participant.display_name}: $${(participant.cached_fee_cents / 100).toFixed(2)}, refund: ${refund.id}`);
              }
            } catch (refundErr: any) {
              console.error(`[Member Cancel] Failed to refund participant ${participant.id}:`, refundErr.message);
            }
          }
        }
      }
    } catch (participantRefundErr) {
      console.error('[Member Cancel] Failed to process participant refunds (non-blocking):', participantRefundErr);
    }
    
    if (wasApproved) {
      const memberName = existing.userName || existing.userEmail;
      const bookingDate = existing.requestDate;
      const bookingTime = existing.startTime?.substring(0, 5) || '';
      const staffMessage = `${memberName} has cancelled their booking for ${bookingDate} at ${bookingTime}.`;
      
      await db.insert(notifications).values({
        userEmail: 'staff@evenhouse.app',
        title: 'Booking Cancelled by Member',
        message: staffMessage,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request'
      });
      
      if (existing.trackmanBookingId) {
        let bayName = 'Bay';
        if (existing.resourceId) {
          const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
          if (resource?.name) {
            bayName = resource.name;
          }
        }
        
        const trackmanReminderMessage = `Reminder: ${memberName}'s booking on ${bookingDate} at ${bookingTime} (${bayName}) was cancelled - please also cancel in Trackman`;
        
        await db.insert(notifications).values({
          userEmail: 'staff@evenhouse.app',
          title: 'Trackman Cancellation Required',
          message: trackmanReminderMessage,
          type: 'booking_cancelled',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });
      }
      
      sendPushNotificationToStaff({
        title: 'Booking Cancelled',
        body: staffMessage,
        url: '/#/staff'
      }).catch(err => console.error('Staff push notification failed:', err));
      
      if (existing.calendarEventId) {
        try {
          const calendarName = await getCalendarNameForBayAsync(existing.resourceId);
          if (calendarName) {
            const calendarId = await getCalendarIdByName(calendarName);
            if (calendarId) {
              await deleteCalendarEvent(existing.calendarEventId, calendarId);
            }
          }
        } catch (calError) {
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
    
    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error: any) {
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
}) {
  const { ownerEmail, durationMinutes, guestCount, requestDate, playerCount, sessionId, bookingId } = params;
  
  const ownerTier = await getMemberTierByEmail(ownerEmail);
  const tierLimits = ownerTier ? await getTierLimits(ownerTier) : null;
  
  const dailyAllowance = tierLimits?.daily_sim_minutes || 0;
  const isSocialTier = ownerTier?.toLowerCase() === 'social';
  const isUnlimitedTier = dailyAllowance >= 999;
  
  const usedMinutesToday = requestDate ? await getDailyBookedMinutes(ownerEmail, requestDate) : 0;
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
  
  // Add guests based on count
  for (let i = 0; i < guestCount; i++) {
    participants.push({ displayName: `Guest ${i + 1}`, participantType: 'guest' });
  }
  
  try {
    // Use unified fee service for actual calculation
    const breakdown = await computeFeeBreakdown(
      sessionId || bookingId 
        ? { sessionId, bookingId, declaredPlayerCount: playerCount, source: 'preview' as const }
        : {
            sessionDate: requestDate,
            sessionDuration: durationMinutes,
            declaredPlayerCount: playerCount,
            hostEmail: ownerEmail,
            participants,
            source: 'preview' as const
          }
    );
    
    // Map unified breakdown to legacy response format for backward compatibility
    const overageFee = Math.round(breakdown.totals.overageCents / 100);
    const guestFees = Math.round(breakdown.totals.guestCents / 100);
    const guestsUsingPasses = breakdown.totals.guestPassesUsed;
    const guestsCharged = Math.max(0, guestCount - guestsUsingPasses);
    
    // Calculate overage minutes from the breakdown
    const ownerLineItem = breakdown.participants.find(p => p.participantType === 'owner');
    const overageMinutes = ownerLineItem?.overageCents ? Math.ceil((ownerLineItem.overageCents / 100) / 25) * 30 : 0;
    
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
        guestFees
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
  } catch (error) {
    // Do NOT use fallback - this could show incorrect prices
    console.error('[FeeEstimate] Unified service error:', error);
    throw new Error('Unable to calculate fee estimate. Please try again.');
  }
}

// Unified fee estimate endpoint - works for both members (with params) and staff (with booking ID)
router.get('/api/fee-estimate', async (req, res) => {
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
        requestDate: request.requestDate || '',
        playerCount: effectivePlayerCount,
        sessionId: (request as any).sessionId ? parseInt((request as any).sessionId) : undefined,
        bookingId
      });
      
      return res.json(estimate);
    }
    
    // Otherwise, use query params (for member preview)
    const durationMinutes = parseInt(req.query.durationMinutes as string) || 60;
    const guestCount = parseInt(req.query.guestCount as string) || 0;
    const playerCount = parseInt(req.query.playerCount as string) || 1;
    const requestDate = (req.query.date as string) || '';
    
    // Members can only check their own fees
    const ownerEmail = isStaff && req.query.email 
      ? (req.query.email as string).toLowerCase() 
      : sessionEmail;
    
    const estimate = await calculateFeeEstimate({
      ownerEmail,
      durationMinutes,
      guestCount,
      requestDate,
      playerCount
    });
    
    res.json(estimate);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to calculate fee estimate', error);
  }
});

// Staff-only endpoint to get fee estimate for existing booking request
router.get('/api/booking-requests/:id/fee-estimate', async (req, res) => {
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
      requestDate: request.requestDate || '',
      playerCount: effectivePlayerCount,
      sessionId: (request as any).sessionId ? parseInt((request as any).sessionId) : undefined,
      bookingId
    });
    
    res.json(estimate);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to calculate fee estimate', error);
  }
});

export default router;
