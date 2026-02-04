import { Router } from 'express';
import { isProduction } from '../core/db';
import { db } from '../db';
import { facilityClosures, pushSubscriptions, users, availabilityBlocks, announcements, notifications, resources, noticeTypes, closureReasons } from '../../shared/schema';
import { eq, desc, or, isNull, inArray, and } from 'drizzle-orm';
import webpush from 'web-push';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { getCalendarIdByName, deleteCalendarEvent, CALENDAR_CONFIG, syncInternalCalendarToClosures, updateDescriptionWithMetadata, formatClosureMetadata, getBaseDescription } from '../core/calendar/index';
import { getGoogleCalendarClient } from '../core/integrations';
import { createPacificDate, parseLocalDate, addDaysToPacificDate, getPacificISOString, getTodayPacific } from '../utils/dateUtils';
import { clearClosureCache } from '../core/bookingValidation';
import { broadcastClosureUpdate } from '../core/websocket';
import { logFromRequest } from '../core/auditLog';

const router = Router();

export async function sendPushNotificationToAllMembers(payload: { title: string; body: string; url?: string }) {
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
      
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
      } catch (err: any) {
        if (err.statusCode === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        }
      }
    });
    
    await Promise.all(notifications);
    console.log(`[Push] Sent notification to ${subscriptions.length} members`);
  } catch (error) {
    console.error('Failed to send push notification to members:', error);
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

async function getAffectedBayIds(affectedAreas: string): Promise<number[]> {
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
  
  if (affectedAreas.startsWith('bay_') && !affectedAreas.includes(',') && !affectedAreas.includes('[')) {
    const bayId = parseInt(affectedAreas.replace('bay_', ''));
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
            const bayId = parseInt(item.replace('bay_', ''));
            if (!isNaN(bayId)) idSet.add(bayId);
          } else if (item === 'conference_room' || item.toLowerCase() === 'conference room') {
            if (conferenceRoomId) idSet.add(conferenceRoomId);
          } else {
            const bayId = parseInt(item);
            if (!isNaN(bayId)) idSet.add(bayId);
          }
        }
      }
      if (idSet.size > 0) return Array.from(idSet);
    }
  } catch (parseError) {
    console.warn('[getAffectedBayIds] Failed to parse JSON affectedAreas:', affectedAreas, parseError);
  }
  
  const parts = affectedAreas.split(',').map(s => s.trim());
  
  for (const part of parts) {
    if (part.startsWith('bay_')) {
      const bayId = parseInt(part.replace('bay_', ''));
      if (!isNaN(bayId)) {
        idSet.add(bayId);
      }
    } else if (part === 'conference_room' || part.toLowerCase() === 'conference room') {
      if (conferenceRoomId) idSet.add(conferenceRoomId);
    } else if (part.match(/^Bay\s*(\d+)$/i)) {
      const match = part.match(/^Bay\s*(\d+)$/i);
      if (match) {
        idSet.add(parseInt(match[1]));
      }
    } else if (part.match(/^Simulator\s*Bay\s*(\d+)$/i)) {
      const match = part.match(/^Simulator\s*Bay\s*(\d+)$/i);
      if (match) {
        idSet.add(parseInt(match[1]));
      }
    } else {
      const parsed = parseInt(part);
      if (!isNaN(parsed)) {
        idSet.add(parsed);
      }
    }
  }
  
  return Array.from(idSet);
}

function getDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = startDate;
  
  while (current <= endDate) {
    dates.push(current);
    current = addDaysToPacificDate(current, 1);
  }
  
  return dates;
}

async function formatAffectedAreasForDisplay(affectedAreas: string): Promise<string> {
  if (affectedAreas === 'entire_facility') return 'Entire Facility';
  if (affectedAreas === 'all_bays') return 'All Simulator Bays';
  if (affectedAreas === 'conference_room') return 'Conference Room';
  
  if (affectedAreas.startsWith('bay_')) {
    const bayId = parseInt(affectedAreas.replace('bay_', ''));
    if (!isNaN(bayId)) {
      const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, bayId));
      return resource ? resource.name : affectedAreas;
    }
  }
  
  return affectedAreas;
}

async function createAvailabilityBlocksForClosure(
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
    await db.insert(availabilityBlocks).values(insertValues);
    console.log(`[Closures] Created ${insertValues.length} availability blocks for closure #${closureId}`);
  }
}

async function deleteAvailabilityBlocksForClosure(closureId: number): Promise<void> {
  await db
    .delete(availabilityBlocks)
    .where(eq(availabilityBlocks.closureId, closureId));
  
  console.log(`[Closures] Deleted availability blocks for closure #${closureId}`);
}

