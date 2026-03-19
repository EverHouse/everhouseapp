import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { events, eventRsvps, availabilityBlocks } from '../../../shared/schema';
import { eq, and, sql, gte } from 'drizzle-orm';
import { getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent, updateCalendarEvent, CALENDAR_CONFIG } from '../../core/calendar/index';
import { createPacificDate, getTodayPacific, getPacificDateParts } from '../../utils/dateUtils';
import { getSessionUser } from '../../types/session';
import { logFromRequest } from '../../core/auditLog';
import { getErrorMessage, safeErrorDetail } from '../../utils/errorUtils';
import { logger } from '../../core/logger';
import { createEventAvailabilityBlocks, removeEventAvailabilityBlocks, updateEventAvailabilityBlocks } from './shared';

const router = Router();

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
      .orderBy(events.eventDate, events.startTime)
      .limit(100);
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch events needing review' });
  }
});

router.post('/api/events/:id/mark-reviewed', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    const sessionUser = getSessionUser(req);
    const reviewedBy = sessionUser?.email || 'unknown';
    
    const result = await db.update(events).set({
      needsReview: false,
      reviewedBy,
      reviewedAt: new Date(),
      reviewDismissed: true,
      conflictDetected: false,
    }).where(eq(events.id, eventId)).returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json({ success: true, event: result[0] });
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to mark event as reviewed' });
  }
});

