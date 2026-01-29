import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool } from '../../core/db';
import { db } from '../../db';
import { billingAuditLog, passRedemptionLogs, dayPassPurchases, users } from '../../../shared/schema';
import { eq, gte, desc, inArray } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { isExpandedProduct } from '../../types/stripe-helpers';
import { getTodayPacific, getPacificMidnightUTC } from '../../utils/dateUtils';
import { getStripeClient } from '../../core/stripe/client';
import {
  createPaymentIntent,
  confirmPaymentSuccess,
  getPaymentIntentStatus,
  cancelPaymentIntent,
  getOrCreateStripeCustomer
} from '../../core/stripe';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants, getEffectivePlayerCount } from '../../core/billing/unifiedFeeService';
import {
  getRefundablePayments,
  getFailedPayments,
  getPendingAuthorizations,
  getPaymentByIntentId,
  updatePaymentStatus,
  updatePaymentStatusAndAmount
} from '../../core/stripe/paymentRepository';
import { logFromRequest } from '../../core/auditLog';
import { getStaffInfo, MAX_RETRY_ATTEMPTS, GUEST_FEE_CENTS } from './helpers';
import { broadcastBillingUpdate, sendNotificationToUser } from '../../core/websocket';
import { alertOnExternalServiceError } from '../../core/errorAlerts';

const router = Router();

