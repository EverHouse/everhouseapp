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
  bookingMembers
} from '../../shared/schema';
import { isProduction } from '../core/db';
import { isStaffOrAdmin, isAuthenticated } from '../core/middleware';
import { getSessionUser } from '../types/session';
import { updateHubSpotContactPreferences } from '../core/memberSync';

const router = Router();

function redactEmail(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [localPart, domain] = email.split('@');
  const prefix = localPart.slice(0, 2);
  return `${prefix}***@${domain}`;
}

router.get('/api/members/search', isAuthenticated, async (req, res) => {
  try {
    const { query, limit = '10', excludeId } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.json([]);
    }
    
    const searchTerm = `%${query.trim().toLowerCase()}%`;
    const maxResults = Math.min(parseInt(limit as string) || 10, 50);
    
    let whereConditions = and(
      sql`${users.membershipStatus} = 'active'`,
      sql`${users.archivedAt} IS NULL`,
      sql`(
        LOWER(COALESCE(${users.firstName}, '') || ' ' || COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.firstName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.lastName}, '')) LIKE ${searchTerm}
        OR LOWER(COALESCE(${users.email}, '')) LIKE ${searchTerm}
      )`
    );
    
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
    })
      .from(users)
      .where(whereConditions)
      .limit(maxResults);
    
    const formattedResults = results.map(user => ({
      id: user.id,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown',
      emailRedacted: redactEmail(user.email || ''),
      tier: user.tier || undefined,
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
    
    // Count past bookings (excluding cancelled/declined)
    // Include bookings where user is primary booker OR linked via booking_members
    const pastBookingsResult = await db.execute(sql`
      SELECT COUNT(DISTINCT br.id) as count FROM booking_requests br
      LEFT JOIN booking_members bm ON br.id = bm.booking_id
      WHERE br.request_date < CURRENT_DATE
      AND br.status NOT IN ('cancelled', 'declined')
      AND (
        LOWER(br.user_email) = ${normalizedEmail}
        OR LOWER(bm.user_email) = ${normalizedEmail}
      )
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
    
    const lastBookingResult = await db.select({ bookingDate: bookingRequests.requestDate })
      .from(bookingRequests)
      .where(and(
        sql`LOWER(${bookingRequests.userEmail}) = ${normalizedEmail}`,
        sql`${bookingRequests.requestDate} < CURRENT_DATE`,
        sql`${bookingRequests.status} NOT IN ('cancelled', 'declined')`
      ))
      .orderBy(desc(bookingRequests.requestDate))
      .limit(1);
    
    const lastBookingDate = lastBookingResult[0]?.bookingDate || null;
    
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
    
    // Visit history: include bookings where member is primary OR linked
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
          sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_members WHERE LOWER(user_email) = ${normalizedEmail})`
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
    
    // Calculate past counts for attended visits
    const today = new Date().toISOString().split('T')[0];
    
    // Past bookings: all bookings where date < today (excluding cancelled/declined)
    const pastBookingsCount = enrichedBookingHistory.filter(b => {
      const dateValue = b.bookingDate as string | Date | null;
      const bookingDate = typeof dateValue === 'string' 
        ? dateValue.split('T')[0] 
        : (dateValue as Date | null)?.toISOString?.()?.split('T')[0] || '';
      const status = (b.status || '').toLowerCase();
      return bookingDate < today && status !== 'cancelled' && status !== 'declined';
    }).length;
    
    // Past events: RSVPs where event date < today (excluding cancelled)
    const pastEventsCount = eventRsvpHistory.filter(r => {
      const dateValue = r.eventDate as string | Date | null;
      const eventDate = typeof dateValue === 'string'
        ? dateValue.split('T')[0]
        : (dateValue as Date | null)?.toISOString?.()?.split('T')[0] || '';
      const status = (r.status || '').toLowerCase();
      return eventDate < today && status !== 'cancelled';
    }).length;
    
    // Past wellness: enrollments where class date < today (excluding cancelled)
    const pastWellnessCount = wellnessHistory.filter(w => {
      const dateValue = w.classDate as string | Date | null;
      const classDate = typeof dateValue === 'string'
        ? dateValue.split('T')[0]
        : (dateValue as Date | null)?.toISOString?.()?.split('T')[0] || '';
      const status = (w.status || '').toLowerCase();
      return classDate < today && status !== 'cancelled';
    }).length;
    
    // Total attended visits = sum of all past activities
    const attendedVisitsCount = pastBookingsCount + pastEventsCount + pastWellnessCount;
    
    res.json({
      bookingHistory: enrichedBookingHistory,
      bookingRequestsHistory: [],
      eventRsvpHistory,
      wellnessHistory,
      guestPassInfo: guestPassInfo,
      guestCheckInsHistory,
      visitHistory,
      pastBookingsCount,
      pastEventsCount,
      pastWellnessCount,
      attendedVisitsCount,
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

router.put('/api/members/:id/role', async (req, res) => {
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

// Update member communication preferences (email/sms opt-in) - for the logged-in user
router.patch('/api/members/me/preferences', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { emailOptIn, smsOptIn } = req.body;
    
    if (emailOptIn === undefined && smsOptIn === undefined) {
      return res.status(400).json({ error: 'No preferences provided' });
    }
    
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (emailOptIn !== undefined) updateData.emailOptIn = emailOptIn;
    if (smsOptIn !== undefined) updateData.smsOptIn = smsOptIn;
    
    const result = await db.update(users)
      .set(updateData)
      .where(eq(users.email, sessionUser.email.toLowerCase()))
      .returning({ 
        emailOptIn: users.emailOptIn, 
        smsOptIn: users.smsOptIn,
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
    
    res.json({ emailOptIn: updated.emailOptIn, smsOptIn: updated.smsOptIn });
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

// Get member communication preferences
router.get('/api/members/me/preferences', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const result = await db.select({ 
      emailOptIn: users.emailOptIn, 
      smsOptIn: users.smsOptIn 
    })
      .from(users)
      .where(eq(users.email, sessionUser.email.toLowerCase()));
    
    if (result.length === 0) {
      return res.json({ emailOptIn: null, smsOptIn: null });
    }
    
    res.json(result[0]);
  } catch (error: any) {
    if (!isProduction) console.error('API error:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

export default router;
