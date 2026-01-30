import { Router } from 'express';
import { sql, and, or, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { users, staffUsers } from '../../../shared/schema';
import { isProduction, pool } from '../../core/db';
import { isStaffOrAdmin, isAuthenticated } from '../../core/middleware';
import { redactEmail } from './helpers';

const router = Router();

router.get('/api/members/search', isAuthenticated, async (req, res) => {
  try {
    const { query, limit = '10', excludeId, includeFormer = 'false', includeVisitors = 'false' } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.json([]);
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(limit as string) || 10, 50);
    const shouldIncludeFormer = includeFormer === 'true';
    const shouldIncludeVisitors = includeVisitors === 'true';
    
    let whereConditions = and(
      sql`${users.archivedAt} IS NULL`,
      // Exclude directory_hidden users (auto-generated visitors, etc.)
      sql`(${users.tags} IS NULL OR NOT (${users.tags} @> '["directory_hidden"]'::jsonb))`,
      sql`(
        LOWER(COALESCE(${users.firstName}, '') || ' ' || COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.firstName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.email}, '')) LIKE ${searchTerm}
      )`
    );
    
    // Include trialing and past_due as active - they still have membership access
    if (shouldIncludeFormer && shouldIncludeVisitors) {
      whereConditions = and(
        whereConditions,
        sql`(${users.membershipStatus} IN ('active', 'trialing', 'past_due', 'expired', 'inactive', 'visitor', 'non-member') OR ${users.stripeSubscriptionId} IS NOT NULL)`
      );
    } else if (shouldIncludeFormer) {
      whereConditions = and(
        whereConditions,
        sql`(${users.membershipStatus} IN ('active', 'trialing', 'past_due', 'expired', 'inactive') OR ${users.stripeSubscriptionId} IS NOT NULL)`
      );
    } else if (shouldIncludeVisitors) {
      whereConditions = and(
        whereConditions,
        sql`(${users.membershipStatus} IN ('active', 'trialing', 'past_due', 'visitor', 'non-member') OR ${users.stripeSubscriptionId} IS NOT NULL)`
      );
    } else {
      whereConditions = and(
        whereConditions,
        sql`(${users.membershipStatus} IN ('active', 'trialing', 'past_due') OR ${users.stripeSubscriptionId} IS NOT NULL)`
      );
    }
    
    if (excludeId && typeof excludeId === 'string') {
      whereConditions = and(
        whereConditions,
        sql`${users.id} != ${excludeId}`
      );
    }
    
    const results = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      tier: users.tier,
      membershipStatus: users.membershipStatus,
    })
      .from(users)
      .where(whereConditions)
      .limit(maxResults);
    
    const sessionUser = (req as any).session?.user;
    const isStaffUser = sessionUser?.isStaff || sessionUser?.role === 'admin' || sessionUser?.role === 'staff';
    
    // Check staff_users table to detect instructors and staff members
    const resultEmails = results.map(r => r.email?.toLowerCase()).filter((e): e is string => !!e);
    let staffInfoMap: Map<string, { role: string; isActive: boolean }> = new Map();
    
    if (resultEmails.length > 0) {
      // Use inArray for proper array matching
      const staffInfo = await db.select({
        email: staffUsers.email,
        role: staffUsers.role,
        isActive: staffUsers.isActive
      })
        .from(staffUsers)
        .where(sql`LOWER(${staffUsers.email}) = ANY(ARRAY[${sql.join(resultEmails.map(e => sql`${e}`), sql`, `)}]::text[])`);
      
      for (const staff of staffInfo) {
        if (staff.email) {
          staffInfoMap.set(staff.email.toLowerCase(), {
            role: staff.role || 'staff',
            isActive: staff.isActive ?? true
          });
        }
      }
    }
    
    const formattedResults = results.map(user => {
      const emailLower = user.email?.toLowerCase() || '';
      const staffInfo = staffInfoMap.get(emailLower);
      const isActiveStaff = staffInfo && staffInfo.isActive;
      const isInstructor = isActiveStaff && staffInfo.role === 'golf_instructor';
      const isStaff = isActiveStaff && !!staffInfo;
      
      // Determine userType based on role hierarchy
      let userType: 'instructor' | 'staff' | 'member' | 'visitor' = 'member';
      if (isInstructor) {
        userType = 'instructor';
      } else if (isStaff) {
        userType = 'staff';
      } else if (user.membershipStatus === 'visitor' || user.membershipStatus === 'non-member') {
        userType = 'visitor';
      }
      
      return {
        id: user.id,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown',
        email: isStaffUser ? user.email : undefined,
        emailRedacted: redactEmail(user.email || ''),
        tier: user.tier || undefined,
        membershipStatus: user.membershipStatus || undefined,
        isInstructor,
        isStaff,
        userType,
        staffRole: isActiveStaff ? staffInfo.role : undefined,
      };
    });
    
    res.json(formattedResults);
  } catch (error: any) {
    if (!isProduction) console.error('Member search error:', error);
    res.status(500).json({ error: 'Failed to search members' });
  }
});

