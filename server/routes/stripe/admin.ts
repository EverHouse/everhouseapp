import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
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
  getDiscountSyncStatus,
  replayStripeEvent
} from '../../core/stripe';
import { checkExpiringCards } from '../../core/billing/cardExpiryChecker';
import { checkStaleWaivers } from '../../schedulers/waiverReviewScheduler';
import { getBillingClassificationSummary, getMembersNeedingStripeMigration } from '../../scripts/classifyMemberBilling';
import { escapeHtml, checkSyncCooldown } from './helpers';
import { sensitiveActionRateLimiter, checkoutRateLimiter } from '../../middleware/rateLimiting';
import { logFromRequest } from '../../core/auditLog';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';

const router = Router();

router.post('/api/admin/check-expiring-cards', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkExpiringCards();
    res.json(result);
  } catch (error: unknown) {
    logger.error('[Stripe] Error checking expiring cards', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check expiring cards', details: getErrorMessage(error) });
  }
});

router.post('/api/admin/check-stale-waivers', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkStaleWaivers();
    res.json(result);
  } catch (error: unknown) {
    logger.error('[Admin] Error checking stale waivers', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check stale waivers', details: getErrorMessage(error) });
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
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting products', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get Stripe products' });
  }
});

router.post('/api/stripe/products/sync', isStaffOrAdmin, sensitiveActionRateLimiter, async (req: Request, res: Response) => {
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
  } catch (error: unknown) {
    logger.error('[Stripe] Error syncing product', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync product to Stripe' });
  }
});

router.post('/api/stripe/products/sync-all', isStaffOrAdmin, sensitiveActionRateLimiter, async (req: Request, res: Response) => {
  try {
    const cooldown = checkSyncCooldown('sync_all_products');
    if (!cooldown.allowed) {
      return res.status(429).json({ 
        error: `This sync operation was run recently. Please wait ${cooldown.remainingSeconds} seconds before running again.`,
        cooldownRemaining: cooldown.remainingSeconds,
        lastRunAt: cooldown.lastRunAt
      });
    }

    const result = await syncAllHubSpotProductsToStripe();
    
    res.json({
      success: result.success,
      synced: result.synced,
      failed: result.failed,
      errors: result.errors
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error syncing all products', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync products to Stripe' });
  }
});

router.get('/api/stripe/tiers/status', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const status = await getTierSyncStatus();
    res.json({ tiers: status });
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting tier sync status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get tier sync status' });
  }
});

router.post('/api/stripe/tiers/sync', isAdmin, sensitiveActionRateLimiter, async (req: Request, res: Response) => {
  try {
    const cooldown = checkSyncCooldown('sync_tiers');
    if (!cooldown.allowed) {
      return res.status(429).json({ 
        error: `This sync operation was run recently. Please wait ${cooldown.remainingSeconds} seconds before running again.`,
        cooldownRemaining: cooldown.remainingSeconds,
        lastRunAt: cooldown.lastRunAt
      });
    }

    const result = await syncMembershipTiersToStripe();
    
    res.json({
      success: result.success,
      synced: result.synced,
      failed: result.failed,
      skipped: result.skipped,
      results: result.results
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error syncing tiers', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync membership tiers to Stripe' });
  }
});

router.get('/api/stripe/discounts/status', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const status = await getDiscountSyncStatus();
    res.json({ discounts: status });
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting discount sync status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get discount sync status' });
  }
});

router.post('/api/stripe/discounts/sync', isAdmin, sensitiveActionRateLimiter, async (req: Request, res: Response) => {
  try {
    const cooldown = checkSyncCooldown('sync_discounts');
    if (!cooldown.allowed) {
      return res.status(429).json({ 
        error: `This sync operation was run recently. Please wait ${cooldown.remainingSeconds} seconds before running again.`,
        cooldownRemaining: cooldown.remainingSeconds,
        lastRunAt: cooldown.lastRunAt
      });
    }

    const result = await syncDiscountRulesToStripeCoupons();
    
    res.json({
      success: result.success,
      synced: result.synced,
      failed: result.failed,
      skipped: result.skipped,
      results: result.results
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error syncing discounts', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync discount rules to Stripe coupons' });
  }
});