async function createClosureCalendarEvents(
  calendarId: string,
  title: string,
  description: string,
  startDate: string,
  endDate: string,
  startTime: string | null,
  endTime: string | null
): Promise<string | null> {
  try {
    const calendar = await getGoogleCalendarClient();
    
    const isSameDay = startDate === endDate;
    const hasSpecificTimes = startTime && endTime;
    
    if (hasSpecificTimes) {
      const dates = getDatesBetween(startDate, endDate);
      const eventIds: string[] = [];
      
      for (const date of dates) {
        const event = {
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
      
      const event = {
        summary: title,
        description,
        start: {
          date: startDate,
        },
        end: {
          date: endDatePlusOne,
        },
      };
      
      const response = await calendar.events.insert({
        calendarId,
        requestBody: event,
      });
      
      return response.data.id || null;
    }
  } catch (error) {
    console.error('Error creating closure calendar event:', error);
    return null;
  }
}

async function deleteClosureCalendarEvents(calendarId: string, eventIds: string): Promise<void> {
  const ids = eventIds.split(',').filter(id => id.trim());
  
  for (const eventId of ids) {
    try {
      await deleteCalendarEvent(eventId.trim(), calendarId);
    } catch (error) {
      console.error(`Failed to delete calendar event ${eventId}:`, error);
    }
  }
}

// Notice Types endpoints
router.get('/api/notice-types', async (req, res) => {
  try {
    const results = await db
      .select()
      .from(noticeTypes)
      .orderBy(noticeTypes.sortOrder, noticeTypes.name);
    res.json(results);
  } catch (error: any) {
    if (!isProduction) console.error('Notice types fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch notice types' });
  }
});

router.post('/api/notice-types', isStaffOrAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    const [result] = await db
      .insert(noticeTypes)
      .values({ name, isPreset: false, sortOrder: 100 })
      .onConflictDoNothing()
      .returning();
    
    if (!result) {
      const [existing] = await db
        .select()
        .from(noticeTypes)
        .where(eq(noticeTypes.name, name));
      return res.json(existing);
    }
    
    res.status(201).json(result);
  } catch (error: any) {
    if (!isProduction) console.error('Notice type creation error:', error);
    res.status(500).json({ error: 'Failed to create notice type' });
  }
});

router.put('/api/notice-types/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, sort_order } = req.body;
    
    const [existing] = await db
      .select()
      .from(noticeTypes)
      .where(eq(noticeTypes.id, parseInt(id)));
    
    if (!existing) {
      return res.status(404).json({ error: 'Notice type not found' });
    }
    
    if (existing.isPreset) {
      return res.status(403).json({ error: 'Cannot edit preset notice types' });
    }
    
    const updateData: Record<string, any> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (sort_order !== undefined) updateData.sortOrder = sort_order;
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    const [result] = await db
      .update(noticeTypes)
      .set(updateData)
      .where(eq(noticeTypes.id, parseInt(id)))
      .returning();
    
    res.json(result);
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A notice type with this name already exists' });
    }
    if (!isProduction) console.error('Notice type update error:', error);
    res.status(500).json({ error: 'Failed to update notice type' });
  }
});

router.delete('/api/notice-types/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [existing] = await db
      .select()
      .from(noticeTypes)
      .where(eq(noticeTypes.id, parseInt(id)));
    
    if (!existing) {
      return res.status(404).json({ error: 'Notice type not found' });
    }
    
    if (existing.isPreset) {
      return res.status(403).json({ error: 'Cannot delete preset notice types' });
    }
    
    await db
      .delete(noticeTypes)
      .where(eq(noticeTypes.id, parseInt(id)));
    
    res.json({ success: true, message: 'Notice type deleted' });
  } catch (error: any) {
    if (!isProduction) console.error('Notice type delete error:', error);
    res.status(500).json({ error: 'Failed to delete notice type' });
  }
});

// Closure Reasons endpoints
router.get('/api/closure-reasons', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const query = db
      .select()
      .from(closureReasons)
      .orderBy(closureReasons.sortOrder, closureReasons.label);
    
    const results = includeInactive
      ? await query
      : await db
          .select()
          .from(closureReasons)
          .where(eq(closureReasons.isActive, true))
          .orderBy(closureReasons.sortOrder, closureReasons.label);
    
    res.json(results);
  } catch (error: any) {
    if (!isProduction) console.error('Closure reasons fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch closure reasons' });
  }
});

