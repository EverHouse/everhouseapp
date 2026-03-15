import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../core/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { getStripeClient } from '../core/stripe/client';
import type Stripe from 'stripe';

const router = Router();

interface RevenueMonth {
  subscription_cents: number;
  booking_cents: number;
  overage_cents: number;
  pos_sale_cents: number;
  account_balance_cents: number;
  guest_fee_cents: number;
  other_cents: number;
  total_cents: number;
}

let revenueCache: { data: Record<string, RevenueMonth>; fetchedAt: number } | null = null;
const REVENUE_CACHE_TTL_MS = 5 * 60 * 1000;

function categorizeCharge(charge: Stripe.Charge): string {
  const pi = charge.payment_intent && typeof charge.payment_intent === 'object' ? charge.payment_intent as Stripe.PaymentIntent : null;
  const meta = pi?.metadata || charge.metadata || {};
  const desc = (pi?.description || charge.description || '').toLowerCase();
  const hasInvoice = !!(charge.invoice);

  if (meta.purpose === 'overage_fee' || desc.includes('overage')) return 'overage';
  if (meta.purpose === 'guest_fee' || desc.includes('guest fee') || desc.includes('guest pass')) return 'guest_fee';
  if (meta.purpose === 'booking_fee' || meta.purpose === 'prepayment' || meta.paymentType === 'booking_fee') return 'booking';
  if (meta.purpose === 'one_time_purchase' || meta.source === 'pos') return 'pos_sale';
  if (meta.purpose === 'add_funds' || desc.includes('top-up') || desc.includes('account balance')) return 'account_balance';
  if (meta.paymentType === 'subscription_terminal' || meta.source === 'membership_inline_payment') return 'subscription';
  if (desc.includes('subscription creation') || desc.includes('subscription update')) return 'subscription';
  if (hasInvoice && desc.includes('subscription')) return 'subscription';
  if (desc.includes('booking') || desc.includes('simulator') || desc.includes('bay')) return 'booking';
  return 'other';
}

