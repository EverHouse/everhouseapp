import { Router } from 'express';
import { isProduction } from '../core/db';
import { db } from '../db';
import { tours, dismissedHubspotMeetings } from '../../shared/schema';
import { eq, gte, asc, desc, and, sql, or, ilike, inArray } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { getGoogleCalendarClient, getHubSpotClient } from '../core/integrations';
import { CALENDAR_CONFIG, getCalendarIdByName, discoverCalendarIds } from '../core/calendar/index';
import { notifyAllStaff } from '../core/notificationService';
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
    
    await notifyAllStaff(
      'Tour Checked In',
      `${updated.guestName || 'Guest'} has checked in for their tour`,
      'tour_scheduled',
      { relatedId: updated.id, relatedType: 'tour', url: '/#/staff/tours' }
    );
    
    res.json(updated);
  } catch (error: any) {
    if (!isProduction) console.error('Tour check-in error:', error);
    res.status(500).json({ error: 'Failed to check in tour' });
  }
});

router.patch('/api/tours/:id/status', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const staffEmail = getSessionUser(req)?.email || null;
    
    const validStatuses = ['scheduled', 'checked_in', 'completed', 'no-show', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }
    
    const updateData: any = {
      status,
      updatedAt: new Date(),
    };
    
    if (status === 'checked_in') {
      updateData.checkedInAt = new Date();
      updateData.checkedInBy = staffEmail;
    } else {
      updateData.checkedInAt = null;
      updateData.checkedInBy = null;
    }
    
    const [updated] = await db.update(tours)
      .set(updateData)
      .where(eq(tours.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Tour not found' });
    }
    
    if (status === 'no-show') {
      await notifyAllStaff(
        'Tour No-Show',
        `${updated.guestName || 'Guest'} did not show for their tour`,
        'tour_scheduled',
        { relatedId: updated.id, relatedType: 'tour', url: '/#/staff/tours' }
      );
    } else if (status === 'cancelled') {
      await notifyAllStaff(
        'Tour Cancelled',
        `Tour for ${updated.guestName || 'Guest'} has been cancelled`,
        'tour_scheduled',
        { relatedId: updated.id, relatedType: 'tour', url: '/#/staff/tours' }
      );
    }
    
    res.json(updated);
  } catch (error: any) {
    if (!isProduction) console.error('Tour status update error:', error);
    res.status(500).json({ error: 'Failed to update tour status' });
  }
});

router.post('/api/tours/sync', isStaffOrAdmin, async (req, res) => {
  try {
    const { source } = req.query;
    let result;
    
    if (source === 'calendar') {
      result = await syncToursFromCalendar();
    } else {
      result = await syncToursFromHubSpot();
    }
    
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
      { relatedId: newTour.id, relatedType: 'tour', url: '/#/staff/tours' }
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
      { relatedId: updated.id, relatedType: 'tour', url: '/#/staff/tours' }
    );
    
    res.json(updated);
  } catch (error: any) {
    if (!isProduction) console.error('Tour confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm tour' });
  }
});

