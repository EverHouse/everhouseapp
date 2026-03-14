import { logger } from '../core/logger';
import { Router } from 'express';
import { isProduction } from '../core/db';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getGoogleCalendarClient } from '../core/integrations';
import { CALENDAR_CONFIG, getResourceConfig, getCalendarAvailability, getCalendarStatus, syncConferenceRoomCalendarToBookings, getCalendarIdByName } from '../core/calendar/index';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { getErrorMessage, safeErrorDetail } from '../utils/errorUtils';
import { broadcastToStaff } from '../core/websocket';

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
  } catch (error: unknown) {
    logger.error('Calendar status check error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ 
      error: 'Failed to check calendar status',
      details: getErrorMessage(error) 
    });
  }
});

// DEPRECATED: Golf calendar sync removed - availability is now calculated from booking_requests table
// Use /api/availability/:date endpoint instead for golf simulator availability
// PUBLIC ROUTE
router.get('/api/calendar-availability/golf', async (req, res) => {
  try {
    res.status(410).json({ 
      error: 'DEPRECATED: Golf calendar availability endpoint is no longer available',
      message: 'Golf simulator availability is now calculated from the booking database. Use /api/availability/:date instead.',
      deprecated_at: '2026-01-06'
    });
  } catch (error: unknown) {
    logger.error('Failed to fetch calendar availability', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.status(500).json({ error: 'Failed to fetch calendar availability' });
  }
});

// PUBLIC ROUTE
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
    
    const conferenceConfig = await getResourceConfig('conference', date as string);
    res.json({
      date,
      calendarName: CALENDAR_CONFIG.conference.name,
      businessHours: conferenceConfig.businessHours,
      slots: result.slots,
      availableSlots: result.slots.filter(s => s.available)
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Conference calendar availability error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch conference room availability' });
  }
});

// PUBLIC ROUTE
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
  } catch (error: unknown) {
    if (!isProduction) logger.error('Calendar list error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to list calendars' });
  }
});

// PUBLIC ROUTE
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
      busy: busySlots.map((slot: Record<string, unknown>) => ({
        start: slot.start,
        end: slot.end,
      })),
    });
  } catch (error: unknown) {
    if (!isProduction) logger.error('Calendar availability error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch calendar availability', details: safeErrorDetail(error) });
  }
});

// Admin endpoint to run conference room historical backfill
router.post('/api/admin/conference-room/backfill', isAdmin, async (req, res) => {
  try {
    const { monthsBack = 12 } = req.body;
    
    logger.info('[Admin] Starting conference room backfill for months...', { extra: { monthsBack } });
    const result = await syncConferenceRoomCalendarToBookings({ monthsBack });
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    logger.info('[Admin] Conference room backfill complete: events ( linked, created, skipped)', { extra: { resultSynced: result.synced, resultLinked: result.linked, resultCreated: result.created, resultSkipped: result.skipped } });
    
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
  } catch (error: unknown) {
    logger.error('Conference room backfill error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run backfill', details: safeErrorDetail(error) });
  }
});

// Endpoint to sync booking history from Google Calendar
router.post('/api/admin/bookings/sync-history', isAdmin, async (req, res) => {
  try {
    const { monthsBack = 12 } = req.body;
    
    logger.info('[Admin] Starting conference room booking history sync for months...', { extra: { monthsBack } });
    
    const conferenceResult = await syncConferenceRoomCalendarToBookings({ monthsBack });
    
    logger.info('[Admin] Conference room sync complete: events', { extra: { conferenceResultSynced: conferenceResult.synced } });
    
    res.json({
      success: !conferenceResult.error,
      message: `Sync complete for ${monthsBack} months`,
      conference_room: {
        synced: conferenceResult.synced,
        linked: conferenceResult.linked,
        created: conferenceResult.created,
        skipped: conferenceResult.skipped,
        error: conferenceResult.error
      },
      totals: {
        synced: conferenceResult.synced,
        linked: conferenceResult.linked,
        created: conferenceResult.created,
        skipped: conferenceResult.skipped
      }
    });
  } catch (error: unknown) {
    logger.error('Booking sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to run sync', details: safeErrorDetail(error) });
  }
});

