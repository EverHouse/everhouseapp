import { Router } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { getCalendarBusyTimes, getCalendarIdByName, CALENDAR_CONFIG } from '../core/calendar/index';
import { getTodayPacific, getPacificDateParts } from '../utils/dateUtils';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';
import { toIntArrayLiteral, toTextArrayLiteral } from '../utils/sqlArrayLiteral';
import { getSessionUser } from '../types/session';

const router = Router();

// Conference room resource ID constant
const CONFERENCE_ROOM_RESOURCE_ID = 11;

interface APISlot {
  start_time: string;
  end_time: string;
  available: boolean;
  requested?: boolean;
}

interface BatchAvailabilityRequest {
  resource_ids: number[];
  date: string;
  duration: number;
  ignore_booking_id?: number;
  user_email?: string;
}

// Get business hours by day of week
const getBusinessHours = (day: number): { open: number; close: number } | null => {
  const openMinutes = 8 * 60 + 30; // 8:30 AM
  switch (day) {
    case 1: // Monday - Closed
      return null;
    case 2: // Tuesday
    case 3: // Wednesday
    case 4: // Thursday
      return { open: openMinutes, close: 20 * 60 }; // 8 PM
    case 5: // Friday
    case 6: // Saturday
      return { open: openMinutes, close: 22 * 60 }; // 10 PM
    case 0: // Sunday
      return { open: openMinutes, close: 18 * 60 }; // 6 PM
    default:
      return null;
  }
};

