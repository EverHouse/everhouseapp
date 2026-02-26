import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { schedulerTracker } from '../core/schedulerTracker';
import { getWebhookEvents, getWebhookEventTypes } from '../core/webhookMonitor';
import { getJobQueueMonitorData } from '../core/jobQueueMonitor';
import { getHubSpotQueueMonitorData } from '../core/hubspotQueueMonitor';
import { getAlertHistory } from '../core/alertHistoryMonitor';
import { safeErrorDetail } from '../utils/errorUtils';
import { getAuditLogs } from '../core/auditLog';
import { isPushNotificationsEnabled } from './push';
import { getSettingBoolean } from '../core/settingsHelper';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { pushSubscriptions } from '../../shared/schema';

const router = Router();

router.get('/api/admin/monitoring/schedulers', isStaffOrAdmin, async (_req, res) => {
  try {
    await schedulerTracker.refreshEnabledStates();
    const statuses = schedulerTracker.getSchedulerStatuses();
    res.json({ schedulers: statuses });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get scheduler statuses', details: safeErrorDetail(error) });
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
    res.status(500).json({ error: 'Failed to get webhook events', details: safeErrorDetail(error) });
  }
});

router.get('/api/admin/monitoring/webhook-types', isStaffOrAdmin, async (_req, res) => {
  try {
    const types = await getWebhookEventTypes();
    res.json({ types });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get webhook event types', details: safeErrorDetail(error) });
  }
});

router.get('/api/admin/monitoring/jobs', isStaffOrAdmin, async (_req, res) => {
  try {
    const data = await getJobQueueMonitorData();
    res.json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get job queue data', details: safeErrorDetail(error) });
  }
});

router.get('/api/admin/monitoring/hubspot-queue', isStaffOrAdmin, async (_req, res) => {
  try {
    const data = await getHubSpotQueueMonitorData();
    res.json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get HubSpot queue data', details: safeErrorDetail(error) });
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
    res.status(500).json({ error: 'Failed to get alert history', details: safeErrorDetail(error) });
  }
});

router.get('/api/admin/monitoring/audit-logs', isStaffOrAdmin, async (req, res) => {
  try {
    const staffEmail = req.query.staffEmail as string | undefined;
    const action = req.query.action as string | undefined;
    const resourceType = req.query.resourceType as string | undefined;
    const resourceId = req.query.resourceId as string | undefined;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const data = await getAuditLogs({ staffEmail, action, resourceType, resourceId, startDate, endDate, limit, offset });
    res.json(data);
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get audit logs', details: safeErrorDetail(error) });
  }
});

router.get('/api/admin/monitoring/email-health', isStaffOrAdmin, async (_req, res) => {
  try {
    const statsResult = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'email.sent') AS total_sent,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered') AS total_delivered,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced') AS total_bounced,
        COUNT(*) FILTER (WHERE event_type = 'email.complained') AS total_complained,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed') AS total_delivery_delayed,
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND created_at >= NOW() - INTERVAL '24 hours') AS sent_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered' AND created_at >= NOW() - INTERVAL '24 hours') AS delivered_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '24 hours') AS bounced_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.complained' AND created_at >= NOW() - INTERVAL '24 hours') AS complained_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed' AND created_at >= NOW() - INTERVAL '24 hours') AS delivery_delayed_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND created_at >= NOW() - INTERVAL '7 days') AS sent_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered' AND created_at >= NOW() - INTERVAL '7 days') AS delivered_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '7 days') AS bounced_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.complained' AND created_at >= NOW() - INTERVAL '7 days') AS complained_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed' AND created_at >= NOW() - INTERVAL '7 days') AS delivery_delayed_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND created_at >= NOW() - INTERVAL '30 days') AS sent_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered' AND created_at >= NOW() - INTERVAL '30 days') AS delivered_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '30 days') AS bounced_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.complained' AND created_at >= NOW() - INTERVAL '30 days') AS complained_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed' AND created_at >= NOW() - INTERVAL '30 days') AS delivery_delayed_30d
      FROM email_events
    `);

    const recentResult = await db.execute(sql`
      SELECT event_id, event_type, email_id, recipient_email, subject, created_at
      FROM email_events
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const raw = statsResult.rows[0] as Record<string, string> || {};
    const stats = [
      {
        period: '24h',
        sent: Number(raw.sent_24h) || 0,
        delivered: Number(raw.delivered_24h) || 0,
        bounced: Number(raw.bounced_24h) || 0,
        complained: Number(raw.complained_24h) || 0,
        delayed: Number(raw.delivery_delayed_24h) || 0,
      },
      {
        period: '7d',
        sent: Number(raw.sent_7d) || 0,
        delivered: Number(raw.delivered_7d) || 0,
        bounced: Number(raw.bounced_7d) || 0,
        complained: Number(raw.complained_7d) || 0,
        delayed: Number(raw.delivery_delayed_7d) || 0,
      },
      {
        period: '30d',
        sent: Number(raw.sent_30d) || 0,
        delivered: Number(raw.delivered_30d) || 0,
        bounced: Number(raw.bounced_30d) || 0,
        complained: Number(raw.complained_30d) || 0,
        delayed: Number(raw.delivery_delayed_30d) || 0,
      },
    ];

    const recentEvents = (recentResult.rows as Array<Record<string, unknown>>).map(row => ({
      id: Number(row.id),
      eventType: String(row.event_type || ''),
      recipientEmail: row.recipient_email ? String(row.recipient_email) : null,
      subject: row.subject ? String(row.subject) : null,
      createdAt: String(row.created_at || ''),
    }));

    res.json({ stats, recentEvents });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get email health stats', details: safeErrorDetail(error) });
  }
});

router.get('/api/admin/monitoring/push-status', isStaffOrAdmin, async (_req, res) => {
  try {
    const vapidConfigured = isPushNotificationsEnabled();
    const pushEnabled = await getSettingBoolean('push.enabled', true);

    const countResult = await db.select({ count: sql<number>`count(*)` }).from(pushSubscriptions);
    const subscriptionCount = countResult[0]?.count ?? 0;

    res.json({
      vapidConfigured,
      pushEnabled,
      subscriptionCount,
    });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get push notification status', details: safeErrorDetail(error) });
  }
});

router.get('/api/admin/monitoring/auto-approve-config', isStaffOrAdmin, async (_req, res) => {
  try {
    const conferenceRooms = await getSettingBoolean('booking.auto_approve.conference_rooms', true);
    const trackmanImports = await getSettingBoolean('booking.auto_approve.trackman_imports', true);

    res.json({
      conferenceRooms,
      trackmanImports,
    });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get auto-approve config', details: safeErrorDetail(error) });
  }
});

export default router;
