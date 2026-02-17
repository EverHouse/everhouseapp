import { logger } from '../core/logger';
import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dayPassPurchases, membershipTiers, users } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from '../core/stripe/client';
import { getOrCreateStripeCustomer, resolveUserByEmail } from '../core/stripe/customers';
import { createPaymentIntent } from '../core/stripe';
import { upsertVisitor, linkPurchaseToUser } from '../core/visitors/matchingService';
import { checkoutRateLimiter } from '../middleware/rateLimiting';
import { isStaffOrAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';
import { getErrorMessage } from '../utils/errorUtils';

const router = Router();

/**
 * GET /api/day-passes/products
 * Returns available day pass products from DB (synced with Stripe)
 */
router.get('/api/day-passes/products', async (req: Request, res: Response) => {
  try {
    const products = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.productType, 'one_time'));

    const formattedProducts = products
      .filter(p => p.isActive && p.priceCents && p.priceCents > 0 && p.slug !== 'guest-pass')
      .map(p => ({
        id: p.slug,
        name: p.name,
        priceCents: p.priceCents,
        description: p.description,
        stripePriceId: p.stripePriceId,
        hasPriceId: !!p.stripePriceId,
      }));

    res.json({ products: formattedProducts });
  } catch (error: unknown) {
    logger.error('[DayPasses] Error getting products', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get day pass products' });
  }
});

/**
 * POST /api/day-passes/checkout
 * Creates a Stripe Checkout Session using synced Price ID
 */
