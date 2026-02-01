import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dayPassPurchases, membershipTiers } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from '../core/stripe/client';
import { getOrCreateStripeCustomer } from '../core/stripe/customers';
import { createPaymentIntent } from '../core/stripe';
import { upsertVisitor, linkPurchaseToUser } from '../core/visitors/matchingService';
import { checkoutRateLimiter } from '../middleware/rateLimiting';
import { isStaffOrAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';

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
  } catch (error: any) {
    console.error('[DayPasses] Error getting products:', error);
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
        error: 'Product not synced to Stripe. Please run Sync Tiers to Stripe from admin panel.' 
      });
    }

    const { customerId } = await getOrCreateStripeCustomer(
      email,
      email,
      firstName || email.split('@')[0]
    );

    const stripe = await getStripeClient();

    const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
    const baseUrl = replitDomains ? `https://${replitDomains}` : 'http://localhost:5000';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
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

    console.log(`[DayPasses] Created Checkout Session ${session.id} for ${productSlug}: $${((product.priceCents || 0) / 100).toFixed(2)}`);

    res.json({
      sessionId: session.id,
      sessionUrl: session.url,
      customerId,
    });
  } catch (error: any) {
    console.error('[DayPasses] Error creating checkout session:', error);
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
      console.warn(`[DayPasses] Product not found: ${productSlug}`);
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
      console.log(`[DayPasses] Purchase already recorded for payment ${resolvedPaymentIntentId}`);
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

    console.log(`[DayPasses] Recorded purchase ${purchase.id} for ${productSlug}: $${(amountPaid / 100).toFixed(2)} from ${email}`);

    res.json({
      success: true,
      purchaseId: purchase.id,
      userId: user.id
    });
  } catch (error: any) {
    console.error('[DayPasses] Error confirming payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

/**
 * POST /api/day-passes/staff-checkout
 * Staff-initiated day pass purchase - creates payment intent for in-person payment
 */
router.post('/api/day-passes/staff-checkout', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { productSlug, email, firstName, lastName, phone, dob, notes } = req.body;
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

    const { customerId } = await getOrCreateStripeCustomer(
      email,
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
        notes: notes || ''
      }
    });

    console.log(`[DayPasses] Staff checkout initiated for ${productSlug}: $${(product.priceCents / 100).toFixed(2)} by ${staffEmail}`);

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      customerId,
      amountCents: product.priceCents,
      productName: product.name
    });
  } catch (error: any) {
    console.error('[DayPasses] Error creating staff checkout:', error);
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
      console.log(`[DayPasses] Purchase already recorded for payment ${paymentIntentId}`);
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

    console.log(`[DayPasses] Staff checkout confirmed: ${purchase.id} for ${productSlug}: $${(paymentIntent.amount / 100).toFixed(2)} by ${staffEmail}`);

    res.json({
      success: true,
      purchaseId: purchase.id,
      userId: user.id,
      userName: `${firstName} ${lastName}`,
      userEmail: email
    });
  } catch (error: any) {
    console.error('[DayPasses] Error confirming staff checkout:', error);
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
      console.log(`[DayPasses] Purchase already recorded for payment ${data.paymentIntentId}`);
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

    console.log(`[DayPasses Webhook] Recorded purchase ${purchase.id} for ${data.productSlug}: $${(data.amountCents / 100).toFixed(2)} from ${data.email}`);

    return { 
      success: true, 
      purchaseId: purchase.id, 
      userId: user.id,
      quantity: purchase.quantity ?? 1,
      remainingUses: purchase.remainingUses ?? 1
    };
  } catch (error: any) {
    console.error('[DayPasses Webhook] Error recording purchase:', error);
    return { success: false, error: error.message };
  }
}

export default router;
