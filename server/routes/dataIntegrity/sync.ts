import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { syncPush, syncPull, runDataCleanup } from '../../core/dataIntegrity';
import { syncAllCustomerMetadata } from '../../core/stripe/customers';
import { getSystemHealth } from '../../core/healthCheck';
import { logger, isAdmin, validateBody, broadcastDataIntegrityUpdate, logFromRequest, sendFixError, getErrorMessage } from './shared';
import type { Request } from 'express';
import { syncPushPullSchema } from '../../../shared/validators/dataIntegrity';

const execFileAsync = promisify(execFile);

const router = Router();

router.post('/api/data-integrity/sync-push', isAdmin, validateBody(syncPushPullSchema), async (req: Request, res) => {
  try {
    const { issue_key, target, user_id, hubspot_contact_id, stripe_customer_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'userId is required for sync push operations' });
    }
    
    const result = await syncPush({
      issueKey: issue_key,
      target,
      userId: user_id,
      hubspotContactId: hubspot_contact_id,
      stripeCustomerId: stripe_customer_id
    });
    
    broadcastDataIntegrityUpdate('data_changed', { source: `sync_push_${target}` });
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Sync push error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error, 'Failed to push sync');
  }
});

router.post('/api/data-integrity/sync-pull', isAdmin, validateBody(syncPushPullSchema), async (req: Request, res) => {
  try {
    const { issue_key, target, user_id, hubspot_contact_id, stripe_customer_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'userId is required for sync pull operations' });
    }
    
    const result = await syncPull({
      issueKey: issue_key,
      target,
      userId: user_id,
      hubspotContactId: hubspot_contact_id,
      stripeCustomerId: stripe_customer_id
    });
    
    broadcastDataIntegrityUpdate('data_changed', { source: `sync_pull_${target}` });
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Sync pull error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error, 'Failed to pull sync');
  }
});

router.post('/api/data-integrity/sync-stripe-metadata', isAdmin, async (req, res) => {
  try {
    logger.info('[DataIntegrity] Starting Stripe customer metadata sync...');
    const result = await syncAllCustomerMetadata();
    
    res.json({ 
      success: true, 
      message: `Synced ${result.synced} customers to Stripe. ${result.failed} failed.`,
      synced: result.synced,
      failed: result.failed
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Stripe metadata sync error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error, 'Failed to sync Stripe metadata');
  }
});

router.post('/api/data-integrity/cleanup', isAdmin, async (req, res) => {
  try {
    logger.info('[DataIntegrity] Starting data cleanup...');
    const result = await runDataCleanup();
    
    res.json({ 
      success: true, 
      message: `Cleanup complete: Removed ${result.orphanedNotifications} orphaned notifications, marked ${result.orphanedBookings} orphaned bookings, removed ${result.expiredHolds} expired guest pass holds.`,
      ...result
    });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Data cleanup error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error, 'Failed to run data cleanup');
  }
});

router.get('/api/data-integrity/health', isAdmin, async (req, res) => {
  try {
    const health = await getSystemHealth();
    
    logFromRequest(
      req,
      'health_check_viewed',
      'system',
      undefined,
      'System Health Check',
      { overall: health.overall }
    );
    
    res.json({ success: true, health });
  } catch (error: unknown) {
    logger.error('[DataIntegrity] Health check error', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error, 'Failed to check system health');
  }
});

