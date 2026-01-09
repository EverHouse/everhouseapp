import { Router } from 'express';
import { isProduction } from '../core/db';
import { db } from '../db';
import { tours } from '../../shared/schema';
import { eq, gte, asc, desc, and, sql, or, ilike } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { getGoogleCalendarClient } from '../core/integrations';
import { CALENDAR_CONFIG, getCalendarIdByName, discoverCalendarIds } from '../core/calendar/index';
import { notifyAllStaff } from '../core/staffNotifications';
import { getTodayPacific } from '../utils/dateUtils';
import { getSessionUser } from '../types/session';

function parseTimeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function extractContactFromAttendees(attendees: any[]): { email: string | null; name: string | null } {
  if (!attendees || attendees.length === 0) return { email: null, name: null };
  
  const guest = attendees.find((a: any) => !a.organizer && !a.self) || attendees[0];
  if (!guest) return { email: null, name: null };
  
  return {
    email: guest.email || null,
    name: guest.displayName || null
  };
}

const router = Router();

router.get('/api/tours', isStaffOrAdmin, async (req, res) => {
  try {
    const { date, upcoming } = req.query;
    
    let query;
    if (date) {
      query = db.select().from(tours)
        .where(eq(tours.tourDate, date as string))
        .orderBy(asc(tours.startTime));
    } else if (upcoming === 'true') {
      query = db.select().from(tours)
        .where(and(
          gte(tours.tourDate, getTodayPacific()),
          sql`${tours.status} != 'cancelled'`
        ))
        .orderBy(asc(tours.tourDate), asc(tours.startTime));
    } else {
      query = db.select().from(tours)
        .orderBy(desc(tours.tourDate), asc(tours.startTime));
    }
    
    const result = await query;
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('Tours fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch tours' });
  }
});

router.get('/api/tours/today', isStaffOrAdmin, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const result = await db.select().from(tours)
      .where(and(
        eq(tours.tourDate, today),
        sql`${tours.status} != 'cancelled'`
      ))
      .orderBy(asc(tours.startTime));
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('Today tours fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch today tours' });
  }
});

router.post('/api/tours/:id/checkin', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const staffEmail = getSessionUser(req)?.email || req.body.staffEmail;
    
    const [updated] = await db.update(tours)
      .set({
        status: 'checked_in',
        checkedInAt: new Date(),
        checkedInBy: staffEmail,
        updatedAt: new Date(),
      })
      .where(eq(tours.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Tour not found' });
    }
    
    res.json(updated);
  } catch (error: any) {
    if (!isProduction) console.error('Tour check-in error:', error);
    res.status(500).json({ error: 'Failed to check in tour' });
  }
});

router.post('/api/tours/sync', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await syncToursFromCalendar();
    res.json(result);
  } catch (error: any) {
    if (!isProduction) console.error('Tours sync error:', error);
    res.status(500).json({ error: 'Failed to sync tours' });
  }
});

router.post('/api/tours/book', async (req, res) => {
  try {
    const { firstName, lastName, email, phone } = req.body;
    
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'First name, last name, and email are required' });
    }
    
    const guestName = `${firstName} ${lastName}`.trim();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    
    const [newTour] = await db.insert(tours).values({
      title: `Tour Request - ${guestName}`,
      guestName,
      guestEmail: email,
      guestPhone: phone || null,
      tourDate: today,
      startTime: '00:00:00',
      status: 'pending',
    }).returning();
    
    await notifyAllStaff(
      'New Tour Request',
      `${guestName} requested a tour and is selecting a time`,
      'tour_scheduled',
      newTour.id,
      'tour'
    );
    
    res.json({ id: newTour.id, message: 'Tour request created' });
  } catch (error: any) {
    if (!isProduction) console.error('Tour booking error:', error);
    res.status(500).json({ error: 'Failed to create tour request' });
  }
});

