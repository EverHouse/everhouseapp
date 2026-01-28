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
  getOrCreateStripeCustomer
} from '../../core/stripe';
import { getSessionUser } from '../../types/session';
import { logFromRequest } from '../../core/auditLog';

const router = Router();

router.get('/api/stripe/subscriptions/:customerId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    
    const result = await listCustomerSubscriptions(customerId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to list subscriptions' });
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
    
    const result = await cancelSubscription(subscriptionId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to cancel subscription' });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Stripe] Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

router.post('/api/stripe/sync-subscriptions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
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
      return res.status(400).json({ error: `Tier "${tierName}" does not have a Stripe price configured` });
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
        createdBy: sessionUser?.email || 'staff',
        ...(couponId ? { couponApplied: couponId } : {})
      }
    });
    
    if (!subscriptionResult.success) {
      return res.status(500).json({ error: subscriptionResult.error || 'Failed to create subscription' });
    }
    
    await pool.query(
      `UPDATE users SET 
        billing_provider = 'stripe',
        tier = $1,
        stripe_subscription_id = $2,
        membership_status = 'active',
        updated_at = NOW()
      WHERE id = $3`,
      [tierName, subscriptionResult.subscription?.subscriptionId, member.id]
    );
    
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
      await syncMemberToHubSpot({ email: member.email, status: 'active', tier: tierName, billingProvider: 'stripe', memberSince: new Date() });
      console.log(`[Stripe] Synced ${member.email} to HubSpot: status=active, tier=${tierName}, billing=stripe, memberSince=now`);
    } catch (hubspotError) {
      console.error('[Stripe] HubSpot sync failed for subscription creation:', hubspotError);
    }
    
    console.log(`[Stripe] Created subscription for ${member.email}: ${subscriptionResult.subscription?.subscriptionId}`);
    
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

export default router;
