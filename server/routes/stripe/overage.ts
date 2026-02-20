import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { sendNotificationToUser, broadcastBillingUpdate } from '../../core/websocket';
import { computeFeeBreakdown, getEffectivePlayerCount } from '../../core/billing/unifiedFeeService';
import { isPlaceholderEmail } from '../../core/stripe/customers';
import { getErrorMessage } from '../../utils/errorUtils';
import { createBookingFeeInvoice, type BookingFeeLineItem } from '../../core/stripe/invoices';
import { pool } from '../../core/db';

const router = Router();

router.post('/api/stripe/overage/create-payment-intent', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.body;
    const sessionUser = getSessionUser(req);
    const userEmail = sessionUser?.email;
    
    if (!bookingId) {
      return res.status(400).json({ error: 'Booking ID is required.' });
    }
    
    const bookingResult = await db.execute(sql`
      SELECT br.id, br.user_email, br.overage_fee_cents, br.overage_paid, br.overage_minutes,
             br.request_date, br.start_time, br.duration_minutes,
             br.session_id, br.declared_player_count, br.overage_payment_intent_id,
             br.trackman_booking_id,
             u.stripe_customer_id, u.id as user_id, u.first_name, u.last_name
      FROM booking_requests br
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE br.id = ${bookingId}
    `);
    
    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    
    const booking = bookingResult.rows[0] as Record<string, unknown>;
    
    const isOwner = (booking.user_email as string).toLowerCase() === userEmail?.toLowerCase();
    const isStaff = sessionUser?.role === 'staff' || sessionUser?.role === 'admin';
    
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Not authorized to pay for this booking.' });
    }
    
    if (booking.overage_paid) {
      return res.status(400).json({ error: 'Overage fee already paid.' });
    }
    
    if (!booking.overage_fee_cents || Number(booking.overage_fee_cents) <= 0) {
      return res.status(400).json({ error: 'No overage fee due for this booking.' });
    }
    
    // Use unified fee service to verify/recalculate overage fee if session exists
    let verifiedOverageCents = booking.overage_fee_cents as number;
    if (booking.session_id) {
      try {
        const breakdown = await computeFeeBreakdown({
          sessionId: booking.session_id as number,
          declaredPlayerCount: getEffectivePlayerCount(Number(booking.declared_player_count) || 1, Number(booking.declared_player_count) || 1),
          source: 'stripe' as const
        });
        
        if (breakdown.totals.overageCents !== booking.overage_fee_cents) {
          logger.info('[Stripe Overage] Verified overage: unified=, stored=', { extra: { breakdownTotalsOverageCents: breakdown.totals.overageCents, bookingOverage_fee_cents: booking.overage_fee_cents } });
          // Use the stored value for payment but log the discrepancy
        }
      } catch (verifyError) {
        logger.warn('[Stripe Overage] Failed to verify overage with unified service', { extra: { verifyError } });
      }
    }
    
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    // Prevent creating Stripe customers for placeholder emails
    if (isPlaceholderEmail(booking.user_email as string)) {
      logger.info('[Stripe] Skipping overage payment for placeholder email', { extra: { bookingUser_email: booking.user_email } });
      return res.status(400).json({ error: 'Cannot process payment for placeholder booking. Please assign this booking to a real member first.' });
    }
    
    let customerId: string;
    if (booking.user_id) {
      const { getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
      const memberName = [booking.first_name, booking.last_name].filter(Boolean).join(' ') || undefined;
      const result = await getOrCreateStripeCustomer(booking.user_id as string, booking.user_email as string, memberName);
      customerId = result.customerId;
    } else {
      const { resolveUserByEmail, getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(booking.user_email as string);
      const resolvedUserId = resolved?.userId || booking.user_email;
      const memberName = [booking.first_name, booking.last_name].filter(Boolean).join(' ') || undefined;
      const custResult = await getOrCreateStripeCustomer(resolvedUserId as string, booking.user_email as string, memberName);
      customerId = custResult.customerId;
    }
    
    if (booking.overage_payment_intent_id && !String(booking.overage_payment_intent_id as string).startsWith('balance-')) {
      try {
        const existingPI = await stripe.paymentIntents.retrieve(booking.overage_payment_intent_id as string);
        if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existingPI.status) 
            && existingPI.amount === verifiedOverageCents) {
          logger.info('[Overage Payment] Reusing existing intent for booking', { extra: { existingPIId: existingPI.id, bookingId } });
          return res.json({
            clientSecret: existingPI.client_secret,
            paymentIntentId: existingPI.id,
            amount: verifiedOverageCents,
            overageMinutes: booking.overage_minutes,
            overageBlocks: Math.ceil(Number(booking.overage_minutes)/ 30),
            reused: true,
            paidInFull: false,
            balanceApplied: 0
          });
        }
        if (existingPI.status === 'succeeded' && !booking.overage_paid) {
          await db.execute(sql`UPDATE booking_requests SET overage_paid = true, updated_at = NOW() WHERE id = ${bookingId}`);
          return res.status(200).json({ alreadyPaid: true, message: 'Overage already paid' });
        }
      } catch (piErr) {
        logger.warn('[Overage Payment] Could not retrieve existing intent, creating new one', { extra: { piErr_as_Error_message: (piErr as Error).message } });
      }
    } else if (booking.overage_payment_intent_id && String(booking.overage_payment_intent_id as string).startsWith('balance-')) {
      if (!booking.overage_paid) {
        await db.execute(sql`UPDATE booking_requests SET overage_paid = true, updated_at = NOW() WHERE id = ${bookingId}`);
      }
      return res.status(200).json({ alreadyPaid: true, message: 'Overage already paid via account credit' });
    }
    
    const productResult = await db.execute(sql`
      SELECT stripe_price_id, stripe_product_id 
      FROM membership_tiers 
      WHERE slug = 'simulator-overage-30min' AND is_active = true
    `);
    
    if (productResult.rows.length === 0 || !(productResult.rows[0] as Record<string, unknown>).stripe_price_id) {
      return res.status(500).json({ error: 'Simulator overage product is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.' });
    }
    
    const overageBlocks = Math.ceil(Number(booking.overage_minutes) / 30);
    const memberName = [booking.first_name, booking.last_name].filter(Boolean).join(' ') || undefined;
    const trackmanId = booking.trackman_booking_id;
    const overageCents = Number(booking.overage_fee_cents);
    const sessionId = booking.session_id as number;

    const ownerDisplayName = memberName || (booking.user_email as string).split('@')[0];
    const feeLineItems: BookingFeeLineItem[] = [{
      displayName: ownerDisplayName,
      participantType: 'owner',
      overageCents: overageCents,
      guestCents: 0,
      totalCents: overageCents,
    }];

    let invoiceResult;
    try {
      invoiceResult = await createBookingFeeInvoice({
        customerId,
        bookingId,
        sessionId,
        trackmanBookingId: trackmanId ? String(trackmanId) : null,
        feeLineItems,
        metadata: {
          overage_minutes: String(booking.overage_minutes),
          overage_blocks: String(overageBlocks),
          member_email: booking.user_email as string,
          booking_date: booking.request_date as string,
          fee_type: 'simulator_overage',
          product_id: (productResult.rows[0] as Record<string, unknown>).stripe_product_id as string,
        },
        purpose: 'overage_fee',
      });
    } catch (invoiceErr: unknown) {
      logger.error('[Overage Payment] Invoice creation failed', { error: invoiceErr instanceof Error ? invoiceErr : new Error(String(invoiceErr)) });
      return res.status(500).json({ error: getErrorMessage(invoiceErr) || 'Failed to create overage payment' });
    }

    const trackingId = invoiceResult.paymentIntentId;
    
    await db.execute(sql`
      UPDATE booking_requests 
      SET overage_payment_intent_id = ${trackingId}, updated_at = NOW() 
      WHERE id = ${bookingId}
    `);

    await pool.query(
      `INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
      [
        (booking.user_id || booking.user_email) as string,
        trackingId,
        customerId,
        overageCents,
        'overage_fee',
        bookingId,
        sessionId || null,
        `Overage fee: ${booking.overage_minutes} min`,
        invoiceResult.paidInFull ? 'succeeded' : 'pending'
      ]
    );

    if (invoiceResult.paidInFull) {
      await db.execute(sql`UPDATE booking_requests SET overage_paid = true, updated_at = NOW() WHERE id = ${bookingId}`);
      logger.info('[Overage Payment] Fully covered by account credit for booking', { extra: { bookingId, dollars: (overageCents / 100).toFixed(2) } });

      try {
        if (booking.user_email) {
          sendNotificationToUser(booking.user_email as string, {
            type: 'billing_update',
            title: 'Overage Payment Confirmed',
            message: `Your overage payment of $${(overageCents / 100).toFixed(2)} has been covered by account credit.`,
            data: { bookingId, amount: overageCents }
          });
          broadcastBillingUpdate({ action: 'overage_paid', memberEmail: booking.user_email as string });
        }
      } catch (notifyError) {
        logger.error('[Overage Payment] Failed to send notification for balance payment', { extra: { notifyError } });
      }

      return res.json({
        paidInFull: true,
        amount: overageCents,
        overageMinutes: booking.overage_minutes,
        overageBlocks,
        balanceApplied: invoiceResult.amountFromBalance || overageCents,
        paymentIntentId: trackingId,
        invoiceId: invoiceResult.invoiceId,
      });
    }
    
    logger.info('[Overage Payment] Created invoice for booking', { extra: { paymentIntentId: trackingId, invoiceId: invoiceResult.invoiceId, bookingId, dollars: (overageCents / 100).toFixed(2) } });
    
    res.json({
      clientSecret: invoiceResult.clientSecret,
      paymentIntentId: invoiceResult.paymentIntentId,
      amount: overageCents,
      overageMinutes: booking.overage_minutes,
      overageBlocks,
      paidInFull: false,
      balanceApplied: 0,
      remainingCents: overageCents,
      invoiceId: invoiceResult.invoiceId,
    });
  } catch (error: unknown) {
    logger.error('[Overage Payment] Error creating payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to create payment intent.' });
  }
});

router.post('/api/stripe/overage/confirm-payment', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { bookingId, paymentIntentId } = req.body;
    const sessionUser = getSessionUser(req);
    const userEmail = sessionUser?.email;
    const isStaff = sessionUser?.role === 'staff' || sessionUser?.role === 'admin';
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    
    if (!bookingId || !paymentIntentId) {
      return res.status(400).json({ error: 'Booking ID and payment intent ID are required.' });
    }
    
    const ownerCheck = await db.execute(sql`SELECT user_email FROM booking_requests WHERE id = ${bookingId}`);
    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    const isOwner = (ownerCheck.rows[0] as Record<string, unknown>).user_email?.toString().toLowerCase() === userEmail.toLowerCase();
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Not authorized to confirm this payment.' });
    }
    
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment not complete. Status: ${paymentIntent.status}` });
    }
    
    const result = await db.execute(sql`
      UPDATE booking_requests 
      SET overage_paid = true, updated_at = NOW() 
      WHERE id = ${bookingId} AND overage_payment_intent_id = ${paymentIntentId}
      RETURNING id, user_email, overage_fee_cents, overage_minutes
    `);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or payment intent mismatch.' });
    }
    
    const booking = result.rows[0] as Record<string, unknown>;
    logger.info('[Overage Payment] Confirmed payment for booking : $', { extra: { bookingId, Number_bookingOverage_fee_cents_100_ToFixed_2: (Number(booking.overage_fee_cents) / 100).toFixed(2) } });
    
    try {
      if (booking.user_email) {
        sendNotificationToUser(booking.user_email as string, {
          type: 'billing_update',
          title: 'Overage Payment Confirmed',
          message: `Your overage payment of $${(Number(booking.overage_fee_cents) / 100).toFixed(2)} has been confirmed.`,
          data: { bookingId, amount: booking.overage_fee_cents }
        });
        broadcastBillingUpdate({ action: 'overage_paid', memberEmail: booking.user_email as string });
      }
    } catch (notifyError) {
      logger.error('[Overage Payment] Failed to send notification', { extra: { notifyError } });
    }
    
    res.json({
      success: true,
      bookingId: booking.id,
      amountPaid: booking.overage_fee_cents,
      overageMinutes: booking.overage_minutes,
    });
  } catch (error: unknown) {
    logger.error('[Overage Payment] Error confirming payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to confirm payment.' });
  }
});

router.get('/api/stripe/overage/check/:bookingId', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const sessionUser = getSessionUser(req);
    const userEmail = sessionUser?.email;
    const isStaff = sessionUser?.role === 'staff' || sessionUser?.role === 'admin';
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    
    const result = await db.execute(sql`
      SELECT id, user_email, overage_minutes, overage_fee_cents, overage_paid, overage_payment_intent_id
      FROM booking_requests 
      WHERE id = ${bookingId}
    `);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    
    const booking = result.rows[0] as Record<string, unknown>;
    const isOwner = (booking.user_email as string)?.toLowerCase() === userEmail.toLowerCase();
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Not authorized to view this booking.' });
    }
    
    const hasUnpaidOverage = Number(booking.overage_fee_cents) > 0 && !booking.overage_paid;
    
    res.json({
      bookingId: booking.id,
      overageMinutes: booking.overage_minutes,
      overageFeeCents: booking.overage_fee_cents,
      overagePaid: booking.overage_paid,
      hasUnpaidOverage,
      overageBlocks: Math.ceil(Number(booking.overage_minutes) / 30),
    });
  } catch (error: unknown) {
    logger.error('[Overage Check] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to check overage status.' });
  }
});

export default router;
