import { Router } from 'express';
import { db } from '../../db';
import { pool } from '../../core/db';
import { bookingRequests, resources } from '../../../shared/schema';
import { eq, and, or, gte, lte, asc } from 'drizzle-orm';
import { getConferenceRoomBookingsFromCalendar } from '../../core/calendar/index';
import { isStaffOrAdmin } from '../../core/middleware';
import { getConferenceRoomId } from '../../core/affectedAreas';
import { logAndRespond } from '../../core/logger';
import { getSessionUser } from '../../types/session';

const router = Router();

router.get('/api/conference-room-bookings', async (req, res) => {
  try {
    const { member_name, member_email } = req.query;
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const searchName = member_name as string || sessionUser.name || undefined;
    const searchEmail = member_email as string || sessionUser.email || undefined;
    
    const bookings = await getConferenceRoomBookingsFromCalendar(searchName, searchEmail);
    const conferenceRoomId = await getConferenceRoomId();
    
    const formattedBookings = bookings.map(booking => ({
      id: `cal_${booking.id}`,
      source: 'calendar',
      resource_id: conferenceRoomId,
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
      resource_type: resources.type,
      trackman_booking_id: bookingRequests.trackmanBookingId,
      declared_player_count: bookingRequests.declaredPlayerCount,
      member_notes: bookingRequests.memberNotes,
      guest_count: bookingRequests.guestCount,
      is_unmatched: bookingRequests.isUnmatched
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .where(and(...conditions))
    .orderBy(asc(bookingRequests.requestDate), asc(bookingRequests.startTime));
    
    let calendarBookings: any[] = [];
    try {
      const calendarEvents = await getConferenceRoomBookingsFromCalendar();
      
      const dbCalendarEventIds = new Set(
        dbResult
          .filter(r => r.calendar_event_id)
          .map(r => r.calendar_event_id)
      );
      
      const confRoomId = await getConferenceRoomId();
      calendarBookings = calendarEvents
        .filter(event => {
          if (dbCalendarEventIds.has(event.id)) return false;
          if (start_date && event.date < (start_date as string)) return false;
          if (end_date && event.date > (end_date as string)) return false;
          return true;
        })
        .map(event => ({
          id: `cal_${event.id}`,
          user_email: null,
          user_name: event.memberName,
          resource_id: confRoomId,
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
          resource_type: 'conference_room',
          source: 'calendar'
        }));
    } catch (calError) {
      console.error('Failed to fetch calendar conference bookings (non-blocking):', calError);
    }
    
    const bookingIds = dbResult.map(b => b.id).filter(Boolean);
    
    let paymentStatusMap = new Map<number, { hasUnpaidFees: boolean; totalOwed: number }>();
    let filledSlotsMap = new Map<number, number>();
    
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
      
      const filledSlotsResult = await pool.query(`
        SELECT 
          br.id as booking_id,
          (SELECT COUNT(*) FROM booking_members bm WHERE bm.booking_id = br.id AND bm.user_email IS NOT NULL AND bm.user_email != '') as member_count,
          (SELECT COUNT(*) FROM booking_guests bg WHERE bg.booking_id = br.id AND bg.guest_email IS NOT NULL AND bg.guest_email != '') as guest_count
        FROM booking_requests br
        WHERE br.id = ANY($1)
      `, [bookingIds]);
      
      for (const row of filledSlotsResult.rows) {
        const memberCount = parseInt(row.member_count) || 0;
        const guestCount = parseInt(row.guest_count) || 0;
        filledSlotsMap.set(row.booking_id, memberCount + guestCount);
      }
    }
    
    const enrichedDbResult = dbResult.map(b => {
      const declaredPlayers = b.declared_player_count || 1;
      const actualFilledSlots = filledSlotsMap.get(b.id);
      // Owner always counts as 1 filled slot; add members and guests from their tables
      const filledSlots = 1 + (actualFilledSlots !== undefined ? actualFilledSlots : (b.guest_count || 0));
      const unfilledSlots = Math.max(0, declaredPlayers - filledSlots);
      
      return {
        ...b,
        has_unpaid_fees: paymentStatusMap.get(b.id)?.hasUnpaidFees || false,
        total_owed: paymentStatusMap.get(b.id)?.totalOwed || 0,
        unfilled_slots: unfilledSlots,
        filled_player_count: filledSlots
      };
    });
    
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

router.post('/api/conference-room/verify-calendar/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    const result = await db.select({
      booking: bookingRequests,
      resourceType: resources.type
    })
      .from(bookingRequests)
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(eq(bookingRequests.id, bookingId));
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const { booking, resourceType } = result[0];
    
    if (resourceType !== 'conference_room') {
      return res.status(400).json({ error: 'This feature is only for conference room bookings' });
    }
    
    if (!['pending', 'approved'].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot verify calendar for booking with status: ${booking.status}` });
    }
    
    if (!booking.startTime || !booking.endTime || !booking.requestDate) {
      return res.status(400).json({ error: 'Booking is missing required time/date information' });
    }
    
    const calendarEvents = await getConferenceRoomBookingsFromCalendar(
      booking.userName || undefined,
      booking.userEmail || undefined
    );
    
    const bookingStartMins = safeParseTimeToMinutes(booking.startTime);
    const bookingEndMins = safeParseTimeToMinutes(booking.endTime);
    
    if (bookingStartMins === null || bookingEndMins === null) {
      return res.status(400).json({ error: 'Invalid booking time format' });
    }
    
    let matchedEvent = null;
    for (const event of calendarEvents) {
      if (event.date !== booking.requestDate) continue;
      
      const eventStartMins = safeParseTimeToMinutes(event.startTime);
      const eventEndMins = safeParseTimeToMinutes(event.endTime);
      
      if (eventStartMins === null || eventEndMins === null) continue;
      
      if (eventStartMins < bookingEndMins && eventEndMins > bookingStartMins) {
        matchedEvent = event;
        break;
      }
    }
    
    if (matchedEvent) {
      if (booking.calendarEventId) {
        return res.json({
          matched: true,
          eventSummary: matchedEvent.summary,
          eventId: matchedEvent.id,
          message: 'Calendar event already linked to this booking'
        });
      }
      
      const updateData: { calendarEventId: string; updatedAt: Date; status?: string } = {
        calendarEventId: matchedEvent.id,
        updatedAt: new Date()
      };
      
      if (booking.status === 'pending') {
        updateData.status = 'approved';
      }
      
      await db.update(bookingRequests)
        .set(updateData)
        .where(eq(bookingRequests.id, bookingId));
      
      return res.json({
        matched: true,
        eventSummary: matchedEvent.summary,
        eventId: matchedEvent.id,
        message: 'Calendar event found and linked to booking'
      });
    }
    
    return res.json({
      matched: false,
      found: false,
      message: 'No matching calendar event found for this booking time'
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to verify calendar event', error);
  }
});

function safeParseTimeToMinutes(time: string | null): number | null {
  if (!time) return null;
  const parts = time.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

export default router;
