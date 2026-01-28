import { Router, Request, Response } from 'express';
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
  createBalanceAwarePayment
} from '../../core/stripe';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants } from '../../core/billing/unifiedFeeService';
import { GUEST_FEE_CENTS } from './helpers';

const router = Router();

router.post('/api/member/bookings/:id/pay-fees', paymentRateLimiter, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const bookingResult = await pool.query(
      `SELECT br.id, br.session_id, br.user_email, br.user_name, u.id as user_id
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.user_email?.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Only the booking owner can pay fees' });
    }

    if (!booking.session_id) {
      return res.status(400).json({ error: 'Booking has no session' });
    }

    // Get all pending participants (guests, members, and owner for overage fees)
    const pendingParticipants = await pool.query(
      `SELECT bp.id, bp.participant_type, bp.display_name, bp.cached_fee_cents,
              (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
              (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       WHERE bp.session_id = $1 
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.cached_fee_cents > 0`,
      [booking.session_id]
    );

    // Filter out orphaned fees (sessions with only cancelled/paid snapshots)
    const validParticipants = pendingParticipants.rows.filter(row => {
      const pendingCount = parseInt(row.pending_snapshot_count) || 0;
      const totalCount = parseInt(row.total_snapshot_count) || 0;
      // Include if no snapshots exist (legacy) or if there's a pending snapshot
      return totalCount === 0 || pendingCount > 0;
    });

    if (validParticipants.length === 0) {
      return res.status(400).json({ error: 'No unpaid fees found' });
    }

    const participantIds = validParticipants.map(r => r.id);
    
    let breakdown;
    try {
      breakdown = await computeFeeBreakdown({
        sessionId: booking.session_id,
        source: 'stripe' as const
      });
      await applyFeeBreakdownToParticipants(booking.session_id, breakdown);
    } catch (feeError) {
      console.error('[Stripe] Failed to compute fees:', feeError);
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

    const client = await pool.connect();
    let snapshotId: number | null = null;
    try {
      await client.query('BEGIN');

      const snapshotResult = await client.query(
        `INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [bookingId, booking.session_id, JSON.stringify(serverFees), serverTotal]
      );
      snapshotId = snapshotResult.rows[0].id;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Build description based on fee types present
    const hasGuestFees = validParticipants.some(r => r.participant_type === 'guest');
    const hasOverageFees = validParticipants.some(r => r.participant_type === 'owner' || r.participant_type === 'member');
    let description = 'Booking fees';
    if (hasGuestFees && hasOverageFees) {
      description = `Overage & guest fees for booking ${bookingId}`;
    } else if (hasGuestFees) {
      const guestNames = validParticipants.filter(r => r.participant_type === 'guest').map(r => r.display_name).join(', ');
      description = `Guest fees for: ${guestNames}`;
    } else if (hasOverageFees) {
      description = `Overage fees for booking ${bookingId}`;
    }

    const metadata: Record<string, string> = {
      feeSnapshotId: snapshotId!.toString(),
      participantCount: serverFees.length.toString(),
      participantIds: serverFees.map(f => f.id).join(',').substring(0, 490),
      memberPayment: 'true'
    };

    // Get or create Stripe customer for balance-aware payment
    const memberName = booking.user_name || booking.user_email.split('@')[0];
    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      booking.user_id || booking.user_email,
      booking.user_email,
      memberName
    );

    let result;
    try {
      // Use balance-aware payment to apply account credits first
      result = await createBalanceAwarePayment({
        stripeCustomerId,
        userId: booking.user_id || booking.user_email,
        email: booking.user_email,
        memberName,
        amountCents: serverTotal,
        purpose: 'guest_fee',
        bookingId,
        sessionId: booking.session_id,
        description,
        metadata
      });
    } catch (stripeErr) {
      if (snapshotId) {
        await pool.query(`DELETE FROM booking_fee_snapshots WHERE id = $1`, [snapshotId]);
      }
      throw stripeErr;
    }

    if (result.error) {
      if (snapshotId) {
        await pool.query(`DELETE FROM booking_fee_snapshots WHERE id = $1`, [snapshotId]);
      }
      throw new Error(result.error);
    }

    // Store payment ID for tracking
    const paymentRef = result.paymentIntentId || result.balanceTransactionId || 'unknown';
    await pool.query(
      `UPDATE booking_fee_snapshots SET stripe_payment_intent_id = $1 WHERE id = $2`,
      [paymentRef, snapshotId]
    );

    console.log(`[Stripe] Member payment created for booking ${bookingId}: $${(serverTotal / 100).toFixed(2)} (balance: $${(result.balanceApplied / 100).toFixed(2)}, remaining: $${(result.remainingCents / 100).toFixed(2)})`);

    const participantFeesList = pendingFees.map(f => {
      const participant = pendingParticipants.rows.find(p => p.id === f.participantId);
      return {
        id: f.participantId,
        displayName: participant?.display_name || 'Guest',
        amount: f.totalCents / 100
      };
    });

    // If fully paid by balance, mark participants as paid
    if (result.paidInFull) {
      const participantIds = pendingFees.map(f => f.participantId);
      await pool.query(
        `UPDATE booking_participants 
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $1, cached_fee_cents = 0
         WHERE id = ANY($2::int[])`,
        [paymentRef, participantIds]
      );
      
      await pool.query(
        `UPDATE booking_fee_snapshots SET status = 'paid' WHERE id = $1`,
        [snapshotId]
      );
    }

    res.json({
      paidInFull: result.paidInFull,
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      balanceTransactionId: result.balanceTransactionId,
      totalAmount: serverTotal / 100,
      balanceApplied: result.balanceApplied / 100,
      remainingAmount: result.remainingCents / 100,
      participantFees: participantFeesList,
      error: result.error
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating member payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

router.post('/api/member/bookings/:id/confirm-payment', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id);
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
    const currentFees = await computeFeeBreakdown({ sessionId: booking.session_id, source: 'payment_verification' as const });
    const snapshotFees = snapshot.participant_fees;
    const snapshotTotal = Array.isArray(snapshotFees) 
      ? snapshotFees.reduce((sum: number, f: any) => sum + (f.amountCents || 0), 0)
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

      const participantFees = JSON.parse(snapshot.participant_fees || '[]');
      const participantIds = participantFees.map((pf: any) => pf.id);

      if (participantIds.length > 0) {
        await client.query(
          `UPDATE booking_participants 
           SET payment_status = 'paid', updated_at = NOW()
           WHERE id = ANY($1::int[])`,
          [participantIds]
        );
      }

      await client.query(
        `UPDATE booking_fee_snapshots SET status = 'completed' WHERE id = $1`,
        [snapshot.id]
      );

      await client.query('COMMIT');
      console.log(`[Stripe] Member payment confirmed for booking ${bookingId}, ${participantIds.length} participants marked as paid (transaction committed)`);
    } catch (txError) {
      await client.query('ROLLBACK');
      console.error('[Stripe] Transaction rolled back for member payment confirmation:', txError);
      throw txError;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error confirming member payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.post('/api/member/invoices/:invoiceId/pay', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    if (!invoiceId || !invoiceId.startsWith('in_')) {
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

    const invoiceResult = await getInvoice(invoiceId);

    if (!invoiceResult.success || !invoiceResult.invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.invoice;

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    const stripeInvoice = await stripe.invoices.retrieve(invoiceId);

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
        invoice_id: invoiceId,
        purpose: 'invoice_payment',
        member_email: sessionEmail,
        source: 'ever_house_member_portal'
      },
      description: `Payment for: ${description}`,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log(`[Stripe] Member invoice payment intent created for ${invoiceId}: $${(amountDue / 100).toFixed(2)}`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      invoiceId: invoiceId,
      amount: amountDue / 100,
      description: description,
      currency: invoice.currency || 'usd'
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating invoice payment intent:', error);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

router.post('/api/member/invoices/:invoiceId/confirm', async (req: Request, res: Response) => {
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
      await stripe.invoices.pay(invoiceId, {
        paid_out_of_band: true,
      });
      console.log(`[Stripe] Invoice ${invoiceId} marked as paid out of band after PaymentIntent ${paymentIntentId} succeeded`);
    } catch (payErr: any) {
      if (payErr.code === 'invoice_already_paid') {
        console.log(`[Stripe] Invoice ${invoiceId} was already marked as paid`);
      } else {
        console.error('[Stripe] Error marking invoice as paid:', payErr);
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error confirming invoice payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.post('/api/member/guest-passes/purchase', async (req: Request, res: Response) => {
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
        error: 'Guest Pass product not configured. Please sync tiers to Stripe first.'
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
      const customerResult = await getOrCreateStripeCustomer(sessionEmail, sessionEmail, memberName);
      stripeCustomerId = customerResult.customerId;
    }

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();

    const description = `${quantity} Guest Pass${quantity > 1 ? 'es' : ''} - Ever House`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: stripeCustomerId,
      metadata: {
        purpose: 'guest_pass_purchase',
        quantity: quantity.toString(),
        priceId: passProduct.stripePriceId,
        member_email: sessionEmail,
        source: 'ever_house_member_portal'
      },
      description,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log(`[Stripe] Guest pass purchase intent created for ${sessionEmail}: ${quantity} passes, $${(amountCents / 100).toFixed(2)}`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      quantity,
      amountCents
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating guest pass payment intent:', error);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

router.post('/api/member/guest-passes/confirm', async (req: Request, res: Response) => {
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

    if (paymentIntent.metadata?.purpose !== 'guest_pass_purchase') {
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
        error: 'Guest Pass product not configured. Please sync tiers to Stripe first.'
      });
    }

    const expectedAmount = passProduct.priceCents * quantity;
    if (paymentIntent.amount !== expectedAmount) {
      console.error(`[Stripe] Amount mismatch for guest pass purchase: expected ${expectedAmount}, got ${paymentIntent.amount}`);
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    const existingPass = await pool.query(
      'SELECT id, passes_total FROM guest_passes WHERE member_email = $1',
      [sessionEmail]
    );

    if (existingPass.rows.length > 0) {
      await pool.query(
        'UPDATE guest_passes SET passes_total = passes_total + $1 WHERE member_email = $2',
        [quantity, sessionEmail]
      );
      console.log(`[Stripe] Added ${quantity} guest passes to existing record for ${sessionEmail}`);
    } else {
      await pool.query(
        'INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES ($1, 0, $2)',
        [sessionEmail, quantity]
      );
      console.log(`[Stripe] Created new guest pass record with ${quantity} passes for ${sessionEmail}`);
    }

    res.json({ success: true, passesAdded: quantity });
  } catch (error: any) {
    console.error('[Stripe] Error confirming guest pass purchase:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.get('/api/member/balance', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const queryEmail = req.query.email as string | undefined;
    if (queryEmail && sessionUser.isStaff) {
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

    const totalCents = breakdown.reduce((sum, item) => sum + item.amountCents, 0);

    res.json({
      totalCents,
      totalDollars: totalCents / 100,
      itemCount: breakdown.length,
      breakdown
    });
  } catch (error: any) {
    console.error('[Member Balance] Error getting balance:', error);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

router.post('/api/member/balance/pay', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const requestEmail = req.body?.memberEmail as string | undefined;
    if (requestEmail && sessionUser.isStaff) {
      memberEmail = requestEmail.toLowerCase();
    }
    
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

    try {
      await client.query('BEGIN');
      
      const snapshotResult = await client.query(
        `INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
         VALUES (NULL, NULL, $1, $2, 'pending') RETURNING id`,
        [JSON.stringify(participantFees), totalCents]
      );
      snapshotId = snapshotResult.rows[0].id;
      
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Get or create Stripe customer for balance-aware payment
    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      memberEmail,
      memberEmail,
      memberName
    );

    // Use balance-aware payment to apply account credits first
    const paymentResult = await createBalanceAwarePayment({
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

    console.log(`[Member Balance] Payment created: $${(totalCents / 100).toFixed(2)} (balance: $${(paymentResult.balanceApplied / 100).toFixed(2)}, remaining: $${(paymentResult.remainingCents / 100).toFixed(2)})`);

    res.json({
      paidInFull: paymentResult.paidInFull,
      clientSecret: paymentResult.clientSecret,
      paymentIntentId: paymentResult.paymentIntentId,
      balanceTransactionId: paymentResult.balanceTransactionId,
      totalCents,
      balanceApplied: paymentResult.balanceApplied,
      remainingCents: paymentResult.remainingCents,
      itemCount: participantFees.length,
      participantFees,
      error: paymentResult.error
    });
  } catch (error: any) {
    console.error('[Member Balance] Error creating payment:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

router.post('/api/member/balance/confirm', async (req: Request, res: Response) => {
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
  } catch (error: any) {
    console.error('[Member Balance] Error confirming payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

export default router;
