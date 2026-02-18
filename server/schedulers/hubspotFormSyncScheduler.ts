import { schedulerTracker } from '../core/schedulerTracker';
import { syncHubSpotFormSubmissions } from '../core/hubspot/formSync';
import { getErrorMessage } from '../utils/errorUtils';
import { logger } from '../core/logger';

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
let isSyncing = false;

async function runSync(): Promise<void> {
  if (isSyncing) {
    logger.info('[HubSpot FormSync] Skipping — sync already in progress');
    return;
  }

  isSyncing = true;

  try {
    await syncHubSpotFormSubmissions();
  } catch (error: unknown) {
    logger.error('[HubSpot FormSync] Scheduler error:', { error: error as Error });
    schedulerTracker.recordRun('HubSpot Form Sync', false, getErrorMessage(error));
  } finally {
    isSyncing = false;
  }
}

export function startHubSpotFormSyncScheduler(): void {
  logger.info('[Startup] HubSpot form sync scheduler enabled (runs every 30 minutes)');

  setTimeout(() => {
    runSync().catch(err => {
      logger.error('[HubSpot FormSync] Initial run failed:', { error: err as Error });
      schedulerTracker.recordRun('HubSpot Form Sync', false, String(err));
    });
  }, 60000);

  setInterval(runSync, SYNC_INTERVAL_MS);
}
