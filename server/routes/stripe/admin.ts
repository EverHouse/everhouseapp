import { Router, Request, Response } from 'express';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { pool } from '../../core/db';
import { getStripeClient } from '../../core/stripe/client';
import {
  getStripeProducts,
  getProductSyncStatus,
  syncHubSpotProductToStripe,
  syncAllHubSpotProductsToStripe,
  fetchHubSpotProducts,
  syncMembershipTiersToStripe,
  getTierSyncStatus,
  syncDiscountRulesToStripeCoupons,
  getDiscountSyncStatus
} from '../../core/stripe';
import { checkExpiringCards } from '../../core/billing/cardExpiryChecker';
import { checkStaleWaivers } from '../../schedulers/waiverReviewScheduler';
import { getBillingClassificationSummary, getMembersNeedingStripeMigration } from '../../scripts/classifyMemberBilling';
import { escapeHtml } from './helpers';

const router = Router();

router.post('/api/admin/check-expiring-cards', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkExpiringCards();
    res.json(result);
  } catch (error: any) {
    console.error('[Stripe] Error checking expiring cards:', error);
    res.status(500).json({ error: 'Failed to check expiring cards', details: error.message });
  }
});

router.post('/api/admin/check-stale-waivers', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkStaleWaivers();
    res.json(result);
  } catch (error: any) {
    console.error('[Admin] Error checking stale waivers:', error);
    res.status(500).json({ error: 'Failed to check stale waivers', details: error.message });
  }
});

router.get('/api/stripe/products', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const syncStatus = await getProductSyncStatus();
    const stripeProducts = await getStripeProducts();
    
    res.json({
      products: stripeProducts,
      syncStatus,
      count: stripeProducts.length
    });
  } catch (error: any) {
    console.error('[Stripe] Error getting products:', error);
    res.status(500).json({ error: 'Failed to get Stripe products' });
  }
});

router.post('/api/stripe/products/sync', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { hubspotProductId } = req.body;
    
    if (!hubspotProductId) {
      return res.status(400).json({ error: 'Missing required field: hubspotProductId' });
    }
    
    const hubspotProducts = await fetchHubSpotProducts();
    const product = hubspotProducts.find(p => p.id === hubspotProductId);
    
    if (!product) {
      return res.status(404).json({ error: 'HubSpot product not found' });
    }
    
    const result = await syncHubSpotProductToStripe(product);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to sync product' });
    }
    
    res.json({
      success: true,
      stripeProductId: result.stripeProductId,
      stripePriceId: result.stripePriceId
    });
  } catch (error: any) {
    console.error('[Stripe] Error syncing product:', error);
    res.status(500).json({ error: 'Failed to sync product to Stripe' });
  }
});

router.post('/api/stripe/products/sync-all', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await syncAllHubSpotProductsToStripe();
    
    res.json({
      success: result.success,
      synced: result.synced,
      failed: result.failed,
      errors: result.errors
    });
  } catch (error: any) {
    console.error('[Stripe] Error syncing all products:', error);
    res.status(500).json({ error: 'Failed to sync products to Stripe' });
  }
});

router.get('/api/stripe/tiers/status', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const status = await getTierSyncStatus();
    res.json({ tiers: status });
  } catch (error: any) {
    console.error('[Stripe] Error getting tier sync status:', error);
    res.status(500).json({ error: 'Failed to get tier sync status' });
  }
});

router.post('/api/stripe/tiers/sync', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await syncMembershipTiersToStripe();
    
    res.json({
      success: result.success,
      synced: result.synced,
      failed: result.failed,
      skipped: result.skipped,
      results: result.results
    });
  } catch (error: any) {
    console.error('[Stripe] Error syncing tiers:', error);
    res.status(500).json({ error: 'Failed to sync membership tiers to Stripe' });
  }
});

router.get('/api/stripe/discounts/status', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const status = await getDiscountSyncStatus();
    res.json({ discounts: status });
  } catch (error: any) {
    console.error('[Stripe] Error getting discount sync status:', error);
    res.status(500).json({ error: 'Failed to get discount sync status' });
  }
});

router.post('/api/stripe/discounts/sync', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await syncDiscountRulesToStripeCoupons();
    
    res.json({
      success: result.success,
      synced: result.synced,
      failed: result.failed,
      skipped: result.skipped,
      results: result.results
    });
  } catch (error: any) {
    console.error('[Stripe] Error syncing discounts:', error);
    res.status(500).json({ error: 'Failed to sync discount rules to Stripe coupons' });
  }
});

