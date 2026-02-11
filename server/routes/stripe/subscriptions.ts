import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool } from '../../core/db';
import { db } from '../../db';
import { membershipTiers } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
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
import { randomUUID } from 'crypto';
import { checkSyncCooldown } from './helpers';
import { sensitiveActionRateLimiter } from '../../middleware/rateLimiting';

const router = Router();

router.get('/api/stripe/subscriptions/:customerId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    
    const result = await listCustomerSubscriptions(customerId);
    
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
  } catch (error: any) {
    console.error('[Stripe] Error listing subscriptions:', error);
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

router.post('/api/stripe/subscriptions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId, priceId, memberEmail } = req.body;
    
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
        broadcastBillingUpdate(memberEmail, 'subscription_created');
      } else {
        const memberLookup = await pool.query(
          'SELECT email FROM users WHERE stripe_customer_id = $1',
          [customerId]
        );
        if (memberLookup.rows.length > 0) {
          const email = memberLookup.rows[0].email;
          sendNotificationToUser(email, {
            type: 'billing_update',
            title: 'Subscription Started',
            message: 'Your membership subscription has been activated.',
            data: { subscriptionId: result.subscription?.subscriptionId }
          });
          broadcastBillingUpdate(email, 'subscription_created');
        }
      }
    } catch (notifyError) {
      console.error('[Stripe] Failed to send subscription creation notification:', notifyError);
    }
    
    res.json({
      success: true,
      subscription: result.subscription
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating subscription:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.delete('/api/stripe/subscriptions/:subscriptionId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { subscriptionId } = req.params;
    
    const memberLookup = await pool.query(
      'SELECT email FROM users WHERE stripe_subscription_id = $1',
      [subscriptionId]
    );
    
    const result = await cancelSubscription(subscriptionId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to cancel subscription' });
    }
    
    try {
      if (memberLookup.rows.length > 0) {
        const memberEmail = memberLookup.rows[0].email;
        sendNotificationToUser(memberEmail, {
          type: 'billing_update',
          title: 'Subscription Cancelled',
          message: 'Your membership subscription has been cancelled.',
          data: { subscriptionId }
        });
        broadcastBillingUpdate(memberEmail, 'subscription_cancelled');
      }
    } catch (notifyError) {
      console.error('[Stripe] Failed to send subscription cancellation notification:', notifyError);
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error canceling subscription:', error);
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
      processed: result.processed,
      updated: result.updated,
      errors: result.errors
    });
  } catch (error: any) {
    console.error('[Stripe] Error syncing subscriptions:', error);
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
  } catch (error: any) {
    console.error('[Stripe] Error listing coupons:', error);
    res.status(500).json({ error: 'Failed to load coupons' });
  }
});

router.post('/api/stripe/subscriptions/create-for-member', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberEmail, tierName, couponId } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!memberEmail || !tierName) {
      return res.status(400).json({ error: 'memberEmail and tierName are required' });
    }
    
    const memberResult = await pool.query(
      'SELECT id, email, first_name, last_name, tier, stripe_customer_id, billing_provider, stripe_subscription_id FROM users WHERE LOWER(email) = $1',
      [memberEmail.toLowerCase()]
    );
    
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = memberResult.rows[0];
    
    if (member.stripe_subscription_id) {
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
    
    const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
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
      await pool.query(
        `UPDATE users SET 
          billing_provider = 'stripe',
          tier = $1,
          stripe_subscription_id = $2,
          membership_status = $4,
          updated_at = NOW()
        WHERE id = $3`,
        [tierName, stripeSubscription?.subscriptionId, member.id, memberStatus]
      );
    } catch (dbError) {
      // Database update failed after Stripe subscription was created
      // Roll back the Stripe subscription to prevent charging the customer without granting access
      if (stripeSubscription?.subscriptionId) {
        try {
          await cancelSubscription(stripeSubscription.subscriptionId);
          console.error(`[Stripe] Rolled back subscription ${stripeSubscription.subscriptionId} due to database update failure:`, dbError);
        } catch (cancelError) {
          console.error(`[Stripe] CRITICAL: Failed to cancel subscription ${stripeSubscription.subscriptionId} during rollback. Customer was charged but access was not granted:`, cancelError);
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
        previousBillingProvider: member.billing_provider,
        previousTier: member.tier
      }
    });
    
    // Sync to HubSpot
    try {
      const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
      await syncMemberToHubSpot({ email: member.email, status: memberStatus, tier: tierName, billingProvider: 'stripe', memberSince: new Date() });
      console.log(`[Stripe] Synced ${member.email} to HubSpot: status=${memberStatus}, tier=${tierName}, billing=stripe, memberSince=now`);
    } catch (hubspotError) {
      console.error('[Stripe] HubSpot sync failed for subscription creation:', hubspotError);
    }
    
    console.log(`[Stripe] Created subscription for ${member.email}: ${subscriptionResult.subscription?.subscriptionId}`);
    
    try {
      sendNotificationToUser(member.email, {
        type: 'billing_update',
        title: 'Membership Activated',
        message: `Your ${tierName} membership has been activated.`,
        data: { subscriptionId: subscriptionResult.subscription?.subscriptionId, tier: tierName }
      });
      broadcastBillingUpdate(member.email, 'subscription_created');
    } catch (notifyError) {
      console.error('[Stripe] Failed to send membership activation notification:', notifyError);
    }
    
    res.json({
      success: true,
      subscription: subscriptionResult.subscription,
      customerId,
      message: `Successfully created ${tierName} subscription for ${memberName}`
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating subscription for member:', error);
    res.status(500).json({ error: error.message || 'Failed to create subscription' });
  }
});

