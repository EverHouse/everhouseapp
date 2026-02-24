import { logger } from '../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from '../core/stripe/client';
import { sendOutstandingBalanceEmail } from '../emails/paymentEmails';
import { getPacificMidnightUTC } from '../utils/dateUtils';
import { upsertTransactionCache } from '../core/stripe/webhooks';
import Stripe from 'stripe';
import { getErrorMessage } from '../utils/errorUtils';
import { logFromRequest, type AuditAction } from '../core/auditLog';

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
 * Returns unified recent transactions from cache AND local offline payments
 * Uses stripe_transaction_cache for fast queries instead of hitting Stripe API
 * Supports cursor-based pagination for reliable data loading
 * Requires staff authentication
 */
router.get('/api/financials/recent-transactions', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { date, cursor, limit: limitParam } = req.query;
    const limit = Math.min(Math.max(parseInt(limitParam as string) || 100, 1), 500);
    
    let startOfDay: number | undefined;
    let endOfDay: number | undefined;
    
    if (date && typeof date === 'string') {
      startOfDay = Math.floor(getPacificMidnightUTC(date).getTime() / 1000);
      endOfDay = startOfDay + 86400;
    }
    
    const cursorDate = cursor && typeof cursor === 'string' ? new Date(cursor) : null;
    
    let stcDateFilter = sql``;
    let genericDateFilter = sql``;
    let purchasedDateFilter = sql``;
    let stcCursorFilter = sql``;
    let genericCursorFilter = sql``;
    let purchasedCursorFilter = sql``;
    
    if (startOfDay && endOfDay) {
      stcDateFilter = sql` AND stc.created_at >= to_timestamp(${startOfDay}) AND stc.created_at < to_timestamp(${endOfDay})`;
      genericDateFilter = sql` AND created_at >= to_timestamp(${startOfDay}) AND created_at < to_timestamp(${endOfDay})`;
      purchasedDateFilter = sql` AND purchased_at >= to_timestamp(${startOfDay}) AND purchased_at < to_timestamp(${endOfDay})`;
    }
    
    if (cursorDate) {
      stcCursorFilter = sql` AND stc.created_at < ${cursorDate}`;
      genericCursorFilter = sql` AND created_at < ${cursorDate}`;
      purchasedCursorFilter = sql` AND purchased_at < ${cursorDate}`;
    }
    
    const limitPlusOne = limit + 1;

    const result = await db.execute(sql`
      WITH all_transactions AS (
        SELECT 
          stc.stripe_id as id,
          'stripe' as type,
          stc.amount_cents,
          COALESCE(stc.description, 'Stripe payment') as description,
          COALESCE(stc.customer_email, 'Unknown') as member_email,
          COALESCE(stc.customer_name, u.first_name || ' ' || u.last_name, stc.customer_email, 'Unknown') as member_name,
          stc.created_at,
          stc.status
        FROM stripe_transaction_cache stc
        LEFT JOIN users u ON LOWER(u.email) = LOWER(stc.customer_email)
        WHERE stc.status IN ('succeeded', 'paid')${stcDateFilter}${stcCursorFilter}
        
        UNION ALL
        
        SELECT 
          id::text,
          'offline' as type,
          amount_cents,
          description,
          member_email,
          COALESCE(member_name, 'Unknown') as member_name,
          created_at,
          'completed' as status
        FROM offline_payments
        WHERE 1=1${genericDateFilter}${genericCursorFilter}
        
        UNION ALL
        
        SELECT 
          id::text,
          'day_pass' as type,
          amount_cents,
          'Day Pass' as description,
          purchaser_email as member_email,
          COALESCE(purchaser_first_name || ' ' || purchaser_last_name, purchaser_email) as member_name,
          purchased_at as created_at,
          'completed' as status
        FROM day_pass_purchases
        WHERE status IN ('active', 'exhausted')${purchasedDateFilter}${purchasedCursorFilter}
      )
      SELECT * FROM all_transactions
      ORDER BY created_at DESC
      LIMIT ${limitPlusOne}
    `);
    
    const hasMore = result.rows.length > limit;
    const transactions = result.rows.slice(0, limit).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      type: row.type as string,
      amount_cents: parseInt(row.amount_cents as string) || 0,
      description: row.description as string,
      member_email: row.member_email as string,
      member_name: row.member_name as string,
      created_at: new Date(row.created_at as string),
      status: row.status as string
    }));
    
    const seen = new Set<string>();
    const deduplicatedTransactions = transactions.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    const nextCursor = hasMore && deduplicatedTransactions.length > 0
      ? deduplicatedTransactions[deduplicatedTransactions.length - 1].created_at.toISOString()
      : null;

    res.json({
      success: true,
      count: deduplicatedTransactions.length,
      transactions: deduplicatedTransactions,
      hasMore,
      nextCursor
    });
  } catch (error: unknown) {
    logger.error('[Financials] Error fetching recent transactions', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent transactions'
    });
  }
});

