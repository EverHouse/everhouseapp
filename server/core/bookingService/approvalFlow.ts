import { db } from '../../db';
import { pool, safeRelease } from '../db';
import { bookingRequests, resources, notifications, users, bookingParticipants, stripePaymentIntents } from '../../../shared/schema';
import { eq, and, or, gt, lt, lte, gte, ne, sql, isNull, isNotNull } from 'drizzle-orm';
import { sendPushNotification } from '../../routes/push';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour } from '../../utils/dateUtils';
import { logger } from '../logger';
import { notifyAllStaff, notifyMember, isSyntheticEmail } from '../notificationService';
import { checkClosureConflict, checkAvailabilityBlockConflict } from '../bookingValidation';
import { bookingEvents } from '../bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate, broadcastMemberStatsUpdated, broadcastBillingUpdate } from '../websocket';
import { refundGuestPass } from '../../routes/guestPasses';
import { updateHubSpotContactVisitCount } from '../memberSync';
import { createSessionWithUsageTracking, ensureSessionForBooking, createOrFindGuest } from './sessionManager';
import { recalculateSessionFees } from '../billing/unifiedFeeService';
import { PaymentStatusService } from '../billing/PaymentStatusService';
import { cancelPaymentIntent, getStripeClient } from '../stripe';
import { cancelPendingPaymentIntentsForBooking } from '../billing/paymentIntentCleanup';
import Stripe from 'stripe';
import { getCalendarNameForBayAsync } from '../../routes/bays/helpers';
import { getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent } from '../calendar/index';
import { releaseGuestPassHold } from '../billing/guestPassHoldService';
import { createPrepaymentIntent } from '../billing/prepaymentService';
import { voidBookingInvoice, finalizeAndPayInvoice, syncBookingInvoice, getBookingInvoiceId } from '../billing/bookingInvoiceService';
import { getErrorMessage } from '../../utils/errorUtils';
import { upsertVisitor } from '../visitors/matchingService';
import { AppError } from '../errors';
import { logPaymentAudit } from '../auditLog';
import { voidBookingPass } from '../../walletPass/bookingPassService';
import { BookingRow, BookingUpdateResult, CancelPushInfo, formatBookingRow, validateTrackmanId } from './approvalTypes';

interface ApproveBookingParams {
  bookingId: number;
  status: string;
  staff_notes?: string;
  suggested_time?: string;
  reviewed_by?: string;
  resource_id?: number;
  trackman_booking_id?: string;
  trackman_external_id?: string;
  pending_trackman_sync?: boolean;
}

