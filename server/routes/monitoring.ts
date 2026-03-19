import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { validateQuery } from '../middleware/validate';
import { z } from 'zod';
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

const webhookQuerySchema = z.object({
  type: z.string().optional(),
  status: z.enum(['processed', 'failed', 'pending']).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/admin/monitoring/webhooks', isStaffOrAdmin, validateQuery(webhookQuerySchema), async (req, res) => {
  try {
    const { type, status, limit: limitStr, offset: offsetStr } = (req as unknown as Request & { validatedQuery: z.infer<typeof webhookQuerySchema> }).validatedQuery;
    const limit = parseInt(limitStr || '', 10) || 50;
    const offset = parseInt(offsetStr || '', 10) || 0;

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

const alertsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/admin/monitoring/alerts', isStaffOrAdmin, validateQuery(alertsQuerySchema), async (req, res) => {
  try {
    const { startDate, endDate, limit: limitStr } = (req as unknown as Request & { validatedQuery: z.infer<typeof alertsQuerySchema> }).validatedQuery;
    const limit = parseInt(limitStr || '', 10) || 100;

    const alerts = await getAlertHistory({ startDate, endDate, limit });
    res.json({ alerts });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get alert history', details: safeErrorDetail(error) });
  }
});

const auditLogsQuerySchema = z.object({
  staffEmail: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/admin/monitoring/audit-logs', isStaffOrAdmin, validateQuery(auditLogsQuerySchema), async (req, res) => {
  try {
    const vq = (req as unknown as Request & { validatedQuery: z.infer<typeof auditLogsQuerySchema> }).validatedQuery;
    const staffEmail = vq.staffEmail;
    const action = vq.action;
    const resourceType = vq.resourceType;
    const resourceId = vq.resourceId;
    const startDate = vq.startDate ? new Date(vq.startDate) : undefined;
    const endDate = vq.endDate ? new Date(vq.endDate) : undefined;
    const limit = Math.min(Math.max(parseInt(vq.limit || '', 10) || 50, 1), 100);
    const offset = Math.max(parseInt(vq.offset || '', 10) || 0, 0);

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
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND event_id LIKE 'local-%') AS total_sent,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered') AS total_delivered,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced') AS total_bounced,
        COUNT(*) FILTER (WHERE event_type = 'email.complained') AS total_complained,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed') AS total_delivery_delayed,
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND event_id LIKE 'local-%' AND created_at >= NOW() - INTERVAL '24 hours') AS sent_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered' AND created_at >= NOW() - INTERVAL '24 hours') AS delivered_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '24 hours') AS bounced_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.complained' AND created_at >= NOW() - INTERVAL '24 hours') AS complained_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed' AND created_at >= NOW() - INTERVAL '24 hours') AS delivery_delayed_24h,
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND event_id LIKE 'local-%' AND created_at >= NOW() - INTERVAL '7 days') AS sent_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered' AND created_at >= NOW() - INTERVAL '7 days') AS delivered_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '7 days') AS bounced_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.complained' AND created_at >= NOW() - INTERVAL '7 days') AS complained_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed' AND created_at >= NOW() - INTERVAL '7 days') AS delivery_delayed_7d,
        COUNT(*) FILTER (WHERE event_type = 'email.sent' AND event_id LIKE 'local-%' AND created_at >= NOW() - INTERVAL '30 days') AS sent_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivered' AND created_at >= NOW() - INTERVAL '30 days') AS delivered_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.bounced' AND created_at >= NOW() - INTERVAL '30 days') AS bounced_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.complained' AND created_at >= NOW() - INTERVAL '30 days') AS complained_30d,
        COUNT(*) FILTER (WHERE event_type = 'email.delivery_delayed' AND created_at >= NOW() - INTERVAL '30 days') AS delivery_delayed_30d
      FROM email_events
    `);

    const recentResult = await db.execute(sql`
      SELECT id, event_id, event_type, email_id, recipient_email, subject, created_at
      FROM email_events
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const lastEventResult = await db.execute(sql`
      SELECT MAX(created_at) AS last_event_at FROM email_events
    `);

    const lastWebhookResult = await db.execute(sql`
      SELECT MAX(created_at) AS last_webhook_at FROM email_events
      WHERE event_id NOT LIKE 'local-%'
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
      createdAt: (row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at ? new Date(String(row.created_at) + 'Z').toISOString() : '')),
    }));

    const lastEventRow = lastEventResult.rows[0] as Record<string, unknown> | undefined;
    const lastWebhookRow = lastWebhookResult.rows[0] as Record<string, unknown> | undefined;

    const formatTs = (val: unknown): string | null => {
      if (!val) return null;
      if (val instanceof Date) return val.toISOString();
      return new Date(String(val) + 'Z').toISOString();
    };

    const lastEventAt = formatTs(lastEventRow?.last_event_at);
    const lastWebhookAt = formatTs(lastWebhookRow?.last_webhook_at);

    const isProduction = process.env.NODE_ENV === 'production';
    const webhookUrl = isProduction
      ? 'https://everclub.app/api/webhooks/resend'
      : process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/webhooks/resend`
        : '/api/webhooks/resend';

    res.json({ stats, recentEvents, lastEventAt, lastWebhookAt, webhookUrl });
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

router.get('/api/admin/monitoring/external-systems', isStaffOrAdmin, async (_req, res) => {
  try {
    const { getExternalSystemsHealth } = await import('../core/healthCheck');
    const health = await getExternalSystemsHealth();
    res.json(health);
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get external systems health', details: safeErrorDetail(error) });
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
