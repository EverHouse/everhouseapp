import { logger } from '../core/logger';
import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from '../core/stripe/client';
import { isPlaceholderEmail, getOrCreateStripeCustomer } from '../core/stripe/customers';
import { listCustomerSubscriptions } from '../core/stripe/subscriptions';
import { getBillingGroupByMemberEmail } from '../core/stripe/groupBilling';
import { listCustomerInvoices } from '../core/stripe/invoices';
import { notifyAllStaff } from '../core/notificationService';
import { getErrorMessage } from '../utils/errorUtils';
import { formatDatePacific } from '../utils/dateUtils';

const router = Router();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.user?.email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireStaffAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.user?.email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.user.role !== 'admin' && req.session.user.role !== 'staff') {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
}

router.get('/api/my/billing', requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    const isStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    const targetEmail = (req.query.email && isStaff) ? String(req.query.email).trim().toLowerCase() : sessionUser.email;
    const email = targetEmail;
    
    const result = await db.execute(sql`SELECT id, email, first_name, last_name, billing_provider, stripe_customer_id, hubspot_id, mindbody_client_id, tier, billing_migration_requested_at,
              cancellation_requested_at, cancellation_effective_date, cancellation_reason, contract_start_date
       FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const billingInfo: Record<string, unknown> = {
      billingProvider: member.billing_provider,
      stripeCustomerId: member.stripe_customer_id,
      hubspotId: member.hubspot_id,
      mindbodyClientId: member.mindbody_client_id,
      tier: member.tier,
      billingMigrationRequestedAt: member.billing_migration_requested_at,
      contractStartDate: member.contract_start_date,
      cancellation: member.cancellation_requested_at ? {
        requestedAt: member.cancellation_requested_at,
        effectiveDate: member.cancellation_effective_date,
        reason: member.cancellation_reason,
      } : null,
    };
    
    // Always fetch Stripe wallet data when member has stripe_customer_id
    if (member.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        
        // Only fetch subscription data if billing_provider is stripe
        if (member.billing_provider === 'stripe') {
          const subsResult = await listCustomerSubscriptions(member.stripe_customer_id as string);
          if (subsResult.success && subsResult.subscriptions) {
            const activeSub = subsResult.subscriptions.find(
              s => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due'
            );
            if (activeSub) {
              const periodEndTimestamp = activeSub.currentPeriodEnd?.getTime();
              const validPeriodEnd = periodEndTimestamp && periodEndTimestamp > 0 
                ? Math.floor(periodEndTimestamp / 1000) 
                : null;
              billingInfo.subscription = {
                status: activeSub.status,
                currentPeriodEnd: validPeriodEnd,
                cancelAtPeriodEnd: activeSub.cancelAtPeriodEnd,
                isPaused: activeSub.isPaused,
              };
              
              const hasUpcomingChanges = activeSub.cancelAtPeriodEnd || activeSub.pausedUntil || activeSub.pendingUpdate;
              if (hasUpcomingChanges) {
                billingInfo.upcomingChanges = {
                  cancelAtPeriodEnd: activeSub.cancelAtPeriodEnd,
                  cancelAt: activeSub.cancelAtPeriodEnd && validPeriodEnd
                    ? validPeriodEnd
                    : null,
                  pausedUntil: activeSub.pausedUntil 
                    ? Math.floor(activeSub.pausedUntil.getTime() / 1000)
                    : null,
                  pendingTierChange: activeSub.pendingUpdate
                    ? {
                        newPlanName: activeSub.pendingUpdate.newProductName || 'New Plan',
                        effectiveDate: Math.floor(activeSub.pendingUpdate.effectiveAt.getTime() / 1000),
                      }
                    : null,
                };
              }
            }
          }
        }
        
        // Always fetch payment methods and balance for any member with Stripe customer
        const paymentMethods = await stripe.paymentMethods.list({
          customer: member.stripe_customer_id as string,
          type: 'card',
        });
        billingInfo.paymentMethods = paymentMethods.data.map(pm => ({
          id: pm.id,
          brand: pm.card?.brand,
          last4: pm.card?.last4,
          expMonth: pm.card?.exp_month,
          expYear: pm.card?.exp_year,
        }));
        
        const customer = await stripe.customers.retrieve(member.stripe_customer_id as string);
        if (customer && !customer.deleted) {
          // Return balance in cents (UI divides by 100 for display)
          billingInfo.customerBalance = (customer as Stripe.Customer).balance || 0;
        }
      } catch (stripeError: unknown) {
        logger.error('[MyBilling] Stripe error', { extra: { stripeError: getErrorMessage(stripeError) } });
        billingInfo.stripeError = 'Unable to load billing details';
      }
    }
    
    if (member.billing_provider === 'family_addon') {
      try {
        const familyGroup = await getBillingGroupByMemberEmail(email);
        if (familyGroup) {
          billingInfo.familyGroup = {
            primaryName: familyGroup.primaryName,
            primaryEmail: familyGroup.primaryEmail,
          };
        }
      } catch (familyError: unknown) {
        logger.warn('[MyBilling] Family group lookup failed', { extra: { familyError: getErrorMessage(familyError) } });
      }
    }
    
    res.json(billingInfo);
  } catch (error: unknown) {
    logger.error('[MyBilling] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to load billing info' });
  }
});

router.get('/api/my/billing/invoices', requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    const isStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    const email = (req.query.email && isStaff) ? String(req.query.email).trim().toLowerCase() : sessionUser.email;
    
    const result = await db.execute(sql`SELECT stripe_customer_id, billing_provider FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    // Return invoices if member has a Stripe customer ID (regardless of billing_provider)
    // This allows MindBody members to see their one-off Stripe purchases (overage fees, guest passes)
    if (!member.stripe_customer_id) {
      return res.json({ invoices: [] });
    }
    
    const invoicesResult = await listCustomerInvoices(member.stripe_customer_id as string);
    
    if (!invoicesResult.success) {
      return res.status(500).json({ error: 'Failed to load invoices' });
    }
    
    const invoices = (invoicesResult.invoices || []).map((inv) => ({
      id: inv.id,
      number: (inv as any).number,
      status: inv.status,
      amountDue: inv.amountDue,
      amountPaid: inv.amountPaid,
      created: Math.floor(inv.created.getTime() / 1000),
      hostedInvoiceUrl: inv.hostedInvoiceUrl,
      invoicePdf: inv.invoicePdf,
    }));
    
    res.json({ invoices });
  } catch (error: unknown) {
    logger.error('[MyBilling] Invoice error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to load invoices' });
  }
});

