import { Router } from 'express';
import { pool } from '../../core/db';
import { isStaffOrAdmin } from '../../core/middleware';
import { getPacificMidnightUTC } from '../../utils/dateUtils';

const router = Router();

/**
 * GET /api/admin/command-center
 * Returns ALL data needed for the staff command center in a single call
 * Consolidates 8+ individual API calls into one efficient request
 */
router.get('/api/admin/command-center', isStaffOrAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = getPacificMidnightUTC(today);
    const startOfDayUnix = Math.floor(startOfDay.getTime() / 1000);
    const endOfDayUnix = startOfDayUnix + 86400;
    
    // Run all queries in parallel for maximum efficiency
    const [
      pendingBookings,
      pendingRequests,
      todaysBookingsData,
      activeMembers,
      pendingTours,
      recentActivity
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count FROM booking_requests WHERE status = 'pending_approval'`),
      pool.query(`
        SELECT br.id, br.request_date, br.start_time, br.end_time, br.status, br.created_at,
               u.first_name, u.last_name, u.email, r.name as resource_name
        FROM booking_requests br
        LEFT JOIN users u ON u.id = br.user_id
        LEFT JOIN resources r ON r.id = br.resource_id
        WHERE br.status IN ('pending', 'pending_approval')
        ORDER BY br.created_at DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT br.id, br.request_date, br.start_time, br.end_time, br.status,
               br.resource_id, r.name as resource_name,
               u.first_name, u.last_name, u.email
        FROM booking_requests br
        LEFT JOIN resources r ON r.id = br.resource_id
        LEFT JOIN users u ON u.id = br.user_id
        WHERE br.request_date = $1
        AND br.status NOT IN ('cancelled', 'declined')
        ORDER BY br.start_time ASC
      `, [today]),
      pool.query(`SELECT COUNT(*) as count FROM users WHERE membership_status = 'active' AND archived_at IS NULL`),
      pool.query(`
        SELECT id, contact_name, contact_email, contact_phone, requested_date, requested_time, status, created_at
        FROM tours WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10
      `),
      pool.query(`
        SELECT id, action, staff_email, resource_type, resource_name, created_at
        FROM admin_audit_log
        ORDER BY created_at DESC
        LIMIT 15
      `)
    ]);
    
    // Financials queries with error handling for missing columns/tables
    let financials = { todayRevenueCents: 0, overduePaymentsCount: 0, failedPaymentsCount: 0 };
    try {
      const todayRevenue = await pool.query(`
        SELECT COALESCE(SUM(amount_cents), 0) as total_cents
        FROM stripe_transaction_cache
        WHERE status IN ('succeeded', 'paid')
        AND created_at >= to_timestamp($1) AND created_at < to_timestamp($2)
      `, [startOfDayUnix, endOfDayUnix]);
      financials.todayRevenueCents = parseInt(todayRevenue.rows[0]?.total_cents || '0');
    } catch { /* table may not have expected structure */ }
    
    res.json({
      counts: {
        pendingBookings: parseInt(pendingBookings.rows[0]?.count || '0'),
        todaysBookings: todaysBookingsData.rowCount || 0,
        activeMembers: parseInt(activeMembers.rows[0]?.count || '0'),
        pendingTours: pendingTours.rowCount || 0
      },
      pendingRequests: pendingRequests.rows,
      todaysBookings: todaysBookingsData.rows,
      pendingToursList: pendingTours.rows,
      recentActivity: recentActivity.rows,
      financials,
      date: today,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error fetching command center data:', error);
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
    const today = new Date().toISOString().split('T')[0];
    
    // Parallel queries for dashboard summary
    const [pendingBookings, todaysBookings, activeMembers, pendingTours] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) as count 
        FROM booking_requests 
        WHERE status = 'pending'
      `),
      pool.query(`
        SELECT COUNT(*) as count 
        FROM booking_requests 
        WHERE booking_date = $1 AND status = 'approved'
      `, [today]),
      pool.query(`
        SELECT COUNT(*) as count 
        FROM users 
        WHERE membership_status = 'active' AND archived_at IS NULL
      `),
      pool.query(`
        SELECT COUNT(*) as count 
        FROM tours 
        WHERE status = 'pending'
      `)
    ]);
    
    res.json({
      pendingBookingsCount: parseInt(pendingBookings.rows[0]?.count || '0'),
      todaysBookingsCount: parseInt(todaysBookings.rows[0]?.count || '0'),
      activeMembersCount: parseInt(activeMembers.rows[0]?.count || '0'),
      pendingToursCount: parseInt(pendingTours.rows[0]?.count || '0'),
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error fetching dashboard summary:', error);
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
    const today = new Date().toISOString().split('T')[0];
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
      const todayRevenue = await pool.query(`
        SELECT COALESCE(SUM(amount_cents), 0) as total_cents
        FROM stripe_transaction_cache
        WHERE status IN ('succeeded', 'paid')
        AND created_at >= to_timestamp($1)
        AND created_at < to_timestamp($2)
      `, [startOfDay, endOfDay]);
      results.todayRevenueCents = parseInt(todayRevenue.rows[0]?.total_cents || '0');
    } catch { /* table may not exist */ }
    
    // Overdue payments from booking sessions
    try {
      const overdueCount = await pool.query(`
        SELECT COUNT(DISTINCT bs.booking_id) as count
        FROM booking_sessions bs
        JOIN booking_requests br ON br.id = bs.booking_id
        WHERE bs.payment_status IN ('outstanding', 'partially_paid')
        AND bs.cancelled_at IS NULL
        AND bs.fee_status = 'finalized'
        AND br.status NOT IN ('cancelled', 'declined')
      `);
      results.overduePaymentsCount = parseInt(overdueCount.rows[0]?.count || '0');
    } catch { /* table may not exist */ }
    
    // Failed payments - only query if table exists
    try {
      const failedPayments = await pool.query(`
        SELECT COUNT(*) as count
        FROM stripe_payment_intents
        WHERE status = 'requires_payment_method' OR status = 'requires_confirmation'
      `);
      results.failedPaymentsCount = parseInt(failedPayments.rows[0]?.count || '0');
    } catch { /* table may not exist */ }
    
    // Pending authorizations - count uncaptured payment intents
    try {
      const pendingAuths = await pool.query(`
        SELECT COUNT(*) as count
        FROM stripe_payment_intents
        WHERE status = 'requires_capture'
      `);
      results.pendingAuthorizationsCount = parseInt(pendingAuths.rows[0]?.count || '0');
    } catch { /* table may not exist */ }
    
    res.json({
      ...results,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error fetching financials summary:', error);
    res.status(500).json({ error: 'Failed to fetch financials summary' });
  }
});

