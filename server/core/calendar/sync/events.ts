import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { getGoogleCalendarClient } from '../../integrations';
import { events } from '../../../../shared/models/auth';
import { and, isNotNull, eq } from 'drizzle-orm';
import { CALENDAR_CONFIG } from '../config';
import { getCalendarIdByName } from '../cache';
import { alertOnSyncFailure } from '../../dataAlerts';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getPacificMidnightUTC } from '../../../utils/dateUtils';
import { getAllActiveBayIds, getConferenceRoomId } from '../../affectedAreas';
import { availabilityBlocks } from '../../../../shared/models/scheduling';
import { findCoveringBlock } from '../../availabilityBlockService';

import { toIntArrayLiteral } from '../../../utils/sqlArrayLiteral';
import { logger } from '../../logger';
import { withCalendarRetry } from '../../retryUtils';
import { ensureDateString, ensureTimeString } from '../../../utils/dateTimeUtils';

async function resyncEventAvailabilityBlocks(
  eventId: number,
  eventDate: string,
  startTime: string,
  endTime: string,
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  eventTitle?: string
): Promise<void> {
  try {
    await db.delete(availabilityBlocks).where(eq(availabilityBlocks.eventId, eventId));

    if (!blockSimulators && !blockConferenceRoom) return;

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
    const effectiveEndTime = endTime || startTime;
    for (const resourceId of resourceIds) {
      try {
        const covering = await findCoveringBlock(resourceId, eventDate, startTime, effectiveEndTime);
        if (covering && covering.event_id !== eventId) {
          logger.info(`[Events Sync] Skipping block insert for event #${eventId} resource ${resourceId} — covered by existing block #${covering.id} (type: ${covering.block_type})`, {
            extra: { resourceId, eventDate, startTime, endTime: effectiveEndTime, eventId }
          });
          continue;
        }
        await db.insert(availabilityBlocks).values({
          resourceId,
          blockDate: eventDate,
          startTime,
          endTime: effectiveEndTime,
          blockType: 'event',
          notes: blockNotes,
          createdBy: 'calendar_sync',
          eventId,
        }).onConflictDoUpdate({
          target: [availabilityBlocks.resourceId, availabilityBlocks.blockDate, availabilityBlocks.startTime, availabilityBlocks.endTime, availabilityBlocks.eventId],
          targetWhere: sql`${availabilityBlocks.eventId} IS NOT NULL`,
          set: {
            blockType: 'event',
            notes: blockNotes,
            createdBy: 'calendar_sync',
          },
        });
      } catch (insertErr: unknown) {
        logger.warn(`[Events Sync] Insert failed for event #${eventId} resource ${resourceId}: ${getErrorMessage(insertErr)}`);
      }
    }
  } catch (err: unknown) {
    logger.error(`[Events Sync] Failed to resync availability blocks for event #${eventId}: ${getErrorMessage(err)}`);
  }
}
export async function syncGoogleCalendarEvents(options?: { suppressAlert?: boolean }): Promise<{ synced: number; created: number; updated: number; deleted: number; pushedToCalendar: number; error?: string }> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: `Calendar "${CALENDAR_CONFIG.events.name}" not found` };
    }
    
    const oneYearAgo = getPacificMidnightUTC();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calendarEvents: any[] = [];
    let pageToken: string | undefined;
    do {
      const response = await withCalendarRetry(() => calendar.events.list({
        calendarId,
        timeMin: oneYearAgo.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: true,
        pageToken,
      }), 'events-list');
      if (response.data.items) calendarEvents.push(...response.data.items);
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    const fetchedEventIds = new Set<string>();
    const cancelledEventIds = new Set<string>();
    let created = 0;
    let updated = 0;
    let pushedToCalendar = 0;
    
    for (const event of calendarEvents) {
      if (!event.id) continue;
      
      if (event.status === 'cancelled' || !event.summary) {
        cancelledEventIds.add(event.id);
        continue;
      }
      
      const googleEventId = event.id;
      const googleEtag = event.etag || null;
      const googleUpdatedAt = event.updated ? new Date(event.updated) : null;
      fetchedEventIds.add(googleEventId);
      const rawTitle = event.summary;
      const description = event.description || null;
      
      const bracketMatch = rawTitle.match(/^\[([^\]]+)\]\s*/);
      const extractedCategoryFromTitle = bracketMatch ? bracketMatch[1] : null;
      const title = bracketMatch ? rawTitle.replace(/^\[([^\]]+)\]\s*/, '') : rawTitle;
      
      const extProps = event.extendedProperties?.shared || event.extendedProperties?.private || {};
      const appMetadata = {
        imageUrl: extProps['ehApp_imageUrl'] || null,
        externalUrl: extProps['ehApp_externalUrl'] || null,
        category: extProps['ehApp_category'] || null,
        maxAttendees: extProps['ehApp_maxAttendees'] ? parseInt(extProps['ehApp_maxAttendees'], 10) : null,
        visibility: extProps['ehApp_visibility'] || null,
        requiresRsvp: extProps['ehApp_requiresRsvp'] === 'true',
        location: extProps['ehApp_location'] || null,
      };
      
      const extractedCategory = appMetadata.category || extractedCategoryFromTitle;
      
      let eventDate: string;
      let startTime: string;
      let endTime: string | null = null;
      
      if (event.start?.dateTime) {
        const startDt = new Date(event.start.dateTime);
        eventDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        startTime = startDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
        
        if (event.end?.dateTime) {
          const endDt = new Date(event.end.dateTime);
          endTime = endDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
        }
      } else if (event.start?.date) {
        eventDate = event.start.date;
        startTime = '00:00:00';
        endTime = '23:59:00';
      } else {
        continue;
      }
      
      const DEFAULT_LOCATION = '15771 Red Hill Ave, Ste 500, Tustin, CA 92780';
      const location = event.location || appMetadata.location || DEFAULT_LOCATION;
      
      const isAppCreated = !!(extProps['ehApp_type'] || extProps['ehApp_id']);
      const hasBracketPrefix = /^\[.+\]/.test(rawTitle);
      const hasSufficientMetadata = !!(location || appMetadata.imageUrl || appMetadata.externalUrl || description);
      const needsReview = isAppCreated ? false : (!hasBracketPrefix || !hasSufficientMetadata);
      
      const enrichedDescription = description;
      
      const existing = await db.execute(sql`SELECT id, locally_edited, app_last_modified_at, google_event_updated_at,
                title, description, event_date, start_time, end_time, location, category,
                image_url, external_url, max_attendees, visibility, requires_rsvp,
                reviewed_at, last_synced_at, review_dismissed, needs_review,
                block_simulators, block_conference_room
         FROM events WHERE google_calendar_id = ${googleEventId}`);
      
      interface EventDbRow {
        id: number;
        locally_edited: boolean;
        app_last_modified_at: string | null;
        google_event_updated_at: string | null;
        title: string;
        description: string | null;
        event_date: Date | string;
        start_time: string;
        end_time: string | null;
        location: string | null;
        category: string | null;
        image_url: string | null;
        external_url: string | null;
        max_attendees: number | null;
        visibility: string | null;
        requires_rsvp: boolean | null;
        reviewed_at: string | null;
        last_synced_at: string | null;
        review_dismissed: boolean;
        block_simulators: boolean;
        block_conference_room: boolean;
        needs_review: boolean;
      }

      if (existing.rows.length > 0) {
        const dbRow = existing.rows[0] as unknown as EventDbRow;
        const appModifiedAt = dbRow.app_last_modified_at instanceof Date ? dbRow.app_last_modified_at : (dbRow.app_last_modified_at ? new Date(dbRow.app_last_modified_at) : null);
        
        if (dbRow.locally_edited === true && appModifiedAt) {
          const calendarIsNewer = googleUpdatedAt && googleUpdatedAt > appModifiedAt;
          
          if (calendarIsNewer) {
            await db.execute(sql`UPDATE events SET title = ${title}, description = ${enrichedDescription}, event_date = ${eventDate}, start_time = ${startTime}, 
               end_time = ${endTime}, location = ${location}, source = 'google_calendar',
               category = COALESCE(${extractedCategory ?? null}, category),
               image_url = COALESCE(${appMetadata.imageUrl ?? null}, image_url),
               external_url = COALESCE(${appMetadata.externalUrl ?? null}, external_url),
               max_attendees = COALESCE(${appMetadata.maxAttendees ?? null}, max_attendees),
               visibility = COALESCE(${appMetadata.visibility ?? null}, visibility),
               requires_rsvp = COALESCE(${appMetadata.requiresRsvp ?? null}, requires_rsvp),
               google_event_etag = ${googleEtag}, google_event_updated_at = ${googleUpdatedAt}, last_synced_at = NOW(),
               locally_edited = false, app_last_modified_at = NULL
               WHERE google_calendar_id = ${googleEventId}`);
            if (dbRow.block_simulators || dbRow.block_conference_room) {
              await resyncEventAvailabilityBlocks(dbRow.id, eventDate, startTime, endTime || startTime, dbRow.block_simulators, dbRow.block_conference_room, title);
            }
            updated++;
          } else {
            try {
              const extendedProps: Record<string, string> = {
                'ehApp_type': 'event',
                'ehApp_id': String(dbRow.id),
              };
              if (dbRow.image_url) extendedProps['ehApp_imageUrl'] = dbRow.image_url as string;
              if (dbRow.external_url) extendedProps['ehApp_externalUrl'] = dbRow.external_url as string;
              if (dbRow.max_attendees) extendedProps['ehApp_maxAttendees'] = String(dbRow.max_attendees);
              if (dbRow.visibility) extendedProps['ehApp_visibility'] = dbRow.visibility as string;
              if (dbRow.requires_rsvp !== null) extendedProps['ehApp_requiresRsvp'] = String(dbRow.requires_rsvp);
              if (dbRow.location) extendedProps['ehApp_location'] = dbRow.location as string;
              if (dbRow.category) extendedProps['ehApp_category'] = dbRow.category as string;
              
              const calendarTitle = dbRow.title as string;
              
              const formattedDate = ensureDateString(dbRow.event_date);
              
              let endDate = formattedDate;
              if (dbRow.end_time && dbRow.start_time) {
                const startParts = String(dbRow.start_time).split(':').map(Number);
                const endParts = String(dbRow.end_time).split(':').map(Number);
                const startMinutes = startParts[0] * 60 + (startParts[1] || 0);
                const endMinutes = endParts[0] * 60 + (endParts[1] || 0);
                if (endMinutes < startMinutes) {
                  const nextDay = new Date(dbRow.event_date as string);
                  nextDay.setDate(nextDay.getDate() + 1);
                  endDate = nextDay.toISOString().split('T')[0];
                }
              }
              
              const eventOptionalKeys = ['ehApp_imageUrl', 'ehApp_externalUrl', 'ehApp_maxAttendees', 'ehApp_visibility', 'ehApp_requiresRsvp', 'ehApp_location', 'ehApp_category'];
              const mergedEventProps: Record<string, string | null> = { ...extProps, ...extendedProps };
              for (const key of eventOptionalKeys) {
                if (!extendedProps[key] && extProps[key]) mergedEventProps[key] = null;
              }

              const patchResult = await withCalendarRetry(() => calendar.events.patch({
                calendarId,
                eventId: googleEventId,
                requestBody: {
                  summary: calendarTitle,
                  description: dbRow.description as string,
                  location: dbRow.location as string,
                  start: {
                    dateTime: `${formattedDate}T${dbRow.start_time}`,
                    timeZone: 'America/Los_Angeles',
                  },
                  end: dbRow.end_time ? {
                    dateTime: `${endDate}T${dbRow.end_time}`,
                    timeZone: 'America/Los_Angeles',
                  } : undefined,
                  extendedProperties: {
                    shared: mergedEventProps,
                  },
                },
              }), `events-patch-event-${dbRow.id}`);
              
              const newEtag = patchResult.data.etag || null;
              const newUpdatedAt = patchResult.data.updated ? new Date(patchResult.data.updated) : null;
              
              const clearResult = await db.execute(sql`UPDATE events SET last_synced_at = NOW(), locally_edited = false, 
                 google_event_etag = ${newEtag}, google_event_updated_at = ${newUpdatedAt}, app_last_modified_at = NULL 
                 WHERE id = ${dbRow.id} AND (date_trunc('milliseconds', app_last_modified_at) IS NOT DISTINCT FROM ${appModifiedAt})`);
              if ((clearResult as { rowCount?: number }).rowCount === 0) {
                logger.warn(`[Events Sync] Event #${dbRow.id} was re-edited during push-back; keeping locally_edited=true for next sync`);
              } else {
                pushedToCalendar++;
              }
            } catch (pushError: unknown) {
              logger.error(`[Events Sync] Failed to push local edits to calendar for event #${dbRow.id}:`, { error: pushError });
            }
          }
        } else {
          const reviewDismissed = dbRow.review_dismissed === true;
          const shouldSetNeedsReview = reviewDismissed ? false : needsReview;
          
          const dbEventDate = ensureDateString(dbRow.event_date);
          const dbStartTime = ensureTimeString(dbRow.start_time, 8);
          const dbEndTime = dbRow.end_time ? ensureTimeString(dbRow.end_time, 8) : null;
          const normalizedStartTime = ensureTimeString(startTime, 8);
          const normalizedEndTime = endTime ? ensureTimeString(endTime, 8) : null;
          
          const wasReviewed = dbRow.needs_review === false && dbRow.reviewed_at !== null;
          const hasChanges = (
            dbRow.title !== title ||
            dbEventDate !== eventDate ||
            dbStartTime !== normalizedStartTime ||
            dbEndTime !== normalizedEndTime ||
            ((dbRow.description as string) || null) !== (description || null) ||
            ((dbRow.location as string) || null) !== (location || null)
          );
          const isConflict = wasReviewed && hasChanges && !reviewDismissed;
          
          await db.execute(sql`UPDATE events SET title = ${title}, description = ${enrichedDescription}, event_date = ${eventDate}, start_time = ${startTime}, 
             end_time = ${endTime}, location = ${location}, source = 'google_calendar',
             category = COALESCE(${extractedCategory ?? null}, category),
             image_url = COALESCE(${appMetadata.imageUrl ?? null}, image_url),
             external_url = COALESCE(${appMetadata.externalUrl ?? null}, external_url),
             max_attendees = COALESCE(${appMetadata.maxAttendees ?? null}, max_attendees),
             visibility = COALESCE(${appMetadata.visibility ?? null}, visibility),
             requires_rsvp = COALESCE(${appMetadata.requiresRsvp ?? null}, requires_rsvp),
             google_event_etag = ${googleEtag}, google_event_updated_at = ${googleUpdatedAt}, last_synced_at = NOW(),
             needs_review = CASE WHEN ${reviewDismissed} THEN needs_review ELSE CASE WHEN ${isConflict} THEN true ELSE ${shouldSetNeedsReview} END END,
             conflict_detected = CASE WHEN ${isConflict} THEN true ELSE conflict_detected END
             WHERE google_calendar_id = ${googleEventId}`);
          if (dbRow.block_simulators || dbRow.block_conference_room) {
            await resyncEventAvailabilityBlocks(dbRow.id, eventDate, startTime, endTime || startTime, dbRow.block_simulators, dbRow.block_conference_room, title);
          }
          updated++;
        }
      } else {
        await db.execute(sql`INSERT INTO events (title, description, event_date, start_time, end_time, location, category, 
           source, visibility, requires_rsvp, google_calendar_id, image_url, external_url, max_attendees,
           google_event_etag, google_event_updated_at, last_synced_at, needs_review)
           VALUES (${title}, ${enrichedDescription}, ${eventDate}, ${startTime}, ${endTime}, ${location}, ${extractedCategory || 'Social'}, ${'google_calendar'}, 
            ${appMetadata.visibility || 'public'}, ${appMetadata.requiresRsvp || false}, ${googleEventId},
            ${appMetadata.imageUrl ?? null}, ${appMetadata.externalUrl ?? null}, ${appMetadata.maxAttendees ?? null},
            ${googleEtag}, ${googleUpdatedAt}, NOW(), ${needsReview})`);
        created++;
      }
    }
    
    const existingEvents = await db.select({
      id: events.id,
      googleCalendarId: events.googleCalendarId,
    }).from(events).where(
      and(
        isNotNull(events.googleCalendarId),
        eq(events.source, 'google_calendar')
      )
    );
    
    const idsToDelete = existingEvents
      .filter(dbEvent => cancelledEventIds.has(dbEvent.googleCalendarId!) || !fetchedEventIds.has(dbEvent.googleCalendarId!))
      .map(dbEvent => dbEvent.id);
    let deleted = 0;
    if (idsToDelete.length > 0) {
      const idsToDeleteLiteral = toIntArrayLiteral(idsToDelete);
      await db.execute(sql`DELETE FROM availability_blocks WHERE event_id = ANY(${idsToDeleteLiteral}::int[])`);
      await db.execute(sql`DELETE FROM events WHERE id = ANY(${idsToDeleteLiteral}::int[])`);
      deleted = idsToDelete.length;
    }
    
    return { synced: calendarEvents.length, created, updated, deleted, pushedToCalendar };
  } catch (error: unknown) {
    logger.error('Error syncing Google Calendar events:', { error: error });
    
    if (!options?.suppressAlert) {
      alertOnSyncFailure(
        'calendar',
        'Events calendar sync',
        error instanceof Error ? error : new Error(getErrorMessage(error)),
        { calendarName: CALENDAR_CONFIG.events.name }
      ).catch((alertErr: unknown) => {
        logger.error('[Events Sync] Failed to send staff alert:', { error: alertErr });
      });
    }
    
    return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Failed to sync events' };
  }
}
