import { Router, Request } from 'express';
import { sql, and } from 'drizzle-orm';
import { db } from '../../db';
import { users, staffUsers } from '../../../shared/schema';
import { bookingParticipants, bookingSessions, resources, guests } from '../../../shared/models/scheduling';
import { isStaffOrAdmin, isAuthenticated } from '../../core/middleware';
import { logger } from '../../core/logger';
import { getSessionUser } from '../../types/session';
import { redactEmail } from './helpers';
import { getCached, setCache } from '../../core/queryCache';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';

const DIRECTORY_CACHE_KEY = 'members_directory';
const DIRECTORY_CACHE_TTL = 30_000;

const router = Router();

const memberSearchSchema = z.object({
  query: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  excludeId: z.string().optional(),
  includeFormer: z.enum(['true', 'false']).optional(),
  includeVisitors: z.enum(['true', 'false']).optional(),
}).passthrough();

router.get('/api/members/search', isAuthenticated, validateQuery(memberSearchSchema), async (req, res) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof memberSearchSchema> }).validatedQuery;
    const { query, limit = '10', excludeId, includeFormer = 'false', includeVisitors = 'false' } = vq;
    
    if (!query || query.trim().length === 0) {
      return res.json([]);
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(limit, 10) || 10, 50);
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
      .orderBy(
        sql`CASE 
          WHEN ${users.membershipStatus} IN ('active', 'trialing', 'past_due') THEN 0
          WHEN ${users.membershipStatus} IN ('expired', 'inactive') THEN 1
          WHEN ${users.membershipStatus} IN ('visitor', 'non-member') THEN 2
          ELSE 3
        END`,
        sql`COALESCE(${users.firstName}, ${users.email}) ASC`
      )
      .limit(maxResults);
    
    const sessionUser = getSessionUser(req);
    const isStaffUser = sessionUser?.isStaff || sessionUser?.role === 'admin' || sessionUser?.role === 'staff';
    
    // Check staff_users table to detect instructors and staff members
    const resultEmails = results.map(r => r.email?.toLowerCase()).filter((e): e is string => !!e);
    const staffInfoMap: Map<string, { role: string; isActive: boolean }> = new Map();
    
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
  } catch (error: unknown) {
    logger.error('Member search error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to search members' });
  }
});

const directoryQuerySchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/members/directory', isStaffOrAdmin, validateQuery(directoryQuerySchema), async (req, res) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof directoryQuerySchema> }).validatedQuery;
    const statusFilter = vq.status?.toLowerCase() || 'active';
    const searchQuery = vq.search?.toLowerCase().trim() || '';
    
    const pageParam = parseInt(vq.page || '', 10);
    const limitParam = parseInt(vq.limit || '', 10);
    const isPaginated = !isNaN(pageParam) || !isNaN(limitParam);
    const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
    const limit = isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);
    
    if (!searchQuery && !isPaginated) {
      const cacheKey = `${DIRECTORY_CACHE_KEY}_${statusFilter}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cached = getCached<any>(cacheKey);
      if (cached) return res.json(cached);
    }

    let statusCondition = sql`1=1`;
    if (statusFilter === 'active') {
      statusCondition = sql`(
        LOWER(${users.membershipStatus}) IN ('active', 'trialing', 'past_due', 'pending')
        OR ${users.membershipStatus} IS NULL
        OR (${users.stripeSubscriptionId} IS NOT NULL AND LOWER(${users.membershipStatus}) = 'non-member')
      )`;
    } else if (statusFilter === 'former') {
      statusCondition = sql`LOWER(${users.membershipStatus}) IN ('inactive', 'cancelled', 'expired', 'terminated', 'former_member', 'churned', 'suspended', 'frozen', 'declined')`;
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
    const baseQuery = db.select({
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
      lastTier: users.lastTier,
      manuallyLinkedEmails: users.manuallyLinkedEmails,
      dataSource: users.dataSource,
      billingProvider: users.billingProvider,
      stripeCurrentPeriodEnd: users.stripeCurrentPeriodEnd,
      firstLoginAt: users.firstLoginAt,
      billingGroupId: users.billingGroupId,
      discountCode: users.discountCode,
    })
      .from(users)
      .where(whereClause)
      .orderBy(sql`COALESCE(${users.firstName}, ${users.email}) ASC`);

    const allMembers = isPaginated
      ? await baseQuery.limit(limit).offset(offset)
      : await baseQuery;
    
    const memberEmails = allMembers.map(m => m.email?.toLowerCase()).filter(Boolean) as string[];
    
    const bookingCounts: Record<string, number> = {};
    const eventCounts: Record<string, number> = {};
    const wellnessCounts: Record<string, number> = {};
    const lastActivityMap: Record<string, string | null> = {};
    
    const walkInCounts: Record<string, number> = {};

    if (memberEmails.length > 0) {
      const [combinedBookingsActivityResult, eventsResult, wellnessResult, walkInCountResult] = await Promise.all([
        db.execute(sql`
          SELECT email, COUNT(DISTINCT booking_id) as booking_count, MAX(last_date) as last_date FROM (
            SELECT LOWER(user_email) as email, id as booking_id, request_date as last_date
            FROM booking_requests
            WHERE LOWER(user_email) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
              AND status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
              AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
            UNION ALL
            SELECT LOWER(u_bp.email) as email, br.id as booking_id, br.request_date as last_date
            FROM booking_participants bp
            JOIN booking_sessions bs ON bp.session_id = bs.id
            JOIN booking_requests br ON br.session_id = bs.id
            LEFT JOIN users u_bp ON bp.user_id = u_bp.id
            WHERE bp.participant_type = 'guest'
              AND LOWER(COALESCE(u_bp.email, '')) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
              AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
              AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
            UNION ALL
            SELECT LOWER(u_bp2.email) as email, br.id as booking_id, br.request_date as last_date
            FROM booking_participants bp2
            JOIN booking_sessions bs2 ON bp2.session_id = bs2.id
            JOIN booking_requests br ON br.session_id = bs2.id
            JOIN users u_bp2 ON bp2.user_id = u_bp2.id
            WHERE bp2.participant_type = 'member'
              AND LOWER(u_bp2.email) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
              AND LOWER(u_bp2.email) != LOWER(br.user_email)
              AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
              AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
            UNION ALL
            SELECT LOWER(er.user_email) as email, NULL::int as booking_id, e.event_date as last_date
            FROM event_rsvps er
            JOIN events e ON er.event_id = e.id
            WHERE LOWER(er.user_email) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
              AND er.status != 'cancelled'
              AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
            UNION ALL
            SELECT LOWER(we.user_email) as email, NULL::int as booking_id, wc.date as last_date
            FROM wellness_enrollments we
            JOIN wellness_classes wc ON we.class_id = wc.id
            WHERE LOWER(we.user_email) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
              AND we.status != 'cancelled'
              AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          ) combined
          GROUP BY email
        `).catch((error: unknown) => {
          logger.error('[Members Directory] Combined bookings/activity query error', { error: error instanceof Error ? error : new Error(String(error)) });
          return { rows: [] };
        }),
        db.execute(sql`
          SELECT LOWER(user_email) as email, COUNT(*) as count
          FROM event_rsvps er
          JOIN events e ON er.event_id = e.id
          WHERE LOWER(er.user_email) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
            AND er.status != 'cancelled'
            AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          GROUP BY LOWER(user_email)
        `).catch((error: unknown) => {
          logger.error('[Members Directory] Events query error', { error: error instanceof Error ? error : new Error(String(error)) });
          return { rows: [] };
        }),
        db.execute(sql`
          SELECT LOWER(we.user_email) as email, COUNT(*) as count
          FROM wellness_enrollments we
          JOIN wellness_classes wc ON we.class_id = wc.id
          WHERE LOWER(we.user_email) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
            AND we.status != 'cancelled'
            AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          GROUP BY LOWER(we.user_email)
        `).catch((error: unknown) => {
          logger.error('[Members Directory] Wellness query error', { error: error instanceof Error ? error : new Error(String(error)) });
          return { rows: [] };
        }),
        db.execute(sql`
          SELECT LOWER(member_email) as email, COUNT(*)::int as count
          FROM walk_in_visits
          WHERE LOWER(member_email) IN (${sql.join(memberEmails.map(e => sql`${e}`), sql`, `)})
          GROUP BY LOWER(member_email)
        `).catch((error: unknown) => {
          logger.error('[Members Directory] Walk-in count query error', { error: error instanceof Error ? error : new Error(String(error)) });
          return { rows: [] };
        }),
      ]);

      for (const row of combinedBookingsActivityResult.rows || []) {
        const r = row as { email: string; booking_count: number | string; last_date: Date | string | null };
        bookingCounts[r.email] = Number(r.booking_count);
        if (r.last_date) {
          const dateVal = r.last_date instanceof Date 
            ? r.last_date.toISOString().split('T')[0]
            : String(r.last_date).split('T')[0];
          lastActivityMap[r.email] = dateVal;
        }
      }

      for (const row of eventsResult.rows || []) {
        const r = row as { email: string; count: number | string };
        eventCounts[r.email] = Number(r.count);
      }

      for (const row of wellnessResult.rows || []) {
        const r = row as { email: string; count: number | string };
        wellnessCounts[r.email] = Number(r.count);
      }

      for (const row of walkInCountResult.rows || []) {
        const r = row as { email: string; count: number };
        walkInCounts[r.email] = r.count;
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
      const isActive = activeStatuses.includes(status.toLowerCase()) || !status || !!member.stripeCustomerId;
      
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
        lifetimeVisits: bookings + events + wellness + (walkInCounts[emailLower] || 0),
        joinDate: member.joinDate,
        lastBookingDate: lastActivityMap[emailLower] || null,
        mindbodyClientId: member.mindbodyClientId,
        stripeCustomerId: member.stripeCustomerId,
        manuallyLinkedEmails: member.manuallyLinkedEmails || [],
        dataSource: member.dataSource,
        membershipStatus: member.membershipStatus || null,
        lastTier: member.lastTier || null,
        billingProvider: member.billingProvider,
        nextPaymentDate: member.stripeCurrentPeriodEnd || null,
        firstLoginAt: member.firstLoginAt || null,
        billingGroupId: member.billingGroupId || null,
        discountCode: member.discountCode || null,
      };
    });
    
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    
    if (isPaginated) {
      const totalPages = Math.ceil(total / limit);
      const paginatedResponse = {
        contacts,
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
        count: contacts.length,
        stale: false,
        refreshing: false,
      };
      if (!searchQuery && !isPaginated) {
        setCache(`${DIRECTORY_CACHE_KEY}_${statusFilter}`, paginatedResponse, DIRECTORY_CACHE_TTL);
      }
      return res.json(paginatedResponse);
    }
    
    const response = {
      contacts,
      count: contacts.length,
      stale: false,
      refreshing: false,
    };
    if (!searchQuery && !isPaginated) {
      setCache(`${DIRECTORY_CACHE_KEY}_${statusFilter}`, response, DIRECTORY_CACHE_TTL);
    }
    return res.json(response);
  } catch (error: unknown) {
    logger.error('[Members Directory] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch members directory' });
  }
});

const guestSearchSchema = z.object({
  query: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  includeFullEmail: z.enum(['true', 'false']).optional(),
}).passthrough();

router.get('/api/guests/search', isAuthenticated, validateQuery(guestSearchSchema), async (req, res) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof guestSearchSchema> }).validatedQuery;
    
    if (!vq.query || vq.query.trim().length < 2) {
      return res.json([]);
    }
    
    const searchTerm = `%${vq.query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(vq.limit || '10', 10) || 10, 30);
    
    const sessionUser = getSessionUser(req);
    const isStaff = sessionUser?.role === 'admin' || sessionUser?.role === 'staff';
    const showFullEmail = isStaff && vq.includeFullEmail === 'true';
    
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
  } catch (error: unknown) {
    logger.error('Guest search error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to search guests' });
  }
});

