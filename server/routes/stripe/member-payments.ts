import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../core/middleware';
import { paymentRateLimiter } from '../../middleware/rateLimiting';
import { pool } from '../../core/db';
import { db } from '../../db';
import { membershipTiers } from '../../../shared/schema';
import { ilike } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import {
  createPaymentIntent,
  confirmPaymentSuccess,
  getOrCreateStripeCustomer,
  getInvoice,
  createBalanceAwarePayment,
  type BookingFeeLineItem,
} from '../../core/stripe';
import { resolveUserByEmail } from '../../core/stripe/customers';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants } from '../../core/billing/unifiedFeeService';
import { GUEST_FEE_CENTS } from './helpers';
import { sendNotificationToUser, broadcastBillingUpdate } from '../../core/websocket';
import { alertOnExternalServiceError } from '../../core/errorAlerts';
import { getErrorCode, getErrorMessage } from '../../utils/errorUtils';
import { getBookingInvoiceId, finalizeAndPayInvoice, createDraftInvoiceForBooking } from '../../core/billing/bookingInvoiceService';

const router = Router();

router.post('/api/member/bookings/:id/pay-fees', isAuthenticated, paymentRateLimiter, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const bookingResult = await pool.query(
      `SELECT br.id, br.session_id, br.user_email, br.user_name, br.status, br.trackman_booking_id, u.id as user_id, u.first_name, u.last_name
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.status === 'cancelled' || booking.status === 'cancellation_pending' || booking.status === 'declined') {
      return res.status(400).json({ error: 'Cannot pay for a cancelled or declined booking' });
    }

    if (booking.user_email?.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Only the booking owner can pay fees' });
    }

    if (!booking.session_id) {
      return res.status(400).json({ error: 'Booking has no session' });
    }

    // Get all pending participants (guests, members, and owner for overage fees)
    // The payment_status filter ensures we only see unpaid fees - no snapshot filtering needed
    const pendingParticipants = await pool.query(
      `SELECT bp.id, bp.participant_type, bp.display_name, bp.cached_fee_cents
       FROM booking_participants bp
       WHERE bp.session_id = $1 
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.cached_fee_cents > 0`,
      [booking.session_id]
    );

    if (pendingParticipants.rows.length === 0) {
      return res.status(400).json({ error: 'No unpaid fees found' });
    }

    const participantIds = pendingParticipants.rows.map(r => r.id);
    
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

    const pendingFees = breakdown.participants.filter(p => 
      p.participantId && participantIds.includes(p.participantId) && p.totalCents > 0
    );

    if (pendingFees.length === 0) {
      return res.status(400).json({ error: 'No fees to charge' });
    }

    const serverTotal = pendingFees.reduce((sum, p) => sum + p.totalCents, 0);

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

    // Check if booking already has a draft invoice
    const existingInvoiceId = await getBookingInvoiceId(bookingId);
    
    if (existingInvoiceId) {
      // Finalize and pay the existing draft invoice
      try {
        const invoiceResult = await finalizeAndPayInvoice({ bookingId });
        
        // Create snapshot for tracking
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const snapshotResult = await client.query(
            `INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status, stripe_payment_intent_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [bookingId, booking.session_id, JSON.stringify(serverFees), serverTotal, 
             invoiceResult.paidInFull ? 'completed' : 'pending', invoiceResult.paymentIntentId]
          );
          await client.query('COMMIT');
          
          if (invoiceResult.paymentIntentId && !invoiceResult.paidInFull) {
            await pool.query(
              `INSERT INTO stripe_payment_intents 
               (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
              [resolvedUserId || booking.user_email, invoiceResult.paymentIntentId, stripeCustomerId,
               serverTotal, 'booking_fee', bookingId, booking.session_id,
               `Member payment invoice for booking ${trackmanId ? `TM-${trackmanId}` : `#${bookingId}`}`, 'pending']
            );
          }
        } catch (err: unknown) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

        if (invoiceResult.paidInFull) {
          return res.json({
            paidInFull: true,
            invoiceId: invoiceResult.invoiceId,
            paymentIntentId: invoiceResult.paymentIntentId,
            totalAmount: serverTotal / 100,
            balanceApplied: invoiceResult.amountFromBalance / 100,
            remainingAmount: 0,
            participantFees: pendingFees.map(f => ({
              id: f.participantId,
              displayName: f.displayName,
              amount: f.totalCents / 100
            }))
          });
        }

        return res.json({
          paidInFull: false,
          clientSecret: invoiceResult.clientSecret,
          paymentIntentId: invoiceResult.paymentIntentId,
          invoiceId: invoiceResult.invoiceId,
          totalAmount: serverTotal / 100,
          balanceApplied: 0,
          remainingAmount: serverTotal / 100,
          participantFees: pendingFees.map(f => ({
            id: f.participantId,
            displayName: f.displayName,
            amount: f.totalCents / 100
          }))
        });
      } catch (invoiceErr: unknown) {
        logger.warn('[Stripe] Failed to use existing draft invoice, falling back to new invoice', {
          extra: { bookingId, existingInvoiceId, error: getErrorMessage(invoiceErr) }
        });
        // Fall through to legacy flow below
      }
    }

    const feeLineItems: BookingFeeLineItem[] = [];
    for (const p of pendingParticipants.rows) {
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

    const snapshotResult = await pool.query(
      `INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [bookingId, booking.session_id, JSON.stringify(serverFees), serverTotal]
    );
    const snapshotId = snapshotResult.rows[0].id;

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

    const invoiceResult = await finalizeAndPayInvoice({ bookingId });

    await pool.query(
      `UPDATE booking_fee_snapshots SET stripe_payment_intent_id = $1, status = $2 WHERE id = $3`,
      [invoiceResult.paymentIntentId, invoiceResult.paidInFull ? 'completed' : 'pending', snapshotId]
    );

    await pool.query(
      `INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
      [
        resolvedUserId || booking.user_email,
        invoiceResult.paymentIntentId,
        stripeCustomerId,
        serverTotal,
        'booking_fee',
        bookingId,
        booking.session_id,
        `Member payment invoice for booking ${trackmanId ? `TM-${trackmanId}` : `#${bookingId}`}`,
        invoiceResult.paidInFull ? 'succeeded' : 'pending'
      ]
    );

    logger.info('[Stripe] Member invoice payment created for booking', { extra: { bookingId, invoiceId: draftResult.invoiceId, paymentIntentId: invoiceResult.paymentIntentId, totalDollars: (serverTotal / 100).toFixed(2) } });

    const participantFeesList = pendingFees.map(f => {
      const participant = pendingParticipants.rows.find(p => p.id === f.participantId);
      return {
        id: f.participantId,
        displayName: participant?.display_name || 'Guest',
        amount: f.totalCents / 100
      };
    });

    if (invoiceResult.paidInFull) {
      return res.json({
        paidInFull: true,
        invoiceId: invoiceResult.invoiceId,
        paymentIntentId: invoiceResult.paymentIntentId,
        totalAmount: serverTotal / 100,
        balanceApplied: invoiceResult.amountFromBalance / 100,
        remainingAmount: 0,
        participantFees: participantFeesList,
      });
    }

    res.json({
      paidInFull: false,
      clientSecret: invoiceResult.clientSecret,
      paymentIntentId: invoiceResult.paymentIntentId,
      invoiceId: invoiceResult.invoiceId,
      totalAmount: serverTotal / 100,
      balanceApplied: 0,
      remainingAmount: serverTotal / 100,
      participantFees: participantFeesList,
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating member payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'create member payment intent');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
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

    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const bookingResult = await pool.query(
      `SELECT br.id, br.session_id, br.user_email, br.user_name
       FROM booking_requests br
       WHERE br.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.user_email?.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Only the booking owner can confirm payment' });
    }

    const snapshotResult = await pool.query(
      `SELECT id, participant_fees, status
       FROM booking_fee_snapshots
       WHERE booking_id = $1 AND stripe_payment_intent_id = $2`,
      [bookingId, paymentIntentId]
    );

    if (snapshotResult.rows.length === 0) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    const snapshot = snapshotResult.rows[0];

    if (snapshot.status === 'completed') {
      return res.json({ success: true, message: 'Payment already confirmed' });
    }

    // Verify fee snapshot is still valid before charging
    const currentFees = await computeFeeBreakdown({ sessionId: booking.session_id, source: 'stripe' as const });
    const snapshotFees = snapshot.participant_fees;
    const snapshotTotal = Array.isArray(snapshotFees) 
      ? snapshotFees.reduce((sum: number, f: Record<string, unknown>) => sum + ((f.amountCents as number) || 0), 0)
      : 0;
    const currentTotal = currentFees.totals.totalCents;

    if (Math.abs(currentTotal - snapshotTotal) > 100) { // Allow $1 tolerance for rounding
      return res.status(409).json({ 
        error: 'Fee calculation has changed since booking. Please refresh and try again.',
        code: 'FEE_SNAPSHOT_STALE',
        snapshotTotal,
        currentTotal
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const confirmResult = await confirmPaymentSuccess(
        paymentIntentId,
        sessionEmail,
        booking.user_name || 'Member',
        client
      );

      if (!confirmResult.success) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: confirmResult.error || 'Payment verification failed' });
      }

      let participantFees: Array<{ id: number; amountCents?: number }> = [];
      try {
        participantFees = JSON.parse(snapshot.participant_fees || '[]');
      } catch (parseErr: unknown) {
        logger.error('[MemberPayments] Failed to parse participant_fees for snapshot', { extra: { snapshot_id: snapshot.id, data: ':', parseErr } });
      }
      const participantIds = participantFees.map((pf) => pf.id);

      if (participantIds.length > 0) {
        await client.query(
          `UPDATE booking_participants 
           SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
           WHERE id = ANY($1::int[])`,
          [participantIds, paymentIntentId]
        );
      }

      await client.query(
        `UPDATE booking_fee_snapshots SET status = 'completed' WHERE id = $1`,
        [snapshot.id]
      );

      await client.query('COMMIT');
      logger.info('[Stripe] Member payment confirmed for booking , participants marked as paid (transaction committed)', { extra: { bookingId, participantIdsLength: participantIds.length } });
      
      // Notify member and broadcast billing update
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
    } catch (txError: unknown) {
      await client.query('ROLLBACK');
      logger.error('[Stripe] Transaction rolled back for member payment confirmation', { extra: { txError } });
      throw txError;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming member payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'confirm member payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/invoices/:invoiceId/pay', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    if (!invoiceId || !(invoiceId as string).startsWith('in_')) {
      return res.status(400).json({ error: 'Invalid invoice ID' });
    }

    const userResult = await pool.query(
      'SELECT id, stripe_customer_id, first_name, last_name, email FROM users WHERE LOWER(email) = $1',
      [sessionEmail.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const stripeCustomerId = user.stripe_customer_id;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found. Please contact support.' });
    }

    const invoiceResult = await getInvoice(invoiceId as string);

    if (!invoiceResult.success || !invoiceResult.invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.invoice;

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    const stripeInvoice = await stripe.invoices.retrieve(invoiceId as string);

    if (stripeInvoice.customer !== stripeCustomerId) {
      return res.status(403).json({ error: 'You do not have permission to pay this invoice' });
    }

    if (invoice.status !== 'open') {
      if (invoice.status === 'paid') {
        return res.status(400).json({ error: 'This invoice has already been paid' });
      }
      return res.status(400).json({ error: `Cannot pay invoice with status: ${invoice.status}` });
    }

    const amountDue = invoice.amountDue;
    if (amountDue < 50) {
      return res.status(400).json({ error: 'Invoice amount is too small to process' });
    }

    const primaryLine = invoice.lines?.[0];
    const description = primaryLine?.description || invoice.description || `Invoice ${invoiceId}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountDue,
      currency: invoice.currency || 'usd',
      customer: stripeCustomerId,
      metadata: {
        invoice_id: invoiceId as string,
        purpose: 'invoice_payment',
        member_email: sessionEmail,
        source: 'ever_house_member_portal'
      },
      description: `Payment for: ${description}`,
      automatic_payment_methods: {
        enabled: true,
      },
    }, {
      idempotencyKey: `invoice_payment_${invoiceId}_${stripeCustomerId}`
    });

    logger.info('[Stripe] Member invoice payment intent created for : $', { extra: { invoiceId, amountDue_100_ToFixed_2: (amountDue / 100).toFixed(2) } });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      invoiceId: invoiceId,
      amount: amountDue / 100,
      description: description,
      currency: invoice.currency || 'usd'
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating invoice payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'create invoice payment intent');
    res.status(500).json({ 
      error: 'Payment initialization failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/invoices/:invoiceId/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    const { paymentIntentId } = req.body;

    if (!invoiceId || !paymentIntentId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE LOWER(email) = $1',
      [sessionEmail.toLowerCase()]
    );

    const stripeCustomerId = userResult.rows[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded' });
    }

    if (paymentIntent.metadata?.invoice_id !== invoiceId) {
      return res.status(400).json({ error: 'Payment does not match invoice' });
    }

    try {
      const invoice = await stripe.invoices.retrieve(invoiceId);
      const invoicePiId = typeof (invoice as any).payment_intent === 'string'
        ? (invoice as any).payment_intent
        : (invoice as any).payment_intent?.id;
      if (invoicePiId && invoicePiId !== paymentIntentId) {
        try {
          await stripe.paymentIntents.cancel(invoicePiId);
          logger.info('[Stripe] Cancelled invoice-generated PI before OOB reconciliation', { extra: { invoicePiId, invoiceId } });
        } catch (cancelErr: unknown) {
          logger.warn('[Stripe] Could not cancel invoice PI', { extra: { invoicePiId, error: getErrorMessage(cancelErr) } });
        }
      }

      await stripe.invoices.pay(invoiceId, {
        paid_out_of_band: true,
      });

      try {
        await stripe.invoices.update(invoiceId, {
          metadata: {
            ...((invoice.metadata as Record<string, string>) || {}),
            reconciled_by_pi: paymentIntentId,
            reconciliation_source: 'member_payment',
          }
        });
      } catch (_metaErr: unknown) { /* non-blocking */ }

      logger.info('[Stripe] Invoice reconciled with member PI', { extra: { invoiceId, paymentIntentId } });
      
      sendNotificationToUser(sessionEmail, {
        type: 'billing_update',
        title: 'Invoice Paid',
        message: 'Your invoice has been paid successfully.',
        data: { invoiceId, status: 'paid' }
      });
      
      broadcastBillingUpdate({
        memberEmail: sessionEmail,
        action: 'invoice_paid',
        status: 'paid'
      });
    } catch (payErr: unknown) {
      if (getErrorCode(payErr) === 'invoice_already_paid') {
        logger.info('[Stripe] Invoice was already marked as paid', { extra: { invoiceId } });
      } else {
        logger.error('[Stripe] Error marking invoice as paid', { extra: { payErr } });
      }
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming invoice payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'confirm invoice payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/guest-passes/purchase', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { quantity } = req.body;

    if (!quantity || ![1, 3, 5].includes(quantity)) {
      return res.status(400).json({ error: 'Invalid quantity. Must be 1, 3, or 5.' });
    }

    const passProduct = await db.query.membershipTiers.findFirst({
      where: ilike(membershipTiers.name, '%Guest Pass%')
    });

    if (!passProduct || !passProduct.stripePriceId || !passProduct.priceCents) {
      return res.status(500).json({
        error: 'Guest Pass product is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.'
      });
    }

    const unitPriceCents = passProduct.priceCents;
    const amountCents = unitPriceCents * quantity;

    const userResult = await pool.query(
      'SELECT id, stripe_customer_id, first_name, last_name FROM users WHERE LOWER(email) = $1',
      [sessionEmail.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || sessionEmail.split('@')[0];

    let stripeCustomerId = user.stripe_customer_id;
    if (!stripeCustomerId) {
      const customerResult = await getOrCreateStripeCustomer(user.id, sessionEmail, memberName);
      stripeCustomerId = customerResult.customerId;
    }

    const description = `${quantity} Guest Pass${quantity > 1 ? 'es' : ''} - Ever Club`;

    const result = await createBalanceAwarePayment({
      stripeCustomerId,
      userId: user.id?.toString() || sessionEmail,
      email: sessionEmail,
      memberName,
      amountCents,
      purpose: 'one_time_purchase',
      description,
      metadata: {
        guestPassPurchase: 'true',
        quantity: quantity.toString(),
        priceId: passProduct.stripePriceId,
        member_email: sessionEmail,
        source: 'ever_house_member_portal'
      }
    });

    if (result.error) {
      throw new Error(result.error);
    }

    logger.info('[Stripe] Guest pass purchase for : passes, $ (balance: $)', { extra: { sessionEmail, quantity, amountCents_100_ToFixed_2: (amountCents / 100).toFixed(2), resultBalanceApplied_100_ToFixed_2: (result.balanceApplied / 100).toFixed(2) } });

    if (result.paidInFull) {
      const existingPass = await pool.query(
        'SELECT id, passes_total FROM guest_passes WHERE LOWER(member_email) = LOWER($1)',
        [sessionEmail]
      );

      if (existingPass.rows.length > 0) {
        await pool.query(
          'UPDATE guest_passes SET passes_total = passes_total + $1 WHERE LOWER(member_email) = LOWER($2)',
          [quantity, sessionEmail]
        );
        logger.info('[Stripe] Added guest passes to existing record for (paid by credit)', { extra: { quantity, sessionEmail } });
      } else {
        await pool.query(
          'INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES ($1, 0, $2)',
          [sessionEmail, quantity]
        );
        logger.info('[Stripe] Created new guest pass record with passes for (paid by credit)', { extra: { quantity, sessionEmail } });
      }

      return res.json({
        paidInFull: true,
        quantity,
        amountCents,
        balanceApplied: result.balanceApplied
      });
    }

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      quantity,
      amountCents,
      paidInFull: false,
      balanceApplied: result.balanceApplied,
      remainingCents: result.remainingCents
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating guest pass payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'create guest pass payment intent');
    res.status(500).json({ 
      error: 'Payment initialization failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/guest-passes/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { paymentIntentId, quantity } = req.body;

    if (!paymentIntentId || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (![1, 3, 5].includes(quantity)) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded' });
    }

    if (paymentIntent.metadata?.purpose !== 'one_time_purchase' || paymentIntent.metadata?.guestPassPurchase !== 'true') {
      return res.status(400).json({ error: 'Invalid payment type' });
    }

    const paymentQuantity = parseInt(paymentIntent.metadata?.quantity || '0');
    if (paymentQuantity !== quantity) {
      return res.status(400).json({ error: 'Quantity mismatch' });
    }

    const passProduct = await db.query.membershipTiers.findFirst({
      where: ilike(membershipTiers.name, '%Guest Pass%')
    });

    if (!passProduct || !passProduct.stripePriceId || !passProduct.priceCents) {
      return res.status(500).json({
        error: 'Guest Pass product is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.'
      });
    }

    const expectedAmount = passProduct.priceCents * quantity;
    const creditApplied = parseInt(paymentIntent.metadata?.creditToConsume || '0');
    const expectedChargeAmount = expectedAmount - creditApplied;
    if (paymentIntent.amount !== expectedChargeAmount && paymentIntent.amount !== expectedAmount) {
      logger.error('[Stripe] Amount mismatch for guest pass purchase: expected (or after credit), got', { extra: { expectedAmount, expectedChargeAmount, paymentIntentAmount: paymentIntent.amount } });
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    const existingPass = await pool.query(
      'SELECT id, passes_total FROM guest_passes WHERE LOWER(member_email) = LOWER($1)',
      [sessionEmail]
    );

    if (existingPass.rows.length > 0) {
      await pool.query(
        'UPDATE guest_passes SET passes_total = passes_total + $1 WHERE LOWER(member_email) = LOWER($2)',
        [quantity, sessionEmail]
      );
      logger.info('[Stripe] Added guest passes to existing record for', { extra: { quantity, sessionEmail } });
    } else {
      await pool.query(
        'INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES ($1, 0, $2)',
        [sessionEmail, quantity]
      );
      logger.info('[Stripe] Created new guest pass record with passes for', { extra: { quantity, sessionEmail } });
    }

    res.json({ success: true, passesAdded: quantity });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming guest pass purchase', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'confirm guest pass purchase');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.get('/api/member/balance', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const queryEmail = req.query.email as string | undefined;
    // Allow staff and admins to view another member's balance (for View As mode)
    const canViewOthers = sessionUser.isStaff || sessionUser.role === 'admin';
    if (queryEmail && canViewOthers) {
      memberEmail = queryEmail.toLowerCase();
    }

    // Only show fees where there's a pending fee snapshot OR no snapshot at all (legacy)
    // Exclude sessions where all snapshots are cancelled/paid (orphaned cached_fee_cents)
    const result = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.participant_type,
        bp.display_name,
        bp.payment_status,
        bp.cached_fee_cents,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
       WHERE LOWER(pu.email) = $1
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
       ORDER BY bs.session_date DESC, bs.start_time DESC`,
      [memberEmail]
    );

    const guestResult = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.participant_type,
        bp.display_name,
        bp.payment_status,
        bp.cached_fee_cents,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        owner_u.email as owner_email,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       JOIN users owner_u ON owner_u.id = owner_bp.user_id
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_u.email) = $1
         AND bp.cached_fee_cents > 0
       ORDER BY bs.session_date DESC, bs.start_time DESC`,
      [memberEmail]
    );

    const breakdown: Array<{
      id: number;
      sessionId: number;
      type: 'overage' | 'guest';
      description: string;
      date: string;
      amountCents: number;
    }> = [];

    for (const row of result.rows) {
      // Include fee if participant has cached_fee_cents OR ledger_fee
      // The payment_status filter already ensures we only see unpaid fees
      let amountCents = 0;
      
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      
      if (amountCents > 0) {
        const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        breakdown.push({
          id: row.participant_id,
          sessionId: row.session_id,
          type: 'overage',
          description: `${row.resource_name || 'Booking'} - ${dateStr}`,
          date: row.session_date,
          amountCents
        });
      }
    }

    for (const row of guestResult.rows) {
      // Include all guest fees with cached_fee_cents > 0
      const amountCents = row.cached_fee_cents || GUEST_FEE_CENTS;
      const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      breakdown.push({
        id: row.participant_id,
        sessionId: row.session_id,
        type: 'guest',
        description: `Guest: ${row.display_name} - ${dateStr}`,
        date: row.session_date,
        amountCents
      });
    }

    // On-the-fly fee computation for uncached sessions
    const existingSessionIds = new Set(breakdown.map(b => b.sessionId));
    try {
      const uncachedResult = await pool.query(
        `SELECT DISTINCT bs.id as session_id
         FROM booking_participants bp
         JOIN booking_sessions bs ON bs.id = bp.session_id
         JOIN users pu ON pu.id = bp.user_id
         WHERE LOWER(pu.email) = $1
           AND bp.participant_type = 'owner'
           AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
           AND COALESCE(bp.cached_fee_cents, 0) = 0
           AND bs.session_date >= CURRENT_DATE - INTERVAL '90 days'
         LIMIT 20`,
        [memberEmail]
      );

      const uncachedSessions = uncachedResult.rows
        .map(r => r.session_id as number)
        .filter(sid => !existingSessionIds.has(sid));

      if (uncachedSessions.length > 0) {
        logger.info('[Member Balance] Computing fees on-the-fly for sessions', { extra: { uncachedSessionsLength: uncachedSessions.length } });

        const allCacheUpdates: Array<{ id: number; cents: number }> = [];

        for (const sessionId of uncachedSessions) {
          try {
            const feeResult = await computeFeeBreakdown({ sessionId, source: 'stripe' as const });

            for (const p of feeResult.participants) {
              if (p.totalCents > 0 && p.participantId) {
                const sessionDataResult = await pool.query(
                  `SELECT bs.session_date, r.name as resource_name, bp.participant_type, bp.display_name
                   FROM booking_sessions bs
                   LEFT JOIN resources r ON r.id = bs.resource_id
                   LEFT JOIN booking_participants bp ON bp.id = $1
                   WHERE bs.id = $2`,
                  [p.participantId, sessionId]
                );
                const sData = sessionDataResult.rows[0];
                const dateStr = sData?.session_date ? new Date(sData.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

                const isGuest = sData?.participant_type === 'guest';
                breakdown.push({
                  id: p.participantId,
                  sessionId,
                  type: isGuest ? 'guest' : 'overage',
                  description: isGuest
                    ? `Guest: ${sData?.display_name || 'Guest'} - ${dateStr}`
                    : `${sData?.resource_name || 'Booking'} - ${dateStr}`,
                  date: sData?.session_date,
                  amountCents: p.totalCents
                });

                allCacheUpdates.push({ id: p.participantId, cents: p.totalCents });
              }
            }
          } catch (sessionErr: unknown) {
            logger.error('[Member Balance] Failed to compute fees for session', { extra: { sessionId, sessionErr } });
          }
        }

        if (allCacheUpdates.length > 0) {
          try {
            const ids = allCacheUpdates.map(u => u.id);
            const cents = allCacheUpdates.map(u => u.cents);
            await pool.query(
              `UPDATE booking_participants bp
               SET cached_fee_cents = updates.cents
               FROM (SELECT UNNEST($1::int[]) as id, UNNEST($2::int[]) as cents) as updates
               WHERE bp.id = updates.id`,
              [ids, cents]
            );
          } catch (cacheErr: unknown) {
            logger.error('[Member Balance] Failed to write-through cache', { extra: { cacheErr } });
          }
        }
      }
    } catch (uncachedErr: unknown) {
      logger.error('[Member Balance] Error computing on-the-fly fees', { extra: { uncachedErr } });
    }

    const unfilledResult = await pool.query(
      `SELECT 
        bs.id as session_id,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        COALESCE(br.declared_player_count, 1) as declared_player_count,
        (SELECT COUNT(*) FROM booking_participants bp2 
         WHERE bp2.session_id = bs.id 
           AND bp2.participant_type != 'owner'
           AND bp2.payment_status IS NOT NULL) as non_owner_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN booking_requests br ON br.session_id = bs.id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       WHERE LOWER(pu.email) = $1
         AND bp.participant_type = 'owner'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND COALESCE(br.declared_player_count, 1) > 1
         AND (bs.session_date AT TIME ZONE 'America/Los_Angeles')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
       GROUP BY bs.id, bs.session_date, bs.start_time, bs.end_time, r.name, br.declared_player_count, bp.user_id`,
      [memberEmail]
    );

    for (const row of unfilledResult.rows) {
      const declaredCount = parseInt(row.declared_player_count, 10) || 1;
      const nonOwnerCount = parseInt(row.non_owner_count, 10) || 0;
      const unfilledSlots = Math.max(0, declaredCount - 1 - nonOwnerCount);
      
      if (unfilledSlots > 0) {
        const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        for (let i = 0; i < unfilledSlots; i++) {
          breakdown.push({
            id: -row.session_id * 1000 - i,
            sessionId: row.session_id,
            type: 'guest',
            description: `Guest fee (unfilled) - ${dateStr}`,
            date: row.session_date,
            amountCents: GUEST_FEE_CENTS
          });
        }
      }
    }

    const totalCents = breakdown.reduce((sum, item) => sum + item.amountCents, 0);

    res.json({
      totalCents,
      totalDollars: totalCents / 100,
      itemCount: breakdown.length,
      breakdown
    });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error getting balance', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

router.post('/api/member/balance/pay', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const requestEmail = req.body?.memberEmail as string | undefined;
    // Allow staff and admins to pay on behalf of another member (for View As mode)
    const canActForOthers = sessionUser.isStaff || sessionUser.role === 'admin';
    if (requestEmail && canActForOthers) {
      memberEmail = requestEmail.toLowerCase();
    }
    const applyCredit = req.body?.applyCredit !== false; // Default to true
    
    // Use email as the primary identifier for Stripe customer
    const memberName = memberEmail;

    // Only include fees where there's a pending fee snapshot OR no snapshot at all (legacy)
    const result = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
       WHERE LOWER(pu.email) = $1
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')`,
      [memberEmail]
    );

    const guestResult = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       JOIN users owner_u ON owner_u.id = owner_bp.user_id
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_u.email) = $1
         AND bp.cached_fee_cents > 0`,
      [memberEmail]
    );

    const participantFees: Array<{id: number; amountCents: number}> = [];

    for (const row of result.rows) {
      // Include all pending fees - the payment_status filter already ensures we only see unpaid fees
      let amountCents = 0;
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      if (amountCents > 0) {
        participantFees.push({ id: row.participant_id, amountCents });
      }
    }

    for (const row of guestResult.rows) {
      // Include all guest fees with cached_fee_cents > 0
      const amountCents = row.cached_fee_cents || GUEST_FEE_CENTS;
      participantFees.push({ id: row.participant_id, amountCents });
    }

    const totalCents = participantFees.reduce((sum, f) => sum + f.amountCents, 0);

    if (totalCents < 50) {
      return res.status(400).json({ error: 'No outstanding balance to pay or amount too small' });
    }

    const client = await pool.connect();
    let snapshotId: number | null = null;
    let existingPaymentIntentId: string | null = null;

    try {
      await client.query('BEGIN');
      
      // Check for existing pending snapshot (balance payment snapshots have null booking_id and session_id)
      const existingSnapshot = await client.query(
        `SELECT id, stripe_payment_intent_id, total_cents, participant_fees
         FROM booking_fee_snapshots 
         WHERE booking_id IS NULL AND session_id IS NULL AND status = 'pending' 
         AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at DESC
         LIMIT 1`,
        []
      );
      
      if (existingSnapshot.rows.length > 0) {
        const existing = existingSnapshot.rows[0];
        const existingFees = existing.participant_fees || {};
        const existingApplyCredit = existingFees.applyCredit !== false;
        const existingParticipantIds = (existingFees.fees || []).map((p: Record<string, unknown>) => p.id).sort().join(',');
        const newParticipantIds = participantFees.map(p => p.id).sort().join(',');
        const participantsMatch = existingParticipantIds === newParticipantIds;
        
        // Reuse snapshot only if applyCredit setting matches, amounts match, and participants match
        if (existing.stripe_payment_intent_id && 
            existing.total_cents === totalCents && 
            participantsMatch &&
            existingApplyCredit === applyCredit) {
          snapshotId = existing.id;
          existingPaymentIntentId = existing.stripe_payment_intent_id;
          logger.info('[Member Balance] Reusing existing pending snapshot', { extra: { snapshotId } });
        } else {
          // Expire stale snapshot (applyCredit changed or amounts/participants changed)
          await client.query(
            `UPDATE booking_fee_snapshots SET status = 'expired' WHERE id = $1`,
            [existing.id]
          );
          logger.info('[Member Balance] Expiring stale snapshot (applyCredit: -> , amountMatch: , participantsMatch: )', { extra: { existingId: existing.id, existingApplyCredit, applyCredit, existingTotal_cents_totalCents: existing.total_cents === totalCents, participantsMatch } });
        }
      }
      
      if (!snapshotId) {
        // Store applyCredit preference with the fees in the snapshot
        const snapshotData = {
          fees: participantFees,
          applyCredit
        };
        const snapshotResult = await client.query(
          `INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
           VALUES (NULL, NULL, $1, $2, 'pending') RETURNING id`,
          [JSON.stringify(snapshotData), totalCents]
        );
        snapshotId = snapshotResult.rows[0].id;
      }
      
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
    // If we have an existing valid payment intent, return it
    if (existingPaymentIntentId) {
      try {
        const { getStripeClient } = await import('../../core/stripe/client');
        const stripe = await getStripeClient();
        const existingIntent = await stripe.paymentIntents.retrieve(existingPaymentIntentId);
        if (existingIntent.status === 'requires_payment_method' || existingIntent.status === 'requires_confirmation') {
          logger.info('[Member Balance] Returning existing payment intent', { extra: { existingPaymentIntentId } });
          
          // Get customer balance for response
          const customer = await stripe.customers.retrieve((existingIntent.customer as string) || '');
          let availableCredit = 0;
          if (!('deleted' in customer) || !customer.deleted) {
            const customerBalance = ('balance' in customer ? (customer.balance as number) : 0) || 0;
            availableCredit = customerBalance < 0 ? Math.abs(customerBalance) : 0;
          }
          
          return res.json({
            paidInFull: false,
            clientSecret: existingIntent.client_secret,
            paymentIntentId: existingPaymentIntentId,
            totalCents,
            balanceApplied: 0,
            remainingCents: totalCents,
            availableCreditCents: availableCredit,
            itemCount: participantFees.length,
            participantFees,
            creditApplied: false
          });
        }
      } catch (intentError: unknown) {
        logger.info('[Member Balance] Could not reuse intent , creating new one', { extra: { existingPaymentIntentId } });
      }
    }

    // Get or create Stripe customer for balance-aware payment
    const resolvedMember = await resolveUserByEmail(memberEmail);
    const resolvedMemberUserId = resolvedMember?.userId || memberEmail;
    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      resolvedMemberUserId,
      memberEmail,
      memberName
    );

    // Get customer's available credit balance
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    let availableCreditCents = 0;
    if (!('deleted' in customer) || !customer.deleted) {
      const customerBalance = ('balance' in customer ? (customer.balance as number) : 0) || 0;
      availableCreditCents = customerBalance < 0 ? Math.abs(customerBalance) : 0;
    }

    let paymentResult: {
      paidInFull: boolean;
      clientSecret?: string;
      paymentIntentId?: string;
      balanceTransactionId?: string;
      totalCents: number;
      balanceApplied: number;
      remainingCents: number;
      error?: string;
    };

    if (applyCredit && availableCreditCents > 0) {
      // Use balance-aware payment to apply account credits first
      paymentResult = await createBalanceAwarePayment({
        stripeCustomerId,
        userId: memberEmail,
        email: memberEmail,
        memberName,
        amountCents: totalCents,
        purpose: 'overage_fee',
        description: `Outstanding balance payment - ${participantFees.length} item(s)`,
        metadata: {
          feeSnapshotId: snapshotId!.toString(),
          participantCount: participantFees.length.toString(),
          participantIds: participantFees.map(f => f.id).join(',').substring(0, 490),
          balancePayment: 'true'
        }
      });
    } else {
      // Use standard payment without balance application
      const intentResult = await createPaymentIntent({
        userId: memberEmail,
        email: memberEmail,
        memberName,
        amountCents: totalCents,
        purpose: 'overage_fee',
        description: `Outstanding balance payment - ${participantFees.length} item(s)`,
        stripeCustomerId,
        metadata: {
          feeSnapshotId: snapshotId!.toString(),
          participantCount: participantFees.length.toString(),
          participantIds: participantFees.map(f => f.id).join(',').substring(0, 490),
          balancePayment: 'true'
        }
      });
      paymentResult = {
        paidInFull: false,
        clientSecret: intentResult.clientSecret,
        paymentIntentId: intentResult.paymentIntentId,
        totalCents,
        balanceApplied: 0,
        remainingCents: totalCents
      };
    }

    if (paymentResult.error) {
      await pool.query(`DELETE FROM booking_fee_snapshots WHERE id = $1`, [snapshotId]);
      throw new Error(paymentResult.error);
    }

    const balancePaymentRef = paymentResult.paymentIntentId || paymentResult.balanceTransactionId || 'unknown';
    await pool.query(
      `UPDATE booking_fee_snapshots SET stripe_payment_intent_id = $1 WHERE id = $2`,
      [balancePaymentRef, snapshotId]
    );

    // If fully paid by balance, mark participants as paid
    if (paymentResult.paidInFull) {
      const participantIds = participantFees.map(f => f.id);
      await pool.query(
        `UPDATE booking_participants 
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $1, cached_fee_cents = 0
         WHERE id = ANY($2::int[])`,
        [balancePaymentRef, participantIds]
      );
      
      await pool.query(
        `UPDATE booking_fee_snapshots SET status = 'paid' WHERE id = $1`,
        [snapshotId]
      );
    }

    // Determine if credit was actually applied
    const creditApplied = applyCredit && availableCreditCents > 0 && paymentResult.balanceApplied > 0;

    logger.info('[Member Balance] Payment created: $ (balance: $, remaining: $, applyCredit: , creditApplied: )', { extra: { totalCents_100_ToFixed_2: (totalCents / 100).toFixed(2), paymentResultBalanceApplied_100_ToFixed_2: (paymentResult.balanceApplied / 100).toFixed(2), paymentResultRemainingCents_100_ToFixed_2: (paymentResult.remainingCents / 100).toFixed(2), applyCredit, creditApplied } });

    res.json({
      paidInFull: paymentResult.paidInFull,
      clientSecret: paymentResult.clientSecret,
      paymentIntentId: paymentResult.paymentIntentId,
      balanceTransactionId: paymentResult.balanceTransactionId,
      totalCents,
      balanceApplied: paymentResult.balanceApplied,
      remainingCents: paymentResult.remainingCents,
      availableCreditCents,
      itemCount: participantFees.length,
      participantFees,
      creditApplied,
      error: paymentResult.error
    });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error creating payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'create balance payment');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/balance/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      sessionUser.email,
      sessionUser.name || 'Member'
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error confirming payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'confirm balance payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/bookings/:bookingId/cancel-payment', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.bookingId as any);
    const { paymentIntentId } = req.body;

    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const verification = await pool.query(
      `SELECT spi.id FROM stripe_payment_intents spi
       JOIN booking_requests br ON spi.booking_id = br.id
       WHERE spi.stripe_payment_intent_id = $1 
       AND spi.booking_id = $2
       AND br.user_email = $3
       AND spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')`,
      [paymentIntentId, bookingId, sessionUser.email.toLowerCase()]
    );

    if (verification.rows.length === 0) {
      return res.status(404).json({ error: 'Payment intent not found or already processed' });
    }

    const { cancelPaymentIntent } = await import('../../core/stripe');
    const result = await cancelPaymentIntent(paymentIntentId);

    if (result.success) {
      logger.info('[Member Payment] User cancelled abandoned PI for booking', { extra: { sessionUserEmail: sessionUser.email, paymentIntentId, bookingId } });

      // Void the finalized invoice and re-create draft for next payment attempt
      try {
        const { voidBookingInvoice, recreateDraftInvoiceFromBooking } = await import('../../core/billing/bookingInvoiceService');
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
    res.json({ success: false });
  }
});

export default router;