router.post('/api/closure-reasons', isStaffOrAdmin, async (req, res) => {
  try {
    const { label, sort_order } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'Label is required' });
    }
    
    const [result] = await db
      .insert(closureReasons)
      .values({ 
        label: label.trim(), 
        sortOrder: sort_order ?? 100,
        isActive: true 
      })
      .returning();
    
    res.status(201).json(result);
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A closure reason with this label already exists' });
    }
    if (!isProduction) console.error('Closure reason creation error:', error);
    res.status(500).json({ error: 'Failed to create closure reason' });
  }
});

router.put('/api/closure-reasons/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { label, sort_order, is_active } = req.body;
    
    const updateData: Record<string, any> = {};
    if (label !== undefined) updateData.label = label.trim();
    if (sort_order !== undefined) updateData.sortOrder = sort_order;
    if (is_active !== undefined) updateData.isActive = is_active;
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    const [result] = await db
      .update(closureReasons)
      .set(updateData)
      .where(eq(closureReasons.id, parseInt(id)))
      .returning();
    
    if (!result) {
      return res.status(404).json({ error: 'Closure reason not found' });
    }
    
    res.json(result);
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A closure reason with this label already exists' });
    }
    if (!isProduction) console.error('Closure reason update error:', error);
    res.status(500).json({ error: 'Failed to update closure reason' });
  }
});

router.delete('/api/closure-reasons/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [result] = await db
      .update(closureReasons)
      .set({ isActive: false })
      .where(eq(closureReasons.id, parseInt(id)))
      .returning();
    
    if (!result) {
      return res.status(404).json({ error: 'Closure reason not found' });
    }
    
    res.json({ success: true, message: 'Closure reason deactivated' });
  } catch (error: any) {
    if (!isProduction) console.error('Closure reason delete error:', error);
    res.status(500).json({ error: 'Failed to delete closure reason' });
  }
});

router.get('/api/closures', async (req, res) => {
  try {
    const results = await db
      .select()
      .from(facilityClosures)
      .where(eq(facilityClosures.isActive, true))
      .orderBy(facilityClosures.startDate, facilityClosures.startTime);
    res.json(results);
  } catch (error: any) {
    if (!isProduction) console.error('Closures fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch closures' });
  }
});

router.get('/api/closures/needs-review', isStaffOrAdmin, async (req, res) => {
  try {
    const results = await db
      .select()
      .from(facilityClosures)
      .where(and(
        eq(facilityClosures.isActive, true),
        eq(facilityClosures.needsReview, true)
      ))
      .orderBy(facilityClosures.startDate, facilityClosures.startTime);
    
    const withMissingFields = results.map(closure => {
      const missingFields: string[] = [];
      if (!closure.noticeType || closure.noticeType.trim() === '') {
        missingFields.push('Notice type');
      }
      if (!closure.affectedAreas || closure.affectedAreas === 'none') {
        missingFields.push('Affected areas');
      }
      if (!closure.visibility || closure.visibility.trim() === '') {
        missingFields.push('Visibility');
      }
      return {
        ...closure,
        missingFields
      };
    });
    
    res.json(withMissingFields);
  } catch (error: any) {
    if (!isProduction) console.error('Needs review closures fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch closures needing review' });
  }
});

