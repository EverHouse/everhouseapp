import { Router } from 'express';
import { eq, and, or, sql, desc, asc, ne } from 'drizzle-orm';
import { db } from '../db';
import { pool } from '../core/db';
import { resources, users, facilityClosures, notifications, bookingRequests, bookingParticipants, bookingMembers } from '../../shared/schema';
import { isAuthorizedForMemberBooking } from '../core/bookingAuth';
import { isStaffOrAdmin } from '../core/middleware';
import { createCalendarEventOnCalendar, getCalendarIdByName, deleteCalendarEvent, CALENDAR_CONFIG } from '../core/calendar/index';
import { logAndRespond, logger } from '../core/logger';
import { sendPushNotification } from './push';
import { DEFAULT_TIER } from '../../shared/constants/tiers';
import { withRetry } from '../core/retry';
import { checkDailyBookingLimit } from '../core/tierService';
import { bookingEvents } from '../core/bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate } from '../core/websocket';
import { checkAllConflicts, parseTimeToMinutes } from '../core/bookingValidation';
import { getSessionUser } from '../types/session';
import { notifyMember, notifyAllStaff } from '../core/notificationService';
import { refundGuestPass } from './guestPasses';
import { createPacificDate, formatDateDisplayWithDay, formatTime12Hour } from '../utils/dateUtils';

interface CancellationCascadeResult {
  participantsNotified: number;
  guestPassesRefunded: number;
  bookingMembersRemoved: number;
  errors: string[];
}

