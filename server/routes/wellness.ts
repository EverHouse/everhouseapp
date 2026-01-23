import { Router } from 'express';
import { pool, isProduction } from '../core/db';
import { isStaffOrAdmin } from '../core/middleware';
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

async function createWellnessAvailabilityBlocks(wellnessClassId: number, classDate: string, startTime: string, endTime: string, createdBy?: string): Promise<void> {
  const bayIds = await getAllActiveBayIds();
  const conferenceRoomId = await getConferenceRoomId();
  
  const allResourceIds = [...bayIds];
  if (conferenceRoomId && !allResourceIds.includes(conferenceRoomId)) {
    allResourceIds.push(conferenceRoomId);
  }
  
  for (const resourceId of allResourceIds) {
    await pool.query(
      `INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by, wellness_class_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [resourceId, classDate, startTime, endTime || startTime, 'wellness', 'Blocked for wellness class', createdBy || 'system', wellnessClassId]
    );
  }
}

async function removeWellnessAvailabilityBlocks(wellnessClassId: number): Promise<void> {
  await pool.query('DELETE FROM availability_blocks WHERE wellness_class_id = $1', [wellnessClassId]);
}

async function updateWellnessAvailabilityBlocks(wellnessClassId: number, classDate: string, startTime: string, endTime: string, createdBy?: string): Promise<void> {
  await removeWellnessAvailabilityBlocks(wellnessClassId);
  await createWellnessAvailabilityBlocks(wellnessClassId, classDate, startTime, endTime, createdBy);
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
  } catch (error: any) {
    if (!isProduction) console.error('Wellness calendar sync error:', error);
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
      } catch (err: any) {
        errors.push(`Class ${wc.id}: ${err.message}`);
      }
    }
    
    res.json({
      message: `Created ${created} calendar events for existing wellness classes`,
      created,
      total: classesWithoutCalendar.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: any) {
    if (!isProduction) console.error('Wellness calendar backfill error:', error);
    res.status(500).json({ error: 'Failed to backfill wellness calendar events' });
  }
});

router.get('/api/wellness-classes/needs-review', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, time, instructor, duration, category, spots, status, description, date, 
              is_active, image_url, external_url, visibility, needs_review, conflict_detected 
       FROM wellness_classes 
       WHERE needs_review = true AND is_active = true
       ORDER BY date ASC, time ASC`
    );
    res.json(result.rows);
  } catch (error: any) {
    if (!isProduction) console.error('Fetch needs review error:', error);
    res.status(500).json({ error: 'Failed to fetch wellness classes needing review' });
  }
});