router.post('/api/closures', isStaffOrAdmin, async (req, res) => {
  try {
    const { 
      title, 
      reason,
      notice_type,
      start_date, 
      start_time,
      end_date, 
      end_time,
      affected_areas, 
      notify_members,
      created_by 
    } = req.body;
    
    if (!start_date || !affected_areas) {
      return res.status(400).json({ error: 'Start date and affected areas are required' });
    }
    
    const shouldNotifyMembers = affected_areas !== 'none' ? true : !!notify_members;
    
    const [result] = await db.insert(facilityClosures).values({
      title: title || 'Facility Closure',
      reason,
      noticeType: notice_type || null,
      startDate: start_date,
      startTime: start_time || null,
      endDate: end_date || start_date,
      endTime: end_time || null,
      affectedAreas: affected_areas,
      notifyMembers: shouldNotifyMembers,
      isActive: true,
      createdBy: created_by
    }).returning();
    
    const closureId = result.id;
    const affectedBayIds = await getAffectedBayIds(affected_areas);
    const dates = getDatesBetween(start_date, end_date || start_date);
    
    if (affectedBayIds.length > 0) {
      await createAvailabilityBlocksForClosure(
        closureId,
        affectedBayIds,
        dates,
        start_time,
        end_time,
        reason,
        created_by
      );
    }
    
    let internalEventIds: string | null = null;
    
    // Create calendar event ONLY on Internal Calendar (staff visibility)
    // Availability blocking is handled by the availability_blocks table created above
    try {
      const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
      
      if (internalCalendarId) {
        // Use notice_type for bracket prefix in calendar title
        // Default to NOTICE for non-blocking (affected_areas='none'), CLOSURE otherwise
        const defaultType = affected_areas === 'none' ? 'NOTICE' : 'CLOSURE';
        const typePrefix = notice_type ? `[${notice_type.toUpperCase()}]` : `[${defaultType}]`;
        const eventTitle = `${typePrefix}: ${title || 'Facility Notice'}`;
        const baseReason = reason || 'Scheduled notice';
        const eventDescription = baseReason + formatClosureMetadata(affected_areas, !!notify_members);
        
        internalEventIds = await createClosureCalendarEvents(
          internalCalendarId,
          eventTitle,
          eventDescription,
          start_date,
          end_date || start_date,
          start_time,
          end_time
        );
        
        if (internalEventIds) {
          console.log(`[Closures] Created Internal Calendar event(s) for closure #${closureId}: ${internalEventIds}`);
          
          await db
            .update(facilityClosures)
            .set({ internalCalendarId: internalEventIds })
            .where(eq(facilityClosures.id, closureId));
        } else {
          console.error(`[Closures] Failed to create Internal Calendar event for closure #${closureId}`);
        }
      } else {
        console.error(`[Closures] Internal Calendar not found - cannot create event for closure #${closureId}`);
      }
    } catch (calError: any) {
      console.error('[Closures] Failed to create Internal Calendar event:', calError?.message || calError);
    }
    
    if (notify_members) {
      const notificationTitle = title || 'Facility Closure';
      const affectedText = affected_areas === 'entire_facility' 
        ? 'Entire Facility' 
        : affected_areas === 'all_bays' 
          ? 'All Simulator Bays' 
          : affected_areas;
      const [sny, snm, snd] = start_date.split('-').map(Number);
      const monthsNotif = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const startDateFormattedNotif = `${monthsNotif[snm - 1]} ${snd}`;
      const notificationBody = reason 
        ? `${reason} - ${affectedText} on ${startDateFormattedNotif}`
        : `${affectedText} will be closed on ${startDateFormattedNotif}`;
      
      try {
        const memberUsers = await db
          .select({ email: users.email })
          .from(users)
          .where(or(eq(users.role, 'member'), isNull(users.role)));
        
        const membersWithEmails = memberUsers.filter(m => m.email && m.email.trim());
        
        if (membersWithEmails.length > 0) {
          const notificationValues = membersWithEmails.map(m => ({
            userEmail: m.email!,
            title: notificationTitle,
            message: notificationBody,
            type: 'closure',
            relatedId: closureId,
            relatedType: 'closure'
          }));
          
          await db.insert(notifications).values(notificationValues);
          console.log(`[Closures] Created in-app notifications for ${membersWithEmails.length} members`);
        }
      } catch (notifError) {
        console.error('[Closures] Failed to create in-app notifications:', notifError);
      }
      
      try {
        await sendPushNotificationToAllMembers({
          title: notificationTitle,
          body: notificationBody,
          url: '/announcements'
        });
      } catch (pushError) {
        console.error('[Closures] Failed to send push notifications:', pushError);
      }
    }
    
    clearClosureCache();
    
    broadcastClosureUpdate('created', result.id);
    
    logFromRequest(req, 'create_closure', 'closure', String(result.id), result.title, {
      reason: result.reason,
      startDate: result.startDate,
      endDate: result.endDate,
      startTime: result.startTime,
      endTime: result.endTime,
      affectedAreas: result.affectedAreas,
      noticeType: result.noticeType,
      notifyMembers: result.notifyMembers
    });
    
    res.json({ 
      ...result, 
      googleCalendarId: null,
      conferenceCalendarId: null,
      internalCalendarId: internalEventIds
    });
  } catch (error: any) {
    if (!isProduction) console.error('Closure create error:', error);
    res.status(500).json({ error: 'Failed to create closure' });
  }
});

