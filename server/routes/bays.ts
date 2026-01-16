import { Router } from 'express';
import { db } from '../db';
import { pool } from '../core/db';
import { resources, availabilityBlocks, bookingRequests, notifications, facilityClosures, users, bookingMembers, bookingGuests, bookingParticipants, bookingPaymentAudit } from '../../shared/schema';
import { eq, and, or, gte, lte, gt, lt, desc, asc, ne, sql } from 'drizzle-orm';
import { isProduction } from '../core/db';
import { getGoogleCalendarClient } from '../core/integrations';
import { CALENDAR_CONFIG, getCalendarIdByName, createCalendarEvent, createCalendarEventOnCalendar, deleteCalendarEvent, getConferenceRoomBookingsFromCalendar } from '../core/calendar/index';
import { sendPushNotification, sendPushNotificationToStaff } from './push';
import { checkDailyBookingLimit } from '../core/tierService';
import { notifyAllStaff } from '../core/notificationService';
import { isStaffOrAdmin } from '../core/middleware';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour, createPacificDate } from '../utils/dateUtils';
import { parseAffectedAreas } from '../core/affectedAreas';
import { logAndRespond } from '../core/logger';
import { checkClosureConflict, checkAvailabilityBlockConflict, parseTimeToMinutes } from '../core/bookingValidation';
import { bookingEvents } from '../core/bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate, broadcastMemberStatsUpdated, broadcastBillingUpdate } from '../core/websocket';
import { getSessionUser } from '../types/session';
import { refundGuestPass } from './guestPasses';
import { updateHubSpotContactVisitCount } from '../core/memberSync';
import { createSessionWithUsageTracking } from '../core/bookingService/sessionManager';
import { calculateAndCacheParticipantFees } from '../core/billing/feeCalculator';

const router = Router();

// Conference room bay ID constant
const CONFERENCE_ROOM_BAY_ID = 11;

// Helper to get the correct calendar name based on bay ID
// ONLY returns calendar name for conference rooms - golf/simulators no longer sync to calendar
// Uses DB lookup for bay name to check if it's a conference room
async function getCalendarNameForBayAsync(bayId: number | null): Promise<string | null> {
  if (!bayId) return null; // Golf/simulators no longer sync to calendar
  
  try {
    const result = await db.select({ name: resources.name, type: resources.type }).from(resources).where(eq(resources.id, bayId));
    const resourceType = result[0]?.type?.toLowerCase() || '';
    const resourceName = result[0]?.name?.toLowerCase() || '';
    if (resourceType === 'conference_room' || resourceName.includes('conference')) {
      return CALENDAR_CONFIG.conference.name;
    }
  } catch (e) {
    // Fallback to ID check if DB lookup fails
  }
  
  // Fallback: check by known conference room ID, otherwise return null (no calendar sync for golf)
  return bayId === CONFERENCE_ROOM_BAY_ID 
    ? CALENDAR_CONFIG.conference.name 
    : null;
}

// Sync version for simple cases (uses ID check only)
// Returns null for golf/simulators - only conference rooms sync to calendar
function getCalendarNameForBay(bayId: number | null): string | null {
  return bayId === CONFERENCE_ROOM_BAY_ID 
    ? CALENDAR_CONFIG.conference.name 
    : null;
}

// Helper to dismiss all staff notifications for a booking request when it's processed
async function dismissStaffNotificationsForBooking(bookingId: number): Promise<void> {
  try {
    await bookingEvents.cleanupNotificationsForBooking(bookingId, { markRead: true });
  } catch (error) {
    console.error('Failed to dismiss staff notifications:', error);
  }
}


router.get('/api/bays', async (req, res) => {
  try {
    const result = await db.select({
      id: resources.id,
      name: resources.name,
      description: resources.description,
      isActive: sql<boolean>`true`,
      createdAt: resources.createdAt
    }).from(resources).where(eq(resources.type, 'simulator')).orderBy(asc(resources.name));
    res.json(result);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch bays', error);
  }
});

router.get('/api/bays/:bayId/availability', async (req, res) => {
  try {
    const { bayId } = req.params;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    
    const bookingsResult = await db.select({
      start_time: bookingRequests.startTime,
      end_time: bookingRequests.endTime,
      user_name: bookingRequests.userName
    })
    .from(bookingRequests)
    .where(and(
      eq(bookingRequests.resourceId, parseInt(bayId)),
      eq(bookingRequests.requestDate, date as string),
      or(
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'attended')
      )
    ))
    .orderBy(asc(bookingRequests.startTime));
    
    const blocksResult = await db.select({
      start_time: availabilityBlocks.startTime,
      end_time: availabilityBlocks.endTime,
      block_type: availabilityBlocks.blockType,
      notes: availabilityBlocks.notes
    })
    .from(availabilityBlocks)
    .where(and(
      eq(availabilityBlocks.resourceId, parseInt(bayId)),
      eq(availabilityBlocks.blockDate, date as string)
    ))
    .orderBy(asc(availabilityBlocks.startTime));
    
    let calendarBlocks: any[] = [];
    try {
      const calendar = await getGoogleCalendarClient();
      const startTime = new Date(date as string);
      startTime.setHours(0, 0, 0, 0);
      const endTime = new Date(date as string);
      endTime.setHours(23, 59, 59, 999);
      
      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin: startTime.toISOString(),
          timeMax: endTime.toISOString(),
          items: [{ id: 'primary' }],
        },
      });
      
      const busySlots = response.data.calendars?.primary?.busy || [];
      calendarBlocks = busySlots.map((slot: any) => {
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        const startPT = start.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
        const endPT = end.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
        return {
          start_time: startPT,
          end_time: endPT,
          block_type: 'calendar',
          notes: 'Google Calendar event'
        };
      });
    } catch (calError) {
      if (!isProduction) console.log('Calendar availability fetch skipped:', (calError as Error).message);
    }
    
    res.json({
      bookings: bookingsResult,
      blocks: [...blocksResult, ...calendarBlocks]
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch availability', error);
  }
});

