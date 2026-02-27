import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getMemberTierByEmail, getTierLimits, getDailyBookedMinutes } from '../../core/tierService';
import { getOrCreateStripeCustomer, createBalanceAwarePayment } from '../../core/stripe';
import { getStripeClient } from '../../core/stripe/client';
import { calculateOverageCents, PRICING } from '../../core/billing/pricingConfig';
import { normalizeEmail } from '../../core/utils/emailNormalization';
import { getSessionUser } from '../../types/session';
import { logger } from '../../core/logger';
import { logFromRequest } from '../../core/auditLog';

interface ExistingPrepaymentRow {
  id: number;
  status: string;
  payment_intent_id: string | null;
}

interface UserRow {
  id: string;
  stripe_customer_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

interface PrepaymentInsertRow {
  id: number;
}

interface PrepaymentDetailRow {
  id: number;
  member_email: string;
  booking_date: string;
  start_time: string;
  duration_minutes: number;
  amount_cents: number;
  payment_type: string;
  payment_intent_id: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  booking_request_id: number | null;
  stripe_payment_intent_id: string | null;
}

const router = Router();

interface PrepayEstimateRequest {
  memberEmail: string;
  date: string;
  startTime: string;
  durationMinutes: number;
}

interface PrepayEstimateResponse {
  totalCents: number;
  overageMinutes: number;
  dailyAllowance: number;
  usedToday: number;
  paymentRequired: boolean;
}

interface CreateIntentRequest {
  memberEmail: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  useCredit?: boolean;
}

router.post('/api/member/conference/prepay/estimate', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { memberEmail: rawMemberEmail, date, startTime, durationMinutes } = req.body as PrepayEstimateRequest;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();

    if (!memberEmail || !date || !startTime || !durationMinutes) {
      return res.status(400).json({ error: 'Missing required fields: memberEmail, date, startTime, durationMinutes' });
    }

    if (typeof durationMinutes !== 'number' || durationMinutes <= 0) {
      return res.status(400).json({ error: 'durationMinutes must be a positive number' });
    }

    const normalizedEmail = normalizeEmail(memberEmail);
    
    if (normalizedEmail.toLowerCase() !== sessionUser.email.toLowerCase()) {
      return res.status(403).json({ error: 'Can only estimate prepayment for your own bookings' });
    }

    const tierName = await getMemberTierByEmail(normalizedEmail);
    if (!tierName) {
      return res.status(400).json({ error: 'Member not found or inactive membership' });
    }

    const tierLimits = await getTierLimits(tierName);
    const dailyAllowance = tierLimits.daily_conf_room_minutes || 0;

    const usedToday = await getDailyBookedMinutes(normalizedEmail, date, 'conference_room');

    const remainingAllowance = Math.max(0, dailyAllowance - usedToday);
    const overageMinutes = Math.max(0, durationMinutes - remainingAllowance);

    const totalCents = calculateOverageCents(overageMinutes);

    const response: PrepayEstimateResponse = {
      totalCents,
      overageMinutes,
      dailyAllowance,
      usedToday,
      paymentRequired: totalCents > 0
    };

    logger.info('[ConferencePrepay] Estimate calculated', {
      extra: { memberEmail: normalizedEmail, date, durationMinutes, overageMinutes, totalCents }
    });

    try { logFromRequest(req, { action: 'create_conference_prepayment', resourceType: 'payment', details: { memberEmail: normalizedEmail, date, startTime, durationMinutes, overageMinutes, totalCents, estimateOnly: true } }); } catch (auditErr) { logger.warn('[Audit] Failed to log create_conference_prepayment estimate:', auditErr); }

    res.json(response);
  } catch (error: unknown) {
    logger.error('[ConferencePrepay] Error calculating estimate', { error: error as Error });
    res.status(500).json({ error: 'Failed to calculate prepayment estimate' });
  }
});

