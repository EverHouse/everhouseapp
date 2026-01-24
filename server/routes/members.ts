import { Router } from 'express';
import { eq, sql, desc, and, or } from 'drizzle-orm';
import { db } from '../db';
import { 
  users, 
  bookingRequests, 
  eventRsvps, 
  events, 
  wellnessEnrollments, 
  wellnessClasses,
  guestPasses,
  memberNotes,
  communicationLogs,
  guestCheckIns,
  resources,
  bookingGuests,
  bookingMembers,
  dayPassPurchases
} from '../../shared/schema';
import { isProduction, pool } from '../core/db';
import { isStaffOrAdmin, isAuthenticated, isAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';
import { updateHubSpotContactPreferences } from '../core/memberSync';
import { createMemberWithDeal, getAllDiscountRules, handleTierChange } from '../core/hubspotDeals';
import { TIER_NAMES, TIER_HIERARCHY } from '../../shared/constants/tiers';
import { notifyMember } from '../core/notificationService';
import { pauseSubscription, changeSubscriptionTier } from '../core/stripe';
import { membershipTiers } from '../../shared/schema';
import { getResendClient } from '../utils/resend';
import { withResendRetry } from '../core/retryUtils';
import { staffUsers } from '../../shared/schema';
import { previewTierChange, commitTierChange, getAvailableTiersForChange } from '../core/stripe/tierChanges';
import { fetchAllHubSpotContacts } from './hubspot';
import { cascadeEmailChange, previewEmailChangeImpact } from '../core/memberService/emailChangeService';
import { logFromRequest } from '../core/auditLog';
import { getOrCreateStripeCustomer } from '../core/stripe/customers';

const router = Router();

function redactEmail(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [localPart, domain] = email.split('@');
  const prefix = localPart.slice(0, 2);
  return `${prefix}***@${domain}`;
}

function getTierRank(tier: string): number {
  return TIER_HIERARCHY[tier as keyof typeof TIER_HIERARCHY] || 1;
}

router.get('/api/members/search', isAuthenticated, async (req, res) => {
  try {
    const { query, limit = '10', excludeId, includeFormer = 'false' } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.json([]);
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(limit as string) || 10, 50);
    const shouldIncludeFormer = includeFormer === 'true';
    
    // Build base conditions - always require non-archived
    let whereConditions = and(
      sql`${users.archivedAt} IS NULL`,
      sql`(
        LOWER(COALESCE(${users.firstName}, '') || ' ' || COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.firstName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.email}, '')) LIKE ${searchTerm}
      )`
    );
    
    // Only filter to active members unless includeFormer is true
    if (!shouldIncludeFormer) {
      whereConditions = and(
        whereConditions,
        sql`${users.membershipStatus} = 'active'`
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
    
    // Check if requester is staff - if so, include full email for linking functionality
    const sessionUser = (req as any).session?.user;
    const isStaff = sessionUser?.isStaff || sessionUser?.role === 'admin' || sessionUser?.role === 'staff';
    
    const formattedResults = results.map(user => ({
      id: user.id,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown',
      email: isStaff ? user.email : undefined,
      emailRedacted: redactEmail(user.email || ''),
      tier: user.tier || undefined,
      membershipStatus: user.membershipStatus || undefined,
    }));
    
    res.json(formattedResults);
  } catch (error: any) {
    if (!isProduction) console.error('Member search error:', error);
    res.status(500).json({ error: 'Failed to search members' });
  }
});

router.get('/api/members/:email/details', isAuthenticated, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      tier: users.tier,
      tags: users.tags,
      role: users.role,
      phone: users.phone,
      mindbodyClientId: users.mindbodyClientId
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const user = userResult[0];
    
    // Count past bookings where user participated (host, player via booking_members, or guest via booking_guests)
    // Uses UNION to deduplicate across all roles
    const pastBookingsResult = await db.execute(sql`
      SELECT COUNT(DISTINCT booking_id) as count FROM (
        -- Bookings as host
        SELECT id as booking_id FROM booking_requests
        WHERE LOWER(user_email) = ${normalizedEmail}
          AND request_date < CURRENT_DATE
          AND status NOT IN ('cancelled', 'declined')
        UNION
        -- Bookings as added player (via booking_members)
        SELECT br.id as booking_id FROM booking_requests br
        JOIN booking_members bm ON br.id = bm.booking_id
        WHERE LOWER(bm.user_email) = ${normalizedEmail}
          AND br.request_date < CURRENT_DATE
          AND br.status NOT IN ('cancelled', 'declined')
        UNION
        -- Bookings as guest (via booking_guests)
        SELECT br.id as booking_id FROM booking_requests br
        JOIN booking_guests bg ON br.id = bg.booking_id
        WHERE LOWER(bg.guest_email) = ${normalizedEmail}
          AND br.request_date < CURRENT_DATE
          AND br.status NOT IN ('cancelled', 'declined')
      ) all_bookings
    `);
    const pastBookingsCount = Number((pastBookingsResult as any).rows?.[0]?.count || 0);
    
    // Count past event RSVPs (excluding cancelled)
    const pastEventsResult = await db.select({ count: sql<number>`COUNT(*)` })
      .from(eventRsvps)
      .innerJoin(events, eq(eventRsvps.eventId, events.id))
      .where(and(
        sql`${events.eventDate} < CURRENT_DATE`,
        sql`${eventRsvps.status} != 'cancelled'`,
        or(
          sql`LOWER(${eventRsvps.userEmail}) = ${normalizedEmail}`,
          eq(eventRsvps.matchedUserId, user.id)
        )
      ));
    const pastEventsCount = Number(pastEventsResult[0]?.count || 0);
    
    // Count past wellness enrollments (excluding cancelled)
    const pastWellnessResult = await db.select({ count: sql<number>`COUNT(*)` })
      .from(wellnessEnrollments)
      .innerJoin(wellnessClasses, eq(wellnessEnrollments.classId, wellnessClasses.id))
      .where(and(
        sql`LOWER(${wellnessEnrollments.userEmail}) = ${normalizedEmail}`,
        sql`${wellnessEnrollments.status} != 'cancelled'`,
        sql`${wellnessClasses.date} < CURRENT_DATE`
      ));
    const pastWellnessCount = Number(pastWellnessResult[0]?.count || 0);
    
    // Total lifetime visits = past bookings + past event RSVPs + past wellness enrollments
    const totalLifetimeVisits = pastBookingsCount + pastEventsCount + pastWellnessCount;
    
    // Get last activity date from all sources (bookings as host/player/guest, events, wellness)
    // Filter to past dates only to reflect actual visits, not future scheduled items
    const lastActivityResult = await db.execute(sql`
      SELECT MAX(last_date) as last_date FROM (
        -- Bookings as host (past only)
        SELECT MAX(request_date) as last_date FROM booking_requests
        WHERE LOWER(user_email) = ${normalizedEmail} 
          AND status NOT IN ('cancelled', 'declined')
          AND request_date < CURRENT_DATE
        UNION ALL
        -- Bookings as guest (past only)
        SELECT MAX(br.request_date) as last_date FROM booking_guests bg
        JOIN booking_requests br ON bg.booking_id = br.id
        WHERE LOWER(bg.guest_email) = ${normalizedEmail} 
          AND br.status NOT IN ('cancelled', 'declined')
          AND br.request_date < CURRENT_DATE
        UNION ALL
        -- Bookings as added player (past only)
        SELECT MAX(br.request_date) as last_date FROM booking_members bm
        JOIN booking_requests br ON bm.booking_id = br.id
        WHERE LOWER(bm.user_email) = ${normalizedEmail} 
          AND bm.is_primary IS NOT TRUE 
          AND br.status NOT IN ('cancelled', 'declined')
          AND br.request_date < CURRENT_DATE
        UNION ALL
        -- Events (past only)
        SELECT MAX(e.event_date) as last_date FROM event_rsvps er
        JOIN events e ON er.event_id = e.id
        WHERE LOWER(er.user_email) = ${normalizedEmail} 
          AND er.status != 'cancelled'
          AND e.event_date < CURRENT_DATE
        UNION ALL
        -- Wellness (past only)
        SELECT MAX(wc.date) as last_date FROM wellness_enrollments we
        JOIN wellness_classes wc ON we.class_id = wc.id
        WHERE LOWER(we.user_email) = ${normalizedEmail} 
          AND we.status != 'cancelled'
          AND wc.date < CURRENT_DATE
      ) combined
    `);
    const lastBookingDateRaw = (lastActivityResult as any).rows?.[0]?.last_date;
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
      lifetimeVisits: totalLifetimeVisits,
      lastBookingDate
    });
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to fetch member details' });
  }
});

