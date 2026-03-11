import { schedulerTracker } from '../core/schedulerTracker';
import { processHubSpotQueue, getQueueStats, recoverStuckProcessingJobs } from '../core/hubspot';
import { logger } from '../core/logger';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';
import { getErrorMessage } from '../utils/errorUtils';

const PROCESS_INTERVAL_MS = 30 * 1000; // 30 seconds
let isProcessing = false;

function extractRootError(error: unknown): string {
  const message = getErrorMessage(error);
  if (error instanceof Error && error.cause) {
    const causeMsg = getErrorMessage(error.cause);
    if (causeMsg && causeMsg !== message) {
      return causeMsg;
    }
  }
  return message;
}

async function processQueue(): Promise<void> {
  if (isProcessing) {
    return;
  }
  
  isProcessing = true;
  
  try {
    await recoverStuckProcessingJobs();
    
    const stats = await processHubSpotQueue(50);
    
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
    if (queueStats.pending > 0 || queueStats.failed > 0 || queueStats.processing > 0) {
      logger.info('[HubSpot Queue] Queue status', {
        extra: queueStats
      });
    }

    schedulerTracker.recordRun('HubSpot Queue', true);
    
  } catch (error: unknown) {
    const rootError = extractRootError(error);
    logger.error('[HubSpot Queue] Scheduler error', { 
      error: rootError,
      extra: { 
        drizzleMessage: getErrorMessage(error),
        cause: error instanceof Error && error.cause ? getErrorMessage(error.cause) : undefined
      }
    });
    try {
      await alertOnScheduledTaskFailure('HubSpot Queue Processor', rootError);
    } catch (alertError: unknown) {
      // Ignore alert failures
    }
    schedulerTracker.recordRun('HubSpot Queue', false, rootError);
  } finally {
    isProcessing = false;
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startHubSpotQueueScheduler(): void {
  if (intervalId) {
    logger.info('[HubSpot Queue] Scheduler already running');
    return;
  }

  logger.info('[Startup] HubSpot queue scheduler enabled (runs every 30 seconds)');
  
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
  
  setTimeout(() => {
    processQueue().catch((err: unknown) => {
      logger.error('[HubSpot Queue] Initial run failed:', { error: err as Error });
    });
  }, 30000);
  
  intervalId = setInterval(processQueue, PROCESS_INTERVAL_MS);
}

export function stopHubSpotQueueScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[HubSpot Queue] Scheduler stopped');
  }
}
