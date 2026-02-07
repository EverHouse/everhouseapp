import { Router } from 'express';
import Stripe from 'stripe';
import { isStaffOrAdmin } from '../core/middleware';
import { pool } from '../core/db';
import { getStripeClient } from '../core/stripe/client';
import { isPlaceholderEmail } from '../core/stripe/customers';
import { getBillingGroupByMemberEmail } from '../core/stripe/groupBilling';
import { listCustomerInvoices, getCustomerPaymentHistory } from '../core/stripe/invoices';
import { listCustomerSubscriptions } from '../core/stripe/subscriptions';
import { logFromRequest } from '../core/auditLog';

const router = Router();

type SubscriptionSelectionMode = 'pauseable' | 'resumable' | 'cancellable' | 'discountable';

async function findEligibleSubscription(
  stripe: Stripe,
  customerId: string,
  mode: SubscriptionSelectionMode
): Promise<{ subscription: Stripe.Subscription | null; error: string | null }> {
  const errorMessages: Record<SubscriptionSelectionMode, string> = {
    pauseable: 'No active subscription found to pause',
    resumable: 'No paused subscription found to resume',
    cancellable: 'No subscription found to cancel',
    discountable: 'No eligible subscription found to apply discount',
  };

  if (mode === 'resumable') {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
    });

    // A subscription is resumable if it has pause_collection set with a behavior
    // (Stripe keeps pause_collection as an object with behavior when paused)
    const subscription = subscriptions.data.find(s =>
      s.pause_collection &&
      typeof s.pause_collection === 'object' &&
      s.pause_collection.behavior &&
      (s.status === 'active' || s.status === 'trialing')
    );

    return subscription
      ? { subscription, error: null }
      : { subscription: null, error: errorMessages[mode] };
  }

  const activeSubscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'active',
  });

  const trialingSubscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'trialing',
  });

  // Include past_due subscriptions - members still have access during grace period
  const pastDueSubscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'past_due',
  });

  const allActiveOrTrialing = [...activeSubscriptions.data, ...trialingSubscriptions.data, ...pastDueSubscriptions.data];

  let subscription: Stripe.Subscription | undefined;

  switch (mode) {
    case 'pauseable':
      subscription = allActiveOrTrialing.find(s => !s.pause_collection);
      break;
    case 'cancellable':
    case 'discountable':
      subscription = allActiveOrTrialing.find(s => !s.cancel_at_period_end);
      break;
  }

  return subscription
    ? { subscription, error: null }
    : { subscription: null, error: errorMessages[mode] };
}

async function getMemberByEmail(email: string) {
  const result = await pool.query(
    `SELECT id, email, first_name, last_name, billing_provider, stripe_customer_id, mindbody_client_id, tier, billing_migration_requested_at
     FROM users WHERE LOWER(email) = $1`,
    [email.toLowerCase()]
  );
  return result.rows[0] || null;
}

