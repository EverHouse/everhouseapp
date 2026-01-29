import { Router } from 'express';
import { isProduction, pool } from '../core/db';
import { isStaffOrAdmin } from '../core/middleware';
import { db } from '../db';
import { events, eventRsvps, users, notifications, availabilityBlocks } from '../../shared/schema';
import { eq, and, or, sql, gte, desc, isNotNull } from 'drizzle-orm';
import { syncGoogleCalendarEvents, syncWellnessCalendarEvents, backfillWellnessToCalendar, getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent, updateCalendarEvent, CALENDAR_CONFIG } from '../core/calendar/index';
import { sendPushNotification } from './push';
import { notifyAllStaff, notifyMember } from '../core/notificationService';
import { createPacificDate, parseLocalDate, formatDateDisplayWithDay, getTodayPacific, getPacificDateParts } from '../utils/dateUtils';
import { getAllActiveBayIds, getConferenceRoomId } from '../core/affectedAreas';
import { sendNotificationToUser, broadcastToStaff } from '../core/websocket';
import { getSessionUser } from '../types/session';
import { logFromRequest } from '../core/auditLog';

async function createEventAvailabilityBlocks(
  eventId: number, 
  eventDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean, 
  blockConferenceRoom: boolean,
  createdBy?: string,
  eventTitle?: string
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
  
  const blockNotes = eventTitle ? `Blocked for: ${eventTitle}` : 'Blocked for event';
  
  for (const resourceId of resourceIds) {
    await pool.query(
      `INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [resourceId, eventDate, startTime, endTime || startTime, 'event', blockNotes, createdBy || 'system', eventId]
    );
  }
}

async function removeEventAvailabilityBlocks(eventId: number): Promise<void> {
  await pool.query('DELETE FROM availability_blocks WHERE event_id = $1', [eventId]);
}

async function updateEventAvailabilityBlocks(
  eventId: number, 
  eventDate: string, 
  startTime: string, 
  endTime: string, 
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  createdBy?: string,
  eventTitle?: string
): Promise<void> {
  await removeEventAvailabilityBlocks(eventId);
  if (blockSimulators || blockConferenceRoom) {
    await createEventAvailabilityBlocks(eventId, eventDate, startTime, endTime, blockSimulators, blockConferenceRoom, createdBy, eventTitle);
  }
}

const router = Router();

router.post('/api/events/sync/google', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await syncGoogleCalendarEvents();
    if (result.error) {
      return res.status(404).json(result);
    }
    res.json({
      success: true,
      message: `Synced ${result.synced} events from Google Calendar`,
      ...result
    });
  } catch (error: any) {
    if (!isProduction) console.error('Google Calendar sync error:', error);
    res.status(500).json({ error: 'Failed to sync Google Calendar events' });
  }
});

router.post('/api/events/sync', isStaffOrAdmin, async (req, res) => {
  try {
    const googleResult = await syncGoogleCalendarEvents();
    
    let eventbriteResult = { synced: 0, created: 0, updated: 0, error: 'No Eventbrite token configured' };
    const eventbriteToken = process.env.EVENTBRITE_PRIVATE_TOKEN;
    if (eventbriteToken) {
      eventbriteResult = { synced: 0, created: 0, updated: 0, error: undefined as any };
    }
    
    logFromRequest(req, 'sync_events', 'event', undefined, 'Event Sync', {
      google_synced: googleResult.synced,
      google_created: googleResult.created,
      google_updated: googleResult.updated,
      google_error: googleResult.error,
      eventbrite_synced: eventbriteResult.synced,
      eventbrite_created: eventbriteResult.created,
      eventbrite_updated: eventbriteResult.updated,
      eventbrite_error: eventbriteResult.error
    });
    
    res.json({
      success: true,
      google: googleResult,
      eventbrite: eventbriteResult.error ? { error: eventbriteResult.error } : eventbriteResult
    });
  } catch (error: any) {
    if (!isProduction) console.error('Event sync error:', error);
    res.status(500).json({ error: 'Failed to sync events' });
  }
});

router.post('/api/calendars/sync-all', isStaffOrAdmin, async (req, res) => {
  try {
    const [eventsResult, wellnessResult, backfillResult] = await Promise.all([
      syncGoogleCalendarEvents().catch(() => ({ synced: 0, created: 0, updated: 0, error: 'Events sync failed' })),
      syncWellnessCalendarEvents().catch(() => ({ synced: 0, created: 0, updated: 0, error: 'Wellness sync failed' })),
      backfillWellnessToCalendar().catch(() => ({ created: 0, total: 0, errors: ['Backfill failed'] }))
    ]);
    
    const eventsSynced = eventsResult?.synced || 0;
    const wellnessSynced = wellnessResult?.synced || 0;
    const wellnessBackfilled = backfillResult?.created || 0;
    
    res.json({
      success: true,
      events: {
        synced: eventsSynced,
        created: eventsResult?.created || 0,
        updated: eventsResult?.updated || 0,
        error: eventsResult?.error
      },
      wellness: {
        synced: wellnessSynced,
        created: wellnessResult?.created || 0,
        updated: wellnessResult?.updated || 0,
        error: wellnessResult?.error
      },
      wellnessBackfill: {
        created: wellnessBackfilled,
        total: backfillResult?.total || 0,
        errors: backfillResult?.errors?.length > 0 ? backfillResult.errors : undefined
      },
      message: `Synced ${eventsSynced} events and ${wellnessSynced} wellness classes from Google Calendar. Created ${wellnessBackfilled} calendar events for existing classes.`
    });
  } catch (error: any) {
    if (!isProduction) console.error('Calendar sync error:', error);
    res.status(500).json({ error: 'Failed to sync calendars' });
  }
});

router.get('/api/events/needs-review', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.select({
      id: events.id,
      title: events.title,
      description: events.description,
      event_date: events.eventDate,
      start_time: events.startTime,
      end_time: events.endTime,
      location: events.location,
      category: events.category,
      source: events.source,
      visibility: events.visibility,
      needs_review: events.needsReview,
      conflict_detected: events.conflictDetected,
      block_simulators: events.blockSimulators,
      block_conference_room: events.blockConferenceRoom,
    }).from(events)
      .where(eq(events.needsReview, true))
      .orderBy(events.eventDate, events.startTime);
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to fetch events needing review' });
  }
});

router.post('/api/events/:id/mark-reviewed', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'unknown';
    
    const result = await db.update(events).set({
      needsReview: false,
      reviewedBy,
      reviewedAt: new Date(),
      reviewDismissed: true,
      conflictDetected: false,
    }).where(eq(events.id, parseInt(id))).returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json({ success: true, event: result[0] });
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to mark event as reviewed' });
  }
});

router.get('/api/events', async (req, res) => {
  try {
    const { date, include_past, visibility, include_archived } = req.query;
    const conditions: any[] = [];
    const todayPacific = getTodayPacific();
    
    // Filter archived records by default unless include_archived=true
    if (include_archived !== 'true') {
      conditions.push(sql`${events.archivedAt} IS NULL`);
    }
    
    if (date) {
      conditions.push(eq(events.eventDate, date as string));
    } else if (include_past !== 'true') {
      conditions.push(gte(events.eventDate, todayPacific));
    }
    
    if (visibility) {
      conditions.push(eq(events.visibility, visibility as string));
    }
    
    const query = db.select({
      id: events.id,
      title: events.title,
      description: events.description,
      event_date: events.eventDate,
      start_time: events.startTime,
      end_time: events.endTime,
      location: events.location,
      category: events.category,
      image_url: events.imageUrl,
      max_attendees: events.maxAttendees,
      eventbrite_id: events.eventbriteId,
      eventbrite_url: events.eventbriteUrl,
      external_url: events.externalUrl,
      source: events.source,
      visibility: events.visibility,
      requires_rsvp: events.requiresRsvp,
      google_calendar_id: events.googleCalendarId,
    }).from(events);
    
    let result;
    if (conditions.length > 0) {
      result = await query.where(and(...conditions)).orderBy(events.eventDate, events.startTime);
    } else {
      result = await query.orderBy(events.eventDate, events.startTime);
    }
    
    // Filter out today's events that have already ended (using end_time or start_time)
    if (include_past !== 'true' && !date) {
      const parts = getPacificDateParts();
      const currentTimeStr = `${parts.hour.toString().padStart(2, '0')}:${parts.minute.toString().padStart(2, '0')}:00`;
      
      result = result.filter(event => {
        if (event.event_date !== todayPacific) {
          return true;
        }
        const eventEndTime = event.end_time || event.start_time || '23:59:59';
        return eventEndTime > currentTimeStr;
      });
    }
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/api/events', isStaffOrAdmin, async (req, res) => {
  try {
    const { title, description, event_date, start_time, end_time, location, category, image_url, max_attendees, visibility, requires_rsvp, external_url, block_bookings, block_simulators, block_conference_room } = req.body;
    
    const trimmedTitle = title?.toString().trim();
    const trimmedEventDate = event_date?.toString().trim();
    const trimmedStartTime = start_time?.toString().trim();
    const trimmedEndTime = end_time?.toString().trim() || null;
    
    if (!trimmedTitle || !trimmedEventDate || !trimmedStartTime) {
      return res.status(400).json({ error: 'Missing required fields: title, event_date, and start_time are required' });
    }
    
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;
    
    if (!dateRegex.test(trimmedEventDate)) {
      return res.status(400).json({ error: 'Invalid event_date format. Use YYYY-MM-DD' });
    }
    
    if (!timeRegex.test(trimmedStartTime)) {
      return res.status(400).json({ error: 'Invalid start_time format. Use HH:MM or HH:MM:SS' });
    }
    
    if (trimmedEndTime && !timeRegex.test(trimmedEndTime)) {
      return res.status(400).json({ error: 'Invalid end_time format. Use HH:MM or HH:MM:SS' });
    }
    
    const testDate = createPacificDate(trimmedEventDate, trimmedStartTime);
    if (isNaN(testDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date/time combination' });
    }
    
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
    if (!calendarId) {
      return res.status(500).json({ error: 'Events calendar not configured. Please contact support.' });
    }
    
    const eventDescription = [description, location ? `Location: ${location}` : ''].filter(Boolean).join('\n');
    
    let googleCalendarId: string | null = null;
    try {
      googleCalendarId = await createCalendarEventOnCalendar(
        calendarId,
        trimmedTitle,
        eventDescription,
        trimmedEventDate,
        trimmedStartTime,
        trimmedEndTime || trimmedStartTime
      );
    } catch (calError: any) {
      if (!isProduction) console.error('Failed to create Google Calendar event:', calError);
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    if (!googleCalendarId) {
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    const newBlockSimulators = block_simulators === true || block_simulators === 'true';
    const newBlockConferenceRoom = block_conference_room === true || block_conference_room === 'true';
    
    const result = await db.insert(events).values({
      title: trimmedTitle,
      description,
      eventDate: trimmedEventDate,
      startTime: trimmedStartTime,
      endTime: trimmedEndTime,
      location,
      category,
      imageUrl: image_url,
      maxAttendees: max_attendees,
      source: 'manual',
      visibility: visibility || 'public',
      requiresRsvp: requires_rsvp || false,
      googleCalendarId: googleCalendarId,
      externalUrl: external_url || null,
      blockBookings: block_bookings || false,
      blockSimulators: newBlockSimulators,
      blockConferenceRoom: newBlockConferenceRoom,
    }).returning();
    
    const createdEvent = result[0];
    
    if (newBlockSimulators || newBlockConferenceRoom) {
      try {
        const userEmail = getSessionUser(req)?.email || 'system';
        await createEventAvailabilityBlocks(createdEvent.id, trimmedEventDate, trimmedStartTime, trimmedEndTime || trimmedStartTime, newBlockSimulators, newBlockConferenceRoom, userEmail, createdEvent.title);
      } catch (blockError) {
        if (!isProduction) console.error('Failed to create availability blocks for event:', blockError);
      }
    }
    
    logFromRequest(req, 'create_event', 'event', String(createdEvent.id), createdEvent.title, {
      event_date: createdEvent.eventDate,
      start_time: createdEvent.startTime,
      end_time: createdEvent.endTime,
      location: createdEvent.location,
      category: createdEvent.category,
      max_attendees: createdEvent.maxAttendees,
      block_simulators: createdEvent.blockSimulators,
      block_conference_room: createdEvent.blockConferenceRoom
    });
    
    res.status(201).json(createdEvent);
  } catch (error: any) {
    if (!isProduction) console.error('Event creation error:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

router.put('/api/events/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, event_date, start_time, end_time, location, category, image_url, max_attendees, external_url, block_bookings, block_simulators, block_conference_room } = req.body;
    
    const trimmedTitle = title?.toString().trim();
    const trimmedEventDate = event_date?.toString().trim();
    const trimmedStartTime = start_time?.toString().trim();
    const trimmedEndTime = end_time?.toString().trim() || null;
    
    if (!trimmedTitle || !trimmedEventDate || !trimmedStartTime) {
      return res.status(400).json({ error: 'Missing required fields: title, event_date, and start_time are required' });
    }
    
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const timeRegex = /^\d{2}:\d{2}(:\d{2})?$/;
    
    if (!dateRegex.test(trimmedEventDate)) {
      return res.status(400).json({ error: 'Invalid event_date format. Use YYYY-MM-DD' });
    }
    
    if (!timeRegex.test(trimmedStartTime)) {
      return res.status(400).json({ error: 'Invalid start_time format. Use HH:MM or HH:MM:SS' });
    }
    
    if (trimmedEndTime && !timeRegex.test(trimmedEndTime)) {
      return res.status(400).json({ error: 'Invalid end_time format. Use HH:MM or HH:MM:SS' });
    }
    
    const testDate = createPacificDate(trimmedEventDate, trimmedStartTime);
    if (isNaN(testDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date/time combination' });
    }
    
    const existing = await db.select({ 
      googleCalendarId: events.googleCalendarId,
      blockBookings: events.blockBookings,
      blockSimulators: events.blockSimulators,
      blockConferenceRoom: events.blockConferenceRoom,
      needsReview: events.needsReview
    }).from(events).where(eq(events.id, parseInt(id)));
    
    const previousBlockBookings = existing[0]?.blockBookings || false;
    const previousBlockSimulators = existing[0]?.blockSimulators || false;
    const previousBlockConferenceRoom = existing[0]?.blockConferenceRoom || false;
    const newBlockBookings = block_bookings === true || block_bookings === 'true';
    const newBlockSimulators = block_simulators === true || block_simulators === 'true';
    const newBlockConferenceRoom = block_conference_room === true || block_conference_room === 'true';
    
    // Auto-exit needs review when required fields are filled:
    // - Category is set and not generic
    // - Description is not empty
    // - Location is not empty
    const hasValidCategory = category && category.trim() !== '' && category !== 'General';
    const hasDescription = description && description.trim() !== '';
    const hasLocation = location && location.trim() !== '';
    const shouldClearReview = existing[0]?.needsReview && hasValidCategory && hasDescription && hasLocation;
    
    const updateData: any = {
      title: trimmedTitle,
      description,
      eventDate: trimmedEventDate,
      startTime: trimmedStartTime,
      endTime: trimmedEndTime,
      location,
      category,
      imageUrl: image_url,
      maxAttendees: max_attendees,
      externalUrl: external_url || null,
      blockBookings: newBlockBookings,
      blockSimulators: newBlockSimulators,
      blockConferenceRoom: newBlockConferenceRoom,
      locallyEdited: true,
      appLastModifiedAt: new Date(),
    };
    
    // If all required fields are filled, auto-clear the needs review flag
    if (shouldClearReview) {
      updateData.needsReview = false;
      updateData.reviewedAt = new Date();
      updateData.reviewedBy = getSessionUser(req)?.email || 'system';
      updateData.reviewDismissed = true;
      updateData.conflictDetected = false;
    }
    
    // Always clear conflict_detected when saving an event (user is acknowledging changes)
    updateData.conflictDetected = false;
    
    const result = await db.update(events).set(updateData).where(eq(events.id, parseInt(id))).returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    if (existing.length > 0 && existing[0].googleCalendarId) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
        if (calendarId) {
          const calendarTitle = category ? `[${category}] ${trimmedTitle}` : trimmedTitle;
          const eventDescription = [description, location ? `Location: ${location}` : ''].filter(Boolean).join('\n');
          await updateCalendarEvent(
            existing[0].googleCalendarId,
            calendarId,
            calendarTitle,
            eventDescription,
            trimmedEventDate,
            trimmedStartTime,
            trimmedEndTime || trimmedStartTime
          );
        }
      } catch (calError) {
        if (!isProduction) console.error('Failed to update Google Calendar event:', calError);
      }
    }
    
    const eventId = parseInt(id);
    const userEmail = getSessionUser(req)?.email || 'system';
    
    // Determine if blocking has changed
    const hadAnyBlocking = previousBlockSimulators || previousBlockConferenceRoom;
    const hasAnyBlocking = newBlockSimulators || newBlockConferenceRoom;
    
    const updatedEvent = result[0];
    
    try {
      if (!hadAnyBlocking && hasAnyBlocking) {
        // Blocks newly enabled
        await createEventAvailabilityBlocks(eventId, trimmedEventDate, trimmedStartTime, trimmedEndTime || trimmedStartTime, newBlockSimulators, newBlockConferenceRoom, userEmail, updatedEvent.title);
      } else if (hadAnyBlocking && !hasAnyBlocking) {
        // Blocks disabled
        await removeEventAvailabilityBlocks(eventId);
      } else if (hasAnyBlocking) {
        // Blocks changed or time/date changed
        await updateEventAvailabilityBlocks(eventId, trimmedEventDate, trimmedStartTime, trimmedEndTime || trimmedStartTime, newBlockSimulators, newBlockConferenceRoom, userEmail, updatedEvent.title);
      }
    } catch (blockError) {
      if (!isProduction) console.error('Failed to update availability blocks for event:', blockError);
    }
    logFromRequest(req, 'update_event', 'event', String(updatedEvent.id), updatedEvent.title, {
      event_date: updatedEvent.eventDate,
      start_time: updatedEvent.startTime,
      end_time: updatedEvent.endTime,
      location: updatedEvent.location,
      category: updatedEvent.category,
      max_attendees: updatedEvent.maxAttendees,
      block_simulators: updatedEvent.blockSimulators,
      block_conference_room: updatedEvent.blockConferenceRoom,
      locally_edited: updatedEvent.locallyEdited
    });
    
    res.json(updatedEvent);
  } catch (error: any) {
    if (!isProduction) console.error('Event update error:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

router.get('/api/events/:id/cascade-preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id);
    
    const [event] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId));
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const rsvpsResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(eventRsvps)
      .where(eq(eventRsvps.eventId, eventId));
    const rsvpsCount = rsvpsResult[0]?.count || 0;
    
    res.json({
      eventId,
      relatedData: {
        rsvps: rsvpsCount
      },
      hasRelatedData: rsvpsCount > 0
    });
  } catch (error: any) {
    if (!isProduction) console.error('Event cascade preview error:', error);
    res.status(500).json({ error: 'Failed to fetch cascade preview' });
  }
});

router.delete('/api/events/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id);
    const sessionUser = getSessionUser(req);
    const archivedBy = sessionUser?.email || 'unknown';
    
    const existing = await db.select({ 
      googleCalendarId: events.googleCalendarId,
      archivedAt: events.archivedAt 
    }).from(events).where(eq(events.id, eventId));
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    if (existing[0].archivedAt) {
      return res.status(400).json({ error: 'Event is already archived' });
    }
    
    if (existing[0].googleCalendarId) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
        if (calendarId) {
          await deleteCalendarEvent(existing[0].googleCalendarId, calendarId);
        } else {
          console.error(`[Events] Calendar "${CALENDAR_CONFIG.events.name}" not found for event deletion`);
        }
      } catch (calError: any) {
        console.error('Failed to delete Google Calendar event:', calError?.message || calError);
      }
    }
    
    try {
      await removeEventAvailabilityBlocks(eventId);
    } catch (blockError) {
      if (!isProduction) console.error('Failed to remove availability blocks for event:', blockError);
    }
    
    const eventBeforeDelete = await db.select({
      title: events.title,
      eventDate: events.eventDate,
      startTime: events.startTime,
      location: events.location
    }).from(events).where(eq(events.id, eventId));
    
    await db.update(events)
      .set({
        archivedAt: new Date(),
        archivedBy: archivedBy
      })
      .where(eq(events.id, eventId));
    
    const deletedEvent = eventBeforeDelete[0] || { title: 'Unknown', eventDate: '', startTime: '', location: '' };
    logFromRequest(req, 'delete_event', 'event', String(eventId), deletedEvent.title, {
      event_date: deletedEvent.eventDate,
      start_time: deletedEvent.startTime,
      location: deletedEvent.location,
      archived_by: archivedBy
    });
    
    res.json({ success: true, archived: true, archivedBy });
  } catch (error: any) {
    console.error('Event archive error:', error?.message || error);
    res.status(500).json({ error: 'Failed to archive event', details: error?.message });
  }
});

router.post('/api/eventbrite/sync', async (req, res) => {
  try {
    const eventbriteToken = process.env.EVENTBRITE_PRIVATE_TOKEN;
    if (!eventbriteToken) {
      return res.json({ 
        success: true, 
        skipped: true, 
        synced: 0, 
        message: 'Eventbrite not configured - skipping sync' 
      });
    }

    const meResponse = await fetch('https://www.eventbriteapi.com/v3/users/me/organizations/', {
      headers: { 'Authorization': `Bearer ${eventbriteToken}` }
    });
    
    if (!meResponse.ok) {
      const errorText = await meResponse.text();
      if (!isProduction) console.error('Eventbrite org fetch error:', errorText);
      return res.status(400).json({ error: 'Failed to fetch Eventbrite organizations' });
    }
    
    const orgData = await meResponse.json() as { organizations?: { id: string }[] };
    const organizationId = orgData.organizations?.[0]?.id;
    
    if (!organizationId) {
      return res.status(400).json({ error: 'No Eventbrite organization found' });
    }

    const eventsResponse = await fetch(
      `https://www.eventbriteapi.com/v3/organizations/${organizationId}/events/?status=live,started,ended&order_by=start_desc`,
      { headers: { 'Authorization': `Bearer ${eventbriteToken}` } }
    );

    if (!eventsResponse.ok) {
      const errorText = await eventsResponse.text();
      if (!isProduction) console.error('Eventbrite events fetch error:', errorText);
      return res.status(400).json({ error: 'Failed to fetch Eventbrite events' });
    }

    const eventsData = await eventsResponse.json() as { events?: any[] };
    const eventbriteEvents = eventsData.events || [];

    let synced = 0;
    let updated = 0;

    for (const ebEvent of eventbriteEvents) {
      const eventbriteId = ebEvent.id;
      const title = ebEvent.name?.text || 'Untitled Event';
      const description = ebEvent.description?.text || '';
      const eventDate = ebEvent.start?.local?.split('T')[0] || null;
      const startTime = ebEvent.start?.local?.split('T')[1]?.substring(0, 8) || '18:00:00';
      const endTime = ebEvent.end?.local?.split('T')[1]?.substring(0, 8) || '21:00:00';
      const location = ebEvent.venue?.name || ebEvent.online_event ? 'Online Event' : 'TBD';
      const imageUrl = ebEvent.logo?.url || null;
      const eventbriteUrl = ebEvent.url || null;
      const maxAttendees = ebEvent.capacity || null;

      const existing = await db.select({ id: events.id })
        .from(events)
        .where(eq(events.eventbriteId, eventbriteId));

      if (existing.length > 0) {
        await db.update(events).set({
          title,
          description,
          eventDate,
          startTime,
          endTime,
          location,
          imageUrl,
          eventbriteUrl,
          maxAttendees,
          source: 'eventbrite',
          visibility: 'members_only',
          requiresRsvp: true,
        }).where(eq(events.eventbriteId, eventbriteId));
        updated++;
      } else {
        await db.insert(events).values({
          title,
          description,
          eventDate,
          startTime,
          endTime,
          location,
          category: 'Social',
          imageUrl,
          eventbriteId,
          eventbriteUrl,
          maxAttendees,
          source: 'eventbrite',
          visibility: 'members_only',
          requiresRsvp: true,
        });
        synced++;
      }
    }

    res.json({ 
      success: true, 
      message: `Synced ${synced} new events, updated ${updated} existing events`,
      total: eventbriteEvents.length,
      synced,
      updated
    });
  } catch (error: any) {
    if (!isProduction) console.error('Eventbrite sync error:', error);
    res.status(500).json({ error: 'Failed to sync Eventbrite events' });
  }
});

