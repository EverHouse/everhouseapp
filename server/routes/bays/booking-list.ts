import { Router } from 'express';
import { db } from '../../db';
import { bookingRequests, resources, users, bookingParticipants } from '../../../shared/schema';
import { eq, and, or, desc, sql, SQL } from 'drizzle-orm';
import { logAndRespond } from '../../core/logger';
import { getSessionUser } from '../../types/session';
import { isStaffOrAdminCheck } from './helpers';
import { isAuthenticated } from '../../core/middleware';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';

const router = Router();

const bookingRequestsQuerySchema = z.object({
  user_email: z.string().optional(),
  status: z.string().optional(),
  include_all: z.enum(['true', 'false']).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
  page: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/booking-requests', isAuthenticated, validateQuery(bookingRequestsQuerySchema), async (req, res) => {
  try {
    const { user_email, status, include_all, limit: limitParam, offset: offsetParam, page: pageParam } = (req as unknown as { validatedQuery: z.infer<typeof bookingRequestsQuerySchema> }).validatedQuery;
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestedEmail = (user_email as string)?.trim()?.toLowerCase();
    
    const isStaffRequest = include_all === 'true';
    
    if (isStaffRequest) {
      const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
      if (!hasStaffAccess) {
        return res.status(403).json({ error: 'Staff access required to view all requests' });
      }
    } else if (user_email) {
      if (requestedEmail !== sessionEmail) {
        const hasStaffAccess = await isStaffOrAdminCheck(sessionEmail);
        if (!hasStaffAccess) {
          return res.status(403).json({ error: 'You can only view your own booking requests' });
        }
      }
    } else {
      return res.status(400).json({ error: 'user_email or include_all parameter required' });
    }
    
    const conditions: (SQL | undefined)[] = [];
    
    conditions.push(
      or(
        eq(bookingRequests.isUnmatched, false),
        sql`${bookingRequests.isUnmatched} IS NULL`
      )
    );
    
    if (user_email && !include_all) {
      const userEmailLower = (user_email as string).toLowerCase();
      conditions.push(
        or(
          sql`LOWER(${bookingRequests.userEmail}) = ${userEmailLower}`,
          sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.linked_email) FROM user_linked_emails ule WHERE LOWER(ule.primary_email) = ${userEmailLower})`,
          sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.primary_email) FROM user_linked_emails ule WHERE LOWER(ule.linked_email) = ${userEmailLower})`,
          sql`${bookingRequests.sessionId} IN (SELECT bp.session_id FROM booking_participants bp JOIN users u ON bp.user_id = u.id WHERE LOWER(u.email) = ${userEmailLower})`
        )
      );
    }
    
    if (status) {
      conditions.push(eq(bookingRequests.status, status as string));
    }
    
    let limit: number | undefined;
    if (limitParam) {
      limit = parseInt(limitParam as string, 10);
      if (isNaN(limit)) return res.status(400).json({ error: 'Invalid limit parameter' });
      limit = Math.min(limit, 500);
    }
    
    let page: number | undefined;
    if (pageParam) {
      page = parseInt(pageParam as string, 10);
      if (isNaN(page)) return res.status(400).json({ error: 'Invalid page parameter' });
      page = Math.max(1, page);
    }
    
    let offset: number | undefined;
    if (offsetParam) {
      offset = parseInt(offsetParam as string, 10);
      if (isNaN(offset)) return res.status(400).json({ error: 'Invalid offset parameter' });
    }
    if (page && limit) {
      offset = (page - 1) * limit;
    }
    
    const isPaginated = !!page;
    
    let query = db.select({
      id: bookingRequests.id,
      user_email: bookingRequests.userEmail,
      user_name: sql<string>`COALESCE(
        NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
        ${bookingRequests.userName}
      )`.as('user_name'),
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
      reviewed_by: bookingRequests.reviewedBy,
      reviewed_at: bookingRequests.reviewedAt,
      created_at: bookingRequests.createdAt,
      updated_at: bookingRequests.updatedAt,
      calendar_event_id: bookingRequests.calendarEventId,
      resource_name: resources.name,
      resource_type: resources.type,
      tier: users.tier,
      guest_count: bookingRequests.guestCount,
      trackman_player_count: bookingRequests.trackmanPlayerCount,
      declared_player_count: bookingRequests.declaredPlayerCount,
      member_notes: bookingRequests.memberNotes,
      session_id: bookingRequests.sessionId,
      guardian_name: bookingRequests.guardianName,
      guardian_relationship: bookingRequests.guardianRelationship,
      guardian_phone: bookingRequests.guardianPhone,
      guardian_consent_at: bookingRequests.guardianConsentAt,
      is_unmatched: bookingRequests.isUnmatched,
      request_participants: bookingRequests.requestParticipants
    })
    .from(bookingRequests)
    .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .leftJoin(users, sql`LOWER(${bookingRequests.userEmail}) = LOWER(${users.email})`)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(bookingRequests.createdAt));
    
    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }
    if (offset !== undefined && offset > 0) {
      query = query.offset(offset) as typeof query;
    }
    
    let totalCount = 0;
    if (isPaginated) {
      const countResult = await db.select({
        count: sql<number>`count(*)::int`
      })
      .from(bookingRequests)
      .leftJoin(users, sql`LOWER(${bookingRequests.userEmail}) = LOWER(${users.email})`)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
      totalCount = countResult[0]?.count || 0;
    }
    
    const result = await query;
    
    if (result.length === 0) {
      if (isPaginated) {
        return res.json({
          data: [],
          pagination: {
            total: 0,
            page: page || 1,
            limit: limit || 0,
            totalPages: 0,
            hasMore: false
          }
        });
      }
      return res.json([]);
    }
    
    const _bookingIds = result.map(b => b.id);
    const sessionIds = result.filter(b => b.session_id).map(b => b.session_id!);
    const requestingUserEmail = (user_email as string)?.toLowerCase();
    
    const allParticipants = sessionIds.length > 0 ? await db.select({
      sessionId: bookingParticipants.sessionId,
      participantType: bookingParticipants.participantType,
      userId: bookingParticipants.userId,
      displayName: bookingParticipants.displayName,
      inviteStatus: bookingParticipants.inviteStatus,
      userEmail: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(bookingParticipants)
    .leftJoin(users, eq(bookingParticipants.userId, users.id))
    .where(sql`${bookingParticipants.sessionId} IN (${sql.join(sessionIds.map(id => sql`${id}`), sql`, `)})`) : [];

    const memberCountsMap = new Map<number, { total: number; filled: number }>();
    const guestCountsMap = new Map<number, number>();
    const memberDetailsArr: typeof allParticipants = [];
    const guestDetailsArr: typeof allParticipants = [];
    const inviteStatusMap = new Map<string, string>();

    for (const p of allParticipants) {
      const sid = p.sessionId;
      const counts = memberCountsMap.get(sid) ?? { total: 0, filled: 0 };
      counts.total++;
      if (p.userId) counts.filled++;
      memberCountsMap.set(sid, counts);

      if (p.participantType === 'guest') {
        guestCountsMap.set(sid, (guestCountsMap.get(sid) ?? 0) + 1);
        guestDetailsArr.push(p);
      } else {
        memberDetailsArr.push(p);
      }

      if (requestingUserEmail && !isStaffRequest && p.userEmail?.toLowerCase() === requestingUserEmail) {
        inviteStatusMap.set(String(sid), p.inviteStatus || '');
      }
    }
    
    const pendingBookings = result.filter(b => b.status === 'pending' || b.status === 'pending_approval');
    const conflictMap = new Map<number, { hasConflict: boolean; conflictingName: string | null }>();
    
    if (pendingBookings.length > 0) {
      const pendingPairs = pendingBookings
        .filter(b => b.resource_id)
        .map(b => ({ resourceId: b.resource_id!, date: b.request_date, startTime: b.start_time, endTime: b.end_time, id: b.id }));
      
      if (pendingPairs.length > 0) {
        const uniqueDates = [...new Set(pendingPairs.map(p => p.date))];
        const uniqueResourceIds = [...new Set(pendingPairs.map(p => p.resourceId))];
        
        const confirmedBookings = await db.select({
          id: bookingRequests.id,
          resourceId: bookingRequests.resourceId,
          requestDate: bookingRequests.requestDate,
          startTime: bookingRequests.startTime,
          endTime: bookingRequests.endTime,
          userName: bookingRequests.userName
        })
        .from(bookingRequests)
        .where(and(
          sql`${bookingRequests.resourceId} IN (${sql.join(uniqueResourceIds.map(id => sql`${id}`), sql`, `)})`,
          sql`${bookingRequests.requestDate} IN (${sql.join(uniqueDates.map(d => sql`${d}`), sql`, `)})`,
          or(
            eq(bookingRequests.status, 'approved'),
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'attended')
          )
        ));
        
        for (const pending of pendingPairs) {
          const conflicts = confirmedBookings.filter(confirmed => 
            confirmed.resourceId === pending.resourceId &&
            confirmed.requestDate === pending.date &&
            confirmed.id !== pending.id &&
            pending.startTime < confirmed.endTime &&
            pending.endTime > confirmed.startTime
          );
          
          if (conflicts.length > 0) {
            conflictMap.set(pending.id, { 
              hasConflict: true, 
              conflictingName: conflicts[0].userName || null 
            });
          }
        }
      }
    }
    
    const memberDetailsMap = new Map<number, Array<{ name: string; type: 'member'; isPrimary: boolean }>>();
    for (const m of memberDetailsArr) {
      if (!memberDetailsMap.has(m.sessionId)) {
        memberDetailsMap.set(m.sessionId, []);
      }
      if (m.userEmail) {
        const fullName = [m.firstName, m.lastName].filter(Boolean).join(' ');
        memberDetailsMap.get(m.sessionId)!.push({
          name: fullName || m.userEmail,
          type: 'member',
          isPrimary: m.participantType === 'owner'
        });
      }
    }
    
    const guestDetailsMap = new Map<number, Array<{ name: string; type: 'guest' }>>();
    for (const g of guestDetailsArr) {
      if (!guestDetailsMap.has(g.sessionId)) {
        guestDetailsMap.set(g.sessionId, []);
      }
      guestDetailsMap.get(g.sessionId)!.push({
        name: g.displayName || 'Guest',
        type: 'guest'
      });
    }
    
    const enrichedResult = result.map((booking) => {
      const mutableBooking = booking as { [key: string]: unknown };
      if (!isStaffRequest) {
        delete mutableBooking.staff_notes;
      }
      const memberCounts = (booking.session_id ? memberCountsMap.get(booking.session_id) : undefined) || { total: 0, filled: 0 };
      const actualGuestCount = (booking.session_id ? guestCountsMap.get(booking.session_id) : undefined) || 0;
      
      const legacyGuestCount = booking.guest_count || 0;
      const trackmanPlayerCount = booking.trackman_player_count;
      
      let totalPlayerCount: number;
      if (trackmanPlayerCount && trackmanPlayerCount > 0) {
        totalPlayerCount = trackmanPlayerCount;
      } else if (memberCounts.total > 0) {
        totalPlayerCount = memberCounts.total;
      } else {
        totalPlayerCount = Math.max((legacyGuestCount as number) + 1, 1);
      }
      
      const isPrimaryBooker = booking.user_email?.toLowerCase() === requestingUserEmail;
      const isLinkedMember = !isPrimaryBooker && !!requestingUserEmail;
      const primaryBookerName = isLinkedMember ? (booking.user_name || booking.user_email) : null;
      
      const inviteStatus = (isLinkedMember && booking.session_id) 
        ? (inviteStatusMap.get(String(booking.session_id)) || null)
        : null;
      
      const members = (booking.session_id ? memberDetailsMap.get(booking.session_id) : undefined) || [];
      const guests = (booking.session_id ? guestDetailsMap.get(booking.session_id) : undefined) || [];
      const nonPrimaryMembers = members.filter(m => !m.isPrimary);
      const participants: Array<{ name: string; type: 'member' | 'guest' }> = [
        ...nonPrimaryMembers.map(m => ({ name: m.name, type: 'member' as const })),
        ...guests.map(g => ({ name: g.name, type: 'guest' as const }))
      ];
      
      const conflictInfo = conflictMap.get(booking.id);
      
      return {
        ...booking,
        linked_member_count: memberCounts.filled,
        guest_count: actualGuestCount,
        total_player_count: totalPlayerCount,
        is_linked_member: isLinkedMember || false,
        primary_booker_name: primaryBookerName,
        invite_status: inviteStatus,
        participants,
        has_conflict: conflictInfo?.hasConflict || false,
        conflicting_booking_name: conflictInfo?.conflictingName || null
      };
    });
    
    if (isPaginated) {
      const totalPages = limit ? Math.ceil(totalCount / limit) : 1;
      const currentPage = page || 1;
      res.json({
        data: enrichedResult,
        pagination: {
          total: totalCount,
          page: currentPage,
          limit: limit || enrichedResult.length,
          totalPages,
          hasMore: currentPage < totalPages
        }
      });
    } else {
      res.json(enrichedResult);
    }
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to fetch booking requests', error);
  }
});

export default router;
