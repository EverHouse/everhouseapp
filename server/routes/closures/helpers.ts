import { logger } from '../../core/logger';
import { db } from '../../db';
import { facilityClosures, pushSubscriptions, users, availabilityBlocks, resources } from '../../../shared/schema';
import { eq, or, isNull } from 'drizzle-orm';
import webpush from 'web-push';
import { getCalendarIdByName, deleteCalendarEvent, CALENDAR_CONFIG } from '../../core/calendar/index';
import { getGoogleCalendarClient } from '../../core/integrations';
import { createPacificDate, addDaysToPacificDate, getPacificISOString } from '../../utils/dateUtils';
import { getErrorMessage, getErrorStatusCode } from '../../utils/errorUtils';

const PUSH_ICON = '/icon-192.png';
const PUSH_BADGE = '/badge-72.png';

export async function sendPushNotificationToAllMembers(payload: { title: string; body: string; url?: string; tag?: string; icon?: string; badge?: string }) {
  try {
    const subscriptions = await db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth
      })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userEmail, users.email))
      .where(or(eq(users.role, 'member'), isNull(users.role)));
    
    const notifications = subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };
      
      const enrichedPayload = { ...payload, icon: payload.icon || PUSH_ICON, badge: payload.badge || PUSH_BADGE };
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(enrichedPayload));
      } catch (err: unknown) {
        if (getErrorStatusCode(err) === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        }
      }
    });
    
    await Promise.all(notifications);
    logger.info('[Push] Sent notification to members', { extra: { subscriptionsLength: subscriptions.length } });
  } catch (error: unknown) {
    logger.error('Failed to send push notification to members', { error: error instanceof Error ? error : new Error(String(error)) });
  }
}

async function getConferenceRoomId(): Promise<number | null> {
  const result = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.type, 'conference_room'))
    .limit(1);
  return result.length > 0 ? result[0].id : null;
}

export async function getAffectedBayIds(affectedAreas: string | null | undefined): Promise<number[]> {
  if (!affectedAreas) return [];
  const idSet = new Set<number>();
  
  if (affectedAreas === 'entire_facility') {
    const allResources = await db.select({ id: resources.id }).from(resources);
    allResources.forEach(r => idSet.add(r.id));
    return Array.from(idSet);
  }
  
  if (affectedAreas === 'all_bays') {
    const simulatorResources = await db
      .select({ id: resources.id })
      .from(resources)
      .where(eq(resources.type, 'simulator'));
    simulatorResources.forEach(r => idSet.add(r.id));
    return Array.from(idSet);
  }
  
  if (affectedAreas === 'conference_room' || affectedAreas === 'Conference Room') {
    const conferenceRoomId = await getConferenceRoomId();
    return conferenceRoomId ? [conferenceRoomId] : [];
  }
  
  if (affectedAreas === 'none' || affectedAreas === 'None' || affectedAreas === '') {
    return [];
  }
  
  if (affectedAreas.startsWith('bay_') && !affectedAreas.includes(',') && !affectedAreas.includes('[')) {
    const bayId = parseInt(affectedAreas.replace('bay_', ''), 10);
    if (!isNaN(bayId)) {
      return [bayId];
    }
  }
  
  const conferenceRoomId = await getConferenceRoomId();
  
  try {
    const parsed = JSON.parse(affectedAreas);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'number') {
          idSet.add(item);
        } else if (typeof item === 'string') {
          if (item.startsWith('bay_')) {
            const bayId = parseInt(item.replace('bay_', ''), 10);
            if (!isNaN(bayId)) idSet.add(bayId);
          } else if (item === 'conference_room' || item.toLowerCase() === 'conference room') {
            if (conferenceRoomId) idSet.add(conferenceRoomId);
          } else {
            const bayId = parseInt(item, 10);
            if (!isNaN(bayId)) idSet.add(bayId);
          }
        }
      }
      if (idSet.size > 0) return Array.from(idSet);
    }
  } catch (parseError: unknown) {
    logger.warn('[getAffectedBayIds] Failed to parse JSON affectedAreas', { extra: { affectedAreas, parseError } });
  }
  
  const parts = affectedAreas.split(',').map(s => s.trim());
  
  for (const part of parts) {
    if (part.startsWith('bay_')) {
      const bayId = parseInt(part.replace('bay_', ''), 10);
      if (!isNaN(bayId)) {
        idSet.add(bayId);
      }
    } else if (part === 'conference_room' || part.toLowerCase() === 'conference room') {
      if (conferenceRoomId) idSet.add(conferenceRoomId);
    } else if (part.match(/^Bay\s*(\d+)$/i)) {
      const match = part.match(/^Bay\s*(\d+)$/i);
      if (match) {
        idSet.add(parseInt(match[1], 10));
      }
    } else if (part.match(/^Simulator\s*Bay\s*(\d+)$/i)) {
      const match = part.match(/^Simulator\s*Bay\s*(\d+)$/i);
      if (match) {
        idSet.add(parseInt(match[1], 10));
      }
    } else {
      const parsed = parseInt(part, 10);
      if (!isNaN(parsed)) {
        idSet.add(parsed);
      }
    }
  }
  
  return Array.from(idSet);
}

