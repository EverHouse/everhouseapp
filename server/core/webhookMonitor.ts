import { db } from '../db';
import { sql } from 'drizzle-orm';

interface WebhookEvent {
  id: number;
  eventType: string;
  trackmanBookingId: string | null;
  trackmanUserId: string | null;
  processedAt: string | null;
  processingError: string | null;
  matchedBookingId: number | null;
  matchedUserId: string | null;
  createdAt: string;
  retryCount: number;
  lastRetryAt: string | null;
  status: 'processed' | 'failed' | 'pending';
}

interface WebhookQueryParams {
  type?: string;
  status?: 'processed' | 'failed' | 'pending';
  limit?: number;
  offset?: number;
}

export async function getWebhookEvents(params: WebhookQueryParams): Promise<{ events: WebhookEvent[]; total: number }> {
  const limit = Math.min(params.limit || 50, 200);
  const offset = params.offset || 0;

  // Build parameterized WHERE clause
  const conditions = [];

  if (params.type) {
    conditions.push(sql`event_type = ${params.type}`);
  }

  if (params.status === 'processed') {
    conditions.push(sql`processed_at IS NOT NULL AND processing_error IS NULL`);
  } else if (params.status === 'failed') {
    conditions.push(sql`processing_error IS NOT NULL`);
  } else if (params.status === 'pending') {
    conditions.push(sql`processed_at IS NULL AND processing_error IS NULL`);
  }

  let whereClause = sql``;
  if (conditions.length > 0) {
    whereClause = sql`WHERE ${sql.join(conditions, sql` AND `)}`;
  }

  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int as total FROM trackman_webhook_events ${whereClause}
  `);
  const total = countResult.rows[0]?.total || 0;

  const result = await db.execute(sql`
    SELECT id, event_type, trackman_booking_id, trackman_user_id, processed_at, processing_error, matched_booking_id, matched_user_id, created_at, retry_count, last_retry_at
    FROM trackman_webhook_events ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const events: WebhookEvent[] = result.rows.map(row => ({
    id: row.id,
    eventType: row.event_type,
    trackmanBookingId: row.trackman_booking_id,
    trackmanUserId: row.trackman_user_id,
    processedAt: row.processed_at?.toISOString?.() || row.processed_at,
    processingError: row.processing_error,
    matchedBookingId: row.matched_booking_id,
    matchedUserId: row.matched_user_id,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    retryCount: row.retry_count || 0,
    lastRetryAt: row.last_retry_at?.toISOString?.() || row.last_retry_at,
    status: row.processing_error ? 'failed' : row.processed_at ? 'processed' : 'pending',
  }));

  return { events, total };
}

export async function getWebhookEventTypes(): Promise<string[]> {
  const result = await db.execute(sql`SELECT DISTINCT event_type FROM trackman_webhook_events ORDER BY event_type`);
  return result.rows.map(r => r.event_type);
}
