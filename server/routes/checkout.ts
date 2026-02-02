import { Router } from 'express';
import { db } from '../db';
import { membershipTiers } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from '../core/stripe/client';

const router = Router();

const CORPORATE_BASE_RATE_CENTS = 35000;
const CORPORATE_MIN_SEATS = 5;

router.post('/api/checkout/sessions', async (req, res) => {
  try {
    const { 
      tier: tierSlug, 
      email, 
      companyName, 
      jobTitle 
    } = req.body;

    if (!tierSlug) {
      return res.status(400).json({ error: 'Tier slug is required' });
    }

    const [tierData] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, tierSlug))
      .limit(1);

    if (!tierData) {
      return res.status(404).json({ error: 'Membership tier not found' });
    }

    const stripe = await getStripeClient();

    const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
    const baseUrl = replitDomains ? `https://${replitDomains}` : 'http://localhost:5000';

    const isCorporate = tierData.tierType === 'corporate' || tierSlug === 'corporate';

    let sessionParams: any = {
      mode: 'subscription',
      ui_mode: 'embedded',
      return_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        company_name: companyName || '',
        job_title: jobTitle || '',
        quantity: String(CORPORATE_MIN_SEATS),
        tier_type: tierData.tierType || 'individual',
        tier_slug: tierSlug,
      },
    };

    if (isCorporate) {
      sessionParams.line_items = [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${tierData.name} - Corporate Membership`,
              description: `${CORPORATE_MIN_SEATS} employee seats at $${(CORPORATE_BASE_RATE_CENTS / 100).toFixed(2)}/seat/month. Volume discounts applied as employees are added.`,
            },
            unit_amount: CORPORATE_BASE_RATE_CENTS,
            recurring: {
              interval: 'month',
            },
          },
          quantity: CORPORATE_MIN_SEATS,
        },
      ];
    } else {
      if (!tierData.stripePriceId) {
        return res.status(400).json({ error: 'This tier does not have a configured Stripe price' });
      }
      sessionParams.line_items = [
        {
          price: tierData.stripePriceId,
          quantity: 1,
        },
      ];
    }

    if (email) {
      sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({
      sessionId: session.id,
      clientSecret: session.client_secret,
    });
  } catch (error: any) {
    console.error('[Checkout] Session creation error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.get('/api/checkout/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    
    const stripe = await getStripeClient();
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    res.json({
      status: session.status,
      paymentStatus: session.payment_status,
    });
  } catch (error: any) {
    console.error('[Checkout] Session retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

export default router;