router.delete('/api/closures/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const closureId = parseInt(id);
    
    const [closure] = await db
      .select()
      .from(facilityClosures)
      .where(eq(facilityClosures.id, closureId));
    
    // Delete calendar event from Internal Calendar only
    // (Legacy golf/conference events are also cleaned up for backward compatibility)
    try {
      // Delete from Internal Calendar (primary)
      if (closure?.internalCalendarId) {
        const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
        if (internalCalendarId) {
          await deleteClosureCalendarEvents(internalCalendarId, closure.internalCalendarId);
          console.log(`[Closures] Deleted Internal Calendar event(s) for closure #${closureId}`);
        }
      }
      
      // Backward compatibility: clean up any legacy conference events
      // Note: Golf calendar cleanup removed as golf calendar sync is deprecated
      if (closure?.conferenceCalendarId) {
        const conferenceCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
        if (conferenceCalendarId) {
          await deleteClosureCalendarEvents(conferenceCalendarId, closure.conferenceCalendarId);
          console.log(`[Closures] Cleaned up legacy Conference Room event(s) for closure #${closureId}`);
        }
      }
    } catch (calError) {
      console.error('[Closures] Failed to delete calendar event:', calError);
    }
    
    await deleteAvailabilityBlocksForClosure(closureId);
    
    try {
      await db
        .delete(announcements)
        .where(eq(announcements.closureId, closureId));
      console.log(`[Closures] Deleted announcement(s) for closure #${closureId}`);
    } catch (announcementError) {
      console.error('[Closures] Failed to delete announcement:', announcementError);
    }
    
    await db
      .update(facilityClosures)
      .set({ isActive: false })
      .where(eq(facilityClosures.id, closureId));
    
    clearClosureCache();
    
    broadcastClosureUpdate('deleted', closureId);
    
    logFromRequest(req, 'delete_closure', 'closure', String(closureId), closure?.title, {
      reason: closure?.reason,
      startDate: closure?.startDate,
      endDate: closure?.endDate,
      affectedAreas: closure?.affectedAreas,
      notifyMembers: closure?.notifyMembers
    });
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Closure delete error:', error);
    res.status(500).json({ error: 'Failed to delete closure' });
  }
});