// Quick sync for conference room calendar (used by sync button on bookings page)
router.post('/api/admin/bookings/sync-calendar', isStaffOrAdmin, async (req, res) => {
  try {
    logger.info('[Admin] Running conference room calendar sync...');
    
    const conferenceResult = await syncConferenceRoomCalendarToBookings();
    
    logger.info('[Admin] Conference room sync complete: events', { extra: { conferenceResultSynced: conferenceResult.synced } });
    
    res.json({
      success: !conferenceResult.error,
      conference_room: {
        synced: conferenceResult.synced,
        linked: conferenceResult.linked,
        created: conferenceResult.created,
        skipped: conferenceResult.skipped,
        error: conferenceResult.error
      }
    });
  } catch (error: unknown) {
    logger.error('Calendar sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync calendar' });
  }
});

let calendarCleanupRunning = false;

router.get('/api/admin/calendar/cleanup-status', isStaffOrAdmin, (_req, res) => {
  res.json({ running: calendarCleanupRunning });
});

router.post('/api/admin/calendar/migrate-clean-descriptions', isAdmin, async (req, res) => {
  if (calendarCleanupRunning) {
    return res.status(409).json({ success: false, error: 'Calendar cleanup is already running. Please wait for it to finish.' });
  }

  const THROTTLE_MS = 150;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  calendarCleanupRunning = true;
  res.json({ success: true, message: 'Calendar description cleanup started in background.' });

  try {
    const calendar = await getGoogleCalendarClient();
    const results = {
      wellness: { total: 0, cleaned: 0, errors: 0 },
      events: { total: 0, cleaned: 0, errors: 0 },
      closures: { total: 0, cleaned: 0, errors: 0 },
    };

    const wellnessCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.wellness.name);
    if (wellnessCalendarId) {
      const wellnessRows = await db.execute(
        sql`SELECT id, title, instructor, description, category, duration, spots, status, 
                   image_url, external_url, google_calendar_id, date, time
            FROM wellness_classes 
            WHERE google_calendar_id IS NOT NULL AND is_active = true`
      );
      results.wellness.total = wellnessRows.rows.length;

      for (const row of wellnessRows.rows as unknown as Array<Record<string, unknown>>) {
        try {
          const extendedProps: Record<string, string> = {
            'ehApp_type': 'wellness',
            'ehApp_id': String(row.id),
          };
          if (row.image_url) extendedProps['ehApp_imageUrl'] = row.image_url as string;
          if (row.external_url) extendedProps['ehApp_externalUrl'] = row.external_url as string;
          if (row.category) extendedProps['ehApp_category'] = row.category as string;
          if (row.duration) extendedProps['ehApp_duration'] = row.duration as string;
          if (row.spots) extendedProps['ehApp_spots'] = row.spots as string;
          if (row.status) extendedProps['ehApp_status'] = row.status as string;

          await calendar.events.patch({
            calendarId: wellnessCalendarId,
            eventId: row.google_calendar_id as string,
            requestBody: {
              summary: `${row.title} with ${row.instructor}`,
              description: (row.description as string) || '',
              extendedProperties: { private: extendedProps },
            },
          });
          results.wellness.cleaned++;
        } catch (err: unknown) {
          results.wellness.errors++;
          logger.warn(`[Migration] Failed to clean wellness #${row.id}`, { error: getErrorMessage(err) });
        }
        await sleep(THROTTLE_MS);
      }
    }

    const eventsCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.events.name);
    if (eventsCalendarId) {
      const eventRows = await db.execute(
        sql`SELECT id, title, description, category, image_url, external_url, 
                   max_attendees, visibility, requires_rsvp, location, google_calendar_id
            FROM events 
            WHERE google_calendar_id IS NOT NULL`
      );
      results.events.total = eventRows.rows.length;

      for (const row of eventRows.rows as unknown as Array<Record<string, unknown>>) {
        try {
          const extendedProps: Record<string, string> = {
            'ehApp_type': 'event',
            'ehApp_id': String(row.id),
          };
          if (row.image_url) extendedProps['ehApp_imageUrl'] = row.image_url as string;
          if (row.external_url) extendedProps['ehApp_externalUrl'] = row.external_url as string;
          if (row.category) extendedProps['ehApp_category'] = row.category as string;
          if (row.max_attendees) extendedProps['ehApp_maxAttendees'] = String(row.max_attendees);
          if (row.visibility) extendedProps['ehApp_visibility'] = row.visibility as string;
          if (row.requires_rsvp !== null && row.requires_rsvp !== undefined) extendedProps['ehApp_requiresRsvp'] = String(row.requires_rsvp);
          if (row.location) extendedProps['ehApp_location'] = row.location as string;

          await calendar.events.patch({
            calendarId: eventsCalendarId,
            eventId: row.google_calendar_id as string,
            requestBody: {
              summary: row.title as string,
              description: (row.description as string) || '',
              extendedProperties: { private: extendedProps },
            },
          });
          results.events.cleaned++;
        } catch (err: unknown) {
          results.events.errors++;
          logger.warn(`[Migration] Failed to clean event #${row.id}`, { error: getErrorMessage(err) });
        }
        await sleep(THROTTLE_MS);
      }
    }

    const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);
    if (internalCalendarId) {
      const closureRows = await db.execute(
        sql`SELECT id, title, reason, notes, affected_areas, notify_members, internal_calendar_id
            FROM facility_closures 
            WHERE internal_calendar_id IS NOT NULL AND is_active = true`
      );
      results.closures.total = closureRows.rows.length;

      for (const row of closureRows.rows as unknown as Array<Record<string, unknown>>) {
        try {
          const extendedProps: Record<string, string> = {
            'ehApp_type': 'closure',
          };
          if (row.affected_areas) extendedProps['ehApp_affectedAreas'] = row.affected_areas as string;
          extendedProps['ehApp_notifyMembers'] = row.notify_members ? 'true' : 'false';
          if (row.notes) extendedProps['ehApp_notes'] = row.notes as string;

          const eventIds = (row.internal_calendar_id as string).split(',').map(id => id.trim()).filter(Boolean);
          for (const eventId of eventIds) {
            try {
              const cleanDescription = (row.notes as string) || (row.reason as string) || '';
              await calendar.events.patch({
                calendarId: internalCalendarId,
                eventId,
                requestBody: {
                  description: cleanDescription,
                  extendedProperties: { private: extendedProps },
                },
              });
            } catch (patchErr: unknown) {
              logger.warn(`[Migration] Failed to patch closure event ${eventId} for closure #${row.id}`, { error: getErrorMessage(patchErr) });
            }
            await sleep(THROTTLE_MS);
          }
          results.closures.cleaned++;
        } catch (err: unknown) {
          results.closures.errors++;
          logger.warn(`[Migration] Failed to clean closure #${row.id}`, { error: getErrorMessage(err) });
        }
      }
    }

    logger.info('[Migration] Calendar description cleanup complete', { extra: results });
    calendarCleanupRunning = false;
    broadcastToStaff({
      type: 'calendar_cleanup_complete',
      data: { success: true, results }
    });
  } catch (error: unknown) {
    logger.error('[Migration] Calendar cleanup failed', { error: error instanceof Error ? error : new Error(String(error)) });
    calendarCleanupRunning = false;
    broadcastToStaff({
      type: 'calendar_cleanup_complete',
      data: { success: false, error: getErrorMessage(error) }
    });
  }
});