router.get('/api/rsvps', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { user_email: rawEmail } = req.query;
    const user_email = rawEmail ? decodeURIComponent(rawEmail as string) : null;
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    
    if (user_email && user_email.toLowerCase() !== sessionEmail) {
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
            if (!isProduction) console.warn('[events] Staff check query failed:', e);
          }
        }
        if (!isStaff) {
          return res.status(403).json({ error: 'You can only view your own RSVPs' });
        }
      }
    }
    
    const { include_past } = req.query;
    
    const conditions = [
      eq(eventRsvps.status, 'confirmed'),
    ];
    
    if (include_past !== 'true') {
      conditions.push(gte(events.eventDate, getTodayPacific()));
    }
    
    if (user_email) {
      // Look up the user's ID to also match by matchedUserId (for Eventbrite RSVPs with different emails)
      const userLookup = await db.select({ id: users.id })
        .from(users)
        .where(sql`LOWER(${users.email}) = LOWER(${user_email})`)
        .limit(1);
      
      if (userLookup.length > 0) {
        // Match by either email OR matched user ID
        conditions.push(
          or(
            eq(eventRsvps.userEmail, user_email),
            eq(eventRsvps.matchedUserId, userLookup[0].id)
          )!
        );
      } else {
        // No user found, just match by email
        conditions.push(eq(eventRsvps.userEmail, user_email));
      }
    }
    
    const result = await db.select({
      id: eventRsvps.id,
      event_id: eventRsvps.eventId,
      user_email: eventRsvps.userEmail,
      status: eventRsvps.status,
      created_at: eventRsvps.createdAt,
      order_date: eventRsvps.orderDate,
      title: events.title,
      event_date: events.eventDate,
      start_time: events.startTime,
      end_time: events.endTime,
      location: events.location,
      category: events.category,
      image_url: events.imageUrl,
    })
    .from(eventRsvps)
    .innerJoin(events, eq(eventRsvps.eventId, events.id))
    .where(and(...conditions))
    .orderBy(events.eventDate, events.startTime);
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/api/rsvps', async (req, res) => {
  try {
    const { event_id, user_email } = req.body;
    
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate,
      startTime: events.startTime,
      location: events.location
    }).from(events).where(eq(events.id, event_id));
    
    if (eventData.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const evt = eventData[0];
    const formattedDate = formatDateDisplayWithDay(evt.eventDate);
    const formattedTime = evt.startTime?.substring(0, 5) || '';
    const memberMessage = `You're confirmed for ${evt.title} on ${formattedDate}${formattedTime ? ` at ${formattedTime}` : ''}${evt.location ? ` - ${evt.location}` : ''}.`;
    const memberName = user_email.split('@')[0];
    const staffMessage = `${memberName} RSVP'd for ${evt.title} on ${formattedDate}`;
    
    const result = await db.transaction(async (tx) => {
      const rsvpResult = await tx.insert(eventRsvps).values({
        eventId: event_id,
        userEmail: user_email,
        checkedIn: true,
      }).onConflictDoUpdate({
        target: [eventRsvps.eventId, eventRsvps.userEmail],
        set: { status: 'confirmed', checkedIn: true },
      }).returning();
      
      await tx.insert(notifications).values({
        userEmail: user_email,
        title: 'Event RSVP Confirmed',
        message: memberMessage,
        type: 'event_rsvp',
        relatedId: event_id,
        relatedType: 'event'
      });
      
      await notifyAllStaff(
        'New Event RSVP',
        staffMessage,
        'event_rsvp',
        { relatedId: event_id, relatedType: 'event', url: '/#/staff/calendar' }
      );
      
      return rsvpResult[0];
    });
    
    sendPushNotification(user_email, {
      title: 'RSVP Confirmed!',
      body: memberMessage,
      url: '/#/member-events'
    }).catch(err => console.error('Push notification failed:', err));
    
    // Send real-time WebSocket notification to member
    sendNotificationToUser(user_email, {
      type: 'notification',
      title: 'Event RSVP Confirmed',
      message: memberMessage,
      data: { eventId: event_id, eventType: 'rsvp_created' }
    }, { action: 'rsvp_created', eventId: event_id, triggerSource: 'events.ts' });
    
    // Broadcast to staff for real-time updates
    broadcastToStaff({
      type: 'rsvp_event',
      action: 'rsvp_created',
      eventId: event_id,
      memberEmail: user_email
    });
    
    res.status(201).json(result);
  } catch (error: any) {
    if (!isProduction) console.error('RSVP creation error:', error);
    res.status(500).json({ error: 'Failed to create RSVP. Staff notification is required.' });
  }
});

