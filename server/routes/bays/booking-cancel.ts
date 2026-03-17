import { Router } from 'express';
import { db } from '../../db';
import { bookingRequests, resources } from '../../../shared/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { logAndRespond, logger } from '../../core/logger';
import { notifyAllStaff, notifyMember, isSyntheticEmail } from '../../core/notificationService';
import { createPacificDate } from '../../utils/dateUtils';
import { broadcastAvailabilityUpdate } from '../../core/websocket';
import { getSessionUser } from '../../types/session';
import { getStripeClient } from '../../core/stripe';
import { logFromRequest, logMemberAction } from '../../core/auditLog';
import { getCalendarNameForBayAsync } from './helpers';
import { isAuthenticated } from '../../core/middleware';
import { getCalendarIdByName, deleteCalendarEvent } from '../../core/calendar/index';
import { refundGuestPass } from '../guestPasses';
import { voidBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { getErrorMessage } from '../../utils/errorUtils';
import { cancelPendingPaymentIntentsForBooking } from '../../core/billing/paymentIntentCleanup';

const router = Router();

router.put('/api/booking-requests/:id/member-cancel', isAuthenticated, async (req, res) => {
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
    
    const idStr = String(id);
    const bookingId = parseInt(idStr, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    
    const [existing] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      status: bookingRequests.status,
      calendarEventId: bookingRequests.calendarEventId,
      resourceId: bookingRequests.resourceId,
      trackmanBookingId: bookingRequests.trackmanBookingId,
      staffNotes: bookingRequests.staffNotes,
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
    
    let isLinkedEmail = false;
    if (!isOwnBooking && !isValidViewAs && bookingEmail && userEmail) {
      const linkedCheck = await db.execute(sql`SELECT 1 FROM users 
         WHERE LOWER(email) = ${userEmail} 
         AND (
           LOWER(trackman_email) = ${bookingEmail}
           OR COALESCE(linked_emails, '[]'::jsonb) @> to_jsonb(${bookingEmail}::text)
           OR COALESCE(manually_linked_emails, '[]'::jsonb) @> to_jsonb(${bookingEmail}::text)
         )
         LIMIT 1`);
      isLinkedEmail = (linkedCheck.rowCount ?? 0) > 0;
    }
    
    if (!isOwnBooking && !isValidViewAs && !isLinkedEmail) {
      logger.warn('[Member Cancel] Email mismatch', { extra: { bookingId_bookingEmail_existing_userEmail_sessionEmail_rawSessionEmail_actingAsEmail_actingAsEmail_none: { 
        bookingId, 
        bookingEmail: existing.userEmail, 
        sessionEmail: rawSessionEmail,
        actingAsEmail: actingAsEmail || 'none'
      } } });
      return res.status(403).json({ error: 'You can only cancel your own bookings' });
    }
    
    if (existing.status === 'cancelled' || existing.status === 'declined') {
      return res.status(400).json({ error: 'Booking is already cancelled' });
    }
    
    if (existing.status === 'cancellation_pending') {
      return res.status(400).json({ error: 'Cancellation is already in progress' });
    }

    if (!isAdminViewingAs && existing.requestDate && existing.startTime) {
      const dateStr = existing.requestDate && typeof existing.requestDate === 'object' && 'toISOString' in (existing.requestDate as object)
        ? (existing.requestDate as unknown as Date).toISOString().split('T')[0] 
        : String(existing.requestDate);
      const timeStr = existing.startTime && typeof existing.startTime === 'object' && 'toISOString' in (existing.startTime as object)
        ? (existing.startTime as unknown as Date).toISOString().substring(11, 16) 
        : String(existing.startTime).substring(0, 5);
      const bookingStart = createPacificDate(dateStr, timeStr);
      if (bookingStart.getTime() <= new Date().getTime()) {
        return res.status(400).json({ error: 'This booking has already started and cannot be cancelled' });
      }
    }
    
    const wasApproved = existing.status === 'approved';
    const isTrackmanLinked = !!existing.trackmanBookingId;
    const needsPendingCancel = wasApproved && isTrackmanLinked;
    
    if (needsPendingCancel) {
      const pendingResult = await db.update(bookingRequests)
        .set({
          status: 'cancellation_pending',
          cancellationPendingAt: new Date(),
          staffNotes: existing.staffNotes 
            ? `${existing.staffNotes}\n[Member requested cancellation - awaiting Trackman cancellation]`
            : '[Member requested cancellation - awaiting Trackman cancellation]',
          updatedAt: new Date()
        })
        .where(and(
          eq(bookingRequests.id, bookingId),
          inArray(bookingRequests.status, ['pending', 'pending_approval', 'approved', 'confirmed'])
        ))
        .returning({ id: bookingRequests.id });
      
      if (pendingResult.length === 0) {
        return res.status(409).json({ error: 'Booking could not be cancelled. Its status was changed concurrently.' });
      }
      
      logFromRequest(req, 'cancellation_requested', 'booking', idStr, undefined, {
        member_email: existing.userEmail,
        trackman_booking_id: existing.trackmanBookingId
      });
      
      const memberName = existing.userName || existing.userEmail;
      const bookingDate = existing.requestDate && typeof existing.requestDate === 'object' && 'toISOString' in (existing.requestDate as object)
        ? (existing.requestDate as unknown as Date).toISOString().split('T')[0] 
        : String(existing.requestDate);
      const bookingTime = existing.startTime && typeof existing.startTime === 'object' && 'toISOString' in (existing.startTime as object)
        ? (existing.startTime as unknown as Date).toISOString().substring(11, 16) 
        : String(existing.startTime).substring(0, 5);
      let bayName = 'Simulator';
      if (existing.resourceId) {
        const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
        if (resource?.name) bayName = resource.name;
      }
      
      const staffMessage = `${memberName} wants to cancel their booking on ${bookingDate} at ${bookingTime} (${bayName}). Please cancel in Trackman to complete the cancellation.`;
      
      notifyAllStaff(
        'Cancellation Request - Cancel in Trackman',
        staffMessage,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/admin/bookings'
        }
      ).catch((err: unknown) => logger.error('Staff cancellation notification failed:', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
      
      if (existing.userEmail && !isSyntheticEmail(existing.userEmail)) {
        await notifyMember({
          userEmail: existing.userEmail,
          title: 'Cancellation Request Submitted',
          message: `Your cancellation request for ${bookingDate} at ${bookingTime} has been submitted. You'll be notified once it's fully processed.`,
          type: 'cancellation_pending',
          relatedId: bookingId,
          relatedType: 'booking_request'
        }, { sendPush: true }).catch(err => logger.error('[Member Cancel] Notification failed', { extra: { error: getErrorMessage(err) } }));
      }
      
      await logMemberAction({
        memberEmail: existing.userEmail || '',
        action: 'cancellation_requested',
        resourceType: 'booking',
        resourceId: String(bookingId),
        resourceName: `${bayName} on ${bookingDate}`,
        details: {
          booking_date: bookingDate,
          start_time: bookingTime,
          bay: bayName,
          trackman_booking_id: existing.trackmanBookingId
        }
      });
      
      return res.json({ 
        success: true, 
        status: 'cancellation_pending',
        message: 'Cancellation request submitted. You will be notified once it is fully processed.'
      });
    }
    
    // Calculate time until booking starts using Pacific timezone
    const refundDateStr = existing.requestDate && typeof existing.requestDate === 'object' && 'toISOString' in (existing.requestDate as object)
      ? (existing.requestDate as unknown as Date).toISOString().split('T')[0] 
      : String(existing.requestDate);
    const refundTimeStr = existing.startTime && typeof existing.startTime === 'object' && 'toISOString' in (existing.startTime as object)
      ? (existing.startTime as unknown as Date).toISOString().substring(11, 16) 
      : String(existing.startTime).substring(0, 5);
    const bookingStart = createPacificDate(refundDateStr, refundTimeStr || '00:00');
    const nowPacific = new Date();
    const hoursUntilStart = (bookingStart.getTime() - nowPacific.getTime()) / (1000 * 60 * 60);
    const shouldSkipRefund = hoursUntilStart < 1;
    
    let staffNotes = existing.staffNotes || '';
    if (existing.trackmanBookingId) {
      const cancelNote = '[Cancelled in app - needs Trackman cancellation]';
      staffNotes = staffNotes ? `${staffNotes}\n${cancelNote}` : cancelNote;
    }
    
    const guestPassRecipientsToRefund: Array<{ displayName: string | null }> = [];
    
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM guest_pass_holds WHERE booking_id = ${bookingId}`);
      
      if (existing.sessionId) {
        const guestParticipants = await tx.execute(sql`SELECT display_name FROM booking_participants
           WHERE session_id = ${existing.sessionId} AND participant_type = 'guest' AND used_guest_pass = true`);
        for (const guest of guestParticipants.rows as Array<Record<string, unknown>>) {
          guestPassRecipientsToRefund.push({ displayName: (guest.display_name as string) || null });
        }
        
        if (!shouldSkipRefund) {
          await tx.execute(sql`UPDATE booking_participants 
             SET cached_fee_cents = 0, payment_status = 'waived'
             WHERE session_id = ${existing.sessionId} 
             AND payment_status = 'pending'`);
          logger.info('[Member Cancel] Cleared pending fees for session', { extra: { sessionId: existing.sessionId } });
        } else {
          logger.info('[Member Cancel] Late cancellation — preserving pending fees for session', { extra: { sessionId: existing.sessionId } });
        }
      }
    });
    
    if (!shouldSkipRefund) {
      for (const guest of guestPassRecipientsToRefund) {
        try {
          const refundResult = await refundGuestPass(existing.userEmail, guest.displayName || undefined, false);
          if (refundResult.success) {
            logger.info('[Member Cancel] Refunded guest pass for participant', { extra: { bookingId, guestName: guest.displayName, ownerEmail: existing.userEmail } });
          } else {
            logger.error('[Member Cancel] Guest pass refund failed', { extra: { bookingId, guestName: guest.displayName, ownerEmail: existing.userEmail, error: refundResult.error } });
          }
        } catch (refundErr: unknown) {
          logger.error('[Member Cancel] Guest pass refund threw (non-blocking)', { extra: { bookingId, guestName: guest.displayName, error: getErrorMessage(refundErr) } });
        }
      }
    } else {
      logger.info('[Member Cancel] Late cancellation — skipping guest pass refund', { extra: { bookingId, hoursUntilStart } });
    }
    
    let refundedAmountCents = 0;
    let refundType: 'none' | 'overage' | 'guest_fees' | 'both' = 'none';
    let refundSkippedDueToLateCancel = false;
    
    if (!shouldSkipRefund) {
      try {
        if (existing.sessionId) {
          const paidParticipants = await db.execute(sql`SELECT id, stripe_payment_intent_id, cached_fee_cents, display_name
             FROM booking_participants 
             WHERE session_id = ${existing.sessionId} 
             AND payment_status = 'paid' 
             AND stripe_payment_intent_id IS NOT NULL 
             AND stripe_payment_intent_id != ''
             AND stripe_payment_intent_id NOT LIKE 'balance-%'`);
          
          if (paidParticipants.rows.length > 0) {
            const stripe = await getStripeClient();
            for (const rawParticipant of paidParticipants.rows as Array<Record<string, unknown>>) {
              try {
                const alreadyRefunding = await db.execute(sql`SELECT 1 FROM stripe_payment_intents 
                   WHERE stripe_payment_intent_id = ${rawParticipant.stripe_payment_intent_id as string} 
                   AND status IN ('refunding', 'refunded')
                   LIMIT 1`);
                if ((alreadyRefunding.rows?.length || 0) > 0) {
                  await db.execute(sql`UPDATE booking_participants SET payment_status = 'refunded', refunded_at = NOW() WHERE id = ${rawParticipant.id}`);
                  logger.info('[Member Cancel] PI already queued for refund by invoice void, marking participant refunded', { extra: { bookingId, participantId: rawParticipant.id, piId: rawParticipant.stripe_payment_intent_id } });
                  continue;
                }
                const claimResult = await db.execute(sql`UPDATE stripe_payment_intents 
                   SET status = 'refunding' 
                   WHERE stripe_payment_intent_id = ${rawParticipant.stripe_payment_intent_id as string} 
                   AND status = 'succeeded'
                   RETURNING id`);
                if ((claimResult.rows?.length || 0) === 0) {
                  logger.info('[Member Cancel] PI already claimed for refund, skipping', { extra: { bookingId, piId: rawParticipant.stripe_payment_intent_id } });
                  await db.execute(sql`UPDATE booking_participants SET payment_status = 'refunded', refunded_at = NOW() WHERE id = ${rawParticipant.id}`);
                  continue;
                }
                const pi = await stripe.paymentIntents.retrieve(rawParticipant.stripe_payment_intent_id as string);
                if (pi.status === 'succeeded' && pi.latest_charge) {
                  const refund = await stripe.refunds.create({
                    charge: pi.latest_charge as string,
                    reason: 'requested_by_customer',
                    metadata: {
                      type: 'booking_cancelled',
                      bookingId: bookingId.toString(),
                      participantId: String(rawParticipant.id)
                    }
                  }, {
                    idempotencyKey: `refund_cancel_participant_${bookingId}_${rawParticipant.stripe_payment_intent_id}`
                  });
                  refundedAmountCents += refund.amount;
                  refundType = refundType === 'none' ? 'guest_fees' : 'both';
                  await db.execute(sql`UPDATE booking_participants SET payment_status = 'refunded', refunded_at = NOW() WHERE id = ${rawParticipant.id}`);
                  logger.info('[Member Cancel] Refunded guest fee for : $, refund', { extra: { participantDisplay_name: rawParticipant.display_name, participantCached_fee_cents_100_ToFixed_2: (Number(rawParticipant.cached_fee_cents) / 100).toFixed(2), refundId: refund.id } });
                }
              } catch (refundErr: unknown) {
                logger.error('[Member Cancel] Failed to refund participant', { extra: { id: rawParticipant.id, error: getErrorMessage(refundErr) } });
              }
            }
          }
        }
      } catch (participantRefundErr: unknown) {
        logger.error('[Member Cancel] Failed to process participant refunds (non-blocking)', { extra: { error: getErrorMessage(participantRefundErr) } });
      }
    } else {
      refundSkippedDueToLateCancel = true;
    }
    
    if (!shouldSkipRefund) {
      try {
        await voidBookingInvoice(bookingId);
      } catch (err: unknown) {
        logger.error('[Member Cancel] Failed to void/refund booking invoice (non-blocking)', {
          extra: { bookingId, error: getErrorMessage(err) }
        });
      }
    } else {
      // Late-cancel: the booking invoice is intentionally preserved so the club can
      // collect the late-cancellation fee. The invoice remains open for staff to
      // finalize and charge the member's payment method on file.
      logger.info('[Member Cancel] Late cancellation — preserving booking invoice for fee collection', { extra: { bookingId } });
    }
    
    if (!shouldSkipRefund) {
      try {
        await cancelPendingPaymentIntentsForBooking(bookingId);
      } catch (cancelIntentsErr: unknown) {
        logger.error('[Member Cancel] Failed to cancel pending payment intents (non-blocking)', { extra: { error: getErrorMessage(cancelIntentsErr) } });
      }
    } else {
      // Late-cancel PI preservation rationale:
      // - Fee snapshots are marked 'cancelled' so they do NOT trigger false positives
      //   in the orphaned payment intent integrity check (which filters on
      //   'pending'/'requires_action' snapshots).
      // - Stripe PIs in the stripe_payment_intents table are intentionally left open.
      //   The fee collection mechanism is the preserved booking invoice (above), not
      //   these PIs directly.
      // - Resolution path for the preserved PIs:
      //   1. The fee snapshot reconciliation scheduler periodically cleans up
      //      abandoned and stale PIs on cancelled bookings.
      //   2. An integrity check surfaces PIs that remain pending on cancelled
      //      bookings for staff review.
      try {
        await db.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status IN ('pending', 'requires_action')`);
        logger.info('[Member Cancel] Late cancel — marked pending fee snapshots as cancelled (Stripe PIs preserved for fee collection)', { extra: { bookingId } });
      } catch (snapshotErr: unknown) {
        logger.error('[Member Cancel] Failed to cancel fee snapshots for late cancel (non-blocking)', { extra: { bookingId, error: getErrorMessage(snapshotErr) } });
      }
    }
    
    const cancelResult = await db.update(bookingRequests)
      .set({
        status: 'cancelled',
        staffNotes: staffNotes || undefined,
        updatedAt: new Date()
      })
      .where(and(
        eq(bookingRequests.id, bookingId),
        inArray(bookingRequests.status, ['pending', 'pending_approval', 'approved', 'confirmed'])
      ))
      .returning({ id: bookingRequests.id });
    
    if (cancelResult.length === 0) {
      throw new Error('Booking could not be cancelled. Its status was changed concurrently by a staff member.');
    }
    
    try {
      const { voidBookingPass } = await import('../../walletPass/bookingPassService');
      voidBookingPass(bookingId).catch(err => logger.error('[Member Cancel] Failed to void booking wallet pass:', { extra: { error: getErrorMessage(err) } }));
    } catch (importErr: unknown) {
      logger.error('[Member Cancel] Failed to import voidBookingPass:', { extra: { error: getErrorMessage(importErr) } });
    }

    logFromRequest(req, 'cancel_booking', 'booking', idStr, undefined, {
      member_email: existing.userEmail
    });
    
    if (wasApproved) {
      const memberName = existing.userName || existing.userEmail;
      const bookingDate = existing.requestDate && typeof existing.requestDate === 'object' && 'toISOString' in (existing.requestDate as object)
        ? (existing.requestDate as unknown as Date).toISOString().split('T')[0] 
        : String(existing.requestDate);
      const bookingTime = existing.startTime && typeof existing.startTime === 'object' && 'toISOString' in (existing.startTime as object)
        ? (existing.startTime as unknown as Date).toISOString().substring(11, 16) 
        : String(existing.startTime).substring(0, 5);
      const staffMessage = `${memberName} has cancelled their booking for ${bookingDate} at ${bookingTime}.`;
      
      notifyAllStaff(
        'Booking Cancelled by Member',
        staffMessage,
        'booking_cancelled',
        {
          relatedId: bookingId,
          relatedType: 'booking_request',
          url: '/admin/bookings'
        }
      ).catch((err: unknown) => logger.error('Staff cancellation notification failed:', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
      
      if (existing.trackmanBookingId) {
        let bayName = 'Bay';
        if (existing.resourceId) {
          const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
          if (resource?.name) {
            bayName = resource.name;
          }
        }
        
        const trackmanReminderMessage = `Reminder: ${memberName}'s booking on ${bookingDate} at ${bookingTime} (${bayName}) was cancelled - please also cancel in Trackman`;
        
        notifyAllStaff(
          'Trackman Cancellation Required',
          trackmanReminderMessage,
          'booking_cancelled',
          {
            relatedId: bookingId,
            relatedType: 'booking_request',
            url: '/admin/bookings'
          }
        ).catch((err: unknown) => logger.error('Staff trackman cancellation notification failed:', { error: err instanceof Error ? err : new Error(getErrorMessage(err)) }));
      }
      
      if (existing.calendarEventId) {
        try {
          const calendarName = await getCalendarNameForBayAsync(existing.resourceId);
          if (calendarName) {
            const calendarId = await getCalendarIdByName(calendarName);
            if (calendarId) {
              await deleteCalendarEvent(existing.calendarEventId, calendarId);
            }
          }
        } catch (calError: unknown) {
          logger.error('Failed to delete calendar event (non-blocking)', { extra: { calError } });
        }
      }
      
      let cancelResourceType: string = 'simulator';
      if (existing.resourceId) {
        const [resForType] = await db.select({ type: resources.type }).from(resources).where(eq(resources.id, existing.resourceId));
        if (resForType?.type) cancelResourceType = resForType.type;
      }
      broadcastAvailabilityUpdate({
        resourceId: existing.resourceId || undefined,
        resourceType: cancelResourceType as 'simulator' | 'conference_room',
        date: existing.requestDate,
        action: 'cancelled'
      });
    }
    
    let bayNameForLog = 'Simulator';
    if (existing.resourceId) {
      const [resourceForLog] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, existing.resourceId));
      if (resourceForLog?.name) {
        bayNameForLog = resourceForLog.name;
      }
    }
    
    const bookingDate = existing.requestDate && typeof existing.requestDate === 'object' && 'toISOString' in (existing.requestDate as object)
      ? (existing.requestDate as unknown as Date).toISOString().split('T')[0] 
      : String(existing.requestDate);
    const bookingTime = existing.startTime && typeof existing.startTime === 'object' && 'toISOString' in (existing.startTime as object)
      ? (existing.startTime as unknown as Date).toISOString().substring(11, 16) 
      : String(existing.startTime).substring(0, 5);
    
    await logMemberAction({
      memberEmail: existing.userEmail || '',
      action: 'booking_cancelled_member',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Booking on ${bookingDate} at ${bookingTime}`,
      details: {
        source: 'member_dashboard',
        booking_date: bookingDate,
        booking_time: existing.startTime,
        bay_name: bayNameForLog,
        had_trackman_booking: !!existing.trackmanBookingId,
        refund_amount_cents: refundedAmountCents || 0,
        refund_type: refundType || 'none'
      },
      req
    });
    
    if (refundSkippedDueToLateCancel) {
      res.json({ 
        success: true, 
        message: 'Booking cancelled successfully. Fees were forfeited due to cancellation within 1 hour of booking start time.',
        refundSkipped: true
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Booking cancelled successfully',
        refundSkipped: false
      });
    }
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to cancel booking', error);
  }
});

export default router;