async function handleCancellationCascade(
  bookingId: number,
  sessionId: number | null,
  ownerEmail: string,
  ownerName: string | null,
  requestDate: string,
  startTime: string,
  resourceName?: string
): Promise<CancellationCascadeResult> {
  const result: CancellationCascadeResult = {
    participantsNotified: 0,
    guestPassesRefunded: 0,
    bookingMembersRemoved: 0,
    errors: []
  };

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const bookingStartTime = createPacificDate(requestDate, startTime);
    const now = new Date();
    const hoursUntilStart = (bookingStartTime.getTime() - now.getTime()) / (1000 * 60 * 60);
    const shouldRefundGuestPasses = hoursUntilStart > 24;

    logger.info('[cancellation-cascade] Starting cascade', {
      extra: {
        bookingId,
        sessionId,
        hoursUntilStart: hoursUntilStart.toFixed(1),
        shouldRefundGuestPasses
      }
    });

    const formattedDate = formatDateDisplayWithDay(requestDate);
    const formattedTime = formatTime12Hour(startTime);
    const displayOwner = ownerName || ownerEmail;
    const displayResource = resourceName || 'simulator';

    const membersToNotify: { email: string; participantId: number }[] = [];
    const guestsToRefund: { displayName: string; participantId: number }[] = [];

    if (sessionId) {
      const participantsResult = await client.query(
        `SELECT id, user_id, guest_id, participant_type, display_name 
         FROM booking_participants WHERE session_id = $1`,
        [sessionId]
      );
      const participants = participantsResult.rows;

      for (const participant of participants) {
        if (participant.participant_type === 'member' && participant.user_id) {
          const userResult = await client.query(
            `SELECT email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
            [participant.user_id]
          );
          if (userResult.rows.length > 0) {
            membersToNotify.push({
              email: userResult.rows[0].email,
              participantId: participant.id
            });
          }
        }

        if (participant.participant_type === 'guest' && shouldRefundGuestPasses) {
          guestsToRefund.push({
            displayName: participant.display_name || 'Guest',
            participantId: participant.id
          });
        }
      }

      await client.query(
        `UPDATE booking_participants SET invite_status = 'cancelled' WHERE session_id = $1`,
        [sessionId]
      );
      
      logger.info('[cancellation-cascade] Updated participant invite statuses', {
        extra: { bookingId, sessionId, count: participants.length }
      });
    }

    const deleteResult = await client.query(
      `DELETE FROM booking_members WHERE booking_id = $1 RETURNING id`,
      [bookingId]
    );
    result.bookingMembersRemoved = deleteResult.rows.length;
    
    if (deleteResult.rows.length > 0) {
      logger.info('[cancellation-cascade] Removed booking members', {
        extra: { bookingId, count: deleteResult.rows.length }
      });
    }

    await client.query('COMMIT');

    for (const member of membersToNotify) {
      try {
        await notifyMember({
          userEmail: member.email,
          title: 'Booking Cancelled',
          message: `${displayOwner}'s ${displayResource} booking on ${formattedDate} at ${formattedTime} has been cancelled.`,
          type: 'booking_cancelled',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });
        result.participantsNotified++;
        logger.info('[cancellation-cascade] Notified member participant', {
          extra: { bookingId, memberEmail: member.email, participantId: member.participantId }
        });
      } catch (notifyError) {
        const errorMsg = `Failed to notify participant ${member.email}: ${(notifyError as Error).message}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg, { error: notifyError as Error });
      }
    }

    const refundedGuests = new Set<number>();
    for (const guest of guestsToRefund) {
      if (refundedGuests.has(guest.participantId)) {
        continue;
      }
      try {
        const refundResult = await refundGuestPass(
          ownerEmail,
          guest.displayName,
          false
        );
        
        if (refundResult.success) {
          result.guestPassesRefunded++;
          refundedGuests.add(guest.participantId);
          logger.info('[cancellation-cascade] Guest pass refunded', {
            extra: {
              bookingId,
              ownerEmail,
              guestName: guest.displayName,
              remainingPasses: refundResult.remaining
            }
          });
        } else {
          result.errors.push(`Failed to refund guest pass for ${guest.displayName}: ${refundResult.error}`);
        }
      } catch (refundError) {
        const errorMsg = `Failed to refund guest pass for ${guest.displayName}: ${(refundError as Error).message}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg, { error: refundError as Error });
      }
    }

    if (result.guestPassesRefunded > 0) {
      try {
        await notifyMember({
          userEmail: ownerEmail,
          title: 'Guest Passes Refunded',
          message: `${result.guestPassesRefunded} guest pass${result.guestPassesRefunded > 1 ? 'es have' : ' has'} been refunded due to your booking cancellation (cancelled more than 24 hours in advance).`,
          type: 'guest_pass',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });
      } catch (notifyError) {
        logger.warn('[cancellation-cascade] Failed to notify owner about guest pass refund', { error: notifyError as Error });
      }
    }

    logger.info('[cancellation-cascade] Cascade complete', {
      extra: {
        bookingId,
        ...result,
        errorCount: result.errors.length
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    const errorMsg = `Cascade error: ${(error as Error).message}`;
    result.errors.push(errorMsg);
    logger.error('[cancellation-cascade] Fatal error during cascade', { error: error as Error });
  } finally {
    client.release();
  }

  return result;
}

const router = Router();

router.get('/api/resources', async (req, res) => {
  try {
    const result = await withRetry(() =>
      db.select()
        .from(resources)
        .orderBy(asc(resources.type), asc(resources.name))
    );
    res.json(result);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch resources', error, 'RESOURCES_FETCH_ERROR');
  }
});

router.get('/api/bookings/check-existing', async (req, res) => {
  try {
    const userEmail = getSessionUser(req)?.email?.toLowerCase();
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { date, resource_type } = req.query;
    
    if (!date || typeof date !== 'string') {
      return res.status(400).json({ error: 'Date parameter required' });
    }
    
    const resourceTypeFilter = resource_type && typeof resource_type === 'string' ? resource_type : 'simulator';
    
    const existingBookings = await db.select({
      id: bookingRequests.id,
      resourceId: bookingRequests.resourceId,
      resourceName: resources.name,
      resourceType: resources.type,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      endTime: bookingRequests.endTime,
      status: bookingRequests.status,
      reviewedBy: bookingRequests.reviewedBy
    })
      .from(bookingRequests)
      .leftJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        eq(bookingRequests.userEmail, userEmail),
        sql`${bookingRequests.requestDate} = ${date}`,
        or(
          eq(resources.type, resourceTypeFilter),
          sql`${resources.type} IS NULL`
        ),
        or(
          eq(bookingRequests.status, 'confirmed'),
          eq(bookingRequests.status, 'pending'),
          eq(bookingRequests.status, 'pending_approval'),
          eq(bookingRequests.status, 'approved')
        )
      ));
    
    const hasExisting = existingBookings.length > 0;
    const staffCreated = existingBookings.some(b => b.reviewedBy !== null && b.status === 'approved');
    
    res.json({
      hasExisting,
      bookings: existingBookings.map(b => ({
        id: b.id,
        resourceName: b.resourceName,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        isStaffCreated: b.reviewedBy !== null && b.status === 'approved'
      })),
      staffCreated
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to check existing bookings', error, 'CHECK_EXISTING_ERROR');
  }
});

router.get('/api/bookings/check-existing-staff', isStaffOrAdmin, async (req, res) => {
  try {
    const { member_email, date, resource_type } = req.query;
    
    if (!member_email || !date || !resource_type) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const existingBookings = await db.select({
      id: bookingRequests.id,
      resourceType: resources.type
    })
      .from(bookingRequests)
      .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
      .where(and(
        eq(bookingRequests.userEmail, (member_email as string).toLowerCase()),
        sql`${bookingRequests.requestDate} = ${date}`,
        eq(resources.type, resource_type as string),
        or(
          eq(bookingRequests.status, 'confirmed'),
          eq(bookingRequests.status, 'pending'),
          eq(bookingRequests.status, 'pending_approval'),
          eq(bookingRequests.status, 'approved')
        )
      ));
    
    res.json({ 
      hasExisting: existingBookings.length > 0,
      count: existingBookings.length
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to check existing bookings', error, 'CHECK_EXISTING_ERROR');
  }
});

router.get('/api/bookings', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { user_email: rawEmail, date, resource_id, status } = req.query;
    
    const user_email = rawEmail ? decodeURIComponent(rawEmail as string) : null;
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    
    if (user_email && user_email.toLowerCase() !== sessionEmail) {
      const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
      const isAdmin = await isAdminEmail(sessionEmail);
      if (!isAdmin) {
        const pool = getAuthPool();
        let isStaff = false;
        if (pool) {
          try {
            const result = await queryWithRetry(
              pool,
              'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
              [sessionEmail]
            );
            isStaff = result.rows.length > 0;
          } catch (e) {
            logger.warn('[resources] Staff check query failed:', e);
          }
        }
        if (!isStaff) {
          return res.status(403).json({ error: 'You can only view your own bookings' });
        }
      }
    }
    
    const { include_all, include_archived } = req.query;
    
    let conditions: any[] = [];
    
    // Filter archived records by default unless include_archived=true
    if (include_archived !== 'true') {
      conditions.push(sql`${bookingRequests.archivedAt} IS NULL`);
    }
    
    if (status) {
      conditions.push(eq(bookingRequests.status, status as string));
    } else if (include_all === 'true') {
    } else {
      conditions.push(or(
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'pending_approval'),
        eq(bookingRequests.status, 'pending'),
        eq(bookingRequests.status, 'attended')
      ));
    }
    
    const userEmail = user_email?.toLowerCase();
    if (userEmail) {
      // Include bookings where user is primary OR linked as additional player
      conditions.push(or(
        eq(bookingRequests.userEmail, userEmail),
        sql`${bookingRequests.id} IN (SELECT booking_id FROM booking_members WHERE LOWER(user_email) = ${userEmail})`
      ));
    }
    if (date) {
      conditions.push(sql`${bookingRequests.requestDate} = ${date}`);
    }
    if (resource_id) {
      conditions.push(eq(bookingRequests.resourceId, parseInt(resource_id as string)));
    }
    
    const result = await withRetry(() =>
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
    
    res.json(result);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch bookings', error, 'BOOKINGS_FETCH_ERROR');
  }
});

router.get('/api/pending-bookings', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await withRetry(() =>
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
        first_name: users.firstName,
        last_name: users.lastName,
      })
        .from(bookingRequests)
        .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
        .leftJoin(users, eq(bookingRequests.userEmail, users.email))
        .where(eq(bookingRequests.status, 'pending_approval'))
        .orderBy(desc(bookingRequests.createdAt))
    );
    res.json(result);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch pending bookings', error, 'PENDING_BOOKINGS_ERROR');
  }
});