async function isStaffOrAdminCheck(email: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
  const isAdmin = await isAdminEmail(email);
  if (isAdmin) return true;
  
  const pool = getAuthPool();
  if (!pool) return false;
  
  try {
    const result = await queryWithRetry(
      pool,
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

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
    
    // Support optional pagination with page/limit or legacy offset/limit
    // Don't force pagination as staff UI currently expects full dataset
    const limit = limitParam ? Math.min(parseInt(limitParam as string), 500) : undefined;
    const page = pageParam ? Math.max(1, parseInt(pageParam as string)) : undefined;
    const offset = page && limit ? (page - 1) * limit : (offsetParam ? parseInt(offsetParam as string) : undefined);
    
    // Determine if pagination metadata should be returned
    // Only return paginated format when `page` is explicitly provided
    // This maintains backwards compatibility for existing callers that only use `limit`
    const isPaginated = !!page;
    
    // Build base query
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
      tier: users.tier,
      guest_count: bookingRequests.guestCount,
      trackman_player_count: bookingRequests.trackmanPlayerCount,
      declared_player_count: bookingRequests.declaredPlayerCount,
      member_notes: bookingRequests.memberNotes,
      session_id: bookingRequests.sessionId
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .leftJoin(users, sql`LOWER(${bookingRequests.userEmail}) = LOWER(${users.email})`)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(bookingRequests.createdAt));
    
    // Apply pagination for staff requests
    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }
    if (offset !== undefined && offset > 0) {
      query = query.offset(offset) as typeof query;
    }
    
    // Get total count for pagination metadata (only when paginated)
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
    
    // Early return if no results
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
    
    // Batch fetch all member/guest counts in single queries instead of N+1
    const bookingIds = result.map(b => b.id);
    const requestingUserEmail = (user_email as string)?.toLowerCase();
    
    // Batch query: Count all member slots per booking using inArray
    const memberSlotsCounts = await db.select({
      bookingId: bookingMembers.bookingId,
      totalSlots: sql<number>`count(*)::int`,
      filledSlots: sql<number>`count(${bookingMembers.userEmail})::int`
    })
    .from(bookingMembers)
    .where(sql`${bookingMembers.bookingId} IN (${sql.join(bookingIds.map(id => sql`${id}`), sql`, `)})`)
    .groupBy(bookingMembers.bookingId);
    
    // Batch query: Count all guests per booking
    const guestCounts = await db.select({
      bookingId: bookingGuests.bookingId,
      count: sql<number>`count(*)::int`
    })
    .from(bookingGuests)
    .where(sql`${bookingGuests.bookingId} IN (${sql.join(bookingIds.map(id => sql`${id}`), sql`, `)})`)
    .groupBy(bookingGuests.bookingId);
    
    // Batch query: Fetch member details (names) for participant display
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
    
    // Batch query: Fetch guest details for participant display
    const guestDetails = await db.select({
      bookingId: bookingGuests.bookingId,
      guestName: bookingGuests.guestName
    })
    .from(bookingGuests)
    .where(sql`${bookingGuests.bookingId} IN (${sql.join(bookingIds.map(id => sql`${id}`), sql`, `)})`);
    
    // Batch query: Get invite statuses for linked members (only for non-staff member requests)
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
    
    // Build lookup maps for O(1) access
    const memberCountsMap = new Map(memberSlotsCounts.map(m => [m.bookingId, { total: m.totalSlots, filled: m.filledSlots }]));
    const guestCountsMap = new Map(guestCounts.map(g => [g.bookingId, g.count]));
    
    // Build participant lookup maps
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
    
    // Enrich results using pre-fetched data
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
      
      // Build participants array (non-primary members and guests)
      const members = memberDetailsMap.get(booking.id) || [];
      const guests = guestDetailsMap.get(booking.id) || [];
      const nonPrimaryMembers = members.filter(m => !m.isPrimary);
      const participants: Array<{ name: string; type: 'member' | 'guest' }> = [
        ...nonPrimaryMembers.map(m => ({ name: m.name, type: 'member' as const })),
        ...guests.map(g => ({ name: g.name, type: 'guest' as const }))
      ];
      
      return {
        ...booking,
        linked_member_count: memberCounts.filled,
        guest_count: actualGuestCount,
        total_player_count: totalPlayerCount,
        is_linked_member: isLinkedMember || false,
        primary_booker_name: primaryBookerName,
        invite_status: inviteStatus,
        participants
      };
    });
    
    // Return with pagination metadata when paginated, otherwise return array for backwards compatibility
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
    
    const { user_email, user_name, resource_id, resource_preference, request_date, start_time, duration_minutes, notes, user_tier, reschedule_booking_id, declared_player_count, member_notes } = req.body;
    
    if (!user_email || !request_date || !start_time || !duration_minutes) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestEmail = user_email.toLowerCase();
    
    if (sessionEmail !== requestEmail) {
      const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
      if (!hasStaffAccess) {
        return res.status(403).json({ error: 'You can only create booking requests for yourself' });
      }
    }
    
    if (typeof duration_minutes !== 'number' || duration_minutes <= 0 || duration_minutes > 480) {
      return res.status(400).json({ error: 'Invalid duration. Must be between 1 and 480 minutes.' });
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
      
      // Only allow rescheduling of approved/confirmed bookings (not attended, declined, cancelled, no_show)
      const validStatuses = ['approved', 'confirmed', 'pending_approval'];
      if (!validStatuses.includes(origBooking.status || '')) {
        return res.status(400).json({ error: 'Original booking cannot be rescheduled (already cancelled, declined, attended, or no-show)' });
      }
      
      // Build Pacific datetime from booking date and start time using proper timezone utilities
      const bookingDateStr = origBooking.requestDate; // YYYY-MM-DD
      const bookingTimeStr = origBooking.startTime?.substring(0, 5) || '00:00'; // HH:MM
      
      // createPacificDate properly handles Pacific timezone and DST
      const bookingDateTime = createPacificDate(bookingDateStr, bookingTimeStr);
      const now = new Date();
      
      // Check if booking has already started or passed
      if (bookingDateTime.getTime() <= now.getTime()) {
        return res.status(400).json({ error: 'Cannot reschedule a booking that has already started or passed' });
      }
      
      // Server-side 30-minute cutoff enforcement
      const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000);
      if (bookingDateTime.getTime() <= thirtyMinutesFromNow.getTime()) {
        return res.status(400).json({ error: 'Cannot reschedule a booking within 30 minutes of its start time' });
      }
      
      // Prevent multiple reschedule requests regardless of status (not just pending)
      // Check for any non-declined, non-cancelled reschedule request
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
    
    if (!reschedule_booking_id) {
      const limitCheck = await checkDailyBookingLimit(user_email, request_date, duration_minutes, user_tier);
      if (!limitCheck.allowed) {
        return res.status(403).json({ 
          error: limitCheck.reason,
          remainingMinutes: limitCheck.remainingMinutes
        });
      }
    }
    
    const [hours, mins] = start_time.split(':').map(Number);
    const totalMins = hours * 60 + mins + duration_minutes;
    const endHours = Math.floor(totalMins / 60);
    const endMins = totalMins % 60;
    const end_time = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    
    const result = await db.insert(bookingRequests).values({
      userEmail: user_email.toLowerCase(),
      userName: user_name,
      resourceId: resource_id || null,
      resourcePreference: resource_preference,
      requestDate: request_date,
      startTime: start_time,
      durationMinutes: duration_minutes,
      endTime: end_time,
      notes: notes,
      rescheduleBookingId: reschedule_booking_id || null,
      declaredPlayerCount: declared_player_count && declared_player_count >= 1 && declared_player_count <= 4 ? declared_player_count : null,
      memberNotes: member_notes ? String(member_notes).slice(0, 280) : null
    }).returning();
    
    const row = result[0];
    
    // Fetch resource name if resource_id is provided
    let resourceName = 'Bay';
    if (row.resourceId) {
      try {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, row.resourceId));
        if (resource?.name) {
          resourceName = resource.name;
        }
      } catch (e) {
        // Keep default 'Bay' if lookup fails
      }
    }
    
    // Send notifications in background - don't block the response
    const formattedDate = formatDateDisplayWithDay(row.requestDate);
    const formattedTime12h = formatTime12Hour(row.startTime?.substring(0, 5) || start_time.substring(0, 5));
    
    // Format duration for display
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
    
    // Include player count if declared
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
    
    // In-app notification to all staff - don't fail booking if this fails
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
    
    // Push notification - already non-blocking
    sendPushNotificationToStaff({
      title: staffTitle,
      body: staffMessage,
      url: '/#/admin'
    }).catch(err => console.error('Staff push notification failed:', err));
    
    // Publish booking event for real-time updates
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
    
    // Broadcast availability update for real-time availability refresh
    broadcastAvailabilityUpdate({
      resourceId: row.resourceId || undefined,
      resourceType: 'simulator',
      date: row.requestDate,
      action: 'booked'
    });
    
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
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to create booking request', error);
  }
});

