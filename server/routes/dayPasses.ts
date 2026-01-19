import { Router, Request, Response } from 'express';
import { db } from '../db';
import { dayPassPurchases } from '../../shared/schema';
import { DAY_PASS_PRODUCTS, DayPassProductType } from '../../shared/constants';
import { getStripeClient } from '../core/stripe/client';
import { getOrCreateStripeCustomer } from '../core/stripe/customers';
import { upsertVisitor, linkPurchaseToUser } from '../core/visitors/matchingService';

const router = Router();

/**
 * GET /api/day-passes/products
 * Returns available day pass products
 */
router.get('/api/day-passes/products', (req: Request, res: Response) => {
  try {
    const products = Object.entries(DAY_PASS_PRODUCTS).map(([id, product]) => ({
      id,
      name: `${product.name} Day Pass`,
      priceCents: product.priceCents,
      description: id === 'workspace' 
        ? 'Full day workspace access'
        : id === 'golf_sim'
        ? '60 minute golf simulator session'
        : ''
    }));

    res.json({ products });
  } catch (error: any) {
    console.error('[DayPasses] Error getting products:', error);
    res.status(500).json({ error: 'Failed to get day pass products' });
  }
});

/**
 * POST /api/day-passes/checkout
 * Creates a PaymentIntent for day pass purchase
 */
router.post('/api/day-passes/checkout', async (req: Request, res: Response) => {
  try {
    const { productType, email, firstName, lastName, phone } = req.body;

    // Validate required fields
    if (!productType || !email) {
      return res.status(400).json({ error: 'Missing required fields: productType, email' });
    }

    // Validate productType
    if (!Object.keys(DAY_PASS_PRODUCTS).includes(productType)) {
      return res.status(400).json({ 
        error: `Invalid productType. Must be one of: ${Object.keys(DAY_PASS_PRODUCTS).join(', ')}` 
      });
    }

    const product = DAY_PASS_PRODUCTS[productType as DayPassProductType];
    const amountCents = product.priceCents;

    // Get or create Stripe customer
    const { customerId, isNew } = await getOrCreateStripeCustomer(
      email, // Use email as userId for now
      email,
      firstName || email.split('@')[0]
    );

    // Create PaymentIntent
    const stripe = await getStripeClient();
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      description: `${product.name} Day Pass`,
      metadata: {
        productType,
        email,
        source: 'day_pass',
        purchaserEmail: email,
        purchaserFirstName: firstName || '',
        purchaserLastName: lastName || ''
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log(`[DayPasses] Created PaymentIntent ${paymentIntent.id} for ${productType}: $${(amountCents / 100).toFixed(2)}`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      customerId
    });
  } catch (error: any) {
    console.error('[DayPasses] Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

/**
 * POST /api/day-passes/confirm
 * Called after successful payment to record purchase
 */
router.post('/api/day-passes/confirm', async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing required field: paymentIntentId' });
    }

    // Verify payment succeeded via Stripe API
    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: `Payment status is ${paymentIntent.status}, not succeeded` 
      });
    }

    const metadata = paymentIntent.metadata || {};
    const productType = metadata.productType as DayPassProductType;
    const email = metadata.email || metadata.purchaserEmail;
    const firstName = metadata.purchaserFirstName;
    const lastName = metadata.purchaserLastName;
    const phone = metadata.purchaserPhone;

    if (!productType || !email) {
      return res.status(400).json({ 
        error: 'Missing required metadata: productType, email' 
      });
    }

    if (!Object.keys(DAY_PASS_PRODUCTS).includes(productType)) {
      return res.status(400).json({ 
        error: `Invalid productType in payment metadata: ${productType}` 
      });
    }

    const product = DAY_PASS_PRODUCTS[productType];

    // Find or create visitor user via matching service
    const user = await upsertVisitor({
      email,
      firstName,
      lastName,
      phone
    });

    // Insert record into day_pass_purchases table
    const [purchase] = await db
      .insert(dayPassPurchases)
      .values({
        userId: user.id,
        productType,
        amountCents: product.priceCents,
        quantity: 1,
        stripePaymentIntentId: paymentIntentId,
        stripeCustomerId: paymentIntent.customer as string,
        purchaserEmail: email,
        purchaserFirstName: firstName,
        purchaserLastName: lastName,
        purchaserPhone: phone,
        source: 'stripe',
        purchasedAt: new Date()
      })
      .returning();

    // Link purchase to user if not already linked
    if (user.id) {
      await linkPurchaseToUser(purchase.id, user.id);
    }

    console.log(`[DayPasses] Recorded purchase ${purchase.id} for ${productType}: $${(product.priceCents / 100).toFixed(2)} from ${email}`);

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

export default router;