router.get('/api/members/frequent-partners', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = sessionUser.id;
    const userEmail = sessionUser.email?.toLowerCase();
    const isStaff = sessionUser.isStaff || sessionUser.role === 'admin' || sessionUser.role === 'staff';

    const memberPartners = await db.execute(sql`
      WITH my_sessions AS (
        SELECT DISTINCT bp.session_id
        FROM booking_participants bp
        JOIN booking_sessions bs ON bp.session_id = bs.id
        JOIN resources r ON bs.resource_id = r.id
        JOIN booking_requests br ON br.session_id = bs.id
        WHERE bp.user_id = ${userId}
          AND r.type = 'simulator'
          AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
          AND br.is_event = false
      )
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.tier,
        u.membership_status,
        COUNT(*)::int AS frequency,
        'member' AS partner_type
      FROM booking_participants bp
      JOIN my_sessions ms ON bp.session_id = ms.session_id
      JOIN users u ON bp.user_id = u.id
      WHERE bp.user_id != ${userId}
        AND bp.participant_type IN ('member', 'owner')
        AND u.archived_at IS NULL
        AND (u.membership_status IN ('active', 'trialing', 'past_due') OR u.stripe_subscription_id IS NOT NULL)
        AND (u.tags IS NULL OR NOT (u.tags @> '["directory_hidden"]'::jsonb))
        AND (u.do_not_sell_my_info IS NULL OR u.do_not_sell_my_info = false)
      GROUP BY u.id, u.first_name, u.last_name, u.email, u.tier, u.membership_status
      ORDER BY frequency DESC
      LIMIT 10
    `);

    const createdByValue = userEmail || userId;
    const guestPartners = await db.execute(sql`
      SELECT
        g.id,
        g.name,
        g.email,
        COUNT(*)::int AS frequency,
        'guest' AS partner_type
      FROM booking_participants bp
      JOIN booking_sessions bs ON bp.session_id = bs.id
      JOIN resources r ON bs.resource_id = r.id
      JOIN booking_requests br ON br.session_id = bs.id
      JOIN guests g ON bp.guest_id = g.id
      WHERE g.created_by_member_id = ${createdByValue}
        AND r.type = 'simulator'
        AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending', 'deleted')
        AND br.is_event = false
        AND g.name IS NOT NULL
        AND g.email IS NOT NULL
      GROUP BY g.id, g.name, g.email
      ORDER BY frequency DESC
      LIMIT 10
    `);

    type MemberRow = { id: string; first_name: string | null; last_name: string | null; email: string | null; tier: string | null; membership_status: string | null; frequency: number; partner_type: string };
    type GuestRow = { id: number; name: string; email: string | null; frequency: number; partner_type: string };

    const members = (memberPartners.rows as MemberRow[]).map(r => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown',
      email: isStaff ? r.email : undefined,
      emailRedacted: redactEmail(r.email || ''),
      tier: r.tier || undefined,
      type: 'member' as const,
      frequency: r.frequency,
    }));

    const guestResults = (guestPartners.rows as GuestRow[]).map(r => {
      const parts = r.name.split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      return {
        id: `guest-${r.id}`,
        name: r.name,
        firstName,
        lastName,
        email: r.email || '',
        emailRedacted: redactEmail(r.email || ''),
        type: 'guest' as const,
        frequency: r.frequency,
      };
    });

    const combined = [...members, ...guestResults]
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10);

    res.json(combined);
  } catch (error: unknown) {
    logger.error('Frequent partners error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch frequent partners' });
  }
});

export default router;
