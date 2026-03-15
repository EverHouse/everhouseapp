import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from '../../core/stripe/client';
import Stripe from 'stripe';

import { CustomerSyncResult } from '../../core/stripe/customerSync';
import {
  syncMembershipTiersToStripe,
  getTierSyncStatus,
  syncDiscountRulesToStripeCoupons,
  getDiscountSyncStatus,
  replayStripeEvent
} from '../../core/stripe';
import { checkExpiringCards } from '../../core/billing/cardExpiryChecker';
import { getMembershipInviteHtml, getWinBackHtml } from '../../emails/memberInviteEmail';
import { checkStaleWaivers } from '../../schedulers/waiverReviewScheduler';
import { getBillingClassificationSummary, getMembersNeedingStripeMigration } from '../../scripts/classifyMemberBilling';
import { escapeHtml, checkSyncCooldown } from './helpers';
import { sensitiveActionRateLimiter, checkoutRateLimiter } from '../../middleware/rateLimiting';
import { logFromRequest } from '../../core/auditLog';
import { getErrorMessage, getErrorCode, safeErrorDetail } from '../../utils/errorUtils';
import { getAppBaseUrl } from '../../utils/urlUtils';

interface MemberSyncRow {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  membership_status: string | null;
  billing_provider: string | null;
  stripe_current_period_end: string | null;
  join_date: string | null;
  tier: string | null;
}

interface TierNameRow {
  name: string;
}

const router = Router();

router.post('/api/admin/check-expiring-cards', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkExpiringCards();
    res.json(result);
  } catch (error: unknown) {
    logger.error('[Stripe] Error checking expiring cards', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check expiring cards', details: safeErrorDetail(error) });
  }
});

