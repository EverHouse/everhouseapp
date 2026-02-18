import { db } from '../db';
import { sql } from 'drizzle-orm';

interface HubSpotQueueStats {
  pending: number;
  failed: number;
  completed_24h: number;
  processing: number;
}

interface FailedQueueItem {
  id: number;
  operation: string;
  lastError: string | null;
  createdAt: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
}

interface HubSpotQueueMonitorData {
  stats: HubSpotQueueStats;
  recentFailed: FailedQueueItem[];
  avgProcessingTime: number;
  queueLag: string;
}

export async function getHubSpotQueueMonitorData(): Promise<HubSpotQueueMonitorData> {
  const statsResult = await db.execute(sql`
    SELECT 
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int as pending,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int as failed,
      COALESCE(SUM(CASE WHEN status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END), 0)::int as completed_24h,
      COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0)::int as processing
    FROM hubspot_sync_queue
  `);

  const row = statsResult.rows[0] as Record<string, unknown>;
  const stats: HubSpotQueueStats = {
    pending: row?.pending || 0,
    failed: row?.failed || 0,
    completed_24h: row?.completed_24h || 0,
    processing: row?.processing || 0,
  };

  const failedResult = await db.execute(sql`
    SELECT id, operation, last_error, created_at, retry_count, max_retries, next_retry_at
    FROM hubspot_sync_queue
    WHERE status = 'failed'
    ORDER BY created_at DESC
    LIMIT 20
  `);

  const recentFailed: FailedQueueItem[] = failedResult.rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    operation: r.operation,
    lastError: r.last_error,
    createdAt: r.created_at?.toISOString?.() || r.created_at,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    nextRetryAt: r.next_retry_at?.toISOString?.() || r.next_retry_at,
  }));

  const avgResult = await db.execute(sql`
    SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000), 0)::int as avg_ms
    FROM hubspot_sync_queue
    WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours'
  `);
  const avgProcessingTime = (avgResult.rows[0] as Record<string, unknown>)?.avg_ms || 0;

  const lagResult = await db.execute(sql`
    SELECT MIN(created_at) as oldest_pending FROM hubspot_sync_queue WHERE status = 'pending'
  `);
  const oldestPending = (lagResult.rows[0] as Record<string, unknown>)?.oldest_pending;
  let queueLag = 'No pending items';
  if (oldestPending) {
    const lagMs = Date.now() - new Date(oldestPending).getTime();
    if (lagMs < 60000) queueLag = `${Math.round(lagMs / 1000)}s`;
    else if (lagMs < 3600000) queueLag = `${Math.round(lagMs / 60000)}m`;
    else queueLag = `${Math.round(lagMs / 3600000)}h`;
  }

  return { stats, recentFailed, avgProcessingTime, queueLag };
}