router.post('/api/stripe/subscriptions/create-new-member', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email, firstName, lastName, phone, dob, tierSlug, couponId, streetAddress, city, state, zipCode } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!email || !tierSlug) {
      return res.status(400).json({ error: 'email and tierSlug are required' });
    }
    
    const { resolveUserByEmail } = await import('../../core/stripe/customers');
    const resolved = await resolveUserByEmail(email);

    const existingUser = resolved
      ? await pool.query(
          `SELECT id, first_name, last_name, membership_status, created_at, archived_at 
           FROM users WHERE id = $1`,
          [resolved.userId]
        )
      : await pool.query(
          `SELECT id, first_name, last_name, membership_status, created_at, archived_at 
           FROM users WHERE LOWER(email) = $1`,
          [email.toLowerCase()]
        );

    if (resolved && resolved.matchType !== 'direct') {
      console.log(`[Stripe] Email ${email} resolved to existing user ${resolved.primaryEmail} via ${resolved.matchType}`);
    }
    
    let existingUserId: string | null = null;
    
    if (existingUser.rows.length > 0) {
      const existing = existingUser.rows[0];
      if (existing.archived_at && ['non-member', 'visitor', null].includes(existing.membership_status)) {
        existingUserId = existing.id;
        console.log(`[Stripe] Unarchiving user ${email} for new membership creation`);
      } else {
        const isPending = existing.membership_status === 'pending';
        const name = [existing.first_name, existing.last_name].filter(Boolean).join(' ') || email;
        return res.status(400).json({ 
          error: isPending 
            ? `This email has an incomplete signup from ${new Date(existing.created_at).toLocaleDateString()}. Clean it up to proceed.`
            : 'A member with this email already exists',
          isPendingUser: isPending,
          existingUserId: isPending ? existing.id : undefined,
          existingUserName: name,
          canCleanup: isPending
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
      await pool.query(
        `UPDATE users SET archived_at = NULL, archived_by = NULL, first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name), phone = COALESCE($4, phone), date_of_birth = COALESCE($5, date_of_birth), street_address = COALESCE($6, street_address), city = COALESCE($7, city), state = COALESCE($8, state), zip_code = COALESCE($9, zip_code), tier = $10, membership_status = 'pending', billing_provider = 'stripe', updated_at = NOW() WHERE id = $1`,
        [existingUserId, firstName || null, lastName || null, phone || null, dob || null, streetAddress || null, city || null, state || null, zipCode || null, tier.name]
      );
      console.log(`[Stripe] Unarchived and updated existing user ${email} with tier ${tier.name}`);
    } else {
      await pool.query(
        `INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, street_address, city, state, zip_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'stripe', $8, $9, $10, $11, NOW())`,
        [userId, email.toLowerCase(), firstName || null, lastName || null, phone || null, dob || null, tier.name, streetAddress || null, city || null, state || null, zipCode || null]
      );
      console.log(`[Stripe] Created pending user ${email} with tier ${tier.name}`);
    }
    
    const { customerId } = await getOrCreateStripeCustomer(
      userId,
      email,
      memberName,
      tier.name
    );
    
    await pool.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
      [customerId, userId]
    );
    
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
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      } else {
        await pool.query(
          `UPDATE users SET membership_status = 'non-member', tier = NULL, billing_provider = NULL, archived_at = NOW(), archived_by = 'system_rollback', updated_at = NOW() WHERE id = $1`,
          [userId]
        );
      }
      return res.status(500).json({ error: subscriptionResult.error || 'Failed to create subscription' });
    }
    
    try {
      await pool.query(
        'UPDATE users SET stripe_subscription_id = $1 WHERE id = $2',
        [subscriptionResult.subscription?.subscriptionId, userId]
      );
    } catch (dbError: any) {
      console.error('[Stripe] DB update failed after subscription creation. Rolling back...', dbError.message);
      if (subscriptionResult.subscription?.subscriptionId) {
        try {
          await cancelSubscription(subscriptionResult.subscription.subscriptionId);
          console.log(`[Stripe] Emergency rollback: cancelled subscription ${subscriptionResult.subscription.subscriptionId}`);
          if (!existingUserId) {
            await pool.query('DELETE FROM users WHERE id = $1', [userId]);
          } else {
            await pool.query(
              `UPDATE users SET membership_status = 'non-member', tier = NULL, billing_provider = NULL, archived_at = NOW(), archived_by = 'system_rollback', updated_at = NOW() WHERE id = $1`,
              [userId]
            );
          }
          return res.status(500).json({ 
            error: 'System error during activation. Payment has been voided. Please try again.' 
          });
        } catch (cancelError: any) {
          console.error(`[Stripe] CRITICAL: Failed to cancel subscription ${subscriptionResult.subscription.subscriptionId} during rollback. User preserved for manual cleanup.`, cancelError.message);
          return res.status(500).json({ 
            error: 'CRITICAL: Account setup failed but the payment could not be automatically reversed. Please contact support immediately so we can issue a refund.' 
          });
        }
      }
      if (!existingUserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      } else {
        await pool.query(
          `UPDATE users SET membership_status = 'non-member', tier = NULL, billing_provider = NULL, archived_at = NOW(), archived_by = 'system_rollback', updated_at = NOW() WHERE id = $1`,
          [userId]
        );
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
    
    console.log(`[Stripe] Created subscription ${subscriptionResult.subscription?.subscriptionId} for new member ${email}`);
    
    // If no clientSecret, the subscription may be fully paid (e.g., 100% discount) or there's an issue
    if (!subscriptionResult.subscription?.clientSecret) {
      console.warn(`[Stripe] No clientSecret returned for subscription ${subscriptionResult.subscription?.subscriptionId}`);
    }
    
    res.json({
      success: true,
      clientSecret: subscriptionResult.subscription?.clientSecret || null,
      subscriptionId: subscriptionResult.subscription?.subscriptionId,
      customerId,
      userId,
      tierName: tier.name
    });
  } catch (error: any) {
    console.error('[Stripe] Error creating new member subscription:', error);
    res.status(500).json({ error: error.message || 'Failed to create subscription' });
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
          
          await stripe.invoices.pay(invoiceId, {
            paid_out_of_band: true
          });
          console.log(`[Stripe Subscriptions] Marked invoice ${invoiceId} as paid out of band`);
        }
      } catch (invoiceError: any) {
        console.error('[Stripe Subscriptions] Error paying invoice:', invoiceError.message);
      }
    }
    
    let userEmail = '';
    let tierName = '';
    
    if (userId) {
      const userResult = await pool.query(
        `SELECT email, tier FROM users WHERE id = $1`,
        [userId]
      );
      
      if (userResult.rows.length > 0) {
        userEmail = userResult.rows[0].email;
        tierName = userResult.rows[0].tier;
        
        await pool.query(
          `UPDATE users SET membership_status = 'active', updated_at = NOW() WHERE id = $1`,
          [userId]
        );
        console.log(`[Stripe Subscriptions] Activated member ${userEmail}`);
      }
    } else if (paymentIntent.customer) {
      const custResult = await pool.query(
        `SELECT id, email, tier FROM users WHERE stripe_customer_id = $1`,
        [paymentIntent.customer]
      );
      
      if (custResult.rows.length > 0) {
        userEmail = custResult.rows[0].email;
        tierName = custResult.rows[0].tier;
        
        await pool.query(
          `UPDATE users SET membership_status = 'active', updated_at = NOW() WHERE stripe_customer_id = $1`,
          [paymentIntent.customer]
        );
        console.log(`[Stripe Subscriptions] Activated member ${userEmail} via customer ID`);
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
          memberSince: new Date() 
        });
        console.log(`[Stripe Subscriptions] Synced ${userEmail} to HubSpot`);
      } catch (hubspotError) {
        console.error('[Stripe Subscriptions] HubSpot sync failed:', hubspotError);
      }
      
      try {
        const { sendNotificationToUser, broadcastBillingUpdate } = await import('../../core/notifications/realtime');
        sendNotificationToUser(userEmail, {
          type: 'billing_update',
          title: 'Membership Activated',
          message: `Your ${tierName} membership has been activated.`,
          data: { subscriptionId: subId, tier: tierName }
        });
        broadcastBillingUpdate(userEmail, 'subscription_created');
      } catch (notifyError) {
        console.error('[Stripe Subscriptions] Notification failed:', notifyError);
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
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error confirming inline payment:', error);
    res.status(500).json({ error: error.message || 'Failed to confirm payment' });
  }
});

