import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { pool } from '../core/db';
import { getStripeClient } from '../core/stripe/client';
import { sendOutstandingBalanceEmail } from '../emails/paymentEmails';
import Stripe from 'stripe';

const router = Router();

interface RecentTransaction {
  id: string;
  type: 'offline' | 'stripe' | 'day_pass';
  amount_cents: number;
  description: string;
  member_email: string;
  member_name: string;
  created_at: Date;
  status: string;
}

/**
 * GET /api/financials/recent-transactions
 * Returns unified recent transactions from offline payments, stripe payments, and day passes
 * Requires staff authentication
 */
router.get('/api/financials/recent-transactions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
        'offline' as type, id::text, amount_cents, description, member_email, 
        COALESCE(member_name, 'Unknown') as member_name, created_at, 'completed' as status
      FROM offline_payments
      UNION ALL
      SELECT 
        'stripe' as type, stripe_payment_intent_id as id, amount as amount_cents, description, member_email,
        COALESCE(member_name, 'Unknown') as member_name, created_at, status
      FROM stripe_payment_intents WHERE status = 'succeeded'
      UNION ALL
      SELECT 
        'day_pass' as type, id::text, price_cents as amount_cents, 'Day Pass' as description, email as member_email,
        COALESCE(purchaser_first_name || ' ' || purchaser_last_name, email) as member_name, purchased_at as created_at, 'completed' as status
      FROM day_passes WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const result = await pool.query(query);
    const transactions: RecentTransaction[] = result.rows.map(row => ({
      id: row.id,
      type: row.type,
      amount_cents: parseInt(row.amount_cents),
      description: row.description,
      member_email: row.member_email,
      member_name: row.member_name,
      created_at: new Date(row.created_at),
      status: row.status
    }));

    res.json({
      success: true,
      count: transactions.length,
      transactions
    });
  } catch (error: any) {
    console.error('[Financials] Error fetching recent transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent transactions'
    });
  }
});

interface SubscriptionListItem {
  id: string;
  memberEmail: string;
  memberName: string;
  planName: string;
  amount: number;
  currency: string;
  interval: string;
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
}

/**
 * GET /api/financials/subscriptions
 * Returns Stripe subscriptions with member info
 * Supports pagination (limit, starting_after) and server-side status filtering
 * Requires staff authentication
 */
router.get('/api/financials/subscriptions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    const { status, limit, starting_after } = req.query;
    
    // Debug: Log account info to verify we're using the right API key
    try {
      const account = await stripe.accounts.retrieve();
      console.log(`[Financials] Stripe account: ${account.id}`);
    } catch (e: any) {
      console.log('[Financials] Could not get account info:', e.message);
    }
    
    const statusFilter = status && typeof status === 'string' && status !== 'all' 
      ? status as Stripe.Subscription.Status
      : undefined;
    
    const pageLimit = Math.min(Math.max(parseInt(limit as string) || 50, 1), 100);
    
    const listParams: Stripe.SubscriptionListParams = {
      limit: pageLimit,
      expand: ['data.customer', 'data.items.data.price'],
    };
    
    if (statusFilter) {
      listParams.status = statusFilter;
    }
    
    if (starting_after && typeof starting_after === 'string') {
      listParams.starting_after = starting_after;
    }
    
    console.log(`[Financials] Fetching subscriptions with params:`, listParams);
    const subscriptions = await stripe.subscriptions.list(listParams);
    console.log(`[Financials] Found ${subscriptions.data.length} subscriptions`);

    const subscriptionItems: SubscriptionListItem[] = subscriptions.data.map(sub => {
      const customer = sub.customer as Stripe.Customer;
      const item = sub.items.data[0];
      const price = item?.price;
      
      return {
        id: sub.id,
        memberEmail: customer?.email || 'Unknown',
        memberName: customer?.name || customer?.email || 'Unknown',
        planName: price?.nickname || 'Subscription Plan',
        amount: price?.unit_amount || 0,
        currency: price?.currency || 'usd',
        interval: price?.recurring?.interval || 'month',
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      };
    });

    const lastItem = subscriptions.data[subscriptions.data.length - 1];

    res.json({
      success: true,
      count: subscriptionItems.length,
      subscriptions: subscriptionItems,
      hasMore: subscriptions.has_more,
      nextCursor: subscriptions.has_more && lastItem ? lastItem.id : null,
    });
  } catch (error: any) {
    console.error('[Financials] Error fetching subscriptions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch subscriptions',
    });
  }
});

