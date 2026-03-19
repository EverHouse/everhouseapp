import { db } from '../../../db';
import { sql, type SQL } from 'drizzle-orm';
import { getGoogleCalendarClient } from '../../integrations';
import { CALENDAR_CONFIG } from '../config';
import { getCalendarIdByName, discoverCalendarIds } from '../cache';
import { getPacificMidnightUTC } from '../../../utils/dateUtils';

import { toIntArrayLiteral } from '../../../utils/sqlArrayLiteral';
import { logger } from '../../logger';
import { getErrorMessage } from '../../../utils/errorUtils';
import { withCalendarRetry } from '../../retryUtils';
import { findCoveringBlock } from '../../availabilityBlockService';

const LESSON_PREFIXES = ['lesson', 'private lesson', 'kids lesson', 'group lesson'];
function isLessonTitle(title: string): boolean {
  return LESSON_PREFIXES.some(prefix => title.startsWith(prefix));
}
function stripBracketPrefixes(title: string): string {
  return title.replace(/^\[[^\]]*\]\s*[-:|]?\s*/g, '').trim();
}

function stripHtmlTags(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseClosureMetadata(description: string): { affectedAreas?: string; notifyMembers?: boolean; notes?: string; visibility?: string } {
  const result: { affectedAreas?: string; notifyMembers?: boolean; notes?: string; visibility?: string } = {};
  
  if (!description) return result;
  
  const affectedMatch = description.match(/\[Affected:\s*(.*?)\]/i);
  if (affectedMatch) {
    const value = affectedMatch[1].trim().toLowerCase();
    if (value === 'none') result.affectedAreas = 'none';
    else if (value === 'all bays') result.affectedAreas = 'all_bays';
    else if (value === 'conference room') result.affectedAreas = 'conference_room';
    else if (value === 'entire facility') result.affectedAreas = 'entire_facility';
  }
  
  const notifyMatch = description.match(/\[Members Notified:\s*(Yes|No)\]/i);
  if (notifyMatch) {
    result.notifyMembers = notifyMatch[1].toLowerCase() === 'yes';
  }
  
  // Extract notes: content after the [Members Notified: ...] bracket
  const notesMatch = description.match(/\[Members Notified:\s*(?:Yes|No)\]\s*([\s\S]*)/i);
  if (notesMatch && notesMatch[1]) {
    const rawNotes = notesMatch[1].trim();
    if (rawNotes) {
      result.notes = stripHtmlTags(rawNotes);
    }
  }
  
  return result;
}

export function formatClosureMetadata(affectedAreas: string, notifyMembers: boolean, notes?: string): string {
  const affectedDisplay: Record<string, string> = {
    'none': 'None',
    'all_bays': 'All Bays',
    'conference_room': 'Conference Room',
    'entire_facility': 'Entire Facility'
  };
  
  let result = `\n---\n[Affected: ${affectedDisplay[affectedAreas] || 'None'}]\n[Members Notified: ${notifyMembers ? 'Yes' : 'No'}]`;
  
  // Append notes after the metadata if provided
  if (notes && notes.trim()) {
    result += `\n\n${notes.trim()}`;
  }
  
  return result;
}

export function updateDescriptionWithMetadata(originalDescription: string, affectedAreas: string, notifyMembers: boolean, notes?: string): string {
  // Remove existing metadata and any notes after it
  const baseDescription = (originalDescription || '').replace(/\n---\n\[Affected:.*?\]\n\[Members Notified:.*?\][\s\S]*/s, '').trim();
  return baseDescription + formatClosureMetadata(affectedAreas, notifyMembers, notes);
}

export function getBaseDescription(description: string): string {
  if (!description) return '';
  return description.replace(/\n---\n\[Affected:.*?\]\n\[Members Notified:.*?\]/s, '').trim();
}

interface ResourceIdRow { id: number }

function getDayDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(startDate + 'T12:00:00');
  const end = new Date(endDate + 'T12:00:00');
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  if (dates.length === 0) dates.push(startDate);
  return dates;
}

interface ClosureRow {
  id: number;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  affected_areas: string | null;
  needs_review: boolean;
  notice_type: string | null;
  locally_edited: boolean;
  app_last_modified_at: string | null;
  google_event_updated_at: string | null;
  title: string;
  notes: string | null;
  notify_members: boolean;
  reason: string | null;
  internal_calendar_id: string | null;
}

async function getAllResourceIds(): Promise<number[]> {
  const idSet = new Set<number>();
  const resourcesResult = await db.execute(sql`SELECT id FROM resources`);
  (resourcesResult.rows as unknown as ResourceIdRow[]).forEach((r) => idSet.add(r.id));
  return Array.from(idSet);
}