router.post('/api/my/billing/update-payment-method', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    const result = await db.execute(sql`SELECT stripe_customer_id, billing_provider FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member || member.billing_provider !== 'stripe' || !member.stripe_customer_id) {
      return res.status(400).json({ error: 'Stripe billing not available' });
    }
    
    const stripe = await getStripeClient();
    
    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/profile`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}/profile`
        : 'https://everclub.com/profile';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: member.stripe_customer_id as string,
      return_url: returnUrl,
      flow_data: {
        type: 'payment_method_update',
      },
    });
    
    res.json({ url: session.url });
  } catch (error: unknown) {
    logger.error('[MyBilling] Payment update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create payment update link' });
  }
});

router.post('/api/my/billing/portal', requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    const isStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    const targetEmail = (req.body.email && isStaff) ? String(req.body.email).trim().toLowerCase() : sessionUser.email;
    
    const result = await db.execute(sql`SELECT id, stripe_customer_id, billing_provider, email, role, first_name, last_name, tier FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    // Don't create Stripe customers for staff/admin accessing their own portal
    // (Staff can still view member billing portals when passing a member email)
    const targetIsStaff = member.role === 'staff' || member.role === 'admin';
    if (targetIsStaff) {
      return res.status(400).json({ error: 'Staff accounts do not have billing portals' });
    }
    
    const stripe = await getStripeClient();
    let customerId = member.stripe_customer_id as string;
    
    if (!customerId) {
      const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
      const result = await getOrCreateStripeCustomer(String(member.id), member.email as string, fullName as string, member.tier as string);
      customerId = result.customerId;
      await db.execute(sql`UPDATE users SET stripe_customer_id = ${customerId},
         billing_provider = CASE WHEN billing_provider IN ('mindbody', 'manual', 'comped') THEN billing_provider ELSE 'stripe' END
         WHERE LOWER(email) = LOWER(${targetEmail.toLowerCase()})`);
      const preservedProvider = member.billing_provider && ['mindbody', 'manual', 'comped'].includes(member.billing_provider as string)
        ? member.billing_provider as string
        : 'stripe';
      try {
        const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
        await syncMemberToHubSpot({ email: member.email as string, billingProvider: preservedProvider });
      } catch (e: unknown) {
        logger.warn('[MyBilling] Failed to sync billing provider to HubSpot for', { extra: { email: member.email as string, e_as_any_e: (e as Error)?.message || e } });
      }
    }
    
    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/profile`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}/profile`
        : 'https://everclub.com/profile';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId as string,
      return_url: returnUrl,
    });
    
    res.json({ url: session.url });
  } catch (error: unknown) {
    logger.error('[MyBilling] Portal error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// Add payment method for extras (overage fees, etc) - does NOT trigger migration
// MindBody members use this to add a card for overage fees without requesting migration
router.post('/api/my/billing/add-payment-method-for-extras', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    const sessionRole = req.session.user.role;
    if (sessionRole === 'staff' || sessionRole === 'admin') {
      return res.status(400).json({ error: 'Staff accounts do not use billing' });
    }
    
    const result = await db.execute(sql`SELECT id, email, first_name, last_name, billing_provider, stripe_customer_id, tier
       FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const stripe = await getStripeClient();
    let customerId = member.stripe_customer_id as string;
    
    // Create or find Stripe customer (but don't mark for migration)
    if (!customerId) {
      const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
      const custResult = await getOrCreateStripeCustomer(String(member.id), member.email as string, fullName as string, member.tier as string);
      customerId = custResult.customerId;
    }
    
    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/profile`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}/profile`
        : 'https://everclub.com/profile';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId as string,
      return_url: returnUrl,
      flow_data: {
        type: 'payment_method_update',
      },
    });
    
    logger.info('[MyBilling] Payment method setup (for extras) initiated for', { extra: { memberEmail: member.email as string } });
    res.json({ url: session.url });
  } catch (error: unknown) {
    logger.error('[MyBilling] Add payment method for extras error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to open payment portal' });
  }
});

router.post('/api/my/billing/migrate-to-stripe', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    // Staff/admin don't need billing migration
    const sessionRole = req.session.user.role;
    if (sessionRole === 'staff' || sessionRole === 'admin') {
      return res.status(400).json({ error: 'Staff accounts do not use billing' });
    }
    
    const result = await db.execute(sql`SELECT id, email, first_name, last_name, billing_provider, stripe_customer_id, tier
       FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (member.billing_provider === 'stripe') {
      return res.json({ success: true, message: 'Already on Stripe billing' });
    }
    
    const stripe = await getStripeClient();
    let customerId = member.stripe_customer_id as string;
    
    if (!customerId) {
      const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
      const custResult = await getOrCreateStripeCustomer(String(member.id), member.email as string, fullName as string, member.tier as string);
      customerId = custResult.customerId;
    }
    
    await db.execute(sql`UPDATE users SET billing_migration_requested_at = NOW() WHERE id = ${member.id}`);
    
    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/profile`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}/profile`
        : 'https://everclub.com/profile';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId as string,
      return_url: returnUrl,
      flow_data: {
        type: 'payment_method_update',
      },
    });
    
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;
    const notificationTitle = 'Billing Migration Request';
    const notificationMessage = `${memberName} has added a payment method and is ready to transition from MindBody billing`;
    
    try {
      await notifyAllStaff(
        notificationTitle,
        notificationMessage,
        'billing_migration'
      );
      logger.info('[MyBilling] Staff notification sent for billing migration request from', { extra: { memberEmail: member.email } });
    } catch (notifyError: unknown) {
      logger.error('[MyBilling] Staff notification failed for', { extra: { email: member.email, error: getErrorMessage(notifyError) } });
    }
    
    res.json({ url: session.url });
  } catch (error: unknown) {
    logger.error('[MyBilling] Migration error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to initiate billing migration' });
  }
});