export function getDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = startDate;
  
  while (current <= endDate) {
    dates.push(current);
    current = addDaysToPacificDate(current, 1);
  }
  
  return dates;
}

async function formatSingleAreaFromDb(area: string): Promise<string> {
  const trimmed = area.trim();
  if (trimmed === 'entire_facility') return 'Entire Facility';
  if (trimmed === 'all_bays') return 'All Simulator Bays';
  if (trimmed === 'conference_room' || trimmed === 'Conference Room') return 'Conference Room';
  if (trimmed === 'none') return '';

  if (trimmed.startsWith('bay_')) {
    const bayId = parseInt(trimmed.replace('bay_', ''), 10);
    if (!isNaN(bayId)) {
      const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, bayId));
      return resource ? resource.name : `Simulator Bay ${bayId}`;
    }
  }

  return trimmed;
}

export async function _formatAffectedAreasForDisplay(affectedAreas: string | null | undefined): Promise<string> {
  if (!affectedAreas) return 'No booking restrictions';
  const trimmed = affectedAreas.trim();
  if (trimmed === 'none') return 'No booking restrictions';

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const formatted = await Promise.all(parsed.map((a: string) => formatSingleAreaFromDb(String(a))));
        const filtered = formatted.filter(a => a);
        if (filtered.length > 0) return filtered.join(', ');
      }
    } catch { /* intentionally swallowed: fall through to comma-separated parsing */ }
  }

  const parts = trimmed.includes(',') ? trimmed.split(',') : [trimmed];
  const formatted = await Promise.all(parts.map(formatSingleAreaFromDb));
  const filtered = formatted.filter(a => a);
  return filtered.length > 0 ? filtered.join(', ') : affectedAreas;
}

export async function createAvailabilityBlocksForClosure(
  closureId: number,
  bayIds: number[],
  dates: string[],
  startTime: string | null,
  endTime: string | null,
  reason: string | null,
  createdBy: string | null
): Promise<void> {
  const blockStartTime = startTime || '08:00:00';
  const blockEndTime = endTime || '22:00:00';
  
  const insertValues = [];
  for (const resourceId of bayIds) {
    for (const date of dates) {
      insertValues.push({
        resourceId,
        blockDate: date,
        startTime: blockStartTime,
        endTime: blockEndTime,
        blockType: 'blocked',
        notes: reason || 'Facility closure',
        createdBy,
        closureId
      });
    }
  }
  
  if (insertValues.length > 0) {
    await db.insert(availabilityBlocks).values(insertValues).onConflictDoNothing();
    logger.info('[Closures] Created availability blocks for closure #', { extra: { insertValuesLength: insertValues.length, closureId } });
  }
}

export async function deleteAvailabilityBlocksForClosure(closureId: number): Promise<void> {
  await db
    .delete(availabilityBlocks)
    .where(eq(availabilityBlocks.closureId, closureId));
  
  logger.info('[Closures] Deleted availability blocks for closure #', { extra: { closureId } });
}