async function getResourceIdsForAffectedAreas(affectedAreas: string | null | undefined): Promise<number[]> {
  if (!affectedAreas) return [];
  const idSet = new Set<number>();
  
  const normalized = affectedAreas.toLowerCase().trim();
  
  if (normalized === 'none' || normalized === '') {
    return [];
  }
  
  if (normalized === 'entire_facility') {
    return getAllResourceIds();
  }
  
  if (normalized === 'all_bays') {
    const simulatorsResult = await db.execute(sql`SELECT id FROM resources WHERE type = 'simulator'`);
    (simulatorsResult.rows as unknown as ResourceIdRow[]).forEach((r) => idSet.add(r.id));
    return Array.from(idSet);
  }
  
  if (normalized === 'conference_room' || normalized === 'conference room') {
    const confResult = await db.execute(sql`SELECT id FROM resources WHERE LOWER(name) LIKE '%conference%' LIMIT 1`);
    if (confResult.rows.length > 0) {
      idSet.add((confResult.rows[0] as unknown as ResourceIdRow).id);
    }
    return Array.from(idSet);
  }
  
  const processToken = async (token: string): Promise<void> => {
    const t = token.toLowerCase().trim();
    if (t === 'entire_facility') {
      const all = await getAllResourceIds();
      all.forEach(id => idSet.add(id));
    } else if (t === 'all_bays') {
      const simulatorsResult = await db.execute(sql`SELECT id FROM resources WHERE type = 'simulator'`);
      (simulatorsResult.rows as unknown as ResourceIdRow[]).forEach((r) => idSet.add(r.id));
    } else if (t === 'conference_room' || t === 'conference room') {
      const confResult = await db.execute(sql`SELECT id FROM resources WHERE LOWER(name) LIKE '%conference%' LIMIT 1`);
      if ((confResult.rows as unknown as ResourceIdRow[]).length > 0) idSet.add((confResult.rows[0] as unknown as ResourceIdRow).id);
    } else if (t.startsWith('bay_')) {
      const bayId = parseInt(t.replace('bay_', ''), 10);
      if (!isNaN(bayId)) idSet.add(bayId);
    }
  };
  
  if (normalized.startsWith('bay_') && !normalized.includes(',') && !normalized.includes('[')) {
    const bayId = parseInt(normalized.replace('bay_', ''), 10);
    if (!isNaN(bayId)) {
      idSet.add(bayId);
    }
    if (idSet.size > 0) return Array.from(idSet);
  }
  
  try {
    const parsed = JSON.parse(affectedAreas);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string') {
          await processToken(item);
        }
      }
      if (idSet.size > 0) return Array.from(idSet);
    }
  } catch (err) {
    logger.debug('[getResourceIdsForAffectedAreas] Failed to parse affected areas as JSON', { error: err instanceof Error ? err.message : err });
  }
  
  const parts = affectedAreas.split(',').map(s => s.trim());
  for (const part of parts) {
    await processToken(part);
  }
  
  if (idSet.size === 0) {
    logger.warn(`[getResourceIdsForAffectedAreas] Could not resolve resources for "${affectedAreas}", falling back to entire_facility`);
    return getAllResourceIds();
  }
  
  return Array.from(idSet);
}

function getDatesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start + 'T12:00:00');
  const endDate = new Date(end + 'T12:00:00');
  while (current <= endDate) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function createAvailabilityBlocks(
  closureId: number,
  resourceIds: number[],
  dates: string[],
  blockStartTime: string,
  blockEndTime: string,
  notes: string
): Promise<number> {
  let blocksCreated = 0;
  
  const validResourcesResult = await db.execute(
    sql`SELECT id FROM resources WHERE id = ANY(${toIntArrayLiteral(resourceIds)}::int[])`
  );
  const validResourceIds = new Set((validResourcesResult.rows as unknown as ResourceIdRow[]).map((r) => r.id));
  const filteredIds = resourceIds.filter(id => validResourceIds.has(id));
  
  if (filteredIds.length < resourceIds.length) {
    const skippedIds = resourceIds.filter(id => !validResourceIds.has(id));
    logger.info(`[Calendar Sync] Skipping non-existent resource IDs: ${skippedIds.join(', ')}`);
  }
  
  const valueParts: SQL[] = [];
  for (const resId of filteredIds) {
    for (const date of dates) {
      const covering = await findCoveringBlock(resId, date, blockStartTime, blockEndTime);
      if (covering) {
        logger.info(`[Closures Sync] Skipping block insert for closure #${closureId} — covered by existing block #${covering.id} (type: ${covering.block_type})`, {
          extra: { resourceId: resId, blockDate: date, startTime: blockStartTime, endTime: blockEndTime, closureId }
        });
        continue;
      }
      valueParts.push(sql`(${resId}, ${date}, ${blockStartTime}, ${blockEndTime}, 'blocked', ${notes}, 'system', ${closureId})`);
      blocksCreated++;
    }
  }
  if (valueParts.length > 0) {
    await db.execute(
      sql`INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by, closure_id)
       VALUES ${sql.join(valueParts, sql`, `)}
       ON CONFLICT DO NOTHING`
    );
  }
  return blocksCreated;
}

