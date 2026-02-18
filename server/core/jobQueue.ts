import { db } from '../db';
import { getErrorMessage } from '../utils/errorUtils';
import { sql } from 'drizzle-orm';
import { schedulerTracker } from './schedulerTracker';
import type { PoolClient } from 'pg';
import { broadcastBillingUpdate, broadcastDayPassUpdate, sendNotificationToUser } from './websocket';
import { notifyPaymentSuccess, notifyPaymentFailed, notifyStaffPaymentFailed, notifyMember, notifyAllStaff } from './notificationService';
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from '../emails/paymentEmails';
import { sendMembershipRenewalEmail, sendMembershipFailedEmail } from '../emails/membershipEmails';
import { sendPassWithQrEmail } from '../emails/passEmails';
import { queuePaymentSyncToHubSpot, queueDayPassSyncToHubSpot, syncCompanyToHubSpot } from './hubspot';

import { logger } from './logger';
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
  | 'stripe_credit_refund'
  | 'stripe_credit_consume'
  | 'generic_async_task';

interface QueueJobOptions {
  priority?: number;
  maxRetries?: number;
  scheduledFor?: Date;
  webhookEventId?: string;
}

export async function queueJob(
  jobType: JobType,
  payload: Record<string, unknown>,
  options: QueueJobOptions = {}
): Promise<number> {
  const { priority = 0, maxRetries = 3, scheduledFor = new Date(), webhookEventId } = options;
  
  const result = await db.execute(sql`INSERT INTO job_queue (job_type, payload, priority, max_retries, scheduled_for, webhook_event_id)
     VALUES (${jobType}, ${JSON.stringify(payload)}, ${priority}, ${maxRetries}, ${scheduledFor}, ${webhookEventId})
     RETURNING id`);
  
  return (result.rows[0] as Record<string, unknown>).id as number;
}

export async function queueJobInTransaction(
  client: PoolClient,
  jobType: JobType,
  payload: Record<string, unknown>,
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
  jobs: Array<{ jobType: JobType; payload: Record<string, unknown>; options?: QueueJobOptions }>
): Promise<number[]> {
  if (jobs.length === 0) return [];
  
  const valuesSql = jobs.map(job => {
    const { priority = 0, maxRetries = 3, scheduledFor = new Date(), webhookEventId } = job.options || {};
    return sql`(${job.jobType}, ${JSON.stringify(job.payload)}, ${priority}, ${maxRetries}, ${scheduledFor}, ${webhookEventId})`;
  });
  
  const result = await db.execute(sql`INSERT INTO job_queue (job_type, payload, priority, max_retries, scheduled_for, webhook_event_id)
     VALUES ${sql.join(valuesSql, sql`, `)}
     RETURNING id`);
  
  return result.rows.map((r: Record<string, unknown>) => r.id as number);
}