export async function approveBooking(params: ApproveBookingParams) {
  const { bookingId, staff_notes, suggested_time, reviewed_by, resource_id, trackman_booking_id, trackman_external_id, pending_trackman_sync } = params;

  const { updated, bayName, approvalMessage, isConferenceRoom, calendarData, createdSessionId, createdParticipantIds, ownerUserId } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('approve_booking_' || ${String(bookingId)}))`);

    const [req_data] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));

    if (!req_data) {
      throw new AppError(404, 'Request not found');
    }

    const assignedBayForLock = resource_id || req_data.resourceId;
    if (assignedBayForLock && req_data.requestDate) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${String(assignedBayForLock)} || '::' || ${req_data.requestDate}))`);
    }

    const allowedForApproval = ['pending', 'pending_approval'];
    if (!allowedForApproval.includes(req_data.status || '')) {
      const alreadyApprovedStatuses = ['approved', 'confirmed', 'attended'];
      if (alreadyApprovedStatuses.includes(req_data.status || '') && trackman_booking_id) {
        if (!req_data.trackmanBookingId) {
          await tx.update(bookingRequests)
            .set({ trackmanBookingId: trackman_booking_id, updatedAt: new Date() })
            .where(eq(bookingRequests.id, bookingId));
        }
        const [refreshed] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));
        return { updated: refreshed, bayName: null, approvalMessage: null, isConferenceRoom: false, calendarData: null, prepaymentData: null };
      }
      throw new AppError(409, `Booking is already ${req_data.status}. Please refresh the page.`);
    }

    const assignedBayId = resource_id || req_data.resourceId;

    if (!assignedBayId) {
      throw new AppError(400, 'Bay must be assigned before approval');
    }

    const conflicts = await tx.select().from(bookingRequests).where(and(
      eq(bookingRequests.resourceId, assignedBayId),
      eq(bookingRequests.requestDate, req_data.requestDate),
      or(
        eq(bookingRequests.status, 'pending'),
        eq(bookingRequests.status, 'pending_approval'),
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'attended'),
        eq(bookingRequests.status, 'cancellation_pending')
      ),
      ne(bookingRequests.id, bookingId),
      or(
        and(lte(bookingRequests.startTime, req_data.startTime), gt(bookingRequests.endTime, req_data.startTime)),
        and(lt(bookingRequests.startTime, req_data.endTime), gte(bookingRequests.endTime, req_data.endTime)),
        and(gte(bookingRequests.startTime, req_data.startTime), lte(bookingRequests.endTime, req_data.endTime))
      )
    ));

    if (conflicts.length > 0) {
      throw new AppError(409, 'Time slot conflicts with existing booking');
    }

    const closureCheck = await checkClosureConflict(assignedBayId, req_data.requestDate, req_data.startTime, req_data.endTime);
    if (closureCheck.hasConflict) {
      throw new AppError(409, 'Cannot approve booking during closure', {
        message: `This time slot conflicts with "${closureCheck.closureTitle}". Please decline this request or wait until the closure ends.`
      });
    }

    const blockCheck = await checkAvailabilityBlockConflict(assignedBayId, req_data.requestDate, req_data.startTime, req_data.endTime);
    if (blockCheck.hasConflict) {
      throw new AppError(409, 'Cannot approve booking during event block', {
        message: `This time slot is blocked: ${blockCheck.blockType || 'Event block'}. Please decline this request or reschedule.`
      });
    }

    const bayResult = await tx.select({ name: resources.name, type: resources.type }).from(resources).where(eq(resources.id, assignedBayId));
    const bayName = bayResult[0]?.name || 'Simulator';
    const isConferenceRoom = bayResult[0]?.type === 'conference_room';

    const calendarEventId: string | null = req_data.calendarEventId || null;
    const calendarName = await getCalendarNameForBayAsync(assignedBayId);

    const finalStatus = 'approved';

    let finalStaffNotes = staff_notes;
    if (pending_trackman_sync && !trackman_booking_id) {
      const syncMarker = '[PENDING_TRACKMAN_SYNC]';
      finalStaffNotes = staff_notes ? `${staff_notes} ${syncMarker}` : syncMarker;
    }

    const [updatedRow] = await tx.update(bookingRequests)
      .set({
        status: finalStatus,
        staffNotes: finalStaffNotes,
        suggestedTime: suggested_time,
        reviewedBy: reviewed_by,
        reviewedAt: new Date(),
        resourceId: assignedBayId,
        calendarEventId: calendarEventId,
        isUnmatched: false,
        ...(trackman_booking_id !== undefined ? { trackmanBookingId: trackman_booking_id || null } : {}),
        ...(trackman_external_id !== undefined ? { trackmanExternalId: trackman_external_id || null } : {}),
        updatedAt: new Date()
      })
      .where(and(eq(bookingRequests.id, bookingId), or(eq(bookingRequests.status, 'pending'), eq(bookingRequests.status, 'pending_approval'))))
      .returning();

    if (!updatedRow) {
      throw new AppError(409, 'Booking was modified by another staff member. Please refresh and try again.');
    }

    let createdSessionId: number | null = null;
    let createdParticipantIds: number[] = [];
    if (!updatedRow.sessionId) {
      try {
        let ownerUserId = updatedRow.userId;
        let ownerDisplayName = updatedRow.userName;
        if (!ownerUserId && updatedRow.userEmail) {
          const userResult = await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(sql`LOWER(${users.email}) = LOWER(${updatedRow.userEmail})`)
            .limit(1);
          if (userResult.length > 0) {
            ownerUserId = userResult[0].id;
            const dbName = [userResult[0].firstName, userResult[0].lastName].filter(Boolean).join(' ').trim();
            if (dbName) ownerDisplayName = dbName;
            await tx.update(bookingRequests)
              .set({ userId: ownerUserId })
              .where(eq(bookingRequests.id, bookingId));
          }
        }
        if (!ownerDisplayName || ownerDisplayName.includes('@')) {
          if (ownerUserId) {
            const nameResult = await tx.select({ firstName: users.firstName, lastName: users.lastName })
              .from(users)
              .where(eq(users.id, ownerUserId))
              .limit(1);
            if (nameResult.length > 0) {
              const dbName = [nameResult[0].firstName, nameResult[0].lastName].filter(Boolean).join(' ').trim();
              if (dbName) ownerDisplayName = dbName;
            }
          }
        }

        const sessionParticipants: Array<{
          userId?: string;
          guestId?: number;
          participantType: 'owner' | 'member' | 'guest';
          displayName: string;
        }> = [{
          userId: ownerUserId || undefined,
          participantType: 'owner',
          displayName: ownerDisplayName || updatedRow.userEmail
        }];

        const requestParticipants = updatedRow.requestParticipants as Array<{
          email?: string;
          type: 'member' | 'guest';
          userId?: string;
          name?: string;
        }> | null;

        const addedUserIds = new Set<string>();
        const addedEmails = new Set<string>();
        const ownerEmailNormalized = updatedRow.userEmail.toLowerCase();

        if (ownerUserId) addedUserIds.add(ownerUserId);
        addedEmails.add(ownerEmailNormalized);

        if (requestParticipants && Array.isArray(requestParticipants)) {
          for (const rp of requestParticipants) {
            if (!rp || typeof rp !== 'object') {
              logger.warn('[Booking Approval] Skipping invalid request participant entry', { extra: { rp } });
              continue;
            }

            const rpEmailNormalized = rp.email?.toLowerCase()?.trim() || '';

            if (rpEmailNormalized && rpEmailNormalized === ownerEmailNormalized) continue;
            if (rp.userId && rp.userId === ownerUserId) continue;
            if (rp.userId && addedUserIds.has(rp.userId)) continue;
            if (rpEmailNormalized && addedEmails.has(rpEmailNormalized)) continue;

            let resolvedUserId = rp.userId;
            let resolvedName = rp.name;
            const isMember = rp.type === 'member';

            if (isMember && !resolvedUserId && rpEmailNormalized) {
              const memberResult = await tx.select({ id: users.id, firstName: users.firstName })
                .from(users)
                .where(eq(sql`LOWER(${users.email})`, rpEmailNormalized))
                .limit(1);
              if (memberResult.length > 0) {
                resolvedUserId = memberResult[0].id;
                if (!resolvedName) resolvedName = memberResult[0].firstName || rpEmailNormalized;
              }
            }

            if (!resolvedUserId && rpEmailNormalized) {
              const memberResult = await tx.select({ id: users.id, firstName: users.firstName })
                .from(users)
                .where(eq(sql`LOWER(${users.email})`, rpEmailNormalized))
                .limit(1);
              if (memberResult.length > 0) {
                resolvedUserId = memberResult[0].id;
                if (!resolvedName) resolvedName = memberResult[0].firstName || rpEmailNormalized;
                logger.info('[Booking Approval] Linked guest user profile for roster tracking (billing type preserved)', { extra: { rpEmailNormalized, billingType: rp.type } });
              }
            }

            if (resolvedUserId && !resolvedName) {
              const memberResult = await tx.select({ firstName: users.firstName, email: users.email })
                .from(users)
                .where(eq(users.id, resolvedUserId))
                .limit(1);
              if (memberResult.length > 0) {
                resolvedName = memberResult[0].firstName || memberResult[0].email || undefined;
              }
            }

            if (isMember && resolvedUserId) {
              if (rpEmailNormalized && req_data.requestDate && req_data.startTime && req_data.endTime) {
                const participantConflicts = await tx.execute(sql`
                  SELECT br2.id, COALESCE(r2.name, 'Unknown') as resource_name, br2.start_time, br2.end_time
                  FROM booking_requests br2
                  LEFT JOIN resources r2 ON r2.id = br2.resource_id
                  WHERE br2.request_date = ${req_data.requestDate}
                  AND br2.status IN ('approved', 'confirmed', 'attended')
                  AND br2.start_time < ${req_data.endTime} AND br2.end_time > ${req_data.startTime}
                  AND br2.id != ${bookingId}
                  AND (
                    LOWER(br2.user_email) = ${rpEmailNormalized}
                    OR br2.session_id IN (
                      SELECT bp2.session_id FROM booking_participants bp2
                      WHERE bp2.user_id = (SELECT id FROM users WHERE LOWER(email) = ${rpEmailNormalized} LIMIT 1)
                    )
                  )
                  LIMIT 1
                `);
                if (participantConflicts.rows.length > 0) {
                  const conflict = participantConflicts.rows[0] as { resource_name: string; start_time: string; end_time: string };
                  logger.warn('[Booking Approval] Skipping participant with time conflict', {
                    extra: {
                      participantEmail: rpEmailNormalized,
                      conflictResource: conflict.resource_name,
                      conflictTime: `${conflict.start_time}-${conflict.end_time}`,
                      bookingId
                    }
                  });
                  continue;
                }
              }

              sessionParticipants.push({
                userId: resolvedUserId,
                participantType: 'member',
                displayName: resolvedName || rpEmailNormalized || 'Member'
              });
              addedUserIds.add(resolvedUserId);
              if (rpEmailNormalized) addedEmails.add(rpEmailNormalized);
            } else {
              const guestParticipant: { participantType: 'guest'; displayName: string; guestId?: number } = {
                participantType: 'guest',
                displayName: resolvedName || rp.name || rpEmailNormalized || 'Guest'
              };
              if (rpEmailNormalized && rp.name) {
                try {
                  const guestId = await createOrFindGuest(rp.name, rpEmailNormalized, undefined, updatedRow.userEmail);
                  guestParticipant.guestId = guestId;
                } catch (guestErr) {
                  logger.error('[Booking Approval] Non-blocking guest record creation failed', {
                    extra: { rpEmailNormalized, error: getErrorMessage(guestErr) }
                  });
                }
              }
              sessionParticipants.push(guestParticipant);
              if (rpEmailNormalized) addedEmails.add(rpEmailNormalized);
            }
          }
          logger.info(`[Booking Approval] Converted ${requestParticipants.length} request participants to ${sessionParticipants.length - 1} session participants (plus owner)`);
        }

        const sessionResult = await createSessionWithUsageTracking(
          {
            ownerEmail: updatedRow.userEmail,
            resourceId: assignedBayId,
            sessionDate: updatedRow.requestDate,
            startTime: updatedRow.startTime,
            endTime: updatedRow.endTime,
            durationMinutes: updatedRow.durationMinutes,
            participants: sessionParticipants,
            trackmanBookingId: updatedRow.trackmanBookingId || undefined,
            declaredPlayerCount: updatedRow.declaredPlayerCount || undefined,
            bookingId: bookingId
          },
          'member_request',
          tx
        );

        if (sessionResult.success && sessionResult.session) {
          createdSessionId = sessionResult.session.id;
          createdParticipantIds = sessionResult.participants?.map(p => p.id) || [];

          await tx.update(bookingRequests)
            .set({ sessionId: createdSessionId })
            .where(eq(bookingRequests.id, bookingId));

          logger.info('[Booking Approval] Created session for booking with participants, ledger entries', { extra: { createdSessionId, bookingId, createdParticipantIdsLength: createdParticipantIds.length, sessionResultUsageLedgerEntries_0: sessionResult.usageLedgerEntries || 0 } });
        } else {
          logger.error('[Booking Approval] Session creation failed', { extra: { sessionResultError: sessionResult.error } });
          throw new AppError(500, 'Failed to create booking session. Please try again.', { details: sessionResult.error });
        }
      } catch (sessionError: unknown) {
        if (sessionError instanceof AppError) throw sessionError;
        logger.error('[Booking Approval] Failed to create session', { extra: { sessionError } });
        throw new AppError(500, 'Failed to create booking session. Please try again.', { details: getErrorMessage(sessionError) || sessionError });
      }
    }

    let ownerUserId = updatedRow.userId;
    if (!ownerUserId && updatedRow.userEmail) {
      const userResult = await tx.select({ id: users.id })
        .from(users)
        .where(eq(users.email, updatedRow.userEmail.toLowerCase()))
        .limit(1);
      if (userResult.length > 0) {
        ownerUserId = userResult[0].id;
      }
    }

    const resourceTypeName = isConferenceRoom ? 'conference room' : 'simulator';
    const approvalMessage = `Your ${resourceTypeName} booking for ${formatNotificationDateTime(updatedRow.requestDate, updatedRow.startTime)} has been approved.`;

    await tx.update(notifications)
      .set({ isRead: true })
      .where(and(
        eq(notifications.relatedId, bookingId),
        eq(notifications.relatedType, 'booking_request'),
        eq(notifications.type, 'booking')
      ));

    const calendarData = !calendarEventId && calendarName ? {
      existingCalendarEventId: calendarEventId,
      calendarName,
      assignedBayId,
      bayName,
      requestDate: req_data.requestDate,
      startTime: req_data.startTime,
      endTime: req_data.endTime,
      userEmail: req_data.userEmail,
      userName: req_data.userName,
      notes: req_data.notes,
      durationMinutes: req_data.durationMinutes
    } : null;

    return { updated: updatedRow, bayName, approvalMessage, isConferenceRoom, calendarData, prepaymentData: null as typeof prepaymentData, createdSessionId, createdParticipantIds, ownerUserId };
  });

  if (updated.userEmail && approvalMessage && !isSyntheticEmail(updated.userEmail)) {
    notifyMember({
      userEmail: updated.userEmail,
      title: 'Booking Request Approved',
      message: approvalMessage,
      type: 'booking_approved',
      relatedId: bookingId,
      relatedType: 'booking_request',
      url: '/sims'
    }, { sendPush: true }).catch(err => logger.error('[Approval] Post-commit notification failed', { extra: { error: getErrorMessage(err) } }));
  }

  let prepaymentData: { sessionId: number; bookingId: number; userId: string | null; userEmail: string; userName: string; totalFeeCents: number; feeBreakdown: { overageCents: number; guestCents: number }; createdSessionId: number } | null = null;
  if (createdSessionId && createdParticipantIds.length > 0) {
    try {
      const breakdown = await recalculateSessionFees(createdSessionId, 'approval');
      logger.info(`[Booking Approval] Applied unified fees for session ${createdSessionId}: $${(breakdown.totals.totalCents/100).toFixed(2)}, overage: $${(breakdown.totals.overageCents/100).toFixed(2)}`);

      if (breakdown.totals.totalCents > 0) {
        prepaymentData = {
          sessionId: createdSessionId,
          bookingId: bookingId,
          userId: ownerUserId || null,
          userEmail: updated.userEmail,
          userName: updated.userName || updated.userEmail,
          totalFeeCents: breakdown.totals.totalCents,
          feeBreakdown: { overageCents: breakdown.totals.overageCents, guestCents: breakdown.totals.guestCents },
          createdSessionId: createdSessionId
        };
      }
    } catch (feeError: unknown) {
      logger.error('[Booking Approval] Fee calculation after commit failed (non-blocking)', { extra: { createdSessionId, feeError: getErrorMessage(feeError) } });
    }
  }

  if (bayName !== null) {
    if (calendarData && !calendarData.existingCalendarEventId) {
      try {
        const calendarId = await getCalendarIdByName(calendarData.calendarName);
        if (calendarId) {
          const summary = `Booking: ${calendarData.userName || calendarData.userEmail}`;
          const description = `Area: ${calendarData.bayName}\nMember: ${calendarData.userEmail}\nDuration: ${calendarData.durationMinutes} minutes${calendarData.notes ? '\nNotes: ' + calendarData.notes : ''}`;
          const newCalendarEventId = await createCalendarEventOnCalendar(calendarId, summary, description, calendarData.requestDate, calendarData.startTime, calendarData.endTime);
          if (newCalendarEventId) {
            await db.update(bookingRequests)
              .set({ calendarEventId: newCalendarEventId })
              .where(eq(bookingRequests.id, bookingId));
          }
        }
      } catch (calError: unknown) {
        logger.error('Calendar sync failed (non-blocking)', { extra: { calError } });
      }
    }

    if (prepaymentData) {
      try {
        const prepayResult = await createPrepaymentIntent({
          sessionId: prepaymentData.sessionId,
          bookingId: prepaymentData.bookingId,
          userId: prepaymentData.userId,
          userEmail: prepaymentData.userEmail,
          userName: prepaymentData.userName,
          totalFeeCents: prepaymentData.totalFeeCents,
          feeBreakdown: prepaymentData.feeBreakdown
        });
        if (prepayResult?.paidInFull) {
          await db.update(bookingParticipants)
            .set({ paymentStatus: 'paid' })
            .where(and(
              eq(bookingParticipants.sessionId, prepaymentData.createdSessionId),
              eq(bookingParticipants.paymentStatus, 'pending')
            ));
          await logPaymentAudit({
            bookingId: prepaymentData.bookingId,
            sessionId: prepaymentData.createdSessionId,
            action: 'payment_confirmed',
            staffEmail: 'system',
            amountAffected: prepaymentData.totalFeeCents / 100,
            paymentMethod: 'account_credit'
          });
          logger.info('[Booking Approval] Prepayment fully covered by credit for session', { extra: { createdSessionId: prepaymentData.createdSessionId } });
        }
      } catch (prepayError: unknown) {
        logger.error('[Booking Approval] Failed to create prepayment intent', { extra: { prepayError } });
      }
    }

    if (isConferenceRoom && prepaymentData && prepaymentData.bookingId) {
      const existingInvoiceId = await getBookingInvoiceId(prepaymentData.bookingId);
      if (existingInvoiceId) {
        try {
          const invoiceResult = await finalizeAndPayInvoice({ bookingId: prepaymentData.bookingId });
          if (invoiceResult?.paidInFull) {
            await db.update(bookingParticipants)
              .set({ paymentStatus: 'paid' })
              .where(and(
                eq(bookingParticipants.sessionId, prepaymentData.createdSessionId),
                eq(bookingParticipants.paymentStatus, 'pending')
              ));
            logger.info('[Booking Approval] Conference room invoice finalized and paid for booking', { extra: { bookingId: prepaymentData.bookingId, invoiceId: invoiceResult.invoiceId } });
          }
        } catch (invoiceError: unknown) {
          logger.error('[Booking Approval] Failed to finalize conference room invoice (non-blocking)', { extra: { bookingId: prepaymentData.bookingId, invoiceError: getErrorMessage(invoiceError) } });
        }
      } else {
        logger.info('[Booking Approval] No invoice found for conference room booking — skipping finalization', { extra: { bookingId: prepaymentData.bookingId } });
      }
    }

    sendPushNotification(updated.userEmail, {
      title: 'Booking Approved!',
      body: approvalMessage,
      url: '/sims',
      tag: `booking-${bookingId}`
    }).catch(err => logger.error('Push notification failed:', { extra: { err } }));

    notifyLinkedMembers(bookingId, updated as unknown as BookingUpdateResult)
      .catch(err => logger.error('[Approval] Group notification failed', { extra: { error: getErrorMessage(err) } }));

    bookingEvents.publish('booking_approved', {
      bookingId,
      memberEmail: updated.userEmail,
      memberName: updated.userName || undefined,
      resourceId: updated.resourceId || undefined,
      resourceName: bayName,
      bookingDate: updated.requestDate,
      startTime: updated.startTime,
      endTime: updated.endTime,
      status: 'approved',
      actionBy: 'staff'
    }, { notifyMember: true, notifyStaff: true, cleanupNotifications: true }).catch(err => logger.error('Booking event publish failed:', { extra: { err } }));

    broadcastAvailabilityUpdate({
      resourceId: updated.resourceId || undefined,
      resourceType: isConferenceRoom ? 'conference_room' : 'simulator',
      date: updated.requestDate,
      action: 'booked'
    });

    sendNotificationToUser(updated.userEmail, {
      type: 'notification',
      title: 'Booking Approved',
      message: approvalMessage,
      data: { bookingId, eventType: 'booking_approved' }
    }, { action: 'booking_approved', bookingId, triggerSource: 'approval.ts' });

    notifyApprovalParticipants(bookingId, updated as unknown as BookingUpdateResult)
      .catch(err => logger.error('[Approval] Group notification failed', { extra: { error: getErrorMessage(err) } }));
  }

  const requestParticipantsForVisitors = (updated as Record<string, unknown>).requestParticipants as Array<{
    email?: string; type: 'member' | 'guest'; name?: string;
  }> | null;
  if (requestParticipantsForVisitors && Array.isArray(requestParticipantsForVisitors)) {
    for (const rp of requestParticipantsForVisitors) {
      if (rp?.type === 'guest' && rp.email) {
        const nameParts = (rp.name || '').trim().split(/\s+/);
        const firstName = nameParts[0] || undefined;
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
        upsertVisitor({ email: rp.email.toLowerCase().trim(), firstName, lastName }, false)
          .then(v => logger.info('[Booking Approval] Visitor record ensured for guest', { extra: { email: rp.email, visitorUserId: v.id, bookingId } }))
          .catch(err => logger.error('[Booking Approval] Non-blocking visitor upsert failed', { extra: { email: rp.email, error: getErrorMessage(err) } }));
      }
    }
  }

  return { updated, isConferenceRoom };
}

