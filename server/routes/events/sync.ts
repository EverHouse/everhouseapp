import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { events, eventRsvps, users, availabilityBlocks } from '../../../shared/schema';
import { eq, and, sql, desc, isNotNull } from 'drizzle-orm';
import { syncGoogleCalendarEvents, syncWellnessCalendarEvents, backfillWellnessToCalendar } from '../../core/calendar/index';
import { getAllActiveBayIds, getConferenceRoomId } from '../../core/affectedAreas';
import { getSessionUser } from '../../types/session';
import { logFromRequest, type AuditAction } from '../../core/auditLog';
import { logger } from '../../core/logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { createEventAvailabilityBlocks } from './shared';

const router = Router();

router.post('/api/events/sync/google', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await syncGoogleCalendarEvents();
    if (result.error) {
      return res.status(502).json(result);
    }
    res.json({
      success: true,
      message: `Synced ${result.synced} events from Google Calendar`,
      ...result
    });
  } catch (error: unknown) {
    logger.error('Google Calendar sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync Google Calendar events' });
  }
});

router.post('/api/events/sync', isStaffOrAdmin, async (req, res) => {
  try {
    const googleResult = await syncGoogleCalendarEvents();
    
    let eventbriteResult = { synced: 0, created: 0, updated: 0, error: 'No Eventbrite token configured' };
    const eventbriteToken = process.env.EVENTBRITE_PRIVATE_TOKEN;
    if (eventbriteToken) {
      eventbriteResult = { synced: 0, created: 0, updated: 0, error: undefined as unknown as string };
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
  } catch (error: unknown) {
    logger.error('Event sync error', { error: error instanceof Error ? error : new Error(String(error)) });
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
  } catch (error: unknown) {
    logger.error('Calendar sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync calendars' });
  }
});

router.post('/api/eventbrite/sync', isStaffOrAdmin, async (req, res) => {
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
      logger.error('Eventbrite org fetch error', { extra: { errorText } });
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
      logger.error('Eventbrite events fetch error', { extra: { errorText } });
      return res.status(400).json({ error: 'Failed to fetch Eventbrite events' });
    }

    interface EventbriteEvent {
      id: string;
      name?: { text?: string };
      description?: { text?: string };
      start?: { local?: string };
      end?: { local?: string };
      venue?: { name?: string };
      online_event?: boolean;
      logo?: { url?: string };
      url?: string;
      capacity?: number;
    }

    const eventsData = await eventsResponse.json() as { events?: EventbriteEvent[] };
    const eventbriteEvents = eventsData.events || [];

    let synced = 0;
    let updated = 0;

    for (const ebEvent of eventbriteEvents) {
      const eventbriteId = ebEvent.id;
      const title = ebEvent.name?.text || 'Untitled Event';
      const description = ebEvent.description?.text || '';
      const eventDate = ebEvent.start?.local?.split('T')[0] || '';
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
  } catch (error: unknown) {
    logger.error('Eventbrite sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync Eventbrite events' });
  }
});

