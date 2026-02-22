import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { membershipTiers, users } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import {
  createSubscription,
  cancelSubscription,
  listCustomerSubscriptions,
  syncActiveSubscriptionsFromStripe,
  getOrCreateStripeCustomer,
  getStripeClient
} from '../../core/stripe';
import { getSessionUser } from '../../types/session';
import { logFromRequest } from '../../core/auditLog';
import { sendNotificationToUser, broadcastBillingUpdate } from '../../core/websocket';
import { sendMembershipActivationEmail } from '../../emails/membershipEmails';
import { findOrCreateHubSpotContact } from '../../core/hubspot/members';
import { randomUUID } from 'crypto';
import { checkSyncCooldown } from './helpers';
import { sensitiveActionRateLimiter } from '../../middleware/rateLimiting';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';

const router = Router();

router.get('/api/stripe/subscriptions/:customerId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    
    const result = await listCustomerSubscriptions(customerId as string);
    
    if (!result.success) {
      const statusCode = result.errorCode === 'CUSTOMER_NOT_FOUND' ? 404 : 500;
      return res.status(statusCode).json({ 
        error: result.error || 'Failed to list subscriptions',
        errorCode: result.errorCode
      });
    }
    
    res.json({
      subscriptions: result.subscriptions,
      count: result.subscriptions?.length || 0
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error listing subscriptions', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

router.post('/api/stripe/subscriptions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId, priceId, memberEmail: rawMemberEmail } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    
    if (!customerId || !priceId) {
      return res.status(400).json({ error: 'Missing required fields: customerId, priceId' });
    }
    
    const result = await createSubscription({
      customerId,
      priceId,
      metadata: memberEmail ? { memberEmail } : undefined
    });
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to create subscription' });
    }
    
    try {
      if (memberEmail) {
        sendNotificationToUser(memberEmail, {
          type: 'billing_update',
          title: 'Subscription Started',
          message: 'Your membership subscription has been activated.',
          data: { subscriptionId: result.subscription?.subscriptionId }
        });
        broadcastBillingUpdate({ action: 'subscription_created', memberEmail });
      } else {
        const memberLookup = await db.select({ email: users.email }).from(users).where(eq(users.stripeCustomerId, customerId));
        if (memberLookup.length > 0) {
          const email = memberLookup[0].email;
          sendNotificationToUser(email, {
            type: 'billing_update',
            title: 'Subscription Started',
            message: 'Your membership subscription has been activated.',
            data: { subscriptionId: result.subscription?.subscriptionId }
          });
          broadcastBillingUpdate({ action: 'subscription_created', memberEmail: email });
        }
      }
    } catch (notifyError) {
      logger.error('[Stripe] Failed to send subscription creation notification', { extra: { notifyError } });
    }
    
    res.json({
      success: true,
      subscription: result.subscription
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating subscription', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.delete('/api/stripe/subscriptions/:subscriptionId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { subscriptionId } = req.params;
    
    const memberLookup = await db.select({ email: users.email }).from(users).where(eq(users.stripeSubscriptionId, subscriptionId as string));
    
    const result = await cancelSubscription(subscriptionId as string);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to cancel subscription' });
    }
    
    try {
      if (memberLookup.length > 0) {
        const memberEmail = memberLookup[0].email;
        sendNotificationToUser(memberEmail, {
          type: 'billing_update',
          title: 'Subscription Cancelled',
          message: 'Your membership subscription has been cancelled.',
          data: { subscriptionId }
        });
        broadcastBillingUpdate({ action: 'subscription_cancelled', memberEmail });
      }
    } catch (notifyError) {
      logger.error('[Stripe] Failed to send subscription cancellation notification', { extra: { notifyError } });
    }
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error canceling subscription', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

router.post('/api/stripe/sync-subscriptions', isStaffOrAdmin, sensitiveActionRateLimiter, async (req: Request, res: Response) => {
  try {
    const cooldown = checkSyncCooldown('sync_subscriptions');
    if (!cooldown.allowed) {
      return res.status(429).json({ 
        error: `This sync operation was run recently. Please wait ${cooldown.remainingSeconds} seconds before running again.`,
        cooldownRemaining: cooldown.remainingSeconds,
        lastRunAt: cooldown.lastRunAt
      });
    }

    const result = await syncActiveSubscriptionsFromStripe();
    
    res.json({
      success: result.success,
      processed: result.created + result.updated + result.skipped,
      updated: result.updated,
      errors: result.errors
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error syncing subscriptions', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync subscriptions' });
  }
});

router.get('/api/stripe/coupons', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = (await import('../../core/stripe')).getStripeClient();
    const stripeClient = await stripe;
    
    const coupons = await stripeClient.coupons.list({
      limit: 50
    });
    
    const activeCoupons = coupons.data
      .filter(c => c.valid)
      .map(c => ({
        id: c.id,
        name: c.name || c.id,
        percentOff: c.percent_off,
        amountOff: c.amount_off,
        currency: c.currency,
        duration: c.duration,
        durationInMonths: c.duration_in_months
      }));
    
    res.json({ coupons: activeCoupons });
  } catch (error: unknown) {
    logger.error('[Stripe] Error listing coupons', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to load coupons' });
  }
});

router.post('/api/stripe/subscriptions/create-for-member', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberEmail: rawMemberEmail, tierName, couponId } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    const sessionUser = getSessionUser(req);
    
    if (!memberEmail || !tierName) {
      return res.status(400).json({ error: 'memberEmail and tierName are required' });
    }
    
    const memberResult = await db.select({
      id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
      tier: users.tier, stripeCustomerId: users.stripeCustomerId, billingProvider: users.billingProvider,
      stripeSubscriptionId: users.stripeSubscriptionId,
    }).from(users).where(sql`LOWER(${users.email}) = ${memberEmail.toLowerCase()}`);
    
    if (memberResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = memberResult[0];
    
    if (member.stripeSubscriptionId) {
      return res.status(400).json({ error: 'Member already has an active subscription' });
    }
    
    const tierResult = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.name, tierName))
      .limit(1);
    
    if (tierResult.length === 0) {
      return res.status(400).json({ error: `Tier "${tierName}" not found` });
    }
    
    const tier = tierResult[0];
    
    if (!tier.stripePriceId) {
      return res.status(400).json({ error: `The "${tierName}" tier is not set up in Stripe yet. Run "Sync to Stripe" from Products & Pricing first.` });
    }
    
    const memberName = `${member.firstName || ''} ${member.lastName || ''}`.trim() || member.email;
    const { customerId } = await getOrCreateStripeCustomer(
      member.id.toString(),
      member.email,
      memberName,
      tierName
    );
    
    const subscriptionResult = await createSubscription({
      customerId,
      priceId: tier.stripePriceId,
      couponId: couponId || undefined,
      metadata: {
        memberEmail: member.email,
        tier: tierName,
        tier_slug: tier.slug,
        createdBy: sessionUser?.email || 'staff',
        ...(couponId ? { couponApplied: couponId } : {})
      }
    });
    
    if (!subscriptionResult.success) {
      return res.status(500).json({ error: subscriptionResult.error || 'Failed to create subscription' });
    }
    
    // Store subscription for potential rollback in case of database failure
    const stripeSubscription = subscriptionResult.subscription;
    
    const subStatus = stripeSubscription?.status;
    const memberStatus = (subStatus === 'active' || subStatus === 'trialing') ? 'active' : 'pending';
    
    try {
      await db.update(users).set({
        billingProvider: 'stripe',
        tier: tierName,
        stripeSubscriptionId: stripeSubscription?.subscriptionId,
        membershipStatus: memberStatus,
        updatedAt: new Date(),
      }).where(eq(users.id, member.id));
    } catch (dbError) {
      // Database update failed after Stripe subscription was created
      // Roll back the Stripe subscription to prevent charging the customer without granting access
      if (stripeSubscription?.subscriptionId) {
        try {
          await cancelSubscription(stripeSubscription.subscriptionId);
          logger.error('[Stripe] Rolled back subscription  due to database update failure', { extra: { subscriptionId: stripeSubscription.subscriptionId, dbError } });
        } catch (cancelError) {
          logger.error('[Stripe] CRITICAL: Failed to cancel subscription  during rollback. Customer was charged but access was not granted', { extra: { subscriptionId: stripeSubscription.subscriptionId, cancelError } });
          throw new Error(
            `Failed to complete subscription setup. Database error: ${dbError instanceof Error ? dbError.message : String(dbError)}. ` +
            `Rollback attempt failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}. ` +
            `Subscription ${stripeSubscription.subscriptionId} may need manual cancellation in Stripe.`
          );
        }
      }
      throw new Error(
        `Failed to activate membership in database: ${dbError instanceof Error ? dbError.message : String(dbError)}. ` +
        `Stripe subscription ${stripeSubscription?.subscriptionId} has been cancelled to prevent unauthorized charges.`
      );
    }
    
    await logFromRequest(req, {
      action: 'subscription_created',
      resourceType: 'member',
      resourceId: member.id.toString(),
      resourceName: memberName,
      details: {
        tier: tierName,
        subscriptionId: subscriptionResult.subscription?.subscriptionId,
        customerId,
        previousBillingProvider: member.billingProvider,
        previousTier: member.tier
      }
    });
    
    // Sync to HubSpot
    try {
      const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
      await syncMemberToHubSpot({ email: member.email, status: memberStatus, tier: tierName, billingProvider: 'stripe', memberSince: new Date(), billingGroupRole: 'Primary' });
      logger.info('[Stripe] Synced to HubSpot: status=, tier=, billing=stripe, memberSince=now', { extra: { memberEmail: member.email, memberStatus, tierName } });
    } catch (hubspotError) {
      logger.error('[Stripe] HubSpot sync failed for subscription creation', { extra: { hubspotError } });
    }
    
    logger.info('[Stripe] Created subscription for', { extra: { memberEmail: member.email, subscriptionResultSubscription: subscriptionResult.subscription?.subscriptionId } });
    
    try {
      sendNotificationToUser(member.email, {
        type: 'billing_update',
        title: 'Membership Activated',
        message: `Your ${tierName} membership has been activated.`,
        data: { subscriptionId: subscriptionResult.subscription?.subscriptionId, tier: tierName }
      });
      broadcastBillingUpdate({ action: 'subscription_created', memberEmail: member.email });
    } catch (notifyError) {
      logger.error('[Stripe] Failed to send membership activation notification', { extra: { notifyError } });
    }
    
    res.json({
      success: true,
      subscription: subscriptionResult.subscription,
      customerId,
      message: `Successfully created ${tierName} subscription for ${memberName}`
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating subscription for member', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to create subscription' });
  }
});

