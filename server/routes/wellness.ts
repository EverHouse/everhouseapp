import { Router } from 'express';
import { isProduction } from '../core/db';
import { isAuthenticated, isStaffOrAdmin } from '../core/middleware';
import { syncWellnessCalendarEvents, discoverCalendarIds, getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent, updateCalendarEvent, CALENDAR_CONFIG } from '../core/calendar/index';
import { db } from '../db';
import { wellnessEnrollments, wellnessClasses, users, notifications } from '../../shared/schema';
import { notifyAllStaff, notifyMember } from '../core/notificationService';
import { eq, and, gte, sql, isNull, asc, desc } from 'drizzle-orm';
import { sendPushNotification } from './push';
import { formatDateDisplayWithDay, getTodayPacific } from '../utils/dateUtils';
import { getAllActiveBayIds, getConferenceRoomId } from '../core/affectedAreas';
import { sendNotificationToUser, broadcastToStaff, broadcastWaitlistUpdate } from '../core/websocket';
import { getSessionUser } from '../types/session';
import { logFromRequest } from '../core/auditLog';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';

async function getMemberDisplayName(email: string): Promise<string> {
  try {
    const normalizedEmail = email.toLowerCase();
    const result = await db.select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .limit(1);
    
    if (result.length > 0 && (result[0].firstName || result[0].lastName)) {
      return [result[0].firstName, result[0].lastName].filter(Boolean).join(' ');
    }
  } catch (err: unknown) {
    logger.warn('Failed to lookup member name', { extra: { error: err } });
  }
  return email.split('@')[0];
}

async function createWellnessAvailabilityBlocks(
  wellnessClassId: number, 
  classDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  createdBy?: string,
  classTitle?: string
): Promise<void> {
  const resourceIds: number[] = [];
  
  if (blockSimulators) {
    const bayIds = await getAllActiveBayIds();
    resourceIds.push(...bayIds);
  }
  
  if (blockConferenceRoom) {
    const conferenceRoomId = await getConferenceRoomId();
    if (conferenceRoomId && !resourceIds.includes(conferenceRoomId)) {
      resourceIds.push(conferenceRoomId);
    }
  }
  
  const blockNotes = classTitle ? `Blocked for: ${classTitle}` : 'Blocked for wellness class';
  
  for (const resourceId of resourceIds) {
    await db.execute(sql`INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by, wellness_class_id)
       VALUES (${resourceId}, ${classDate}, ${startTime}, ${endTime || startTime}, ${'wellness'}, ${blockNotes}, ${createdBy || 'system'}, ${wellnessClassId})
       ON CONFLICT DO NOTHING`);
  }
}

async function removeWellnessAvailabilityBlocks(wellnessClassId: number): Promise<void> {
  await db.execute(sql`DELETE FROM availability_blocks WHERE wellness_class_id = ${wellnessClassId}`);
}

async function updateWellnessAvailabilityBlocks(
  wellnessClassId: number, 
  classDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  createdBy?: string,
  classTitle?: string
): Promise<void> {
  await removeWellnessAvailabilityBlocks(wellnessClassId);
  if (blockSimulators || blockConferenceRoom) {
    await createWellnessAvailabilityBlocks(wellnessClassId, classDate, startTime, endTime, blockSimulators, blockConferenceRoom, createdBy, classTitle);
  }
}

const router = Router();

router.post('/api/wellness-classes/sync', isStaffOrAdmin, async (req, res) => {
  try {
    await discoverCalendarIds();
    const result = await syncWellnessCalendarEvents();
    
    if (result.error) {
      return res.status(404).json({ error: result.error });
    }
    
    logFromRequest(req, 'sync_wellness', 'wellness', 'all', 'Calendar Sync', {
      created: result.created,
      updated: result.updated,
      total: result.synced
    });
    
    res.json({
      message: `Synced ${result.synced} wellness classes from Google Calendar`,
      created: result.created,
      updated: result.updated,
      total: result.synced
    });
  } catch (error: unknown) {
    logger.error('Wellness calendar sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync wellness calendar events' });
  }
});

router.post('/api/wellness-classes/backfill-calendar', isStaffOrAdmin, async (req, res) => {
  try {
    await discoverCalendarIds();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
    
    if (!calendarId) {
      return res.status(404).json({ error: 'Wellness calendar not found' });
    }
    
    const classesWithoutCalendar = await db.select().from(wellnessClasses)
      .where(and(
        isNull(wellnessClasses.googleCalendarId),
        gte(wellnessClasses.date, getTodayPacific())
      ))
      .orderBy(asc(wellnessClasses.date));
    
    const convertTo24Hour = (timeStr: string): string => {
      const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (match12h) {
        let hours = parseInt(match12h[1]);
        const minutes = match12h[2];
        const period = match12h[3].toUpperCase();
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      }
      const match24h = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (match24h) {
        const hours = match24h[1].padStart(2, '0');
        const minutes = match24h[2];
        const seconds = match24h[3] || '00';
        return `${hours}:${minutes}:${seconds}`;
      }
      return '09:00:00';
    };
    
    const calculateEndTime = (startTime24: string, durationStr: string): string => {
      const durationMatch = durationStr.match(/(\d+)/);
      const durationMinutes = durationMatch ? parseInt(durationMatch[1]) : 60;
      const [hours, minutes] = startTime24.split(':').map(Number);
      const totalMinutes = hours * 60 + minutes + durationMinutes;
      const endHours = Math.floor(totalMinutes / 60) % 24;
      const endMins = totalMinutes % 60;
      return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    };
    
    let created = 0;
    const errors: string[] = [];
    
    for (const wc of classesWithoutCalendar) {
      try {
        const calendarTitle = `${wc.title} with ${wc.instructor}`;
        const calendarDescription = [`Category: ${wc.category}`, wc.description, `Duration: ${wc.duration}`, `Spots: ${wc.spots}`].filter(Boolean).join('\n');
        const startTime24 = convertTo24Hour(wc.time);
        const endTime24 = calculateEndTime(startTime24, wc.duration);
        
        const googleCalendarId = await createCalendarEventOnCalendar(
          calendarId,
          calendarTitle,
          calendarDescription,
          wc.date,
          startTime24,
          endTime24
        );
        
        if (googleCalendarId) {
          await db.update(wellnessClasses)
            .set({ googleCalendarId })
            .where(eq(wellnessClasses.id, wc.id));
          created++;
        }
      } catch (err: unknown) {
        errors.push(`Class ${wc.id}: ${getErrorMessage(err)}`);
      }
    }
    
    res.json({
      message: `Created ${created} calendar events for existing wellness classes`,
      created,
      total: classesWithoutCalendar.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: unknown) {
    logger.error('Wellness calendar backfill error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to backfill wellness calendar events' });
  }
});

router.get('/api/wellness-classes/needs-review', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.execute(sql`SELECT id, title, time, instructor, duration, category, spots, status, description, date, 
              is_active, image_url, external_url, visibility, needs_review, conflict_detected,
              block_simulators, block_conference_room 
       FROM wellness_classes 
       WHERE needs_review = true AND is_active = true
       ORDER BY date ASC, time ASC
       LIMIT 100`);
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('Fetch needs review error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch wellness classes needing review' });
  }
});

