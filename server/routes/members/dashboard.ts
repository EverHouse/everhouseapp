import { Router } from 'express';
import { isAuthenticated } from '../../core/middleware';
import { db } from '../../db';
import { isProduction } from '../../core/db';
import { 
  bookingRequests, 
  resources, 
  eventRsvps, 
  events, 
  wellnessEnrollments, 
  wellnessClasses,
  users,
  guestPasses,
  announcements
} from '../../../shared/schema';
import { eq, and, or, sql, gte, desc, lte, isNull, asc } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry';
import { getTierLimits } from '../../core/tierService';
import { getConferenceRoomBookingsFromCalendar } from '../../core/calendar/index';
import { getConferenceRoomId } from '../../core/affectedAreas';
import { getTodayPacific } from '../../utils/dateUtils';

const router = Router();

router.get('/api/member/dashboard-data', isAuthenticated, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    
    if (!sessionEmail) {
      return res.status(400).json({ error: 'User email is required' });
    }
    
    // Support admin "View As" mode - allow admins to fetch another member's data
    const { member_email } = req.query;
    const isAdmin = sessionUser.role === 'admin';
    let userEmail = sessionEmail;
    let userName = sessionUser.name || '';
    
    if (member_email && typeof member_email === 'string') {
      if (!isAdmin) {
        return res.status(403).json({ error: 'Only admins can view other member data' });
      }
      userEmail = (member_email as string).trim().toLowerCase();
      // Fetch the viewed member's name for proper display
      const viewedMember = await db.select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(sql`LOWER(${users.email}) = ${userEmail}`)
        .limit(1);
      if (viewedMember.length > 0) {
        userName = [viewedMember[0].firstName, viewedMember[0].lastName].filter(Boolean).join(' ') || userEmail;
      }
      logger.info('[dashboard-data] Admin viewing member dashboard', { 
        extra: { adminEmail: sessionEmail, viewingEmail: userEmail }
      });
    } else {
      logger.info('[dashboard-data] Fetching combined dashboard data', { 
        extra: { email: userEmail }
      });
    }
    
    const todayPacific = getTodayPacific();
    const now = new Date();
    
    const fetchBookings = async () => {
      try {
        const conditions = [
          sql`${bookingRequests.archivedAt} IS NULL`,
          or(
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'approved'),
            eq(bookingRequests.status, 'pending_approval'),
            eq(bookingRequests.status, 'pending'),
            eq(bookingRequests.status, 'attended')
          ),
          or(
            eq(bookingRequests.userEmail, userEmail),
            sql`${bookingRequests.sessionId} IN (SELECT bp.session_id FROM booking_participants bp JOIN users u ON bp.user_id = u.id WHERE LOWER(u.email) = ${userEmail})`,
            sql`${bookingRequests.id} IN (
              SELECT br2.id FROM booking_requests br2
              JOIN booking_sessions bs ON bs.id = br2.session_id
              JOIN booking_participants bp ON bp.session_id = bs.id
              JOIN users u ON u.id = bp.user_id
              WHERE LOWER(u.email) = ${userEmail}
            )`
          )
        ];
        
        return await withRetry(() =>
          db.select({
            id: bookingRequests.id,
            resource_id: bookingRequests.resourceId,
            user_email: bookingRequests.userEmail,
            booking_date: bookingRequests.requestDate,
            start_time: bookingRequests.startTime,
            end_time: bookingRequests.endTime,
            status: bookingRequests.status,
            notes: bookingRequests.notes,
            created_at: bookingRequests.createdAt,
            resource_name: resources.name,
            resource_type: resources.type,
            declared_player_count: bookingRequests.declaredPlayerCount
          })
            .from(bookingRequests)
            .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
            .where(and(...conditions))
            .orderBy(asc(bookingRequests.requestDate), asc(bookingRequests.startTime))
        );
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch bookings', { error: error instanceof Error ? error : new Error(String(error)) });
        return [];
      }
    };
    
    const fetchRsvps = async () => {
      try {
        const userLookup = await db.select({ id: users.id })
          .from(users)
          .where(sql`LOWER(${users.email}) = LOWER(${userEmail})`)
          .limit(1);
        
        const conditions = [
          eq(eventRsvps.status, 'confirmed'),
          gte(events.eventDate, todayPacific)
        ];
        
        if (userLookup.length > 0) {
          conditions.push(
            or(
              eq(eventRsvps.userEmail, userEmail),
              eq(eventRsvps.matchedUserId, userLookup[0].id)
            )!
          );
        } else {
          conditions.push(eq(eventRsvps.userEmail, userEmail));
        }
        
        return await db.select({
          id: eventRsvps.id,
          event_id: eventRsvps.eventId,
          user_email: eventRsvps.userEmail,
          status: eventRsvps.status,
          created_at: eventRsvps.createdAt,
          title: events.title,
          event_date: events.eventDate,
          start_time: events.startTime,
          end_time: events.endTime,
          location: events.location,
          category: events.category,
        })
        .from(eventRsvps)
        .innerJoin(events, eq(eventRsvps.eventId, events.id))
        .where(and(...conditions))
        .orderBy(events.eventDate, events.startTime);
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch RSVPs', { error: error instanceof Error ? error : new Error(String(error)) });
        return [];
      }
    };
    
    const fetchWellnessEnrollments = async () => {
      try {
        const conditions = [
          eq(wellnessEnrollments.status, 'confirmed'),
          eq(wellnessEnrollments.userEmail, userEmail),
          gte(wellnessClasses.date, todayPacific)
        ];
        
        return await db.select({
          id: wellnessEnrollments.id,
          class_id: wellnessEnrollments.classId,
          user_email: wellnessEnrollments.userEmail,
          status: wellnessEnrollments.status,
          is_waitlisted: wellnessEnrollments.isWaitlisted,
          created_at: wellnessEnrollments.createdAt,
          title: wellnessClasses.title,
          date: wellnessClasses.date,
          time: wellnessClasses.time,
          instructor: wellnessClasses.instructor,
          duration: wellnessClasses.duration,
          category: wellnessClasses.category,
        })
        .from(wellnessEnrollments)
        .innerJoin(wellnessClasses, eq(wellnessEnrollments.classId, wellnessClasses.id))
        .where(and(...conditions))
        .orderBy(wellnessClasses.date, wellnessClasses.time);
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch wellness enrollments', { error: error instanceof Error ? error : new Error(String(error)) });
        return [];
      }
    };
    
    const fetchBookingRequests = async () => {
      try {
        const conditions = [
          or(
            sql`LOWER(${bookingRequests.userEmail}) = ${userEmail}`,
            sql`${bookingRequests.sessionId} IN (SELECT bp.session_id FROM booking_participants bp JOIN users u ON bp.user_id = u.id WHERE LOWER(u.email) = ${userEmail})`
          )
        ];
        
        return await db.select({
          id: bookingRequests.id,
          user_email: bookingRequests.userEmail,
          user_name: bookingRequests.userName,
          resource_id: bookingRequests.resourceId,
          resource_preference: bookingRequests.resourcePreference,
          request_date: bookingRequests.requestDate,
          start_time: bookingRequests.startTime,
          duration_minutes: bookingRequests.durationMinutes,
          end_time: bookingRequests.endTime,
          notes: bookingRequests.notes,
          status: bookingRequests.status,
          staff_notes: bookingRequests.staffNotes,
          suggested_time: bookingRequests.suggestedTime,
          created_at: bookingRequests.createdAt,
          calendar_event_id: bookingRequests.calendarEventId,
          resource_name: resources.name,
          resource_type: resources.type,
          declared_player_count: bookingRequests.declaredPlayerCount,
          is_linked_member: sql<boolean>`LOWER(${bookingRequests.userEmail}) != ${userEmail}`,
          primary_booker_name: bookingRequests.userName,
        })
        .from(bookingRequests)
        .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
        .where(and(...conditions))
        .orderBy(desc(bookingRequests.createdAt));
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch booking requests', { error: error instanceof Error ? error : new Error(String(error)) });
        return [];
      }
    };
    
    const fetchConferenceRoomBookings = async () => {
      try {
        const bookings = await getConferenceRoomBookingsFromCalendar(userName, userEmail);
        const conferenceRoomId = await getConferenceRoomId();
        
        return bookings.map(booking => ({
          id: `cal_${booking.id}`,
          source: 'calendar',
          resource_id: conferenceRoomId,
          resource_name: 'Conference Room',
          request_date: booking.date,
          start_time: booking.startTime + ':00',
          end_time: booking.endTime + ':00',
          user_name: booking.memberName,
          status: 'approved',
          notes: booking.description,
          calendar_event_id: booking.id
        }));
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch conference room bookings', { error: error instanceof Error ? error : new Error(String(error)) });
        return [];
      }
    };
    
    const fetchWellnessClasses = async () => {
      try {
        const result = await db.execute(sql`
          SELECT wc.*, 
            COALESCE(e.enrolled_count, 0)::integer as enrolled_count,
            COALESCE(w.waitlist_count, 0)::integer as waitlist_count,
            CASE 
              WHEN wc.capacity IS NOT NULL THEN GREATEST(0, wc.capacity - COALESCE(e.enrolled_count, 0))
              WHEN wc.spots ~ '^[0-9]+$' THEN GREATEST(0, CAST(wc.spots AS INTEGER) - COALESCE(e.enrolled_count, 0))
              WHEN wc.spots ~ '^[0-9]+' THEN GREATEST(0, CAST(REGEXP_REPLACE(wc.spots, '[^0-9]', '', 'g') AS INTEGER) - COALESCE(e.enrolled_count, 0))
              ELSE NULL
            END::integer as spots_remaining
          FROM wellness_classes wc
          LEFT JOIN (
            SELECT class_id, COUNT(*)::integer as enrolled_count 
            FROM wellness_enrollments 
            WHERE status = 'confirmed' AND is_waitlisted = false
            GROUP BY class_id
          ) e ON wc.id = e.class_id
          LEFT JOIN (
            SELECT class_id, COUNT(*)::integer as waitlist_count 
            FROM wellness_enrollments 
            WHERE status = 'confirmed' AND is_waitlisted = true
            GROUP BY class_id
          ) w ON wc.id = w.class_id
          WHERE wc.archived_at IS NULL AND wc.date >= ${todayPacific}
          ORDER BY wc.date, wc.time
        `);
        return result.rows;
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch wellness classes', { error: error instanceof Error ? error : new Error(String(error)) });
        return [];
      }
    };
    
    const fetchEvents = async () => {
      try {
        const conditions = [
          sql`${events.archivedAt} IS NULL`,
          gte(events.eventDate, todayPacific)
        ];
        
        return await db.select({
          id: events.id,
          title: events.title,
          description: events.description,
          event_date: events.eventDate,
          start_time: events.startTime,
          end_time: events.endTime,
          location: events.location,
          category: events.category,
          image_url: events.imageUrl,
          max_attendees: events.maxAttendees,
          eventbrite_url: events.eventbriteUrl,
          external_url: events.externalUrl,
          visibility: events.visibility,
          requires_rsvp: events.requiresRsvp,
        })
        .from(events)
        .where(and(...conditions))
        .orderBy(asc(events.eventDate), asc(events.startTime));
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch events', { error: error instanceof Error ? error : new Error(String(error)) });
        return [];
      }
    };
    
    const fetchGuestPasses = async () => {
      try {
        const userResult = await withRetry(() =>
          db.execute(sql`SELECT tier FROM users WHERE LOWER(email) = LOWER(${userEmail}) LIMIT 1`)
        );
        const actualTier = (userResult as unknown as Record<string, unknown> & { rows?: Record<string, unknown>[] }).rows?.[0]?.tier as string || null;
        
        const tierLimits = actualTier ? await getTierLimits(actualTier) : null;
        const passesTotal = tierLimits?.guest_passes_per_month ?? 0;
        
        let result = await withRetry(() => 
          db.select()
            .from(guestPasses)
            .where(sql`LOWER(${guestPasses.memberEmail}) = ${userEmail}`)
            .limit(1)
        );
        
        if (result.length === 0) {
          await withRetry(() =>
            db.insert(guestPasses)
              .values({
                memberEmail: userEmail,
                passesUsed: 0,
                passesTotal: passesTotal
              })
              .onConflictDoNothing()
          );
          result = await withRetry(() =>
            db.select()
              .from(guestPasses)
              .where(sql`LOWER(${guestPasses.memberEmail}) = ${userEmail}`)
              .limit(1)
          );
        } else if (result[0].passesTotal !== passesTotal) {
          const newPassesUsed = Math.min(result[0].passesUsed, passesTotal);
          await withRetry(() =>
            db.update(guestPasses)
              .set({ passesTotal: passesTotal, passesUsed: newPassesUsed })
              .where(sql`LOWER(${guestPasses.memberEmail}) = ${userEmail}`)
          );
          result[0].passesTotal = passesTotal;
          result[0].passesUsed = newPassesUsed;
        }
        
        const data = result[0];
        return {
          passes_used: data.passesUsed,
          passes_total: data.passesTotal,
          passes_remaining: Math.max(0, data.passesTotal - data.passesUsed)
        };
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch guest passes', { error: error instanceof Error ? error : new Error(String(error)) });
        return null;
      }
    };
    
    const fetchBannerAnnouncement = async () => {
      try {
        const results = await db.select().from(announcements)
          .where(
            and(
              eq(announcements.isActive, true),
              sql`show_as_banner = true`,
              or(
                isNull(announcements.startsAt),
                lte(announcements.startsAt, now)
              ),
              or(
                isNull(announcements.endsAt),
                gte(announcements.endsAt, now)
              )
            )
          )
          .orderBy(desc(announcements.createdAt))
          .limit(1);
        
        if (results.length === 0) {
          return null;
        }
        
        const a = results[0];
        return {
          id: a.id.toString(),
          title: a.title,
          desc: a.message || '',
          linkType: a.linkType || undefined,
          linkTarget: a.linkTarget || undefined,
        };
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch banner announcement', { error: error instanceof Error ? error : new Error(String(error)) });
        return null;
      }
    };
    
    const fetchLifetimeVisitCount = async (): Promise<number> => {
      try {
        const result = await db.execute(sql`
          SELECT COUNT(*) as cnt FROM (
            SELECT br.id
            FROM booking_requests br
            WHERE LOWER(br.user_email) = ${userEmail}
              AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
              AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')

            UNION ALL

            SELECT br.id
            FROM booking_requests br
            JOIN booking_sessions bs ON br.session_id = bs.id
            JOIN booking_participants bp ON bp.session_id = bs.id
            LEFT JOIN users bp_user ON bp.user_id = bp_user.id
            LEFT JOIN guests bp_guest ON bp.guest_id = bp_guest.id
            WHERE (LOWER(COALESCE(bp_user.email, bp_guest.email, '')) = ${userEmail})
              AND bp.participant_type != 'owner'
              AND LOWER(br.user_email) != ${userEmail}
              AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
              AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')

            UNION ALL

            SELECT we.id
            FROM wellness_enrollments we
            JOIN wellness_classes wc ON we.class_id = wc.id
            WHERE LOWER(we.user_email) = ${userEmail}
              AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
              AND we.status NOT IN ('cancelled')

            UNION ALL

            SELECT er.id
            FROM event_rsvps er
            JOIN events e ON er.event_id = e.id
            WHERE LOWER(er.user_email) = ${userEmail}
              AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
              AND er.status NOT IN ('cancelled')
          ) visits
        `);
        const rows = result.rows as Record<string, unknown>[];
        return rows.length > 0 ? Number(rows[0].cnt) : 0;
      } catch (error: unknown) {
        logger.warn('[dashboard-data] Failed to fetch lifetime visit count', { error: error instanceof Error ? error : new Error(String(error)) });
        return 0;
      }
    };

    const [
      bookingsResult,
      rsvpsResult,
      wellnessEnrollmentsResult,
      bookingRequestsResult,
      conferenceRoomBookingsResult,
      wellnessClassesResult,
      eventsResult,
      guestPassesResult,
      bannerAnnouncementResult,
      lifetimeVisitCount
    ] = await Promise.all([
      fetchBookings(),
      fetchRsvps(),
      fetchWellnessEnrollments(),
      fetchBookingRequests(),
      fetchConferenceRoomBookings(),
      fetchWellnessClasses(),
      fetchEvents(),
      fetchGuestPasses(),
      fetchBannerAnnouncement(),
      fetchLifetimeVisitCount()
    ]);
    
    logger.info('[dashboard-data] Successfully fetched dashboard data', { 
      extra: { 
        email: userEmail,
        counts: {
          bookings: bookingsResult.length,
          rsvps: rsvpsResult.length,
          wellnessEnrollments: wellnessEnrollmentsResult.length,
          bookingRequests: bookingRequestsResult.length,
          conferenceRoomBookings: conferenceRoomBookingsResult.length,
          wellnessClasses: wellnessClassesResult.length,
          events: eventsResult.length,
          hasGuestPasses: !!guestPassesResult,
          hasBanner: !!bannerAnnouncementResult
        }
      }
    });
    
    res.json({
      bookings: bookingsResult,
      rsvps: rsvpsResult,
      wellnessEnrollments: wellnessEnrollmentsResult,
      bookingRequests: bookingRequestsResult,
      conferenceRoomBookings: conferenceRoomBookingsResult,
      wellnessClasses: wellnessClassesResult,
      events: eventsResult,
      guestPasses: guestPassesResult,
      bannerAnnouncement: bannerAnnouncementResult,
      lifetimeVisitCount
    });
  } catch (error: unknown) {
    logger.error('[dashboard-data] Failed to fetch dashboard data', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

export default router;