// Update closure - also updates calendar events
router.put('/api/closures/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const closureId = parseInt(id);
    const { 
      title, 
      reason,
      notice_type,
      start_date, 
      start_time,
      end_date, 
      end_time,
      affected_areas,
      notify_members
    } = req.body;
    
    // Get existing closure
    const [existing] = await db
      .select()
      .from(facilityClosures)
      .where(eq(facilityClosures.id, closureId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Closure not found' });
    }
    
    // Determine notifyMembers value - always true if resources are affected
    const newAffectedAreas = affected_areas || existing.affectedAreas;
    const shouldNotifyMembers = newAffectedAreas !== 'none' ? true : 
      (notify_members !== undefined ? notify_members : existing.notifyMembers);
    
    // Convert empty strings to null for time fields (PostgreSQL requires null, not '')
    const normalizedStartTime = start_time === '' ? null : (start_time !== undefined ? start_time : existing.startTime);
    const normalizedEndTime = end_time === '' ? null : (end_time !== undefined ? end_time : existing.endTime);
    
    // Update the closure record - also mark as reviewed (no longer needs review)
    const [updated] = await db
      .update(facilityClosures)
      .set({
        title: title || existing.title,
        reason: reason !== undefined ? reason : existing.reason,
        noticeType: notice_type !== undefined ? notice_type : existing.noticeType,
        startDate: start_date || existing.startDate,
        startTime: normalizedStartTime,
        endDate: end_date || existing.endDate,
        endTime: normalizedEndTime,
        affectedAreas: affected_areas || existing.affectedAreas,
        notifyMembers: shouldNotifyMembers,
        needsReview: false
      })
      .where(eq(facilityClosures.id, closureId))
      .returning();
    
    // Update availability blocks if dates/times changed
    const datesChanged = start_date !== existing.startDate || end_date !== existing.endDate;
    const timesChanged = start_time !== existing.startTime || end_time !== existing.endTime;
    const areasChanged = affected_areas !== existing.affectedAreas;
    const startDateChanged = start_date && start_date !== existing.startDate;
    
    // If start date changed, clear old closure_today notifications so it can be re-notified on the new date
    if (startDateChanged && !existing.needsReview) {
      try {
        await db
          .delete(notifications)
          .where(and(
            eq(notifications.type, 'closure_today'),
            eq(notifications.relatedType, 'closure'),
            eq(notifications.relatedId, closureId)
          ));
        console.log(`[Closures] Cleared old notifications for closure #${closureId} (start date changed to ${start_date})`);
      } catch (err) {
        console.error('[Closures] Failed to clear old notifications:', err);
      }
    }
    
    if (datesChanged || timesChanged || areasChanged) {
      // Delete old availability blocks and recreate
      await deleteAvailabilityBlocksForClosure(closureId);
      
      const newAffectedAreas = affected_areas || existing.affectedAreas;
      const affectedBayIds = await getAffectedBayIds(newAffectedAreas);
      const dates = getDatesBetween(
        start_date || existing.startDate,
        end_date || existing.endDate || start_date || existing.startDate
      );
      
      if (affectedBayIds.length > 0) {
        await createAvailabilityBlocksForClosure(
          closureId,
          affectedBayIds,
          dates,
          normalizedStartTime,
          normalizedEndTime,
          reason !== undefined ? reason : existing.reason,
          existing.createdBy
        );
      }
    }
    
    // Update Internal Calendar event if dates/times/title changed
    // Only update Internal Calendar - availability blocking is handled by the availability_blocks table
    const shouldUpdateCalendar = datesChanged || timesChanged || title !== existing.title || reason !== existing.reason || areasChanged;
    if (shouldUpdateCalendar) {
      try {
        const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
        
        if (internalCalendarId) {
          // Delete old Internal Calendar event
          if (existing.internalCalendarId) {
            await deleteClosureCalendarEvents(internalCalendarId, existing.internalCalendarId);
          }
          
          // Also clean up any legacy conference events (backward compatibility)
          // Note: Golf calendar cleanup removed as golf calendar sync is deprecated
          if (existing.conferenceCalendarId) {
            const conferenceCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
            if (conferenceCalendarId) {
              await deleteClosureCalendarEvents(conferenceCalendarId, existing.conferenceCalendarId);
            }
          }
          
          // Create new Internal Calendar event only (uses newAffectedAreas and shouldNotifyMembers from above)
          const effectiveNoticeType = notice_type !== undefined ? notice_type : existing.noticeType;
          // Default to NOTICE for non-blocking (affected_areas='none'), CLOSURE otherwise
          const defaultType = newAffectedAreas === 'none' ? 'NOTICE' : 'CLOSURE';
          const typePrefix = effectiveNoticeType ? `[${effectiveNoticeType.toUpperCase()}]` : `[${defaultType}]`;
          const eventTitle = `${typePrefix}: ${title || existing.title}`;
          const baseReason = reason !== undefined ? reason : existing.reason || 'Scheduled notice';
          const eventDescription = baseReason + formatClosureMetadata(newAffectedAreas, shouldNotifyMembers);
          const newStartDate = start_date || existing.startDate;
          const newEndDate = end_date || existing.endDate;
          const newStartTime = start_time !== undefined ? start_time : existing.startTime;
          const newEndTime = end_time !== undefined ? end_time : existing.endTime;
          
          const newInternalEventIds = await createClosureCalendarEvents(
            internalCalendarId,
            eventTitle,
            eventDescription,
            newStartDate,
            newEndDate || newStartDate,
            newStartTime,
            newEndTime
          );
          
          // Update stored calendar ID (clear legacy columns)
          await db
            .update(facilityClosures)
            .set({ 
              googleCalendarId: null,
              conferenceCalendarId: null,
              internalCalendarId: newInternalEventIds
            })
            .where(eq(facilityClosures.id, closureId));
          
          console.log(`[Closures] Updated Internal Calendar event for closure #${closureId}`);
        }
      } catch (calError) {
        console.error('[Closures] Failed to update calendar events:', calError);
      }
    }
    
    // Update linked announcement if exists
    try {
      const newAffectedAreas = affected_areas || existing.affectedAreas;
      const affectedText = newAffectedAreas === 'entire_facility' 
        ? 'Entire Facility' 
        : newAffectedAreas === 'all_bays' 
          ? 'All Simulator Bays' 
          : newAffectedAreas;
      
      const newStartDate = start_date || existing.startDate;
      const newEndDate = end_date || existing.endDate;
      const [usy, usm, usd] = newStartDate.split('-').map(Number);
      const monthsUpdate = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const startDateFormatted = `${monthsUpdate[usm - 1]} ${usd}`;
      const endDateFormatted = newEndDate && newEndDate !== newStartDate 
        ? (() => { const [uey, uem, ued] = newEndDate.split('-').map(Number); return `${monthsUpdate[uem - 1]} ${ued}`; })()
        : null;
      
      const newStartTime = start_time !== undefined ? start_time : existing.startTime;
      const newEndTime = end_time !== undefined ? end_time : existing.endTime;
      const dateRange = endDateFormatted ? `${startDateFormatted} - ${endDateFormatted}` : startDateFormatted;
      const timeRange = newStartTime && newEndTime ? ` (${newStartTime} - ${newEndTime})` : newStartTime ? ` from ${newStartTime}` : '';
      
      const announcementTitle = title || existing.title;
      const announcementMessage = `${reason !== undefined ? reason : existing.reason || 'Scheduled maintenance'}\n\nAffected: ${affectedText}\nWhen: ${dateRange}${timeRange}`;
      
      await db
        .update(announcements)
        .set({
          title: announcementTitle,
          message: announcementMessage,
          startsAt: createPacificDate(newStartDate, '00:00:00'),
          endsAt: newEndDate ? createPacificDate(newEndDate, '23:59:59') : createPacificDate(newStartDate, '23:59:59')
        })
        .where(eq(announcements.closureId, closureId));
      
      console.log(`[Closures] Updated announcement for closure #${closureId}`);
    } catch (announcementError) {
      console.error('[Closures] Failed to update announcement:', announcementError);
    }
    
    clearClosureCache();
    
    // If this was a draft (needsReview = true) being published AND it starts today, notify members
    // For future closures, the morning job will handle notifications on the start day
    const wasPublished = existing.needsReview === true;
    const hasAffectedResources = newAffectedAreas && newAffectedAreas !== 'none';
    const finalStartDate = start_date || existing.startDate;
    const todayStr = getTodayPacific();
    const startsToday = finalStartDate === todayStr;
    
    if (wasPublished && hasAffectedResources && startsToday) {
      try {
        const finalTitle = title || existing.title;
        const finalReason = reason !== undefined ? reason : existing.reason;
        
        // Format the date for display
        const [year, month, day] = finalStartDate.split('-').map(Number);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dateFormatted = `${months[month - 1]} ${day}`;
        
        // Send push notification to all members
        await sendPushNotificationToAllMembers({
          title: `Today: ${finalTitle}`,
          body: finalReason ? `${finalReason}` : `Effective today`,
          url: '/updates?tab=notices'
        });
        
        // Create in-app notifications for all members
        const allMembers = await db
          .select({ email: users.email })
          .from(users)
          .where(or(eq(users.role, 'member'), isNull(users.role)));
        
        if (allMembers.length > 0) {
          const notificationValues = allMembers.map(member => ({
            userEmail: member.email,
            title: `Today: ${finalTitle}`,
            message: finalReason || `${finalTitle} - Effective today`,
            type: 'closure_today',
            relatedId: closureId,
            relatedType: 'closure'
          }));
          
          await db.insert(notifications).values(notificationValues);
          console.log(`[Closures] Sent same-day publish notification to ${allMembers.length} members for closure #${closureId}`);
        }
      } catch (notifyError) {
        console.error('[Closures] Failed to send publish notifications:', notifyError);
      }
    } else if (wasPublished && hasAffectedResources && !startsToday) {
      console.log(`[Closures] Draft published for future date (${finalStartDate}), morning job will notify on start day`);
    }
    
    broadcastClosureUpdate('updated', closureId);
    
    logFromRequest(req, 'update_closure', 'closure', String(closureId), updated.title, {
      reason: updated.reason,
      startDate: updated.startDate,
      endDate: updated.endDate,
      startTime: updated.startTime,
      endTime: updated.endTime,
      affectedAreas: updated.affectedAreas,
      noticeType: updated.noticeType,
      notifyMembers: updated.notifyMembers
    });
    
    res.json(updated);
  } catch (error: any) {
    if (!isProduction) console.error('Closure update error:', error);
    res.status(500).json({ error: 'Failed to update closure' });
  }
});

