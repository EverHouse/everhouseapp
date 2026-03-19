import { schedulerTracker } from '../core/schedulerTracker';
import { syncAllMembersFromHubSpot, setLastMemberSyncTime } from '../core/memberSync';
import { getPacificDateParts } from '../utils/dateUtils';
import { logger } from '../core/logger';
import { getErrorMessage } from '../utils/errorUtils';

const SYNC_HOUR = 3;
let currentTimeoutId: NodeJS.Timeout | null = null;
let isRunning = false;

function getMillisecondsUntilNext3amPacific(): number {
  const parts = getPacificDateParts();

  let hoursUntilSync = SYNC_HOUR - parts.hour;
  if (hoursUntilSync <= 0) {
    hoursUntilSync += 24;
  }

  const minutesRemaining = 60 - parts.minute;
  const totalMinutes = (hoursUntilSync - 1) * 60 + minutesRemaining;

  return Math.max(totalMinutes * 60 * 1000, 60000);
}

async function runDailyMemberSync(): Promise<void> {
  if (isRunning) {
    logger.info('[MemberSync] Skipping run — previous sync still in progress');
    const nextRun = getMillisecondsUntilNext3amPacific();
    currentTimeoutId = setTimeout(runDailyMemberSync, nextRun);
    return;
  }
  isRunning = true;
  logger.info('[MemberSync] Starting daily reconciliation sync...');
  try {
    const result = await syncAllMembersFromHubSpot();
    logger.info(`[MemberSync] Daily reconciliation complete - Synced: ${result.synced}, Errors: ${result.errors}`);
    schedulerTracker.recordRun('Member Sync', true);
    await setLastMemberSyncTime(Date.now());
  } catch (err: unknown) {
    logger.error('[MemberSync] Daily reconciliation failed:', { error: err as Error });
    schedulerTracker.recordRun('Member Sync', false, getErrorMessage(err));
  } finally {
    isRunning = false;
  }
  
  const nextRun = getMillisecondsUntilNext3amPacific();
  currentTimeoutId = setTimeout(runDailyMemberSync, nextRun);
  const hours = Math.round(nextRun / 1000 / 60 / 60);
  logger.info(`[MemberSync] Next reconciliation scheduled in ~${hours} hours (daily 3am Pacific)`);
}

export function startMemberSyncScheduler(): void {
  if (currentTimeoutId) {
    logger.info('[MemberSync] Scheduler already running');
    return;
  }
  const msUntilSync = getMillisecondsUntilNext3amPacific();
  const hours = Math.round(msUntilSync / 1000 / 60 / 60);
  
  currentTimeoutId = setTimeout(runDailyMemberSync, msUntilSync);
  logger.info(`[Startup] Member sync scheduler enabled (runs daily 3am Pacific, next run in ~${hours} hours)`);
}

export function stopMemberSyncScheduler(): void {
  if (currentTimeoutId) {
    clearTimeout(currentTimeoutId);
    currentTimeoutId = null;
    logger.info('[MemberSync] Scheduler stopped');
  }
}
