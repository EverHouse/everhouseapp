import { processHubSpotQueue, getQueueStats, recoverStuckProcessingJobs } from '../core/hubspot';
import { logger } from '../core/logger';
import { alertOnScheduledTaskFailure } from '../core/dataAlerts';

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
    
    // Log queue health periodically
    const queueStats = await getQueueStats();
    if (queueStats.pending > 0 || queueStats.failed > 0 || queueStats.dead > 0) {
      logger.info('[HubSpot Queue] Queue status', {
        extra: queueStats
      });
    }
    
  } catch (error: any) {
    logger.error('[HubSpot Queue] Scheduler error', { error });
    try {
      await alertOnScheduledTaskFailure('HubSpot Queue Processor', error);
    } catch (alertError) {
      // Ignore alert failures
    }
  } finally {
    isProcessing = false;
  }
}

export function startHubSpotQueueScheduler(): void {
  console.log('[Startup] HubSpot queue scheduler enabled (runs every 2 minutes)');
  
  // Run immediately on startup to process any pending jobs
  setTimeout(() => {
    processQueue().catch(err => {
      console.error('[HubSpot Queue] Initial run failed:', err);
    });
  }, 30000); // Wait 30 seconds after startup
  
  // Then run every 2 minutes
  setInterval(processQueue, PROCESS_INTERVAL_MS);
}