router.put('/api/bookings/:id/approve', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id);
    
    const result = await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
      
      if (!booking) {
        throw { statusCode: 404, error: 'Booking not found' };
      }
      
      // Check all conflicts: closures, availability blocks, and existing bookings
      const conflictCheck = await checkAllConflicts(
        booking.resourceId!,
        booking.requestDate,
        booking.startTime,
        booking.endTime,
        bookingId  // Exclude this booking from the check
      );
      
      if (conflictCheck.hasConflict) {
        if (conflictCheck.conflictType === 'closure') {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during closure',
            message: `This time slot conflicts with "${conflictCheck.conflictTitle}". Please decline this request or wait until the closure ends.`
          };
        } else if (conflictCheck.conflictType === 'availability_block') {
          throw { 
            statusCode: 409, 
            error: 'Cannot approve booking during event block',
            message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}. Please decline this request or reschedule.`
          };
        }
        // Note: booking conflicts handled by the existing query below for more detailed messaging
      }
      
      const existingConflicts = await tx.select()
        .from(bookingRequests)
        .where(and(
          eq(bookingRequests.resourceId, booking.resourceId!),
          sql`${bookingRequests.requestDate} = ${booking.requestDate}`,
          or(
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'approved'),
            eq(bookingRequests.status, 'pending_approval')
          ),
          ne(bookingRequests.id, bookingId),
          or(
            and(
              sql`${bookingRequests.startTime} < ${booking.endTime}`,
              sql`${bookingRequests.endTime} > ${booking.startTime}`
            )
          )
        ));
      
      if (existingConflicts.length > 0) {
        throw { 
          statusCode: 409, 
          error: 'Time slot already booked',
          message: 'Another booking has already been approved for this time slot. Please decline this request or suggest an alternative time.'
        };
      }
      
      const [updated] = await tx.update(bookingRequests)
        .set({ status: 'confirmed' })
        .where(eq(bookingRequests.id, bookingId))
        .returning();
      
      return updated;
    });
    
    // Broadcast availability update for real-time availability refresh
    broadcastAvailabilityUpdate({
      resourceId: result.resourceId || undefined,
      date: result.requestDate,
      action: 'booked'
    });
    
    res.json(result);
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ 
        error: error.error, 
        message: error.message 
      });
    }
    logAndRespond(req, res, 500, 'Failed to approve booking', error, 'APPROVE_BOOKING_ERROR');
  }
});

router.put('/api/bookings/:id/decline', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id);
    
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
      
      if (!existing) {
        throw { statusCode: 404, error: 'Booking not found' };
      }
      
      const [updated] = await tx.update(bookingRequests)
        .set({ status: 'declined' })
        .where(eq(bookingRequests.id, bookingId))
        .returning();
      
      return updated;
    });
    
    res.json(result);
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.error });
    }
    logAndRespond(req, res, 500, 'Failed to decline booking', error, 'DECLINE_BOOKING_ERROR');
  }
});

router.post('/api/bookings', async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { resource_id, user_email, booking_date, start_time, end_time, notes } = req.body;
    
    if (!resource_id || !user_email || !booking_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Missing required fields: resource_id, user_email, booking_date, start_time, end_time' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    const requestEmail = user_email.toLowerCase();
    
    if (sessionEmail !== requestEmail) {
      const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
      const isAdmin = await isAdminEmail(sessionEmail);
      if (!isAdmin) {
        const pool = getAuthPool();
        let isStaff = false;
        if (pool) {
          try {
            const result = await queryWithRetry(
              pool,
              'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
              [sessionEmail]
            );
            isStaff = result.rows.length > 0;
          } catch (e) {
            logger.warn('[resources] Staff check query failed:', e);
          }
        }
        if (!isStaff) {
          return res.status(403).json({ error: 'You can only create bookings for yourself' });
        }
      }
    }
    
    const userResult = await db.select({
      id: users.id,
      tier: users.tier,
      tags: users.tags,
      firstName: users.firstName,
      lastName: users.lastName
    })
      .from(users)
      .where(eq(users.email, user_email));
    
    const user = userResult[0];
    const userTier = user?.tier || DEFAULT_TIER;
    let userTags: string[] = [];
    try {
      if (user?.tags) {
        userTags = typeof user.tags === 'string' ? JSON.parse(user.tags) : (Array.isArray(user.tags) ? user.tags : []);
      }
    } catch (parseError) {
      console.warn('[POST /api/bookings] Failed to parse user tags for', user_email, parseError);
      userTags = [];
    }
    
    const isMemberAuthorized = await isAuthorizedForMemberBooking(userTier, userTags);
    
    if (!isMemberAuthorized) {
      return res.status(402).json({ 
        error: 'Membership upgrade required',
        bookingType: 'upgrade_required',
        message: 'Simulator booking is available for Core, Premium, VIP, and Corporate members'
      });
    }
    
    const startParts = start_time.split(':').map(Number);
    const endParts = end_time.split(':').map(Number);
    const durationMinutes = (endParts[0] * 60 + endParts[1]) - (startParts[0] * 60 + startParts[1]);
    
    const limitCheck = await checkDailyBookingLimit(user_email, booking_date, durationMinutes, userTier);
    if (!limitCheck.allowed) {
      return res.status(403).json({ 
        error: limitCheck.reason,
        remainingMinutes: limitCheck.remainingMinutes
      });
    }
    
    const existingResult = await db.select()
      .from(bookingRequests)
      .where(and(
        eq(bookingRequests.resourceId, resource_id),
        sql`${bookingRequests.requestDate} = ${booking_date}`,
        or(
          eq(bookingRequests.status, 'confirmed'),
          eq(bookingRequests.status, 'approved'),
          eq(bookingRequests.status, 'pending_approval')
        ),
        or(
          and(
            sql`${bookingRequests.startTime} <= ${start_time}`,
            sql`${bookingRequests.endTime} > ${start_time}`
          ),
          and(
            sql`${bookingRequests.startTime} < ${end_time}`,
            sql`${bookingRequests.endTime} >= ${end_time}`
          ),
          and(
            sql`${bookingRequests.startTime} >= ${start_time}`,
            sql`${bookingRequests.endTime} <= ${end_time}`
          )
        )
      ));
    
    if (existingResult.length > 0) {
      return res.status(409).json({ error: 'This time slot is already requested or booked' });
    }
    
    // Check all conflicts using unified function
    const conflictCheck = await checkAllConflicts(resource_id, booking_date, start_time, end_time);
    if (conflictCheck.hasConflict) {
      if (conflictCheck.conflictType === 'closure') {
        return res.status(409).json({ 
          error: 'Time slot conflicts with a facility closure',
          message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
        });
      } else if (conflictCheck.conflictType === 'availability_block') {
        return res.status(409).json({ 
          error: 'Time slot is blocked for an event',
          message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
        });
      } else {
        return res.status(409).json({ 
          error: 'Time slot already booked',
          message: 'Another booking already exists for this time slot.'
        });
      }
    }
    
    const userName = user?.firstName && user?.lastName 
      ? `${user.firstName} ${user.lastName}` 
      : user_email;
    
    const result = await db.insert(bookingRequests)
      .values({
        resourceId: resource_id,
        userEmail: user_email.toLowerCase(),
        userName: userName,
        requestDate: booking_date,
        startTime: start_time,
        endTime: end_time,
        durationMinutes: durationMinutes,
        notes: notes || null,
        status: 'pending_approval'
      })
      .returning();
    
    res.status(201).json({
      ...result[0],
      message: 'Request sent! Concierge will confirm shortly.'
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to submit booking request', error, 'BOOKING_REQUEST_ERROR');
  }
});

router.get('/api/bookings/:id/cascade-preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id);
    
    const [booking] = await db.select({
      id: bookingRequests.id,
      sessionId: bookingRequests.sessionId
    })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    let participantsCount = 0;
    let membersCount = 0;
    
    if (booking.sessionId) {
      const participantsResult = await db.select({ count: sql<number>`count(*)::int` })
        .from(bookingParticipants)
        .where(eq(bookingParticipants.sessionId, booking.sessionId));
      participantsCount = participantsResult[0]?.count || 0;
    }
    
    const membersResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(bookingMembers)
      .where(eq(bookingMembers.bookingId, bookingId));
    membersCount = membersResult[0]?.count || 0;
    
    res.json({
      bookingId,
      relatedData: {
        participants: participantsCount,
        linkedMembers: membersCount
      },
      hasRelatedData: participantsCount > 0 || membersCount > 0
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch cascade preview', error, 'CASCADE_PREVIEW_ERROR');
  }
});

router.delete('/api/bookings/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id);
    const sessionUser = getSessionUser(req);
    const archivedBy = sessionUser?.email || 'unknown';
    
    const [booking] = await db.select({
      calendarEventId: bookingRequests.calendarEventId,
      resourceId: bookingRequests.resourceId,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      sessionId: bookingRequests.sessionId,
      archivedAt: bookingRequests.archivedAt
    })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    if (booking.archivedAt) {
      return res.status(400).json({ error: 'Booking is already archived' });
    }
    
    let resourceName: string | undefined;
    if (booking.resourceId) {
      const [resource] = await db.select({ name: resources.name, type: resources.type })
        .from(resources)
        .where(eq(resources.id, booking.resourceId));
      resourceName = resource?.name;
    }
    
    await db.update(bookingRequests)
      .set({ 
        status: 'cancelled',
        archivedAt: new Date(),
        archivedBy: archivedBy
      })
      .where(eq(bookingRequests.id, bookingId));
    
    const cascadeResult = await handleCancellationCascade(
      bookingId,
      booking.sessionId,
      booking.userEmail || '',
      booking.userName || null,
      booking.requestDate,
      booking.startTime || '',
      resourceName
    );
    
    logger.info('[DELETE /api/bookings] Soft delete complete', {
      extra: {
        bookingId,
        archivedBy,
        participantsNotified: cascadeResult.participantsNotified,
        guestPassesRefunded: cascadeResult.guestPassesRefunded,
        bookingMembersRemoved: cascadeResult.bookingMembersRemoved,
        cascadeErrors: cascadeResult.errors.length
      }
    });
    
    broadcastAvailabilityUpdate({
      resourceId: booking?.resourceId || undefined,
      date: booking.requestDate,
      action: 'cancelled'
    });
    
    if (booking?.calendarEventId && booking.resourceId) {
      try {
        const [resource] = await db.select({ type: resources.type })
          .from(resources)
          .where(eq(resources.id, booking.resourceId));
        
        if (resource?.type === 'conference_room') {
          const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
          if (calendarId) {
            await deleteCalendarEvent(booking.calendarEventId, calendarId);
          }
        }
      } catch (calError) {
        console.error('Failed to delete calendar event (non-blocking):', calError);
      }
    }
    
    res.json({ 
      success: true,
      archived: true,
      archivedBy,
      cascade: {
        participantsNotified: cascadeResult.participantsNotified,
        guestPassesRefunded: cascadeResult.guestPassesRefunded
      }
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to archive booking', error, 'BOOKING_ARCHIVE_ERROR');
  }
});

router.put('/api/bookings/:id/member-cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const rawSessionEmail = getSessionUser(req)?.email;
    const sessionUserRole = getSessionUser(req)?.role;
    const userEmail = rawSessionEmail?.toLowerCase();
    
    const actingAsEmail = req.body?.acting_as_email?.toLowerCase();
    const isAdminViewingAs = (sessionUserRole === 'admin' || sessionUserRole === 'staff') && actingAsEmail;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const bookingId = parseInt(id);
    
    const [existing] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      status: bookingRequests.status,
      calendarEventId: bookingRequests.calendarEventId,
      resourceId: bookingRequests.resourceId,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      sessionId: bookingRequests.sessionId
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const bookingEmail = existing.userEmail?.toLowerCase();
    
    const isOwnBooking = bookingEmail === userEmail;
    const isValidViewAs = isAdminViewingAs && bookingEmail === actingAsEmail;
    
    if (!isOwnBooking && !isValidViewAs) {
      logger.warn('Member cancel email mismatch', { 
        bookingId, 
        bookingEmail: existing.userEmail, 
        sessionEmail: rawSessionEmail,
        actingAsEmail: actingAsEmail || 'none',
        normalizedBookingEmail: bookingEmail,
        normalizedSessionEmail: userEmail,
        requestId: req.requestId 
      });
      return res.status(403).json({ error: 'You can only cancel your own bookings' });
    }
    
    if (existing.status === 'cancelled') {
      return res.status(400).json({ error: 'Booking is already cancelled' });
    }
    
    let resourceName: string | undefined;
    if (existing.resourceId) {
      const [resource] = await db.select({ name: resources.name, type: resources.type })
        .from(resources)
        .where(eq(resources.id, existing.resourceId));
      resourceName = resource?.name;
    }
    
    await db.update(bookingRequests)
      .set({ status: 'cancelled' })
      .where(eq(bookingRequests.id, bookingId));
    
    const cascadeResult = await handleCancellationCascade(
      bookingId,
      existing.sessionId,
      existing.userEmail || '',
      existing.userName || null,
      existing.requestDate,
      existing.startTime || '',
      resourceName
    );
    
    logger.info('[PUT /api/bookings/member-cancel] Cancellation cascade complete', {
      extra: {
        bookingId,
        participantsNotified: cascadeResult.participantsNotified,
        guestPassesRefunded: cascadeResult.guestPassesRefunded,
        bookingMembersRemoved: cascadeResult.bookingMembersRemoved,
        cascadeErrors: cascadeResult.errors.length
      }
    });
    
    broadcastAvailabilityUpdate({
      resourceId: existing.resourceId || undefined,
      date: existing.requestDate,
      action: 'cancelled'
    });
    
    const friendlyDate = existing.requestDate;
    const friendlyTime = existing.startTime?.substring(0, 5) || '';
    const cancelMessage = `Booking for ${friendlyDate} at ${friendlyTime} was cancelled by member.`;
    
    try {
      await notifyAllStaff(
        'Member Cancelled Booking',
        cancelMessage,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request'
        }
      );
    } catch (staffNotifyErr) {
      console.error('Staff notification failed:', staffNotifyErr);
    }
    
    if (existing.calendarEventId && existing.resourceId) {
      try {
        const [resource] = await db.select({ type: resources.type })
          .from(resources)
          .where(eq(resources.id, existing.resourceId));
        
        if (resource?.type === 'conference_room') {
          const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
          if (calendarId) {
            await deleteCalendarEvent(existing.calendarEventId, calendarId);
          }
        }
      } catch (calError) {
        console.error('Failed to delete calendar event (non-blocking):', calError);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Booking cancelled successfully',
      cascade: {
        participantsNotified: cascadeResult.participantsNotified,
        guestPassesRefunded: cascadeResult.guestPassesRefunded
      }
    });

    bookingEvents.publish('booking_cancelled', {
      bookingId,
      memberEmail: existing.userEmail || '',
      bookingDate: existing.requestDate,
      startTime: existing.startTime || '',
      resourceId: existing.resourceId || undefined,
      status: 'cancelled',
      actionBy: 'member'
    }, { 
      notifyMember: true, 
      notifyStaff: true, 
      cleanupNotifications: true 
    }).catch(err => console.error('Booking event publish failed:', err));
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to cancel booking', error, 'BOOKING_CANCEL_ERROR');
  }
});

router.post('/api/bookings/:id/checkin', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bookingId = parseInt(id);
    const staffEmail = getSessionUser(req)?.email;
    
    const result = await db.update(bookingRequests)
      .set({ status: 'checked_in' })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = result[0];
    res.json({ success: true, booking });

    // Publish booking event for real-time updates
    bookingEvents.publish('booking_checked_in', {
      bookingId,
      memberEmail: booking.userEmail || '',
      bookingDate: booking.requestDate,
      startTime: booking.startTime || '',
      endTime: booking.endTime || '',
      resourceId: booking.resourceId || undefined,
      status: 'checked_in',
      actionBy: 'staff',
      staffEmail: staffEmail
    }, { 
      notifyMember: true, 
      notifyStaff: true,
      cleanupNotifications: true,
      memberNotification: {
        title: 'Checked In',
        message: 'You have been checked in for your booking',
        type: 'booking_checked_in'
      }
    }).catch(err => console.error('Booking event publish failed:', err));
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to check in', error, 'CHECKIN_ERROR');
  }
});

router.post('/api/staff/bookings/manual', isStaffOrAdmin, async (req, res) => {
  try {
    const { 
      member_email, 
      resource_id, 
      booking_date, 
      start_time, 
      duration_minutes, 
      guest_count = 0, 
      booking_source, 
      notes,
      staff_notes,
      reschedule_from_id,
      trackman_booking_id
    } = req.body;

    const staffEmail = getSessionUser(req)?.email;
    if (!staffEmail) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!member_email || !resource_id || !booking_date || !start_time || !duration_minutes || !booking_source) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validSources = ['Trackman', 'YGB', 'Mindbody', 'Texted Concierge', 'Called', 'Other'];
    if (!validSources.includes(booking_source)) {
      return res.status(400).json({ error: 'Invalid booking source' });
    }

    const validDurations = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];
    if (!validDurations.includes(duration_minutes)) {
      return res.status(400).json({ error: 'Invalid duration. Must be between 30 and 300 minutes in 30-minute increments.' });
    }

    const [member] = await db.select()
      .from(users)
      .where(eq(users.email, member_email));

    if (!member) {
      return res.status(404).json({ error: 'Member not found with that email' });
    }

    const [resource] = await db.select()
      .from(resources)
      .where(eq(resources.id, resource_id));

    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    let oldBookingRequest: typeof bookingRequests.$inferSelect | null = null;
    if (reschedule_from_id) {
      const [found] = await db.select()
        .from(bookingRequests)
        .where(eq(bookingRequests.id, reschedule_from_id));
      oldBookingRequest = found || null;
    }

    if (!reschedule_from_id) {
      const existingBookings = await db.select({
        id: bookingRequests.id,
        resourceType: resources.type
      })
        .from(bookingRequests)
        .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
        .where(and(
          eq(bookingRequests.userEmail, member_email.toLowerCase()),
          sql`${bookingRequests.requestDate} = ${booking_date}`,
          eq(resources.type, resource.type),
          or(
            eq(bookingRequests.status, 'confirmed'),
            eq(bookingRequests.status, 'pending'),
            eq(bookingRequests.status, 'pending_approval'),
            eq(bookingRequests.status, 'approved')
          )
        ));
      
      if (existingBookings.length > 0) {
        const resourceTypeLabel = resource.type === 'conference_room' ? 'conference room' : 'bay';
        return res.status(409).json({ 
          error: 'Member already has a booking',
          message: `This member already has a ${resourceTypeLabel} booking on ${booking_date}. Only one ${resourceTypeLabel} booking per day is allowed.`
        });
      }
    }

    const startParts = start_time.split(':').map(Number);
    const startMinutes = startParts[0] * 60 + (startParts[1] || 0);
    const endMinutes = startMinutes + duration_minutes;
    const endHour = Math.floor(endMinutes / 60);
    const endMin = endMinutes % 60;
    const end_time = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;

    // Check all conflicts: closures, availability blocks, and existing bookings
    const conflictCheck = await checkAllConflicts(resource_id, booking_date, start_time, end_time);
    if (conflictCheck.hasConflict) {
      if (conflictCheck.conflictType === 'closure') {
        return res.status(409).json({ 
          error: 'Time slot conflicts with a facility closure',
          message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
        });
      } else if (conflictCheck.conflictType === 'availability_block') {
        return res.status(409).json({ 
          error: 'Time slot is blocked for an event',
          message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
        });
      } else {
        return res.status(409).json({ 
          error: 'Time slot already booked',
          message: 'Another booking already exists for this time slot.'
        });
      }
    }

    // Only create calendar events for conference rooms - golf/simulators no longer sync to calendar
    let calendarEventId: string | null = null;
    if (resource.type === 'conference_room') {
      try {
        const calendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
        
        if (calendarId) {
          const memberName = member.firstName && member.lastName 
            ? `${member.firstName} ${member.lastName}` 
            : member_email;
          
          const summary = `Booking: ${memberName}`;
          const descriptionLines = [
            `Area: ${resource.name}`,
            `Member: ${member_email}`,
            `Guests: ${guest_count}`,
            `Source: ${booking_source}`,
            `Created by: ${staffEmail}`
          ];
          if (notes) {
            descriptionLines.push(`Notes: ${notes}`);
          }
          const description = descriptionLines.join('\n');
          
          calendarEventId = await createCalendarEventOnCalendar(
            calendarId,
            summary,
            description,
            booking_date,
            start_time,
            end_time
          );
        }
      } catch (calErr) {
        logger.error('Calendar event creation error', { error: calErr as Error, requestId: req.requestId });
      }
    }

    const memberName = member.firstName && member.lastName 
      ? `${member.firstName} ${member.lastName}` 
      : member_email;
    
    const bookingNotes = notes 
      ? `${notes}\n[Source: ${booking_source}]` 
      : `[Source: ${booking_source}]`;
    
    const [newBooking] = await db.insert(bookingRequests)
      .values({
        resourceId: resource_id,
        userEmail: member_email,
        userName: memberName,
        resourcePreference: resource.name,
        requestDate: booking_date,
        startTime: start_time,
        endTime: end_time,
        durationMinutes: duration_minutes,
        notes: bookingNotes,
        staffNotes: staff_notes || null,
        status: 'approved',
        guestCount: guest_count,
        reviewedBy: staffEmail,
        reviewedAt: new Date(),
        calendarEventId: calendarEventId,
        trackmanBookingId: trackman_booking_id || null
      })
      .returning();

    if (oldBookingRequest) {
      await db.update(bookingRequests)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(bookingRequests.id, reschedule_from_id as number));
      
      // Only delete calendar events for conference room bookings
      if (oldBookingRequest.calendarEventId && oldBookingRequest.resourceId) {
        try {
          const [oldResource] = await db.select({ type: resources.type })
            .from(resources)
            .where(eq(resources.id, oldBookingRequest.resourceId));
          
          if (oldResource?.type === 'conference_room') {
            const oldCalendarId = await getCalendarIdByName(CALENDAR_CONFIG.conference.name);
            if (oldCalendarId) {
              await deleteCalendarEvent(oldBookingRequest.calendarEventId, oldCalendarId);
            }
          }
        } catch (calErr) {
          logger.warn('Failed to delete old calendar event during reschedule', { error: calErr as Error, requestId: req.requestId });
        }
      }
      
      logger.info('Rescheduled booking - cancelled old, created new', { 
        oldBookingId: reschedule_from_id, 
        newBookingId: newBooking.id,
        memberEmail: member_email,
        requestId: req.requestId 
      });

      // Clean up notifications for the cancelled original booking
      bookingEvents.cleanupNotificationsForBooking(reschedule_from_id as number, { delete: true })
        .catch(err => console.error('Failed to cleanup old booking notifications:', err));
    }

    try {
      const formattedDate = new Date(booking_date + 'T00:00:00').toLocaleDateString('en-US', { 
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles'
      });
      const formatTime = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour12 = h % 12 || 12;
        return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;
      };
      const notifTitle = 'Booking Confirmed';
      const notifMessage = `Your ${resource.type === 'simulator' ? 'golf simulator' : 'conference room'} booking for ${formattedDate} at ${formatTime(start_time)} has been confirmed.`;
      
      await db.insert(notifications).values({
        userEmail: member_email,
        title: notifTitle,
        message: notifMessage,
        type: 'booking_approved',
        relatedId: newBooking.id,
        relatedType: 'booking'
      });
      
      await sendPushNotification(member_email, {
        title: notifTitle,
        body: notifMessage,
        url: '/dashboard'
      });
      
      // Send WebSocket notification to member (DB notification already inserted above)
      sendNotificationToUser(member_email, {
        type: 'notification',
        title: notifTitle,
        message: notifMessage,
        data: { bookingId: newBooking.id, eventType: 'booking_approved' }
      }, { action: 'manual_booking', bookingId: newBooking.id, resourceType: resource.type, triggerSource: 'resources.ts' });
    } catch (notifErr) {
      logger.error('Failed to send manual booking notification', { error: notifErr as Error, requestId: req.requestId });
    }

    // Publish booking event for real-time updates
    bookingEvents.publish('booking_approved', {
      bookingId: newBooking.id,
      memberEmail: member_email,
      memberName: memberName,
      resourceId: resource_id,
      resourceName: resource.name,
      resourceType: resource.type,
      bookingDate: booking_date,
      startTime: start_time,
      endTime: end_time,
      status: 'approved',
      actionBy: 'staff',
      staffEmail: staffEmail,
      isManualBooking: true
    }, { notifyMember: true, notifyStaff: true }).catch(err => console.error('Booking event publish failed:', err));

    res.status(201).json({
      success: true,
      booking: {
        ...newBooking,
        resource_name: resource.name,
        resource_type: resource.type,
        member_name: member.firstName && member.lastName 
          ? `${member.firstName} ${member.lastName}` 
          : null
      },
      message: 'Booking created successfully'
    });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to create manual booking', error, 'MANUAL_BOOKING_ERROR');
  }
});

export default router;