router.post('/api/wellness-classes/:id/mark-reviewed', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { applyToAll } = req.body;
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const existing = await db.execute(sql`SELECT title, time, date FROM wellness_classes WHERE id = ${id}`);
    const originalTitle = existing.rows[0]?.title;
    const originalTime = existing.rows[0]?.time;
    const originalDate = existing.rows[0]?.date;
    
    const result = await db.execute(sql`UPDATE wellness_classes 
       SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false,
           locally_edited = true, app_last_modified_at = NOW()
       WHERE id = ${id} RETURNING *`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const updatedClass = result.rows[0];
    let additionalUpdated = 0;
    
    if (applyToAll !== false) {
      let bulkResult;
      
      if (updatedClass.recurring_event_id) {
        bulkResult = await db.execute(sql`UPDATE wellness_classes 
           SET needs_review = false, 
               reviewed_by = ${reviewedBy}, 
               reviewed_at = NOW(), 
               updated_at = NOW(), 
               review_dismissed = true, 
               conflict_detected = false,
               category = ${updatedClass.category},
               instructor = ${updatedClass.instructor},
               title = ${updatedClass.title},
               image_url = COALESCE(${updatedClass.image_url}, image_url),
               external_url = COALESCE(${updatedClass.external_url}, external_url),
               locally_edited = true,
               app_last_modified_at = NOW()
           WHERE recurring_event_id = ${updatedClass.recurring_event_id} 
             AND id != ${id} 
             AND date >= ${updatedClass.date}
             AND is_active = true
           RETURNING id`);
      } else if (originalTitle && originalTime && originalDate) {
        const dayOfWeek = new Date(originalDate as string).getDay();
        
        bulkResult = await db.execute(sql`UPDATE wellness_classes 
           SET needs_review = false, 
               reviewed_by = ${reviewedBy}, 
               reviewed_at = NOW(), 
               updated_at = NOW(), 
               review_dismissed = true, 
               conflict_detected = false,
               category = ${updatedClass.category},
               instructor = ${updatedClass.instructor},
               title = ${updatedClass.title},
               image_url = COALESCE(${updatedClass.image_url}, image_url),
               external_url = COALESCE(${updatedClass.external_url}, external_url),
               locally_edited = true,
               app_last_modified_at = NOW()
           WHERE title = ${originalTitle as string}
             AND time = ${originalTime as string}
             AND EXTRACT(DOW FROM date) = ${dayOfWeek}
             AND id != ${id} 
             AND date >= ${updatedClass.date}
             AND is_active = true
           RETURNING id`);
      }
      
      if (bulkResult) {
        additionalUpdated = bulkResult.rows.length;
      }
    }
    
    res.json({ 
      ...updatedClass, 
      additionalUpdated,
      message: additionalUpdated > 0 
        ? `Also updated ${additionalUpdated} other instances of this recurring event` 
        : undefined 
    });
  } catch (error: unknown) {
    logger.error('Mark reviewed error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to mark wellness class as reviewed' });
  }
});

router.get('/api/wellness-classes', async (req, res) => {
  try {
    const { active_only, include_archived } = req.query;
    const sqlConditions: ReturnType<typeof sql>[] = [];
    
    if (include_archived !== 'true') {
      sqlConditions.push(sql`wc.archived_at IS NULL`);
    }
    
    if (active_only === 'true') {
      sqlConditions.push(sql`wc.is_active = true`);
      sqlConditions.push(sql`wc.date >= ${getTodayPacific()}`);
    }
    
    const baseQuery = sql`SELECT wc.*, 
        COALESCE(e.enrolled_count, 0)::integer as enrolled_count,
        COALESCE(w.waitlist_count, 0)::integer as waitlist_count,
        CASE 
          WHEN wc.capacity IS NOT NULL THEN GREATEST(0, wc.capacity - COALESCE(e.enrolled_count, 0))
          WHEN wc.spots ~ '^[0-9]+$' THEN GREATEST(0, CAST(wc.spots AS INTEGER) - COALESCE(e.enrolled_count, 0))
          WHEN wc.spots ~ '^[0-9]+' THEN GREATEST(0, CAST(REGEXP_REPLACE(wc.spots, '[^0-9]', '', 'g') AS INTEGER) - COALESCE(e.enrolled_count, 0))
          ELSE NULL
        END::integer as spots_remaining
      FROM wellness_classes wc
      LEFT JOIN (
        SELECT class_id, COUNT(*)::integer as enrolled_count 
        FROM wellness_enrollments 
        WHERE status = 'confirmed' AND is_waitlisted = false
        GROUP BY class_id
      ) e ON wc.id = e.class_id
      LEFT JOIN (
        SELECT class_id, COUNT(*)::integer as waitlist_count 
        FROM wellness_enrollments 
        WHERE status = 'confirmed' AND is_waitlisted = true
        GROUP BY class_id
      ) w ON wc.id = w.class_id`;
    
    let fullQuery = baseQuery;
    if (sqlConditions.length > 0) {
      fullQuery = sql`${baseQuery} WHERE ${sql.join(sqlConditions, sql` AND `)}`;
    }
    fullQuery = sql`${fullQuery} ORDER BY wc.date ASC, wc.time ASC`;
    
    const result = await db.execute(fullQuery);
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch wellness classes' });
  }
});

