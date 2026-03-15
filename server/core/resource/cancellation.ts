import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { resources, notifications, bookingRequests } from '../../../shared/schema';
import { logger } from '../logger';
import { createPacificDate, formatDateDisplayWithDay, formatTime12Hour } from '../../utils/dateUtils';
import { notifyMember, notifyAllStaff, isSyntheticEmail } from '../notificationService';
import { refundGuestPass } from '../../routes/guestPasses';
import { broadcastAvailabilityUpdate } from '../websocket';
import { getCalendarIdByName, deleteCalendarEvent, CALENDAR_CONFIG } from '../calendar/index';
import { toTextArrayLiteral } from '../../utils/sqlArrayLiteral';
import { getErrorMessage } from '../../utils/errorUtils';
import { bookingEvents } from '../bookingEvents';
import { logMemberAction } from '../auditLog';
import { releaseGuestPassHold } from '../billing/guestPassHoldService';
import { getStripeClient } from '../stripe/client';
import { cancelPaymentIntent } from '../stripe/payments';
import { markPaymentRefunded } from '../billing/PaymentStatusService';
import { AppError } from '../errors';
import { voidBookingPass } from '../../walletPass/bookingPassService';

interface BookingParticipantRow {
  id: number;
  user_id: string | null;
  guest_id: number | null;
  participant_type: string;
  display_name: string | null;
  used_guest_pass: boolean | null;
}

interface _UserEmailRow {
  email: string;
}

interface PaymentIntentIdRow {
  stripe_payment_intent_id: string;
  amount_cents?: number;
  stripe_customer_id?: string;
  user_id?: string;
}

export interface CancellationCascadeResult {
  participantsNotified: number;
  guestPassesRefunded: number;
  bookingParticipantsRemoved: number;
  prepaymentRefunds: number;
  errors: string[];
}