router.get('/api/members/:email/history', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    // Get bookings where member is primary booker OR linked via booking_members
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
        sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_members WHERE LOWER(user_email) = ${normalizedEmail})`
      ))
      .orderBy(desc(bookingRequests.requestDate), desc(bookingRequests.startTime));
    
    // Enrich with role info and player counts
    const enrichedBookingHistory = await Promise.all(bookingHistory.map(async (booking) => {
      // Check if member is the primary booker (either via booking_requests.user_email OR is_primary in booking_members)
      const isPrimaryViaBookingRequest = booking.userEmail?.toLowerCase() === normalizedEmail;
      
      const primaryMemberResult = await db.select({ isPrimary: bookingMembers.isPrimary })
        .from(bookingMembers)
        .where(and(
          eq(bookingMembers.bookingId, booking.id),
          sql`LOWER(${bookingMembers.userEmail}) = ${normalizedEmail}`
        ))
        .limit(1);
      
      const isPrimaryViaMemberSlot = primaryMemberResult[0]?.isPrimary === true;
      const isPrimaryBooker = isPrimaryViaBookingRequest || isPrimaryViaMemberSlot;
      
      // Get total member slots (represents expected member count from Trackman)
      const memberSlotsResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingMembers)
        .where(eq(bookingMembers.bookingId, booking.id));
      
      // Count filled member slots (excluding empty slots)
      const filledMemberResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingMembers)
        .where(and(
          eq(bookingMembers.bookingId, booking.id),
          sql`${bookingMembers.userEmail} IS NOT NULL`
        ));
      
      // Count additional members (non-primary filled slots - includes NULL and false for is_primary)
      const additionalMemberResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingMembers)
        .where(and(
          eq(bookingMembers.bookingId, booking.id),
          sql`${bookingMembers.userEmail} IS NOT NULL`,
          sql`${bookingMembers.isPrimary} IS NOT TRUE`
        ));
      
      // Count actual guests in booking_guests table
      const guestResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingGuests)
        .where(eq(bookingGuests.bookingId, booking.id));
      
      const memberSlotsCount = memberSlotsResult[0]?.count || 0;
      const filledMemberCount = filledMemberResult[0]?.count || 0;
      const additionalMemberCount = additionalMemberResult[0]?.count || 0;
      const actualGuestCount = guestResult[0]?.count || 0;
      const legacyGuestCount = booking.guestCount || 0;
      
      // Total player count: use Trackman's original value if available, else compute from slots
      // Priority: trackman_player_count > member_slots + guests > legacy guest_count + 1
      let totalPlayerCount: number;
      const trackmanPlayerCount = booking.trackmanPlayerCount;
      if (trackmanPlayerCount && trackmanPlayerCount > 0) {
        // Trackman import with stored player count - most authoritative
        totalPlayerCount = trackmanPlayerCount;
      } else if (memberSlotsCount > 0) {
        // Trackman import without stored player count - compute from slots + guests
        totalPlayerCount = memberSlotsCount + actualGuestCount;
      } else {
        // Legacy booking without booking_members - use legacy formula
        totalPlayerCount = Math.max(legacyGuestCount + 1, 1);
      }
      
      // Effective guest count for display (from booking_guests if available, else legacy)
      const effectiveGuestCount = actualGuestCount > 0 ? actualGuestCount : legacyGuestCount;
      
      return {
        ...booking,
        role: isPrimaryBooker ? 'owner' : 'player',
        primaryBookerName: isPrimaryBooker ? null : (booking.userName || booking.userEmail),
        totalPlayerCount,
        linkedMemberCount: additionalMemberCount,
        actualGuestCount: effectiveGuestCount
      };
    }));
    
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
      .orderBy(desc(events.eventDate), desc(eventRsvps.createdAt));
    
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
      .orderBy(desc(wellnessClasses.date), desc(wellnessEnrollments.createdAt));
    
    const guestPassRaw = await db.select()
      .from(guestPasses)
      .where(sql`LOWER(${guestPasses.memberEmail}) = ${normalizedEmail}`)
      .limit(1);
    
    // Transform to expected format for frontend
    const guestPassInfo = guestPassRaw[0] ? {
      remainingPasses: guestPassRaw[0].passesTotal - guestPassRaw[0].passesUsed,
      totalUsed: guestPassRaw[0].passesUsed,
      passesTotal: guestPassRaw[0].passesTotal
    } : null;
    
    const guestCheckInsHistory = await db.select()
      .from(guestCheckIns)
      .where(sql`LOWER(${guestCheckIns.memberEmail}) = ${normalizedEmail}`)
      .orderBy(desc(guestCheckIns.checkInDate), desc(guestCheckIns.createdAt));
    
    // Visit history: include bookings where member is primary OR linked OR was a guest
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
          sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_members WHERE LOWER(user_email) = ${normalizedEmail})`,
          sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_guests WHERE LOWER(guest_email) = ${normalizedEmail})`
        ),
        or(
          eq(bookingRequests.status, 'attended'),
          and(
            eq(bookingRequests.resourceId, 11),
            eq(bookingRequests.status, 'approved'),
            sql`${bookingRequests.requestDate} < CURRENT_DATE`
          )
        )
      ))
      .orderBy(desc(bookingRequests.requestDate));
    
    // Get bookings where user was a guest (non-member on someone else's booking)
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
      .innerJoin(bookingGuests, eq(bookingRequests.id, bookingGuests.bookingId))
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(sql`LOWER(${bookingGuests.guestEmail}) = ${normalizedEmail}`)
      .orderBy(desc(bookingRequests.requestDate));
    
    // Create unified visits list combining all sources with role indicators
    const today = new Date().toISOString().split('T')[0];
    
    // Helper to parse date strings
    const parseDate = (dateValue: string | Date | null): string => {
      if (!dateValue) return '';
      return typeof dateValue === 'string' 
        ? dateValue.split('T')[0] 
        : (dateValue as Date)?.toISOString?.()?.split('T')[0] || '';
    };
    
    // Build a set of booking IDs where user is a guest (from booking_guests)
    const guestBookingIds = new Set(guestAppearances.map(g => g.id));
    
    // Unified visits from bookings (as host or player via booking_members)
    // Filter to past bookings only (attended) and exclude cancelled/declined
    // Also exclude bookings that are in guestAppearances to avoid duplicates
    const bookingVisits = visitHistory
      .filter(v => {
        const dateStr = parseDate(v.bookingDate);
        // Skip if this is a guest booking (will be handled in guestVisits)
        if (guestBookingIds.has(v.id)) return false;
        return dateStr <= today; // visitHistory already filters by attended status in the query
      })
      .map(v => {
        const dateStr = parseDate(v.bookingDate);
        // Determine role: host if they're the primary booker in enrichedBookingHistory
        const enrichedEntry = enrichedBookingHistory.find(b => b.id === v.id);
        const isHost = enrichedEntry?.role === 'owner';
        return {
          type: 'booking' as const,
          role: isHost ? 'Host' : 'Player',
          date: dateStr,
          sortDate: new Date(dateStr + 'T' + (v.startTime || '00:00')).getTime(),
          resourceName: v.resourceName,
          startTime: v.startTime,
          endTime: v.endTime,
          id: v.id,
        };
      });
    
    // Unified visits from guest appearances (booking_guests)
    const guestVisits = guestAppearances
      .filter(g => {
        const dateStr = parseDate(g.bookingDate);
        const status = (g.status || '').toLowerCase();
        return dateStr <= today && status !== 'cancelled' && status !== 'declined';
      })
      .map(g => {
        const dateStr = parseDate(g.bookingDate);
        return {
          type: 'booking' as const,
          role: 'Guest',
          date: dateStr,
          sortDate: new Date(dateStr + 'T' + (g.startTime || '00:00')).getTime(),
          resourceName: g.resourceName,
          startTime: g.startTime,
          endTime: g.endTime,
          id: g.id,
          hostName: g.hostName || g.hostEmail,
        };
      });
    
    // Unified visits from wellness
    const wellnessVisits = wellnessHistory
      .filter(w => {
        const dateStr = parseDate(w.classDate);
        const status = (w.status || '').toLowerCase();
        return dateStr <= today && status !== 'cancelled';
      })
      .map(w => {
        const dateStr = parseDate(w.classDate);
        return {
          type: 'wellness' as const,
          role: 'Wellness',
          date: dateStr,
          sortDate: new Date(dateStr + 'T' + (w.classTime || '00:00')).getTime(),
          resourceName: w.classTitle,
          startTime: w.classTime,
          endTime: null,
          id: w.id,
          instructor: w.instructor,
          category: w.category,
        };
      });
    
    // Unified visits from events
    const eventVisits = eventRsvpHistory
      .filter(e => {
        const dateStr = parseDate(e.eventDate);
        const status = (e.status || '').toLowerCase();
        return dateStr <= today && status !== 'cancelled';
      })
      .map(e => {
        const dateStr = parseDate(e.eventDate);
        return {
          type: 'event' as const,
          role: 'Event',
          date: dateStr,
          sortDate: new Date(dateStr).getTime(),
          resourceName: e.eventTitle,
          startTime: null,
          endTime: null,
          id: e.id,
          location: e.eventLocation,
          category: e.eventCategory,
        };
      });
    
    // Combine and sort all visits by date (most recent first)
    // Deduplicate booking visits (in case same booking appears as both visitHistory and guestAppearances)
    const seenBookingIds = new Set<number>();
    const allBookingVisits = [...bookingVisits, ...guestVisits].filter(v => {
      if (seenBookingIds.has(v.id)) return false;
      seenBookingIds.add(v.id);
      return true;
    });
    
    const unifiedVisits = [...allBookingVisits, ...wellnessVisits, ...eventVisits]
      .sort((a, b) => b.sortDate - a.sortDate);
    
    // Calculate counts from unified visits (past visits only)
    const pastBookingsCount = allBookingVisits.length;
    const pastEventsCount = eventVisits.length;
    const pastWellnessCount = wellnessVisits.length;
    const attendedVisitsCount = unifiedVisits.length;
    
    // Get most recent visit date
    const lastVisitDate = unifiedVisits.length > 0 ? unifiedVisits[0].date : null;
    
    res.json({
      bookingHistory: enrichedBookingHistory,
      bookingRequestsHistory: [],
      eventRsvpHistory,
      wellnessHistory,
      guestPassInfo: guestPassInfo,
      guestCheckInsHistory,
      visitHistory,
      guestAppearances,
      unifiedVisits,
      pastBookingsCount,
      pastEventsCount,
      pastWellnessCount,
      attendedVisitsCount,
      lastVisitDate,
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member history error:', error);
    res.status(500).json({ error: 'Failed to fetch member history' });
  }
});

router.get('/api/members/:email/notes', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const notes = await db.select()
      .from(memberNotes)
      .where(sql`LOWER(${memberNotes.memberEmail}) = ${normalizedEmail}`)
      .orderBy(desc(memberNotes.isPinned), desc(memberNotes.createdAt));
    
    res.json(notes);
  } catch (error: any) {
    if (!isProduction) console.error('Member notes error:', error);
    res.status(500).json({ error: 'Failed to fetch member notes' });
  }
});

router.post('/api/members/:email/notes', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { content, isPinned } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!content?.trim()) {
      return res.status(400).json({ error: 'Note content is required' });
    }
    
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const result = await db.insert(memberNotes)
      .values({
        memberEmail: normalizedEmail,
        content: content.trim(),
        createdBy: sessionUser?.email || 'unknown',
        createdByName: sessionUser?.firstName 
          ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
          : sessionUser?.email?.split('@')[0] || 'Staff',
        isPinned: isPinned || false,
      })
      .returning();
    
    res.status(201).json(result[0]);
  } catch (error: any) {
    if (!isProduction) console.error('Create note error:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

router.put('/api/members/:email/notes/:noteId', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, noteId } = req.params;
    const { content, isPinned } = req.body;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (content !== undefined) updateData.content = content.trim();
    if (isPinned !== undefined) updateData.isPinned = isPinned;
    
    const result = await db.update(memberNotes)
      .set(updateData)
      .where(and(
        eq(memberNotes.id, parseInt(noteId)),
        sql`LOWER(${memberNotes.memberEmail}) = ${normalizedEmail}`
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    res.json(result[0]);
  } catch (error: any) {
    if (!isProduction) console.error('Update note error:', error);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

router.delete('/api/members/:email/notes/:noteId', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, noteId } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const result = await db.delete(memberNotes)
      .where(and(
        eq(memberNotes.id, parseInt(noteId)),
        sql`LOWER(${memberNotes.memberEmail}) = ${normalizedEmail}`
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Note not found for this member' });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Delete note error:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

router.get('/api/members/:email/communications', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const logs = await db.select()
      .from(communicationLogs)
      .where(sql`LOWER(${communicationLogs.memberEmail}) = ${normalizedEmail}`)
      .orderBy(desc(communicationLogs.occurredAt));
    
    res.json(logs);
  } catch (error: any) {
    if (!isProduction) console.error('Communication logs error:', error);
    res.status(500).json({ error: 'Failed to fetch communication logs' });
  }
});

router.post('/api/members/:email/communications', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { type, direction, subject, body, status, occurredAt } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!type) {
      return res.status(400).json({ error: 'Communication type is required' });
    }
    
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const result = await db.insert(communicationLogs)
      .values({
        memberEmail: normalizedEmail,
        type,
        direction: direction || 'outbound',
        subject: subject || null,
        body: body || null,
        status: status || 'sent',
        loggedBy: sessionUser?.email || 'unknown',
        loggedByName: sessionUser?.firstName 
          ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
          : sessionUser?.email?.split('@')[0] || 'Staff',
        occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
      })
      .returning();
    
    res.status(201).json(result[0]);
  } catch (error: any) {
    if (!isProduction) console.error('Create communication log error:', error);
    res.status(500).json({ error: 'Failed to create communication log' });
  }
});

router.delete('/api/members/:email/communications/:logId', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, logId } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const result = await db.delete(communicationLogs)
      .where(and(
        eq(communicationLogs.id, parseInt(logId)),
        sql`LOWER(${communicationLogs.memberEmail}) = ${normalizedEmail}`
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Communication log not found for this member' });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    if (!isProduction) console.error('Delete communication log error:', error);
    res.status(500).json({ error: 'Failed to delete communication log' });
  }
});

router.get('/api/members/:email/guests', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const guestHistory = await db.select({
      id: bookingGuests.id,
      bookingId: bookingGuests.bookingId,
      guestName: bookingGuests.guestName,
      guestEmail: bookingGuests.guestEmail,
      slotNumber: bookingGuests.slotNumber,
      createdAt: bookingGuests.createdAt,
      visitDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      resourceName: resources.name,
    })
      .from(bookingGuests)
      .innerJoin(bookingRequests, eq(bookingGuests.bookingId, bookingRequests.id))
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(sql`LOWER(${bookingRequests.userEmail}) = ${normalizedEmail}`)
      .orderBy(desc(bookingRequests.requestDate), desc(bookingRequests.startTime));
    
    res.json(guestHistory);
  } catch (error: any) {
    if (!isProduction) console.error('Member guests error:', error);
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
    
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (role) updateData.role = role;
    if (tags !== undefined) updateData.tags = tags;
    
    const result = await db.update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning();
    
    if (result.length === 0) {
      const insertResult = await db.insert(users)
        .values({
          id,
          role: role || 'member',
          tags: tags || []
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            role: role || sql`${users.role}`,
            tags: tags !== undefined ? tags : sql`${users.tags}`,
            updatedAt: new Date()
          }
        })
        .returning();
      return res.json(insertResult[0]);
    }
    
    res.json(result[0]);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

router.patch('/api/members/:email/tier', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { tier, immediate = false } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!tier || typeof tier !== 'string') {
      return res.status(400).json({ error: 'Tier is required' });
    }
    
    if (!TIER_NAMES.includes(tier as any)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${TIER_NAMES.join(', ')}` });
    }
    
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      tier: users.tier,
      firstName: users.firstName,
      lastName: users.lastName,
      billingProvider: users.billingProvider,
      stripeSubscriptionId: users.stripeSubscriptionId
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = userResult[0];
    // Use actual DB value for comparison (can be null)
    const actualTier = member.tier;
    // For display/sync purposes, default null to 'Social'
    const oldTierDisplay = actualTier || 'Social';
    
    // Compare against actual DB value, not defaulted value
    // This allows "No Tier" (null) -> "Social" transitions to work
    if (actualTier === tier) {
      return res.json({ 
        success: true, 
        message: 'Member is already on this tier',
        member: { id: member.id, email: member.email, tier }
      });
    }
    
    await db.update(users)
      .set({ tier, updatedAt: new Date() })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    const performedBy = sessionUser?.email || 'unknown';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : sessionUser?.email?.split('@')[0] || 'Staff';
    
    const hubspotResult = await handleTierChange(
      normalizedEmail,
      oldTierDisplay,
      tier,
      performedBy,
      performedByName
    );
    
    if (!hubspotResult.success && hubspotResult.error) {
      console.warn(`[Members] HubSpot tier change failed for ${normalizedEmail}: ${hubspotResult.error}`);
    }
    
    let stripeSync = { success: true, warning: null as string | null };
    
    if (member.billingProvider === 'stripe' && member.stripeSubscriptionId) {
      const tierRecord = await db.select()
        .from(membershipTiers)
        .where(eq(membershipTiers.name, tier))
        .limit(1);
      
      if (tierRecord.length > 0 && tierRecord[0].stripePriceId) {
        const isUpgrade = getTierRank(tier) > getTierRank(oldTierDisplay);
        const stripeResult = await changeSubscriptionTier(
          member.stripeSubscriptionId,
          tierRecord[0].stripePriceId,
          immediate || isUpgrade
        );
        
        if (!stripeResult.success) {
          stripeSync = { success: false, warning: `Stripe update failed: ${stripeResult.error}. Manual billing adjustment may be needed.` };
        }
      } else {
        stripeSync = { success: true, warning: 'Tier updated but Stripe price not configured. Billing unchanged.' };
      }
    } else if (member.billingProvider === 'mindbody') {
      stripeSync = { success: true, warning: 'Tier updated in App & HubSpot. PLEASE UPDATE MINDBODY BILLING MANUALLY.' };
    }
    
    const isUpgrade = getTierRank(tier) > getTierRank(oldTierDisplay);
    const changeType = isUpgrade ? 'upgraded' : 'changed';
    await notifyMember({
      userEmail: normalizedEmail,
      title: isUpgrade ? 'Membership Upgraded' : 'Membership Updated',
      message: `Your membership has been ${changeType} from ${oldTierDisplay} to ${tier}`,
      type: 'system',
      url: '/#/profile'
    });
    
    res.json({
      success: true,
      message: `Member tier updated from ${oldTierDisplay} to ${tier}`,
      member: {
        id: member.id,
        email: member.email,
        tier,
        previousTier: oldTierDisplay
      },
      hubspotSync: {
        success: hubspotResult.success,
        oldLineItemRemoved: hubspotResult.oldLineItemRemoved,
        newLineItemAdded: hubspotResult.newLineItemAdded
      },
      stripeSync,
      warning: stripeSync.warning
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member tier update error:', error);
    res.status(500).json({ error: 'Failed to update member tier' });
  }
});

