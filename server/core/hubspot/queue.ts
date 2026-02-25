import { db } from '../../db';
import { getErrorMessage } from '../../utils/errorUtils';
import { sql } from 'drizzle-orm';
import { logger } from '../logger';

export type HubSpotOperation = 
  | 'create_contact'
  | 'update_contact'
  | 'create_deal'
  | 'sync_member'
  | 'sync_tier'
  | 'sync_company'
  | 'sync_day_pass'
  | 'sync_payment';

interface QueueJobOptions {
  priority?: number;  // 1-10, lower = higher priority
  idempotencyKey?: string;
  maxRetries?: number;
}

export async function enqueueHubSpotSync(
  operation: HubSpotOperation,
  payload: Record<string, unknown>,
  options: QueueJobOptions = {}
): Promise<number | null> {
  const { priority = 5, idempotencyKey, maxRetries = 5 } = options;
  
  try {
    // If idempotency key provided, check for existing pending job
    if (idempotencyKey) {
      const existing = await db.execute(sql`SELECT id FROM hubspot_sync_queue 
         WHERE idempotency_key = ${idempotencyKey} AND status IN ('pending', 'processing', 'failed')`);
      if (existing.rows.length > 0) {
        logger.info('[HubSpot Queue] Duplicate job skipped', { 
          extra: { idempotencyKey, existingId: existing.rows[0].id }
        });
        return (existing.rows[0] as Record<string, unknown>).id as number;
      }
    }
    
    const result = await db.execute(sql`INSERT INTO hubspot_sync_queue (operation, payload, priority, max_retries, idempotency_key)
       VALUES (${operation}, ${JSON.stringify(payload)}, ${priority}, ${maxRetries}, ${idempotencyKey})
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL AND status != 'completed' DO NOTHING
       RETURNING id`);
    
    if (result.rows.length === 0) {
      logger.info('[HubSpot Queue] Duplicate job skipped (conflict)', { 
        extra: { idempotencyKey, operation }
      });
      return null;
    }
    
    logger.info('[HubSpot Queue] Job enqueued', { 
      extra: { jobId: (result.rows[0] as Record<string, unknown>).id, operation, idempotencyKey }
    });
    
    return (result.rows[0] as Record<string, unknown>).id as number;
  } catch (error: unknown) {
    logger.error('[HubSpot Queue] Failed to enqueue job', { 
      error: error,
      extra: { operation, idempotencyKey }
    });
    return null;
  }
}

// Calculate next retry time with exponential backoff
function getNextRetryTime(retryCount: number): Date {
  const baseDelay = 60 * 1000; // 1 minute
  const maxDelay = 60 * 60 * 1000; // 1 hour
  const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
  return new Date(Date.now() + delay);
}

export async function processHubSpotQueue(batchSize: number = 10): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const stats = { processed: 0, succeeded: 0, failed: 0 };
  
  // Atomically claim pending jobs using UPDATE ... RETURNING
  // This prevents race conditions with parallel workers
  const result = await db.execute(sql`
    UPDATE hubspot_sync_queue
    SET status = 'processing', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM hubspot_sync_queue
      WHERE (status = 'pending' OR (status = 'failed' AND next_retry_at <= NOW()))
      ORDER BY priority ASC, created_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, operation, payload, retry_count, max_retries
  `);
  
  if (result.rows.length === 0) {
    return stats;
  }
  
  logger.info('[HubSpot Queue] Processing batch', { 
    extra: { count: result.rows.length }
  });
  
  for (const _job of result.rows) {
    const job = _job as Record<string, unknown>;
    stats.processed++;
    
    try {
      // Execute the operation
      await executeHubSpotOperation(job.operation as string, job.payload as any);
      
      // Mark as completed
      await db.execute(sql`UPDATE hubspot_sync_queue 
         SET status = 'completed', completed_at = NOW(), updated_at = NOW() 
         WHERE id = ${job.id}`);
      
      stats.succeeded++;
      logger.info('[HubSpot Queue] Job completed', { 
        extra: { jobId: job.id, operation: job.operation }
      });
      
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      const isUnrecoverable = 
        errorMsg.includes('MISSING_SCOPES') || 
        errorMsg.includes('403') || 
        errorMsg.includes('401');
      
      if (isUnrecoverable) {
        await db.execute(sql`UPDATE hubspot_sync_queue 
           SET status = 'dead', 
               last_error = ${`Unrecoverable error - ${errorMsg}`},
               updated_at = NOW() 
           WHERE id = ${job.id}`);
        
        logger.error('[HubSpot Queue] Job dead (unrecoverable error - skipping retries)', { 
          error: error,
          extra: { jobId: job.id, operation: job.operation }
        });
        
        try {
          const { notifyAllStaff } = await import('../staffNotifications');
          await notifyAllStaff(
            'HubSpot Sync Failed',
            `Job ${job.id} (${job.operation}) failed: ${errorMsg}. ` +
            `Check that HUBSPOT_PRIVATE_APP_TOKEN is valid and not expired. ` +
            `Note: all required scopes are already enabled — this is likely a token or auth issue, not a scopes problem.`,
            'integration_error'
          );
        } catch (notifyErr: unknown) {
          logger.error('[HubSpot Queue] Failed to notify staff of dead job', { error: notifyErr });
        }
        
        stats.failed++;
        continue;
      }
      
      const newRetryCount = Number(job.retry_count) + 1;
      const shouldRetry = Number(newRetryCount) < Number(job.max_retries);
      
      if (shouldRetry) {
        // Schedule retry with exponential backoff
        const nextRetry = getNextRetryTime(newRetryCount);
        await db.execute(sql`UPDATE hubspot_sync_queue 
           SET status = 'failed', 
               retry_count = ${newRetryCount}, 
               last_error = ${getErrorMessage(error)}, 
               next_retry_at = ${nextRetry},
               updated_at = NOW() 
           WHERE id = ${job.id}`);
        
        logger.warn('[HubSpot Queue] Job failed, will retry', { 
          extra: { 
            jobId: job.id, 
            operation: job.operation,
            retryCount: newRetryCount,
            nextRetry: nextRetry.toISOString()
          }
        });
      } else {
        // Mark as dead (exceeded retries)
        await db.execute(sql`UPDATE hubspot_sync_queue 
           SET status = 'dead', 
               last_error = ${getErrorMessage(error)},
               updated_at = NOW() 
           WHERE id = ${job.id}`);
        
        logger.error('[HubSpot Queue] Job dead (max retries exceeded)', { 
          error: error,
          extra: { jobId: job.id, operation: job.operation }
        });
        
        // Alert staff so failed syncs don't go unnoticed
        try {
          const { notifyAllStaff } = await import('../staffNotifications');
          await notifyAllStaff(
            'HubSpot Sync Failed Permanently',
            `Job ${job.id} (${job.operation}) failed after ${job.max_retries} retries. ` +
            `Last error: ${getErrorMessage(error)}. Manual intervention may be required.`,
            'integration_error'
          );
        } catch (notifyErr: unknown) {
          logger.error('[HubSpot Queue] Failed to notify staff of dead job', { error: notifyErr });
        }
      }
      
      stats.failed++;
    }
  }
  
  return stats;
}

