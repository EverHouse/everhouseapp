import { Router } from 'express';
import { eq, sql, desc } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db';
import { users, dayPassPurchases } from '../../../shared/schema';
import { isProduction } from '../../core/db';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { getSessionUser } from '../../types/session';
import { getOrCreateStripeCustomer } from '../../core/stripe';
import { logFromRequest } from '../../core/auditLog';

const PLACEHOLDER_EMAIL_PATTERNS = [
  '@visitors.evenhouse.club',
  '@trackman.local',
  'unmatched-',
  'golfnow-',
  'classpass-',
  'anonymous-',
  'anongolfnow@',
  'placeholder@'
];

function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const lower = email.toLowerCase();
  return PLACEHOLDER_EMAIL_PATTERNS.some(pattern => lower.includes(pattern));
}

const router = Router();

router.get('/api/visitors', isStaffOrAdmin, async (req, res) => {
  try {
    const { sortBy = 'lastPurchase', order = 'desc', limit = '100', offset = '0', typeFilter = 'all', sourceFilter = 'all', search = '' } = req.query;
    const pageLimit = Math.min(parseInt(limit as string) || 100, 500);
    const pageOffset = Math.max(parseInt(offset as string) || 0, 0);
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const searchTerm = (search as string || '').trim().toLowerCase();
    
    const sortColumnMap: Record<string, string> = {
      name: "first_name || ' ' || last_name",
      totalSpent: 'total_spent_cents',
      purchaseCount: 'purchase_count',
      createdAt: 'created_at',
    };
    const nullsLast = sortBy === 'name' || sortBy === 'totalSpent' || sortBy === 'purchaseCount' ? '' : ' NULLS LAST';
    const sortColumn = sortColumnMap[sortBy as string] || 'last_purchase_date';
    const orderByClause = sql.raw(`${sortColumn} ${sortOrder}${nullsLast}`);
    
    let sourceCondition = '';
    if (sourceFilter === 'stripe') {
      sourceCondition = `AND u.stripe_customer_id IS NOT NULL 
        AND u.mindbody_client_id IS NULL 
        AND u.legacy_source IS DISTINCT FROM 'mindbody_import'
        AND u.data_source IS DISTINCT FROM 'APP'`;
    } else if (sourceFilter === 'mindbody') {
      sourceCondition = `AND (u.mindbody_client_id IS NOT NULL OR u.legacy_source = 'mindbody_import')`;
    } else if (sourceFilter === 'hubspot') {
      sourceCondition = `AND u.hubspot_id IS NOT NULL 
        AND u.stripe_customer_id IS NULL 
        AND u.mindbody_client_id IS NULL
        AND u.legacy_source IS DISTINCT FROM 'mindbody_import'
        AND u.data_source IS DISTINCT FROM 'APP'`;
    } else if (sourceFilter === 'APP') {
      sourceCondition = `AND u.data_source = 'APP'`;
    }
    
    let typeConditionCount = '';
    let typeConditionMain = '';
    if (typeFilter === 'day_pass') {
      typeConditionCount = "AND computed_type = 'day_pass'";
      typeConditionMain = "AND effective_type = 'day_pass'";
    } else if (typeFilter === 'guest') {
      typeConditionCount = "AND computed_type = 'guest'";
      typeConditionMain = "AND effective_type = 'guest'";
    } else if (typeFilter === 'lead') {
      typeConditionCount = "AND computed_type = 'lead'";
      typeConditionMain = "AND effective_type = 'lead'";
    } else if (typeFilter === 'classpass') {
      typeConditionCount = "AND computed_type = 'classpass'";
      typeConditionMain = "AND effective_type = 'classpass'";
    } else if (typeFilter === 'sim_walkin') {
      typeConditionCount = "AND computed_type = 'sim_walkin'";
      typeConditionMain = "AND effective_type = 'sim_walkin'";
    } else if (typeFilter === 'private_lesson') {
      typeConditionCount = "AND computed_type = 'private_lesson'";
      typeConditionMain = "AND effective_type = 'private_lesson'";
    } else if (typeFilter === 'NEW') {
      typeConditionCount = "AND computed_type = 'NEW'";
      typeConditionMain = "AND effective_type = 'NEW'";
    }
    
    const searchPattern = searchTerm ? `%${searchTerm}%` : null;
    const searchClause = searchPattern
      ? sql`AND (
        LOWER(u.first_name || ' ' || u.last_name) LIKE ${searchPattern}
        OR LOWER(u.email) LIKE ${searchPattern}
        OR LOWER(u.phone) LIKE ${searchPattern}
      )`
      : sql``;
    
    const countResult = await db.execute(sql`
      WITH 
      purchase_types AS (
        SELECT DISTINCT ON (LOWER(member_email))
          LOWER(member_email) as email,
          CASE 
            WHEN item_name ILIKE '%classpass%' THEN 'classpass'
            WHEN item_name ILIKE '%sim%walk%' OR item_name ILIKE '%simulator walk%' THEN 'sim_walkin'
            WHEN item_name ILIKE '%private lesson%' THEN 'private_lesson'
            WHEN item_name ILIKE '%day pass%' THEN 'day_pass'
            ELSE NULL
          END as lp_type,
          sale_date as lp_date
        FROM legacy_purchases
        ORDER BY LOWER(member_email), sale_date DESC NULLS LAST
      ),
      guest_appearances AS (
        SELECT DISTINCT ON (LOWER(g.email))
          LOWER(g.email) as email,
          bs.session_date::timestamp as bp_date
        FROM booking_participants bp
        JOIN guests g ON bp.guest_id = g.id
        JOIN booking_sessions bs ON bp.session_id = bs.id
        WHERE bp.participant_type = 'guest'
        ORDER BY LOWER(g.email), bs.session_date DESC
      ),
      visitor_data AS (
        SELECT u.id,
          COALESCE(
            u.visitor_type,
            CASE 
              WHEN pt.lp_type IS NOT NULL AND ga.bp_date IS NOT NULL THEN
                CASE WHEN pt.lp_date >= ga.bp_date THEN pt.lp_type ELSE 'guest' END
              WHEN pt.lp_type IS NOT NULL THEN pt.lp_type
              WHEN ga.bp_date IS NOT NULL THEN 'guest'
              ELSE 'lead'
            END
          ) as computed_type
        FROM users u
        LEFT JOIN purchase_types pt ON LOWER(u.email) = pt.email
        LEFT JOIN guest_appearances ga ON LOWER(u.email) = ga.email
        WHERE (u.role = 'visitor' OR u.membership_status = 'visitor' OR u.membership_status = 'non-member')
        AND u.role NOT IN ('admin', 'staff')
        AND u.archived_at IS NULL
        ${sql.raw(sourceCondition)}
        ${searchClause}
      )
      SELECT COUNT(*)::int as total
      FROM visitor_data
      WHERE 1=1 ${sql.raw(typeConditionCount)}
    `);
    const totalCount = (countResult.rows[0] as any)?.total || 0;
    
    const visitorsWithPurchases = await db.execute(sql`
      WITH 
      purchase_types AS (
        SELECT DISTINCT ON (LOWER(member_email))
          LOWER(member_email) as email,
          CASE 
            WHEN item_name ILIKE '%classpass%' THEN 'classpass'
            WHEN item_name ILIKE '%sim%walk%' OR item_name ILIKE '%simulator walk%' THEN 'sim_walkin'
            WHEN item_name ILIKE '%private lesson%' THEN 'private_lesson'
            WHEN item_name ILIKE '%day pass%' THEN 'day_pass'
            ELSE NULL
          END as lp_type,
          sale_date as lp_date
        FROM legacy_purchases
        ORDER BY LOWER(member_email), sale_date DESC NULLS LAST
      ),
      guest_appearances AS (
        SELECT DISTINCT ON (LOWER(g.email))
          LOWER(g.email) as email,
          bs.session_date::timestamp as bp_date
        FROM booking_participants bp
        JOIN guests g ON bp.guest_id = g.id
        JOIN booking_sessions bs ON bp.session_id = bs.id
        WHERE bp.participant_type = 'guest'
        ORDER BY LOWER(g.email), bs.session_date DESC
      ),
      visitor_base AS (
        SELECT 
          u.id,
          u.email,
          u.first_name,
          u.last_name,
          u.phone,
          (COALESCE(dpp_agg.purchase_count, 0) + COALESCE(lp_agg.purchase_count, 0))::int as purchase_count,
          (COALESCE(dpp_agg.total_spent_cents, 0) + COALESCE(lp_agg.total_spent_cents, 0))::bigint as total_spent_cents,
          GREATEST(dpp_agg.last_purchase_date, lp_agg.last_purchase_date) as last_purchase_date,
          u.membership_status,
          u.role,
          u.stripe_customer_id,
          u.hubspot_id,
          u.mindbody_client_id,
          u.legacy_source,
          u.billing_provider,
          u.visitor_type,
          u.last_activity_at,
          u.last_activity_source,
          u.created_at,
          u.data_source,
          COALESCE(guest_agg.guest_count, 0)::int as guest_count,
          guest_agg.last_guest_date,
          COALESCE(
            u.visitor_type,
            CASE 
              WHEN pt.lp_type IS NOT NULL AND ga.bp_date IS NOT NULL THEN
                CASE WHEN pt.lp_date >= ga.bp_date THEN pt.lp_type ELSE 'guest' END
              WHEN pt.lp_type IS NOT NULL THEN pt.lp_type
              WHEN ga.bp_date IS NOT NULL THEN 'guest'
              ELSE 'lead'
            END
          ) as effective_type
        FROM users u
        LEFT JOIN purchase_types pt ON LOWER(u.email) = pt.email
        LEFT JOIN guest_appearances ga ON LOWER(u.email) = ga.email
        LEFT JOIN (
          SELECT LOWER(purchaser_email) as email, COUNT(*)::int as purchase_count, SUM(amount_cents) as total_spent_cents, MAX(purchased_at) as last_purchase_date
          FROM day_pass_purchases
          GROUP BY LOWER(purchaser_email)
        ) dpp_agg ON LOWER(u.email) = dpp_agg.email
        LEFT JOIN (
          SELECT LOWER(member_email) as email, COUNT(*)::int as purchase_count, SUM(item_total_cents) as total_spent_cents, MAX(sale_date) as last_purchase_date
          FROM legacy_purchases
          GROUP BY LOWER(member_email)
        ) lp_agg ON LOWER(u.email) = lp_agg.email
        LEFT JOIN (
          SELECT LOWER(bg.guest_email) as email, COUNT(DISTINCT bg.id)::int as guest_count, MAX(br.start_time) as last_guest_date
          FROM booking_guests bg
          LEFT JOIN booking_requests br ON bg.booking_id = br.id
          GROUP BY LOWER(bg.guest_email)
        ) guest_agg ON LOWER(u.email) = guest_agg.email
        WHERE (u.role = 'visitor' OR u.membership_status = 'visitor' OR u.membership_status = 'non-member')
        AND u.role NOT IN ('admin', 'staff')
        AND u.archived_at IS NULL
        ${sql.raw(sourceCondition)}
        ${searchClause}
      )
      SELECT *, effective_type as computed_type
      FROM visitor_base
      WHERE 1=1 ${sql.raw(typeConditionMain)}
      ORDER BY ${orderByClause}
      LIMIT ${pageLimit}
      OFFSET ${pageOffset}
    `);
    
    const getSource = (row: any): 'mindbody' | 'hubspot' | 'stripe' | 'app' => {
      if (row.data_source === 'APP') return 'app';
      const hasMindbodyData = row.mindbody_client_id || row.legacy_source === 'mindbody_import';
      const hasStripeData = !!row.stripe_customer_id;
      const hasHubspotData = !!row.hubspot_id;
      if (row.billing_provider === 'stripe' && hasStripeData) return 'stripe';
      if (hasMindbodyData) return 'mindbody';
      if (hasStripeData && !hasMindbodyData) return 'stripe';
      if (hasHubspotData) return 'hubspot';
      if (row.billing_provider === 'mindbody') return 'mindbody';
      if (row.billing_provider === 'stripe') return 'stripe';
      if (row.stripe_customer_id) return 'stripe';
      if (row.hubspot_id) return 'hubspot';
      return 'app';
    };
    
    type VisitorTypeValue = 'NEW' | 'classpass' | 'sim_walkin' | 'private_lesson' | 'day_pass' | 'guest' | 'lead';
    const getType = (row: any): VisitorTypeValue => {
      if (row.effective_type) {
        const et = row.effective_type as string;
        if (et === 'NEW') return 'NEW';
        if (et === 'classpass') return 'classpass';
        if (et === 'sim_walkin') return 'sim_walkin';
        if (et === 'private_lesson') return 'private_lesson';
        if (et === 'day_pass_buyer' || et === 'day_pass') return 'day_pass';
        if (et === 'guest') return 'guest';
        if (et === 'lead') return 'lead';
      }
      if (row.visitor_type) {
        if (row.visitor_type === 'NEW') return 'NEW';
        if (row.visitor_type === 'classpass') return 'classpass';
        if (row.visitor_type === 'sim_walkin') return 'sim_walkin';
        if (row.visitor_type === 'private_lesson') return 'private_lesson';
        if (row.visitor_type === 'day_pass_buyer' || row.visitor_type === 'day_pass') return 'day_pass';
        if (row.visitor_type === 'guest') return 'guest';
        if (row.visitor_type === 'lead') return 'lead';
      }
      const purchaseCount = parseInt(row.purchase_count) || 0;
      const guestCount = parseInt(row.guest_count) || 0;
      if (purchaseCount > 0) return 'day_pass';
      if (guestCount > 0) return 'guest';
      return 'lead';
    };
    
    const visitors = (visitorsWithPurchases.rows as any[]).map((row: any) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      purchaseCount: parseInt(row.purchase_count) || 0,
      totalSpentCents: parseInt(row.total_spent_cents) || 0,
      lastPurchaseDate: row.last_purchase_date,
      guestCount: parseInt(row.guest_count) || 0,
      lastGuestDate: row.last_guest_date,
      membershipStatus: row.membership_status,
      role: row.role,
      stripeCustomerId: row.stripe_customer_id,
      hubspotId: row.hubspot_id,
      mindbodyClientId: row.mindbody_client_id,
      lastActivityAt: row.last_activity_at,
      lastActivitySource: row.last_activity_source,
      createdAt: row.created_at,
      source: getSource(row),
      type: getType(row)
    }));
    
    res.json({
      success: true,
      total: totalCount,
      limit: pageLimit,
      offset: pageOffset,
      hasMore: pageOffset + visitors.length < totalCount,
      visitors
    });
  } catch (error: any) {
    if (!isProduction) console.error('Visitors list error:', error);
    res.status(500).json({ error: 'Failed to fetch visitors' });
  }
});

