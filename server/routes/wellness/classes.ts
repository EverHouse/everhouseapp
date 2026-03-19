import { Router } from 'express';
import { isAuthenticated, isStaffOrAdmin } from '../../core/middleware';
import { syncWellnessCalendarEvents, discoverCalendarIds, getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent, updateCalendarEvent, CALENDAR_CONFIG } from '../../core/calendar/index';
import { db } from '../../db';
import { wellnessEnrollments, wellnessClasses, users, notifications } from '../../../shared/schema';
import { notifyAllStaff, notifyMember } from '../../core/notificationService';
import { eq, and, gte, sql, isNull, asc, desc } from 'drizzle-orm';
import { formatDateDisplayWithDay, getTodayPacific, formatTime12Hour } from '../../utils/dateUtils';
import { getAllActiveBayIds, getConferenceRoomId } from '../../core/affectedAreas';
import { broadcastToStaff, broadcastWaitlistUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { logFromRequest } from '../../core/auditLog';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../core/logger';
import {
  WellnessClassRow,
  WellnessRecurringRow,
  WaitlistedUserRow,
  WellnessClassDetailRow,
  getMemberDisplayName,
  createWellnessAvailabilityBlocks,
  removeWellnessAvailabilityBlocks,
  updateWellnessAvailabilityBlocks,
} from './helpers';

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
      .orderBy(asc(wellnessClasses.date))
      .limit(500);
    
    const convertTo24Hour = (timeStr: string): string => {
      const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (match12h) {
        let hours = parseInt(match12h[1], 10);
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
      const durationMinutes = durationMatch ? parseInt(durationMatch[1], 10) : 60;
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
        const calendarDescription = wc.description || '';
        const startTime24 = convertTo24Hour(wc.time);
        const endTime24 = calculateEndTime(startTime24, wc.duration);
        
        const extendedProps: Record<string, string> = {
          'ehApp_type': 'wellness',
          'ehApp_id': String(wc.id),
        };
        if (wc.category) extendedProps['ehApp_category'] = wc.category;
        if (wc.duration) extendedProps['ehApp_duration'] = wc.duration;
        if (wc.spots) extendedProps['ehApp_spots'] = wc.spots;
        if (wc.status) extendedProps['ehApp_status'] = wc.status;
        if (wc.imageUrl) extendedProps['ehApp_imageUrl'] = wc.imageUrl;
        if (wc.externalUrl) extendedProps['ehApp_externalUrl'] = wc.externalUrl;
        
        const googleCalendarId = await createCalendarEventOnCalendar(
          calendarId,
          calendarTitle,
          calendarDescription,
          wc.date,
          startTime24,
          endTime24,
          extendedProps
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
    const numId = parseInt(id as string, 10);
    if (isNaN(numId)) return res.status(400).json({ error: 'Invalid wellness class ID' });
    const { applyToAll } = req.body;
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const existing = await db.execute(sql`SELECT title, time, date FROM wellness_classes WHERE id = ${numId}`);
    const originalTitle = existing.rows[0]?.title;
    const originalTime = existing.rows[0]?.time;
    const originalDate = existing.rows[0]?.date;
    
    const result = await db.execute(sql`UPDATE wellness_classes 
       SET needs_review = false, reviewed_by = ${reviewedBy}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false,
           locally_edited = true, app_last_modified_at = NOW()
       WHERE id = ${numId} RETURNING *`);
    
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
             AND id != ${numId} 
             AND date >= ${updatedClass.date}
             AND is_active = true
           RETURNING id`);
      } else if (originalTitle && originalTime && originalDate) {
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
             AND EXTRACT(DOW FROM date) = EXTRACT(DOW FROM ${originalDate as string}::date)
             AND id != ${numId} 
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

// PUBLIC ROUTE
router.get('/api/wellness-classes', async (req, res) => {
  try {
    const { active_only, include_archived, include_inactive, end_date } = req.query;
    const sqlConditions: ReturnType<typeof sql>[] = [];
    
    if (include_archived !== 'true') {
      sqlConditions.push(sql`wc.archived_at IS NULL`);
    }
    
    if (include_inactive !== 'true') {
      sqlConditions.push(sql`wc.is_active = true`);
    }
    
    if (active_only === 'true') {
      const today = getTodayPacific();
      sqlConditions.push(sql`wc.date >= ${today}`);
      if (end_date && typeof end_date === 'string') {
        sqlConditions.push(sql`wc.date <= ${end_date}`);
      } else {
        const cutoff = new Date(today);
        cutoff.setDate(cutoff.getDate() + 60);
        const cutoffStr = cutoff.toISOString().split('T')[0];
        sqlConditions.push(sql`wc.date <= ${cutoffStr}`);
      }
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
    fullQuery = sql`${fullQuery} ORDER BY wc.date ASC, wc.time ASC LIMIT 500`;
    
    const result = await db.execute(fullQuery);
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
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
    const finalCapacity = capacity || (spots ? parseInt(spots.toString().replace(/[^0-9]/g, ''), 10) || null : null);
    
    const convertTo24Hour = (timeStr: string): string => {
      const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (match12h) {
        let hours = parseInt(match12h[1], 10);
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
      const durationMinutes = durationMatch ? parseInt(durationMatch[1], 10) : 60;
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
    const calendarDescription = description || '';
    const startTime24 = convertTo24Hour(time);
    const endTime24 = calculateEndTime(startTime24, duration);
    
    const createExtProps: Record<string, string> = {
      'ehApp_type': 'wellness',
    };
    if (category) createExtProps['ehApp_category'] = category;
    if (duration) createExtProps['ehApp_duration'] = duration;
    if (finalSpots) createExtProps['ehApp_spots'] = finalSpots;
    if (status) createExtProps['ehApp_status'] = status;
    if (image_url) createExtProps['ehApp_imageUrl'] = image_url;
    if (external_url) createExtProps['ehApp_externalUrl'] = external_url;
    
    let googleCalendarId: string | null = null;
    try {
      googleCalendarId = await createCalendarEventOnCalendar(
        calendarId,
        calendarTitle,
        calendarDescription,
        date,
        startTime24,
        endTime24,
        createExtProps
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
        await createWellnessAvailabilityBlocks((createdClass as unknown as WellnessClassRow).id, date, startTime24, endTime24, newBlockSimulators, newBlockConferenceRoom, userEmail, title);
      } catch (blockError: unknown) {
        logger.error('Failed to create availability blocks for wellness class', { extra: { error: blockError } });
      }
    }
    
    logFromRequest(req, 'create_wellness_class', 'wellness', String((createdClass as unknown as WellnessClassRow).id), title, {
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
    const finalCapacity = capacity || (spots ? parseInt(spots.toString().replace(/[^0-9]/g, ''), 10) || null : null);
    
    const wellnessId = parseInt(id as string, 10);
    if (isNaN(wellnessId)) return res.status(400).json({ error: 'Invalid wellness class ID' });
    
    const existing = await db.execute(sql`SELECT google_calendar_id, title, time, instructor, duration, category, date, block_bookings, block_simulators, block_conference_room, recurring_event_id FROM wellness_classes WHERE id = ${wellnessId}`);
    
    const _previousBlockBookings = existing.rows[0]?.block_bookings || false;
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
       WHERE id = ${wellnessId} RETURNING *`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    if (existing.rows.length > 0 && (existing.rows[0] as unknown as WellnessClassRow).google_calendar_id) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
        if (calendarId) {
          const updated = result.rows[0] as unknown as WellnessClassRow;
          const calendarTitle = `${updated.title} with ${updated.instructor}`;
          const calendarDescription = updated.description || '';
          const updateExtProps: Record<string, string> = {
            'ehApp_type': 'wellness',
            'ehApp_id': String(updated.id),
          };
          if (updated.category) updateExtProps['ehApp_category'] = updated.category as string;
          if (updated.duration) updateExtProps['ehApp_duration'] = updated.duration as string;
          if (updated.spots) updateExtProps['ehApp_spots'] = updated.spots as string;
          if (updated.status) updateExtProps['ehApp_status'] = updated.status as string;
          if (updated.image_url) updateExtProps['ehApp_imageUrl'] = updated.image_url as string;
          if (updated.external_url) updateExtProps['ehApp_externalUrl'] = updated.external_url as string;
          
          const convertTo24Hour = (timeStr: string): string => {
            const match12h = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
            if (match12h) {
              let hours = parseInt(match12h[1], 10);
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
            const durationMinutes = durationMatch ? parseInt(durationMatch[1], 10) : 60;
            const [hours, minutes] = startTime24.split(':').map(Number);
            const totalMinutes = hours * 60 + minutes + durationMinutes;
            const endHours = Math.floor(totalMinutes / 60) % 24;
            const endMins = totalMinutes % 60;
            return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
          };
          
          const startTime24 = convertTo24Hour(updated.time as string);
          const endTime24 = calculateEndTime(startTime24, updated.duration as string);
          
          await updateCalendarEvent(
            (existing.rows[0] as unknown as WellnessClassRow).google_calendar_id as string,
            calendarId,
            calendarTitle,
            calendarDescription,
            updated.date as string,
            startTime24,
            endTime24,
            updateExtProps
          );
        }
      } catch (calError: unknown) {
        logger.error('Failed to update Google Calendar event for wellness class', { extra: { error: calError } });
      }
    }
    
    const updated = result.rows[0] as unknown as WellnessClassRow;
    let recurringUpdated = 0;
    const existingRow = existing.rows[0] as unknown as WellnessClassRow;
    
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
               AND id != ${wellnessId} 
               AND date > ${updated.date}
               AND is_active = true
             RETURNING id, date, time, duration, title`);
        } else if (existingRow?.title) {
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
               AND EXTRACT(DOW FROM date) = EXTRACT(DOW FROM ${existingRow.date as string}::date)
               AND id != ${wellnessId} 
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
                    let hours = parseInt(match12h[1], 10);
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
                  const durationMinutes = durationMatch ? parseInt(durationMatch[1], 10) : 60;
                  const [hours, minutes] = startTime24.split(':').map(Number);
                  const totalMinutes = hours * 60 + minutes + durationMinutes;
                  const endHours = Math.floor(totalMinutes / 60) % 24;
                  const endMins = totalMinutes % 60;
                  return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
                };
                
                const recurRow = row as unknown as WellnessRecurringRow;
                const startTime24 = convertTime(recurRow.time);
                const endTime24 = calcEndTime(startTime24, recurRow.duration || updated.duration);
                
                await removeWellnessAvailabilityBlocks(recurRow.id);
                await createWellnessAvailabilityBlocks(
                  recurRow.id, recurRow.date, startTime24, endTime24, 
                  newBlockSimulators, newBlockConferenceRoom, 
                  recurringUserEmail, recurRow.title || updated.title
                );
              } catch (blockError: unknown) {
                logger.error(`Failed to create blocks for recurring wellness class ${row.id}`, { extra: { error: blockError } });
              }
            }
          } else {
            // Blocking was disabled - remove blocks from all recurring instances
            for (const row of recurringResult.rows as unknown as WellnessRecurringRow[]) {
              try {
                await removeWellnessAvailabilityBlocks(row.id);
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
    
    updated.recurringUpdated = recurringUpdated;
    const wellnessClassId = parseInt(id as string, 10);
    if (isNaN(wellnessClassId)) return res.status(400).json({ error: 'Invalid wellness class ID' });
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
        let hours = parseInt(match12h[1], 10);
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
      const durationMinutes = durationMatch ? parseInt(durationMatch[1], 10) : 60;
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
      const spotsValue = spotsMatch ? parseInt(spotsMatch[1], 10) : 0;
      const capacityValue = updated.capacity || 0;
      const hasValidSpots = spotsValue > 0 || Number(capacityValue) > 0;
      
      if (hasValidInstructor && hasValidCategory && hasValidSpots) {
        try {
          const reviewedResult = await db.execute(sql`UPDATE wellness_classes SET needs_review = false, reviewed_by = ${userEmail}, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true WHERE id = ${wellnessId} RETURNING *`);
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
      const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../../replit_integrations/auth/replitAuth');
      const isAdmin = await isAdminEmail(sessionEmail);
      if (!isAdmin) {
        const pool = getAuthPool();
        let isStaff = false;
        if (pool) {
          try {
            const { getAlternateDomainEmail } = await import('../../core/utils/emailNormalization');
            const altEmail = getAlternateDomainEmail(sessionEmail);
            const emailsToCheck = altEmail ? [sessionEmail, altEmail] : [sessionEmail];
            const placeholders = emailsToCheck.map((_, i) => `LOWER($${i + 1})`).join(', ');
            const result = await queryWithRetry(
              pool,
              `SELECT id FROM staff_users WHERE LOWER(email) IN (${placeholders}) AND is_active = true`,
              emailsToCheck
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
    const { class_id: rawClassId, user_email: raw_user_email } = req.body;
    const user_email = raw_user_email?.trim()?.toLowerCase();
    
    if (!rawClassId || !user_email) {
      return res.status(400).json({ error: 'Missing class_id or user_email' });
    }
    const class_id = parseInt(String(rawClassId), 10);
    if (isNaN(class_id)) {
      return res.status(400).json({ error: 'Invalid class_id' });
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
    
    const cls = classDataResult.rows[0] as unknown as WellnessClassRow;
    const dateStr = cls.date instanceof Date 
      ? cls.date.toISOString().split('T')[0] 
      : (typeof cls.date === 'string' ? cls.date.split('T')[0] : String(cls.date));
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const memberName = await getMemberDisplayName(user_email);
    
    const waitlistEnabled = cls.waitlist_enabled;
    
    let result;
    try {
      result = await db.transaction(async (tx) => {
        const lockedClassResult = await tx.execute(sql`SELECT capacity,
            COALESCE((SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = ${class_id} AND status = 'confirmed' AND is_waitlisted = false), 0)::integer as enrolled_count
          FROM wellness_classes WHERE id = ${class_id} FOR UPDATE`);
        
        const lockedCls = lockedClassResult.rows[0] as { capacity: number | null; enrolled_count: number };
        const capacity = lockedCls.capacity;
        const enrolledCount = lockedCls.enrolled_count;
        const isAtCapacity = capacity !== null && capacity !== undefined && enrolledCount >= capacity;
        
        if (isAtCapacity && !waitlistEnabled) {
          return { full: true as const };
        }
        
        const isWaitlisted = isAtCapacity && waitlistEnabled;
        
        const memberMessage = isWaitlisted 
          ? `You've been added to the waitlist for ${cls.title} with ${cls.instructor} on ${formattedDate} at ${formatTime12Hour(cls.time)}. We'll notify you if a spot opens up.`
          : `You're enrolled in ${cls.title} with ${cls.instructor} on ${formattedDate} at ${formatTime12Hour(cls.time)}.`;
        
        const enrollmentResult = await tx.insert(wellnessEnrollments)
          .values({
            classId: class_id,
            userEmail: user_email as string,
            status: 'confirmed',
            isWaitlisted: isWaitlisted as boolean
          })
          .returning();
        
        return { full: false as const, enrollment: enrollmentResult[0], isWaitlisted, memberMessage };
      });
    } catch (txErr: unknown) {
      if (String(txErr).includes('wellness_enrollments_unique_active')) {
        logger.info('[Wellness] Duplicate enrollment caught by unique constraint', { extra: { classId: class_id, userEmail: user_email } });
        return res.status(409).json({ error: 'Already enrolled in this class' });
      }
      throw txErr;
    }
    
    if (result.full) {
      return res.status(400).json({ error: 'This class is full' });
    }
    
    const { isWaitlisted, memberMessage } = result;
    
    notifyMember({
      userEmail: user_email as string,
      title: isWaitlisted ? 'Added to Waitlist' : 'Wellness Class Confirmed',
      message: memberMessage,
      type: 'wellness_booking',
      relatedId: class_id,
      relatedType: 'wellness_class',
      url: '/wellness'
    }).catch(err => logger.warn('Failed to send wellness enrollment notification', { extra: { error: err } }));
    const staffMessage = isWaitlisted
      ? `${memberName} joined the waitlist for ${cls.title} on ${formattedDate}`
      : `${memberName} enrolled in ${cls.title} on ${formattedDate}`;
    
    notifyAllStaff(
      isWaitlisted ? 'New Waitlist Entry' : 'New Wellness Enrollment',
      staffMessage,
      'wellness_enrollment',
      { relatedId: class_id, relatedType: 'wellness_class', url: '/admin/calendar' }
    ).catch(err => logger.warn('Failed to notify staff of wellness enrollment', { extra: { error: getErrorMessage(err) } }));
    
    broadcastToStaff({
      type: 'wellness_event',
      action: isWaitlisted ? 'waitlist_joined' : 'enrollment_created',
      classId: class_id,
      memberEmail: user_email
    });
    
    broadcastWaitlistUpdate({ classId: class_id, action: 'enrolled' });
    
    res.status(201).json({ ...result.enrollment, isWaitlisted, message: isWaitlisted ? 'Added to waitlist' : 'Enrolled' });
  } catch (error: unknown) {
    logger.error('Wellness enrollment error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to enroll in class. Staff notification is required.' });
  }
});

