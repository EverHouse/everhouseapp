import { schedulerTracker } from '../core/schedulerTracker';
import { triggerCommunicationLogsSync } from '../core/memberSync';
import { logger } from '../core/logger';

const COMM_LOGS_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export function startCommunicationLogsScheduler(): void {
  setTimeout(() => {
    triggerCommunicationLogsSync();
    setInterval(triggerCommunicationLogsSync, COMM_LOGS_SYNC_INTERVAL_MS);
  }, 10 * 60 * 1000);
  
  logger.info('[Startup] Communication logs sync scheduler enabled (runs every 30 minutes)');
}
