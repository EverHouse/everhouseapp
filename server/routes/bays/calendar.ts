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
    
    const today = new Date();
    const defaultStartDate = start_date || new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const defaultEndDate = end_date || new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const conditions: any[] = [
      or(
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'attended')
      ),
    ];
    
    conditions.push(gte(bookingRequests.requestDate, defaultStartDate as string));
    conditions.push(lte(bookingRequests.requestDate, defaultEndDate as string));
    
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
      is_unmatched: bookingRequests.isUnmatched,
      trackman_customer_notes: bookingRequests.trackmanCustomerNotes,
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
          if (event.date < (defaultStartDate as string)) return false;
          if (event.date > (defaultEndDate as string)) return false;
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
    let feeSnapshotPaidSet = new Set<number>();
    
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
      
      const feeSnapshotResult = await pool.query(`
        SELECT br.id as booking_id
        FROM booking_requests br
        INNER JOIN booking_fee_snapshots bfs ON bfs.session_id = br.session_id AND bfs.status = 'completed'
        WHERE br.id = ANY($1)
      `, [bookingIds]);
      feeSnapshotPaidSet = new Set<number>(feeSnapshotResult.rows.map((r: any) => r.booking_id));

      for (const row of paymentStatusResult.rows) {
        const totalOwed = parseFloat(row.total_owed) || 0;
        const snapshotPaid = feeSnapshotPaidSet.has(row.booking_id);
        paymentStatusMap.set(row.booking_id, {
          hasUnpaidFees: snapshotPaid ? false : totalOwed > 0,
          totalOwed: snapshotPaid ? 0 : totalOwed
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
      const filledSlots = actualFilledSlots !== undefined && actualFilledSlots > 0
        ? actualFilledSlots
        : 1 + (b.guest_count || 0);
      const unfilledSlots = Math.max(0, declaredPlayers - filledSlots);
      
      return {
        ...b,
        has_unpaid_fees: paymentStatusMap.get(b.id)?.hasUnpaidFees || false,
        total_owed: paymentStatusMap.get(b.id)?.totalOwed || 0,
        fee_snapshot_paid: feeSnapshotPaidSet.has(b.id),
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

export default router;
