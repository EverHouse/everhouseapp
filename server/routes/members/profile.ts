import { Router } from 'express';
import { eq, sql, desc, and, or } from 'drizzle-orm';
import { db } from '../../db';
import { 
  users, 
  bookingRequests, 
  bookingParticipants,
  resources, 
  events, 
  eventRsvps, 
  wellnessClasses, 
  wellnessEnrollments,
  guestPasses,
  guestCheckIns 
} from '../../../shared/schema';
import { isProduction } from '../../core/db';
import { isStaffOrAdmin, isAuthenticated, isAdmin } from '../../core/middleware';
import { syncSmsPreferencesToHubSpot } from '../../core/hubspot/contacts';
import { getSessionUser } from '../../types/session';
import { logSystemAction, logFromRequest } from '../../core/auditLog';
import { logger } from '../../core/logger';
import { memberLookupRateLimiter } from '../../middleware/rateLimiting';
import { z } from 'zod';

const router = Router();

const emailParamSchema = z.string().min(1).max(320).transform(val => {
  const decoded = decodeURIComponent(val).trim().toLowerCase();
  return decoded;
}).refine(val => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val), {
  message: 'Invalid email format'
});

const smsPreferencesSchema = z.object({
  smsPromoOptIn: z.boolean().optional(),
  smsTransactionalOptIn: z.boolean().optional(),
  smsRemindersOptIn: z.boolean().optional(),
});

