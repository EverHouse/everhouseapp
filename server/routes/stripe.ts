import { Router, Request, Response } from 'express';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { pool } from '../core/db';
import { db } from '../db';
import { billingAuditLog } from '../../shared/schema';
import { getTodayPacific } from '../utils/dateUtils';
import {
  getStripePublishableKey,
  createPaymentIntent,
  confirmPaymentSuccess,
  getPaymentIntentStatus,
  cancelPaymentIntent,
  getOrCreateStripeCustomer,
  getStripeProducts,
  getProductSyncStatus,
  syncHubSpotProductToStripe,
  syncAllHubSpotProductsToStripe,
  fetchHubSpotProducts,
  createSubscription,
  cancelSubscription,
  listCustomerSubscriptions,
  getSubscription,
  createInvoice,
  previewInvoice,
  finalizeAndSendInvoice,
  listCustomerInvoices,
  getInvoice,
  voidInvoice
} from '../core/stripe';
import { calculateAndCacheParticipantFees } from '../core/billing/feeCalculator';
import { checkExpiringCards } from '../core/billing/cardExpiryChecker';
import { checkStaleWaivers } from '../schedulers/waiverReviewScheduler';

const router = Router();

router.get('/api/stripe/config', async (req: Request, res: Response) => {
  try {
    const publishableKey = await getStripePublishableKey();
    res.json({ publishableKey });
  } catch (error: any) {
    console.error('[Stripe] Error getting config:', error);
    res.status(500).json({ error: 'Failed to get Stripe configuration' });
  }
});

