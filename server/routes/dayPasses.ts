import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dayPassPurchases, membershipTiers } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from '../core/stripe/client';
import { getOrCreateStripeCustomer } from '../core/stripe/customers';
import { upsertVisitor, linkPurchaseToUser } from '../core/visitors/matchingService';

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
      .filter(p => p.isActive && p.priceCents && p.priceCents > 0)
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
router.post('/api/day-passes/checkout', async (req: Request, res: Response) => {
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
      success_url: `${baseUrl}/#/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/#/checkout/cancel`,
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
}): Promise<{ success: boolean; purchaseId?: string; userId?: string; error?: string }> {
  try {
    const existingPurchase = await db.select()
      .from(dayPassPurchases)
      .where(eq(dayPassPurchases.stripePaymentIntentId, data.paymentIntentId))
      .limit(1);

    if (existingPurchase.length > 0) {
      console.log(`[DayPasses] Purchase already recorded for payment ${data.paymentIntentId}`);
      return { success: true, purchaseId: existingPurchase[0].id, userId: existingPurchase[0].userId || undefined };
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

    return { success: true, purchaseId: purchase.id, userId: user.id };
  } catch (error: any) {
    console.error('[DayPasses Webhook] Error recording purchase:', error);
    return { success: false, error: error.message };
  }
}

export default router;