router.post('/api/stripe/subscriptions/create-new-member', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, firstName, lastName, phone, dob, tierSlug, couponId, streetAddress, city, state, zipCode } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    const sessionUser = getSessionUser(req);
    
    if (!email || !tierSlug) {
      return res.status(400).json({ error: 'email and tierSlug are required' });
    }
    
    const { resolveUserByEmail } = await import('../../core/stripe/customers');
    const resolved = await resolveUserByEmail(email);

    const existingUser = resolved
      ? await db.select({
          id: users.id, firstName: users.firstName, lastName: users.lastName,
          membershipStatus: users.membershipStatus, createdAt: users.createdAt,
          archivedAt: users.archivedAt, stripeCustomerId: users.stripeCustomerId,
        }).from(users).where(eq(users.id, resolved.userId))
      : await db.select({
          id: users.id, firstName: users.firstName, lastName: users.lastName,
          membershipStatus: users.membershipStatus, createdAt: users.createdAt,
          archivedAt: users.archivedAt, stripeCustomerId: users.stripeCustomerId,
        }).from(users).where(sql`LOWER(${users.email}) = ${email.toLowerCase()}`);

    if (resolved && resolved.matchType !== 'direct') {
      logger.info('[Stripe] Email resolved to existing user via', { extra: { email, resolvedPrimaryEmail: resolved.primaryEmail, resolvedMatchType: resolved.matchType } });
    }
    
    let existingUserId: string | null = null;
    
    if (existingUser.length > 0) {
      const existing = existingUser[0];
      if (existing.archivedAt && ['non-member', 'visitor', null].includes(existing.membershipStatus)) {
        existingUserId = existing.id;
        logger.info('[Stripe] Unarchiving user for new membership creation', { extra: { email } });
      } else if (existing.membershipStatus === 'pending') {
        existingUserId = existing.id;
        logger.info('[Stripe] Reusing pending user () for new membership creation', { extra: { email, existingId: existing.id } });
        if (existing.stripeCustomerId) {
          try {
            const stripeClient = await getStripeClient();
            const subs = await stripeClient.subscriptions.list({ customer: existing.stripeCustomerId, status: 'all', limit: 10 });
            for (const sub of subs.data) {
              if (['active', 'trialing', 'past_due', 'incomplete'].includes(sub.status)) {
                await stripeClient.subscriptions.cancel(sub.id);
                logger.info('[Stripe] Cancelled stale subscription during pending user reuse', { extra: { subId: sub.id } });
              }
            }
            await stripeClient.customers.del(existing.stripeCustomerId);
            logger.info('[Stripe] Deleted stale Stripe customer during pending user reuse', { extra: { existingStripe_customer_id: existing.stripeCustomerId } });
          } catch (cleanupErr: unknown) {
            logger.error('[Stripe] Failed to cleanup stale Stripe data for pending user:', { extra: { error: getErrorMessage(cleanupErr) } });
          }
          await db.update(users).set({ stripeCustomerId: null, stripeSubscriptionId: null }).where(eq(users.id, existing.id));
        }
      } else {
        const name = [existing.firstName, existing.lastName].filter(Boolean).join(' ') || email;
        return res.status(400).json({ 
          error: 'A member with this email already exists',
          existingUserName: name
        });
      }
    }
    
    const tierResult = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, tierSlug))
      .limit(1);
    
    if (tierResult.length === 0) {
      return res.status(400).json({ error: `Tier "${tierSlug}" not found` });
    }
    
    const tier = tierResult[0];
    
    if (!tier.stripePriceId) {
      return res.status(400).json({ error: `The "${tier.name}" tier is not set up in Stripe yet. Run "Sync to Stripe" from Products & Pricing first.` });
    }
    
    const userId = existingUserId || randomUUID();
    const memberName = `${firstName || ''} ${lastName || ''}`.trim() || email;
    
    if (existingUserId) {
      await db.execute(sql`UPDATE users SET archived_at = NULL, archived_by = NULL, first_name = COALESCE(${firstName || null}, first_name), last_name = COALESCE(${lastName || null}, last_name), phone = COALESCE(${phone || null}, phone), date_of_birth = COALESCE(${dob || null}, date_of_birth), street_address = COALESCE(${streetAddress || null}, street_address), city = COALESCE(${city || null}, city), state = COALESCE(${state || null}, state), zip_code = COALESCE(${zipCode || null}, zip_code), tier = ${tier.name}, membership_status = 'pending', billing_provider = 'stripe', updated_at = NOW() WHERE id = ${existingUserId}`);
      logger.info('[Stripe] Unarchived and updated existing user with tier', { extra: { email, tierName: tier.name } });
    } else {
      const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${email.toLowerCase()}`);
      if (exclusionCheck.rows.length > 0) {
        logger.warn('[Stripe] Blocked subscription creation for permanently deleted member', { extra: { email } });
        return res.status(400).json({ error: 'This email belongs to a previously removed member and cannot be re-used for a new membership.' });
      }
      await db.insert(users).values({
        id: userId,
        email: email.toLowerCase(),
        firstName: firstName || null,
        lastName: lastName || null,
        phone: phone || null,
        dateOfBirth: dob || null,
        tier: tier.name,
        membershipStatus: 'pending',
        billingProvider: 'stripe',
        streetAddress: streetAddress || null,
        city: city || null,
        state: state || null,
        zipCode: zipCode || null,
        createdAt: new Date(),
      });
      logger.info('[Stripe] Created pending user with tier', { extra: { email, tierName: tier.name } });
    }
    
    const { customerId } = await getOrCreateStripeCustomer(
      userId,
      email,
      memberName,
      tier.name
    );
    
    await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));
    
    const subscriptionResult = await createSubscription({
      customerId,
      priceId: tier.stripePriceId,
      couponId: couponId || undefined,
      metadata: {
        memberEmail: email,
        tier: tier.name,
        tier_slug: tier.slug,
        createdBy: sessionUser?.email || 'staff',
        userId,
        isNewMember: 'true',
        ...(couponId ? { couponApplied: couponId } : {})
      }
    });
    
    if (!subscriptionResult.success) {
      if (!existingUserId) {
        await db.delete(users).where(eq(users.id, userId));
      } else {
        await db.update(users).set({
          membershipStatus: 'non-member', tier: null, billingProvider: null,
          archivedAt: new Date(), archivedBy: 'system_rollback', updatedAt: new Date(),
        }).where(eq(users.id, userId));
      }
      return res.status(500).json({ error: subscriptionResult.error || 'Failed to create subscription' });
    }
    
    try {
      await db.update(users).set({ stripeSubscriptionId: subscriptionResult.subscription?.subscriptionId }).where(eq(users.id, userId));
    } catch (dbError: unknown) {
      logger.error('[Stripe] DB update failed after subscription creation. Rolling back...', { extra: { dbError: getErrorMessage(dbError) } });
      if (subscriptionResult.subscription?.subscriptionId) {
        try {
          await cancelSubscription(subscriptionResult.subscription.subscriptionId);
          logger.info('[Stripe] Emergency rollback: cancelled subscription', { extra: { subscriptionResultSubscriptionSubscriptionId: subscriptionResult.subscription.subscriptionId } });
          if (!existingUserId) {
            await db.delete(users).where(eq(users.id, userId));
          } else {
            await db.update(users).set({
              membershipStatus: 'non-member', tier: null, billingProvider: null,
              archivedAt: new Date(), archivedBy: 'system_rollback', updatedAt: new Date(),
            }).where(eq(users.id, userId));
          }
          return res.status(500).json({ 
            error: 'System error during activation. Payment has been voided. Please try again.' 
          });
        } catch (cancelError: unknown) {
          logger.error('[Stripe] CRITICAL: Failed to cancel subscription  during rollback. User preserved for manual cleanup.', { extra: { subscriptionId: subscriptionResult.subscription.subscriptionId, error: getErrorMessage(cancelError) } });
          return res.status(500).json({ 
            error: 'CRITICAL: Account setup failed but the payment could not be automatically reversed. Please contact support immediately so we can issue a refund.' 
          });
        }
      }
      if (!existingUserId) {
        await db.delete(users).where(eq(users.id, userId));
      } else {
        await db.update(users).set({
          membershipStatus: 'non-member', tier: null, billingProvider: null,
          archivedAt: new Date(), archivedBy: 'system_rollback', updatedAt: new Date(),
        }).where(eq(users.id, userId));
      }
      return res.status(500).json({ 
        error: 'System error during activation. Please try again.' 
      });
    }
    
    await logFromRequest(req, {
      action: 'new_member_subscription_created',
      resourceType: 'member',
      resourceId: userId,
      resourceName: memberName,
      details: {
        tier: tier.name,
        subscriptionId: subscriptionResult.subscription?.subscriptionId,
        customerId
      }
    });
    
    logger.info('[Stripe] Created subscription for new member', { extra: { subscriptionResultSubscription: subscriptionResult.subscription?.subscriptionId, email } });
    
    // If no clientSecret, the subscription may be fully paid (e.g., 100% discount) or there's an issue
    if (!subscriptionResult.subscription?.clientSecret) {
      logger.warn('[Stripe] No clientSecret returned for subscription', { extra: { subscriptionResultSubscription: subscriptionResult.subscription?.subscriptionId } });
    }
    
    res.json({
      success: true,
      clientSecret: subscriptionResult.subscription?.clientSecret || null,
      subscriptionId: subscriptionResult.subscription?.subscriptionId,
      customerId,
      userId,
      tierName: tier.name
    });

    // Background sync to HubSpot (fire-and-forget)
    findOrCreateHubSpotContact(email, firstName || '', lastName || '', phone).catch((err) => {
      logger.error('[Subscriptions] Background HubSpot contact sync failed:', { extra: { error: getErrorMessage(err), email } });
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating new member subscription', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to create subscription' });
  }
});

router.post('/api/stripe/subscriptions/confirm-inline-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, subscriptionId, userId } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'paymentIntentId is required' });
    }
    
    const stripe = await getStripeClient();
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: `Payment not successful. Status: ${paymentIntent.status}` 
      });
    }
    
    const invoiceId = paymentIntent.metadata?.invoice_id;
    const subId = subscriptionId || paymentIntent.metadata?.subscription_id;
    
    if (invoiceId) {
      try {
        const invoice = await stripe.invoices.retrieve(invoiceId);
        
        if (invoice.status === 'open') {
          const paymentMethodId = paymentIntent.payment_method;
          
          if (paymentMethodId && typeof paymentMethodId === 'string') {
            await stripe.customers.update(paymentIntent.customer as string, {
              invoice_settings: { default_payment_method: paymentMethodId }
            });
          }

          const invoicePiId = typeof (invoice as any).payment_intent === 'string'
            ? (invoice as any).payment_intent
            : (invoice as any).payment_intent?.id;
          if (invoicePiId && invoicePiId !== paymentIntentId) {
            try {
              await stripe.paymentIntents.cancel(invoicePiId);
              logger.info('[Stripe Subscriptions] Cancelled invoice-generated PI before OOB reconciliation', { extra: { invoicePiId, invoiceId } });
            } catch (cancelErr: unknown) {
              logger.warn('[Stripe Subscriptions] Could not cancel invoice PI', { extra: { invoicePiId, error: getErrorMessage(cancelErr) } });
            }
          }

          await stripe.invoices.pay(invoiceId, {
            paid_out_of_band: true
          });

          try {
            await stripe.invoices.update(invoiceId, {
              metadata: {
                ...((invoice.metadata as Record<string, string>) || {}),
                reconciled_by_pi: paymentIntentId,
                reconciliation_source: 'inline_payment',
              }
            });
          } catch (_metaErr: unknown) { /* non-blocking */ }

          logger.info('[Stripe Subscriptions] Invoice reconciled with inline PI', { extra: { invoiceId, paymentIntentId } });
        }
      } catch (invoiceError: unknown) {
        logger.error('[Stripe Subscriptions] Error paying invoice', { extra: { invoiceError: getErrorMessage(invoiceError) } });
      }
    }
    
    let userEmail = '';
    let tierName = '';
    
    if (userId) {
      const userResult = await db.select({ email: users.email, tier: users.tier }).from(users).where(eq(users.id, userId));
      
      if (userResult.length > 0) {
        userEmail = userResult[0].email;
        tierName = userResult[0].tier;
        
        await db.update(users).set({ membershipStatus: 'active', billingProvider: 'stripe', updatedAt: new Date() }).where(eq(users.id, userId));
        logger.info('[Stripe Subscriptions] Activated member', { extra: { userEmail } });
      }
    } else if (paymentIntent.customer) {
      const custResult = await db.select({ id: users.id, email: users.email, tier: users.tier }).from(users).where(eq(users.stripeCustomerId, paymentIntent.customer as string));
      
      if (custResult.length > 0) {
        userEmail = custResult[0].email;
        tierName = custResult[0].tier;
        
        await db.update(users).set({ membershipStatus: 'active', billingProvider: 'stripe', updatedAt: new Date() }).where(eq(users.stripeCustomerId, paymentIntent.customer as string));
        logger.info('[Stripe Subscriptions] Activated member via customer ID', { extra: { userEmail } });
      }
    }
    
    if (userEmail) {
      try {
        const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
        await syncMemberToHubSpot({ 
          email: userEmail, 
          status: 'active', 
          tier: tierName, 
          billingProvider: 'stripe', 
          memberSince: new Date(),
          billingGroupRole: 'Primary',
        });
        logger.info('[Stripe Subscriptions] Synced to HubSpot', { extra: { userEmail } });
      } catch (hubspotError) {
        logger.error('[Stripe Subscriptions] HubSpot sync failed', { extra: { hubspotError } });
      }
      
      try {
        const { sendNotificationToUser: sendNotif, broadcastBillingUpdate: broadcastUpdate } = await import('../../core/websocket');
        sendNotif(userEmail, {
          type: 'billing_update',
          title: 'Membership Activated',
          message: `Your ${tierName} membership has been activated.`,
          data: { subscriptionId: subId, tier: tierName }
        });
        (broadcastUpdate as any)(userEmail as string, 'subscription_created');
      } catch (notifyError) {
        logger.error('[Stripe Subscriptions] Notification failed', { extra: { notifyError } });
      }
    }
    
    await logFromRequest(req, {
      action: 'inline_payment_confirmed',
      resourceType: 'member',
      resourceId: userId || paymentIntent.customer as string,
      resourceName: userEmail,
      details: {
        paymentIntentId,
        subscriptionId: subId,
        invoiceId,
        amount: paymentIntent.amount
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Payment confirmed and membership activated',
      memberEmail: userEmail
    });
  } catch (error: unknown) {
    logger.error('[Stripe Subscriptions] Error confirming inline payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to confirm payment' });
  }
});

router.post('/api/stripe/subscriptions/send-activation-link', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, firstName, lastName, phone, dob, tierSlug, couponId, streetAddress, city, state, zipCode } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    const sessionUser = getSessionUser(req);
    
    if (!email || !tierSlug) {
      return res.status(400).json({ error: 'email and tierSlug are required' });
    }
    
    const { resolveUserByEmail } = await import('../../core/stripe/customers');
    const resolved = await resolveUserByEmail(email);

    const existingUser = resolved
      ? await db.select({
          id: users.id, firstName: users.firstName, lastName: users.lastName,
          membershipStatus: users.membershipStatus, createdAt: users.createdAt,
          archivedAt: users.archivedAt, stripeSubscriptionId: users.stripeSubscriptionId, tier: users.tier,
        }).from(users).where(eq(users.id, resolved.userId))
      : await db.select({
          id: users.id, firstName: users.firstName, lastName: users.lastName,
          membershipStatus: users.membershipStatus, createdAt: users.createdAt,
          archivedAt: users.archivedAt, stripeSubscriptionId: users.stripeSubscriptionId, tier: users.tier,
        }).from(users).where(sql`LOWER(${users.email}) = ${email.toLowerCase()}`);

    if (resolved && resolved.matchType !== 'direct') {
      logger.info('[Activation Link] Email resolved to existing user via', { extra: { email, resolvedPrimaryEmail: resolved.primaryEmail, resolvedMatchType: resolved.matchType } });
    }
    
    let existingUserId: string | null = null;
    let isResend = false;
    
    if (existingUser.length > 0) {
      const existing = existingUser[0];
      if (existing.archivedAt && ['non-member', 'visitor', null].includes(existing.membershipStatus)) {
        existingUserId = existing.id;
        logger.info('[Activation Link] Unarchiving user for new membership creation', { extra: { email } });
      } else if (existing.membershipStatus === 'pending') {
        const name = [existing.firstName, existing.lastName].filter(Boolean).join(' ') || email;
        return res.status(400).json({ 
          error: `This email has an incomplete signup from ${new Date(existing.createdAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}. Clean it up to proceed.`,
          isPendingUser: true,
          existingUserId: existing.id,
          existingUserName: name,
          canCleanup: true
        });
      } else if (existing.membershipStatus === 'active' && existing.stripeSubscriptionId) {
        const name = [existing.firstName, existing.lastName].filter(Boolean).join(' ') || email;
        return res.status(400).json({ 
          error: `${name} is already an active member with a ${existing.tier} subscription. No activation link is needed.`,
          isAlreadyActive: true
        });
      } else {
        existingUserId = existing.id;
        isResend = true;
        logger.info('[Activation Link] Resending activation link for existing user (status: , has subscription: )', { extra: { email, existingMembership_status: existing.membershipStatus, existingStripe_subscription_id: !!existing.stripeSubscriptionId } });
      }
    }
    
    const tierResult = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, tierSlug))
      .limit(1);
    
    if (tierResult.length === 0) {
      return res.status(400).json({ error: `Tier "${tierSlug}" not found` });
    }
    
    const tier = tierResult[0];
    
    if (!tier.stripePriceId) {
      return res.status(400).json({ error: `The "${tier.name}" tier is not set up in Stripe yet. Run "Sync to Stripe" from Products & Pricing first.` });
    }
    
    const userId = existingUserId || randomUUID();
    const memberName = `${firstName || ''} ${lastName || ''}`.trim() || email;
    
    if (existingUserId) {
      await db.execute(sql`UPDATE users SET archived_at = NULL, archived_by = NULL, first_name = COALESCE(${firstName || null}, first_name), last_name = COALESCE(${lastName || null}, last_name), phone = COALESCE(${phone || null}, phone), date_of_birth = COALESCE(${dob || null}, date_of_birth), street_address = COALESCE(${streetAddress || null}, street_address), city = COALESCE(${city || null}, city), state = COALESCE(${state || null}, state), zip_code = COALESCE(${zipCode || null}, zip_code), tier = ${tier.name}, membership_status = 'pending', billing_provider = 'stripe', updated_at = NOW() WHERE id = ${existingUserId}`);
      logger.info('[Activation Link] user with tier', { extra: { isResend_Updated_existing_Unarchived_and_updated_existing: isResend ? 'Updated existing' : 'Unarchived and updated existing', email, tierName: tier.name } });
    } else {
      const exclusionCheck2 = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${email.toLowerCase()}`);
      if (exclusionCheck2.rows.length > 0) {
        logger.warn('[Stripe] Blocked activation link for permanently deleted member', { extra: { email } });
        return res.status(400).json({ error: 'This email belongs to a previously removed member and cannot be re-used for a new membership.' });
      }
      await db.insert(users).values({
        id: userId,
        email: email.toLowerCase(),
        firstName: firstName || null,
        lastName: lastName || null,
        phone: phone || null,
        dateOfBirth: dob || null,
        tier: tier.name,
        membershipStatus: 'pending',
        billingProvider: 'stripe',
        streetAddress: streetAddress || null,
        city: city || null,
        state: state || null,
        zipCode: zipCode || null,
        createdAt: new Date(),
      });
      logger.info('[Activation Link] Created pending user with tier', { extra: { email, tierName: tier.name } });
    }
    
    const { customerId } = await getOrCreateStripeCustomer(
      userId,
      email,
      memberName,
      tier.name
    );
    
    await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));
    
    const stripe = await getStripeClient();
    
    // Use environment-aware URLs
    const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
    const baseUrl = replitDomains ? `https://${replitDomains}` : 'https://everclub.app';
    
    const successUrl = `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/`;
    
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [{
        price: tier.stripePriceId,
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId,
        memberEmail: email,
        tier: tier.name,
        tierSlug: tier.slug,
        createdBy: sessionUser?.email || 'staff',
        isNewMember: 'true',
        source: 'activation_link'
      },
      subscription_data: {
        metadata: {
          userId,
          memberEmail: email,
          tier: tier.name,
          tierSlug: tier.slug,
          isNewMember: 'true'
        }
      },
      expires_at: Math.floor(Date.now() / 1000) + (23 * 60 * 60), // 23 hours (Stripe max is 24h)
    };
    
    if (couponId) {
      sessionParams.discounts = [{ coupon: couponId }];
    }
    
    const checkoutSession = await stripe.checkout.sessions.create(sessionParams);
    
    if (!checkoutSession.url) {
      logger.error('[Activation Link] Stripe returned no checkout URL for session', { extra: { checkoutSessionId: checkoutSession.id } });
      return res.status(500).json({ error: 'Failed to create checkout session - no URL returned' });
    }
    
    logger.info('[Activation Link] Created checkout session for', { extra: { checkoutSessionId: checkoutSession.id, email } });
    
    const expiresAt = new Date(checkoutSession.expires_at * 1000);
    const emailResult = await sendMembershipActivationEmail(email, {
      memberName,
      tierName: tier.name,
      monthlyPrice: tier.priceCents / 100,
      checkoutUrl: checkoutSession.url,
      expiresAt
    });
    
    if (!emailResult.success) {
      logger.error('[Activation Link] Email failed for', { extra: { email, emailResult: emailResult.error } });
    }
    
    await logFromRequest(req, {
      action: isResend ? 'activation_link_resent' : 'activation_link_sent',
      resourceType: 'member',
      resourceId: userId,
      resourceName: memberName,
      details: {
        tier: tier.name,
        checkoutSessionId: checkoutSession.id,
        emailSent: emailResult.success,
        expiresAt: expiresAt.toISOString(),
        ...(isResend ? { isResend: true } : {})
      }
    });
    
    res.json({
      success: true,
      checkoutSessionId: checkoutSession.id,
      checkoutUrl: checkoutSession.url,
      expiresAt: expiresAt.toISOString(),
      userId,
      tierName: tier.name,
      emailSent: emailResult.success
    });

    // Background sync to HubSpot (fire-and-forget)
    findOrCreateHubSpotContact(email, firstName || '', lastName || '', phone).catch((err) => {
      logger.error('[Subscriptions] Background HubSpot contact sync failed:', { extra: { error: getErrorMessage(err), email } });
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error sending activation link', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to send activation link' });
  }
});