async function claimJobs(): Promise<Array<{ id: number; jobType: string; payload: Record<string, unknown>; retryCount: number; maxRetries: number }>> {
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
  
  return result.rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    jobType: r.job_type as string,
    payload: r.payload as Record<string, unknown>,
    retryCount: r.retry_count as number,
    maxRetries: r.max_retries as number,
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

async function executeJob(job: { id: number; jobType: string; payload: Record<string, unknown>; retryCount: number; maxRetries: number }): Promise<void> {
  const { jobType, payload } = job;
  
  try {
    switch (jobType) {
      case 'send_payment_receipt':
        await sendPaymentReceiptEmail(payload.to as string, { memberName: payload.memberName as string, amount: payload.amount as string, date: payload.date as string, description: payload.description as string, transactionId: payload.paymentMethod as string } as any);
        break;
      case 'send_payment_failed_email':
        await sendPaymentFailedEmail(payload.to as string, { memberName: payload.memberName as string, amount: payload.amount as string, reason: payload.reason as string, updateCardUrl: payload.retryDate as string } as any);
        break;
      case 'send_membership_renewal_email':
        await sendMembershipRenewalEmail(payload.to as string, { memberName: payload.memberName as string, planName: payload.tier as string, nextBillingDate: payload.nextBillingDate as string, amount: payload.amount as string } as any);
        break;
      case 'send_membership_failed_email':
        await sendMembershipFailedEmail(payload.to as string, { memberName: payload.memberName as string, planName: payload.tier as string, reason: payload.reason as string, amount: (payload.amount as string) || '0' } as any);
        break;
      case 'send_pass_with_qr_email':
        await sendPassWithQrEmail(payload.to as string, payload.passPurchase as any);
        break;
      case 'notify_payment_success':
        await notifyPaymentSuccess(payload.userEmail as string, payload.amount as string, payload.description as string);
        break;
      case 'notify_payment_failed':
        await notifyPaymentFailed(payload.userEmail as string, payload.amount as string, payload.reason as string);
        break;
      case 'notify_staff_payment_failed':
        await notifyStaffPaymentFailed(payload.memberEmail as string, payload.memberName as string, payload.amount as string, payload.reason as string);
        break;
      case 'notify_member':
        await notifyMember({
          userEmail: payload.userEmail as string,
          title: payload.title as string,
          message: payload.message as string,
          type: payload.type as any,
          relatedId: payload.relatedId as string,
          relatedType: payload.relatedType as string,
        });
        break;
      case 'notify_all_staff':
        await notifyAllStaff(payload.title as string, payload.message as string, payload.type as any, {
          relatedId: payload.relatedId as string,
          relatedType: payload.relatedType as string,
          url: payload.actionUrl as string,
        });
        break;
      case 'broadcast_billing_update':
        broadcastBillingUpdate(payload as any);
        break;
      case 'broadcast_day_pass_update':
        broadcastDayPassUpdate(payload as any);
        break;
      case 'send_notification_to_user':
        sendNotificationToUser(payload.userEmail as string, payload.notification as any);
        break;
      case 'sync_to_hubspot':
        await queuePaymentSyncToHubSpot(payload as any);
        break;
      case 'sync_company_to_hubspot':
        await syncCompanyToHubSpot(payload as any);
        break;
      case 'sync_day_pass_to_hubspot':
        await queueDayPassSyncToHubSpot(payload as any);
        break;
      case 'upsert_transaction_cache':
        const { upsertTransactionCache } = await import('./stripe/transactionCache');
        await upsertTransactionCache(payload as Record<string, string>);
        break;
      case 'stripe_credit_refund': {
        const { getStripeClient } = await import('./stripe/client');
        const stripeRefund = await getStripeClient();
        await stripeRefund.refunds.create({
          payment_intent: payload.paymentIntentId as string,
          amount: payload.amountCents as number,
          reason: 'requested_by_customer',
          metadata: {
            type: 'account_credit_applied',
            originalPaymentIntent: payload.paymentIntentId as string,
            email: payload.email as string
          }
        }, {
          idempotencyKey: `credit_refund_${payload.paymentIntentId}_${payload.amountCents}`
        });
        logger.info(`[JobQueue] Applied credit refund of $${(Number(payload.amountCents) / 100).toFixed(2)} for ${payload.email}`);
        break;
      }
      case 'stripe_credit_consume': {
        const { getStripeClient: getStripeForConsume } = await import('./stripe/client');
        const stripeConsume = await getStripeForConsume();
        await stripeConsume.customers.createBalanceTransaction(
          payload.customerId as string,
          {
            amount: payload.amountCents as number,
            currency: 'usd',
            description: `Account credit applied to payment ${payload.paymentIntentId}`,
          },
          {
            idempotencyKey: `credit_consume_${payload.paymentIntentId}_${payload.amountCents}`
          }
        );
        logger.info(`[JobQueue] Consumed account credit of $${(Number(payload.amountCents) / 100).toFixed(2)} for ${payload.email}`);
        break;
      }
      case 'update_member_tier':
        const { processMemberTierUpdate } = await import('./memberTierUpdateProcessor');
        await processMemberTierUpdate(payload as any);
        break;
      case 'generic_async_task':
        logger.info(`[JobQueue] Executing generic task: ${payload.description || 'no description'}`);
        break;
      default:
        logger.warn(`[JobQueue] Unknown job type: ${jobType}`);
    }
    
    await markJobCompleted(job.id);
  } catch (error: unknown) {
    logger.error(`[JobQueue] Job ${job.id} (${jobType}) failed:`, { error: getErrorMessage(error) || error });
    await markJobFailed(job.id, getErrorMessage(error) || String(error), job.retryCount, job.maxRetries);
  }
}

let processingInterval: ReturnType<typeof setInterval> | null = null;

export async function processJobs(): Promise<number> {
  const jobs = await claimJobs();
  
  if (jobs.length === 0) return 0;
  
  logger.info(`[JobQueue] Processing ${jobs.length} job(s)`);
  
  await Promise.allSettled(jobs.map(job => executeJob(job)));
  
  return jobs.length;
}

export function startJobProcessor(intervalMs: number = 5000): void {
  if (processingInterval) {
    logger.info('[JobQueue] Processor already running');
    return;
  }
  
  logger.info(`[Startup] Job queue processor enabled (runs every ${intervalMs / 1000}s)`);
  
  processingInterval = setInterval(async () => {
    try {
      await processJobs();
      schedulerTracker.recordRun('Job Queue Processor', true);
    } catch (error) {
      logger.error('[JobQueue] Processing error:', { error: error });
      schedulerTracker.recordRun('Job Queue Processor', false, String(error));
    }
  }, intervalMs);
}

export function stopJobProcessor(): void {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
    logger.info('[JobQueue] Processor stopped');
  }
}

export async function cleanupOldJobs(daysToKeep: number = 7): Promise<number> {
  const result = await db.execute(sql`DELETE FROM job_queue 
     WHERE status IN ('completed', 'failed') 
       AND processed_at < NOW() - INTERVAL '1 day' * ${daysToKeep}
     RETURNING id`);
  
  if (result.rowCount && result.rowCount > 0) {
    logger.info(`[JobQueue] Cleaned up ${result.rowCount} old jobs`);
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
  for (const _row of result.rows) {
    const row = _row as Record<string, unknown>;
    if (row.status === 'pending') stats.pending = row.count as number;
    else if (row.status === 'processing') stats.processing = row.count as number;
    else if (row.status === 'completed') stats.completed = row.count as number;
    else if (row.status === 'failed') stats.failed = row.count as number;
  }
  
  return stats;
}