router.get('/api/members/:email/details', isAuthenticated, memberLookupRateLimiter, async (req, res) => {
  try {
    const { email } = req.params;
    
    if (email === 'private-event@resolved' || (email as string).endsWith('@trackman.local') || (email as string).startsWith('unmatched-')) {
      return res.status(200).json({ synthetic: true, email, firstName: 'Private', lastName: 'Event', tier: null, membershipStatus: null });
    }
    
    const parseResult = emailParamSchema.safeParse(email);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const normalizedEmail = parseResult.data;
    
    const sessionUser = getSessionUser(req);
    const requestingUserEmail = sessionUser?.email?.toLowerCase();
    const requestingUserRole = sessionUser?.role;
    
    if (requestingUserEmail !== normalizedEmail && 
        !['staff', 'admin'].includes(requestingUserRole || '')) {
      await logSystemAction({
        action: 'unauthorized_access_attempt',
        resourceType: 'authorization',
        resourceId: normalizedEmail,
        details: {
          endpoint: '/api/members/:email/details',
          requestingUser: requestingUserEmail || 'unknown',
          targetUser: normalizedEmail,
          reason: 'User attempted to access another member\'s profile',
        },
      });
      return res.status(403).json({ error: 'Not authorized to view this profile' });
    }
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      tier: users.tier,
      tags: users.tags,
      role: users.role,
      phone: users.phone,
      mindbodyClientId: users.mindbodyClientId,
      stripeCustomerId: users.stripeCustomerId,
      hubspotId: users.hubspotId,
      membershipStatus: users.membershipStatus,
      billingProvider: users.billingProvider,
      dateOfBirth: users.dateOfBirth,
      streetAddress: users.streetAddress,
      city: users.city,
      state: users.state,
      zipCode: users.zipCode,
      companyName: users.companyName,
      emailOptIn: users.emailOptIn,
      smsOptIn: users.smsOptIn,
      smsPromoOptIn: users.smsPromoOptIn,
      smsTransactionalOptIn: users.smsTransactionalOptIn,
      smsRemindersOptIn: users.smsRemindersOptIn,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const user = userResult[0];
    
    // Run all count queries in parallel for better performance
    const [pastBookingsResult, pastEventsResult, pastWellnessResult, lastActivityResult, walkInResult] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(DISTINCT booking_id) as count FROM (
          SELECT id as booking_id FROM booking_requests
          WHERE LOWER(user_email) = ${normalizedEmail}
            AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
            AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
          UNION
          SELECT br.id as booking_id FROM booking_requests br
          JOIN booking_participants bp ON bp.session_id = br.session_id
          JOIN users u ON bp.user_id = u.id
          WHERE LOWER(u.email) = ${normalizedEmail}
            AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
            AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
        ) all_bookings
      `),
      db.select({ count: sql<number>`COUNT(*)` })
        .from(eventRsvps)
        .innerJoin(events, eq(eventRsvps.eventId, events.id))
        .where(and(
          sql`${events.eventDate} < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date`,
          sql`${eventRsvps.status} != 'cancelled'`,
          or(
            sql`LOWER(${eventRsvps.userEmail}) = ${normalizedEmail}`,
            eq(eventRsvps.matchedUserId, user.id)
          )
        )),
      db.select({ count: sql<number>`COUNT(*)` })
        .from(wellnessEnrollments)
        .innerJoin(wellnessClasses, eq(wellnessEnrollments.classId, wellnessClasses.id))
        .where(and(
          sql`LOWER(${wellnessEnrollments.userEmail}) = ${normalizedEmail}`,
          sql`${wellnessEnrollments.status} != 'cancelled'`,
          sql`${wellnessClasses.date} < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date`
        )),
      db.execute(sql`
        SELECT MAX(last_date) as last_date FROM (
          SELECT MAX(request_date) as last_date FROM booking_requests
          WHERE LOWER(user_email) = ${normalizedEmail} 
            AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
            AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          UNION ALL
          SELECT MAX(br.request_date) as last_date FROM booking_participants bp
          JOIN users u ON bp.user_id = u.id
          JOIN booking_requests br ON bp.session_id = br.session_id
          WHERE LOWER(u.email) = ${normalizedEmail}
            AND bp.participant_type = 'guest'
            AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
            AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          UNION ALL
          SELECT MAX(br.request_date) as last_date FROM booking_participants bp
          JOIN users u ON bp.user_id = u.id
          JOIN booking_requests br ON bp.session_id = br.session_id
          WHERE LOWER(u.email) = ${normalizedEmail} 
            AND bp.participant_type != 'owner'
            AND bp.participant_type != 'guest'
            AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
            AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          UNION ALL
          SELECT MAX(e.event_date) as last_date FROM event_rsvps er
          JOIN events e ON er.event_id = e.id
          WHERE LOWER(er.user_email) = ${normalizedEmail} 
            AND er.status != 'cancelled'
            AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          UNION ALL
          SELECT MAX(wc.date) as last_date FROM wellness_enrollments we
          JOIN wellness_classes wc ON we.class_id = wc.id
          WHERE LOWER(we.user_email) = ${normalizedEmail} 
            AND we.status != 'cancelled'
            AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
        ) combined
      `),
      db.execute(
        sql`SELECT COUNT(*)::int as count FROM walk_in_visits WHERE LOWER(member_email) = ${normalizedEmail}`
      )
    ]);
    
    const pastBookingsCount = Number((pastBookingsResult as { rows?: Record<string, unknown>[] }).rows?.[0]?.count || 0);
    const pastEventsCount = Number(pastEventsResult[0]?.count || 0);
    const pastWellnessCount = Number(pastWellnessResult[0]?.count || 0);
    const walkInCount = (walkInResult as { rows?: Record<string, unknown>[] }).rows?.[0]?.count || 0;
    const totalLifetimeVisits = Number(pastBookingsCount) + pastEventsCount + pastWellnessCount + Number(walkInCount);
    
    const lastBookingDateRaw = (lastActivityResult as { rows?: Record<string, unknown>[] }).rows?.[0]?.last_date;
    const lastBookingDate = lastBookingDateRaw 
      ? (lastBookingDateRaw instanceof Date ? lastBookingDateRaw.toISOString().split('T')[0] : String(lastBookingDateRaw).split('T')[0])
      : null;
    
    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tier: user.tier,
      tags: user.tags || [],
      role: user.role,
      phone: user.phone,
      mindbodyClientId: user.mindbodyClientId,
      stripeCustomerId: user.stripeCustomerId,
      hubspotId: user.hubspotId,
      membershipStatus: user.membershipStatus,
      billingProvider: user.billingProvider,
      lifetimeVisits: totalLifetimeVisits,
      lastBookingDate,
      dateOfBirth: user.dateOfBirth,
      streetAddress: user.streetAddress,
      city: user.city,
      state: user.state,
      zipCode: user.zipCode,
      companyName: user.companyName,
      emailOptIn: user.emailOptIn,
      smsOptIn: user.smsOptIn,
      smsPromoOptIn: user.smsPromoOptIn,
      smsTransactionalOptIn: user.smsTransactionalOptIn,
      smsRemindersOptIn: user.smsRemindersOptIn,
    });
  } catch (error: unknown) {
    logger.error('API error fetching member details', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch member details' });
  }
});

router.put('/api/members/:email/sms-preferences', isAuthenticated, async (req, res) => {
  try {
    const { email } = req.params;
    
    const emailParseResult = emailParamSchema.safeParse(email);
    if (!emailParseResult.success) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const normalizedEmail = emailParseResult.data;
    
    const bodyParseResult = smsPreferencesSchema.safeParse(req.body);
    if (!bodyParseResult.success) {
      return res.status(400).json({ error: 'Invalid preferences format' });
    }
    
    const sessionUser = getSessionUser(req);
    
    if (sessionUser?.email?.toLowerCase() !== normalizedEmail && 
        !['staff', 'admin'].includes(sessionUser?.role || '')) {
      return res.status(403).json({ error: 'Not authorized to update this member\'s preferences' });
    }
    
    const { smsPromoOptIn, smsTransactionalOptIn, smsRemindersOptIn } = bodyParseResult.data;
    
    // Build update object with only provided fields
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof smsPromoOptIn === 'boolean') updateData.smsPromoOptIn = smsPromoOptIn;
    if (typeof smsTransactionalOptIn === 'boolean') updateData.smsTransactionalOptIn = smsTransactionalOptIn;
    if (typeof smsRemindersOptIn === 'boolean') updateData.smsRemindersOptIn = smsRemindersOptIn;
    
    if (Object.keys(updateData).length === 1) {
      return res.status(400).json({ error: 'No valid preference updates provided' });
    }
    
    const result = await db.update(users)
      .set(updateData)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .returning({
        email: users.email,
        smsPromoOptIn: users.smsPromoOptIn,
        smsTransactionalOptIn: users.smsTransactionalOptIn,
        smsRemindersOptIn: users.smsRemindersOptIn
      });
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    // Sync preferences back to HubSpot in the background
    syncSmsPreferencesToHubSpot(normalizedEmail, {
      smsPromoOptIn: result[0].smsPromoOptIn,
      smsTransactionalOptIn: result[0].smsTransactionalOptIn,
      smsRemindersOptIn: result[0].smsRemindersOptIn
    }).catch(err => {
      logger.error('[Profile] Failed to sync SMS preferences to HubSpot', { extra: { email: normalizedEmail, error: err } });
    });
    
    res.json({
      success: true,
      smsPromoOptIn: result[0].smsPromoOptIn,
      smsTransactionalOptIn: result[0].smsTransactionalOptIn,
      smsRemindersOptIn: result[0].smsRemindersOptIn
    });
  } catch (error: unknown) {
    logger.error('SMS preferences update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update SMS preferences' });
  }
});

router.get('/api/members/:email/history', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).trim().toLowerCase();
    
    const bookingHistory = await db.select({
      id: bookingRequests.id,
      resourceId: bookingRequests.resourceId,
      bookingDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      durationMinutes: bookingRequests.durationMinutes,
      status: bookingRequests.status,
      notes: bookingRequests.notes,
      staffNotes: bookingRequests.staffNotes,
      guestCount: bookingRequests.guestCount,
      trackmanPlayerCount: bookingRequests.trackmanPlayerCount,
      createdAt: bookingRequests.createdAt,
      resourceName: resources.name,
      resourceType: resources.type,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
    })
      .from(bookingRequests)
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(or(
        sql`LOWER(${bookingRequests.userEmail}) = ${normalizedEmail}`,
        sql`${bookingRequests.sessionId} IN (SELECT bp.session_id FROM booking_participants bp JOIN users u ON bp.user_id = u.id WHERE LOWER(u.email) = ${normalizedEmail})`
      ))
      .orderBy(desc(bookingRequests.requestDate), desc(bookingRequests.startTime))
      .limit(100);
    
    const bookingIds = bookingHistory.map(b => b.id);
    const historySessionIds = bookingHistory.filter(b => b.sessionId).map(b => b.sessionId!);
    
    type BookingCounts = {
      memberSlotsCount: number;
      additionalMemberCount: number;
      guestCount: number;
      isPrimaryViaMemberSlot: boolean;
    };
    const countsMap = new Map<number, BookingCounts>();
    
    if (historySessionIds.length > 0) {
      const sessionIdsSql = sql.join(historySessionIds.map(id => sql`${id}`), sql`, `);
      const batchCountsResult = await db.execute(sql`
        WITH member_counts AS (
          SELECT 
            bp.session_id,
            COUNT(*)::int as total_slots,
            COUNT(*) FILTER (WHERE bp.user_id IS NOT NULL)::int as filled_slots,
            COUNT(*) FILTER (WHERE bp.user_id IS NOT NULL AND bp.participant_type != 'owner')::int as additional_members,
            BOOL_OR(bp.participant_type = 'owner' AND LOWER(u.email) = ${normalizedEmail}) as is_primary_member
          FROM booking_participants bp
          LEFT JOIN users u ON bp.user_id = u.id
          WHERE bp.session_id = ANY(ARRAY[${sessionIdsSql}]::int[])
            AND bp.participant_type != 'guest'
          GROUP BY bp.session_id
        ),
        guest_counts AS (
          SELECT session_id, COUNT(*)::int as guest_count
          FROM booking_participants
          WHERE session_id = ANY(ARRAY[${sessionIdsSql}]::int[])
            AND participant_type = 'guest'
          GROUP BY session_id
        )
        SELECT 
          COALESCE(mc.session_id, gc.session_id) as session_id,
          COALESCE(mc.total_slots, 0) as member_slots_count,
          COALESCE(mc.additional_members, 0) as additional_member_count,
          COALESCE(gc.guest_count, 0) as guest_count,
          COALESCE(mc.is_primary_member, false) as is_primary_via_member_slot
        FROM member_counts mc
        FULL OUTER JOIN guest_counts gc ON mc.session_id = gc.session_id
      `);
      
      for (const row of (batchCountsResult as { rows?: Record<string, unknown>[] }).rows || []) {
        countsMap.set(row.session_id as number, {
          memberSlotsCount: (row.member_slots_count as number) || 0,
          additionalMemberCount: (row.additional_member_count as number) || 0,
          guestCount: (row.guest_count as number) || 0,
          isPrimaryViaMemberSlot: (row.is_primary_via_member_slot as boolean) || false
        });
      }
    }
    
    // Enrich bookings using the pre-fetched counts (no additional queries)
    const enrichedBookingHistory = bookingHistory.map((booking) => {
      const isPrimaryViaBookingRequest = booking.userEmail?.toLowerCase() === normalizedEmail;
      const counts = (booking.sessionId ? countsMap.get(booking.sessionId) : undefined) || {
        memberSlotsCount: 0,
        additionalMemberCount: 0,
        guestCount: 0,
        isPrimaryViaMemberSlot: false
      };
      
      const isPrimaryBooker = isPrimaryViaBookingRequest || counts.isPrimaryViaMemberSlot;
      const legacyGuestCount = booking.guestCount || 0;
      
      let totalPlayerCount: number;
      const trackmanPlayerCount = booking.trackmanPlayerCount;
      if (trackmanPlayerCount && trackmanPlayerCount > 0) {
        totalPlayerCount = trackmanPlayerCount;
      } else if (counts.memberSlotsCount > 0) {
        totalPlayerCount = counts.memberSlotsCount + counts.guestCount;
      } else {
        totalPlayerCount = Math.max(legacyGuestCount + 1, 1);
      }
      
      const effectiveGuestCount = counts.guestCount > 0 ? counts.guestCount : legacyGuestCount;
      
      return {
        ...booking,
        role: isPrimaryBooker ? 'owner' : 'player',
        primaryBookerName: isPrimaryBooker ? null : (booking.userName || booking.userEmail),
        totalPlayerCount,
        linkedMemberCount: counts.additionalMemberCount,
        actualGuestCount: effectiveGuestCount
      };
    });
    
    const eventRsvpHistory = await db.select({
      id: eventRsvps.id,
      eventId: eventRsvps.eventId,
      status: eventRsvps.status,
      checkedIn: eventRsvps.checkedIn,
      ticketClass: eventRsvps.ticketClass,
      createdAt: eventRsvps.createdAt,
      eventTitle: events.title,
      eventDate: events.eventDate,
      eventLocation: events.location,
      eventCategory: events.category,
    })
      .from(eventRsvps)
      .leftJoin(events, eq(eventRsvps.eventId, events.id))
      .where(sql`LOWER(${eventRsvps.userEmail}) = ${normalizedEmail}`)
      .orderBy(desc(events.eventDate), desc(eventRsvps.createdAt))
      .limit(100);
    
    const wellnessHistory = await db.select({
      id: wellnessEnrollments.id,
      classId: wellnessEnrollments.classId,
      status: wellnessEnrollments.status,
      createdAt: wellnessEnrollments.createdAt,
      classTitle: wellnessClasses.title,
      classDate: wellnessClasses.date,
      classTime: wellnessClasses.time,
      instructor: wellnessClasses.instructor,
      category: wellnessClasses.category,
    })
      .from(wellnessEnrollments)
      .leftJoin(wellnessClasses, eq(wellnessEnrollments.classId, wellnessClasses.id))
      .where(sql`LOWER(${wellnessEnrollments.userEmail}) = ${normalizedEmail}`)
      .orderBy(desc(wellnessClasses.date), desc(wellnessEnrollments.createdAt))
      .limit(100);
    
    const guestPassRaw = await db.select()
      .from(guestPasses)
      .where(sql`LOWER(${guestPasses.memberEmail}) = ${normalizedEmail}`)
      .limit(1);
    
    const guestPassInfo = guestPassRaw[0] ? {
      remainingPasses: guestPassRaw[0].passesTotal - guestPassRaw[0].passesUsed,
      totalUsed: guestPassRaw[0].passesUsed,
      passesTotal: guestPassRaw[0].passesTotal
    } : null;
    
    const guestCheckInsHistory = await db.select()
      .from(guestCheckIns)
      .where(sql`LOWER(${guestCheckIns.memberEmail}) = ${normalizedEmail}`)
      .orderBy(desc(guestCheckIns.checkInDate), desc(guestCheckIns.createdAt))
      .limit(100);
    
    const visitHistory = await db.select({
      id: bookingRequests.id,
      bookingDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      resourceName: resources.name,
      resourceType: resources.type,
      guestCount: bookingRequests.guestCount,
    })
      .from(bookingRequests)
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        or(
          sql`LOWER(${bookingRequests.userEmail}) = ${normalizedEmail}`,
          sql`${bookingRequests.sessionId} IN (SELECT bp.session_id FROM booking_participants bp JOIN users u ON bp.user_id = u.id WHERE LOWER(u.email) = ${normalizedEmail})`
        ),
        or(
          eq(bookingRequests.status, 'attended'),
          and(
            eq(bookingRequests.resourceId, 11),
            eq(bookingRequests.status, 'approved'),
            sql`${bookingRequests.requestDate} < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date`
          )
        )
      ))
      .orderBy(desc(bookingRequests.requestDate))
      .limit(100);
    
    const guestAppearances = await db.select({
      id: bookingRequests.id,
      bookingDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      status: bookingRequests.status,
      resourceName: resources.name,
      resourceType: resources.type,
      hostName: bookingRequests.userName,
      hostEmail: bookingRequests.userEmail,
    })
      .from(bookingRequests)
      .innerJoin(bookingParticipants, eq(bookingRequests.sessionId, bookingParticipants.sessionId))
      .innerJoin(users, eq(bookingParticipants.userId, users.id))
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        sql`LOWER(${users.email}) = ${normalizedEmail}`,
        eq(bookingParticipants.participantType, 'guest')
      ))
      .orderBy(desc(bookingRequests.requestDate));
    
    const walkInResult = await db.execute(sql`
      SELECT id, member_email, checked_in_by_name, created_at
      FROM walk_in_visits
      WHERE LOWER(member_email) = ${normalizedEmail}
      ORDER BY created_at DESC
    `);

    const walkInItems = walkInResult.rows.map((v: Record<string, unknown>) => ({
      id: `walkin-${v.id}`,
      bookingDate: v.created_at,
      startTime: null,
      endTime: null,
      resourceName: 'Walk-in Visit',
      resourceType: 'walk_in',
      guestCount: 0,
      checkedInBy: v.checked_in_by_name,
      isWalkIn: true,
    }));

    const combinedVisitHistory = [...visitHistory, ...walkInItems].sort((a: any, b: any) =>
      new Date(b.bookingDate).getTime() - new Date(a.bookingDate).getTime()
    );

    // Calculate total attended visits including bookings, walk-ins, events, and wellness
    const attendedBookingsCount = visitHistory.length + walkInItems.length;
    const now = new Date();
    const attendedEventsCount = eventRsvpHistory.filter((e) => {
      const eventDate = new Date(e.eventDate);
      return eventDate < now;
    }).length;
    const attendedWellnessCount = wellnessHistory.filter((w) => w.status === 'attended').length;
    const totalAttendedVisits = attendedBookingsCount + attendedEventsCount + attendedWellnessCount;
    
    res.json({
      bookingHistory: enrichedBookingHistory,
      bookingRequestsHistory: [],
      eventRsvpHistory: eventRsvpHistory,
      wellnessHistory: wellnessHistory,
      guestPassInfo: guestPassInfo,
      guestCheckInsHistory: guestCheckInsHistory,
      visitHistory: combinedVisitHistory,
      guestAppearances,
      attendedVisitsCount: totalAttendedVisits
    });
  } catch (error: unknown) {
    logger.error('Member history error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch member history' });
  }
});

router.get('/api/members/:email/guests', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).trim().toLowerCase();
    
    const guestHistory = await db.select({
      id: bookingParticipants.id,
      bookingId: bookingRequests.id,
      guestName: bookingParticipants.displayName,
      guestEmail: sql<string | null>`NULL`,
      slotNumber: sql<number>`0`,
      createdAt: bookingParticipants.createdAt,
      visitDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      resourceName: resources.name,
    })
      .from(bookingParticipants)
      .innerJoin(bookingRequests, eq(bookingParticipants.sessionId, bookingRequests.sessionId))
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        sql`LOWER(${bookingRequests.userEmail}) = ${normalizedEmail}`,
        eq(bookingParticipants.participantType, 'guest')
      ))
      .orderBy(desc(bookingRequests.requestDate), desc(bookingRequests.startTime));
    
    res.json(guestHistory);
  } catch (error: unknown) {
    logger.error('Member guests error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch member guests' });
  }
});

router.put('/api/members/:id/role', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role, tags } = req.body;
    
    if (role && !['member', 'staff', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    if (!role && tags === undefined) {
      return res.status(400).json({ error: 'No updates provided' });
    }
    
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (role) updateData.role = role;
    if (tags !== undefined) updateData.tags = tags;
    
    const result = await db.update(users)
      .set(updateData)
      .where(eq(users.id, id as string))
      .returning();
    
    if (result.length === 0) {
      const insertResult = await db.insert(users)
        .values({
          id: id as string,
          role: role || 'member',
          tags: tags || []
        } as Record<string, unknown>)
        .onConflictDoUpdate({
          target: users.id,
          set: {
            role: role || sql`${users.role}`,
            tags: tags !== undefined ? tags : sql`${users.tags}`,
            updatedAt: new Date()
          }
        })
        .returning();
      logFromRequest(req, 'change_member_role', 'user', req.params.id as any, '', { newRole: req.body.role, tags: req.body.tags });
      return res.json(insertResult[0]);
    }
    
    logFromRequest(req, 'change_member_role', 'user', req.params.id as any, '', { newRole: req.body.role, tags: req.body.tags });
    res.json(result[0]);
  } catch (error: unknown) {
    logger.error('API error updating member', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update member' });
  }
});

router.get('/api/members/:email/cascade-preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).trim().toLowerCase();
    
    const userResult = await db.select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    
    const bookingsResult = await db.execute(sql`
      SELECT COUNT(DISTINCT br.id)::int as count FROM booking_requests br
      LEFT JOIN booking_participants bp ON bp.session_id = br.session_id
      LEFT JOIN users u ON bp.user_id = u.id
      WHERE (
        LOWER(br.user_email) = ${normalizedEmail}
        OR LOWER(u.email) = ${normalizedEmail}
      )
      AND br.archived_at IS NULL
    `);
    const bookingsCount = Number((bookingsResult as { rows?: Record<string, unknown>[] }).rows?.[0]?.count || 0);
    
    const rsvpsResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(eventRsvps)
      .where(or(
        sql`LOWER(${eventRsvps.userEmail}) = ${normalizedEmail}`,
        eq(eventRsvps.matchedUserId, userId)
      ));
    const rsvpsCount = rsvpsResult[0]?.count || 0;
    
    const enrollmentsResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(wellnessEnrollments)
      .where(sql`LOWER(${wellnessEnrollments.userEmail}) = ${normalizedEmail}`);
    const enrollmentsCount = enrollmentsResult[0]?.count || 0;
    
    const guestCheckInsResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(guestCheckIns)
      .where(sql`LOWER(${guestCheckIns.memberEmail}) = ${normalizedEmail}`);
    const guestCheckInsCount = guestCheckInsResult[0]?.count || 0;
    
    res.json({
      memberEmail: normalizedEmail,
      relatedData: {
        bookings: bookingsCount,
        rsvps: rsvpsCount,
        enrollments: enrollmentsCount,
        guestCheckIns: guestCheckInsCount
      },
      hasRelatedData: bookingsCount > 0 || rsvpsCount > 0 || enrollmentsCount > 0 || guestCheckInsCount > 0
    });
  } catch (error: unknown) {
    logger.error('Member cascade preview error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch cascade preview' });
  }
});

export default router;
