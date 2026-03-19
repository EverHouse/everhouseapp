import { logger } from '../../core/logger';
import { Router } from 'express';
import { isProduction } from '../../core/db';
import { db } from '../../db';
import { facilityClosures, users, announcements, noticeTypes, closureReasons, notifications } from '../../../shared/schema';
import { eq, desc, or, isNull, and } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { getCalendarIdByName, CALENDAR_CONFIG } from '../../core/calendar/index';
import { clearClosureCache } from '../../core/bookingValidation';
import { broadcastClosureUpdate } from '../../core/websocket';
import { notifyMember } from '../../core/notificationService';
import { logFromRequest } from '../../core/auditLog';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { getTodayPacific, createPacificDate } from '../../utils/dateUtils';
import {
  sendPushNotificationToAllMembers,
  getAffectedBayIds,
  getDatesBetween,
  createAvailabilityBlocksForClosure,
  deleteAvailabilityBlocksForClosure,
  createClosureCalendarEvents,
  deleteClosureCalendarEvents,
  patchClosureCalendarEvents,
} from './helpers';

const router = Router();

// PUBLIC ROUTE - notice types used by closure forms
router.get('/api/notice-types', async (req, res) => {
  try {
    const results = await db
      .select()
      .from(noticeTypes)
      .orderBy(noticeTypes.sortOrder, noticeTypes.name);
    res.json(results);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Notice types fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
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
    
    logFromRequest(req, 'create_notice_type', 'notice_type', String(result.id), result.name, {});
    res.status(201).json(result);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Notice type creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create notice type' });
  }
});

router.put('/api/notice-types/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const noticeTypeId = parseInt(id as string, 10);
    if (isNaN(noticeTypeId)) return res.status(400).json({ error: 'Invalid notice type ID' });
    const { name, sort_order } = req.body;
    
    const [existing] = await db
      .select()
      .from(noticeTypes)
      .where(eq(noticeTypes.id, noticeTypeId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Notice type not found' });
    }
    
    if (existing.isPreset) {
      return res.status(403).json({ error: 'Cannot edit preset notice types' });
    }
    
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (sort_order !== undefined) updateData.sortOrder = sort_order;
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    const [result] = await db
      .update(noticeTypes)
      .set(updateData)
      .where(eq(noticeTypes.id, noticeTypeId))
      .returning();
    
    logFromRequest(req, 'update_notice_type', 'notice_type', String(id), undefined, {});
    res.json(result);
  } catch (error: unknown) {
    if (getErrorCode(error) === '23505') {
      return res.status(400).json({ error: 'A notice type with this name already exists' });
    }
    if (!isProduction) logger.error('Notice type update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update notice type' });
  }
});

router.delete('/api/notice-types/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const noticeTypeId = parseInt(id as string, 10);
    if (isNaN(noticeTypeId)) return res.status(400).json({ error: 'Invalid notice type ID' });
    
    const [existing] = await db
      .select()
      .from(noticeTypes)
      .where(eq(noticeTypes.id, noticeTypeId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Notice type not found' });
    }
    
    if (existing.isPreset) {
      return res.status(403).json({ error: 'Cannot delete preset notice types' });
    }
    
    await db
      .delete(noticeTypes)
      .where(eq(noticeTypes.id, noticeTypeId));
    
    logFromRequest(req, 'delete_notice_type', 'notice_type', String(id), undefined, {});
    res.json({ success: true, message: 'Notice type deleted' });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Notice type delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete notice type' });
  }
});

// PUBLIC ROUTE - closure reasons used by closure forms
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
  } catch (error: unknown) {
    if (!isProduction) logger.error('Closure reasons fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
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
    
    logFromRequest(req, 'create_closure_reason', 'closure_reason', String(result.id), result.label, {});
    res.status(201).json(result);
  } catch (error: unknown) {
    if (getErrorCode(error) === '23505') {
      return res.status(400).json({ error: 'A closure reason with this label already exists' });
    }
    if (!isProduction) logger.error('Closure reason creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create closure reason' });
  }
});