router.post('/api/admin/check-stale-waivers', isAdmin, async (req: Request, res: Response) => {
  try {
    const result = await checkStaleWaivers();
    res.json(result);
  } catch (error: unknown) {
    logger.error('[Admin] Error checking stale waivers', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to check stale waivers', details: safeErrorDetail(error) });
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
    const { email: rawEmail, firstName, lastName, tierId } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();

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

    const tier = tierResult.rows[0] as { id: number; name: string; stripe_price_id: string | null; price_cents: number; billing_interval: string };

    if (!tier.stripe_price_id) {
      return res.status(400).json({ error: 'This tier has not been synced to Stripe. Please sync tiers first.' });
    }

    const stripe = await getStripeClient();

    const baseUrl = getAppBaseUrl();

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
        tierId: String(tier.id),
        tierName: tier.name as string,
        source: 'staff_invite',
      },
    });

    const checkoutUrl = session.url;

    if (!checkoutUrl) {
      logger.error('[Stripe] Checkout session created but no URL returned', { extra: { sessionId: session.id, email } });
      return res.status(500).json({ error: 'Failed to generate checkout URL' });
    }

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
        html: getMembershipInviteHtml({ firstName: safeFirstName, tierName: tier.name, priceFormatted, checkoutUrl }),
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
    const { memberEmail: rawMemberEmail, subscriptionId } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();

    if (!memberEmail) {
      return res.status(400).json({ error: 'Missing required field: memberEmail' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(memberEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name, tier, last_tier, membership_status, billing_provider, stripe_customer_id, stripe_subscription_id
       FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0] as { id: number; email: string; first_name: string | null; last_name: string | null; tier: string | null; last_tier: string | null; membership_status: string | null; billing_provider: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null };
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

    let reactivationLink = 'https://everclub.app/billing';
    let usedCheckout = false;
    let usedInvoiceLink = false;

    const subIdToCheck = subscriptionId || member.stripe_subscription_id;
    if (subIdToCheck && member.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        const sub = await stripe.subscriptions.retrieve(subIdToCheck, { expand: ['latest_invoice'] });
        const subCustomer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        if (subCustomer && member.stripe_customer_id && subCustomer !== member.stripe_customer_id) {
          logger.warn('[Stripe] Subscription does not belong to member', { extra: { email: member.email, subscriptionId: subIdToCheck, subCustomer, memberCustomer: member.stripe_customer_id } });
        } else if (sub.status === 'incomplete') {
          const invoice = sub.latest_invoice as Stripe.Invoice | null;
          if (invoice?.hosted_invoice_url) {
            reactivationLink = invoice.hosted_invoice_url;
            usedInvoiceLink = true;
            logger.info('[Stripe] Using hosted invoice URL for incomplete subscription activation', { extra: { memberEmail: member.email, invoiceId: invoice.id } });
          }
        }
      } catch (subError: unknown) {
        logger.warn('[Stripe] Could not retrieve subscription for activation link', { extra: { email: member.email, subscriptionId: subIdToCheck, error: getErrorMessage(subError) } });
      }
    }

    if (!usedInvoiceLink && member.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        const returnUrl = getAppBaseUrl();

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
        logger.warn('[Stripe] Could not create billing portal for member, using fallback link', { extra: { email: member.email, error: getErrorMessage(portalError) } });
      }
    } else if (!usedInvoiceLink) {
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
            const tier = tierResult.rows[0] as { id: number; name: string; stripe_price_id: string | null; price_cents: number; billing_interval: string };
            if (tier.stripe_price_id) {
              const stripe = await getStripeClient();
              const baseUrl = getAppBaseUrl();

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
        memberName: memberName as string,
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
          html: getWinBackHtml({ firstName: safeFirstName, reactivationLink }),
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
      resourceName: memberName as string,
      details: {
        memberEmail: member.email as string,
        hadStripeCustomer: !!member.stripe_customer_id,
        usedCheckout,
        usedInvoiceLink,
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
    const { email: rawEmail, passType, firstName, lastName } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();

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

    const tier = tierResult.rows[0] as { id: number; name: string; slug: string; stripe_price_id: string | null; price_cents: number; description: string | null };

    if (!tier.stripe_price_id) {
      return res.status(400).json({ error: 'This day pass is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.' });
    }

    const stripe = await getStripeClient();

    const domain = getAppBaseUrl();

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
        purpose: 'day_pass',
        product_slug: tier.slug as string,
        purchaser_email: email,
        purchaser_first_name: sanitizedFirstName,
        purchaser_last_name: sanitizedLastName,
        purchaser_phone: '',
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
    res.status(500).json({ error: 'Failed to get customer sync status' });
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
      created: (result as CustomerSyncResult & { created?: number; linked?: number }).created,
      linked: (result as CustomerSyncResult & { created?: number; linked?: number }).linked,
      skipped: result.skipped,
      errorCount: result.errors.length,
      errors: result.errors.slice(0, 10),
      message: `Created ${(result as CustomerSyncResult & { created?: number; linked?: number }).created} new customers, linked ${(result as CustomerSyncResult & { created?: number; linked?: number }).linked} existing customers`,
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

    const membersResult = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_subscription_id, stripe_customer_id,
              membership_status, billing_provider, stripe_current_period_end, join_date, tier
       FROM users
       WHERE stripe_subscription_id IS NOT NULL OR stripe_customer_id IS NOT NULL`);

    const members = membersResult.rows as unknown as MemberSyncRow[];
    let synced = 0;
    let updated = 0;
    let errorCount = 0;
    const details: Array<{ email: string; action: string; changes?: string[] }> = [];

    async function resolveTierFromSubscription(subscription: Stripe.Subscription): Promise<string | null> {
      const metadataTierSlug = subscription.metadata?.tier_slug || subscription.metadata?.tierSlug;
      const metadataTierName = subscription.metadata?.tier_name || subscription.metadata?.tier;

      if (metadataTierSlug) {
        const tierResult = await db.execute(sql`SELECT name FROM membership_tiers WHERE slug = ${metadataTierSlug}`);
        if (tierResult.rows.length > 0) return (tierResult.rows[0] as unknown as TierNameRow).name;
        if (metadataTierName) return metadataTierName;
      }

      const priceId = subscription.items?.data?.[0]?.price?.id;
      if (priceId) {
        const tierResult = await db.execute(sql`SELECT name FROM membership_tiers WHERE stripe_price_id = ${priceId} OR founding_price_id = ${priceId}`);
        if (tierResult.rows.length > 0) return (tierResult.rows[0] as unknown as TierNameRow).name;
      }

      return null;
    }

    const BATCH_SIZE = 10;
    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      const batch = members.slice(i, i + BATCH_SIZE);
      const _results = await Promise.allSettled(batch.map(async (member) => {
        const _memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || String(member.email);

        if (member.stripe_subscription_id) {
          try {
            const subscription = await stripe.subscriptions.retrieve(member.stripe_subscription_id as string);
            const mappedStatus = statusMap[subscription.status] || subscription.status;
            const periodEnd = subscription.items.data[0]?.current_period_end
              ? new Date(subscription.items.data[0].current_period_end * 1000)
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
              ? new Date(member.stripe_current_period_end as string).toISOString()
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
              const updateParts = [
                sql`membership_status = ${mappedStatus}`,
                sql`billing_provider = 'stripe'`,
                sql`stripe_current_period_end = ${periodEnd}`,
                sql`updated_at = NOW()`
              ];

              if (resolvedTier && member.tier !== resolvedTier) {
                updateParts.push(sql`tier = ${resolvedTier}`);
              }

              if (setJoinDate) {
                updateParts.push(sql`join_date = ${new Date()}`);
              }

              await db.execute(sql`UPDATE users SET ${sql.join(updateParts, sql`, `)} WHERE id = ${member.id}`);
              updated++;
              details.push({ email: String(member.email), action: 'updated', changes });
            }
            synced++;
          } catch (err: unknown) {
            if (getErrorCode(err) === 'resource_missing') {
              await db.execute(sql`UPDATE users SET stripe_subscription_id = NULL, updated_at = NOW() WHERE id = ${member.id}`);
              updated++;
              details.push({ email: String(member.email), action: 'cleared', changes: ['subscription not found in Stripe — cleared'] });
              synced++;
            } else {
              errorCount++;
              details.push({ email: String(member.email), action: 'error', changes: [getErrorMessage(err)] });
            }
          }
        } else if (member.stripe_customer_id) {
          try {
            const subscriptions = await stripe.subscriptions.list({
              customer: member.stripe_customer_id as string,
              status: 'active',
              limit: 1,
            });

            if (subscriptions.data.length > 0) {
              const sub = subscriptions.data[0];
              const mappedStatus = statusMap[sub.status] || sub.status;
              const periodEnd = sub.items.data[0]?.current_period_end
                ? new Date(sub.items.data[0].current_period_end * 1000)
                : null;
              const resolvedTier = await resolveTierFromSubscription(sub);

              const updateParts = [
                sql`stripe_subscription_id = ${sub.id}`,
                sql`membership_status = ${mappedStatus}`,
                sql`billing_provider = 'stripe'`,
                sql`stripe_current_period_end = ${periodEnd}`,
                sql`updated_at = NOW()`
              ];

              if (resolvedTier) {
                updateParts.push(sql`tier = COALESCE(${resolvedTier}, tier)`);
              }

              if (!member.join_date && (mappedStatus === 'active' || mappedStatus === 'trialing')) {
                updateParts.push(sql`join_date = ${new Date()}`);
              }

              await db.execute(sql`UPDATE users SET ${sql.join(updateParts, sql`, `)} WHERE id = ${member.id}`);
              updated++;
              const changeDetails = [`linked subscription ${sub.id}`, `status: ${mappedStatus}`];
              if (resolvedTier) changeDetails.push(`tier: ${resolvedTier}`);
              details.push({ email: String(member.email), action: 'linked', changes: changeDetails });
            }
            synced++;
          } catch (err: unknown) {
            errorCount++;
            details.push({ email: String(member.email), action: 'error', changes: [getErrorMessage(err)] });
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
    res.status(500).json({ error: 'Failed to sync member subscriptions', details: safeErrorDetail(error) });
  }
});

export default router;