router.get('/api/my/balance', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    const result = await db.execute(sql`SELECT stripe_customer_id, role FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    // Staff/admin don't have account balances
    if ((result.rows as Array<Record<string, unknown>>)[0]?.role === 'staff' || (result.rows as Array<Record<string, unknown>>)[0]?.role === 'admin') {
      return res.json({ balanceCents: 0, balanceDollars: 0, isStaff: true });
    }
    
    if (!(result.rows as Array<Record<string, unknown>>)[0]?.stripe_customer_id) {
      return res.json({ balanceCents: 0, balanceDollars: 0 });
    }
    
    const stripe = await getStripeClient();
    const customer = await stripe.customers.retrieve((result.rows as Array<Record<string, unknown>>)[0].stripe_customer_id as string);
    
    if (customer.deleted) {
      return res.json({ balanceCents: 0, balanceDollars: 0 });
    }
    
    const balanceCents = (customer as Stripe.Customer).balance || 0;
    res.json({
      balanceCents: Math.abs(balanceCents),
      balanceDollars: Math.abs(balanceCents) / 100,
      isCredit: balanceCents < 0
    });
  } catch (error: unknown) {
    logger.error('[MyBilling] Balance fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

router.post('/api/my/add-funds', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    const { amountCents } = req.body;
    
    if (!amountCents || amountCents < 500 || amountCents > 50000) {
      return res.status(400).json({ error: 'Amount must be between $5 and $500' });
    }
    
    const result = await db.execute(sql`SELECT id, stripe_customer_id, first_name, last_name, role, tier FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    // Staff/admin don't need account balance functionality - don't create Stripe customers for them
    if (member.role === 'staff' || member.role === 'admin') {
      return res.status(400).json({ error: 'Staff accounts do not use account balance' });
    }
    
    const stripe = await getStripeClient();
    
    let customerId = member.stripe_customer_id as string;
    if (!customerId) {
      const fullName = `${(member.first_name as string) || ''} ${(member.last_name as string) || ''}`.trim() || undefined;
      const custResult = await getOrCreateStripeCustomer(String(member.id), email, fullName, member.tier as string);
      customerId = custResult.customerId;
    }
    
    const replitDomains = process.env.REPLIT_DOMAINS?.split(',')[0];
    const baseUrl = replitDomains ? `https://${replitDomains}` : 'http://localhost:5000';
    
    const session = await stripe.checkout.sessions.create({
      customer: customerId as string,
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: 'Account Balance Top-Up',
            description: `Add $${(amountCents / 100).toFixed(2)} to your Ever Club account balance`
          }
        },
        quantity: 1
      }],
      metadata: {
        purpose: 'add_funds',
        memberEmail: email,
        amountCents: amountCents.toString()
      },
      success_url: `${baseUrl}/member/profile?funds_added=true`,
      cancel_url: `${baseUrl}/member/profile`
    });
    
    res.json({ checkoutUrl: session.url });
  } catch (error: unknown) {
    logger.error('[MyBilling] Add funds error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Route alias for account-balance endpoint
// Supports ?user_email param for "View As" feature when staff views as another member
router.get('/api/my-billing/account-balance', requireAuth, async (req, res) => {
  try {
    const sessionEmail = req.session.user.email;
    const sessionRole = req.session.user.role;
    
    // Support "View As" feature: staff can pass user_email param to view as another member
    const requestedEmail = (req.query.user_email as string | undefined)?.trim()?.toLowerCase();
    let targetEmail = sessionEmail;
    
    if (requestedEmail && requestedEmail !== sessionEmail.toLowerCase()) {
      if (sessionRole === 'admin' || sessionRole === 'staff') {
        targetEmail = requestedEmail;
      }
    }
    
    const result = await db.execute(sql`SELECT stripe_customer_id, role FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`);
    
    // Staff/admin don't have account balances
    if ((result.rows as Array<Record<string, unknown>>)[0]?.role === 'staff' || (result.rows as Array<Record<string, unknown>>)[0]?.role === 'admin') {
      return res.json({ balanceCents: 0, balanceDollars: 0, isStaff: true });
    }
    
    if (!(result.rows as Array<Record<string, unknown>>)[0]?.stripe_customer_id) {
      return res.json({ balanceCents: 0, balanceDollars: 0 });
    }
    
    const stripe = await getStripeClient();
    const customer = await stripe.customers.retrieve((result.rows as Array<Record<string, unknown>>)[0].stripe_customer_id as string);
    
    if (customer.deleted) {
      return res.json({ balanceCents: 0, balanceDollars: 0 });
    }
    
    const balanceCents = (customer as Stripe.Customer).balance || 0;
    res.json({
      balanceCents: Math.abs(balanceCents),
      balanceDollars: Math.abs(balanceCents) / 100,
      isCredit: balanceCents < 0
    });
  } catch (error: unknown) {
    logger.error('[MyBilling] Account balance fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Sync member to Stripe - create or find customer by email
router.post('/api/member-billing/:email/sync-stripe', requireStaffAuth, async (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email as any).trim().toLowerCase();
    
    const result = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id, tier FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (member.stripe_customer_id) {
      return res.json({ success: true, created: false, customerId: member.stripe_customer_id });
    }
    
    const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
    const custResult = await getOrCreateStripeCustomer(String(member.id), targetEmail, fullName as string, member.tier as string);
    const customerId = custResult.customerId;
    const created = custResult.isNew;
    logger.info('[SyncStripe] Stripe customer for', { extra: { created_Created_Found_existing: created ? 'Created' : 'Found existing', customerId, targetEmail } });
    
    res.json({ success: true, created, customerId });
  } catch (error: unknown) {
    logger.error('[SyncStripe] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync to Stripe' });
  }
});

// Sync customer metadata to Stripe
router.post('/api/member-billing/:email/sync-metadata', requireStaffAuth, async (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email as any).trim().toLowerCase();
    
    const result = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id, tier FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'Member does not have a Stripe customer ID' });
    }
    
    const stripe = await getStripeClient();
    
    await stripe.customers.update(member.stripe_customer_id as string, {
      name: [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined,
      metadata: {
        userId: (member.id as number).toString(),
        tier: (member.tier as string) || '',
        lastSyncAt: new Date().toISOString(),
      },
    });
    
    logger.info('[SyncMetadata] Updated Stripe customer metadata for', { extra: { memberStripe_customer_id: member.stripe_customer_id, targetEmail } });
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[SyncMetadata] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync metadata' });
  }
});