router.put('/api/closure-reasons/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const reasonId = parseInt(id as string, 10);
    if (isNaN(reasonId)) return res.status(400).json({ error: 'Invalid closure reason ID' });
    const { label, sort_order, is_active } = req.body;
    
    const updateData: Record<string, unknown> = {};
    if (label !== undefined) updateData.label = label.trim();
    if (sort_order !== undefined) updateData.sortOrder = sort_order;
    if (is_active !== undefined) updateData.isActive = is_active;
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    const [result] = await db
      .update(closureReasons)
      .set(updateData)
      .where(eq(closureReasons.id, reasonId))
      .returning();
    
    if (!result) {
      return res.status(404).json({ error: 'Closure reason not found' });
    }
    
    logFromRequest(req, 'update_closure_reason', 'closure_reason', String(id), undefined, {});
    res.json(result);
  } catch (error: unknown) {
    if (getErrorCode(error) === '23505') {
      return res.status(400).json({ error: 'A closure reason with this label already exists' });
    }
    if (!isProduction) logger.error('Closure reason update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update closure reason' });
  }
});

router.delete('/api/closure-reasons/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const reasonId = parseInt(id as string, 10);
    if (isNaN(reasonId)) return res.status(400).json({ error: 'Invalid closure reason ID' });
    
    const [result] = await db
      .update(closureReasons)
      .set({ isActive: false })
      .where(eq(closureReasons.id, reasonId))
      .returning();
    
    if (!result) {
      return res.status(404).json({ error: 'Closure reason not found' });
    }
    
    logFromRequest(req, 'delete_closure_reason', 'closure_reason', String(id), undefined, {});
    res.json({ success: true, message: 'Closure reason deactivated' });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Closure reason delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete closure reason' });
  }
});

// PUBLIC ROUTE - active closures displayed to all visitors
router.get('/api/closures', async (req, res) => {
  try {
    const results = await db
      .select()
      .from(facilityClosures)
      .where(eq(facilityClosures.isActive, true))
      .orderBy(desc(facilityClosures.startDate), desc(facilityClosures.startTime))
      .limit(500);
    res.json(results);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Closures fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
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
      return {
        ...closure,
        missingFields
      };
    });
    
    res.json(withMissingFields);
  } catch (error: unknown) {
    if (!isProduction) logger.error('Needs review closures fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch closures needing review' });
  }
});