router.post('/api/events/:id/sync-eventbrite-attendees', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    
    const eventResult = await db.select({
      id: events.id,
      title: events.title,
      eventbriteId: events.eventbriteId,
    })
    .from(events)
    .where(eq(events.id, eventId))
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
    
    const attendeesResponse = await fetch(
      `https://www.eventbriteapi.com/v3/events/${event.eventbriteId}/attendees/`,
      { headers: { 'Authorization': `Bearer ${eventbriteToken}` } }
    );
    
    if (!attendeesResponse.ok) {
      const errorText = await attendeesResponse.text();
      logger.error('Eventbrite attendees fetch error', { extra: { errorText } });
      return res.status(400).json({ error: 'Failed to fetch attendees from Eventbrite' });
    }
    
    const attendeesData = await attendeesResponse.json() as { 
      attendees?: Array<{
        id: string;
        profile?: { email?: string; name?: string; first_name?: string; last_name?: string };
        ticket_class_name?: string;
        checked_in?: boolean;
        status?: string;
        created?: string;
      }> 
    };
    const attendees = attendeesData.attendees || [];
    
    const allMembers = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      linkedEmails: users.linkedEmails,
      manuallyLinkedEmails: users.manuallyLinkedEmails,
    }).from(users);
    
    const emailToMember = new Map<string, typeof allMembers[0]>();
    for (const member of allMembers) {
      if (member.email) {
        emailToMember.set(member.email.toLowerCase(), member);
      }
      const linkedEmails = (member.linkedEmails as string[] | null) || [];
      const manualEmails = (member.manuallyLinkedEmails as string[] | null) || [];
      for (const linkedEmail of [...linkedEmails, ...manualEmails]) {
        if (linkedEmail) {
          emailToMember.set(linkedEmail.toLowerCase(), member);
        }
      }
    }
    
    let synced = 0;
    let matched = 0;
    let skipped = 0;
    
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
    
    for (const [email, groupAttendees] of emailGroups) {
      const attendingAttendees = groupAttendees.filter(a => a.status === 'Attending');
      const attendingCount = attendingAttendees.length;
      
      if (attendingCount === 0) {
        const existingToCancel = await db.select()
          .from(eventRsvps)
          .where(and(
            eq(eventRsvps.eventId, eventId),
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
      
      const primaryAttendee = attendingAttendees[0];
      const guestCount = attendingCount - 1;
      
      const attendeeName = primaryAttendee.profile?.name || 
        `${primaryAttendee.profile?.first_name || ''} ${primaryAttendee.profile?.last_name || ''}`.trim() ||
        email.split('@')[0];
      
      const matchedMember = emailToMember.get(email);
      
      const existingByAnyAttendeeId = await db.select()
        .from(eventRsvps)
        .where(and(
          eq(eventRsvps.eventId, eventId),
          eq(eventRsvps.userEmail, email)
        ))
        .limit(1);
      
      if (existingByAnyAttendeeId.length > 0) {
        await db.update(eventRsvps)
          .set({
            checkedIn: primaryAttendee.checked_in || false,
            status: primaryAttendee.status === 'Attending' ? 'confirmed' : 'cancelled',
            source: 'eventbrite',
            attendeeName,
            ticketClass: primaryAttendee.ticket_class_name || null,
            matchedUserId: matchedMember?.id || existingByAnyAttendeeId[0].matchedUserId || null,
            eventbriteAttendeeId: primaryAttendee.id,
            guestCount: guestCount,
            orderDate: primaryAttendee.created ? new Date(primaryAttendee.created) : null,
          })
          .where(eq(eventRsvps.id, existingByAnyAttendeeId[0].id));
        
        if (matchedMember && !existingByAnyAttendeeId[0].matchedUserId) {
          matched++;
        }
        synced += attendingCount;
        continue;
      }
      
      await db.insert(eventRsvps).values({
        eventId: eventId,
        userEmail: email,
        status: 'confirmed',
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
    
    const totalMatchedResult = await db.select({ count: sql<number>`count(*)` })
      .from(eventRsvps)
      .where(and(
        eq(eventRsvps.eventId, eventId),
        isNotNull(eventRsvps.matchedUserId)
      ));
    const totalMatched = Number(totalMatchedResult[0]?.count || 0);
    
    res.json({ 
      success: true, 
      synced,
      matched: totalMatched,
      newlyMatched: matched,
      skipped,
      total: attendees.length,
      message: `Synced ${synced} attendees, ${totalMatched} matched to members`
    });
  } catch (error: unknown) {
    logger.error('Eventbrite attendees sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync Eventbrite attendees' });
  }
});

router.get('/api/events/:id/eventbrite-attendees', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const eventId = parseInt(id as string, 10);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    
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
      eq(eventRsvps.eventId, eventId),
      eq(eventRsvps.source, 'eventbrite')
    ))
    .orderBy(desc(eventRsvps.createdAt));
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('Eventbrite attendees fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch Eventbrite attendees' });
  }
});

