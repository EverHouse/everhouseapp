import { syncHubSpotFormSubmissions } from '../core/hubspot/formSync';

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
  } catch (error: any) {
    console.error('[HubSpot FormSync] Scheduler error:', error.message || error);
  } finally {
    isSyncing = false;
  }
}

export function startHubSpotFormSyncScheduler(): void {
  console.log('[Startup] HubSpot form sync scheduler enabled (runs every 30 minutes)');

  setTimeout(() => {
    runSync().catch(err => {
      console.error('[HubSpot FormSync] Initial run failed:', err);
    });
  }, 60000);

  setInterval(runSync, SYNC_INTERVAL_MS);
}