router.post('/api/members/:id/suspend', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, durationDays, reason } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!startDate || !durationDays) {
      return res.status(400).json({ error: 'startDate and durationDays are required' });
    }
    
    const start = new Date(startDate);
    const now = new Date();
    const daysUntilStart = (start.getTime() - now.getTime()) / (1000 * 3600 * 24);
    
    if (daysUntilStart < 30) {
      return res.status(400).json({ 
        error: 'Suspension requests must be made at least 30 days in advance.' 
      });
    }
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      billingProvider: users.billingProvider,
      stripeSubscriptionId: users.stripeSubscriptionId,
      membershipStatus: users.membershipStatus
    })
      .from(users)
      .where(eq(users.id, id));
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = userResult[0];
    
    if (member.billingProvider === 'mindbody') {
      await db.update(users)
        .set({ membershipStatus: 'suspended', updatedAt: new Date() })
        .where(eq(users.id, id));
      
      return res.json({ 
        success: true, 
        warning: 'Member marked suspended in App/HubSpot. PLEASE PAUSE BILLING IN MINDBODY MANUALLY.',
        member: { id: member.id, email: member.email, status: 'suspended' }
      });
    }
    
    if (member.billingProvider === 'stripe' && member.stripeSubscriptionId) {
      const result = await pauseSubscription(member.stripeSubscriptionId, parseInt(durationDays), start);
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || 'Failed to pause subscription' });
      }
      
      await db.update(users)
        .set({ membershipStatus: 'suspended', updatedAt: new Date() })
        .where(eq(users.id, id));
      
      await notifyMember({
        userEmail: member.email || '',
        title: 'Membership Paused',
        message: `Your membership has been paused for ${durationDays} days starting ${start.toLocaleDateString()}.`,
        type: 'system',
        url: '/#/profile'
      });
      
      return res.json({ 
        success: true, 
        message: `Billing suspended for ${durationDays} days starting ${startDate}`,
        resumeDate: result.resumeDate,
        member: { id: member.id, email: member.email, status: 'suspended' }
      });
    }
    
    return res.status(400).json({ error: 'No active billing found for this member.' });
  } catch (error: any) {
    if (!isProduction) console.error('Member suspend error:', error);
    res.status(500).json({ error: 'Failed to suspend member' });
  }
});