router.get('/api/stripe/billing/classification', isAdmin, async (req: Request, res: Response) => {
  try {
    const summary = await getBillingClassificationSummary();
    res.json(summary);
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting billing classification', { error: error instanceof Error ? error : new Error(String(error)) });
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
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting members needing migration', { error: error instanceof Error ? error : new Error(String(error)) });
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

    const tierResult = await db.execute(sql`SELECT id, name, stripe_price_id, price_cents, billing_interval 
       FROM membership_tiers 
       WHERE id = ${tierId} AND is_active = true 
         AND product_type = 'subscription'
         AND billing_interval IN ('month', 'year', 'week')`);

    if (tierResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tier not found or inactive' });
    }

    const tier = tierResult.rows[0] as any;

    if (!tier.stripe_price_id) {
      return res.status(400).json({ error: 'This tier has not been synced to Stripe. Please sync tiers first.' });
    }

    const stripe = await getStripeClient();

    const baseUrl = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'https://everclub.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          price: tier.stripe_price_id as string,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/`,
      metadata: {
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        tierId: String(tier.id),
        tierName: tier.name as string,
        source: 'staff_invite',
      },
    });

    const checkoutUrl = session.url;

    try {
      const { getResendClient } = await import('../../utils/resend');
      const { client: resend, fromEmail } = await getResendClient();

      const priceFormatted = tier.billing_interval === 'year' 
        ? `$${(Number(tier.price_cents) / 100).toFixed(0)}/year`
        : `$${(Number(tier.price_cents) / 100).toFixed(0)}/month`;

      const safeFirstName = escapeHtml(sanitizedFirstName);

      await resend.emails.send({
        from: fromEmail || 'Ever Club <noreply@everclub.app>',
        to: email,
        subject: `Your Ever Club Membership Invitation - ${tier.name}`,
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
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #1a1a1a;">Welcome to Ever Club, ${safeFirstName}!</h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">You've been invited to join Ever Club as a <strong>${tier.name}</strong> member at ${priceFormatted}.</p>
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
      logger.info('[Stripe] Membership invite email sent to', { extra: { email } });
    } catch (emailError: unknown) {
      logger.error('[Stripe] Failed to send membership invite email', { extra: { emailError } });
    }

    res.json({ success: true, checkoutUrl });
  } catch (error: unknown) {
    logger.error('[Stripe] Error sending membership invite', { error: error instanceof Error ? error : new Error(String(error)) });
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

    const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name, tier, last_tier, membership_status, billing_provider, stripe_customer_id
       FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0] as any;
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

    let reactivationLink = 'https://everclub.app/billing';
    let usedCheckout = false;

    if (member.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        const returnUrl = process.env.NODE_ENV === 'production' 
          ? 'https://everclub.app'
          : (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'https://everclub.app');

        const session = await stripe.billingPortal.sessions.create({
          customer: member.stripe_customer_id as string,
          return_url: returnUrl,
          flow_data: {
            type: 'payment_method_update',
          },
        });
        reactivationLink = session.url;
        logger.info('[Stripe] Created billing portal session for reactivation', { extra: { memberEmail: member.email } });
      } catch (portalError: unknown) {
        logger.warn('[Stripe] Could not create billing portal for , using fallback link', { extra: { email: member.email, error: getErrorMessage(portalError) } });
      }
    } else {
      const tierName = (member.last_tier || member.tier) as string | null;
      if (tierName) {
        try {
          const tierResult = await db.execute(sql`SELECT id, name, stripe_price_id, price_cents, billing_interval
            FROM membership_tiers
            WHERE LOWER(name) = LOWER(${tierName}) AND is_active = true
              AND product_type = 'subscription'
              AND billing_interval IN ('month', 'year', 'week')
            LIMIT 1`);

          if (tierResult.rows.length > 0) {
            const tier = tierResult.rows[0] as any;
            if (tier.stripe_price_id) {
              const stripe = await getStripeClient();
              const baseUrl = process.env.REPLIT_DEV_DOMAIN
                ? `https://${process.env.REPLIT_DEV_DOMAIN}`
                : 'https://everclub.app';

              const sanitizedFirstName = String(member.first_name || '').trim().slice(0, 100);
              const sanitizedLastName = String(member.last_name || '').trim().slice(0, 100);

              const checkoutSession = await stripe.checkout.sessions.create({
                mode: 'subscription',
                customer_email: member.email as string,
                line_items: [
                  {
                    price: tier.stripe_price_id as string,
                    quantity: 1,
                  },
                ],
                success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${baseUrl}/`,
                metadata: {
                  firstName: sanitizedFirstName,
                  lastName: sanitizedLastName,
                  tierId: String(tier.id),
                  tierName: tier.name as string,
                  source: 'reactivation',
                },
              });

              reactivationLink = checkoutSession.url || reactivationLink;
              usedCheckout = true;
              logger.info('[Stripe] Created checkout session for reactivation', { extra: { memberEmail: member.email, tierName: tier.name } });
            }
          }
        } catch (checkoutError: unknown) {
          logger.warn('[Stripe] Could not create checkout session for reactivation, using fallback link', { extra: { email: member.email, error: getErrorMessage(checkoutError) } });
        }
      }
    }

    if (member.stripe_customer_id && !usedCheckout) {
      const { sendGracePeriodReminderEmail } = await import('../../emails/membershipEmails');
      await sendGracePeriodReminderEmail(member.email as string, {
        memberName,
        currentDay: 1,
        totalDays: 3,
        reactivationLink
      });
    } else {
      try {
        const { getResendClient } = await import('../../utils/resend');
        const { client: resend, fromEmail } = await getResendClient();
        const safeFirstName = escapeHtml(String(member.first_name || memberName).trim());

        await resend.emails.send({
          from: fromEmail || 'Ever Club <noreply@everclub.app>',
          to: member.email as string,
          subject: "We'd Love to Have You Back at Ever Club",
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
              <img src="https://everclub.app/images/everclub-logo-dark.png" alt="Ever Club" width="180" height="60" style="display: inline-block;">
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #1a1a1a;">We Miss You, ${safeFirstName}!</h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">We'd love to welcome you back to Ever Club. Your spot is waiting for you.</p>
              <p style="margin: 0 0 32px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">Click below to rejoin and pick up right where you left off:</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center;">
                    <a href="${reactivationLink}" style="display: inline-block; padding: 14px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 500; border-radius: 8px;">Rejoin Ever Club</a>
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
        logger.info('[Stripe] Reactivation email sent to', { extra: { email: member.email } });
      } catch (emailError: unknown) {
        logger.error('[Stripe] Failed to send reactivation email', { extra: { emailError } });
      }
    }

    logFromRequest(req, {
      action: 'send_reactivation_link',
      resourceType: 'member',
      resourceId: String(member.id),
      resourceName: memberName,
      details: {
        memberEmail: member.email,
        hadStripeCustomer: !!member.stripe_customer_id,
        usedCheckout,
      }
    });

    logger.info('[Stripe] Reactivation link sent manually to by staff', { extra: { memberEmail: member.email } });

    res.json({ success: true, message: `Reactivation link sent to ${member.email}`, checkoutUrl: reactivationLink });
  } catch (error: unknown) {
    logger.error('[Stripe] Error sending reactivation link', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send reactivation link' });
  }
});

router.post('/api/public/day-pass/checkout', checkoutRateLimiter, async (req: Request, res: Response) => {
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

    const tierResult = await db.execute(sql`SELECT id, name, slug, stripe_price_id, price_cents, description 
       FROM membership_tiers 
       WHERE slug = ${sanitizedPassType} AND product_type = 'one_time' AND is_active = true`);

    if (tierResult.rows.length === 0) {
      return res.status(404).json({ error: 'Day pass type not found' });
    }

    const tier = tierResult.rows[0] as any;

    if (!tier.stripe_price_id) {
      return res.status(400).json({ error: 'This day pass is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.' });
    }

    const stripe = await getStripeClient();

    const domain = process.env.NODE_ENV === 'production' 
      ? 'https://everclub.app'
      : (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'https://everclub.app');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price: tier.stripe_price_id as string,
          quantity: 1,
        },
      ],
      customer_email: email,
      success_url: `${domain}/day-pass/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domain}/day-pass`,
      metadata: {
        productType: tier.slug as string,
        tierName: tier.name as string,
        email: email,
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        source: 'public_purchase',
      },
    });

    logger.info('[Stripe] Day pass checkout session created for , pass type', { extra: { email, tierName: tier.name } });

    res.json({ checkoutUrl: session.url });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating day pass checkout', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.get('/api/stripe/customer-sync-status', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { getCustomerSyncStatus } = await import('../../core/stripe/customerSync');
    const status = await getCustomerSyncStatus();
    res.json(status);
  } catch (error: unknown) {
    logger.error('[Stripe Customer Sync] Error getting status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

router.post('/api/stripe/sync-customers', isStaffOrAdmin, sensitiveActionRateLimiter, async (req: Request, res: Response) => {
  try {
    const cooldown = checkSyncCooldown('sync_customers');
    if (!cooldown.allowed) {
      return res.status(429).json({ 
        error: `This sync operation was run recently. Please wait ${cooldown.remainingSeconds} seconds before running again.`,
        cooldownRemaining: cooldown.remainingSeconds,
        lastRunAt: cooldown.lastRunAt
      });
    }

    logger.info('[Stripe Customer Sync] Manual sync triggered by staff');
    const { syncStripeCustomersForMindBodyMembers } = await import('../../core/stripe/customerSync');
    const result = await syncStripeCustomersForMindBodyMembers();
    
    res.json({
      success: result.success,
      created: (result as any).created,
      linked: (result as any).linked,
      skipped: result.skipped,
      errorCount: result.errors.length,
      errors: result.errors.slice(0, 10),
      message: `Created ${(result as any).created} new customers, linked ${(result as any).linked} existing customers`,
    });
  } catch (error: unknown) {
    logger.error('[Stripe Customer Sync] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync customers' });
  }
});

router.post('/api/admin/stripe/replay-webhook', isAdmin, async (req: Request, res: Response) => {
  try {
    const { eventId, forceReplay } = req.body;

    if (!eventId || typeof eventId !== 'string' || !eventId.startsWith('evt_')) {
      return res.status(400).json({ success: false, error: 'Invalid eventId. Must start with evt_' });
    }

    const result = await replayStripeEvent(eventId, forceReplay === true);

    logFromRequest(req, {
      action: 'replay_webhook',
      resourceType: 'system',
      resourceId: eventId,
      resourceName: `Webhook replay: ${result.eventType}`,
      details: {
        eventId,
        forceReplay: forceReplay === true,
        success: result.success,
        eventType: result.eventType,
        message: result.message
      }
    });

    res.json(result);
  } catch (error: unknown) {
    logger.error('[Stripe Admin] Error replaying webhook event', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({
      success: false,
      error: 'Failed to replay webhook event',
      details: getErrorMessage(error)
    });
  }
});

router.post('/api/stripe/sync-member-subscriptions', isStaffOrAdmin, sensitiveActionRateLimiter, async (req: Request, res: Response) => {
  try {
    const cooldown = checkSyncCooldown('sync_member_subscriptions');
    if (!cooldown.allowed) {
      return res.status(429).json({
        error: `This sync operation was run recently. Please wait ${cooldown.remainingSeconds} seconds before running again.`,
        cooldownRemaining: cooldown.remainingSeconds,
        lastRunAt: cooldown.lastRunAt
      });
    }

    const stripe = await getStripeClient();
    const { pool } = await import('../../core/db');

    const statusMap: Record<string, string> = {
      'active': 'active',
      'trialing': 'trialing',
      'past_due': 'past_due',
      'incomplete': 'pending',
      'incomplete_expired': 'pending',
      'canceled': 'cancelled',
      'unpaid': 'past_due',
      'paused': 'frozen'
    };

    const membersResult = await pool.query(
      `SELECT id, email, first_name, last_name, stripe_subscription_id, stripe_customer_id,
              membership_status, billing_provider, stripe_current_period_end, join_date, tier
       FROM users
       WHERE stripe_subscription_id IS NOT NULL OR stripe_customer_id IS NOT NULL`
    );

    const members = membersResult.rows;
    let synced = 0;
    let updated = 0;
    let errorCount = 0;
    const details: any[] = [];

    async function resolveTierFromSubscription(subscription: any): Promise<string | null> {
      const metadataTierSlug = subscription.metadata?.tier_slug || subscription.metadata?.tierSlug;
      const metadataTierName = subscription.metadata?.tier_name || subscription.metadata?.tier;

      if (metadataTierSlug) {
        const tierResult = await pool.query(
          'SELECT name FROM membership_tiers WHERE slug = $1',
          [metadataTierSlug]
        );
        if (tierResult.rows.length > 0) return tierResult.rows[0].name;
        if (metadataTierName) return metadataTierName;
      }

      const priceId = subscription.items?.data?.[0]?.price?.id;
      if (priceId) {
        const tierResult = await pool.query(
          'SELECT name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );
        if (tierResult.rows.length > 0) return tierResult.rows[0].name;
      }

      return null;
    }

    const BATCH_SIZE = 10;
    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      const batch = members.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async (member) => {
        const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

        if (member.stripe_subscription_id) {
          try {
            const subscription = await stripe.subscriptions.retrieve(member.stripe_subscription_id);
            const mappedStatus = statusMap[subscription.status] || subscription.status;
            const periodEnd = (subscription as any).current_period_end
              ? new Date((subscription as any).current_period_end * 1000)
              : null;
            const resolvedTier = await resolveTierFromSubscription(subscription);
            const changes: string[] = [];

            if (member.membership_status !== mappedStatus) {
              changes.push(`status: ${member.membership_status} → ${mappedStatus}`);
            }

            if (resolvedTier && member.tier !== resolvedTier) {
              changes.push(`tier: ${member.tier || 'none'} → ${resolvedTier}`);
            }

            const existingEnd = member.stripe_current_period_end
              ? new Date(member.stripe_current_period_end).toISOString()
              : null;
            const newEnd = periodEnd ? periodEnd.toISOString() : null;
            if (existingEnd !== newEnd) {
              changes.push(`period_end updated`);
            }

            if (member.billing_provider !== 'stripe') {
              changes.push(`billing_provider: ${member.billing_provider} → stripe`);
            }

            let setJoinDate = false;
            if ((mappedStatus === 'active' || mappedStatus === 'trialing') &&
                (!member.membership_status || member.membership_status === 'pending' || member.membership_status === 'inactive')) {
              if (!member.join_date) {
                setJoinDate = true;
                changes.push(`activated (join_date set)`);
              }
            }

            if (changes.length > 0) {
              const updateFields: string[] = [
                `membership_status = $1`,
                `billing_provider = 'stripe'`,
                `stripe_current_period_end = $2`,
                `updated_at = NOW()`
              ];
              const updateParams: any[] = [mappedStatus, periodEnd];
              let paramIndex = 3;

              if (resolvedTier && member.tier !== resolvedTier) {
                updateFields.push(`tier = $${paramIndex}`);
                updateParams.push(resolvedTier);
                paramIndex++;
              }

              if (setJoinDate) {
                updateFields.push(`join_date = $${paramIndex}`);
                updateParams.push(new Date());
                paramIndex++;
              }

              updateParams.push(member.id);
              await pool.query(
                `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
                updateParams
              );
              updated++;
              details.push({ email: member.email, name: memberName, changes });
            }
            synced++;
          } catch (err: unknown) {
            if (getErrorCode(err) === 'resource_missing') {
              await pool.query(
                `UPDATE users SET stripe_subscription_id = NULL, updated_at = NOW() WHERE id = $1`,
                [member.id]
              );
              updated++;
              details.push({ email: member.email, name: memberName, changes: ['subscription not found in Stripe — cleared'] });
              synced++;
            } else {
              errorCount++;
              details.push({ email: member.email, name: memberName, error: getErrorMessage(err) });
            }
          }
        } else if (member.stripe_customer_id) {
          try {
            const subscriptions = await stripe.subscriptions.list({
              customer: member.stripe_customer_id,
              status: 'active',
              limit: 1,
            });

            if (subscriptions.data.length > 0) {
              const sub = subscriptions.data[0];
              const mappedStatus = statusMap[sub.status] || sub.status;
              const periodEnd = (sub as any).current_period_end
                ? new Date((sub as any).current_period_end * 1000)
                : null;
              const resolvedTier = await resolveTierFromSubscription(sub);

              const updateFields: string[] = [
                `stripe_subscription_id = $1`,
                `membership_status = $2`,
                `billing_provider = 'stripe'`,
                `stripe_current_period_end = $3`,
                `updated_at = NOW()`
              ];
              const updateParams: any[] = [sub.id, mappedStatus, periodEnd];
              let paramIndex = 4;

              if (resolvedTier) {
                updateFields.push(`tier = COALESCE($${paramIndex}, tier)`);
                updateParams.push(resolvedTier);
                paramIndex++;
              }

              if (!member.join_date && (mappedStatus === 'active' || mappedStatus === 'trialing')) {
                updateFields.push(`join_date = $${paramIndex}`);
                updateParams.push(new Date());
                paramIndex++;
              }

              updateParams.push(member.id);
              await pool.query(
                `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
                updateParams
              );
              updated++;
              const changeDetails = [`linked subscription ${sub.id}`, `status: ${mappedStatus}`];
              if (resolvedTier) changeDetails.push(`tier: ${resolvedTier}`);
              details.push({ email: member.email, name: memberName, changes: changeDetails });
            }
            synced++;
          } catch (err: unknown) {
            errorCount++;
            details.push({ email: member.email, name: memberName, error: getErrorMessage(err) });
          }
        }
      }));
    }

    logFromRequest(req, {
      action: 'stripe_member_sync',
      resourceType: 'system',
      resourceName: 'Stripe Member Subscription Sync',
      details: { synced, updated, errors: errorCount, totalMembers: members.length }
    });

    res.json({ success: true, synced, updated, errors: errorCount, details });
  } catch (error: unknown) {
    logger.error('[Stripe] Error syncing member subscriptions', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync member subscriptions', details: getErrorMessage(error) });
  }
});

export default router;