router.post('/api/wellness-classes/:id/mark-reviewed', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { applyToAll } = req.body;
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const existing = await pool.query(
      `SELECT title, time, date FROM wellness_classes WHERE id = $1`, [id]
    );
    const originalTitle = existing.rows[0]?.title;
    const originalTime = existing.rows[0]?.time;
    const originalDate = existing.rows[0]?.date;
    
    const result = await pool.query(
      `UPDATE wellness_classes 
       SET needs_review = false, reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true, conflict_detected = false,
           locally_edited = true, app_last_modified_at = NOW()
       WHERE id = $2 RETURNING *`,
      [reviewedBy, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const updatedClass = result.rows[0];
    let additionalUpdated = 0;
    
    if (applyToAll !== false) {
      let bulkResult;
      
      if (updatedClass.recurring_event_id) {
        bulkResult = await pool.query(
          `UPDATE wellness_classes 
           SET needs_review = false, 
               reviewed_by = $1, 
               reviewed_at = NOW(), 
               updated_at = NOW(), 
               review_dismissed = true, 
               conflict_detected = false,
               category = $3,
               instructor = $4,
               title = $5,
               image_url = COALESCE($6, image_url),
               external_url = COALESCE($7, external_url),
               locally_edited = true,
               app_last_modified_at = NOW()
           WHERE recurring_event_id = $2 
             AND id != $8 
             AND date >= $9
             AND is_active = true
           RETURNING id`,
          [
            reviewedBy, 
            updatedClass.recurring_event_id, 
            updatedClass.category,
            updatedClass.instructor,
            updatedClass.title,
            updatedClass.image_url,
            updatedClass.external_url,
            id,
            updatedClass.date
          ]
        );
      } else if (originalTitle && originalTime && originalDate) {
        const dayOfWeek = new Date(originalDate).getDay();
        
        bulkResult = await pool.query(
          `UPDATE wellness_classes 
           SET needs_review = false, 
               reviewed_by = $1, 
               reviewed_at = NOW(), 
               updated_at = NOW(), 
               review_dismissed = true, 
               conflict_detected = false,
               category = $3,
               instructor = $4,
               title = $5,
               image_url = COALESCE($6, image_url),
               external_url = COALESCE($7, external_url),
               locally_edited = true,
               app_last_modified_at = NOW()
           WHERE title = $8
             AND time = $9
             AND EXTRACT(DOW FROM date) = $10
             AND id != $11 
             AND date >= $12
             AND is_active = true
           RETURNING id`,
          [
            reviewedBy, 
            null,
            updatedClass.category,
            updatedClass.instructor,
            updatedClass.title,
            updatedClass.image_url,
            updatedClass.external_url,
            originalTitle,
            originalTime,
            dayOfWeek,
            id,
            updatedClass.date
          ]
        );
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
  } catch (error: any) {
    if (!isProduction) console.error('Mark reviewed error:', error);
    res.status(500).json({ error: 'Failed to mark wellness class as reviewed' });
  }
});

router.get('/api/wellness-classes', async (req, res) => {
  try {
    const { active_only, include_archived } = req.query;
    // Join with enrollments to get remaining spots and waitlist count
    let query = `
      SELECT wc.*, 
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
      ) w ON wc.id = w.class_id
    `;
    
    // Build WHERE conditions
    const conditions: string[] = [];
    const params: any[] = [];
    
    // Filter archived records by default unless include_archived=true
    if (include_archived !== 'true') {
      conditions.push('wc.archived_at IS NULL');
    }
    
    if (active_only === 'true') {
      conditions.push('wc.is_active = true');
      params.push(getTodayPacific());
      conditions.push(`wc.date >= $${params.length}`);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY wc.date ASC, wc.time ASC';
    const result = params.length > 0 
      ? await pool.query(query, params)
      : await pool.query(query);
    res.json(result.rows);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to fetch wellness classes' });
  }
});

router.post('/api/wellness-classes', isStaffOrAdmin, async (req, res) => {
  try {
    const { title, time, instructor, duration, category, spots, status, description, date, image_url, external_url, block_bookings, capacity, waitlist_enabled } = req.body;
    
    if (!title || !time || !instructor || !duration || !category || !spots || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
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
    const calendarDescription = [`Category: ${category}`, description, `Duration: ${duration}`, `Spots: ${spots}`].filter(Boolean).join('\n');
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
    } catch (calError: any) {
      if (!isProduction) console.error('Failed to create Google Calendar event for wellness class:', calError);
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    if (!googleCalendarId) {
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    const result = await pool.query(
      `INSERT INTO wellness_classes (title, time, instructor, duration, category, spots, status, description, date, google_calendar_id, image_url, external_url, block_bookings, capacity, waitlist_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [title, time, instructor, duration, category, spots, status || 'available', description || null, date, googleCalendarId, image_url || null, external_url || null, block_bookings || false, capacity || null, waitlist_enabled || false]
    );
    
    const createdClass = result.rows[0];
    
    if (block_bookings) {
      try {
        const userEmail = getSessionUser(req)?.email || 'system';
        await createWellnessAvailabilityBlocks(createdClass.id, date, startTime24, endTime24, userEmail);
      } catch (blockError) {
        if (!isProduction) console.error('Failed to create availability blocks for wellness class:', blockError);
      }
    }
    
    logFromRequest(req, 'create_wellness_class', 'wellness', String(createdClass.id), title, {
      instructor,
      date,
      time,
      duration,
      category,
      spots,
      description
    });
    
    res.status(201).json(createdClass);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to create wellness class' });
  }
});

router.put('/api/wellness-classes/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, time, instructor, duration, category, spots, status, description, date, is_active, image_url, external_url, block_bookings, capacity, waitlist_enabled, apply_to_recurring } = req.body;
    
    const existing = await pool.query('SELECT google_calendar_id, title, time, instructor, duration, category, date, block_bookings, recurring_event_id FROM wellness_classes WHERE id = $1', [id]);
    
    const previousBlockBookings = existing.rows[0]?.block_bookings || false;
    const newBlockBookings = block_bookings === true || block_bookings === 'true';
    const newWaitlistEnabled = waitlist_enabled === true || waitlist_enabled === 'true';
    
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'staff';
    
    const result = await pool.query(
      `UPDATE wellness_classes SET 
        title = COALESCE($1, title),
        time = COALESCE($2, time),
        instructor = COALESCE($3, instructor),
        duration = COALESCE($4, duration),
        category = COALESCE($5, category),
        spots = COALESCE($6, spots),
        status = COALESCE($7, status),
        description = COALESCE($8, description),
        date = COALESCE($9, date),
        is_active = COALESCE($10, is_active),
        image_url = COALESCE($11, image_url),
        external_url = COALESCE($12, external_url),
        block_bookings = $13,
        capacity = $14,
        waitlist_enabled = $15,
        locally_edited = true,
        app_last_modified_at = NOW(),
        updated_at = NOW(),
        conflict_detected = false,
        needs_review = false,
        review_dismissed = true,
        reviewed_by = $17,
        reviewed_at = NOW()
       WHERE id = $16 RETURNING *`,
      [title, time, instructor, duration, category, spots, status, description, date, is_active, image_url, external_url, newBlockBookings, capacity || null, newWaitlistEnabled, id, reviewedBy]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    if (existing.rows.length > 0 && existing.rows[0].google_calendar_id) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
        if (calendarId) {
          const updated = result.rows[0];
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
          
          const startTime24 = convertTo24Hour(updated.time);
          const endTime24 = calculateEndTime(startTime24, updated.duration);
          
          await updateCalendarEvent(
            existing.rows[0].google_calendar_id,
            calendarId,
            calendarTitle,
            calendarDescription,
            updated.date,
            startTime24,
            endTime24
          );
        }
      } catch (calError) {
        if (!isProduction) console.error('Failed to update Google Calendar event for wellness class:', calError);
      }
    }
    
    const updated = result.rows[0];
    let recurringUpdated = 0;
    const existingRow = existing.rows[0];
    
    if (apply_to_recurring !== false) {
      try {
        let recurringResult;
        
        if (existingRow?.recurring_event_id) {
          recurringResult = await pool.query(
            `UPDATE wellness_classes 
             SET category = COALESCE($1, category),
                 instructor = COALESCE($2, instructor),
                 title = COALESCE($3, title),
                 duration = COALESCE($4, duration),
                 spots = COALESCE($5, spots),
                 capacity = COALESCE($6, capacity),
                 image_url = COALESCE($7, image_url),
                 external_url = COALESCE($8, external_url),
                 needs_review = false,
                 reviewed_by = $9,
                 reviewed_at = NOW(),
                 review_dismissed = true,
                 conflict_detected = false,
                 updated_at = NOW(),
                 locally_edited = true,
                 app_last_modified_at = NOW()
             WHERE recurring_event_id = $10 
               AND id != $11 
               AND date > $12
               AND is_active = true
             RETURNING id`,
            [
              category, instructor, title, duration, spots, capacity || null, 
              image_url, external_url, reviewedBy,
              existingRow.recurring_event_id, id, updated.date
            ]
          );
        } else if (existingRow?.title) {
          const dayOfWeek = new Date(existingRow.date).getDay();
          const originalTime = existingRow.time;
          
          recurringResult = await pool.query(
            `UPDATE wellness_classes 
             SET category = COALESCE($1, category),
                 instructor = COALESCE($2, instructor),
                 title = COALESCE($3, title),
                 duration = COALESCE($4, duration),
                 spots = COALESCE($5, spots),
                 capacity = COALESCE($6, capacity),
                 image_url = COALESCE($7, image_url),
                 external_url = COALESCE($8, external_url),
                 needs_review = false,
                 reviewed_by = $9,
                 reviewed_at = NOW(),
                 review_dismissed = true,
                 conflict_detected = false,
                 updated_at = NOW(),
                 locally_edited = true,
                 app_last_modified_at = NOW()
             WHERE title = $10 
               AND time = $11
               AND EXTRACT(DOW FROM date) = $12
               AND id != $13 
               AND date > $14
               AND is_active = true
             RETURNING id`,
            [
              category, instructor, title, duration, spots, capacity || null, 
              image_url, external_url, reviewedBy,
              existingRow.title, originalTime, dayOfWeek, id, updated.date
            ]
          );
        }
        
        if (recurringResult) {
          recurringUpdated = recurringResult.rows.length;
        }
      } catch (recurError) {
        if (!isProduction) console.error('Failed to update recurring wellness classes:', recurError);
      }
    }
    
    (updated as any).recurringUpdated = recurringUpdated;
    const wellnessClassId = parseInt(id);
    const userEmail = getSessionUser(req)?.email || 'system';
    
    logFromRequest(req, 'update_wellness_class', 'wellness', String(wellnessClassId), updated.title, {
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
    
    try {
      const startTime24 = convertTo24HourForBlocks(updated.time);
      const endTime24 = calculateEndTimeForBlocks(startTime24, updated.duration);
      
      if (!previousBlockBookings && newBlockBookings) {
        await createWellnessAvailabilityBlocks(wellnessClassId, updated.date, startTime24, endTime24, userEmail);
      } else if (previousBlockBookings && !newBlockBookings) {
        await removeWellnessAvailabilityBlocks(wellnessClassId);
      } else if (newBlockBookings) {
        await updateWellnessAvailabilityBlocks(wellnessClassId, updated.date, startTime24, endTime24, userEmail);
      }
    } catch (blockError) {
      if (!isProduction) console.error('Failed to update availability blocks for wellness class:', blockError);
    }
    
    // Auto-clear needs_review if all required fields are filled
    if (updated.needs_review) {
      const hasValidInstructor = updated.instructor && updated.instructor.toLowerCase() !== 'tbd' && updated.instructor.trim() !== '';
      const hasValidCategory = updated.category && updated.category.toLowerCase() !== 'wellness' && updated.category.trim() !== '';
      const spotsMatch = updated.spots?.match(/(\d+)/);
      const spotsValue = spotsMatch ? parseInt(spotsMatch[1]) : 0;
      const capacityValue = updated.capacity || 0;
      const hasValidSpots = spotsValue > 0 || capacityValue > 0;
      
      if (hasValidInstructor && hasValidCategory && hasValidSpots) {
        try {
          const reviewedResult = await pool.query(
            `UPDATE wellness_classes SET needs_review = false, reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW(), review_dismissed = true WHERE id = $2 RETURNING *`,
            [userEmail, id]
          );
          if (reviewedResult.rows.length > 0) {
            Object.assign(updated, reviewedResult.rows[0]);
          }
        } catch (reviewError) {
          if (!isProduction) console.error('Failed to auto-clear needs_review:', reviewError);
        }
      }
    }
    
    res.json(updated);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
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
            isStaff = result.rows.length > 0;
          } catch (e) {
            if (!isProduction) console.warn('[wellness] Staff check query failed:', e);
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
  } catch (error: any) {
    if (!isProduction) console.error('Wellness enrollments error:', error);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

router.post('/api/wellness-enrollments', async (req, res) => {
  try {
    const { class_id, user_email } = req.body;
    
    if (!class_id || !user_email) {
      return res.status(400).json({ error: 'Missing class_id or user_email' });
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
    
    const classDataResult = await pool.query(
      `SELECT wc.*, 
        COALESCE((SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = wc.id AND status = 'confirmed' AND is_waitlisted = false), 0)::integer as enrolled_count
      FROM wellness_classes wc WHERE wc.id = $1`,
      [class_id]
    );
    
    if (classDataResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const cls = classDataResult.rows[0];
    // cls.date is a Date object from Postgres, convert to YYYY-MM-DD string
    const dateStr = cls.date instanceof Date 
      ? cls.date.toISOString().split('T')[0] 
      : (typeof cls.date === 'string' ? cls.date.split('T')[0] : String(cls.date));
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const memberName = user_email.split('@')[0];
    
    // Check capacity and determine if this should be a waitlist enrollment
    const capacity = cls.capacity;
    const enrolledCount = cls.enrolled_count;
    const waitlistEnabled = cls.waitlist_enabled;
    const isAtCapacity = capacity !== null && enrolledCount >= capacity;
    
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
          classId: class_id,
          userEmail: user_email,
          status: 'confirmed',
          isWaitlisted: isWaitlisted
        })
        .returning();
      
      await tx.insert(notifications).values({
        userEmail: user_email,
        title: isWaitlisted ? 'Added to Waitlist' : 'Wellness Class Confirmed',
        message: memberMessage,
        type: 'wellness_booking',
        relatedId: class_id,
        relatedType: 'wellness_class'
      });
      
      await notifyAllStaff(
        isWaitlisted ? 'New Waitlist Entry' : 'New Wellness Enrollment',
        staffMessage,
        'wellness_enrollment',
        { relatedId: class_id, relatedType: 'wellness_class', url: '/#/staff/calendar' }
      );
      
      return enrollmentResult[0];
    });
    
    sendPushNotification(user_email, {
      title: isWaitlisted ? 'Added to Waitlist' : 'Class Booked!',
      body: memberMessage,
      url: '/#/member-wellness'
    }).catch(err => console.error('Push notification failed:', err));
    
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
  } catch (error: any) {
    if (!isProduction) console.error('Wellness enrollment error:', error);
    res.status(500).json({ error: 'Failed to enroll in class. Staff notification is required.' });
  }
});

router.delete('/api/wellness-enrollments/:class_id/:user_email', async (req, res) => {
  try {
    const { class_id, user_email } = req.params;
    const enrollmentEmail = user_email.toLowerCase();
    
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
    
    const classDataResult = await pool.query(
      `SELECT wc.*, 
        (SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = wc.id AND status = 'confirmed' AND is_waitlisted = true) as waitlist_count
      FROM wellness_classes wc WHERE wc.id = $1`,
      [class_id]
    );
    
    if (classDataResult.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const cls = classDataResult.rows[0];
    // cls.date is a Date object from Postgres, convert to YYYY-MM-DD string
    const dateStr = cls.date instanceof Date 
      ? cls.date.toISOString().split('T')[0] 
      : (typeof cls.date === 'string' ? cls.date.split('T')[0] : String(cls.date));
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const memberName = user_email.split('@')[0];
    const staffMessage = `${memberName} cancelled their enrollment for ${cls.title} on ${formattedDate}`;
    
    await db.transaction(async (tx) => {
      await tx.update(wellnessEnrollments)
        .set({ status: 'cancelled' })
        .where(and(
          eq(wellnessEnrollments.classId, parseInt(class_id)),
          eq(wellnessEnrollments.userEmail, user_email)
        ));
      
      await notifyAllStaff(
        'Wellness Enrollment Cancelled',
        staffMessage,
        'wellness_cancellation',
        { relatedId: parseInt(class_id), relatedType: 'wellness_class', url: '/#/staff/calendar' }
      );
    });
    
    await notifyMember({
      userEmail: user_email,
      title: 'Wellness Enrollment Cancelled',
      message: `Your enrollment in "${cls.title}" on ${formattedDate} has been cancelled`,
      type: 'wellness',
      relatedId: parseInt(class_id),
      relatedType: 'wellness',
      url: '/#/wellness'
    });
    
    // If a regular enrollment was cancelled and there are waitlisted users, promote the first one
    if (wasNotWaitlisted && parseInt(cls.waitlist_count) > 0) {
      try {
        // Get the first person on waitlist (oldest entry)
        const waitlistedUsers = await db.select()
          .from(wellnessEnrollments)
          .where(and(
            eq(wellnessEnrollments.classId, parseInt(class_id)),
            eq(wellnessEnrollments.status, 'confirmed'),
            eq(wellnessEnrollments.isWaitlisted, true)
          ))
          .orderBy(asc(wellnessEnrollments.createdAt))
          .limit(1);
        
        if (waitlistedUsers.length > 0) {
          const promotedUser = waitlistedUsers[0];
          const promotedEmail = promotedUser.userEmail;
          const promotedName = promotedEmail.split('@')[0];
          
          // Promote from waitlist
          await db.update(wellnessEnrollments)
            .set({ isWaitlisted: false })
            .where(eq(wellnessEnrollments.id, promotedUser.id));
          
          const promotedMessage = `A spot opened up! You've been moved from the waitlist and are now enrolled in ${cls.title} with ${cls.instructor} on ${formattedDate} at ${cls.time}.`;
          
          // Create notification for promoted user
          await db.insert(notifications).values({
            userEmail: promotedEmail,
            title: 'Spot Available - You\'re In!',
            message: promotedMessage,
            type: 'wellness_booking',
            relatedId: parseInt(class_id),
            relatedType: 'wellness_class'
          });
          
          // Send push notification
          sendPushNotification(promotedEmail, {
            title: 'Spot Available - You\'re In!',
            body: promotedMessage,
            url: '/#/member-wellness'
          }).catch(err => console.error('Push notification failed:', err));
          
          // Send real-time WebSocket notification
          sendNotificationToUser(promotedEmail, {
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
            { relatedId: parseInt(class_id), relatedType: 'wellness_class', url: '/#/staff/calendar' }
          );
        }
      } catch (promoteError) {
        if (!isProduction) console.error('Failed to promote waitlisted user:', promoteError);
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
    const spotsQuery = await pool.query(
      `SELECT 
        CASE 
          WHEN capacity IS NOT NULL THEN GREATEST(0, capacity - COALESCE((SELECT COUNT(*) FROM wellness_enrollments WHERE class_id = $1 AND status = 'confirmed' AND is_waitlisted = false), 0))
          ELSE NULL
        END as spots_available
       FROM wellness_classes WHERE id = $1`,
      [class_id]
    );
    const spotsAvailable = spotsQuery.rows[0]?.spots_available;
    broadcastWaitlistUpdate({ classId: parseInt(class_id), action: 'spot_opened', spotsAvailable: spotsAvailable ?? undefined });
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Wellness enrollment cancellation error:', error);
    res.status(500).json({ error: 'Failed to cancel enrollment. Staff notification is required.' });
  }
});

router.delete('/api/wellness-classes/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const wellnessClassId = parseInt(id);
    
    const existing = await pool.query('SELECT google_calendar_id FROM wellness_classes WHERE id = $1', [id]);
    if (existing.rows.length > 0 && existing.rows[0].google_calendar_id) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
        if (calendarId) {
          await deleteCalendarEvent(existing.rows[0].google_calendar_id, calendarId);
        }
      } catch (calError) {
        if (!isProduction) console.error('Failed to delete Google Calendar event for wellness class:', calError);
      }
    }
    
    try {
      await removeWellnessAvailabilityBlocks(wellnessClassId);
    } catch (blockError) {
      if (!isProduction) console.error('Failed to remove availability blocks for wellness class:', blockError);
    }
    
    const result = await pool.query(
      'DELETE FROM wellness_classes WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wellness class not found' });
    }
    
    const deletedClass = result.rows[0];
    logFromRequest(req, 'delete_wellness_class', 'wellness', String(deletedClass.id), deletedClass.title, {
      instructor: deletedClass.instructor,
      date: deletedClass.date,
      time: deletedClass.time,
      duration: deletedClass.duration,
      category: deletedClass.category,
      spots: deletedClass.spots
    });
    
    res.json({ message: 'Wellness class deleted', class: deletedClass });
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
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
      eq(wellnessEnrollments.classId, parseInt(id)),
      eq(wellnessEnrollments.status, 'confirmed')
    ))
    .orderBy(desc(wellnessEnrollments.createdAt));
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

router.post('/api/wellness-classes/:id/enrollments/manual', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const existingEnrollment = await db.select()
      .from(wellnessEnrollments)
      .where(and(
        eq(wellnessEnrollments.classId, parseInt(id)),
        eq(wellnessEnrollments.userEmail, email),
        eq(wellnessEnrollments.status, 'confirmed')
      ))
      .limit(1);
    
    if (existingEnrollment.length > 0) {
      return res.status(400).json({ error: 'This email is already enrolled in this class' });
    }

    // Get the class details for audit logging
    const classQuery = await pool.query(
      'SELECT id, title, instructor FROM wellness_classes WHERE id = $1',
      [parseInt(id)]
    );
    const classDetails = classQuery.rows[0];

    await db.insert(wellnessEnrollments).values({
      classId: parseInt(id),
      userEmail: email,
      status: 'confirmed',
    });
    
    logFromRequest(req, 'manual_enrollment', 'wellness', String(id), classDetails?.title || 'Wellness Class', {
      instructor: classDetails?.instructor,
      memberEnrolled: email
    });
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Manual enrollment error:', error);
    res.status(500).json({ error: 'Failed to add enrollment' });
  }
});

export default router;
