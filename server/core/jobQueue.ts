import { db } from '../db';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { broadcastBillingUpdate, broadcastDayPassUpdate, sendNotificationToUser } from './websocket';
import { notifyPaymentSuccess, notifyPaymentFailed, notifyStaffPaymentFailed, notifyMember, notifyAllStaff } from './notificationService';
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from '../emails/paymentEmails';
import { sendMembershipRenewalEmail, sendMembershipFailedEmail } from '../emails/membershipEmails';
import { sendPassWithQrEmail } from '../emails/passEmails';
import { queuePaymentSyncToHubSpot, queueDayPassSyncToHubSpot, syncCompanyToHubSpot } from './hubspot';

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const BATCH_SIZE = 10;

export type JobType = 
  | 'send_payment_receipt'
  | 'send_payment_failed_email'
  | 'send_membership_renewal_email'
  | 'send_membership_failed_email'
  | 'send_pass_with_qr_email'
  | 'notify_payment_success'
  | 'notify_payment_failed'
  | 'notify_staff_payment_failed'
  | 'notify_member'
  | 'notify_all_staff'
  | 'broadcast_billing_update'
  | 'broadcast_day_pass_update'
  | 'send_notification_to_user'
  | 'sync_to_hubspot'
  | 'sync_company_to_hubspot'
  | 'sync_day_pass_to_hubspot'
  | 'upsert_transaction_cache'
  | 'update_member_tier'
  | 'generic_async_task';

interface QueueJobOptions {
  priority?: number;
  maxRetries?: number;
  scheduledFor?: Date;
  webhookEventId?: string;
}

export async function queueJob(
  jobType: JobType,
  payload: Record<string, any>,
  options: QueueJobOptions = {}
): Promise<number> {
  const { priority = 0, maxRetries = 3, scheduledFor = new Date(), webhookEventId } = options;
  
  const result = await db.execute(sql`INSERT INTO job_queue (job_type, payload, priority, max_retries, scheduled_for, webhook_event_id)
     VALUES (${jobType}, ${JSON.stringify(payload)}, ${priority}, ${maxRetries}, ${scheduledFor}, ${webhookEventId})
     RETURNING id`);
  
  return result.rows[0].id;
}

