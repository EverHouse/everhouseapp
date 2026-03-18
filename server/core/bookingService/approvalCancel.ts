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
import { BookingUpdateResult, CancelBookingData, CancelPushInfo, OverageRefundResult } from './approvalTypes';

interface CancelBookingParams {
  bookingId: number;
  staff_notes?: string;
  cancelled_by?: string;
}

export async function cancelBooking(params: CancelBookingParams) {
  const { bookingId, staff_notes, cancelled_by } = params;

  const { updated, bookingData, pushInfo, overageRefundResult, isConferenceRoom: isConfRoom, isPendingCancel, alreadyPending, stripeCleanupData, guestPassRefundData } = await db.transaction(async (tx) => {
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
      throw new AppError(404, 'Booking request not found');
    }

    if (existing.status === 'cancellation_pending') {
      voidBookingPass(bookingId).catch(err =>
        logger.warn('[ApprovalCancel] Self-heal void pass failed for already-pending booking (non-fatal)', { extra: { bookingId, error: getErrorMessage(err) } })
      );
      return {
        updated: existing,
        bookingData: existing,
        pushInfo: null as unknown as CancelPushInfo | null,
        overageRefundResult: {},
        isConferenceRoom: false,
        isPendingCancel: true,
        alreadyPending: true,
        stripeCleanupData: { snapshotIntents: [] as Array<{ stripePaymentIntentId: string }>, orphanIntents: [] as Array<{ stripePaymentIntentId: string }>, paidParticipants: [] as Array<{ id: number; stripePaymentIntentId: string; cachedFeeCents: number; displayName: string }>, sessionId: null as number | null }
      };
    }

    const isTrackmanLinked = !!existing.trackmanBookingId && /^\d+$/.test(existing.trackmanBookingId);
    const wasApproved = ['approved', 'confirmed'].includes(existing.status || '');
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

      voidBookingPass(bookingId).catch(err =>
        logger.error('[Cancel] Wallet pass void failed for cancellation_pending', { extra: { bookingId, error: getErrorMessage(err) } })
      );

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
        snapshotIntents.push({ stripePaymentIntentId: String(snapshot.stripe_payment_intent_id) });
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
        orphanIntents.push({ stripePaymentIntentId: String(row.stripe_payment_intent_id) });
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
      throw new AppError(409, 'Booking was modified by another staff member. Please refresh.');
    }

    const sessionResult = await tx.select({ sessionId: bookingRequests.sessionId })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));

    const guestPassRefundData: Array<{ displayName: string | null; ownerEmail: string }> = [];

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

    // eslint-disable-next-line no-useless-assignment
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

      pushInfo = { type: 'both', email: memberEmail, staffMessage, memberMessage, message: staffMessage };
    } else {
      const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled by staff.`;

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
        const refundResult = await refundGuestPass(refund.ownerEmail, refund.displayName || undefined, false);
        if (!refundResult.success) {
          logger.error('[Staff Cancel] Guest pass refund failed', { extra: { ownerEmail: refund.ownerEmail, displayName: refund.displayName, error: refundResult.error } });
        }
      } catch (refundErr: unknown) {
        logger.error('[Staff Cancel] Guest pass refund threw (non-blocking)', { extra: { ownerEmail: refund.ownerEmail, displayName: refund.displayName, error: getErrorMessage(refundErr) } });
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
                logger.info(`[Staff Cancel] Refunded payment for booking ${bookingId}: $${(pi.amount / 100).toFixed(2)}, refund ${refund.id}`, { extra: { paymentIntentId: snapshot.stripePaymentIntentId, bookingId } });

                await PaymentStatusService.markPaymentRefunded({
                  paymentIntentId: snapshot.stripePaymentIntentId,
                  bookingId,
                  refundId: refund.id,
                  amountCents: pi.amount
                });
              } else if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'processing'].includes(pi.status)) {
                await cancelPaymentIntent(snapshot.stripePaymentIntentId);
                logger.info('[Staff Cancel] Cancelled payment intent for booking', { extra: { paymentIntentId: snapshot.stripePaymentIntentId, bookingId } });

                await PaymentStatusService.markPaymentCancelled({
                  paymentIntentId: snapshot.stripePaymentIntentId
                });
              } else if (pi.status === 'canceled') {
                await PaymentStatusService.markPaymentCancelled({
                  paymentIntentId: snapshot.stripePaymentIntentId
                });
              }
              await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND stripe_payment_intent_id = ${snapshot.stripePaymentIntentId} AND status IN ('pending', 'requires_action')`);
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
                logger.info(`[Staff Cancel] Refunded guest fee for ${participant.displayName}: $${((participant.cachedFeeCents || 0) / 100).toFixed(2)}, refund ${refund.id}`);
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
    await voidBookingInvoice(bookingId).catch((err: unknown) => {
      logger.error('[Staff Cancel] Failed to void/refund booking invoice (non-blocking)', {
        extra: { bookingId, error: getErrorMessage(err) }
      });
    });

    await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_action')`).catch((err: unknown) => {
      logger.warn('[Staff Cancel] Failed to mark remaining fee snapshots as cancelled', { extra: { bookingId, error: getErrorMessage(err) } });
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

  if (bookingData.userEmail && !isSyntheticEmail(bookingData.userEmail)) {
    await notifyMember({
      userEmail: bookingData.userEmail,
      title: 'Booking Cancellation in Progress',
      message: `Your booking for ${bookingDate} at ${bookingTime} is being cancelled. You'll be notified once it's fully processed.`,
      type: 'cancellation_pending',
      relatedId: bookingId,
      relatedType: 'booking_request',
      url: '/sims'
    }, { sendPush: true }).catch(err => logger.error('Member cancellation notification failed:', { extra: { err } }));
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

  await voidBookingInvoice(bookingId).catch(err => {
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
      if (pushInfo.email && !isSyntheticEmail(pushInfo.email)) {
        notifyMember({
          userEmail: pushInfo.email,
          title: 'Booking Cancelled',
          message: pushInfo.memberMessage || pushInfo.message,
          type: 'booking_cancelled',
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/sims'
        }, { sendPush: true }).catch(err => logger.error('Member cancellation notification failed:', { extra: { err } }));
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
    } else if (pushInfo.email && !isSyntheticEmail(pushInfo.email)) {
      notifyMember({
        userEmail: pushInfo.email,
        title: 'Booking Cancelled',
        message: pushInfo.message,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request',
        url: '/sims'
      }, { sendPush: true }).catch(err => logger.error('Member cancellation notification failed:', { extra: { err } }));
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

  voidBookingPass(bookingId).catch(err => logger.error('[cancelBooking] Failed to void booking wallet pass:', { extra: { err } }));

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
