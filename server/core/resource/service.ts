import { eq, and, or, sql, desc, asc, ne } from 'drizzle-orm';
import { db } from '../../db';
import { resources, users, bookingRequests, bookingParticipants } from '../../../shared/schema';
import { isAuthorizedForMemberBooking } from '../bookingAuth';
import { logger } from '../logger';
import { withRetry } from '../retry';
import { checkDailyBookingLimit } from '../tierService';
import { sendNotificationToUser, broadcastAvailabilityUpdate } from '../websocket';
import { checkAllConflicts } from '../bookingValidation';
import { ensureSessionForBooking } from '../bookingService/sessionManager';
import { getCached, setCache } from '../queryCache';
import { AppError } from '../errors';
import { getErrorMessage } from '../../utils/errorUtils';
import { ensureDateString, ensureTimeString } from '../../utils/dateTimeUtils';
import { formatTime12Hour } from '../../utils/dateUtils';
import { resolveUserByEmail } from '../stripe/customers';

interface ResourceTypeRow {
  type: string;
}

const RESOURCE_CACHE_KEY = 'all_resources';
const RESOURCE_CACHE_TTL = 60_000;

export async function fetchAllResources() {
  const cached = getCached<Record<string, unknown>[]>(RESOURCE_CACHE_KEY);
  if (cached) return cached;

  const result = await withRetry(() =>
    db.select()
      .from(resources)
      .orderBy(asc(resources.type), asc(resources.name))
  );

  setCache(RESOURCE_CACHE_KEY, result, RESOURCE_CACHE_TTL);
  return result;
}

export async function checkExistingBookings(userEmail: string, date: string, resourceType: string) {
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
      or(
        eq(bookingRequests.userEmail, userEmail),
        sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.linked_email) FROM user_linked_emails ule WHERE LOWER(ule.primary_email) = ${userEmail.toLowerCase()})`,
        sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.primary_email) FROM user_linked_emails ule WHERE LOWER(ule.linked_email) = ${userEmail.toLowerCase()})`,
        sql`${bookingRequests.sessionId} IN (
          SELECT bp.session_id FROM booking_participants bp
          JOIN users u ON bp.user_id = u.id
          WHERE LOWER(u.email) = ${userEmail.toLowerCase()}
        )`
      ),
      sql`${bookingRequests.requestDate} = ${date}`,
      or(
        eq(resources.type, resourceType),
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
  
  return {
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
  };
}

export async function checkExistingBookingsForStaff(memberEmail: string, date: string, resourceType: string) {
  const existingBookings = await db.select({
    id: bookingRequests.id,
    resourceType: resources.type
  })
    .from(bookingRequests)
    .innerJoin(resources, eq(bookingRequests.resourceId, resources.id))
    .where(and(
      or(
        eq(bookingRequests.userEmail, memberEmail.toLowerCase()),
        sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.linked_email) FROM user_linked_emails ule WHERE LOWER(ule.primary_email) = ${memberEmail.toLowerCase()})`,
        sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.primary_email) FROM user_linked_emails ule WHERE LOWER(ule.linked_email) = ${memberEmail.toLowerCase()})`,
        sql`${bookingRequests.sessionId} IN (
          SELECT bp.session_id FROM booking_participants bp
          JOIN users u ON bp.user_id = u.id
          WHERE LOWER(u.email) = ${memberEmail.toLowerCase()}
        )`
      ),
      sql`${bookingRequests.requestDate} = ${date}`,
      eq(resources.type, resourceType),
      or(
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'pending'),
        eq(bookingRequests.status, 'pending_approval'),
        eq(bookingRequests.status, 'approved')
      )
    ));
  
  return { 
    hasExisting: existingBookings.length > 0,
    count: existingBookings.length
  };
}