router.put('/api/booking-requests/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, staff_notes, suggested_time, reviewed_by, resource_id, trackman_booking_id } = req.body;
    
    // If only updating trackman_booking_id (no status change)
    if (trackman_booking_id !== undefined && !status) {
      const bookingId = parseInt(id);
      const [updated] = await db.update(bookingRequests)
        .set({ 
          trackmanBookingId: trackman_booking_id || null,
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, bookingId))
        .returning();
      
      if (!updated) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      return res.json({ 
        success: true, 
        trackman_booking_id: updated.trackmanBookingId,
        message: trackman_booking_id ? 'Trackman ID saved' : 'Trackman ID removed'
      });
    }
    
    if (!['pending', 'approved', 'declined', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const formatRow = (row: any) => ({
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
    
    if (status === 'approved') {
      const bookingId = parseInt(id);
      
      const { updated, bayName, approvalMessage } = await db.transaction(async (tx) => {
        const [req_data] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
        
        if (!req_data) {
          throw { statusCode: 404, error: 'Request not found' };
        }
        
        const assignedBayId = resource_id || req_data.resourceId;
        
        if (!assignedBayId) {
          throw { statusCode: 400, error: 'Bay must be assigned before approval' };
        }
        
        const conflicts = await tx.select().from(bookingRequests).where(and(
          eq(bookingRequests.resourceId, assignedBayId),
          eq(bookingRequests.requestDate, req_data.requestDate),
          or(
            eq(bookingRequests.status, 'approved'),
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'attended')
          ),
          ne(bookingRequests.id, bookingId),
          or(
            and(lte(bookingRequests.startTime, req_data.startTime), gt(bookingRequests.endTime, req_data.startTime)),
            and(lt(bookingRequests.startTime, req_data.endTime), gte(bookingRequests.endTime, req_data.endTime)),
            and(gte(bookingRequests.startTime, req_data.startTime), lte(bookingRequests.endTime, req_data.endTime))
          )
        ));
        
        if (conflicts.length > 0) {
          throw { statusCode: 409, error: 'Time slot conflicts with existing booking' };
        }
        
        const closureCheck = await checkClosureConflict(
          assignedBayId,
          req_data.requestDate,
          req_data.startTime,
          req_data.endTime
        );
        
        if (closureCheck.hasConflict) {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during closure',
            message: `This time slot conflicts with "${closureCheck.closureTitle}". Please decline this request or wait until the closure ends.`
          };
        }
        
        // Also check availability blocks (event blocks)
        const blockCheck = await checkAvailabilityBlockConflict(
          assignedBayId,
          req_data.requestDate,
          req_data.startTime,
          req_data.endTime
        );
        
        if (blockCheck.hasConflict) {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during event block',
            message: `This time slot is blocked: ${blockCheck.blockType || 'Event block'}. Please decline this request or reschedule.`
          };
        }
        
        const bayResult = await tx.select({ name: resources.name, type: resources.type }).from(resources).where(eq(resources.id, assignedBayId));
        const bayName = bayResult[0]?.name || 'Simulator';
        const isConferenceRoom = bayResult[0]?.type === 'conference_room';
        
        // Skip calendar event creation if already linked (e.g., from MindBody sync)
        // Only create calendar events for conference rooms - golf/simulators no longer sync to calendar
        let calendarEventId: string | null = req_data.calendarEventId || null;
        if (!calendarEventId) {
          try {
            const calendarName = await getCalendarNameForBayAsync(assignedBayId);
            // Only sync to calendar if calendarName is returned (conference rooms only)
            if (calendarName) {
              const calendarId = await getCalendarIdByName(calendarName);
              if (calendarId) {
                const summary = `Booking: ${req_data.userName || req_data.userEmail}`;
                const description = `Area: ${bayName}\nMember: ${req_data.userEmail}\nDuration: ${req_data.durationMinutes} minutes${req_data.notes ? '\nNotes: ' + req_data.notes : ''}`;
                calendarEventId = await createCalendarEventOnCalendar(
                  calendarId,
                  summary,
                  description,
                  req_data.requestDate,
                  req_data.startTime,
                  req_data.endTime
                );
              }
            }
          } catch (calError) {
            console.error('Calendar sync failed (non-blocking):', calError);
          }
        }
        
        // Conference room bookings auto check-in (no manual check-in required)
        const finalStatus = isConferenceRoom ? 'attended' : status;
        
        const [updatedRow] = await tx.update(bookingRequests)
          .set({
            status: finalStatus,
            staffNotes: staff_notes,
            suggestedTime: suggested_time,
            reviewedBy: reviewed_by,
            reviewedAt: new Date(),
            resourceId: assignedBayId,
            calendarEventId: calendarEventId,
            ...(trackman_booking_id !== undefined ? { trackmanBookingId: trackman_booking_id || null } : {}),
            updatedAt: new Date()
          })
          .where(eq(bookingRequests.id, bookingId))
          .returning();
        
        // Create booking session, participant, and usage ledger for simulator bookings
        // This enables the Manage Players UI and fee calculations
        let createdSessionId: number | null = null;
        let createdParticipantIds: number[] = [];
        if (!isConferenceRoom && !updatedRow.sessionId) {
          try {
            // Resolve user_id from email if not present on booking_request
            let ownerUserId = updatedRow.userId;
            if (!ownerUserId && updatedRow.userEmail) {
              const userResult = await tx.select({ id: users.id })
                .from(users)
                .where(eq(users.email, updatedRow.userEmail.toLowerCase()))
                .limit(1);
              if (userResult.length > 0) {
                ownerUserId = userResult[0].id;
                // Also update the booking_request with the resolved user_id
                await tx.update(bookingRequests)
                  .set({ userId: ownerUserId })
                  .where(eq(bookingRequests.id, bookingId));
              }
            }
            
            // Use createSessionWithUsageTracking for full billing calculation
            // This creates session, participants, usage_ledger entries, and calculates fees
            const sessionResult = await createSessionWithUsageTracking(
              {
                ownerEmail: updatedRow.userEmail,
                resourceId: assignedBayId,
                sessionDate: updatedRow.requestDate,
                startTime: updatedRow.startTime,
                endTime: updatedRow.endTime,
                durationMinutes: updatedRow.durationMinutes,
                participants: [{
                  userId: ownerUserId || undefined,
                  participantType: 'owner',
                  displayName: updatedRow.userName || updatedRow.userEmail
                }],
                trackmanBookingId: updatedRow.trackmanBookingId || undefined
              },
              'member_request'
            );
            
            if (sessionResult.success && sessionResult.session) {
              createdSessionId = sessionResult.session.id;
              createdParticipantIds = sessionResult.participants?.map(p => p.id) || [];
              
              // Link session to booking request
              await tx.update(bookingRequests)
                .set({ sessionId: createdSessionId })
                .where(eq(bookingRequests.id, bookingId));
              
              console.log(`[Booking Approval] Created session ${createdSessionId} for booking ${bookingId} with ${createdParticipantIds.length} participants, ${sessionResult.usageLedgerEntries || 0} ledger entries`);
            } else {
              console.error(`[Booking Approval] Session creation failed: ${sessionResult.error}`);
            }
          } catch (sessionError) {
            console.error('[Booking Approval] Failed to create session (non-blocking):', sessionError);
          }
        }
        
        // Calculate and cache fees for newly created participants
        if (createdSessionId && createdParticipantIds.length > 0) {
          setImmediate(async () => {
            try {
              await calculateAndCacheParticipantFees(createdSessionId!, createdParticipantIds);
              console.log(`[Booking Approval] Cached fees for session ${createdSessionId}`);
            } catch (feeError) {
              console.error('[Booking Approval] Failed to cache fees (non-blocking):', feeError);
            }
          });
        }
        
        const isReschedule = !!updatedRow.rescheduleBookingId;
        const approvalMessage = isReschedule
          ? `Reschedule approved - your booking is now ${formatNotificationDateTime(updatedRow.requestDate, updatedRow.startTime)}`
          : `Your simulator booking for ${formatNotificationDateTime(updatedRow.requestDate, updatedRow.startTime)} has been approved.`;
        
        await tx.insert(notifications).values({
          userEmail: updatedRow.userEmail,
          title: isReschedule ? 'Reschedule Approved' : 'Booking Request Approved',
          message: approvalMessage,
          type: 'booking_approved',
          relatedId: updatedRow.id,
          relatedType: 'booking_request'
        });
        
        await tx.update(notifications)
          .set({ isRead: true })
          .where(and(
            eq(notifications.relatedId, bookingId),
            eq(notifications.relatedType, 'booking_request'),
            eq(notifications.type, 'booking')
          ));
        
        return { updated: updatedRow, bayName, approvalMessage };
      });
      
      if (updated.rescheduleBookingId) {
        try {
          const [originalBooking] = await db.select({
            id: bookingRequests.id,
            calendarEventId: bookingRequests.calendarEventId,
            resourceId: bookingRequests.resourceId
          })
            .from(bookingRequests)
            .where(eq(bookingRequests.id, updated.rescheduleBookingId));
          
          if (originalBooking) {
            await db.update(bookingRequests)
              .set({ status: 'cancelled', updatedAt: new Date() })
              .where(eq(bookingRequests.id, originalBooking.id));
            
            if (originalBooking.calendarEventId) {
              try {
                const calendarName = await getCalendarNameForBayAsync(originalBooking.resourceId);
                // Only delete calendar event if calendarName is returned (conference rooms only)
                if (calendarName) {
                  const calendarId = await getCalendarIdByName(calendarName);
                  if (calendarId) {
                    await deleteCalendarEvent(originalBooking.calendarEventId, calendarId);
                  }
                }
              } catch (calError) {
                console.error('Failed to delete original booking calendar event (non-blocking):', calError);
              }
            }
          }
        } catch (rescheduleError) {
          console.error('Failed to cancel original booking during reschedule approval:', rescheduleError);
        }
      }
      
      sendPushNotification(updated.userEmail, {
        title: updated.rescheduleBookingId ? 'Reschedule Approved!' : 'Booking Approved!',
        body: approvalMessage,
        url: '/#/sims'
      }).catch(err => console.error('Push notification failed:', err));
      
      // Notify linked members (non-primary members in booking_members)
      (async () => {
        try {
          const linkedMembers = await db.select({ userEmail: bookingMembers.userEmail })
            .from(bookingMembers)
            .where(and(
              eq(bookingMembers.bookingId, parseInt(id)),
              sql`${bookingMembers.userEmail} IS NOT NULL`,
              sql`${bookingMembers.isPrimary} IS NOT TRUE`
            ));
          
          for (const member of linkedMembers) {
            if (member.userEmail && member.userEmail.toLowerCase() !== updated.userEmail.toLowerCase()) {
              const linkedMessage = `A booking you're part of has been confirmed for ${formatNotificationDateTime(updated.requestDate, updated.startTime)}.`;
              
              // Insert database notification
              await db.insert(notifications).values({
                userEmail: member.userEmail,
                title: 'Booking Confirmed',
                message: linkedMessage,
                type: 'booking_approved',
                relatedId: parseInt(id),
                relatedType: 'booking_request'
              });
              
              // Send push notification
              sendPushNotification(member.userEmail, {
                title: 'Booking Confirmed',
                body: linkedMessage,
                tag: `booking-approved-linked-${id}`
              }).catch(() => {});
              
              // Send WebSocket notification
              sendNotificationToUser(member.userEmail, {
                type: 'notification',
                title: 'Booking Confirmed',
                message: linkedMessage,
                data: { bookingId: parseInt(id), eventType: 'booking_approved' }
              }, { action: 'booking_approved_linked', bookingId: parseInt(id), triggerSource: 'bays.ts' });
            }
          }
        } catch (err) {
          console.error('Failed to notify linked members:', err);
        }
      })();
      
      // Publish booking approved event for real-time updates
      bookingEvents.publish('booking_approved', {
        bookingId: parseInt(id),
        memberEmail: updated.userEmail,
        memberName: updated.userName || undefined,
        resourceId: updated.resourceId || undefined,
        resourceName: bayName,
        bookingDate: updated.requestDate,
        startTime: updated.startTime,
        endTime: updated.endTime,
        status: 'approved',
        actionBy: 'staff'
      }, { notifyMember: true, notifyStaff: true, cleanupNotifications: true }).catch(err => console.error('Booking event publish failed:', err));
      
      // Broadcast availability update for real-time availability refresh
      broadcastAvailabilityUpdate({
        resourceId: updated.resourceId || undefined,
        resourceType: 'simulator',
        date: updated.requestDate,
        action: 'booked'
      });
      
      // Send WebSocket notification to member (DB notification already inserted in transaction)
      sendNotificationToUser(updated.userEmail, {
        type: 'notification',
        title: updated.rescheduleBookingId ? 'Reschedule Approved' : 'Booking Approved',
        message: approvalMessage,
        data: { bookingId: parseInt(id), eventType: 'booking_approved' }
      }, { action: 'booking_approved', bookingId: parseInt(id), triggerSource: 'bays.ts' });
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'declined') {
      const bookingId = parseInt(id);
      
      const { updated, declineMessage, isReschedule } = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
        
        if (!existing) {
          throw { statusCode: 404, error: 'Booking request not found' };
        }
        
        const [updatedRow] = await tx.update(bookingRequests)
          .set({
            status: status,
            staffNotes: staff_notes,
            suggestedTime: suggested_time,
            reviewedBy: reviewed_by,
            reviewedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(bookingRequests.id, bookingId))
          .returning();
        
        const isReschedule = !!updatedRow.rescheduleBookingId;
        let declineMessage: string;
        let notificationTitle: string;
        
        if (isReschedule) {
          const [originalBooking] = await tx.select({
            requestDate: bookingRequests.requestDate,
            startTime: bookingRequests.startTime
          })
            .from(bookingRequests)
            .where(eq(bookingRequests.id, updatedRow.rescheduleBookingId!));
          
          if (originalBooking) {
            const origDateTime = formatNotificationDateTime(originalBooking.requestDate, originalBooking.startTime);
            declineMessage = `Reschedule declined - your original booking for ${origDateTime} remains active`;
          } else {
            declineMessage = `Reschedule declined - your original booking remains active`;
          }
          notificationTitle = 'Reschedule Declined';
        } else {
          declineMessage = suggested_time 
            ? `Your simulator booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined. Suggested alternative: ${formatTime12Hour(suggested_time)}`
            : `Your simulator booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined.`;
          notificationTitle = 'Booking Request Declined';
        }
        
        await tx.insert(notifications).values({
          userEmail: updatedRow.userEmail,
          title: notificationTitle,
          message: declineMessage,
          type: 'booking_declined',
          relatedId: updatedRow.id,
          relatedType: 'booking_request'
        });
        
        await tx.update(notifications)
          .set({ isRead: true })
          .where(and(
            eq(notifications.relatedId, bookingId),
            eq(notifications.relatedType, 'booking_request'),
            eq(notifications.type, 'booking')
          ));
        
        return { updated: updatedRow, declineMessage, isReschedule };
      });
      
      sendPushNotification(updated.userEmail, {
        title: isReschedule ? 'Reschedule Declined' : 'Booking Request Update',
        body: declineMessage,
        url: '/#/sims'
      }).catch(err => console.error('Push notification failed:', err));
      
      // Publish booking declined event for real-time updates
      bookingEvents.publish('booking_declined', {
        bookingId: parseInt(id),
        memberEmail: updated.userEmail,
        memberName: updated.userName || undefined,
        bookingDate: updated.requestDate,
        startTime: updated.startTime,
        status: 'declined',
        actionBy: 'staff'
      }, { notifyMember: true, notifyStaff: true, cleanupNotifications: true }).catch(err => console.error('Booking event publish failed:', err));
      
      // Send WebSocket notification to member (DB notification already inserted in transaction)
      sendNotificationToUser(updated.userEmail, {
        type: 'notification',
        title: isReschedule ? 'Reschedule Declined' : 'Booking Declined',
        message: declineMessage,
        data: { bookingId: parseInt(id), eventType: 'booking_declined' }
      }, { action: 'booking_declined', bookingId: parseInt(id), triggerSource: 'bays.ts' });
      
      return res.json(formatRow(updated));
    }
    
    if (status === 'cancelled') {
      const bookingId = parseInt(id);
      const { cancelled_by } = req.body;
      
      const { updated, bookingData, pushInfo } = await db.transaction(async (tx) => {
        const [existing] = await tx.select({
          id: bookingRequests.id,
          calendarEventId: bookingRequests.calendarEventId,
          userEmail: bookingRequests.userEmail,
          userName: bookingRequests.userName,
          requestDate: bookingRequests.requestDate,
          startTime: bookingRequests.startTime,
          status: bookingRequests.status,
          resourceId: bookingRequests.resourceId
        })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, bookingId));
        
        if (!existing) {
          throw { statusCode: 404, error: 'Booking request not found' };
        }
        
        const [updatedRow] = await tx.update(bookingRequests)
          .set({
            status: status,
            staffNotes: staff_notes || undefined,
            updatedAt: new Date()
          })
          .where(eq(bookingRequests.id, bookingId))
          .returning();
        
        // Refund guest passes for any guests in this booking
        // Check if booking has a session with guest participants
        const sessionResult = await tx.select({ sessionId: bookingRequests.sessionId })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, bookingId));
        
        if (sessionResult[0]?.sessionId) {
          const guestParticipants = await tx.select({ id: bookingParticipants.id, displayName: bookingParticipants.displayName })
            .from(bookingParticipants)
            .where(and(
              eq(bookingParticipants.sessionId, sessionResult[0].sessionId),
              eq(bookingParticipants.participantType, 'guest')
            ));
          
          // Refund one guest pass for each guest participant
          for (const guest of guestParticipants) {
            await refundGuestPass(existing.userEmail, guest.displayName || undefined, false);
          }
          
          if (guestParticipants.length > 0) {
            console.log(`[bays] Refunded ${guestParticipants.length} guest pass(es) for cancelled booking ${bookingId}`);
          }
        }
        
        let pushInfo: { type: 'staff' | 'member' | 'both'; email?: string; staffMessage?: string; memberMessage?: string; message: string } | null = null;
        
        const memberEmail = existing.userEmail;
        const memberName = existing.userName || memberEmail;
        const bookingDate = existing.requestDate;
        const memberCancelled = cancelled_by === memberEmail;
        const wasApproved = existing.status === 'approved';
        
        const friendlyDateTime = formatNotificationDateTime(bookingDate, existing.startTime || '00:00');
        const statusLabel = wasApproved ? 'booking' : 'booking request';
        
        if (memberCancelled) {
          const staffMessage = `${memberName} has cancelled their ${statusLabel} for ${friendlyDateTime}.`;
          const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled.`;
          
          await tx.insert(notifications).values({
            userEmail: 'staff@evenhouse.app',
            title: 'Booking Cancelled by Member',
            message: staffMessage,
            type: 'booking_cancelled',
            relatedId: bookingId,
            relatedType: 'booking_request'
          });
          
          await tx.insert(notifications).values({
            userEmail: memberEmail,
            title: 'Booking Cancelled',
            message: memberMessage,
            type: 'booking_cancelled',
            relatedId: bookingId,
            relatedType: 'booking_request'
          });
          
          pushInfo = { type: 'both', email: memberEmail, staffMessage, memberMessage, message: staffMessage };
        } else {
          const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled by staff.`;
          
          await tx.insert(notifications).values({
            userEmail: memberEmail,
            title: 'Booking Cancelled',
            message: memberMessage,
            type: 'booking_cancelled',
            relatedId: bookingId,
            relatedType: 'booking_request'
          });
          
          pushInfo = { type: 'member', email: memberEmail, message: memberMessage };
        }
        
        await tx.update(notifications)
          .set({ isRead: true })
          .where(and(
            eq(notifications.relatedId, bookingId),
            eq(notifications.relatedType, 'booking_request'),
            eq(notifications.type, 'booking')
          ));
        
        return { updated: updatedRow, bookingData: existing, pushInfo };
      });
      
      if (bookingData?.calendarEventId) {
        try {
          const calendarName = await getCalendarNameForBayAsync(bookingData.resourceId);
          // Only delete calendar event if calendarName is returned (conference rooms only)
          if (calendarName) {
            const calendarId = await getCalendarIdByName(calendarName);
            if (calendarId) {
              await deleteCalendarEvent(bookingData.calendarEventId, calendarId);
            }
          }
        } catch (calError) {
          console.error('Failed to delete calendar event (non-blocking):', calError);
        }
      }
      
      if (pushInfo) {
        if (pushInfo.type === 'both') {
          sendPushNotificationToStaff({
            title: 'Booking Cancelled',
            body: pushInfo.staffMessage || pushInfo.message,
            url: '/#/staff'
          }).catch(err => console.error('Staff push notification failed:', err));
          if (pushInfo.email) {
            sendPushNotification(pushInfo.email, {
              title: 'Booking Cancelled',
              body: pushInfo.memberMessage || pushInfo.message,
              url: '/#/sims'
            }).catch(err => console.error('Member push notification failed:', err));
          }
        } else if (pushInfo.type === 'staff') {
          sendPushNotificationToStaff({
            title: 'Booking Cancelled',
            body: pushInfo.message,
            url: '/#/staff'
          }).catch(err => console.error('Staff push notification failed:', err));
        } else if (pushInfo.email) {
          sendPushNotification(pushInfo.email, {
            title: 'Booking Cancelled',
            body: pushInfo.message,
            url: '/#/sims'
          }).catch(err => console.error('Member push notification failed:', err));
        }
      }
      
      // Publish booking cancelled event for real-time updates
      // Note: notifyMember is false because we already created the notification in the transaction above
      // cleanupNotifications is false to preserve the cancellation notification we just created
      const cancelledBy = pushInfo?.type === 'both' ? 'member' : 'staff';
      bookingEvents.publish('booking_cancelled', {
        bookingId: parseInt(id),
        memberEmail: bookingData.userEmail,
        memberName: bookingData.userName || undefined,
        resourceId: bookingData.resourceId || undefined,
        bookingDate: bookingData.requestDate,
        startTime: bookingData.startTime,
        status: 'cancelled',
        actionBy: cancelledBy
      }, { notifyMember: false, notifyStaff: true, cleanupNotifications: false }).catch(err => console.error('Booking event publish failed:', err));
      
      // Broadcast availability update for real-time availability refresh
      broadcastAvailabilityUpdate({
        resourceId: bookingData.resourceId || undefined,
        resourceType: 'simulator',
        date: bookingData.requestDate,
        action: 'cancelled'
      });
      
      // Send WebSocket notification to member (DB notification already inserted in transaction)
      if (pushInfo?.email && (pushInfo.type === 'member' || pushInfo.type === 'both')) {
        sendNotificationToUser(pushInfo.email, {
          type: 'notification',
          title: 'Booking Cancelled',
          message: pushInfo.memberMessage || pushInfo.message,
          data: { bookingId: parseInt(id), eventType: 'booking_cancelled' }
        }, { action: 'booking_cancelled', bookingId: parseInt(id), triggerSource: 'bays.ts' });
      }
      
      return res.json(formatRow(updated));
    }
    
    const result = await db.update(bookingRequests)
      .set({
        status: status,
        staffNotes: staff_notes || undefined,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, parseInt(id)))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking request not found' });
    }
    
    res.json(formatRow(result[0]));
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ 
        error: error.error, 
        message: error.message 
      });
    }
    logAndRespond(req, res, 500, 'Failed to update booking request', error);
  }
});

