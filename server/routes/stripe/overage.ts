import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { sendNotificationToUser, broadcastBillingUpdate } from '../../core/websocket';
import { computeFeeBreakdown, getEffectivePlayerCount } from '../../core/billing/unifiedFeeService';
import { isPlaceholderEmail } from '../../core/stripe/customers';

const router = Router();

router.post('/api/stripe/overage/create-payment-intent', async (req: Request, res: Response) => {
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
             br.session_id, br.declared_player_count,
             u.stripe_customer_id, u.id as user_id, u.first_name, u.last_name
      FROM booking_requests br
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE br.id = ${bookingId}
    `);
    
    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    
    const booking = bookingResult.rows[0];
    
    const isOwner = booking.user_email.toLowerCase() === userEmail?.toLowerCase();
    const isStaff = sessionUser?.role === 'staff' || sessionUser?.role === 'admin';
    
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Not authorized to pay for this booking.' });
    }
    
    if (booking.overage_paid) {
      return res.status(400).json({ error: 'Overage fee already paid.' });
    }
    
    if (!booking.overage_fee_cents || booking.overage_fee_cents <= 0) {
      return res.status(400).json({ error: 'No overage fee due for this booking.' });
    }
    
    // Use unified fee service to verify/recalculate overage fee if session exists
    let verifiedOverageCents = booking.overage_fee_cents;
    if (booking.session_id) {
      try {
        const breakdown = await computeFeeBreakdown({
          sessionId: booking.session_id,
          declaredPlayerCount: getEffectivePlayerCount(booking.declared_player_count || 1, booking.declared_player_count || 1),
          source: 'stripe' as const
        });
        
        if (breakdown.totals.overageCents !== booking.overage_fee_cents) {
          console.log(`[Stripe Overage] Verified overage: unified=${breakdown.totals.overageCents}, stored=${booking.overage_fee_cents}`);
          // Use the stored value for payment but log the discrepancy
        }
      } catch (verifyError) {
        console.warn('[Stripe Overage] Failed to verify overage with unified service:', verifyError);
      }
    }
    
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    // Prevent creating Stripe customers for placeholder emails
    if (isPlaceholderEmail(booking.user_email)) {
      console.log(`[Stripe] Skipping overage payment for placeholder email: ${booking.user_email}`);
      return res.status(400).json({ error: 'Cannot process payment for placeholder booking. Please assign this booking to a real member first.' });
    }
    
    let customerId: string;
    if (booking.user_id) {
      const { getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
      const memberName = [booking.first_name, booking.last_name].filter(Boolean).join(' ') || undefined;
      const result = await getOrCreateStripeCustomer(booking.user_id, booking.user_email, memberName);
      customerId = result.customerId;
    } else {
      const { resolveUserByEmail, getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(booking.user_email);
      const resolvedUserId = resolved?.userId || booking.user_email;
      const memberName = [booking.first_name, booking.last_name].filter(Boolean).join(' ') || undefined;
      const custResult = await getOrCreateStripeCustomer(resolvedUserId, booking.user_email, memberName);
      customerId = custResult.customerId;
    }
    
    const productResult = await db.execute(sql`
      SELECT stripe_price_id, stripe_product_id 
      FROM membership_tiers 
      WHERE slug = 'simulator-overage-30min' AND is_active = true
    `);
    
    if (productResult.rows.length === 0 || !productResult.rows[0].stripe_price_id) {
      return res.status(500).json({ error: 'Simulator overage product is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.' });
    }
    
    const { PRICING } = await import('../../core/billing/pricingConfig');
    const overageBlocks = Math.ceil(booking.overage_minutes / 30);
    const overageRateStr = (PRICING.OVERAGE_RATE_CENTS / 100).toFixed(0);
    const description = `Simulator Overage: ${booking.overage_minutes} min (${overageBlocks} × 30 min @ $${overageRateStr})`;
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: booking.overage_fee_cents,
      currency: 'usd',
      customer: customerId,
      description,
      metadata: {
        booking_id: bookingId.toString(),
        overage_minutes: booking.overage_minutes.toString(),
        overage_blocks: overageBlocks.toString(),
        member_email: booking.user_email,
        booking_date: booking.request_date,
        fee_type: 'simulator_overage',
        product_id: productResult.rows[0].stripe_product_id,
      },
      automatic_payment_methods: { enabled: true },
    });
    
    await db.execute(sql`
      UPDATE booking_requests 
      SET overage_payment_intent_id = ${paymentIntent.id}, updated_at = NOW() 
      WHERE id = ${bookingId}
    `);
    
    console.log(`[Overage Payment] Created payment intent ${paymentIntent.id} for booking ${bookingId}: $${(booking.overage_fee_cents / 100).toFixed(2)}`);
    
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: booking.overage_fee_cents,
      overageMinutes: booking.overage_minutes,
      overageBlocks,
    });
  } catch (error: any) {
    console.error('[Overage Payment] Error creating payment intent:', error);
    res.status(500).json({ error: error.message || 'Failed to create payment intent.' });
  }
});

router.post('/api/stripe/overage/confirm-payment', async (req: Request, res: Response) => {
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
    const isOwner = ownerCheck.rows[0].user_email?.toLowerCase() === userEmail.toLowerCase();
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
    
    const booking = result.rows[0];
    console.log(`[Overage Payment] Confirmed payment for booking ${bookingId}: $${(booking.overage_fee_cents / 100).toFixed(2)}`);
    
    try {
      if (booking.user_email) {
        sendNotificationToUser(booking.user_email, {
          type: 'billing_update',
          title: 'Overage Payment Confirmed',
          message: `Your overage payment of $${(booking.overage_fee_cents / 100).toFixed(2)} has been confirmed.`,
          data: { bookingId, amount: booking.overage_fee_cents }
        });
        broadcastBillingUpdate(booking.user_email, 'overage_paid');
      }
    } catch (notifyError) {
      console.error('[Overage Payment] Failed to send notification:', notifyError);
    }
    
    res.json({
      success: true,
      bookingId: booking.id,
      amountPaid: booking.overage_fee_cents,
      overageMinutes: booking.overage_minutes,
    });
  } catch (error: any) {
    console.error('[Overage Payment] Error confirming payment:', error);
    res.status(500).json({ error: error.message || 'Failed to confirm payment.' });
  }
});

router.get('/api/stripe/overage/check/:bookingId', async (req: Request, res: Response) => {
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
    
    const booking = result.rows[0];
    const isOwner = booking.user_email?.toLowerCase() === userEmail.toLowerCase();
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: 'Not authorized to view this booking.' });
    }
    
    const hasUnpaidOverage = booking.overage_fee_cents > 0 && !booking.overage_paid;
    
    res.json({
      bookingId: booking.id,
      overageMinutes: booking.overage_minutes,
      overageFeeCents: booking.overage_fee_cents,
      overagePaid: booking.overage_paid,
      hasUnpaidOverage,
      overageBlocks: Math.ceil(booking.overage_minutes / 30),
    });
  } catch (error: any) {
    console.error('[Overage Check] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to check overage status.' });
  }
});

export default router;