export async function fetchBookings(params: {
  userEmail?: string | null;
  date?: string | null;
  resourceId?: string | null;
  status?: string | null;
  includeAll?: boolean;
  includeArchived?: boolean;
}) {
  const conditions: ReturnType<typeof eq | typeof sql>[] = [];
  
  if (!params.includeArchived) {
    conditions.push(sql`${bookingRequests.archivedAt} IS NULL`);
  }
  
  if (params.status) {
    conditions.push(eq(bookingRequests.status, params.status));
  } else if (params.includeAll) {
    // intentionally no filter — include all statuses
  } else {
    conditions.push(or(
      eq(bookingRequests.status, 'confirmed'),
      eq(bookingRequests.status, 'approved'),
      eq(bookingRequests.status, 'pending_approval'),
      eq(bookingRequests.status, 'pending'),
      eq(bookingRequests.status, 'attended')
    )!);
  }
  
  if (params.userEmail) {
    const userEmail = params.userEmail.toLowerCase();
    conditions.push(or(
      eq(bookingRequests.userEmail, userEmail),
      sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.linked_email) FROM user_linked_emails ule WHERE LOWER(ule.primary_email) = ${userEmail})`,
      sql`LOWER(${bookingRequests.userEmail}) IN (SELECT LOWER(ule.primary_email) FROM user_linked_emails ule WHERE LOWER(ule.linked_email) = ${userEmail})`,
      sql`${bookingRequests.id} IN (SELECT br2.id FROM booking_requests br2 INNER JOIN booking_participants bp ON bp.session_id = br2.session_id INNER JOIN users u ON u.id = bp.user_id WHERE LOWER(u.email) = ${userEmail})`
    )!);
  }
  if (params.date) {
    conditions.push(sql`${bookingRequests.requestDate} = ${params.date}`);
  }
  if (params.resourceId) {
    conditions.push(eq(bookingRequests.resourceId, parseInt(params.resourceId, 10)));
  }
  
  return withRetry(() =>
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
}

export async function fetchPendingBookings() {
  return withRetry(() =>
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
      .where(and(
        eq(bookingRequests.status, 'pending_approval'),
        or(
          eq(bookingRequests.isUnmatched, false),
          sql`${bookingRequests.isUnmatched} IS NULL`
        )
      ))
      .orderBy(desc(bookingRequests.createdAt))
  );
}

export async function approveBooking(bookingId: number) {
  const result = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
    
    if (!booking) {
      throw new AppError(404, 'Booking not found');
    }
    
    const conflictCheck = await checkAllConflicts(
      booking.resourceId!,
      booking.requestDate,
      booking.startTime,
      booking.endTime,
      bookingId
    );
    
    if (conflictCheck.hasConflict) {
      if (conflictCheck.conflictType === 'closure') {
        throw new AppError(409, 'Cannot approve booking during closure', {
          message: `This time slot conflicts with "${conflictCheck.conflictTitle}". Please decline this request or wait until the closure ends.`
        });
      } else if (conflictCheck.conflictType === 'availability_block') {
        throw new AppError(409, 'Cannot approve booking during event block', {
          message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}. Please decline this request or reschedule.`
        });
      }
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
      throw new AppError(409, 'Time slot already booked', {
        message: 'Another booking has already been approved for this time slot. Please decline this request or suggest an alternative time.'
      });
    }
    
    const [updated] = await tx.update(bookingRequests)
      .set({ status: 'confirmed' })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    if (updated.resourceId) {
      try {
        const dateStr = ensureDateString(updated.requestDate);

        const sessionResult = await ensureSessionForBooking({
          bookingId: updated.id,
          resourceId: updated.resourceId,
          sessionDate: dateStr,
          startTime: updated.startTime || '',
          endTime: updated.endTime || '',
          ownerEmail: updated.userEmail || '',
          ownerName: updated.userName || undefined,
          trackmanBookingId: updated.trackmanBookingId || undefined,
          source: 'member_request',
          createdBy: 'resource_confirmation'
        });
        if (sessionResult.error) {
          logger.error('[Resource Confirmation] Session creation returned error', { extra: { bookingId: updated.id, error: sessionResult.error } });
        }
      } catch (sessionErr: unknown) {
        logger.error('[Resource Confirmation] Failed to ensure session', { error: sessionErr instanceof Error ? sessionErr : new Error(getErrorMessage(sessionErr)) });
      }
    }

    return updated;
  });
  
  broadcastAvailabilityUpdate({
    resourceId: result.resourceId || undefined,
    date: result.requestDate,
    action: 'booked'
  });
  
  sendNotificationToUser(result.userEmail, {
    type: 'booking_update',
    title: 'Booking Confirmed',
    message: `Your booking for ${ensureDateString(result.requestDate)} at ${formatTime12Hour(ensureTimeString(result.startTime))} has been approved.`,
    data: { bookingId, status: 'confirmed' }
  });
  
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function declineBooking(bookingId: number, reason?: string) {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
    
    if (!existing) {
      throw new AppError(404, 'Booking not found');
    }
    
    const [updated] = await tx.update(bookingRequests)
      .set({ 
        status: 'declined',
        trackmanExternalId: null
      })
      .where(eq(bookingRequests.id, bookingId))
      .returning();
    
    return updated;
  });
  
  if (result.resourceId && result.requestDate && result.startTime) {
    try {
      if (result.durationMinutes) {
        const [startHour, startMin] = ensureTimeString(result.startTime, 8).split(':').map(Number);
        const startTotalMin = startHour * 60 + startMin;
        const endTotalMin = startTotalMin + result.durationMinutes;
        const endHour = Math.floor(endTotalMin / 60);
        const endMinute = endTotalMin % 60;
        const endTime = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`;
        await db.execute(sql`DELETE FROM trackman_bay_slots 
           WHERE resource_id = ${result.resourceId} AND slot_date = ${result.requestDate} AND start_time >= ${result.startTime} AND start_time < ${endTime}`);
      } else {
        await db.execute(sql`DELETE FROM trackman_bay_slots 
           WHERE resource_id = ${result.resourceId} AND slot_date = ${result.requestDate} AND start_time = ${result.startTime}`);
      }
    } catch (err: unknown) {
      logger.warn('[Staff Decline] Failed to clean up trackman_bay_slots', { 
        bookingId, 
        resourceId: result.resourceId,
        error: getErrorMessage(err) 
      });
    }
  }
  
  sendNotificationToUser(result.userEmail, {
    type: 'booking_update',
    title: 'Booking Declined',
    message: 'Your booking request has been declined.',
    data: { bookingId, status: 'declined' }
  });
  
  return result;
}

export async function createBookingRequest(params: {
  resourceId: number;
  userEmail: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  notes?: string;
}) {
  let resolvedEmail = params.userEmail.toLowerCase();
  let resolvedUserId: string | null = null;
  const resolved = await resolveUserByEmail(resolvedEmail);
  if (resolved) {
    if (resolved.matchType !== 'direct') {
      logger.info('[ResourceBooking] Resolved linked email to primary', { extra: { originalEmail: resolvedEmail, resolvedEmail: resolved.primaryEmail, matchType: resolved.matchType } });
      resolvedEmail = resolved.primaryEmail.toLowerCase();
    }
    resolvedUserId = resolved.userId;
  }

  const userResult = await db.select({
    id: users.id,
    tier: users.tier,
    tags: users.tags,
    firstName: users.firstName,
    lastName: users.lastName
  })
    .from(users)
    .where(eq(users.email, resolvedEmail));
  
  const user = userResult[0];
  const userTier = user?.tier || null;
  
  const isMemberAuthorized = await isAuthorizedForMemberBooking(userTier);
  
  if (!isMemberAuthorized) {
    throw new AppError(402, 'Membership upgrade required', {
      bookingType: 'upgrade_required',
      message: 'Your current membership tier does not include simulator booking access. Please upgrade your membership.'
    });
  }
  
  const startParts = params.startTime.split(':').map(Number);
  const endParts = params.endTime.split(':').map(Number);
  const durationMinutes = (endParts[0] * 60 + endParts[1]) - (startParts[0] * 60 + startParts[1]);
  
  let resourceType = 'simulator';
  if (params.resourceId) {
    const resourceResult = await db.execute(sql`SELECT type FROM resources WHERE id = ${params.resourceId}`);
    resourceType = (resourceResult.rows as unknown as ResourceTypeRow[])[0]?.type || 'simulator';
  }
  
  const limitCheck = await checkDailyBookingLimit(resolvedEmail, params.bookingDate, durationMinutes, userTier, resourceType);
  if (!limitCheck.allowed) {
    throw new AppError(403, limitCheck.reason ?? 'Booking limit exceeded', {
      remainingMinutes: limitCheck.remainingMinutes
    });
  }
  
  const existingResult = await db.select()
    .from(bookingRequests)
    .where(and(
      eq(bookingRequests.resourceId, params.resourceId),
      sql`${bookingRequests.requestDate} = ${params.bookingDate}`,
      or(
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'pending_approval')
      ),
      or(
        and(
          sql`${bookingRequests.startTime} <= ${params.startTime}`,
          sql`${bookingRequests.endTime} > ${params.startTime}`
        ),
        and(
          sql`${bookingRequests.startTime} < ${params.endTime}`,
          sql`${bookingRequests.endTime} >= ${params.endTime}`
        ),
        and(
          sql`${bookingRequests.startTime} >= ${params.startTime}`,
          sql`${bookingRequests.endTime} <= ${params.endTime}`
        )
      )
    ));
  
  if (existingResult.length > 0) {
    throw new AppError(409, 'This time slot is already requested or booked');
  }
  
  const conflictCheck = await checkAllConflicts(params.resourceId, params.bookingDate, params.startTime, params.endTime);
  if (conflictCheck.hasConflict) {
    if (conflictCheck.conflictType === 'closure') {
      throw new AppError(409, 'Time slot conflicts with a facility closure', {
        message: `This time slot conflicts with "${conflictCheck.conflictTitle}".`
      });
    } else if (conflictCheck.conflictType === 'availability_block') {
      throw new AppError(409, 'Time slot is blocked for an event', {
        message: `This time slot is blocked: ${conflictCheck.conflictTitle || 'Event block'}.`
      });
    } else {
      throw new AppError(409, 'Time slot already booked', {
        message: 'Another booking already exists for this time slot.'
      });
    }
  }
  
  const userName = user?.firstName && user?.lastName 
    ? `${user.firstName} ${user.lastName}` 
    : resolvedEmail;
  
  const result = await db.insert(bookingRequests)
    .values({
      resourceId: params.resourceId,
      userEmail: resolvedEmail,
      userId: resolvedUserId,
      userName: userName,
      requestDate: params.bookingDate,
      startTime: params.startTime,
      endTime: params.endTime,
      durationMinutes: durationMinutes,
      notes: params.notes || null,
      status: 'pending_approval'
    })
    .returning();
  
  return result[0];
}

export async function getCascadePreview(bookingId: number) {
  const [booking] = await db.select({
    id: bookingRequests.id,
    sessionId: bookingRequests.sessionId
  })
  .from(bookingRequests)
  .where(eq(bookingRequests.id, bookingId));
  
  if (!booking) {
    throw new AppError(404, 'Booking not found');
  }
  
  let participantsCount = 0;
  const _membersCount = 0;
  
  if (booking.sessionId) {
    const participantsResult = await db.select({ count: sql<number>`count(*)::int` })
      .from(bookingParticipants)
      .where(eq(bookingParticipants.sessionId, booking.sessionId));
    participantsCount = participantsResult[0]?.count || 0;
  }
  
  return {
    bookingId,
    relatedData: {
      participants: participantsCount,
      linkedMembers: participantsCount
    },
    hasRelatedData: participantsCount > 0
  };
}

export async function isStaffOrAdminEmail(sessionEmail: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../../replit_integrations/auth/replitAuth');
  const { getAlternateDomainEmail } = await import('../../core/utils/emailNormalization');
  const isAdmin = await isAdminEmail(sessionEmail);
  if (isAdmin) return true;
  
  const authPool = getAuthPool();
  if (authPool) {
    try {
      const alt = getAlternateDomainEmail(sessionEmail);
      const emails = alt ? [sessionEmail, alt] : [sessionEmail];
      const placeholders = emails.map((_, i) => `LOWER($${i + 1})`).join(', ');
      const result = await queryWithRetry(
        authPool,
        `SELECT id FROM staff_users WHERE LOWER(email) IN (${placeholders}) AND is_active = true`,
        emails
      );
      return ((result as unknown as { rows: unknown[] }).rows).length > 0;
    } catch (e: unknown) {
      logger.warn('[resources] Staff check query failed:', { error: e instanceof Error ? e : new Error(getErrorMessage(e)) });
    }
  }
  return false;
}
