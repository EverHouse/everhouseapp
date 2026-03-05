import { db } from '../db';
import { queryWithRetry } from './db';
import { getErrorMessage } from '../utils/errorUtils';
import { sql } from 'drizzle-orm';
import { schedulerTracker } from './schedulerTracker';
import type { PoolClient } from 'pg';
import { broadcastBillingUpdate, broadcastDayPassUpdate, sendNotificationToUser } from './websocket';
import { notifyPaymentSuccess, notifyPaymentFailed, notifyStaffPaymentFailed, notifyMember, notifyAllStaff } from './notificationService';
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from '../emails/paymentEmails';
import { sendMembershipRenewalEmail, sendMembershipFailedEmail } from '../emails/membershipEmails';
import { sendPassWithQrEmail } from '../emails/passEmails';
import { syncCompanyToHubSpot } from './hubspot';

import { logger } from './logger';

interface JobIdRow {
  id: number;
}

interface JobRow {
  id: number;
  job_type: string;
  payload: Record<string, unknown>;
  retry_count: number;
  max_retries: number;
}

interface JobStatusCountRow {
  status: string;
  count: number;
}

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
  | 'sync_company_to_hubspot'
  | 'upsert_transaction_cache'
  | 'update_member_tier'
  | 'stripe_credit_refund'
  | 'stripe_credit_consume'
  | 'stripe_auto_refund'
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
  const scheduledForIso = scheduledFor.toISOString();
  
  const result = await db.execute(sql`INSERT INTO job_queue (job_type, payload, priority, max_retries, scheduled_for, webhook_event_id)
     VALUES (${jobType}, ${JSON.stringify(payload)}, ${priority}, ${maxRetries}, ${scheduledForIso}::timestamptz, ${webhookEventId})
     RETURNING id`);
  
  return (result.rows[0] as unknown as JobIdRow).id;
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
    const scheduledForIso = scheduledFor.toISOString();
    return sql`(${job.jobType}, ${JSON.stringify(job.payload)}, ${priority}, ${maxRetries}, ${scheduledForIso}::timestamptz, ${webhookEventId})`;
  });
  
  const result = await db.execute(sql`INSERT INTO job_queue (job_type, payload, priority, max_retries, scheduled_for, webhook_event_id)
     VALUES ${sql.join(valuesSql, sql`, `)}
     RETURNING id`);
  
  return result.rows.map((r: Record<string, unknown>) => r.id as number);
}

async function claimJobs(): Promise<Array<{ id: number; jobType: string; payload: Record<string, unknown>; retryCount: number; maxRetries: number }>> {
  const nowIso = new Date().toISOString();
  const lockExpiryIso = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
  
  const result = await queryWithRetry(
    `UPDATE job_queue
     SET locked_at = $1::timestamptz, locked_by = $2
     WHERE id IN (
       SELECT id FROM job_queue
       WHERE status = 'pending'
         AND scheduled_for <= $3::timestamptz
         AND (locked_at IS NULL OR locked_at < $4::timestamptz)
       ORDER BY priority DESC, scheduled_for ASC
       LIMIT $5
     )
     RETURNING id, job_type, payload, retry_count, max_retries`,
    [nowIso, WORKER_ID, nowIso, lockExpiryIso, BATCH_SIZE],
    3
  );
  
  return result.rows.map((r) => {
    const row = r as unknown as JobRow;
    return {
      id: row.id,
      jobType: row.job_type,
      payload: row.payload,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
    };
  });
}

async function markJobCompleted(jobId: number): Promise<void> {
  await queryWithRetry(
    `UPDATE job_queue SET status = 'completed', processed_at = NOW(), locked_at = NULL, locked_by = NULL WHERE id = $1`,
    [jobId],
    3
  );
}

async function markJobFailed(jobId: number, error: string, retryCount: number, maxRetries: number): Promise<void> {
  if (retryCount + 1 >= maxRetries) {
    await queryWithRetry(
      `UPDATE job_queue SET status = 'failed', last_error = $1, retry_count = retry_count + 1, locked_at = NULL, locked_by = NULL WHERE id = $2`,
      [error, jobId],
      3
    );
  } else {
    const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 60000);
    const nextScheduledIso = new Date(Date.now() + backoffMs).toISOString();
    await queryWithRetry(
      `UPDATE job_queue SET last_error = $1, retry_count = retry_count + 1, scheduled_for = $2::timestamptz, locked_at = NULL, locked_by = NULL WHERE id = $3`,
      [error, nextScheduledIso, jobId],
      3
    );
  }
}

