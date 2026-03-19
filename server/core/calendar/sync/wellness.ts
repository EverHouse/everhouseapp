import { db } from '../../../db';
import { sql, eq, isNull, gte, asc, and } from 'drizzle-orm';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getGoogleCalendarClient } from '../../integrations';
import { wellnessClasses } from '../../../../shared/models/auth';
import { availabilityBlocks } from '../../../../shared/models/scheduling';
import { getTodayPacific, getPacificMidnightUTC } from '../../../utils/dateUtils';
import { CALENDAR_CONFIG } from '../config';
import { getCalendarIdByName, discoverCalendarIds } from '../cache';
import { alertOnSyncFailure } from '../../dataAlerts';
import { getAllActiveBayIds, getConferenceRoomId } from '../../affectedAreas';
import { findCoveringBlock } from '../../availabilityBlockService';

import { toIntArrayLiteral } from '../../../utils/sqlArrayLiteral';
import { logger } from '../../logger';
import { withCalendarRetry } from '../../retryUtils';

async function resyncWellnessAvailabilityBlocks(
  wellnessClassId: number,
  classDate: string,
  startTime: string,
  endTime: string,
  blockSimulators: boolean,
  blockConferenceRoom: boolean,
  classTitle?: string
): Promise<void> {
  try {
    await db.delete(availabilityBlocks).where(eq(availabilityBlocks.wellnessClassId, wellnessClassId));

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

    const blockNotes = classTitle ? `Blocked for: ${classTitle}` : 'Blocked for wellness class';
    const effectiveEndTime = endTime || startTime;
    for (const resourceId of resourceIds) {
      try {
        const covering = await findCoveringBlock(resourceId, classDate, startTime, effectiveEndTime);
        if (covering && covering.wellness_class_id !== wellnessClassId) {
          logger.info(`[Wellness Sync] Skipping block insert for class #${wellnessClassId} resource ${resourceId} — covered by existing block #${covering.id} (type: ${covering.block_type})`, {
            extra: { resourceId, classDate, startTime, endTime: effectiveEndTime, wellnessClassId }
          });
          continue;
        }
        await db.insert(availabilityBlocks).values({
          resourceId,
          blockDate: classDate,
          startTime,
          endTime: effectiveEndTime,
          blockType: 'wellness',
          notes: blockNotes,
          createdBy: 'calendar_sync',
          wellnessClassId,
        }).onConflictDoUpdate({
          target: [availabilityBlocks.resourceId, availabilityBlocks.blockDate, availabilityBlocks.startTime, availabilityBlocks.endTime, availabilityBlocks.wellnessClassId],
          targetWhere: sql`${availabilityBlocks.wellnessClassId} IS NOT NULL`,
          set: {
            blockType: 'wellness',
            notes: blockNotes,
            createdBy: 'calendar_sync',
          },
        });
      } catch (insertErr: unknown) {
        logger.warn(`[Wellness Sync] Insert failed for class #${wellnessClassId} resource ${resourceId}: ${getErrorMessage(insertErr)}`);
      }
    }
  } catch (err: unknown) {
    logger.error(`[Wellness Sync] Failed to resync availability blocks for class #${wellnessClassId}: ${getErrorMessage(err)}`);
  }
}
export async function syncWellnessCalendarEvents(options?: { suppressAlert?: boolean }): Promise<{ synced: number; created: number; updated: number; deleted: number; pushedToCalendar: number; error?: string }> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: `Calendar "${CALENDAR_CONFIG.wellness.name}" not found` };
    }
    
    const oneYearAgo = getPacificMidnightUTC();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
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
      }), 'wellness-list');
      if (response.data.items) events.push(...response.data.items);
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
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
      
      const extProps = event.extendedProperties?.shared || event.extendedProperties?.private || {};
      const appMetadata = {
        imageUrl: extProps['ehApp_imageUrl'] || null,
        externalUrl: extProps['ehApp_externalUrl'] || null,
        category: extProps['ehApp_category'] || null,
        duration: extProps['ehApp_duration'] || null,
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
      let category = appMetadata.category || 'Wellness';
      
      if (rawTitle.includes(' - ')) {
        const parts = rawTitle.split(' - ');
        if (!appMetadata.category) category = parts[0].trim();
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
        
        if (!appMetadata.category) {
          const categoryMatch = description.match(/category[:\s]+([^\n,]+)/i);
          if (categoryMatch) category = categoryMatch[1].trim();
        }
      }
      
      let duration = appMetadata.duration || `${durationMinutes} min`;
      let spots = appMetadata.spots || '10 spots';
      let status = appMetadata.status || 'Open';
      
      if (!appMetadata.duration && description) {
        const durationMatch = description.match(/duration[:\s]+([^\n,]+)/i);
        if (durationMatch) duration = durationMatch[1].trim();
      }
      if (!appMetadata.spots && description) {
        const spotsMatch = description.match(/spots[:\s]+([^\n,]+)/i);
        if (spotsMatch) spots = spotsMatch[1].trim();
      }
      if (!appMetadata.status && description) {
        const statusMatch = description.match(/status[:\s]+([^\n,]+)/i);
        if (statusMatch) status = statusMatch[1].trim();
      }
      
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
                image_url, external_url, spots, status, title, time, instructor, duration, category, date, description,
                reviewed_at, last_synced_at, review_dismissed, needs_review,
                block_simulators, block_conference_room
         FROM wellness_classes WHERE google_calendar_id = ${googleEventId}`);
      
      interface WellnessDbRow {
        id: number;
        locally_edited: boolean;
        app_last_modified_at: string | null;
        google_event_updated_at: string | null;
        image_url: string | null;
        external_url: string | null;
        spots: string | null;
        status: string | null;
        title: string;
        time: string;
        instructor: string | null;
        duration: string;
        category: string | null;
        date: Date | string;
        description: string | null;
        reviewed_at: string | null;
        last_synced_at: string | null;
        review_dismissed: boolean;
        needs_review: boolean;
        block_simulators: boolean;
        block_conference_room: boolean;
      }

      if (existing.rows.length > 0) {
        const dbRow = existing.rows[0] as unknown as WellnessDbRow;
        const appModifiedAt = dbRow.app_last_modified_at ? new Date(dbRow.app_last_modified_at as string) : null;
        
        if (dbRow.locally_edited === true && appModifiedAt) {
          const calendarIsNewer = googleUpdatedAt && googleUpdatedAt > appModifiedAt;
          
          if (calendarIsNewer) {
            await db.execute(sql`UPDATE wellness_classes SET 
                title = ${title ?? null}, time = ${startTime ?? null}, instructor = ${instructor ?? null}, duration = ${duration ?? null}, 
                category = ${category ?? null}, spots = ${spots ?? null}, status = ${status ?? null}, description = ${description ?? null}, 
                date = ${eventDate ?? null}, is_active = true, updated_at = NOW(),
                image_url = COALESCE(${appMetadata.imageUrl ?? null}, image_url),
                external_url = COALESCE(${appMetadata.externalUrl ?? null}, external_url),
                google_event_etag = ${googleEtag ?? null}, google_event_updated_at = ${googleUpdatedAt ?? null}, last_synced_at = NOW(),
                locally_edited = false, app_last_modified_at = NULL, needs_review = ${needsReview ?? null},
                recurring_event_id = COALESCE(${recurringEventId ?? null}, recurring_event_id)
               WHERE google_calendar_id = ${googleEventId}`);
            if (dbRow.block_simulators || dbRow.block_conference_room) {
              const durationMatch = duration.match(/(\d+)/);
              const durMins = durationMatch ? parseInt(durationMatch[1], 10) : durationMinutes;
              const [sh, sm] = startTime.split(':').map(Number);
              const totalMins = sh * 60 + sm + durMins;
              const wellnessEndTime = `${String(Math.floor(totalMins / 60) % 24).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}:00`;
              await resyncWellnessAvailabilityBlocks(dbRow.id, eventDate, startTime + ':00', wellnessEndTime, dbRow.block_simulators, dbRow.block_conference_room, title);
            }
            updated++;
          } else {
            try {
              const calendarTitle = `${dbRow.title} with ${dbRow.instructor}`;
              const calendarDescription = (dbRow.description as string) || '';
              
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
                  return `${match24h[1].padStart(2, '0')}:${match24h[2]}:${match24h[3] || '00'}`;
                }
                return '09:00:00';
              };
              
              const calculateEndTime = (startTime24: string, durationStr: string): string => {
                const durationMatch = durationStr.match(/(\d+)/);
                const durationMins = durationMatch ? parseInt(durationMatch[1], 10) : 60;
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
              if (dbRow.category) extendedProps['ehApp_category'] = dbRow.category as string;
              if (dbRow.duration) extendedProps['ehApp_duration'] = dbRow.duration as string;
              if (dbRow.spots) extendedProps['ehApp_spots'] = dbRow.spots as string;
              if (dbRow.status) extendedProps['ehApp_status'] = dbRow.status as string;
              
              const wellnessOptionalKeys = ['ehApp_imageUrl', 'ehApp_externalUrl', 'ehApp_category', 'ehApp_duration', 'ehApp_spots', 'ehApp_status'];
              const mergedWellnessProps: Record<string, string | null> = { ...extProps, ...extendedProps };
              for (const key of wellnessOptionalKeys) {
                if (!extendedProps[key] && extProps[key]) mergedWellnessProps[key] = null;
              }

              const patchResult = await withCalendarRetry(() => calendar.events.patch({
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
                    shared: mergedWellnessProps,
                  },
                },
              }), `wellness-patch-class-${dbRow.id}`);
              
              const newEtag = patchResult.data.etag || null;
              const newUpdatedAt = patchResult.data.updated ? new Date(patchResult.data.updated) : null;
              
              const wellnessClearResult = await db.execute(sql`UPDATE wellness_classes SET last_synced_at = NOW(), locally_edited = false,
                 google_event_etag = ${newEtag}, google_event_updated_at = ${newUpdatedAt}, app_last_modified_at = NULL
                 WHERE id = ${dbRow.id} AND (app_last_modified_at IS NOT DISTINCT FROM ${appModifiedAt})`);
              if ((wellnessClearResult as { rowCount?: number }).rowCount === 0) {
                logger.warn(`[Wellness Sync] Class #${dbRow.id} was re-edited during push-back; keeping locally_edited=true for next sync`);
              } else {
                pushedToCalendar++;
              }
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
          if (dbRow.block_simulators || dbRow.block_conference_room) {
            const durationMatch = duration.match(/(\d+)/);
            const durMins = durationMatch ? parseInt(durationMatch[1], 10) : durationMinutes;
            const [sh, sm] = startTime.split(':').map(Number);
            const totalMins = sh * 60 + sm + durMins;
            const wellnessEndTime = `${String(Math.floor(totalMins / 60) % 24).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}:00`;
            await resyncWellnessAvailabilityBlocks(dbRow.id, eventDate, startTime + ':00', wellnessEndTime, dbRow.block_simulators, dbRow.block_conference_room, title);
          }
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
    
    interface WellnessClassIdRow { id: number; google_calendar_id: string }
    const idsToDeactivate = (existingClasses.rows as unknown as WellnessClassIdRow[])
      .filter((dbClass) => cancelledEventIds.has(dbClass.google_calendar_id) || !fetchedEventIds.has(dbClass.google_calendar_id))
      .map((dbClass) => dbClass.id);
    let deleted = 0;
    if (idsToDeactivate.length > 0) {
      const idsToDeactivateLiteral = toIntArrayLiteral(idsToDeactivate);
      await db.execute(sql`DELETE FROM availability_blocks WHERE wellness_class_id = ANY(${idsToDeactivateLiteral}::int[])`);
      await db.execute(sql`UPDATE wellness_classes SET is_active = false WHERE id = ANY(${idsToDeactivateLiteral}::int[])`);
      deleted = idsToDeactivate.length;
    }
    
    return { synced: events.length, created, updated, deleted, pushedToCalendar };
  } catch (error: unknown) {
    logger.error('Error syncing Wellness Calendar events:', { error: error });
    
    if (!options?.suppressAlert) {
      alertOnSyncFailure(
        'calendar',
        'Wellness calendar sync',
        error instanceof Error ? error : new Error(getErrorMessage(error)),
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
    
    const calendar = await getGoogleCalendarClient();
    
    for (const wc of classesWithoutCalendarRows) {
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
        
        const formatDateToISO = (d: Date | string): string => {
          if (typeof d === 'string') return d;
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        };
        const dateStr = formatDateToISO(wc.date);
        
        const response = await calendar.events.insert({
          calendarId,
          requestBody: {
            summary: calendarTitle,
            description: calendarDescription,
            start: {
              dateTime: `${dateStr}T${startTime24}`,
              timeZone: 'America/Los_Angeles',
            },
            end: {
              dateTime: `${dateStr}T${endTime24}`,
              timeZone: 'America/Los_Angeles',
            },
            extendedProperties: {
              shared: extendedProps,
            },
          },
        });
        
        const googleCalendarId = response.data.id || null;
        
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
