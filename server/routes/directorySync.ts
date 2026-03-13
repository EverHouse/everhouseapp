import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { logger } from '../core/logger';
import { createBackgroundJob, updateJobProgress, completeJob, failJob, getActiveJob, getLatestJob } from '../core/backgroundJobStore';
import { broadcastDirectorySyncUpdate } from '../core/websocket';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../utils/errorUtils';

const router = Router();

const JOB_TYPE = 'directory_sync';

function getInternalBaseUrl(): string {
  const port = process.env.PORT || '3001';
  return `http://localhost:${port}`;
}

async function internalPost(path: string, sessionCookie: string): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(`${getInternalBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
    },
    body: JSON.stringify({}),
  });
  const data = await res.json() as Record<string, unknown>;
  return { ok: res.ok, data };
}

async function runDirectorySync(jobId: string, sessionCookie: string) {
  let pullCount = 0;
  let pushCount = 0;
  let stripeUpdated = 0;
  const errors: string[] = [];

  await updateJobProgress(jobId, { step: 'hubspot_pull' });
  broadcastDirectorySyncUpdate({ status: 'running', jobId, progress: { step: 'hubspot_pull' } });

  try {
    const result = await internalPost('/api/hubspot/sync-all-members', sessionCookie);
    if (result.ok) {
      pullCount = (result.data.synced as number) || 0;
    } else {
      errors.push('pull');
      logger.error('[DirectorySync] HubSpot pull failed', { extra: { response: result.data } });
    }
  } catch (err: unknown) {
    errors.push('pull');
    logger.error('[DirectorySync] HubSpot pull failed', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  await updateJobProgress(jobId, { step: 'hubspot_push', pullCount });
  broadcastDirectorySyncUpdate({ status: 'running', jobId, progress: { step: 'hubspot_push', pullCount } });

  try {
    const result = await internalPost('/api/hubspot/push-members-to-hubspot', sessionCookie);
    if (result.ok) {
      pushCount = (result.data.synced as number) || 0;
    } else {
      errors.push('push');
      logger.error('[DirectorySync] HubSpot push failed', { extra: { response: result.data } });
    }
  } catch (err: unknown) {
    errors.push('push');
    logger.error('[DirectorySync] HubSpot push failed', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  await updateJobProgress(jobId, { step: 'stripe', pullCount, pushCount });
  broadcastDirectorySyncUpdate({ status: 'running', jobId, progress: { step: 'stripe', pullCount, pushCount } });

  try {
    const result = await internalPost('/api/stripe/sync-member-subscriptions', sessionCookie);
    if (result.ok) {
      stripeUpdated = (result.data.updated as number) || 0;
    } else if ((result.data as Record<string, unknown>).cooldownRemaining) {
      stripeUpdated = 0;
    } else {
      errors.push('stripe');
      logger.error('[DirectorySync] Stripe sync failed', { extra: { response: result.data } });
    }
  } catch (err: unknown) {
    errors.push('stripe');
    logger.error('[DirectorySync] Stripe sync failed', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  const syncResult = { pullCount, pushCount, stripeUpdated, errors };
  const lastSyncTime = new Date().toISOString();

  if (errors.length === 3) {
    await failJob(jobId, 'All sync operations failed', { ...syncResult });
    broadcastDirectorySyncUpdate({ status: 'failed', jobId, result: syncResult, error: 'All sync operations failed', lastSyncTime });
  } else {
    await completeJob(jobId, syncResult, { ...syncResult });
    broadcastDirectorySyncUpdate({ status: 'completed', jobId, result: syncResult, lastSyncTime });
  }
}

router.post('/api/directory/sync', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const activeJob = await getActiveJob(JOB_TYPE);
    if (activeJob) {
      return res.json({ started: false, message: 'Sync already in progress', jobId: activeJob.id });
    }

    const sessionCookie = req.headers.cookie || '';

    const jobId = `dir_sync_${Date.now()}`;
    await createBackgroundJob({
      id: jobId,
      jobType: JOB_TYPE,
      dryRun: false,
      progress: { step: 'starting' },
    });

    res.json({ started: true, jobId });

    runDirectorySync(jobId, sessionCookie).catch(async (err: unknown) => {
      logger.error('[DirectorySync] Unexpected error in background sync', { error: err instanceof Error ? err : new Error(String(err)) });
      try {
        await failJob(jobId, getErrorMessage(err), { step: 'unexpected_error' });
        broadcastDirectorySyncUpdate({ status: 'failed', jobId, error: getErrorMessage(err) });
      } catch (failErr: unknown) {
        logger.error('[DirectorySync] Failed to record job failure', { error: failErr instanceof Error ? failErr : new Error(String(failErr)) });
      }
    });
  } catch (error: unknown) {
    logger.error('[DirectorySync] Failed to start sync', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to start directory sync' });
  }
});

router.get('/api/directory/sync-status', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const activeJob = await getActiveJob(JOB_TYPE);
    if (activeJob) {
      return res.json({
        status: 'running',
        jobId: activeJob.id,
        startedAt: activeJob.startedAt,
        progress: activeJob.progress,
      });
    }

    const latestJob = await getLatestJob(JOB_TYPE);
    if (latestJob) {
      const lastSyncSetting = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'last_member_sync_time'`);
      const lastSyncTime = lastSyncSetting.rows.length > 0 ? new Date(Number((lastSyncSetting.rows[0] as { value: string }).value)).toISOString() : null;

      return res.json({
        status: latestJob.status,
        jobId: latestJob.id,
        startedAt: latestJob.startedAt,
        completedAt: latestJob.completedAt,
        result: latestJob.result,
        error: latestJob.error,
        lastSyncTime,
      });
    }

    const lastSyncSetting = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'last_member_sync_time'`);
    const lastSyncTime = lastSyncSetting.rows.length > 0 ? new Date(Number((lastSyncSetting.rows[0] as { value: string }).value)).toISOString() : null;

    res.json({ status: 'idle', lastSyncTime });
  } catch (error: unknown) {
    logger.error('[DirectorySync] Failed to get sync status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

export default router;
