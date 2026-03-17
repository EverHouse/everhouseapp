import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { isStaffOrAdmin } from '../../core/middleware';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';

interface TotalCountRow {
  total: string;
}

interface LinkedEmailRow {
  primary_email: string;
  linked_email: string;
  source: string;
  created_by: string | null;
  created_at: string;
}

const router = Router();

const webhookPaginationSchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/admin/trackman-webhooks', isStaffOrAdmin, validateQuery(webhookPaginationSchema), async (req: Request, res: Response) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof webhookPaginationSchema> }).validatedQuery;
    const limit = Math.min(parseInt(vq.limit || '', 10) || 50, 100);
    const offset = parseInt(vq.offset || '', 10) || 0;
    
    const result = await db.execute(sql`SELECT 
        twe.id,
        twe.event_type,
        twe.trackman_booking_id,
        twe.matched_booking_id,
        twe.matched_user_id,
        twe.processing_error,
        twe.processed_at,
        twe.created_at,
        twe.retry_count,
        twe.last_retry_at,
        twe.payload,
        br.was_auto_linked,
        br.user_email as matched_user_email,
        br.request_date,
        br.start_time,
        br.end_time,
        br.resource_id,
        br.is_unmatched as linked_booking_unmatched,
        u.first_name || ' ' || u.last_name as linked_member_name,
        u.email as linked_member_email
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      LEFT JOIN users u ON br.user_id = u.id
      ORDER BY twe.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`);
    
    const countResult = await db.execute(sql`SELECT COUNT(*) as total FROM trackman_webhook_events`);
    
    const totalCount = parseInt((countResult.rows[0] as unknown as TotalCountRow).total, 10);
    res.json({
      events: result.rows,
      total: totalCount,
      totalCount,
      limit,
      offset
    });
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch webhook events', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch webhook events' });
  }
});

router.get('/api/admin/trackman-webhooks/stats', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stats = await db.execute(sql`SELECT 
        COUNT(*) as total_events,
        COUNT(*) FILTER (WHERE matched_booking_id IS NOT NULL) as matched,
        COUNT(*) FILTER (WHERE matched_booking_id IS NULL AND processing_error IS NULL) as unmatched,
        COUNT(*) FILTER (WHERE processing_error IS NOT NULL) as errors,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%created%' OR twe.event_type::text ILIKE '%create%') as created,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%cancelled%' OR twe.event_type::text ILIKE '%cancel%' OR twe.event_type::text ILIKE '%deleted%') as cancelled,
        COUNT(*) FILTER (WHERE (twe.event_type::text ILIKE '%modified%' OR twe.event_type::text ILIKE '%update%') AND twe.event_type::text NOT ILIKE '%user%' AND twe.event_type::text NOT ILIKE '%purchase%') as modified,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%user%') as user_updates,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%purchase%') as purchase_events,
        COUNT(*) FILTER (WHERE twe.event_type::text ILIKE '%block%') as blocks,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.was_auto_linked = true AND br.is_unmatched = false) as auto_confirmed,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND (br.was_auto_linked = false OR br.was_auto_linked IS NULL) AND br.is_unmatched = false) as manually_linked,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.is_unmatched = true) as needs_linking,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NULL AND processing_error IS NULL AND NOT (twe.event_type::text ILIKE '%cancelled%' OR twe.event_type::text ILIKE '%cancel%' OR twe.event_type::text ILIKE '%deleted%') AND twe.event_type::text NOT ILIKE '%user%' AND twe.event_type::text NOT ILIKE '%purchase%' AND twe.event_type::text NOT ILIKE '%block%') as needs_linking_unmatched,
        MAX(twe.created_at) as last_event_at
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      WHERE twe.created_at >= NOW() - INTERVAL '30 days'`);
    
    const row = stats.rows[0] as Record<string, string>;
    const autoConfirmed = parseInt(row?.auto_confirmed || '0', 10);
    const manuallyLinked = parseInt(row?.manually_linked || '0', 10);
    const needsLinking = parseInt(row?.needs_linking || '0', 10) + parseInt(row?.needs_linking_unmatched || '0', 10);
    
    const slotStats = await db.execute(sql`SELECT 
        COUNT(*) as total_slots,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE slot_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date) as upcoming
      FROM trackman_bay_slots`);
    
    res.json({
      webhookStats: {
        ...row,
        auto_confirmed: autoConfirmed,
        manually_linked: manuallyLinked,
        needs_linking: needsLinking,
      },
      slotStats: slotStats.rows[0],
    });
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch stats', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/api/admin/trackman-webhook/stats', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stats = await db.execute(sql`SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE matched_booking_id IS NOT NULL) as matched,
        COUNT(*) FILTER (WHERE matched_booking_id IS NULL AND processing_error IS NULL) as unmatched,
        COUNT(*) FILTER (WHERE processing_error IS NOT NULL) as errors,
        COUNT(*) FILTER (WHERE event_type = 'booking.created') as created,
        COUNT(*) FILTER (WHERE event_type = 'booking.cancelled') as cancelled,
        COUNT(*) FILTER (WHERE event_type = 'booking.modified') as modified,
        COUNT(*) FILTER (WHERE event_type::text ILIKE '%user%') as user_updates,
        COUNT(*) FILTER (WHERE event_type::text ILIKE '%purchase%') as purchase_events,
        COUNT(*) FILTER (WHERE twe.matched_booking_id IS NOT NULL AND br.is_unmatched = true) as matched_but_unlinked
      FROM trackman_webhook_events twe
      LEFT JOIN booking_requests br ON twe.matched_booking_id = br.id
      WHERE twe.created_at >= NOW() - INTERVAL '30 days'`);
    
    const slotStats = await db.execute(sql`SELECT 
        COUNT(*) as total_slots,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE slot_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date) as upcoming
      FROM trackman_bay_slots`);
    
    res.json({
      webhookStats: stats.rows[0],
      slotStats: slotStats.rows[0],
    });
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch stats', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.post('/api/admin/linked-emails', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { primaryEmail: rawPrimaryEmail, linkedEmail: rawLinkedEmail } = req.body;
    const primaryEmail = rawPrimaryEmail?.trim()?.toLowerCase();
    const linkedEmail = rawLinkedEmail?.trim()?.toLowerCase();
    
    if (!primaryEmail || !linkedEmail) {
      return res.status(400).json({ error: 'primaryEmail and linkedEmail are required' });
    }
    
    if (primaryEmail.toLowerCase() === linkedEmail.toLowerCase()) {
      return res.status(400).json({ error: 'Primary email and linked email cannot be the same' });
    }
    
    const existingLink = await db.execute(sql`SELECT id FROM user_linked_emails WHERE LOWER(linked_email) = LOWER(${linkedEmail})`);
    
    if (existingLink.rows.length > 0) {
      return res.status(409).json({ error: 'This email is already linked to a member' });
    }
    
    const createdBy = req.session?.user?.email || 'unknown';
    
    await db.execute(sql`INSERT INTO user_linked_emails (primary_email, linked_email, source, created_by)
       VALUES (${primaryEmail.toLowerCase()}, ${linkedEmail.toLowerCase()}, ${'trackman_resolution'}, ${createdBy})`);
    
    logger.info('[Linked Emails] Created email link', {
      extra: { primaryEmail, linkedEmail, createdBy }
    });
    
    res.json({ success: true, message: 'Email link created successfully' });
  } catch (error: unknown) {
    logger.error('[Linked Emails] Failed to create link', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create email link' });
  }
});