export async function queueJobInTransaction(
  client: PoolClient,
  jobType: JobType,
  payload: Record<string, any>,
  options: QueueJobOptions = {}
): Promise<number> {
  const { priority = 0, maxRetries = 3, scheduledFor = new Date(), webhookEventId } = options;
  
  const result = await client.query(
    `INSERT INTO job_queue (job_type, payload, priority, max_retries, scheduled_for, webhook_event_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [jobType, JSON.stringify(payload), priority, maxRetries, scheduledFor, webhookEventId]
  );
  
  return result.rows[0].id;
}

export async function queueJobs(
  jobs: Array<{ jobType: JobType; payload: Record<string, any>; options?: QueueJobOptions }>
): Promise<number[]> {
  if (jobs.length === 0) return [];
  
  const valuesSql = jobs.map(job => {
    const { priority = 0, maxRetries = 3, scheduledFor = new Date(), webhookEventId } = job.options || {};
    return sql`(${job.jobType}, ${JSON.stringify(job.payload)}, ${priority}, ${maxRetries}, ${scheduledFor}, ${webhookEventId})`;
  });
  
  const result = await db.execute(sql`INSERT INTO job_queue (job_type, payload, priority, max_retries, scheduled_for, webhook_event_id)
     VALUES ${sql.join(valuesSql, sql`, `)}
     RETURNING id`);
  
  return result.rows.map(r => r.id);
}

async function claimJobs(): Promise<Array<{ id: number; jobType: string; payload: any; retryCount: number; maxRetries: number }>> {
  const now = new Date();
  const lockExpiry = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  
  const result = await db.execute(sql`UPDATE job_queue
     SET locked_at = ${now}, locked_by = ${WORKER_ID}
     WHERE id IN (
       SELECT id FROM job_queue
       WHERE status = 'pending'
         AND scheduled_for <= ${now}
         AND (locked_at IS NULL OR locked_at < ${lockExpiry})
       ORDER BY priority DESC, scheduled_for ASC
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, job_type, payload, retry_count, max_retries`);
  
  return result.rows.map(r => ({
    id: r.id,
    jobType: r.job_type,
    payload: r.payload,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
  }));
}

async function markJobCompleted(jobId: number): Promise<void> {
  await db.execute(sql`UPDATE job_queue SET status = 'completed', processed_at = NOW(), locked_at = NULL, locked_by = NULL WHERE id = ${jobId}`);
}

async function markJobFailed(jobId: number, error: string, retryCount: number, maxRetries: number): Promise<void> {
  if (retryCount + 1 >= maxRetries) {
    await db.execute(sql`UPDATE job_queue SET status = 'failed', last_error = ${error}, retry_count = retry_count + 1, locked_at = NULL, locked_by = NULL WHERE id = ${jobId}`);
  } else {
    const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 60000);
    const nextScheduled = new Date(Date.now() + backoffMs);
    await db.execute(sql`UPDATE job_queue SET last_error = ${error}, retry_count = retry_count + 1, scheduled_for = ${nextScheduled}, locked_at = NULL, locked_by = NULL WHERE id = ${jobId}`);
  }
}

async function executeJob(job: { id: number; jobType: string; payload: any; retryCount: number; maxRetries: number }): Promise<void> {
  const { jobType, payload } = job;
  
  try {
    switch (jobType) {
      case 'send_payment_receipt':
        await sendPaymentReceiptEmail(payload.to, payload.memberName, payload.amount, payload.date, payload.description, payload.paymentMethod);
        break;
      case 'send_payment_failed_email':
        await sendPaymentFailedEmail(payload.to, payload.memberName, payload.amount, payload.reason, payload.retryDate);
        break;
      case 'send_membership_renewal_email':
        await sendMembershipRenewalEmail(payload.to, payload.memberName, payload.tier, payload.nextBillingDate, payload.amount);
        break;
      case 'send_membership_failed_email':
        await sendMembershipFailedEmail(payload.to, payload.memberName, payload.tier, payload.reason, payload.updatePaymentUrl);
        break;
      case 'send_pass_with_qr_email':
        await sendPassWithQrEmail(payload.to, payload.passPurchase, payload.qrCodeDataUrl);
        break;
      case 'notify_payment_success':
        await notifyPaymentSuccess(payload.userEmail, payload.amount, payload.description);
        break;
      case 'notify_payment_failed':
        await notifyPaymentFailed(payload.userEmail, payload.amount, payload.reason);
        break;
      case 'notify_staff_payment_failed':
        await notifyStaffPaymentFailed(payload.memberEmail, payload.memberName, payload.amount, payload.reason);
        break;
      case 'notify_member':
        await notifyMember({
          userEmail: payload.userEmail,
          title: payload.title,
          message: payload.message,
          type: payload.type,
          relatedId: payload.relatedId,
          relatedType: payload.relatedType,
        });
        break;
      case 'notify_all_staff':
        await notifyAllStaff(payload.title, payload.message, payload.type, {
          relatedId: payload.relatedId,
          relatedType: payload.relatedType,
          url: payload.actionUrl,
        });
        break;
      case 'broadcast_billing_update':
        broadcastBillingUpdate(payload);
        break;
      case 'broadcast_day_pass_update':
        broadcastDayPassUpdate(payload);
        break;
      case 'send_notification_to_user':
        sendNotificationToUser(payload.userEmail, payload.notification);
        break;
      case 'sync_to_hubspot':
        await queuePaymentSyncToHubSpot(payload);
        break;
      case 'sync_company_to_hubspot':
        await syncCompanyToHubSpot(payload.companyName, payload.metadata);
        break;
      case 'sync_day_pass_to_hubspot':
        await queueDayPassSyncToHubSpot(payload);
        break;
      case 'upsert_transaction_cache':
        const { upsertTransactionCache } = await import('./stripe/transactionCache');
        await upsertTransactionCache(payload);
        break;
      case 'update_member_tier':
        const { processMemberTierUpdate } = await import('./memberTierUpdateProcessor');
        await processMemberTierUpdate(payload);
        break;
      case 'generic_async_task':
        console.log(`[JobQueue] Executing generic task: ${payload.description || 'no description'}`);
        break;
      default:
        console.warn(`[JobQueue] Unknown job type: ${jobType}`);
    }
    
    await markJobCompleted(job.id);
  } catch (error: any) {
    console.error(`[JobQueue] Job ${job.id} (${jobType}) failed:`, error?.message || error);
    await markJobFailed(job.id, error?.message || String(error), job.retryCount, job.maxRetries);
  }
}

let processingInterval: ReturnType<typeof setInterval> | null = null;

export async function processJobs(): Promise<number> {
  const jobs = await claimJobs();
  
  if (jobs.length === 0) return 0;
  
  console.log(`[JobQueue] Processing ${jobs.length} job(s)`);
  
  await Promise.allSettled(jobs.map(job => executeJob(job)));
  
  return jobs.length;
}

export function startJobProcessor(intervalMs: number = 5000): void {
  if (processingInterval) {
    console.log('[JobQueue] Processor already running');
    return;
  }
  
  console.log(`[Startup] Job queue processor enabled (runs every ${intervalMs / 1000}s)`);
  
  processingInterval = setInterval(async () => {
    try {
      await processJobs();
    } catch (error) {
      console.error('[JobQueue] Processing error:', error);
    }
  }, intervalMs);
}

export function stopJobProcessor(): void {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
    console.log('[JobQueue] Processor stopped');
  }
}

export async function cleanupOldJobs(daysToKeep: number = 7): Promise<number> {
  const result = await db.execute(sql`DELETE FROM job_queue 
     WHERE status IN ('completed', 'failed') 
       AND processed_at < NOW() - INTERVAL '1 day' * ${daysToKeep}
     RETURNING id`);
  
  if (result.rowCount && result.rowCount > 0) {
    console.log(`[JobQueue] Cleaned up ${result.rowCount} old jobs`);
  }
  
  return result.rowCount || 0;
}

export async function getJobQueueStats(): Promise<{
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}> {
  const result = await db.execute(sql`SELECT status, COUNT(*)::int as count FROM job_queue GROUP BY status`);
  
  const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of result.rows) {
    if (row.status === 'pending') stats.pending = row.count;
    else if (row.status === 'processing') stats.processing = row.count;
    else if (row.status === 'completed') stats.completed = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
  }
  
  return stats;
}