router.delete('/api/rsvps/:event_id/:user_email', async (req, res) => {
  try {
    const { event_id, user_email } = req.params;
    
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate,
    }).from(events).where(eq(events.id, parseInt(event_id)));
    
    if (eventData.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const evt = eventData[0];
    const formattedDate = formatDateDisplayWithDay(evt.eventDate);
    const memberName = user_email.split('@')[0];
    const staffMessage = `${memberName} cancelled their RSVP for ${evt.title} on ${formattedDate}`;
    
    await db.transaction(async (tx) => {
      await tx.update(eventRsvps)
        .set({ status: 'cancelled' })
        .where(and(
          eq(eventRsvps.eventId, parseInt(event_id)),
          eq(eventRsvps.userEmail, user_email)
        ));
      
      await notifyAllStaff(
        'Event RSVP Cancelled',
        staffMessage,
        'event_rsvp_cancelled',
        { relatedId: parseInt(event_id), relatedType: 'event', url: '/#/staff/calendar' }
      );
      
      await notifyMember({
        userEmail: user_email,
        title: 'RSVP Cancelled',
        message: `Your RSVP for "${evt.title}" on ${formattedDate} has been cancelled`,
        type: 'event',
        relatedId: parseInt(event_id),
        relatedType: 'event',
        url: '/#/events'
      });
    });
    
    // Broadcast to staff for real-time updates
    broadcastToStaff({
      type: 'rsvp_event',
      action: 'rsvp_cancelled',
      eventId: parseInt(event_id),
      memberEmail: user_email
    });
    
    logFromRequest(req, 'cancel_event_rsvp', 'event', event_id, {
      member_email: user_email,
      event_title: evt.title,
      event_date: evt.eventDate
    }, 'member', user_email);
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('RSVP cancellation error:', error);
    res.status(500).json({ error: 'Failed to cancel RSVP. Staff notification is required.' });
  }
});