router.post('/api/stripe/subscriptions/send-activation-link', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email, firstName, lastName, phone, dob, tierSlug, couponId, streetAddress, city, state, zipCode } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!email || !tierSlug) {
      return res.status(400).json({ error: 'email and tierSlug are required' });
    }
    
    const { resolveUserByEmail } = await import('../../core/stripe/customers');
    const resolved = await resolveUserByEmail(email);

    const existingUser = resolved
      ? await pool.query(
          `SELECT id, first_name, last_name, membership_status, created_at, archived_at, stripe_subscription_id, tier 
           FROM users WHERE id = $1`,
          [resolved.userId]
        )
      : await pool.query(
          `SELECT id, first_name, last_name, membership_status, created_at, archived_at, stripe_subscription_id, tier 
           FROM users WHERE LOWER(email) = $1`,
          [email.toLowerCase()]
        );

    if (resolved && resolved.matchType !== 'direct') {
      console.log(`[Activation Link] Email ${email} resolved to existing user ${resolved.primaryEmail} via ${resolved.matchType}`);
    }
    
    let existingUserId: string | null = null;
    let isResend = false;
    
    if (existingUser.rows.length > 0) {
      const existing = existingUser.rows[0];
      if (existing.archived_at && ['non-member', 'visitor', null].includes(existing.membership_status)) {
        existingUserId = existing.id;
        console.log(`[Activation Link] Unarchiving user ${email} for new membership creation`);
      } else if (existing.membership_status === 'pending') {
        const name = [existing.first_name, existing.last_name].filter(Boolean).join(' ') || email;
        return res.status(400).json({ 
          error: `This email has an incomplete signup from ${new Date(existing.created_at).toLocaleDateString()}. Clean it up to proceed.`,
          isPendingUser: true,
          existingUserId: existing.id,
          existingUserName: name,
          canCleanup: true
        });
      } else if (existing.membership_status === 'active' && existing.stripe_subscription_id) {
        const name = [existing.first_name, existing.last_name].filter(Boolean).join(' ') || email;
        return res.status(400).json({ 
          error: `${name} is already an active member with a ${existing.tier} subscription. No activation link is needed.`,
          isAlreadyActive: true
        });
      } else {
        existingUserId = existing.id;
        isResend = true;
        console.log(`[Activation Link] Resending activation link for existing user ${email} (status: ${existing.membership_status}, has subscription: ${!!existing.stripe_subscription_id})`);
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
      await pool.query(
        `UPDATE users SET archived_at = NULL, archived_by = NULL, first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name), phone = COALESCE($4, phone), date_of_birth = COALESCE($5, date_of_birth), street_address = COALESCE($6, street_address), city = COALESCE($7, city), state = COALESCE($8, state), zip_code = COALESCE($9, zip_code), tier = $10, membership_status = 'pending', billing_provider = 'stripe', updated_at = NOW() WHERE id = $1`,
        [existingUserId, firstName || null, lastName || null, phone || null, dob || null, streetAddress || null, city || null, state || null, zipCode || null, tier.name]
      );
      console.log(`[Activation Link] ${isResend ? 'Updated existing' : 'Unarchived and updated existing'} user ${email} with tier ${tier.name}`);
    } else {
      await pool.query(
        `INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, street_address, city, state, zip_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'stripe', $8, $9, $10, $11, NOW())`,
        [userId, email.toLowerCase(), firstName || null, lastName || null, phone || null, dob || null, tier.name, streetAddress || null, city || null, state || null, zipCode || null]
      );
      console.log(`[Activation Link] Created pending user ${email} with tier ${tier.name}`);
    }
    
    const { customerId } = await getOrCreateStripeCustomer(
      userId,
      email,
      memberName,
      tier.name
    );
    
    await pool.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
      [customerId, userId]
    );
    
    const stripe = await getStripeClient();
    
    // Use environment-aware URLs
    const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
    const baseUrl = replitDomains ? `https://${replitDomains}` : 'https://everclub.app';
    
    const successUrl = `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/`;
    
    const sessionParams: any = {
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
      console.error(`[Activation Link] Stripe returned no checkout URL for session ${checkoutSession.id}`);
      return res.status(500).json({ error: 'Failed to create checkout session - no URL returned' });
    }
    
    console.log(`[Activation Link] Created checkout session ${checkoutSession.id} for ${email}`);
    
    const expiresAt = new Date(checkoutSession.expires_at * 1000);
    const emailResult = await sendMembershipActivationEmail(email, {
      memberName,
      tierName: tier.name,
      monthlyPrice: tier.priceCents / 100,
      checkoutUrl: checkoutSession.url,
      expiresAt
    });
    
    if (!emailResult.success) {
      console.error(`[Activation Link] Email failed for ${email}:`, emailResult.error);
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
  } catch (error: any) {
    console.error('[Stripe] Error sending activation link:', error);
    res.status(500).json({ error: error.message || 'Failed to send activation link' });
  }
});

