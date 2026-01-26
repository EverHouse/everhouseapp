import { pool } from '../db';
import { logger } from '../logger';

export type HubSpotOperation = 
  | 'create_contact'
  | 'update_contact'
  | 'create_deal'
  | 'sync_member'
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
  payload: Record<string, any>,
  options: QueueJobOptions = {}
): Promise<number | null> {
  const { priority = 5, idempotencyKey, maxRetries = 5 } = options;
  
  try {
    // If idempotency key provided, check for existing pending job
    if (idempotencyKey) {
      const existing = await pool.query(
        `SELECT id FROM hubspot_sync_queue 
         WHERE idempotency_key = $1 AND status IN ('pending', 'processing')`,
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        logger.info('[HubSpot Queue] Duplicate job skipped', { 
          extra: { idempotencyKey, existingId: existing.rows[0].id }
        });
        return existing.rows[0].id;
      }
    }
    
    const result = await pool.query(
      `INSERT INTO hubspot_sync_queue (operation, payload, priority, max_retries, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [operation, JSON.stringify(payload), priority, maxRetries, idempotencyKey]
    );
    
    logger.info('[HubSpot Queue] Job enqueued', { 
      extra: { jobId: result.rows[0].id, operation, idempotencyKey }
    });
    
    return result.rows[0].id;
  } catch (error: any) {
    logger.error('[HubSpot Queue] Failed to enqueue job', { 
      error,
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
  const result = await pool.query(`
    UPDATE hubspot_sync_queue
    SET status = 'processing', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM hubspot_sync_queue
      WHERE (status = 'pending' OR (status = 'failed' AND next_retry_at <= NOW()))
      ORDER BY priority ASC, created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, operation, payload, retry_count, max_retries
  `, [batchSize]);
  
  if (result.rows.length === 0) {
    return stats;
  }
  
  logger.info('[HubSpot Queue] Processing batch', { 
    extra: { count: result.rows.length }
  });
  
  for (const job of result.rows) {
    stats.processed++;
    
    try {
      // Execute the operation
      await executeHubSpotOperation(job.operation, job.payload);
      
      // Mark as completed
      await pool.query(
        `UPDATE hubspot_sync_queue 
         SET status = 'completed', completed_at = NOW(), updated_at = NOW() 
         WHERE id = $1`,
        [job.id]
      );
      
      stats.succeeded++;
      logger.info('[HubSpot Queue] Job completed', { 
        extra: { jobId: job.id, operation: job.operation }
      });
      
    } catch (error: any) {
      const newRetryCount = job.retry_count + 1;
      const shouldRetry = newRetryCount < job.max_retries;
      
      if (shouldRetry) {
        // Schedule retry with exponential backoff
        const nextRetry = getNextRetryTime(newRetryCount);
        await pool.query(
          `UPDATE hubspot_sync_queue 
           SET status = 'failed', 
               retry_count = $2, 
               last_error = $3, 
               next_retry_at = $4,
               updated_at = NOW() 
           WHERE id = $1`,
          [job.id, newRetryCount, error.message, nextRetry]
        );
        
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
        await pool.query(
          `UPDATE hubspot_sync_queue 
           SET status = 'dead', 
               last_error = $2,
               updated_at = NOW() 
           WHERE id = $1`,
          [job.id, error.message]
        );
        
        logger.error('[HubSpot Queue] Job dead (max retries exceeded)', { 
          error,
          extra: { jobId: job.id, operation: job.operation }
        });
      }
      
      stats.failed++;
    }
  }
  
  return stats;
}

// Execute a specific HubSpot operation
async function executeHubSpotOperation(operation: string, payload: any): Promise<void> {
  // Import handlers dynamically to avoid circular deps
  const members = await import('./members');
  const contacts = await import('./contacts');
  const companies = await import('./companies');
  const stages = await import('./stages');
  
  switch (operation) {
    case 'create_contact':
      await members.findOrCreateHubSpotContact(
        payload.email,
        payload.firstName,
        payload.lastName,
        payload.phone
      );
      break;
      
    case 'update_contact':
      await stages.updateContactMembershipStatus(
        payload.email,
        payload.status
      );
      break;
      
    case 'create_deal':
      await members.createMembershipDeal(
        payload.contactId,
        payload.email,
        payload.tier,
        payload.pricePerMonth
      );
      break;
      
    case 'sync_member':
      // Sync a newly created member to HubSpot (contact + deal)
      await members.syncNewMemberToHubSpot(payload);
      break;
      
    case 'sync_company':
      await companies.syncCompanyToHubSpot(payload);
      break;
      
    case 'sync_day_pass':
      // Use the stripe hubspotSync version which handles line items on deals
      const dayPassSync = await import('../stripe/hubspotSync');
      await dayPassSync.syncDayPassToHubSpot(payload);
      break;
      
    case 'sync_payment':
      const hubspotSync = await import('../stripe/hubspotSync');
      await hubspotSync.syncPaymentToHubSpot(payload);
      break;
      
    default:
      throw new Error(`Unknown HubSpot operation: ${operation}`);
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
  const result = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'processing') as processing,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'dead') as dead,
      COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '24 hours') as completed_today
    FROM hubspot_sync_queue
  `);
  
  return {
    pending: parseInt(result.rows[0].pending) || 0,
    processing: parseInt(result.rows[0].processing) || 0,
    failed: parseInt(result.rows[0].failed) || 0,
    dead: parseInt(result.rows[0].dead) || 0,
    completedToday: parseInt(result.rows[0].completed_today) || 0
  };
}