export async function handleCancellationCascade(
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
    bookingParticipantsRemoved: 0,
    prepaymentRefunds: 0,
    errors: []
  };

  const bookingStartTime = createPacificDate(requestDate, startTime);
  const now = new Date();
  const hoursUntilStart = (bookingStartTime.getTime() - now.getTime()) / (1000 * 60 * 60);
  const shouldRefundGuestPasses = hoursUntilStart >= 1;

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

  const txResult = await db.transaction(async (tx) => {
    if (sessionId) {
      const participantsResult = await tx.execute(sql`SELECT id, user_id, guest_id, participant_type, display_name, used_guest_pass 
         FROM booking_participants WHERE session_id = ${sessionId}`);
      const participants = participantsResult.rows as unknown as BookingParticipantRow[];

      const memberUserIds = participants
        .filter(p => p.participant_type === 'member' && p.user_id)
        .map(p => p.user_id as string);

      const userEmailMap = new Map<string, string>();
      if (memberUserIds.length > 0) {
        const emailsResult = await tx.execute(sql`SELECT id::text, email FROM users WHERE id::text = ANY(${toTextArrayLiteral(memberUserIds)}::text[]) OR LOWER(email) = ANY(SELECT LOWER(unnest(${toTextArrayLiteral(memberUserIds)}::text[])))`);
        for (const row of emailsResult.rows as unknown as { id: string; email: string }[]) {
          userEmailMap.set(row.id, row.email);
          userEmailMap.set(row.email.toLowerCase(), row.email);
        }
      }

      for (const participant of participants) {
        if (participant.participant_type === 'member' && participant.user_id) {
          const email = userEmailMap.get(participant.user_id) || userEmailMap.get(participant.user_id.toLowerCase());
          if (email) {
            membersToNotify.push({
              email,
              participantId: participant.id
            });
          }
        }

        if (participant.participant_type === 'guest' && shouldRefundGuestPasses && participant.used_guest_pass) {
          guestsToRefund.push({
            displayName: participant.display_name || 'Guest',
            participantId: participant.id
          });
        }
      }

      logger.info('[cancellation-cascade] Participants found for cascade', {
        extra: { bookingId, sessionId, count: participants.length }
      });
    }

    const pendingIntentsResult = await tx.execute(sql`SELECT stripe_payment_intent_id 
       FROM stripe_payment_intents 
       WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')`);

    return { pendingIntents: pendingIntentsResult.rows as unknown as PaymentIntentIdRow[] };
  });
    
  for (const row of txResult.pendingIntents) {
    try {
      const cancelResult = await cancelPaymentIntent(row.stripe_payment_intent_id);
      if (cancelResult.success) {
        logger.info('[cancellation-cascade] Cancelled payment intent', {
          extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
        });
      } else if (cancelResult.error?.includes('already succeeded') || cancelResult.error?.includes('use refund instead')) {
        logger.warn('[cancellation-cascade] PI already succeeded, will refund via succeeded intents path', {
          extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
        });
      } else {
        throw new Error(cancelResult.error || 'Unknown cancel error');
      }
    } catch (cancelErr: unknown) {
      const errorMsg = `Failed to cancel payment intent ${row.stripe_payment_intent_id}: ${getErrorMessage(cancelErr)}`;
      result.errors.push(errorMsg);
      logger.warn('[cancellation-cascade] ' + errorMsg);
    }
  }

  const succeededIntents = await db.execute(sql`SELECT spi.stripe_payment_intent_id, spi.amount_cents, spi.stripe_customer_id, spi.user_id
       FROM stripe_payment_intents spi
       WHERE spi.booking_id = ${bookingId} AND spi.status = 'succeeded'`);

  await Promise.allSettled((succeededIntents.rows as unknown as PaymentIntentIdRow[]).map(async (row) => {
    try {
      const claimResult = await db.execute(sql`UPDATE stripe_payment_intents 
           SET status = 'refunding', updated_at = NOW() 
           WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id} AND status = 'succeeded'
           RETURNING stripe_payment_intent_id`);
        
      if ((claimResult as unknown as { rowCount: number }).rowCount === 0) {
          logger.info('[cancellation-cascade] Payment already claimed or refunded, skipping', {
            extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
          });
          return;
        }
        
        if (row.stripe_payment_intent_id.startsWith('balance-')) {
          if (row.stripe_customer_id) {
            const stripe = await getStripeClient();
            const refundableResult = await db.execute(sql`
              SELECT amount_cents - COALESCE(refunded_amount_cents, 0) AS remaining_cents
              FROM stripe_payment_intents
              WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id}`);
            const remainingRaw = (refundableResult.rows[0] as Record<string, unknown>)?.remaining_cents;
            const remainingCents = remainingRaw != null ? Number(remainingRaw) : (row.amount_cents as number);
            if (remainingCents <= 0) {
              logger.info('[cancellation-cascade] Balance already fully refunded, skipping', {
                extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
              });
              await db.execute(sql`UPDATE stripe_payment_intents 
                 SET status = 'refunded', updated_at = NOW() 
                 WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id} AND status = 'refunding'`);
              return;
            }
            const balanceTxn = await stripe.customers.createBalanceTransaction(
              row.stripe_customer_id,
              {
                amount: -remainingCents,
                currency: 'usd',
                description: `Refund for cancelled booking #${bookingId}`,
              },
              { idempotencyKey: `balance_refund_cascade_${bookingId}_${row.stripe_payment_intent_id}` }
            );
            await markPaymentRefunded({
              paymentIntentId: row.stripe_payment_intent_id,
              refundId: balanceTxn.id,
              amountCents: row.amount_cents as number,
            });
            
            result.prepaymentRefunds++;
            logger.info('[cancellation-cascade] Balance refund issued', {
              extra: { 
                bookingId, 
                paymentIntentId: row.stripe_payment_intent_id,
                amountCents: row.amount_cents,
                txnId: balanceTxn.id
              }
            });
          } else {
            await db.execute(sql`UPDATE stripe_payment_intents 
               SET status = 'succeeded', updated_at = NOW() 
               WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id} AND status = 'refunding'`);
            logger.warn('[cancellation-cascade] Cannot refund balance - no customer ID, reverted to succeeded', {
              extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
            });
          }
        } else {
          const idempotencyKey = `refund-booking-${bookingId}-${row.stripe_payment_intent_id}`;
          const stripe = await getStripeClient();
          const refundParams: { payment_intent: string; reason: 'requested_by_customer'; metadata: Record<string, string> } = {
            payment_intent: row.stripe_payment_intent_id,
            reason: 'requested_by_customer',
            metadata: {
              reason: 'booking_cancellation',
              bookingId: bookingId.toString(),
            },
          };
          const refund = await stripe.refunds.create(refundParams, { idempotencyKey });
          try {
            await markPaymentRefunded({
              paymentIntentId: row.stripe_payment_intent_id,
              refundId: refund.id,
              amountCents: row.amount_cents as number | undefined,
            });
          } catch (statusErr: unknown) {
            logger.warn('[cancellation-cascade] Non-blocking: failed to mark payment refunded, setting refund_succeeded_sync_failed', { extra: { paymentIntentId: row.stripe_payment_intent_id, error: getErrorMessage(statusErr) } });
            try {
              await db.execute(sql`UPDATE stripe_payment_intents 
                 SET status = 'refund_succeeded_sync_failed', updated_at = NOW() 
                 WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id}`);
            } catch (syncErr: unknown) {
              logger.error('[cancellation-cascade] CRITICAL: Failed to set refund_succeeded_sync_failed status', {
                error: getErrorMessage(syncErr),
                extra: { paymentIntentId: row.stripe_payment_intent_id }
              });
            }
          }
          
          result.prepaymentRefunds++;
          logger.info('[cancellation-cascade] Refund issued', {
            extra: { 
              bookingId, 
              paymentIntentId: row.stripe_payment_intent_id,
              refundId: refund.id,
              amountCents: row.amount_cents
            }
          });
        }
      } catch (refundErr: unknown) {
        try {
          await db.execute(sql`UPDATE stripe_payment_intents 
             SET status = 'succeeded', updated_at = NOW() 
             WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id} AND status = 'refunding'`);
        } catch (rollbackErr: unknown) {
          logger.error('[cancellation-cascade] CRITICAL: Failed to rollback payment_intent status after refund queue failure', {
            error: getErrorMessage(rollbackErr),
            extra: { paymentIntentId: row.stripe_payment_intent_id }
          });
        }
        
        const errorMsg = `Failed to queue refund for prepayment ${row.stripe_payment_intent_id}: ${getErrorMessage(refundErr)}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg);
      }
    }));

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
      } catch (notifyError: unknown) {
        const errorMsg = `Failed to notify participant ${member.email}: ${getErrorMessage(notifyError)}`;
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
      } catch (refundError: unknown) {
        const errorMsg = `Failed to refund guest pass for ${guest.displayName}: ${getErrorMessage(refundError)}`;
        result.errors.push(errorMsg);
        logger.warn('[cancellation-cascade] ' + errorMsg, { error: refundError as Error });
      }
    }

    if (result.guestPassesRefunded > 0) {
      try {
        await notifyMember({
          userEmail: ownerEmail,
          title: 'Guest Passes Refunded',
          message: `${result.guestPassesRefunded} guest pass${result.guestPassesRefunded > 1 ? 'es have' : ' has'} been refunded due to your booking cancellation (cancelled more than 1 hour in advance).`,
          type: 'guest_pass',
          relatedId: bookingId,
          relatedType: 'booking_request'
        });
      } catch (notifyError: unknown) {
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

  return result;
}

export async function deleteBooking(bookingId: number, archivedBy: string, hardDelete: boolean) {
  const [booking] = await db.select({
    calendarEventId: bookingRequests.calendarEventId,
    resourceId: bookingRequests.resourceId,
    userEmail: bookingRequests.userEmail,
    userName: bookingRequests.userName,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    sessionId: bookingRequests.sessionId,
    archivedAt: bookingRequests.archivedAt,
    trackmanBookingId: bookingRequests.trackmanBookingId,
    stripeInvoiceId: bookingRequests.stripeInvoiceId
  })
  .from(bookingRequests)
  .where(eq(bookingRequests.id, bookingId));
  
  if (!booking) {
    throw new AppError(404, 'Booking not found');
  }
  
  if (!hardDelete && booking.archivedAt) {
    throw new AppError(400, 'Booking is already archived');
  }
  
  let resourceName: string | undefined;
  if (booking.resourceId) {
    const [resource] = await db.select({ name: resources.name, type: resources.type })
      .from(resources)
      .where(eq(resources.id, booking.resourceId));
    resourceName = resource?.name;
  }
  
  let cascadeResult: CancellationCascadeResult | undefined;
  
  if (hardDelete) {
    try {
      const { voidBookingInvoice } = await import('../billing/bookingInvoiceService');
      const voidResult = await voidBookingInvoice(bookingId);
      if (!voidResult.success) {
        logger.error('[DELETE /api/bookings] Invoice void/refund incomplete before hard delete', {
          extra: { bookingId, stripeInvoiceId: booking.stripeInvoiceId, error: voidResult.error }
        });
      }
    } catch (voidErr: unknown) {
      logger.warn('[DELETE /api/bookings] Failed to void invoice before hard delete', {
        extra: { bookingId, stripeInvoiceId: booking.stripeInvoiceId, error: getErrorMessage(voidErr) }
      });
    }

    try {
      const associatedPIs = await db.execute(sql`
        SELECT stripe_payment_intent_id, status, amount_cents
        FROM stripe_payment_intents
        WHERE booking_id = ${bookingId}
      `);
      for (const row of associatedPIs.rows as unknown as Array<{ stripe_payment_intent_id: string; status: string; amount_cents: number }>) {
        try {
          if (row.status === 'succeeded' && !row.stripe_payment_intent_id.startsWith('balance-') && !row.stripe_payment_intent_id.startsWith('invoice-')) {
            const stripe = await getStripeClient();
            await stripe.refunds.create({
              payment_intent: row.stripe_payment_intent_id,
              reason: 'requested_by_customer',
              metadata: { reason: 'hard_delete_booking', bookingId: String(bookingId) },
            }, { idempotencyKey: `refund_hard_delete_${bookingId}_${row.stripe_payment_intent_id}` });
            logger.info('[DELETE /api/bookings] Refunded succeeded PI before hard delete', {
              extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
            });
          } else if (row.status !== 'canceled' && row.status !== 'refunded' && !row.stripe_payment_intent_id.startsWith('balance-') && !row.stripe_payment_intent_id.startsWith('invoice-')) {
            const cancelResult = await cancelPaymentIntent(row.stripe_payment_intent_id);
            if (!cancelResult.success) {
              logger.warn('[DELETE /api/bookings] Failed to cancel PI before hard delete', {
                extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id, error: cancelResult.error }
              });
            } else {
              logger.info('[DELETE /api/bookings] Cancelled PI before hard delete', {
                extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id }
              });
            }
          }
        } catch (piErr: unknown) {
          logger.warn('[DELETE /api/bookings] Failed to refund/cancel PI before hard delete', {
            extra: { bookingId, paymentIntentId: row.stripe_payment_intent_id, error: getErrorMessage(piErr) }
          });
        }
      }
    } catch (piQueryErr: unknown) {
      logger.warn('[DELETE /api/bookings] Failed to query PIs before hard delete', {
        extra: { bookingId, error: getErrorMessage(piQueryErr) }
      });
    }

    try {
      await releaseGuestPassHold(bookingId);
    } catch (holdErr: unknown) {
      logger.warn('[DELETE /api/bookings] Failed to release guest pass hold before hard delete', {
        extra: { bookingId, error: getErrorMessage(holdErr) }
      });
    }

    await db.transaction(async (tx) => {
      if (booking.sessionId) {
        await tx.execute(sql`DELETE FROM booking_participants WHERE session_id = ${booking.sessionId}`);
        await tx.execute(sql`DELETE FROM booking_sessions WHERE id = ${booking.sessionId}`);
      }
      
      if (booking.trackmanBookingId) {
        await tx.execute(sql`DELETE FROM trackman_bay_slots WHERE trackman_booking_id = ${booking.trackmanBookingId}`);
        await tx.execute(sql`UPDATE trackman_webhook_events SET matched_booking_id = NULL WHERE trackman_booking_id = ${booking.trackmanBookingId}`);
        await tx.execute(sql`DELETE FROM trackman_unmatched_bookings WHERE trackman_booking_id = ${booking.trackmanBookingId}`);
      }
      
      await tx.execute(sql`DELETE FROM stripe_payment_intents WHERE booking_id = ${bookingId}`);
      await tx.execute(sql`DELETE FROM booking_fee_snapshots WHERE booking_id = ${bookingId}`);
      await tx.execute(sql`DELETE FROM booking_requests WHERE id = ${bookingId}`);
    });
    
    logger.info('[DELETE /api/bookings] Hard delete complete', {
      extra: {
        bookingId,
        deletedBy: archivedBy,
        trackmanBookingId: booking.trackmanBookingId,
        sessionId: booking.sessionId
      }
    });
  } else {
    cascadeResult = await handleCancellationCascade(
      bookingId,
      booking.sessionId,
      booking.userEmail || '',
      booking.userName || null,
      booking.requestDate,
      booking.startTime || '',
      resourceName
    );
    
    try {
      const { voidBookingInvoice } = await import('../billing/bookingInvoiceService');
      const voidResult = await voidBookingInvoice(bookingId);
      if (!voidResult.success) {
        logger.error('[DELETE /api/bookings] Invoice void/refund incomplete', {
          extra: { bookingId, error: voidResult.error }
        });
      }
    } catch (voidErr: unknown) {
      logger.warn('[DELETE /api/bookings] Failed to void booking invoice', {
        extra: { bookingId, error: getErrorMessage(voidErr) }
      });
    }
    
    await releaseGuestPassHold(bookingId);

    await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_action')`).catch((err: unknown) => {
      logger.warn('[DELETE /api/bookings] Non-blocking: failed to cancel fee snapshots', { extra: { bookingId, error: getErrorMessage(err) } });
    });

    await db.update(bookingRequests)
      .set({ 
        status: 'cancelled',
        archivedAt: new Date(),
        archivedBy: archivedBy
      })
      .where(eq(bookingRequests.id, bookingId));

    voidBookingPass(bookingId).catch(err => logger.error('[DELETE /api/bookings] Failed to void booking wallet pass:', { extra: { error: getErrorMessage(err) } }));

    logger.info('[DELETE /api/bookings] Soft delete complete', {
      extra: {
        bookingId,
        archivedBy,
        participantsNotified: cascadeResult.participantsNotified,
        guestPassesRefunded: cascadeResult.guestPassesRefunded,
        bookingParticipantsRemoved: cascadeResult.bookingParticipantsRemoved,
        prepaymentRefunds: cascadeResult.prepaymentRefunds,
        cascadeErrors: cascadeResult.errors.length
      }
    });
  }
  
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
    } catch (calError: unknown) {
      logger.error('Failed to delete calendar event (non-blocking)', { extra: { error: getErrorMessage(calError) } });
    }
  }
  
  return { 
    hardDeleted: hardDelete, 
    archived: !hardDelete, 
    archivedBy,
    cascadeErrors: cascadeResult?.errors?.length ? cascadeResult.errors : undefined,
    prepaymentRefunds: cascadeResult?.prepaymentRefunds ?? 0,
    guestPassesRefunded: cascadeResult?.guestPassesRefunded ?? 0,
    participantsNotified: cascadeResult?.participantsNotified ?? 0,
  };
}