async function notifyLinkedMembers(bookingId: number, updated: BookingUpdateResult) {
  try {
    const sessionResult = await db.select({ sessionId: bookingRequests.sessionId })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId))
      .limit(1);
    const sessionId = sessionResult[0]?.sessionId;
    if (!sessionId) return;

    const linkedMembers = await db.select({ userEmail: users.email })
      .from(bookingParticipants)
      .innerJoin(users, eq(bookingParticipants.userId, users.id))
      .where(and(
        eq(bookingParticipants.sessionId, sessionId),
        sql`${bookingParticipants.participantType} != 'owner'`,
        sql`${users.email} IS NOT NULL`
      ));

    for (const member of linkedMembers) {
      if (member.userEmail && member.userEmail.toLowerCase() !== updated.userEmail.toLowerCase() && !isSyntheticEmail(member.userEmail)) {
        const linkedMessage = `A booking you're part of has been confirmed for ${formatNotificationDateTime(updated.requestDate, updated.startTime)}.`;

        await notifyMember({
          userEmail: member.userEmail,
          title: 'Booking Confirmed',
          message: linkedMessage,
          type: 'booking_approved',
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/sims'
        }, { sendPush: true }).catch((err) => {
          logger.error('[approval] Failed to send notification on approval', {
            error: err instanceof Error ? err : new Error(String(err))
          });
        });

        sendNotificationToUser(member.userEmail, {
          type: 'notification',
          title: 'Booking Confirmed',
          message: linkedMessage,
          data: { bookingId, eventType: 'booking_approved' }
        }, { action: 'booking_approved_linked', bookingId, triggerSource: 'approval.ts' });
      }
    }
  } catch (err: unknown) {
    logger.error('Failed to notify linked members', { extra: { err } });
  }
}