/**
 * POST /api/financials/backfill-stripe-cache
 * Backfills historical transactions from Stripe into the cache
 * Requires admin authentication
 */
router.post('/api/financials/backfill-stripe-cache', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { daysBack = 90, batchSize = 100 } = req.body;
    const stripe = await getStripeClient();
    
    const startDate = Math.floor((Date.now() - (daysBack * 24 * 60 * 60 * 1000)) / 1000);
    
    let paymentIntentsProcessed = 0;
    let chargesProcessed = 0;
    let invoicesProcessed = 0;
    let errors: string[] = [];
    
    logger.info('[Financials Backfill] Starting backfill for last days...', { extra: { daysBack } });
    
    let piHasMore = true;
    let piStartingAfter: string | undefined;
    
    while (piHasMore) {
      try {
        const params: Stripe.PaymentIntentListParams = {
          limit: Math.min(batchSize, 100),
          created: { gte: startDate },
          expand: ['data.customer'],
        };
        
        if (piStartingAfter) {
          params.starting_after = piStartingAfter;
        }
        
        const page = await stripe.paymentIntents.list(params);
        
        for (const pi of page.data) {
          if (pi.status !== 'succeeded' && pi.status !== 'requires_capture') continue;
          
          const customer = pi.customer as Stripe.Customer | null;
          await upsertTransactionCache({
            stripeId: pi.id,
            objectType: 'payment_intent',
            amountCents: pi.amount,
            currency: pi.currency || 'usd',
            status: pi.status,
            createdAt: new Date(pi.created * 1000),
            customerId: typeof pi.customer === 'string' ? pi.customer : customer?.id,
            customerEmail: customer?.email || pi.receipt_email || pi.metadata?.email,
            customerName: customer?.name || pi.metadata?.memberName,
            description: pi.description || pi.metadata?.productName || 'Stripe payment',
            metadata: pi.metadata,
            source: 'backfill',
            paymentIntentId: pi.id,
          });
          paymentIntentsProcessed++;
        }
        
        piHasMore = page.has_more;
        if (page.data.length > 0) {
          piStartingAfter = page.data[page.data.length - 1].id;
        }
        
        if (piHasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err: unknown) {
        errors.push(`PaymentIntents batch error: ${getErrorMessage(err)}`);
        logger.error('[Financials Backfill] PaymentIntents error', { extra: { err: getErrorMessage(err) } });
        break;
      }
    }
    
    let chHasMore = true;
    let chStartingAfter: string | undefined;
    
    while (chHasMore) {
      try {
        const params: Stripe.ChargeListParams = {
          limit: Math.min(batchSize, 100),
          created: { gte: startDate },
          expand: ['data.customer'],
        };
        
        if (chStartingAfter) {
          params.starting_after = chStartingAfter;
        }
        
        const page = await stripe.charges.list(params);
        
        for (const ch of page.data) {
          if (!ch.paid || ch.refunded) continue;
          
          const customer = ch.customer as Stripe.Customer | null;
          await upsertTransactionCache({
            stripeId: ch.id,
            objectType: 'charge',
            amountCents: ch.amount,
            currency: ch.currency || 'usd',
            status: 'succeeded',
            createdAt: new Date(ch.created * 1000),
            customerId: typeof ch.customer === 'string' ? ch.customer : customer?.id,
            customerEmail: customer?.email || ch.receipt_email || ch.billing_details?.email,
            customerName: customer?.name || ch.billing_details?.name,
            description: ch.description || 'Stripe charge',
            metadata: ch.metadata,
            source: 'backfill',
            chargeId: ch.id,
            paymentIntentId: typeof ch.payment_intent === 'string' ? ch.payment_intent : undefined,
          });
          chargesProcessed++;
        }
        
        chHasMore = page.has_more;
        if (page.data.length > 0) {
          chStartingAfter = page.data[page.data.length - 1].id;
        }
        
        if (chHasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err: unknown) {
        errors.push(`Charges batch error: ${getErrorMessage(err)}`);
        logger.error('[Financials Backfill] Charges error', { extra: { err: getErrorMessage(err) } });
        break;
      }
    }
    
    let invHasMore = true;
    let invStartingAfter: string | undefined;
    
    while (invHasMore) {
      try {
        const params: Stripe.InvoiceListParams = {
          limit: Math.min(batchSize, 100),
          created: { gte: startDate },
          status: 'paid',
          expand: ['data.customer'],
        };
        
        if (invStartingAfter) {
          params.starting_after = invStartingAfter;
        }
        
        const page = await stripe.invoices.list(params);
        
        for (const inv of page.data) {
          const customer = inv.customer as Stripe.Customer | null;
          await upsertTransactionCache({
            stripeId: inv.id,
            objectType: 'invoice',
            amountCents: inv.amount_paid,
            currency: inv.currency || 'usd',
            status: 'paid',
            createdAt: new Date(inv.created * 1000),
            customerId: typeof inv.customer === 'string' ? inv.customer : customer?.id,
            customerEmail: customer?.email || inv.customer_email,
            customerName: customer?.name,
            description: inv.lines?.data?.[0]?.description || 'Invoice payment',
            metadata: inv.metadata,
            source: 'backfill',
            invoiceId: inv.id,
            paymentIntentId: typeof (inv as any).payment_intent === 'string' ? (inv as any).payment_intent as string : undefined,
          });
          invoicesProcessed++;
        }
        
        invHasMore = page.has_more;
        if (page.data.length > 0) {
          invStartingAfter = page.data[page.data.length - 1].id;
        }
        
        if (invHasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err: unknown) {
        errors.push(`Invoices batch error: ${getErrorMessage(err)}`);
        logger.error('[Financials Backfill] Invoices error', { extra: { err: getErrorMessage(err) } });
        break;
      }
    }
    
    logger.info('[Financials Backfill] Complete: payment intents, charges, invoices', { extra: { paymentIntentsProcessed, chargesProcessed, invoicesProcessed } });
    
    logFromRequest(req, 'backfill_stripe_cache', 'stripe', null as unknown as string, undefined, {
      action: 'backfill',
      daysBack,
      paymentIntentsProcessed,
      chargesProcessed,
      invoicesProcessed,
      errorCount: errors.length,
    });
    
    res.json({
      success: true,
      processed: {
        paymentIntents: paymentIntentsProcessed,
        charges: chargesProcessed,
        invoices: invoicesProcessed,
        total: paymentIntentsProcessed + chargesProcessed + invoicesProcessed
      },
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: unknown) {
    logger.error('[Financials Backfill] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({
      success: false,
      error: 'Failed to backfill Stripe cache'
    });
  }
});

/**
 * POST /api/financials/sync-member-payments
 * Manually sync a specific member's payments from Stripe to the cache
 * Staff can use this to refresh payment history for a member
 * Requires staff authentication
 */
router.post('/api/financials/sync-member-payments', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, daysBack = 365 } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    
    // Find the user's Stripe customer ID
    const userResult = await db.execute(sql`SELECT id, stripe_customer_id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${email})`);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = userResult.rows[0] as Record<string, unknown>;
    if (!user.stripe_customer_id) {
      return res.status(400).json({ success: false, error: 'User has no Stripe customer linked' });
    }
    
    const stripe = await getStripeClient();
    const startDate = Math.floor((Date.now() - (daysBack * 24 * 60 * 60 * 1000)) / 1000);
    
    let paymentsProcessed = 0;
    let invoicesProcessed = 0;
    const errors: string[] = [];
    
    logger.info('[Financials Sync] Syncing payments for (customer: )...', { extra: { email, userStripe_customer_id: user.stripe_customer_id } });
    
    // Fetch all payment intents for this customer (with pagination)
    try {
      let hasMore = true;
      let startingAfter: string | undefined;
      
      while (hasMore) {
        const params: Stripe.PaymentIntentListParams = {
          customer: user.stripe_customer_id as string,
          limit: 100,
          created: { gte: startDate },
          expand: ['data.customer']
        };
        if (startingAfter) params.starting_after = startingAfter;
        
        const page = await stripe.paymentIntents.list(params);
        
        for (const pi of page.data) {
          if (pi.status === 'succeeded' || pi.status === 'requires_payment_method') {
            const customer = pi.customer && typeof pi.customer === 'object' ? pi.customer as Stripe.Customer : null;
            await upsertTransactionCache({
              stripeId: pi.id,
              objectType: 'payment_intent',
              status: pi.status,
              amountCents: pi.amount,
              currency: pi.currency || 'usd',
              createdAt: new Date(pi.created * 1000),
              customerId: user.stripe_customer_id as string,
              customerEmail: email.toLowerCase(),
              customerName: customer?.name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
              description: pi.description || pi.metadata?.productName || 'Stripe payment',
              metadata: pi.metadata,
              source: 'backfill',
              paymentIntentId: pi.id,
            });
            paymentsProcessed++;
          }
        }
        
        hasMore = page.has_more;
        if (page.data.length > 0) {
          startingAfter = page.data[page.data.length - 1].id;
        }
      }
    } catch (err: unknown) {
      errors.push(`PaymentIntents error: ${getErrorMessage(err)}`);
    }
    
    // Fetch all invoices for this customer (with pagination)
    try {
      let hasMore = true;
      let startingAfter: string | undefined;
      
      while (hasMore) {
        const params: Stripe.InvoiceListParams = {
          customer: user.stripe_customer_id as string,
          limit: 100,
          created: { gte: startDate },
          expand: ['data.customer']
        };
        if (startingAfter) params.starting_after = startingAfter;
        
        const page = await stripe.invoices.list(params);
        
        for (const inv of page.data) {
          if (inv.status === 'paid' || inv.status === 'open' || inv.status === 'uncollectible') {
            const customer = inv.customer && typeof inv.customer === 'object' ? inv.customer as Stripe.Customer : null;
            await upsertTransactionCache({
              stripeId: inv.id,
              objectType: 'invoice',
              status: inv.status || 'unknown',
              amountCents: inv.amount_paid || inv.amount_due || 0,
              currency: inv.currency || 'usd',
              createdAt: new Date(inv.created * 1000),
              customerId: user.stripe_customer_id as string,
              customerEmail: email.toLowerCase(),
              customerName: customer?.name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
              description: inv.lines?.data?.[0]?.description || 'Invoice payment',
              metadata: inv.metadata,
              source: 'backfill',
              invoiceId: inv.id,
            });
            invoicesProcessed++;
          }
        }
        
        hasMore = page.has_more;
        if (page.data.length > 0) {
          startingAfter = page.data[page.data.length - 1].id;
        }
      }
    } catch (err: unknown) {
      errors.push(`Invoices error: ${getErrorMessage(err)}`);
    }
    
    logger.info('[Financials Sync] Complete for : payments, invoices', { extra: { email, paymentsProcessed, invoicesProcessed } });
    
    res.json({
      success: true,
      member: { 
        email, 
        name: `${user.first_name} ${user.last_name}`.trim(),
        stripeCustomerId: user.stripe_customer_id
      },
      synced: {
        payments: paymentsProcessed,
        invoices: invoicesProcessed,
        total: paymentsProcessed + invoicesProcessed
      },
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: unknown) {
    logger.error('[Financials Sync] Error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({
      success: false,
      error: 'Failed to sync member payments'
    });
  }
});

