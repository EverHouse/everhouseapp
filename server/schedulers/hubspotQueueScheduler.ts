import { schedulerTracker } from '../core/schedulerTracker';
import { processHubSpotQueue, getQueueStats, recoverStuckProcessingJobs } from '../core/hubspot';
import { logger } from '../core/logger';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';
import { getErrorMessage } from '../utils/errorUtils';

const PROCESS_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
let isProcessing = false;

async function processQueue(): Promise<void> {
  if (isProcessing) {
    return; // Skip if already processing
  }
  
  isProcessing = true;
  
  try {
    // First, recover any jobs stuck in 'processing' state (server crash recovery)
    await recoverStuckProcessingJobs();
    
    const stats = await processHubSpotQueue(20); // Process up to 20 jobs per batch
    
    if (stats.processed > 0) {
      logger.info('[HubSpot Queue] Batch processed', {
        extra: {
          processed: stats.processed,
          succeeded: stats.succeeded,
          failed: stats.failed
        }
      });
    }
    
    const queueStats = await getQueueStats();
    if (queueStats.pending > 0 || queueStats.failed > 0 || queueStats.dead > 0) {
      logger.info('[HubSpot Queue] Queue status', {
        extra: queueStats
      });
    }

    schedulerTracker.recordRun('HubSpot Queue', true);
    
  } catch (error: unknown) {
    logger.error('[HubSpot Queue] Scheduler error', { error: getErrorMessage(error) });
    try {
      await alertOnScheduledTaskFailure('HubSpot Queue Processor', error instanceof Error ? error : getErrorMessage(error));
    } catch (alertError: unknown) {
      // Ignore alert failures
    }
    schedulerTracker.recordRun('HubSpot Queue', false, getErrorMessage(error));
  } finally {
    isProcessing = false;
  }
}

export function startHubSpotQueueScheduler(): NodeJS.Timeout {
  logger.info('[Startup] HubSpot queue scheduler enabled (runs every 2 minutes)');
  
  // Ensure HubSpot properties have all required options on startup
  setTimeout(async () => {
    try {
      const { ensureHubSpotPropertiesExist } = await import('../core/hubspot/stages');
      const result = await ensureHubSpotPropertiesExist();
      if (result.created.length > 0) {
        logger.info(`[HubSpot] Created properties: ${result.created.join(', ')}`);
      }
      if (result.errors.length > 0) {
        logger.error(`[HubSpot] Property errors: ${result.errors.join(', ')}`);
      }
    } catch (err: unknown) {
      logger.error('[HubSpot] Failed to ensure properties exist:', { error: err as Error });
    }
  }, 15000);
  
  // Run immediately on startup to process any pending jobs
  setTimeout(() => {
    processQueue().catch((err: unknown) => {
      logger.error('[HubSpot Queue] Initial run failed:', { error: err as Error });
    });
  }, 30000); // Wait 30 seconds after startup
  
  // Then run every 2 minutes
  return setInterval(processQueue, PROCESS_INTERVAL_MS);
}
