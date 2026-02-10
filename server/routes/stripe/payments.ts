import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool } from '../../core/db';
import { db } from '../../db';
import { billingAuditLog, passRedemptionLogs, dayPassPurchases, users } from '../../../shared/schema';
import { eq, gte, desc, inArray, sql } from 'drizzle-orm';
import { getSessionUser } from '../../types/session';
import { isExpandedProduct } from '../../types/stripe-helpers';
import { getTodayPacific, getPacificMidnightUTC } from '../../utils/dateUtils';
import { getStripeClient } from '../../core/stripe/client';
import { isPlaceholderEmail } from '../../core/stripe/customers';
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
import { sendPurchaseReceipt, PurchaseReceiptItem } from '../../emails/paymentEmails';
import { getStaffInfo, MAX_RETRY_ATTEMPTS, GUEST_FEE_CENTS, SAVED_CARD_APPROVAL_THRESHOLD_CENTS } from './helpers';
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

    if (!email || !amountCents || !purpose || !description) {
      return res.status(400).json({ 
        error: 'Missing required fields: email, amountCents, purpose, description' 
      });
    }

    let finalDescription = description;
    if (bookingId) {
      const trackmanLookup = await db.execute(sql`SELECT trackman_booking_id FROM booking_requests WHERE id = ${bookingId}`);
      const trackmanId = trackmanLookup.rows[0]?.trackman_booking_id;
      const displayId = trackmanId || bookingId;
      if (!description.startsWith('#')) {
        finalDescription = `#${displayId} - ${description}`;
      }
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

    let resolvedUserId = userId || '';
    if (!resolvedUserId && email) {
      const { resolveUserByEmail } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(email);
      if (resolved) {
        resolvedUserId = resolved.userId;
      }
    }

    let snapshotId: number | null = null;
    let serverFees: Array<{id: number; amountCents: number}> = [];
    let serverTotal = Math.round(amountCents);
    const isBookingPayment = bookingId && sessionId && participantFees && Array.isArray(participantFees) && participantFees.length > 0;

    if (isBookingPayment) {
      const sessionCheck = await db.execute(sql`SELECT bs.id FROM booking_sessions bs
         JOIN booking_requests br ON br.session_id = bs.id
         WHERE bs.id = ${sessionId} AND br.id = ${bookingId}`);
      if (sessionCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid session/booking combination' });
      }

      const existingPendingSnapshot = await db.execute(sql`SELECT bfs.id, bfs.stripe_payment_intent_id, spi.status as pi_status
         FROM booking_fee_snapshots bfs
         LEFT JOIN stripe_payment_intents spi ON bfs.stripe_payment_intent_id = spi.stripe_payment_intent_id
         WHERE bfs.booking_id = ${bookingId} AND bfs.status = 'pending'
         AND bfs.created_at > NOW() - INTERVAL '30 minutes'
         ORDER BY bfs.created_at DESC
         LIMIT 1`);
      
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
              if (pi.amount !== Math.round(amountCents)) {
                console.warn(`[Stripe] Stale payment intent ${existing.stripe_payment_intent_id}: PI amount ${pi.amount} != requested ${Math.round(amountCents)}, cancelling and creating new one`);
                try {
                  await cancelPaymentIntent(existing.stripe_payment_intent_id);
                } catch (cancelErr) {
                  console.warn('[Stripe] Failed to cancel stale payment intent:', cancelErr);
                }
                await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${existing.id}`);
              } else {
                console.log(`[Stripe] Reusing existing payment intent ${existing.stripe_payment_intent_id}`);
                return res.json({ 
                  clientSecret: pi.client_secret, 
                  paymentIntentId: pi.id,
                  reused: true
                });
              }
            }
          } catch (err) {
            console.warn('[Stripe] Failed to check existing payment intent, creating new one');
          }
        }
      }

      const requestedIds: number[] = participantFees.map((pf: any) => pf.id);

      // Get participant count for effective player count calculation
      const participantCountResult = await db.execute(sql`SELECT COUNT(*) as count FROM booking_participants WHERE session_id = ${sessionId}`);
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
        userId: resolvedUserId,
        email,
        memberName: memberName || email.split('@')[0],
        amountCents: serverTotal,
        purpose,
        bookingId,
        sessionId,
        description: finalDescription,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined
      });
    } catch (stripeErr) {
      if (snapshotId) {
        await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${snapshotId}`);
        console.log(`[Stripe] Deleted orphaned snapshot ${snapshotId} after PaymentIntent creation failed`);
      }
      throw stripeErr;
    }

    if (snapshotId) {
      await db.execute(sql`UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${result.paymentIntentId} WHERE id = ${snapshotId}`);
    }

    logFromRequest(req, 'record_charge', 'payment', result.paymentIntentId, email, {
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
    const staleIntents = await db.execute(sql`SELECT spi.stripe_payment_intent_id, spi.id as local_id, br.status as booking_status
       FROM stripe_payment_intents spi
       LEFT JOIN booking_requests br ON spi.booking_id = br.id
       WHERE spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')
       AND (br.status = 'cancelled' OR br.id IS NULL)`);
    
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

    const { staffEmail } = getStaffInfo(req);
    logFromRequest(req, {
      action: 'staff_view_member_payments',
      resourceType: 'payments',
      resourceId: email,
      resourceName: email,
      details: { viewedBy: staffEmail, targetEmail: email }
    });

    const result = await db.execute(sql`SELECT 
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
       WHERE LOWER(u.email) = ${email.toLowerCase()}
       ORDER BY spi.created_at DESC
       LIMIT 50`);

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
    const searchPattern = `%${searchTerm}%`;
    
    const inactiveFilter = includeInactive !== 'true'
      ? sql` AND (membership_status IN ('active', 'trialing', 'past_due') OR membership_status IS NULL OR stripe_subscription_id IS NOT NULL)`
      : sql``;
    
    const result = await db.execute(sql`
      SELECT 
        id, email, first_name, last_name, 
        membership_tier, membership_status, 
        stripe_customer_id, hubspot_id
      FROM users 
      WHERE (
        LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ${searchPattern}
        OR LOWER(COALESCE(first_name, '')) LIKE ${searchPattern}
        OR LOWER(COALESCE(last_name, '')) LIKE ${searchPattern}
        OR LOWER(COALESCE(email, '')) LIKE ${searchPattern}
      )${inactiveFilter} AND archived_at IS NULL ORDER BY first_name, last_name LIMIT 10
    `);
    
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
    const { memberEmail, memberName, amountCents, description, productId, isNewCustomer, firstName, lastName, phone, dob, tierSlug, tierName, createUser, streetAddress, city, state, zipCode } = req.body;
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
    
    // Prevent creating Stripe customers for placeholder emails
    if (isPlaceholderEmail(memberEmail)) {
      return res.status(400).json({ error: 'Cannot charge placeholder emails. Please use a real email address.' });
    }

    let member: { id: string; email: string; first_name?: string; last_name?: string; stripe_customer_id?: string } | null = null;
    let resolvedName: string;
    let stripeCustomerId: string | undefined;

    if (isNewCustomer) {
      if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First name and last name are required for new customers' });
      }
      
      resolvedName = `${firstName} ${lastName}`.trim();
      
      const { resolveUserByEmail, getOrCreateStripeCustomer: getOrCreateCust } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(memberEmail);
      if (resolved) {
        const custResult = await getOrCreateCust(resolved.userId, memberEmail, resolvedName);
        stripeCustomerId = custResult.customerId;
        console.log(`[Stripe] ${custResult.isNew ? 'Created' : 'Found existing'} customer ${stripeCustomerId} for quick charge: ${memberEmail}`);
      } else {
        const custResult = await getOrCreateCust(memberEmail, memberEmail, resolvedName);
        stripeCustomerId = custResult.customerId;
        console.log(`[Stripe] ${custResult.isNew ? 'Created' : 'Found existing'} customer ${stripeCustomerId} for quick charge: ${memberEmail}`);

        try {
          const existingUser = await db.execute(sql`SELECT id, stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);
          if (existingUser.rows.length === 0) {
            const crypto = await import('crypto');
            const visitorId = crypto.randomUUID();
            await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, membership_status, stripe_customer_id, data_source, visitor_type, role, street_address, city, state, zip_code, created_at, updated_at)
               VALUES (${visitorId}, ${memberEmail}, ${firstName}, ${lastName}, 'visitor', ${stripeCustomerId}, 'APP', 'day_pass', 'visitor', ${streetAddress || null}, ${city || null}, ${state || null}, ${zipCode || null}, NOW(), NOW())
               ON CONFLICT (email) DO UPDATE SET
                 stripe_customer_id = COALESCE(users.stripe_customer_id, EXCLUDED.stripe_customer_id),
                 first_name = COALESCE(NULLIF(users.first_name, ''), EXCLUDED.first_name),
                 last_name = COALESCE(NULLIF(users.last_name, ''), EXCLUDED.last_name),
                 street_address = COALESCE(NULLIF(EXCLUDED.street_address, ''), users.street_address),
                 city = COALESCE(NULLIF(EXCLUDED.city, ''), users.city),
                 state = COALESCE(NULLIF(EXCLUDED.state, ''), users.state),
                 zip_code = COALESCE(NULLIF(EXCLUDED.zip_code, ''), users.zip_code),
                 updated_at = NOW()`);
            console.log(`[QuickCharge] Created visitor record for new customer: ${memberEmail}`);
          } else if (!existingUser.rows[0].stripe_customer_id) {
            await db.execute(sql`UPDATE users SET stripe_customer_id = ${stripeCustomerId}, updated_at = NOW() WHERE id = ${existingUser.rows[0].id}`);
            console.log(`[QuickCharge] Linked Stripe customer ${stripeCustomerId} to existing user: ${memberEmail}`);
          }
        } catch (visitorErr: any) {
          console.warn('[QuickCharge] Could not create visitor record (non-blocking):', visitorErr.message);
        }
      }
      
    } else {
      const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id 
         FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

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
        isNewCustomer: isNewCustomer ? 'true' : 'false',
        createUser: createUser ? 'true' : 'false',
        tierSlug: tierSlug || '',
        tierName: tierName || '',
        firstName: firstName || '',
        lastName: lastName || '',
        phone: phone || '',
        dob: dob || ''
      }
    });

    logFromRequest(req, 'initiate_charge', 'payment', result.paymentIntentId, customerEmail, {
      amountCents: numericAmount,
      description: finalDescription,
      productId: productId || null,
      productName: finalProductName || null,
      isNewCustomer: !!isNewCustomer,
      source: 'pos_quick_charge'
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

    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const metadata = paymentIntent.metadata || {};
    
    if (metadata.createUser === 'true' && metadata.tierSlug && metadata.memberEmail) {
      const tierSlug = metadata.tierSlug;
      const tierName = metadata.tierName || tierSlug;
      const memberEmail = metadata.memberEmail;
      const firstName = metadata.firstName || '';
      const lastName = metadata.lastName || '';
      const phone = metadata.phone || null;
      const dob = metadata.dob || null;
      const stripeCustomerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id;
      
      const tierResult = await db.execute(sql`SELECT name FROM membership_tiers WHERE slug = ${tierSlug} OR name = ${tierSlug}`);
      const validatedTierName = tierResult.rows[0]?.name || tierName;
      
      // Check if this email resolves to an existing user via linked email
      const { resolveUserByEmail } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(memberEmail);
      if (resolved) {
        // Update existing user (found directly or via linked email)
        await db.execute(sql`UPDATE users SET tier = ${validatedTierName}, billing_provider = 'stripe', stripe_customer_id = COALESCE(${stripeCustomerId}, stripe_customer_id)
           WHERE id = ${resolved.userId}`);
        console.log(`[Stripe] Updated user ${resolved.primaryEmail} with tier ${validatedTierName} after payment confirmation (matched via ${resolved.matchType})`);
      } else {
        const userId = require('crypto').randomUUID();
        await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, stripe_customer_id, created_at)
           VALUES (${userId}, ${memberEmail.toLowerCase()}, ${firstName}, ${lastName}, ${phone}, ${dob}, ${validatedTierName}, 'inactive', 'stripe', ${stripeCustomerId || null}, NOW())`);
        console.log(`[Stripe] Created user ${memberEmail} with tier ${validatedTierName} after payment confirmation`);
      }
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

// Staff charge member's saved card directly (off-session)
router.post('/api/stripe/staff/charge-saved-card', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberEmail, bookingId, sessionId, participantIds } = req.body;
    const { staffEmail, staffName, sessionUser } = getStaffInfo(req);

    if (!memberEmail) {
      return res.status(400).json({ error: 'Missing required field: memberEmail' });
    }

    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ error: 'Missing required field: participantIds' });
    }

    // Get member and their Stripe customer
    const memberResult = await db.execute(sql`SELECT id, email, name, first_name, last_name, stripe_customer_id 
       FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0];
    const memberName = member.name || [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

    // CRITICAL: Validate participantIds and compute amount from authoritative cached fees
    const participantResult = await db.execute(sql`SELECT bp.id, bp.session_id, bp.cached_fee_cents, bp.payment_status, bs.booking_id
       FROM booking_participants bp
       JOIN booking_sessions bs ON bp.session_id = bs.id
       WHERE bp.id IN (${sql.join(participantIds.map((id: number) => sql`${id}`), sql`, `)}) AND bp.payment_status = 'pending'`);

    if (participantResult.rows.length === 0) {
      return res.status(400).json({ error: 'No pending participants found for the provided IDs' });
    }

    // Verify all requested participants were found
    const foundIds = new Set(participantResult.rows.map(r => r.id));
    const missingIds = participantIds.filter((id: number) => !foundIds.has(id));
    if (missingIds.length > 0) {
      return res.status(400).json({ error: `Some participant IDs not found or already paid: ${missingIds.join(', ')}` });
    }

    // Verify all participants are from the same booking if bookingId provided
    if (bookingId) {
      const wrongBooking = participantResult.rows.filter(r => r.booking_id !== bookingId);
      if (wrongBooking.length > 0) {
        return res.status(400).json({ error: 'Participant IDs do not belong to the specified booking' });
      }
    }

    // Compute authoritative amount from cached fees (TRUST DATABASE, NOT CLIENT)
    const authoritativeAmountCents = participantResult.rows.reduce(
      (sum, r) => sum + (r.cached_fee_cents || 0), 0
    );

    if (authoritativeAmountCents < 50) {
      return res.status(400).json({ error: 'Total amount too small to charge (minimum $0.50)' });
    }

    if (authoritativeAmountCents >= SAVED_CARD_APPROVAL_THRESHOLD_CENTS) {
      if (sessionUser?.role !== 'admin') {
        return res.status(403).json({
          error: 'Charges above $500 require manager approval. Please ask an admin to process this charge.',
          requiresApproval: true,
          thresholdCents: SAVED_CARD_APPROVAL_THRESHOLD_CENTS
        });
      }
      logFromRequest(req, 'large_charge_approved', 'payment', null, memberEmail, {
        amountCents: authoritativeAmountCents,
        approvedBy: staffEmail,
        role: 'admin',
        chargeType: 'saved_card'
      });
    }

    const resolvedSessionId = participantResult.rows[0].session_id;
    const resolvedBookingId = participantResult.rows[0].booking_id;

    if (resolvedBookingId) {
      const existingPaymentResult = await db.execute(sql`
        SELECT stripe_payment_intent_id, status, amount_cents 
        FROM stripe_payment_intents 
        WHERE booking_id = ${resolvedBookingId} 
        AND status = 'succeeded'
        AND purpose IN ('prepayment', 'booking_fee')
        LIMIT 1`);

      if (existingPaymentResult.rows.length > 0) {
        const existingPayment = existingPaymentResult.rows[0];
        return res.status(409).json({ 
          error: 'Payment already collected for this booking',
          existingPaymentId: existingPayment.stripe_payment_intent_id
        });
      }
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ 
        error: 'Member does not have a Stripe account. They need to make a payment first to save their card.',
        noStripeCustomer: true
      });
    }

    const stripe = await getStripeClient();

    // Get customer's saved payment methods
    const paymentMethods = await stripe.paymentMethods.list({
      customer: member.stripe_customer_id,
      type: 'card'
    });

    if (paymentMethods.data.length === 0) {
      return res.status(400).json({ 
        error: 'Member has no saved card on file. They need to make a payment first to save their card.',
        noSavedCard: true
      });
    }

    // Use the first (most recent) payment method
    const paymentMethod = paymentMethods.data[0];
    const cardLast4 = paymentMethod.card?.last4 || '****';
    const cardBrand = paymentMethod.card?.brand || 'card';

    // Create and confirm payment intent off-session using AUTHORITATIVE amount
    const paymentIntent = await stripe.paymentIntents.create({
      amount: authoritativeAmountCents,
      currency: 'usd',
      customer: member.stripe_customer_id,
      payment_method: paymentMethod.id,
      confirm: true,
      off_session: true,
      description: `Booking fees charged by staff`,
      metadata: {
        type: 'staff_saved_card_charge',
        staffEmail: staffEmail,
        staffName: staffName || '',
        memberEmail: member.email,
        memberId: member.id,
        bookingId: resolvedBookingId?.toString() || '',
        sessionId: resolvedSessionId?.toString() || '',
        participantIds: JSON.stringify(participantIds),
        authoritativeAmountCents: authoritativeAmountCents.toString()
      }
    });

    if (paymentIntent.status === 'succeeded') {
      // If participantIds provided, mark them as paid
      if (participantIds && Array.isArray(participantIds) && participantIds.length > 0) {
        await db.execute(sql`UPDATE booking_participants 
           SET payment_status = 'paid', 
               stripe_payment_intent_id = ${paymentIntent.id},
               paid_at = NOW()
           WHERE id IN (${sql.join(participantIds.map((id: number) => sql`${id}`), sql`, `)})`);
        console.log(`[Stripe] Staff charged saved card: $${(authoritativeAmountCents / 100).toFixed(2)} for ${member.email}, marked ${participantIds.length} participants as paid`);
      }

      // Record the payment
      await db.execute(sql`INSERT INTO stripe_payment_intents 
          (payment_intent_id, member_email, member_id, amount_cents, status, purpose, description, created_by)
         VALUES (${paymentIntent.id}, ${member.email}, ${member.id}, ${authoritativeAmountCents}, 'succeeded', 'booking_fee', ${'Staff charged saved card'}, ${staffEmail})
         ON CONFLICT (payment_intent_id) DO UPDATE SET status = 'succeeded', updated_at = NOW()`);

      // Log the action
      const staffActionDetails = JSON.stringify({
          amountCents: authoritativeAmountCents,
          cardLast4,
          cardBrand,
          paymentIntentId: paymentIntent.id,
          bookingId: resolvedBookingId,
          sessionId: resolvedSessionId
        });
      await db.execute(sql`INSERT INTO staff_actions (action_type, staff_email, staff_name, target_email, details, created_at)
         VALUES ('charge_saved_card', ${staffEmail}, ${staffName || ''}, ${member.email}, ${staffActionDetails}, NOW())`);

      broadcastBillingUpdate({
        action: 'payment_succeeded',
        memberEmail: member.email,
        amount: authoritativeAmountCents
      });


      res.json({ 
        success: true, 
        message: `Charged ${cardBrand} ending in ${cardLast4}: $${(authoritativeAmountCents / 100).toFixed(2)}`,
        paymentIntentId: paymentIntent.id,
        cardLast4,
        cardBrand,
        amountCharged: authoritativeAmountCents
      });
    } else {
      // Payment requires additional action (3D Secure, etc.)
      console.warn(`[Stripe] Saved card charge requires action: ${paymentIntent.status} for ${member.email}`);
      res.status(400).json({ 
        error: `Payment requires additional verification. Please use the standard payment flow.`,
        requiresAction: true,
        status: paymentIntent.status
      });
    }
  } catch (error: any) {
    console.error('[Stripe] Error charging saved card:', error);
    
    // Handle specific Stripe errors
    if (error.type === 'StripeCardError') {
      return res.status(400).json({ 
        error: `Card declined: ${error.message}`,
        cardError: true,
        declineCode: error.decline_code
      });
    }
    
    if (error.code === 'authentication_required') {
      return res.status(400).json({ 
        error: 'Card requires authentication. Please use the standard payment flow.',
        requiresAction: true
      });
    }

    await alertOnExternalServiceError('Stripe', error, 'charge saved card');
    res.status(500).json({ 
      error: 'Failed to charge card. Please try again or use another payment method.',
      retryable: true
    });
  }
});

