import { db } from '../db';
import { sql } from 'drizzle-orm';

interface JobQueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

interface FailedJob {
  id: number;
  jobType: string;
  lastError: string | null;
  createdAt: string;
  retryCount: number;
  maxRetries: number;
}

interface JobQueueMonitorData {
  stats: JobQueueStats;
  recentFailed: FailedJob[];
  recentCompleted: { id: number; jobType: string; processedAt: string }[];
  oldestPending: string | null;
}

export async function getJobQueueMonitorData(): Promise<JobQueueMonitorData> {
  const statsResult = await db.execute(sql`
    SELECT 
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int as pending,
      COALESCE(SUM(CASE WHEN status = 'pending' AND locked_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int as processing,
      COALESCE(SUM(CASE WHEN status = 'completed' AND processed_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END), 0)::int as completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int as failed
    FROM job_queue
  `);

  const stats: JobQueueStats = {
    pending: statsResult.rows[0]?.pending || 0,
    processing: statsResult.rows[0]?.processing || 0,
    completed: statsResult.rows[0]?.completed || 0,
    failed: statsResult.rows[0]?.failed || 0,
  };

  const failedResult = await db.execute(sql`
    SELECT id, job_type, last_error, created_at, retry_count, max_retries
    FROM job_queue
    WHERE status = 'failed'
    ORDER BY created_at DESC
    LIMIT 20
  `);

  const recentFailed: FailedJob[] = failedResult.rows.map(r => ({
    id: r.id,
    jobType: r.job_type,
    lastError: r.last_error,
    createdAt: r.created_at?.toISOString?.() || r.created_at,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
  }));

  const completedResult = await db.execute(sql`
    SELECT id, job_type, processed_at
    FROM job_queue
    WHERE status = 'completed' AND processed_at > NOW() - INTERVAL '24 hours'
    ORDER BY processed_at DESC
    LIMIT 10
  `);

  const recentCompleted = completedResult.rows.map(r => ({
    id: r.id,
    jobType: r.job_type,
    processedAt: r.processed_at?.toISOString?.() || r.processed_at,
  }));

  const oldestResult = await db.execute(sql`
    SELECT MIN(created_at) as oldest FROM job_queue WHERE status = 'pending'
  `);
  const oldestPending = oldestResult.rows[0]?.oldest?.toISOString?.() || null;

  return { stats, recentFailed, recentCompleted, oldestPending };
}