router.delete('/api/wellness-enrollments/:class_id/:user_email', isAuthenticated, async (req, res) => {
  try {
    const { class_id: rawClassId, user_email: rawUserEmail } = req.params;
    const class_id = parseInt(rawClassId as string, 10);
    if (isNaN(class_id)) {
      return res.status(400).json({ error: 'Invalid class_id' });
    }
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
        eq(wellnessEnrollments.classId, class_id),
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
    
    const cls = classDataResult.rows[0] as unknown as WellnessClassRow;
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
          eq(wellnessEnrollments.classId, class_id),
          eq(wellnessEnrollments.userEmail, user_email)
        ));
    });
    
    notifyAllStaff(
      'Wellness Enrollment Cancelled',
      staffMessage,
      'wellness_cancellation',
      { relatedId: class_id, relatedType: 'wellness_class', url: '/admin/calendar' }
    ).catch(err => logger.warn('Failed to notify staff of wellness cancellation', { extra: { error: err } }));
    
    // Delete the original "Wellness Class Confirmed" notification to avoid confusion
    try {
      await db.execute(sql`DELETE FROM notifications 
         WHERE LOWER(user_email) = LOWER(${user_email}) 
         AND related_id = ${class_id} 
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
      relatedId: class_id,
      relatedType: 'wellness',
      url: '/wellness'
    });
    
    // If a regular enrollment was cancelled and there are waitlisted users, promote the first one
    if (wasNotWaitlisted && parseInt(cls.waitlist_count as string, 10) > 0) {
      try {
        const promotedUserRow = await db.transaction(async (tx) => {
          const waitlistedResult = await tx.execute(sql`SELECT * FROM wellness_enrollments 
             WHERE class_id = ${class_id} 
               AND status = 'confirmed' 
               AND is_waitlisted = true
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`);
          
          if (waitlistedResult.rows.length === 0) return null;
          
          const row = waitlistedResult.rows[0] as unknown as WaitlistedUserRow;
          await tx.update(wellnessEnrollments)
            .set({ isWaitlisted: false })
            .where(eq(wellnessEnrollments.id, row.id as number));
          
          return row;
        });
        
        if (promotedUserRow) {
          const promotedEmail = promotedUserRow.user_email;
          const promotedName = await getMemberDisplayName(promotedEmail as string);
          
          const promotedMessage = `A spot opened up! You've been moved from the waitlist and are now enrolled in ${cls.title} with ${cls.instructor} on ${formattedDate} at ${formatTime12Hour(cls.time)}.`;
          
          notifyMember({
            userEmail: promotedEmail as string,
            title: 'Spot Available - You\'re In!',
            message: promotedMessage,
            type: 'wellness_booking',
            relatedId: class_id,
            relatedType: 'wellness_class',
            url: '/wellness'
          }).catch(err => logger.warn('Failed to send waitlist promotion notification', { extra: { error: getErrorMessage(err) } }));
          
          // Notify staff
          await notifyAllStaff(
            'Waitlist Promotion',
            `${promotedName} was automatically promoted from waitlist for ${cls.title} on ${formattedDate}`,
            'wellness_enrollment',
            { relatedId: class_id, relatedType: 'wellness_class', url: '/admin/calendar' }
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
      classId: class_id,
      memberEmail: user_email
    });
    
    // Broadcast waitlist update for real-time availability refresh (spot opened)
    const spotsQuery = await db.execute(sql`SELECT 
        CASE 
          WHEN capacity IS NOT NULL THEN GREATEST(0, capacity - COALESCE((SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = ${class_id} AND status = 'confirmed' AND is_waitlisted = false), 0))
          ELSE NULL
        END as spots_available
       FROM wellness_classes WHERE id = ${class_id}`);
    const spotsAvailable = (spotsQuery.rows[0] as unknown as WellnessClassRow)?.spots_available;
    broadcastWaitlistUpdate({ classId: class_id, action: 'spot_opened', spotsAvailable: (spotsAvailable as number) ?? undefined });
    
    logFromRequest(req, 'delete_wellness_class', 'wellness', String(class_id), undefined, {
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
    const wellnessClassId = parseInt(id as string, 10);
    if (isNaN(wellnessClassId)) return res.status(400).json({ error: 'Invalid wellness class ID' });
    
    const existing = await db.execute(sql`SELECT google_calendar_id FROM wellness_classes WHERE id = ${wellnessClassId}`);
    if (existing.rows.length > 0 && (existing.rows[0] as unknown as WellnessClassRow).google_calendar_id) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
        if (calendarId) {
          await deleteCalendarEvent((existing.rows[0] as unknown as WellnessClassRow).google_calendar_id as string, calendarId);
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
    
    const result = await db.execute(sql`DELETE FROM wellness_classes WHERE id = ${wellnessClassId} RETURNING *`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const deletedClass = result.rows[0] as unknown as WellnessClassRow;
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
    const classId = parseInt(id as string, 10);
    if (isNaN(classId)) return res.status(400).json({ error: 'Invalid wellness class ID' });
    
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
      eq(wellnessEnrollments.classId, classId),
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
    const classId = parseInt(id as string, 10);
    if (isNaN(classId)) return res.status(400).json({ error: 'Invalid wellness class ID' });
    const { email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const existingEnrollment = await db.select()
      .from(wellnessEnrollments)
      .where(and(
        eq(wellnessEnrollments.classId, classId),
        eq(wellnessEnrollments.userEmail, email),
        eq(wellnessEnrollments.status, 'confirmed')
      ))
      .limit(1);
    
    if (existingEnrollment.length > 0) {
      return res.status(400).json({ error: 'This email is already enrolled in this class' });
    }

    const classQuery = await db.execute(sql`SELECT id, title, instructor, date, time FROM wellness_classes WHERE id = ${classId}`);
    if (classQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    const classDetails = classQuery.rows[0] as unknown as WellnessClassDetailRow & { date: string | Date; time: string };

    await db.insert(wellnessEnrollments).values({
      classId,
      userEmail: email,
      status: 'confirmed',
    });
    
    const dateStr = classDetails.date instanceof Date 
      ? classDetails.date.toISOString().split('T')[0] 
      : (typeof classDetails.date === 'string' ? classDetails.date.split('T')[0] : String(classDetails.date));
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const classTitle = (classDetails?.title || 'Wellness Class') as string;
    const memberMessage = `You've been enrolled in ${classTitle} with ${classDetails.instructor || 'instructor'} on ${formattedDate} at ${formatTime12Hour(classDetails.time as string)} by staff.`;
    
    try {
      await notifyMember({
        userEmail: email,
        title: 'Wellness Class Confirmed',
        message: memberMessage,
        type: 'wellness_booking',
        relatedId: classId,
        relatedType: 'wellness_class',
        url: '/wellness'
      });
      
      broadcastToStaff({
        type: 'wellness_event',
        action: 'enrollment_created',
        classId,
        memberEmail: email
      });
    } catch (notifyErr: unknown) {
      logger.warn('Non-critical: Failed to send notifications for manual enrollment', { extra: { error: notifyErr, classId: id, email } });
    }
    
    logFromRequest(req, 'manual_enrollment', 'wellness', String(id), classTitle, {
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