export async function createClosureCalendarEvents(
  calendarId: string,
  title: string,
  description: string,
  startDate: string,
  endDate: string,
  startTime: string | null,
  endTime: string | null,
  extendedProps?: Record<string, string>
): Promise<string | null> {
  try {
    const calendar = await getGoogleCalendarClient();
    
    const _isSameDay = startDate === endDate;
    const hasSpecificTimes = startTime && endTime;
    
    if (hasSpecificTimes) {
      const dates = getDatesBetween(startDate, endDate);
      const eventIds: string[] = [];
      
      for (const date of dates) {
        const event: Record<string, unknown> = {
          summary: title,
          description: `${description}${dates.length > 1 ? `\n\n(Day ${dates.indexOf(date) + 1} of ${dates.length})` : ''}`,
          start: {
            dateTime: getPacificISOString(date, startTime),
            timeZone: 'America/Los_Angeles',
          },
          end: {
            dateTime: getPacificISOString(date, endTime),
            timeZone: 'America/Los_Angeles',
          },
        };
        
        if (extendedProps && Object.keys(extendedProps).length > 0) {
          event.extendedProperties = { shared: extendedProps };
        }
        
        const response = await calendar.events.insert({
          calendarId,
          requestBody: event,
        });
        
        if (response.data.id) {
          eventIds.push(response.data.id);
        }
      }
      
      return eventIds.join(',');
    } else {
      const endDatePlusOne = addDaysToPacificDate(endDate, 1);
      
      const event: Record<string, unknown> = {
        summary: title,
        description,
        start: {
          date: startDate,
        },
        end: {
          date: endDatePlusOne,
        },
      };
      
      if (extendedProps && Object.keys(extendedProps).length > 0) {
        event.extendedProperties = { shared: extendedProps };
      }
      
      const response = await calendar.events.insert({
        calendarId,
        requestBody: event,
      });
      
      return response.data.id || null;
    }
  } catch (error: unknown) {
    logger.error('Error creating closure calendar event', { error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

export async function deleteClosureCalendarEvents(calendarId: string, eventIds: string): Promise<void> {
  const ids = eventIds.split(',').filter(id => id.trim());
  
  for (const eventId of ids) {
    try {
      await deleteCalendarEvent(eventId.trim(), calendarId);
    } catch (error: unknown) {
      logger.error('Failed to delete calendar event', { error: error instanceof Error ? error : new Error(String(error)), extra: { eventId } });
    }
  }
}

export async function patchClosureCalendarEvents(
  calendarId: string,
  eventIds: string,
  title: string,
  description: string,
  startDate: string,
  endDate: string,
  startTime: string | null,
  endTime: string | null,
  extendedProps?: Record<string, string>
): Promise<boolean> {
  const calendar = await getGoogleCalendarClient();
  const ids = eventIds.split(',').filter(id => id.trim());
  const hasSpecificTimes = startTime && endTime;
  const dates = getDatesBetween(startDate, endDate || startDate);
  
  for (let i = 0; i < ids.length; i++) {
    const eventId = ids[i].trim();
    const eventDate = dates[i] || dates[dates.length - 1];
    
    const requestBody: Record<string, unknown> = {
      summary: title,
      description: ids.length > 1
        ? `${description}\n\n(Day ${i + 1} of ${ids.length})`
        : description,
    };
    
    if (extendedProps && Object.keys(extendedProps).length > 0) {
      requestBody.extendedProperties = { shared: extendedProps };
    }
    
    if (hasSpecificTimes) {
      requestBody.start = {
        dateTime: getPacificISOString(eventDate, startTime),
        timeZone: 'America/Los_Angeles',
      };
      requestBody.end = {
        dateTime: getPacificISOString(eventDate, endTime),
        timeZone: 'America/Los_Angeles',
      };
    } else {
      requestBody.start = { date: eventDate };
      requestBody.end = { date: addDaysToPacificDate(eventDate, 1) };
    }
    
    try {
      await calendar.events.patch({ calendarId, eventId, requestBody });
    } catch (error: unknown) {
      logger.warn(`[Closures] Failed to patch calendar event ${eventId}, will fall back to create`, { error: error instanceof Error ? error.message : error });
      return false;
    }
  }
  return true;
}