async function notifyApprovalParticipants(bookingId: number, updated: BookingUpdateResult) {
  if (!updated.userEmail) return;

  try {
    const requestParticipants = updated.requestParticipants as Array<{
      email?: string;
      type: 'member' | 'guest';
      userId?: string;
      name?: string;
    }> | null;

    if (!requestParticipants || !Array.isArray(requestParticipants) || requestParticipants.length === 0) return;

    const ownerEmailLower = updated.userEmail?.toLowerCase();
    const ownerName = updated.userName || updated.userEmail?.split('@')[0] || 'A member';
    const formattedDate = formatDateDisplayWithDay(updated.requestDate);
    const formattedTime = formatTime12Hour(updated.startTime || '');
    const processedEmails = new Set<string>();

    for (const rp of requestParticipants) {
      if (!rp || typeof rp !== 'object') continue;
      if (rp.type !== 'member') continue;

      let participantEmail = rp.email?.toLowerCase()?.trim() || '';
      if (!participantEmail && rp.userId) {
        const userResult = await db.select({ email: users.email })
          .from(users)
          .where(eq(users.id, rp.userId))
          .limit(1);
        if (userResult.length > 0) {
          participantEmail = userResult[0].email?.toLowerCase() || '';
        }
      }

      if (!participantEmail) continue;
      if (participantEmail === ownerEmailLower) continue;
      if (processedEmails.has(participantEmail)) continue;
      if (isSyntheticEmail(participantEmail)) continue;
      processedEmails.add(participantEmail);

      const notificationMsg = `${ownerName} has added you to their simulator booking on ${formattedDate} at ${formattedTime}.`;

      await notifyMember({
        userEmail: participantEmail,
        title: 'Added to Booking',
        message: notificationMsg,
        type: 'booking',
        relatedType: 'booking',
        relatedId: bookingId,
        url: '/sims'
      }, { sendPush: true }).catch(err => logger.error('[approval] Participant notification failed', { extra: { error: getErrorMessage(err) } }));

      sendNotificationToUser(participantEmail, {
        type: 'notification',
        title: 'Added to Booking',
        message: notificationMsg,
        data: { bookingId: bookingId.toString(), eventType: 'booking_participant_added' }
      }, { action: 'booking_participant_added', bookingId, triggerSource: 'approval.ts' });

      logger.info('[Approval] Sent Added to Booking notification', { extra: { participantEmail, bookingId } });
    }
  } catch (notifyErr: unknown) {
    logger.error('[Approval] Failed to notify participants (non-blocking)', { extra: { notifyErr } });
  }
}

