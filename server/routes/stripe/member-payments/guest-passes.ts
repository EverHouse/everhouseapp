import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../../core/middleware';
import { db } from '../../../db';
import { membershipTiers } from '../../../../shared/schema';
import { sql, ilike } from 'drizzle-orm';
import { getSessionUser } from '../../../types/session';
import {
  getOrCreateStripeCustomer,
  createBalanceAwarePayment,
} from '../../../core/stripe';
import { alertOnExternalServiceError } from '../../../core/errorAlerts';
import { logger } from '../../../core/logger';
import { UserRow } from './shared';

const router = Router();

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

    const userResult = await db.execute(sql`
      SELECT id, stripe_customer_id, first_name, last_name FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()}
    `);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0] as unknown as UserRow;
    const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || sessionEmail.split('@')[0];

    let stripeCustomerId = user.stripe_customer_id;
    if (!stripeCustomerId) {
      const customerResult = await getOrCreateStripeCustomer(user.id, sessionEmail, memberName);
      stripeCustomerId = customerResult.customerId;
    }

    const description = `${quantity} Guest Pass${quantity > 1 ? 'es' : ''} - Ever Club`;

    const result = await createBalanceAwarePayment({
      stripeCustomerId: stripeCustomerId!,
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
      const existingPass = await db.execute(sql`
        SELECT id, passes_total FROM guest_passes WHERE LOWER(member_email) = LOWER(${sessionEmail})
      `);

      if (existingPass.rows.length > 0) {
        await db.execute(sql`
          UPDATE guest_passes SET passes_total = passes_total + ${quantity} WHERE LOWER(member_email) = LOWER(${sessionEmail})
        `);
        logger.info('[Stripe] Added guest passes to existing record for (paid by credit)', { extra: { quantity, sessionEmail } });
      } else {
        await db.execute(sql`
          INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES (${sessionEmail}, 0, ${quantity})
        `);
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
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create guest pass payment intent');
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

    const { getStripeClient } = await import('../../../core/stripe/client');
    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded' });
    }

    if (paymentIntent.metadata?.purpose !== 'one_time_purchase' || paymentIntent.metadata?.guestPassPurchase !== 'true') {
      return res.status(400).json({ error: 'Invalid payment type' });
    }

    const paymentQuantity = parseInt(paymentIntent.metadata?.quantity || '0', 10);
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
    const creditApplied = parseInt(paymentIntent.metadata?.creditToConsume || '0', 10);
    const expectedChargeAmount = expectedAmount - creditApplied;
    if (paymentIntent.amount !== expectedChargeAmount && paymentIntent.amount !== expectedAmount) {
      logger.error('[Stripe] Amount mismatch for guest pass purchase: expected (or after credit), got', { extra: { expectedAmount, expectedChargeAmount, paymentIntentAmount: paymentIntent.amount } });
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    const existingPass = await db.execute(sql`
      SELECT id, passes_total FROM guest_passes WHERE LOWER(member_email) = LOWER(${sessionEmail})
    `);

    if (existingPass.rows.length > 0) {
      await db.execute(sql`
        UPDATE guest_passes SET passes_total = passes_total + ${quantity} WHERE LOWER(member_email) = LOWER(${sessionEmail})
      `);
      logger.info('[Stripe] Added guest passes to existing record for', { extra: { quantity, sessionEmail } });
    } else {
      await db.execute(sql`
        INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES (${sessionEmail}, 0, ${quantity})
      `);
      logger.info('[Stripe] Created new guest pass record with passes for', { extra: { quantity, sessionEmail } });
    }

    res.json({ success: true, passesAdded: quantity });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming guest pass purchase', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm guest pass purchase');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

export default router;