// DEPRECATED: Conference rooms now use invoice-based flow. This endpoint is kept for grandfathered in-flight bookings.
router.post('/api/member/conference/prepay/create-intent', isAuthenticated, async (req: Request, res: Response) => {
  try {
    logger.warn('[ConferencePrepayment] DEPRECATED: create-intent endpoint called - conference rooms now use invoice flow');
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { memberEmail: rawMemberEmail, date, startTime, durationMinutes, useCredit = false } = req.body as CreateIntentRequest;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();

    if (!memberEmail || !date || !startTime || !durationMinutes) {
      return res.status(400).json({ error: 'Missing required fields: memberEmail, date, startTime, durationMinutes' });
    }

    if (typeof durationMinutes !== 'number' || durationMinutes <= 0) {
      return res.status(400).json({ error: 'durationMinutes must be a positive number' });
    }

    const normalizedEmail = normalizeEmail(memberEmail);
    
    if (normalizedEmail.toLowerCase() !== sessionUser.email.toLowerCase()) {
      return res.status(403).json({ error: 'Can only create prepayment for your own bookings' });
    }

    const tierName = await getMemberTierByEmail(normalizedEmail);
    if (!tierName) {
      return res.status(400).json({ error: 'Member not found or inactive membership' });
    }

    const tierLimits = await getTierLimits(tierName);
    const dailyAllowance = tierLimits.daily_conf_room_minutes || 0;
    const usedToday = await getDailyBookedMinutes(normalizedEmail, date, 'conference_room');
    const remainingAllowance = Math.max(0, dailyAllowance - usedToday);
    const overageMinutes = Math.max(0, durationMinutes - remainingAllowance);
    const totalCents = calculateOverageCents(overageMinutes);

    if (totalCents === 0) {
      return res.json({
        paymentRequired: false,
        totalCents: 0,
        overageMinutes: 0
      });
    }

    if (totalCents < 50) {
      return res.status(400).json({ error: 'Amount must be at least 50 cents' });
    }

    const existingPrepayment = await db.execute(
      sql`SELECT id, status, payment_intent_id 
       FROM conference_prepayments 
       WHERE member_email = ${normalizedEmail} 
       AND booking_date = ${date} 
       AND start_time = ${startTime} 
       AND status NOT IN ('refunded', 'expired', 'failed')
       LIMIT 1`
    );

    if (existingPrepayment.rows.length > 0) {
      const existing = existingPrepayment.rows[0] as unknown as ExistingPrepaymentRow;

      if (existing.status === 'succeeded' || existing.status === 'completed') {
        return res.json({
          paymentRequired: false,
          alreadyPaid: true,
          prepaymentId: existing.id
        });
      }

      if (existing.status === 'pending' && existing.payment_intent_id) {
        try {
          const stripe = await getStripeClient();
          const existingPI = await stripe.paymentIntents.retrieve(existing.payment_intent_id);
          if (existingPI.status === 'requires_payment_method' || existingPI.status === 'requires_confirmation' || existingPI.status === 'requires_action') {
            logger.info('[ConferencePrepay] Reusing existing pending payment intent', {
              extra: { prepaymentId: existing.id, paymentIntentId: existing.payment_intent_id }
            });
            return res.json({
              clientSecret: existingPI.client_secret,
              paymentIntentId: existingPI.id,
              totalCents,
              prepaymentId: existing.id,
              paymentRequired: true,
              reused: true
            });
          }
        } catch (err: unknown) {
          logger.warn('[ConferencePrepay] Failed to retrieve existing payment intent, creating new one', {
            extra: { paymentIntentId: existing.payment_intent_id }
          });
        }
      }
    }

    const userResult = await db.execute(
      sql`SELECT id, stripe_customer_id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${normalizedEmail})`
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0] as unknown as UserRow;
    const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || normalizedEmail.split('@')[0];

    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      user.id || normalizedEmail,
      normalizedEmail,
      memberName
    );

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 30);

    const description = `Conference room prepayment - ${overageMinutes} overage minutes on ${date}`;

    if (useCredit) {
      const stripe = await getStripeClient();
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      
      if (!customer.deleted) {
        const customerBalance = (customer as unknown as { balance?: number }).balance || 0;
        const availableCredit = customerBalance < 0 ? Math.abs(customerBalance) : 0;

        if (availableCredit >= totalCents) {
          const balanceTransaction = await stripe.customers.createBalanceTransaction(
            stripeCustomerId,
            {
              amount: totalCents,
              currency: 'usd',
              description: `Conference room prepayment credit applied: ${description}`,
            }
          );

          const balanceRef = `balance-${balanceTransaction.id}`;

          const prepaymentResult = await db.transaction(async (tx) => {
            const result = await tx.execute(
              sql`INSERT INTO conference_prepayments 
               (member_email, booking_date, start_time, duration_minutes, amount_cents, payment_type, credit_reference_id, status, expires_at, completed_at)
               VALUES (${normalizedEmail}, ${date}, ${startTime}, ${durationMinutes}, ${totalCents}, 'credit', ${balanceRef}, 'succeeded', ${expiresAt}, NOW())
               RETURNING id`
            );

            await tx.execute(
              sql`INSERT INTO stripe_payment_intents 
               (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, created_at, updated_at)
               VALUES (${normalizedEmail}, ${balanceRef}, ${stripeCustomerId}, ${totalCents}, 'prepayment', ${description}, 'succeeded', NOW(), NOW())
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`
            );

            return result;
          });

          logger.info('[ConferencePrepay] Credit applied successfully', {
            extra: { 
              prepaymentId: (prepaymentResult.rows[0] as unknown as PrepaymentInsertRow).id, 
              memberEmail: normalizedEmail, 
              amountCents: totalCents,
              balanceRef
            }
          });

          try { logFromRequest(req, { action: 'create_conference_prepayment', resourceType: 'payment', resourceId: String((prepaymentResult.rows[0] as unknown as PrepaymentInsertRow).id), details: { memberEmail: normalizedEmail, date, startTime, durationMinutes, overageMinutes, amountCents: totalCents, paymentType: 'credit', balanceRef } }); } catch (auditErr) { logger.warn('[Audit] Failed to log create_conference_prepayment:', auditErr); }

          return res.json({
            creditApplied: true,
            amountCents: totalCents,
            creditReferenceId: balanceRef,
            prepaymentId: (prepaymentResult.rows[0] as unknown as PrepaymentInsertRow).id,
            paymentRequired: false
          });
        }
      }
    }

    const result = await createBalanceAwarePayment({
      stripeCustomerId,
      userId: user.id || normalizedEmail,
      email: normalizedEmail,
      memberName,
      amountCents: totalCents,
      purpose: 'overage_fee',
      description,
      metadata: {
        type: 'conference_booking',
        conferenceRoomPrepayment: 'true',
        bookingDate: date,
        startTime,
        durationMinutes: durationMinutes.toString(),
        overageMinutes: overageMinutes.toString(),
        memberEmail: normalizedEmail
      }
    });

    if (result.error) {
      logger.error('[ConferencePrepay] Failed to create payment', { 
        extra: { memberEmail: normalizedEmail, error: result.error }
      });
      return res.status(500).json({ error: 'Failed to create payment intent' });
    }

    if (result.paidInFull) {
      const balanceRef = `balance-${result.balanceTransactionId}`;

      const prepaymentResult = await db.transaction(async (tx) => {
        return await tx.execute(
          sql`INSERT INTO conference_prepayments 
           (member_email, booking_date, start_time, duration_minutes, amount_cents, payment_type, credit_reference_id, status, expires_at, completed_at)
           VALUES (${normalizedEmail}, ${date}, ${startTime}, ${durationMinutes}, ${totalCents}, 'credit', ${balanceRef}, 'succeeded', ${expiresAt}, NOW())
           RETURNING id`
        );
      });

      logger.info('[ConferencePrepay] Paid in full via balance', {
        extra: { 
          prepaymentId: (prepaymentResult.rows[0] as unknown as PrepaymentInsertRow).id,
          memberEmail: normalizedEmail, 
          amountCents: totalCents,
          balanceRef
        }
      });

      try { logFromRequest(req, { action: 'create_conference_prepayment', resourceType: 'payment', resourceId: String((prepaymentResult.rows[0] as unknown as PrepaymentInsertRow).id), details: { memberEmail: normalizedEmail, date, startTime, durationMinutes, overageMinutes, amountCents: totalCents, paymentType: 'balance', balanceRef } }); } catch (auditErr) { logger.warn('[Audit] Failed to log create_conference_prepayment:', auditErr); }

      return res.json({
        creditApplied: true,
        amountCents: totalCents,
        creditReferenceId: balanceRef,
        prepaymentId: (prepaymentResult.rows[0] as unknown as PrepaymentInsertRow).id,
        paymentRequired: false
      });
    }

    const prepaymentResult = await db.execute(
      sql`INSERT INTO conference_prepayments 
         (member_email, booking_date, start_time, duration_minutes, amount_cents, payment_type, payment_intent_id, status, expires_at)
         VALUES (${normalizedEmail}, ${date}, ${startTime}, ${durationMinutes}, ${totalCents}, 'stripe', ${result.paymentIntentId}, 'pending', ${expiresAt})
         RETURNING id`
    );

    const insertedRow = prepaymentResult.rows[0] as unknown as PrepaymentInsertRow;
    const stripe = await getStripeClient();
    await stripe.paymentIntents.update(result.paymentIntentId!, {
      metadata: {
        conferenceBookingId: insertedRow.id.toString()
      }
    });

    logger.info('[ConferencePrepay] Payment intent created', {
      extra: { 
        prepaymentId: insertedRow.id,
        paymentIntentId: result.paymentIntentId,
        memberEmail: normalizedEmail, 
        totalCents,
        balanceApplied: result.balanceApplied
      }
    });

    try { logFromRequest(req, { action: 'create_conference_prepayment', resourceType: 'payment', resourceId: String(insertedRow.id), details: { memberEmail: normalizedEmail, date, startTime, durationMinutes, overageMinutes, amountCents: totalCents, paymentType: 'stripe', paymentIntentId: result.paymentIntentId, balanceApplied: result.balanceApplied } }); } catch (auditErr) { logger.warn('[Audit] Failed to log create_conference_prepayment:', auditErr); }

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      totalCents,
      balanceApplied: result.balanceApplied,
      remainingCents: result.remainingCents,
      prepaymentId: insertedRow.id,
      paymentRequired: true
    });
  } catch (error: unknown) {
    logger.error('[ConferencePrepay] Error creating payment intent', { error: error as Error });
    res.status(500).json({ error: 'Failed to create prepayment' });
  }
});