router.post('/api/admin/backfill-availability-blocks', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'system';
    let eventBlocksCreated = 0;
    let wellnessBlocksCreated = 0;

    const eventsWithToggles = await db.execute(sql`
      SELECT e.id, e.title, e.event_date, e.start_time, e.end_time, e.block_simulators, e.block_conference_room
      FROM events e
      WHERE (e.block_simulators = true OR e.block_conference_room = true)
        AND e.archived_at IS NULL
        AND e.event_date >= CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM availability_blocks ab WHERE ab.event_id = e.id
        )
    `);

    interface EventRow { id: number; title: string; event_date: string; start_time: string; end_time: string; block_simulators: boolean; block_conference_room: boolean; }
    for (const row of eventsWithToggles.rows as unknown as EventRow[]) {
      try {
        const eventDate = typeof row.event_date === 'string' ? row.event_date.split('T')[0] : String(row.event_date).split('T')[0];
        await createEventAvailabilityBlocks(row.id, eventDate, row.start_time, row.end_time || row.start_time, row.block_simulators, row.block_conference_room, staffEmail, row.title);
        eventBlocksCreated++;
      } catch (err: unknown) {
        logger.error(`[Backfill] Failed to create blocks for event #${row.id}`, { error: getErrorMessage(err) });
      }
    }

    const wellnessWithToggles = await db.execute(sql`
      SELECT wc.id, wc.title, wc.date, wc.time, wc.duration, wc.block_simulators, wc.block_conference_room
      FROM wellness_classes wc
      WHERE (wc.block_simulators = true OR wc.block_conference_room = true)
        AND wc.is_active = true
        AND wc.date >= CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM availability_blocks ab WHERE ab.wellness_class_id = wc.id
        )
    `);

    interface WellnessRow { id: number; title: string; date: string; time: string; duration: string; block_simulators: boolean; block_conference_room: boolean; }
    for (const row of wellnessWithToggles.rows as unknown as WellnessRow[]) {
      try {
        const classDate = typeof row.date === 'string' ? row.date.split('T')[0] : String(row.date).split('T')[0];
        const durationMatch = row.duration?.match(/(\d+)/);
        const durMins = durationMatch ? parseInt(durationMatch[1], 10) : 60;
        const timeParts = row.time.split(':').map(Number);
        const totalMins = (timeParts[0] || 0) * 60 + (timeParts[1] || 0) + durMins;
        const endTime = `${String(Math.floor(totalMins / 60) % 24).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}:00`;
        const startTime24 = `${String(timeParts[0] || 0).padStart(2, '0')}:${String(timeParts[1] || 0).padStart(2, '0')}:00`;

        const resourceIds: number[] = [];
        if (row.block_simulators) {
          const bayIds = await getAllActiveBayIds();
          resourceIds.push(...bayIds);
        }
        if (row.block_conference_room) {
          const conferenceRoomId = await getConferenceRoomId();
          if (conferenceRoomId && !resourceIds.includes(conferenceRoomId)) {
            resourceIds.push(conferenceRoomId);
          }
        }

        for (const resourceId of resourceIds) {
          await db.insert(availabilityBlocks).values({
            resourceId,
            blockDate: classDate,
            startTime: startTime24,
            endTime,
            blockType: 'wellness',
            notes: `Blocked for: ${row.title}`,
            createdBy: staffEmail,
            wellnessClassId: row.id,
          }).onConflictDoUpdate({
            target: [availabilityBlocks.resourceId, availabilityBlocks.blockDate, availabilityBlocks.startTime, availabilityBlocks.endTime, availabilityBlocks.wellnessClassId],
            targetWhere: sql`${availabilityBlocks.wellnessClassId} IS NOT NULL`,
            set: {
              blockType: 'wellness',
              notes: `Blocked for: ${row.title}`,
              createdBy: staffEmail,
            },
          });
        }
        wellnessBlocksCreated++;
      } catch (err: unknown) {
        logger.error(`[Backfill] Failed to create blocks for wellness class #${row.id}`, { error: getErrorMessage(err) });
      }
    }

    logFromRequest(req, 'backfill_blocks' as AuditAction, 'system', 'availability_blocks', staffEmail, {
      eventsFound: eventsWithToggles.rows.length,
      eventBlocksCreated,
      wellnessFound: wellnessWithToggles.rows.length,
      wellnessBlocksCreated,
    });

    res.json({
      success: true,
      eventsFound: eventsWithToggles.rows.length,
      eventBlocksCreated,
      wellnessFound: wellnessWithToggles.rows.length,
      wellnessBlocksCreated,
    });
  } catch (error: unknown) {
    logger.error('[Backfill] Failed to backfill availability blocks', { error });
    res.status(500).json({ error: 'Failed to backfill availability blocks' });
  }
});

export default router;