async function executeJob(job: { id: number; jobType: string; payload: Record<string, unknown>; retryCount: number; maxRetries: number }): Promise<void> {
  const { jobType, payload } = job;
  
  try {
    switch (jobType) {
      case 'send_payment_receipt':
        await sendPaymentReceiptEmail(payload.to as string, { memberName: payload.memberName as string, amount: Number(payload.amount), date: new Date(payload.date as string), description: payload.description as string, transactionId: payload.paymentMethod as string });
        break;
      case 'send_payment_failed_email':
        await sendPaymentFailedEmail(payload.to as string, { memberName: payload.memberName as string, amount: Number(payload.amount), reason: payload.reason as string, updateCardUrl: payload.retryDate as string });
        break;
      case 'send_membership_renewal_email':
        await sendMembershipRenewalEmail(payload.to as string, { memberName: payload.memberName as string, planName: payload.tier as string, nextBillingDate: new Date(payload.nextBillingDate as string), amount: Number(payload.amount) });
        break;
      case 'send_membership_failed_email':
        await sendMembershipFailedEmail(payload.to as string, { memberName: payload.memberName as string, planName: payload.tier as string, reason: payload.reason as string, amount: Number(payload.amount) || 0 });
        break;
      case 'send_pass_with_qr_email':
        await sendPassWithQrEmail(payload.to as string, payload.passPurchase as unknown as { passId: number; type: string; quantity: number; purchaseDate: Date });
        break;
      case 'notify_payment_success':
        await notifyPaymentSuccess(payload.userEmail as string, Number(payload.amount), payload.description as string);
        break;
      case 'notify_payment_failed':
        await notifyPaymentFailed(payload.userEmail as string, Number(payload.amount), payload.reason as string);
        break;
      case 'notify_staff_payment_failed':
        await notifyStaffPaymentFailed(payload.memberEmail as string, payload.memberName as string, Number(payload.amount), payload.reason as string);
        break;
      case 'notify_member':
        await notifyMember({
          userEmail: payload.userEmail as string,
          title: payload.title as string,
          message: payload.message as string,
          type: payload.type as 'info' | 'success' | 'warning' | 'error' | 'system' | 'booking' | 'booking_approved' | 'booking_declined' | 'booking_reminder' | 'booking_cancelled',
          relatedId: payload.relatedId as number,
          relatedType: payload.relatedType as string,
        });
        break;
      case 'notify_all_staff':
        await notifyAllStaff(payload.title as string, payload.message as string, payload.type as 'info' | 'success' | 'warning' | 'error' | 'system' | 'booking' | 'booking_approved' | 'booking_declined' | 'booking_reminder' | 'booking_cancelled', {
          relatedId: payload.relatedId as number,
          relatedType: payload.relatedType as string,
          url: payload.actionUrl as string,
        });
        break;
      case 'broadcast_billing_update':
        broadcastBillingUpdate(payload as unknown as Parameters<typeof broadcastBillingUpdate>[0]);
        break;
      case 'broadcast_day_pass_update':
        broadcastDayPassUpdate(payload as unknown as Parameters<typeof broadcastDayPassUpdate>[0]);
        break;
      case 'send_notification_to_user':
        sendNotificationToUser(payload.userEmail as string, payload.notification as unknown as { type: string; title: string; message: string; data?: Record<string, unknown> });
        break;
      case 'sync_company_to_hubspot':
        await syncCompanyToHubSpot(payload as unknown as Parameters<typeof syncCompanyToHubSpot>[0]);
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
      case 'stripe_auto_refund': {
        const { getStripeClient: getStripeForRefund } = await import('./stripe/client');
        const stripeRefund = await getStripeForRefund();
        try {
          const refundCreateParams: { payment_intent: string; reason: 'duplicate' | 'fraudulent' | 'requested_by_customer'; metadata: Record<string, string>; amount?: number } = {
            payment_intent: payload.paymentIntentId as string,
            reason: ((payload.reason as string) || 'duplicate') as 'duplicate' | 'fraudulent' | 'requested_by_customer',
            metadata: payload.metadata as Record<string, string>,
          };
          if (payload.amountCents) {
            refundCreateParams.amount = payload.amountCents as number;
          }
          const refund = await stripeRefund.refunds.create(
            refundCreateParams,
            { idempotencyKey: payload.idempotencyKey as string }
          );
          logger.info(`[JobQueue] Auto-refund issued: ${refund.id} for PI ${payload.paymentIntentId}, amount: ${payload.amountCents || 'full'}`);
        } catch (refundError: unknown) {
          logger.error(`[JobQueue] Auto-refund failed for PI ${payload.paymentIntentId} — flagging for manual review`, { error: refundError });
          if (payload.sessionId) {
            await queryWithRetry(
              `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
              [payload.reviewReason as string, Number(payload.sessionId)],
              3
            );
          }
          throw refundError;
        }
        break;
      }
      case 'update_member_tier':
        const { processMemberTierUpdate } = await import('./memberTierUpdateProcessor');
        await processMemberTierUpdate(payload as unknown as Parameters<typeof processMemberTierUpdate>[0]);
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
  
  logger.info(`[Startup] Job queue processor enabled (runs every ${intervalMs / 1000}s, starting after 15s warmup)`);
  
  setTimeout(() => {
    processJobs().catch(err => {
      logger.error('[JobQueue] Initial job scan error:', { error: err });
    });
    
    processingInterval = setInterval(async () => {
      try {
        await processJobs();
        schedulerTracker.recordRun('Job Queue Processor', true);
      } catch (error: unknown) {
        logger.error('[JobQueue] Processing error:', { error: error });
        schedulerTracker.recordRun('Job Queue Processor', false, String(error));
      }
    }, intervalMs);
  }, 15000);
}

export function stopJobProcessor(): void {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
    logger.info('[JobQueue] Processor stopped');
  }
}

export async function cleanupOldJobs(daysToKeep: number = 7): Promise<number> {
  const result = await queryWithRetry(
    `DELETE FROM job_queue 
     WHERE status IN ('completed', 'failed') 
       AND processed_at < NOW() - INTERVAL '1 day' * $1
     RETURNING id`,
    [daysToKeep],
    3
  );
  
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
  const result = await queryWithRetry(
    `SELECT status, COUNT(*)::int as count FROM job_queue GROUP BY status`,
    [],
    3
  );
  
  const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const _row of result.rows) {
    const row = _row as unknown as JobStatusCountRow;
    if (row.status === 'pending') stats.pending = row.count;
    else if (row.status === 'processing') stats.processing = row.count;
    else if (row.status === 'completed') stats.completed = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
  }
  
  return stats;
}