// Execute a specific HubSpot operation
async function executeHubSpotOperation(operation: string, payload: Record<string, unknown>): Promise<void> {
  // Import handlers dynamically to avoid circular deps
  const members = await import('./members');
  const contacts = await import('./contacts');
  const companies = await import('./companies');
  const stages = await import('./stages');
  
  switch (operation) {
    case 'create_contact':
      await members.findOrCreateHubSpotContact(
        payload.email as string,
        payload.firstName as string,
        payload.lastName as string,
        payload.phone as string,
        payload.tier as string | undefined,
        payload.role ? { role: payload.role as string } : undefined
      );
      break;
      
    case 'update_contact':
      await stages.updateContactMembershipStatus(
        payload.email as string,
        payload.status as any,
        (payload.performedBy as string) || 'system'
      );
      break;
      
    case 'create_deal':
      logger.info(`[HubSpot Queue] Deal creation disabled — skipping create_deal for ${payload.email}`);
      break;
      
    case 'sync_member':
      logger.info(`[HubSpot Queue] Deal creation disabled — skipping sync_member for ${payload.email}`);
      break;
      
    case 'sync_tier':
      // Sync tier change to HubSpot contact and deal
      await members.syncTierToHubSpot(payload as any);
      break;
      
    case 'sync_company':
      await companies.syncCompanyToHubSpot(payload as any);
      break;
      
    case 'sync_day_pass':
      // Use the stripe hubspotSync version which handles line items on deals
      const dayPassSync = await import('../stripe/hubspotSync');
      await dayPassSync.syncDayPassToHubSpot(payload as any);
      break;
      
    case 'sync_payment':
      const hubspotSync = await import('../stripe/hubspotSync');
      await hubspotSync.syncPaymentToHubSpot(payload as any);
      break;
      
    default:
      throw new Error(`Unknown HubSpot operation: ${operation}`);
  }
}

// Recover jobs stuck in 'processing' status (server crash recovery)
export async function recoverStuckProcessingJobs(): Promise<number> {
  try {
    const result = await db.execute(sql`
      UPDATE hubspot_sync_queue
      SET status = 'failed', 
          retry_count = retry_count + 1,
          last_error = 'Processing timeout - server may have crashed',
          next_retry_at = NOW() + INTERVAL '5 minutes',
          updated_at = NOW()
      WHERE status = 'processing' 
        AND updated_at < NOW() - INTERVAL '10 minutes'
      RETURNING id
    `);
    
    if ((result.rowCount || 0) > 0) {
      logger.warn('[HubSpot Queue] Recovered stuck processing jobs', { 
        extra: { count: result.rowCount }
      });
    }
    
    return result.rowCount || 0;
  } catch (error: unknown) {
    logger.error('[HubSpot Queue] Error recovering stuck jobs', { error });
    return 0;
  }
}

// Get queue stats for monitoring
export async function getQueueStats(): Promise<{
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  completedToday: number;
}> {
  const result = await db.execute(sql`
    SELECT 
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'processing') as processing,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'dead') as dead,
      COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '24 hours') as completed_today
    FROM hubspot_sync_queue
  `);
  
  const statsRow = result.rows[0] as Record<string, unknown>;
  return {
    pending: parseInt(String(statsRow.pending)) || 0,
    processing: parseInt(String(statsRow.processing)) || 0,
    failed: parseInt(String(statsRow.failed)) || 0,
    dead: parseInt(String(statsRow.dead)) || 0,
    completedToday: parseInt(String(statsRow.completed_today)) || 0
  };
}
