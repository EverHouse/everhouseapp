import { Router } from 'express';
import { db } from '../../db';
import { isStaffOrAdmin } from '../../core/middleware';
import { logger } from '../../core/logger';
import { getPacificMidnightUTC, getTodayPacific } from '../../utils/dateUtils';
import { bookingRequests, tours, adminAuditLog, users, resources } from '../../../shared/schema';
import { eq, and, inArray, notInArray, desc, asc, sql, gte, lt, count } from 'drizzle-orm';

const router = Router();

/**
 * GET /api/admin/command-center
 * Returns ALL data needed for the staff command center in a single call
 * Consolidates 8+ individual API calls into one efficient request
 * Uses Drizzle ORM for consistent camelCase field naming
 */
router.get('/api/admin/command-center', isStaffOrAdmin, async (req, res) => {
  try {
    const today = getTodayPacific();
    const startOfDay = getPacificMidnightUTC(today);
    const startOfDayUnix = Math.floor(startOfDay.getTime() / 1000);
    const endOfDayUnix = startOfDayUnix + 86400;
    
    // Run all queries in parallel for maximum efficiency using Drizzle
    const [
      pendingBookingsCount,
      pendingRequestsData,
      todaysBookingsData,
      activeMembersCount,
      pendingToursData,
      recentActivityData
    ] = await Promise.all([
      // Count pending bookings (exclude unmatched Trackman bookings)
      db.select({ count: count() })
        .from(bookingRequests)
        .where(and(
          eq(bookingRequests.status, 'pending_approval'),
          sql`(${bookingRequests.isUnmatched} = false OR ${bookingRequests.isUnmatched} IS NULL)`
        )),
      
      // Pending requests with user and resource info
      db.select({
        id: bookingRequests.id,
        requestDate: bookingRequests.requestDate,
        startTime: bookingRequests.startTime,
        endTime: bookingRequests.endTime,
        status: bookingRequests.status,
        createdAt: bookingRequests.createdAt,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        resourceName: resources.name
      })
        .from(bookingRequests)
        .leftJoin(users, eq(users.id, bookingRequests.userId))
        .leftJoin(resources, eq(resources.id, bookingRequests.resourceId))
        .where(and(
          inArray(bookingRequests.status, ['pending', 'pending_approval']),
          sql`(${bookingRequests.isUnmatched} = false OR ${bookingRequests.isUnmatched} IS NULL)`
        ))
        .orderBy(desc(bookingRequests.createdAt))
        .limit(20),
      
      // Today's bookings (exclude unmatched Trackman bookings)
      db.select({
        id: bookingRequests.id,
        requestDate: bookingRequests.requestDate,
        startTime: bookingRequests.startTime,
        endTime: bookingRequests.endTime,
        status: bookingRequests.status,
        resourceId: bookingRequests.resourceId,
        resourceName: resources.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email
      })
        .from(bookingRequests)
        .leftJoin(resources, eq(resources.id, bookingRequests.resourceId))
        .leftJoin(users, eq(users.id, bookingRequests.userId))
        .where(and(
          eq(bookingRequests.requestDate, today),
          notInArray(bookingRequests.status, ['cancelled', 'declined']),
          sql`(${bookingRequests.isUnmatched} = false OR ${bookingRequests.isUnmatched} IS NULL)`
        ))
        .orderBy(asc(bookingRequests.startTime)),
      
      // Active members count
      db.select({ count: count() })
        .from(users)
        .where(and(
          eq(users.membershipStatus, 'active'),
          sql`${users.archivedAt} IS NULL`
        )),
      
      // Pending tours
      db.select({
        id: tours.id,
        guestName: tours.guestName,
        guestEmail: tours.guestEmail,
        guestPhone: tours.guestPhone,
        tourDate: tours.tourDate,
        startTime: tours.startTime,
        status: tours.status,
        createdAt: tours.createdAt
      })
        .from(tours)
        .where(eq(tours.status, 'pending'))
        .orderBy(desc(tours.createdAt))
        .limit(10),
      
      // Recent activity
      db.select({
        id: adminAuditLog.id,
        action: adminAuditLog.action,
        staffEmail: adminAuditLog.staffEmail,
        resourceType: adminAuditLog.resourceType,
        resourceName: adminAuditLog.resourceName,
        createdAt: adminAuditLog.createdAt
      })
        .from(adminAuditLog)
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(15)
    ]);
    
    // Financials queries with error handling for missing columns/tables
    let financials = { todayRevenueCents: 0, overduePaymentsCount: 0, failedPaymentsCount: 0 };
    try {
      const todayRevenue = await db.execute(sql`
        SELECT COALESCE(SUM(amount_cents), 0) as total_cents
        FROM stripe_transaction_cache
        WHERE status IN ('succeeded', 'paid')
        AND created_at >= to_timestamp(${startOfDayUnix}) AND created_at < to_timestamp(${endOfDayUnix})
      `);
      financials.todayRevenueCents = parseInt(String(todayRevenue.rows[0]?.total_cents || '0'));
    } catch (err) { logger.debug('[Command Center] Failed to query today revenue — table may not have expected structure', { error: err instanceof Error ? err.message : err }); }
    
    res.json({
      counts: {
        pendingBookings: pendingBookingsCount[0]?.count || 0,
        todaysBookings: todaysBookingsData.length,
        activeMembers: activeMembersCount[0]?.count || 0,
        pendingTours: pendingToursData.length
      },
      pendingRequests: pendingRequestsData,
      todaysBookings: todaysBookingsData,
      pendingToursList: pendingToursData,
      recentActivity: recentActivityData,
      financials,
      date: today,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    logger.error('Error fetching command center data', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch command center data' });
  }
});

/**
 * GET /api/admin/dashboard-summary
 * Returns summary data for the admin dashboard home page
 * Used for prefetching to speed up dashboard load
 */
router.get('/api/admin/dashboard-summary', isStaffOrAdmin, async (req, res) => {
  try {
    const today = getTodayPacific();
    
    // Parallel queries for dashboard summary using Drizzle
    const [pendingBookings, todaysBookings, activeMembers, pendingTours] = await Promise.all([
      db.select({ count: count() })
        .from(bookingRequests)
        .where(and(
          eq(bookingRequests.status, 'pending'),
          sql`(${bookingRequests.isUnmatched} = false OR ${bookingRequests.isUnmatched} IS NULL)`
        )),
      
      db.select({ count: count() })
        .from(bookingRequests)
        .where(and(
          eq(bookingRequests.requestDate, today),
          eq(bookingRequests.status, 'approved'),
          sql`(${bookingRequests.isUnmatched} = false OR ${bookingRequests.isUnmatched} IS NULL)`
        )),
      
      db.select({ count: count() })
        .from(users)
        .where(and(
          eq(users.membershipStatus, 'active'),
          sql`${users.archivedAt} IS NULL`
        )),
      
      db.select({ count: count() })
        .from(tours)
        .where(eq(tours.status, 'pending'))
    ]);
    
    res.json({
      pendingBookingsCount: pendingBookings[0]?.count || 0,
      todaysBookingsCount: todaysBookings[0]?.count || 0,
      activeMembersCount: activeMembers[0]?.count || 0,
      pendingToursCount: pendingTours[0]?.count || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    logger.error('Error fetching dashboard summary', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch dashboard summary' });
  }
});

/**
 * GET /api/admin/financials/summary
 * Returns summary financial data for the financials tab
 * Used for prefetching to speed up financials page load
 */
router.get('/api/admin/financials/summary', isStaffOrAdmin, async (req, res) => {
  try {
    const today = getTodayPacific();
    const startOfDay = Math.floor(getPacificMidnightUTC(today).getTime() / 1000);
    const endOfDay = startOfDay + 86400;
    
    // Use individual queries with error handling for each - some tables may not exist
    const results: { todayRevenueCents: number; overduePaymentsCount: number; failedPaymentsCount: number; pendingAuthorizationsCount: number } = {
      todayRevenueCents: 0,
      overduePaymentsCount: 0,
      failedPaymentsCount: 0,
      pendingAuthorizationsCount: 0
    };
    
    // Today's revenue from Stripe cache
    try {
      const todayRevenue = await db.execute(sql`
        SELECT COALESCE(SUM(amount_cents), 0) as total_cents
        FROM stripe_transaction_cache
        WHERE status IN ('succeeded', 'paid')
        AND created_at >= to_timestamp(${startOfDay})
        AND created_at < to_timestamp(${endOfDay})
      `);
      results.todayRevenueCents = parseInt(String(todayRevenue.rows[0]?.total_cents || '0'));
    } catch (err) { logger.debug('[Financials] Failed to query today revenue — table may not exist', { error: err instanceof Error ? err.message : err }); }
    
    // Overdue payments from booking sessions
    try {
      const overdueCount = await db.execute(sql`
        SELECT COUNT(DISTINCT br.id) as count
        FROM booking_requests br
        WHERE br.session_id IS NOT NULL
          AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND br.request_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date - INTERVAL '30 days'
          AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
          AND NOT EXISTS (
            SELECT 1 FROM booking_fee_snapshots bfs
            WHERE bfs.session_id = br.session_id AND bfs.status IN ('completed', 'paid')
          )
          AND EXISTS (
            SELECT 1 FROM booking_participants bp
            WHERE bp.session_id = br.session_id
              AND bp.payment_status = 'pending'
              AND COALESCE(bp.cached_fee_cents, 0) > 0
          )
      `);
      results.overduePaymentsCount = parseInt(String(overdueCount.rows[0]?.count || '0'));
    } catch (err) { logger.debug('[Financials] Failed to query overdue payments — table may not exist', { error: err instanceof Error ? err.message : err }); }
    
    // Failed payments - only query if table exists
    try {
      const failedPayments = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM stripe_payment_intents
        WHERE status = 'requires_payment_method' OR status = 'requires_confirmation'
      `);
      results.failedPaymentsCount = parseInt(String(failedPayments.rows[0]?.count || '0'));
    } catch (err) { logger.debug('[Financials] Failed to query failed payments — table may not exist', { error: err instanceof Error ? err.message : err }); }
    
    // Pending authorizations - count uncaptured payment intents
    try {
      const pendingAuths = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM stripe_payment_intents
        WHERE status = 'requires_capture'
      `);
      results.pendingAuthorizationsCount = parseInt(String(pendingAuths.rows[0]?.count || '0'));
    } catch (err) { logger.debug('[Financials] Failed to query pending authorizations — table may not exist', { error: err instanceof Error ? err.message : err }); }
    
    res.json({
      ...results,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    logger.error('Error fetching financials summary', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch financials summary' });
  }
});

/**
 * GET /api/admin/todays-bookings
 * Returns today's bookings for the staff dashboard
 * Used for prefetching to speed up admin page load
 * Uses Drizzle ORM for consistent camelCase field naming
 */
router.get('/api/admin/todays-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const today = getTodayPacific();
    
    const bookingsData = await db.select({
      id: bookingRequests.id,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      status: bookingRequests.status,
      resourceId: bookingRequests.resourceId,
      resourceName: resources.name,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email
    })
      .from(bookingRequests)
      .leftJoin(resources, eq(resources.id, bookingRequests.resourceId))
      .leftJoin(users, eq(users.id, bookingRequests.userId))
      .where(and(
        eq(bookingRequests.requestDate, today),
        notInArray(bookingRequests.status, ['cancelled', 'declined']),
        sql`(${bookingRequests.isUnmatched} = false OR ${bookingRequests.isUnmatched} IS NULL)`
      ))
      .orderBy(asc(bookingRequests.startTime));
    
    res.json({
      bookings: bookingsData,
      count: bookingsData.length,
      date: today,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    logger.error('Error fetching todays bookings', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch todays bookings' });
  }
});

router.get('/api/staff/list', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT su.id, su.email, su.first_name, su.last_name, su.role,
             u.id as user_id
      FROM staff_users su
      LEFT JOIN users u ON LOWER(u.email) = LOWER(su.email) AND u.archived_at IS NULL
      WHERE su.is_active = true
      ORDER BY 
        CASE su.role 
          WHEN 'golf_instructor' THEN 1 
          WHEN 'admin' THEN 2 
          WHEN 'staff' THEN 3 
          ELSE 4 
        END,
        su.first_name
    `);
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('Error fetching staff list', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch staff list' });
  }
});

router.get('/api/directory/team', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT 
        su.id as staff_id,
        su.email,
        su.first_name,
        su.last_name,
        su.phone,
        su.job_title,
        su.role,
        su.is_active,
        u.id as user_id,
        u.tier,
        u.membership_status,
        u.stripe_customer_id,
        u.hubspot_id
      FROM staff_users su
      LEFT JOIN users u ON LOWER(u.email) = LOWER(su.email)
      WHERE su.is_active = true
      ORDER BY 
        CASE su.role 
          WHEN 'golf_instructor' THEN 1 
          WHEN 'admin' THEN 2 
          WHEN 'staff' THEN 3 
          ELSE 4 
        END,
        su.first_name,
        su.last_name
    `);
    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('Error fetching directory team', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch team directory' });
  }
});

export default router;
