import { Router } from 'express';
import { db } from '../../db';
import { resources, availabilityBlocks, bookingRequests } from '../../../shared/schema';
import { eq, and, or, asc, sql } from 'drizzle-orm';
import { isProduction } from '../../core/db';
import { getGoogleCalendarClient } from '../../core/integrations';
import {logAndRespond, logger } from '../../core/logger';

const router = Router();

router.get('/api/bays', async (req, res) => {
  try {
    const result = await db.select({
      id: resources.id,
      name: resources.name,
      description: resources.description,
      isActive: sql<boolean>`true`,
      createdAt: resources.createdAt
    }).from(resources).where(eq(resources.type, 'simulator')).orderBy(asc(resources.name));
    res.json(result);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch bays', error);
  }
});

router.get('/api/bays/:bayId/availability', async (req, res) => {
  try {
    const { bayId } = req.params;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    
    const bookingsResult = await db.select({
      start_time: bookingRequests.startTime,
      end_time: bookingRequests.endTime,
      user_name: bookingRequests.userName
    })
    .from(bookingRequests)
    .where(and(
      eq(bookingRequests.resourceId, parseInt(bayId)),
      eq(bookingRequests.requestDate, date as string),
      or(
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'attended')
      )
    ))
    .orderBy(asc(bookingRequests.startTime));
    
    const blocksResult = await db.select({
      start_time: availabilityBlocks.startTime,
      end_time: availabilityBlocks.endTime,
      block_type: availabilityBlocks.blockType,
      notes: availabilityBlocks.notes
    })
    .from(availabilityBlocks)
    .where(and(
      eq(availabilityBlocks.resourceId, parseInt(bayId)),
      eq(availabilityBlocks.blockDate, date as string)
    ))
    .orderBy(asc(availabilityBlocks.startTime));
    
    let calendarBlocks: any[] = [];
    try {
      const calendar = await getGoogleCalendarClient();
      const startTime = new Date(date as string);
      startTime.setHours(0, 0, 0, 0);
      const endTime = new Date(date as string);
      endTime.setHours(23, 59, 59, 999);
      
      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin: startTime.toISOString(),
          timeMax: endTime.toISOString(),
          items: [{ id: 'primary' }],
        },
      });
      
      const busySlots = response.data.calendars?.primary?.busy || [];
      calendarBlocks = busySlots.map((slot: any) => {
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        const startPT = start.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
        const endPT = end.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
        return {
          start_time: startPT,
          end_time: endPT,
          block_type: 'calendar',
          notes: 'Google Calendar event'
        };
      });
    } catch (calError) {
      if (!isProduction) logger.info('Calendar availability fetch skipped', { extra: { calError_as_Error_message: (calError as Error).message } });
    }
    
    res.json({
      bookings: bookingsResult,
      blocks: [...blocksResult, ...calendarBlocks]
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch availability', error);
  }
});

export default router;