router.post('/api/wellness-classes', isStaffOrAdmin, async (req, res) => {
  try {
    const { title, time, instructor, duration, category, spots, status, description, date, image_url, external_url, block_bookings, block_simulators, block_conference_room, capacity, waitlist_enabled } = req.body;
    
    if (!title || !time || !instructor || !duration || !category || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!capacity && !spots) {
      return res.status(400).json({ error: 'Number of spots is required' });
    }
    
    const finalSpots = spots || (capacity ? `${capacity} spots` : 'Unlimited');
    const finalCapacity = capacity || (spots ? parseInt(spots.toString().replace(/[^0-9]/g, '')) || null : null);
    
    const convertTo24Hour = (timeStr: string): string => {
      const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (match12h) {
        let hours = parseInt(match12h[1]);
        const minutes = match12h[2];
        const period = match12h[3].toUpperCase();
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      }
      const match24h = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (match24h) {
        const hours = match24h[1].padStart(2, '0');
        const minutes = match24h[2];
        const seconds = match24h[3] || '00';
        return `${hours}:${minutes}:${seconds}`;
      }
      return '09:00:00';
    };
    
    const calculateEndTime = (startTime24: string, durationStr: string): string => {
      const durationMatch = durationStr.match(/(\d+)/);
      const durationMinutes = durationMatch ? parseInt(durationMatch[1]) : 60;
      const [hours, minutes] = startTime24.split(':').map(Number);
      const totalMinutes = hours * 60 + minutes + durationMinutes;
      const endHours = Math.floor(totalMinutes / 60) % 24;
      const endMins = totalMinutes % 60;
      return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    };
    
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
    if (!calendarId) {
      return res.status(500).json({ error: 'Wellness calendar not configured. Please contact support.' });
    }
    
    const calendarTitle = `${title} with ${instructor}`;
    const calendarDescription = [`Category: ${category}`, description, `Duration: ${duration}`, `Spots: ${finalSpots}`].filter(Boolean).join('\n');
    const startTime24 = convertTo24Hour(time);
    const endTime24 = calculateEndTime(startTime24, duration);
    
    let googleCalendarId: string | null = null;
    try {
      googleCalendarId = await createCalendarEventOnCalendar(
        calendarId,
        calendarTitle,
        calendarDescription,
        date,
        startTime24,
        endTime24
      );
    } catch (calError: unknown) {
      logger.error('Failed to create Google Calendar event for wellness class', { extra: { error: calError } });
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    if (!googleCalendarId) {
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    const newBlockSimulators = block_simulators === true || block_simulators === 'true';
    const newBlockConferenceRoom = block_conference_room === true || block_conference_room === 'true';
    
    const result = await db.execute(sql`INSERT INTO wellness_classes (title, time, instructor, duration, category, spots, status, description, date, google_calendar_id, image_url, external_url, block_bookings, block_simulators, block_conference_room, capacity, waitlist_enabled)
       VALUES (${title}, ${time}, ${instructor}, ${duration}, ${category}, ${finalSpots}, ${status || 'available'}, ${description || null}, ${date}, ${googleCalendarId}, ${image_url || null}, ${external_url || null}, ${block_bookings || false}, ${newBlockSimulators}, ${newBlockConferenceRoom}, ${finalCapacity}, ${waitlist_enabled || false}) RETURNING *`);
    
    const createdClass = result.rows[0];
    
    if (newBlockSimulators || newBlockConferenceRoom) {
      try {
        const userEmail = getSessionUser(req)?.email || 'system';
        await createWellnessAvailabilityBlocks((createdClass as Record<string, unknown>).id as number, date, startTime24, endTime24, newBlockSimulators, newBlockConferenceRoom, userEmail, title);
      } catch (blockError: unknown) {
        logger.error('Failed to create availability blocks for wellness class', { extra: { error: blockError } });
      }
    }
    
    logFromRequest(req, 'create_wellness_class', 'wellness', String((createdClass as Record<string, unknown>).id), title, {
      instructor,
      date,
      time,
      duration,
      category,
      spots,
      description,
      block_simulators: newBlockSimulators,
      block_conference_room: newBlockConferenceRoom
    });
    
    res.status(201).json(createdClass);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create wellness class' });
  }
});

router.put('/api/wellness-classes/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, time, instructor, duration, category, spots, status, description, date, is_active, image_url, external_url, block_bookings, block_simulators, block_conference_room, capacity, waitlist_enabled, apply_to_recurring } = req.body;
    
    const finalSpots = spots || (capacity ? `${capacity} spots` : null);
    const finalCapacity = capacity || (spots ? parseInt(spots.toString().replace(/[^0-9]/g, '')) || null : null);
    
    const existing = await db.execute(sql`SELECT google_calendar_id, title, time, instructor, duration, category, date, block_bookings, block_simulators, block_conference_room, recurring_event_id FROM wellness_classes WHERE id = ${id}`);
    
    const previousBlockBookings = existing.rows[0]?.block_bookings || false;
    const previousBlockSimulators = existing.rows[0]?.block_simulators || false;
    const previousBlockConferenceRoom = existing.rows[0]?.block_conference_room || false;
    const newBlockBookings = block_bookings === true || block_bookings === 'true';
    const newBlockSimulators = block_simulators === true || block_simulators === 'true';
    const newBlockConferenceRoom = block_conference_room === true || block_conference_room === 'true';
    const newWaitlistEnabled = waitlist_enabled === true || waitlist_enabled === 'true';
    
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const result = await db.execute(sql`UPDATE wellness_classes SET 
        title = COALESCE(${title}, title),
        time = COALESCE(${time}, time),
        instructor = COALESCE(${instructor}, instructor),
        duration = COALESCE(${duration}, duration),
        category = COALESCE(${category}, category),
        spots = COALESCE(${finalSpots}, spots),
        status = COALESCE(${status}, status),
        description = COALESCE(${description}, description),
        date = COALESCE(${date}, date),
        is_active = COALESCE(${is_active}, is_active),
        image_url = COALESCE(${image_url}, image_url),
        external_url = COALESCE(${external_url}, external_url),
        block_bookings = ${newBlockBookings},
        block_simulators = ${newBlockSimulators},
        block_conference_room = ${newBlockConferenceRoom},
        capacity = ${finalCapacity},
        waitlist_enabled = ${newWaitlistEnabled},
        locally_edited = true,
        app_last_modified_at = NOW(),
        updated_at = NOW(),
        conflict_detected = false,
        needs_review = false,
        review_dismissed = true,
        reviewed_by = ${reviewedBy},
        reviewed_at = NOW()
       WHERE id = ${id} RETURNING *`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    if (existing.rows.length > 0 && (existing.rows[0] as Record<string, unknown>).google_calendar_id) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
        if (calendarId) {
          const updated = result.rows[0] as Record<string, unknown>;
          const calendarTitle = `${updated.category} - ${updated.title} with ${updated.instructor}`;
          const calendarDescription = [updated.description, `Duration: ${updated.duration}`, `Spots: ${updated.spots}`].filter(Boolean).join('\n');
          
          const convertTo24Hour = (timeStr: string): string => {
            const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
            if (match12h) {
              let hours = parseInt(match12h[1]);
              const minutes = match12h[2];
              const period = match12h[3].toUpperCase();
              if (period === 'PM' && hours !== 12) hours += 12;
              if (period === 'AM' && hours === 12) hours = 0;
              return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
            }
            const match24h = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
            if (match24h) {
              const hours = match24h[1].padStart(2, '0');
              const minutes = match24h[2];
              const seconds = match24h[3] || '00';
              return `${hours}:${minutes}:${seconds}`;
            }
            return '09:00:00';
          };
          
          const calculateEndTime = (startTime24: string, durationStr: string): string => {
            const durationMatch = durationStr.match(/(\d+)/);
            const durationMinutes = durationMatch ? parseInt(durationMatch[1]) : 60;
            const [hours, minutes] = startTime24.split(':').map(Number);
            const totalMinutes = hours * 60 + minutes + durationMinutes;
            const endHours = Math.floor(totalMinutes / 60) % 24;
            const endMins = totalMinutes % 60;
            return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
          };
          
          const startTime24 = convertTo24Hour(updated.time as string);
          const endTime24 = calculateEndTime(startTime24, updated.duration as string);
          
          await updateCalendarEvent(
            (existing.rows[0] as Record<string, unknown>).google_calendar_id as string,
            calendarId,
            calendarTitle,
            calendarDescription,
            updated.date as string,
            startTime24,
            endTime24
          );
        }
      } catch (calError: unknown) {
        logger.error('Failed to update Google Calendar event for wellness class', { extra: { error: calError } });
      }
    }
    
    const updated = result.rows[0] as Record<string, unknown>;
    let recurringUpdated = 0;
    const existingRow = existing.rows[0] as Record<string, unknown>;
    
    if (apply_to_recurring !== false) {
      try {
        let recurringResult;
        
        if (existingRow?.recurring_event_id) {
          recurringResult = await db.execute(sql`UPDATE wellness_classes 
             SET category = COALESCE(${category}, category),
                 instructor = COALESCE(${instructor}, instructor),
                 title = COALESCE(${title}, title),
                 duration = COALESCE(${duration}, duration),
                 spots = COALESCE(${finalSpots}, spots),
                 capacity = COALESCE(${finalCapacity}, capacity),
                 image_url = COALESCE(${image_url}, image_url),
                 external_url = COALESCE(${external_url}, external_url),
                 block_simulators = ${newBlockSimulators},
                 block_conference_room = ${newBlockConferenceRoom},
                 needs_review = false,
                 reviewed_by = ${reviewedBy},
                 reviewed_at = NOW(),
                 review_dismissed = true,
                 conflict_detected = false,
                 updated_at = NOW(),
                 locally_edited = true,
                 app_last_modified_at = NOW()
             WHERE recurring_event_id = ${existingRow.recurring_event_id} 
               AND id != ${id} 
               AND date > ${updated.date}
               AND is_active = true
             RETURNING id, date, time, duration, title`);
        } else if (existingRow?.title) {
          const dayOfWeek = new Date(existingRow.date as string).getDay();
          const originalTime = existingRow.time;
          
          recurringResult = await db.execute(sql`UPDATE wellness_classes 
             SET category = COALESCE(${category}, category),
                 instructor = COALESCE(${instructor}, instructor),
                 title = COALESCE(${title}, title),
                 duration = COALESCE(${duration}, duration),
                 spots = COALESCE(${finalSpots}, spots),
                 capacity = COALESCE(${finalCapacity}, capacity),
                 image_url = COALESCE(${image_url}, image_url),
                 external_url = COALESCE(${external_url}, external_url),
                 block_simulators = ${newBlockSimulators},
                 block_conference_room = ${newBlockConferenceRoom},
                 needs_review = false,
                 reviewed_by = ${reviewedBy},
                 reviewed_at = NOW(),
                 review_dismissed = true,
                 conflict_detected = false,
                 updated_at = NOW(),
                 locally_edited = true,
                 app_last_modified_at = NOW()
             WHERE title = ${existingRow.title} 
               AND time = ${originalTime}
               AND EXTRACT(DOW FROM date) = ${dayOfWeek}
               AND id != ${id} 
               AND date > ${updated.date}
               AND is_active = true
             RETURNING id, date, time, duration, title`);
        }
        
        if (recurringResult) {
          recurringUpdated = recurringResult.rows.length;
          
          // Create/update blocks for all recurring instances
          // Note: newBlockSimulators and newBlockConferenceRoom are already defined above as parsed booleans
          const recurringUserEmail = getSessionUser(req)?.email || 'system';
          
          if (newBlockSimulators || newBlockConferenceRoom) {
            for (const row of recurringResult.rows) {
              try {
                // Helper to convert time to 24h format
                const convertTime = (timeStr: string): string => {
                  const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
                  if (match12h) {
                    let hours = parseInt(match12h[1]);
                    const minutes = match12h[2];
                    const period = match12h[3].toUpperCase();
                    if (period === 'PM' && hours !== 12) hours += 12;
                    if (period === 'AM' && hours === 12) hours = 0;
                    return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
                  }
                  const match24h = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
                  if (match24h) {
                    return `${match24h[1].padStart(2, '0')}:${match24h[2]}:${match24h[3] || '00'}`;
                  }
                  return '09:00:00';
                };
                
                const calcEndTime = (startTime24: string, durationStr: string): string => {
                  const durationMatch = durationStr?.match(/(\d+)/);
                  const durationMinutes = durationMatch ? parseInt(durationMatch[1]) : 60;
                  const [hours, minutes] = startTime24.split(':').map(Number);
                  const totalMinutes = hours * 60 + minutes + durationMinutes;
                  const endHours = Math.floor(totalMinutes / 60) % 24;
                  const endMins = totalMinutes % 60;
                  return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
                };
                
                const startTime24 = convertTime(row.time as string);
                const endTime24 = calcEndTime(startTime24, (row.duration as string) || (updated.duration as string));
                
                await removeWellnessAvailabilityBlocks(row.id as number);
                await createWellnessAvailabilityBlocks(
                  row.id as number, row.date as string, startTime24, endTime24, 
                  newBlockSimulators, newBlockConferenceRoom, 
                  recurringUserEmail, (row.title as string) || (updated.title as string)
                );
              } catch (blockError: unknown) {
                logger.error(`Failed to create blocks for recurring wellness class ${row.id}`, { extra: { error: blockError } });
              }
            }
          } else {
            // Blocking was disabled - remove blocks from all recurring instances
            for (const row of recurringResult.rows as Array<Record<string, unknown>>) {
              try {
                await removeWellnessAvailabilityBlocks(row.id as number);
              } catch (blockError: unknown) {
                logger.error(`Failed to remove blocks for recurring wellness class ${row.id}`, { extra: { error: blockError } });
              }
            }
          }
        }
      } catch (recurError: unknown) {
        logger.error('Failed to update recurring wellness classes', { extra: { error: recurError } });
      }
    }
    
    (updated as Record<string, unknown>).recurringUpdated = recurringUpdated;
    const wellnessClassId = parseInt(id as string);
    const userEmail = getSessionUser(req)?.email || 'system';
    
    logFromRequest(req, 'update_wellness_class', 'wellness', String(wellnessClassId), updated.title as string, {
      instructor: updated.instructor,
      date: updated.date,
      time: updated.time,
      duration: updated.duration,
      category: updated.category,
      spots: updated.spots,
      description: updated.description,
      recurringUpdated
    });
    
    const convertTo24HourForBlocks = (timeStr: string): string => {
      const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (match12h) {
        let hours = parseInt(match12h[1]);
        const minutes = match12h[2];
        const period = match12h[3].toUpperCase();
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      }
      const match24h = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (match24h) {
        const hours = match24h[1].padStart(2, '0');
        const minutes = match24h[2];
        const seconds = match24h[3] || '00';
        return `${hours}:${minutes}:${seconds}`;
      }
      return '09:00:00';
    };
    
    const calculateEndTimeForBlocks = (startTime24: string, durationStr: string): string => {
      const durationMatch = durationStr.match(/(\d+)/);
      const durationMinutes = durationMatch ? parseInt(durationMatch[1]) : 60;
      const [hours, minutes] = startTime24.split(':').map(Number);
      const totalMinutes = hours * 60 + minutes + durationMinutes;
      const endHours = Math.floor(totalMinutes / 60) % 24;
      const endMins = totalMinutes % 60;
      return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    };
    
    // Determine if blocking has changed
    const hadAnyBlocking = previousBlockSimulators || previousBlockConferenceRoom;
    const hasAnyBlocking = newBlockSimulators || newBlockConferenceRoom;
    
    try {
      const startTime24 = convertTo24HourForBlocks(updated.time as string);
      const endTime24 = calculateEndTimeForBlocks(startTime24, updated.duration as string);
      
      if (!hadAnyBlocking && hasAnyBlocking) {
        // Blocks newly enabled
        await createWellnessAvailabilityBlocks(wellnessClassId, updated.date as string, startTime24, endTime24, newBlockSimulators, newBlockConferenceRoom, userEmail, updated.title as string);
      } else if (hadAnyBlocking && !hasAnyBlocking) {
        // Blocks disabled
        await removeWellnessAvailabilityBlocks(wellnessClassId);
      } else if (hasAnyBlocking) {
        // Blocks changed or time/date changed
        await updateWellnessAvailabilityBlocks(wellnessClassId, updated.date as string, startTime24, endTime24, newBlockSimulators, newBlockConferenceRoom, userEmail, updated.title as string);
      }
    } catch (blockError: unknown) {
      logger.error('Failed to update availability blocks for wellness class', { extra: { error: blockError } });
    }
    
    // Auto-clear needs_review if all required fields are filled
    if (updated.needs_review) {
      const hasValidInstructor = updated.instructor && String(updated.instructor).toLowerCase() !== 'tbd' && String(updated.instructor).trim() !== '';
      const hasValidCategory = updated.category && String(updated.category).toLowerCase() !== 'wellness' && String(updated.category).trim() !== '';
      const spotsMatch = String(updated.spots || '').match(/(\d+)/);
      const spotsValue = spotsMatch ? parseInt(spotsMatch[1]) : 0;
      const capacityValue = updated.capacity || 0;
      const hasValidSpots = spotsValue > 0 || Number(capacityValue) > 0;
      
      if (hasValidInstructor && hasValidCategory && hasValidSpots) {
        try {
          const reviewedResult = await db.execute(sql`UPDATE wellness_classes SET needs_review = false, reviewed_by = ${userEmail}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true WHERE id = ${id} RETURNING *`);
          if (reviewedResult.rows.length > 0) {
            Object.assign(updated, reviewedResult.rows[0]);
          }
        } catch (reviewError: unknown) {
          logger.error('Failed to auto-clear needs_review', { extra: { error: reviewError } });
        }
      }
    }
    
    res.json(updated);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update wellness class' });
  }
});

