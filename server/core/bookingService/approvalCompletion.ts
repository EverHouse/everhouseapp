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
import type { DevConfirmBookingRow } from './approvalCheckin';
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
import { voidBookingPass, refreshBookingPass } from '../../walletPass/bookingPassService';
import { BookingUpdateResult, CancelBookingData, CancelPushInfo } from './approvalTypes';

interface DevConfirmParams {
  bookingId: number;
  staffEmail: string;
}

export async function devConfirmBooking(params: DevConfirmParams) {
  const { bookingId, staffEmail: _staffEmail } = params;

  const bookingResult = await db.execute(sql`
    SELECT br.*, u.id as user_id, u.stripe_customer_id, u.tier
     FROM booking_requests br
     LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
     WHERE br.id = ${bookingId}
  `);

  if (bookingResult.rows.length === 0) {
    return { error: 'Booking not found', statusCode: 404 };
  }

  const booking = bookingResult.rows[0] as unknown as DevConfirmBookingRow;

  if (booking.status !== 'pending' && booking.status !== 'pending_approval') {
    return { error: `Booking is already ${booking.status}`, statusCode: 400 };
  }

  // eslint-disable-next-line no-useless-assignment
  let resolvedTotalFeeCents = 0;
  const { sessionId, totalFeeCents, dateStr, timeStr, participantEmails } = await db.transaction(async (tx) => {
    let sessionId = booking.session_id;
    const totalFeeCents = 0;

    if (!sessionId && booking.resource_id) {
      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id as number,
        sessionDate: booking.request_date as string,
        startTime: booking.start_time as string,
        endTime: booking.end_time as string,
        ownerEmail: (booking.user_email || booking.owner_email || '') as string,
        ownerName: (booking.user_name || undefined) as string | undefined,
        ownerUserId: booking.user_id?.toString() || undefined,
        source: 'staff_manual',
        createdBy: 'dev_confirm'
      });
      sessionId = sessionResult.sessionId || null;

      if (!sessionId) {
        logger.error('[Dev Confirm] Session creation failed — cannot approve without billing session', {
          extra: { bookingId, resourceId: booking.resource_id }
        });
        throw new AppError(500, 'Failed to create billing session. Cannot approve booking without billing.');
      }
    }

    if (sessionId) {
      const requestParticipants = booking.request_participants as Array<{
        email?: string;
        type: 'member' | 'guest';
        userId?: string;
        name?: string;
      }> | null;

      const existingParticipants = await tx.execute(sql`
        SELECT user_id, display_name, participant_type FROM booking_participants
         WHERE session_id = ${sessionId} AND participant_type != 'owner'
      `);
      const typedParticipantRows = existingParticipants.rows as unknown as Array<{ user_id: string | null; display_name: string | null; participant_type: string }>;
      const existingUserIds = new Set(
        typedParticipantRows
          .filter(p => p.user_id)
          .map(p => String(p.user_id))
      );
      const existingGuestNames = new Set(
        typedParticipantRows
          .filter(p => !p.user_id && p.participant_type === 'guest')
          .map(p => (p.display_name || '').toLowerCase())
      );

      let participantsCreated = 0;
      if (requestParticipants && Array.isArray(requestParticipants)) {
        for (const rp of requestParticipants) {
          if (!rp || typeof rp !== 'object') continue;

          let resolvedUserId = rp.userId || null;
          let resolvedName = rp.name || '';
          let participantType = rp.type === 'member' ? 'member' : 'guest';

          if (resolvedUserId && !resolvedName) {
            const userResult = await tx.execute(sql`
              SELECT first_name, last_name, email FROM users WHERE id = ${resolvedUserId}
            `);
            if (userResult.rows.length > 0) {
              interface UserNameRow { first_name: string | null; last_name: string | null; email: string }
              const u = userResult.rows[0] as unknown as UserNameRow;
              resolvedName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Member';
            }
          }

          if (!resolvedUserId && rp.email) {
            const userResult = await tx.execute(sql`
              SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${rp.email})
            `);
            if (userResult.rows.length > 0) {
              interface UserNameLookupRow { id: string; first_name: string | null; last_name: string | null }
              resolvedUserId = (userResult.rows[0] as unknown as UserNameLookupRow).id;
              participantType = 'member';
              if (!resolvedName) {
                const u = userResult.rows[0] as unknown as UserNameLookupRow;
                resolvedName = `${u.first_name || ''} ${u.last_name || ''}`.trim();
              }
            }
          }

          let resolvedGuestId: number | null = null;
          if (participantType === 'guest' && rp.email) {
            try {
              resolvedGuestId = await createOrFindGuest(
                rp.name || resolvedName || 'Guest',
                rp.email,
                undefined,
                (booking.user_email || '') as string
              );
            } catch (guestErr) {
              logger.error('[Dev Confirm] Non-blocking guest record creation failed', {
                extra: { email: rp.email, error: getErrorMessage(guestErr) }
              });
            }
          }

          if (!resolvedName) {
            resolvedName = rp.name || rp.email || (participantType === 'guest' ? 'Guest' : 'Member');
          }

          if (resolvedUserId && existingUserIds.has(String(resolvedUserId))) {
            continue;
          }
          if (!resolvedUserId && participantType === 'guest' && existingGuestNames.has(resolvedName.toLowerCase())) {
            continue;
          }

          try {
            const insertUserId = participantType === 'guest' ? null : resolvedUserId;
            await tx.execute(sql`
              INSERT INTO booking_participants (session_id, user_id, guest_id, participant_type, display_name, created_at)
               VALUES (${sessionId}, ${insertUserId}, ${resolvedGuestId}, ${participantType}, ${resolvedName}, NOW())
            `);
            participantsCreated++;
            if (resolvedUserId) existingUserIds.add(String(resolvedUserId));
            if (!resolvedUserId && participantType === 'guest') existingGuestNames.add(resolvedName.toLowerCase());
          } catch (partErr: unknown) {
            logger.error('[Dev Confirm] Failed to create participant', { extra: { partErr } });
          }

        }
      }

      logger.info('[Dev Confirm] Participants transferred from request', {
        extra: { bookingId, sessionId, participantsCreated, totalRequested: requestParticipants?.length || 0 }
      });
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
      : (booking.request_date as Date).toISOString().split('T')[0];
    const timeStr = typeof booking.start_time === 'string'
      ? booking.start_time.substring(0, 5)
      : String(booking.start_time);

    let participantEmails: string[] = [];
    if (booking.user_email) {
      try {
        const participantsResult = await tx.execute(sql`
          SELECT u.email as user_email
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
        participantEmails = (participantsResult.rows as unknown as Array<{ user_email: string }>)
          .map(p => p.user_email?.toLowerCase())
          .filter(Boolean);
      } catch (notifyErr: unknown) {
        logger.error('[Dev Confirm] Failed to query participants (non-blocking)', { extra: { notifyErr } });
      }
    }

    return { sessionId, totalFeeCents, dateStr, timeStr, participantEmails };
  });

  resolvedTotalFeeCents = totalFeeCents ?? 0;
  if (sessionId) {
    try {
      const feeResult = await recalculateSessionFees(sessionId as number, 'approval');
      if (feeResult?.totals?.totalCents != null) {
        resolvedTotalFeeCents = feeResult.totals.totalCents;
      }
    } catch (feeError: unknown) {
      logger.warn('[Dev Confirm] Failed to calculate fees', { extra: { feeError } });
    }
  }

  if (booking.user_email && !isSyntheticEmail(booking.user_email as string)) {
    notifyMember({
      userEmail: booking.user_email as string,
      title: 'Booking Confirmed',
      message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
      type: 'booking_confirmed',
      relatedType: 'booking',
      url: '/sims'
    }, { sendPush: true }).catch(err => logger.error('[Dev Confirm] Owner notification failed', { extra: { error: getErrorMessage(err) } }));
  }

  sendNotificationToUser(booking.user_email as string, {
    type: 'notification',
    title: 'Booking Confirmed',
    message: `Your simulator booking for ${dateStr} at ${timeStr} has been confirmed.`,
    data: { bookingId: bookingId.toString(), eventType: 'booking_confirmed' }
  }, { action: 'booking_confirmed', bookingId, triggerSource: 'approval.ts' });

  if (participantEmails && participantEmails.length > 0) {
    const ownerName = booking.user_name || (booking.user_email as string)?.split('@')[0] || 'A member';
    const formattedDate = formatDateDisplayWithDay(dateStr);
    const formattedTime = formatTime12Hour(timeStr as string);
    for (const participantEmail of participantEmails) {
      if (isSyntheticEmail(participantEmail)) continue;
      const notificationMsg = `${ownerName} has added you to their simulator booking on ${formattedDate} at ${formattedTime}.`;
      notifyMember({
        userEmail: participantEmail,
        title: 'Added to Booking',
        message: notificationMsg,
        type: 'booking',
        relatedType: 'booking',
        relatedId: bookingId,
        url: '/sims'
      }, { sendPush: true }).catch(err => logger.error('[Dev Confirm] Participant notification failed', { extra: { error: getErrorMessage(err) } }));

      sendNotificationToUser(participantEmail, {
        type: 'notification',
        title: 'Added to Booking',
        message: notificationMsg,
        data: { bookingId: bookingId.toString(), eventType: 'booking_participant_added' }
      }, { action: 'booking_participant_added', bookingId, triggerSource: 'approval.ts' });

      logger.info('[Dev Confirm] Sent Added to Booking notification', { extra: { participantEmail, bookingId } });
    }
  }

  const devConfirmRequestParticipants = booking.request_participants as Array<{
    email?: string; type: 'member' | 'guest'; name?: string;
  }> | null;
  if (devConfirmRequestParticipants && Array.isArray(devConfirmRequestParticipants)) {
    for (const rp of devConfirmRequestParticipants) {
      if (rp?.type === 'guest' && rp.email) {
        const nameParts = (rp.name || '').trim().split(/\s+/);
        const firstName = nameParts[0] || undefined;
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
        upsertVisitor({ email: rp.email.toLowerCase().trim(), firstName, lastName }, false)
          .then(v => logger.info('[Dev Confirm] Visitor record ensured for guest', { extra: { email: rp.email, visitorUserId: v.id, bookingId } }))
          .catch(err => logger.error('[Dev Confirm] Non-blocking visitor upsert failed', { extra: { email: rp.email, error: getErrorMessage(err) } }));
      }
    }
  }

  refreshBookingPass(bookingId).catch(err =>
    logger.error('[Dev Confirm] Wallet pass refresh failed after confirm', { extra: { bookingId, error: getErrorMessage(err) } })
  );

  return { success: true, bookingId, sessionId, totalFeeCents: resolvedTotalFeeCents, booking, dateStr, timeStr };
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

  const cancelResult = await db.transaction(async (tx) => {
    const [updatedRow] = await tx.update(bookingRequests)
      .set({
        status: 'cancelled',
        staffNotes: sql`COALESCE(staff_notes, '') || ${'\n[Cancellation completed manually by ' + staffEmail + ']'}`,
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        eq(bookingRequests.status, 'cancellation_pending')
      ))
      .returning({ id: bookingRequests.id });
    return updatedRow;
  });

  if (!cancelResult) {
    logger.warn('[CompleteCancellation] Booking status changed before cancellation could complete', { extra: { bookingId } });
    return { success: false, error: 'Booking status has changed. Please refresh and try again.', errors: ['Status conflict'] };
  }

  if (existing.userEmail && !isSyntheticEmail(existing.userEmail)) {
    notifyMember({
      userEmail: existing.userEmail,
      title: 'Booking Cancelled',
      message: `Your booking on ${bookingDate} at ${bookingTime} has been cancelled and charges have been refunded.`,
      type: 'booking_cancelled',
      relatedId: bookingId,
      relatedType: 'booking_request',
      url: '/sims'
    }, { sendPush: true }).catch(err => logger.error('[CompleteCancellation] Notification failed', { extra: { error: getErrorMessage(err) } }));
  }

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

    await Promise.allSettled((allSnapshots.rows as unknown as Array<{ id: number; stripe_payment_intent_id: string; snapshot_status: string; total_cents: number }>).map(async (snapshot) => {
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
          const snapCancelResult = await cancelPaymentIntent(snapshot.stripe_payment_intent_id);
          if (snapCancelResult.success) {
            logger.info('[Complete Cancellation] Cancelled pending fee snapshot payment', {
              extra: { paymentIntentId: snapshot.stripe_payment_intent_id, bookingId }
            });
          } else {
            logger.warn('[Complete Cancellation] Could not cancel fee snapshot payment (non-blocking)', {
              extra: { paymentIntentId: snapshot.stripe_payment_intent_id, bookingId, error: snapCancelResult.error }
            });
          }
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
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
              logger.info(`[Complete Cancellation] Refunded ${participant.displayName}: $${((participant.cachedFeeCents || 0) / 100).toFixed(2)}`);
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
          const refundResult = await refundGuestPass(existing.userEmail || '', guest.displayName || undefined, false);
          if (!refundResult.success) {
            errors.push(`Guest pass refund failed for ${guest.displayName}: ${refundResult.error}`);
            logger.error('[Complete Cancellation] Guest pass refund failed', { extra: { guestName: guest.displayName, error: refundResult.error } });
          }
        } catch (guestErr: unknown) {
          errors.push(`Guest pass refund threw for ${guest.displayName}: ${getErrorMessage(guestErr)}`);
          logger.error('[Complete Cancellation] Guest pass refund threw', { extra: { guestName: guest.displayName, error: getErrorMessage(guestErr) } });
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
  }).catch(err => logger.error('[CompleteCancellation] Booking event publish failed:', { extra: { err: getErrorMessage(err) } }));

  logger.info('[Complete Cancellation] Staff manually completed cancellation of booking', { extra: { staffEmail, bookingId, errorCount: errors.length } });

  return {
    success: true,
    status: 'cancelled',
    message: 'Cancellation completed successfully. Member has been notified.',
    cleanup_errors: errors.length > 0 ? errors : undefined,
    existing
  };
}

