import { schedulerTracker } from '../core/schedulerTracker';
import { syncGoogleCalendarEvents, syncWellnessCalendarEvents, syncInternalCalendarToClosures, syncConferenceRoomCalendarToBookings } from '../core/calendar/index';
import { syncToursFromCalendar } from '../routes/tours';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const runBackgroundSync = async () => {
  try {
    const eventsResult = await syncGoogleCalendarEvents().catch(() => ({ synced: 0, created: 0, updated: 0, deleted: 0, error: 'Events sync failed' }));
    const wellnessResult = await syncWellnessCalendarEvents().catch(() => ({ synced: 0, created: 0, updated: 0, deleted: 0, error: 'Wellness sync failed' }));
    const toursResult = await syncToursFromCalendar().catch(() => ({ synced: 0, created: 0, updated: 0, cancelled: 0, error: 'Tours sync failed' }));
    const closuresResult = await syncInternalCalendarToClosures().catch(() => ({ synced: 0, created: 0, updated: 0, deleted: 0, error: 'Closures sync failed' }));
    const confRoomResult = await syncConferenceRoomCalendarToBookings().catch(() => ({ synced: 0, linked: 0, created: 0, skipped: 0, error: 'Conference room sync failed' })) as { synced: number; linked: number; created: number; skipped: number; error?: string; warning?: string };
    const eventsMsg = eventsResult.error ? eventsResult.error : `${eventsResult.synced} synced`;
    const wellnessMsg = wellnessResult.error ? wellnessResult.error : `${wellnessResult.synced} synced`;
    const toursMsg = toursResult.error ? toursResult.error : `${toursResult.synced} synced`;
    const closuresMsg = closuresResult.error ? closuresResult.error : `${closuresResult.synced} synced`;
    const confRoomMsg = confRoomResult.error ? confRoomResult.error : (confRoomResult.warning ? 'not configured' : `${confRoomResult.synced} synced`);
    console.log(`[Auto-sync] Events: ${eventsMsg}, Wellness: ${wellnessMsg}, Tours: ${toursMsg}, Closures: ${closuresMsg}, ConfRoom: ${confRoomMsg}`);
  } catch (err) {
    console.error('[Auto-sync] Calendar sync failed:', err);
    schedulerTracker.recordRun('Background Sync', false, String(err));
  } finally {
    setTimeout(runBackgroundSync, SYNC_INTERVAL_MS);
  }
};

export function startBackgroundSyncScheduler(): void {
  setTimeout(runBackgroundSync, SYNC_INTERVAL_MS);
  console.log('[Startup] Background calendar sync enabled (every 5 minutes, first sync in 5 minutes)');
}
