import { db } from '../../db';
import { bookingRequests, resources, notifications, users, bookingParticipants, stripePaymentIntents } from '../../../shared/schema';
import { eq, and, or, gt, lt, lte, gte, ne, sql, isNull, isNotNull } from 'drizzle-orm';
import { sendPushNotification } from '../../routes/push';
import { formatNotificationDateTime, formatDateDisplayWithDay, formatTime12Hour } from '../../utils/dateUtils';
import { logger } from '../logger';
import { notifyAllStaff, notifyMember } from '../notificationService';
import { checkClosureConflict, checkAvailabilityBlockConflict } from '../bookingValidation';
import { bookingEvents } from '../bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate, broadcastMemberStatsUpdated, broadcastBillingUpdate } from '../websocket';
import { refundGuestPass } from '../../routes/guestPasses';
import { updateHubSpotContactVisitCount } from '../memberSync';
import { createSessionWithUsageTracking, ensureSessionForBooking } from './sessionManager';
import { recalculateSessionFees } from '../billing/unifiedFeeService';
import { PaymentStatusService } from '../billing/PaymentStatusService';
import { cancelPaymentIntent, getStripeClient } from '../stripe';
import { cancelPendingPaymentIntentsForBooking } from '../billing/paymentIntentCleanup';
import Stripe from 'stripe';
import { getCalendarNameForBayAsync } from '../../routes/bays/helpers';
import { getCalendarIdByName, createCalendarEventOnCalendar, deleteCalendarEvent } from '../calendar/index';
import { releaseGuestPassHold } from '../billing/guestPassHoldService';
import { createPrepaymentIntent } from '../billing/prepaymentService';
import { voidBookingInvoice, finalizeAndPayInvoice } from '../billing/bookingInvoiceService';
import { getErrorMessage, getErrorStatusCode } from '../../utils/errorUtils';
import { logPaymentAudit } from '../auditLog';

type SqlQueryParam = string | number | boolean | null | Date;

interface BookingRow {
  id: number;
  userEmail: string;
  userName: string | null;
  resourceId: number | null;
  resourcePreference: string | null;
  requestDate: string;
  startTime: string;
  durationMinutes: number;
  endTime: string;
  notes: string | null;
  status: string | null;
  staffNotes: string | null;
  suggestedTime: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  calendarEventId: string | null;
  rescheduleBookingId: number | null;
}

interface BookingUpdateResult {
  id: number;
  userEmail: string;
  userName: string | null;
  userId: string | null;
  resourceId: number | null;
  requestDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  status: string | null;
  calendarEventId: string | null;
  trackmanBookingId: string | null;
  sessionId: number | null;
  requestParticipants: Array<{ email?: string; type: 'member' | 'guest'; userId?: string; name?: string }> | null;
  memberNotes: string | null;
  notes: string | null;
}

interface CancelBookingData {
  userEmail: string;
  userName: string | null;
  resourceId: number | null;
  requestDate: string;
  startTime: string;
  calendarEventId: string | null;
  sessionId: number | null;
  status: string | null;
}

interface CancelPushInfo {
  type: 'both' | 'staff' | 'member';
  email?: string;
  message: string;
  staffMessage?: string;
  memberMessage?: string;
  memberName?: string;
  bookingDate?: string;
  bookingTime?: string;
  bayName?: string;
}

interface OverageRefundResult {
  refunded?: boolean;
  amountCents?: number;
  error?: string;
}

export function formatBookingRow(row: BookingRow) {
  return {
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
    reschedule_booking_id: row.rescheduleBookingId
  };
}

