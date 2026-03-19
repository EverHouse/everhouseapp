import { logger } from '../../core/logger';
import { Router } from 'express';
import { db } from '../../db';
import { facilityClosures, availabilityBlocks } from '../../../shared/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { isProduction } from '../../core/db';
import { logFromRequest } from '../../core/auditLog';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { getCalendarIdByName, syncInternalCalendarToClosures, backfillCalendarExtendedProperties, CALENDAR_CONFIG } from '../../core/calendar/index';
import { clearClosureCache } from '../../core/bookingValidation';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  getAffectedBayIds,
  getDatesBetween,
  createAvailabilityBlocksForClosure,
  createClosureCalendarEvents,
} from './helpers';

const router = Router();

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
          await db.insert(availabilityBlocks).values(insertValues).onConflictDoNothing();
          totalBlocksCreated += insertValues.length;
          results.push({ closureId: closure.id, title: closure.title, blocksCreated: insertValues.length });
          logger.info('[Backfill] Created blocks for closure #', { extra: { insertValuesLength: insertValues.length, closureId: closure.id, closureTitle: closure.title } });
        }
      } else {
        results.push({ closureId: closure.id, title: closure.title, blocksCreated: 0 });
      }
    }
    
    logger.info('[Backfill] Complete: total blocks created for closures', { extra: { totalBlocksCreated, allClosuresLength: allClosures.length } });
    res.json({ 
      success: true, 
      totalClosures: allClosures.length,
      totalBlocksCreated,
      details: results 
    });
  } catch (error: unknown) {
    logger.error('Backfill error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to backfill availability blocks' });
  }
});

// Manual sync endpoint for closures from Internal Calendar
router.post('/api/closures/sync', isStaffOrAdmin, async (req, res) => {
  try {
    logger.info('[Manual Sync] Starting Internal Calendar closure sync...');
    const result = await syncInternalCalendarToClosures();
    
    if (result.error) {
      return res.status(400).json(result);
    }
    
    logFromRequest(req, 'sync_closures', 'closure', '', 'Internal Calendar Sync', {
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      errors: result.error
    });
    
    res.json({
      success: true,
      message: 'Closures synced successfully',
      stats: result
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Manual closure sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync closures' });
  }
});

// Fix orphaned closures - create calendar events for closures without google_calendar_id
router.post('/api/closures/fix-orphaned', isAdmin, async (req, res) => {
  try {
    logger.info('[Fix Orphaned] Starting orphaned closures fix...');
    
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
        const closureExtProps: Record<string, string> = {
          'ehApp_type': 'closure',
        };
        if (closure.affectedAreas) closureExtProps['ehApp_affectedAreas'] = closure.affectedAreas;
        closureExtProps['ehApp_notifyMembers'] = closure.notifyMembers ? 'true' : 'false';
        if (closure.notes) closureExtProps['ehApp_notes'] = closure.notes;
        
        const eventIds = await createClosureCalendarEvents(
          internalCalendarId,
          closure.title,
          closure.reason || 'Facility closure',
          closure.startDate,
          closure.endDate,
          closure.startTime,
          closure.endTime,
          closureExtProps
        );
        
        if (eventIds) {
          await db.update(facilityClosures)
            .set({ 
              googleCalendarId: eventIds,
              internalCalendarId: eventIds 
            })
            .where(eq(facilityClosures.id, closure.id));
          
          results.push({ id: closure.id, title: closure.title, status: 'fixed', eventId: eventIds });
          logger.info('[Fix Orphaned] Created calendar event for closure #', { extra: { closureId: closure.id, closureTitle: closure.title } });
        } else {
          results.push({ id: closure.id, title: closure.title, status: 'failed' });
        }
      } catch (err: unknown) {
        logger.error('[Fix Orphaned] Error fixing closure #', { extra: { id: closure.id, err } });
        results.push({ id: closure.id, title: closure.title, status: 'error', eventId: getErrorMessage(err) });
      }
    }
    
    const fixedCount = results.filter(r => r.status === 'fixed').length;
    logger.info('[Fix Orphaned] Complete: / closures fixed', { extra: { fixedCount, orphanedClosuresLength: orphanedClosures.length } });
    
    res.json({
      success: true,
      message: `Fixed ${fixedCount} of ${orphanedClosures.length} orphaned closures`,
      fixed: fixedCount,
      total: orphanedClosures.length,
      details: results
    });
  } catch (error: unknown) {
    logger.error('[Fix Orphaned] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fix orphaned closures' });
  }
});

let backfillStatus: { running: boolean; startedAt?: Date; result?: Awaited<ReturnType<typeof backfillCalendarExtendedProperties>>; error?: string } = { running: false };

router.post('/api/admin/backfill-calendar-extended-properties', isAdmin, async (req, res) => {
  if (backfillStatus.running) {
    return res.status(409).json({ success: false, error: 'Backfill is already running', startedAt: backfillStatus.startedAt });
  }

  backfillStatus = { running: true, startedAt: new Date() };
  res.json({ success: true, message: 'Backfill started in background. Check status with GET /api/admin/backfill-calendar-extended-properties/status' });

  try {
    const result = await backfillCalendarExtendedProperties();
    backfillStatus = { running: false, startedAt: backfillStatus.startedAt, result };

    logFromRequest(req, 'backfill_calendar_props' as Parameters<typeof logFromRequest>[1], 'system', 'calendar', 'Extended Properties Backfill', {
      closures_patched: result.closures.patched,
      closures_skipped: result.closures.skipped,
      events_patched: result.events.patched,
      events_skipped: result.events.skipped,
      wellness_patched: result.wellness.patched,
      wellness_skipped: result.wellness.skipped,
    });

    logger.info('[Backfill] Calendar extended properties backfill complete', {
      extra: { closures: result.closures, events: result.events, wellness: result.wellness },
    });
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    backfillStatus = { running: false, startedAt: backfillStatus.startedAt, error: msg };
    logger.error('Extended properties backfill error', { error: error instanceof Error ? error : new Error(msg) });
  }
});

router.get('/api/admin/backfill-calendar-extended-properties/status', isAdmin, (_req, res) => {
  if (backfillStatus.running) {
    return res.json({ status: 'running', startedAt: backfillStatus.startedAt });
  }
  if (backfillStatus.result) {
    const r = backfillStatus.result;
    return res.json({
      status: 'complete',
      startedAt: backfillStatus.startedAt,
      message: `Patched: ${r.closures.patched} closures, ${r.events.patched} events, ${r.wellness.patched} wellness. Skipped: ${r.closures.skipped} closures, ${r.events.skipped} events, ${r.wellness.skipped} wellness.`,
      ...r,
    });
  }
  if (backfillStatus.error) {
    return res.json({ status: 'error', startedAt: backfillStatus.startedAt, error: backfillStatus.error });
  }
  res.json({ status: 'idle' });
});

export default router;