router.post('/api/closures/backfill-blocks', isStaffOrAdmin, async (req, res) => {
  try {
    const allClosures = await db
      .select()
      .from(facilityClosures)
      .where(eq(facilityClosures.isActive, true));
    
    let totalBlocksCreated = 0;
    const results: { closureId: number; title: string; blocksCreated: number }[] = [];
    
    for (const closure of allClosures) {
      const existingBlocks = await db
        .select({ id: availabilityBlocks.id })
        .from(availabilityBlocks)
        .where(eq(availabilityBlocks.closureId, closure.id));
      
      if (existingBlocks.length > 0) {
        results.push({ closureId: closure.id, title: closure.title, blocksCreated: 0 });
        continue;
      }
      
      const affectedBayIds = await getAffectedBayIds(closure.affectedAreas || 'entire_facility');
      const dates = getDatesBetween(closure.startDate, closure.endDate || closure.startDate);
      
      if (affectedBayIds.length > 0) {
        const blockStartTime = closure.startTime || '08:00:00';
        const blockEndTime = closure.endTime || '22:00:00';
        
        const insertValues = [];
        for (const resourceId of affectedBayIds) {
          for (const date of dates) {
            insertValues.push({
              resourceId,
              blockDate: date,
              startTime: blockStartTime,
              endTime: blockEndTime,
              blockType: 'blocked',
              notes: closure.reason || 'Facility closure',
              createdBy: closure.createdBy,
              closureId: closure.id
            });
          }
        }
        
        if (insertValues.length > 0) {
          await db.insert(availabilityBlocks).values(insertValues);
          totalBlocksCreated += insertValues.length;
          results.push({ closureId: closure.id, title: closure.title, blocksCreated: insertValues.length });
          console.log(`[Backfill] Created ${insertValues.length} blocks for closure #${closure.id}: ${closure.title}`);
        }
      } else {
        results.push({ closureId: closure.id, title: closure.title, blocksCreated: 0 });
      }
    }
    
    console.log(`[Backfill] Complete: ${totalBlocksCreated} total blocks created for ${allClosures.length} closures`);
    res.json({ 
      success: true, 
      totalClosures: allClosures.length,
      totalBlocksCreated,
      details: results 
    });
  } catch (error: any) {
    console.error('Backfill error:', error);
    res.status(500).json({ error: 'Failed to backfill availability blocks' });
  }
});