// Generate slots for a resource given its conflicts
const generateSlotsForResource = (
  durationMinutes: number,
  hours: { open: number; close: number },
  currentMinutes: number,
  isToday: boolean,
  bookedSlots: { start_time: string; end_time: string }[],
  blockedSlots: { start_time: string; end_time: string }[],
  unmatchedSlots: { start_time: string; end_time: string }[],
  calendarSlots: { start_time: string; end_time: string }[],
  pendingSlots: { start_time: string; end_time: string }[] = []
): APISlot[] => {
  const slots: APISlot[] = [];
  const slotIncrement = 15;
  const { open: openMinutes, close: closeMinutes } = hours;

  for (let startMins = openMinutes; startMins + durationMinutes <= closeMinutes; startMins += slotIncrement) {
    if (isToday && startMins <= currentMinutes) {
      continue;
    }
    
    const startHour = Math.floor(startMins / 60);
    const startMin = startMins % 60;
    const endMins = startMins + durationMinutes;
    const endHour = Math.floor(endMins / 60);
    const endMin = endMins % 60;
    
    const startTime = `${startHour.toString().padStart(2, '0')}:${startMin.toString().padStart(2, '0')}:00`;
    const endTime = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}:00`;
    
    const hasBookingConflict = bookedSlots.some((booking) => 
      startTime < booking.end_time && endTime > booking.start_time
    );
    
    const hasBlockConflict = blockedSlots.some((block) => 
      startTime < block.end_time && endTime > block.start_time
    );
    
    const hasUnmatchedConflict = unmatchedSlots.some((unmatched) => 
      startTime < unmatched.end_time && endTime > unmatched.start_time
    );
    
    const hasCalendarConflict = calendarSlots.some((busy) => 
      startTime < busy.end_time && endTime > busy.start_time
    );
    
    const hasPendingConflict = pendingSlots.some((pending) =>
      startTime < pending.end_time && endTime > pending.start_time
    );
    
    const isUnavailable = hasBookingConflict || hasBlockConflict || hasUnmatchedConflict || hasCalendarConflict || hasPendingConflict;
    
    const slot: APISlot = {
      start_time: startTime,
      end_time: endTime,
      available: !isUnavailable
    };
    
    if (hasPendingConflict && !hasBookingConflict && !hasBlockConflict && !hasUnmatchedConflict && !hasCalendarConflict) {
      slot.requested = true;
    }
    
    slots.push(slot);
  }
  
  return slots;
};

// Batch availability endpoint - fetch multiple resources in a single request
router.post('/api/availability/batch', async (req, res) => {
  try {
    const { resource_ids, date, duration, ignore_booking_id, user_email } = req.body as BatchAvailabilityRequest;
    
    if (!resource_ids || !Array.isArray(resource_ids) || resource_ids.length === 0 || !date) {
      return res.status(400).json({ error: 'resource_ids (array) and date are required' });
    }
    
    const durationMinutes = duration || 60;
    const ignoreId = ignore_booking_id ? ignore_booking_id : null;
    
    const sessionUser = getSessionUser(req);
    const requestingEmail = (user_email || sessionUser?.email || '').trim().toLowerCase();
    
    // Get day of week for business hours
    const requestedDate = new Date(date + 'T12:00:00');
    const dayOfWeek = requestedDate.getDay();
    const hours = getBusinessHours(dayOfWeek);
    
    // Return empty slots for all resources if closed
    if (!hours) {
      const result: Record<number, { slots: APISlot[] }> = {};
      resource_ids.forEach(id => { result[id] = { slots: [] }; });
      return res.json(result);
    }
    
    // Use Pacific timezone utilities
    const todayStr = getTodayPacific();
    const isToday = date === todayStr;
    const pacificParts = getPacificDateParts();
    const currentMinutes = isToday ? pacificParts.hour * 60 + pacificParts.minute : 0;
    
    // Fetch all data in parallel with optimized queries
    const resourceIdsLiteral = toIntArrayLiteral(resource_ids);
    const resourceIdsTextLiteral = toTextArrayLiteral(resource_ids.map(String));
    const [resourcesResult, bookedResult, blockedResult, unmatchedResult, webhookCacheResult, pendingResult] = await Promise.all([
      db.execute(sql`SELECT id, type FROM resources WHERE id = ANY(${resourceIdsLiteral}::int[])`),
      ignoreId
        ? db.execute(sql`SELECT resource_id, start_time, end_time FROM booking_requests 
             WHERE resource_id = ANY(${resourceIdsLiteral}::int[]) AND request_date = ${date} AND status IN ('approved', 'confirmed', 'cancellation_pending') AND id != ${ignoreId}`)
        : db.execute(sql`SELECT resource_id, start_time, end_time FROM booking_requests 
             WHERE resource_id = ANY(${resourceIdsLiteral}::int[]) AND request_date = ${date} AND status IN ('approved', 'confirmed', 'cancellation_pending')`),
      db.execute(sql`SELECT resource_id, start_time, end_time FROM availability_blocks 
         WHERE resource_id = ANY(${resourceIdsLiteral}::int[]) AND block_date = ${date}`),
      db.execute(sql`SELECT tub.bay_number, tub.start_time, tub.end_time FROM trackman_unmatched_bookings tub
         WHERE tub.bay_number = ANY(${resourceIdsTextLiteral}::text[]) AND tub.booking_date = ${date} AND tub.resolved_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM booking_requests br 
             WHERE br.trackman_booking_id = tub.trackman_booking_id::text
           )`).catch(() => ({ rows: [] })),
      db.execute(sql`SELECT resource_id, start_time, end_time FROM trackman_bay_slots 
         WHERE resource_id = ANY(${resourceIdsLiteral}::int[]) AND slot_date = ${date} AND status = 'booked'`).catch(() => ({ rows: [] })),
      requestingEmail
        ? db.execute(sql`SELECT resource_id, start_time, end_time FROM booking_requests 
             WHERE resource_id = ANY(${resourceIdsLiteral}::int[]) AND request_date = ${date} 
             AND status IN ('pending', 'pending_approval')
             AND LOWER(user_email) != ${requestingEmail}
             AND resource_id IS NOT NULL`)
        : db.execute(sql`SELECT resource_id, start_time, end_time FROM booking_requests 
             WHERE resource_id = ANY(${resourceIdsLiteral}::int[]) AND request_date = ${date} 
             AND status IN ('pending', 'pending_approval')
             AND resource_id IS NOT NULL`)
    ]);
    
    // Build resource type map
    const resourceTypeMap = new Map<number, string>();
    resourcesResult.rows.forEach((row: { id: number; type: string }) => {
      resourceTypeMap.set(row.id, row.type);
    });
    
    // Group booked slots by resource_id
    const bookedByResource = new Map<number, { start_time: string; end_time: string }[]>();
    resource_ids.forEach(id => bookedByResource.set(id, []));
    bookedResult.rows.forEach((row: { resource_id: number; start_time: string; end_time: string }) => {
      bookedByResource.get(row.resource_id)?.push({ start_time: row.start_time, end_time: row.end_time });
    });
    
    // Group blocked slots by resource_id
    const blockedByResource = new Map<number, { start_time: string; end_time: string }[]>();
    resource_ids.forEach(id => blockedByResource.set(id, []));
    blockedResult.rows.forEach((row: { resource_id: number; start_time: string; end_time: string }) => {
      blockedByResource.get(row.resource_id)?.push({ start_time: row.start_time, end_time: row.end_time });
    });
    
    // Group unmatched Trackman by resource (bay_number is stored as string)
    const unmatchedByResource = new Map<number, { start_time: string; end_time: string }[]>();
    resource_ids.forEach(id => unmatchedByResource.set(id, []));
    unmatchedResult.rows.forEach((row: { bay_number: string; start_time: string; end_time: string }) => {
      const resourceId = parseInt(row.bay_number);
      unmatchedByResource.get(resourceId)?.push({ start_time: row.start_time, end_time: row.end_time });
    });
    
    // Group Trackman webhook cache slots by resource
    const webhookCacheByResource = new Map<number, { start_time: string; end_time: string }[]>();
    resource_ids.forEach(id => webhookCacheByResource.set(id, []));
    webhookCacheResult.rows.forEach((row: { resource_id: number; start_time: string; end_time: string }) => {
      webhookCacheByResource.get(row.resource_id)?.push({ start_time: row.start_time, end_time: row.end_time });
    });
    
    // Group pending booking requests by resource (soft lock — blocks other members from requesting same slot)
    const pendingByResource = new Map<number, { start_time: string; end_time: string }[]>();
    resource_ids.forEach(id => pendingByResource.set(id, []));
    pendingResult.rows.forEach((row: { resource_id: number; start_time: string; end_time: string }) => {
      pendingByResource.get(row.resource_id)?.push({ start_time: row.start_time, end_time: row.end_time });
    });
    
    // Find conference room resources that need calendar lookups
    const conferenceRoomIds = resource_ids.filter(id => resourceTypeMap.get(id) === 'conference_room');
    
    // Fetch calendar busy times for conference rooms (if any)
    const calendarByResource = new Map<number, { start_time: string; end_time: string }[]>();
    resource_ids.forEach(id => calendarByResource.set(id, []));
    
    if (conferenceRoomIds.length > 0) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
        if (calendarId) {
          const busyPeriods = await getCalendarBusyTimes(calendarId, date);
          const calendarSlots = busyPeriods.map(period => {
            const startStr = period.start.toLocaleTimeString('en-US', { 
              hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles'
            });
            const endStr = period.end.toLocaleTimeString('en-US', { 
              hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles'
            });
            return { start_time: startStr + ':00', end_time: endStr + ':00' };
          });
          conferenceRoomIds.forEach(id => calendarByResource.set(id, calendarSlots));
        }
      } catch (calError: unknown) {
        logger.error('Failed to fetch Google Calendar busy times (non-blocking)', { extra: { error: calError } });
      }
    }
    
    // Generate slots for each resource
    const result: Record<number, { slots: APISlot[] }> = {};
    
    for (const resourceId of resource_ids) {
      // Combine unmatched and webhook cache slots (both are external Trackman data)
      const combinedUnmatchedSlots = [
        ...(unmatchedByResource.get(resourceId) || []),
        ...(webhookCacheByResource.get(resourceId) || [])
      ];
      
      const slots = generateSlotsForResource(
        durationMinutes,
        hours,
        currentMinutes,
        isToday,
        bookedByResource.get(resourceId) || [],
        blockedByResource.get(resourceId) || [],
        combinedUnmatchedSlots,
        calendarByResource.get(resourceId) || [],
        pendingByResource.get(resourceId) || []
      );
      result[resourceId] = { slots };
    }
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('Batch availability API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Batch availability request failed' });
  }
});

router.get('/api/availability', async (req, res) => {
  try {
    const { resource_id, date, duration, ignore_booking_id } = req.query;
    
    if (!resource_id || !date) {
      return res.status(400).json({ error: 'resource_id and date are required' });
    }
    
    const durationMinutes = parseInt(duration as string) || 60;
    // 15-minute increment for cleaner time slots (:00, :15, :30, :45)
    const slotIncrement = 15;
    
    // Get resource type to determine business hours
    const resourceResult = await db.execute(sql`SELECT type FROM resources WHERE id = ${resource_id}`);
    const resourceType = resourceResult.rows[0]?.type || 'simulator';
    
    // When rescheduling, ignore the original booking so its slot shows as available
    const ignoreId = ignore_booking_id ? parseInt(ignore_booking_id as string) : null;
    
    const sessionUser = getSessionUser(req);
    const requestingEmail = (sessionUser?.email || '').trim().toLowerCase();
    
    // Include both 'approved' and 'confirmed' statuses as active bookings that block availability
    const bookedSlots = ignoreId
      ? await db.execute(sql`SELECT start_time, end_time FROM booking_requests 
           WHERE resource_id = ${resource_id} AND request_date = ${date} AND status IN ('approved', 'confirmed', 'cancellation_pending') AND id != ${ignoreId}`)
      : await db.execute(sql`SELECT start_time, end_time FROM booking_requests 
           WHERE resource_id = ${resource_id} AND request_date = ${date} AND status IN ('approved', 'confirmed', 'cancellation_pending')`);
    
    const blockedSlots = await db.execute(sql`SELECT start_time, end_time FROM availability_blocks 
       WHERE resource_id = ${resource_id} AND block_date = ${date}`);
    
    // Fetch pending bookings from other members (soft lock)
    const pendingSlots = requestingEmail
      ? await db.execute(sql`SELECT start_time, end_time FROM booking_requests 
           WHERE resource_id = ${resource_id} AND request_date = ${date} 
           AND status IN ('pending', 'pending_approval')
           AND LOWER(user_email) != ${requestingEmail}
           AND resource_id IS NOT NULL`)
      : await db.execute(sql`SELECT start_time, end_time FROM booking_requests 
           WHERE resource_id = ${resource_id} AND request_date = ${date} 
           AND status IN ('pending', 'pending_approval')
           AND resource_id IS NOT NULL`);
    
    // Also check unmatched Trackman bookings (unresolved imports occupy time slots)
    // Exclude entries that already exist in booking_requests to prevent double-counting
    let unmatchedTrackmanSlots: { rows: { start_time: string; end_time: string }[] } = { rows: [] };
    try {
      unmatchedTrackmanSlots = await db.execute(sql`SELECT tub.start_time, tub.end_time FROM trackman_unmatched_bookings tub
         WHERE tub.bay_number = ${resource_id}::text AND tub.booking_date = ${date} AND tub.resolved_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM booking_requests br 
             WHERE br.trackman_booking_id = tub.trackman_booking_id::text
           )`);
    } catch (e: unknown) {
      // Non-blocking: continue without unmatched booking checks if table doesn't exist
      logger.error('Failed to fetch unmatched Trackman bookings (non-blocking)', { extra: { error: e } });
    }
    
    // For conference room, also fetch busy times from Google Calendar (Mindbody bookings)
    let calendarBusySlots: { start_time: string; end_time: string }[] = [];
    const isConferenceRoom = resourceType === 'conference_room';
    if (isConferenceRoom) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
        if (calendarId) {
          const busyPeriods = await getCalendarBusyTimes(calendarId, date as string);
          // Convert busy periods to time strings with seconds for consistent comparison
          calendarBusySlots = busyPeriods.map(period => {
            const startStr = period.start.toLocaleTimeString('en-US', { 
              hour12: false, 
              hour: '2-digit', 
              minute: '2-digit',
              timeZone: 'America/Los_Angeles'
            });
            const endStr = period.end.toLocaleTimeString('en-US', { 
              hour12: false, 
              hour: '2-digit', 
              minute: '2-digit',
              timeZone: 'America/Los_Angeles'
            });
            return {
              start_time: startStr + ':00',
              end_time: endStr + ':00'
            };
          });
        }
      } catch (calError: unknown) {
        logger.error('Failed to fetch Google Calendar busy times (non-blocking)', { extra: { error: calError } });
      }
    }
    
    const slots = [];
    
    // Use Pacific timezone utilities for accurate time calculations
    const todayStr = getTodayPacific();
    const isToday = date === todayStr;
    const pacificParts = getPacificDateParts();
    const currentMinutes = isToday ? pacificParts.hour * 60 + pacificParts.minute : 0;
    
    // Get day of week for the requested date (0 = Sunday, 1 = Monday, etc.)
    const requestedDate = new Date(date as string + 'T12:00:00');
    const dayOfWeek = requestedDate.getDay();
    
    // Business hours by day of week:
    // Monday (1): Closed
    // Tuesday-Thursday (2-4): 8:30 AM - 8 PM
    // Friday-Saturday (5-6): 8:30 AM - 10 PM
    // Sunday (0): 8:30 AM - 6 PM
    const getBusinessHours = (day: number): { open: number; close: number } | null => {
      const openMinutes = 8 * 60 + 30; // 8:30 AM
      switch (day) {
        case 1: // Monday - Closed
          return null;
        case 2: // Tuesday
        case 3: // Wednesday
        case 4: // Thursday
          return { open: openMinutes, close: 20 * 60 }; // 8 PM
        case 5: // Friday
        case 6: // Saturday
          return { open: openMinutes, close: 22 * 60 }; // 10 PM
        case 0: // Sunday
          return { open: openMinutes, close: 18 * 60 }; // 6 PM
        default:
          return null;
      }
    };
    
    const hours = getBusinessHours(dayOfWeek);
    
    // Return empty slots if closed (Monday or invalid day)
    if (!hours) {
      return res.json([]);
    }
    
    const openMinutes = hours.open;
    const closeMinutes = hours.close;
    
    for (let startMins = openMinutes; startMins + durationMinutes <= closeMinutes; startMins += slotIncrement) {
      // Skip past time slots for today
      if (isToday && startMins <= currentMinutes) {
        continue;
      }
      const startHour = Math.floor(startMins / 60);
      const startMin = startMins % 60;
      const endMins = startMins + durationMinutes;
      const endHour = Math.floor(endMins / 60);
      const endMin = endMins % 60;
      
      const startTime = `${startHour.toString().padStart(2, '0')}:${startMin.toString().padStart(2, '0')}:00`;
      const endTime = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}:00`;
      
      const hasBookingConflict = bookedSlots.rows.some((booking: Record<string, unknown>) => {
        const bookStart = booking.start_time;
        const bookEnd = booking.end_time;
        return (startTime < bookEnd && endTime > bookStart);
      });
      
      const hasBlockConflict = blockedSlots.rows.some((block: Record<string, unknown>) => {
        const blockStart = block.start_time;
        const blockEnd = block.end_time;
        return (startTime < blockEnd && endTime > blockStart);
      });
      
      // Check unmatched Trackman bookings (unresolved historical imports)
      const hasUnmatchedConflict = unmatchedTrackmanSlots.rows.some((unmatched: Record<string, unknown>) => {
        const unmatchedStart = unmatched.start_time;
        const unmatchedEnd = unmatched.end_time;
        return (startTime < unmatchedEnd && endTime > unmatchedStart);
      });
      
      // Check Google Calendar busy times (for Mindbody conference room bookings)
      const hasCalendarConflict = calendarBusySlots.some((busy) => {
        return (startTime < busy.end_time && endTime > busy.start_time);
      });
      
      // Check pending bookings from other members (soft lock)
      const hasPendingConflict = pendingSlots.rows.some((pending: Record<string, unknown>) => {
        return (startTime < pending.end_time && endTime > pending.start_time);
      });
      
      const isUnavailable = hasBookingConflict || hasBlockConflict || hasUnmatchedConflict || hasCalendarConflict || hasPendingConflict;
      
      const slot: APISlot = {
        start_time: startTime,
        end_time: endTime,
        available: !isUnavailable
      };
      
      if (hasPendingConflict && !hasBookingConflict && !hasBlockConflict && !hasUnmatchedConflict && !hasCalendarConflict) {
        slot.requested = true;
      }
      
      slots.push(slot);
    }
    
    res.json(slots);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/api/availability-blocks', isStaffOrAdmin, async (req, res) => {
  try {
    const { resource_id, block_date, start_time, end_time, block_type, notes, created_by } = req.body;
    
    if (!resource_id || !block_date || !start_time || !end_time || !block_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const result = await db.execute(sql`INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
       VALUES (${resource_id}, ${block_date}, ${start_time}, ${end_time}, ${block_type}, ${notes}, ${created_by}) RETURNING *`);
    
    if (result.rows[0]) {
      logFromRequest(req, 'create_availability_block', 'availability', String(result.rows[0].id), undefined, { resource_id, block_date, start_time, end_time });
      res.status(201).json(result.rows[0]);
    } else {
      res.status(500).json({ error: 'Failed to create availability block' });
    }
  } catch (error: unknown) {
    logger.error('Availability block creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create availability block' });
  }
});