export async function validateTrackmanId(trackmanBookingId: string, bookingId: number): Promise<{ valid: boolean; error?: string; statusCode?: number; unlinkedFromBookingId?: number }> {
  if (!/^\d+$/.test(trackmanBookingId)) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Trackman Booking ID must be a number (e.g., 19510379). UUIDs and other formats are not valid Trackman IDs.'
    };
  }

  const [duplicate] = await db.select({ id: bookingRequests.id, status: bookingRequests.status, userEmail: bookingRequests.userEmail })
    .from(bookingRequests)
    .where(and(
      eq(bookingRequests.trackmanBookingId, trackmanBookingId),
      ne(bookingRequests.id, bookingId)
    ))
    .limit(1);

  if (duplicate) {
    const terminalStatuses = ['cancelled', 'cancellation_pending', 'declined', 'no_show'];
    if (terminalStatuses.includes(duplicate.status || '')) {
      await db.update(bookingRequests)
        .set({ trackmanBookingId: null })
        .where(eq(bookingRequests.id, duplicate.id));
    } else {
      const [currentBooking] = await db.select({ userEmail: bookingRequests.userEmail })
        .from(bookingRequests)
        .where(eq(bookingRequests.id, bookingId))
        .limit(1);

      const sameEmail = currentBooking?.userEmail && duplicate.userEmail &&
        currentBooking.userEmail.toLowerCase() === duplicate.userEmail.toLowerCase();

      if (sameEmail) {
        const duplicateId = duplicate.id as number;

        await db.update(bookingRequests)
          .set({
            trackmanBookingId: null,
            status: 'declined',
            staffNotes: sql`COALESCE(staff_notes, '') || ' [Auto-declined: Trackman ID re-linked to booking #' || ${bookingId}::text || ' for the same member]'`,
            reviewedBy: 'system_relink',
            reviewedAt: sql`NOW()`,
            updatedAt: sql`NOW()`
          })
          .where(eq(bookingRequests.id, duplicateId));

        const [orphanedSession] = await db.execute(sql`
          SELECT id FROM booking_sessions WHERE id = (
            SELECT session_id FROM booking_requests WHERE id = ${duplicateId}
          )
        `).then(r => r.rows as Array<Record<string, unknown>>);

        try {
          await cancelPendingPaymentIntentsForBooking(duplicateId);
          logger.info('[ValidateTrackmanId] Cleaned up payment intents for orphaned booking', {
            extra: { declinedBookingId: duplicateId }
          });
        } catch (piErr: unknown) {
          logger.warn('[ValidateTrackmanId] Payment intent cleanup failed for orphaned booking (non-blocking)', {
            extra: { declinedBookingId: duplicateId, error: piErr instanceof Error ? piErr.message : String(piErr) }
          });
        }

        try {
          const stripe = getStripeClient();

          const allSnapshots = await db.execute(sql`
            SELECT id, stripe_payment_intent_id, total_cents
            FROM booking_fee_snapshots
            WHERE booking_id = ${duplicateId} AND stripe_payment_intent_id IS NOT NULL
          `);
          for (const snapshot of allSnapshots.rows as any[]) {
            try {
              const pi = await stripe.paymentIntents.retrieve(snapshot.stripe_payment_intent_id);
              if (pi.status === 'succeeded') {
                const refund = await stripe.refunds.create({
                  payment_intent: snapshot.stripe_payment_intent_id,
                  reason: 'requested_by_customer'
                }, {
                  idempotencyKey: `refund_trackman_relink_snapshot_${duplicateId}_${snapshot.stripe_payment_intent_id}`
                });
                await PaymentStatusService.markPaymentRefunded({
                  paymentIntentId: snapshot.stripe_payment_intent_id,
                  bookingId: duplicateId,
                  refundId: refund.id,
                  amountCents: pi.amount
                });
                logger.info('[ValidateTrackmanId] Refunded fee snapshot for orphaned booking', {
                  extra: { paymentIntentId: snapshot.stripe_payment_intent_id, refundId: refund.id, declinedBookingId: duplicateId }
                });
              }
            } catch (snapErr: unknown) {
              logger.warn('[ValidateTrackmanId] Fee snapshot refund failed (non-blocking)', {
                extra: { paymentIntentId: snapshot.stripe_payment_intent_id, error: snapErr instanceof Error ? snapErr.message : String(snapErr) }
              });
            }
          }

          const invoices = await stripe.invoices.search({
            query: `metadata["booking_id"]:"${duplicateId}"`,
            limit: 5
          });
          for (const invoice of invoices.data) {
            if (invoice.status === 'draft') {
              await stripe.invoices.del(invoice.id);
              logger.info('[ValidateTrackmanId] Deleted draft invoice for orphaned booking', {
                extra: { invoiceId: invoice.id, declinedBookingId: duplicateId }
              });
            } else if (invoice.status === 'open') {
              await stripe.invoices.voidInvoice(invoice.id);
              logger.info('[ValidateTrackmanId] Voided open invoice for orphaned booking', {
                extra: { invoiceId: invoice.id, declinedBookingId: duplicateId }
              });
            }
          }
        } catch (invoiceErr: unknown) {
          logger.warn('[ValidateTrackmanId] Stripe cleanup failed for orphaned booking (non-blocking)', {
            extra: { declinedBookingId: duplicateId, error: invoiceErr instanceof Error ? invoiceErr.message : String(invoiceErr) }
          });
        }

        if (orphanedSession?.id) {
          await db.execute(sql`UPDATE booking_requests SET session_id = NULL WHERE session_id = ${orphanedSession.id}`);
          await db.execute(sql`DELETE FROM booking_participants WHERE session_id = ${orphanedSession.id}`);
          await db.execute(sql`DELETE FROM booking_sessions WHERE id = ${orphanedSession.id}`);
          logger.info('[ValidateTrackmanId] Cleaned up orphaned session', {
            extra: { sessionId: orphanedSession.id, declinedBookingId: duplicateId }
          });
        }

        logger.info('[ValidateTrackmanId] Declined orphaned same-member booking', {
          extra: { declinedBookingId: duplicateId, relinkToBookingId: bookingId, trackmanBookingId }
        });

        return { valid: true, unlinkedFromBookingId: duplicateId };
      }

      return {
        valid: false,
        statusCode: 409,
        error: `Trackman Booking ID ${trackmanBookingId} is already linked to another booking (#${duplicate.id}). Each Trackman booking can only be linked once.`
      };
    }
  }

  return { valid: true };
}

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
    const [req_data] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));

    if (!req_data) {
      throw { statusCode: 404, error: 'Request not found' };
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
      throw { statusCode: 409, error: `Booking is already ${req_data.status}. Please refresh the page.` };
    }

    const assignedBayId = resource_id || req_data.resourceId;

    if (!assignedBayId) {
      throw { statusCode: 400, error: 'Bay must be assigned before approval' };
    }

    const conflicts = await tx.select().from(bookingRequests).where(and(
      eq(bookingRequests.resourceId, assignedBayId),
      eq(bookingRequests.requestDate, req_data.requestDate),
      or(
        eq(bookingRequests.status, 'approved'),
        eq(bookingRequests.status, 'confirmed'),
        eq(bookingRequests.status, 'attended'),
        eq(bookingRequests.status, 'pending')
      ),
      ne(bookingRequests.id, bookingId),
      or(
        and(lte(bookingRequests.startTime, req_data.startTime), gt(bookingRequests.endTime, req_data.startTime)),
        and(lt(bookingRequests.startTime, req_data.endTime), gte(bookingRequests.endTime, req_data.endTime)),
        and(gte(bookingRequests.startTime, req_data.startTime), lte(bookingRequests.endTime, req_data.endTime))
      )
    ));

    if (conflicts.length > 0) {
      throw { statusCode: 409, error: 'Time slot conflicts with existing booking' };
    }

    const closureCheck = await checkClosureConflict(assignedBayId, req_data.requestDate, req_data.startTime, req_data.endTime);
    if (closureCheck.hasConflict) {
      throw {
        statusCode: 409,
        error: 'Cannot approve booking during closure',
        message: `This time slot conflicts with "${closureCheck.closureTitle}". Please decline this request or wait until the closure ends.`
      };
    }

    const blockCheck = await checkAvailabilityBlockConflict(assignedBayId, req_data.requestDate, req_data.startTime, req_data.endTime);
    if (blockCheck.hasConflict) {
      throw {
        statusCode: 409,
        error: 'Cannot approve booking during event block',
        message: `This time slot is blocked: ${blockCheck.blockType || 'Event block'}. Please decline this request or reschedule.`
      };
    }

    const bayResult = await tx.select({ name: resources.name, type: resources.type }).from(resources).where(eq(resources.id, assignedBayId));
    const bayName = bayResult[0]?.name || 'Simulator';
    const isConferenceRoom = bayResult[0]?.type === 'conference_room';

    let calendarEventId: string | null = req_data.calendarEventId || null;
    const calendarName = await getCalendarNameForBayAsync(assignedBayId);

    const finalStatus = isConferenceRoom ? 'attended' : 'approved';

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
      throw { statusCode: 409, error: 'Booking was modified by another staff member. Please refresh and try again.' };
    }

    let createdSessionId: number | null = null;
    let createdParticipantIds: number[] = [];
    if (!updatedRow.sessionId) {
      try {
        let ownerUserId = updatedRow.userId;
        if (!ownerUserId && updatedRow.userEmail) {
          const userResult = await tx.select({ id: users.id })
            .from(users)
            .where(eq(users.email, updatedRow.userEmail.toLowerCase()))
            .limit(1);
          if (userResult.length > 0) {
            ownerUserId = userResult[0].id;
            await tx.update(bookingRequests)
              .set({ userId: ownerUserId })
              .where(eq(bookingRequests.id, bookingId));
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
          displayName: updatedRow.userName || updatedRow.userEmail
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
            let isMember = rp.type === 'member';

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
                resolvedName = memberResult[0].firstName || memberResult[0].email;
              }
            }

            if (isMember && resolvedUserId) {
              sessionParticipants.push({
                userId: resolvedUserId,
                participantType: 'member',
                displayName: resolvedName || rpEmailNormalized || 'Member'
              });
              addedUserIds.add(resolvedUserId);
              if (rpEmailNormalized) addedEmails.add(rpEmailNormalized);
            } else {
              sessionParticipants.push({
                participantType: 'guest',
                displayName: resolvedName || rp.name || rpEmailNormalized || 'Guest'
              });
              if (rpEmailNormalized) addedEmails.add(rpEmailNormalized);
            }
          }
          logger.info('[Booking Approval] Converted request participants to session participants (plus owner)', { extra: { requestParticipantsLength: requestParticipants.length, sessionParticipantsLength_1: sessionParticipants.length - 1 } });
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
          throw { statusCode: 500, error: 'Failed to create booking session. Please try again.', details: sessionResult.error };
        }
      } catch (sessionError: unknown) {
        logger.error('[Booking Approval] Failed to create session', { extra: { sessionError } });
        throw { statusCode: 500, error: 'Failed to create booking session. Please try again.', details: getErrorMessage(sessionError) || sessionError };
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

    await tx.insert(notifications).values({
      userEmail: updatedRow.userEmail,
      title: 'Booking Request Approved',
      message: approvalMessage,
      type: 'booking_approved',
      relatedId: updatedRow.id,
      relatedType: 'booking_request'
    });

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

  let prepaymentData: { sessionId: number; bookingId: number; userId: string | null; userEmail: string; userName: string; totalFeeCents: number; feeBreakdown: { overageCents: number; guestCents: number }; createdSessionId: number } | null = null;
  if (createdSessionId && createdParticipantIds.length > 0) {
    try {
      const breakdown = await recalculateSessionFees(createdSessionId, 'approval');
      logger.info('[Booking Approval] Applied unified fees for session : $, overage: $', { extra: { createdSessionId, breakdownTotalsTotalCents_100_ToFixed_2: (breakdown.totals.totalCents/100).toFixed(2), breakdownTotalsOverageCents_100_ToFixed_2: (breakdown.totals.overageCents/100).toFixed(2) } });

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
    }

    sendPushNotification(updated.userEmail, {
      title: 'Booking Approved!',
      body: approvalMessage,
      url: '/sims'
    }).catch(err => logger.error('Push notification failed:', { extra: { err } }));

    notifyLinkedMembers(bookingId, updated as any);

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

    notifyApprovalParticipants(bookingId, updated as any);
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
      if (member.userEmail && member.userEmail.toLowerCase() !== updated.userEmail.toLowerCase()) {
        const linkedMessage = `A booking you're part of has been confirmed for ${formatNotificationDateTime(updated.requestDate, updated.startTime)}.`;

        await db.insert(notifications).values({
          userEmail: member.userEmail,
          title: 'Booking Confirmed',
          message: linkedMessage,
          type: 'booking_approved',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });

        sendPushNotification(member.userEmail, {
          title: 'Booking Confirmed',
          body: linkedMessage,
          tag: `booking-approved-linked-${bookingId}`
        }).catch((err) => {
          logger.error('[approval] Failed to send push notification on approval', {
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
      processedEmails.add(participantEmail);

      const notificationMsg = `${ownerName} has added you to their simulator booking on ${formattedDate} at ${formattedTime}.`;

      await db.insert(notifications).values({
        userEmail: participantEmail,
        title: 'Added to Booking',
        message: notificationMsg,
        type: 'booking',
        relatedType: 'booking',
        relatedId: bookingId
      });

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

  const { updated, declineMessage, resourceTypeName } = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bookingRequests).where(eq(bookingRequests.id, bookingId));

    if (!existing) {
      throw { statusCode: 404, error: 'Booking request not found' };
    }

    const declinableStatuses = ['pending', 'pending_approval'];
    if (!declinableStatuses.includes(existing.status || '')) {
      throw { statusCode: 409, error: `Cannot decline a booking that is already ${existing.status}. Use cancel instead.` };
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
      throw { statusCode: 409, error: 'Booking was modified by another staff member. Please refresh.' };
    }

    const declineMessage = suggested_time
      ? `Your ${resourceTypeName} booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined. Suggested alternative: ${formatTime12Hour(suggested_time)}`
      : `Your ${resourceTypeName} booking request for ${formatDateDisplayWithDay(updatedRow.requestDate)} was declined.`;

    await tx.insert(notifications).values({
      userEmail: updatedRow.userEmail,
      title: 'Booking Request Declined',
      message: declineMessage,
      type: 'booking_declined',
      relatedId: updatedRow.id,
      relatedType: 'booking_request'
    });

    await tx.update(notifications)
      .set({ isRead: true })
      .where(and(
        eq(notifications.relatedId, bookingId),
        eq(notifications.relatedType, 'booking_request'),
        eq(notifications.type, 'booking')
      ));

    return { updated: updatedRow, declineMessage, resourceTypeName };
  });

  await releaseGuestPassHold(bookingId);

  voidBookingInvoice(bookingId).catch(err => {
    logger.warn('[Decline] Non-blocking: failed to void draft invoice', { extra: { bookingId, error: getErrorMessage(err) } });
  });

  sendPushNotification(updated.userEmail, {
    title: 'Booking Request Update',
    body: declineMessage,
    url: '/sims'
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

interface CancelBookingParams {
  bookingId: number;
  staff_notes?: string;
  cancelled_by?: string;
}

export async function cancelBooking(params: CancelBookingParams) {
  const { bookingId, staff_notes, cancelled_by } = params;

  const { updated, bookingData, pushInfo, overageRefundResult, isConferenceRoom: isConfRoom, isPendingCancel, alreadyPending, stripeCleanupData } = await db.transaction(async (tx) => {
    const [existing] = await tx.select({
      id: bookingRequests.id,
      calendarEventId: bookingRequests.calendarEventId,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      status: bookingRequests.status,
      resourceId: bookingRequests.resourceId,
      trackmanBookingId: bookingRequests.trackmanBookingId,
      sessionId: bookingRequests.sessionId,
      staffNotes: bookingRequests.staffNotes
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));

    if (!existing) {
      throw { statusCode: 404, error: 'Booking request not found' };
    }

    if (existing.status === 'cancellation_pending') {
      return {
        updated: existing,
        bookingData: existing,
        pushInfo: null as Record<string, unknown> | null,
        overageRefundResult: {},
        isConferenceRoom: false,
        isPendingCancel: true,
        alreadyPending: true,
        stripeCleanupData: { snapshotIntents: [] as Array<{ stripePaymentIntentId: string }>, orphanIntents: [] as Array<{ stripePaymentIntentId: string }>, paidParticipants: [] as Array<{ id: number; stripePaymentIntentId: string; cachedFeeCents: number; displayName: string }>, sessionId: null as number | null }
      };
    }

    const isTrackmanLinked = !!existing.trackmanBookingId && /^\d+$/.test(existing.trackmanBookingId);
    const wasApproved = ['approved', 'confirmed'].includes(existing.status);
    const needsPendingCancel = isTrackmanLinked && wasApproved;

    if (needsPendingCancel) {
      const [updatedRow] = await tx.update(bookingRequests)
        .set({
          status: 'cancellation_pending',
          cancellationPendingAt: new Date(),
          staffNotes: (existing.staffNotes || '') + '\n[Staff initiated cancellation - awaiting Trackman cancellation]',
          updatedAt: new Date()
        })
        .where(eq(bookingRequests.id, bookingId))
        .returning();

      const memberName = existing.userName || existing.userEmail || 'Member';
      const bookingDate = existing.requestDate;
      const bookingTime = existing.startTime?.substring(0, 5) || '';
      let bayName = 'Bay';
      if (existing.resourceId) {
        const [resource] = await tx.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
        if (resource?.name) bayName = resource.name;
      }

      return {
        updated: updatedRow,
        bookingData: existing,
        pushInfo: { type: 'staff' as const, memberName, bookingDate, bookingTime, bayName },
        overageRefundResult: {},
        isConferenceRoom: false,
        isPendingCancel: true,
        alreadyPending: false,
        stripeCleanupData: { snapshotIntents: [] as Array<{ stripePaymentIntentId: string }>, orphanIntents: [] as Array<{ stripePaymentIntentId: string }>, paidParticipants: [] as Array<{ id: number; stripePaymentIntentId: string; cachedFeeCents: number; displayName: string }>, sessionId: null as number | null }
      };
    }

    let isConferenceRoom = false;
    if (existing.resourceId) {
      const [resource] = await tx.select({ type: resources.type }).from(resources).where(eq(resources.id, existing.resourceId));
      isConferenceRoom = resource?.type === 'conference_room';
    }

    const overageRefundResult: { cancelled?: boolean; refunded?: boolean; amount?: number; error?: string } = {};

    const snapshotIntents: Array<{ stripePaymentIntentId: string }> = [];
    const orphanIntents: Array<{ stripePaymentIntentId: string }> = [];
    let paidParticipantsForRefund: Array<{ id: number; stripePaymentIntentId: string; cachedFeeCents: number; displayName: string }> = [];
    let cleanupSessionId: number | null = null;

    try {
      const allSnapshots = await tx.execute(sql`
        SELECT id, stripe_payment_intent_id, status as snapshot_status, total_cents
         FROM booking_fee_snapshots 
         WHERE booking_id = ${bookingId} AND stripe_payment_intent_id IS NOT NULL
      `);

      for (const snapshot of allSnapshots.rows) {
        snapshotIntents.push({ stripePaymentIntentId: snapshot.stripe_payment_intent_id });
      }

      const otherIntents = await tx.execute(sql`
        SELECT stripe_payment_intent_id 
         FROM stripe_payment_intents 
         WHERE booking_id = ${bookingId} 
         AND stripe_payment_intent_id NOT IN (
           SELECT stripe_payment_intent_id FROM booking_fee_snapshots 
           WHERE booking_id = ${bookingId} AND stripe_payment_intent_id IS NOT NULL
         )
      `);

      for (const row of otherIntents.rows) {
        orphanIntents.push({ stripePaymentIntentId: row.stripe_payment_intent_id });
      }

      if (existing.sessionId) {
        cleanupSessionId = existing.sessionId;

        await tx.update(bookingParticipants)
          .set({ paymentStatus: 'waived' })
          .where(and(
            eq(bookingParticipants.sessionId, existing.sessionId),
            or(
              eq(bookingParticipants.paymentStatus, 'pending'),
              isNull(bookingParticipants.paymentStatus)
            )
          ));
        logger.info('[Staff Cancel] Cleared pending fees for session', { extra: { existingSessionId: existing.sessionId } });
      }
    } catch (cancelIntentsErr: unknown) {
      logger.error('[Staff Cancel] Failed to handle payment intents (non-blocking)', { extra: { cancelIntentsErr } });
    }

    let updatedStaffNotes = staff_notes || '';
    if (existing.trackmanBookingId) {
      const trackmanNote = '[Cancelled in app - needs Trackman cancellation]';
      updatedStaffNotes = updatedStaffNotes
        ? `${updatedStaffNotes}\n${trackmanNote}`
        : trackmanNote;
    }

    const cancellableStatuses = ['pending', 'pending_approval', 'approved', 'confirmed'];
    const [updatedRow] = await tx.update(bookingRequests)
      .set({
        status: 'cancelled',
        staffNotes: updatedStaffNotes || undefined,
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        or(...cancellableStatuses.map(s => eq(bookingRequests.status, s)))
      ))
      .returning();

    if (!updatedRow) {
      throw { statusCode: 409, error: 'Booking was modified by another staff member. Please refresh.' };
    }

    const sessionResult = await tx.select({ sessionId: bookingRequests.sessionId })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));

    let guestPassRefundData: Array<{ displayName: string | null; ownerEmail: string }> = [];

    if (sessionResult[0]?.sessionId) {
      const guestParticipants = await tx.select({ 
        id: bookingParticipants.id, 
        displayName: bookingParticipants.displayName,
        usedGuestPass: bookingParticipants.usedGuestPass
      })
        .from(bookingParticipants)
        .where(and(
          eq(bookingParticipants.sessionId, sessionResult[0].sessionId),
          eq(bookingParticipants.participantType, 'guest')
        ));

      for (const guest of guestParticipants) {
        if (guest.usedGuestPass) {
          guestPassRefundData.push({ displayName: guest.displayName, ownerEmail: existing.userEmail });
        }
      }

      if (guestParticipants.length > 0) {
        logger.info('[bays] Guest pass refunds queued for after transaction', { extra: { guestParticipantsLength: guestParticipants.length, refundCount: guestPassRefundData.length, bookingId } });
      }

      const paidParticipants = await tx.select({
        id: bookingParticipants.id,
        stripePaymentIntentId: bookingParticipants.stripePaymentIntentId,
        cachedFeeCents: bookingParticipants.cachedFeeCents,
        displayName: bookingParticipants.displayName
      })
        .from(bookingParticipants)
        .where(and(
          eq(bookingParticipants.sessionId, sessionResult[0].sessionId),
          eq(bookingParticipants.paymentStatus, 'paid'),
          isNotNull(bookingParticipants.stripePaymentIntentId),
          ne(bookingParticipants.stripePaymentIntentId, ''),
          sql`${bookingParticipants.stripePaymentIntentId} NOT LIKE 'balance-%'`
        ));

      paidParticipantsForRefund = paidParticipants
        .filter((p: { stripePaymentIntentId: string | null }) => p.stripePaymentIntentId)
        .map((p: { id: number; stripePaymentIntentId: string | null; cachedFeeCents: number | null; displayName: string | null }) => ({
          id: p.id,
          stripePaymentIntentId: p.stripePaymentIntentId!,
          cachedFeeCents: p.cachedFeeCents || 0,
          displayName: p.displayName || ''
        }));

      try {
        await tx.update(bookingParticipants)
          .set({ cachedFeeCents: 0, paymentStatus: 'waived' })
          .where(and(
            eq(bookingParticipants.sessionId, sessionResult[0].sessionId),
            eq(bookingParticipants.paymentStatus, 'pending')
          ));
        logger.info('[Staff Cancel] Cleared pending fees for session', { extra: { sessionResult_0_SessionId: sessionResult[0].sessionId } });
      } catch (feeCleanupErr: unknown) {
        logger.error('[Staff Cancel] Failed to clear pending fees (non-blocking)', { extra: { feeCleanupErr } });
      }

      try {
        const sessionRow = await tx.execute(sql`
          SELECT trackman_booking_id FROM booking_sessions WHERE id = ${sessionResult[0].sessionId}
        `);
        const hasTrackmanId = sessionRow.rows[0]?.trackman_booking_id;
        if (!hasTrackmanId) {
          await tx.execute(sql`
            DELETE FROM booking_participants WHERE session_id = ${sessionResult[0].sessionId}
          `);
          await tx.execute(sql`
            UPDATE booking_requests SET session_id = NULL WHERE session_id = ${sessionResult[0].sessionId}
          `);
          await tx.execute(sql`
            DELETE FROM booking_sessions WHERE id = ${sessionResult[0].sessionId}
          `);
          logger.info('[Staff Cancel] Cleaned up orphaned session without Trackman ID', { extra: { sessionId: sessionResult[0].sessionId } });
        }
      } catch (sessionCleanupErr: unknown) {
        logger.error('[Staff Cancel] Failed to clean up session (non-blocking)', { extra: { sessionCleanupErr } });
      }
    }

    let pushInfo: { type: 'staff' | 'member' | 'both'; email?: string; staffMessage?: string; memberMessage?: string; message: string } | null = null;

    const memberEmail = existing.userEmail;
    const memberName = existing.userName || memberEmail;
    const bookingDate = existing.requestDate;
    const memberCancelled = cancelled_by === memberEmail;
    const existingWasApproved = existing.status === 'approved';

    const friendlyDateTime = formatNotificationDateTime(bookingDate, existing.startTime || '00:00');
    const statusLabel = existingWasApproved ? 'booking' : 'booking request';

    if (memberCancelled) {
      const staffMessage = `${memberName} has cancelled their ${statusLabel} for ${friendlyDateTime}.`;
      const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled.`;

      await tx.insert(notifications).values({
        userEmail: memberEmail,
        title: 'Booking Cancelled',
        message: memberMessage,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request'
      });

      pushInfo = { type: 'both', email: memberEmail, staffMessage, memberMessage, message: staffMessage };
    } else {
      const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled by staff.`;

      await tx.insert(notifications).values({
        userEmail: memberEmail,
        title: 'Booking Cancelled',
        message: memberMessage,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request'
      });

      pushInfo = { type: 'member', email: memberEmail, message: memberMessage };
    }

    await tx.update(notifications)
      .set({ isRead: true })
      .where(and(
        eq(notifications.relatedId, bookingId),
        eq(notifications.relatedType, 'booking_request'),
        eq(notifications.type, 'booking')
      ));

    const stripeCleanupData = {
      snapshotIntents,
      orphanIntents,
      paidParticipants: paidParticipantsForRefund,
      sessionId: cleanupSessionId || sessionResult?.[0]?.sessionId || null
    };

    return { updated: updatedRow, bookingData: existing, pushInfo, overageRefundResult, isConferenceRoom, isPendingCancel: false, alreadyPending: false, stripeCleanupData, guestPassRefundData };
  });

  if (guestPassRefundData && guestPassRefundData.length > 0) {
    for (const refund of guestPassRefundData) {
      try {
        await refundGuestPass(refund.ownerEmail, refund.displayName || undefined, false);
      } catch (refundErr: unknown) {
        logger.error('[Staff Cancel] Failed to refund guest pass (non-blocking)', { extra: { ownerEmail: refund.ownerEmail, displayName: refund.displayName, error: getErrorMessage(refundErr) } });
      }
    }
    logger.info('[Staff Cancel] Guest pass refunds completed', { extra: { count: guestPassRefundData.length, bookingId } });
  }

  if (!isPendingCancel && stripeCleanupData) {
    const hasStripeWork = stripeCleanupData.snapshotIntents.length > 0 ||
                          stripeCleanupData.orphanIntents.length > 0 ||
                          stripeCleanupData.paidParticipants.length > 0;
    if (hasStripeWork) {
      try {
        const stripe = await getStripeClient();

        await Promise.all([
          Promise.allSettled(stripeCleanupData.snapshotIntents.map(async (snapshot) => {
            try {
              const pi = await stripe.paymentIntents.retrieve(snapshot.stripePaymentIntentId);

              if (pi.status === 'succeeded') {
                const refund = await stripe.refunds.create({
                  payment_intent: snapshot.stripePaymentIntentId,
                  reason: 'requested_by_customer'
                }, {
                  idempotencyKey: `refund_staff_cancel_snapshot_${bookingId}_${snapshot.stripePaymentIntentId}`
                });
                logger.info('[Staff Cancel] Refunded payment for booking : $, refund', { extra: { snapshotStripe_payment_intent_id: snapshot.stripePaymentIntentId, bookingId, piAmount_100_ToFixed_2: (pi.amount / 100).toFixed(2), refundId: refund.id } });

                await PaymentStatusService.markPaymentRefunded({
                  paymentIntentId: snapshot.stripePaymentIntentId,
                  bookingId,
                  refundId: refund.id,
                  amountCents: pi.amount
                });
              } else if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'processing'].includes(pi.status)) {
                await stripe.paymentIntents.cancel(snapshot.stripePaymentIntentId);
                logger.info('[Staff Cancel] Cancelled payment intent for booking', { extra: { snapshotStripe_payment_intent_id: snapshot.stripePaymentIntentId, bookingId } });

                await PaymentStatusService.markPaymentCancelled({
                  paymentIntentId: snapshot.stripePaymentIntentId
                });
              } else if (pi.status === 'canceled') {
                await PaymentStatusService.markPaymentCancelled({
                  paymentIntentId: snapshot.stripePaymentIntentId
                });
              }
            } catch (piErr: unknown) {
              logger.error('[Staff Cancel] Failed to handle payment', { extra: { stripe_payment_intent_id: snapshot.stripePaymentIntentId, error: getErrorMessage(piErr) } });
            }
          })),
          Promise.allSettled(stripeCleanupData.orphanIntents.map(async (row) => {
            try {
              const pi = await stripe.paymentIntents.retrieve(row.stripePaymentIntentId);
              if (pi.status === 'succeeded' && pi.latest_charge) {
                await stripe.refunds.create({
                  charge: typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge as Stripe.Charge).id,
                  reason: 'requested_by_customer'
                }, {
                  idempotencyKey: `refund_staff_cancel_orphan_${bookingId}_${row.stripePaymentIntentId}`
                });
                logger.info('[Staff Cancel] Refunded succeeded orphan payment intent', {
                  extra: { paymentIntentId: row.stripePaymentIntentId, bookingId, amount: (pi.amount / 100).toFixed(2) }
                });
              } else if (pi.status !== 'canceled') {
                await cancelPaymentIntent(row.stripePaymentIntentId);
                logger.info('[Staff Cancel] Cancelled orphan payment intent', { extra: { paymentIntentId: row.stripePaymentIntentId, bookingId } });
              }
            } catch (cancelErr: unknown) {
              logger.error('[Staff Cancel] Failed to handle orphan payment intent', {
                extra: { paymentIntentId: row.stripePaymentIntentId, error: getErrorMessage(cancelErr) }
              });
            }
          })),
          Promise.allSettled(stripeCleanupData.paidParticipants.map(async (participant) => {
            try {
              const pi = await stripe.paymentIntents.retrieve(participant.stripePaymentIntentId);
              if (pi.status === 'succeeded' && pi.latest_charge) {
                const refund = await stripe.refunds.create({
                  charge: pi.latest_charge as string,
                  reason: 'requested_by_customer',
                  metadata: {
                    type: 'booking_cancelled_by_staff',
                    bookingId: bookingId.toString(),
                    participantId: participant.id.toString()
                  }
                }, {
                  idempotencyKey: `refund_staff_cancel_participant_${bookingId}_${participant.id}_${participant.stripePaymentIntentId}`
                });
                await db.update(bookingParticipants)
                  .set({ paymentStatus: 'refunded', refundedAt: new Date() })
                  .where(eq(bookingParticipants.id, participant.id));
                logger.info('[Staff Cancel] Refunded guest fee for : $, refund', { extra: { participantDisplay_name: participant.displayName, participantCached_fee_cents_100_ToFixed_2: ((participant.cachedFeeCents || 0) / 100).toFixed(2), refundId: refund.id } });
              }
            } catch (refundErr: unknown) {
              logger.error('[Staff Cancel] Failed to refund participant', { extra: { id: participant.id, error: getErrorMessage(refundErr) } });
            }
          })),
        ]);
      } catch (stripeErr: unknown) {
        logger.error('[Staff Cancel] Failed to handle payment intents (non-blocking)', { extra: { cancelIntentsErr: stripeErr } });
      }
    }
  }

  if (!isPendingCancel) {
    voidBookingInvoice(bookingId).catch((err: unknown) => {
      logger.error('[Staff Cancel] Failed to void/refund booking invoice (non-blocking)', {
        extra: { bookingId, error: getErrorMessage(err) }
      });
    });
  }

  return { updated, bookingData, pushInfo, overageRefundResult, isConferenceRoom: isConfRoom, isPendingCancel, alreadyPending };
}

export async function handlePendingCancellation(bookingId: number, bookingData: CancelBookingData, pushInfo: CancelPushInfo) {
  const { memberName, bookingDate, bookingTime, bayName } = pushInfo;

  const staffMessage = `Booking cancellation pending for ${memberName} on ${bookingDate} at ${bookingTime} (${bayName}). Please cancel in Trackman to complete.`;
  notifyAllStaff(
    'Cancel in Trackman Required',
    staffMessage,
    'booking_cancelled',
    {
      relatedId: bookingId,
      relatedType: 'booking_request',
      url: '/admin/bookings'
    }
  ).catch(err => logger.error('Staff cancellation notification failed:', { extra: { err } }));

  await db.insert(notifications).values({
    userEmail: bookingData.userEmail || '',
    title: 'Booking Cancellation in Progress',
    message: `Your booking for ${bookingDate} at ${bookingTime} is being cancelled. You'll be notified once it's fully processed.`,
    type: 'cancellation_pending',
    relatedId: bookingId,
    relatedType: 'booking_request'
  });

  if (bookingData.userEmail) {
    sendPushNotification(bookingData.userEmail, {
      title: 'Booking Cancellation in Progress',
      body: `Your booking for ${bookingDate} at ${bookingTime} is being cancelled. You'll be notified once it's fully processed.`,
      url: '/sims'
    }).catch(err => logger.error('Member push notification failed:', { extra: { err } }));
  }
}

export async function handleCancelPostTransaction(
  bookingId: number,
  bookingData: CancelBookingData,
  pushInfo: CancelPushInfo | null,
  overageRefundResult: OverageRefundResult | null,
  isConfRoom: boolean
) {
  await releaseGuestPassHold(bookingId);

  voidBookingInvoice(bookingId).catch(err => {
    logger.warn('[Cancel] Non-blocking: failed to void draft invoice', { extra: { bookingId, error: getErrorMessage(err) } });
  });

  if (bookingData?.calendarEventId) {
    try {
      const calendarName = await getCalendarNameForBayAsync(bookingData.resourceId);
      if (calendarName) {
        const calendarId = await getCalendarIdByName(calendarName);
        if (calendarId) {
          await deleteCalendarEvent(bookingData.calendarEventId, calendarId);
        }
      }
    } catch (calError: unknown) {
      logger.error('Failed to delete calendar event (non-blocking)', { extra: { calError } });
    }
  }

  if (pushInfo) {
    if (pushInfo.type === 'both') {
      notifyAllStaff(
        'Booking Cancelled by Member',
        pushInfo.staffMessage || pushInfo.message,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/admin/bookings'
        }
      ).catch(err => logger.error('Staff cancellation notification failed:', { extra: { err } }));
      if (pushInfo.email) {
        sendPushNotification(pushInfo.email, {
          title: 'Booking Cancelled',
          body: pushInfo.memberMessage || pushInfo.message,
          url: '/sims'
        }).catch(err => logger.error('Member push notification failed:', { extra: { err } }));
      }
    } else if (pushInfo.type === 'staff') {
      notifyAllStaff(
        'Booking Cancelled by Staff',
        pushInfo.message,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/admin/bookings'
        }
      ).catch(err => logger.error('Staff cancellation notification failed:', { extra: { err } }));
    } else if (pushInfo.email) {
      sendPushNotification(pushInfo.email, {
        title: 'Booking Cancelled',
        body: pushInfo.message,
        url: '/sims'
      }).catch(err => logger.error('Member push notification failed:', { extra: { err } }));
    }
  }

  const cancelledBy = pushInfo?.type === 'both' ? 'member' : 'staff';
  bookingEvents.publish('booking_cancelled', {
    bookingId,
    memberEmail: bookingData.userEmail,
    memberName: bookingData.userName || undefined,
    resourceId: bookingData.resourceId || undefined,
    bookingDate: bookingData.requestDate,
    startTime: bookingData.startTime,
    status: 'cancelled',
    actionBy: cancelledBy
  }, { notifyMember: false, notifyStaff: true, cleanupNotifications: false }).catch(err => logger.error('Booking event publish failed:', { extra: { err } }));

  broadcastAvailabilityUpdate({
    resourceId: bookingData.resourceId || undefined,
    resourceType: isConfRoom ? 'conference_room' : 'simulator',
    date: bookingData.requestDate,
    action: 'cancelled'
  });

  if (pushInfo?.email && (pushInfo.type === 'member' || pushInfo.type === 'both')) {
    sendNotificationToUser(pushInfo.email, {
      type: 'notification',
      title: 'Booking Cancelled',
      message: pushInfo.memberMessage || pushInfo.message,
      data: { bookingId, eventType: 'booking_cancelled' }
    }, { action: 'booking_cancelled', bookingId, triggerSource: 'approval.ts' });
  }
}

