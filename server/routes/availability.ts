import { Router } from 'express';
import { pool, isProduction } from '../core/db';
import { isStaffOrAdmin } from '../core/middleware';
import { getCalendarBusyTimes, getCalendarIdByName, CALENDAR_CONFIG } from '../core/calendar/index';
import { getTodayPacific, getPacificDateParts } from '../utils/dateUtils';

const router = Router();

// Conference room resource ID constant
const CONFERENCE_ROOM_RESOURCE_ID = 11;

interface APISlot {
  start_time: string;
  end_time: string;
  available: boolean;
}

interface BatchAvailabilityRequest {
  resource_ids: number[];
  date: string;
  duration: number;
  ignore_booking_id?: number;
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
  calendarSlots: { start_time: string; end_time: string }[]
): APISlot[] => {
  const slots: APISlot[] = [];
  const slotIncrement = 5;
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
    
    slots.push({
      start_time: startTime,
      end_time: endTime,
      available: !hasBookingConflict && !hasBlockConflict && !hasUnmatchedConflict && !hasCalendarConflict
    });
  }
  
  return slots;
};

// Batch availability endpoint - fetch multiple resources in a single request
router.post('/api/availability/batch', async (req, res) => {
  try {
    const { resource_ids, date, duration, ignore_booking_id } = req.body as BatchAvailabilityRequest;
    
    if (!resource_ids || !Array.isArray(resource_ids) || resource_ids.length === 0 || !date) {
      return res.status(400).json({ error: 'resource_ids (array) and date are required' });
    }
    
    const durationMinutes = duration || 60;
    const ignoreId = ignore_booking_id ? ignore_booking_id : null;
    
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
    const [resourcesResult, bookedResult, blockedResult, unmatchedResult] = await Promise.all([
      // Get resource types for all requested resources
      pool.query(
        `SELECT id, type FROM resources WHERE id = ANY($1)`,
        [resource_ids]
      ),
      // Fetch all booked slots for all resources in one query
      ignoreId
        ? pool.query(
            `SELECT resource_id, start_time, end_time FROM booking_requests 
             WHERE resource_id = ANY($1) AND request_date = $2 AND status = 'approved' AND id != $3`,
            [resource_ids, date, ignoreId]
          )
        : pool.query(
            `SELECT resource_id, start_time, end_time FROM booking_requests 
             WHERE resource_id = ANY($1) AND request_date = $2 AND status = 'approved'`,
            [resource_ids, date]
          ),
      // Fetch all blocked slots for all resources in one query
      pool.query(
        `SELECT resource_id, start_time, end_time FROM availability_blocks 
         WHERE resource_id = ANY($1) AND block_date = $2`,
        [resource_ids, date]
      ),
      // Fetch all unmatched Trackman bookings
      pool.query(
        `SELECT bay_number, start_time, end_time FROM trackman_unmatched_bookings 
         WHERE bay_number = ANY($1::text[]) AND booking_date = $2 AND resolved_at IS NULL`,
        [resource_ids.map(String), date]
      ).catch(() => ({ rows: [] })) // Non-blocking if table doesn't exist
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
      } catch (calError) {
        console.error('Failed to fetch Google Calendar busy times (non-blocking):', calError);
      }
    }
    
    // Generate slots for each resource
    const result: Record<number, { slots: APISlot[] }> = {};
    
    for (const resourceId of resource_ids) {
      const slots = generateSlotsForResource(
        durationMinutes,
        hours,
        currentMinutes,
        isToday,
        bookedByResource.get(resourceId) || [],
        blockedByResource.get(resourceId) || [],
        unmatchedByResource.get(resourceId) || [],
        calendarByResource.get(resourceId) || []
      );
      result[resourceId] = { slots };
    }
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('Batch availability API error:', error);
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
    // Fixed 5-minute increment for more flexible start times
    const slotIncrement = 5;
    
    // Get resource type to determine business hours
    const resourceResult = await pool.query(
      `SELECT type FROM resources WHERE id = $1`,
      [resource_id]
    );
    const resourceType = resourceResult.rows[0]?.type || 'simulator';
    
    // When rescheduling, ignore the original booking so its slot shows as available
    const ignoreId = ignore_booking_id ? parseInt(ignore_booking_id as string) : null;
    
    const bookedSlots = ignoreId
      ? await pool.query(
          `SELECT start_time, end_time FROM booking_requests 
           WHERE resource_id = $1 AND request_date = $2 AND status = 'approved' AND id != $3`,
          [resource_id, date, ignoreId]
        )
      : await pool.query(
          `SELECT start_time, end_time FROM booking_requests 
           WHERE resource_id = $1 AND request_date = $2 AND status = 'approved'`,
          [resource_id, date]
        );
    
    const blockedSlots = await pool.query(
      `SELECT start_time, end_time FROM availability_blocks 
       WHERE resource_id = $1 AND block_date = $2`,
      [resource_id, date]
    );
    
    // Also check unmatched Trackman bookings (unresolved imports occupy time slots)
    let unmatchedTrackmanSlots: { rows: { start_time: string; end_time: string }[] } = { rows: [] };
    try {
      unmatchedTrackmanSlots = await pool.query(
        `SELECT start_time, end_time FROM trackman_unmatched_bookings 
         WHERE bay_number = $1::text AND booking_date = $2 AND resolved_at IS NULL`,
        [resource_id, date]
      );
    } catch (e) {
      // Non-blocking: continue without unmatched booking checks if table doesn't exist
      console.error('Failed to fetch unmatched Trackman bookings (non-blocking):', e);
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
      } catch (calError) {
        console.error('Failed to fetch Google Calendar busy times (non-blocking):', calError);
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
      
      const hasBookingConflict = bookedSlots.rows.some((booking: any) => {
        const bookStart = booking.start_time;
        const bookEnd = booking.end_time;
        return (startTime < bookEnd && endTime > bookStart);
      });
      
      const hasBlockConflict = blockedSlots.rows.some((block: any) => {
        const blockStart = block.start_time;
        const blockEnd = block.end_time;
        return (startTime < blockEnd && endTime > blockStart);
      });
      
      // Check unmatched Trackman bookings (unresolved historical imports)
      const hasUnmatchedConflict = unmatchedTrackmanSlots.rows.some((unmatched: any) => {
        const unmatchedStart = unmatched.start_time;
        const unmatchedEnd = unmatched.end_time;
        return (startTime < unmatchedEnd && endTime > unmatchedStart);
      });
      
      // Check Google Calendar busy times (for Mindbody conference room bookings)
      const hasCalendarConflict = calendarBusySlots.some((busy) => {
        return (startTime < busy.end_time && endTime > busy.start_time);
      });
      
      slots.push({
        start_time: startTime,
        end_time: endTime,
        available: !hasBookingConflict && !hasBlockConflict && !hasUnmatchedConflict && !hasCalendarConflict
      });
    }
    
    res.json(slots);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/api/availability-blocks', isStaffOrAdmin, async (req, res) => {
  try {
    const { resource_id, block_date, start_time, end_time, block_type, notes, created_by } = req.body;
    
    if (!resource_id || !block_date || !start_time || !end_time || !block_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const result = await pool.query(
      `INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [resource_id, block_date, start_time, end_time, block_type, notes, created_by]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (!isProduction) console.error('Availability block creation error:', error);
    res.status(500).json({ error: 'Failed to create availability block' });
  }
});

router.get('/api/availability-blocks', async (req, res) => {
  try {
    const { start_date, end_date, resource_id } = req.query;
    
    let query = `SELECT ab.*, r.name as resource_name, fc.title as closure_title 
                 FROM availability_blocks ab
                 JOIN resources r ON ab.resource_id = r.id
                 LEFT JOIN facility_closures fc ON ab.closure_id = fc.id
                 WHERE 1=1`;
    const params: any[] = [];
    
    if (start_date) {
      params.push(start_date);
      query += ` AND ab.block_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      query += ` AND ab.block_date <= $${params.length}`;
    }
    if (resource_id) {
      params.push(resource_id);
      query += ` AND ab.resource_id = $${params.length}`;
    }
    
    query += ' ORDER BY ab.block_date, ab.start_time';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error: any) {
    if (!isProduction) console.error('Availability blocks error:', error);
    res.status(500).json({ error: 'Failed to fetch availability blocks' });
  }
});

router.put('/api/availability-blocks/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { resource_id, block_date, start_time, end_time, block_type, notes } = req.body;
    
    const result = await pool.query(
      `UPDATE availability_blocks 
       SET resource_id = COALESCE($1, resource_id),
           block_date = COALESCE($2, block_date),
           start_time = COALESCE($3, start_time),
           end_time = COALESCE($4, end_time),
           block_type = COALESCE($5, block_type),
           notes = $6
       WHERE id = $7 RETURNING *`,
      [resource_id, block_date, start_time, end_time, block_type, notes, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Block not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error: any) {
    if (!isProduction) console.error('Update block error:', error);
    res.status(500).json({ error: 'Failed to update availability block' });
  }
});

router.delete('/api/availability-blocks/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM availability_blocks WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Delete block error:', error);
    res.status(500).json({ error: 'Failed to delete availability block' });
  }
});

export default router;
