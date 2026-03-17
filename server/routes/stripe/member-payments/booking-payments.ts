import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../../core/middleware';
import { paymentRateLimiter } from '../../../middleware/rateLimiting';
import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { getSessionUser } from '../../../types/session';
import {
  confirmPaymentSuccess,
  getOrCreateStripeCustomer,
  type BookingFeeLineItem,
} from '../../../core/stripe';
import { resolveUserByEmail } from '../../../core/stripe/customers';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants } from '../../../core/billing/unifiedFeeService';
import { sendNotificationToUser, broadcastBillingUpdate, broadcastBookingInvoiceUpdate } from '../../../core/websocket';
import { logPaymentAudit } from '../../../core/auditLog';
import { alertOnExternalServiceError } from '../../../core/errorAlerts';
import { getErrorMessage } from '../../../utils/errorUtils';
import { toIntArrayLiteral } from '../../../utils/sqlArrayLiteral';
import { createDraftInvoiceForBooking, buildInvoiceDescription } from '../../../core/billing/bookingInvoiceService';
import { logger } from '../../../core/logger';
import {
  BookingRow,
  ParticipantRow,
  SnapshotRow,
  IdRow,
  getStripeDeclineMessage,
  describeFee,
  finalizeInvoiceWithPi,
  handleExistingInvoicePayment,
} from './shared';

const router = Router();