router.get('/api/events/:id/rsvps', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.select({
      id: eventRsvps.id,
      userEmail: eventRsvps.userEmail,
      status: eventRsvps.status,
      source: eventRsvps.source,
      attendeeName: eventRsvps.attendeeName,
      ticketClass: eventRsvps.ticketClass,
      checkedIn: eventRsvps.checkedIn,
      matchedUserId: eventRsvps.matchedUserId,
      guestCount: eventRsvps.guestCount,
      orderDate: eventRsvps.orderDate,
      createdAt: eventRsvps.createdAt,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
    })
    .from(eventRsvps)
    .leftJoin(users, or(
      eq(eventRsvps.userEmail, users.email),
      eq(eventRsvps.matchedUserId, users.id)
    ))
    .where(and(
      eq(eventRsvps.eventId, parseInt(id)),
      eq(eventRsvps.status, 'confirmed')
    ))
    .orderBy(desc(eventRsvps.createdAt));
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to fetch RSVPs' });
  }
});

router.delete('/api/events/:eventId/rsvps/:rsvpId', isStaffOrAdmin, async (req, res) => {
  try {
    const { eventId, rsvpId } = req.params;
    
    const existingRsvp = await db.select()
      .from(eventRsvps)
      .where(and(
        eq(eventRsvps.id, parseInt(rsvpId)),
        eq(eventRsvps.eventId, parseInt(eventId))
      ))
      .limit(1);
    
    if (existingRsvp.length === 0) {
      return res.status(404).json({ error: 'RSVP not found' });
    }
    
    const rsvp = existingRsvp[0];
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate
    }).from(events).where(eq(events.id, parseInt(eventId)));
    
    await db.delete(eventRsvps)
      .where(eq(eventRsvps.id, parseInt(rsvpId)));
    
    const event = eventData[0] || { title: 'Unknown', eventDate: '' };
    logFromRequest(req, 'remove_rsvp', 'event', eventId, event.title, {
      rsvp_email: rsvp.userEmail,
      attendee_name: rsvp.attendeeName,
      event_date: event.eventDate
    });
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('RSVP deletion error:', error);
    res.status(500).json({ error: 'Failed to delete RSVP' });
  }
});

