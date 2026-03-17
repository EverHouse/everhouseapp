import { Router } from 'express';
import { db } from '../../db';
import { resources, availabilityBlocks, bookingRequests, users } from '../../../shared/schema';
import { eq, and, or, asc, sql } from 'drizzle-orm';
import { isProduction } from '../../core/db';
import { getGoogleCalendarClient } from '../../core/integrations';
import {logAndRespond, logger } from '../../core/logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { getPacificMidnightUTC } from '../../utils/dateUtils';

const router = Router();

// PUBLIC ROUTE - bay list needed by public booking UI
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

// PUBLIC ROUTE - bay availability needed by public booking UI
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
      user_name: sql`COALESCE(
        NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
        NULLIF(${bookingRequests.userName}, ''),
        ${bookingRequests.userEmail}
      )`.as('user_name')
    })
    .from(bookingRequests)
    .leftJoin(users, eq(bookingRequests.userId, users.id))
    .where(and(
      eq(bookingRequests.resourceId, parseInt(bayId, 10)),
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
      eq(availabilityBlocks.resourceId, parseInt(bayId, 10)),
      eq(availabilityBlocks.blockDate, date as string)
    ))
    .orderBy(asc(availabilityBlocks.startTime));
    
    let calendarBlocks: Array<{ start_time: string; end_time: string; block_type: string; notes: string }> = [];
    try {
      const calendar = await getGoogleCalendarClient();
      const startTime = getPacificMidnightUTC(date as string);
      const endTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000 - 1);
      
      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin: startTime.toISOString(),
          timeMax: endTime.toISOString(),
          items: [{ id: 'primary' }],
        },
      });
      
      const busySlots = response.data.calendars?.primary?.busy || [];
      calendarBlocks = busySlots.map((slot: { start?: string | null; end?: string | null }) => {
        const start = new Date(slot.start ?? '');
        const end = new Date(slot.end ?? '');
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
      if (!isProduction) logger.info('Calendar availability fetch skipped', { extra: { error: getErrorMessage(calError) } });
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