router.post('/api/closures', isStaffOrAdmin, async (req, res) => {
  try {
    const { 
      title, 
      reason,
      member_notice,
      notes,
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
    
    const [[result], affectedBayIds, internalCalendarId] = await Promise.all([
      db.insert(facilityClosures).values({
        title: title || 'Facility Closure',
        reason,
        memberNotice: member_notice || null,
        notes: notes || null,
        noticeType: notice_type || null,
        startDate: start_date,
        startTime: start_time || null,
        endDate: end_date || start_date,
        endTime: end_time || null,
        affectedAreas: affected_areas,
        visibility: shouldNotifyMembers ? 'Members' : 'Staff Only',
        notifyMembers: shouldNotifyMembers,
        isActive: true,
        createdBy: created_by
      }).returning(),
      getAffectedBayIds(affected_areas),
      getCalendarIdByName(CALENDAR_CONFIG.internal.name).catch(() => null),
    ]);
    
    const closureId = result.id;
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
    
    try {
      
      if (internalCalendarId) {
        // Use notice_type for bracket prefix in calendar title
        // Default to NOTICE for non-blocking (affected_areas='none'), CLOSURE otherwise
        const defaultType = affected_areas === 'none' ? 'NOTICE' : 'CLOSURE';
        const typePrefix = notice_type ? `[${notice_type.toUpperCase()}]` : `[${defaultType}]`;
        const eventTitle = `${typePrefix}: ${title || 'Facility Notice'}`;
        const eventDescription = reason || 'Scheduled notice';
        
        const closureExtProps: Record<string, string> = {
          'ehApp_type': 'closure',
        };
        if (affected_areas) closureExtProps['ehApp_affectedAreas'] = affected_areas;
        closureExtProps['ehApp_notifyMembers'] = shouldNotifyMembers ? 'true' : 'false';
        if (notes) closureExtProps['ehApp_notes'] = notes;
        
        internalEventIds = await createClosureCalendarEvents(
          internalCalendarId,
          eventTitle,
          eventDescription,
          start_date,
          end_date || start_date,
          start_time,
          end_time,
          closureExtProps
        );
        
        if (internalEventIds) {
          logger.info('[Closures] Created Internal Calendar event(s) for closure #', { extra: { closureId, internalEventIds } });
          
          await db
            .update(facilityClosures)
            .set({ internalCalendarId: internalEventIds })
            .where(eq(facilityClosures.id, closureId));
        } else {
          logger.error('[Closures] Failed to create Internal Calendar event for closure #', { extra: { closureId } });
        }
      } else {
        logger.error('[Closures] Internal Calendar not found - cannot create event for closure #', { extra: { closureId } });
      }
    } catch (calError: unknown) {
      logger.error('[Closures] Failed to create Internal Calendar event', { extra: { calError: getErrorMessage(calError) } });
    }
    
    if (notify_members) {
      const notificationTitle = title || 'Facility Closure';
      const affectedText = affected_areas === 'entire_facility' 
        ? 'Entire Facility' 
        : affected_areas === 'all_bays' 
          ? 'All Simulator Bays' 
          : affected_areas;
      const [_sny, snm, snd] = start_date.split('-').map(Number);
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
          const results = await Promise.allSettled(
            membersWithEmails.map(m => notifyMember({
              userEmail: m.email!,
              title: notificationTitle,
              message: notificationBody,
              type: 'closure',
              relatedId: closureId,
              relatedType: 'closure',
              url: '/updates?tab=notices'
            }))
          );
          const failedCount = results.filter(r => r.status === 'rejected').length;
          logger.info('[Closures] Created in-app notifications for members', { extra: { membersWithEmailsLength: membersWithEmails.length, failedCount } });
        }
      } catch (notifError: unknown) {
        logger.error('[Closures] Failed to create in-app notifications', { extra: { notifError } });
      }
      
      try {
        await sendPushNotificationToAllMembers({
          title: notificationTitle,
          body: notificationBody,
          url: '/announcements',
          tag: `closure-${closureId}`
        });
      } catch (pushError: unknown) {
        logger.error('[Closures] Failed to send push notifications', { extra: { pushError } });
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
  } catch (error: unknown) {
    if (!isProduction) logger.error('Closure create error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create closure' });
  }
});

router.delete('/api/closures/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const closureId = parseInt(id as string, 10);
    if (isNaN(closureId)) return res.status(400).json({ error: 'Invalid closure ID' });
    
    const [closure] = await db
      .select()
      .from(facilityClosures)
      .where(eq(facilityClosures.id, closureId));
    
    try {
      const [internalCalendarId, conferenceCalendarId] = await Promise.all([
        closure?.internalCalendarId ? getCalendarIdByName(CALENDAR_CONFIG.internal.name) : Promise.resolve(null),
        closure?.conferenceCalendarId ? getCalendarIdByName(CALENDAR_CONFIG.conference.name) : Promise.resolve(null),
      ]);

      await Promise.all([
        internalCalendarId && closure?.internalCalendarId
          ? deleteClosureCalendarEvents(internalCalendarId, closure.internalCalendarId).then(() =>
              logger.info('[Closures] Deleted Internal Calendar event(s) for closure #', { extra: { closureId } }))
          : Promise.resolve(),
        conferenceCalendarId && closure?.conferenceCalendarId
          ? deleteClosureCalendarEvents(conferenceCalendarId, closure.conferenceCalendarId).then(() =>
              logger.info('[Closures] Cleaned up legacy Conference Room event(s) for closure #', { extra: { closureId } }))
          : Promise.resolve(),
      ]);
    } catch (calError: unknown) {
      logger.error('[Closures] Failed to delete calendar event', { extra: { calError } });
    }
    
    await deleteAvailabilityBlocksForClosure(closureId);
    
    try {
      await db
        .delete(announcements)
        .where(eq(announcements.closureId, closureId));
      logger.info('[Closures] Deleted announcement(s) for closure #', { extra: { closureId } });
    } catch (announcementError: unknown) {
      logger.error('[Closures] Failed to delete announcement', { extra: { announcementError } });
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
  } catch (error: unknown) {
    if (!isProduction) logger.error('Closure delete error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete closure' });
  }
});