// Sync tier from Stripe subscription - fetches active subscription and updates tier based on product name
router.post('/api/member-billing/:email/sync-tier-from-stripe', requireStaffAuth, async (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email as any).trim().toLowerCase();
    
    const result = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id, tier FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'Member does not have a Stripe customer ID' });
    }
    
    const stripe = await getStripeClient();
    
    // Fetch active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: member.stripe_customer_id as string,
      status: 'active',
      limit: 10,
    });
    
    if (subscriptions.data.length === 0) {
      // Also check for trialing/past_due
      const allSubs = await stripe.subscriptions.list({
        customer: member.stripe_customer_id as string,
        limit: 10,
      });
      const activeSub = allSubs.data.find(s => 
        s.status === 'active' || s.status === 'trialing' || s.status === 'past_due'
      );
      if (!activeSub) {
        return res.status(400).json({ error: 'No active subscription found in Stripe' });
      }
      subscriptions.data = [activeSub];
    }
    
    const activeSub = subscriptions.data[0];
    const priceId = activeSub.items?.data?.[0]?.price?.id;
    const productId = activeSub.items?.data?.[0]?.price?.product;
    
    // First try to match by price ID
    let tierResult = await db.execute(sql`SELECT slug, name FROM membership_tiers WHERE stripe_price_id = ${priceId} OR founding_price_id = ${priceId}`);
    
    let newTier: string | null = null;
    let matchMethod = '';
    
    let tierRows = tierResult.rows as Array<Record<string, unknown>>;
    if (tierRows.length > 0) {
      newTier = tierRows[0].name as string;
      matchMethod = 'price_id';
    } else if (productId) {
      // Fallback: fetch product and match by name
      const product = await stripe.products.retrieve(productId as string);
      const productName = product.name?.toLowerCase() || '';
      
      // Match product name to tier - look for tier keywords
      const tierKeywords = ['vip', 'premium', 'corporate', 'core', 'social'];
      for (const keyword of tierKeywords) {
        if (productName.includes(keyword)) {
          tierResult = await db.execute(sql`SELECT slug, name FROM membership_tiers WHERE LOWER(slug) = ${keyword} OR LOWER(name) = ${keyword}`);
          tierRows = tierResult.rows as Array<Record<string, unknown>>;
          if (tierRows.length > 0) {
            newTier = tierRows[0].name as string;
            matchMethod = 'product_name';
            break;
          }
        }
      }
    }
    
    if (!newTier) {
      return res.status(400).json({ 
        error: 'Could not match Stripe subscription to a tier',
        priceId,
        productId,
        hint: 'The Stripe price or product may not be linked to a tier in the database'
      });
    }
    
    const previousTier = member.tier;
    
    if (newTier === previousTier) {
      return res.json({ 
        success: true, 
        message: 'Tier already matches',
        previousTier,
        newTier,
        matchMethod
      });
    }
    
    // Update the user's tier
    await db.execute(sql`UPDATE users SET tier = ${newTier}, billing_provider = 'stripe', membership_status = 'active', updated_at = NOW() WHERE id = ${member.id}`);
    
    logger.info('[SyncTierFromStripe] Updated tier for : -> (matched by )', { extra: { targetEmail, previousTier, newTier, matchMethod } });
    
    // Sync to HubSpot
    try {
      const { syncMemberToHubSpot } = await import('../core/hubspot/stages');
      await syncMemberToHubSpot({ email: targetEmail, status: 'active', tier: newTier, billingProvider: 'stripe' });
      logger.info('[SyncTierFromStripe] Synced to HubSpot: status=active, tier=, billing=stripe', { extra: { targetEmail, newTier } });
    } catch (hubspotError) {
      logger.error('[SyncTierFromStripe] HubSpot sync failed', { extra: { hubspotError } });
    }
    
    res.json({ 
      success: true, 
      previousTier,
      newTier,
      matchMethod,
      message: `Tier updated from ${previousTier || 'none'} to ${newTier}`
    });
  } catch (error: unknown) {
    logger.error('[SyncTierFromStripe] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to sync tier from Stripe' });
  }
});

