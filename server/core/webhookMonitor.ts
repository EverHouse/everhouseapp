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
  const total = (countResult.rows[0] as Record<string, unknown>)?.total || 0;

  const result = await db.execute(sql`
    SELECT id, event_type, trackman_booking_id, trackman_user_id, processed_at, processing_error, matched_booking_id, matched_user_id, created_at, retry_count, last_retry_at
    FROM trackman_webhook_events ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const events = (result.rows as Record<string, unknown>[]).map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    eventType: String(row.event_type),
    trackmanBookingId: String(row.trackman_booking_id || ''),
    trackmanUserId: String(row.trackman_user_id || ''),
    processedAt: (row.processed_at as any)?.toISOString?.() || (row.processed_at ? new Date(String(row.processed_at) + 'Z').toISOString() : null),
    processingError: row.processing_error ? String(row.processing_error) : null,
    matchedBookingId: row.matched_booking_id ? Number(row.matched_booking_id) : null,
    matchedUserId: row.matched_user_id ? Number(row.matched_user_id) : null,
    createdAt: (row.created_at as any)?.toISOString?.() || new Date(String(row.created_at) + 'Z').toISOString(),
    retryCount: Number(row.retry_count || 0),
    lastRetryAt: (row.last_retry_at as any)?.toISOString?.() || (row.last_retry_at ? new Date(String(row.last_retry_at) + 'Z').toISOString() : null),
    status: (row.processing_error ? 'failed' : row.processed_at ? 'processed' : 'pending') as 'pending' | 'failed' | 'processed',
  }));

  return { events: events as unknown as WebhookEvent[], total: total as number };
}

export async function getWebhookEventTypes(): Promise<string[]> {
  const result = await db.execute(sql`SELECT DISTINCT event_type FROM trackman_webhook_events ORDER BY event_type`);
  return result.rows.map((r: Record<string, unknown>) => r.event_type as string);
}
