import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getGoogleCalendarClient } from '../../integrations';
import { wellnessClasses } from '../../../../shared/models/auth';
import { isNull, gte, asc, and } from 'drizzle-orm';
import { getTodayPacific, getPacificMidnightUTC } from '../../../utils/dateUtils';
import { CALENDAR_CONFIG } from '../config';
import { getCalendarIdByName, discoverCalendarIds } from '../cache';
import { createCalendarEventOnCalendar } from '../google-client';
import { alertOnSyncFailure } from '../../dataAlerts';

import { logger } from '../../logger';
export async function syncWellnessCalendarEvents(options?: { suppressAlert?: boolean }): Promise<{ synced: number; created: number; updated: number; deleted: number; pushedToCalendar: number; error?: string }> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: `Calendar "${CALENDAR_CONFIG.wellness.name}" not found` };
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
    
    const events = response.data.items || [];
    const fetchedEventIds = new Set<string>();
    const cancelledEventIds = new Set<string>();
    let created = 0;
    let updated = 0;
    let pushedToCalendar = 0;
    
    for (const event of events) {
      if (!event.id) continue;
      
      if (event.status === 'cancelled' || !event.summary) {
        cancelledEventIds.add(event.id);
        continue;
      }
      
      const googleEventId = event.id;
      const googleEtag = event.etag || null;
      const googleUpdatedAt = event.updated ? new Date(event.updated) : null;
      const recurringEventId = event.recurringEventId || null;
      fetchedEventIds.add(googleEventId);
      const rawTitle = event.summary;
      const description = event.description || null;
      
      const extProps = event.extendedProperties?.private || {};
      const appMetadata = {
        imageUrl: extProps['ehApp_imageUrl'] || null,
        externalUrl: extProps['ehApp_externalUrl'] || null,
        spots: extProps['ehApp_spots'] || null,
        status: extProps['ehApp_status'] || null,
      };
      
      let eventDate: string;
      let startTime: string;
      let durationMinutes = 60;
      
      if (event.start?.dateTime) {
        const startDt = new Date(event.start.dateTime);
        eventDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        startTime = startDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
        
        if (event.end?.dateTime) {
          const endDt = new Date(event.end.dateTime);
          durationMinutes = Math.round((endDt.getTime() - startDt.getTime()) / 60000);
        }
      } else if (event.start?.date) {
        eventDate = event.start.date;
        startTime = '09:00';
      } else {
        continue;
      }
      
      let title = rawTitle;
      let instructor = 'TBD';
      let category = 'Wellness';
      
      if (rawTitle.includes(' - ')) {
        const parts = rawTitle.split(' - ');
        category = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }
      
      if (rawTitle.toLowerCase().includes(' with ')) {
        const withMatch = rawTitle.match(/with\s+(.+?)(?:\s*[-|]|$)/i);
        if (withMatch) {
          instructor = withMatch[1].trim();
          title = title.replace(/\s+with\s+.+$/i, '').trim();
        }
      }
      
      if (description) {
        const instructorMatch = description.match(/instructor[:\s]+([^\n,]+)/i);
        if (instructorMatch) instructor = instructorMatch[1].trim();
        
        const categoryMatch = description.match(/category[:\s]+([^\n,]+)/i);
        if (categoryMatch) category = categoryMatch[1].trim();
      }
      
      const duration = `${durationMinutes} min`;
      const spots = appMetadata.spots || '10 spots';
      const status = appMetadata.status || 'Open';
      
      const isAppCreated = !!(extProps['ehApp_type'] || extProps['ehApp_id']);
      let needsReview = false;
      if (!isAppCreated) {
        if (!rawTitle.includes(' - ') && !rawTitle.toLowerCase().includes(' with ')) {
          needsReview = true;
        }
        if (instructor === 'TBD') {
          needsReview = true;
        }
        if (category === 'Wellness') {
          needsReview = true;
        }
      }
      
      const existing = await db.execute(sql`SELECT id, locally_edited, app_last_modified_at, google_event_updated_at, 
                image_url, external_url, spots, status, title, time, instructor, duration, category, date,
                reviewed_at, last_synced_at, review_dismissed, needs_review
         FROM wellness_classes WHERE google_calendar_id = ${googleEventId}`);
      
      if (existing.rows.length > 0) {
        const dbRow = existing.rows[0] as Record<string, unknown>;
        const appModifiedAt = dbRow.app_last_modified_at ? new Date(dbRow.app_last_modified_at as string) : null;
        
        if (dbRow.locally_edited === true && appModifiedAt) {
          const calendarIsNewer = googleUpdatedAt && googleUpdatedAt > appModifiedAt;
          
          if (calendarIsNewer) {
            await db.execute(sql`UPDATE wellness_classes SET 
                title = ${title}, time = ${startTime}, instructor = ${instructor}, duration = ${duration}, 
                category = ${category}, spots = ${spots}, status = ${status}, description = ${description}, 
                date = ${eventDate}, is_active = true, updated_at = NOW(),
                image_url = COALESCE(${appMetadata.imageUrl}, image_url),
                external_url = COALESCE(${appMetadata.externalUrl}, external_url),
                google_event_etag = ${googleEtag}, google_event_updated_at = ${googleUpdatedAt}, last_synced_at = NOW(),
                locally_edited = false, app_last_modified_at = NULL, needs_review = ${needsReview},
                recurring_event_id = COALESCE(${recurringEventId}, recurring_event_id)
               WHERE google_calendar_id = ${googleEventId}`);
            updated++;
          } else {
            try {
              const calendarTitle = `${dbRow.title} with ${dbRow.instructor}`;
              const calendarDescription = [`Category: ${dbRow.category}`, (dbRow.description as string) || '', `Duration: ${dbRow.duration}`, `Spots: ${dbRow.spots}`].filter(Boolean).join('\n');
              
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
                  return `${match24h[1].padStart(2, '0')}:${match24h[2]}:${match24h[3] || '00'}`;
                }
                return '09:00:00';
              };
              
              const calculateEndTime = (startTime24: string, durationStr: string): string => {
                const durationMatch = durationStr.match(/(\d+)/);
                const durationMins = durationMatch ? parseInt(durationMatch[1]) : 60;
                const [hours, minutes] = startTime24.split(':').map(Number);
                const totalMinutes = hours * 60 + minutes + durationMins;
                const endHours = Math.floor(totalMinutes / 60) % 24;
                const endMins = totalMinutes % 60;
                return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
              };
              
              const formatDateToISO = (d: Date | string): string => {
                if (typeof d === 'string') return d;
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
              };
              const dbDateStr = formatDateToISO(dbRow.date as Date | string);
              
              const startTime24 = convertTo24Hour(dbRow.time as string);
              const endTime24 = calculateEndTime(startTime24, dbRow.duration as string);
              
              const extendedProps: Record<string, string> = {
                'ehApp_type': 'wellness',
                'ehApp_id': String(dbRow.id),
              };
              if (dbRow.image_url) extendedProps['ehApp_imageUrl'] = dbRow.image_url as string;
              if (dbRow.external_url) extendedProps['ehApp_externalUrl'] = dbRow.external_url as string;
              if (dbRow.spots) extendedProps['ehApp_spots'] = dbRow.spots as string;
              if (dbRow.status) extendedProps['ehApp_status'] = dbRow.status as string;
              
              const patchResult = await calendar.events.patch({
                calendarId,
                eventId: googleEventId,
                requestBody: {
                  summary: calendarTitle,
                  description: calendarDescription,
                  start: {
                    dateTime: `${dbDateStr}T${startTime24}`,
                    timeZone: 'America/Los_Angeles',
                  },
                  end: {
                    dateTime: `${dbDateStr}T${endTime24}`,
                    timeZone: 'America/Los_Angeles',
                  },
                  extendedProperties: {
                    private: extendedProps,
                  },
                },
              });
              
              const newEtag = patchResult.data.etag || null;
              const newUpdatedAt = patchResult.data.updated ? new Date(patchResult.data.updated) : null;
              
              await db.execute(sql`UPDATE wellness_classes SET last_synced_at = NOW(), locally_edited = false,
                 google_event_etag = ${newEtag}, google_event_updated_at = ${newUpdatedAt}, app_last_modified_at = NULL
                 WHERE id = ${dbRow.id}`);
              pushedToCalendar++;
            } catch (pushError: unknown) {
              logger.error(`[Wellness Sync] Failed to push local edits to calendar for class #${dbRow.id}:`, { error: pushError });
            }
          }
        } else {
          const reviewDismissed = dbRow.review_dismissed === true;
          const shouldSetNeedsReview = reviewDismissed ? false : needsReview;
          
          const dbDate = dbRow.date instanceof Date 
            ? dbRow.date.toISOString().split('T')[0] 
            : String(dbRow.date || '').split('T')[0];
          
          const wasReviewed = dbRow.needs_review === false && dbRow.reviewed_at !== null;
          const hasChanges = (
            dbRow.title !== title ||
            dbDate !== eventDate ||
            dbRow.time !== startTime ||
            ((dbRow.instructor as string) || null) !== (instructor || null) ||
            dbRow.duration !== duration ||
            ((dbRow.category as string) || null) !== (category || null)
          );
          const isConflict = wasReviewed && hasChanges && !reviewDismissed;
          
          await db.execute(sql`UPDATE wellness_classes SET 
              title = ${title}, time = ${startTime}, instructor = ${instructor}, duration = ${duration}, 
              category = ${category}, spots = ${spots}, status = ${status}, description = ${description}, 
              date = ${eventDate}, is_active = true, updated_at = NOW(),
              image_url = COALESCE(${appMetadata.imageUrl}, image_url),
              external_url = COALESCE(${appMetadata.externalUrl}, external_url),
              google_event_etag = ${googleEtag}, google_event_updated_at = ${googleUpdatedAt}, last_synced_at = NOW(),
              needs_review = CASE WHEN ${reviewDismissed} THEN needs_review ELSE CASE WHEN ${isConflict} THEN true ELSE ${shouldSetNeedsReview} END END,
              conflict_detected = CASE WHEN ${isConflict} THEN true ELSE conflict_detected END,
              recurring_event_id = COALESCE(${recurringEventId}, recurring_event_id)
             WHERE google_calendar_id = ${googleEventId}`);
          updated++;
        }
      } else {
        await db.execute(sql`INSERT INTO wellness_classes 
            (title, time, instructor, duration, category, spots, status, description, date, is_active, 
             google_calendar_id, image_url, external_url, google_event_etag, google_event_updated_at, last_synced_at, created_at, needs_review, recurring_event_id)
           VALUES (${title}, ${startTime}, ${instructor}, ${duration}, ${category}, ${spots}, ${status}, ${description}, ${eventDate}, true, ${googleEventId},
            ${appMetadata.imageUrl}, ${appMetadata.externalUrl}, ${googleEtag}, ${googleUpdatedAt}, NOW(), NOW(), ${needsReview}, ${recurringEventId})`);
        created++;
      }
    }
    
    const existingClasses = await db.execute(sql`SELECT id, google_calendar_id FROM wellness_classes WHERE google_calendar_id IS NOT NULL AND is_active = true`);
    
    const idsToDeactivate = (existingClasses.rows as Array<Record<string, unknown>>)
      .filter((dbClass: Record<string, unknown>) => cancelledEventIds.has(dbClass.google_calendar_id as string) || !fetchedEventIds.has(dbClass.google_calendar_id as string))
      .map((dbClass: Record<string, unknown>) => dbClass.id as number);
    let deleted = 0;
    if (idsToDeactivate.length > 0) {
      await db.execute(sql`UPDATE wellness_classes SET is_active = false WHERE id = ANY(${idsToDeactivate})`);
      deleted = idsToDeactivate.length;
    }
    
    return { synced: events.length, created, updated, deleted, pushedToCalendar };
  } catch (error: unknown) {
    logger.error('Error syncing Wellness Calendar events:', { error: error });
    
    if (!options?.suppressAlert) {
      alertOnSyncFailure(
        'calendar',
        'Wellness calendar sync',
        error instanceof Error ? error : new Error(String(error)),
        { calendarName: CALENDAR_CONFIG.wellness.name }
      ).catch((alertErr: unknown) => {
        logger.error('[Wellness Sync] Failed to send staff alert:', { error: alertErr });
      });
    }
    
    return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Failed to sync wellness classes' };
  }
}

export async function backfillWellnessToCalendar(): Promise<{ created: number; total: number; errors: string[] }> {
  const errors: string[] = [];
  let created = 0;
  
  try {
    await discoverCalendarIds();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
    
    if (!calendarId) {
      return { created: 0, total: 0, errors: ['Wellness calendar not found'] };
    }
    
    const classesWithoutCalendarRows = await db.select()
      .from(wellnessClasses)
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
    
    for (const wc of classesWithoutCalendarRows) {
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
          await db.execute(sql`UPDATE wellness_classes SET google_calendar_id = ${googleCalendarId} WHERE id = ${wc.id}`);
          created++;
        }
      } catch (err: unknown) {
        errors.push(`Class ${wc.id}: ${getErrorMessage(err)}`);
      }
    }
    
    return { created, total: classesWithoutCalendarRows.length, errors };
  } catch (error: unknown) {
    logger.error('Error backfilling wellness to calendar:', { error: error });
    return { created: 0, total: 0, errors: [`Backfill failed: ${getErrorMessage(error)}`] };
  }
}
