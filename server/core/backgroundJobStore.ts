import { db } from '../db';
import { backgroundJobs } from '../../shared/schema';
import { eq, and, desc, lt, sql } from 'drizzle-orm';

const STALE_JOB_TIMEOUT_MINUTES = 30;

export interface BackgroundJobData {
  id: string;
  jobType: string;
  status: 'running' | 'completed' | 'failed';
  dryRun: boolean;
  startedAt: Date;
  completedAt?: Date | null;
  progress: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  startedBy?: string | null;
}

export async function createBackgroundJob(data: {
  id: string;
  jobType: string;
  dryRun: boolean;
  progress: Record<string, unknown>;
  startedBy?: string;
}): Promise<void> {
  await db.update(backgroundJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      error: 'Marked as failed: server restarted or job timed out',
    })
    .where(and(
      eq(backgroundJobs.jobType, data.jobType),
      eq(backgroundJobs.status, 'running'),
    ));

  await db.insert(backgroundJobs).values({
    id: data.id,
    jobType: data.jobType,
    status: 'running',
    dryRun: data.dryRun,
    progress: data.progress,
    startedBy: data.startedBy,
  });
}

export async function updateJobProgress(
  jobId: string,
  progress: Record<string, unknown>
): Promise<void> {
  await db.update(backgroundJobs)
    .set({ progress })
    .where(eq(backgroundJobs.id, jobId));
}

export async function completeJob(
  jobId: string,
  result: Record<string, unknown>,
  progress: Record<string, unknown>
): Promise<void> {
  await db.update(backgroundJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      result,
      progress,
    })
    .where(eq(backgroundJobs.id, jobId));
}

export async function failJob(
  jobId: string,
  error: string,
  progress: Record<string, unknown>
): Promise<void> {
  await db.update(backgroundJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      error,
      progress,
    })
    .where(eq(backgroundJobs.id, jobId));
}

export async function getActiveJob(jobType: string): Promise<BackgroundJobData | null> {
  await db.update(backgroundJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      error: `Job timed out after ${STALE_JOB_TIMEOUT_MINUTES} minutes`,
    })
    .where(and(
      eq(backgroundJobs.jobType, jobType),
      eq(backgroundJobs.status, 'running'),
      lt(backgroundJobs.startedAt, sql`NOW() - INTERVAL '${sql.raw(String(STALE_JOB_TIMEOUT_MINUTES))} minutes'`)
    ));

  const rows = await db.select().from(backgroundJobs)
    .where(and(
      eq(backgroundJobs.jobType, jobType),
      eq(backgroundJobs.status, 'running')
    ))
    .limit(1);

  if (rows.length === 0) return null;
  return rows[0] as unknown as BackgroundJobData;
}

export async function getLatestJob(jobType: string): Promise<BackgroundJobData | null> {
  const rows = await db.select().from(backgroundJobs)
    .where(eq(backgroundJobs.jobType, jobType))
    .orderBy(desc(backgroundJobs.startedAt))
    .limit(1);

  if (rows.length === 0) return null;
  return rows[0] as unknown as BackgroundJobData;
}