export async function memberCancelBooking(bookingId: number, userEmail: string, sessionUserRole: string | undefined, actingAsEmail?: string) {
  const isAdminViewingAs = (sessionUserRole === 'admin' || sessionUserRole === 'staff') && actingAsEmail;
  
  const [existing] = await db.select({
    id: bookingRequests.id,
    userEmail: bookingRequests.userEmail,
    userName: bookingRequests.userName,
    status: bookingRequests.status,
    calendarEventId: bookingRequests.calendarEventId,
    resourceId: bookingRequests.resourceId,
    requestDate: bookingRequests.requestDate,
    startTime: bookingRequests.startTime,
    durationMinutes: bookingRequests.durationMinutes,
    sessionId: bookingRequests.sessionId,
    trackmanBookingId: bookingRequests.trackmanBookingId,
  })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, bookingId));
  
  if (!existing) {
    throw new AppError(404, 'Booking not found');
  }
  
  const bookingEmail = existing.userEmail?.toLowerCase();
  
  const isOwnBooking = bookingEmail === userEmail;
  const isValidViewAs = isAdminViewingAs && bookingEmail === actingAsEmail;
  
  if (!isOwnBooking && !isValidViewAs) {
    throw new AppError(403, 'You can only cancel your own bookings', {
      _logData: {
        bookingId,
        bookingEmail: existing.userEmail,
        sessionEmail: userEmail,
        actingAsEmail: actingAsEmail || 'none',
        normalizedBookingEmail: bookingEmail,
        normalizedSessionEmail: userEmail
      }
    });
  }
  
  if (existing.status === 'cancelled') {
    throw new AppError(400, 'Booking is already cancelled');
  }
  if (existing.status === 'cancellation_pending') {
    if (isAdminViewingAs) {
      logger.warn('[memberCancelBooking] Staff force-cancelling booking stuck in cancellation_pending', {
        extra: { bookingId, staffEmail: userEmail, actingAsEmail }
      });
    } else {
      throw new AppError(400, 'Cancellation is already in progress');
    }
  }

  if (!isAdminViewingAs && existing.requestDate && existing.startTime) {
    const bookingStart = createPacificDate(existing.requestDate, existing.startTime);
    if (bookingStart <= new Date()) {
      throw new AppError(400, 'This booking has already started and cannot be cancelled');
    }
  }
  
  const wasApproved = existing.status === 'approved';
  const isTrackmanLinked = !!existing.trackmanBookingId;
  const needsPendingCancel = wasApproved && isTrackmanLinked;
  
  if (needsPendingCancel) {
    await db.update(bookingRequests)
      .set({
        status: 'cancellation_pending',
        cancellationPendingAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(bookingRequests.id, bookingId));
    
    const memberName = existing.userName || existing.userEmail;
    const bookingDate = existing.requestDate;
    const bookingTime = existing.startTime?.substring(0, 5) || '';
    
    let bayName = 'Simulator';
    if (existing.resourceId) {
      const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
      if (resource?.name) bayName = resource.name;
    }
    
    const staffMessage = `${memberName} wants to cancel their booking on ${bookingDate} at ${bookingTime} (${bayName}). Please cancel in Trackman to complete the cancellation.`;
    
    notifyAllStaff(
      'Cancellation Request - Cancel in Trackman',
      staffMessage,
      'cancellation_pending',
      {
        relatedId: bookingId,
        relatedType: 'booking_request',
        url: '/admin/bookings'
      }
    ).catch(err => logger.error('Staff cancellation notification failed', { extra: { error: getErrorMessage(err) } }));
    
    if (existing.userEmail && !isSyntheticEmail(existing.userEmail)) {
      await db.insert(notifications).values({
        userEmail: existing.userEmail,
        title: 'Cancellation Request Submitted',
        message: `Your cancellation request for ${bookingDate} at ${bookingTime} has been submitted. You'll be notified once it's fully processed.`,
        type: 'cancellation_pending',
        relatedId: bookingId,
        relatedType: 'booking_request'
      });
    }
    
    return { 
      success: true, 
      status: 'cancellation_pending',
      message: 'Cancellation request submitted. You will be notified once it is fully processed.',
      existing,
      isPending: true
    };
  }
  
  let resourceName: string | undefined;
  if (existing.resourceId) {
    const [resource] = await db.select({ name: resources.name, type: resources.type })
      .from(resources)
      .where(eq(resources.id, existing.resourceId));
    resourceName = resource?.name;
  }
  
  if (existing.resourceId && existing.requestDate && existing.startTime) {
    try {
      if (existing.durationMinutes) {
        const [startHour, startMin] = existing.startTime.split(':').map(Number);
        const startTotalMin = startHour * 60 + startMin;
        const endTotalMin = startTotalMin + existing.durationMinutes;
        const endHour = Math.floor(endTotalMin / 60);
        const endMinute = endTotalMin % 60;
        const endTime = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`;
        await db.execute(sql`DELETE FROM trackman_bay_slots 
           WHERE resource_id = ${existing.resourceId} AND slot_date = ${existing.requestDate} AND start_time >= ${existing.startTime} AND start_time < ${endTime}`);
      } else {
        await db.execute(sql`DELETE FROM trackman_bay_slots 
           WHERE resource_id = ${existing.resourceId} AND slot_date = ${existing.requestDate}`);
      }
    } catch (err: unknown) {
      logger.warn('[Member Cancel] Failed to clean up trackman_bay_slots', { 
        bookingId, 
        resourceId: existing.resourceId,
        error: getErrorMessage(err) 
      });
    }
  }
  
  const cascadeResult = await handleCancellationCascade(
    bookingId,
    existing.sessionId,
    existing.userEmail || '',
    existing.userName || null,
    existing.requestDate,
    existing.startTime || '',
    resourceName
  );
  
  try {
    const { voidBookingInvoice } = await import('../billing/bookingInvoiceService');
    const voidResult = await voidBookingInvoice(bookingId);
    if (!voidResult.success) {
      logger.error('[Member Cancel] Invoice void/refund incomplete', {
        extra: { bookingId, error: voidResult.error }
      });
    }
  } catch (voidErr: unknown) {
    logger.warn('[Member Cancel] Failed to void booking invoice', { 
      extra: { bookingId, error: getErrorMessage(voidErr) }
    });
  }
  
  await releaseGuestPassHold(bookingId);

  await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_action', 'succeeded')`).catch((err: unknown) => {
    logger.warn('[Member Cancel] Non-blocking: failed to cancel fee snapshots', { extra: { bookingId, error: getErrorMessage(err) } });
  });

  await db.update(bookingRequests)
    .set({ 
      status: 'cancelled',
      trackmanExternalId: null
    })
    .where(eq(bookingRequests.id, bookingId));
  
  logger.info('[PUT /api/bookings/member-cancel] Cancellation cascade complete', {
    extra: {
      bookingId,
      participantsNotified: cascadeResult.participantsNotified,
      guestPassesRefunded: cascadeResult.guestPassesRefunded,
      bookingParticipantsRemoved: cascadeResult.bookingParticipantsRemoved,
      prepaymentRefunds: cascadeResult.prepaymentRefunds,
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
  } catch (staffNotifyErr: unknown) {
    logger.error('Staff notification failed', { extra: { error: getErrorMessage(staffNotifyErr) } });
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
    } catch (calError: unknown) {
      logger.error('Failed to delete calendar event (non-blocking)', { extra: { error: getErrorMessage(calError) } });
    }
  }
  
  logMemberAction({ action: 'booking_cancelled_member', resourceType: 'booking', resourceId: bookingId.toString(), memberEmail: existing.userEmail || '', details: {
    member_email: existing.userEmail,
    member_name: existing.userName,
    booking_date: existing.requestDate,
    booking_time: existing.startTime,
    bay_name: resourceName,
    refunded_passes: cascadeResult.guestPassesRefunded,
    prepayment_refunds: cascadeResult.prepaymentRefunds
  }});
  
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
  }).catch(err => logger.error('Booking event publish failed', { extra: { error: getErrorMessage(err) } }));

  voidBookingPass(bookingId).catch(err => logger.error('[memberCancelBooking] Failed to void booking wallet pass:', { extra: { error: getErrorMessage(err) } }));

  return { 
    success: true,
    existing,
    cascadeResult,
    isPending: false,
    message: 'Booking cancelled successfully',
    cascade: {
      participantsNotified: cascadeResult.participantsNotified,
      guestPassesRefunded: cascadeResult.guestPassesRefunded,
      prepaymentRefunds: cascadeResult.prepaymentRefunds,
      errors: cascadeResult.errors.length ? cascadeResult.errors : undefined
    }
  };
}
