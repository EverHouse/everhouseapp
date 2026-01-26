import { Router } from 'express';
import { eq, sql, desc, and, or } from 'drizzle-orm';
import { db } from '../../db';
import { 
  users, 
  bookingRequests, 
  bookingMembers, 
  bookingGuests, 
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

const router = Router();

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
      mindbodyClientId: users.mindbodyClientId,
      dateOfBirth: users.dateOfBirth,
      streetAddress: users.streetAddress,
      city: users.city,
      state: users.state,
      zipCode: users.zipCode,
      companyName: users.companyName,
      emailOptIn: users.emailOptIn,
      smsOptIn: users.smsOptIn,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const user = userResult[0];
    
    const pastBookingsResult = await db.execute(sql`
      SELECT COUNT(DISTINCT booking_id) as count FROM (
        SELECT id as booking_id FROM booking_requests
        WHERE LOWER(user_email) = ${normalizedEmail}
          AND request_date < CURRENT_DATE
          AND status NOT IN ('cancelled', 'declined')
        UNION
        SELECT br.id as booking_id FROM booking_requests br
        JOIN booking_members bm ON br.id = bm.booking_id
        WHERE LOWER(bm.user_email) = ${normalizedEmail}
          AND br.request_date < CURRENT_DATE
          AND br.status NOT IN ('cancelled', 'declined')
        UNION
        SELECT br.id as booking_id FROM booking_requests br
        JOIN booking_guests bg ON br.id = bg.booking_id
        WHERE LOWER(bg.guest_email) = ${normalizedEmail}
          AND br.request_date < CURRENT_DATE
          AND br.status NOT IN ('cancelled', 'declined')
      ) all_bookings
    `);
    const pastBookingsCount = Number((pastBookingsResult as any).rows?.[0]?.count || 0);
    
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
    
    const pastWellnessResult = await db.select({ count: sql<number>`COUNT(*)` })
      .from(wellnessEnrollments)
      .innerJoin(wellnessClasses, eq(wellnessEnrollments.classId, wellnessClasses.id))
      .where(and(
        sql`LOWER(${wellnessEnrollments.userEmail}) = ${normalizedEmail}`,
        sql`${wellnessEnrollments.status} != 'cancelled'`,
        sql`${wellnessClasses.date} < CURRENT_DATE`
      ));
    const pastWellnessCount = Number(pastWellnessResult[0]?.count || 0);
    
    const totalLifetimeVisits = pastBookingsCount + pastEventsCount + pastWellnessCount;
    
    const lastActivityResult = await db.execute(sql`
      SELECT MAX(last_date) as last_date FROM (
        SELECT MAX(request_date) as last_date FROM booking_requests
        WHERE LOWER(user_email) = ${normalizedEmail} 
          AND status NOT IN ('cancelled', 'declined')
          AND request_date < CURRENT_DATE
        UNION ALL
        SELECT MAX(br.request_date) as last_date FROM booking_guests bg
        JOIN booking_requests br ON bg.booking_id = br.id
        WHERE LOWER(bg.guest_email) = ${normalizedEmail} 
          AND br.status NOT IN ('cancelled', 'declined')
          AND br.request_date < CURRENT_DATE
        UNION ALL
        SELECT MAX(br.request_date) as last_date FROM booking_members bm
        JOIN booking_requests br ON bm.booking_id = br.id
        WHERE LOWER(bm.user_email) = ${normalizedEmail} 
          AND bm.is_primary IS NOT TRUE 
          AND br.status NOT IN ('cancelled', 'declined')
          AND br.request_date < CURRENT_DATE
        UNION ALL
        SELECT MAX(e.event_date) as last_date FROM event_rsvps er
        JOIN events e ON er.event_id = e.id
        WHERE LOWER(er.user_email) = ${normalizedEmail} 
          AND er.status != 'cancelled'
          AND e.event_date < CURRENT_DATE
        UNION ALL
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
      lastBookingDate,
      dateOfBirth: user.dateOfBirth,
      streetAddress: user.streetAddress,
      city: user.city,
      state: user.state,
      zipCode: user.zipCode,
      companyName: user.companyName,
      emailOptIn: user.emailOptIn,
      smsOptIn: user.smsOptIn,
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
    
    const enrichedBookingHistory = await Promise.all(bookingHistory.map(async (booking) => {
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
      
      const memberSlotsResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingMembers)
        .where(eq(bookingMembers.bookingId, booking.id));
      
      const filledMemberResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingMembers)
        .where(and(
          eq(bookingMembers.bookingId, booking.id),
          sql`${bookingMembers.userEmail} IS NOT NULL`
        ));
      
      const additionalMemberResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingMembers)
        .where(and(
          eq(bookingMembers.bookingId, booking.id),
          sql`${bookingMembers.userEmail} IS NOT NULL`,
          sql`${bookingMembers.isPrimary} IS NOT TRUE`
        ));
      
      const guestResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingGuests)
        .where(eq(bookingGuests.bookingId, booking.id));
      
      const memberSlotsCount = memberSlotsResult[0]?.count || 0;
      const additionalMemberCount = additionalMemberResult[0]?.count || 0;
      const actualGuestCount = guestResult[0]?.count || 0;
      const legacyGuestCount = booking.guestCount || 0;
      
      let totalPlayerCount: number;
      const trackmanPlayerCount = booking.trackmanPlayerCount;
      if (trackmanPlayerCount && trackmanPlayerCount > 0) {
        totalPlayerCount = trackmanPlayerCount;
      } else if (memberSlotsCount > 0) {
        totalPlayerCount = memberSlotsCount + actualGuestCount;
      } else {
        totalPlayerCount = Math.max(legacyGuestCount + 1, 1);
      }
      
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
    
    const guestPassInfo = guestPassRaw[0] ? {
      remainingPasses: guestPassRaw[0].passesTotal - guestPassRaw[0].passesUsed,
      totalUsed: guestPassRaw[0].passesUsed,
      passesTotal: guestPassRaw[0].passesTotal
    } : null;
    
    const guestCheckInsHistory = await db.select()
      .from(guestCheckIns)
      .where(sql`LOWER(${guestCheckIns.memberEmail}) = ${normalizedEmail}`)
      .orderBy(desc(guestCheckIns.checkInDate), desc(guestCheckIns.createdAt));
    
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
    
    // Calculate total attended visits including bookings, events, and wellness
    // - Simulator bookings with status='attended' (already in visitHistory)
    // - Past event RSVPs count as attended visits
    // - Wellness classes with status='attended'
    const attendedBookingsCount = visitHistory.length;
    const now = new Date();
    const attendedEventsCount = eventRsvpHistory.filter((e: any) => {
      const eventDate = new Date(e.eventDate);
      return eventDate < now; // Past events count as attended
    }).length;
    const attendedWellnessCount = wellnessHistory.filter((w: any) => w.status === 'attended').length;
    const totalAttendedVisits = attendedBookingsCount + attendedEventsCount + attendedWellnessCount;
    
    // Return with field names that match frontend MemberHistory interface
    res.json({
      bookingHistory: enrichedBookingHistory,
      bookingRequestsHistory: [], // Legacy field - requests are now included in bookingHistory
      eventRsvpHistory: eventRsvpHistory,
      wellnessHistory: wellnessHistory,
      guestPassInfo: guestPassInfo,
      guestCheckInsHistory: guestCheckInsHistory,
      visitHistory: visitHistory,
      guestAppearances,
      attendedVisitsCount: totalAttendedVisits
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member history error:', error);
    res.status(500).json({ error: 'Failed to fetch member history' });
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
  } catch (error: any) {
    if (!isProduction) console.error('Member cascade preview error:', error);
    res.status(500).json({ error: 'Failed to fetch cascade preview' });
  }
});

export default router;
