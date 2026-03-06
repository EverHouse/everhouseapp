import { schedulerTracker } from '../core/schedulerTracker';
import { syncAllMembersFromHubSpot, getLastMemberSyncTime, setLastMemberSyncTime } from '../core/memberSync';
import { getPacificDateParts } from '../utils/dateUtils';
import { logger } from '../core/logger';

const SYNC_HOUR = 3;
const SYNC_DAY = 0; // Sunday
let currentTimeoutId: NodeJS.Timeout | null = null;
let isRunning = false;

function getMillisecondsUntilNextSunday3amPacific(): number {
  const parts = getPacificDateParts();

  let daysUntilSunday = SYNC_DAY - parts.dayOfWeek;
  if (daysUntilSunday < 0) daysUntilSunday += 7;

  if (daysUntilSunday === 0 && parts.hour >= SYNC_HOUR) {
    daysUntilSunday = 7;
  }

  let hoursUntilSync = SYNC_HOUR - parts.hour + (daysUntilSunday * 24);
  if (daysUntilSunday === 0 && parts.hour < SYNC_HOUR) {
    hoursUntilSync = SYNC_HOUR - parts.hour;
  }

  const minutesRemaining = 60 - parts.minute;
  const totalMinutes = (hoursUntilSync - 1) * 60 + minutesRemaining;

  return Math.max(totalMinutes * 60 * 1000, 60000);
}

async function runWeeklyMemberSync(): Promise<void> {
  if (isRunning) {
    logger.info('[MemberSync] Skipping run — previous sync still in progress');
    const nextRun = getMillisecondsUntilNextSunday3amPacific();
    currentTimeoutId = setTimeout(runWeeklyMemberSync, nextRun);
    return;
  }
  isRunning = true;
  logger.info('[MemberSync] Starting weekly reconciliation sync...');
  try {
    const result = await syncAllMembersFromHubSpot();
    logger.info(`[MemberSync] Weekly reconciliation complete - Synced: ${result.synced}, Errors: ${result.errors}`);
    schedulerTracker.recordRun('Member Sync', true);
    await setLastMemberSyncTime(Date.now());
  } catch (err: unknown) {
    logger.error('[MemberSync] Weekly reconciliation failed:', { error: err as Error });
    schedulerTracker.recordRun('Member Sync', false, String(err));
  } finally {
    isRunning = false;
  }
  
  const nextRun = getMillisecondsUntilNextSunday3amPacific();
  currentTimeoutId = setTimeout(runWeeklyMemberSync, nextRun);
  const days = Math.round(nextRun / 1000 / 60 / 60 / 24);
  logger.info(`[MemberSync] Next reconciliation scheduled in ~${days} days (Sunday 3am Pacific)`);
}

export function startMemberSyncScheduler(): void {
  if (currentTimeoutId) {
    logger.info('[MemberSync] Scheduler already running');
    return;
  }
  const msUntilSync = getMillisecondsUntilNextSunday3amPacific();
  const days = Math.round(msUntilSync / 1000 / 60 / 60 / 24);
  
  currentTimeoutId = setTimeout(runWeeklyMemberSync, msUntilSync);
  logger.info(`[Startup] Member sync scheduler enabled (runs weekly Sunday 3am Pacific, next run in ~${days} days)`);
}

export function stopMemberSyncScheduler(): void {
  if (currentTimeoutId) {
    clearTimeout(currentTimeoutId);
    currentTimeoutId = null;
    logger.info('[MemberSync] Scheduler stopped');
  }
}
