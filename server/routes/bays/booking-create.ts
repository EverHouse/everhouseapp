import { Router } from 'express';
import { db } from '../../db';
import { resources, users } from '../../../shared/schema';
import { eq, sql, inArray } from 'drizzle-orm';
import { BookingValidationError, SanitizedParticipant, BookingInsertRow } from './booking-shared';
import { checkDailyBookingLimit } from '../../core/tierService';
import { notifyAllStaff } from '../../core/notificationService';
import { formatDateDisplayWithDay, formatTime12Hour, getTodayPacific } from '../../utils/dateUtils';
import { logAndRespond, logger } from '../../core/logger';
import { bookingEvents } from '../../core/bookingEvents';
import { broadcastAvailabilityUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { isStaffOrAdminCheck } from './helpers';
import { isAuthenticated } from '../../core/middleware';
import { syncBookingInvoice, finalizeAndPayInvoice, getBookingInvoiceId } from '../../core/billing/bookingInvoiceService';
import { createGuestPassHold } from '../../core/billing/guestPassHoldService';
import { ensureSessionForBooking, createSessionWithUsageTracking } from '../../core/bookingService/sessionManager';
import { getErrorMessage } from '../../utils/errorUtils';
import { ensureTimeString } from '../../utils/dateTimeUtils';
import { resolveUserByEmail } from '../../core/stripe/customers';
import { bookingRateLimiter } from '../../middleware/rateLimiting';
import { validateBody } from '../../middleware/validate';
import { createBookingRequestSchema } from '../../../shared/validators/booking';
import { checkClosureConflict, checkAvailabilityBlockConflict } from '../../core/bookingValidation';
import { acquireBookingLocks, checkResourceOverlap, BookingConflictError } from '../../core/bookingService/bookingCreationGuard';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { GuestPassHoldError } from '../../core/errors';

interface BookingOverlapRow {
  id: number;
  resource_name: string;
  start_time: string;
  end_time: string;
}

const router = Router();

router.post('/api/booking-requests', isAuthenticated, bookingRateLimiter, validateBody(createBookingRequestSchema), async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { 
      user_email, user_name, resource_id, resource_preference, request_date, start_time, 
      duration_minutes, notes, declared_player_count, member_notes,
      guardian_name, guardian_relationship, guardian_phone, guardian_consent, request_participants
    } = req.body;
    
    const parsedDate = new Date(request_date + 'T00:00:00');
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    
    const [year, month, day] = request_date.split('-').map((n: string) => parseInt(n, 10));
    const validatedDate = new Date(year, month - 1, day);
    if (validatedDate.getFullYear() !== year || 
        validatedDate.getMonth() !== month - 1 || 
        validatedDate.getDate() !== day) {
      return res.status(400).json({ error: 'Invalid date - date does not exist (e.g., Feb 30)' });
    }
    
    const todayPacific = getTodayPacific();
    if (request_date < todayPacific) {
      return res.status(400).json({ error: 'Cannot create bookings in the past' });
    }
    
    const sessionEmail = sessionUser.email?.toLowerCase() || '';
    let requestEmail = user_email.toLowerCase();
    let resolvedUserId: string | null = null;
    
    const resolved = await resolveUserByEmail(requestEmail);
    if (resolved) {
      if (resolved.matchType !== 'direct') {
        logger.info('[Booking] Resolved linked email to primary for booking creation', { extra: { originalEmail: requestEmail, resolvedEmail: resolved.primaryEmail, matchType: resolved.matchType } });
        requestEmail = resolved.primaryEmail.toLowerCase();
      }
      resolvedUserId = resolved.userId;
    }
    
    const needsNameLookup = !user_name || user_name.includes('@');
    const needsAuthCheck = sessionEmail !== requestEmail;

    const [sessionResolved, isStaffRequest, dbUserResult] = await Promise.all([
      needsAuthCheck ? resolveUserByEmail(sessionEmail) : Promise.resolve(null),
      isStaffOrAdminCheck(sessionEmail),
      needsNameLookup
        ? db.select({ firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(sql`LOWER(${users.email}) = ${requestEmail}`)
            .limit(1)
        : Promise.resolve(null)
    ]);

    if (needsAuthCheck) {
      const sessionPrimary = sessionResolved?.primaryEmail?.toLowerCase() || sessionEmail;
      if (sessionPrimary !== requestEmail && !isStaffRequest) {
        return res.status(403).json({ error: 'You can only create booking requests for yourself' });
      }
    }

    let resolvedUserName = user_name;
    if (needsNameLookup && dbUserResult && dbUserResult.length > 0) {
      const fullName = [dbUserResult[0].firstName, dbUserResult[0].lastName].filter(Boolean).join(' ').trim();
      if (fullName) resolvedUserName = fullName;
    }
    const isViewAsMode = isStaffRequest && sessionEmail !== requestEmail;
    
    if (typeof duration_minutes !== 'number' || !Number.isInteger(duration_minutes) || duration_minutes <= 0 || duration_minutes > 480) {
      return res.status(400).json({ error: 'Invalid duration. Must be a whole number between 1 and 480 minutes.' });
    }
    
    const [hours, mins] = start_time.split(':').map(Number);
    const totalMins = hours * 60 + mins + duration_minutes;
    const endHours = Math.floor(totalMins / 60);
    const endMins = totalMins % 60;
    const end_time = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}:00`;
    
    if (endHours > 24 || (endHours === 24 && endMins > 0)) {
      return res.status(400).json({ error: 'Booking cannot extend past midnight. Please choose an earlier start time or shorter duration.' });
    }
    
    let row: BookingInsertRow;
    let resourceType = 'simulator';
    try {
      const txResult = await db.transaction(async (tx) => {
        if (resource_id) {
          const [resourceRow] = await tx.select({ type: resources.type }).from(resources).where(eq(resources.id, resource_id));
          resourceType = resourceRow?.type || 'simulator';
        }
        
        await acquireBookingLocks(tx as unknown as Parameters<typeof acquireBookingLocks>[0], {
          resourceId: resource_id,
          requestDate: request_date,
          startTime: start_time,
          endTime: end_time,
          requestEmail,
          isStaffRequest,
          isViewAsMode,
          resourceType,
        });

        await checkResourceOverlap(tx as unknown as Parameters<typeof checkResourceOverlap>[0], {
          resourceId: resource_id,
          requestDate: request_date,
          startTime: start_time,
          endTime: end_time,
        });
        
        if (resource_id) {
          const closureCheck = await checkClosureConflict(resource_id, request_date, start_time, end_time);
          if (closureCheck.hasConflict) {
            throw new BookingValidationError(409, {
              error: `This time slot conflicts with a facility closure: ${closureCheck.closureTitle || 'Facility Closure'}. Please choose a different time.`
            });
          }

          const blockCheck = await checkAvailabilityBlockConflict(resource_id, request_date, start_time, end_time);
          if (blockCheck.hasConflict) {
            throw new BookingValidationError(409, {
              error: `This time slot is blocked for: ${blockCheck.blockType || 'Event Block'}. Please choose a different time.`
            });
          }
        }

        if (!isStaffRequest || isViewAsMode) {
          const memberOverlapCheck = await tx.execute(sql`
            SELECT br.id, br.start_time, br.end_time, r.name AS resource_name
            FROM booking_requests br
            LEFT JOIN resources r ON r.id = br.resource_id
            WHERE br.request_date = ${request_date}
            AND br.status IN ('pending', 'pending_approval', 'approved', 'confirmed', 'checked_in', 'attended', 'cancellation_pending')
            AND br.start_time < ${end_time} AND br.end_time > ${start_time}
            AND (
              LOWER(br.user_email) = LOWER(${requestEmail})
              OR LOWER(br.user_email) IN (SELECT LOWER(ule.linked_email) FROM user_linked_emails ule WHERE LOWER(ule.primary_email) = LOWER(${requestEmail}))
              OR LOWER(br.user_email) IN (SELECT LOWER(ule.primary_email) FROM user_linked_emails ule WHERE LOWER(ule.linked_email) = LOWER(${requestEmail}))
              OR br.session_id IN (
                SELECT bp.session_id FROM booking_participants bp
                JOIN users u ON bp.user_id = u.id
                WHERE LOWER(u.email) = LOWER(${requestEmail})
              )
            )
          `);
          
          if (memberOverlapCheck.rows.length > 0) {
            const conflict = memberOverlapCheck.rows[0] as Record<string, unknown>;
            const conflictStart = (conflict.start_time as string)?.substring(0, 5);
            const conflictEnd = (conflict.end_time as string)?.substring(0, 5);
            const conflictResource = (conflict.resource_name as string) || 'another booking';
            
            throw new BookingValidationError(409, {
              error: `You already have a booking at ${conflictResource} from ${formatTime12Hour(conflictStart)} to ${formatTime12Hour(conflictEnd)}. You cannot book overlapping time slots.`
            });
          }
        }
        
        const limitCheck = await checkDailyBookingLimit(requestEmail, request_date, duration_minutes, undefined, resourceType);
        if (!limitCheck.allowed) {
          throw new BookingValidationError(403, { 
            error: limitCheck.reason,
            remainingMinutes: limitCheck.remainingMinutes
          });
        }
        
        let sanitizedParticipants: SanitizedParticipant[] = [];
        logger.info('[Booking] Received request_participants', { extra: { declaredPlayerCount: declared_player_count, participantCount: Array.isArray(request_participants) ? request_participants.length : 0, participantTypes: Array.isArray(request_participants) ? request_participants.map((p: { type?: string; userId?: string }) => ({ type: p.type, hasUserId: !!p.userId })) : [] } });
        if (request_participants && Array.isArray(request_participants)) {
          if (request_participants.length > 3) {
            throw new BookingValidationError(400, { error: 'Maximum of 3 guests allowed per booking' });
          }
          sanitizedParticipants = request_participants
            .map((p: { email?: string; type?: string; userId?: string; name?: string }) => ({
              email: typeof p.email === 'string' ? p.email.toLowerCase().trim() : '',
              type: (p.type === 'member' ? 'member' : 'guest') as 'member' | 'guest',
              userId: typeof p.userId === 'string' ? p.userId : undefined,
              name: typeof p.name === 'string' ? p.name.trim() : undefined
            }))
            .filter((p: SanitizedParticipant) => p.email || p.userId);
        }
        
        const emailsToLookup = sanitizedParticipants
          .filter((p: SanitizedParticipant) => p.email && !p.userId)
          .map((p: SanitizedParticipant) => p.email.toLowerCase());
        const userIdsToLookup = sanitizedParticipants
          .filter((p: SanitizedParticipant) => p.userId && !p.email)
          .map((p: SanitizedParticipant) => p.userId as string);

        if (emailsToLookup.length > 0) {
          try {
            const emailUsers = await tx.select({
              id: users.id,
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName
            }).from(users)
              .where(inArray(sql`LOWER(${users.email})`, emailsToLookup));
            const emailMap = new Map(emailUsers.map(u => [u.email?.toLowerCase() || '', u]));
            for (const participant of sanitizedParticipants) {
              if (participant.email && !participant.userId) {
                const found = emailMap.get(participant.email.toLowerCase());
                if (found) {
                  participant.userId = found.id;
                  if (!participant.name || participant.name.includes('@')) {
                    const fullName = [found.firstName, found.lastName].filter(Boolean).join(' ').trim();
                    if (fullName) participant.name = fullName;
                  }
                }
              }
            }
          } catch (err: unknown) {
            logger.error('[Booking] Failed to batch lookup users by email', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) });
          }
        }

        if (userIdsToLookup.length > 0) {
          try {
            const idUsers = await tx.select({
              id: users.id,
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName
            }).from(users)
              .where(inArray(users.id, userIdsToLookup));
            const idMap = new Map(idUsers.map(u => [u.id, u]));
            for (const participant of sanitizedParticipants) {
              if (participant.userId && !participant.email) {
                const found = idMap.get(participant.userId);
                if (found) {
                  participant.email = found.email?.toLowerCase() || '';
                  if (!participant.name) {
                    const fullName = [found.firstName, found.lastName].filter(Boolean).join(' ').trim();
                    participant.name = fullName || found.email || undefined;
                  }
                  logger.info('[Booking] Resolved email for directory-selected participant', { extra: { participantEmail: participant.email } });
                }
              }
            }
          } catch (err: unknown) {
            logger.error('[Booking] Failed to batch lookup users by userId', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) });
          }
        }

        const allParticipantUserIds = sanitizedParticipants
          .filter((p: SanitizedParticipant) => p.userId)
          .map((p: SanitizedParticipant) => p.userId as string);
        if (allParticipantUserIds.length > 0) {
          const statusResults = await tx.select({
            id: users.id,
            membershipStatus: users.membershipStatus,
            email: users.email,
            name: sql<string>`COALESCE(TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName})), '')`.as('name')
          }).from(users)
            .where(inArray(users.id, allParticipantUserIds));
          for (const statusRow of statusResults) {
            if (statusRow.membershipStatus === 'inactive' || statusRow.membershipStatus === 'cancelled') {
              throw new BookingValidationError(400, {
                error: `${statusRow.name || statusRow.email || 'A participant'} has an inactive membership and cannot be added to bookings.`
              });
            }
          }
        }
        
        const seenEmails = new Set<string>();
        const seenUserIds = new Set<string>();
        seenEmails.add(requestEmail);
        sanitizedParticipants = sanitizedParticipants.filter((p: SanitizedParticipant) => {
          if (p.userId && seenUserIds.has(p.userId)) return false;
          if (p.email && seenEmails.has(p.email.toLowerCase())) return false;
          if (p.userId) seenUserIds.add(p.userId);
          if (p.email) seenEmails.add(p.email.toLowerCase());
          return true;
        });
        
        for (const participant of sanitizedParticipants) {
          if (participant.type === 'member' && participant.email) {
            const pOverlap = await tx.execute(sql`
              SELECT br.id, COALESCE(r.name, 'Unknown') AS resource_name, br.start_time, br.end_time
              FROM booking_requests br
              LEFT JOIN resources r ON r.id = br.resource_id
              WHERE br.request_date = ${request_date}
              AND br.status IN ('pending', 'pending_approval', 'approved', 'confirmed', 'checked_in', 'attended', 'cancellation_pending')
              AND br.start_time < ${end_time} AND br.end_time > ${start_time}
              AND (
                LOWER(br.user_email) = LOWER(${participant.email})
                OR LOWER(br.user_email) IN (SELECT LOWER(ule.linked_email) FROM user_linked_emails ule WHERE LOWER(ule.primary_email) = LOWER(${participant.email}))
                OR LOWER(br.user_email) IN (SELECT LOWER(ule.primary_email) FROM user_linked_emails ule WHERE LOWER(ule.linked_email) = LOWER(${participant.email}))
                OR br.session_id IN (
                  SELECT bp.session_id FROM booking_participants bp
                  JOIN users u ON bp.user_id = u.id
                  WHERE LOWER(u.email) = LOWER(${participant.email})
                )
              )
              LIMIT 1
            `);
            if (pOverlap.rows.length > 0) {
              const conflict = pOverlap.rows[0] as BookingOverlapRow;
              const cStart = conflict.start_time?.substring(0, 5);
              const cEnd = conflict.end_time?.substring(0, 5);
              throw new BookingValidationError(409, {
                error: `${participant.name || participant.email} already has a booking at ${conflict.resource_name} from ${formatTime12Hour(cStart)} to ${formatTime12Hour(cEnd)}. They cannot be added to an overlapping time slot.`
              });
            }
          }
        }
        
        const isConferenceRoom = resourceType === 'conference_room';
        const initialStatus: 'pending' | 'confirmed' = isConferenceRoom ? 'confirmed' : 'pending';
        
        const guardianConsentAt = guardian_consent ? new Date() : null;
        const insertResult = await tx.execute(sql`
          INSERT INTO booking_requests (
            user_email, user_name, user_id, resource_id, resource_preference, 
            request_date, start_time, duration_minutes, end_time, notes,
            declared_player_count, member_notes,
            guardian_name, guardian_relationship, guardian_phone, guardian_consent_at,
            request_participants, status, created_at, updated_at
          ) VALUES (
            ${requestEmail},
            ${resolvedUserName},
            ${resolvedUserId || null},
            ${resource_id || null},
            ${resource_preference || null},
            ${request_date},
            ${start_time},
            ${duration_minutes},
            ${end_time},
            ${notes || null},
            ${(declared_player_count && declared_player_count >= 1 && declared_player_count <= 4 ? declared_player_count : null) ?? null},
            ${(member_notes ? String(member_notes).slice(0, 280) : null) ?? null},
            ${(guardian_consent && guardian_name ? guardian_name : null) ?? null},
            ${(guardian_consent && guardian_relationship ? guardian_relationship : null) ?? null},
            ${(guardian_consent && guardian_phone ? guardian_phone : null) ?? null},
            ${guardianConsentAt},
            ${sanitizedParticipants.length > 0 ? JSON.stringify(sanitizedParticipants) : '[]'},
            ${initialStatus},
            NOW(), NOW()
          )
          RETURNING *
        `);
        
        const guestCount = sanitizedParticipants.filter((p: SanitizedParticipant) => p.type === 'guest').length;
        if (guestCount > 0) {
          const bookingId = (insertResult.rows[0] as Record<string, unknown>).id as number;
          const holdResult = await createGuestPassHold(
            requestEmail,
            bookingId,
            guestCount,
            tx
          );
          if (!holdResult.success) {
            throw new GuestPassHoldError(holdResult.error || 'Insufficient guest passes available');
          }
        }
        
        const dbRow = insertResult.rows[0] as Record<string, unknown>;
        logger.info('[Booking] Persisted booking with participants', { extra: { bookingId: dbRow.id, participantsSaved: sanitizedParticipants.length, participantTypes: sanitizedParticipants.map((p: SanitizedParticipant) => ({ type: p.type, hasUserId: !!p.userId, hasEmail: !!p.email })) } });
        return {
          id: dbRow.id,
          userEmail: dbRow.user_email,
          userName: dbRow.user_name,
          resourceId: dbRow.resource_id,
          resourcePreference: dbRow.resource_preference,
          requestDate: dbRow.request_date,
          startTime: dbRow.start_time,
          durationMinutes: dbRow.duration_minutes,
          endTime: dbRow.end_time,
          notes: dbRow.notes,
          status: dbRow.status,
          declaredPlayerCount: dbRow.declared_player_count,
          memberNotes: dbRow.member_notes,
          guardianName: dbRow.guardian_name,
          guardianRelationship: dbRow.guardian_relationship,
          guardianPhone: dbRow.guardian_phone,
          guardianConsentAt: dbRow.guardian_consent_at,
          requestParticipants: dbRow.request_participants || [],
          createdAt: dbRow.created_at,
          updatedAt: dbRow.updated_at
        } as BookingInsertRow;
      });
      row = txResult;
    } catch (error: unknown) {
      if (error instanceof BookingValidationError) {
        return res.status(error.statusCode).json(error.errorBody);
      }
      if (error instanceof BookingConflictError) {
        return res.status(error.statusCode).json(error.errorBody);
      }
      if (error instanceof GuestPassHoldError) {
        return res.status(402).json({ error: 'Guest pass hold failed. Please check guest pass availability and try again.' });
      }
      throw error;
    }
    
    let resourceName = 'Bay';
    if (row.resourceId) {
      try {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, row.resourceId));
        if (resource?.name) {
          resourceName = resource.name;
        }
      } catch (error: unknown) {
        logger.error('[Bookings] Failed to fetch resource name', { error: error instanceof Error ? error : new Error(getErrorMessage(error)) });
      }
    }
    
    const dateStr = typeof row.requestDate === 'string' 
      ? row.requestDate 
      : request_date;
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const timeStr = ensureTimeString(row.startTime ?? start_time);
    const formattedTime12h = formatTime12Hour(timeStr);
    
    const durationMins = row.durationMinutes || duration_minutes;
    let durationDisplay = '';
    if (durationMins) {
      if (durationMins < 60) {
        durationDisplay = `${durationMins} min`;
      } else {
        const hours = durationMins / 60;
        durationDisplay = hours === Math.floor(hours) ? `${hours} hr${hours > 1 ? 's' : ''}` : `${hours.toFixed(1)} hrs`;
      }
    }
    
    const playerCount = declared_player_count && declared_player_count > 1 ? ` (${declared_player_count} players)` : '';
    
    const isConfRoom = resourceType === 'conference_room';
    const staffTitle = isConfRoom ? 'New Conference Room Booking' : 'New Golf Booking Request';
    const staffMessage = `${row.userName || row.userEmail}${playerCount} - ${resourceName} on ${formattedDate} at ${formattedTime12h} for ${durationDisplay}`;
    
    res.status(201).json({
      id: row.id,
      user_email: row.userEmail,
      user_name: row.userName,
      resource_id: row.resourceId,
      resource_preference: row.resourcePreference,
      request_date: row.requestDate,
      start_time: row.startTime,
      duration_minutes: row.durationMinutes,
      end_time: row.endTime,
      notes: row.notes,
      status: row.status,
      staff_notes: row.staffNotes,
      suggested_time: row.suggestedTime,
      reviewed_by: row.reviewedBy,
      reviewed_at: row.reviewedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      calendar_event_id: row.calendarEventId,
    });
    
    db.execute(sql`UPDATE users SET first_booking_at = NOW(), updated_at = NOW() WHERE LOWER(email) = LOWER(${row.userEmail}) AND first_booking_at IS NULL`).catch((err) => logger.warn('[Booking] Non-critical first_booking_at update failed:', err));

    db.execute(sql`UPDATE users SET onboarding_completed_at = NOW(), updated_at = NOW() 
      WHERE LOWER(email) = LOWER(${row.userEmail}) 
      AND onboarding_completed_at IS NULL 
      AND first_name IS NOT NULL AND last_name IS NOT NULL AND phone IS NOT NULL
      AND waiver_signed_at IS NOT NULL AND app_installed_at IS NOT NULL`).catch((err) => logger.warn('[Booking] Non-critical onboarding update failed:', err));

    if (resourceType === 'conference_room' && row.resourceId) {
      (async () => {
        try {
          const confEndTime = row.endTime || end_time;
          const [startH, startM] = start_time.split(':').map(Number);
          const [endH, endM] = confEndTime.split(':').map(Number);
          const confDurationMinutes = (endH * 60 + endM) - (startH * 60 + startM);

          const participants = [{
            participantType: 'owner' as const,
            displayName: resolvedUserName || requestEmail,
            userId: resolvedUserId || sessionUser?.id || undefined,
            guestId: undefined
          }];

          const result = await createSessionWithUsageTracking({
            bookingId: row.id,
            resourceId: row.resourceId!,
            sessionDate: request_date,
            startTime: start_time,
            endTime: confEndTime,
            ownerEmail: requestEmail,
            durationMinutes: confDurationMinutes > 0 ? confDurationMinutes : duration_minutes,
            declaredPlayerCount: 1,
            participants
          }, 'member_request');

          if (!result.success) {
            logger.warn('[ConferenceRoom] Usage tracking returned failure, falling back to session-only', {
              extra: { bookingId: row.id, error: result.error }
            });
            const fallbackSession = await ensureSessionForBooking({
              bookingId: row.id,
              resourceId: row.resourceId!,
              sessionDate: request_date,
              startTime: start_time,
              endTime: row.endTime || end_time,
              ownerEmail: requestEmail,
              ownerName: user_name || undefined,
              source: 'member_request',
              createdBy: 'conference_room_auto_confirm'
            });
            if (fallbackSession.error) {
              logger.error('[ConferenceRoom] Fallback session creation failed', { extra: { bookingId: row.id, error: fallbackSession.error } });
            }
          }

          const sessionCheck = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${row.id} LIMIT 1`);
          const confSessionId = sessionCheck.rows[0]?.session_id as number | null;

          if (!confSessionId) {
            logger.error('[ConferenceRoom] Session creation failed — no session_id after all attempts, reverting to pending', {
              extra: { bookingId: row.id }
            });
            await db.execute(sql`UPDATE booking_requests SET status = 'pending', staff_notes = 'Auto-confirm failed: session could not be created. Please review and approve manually.', updated_at = NOW() WHERE id = ${row.id} AND status IN ('approved', 'confirmed')`);
          } else {
            try {
              await recalculateSessionFees(confSessionId, 'approval');
              await syncBookingInvoice(row.id, confSessionId);
              
              const invoiceId = await getBookingInvoiceId(row.id);
              if (invoiceId) {
                try {
                  const payResult = await finalizeAndPayInvoice({ bookingId: row.id });
                  logger.info('[ConferenceRoom] Invoice finalized and payment attempted', {
                    extra: { bookingId: row.id, sessionId: confSessionId, paidInFull: payResult.paidInFull, status: payResult.status }
                  });
                } catch (payErr: unknown) {
                  logger.warn('[ConferenceRoom] Invoice finalize/pay did not complete instantly — member can pay via dashboard', {
                    extra: { bookingId: row.id, error: getErrorMessage(payErr) }
                  });
                }
              } else {
                logger.info('[ConferenceRoom] No fees due — skipping invoice finalization', {
                  extra: { bookingId: row.id, sessionId: confSessionId }
                });
              }
            } catch (invoiceErr: unknown) {
              logger.warn('[ConferenceRoom] Non-blocking: Failed to create invoice after booking', {
                extra: { bookingId: row.id, error: getErrorMessage(invoiceErr) }
              });
            }
          }
        } catch (confError) {
          logger.error('[ConferenceRoom] Post-response conference room processing failed', {
            error: new Error(getErrorMessage(confError)),
            extra: { bookingId: row.id }
          });
          try {
            await ensureSessionForBooking({
              bookingId: row.id,
              resourceId: row.resourceId!,
              sessionDate: request_date,
              startTime: start_time,
              endTime: row.endTime || end_time,
              ownerEmail: requestEmail,
              ownerName: user_name || undefined,
              source: 'member_request',
              createdBy: 'conference_room_auto_confirm'
            });
          } catch (fallbackErr) {
            logger.error('[ConferenceRoom] Fallback ensureSession also failed', {
              error: new Error(getErrorMessage(fallbackErr))
            });
          }
        }
      })().catch(err => logger.error('[ConferenceRoom] Unhandled error in post-response processing', {
        error: new Error(getErrorMessage(err))
      }));
    }

    try {
      notifyAllStaff(
        staffTitle,
        staffMessage,
        'booking',
        {
          relatedId: row.id,
          relatedType: 'booking_request',
          url: '/admin/bookings',
          sendPush: true
        }
      ).catch((err: unknown) => logger.error('Staff notification failed:', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
      
      bookingEvents.publish('booking_created', {
        bookingId: row.id,
        memberEmail: row.userEmail,
        memberName: row.userName || undefined,
        resourceId: row.resourceId || undefined,
        resourceName: resourceName,
        bookingDate: row.requestDate,
        startTime: row.startTime,
        durationMinutes: durationMins,
        playerCount: declared_player_count || undefined,
        status: row.status || 'pending',
        actionBy: 'member'
      }, { notifyMember: false, notifyStaff: true }).catch((err: unknown) => logger.error('Booking event publish failed:', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
      
      broadcastAvailabilityUpdate({
        resourceId: row.resourceId || undefined,
        resourceType: resourceType === 'conference_room' ? 'conference_room' : 'simulator',
        date: row.requestDate,
        action: 'booked'
      });
    } catch (postCommitError: unknown) {
      logger.error('[BookingRequest] Post-commit operations failed', { extra: { postCommitError } });
    }
  } catch (error: unknown) {
    const { isConstraintError } = await import('../../core/db');
    const constraint = isConstraintError(error);
    if (constraint.type === 'unique') {
      return res.status(409).json({ error: 'This time slot may have just been booked. Please refresh and try again.' });
    }
    if (constraint.type === 'foreign_key') {
      return res.status(400).json({ error: 'Referenced record not found. Please refresh and try again.' });
    }
    logAndRespond(req, res, 500, 'Failed to create booking request', error);
  }
});

export default router;
