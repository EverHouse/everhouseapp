import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../core/logger';
import { getErrorMessage } from '../utils/errorUtils';

const router = Router();

router.get('/api/analytics/booking-stats', isStaffOrAdmin, async (_req: Request, res: Response) => {
  try {
    const peakHoursResult = await db.execute(sql`
      SELECT
        EXTRACT(DOW FROM request_date::date) AS day_of_week,
        EXTRACT(HOUR FROM start_time::time) AS hour_of_day,
        COUNT(*)::int AS booking_count
      FROM booking_requests
      WHERE status NOT IN ('cancelled', 'declined')
        AND request_date IS NOT NULL
        AND start_time IS NOT NULL
      GROUP BY day_of_week, hour_of_day
      ORDER BY day_of_week, hour_of_day
    `);

    const resourceUtilResult = await db.execute(sql`
      SELECT
        r.name AS resource_name,
        COALESCE(SUM(br.duration_minutes), 0)::int AS total_minutes
      FROM resources r
      LEFT JOIN booking_requests br ON br.resource_id = r.id
        AND br.status NOT IN ('cancelled', 'declined')
      GROUP BY r.id, r.name
      ORDER BY total_minutes DESC
    `);

    const topMembersResult = await db.execute(sql`
      SELECT
        COALESCE(br.user_name, br.user_email) AS member_name,
        br.user_email AS member_email,
        SUM(br.duration_minutes)::int AS total_minutes
      FROM booking_requests br
      WHERE br.status NOT IN ('cancelled', 'declined')
        AND br.user_email IS NOT NULL
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
    `);

    const avgSessionResult = await db.execute(sql`
      SELECT
        ROUND(AVG(duration_minutes), 1) AS avg_minutes
      FROM booking_requests
      WHERE status NOT IN ('cancelled', 'declined')
        AND duration_minutes IS NOT NULL
        AND duration_minutes > 0
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
        WHERE br.status NOT IN ('cancelled', 'declined')
      `),

      db.execute(sql`
        WITH member_counts AS (
          SELECT user_email, COUNT(*)::int AS booking_count
          FROM booking_requests
          WHERE status NOT IN ('cancelled', 'declined')
            AND request_date >= CURRENT_DATE - INTERVAL '90 days'
            AND user_email IS NOT NULL
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

      db.execute(sql`
        WITH participant_rev AS (
          SELECT
            TO_CHAR(DATE_TRUNC('month', bs.session_date::date), 'YYYY-MM') AS month,
            COALESCE(SUM(bp.cached_fee_cents) FILTER (WHERE bp.payment_status = 'paid' AND bp.participant_type != 'guest'), 0)::int AS booking_revenue_cents,
            COALESCE(SUM(bp.cached_fee_cents) FILTER (WHERE bp.payment_status = 'paid' AND bp.participant_type = 'guest'), 0)::int AS guest_revenue_cents
          FROM booking_sessions bs
          INNER JOIN booking_participants bp ON bp.session_id = bs.id
          WHERE bs.session_date >= CURRENT_DATE - INTERVAL '6 months'
          GROUP BY DATE_TRUNC('month', bs.session_date::date)
        ),
        ledger_rev AS (
          SELECT
            TO_CHAR(DATE_TRUNC('month', bs.session_date::date), 'YYYY-MM') AS month,
            COALESCE(SUM(ul.overage_fee::numeric * 100), 0)::int AS overage_revenue_cents
          FROM booking_sessions bs
          INNER JOIN usage_ledger ul ON ul.session_id = bs.id
          WHERE bs.session_date >= CURRENT_DATE - INTERVAL '6 months'
          GROUP BY DATE_TRUNC('month', bs.session_date::date)
        )
        SELECT
          COALESCE(p.month, l.month) AS month,
          COALESCE(p.booking_revenue_cents, 0)::int AS participant_revenue_cents,
          COALESCE(p.guest_revenue_cents, 0)::int AS guest_revenue_cents,
          COALESCE(l.overage_revenue_cents, 0)::int AS overage_revenue_cents
        FROM participant_rev p
        FULL OUTER JOIN ledger_rev l ON p.month = l.month
        ORDER BY month
      `),

      db.execute(sql`
        SELECT
          TO_CHAR(DATE_TRUNC('week', request_date::date), 'YYYY-MM-DD') AS week_start,
          COUNT(*)::int AS booking_count
        FROM booking_requests
        WHERE status NOT IN ('cancelled', 'declined')
          AND request_date >= CURRENT_DATE - INTERVAL '6 months'
          AND request_date IS NOT NULL
        GROUP BY DATE_TRUNC('week', request_date::date)
        ORDER BY week_start
      `),

      db.execute(sql`
        SELECT
          EXTRACT(DOW FROM request_date::date)::int AS day_of_week,
          COUNT(*)::int AS booking_count
        FROM booking_requests
        WHERE status NOT IN ('cancelled', 'declined')
          AND request_date IS NOT NULL
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
          WHERE status NOT IN ('cancelled', 'declined')
            AND start_time IS NOT NULL
            AND end_time IS NOT NULL
            AND resource_id IN (SELECT id FROM resources WHERE type = 'simulator')
        ),
        hourly_bookings AS (
          SELECT hour_slot::int, COUNT(*)::int AS booked_count
          FROM booking_hours
          GROUP BY hour_slot
        ),
        total_days AS (
          SELECT COUNT(DISTINCT request_date)::int AS num_days
          FROM booking_requests
          WHERE status NOT IN ('cancelled', 'declined')
            AND request_date IS NOT NULL
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
      revenueOverTime: (revenueOverTimeResult.rows as { month: string; participant_revenue_cents: number; overage_revenue_cents: number; guest_revenue_cents: number }[]).map(r => ({
        month: r.month,
        participantRevenue: Math.round(r.participant_revenue_cents) / 100,
        overageRevenue: Math.round(r.overage_revenue_cents) / 100,
        guestRevenue: Math.round(r.guest_revenue_cents) / 100,
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

export default router;