router.post('/api/day-passes/checkout', checkoutRateLimiter, async (req: Request, res: Response) => {
  try {
    const { productSlug, email, firstName, lastName, phone } = req.body;

    if (!productSlug || !email) {
      return res.status(400).json({ error: 'Missing required fields: productSlug, email' });
    }

    const [product] = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, productSlug))
      .limit(1);

    if (!product) {
      return res.status(404).json({ error: `Product not found: ${productSlug}` });
    }

    if (product.productType !== 'one_time') {
      return res.status(400).json({ error: 'This endpoint is for one-time purchases only' });
    }

    if (!product.stripePriceId) {
      return res.status(400).json({ 
        error: 'This day pass is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.' 
      });
    }

    const resolved = await resolveUserByEmail(email);
    const resolvedUserId = resolved?.userId || email;
    const resolvedName = resolved
      ? [resolved.firstName, resolved.lastName].filter(Boolean).join(' ') || firstName || email.split('@')[0]
      : firstName || email.split('@')[0];

    if (resolved && ['active', 'trialing'].includes(resolved.membershipStatus || '')) {
      logger.info('[DayPasses] Warning: active member purchasing day pass with email', { extra: { resolvedPrimaryEmail: resolved.primaryEmail, email } });
    }

    const stripe = await getStripeClient();

    const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
    const baseUrl = replitDomains ? `https://${replitDomains}` : 'http://localhost:5000';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email.toLowerCase(),
      line_items: [
        {
          price: product.stripePriceId,
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          purpose: 'day_pass',
          product_slug: productSlug,
          purchaser_email: email,
          purchaser_first_name: firstName || '',
          purchaser_last_name: lastName || '',
          purchaser_phone: phone || '',
        },
      },
      metadata: {
        purpose: 'day_pass',
        product_slug: productSlug,
        purchaser_email: email,
      },
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancel`,
    });

    logger.info('[DayPasses] Created Checkout Session for : $', { extra: { sessionId: session.id, productSlug, productPriceCents_0_100_ToFixed_2: ((product.priceCents || 0) / 100).toFixed(2) } });

    res.json({
      sessionId: session.id,
      sessionUrl: session.url,
    });
  } catch (error: unknown) {
    logger.error('[DayPasses] Error creating checkout session', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/day-passes/confirm
 * Called after successful payment to record purchase (supports both session_id and payment_intent_id)
 */
router.post('/api/day-passes/confirm', async (req: Request, res: Response) => {
  try {
    const { sessionId, paymentIntentId } = req.body;

    if (!sessionId && !paymentIntentId) {
      return res.status(400).json({ error: 'Missing required field: sessionId or paymentIntentId' });
    }

    const stripe = await getStripeClient();
    let metadata: Record<string, string> = {};
    let customerId: string | null = null;
    let resolvedPaymentIntentId: string | null = null;
    let amountPaid: number = 0;

    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['payment_intent'],
      });

      if (session.payment_status !== 'paid') {
        return res.status(400).json({ 
          error: `Payment status is ${session.payment_status}, not paid` 
        });
      }

      metadata = session.metadata || {};
      customerId = session.customer as string;
      amountPaid = session.amount_total || 0;
      
      if (session.payment_intent && typeof session.payment_intent === 'object') {
        resolvedPaymentIntentId = session.payment_intent.id;
        metadata = { ...metadata, ...session.payment_intent.metadata };
      } else if (typeof session.payment_intent === 'string') {
        resolvedPaymentIntentId = session.payment_intent;
      }
    } else {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      
      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ 
          error: `Payment status is ${paymentIntent.status}, not succeeded` 
        });
      }

      metadata = paymentIntent.metadata || {};
      customerId = paymentIntent.customer as string;
      resolvedPaymentIntentId = paymentIntentId;
      amountPaid = paymentIntent.amount;
    }

    const productSlug = metadata.product_slug;
    const email = metadata.purchaser_email;
    const firstName = metadata.purchaser_first_name;
    const lastName = metadata.purchaser_last_name;
    const phone = metadata.purchaser_phone;

    if (!productSlug || !email) {
      return res.status(400).json({ 
        error: 'Missing required metadata: product_slug, purchaser_email' 
      });
    }

    const [product] = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, productSlug))
      .limit(1);

    if (!product) {
      logger.warn('[DayPasses] Product not found', { extra: { productSlug } });
    }

    const user = await upsertVisitor({
      email,
      firstName,
      lastName,
      phone
    });

    const existingPurchase = resolvedPaymentIntentId 
      ? await db.select()
          .from(dayPassPurchases)
          .where(eq(dayPassPurchases.stripePaymentIntentId, resolvedPaymentIntentId))
          .limit(1)
      : [];

    if (existingPurchase.length > 0) {
      logger.info('[DayPasses] Purchase already recorded for payment', { extra: { resolvedPaymentIntentId } });
      return res.json({
        success: true,
        purchaseId: existingPurchase[0].id,
        userId: user.id,
        alreadyRecorded: true
      });
    }

    const [purchase] = await db
      .insert(dayPassPurchases)
      .values({
        userId: user.id,
        productType: productSlug,
        amountCents: amountPaid,
        quantity: 1,
        stripePaymentIntentId: resolvedPaymentIntentId,
        stripeCustomerId: customerId,
        purchaserEmail: email,
        purchaserFirstName: firstName,
        purchaserLastName: lastName,
        purchaserPhone: phone,
        source: 'stripe',
        purchasedAt: new Date()
      })
      .returning();

    if (user.id) {
      await linkPurchaseToUser(purchase.id, user.id);
    }

    logger.info('[DayPasses] Recorded purchase for : $ from', { extra: { purchaseId: purchase.id, productSlug, amountPaid_100_ToFixed_2: (amountPaid / 100).toFixed(2), email } });

    res.json({
      success: true,
      purchaseId: purchase.id,
      userId: user.id
    });
  } catch (error: unknown) {
    logger.error('[DayPasses] Error confirming payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

/**
 * POST /api/day-passes/staff-checkout
 * Staff-initiated day pass purchase - creates payment intent for in-person payment
 */
router.post('/api/day-passes/staff-checkout', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { productSlug, email, firstName, lastName, phone, dob, notes, streetAddress, city, state, zipCode } = req.body;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'staff';

    if (!productSlug || !email || !firstName || !lastName) {
      return res.status(400).json({ 
        error: 'Missing required fields: productSlug, email, firstName, lastName' 
      });
    }

    const [product] = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, productSlug))
      .limit(1);

    if (!product) {
      return res.status(404).json({ error: `Product not found: ${productSlug}` });
    }

    if (product.productType !== 'one_time') {
      return res.status(400).json({ error: 'This endpoint is for one-time purchases only' });
    }

    if (!product.priceCents || product.priceCents < 50) {
      return res.status(400).json({ error: 'Invalid product price' });
    }

    const resolvedStaff = await resolveUserByEmail(email);
    const resolvedStaffUserId = resolvedStaff?.userId || email;
    const { customerId } = await getOrCreateStripeCustomer(
      resolvedStaffUserId,
      email,
      `${firstName} ${lastName}`
    );

    const result = await createPaymentIntent({
      userId: email,
      email,
      memberName: `${firstName} ${lastName}`,
      amountCents: product.priceCents,
      purpose: 'one_time_purchase',
      description: `Day Pass: ${product.name}`,
      stripeCustomerId: customerId,
      productName: product.name,
      metadata: {
        staffInitiated: 'true',
        staffEmail,
        purpose: 'day_pass',
        product_slug: productSlug,
        purchaser_email: email,
        purchaser_first_name: firstName,
        purchaser_last_name: lastName,
        purchaser_phone: phone || '',
        purchaser_dob: dob || '',
        notes: notes || '',
        purchaser_street_address: streetAddress || '',
        purchaser_city: city || '',
        purchaser_state: state || '',
        purchaser_zip_code: zipCode || '',
      }
    });

    logger.info('[DayPasses] Staff checkout initiated for : $ by', { extra: { productSlug, productPriceCents_100_ToFixed_2: (product.priceCents / 100).toFixed(2), staffEmail } });

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      customerId,
      amountCents: product.priceCents,
      productName: product.name
    });
  } catch (error: unknown) {
    logger.error('[DayPasses] Error creating staff checkout', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

/**
 * POST /api/day-passes/staff-checkout/confirm
 * Confirm staff-initiated day pass payment and create the purchase record
 */
router.post('/api/day-passes/staff-checkout/confirm', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'staff';

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: `Payment status is ${paymentIntent.status}, not succeeded` 
      });
    }

    const metadata = paymentIntent.metadata || {};
    const productSlug = metadata.product_slug;
    const email = metadata.purchaser_email;
    const firstName = metadata.purchaser_first_name;
    const lastName = metadata.purchaser_last_name;
    const phone = metadata.purchaser_phone;

    if (!productSlug || !email) {
      return res.status(400).json({ 
        error: 'Missing required metadata: product_slug, purchaser_email' 
      });
    }

    const existingPurchase = await db.select()
      .from(dayPassPurchases)
      .where(eq(dayPassPurchases.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (existingPurchase.length > 0) {
      logger.info('[DayPasses] Purchase already recorded for payment', { extra: { paymentIntentId } });
      return res.json({
        success: true,
        purchaseId: existingPurchase[0].id,
        userId: existingPurchase[0].userId,
        alreadyRecorded: true
      });
    }

    const user = await upsertVisitor({
      email,
      firstName,
      lastName,
      phone
    });

    const purchaserStreetAddress = metadata.purchaser_street_address;
    const purchaserCity = metadata.purchaser_city;
    const purchaserState = metadata.purchaser_state;
    const purchaserZipCode = metadata.purchaser_zip_code;
    if (user.id && (purchaserStreetAddress || purchaserCity || purchaserState || purchaserZipCode)) {
      const addressUpdate: Record<string, any> = { updatedAt: new Date() };
      if (purchaserStreetAddress) addressUpdate.streetAddress = purchaserStreetAddress;
      if (purchaserCity) addressUpdate.city = purchaserCity;
      if (purchaserState) addressUpdate.state = purchaserState;
      if (purchaserZipCode) addressUpdate.zipCode = purchaserZipCode;
      await db.update(users).set(addressUpdate).where(eq(users.id, user.id));
    }

    const [purchase] = await db
      .insert(dayPassPurchases)
      .values({
        userId: user.id,
        productType: productSlug,
        amountCents: paymentIntent.amount,
        quantity: 1,
        stripePaymentIntentId: paymentIntentId,
        stripeCustomerId: paymentIntent.customer as string,
        purchaserEmail: email,
        purchaserFirstName: firstName,
        purchaserLastName: lastName,
        purchaserPhone: phone,
        source: 'staff',
        purchasedAt: new Date()
      })
      .returning();

    if (user.id) {
      await linkPurchaseToUser(purchase.id, user.id);
    }

    logger.info('[DayPasses] Staff checkout confirmed: for : $ by', { extra: { purchaseId: purchase.id, productSlug, paymentIntentAmount_100_ToFixed_2: (paymentIntent.amount / 100).toFixed(2), staffEmail } });

    res.json({
      success: true,
      purchaseId: purchase.id,
      userId: user.id,
      userName: `${firstName} ${lastName}`,
      userEmail: email
    });
  } catch (error: unknown) {
    logger.error('[DayPasses] Error confirming staff checkout', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

/**
 * Function to record a day pass purchase from webhook
 * Called by checkout.session.completed webhook handler
 */
export async function recordDayPassPurchaseFromWebhook(data: {
  productSlug: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  amountCents: number;
  paymentIntentId: string;
  customerId: string;
}): Promise<{ success: boolean; purchaseId?: string; userId?: string; quantity?: number; remainingUses?: number; error?: string }> {
  try {
    const existingPurchase = await db.select()
      .from(dayPassPurchases)
      .where(eq(dayPassPurchases.stripePaymentIntentId, data.paymentIntentId))
      .limit(1);

    if (existingPurchase.length > 0) {
      logger.info('[DayPasses] Purchase already recorded for payment', { extra: { dataPaymentIntentId: data.paymentIntentId } });
      return { 
        success: true, 
        purchaseId: existingPurchase[0].id, 
        userId: existingPurchase[0].userId || undefined,
        quantity: existingPurchase[0].quantity ?? 1,
        remainingUses: existingPurchase[0].remainingUses ?? 1
      };
    }

    const user = await upsertVisitor({
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone
    });

    const [purchase] = await db
      .insert(dayPassPurchases)
      .values({
        userId: user.id,
        productType: data.productSlug,
        amountCents: data.amountCents,
        quantity: 1,
        stripePaymentIntentId: data.paymentIntentId,
        stripeCustomerId: data.customerId,
        purchaserEmail: data.email,
        purchaserFirstName: data.firstName,
        purchaserLastName: data.lastName,
        purchaserPhone: data.phone,
        source: 'stripe',
        purchasedAt: new Date()
      })
      .returning();

    if (user.id) {
      await linkPurchaseToUser(purchase.id, user.id);
    }

    logger.info('[DayPasses Webhook] Recorded purchase for : $ from', { extra: { purchaseId: purchase.id, dataProductSlug: data.productSlug, dataAmountCents_100_ToFixed_2: (data.amountCents / 100).toFixed(2), dataEmail: data.email } });

    return { 
      success: true, 
      purchaseId: purchase.id, 
      userId: user.id,
      quantity: purchase.quantity ?? 1,
      remainingUses: purchase.remainingUses ?? 1
    };
  } catch (error: unknown) {
    logger.error('[DayPasses Webhook] Error recording purchase', { error: error instanceof Error ? error : new Error(String(error)) });
    return { success: false, error: getErrorMessage(error) };
  }
}

export default router;