// Manual sync endpoint for closures from Internal Calendar
router.post('/api/closures/sync', isStaffOrAdmin, async (req, res) => {
  try {
    console.log('[Manual Sync] Starting Internal Calendar closure sync...');
    const result = await syncInternalCalendarToClosures();
    
    if (result.error) {
      return res.status(400).json(result);
    }
    
    logFromRequest(req, 'sync_closures', 'closure', '', 'Internal Calendar Sync', {
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      errors: result.errors
    });
    
    res.json({
      success: true,
      message: 'Closures synced successfully',
      stats: result
    });
  } catch (error: any) {
    if (!isProduction) console.error('Manual closure sync error:', error);
    res.status(500).json({ error: 'Failed to sync closures' });
  }
});

// Fix orphaned closures - create calendar events for closures without google_calendar_id
router.post('/api/closures/fix-orphaned', isAdmin, async (req, res) => {
  try {
    console.log('[Fix Orphaned] Starting orphaned closures fix...');
    
    const orphanedClosures = await db
      .select()
      .from(facilityClosures)
      .where(and(
        eq(facilityClosures.isActive, true),
        isNull(facilityClosures.googleCalendarId)
      ));
    
    if (orphanedClosures.length === 0) {
      return res.json({ success: true, message: 'No orphaned closures found', fixed: 0 });
    }
    
    const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
    if (!internalCalendarId) {
      return res.status(400).json({ error: 'Internal Calendar not found' });
    }
    
    const results: { id: number; title: string; status: string; eventId?: string }[] = [];
    
    for (const closure of orphanedClosures) {
      try {
        const eventIds = await createClosureCalendarEvents(
          internalCalendarId,
          closure.title,
          closure.reason || 'Facility closure',
          closure.startDate,
          closure.endDate,
          closure.startTime,
          closure.endTime
        );
        
        if (eventIds) {
          await db.update(facilityClosures)
            .set({ 
              googleCalendarId: eventIds,
              internalCalendarId: eventIds 
            })
            .where(eq(facilityClosures.id, closure.id));
          
          results.push({ id: closure.id, title: closure.title, status: 'fixed', eventId: eventIds });
          console.log(`[Fix Orphaned] Created calendar event for closure #${closure.id}: ${closure.title}`);
        } else {
          results.push({ id: closure.id, title: closure.title, status: 'failed' });
        }
      } catch (err: any) {
        console.error(`[Fix Orphaned] Error fixing closure #${closure.id}:`, err);
        results.push({ id: closure.id, title: closure.title, status: 'error', eventId: err.message });
      }
    }
    
    const fixedCount = results.filter(r => r.status === 'fixed').length;
    console.log(`[Fix Orphaned] Complete: ${fixedCount}/${orphanedClosures.length} closures fixed`);
    
    res.json({
      success: true,
      message: `Fixed ${fixedCount} of ${orphanedClosures.length} orphaned closures`,
      fixed: fixedCount,
      total: orphanedClosures.length,
      details: results
    });
  } catch (error: any) {
    console.error('[Fix Orphaned] Error:', error);
    res.status(500).json({ error: 'Failed to fix orphaned closures' });
  }
});

export default router;