router.delete('/api/stripe/subscriptions/cleanup-pending/:userId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const sessionUser = getSessionUser(req);
    
    const userResult = await pool.query(
      `SELECT id, email, first_name, last_name, membership_status, stripe_customer_id, id_image_url 
       FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    if (user.membership_status !== 'pending') {
      return res.status(400).json({ 
        error: `Cannot cleanup user with status "${user.membership_status}". Only pending users can be cleaned up.`
      });
    }
    
    if (user.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: 'all',
          limit: 10
        });
        
        const activeStatuses = ['active', 'trialing', 'past_due', 'incomplete'];
        for (const sub of subscriptions.data) {
          if (activeStatuses.includes(sub.status)) {
            try {
              await stripe.subscriptions.cancel(sub.id);
              console.log(`[Stripe] Cancelled active subscription ${sub.id} (status: ${sub.status}) during pending user cleanup`);
            } catch (cancelErr: any) {
              console.error(`[Stripe] Failed to cancel subscription ${sub.id} during cleanup:`, cancelErr.message);
            }
          }
        }
        
        await stripe.customers.del(user.stripe_customer_id);
        console.log(`[Stripe] Deleted Stripe customer ${user.stripe_customer_id} for pending user cleanup`);
      } catch (stripeErr: any) {
        console.error(`[Stripe] Failed to delete Stripe customer during cleanup:`, stripeErr.message);
      }
    }
    
    if (user.id_image_url) {
      try {
        await pool.query('UPDATE users SET id_image_url = NULL WHERE id = $1', [userId]);
      } catch (idErr: any) {
        console.error(`[Stripe] Failed to clear ID image during cleanup:`, idErr.message);
      }
    }
    
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    
    const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
    console.log(`[Stripe] Cleaned up pending user ${user.email} (${userName}) by ${sessionUser?.email}`);
    
    logFromRequest(req, 'cleanup_pending_user', 'member', user.email,
      userName, { status: user.membership_status });
    
    res.json({ 
      success: true, 
      message: `Cleaned up pending signup for ${userName}`,
      email: user.email
    });
  } catch (error: any) {
    console.error('[Stripe] Error cleaning up pending user:', error);
    res.status(500).json({ error: 'Failed to cleanup pending user' });
  }
});

export default router;
