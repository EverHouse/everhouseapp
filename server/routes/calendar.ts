import { Router } from 'express';
import { isProduction } from '../core/db';
import { getGoogleCalendarClient } from '../core/integrations';
import { CALENDAR_CONFIG, getCalendarAvailability, discoverCalendarIds, getCalendarStatus, syncConferenceRoomCalendarToBookings } from '../core/calendar/index';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';

const router = Router();

// Admin endpoint to check calendar status
router.get('/api/admin/calendars', isStaffOrAdmin, async (req, res) => {
  try {
    const status = await getCalendarStatus();
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        total_configured: status.configured.length,
        connected: status.configured.filter(c => c.status === 'connected').length,
        not_found: status.configured.filter(c => c.status === 'not_found').length,
        total_discovered: status.discovered.length
      },
      configured_calendars: status.configured,
      all_discovered_calendars: status.discovered,
      usage_mapping: {
        'MBO_Conference_Room': 'Conference Room bookings (MindBody sync)',
        'Events': 'Events sync',
        'Wellness & Classes': 'Wellness classes sync',
        'Tours Scheduled': 'Tours sync',
        'Internal Calendar': 'Closures (internal tracking)'
      }
    });
  } catch (error: any) {
    console.error('Calendar status check error:', error);
    res.status(500).json({ 
      error: 'Failed to check calendar status',
      details: error.message 
    });
  }
});

// DEPRECATED: Golf calendar sync removed - availability is now calculated from booking_requests table
// Use /api/availability/:date endpoint instead for golf simulator availability
router.get('/api/calendar-availability/golf', async (req, res) => {
  res.status(410).json({ 
    error: 'DEPRECATED: Golf calendar availability endpoint is no longer available',
    message: 'Golf simulator availability is now calculated from the booking database. Use /api/availability/:date instead.',
    deprecated_at: '2026-01-06'
  });
});

router.get('/api/calendar-availability/conference', async (req, res) => {
  try {
    const { date, duration } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'date is required (YYYY-MM-DD format)' });
    }
    
    const durationMinutes = duration ? parseInt(duration as string) : undefined;
    const result = await getCalendarAvailability('conference', date as string, durationMinutes);
    
    if (result.error) {
      return res.status(404).json({ error: result.error });
    }
    
    res.json({
      date,
      calendarName: CALENDAR_CONFIG.conference.name,
      businessHours: CALENDAR_CONFIG.conference.businessHours,
      slots: result.slots,
      availableSlots: result.slots.filter(s => s.available)
    });
  } catch (error: any) {
    if (!isProduction) console.error('Conference calendar availability error:', error);
    res.status(500).json({ error: 'Failed to fetch conference room availability' });
  }
});

router.get('/api/calendars', async (req, res) => {
  try {
    const status = await getCalendarStatus();
    res.json({
      calendars: status.discovered,
      configured: {
        conference: CALENDAR_CONFIG.conference.name,
        events: CALENDAR_CONFIG.events.name,
        wellness: CALENDAR_CONFIG.wellness.name,
        internal: CALENDAR_CONFIG.internal.name
      }
    });
  } catch (error: any) {
    if (!isProduction) console.error('Calendar list error:', error);
    res.status(500).json({ error: 'Failed to list calendars' });
  }
});

router.get('/api/calendar/availability', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }
    
    const calendar = await getGoogleCalendarClient();
    
    const startTime = new Date(start_date as string);
    startTime.setHours(0, 0, 0, 0);
    
    const endTime = new Date(end_date as string);
    endTime.setHours(23, 59, 59, 999);
    
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        items: [{ id: 'primary' }],
      },
    });
    
    const busySlots = response.data.calendars?.primary?.busy || [];
    
    res.json({
      busy: busySlots.map((slot: any) => ({
        start: slot.start,
        end: slot.end,
      })),
    });
  } catch (error: any) {
    if (!isProduction) console.error('Calendar availability error:', error);
    res.status(500).json({ error: 'Failed to fetch calendar availability', details: error.message });
  }
});

// Admin endpoint to run conference room historical backfill
router.post('/api/admin/conference-room/backfill', isAdmin, async (req, res) => {
  try {
    const { monthsBack = 12 } = req.body;
    
    console.log(`[Admin] Starting conference room backfill for ${monthsBack} months...`);
    const result = await syncConferenceRoomCalendarToBookings({ monthsBack });
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    console.log(`[Admin] Conference room backfill complete: ${result.synced} events (${result.linked} linked, ${result.created} created, ${result.skipped} skipped)`);
    
    res.json({
      success: true,
      message: `Backfill complete for ${monthsBack} months`,
      stats: {
        total_events: result.synced,
        linked_to_existing: result.linked,
        new_bookings_created: result.created,
        skipped_duplicates: result.skipped
      }
    });
  } catch (error: any) {
    console.error('Conference room backfill error:', error);
    res.status(500).json({ error: 'Failed to run backfill', details: error.message });
  }
});

// Endpoint to sync booking history from Google Calendar
// NOTE: Golf calendar sync is deprecated - only conference room sync is active
router.post('/api/admin/bookings/sync-history', isAdmin, async (req, res) => {
  try {
    const { monthsBack = 12 } = req.body;
    
    console.log(`[Admin] Starting conference room booking history sync for ${monthsBack} months...`);
    console.log(`[Admin] Note: Golf calendar sync is deprecated - bookings are done in-app only`);
    
    const conferenceResult = await syncConferenceRoomCalendarToBookings({ monthsBack });
    
    console.log(`[Admin] Conference room sync complete: ${conferenceResult.synced} events`);
    
    res.json({
      success: !conferenceResult.error,
      message: `Sync complete for ${monthsBack} months (conference room only - golf sync is deprecated)`,
      conference_room: {
        synced: conferenceResult.synced,
        linked: conferenceResult.linked,
        created: conferenceResult.created,
        skipped: conferenceResult.skipped,
        error: conferenceResult.error
      },
      booked_golf: {
        synced: 0,
        linked: 0,
        created: 0,
        skipped: 0,
        error: 'Golf calendar sync is deprecated - bookings are done in-app only'
      },
      totals: {
        synced: conferenceResult.synced,
        linked: conferenceResult.linked,
        created: conferenceResult.created,
        skipped: conferenceResult.skipped
      }
    });
  } catch (error: any) {
    console.error('Booking sync error:', error);
    res.status(500).json({ error: 'Failed to run sync', details: error.message });
  }
});

export default router;