export async function updateGenericStatus(bookingId: number, status: string, staff_notes?: string) {
  const result = await db.update(bookingRequests)
    .set({
      status: status,
      staffNotes: staff_notes || undefined,
      updatedAt: new Date()
    })
    .where(eq(bookingRequests.id, bookingId))
    .returning();

  return result;
}

interface CheckinBookingParams {
  bookingId: number;
  targetStatus?: string;
  confirmPayment?: boolean;
  skipPaymentCheck?: boolean;
  skipRosterCheck?: boolean;
  staffEmail: string;
  staffName: string | null;
}

export async function checkinBooking(params: CheckinBookingParams) {
  const { bookingId, targetStatus, confirmPayment, skipPaymentCheck, skipRosterCheck, staffEmail, staffName } = params;

  const validStatuses = ['attended', 'no_show'];
  const newStatus = validStatuses.includes(targetStatus || '') ? targetStatus! : 'attended';

  const existingResult = await db.select({
    status: bookingRequests.status,
    user_email: bookingRequests.userEmail,
    session_id: bookingRequests.sessionId,
    resource_id: bookingRequests.resourceId,
    request_date: bookingRequests.requestDate,
    start_time: bookingRequests.startTime,
    end_time: bookingRequests.endTime,
    declared_player_count: bookingRequests.declaredPlayerCount,
    user_name: bookingRequests.userName
  })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));

  if (existingResult.length === 0) {
    return { error: 'Booking not found', statusCode: 404 };
  }

  const existing: Record<string, any> = existingResult[0];
  const currentStatus = existing.status;

  if (newStatus === 'attended') {
    const ownerStatusResult = await db.execute(sql`
      SELECT membership_status, tier FROM users 
      WHERE LOWER(email) = LOWER(${existing.user_email ?? null})
      LIMIT 1
    `);
    const ownerStatus = (ownerStatusResult.rows[0] as Record<string, any>)?.membership_status;
    const blockedStatuses = ['cancelled', 'suspended', 'terminated', 'inactive'];
    if (ownerStatus && blockedStatuses.includes(ownerStatus) && !skipPaymentCheck) {
      logger.warn('[Checkin] Attempting check-in for member with blocked status', { extra: { bookingId, ownerEmail: existing.user_email, membershipStatus: ownerStatus } });
      return {
        error: `Member status is "${ownerStatus}". Check-in blocked — membership is no longer active.`,
        statusCode: 403,
        membershipBlocked: true,
        membershipStatus: ownerStatus
      };
    }
  }

  if (currentStatus === newStatus) {
    return { success: true, message: `Already marked as ${newStatus}`, alreadyProcessed: true };
  }

  if (newStatus === 'attended' && !existing.session_id && existing.resource_id) {
    try {
      const userResult = await db.select({ id: users.id })
        .from(users)
        .where(eq(sql`LOWER(${users.email})`, existing.user_email?.toLowerCase()))
        .limit(1);
      const userId = userResult[0]?.id || null;

      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: existing.resource_id,
        sessionDate: existing.request_date,
        startTime: existing.start_time,
        endTime: existing.end_time,
        ownerEmail: existing.user_email || existing.owner_email || '',
        ownerName: existing.user_name,
        ownerUserId: userId?.toString() || undefined,
        source: 'staff_manual',
        createdBy: staffEmail
      });
      if (sessionResult.sessionId) {
        existing.session_id = sessionResult.sessionId;
        await recalculateSessionFees(sessionResult.sessionId, 'checkin');
      }
    } catch (err: unknown) {
      logger.error('[Checkin] Failed to auto-create session', { extra: { err } });
    }
  }

  const hasSession = existing.session_id !== null;
  const allowedStatuses = ['approved', 'confirmed', 'attended', 'no_show', 'checked_in'];
  if (hasSession && (currentStatus === 'cancelled' || currentStatus === 'cancellation_pending')) {
    allowedStatuses.push('cancelled', 'cancellation_pending');
  }

  if (!allowedStatuses.includes(currentStatus)) {
    return { error: `Cannot update booking with status: ${currentStatus}`, statusCode: 400 };
  }

  if (newStatus === 'attended' && !skipRosterCheck) {
    const rosterResult = await db.execute(sql`
      SELECT 
        br.trackman_player_count,
        br.declared_player_count,
        br.session_id,
        (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id) as total_slots,
        0 as empty_slots,
        (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id) as participant_count
      FROM booking_requests br
      WHERE br.id = ${bookingId}
    `);

    if (rosterResult.rows.length > 0) {
      const roster = rosterResult.rows[0] as Record<string, any>;
      const declaredCount = roster.declared_player_count || roster.trackman_player_count || 1;
      const participantCount = parseInt(roster.participant_count) || 0;

      if (roster.session_id && participantCount >= declaredCount) {
        // Session exists with enough participants — roster is complete
      } else {
        const emptySlots = parseInt(roster.empty_slots) || 0;
        const totalSlots = parseInt(roster.total_slots) || 0;

        if (emptySlots > 0 && declaredCount > 1) {
          return {
            error: 'Roster incomplete',
            statusCode: 402,
            requiresRoster: true,
            emptySlots,
            totalSlots,
            declaredPlayerCount: declaredCount,
            message: `${emptySlots} player slot${emptySlots > 1 ? 's' : ''} not assigned. Staff must link members or add guests before check-in to ensure proper billing.`
          };
        }
      }
    }
  }

  if (newStatus === 'attended' && !existing.session_id && !skipPaymentCheck) {
    return {
      error: 'Billing session not generated yet',
      statusCode: 400,
      requiresSync: true,
      message: 'Billing session not generated yet - Check Trackman Sync. The session may need to be synced from Trackman before check-in to ensure proper billing.'
    };
  }

  let totalOutstanding = 0;
  let unpaidParticipants: Array<{ id: number; name: string; amount: number }> = [];

  if (newStatus === 'attended' && existing.session_id) {
    const nullFeesCheck = await db.execute(sql`
      SELECT COUNT(*) as null_count
      FROM booking_participants bp
      WHERE bp.session_id = ${existing.session_id} AND bp.payment_status = 'pending' AND (bp.cached_fee_cents IS NULL OR bp.cached_fee_cents = 0)
    `);

    if (parseInt((nullFeesCheck.rows[0] as any)?.null_count) > 0) {
      try {
        await recalculateSessionFees(existing.session_id, 'checkin');
        logger.info('[Check-in Guard] Recalculated fees for session - some participants had NULL or zero cached_fee_cents', { extra: { existingSession_id: existing.session_id } });
      } catch (recalcError: unknown) {
        logger.error('[Check-in Guard] Failed to recalculate fees for session', { extra: { session_id: existing.session_id, recalcError } });
      }
    }

    const balanceResult = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.display_name,
        bp.participant_type,
        bp.payment_status,
        COALESCE(bp.cached_fee_cents, 0)::numeric / 100.0 as fee_amount
      FROM booking_participants bp
      WHERE bp.session_id = ${existing.session_id} AND bp.payment_status = 'pending'
    `);

    for (const p of balanceResult.rows as any[]) {
      const amount = parseFloat(p.fee_amount);
      if (amount > 0) {
        totalOutstanding += amount;
        unpaidParticipants.push({
          id: p.participant_id,
          name: p.display_name,
          amount
        });
      }
    }

    if (totalOutstanding > 0) {
      const prepaidResult = await db.execute(sql`
        SELECT COALESCE(SUM(amount_cents), 0)::numeric / 100.0 as prepaid_total
        FROM conference_prepayments
        WHERE booking_id = ${bookingId} AND status IN ('succeeded', 'completed')
      `);
      const prepaidTotal = parseFloat((prepaidResult.rows[0] as any)?.prepaid_total || '0');
      if (prepaidTotal > 0) {
        totalOutstanding = Math.max(0, totalOutstanding - prepaidTotal);
        logger.info('[Check-in Guard] Deducted conference prepayment from outstanding balance', {
          extra: { bookingId, prepaidTotal, remainingOutstanding: totalOutstanding }
        });
      }
    }

    if (totalOutstanding > 0 && !confirmPayment) {
      if (skipPaymentCheck) {
        await logPaymentAudit({
          bookingId,
          sessionId: existing.session_id,
          action: 'payment_check_bypassed',
          staffEmail,
          staffName,
          amountAffected: totalOutstanding,
          metadata: { unpaidParticipants, bypassed: true, reason: 'skipPaymentCheck flag used' },
        });
        logger.warn('[Check-in Guard] AUDIT: Payment check bypassed by for booking , outstanding: $', { extra: { staffEmail, bookingId, totalOutstandingToFixed_2: totalOutstanding.toFixed(2) } });
      } else {
        await logPaymentAudit({
          bookingId,
          sessionId: existing.session_id,
          action: 'checkin_guard_triggered',
          staffEmail,
          staffName,
          amountAffected: totalOutstanding,
          metadata: { unpaidParticipants },
        });

        return {
          error: 'Cannot complete check-in: All fees must be collected first',
          statusCode: 402,
          code: 'OUTSTANDING_BALANCE',
          requiresPayment: true,
          totalOutstanding,
          unpaidParticipants,
          pendingCount: unpaidParticipants.length,
          message: `Outstanding balance of $${totalOutstanding.toFixed(2)}. Has the member paid?`
        };
      }
    }

  }

  const result = await db.transaction(async (tx) => {
    const updated = await tx.update(bookingRequests)
      .set({
        status: newStatus,
        isUnmatched: false,
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        eq(bookingRequests.status, currentStatus)
      ))
      .returning();

    if (updated.length === 0) {
      return null;
    }

    if (confirmPayment && totalOutstanding > 0) {
      for (const p of unpaidParticipants) {
        await tx.update(bookingParticipants)
          .set({ paymentStatus: 'paid' })
          .where(eq(bookingParticipants.id, p.id));
      }
    }

    return updated;
  });

  if (!result || result.length === 0) {
    logger.warn('[Checkin] Booking status changed during check-in, possible race condition', { extra: { bookingId, expectedStatus: currentStatus, newStatus } });
    return { error: 'Booking status changed during check-in. Please refresh and try again.', statusCode: 409 };
  }

  if (confirmPayment && totalOutstanding > 0) {

    for (const p of unpaidParticipants) {
      await logPaymentAudit({
        bookingId,
        sessionId: existing.session_id,
        participantId: p.id,
        action: 'payment_confirmed',
        staffEmail,
        staffName,
        amountAffected: p.amount,
        previousStatus: 'pending',
        newStatus: 'paid',
      });
    }

    broadcastBillingUpdate({
      action: 'booking_payment_updated',
      bookingId,
      sessionId: existing.session_id,
      memberEmail: existing.user_email,
      amount: totalOutstanding * 100
    });
  }

  const booking = result[0];
  if (newStatus === 'attended' && booking.userEmail) {
    const updateResult = await db.execute(sql`
      UPDATE users 
       SET lifetime_visits = COALESCE(lifetime_visits, 0) + 1 
       WHERE email = ${booking.userEmail}
       RETURNING lifetime_visits, hubspot_id
    `);

    const updatedUser = updateResult.rows[0] as { lifetime_visits: number; hubspot_id: string | null } | undefined;
    if (updatedUser?.hubspot_id && updatedUser.lifetime_visits) {
      updateHubSpotContactVisitCount(updatedUser.hubspot_id, updatedUser.lifetime_visits)
        .catch(err => logger.error('[Bays] Failed to sync visit count to HubSpot:', { extra: { err } }));
    }

    if (updatedUser?.lifetime_visits) {
      try { broadcastMemberStatsUpdated(booking.userEmail, { lifetimeVisits: updatedUser.lifetime_visits }); } catch (err: unknown) { logger.error('[Broadcast] Stats update error', { extra: { err } }); }
    }

    const dateStr = (booking.requestDate as any) instanceof Date
      ? booking.requestDate.toISOString().split('T')[0]
      : String(booking.requestDate).split('T')[0];
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const formattedTime = formatTime12Hour(booking.startTime);

    await notifyMember({
      userEmail: booking.userEmail,
      title: 'Checked In',
      message: `Thanks for visiting! Your session on ${formattedDate} at ${formattedTime} has been checked in.`,
      type: 'booking',
      relatedId: bookingId,
      relatedType: 'booking',
      url: '/sims'
    });
  }

  if (newStatus === 'no_show' && booking.userEmail) {
    const noShowDateStr = (booking.requestDate as any) instanceof Date
      ? booking.requestDate.toISOString().split('T')[0]
      : String(booking.requestDate).split('T')[0];
    const formattedDate = formatDateDisplayWithDay(noShowDateStr);
    const formattedTime = formatTime12Hour(booking.startTime);

    await db.insert(notifications).values({
      userEmail: booking.userEmail,
      title: 'Missed Booking',
      message: `You were marked as a no-show for your booking on ${formattedDate} at ${formattedTime}. If this was in error, please contact staff.`,
      type: 'booking',
      relatedType: 'booking'
    });

    sendNotificationToUser(booking.userEmail, {
      type: 'notification',
      title: 'Missed Booking',
      message: `You were marked as a no-show for your booking on ${formattedDate} at ${formattedTime}. If this was in error, please contact staff.`,
      data: { bookingId, eventType: 'booking_no_show' }
    }, { action: 'booking_no_show', bookingId, triggerSource: 'approval.ts' });
  }

  return { success: true, booking: result[0] };
}

interface DevConfirmParams {
  bookingId: number;
  staffEmail: string;
}

export async function devConfirmBooking(params: DevConfirmParams) {
  const { bookingId, staffEmail } = params;

  const bookingResult = await db.execute(sql`
    SELECT br.*, u.id as user_id, u.stripe_customer_id, u.tier
     FROM booking_requests br
     LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
     WHERE br.id = ${bookingId}
  `);

  if (bookingResult.rows.length === 0) {
    return { error: 'Booking not found', statusCode: 404 };
  }

  const booking = bookingResult.rows[0] as Record<string, any>;

  if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
    return { error: `Booking is already ${booking.status}`, statusCode: 400 };
  }

  const { sessionId, totalFeeCents, dateStr, timeStr } = await db.transaction(async (tx) => {
    let sessionId = booking.session_id;
    let totalFeeCents = 0;

    if (!sessionId && booking.resource_id) {
      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id,
        sessionDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: booking.user_email || booking.owner_email || '',
        ownerName: booking.user_name,
        ownerUserId: booking.user_id?.toString() || undefined,
        source: 'staff_manual',
        createdBy: 'dev_confirm'
      });
      sessionId = sessionResult.sessionId || null;

      if (!sessionId) {
        logger.error('[Dev Confirm] Session creation failed — cannot approve without billing session', {
          extra: { bookingId, resourceId: booking.resource_id }
        });
        throw { statusCode: 500, error: 'Failed to create billing session. Cannot approve booking without billing.' };
      }

      if (sessionId) {
        const requestParticipants = booking.request_participants as Array<{
          email?: string;
          type: 'member' | 'guest';
          userId?: string;
          name?: string;
        }> | null;

        let participantsCreated = 0;
        let slotNumber = 2;
        if (requestParticipants && Array.isArray(requestParticipants)) {
          for (const rp of requestParticipants) {
            if (!rp || typeof rp !== 'object') continue;

            let resolvedUserId = rp.userId || null;
            let resolvedName = rp.name || '';
            let participantType = rp.type === 'member' ? 'member' : 'guest';

            if (resolvedUserId && !resolvedName) {
              const userResult = await tx.execute(sql`
                SELECT name, first_name, last_name, email FROM users WHERE id = ${resolvedUserId}
              `);
              if (userResult.rows.length > 0) {
                const u = userResult.rows[0] as Record<string, any>;
                resolvedName = u.name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Member';
              }
            }

            if (!resolvedUserId && rp.email) {
              const userResult = await tx.execute(sql`
                SELECT id, name, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${rp.email})
              `);
              if (userResult.rows.length > 0) {
                resolvedUserId = (userResult.rows[0] as any).id;
                participantType = 'member';
                if (!resolvedName) {
                  const u = userResult.rows[0] as Record<string, any>;
                  resolvedName = u.name || `${u.first_name || ''} ${u.last_name || ''}`.trim();
                }
              }
            }

            if (!resolvedName) {
              resolvedName = rp.name || rp.email || (participantType === 'guest' ? 'Guest' : 'Member');
            }

            try {
              await tx.execute(sql`
                INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, created_at)
                 VALUES (${sessionId}, ${resolvedUserId}, ${participantType}, ${resolvedName}, NOW())
                 ON CONFLICT (session_id, user_id) DO NOTHING
              `);
              participantsCreated++;
            } catch (partErr: unknown) {
              logger.error('[Dev Confirm] Failed to create participant', { extra: { partErr } });
            }

          }
        }

        try {
          const feeResult = await recalculateSessionFees(sessionId, 'approval');
          if (feeResult?.totalSessionFee) {
            totalFeeCents = feeResult.totalSessionFee;
          }
        } catch (feeError: unknown) {
          logger.warn('[Dev Confirm] Failed to calculate fees', { extra: { feeError } });
        }
      }
    }

    const devConfirmResult = await tx.execute(sql`
      UPDATE booking_requests 
       SET status = 'approved', 
           session_id = COALESCE(session_id, ${sessionId}),
           notes = COALESCE(notes, '') || E'\n[Dev confirmed]',
           updated_at = NOW()
       WHERE id = ${bookingId} AND status IN ('pending', 'pending_approval')
    `);

    if (!devConfirmResult.rowCount || devConfirmResult.rowCount === 0) {
      return { success: false, error: 'Booking status changed while processing — please refresh and try again' };
    }

    const dateStr = typeof booking.request_date === 'string'
      ? booking.request_date
      : booking.request_date.toISOString().split('T')[0];
    const timeStr = typeof booking.start_time === 'string'
      ? booking.start_time.substring(0, 5)
      : booking.start_time;

    await tx.insert(notifications).values({
      userEmail: booking.user_email,
      title: 'Booking Confirmed',
      message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
      type: 'booking',
      relatedType: 'booking'
    });

    if (booking.user_email) {
      try {
        const participantsResult = await tx.execute(sql`
          SELECT u.email as user_email, u.first_name, u.last_name 
           FROM booking_participants bp
           JOIN booking_sessions bs ON bp.session_id = bs.id
           JOIN booking_requests br2 ON br2.session_id = bs.id
           LEFT JOIN users u ON bp.user_id = u.id
           WHERE br2.id = ${bookingId} 
             AND bp.participant_type != 'owner'
             AND u.email IS NOT NULL 
             AND u.email != ''
             AND LOWER(u.email) != LOWER(${booking.user_email})
        `);

        const ownerName = booking.user_name || booking.user_email?.split('@')[0] || 'A member';
        const formattedDate = formatDateDisplayWithDay(dateStr);
        const formattedTime = formatTime12Hour(timeStr);

        for (const participant of participantsResult.rows as any[]) {
          const participantEmail = participant.user_email?.toLowerCase();
          if (!participantEmail) continue;

          const notificationMsg = `${ownerName} has added you to their simulator booking on ${formattedDate} at ${formattedTime}.`;

          await tx.insert(notifications).values({
            userEmail: participantEmail,
            title: 'Added to Booking',
            message: notificationMsg,
            type: 'booking',
            relatedType: 'booking',
            relatedId: bookingId
          });

          sendNotificationToUser(participantEmail, {
            type: 'notification',
            title: 'Added to Booking',
            message: notificationMsg,
            data: { bookingId: bookingId.toString(), eventType: 'booking_participant_added' }
          }, { action: 'booking_participant_added', bookingId, triggerSource: 'approval.ts' });

          logger.info('[Dev Confirm] Sent Added to Booking notification', { extra: { participantEmail, bookingId } });
        }
      } catch (notifyErr: unknown) {
        logger.error('[Dev Confirm] Failed to notify participants (non-blocking)', { extra: { notifyErr } });
      }
    }

    return { sessionId, totalFeeCents, dateStr, timeStr };
  });

  sendNotificationToUser(booking.user_email, {
    type: 'notification',
    title: 'Booking Confirmed',
    message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
    data: { bookingId: bookingId.toString(), eventType: 'booking_confirmed' }
  }, { action: 'booking_confirmed', bookingId, triggerSource: 'approval.ts' });

  return { success: true, bookingId, sessionId, totalFeeCents, booking, dateStr, timeStr };
}

interface CompleteCancellationParams {
  bookingId: number;
  staffEmail: string;
}

export async function completeCancellation(params: CompleteCancellationParams) {
  const { bookingId, staffEmail } = params;

  const [existing] = await db.select({
    id: bookingRequests.id,
    userEmail: bookingRequests.userEmail,
    userName: bookingRequests.userName,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    endTime: bookingRequests.endTime,
    status: bookingRequests.status,
    resourceId: bookingRequests.resourceId,
    trackmanBookingId: bookingRequests.trackmanBookingId,
    sessionId: bookingRequests.sessionId,
  })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));

  if (!existing) {
    return { error: 'Booking not found', statusCode: 404 };
  }

  if (existing.status !== 'cancellation_pending') {
    return { error: `Cannot complete cancellation — booking status is '${existing.status}', expected 'cancellation_pending'`, statusCode: 400 };
  }

  const errors: string[] = [];

  const bookingDate = existing.requestDate;
  const bookingTime = existing.startTime?.substring(0, 5) || '';

  await db.transaction(async (tx) => {
    await tx.update(bookingRequests)
      .set({
        status: 'cancelled',
        staffNotes: sql`COALESCE(staff_notes, '') || ${'\n[Cancellation completed manually by ' + staffEmail + ']'}`,
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        eq(bookingRequests.status, 'cancellation_pending')
      ));

    await tx.insert(notifications).values({
      userEmail: existing.userEmail || '',
      title: 'Booking Cancelled',
      message: `Your booking on ${bookingDate} at ${bookingTime} has been cancelled and charges have been refunded.`,
      type: 'booking_cancelled',
      relatedId: bookingId,
      relatedType: 'booking_request'
    });
  });

  try {
    const pendingIntents = await db.select({ stripePaymentIntentId: stripePaymentIntents.stripePaymentIntentId })
      .from(stripePaymentIntents)
      .where(and(
        eq(stripePaymentIntents.bookingId, bookingId),
        sql`${stripePaymentIntents.status} IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')`
      ));
    for (const row of pendingIntents) {
      try {
        await cancelPaymentIntent(row.stripePaymentIntentId);
      } catch (cancelErr: unknown) {
        errors.push(`Failed to cancel payment intent ${row.stripePaymentIntentId.substring(0, 8)}: ${getErrorMessage(cancelErr)}`);
        logger.error('[Complete Cancellation] Failed to cancel payment intent:', { extra: { error: getErrorMessage(cancelErr) } });
      }
    }
  } catch (err: unknown) {
    errors.push(`Failed to query pending intents: ${getErrorMessage(err)}`);
    logger.error('[Complete Cancellation] Failed to query pending intents', { extra: { err } });
  }

  // Refund fee snapshot payments (check-in register payments)
  try {
    const stripe = await getStripeClient();
    const allSnapshots = await db.execute(sql`
      SELECT id, stripe_payment_intent_id, status as snapshot_status, total_cents
       FROM booking_fee_snapshots 
       WHERE booking_id = ${bookingId} AND stripe_payment_intent_id IS NOT NULL
    `);

    await Promise.allSettled((allSnapshots.rows as any[]).map(async (snapshot) => {
      try {
        const pi = await stripe.paymentIntents.retrieve(snapshot.stripe_payment_intent_id);

        if (pi.status === 'succeeded') {
          const refund = await stripe.refunds.create({
            payment_intent: snapshot.stripe_payment_intent_id,
            reason: 'requested_by_customer'
          }, {
            idempotencyKey: `refund_complete_cancel_snapshot_${bookingId}_${snapshot.stripe_payment_intent_id}`
          });
          await PaymentStatusService.markPaymentRefunded({
            paymentIntentId: snapshot.stripe_payment_intent_id,
            bookingId,
            refundId: refund.id,
            amountCents: pi.amount
          });
          logger.info('[Complete Cancellation] Refunded fee snapshot payment', { 
            extra: { 
              paymentIntentId: snapshot.stripe_payment_intent_id, 
              bookingId, 
              amount: (pi.amount / 100).toFixed(2),
              refundId: refund.id 
            } 
          });
        } else if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'processing'].includes(pi.status)) {
          await stripe.paymentIntents.cancel(snapshot.stripe_payment_intent_id);
          logger.info('[Complete Cancellation] Cancelled pending fee snapshot payment', {
            extra: { paymentIntentId: snapshot.stripe_payment_intent_id, bookingId }
          });
        }
      } catch (snapErr: unknown) {
        errors.push(`Failed to handle fee snapshot ${snapshot.stripe_payment_intent_id?.substring(0, 8)}: ${getErrorMessage(snapErr)}`);
        logger.error('[Complete Cancellation] Failed to handle fee snapshot', { 
          extra: { stripe_payment_intent_id: snapshot.stripe_payment_intent_id, error: getErrorMessage(snapErr) } 
        });
      }
    }));
  } catch (snapshotErr: unknown) {
    errors.push(`Failed to query fee snapshots: ${getErrorMessage(snapshotErr)}`);
    logger.error('[Complete Cancellation] Failed to query fee snapshots', { extra: { snapshotErr } });
  }

  if (existing.sessionId) {
    try {
      await db.update(bookingParticipants)
        .set({ cachedFeeCents: 0, paymentStatus: 'waived' })
        .where(and(
          eq(bookingParticipants.sessionId, existing.sessionId),
          eq(bookingParticipants.paymentStatus, 'pending')
        ));
    } catch (clearErr: unknown) {
      errors.push(`Failed to clear pending fees: ${getErrorMessage(clearErr)}`);
      logger.error('[Complete Cancellation] Failed to clear pending fees', { extra: { clearErr } });
    }

    try {
      const paidParticipants = await db.select({
        id: bookingParticipants.id,
        stripePaymentIntentId: bookingParticipants.stripePaymentIntentId,
        cachedFeeCents: bookingParticipants.cachedFeeCents,
        displayName: bookingParticipants.displayName
      })
        .from(bookingParticipants)
        .where(and(
          eq(bookingParticipants.sessionId, existing.sessionId),
          eq(bookingParticipants.paymentStatus, 'paid'),
          isNotNull(bookingParticipants.stripePaymentIntentId),
          ne(bookingParticipants.stripePaymentIntentId, ''),
          sql`${bookingParticipants.stripePaymentIntentId} NOT LIKE 'balance-%'`,
          isNull(bookingParticipants.refundedAt)
        ));

      if (paidParticipants.length > 0) {
        const stripe = await getStripeClient();
        await Promise.allSettled(paidParticipants.map(async (participant) => {
          try {
            const pi = await stripe.paymentIntents.retrieve(participant.stripePaymentIntentId!);
            if (pi.status === 'succeeded' && pi.latest_charge) {
              const refund = await stripe.refunds.create({
                charge: typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge as Stripe.Charge).id,
                reason: 'requested_by_customer',
                metadata: {
                  type: 'cancellation_completed_by_staff',
                  bookingId: bookingId.toString(),
                  participantId: participant.id.toString()
                }
              }, {
                idempotencyKey: `refund_deny_participant_${bookingId}_${participant.stripePaymentIntentId}`
              });
              await db.update(bookingParticipants)
                .set({ refundedAt: new Date(), paymentStatus: 'waived' })
                .where(eq(bookingParticipants.id, participant.id));
              logger.info('[Complete Cancellation] Refunded : $', { extra: { participantDisplay_name: participant.displayName, participantCached_fee_cents_100_ToFixed_2: ((participant.cachedFeeCents || 0) / 100).toFixed(2) } });
            }
          } catch (refundErr: unknown) {
            errors.push(`Failed to refund ${participant.displayName}: ${getErrorMessage(refundErr)}`);
            logger.error('[Complete Cancellation] Failed to refund participant', { extra: { id: participant.id, error: getErrorMessage(refundErr) } });
          }
        }));
      }
    } catch (feeErr: unknown) {
      errors.push(`Failed to handle participant refunds: ${getErrorMessage(feeErr)}`);
      logger.error('[Complete Cancellation] Failed to handle fees', { extra: { feeErr } });
    }

    try {
      const guestParticipants = await db.select({
        id: bookingParticipants.id,
        displayName: bookingParticipants.displayName,
        usedGuestPass: bookingParticipants.usedGuestPass
      })
        .from(bookingParticipants)
        .where(and(
          eq(bookingParticipants.sessionId, existing.sessionId),
          eq(bookingParticipants.participantType, 'guest')
        ));
      for (const guest of guestParticipants) {
        if (!guest.usedGuestPass) continue;
        try {
          await refundGuestPass(existing.userEmail || '', guest.displayName || undefined, false);
        } catch (guestErr: unknown) {
          errors.push(`Failed to refund guest pass for ${guest.displayName}: ${getErrorMessage(guestErr)}`);
          logger.error('[Complete Cancellation] Failed to refund guest pass', { extra: { guestErr } });
        }
      }
    } catch (err: unknown) {
      errors.push(`Failed to query guest participants: ${getErrorMessage(err)}`);
      logger.error('[Complete Cancellation] Failed to query guest participants', { extra: { err } });
    }
  }

  try {
    await releaseGuestPassHold(bookingId);
  } catch (err: unknown) {
    errors.push(`Failed to release guest pass holds: ${getErrorMessage(err)}`);
    logger.error('[Complete Cancellation] Failed to release guest pass holds', { extra: { err } });
  }

  try {
    await voidBookingInvoice(bookingId);
  } catch (err: unknown) {
    errors.push(`Failed to void/refund booking invoice: ${getErrorMessage(err)}`);
    logger.error('[Complete Cancellation] Failed to void/refund booking invoice', { extra: { bookingId, error: getErrorMessage(err) } });
  }

  if (errors.length > 0) {
    const errorNote = `\n[Cancellation completed with ${errors.length} error(s): ${errors.join('; ')}]`;
    await db.update(bookingRequests)
      .set({
        staffNotes: sql`COALESCE(staff_notes, '') || ${errorNote}`,
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId));
  }

  broadcastAvailabilityUpdate({
    resourceId: existing.resourceId || undefined,
    resourceType: 'simulator',
    date: existing.requestDate,
    action: 'cancelled'
  });

  bookingEvents.publish('booking_cancelled', {
    bookingId,
    memberEmail: existing.userEmail || '',
    resourceId: existing.resourceId || undefined,
    bookingDate: String(bookingDate),
    startTime: existing.startTime || '',
    status: 'cancelled',
    actionBy: 'staff'
  });

  logger.info('[Complete Cancellation] Staff manually completed cancellation of booking', { extra: { staffEmail, bookingId, errorCount: errors.length } });

  return {
    success: true,
    status: 'cancelled',
    message: 'Cancellation completed successfully. Member has been notified.',
    cleanup_errors: errors.length > 0 ? errors : undefined,
    existing
  };
}