router.get('/api/visitors/:id/purchases', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const visitorResult = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      membershipStatus: users.membershipStatus
    })
      .from(users)
      .where(eq(users.id, id));
    
    if (visitorResult.length === 0) {
      return res.status(404).json({ error: 'Visitor not found' });
    }
    
    const visitor = visitorResult[0];
    
    const isVisitorLike = visitor.role === 'visitor' || 
                          visitor.membershipStatus === 'visitor' || 
                          visitor.membershipStatus === 'non-member';
    if (!isVisitorLike) {
      return res.status(403).json({ error: 'User is not a visitor' });
    }
    
    const purchases = await db.select()
      .from(dayPassPurchases)
      .where(sql`LOWER(${dayPassPurchases.purchaserEmail}) = LOWER(${visitor.email || ''})`)
      .orderBy(desc(dayPassPurchases.purchasedAt));
    
    res.json({
      success: true,
      visitor: {
        id: visitor.id,
        email: visitor.email,
        firstName: visitor.firstName,
        lastName: visitor.lastName,
        role: visitor.role,
        membershipStatus: visitor.membershipStatus
      },
      purchases,
      total: purchases.length
    });
  } catch (error: any) {
    if (!isProduction) console.error('Visitor purchases error:', error);
    res.status(500).json({ error: 'Failed to fetch visitor purchases' });
  }
});