router.get('/api/stripe/prices/recurring', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    const prices = await stripe.prices.list({
      active: true,
      type: 'recurring',
      expand: ['data.product'],
      limit: 100
    });
    
    const formattedPrices = prices.data.map(price => {
      const product = price.product;
      const productName = isExpandedProduct(product) ? product.name : 'Unknown Product';
      const amountDollars = (price.unit_amount || 0) / 100;
      const interval = price.recurring?.interval || 'month';
      
      return {
        id: price.id,
        productId: isExpandedProduct(product) ? product.id : (typeof product === 'string' ? product : 'unknown'),
        productName,
        nickname: price.nickname || null,
        amount: amountDollars,
        amountCents: price.unit_amount || 0,
        currency: price.currency,
        interval,
        displayString: `$${amountDollars}/${interval} - ${price.nickname || productName}`
      };
    });
    
    res.json({ prices: formattedPrices });
  } catch (error: any) {
    console.error('[Stripe] Error fetching recurring prices:', error);
    res.status(500).json({ error: 'Failed to fetch Stripe prices' });
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
    
    if (typeof amountCents !== 'number' || amountCents < 50 || !Number.isFinite(amountCents)) {
      return res.status(400).json({ 
        error: 'Invalid amount. Must be a positive number of at least 50 cents.' 
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

      const existingPendingSnapshot = await pool.query(
        `SELECT bfs.id, bfs.stripe_payment_intent_id, spi.status as pi_status
         FROM booking_fee_snapshots bfs
         LEFT JOIN stripe_payment_intents spi ON bfs.stripe_payment_intent_id = spi.stripe_payment_intent_id
         WHERE bfs.booking_id = $1 AND bfs.status = 'pending'
         AND bfs.created_at > NOW() - INTERVAL '30 minutes'
         ORDER BY bfs.created_at DESC
         LIMIT 1`,
        [bookingId]
      );
      
      if (existingPendingSnapshot.rows.length > 0) {
        const existing = existingPendingSnapshot.rows[0];
        if (existing.stripe_payment_intent_id) {
          try {
            const stripe = await getStripeClient();
            const pi = await stripe.paymentIntents.retrieve(existing.stripe_payment_intent_id);
            if (pi.status === 'succeeded') {
              await confirmPaymentSuccess(existing.stripe_payment_intent_id, 'system', 'Auto-sync');
              return res.status(200).json({ 
                alreadyPaid: true,
                message: 'Payment already completed' 
              });
            } else if (pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation') {
              console.log(`[Stripe] Reusing existing payment intent ${existing.stripe_payment_intent_id}`);
              return res.json({ 
                clientSecret: pi.client_secret, 
                paymentIntentId: pi.id,
                reused: true
              });
            }
          } catch (err) {
            console.warn('[Stripe] Failed to check existing payment intent, creating new one');
          }
        }
      }

      const requestedIds: number[] = participantFees.map((pf: any) => pf.id);

      // Get participant count for effective player count calculation
      const participantCountResult = await pool.query(
        `SELECT COUNT(*) as count FROM booking_participants WHERE session_id = $1`,
        [sessionId]
      );
      const actualParticipantCount = parseInt(participantCountResult.rows[0]?.count || '1');
      const effectivePlayerCount = getEffectivePlayerCount(actualParticipantCount, actualParticipantCount);

      let feeBreakdown;
      try {
        feeBreakdown = await computeFeeBreakdown({
          sessionId,
          declaredPlayerCount: effectivePlayerCount,
          source: 'stripe' as const
        });
        await applyFeeBreakdownToParticipants(sessionId, feeBreakdown);
        console.log(`[Stripe] Applied unified fees for session ${sessionId}: $${(feeBreakdown.totals.totalCents/100).toFixed(2)}`);
      } catch (unifiedError) {
        console.error('[Stripe] Unified fee service error:', unifiedError);
        return res.status(500).json({ error: 'Failed to calculate fees' });
      }

      const pendingFees = feeBreakdown.participants.filter(p => 
        p.participantId && requestedIds.includes(p.participantId) && p.totalCents > 0
      );
      
      if (pendingFees.length === 0) {
        return res.status(400).json({ error: 'No valid pending participants with fees to charge' });
      }
      
      for (const fee of pendingFees) {
        serverFees.push({ id: fee.participantId!, amountCents: fee.totalCents });
      }
      
      console.log(`[Stripe] Calculated ${pendingFees.length} authoritative fees using unified service`);

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
      metadata.participantCount = serverFees.length.toString();
      const participantIds = serverFees.map(f => f.id).join(',');
      metadata.participantIds = participantIds.length > 490 ? participantIds.substring(0, 490) + '...' : participantIds;
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

    logFromRequest(req, 'record_charge', 'payment', result.paymentIntentId, {
      member_email: email,
      amount: serverTotal,
      description: description
    });
    
    res.json({
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret,
      customerId: result.customerId
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating payment intent:', error);
    await alertOnExternalServiceError('Stripe', error, 'create payment intent');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/stripe/confirm-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      staffEmail,
      staffName
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const paymentRecord = await getPaymentByIntentId(paymentIntentId);
    
    broadcastBillingUpdate({
      action: 'payment_succeeded',
      memberEmail: paymentRecord?.memberEmail || paymentRecord?.member_email,
      amount: paymentRecord?.amountCents || paymentRecord?.amount_cents
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error confirming payment:', error);
    await alertOnExternalServiceError('Stripe', error, 'confirm payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
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
    await alertOnExternalServiceError('Stripe', error, 'cancel payment');
    res.status(500).json({ 
      error: 'Payment cancellation failed. Please try again.',
      retryable: true
    });
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
    await alertOnExternalServiceError('Stripe', error, 'create customer');
    res.status(500).json({ 
      error: 'Customer creation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/stripe/cleanup-stale-intents', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const staleIntents = await pool.query(
      `SELECT spi.stripe_payment_intent_id, spi.id as local_id, br.status as booking_status
       FROM stripe_payment_intents spi
       LEFT JOIN booking_requests br ON spi.booking_id = br.id
       WHERE spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')
       AND (br.status = 'cancelled' OR br.id IS NULL)`
    );
    
    const results: { id: string; success: boolean; error?: string }[] = [];
    
    for (const row of staleIntents.rows) {
      try {
        await cancelPaymentIntent(row.stripe_payment_intent_id);
        results.push({ id: row.stripe_payment_intent_id, success: true });
        console.log(`[Cleanup] Cancelled stale payment intent ${row.stripe_payment_intent_id}`);
      } catch (err: any) {
        results.push({ id: row.stripe_payment_intent_id, success: false, error: err.message });
        console.error(`[Cleanup] Failed to cancel ${row.stripe_payment_intent_id}:`, err.message);
      }
    }
    
    res.json({ 
      success: true, 
      processed: results.length,
      cancelled: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      details: results 
    });
  } catch (error: any) {
    console.error('[Stripe] Error cleaning up stale intents:', error);
    res.status(500).json({ error: 'Failed to cleanup stale intents' });
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
        spi.product_id,
        spi.product_name,
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
      // Include trialing and past_due as active - they still have membership access
      sql += ` AND (membership_status IN ('active', 'trialing', 'past_due') OR membership_status IS NULL OR stripe_subscription_id IS NOT NULL)`;
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

router.post('/api/stripe/staff/quick-charge', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberEmail, memberName, amountCents, description, productId, isNewCustomer, firstName, lastName, phone } = req.body;
    const { sessionUser, staffEmail } = getStaffInfo(req);

    if (!memberEmail || amountCents === undefined || amountCents === null) {
      return res.status(400).json({ error: 'Missing required fields: memberEmail, amountCents' });
    }

    const numericAmount = Number(amountCents);
    if (isNaN(numericAmount) || !Number.isFinite(numericAmount)) {
      return res.status(400).json({ error: 'amountCents must be a valid number' });
    }

    if (numericAmount < 50) {
      return res.status(400).json({ error: 'Minimum charge amount is $0.50' });
    }

    if (numericAmount > 99999999) {
      return res.status(400).json({ error: 'Amount exceeds maximum allowed' });
    }

    let member: { id: string; email: string; first_name?: string; last_name?: string; stripe_customer_id?: string } | null = null;
    let resolvedName: string;
    let stripeCustomerId: string | undefined;

    if (isNewCustomer) {
      if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First name and last name are required for new customers' });
      }
      
      resolvedName = `${firstName} ${lastName}`.trim();
      
      const stripe = await getStripeClient();
      
      const existingCustomers = await stripe.customers.list({
        email: memberEmail,
        limit: 1
      });
      
      if (existingCustomers.data.length > 0) {
        stripeCustomerId = existingCustomers.data[0].id;
        console.log(`[Stripe] Found existing customer ${stripeCustomerId} for quick charge: ${memberEmail}`);
      } else {
        const customer = await stripe.customers.create({
          email: memberEmail,
          name: resolvedName,
          phone: phone || undefined,
          metadata: {
            source: 'staff_quick_charge',
            createdBy: staffEmail
          }
        });
        stripeCustomerId = customer.id;
        console.log(`[Stripe] Created new customer ${customer.id} for quick charge: ${memberEmail}`);
      }
    } else {
      const memberResult = await pool.query(
        `SELECT id, email, first_name, last_name, stripe_customer_id 
         FROM users WHERE LOWER(email) = LOWER($1)`,
        [memberEmail]
      );

      if (memberResult.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found in database. Use "Charge someone not in the system" to add a new customer.' });
      }

      member = memberResult.rows[0];
      resolvedName = memberName || [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email.split('@')[0];
      stripeCustomerId = member.stripe_customer_id;
    }

    let finalProductName: string | undefined;
    let finalDescription = description || 'Staff quick charge';

    const customerEmail = member?.email || memberEmail;
    
    if (!productId) {
      console.warn(`[Stripe] Quick charge for ${customerEmail} without productId - purchase reporting will be generic.`);
      if (!description) {
        finalDescription = 'Staff quick charge (no product specified)';
      }
    }

    if (productId) {
      try {
        const stripe = await getStripeClient();
        const product = await stripe.products.retrieve(productId);
        
        finalProductName = product.name;
        if (product.name && !description) {
          finalDescription = `Quick charge - ${product.name}`;
        }
        
        console.log(`[Stripe] Quick charge with product: ${productId} (${product.name})`);
      } catch (productError: any) {
        console.error(`[Stripe] Warning: Could not retrieve product ${productId}:`, productError.message);
        return res.status(400).json({ error: `Product ${productId} not found in Stripe` });
      }
    }

    const result = await createPaymentIntent({
      userId: member?.id?.toString() || 'guest',
      email: customerEmail,
      memberName: resolvedName,
      amountCents: Math.round(numericAmount),
      purpose: 'one_time_purchase',
      description: finalDescription,
      productId,
      productName: finalProductName,
      stripeCustomerId,
      metadata: {
        staffInitiated: 'true',
        staffEmail: staffEmail,
        chargeType: 'quick_charge',
        memberId: member?.id?.toString() || 'guest',
        memberEmail: customerEmail,
        memberName: resolvedName,
        isNewCustomer: isNewCustomer ? 'true' : 'false'
      }
    });

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating quick charge:', error);
    await alertOnExternalServiceError('Stripe', error, 'create quick charge');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/stripe/staff/quick-charge/confirm', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      staffEmail,
      staffName
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Payment confirmation failed' });
    }

    const paymentRecord = await getPaymentByIntentId(paymentIntentId);
    
    broadcastBillingUpdate({
      action: 'payment_succeeded',
      memberEmail: paymentRecord?.memberEmail || paymentRecord?.member_email,
      amount: paymentRecord?.amountCents || paymentRecord?.amount_cents
    });

    console.log(`[Stripe] Quick charge confirmed: ${paymentIntentId} by ${staffEmail}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error confirming quick charge:', error);
    await alertOnExternalServiceError('Stripe', error, 'confirm quick charge');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
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
       LEFT JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
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
    
    const { staffEmail, staffName } = getStaffInfo(req);

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
      performedBy: staffEmail,
      performedByName: staffName
    });

    console.log(`[Payments] Recorded offline ${paymentMethod} payment of ${formattedAmount} for ${memberEmail} by ${staffEmail}`);

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
    const { memberId, memberEmail, memberName, adjustment, reason } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

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
      performedBy: staffEmail,
      performedByName: staffName
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
    const stripe = await getStripeClient();

    const startOfDay = getPacificMidnightUTC();

    const [paymentIntents, passRedemptions] = await Promise.all([
      stripe.paymentIntents.list({
        created: { gte: Math.floor(startOfDay.getTime() / 1000) },
        limit: 50,
        expand: ['data.customer'],
      }),
      db.select({
        id: passRedemptionLogs.id,
        purchaseId: passRedemptionLogs.purchaseId,
        redeemedAt: passRedemptionLogs.redeemedAt,
        redeemedBy: passRedemptionLogs.redeemedBy,
        purchaserEmail: dayPassPurchases.purchaserEmail,
        purchaserFirstName: dayPassPurchases.purchaserFirstName,
        purchaserLastName: dayPassPurchases.purchaserLastName,
        productType: dayPassPurchases.productType,
      })
        .from(passRedemptionLogs)
        .innerJoin(dayPassPurchases, eq(passRedemptionLogs.purchaseId, dayPassPurchases.id))
        .where(gte(passRedemptionLogs.redeemedAt, startOfDay))
        .orderBy(desc(passRedemptionLogs.redeemedAt))
        .limit(20)
    ]);

    const getPaymentEmail = (pi: any): string => {
      if (pi.metadata?.memberEmail) return pi.metadata.memberEmail;
      if (pi.metadata?.email) return pi.metadata.email;
      if (pi.receipt_email) return pi.receipt_email;
      if (typeof pi.customer === 'object' && pi.customer?.email) return pi.customer.email;
      return '';
    };

    const getCustomerName = (pi: any): string | undefined => {
      if (pi.metadata?.memberName) return pi.metadata.memberName;
      if (typeof pi.customer === 'object' && pi.customer?.name) return pi.customer.name;
      return undefined;
    };

    const emails = paymentIntents.data
      .map(getPaymentEmail)
      .filter((e): e is string => !!e);
    
    const memberNameMap = new Map<string, string>();
    if (emails.length > 0) {
      const memberResults = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(inArray(users.email, emails));
      for (const m of memberResults) {
        if (m.email) {
          const name = [m.firstName, m.lastName].filter(Boolean).join(' ');
          memberNameMap.set(m.email.toLowerCase(), name || m.email);
        }
      }
    }

    const stripeTransactions = paymentIntents.data
      .filter(pi => pi.status === 'succeeded' || pi.status === 'processing')
      .map(pi => {
        const email = getPaymentEmail(pi);
        const stripeName = getCustomerName(pi);
        const dbName = email ? memberNameMap.get(email.toLowerCase()) : undefined;
        return {
          id: pi.id,
          amount: pi.amount,
          status: pi.status,
          description: pi.description || pi.metadata?.purpose || 'Payment',
          memberEmail: email,
          memberName: dbName || stripeName || email || 'Unknown',
          createdAt: new Date(pi.created * 1000).toISOString(),
          type: pi.metadata?.purpose || 'payment'
        };
      });

    const passRedemptionTransactions = passRedemptions.map(pr => {
      const guestName = [pr.purchaserFirstName, pr.purchaserLastName].filter(Boolean).join(' ') || 'Guest';
      const productLabel = pr.productType
        ?.split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ')
        .replace(/day pass/i, 'Day Pass') || 'Day Pass';
      return {
        id: `pass-redemption-${pr.id}`,
        amount: 0,
        status: 'succeeded',
        description: `${productLabel} Redeemed`,
        memberEmail: pr.purchaserEmail || '',
        memberName: guestName,
        createdAt: pr.redeemedAt?.toISOString() || new Date().toISOString(),
        type: 'day_pass_redemption'
      };
    });

    const allTransactions = [...stripeTransactions, ...passRedemptionTransactions]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(allTransactions);
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

    const { staffEmail, staffName } = getStaffInfo(req);
    const finalPerformedBy = performedBy || staffEmail;
    const finalPerformedByName = performedByName || staffName;

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
    const payments = await getRefundablePayments();
    res.json(payments);
  } catch (error: any) {
    console.error('[Payments] Error fetching refundable payments:', error);
    res.status(500).json({ error: 'Failed to fetch refundable payments' });
  }
});

router.get('/api/payments/failed', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const payments = await getFailedPayments();
    res.json(payments);
  } catch (error: any) {
    console.error('[Payments] Error fetching failed payments:', error);
    res.status(500).json({ error: 'Failed to fetch failed payments' });
  }
});

router.post('/api/payments/retry', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing required field: paymentIntentId' });
    }

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const retryResult = await pool.query(
      `SELECT retry_count, requires_card_update FROM stripe_payment_intents WHERE stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );
    
    const currentRetryCount = retryResult.rows[0]?.retry_count || 0;
    const requiresCardUpdate = retryResult.rows[0]?.requires_card_update || false;

    if (requiresCardUpdate) {
      return res.status(400).json({ 
        error: 'This payment has reached the maximum retry limit. The member needs to update their payment method.',
        requiresCardUpdate: true,
        retryCount: currentRetryCount
      });
    }

    if (currentRetryCount >= MAX_RETRY_ATTEMPTS) {
      return res.status(400).json({ 
        error: `Maximum retry limit (${MAX_RETRY_ATTEMPTS}) reached. Member must update their card.`,
        requiresCardUpdate: true,
        retryCount: currentRetryCount
      });
    }

    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      await updatePaymentStatus(paymentIntentId, 'succeeded');
      return res.json({ 
        success: true, 
        message: 'Payment was already successful',
        status: 'succeeded'
      });
    }

    if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(paymentIntent.status)) {
      return res.status(400).json({ 
        error: `Cannot retry payment with status: ${paymentIntent.status}` 
      });
    }

    const confirmedIntent = await stripe.paymentIntents.confirm(paymentIntentId);
    const newRetryCount = currentRetryCount + 1;
    const nowReachesLimit = newRetryCount >= MAX_RETRY_ATTEMPTS;

    if (confirmedIntent.status === 'succeeded') {
      await pool.query(
        `UPDATE stripe_payment_intents 
         SET status = 'succeeded', 
             updated_at = NOW(),
             retry_count = $2,
             last_retry_at = NOW(),
             requires_card_update = FALSE
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId, newRetryCount]
      );

      await db.insert(billingAuditLog).values({
        memberEmail: payment.member_email || 'unknown',
        hubspotDealId: null,
        actionType: 'payment_retry_succeeded',
        actionDetails: {
          paymentIntentId,
          retryAttempt: newRetryCount,
          amount: payment.amount_cents
        },
        newValue: `Retry #${newRetryCount} succeeded: $${(payment.amount_cents / 100).toFixed(2)}`,
        performedBy: staffEmail,
        performedByName: staffName
      });

      console.log(`[Payments] Retry #${newRetryCount} succeeded for ${paymentIntentId}`);

      res.json({
        success: true,
        status: 'succeeded',
        retryCount: newRetryCount,
        message: 'Payment retry successful'
      });
    } else {
      const failureReason = confirmedIntent.last_payment_error?.message || `Status: ${confirmedIntent.status}`;
      
      await pool.query(
        `UPDATE stripe_payment_intents 
         SET status = $2, 
             updated_at = NOW(),
             retry_count = $3,
             last_retry_at = NOW(),
             failure_reason = $4,
             requires_card_update = $5
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId, confirmedIntent.status, newRetryCount, failureReason, nowReachesLimit]
      );

      await db.insert(billingAuditLog).values({
        memberEmail: payment.member_email || 'unknown',
        hubspotDealId: null,
        actionType: 'payment_retry_failed',
        actionDetails: {
          paymentIntentId,
          retryAttempt: newRetryCount,
          newStatus: confirmedIntent.status,
          reachedLimit: nowReachesLimit
        },
        newValue: `Retry #${newRetryCount} failed: ${confirmedIntent.status}${nowReachesLimit ? ' (limit reached)' : ''}`,
        performedBy: staffEmail,
        performedByName: staffName
      });

      console.log(`[Payments] Retry #${newRetryCount} failed for ${paymentIntentId}: ${confirmedIntent.status}`);

      res.json({
        success: false,
        status: confirmedIntent.status,
        retryCount: newRetryCount,
        requiresCardUpdate: nowReachesLimit,
        message: nowReachesLimit 
          ? 'Maximum retry attempts reached. Member must update their payment method.'
          : `Payment requires further action: ${confirmedIntent.status}`
      });
    }
  } catch (error: any) {
    console.error('[Payments] Error retrying payment:', error);
    await alertOnExternalServiceError('Stripe', error, 'retry payment');
    res.status(500).json({ 
      error: 'Payment retry failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/payments/cancel', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing required field: paymentIntentId' });
    }

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status === 'succeeded') {
      return res.status(400).json({ error: 'Cannot cancel a succeeded payment. Use refund instead.' });
    }

    if (payment.status === 'canceled') {
      return res.json({ success: true, message: 'Payment was already canceled' });
    }

    const stripe = await getStripeClient();

    try {
      await stripe.paymentIntents.cancel(paymentIntentId);
    } catch (stripeError: any) {
      if (stripeError.code !== 'payment_intent_unexpected_state') {
        throw stripeError;
      }
    }

    await pool.query(
      `UPDATE stripe_payment_intents 
       SET status = 'canceled', updated_at = NOW()
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );

    await db.insert(billingAuditLog).values({
      memberEmail: payment.member_email || 'unknown',
      hubspotDealId: null,
      actionType: 'payment_canceled',
      actionDetails: {
        paymentIntentId,
        amount: payment.amountCents,
        description: payment.description
      },
      newValue: `Canceled payment: $${(payment.amountCents / 100).toFixed(2)}`,
      performedBy: staffEmail,
      performedByName: staffName
    });

    await logFromRequest(req, {
      action: 'cancel_payment',
      resourceType: 'billing',
      resourceId: paymentIntentId,
      resourceName: `$${(payment.amountCents / 100).toFixed(2)} - ${payment.description || 'Payment'}`,
      details: { memberEmail: payment.member_email }
    });

    console.log(`[Payments] Payment ${paymentIntentId} canceled by ${staffEmail}`);

    res.json({ success: true, message: 'Payment canceled successfully' });
  } catch (error: any) {
    console.error('[Payments] Error canceling payment:', error);
    res.status(500).json({ error: error.message || 'Failed to cancel payment' });
  }
});

router.post('/api/payments/refund', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amountCents, reason } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing required field: paymentIntentId' });
    }

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status !== 'succeeded') {
      return res.status(400).json({ error: `Cannot refund payment with status: ${payment.status}` });
    }

    const stripe = await getStripeClient();

    const refundParams: any = {
      payment_intent: paymentIntentId
    };

    if (amountCents && amountCents > 0 && amountCents < payment.amountCents) {
      refundParams.amount = amountCents;
    }

    const refund = await stripe.refunds.create(refundParams);

    const refundedAmount = refund.amount;
    const isPartialRefund = refundedAmount < payment.amountCents;
    const newStatus = isPartialRefund ? 'partially_refunded' : 'refunded';

    await updatePaymentStatus(paymentIntentId, newStatus);

    if (payment.sessionId) {
      try {
        await pool.query(
          `UPDATE booking_participants 
           SET payment_status = 'refunded', updated_at = NOW() 
           WHERE session_id = $1 AND stripe_payment_intent_id = $2`,
          [payment.sessionId, paymentIntentId]
        );
        
        let ledgerEntries = await pool.query(
          `SELECT id, member_id, overage_fee, guest_fee, minutes_charged, stripe_payment_intent_id
           FROM usage_ledger 
           WHERE session_id = $1 
             AND stripe_payment_intent_id = $2
             AND (COALESCE(overage_fee, 0) > 0 OR COALESCE(guest_fee, 0) > 0)
           ORDER BY created_at ASC`,
          [payment.sessionId, paymentIntentId]
        );
        
        if (ledgerEntries.rows.length === 0) {
          console.warn(`[Payments] [OPS_REVIEW_REQUIRED] No ledger entries found with payment_intent_id ${paymentIntentId}, falling back to session-wide entries for session ${payment.sessionId}.`);
          ledgerEntries = await pool.query(
            `SELECT id, member_id, overage_fee, guest_fee, minutes_charged, stripe_payment_intent_id
             FROM usage_ledger 
             WHERE session_id = $1 
               AND (COALESCE(overage_fee, 0) > 0 OR COALESCE(guest_fee, 0) > 0)
             ORDER BY created_at ASC`,
            [payment.sessionId]
          );
        }
        
        if (ledgerEntries.rows.length > 0) {
          const totalLedgerFees = ledgerEntries.rows.reduce((sum, entry) => {
            return sum + (parseFloat(entry.overage_fee) || 0) + (parseFloat(entry.guest_fee) || 0);
          }, 0);
          
          const refundAmountDollars = refundedAmount / 100;
          const refundProportion = totalLedgerFees > 0 
            ? Math.min(1, refundAmountDollars / totalLedgerFees)
            : 1;
          
          let totalReversedOverage = 0;
          let totalReversedGuest = 0;
          const targetReversalTotal = refundAmountDollars;
          
          const reversalAmounts: Array<{
            memberId: string;
            reversedOverage: number;
            reversedGuest: number;
          }> = [];
          
          for (const entry of ledgerEntries.rows) {
            const originalOverage = parseFloat(entry.overage_fee) || 0;
            const originalGuest = parseFloat(entry.guest_fee) || 0;
            
            let reversedOverage = isPartialRefund 
              ? Math.round(originalOverage * refundProportion * 100) / 100
              : originalOverage;
            let reversedGuest = isPartialRefund 
              ? Math.round(originalGuest * refundProportion * 100) / 100
              : originalGuest;
            
            reversalAmounts.push({
              memberId: entry.member_id,
              reversedOverage,
              reversedGuest
            });
            
            totalReversedOverage += reversedOverage;
            totalReversedGuest += reversedGuest;
          }
          
          if (isPartialRefund && reversalAmounts.length > 0) {
            const actualReversalTotal = Math.round((totalReversedOverage + totalReversedGuest) * 100) / 100;
            const remainder = Math.round((targetReversalTotal - actualReversalTotal) * 100) / 100;
            
            if (Math.abs(remainder) > 0.001) {
              if (reversalAmounts[0].reversedOverage > 0 || reversalAmounts[0].reversedGuest === 0) {
                reversalAmounts[0].reversedOverage = Math.round((reversalAmounts[0].reversedOverage + remainder) * 100) / 100;
              } else {
                reversalAmounts[0].reversedGuest = Math.round((reversalAmounts[0].reversedGuest + remainder) * 100) / 100;
              }
              console.log(`[Payments] Applied rounding remainder of $${remainder.toFixed(2)} to first reversal entry`);
            }
          }
          
          let reversalCount = 0;
          for (let i = 0; i < ledgerEntries.rows.length; i++) {
            const entry = ledgerEntries.rows[i];
            const amounts = reversalAmounts[i];
            
            if (amounts.reversedOverage !== 0 || amounts.reversedGuest !== 0) {
              await pool.query(
                `INSERT INTO usage_ledger 
                 (session_id, member_id, minutes_charged, overage_fee, guest_fee, payment_method, source, stripe_payment_intent_id)
                 VALUES ($1, $2, 0, $3, $4, 'waived', 'staff_manual', $5)`,
                [
                  payment.sessionId, 
                  amounts.memberId,
                  (-amounts.reversedOverage).toFixed(2),
                  (-amounts.reversedGuest).toFixed(2),
                  paymentIntentId
                ]
              );
              reversalCount++;
            }
          }
          
          const reversalType = isPartialRefund 
            ? `partial (${(refundProportion * 100).toFixed(1)}%)`
            : 'full';
          console.log(`[Payments] Created ${reversalCount} ${reversalType} ledger reversal(s) for session ${payment.sessionId}, refund: $${refundAmountDollars.toFixed(2)}, linked to payment ${paymentIntentId}`);
        }
        
        console.log(`[Payments] Updated ledger and participants for session ${payment.sessionId}`);
      } catch (ledgerError) {
        console.error('[Payments] Failed to update ledger/participants for refund:', ledgerError);
      }
    }

    await db.insert(billingAuditLog).values({
      memberEmail: payment.memberEmail || 'unknown',
      hubspotDealId: null,
      actionType: 'payment_refunded',
      actionDetails: {
        paymentIntentId,
        refundId: refund.id,
        refundAmount: refundedAmount,
        reason: reason || 'No reason provided',
        originalAmount: payment.amountCents,
        isPartialRefund,
        sessionId: payment.sessionId
      },
      newValue: `Refunded $${(refundedAmount / 100).toFixed(2)} of $${(payment.amountCents / 100).toFixed(2)}`,
      performedBy: staffEmail,
      performedByName: staffName
    });

    console.log(`[Payments] Refund ${refund.id} created for ${paymentIntentId}: $${(refundedAmount / 100).toFixed(2)}`);

    const memberEmail = payment.memberEmail || payment.member_email;
    
    // Notify member directly of refund
    if (memberEmail) {
      sendNotificationToUser(memberEmail, {
        type: 'billing_update',
        title: 'Refund Processed',
        message: `A refund of $${(refundedAmount / 100).toFixed(2)} has been processed to your payment method.`,
        data: { paymentIntentId, refundId: refund.id, amount: refundedAmount }
      });
    }
    
    broadcastBillingUpdate({
      action: 'payment_refunded',
      memberEmail,
      amount: refundedAmount,
      status: newStatus
    });

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
    const authorizations = await getPendingAuthorizations();
    res.json(authorizations);
  } catch (error: any) {
    console.error('[Payments] Error fetching pending authorizations:', error);
    res.status(500).json({ error: 'Failed to fetch pending authorizations' });
  }
});

router.post('/api/payments/capture', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amountCents } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment authorization not found' });
    }

    if (payment.status !== 'requires_capture') {
      return res.status(400).json({ error: `Cannot capture payment with status: ${payment.status}` });
    }

    const stripe = await getStripeClient();

    const captureParams: any = {};
    if (amountCents && amountCents > 0 && amountCents <= payment.amount_cents) {
      captureParams.amount_to_capture = amountCents;
    }

    const capturedPaymentIntent = await stripe.paymentIntents.capture(paymentIntentId, captureParams);

    const capturedAmount = capturedPaymentIntent.amount_received || amountCents || payment.amount_cents;

    await updatePaymentStatusAndAmount(paymentIntentId, 'succeeded', capturedAmount);

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
      performedBy: staffEmail,
      performedByName: staffName
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
    const { staffEmail, staffName } = getStaffInfo(req);

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment authorization not found' });
    }

    if (payment.status !== 'requires_capture') {
      return res.status(400).json({ error: `Cannot void payment with status: ${payment.status}` });
    }

    const stripe = await getStripeClient();

    await stripe.paymentIntents.cancel(paymentIntentId);

    await updatePaymentStatus(paymentIntentId, 'canceled');

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
      performedBy: staffEmail,
      performedByName: staffName
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
    const stripe = await getStripeClient();
    
    const startOfDay = Math.floor(getPacificMidnightUTC().getTime() / 1000);
    const endOfDay = startOfDay + 86400;
    
    const allPaymentIntents: Stripe.PaymentIntent[] = [];
    let piHasMore = true;
    let piStartingAfter: string | undefined;
    
    while (piHasMore && allPaymentIntents.length < 500) {
      const page = await stripe.paymentIntents.list({
        created: { gte: startOfDay, lt: endOfDay },
        limit: 100,
        ...(piStartingAfter && { starting_after: piStartingAfter })
      });
      allPaymentIntents.push(...page.data);
      piHasMore = page.has_more;
      if (page.data.length > 0) {
        piStartingAfter = page.data[page.data.length - 1].id;
      }
    }
    
    const allCharges: Stripe.Charge[] = [];
    let chHasMore = true;
    let chStartingAfter: string | undefined;
    
    while (chHasMore && allCharges.length < 500) {
      const page = await stripe.charges.list({
        created: { gte: startOfDay, lt: endOfDay },
        limit: 100,
        ...(chStartingAfter && { starting_after: chStartingAfter })
      });
      allCharges.push(...page.data);
      chHasMore = page.has_more;
      if (page.data.length > 0) {
        chStartingAfter = page.data[page.data.length - 1].id;
      }
    }
    
    console.log(`[Daily Summary] Fetched ${allPaymentIntents.length} PaymentIntents and ${allCharges.length} Charges for ${today}`);

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
    const processedIds = new Set<string>();

    for (const pi of allPaymentIntents) {
      if (pi.status !== 'succeeded') continue;
      processedIds.add(pi.id);
      
      const purpose = pi.metadata?.purpose || 'other';
      const cents = pi.amount || 0;
      
      transactionCount += 1;
      
      if (purpose === 'guest_fee') {
        breakdown.guest_fee += cents;
      } else if (purpose === 'overage_fee') {
        breakdown.overage += cents;
      } else if (purpose === 'one_time_purchase') {
        breakdown.merchandise += cents;
      } else if (pi.description?.toLowerCase().includes('subscription') || pi.description?.toLowerCase().includes('membership')) {
        breakdown.membership += cents;
      } else {
        breakdown.other += cents;
      }
    }
    
    for (const ch of allCharges) {
      if (!ch.paid || ch.refunded) continue;
      if (ch.payment_intent && processedIds.has(ch.payment_intent as string)) continue;
      
      processedIds.add(ch.id);
      const cents = ch.amount || 0;
      
      transactionCount += 1;
      
      if (ch.invoice) {
        breakdown.membership += cents;
      } else {
        breakdown.other += cents;
      }
    }

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
