import { schedulerTracker } from '../core/schedulerTracker';
import { syncAllMembersFromHubSpot, getLastMemberSyncTime, setLastMemberSyncTime } from '../core/memberSync';
import { getPacificDateParts } from '../utils/dateUtils';
import { logger } from '../core/logger';

const SYNC_HOUR = 3;
let currentTimeoutId: NodeJS.Timeout | null = null;

function getMillisecondsUntil3amPacific(): number {
  const parts = getPacificDateParts();
  const now = new Date();
  
  const targetHour = SYNC_HOUR;
  let hoursUntilSync = targetHour - parts.hour;
  
  if (hoursUntilSync <= 0) {
    hoursUntilSync += 24;
  }
  
  const minutesRemaining = 60 - parts.minute;
  const totalMinutes = (hoursUntilSync - 1) * 60 + minutesRemaining;
  
  return totalMinutes * 60 * 1000;
}

async function runDailyMemberSync(): Promise<void> {
  logger.info('[MemberSync] Starting daily off-hours sync...');
  try {
    const result = await syncAllMembersFromHubSpot();
    logger.info(`[MemberSync] Daily sync complete - Synced: ${result.synced}, Errors: ${result.errors}`);
    schedulerTracker.recordRun('Member Sync', true);
    await setLastMemberSyncTime(Date.now());
  } catch (err: unknown) {
    logger.error('[MemberSync] Daily sync failed:', { error: err as Error });
    schedulerTracker.recordRun('Member Sync', false, String(err));
  }
  
  const nextRun = getMillisecondsUntil3amPacific();
  currentTimeoutId = setTimeout(runDailyMemberSync, nextRun);
  logger.info(`[MemberSync] Next sync scheduled in ${Math.round(nextRun / 1000 / 60 / 60)} hours`);
}

export function startMemberSyncScheduler(): void {
  const msUntilSync = getMillisecondsUntil3amPacific();
  const hoursUntilSync = Math.round(msUntilSync / 1000 / 60 / 60);
  
  currentTimeoutId = setTimeout(runDailyMemberSync, msUntilSync);
  logger.info(`[Startup] Member sync scheduler enabled (runs daily at 3am Pacific, next run in ~${hoursUntilSync} hours)`);
}

export function stopMemberSyncScheduler(): void {
  if (currentTimeoutId) {
    clearTimeout(currentTimeoutId);
    currentTimeoutId = null;
    logger.info('[MemberSync] Scheduler stopped');
  }
}