router.put('/api/booking-requests/:id/member-cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const rawSessionEmail = getSessionUser(req)?.email;
    const sessionUserRole = getSessionUser(req)?.role;
    const userEmail = rawSessionEmail?.toLowerCase();
    
    // Check for admin "View As" mode - get the impersonated user's email from request body
    const actingAsEmail = req.body?.acting_as_email?.toLowerCase();
    const isAdminViewingAs = (sessionUserRole === 'admin' || sessionUserRole === 'staff') && actingAsEmail;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const bookingId = parseInt(id);
    
    const [existing] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      status: bookingRequests.status,
      calendarEventId: bookingRequests.calendarEventId,
      resourceId: bookingRequests.resourceId
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const bookingEmail = existing.userEmail?.toLowerCase();
    
    // Allow cancel if: (1) session user owns the booking, OR (2) admin/staff is viewing as the booking owner
    const isOwnBooking = bookingEmail === userEmail;
    const isValidViewAs = isAdminViewingAs && bookingEmail === actingAsEmail;
    
    if (!isOwnBooking && !isValidViewAs) {
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
    
    const [updated] = await db.update(bookingRequests)
      .set({
        status: 'cancelled',
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
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
      
      sendPushNotificationToStaff({
        title: 'Booking Cancelled',
        body: staffMessage,
        url: '/#/staff'
      }).catch(err => console.error('Staff push notification failed:', err));
      
      if (existing.calendarEventId) {
        try {
          const calendarName = await getCalendarNameForBayAsync(existing.resourceId);
          // Only delete calendar event if calendarName is returned (conference rooms only)
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
      
      // Broadcast availability update for real-time availability refresh
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

router.put('/api/bookings/:id/checkin', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status: targetStatus, confirmPayment, skipPaymentCheck } = req.body;
    const bookingId = parseInt(id);
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'unknown';
    const staffName = sessionUser?.name || null;
    
    // Validate the target status - must be 'attended' or 'no_show'
    const validStatuses = ['attended', 'no_show'];
    const newStatus = validStatuses.includes(targetStatus) ? targetStatus : 'attended';
    
    // First check the current booking status and session
    const existingResult = await pool.query(`
      SELECT br.status, br.user_email, br.session_id
      FROM booking_requests br
      WHERE br.id = $1
    `, [bookingId]);
    
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const existing = existingResult.rows[0];
    const currentStatus = existing.status;
    
    // Idempotent - skip if already at target status
    if (currentStatus === newStatus) {
      return res.json({ success: true, message: `Already marked as ${newStatus}`, alreadyProcessed: true });
    }
    
    // Only allow status change from approved or confirmed
    if (currentStatus !== 'approved' && currentStatus !== 'confirmed') {
      return res.status(400).json({ error: `Cannot update booking with status: ${currentStatus}` });
    }
    
    // ROSTER GUARD: Check for empty player slots before allowing check-in
    const { skipRosterCheck } = req.body;
    if (newStatus === 'attended' && !skipRosterCheck) {
      const rosterResult = await pool.query(`
        SELECT 
          br.trackman_player_count,
          br.declared_player_count,
          (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id) as total_slots,
          (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NULL) as empty_slots
        FROM booking_requests br
        WHERE br.id = $1
      `, [bookingId]);
      
      if (rosterResult.rows.length > 0) {
        const roster = rosterResult.rows[0];
        const declaredCount = roster.trackman_player_count || roster.declared_player_count || 1;
        const emptySlots = parseInt(roster.empty_slots) || 0;
        const totalSlots = parseInt(roster.total_slots) || 0;
        
        if (emptySlots > 0 && declaredCount > 1) {
          return res.status(402).json({
            error: 'Roster incomplete',
            requiresRoster: true,
            emptySlots,
            totalSlots,
            declaredPlayerCount: declaredCount,
            message: `${emptySlots} player slot${emptySlots > 1 ? 's' : ''} not assigned. Staff must link members or add guests before check-in to ensure proper billing.`
          });
        }
      }
    }
    
    // PAYMENT GUARD: Check for unpaid balance before marking as attended
    // First, warn staff if billing session hasn't been synced yet
    if (newStatus === 'attended' && !existing.session_id && !skipPaymentCheck) {
      return res.status(400).json({
        error: 'Billing session not generated yet',
        requiresSync: true,
        message: 'Billing session not generated yet - Check Trackman Sync. The session may need to be synced from Trackman before check-in to ensure proper billing.'
      });
    }
    
    if (newStatus === 'attended' && existing.session_id && !skipPaymentCheck) {
      const balanceResult = await pool.query(`
        SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.payment_status,
          COALESCE(ul.overage_fee, 0)::numeric as overage_fee,
          COALESCE(ul.guest_fee, 0)::numeric as guest_fee
        FROM booking_participants bp
        LEFT JOIN users pu ON pu.id = bp.user_id
        LEFT JOIN booking_requests br ON br.session_id = bp.session_id
        LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
          AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email) OR LOWER(ul.member_id) = LOWER(br.user_email))
        WHERE bp.session_id = $1 AND bp.payment_status = 'pending'
      `, [existing.session_id]);
      
      let totalOutstanding = 0;
      const unpaidParticipants: Array<{ id: number; name: string; amount: number }> = [];
      
      for (const p of balanceResult.rows) {
        const amount = parseFloat(p.overage_fee) + parseFloat(p.guest_fee);
        if (amount > 0) {
          totalOutstanding += amount;
          unpaidParticipants.push({
            id: p.participant_id,
            name: p.display_name,
            amount
          });
        }
      }
      
      if (totalOutstanding > 0 && !confirmPayment) {
        // Log the guard trigger
        await pool.query(`
          INSERT INTO booking_payment_audit 
            (booking_id, session_id, action, staff_email, staff_name, amount_affected, metadata)
          VALUES ($1, $2, 'checkin_guard_triggered', $3, $4, $5, $6)
        `, [
          bookingId,
          existing.session_id,
          staffEmail,
          staffName,
          totalOutstanding,
          JSON.stringify({ unpaidParticipants })
        ]);
        
        return res.status(402).json({ 
          error: 'Payment required',
          requiresPayment: true,
          totalOutstanding,
          unpaidParticipants,
          message: `Outstanding balance of $${totalOutstanding.toFixed(2)}. Has the member paid?`
        });
      }
      
      // If confirmPayment is true, mark all pending participants as paid
      if (confirmPayment && totalOutstanding > 0) {
        for (const p of unpaidParticipants) {
          await pool.query(
            `UPDATE booking_participants SET payment_status = 'paid' WHERE id = $1`,
            [p.id]
          );
          
          await pool.query(`
            INSERT INTO booking_payment_audit 
              (booking_id, session_id, participant_id, action, staff_email, staff_name, amount_affected, previous_status, new_status)
            VALUES ($1, $2, $3, 'payment_confirmed', $4, $5, $6, 'pending', 'paid')
          `, [bookingId, existing.session_id, p.id, staffEmail, staffName, p.amount]);
        }
        
        broadcastBillingUpdate({
          action: 'booking_payment_updated',
          bookingId,
          sessionId: existing.session_id,
          memberEmail: existing.user_email,
          amount: totalOutstanding * 100
        });
      }
    }
    
    // Update booking request status
    const result = await db.update(bookingRequests)
      .set({
        status: newStatus,
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        or(
          eq(bookingRequests.status, 'approved'),
          eq(bookingRequests.status, 'confirmed')
        )
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(400).json({ error: 'Booking status changed before update' });
    }
    
    // Increment lifetime visits for the member only if marked as attended
    const booking = result[0];
    if (newStatus === 'attended' && booking.userEmail) {
      // Update local database
      const updateResult = await pool.query<{ lifetime_visits: number; hubspot_id: string | null }>(
        `UPDATE users 
         SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
         WHERE email = $1
         RETURNING lifetime_visits, hubspot_id`,
        [booking.userEmail]
      );
      
      // Push updated visit count to HubSpot if contact has hubspot_id
      const updatedUser = updateResult.rows[0];
      if (updatedUser?.hubspot_id && updatedUser.lifetime_visits) {
        updateHubSpotContactVisitCount(updatedUser.hubspot_id, updatedUser.lifetime_visits)
          .catch(err => console.error('[Bays] Failed to sync visit count to HubSpot:', err));
      }
      
      // Broadcast stats update to all connected clients
      if (updatedUser?.lifetime_visits) {
        broadcastMemberStatsUpdated(booking.userEmail, {
          lifetimeVisits: updatedUser.lifetime_visits
        });
      }
    }
    
    res.json({ success: true, booking: result[0] });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to update booking status', error);
  }
});

// Get conference room bookings from Google Calendar (Mindbody bookings)
router.get('/api/conference-room-bookings', async (req, res) => {
  try {
    const { member_name, member_email } = req.query;
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // If no member name/email provided, use the session user's info
    const searchName = member_name as string || sessionUser.name || undefined;
    const searchEmail = member_email as string || sessionUser.email || undefined;
    
    const bookings = await getConferenceRoomBookingsFromCalendar(searchName, searchEmail);
    
    // Transform to match booking format expected by frontend
    const formattedBookings = bookings.map(booking => ({
      id: `cal_${booking.id}`,
      source: 'calendar',
      resource_id: CONFERENCE_ROOM_BAY_ID,
      resource_name: 'Conference Room',
      request_date: booking.date,
      start_time: booking.startTime + ':00',
      end_time: booking.endTime + ':00',
      user_name: booking.memberName,
      status: 'approved',
      notes: booking.description,
      calendar_event_id: booking.id
    }));
    
    res.json(formattedBookings);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch conference room bookings', error);
  }
});

router.get('/api/approved-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    const conditions: any[] = [
      or(
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'attended')
      )
    ];
    
    if (start_date) {
      conditions.push(gte(bookingRequests.requestDate, start_date as string));
    }
    if (end_date) {
      conditions.push(lte(bookingRequests.requestDate, end_date as string));
    }
    
    const dbResult = await db.select({
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
      resource_name: resources.name,
      trackman_booking_id: bookingRequests.trackmanBookingId,
      declared_player_count: bookingRequests.declaredPlayerCount,
      member_notes: bookingRequests.memberNotes
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .where(and(...conditions))
    .orderBy(asc(bookingRequests.requestDate), asc(bookingRequests.startTime));
    
    // Also fetch conference room bookings from Google Calendar (Mindbody bookings)
    let calendarBookings: any[] = [];
    try {
      const calendarEvents = await getConferenceRoomBookingsFromCalendar();
      
      // Get calendar event IDs from DB results to avoid duplicates
      const dbCalendarEventIds = new Set(
        dbResult
          .filter(r => r.calendar_event_id)
          .map(r => r.calendar_event_id)
      );
      
      // Filter and format calendar bookings
      calendarBookings = calendarEvents
        .filter(event => {
          // Exclude events that already exist in DB
          if (dbCalendarEventIds.has(event.id)) return false;
          
          // Apply date filtering if specified
          if (start_date && event.date < (start_date as string)) return false;
          if (end_date && event.date > (end_date as string)) return false;
          
          return true;
        })
        .map(event => ({
          id: `cal_${event.id}`,
          user_email: null,
          user_name: event.memberName,
          resource_id: CONFERENCE_ROOM_BAY_ID,
          resource_preference: null,
          request_date: event.date,
          start_time: event.startTime + ':00',
          duration_minutes: null,
          end_time: event.endTime + ':00',
          notes: event.description,
          status: 'approved',
          staff_notes: null,
          suggested_time: null,
          reviewed_by: null,
          reviewed_at: null,
          created_at: null,
          updated_at: null,
          calendar_event_id: event.id,
          resource_name: 'Conference Room',
          source: 'calendar'
        }));
    } catch (calError) {
      console.error('Failed to fetch calendar conference bookings (non-blocking):', calError);
    }
    
    // Get session IDs to check for unpaid fees
    const bookingIds = dbResult.map(b => b.id).filter(Boolean);
    
    // Query unpaid fees for each booking's session
    // Use a subquery to get participant fees without cross-product duplication
    let paymentStatusMap = new Map<number, { hasUnpaidFees: boolean; totalOwed: number }>();
    if (bookingIds.length > 0) {
      const paymentStatusResult = await pool.query(`
        SELECT 
          br.id as booking_id,
          COALESCE(pending_fees.total_owed, 0)::numeric as total_owed
        FROM booking_requests br
        LEFT JOIN LATERAL (
          SELECT SUM(COALESCE(bp.cached_fee_cents, 0)) / 100.0 as total_owed
          FROM booking_participants bp
          WHERE bp.session_id = br.session_id
            AND bp.payment_status = 'pending'
        ) pending_fees ON true
        WHERE br.id = ANY($1)
      `, [bookingIds]);
      
      for (const row of paymentStatusResult.rows) {
        const totalOwed = parseFloat(row.total_owed) || 0;
        paymentStatusMap.set(row.booking_id, {
          hasUnpaidFees: totalOwed > 0,
          totalOwed
        });
      }
    }
    
    // Enrich DB results with payment status
    const enrichedDbResult = dbResult.map(b => ({
      ...b,
      has_unpaid_fees: paymentStatusMap.get(b.id)?.hasUnpaidFees || false,
      total_owed: paymentStatusMap.get(b.id)?.totalOwed || 0
    }));
    
    // Merge DB results with calendar bookings
    const allBookings = [...enrichedDbResult, ...calendarBookings]
      .sort((a, b) => {
        const dateCompare = (a.request_date || '').localeCompare(b.request_date || '');
        if (dateCompare !== 0) return dateCompare;
        return (a.start_time || '').localeCompare(b.start_time || '');
      });
    
    res.json(allBookings);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch approved bookings', error);
  }
});

router.get('/api/recent-activity', isStaffOrAdmin, async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activities: Array<{
      id: string;
      type: 'booking_created' | 'booking_approved' | 'check_in' | 'cancellation' | 'tour' | 'notification';
      timestamp: string;
      primary_text: string;
      secondary_text: string;
      icon: string;
    }> = [];
    
    const userEmail = getSessionUser(req)?.email;
    if (userEmail) {
      const { notifications } = await import('../../shared/models/auth');
      const notificationResults = await db.select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userEmail, userEmail),
            gte(notifications.createdAt, twentyFourHoursAgo)
          )
        )
        .orderBy(desc(notifications.createdAt))
        .limit(10);
      
      for (const notif of notificationResults) {
        let icon = 'notifications';
        if (notif.type === 'booking' || notif.relatedType === 'booking_request') {
          icon = 'calendar_month';
        } else if (notif.type === 'tour' || notif.relatedType === 'tour') {
          icon = 'directions_walk';
        } else if (notif.type === 'booking_cancelled') {
          icon = 'event_busy';
        }
        
        activities.push({
          id: `notification_${notif.id}`,
          type: 'notification',
          timestamp: notif.createdAt?.toISOString() || new Date().toISOString(),
          primary_text: notif.title,
          secondary_text: notif.message.length > 50 ? notif.message.substring(0, 50) + '...' : notif.message,
          icon
        });
      }
    }

    const bookingResults = await db.select({
      id: bookingRequests.id,
      userName: bookingRequests.userName,
      userEmail: bookingRequests.userEmail,
      status: bookingRequests.status,
      resourceId: bookingRequests.resourceId,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      createdAt: bookingRequests.createdAt,
      updatedAt: bookingRequests.updatedAt,
      resourceName: resources.name
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .where(
      or(
        gte(bookingRequests.createdAt, twentyFourHoursAgo),
        gte(bookingRequests.updatedAt, twentyFourHoursAgo)
      )
    )
    .orderBy(desc(bookingRequests.updatedAt));

    for (const booking of bookingResults) {
      const name = booking.userName || booking.userEmail || 'Unknown';
      const bayName = booking.resourceName || 'Simulator';
      const timeStr = booking.startTime ? formatTime12Hour(booking.startTime) : '';
      
      if (booking.status === 'pending' || booking.status === 'pending_approval') {
        activities.push({
          id: `booking_created_${booking.id}`,
          type: 'booking_created',
          timestamp: booking.createdAt?.toISOString() || new Date().toISOString(),
          primary_text: name,
          secondary_text: `${bayName} at ${timeStr}`,
          icon: 'calendar_add_on'
        });
      } else if (booking.status === 'approved') {
        if (booking.updatedAt && booking.updatedAt >= twentyFourHoursAgo) {
          activities.push({
            id: `booking_approved_${booking.id}`,
            type: 'booking_approved',
            timestamp: booking.updatedAt?.toISOString() || new Date().toISOString(),
            primary_text: name,
            secondary_text: `${bayName} at ${timeStr}`,
            icon: 'check_circle'
          });
        }
      } else if (booking.status === 'attended') {
        if (booking.updatedAt && booking.updatedAt >= twentyFourHoursAgo) {
          activities.push({
            id: `check_in_${booking.id}`,
            type: 'check_in',
            timestamp: booking.updatedAt?.toISOString() || new Date().toISOString(),
            primary_text: name,
            secondary_text: bayName,
            icon: 'login'
          });
        }
      } else if (booking.status === 'cancelled' || booking.status === 'declined') {
        if (booking.updatedAt && booking.updatedAt >= twentyFourHoursAgo) {
          activities.push({
            id: `cancellation_${booking.id}`,
            type: 'cancellation',
            timestamp: booking.updatedAt?.toISOString() || new Date().toISOString(),
            primary_text: name,
            secondary_text: `${bayName} at ${timeStr}`,
            icon: 'event_busy'
          });
        }
      }
    }

    const { tours } = await import('../../shared/schema');
    const tourResults = await db.select()
      .from(tours)
      .where(
        and(
          eq(tours.status, 'completed'),
          gte(tours.updatedAt, twentyFourHoursAgo)
        )
      )
      .orderBy(desc(tours.updatedAt));

    for (const tour of tourResults) {
      const guestName = tour.guestName || tour.guestEmail || 'Guest';
      const timeStr = tour.startTime ? formatTime12Hour(tour.startTime) : '';
      
      activities.push({
        id: `tour_${tour.id}`,
        type: 'tour',
        timestamp: tour.updatedAt?.toISOString() || new Date().toISOString(),
        primary_text: guestName,
        secondary_text: `Tour at ${timeStr}`,
        icon: 'directions_walk'
      });
    }

    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json(activities.slice(0, 20));
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch recent activity', error);
  }
});

export default router;