/**
 * GET /api/admin/todays-bookings
 * Returns today's bookings for the staff dashboard
 * Used for prefetching to speed up admin page load
 */
router.get('/api/admin/todays-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = getPacificMidnightUTC(today);
    const endOfDay = new Date(startOfDay.getTime() + 86400000);
    
    const result = await pool.query(`
      SELECT br.id, br.booking_date, br.start_time, br.end_time, br.status,
             bs.bay_id, b.name as bay_name, b.color as bay_color,
             u.first_name, u.last_name, u.email
      FROM booking_requests br
      LEFT JOIN booking_sessions bs ON bs.booking_id = br.id
      LEFT JOIN bays b ON b.id = br.bay_id
      LEFT JOIN users u ON u.id = br.user_id
      WHERE br.booking_date = $1
      AND br.status NOT IN ('cancelled', 'declined')
      ORDER BY br.start_time ASC
    `, [today]);
    
    res.json({
      bookings: result.rows,
      count: result.rowCount,
      date: today,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error fetching todays bookings:', error);
    res.status(500).json({ error: 'Failed to fetch todays bookings' });
  }
});

router.get('/api/staff/list', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT su.id, su.email, su.first_name, su.last_name, su.role,
             u.id as user_id
      FROM staff_users su
      INNER JOIN users u ON LOWER(u.email) = LOWER(su.email)
      WHERE su.is_active = true AND u.archived_at IS NULL
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
  } catch (error: any) {
    console.error('Error fetching staff list:', error);
    res.status(500).json({ error: 'Failed to fetch staff list' });
  }
});

router.get('/api/directory/team', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
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
  } catch (error: any) {
    console.error('Error fetching directory team:', error);
    res.status(500).json({ error: 'Failed to fetch team directory' });
  }
});

export default router;