router.get('/api/stripe/billing/classification', isAdmin, async (req: Request, res: Response) => {
  try {
    const summary = await getBillingClassificationSummary();
    res.json(summary);
  } catch (error: any) {
    console.error('[Stripe] Error getting billing classification:', error);
    res.status(500).json({ error: 'Failed to classify member billing' });
  }
});

router.get('/api/stripe/billing/needs-migration', isAdmin, async (req: Request, res: Response) => {
  try {
    const members = await getMembersNeedingStripeMigration();
    res.json({ 
      count: members.length,
      members: members.map(m => ({
        id: m.id,
        email: m.email,
        name: `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email,
        tier: m.tier,
        currentProvider: m.billingProvider,
        hasStripeCustomer: !!m.stripeCustomerId,
        hasMindbodyId: !!m.mindbodyClientId,
      }))
    });
  } catch (error: any) {
    console.error('[Stripe] Error getting members needing migration:', error);
    res.status(500).json({ error: 'Failed to get members needing migration' });
  }
});

router.post('/api/stripe/staff/send-membership-link', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email, firstName, lastName, tierId } = req.body;

    if (!email || !firstName || !lastName || !tierId) {
      return res.status(400).json({ error: 'Missing required fields: email, firstName, lastName, tierId' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const sanitizedFirstName = String(firstName).trim().slice(0, 100);
    const sanitizedLastName = String(lastName).trim().slice(0, 100);

    if (!sanitizedFirstName || !sanitizedLastName) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }

    const tierResult = await pool.query(
      `SELECT id, name, stripe_price_id, price_cents, billing_interval 
       FROM membership_tiers 
       WHERE id = $1 AND is_active = true 
         AND product_type = 'subscription'
         AND billing_interval IN ('month', 'year', 'week')`,
      [tierId]
    );

    if (tierResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found or inactive' });
    }

    const tier = tierResult.rows[0];

    if (!tier.stripe_price_id) {
      return res.status(400).json({ error: 'This tier has not been synced to Stripe. Please sync tiers first.' });
    }

    const stripe = await getStripeClient();

    const baseUrl = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'https://everhouse.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          price: tier.stripe_price_id,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/`,
      metadata: {
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        tierId: tier.id.toString(),
        tierName: tier.name,
        source: 'staff_invite',
      },
    });

    const checkoutUrl = session.url;

    try {
      const { getResendClient } = await import('../../utils/resend');
      const { client: resend, fromEmail } = await getResendClient();

      const priceFormatted = tier.billing_interval === 'year' 
        ? `$${(tier.price_cents / 100).toFixed(0)}/year`
        : `$${(tier.price_cents / 100).toFixed(0)}/month`;

      const safeFirstName = escapeHtml(sanitizedFirstName);

      await resend.emails.send({
        from: fromEmail || 'Ever House Members Club <noreply@everhouse.app>',
        to: email,
        subject: `Your Ever House Membership Invitation - ${tier.name}`,
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #F2F2EC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #F2F2EC;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px;">
          <tr>
            <td style="text-align: center; padding-bottom: 32px;">
              <img src="https://everhouse.app/assets/logos/monogram-dark.webp" alt="Ever House" width="60" height="60" style="display: inline-block;">
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #1a1a1a;">Welcome to Ever House, ${safeFirstName}!</h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">You've been invited to join Ever House as a <strong>${tier.name}</strong> member at ${priceFormatted}.</p>
              <p style="margin: 0 0 32px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Click below to complete your membership signup:</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center;">
                    <a href="${checkoutUrl}" style="display: inline-block; padding: 14px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 500; border-radius: 8px;">Complete Membership</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 32px 0 0; font-size: 14px; line-height: 1.6; color: #888888; text-align: center;">This link will expire in 24 hours. If you have any questions, please contact us.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`,
      });
      console.log(`[Stripe] Membership invite email sent to ${email}`);
    } catch (emailError: any) {
      console.error('[Stripe] Failed to send membership invite email:', emailError);
    }

    res.json({ success: true, checkoutUrl });
  } catch (error: any) {
    console.error('[Stripe] Error sending membership invite:', error);
    res.status(500).json({ error: 'Failed to create membership invite' });
  }
});

router.post('/api/stripe/staff/send-reactivation-link', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberEmail } = req.body;

    if (!memberEmail) {
      return res.status(400).json({ error: 'Missing required field: memberEmail' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(memberEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const memberResult = await pool.query(
      `SELECT id, email, first_name, last_name, tier, last_tier, membership_status, billing_provider, stripe_customer_id
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [memberEmail]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0];
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

    let reactivationLink = 'https://everhouse.app/billing';

    if (member.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        const returnUrl = process.env.NODE_ENV === 'production' 
          ? 'https://everhouse.app'
          : (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'https://everhouse.app');

        const session = await stripe.billingPortal.sessions.create({
          customer: member.stripe_customer_id,
          return_url: returnUrl,
          flow_data: {
            type: 'payment_method_update',
          },
        });
        reactivationLink = session.url;
        console.log(`[Stripe] Created billing portal session for reactivation: ${member.email}`);
      } catch (portalError: any) {
        console.warn(`[Stripe] Could not create billing portal for ${member.email}, using fallback link:`, portalError.message);
      }
    }

    const { sendGracePeriodReminderEmail } = await import('../../emails/membershipEmails');
    
    await sendGracePeriodReminderEmail(member.email, {
      memberName,
      currentDay: 1,
      totalDays: 3,
      reactivationLink
    });

    console.log(`[Stripe] Reactivation link sent manually to ${member.email} by staff`);

    res.json({ success: true, message: `Reactivation link sent to ${member.email}` });
  } catch (error: any) {
    console.error('[Stripe] Error sending reactivation link:', error);
    res.status(500).json({ error: 'Failed to send reactivation link' });
  }
});

router.post('/api/public/day-pass/checkout', async (req: Request, res: Response) => {
  try {
    const { email, passType, firstName, lastName } = req.body;

    if (!email || !passType) {
      return res.status(400).json({ error: 'Missing required fields: email, passType' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const sanitizedPassType = String(passType).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 50);
    if (!sanitizedPassType) {
      return res.status(400).json({ error: 'Invalid pass type' });
    }

    const sanitizedFirstName = firstName ? String(firstName).trim().slice(0, 100) : '';
    const sanitizedLastName = lastName ? String(lastName).trim().slice(0, 100) : '';

    const tierResult = await pool.query(
      `SELECT id, name, slug, stripe_price_id, price_cents, description 
       FROM membership_tiers 
       WHERE slug = $1 AND product_type = 'one_time' AND is_active = true`,
      [sanitizedPassType]
    );

    if (tierResult.rows.length === 0) {
      return res.status(404).json({ error: 'Day pass type not found' });
    }

    const tier = tierResult.rows[0];

    if (!tier.stripe_price_id) {
      return res.status(400).json({ error: 'This day pass is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.' });
    }

    const stripe = await getStripeClient();

    const domain = process.env.NODE_ENV === 'production' 
      ? 'https://everhouse.app'
      : (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'https://everhouse.app');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price: tier.stripe_price_id,
          quantity: 1,
        },
      ],
      customer_email: email,
      success_url: `${domain}/day-pass/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domain}/day-pass`,
      metadata: {
        productType: tier.slug,
        tierName: tier.name,
        email: email,
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        source: 'public_purchase',
      },
    });

    console.log(`[Stripe] Day pass checkout session created for ${email}, pass type: ${tier.name}`);

    res.json({ checkoutUrl: session.url });
  } catch (error: any) {
    console.error('[Stripe] Error creating day pass checkout:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.get('/api/stripe/customer-sync-status', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { getCustomerSyncStatus } = await import('../../core/stripe/customerSync');
    const status = await getCustomerSyncStatus();
    res.json(status);
  } catch (error: any) {
    console.error('[Stripe Customer Sync] Error getting status:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/stripe/sync-customers', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    console.log('[Stripe Customer Sync] Manual sync triggered by staff');
    const { syncStripeCustomersForMindBodyMembers } = await import('../../core/stripe/customerSync');
    const result = await syncStripeCustomersForMindBodyMembers();
    
    res.json({
      success: result.success,
      created: result.created,
      linked: result.linked,
      skipped: result.skipped,
      errorCount: result.errors.length,
      errors: result.errors.slice(0, 10),
      message: `Created ${result.created} new customers, linked ${result.linked} existing customers`,
    });
  } catch (error: any) {
    console.error('[Stripe Customer Sync] Error:', error);
    res.status(500).json({ error: 'Failed to sync customers' });
  }
});

export default router;