router.post('/api/member/bookings/:id/pay-fees', isAuthenticated, paymentRateLimiter, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const bookingResult = await db.execute(sql`
      SELECT br.id, br.session_id, br.user_email, br.user_name, br.status, br.trackman_booking_id, u.id as user_id, u.first_name, u.last_name
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as unknown as BookingRow;

    if (booking.status === 'cancelled' || booking.status === 'cancellation_pending' || booking.status === 'declined') {
      return res.status(400).json({ error: 'Cannot pay for a cancelled or declined booking' });
    }

    if (booking.user_email?.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Only the booking owner can pay fees' });
    }

    if (!booking.session_id) {
      return res.status(400).json({ error: 'Booking has no session' });
    }

    let breakdown;
    try {
      breakdown = await computeFeeBreakdown({
        sessionId: booking.session_id,
        source: 'stripe' as const
      });
      await applyFeeBreakdownToParticipants(booking.session_id, breakdown);
    } catch (feeError: unknown) {
      logger.error('[Stripe] Failed to compute fees', { extra: { feeError } });
      return res.status(500).json({ error: 'Failed to calculate fees' });
    }

    const pendingParticipants = await db.execute(sql`
      SELECT bp.id, bp.participant_type, bp.display_name, bp.cached_fee_cents
       FROM booking_participants bp
       WHERE bp.session_id = ${booking.session_id} 
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.cached_fee_cents > 0
    `);

    if (pendingParticipants.rows.length === 0) {
      const unpaidCheck = await db.execute(sql`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) as paid_count,
               SUM(CASE WHEN cached_fee_cents > 0 AND payment_status != 'paid' THEN 1 ELSE 0 END) as unpaid_with_fees
        FROM booking_participants
        WHERE session_id = ${booking.session_id}
      `);
      const row = unpaidCheck.rows[0] as { total: string; paid_count: string; unpaid_with_fees: string };
      const totalCount = parseInt(row.total, 10) || 0;
      const paidCount = parseInt(row.paid_count, 10) || 0;
      const unpaidWithFees = parseInt(row.unpaid_with_fees, 10) || 0;
      if (totalCount > 0 && paidCount > 0 && unpaidWithFees === 0) {
        logger.info('[Stripe] All fee-bearing participants already paid (race condition)', { extra: { bookingId, paidCount, totalCount } });
        return res.json({
          paidInFull: true,
          message: 'This booking has already been paid.',
          totalAmount: 0,
          balanceApplied: 0,
          remainingAmount: 0,
          participantFees: [],
        });
      }
      return res.status(400).json({ error: 'No unpaid fees found' });
    }

    const typedParticipants = pendingParticipants.rows as unknown as ParticipantRow[];
    const participantIds = typedParticipants.map(r => r.id);

    const pendingFees = breakdown.participants.filter(p => 
      p.participantId && participantIds.includes(p.participantId) && p.totalCents > 0
    );

    if (pendingFees.length === 0) {
      return res.status(400).json({ error: 'No fees to charge' });
    }

    const serverTotal = pendingFees.reduce((sum, p) => sum + p.totalCents, 0);

    if (serverTotal === 0) {
      const zeroFeeParticipantIds = pendingFees.map(p => p.participantId!);
      await db.transaction(async (tx) => {
        if (zeroFeeParticipantIds.length > 0) {
          await tx.execute(sql`
            UPDATE booking_participants 
             SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW(), cached_fee_cents = 0
             WHERE id = ANY(${toIntArrayLiteral(zeroFeeParticipantIds)}::int[])
          `);
        }
      });
      logger.info('[Stripe] $0 fee booking — bypassed Stripe, marked participants as paid', { extra: { bookingId, participantCount: zeroFeeParticipantIds.length } });
      
      sendNotificationToUser(booking.user_email, {
        type: 'billing_update',
        title: 'Booking Confirmed',
        message: 'Your booking fees have been resolved — no payment required.',
        data: { bookingId, status: 'paid' }
      });
      broadcastBillingUpdate({ memberEmail: booking.user_email, action: 'payment_confirmed', bookingId, status: 'paid' });
      broadcastBookingInvoiceUpdate({ bookingId, action: 'payment_confirmed' });
      
      return res.json({
        paidInFull: true,
        totalAmount: 0,
        balanceApplied: 0,
        remainingAmount: 0,
        participantFees: pendingFees.map(f => ({
          id: f.participantId,
          displayName: f.displayName,
          amount: 0
        }))
      });
    }

    if (serverTotal < 50) {
      return res.status(400).json({ error: 'Total amount must be at least $0.50' });
    }

    const serverFees = pendingFees.map(p => ({ id: p.participantId!, amountCents: p.totalCents }));

    const trackmanId = booking.trackman_booking_id;
    const memberName = [booking.first_name, booking.last_name].filter(Boolean).join(' ') || booking.user_name || booking.user_email.split('@')[0];
    let resolvedUserId = booking.user_id;
    if (!resolvedUserId) {
      const resolved = await resolveUserByEmail(booking.user_email);
      resolvedUserId = resolved?.userId || booking.user_email;
    }
    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      resolvedUserId,
      booking.user_email,
      memberName
    );

    const existingInvoiceResult = await handleExistingInvoicePayment({
      bookingId,
      sessionId: booking.session_id,
      bookingEmail: booking.user_email,
      serverFees,
      serverTotal,
      pendingFees: pendingFees.map(f => ({
        participantId: f.participantId ?? null,
        displayName: f.displayName,
        totalCents: f.totalCents,
        overageCents: f.overageCents,
        guestCents: f.guestCents,
        participantType: f.participantType,
        minutesAllocated: f.minutesAllocated,
      })),
      resolvedUserId,
      stripeCustomerId,
      trackmanId,
    });
    if (existingInvoiceResult) {
      return res.json(existingInvoiceResult);
    }

    const feeLineItems: BookingFeeLineItem[] = [];
    for (const p of typedParticipants) {
      const fee = pendingFees.find(f => f.participantId === p.id);
      if (!fee || fee.totalCents <= 0) continue;
      const isGuest = p.participant_type === 'guest';
      feeLineItems.push({
        participantId: p.id,
        displayName: p.display_name || (isGuest ? 'Guest' : 'Member'),
        participantType: p.participant_type as 'owner' | 'member' | 'guest',
        overageCents: isGuest ? 0 : fee.totalCents,
        guestCents: isGuest ? fee.totalCents : 0,
        totalCents: fee.totalCents,
      });
    }

    const snapshotResult = await db.execute(sql`
      INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
       VALUES (${bookingId}, ${booking.session_id}, ${JSON.stringify(serverFees)}, ${serverTotal}, 'pending') RETURNING id
    `);
    const snapshotId = (snapshotResult.rows[0] as unknown as IdRow).id;

    const draftResult = await createDraftInvoiceForBooking({
      customerId: stripeCustomerId,
      bookingId,
      sessionId: booking.session_id,
      trackmanBookingId: trackmanId || null,
      feeLineItems,
      metadata: {
        feeSnapshotId: snapshotId.toString(),
        participantCount: serverFees.length.toString(),
        participantIds: serverFees.map(f => f.id).join(',').substring(0, 490),
        memberPayment: 'true',
      },
      purpose: 'booking_fee',
    });

    const participantFeesList = pendingFees.map(f => {
      const participant = typedParticipants.find(p => p.id === f.participantId);
      const pType = participant?.participant_type as 'owner' | 'member' | 'guest' | undefined;
      const isGuest = pType === 'guest';
      const overageCents = 'overageCents' in f ? (f as { overageCents: number }).overageCents : 0;
      const guestCents = 'guestCents' in f ? (f as { guestCents: number }).guestCents : 0;

      const { feeType, feeDescription } = describeFee(isGuest, overageCents, guestCents);

      return {
        id: f.participantId,
        displayName: participant?.display_name || (isGuest ? 'Guest' : 'Member'),
        amount: f.totalCents / 100,
        feeType,
        feeDescription,
        participantType: pType || 'member',
      };
    });

    const { getStripeClient } = await import('../../../core/stripe/client');
    const stripe = await getStripeClient();

    await stripe.invoices.update(draftResult.invoiceId, {
      collection_method: 'charge_automatically',
    });

    const newPiResult = await finalizeInvoiceWithPi(stripe, draftResult.invoiceId);

    if (newPiResult.paidInFull) {
      const paidParticipantIds = pendingFees.map(f => f.participantId!).filter(Boolean);
      if (paidParticipantIds.length > 0) {
        await db.execute(sql`
          UPDATE booking_participants
           SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW()
           WHERE id = ANY(${toIntArrayLiteral(paidParticipantIds)}::int[])
        `);
      }
      await db.execute(sql`
        UPDATE booking_fee_snapshots SET status = 'completed', used_at = NOW() WHERE id = ${snapshotId}
      `);
      logger.info('[Stripe] New invoice auto-paid after finalization', { extra: { bookingId, invoiceId: draftResult.invoiceId } });
      await logPaymentAudit({
        bookingId,
        sessionId: booking.session_id,
        action: 'payment_confirmed',
        staffEmail: 'system',
        amountAffected: serverTotal / 100,
        paymentMethod: 'account_credit',
        metadata: { invoiceId: draftResult.invoiceId, trigger: 'auto_pay_new_invoice' },
      });
      return res.json({
        paidInFull: true,
        invoiceId: draftResult.invoiceId,
        paymentIntentId: '',
        totalAmount: serverTotal / 100,
        balanceApplied: serverTotal / 100,
        remainingAmount: 0,
        participantFees: participantFeesList,
      });
    }

    const invoicePiId = newPiResult.piId;
    let invoicePiSecret = newPiResult.clientSecret;
    if (!invoicePiSecret?.startsWith('pi_')) {
      logger.warn('[Stripe] New invoice finalization returned non-standard client_secret, attempting direct PI retrieve', {
        extra: { bookingId, invoiceId: draftResult.invoiceId, piId: invoicePiId }
      });
      const directPi = await stripe.paymentIntents.retrieve(invoicePiId);
      if (directPi.client_secret) {
        invoicePiSecret = directPi.client_secret;
      }
    }
    logger.info('[Stripe] Finalized new invoice as charge_automatically for interactive member payment', { extra: { bookingId, invoiceId: draftResult.invoiceId, paymentIntentId: invoicePiId } });

    try {
      await stripe.paymentIntents.update(invoicePiId, {
        setup_future_usage: 'off_session',
      });
    } catch (sfuErr: unknown) {
      logger.warn('[Stripe] Could not set setup_future_usage on invoice PI', {
        extra: { bookingId, piId: invoicePiId, error: getErrorMessage(sfuErr) }
      });
    }

    await db.execute(sql`
      UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${invoicePiId}, status = 'pending' WHERE id = ${snapshotId}
    `);
    const newPiDescription = await buildInvoiceDescription(bookingId, trackmanId);

    await db.execute(sql`
      INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES (${resolvedUserId || booking.user_email}, ${invoicePiId}, ${stripeCustomerId},
       ${serverTotal}, ${'booking_fee'}, ${bookingId}, ${booking.session_id},
       ${newPiDescription}, 'pending')
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `);

    let customerSessionSecret: string | undefined;
    try {
      const customerSession = await stripe.customerSessions.create({
        customer: stripeCustomerId,
        components: {
          payment_element: {
            enabled: true,
            features: {
              payment_method_redisplay: 'enabled',
              payment_method_save: 'enabled',
              payment_method_remove: 'enabled',
            },
          },
        },
      });
      customerSessionSecret = customerSession.client_secret;
    } catch (csErr: unknown) {
      logger.warn('[Stripe] Failed to create customer session for saved cards', {
        extra: { bookingId, error: getErrorMessage(csErr) }
      });
    }

    res.json({
      paidInFull: false,
      clientSecret: invoicePiSecret,
      paymentIntentId: invoicePiId,
      invoiceId: draftResult.invoiceId,
      totalAmount: serverTotal / 100,
      balanceApplied: 0,
      remainingAmount: serverTotal / 100,
      participantFees: participantFeesList,
      description: newPiDescription,
      customerSessionClientSecret: customerSessionSecret,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const stripeCode = (error as { code?: string })?.code;
    const stripeType = (error as { type?: string })?.type;
    const stripeDeclineCode = (error as { decline_code?: string })?.decline_code;
    const bookingIdForLog = parseInt(req.params.id as string, 10);
    if (isNaN(bookingIdForLog)) return res.status(400).json({ error: 'Invalid booking IDForLog' });
    logger.error('[Stripe] Error creating member payment intent', { 
      error: error instanceof Error ? error : new Error(String(error)),
      extra: {
        stripeCode,
        stripeType,
        stripeDeclineCode,
        message: errMsg,
        bookingId: isNaN(bookingIdForLog) ? req.params.id : bookingIdForLog,
        endpoint: 'pay-fees',
      }
    });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create member payment intent');
    const friendlyMessage = getStripeDeclineMessage(error);
    const statusCode = friendlyMessage ? 402 : 500;
    res.status(statusCode).json({ 
      error: friendlyMessage || 'Payment processing failed. Please try again.',
      retryable: !friendlyMessage,
    });
  }
});

router.post('/api/member/bookings/:id/confirm-payment', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const bookingResult = await db.execute(sql`
      SELECT br.id, br.session_id, br.user_email, br.user_name
       FROM booking_requests br
       WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as unknown as BookingRow;

    if (booking.user_email?.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Only the booking owner can confirm payment' });
    }

    const snapshotResult = await db.execute(sql`
      SELECT id, participant_fees, status
       FROM booking_fee_snapshots
       WHERE booking_id = ${bookingId} AND stripe_payment_intent_id = ${paymentIntentId}
    `);

    if (snapshotResult.rows.length === 0) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    const snapshot = snapshotResult.rows[0] as unknown as SnapshotRow;

    if (snapshot.status === 'completed') {
      return res.json({ success: true, message: 'Payment already confirmed' });
    }

    const currentFees = await computeFeeBreakdown({ sessionId: booking.session_id!, source: 'stripe' as const });
    let snapshotFees: unknown;
    try {
      snapshotFees = typeof snapshot.participant_fees === 'string' ? JSON.parse(snapshot.participant_fees) : snapshot.participant_fees;
    } catch {
      snapshotFees = null;
    }
    const snapshotTotal = Array.isArray(snapshotFees) 
      ? snapshotFees.reduce((sum: number, f: Record<string, unknown>) => sum + ((f.amountCents as number) || 0), 0)
      : 0;
    const currentTotal = currentFees.totals.totalCents;

    if (Math.abs(currentTotal - snapshotTotal) > 100) {
      logger.warn('[Stripe] Fee drift detected during confirm-payment — proceeding since Stripe already charged', {
        extra: { bookingId, snapshotTotal, currentTotal, difference: currentTotal - snapshotTotal, paymentIntentId }
      });
      try {
        await db.execute(sql`
          UPDATE booking_sessions SET needs_review = true, review_reason = ${`Fee drift: snapshot ${snapshotTotal} cents vs current ${currentTotal} cents (diff: ${currentTotal - snapshotTotal}). Payment ${paymentIntentId} already succeeded.`} WHERE id = ${booking.session_id}
        `);
      } catch (flagErr: unknown) {
        logger.error('[Stripe] Failed to flag session for review after fee drift', { extra: { error: getErrorMessage(flagErr) } });
      }
    }

    const confirmResult = await confirmPaymentSuccess(
      paymentIntentId,
      sessionEmail,
      booking.user_name || 'Member'
    );

    if (!confirmResult.success) {
      return res.status(400).json({ error: confirmResult.error || 'Payment verification failed' });
    }

    let participantFees: Array<{ id: number; amountCents?: number }> = [];
    try {
      participantFees = JSON.parse(typeof snapshot.participant_fees === 'string' ? snapshot.participant_fees : '[]');
    } catch (parseErr: unknown) {
      logger.error('[MemberPayments] Failed to parse participant_fees for snapshot', { extra: { snapshot_id: snapshot.id, parseErr: getErrorMessage(parseErr) } });
    }
    const participantIdsToUpdate = participantFees.map((pf) => pf.id);

    try {
      await db.transaction(async (tx) => {
        if (participantIdsToUpdate.length > 0) {
          await tx.execute(sql`
            UPDATE booking_participants 
             SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW(), stripe_payment_intent_id = ${paymentIntentId}, cached_fee_cents = 0
             WHERE id = ANY(${toIntArrayLiteral(participantIdsToUpdate)}::int[])
          `);
        }

        await tx.execute(sql`
          UPDATE booking_fee_snapshots SET status = 'completed' WHERE id = ${snapshot.id}
        `);
      });

      logger.info('[Stripe] Member payment confirmed for booking , participants marked as paid (transaction committed)', { extra: { bookingId, participantIdsLength: participantIdsToUpdate.length } });

      try {
        const invoiceIdResult = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} AND stripe_invoice_id IS NOT NULL LIMIT 1`);
        const invoiceId = (invoiceIdResult.rows[0] as Record<string, unknown> | undefined)?.stripe_invoice_id as string | undefined;
        if (invoiceId) {
          const { getStripeClient } = await import('../../../core/stripe/client');
          const stripe = await getStripeClient();
          const inv = await stripe.invoices.retrieve(invoiceId);
          if (inv.status === 'paid') {
            logger.info('[Stripe] Invoice paid via its own PI', { extra: { bookingId, invoiceId } });
          } else {
            logger.info('[Stripe] Invoice not yet marked paid — Stripe will settle automatically when PI webhook arrives', { extra: { bookingId, invoiceId, paymentIntentId, invoiceStatus: inv.status } });
          }
        }
      } catch (invoiceCheckErr: unknown) {
        logger.warn('[Stripe] Non-blocking: Failed to check invoice status after confirm-payment', { extra: { bookingId, error: getErrorMessage(invoiceCheckErr) } });
      }

      sendNotificationToUser(sessionEmail, {
        type: 'billing_update',
        title: 'Payment Successful',
        message: 'Your payment has been processed successfully.',
        data: { bookingId, status: 'paid' }
      });
      
      broadcastBillingUpdate({
        memberEmail: sessionEmail,
        action: 'payment_confirmed',
        bookingId,
        status: 'paid'
      });

      broadcastBookingInvoiceUpdate({
        bookingId,
        action: 'payment_confirmed',
      });
    } catch (txError: unknown) {
      logger.error('[Stripe] Transaction rolled back for member payment confirmation', { extra: { txError } });
      throw txError;
    }

    res.json({ success: true });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const stripeCode = (error as { code?: string })?.code;
    const stripeType = (error as { type?: string })?.type;
    const stripeDeclineCode = (error as { decline_code?: string })?.decline_code;
    const bookingIdForLog = parseInt(req.params.id as string, 10);
    if (isNaN(bookingIdForLog)) return res.status(400).json({ error: 'Invalid booking IDForLog' });
    logger.error('[Stripe] Error confirming member payment', {
      error: error instanceof Error ? error : new Error(String(error)),
      extra: {
        stripeCode,
        stripeType,
        stripeDeclineCode,
        message: errMsg,
        bookingId: isNaN(bookingIdForLog) ? req.params.id : bookingIdForLog,
        paymentIntentId: req.body?.paymentIntentId,
        endpoint: 'confirm-payment',
      }
    });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm member payment');
    const friendlyMessage = getStripeDeclineMessage(error);
    const statusCode = friendlyMessage ? 402 : 500;
    res.status(statusCode).json({ 
      error: friendlyMessage || 'Payment confirmation failed. Please try again.',
      retryable: !friendlyMessage,
    });
  }
});

router.post('/api/member/bookings/:bookingId/cancel-payment', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.bookingId as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    const { paymentIntentId } = req.body;

    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const verification = await db.execute(sql`
      SELECT spi.id FROM stripe_payment_intents spi
       JOIN booking_requests br ON spi.booking_id = br.id
       WHERE spi.stripe_payment_intent_id = ${paymentIntentId} 
       AND spi.booking_id = ${bookingId}
       AND br.user_email = ${sessionUser.email.toLowerCase()}
       AND spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')
    `);

    if (verification.rows.length === 0) {
      return res.status(404).json({ error: 'Payment intent not found or already processed' });
    }

    const { cancelPaymentIntent } = await import('../../../core/stripe');
    const result = await cancelPaymentIntent(paymentIntentId);

    if (result.success) {
      logger.info('[Member Payment] User cancelled abandoned PI for booking', { extra: { sessionUserEmail: sessionUser.email, paymentIntentId, bookingId } });

      try {
        const { voidBookingInvoice, recreateDraftInvoiceFromBooking } = await import('../../../core/billing/bookingInvoiceService');
        await voidBookingInvoice(bookingId);
        await recreateDraftInvoiceFromBooking(bookingId);
        logger.info('[Member Payment] Voided invoice and re-created draft after abandoned payment', { extra: { bookingId } });
      } catch (invoiceErr: unknown) {
        logger.warn('[Member Payment] Failed to void/recreate invoice after payment cancellation', { extra: { bookingId, error: String(invoiceErr) } });
      }
    }

    res.json({ success: result.success });
  } catch (error: unknown) {
    logger.error('[Member Payment] Error cancelling payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ success: false, error: 'Failed to cancel payment' });
  }
});

export default router;