router.get('/api/tours/needs-review', isStaffOrAdmin, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    let meetings: HubSpotMeetingDetails[];
    
    if (!forceRefresh && hubspotMeetingsCache && (Date.now() - hubspotMeetingsCache.timestamp) < HUBSPOT_CACHE_TTL_MS) {
      meetings = hubspotMeetingsCache.data;
    } else {
      meetings = await fetchHubSpotTourMeetings();
      hubspotMeetingsCache = { data: meetings, timestamp: Date.now() };
    }
    
    const existingToursByHubspotId = await db.select().from(tours)
      .where(sql`${tours.hubspotMeetingId} IS NOT NULL`);
    const linkedHubspotIds = new Set(existingToursByHubspotId.map(t => t.hubspotMeetingId));
    
    const dismissedMeetings = await db.select().from(dismissedHubspotMeetings);
    const dismissedIds = new Set(dismissedMeetings.map(d => d.hubspotMeetingId));
    
    const unmatchedMeetings: any[] = [];
    
    for (const meeting of meetings) {
      if (linkedHubspotIds.has(meeting.hubspotMeetingId)) continue;
      if (dismissedIds.has(meeting.hubspotMeetingId)) continue;
      
      let potentialMatches: any[] = [];
      if (meeting.guestEmail) {
        const meetingTimeMinutes = parseTimeToMinutes(meeting.startTime);
        const candidateTours = await db.select().from(tours).where(
          and(
            ilike(tours.guestEmail, meeting.guestEmail),
            eq(tours.tourDate, meeting.tourDate),
            sql`${tours.hubspotMeetingId} IS NULL`
          )
        );
        
        potentialMatches = candidateTours.filter(t => {
          if (t.startTime === '00:00:00') return true;
          const tourTimeMinutes = parseTimeToMinutes(t.startTime);
          return Math.abs(meetingTimeMinutes - tourTimeMinutes) <= 15;
        }).map(t => ({
          id: t.id,
          guestName: t.guestName,
          guestEmail: t.guestEmail,
          tourDate: t.tourDate,
          startTime: t.startTime,
          status: t.status,
        }));
      }
      
      unmatchedMeetings.push({
        ...meeting,
        potentialMatches,
        wouldBackfill: potentialMatches.length > 0,
      });
    }
    
    res.json({ unmatchedMeetings });
  } catch (error: any) {
    if (!isProduction) console.error('Tours needs-review error:', error);
    res.status(500).json({ error: 'Failed to fetch HubSpot meetings needing review' });
  }
});

router.post('/api/tours/link-hubspot', isStaffOrAdmin, async (req, res) => {
  try {
    const { hubspotMeetingId, tourId } = req.body;
    
    if (!hubspotMeetingId || !tourId) {
      return res.status(400).json({ error: 'hubspotMeetingId and tourId are required' });
    }
    
    const existingLink = await db.select().from(tours)
      .where(eq(tours.hubspotMeetingId, hubspotMeetingId));
    if (existingLink.length > 0) {
      return res.status(400).json({ error: 'This HubSpot meeting is already linked to a tour' });
    }
    
    const meetings = await fetchHubSpotTourMeetings();
    const meeting = meetings.find(m => m.hubspotMeetingId === hubspotMeetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'HubSpot meeting not found' });
    }
    
    const [updated] = await db.update(tours)
      .set({
        hubspotMeetingId,
        title: meeting.title,
        guestName: meeting.guestName,
        guestEmail: meeting.guestEmail,
        guestPhone: meeting.guestPhone,
        tourDate: meeting.tourDate,
        startTime: meeting.startTime,
        endTime: meeting.endTime,
        notes: meeting.notes,
        updatedAt: new Date(),
      })
      .where(eq(tours.id, tourId))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Tour not found' });
    }
    
    res.json({ success: true, tour: updated });
  } catch (error: any) {
    if (!isProduction) console.error('Link HubSpot error:', error);
    res.status(500).json({ error: 'Failed to link HubSpot meeting to tour' });
  }
});

router.post('/api/tours/create-from-hubspot', isStaffOrAdmin, async (req, res) => {
  try {
    const { hubspotMeetingId } = req.body;
    
    if (!hubspotMeetingId) {
      return res.status(400).json({ error: 'hubspotMeetingId is required' });
    }
    
    const existingLink = await db.select().from(tours)
      .where(eq(tours.hubspotMeetingId, hubspotMeetingId));
    if (existingLink.length > 0) {
      return res.status(400).json({ error: 'This HubSpot meeting is already linked to a tour' });
    }
    
    const meetings = await fetchHubSpotTourMeetings();
    const meeting = meetings.find(m => m.hubspotMeetingId === hubspotMeetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'HubSpot meeting not found' });
    }
    
    const [newTour] = await db.insert(tours).values({
      hubspotMeetingId,
      title: meeting.title,
      guestName: meeting.guestName,
      guestEmail: meeting.guestEmail,
      guestPhone: meeting.guestPhone,
      tourDate: meeting.tourDate,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      notes: meeting.notes,
      status: meeting.isCancelled ? 'cancelled' : 'scheduled',
    }).returning();
    
    res.json({ success: true, tour: newTour });
  } catch (error: any) {
    if (!isProduction) console.error('Create from HubSpot error:', error);
    res.status(500).json({ error: 'Failed to create tour from HubSpot meeting' });
  }
});

