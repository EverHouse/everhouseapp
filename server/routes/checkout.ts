import { logger } from '../core/logger';
import { Router } from 'express';
import { db } from '../db';
import { membershipTiers, users } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from '../core/stripe/client';
import { getCorporateVolumePrice } from '../core/stripe/groupBilling';
import { logSystemAction } from '../core/auditLog';
import { checkoutRateLimiter } from '../middleware/rateLimiting';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

const router = Router();

const CORPORATE_MIN_SEATS = 5;

const checkoutSessionSchema = z.object({
  tier: z.string().min(1, 'Tier slug is required').max(100),
  email: z.string().email('Invalid email format').optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(30).optional(),
  companyName: z.string().max(200).optional(),
  jobTitle: z.string().max(100).optional(),
  quantity: z.number().int().min(1).max(100).optional(),
});

router.post('/api/checkout/sessions', checkoutRateLimiter, async (req, res) => {
  try {
    const parseResult = checkoutSessionSchema.safeParse(req.body);
    
    if (!parseResult.success) {
      const firstError = parseResult.error.issues?.[0];
      return res.status(400).json({ error: firstError.message || 'Invalid input' });
    }
    
    const { tier: tierSlug, email, firstName, lastName, phone, companyName, jobTitle, quantity } = parseResult.data;

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
    
    if (isCorporate) {
      if (!firstName?.trim()) {
        return res.status(400).json({ error: 'First name is required for corporate checkout' });
      }
      if (!lastName?.trim()) {
        return res.status(400).json({ error: 'Last name is required for corporate checkout' });
      }
      if (!email?.trim()) {
        return res.status(400).json({ error: 'Email is required for corporate checkout' });
      }
      if (!phone?.trim()) {
        return res.status(400).json({ error: 'Phone number is required for corporate checkout' });
      }
      if (!companyName?.trim()) {
        return res.status(400).json({ error: 'Company name is required for corporate checkout' });
      }
    }
    
    const seatCount = isCorporate ? Math.max(quantity || CORPORATE_MIN_SEATS, CORPORATE_MIN_SEATS) : 1;

    let sessionParams: any = {
      mode: 'subscription',
      ui_mode: 'embedded',
      return_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        first_name: firstName || '',
        last_name: lastName || '',
        phone: phone || '',
        company_name: companyName || '',
        job_title: jobTitle || '',
        quantity: String(seatCount),
        tier_type: tierData.tierType || 'individual',
        tier_slug: tierSlug,
      },
      subscription_data: {
        metadata: {
          tier_slug: tierSlug,
          tier_name: tierData.name,
          tier_type: tierData.tierType || 'individual',
          purchaser_email: email || '',
          first_name: firstName || '',
          last_name: lastName || '',
          phone: phone || '',
          company_name: companyName || '',
          quantity: String(seatCount),
        },
      },
    };

    if (isCorporate) {
      const corporatePricePerSeat = getCorporateVolumePrice(seatCount);
      
      await logSystemAction({
        action: 'checkout_pricing_calculated',
        resourceType: 'checkout',
        resourceId: email || 'unknown',
        details: {
          tier: tierSlug,
          tierType: 'corporate',
          seatCount,
          pricePerSeatCents: corporatePricePerSeat,
          totalMonthlyCents: corporatePricePerSeat * seatCount,
          firstName: firstName || null,
          lastName: lastName || null,
          phone: phone || null,
          companyName: companyName || null,
          serverControlled: true,
        },
      });
      
      sessionParams.line_items = [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${tierData.name} - Corporate Membership`,
              description: `${seatCount} employee seats at $${(corporatePricePerSeat / 100).toFixed(2)}/seat/month. Volume discounts applied as employees are added.`,
            },
            unit_amount: corporatePricePerSeat,
            recurring: {
              interval: 'month',
            },
          },
          quantity: seatCount,
        },
      ];
    } else {
      if (!tierData.stripePriceId) {
        return res.status(400).json({ error: 'This membership tier is not set up in Stripe yet. An admin needs to run "Sync to Stripe" from Products & Pricing before signups can be processed.' });
      }
      sessionParams.line_items = [
        {
          price: tierData.stripePriceId,
          quantity: 1,
        },
      ];
    }

    if (email) {
      const [existingUser] = await db.select({
        stripeCustomerId: users.stripeCustomerId,
        migrationStatus: users.migrationStatus,
      })
        .from(users)
        .where(sql`LOWER(${users.email}) = ${email.toLowerCase()}`)
        .limit(1);

      if (existingUser?.migrationStatus === 'pending') {
        return res.status(400).json({ error: 'Your billing is being migrated — a subscription will be created automatically. No action needed.' });
      }

      if (existingUser?.stripeCustomerId) {
        sessionParams.customer = existingUser.stripeCustomerId;
        logger.info('[Checkout] Reusing existing Stripe customer for', { extra: { existingUserStripeCustomerId: existingUser.stripeCustomerId, email } });
      } else {
        sessionParams.customer_email = email;
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({
      sessionId: session.id,
      clientSecret: session.client_secret,
    });
  } catch (error: unknown) {
    logger.error('[Checkout] Session creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

const sessionIdSchema = z.string().min(1).regex(/^cs_/, 'Invalid session ID format');

router.get('/api/checkout/session/:sessionId', checkoutRateLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const parseResult = sessionIdSchema.safeParse(sessionId);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    
    const stripe = await getStripeClient();
    
    const session = await stripe.checkout.sessions.retrieve(sessionId as string, { expand: ['customer'] });
    
    const customerEmail = session.customer_details?.email || (typeof session.customer === 'object' && session.customer !== null && 'email' in session.customer ? (session.customer as unknown as Record<string, unknown>).email as string : null) || null;
    const metadata = session.metadata || {};
    
    let tierName: string | null = null;
    if (metadata.tier_slug) {
      const [tierData] = await db
        .select({ name: membershipTiers.name })
        .from(membershipTiers)
        .where(eq(membershipTiers.slug, metadata.tier_slug))
        .limit(1);
      tierName = tierData?.name || null;
    }

    let accountReady = false;
    if (customerEmail) {
      const [existingUser] = await db
        .select({ membershipStatus: users.membershipStatus })
        .from(users)
        .where(sql`LOWER(${users.email}) = ${customerEmail.toLowerCase()}`)
        .limit(1);
      accountReady = !!existingUser && existingUser.membershipStatus !== 'pending';
    }

    res.json({
      status: session.status,
      paymentStatus: session.payment_status,
      customerEmail,
      metadata,
      tierName,
      accountReady,
    });
  } catch (error: unknown) {
    logger.error('[Checkout] Session retrieval error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

export default router;