router.post('/api/events/:id/rsvps/manual', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const existingRsvp = await db.select()
      .from(eventRsvps)
      .where(and(
        eq(eventRsvps.eventId, parseInt(id)),
        eq(eventRsvps.userEmail, email),
        eq(eventRsvps.status, 'confirmed')
      ))
      .limit(1);
    
    if (existingRsvp.length > 0) {
      return res.status(400).json({ error: 'This email is already registered for this event' });
    }

    await db.insert(eventRsvps).values({
      eventId: parseInt(id),
      userEmail: email,
      status: 'confirmed',
      checkedIn: true,
    });
    
    const eventData = await db.select({
      title: events.title,
      eventDate: events.eventDate
    }).from(events).where(eq(events.id, parseInt(id)));
    
    const event = eventData[0] || { title: 'Unknown', eventDate: '' };
    logFromRequest(req, 'manual_rsvp', 'event', id, event.title, {
      attendee_email: email,
      event_date: event.eventDate
    });
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Manual RSVP error:', error);
    res.status(500).json({ error: 'Failed to add RSVP' });
  }
});

// Sync Eventbrite attendees for an event
router.post('/api/events/:id/sync-eventbrite-attendees', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the event to find its eventbrite_id
    const eventResult = await db.select({
      id: events.id,
      title: events.title,
      eventbriteId: events.eventbriteId,
    })
    .from(events)
    .where(eq(events.id, parseInt(id)))
    .limit(1);
    
    if (eventResult.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = eventResult[0];
    
    if (!event.eventbriteId) {
      return res.status(400).json({ error: 'This event is not from Eventbrite' });
    }
    
    const eventbriteToken = process.env.EVENTBRITE_PRIVATE_TOKEN;
    if (!eventbriteToken) {
      return res.status(400).json({ error: 'Eventbrite not configured' });
    }
    
    // Fetch attendees from Eventbrite API
    const attendeesResponse = await fetch(
      `https://www.eventbriteapi.com/v3/events/${event.eventbriteId}/attendees/`,
      { headers: { 'Authorization': `Bearer ${eventbriteToken}` } }
    );
    
    if (!attendeesResponse.ok) {
      const errorText = await attendeesResponse.text();
      if (!isProduction) console.error('Eventbrite attendees fetch error:', errorText);
      return res.status(400).json({ error: 'Failed to fetch attendees from Eventbrite' });
    }
    
    const attendeesData = await attendeesResponse.json() as { 
      attendees?: Array<{
        id: string;
        profile?: { email?: string; name?: string; first_name?: string; last_name?: string };
        ticket_class_name?: string;
        checked_in?: boolean;
        status?: string;
        created?: string; // ISO date string when the order was placed
      }> 
    };
    const attendees = attendeesData.attendees || [];
    
    // Get all members for email matching
    const allMembers = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      linkedEmails: users.linkedEmails,
      manuallyLinkedEmails: users.manuallyLinkedEmails,
    }).from(users);
    
    // Create email lookup map (including linked emails)
    const emailToMember = new Map<string, typeof allMembers[0]>();
    // Create name lookup map for fallback matching
    const nameToMember = new Map<string, typeof allMembers[0]>();
    
    for (const member of allMembers) {
      if (member.email) {
        emailToMember.set(member.email.toLowerCase(), member);
      }
      // Also add linked emails
      const linkedEmails = (member.linkedEmails as string[] | null) || [];
      const manualEmails = (member.manuallyLinkedEmails as string[] | null) || [];
      for (const linkedEmail of [...linkedEmails, ...manualEmails]) {
        if (linkedEmail) {
          emailToMember.set(linkedEmail.toLowerCase(), member);
        }
      }
      // Add to name lookup map (normalized: lowercase, trimmed)
      if (member.firstName && member.lastName) {
        const fullName = `${member.firstName} ${member.lastName}`.toLowerCase().trim();
        // Only add if not already in map (first match wins, avoids overwriting)
        if (!nameToMember.has(fullName)) {
          nameToMember.set(fullName, member);
        }
      }
    }
    
    let synced = 0;
    let matched = 0;
    let skipped = 0;
    
    // First pass: Group attendees by email to calculate correct guest counts
    const emailGroups = new Map<string, typeof attendees>();
    
    for (const attendee of attendees) {
      const email = attendee.profile?.email?.toLowerCase();
      if (!email) {
        skipped++;
        continue;
      }
      
      if (!emailGroups.has(email)) {
        emailGroups.set(email, []);
      }
      emailGroups.get(email)!.push(attendee);
    }
    
    // Second pass: Process each unique email with its full attendee list
    for (const [email, groupAttendees] of emailGroups) {
      // Filter to only attending attendees for count and status
      const attendingAttendees = groupAttendees.filter(a => a.status === 'Attending');
      const attendingCount = attendingAttendees.length;
      
      // If no one is attending, cancel any existing RSVP for this email
      if (attendingCount === 0) {
        const existingToCancel = await db.select()
          .from(eventRsvps)
          .where(and(
            eq(eventRsvps.eventId, parseInt(id)),
            eq(eventRsvps.userEmail, email)
          ))
          .limit(1);
        
        if (existingToCancel.length > 0) {
          await db.update(eventRsvps)
            .set({
              status: 'cancelled',
              guestCount: 0,
            })
            .where(eq(eventRsvps.id, existingToCancel[0].id));
        }
        skipped += groupAttendees.length;
        continue;
      }
      
      // Use the first attending attendee as primary
      const primaryAttendee = attendingAttendees[0];
      const guestCount = attendingCount - 1; // Additional attending tickets beyond the primary
      
      const attendeeName = primaryAttendee.profile?.name || 
        `${primaryAttendee.profile?.first_name || ''} ${primaryAttendee.profile?.last_name || ''}`.trim() ||
        email.split('@')[0];
      
      let matchedMember = emailToMember.get(email);
      if (!matchedMember && attendeeName) {
        const normalizedName = attendeeName.toLowerCase().trim();
        matchedMember = nameToMember.get(normalizedName);
      }
      
      // Check if ANY of these attendee IDs already exist
      const existingByAnyAttendeeId = await db.select()
        .from(eventRsvps)
        .where(and(
          eq(eventRsvps.eventId, parseInt(id)),
          eq(eventRsvps.userEmail, email)
        ))
        .limit(1);
      
      if (existingByAnyAttendeeId.length > 0) {
        // Update existing RSVP with current guest count (idempotent)
        await db.update(eventRsvps)
          .set({
            checkedIn: primaryAttendee.checked_in || false,
            status: primaryAttendee.status === 'Attending' ? 'confirmed' : 'cancelled',
            source: 'eventbrite',
            attendeeName,
            ticketClass: primaryAttendee.ticket_class_name || null,
            matchedUserId: matchedMember?.id || existingByAnyAttendeeId[0].matchedUserId || null,
            eventbriteAttendeeId: primaryAttendee.id,
            guestCount: guestCount, // Set to correct count, not increment
            orderDate: primaryAttendee.created ? new Date(primaryAttendee.created) : null,
          })
          .where(eq(eventRsvps.id, existingByAnyAttendeeId[0].id));
        
        if (matchedMember && !existingByAnyAttendeeId[0].matchedUserId) {
          matched++;
        }
        synced += attendingCount;
        continue;
      }
      
      // Insert new RSVP with correct guest count
      await db.insert(eventRsvps).values({
        eventId: parseInt(id),
        userEmail: email,
        status: 'confirmed', // We only insert for attending attendees
        source: 'eventbrite',
        eventbriteAttendeeId: primaryAttendee.id,
        matchedUserId: matchedMember?.id || null,
        attendeeName,
        ticketClass: primaryAttendee.ticket_class_name || null,
        checkedIn: primaryAttendee.checked_in || false,
        guestCount: guestCount,
        orderDate: primaryAttendee.created ? new Date(primaryAttendee.created) : null,
      });
      
      synced += attendingCount;
      if (matchedMember) {
        matched++;
      }
    }
    
    // Get total matched members count (not just newly matched)
    const totalMatchedResult = await db.select({ count: sql<number>`count(*)` })
      .from(eventRsvps)
      .where(and(
        eq(eventRsvps.eventId, parseInt(id)),
        isNotNull(eventRsvps.matchedUserId)
      ));
    const totalMatched = Number(totalMatchedResult[0]?.count || 0);
    
    res.json({ 
      success: true, 
      synced,
      matched: totalMatched, // Return total matched, not just newly matched
      newlyMatched: matched, // Keep track of newly matched for debugging
      skipped,
      total: attendees.length,
      message: `Synced ${synced} attendees, ${totalMatched} matched to members`
    });
  } catch (error: any) {
    if (!isProduction) console.error('Eventbrite attendees sync error:', error);
    res.status(500).json({ error: 'Failed to sync Eventbrite attendees' });
  }
});

// Get Eventbrite attendees for an event (with member matching info)
router.get('/api/events/:id/eventbrite-attendees', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get RSVPs with source=eventbrite and join with member info
    const result = await db.select({
      id: eventRsvps.id,
      userEmail: eventRsvps.userEmail,
      status: eventRsvps.status,
      source: eventRsvps.source,
      attendeeName: eventRsvps.attendeeName,
      ticketClass: eventRsvps.ticketClass,
      checkedIn: eventRsvps.checkedIn,
      matchedUserId: eventRsvps.matchedUserId,
      createdAt: eventRsvps.createdAt,
      memberFirstName: users.firstName,
      memberLastName: users.lastName,
    })
    .from(eventRsvps)
    .leftJoin(users, eq(eventRsvps.matchedUserId, users.id))
    .where(and(
      eq(eventRsvps.eventId, parseInt(id)),
      eq(eventRsvps.source, 'eventbrite')
    ))
    .orderBy(desc(eventRsvps.createdAt));
    
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('Eventbrite attendees fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch Eventbrite attendees' });
  }
});

export default router;
