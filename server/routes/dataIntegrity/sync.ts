import { Router } from 'express';
import { syncPush, syncPull, runDataCleanup } from '../../core/dataIntegrity';
import { syncAllCustomerMetadata } from '../../core/stripe/customers';
import { getSystemHealth } from '../../core/healthCheck';
import { logger, isAdmin, validateBody, broadcastDataIntegrityUpdate, logFromRequest, sendFixError } from './shared';
import type { Request } from 'express';
import { syncPushPullSchema } from '../../../shared/validators/dataIntegrity';

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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
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
    sendFixError(res, error);
  }
});

export default router;