// DEPRECATED: Conference rooms now use invoice-based flow. Kept for grandfathered in-flight bookings.
router.post('/api/member/conference/prepay/:id/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const prepaymentId = parseInt(req.params.id as string);
    if (isNaN(prepaymentId)) {
      return res.status(400).json({ error: 'Invalid prepayment ID' });
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const prepaymentResult = await db.execute(
      sql`SELECT id, member_email, stripe_payment_intent_id, amount_cents, booking_request_id, status FROM conference_prepayments WHERE id = ${prepaymentId}`
    );

    if (prepaymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Prepayment not found' });
    }

    const prepayment = prepaymentResult.rows[0] as unknown as PrepaymentDetailRow;

    if (prepayment.member_email.toLowerCase() !== sessionUser.email.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized to confirm this prepayment' });
    }

    if (prepayment.payment_intent_id !== paymentIntentId) {
      return res.status(400).json({ error: 'Payment intent does not match prepayment' });
    }

    if (prepayment.status === 'completed') {
      return res.json({ success: true, message: 'Already confirmed' });
    }

    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment status is ${paymentIntent.status}, not succeeded` });
    }

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE conference_prepayments SET status = 'completed', completed_at = NOW() WHERE id = ${prepaymentId}`
      );

      await tx.execute(
        sql`INSERT INTO stripe_payment_intents 
         (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, created_at, updated_at)
         VALUES (${prepayment.member_email}, ${paymentIntentId}, ${paymentIntent.customer}, ${prepayment.amount_cents}, 'prepayment', 'Conference room prepayment', 'succeeded', NOW(), NOW())
         ON CONFLICT (stripe_payment_intent_id) 
         DO UPDATE SET status = 'succeeded', updated_at = NOW()`
      );
    });

    logger.info('[ConferencePrepay] Payment confirmed', {
      extra: { prepaymentId, paymentIntentId }
    });

    try { logFromRequest(req, { action: 'confirm_conference_prepayment', resourceType: 'payment', resourceId: String(prepaymentId), details: { memberEmail: prepayment.member_email, bookingDate: prepayment.booking_date, amountCents: prepayment.amount_cents, paymentIntentId } }); } catch (auditErr) { logger.warn('[Audit] Failed to log confirm_conference_prepayment:', auditErr); }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[ConferencePrepay] Error confirming payment', { error: error as Error });
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// DEPRECATED: Conference rooms now use invoice-based flow. Kept for grandfathered in-flight bookings.
router.get('/api/member/conference/prepay/:id', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const prepaymentId = parseInt(req.params.id as string);
    if (isNaN(prepaymentId)) {
      return res.status(400).json({ error: 'Invalid prepayment ID' });
    }

    const prepaymentResult = await db.execute(
      sql`SELECT id, member_email, stripe_payment_intent_id, amount_cents, booking_request_id, status FROM conference_prepayments WHERE id = ${prepaymentId}`
    );

    if (prepaymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Prepayment not found' });
    }

    const prepayment = prepaymentResult.rows[0] as unknown as PrepaymentDetailRow;

    if (prepayment.member_email.toLowerCase() !== sessionUser.email.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized to view this prepayment' });
    }

    res.json({
      id: prepayment.id,
      memberEmail: prepayment.member_email,
      bookingDate: prepayment.booking_date,
      startTime: prepayment.start_time,
      durationMinutes: prepayment.duration_minutes,
      amountCents: prepayment.amount_cents,
      paymentType: prepayment.payment_type,
      status: prepayment.status,
      createdAt: prepayment.created_at,
      expiresAt: prepayment.expires_at,
      completedAt: prepayment.completed_at
    });
  } catch (error: unknown) {
    logger.error('[ConferencePrepay] Error fetching prepayment', { error: error as Error });
    res.status(500).json({ error: 'Failed to fetch prepayment' });
  }
});

export default router;