async function fetchRevenueFromStripe(): Promise<Record<string, RevenueMonth>> {
  const now = Date.now();
  if (revenueCache && (now - revenueCache.fetchedAt) < REVENUE_CACHE_TTL_MS) {
    return revenueCache.data;
  }

  const stripe = await getStripeClient();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);
  const startTimestamp = Math.floor(sixMonthsAgo.getTime() / 1000);

  const knownCustomersResult = await db.execute(sql`
    SELECT stripe_customer_id FROM users WHERE stripe_customer_id IS NOT NULL
  `);
  const knownCustomerIds = new Set(
    (knownCustomersResult.rows as { stripe_customer_id: string }[]).map(r => r.stripe_customer_id)
  );

  const months: Record<string, RevenueMonth> = {};
  const currentDate = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months[key] = { subscription_cents: 0, booking_cents: 0, overage_cents: 0, pos_sale_cents: 0, account_balance_cents: 0, guest_fee_cents: 0, other_cents: 0, total_cents: 0 };
  }

  let hasMore = true;
  let startingAfter: string | undefined;
  let skippedOrphans = 0;

  while (hasMore) {
    const params: Stripe.ChargeListParams = {
      limit: 100,
      created: { gte: startTimestamp },
      expand: ['data.payment_intent'],
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.charges.list(params);

    for (const charge of page.data) {
      if (!charge.paid || charge.refunded) continue;

      const netAmount = charge.amount - (charge.amount_refunded || 0);
      if (netAmount <= 0) continue;

      const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
      if (customerId && !knownCustomerIds.has(customerId)) {
        skippedOrphans++;
        continue;
      }

      const created = new Date(charge.created * 1000);
      const monthKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`;
      if (!months[monthKey]) continue;

      const category = categorizeCharge(charge);
      const catKey = `${category}_cents` as keyof RevenueMonth;
      if (catKey in months[monthKey]) {
        months[monthKey][catKey] += netAmount;
      }
      months[monthKey].total_cents += netAmount;
    }

    hasMore = page.has_more;
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  revenueCache = { data: months, fetchedAt: now };
  logger.info('[Analytics] Fetched revenue data from Stripe', { extra: { monthCount: Object.keys(months).length, skippedOrphans } });
  return months;
}

const STAFF_EMAILS_SUBQUERY = sql`(SELECT email FROM users WHERE role IN ('staff', 'admin'))`;

router.get('/api/analytics/booking-stats', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const peakHoursResult = await db.execute(sql`
      SELECT
        EXTRACT(DOW FROM request_date::date) AS day_of_week,
        EXTRACT(HOUR FROM start_time::time) AS hour_of_day,
        COUNT(*)::int AS booking_count
      FROM booking_requests
      WHERE status NOT IN ('cancelled', 'declined', 'deleted')
        AND request_date IS NOT NULL
        AND start_time IS NOT NULL
        AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
      GROUP BY day_of_week, hour_of_day
      ORDER BY day_of_week, hour_of_day
    `);

    const resourceUtilResult = await db.execute(sql`
      SELECT
        r.name AS resource_name,
        COALESCE(SUM(br.duration_minutes), 0)::int AS total_minutes
      FROM resources r
      LEFT JOIN booking_requests br ON br.resource_id = r.id
        AND br.status NOT IN ('cancelled', 'declined', 'deleted')
        AND br.user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
      GROUP BY r.id, r.name
      ORDER BY total_minutes DESC
    `);

    const topMembersResult = await db.execute(sql`
      SELECT
        COALESCE(br.user_name, br.user_email) AS member_name,
        br.user_email AS member_email,
        SUM(br.duration_minutes)::int AS total_minutes
      FROM booking_requests br
      WHERE br.status NOT IN ('cancelled', 'declined', 'deleted')
        AND br.user_email IS NOT NULL
        AND br.user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
      GROUP BY br.user_name, br.user_email
      ORDER BY total_minutes DESC
      LIMIT 5
    `);

    const cancellationResult = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
      FROM booking_requests
      WHERE status != 'declined'
        AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
    `);

    const avgSessionResult = await db.execute(sql`
      SELECT
        ROUND(AVG(duration_minutes), 1) AS avg_minutes
      FROM booking_requests
      WHERE status NOT IN ('cancelled', 'declined', 'deleted')
        AND duration_minutes IS NOT NULL
        AND duration_minutes > 0
        AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
    `);

    const cancRow = cancellationResult.rows[0] as { total: number; cancelled: number };
    const cancellationRate = cancRow.total > 0
      ? Math.round((cancRow.cancelled / cancRow.total) * 1000) / 10
      : 0;

    const avgRow = avgSessionResult.rows[0] as { avg_minutes: string | null };
    const avgSessionMinutes = avgRow.avg_minutes ? parseFloat(avgRow.avg_minutes) : 0;

    res.json({
      peakHours: peakHoursResult.rows as { day_of_week: number; hour_of_day: number; booking_count: number }[],
      resourceUtilization: (resourceUtilResult.rows as { resource_name: string; total_minutes: number }[]).map(r => ({
        resourceName: r.resource_name,
        totalHours: Math.round((r.total_minutes / 60) * 10) / 10,
      })),
      topMembers: (topMembersResult.rows as { member_name: string; member_email: string; total_minutes: number }[]).map(m => ({
        memberName: m.member_name,
        memberEmail: m.member_email,
        totalHours: Math.round((m.total_minutes / 60) * 10) / 10,
      })),
      cancellationRate,
      totalBookings: cancRow.total,
      cancelledBookings: cancRow.cancelled,
      avgSessionMinutes,
    });
  } catch (error) {
    logger.error('Failed to fetch booking analytics', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to fetch booking analytics' });
  }
});

