import { pool } from '../../db';
import { getGoogleCalendarClient } from '../../integrations';
import { db } from '../../../db';
import { events } from '../../../../shared/models/auth';
import { and, isNotNull, eq } from 'drizzle-orm';
import { CALENDAR_CONFIG } from '../config';
import { getCalendarIdByName } from '../cache';

export async function syncGoogleCalendarEvents(): Promise<{ synced: number; created: number; updated: number; deleted: number; pushedToCalendar: number; error?: string }> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: `Calendar "${CALENDAR_CONFIG.events.name}" not found` };
    }
    
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    
    const response = await calendar.events.list({
      calendarId,
      timeMin: oneYearAgo.toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const calendarEvents = response.data.items || [];
    const fetchedEventIds = new Set<string>();
    let created = 0;
    let updated = 0;
    let pushedToCalendar = 0;
    
    for (const event of calendarEvents) {
      if (!event.id || !event.summary) continue;
      
      const googleEventId = event.id;
      const googleEtag = event.etag || null;
      const googleUpdatedAt = event.updated ? new Date(event.updated) : null;
      fetchedEventIds.add(googleEventId);
      const title = event.summary;
      const description = event.description || null;
      
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
      
      const location = event.location || appMetadata.location || null;
      
      const existing = await pool.query(
        `SELECT id, locally_edited, app_last_modified_at, google_event_updated_at,
                title, description, event_date, start_time, end_time, location, category,
                image_url, external_url, max_attendees, visibility, requires_rsvp
         FROM events WHERE google_calendar_id = $1`,
        [googleEventId]
      );
      
      if (existing.rows.length > 0) {
        const dbRow = existing.rows[0];
        const appModifiedAt = dbRow.app_last_modified_at ? new Date(dbRow.app_last_modified_at) : null;
        
        if (dbRow.locally_edited === true && appModifiedAt) {
          const calendarIsNewer = googleUpdatedAt && googleUpdatedAt > appModifiedAt;
          
          if (calendarIsNewer) {
            await pool.query(
              `UPDATE events SET title = $1, description = $2, event_date = $3, start_time = $4, 
               end_time = $5, location = $6, source = 'google_calendar',
               image_url = COALESCE($7, image_url),
               external_url = COALESCE($8, external_url),
               max_attendees = COALESCE($9, max_attendees),
               visibility = COALESCE($10, visibility),
               requires_rsvp = COALESCE($11, requires_rsvp),
               google_event_etag = $12, google_event_updated_at = $13, last_synced_at = NOW(),
               locally_edited = false, app_last_modified_at = NULL
               WHERE google_calendar_id = $14`,
              [title, description, eventDate, startTime, endTime, location,
               appMetadata.imageUrl, appMetadata.externalUrl, appMetadata.maxAttendees,
               appMetadata.visibility, appMetadata.requiresRsvp,
               googleEtag, googleUpdatedAt, googleEventId]
            );
            updated++;
          } else {
            try {
              const extendedProps: Record<string, string> = {
                'ehApp_type': 'event',
                'ehApp_id': String(dbRow.id),
              };
              if (dbRow.image_url) extendedProps['ehApp_imageUrl'] = dbRow.image_url;
              if (dbRow.external_url) extendedProps['ehApp_externalUrl'] = dbRow.external_url;
              if (dbRow.max_attendees) extendedProps['ehApp_maxAttendees'] = String(dbRow.max_attendees);
              if (dbRow.visibility) extendedProps['ehApp_visibility'] = dbRow.visibility;
              if (dbRow.requires_rsvp !== null) extendedProps['ehApp_requiresRsvp'] = String(dbRow.requires_rsvp);
              if (dbRow.location) extendedProps['ehApp_location'] = dbRow.location;
              
              const patchResult = await calendar.events.patch({
                calendarId,
                eventId: googleEventId,
                requestBody: {
                  summary: dbRow.title,
                  description: dbRow.description,
                  location: dbRow.location,
                  start: {
                    dateTime: `${dbRow.event_date}T${dbRow.start_time}`,
                    timeZone: 'America/Los_Angeles',
                  },
                  end: dbRow.end_time ? {
                    dateTime: `${dbRow.event_date}T${dbRow.end_time}`,
                    timeZone: 'America/Los_Angeles',
                  } : undefined,
                  extendedProperties: {
                    private: extendedProps,
                  },
                },
              });
              
              const newEtag = patchResult.data.etag || null;
              const newUpdatedAt = patchResult.data.updated ? new Date(patchResult.data.updated) : null;
              
              await pool.query(
                `UPDATE events SET last_synced_at = NOW(), locally_edited = false, 
                 google_event_etag = $2, google_event_updated_at = $3, app_last_modified_at = NULL 
                 WHERE id = $1`,
                [dbRow.id, newEtag, newUpdatedAt]
              );
              pushedToCalendar++;
            } catch (pushError) {
              console.error(`[Events Sync] Failed to push local edits to calendar for event #${dbRow.id}:`, pushError);
            }
          }
        } else {
          await pool.query(
            `UPDATE events SET title = $1, description = $2, event_date = $3, start_time = $4, 
             end_time = $5, location = $6, source = 'google_calendar',
             image_url = COALESCE($7, image_url),
             external_url = COALESCE($8, external_url),
             max_attendees = COALESCE($9, max_attendees),
             visibility = COALESCE($10, visibility),
             requires_rsvp = COALESCE($11, requires_rsvp),
             google_event_etag = $12, google_event_updated_at = $13, last_synced_at = NOW()
             WHERE google_calendar_id = $14`,
            [title, description, eventDate, startTime, endTime, location,
             appMetadata.imageUrl, appMetadata.externalUrl, appMetadata.maxAttendees,
             appMetadata.visibility, appMetadata.requiresRsvp,
             googleEtag, googleUpdatedAt, googleEventId]
          );
          updated++;
        }
      } else {
        await pool.query(
          `INSERT INTO events (title, description, event_date, start_time, end_time, location, category, 
           source, visibility, requires_rsvp, google_calendar_id, image_url, external_url, max_attendees,
           google_event_etag, google_event_updated_at, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())`,
          [title, description, eventDate, startTime, endTime, location, 'Social', 'google_calendar', 
           appMetadata.visibility || 'public', appMetadata.requiresRsvp || false, googleEventId,
           appMetadata.imageUrl, appMetadata.externalUrl, appMetadata.maxAttendees,
           googleEtag, googleUpdatedAt]
        );
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
    
    let deleted = 0;
    for (const dbEvent of existingEvents) {
      if (!fetchedEventIds.has(dbEvent.googleCalendarId!)) {
        await db.delete(events).where(eq(events.id, dbEvent.id));
        deleted++;
      }
    }
    
    return { synced: calendarEvents.length, created, updated, deleted, pushedToCalendar };
  } catch (error) {
    console.error('Error syncing Google Calendar events:', error);
    return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Failed to sync events' };
  }
}