router.post('/api/tours/dismiss-hubspot', isStaffOrAdmin, async (req, res) => {
  try {
    const { hubspotMeetingId, notes } = req.body;
    const staffEmail = getSessionUser(req)?.email || null;
    
    if (!hubspotMeetingId) {
      return res.status(400).json({ error: 'hubspotMeetingId is required' });
    }
    
    const existing = await db.select().from(dismissedHubspotMeetings)
      .where(eq(dismissedHubspotMeetings.hubspotMeetingId, hubspotMeetingId));
    if (existing.length > 0) {
      return res.status(400).json({ error: 'This HubSpot meeting is already dismissed' });
    }
    
    const [dismissed] = await db.insert(dismissedHubspotMeetings).values({
      hubspotMeetingId,
      dismissedBy: staffEmail,
      notes: notes || null,
    }).returning();
    
    res.json({ success: true, dismissed });
  } catch (error: any) {
    if (!isProduction) console.error('Dismiss HubSpot error:', error);
    res.status(500).json({ error: 'Failed to dismiss HubSpot meeting' });
  }
});

interface HubSpotMeetingDetails {
  hubspotMeetingId: string;
  title: string;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  tourDate: string;
  startTime: string;
  endTime: string | null;
  notes: string | null;
  isCancelled: boolean;
}

const HUBSPOT_CACHE_TTL_MS = 5 * 60 * 1000;
let hubspotMeetingsCache: { data: HubSpotMeetingDetails[]; timestamp: number } | null = null;

async function fetchHubSpotTourMeetings(): Promise<HubSpotMeetingDetails[]> {
  const hubspot = await getHubSpotClient();
  
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  const allMeetings: any[] = [];
  let after: string | undefined = undefined;
  
  do {
    const response = await hubspot.crm.objects.meetings.basicApi.getPage(
      100,
      after,
      [
        'hs_meeting_title',
        'hs_meeting_start_time',
        'hs_meeting_end_time',
        'hs_meeting_outcome',
        'hs_meeting_body',
        'hs_internal_meeting_notes',
        'hs_meeting_external_url',
        'hs_timestamp',
        'hs_meeting_location'
      ],
      undefined,
      ['contacts']
    );
    
    if (response.results) {
      const filteredMeetings = response.results.filter((meeting: any) => {
        const startTime = meeting.properties.hs_meeting_start_time;
        if (!startTime) return false;
        const meetingDate = new Date(startTime);
        if (meetingDate < oneYearAgo) return false;
        const title = (meeting.properties.hs_meeting_title || '').toLowerCase();
        const location = (meeting.properties.hs_meeting_location || '').toLowerCase();
        const externalUrl = (meeting.properties.hs_meeting_external_url || '').toLowerCase();
        return title.includes('tour') || 
               location.includes('tourbooking') || 
               externalUrl.includes('tourbooking');
      });
      allMeetings.push(...filteredMeetings);
    }
    after = response.paging?.next?.after;
  } while (after);
  
  const result: HubSpotMeetingDetails[] = [];
  
  for (const meeting of allMeetings) {
    const props = meeting.properties;
    const startTimeRaw = props.hs_meeting_start_time;
    if (!startTimeRaw) continue;
    
    const hubspotMeetingId = meeting.id;
    const title = props.hs_meeting_title || 'Tour';
    const endTimeRaw = props.hs_meeting_end_time;
    const outcome = (props.hs_meeting_outcome || '').toLowerCase();
    const notes = props.hs_meeting_body || props.hs_internal_meeting_notes || '';
    
    const startDt = new Date(startTimeRaw);
    const tourDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const startTime = startDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
    
    let endTime: string | null = null;
    if (endTimeRaw) {
      const endDt = new Date(endTimeRaw);
      endTime = endDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
    }
    
    let guestName: string | null = null;
    let guestEmail: string | null = null;
    let guestPhone: string | null = null;
    
    const associations = meeting.associations;
    if (associations?.contacts?.results?.length > 0) {
      const contactId = associations.contacts.results[0].id;
      try {
        const contact = await hubspot.crm.contacts.basicApi.getById(contactId, [
          'firstname', 'lastname', 'email', 'phone'
        ]);
        const firstName = contact.properties.firstname || '';
        const lastName = contact.properties.lastname || '';
        guestName = `${firstName} ${lastName}`.trim() || null;
        guestEmail = contact.properties.email || null;
        guestPhone = contact.properties.phone || null;
      } catch (e) {
        if (!isProduction) console.warn(`[HubSpot] Failed to fetch contact ${contactId}:`, e);
      }
    }
    
    const cancelledOutcomes = ['canceled', 'cancelled', 'no show', 'no_show', 'noshow', 'rescheduled'];
    const isCancelled = cancelledOutcomes.includes(outcome);
    
    result.push({
      hubspotMeetingId,
      title,
      guestName,
      guestEmail,
      guestPhone,
      tourDate,
      startTime,
      endTime,
      notes: notes || null,
      isCancelled,
    });
  }
  
  return result;
}

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

