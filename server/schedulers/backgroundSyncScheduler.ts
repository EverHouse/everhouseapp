import { schedulerTracker } from '../core/schedulerTracker';
import { syncGoogleCalendarEvents, syncWellnessCalendarEvents, syncInternalCalendarToClosures, syncConferenceRoomCalendarToBookings } from '../core/calendar/index';
import { alertOnSyncFailure } from '../core/dataAlerts';
import { logger } from '../core/logger';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const consecutiveFailures: Record<string, number> = {};
let currentTimeoutId: NodeJS.Timeout | null = null;
const ALERT_THRESHOLD = 2;

const lastSyncTimestamps: Record<string, { at: Date; success: boolean; error?: string }> = {};

export function getCalendarSyncHealth(): Record<string, { lastSyncAt: string | null; success: boolean; consecutiveFailures: number; error?: string }> {
  const names = ['Events', 'Wellness', 'Closures', 'ConfRoom'];
  const result: Record<string, { lastSyncAt: string | null; success: boolean; consecutiveFailures: number; error?: string }> = {};
  for (const name of names) {
    const ts = lastSyncTimestamps[name];
    result[name] = {
      lastSyncAt: ts?.at?.toISOString() ?? null,
      success: ts?.success ?? false,
      consecutiveFailures: consecutiveFailures[name] || 0,
      error: ts?.error,
    };
  }
  return result;
}

async function syncWithRetry<T extends { error?: string }>(
  name: string,
  syncFn: () => Promise<T>,
  fallback: T
): Promise<T> {
  let result: T;
  try {
    result = await syncFn();
  } catch (err) {
    logger.debug(`[Auto-sync] ${name} initial attempt threw, using fallback`, { error: err });
    result = fallback;
  }

  if (!result.error) {
    if (consecutiveFailures[name] && consecutiveFailures[name] > 0) {
      logger.info(`[Auto-sync] ${name} recovered after ${consecutiveFailures[name]} consecutive failure(s)`);
    }
    consecutiveFailures[name] = 0;
    lastSyncTimestamps[name] = { at: new Date(), success: true };
    return result;
  }

  logger.warn(`[Auto-sync] ${name} failed, retrying in 5s...`);
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    result = await syncFn();
  } catch (err) {
    logger.debug(`[Auto-sync] ${name} retry attempt threw, using fallback`, { error: err });
    result = fallback;
  }

  if (!result.error) {
    consecutiveFailures[name] = 0;
    lastSyncTimestamps[name] = { at: new Date(), success: true };
    logger.info(`[Auto-sync] ${name} succeeded on retry`);
    return result;
  }

  consecutiveFailures[name] = (consecutiveFailures[name] || 0) + 1;
  lastSyncTimestamps[name] = { at: new Date(), success: false, error: result.error };
  logger.error(`[Auto-sync] ${name} failed after retry (consecutive: ${consecutiveFailures[name]})`);

  if (consecutiveFailures[name] >= ALERT_THRESHOLD) {
    alertOnSyncFailure(
      'calendar',
      `${name} calendar sync`,
      new Error(result.error || `${name} sync failed`),
      { calendarName: name }
    ).catch((err: unknown) => {
      logger.error(`[Auto-sync] Failed to send ${name} failure alert:`, { error: err as Error });
    });
  } else {
    logger.info(`[Auto-sync] ${name}: first consecutive failure — will alert if next sync also fails`);
  }

  return result;
}

const runBackgroundSync = async () => {
  try {
    const eventsResult = await syncWithRetry('Events', () => syncGoogleCalendarEvents({ suppressAlert: true }), { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Events sync failed' });
    const wellnessResult = await syncWithRetry('Wellness', () => syncWellnessCalendarEvents({ suppressAlert: true }), { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Wellness sync failed' });
    const closuresResult = await syncWithRetry('Closures', () => syncInternalCalendarToClosures(), { synced: 0, created: 0, updated: 0, deleted: 0, pushedToCalendar: 0, error: 'Closures sync failed' });
    const confRoomResult = await syncWithRetry('ConfRoom', () => syncConferenceRoomCalendarToBookings(), { synced: 0, linked: 0, created: 0, skipped: 0, cancelled: 0, updated: 0, error: 'Conference room sync failed' }) as { synced: number; linked: number; created: number; skipped: number; cancelled: number; updated: number; error?: string; warning?: string };
    const eventsMsg = eventsResult.error ? eventsResult.error : `${eventsResult.synced} synced`;
    const wellnessMsg = wellnessResult.error ? wellnessResult.error : `${wellnessResult.synced} synced`;
    const closuresMsg = closuresResult.error ? closuresResult.error : `${(closuresResult as { synced: number; error?: string }).synced} synced`;
    const confRoomMsg = confRoomResult.error ? confRoomResult.error : (confRoomResult.warning ? 'not configured' : `${confRoomResult.synced} synced`);
    logger.info(`[Auto-sync] Events: ${eventsMsg}, Wellness: ${wellnessMsg}, Closures: ${closuresMsg}, ConfRoom: ${confRoomMsg}`);
    schedulerTracker.recordRun('Background Sync', true);
  } catch (err: unknown) {
    logger.error('[Auto-sync] Calendar sync failed:', { error: err as Error });
    schedulerTracker.recordRun('Background Sync', false, String(err));
  } finally {
    currentTimeoutId = setTimeout(runBackgroundSync, SYNC_INTERVAL_MS);
  }
};

export function startBackgroundSyncScheduler(): void {
  if (currentTimeoutId) return;
  currentTimeoutId = setTimeout(runBackgroundSync, SYNC_INTERVAL_MS);
  logger.info('[Startup] Background calendar sync enabled (every 5 minutes, first sync in 5 minutes)');
}

export function stopBackgroundSyncScheduler(): void {
  if (currentTimeoutId) {
    clearTimeout(currentTimeoutId);
    currentTimeoutId = null;
    logger.info('[Background Sync] Scheduler stopped');
  }
}
