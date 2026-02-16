import { Router, Request, Response } from 'express';
import { pool } from '../../core/db';
import { getMemberTierByEmail, getTierLimits, getDailyBookedMinutes } from '../../core/tierService';
import { getOrCreateStripeCustomer, createBalanceAwarePayment } from '../../core/stripe';
import { getStripeClient } from '../../core/stripe/client';
import { calculateOverageCents, PRICING } from '../../core/billing/pricingConfig';
import { normalizeEmail } from '../../core/utils/emailNormalization';
import { getSessionUser } from '../../types/session';
import { logger } from '../../core/logger';

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

router.post('/api/member/conference/prepay/estimate', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { memberEmail, date, startTime, durationMinutes } = req.body as PrepayEstimateRequest;

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

    res.json(response);
  } catch (error: unknown) {
    logger.error('[ConferencePrepay] Error calculating estimate', { error: error as Error });
    res.status(500).json({ error: 'Failed to calculate prepayment estimate' });
  }
});

router.post('/api/member/conference/prepay/create-intent', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { memberEmail, date, startTime, durationMinutes, useCredit = false } = req.body as CreateIntentRequest;

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

    const existingPrepayment = await pool.query(
      `SELECT id, status, payment_intent_id 
       FROM conference_prepayments 
       WHERE member_email = $1 
       AND booking_date = $2 
       AND start_time = $3 
       AND status NOT IN ('refunded', 'expired', 'failed')
       LIMIT 1`,
      [normalizedEmail, date, startTime]
    );

    if (existingPrepayment.rows.length > 0) {
      const existing = existingPrepayment.rows[0];

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
        } catch (err) {
          logger.warn('[ConferencePrepay] Failed to retrieve existing payment intent, creating new one', {
            extra: { paymentIntentId: existing.payment_intent_id }
          });
        }
      }
    }

    const userResult = await pool.query(
      `SELECT id, stripe_customer_id, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)`,
      [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
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
        const customerBalance = (customer as any).balance || 0;
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

          const creditClient = await pool.connect();
          let prepaymentResult;
          try {
            await creditClient.query('BEGIN');

            prepaymentResult = await creditClient.query(
              `INSERT INTO conference_prepayments 
               (member_email, booking_date, start_time, duration_minutes, amount_cents, payment_type, credit_reference_id, status, expires_at, completed_at)
               VALUES ($1, $2, $3, $4, $5, 'credit', $6, 'succeeded', $7, NOW())
               RETURNING id`,
              [normalizedEmail, date, startTime, durationMinutes, totalCents, balanceRef, expiresAt]
            );

            await creditClient.query(
              `INSERT INTO stripe_payment_intents 
               (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 'prepayment', $5, 'succeeded', NOW(), NOW())
               ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
              [normalizedEmail, balanceRef, stripeCustomerId, totalCents, description]
            );

            await creditClient.query('COMMIT');
          } catch (txError) {
            await creditClient.query('ROLLBACK');
            throw txError;
          } finally {
            creditClient.release();
          }

          logger.info('[ConferencePrepay] Credit applied successfully', {
            extra: { 
              prepaymentId: prepaymentResult.rows[0].id, 
              memberEmail: normalizedEmail, 
              amountCents: totalCents,
              balanceRef
            }
          });

          return res.json({
            creditApplied: true,
            amountCents: totalCents,
            creditReferenceId: balanceRef,
            prepaymentId: prepaymentResult.rows[0].id,
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

      const balanceClient = await pool.connect();
      let prepaymentResult;
      try {
        await balanceClient.query('BEGIN');

        prepaymentResult = await balanceClient.query(
          `INSERT INTO conference_prepayments 
           (member_email, booking_date, start_time, duration_minutes, amount_cents, payment_type, credit_reference_id, status, expires_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, 'credit', $6, 'succeeded', $7, NOW())
           RETURNING id`,
          [normalizedEmail, date, startTime, durationMinutes, totalCents, balanceRef, expiresAt]
        );

        await balanceClient.query('COMMIT');
      } catch (txError) {
        await balanceClient.query('ROLLBACK');
        throw txError;
      } finally {
        balanceClient.release();
      }

      logger.info('[ConferencePrepay] Paid in full via balance', {
        extra: { 
          prepaymentId: prepaymentResult.rows[0].id,
          memberEmail: normalizedEmail, 
          amountCents: totalCents,
          balanceRef
        }
      });

      return res.json({
        creditApplied: true,
        amountCents: totalCents,
        creditReferenceId: balanceRef,
        prepaymentId: prepaymentResult.rows[0].id,
        paymentRequired: false
      });
    }

    const stripeClient = await pool.connect();
    let prepaymentResult;
    try {
      await stripeClient.query('BEGIN');

      prepaymentResult = await stripeClient.query(
        `INSERT INTO conference_prepayments 
         (member_email, booking_date, start_time, duration_minutes, amount_cents, payment_type, payment_intent_id, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'stripe', $6, 'pending', $7)
         RETURNING id`,
        [normalizedEmail, date, startTime, durationMinutes, totalCents, result.paymentIntentId, expiresAt]
      );

      await stripeClient.query('COMMIT');
    } catch (txError) {
      await stripeClient.query('ROLLBACK');
      throw txError;
    } finally {
      stripeClient.release();
    }

    const stripe = await getStripeClient();
    await stripe.paymentIntents.update(result.paymentIntentId!, {
      metadata: {
        conferenceBookingId: prepaymentResult.rows[0].id.toString()
      }
    });

    logger.info('[ConferencePrepay] Payment intent created', {
      extra: { 
        prepaymentId: prepaymentResult.rows[0].id,
        paymentIntentId: result.paymentIntentId,
        memberEmail: normalizedEmail, 
        totalCents,
        balanceApplied: result.balanceApplied
      }
    });

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      totalCents,
      balanceApplied: result.balanceApplied,
      remainingCents: result.remainingCents,
      prepaymentId: prepaymentResult.rows[0].id,
      paymentRequired: true
    });
  } catch (error: unknown) {
    logger.error('[ConferencePrepay] Error creating payment intent', { error: error as Error });
    res.status(500).json({ error: 'Failed to create prepayment' });
  }
});

router.post('/api/member/conference/prepay/:id/confirm', async (req: Request, res: Response) => {
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

    const prepaymentResult = await pool.query(
      `SELECT * FROM conference_prepayments WHERE id = $1`,
      [prepaymentId]
    );

    if (prepaymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Prepayment not found' });
    }

    const prepayment = prepaymentResult.rows[0];

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

    const confirmClient = await pool.connect();
    try {
      await confirmClient.query('BEGIN');

      await confirmClient.query(
        `UPDATE conference_prepayments SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [prepaymentId]
      );

      await confirmClient.query(
        `INSERT INTO stripe_payment_intents 
         (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'prepayment', 'Conference room prepayment', 'succeeded', NOW(), NOW())
         ON CONFLICT (stripe_payment_intent_id) 
         DO UPDATE SET status = 'succeeded', updated_at = NOW()`,
        [prepayment.member_email, paymentIntentId, paymentIntent.customer, prepayment.amount_cents]
      );

      await confirmClient.query('COMMIT');
    } catch (txError) {
      await confirmClient.query('ROLLBACK');
      throw txError;
    } finally {
      confirmClient.release();
    }

    logger.info('[ConferencePrepay] Payment confirmed', {
      extra: { prepaymentId, paymentIntentId }
    });

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[ConferencePrepay] Error confirming payment', { error: error as Error });
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

router.get('/api/member/conference/prepay/:id', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const prepaymentId = parseInt(req.params.id as string);
    if (isNaN(prepaymentId)) {
      return res.status(400).json({ error: 'Invalid prepayment ID' });
    }

    const prepaymentResult = await pool.query(
      `SELECT * FROM conference_prepayments WHERE id = $1`,
      [prepaymentId]
    );

    if (prepaymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Prepayment not found' });
    }

    const prepayment = prepaymentResult.rows[0];

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