router.post('/api/stripe/staff/charge-saved-card-pos', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberEmail, memberName, amountCents, description, productId } = req.body;
    const { staffEmail, staffName, sessionUser } = getStaffInfo(req);

    if (!memberEmail || !amountCents) {
      return res.status(400).json({ error: 'Missing required fields: memberEmail, amountCents' });
    }

    const numericAmount = Number(amountCents);
    if (isNaN(numericAmount) || !Number.isFinite(numericAmount) || numericAmount < 50) {
      return res.status(400).json({ error: 'Amount must be at least $0.50' });
    }

    if (numericAmount > 99999999) {
      return res.status(400).json({ error: 'Amount exceeds maximum allowed' });
    }

    if (numericAmount >= SAVED_CARD_APPROVAL_THRESHOLD_CENTS) {
      if (sessionUser?.role !== 'admin') {
        return res.status(403).json({
          error: 'Charges above $500 require manager approval. Please ask an admin to process this charge.',
          requiresApproval: true,
          thresholdCents: SAVED_CARD_APPROVAL_THRESHOLD_CENTS
        });
      }
      logFromRequest(req, 'large_charge_approved', 'payment', null, memberEmail, {
        amountCents: numericAmount,
        approvedBy: staffEmail,
        role: 'admin',
        chargeType: 'saved_card_pos'
      });
    }

    const memberResult = await db.execute(sql`SELECT id, email, name, first_name, last_name, stripe_customer_id 
       FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0];
    const resolvedName = memberName || [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

    if (!member.stripe_customer_id) {
      return res.status(400).json({
        error: 'Customer does not have a Stripe account yet. Use Online Card instead.',
        noStripeCustomer: true
      });
    }

    const stripe = await getStripeClient();

    const paymentMethods = await stripe.paymentMethods.list({
      customer: member.stripe_customer_id,
      type: 'card'
    });

    if (paymentMethods.data.length === 0) {
      return res.status(400).json({
        error: 'No saved card on file. Use Online Card instead.',
        noSavedCard: true
      });
    }

    const paymentMethod = paymentMethods.data[0];
    const cardLast4 = paymentMethod.card?.last4 || '****';
    const cardBrand = paymentMethod.card?.brand || 'card';

    const paymentIntent = await stripe.paymentIntents.create({
      amount: numericAmount,
      currency: 'usd',
      customer: member.stripe_customer_id,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      description: description || 'POS purchase',
      metadata: {
        type: 'staff_pos_saved_card',
        staffEmail,
        staffName: staffName || staffEmail,
        memberId: member.id?.toString() || '',
        memberEmail: member.email,
        memberName: resolvedName,
        source: 'pos',
        productId: productId || ''
      }
    });

    if (paymentIntent.status === 'succeeded') {
      await db.execute(sql`INSERT INTO billing_audit_log (payment_intent_id, member_email, member_id, amount_cents, description, staff_email, created_at)
         VALUES (${paymentIntent.id}, ${member.email}, ${member.id}, ${numericAmount}, ${description || 'POS saved card charge'}, ${staffEmail}, NOW())`);

      logFromRequest(req, 'charge_saved_card', 'payment', paymentIntent.id, member.email, {
        amountCents: numericAmount,
        description: description || 'POS saved card charge',
        cardLast4,
        cardBrand,
        source: 'pos'
      });


      res.json({
        success: true,
        paymentIntentId: paymentIntent.id,
        cardLast4,
        cardBrand
      });
    } else if (paymentIntent.status === 'requires_action') {
      res.status(400).json({
        error: 'Card requires additional verification. Use Online Card instead so the customer can authenticate.',
        requiresAction: true
      });
    } else {
      res.status(400).json({
        error: `Payment not completed (status: ${paymentIntent.status}). Try Online Card instead.`
      });
    }
  } catch (error: any) {
    console.error('[Stripe] Error with POS saved card charge:', error);

    if (error.type === 'StripeCardError') {
      return res.status(400).json({
        error: `Card declined: ${error.message}`,
        cardError: true
      });
    }

    await alertOnExternalServiceError('Stripe', error, 'pos saved card charge');
    res.status(500).json({
      error: 'Failed to charge card. Please try another payment method.',
      retryable: true
    });
  }
});

// Check if member has a saved card on file
router.get('/api/stripe/staff/check-saved-card/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const memberEmail = decodeURIComponent(req.params.email).toLowerCase();

    const { staffEmail } = getStaffInfo(req);
    logFromRequest(req, {
      action: 'staff_view_member_card_info',
      resourceType: 'payment_method',
      resourceId: memberEmail,
      resourceName: memberEmail,
      details: { viewedBy: staffEmail, targetEmail: memberEmail }
    });

    const memberResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0 || !memberResult.rows[0].stripe_customer_id) {
      return res.json({ hasSavedCard: false });
    }

    const stripe = await getStripeClient();
    const paymentMethods = await stripe.paymentMethods.list({
      customer: memberResult.rows[0].stripe_customer_id,
      type: 'card',
      limit: 1
    });

    if (paymentMethods.data.length === 0) {
      return res.json({ hasSavedCard: false });
    }

    const card = paymentMethods.data[0].card;
    res.json({ 
      hasSavedCard: true,
      cardLast4: card?.last4,
      cardBrand: card?.brand,
      cardExpMonth: card?.exp_month,
      cardExpYear: card?.exp_year
    });
  } catch (error: any) {
    if (error?.code === 'resource_missing') {
      console.warn(`[Stripe] Stale customer ID for ${req.params.email} — returning hasSavedCard: false`);
    } else {
      console.error('[Stripe] Error checking saved card:', error);
    }
    res.json({ hasSavedCard: false, error: 'Could not check saved card' });
  }
});

router.get('/api/staff/member-balance/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const memberEmail = decodeURIComponent(req.params.email).toLowerCase();

    const { staffEmail } = getStaffInfo(req);
    logFromRequest(req, {
      action: 'staff_view_member_balance',
      resourceType: 'balance',
      resourceId: memberEmail,
      resourceName: memberEmail,
      details: { viewedBy: staffEmail, targetEmail: memberEmail }
    });

    const result = await db.execute(sql`SELECT 
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
       WHERE LOWER(bp.user_id) = ${memberEmail}
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
       ORDER BY bs.session_date DESC`);

    const guestResult = await db.execute(sql`SELECT 
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
         AND LOWER(owner_bp.user_id) = ${memberEmail}
         AND bp.cached_fee_cents > 0`);

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


router.post('/api/purchases/send-receipt', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email, memberName, items, totalAmount, paymentMethod, paymentIntentId } = req.body;

    if (!email || !memberName || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: email, memberName, items' });
    }

    const numericTotal = Number(totalAmount);
    if (!totalAmount || isNaN(numericTotal) || numericTotal <= 0) {
      return res.status(400).json({ error: 'totalAmount must be a positive number' });
    }

    const receiptItems: PurchaseReceiptItem[] = items.map((item: any) => ({
      name: item.name || 'Unknown Item',
      quantity: item.quantity || 1,
      unitPrice: item.unitPrice || 0,
      total: item.total || 0
    }));

    const result = await sendPurchaseReceipt(email, {
      memberName,
      items: receiptItems,
      totalAmount,
      paymentMethod: paymentMethod || 'card',
      paymentIntentId,
      date: new Date()
    });

    if (result.success) {
      logFromRequest(req, 'send_receipt', 'payment', paymentIntentId || undefined, memberName, {
        email,
        totalAmount,
        itemCount: items.length,
        paymentMethod
      });

      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send receipt' });
    }
  } catch (error: any) {
    console.error('[Purchases] Error sending receipt:', error);
    res.status(500).json({ error: 'Failed to send receipt email' });
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

    const existingResult = await db.execute(sql`SELECT id, passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = ${memberEmail.toLowerCase()}`);

    let previousCount = 0;
    let newCount = 0;
    let passesUsed = 0;

    if (existingResult.rows.length === 0) {
      newCount = Math.max(0, adjustment);
      await db.execute(sql`INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES (${memberEmail.toLowerCase()}, 0, ${newCount})`);
      console.log(`[GuestPasses] Created new record for ${memberEmail} with ${newCount} passes`);
    } else {
      const current = existingResult.rows[0];
      previousCount = current.passes_total || 0;
      passesUsed = current.passes_used || 0;
      newCount = Math.max(0, previousCount + adjustment);

      await db.execute(sql`UPDATE guest_passes SET passes_total = ${newCount} WHERE id = ${current.id}`);
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

    const piResult = await db.execute(sql`SELECT u.email as member_email 
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.stripe_payment_intent_id = ${transactionId}`);

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

    const result = await db.execute(sql`SELECT id, action_details->>'note' as note, performed_by_name, created_at
       FROM billing_audit_log
       WHERE action_type = 'payment_note_added'
         AND action_details->>'paymentIntentId' = ${paymentIntentId}
       ORDER BY created_at DESC`);

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

    const retryResult = await db.execute(sql`SELECT retry_count, requires_card_update FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${paymentIntentId}`);
    
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
      await db.execute(sql`UPDATE stripe_payment_intents 
         SET status = 'succeeded', 
             updated_at = NOW(),
             retry_count = ${newRetryCount},
             last_retry_at = NOW(),
             requires_card_update = FALSE
         WHERE stripe_payment_intent_id = ${paymentIntentId}`);

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
      
      await db.execute(sql`UPDATE stripe_payment_intents 
         SET status = ${confirmedIntent.status}, 
             updated_at = NOW(),
             retry_count = ${newRetryCount},
             last_retry_at = NOW(),
             failure_reason = ${failureReason},
             requires_card_update = ${nowReachesLimit}
         WHERE stripe_payment_intent_id = ${paymentIntentId}`);

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

    await db.execute(sql`UPDATE stripe_payment_intents 
       SET status = 'canceled', updated_at = NOW()
       WHERE stripe_payment_intent_id = ${paymentIntentId}`);

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
        await db.execute(sql`UPDATE booking_participants 
           SET payment_status = 'refunded', updated_at = NOW() 
           WHERE session_id = ${payment.sessionId} AND stripe_payment_intent_id = ${paymentIntentId}`);
        
        let ledgerEntries = await db.execute(sql`SELECT id, member_id, overage_fee, guest_fee, minutes_charged, stripe_payment_intent_id
           FROM usage_ledger 
           WHERE session_id = ${payment.sessionId} 
             AND stripe_payment_intent_id = ${paymentIntentId}
             AND (COALESCE(overage_fee, 0) > 0 OR COALESCE(guest_fee, 0) > 0)
           ORDER BY created_at ASC`);
        
        if (ledgerEntries.rows.length === 0) {
          console.warn(`[Payments] [OPS_REVIEW_REQUIRED] No ledger entries found with payment_intent_id ${paymentIntentId}, falling back to session-wide entries for session ${payment.sessionId}.`);
          ledgerEntries = await db.execute(sql`SELECT id, member_id, overage_fee, guest_fee, minutes_charged, stripe_payment_intent_id
             FROM usage_ledger 
             WHERE session_id = ${payment.sessionId} 
               AND (COALESCE(overage_fee, 0) > 0 OR COALESCE(guest_fee, 0) > 0)
             ORDER BY created_at ASC`);
        }
        
        if (ledgerEntries.rows.length > 0) {
          const totalLedgerFeeCents = ledgerEntries.rows.reduce((sum, entry) => {
            return sum + Math.round((parseFloat(entry.overage_fee) || 0) * 100) + Math.round((parseFloat(entry.guest_fee) || 0) * 100);
          }, 0);
          
          const refundCents = refundedAmount;
          const refundProportion = totalLedgerFeeCents > 0 
            ? Math.min(1, refundCents / totalLedgerFeeCents)
            : 1;
          
          let totalReversedOverageCents = 0;
          let totalReversedGuestCents = 0;
          const targetReversalCents = refundCents;
          
          const reversalAmounts: Array<{
            memberId: string;
            reversedOverageCents: number;
            reversedGuestCents: number;
          }> = [];
          
          for (const entry of ledgerEntries.rows) {
            const originalOverageCents = Math.round((parseFloat(entry.overage_fee) || 0) * 100);
            const originalGuestCents = Math.round((parseFloat(entry.guest_fee) || 0) * 100);
            
            let reversedOverageCents = isPartialRefund 
              ? Math.round(originalOverageCents * refundProportion)
              : originalOverageCents;
            let reversedGuestCents = isPartialRefund 
              ? Math.round(originalGuestCents * refundProportion)
              : originalGuestCents;
            
            reversalAmounts.push({
              memberId: entry.member_id,
              reversedOverageCents,
              reversedGuestCents
            });
            
            totalReversedOverageCents += reversedOverageCents;
            totalReversedGuestCents += reversedGuestCents;
          }
          
          if (isPartialRefund && reversalAmounts.length > 0) {
            const actualReversalCents = totalReversedOverageCents + totalReversedGuestCents;
            const remainderCents = targetReversalCents - actualReversalCents;
            
            if (remainderCents !== 0) {
              if (reversalAmounts[0].reversedOverageCents > 0 || reversalAmounts[0].reversedGuestCents === 0) {
                reversalAmounts[0].reversedOverageCents += remainderCents;
              } else {
                reversalAmounts[0].reversedGuestCents += remainderCents;
              }
              console.log(`[Payments] Applied rounding remainder of $${(remainderCents / 100).toFixed(2)} to first reversal entry`);
            }
          }
          
          let reversalCount = 0;
          for (let i = 0; i < ledgerEntries.rows.length; i++) {
            const entry = ledgerEntries.rows[i];
            const amounts = reversalAmounts[i];
            
            if (amounts.reversedOverageCents !== 0 || amounts.reversedGuestCents !== 0) {
              await db.execute(sql`INSERT INTO usage_ledger 
                 (session_id, member_id, minutes_charged, overage_fee, guest_fee, payment_method, source, stripe_payment_intent_id)
                 VALUES (${payment.sessionId}, ${amounts.memberId}, 0, ${(-amounts.reversedOverageCents / 100).toFixed(2)}, ${(-amounts.reversedGuestCents / 100).toFixed(2)}, 'waived', 'staff_manual', ${paymentIntentId})`);
              reversalCount++;
            }
          }
          
          const reversalType = isPartialRefund 
            ? `partial (${(refundProportion * 100).toFixed(1)}%)`
            : 'full';
          console.log(`[Payments] Created ${reversalCount} ${reversalType} ledger reversal(s) for session ${payment.sessionId}, refund: $${(refundCents / 100).toFixed(2)}, linked to payment ${paymentIntentId}`);
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

router.get('/api/payments/future-bookings-with-fees', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await db.execute(sql`SELECT 
        br.id as booking_id,
        br.user_email,
        br.user_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.session_id,
        br.status,
        br.player_count,
        r.name as resource_name,
        r.type as resource_type,
        u.tier,
        u.first_name,
        u.last_name,
        COALESCE(
          (SELECT SUM(bp.cached_fee_cents) FROM booking_participants bp WHERE bp.session_id = br.session_id AND bp.payment_status IN ('pending', NULL)),
          0
        ) as pending_fee_cents,
        COALESCE(
          (SELECT SUM(ul.overage_fee * 100 + ul.guest_fee * 100) FROM usage_ledger ul WHERE ul.session_id = br.session_id),
          0
        ) as ledger_fee_cents,
        (SELECT COUNT(*) FROM stripe_payment_intents spi WHERE spi.booking_id = br.id AND spi.status NOT IN ('succeeded', 'canceled')) as pending_intent_count,
        (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id AND bp.participant_type = 'guest') as guest_count
      FROM booking_requests br
      LEFT JOIN resources r ON r.id = br.bay_id
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE br.status IN ('approved', 'confirmed')
      AND br.request_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
      AND r.type != 'conference_room'
      ORDER BY br.request_date, br.start_time
      LIMIT 50`);

    const futureBookings = result.rows.map(row => {
      const totalFeeCents = Math.max(
        parseInt(row.pending_fee_cents) || 0,
        parseInt(row.ledger_fee_cents) || 0
      );
      
      return {
        bookingId: row.booking_id,
        memberEmail: row.user_email,
        memberName: row.first_name && row.last_name 
          ? `${row.first_name} ${row.last_name}` 
          : row.user_name || row.user_email,
        tier: row.tier,
        date: row.request_date,
        startTime: row.start_time,
        endTime: row.end_time,
        resourceName: row.resource_name,
        status: row.status,
        playerCount: row.player_count || 1,
        guestCount: parseInt(row.guest_count) || 0,
        estimatedFeeCents: totalFeeCents,
        hasPaymentIntent: parseInt(row.pending_intent_count) > 0
      };
    });

    res.json(futureBookings);
  } catch (error: any) {
    console.error('[Payments] Error fetching future bookings with fees:', error);
    res.status(500).json({ error: 'Failed to fetch future bookings' });
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

    const offlineResult = await db.execute(sql`SELECT 
        action_details->>'paymentMethod' as payment_method,
        action_details->>'category' as category,
        (action_details->>'amountCents')::int as amount_cents
       FROM billing_audit_log
       WHERE action_type = 'offline_payment'
         AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = ${today}`);

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
