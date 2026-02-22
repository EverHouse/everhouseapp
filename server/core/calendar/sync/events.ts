import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { getGoogleCalendarClient } from '../../integrations';
import { events } from '../../../../shared/models/auth';
import { and, isNotNull, eq } from 'drizzle-orm';
import { CALENDAR_CONFIG } from '../config';
import { getCalendarIdByName } from '../cache';
import { alertOnSyncFailure } from '../../dataAlerts';
import { getPacificMidnightUTC } from '../../../utils/dateUtils';

import { logger } from '../../logger';
export async function syncGoogleCalendarEvents(options?: { suppressAlert?: boolean }): Promise<{ synced: number; created: number; updated: number; deleted: number; pushedToCalendar: number; error?: string }> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: `Calendar "${CALENDAR_CONFIG.events.name}" not found` };
    }
    
    const oneYearAgo = getPacificMidnightUTC();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    const response = await calendar.events.list({
      calendarId,
      timeMin: oneYearAgo.toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: true,
    });
    
    const calendarEvents = response.data.items || [];
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
      const extractedCategory = bracketMatch ? bracketMatch[1] : null;
      const title = bracketMatch ? rawTitle.replace(/^\[([^\]]+)\]\s*/, '') : rawTitle;
      
      const extProps = event.extendedProperties?.private || {};
      const appMetadata = {
        imageUrl: extProps['ehApp_imageUrl'] || null,
        externalUrl: extProps['ehApp_externalUrl'] || null,
        maxAttendees: extProps['ehApp_maxAttendees'] ? parseInt(extProps['ehApp_maxAttendees']) : null,
        visibility: extProps['ehApp_visibility'] || null,
        requiresRsvp: extProps['ehApp_requiresRsvp'] === 'true',
        location: extProps['ehApp_location'] || null,
      };
      
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
      
      const enrichedDescription = extractedCategory && description && !description.startsWith(`[${extractedCategory}]`)
        ? `[${extractedCategory}] ${description}`
        : extractedCategory && !description
        ? `[${extractedCategory}]`
        : description;
      
      const existing = await db.execute(sql`SELECT id, locally_edited, app_last_modified_at, google_event_updated_at,
                title, description, event_date, start_time, end_time, location, category,
                image_url, external_url, max_attendees, visibility, requires_rsvp,
                reviewed_at, last_synced_at, review_dismissed, needs_review
         FROM events WHERE google_calendar_id = ${googleEventId}`);
      
      if (existing.rows.length > 0) {
        const dbRow = existing.rows[0] as Record<string, unknown>;
        const appModifiedAt = dbRow.app_last_modified_at ? new Date(dbRow.app_last_modified_at as string) : null;
        
        if (dbRow.locally_edited === true && appModifiedAt) {
          const calendarIsNewer = googleUpdatedAt && googleUpdatedAt > appModifiedAt;
          
          if (calendarIsNewer) {
            await db.execute(sql`UPDATE events SET title = ${title}, description = ${enrichedDescription}, event_date = ${eventDate}, start_time = ${startTime}, 
               end_time = ${endTime}, location = ${location}, source = 'google_calendar',
               category = COALESCE(${extractedCategory}, category),
               image_url = COALESCE(${appMetadata.imageUrl}, image_url),
               external_url = COALESCE(${appMetadata.externalUrl}, external_url),
               max_attendees = COALESCE(${appMetadata.maxAttendees}, max_attendees),
               visibility = COALESCE(${appMetadata.visibility}, visibility),
               requires_rsvp = COALESCE(${appMetadata.requiresRsvp}, requires_rsvp),
               google_event_etag = ${googleEtag}, google_event_updated_at = ${googleUpdatedAt}, last_synced_at = NOW(),
               locally_edited = false, app_last_modified_at = NULL
               WHERE google_calendar_id = ${googleEventId}`);
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
              
              const calendarTitle = dbRow.category ? `[${dbRow.category}] ${dbRow.title}` : dbRow.title as string;
              
              const formattedDate = new Date(dbRow.event_date as string).toISOString().split('T')[0];
              
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
              
              const patchResult = await calendar.events.patch({
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
                    private: extendedProps,
                  },
                },
              });
              
              const newEtag = patchResult.data.etag || null;
              const newUpdatedAt = patchResult.data.updated ? new Date(patchResult.data.updated) : null;
              
              await db.execute(sql`UPDATE events SET last_synced_at = NOW(), locally_edited = false, 
                 google_event_etag = ${newEtag}, google_event_updated_at = ${newUpdatedAt}, app_last_modified_at = NULL 
                 WHERE id = ${dbRow.id}`);
              pushedToCalendar++;
            } catch (pushError: unknown) {
              logger.error(`[Events Sync] Failed to push local edits to calendar for event #${dbRow.id}:`, { error: pushError });
            }
          }
        } else {
          const reviewDismissed = dbRow.review_dismissed === true;
          const shouldSetNeedsReview = reviewDismissed ? false : needsReview;
          
          const dbEventDate = dbRow.event_date instanceof Date 
            ? dbRow.event_date.toISOString().split('T')[0] 
            : String(dbRow.event_date || '').split('T')[0];
          const dbStartTime = String(dbRow.start_time || '').substring(0, 8);
          const dbEndTime = dbRow.end_time ? String(dbRow.end_time).substring(0, 8) : null;
          const normalizedStartTime = startTime.substring(0, 8);
          const normalizedEndTime = endTime ? endTime.substring(0, 8) : null;
          
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
             category = COALESCE(${extractedCategory}, category),
             image_url = COALESCE(${appMetadata.imageUrl}, image_url),
             external_url = COALESCE(${appMetadata.externalUrl}, external_url),
             max_attendees = COALESCE(${appMetadata.maxAttendees}, max_attendees),
             visibility = COALESCE(${appMetadata.visibility}, visibility),
             requires_rsvp = COALESCE(${appMetadata.requiresRsvp}, requires_rsvp),
             google_event_etag = ${googleEtag}, google_event_updated_at = ${googleUpdatedAt}, last_synced_at = NOW(),
             needs_review = CASE WHEN ${reviewDismissed} THEN needs_review ELSE CASE WHEN ${isConflict} THEN true ELSE ${shouldSetNeedsReview} END END,
             conflict_detected = CASE WHEN ${isConflict} THEN true ELSE conflict_detected END
             WHERE google_calendar_id = ${googleEventId}`);
          updated++;
        }
      } else {
        await db.execute(sql`INSERT INTO events (title, description, event_date, start_time, end_time, location, category, 
           source, visibility, requires_rsvp, google_calendar_id, image_url, external_url, max_attendees,
           google_event_etag, google_event_updated_at, last_synced_at, needs_review)
           VALUES (${title}, ${enrichedDescription}, ${eventDate}, ${startTime}, ${endTime}, ${location}, ${extractedCategory || 'Social'}, ${'google_calendar'}, 
            ${appMetadata.visibility || 'public'}, ${appMetadata.requiresRsvp || false}, ${googleEventId},
            ${appMetadata.imageUrl}, ${appMetadata.externalUrl}, ${appMetadata.maxAttendees},
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
      await db.execute(sql`DELETE FROM events WHERE id = ANY(${idsToDelete})`);
      deleted = idsToDelete.length;
    }
    
    return { synced: calendarEvents.length, created, updated, deleted, pushedToCalendar };
  } catch (error: unknown) {
    logger.error('Error syncing Google Calendar events:', { error: error });
    
    if (!options?.suppressAlert) {
      alertOnSyncFailure(
        'calendar',
        'Events calendar sync',
        error instanceof Error ? error : new Error(String(error)),
        { calendarName: CALENDAR_CONFIG.events.name }
      ).catch((alertErr: unknown) => {
        logger.error('[Events Sync] Failed to send staff alert:', { error: alertErr });
      });
    }
    
    return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Failed to sync events' };
  }
}