router.get('/api/members/directory', isStaffOrAdmin, async (req, res) => {
  try {
    const statusFilter = (req.query.status as string)?.toLowerCase() || 'active';
    const searchQuery = (req.query.search as string)?.toLowerCase().trim() || '';
    
    const pageParam = parseInt(req.query.page as string, 10);
    const limitParam = parseInt(req.query.limit as string, 10);
    const isPaginated = !isNaN(pageParam) || !isNaN(limitParam);
    const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
    const limit = isNaN(limitParam) ? 500 : Math.min(Math.max(limitParam, 1), 500);
    
    let statusCondition = sql`1=1`;
    if (statusFilter === 'active') {
      // Include trialing and past_due as active - they still have membership access
      statusCondition = sql`(
        ${users.membershipStatus} IN ('active', 'trialing', 'past_due')
        OR ${users.membershipStatus} IS NULL
        OR (${users.stripeSubscriptionId} IS NOT NULL AND (${users.membershipStatus} = 'non-member' OR ${users.membershipStatus} = 'pending'))
      )`;
    } else if (statusFilter === 'former') {
      // past_due is NOT former - they're still active with a payment issue
      statusCondition = sql`${users.membershipStatus} IN ('inactive', 'cancelled', 'expired', 'terminated', 'former_member', 'churned', 'suspended', 'frozen', 'declined')`;
    }
    
    let searchCondition = sql`1=1`;
    if (searchQuery) {
      const searchWords = searchQuery.split(/\s+/).filter(Boolean);
      const searchConditions = searchWords.map(word => {
        const pattern = `%${word}%`;
        return sql`(
          LOWER(COALESCE(${users.firstName}, '')) LIKE ${pattern}
          OR LOWER(COALESCE(${users.lastName}, '')) LIKE ${pattern}
          OR LOWER(COALESCE(${users.email}, '')) LIKE ${pattern}
        )`;
      });
      searchCondition = and(...searchConditions)!;
    }
    
    const whereClause = and(
      statusCondition,
      searchCondition,
      sql`${users.archivedAt} IS NULL`,
      sql`${users.role} != 'staff'`,
      // Exclude auto-generated visitors (GolfNow, ClassPass, etc.) from directory
      sql`(${users.tags} IS NULL OR NOT (${users.tags} @> '["directory_hidden"]'::jsonb))`
    );
    
    const countResult = await db.select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .where(whereClause);
    const total = Number(countResult[0]?.count || 0);
    
    const offset = (page - 1) * limit;
    const allMembers = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      tier: users.tier,
      tags: users.tags,
      phone: users.phone,
      membershipStatus: users.membershipStatus,
      joinDate: sql<string>`COALESCE(${users.joinDate}::date, ${users.createdAt}::date)`.as('join_date'),
      hubspotId: users.hubspotId,
      mindbodyClientId: users.mindbodyClientId,
      stripeCustomerId: users.stripeCustomerId,
      manuallyLinkedEmails: users.manuallyLinkedEmails,
      dataSource: users.dataSource,
      billingProvider: users.billingProvider,
    })
      .from(users)
      .where(whereClause)
      .orderBy(sql`COALESCE(${users.firstName}, ${users.email}) ASC`)
      .limit(limit)
      .offset(offset);
    
    const memberEmails = allMembers.map(m => m.email?.toLowerCase()).filter(Boolean) as string[];
    
    let bookingCounts: Record<string, number> = {};
    let eventCounts: Record<string, number> = {};
    let wellnessCounts: Record<string, number> = {};
    let lastActivityMap: Record<string, string | null> = {};
    
    if (memberEmails.length > 0) {
      const bookingsResult = await pool.query(
        `SELECT email, COUNT(DISTINCT booking_id) as count FROM (
          SELECT LOWER(user_email) as email, id as booking_id
          FROM booking_requests
          WHERE LOWER(user_email) = ANY($1)
            AND status NOT IN ('cancelled', 'declined')
            AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          UNION
          SELECT LOWER(bg.guest_email) as email, br.id as booking_id
          FROM booking_guests bg
          JOIN booking_requests br ON bg.booking_id = br.id
          WHERE LOWER(bg.guest_email) = ANY($1)
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          UNION
          SELECT LOWER(bm.user_email) as email, br.id as booking_id
          FROM booking_members bm
          JOIN booking_requests br ON bm.booking_id = br.id
          WHERE LOWER(bm.user_email) = ANY($1)
            AND bm.is_primary IS NOT TRUE
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
        ) all_bookings
        GROUP BY email`,
        [memberEmails]
      );
      for (const row of bookingsResult.rows || []) {
        bookingCounts[row.email] = Number(row.count);
      }
      
      const eventsResult = await pool.query(
        `SELECT LOWER(user_email) as email, COUNT(*) as count
        FROM event_rsvps er
        JOIN events e ON er.event_id = e.id
        WHERE LOWER(er.user_email) = ANY($1)
          AND er.status != 'cancelled'
          AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
        GROUP BY LOWER(user_email)`,
        [memberEmails]
      );
      for (const row of eventsResult.rows || []) {
        eventCounts[row.email] = Number(row.count);
      }
      
      const wellnessResult = await pool.query(
        `SELECT LOWER(we.user_email) as email, COUNT(*) as count
        FROM wellness_enrollments we
        JOIN wellness_classes wc ON we.class_id = wc.id
        WHERE LOWER(we.user_email) = ANY($1)
          AND we.status != 'cancelled'
          AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
        GROUP BY LOWER(we.user_email)`,
        [memberEmails]
      );
      for (const row of wellnessResult.rows || []) {
        wellnessCounts[row.email] = Number(row.count);
      }
      
      const lastActivityResult = await pool.query(
        `SELECT email, MAX(last_date) as last_date FROM (
          SELECT LOWER(user_email) as email, MAX(request_date) as last_date
          FROM booking_requests
          WHERE LOWER(user_email) = ANY($1) 
            AND status NOT IN ('cancelled', 'declined')
            AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          GROUP BY LOWER(user_email)
          UNION ALL
          SELECT LOWER(bg.guest_email) as email, MAX(br.request_date) as last_date
          FROM booking_guests bg
          JOIN booking_requests br ON bg.booking_id = br.id
          WHERE LOWER(bg.guest_email) = ANY($1) 
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          GROUP BY LOWER(bg.guest_email)
          UNION ALL
          SELECT LOWER(bm.user_email) as email, MAX(br.request_date) as last_date
          FROM booking_members bm
          JOIN booking_requests br ON bm.booking_id = br.id
          WHERE LOWER(bm.user_email) = ANY($1) 
            AND bm.is_primary IS NOT TRUE 
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          GROUP BY LOWER(bm.user_email)
          UNION ALL
          SELECT LOWER(er.user_email) as email, MAX(e.event_date) as last_date
          FROM event_rsvps er
          JOIN events e ON er.event_id = e.id
          WHERE LOWER(er.user_email) = ANY($1) 
            AND er.status != 'cancelled'
            AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          GROUP BY LOWER(er.user_email)
          UNION ALL
          SELECT LOWER(we.user_email) as email, MAX(wc.date) as last_date
          FROM wellness_enrollments we
          JOIN wellness_classes wc ON we.class_id = wc.id
          WHERE LOWER(we.user_email) = ANY($1) 
            AND we.status != 'cancelled'
            AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          GROUP BY LOWER(we.user_email)
        ) combined
        GROUP BY email`,
        [memberEmails]
      );
      for (const row of lastActivityResult.rows || []) {
        if (row.last_date) {
          const dateVal = row.last_date instanceof Date 
            ? row.last_date.toISOString().split('T')[0]
            : String(row.last_date).split('T')[0];
          lastActivityMap[row.email] = dateVal;
        }
      }
    }
    
    const contacts = allMembers.map(member => {
      const emailLower = member.email?.toLowerCase() || '';
      const bookings = bookingCounts[emailLower] || 0;
      const events = eventCounts[emailLower] || 0;
      const wellness = wellnessCounts[emailLower] || 0;
      const status = member.membershipStatus || 'active';
      // Consider all active statuses, including trialing and past_due (still has access)
      // Also consider active if they have a Stripe subscription
      const activeStatuses = ['active', 'trialing', 'past_due'];
      const isActive = activeStatuses.includes(status.toLowerCase()) || !status || !!member.stripeSubscriptionId;
      
      return {
        id: member.id,
        hubspotId: member.hubspotId,
        firstName: member.firstName,
        lastName: member.lastName,
        email: member.email,
        phone: member.phone,
        tier: member.tier,
        rawTier: member.tier,
        tags: member.tags || [],
        status: isActive ? 'Active' : status,
        isActiveMember: isActive,
        isFormerMember: !isActive,
        lifetimeVisits: bookings + events + wellness,
        joinDate: member.joinDate,
        lastBookingDate: lastActivityMap[emailLower] || null,
        mindbodyClientId: member.mindbodyClientId,
        stripeCustomerId: member.stripeCustomerId,
        manuallyLinkedEmails: member.manuallyLinkedEmails || [],
        dataSource: member.dataSource,
        billingProvider: member.billingProvider,
      };
    });
    
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    
    if (isPaginated) {
      const totalPages = Math.ceil(total / limit);
      return res.json({
        contacts,
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
        count: contacts.length,
        stale: false,
        refreshing: false,
      });
    }
    
    return res.json({
      contacts,
      count: contacts.length,
      stale: false,
      refreshing: false,
    });
  } catch (error: any) {
    console.error('[Members Directory] Error:', error);
    res.status(500).json({ error: 'Failed to fetch members directory' });
  }
});

