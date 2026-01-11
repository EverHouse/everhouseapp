import { pool } from '../../db';
import { getGoogleCalendarClient } from '../../integrations';
import { CALENDAR_CONFIG } from '../config';
import { getCalendarIdByName } from '../cache';

export function parseClosureMetadata(description: string): { affectedAreas?: string; notifyMembers?: boolean } {
  const result: { affectedAreas?: string; notifyMembers?: boolean } = {};
  
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
  
  return result;
}

export function formatClosureMetadata(affectedAreas: string, notifyMembers: boolean): string {
  const affectedDisplay: Record<string, string> = {
    'none': 'None',
    'all_bays': 'All Bays',
    'conference_room': 'Conference Room',
    'entire_facility': 'Entire Facility'
  };
  
  return `\n---\n[Affected: ${affectedDisplay[affectedAreas] || 'None'}]\n[Members Notified: ${notifyMembers ? 'Yes' : 'No'}]`;
}

export function updateDescriptionWithMetadata(originalDescription: string, affectedAreas: string, notifyMembers: boolean): string {
  const baseDescription = (originalDescription || '').replace(/\n---\n\[Affected:.*?\]\n\[Members Notified:.*?\]/s, '').trim();
  return baseDescription + formatClosureMetadata(affectedAreas, notifyMembers);
}

export function getBaseDescription(description: string): string {
  if (!description) return '';
  return description.replace(/\n---\n\[Affected:.*?\]\n\[Members Notified:.*?\]/s, '').trim();
}

async function getAllResourceIds(): Promise<number[]> {
  const idSet = new Set<number>();
  const resourcesResult = await pool.query('SELECT id FROM resources');
  resourcesResult.rows.forEach((r: any) => idSet.add(r.id));
  return Array.from(idSet);
}

async function getResourceIdsForAffectedAreas(affectedAreas: string): Promise<number[]> {
  const idSet = new Set<number>();
  
  const normalized = affectedAreas.toLowerCase().trim();
  
  if (normalized === 'none' || normalized === '') {
    return [];
  }
  
  if (normalized === 'entire_facility') {
    return getAllResourceIds();
  }
  
  if (normalized === 'all_bays') {
    const simulatorsResult = await pool.query("SELECT id FROM resources WHERE type = 'simulator'");
    simulatorsResult.rows.forEach((r: any) => idSet.add(r.id));
    return Array.from(idSet);
  }
  
  if (normalized === 'conference_room' || normalized === 'conference room') {
    const confResult = await pool.query("SELECT id FROM resources WHERE LOWER(name) LIKE '%conference%' LIMIT 1");
    if (confResult.rows.length > 0) {
      idSet.add(confResult.rows[0].id);
    }
    return Array.from(idSet);
  }
  
  const processToken = async (token: string): Promise<void> => {
    const t = token.toLowerCase().trim();
    if (t === 'entire_facility') {
      const all = await getAllResourceIds();
      all.forEach(id => idSet.add(id));
    } else if (t === 'all_bays') {
      const simulatorsResult = await pool.query("SELECT id FROM resources WHERE type = 'simulator'");
      simulatorsResult.rows.forEach((r: any) => idSet.add(r.id));
    } else if (t === 'conference_room' || t === 'conference room') {
      const confResult = await pool.query("SELECT id FROM resources WHERE LOWER(name) LIKE '%conference%' LIMIT 1");
      if (confResult.rows.length > 0) idSet.add(confResult.rows[0].id);
    } else if (t.startsWith('bay_')) {
      const bayId = parseInt(t.replace('bay_', ''));
      if (!isNaN(bayId)) idSet.add(bayId);
    }
  };
  
  if (normalized.startsWith('bay_') && !normalized.includes(',') && !normalized.includes('[')) {
    const bayId = parseInt(normalized.replace('bay_', ''));
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
  } catch {
  }
  
  const parts = affectedAreas.split(',').map(s => s.trim());
  for (const part of parts) {
    await processToken(part);
  }
  
  if (idSet.size === 0) {
    console.warn(`[getResourceIdsForAffectedAreas] Could not resolve resources for "${affectedAreas}", falling back to entire_facility`);
    return getAllResourceIds();
  }
  
  return Array.from(idSet);
}

function getDatesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = new Date(start + 'T12:00:00');
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
  
  const validResourcesResult = await pool.query(
    'SELECT id FROM resources WHERE id = ANY($1)',
    [resourceIds]
  );
  const validResourceIds = new Set(validResourcesResult.rows.map((r: any) => r.id));
  const filteredIds = resourceIds.filter(id => validResourceIds.has(id));
  
  if (filteredIds.length < resourceIds.length) {
    const skippedIds = resourceIds.filter(id => !validResourceIds.has(id));
    console.log(`[Calendar Sync] Skipping non-existent resource IDs: ${skippedIds.join(', ')}`);
  }
  
  for (const resId of filteredIds) {
    for (const date of dates) {
      await pool.query(
        `INSERT INTO availability_blocks (resource_id, block_date, start_time, end_time, block_type, notes, created_by, closure_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [resId, date, blockStartTime, blockEndTime, 'blocked', notes, 'system', closureId]
      );
      blocksCreated++;
    }
  }
  return blocksCreated;
}

async function deleteAvailabilityBlocks(closureId: number): Promise<void> {
  await pool.query('DELETE FROM availability_blocks WHERE closure_id = $1', [closureId]);
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
  await pool.query(
    `INSERT INTO notice_types (name, is_preset, sort_order) VALUES ($1, false, 100) ON CONFLICT (name) DO NOTHING`,
    [normalized]
  );
}

export async function syncInternalCalendarToClosures(): Promise<{ synced: number; created: number; updated: number; deleted: number; error?: string }> {
  try {
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, deleted: 0, error: `Calendar "${CALENDAR_CONFIG.internal.name}" not found` };
    }
    
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    
    const response = await calendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const events = response.data.items || [];
    const fetchedEventIds = new Set<string>();
    let created = 0;
    let updated = 0;
    
    for (const event of events) {
      if (!event.id || !event.summary) continue;
      
      fetchedEventIds.add(event.id);
      const internalCalendarId = event.id;
      const rawTitle = event.summary;
      const { noticeType, cleanTitle } = extractNoticeTypeFromTitle(rawTitle);
      const title = cleanTitle;
      const rawDescription = event.description || '';
      const reason = getBaseDescription(rawDescription) || 'Internal calendar event';
      
      if (noticeType) {
        await ensureNoticeTypeExists(noticeType);
      }
      
      const metadata = parseClosureMetadata(rawDescription);
      
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
      
      const existing = await pool.query(
        'SELECT id, start_date, end_date, start_time, end_time, affected_areas FROM facility_closures WHERE internal_calendar_id = $1',
        [internalCalendarId]
      );
      
      if (existing.rows.length > 0) {
        const existingClosure = existing.rows[0];
        const closureId = existingClosure.id;
        
        const preservedAffectedAreas = existingClosure.affected_areas || 'entire_facility';
        
        const datesChanged = 
          existingClosure.start_date !== startDate || 
          existingClosure.end_date !== endDate ||
          existingClosure.start_time !== startTime ||
          existingClosure.end_time !== endTime;
        
        await pool.query(
          `UPDATE facility_closures SET 
           title = $1, reason = $2, start_date = $3, start_time = $4,
           end_date = $5, end_time = $6, notice_type = $7, is_active = true
           WHERE internal_calendar_id = $8`,
          [title, reason, startDate, startTime, endDate, endTime, noticeType, internalCalendarId]
        );
        
        if (datesChanged) {
          await deleteAvailabilityBlocks(closureId);
          if (preservedAffectedAreas !== 'none') {
            const resourceIds = await getResourceIdsForAffectedAreas(preservedAffectedAreas);
            const dates = getDatesBetween(startDate, endDate);
            const blockStartTime = startTime || '08:00:00';
            const blockEndTime = endTime || '22:00:00';
            await createAvailabilityBlocks(closureId, resourceIds, dates, blockStartTime, blockEndTime, reason);
            console.log(`[Calendar Sync] Updated availability blocks for closure #${closureId}: ${title}`);
          } else {
            console.log(`[Calendar Sync] Updated closure #${closureId}: ${title} (no availability blocks - affected_areas='none')`);
          }
        }
        
        updated++;
      } else {
        const affectedAreas = metadata.affectedAreas || 'none';
        const visibility = metadata.visibility || null;
        const needsReview = !noticeType || affectedAreas === 'none' || !visibility;
        
        const result = await pool.query(
          `INSERT INTO facility_closures 
           (title, reason, notice_type, start_date, start_time, end_date, end_time, affected_areas, is_active, created_by, internal_calendar_id, needs_review)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'system', $9, $10)
           RETURNING id`,
          [title, reason, noticeType, startDate, startTime, endDate, endTime, affectedAreas, internalCalendarId, needsReview]
        );
        
        const closureId = result.rows[0].id;
        
        if (affectedAreas !== 'none') {
          const resourceIds = await getResourceIdsForAffectedAreas(affectedAreas);
          const dates = getDatesBetween(startDate, endDate);
          const blockStartTime = startTime || '08:00:00';
          const blockEndTime = endTime || '22:00:00';
          const blocksCreated = await createAvailabilityBlocks(closureId, resourceIds, dates, blockStartTime, blockEndTime, reason);
          console.log(`[Calendar Sync] Created ${blocksCreated} availability blocks for closure #${closureId}: ${title}`);
        } else {
          console.log(`[Calendar Sync] Created closure #${closureId}: ${title} (no availability blocks - affected_areas='none')`);
        }
        
        created++;
      }
    }
    
    const existingClosures = await pool.query(
      'SELECT id, internal_calendar_id FROM facility_closures WHERE internal_calendar_id IS NOT NULL'
    );
    
    let deleted = 0;
    for (const closure of existingClosures.rows) {
      if (!fetchedEventIds.has(closure.internal_calendar_id)) {
        await deleteAvailabilityBlocks(closure.id);
        await pool.query('UPDATE facility_closures SET is_active = false WHERE id = $1', [closure.id]);
        console.log(`[Calendar Sync] Deactivated closure #${closure.id} and removed availability blocks`);
        deleted++;
      }
    }
    
    return { synced: events.length, created, updated, deleted };
  } catch (error) {
    console.error('Error syncing Internal Calendar to closures:', error);
    return { synced: 0, created: 0, updated: 0, deleted: 0, error: 'Failed to sync closures' };
  }
}