router.get('/api/guests/needs-email', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT 
        g.id as guest_id,
        g.name as guest_name,
        g.email,
        bp.id as participant_id,
        bp.session_id,
        bp.display_name,
        bs.session_date,
        br.user_email as owner_email,
        br.id as booking_id,
        u.first_name || ' ' || u.last_name as owner_name
      FROM guests g
      JOIN booking_participants bp ON bp.guest_id = g.id
      JOIN booking_sessions bs ON bs.id = bp.session_id
      LEFT JOIN booking_requests br ON br.session_id = bs.id
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE (g.email IS NULL OR g.email = '')
      ORDER BY bs.session_date DESC
    `);
    
    res.json({
      success: true,
      guests: result.rows.map((row: any) => ({
        guestId: row.guest_id,
        guestName: row.guest_name,
        participantId: row.participant_id,
        sessionId: row.session_id,
        displayName: row.display_name,
        sessionDate: row.session_date,
        ownerEmail: row.owner_email,
        ownerName: row.owner_name,
        bookingId: row.booking_id
      })),
      count: result.rows.length
    });
  } catch (error: any) {
    console.error('[Guests Needs Email] Error:', error);
    res.status(500).json({ error: 'Failed to fetch guests needing email' });
  }
});

router.patch('/api/guests/:guestId/email', isStaffOrAdmin, async (req, res) => {
  try {
    const { guestId } = req.params;
    const { email } = req.body;
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    
    const normalizedEmail = email.trim().toLowerCase();
    
    const result = await db.execute(sql`UPDATE guests SET email = ${normalizedEmail} WHERE id = ${guestId} RETURNING id, name, email`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    res.json({
      success: true,
      guest: result.rows[0],
      message: `Email updated for ${(result.rows[0] as any).name}`
    });
  } catch (error: any) {
    console.error('[Update Guest Email] Error:', error);
    res.status(500).json({ error: 'Failed to update guest email' });
  }
});

router.post('/api/visitors', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, firstName, lastName, phone, createStripeCustomer = true, visitorType, dataSource } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const { resolveUserByEmail } = await import('../../core/stripe/customers');
    const resolved = await resolveUserByEmail(normalizedEmail);

    const existingUser = resolved
      ? await db.execute(sql`SELECT id, email, role, membership_status, first_name, last_name FROM users WHERE id = ${resolved.userId}`)
      : await db.execute(sql`SELECT id, email, role, membership_status, first_name, last_name FROM users WHERE LOWER(email) = ${normalizedEmail}`);

    if (resolved && resolved.matchType !== 'direct') {
      console.log(`[Visitors] Email ${normalizedEmail} resolved to existing user ${resolved.primaryEmail} via ${resolved.matchType}`);
    }
    
    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0] as any;
      
      const isNonMemberOrLead = ['non-member', 'visitor', 'lead'].includes(user.membership_status) || 
                                ['visitor', 'lead'].includes(user.role);
      
      if (isNonMemberOrLead && createStripeCustomer && !isPlaceholderEmail(normalizedEmail)) {
        let stripeCustomerId: string | null = null;
        try {
          const fullName = [firstName || user.first_name, lastName || user.last_name].filter(Boolean).join(' ') || undefined;
          const result = await getOrCreateStripeCustomer(user.id, normalizedEmail, fullName, 'visitor');
          stripeCustomerId = result.customerId;
          console.log(`[Visitors] Linked Stripe customer ${stripeCustomerId} to existing non-member ${normalizedEmail}`);
          
          if (user.membership_status === 'non-member') {
            await db.execute(sql`UPDATE users SET role = ${'visitor'}, updated_at = NOW() WHERE id = ${user.id}`);
          }
        } catch (stripeError: any) {
          console.error('[Visitors] Failed to link Stripe customer:', stripeError);
        }
        
        const staffEmail = (req as any).session?.user?.email || 'admin';
        await logFromRequest(req, {
          action: 'visitor_stripe_linked',
          resourceType: 'user',
          resourceId: user.id,
          resourceName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || normalizedEmail,
          details: { 
            email: normalizedEmail, 
            stripeCustomerId,
            linkedBy: staffEmail,
            wasNonMember: true
          }
        });
        
        return res.status(200).json({
          success: true,
          linked: true,
          stripeCreated: !!stripeCustomerId,
          visitor: {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phone: user.phone,
            role: 'visitor',
            membershipStatus: user.membership_status,
            stripeCustomerId
          }
        });
      }
      
      return res.status(409).json({ 
        error: 'A user with this email already exists',
        existingUser: {
          id: user.id,
          email: user.email,
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
          role: user.role,
          membershipStatus: user.membership_status
        }
      });
    }
    
    const userId = crypto.randomUUID();
    
    const insertResult = await db.execute(sql`
      INSERT INTO users (id, email, first_name, last_name, phone, role, membership_status, visitor_type, data_source, created_at, updated_at)
      VALUES (${userId}, ${normalizedEmail}, ${firstName || null}, ${lastName || null}, ${phone || null}, 'visitor', 'visitor', ${visitorType || null}, ${dataSource || null}, NOW(), NOW())
      RETURNING id, email, first_name, last_name, phone, role, membership_status, visitor_type, data_source
    `);
    
    const newUser = insertResult.rows[0] as any;
    let stripeCustomerId: string | null = null;
    
    if (createStripeCustomer && !isPlaceholderEmail(normalizedEmail)) {
      try {
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || undefined;
        const result = await getOrCreateStripeCustomer(userId, normalizedEmail, fullName, 'visitor');
        stripeCustomerId = result.customerId;
        console.log(`[Visitors] Created Stripe customer ${stripeCustomerId} for new visitor ${normalizedEmail}`);
      } catch (stripeError: any) {
        console.error('[Visitors] Failed to create Stripe customer:', stripeError);
      }
    }
    
    const staffEmail = (req as any).session?.user?.email || 'admin';
    await logFromRequest(req, {
      action: 'visitor_created',
      resourceType: 'user',
      resourceId: userId,
      resourceName: `${firstName || ''} ${lastName || ''}`.trim() || normalizedEmail,
      details: { 
        email: normalizedEmail, 
        stripeCustomerId,
        createdBy: staffEmail
      }
    });
    
    res.status(201).json({
      success: true,
      linked: false,
      stripeCreated: !!stripeCustomerId,
      visitor: {
        id: newUser.id,
        email: newUser.email,
        firstName: newUser.first_name,
        lastName: newUser.last_name,
        phone: newUser.phone,
        role: newUser.role,
        membershipStatus: newUser.membership_status,
        visitorType: newUser.visitor_type,
        dataSource: newUser.data_source,
        stripeCustomerId
      }
    });
  } catch (error: any) {
    console.error('[Visitors] Create visitor error:', error);
    res.status(500).json({ error: error.message || 'Failed to create visitor' });
  }
});

router.get('/api/visitors/search', isStaffOrAdmin, async (req, res) => {
  try {
    const { query, limit = '10', includeStaff = 'false', includeMembers = 'false' } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.json([]);
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(limit as string) || 10, 50);
    const shouldIncludeStaff = includeStaff === 'true';
    const shouldIncludeMembers = includeMembers === 'true';
    
    // Build role/status filter based on flags
    // Default: only visitors
    // includeStaff: also search staff/admin users (for booking assignment)
    // includeMembers: also search active members
    // Note: Always include users who are in staff_users table (instructors, staff, admins)
    // even if their users.membership_status is 'non-member'
    let roleCondition = `(role = 'visitor' OR membership_status = 'visitor')`;
    if (shouldIncludeStaff && shouldIncludeMembers) {
      roleCondition = `(
        role = 'visitor' OR membership_status = 'visitor'
        OR role IN ('staff', 'admin')
        OR membership_status IN ('active', 'trialing', 'past_due')
        OR EXISTS (SELECT 1 FROM staff_users su2 WHERE LOWER(su2.email) = LOWER(u.email) AND su2.is_active = true)
      )`;
    } else if (shouldIncludeStaff) {
      roleCondition = `(
        role = 'visitor' OR membership_status = 'visitor'
        OR role IN ('staff', 'admin')
        OR EXISTS (SELECT 1 FROM staff_users su2 WHERE LOWER(su2.email) = LOWER(u.email) AND su2.is_active = true)
      )`;
    } else if (shouldIncludeMembers) {
      roleCondition = `(
        role = 'visitor' OR membership_status = 'visitor'
        OR membership_status IN ('active', 'trialing', 'past_due')
      )`;
    }
    
    const results = await db.execute(sql`
      SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.stripe_customer_id, u.role, u.membership_status,
             su.role as staff_role, su.is_active as is_staff_active
      FROM users u
      LEFT JOIN staff_users su ON LOWER(u.email) = LOWER(su.email) AND su.is_active = true
      WHERE ${sql.raw(roleCondition.replace(/role/g, 'u.role').replace(/membership_status/g, 'u.membership_status').replace(/archived_at/g, 'u.archived_at'))}
      AND u.archived_at IS NULL
      AND (
        LOWER(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(u.first_name, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(u.last_name, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(u.email, '')) LIKE ${searchTerm}
      )
      ORDER BY u.first_name, u.last_name
      LIMIT ${maxResults}
    `);
    
    const visitors = results.rows.map((row: any) => {
      // Determine user type based on staff_users role and users table data
      const isGolfInstructor = row.staff_role === 'golf_instructor' && row.is_staff_active;
      const isStaff = row.role === 'staff' || row.role === 'admin' || row.staff_role === 'staff' || row.staff_role === 'admin';
      const isMember = row.membership_status === 'active' || row.membership_status === 'trialing' || row.membership_status === 'past_due';
      
      let userType = 'visitor';
      if (isGolfInstructor) {
        userType = 'instructor';
      } else if (isStaff) {
        userType = 'staff';
      } else if (isMember) {
        userType = 'member';
      }
      
      return {
        id: row.id,
        email: row.email,
        firstName: row.first_name || '',
        lastName: row.last_name || '',
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        phone: row.phone,
        hasStripeCustomer: !!row.stripe_customer_id,
        role: row.role,
        membershipStatus: row.membership_status,
        staffRole: row.staff_role,
        isInstructor: isGolfInstructor,
        userType
      };
    });
    
    res.json(visitors);
  } catch (error: any) {
    console.error('[Visitors] Search error:', error);
    res.status(500).json({ error: 'Failed to search visitors' });
  }
});

router.post('/api/visitors/backfill-types', isAdmin, async (req, res) => {
  try {
    const dayPassResult = await db.execute(sql`
      UPDATE users u
      SET 
        visitor_type = 'day_pass',
        last_activity_at = COALESCE(
          (SELECT MAX(purchased_at) FROM day_pass_purchases dpp WHERE LOWER(dpp.purchaser_email) = LOWER(u.email)),
          u.last_activity_at
        ),
        last_activity_source = 'day_pass_purchase',
        updated_at = NOW()
      FROM (
        SELECT DISTINCT LOWER(purchaser_email) as email
        FROM day_pass_purchases
      ) dpp
      WHERE LOWER(u.email) = dpp.email
      AND (u.role = 'visitor' OR u.membership_status IN ('visitor', 'non-member'))
      AND u.role NOT IN ('admin', 'staff')
      AND (u.visitor_type IS NULL OR u.visitor_type = 'lead')
      RETURNING u.id
    `);
    
    const guestResult = await db.execute(sql`
      UPDATE users u
      SET 
        visitor_type = 'guest',
        last_activity_at = COALESCE(
          (SELECT MAX(br.start_time) FROM booking_guests bg 
           JOIN booking_requests br ON bg.booking_id = br.id 
           WHERE LOWER(bg.guest_email) = LOWER(u.email)),
          u.last_activity_at
        ),
        last_activity_source = 'guest_pass',
        updated_at = NOW()
      FROM (
        SELECT DISTINCT LOWER(guest_email) as email
        FROM booking_guests
        WHERE guest_email IS NOT NULL
      ) bg
      WHERE LOWER(u.email) = bg.email
      AND (u.role = 'visitor' OR u.membership_status IN ('visitor', 'non-member'))
      AND u.role NOT IN ('admin', 'staff')
      AND u.visitor_type IS NULL
      RETURNING u.id
    `);
    
    const leadResult = await db.execute(sql`
      UPDATE users
      SET 
        visitor_type = 'lead',
        updated_at = NOW()
      WHERE (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
      AND role NOT IN ('admin', 'staff')
      AND visitor_type IS NULL
      RETURNING id
    `);
    
    const staffEmail = (req as any).session?.user?.email || 'admin';
    await logFromRequest(req, {
      action: 'data_migration',
      resourceType: 'system',
      resourceId: 'visitor_types_backfill',
      resourceName: 'Visitor Types Backfill',
      details: { 
        dayPassCount: dayPassResult.rows.length,
        guestCount: guestResult.rows.length,
        leadCount: leadResult.rows.length,
        triggeredBy: staffEmail
      }
    });
    
    res.json({
      success: true,
      updated: {
        dayPass: dayPassResult.rows.length,
        guest: guestResult.rows.length,
        lead: leadResult.rows.length
      }
    });
  } catch (error: any) {
    console.error('[Visitors] Backfill types error:', error);
    res.status(500).json({ error: error.message || 'Failed to backfill visitor types' });
  }
});

router.delete('/api/visitors/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteFromHubSpot, deleteFromStripe } = req.query;
    const sessionUser = getSessionUser(req);
    
    const userResult = await db.select({ 
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      tier: users.tier,
      stripeCustomerId: users.stripeCustomerId,
      hubspotId: users.hubspotId
    })
      .from(users)
      .where(eq(users.id, id));
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Visitor not found' });
    }
    
    const visitor = userResult[0];
    
    if (visitor.tier || (visitor.role && visitor.role !== 'visitor')) {
      return res.status(400).json({ 
        error: 'Cannot delete: This is a member, not a visitor. Use the member deletion flow instead.' 
      });
    }
    
    const visitorName = `${visitor.firstName || ''} ${visitor.lastName || ''}`.trim() || visitor.email;
    const visitorEmail = (visitor.email || '').toLowerCase();
    const visitorIdStr = String(id);
    const deletionLog: string[] = [];
    
    await db.execute(sql`DELETE FROM pass_redemption_logs WHERE purchase_id IN (SELECT id FROM day_pass_purchases WHERE user_id = ${visitorIdStr} OR LOWER(purchaser_email) = ${visitorEmail})`);
    deletionLog.push('pass_redemption_logs');
    
    await db.execute(sql`DELETE FROM day_pass_purchases WHERE user_id = ${visitorIdStr} OR LOWER(purchaser_email) = ${visitorEmail}`);
    deletionLog.push('day_pass_purchases');
    
    await db.execute(sql`DELETE FROM booking_guests WHERE LOWER(guest_email) = ${visitorEmail}`);
    deletionLog.push('booking_guests');
    
    await db.execute(sql`DELETE FROM member_notes WHERE LOWER(member_email) = ${visitorEmail}`);
    deletionLog.push('member_notes');
    
    await db.execute(sql`DELETE FROM communication_logs WHERE LOWER(member_email) = ${visitorEmail}`);
    deletionLog.push('communication_logs');
    
    await db.execute(sql`DELETE FROM legacy_purchases WHERE LOWER(member_email) = ${visitorEmail}`);
    deletionLog.push('legacy_purchases');
    
    await db.execute(sql`DELETE FROM booking_participants WHERE user_id = ${id}`);
    deletionLog.push('booking_participants');
    
    await db.execute(sql`UPDATE event_rsvps SET matched_user_id = NULL WHERE matched_user_id = ${visitorIdStr}`);
    await db.execute(sql`DELETE FROM event_rsvps WHERE LOWER(user_email) = ${visitorEmail}`);
    deletionLog.push('event_rsvps');
    
    await db.execute(sql`UPDATE booking_sessions SET created_by = NULL WHERE LOWER(created_by) = ${visitorEmail}`);
    deletionLog.push('booking_sessions (unlinked)');
    
    await db.execute(sql`UPDATE guests SET created_by_member_id = NULL WHERE created_by_member_id = ${visitorIdStr}`);
    deletionLog.push('guests (unlinked)');
    
    await db.execute(sql`DELETE FROM email_events WHERE LOWER(recipient_email) = ${visitorEmail}`);
    deletionLog.push('email_events');
    
    await db.execute(sql`DELETE FROM tours WHERE LOWER(guest_email) = ${visitorEmail}`);
    deletionLog.push('tours');
    
    await db.execute(sql`DELETE FROM trackman_unmatched_bookings WHERE LOWER(original_email) = ${visitorEmail} OR LOWER(resolved_email) = ${visitorEmail}`);
    deletionLog.push('trackman_unmatched_bookings');
    
    await db.execute(sql`DELETE FROM trackman_bay_slots WHERE LOWER(customer_email) = ${visitorEmail}`);
    deletionLog.push('trackman_bay_slots');
    
    await db.execute(sql`DELETE FROM stripe_transaction_cache WHERE LOWER(customer_email) = ${visitorEmail}`);
    deletionLog.push('stripe_transaction_cache (by email)');
    
    await db.execute(sql`DELETE FROM hubspot_line_items WHERE hubspot_deal_id IN (SELECT hubspot_deal_id FROM hubspot_deals WHERE LOWER(member_email) = ${visitorEmail})`);
    deletionLog.push('hubspot_line_items');
    
    await db.execute(sql`DELETE FROM hubspot_deals WHERE LOWER(member_email) = ${visitorEmail}`);
    deletionLog.push('hubspot_deals');
    
    await db.execute(sql`DELETE FROM notifications WHERE LOWER(user_email) = ${visitorEmail}`);
    deletionLog.push('notifications');
    
    await db.execute(sql`DELETE FROM magic_links WHERE LOWER(email) = ${visitorEmail}`);
    deletionLog.push('magic_links');
    
    await db.execute(sql`DELETE FROM push_subscriptions WHERE LOWER(user_email) = ${visitorEmail}`);
    deletionLog.push('push_subscriptions');
    
    await db.execute(sql`DELETE FROM user_dismissed_notices WHERE LOWER(user_email) = ${visitorEmail}`);
    deletionLog.push('user_dismissed_notices');
    
    await db.execute(sql`DELETE FROM form_submissions WHERE LOWER(email) = ${visitorEmail}`);
    deletionLog.push('form_submissions');
    
    await db.execute(sql`DELETE FROM sessions WHERE sess->'user'->>'email' = ${visitorEmail}`);
    deletionLog.push('sessions');
    
    await db.execute(sql`DELETE FROM hubspot_sync_queue WHERE LOWER(payload->>'email') = ${visitorEmail}`);
    deletionLog.push('hubspot_sync_queue');
    
    await db.execute(sql`DELETE FROM guest_check_ins WHERE LOWER(member_email) = ${visitorEmail} OR LOWER(guest_email) = ${visitorEmail}`);
    deletionLog.push('guest_check_ins');
    
    await db.execute(sql`DELETE FROM guest_passes WHERE LOWER(member_email) = ${visitorEmail}`);
    deletionLog.push('guest_passes');
    
    await db.execute(sql`DELETE FROM account_deletion_requests WHERE user_id = ${id}`);
    deletionLog.push('account_deletion_requests');
    
    await db.execute(sql`DELETE FROM data_export_requests WHERE LOWER(user_email) = ${visitorEmail}`);
    deletionLog.push('data_export_requests');
    
    await db.execute(sql`DELETE FROM bug_reports WHERE LOWER(user_email) = ${visitorEmail}`);
    deletionLog.push('bug_reports');
    
    await db.execute(sql`DELETE FROM terminal_payments WHERE user_id = ${visitorIdStr} OR LOWER(user_email) = ${visitorEmail}`);
    deletionLog.push('terminal_payments');
    
    await db.execute(sql`DELETE FROM stripe_payment_intents WHERE user_id = ${visitorIdStr}`);
    deletionLog.push('stripe_payment_intents');
    
    if (visitor.stripeCustomerId) {
      await db.execute(sql`DELETE FROM stripe_transaction_cache WHERE customer_id = ${visitor.stripeCustomerId}`);
      deletionLog.push('stripe_transaction_cache');
      
      await db.execute(sql`DELETE FROM terminal_payments WHERE stripe_customer_id = ${visitor.stripeCustomerId}`);
      await db.execute(sql`DELETE FROM stripe_payment_intents WHERE stripe_customer_id = ${visitor.stripeCustomerId}`);
      
      await db.execute(sql`DELETE FROM webhook_processed_events WHERE resource_id = ${visitor.stripeCustomerId}`);
      deletionLog.push('webhook_processed_events');
    }
    
    await db.execute(sql`DELETE FROM admin_audit_log WHERE resource_id = ${visitorIdStr} AND resource_type = 'user'`);
    deletionLog.push('admin_audit_log');
    
    await db.execute(sql`UPDATE billing_groups SET is_active = false WHERE LOWER(primary_email) = ${visitorEmail} AND is_active = true`);
    deletionLog.push('billing_groups (deactivated)');
    
    let stripeDeleted = false;
    if (deleteFromStripe === 'true' && visitor.stripeCustomerId) {
      try {
        const { getStripe } = await import('../../core/stripe');
        const stripe = getStripe();
        let hasMore = true;
        let startingAfter: string | undefined;
        while (hasMore) {
          const params: any = { customer: visitor.stripeCustomerId, limit: 100 };
          if (startingAfter) params.starting_after = startingAfter;
          const subscriptions = await stripe.subscriptions.list(params);
          for (const sub of subscriptions.data) {
            if (['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) {
              await stripe.subscriptions.cancel(sub.id);
              deletionLog.push(`stripe_subscription_cancelled (${sub.id})`);
            }
          }
          hasMore = subscriptions.has_more;
          if (subscriptions.data.length > 0) {
            startingAfter = subscriptions.data[subscriptions.data.length - 1].id;
          }
        }
        await stripe.customers.del(visitor.stripeCustomerId);
        stripeDeleted = true;
        deletionLog.push('stripe_customer');
      } catch (stripeError: any) {
        console.error(`[Visitors] Failed to delete Stripe customer ${visitor.stripeCustomerId}:`, stripeError.message);
      }
    }
    
    let hubspotArchived = false;
    if (deleteFromHubSpot === 'true' && visitor.hubspotId) {
      try {
        const { getHubSpotClient } = await import('../../core/integrations');
        const hubspot = await getHubSpotClient();
        await hubspot.crm.contacts.basicApi.archive(visitor.hubspotId);
        hubspotArchived = true;
        deletionLog.push('hubspot_contact (archived)');
      } catch (hubspotError: any) {
        console.error(`[Visitors] Failed to archive HubSpot contact ${visitor.hubspotId}:`, hubspotError.message);
      }
    }
    
    await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    deletionLog.push('users');
    
    await logFromRequest(req, {
      action: 'delete_visitor',
      resourceType: 'user',
      resourceId: id,
      resourceName: visitorName,
      details: {
        email: visitor.email,
        deletedRecords: deletionLog,
        stripeDeleted,
        hubspotArchived,
        deletedBy: sessionUser?.email
      }
    });
    
    console.log(`[Visitors] Visitor permanently deleted: ${visitor.email} (${visitorName}) by ${sessionUser?.email}. Records: ${deletionLog.join(', ')}`);
    
    res.json({ 
      success: true, 
      deleted: true,
      deletedBy: sessionUser?.email,
      deletedRecords: deletionLog,
      stripeDeleted,
      hubspotArchived,
      message: `Visitor ${visitorName || visitor.email} permanently deleted`
    });
  } catch (error: any) {
    console.error('[Visitors] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete visitor' });
  }
});

export default router;