// PUBLIC ROUTE - events listing for public calendar
router.get('/api/events', async (req, res) => {
  try {
    const { date, include_past, visibility, include_archived } = req.query;
    const conditions: ReturnType<typeof sql>[] = [];
    const todayPacific = getTodayPacific();
    
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
      result = await query.where(and(...conditions)).orderBy(events.eventDate, events.startTime).limit(200);
    } else {
      result = await query.orderBy(events.eventDate, events.startTime).limit(200);
    }
    
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
    
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
    res.json(result);
  } catch (error: unknown) {
    logger.error('API error', { error: error instanceof Error ? error : new Error(String(error)) });
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
    
    const eventDescription = description || '';
    
    const createExtProps: Record<string, string> = {
      'ehApp_type': 'event',
    };
    if (category) createExtProps['ehApp_category'] = category;
    if (image_url) createExtProps['ehApp_imageUrl'] = image_url;
    if (external_url) createExtProps['ehApp_externalUrl'] = external_url;
    if (max_attendees) createExtProps['ehApp_maxAttendees'] = String(max_attendees);
    if (visibility) createExtProps['ehApp_visibility'] = visibility;
    if (requires_rsvp !== undefined && requires_rsvp !== null) createExtProps['ehApp_requiresRsvp'] = String(requires_rsvp);
    if (location) createExtProps['ehApp_location'] = location;
    
    let googleCalendarId: string | null = null;
    try {
      googleCalendarId = await createCalendarEventOnCalendar(
        calendarId,
        trimmedTitle,
        eventDescription,
        trimmedEventDate,
        trimmedStartTime,
        trimmedEndTime || trimmedStartTime,
        createExtProps
      );
    } catch (calError: unknown) {
      logger.error('Failed to create Google Calendar event', { error: calError instanceof Error ? calError : new Error(getErrorMessage(calError)) });
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    if (!googleCalendarId) {
      return res.status(500).json({ error: 'Failed to create calendar event. Please try again.' });
    }
    
    const newBlockSimulators = block_simulators === true || block_simulators === 'true';
    const newBlockConferenceRoom = block_conference_room === true || block_conference_room === 'true';
    const userEmail = getSessionUser(req)?.email || 'system';
    
    const createdEvent = await db.transaction(async (tx) => {
      const result = await tx.insert(events).values({
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
      
      const event = result[0];
      
      if (newBlockSimulators || newBlockConferenceRoom) {
        await createEventAvailabilityBlocks(event.id, trimmedEventDate, trimmedStartTime, trimmedEndTime || trimmedStartTime, newBlockSimulators, newBlockConferenceRoom, userEmail, event.title, tx);
      }
      
      return event;
    });
    
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
  } catch (error: unknown) {
    logger.error('Event creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create event' });
  }
});

router.put('/api/events/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
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
    
    const eventId = parseInt(id as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    
    const existing = await db.select({ 
      googleCalendarId: events.googleCalendarId,
      blockBookings: events.blockBookings,
      blockSimulators: events.blockSimulators,
      blockConferenceRoom: events.blockConferenceRoom,
      needsReview: events.needsReview
    }).from(events).where(eq(events.id, eventId));
    
    const _previousBlockBookings = existing[0]?.blockBookings || false;
    const previousBlockSimulators = existing[0]?.blockSimulators || false;
    const previousBlockConferenceRoom = existing[0]?.blockConferenceRoom || false;
    const newBlockBookings = block_bookings === true || block_bookings === 'true';
    const newBlockSimulators = block_simulators === true || block_simulators === 'true';
    const newBlockConferenceRoom = block_conference_room === true || block_conference_room === 'true';
    
    const hasValidCategory = category && category.trim() !== '' && category !== 'General';
    const hasDescription = description && description.trim() !== '';
    const hasLocation = location && location.trim() !== '';
    const shouldClearReview = existing[0]?.needsReview && hasValidCategory && hasDescription && hasLocation;
    
    const updateData: Record<string, unknown> = {
      title: trimmedTitle,
      description,
      eventDate: trimmedEventDate,
      startTime: trimmedStartTime,
      endTime: trimmedEndTime,
      location,
      category,
      imageUrl: image_url,
      maxAttendees: max_attendees,
      visibility: visibility || 'public',
      requiresRsvp: requires_rsvp || false,
      externalUrl: external_url || null,
      blockBookings: newBlockBookings,
      blockSimulators: newBlockSimulators,
      blockConferenceRoom: newBlockConferenceRoom,
      locallyEdited: true,
      appLastModifiedAt: new Date(),
    };
    
    if (shouldClearReview) {
      updateData.needsReview = false;
      updateData.reviewedAt = new Date();
      updateData.reviewedBy = getSessionUser(req)?.email || 'system';
      updateData.reviewDismissed = true;
      updateData.conflictDetected = false;
    }
    
    updateData.conflictDetected = false;
    
    const result = await db.update(events).set(updateData).where(eq(events.id, eventId)).returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    if (existing.length > 0 && existing[0].googleCalendarId) {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
        if (calendarId) {
          const calendarTitle = trimmedTitle;
          const eventDescription = description || '';
          const extendedProps: Record<string, string> = {
            'ehApp_type': 'event',
            'ehApp_id': id as string,
          };
          if (image_url) extendedProps['ehApp_imageUrl'] = image_url;
          if (external_url) extendedProps['ehApp_externalUrl'] = external_url;
          if (category) extendedProps['ehApp_category'] = category;
          if (max_attendees) extendedProps['ehApp_maxAttendees'] = String(max_attendees);
          if (visibility) extendedProps['ehApp_visibility'] = visibility;
          if (requires_rsvp !== undefined && requires_rsvp !== null) extendedProps['ehApp_requiresRsvp'] = String(requires_rsvp);
          if (location) extendedProps['ehApp_location'] = location;
          const calResult = await updateCalendarEvent(
            existing[0].googleCalendarId,
            calendarId,
            calendarTitle,
            eventDescription,
            trimmedEventDate,
            trimmedStartTime,
            trimmedEndTime || trimmedStartTime,
            extendedProps
          );
          if (calResult.success) {
            await db.update(events).set({
              googleEventEtag: calResult.etag,
              googleEventUpdatedAt: calResult.updatedAt,
              locallyEdited: false,
              appLastModifiedAt: null,
              lastSyncedAt: new Date(),
            }).where(eq(events.id, eventId));
          }
        }
      } catch (calError: unknown) {
        logger.error('Failed to update Google Calendar event', { error: calError instanceof Error ? calError : new Error(getErrorMessage(calError)) });
      }
    }
    
    const userEmail = getSessionUser(req)?.email || 'system';
    
    const hadAnyBlocking = previousBlockSimulators || previousBlockConferenceRoom;
    const hasAnyBlocking = newBlockSimulators || newBlockConferenceRoom;
    
    const updatedEvent = result[0];
    
    if (hadAnyBlocking && !hasAnyBlocking) {
      await removeEventAvailabilityBlocks(eventId);
    } else if (!hadAnyBlocking && hasAnyBlocking) {
      try {
        await createEventAvailabilityBlocks(eventId, trimmedEventDate, trimmedStartTime, trimmedEndTime || trimmedStartTime, newBlockSimulators, newBlockConferenceRoom, userEmail, updatedEvent.title);
      } catch (blockErr: unknown) {
        const cause = blockErr instanceof Error && blockErr.cause instanceof Error ? blockErr.cause : blockErr;
        logger.error(`[Events] Failed to create availability blocks for event #${eventId}`, { 
          error: cause instanceof Error ? cause : new Error(String(cause)),
          extra: { eventId, blockSimulators: newBlockSimulators, blockConferenceRoom: newBlockConferenceRoom }
        });
      }
    } else if (hasAnyBlocking) {
      try {
        await updateEventAvailabilityBlocks(eventId, trimmedEventDate, trimmedStartTime, trimmedEndTime || trimmedStartTime, newBlockSimulators, newBlockConferenceRoom, userEmail, updatedEvent.title);
      } catch (blockErr: unknown) {
        const cause = blockErr instanceof Error && blockErr.cause instanceof Error ? blockErr.cause : blockErr;
        logger.error(`[Events] Failed to update availability blocks for event #${eventId}`, { 
          error: cause instanceof Error ? cause : new Error(String(cause)),
          extra: { eventId, blockSimulators: newBlockSimulators, blockConferenceRoom: newBlockConferenceRoom }
        });
      }
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
  } catch (error: unknown) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    logger.error('Event update error', { error: cause instanceof Error ? cause : new Error(String(cause)) });
    res.status(500).json({ error: 'Failed to update event' });
  }
});

router.get('/api/events/:id/cascade-preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    
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
  } catch (error: unknown) {
    logger.error('Event cascade preview error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch cascade preview' });
  }
});

router.delete('/api/events/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
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
          logger.error(`[Events] Calendar "${CALENDAR_CONFIG.events.name}" not found for event deletion`);
        }
      } catch (calError: unknown) {
        logger.error('Failed to delete Google Calendar event', { error: calError instanceof Error ? calError : new Error(getErrorMessage(calError)) });
      }
    }
    
    try {
      await removeEventAvailabilityBlocks(eventId);
    } catch (blockError: unknown) {
      logger.error('Failed to remove availability blocks for event', { error: blockError instanceof Error ? blockError : new Error(getErrorMessage(blockError)) });
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
  } catch (error: unknown) {
    logger.error('Event archive error', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
    res.status(500).json({ error: 'Failed to archive event', details: safeErrorDetail(error) });
  }
});

export default router;