router.post('/api/data-integrity/resync-from-production', isAdmin, async (req, res) => {
  try {
    const isDev = process.env.NODE_ENV !== 'production';
    if (!isDev) {
      return res.status(403).json({ success: false, error: 'This operation is only available in development' });
    }

    const poolerUrl = process.env.DATABASE_POOLER_URL;
    const localUrl = process.env.DATABASE_URL;
    if (!poolerUrl || !localUrl) {
      return res.status(400).json({ success: false, error: 'Missing DATABASE_POOLER_URL or DATABASE_URL' });
    }

    const isLocal = (() => {
      try { return ['localhost', '127.0.0.1', 'helium'].includes(new URL(localUrl).hostname); }
      catch { return false; }
    })();
    if (!isLocal) {
      return res.status(400).json({ success: false, error: 'DATABASE_URL does not point to a local database — refusing to overwrite' });
    }

    logger.info('[DevSync] Starting production → local database resync...');

    const dumpDir = '/tmp/db_sync/data';
    mkdirSync(dumpDir, { recursive: true });

    if (existsSync(dumpDir)) {
      for (const f of readdirSync(dumpDir)) {
        if (f.endsWith('.csv')) unlinkSync(`${dumpDir}/${f}`);
      }
    }

    const { stdout: tableList } = await execFileAsync('psql', [
      poolerUrl, '-t', '-A', '-c',
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
    ], { timeout: 30000 });

    const tables = tableList.trim().split('\n').filter(Boolean);
    logger.info(`[DevSync] Found ${tables.length} tables to export`);

    let exported = 0;
    for (const table of tables) {
      const { stdout: countStr } = await execFileAsync('psql', [
        poolerUrl, '-t', '-A', '-c', `SELECT count(*) FROM "${table}";`
      ], { timeout: 30000 });
      const count = parseInt(countStr.trim(), 10);
      if (count === 0) continue;

      await execFileAsync('psql', [
        poolerUrl, '-c', `\\COPY "${table}" TO '${dumpDir}/${table}.csv' WITH (FORMAT csv, HEADER true)`
      ], { timeout: 60000 });
      exported++;
    }

    logger.info(`[DevSync] Exported ${exported} tables from production`);

    let imported = 0;
    const failed: string[] = [];
    const csvFiles = readdirSync(dumpDir).filter(f => f.endsWith('.csv'));

    const truncateSql = csvFiles.map(f => `TRUNCATE "${f.replace('.csv', '')}" CASCADE;`).join(' ');
    await execFileAsync('psql', [
      localUrl, '-c', `SET session_replication_role = 'replica'; ${truncateSql}`
    ], { timeout: 30000 });

    for (const csvFile of csvFiles) {
      const table = csvFile.replace('.csv', '');
      try {
        await execFileAsync('psql', [
          localUrl, '-c', `SET session_replication_role = 'replica'; \\COPY "${table}" FROM '${dumpDir}/${csvFile}' WITH (FORMAT csv, HEADER true)`
        ], { timeout: 60000, shell: true });
        imported++;
      } catch (err) {
        const importSql = `SET session_replication_role = 'replica';\n\\COPY "${table}" FROM '${dumpDir}/${csvFile}' WITH (FORMAT csv, HEADER true)`;
        try {
          await execFileAsync('psql', [localUrl], {
            timeout: 60000,
            input: importSql
          } as Parameters<typeof execFileAsync>[2] & { input: string });
          imported++;
        } catch (importErr: unknown) {
          failed.push(table);
          logger.warn(`[DevSync] Failed to import ${table}: ${getErrorMessage(importErr)}`);
        }
      }
    }

    const { stdout: seqQueries } = await execFileAsync('psql', [
      localUrl, '-t', '-A', '-c',
      `SELECT 'SELECT setval(pg_get_serial_sequence(''' || quote_ident(tablename) || ''', ''' || attname || '''), COALESCE((SELECT MAX(' || quote_ident(attname) || ') FROM ' || quote_ident(tablename) || '), 1));'
       FROM pg_tables t
       JOIN pg_attribute a ON a.attrelid = (t.schemaname || '.' || t.tablename)::regclass
       JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE t.schemaname = 'public' AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%';`
    ], { timeout: 30000 });

    for (const seqSql of seqQueries.trim().split('\n').filter(Boolean)) {
      try {
        await execFileAsync('psql', [localUrl, '-c', seqSql], { timeout: 10000 });
      } catch { /* sequence reset is best-effort */ }
    }

    const { stdout: userCount } = await execFileAsync('psql', [localUrl, '-t', '-A', '-c', 'SELECT count(*) FROM users;'], { timeout: 10000 });
    const { stdout: bookingCount } = await execFileAsync('psql', [localUrl, '-t', '-A', '-c', 'SELECT count(*) FROM booking_requests;'], { timeout: 10000 });

    const summary = `Synced ${imported} tables (${failed.length} failed). Local DB now has ${userCount.trim()} users, ${bookingCount.trim()} bookings.`;
    logger.info(`[DevSync] ${summary}`);

    logFromRequest(req, 'dev_resync_from_production', 'system', undefined, summary);

    res.json({
      success: true,
      message: summary,
      tables: imported,
      failed: failed.length > 0 ? failed : undefined,
      users: parseInt(userCount.trim(), 10),
      bookings: parseInt(bookingCount.trim(), 10),
    });
  } catch (error: unknown) {
    logger.error('[DevSync] Resync failed', { error: error instanceof Error ? error : new Error(String(error)) });
    sendFixError(res, error, 'Failed to resync from production');
  }
});

export default router;