router.post('/api/stripe/create-payment-intent', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { 
      userId, 
      email, 
      memberName, 
      amountCents, 
      purpose, 
      bookingId, 
      sessionId, 
      description,
      participantFees
    } = req.body;

    if (!userId || !email || !amountCents || !purpose || !description) {
      return res.status(400).json({ 
        error: 'Missing required fields: userId, email, amountCents, purpose, description' 
      });
    }

    const validPurposes = ['guest_fee', 'overage_fee', 'one_time_purchase'];
    if (!validPurposes.includes(purpose)) {
      return res.status(400).json({ 
        error: `Invalid purpose. Must be one of: ${validPurposes.join(', ')}` 
      });
    }

    let snapshotId: number | null = null;
    let serverFees: Array<{id: number; amountCents: number}> = [];
    let serverTotal = Math.round(amountCents);
    const isBookingPayment = bookingId && sessionId && participantFees && Array.isArray(participantFees) && participantFees.length > 0;

    if (isBookingPayment) {
      const sessionCheck = await pool.query(
        `SELECT bs.id FROM booking_sessions bs
         JOIN booking_requests br ON br.session_id = bs.id
         WHERE bs.id = $1 AND br.id = $2`,
        [sessionId, bookingId]
      );
      if (sessionCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid session/booking combination' });
      }

      const requestedIds: number[] = participantFees.map((pf: any) => pf.id);

      const feeResult = await calculateAndCacheParticipantFees(sessionId, requestedIds);
      
      if (!feeResult.success) {
        return res.status(500).json({ error: feeResult.error || 'Failed to calculate fees' });
      }
      
      if (feeResult.fees.length === 0) {
        return res.status(400).json({ error: 'No valid pending participants with fees to charge' });
      }
      
      for (const fee of feeResult.fees) {
        serverFees.push({ id: fee.participantId, amountCents: fee.amountCents });
      }
      
      console.log(`[Stripe] Calculated ${feeResult.fees.length} authoritative fees using fee calculator`);

      serverTotal = serverFees.reduce((sum, f) => sum + f.amountCents, 0);
      
      if (serverTotal < 50) {
        return res.status(400).json({ error: 'Total amount must be at least $0.50' });
      }

      console.log(`[Stripe] Using authoritative cached fees from DB, total: $${(serverTotal/100).toFixed(2)}`);
      if (Math.abs(serverTotal - amountCents) > 1) {
        console.warn(`[Stripe] Client total mismatch: client=${amountCents}, server=${serverTotal} - using server total`);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        const snapshotResult = await client.query(
          `INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
           VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
          [bookingId, sessionId, JSON.stringify(serverFees), serverTotal]
        );
        snapshotId = snapshotResult.rows[0].id;
        
        await client.query('COMMIT');
        console.log(`[Stripe] Created fee snapshot ${snapshotId} for booking ${bookingId}: $${(serverTotal/100).toFixed(2)} with ${serverFees.length} participants`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      if (serverTotal < 50) {
        return res.status(400).json({ error: 'Amount must be at least $0.50' });
      }
      console.log(`[Stripe] Non-booking payment: $${(serverTotal/100).toFixed(2)} for ${purpose}`);
    }

    const metadata: Record<string, string> = {};
    if (snapshotId) {
      metadata.feeSnapshotId = snapshotId.toString();
    }
    if (serverFees.length > 0) {
      metadata.participantFees = JSON.stringify(serverFees);
    }
    
    let result;
    try {
      result = await createPaymentIntent({
        userId,
        email,
        memberName: memberName || email.split('@')[0],
        amountCents: serverTotal,
        purpose,
        bookingId,
        sessionId,
        description,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined
      });
    } catch (stripeErr) {
      if (snapshotId) {
        await pool.query(`DELETE FROM booking_fee_snapshots WHERE id = $1`, [snapshotId]);
        console.log(`[Stripe] Deleted orphaned snapshot ${snapshotId} after PaymentIntent creation failed`);
      }
      throw stripeErr;
    }

    if (snapshotId) {
      await pool.query(
        `UPDATE booking_fee_snapshots SET stripe_payment_intent_id = $1 WHERE id = $2`,
        [result.paymentIntentId, snapshotId]
      );
    }

    res.json({
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret,
      customerId: result.customerId
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

router.post('/api/stripe/confirm-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const staffUser = (req as any).staffUser;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      staffUser?.email || 'staff',
      staffUser?.name || 'Staff Member'
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error confirming payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.get('/api/stripe/payment-intent/:id', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const status = await getPaymentIntentStatus(id);

    if (!status) {
      return res.status(404).json({ error: 'Payment intent not found' });
    }

    res.json(status);
  } catch (error: any) {
    console.error('[Stripe] Error getting payment intent:', error);
    res.status(500).json({ error: 'Failed to get payment intent status' });
  }
});

router.post('/api/stripe/cancel-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await cancelPaymentIntent(paymentIntentId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error canceling payment:', error);
    res.status(500).json({ error: 'Failed to cancel payment' });
  }
});

router.post('/api/stripe/create-customer', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { userId, email, name } = req.body;

    if (!userId || !email) {
      return res.status(400).json({ error: 'Missing required fields: userId, email' });
    }

    const result = await getOrCreateStripeCustomer(userId, email, name);

    res.json({
      customerId: result.customerId,
      isNew: result.isNew
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating customer:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

router.get('/api/stripe/payments/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const email = decodeURIComponent(req.params.email);

    const result = await pool.query(
      `SELECT 
        spi.id,
        spi.stripe_payment_intent_id,
        spi.amount_cents,
        spi.purpose,
        spi.booking_id,
        spi.description,
        spi.status,
        spi.created_at
       FROM stripe_payment_intents spi
       JOIN users u ON u.id = spi.user_id
       WHERE LOWER(u.email) = $1
       ORDER BY spi.created_at DESC
       LIMIT 50`,
      [email.toLowerCase()]
    );

    res.json({ payments: result.rows });
  } catch (error: any) {
    console.error('[Stripe] Error fetching payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

router.post('/api/admin/check-expiring-cards', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkExpiringCards();
    res.json(result);
  } catch (error: any) {
    console.error('[Stripe] Error checking expiring cards:', error);
    res.status(500).json({ error: 'Failed to check expiring cards', details: error.message });
  }
});

router.post('/api/admin/check-stale-waivers', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkStaleWaivers();
    res.json(result);
  } catch (error: any) {
    console.error('[Admin] Error checking stale waivers:', error);
    res.status(500).json({ error: 'Failed to check stale waivers', details: error.message });
  }
});

router.get('/api/stripe/products', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const syncStatus = await getProductSyncStatus();
    const stripeProducts = await getStripeProducts();
    
    res.json({
      products: stripeProducts,
      syncStatus,
      count: stripeProducts.length
    });
  } catch (error: any) {
    console.error('[Stripe] Error getting products:', error);
    res.status(500).json({ error: 'Failed to get Stripe products' });
  }
});

router.post('/api/stripe/products/sync', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { hubspotProductId } = req.body;
    
    if (!hubspotProductId) {
      return res.status(400).json({ error: 'Missing required field: hubspotProductId' });
    }
    
    const hubspotProducts = await fetchHubSpotProducts();
    const product = hubspotProducts.find(p => p.id === hubspotProductId);
    
    if (!product) {
      return res.status(404).json({ error: 'HubSpot product not found' });
    }
    
    const result = await syncHubSpotProductToStripe(product);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to sync product' });
    }
    
    res.json({
      success: true,
      stripeProductId: result.stripeProductId,
      stripePriceId: result.stripePriceId
    });
  } catch (error: any) {
    console.error('[Stripe] Error syncing product:', error);
    res.status(500).json({ error: 'Failed to sync product to Stripe' });
  }
});

router.post('/api/stripe/products/sync-all', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await syncAllHubSpotProductsToStripe();
    
    res.json({
      success: result.success,
      synced: result.synced,
      failed: result.failed,
      errors: result.errors
    });
  } catch (error: any) {
    console.error('[Stripe] Error syncing all products:', error);
    res.status(500).json({ error: 'Failed to sync products to Stripe' });
  }
});

router.get('/api/stripe/subscriptions/:customerId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    
    const result = await listCustomerSubscriptions(customerId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to list subscriptions' });
    }
    
    res.json({
      subscriptions: result.subscriptions,
      count: result.subscriptions?.length || 0
    });
  } catch (error: any) {
    console.error('[Stripe] Error listing subscriptions:', error);
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

router.post('/api/stripe/subscriptions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId, priceId, memberEmail } = req.body;
    
    if (!customerId || !priceId) {
      return res.status(400).json({ error: 'Missing required fields: customerId, priceId' });
    }
    
    const result = await createSubscription({
      customerId,
      priceId,
      metadata: memberEmail ? { memberEmail } : undefined
    });
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to create subscription' });
    }
    
    res.json({
      success: true,
      subscription: result.subscription
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating subscription:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.delete('/api/stripe/subscriptions/:subscriptionId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { subscriptionId } = req.params;
    
    const result = await cancelSubscription(subscriptionId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to cancel subscription' });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

router.get('/api/stripe/invoices/preview', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId, priceId } = req.query;
    
    if (!customerId || !priceId) {
      return res.status(400).json({ error: 'Missing required query params: customerId, priceId' });
    }
    
    const result = await previewInvoice({
      customerId: customerId as string,
      priceId: priceId as string,
    });
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to preview invoice' });
    }
    
    res.json({ preview: result.preview });
  } catch (error: any) {
    console.error('[Stripe] Error previewing invoice:', error);
    res.status(500).json({ error: 'Failed to preview invoice' });
  }
});

router.get('/api/stripe/invoices/:customerId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    
    const result = await listCustomerInvoices(customerId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to list invoices' });
    }
    
    res.json({
      invoices: result.invoices,
      count: result.invoices?.length || 0
    });
  } catch (error: any) {
    console.error('[Stripe] Error listing invoices:', error);
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

router.post('/api/stripe/invoices', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId, items, description } = req.body;
    
    if (!customerId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: customerId, items (array)' });
    }
    
    const result = await createInvoice({
      customerId,
      items,
      description,
    });
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to create invoice' });
    }
    
    res.json({
      success: true,
      invoice: result.invoice
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating invoice:', error);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

router.post('/api/stripe/invoices/:invoiceId/finalize', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    
    const result = await finalizeAndSendInvoice(invoiceId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to finalize invoice' });
    }
    
    res.json({
      success: true,
      invoice: result.invoice
    });
  } catch (error: any) {
    console.error('[Stripe] Error finalizing invoice:', error);
    res.status(500).json({ error: 'Failed to finalize invoice' });
  }
});

router.get('/api/stripe/invoice/:invoiceId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    
    const result = await getInvoice(invoiceId);
    
    if (!result.success) {
      return res.status(404).json({ error: result.error || 'Invoice not found' });
    }
    
    res.json({ invoice: result.invoice });
  } catch (error: any) {
    console.error('[Stripe] Error getting invoice:', error);
    res.status(500).json({ error: 'Failed to get invoice' });
  }
});

router.post('/api/stripe/invoices/:invoiceId/void', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    
    const result = await voidInvoice(invoiceId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to void invoice' });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error voiding invoice:', error);
    res.status(500).json({ error: 'Failed to void invoice' });
  }
});

// Member-accessible endpoint to view their own invoices
router.get('/api/my-invoices', async (req: Request, res: Response) => {
  try {
    const sessionEmail = (req as any).user?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    // Support "View As" feature: staff can pass user_email param to view as another member
    const requestedEmail = req.query.user_email as string | undefined;
    let targetEmail = sessionEmail;
    
    if (requestedEmail && requestedEmail.toLowerCase() !== sessionEmail.toLowerCase()) {
      const userRole = (req as any).user?.role;
      if (userRole === 'admin' || userRole === 'staff') {
        targetEmail = decodeURIComponent(requestedEmail);
      }
    }
    
    // Look up user's stripe customer ID
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE LOWER(email) = $1',
      [targetEmail.toLowerCase()]
    );
    
    const stripeCustomerId = userResult.rows[0]?.stripe_customer_id;
    
    if (!stripeCustomerId) {
      // No Stripe customer - return empty array
      return res.json({ invoices: [], count: 0 });
    }
    
    const result = await listCustomerInvoices(stripeCustomerId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to list invoices' });
    }
    
    console.log(`[Stripe] my-invoices for ${targetEmail}: found ${result.invoices?.length || 0} invoices`);
    
    res.json({
      invoices: result.invoices,
      count: result.invoices?.length || 0
    });
  } catch (error: any) {
    console.error('[Stripe] Error listing member invoices:', error);
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

router.post('/api/member/bookings/:id/pay-fees', async (req: Request, res: Response) => {
  try {
    const sessionEmail = (req as any).user?.email;
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

    const pendingParticipants = await pool.query(
      `SELECT id, participant_type, display_name, cached_fee_cents
       FROM booking_participants
       WHERE session_id = $1 
         AND participant_type = 'guest'
         AND (payment_status = 'pending' OR payment_status IS NULL)`,
      [booking.session_id]
    );

    if (pendingParticipants.rows.length === 0) {
      return res.status(400).json({ error: 'No unpaid guest fees found' });
    }

    const participantIds = pendingParticipants.rows.map(r => r.id);
    const feeResult = await calculateAndCacheParticipantFees(booking.session_id, participantIds);

    if (!feeResult.success) {
      return res.status(500).json({ error: feeResult.error || 'Failed to calculate fees' });
    }

    if (feeResult.fees.length === 0) {
      return res.status(400).json({ error: 'No fees to charge' });
    }

    const serverTotal = feeResult.totalCents;

    if (serverTotal < 50) {
      return res.status(400).json({ error: 'Total amount must be at least $0.50' });
    }

    const serverFees = feeResult.fees.map(f => ({ id: f.participantId, amountCents: f.amountCents }));

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

    const guestNames = pendingParticipants.rows.map(r => r.display_name).join(', ');
    const description = `Guest fees for: ${guestNames}`;

    const metadata: Record<string, string> = {
      feeSnapshotId: snapshotId!.toString(),
      participantFees: JSON.stringify(serverFees),
      memberPayment: 'true'
    };

    let result;
    try {
      result = await createPaymentIntent({
        userId: booking.user_id || booking.user_email,
        email: booking.user_email,
        memberName: booking.user_name || booking.user_email.split('@')[0],
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

    await pool.query(
      `UPDATE booking_fee_snapshots SET stripe_payment_intent_id = $1 WHERE id = $2`,
      [result.paymentIntentId, snapshotId]
    );

    console.log(`[Stripe] Member payment intent created for booking ${bookingId}: $${(serverTotal / 100).toFixed(2)}`);

    const participantFeesList = feeResult.fees.map(f => {
      const participant = pendingParticipants.rows.find(p => p.id === f.participantId);
      return {
        id: f.participantId,
        displayName: participant?.display_name || 'Guest',
        amount: f.amountCents / 100
      };
    });

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      totalAmount: serverTotal / 100,
      participantFees: participantFeesList
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating member payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

router.post('/api/member/bookings/:id/confirm-payment', async (req: Request, res: Response) => {
  try {
    const sessionEmail = (req as any).user?.email;
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
      `SELECT br.id, br.session_id, br.user_email
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

    const confirmResult = await confirmPaymentSuccess(
      paymentIntentId,
      sessionEmail,
      booking.user_name || 'Member'
    );

    if (!confirmResult.success) {
      return res.status(400).json({ error: confirmResult.error || 'Payment verification failed' });
    }

    const participantFees = JSON.parse(snapshot.participant_fees || '[]');
    const participantIds = participantFees.map((pf: any) => pf.id);

    if (participantIds.length > 0) {
      await pool.query(
        `UPDATE booking_participants 
         SET payment_status = 'paid', updated_at = NOW()
         WHERE id = ANY($1::int[])`,
        [participantIds]
      );
    }

    await pool.query(
      `UPDATE booking_fee_snapshots SET status = 'completed' WHERE id = $1`,
      [snapshot.id]
    );

    console.log(`[Stripe] Member payment confirmed for booking ${bookingId}, ${participantIds.length} participants marked as paid`);

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error confirming member payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.post('/api/member/invoices/:invoiceId/pay', async (req: Request, res: Response) => {
  try {
    const sessionEmail = (req as any).user?.email;
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

    const { getStripeClient } = await import('../core/stripe/client');
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
    const sessionEmail = (req as any).user?.email;
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

    const { getStripeClient } = await import('../core/stripe/client');
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

const GUEST_PASS_PRICING: Record<number, number> = {
  1: 3000,
  3: 7500,
  5: 10000,
};

router.post('/api/member/guest-passes/purchase', async (req: Request, res: Response) => {
  try {
    const sessionEmail = (req as any).user?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { quantity } = req.body;

    if (!quantity || ![1, 3, 5].includes(quantity)) {
      return res.status(400).json({ error: 'Invalid quantity. Must be 1, 3, or 5.' });
    }

    const amountCents = GUEST_PASS_PRICING[quantity];
    if (!amountCents) {
      return res.status(400).json({ error: 'Invalid pricing configuration' });
    }

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

    const { getStripeClient } = await import('../core/stripe/client');
    const stripe = await getStripeClient();

    const description = `${quantity} Guest Pass${quantity > 1 ? 'es' : ''} - Ever House`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: stripeCustomerId,
      metadata: {
        purpose: 'guest_pass_purchase',
        quantity: quantity.toString(),
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
    const sessionEmail = (req as any).user?.email;
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

    const { getStripeClient } = await import('../core/stripe/client');
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

    const expectedAmount = GUEST_PASS_PRICING[quantity];
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

// ============================================================================
// Member Balance Endpoints
// ============================================================================

router.get('/api/member/balance', async (req: Request, res: Response) => {
  try {
    const sessionUser = (req.session as any)?.user;
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const memberEmail = sessionUser.email.toLowerCase();

    // Query all unpaid booking_participants for this member
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
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id AND ul.member_id = bp.user_id
       WHERE LOWER(bp.user_id) = $1
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
       ORDER BY bs.session_date DESC, bs.start_time DESC`,
      [memberEmail]
    );

    // Also get unpaid guest fees where this member is the owner (responsible for guests)
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
        owner_bp.user_id as owner_email
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_bp.user_id) = $1
         AND bp.cached_fee_cents > 0
       ORDER BY bs.session_date DESC, bs.start_time DESC`,
      [memberEmail]
    );

    const GUEST_FEE_CENTS = 2500;
    const breakdown: Array<{
      id: number;
      sessionId: number;
      type: 'overage' | 'guest';
      description: string;
      date: string;
      amountCents: number;
    }> = [];

    // Process member fees (overage/personal fees)
    for (const row of result.rows) {
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

    // Process guest fees
    for (const row of guestResult.rows) {
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
    const sessionUser = (req.session as any)?.user;
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const memberEmail = sessionUser.email.toLowerCase();
    const memberName = sessionUser.name || memberEmail.split('@')[0];

    // Recalculate the balance server-side (never trust client)
    const result = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee
       FROM booking_participants bp
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id AND ul.member_id = bp.user_id
       WHERE LOWER(bp.user_id) = $1
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')`,
      [memberEmail]
    );

    const guestResult = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents
       FROM booking_participants bp
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_bp.user_id) = $1
         AND bp.cached_fee_cents > 0`,
      [memberEmail]
    );

    const GUEST_FEE_CENTS = 2500;
    const participantFees: Array<{id: number; amountCents: number}> = [];

    for (const row of result.rows) {
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
      const amountCents = row.cached_fee_cents || GUEST_FEE_CENTS;
      participantFees.push({ id: row.participant_id, amountCents });
    }

    const totalCents = participantFees.reduce((sum, f) => sum + f.amountCents, 0);

    if (totalCents < 50) {
      return res.status(400).json({ error: 'No outstanding balance to pay or amount too small' });
    }

    // Create fee snapshot
    const client = await pool.connect();
    let snapshotId: number | null = null;

    try {
      await client.query('BEGIN');
      
      const snapshotResult = await client.query(
        `INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
         VALUES (0, 0, $1, $2, 'pending') RETURNING id`,
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

    // Create payment intent
    const paymentResult = await createPaymentIntent({
      userId: memberEmail,
      email: memberEmail,
      memberName,
      amountCents: totalCents,
      purpose: 'overage_fee',
      description: `Outstanding balance payment - ${participantFees.length} item(s)`,
      metadata: {
        feeSnapshotId: snapshotId!.toString(),
        participantFees: JSON.stringify(participantFees),
        balancePayment: 'true'
      }
    });

    // Update snapshot with payment intent ID
    await pool.query(
      `UPDATE booking_fee_snapshots SET stripe_payment_intent_id = $1 WHERE id = $2`,
      [paymentResult.paymentIntentId, snapshotId]
    );

    res.json({
      clientSecret: paymentResult.clientSecret,
      paymentIntentId: paymentResult.paymentIntentId,
      totalCents,
      itemCount: participantFees.length,
      participantFees
    });
  } catch (error: any) {
    console.error('[Member Balance] Error creating payment:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

router.post('/api/member/balance/confirm', async (req: Request, res: Response) => {
  try {
    const sessionUser = (req.session as any)?.user;
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

router.get('/api/billing/members/search', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { query, includeInactive } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.json({ members: [] });
    }
    
    const searchTerm = query.trim().toLowerCase();
    
    let sql = `
      SELECT 
        id, email, first_name, last_name, 
        membership_tier, membership_status, 
        stripe_customer_id, hubspot_id
      FROM users 
      WHERE (
        LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE $1
        OR LOWER(COALESCE(first_name, '')) LIKE $1
        OR LOWER(COALESCE(last_name, '')) LIKE $1
        OR LOWER(COALESCE(email, '')) LIKE $1
      )
    `;
    
    if (includeInactive !== 'true') {
      sql += ` AND (membership_status = 'active' OR membership_status IS NULL)`;
    }
    
    sql += ` AND archived_at IS NULL ORDER BY first_name, last_name LIMIT 10`;
    
    const result = await pool.query(sql, [`%${searchTerm}%`]);
    
    const members = result.rows.map(row => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email?.split('@')[0] || 'Unknown',
      membershipTier: row.membership_tier,
      membershipStatus: row.membership_status,
      stripeCustomerId: row.stripe_customer_id,
      hubspotId: row.hubspot_id,
    }));
    
    res.json({ members });
  } catch (error: any) {
    console.error('[Billing] Error searching members:', error);
    res.status(500).json({ error: 'Failed to search members' });
  }
});

// ============================================================================
// Staff Quick Charge Endpoints
// ============================================================================

router.post('/api/stripe/staff/quick-charge', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberEmail, memberName, amountCents, description } = req.body;
    const staffUser = (req as any).user;

    if (!memberEmail || !amountCents) {
      return res.status(400).json({ error: 'Missing required fields: memberEmail, amountCents' });
    }

    if (amountCents < 50) {
      return res.status(400).json({ error: 'Minimum charge amount is $0.50' });
    }

    const memberResult = await pool.query(
      `SELECT id, email, first_name, last_name, stripe_customer_id 
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [memberEmail]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in database' });
    }

    const member = memberResult.rows[0];
    const resolvedName = memberName || [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email.split('@')[0];

    const result = await createPaymentIntent({
      userId: member.id.toString(),
      email: member.email,
      memberName: resolvedName,
      amountCents: Math.round(amountCents),
      purpose: 'one_time_purchase',
      description: description || 'Quick charge',
      metadata: {
        staffInitiated: 'true',
        staffEmail: staffUser?.email || 'unknown',
        chargeType: 'quick_charge',
        memberId: member.id.toString(),
        memberEmail: member.email,
        memberName: resolvedName
      }
    });

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating quick charge:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

router.post('/api/stripe/staff/quick-charge/confirm', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const staffUser = (req as any).user;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      staffUser?.email || 'staff',
      staffUser?.name || 'Staff Member'
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Payment confirmation failed' });
    }

    console.log(`[Stripe] Quick charge confirmed: ${paymentIntentId} by ${staffUser?.email}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error confirming quick charge:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.get('/api/staff/member-balance/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const memberEmail = decodeURIComponent(req.params.email).toLowerCase();

    const result = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        bs.session_date,
        r.name as resource_name,
        bp.participant_type,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id AND ul.member_id = bp.user_id
       WHERE LOWER(bp.user_id) = $1
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
       ORDER BY bs.session_date DESC`,
      [memberEmail]
    );

    const guestResult = await pool.query(
      `SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        bs.session_date,
        r.name as resource_name
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_bp.user_id) = $1
         AND bp.cached_fee_cents > 0`,
      [memberEmail]
    );

    const GUEST_FEE_CENTS = 2500;
    const items: Array<{participantId: number; sessionId: number; sessionDate: string; resourceName: string; amountCents: number; type: string}> = [];

    for (const row of result.rows) {
      let amountCents = 0;
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      if (amountCents > 0) {
        items.push({
          participantId: row.participant_id,
          sessionId: row.session_id,
          sessionDate: row.session_date,
          resourceName: row.resource_name || 'Unknown',
          amountCents,
          type: row.participant_type === 'owner' ? 'overage' : 'member_fee'
        });
      }
    }

    for (const row of guestResult.rows) {
      items.push({
        participantId: row.participant_id,
        sessionId: row.session_id,
        sessionDate: row.session_date,
        resourceName: row.resource_name || 'Unknown',
        amountCents: row.cached_fee_cents || GUEST_FEE_CENTS,
        type: 'guest_fee'
      });
    }

    const totalCents = items.reduce((sum, item) => sum + item.amountCents, 0);

    res.json({ totalCents, items });
  } catch (error: any) {
    console.error('[Staff] Error fetching member balance:', error);
    res.status(500).json({ error: 'Failed to fetch member balance' });
  }
});

router.post('/api/payments/record-offline', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const {
      memberEmail,
      memberId,
      memberName,
      amountCents,
      paymentMethod,
      category,
      description,
      notes
    } = req.body;
    
    const staffUser = (req as any).staffUser;
    const performedBy = staffUser?.email || 'staff';
    const performedByName = staffUser?.name || 'Staff Member';

    if (!memberEmail || !amountCents || !paymentMethod || !category) {
      return res.status(400).json({ 
        error: 'Missing required fields: memberEmail, amountCents, paymentMethod, category' 
      });
    }

    const validPaymentMethods = ['cash', 'check', 'other'];
    if (!validPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({ 
        error: `Invalid paymentMethod. Must be one of: ${validPaymentMethods.join(', ')}` 
      });
    }

    const validCategories = ['guest_fee', 'overage', 'merchandise', 'membership', 'other'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ 
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}` 
      });
    }

    if (amountCents < 1) {
      return res.status(400).json({ error: 'Amount must be at least $0.01' });
    }

    const formattedAmount = `$${(amountCents / 100).toFixed(2)}`;
    const paymentMethodDisplay = paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1);

    await db.insert(billingAuditLog).values({
      memberEmail,
      hubspotDealId: null,
      actionType: 'offline_payment',
      actionDetails: {
        paymentMethod,
        category,
        amountCents,
        description: description || null,
        notes: notes || null,
        memberId: memberId || null,
        memberName: memberName || null
      },
      newValue: `${paymentMethodDisplay} payment of ${formattedAmount} for ${category.replace('_', ' ')}${description ? `: ${description}` : ''}`,
      performedBy,
      performedByName
    });

    console.log(`[Payments] Recorded offline ${paymentMethod} payment of ${formattedAmount} for ${memberEmail} by ${performedBy}`);

    res.json({ 
      success: true, 
      message: `${paymentMethodDisplay} payment of ${formattedAmount} recorded successfully`
    });
  } catch (error: any) {
    console.error('[Payments] Error recording offline payment:', error);
    res.status(500).json({ error: 'Failed to record offline payment' });
  }
});

router.post('/api/payments/adjust-guest-passes', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const staffUser = (req as any).staffUser;
    const { memberId, memberEmail, memberName, adjustment, reason } = req.body;
    const performedBy = staffUser?.email || req.body.performedBy || 'staff';
    const performedByName = staffUser?.name || req.body.performedByName || 'Staff Member';

    if (!memberEmail || typeof adjustment !== 'number' || !reason) {
      return res.status(400).json({ 
        error: 'Missing required fields: memberEmail, adjustment (number), reason' 
      });
    }

    if (adjustment === 0) {
      return res.status(400).json({ error: 'Adjustment cannot be zero' });
    }

    const existingResult = await pool.query(
      'SELECT id, passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = $1',
      [memberEmail.toLowerCase()]
    );

    let previousCount = 0;
    let newCount = 0;
    let passesUsed = 0;

    if (existingResult.rows.length === 0) {
      newCount = Math.max(0, adjustment);
      await pool.query(
        'INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES ($1, 0, $2)',
        [memberEmail.toLowerCase(), newCount]
      );
      console.log(`[GuestPasses] Created new record for ${memberEmail} with ${newCount} passes`);
    } else {
      const current = existingResult.rows[0];
      previousCount = current.passes_total || 0;
      passesUsed = current.passes_used || 0;
      newCount = Math.max(0, previousCount + adjustment);

      await pool.query(
        'UPDATE guest_passes SET passes_total = $1 WHERE id = $2',
        [newCount, current.id]
      );
      console.log(`[GuestPasses] Updated ${memberEmail}: ${previousCount} -> ${newCount} (${adjustment > 0 ? '+' : ''}${adjustment})`);
    }

    await db.insert(billingAuditLog).values({
      memberEmail,
      hubspotDealId: null,
      actionType: 'guest_pass_adjustment',
      actionDetails: {
        adjustment,
        reason,
        previousCount,
        newCount,
        memberId: memberId || null,
        memberName: memberName || null
      },
      previousValue: previousCount.toString(),
      newValue: newCount.toString(),
      performedBy,
      performedByName
    });

    res.json({ 
      success: true, 
      previousCount,
      newCount,
      remaining: newCount - passesUsed
    });
  } catch (error: any) {
    console.error('[GuestPasses] Error adjusting guest passes:', error);
    res.status(500).json({ error: 'Failed to adjust guest passes' });
  }
});

router.get('/api/stripe/transactions/today', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { getStripeClient } = await import('../core/stripe/client');
    const stripe = await getStripeClient();

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const paymentIntents = await stripe.paymentIntents.list({
      created: { gte: Math.floor(startOfDay.getTime() / 1000) },
      limit: 50,
    });

    const transactions = paymentIntents.data
      .filter(pi => pi.status === 'succeeded' || pi.status === 'processing')
      .map(pi => ({
        id: pi.id,
        amount: pi.amount,
        status: pi.status,
        description: pi.description || pi.metadata?.purpose || 'Payment',
        memberEmail: pi.metadata?.memberEmail || pi.metadata?.email || pi.receipt_email || '',
        memberName: pi.metadata?.memberName || 'Unknown',
        createdAt: new Date(pi.created * 1000).toISOString(),
        type: pi.metadata?.purpose || 'payment'
      }));

    res.json(transactions);
  } catch (error: any) {
    console.error('[Stripe] Error fetching today transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

router.post('/api/payments/add-note', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { transactionId, note, performedBy, performedByName } = req.body;

    if (!transactionId || !note) {
      return res.status(400).json({ error: 'Missing required fields: transactionId, note' });
    }

    const staffUser = (req as any).staffUser;
    const finalPerformedBy = performedBy || staffUser?.email || 'staff';
    const finalPerformedByName = performedByName || staffUser?.name || 'Staff Member';

    const piResult = await pool.query(
      `SELECT u.email as member_email 
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.stripe_payment_intent_id = $1`,
      [transactionId]
    );

    let memberEmail = 'unknown';
    if (piResult.rows.length > 0 && piResult.rows[0].member_email) {
      memberEmail = piResult.rows[0].member_email;
    }

    await db.insert(billingAuditLog).values({
      memberEmail,
      actionType: 'payment_note_added',
      actionDetails: { paymentIntentId: transactionId, note },
      newValue: note,
      performedBy: finalPerformedBy,
      performedByName: finalPerformedByName
    });

    console.log(`[Payments] Note added to transaction ${transactionId} by ${finalPerformedByName}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Payments] Error adding note:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

router.get('/api/payments/:paymentIntentId/notes', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.params;

    const result = await pool.query(
      `SELECT id, action_details->>'note' as note, performed_by_name, created_at
       FROM billing_audit_log
       WHERE action_type = 'payment_note_added'
         AND action_details->>'paymentIntentId' = $1
       ORDER BY created_at DESC`,
      [paymentIntentId]
    );

    const notes = result.rows.map(row => ({
      id: row.id,
      note: row.note,
      performedByName: row.performed_by_name,
      createdAt: row.created_at
    }));

    res.json({ notes });
  } catch (error: any) {
    console.error('[Payments] Error fetching notes:', error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

router.get('/api/payments/refundable', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await pool.query(
      `SELECT 
        spi.id,
        spi.stripe_payment_intent_id as "paymentIntentId",
        u.email as "memberEmail",
        COALESCE(TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.email) as "memberName",
        spi.amount_cents as amount,
        spi.description,
        spi.created_at as "createdAt",
        spi.status
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.status = 'succeeded'
         AND spi.created_at >= $1
       ORDER BY spi.created_at DESC`,
      [thirtyDaysAgo]
    );

    res.json(result.rows);
  } catch (error: any) {
    console.error('[Payments] Error fetching refundable payments:', error);
    res.status(500).json({ error: 'Failed to fetch refundable payments' });
  }
});

router.get('/api/payments/failed', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT 
        spi.id,
        spi.stripe_payment_intent_id as "paymentIntentId",
        u.email as "memberEmail",
        COALESCE(TRIM(CONCAT(u.first_name, ' ', u.last_name)), 'Unknown') as "memberName",
        spi.amount_cents as amount,
        spi.description,
        spi.status,
        spi.created_at as "createdAt"
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.status IN ('failed', 'canceled', 'requires_action', 'requires_payment_method')
       ORDER BY spi.created_at DESC
       LIMIT 50`
    );

    const payments = result.rows.map(row => ({
      id: row.id,
      paymentIntentId: row.paymentIntentId,
      memberEmail: row.memberEmail || 'unknown',
      memberName: row.memberName,
      amount: row.amount,
      description: row.description,
      status: row.status,
      failureReason: null,
      createdAt: row.createdAt
    }));

    res.json(payments);
  } catch (error: any) {
    console.error('[Payments] Error fetching failed payments:', error);
    res.status(500).json({ error: 'Failed to fetch failed payments' });
  }
});

router.post('/api/payments/refund', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amountCents, reason } = req.body;
    const staffUser = (req as any).staffUser;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing required field: paymentIntentId' });
    }

    const localRecord = await pool.query(
      `SELECT spi.*, u.email as member_email, TRIM(CONCAT(u.first_name, ' ', u.last_name)) as member_name
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );

    if (localRecord.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = localRecord.rows[0];

    if (payment.status !== 'succeeded') {
      return res.status(400).json({ error: `Cannot refund payment with status: ${payment.status}` });
    }

    const stripe = await (await import('../core/stripe/client')).getStripeClient();

    const refundParams: any = {
      payment_intent: paymentIntentId
    };

    if (amountCents && amountCents > 0 && amountCents < payment.amount_cents) {
      refundParams.amount = amountCents;
    }

    const refund = await stripe.refunds.create(refundParams);

    const refundedAmount = refund.amount;
    const isPartialRefund = refundedAmount < payment.amount_cents;
    const newStatus = isPartialRefund ? 'partially_refunded' : 'refunded';

    await pool.query(
      `UPDATE stripe_payment_intents 
       SET status = $1, updated_at = NOW() 
       WHERE stripe_payment_intent_id = $2`,
      [newStatus, paymentIntentId]
    );

    await db.insert(billingAuditLog).values({
      memberEmail: payment.member_email || 'unknown',
      hubspotDealId: null,
      actionType: 'payment_refunded',
      actionDetails: {
        paymentIntentId,
        refundId: refund.id,
        refundAmount: refundedAmount,
        reason: reason || 'No reason provided',
        originalAmount: payment.amount_cents,
        isPartialRefund
      },
      newValue: `Refunded $${(refundedAmount / 100).toFixed(2)} of $${(payment.amount_cents / 100).toFixed(2)}`,
      performedBy: staffUser?.email || 'staff',
      performedByName: staffUser?.name || 'Staff Member'
    });

    console.log(`[Payments] Refund ${refund.id} created for ${paymentIntentId}: $${(refundedAmount / 100).toFixed(2)}`);

    res.json({
      success: true,
      refundId: refund.id,
      refundedAmount,
      newStatus
    });
  } catch (error: any) {
    console.error('[Payments] Error creating refund:', error);
    res.status(500).json({ error: error.message || 'Failed to create refund' });
  }
});

router.get('/api/payments/pending-authorizations', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT 
        spi.id,
        spi.stripe_payment_intent_id as "paymentIntentId",
        u.email as "memberEmail",
        COALESCE(TRIM(CONCAT(u.first_name, ' ', u.last_name)), spi.description) as "memberName",
        spi.amount_cents as "amount",
        spi.description,
        spi.created_at as "createdAt"
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.status = 'requires_capture'
       ORDER BY spi.created_at DESC`
    );

    const authorizations = result.rows.map(row => ({
      ...row,
      expiresAt: new Date(new Date(row.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }));

    res.json(authorizations);
  } catch (error: any) {
    console.error('[Payments] Error fetching pending authorizations:', error);
    res.status(500).json({ error: 'Failed to fetch pending authorizations' });
  }
});

router.post('/api/payments/capture', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amountCents } = req.body;
    const staffUser = (req as any).staffUser;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const localRecord = await pool.query(
      `SELECT spi.*, u.email as member_email, TRIM(CONCAT(u.first_name, ' ', u.last_name)) as member_name
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );

    if (localRecord.rows.length === 0) {
      return res.status(404).json({ error: 'Payment authorization not found' });
    }

    const payment = localRecord.rows[0];

    if (payment.status !== 'requires_capture') {
      return res.status(400).json({ error: `Cannot capture payment with status: ${payment.status}` });
    }

    const stripe = await (await import('../core/stripe/client')).getStripeClient();

    const captureParams: any = {};
    if (amountCents && amountCents > 0 && amountCents <= payment.amount_cents) {
      captureParams.amount_to_capture = amountCents;
    }

    const capturedPaymentIntent = await stripe.paymentIntents.capture(paymentIntentId, captureParams);

    const capturedAmount = capturedPaymentIntent.amount_received || amountCents || payment.amount_cents;

    await pool.query(
      `UPDATE stripe_payment_intents 
       SET status = 'succeeded', amount_cents = $1, updated_at = NOW() 
       WHERE stripe_payment_intent_id = $2`,
      [capturedAmount, paymentIntentId]
    );

    await db.insert(billingAuditLog).values({
      memberEmail: payment.member_email || 'unknown',
      hubspotDealId: null,
      actionType: 'payment_captured',
      actionDetails: {
        paymentIntentId,
        originalAmount: payment.amount_cents,
        capturedAmount,
        isPartialCapture: amountCents && amountCents < payment.amount_cents
      },
      previousValue: `Pre-authorized: $${(payment.amount_cents / 100).toFixed(2)}`,
      newValue: `Captured: $${(capturedAmount / 100).toFixed(2)}`,
      performedBy: staffUser?.email || 'staff',
      performedByName: staffUser?.name || 'Staff Member'
    });

    console.log(`[Payments] Captured ${paymentIntentId}: $${(capturedAmount / 100).toFixed(2)}`);

    res.json({
      success: true,
      capturedAmount,
      paymentIntentId
    });
  } catch (error: any) {
    console.error('[Payments] Error capturing payment:', error);
    res.status(500).json({ error: error.message || 'Failed to capture payment' });
  }
});

router.post('/api/payments/void-authorization', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, reason } = req.body;
    const staffUser = (req as any).staffUser;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const localRecord = await pool.query(
      `SELECT spi.*, u.email as member_email, TRIM(CONCAT(u.first_name, ' ', u.last_name)) as member_name
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );

    if (localRecord.rows.length === 0) {
      return res.status(404).json({ error: 'Payment authorization not found' });
    }

    const payment = localRecord.rows[0];

    if (payment.status !== 'requires_capture') {
      return res.status(400).json({ error: `Cannot void payment with status: ${payment.status}` });
    }

    const stripe = await (await import('../core/stripe/client')).getStripeClient();

    await stripe.paymentIntents.cancel(paymentIntentId);

    await pool.query(
      `UPDATE stripe_payment_intents 
       SET status = 'canceled', updated_at = NOW() 
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );

    await db.insert(billingAuditLog).values({
      memberEmail: payment.member_email || 'unknown',
      hubspotDealId: null,
      actionType: 'authorization_voided',
      actionDetails: {
        paymentIntentId,
        amount: payment.amount_cents,
        reason: reason || 'No reason provided'
      },
      previousValue: `Pre-authorized: $${(payment.amount_cents / 100).toFixed(2)}`,
      newValue: 'Voided',
      performedBy: staffUser?.email || 'staff',
      performedByName: staffUser?.name || 'Staff Member'
    });

    console.log(`[Payments] Voided authorization ${paymentIntentId}: $${(payment.amount_cents / 100).toFixed(2)} - ${reason || 'No reason'}`);

    res.json({
      success: true,
      paymentIntentId
    });
  } catch (error: any) {
    console.error('[Payments] Error voiding authorization:', error);
    res.status(500).json({ error: error.message || 'Failed to void authorization' });
  }
});

router.get('/api/payments/daily-summary', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const today = getTodayPacific();
    
    const stripeResult = await pool.query(
      `SELECT 
        purpose,
        SUM(amount_cents) as total_cents,
        COUNT(*) as count
       FROM stripe_payment_intents
       WHERE status = 'succeeded'
         AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = $1
       GROUP BY purpose`,
      [today]
    );

    const offlineResult = await pool.query(
      `SELECT 
        action_details->>'paymentMethod' as payment_method,
        action_details->>'category' as category,
        (action_details->>'amountCents')::int as amount_cents
       FROM billing_audit_log
       WHERE action_type = 'offline_payment'
         AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = $1`,
      [today]
    );

    const breakdown: Record<string, number> = {
      guest_fee: 0,
      overage: 0,
      merchandise: 0,
      membership: 0,
      cash: 0,
      check: 0,
      other: 0
    };

    let transactionCount = 0;

    for (const row of stripeResult.rows) {
      const purpose = row.purpose || 'other';
      const cents = parseInt(row.total_cents) || 0;
      const count = parseInt(row.count) || 0;
      
      transactionCount += count;
      
      if (purpose === 'guest_fee') {
        breakdown.guest_fee += cents;
      } else if (purpose === 'overage_fee') {
        breakdown.overage += cents;
      } else if (purpose === 'one_time_purchase') {
        breakdown.merchandise += cents;
      } else {
        breakdown.other += cents;
      }
    }

    for (const row of offlineResult.rows) {
      const method = row.payment_method || 'other';
      const category = row.category || 'other';
      const cents = row.amount_cents || 0;
      
      transactionCount += 1;

      if (method === 'cash') {
        breakdown.cash += cents;
      } else if (method === 'check') {
        breakdown.check += cents;
      } else {
        if (category === 'guest_fee') {
          breakdown.guest_fee += cents;
        } else if (category === 'overage') {
          breakdown.overage += cents;
        } else if (category === 'merchandise') {
          breakdown.merchandise += cents;
        } else if (category === 'membership') {
          breakdown.membership += cents;
        } else {
          breakdown.other += cents;
        }
      }
    }

    const totalCollected = Object.values(breakdown).reduce((sum, val) => sum + val, 0);

    res.json({
      date: today,
      totalCollected,
      breakdown,
      transactionCount
    });
  } catch (error: any) {
    console.error('[Payments] Error getting daily summary:', error);
    res.status(500).json({ error: 'Failed to get daily summary' });
  }
});

export default router;