async function deleteAvailabilityBlocks(closureId: number): Promise<void> {
  await db.execute(sql`DELETE FROM availability_blocks WHERE closure_id = ${closureId}`);
}

function extractNoticeTypeFromTitle(title: string): { noticeType: string | null; cleanTitle: string } {
  const bracketMatch = title.match(/^\[([^\]]+)\]\s*:?\s*/i);
  if (bracketMatch) {
    const noticeType = bracketMatch[1].trim();
    const cleanTitle = title.replace(bracketMatch[0], '').trim();
    return { noticeType, cleanTitle };
  }
  if (title.toLowerCase().startsWith('closure:')) {
    return { noticeType: 'Closure', cleanTitle: title.replace(/^closure:\s*/i, '').trim() };
  }
  return { noticeType: null, cleanTitle: title };
}

async function ensureNoticeTypeExists(typeName: string): Promise<void> {
  if (!typeName) return;
  const normalized = typeName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  await db.execute(
    sql`INSERT INTO notice_types (name, is_preset, sort_order) VALUES (${normalized}, false, 100) ON CONFLICT (name) DO NOTHING`
  );
}

export async function syncInternalCalendarToClosures(): Promise<{ synced: number; created: number; updated: number; deleted: number; pushedToCalendar: number; error?: string }> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: `Calendar "${CALENDAR_CONFIG.internal.name}" not found` };
    }
    
    // Use Pacific midnight for consistent timezone handling
    const pacificMidnight = getPacificMidnightUTC();
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    let pageToken: string | undefined;
    do {
      const response = await withCalendarRetry(() => calendar.events.list({
        calendarId,
        timeMin: pacificMidnight.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: true,
        pageToken,
      }), 'closures-list');
      if (response.data.items) events.push(...response.data.items);
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    const fetchedEventIds = new Set<string>();
    const cancelledEventIds = new Set<string>();
    let created = 0;
    let updated = 0;
    let pushedToCalendar = 0;
    const pushedClosureIds = new Set<number>();
    let skippedTrackman = 0;
    
    const todayStr = pacificMidnight.toISOString().split('T')[0];
    const trackmanBookingsResult = await db.execute(sql`
      SELECT request_date, start_time, end_time
      FROM booking_requests 
      WHERE origin = 'trackman_webhook' 
        AND request_date >= ${todayStr}
        AND status NOT IN ('cancelled', 'declined', 'deleted')`);
    interface TrackmanSlotRow { request_date: string; start_time: string; end_time: string }
    const trackmanSlotSet = new Set(
      (trackmanBookingsResult.rows as unknown as TrackmanSlotRow[]).map(slot => {
        const d = typeof slot.request_date === 'string' && slot.request_date.includes('T')
          ? slot.request_date.split('T')[0]
          : String(slot.request_date);
        return `${d}_${slot.start_time}_${slot.end_time}`;
      })
    );
    for (const event of events) {
      if (!event.id) continue;
      
      if (event.status === 'cancelled' || !event.summary) {
        cancelledEventIds.add(event.id);
        continue;
      }
      
      const rawTitleLower = event.summary.toLowerCase().trim();
      const strippedTitle = stripBracketPrefixes(rawTitleLower);
      if (isLessonTitle(rawTitleLower) || isLessonTitle(strippedTitle)) {
        continue;
      }
      
      const internalCalendarId = event.id;
      const rawTitle = event.summary;
      const { noticeType, cleanTitle } = extractNoticeTypeFromTitle(rawTitle);
      const title = cleanTitle;
      const rawDescription = event.description || '';
      const extProps = event.extendedProperties?.shared || event.extendedProperties?.private || {};
      
      const hasExtProps = !!(extProps['ehApp_affectedAreas'] || extProps['ehApp_notifyMembers']);
      const calendarNotes = hasExtProps ? null : (getBaseDescription(rawDescription) || null);
      
      if (noticeType) {
        await ensureNoticeTypeExists(noticeType);
      }
      
      const parsedMetadata = parseClosureMetadata(rawDescription);
      const metadata = {
        affectedAreas: extProps['ehApp_affectedAreas'] || parsedMetadata.affectedAreas,
        notifyMembers: extProps['ehApp_notifyMembers'] !== undefined
          ? extProps['ehApp_notifyMembers'] === 'true'
          : parsedMetadata.notifyMembers,
        notes: extProps['ehApp_notes'] || parsedMetadata.notes,
        visibility: parsedMetadata.visibility,
      };
      
      let startDate: string;
      let startTime: string | null = null;
      let endDate: string;
      let endTime: string | null = null;
      
      if (event.start?.dateTime) {
        const startDt = new Date(event.start.dateTime);
        startDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        startTime = startDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
        
        if (event.end?.dateTime) {
          const endDt = new Date(event.end.dateTime);
          endDate = endDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
          endTime = endDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
        } else {
          endDate = startDate;
          endTime = '23:59:00';
        }
      } else if (event.start?.date) {
        startDate = event.start.date;
        startTime = null;
        if (event.end?.date) {
          const endDt = new Date(event.end.date);
          endDt.setDate(endDt.getDate() - 1);
          endDate = endDt.toISOString().split('T')[0];
        } else {
          endDate = startDate;
        }
        endTime = null;
      } else {
        continue;
      }
      
      if (startTime && endTime && !extProps['ehApp_type'] && trackmanSlotSet.has(`${startDate}_${startTime}_${endTime}`)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        skippedTrackman++;
        logger.info(`[Calendar Sync] Skipping Trackman booking on Internal Calendar: ${title} on ${startDate} at ${startTime}-${endTime}`);
        continue;
      }
      
      fetchedEventIds.add(event.id);
      
      let existing = await db.execute(
        sql`SELECT id, start_date, end_date, start_time, end_time, affected_areas, needs_review, notice_type,
               locally_edited, app_last_modified_at, google_event_updated_at, title, notes, notify_members, reason,
               internal_calendar_id
         FROM facility_closures
         WHERE internal_calendar_id = ${internalCalendarId}
            OR POSITION(${internalCalendarId} IN internal_calendar_id) > 0`
      );
      
      if (existing.rows.length === 0) {
        const adoptable = await db.execute(
          sql`SELECT id, start_date, end_date, start_time, end_time, affected_areas, needs_review, notice_type,
                 locally_edited, app_last_modified_at, google_event_updated_at, title, notes, notify_members, reason,
                 internal_calendar_id
           FROM facility_closures
           WHERE title = ${title}
             AND is_active = true
             AND start_date <= ${endDate}
             AND end_date >= ${startDate}
           ORDER BY ABS(EXTRACT(EPOCH FROM (start_date::timestamp - ${startDate}::timestamp))) ASC
           LIMIT 1`
        );
        if (adoptable.rows.length > 0) {
          await db.execute(
            sql`UPDATE facility_closures SET internal_calendar_id = ${internalCalendarId} WHERE id = ${(adoptable.rows[0] as unknown as ClosureRow).id}`
          );
          existing = adoptable;
          logger.info(`[Calendar Sync] Adopted closure #${(adoptable.rows[0] as unknown as ClosureRow).id} for event ${internalCalendarId}: ${title}`);
        }
      }
      
      if (existing.rows.length > 0) {
        const existingClosure = existing.rows[0] as unknown as ClosureRow;
        const closureId = existingClosure.id;
        const googleUpdatedAt = event.updated ? new Date(event.updated) : null;
        const appModifiedAt = existingClosure.app_last_modified_at ? new Date(existingClosure.app_last_modified_at) : null;
        
        if (existingClosure.locally_edited === true) {
          if (!appModifiedAt) {
            await db.execute(sql`UPDATE facility_closures SET locally_edited = false, app_last_modified_at = NULL WHERE id = ${closureId}`);
            logger.warn(`[Calendar Sync] Cleared stale locally_edited flag (missing app_last_modified_at) for closure #${closureId}`);
          }
          const calendarIsNewer = appModifiedAt && googleUpdatedAt && googleUpdatedAt > appModifiedAt;
          
          if (appModifiedAt && !calendarIsNewer && !pushedClosureIds.has(closureId)) {
            pushedClosureIds.add(closureId);
            try {
              const dbNoticeType = existingClosure.notice_type;
              const dbAffectedAreas = existingClosure.affected_areas || 'none';
              const defaultType = dbAffectedAreas === 'none' ? 'NOTICE' : 'CLOSURE';
              const typePrefix = dbNoticeType ? `[${dbNoticeType.toUpperCase()}]` : `[${defaultType}]`;
              const calendarTitle = `${typePrefix}: ${existingClosure.title}`;
              const calendarDescription = existingClosure.reason || 'Scheduled notice';
              
              const extendedProps: Record<string, string> = {
                'ehApp_type': 'closure',
                'ehApp_id': String(closureId),
              };
              if (dbAffectedAreas) extendedProps['ehApp_affectedAreas'] = dbAffectedAreas;
              extendedProps['ehApp_notifyMembers'] = existingClosure.notify_members ? 'true' : 'false';
              if (existingClosure.notes) extendedProps['ehApp_notes'] = existingClosure.notes;
              
              const dbInternalIds = existingClosure.internal_calendar_id;
              const allEventIds = dbInternalIds ? dbInternalIds.split(',').filter(Boolean).map(id => id.trim()) : [internalCalendarId];
              const dbStartTime = existingClosure.start_time;
              const dbEndTime = existingClosure.end_time;
              const dbStartDate = existingClosure.start_date;
              const dbEndDate = existingClosure.end_date || dbStartDate;
              
              let lastPatchUpdated: Date | null = null;
              if (dbStartTime && dbEndTime) {
                const dayDates = getDayDatesBetween(dbStartDate, dbEndDate);
                for (let ei = 0; ei < allEventIds.length; ei++) {
                  const evDate = dayDates[ei] || dayDates[dayDates.length - 1];
                  const desc = allEventIds.length > 1
                    ? `${calendarDescription}\n\n(Day ${ei + 1} of ${allEventIds.length})`
                    : calendarDescription;
                  const patchRes = await withCalendarRetry(() => calendar.events.patch({
                    calendarId,
                    eventId: allEventIds[ei],
                    requestBody: {
                      summary: calendarTitle,
                      description: desc,
                      extendedProperties: { shared: extendedProps },
                      start: { dateTime: `${evDate}T${dbStartTime}`, timeZone: 'America/Los_Angeles' },
                      end: { dateTime: `${evDate}T${dbEndTime}`, timeZone: 'America/Los_Angeles' },
                    },
                  }), `closures-patch-${closureId}-${ei}`);
                  if (patchRes.data.updated) lastPatchUpdated = new Date(patchRes.data.updated);
                }
              } else {
                const endDt = new Date(dbEndDate + 'T12:00:00');
                endDt.setDate(endDt.getDate() + 1);
                const gcEndDate = endDt.toISOString().split('T')[0];
                const patchRes = await withCalendarRetry(() => calendar.events.patch({
                  calendarId,
                  eventId: allEventIds[0],
                  requestBody: {
                    summary: calendarTitle,
                    description: calendarDescription,
                    extendedProperties: { shared: extendedProps },
                    start: { date: dbStartDate },
                    end: { date: gcEndDate },
                  },
                }), `closures-patch-${closureId}`);
                if (patchRes.data.updated) lastPatchUpdated = new Date(patchRes.data.updated);
              }
              
              const clearResult = await db.execute(sql`UPDATE facility_closures SET 
                last_synced_at = NOW(), locally_edited = false,
                app_last_modified_at = NULL,
                google_event_updated_at = ${lastPatchUpdated}
                WHERE id = ${closureId}
                  AND (app_last_modified_at IS NOT DISTINCT FROM ${appModifiedAt})`);
              if ((clearResult as { rowCount?: number }).rowCount === 0) {
                logger.warn(`[Calendar Sync] Closure #${closureId} was re-edited during push-back; keeping locally_edited=true for next sync`);
              } else {
                pushedToCalendar++;
                logger.info(`[Calendar Sync] Pushed local edits to calendar for closure #${closureId} (${allEventIds.length} event(s)): ${existingClosure.title}`);
              }
            } catch (pushError: unknown) {
              logger.error(`[Calendar Sync] Failed to push local edits to calendar for closure #${closureId}:`, { error: pushError });
            }
          } else if (pushedClosureIds.has(closureId)) {
            continue;
          } else {
            await db.execute(
              sql`UPDATE facility_closures SET 
               title = ${title}, start_date = ${startDate}, start_time = ${startTime},
               end_date = ${endDate}, end_time = ${endTime},
               notice_type = COALESCE(notice_type, ${noticeType}),
               notes = COALESCE(${calendarNotes || metadata.notes || null}, notes), is_active = true,
               locally_edited = false, app_last_modified_at = NULL, last_synced_at = NOW(),
               google_event_updated_at = ${googleUpdatedAt}
               WHERE id = ${closureId}`
            );
            updated++;
          }
        } else {
          const preservedAffectedAreas = existingClosure.affected_areas || 'entire_facility';
          
          const datesChanged = 
            existingClosure.start_date !== startDate || 
            existingClosure.end_date !== endDate ||
            existingClosure.start_time !== startTime ||
            existingClosure.end_time !== endTime;
          
          const hasValidNoticeType = !!(noticeType || existingClosure.notice_type);
          const hasValidAffectedAreas = !!(existingClosure.affected_areas && existingClosure.affected_areas !== 'none');
          const shouldClearNeedsReview = existingClosure.needs_review && hasValidAffectedAreas && hasValidNoticeType;

          await db.execute(
            sql`UPDATE facility_closures SET 
             title = ${title}, start_date = ${startDate}, start_time = ${startTime},
             end_date = ${endDate}, end_time = ${endTime},
             notice_type = COALESCE(notice_type, ${noticeType}),
             notes = COALESCE(${calendarNotes || metadata.notes || null}, notes), is_active = true,
             needs_review = CASE WHEN ${!!shouldClearNeedsReview} THEN false ELSE needs_review END,
             last_synced_at = NOW(), google_event_updated_at = ${googleUpdatedAt}
             WHERE id = ${closureId}`
          );
          
          if (datesChanged) {
            await deleteAvailabilityBlocks(closureId);
            if (preservedAffectedAreas !== 'none') {
              const resourceIds = await getResourceIdsForAffectedAreas(preservedAffectedAreas);
              const dates = getDatesBetween(startDate, endDate);
              const blockStartTime = startTime || '08:00:00';
              const blockEndTime = endTime || '22:00:00';
              await createAvailabilityBlocks(closureId, resourceIds, dates, blockStartTime, blockEndTime, title);
              logger.info(`[Calendar Sync] Updated availability blocks for closure #${closureId}: ${title}`);
            } else {
              logger.info(`[Calendar Sync] Updated closure #${closureId}: ${title} (no availability blocks - affected_areas='none')`);
            }
          }
          
          updated++;
        }
      } else {
        let affectedAreas = metadata.affectedAreas || 'none';
        let visibility = metadata.visibility || null;
        let notifyMembers = metadata.notifyMembers ?? false;
        let needsReview = !noticeType || affectedAreas === 'none' || !visibility;
        let restoredNotes = calendarNotes || metadata.notes || null;

        const deactivated = await db.execute(
          sql`SELECT affected_areas, visibility, notify_members, needs_review, notes FROM facility_closures
           WHERE title = ${title}
             AND is_active = false
             AND start_date <= ${endDate}
             AND end_date >= ${startDate}
             AND created_at >= NOW() - INTERVAL '90 days'
           ORDER BY ABS(EXTRACT(EPOCH FROM (start_date::timestamp - ${startDate}::timestamp))) ASC, created_at DESC
           LIMIT 1`
        );
        if (deactivated.rows.length > 0) {
          const prev = deactivated.rows[0] as unknown as { affected_areas: string | null; visibility: string | null; notify_members: boolean; needs_review: boolean; notes: string | null };
          if (prev.affected_areas && prev.affected_areas !== 'none') {
            affectedAreas = prev.affected_areas;
          }
          if (prev.visibility) {
            visibility = prev.visibility;
          }
          notifyMembers = prev.notify_members ?? notifyMembers;
          needsReview = prev.needs_review;
          if (!restoredNotes && prev.notes) {
            restoredNotes = prev.notes;
          }
          logger.info(`[Calendar Sync] Restored configured fields from deactivated closure for: ${title}`);
        }

        const result = await db.execute(
          sql`INSERT INTO facility_closures 
           (title, notes, notice_type, start_date, start_time, end_date, end_time, affected_areas, visibility, notify_members, is_active, created_by, internal_calendar_id, needs_review)
           VALUES (${title}, ${restoredNotes}, ${noticeType}, ${startDate}, ${startTime}, ${endDate}, ${endTime}, ${affectedAreas}, ${visibility}, ${notifyMembers}, true, 'system', ${internalCalendarId}, ${needsReview})
           RETURNING id`
        );
        
        const closureId = (result.rows[0] as { id: number }).id;
        
        if (affectedAreas !== 'none') {
          const resourceIds = await getResourceIdsForAffectedAreas(affectedAreas);
          const dates = getDatesBetween(startDate, endDate);
          const blockStartTime = startTime || '08:00:00';
          const blockEndTime = endTime || '22:00:00';
          const blocksCreated = await createAvailabilityBlocks(closureId, resourceIds, dates, blockStartTime, blockEndTime, title);
          logger.info(`[Calendar Sync] Created ${blocksCreated} availability blocks for closure #${closureId}: ${title}`);
        } else {
          logger.info(`[Calendar Sync] Created closure #${closureId}: ${title} (no availability blocks - affected_areas='none')`);
        }
        
        created++;
      }
    }
    
    const existingClosures = await db.execute(
      sql`SELECT id, internal_calendar_id FROM facility_closures WHERE internal_calendar_id IS NOT NULL AND is_active = true`
    );
    
    let deleted = 0;
    interface ExistingClosureRow { id: number; internal_calendar_id: string }
    const closuresToDeactivate: ExistingClosureRow[] = [];
    for (const closure of existingClosures.rows as unknown as ExistingClosureRow[]) {
      const closureCalIds = closure.internal_calendar_id.split(',').map((id: string) => id.trim()).filter(Boolean);
      const anyCancelled = closureCalIds.some((id: string) => cancelledEventIds.has(id));
      const anyFetched = closureCalIds.some((id: string) => fetchedEventIds.has(id));
      
      if (anyCancelled || !anyFetched) {
        closuresToDeactivate.push(closure);
      }
    }

    const totalActive = existingClosures.rows.length;
    const deactivationRatio = totalActive > 0 ? closuresToDeactivate.length / totalActive : 0;
    if (totalActive > 0 && deactivationRatio > 0.5) {
      logger.warn(`[Calendar Sync] Mass deactivation guard triggered: ${closuresToDeactivate.length}/${totalActive} (${Math.round(deactivationRatio * 100)}%) closures would be deactivated. Skipping deactivation step to prevent data loss from possible calendar API failure.`);
    } else {
      for (const closure of closuresToDeactivate) {
        await deleteAvailabilityBlocks(closure.id);
        await db.execute(sql`UPDATE facility_closures SET is_active = false WHERE id = ${closure.id}`);
        logger.info(`[Calendar Sync] Deactivated closure #${closure.id} and removed availability blocks`);
        deleted++;
      }
    }
    
    return { synced: events.length, created, updated, deleted, pushedToCalendar };
  } catch (error: unknown) {
    logger.error('Error syncing Internal Calendar to closures:', { error: error });
    return { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Failed to sync closures' };
  }
}