router.post('/api/admin/calendar/restore-closure-notes', isAdmin, async (req, res) => {
  try {
    const calendar = await getGoogleCalendarClient();
    const internalCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.internal.name);

    if (!internalCalendarId) {
      return res.status(404).json({ success: false, error: 'Internal calendar not found' });
    }

    const closureRows = await db.execute(
      sql`SELECT id, title, notes, internal_calendar_id FROM facility_closures WHERE internal_calendar_id IS NOT NULL AND is_active = true`
    );

    let restored = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of closureRows.rows as unknown as Array<{ id: number; title: string; notes: string | null; internal_calendar_id: string }>) {
      const eventIds = row.internal_calendar_id.split(',').map(id => id.trim()).filter(Boolean);
      const eventId = eventIds[0];
      if (!eventId) { skipped++; continue; }

      try {
        const event = await calendar.events.get({ calendarId: internalCalendarId, eventId });
        const extProps = event.data.extendedProperties?.private || {};
        const savedNotes = extProps['ehApp_notes'];

        if (savedNotes && savedNotes.trim() && (!row.notes || !row.notes.trim() || row.notes.trim().length < savedNotes.trim().length)) {
          await db.execute(
            sql`UPDATE facility_closures SET notes = ${savedNotes.trim()} WHERE id = ${row.id}`
          );
          logger.info(`[Recovery] Restored notes for closure #${row.id}: ${row.title}`);
          restored++;
        } else {
          skipped++;
        }
      } catch (err: unknown) {
        errors++;
        logger.warn(`[Recovery] Failed to restore closure #${row.id}`, { error: getErrorMessage(err) });
      }
    }

    logger.info('[Recovery] Closure notes restoration complete', { extra: { restored, skipped, errors } });
    res.json({ success: true, restored, skipped, errors });
  } catch (error: unknown) {
    logger.error('[Recovery] Closure notes restoration failed', { error: getErrorMessage(error) });
    res.status(500).json({ success: false, error: 'Failed to restore closure notes' });
  }
});

export default router;
