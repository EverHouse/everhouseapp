import { Router } from 'express';
import { pool } from '../core/db';
import { getStripeClient } from '../core/stripe/client';
import { listCustomerSubscriptions } from '../core/stripe/subscriptions';
import { getBillingGroupByMemberEmail } from '../core/stripe/groupBilling';
import { listCustomerInvoices } from '../core/stripe/invoices';
import { notifyAllStaffRequired, getStaffAndAdminEmails } from '../core/staffNotifications';

const router = Router();

function requireAuth(req: any, res: any, next: any) {
  if (!req.session?.user?.email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

router.get('/api/my/billing', requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    const isStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    const targetEmail = (req.query.email && isStaff) ? String(req.query.email) : sessionUser.email;
    const email = targetEmail;
    
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, billing_provider, stripe_customer_id, tier, billing_migration_requested_at
       FROM users WHERE LOWER(email) = $1`,
      [email.toLowerCase()]
    );
    
    const member = result.rows[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const billingInfo: any = {
      billingProvider: member.billing_provider,
      tier: member.tier,
      billingMigrationRequestedAt: member.billing_migration_requested_at,
    };
    
    if (member.billing_provider === 'stripe' && member.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        
        const subsResult = await listCustomerSubscriptions(member.stripe_customer_id);
        if (subsResult.success && subsResult.subscriptions) {
          const activeSub = subsResult.subscriptions.find(
            s => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due'
          );
          if (activeSub) {
            billingInfo.subscription = {
              status: activeSub.status,
              currentPeriodEnd: Math.floor(activeSub.currentPeriodEnd.getTime() / 1000),
              cancelAtPeriodEnd: activeSub.cancelAtPeriodEnd,
              isPaused: activeSub.isPaused,
            };
            
            const hasUpcomingChanges = activeSub.cancelAtPeriodEnd || activeSub.pausedUntil || activeSub.pendingUpdate;
            if (hasUpcomingChanges) {
              billingInfo.upcomingChanges = {
                cancelAtPeriodEnd: activeSub.cancelAtPeriodEnd,
                cancelAt: activeSub.cancelAtPeriodEnd 
                  ? Math.floor(activeSub.currentPeriodEnd.getTime() / 1000)
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
        
        const customer = await stripe.customers.retrieve(member.stripe_customer_id);
        if (customer && !customer.deleted) {
          billingInfo.customerBalanceDollars = ((customer as any).balance || 0) / 100;
        }
      } catch (stripeError: any) {
        console.error('[MyBilling] Stripe error:', stripeError.message);
        billingInfo.stripeError = 'Unable to load billing details';
      }
    } else if (member.billing_provider === 'family_addon') {
      try {
        const familyGroup = await getBillingGroupByMemberEmail(email);
        if (familyGroup) {
          billingInfo.familyGroup = {
            primaryName: familyGroup.primaryName,
            primaryEmail: familyGroup.primaryEmail,
          };
        }
      } catch (e) {}
    }
    
    res.json(billingInfo);
  } catch (error: any) {
    console.error('[MyBilling] Error:', error);
    res.status(500).json({ error: 'Failed to load billing info' });
  }
});

router.get('/api/my/billing/invoices', requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    const isStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    const email = (req.query.email && isStaff) ? String(req.query.email) : sessionUser.email;
    
    const result = await pool.query(
      `SELECT stripe_customer_id, billing_provider FROM users WHERE LOWER(email) = $1`,
      [email.toLowerCase()]
    );
    
    const member = result.rows[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (member.billing_provider !== 'stripe' || !member.stripe_customer_id) {
      return res.json({ invoices: [] });
    }
    
    const invoicesResult = await listCustomerInvoices(member.stripe_customer_id);
    
    if (!invoicesResult.success) {
      return res.status(500).json({ error: 'Failed to load invoices' });
    }
    
    const invoices = (invoicesResult.invoices || []).map((inv: any) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountDue: inv.amountDue,
      amountPaid: inv.amountPaid,
      created: Math.floor(inv.created.getTime() / 1000),
      hostedInvoiceUrl: inv.hostedInvoiceUrl,
      invoicePdf: inv.invoicePdf,
    }));
    
    res.json({ invoices });
  } catch (error: any) {
    console.error('[MyBilling] Invoice error:', error);
    res.status(500).json({ error: 'Failed to load invoices' });
  }
});

router.post('/api/my/billing/update-payment-method', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    const result = await pool.query(
      `SELECT stripe_customer_id, billing_provider FROM users WHERE LOWER(email) = $1`,
      [email.toLowerCase()]
    );
    
    const member = result.rows[0];
    if (!member || member.billing_provider !== 'stripe' || !member.stripe_customer_id) {
      return res.status(400).json({ error: 'Stripe billing not available' });
    }
    
    const stripe = await getStripeClient();
    
    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/profile`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}/profile`
        : 'https://everhouse.com/profile';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: member.stripe_customer_id,
      return_url: returnUrl,
      flow_data: {
        type: 'payment_method_update',
      },
    });
    
    res.json({ url: session.url });
  } catch (error: any) {
    console.error('[MyBilling] Payment update error:', error);
    res.status(500).json({ error: 'Failed to create payment update link' });
  }
});

router.post('/api/my/billing/portal', requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    const isStaff = sessionUser.role === 'admin' || sessionUser.role === 'staff';
    const targetEmail = (req.body.email && isStaff) ? String(req.body.email) : sessionUser.email;
    
    const result = await pool.query(
      `SELECT stripe_customer_id, billing_provider, email FROM users WHERE LOWER(email) = $1`,
      [targetEmail.toLowerCase()]
    );
    
    const member = result.rows[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const stripe = await getStripeClient();
    let customerId = member.stripe_customer_id;
    
    if (!customerId) {
      const customers = await stripe.customers.list({ email: member.email, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
        await pool.query(
          `UPDATE users SET stripe_customer_id = $1, billing_provider = 'stripe' WHERE LOWER(email) = $2`,
          [customerId, targetEmail.toLowerCase()]
        );
      } else {
        const customer = await stripe.customers.create({ email: member.email });
        customerId = customer.id;
        await pool.query(
          `UPDATE users SET stripe_customer_id = $1, billing_provider = 'stripe' WHERE LOWER(email) = $2`,
          [customerId, targetEmail.toLowerCase()]
        );
      }
    }
    
    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/profile`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}/profile`
        : 'https://everhouse.com/profile';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    
    res.json({ url: session.url });
  } catch (error: any) {
    console.error('[MyBilling] Portal error:', error);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

router.post('/api/my/billing/migrate-to-stripe', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, billing_provider, stripe_customer_id
       FROM users WHERE LOWER(email) = $1`,
      [email.toLowerCase()]
    );
    
    const member = result.rows[0];
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (member.billing_provider === 'stripe') {
      return res.json({ success: true, message: 'Already on Stripe billing' });
    }
    
    const stripe = await getStripeClient();
    let customerId = member.stripe_customer_id;
    
    if (!customerId) {
      const customers = await stripe.customers.list({ email: member.email, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      } else {
        const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
        const customer = await stripe.customers.create({
          email: member.email,
          name: fullName,
        });
        customerId = customer.id;
      }
    }
    
    await pool.query(
      `UPDATE users SET stripe_customer_id = $1, billing_migration_requested_at = NOW() WHERE id = $2`,
      [customerId, member.id]
    );
    
    const returnUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/profile`
      : process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? `https://${process.env.REPLIT_DEPLOYMENT_DOMAIN}/profile`
        : 'https://everhouse.com/profile';
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      flow_data: {
        type: 'payment_method_update',
      },
    });
    
    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;
    const notificationTitle = 'Billing Migration Request';
    const notificationMessage = `${memberName} has added a payment method and is ready to transition from MindBody billing`;
    
    try {
      await notifyAllStaffRequired(
        notificationTitle,
        notificationMessage,
        'billing_migration'
      );
      console.log(`[MyBilling] Staff notification sent for billing migration request from ${member.email}`);
    } catch (notifyError: any) {
      console.error(`[MyBilling] Real-time staff notification failed for ${member.email}:`, notifyError.message);
      
      try {
        const staffEmails = await getStaffAndAdminEmails();
        if (staffEmails.length > 0) {
          const placeholders: string[] = [];
          const params: string[] = [];
          staffEmails.forEach((staffEmail, i) => {
            const base = i * 4;
            placeholders.push('($' + (base + 1) + ', $' + (base + 2) + ', $' + (base + 3) + ', $' + (base + 4) + ', NOW())');
            params.push(staffEmail, notificationTitle, notificationMessage, 'billing_migration');
          });
          await pool.query(
            'INSERT INTO notifications (user_email, title, message, type, created_at) VALUES ' + placeholders.join(', '),
            params
          );
          console.log('[MyBilling] Fallback notification inserted for ' + staffEmails.length + ' staff members');
        } else {
          console.error('[MyBilling] No staff members found for fallback notification');
        }
      } catch (fallbackError: any) {
        console.error('[MyBilling] Fallback notification insertion failed:', fallbackError.message);
      }
    }
    
    res.json({ url: session.url });
  } catch (error: any) {
    console.error('[MyBilling] Migration error:', error);
    res.status(500).json({ error: 'Failed to initiate billing migration' });
  }
});

export default router;