router.delete('/api/stripe/subscriptions/cleanup-pending/:userId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const sessionUser = getSessionUser(req);
    
    const userResult = await db.select({
      id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
      membershipStatus: users.membershipStatus, stripeCustomerId: users.stripeCustomerId, idImageUrl: users.idImageUrl,
    }).from(users).where(eq(users.id, userId));
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult[0];
    
    if (user.membershipStatus !== 'pending') {
      return res.status(400).json({ 
        error: `Cannot cleanup user with status "${user.membershipStatus}". Only pending users can be cleaned up.`
      });
    }
    
    if (user.stripeCustomerId) {
      try {
        const stripe = await getStripeClient();
        
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'all',
          limit: 10
        });
        
        const activeStatuses = ['active', 'trialing', 'past_due', 'incomplete'];
        for (const sub of subscriptions.data) {
          if (activeStatuses.includes(sub.status)) {
            try {
              await stripe.subscriptions.cancel(sub.id);
              logger.info('[Stripe] Cancelled active subscription (status: ) during pending user cleanup', { extra: { subId: sub.id, subStatus: sub.status } });
            } catch (cancelErr: unknown) {
              logger.error('[Stripe] Failed to cancel subscription  during cleanup', { extra: { id: sub.id, error: getErrorMessage(cancelErr) } });
            }
          }
        }
        
        await stripe.customers.del(user.stripeCustomerId);
        logger.info('[Stripe] Deleted Stripe customer for pending user cleanup', { extra: { userStripe_customer_id: user.stripeCustomerId } });
      } catch (stripeErr: unknown) {
        logger.error('[Stripe] Failed to delete Stripe customer during cleanup:', { extra: { error: getErrorMessage(stripeErr) } });
      }
    }
    
    if (user.idImageUrl) {
      try {
        await db.update(users).set({ idImageUrl: null }).where(eq(users.id, userId));
      } catch (idErr: unknown) {
        logger.error('[Stripe] Failed to clear ID image during cleanup:', { extra: { error: getErrorMessage(idErr) } });
      }
    }
    
    await db.delete(users).where(eq(users.id, userId));
    
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
    logger.info('[Stripe] Cleaned up pending user () by', { extra: { userEmail: user.email, userName, sessionUser: sessionUser?.email } });
    
    logFromRequest(req, 'cleanup_pending_user', 'member', user.email,
      userName, { status: user.membershipStatus });
    
    res.json({ 
      success: true, 
      message: `Cleaned up pending signup for ${userName}`,
      email: user.email
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error cleaning up pending user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cleanup pending user' });
  }
});

export default router;