interface DeclineBookingParams {
  bookingId: number;
  staff_notes?: string;
  suggested_time?: string;
  reviewed_by?: string;
}

export async function declineBooking(params: DeclineBookingParams) {
  const { bookingId, staff_notes, suggested_time, reviewed_by } = params;

  const { updated, declineMessage, resourceTypeName: _resourceTypeName } = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));

    if (!existing) {
      throw new AppError(404, 'Booking request not found');
    }

    const declinableStatuses = ['pending', 'pending_approval'];
    if (!declinableStatuses.includes(existing.status || '')) {
      throw new AppError(409, `Cannot decline a booking that is already ${existing.status}. Use cancel instead.`);
    }

    let resourceTypeName = 'simulator';
    if (existing.resourceId) {
      const [resource] = await tx.select({ type: resources.type }).from(resources).where(eq(resources.id, existing.resourceId));
      if (resource?.type === 'conference_room') {
        resourceTypeName = 'conference room';
      }
    }

    const [updatedRow] = await tx.update(bookingRequests)
      .set({
        status: 'declined',
        isUnmatched: false,
        staffNotes: staff_notes,
        suggestedTime: suggested_time,
        reviewedBy: reviewed_by,
        reviewedAt: new Date(),
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        or(eq(bookingRequests.status, 'pending'), eq(bookingRequests.status, 'pending_approval'))
      ))
      .returning();

    if (!updatedRow) {
      throw new AppError(409, 'Booking was modified by another staff member. Please refresh.');
    }

    const declineMessage = suggested_time
      ? `Your ${resourceTypeName} booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined. Suggested alternative: ${formatTime12Hour(suggested_time)}`
      : `Your ${resourceTypeName} booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined.`;

    await tx.update(notifications)
      .set({ isRead: true })
      .where(and(
        eq(notifications.relatedId, bookingId),
        eq(notifications.relatedType, 'booking_request'),
        eq(notifications.type, 'booking')
      ));

    return { updated: updatedRow, declineMessage, resourceTypeName };
  });

  if (updated.userEmail && !isSyntheticEmail(updated.userEmail)) {
    notifyMember({
      userEmail: updated.userEmail,
      title: 'Booking Request Declined',
      message: declineMessage,
      type: 'booking_declined',
      relatedId: bookingId,
      relatedType: 'booking_request',
      url: '/dashboard'
    }, { sendPush: true }).catch(err => logger.error('[Approval] Decline notification failed', { extra: { error: getErrorMessage(err) } }));
  }

  await releaseGuestPassHold(bookingId);

  voidBookingInvoice(bookingId).catch(err => {
    logger.warn('[Decline] Non-blocking: failed to void draft invoice', { extra: { bookingId, error: getErrorMessage(err) } });
  });

  (async () => {
    try {
      await cancelPendingPaymentIntentsForBooking(bookingId);
    } catch (err: unknown) {
      logger.warn('[Decline] Non-blocking: failed to cancel pending payment intents', { extra: { bookingId, error: getErrorMessage(err) } });
    }
    try {
      await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_action')`);
    } catch (err: unknown) {
      logger.warn('[Decline] Non-blocking: failed to clean up fee snapshots', { extra: { bookingId, error: getErrorMessage(err) } });
    }
  })().catch(err => logger.error('[Decline] Unhandled async error in fee snapshot cleanup', { extra: { bookingId, error: getErrorMessage(err) } }));

  sendPushNotification(updated.userEmail, {
    title: 'Booking Request Update',
    body: declineMessage,
    url: '/sims',
    tag: `booking-${bookingId}`
  }).catch(err => logger.error('Push notification failed:', { extra: { err } }));

  bookingEvents.publish('booking_declined', {
    bookingId,
    memberEmail: updated.userEmail,
    memberName: updated.userName || undefined,
    bookingDate: updated.requestDate,
    startTime: updated.startTime,
    status: 'declined',
    actionBy: 'staff'
  }, { notifyMember: true, notifyStaff: true, cleanupNotifications: true }).catch(err => logger.error('Booking event publish failed:', { extra: { err } }));

  sendNotificationToUser(updated.userEmail, {
    type: 'notification',
    title: 'Booking Declined',
    message: declineMessage,
    data: { bookingId, eventType: 'booking_declined' }
  }, { action: 'booking_declined', bookingId, triggerSource: 'approval.ts' });

  return { updated };
}