// Update member communication preferences (email/sms opt-in, privacy) - for the logged-in user
// Supports ?user_email param for "View As" feature when staff edits another member's preferences
router.patch('/api/members/me/preferences', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { emailOptIn, smsOptIn, doNotSellMyInfo } = req.body;
    
    if (emailOptIn === undefined && smsOptIn === undefined && doNotSellMyInfo === undefined) {
      return res.status(400).json({ error: 'No preferences provided' });
    }
    
    // Support "View As" feature: staff can pass user_email param to edit another member's preferences
    const requestedEmail = req.query.user_email as string | undefined;
    let targetEmail = sessionUser.email;
    
    if (requestedEmail && requestedEmail.toLowerCase() !== sessionUser.email.toLowerCase()) {
      // Only staff/admin can edit other members' preferences
      if (sessionUser.role === 'admin' || sessionUser.role === 'staff') {
        targetEmail = decodeURIComponent(requestedEmail);
      }
    }
    
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (emailOptIn !== undefined) updateData.emailOptIn = emailOptIn;
    if (smsOptIn !== undefined) updateData.smsOptIn = smsOptIn;
    if (doNotSellMyInfo !== undefined) updateData.doNotSellMyInfo = doNotSellMyInfo;
    
    const result = await db.update(users)
      .set(updateData)
      .where(eq(users.email, targetEmail.toLowerCase()))
      .returning({ 
        emailOptIn: users.emailOptIn, 
        smsOptIn: users.smsOptIn,
        doNotSellMyInfo: users.doNotSellMyInfo,
        hubspotId: users.hubspotId 
      });
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    // Push preferences to HubSpot if contact has hubspot_id
    const updated = result[0];
    if (updated.hubspotId) {
      updateHubSpotContactPreferences(updated.hubspotId, { 
        emailOptIn: emailOptIn !== undefined ? emailOptIn : undefined,
        smsOptIn: smsOptIn !== undefined ? smsOptIn : undefined
      }).catch(err => console.error('[Members] Failed to sync preferences to HubSpot:', err));
    }
    
    res.json({ 
      emailOptIn: updated.emailOptIn, 
      smsOptIn: updated.smsOptIn,
      doNotSellMyInfo: updated.doNotSellMyInfo
    });
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Get cascade preview for member archive - shows what will be affected
router.get('/api/members/:email/cascade-preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const userResult = await db.select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    
    // Count bookings where user is primary booker or linked
    const bookingsResult = await db.execute(sql`
      SELECT COUNT(DISTINCT br.id)::int as count FROM booking_requests br
      LEFT JOIN booking_members bm ON br.id = bm.booking_id
      WHERE (
        LOWER(br.user_email) = ${normalizedEmail}
        OR LOWER(bm.user_email) = ${normalizedEmail}
      )
      AND br.archived_at IS NULL
    `);
    const bookingsCount = Number((bookingsResult as any).rows?.[0]?.count || 0);
    
    // Count event RSVPs
    const rsvpsResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(eventRsvps)
      .where(or(
        sql`LOWER(${eventRsvps.userEmail}) = ${normalizedEmail}`,
        eq(eventRsvps.matchedUserId, userId)
      ));
    const rsvpsCount = rsvpsResult[0]?.count || 0;
    
    // Count wellness enrollments
    const enrollmentsResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(wellnessEnrollments)
      .where(sql`LOWER(${wellnessEnrollments.userEmail}) = ${normalizedEmail}`);
    const enrollmentsCount = enrollmentsResult[0]?.count || 0;
    
    // Count guest check-ins
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
  } catch (error: any) {
    if (!isProduction) console.error('Member cascade preview error:', error);
    res.status(500).json({ error: 'Failed to fetch cascade preview' });
  }
});