// Update closure - also updates calendar events
router.put('/api/closures/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const closureId = parseInt(id as string, 10);
    if (isNaN(closureId)) return res.status(400).json({ error: 'Invalid closure ID' });
    const { 
      title, 
      reason,
      member_notice,
      notes,
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
        memberNotice: member_notice !== undefined ? member_notice : existing.memberNotice,
        notes: notes !== undefined ? notes : existing.notes,
        noticeType: notice_type !== undefined ? notice_type : existing.noticeType,
        startDate: start_date || existing.startDate,
        startTime: normalizedStartTime,
        endDate: end_date || existing.endDate,
        endTime: normalizedEndTime,
        affectedAreas: affected_areas || existing.affectedAreas,
        visibility: shouldNotifyMembers ? 'Members' : 'Staff Only',
        notifyMembers: shouldNotifyMembers,
        needsReview: false,
        locallyEdited: true,
        appLastModifiedAt: new Date(),
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
        logger.info('[Closures] Cleared old notifications for closure # (start date changed to )', { extra: { closureId, start_date } });
      } catch (err: unknown) {
        logger.error('[Closures] Failed to clear old notifications', { extra: { err } });
      }
    }
    
    if (datesChanged || timesChanged || areasChanged) {
      const [, affectedBayIds] = await Promise.all([
        deleteAvailabilityBlocksForClosure(closureId),
        getAffectedBayIds(newAffectedAreas),
      ]);
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
    
    // Update Internal Calendar event if dates/times/title/notes changed
    // Only update Internal Calendar - availability blocking is handled by the availability_blocks table
    const notesChanged = notes !== undefined && notes !== existing.notes;
    const noticeTypeChanged = notice_type !== undefined && notice_type !== existing.noticeType;
    const notifyMembersChanged = shouldNotifyMembers !== existing.notifyMembers;
    const shouldUpdateCalendar = datesChanged || timesChanged || title !== existing.title || reason !== existing.reason || areasChanged || notesChanged || noticeTypeChanged || notifyMembersChanged;
    if (shouldUpdateCalendar) {
      try {
        const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
        
        if (internalCalendarId) {
          const effectiveNoticeType = notice_type !== undefined ? notice_type : existing.noticeType;
          const defaultType = newAffectedAreas === 'none' ? 'NOTICE' : 'CLOSURE';
          const typePrefix = effectiveNoticeType ? `[${effectiveNoticeType.toUpperCase()}]` : `[${defaultType}]`;
          const eventTitle = `${typePrefix}: ${title || existing.title}`;
          const eventDescription = reason !== undefined ? reason : existing.reason || 'Scheduled notice';
          const effectiveNotes = notes !== undefined ? notes : existing.notes;
          const newStartDate = start_date || existing.startDate;
          const newEndDate = end_date || existing.endDate;
          const newStartTime = start_time !== undefined ? start_time : existing.startTime;
          const newEndTime = end_time !== undefined ? end_time : existing.endTime;
          
          const closureExtProps: Record<string, string> = {
            'ehApp_type': 'closure',
          };
          if (newAffectedAreas) closureExtProps['ehApp_affectedAreas'] = newAffectedAreas;
          closureExtProps['ehApp_notifyMembers'] = shouldNotifyMembers ? 'true' : 'false';
          if (effectiveNotes) closureExtProps['ehApp_notes'] = effectiveNotes;
          
          let calendarUpdated = false;
          
          if (existing.internalCalendarId) {
            calendarUpdated = await patchClosureCalendarEvents(
              internalCalendarId,
              existing.internalCalendarId,
              eventTitle,
              eventDescription,
              newStartDate,
              newEndDate || newStartDate,
              newStartTime,
              newEndTime,
              closureExtProps
            );
            
            if (calendarUpdated) {
              await db
                .update(facilityClosures)
                .set({ locallyEdited: false, appLastModifiedAt: null, lastSyncedAt: new Date() })
                .where(eq(facilityClosures.id, closureId));
              logger.info('[Closures] Patched Internal Calendar event(s) for closure #', { extra: { closureId } });
            }
          }
          
          if (!calendarUpdated) {
            if (existing.internalCalendarId) {
              await deleteClosureCalendarEvents(internalCalendarId, existing.internalCalendarId);
            }
            
            const newInternalEventIds = await createClosureCalendarEvents(
              internalCalendarId,
              eventTitle,
              eventDescription,
              newStartDate,
              newEndDate || newStartDate,
              newStartTime,
              newEndTime,
              closureExtProps
            );
            
            await db
              .update(facilityClosures)
              .set({ 
                googleCalendarId: null,
                conferenceCalendarId: null,
                internalCalendarId: newInternalEventIds,
                locallyEdited: false,
                appLastModifiedAt: null,
                lastSyncedAt: new Date(),
              })
              .where(eq(facilityClosures.id, closureId));
            
            logger.info('[Closures] Recreated Internal Calendar event for closure #', { extra: { closureId } });
          }
          
          if (existing.conferenceCalendarId) {
            const conferenceCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
            if (conferenceCalendarId) {
              await deleteClosureCalendarEvents(conferenceCalendarId, existing.conferenceCalendarId);
            }
          }
        }
      } catch (calError: unknown) {
        logger.error('[Closures] Failed to update calendar events', { extra: { calError } });
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
      const [_usy, usm, usd] = newStartDate.split('-').map(Number);
      const monthsUpdate = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const startDateFormatted = `${monthsUpdate[usm - 1]} ${usd}`;
      const endDateFormatted = newEndDate && newEndDate !== newStartDate 
        ? (() => { const [_uey, uem, ued] = newEndDate.split('-').map(Number); return `${monthsUpdate[uem - 1]} ${ued}`; })()
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
      
      logger.info('[Closures] Updated announcement for closure #', { extra: { closureId } });
    } catch (announcementError: unknown) {
      logger.error('[Closures] Failed to update announcement', { extra: { announcementError } });
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
        const [_year, month, day] = finalStartDate.split('-').map(Number);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const _dateFormatted = `${months[month - 1]} ${day}`;
        
        // Send push notification to all members
        await sendPushNotificationToAllMembers({
          title: `Today: ${finalTitle}`,
          body: finalReason ? `${finalReason}` : `Effective today`,
          url: '/updates?tab=notices',
          tag: `closure-${closureId}`
        });
        
        // Create in-app notifications for all members
        const allMembers = await db
          .select({ email: users.email })
          .from(users)
          .where(or(eq(users.role, 'member'), isNull(users.role)));
        
        if (allMembers.length > 0) {
          const results = await Promise.allSettled(
            allMembers.map(member => notifyMember({
              userEmail: member.email,
              title: `Today: ${finalTitle}`,
              message: finalReason || `${finalTitle} - Effective today`,
              type: 'closure_today',
              relatedId: closureId,
              relatedType: 'closure',
              url: '/updates?tab=notices'
            }))
          );
          const failedCount = results.filter(r => r.status === 'rejected').length;
          logger.info('[Closures] Sent same-day publish notification to members for closure #', { extra: { allMembersLength: allMembers.length, closureId, failedCount } });
        }
      } catch (notifyError: unknown) {
        logger.error('[Closures] Failed to send publish notifications', { extra: { notifyError } });
      }
    } else if (wasPublished && hasAffectedResources && !startsToday) {
      logger.info('[Closures] Draft published for future date (), morning job will notify on start day', { extra: { finalStartDate } });
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
  } catch (error: unknown) {
    if (!isProduction) logger.error('Closure update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update closure' });
  }
});
export default router;
