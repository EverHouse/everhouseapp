import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { schedulerTracker } from '../core/schedulerTracker';
import { getWebhookEvents, getWebhookEventTypes } from '../core/webhookMonitor';
import { getJobQueueMonitorData } from '../core/jobQueueMonitor';
import { getHubSpotQueueMonitorData } from '../core/hubspotQueueMonitor';
import { getAlertHistory } from '../core/alertHistoryMonitor';
import { getErrorMessage } from '../utils/errorUtils';

const router = Router();

router.get('/api/admin/monitoring/schedulers', isStaffOrAdmin, async (_req, res) => {
  try {
    const statuses = schedulerTracker.getSchedulerStatuses();
    res.json({ schedulers: statuses });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get scheduler statuses', details: getErrorMessage(error) });
  }
});

router.get('/api/admin/monitoring/webhooks', isStaffOrAdmin, async (req, res) => {
  try {
    const type = req.query.type as string | undefined;
    const status = req.query.status as 'processed' | 'failed' | 'pending' | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const data = await getWebhookEvents({ type, status, limit, offset });
    res.json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get webhook events', details: getErrorMessage(error) });
  }
});

router.get('/api/admin/monitoring/webhook-types', isStaffOrAdmin, async (_req, res) => {
  try {
    const types = await getWebhookEventTypes();
    res.json({ types });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get webhook event types', details: getErrorMessage(error) });
  }
});

router.get('/api/admin/monitoring/jobs', isStaffOrAdmin, async (_req, res) => {
  try {
    const data = await getJobQueueMonitorData();
    res.json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get job queue data', details: getErrorMessage(error) });
  }
});

router.get('/api/admin/monitoring/hubspot-queue', isStaffOrAdmin, async (_req, res) => {
  try {
    const data = await getHubSpotQueueMonitorData();
    res.json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get HubSpot queue data', details: getErrorMessage(error) });
  }
});

router.get('/api/admin/monitoring/alerts', isStaffOrAdmin, async (req, res) => {
  try {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;

    const alerts = await getAlertHistory({ startDate, endDate, limit });
    res.json({ alerts });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get alert history', details: getErrorMessage(error) });
  }
});

export default router;
