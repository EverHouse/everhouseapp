import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { logger } from '../core/logger';
import { createBackgroundJob, updateJobProgress, completeJob, failJob, getActiveJob, getLatestJob } from '../core/backgroundJobStore';
import { broadcastDirectorySyncUpdate } from '../core/websocket';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../utils/errorUtils';
import { isPlaceholderEmail } from '../core/stripe/customers';

const router = Router();

const JOB_TYPE = 'directory_sync';

function getInternalBaseUrl(): string {
  const port = process.env.PORT || '3001';
  return `http://localhost:${port}`;
}

async function internalPost(path: string, sessionCookie: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${getInternalBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
    },
    body: JSON.stringify({}),
  });
  const data = await res.json() as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

const PUSH_BATCH_SIZE = 5;

async function pushMembersDirectly(jobId: string): Promise<{ synced: number; errors: number; errorDetails: string[] }> {
  const membersResult = await db.execute(sql`
    SELECT email, membership_status, billing_provider, tier, hubspot_id, first_name, last_name
    FROM users
    WHERE membership_status IN ('active', 'trialing', 'past_due') AND email IS NOT NULL
    ORDER BY email
  `);
  const members = membersResult.rows as unknown as Array<{
    email: string;
    membership_status: string | null;
    billing_provider: string | null;
    tier: string | null;
    hubspot_id: string | null;
    first_name: string | null;
    last_name: string | null;
  }>;

  let synced = 0;
  let errors = 0;
  const errorDetails: string[] = [];
  const { syncMemberToHubSpot } = await import('../core/hubspot/stages');

  for (let i = 0; i < members.length; i += PUSH_BATCH_SIZE) {
    const batch = members.slice(i, i + PUSH_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (member) => {
        if (isPlaceholderEmail(member.email)) return { skipped: true, success: false, email: member.email };
        const res = await syncMemberToHubSpot({
          email: member.email,
          status: member.membership_status || undefined,
          tier: member.tier || undefined,
          billingProvider: member.billing_provider || undefined,
        });
        return { ...res, email: member.email };
      })
    );

    for (let j = 0; j < results.length; j++) {
      const settlement = results[j];
      const email = batch[j]?.email || 'unknown';

      if (settlement.status === 'rejected') {
        errors++;
        const errMsg = getErrorMessage(settlement.reason);
        errorDetails.push(`${email}: ${errMsg}`);
        logger.warn('[HubSpot Push] Failed to push member (rejected)', { extra: { email, error: errMsg } });
        continue;
      }

      const value = settlement.value;
      if (value && 'skipped' in value) continue;

      if (value && value.success) {
        synced++;
      } else {
        errors++;
        const errMsg = value?.error || 'Unknown error';
        errorDetails.push(`${email}: ${errMsg}`);
        logger.warn('[HubSpot Push] Failed to push member', { extra: { email, error: errMsg } });
      }
    }

    if (i + PUSH_BATCH_SIZE < members.length) {
      await updateJobProgress(jobId, {
        step: 'hubspot_push',
        pushProgress: `${Math.min(i + PUSH_BATCH_SIZE, members.length)}/${members.length}`,
      });
    }
  }

  try {
    const { invalidateHubSpotContactsCache } = await import('./hubspot/index');
    invalidateHubSpotContactsCache();
  } catch (_e) {
    logger.debug('[DirectorySync] Could not invalidate HubSpot contacts cache');
  }

  logger.info(`[DirectorySync] Push complete: ${synced} synced, ${errors} errors out of ${members.length} members`);
  return { synced, errors, errorDetails };
}

async function runDirectorySync(jobId: string, sessionCookie: string) {
  let pullCount = 0;
  let pushCount = 0;
  let stripeUpdated = 0;
  let stripeSkipped = false;
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

  let pushErrors = 0;
  try {
    const pushResult = await pushMembersDirectly(jobId);
    pushCount = pushResult.synced;
    pushErrors = pushResult.errors;
    if (pushResult.errors > 0 && pushResult.synced === 0) {
      errors.push('push');
      logger.error('[DirectorySync] HubSpot push failed — all members errored', { extra: { errorCount: pushResult.errors, sample: pushResult.errorDetails.slice(0, 5) } });
    } else if (pushResult.errors > 0) {
      logger.warn(`[DirectorySync] HubSpot push partial: ${pushResult.synced} synced, ${pushResult.errors} errors`, { extra: { sample: pushResult.errorDetails.slice(0, 5) } });
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
    } else if (result.status === 429) {
      stripeSkipped = true;
      stripeUpdated = 0;
      logger.info('[DirectorySync] Stripe sync skipped (rate limited or cooldown)', { extra: { response: result.data } });
    } else {
      errors.push('stripe');
      logger.error('[DirectorySync] Stripe sync failed', { extra: { response: result.data } });
    }
  } catch (err: unknown) {
    errors.push('stripe');
    logger.error('[DirectorySync] Stripe sync failed', { error: err instanceof Error ? err : new Error(String(err)) });
  }

  const syncResult = { pullCount, pushCount, pushErrors, stripeUpdated, stripeSkipped, errors };
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