// Wellness enrollments endpoints
router.get('/api/wellness-enrollments', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { user_email: rawEmail } = req.query;
    
    if (!rawEmail) {
      return res.status(400).json({ error: 'User email is required' });
    }
    
    const user_email = decodeURIComponent(rawEmail as string);
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    
    if (user_email.toLowerCase() !== sessionEmail) {
      const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
      const isAdmin = await isAdminEmail(sessionEmail);
      if (!isAdmin) {
        const pool = getAuthPool();
        let isStaff = false;
        if (pool) {
          try {
            const result = await queryWithRetry(
              pool,
              'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
              [sessionEmail]
            );
            isStaff = ((result as unknown as { rows: unknown[] }).rows || []).length > 0;
          } catch (e: unknown) {
            logger.warn('[wellness] Staff check query failed', { extra: { error: e } });
          }
        }
        if (!isStaff) {
          return res.status(403).json({ error: 'You can only view your own enrollments' });
        }
      }
    }
    
    const { include_past } = req.query;
    
    const conditions = [
      eq(wellnessEnrollments.status, 'confirmed'),
      eq(wellnessEnrollments.userEmail, user_email as string),
    ];
    
    if (include_past !== 'true') {
      conditions.push(gte(wellnessClasses.date, getTodayPacific()));
    }
    
    const result = await db.select({
      id: wellnessEnrollments.id,
      class_id: wellnessEnrollments.classId,
      user_email: wellnessEnrollments.userEmail,
      status: wellnessEnrollments.status,
      is_waitlisted: wellnessEnrollments.isWaitlisted,
      created_at: wellnessEnrollments.createdAt,
      title: wellnessClasses.title,
      date: wellnessClasses.date,
      time: wellnessClasses.time,
      instructor: wellnessClasses.instructor,
      duration: wellnessClasses.duration,
      category: wellnessClasses.category,
      spots: wellnessClasses.spots
    })
    .from(wellnessEnrollments)
    .innerJoin(wellnessClasses, eq(wellnessEnrollments.classId, wellnessClasses.id))
    .where(and(...conditions))
    .orderBy(wellnessClasses.date, wellnessClasses.time);
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('Wellness enrollments error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

router.post('/api/wellness-enrollments', isAuthenticated, async (req, res) => {
  try {
    const { class_id, user_email: raw_user_email } = req.body;
    const user_email = raw_user_email?.trim()?.toLowerCase();
    
    if (!class_id || !user_email) {
      return res.status(400).json({ error: 'Missing class_id or user_email' });
    }
    
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const isOwnAction = sessionEmail === user_email.toLowerCase();
    const isAdminOrStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    if (!isOwnAction && !isAdminOrStaff) {
      return res.status(403).json({ error: 'You can only perform this action for yourself' });
    }
    
    const existing = await db.select({ id: wellnessEnrollments.id })
      .from(wellnessEnrollments)
      .where(and(
        eq(wellnessEnrollments.classId, class_id),
        eq(wellnessEnrollments.userEmail, user_email),
        eq(wellnessEnrollments.status, 'confirmed')
      ));
    
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Already enrolled in this class' });
    }
    
    const classDataResult = await db.execute(sql`SELECT wc.*, 
        COALESCE((SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = wc.id AND status = 'confirmed' AND is_waitlisted = false), 0)::integer as enrolled_count
      FROM wellness_classes wc WHERE wc.id = ${class_id}`);
    
    if (classDataResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const cls = classDataResult.rows[0] as Record<string, unknown>;
    const dateStr = cls.date instanceof Date 
      ? cls.date.toISOString().split('T')[0] 
      : (typeof cls.date === 'string' ? cls.date.split('T')[0] : String(cls.date));
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const memberName = await getMemberDisplayName(user_email);
    
    // Check capacity and determine if this should be a waitlist enrollment
    const capacity = cls.capacity as number | null;
    const enrolledCount = cls.enrolled_count as number;
    const waitlistEnabled = cls.waitlist_enabled;
    const isAtCapacity = capacity !== null && capacity !== undefined && enrolledCount >= capacity;
    
    // If at capacity and no waitlist, reject enrollment
    if (isAtCapacity && !waitlistEnabled) {
      return res.status(400).json({ error: 'This class is full' });
    }
    
    const isWaitlisted = isAtCapacity && waitlistEnabled;
    
    const memberMessage = isWaitlisted 
      ? `You've been added to the waitlist for ${cls.title} with ${cls.instructor} on ${formattedDate} at ${cls.time}. We'll notify you if a spot opens up.`
      : `You're enrolled in ${cls.title} with ${cls.instructor} on ${formattedDate} at ${cls.time}.`;
    const staffMessage = isWaitlisted
      ? `${memberName} joined the waitlist for ${cls.title} on ${formattedDate}`
      : `${memberName} enrolled in ${cls.title} on ${formattedDate}`;
    
    const result = await db.transaction(async (tx) => {
      const enrollmentResult = await tx.insert(wellnessEnrollments)
        .values({
          classId: parseInt(class_id as string),
          userEmail: user_email as string,
          status: 'confirmed',
          isWaitlisted: isWaitlisted as boolean
        })
        .returning();
      
      await tx.insert(notifications).values({
        userEmail: user_email as string,
        title: isWaitlisted ? 'Added to Waitlist' : 'Wellness Class Confirmed',
        message: memberMessage,
        type: 'wellness_booking',
        relatedId: parseInt(class_id as string),
        relatedType: 'wellness_class'
      });
      
      return enrollmentResult[0];
    });
    
    notifyAllStaff(
      isWaitlisted ? 'New Waitlist Entry' : 'New Wellness Enrollment',
      staffMessage,
      'wellness_enrollment',
      { relatedId: class_id, relatedType: 'wellness_class', url: '/admin/calendar' }
    ).catch(err => logger.warn('Failed to notify staff of wellness enrollment', { extra: { error: err } }));
    
    sendPushNotification(user_email, {
      title: isWaitlisted ? 'Added to Waitlist' : 'Class Booked!',
      body: memberMessage,
      url: '/member-wellness'
    }).catch(err => logger.error('Push notification failed', { extra: { error: err } }));
    
    // Send real-time WebSocket notification to member
    sendNotificationToUser(user_email, {
      type: 'notification',
      title: isWaitlisted ? 'Added to Waitlist' : 'Wellness Class Confirmed',
      message: memberMessage,
      data: { classId: class_id, eventType: isWaitlisted ? 'wellness_waitlisted' : 'wellness_enrolled' }
    }, { action: isWaitlisted ? 'wellness_waitlisted' : 'wellness_enrolled', classId: class_id, triggerSource: 'wellness.ts' });
    
    // Broadcast to staff for real-time updates
    broadcastToStaff({
      type: 'wellness_event',
      action: isWaitlisted ? 'waitlist_joined' : 'enrollment_created',
      classId: class_id,
      memberEmail: user_email
    });
    
    // Broadcast waitlist update for real-time availability refresh
    broadcastWaitlistUpdate({ classId: class_id, action: 'enrolled' });
    
    res.status(201).json({ ...result, isWaitlisted, message: isWaitlisted ? 'Added to waitlist' : 'Enrolled' });
  } catch (error: unknown) {
    logger.error('Wellness enrollment error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to enroll in class. Staff notification is required.' });
  }
});

router.delete('/api/wellness-enrollments/:class_id/:user_email', isAuthenticated, async (req, res) => {
  try {
    const { class_id: rawClassId, user_email: rawUserEmail } = req.params;
    const class_id = rawClassId as string;
    const user_email = decodeURIComponent(rawUserEmail as string).trim().toLowerCase();
    const enrollmentEmail = user_email;
    
    const rawSessionEmail = getSessionUser(req)?.email;
    const sessionUserRole = getSessionUser(req)?.role;
    const sessionEmail = rawSessionEmail?.toLowerCase();
    
    const actingAsEmail = req.body?.acting_as_email?.toLowerCase();
    const isAdminOrStaff = sessionUserRole === 'admin' || sessionUserRole === 'staff';
    const isAdminViewingAs = isAdminOrStaff && actingAsEmail;
    
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const isOwnEnrollment = enrollmentEmail === sessionEmail;
    const isValidViewAs = isAdminViewingAs && enrollmentEmail === actingAsEmail;
    
    if (!isOwnEnrollment && !isValidViewAs && !isAdminOrStaff) {
      return res.status(403).json({ error: 'You can only cancel your own enrollments' });
    }
    
    // Get current enrollment to check if it was a regular enrollment (not waitlisted)
    const currentEnrollment = await db.select()
      .from(wellnessEnrollments)
      .where(and(
        eq(wellnessEnrollments.classId, parseInt(class_id)),
        eq(wellnessEnrollments.userEmail, user_email),
        eq(wellnessEnrollments.status, 'confirmed')
      ))
      .limit(1);
    
    const wasNotWaitlisted = currentEnrollment.length > 0 && !currentEnrollment[0].isWaitlisted;
    
    const classDataResult = await db.execute(sql`SELECT wc.*, 
        (SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = wc.id AND status = 'confirmed' AND is_waitlisted = true) as waitlist_count
      FROM wellness_classes wc WHERE wc.id = ${class_id}`);
    
    if (classDataResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const cls = classDataResult.rows[0] as Record<string, unknown>;
    const dateStr = cls.date instanceof Date 
      ? cls.date.toISOString().split('T')[0] 
      : (typeof cls.date === 'string' ? cls.date.split('T')[0] : String(cls.date));
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const memberName = await getMemberDisplayName(user_email);
    const staffMessage = `${memberName} cancelled their enrollment for ${cls.title} on ${formattedDate}`;
    
    await db.transaction(async (tx) => {
      await tx.update(wellnessEnrollments)
        .set({ status: 'cancelled' })
        .where(and(
          eq(wellnessEnrollments.classId, parseInt(class_id)),
          eq(wellnessEnrollments.userEmail, user_email)
        ));
    });
    
    notifyAllStaff(
      'Wellness Enrollment Cancelled',
      staffMessage,
      'wellness_cancellation',
      { relatedId: parseInt(class_id), relatedType: 'wellness_class', url: '/admin/calendar' }
    ).catch(err => logger.warn('Failed to notify staff of wellness cancellation', { extra: { error: err } }));
    
    // Delete the original "Wellness Class Confirmed" notification to avoid confusion
    try {
      await db.execute(sql`DELETE FROM notifications 
         WHERE LOWER(user_email) = LOWER(${user_email}) 
         AND related_id = ${parseInt(class_id)} 
         AND related_type = 'wellness_class' 
         AND type = 'wellness_booking'`);
    } catch (cleanupErr: unknown) {
      // Non-critical - log but don't fail the cancellation
      logger.warn('Failed to cleanup wellness confirmation notification', { extra: { error: cleanupErr } });
    }
    
    await notifyMember({
      userEmail: user_email,
      title: 'Wellness Enrollment Cancelled',
      message: `Your enrollment in "${cls.title}" on ${formattedDate} has been cancelled`,
      type: 'wellness',
      relatedId: parseInt(class_id),
      relatedType: 'wellness',
      url: '/member-wellness'
    });
    
    // If a regular enrollment was cancelled and there are waitlisted users, promote the first one
    if (wasNotWaitlisted && parseInt(cls.waitlist_count as string) > 0) {
      try {
        // Get the first person on waitlist (oldest entry) with row locking to prevent race conditions
        // FOR UPDATE SKIP LOCKED ensures concurrent processes pick different users
        const waitlistedResult = await db.execute(sql`SELECT * FROM wellness_enrollments 
           WHERE class_id = ${parseInt(class_id)} 
             AND status = 'confirmed' 
             AND is_waitlisted = true
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`);
        
        if (waitlistedResult.rows.length > 0) {
          const promotedUserRow = waitlistedResult.rows[0] as Record<string, unknown>;
          const promotedEmail = promotedUserRow.user_email;
          const promotedName = await getMemberDisplayName(promotedEmail as string);
          
          // Promote from waitlist
          await db.update(wellnessEnrollments)
            .set({ isWaitlisted: false })
            .where(eq(wellnessEnrollments.id, promotedUserRow.id as number));
          
          const promotedMessage = `A spot opened up! You've been moved from the waitlist and are now enrolled in ${cls.title} with ${cls.instructor} on ${formattedDate} at ${cls.time}.`;
          
          // Create notification for promoted user
          await db.insert(notifications).values({
            userEmail: promotedEmail as string,
            title: 'Spot Available - You\'re In!',
            message: promotedMessage,
            type: 'wellness_booking',
            relatedId: parseInt(class_id as string),
            relatedType: 'wellness_class'
          });
          
          // Send push notification
          sendPushNotification(promotedEmail as string, {
            title: 'Spot Available - You\'re In!',
            body: promotedMessage,
            url: '/member-wellness'
          }).catch(err => logger.error('Push notification failed', { extra: { error: err } }));
          
          // Send real-time WebSocket notification
          sendNotificationToUser(promotedEmail as string, {
            type: 'notification',
            title: 'Spot Available - You\'re In!',
            message: promotedMessage,
            data: { classId: parseInt(class_id), eventType: 'wellness_promoted' }
          }, { action: 'wellness_promoted', classId: parseInt(class_id), triggerSource: 'wellness.ts' });
          
          // Notify staff
          await notifyAllStaff(
            'Waitlist Promotion',
            `${promotedName} was automatically promoted from waitlist for ${cls.title} on ${formattedDate}`,
            'wellness_enrollment',
            { relatedId: parseInt(class_id), relatedType: 'wellness_class', url: '/admin/calendar' }
          );
        }
      } catch (promoteError: unknown) {
        logger.error('Failed to promote waitlisted user', { extra: { error: promoteError } });
      }
    }
    
    // Broadcast to staff for real-time updates
    broadcastToStaff({
      type: 'wellness_event',
      action: 'enrollment_cancelled',
      classId: parseInt(class_id),
      memberEmail: user_email
    });
    
    // Broadcast waitlist update for real-time availability refresh (spot opened)
    const spotsQuery = await db.execute(sql`SELECT 
        CASE 
          WHEN capacity IS NOT NULL THEN GREATEST(0, capacity - COALESCE((SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = ${class_id} AND status = 'confirmed' AND is_waitlisted = false), 0))
          ELSE NULL
        END as spots_available
       FROM wellness_classes WHERE id = ${class_id}`);
    const spotsAvailable = (spotsQuery.rows[0] as Record<string, unknown>)?.spots_available;
    broadcastWaitlistUpdate({ classId: parseInt(class_id as string), action: 'spot_opened', spotsAvailable: (spotsAvailable as number) ?? undefined });
    
    logFromRequest(req, 'delete_wellness_class', 'wellness', class_id as string, undefined, {
      member_email: user_email,
      class_title: cls.title,
      class_date: dateStr
    });
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Wellness enrollment cancellation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cancel enrollment. Staff notification is required.' });
  }
});

router.delete('/api/wellness-classes/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const wellnessClassId = parseInt(id as string);
    
    const existing = await db.execute(sql`SELECT google_calendar_id FROM wellness_classes WHERE id = ${id}`);
    if (existing.rows.length > 0 && (existing.rows[0] as Record<string, unknown>).google_calendar_id) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
        if (calendarId) {
          await deleteCalendarEvent((existing.rows[0] as Record<string, unknown>).google_calendar_id as string, calendarId);
        }
      } catch (calError: unknown) {
        logger.error('Failed to delete Google Calendar event for wellness class', { extra: { error: calError } });
      }
    }
    
    try {
      await removeWellnessAvailabilityBlocks(wellnessClassId);
    } catch (blockError: unknown) {
      logger.error('Failed to remove availability blocks for wellness class', { extra: { error: blockError } });
    }
    
    const result = await db.execute(sql`DELETE FROM wellness_classes WHERE id = ${id} RETURNING *`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const deletedClass = result.rows[0] as Record<string, unknown>;
    logFromRequest(req, 'delete_wellness_class', 'wellness', String(deletedClass.id), deletedClass.title as string, {
      instructor: deletedClass.instructor,
      date: deletedClass.date,
      time: deletedClass.time,
      duration: deletedClass.duration,
      category: deletedClass.category,
      spots: deletedClass.spots
    });
    
    res.json({ message: 'Wellness class deleted', class: deletedClass });
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete wellness class' });
  }
});