router.get('/api/availability-blocks', async (req, res) => {
  try {
    const { start_date, end_date, resource_id } = req.query;
    
    const conditions: ReturnType<typeof sql>[] = [];
    
    if (start_date) {
      conditions.push(sql`AND ab.block_date >= ${start_date}`);
    }
    if (end_date) {
      conditions.push(sql`AND ab.block_date <= ${end_date}`);
    }
    if (resource_id) {
      conditions.push(sql`AND ab.resource_id = ${resource_id}`);
    }
    
    const result = await db.execute(sql.join([
      sql`SELECT ab.*, r.name as resource_name, fc.title as closure_title 
                 FROM availability_blocks ab
                 JOIN resources r ON ab.resource_id = r.id
                 LEFT JOIN facility_closures fc ON ab.closure_id = fc.id
                 WHERE 1=1`,
      ...conditions,
      sql`ORDER BY ab.block_date, ab.start_time`
    ], sql` `));
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('Availability blocks error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch availability blocks' });
  }
});

router.put('/api/availability-blocks/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { resource_id, block_date, start_time, end_time, block_type, notes } = req.body;
    
    const result = await db.execute(sql`UPDATE availability_blocks 
       SET resource_id = COALESCE(${resource_id}, resource_id),
           block_date = COALESCE(${block_date}, block_date),
           start_time = COALESCE(${start_time}, start_time),
           end_time = COALESCE(${end_time}, end_time),
           block_type = COALESCE(${block_type}, block_type),
           notes = ${notes}
       WHERE id = ${id} RETURNING *`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Block not found' });
    }
    
    logFromRequest(req, 'update_availability_block', 'availability', id as string, undefined, { resource_id, block_date, start_time, end_time });
    res.json(result.rows[0]);
  } catch (error: unknown) {
    logger.error('Update block error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update availability block' });
  }
});

router.delete('/api/availability-blocks/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute(sql`DELETE FROM availability_blocks WHERE id = ${id}`);
    logFromRequest(req, 'delete_availability_block', 'availability', id as string);
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Delete block error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete availability block' });
  }
});

export default router;