router.patch('/api/tours/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [updated] = await db.update(tours)
      .set({
        status: 'scheduled',
        updatedAt: new Date(),
      })
      .where(eq(tours.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Tour not found' });
    }
    
    await notifyAllStaff(
      'Tour Confirmed',
      `${updated.guestName || 'Guest'} confirmed their tour booking`,
      'tour_scheduled',
      updated.id,
      'tour'
    );
    
    res.json(updated);
  } catch (error: any) {
    if (!isProduction) console.error('Tour confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm tour' });
  }
});

export async function syncToursFromCalendar(): Promise<{ synced: number; created: number; updated: number; cancelled: number; error?: string }> {
  try {
    await discoverCalendarIds();
    const calendar = await getGoogleCalendarClient();
    const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.tours.name);
    
    if (!calendarId) {
      return { synced: 0, created: 0, updated: 0, cancelled: 0, error: `Calendar "${CALENDAR_CONFIG.tours.name}" not found` };
    }
    
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    
    const allEvents: any[] = [];
    let pageToken: string | undefined = undefined;
    
    do {
      const response = await calendar.events.list({
        calendarId,
        timeMin: oneYearAgo.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        pageToken,
      });
      
      if (response.data.items) {
        allEvents.push(...response.data.items);
      }
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
    
    const events = allEvents;
    let created = 0;
    let updated = 0;
    let cancelled = 0;
    
    const calendarEventIds = new Set(events.map(e => e.id).filter(Boolean));
    
    for (const event of events) {
      if (!event.id || !event.summary) continue;
      
      const googleEventId = event.id;
      const title = event.summary;
      const description = event.description || '';
      
      let tourDate: string;
      let startTime: string;
      let endTime: string | null = null;
      
      if (event.start?.dateTime) {
        const startDt = new Date(event.start.dateTime);
        tourDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        startTime = startDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
        
        if (event.end?.dateTime) {
          const endDt = new Date(event.end.dateTime);
          endTime = endDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
        }
      } else if (event.start?.date) {
        tourDate = event.start.date;
        startTime = '10:00:00';
        endTime = '11:00:00';
      } else {
        continue;
      }
      
      let guestName = title;
      let guestEmail: string | null = null;
      let guestPhone: string | null = null;
      
      const attendeeInfo = extractContactFromAttendees(event.attendees || []);
      if (attendeeInfo.email) guestEmail = attendeeInfo.email;
      if (attendeeInfo.name) guestName = attendeeInfo.name;
      
      if (description) {
        const emailMatch = description.match(/email[:\s]+([^\s\n,]+@[^\s\n,]+)/i);
        if (emailMatch && !guestEmail) guestEmail = emailMatch[1].trim();
        
        const phoneMatch = description.match(/phone[:\s]+([^\n]+)/i) || description.match(/(\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/);
        if (phoneMatch) guestPhone = phoneMatch[1].trim();
        
        const nameMatch = description.match(/name[:\s]+([^\n]+)/i);
        if (nameMatch && !attendeeInfo.name) guestName = nameMatch[1].trim();
      }
      
      // Check if calendar event was marked as cancelled (title starts with "Canceled:" or "Cancelled:")
      const isCancelledEvent = /^cancell?ed:/i.test(title);
      
      const existing = await db.select().from(tours).where(eq(tours.googleCalendarId, googleEventId));
      
      if (existing.length > 0) {
        if (isCancelledEvent && existing[0].status !== 'cancelled') {
          // Calendar event was marked as cancelled - update tour status
          await db.update(tours)
            .set({
              status: 'cancelled',
              updatedAt: new Date(),
            })
            .where(eq(tours.googleCalendarId, googleEventId));
          cancelled++;
        } else if (!isCancelledEvent) {
          // Normal update for non-cancelled events
          await db.update(tours)
            .set({
              title,
              guestName,
              guestEmail,
              guestPhone,
              tourDate,
              startTime,
              endTime,
              notes: description || null,
              updatedAt: new Date(),
            })
            .where(eq(tours.googleCalendarId, googleEventId));
          updated++;
        }
      } else {
        let matchedPendingTour = null;
        if (guestEmail) {
          const eventTimeMinutes = parseTimeToMinutes(startTime);
          const pendingTours = await db.select().from(tours).where(
            and(
              ilike(tours.guestEmail, guestEmail),
              eq(tours.tourDate, tourDate),
              or(eq(tours.status, 'pending'), eq(tours.status, 'scheduled')),
              sql`${tours.googleCalendarId} IS NULL`
            )
          );
          
          matchedPendingTour = pendingTours.find(t => {
            if (t.startTime === '00:00:00') return true;
            const pendingTimeMinutes = parseTimeToMinutes(t.startTime);
            return Math.abs(eventTimeMinutes - pendingTimeMinutes) <= 15;
          });
        }
        
        if (matchedPendingTour) {
          await db.update(tours)
            .set({
              googleCalendarId: googleEventId,
              title,
              guestName: matchedPendingTour.guestName || guestName,
              guestEmail: matchedPendingTour.guestEmail || guestEmail,
              guestPhone: matchedPendingTour.guestPhone || guestPhone,
              tourDate,
              startTime,
              endTime,
              notes: description || null,
              status: 'scheduled',
              updatedAt: new Date(),
            })
            .where(eq(tours.id, matchedPendingTour.id));
          updated++;
        } else {
          await db.insert(tours).values({
            googleCalendarId: googleEventId,
            title,
            guestName,
            guestEmail,
            guestPhone,
            tourDate,
            startTime,
            endTime,
            notes: description || null,
            status: 'scheduled',
          });
          created++;
          
          const tourDateObj = new Date(tourDate);
          const formattedDate = tourDateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
          await notifyAllStaff(
            'New Tour Scheduled',
            `${guestName} scheduled a tour for ${formattedDate}`,
            'tour_scheduled',
            undefined,
            'tour'
          );
        }
      }
    }
    
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const scheduledToursWithCalendarId = await db.select().from(tours)
      .where(and(
        sql`${tours.googleCalendarId} IS NOT NULL`,
        eq(tours.status, 'scheduled'),
        sql`${tours.tourDate} >= ${today}`
      ));
    
    for (const tour of scheduledToursWithCalendarId) {
      if (tour.googleCalendarId && !calendarEventIds.has(tour.googleCalendarId)) {
        await db.update(tours)
          .set({
            status: 'cancelled',
            updatedAt: new Date(),
          })
          .where(eq(tours.id, tour.id));
        cancelled++;
        console.log(`[Tour Sync] Cancelled tour #${tour.id} (${tour.guestName || tour.title}) - calendar event deleted`);
      }
    }
    
    return { synced: events.length, created, updated, cancelled };
  } catch (error: any) {
    console.error('Error syncing tours from calendar:', error);
    return { synced: 0, created: 0, updated: 0, cancelled: 0, error: 'Failed to sync tours' };
  }
}

export async function sendTodayTourReminders(): Promise<number> {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const todayTours = await db.select().from(tours)
      .where(and(
        eq(tours.tourDate, today),
        eq(tours.status, 'scheduled')
      ))
      .orderBy(asc(tours.startTime));
    
    if (todayTours.length > 0) {
      const tourList = todayTours.map(t => {
        const time = t.startTime.substring(0, 5);
        return `${time} - ${t.guestName || t.title}`;
      }).join(', ');
      
      await notifyAllStaff(
        `${todayTours.length} Tour${todayTours.length > 1 ? 's' : ''} Today`,
        `Today's tours: ${tourList}`,
        'tour_reminder',
        undefined,
        'tour'
      );
    }
    
    return todayTours.length;
  } catch (error) {
    console.error('Error sending tour reminders:', error);
    return 0;
  }
}

export default router;
