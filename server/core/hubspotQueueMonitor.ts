import { queryWithRetry } from './db';

interface HubSpotQueueStats {
  pending: number;
  failed: number;
  completed_24h: number;
  superseded_24h: number;
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

interface FailedQueueRow {
  id: number;
  operation: string;
  last_error: string | null;
  created_at: string | Date;
  retry_count: number;
  max_retries: number;
  next_retry_at: string | Date | null;
}

interface HubSpotQueueMonitorData {
  stats: HubSpotQueueStats;
  recentFailed: FailedQueueItem[];
  avgProcessingTime: number;
  queueLag: string;
}

export async function getHubSpotQueueMonitorData(): Promise<HubSpotQueueMonitorData> {
  const statsResult = await queryWithRetry(
    `SELECT 
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int as pending,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int as failed,
      COALESCE(SUM(CASE WHEN status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END), 0)::int as completed_24h,
      COALESCE(SUM(CASE WHEN status = 'superseded' AND completed_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END), 0)::int as superseded_24h,
      COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0)::int as processing
    FROM hubspot_sync_queue`,
    [],
    3
  );

  const row = statsResult.rows[0] as unknown as HubSpotQueueStats;
  const stats: HubSpotQueueStats = {
    pending: Number(row?.pending) || 0,
    failed: Number(row?.failed) || 0,
    completed_24h: Number(row?.completed_24h) || 0,
    superseded_24h: Number(row?.superseded_24h) || 0,
    processing: Number(row?.processing) || 0,
  };

  const failedResult = await queryWithRetry(
    `SELECT id, operation, last_error, created_at, retry_count, max_retries, next_retry_at
    FROM hubspot_sync_queue
    WHERE status = 'failed'
    ORDER BY created_at DESC
    LIMIT 20`,
    [],
    3
  );

  const recentFailed: FailedQueueItem[] = failedResult.rows.map((_r) => {
    const r = _r as unknown as FailedQueueRow;
    return {
      id: r.id,
      operation: r.operation,
      lastError: r.last_error,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      retryCount: Number(r.retry_count),
      maxRetries: Number(r.max_retries),
      nextRetryAt: r.next_retry_at instanceof Date ? r.next_retry_at.toISOString() : String(r.next_retry_at || ''),
    };
  });

  const avgResult = await queryWithRetry(
    `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000), 0)::int as avg_ms
    FROM hubspot_sync_queue
    WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours'`,
    [],
    3
  );
  const avgProcessingTime = Number((avgResult.rows[0] as { avg_ms?: number })?.avg_ms) || 0;

  const lagResult = await queryWithRetry(
    `SELECT MIN(created_at) as oldest_pending FROM hubspot_sync_queue WHERE status = 'pending'`,
    [],
    3
  );
  const oldestPending = (lagResult.rows[0] as { oldest_pending?: string | Date })?.oldest_pending;
  let queueLag = 'No pending items';
  if (oldestPending) {
    const lagMs = Date.now() - new Date(oldestPending as string).getTime();
    if (lagMs < 60000) queueLag = `${Math.round(lagMs / 1000)}s`;
    else if (lagMs < 3600000) queueLag = `${Math.round(lagMs / 60000)}m`;
    else queueLag = `${Math.round(lagMs / 3600000)}h`;
  }

  return { stats, recentFailed, avgProcessingTime, queueLag };
}
