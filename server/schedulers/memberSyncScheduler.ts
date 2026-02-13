import { schedulerTracker } from '../core/schedulerTracker';
import { syncAllMembersFromHubSpot, getLastMemberSyncTime, setLastMemberSyncTime } from '../core/memberSync';
import { getPacificDateParts } from '../utils/dateUtils';

const SYNC_HOUR = 3;

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
  console.log('[MemberSync] Starting daily off-hours sync...');
  try {
    const result = await syncAllMembersFromHubSpot();
    console.log(`[MemberSync] Daily sync complete - Synced: ${result.synced}, Errors: ${result.errors}`);
    schedulerTracker.recordRun('Member Sync', true);
    await setLastMemberSyncTime(Date.now());
  } catch (err) {
    console.error('[MemberSync] Daily sync failed:', err);
    schedulerTracker.recordRun('Member Sync', false, String(err));
  }
  
  const nextRun = getMillisecondsUntil3amPacific();
  setTimeout(runDailyMemberSync, nextRun);
  console.log(`[MemberSync] Next sync scheduled in ${Math.round(nextRun / 1000 / 60 / 60)} hours`);
}

export function startMemberSyncScheduler(): void {
  const msUntilSync = getMillisecondsUntil3amPacific();
  const hoursUntilSync = Math.round(msUntilSync / 1000 / 60 / 60);
  
  setTimeout(runDailyMemberSync, msUntilSync);
  console.log(`[Startup] Member sync scheduler enabled (runs daily at 3am Pacific, next run in ~${hoursUntilSync} hours)`);
}