interface BackfillResult {
  closures: { patched: number; skipped: number; errors: string[] };
  events: { patched: number; skipped: number; errors: string[] };
  wellness: { patched: number; skipped: number; errors: string[] };
}

function propsNeedUpdate(
  existing: Record<string, string>,
  expected: Record<string, string>,
  allOptionalKeys: string[] = []
): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (existing[key] !== value) return true;
  }
  for (const key of allOptionalKeys) {
    if (existing[key] && !expected[key]) return true;
  }
  return false;
}

function buildPatchProps(
  existing: Record<string, string>,
  expected: Record<string, string>,
  allOptionalKeys: string[]
): Record<string, string | null> {
  const merged: Record<string, string | null> = { ...existing, ...expected };
  for (const key of allOptionalKeys) {
    if (!expected[key] && existing[key]) {
      merged[key] = null;
    }
  }
  return merged;
}

export async function backfillCalendarExtendedProperties(): Promise<BackfillResult> {
  await discoverCalendarIds();
  const calendar = await getGoogleCalendarClient();
  
  const result: BackfillResult = {
    closures: { patched: 0, skipped: 0, errors: [] },
    events: { patched: 0, skipped: 0, errors: [] },
    wellness: { patched: 0, skipped: 0, errors: [] },
  };

  const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
  if (internalCalendarId) {
    const closuresResult = await db.execute(sql`
      SELECT id, title, reason, notes, notice_type, start_date, start_time, end_date, end_time,
             affected_areas, notify_members, internal_calendar_id
      FROM facility_closures
      WHERE internal_calendar_id IS NOT NULL AND is_active = true
    `);
    
    interface ClosureBackfillRow {
      id: number; title: string; reason: string | null; notes: string | null;
      notice_type: string | null; start_date: string; start_time: string | null;
      end_date: string; end_time: string | null; affected_areas: string | null;
      notify_members: boolean; internal_calendar_id: string;
    }
    
    for (const row of closuresResult.rows as unknown as ClosureBackfillRow[]) {
      const eventIds = row.internal_calendar_id.split(',').filter(Boolean);
      for (const eventId of eventIds) {
        try {
          const gcEvent = await withCalendarRetry(() => calendar.events.get({
            calendarId: internalCalendarId,
            eventId: eventId.trim(),
          }), `backfill-closure-get-${row.id}`);
          
          const existingProps = gcEvent.data.extendedProperties?.shared || {};
          const closureOptionalKeys = ['ehApp_affectedAreas', 'ehApp_notifyMembers', 'ehApp_notes'];
          const extendedProps: Record<string, string> = {
            'ehApp_type': 'closure',
            'ehApp_id': String(row.id),
          };
          if (row.affected_areas) extendedProps['ehApp_affectedAreas'] = row.affected_areas;
          extendedProps['ehApp_notifyMembers'] = row.notify_members ? 'true' : 'false';
          if (row.notes) extendedProps['ehApp_notes'] = row.notes;
          
          if (!propsNeedUpdate(existingProps, extendedProps, closureOptionalKeys)) {
            result.closures.skipped++;
            continue;
          }
          
          await withCalendarRetry(() => calendar.events.patch({
            calendarId: internalCalendarId,
            eventId: eventId.trim(),
            requestBody: {
              extendedProperties: { shared: buildPatchProps(existingProps, extendedProps, closureOptionalKeys) },
            },
          }), `backfill-closure-patch-${row.id}`);
          
          result.closures.patched++;
        } catch (err: unknown) {
          result.closures.errors.push(`Closure #${row.id} event ${eventId}: ${getErrorMessage(err)}`);
        }
      }
    }
  }

  const eventsCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
  if (eventsCalendarId) {
    const eventsResult = await db.execute(sql`
      SELECT id, title, description, event_date, start_time, end_time, location, category,
             image_url, external_url, max_attendees, visibility, requires_rsvp, google_calendar_id
      FROM events
      WHERE google_calendar_id IS NOT NULL AND archived_at IS NULL
    `);
    
    interface EventBackfillRow {
      id: number; title: string; description: string | null; event_date: string;
      start_time: string; end_time: string | null; location: string | null;
      category: string | null; image_url: string | null; external_url: string | null;
      max_attendees: number | null; visibility: string | null; requires_rsvp: boolean | null;
      google_calendar_id: string;
    }
    
    for (const row of eventsResult.rows as unknown as EventBackfillRow[]) {
      try {
        const gcEvent = await withCalendarRetry(() => calendar.events.get({
          calendarId: eventsCalendarId,
          eventId: row.google_calendar_id,
        }), `backfill-event-get-${row.id}`);
        
        const existingProps = gcEvent.data.extendedProperties?.shared || {};
        const eventOptionalKeys = ['ehApp_imageUrl', 'ehApp_externalUrl', 'ehApp_category', 'ehApp_maxAttendees', 'ehApp_visibility', 'ehApp_requiresRsvp', 'ehApp_location'];
        const extendedProps: Record<string, string> = {
          'ehApp_type': 'event',
          'ehApp_id': String(row.id),
        };
        if (row.image_url) extendedProps['ehApp_imageUrl'] = row.image_url;
        if (row.external_url) extendedProps['ehApp_externalUrl'] = row.external_url;
        if (row.category) extendedProps['ehApp_category'] = row.category;
        if (row.max_attendees) extendedProps['ehApp_maxAttendees'] = String(row.max_attendees);
        if (row.visibility) extendedProps['ehApp_visibility'] = row.visibility;
        if (row.requires_rsvp !== null) extendedProps['ehApp_requiresRsvp'] = String(row.requires_rsvp);
        if (row.location) extendedProps['ehApp_location'] = row.location;
        
        if (!propsNeedUpdate(existingProps, extendedProps, eventOptionalKeys)) {
          result.events.skipped++;
          continue;
        }
        
        await withCalendarRetry(() => calendar.events.patch({
          calendarId: eventsCalendarId,
          eventId: row.google_calendar_id,
          requestBody: {
            extendedProperties: { shared: buildPatchProps(existingProps, extendedProps, eventOptionalKeys) },
          },
        }), `backfill-event-patch-${row.id}`);
        
        result.events.patched++;
      } catch (err: unknown) {
        result.events.errors.push(`Event #${row.id}: ${getErrorMessage(err)}`);
      }
    }
  }

  const wellnessCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
  if (wellnessCalendarId) {
    const wellnessResult = await db.execute(sql`
      SELECT id, title, time, instructor, duration, category, spots, status, description,
             date, image_url, external_url, google_calendar_id
      FROM wellness_classes
      WHERE google_calendar_id IS NOT NULL AND is_active = true
    `);
    
    interface WellnessBackfillRow {
      id: number; title: string; time: string; instructor: string; duration: string;
      category: string | null; spots: string | null; status: string | null;
      description: string | null; date: string; image_url: string | null;
      external_url: string | null; google_calendar_id: string;
    }
    
    for (const row of wellnessResult.rows as unknown as WellnessBackfillRow[]) {
      try {
        const gcEvent = await withCalendarRetry(() => calendar.events.get({
          calendarId: wellnessCalendarId,
          eventId: row.google_calendar_id,
        }), `backfill-wellness-get-${row.id}`);
        
        const existingProps = gcEvent.data.extendedProperties?.shared || {};
        const wellnessOptionalKeys = ['ehApp_category', 'ehApp_duration', 'ehApp_spots', 'ehApp_status', 'ehApp_imageUrl', 'ehApp_externalUrl'];
        const extendedProps: Record<string, string> = {
          'ehApp_type': 'wellness',
          'ehApp_id': String(row.id),
        };
        if (row.category) extendedProps['ehApp_category'] = row.category;
        if (row.duration) extendedProps['ehApp_duration'] = row.duration;
        if (row.spots) extendedProps['ehApp_spots'] = row.spots;
        if (row.status) extendedProps['ehApp_status'] = row.status;
        if (row.image_url) extendedProps['ehApp_imageUrl'] = row.image_url;
        if (row.external_url) extendedProps['ehApp_externalUrl'] = row.external_url;
        
        if (!propsNeedUpdate(existingProps, extendedProps, wellnessOptionalKeys)) {
          result.wellness.skipped++;
          continue;
        }
        
        await withCalendarRetry(() => calendar.events.patch({
          calendarId: wellnessCalendarId,
          eventId: row.google_calendar_id,
          requestBody: {
            extendedProperties: { shared: buildPatchProps(existingProps, extendedProps, wellnessOptionalKeys) },
          },
        }), `backfill-wellness-patch-${row.id}`);
        
        result.wellness.patched++;
      } catch (err: unknown) {
        result.wellness.errors.push(`Wellness #${row.id}: ${getErrorMessage(err)}`);
      }
    }
  }
  
  return result;
}
