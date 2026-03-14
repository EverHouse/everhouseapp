import { syncCommunicationLogsFromHubSpot } from '../core/memberSync';
import { logger } from '../core/logger';

const COMM_LOGS_SYNC_INTERVAL_MS = 30 * 60 * 1000;

let commLogsIntervalId: NodeJS.Timeout | null = null;
let isRunning = false;

async function guardedSync(): Promise<void> {
  if (isRunning) {
    logger.info('[CommLogs Sync] Skipping run — previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    await syncCommunicationLogsFromHubSpot();
  } catch (err: unknown) {
    logger.error('[CommLogs] Background sync failed:', { error: err as Error });
  } finally {
    isRunning = false;
  }
}

let startupTimeoutId: NodeJS.Timeout | null = null;

export function startCommunicationLogsScheduler(): void {
  stopCommunicationLogsScheduler();
  startupTimeoutId = setTimeout(() => {
    startupTimeoutId = null;
    guardedSync();
    commLogsIntervalId = setInterval(guardedSync, COMM_LOGS_SYNC_INTERVAL_MS);
  }, 10 * 60 * 1000);
  
  logger.info('[Startup] Communication logs sync scheduler enabled (runs every 30 minutes)');
}

export function stopCommunicationLogsScheduler(): void {
  if (startupTimeoutId) {
    clearTimeout(startupTimeoutId);
    startupTimeoutId = null;
  }
  if (commLogsIntervalId) {
    clearInterval(commLogsIntervalId);
    commLogsIntervalId = null;
  }
}