/**
 * POST /api/financials/subscriptions/:subscriptionId/send-reminder
 * Sends a payment reminder email for a past_due subscription
 * Requires staff authentication
 */
router.post('/api/financials/subscriptions/:subscriptionId/send-reminder', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { subscriptionId } = req.params;
    const stripe = await getStripeClient();

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['customer', 'items.data.price.product'],
    });

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    const customer = subscription.customer as Stripe.Customer;
    if (!customer?.email) {
      return res.status(400).json({ success: false, error: 'Customer email not found' });
    }

    const item = subscription.items.data[0];
    const price = item?.price;
    const product = price?.product as Stripe.Product | undefined;
    const amount = (price?.unit_amount || 0) / 100;

    const result = await sendOutstandingBalanceEmail(customer.email, {
      memberName: customer.name || 'Member',
      amount,
      description: `${product?.name || 'Membership'} subscription payment is past due`,
      dueDate: new Date(subscription.current_period_end * 1000).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    });

    if (result.success) {
      console.log(`[Financials] Sent payment reminder to ${customer.email} for subscription ${subscriptionId}`);
      res.json({ success: true, message: 'Reminder sent successfully' });
    } else {
      res.status(500).json({ success: false, error: result.error || 'Failed to send reminder' });
    }
  } catch (error: any) {
    console.error('[Financials] Error sending subscription reminder:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send reminder',
    });
  }
});

interface InvoiceListItem {
  id: string;
  memberEmail: string;
  memberName: string;
  number: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  created: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

/**
 * GET /api/financials/invoices
 * Returns Stripe invoices with member info
 * Supports pagination (limit, starting_after) and server-side filtering by status and date range
 * Requires staff authentication
 */
router.get('/api/financials/invoices', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    const { status, startDate, endDate, limit, starting_after } = req.query;
    
    const pageLimit = Math.min(Math.max(parseInt(limit as string) || 50, 1), 100);
    
    const listParams: Stripe.InvoiceListParams = {
      limit: pageLimit,
      expand: ['data.customer'],
    };

    if (status && typeof status === 'string' && status !== 'all') {
      listParams.status = status as Stripe.InvoiceListParams['status'];
    }

    if (startDate && typeof startDate === 'string') {
      const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
      listParams.created = { ...(listParams.created as object || {}), gte: startTimestamp };
    }

    if (endDate && typeof endDate === 'string') {
      const endTimestamp = Math.floor(new Date(endDate).getTime() / 1000) + 86400;
      listParams.created = { ...(listParams.created as object || {}), lte: endTimestamp };
    }

    if (starting_after && typeof starting_after === 'string') {
      listParams.starting_after = starting_after;
    }

    const invoices = await stripe.invoices.list(listParams);

    const invoiceItems: InvoiceListItem[] = invoices.data.map(invoice => {
      const customer = invoice.customer as Stripe.Customer | null;
      
      return {
        id: invoice.id,
        memberEmail: customer?.email || invoice.customer_email || 'Unknown',
        memberName: customer?.name || customer?.email || invoice.customer_email || 'Unknown',
        number: invoice.number,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        status: invoice.status || 'draft',
        created: invoice.created,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdf: invoice.invoice_pdf,
      };
    });

    const lastItem = invoices.data[invoices.data.length - 1];

    res.json({
      success: true,
      count: invoiceItems.length,
      invoices: invoiceItems,
      hasMore: invoices.has_more,
      nextCursor: invoices.has_more && lastItem ? lastItem.id : null,
    });
  } catch (error: any) {
    console.error('[Financials] Error fetching invoices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch invoices',
    });
  }
});

export default router;