router.get('/api/guests/search', isAuthenticated, async (req, res) => {
  try {
    const { query, limit = '10', includeFullEmail } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.json([]);
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(limit as string) || 10, 30);
    
    const sessionUser = getSessionUser(req);
    const isStaff = sessionUser?.role === 'admin' || sessionUser?.role === 'staff';
    const showFullEmail = isStaff && includeFullEmail === 'true';
    
    const results = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      visitorType: sql<string>`COALESCE(${users.visitorType}, 'guest')`,
    })
      .from(users)
      .where(and(
        sql`${users.archivedAt} IS NULL`,
        sql`(${users.membershipStatus} IN ('visitor', 'non-member') OR ${users.role} = 'visitor')`,
        sql`(
          LOWER(COALESCE(${users.firstName}, '') || ' ' || COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
          OR LOWER(COALESCE(${users.firstName}, '')) LIKE ${searchTerm}
          OR LOWER(COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
          OR LOWER(COALESCE(${users.email}, '')) LIKE ${searchTerm}
        )`
      ))
      .limit(maxResults);
    
    const formattedResults = results.map(visitor => ({
      id: visitor.id,
      name: [visitor.firstName, visitor.lastName].filter(Boolean).join(' ') || 'Unknown',
      email: showFullEmail ? (visitor.email || '') : undefined,
      emailRedacted: redactEmail(visitor.email || ''),
      visitorType: visitor.visitorType,
    }));
    
    res.json(formattedResults);
  } catch (error: any) {
    if (!isProduction) console.error('Guest search error:', error);
    res.status(500).json({ error: 'Failed to search guests' });
  }
});

export default router;