// Archive a member (soft delete)
router.delete('/api/members/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    const sessionUser = getSessionUser(req);
    const archivedBy = sessionUser?.email || 'unknown';
    
    const userResult = await db.select({ 
      id: users.id, 
      archivedAt: users.archivedAt 
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (userResult[0].archivedAt) {
      return res.status(400).json({ error: 'Member is already archived' });
    }
    
    await db.update(users)
      .set({
        archivedAt: new Date(),
        archivedBy: archivedBy,
        membershipStatus: 'archived',
        updatedAt: new Date()
      })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    res.json({ 
      success: true, 
      archived: true,
      archivedBy,
      message: 'Member archived successfully'
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member archive error:', error);
    res.status(500).json({ error: 'Failed to archive member' });
  }
});

// Hard delete a member (ADMIN ONLY - for testing purposes)
// This permanently removes the user and all associated data from the database
// Optionally also removes from HubSpot and Stripe
router.delete('/api/members/:email/permanent', isAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { deleteFromHubSpot, deleteFromStripe } = req.query;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    const sessionUser = getSessionUser(req);
    
    const userResult = await db.select({ 
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      stripeCustomerId: users.stripeCustomerId,
      hubspotId: users.hubspotId
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    const memberName = `${userResult[0].firstName || ''} ${userResult[0].lastName || ''}`.trim();
    const stripeCustomerId = userResult[0].stripeCustomerId;
    const hubspotId = userResult[0].hubspotId;
    
    const deletionLog: string[] = [];
    
    // Delete related records first (before deleting user due to foreign keys)
    await pool.query('DELETE FROM member_notes WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('member_notes');
    
    await pool.query('DELETE FROM communication_logs WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('communication_logs');
    
    await pool.query('DELETE FROM guest_passes WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('guest_passes');
    
    await pool.query('DELETE FROM guest_check_ins WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('guest_check_ins');
    
    await pool.query('DELETE FROM event_rsvps WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('event_rsvps');
    
    await pool.query('DELETE FROM wellness_enrollments WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('wellness_enrollments');
    
    await pool.query('DELETE FROM booking_requests WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('booking_requests');
    
    await pool.query('DELETE FROM booking_members WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('booking_members');
    
    // Delete from Stripe if requested
    let stripeDeleted = false;
    if (deleteFromStripe === 'true' && stripeCustomerId) {
      try {
        const { getStripe } = await import('../core/stripe');
        const stripe = getStripe();
        await stripe.customers.del(stripeCustomerId);
        stripeDeleted = true;
        deletionLog.push('stripe_customer');
      } catch (stripeError: any) {
        console.error(`[Admin] Failed to delete Stripe customer ${stripeCustomerId}:`, stripeError.message);
      }
    }
    
    // Archive from HubSpot if requested (HubSpot only supports archive, not permanent delete)
    let hubspotArchived = false;
    if (deleteFromHubSpot === 'true' && hubspotId) {
      try {
        const { getHubSpotClient } = await import('../core/integrations');
        const hubspot = await getHubSpotClient();
        await hubspot.crm.contacts.basicApi.archive(hubspotId);
        hubspotArchived = true;
        deletionLog.push('hubspot_contact (archived)');
      } catch (hubspotError: any) {
        console.error(`[Admin] Failed to archive HubSpot contact ${hubspotId}:`, hubspotError.message);
      }
    }
    
    // Finally delete the user record
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    deletionLog.push('users');
    
    console.log(`[Admin] Member permanently deleted: ${normalizedEmail} (${memberName}) by ${sessionUser?.email}. Records: ${deletionLog.join(', ')}`);
    
    res.json({ 
      success: true, 
      deleted: true,
      deletedBy: sessionUser?.email,
      deletedRecords: deletionLog,
      stripeDeleted,
      hubspotArchived,
      message: `Member ${memberName || normalizedEmail} permanently deleted`
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member permanent delete error:', error);
    res.status(500).json({ error: 'Failed to permanently delete member' });
  }
});

// Anonymize a member (CCPA/CPRA compliance - full data erasure)
// This replaces PII with anonymized placeholders while preserving financial records
router.post('/api/members/:email/anonymize', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    const sessionUser = getSessionUser(req);
    const anonymizedBy = sessionUser?.email || 'unknown';
    
    const userResult = await db.select({ 
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      archivedAt: users.archivedAt 
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    const anonymizedId = userId.slice(0, 8);
    const anonymizedEmail = `deleted_${anonymizedId}@anonymized.local`;
    const now = new Date();
    
    await db.update(users)
      .set({
        firstName: 'Deleted',
        lastName: 'Member',
        email: anonymizedEmail,
        phone: null,
        trackmanEmail: null,
        linkedEmails: sql`'[]'::jsonb`,
        manuallyLinkedEmails: sql`'[]'::jsonb`,
        emailOptIn: false,
        smsOptIn: false,
        doNotSellMyInfo: true,
        archivedAt: now,
        archivedBy: anonymizedBy,
        membershipStatus: 'deleted',
        updatedAt: now
      })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    await db.execute(sql`
      UPDATE booking_requests 
      SET user_name = 'Deleted Member', 
          user_email = ${anonymizedEmail}
      WHERE LOWER(user_email) = ${normalizedEmail}
    `);
    
    await db.execute(sql`
      UPDATE booking_members 
      SET user_name = 'Deleted Member',
          user_email = ${anonymizedEmail}
      WHERE LOWER(user_email) = ${normalizedEmail}
    `);
    
    console.log(`[Privacy] Member ${normalizedEmail} anonymized by ${anonymizedBy} at ${now.toISOString()}`);
    
    logFromRequest(req, 'archive_member', 'member', normalizedEmail, 
      `${userResult[0].firstName} ${userResult[0].lastName}`.trim() || undefined,
      { action: 'anonymize', reason: 'CCPA compliance' });
    
    res.json({ 
      success: true, 
      anonymized: true,
      anonymizedBy,
      message: 'Member data anonymized successfully. Financial records preserved for compliance.'
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member anonymize error:', error);
    res.status(500).json({ error: 'Failed to anonymize member data' });
  }
});

// Get member communication preferences (includes CCPA privacy settings)
// Supports ?user_email param for "View As" feature when staff views as another member
router.get('/api/members/me/preferences', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Support "View As" feature: staff can pass user_email param to view as another member
    const requestedEmail = req.query.user_email as string | undefined;
    let targetEmail = sessionUser.email;
    
    if (requestedEmail && requestedEmail.toLowerCase() !== sessionUser.email.toLowerCase()) {
      // Only staff/admin can view other members' preferences
      if (sessionUser.role === 'admin' || sessionUser.role === 'staff') {
        targetEmail = decodeURIComponent(requestedEmail);
      }
    }
    
    const result = await db.select({ 
      emailOptIn: users.emailOptIn, 
      smsOptIn: users.smsOptIn,
      doNotSellMyInfo: users.doNotSellMyInfo,
      dataExportRequestedAt: users.dataExportRequestedAt
    })
      .from(users)
      .where(eq(users.email, targetEmail.toLowerCase()));
    
    if (result.length === 0) {
      return res.json({ emailOptIn: null, smsOptIn: null, doNotSellMyInfo: false, dataExportRequestedAt: null });
    }
    
    res.json(result[0]);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// Get unified visits for the current authenticated user
// Returns all past visits (bookings, wellness, events) with role information
router.get('/api/my-visits', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const requestedEmail = req.query.user_email as string | undefined;
    let targetEmail = sessionUser.email.toLowerCase();
    
    if (requestedEmail && requestedEmail.toLowerCase() !== sessionUser.email.toLowerCase()) {
      if (sessionUser.role === 'admin' || sessionUser.role === 'staff') {
        targetEmail = decodeURIComponent(requestedEmail).toLowerCase();
      }
    }
    
    const unifiedVisitsResult = await db.execute(sql`
      SELECT DISTINCT ON (visit_type, visit_id) * FROM (
        -- Bookings as host
        SELECT 
          br.id as visit_id,
          'booking' as visit_type,
          'Host' as role,
          br.request_date::text as date,
          br.start_time::text as start_time,
          br.end_time::text as end_time,
          COALESCE(r.name, br.resource_preference, 'Simulator') as resource_name,
          NULL as location,
          CASE WHEN r.type = 'conference_room' OR LOWER(r.name) LIKE '%conference%' THEN 'Conference Room' ELSE 'Golf Simulator' END as category,
          NULL as invited_by
        FROM booking_requests br
        LEFT JOIN resources r ON br.resource_id = r.id
        WHERE LOWER(br.user_email) = ${targetEmail}
          AND br.request_date < CURRENT_DATE
          AND br.status NOT IN ('cancelled', 'declined')
        
        UNION ALL
        
        -- Bookings as player (via booking_members, non-primary)
        SELECT 
          br.id as visit_id,
          'booking' as visit_type,
          'Player' as role,
          br.request_date::text as date,
          br.start_time::text as start_time,
          br.end_time::text as end_time,
          COALESCE(r.name, br.resource_preference, 'Simulator') as resource_name,
          NULL as location,
          CASE WHEN r.type = 'conference_room' OR LOWER(r.name) LIKE '%conference%' THEN 'Conference Room' ELSE 'Golf Simulator' END as category,
          COALESCE(host_user.first_name || ' ' || host_user.last_name, br.user_name) as invited_by
        FROM booking_requests br
        JOIN booking_members bm ON br.id = bm.booking_id
        LEFT JOIN resources r ON br.resource_id = r.id
        LEFT JOIN users host_user ON LOWER(br.user_email) = LOWER(host_user.email)
        WHERE LOWER(bm.user_email) = ${targetEmail}
          AND (bm.is_primary IS NOT TRUE OR bm.is_primary IS NULL)
          AND LOWER(br.user_email) != ${targetEmail}
          AND br.request_date < CURRENT_DATE
          AND br.status NOT IN ('cancelled', 'declined')
        
        UNION ALL
        
        -- Bookings as guest (via booking_guests)
        SELECT 
          br.id as visit_id,
          'booking' as visit_type,
          'Guest' as role,
          br.request_date::text as date,
          br.start_time::text as start_time,
          br.end_time::text as end_time,
          COALESCE(r.name, br.resource_preference, 'Simulator') as resource_name,
          NULL as location,
          CASE WHEN r.type = 'conference_room' OR LOWER(r.name) LIKE '%conference%' THEN 'Conference Room' ELSE 'Golf Simulator' END as category,
          COALESCE(host_user.first_name || ' ' || host_user.last_name, br.user_name) as invited_by
        FROM booking_requests br
        JOIN booking_guests bg ON br.id = bg.booking_id
        LEFT JOIN resources r ON br.resource_id = r.id
        LEFT JOIN users host_user ON LOWER(br.user_email) = LOWER(host_user.email)
        WHERE LOWER(bg.guest_email) = ${targetEmail}
          AND br.request_date < CURRENT_DATE
          AND br.status NOT IN ('cancelled', 'declined')
        
        UNION ALL
        
        -- Wellness enrollments
        SELECT 
          we.id as visit_id,
          'wellness' as visit_type,
          'Wellness' as role,
          wc.date::text as date,
          wc.time::text as start_time,
          NULL as end_time,
          wc.title as resource_name,
          NULL as location,
          wc.category as category,
          wc.instructor as invited_by
        FROM wellness_enrollments we
        JOIN wellness_classes wc ON we.class_id = wc.id
        WHERE LOWER(we.user_email) = ${targetEmail}
          AND wc.date < CURRENT_DATE
          AND we.status NOT IN ('cancelled')
        
        UNION ALL
        
        -- Event RSVPs
        SELECT 
          er.id as visit_id,
          'event' as visit_type,
          'Event' as role,
          e.event_date::text as date,
          e.start_time::text as start_time,
          e.end_time::text as end_time,
          e.title as resource_name,
          e.location as location,
          e.category as category,
          NULL as invited_by
        FROM event_rsvps er
        JOIN events e ON er.event_id = e.id
        WHERE LOWER(er.user_email) = ${targetEmail}
          AND e.event_date < CURRENT_DATE
          AND er.status NOT IN ('cancelled')
      ) all_visits
      ORDER BY visit_type, visit_id, date DESC
    `);
    
    const rows = (unifiedVisitsResult as any).rows || [];
    
    const visits = rows
      .map((row: any) => ({
        id: row.visit_id,
        type: row.visit_type,
        role: row.role,
        date: row.date,
        startTime: row.start_time,
        endTime: row.end_time,
        resourceName: row.resource_name,
        location: row.location || undefined,
        category: row.category || undefined,
        invitedBy: row.invited_by || undefined,
      }))
      .sort((a: any, b: any) => b.date.localeCompare(a.date));
    
    res.json(visits);
  } catch (error: any) {
    if (!isProduction) console.error('API error fetching my-visits:', error);
    res.status(500).json({ error: 'Failed to fetch visits' });
  }
});

// Request data export (CCPA/CPRA compliance)
// Records the request timestamp and sends email notification to staff
router.post('/api/members/me/data-export-request', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Record the request timestamp
    const result = await db.update(users)
      .set({ 
        dataExportRequestedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(users.email, sessionUser.email.toLowerCase()))
      .returning({ 
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        dataExportRequestedAt: users.dataExportRequestedAt
      });
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = result[0];
    const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ') || 'Member';
    console.log(`[Privacy] Data export requested by ${member.email} at ${member.dataExportRequestedAt}`);
    
    // Send email notification to admin staff
    try {
      const adminStaff = await db.select({ email: staffUsers.email, name: staffUsers.name })
        .from(staffUsers)
        .where(and(eq(staffUsers.role, 'admin'), eq(staffUsers.isActive, true)));
      
      if (adminStaff.length > 0) {
        const { client: resendClient, fromEmail } = await getResendClient();
        const adminEmails = adminStaff.map(s => s.email);
        
        await withResendRetry(() => resendClient.emails.send({
          from: fromEmail,
          to: adminEmails,
          subject: `[Action Required] CCPA Data Export Request from ${memberName}`,
          html: `
            <h2>Data Export Request</h2>
            <p>A member has requested a copy of their personal data under CCPA/CPRA.</p>
            <p><strong>Member:</strong> ${memberName}</p>
            <p><strong>Email:</strong> ${member.email}</p>
            <p><strong>Requested At:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</p>
            <hr/>
            <p><em>Under California law, you must respond within 45 days.</em></p>
            <p>Please prepare and send the member's data export.</p>
          `
        }));
        console.log(`[Privacy] Data export notification sent to ${adminEmails.length} admin(s)`);
      }
    } catch (emailError) {
      console.error('[Privacy] Failed to send data export notification email:', emailError);
    }
    
    res.json({ 
      success: true, 
      message: 'Data export request submitted successfully',
      requestedAt: member.dataExportRequestedAt
    });
  } catch (error: any) {
    if (!isProduction) console.error('Data export request error:', error);
    res.status(500).json({ error: 'Failed to submit data export request' });
  }
});

// ============================================================
// ADD MEMBER - Staff can manually create new members
// Creates user in DB + HubSpot contact + Deal + Line Item
// ============================================================

// Get options for Add Member form (tiers and discount reasons)
router.get('/api/members/add-options', isStaffOrAdmin, async (req, res) => {
  try {
    const discountRules = await getAllDiscountRules();
    
    // Get active subscription tiers with IDs for Stripe payment links
    const tiersResult = await pool.query(
      `SELECT id, name, slug, price_cents, billing_interval, stripe_price_id
       FROM membership_tiers 
       WHERE is_active = true 
         AND product_type = 'subscription'
         AND billing_interval IN ('month', 'year', 'week')
       ORDER BY sort_order ASC NULLS LAST, name ASC`
    );
    
    res.json({
      tiers: TIER_NAMES,
      tiersWithIds: tiersResult.rows.map(t => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        priceCents: t.price_cents,
        billingInterval: t.billing_interval,
        hasStripePrice: !!t.stripe_price_id
      })),
      discountReasons: discountRules
        .filter(r => r.isActive)
        .map(r => ({
          tag: r.discountTag,
          percent: r.discountPercent,
          description: r.description
        }))
    });
  } catch (error: any) {
    if (!isProduction) console.error('Add options error:', error);
    res.status(500).json({ error: 'Failed to fetch add member options' });
  }
});

// Create new member (Staff only)
router.post('/api/members', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { firstName, lastName, email, phone, tier, startDate, discountReason } = req.body;
    
    // Validation
    if (!firstName || typeof firstName !== 'string' || firstName.trim().length === 0) {
      return res.status(400).json({ error: 'First name is required' });
    }
    if (!lastName || typeof lastName !== 'string' || lastName.trim().length === 0) {
      return res.status(400).json({ error: 'Last name is required' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!tier || !TIER_NAMES.includes(tier as any)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${TIER_NAMES.join(', ')}` });
    }
    
    // Validate startDate if provided
    if (startDate) {
      if (typeof startDate !== 'string') {
        return res.status(400).json({ error: 'Start date must be a string in YYYY-MM-DD format' });
      }
      
      // Check YYYY-MM-DD format
      const dateFormatRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateFormatRegex.test(startDate)) {
        return res.status(400).json({ error: 'Start date must be in YYYY-MM-DD format' });
      }
      
      // Validate it's a real date
      const dateObj = new Date(`${startDate}T00:00:00Z`);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({ error: 'Start date is not a valid date' });
      }
      
      // Check if date is in the future and warn (but still allow)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const providedDate = new Date(`${startDate}T00:00:00Z`);
      
      if (providedDate > today) {
        if (!isProduction) {
          console.warn(`[Members] Start date is in the future: ${startDate}. Member ${email} will have a future join date.`);
        }
      }
    }
    
    // Create member with HubSpot integration
    const result = await createMemberWithDeal({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone?.trim() || undefined,
      tier,
      startDate: startDate || undefined,
      discountReason: discountReason || undefined,
      createdBy: sessionUser.email,
      createdByName: sessionUser.name || `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim()
    });
    
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to create member' });
    }
    
    res.status(201).json({
      success: true,
      message: `Successfully created member ${firstName} ${lastName}`,
      member: {
        id: result.userId,
        email: email.toLowerCase(),
        firstName,
        lastName,
        tier,
        hubspotContactId: result.hubspotContactId,
        hubspotDealId: result.hubspotDealId
      }
    });
  } catch (error: any) {
    console.error('Create member error:', error);
    res.status(500).json({ error: 'Failed to create member' });
  }
});

// Admin: Bulk update member tiers from CSV data
router.post('/api/members/admin/bulk-tier-update', isStaffOrAdmin, async (req, res) => {
  try {
    const { members, syncToHubspot = true, dryRun = false } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: 'Members array is required' });
    }
    
    const performedBy = sessionUser?.email || 'system';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : 'Bulk Update';
    
    const results: {
      updated: { email: string; name: string; oldTier: string; newTier: string; hubspotSynced?: boolean }[];
      unchanged: { email: string; name: string; tier: string }[];
      notFound: { email: string; tier: string }[];
      errors: { email: string; error: string }[];
    } = { updated: [], unchanged: [], notFound: [], errors: [] };
    
    // Map tier names from CSV to normalized tier names using centralized utility
    const { normalizeTierName: normalizeTierNameUtil, TIER_SLUGS } = await import('../utils/tierUtils');
    function normalizeCsvTier(csvTier: string): string | null {
      if (!csvTier) return null;
      const normalized = normalizeTierNameUtil(csvTier);
      return normalized;
    }
    
    // Get tier ID from tier name
    const tierIdMap: Record<string, number> = {
      'Social': 1,
      'Core': 2,
      'Premium': 3,
      'Corporate': 4,
      'VIP': 5
    };
    
    for (const member of members) {
      const { email, tier: csvTier, name } = member;
      
      if (!email) {
        results.errors.push({ email: 'unknown', error: 'Email missing' });
        continue;
      }
      
      const normalizedEmail = email.toLowerCase().trim();
      const normalizedTier = normalizeCsvTier(csvTier);
      
      if (!normalizedTier) {
        results.errors.push({ email: normalizedEmail, error: `Invalid tier: ${csvTier}` });
        continue;
      }
      
      try {
        // Find the member
        const userResult = await db.select({
          id: users.id,
          email: users.email,
          tier: users.tier,
          tierId: users.tierId,
          firstName: users.firstName,
          lastName: users.lastName
        })
          .from(users)
          .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
        
        if (userResult.length === 0) {
          results.notFound.push({ email: normalizedEmail, tier: normalizedTier });
          continue;
        }
        
        const user = userResult[0];
        // Use actual DB value for comparison (can be null)
        const actualTier = user.tier;
        // For display/sync purposes, default null to 'Social'
        const oldTierDisplay = actualTier || 'Social';
        const memberName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || normalizedEmail;
        
        // Check if tier is already correct - compare against actual DB value
        if (actualTier === normalizedTier) {
          results.unchanged.push({ email: normalizedEmail, name: memberName, tier: normalizedTier });
          continue;
        }
        
        if (dryRun) {
          results.updated.push({ 
            email: normalizedEmail, 
            name: memberName, 
            oldTier: oldTierDisplay, 
            newTier: normalizedTier,
            hubspotSynced: false
          });
          continue;
        }
        
        // Update both tier and tier_id
        const tierId = tierIdMap[normalizedTier];
        await db.update(users)
          .set({ 
            tier: normalizedTier, 
            tierId: tierId,
            membershipTier: csvTier, // Store the original CSV tier for reference
            updatedAt: new Date() 
          })
          .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
        
        // Sync to HubSpot if enabled
        let hubspotSynced = false;
        if (syncToHubspot) {
          const hubspotResult = await handleTierChange(
            normalizedEmail,
            oldTierDisplay,
            normalizedTier,
            performedBy,
            performedByName
          );
          hubspotSynced = hubspotResult.success;
          
          if (!hubspotResult.success && hubspotResult.error) {
            console.warn(`[BulkTierUpdate] HubSpot sync failed for ${normalizedEmail}: ${hubspotResult.error}`);
          }
        }
        
        results.updated.push({ 
          email: normalizedEmail, 
          name: memberName, 
          oldTier: oldTierDisplay, 
          newTier: normalizedTier,
          hubspotSynced
        });
        
        // Add a small delay to avoid rate limiting
        if (syncToHubspot) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error: any) {
        console.error(`[BulkTierUpdate] Error processing ${normalizedEmail}:`, error);
        results.errors.push({ email: normalizedEmail, error: error.message });
      }
    }
    
    res.json({
      success: true,
      dryRun,
      summary: {
        total: members.length,
        updated: results.updated.length,
        unchanged: results.unchanged.length,
        notFound: results.notFound.length,
        errors: results.errors.length
      },
      results
    });
  } catch (error: any) {
    console.error('Bulk tier update error:', error);
    res.status(500).json({ error: 'Failed to process bulk tier update' });
  }
});

router.get('/api/visitors', isStaffOrAdmin, async (req, res) => {
  try {
    const { sortBy = 'lastPurchase', order = 'desc', limit = '100', offset = '0', typeFilter = 'all', sourceFilter = 'all', search = '' } = req.query;
    const pageLimit = Math.min(parseInt(limit as string) || 100, 500);
    const pageOffset = Math.max(parseInt(offset as string) || 0, 0);
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const searchTerm = (search as string || '').trim().toLowerCase();
    
    // Determine sort column based on sortBy parameter
    // Uses pre-aggregated subquery aliases (dpp_agg, lp_agg)
    let orderByClause = `GREATEST(dpp_agg.last_purchase_date, lp_agg.last_purchase_date) ${sortOrder} NULLS LAST`;
    if (sortBy === 'name') {
      orderByClause = `u.first_name || ' ' || u.last_name ${sortOrder}`;
    } else if (sortBy === 'totalSpent') {
      orderByClause = `(COALESCE(dpp_agg.total_spent_cents, 0) + COALESCE(lp_agg.total_spent_cents, 0)) ${sortOrder}`;
    } else if (sortBy === 'purchaseCount') {
      orderByClause = `(COALESCE(dpp_agg.purchase_count, 0) + COALESCE(lp_agg.purchase_count, 0)) ${sortOrder}`;
    } else if (sortBy === 'createdAt') {
      orderByClause = `u.created_at ${sortOrder} NULLS LAST`;
    }
    
    // Build source filter condition
    // Must match the getSource() logic exactly to avoid filter/display mismatch
    // Priority order in getSource: billing_provider > mindbody_client_id/legacy_source > stripe_customer_id > hubspot_id
    let sourceCondition = '';
    if (sourceFilter === 'stripe') {
      // Stripe: billing_provider is 'stripe' OR (has stripe_customer_id AND no mindbody indicators)
      sourceCondition = `AND (
        u.billing_provider = 'stripe'
        OR (
          u.billing_provider IS DISTINCT FROM 'mindbody'
          AND u.stripe_customer_id IS NOT NULL 
          AND u.mindbody_client_id IS NULL 
          AND u.legacy_source IS DISTINCT FROM 'mindbody_import'
        )
      )`;
    } else if (sourceFilter === 'mindbody') {
      // MindBody: billing_provider is 'mindbody' OR has mindbody_client_id/legacy_source (regardless of stripe_customer_id)
      sourceCondition = `AND (
        u.billing_provider = 'mindbody'
        OR (
          u.billing_provider IS DISTINCT FROM 'stripe'
          AND (u.mindbody_client_id IS NOT NULL OR u.legacy_source = 'mindbody_import')
        )
      )`;
    } else if (sourceFilter === 'hubspot') {
      // HubSpot: has hubspot_id but NOT stripe and NOT mindbody
      sourceCondition = `AND u.hubspot_id IS NOT NULL 
        AND u.billing_provider IS DISTINCT FROM 'stripe'
        AND u.billing_provider IS DISTINCT FROM 'mindbody'
        AND u.stripe_customer_id IS NULL 
        AND u.mindbody_client_id IS NULL
        AND u.legacy_source IS DISTINCT FROM 'mindbody_import'`;
    }
    
    // Build type filter - filter by stored visitor_type or computed from activity
    let typeCondition = '';
    if (typeFilter === 'day_pass') {
      typeCondition = "AND (u.visitor_type = 'day_pass' OR u.visitor_type = 'day_pass_buyer')";
    } else if (typeFilter === 'guest') {
      typeCondition = "AND u.visitor_type = 'guest'";
    } else if (typeFilter === 'lead') {
      typeCondition = "AND (u.visitor_type = 'lead' OR u.visitor_type IS NULL)";
    }
    
    // Build search condition
    let searchCondition = '';
    if (searchTerm) {
      const escapedSearch = searchTerm.replace(/'/g, "''");
      searchCondition = `AND (
        LOWER(u.first_name || ' ' || u.last_name) LIKE '%${escapedSearch}%'
        OR LOWER(u.email) LIKE '%${escapedSearch}%'
        OR LOWER(u.phone) LIKE '%${escapedSearch}%'
      )`;
    }
    
    // Get total count first for pagination
    const countResult = await db.execute(sql`
      SELECT COUNT(DISTINCT u.id)::int as total
      FROM users u
      WHERE (u.role = 'visitor' OR u.membership_status = 'visitor' OR u.membership_status = 'non-member')
      AND u.role NOT IN ('admin', 'staff')
      AND u.archived_at IS NULL
      ${sql.raw(sourceCondition)}
      ${sql.raw(typeCondition)}
      ${sql.raw(searchCondition)}
    `);
    const totalCount = (countResult.rows[0] as any)?.total || 0;
    
    // Get all non-member contacts (visitors, non-members, leads) with aggregated purchase stats
    // Combines purchases from both day_pass_purchases (Stripe) and legacy_purchases (MindBody)
    // Uses subqueries to pre-aggregate per table to avoid cartesian multiplication issues
    // Also get guest count and latest activity
    const visitorsWithPurchases = await db.execute(sql`
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
        COALESCE(guest_agg.guest_count, 0)::int as guest_count,
        guest_agg.last_guest_date
      FROM users u
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
      ${sql.raw(typeCondition)}
      ${sql.raw(searchCondition)}
      ORDER BY ${sql.raw(orderByClause)}
      LIMIT ${pageLimit}
      OFFSET ${pageOffset}
    `);
    
    // Determine source based on database fields
    // Priority: billing_provider takes precedence when explicitly set
    // Then: STRIPE > MINDBODY > HUBSPOT > APP
    const getSource = (row: any): 'mindbody' | 'hubspot' | 'stripe' | 'app' => {
      // If billing_provider is explicitly set, respect it
      if (row.billing_provider === 'mindbody') return 'mindbody';
      if (row.billing_provider === 'stripe') return 'stripe';
      
      // STRIPE: has a Stripe customer record AND no mindbody indicators
      // (some records have stale stripe_customer_id that don't exist in Stripe)
      if (row.stripe_customer_id && !row.mindbody_client_id && row.legacy_source !== 'mindbody_import') {
        return 'stripe';
      }
      // MINDBODY: has mindbody_client_id or legacy mindbody markers
      if (row.mindbody_client_id || row.legacy_source === 'mindbody_import') {
        return 'mindbody';
      }
      // STRIPE: has stripe_customer_id (fallback)
      if (row.stripe_customer_id) return 'stripe';
      // HUBSPOT: has HubSpot ID
      if (row.hubspot_id) return 'hubspot';
      return 'app';
    };
    
    // Determine type based on stored visitor_type or compute from activity
    // Types: day_pass, guest, lead
    const getType = (row: any): 'day_pass' | 'guest' | 'lead' => {
      // If we have a stored visitor_type, use it (normalize old values)
      if (row.visitor_type) {
        if (row.visitor_type === 'day_pass_buyer' || row.visitor_type === 'day_pass') return 'day_pass';
        if (row.visitor_type === 'guest') return 'guest';
        if (row.visitor_type === 'lead') return 'lead';
      }
      // Otherwise compute from activity data
      const purchaseCount = parseInt(row.purchase_count) || 0;
      const guestCount = parseInt(row.guest_count) || 0;
      // Day pass buyer takes precedence (paid activity)
      if (purchaseCount > 0) return 'day_pass';
      // Guest (was brought by a member)
      if (guestCount > 0) return 'guest';
      // Lead (no app activity)
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
    
    // Get the visitor first to ensure they exist and are a visitor
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
    
    // Verify the user is a visitor or non-member (allow broader access for billing lookup)
    const isVisitorLike = visitor.role === 'visitor' || 
                          visitor.membershipStatus === 'visitor' || 
                          visitor.membershipStatus === 'non-member';
    if (!isVisitorLike) {
      return res.status(403).json({ error: 'User is not a visitor' });
    }
    
    // Get all day pass purchases for this visitor
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

// Get guests that are missing email addresses
router.get('/api/guests/needs-email', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
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
      guests: result.rows.map(row => ({
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

// Update a guest's email address
router.patch('/api/guests/:guestId/email', isStaffOrAdmin, async (req, res) => {
  try {
    const { guestId } = req.params;
    const { email } = req.body;
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    
    const normalizedEmail = email.trim().toLowerCase();
    
    // Update the guest's email
    const result = await pool.query(
      `UPDATE guests SET email = $1 WHERE id = $2 RETURNING id, name, email`,
      [normalizedEmail, guestId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    res.json({
      success: true,
      guest: result.rows[0],
      message: `Email updated for ${result.rows[0].name}`
    });
  } catch (error: any) {
    console.error('[Update Guest Email] Error:', error);
    res.status(500).json({ error: 'Failed to update guest email' });
  }
});

router.post('/api/admin/member/change-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { oldEmail, newEmail } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!oldEmail || !newEmail) {
      return res.status(400).json({ error: 'Both oldEmail and newEmail are required' });
    }
    
    const performedBy = sessionUser?.email || 'unknown';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : sessionUser?.email?.split('@')[0] || 'Staff';
    
    const result = await cascadeEmailChange(oldEmail, newEmail, performedBy, performedByName);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({
      success: true,
      message: `Email changed from ${result.oldEmail} to ${result.newEmail}`,
      tablesUpdated: result.tablesUpdated
    });
  } catch (error: any) {
    console.error('[Email Change] Error:', error);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

router.get('/api/admin/member/change-email/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const impact = await previewEmailChangeImpact(email);
    res.json(impact);
  } catch (error: any) {
    console.error('[Email Change Preview] Error:', error);
    res.status(500).json({ error: 'Failed to preview email change impact' });
  }
});

router.get('/api/admin/tier-change/tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const tiers = await getAvailableTiersForChange();
    res.json({ tiers });
  } catch (error: any) {
    console.error('[Tier Change] Error getting tiers:', error);
    res.status(500).json({ error: 'Failed to get tiers' });
  }
});

router.post('/api/admin/tier-change/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { subscriptionId, newPriceId, immediate = true } = req.body;
    
    if (!subscriptionId || !newPriceId) {
      return res.status(400).json({ error: 'subscriptionId and newPriceId required' });
    }
    
    const result = await previewTierChange(subscriptionId, newPriceId, immediate);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ preview: result.preview });
  } catch (error: any) {
    console.error('[Tier Change] Preview error:', error);
    res.status(500).json({ error: 'Failed to preview tier change' });
  }
});

router.post('/api/admin/tier-change/commit', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberEmail, subscriptionId, newPriceId, immediate = true } = req.body;
    const staffEmail = (req as any).user?.email || 'unknown';
    
    if (!memberEmail || !subscriptionId || !newPriceId) {
      return res.status(400).json({ error: 'memberEmail, subscriptionId, and newPriceId required' });
    }
    
    const result = await commitTierChange(memberEmail, subscriptionId, newPriceId, immediate, staffEmail);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Tier Change] Commit error:', error);
    res.status(500).json({ error: 'Failed to change tier' });
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
      statusCondition = sql`(
        ${users.membershipStatus} = 'active' 
        OR ${users.membershipStatus} IS NULL
        OR (${users.stripeSubscriptionId} IS NOT NULL AND (${users.membershipStatus} = 'non-member' OR ${users.membershipStatus} = 'pending'))
      )`;
    } else if (statusFilter === 'former') {
      statusCondition = sql`${users.membershipStatus} IN ('inactive', 'cancelled', 'expired', 'terminated', 'former_member', 'churned', 'suspended', 'frozen', 'past_due', 'declined')`;
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
      sql`${users.role} != 'staff'`
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
      joinDate: users.joinDate,
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
      // Count ALL bookings where user participated (as host, player, or guest)
      // Uses UNION to deduplicate across all roles for the same booking
      const bookingsResult = await pool.query(
        `SELECT email, COUNT(DISTINCT booking_id) as count FROM (
          -- Bookings as host
          SELECT LOWER(user_email) as email, id as booking_id
          FROM booking_requests
          WHERE LOWER(user_email) = ANY($1)
            AND status NOT IN ('cancelled', 'declined')
            AND request_date < CURRENT_DATE
          UNION
          -- Bookings as guest
          SELECT LOWER(bg.guest_email) as email, br.id as booking_id
          FROM booking_guests bg
          JOIN booking_requests br ON bg.booking_id = br.id
          WHERE LOWER(bg.guest_email) = ANY($1)
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < CURRENT_DATE
          UNION
          -- Bookings as added player (non-primary)
          SELECT LOWER(bm.user_email) as email, br.id as booking_id
          FROM booking_members bm
          JOIN booking_requests br ON bm.booking_id = br.id
          WHERE LOWER(bm.user_email) = ANY($1)
            AND bm.is_primary IS NOT TRUE
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < CURRENT_DATE
        ) all_bookings
        GROUP BY email`,
        [memberEmails]
      );
      for (const row of bookingsResult.rows || []) {
        bookingCounts[row.email] = Number(row.count);
      }
      
      // Count event RSVPs
      const eventsResult = await pool.query(
        `SELECT LOWER(user_email) as email, COUNT(*) as count
        FROM event_rsvps er
        JOIN events e ON er.event_id = e.id
        WHERE LOWER(er.user_email) = ANY($1)
          AND er.status != 'cancelled'
          AND e.event_date < CURRENT_DATE
        GROUP BY LOWER(user_email)`,
        [memberEmails]
      );
      for (const row of eventsResult.rows || []) {
        eventCounts[row.email] = Number(row.count);
      }
      
      // Count wellness class enrollments
      const wellnessResult = await pool.query(
        `SELECT LOWER(we.user_email) as email, COUNT(*) as count
        FROM wellness_enrollments we
        JOIN wellness_classes wc ON we.class_id = wc.id
        WHERE LOWER(we.user_email) = ANY($1)
          AND we.status != 'cancelled'
          AND wc.date < CURRENT_DATE
        GROUP BY LOWER(we.user_email)`,
        [memberEmails]
      );
      for (const row of wellnessResult.rows || []) {
        wellnessCounts[row.email] = Number(row.count);
      }
      
      // Get last activity date from all sources (past only)
      const lastActivityResult = await pool.query(
        `SELECT email, MAX(last_date) as last_date FROM (
          -- Bookings as host (past only)
          SELECT LOWER(user_email) as email, MAX(request_date) as last_date
          FROM booking_requests
          WHERE LOWER(user_email) = ANY($1) 
            AND status NOT IN ('cancelled', 'declined')
            AND request_date < CURRENT_DATE
          GROUP BY LOWER(user_email)
          UNION ALL
          -- Bookings as guest (past only)
          SELECT LOWER(bg.guest_email) as email, MAX(br.request_date) as last_date
          FROM booking_guests bg
          JOIN booking_requests br ON bg.booking_id = br.id
          WHERE LOWER(bg.guest_email) = ANY($1) 
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < CURRENT_DATE
          GROUP BY LOWER(bg.guest_email)
          UNION ALL
          -- Bookings as added player (past only)
          SELECT LOWER(bm.user_email) as email, MAX(br.request_date) as last_date
          FROM booking_members bm
          JOIN booking_requests br ON bm.booking_id = br.id
          WHERE LOWER(bm.user_email) = ANY($1) 
            AND bm.is_primary IS NOT TRUE 
            AND br.status NOT IN ('cancelled', 'declined')
            AND br.request_date < CURRENT_DATE
          GROUP BY LOWER(bm.user_email)
          UNION ALL
          -- Events (past only)
          SELECT LOWER(er.user_email) as email, MAX(e.event_date) as last_date
          FROM event_rsvps er
          JOIN events e ON er.event_id = e.id
          WHERE LOWER(er.user_email) = ANY($1) 
            AND er.status != 'cancelled'
            AND e.event_date < CURRENT_DATE
          GROUP BY LOWER(er.user_email)
          UNION ALL
          -- Wellness (past only)
          SELECT LOWER(we.user_email) as email, MAX(wc.date) as last_date
          FROM wellness_enrollments we
          JOIN wellness_classes wc ON we.class_id = wc.id
          WHERE LOWER(we.user_email) = ANY($1) 
            AND we.status != 'cancelled'
            AND wc.date < CURRENT_DATE
          GROUP BY LOWER(we.user_email)
        ) combined
        GROUP BY email`,
        [memberEmails]
      );
      for (const row of lastActivityResult.rows || []) {
        if (row.last_date) {
          // Handle both Date objects and strings from PostgreSQL
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
      const isActive = status === 'active' || !status;
      
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

router.post('/api/visitors', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, firstName, lastName, phone, createStripeCustomer = true } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const existingUser = await pool.query(
      'SELECT id, email, role, membership_status, first_name, last_name FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    // If user exists, check if we should link Stripe customer instead of erroring
    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];
      
      // Check if this is a non-member/lead that needs Stripe linking
      const isNonMemberOrLead = ['non-member', 'visitor', 'lead'].includes(user.membership_status) || 
                                ['visitor', 'lead'].includes(user.role);
      
      if (isNonMemberOrLead && createStripeCustomer) {
        // Link Stripe customer to existing non-member record
        let stripeCustomerId: string | null = null;
        try {
          const fullName = [firstName || user.first_name, lastName || user.last_name].filter(Boolean).join(' ') || undefined;
          const result = await getOrCreateStripeCustomer(user.id, normalizedEmail, fullName, 'visitor');
          stripeCustomerId = result.customerId;
          console.log(`[Visitors] Linked Stripe customer ${stripeCustomerId} to existing non-member ${normalizedEmail}`);
          
          // Update user's role to visitor if they were just a lead
          if (user.membership_status === 'non-member') {
            await pool.query(
              'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2',
              ['visitor', user.id]
            );
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
      
      // For actual members or other roles, return conflict error
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
    
    const insertResult = await pool.query(`
      INSERT INTO users (id, email, first_name, last_name, phone, role, membership_status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'visitor', 'visitor', NOW(), NOW())
      RETURNING id, email, first_name, last_name, phone, role, membership_status
    `, [userId, normalizedEmail, firstName || null, lastName || null, phone || null]);
    
    const newUser = insertResult.rows[0];
    let stripeCustomerId: string | null = null;
    
    if (createStripeCustomer) {
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
    const { query, limit = '10' } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.json([]);
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(limit as string) || 10, 50);
    
    const results = await pool.query(`
      SELECT id, email, first_name, last_name, phone, stripe_customer_id
      FROM users
      WHERE (role = 'visitor' OR membership_status = 'visitor')
      AND archived_at IS NULL
      AND (
        LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE $1
        OR LOWER(COALESCE(first_name, '')) LIKE $1
        OR LOWER(COALESCE(last_name, '')) LIKE $1
        OR LOWER(COALESCE(email, '')) LIKE $1
      )
      ORDER BY first_name, last_name
      LIMIT $2
    `, [searchTerm, maxResults]);
    
    const visitors = results.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name || '',
      lastName: row.last_name || '',
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      phone: row.phone,
      hasStripeCustomer: !!row.stripe_customer_id
    }));
    
    res.json(visitors);
  } catch (error: any) {
    console.error('[Visitors] Search error:', error);
    res.status(500).json({ error: 'Failed to search visitors' });
  }
});

// Backfill visitor types from activity data
router.post('/api/visitors/backfill-types', isAdmin, async (req, res) => {
  try {
    // First, backfill day_pass types from day_pass_purchases
    const dayPassResult = await pool.query(`
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
    
    // Then, backfill guest types from booking_guests (only if not already day_pass)
    const guestResult = await pool.query(`
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
    
    // Finally, set remaining as 'lead'
    const leadResult = await pool.query(`
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
        dayPassCount: dayPassResult.rowCount,
        guestCount: guestResult.rowCount,
        leadCount: leadResult.rowCount,
        triggeredBy: staffEmail
      }
    });
    
    res.json({
      success: true,
      updated: {
        dayPass: dayPassResult.rowCount,
        guest: guestResult.rowCount,
        lead: leadResult.rowCount
      }
    });
  } catch (error: any) {
    console.error('[Visitors] Backfill types error:', error);
    res.status(500).json({ error: error.message || 'Failed to backfill visitor types' });
  }
});

// Delete a visitor permanently with optional Stripe/HubSpot data removal
router.delete('/api/visitors/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteFromHubSpot, deleteFromStripe } = req.query;
    const sessionUser = getSessionUser(req);
    const userId = parseInt(id, 10);
    
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid visitor ID' });
    }
    
    // Get visitor details
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
      .where(eq(users.id, userId));
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Visitor not found' });
    }
    
    const visitor = userResult[0];
    
    // Verify this is actually a visitor (not a member)
    if (visitor.tier || (visitor.role && visitor.role !== 'visitor')) {
      return res.status(400).json({ 
        error: 'Cannot delete: This is a member, not a visitor. Use the member deletion flow instead.' 
      });
    }
    
    const visitorName = `${visitor.firstName || ''} ${visitor.lastName || ''}`.trim() || visitor.email;
    const deletionLog: string[] = [];
    
    // Delete related records first (before deleting user due to foreign keys)
    await pool.query('DELETE FROM day_pass_purchases WHERE user_id = $1', [userId]);
    deletionLog.push('day_pass_purchases');
    
    await pool.query('DELETE FROM booking_guests WHERE LOWER(guest_email) = LOWER($1)', [visitor.email]);
    deletionLog.push('booking_guests');
    
    await pool.query('DELETE FROM member_notes WHERE member_email = $1', [visitor.email]);
    deletionLog.push('member_notes');
    
    await pool.query('DELETE FROM communication_logs WHERE member_email = $1', [visitor.email]);
    deletionLog.push('communication_logs');
    
    await pool.query('DELETE FROM legacy_purchases WHERE LOWER(member_email) = LOWER($1)', [visitor.email]);
    deletionLog.push('legacy_purchases');
    
    await pool.query('DELETE FROM booking_participants WHERE user_id = $1', [userId]);
    deletionLog.push('booking_participants');
    
    // Delete from Stripe if requested
    let stripeDeleted = false;
    if (deleteFromStripe === 'true' && visitor.stripeCustomerId) {
      try {
        const { getStripe } = await import('../core/stripe');
        const stripe = getStripe();
        await stripe.customers.del(visitor.stripeCustomerId);
        stripeDeleted = true;
        deletionLog.push('stripe_customer');
      } catch (stripeError: any) {
        console.error(`[Visitors] Failed to delete Stripe customer ${visitor.stripeCustomerId}:`, stripeError.message);
      }
    }
    
    // Archive from HubSpot if requested (HubSpot only supports archive, not permanent delete)
    let hubspotArchived = false;
    if (deleteFromHubSpot === 'true' && visitor.hubspotId) {
      try {
        const { getHubSpotClient } = await import('../core/integrations');
        const hubspot = await getHubSpotClient();
        await hubspot.crm.contacts.basicApi.archive(visitor.hubspotId);
        hubspotArchived = true;
        deletionLog.push('hubspot_contact (archived)');
      } catch (hubspotError: any) {
        console.error(`[Visitors] Failed to archive HubSpot contact ${visitor.hubspotId}:`, hubspotError.message);
      }
    }
    
    // Finally delete the user record
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    deletionLog.push('users');
    
    // Log the deletion action
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