/**
 * GET /api/financials/cache-stats
 * Returns statistics about the stripe_transaction_cache
 * Requires staff authentication
 */
router.get('/api/financials/cache-stats', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const statsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as total_count,
        COUNT(DISTINCT customer_email) as unique_customers,
        MIN(created_at) as oldest_transaction,
        MAX(created_at) as newest_transaction,
        SUM(amount_cents) as total_amount_cents,
        object_type,
        source
      FROM stripe_transaction_cache
      GROUP BY object_type, source
      ORDER BY object_type, source
    `);
    
    const totalResult = await db.execute(sql`
      SELECT 
        COUNT(*) as total_count,
        COUNT(DISTINCT customer_email) as unique_customers,
        MIN(created_at) as oldest_transaction,
        MAX(created_at) as newest_transaction
      FROM stripe_transaction_cache
    `);
    
    res.json({
      success: true,
      overall: totalResult.rows[0],
      byTypeAndSource: statsResult.rows
    });
  } catch (error: unknown) {
    logger.error('[Financials] Error fetching cache stats', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cache stats'
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
    
    try {
      const account = await stripe.accounts.retrieve();
      logger.info('[Financials] Stripe account', { extra: { accountId: account.id } });
    } catch (e: unknown) {
      logger.info('[Financials] Could not get account info', { extra: { e: getErrorMessage(e) } });
    }
    
    const statusFilter = status && typeof status === 'string' && status !== 'all' 
      ? status as Stripe.Subscription.Status
      : 'all';
    
    const pageLimit = Math.min(Math.max(parseInt(limit as string) || 50, 1), 100);
    
    const listParams: Stripe.SubscriptionListParams = {
      limit: pageLimit,
      expand: ['data.customer', 'data.items.data.price'],
      status: statusFilter,
    };
    
    if (starting_after && typeof starting_after === 'string') {
      listParams.starting_after = starting_after;
    }
    
    logger.info('[Financials] Fetching subscriptions with params:', { extra: { listParams } });
    const globalSubscriptions = await stripe.subscriptions.list(listParams);
    logger.info('[Financials] Found subscriptions from global list', { extra: { globalSubscriptionsDataLength: globalSubscriptions.data.length } });
    
    const seenSubIds = new Set<string>(globalSubscriptions.data.map(s => s.id));
    const allSubs: Stripe.Subscription[] = [...globalSubscriptions.data];
    
    const additionalSubs: Stripe.Subscription[] = [];
    
    if (globalSubscriptions.data.length === 0) {
      logger.info('[Financials] No subscriptions in global list - scanning database customers (for test clock support)...');
      
      const dbResult = await db.execute(sql`
        SELECT DISTINCT email, stripe_customer_id, first_name, last_name 
        FROM users 
        WHERE stripe_customer_id IS NOT NULL 
        AND stripe_customer_id != ''
        AND billing_provider = 'stripe'
        LIMIT 100
      `);
      
      logger.info('[Financials] Found Stripe-billed customers in database', { extra: { dbResultRowsLength: dbResult.rows.length } });
      
      const uniqueCustomers = new Map<string, Record<string, unknown>>();
      for (const row of dbResult.rows as Record<string, unknown>[]) {
        if (!uniqueCustomers.has(row.stripe_customer_id as string)) {
          uniqueCustomers.set(row.stripe_customer_id as string, row);
        }
      }
      
      const CONCURRENCY_LIMIT = 5;
      const customerArray = Array.from(uniqueCustomers.values());
      
      for (let i = 0; i < customerArray.length; i += CONCURRENCY_LIMIT) {
        const batch = customerArray.slice(i, i + CONCURRENCY_LIMIT);
        const batchResults = await Promise.allSettled(
          batch.map(async (row) => {
            const custSubs = await stripe.subscriptions.list({ 
              customer: row.stripe_customer_id as string, 
              status: statusFilter,
              limit: 100,
              expand: ['data.items.data.price', 'data.customer']
            });
            return { subs: custSubs.data, row };
          })
        );
        
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            for (const sub of result.value.subs) {
              if (seenSubIds.has(sub.id)) continue;
              seenSubIds.add(sub.id);
              
              const row = result.value.row;
              if (typeof sub.customer === 'string') {
                (sub as unknown as Record<string, unknown>).customer = {
                  id: row.stripe_customer_id,
                  email: row.email,
                  name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email,
                };
              }
              additionalSubs.push(sub);
            }
          } else {
            const error = result.reason as Error;
            logger.info('[Financials] Error fetching subs', { extra: { error: getErrorMessage(error) } });
          }
        }
        
        if (i + CONCURRENCY_LIMIT < customerArray.length) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      
      logger.info('[Financials] Scanned database customers, found additional subscriptions', { extra: { uniqueCustomersSize: uniqueCustomers.size, additionalSubsLength: additionalSubs.length } });
    }
    
    allSubs.push(...additionalSubs);
    const subscriptions = { data: allSubs, has_more: globalSubscriptions.has_more, object: 'list' as const, url: '' };

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
        currentPeriodEnd: (sub as any).current_period_end,
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
  } catch (error: unknown) {
    logger.error('[Financials] Error fetching subscriptions', { error: error instanceof Error ? error : new Error(String(error)) });
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

    const subscription = await stripe.subscriptions.retrieve(subscriptionId as string, {
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
      dueDate: new Date((subscription as any).current_period_end * 1000).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/Los_Angeles',
      }),
    });

    if (result.success) {
      logger.info('[Financials] Sent payment reminder to for subscription', { extra: { customerEmail: customer.email, subscriptionId } });
      res.json({ success: true, message: 'Reminder sent successfully' });
    } else {
      res.status(500).json({ success: false, error: result.error || 'Failed to send reminder' });
    }
  } catch (error: unknown) {
    logger.error('[Financials] Error sending subscription reminder', { error: error instanceof Error ? error : new Error(String(error)) });
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
  } catch (error: unknown) {
    logger.error('[Financials] Error fetching invoices', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch invoices',
    });
  }
});

export default router;