router.get('/api/member-billing/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const billingInfo: any = {
      email: member.email,
      firstName: member.first_name,
      lastName: member.last_name,
      billingProvider: member.billing_provider,
      stripeCustomerId: member.stripe_customer_id,
      tier: member.tier,
      billingMigrationRequestedAt: member.billing_migration_requested_at,
    };

    if (member.billing_provider === 'stripe' && member.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();

        const subscriptionsResult = await listCustomerSubscriptions(member.stripe_customer_id);
        if (subscriptionsResult.success) {
          billingInfo.subscriptions = subscriptionsResult.subscriptions;
          const activeSub = subscriptionsResult.subscriptions?.find(
            s => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due' || s.status === 'incomplete'
          );
          billingInfo.activeSubscription = activeSub || null;
        }

        const paymentMethods = await stripe.paymentMethods.list({
          customer: member.stripe_customer_id,
          type: 'card',
        });
        billingInfo.paymentMethods = paymentMethods.data.map(pm => ({
          id: pm.id,
          brand: pm.card?.brand,
          last4: pm.card?.last4,
          expMonth: pm.card?.exp_month,
          expYear: pm.card?.exp_year,
        }));

        const invoicesResult = await listCustomerInvoices(member.stripe_customer_id);
        if (invoicesResult.success) {
          billingInfo.recentInvoices = invoicesResult.invoices?.slice(0, 5) || [];
        }

        const customer = await stripe.customers.retrieve(member.stripe_customer_id);
        if (customer && !customer.deleted) {
          const balanceCents = (customer as any).balance || 0;
          billingInfo.customerBalance = balanceCents;
          billingInfo.customerBalanceDollars = balanceCents / 100;
        }
      } catch (stripeError: any) {
        console.error('[MemberBilling] Stripe API error:', stripeError.message);
        billingInfo.stripeError = stripeError.message;
      }
    } else if (member.billing_provider === 'mindbody') {
      billingInfo.mindbodyClientId = member.mindbody_client_id;
      
      // Also fetch Stripe data for MindBody members who have a Stripe customer ID
      // This allows staff to view/charge one-off purchases through Stripe
      if (member.stripe_customer_id) {
        try {
          const stripe = await getStripeClient();
          
          // Get recent invoices (for one-off charges like overage fees)
          const invoicesResult = await listCustomerInvoices(member.stripe_customer_id);
          if (invoicesResult.success && invoicesResult.invoices && invoicesResult.invoices.length > 0) {
            billingInfo.recentInvoices = invoicesResult.invoices.slice(0, 10);
          }
          
          // Get customer balance (credits)
          const customer = await stripe.customers.retrieve(member.stripe_customer_id);
          if (customer && !customer.deleted) {
            const balanceCents = (customer as any).balance || 0;
            billingInfo.customerBalance = balanceCents;
            billingInfo.customerBalanceDollars = balanceCents / 100;
          }
          
          // Get payment methods on file
          const paymentMethods = await stripe.paymentMethods.list({
            customer: member.stripe_customer_id,
            type: 'card',
          });
          if (paymentMethods.data.length > 0) {
            billingInfo.paymentMethods = paymentMethods.data.map(pm => ({
              id: pm.id,
              brand: pm.card?.brand,
              last4: pm.card?.last4,
              expMonth: pm.card?.exp_month,
              expYear: pm.card?.exp_year,
            }));
          }
        } catch (stripeError: any) {
          // Don't fail the whole request if Stripe lookup fails
          console.error('[MemberBilling] Stripe lookup for MindBody member failed:', stripeError.message);
        }
      }
    } else if (member.billing_provider === 'family_addon') {
      try {
        const familyGroup = await getBillingGroupByMemberEmail(email);
        billingInfo.familyGroup = familyGroup;
      } catch (familyError: any) {
        console.error('[MemberBilling] Family group error:', familyError.message);
        billingInfo.familyError = familyError.message;
      }
    }

    res.json(billingInfo);
  } catch (error: any) {
    console.error('[MemberBilling] Error getting billing info:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/member-billing/:email/source', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { billingProvider } = req.body;

    const validProviders = ['stripe', 'mindbody', 'family_addon', 'comped', null];
    if (!validProviders.includes(billingProvider)) {
      return res.status(400).json({ error: 'Invalid billing provider' });
    }

    const member = await getMemberByEmail(email);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    await pool.query(
      'UPDATE users SET billing_provider = $1, updated_at = NOW() WHERE LOWER(email) = $2',
      [billingProvider, email.toLowerCase()]
    );

    console.log(`[MemberBilling] Updated billing provider for ${email} to ${billingProvider}`);
    
    // Sync billing provider AND current membership status to HubSpot
    // This ensures HubSpot reflects the app's status, not external system's status
    try {
      const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
      // Include current membership status so HubSpot uses app as source of truth
      await syncMemberToHubSpot({ 
        email, 
        billingProvider: billingProvider || 'manual',
        status: member.membership_status || 'active'
      });
      console.log(`[MemberBilling] Synced billing provider ${billingProvider} and status ${member.membership_status} to HubSpot for ${email}`);
    } catch (hubspotError) {
      console.error('[MemberBilling] HubSpot sync failed for billing provider change:', hubspotError);
    }
    
    res.json({ success: true, billingProvider });
  } catch (error: any) {
    console.error('[MemberBilling] Error updating billing source:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/member-billing/:email/pause', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { durationDays } = req.body;

    if (!durationDays || (durationDays !== 30 && durationDays !== 60)) {
      return res.status(400).json({ error: 'Duration must be 30 or 60 days' });
    }

    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (member.billing_provider !== 'stripe') {
      return res.status(400).json({ error: 'Pause is only available for Stripe billing' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const stripe = await getStripeClient();
    const { subscription, error } = await findEligibleSubscription(stripe, member.stripe_customer_id, 'pauseable');

    if (!subscription) {
      return res.status(400).json({ error });
    }

    const resumeDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    const resumeTimestamp = Math.floor(resumeDate.getTime() / 1000);

    await stripe.subscriptions.update(subscription.id, {
      pause_collection: {
        behavior: 'void',
        resumes_at: resumeTimestamp,
      },
    });

    console.log(`[MemberBilling] Paused subscription ${subscription.id} for ${email} until ${resumeDate.toISOString()} (${durationDays} days)`);
    
    logFromRequest(req, 'pause_subscription', 'subscription', subscription.id, email, {
      pause_until: resumeDate.toISOString()
    });
    
    res.json({ 
      success: true, 
      subscriptionId: subscription.id, 
      status: 'paused',
      resumeDate: resumeDate.toISOString(),
      durationDays,
    });
  } catch (error: any) {
    console.error('[MemberBilling] Error pausing subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/member-billing/:email/resume', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (member.billing_provider !== 'stripe') {
      return res.status(400).json({ error: 'Resume is only available for Stripe billing' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const stripe = await getStripeClient();
    const { subscription, error } = await findEligibleSubscription(stripe, member.stripe_customer_id, 'resumable');

    if (!subscription) {
      return res.status(400).json({ error });
    }

    await stripe.subscriptions.update(subscription.id, {
      pause_collection: null as any,
    });

    console.log(`[MemberBilling] Resumed subscription ${subscription.id} for ${email}`);
    
    logFromRequest(req, 'resume_subscription', 'subscription', subscription.id, email, {});
    
    res.json({ success: true, subscriptionId: subscription.id, status: 'active' });
  } catch (error: any) {
    console.error('[MemberBilling] Error resuming subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/member-billing/:email/cancel', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { reason, immediate } = req.body;
    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (member.billing_provider !== 'stripe') {
      return res.status(400).json({ error: 'Cancel is only available for Stripe billing' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const stripe = await getStripeClient();
    const { subscription, error } = await findEligibleSubscription(stripe, member.stripe_customer_id, 'cancellable');

    if (!subscription) {
      return res.status(400).json({ error });
    }

    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    
    const effectiveDate = immediate ? currentPeriodEnd : 
      (thirtyDaysFromNow > currentPeriodEnd ? thirtyDaysFromNow : currentPeriodEnd);
    const cancelAtTimestamp = Math.floor(effectiveDate.getTime() / 1000);

    const updated = await stripe.subscriptions.update(subscription.id, {
      cancel_at: cancelAtTimestamp,
    });

    await pool.query(
      `UPDATE users SET 
        cancellation_requested_at = NOW(),
        cancellation_effective_date = $1,
        cancellation_reason = $2,
        updated_at = NOW()
       WHERE LOWER(email) = $3`,
      [effectiveDate.toISOString().split('T')[0], reason || null, email.toLowerCase()]
    );

    console.log(`[MemberBilling] Set cancel_at for subscription ${subscription.id}, email ${email}, effective ${effectiveDate.toISOString()}`);
    
    logFromRequest(req, 'cancel_subscription', 'subscription', subscription.id, email, {
      reason: reason || 'Not specified',
      effective_date: effectiveDate.toISOString(),
      immediate: !!immediate
    });
    
    res.json({
      success: true,
      subscriptionId: subscription.id,
      cancelAt: Math.floor(effectiveDate.getTime() / 1000),
      cancellationRequestedAt: now.toISOString(),
      cancellationEffectiveDate: effectiveDate.toISOString(),
      noticePeriodDays: 30,
    });
  } catch (error: any) {
    console.error('[MemberBilling] Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to process cancellation request' });
  }
});

router.post('/api/member-billing/:email/undo-cancellation', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (member.billing_provider !== 'stripe') {
      return res.status(400).json({ error: 'Undo cancellation is only available for Stripe billing' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const stripe = await getStripeClient();
    const subscriptions = await stripe.subscriptions.list({
      customer: member.stripe_customer_id,
      limit: 10,
    });

    const pendingCancelSub = subscriptions.data.find(s => 
      (s.status === 'active' || s.status === 'trialing') && (s.cancel_at || s.cancel_at_period_end)
    );

    if (!pendingCancelSub) {
      return res.status(400).json({ error: 'No pending cancellation found' });
    }

    await stripe.subscriptions.update(pendingCancelSub.id, {
      cancel_at: null,
      cancel_at_period_end: false,
    });

    await pool.query(
      `UPDATE users SET 
        cancellation_requested_at = NULL,
        cancellation_effective_date = NULL,
        cancellation_reason = NULL,
        updated_at = NOW()
       WHERE LOWER(email) = $1`,
      [email.toLowerCase()]
    );

    console.log(`[MemberBilling] Undid cancellation for subscription ${pendingCancelSub.id}, email ${email}`);
    
    logFromRequest(req, 'undo_cancel_subscription', 'subscription', pendingCancelSub.id, email, {});
    
    res.json({
      success: true,
      subscriptionId: pendingCancelSub.id,
      message: 'Cancellation has been reversed'
    });
  } catch (error: any) {
    console.error('[MemberBilling] Error undoing cancellation:', error);
    res.status(500).json({ error: 'Failed to undo cancellation' });
  }
});

router.post('/api/member-billing/:email/credit', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { amountCents, description } = req.body;

    if (typeof amountCents !== 'number' || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'Description is required' });
    }

    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    // Prevent operations on placeholder emails
    if (isPlaceholderEmail(email)) {
      return res.status(400).json({ error: 'Cannot add credits to placeholder accounts' });
    }

    // Allow credits for any member who has (or can have) a Stripe customer ID
    // This includes MindBody members who use Stripe for one-off charges and credits
    const stripe = await getStripeClient();
    
    let stripeCustomerId = member.stripe_customer_id;
    
    if (!stripeCustomerId) {
      const { getOrCreateStripeCustomer } = await import('../core/stripe/customers');
      const memberName = member.first_name && member.last_name 
        ? `${member.first_name} ${member.last_name}` 
        : email;
      const custResult = await getOrCreateStripeCustomer(member.id, email, memberName, member.tier);
      stripeCustomerId = custResult.customerId;
      console.log(`[MemberBilling] ${custResult.isNew ? 'Created' : 'Found existing'} Stripe customer ${stripeCustomerId} for ${email}`);
    }

    const transaction = await stripe.customers.createBalanceTransaction(
      stripeCustomerId,
      {
        amount: -amountCents,
        currency: 'usd',
        description,
      }
    );

    console.log(`[MemberBilling] Applied credit of ${amountCents} cents to ${email}`);
    
    // Audit log the credit application
    await logFromRequest(req, 'apply_credit', 'member', email, email, {
      amountCents,
      amountDollars: (amountCents / 100).toFixed(2),
      description,
      transactionId: transaction.id,
      endingBalance: transaction.ending_balance,
    });
    
    res.json({
      success: true,
      transactionId: transaction.id,
      amount: transaction.amount,
      endingBalance: transaction.ending_balance,
    });
  } catch (error: any) {
    console.error('[MemberBilling] Error applying credit:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/member-billing/:email/discount', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { couponId, percentOff, duration = 'once' } = req.body;

    if (!couponId && !percentOff) {
      return res.status(400).json({ error: 'Either couponId or percentOff is required' });
    }

    if (!couponId && percentOff) {
      if (typeof percentOff !== 'number' || percentOff < 1 || percentOff > 100) {
        return res.status(400).json({ error: 'Discount percentage must be between 1 and 100' });
      }
    }

    const validDurations = ['once', 'forever'];
    if (!validDurations.includes(duration)) {
      return res.status(400).json({ error: 'Invalid duration. Must be "once" or "forever"' });
    }

    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (member.billing_provider !== 'stripe') {
      return res.status(400).json({ error: 'Discounts are only available for Stripe billing' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const stripe = await getStripeClient();
    const { subscription, error: subError } = await findEligibleSubscription(stripe, member.stripe_customer_id, 'discountable');

    if (!subscription) {
      return res.status(400).json({ error: subError });
    }

    let appliedCouponId = couponId;

    if (!couponId && percentOff) {
      const coupon = await stripe.coupons.create({
        percent_off: percentOff,
        duration: duration as 'once' | 'forever',
        name: `Staff discount for ${email}`,
      });
      appliedCouponId = coupon.id;
    }

    await stripe.subscriptions.update(subscription.id, {
      coupon: appliedCouponId,
    });

    console.log(`[MemberBilling] Applied discount ${appliedCouponId} to subscription ${subscription.id} for ${email}`);
    res.json({
      success: true,
      subscriptionId: subscription.id,
      couponId: appliedCouponId,
    });
  } catch (error: any) {
    console.error('[MemberBilling] Error applying discount:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/member-billing/:email/invoices', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const result = await listCustomerInvoices(member.stripe_customer_id);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({ invoices: result.invoices });
  } catch (error: any) {
    console.error('[MemberBilling] Error getting invoices:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/member-billing/:email/payment-history', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { limit = '50' } = req.query;
    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const result = await getCustomerPaymentHistory(
      member.stripe_customer_id, 
      Math.min(parseInt(limit as string) || 50, 200)
    );

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({ transactions: result.transactions });
  } catch (error: any) {
    console.error('[MemberBilling] Error getting payment history:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/member-billing/:email/payment-link', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const member = await getMemberByEmail(email);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer ID found' });
    }

    const stripe = await getStripeClient();

    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}`
        : 'https://everclub.com';

    const session = await stripe.billingPortal.sessions.create({
      customer: member.stripe_customer_id,
      return_url: returnUrl,
      flow_data: {
        type: 'payment_method_update',
      },
    });

    console.log(`[MemberBilling] Created billing portal session for ${email}`);
    
    logFromRequest(req, 'send_payment_link', 'member', member.id?.toString() || null, email, {});
    
    res.json({
      success: true,
      url: session.url,
    });
  } catch (error: any) {
    console.error('[MemberBilling] Error creating payment link:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