router.get('/api/analytics/extended-stats', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const [
      activeMembersResult,
      bookingFrequencyResult,
      revenueOverTimeResult,
      bookingsOverTimeResult,
      dayOfWeekResult,
      utilizationResult,
    ] = await Promise.all([
      db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE role = 'member' AND membership_status IN ('active', 'trialing', 'past_due') AND archived_at IS NULL) AS total_active_members,
          COUNT(DISTINCT br.user_email) FILTER (WHERE br.request_date >= CURRENT_DATE - INTERVAL '30 days')::int AS active_30,
          COUNT(DISTINCT br.user_email) FILTER (WHERE br.request_date >= CURRENT_DATE - INTERVAL '60 days')::int AS active_60,
          COUNT(DISTINCT br.user_email) FILTER (WHERE br.request_date >= CURRENT_DATE - INTERVAL '90 days')::int AS active_90
        FROM booking_requests br
        INNER JOIN users u ON u.email = br.user_email
          AND u.role = 'member'
          AND u.membership_status IN ('active', 'trialing', 'past_due')
          AND u.archived_at IS NULL
        WHERE br.status NOT IN ('cancelled', 'declined', 'deleted')
      `),

      db.execute(sql`
        WITH member_counts AS (
          SELECT user_email, COUNT(*)::int AS booking_count
          FROM booking_requests
          WHERE status NOT IN ('cancelled', 'declined', 'deleted')
            AND request_date >= CURRENT_DATE - INTERVAL '90 days'
            AND user_email IS NOT NULL
            AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
          GROUP BY user_email
        )
        SELECT
          CASE
            WHEN booking_count BETWEEN 1 AND 2 THEN '1-2'
            WHEN booking_count BETWEEN 3 AND 5 THEN '3-5'
            WHEN booking_count BETWEEN 6 AND 10 THEN '6-10'
            WHEN booking_count BETWEEN 11 AND 20 THEN '11-20'
            ELSE '20+'
          END AS bucket,
          COUNT(*)::int AS member_count
        FROM member_counts
        GROUP BY bucket
        ORDER BY MIN(booking_count)
      `),

      fetchRevenueFromStripe().then(months => {
        const sortedMonths = Object.keys(months).sort();
        return { rows: sortedMonths.map(month => ({ month, ...months[month] })) };
      }),

      db.execute(sql`
        SELECT
          TO_CHAR(DATE_TRUNC('week', request_date::date), 'YYYY-MM-DD') AS week_start,
          COUNT(*)::int AS booking_count
        FROM booking_requests
        WHERE status NOT IN ('cancelled', 'declined', 'deleted')
          AND request_date >= CURRENT_DATE - INTERVAL '6 months'
          AND request_date IS NOT NULL
          AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
        GROUP BY DATE_TRUNC('week', request_date::date)
        ORDER BY week_start
      `),

      db.execute(sql`
        SELECT
          EXTRACT(DOW FROM request_date::date)::int AS day_of_week,
          COUNT(*)::int AS booking_count
        FROM booking_requests
        WHERE status NOT IN ('cancelled', 'declined', 'deleted')
          AND request_date IS NOT NULL
          AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
        GROUP BY day_of_week
        ORDER BY day_of_week
      `),

      db.execute(sql`
        WITH booking_hours AS (
          SELECT
            generate_series(
              EXTRACT(HOUR FROM start_time::time)::int,
              GREATEST(EXTRACT(HOUR FROM start_time::time)::int, EXTRACT(HOUR FROM end_time::time)::int - 1)
            ) AS hour_slot
          FROM booking_requests
          WHERE status NOT IN ('cancelled', 'declined', 'deleted')
            AND start_time IS NOT NULL
            AND end_time IS NOT NULL
            AND resource_id IN (SELECT id FROM resources WHERE type = 'simulator')
            AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
        ),
        hourly_bookings AS (
          SELECT hour_slot::int, COUNT(*)::int AS booked_count
          FROM booking_hours
          GROUP BY hour_slot
        ),
        total_days AS (
          SELECT COUNT(DISTINCT request_date)::int AS num_days
          FROM booking_requests
          WHERE status NOT IN ('cancelled', 'declined', 'deleted')
            AND request_date IS NOT NULL
            AND user_email NOT IN ${STAFF_EMAILS_SUBQUERY}
        ),
        sim_count AS (
          SELECT COUNT(*)::int AS num_sims FROM resources WHERE type = 'simulator'
        )
        SELECT
          hb.hour_slot,
          hb.booked_count,
          td.num_days,
          sc.num_sims,
          CASE WHEN td.num_days * sc.num_sims > 0
            THEN ROUND((hb.booked_count::numeric / (td.num_days * sc.num_sims)) * 100, 1)
            ELSE 0
          END AS utilization_pct
        FROM hourly_bookings hb
        CROSS JOIN total_days td
        CROSS JOIN sim_count sc
        ORDER BY hb.hour_slot
      `),
    ]);

    const activeRow = activeMembersResult.rows[0] as {
      total_active_members: number; active_30: number; active_60: number; active_90: number;
    };

    res.json({
      activeMembers: {
        totalActiveMembers: activeRow.total_active_members,
        active30: activeRow.active_30,
        active60: activeRow.active_60,
        active90: activeRow.active_90,
      },
      bookingFrequency: (bookingFrequencyResult.rows as { bucket: string; member_count: number }[]).map(r => ({
        bucket: r.bucket,
        memberCount: r.member_count,
      })),
      revenueOverTime: (revenueOverTimeResult.rows as (RevenueMonth & { month: string })[]).map(r => ({
        month: r.month,
        subscriptionRevenue: Math.round(r.subscription_cents) / 100,
        bookingRevenue: Math.round(r.booking_cents) / 100,
        overageRevenue: Math.round(r.overage_cents) / 100,
        posSaleRevenue: Math.round(r.pos_sale_cents) / 100,
        accountBalanceRevenue: Math.round(r.account_balance_cents) / 100,
        guestFeeRevenue: Math.round(r.guest_fee_cents) / 100,
        otherRevenue: Math.round(r.other_cents) / 100,
        totalRevenue: Math.round(r.total_cents) / 100,
      })),
      bookingsOverTime: (bookingsOverTimeResult.rows as { week_start: string; booking_count: number }[]).map(r => ({
        weekStart: r.week_start,
        bookingCount: r.booking_count,
      })),
      dayOfWeekBreakdown: (dayOfWeekResult.rows as { day_of_week: number; booking_count: number }[]).map(r => ({
        dayOfWeek: r.day_of_week,
        bookingCount: r.booking_count,
      })),
      utilizationByHour: (utilizationResult.rows as { hour_slot: number; booked_count: number; utilization_pct: number }[]).map(r => ({
        hourSlot: r.hour_slot,
        bookedCount: r.booked_count,
        utilizationPct: parseFloat(String(r.utilization_pct)),
      })),
    });
  } catch (error) {
    logger.error('Failed to fetch extended analytics', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to fetch extended analytics' });
  }
});

router.get('/api/analytics/membership-insights', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const [tierResult, atRiskResult, growthResult] = await Promise.all([
      db.execute(sql`
        SELECT
          COALESCE(mt.name, 'Unknown') AS tier,
          COUNT(*)::int AS member_count
        FROM users u
        LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
        WHERE u.role = 'member'
          AND u.membership_status IN ('active', 'trialing', 'past_due')
          AND u.archived_at IS NULL
        GROUP BY mt.name
        ORDER BY member_count DESC
      `),

      db.execute(sql`
        SELECT
          u.id,
          COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.email) AS name,
          u.email,
          COALESCE(mt.name, 'Unknown') AS tier,
          MAX(br.request_date) AS last_booking_date
        FROM users u
        LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
        LEFT JOIN booking_requests br ON br.user_email = u.email
          AND br.status NOT IN ('cancelled', 'declined', 'deleted')
        WHERE u.role = 'member'
          AND u.membership_status IN ('active', 'trialing', 'past_due')
          AND u.archived_at IS NULL
        GROUP BY u.id, u.first_name, u.last_name, u.email, mt.name
        HAVING MAX(br.request_date) IS NULL
           OR MAX(br.request_date) < CURRENT_DATE - INTERVAL '45 days'
        ORDER BY MAX(br.request_date) ASC NULLS FIRST
        LIMIT 15
      `),

      db.execute(sql`
        WITH months AS (
          SELECT TO_CHAR(d, 'YYYY-MM') AS month
          FROM generate_series(
            DATE_TRUNC('month', CURRENT_DATE - INTERVAL '5 months'),
            DATE_TRUNC('month', CURRENT_DATE),
            '1 month'::interval
          ) d
        ),
        signups AS (
          SELECT
            TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
            COUNT(*)::int AS new_members
          FROM users
          WHERE role = 'member'
            AND archived_at IS NULL
            AND membership_status IN ('active', 'trialing', 'past_due')
            AND created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '5 months')
          GROUP BY DATE_TRUNC('month', created_at)
        )
        SELECT m.month, COALESCE(s.new_members, 0)::int AS new_members
        FROM months m
        LEFT JOIN signups s ON s.month = m.month
        ORDER BY m.month
      `),
    ]);

    res.json({
      tierDistribution: (tierResult.rows as { tier: string; member_count: number }[]).map(r => ({
        tier: r.tier,
        memberCount: r.member_count,
      })),
      atRiskMembers: (atRiskResult.rows as { id: number; name: string; email: string; tier: string | null; last_booking_date: string | null }[]).map(r => ({
        id: r.id,
        name: r.name,
        email: r.email,
        tier: r.tier || 'Unknown',
        lastBookingDate: r.last_booking_date,
      })),
      newMemberGrowth: (growthResult.rows as { month: string; new_members: number }[]).map(r => ({
        month: r.month,
        newMembers: r.new_members,
      })),
    });
  } catch (error) {
    logger.error('Failed to fetch membership insights', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to fetch membership insights' });
  }
});

export default router;