export async function syncToursFromHubSpot(): Promise<{ synced: number; created: number; updated: number; cancelled: number; error?: string }> {
  try {
    const hubspot = await getHubSpotClient();
    
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    const allMeetings: any[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await hubspot.crm.objects.meetings.basicApi.getPage(
        100,
        after,
        [
          'hs_meeting_title',
          'hs_meeting_start_time',
          'hs_meeting_end_time',
          'hs_meeting_outcome',
          'hs_meeting_body',
          'hs_internal_meeting_notes',
          'hs_meeting_external_url',
          'hs_timestamp',
          'hs_meeting_location'
        ],
        undefined,
        ['contacts']
      );
      
      if (response.results) {
        const filteredMeetings = response.results.filter((meeting: any) => {
          const startTime = meeting.properties.hs_meeting_start_time;
          if (!startTime) return false;
          const meetingDate = new Date(startTime);
          if (meetingDate < oneYearAgo) return false;
          const title = (meeting.properties.hs_meeting_title || '').toLowerCase();
          const location = (meeting.properties.hs_meeting_location || '').toLowerCase();
          const externalUrl = (meeting.properties.hs_meeting_external_url || '').toLowerCase();
          return title.includes('tour') || 
                 location.includes('tourbooking') || 
                 externalUrl.includes('tourbooking');
        });
        allMeetings.push(...filteredMeetings);
      }
      after = response.paging?.next?.after;
    } while (after);
    
    let created = 0;
    let updated = 0;
    let cancelled = 0;
    
    const hubspotMeetingIds = new Set(allMeetings.map(m => m.id));
    
    for (const meeting of allMeetings) {
      const hubspotMeetingId = meeting.id;
      const props = meeting.properties;
      
      const title = props.hs_meeting_title || 'Tour';
      const startTimeRaw = props.hs_meeting_start_time;
      const endTimeRaw = props.hs_meeting_end_time;
      const outcome = (props.hs_meeting_outcome || '').toLowerCase();
      const notes = props.hs_meeting_body || props.hs_internal_meeting_notes || '';
      
      if (!startTimeRaw) continue;
      
      const startDt = new Date(startTimeRaw);
      const tourDate = startDt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const startTime = startDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
      
      let endTime: string | null = null;
      if (endTimeRaw) {
        const endDt = new Date(endTimeRaw);
        endTime = endDt.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
      }
      
      let guestName: string | null = null;
      let guestEmail: string | null = null;
      let guestPhone: string | null = null;
      
      const associations = meeting.associations;
      if (associations?.contacts?.results?.length > 0) {
        const contactId = associations.contacts.results[0].id;
        try {
          const contact = await hubspot.crm.contacts.basicApi.getById(contactId, [
            'firstname', 'lastname', 'email', 'phone'
          ]);
          const firstName = contact.properties.firstname || '';
          const lastName = contact.properties.lastname || '';
          guestName = `${firstName} ${lastName}`.trim() || null;
          guestEmail = contact.properties.email || null;
          guestPhone = contact.properties.phone || null;
        } catch (e) {
          if (!isProduction) console.warn(`[HubSpot Sync] Failed to fetch contact ${contactId}:`, e);
        }
      }
      
      const cancelledOutcomes = ['canceled', 'cancelled', 'no show', 'no_show', 'noshow', 'rescheduled'];
      const isCancelled = cancelledOutcomes.includes(outcome);
      
      const existing = await db.select().from(tours).where(eq(tours.hubspotMeetingId, hubspotMeetingId));
      
      if (existing.length > 0) {
        if (isCancelled && existing[0].status !== 'cancelled') {
          await db.update(tours)
            .set({
              status: 'cancelled',
              updatedAt: new Date(),
            })
            .where(eq(tours.hubspotMeetingId, hubspotMeetingId));
          cancelled++;
        } else if (!isCancelled) {
          await db.update(tours)
            .set({
              title,
              guestName: guestName || existing[0].guestName,
              guestEmail: guestEmail || existing[0].guestEmail,
              guestPhone: guestPhone || existing[0].guestPhone,
              tourDate,
              startTime,
              endTime,
              notes: notes || null,
              updatedAt: new Date(),
            })
            .where(eq(tours.hubspotMeetingId, hubspotMeetingId));
          updated++;
        }
      } else {
        let matchedExistingTour = null;
        if (guestEmail) {
          const eventTimeMinutes = parseTimeToMinutes(startTime);
          const existingTours = await db.select().from(tours).where(
            and(
              ilike(tours.guestEmail, guestEmail),
              eq(tours.tourDate, tourDate),
              or(eq(tours.status, 'pending'), eq(tours.status, 'scheduled'), eq(tours.status, 'checked_in')),
              sql`${tours.hubspotMeetingId} IS NULL`
            )
          );
          
          matchedExistingTour = existingTours.find(t => {
            if (t.startTime === '00:00:00') return true;
            const existingTimeMinutes = parseTimeToMinutes(t.startTime);
            return Math.abs(eventTimeMinutes - existingTimeMinutes) <= 15;
          });
        }
        
        if (matchedExistingTour) {
          await db.update(tours)
            .set({
              hubspotMeetingId,
              title,
              guestName: matchedExistingTour.guestName || guestName,
              guestEmail: matchedExistingTour.guestEmail || guestEmail,
              guestPhone: matchedExistingTour.guestPhone || guestPhone,
              tourDate,
              startTime,
              endTime,
              notes: notes || null,
              status: isCancelled ? 'cancelled' : (matchedExistingTour.status === 'checked_in' ? 'checked_in' : 'scheduled'),
              updatedAt: new Date(),
            })
            .where(eq(tours.id, matchedExistingTour.id));
          updated++;
        } else {
          console.log(`[HubSpot Tour Sync] No existing match found for meeting ${hubspotMeetingId} (${guestEmail || 'no email'}, ${tourDate} ${startTime}), creating new tour`);
          await db.insert(tours).values({
            hubspotMeetingId,
            title,
            guestName,
            guestEmail,
            guestPhone,
            tourDate,
            startTime,
            endTime,
            notes: notes || null,
            status: isCancelled ? 'cancelled' : 'scheduled',
          });
          created++;
          
          if (!isCancelled) {
            const tourDateObj = new Date(tourDate);
            const formattedDate = tourDateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
            await notifyAllStaff(
              'New Tour Scheduled',
              `${guestName || 'Guest'} scheduled a tour for ${formattedDate}`,
              'tour_scheduled',
              undefined,
              'tour'
            );
          }
        }
      }
    }
    
    console.log(`[HubSpot Tour Sync] Completed: ${allMeetings.length} meetings processed, ${created} created, ${updated} updated, ${cancelled} cancelled`);
    
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const scheduledToursWithHubSpotId = await db.select().from(tours)
      .where(and(
        sql`${tours.hubspotMeetingId} IS NOT NULL`,
        eq(tours.status, 'scheduled'),
        sql`${tours.tourDate} >= ${today}`
      ));
    
    for (const tour of scheduledToursWithHubSpotId) {
      if (tour.hubspotMeetingId && !hubspotMeetingIds.has(tour.hubspotMeetingId)) {
        await db.update(tours)
          .set({
            status: 'cancelled',
            updatedAt: new Date(),
          })
          .where(eq(tours.id, tour.id));
        cancelled++;
        console.log(`[HubSpot Tour Sync] Cancelled tour #${tour.id} (${tour.guestName || tour.title}) - meeting deleted in HubSpot`);
      }
    }
    
    return { synced: allMeetings.length, created, updated, cancelled };
  } catch (error: any) {
    console.error('Error syncing tours from HubSpot:', error);
    return { synced: 0, created: 0, updated: 0, cancelled: 0, error: error.message || 'Failed to sync tours from HubSpot' };
  }
}

export default router;
