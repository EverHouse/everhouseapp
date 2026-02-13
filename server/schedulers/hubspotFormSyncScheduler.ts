import { schedulerTracker } from '../core/schedulerTracker';
import { syncHubSpotFormSubmissions } from '../core/hubspot/formSync';
import { getErrorMessage } from '../utils/errorUtils';

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
let isSyncing = false;

async function runSync(): Promise<void> {
  if (isSyncing) {
    console.log('[HubSpot FormSync] Skipping — sync already in progress');
    return;
  }

  isSyncing = true;

  try {
    await syncHubSpotFormSubmissions();
  } catch (error: unknown) {
    console.error('[HubSpot FormSync] Scheduler error:', getErrorMessage(error));
    schedulerTracker.recordRun('HubSpot Form Sync', false, getErrorMessage(error));
  } finally {
    isSyncing = false;
  }
}

export function startHubSpotFormSyncScheduler(): void {
  console.log('[Startup] HubSpot form sync scheduler enabled (runs every 30 minutes)');

  setTimeout(() => {
    runSync().catch(err => {
      console.error('[HubSpot FormSync] Initial run failed:', err);
      schedulerTracker.recordRun('HubSpot Form Sync', false, String(err));
    });
  }, 60000);

  setInterval(runSync, SYNC_INTERVAL_MS);
}