router.get('/api/wellness-classes/:id/enrollments', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.select({
      id: wellnessEnrollments.id,
      userEmail: wellnessEnrollments.userEmail,
      status: wellnessEnrollments.status,
      createdAt: wellnessEnrollments.createdAt,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
    })
    .from(wellnessEnrollments)
    .leftJoin(users, eq(wellnessEnrollments.userEmail, users.email))
    .where(and(
      eq(wellnessEnrollments.classId, parseInt(id as string)),
      eq(wellnessEnrollments.status, 'confirmed')
    ))
    .orderBy(desc(wellnessEnrollments.createdAt));
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

router.post('/api/wellness-classes/:id/enrollments/manual', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const existingEnrollment = await db.select()
      .from(wellnessEnrollments)
      .where(and(
        eq(wellnessEnrollments.classId, parseInt(id as string)),
        eq(wellnessEnrollments.userEmail, email),
        eq(wellnessEnrollments.status, 'confirmed')
      ))
      .limit(1);
    
    if (existingEnrollment.length > 0) {
      return res.status(400).json({ error: 'This email is already enrolled in this class' });
    }

    // Get the class details for audit logging
    const classQuery = await db.execute(sql`SELECT id, title, instructor FROM wellness_classes WHERE id = ${parseInt(id as string)}`);
    const classDetails = classQuery.rows[0] as Record<string, unknown>;

    await db.insert(wellnessEnrollments).values({
      classId: parseInt(id as string),
      userEmail: email,
      status: 'confirmed',
    });
    
    logFromRequest(req, 'manual_enrollment', 'wellness', String(id), (classDetails?.title || 'Wellness Class') as string, {
      instructor: classDetails?.instructor,
      memberEnrolled: email
    });
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Manual enrollment error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add enrollment' });
  }
});

export default router;