router.get('/api/admin/linked-emails/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail } = req.params;
    
    if (!rawEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const email = decodeURIComponent(rawEmail as string).trim().toLowerCase();
    
    const asLinked = await db.execute(sql`SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(linked_email) = LOWER(${email})`);
    
    const asPrimary = await db.execute(sql`SELECT primary_email, linked_email, source, created_by, created_at
       FROM user_linked_emails 
       WHERE LOWER(primary_email) = LOWER(${email})`);
    
    res.json({
      linkedTo: asLinked.rows.length > 0 ? (asLinked.rows[0] as unknown as LinkedEmailRow).primary_email : null,
      linkedEmails: (asPrimary.rows as unknown as LinkedEmailRow[]).map((r) => ({
        linkedEmail: r.linked_email,
        source: r.source,
        createdBy: r.created_by,
        createdAt: r.created_at
      }))
    });
  } catch (error: unknown) {
    logger.error('[Linked Emails] Failed to fetch links', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch email links' });
  }
});

router.get('/api/availability/trackman-cache', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { start_date, end_date, resource_id } = req.query;
    
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }
    
    const sqlConditions: ReturnType<typeof sql>[] = [
      sql`slot_date >= ${start_date}`,
      sql`slot_date <= ${end_date}`,
      sql`status = 'booked'`
    ];
    
    if (resource_id) {
      sqlConditions.push(sql`resource_id = ${resource_id}`);
    }
    
    const result = await db.execute(sql`SELECT 
        id,
        resource_id,
        TO_CHAR(slot_date, 'YYYY-MM-DD') as slot_date,
        start_time,
        end_time,
        status,
        trackman_booking_id,
        customer_name,
        player_count
       FROM trackman_bay_slots
       WHERE ${sql.join(sqlConditions, sql` AND `)}
       ORDER BY slot_date, start_time`);
    
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('[Trackman Webhook] Failed to fetch availability cache', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

export default router;