// Backfill transaction cache for individual member
router.post('/api/member-billing/:email/backfill-cache', requireStaffAuth, async (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email as any).trim().toLowerCase();
    
    const result = await db.execute(sql`SELECT id, email, stripe_customer_id FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (!member.stripe_customer_id) {
      return res.status(400).json({ error: 'Member does not have a Stripe customer ID' });
    }
    
    const stripe = await getStripeClient();
    
    // Get last 90 days of charges
    const ninetyDaysAgo = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
    
    const charges = await stripe.charges.list({
      customer: member.stripe_customer_id as string,
      created: { gte: ninetyDaysAgo },
      limit: 100,
    });
    
    let transactionCount = 0;
    
    for (const charge of charges.data) {
      if (charge.status !== 'succeeded') continue;
      
      // Insert or update in stripe_transaction_cache
      await db.execute(sql`INSERT INTO stripe_transaction_cache (
          stripe_id, object_type, customer_id, customer_email,
          amount_cents, currency, status, description, 
          payment_intent_id, charge_id, created_at, updated_at, source
        ) VALUES (${charge.id}, ${'charge'}, ${member.stripe_customer_id as string}, ${targetEmail}, ${charge.amount}, ${charge.currency}, ${charge.status}, ${charge.description || null}, ${charge.payment_intent || null}, ${charge.id}, to_timestamp(${charge.created}), NOW(), ${'backfill'})
        ON CONFLICT (stripe_id) DO UPDATE SET
          amount_cents = EXCLUDED.amount_cents,
          status = EXCLUDED.status,
          description = EXCLUDED.description,
          updated_at = NOW()`);
      transactionCount++;
    }
    
    logger.info('[BackfillCache] Cached transactions for', { extra: { transactionCount, targetEmail } });
    res.json({ success: true, transactionCount });
  } catch (error: unknown) {
    logger.error('[BackfillCache] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to backfill cache' });
  }
});

router.post('/api/my/billing/request-cancellation', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    const { reason } = req.body;
    
    const result = await db.execute(sql`SELECT id, email, billing_provider, stripe_customer_id, cancellation_requested_at 
       FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (member.cancellation_requested_at) {
      return res.status(400).json({ 
        error: 'Cancellation already requested',
        cancellationRequestedAt: member.cancellation_requested_at
      });
    }
    
    if (member.billing_provider !== 'stripe' || !member.stripe_customer_id) {
      return res.status(400).json({ error: 'Cancellation requests are only available for Stripe billing' });
    }
    
    const stripe = await getStripeClient();
    const subscriptions = await stripe.subscriptions.list({
      customer: member.stripe_customer_id as string,
      status: 'active',
      limit: 1,
    });
    
    if (subscriptions.data.length === 0) {
      return res.status(400).json({ error: 'No active subscription found' });
    }
    
    const subscription = subscriptions.data[0];
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const currentPeriodEnd = new Date((subscription as any).current_period_end * 1000);
    const effectiveDate = thirtyDaysFromNow > currentPeriodEnd ? thirtyDaysFromNow : currentPeriodEnd;
    const cancelAtTimestamp = Math.floor(effectiveDate.getTime() / 1000);
    
    await stripe.subscriptions.update(subscription.id, {
      cancel_at: cancelAtTimestamp,
    });
    
    await db.execute(sql`UPDATE users SET 
        cancellation_requested_at = NOW(),
        cancellation_effective_date = ${formatDatePacific(effectiveDate)},
        cancellation_reason = ${reason || null},
        updated_at = NOW()
       WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    try {
      await notifyAllStaff(
        'Member Cancellation Request',
        `${email} has requested to cancel their membership. Effective date: ${effectiveDate.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}. Reason: ${reason || 'Not specified'}`,
        'membership_cancellation'
      );
    } catch (notifyErr) {
      logger.warn('[MyBilling] Failed to notify staff of cancellation request', { extra: { notifyErr } });
    }
    
    logger.info('[MyBilling] Member requested cancellation, effective', { extra: { email, effectiveDateToISOString: effectiveDate.toISOString() } });
    
    res.json({
      success: true,
      message: 'Cancellation request submitted',
      cancellationRequestedAt: now.toISOString(),
      cancellationEffectiveDate: effectiveDate.toISOString(),
      noticePeriodDays: 30,
    });
  } catch (error: unknown) {
    logger.error('[MyBilling] Cancellation request error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to submit cancellation request' });
  }
});

router.get('/api/my/billing/cancellation-status', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    const result = await db.execute(sql`SELECT cancellation_requested_at, cancellation_effective_date, cancellation_reason
       FROM users WHERE LOWER(email) = ${email.toLowerCase()}`);
    
    const member = (result.rows as Array<Record<string, unknown>>)[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    res.json({
      hasPendingCancellation: !!member.cancellation_requested_at,
      cancellationRequestedAt: member.cancellation_requested_at,
      cancellationEffectiveDate: member.cancellation_effective_date,
      cancellationReason: member.cancellation_reason,
    });
  } catch (error: unknown) {
    logger.error('[MyBilling] Cancellation status error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get cancellation status' });
  }
});

router.get('/api/my-billing/receipt/:paymentIntentId', requireAuth, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    const sessionEmail = req.session.user.email;
    
    if (!paymentIntentId || !(paymentIntentId as string).startsWith('pi_')) {
      return res.status(400).json({ error: 'Invalid payment intent ID' });
    }
    
    const userResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()}`);
    
    const user = (userResult.rows as Array<Record<string, unknown>>)[0];
    if (!user || !user.stripe_customer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const piResult = await db.execute(sql`SELECT stripe_customer_id, user_id FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${paymentIntentId}`);
    
    const paymentIntent = (piResult.rows as Array<Record<string, unknown>>)[0];
    if (!paymentIntent) {
      return res.status(404).json({ error: 'Payment intent not found' });
    }
    
    const belongsToUser = paymentIntent.stripe_customer_id === user.stripe_customer_id ||
                         paymentIntent.user_id === user.id;
    
    if (!belongsToUser) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const stripe = await getStripeClient();
    const charges = await stripe.charges.list({ payment_intent: paymentIntentId as string, limit: 1 });
    
    if (charges.data.length > 0 && charges.data[0].receipt_url) {
      return res.json({ receiptUrl: charges.data[0].receipt_url });
    }
    
    res.status(404).json({ error: 'Receipt not available' });
  } catch (error: unknown) {
    logger.error('[MyBilling] Receipt fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch receipt' });
  }
});

export default router;
