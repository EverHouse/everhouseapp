import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import Stripe from 'stripe';

interface StripeChargeExpanded extends Stripe.Charge {
  invoice: string | { id: string } | null;
}

import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { passRedemptionLogs, dayPassPurchases, users } from '../../../shared/schema';
import { eq, gte, desc, inArray, sql } from 'drizzle-orm';
import { getTodayPacific, getPacificMidnightUTC } from '../../utils/dateUtils';
import { getStripeClient } from '../../core/stripe/client';
import {
  getRefundablePayments,
  getFailedPayments,
  getPendingAuthorizations,
} from '../../core/stripe/paymentRepository';
import { logFromRequest } from '../../core/auditLog';
import { getStaffInfo } from './helpers';

interface _DbMemberRow {
  id: string;
  email: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  stripe_customer_id?: string;
  hubspot_id?: string;
  membership_tier?: string;
  membership_status?: string;
  tier?: string;
  membership_minutes?: number;
  billing_provider?: string;
}

interface DbOfflinePaymentRow {
  payment_method: string;
  category: string;
  amount_cents: number;
}

const router = Router();

router.get('/api/stripe/payments/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const email = decodeURIComponent(req.params.email as string).trim().toLowerCase();

    const { staffEmail } = getStaffInfo(req);
    logFromRequest(req, {
      action: 'staff_view_member_payments',
      resourceType: 'payments',
      resourceId: email,
      resourceName: email,
      details: { viewedBy: staffEmail, targetEmail: email }
    });

    const [stripeResult, legacyResult] = await Promise.all([
      db.execute(sql`SELECT 
        spi.id,
        spi.stripe_payment_intent_id,
        spi.amount_cents,
        spi.purpose,
        spi.booking_id,
        spi.description,
        spi.status,
        spi.product_id,
        spi.product_name,
        spi.created_at
       FROM stripe_payment_intents spi
       JOIN users u ON u.id = spi.user_id
       WHERE LOWER(u.email) = ${email.toLowerCase()}
       ORDER BY spi.created_at DESC
       LIMIT 50`),
      db.execute(sql`SELECT 
        lp.id,
        lp.item_name,
        lp.item_category,
        lp.item_total_cents,
        lp.quantity,
        lp.sale_date,
        lp.payment_method,
        lp.is_comp
       FROM legacy_purchases lp
       WHERE LOWER(lp.member_email) = ${email.toLowerCase()}
       ORDER BY lp.sale_date DESC
       LIMIT 200`),
    ]);

    const stripePayments = (stripeResult.rows as Array<{ id: number; stripe_payment_intent_id: string; amount_cents: number; purpose: string; booking_id: number | null; description: string; status: string; product_id: string | null; product_name: string | null; created_at: string }>).map((row) => ({
      id: row.id,
      stripePaymentIntentId: row.stripe_payment_intent_id,
      amountCents: row.amount_cents,
      amount: row.amount_cents,
      purpose: row.purpose,
      bookingId: row.booking_id,
      description: row.description,
      status: row.status,
      productId: row.product_id,
      productName: row.product_name,
      product_name: row.product_name,
      createdAt: row.created_at,
      created_at: row.created_at,
      date: row.created_at,
      type: 'stripe',
      source: 'Stripe',
    }));

    const legacyPayments = (legacyResult.rows as Array<Record<string, unknown>>).map((row) => ({
      id: `legacy-${row.id}`,
      description: row.item_name as string,
      amount: row.item_total_cents as number,
      amountCents: row.item_total_cents as number,
      status: (row.is_comp as boolean) ? 'comp' : 'paid',
      date: row.sale_date as string,
      created_at: row.sale_date as string,
      createdAt: row.sale_date as string,
      type: 'legacy',
      source: 'Mindbody',
      product_name: row.item_name as string,
      purpose: (row.item_category as string) || 'other',
      quantity: (row.quantity as number) > 1 ? (row.quantity as number) : undefined,
    }));

    const allPayments = [...stripePayments, ...legacyPayments]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({ payments: allPayments });
  } catch (error: unknown) {
    logger.error('[Stripe] Error fetching payments', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

router.get('/api/stripe/transactions/today', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();

    const startOfDay = getPacificMidnightUTC();

    const startTs = Math.floor(startOfDay.getTime() / 1000);
    const [paymentIntents, charges, passRedemptions] = await Promise.all([
      stripe.paymentIntents.list({
        created: { gte: startTs },
        limit: 100,
        expand: ['data.customer', 'data.latest_charge'],
      }),
      stripe.charges.list({
        created: { gte: startTs },
        limit: 100,
        expand: ['data.customer'],
      }),
      db.select({
        id: passRedemptionLogs.id,
        purchaseId: passRedemptionLogs.purchaseId,
        redeemedAt: passRedemptionLogs.redeemedAt,
        redeemedBy: passRedemptionLogs.redeemedBy,
        purchaserEmail: dayPassPurchases.purchaserEmail,
        purchaserFirstName: dayPassPurchases.purchaserFirstName,
        purchaserLastName: dayPassPurchases.purchaserLastName,
        productType: dayPassPurchases.productType,
      })
        .from(passRedemptionLogs)
        .innerJoin(dayPassPurchases, eq(passRedemptionLogs.purchaseId, dayPassPurchases.id))
        .where(gte(passRedemptionLogs.redeemedAt, startOfDay))
        .orderBy(desc(passRedemptionLogs.redeemedAt))
        .limit(20)
    ]);

    const getPaymentEmail = (pi: Stripe.PaymentIntent): string => {
      if (pi.metadata?.memberEmail) return pi.metadata.memberEmail;
      if (pi.metadata?.email) return pi.metadata.email;
      if (pi.receipt_email) return pi.receipt_email;
      if (typeof pi.customer === 'object' && pi.customer && !('deleted' in pi.customer) && pi.customer?.email) return pi.customer.email;
      return '';
    };

    const getCustomerName = (pi: Stripe.PaymentIntent): string | undefined => {
      if (pi.metadata?.memberName) return pi.metadata.memberName;
      if (typeof pi.customer === 'object' && pi.customer && !('deleted' in pi.customer) && pi.customer?.name) return pi.customer.name;
      return undefined;
    };

    const chargeEmails = charges.data
      .map(ch => ch.billing_details?.email || (typeof ch.customer === 'object' && ch.customer && !('deleted' in ch.customer) ? ch.customer.email : null))
      .filter((e): e is string => !!e);

    const emails = [
      ...paymentIntents.data.map(getPaymentEmail).filter((e): e is string => !!e),
      ...chargeEmails
    ];
    const uniqueEmails = [...new Set(emails)];
    
    const memberNameMap = new Map<string, string>();
    if (uniqueEmails.length > 0) {
      const memberResults = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(inArray(users.email, uniqueEmails));
      for (const m of memberResults) {
        if (m.email) {
          const name = [m.firstName, m.lastName].filter(Boolean).join(' ');
          memberNameMap.set(m.email.toLowerCase(), name || m.email);
        }
      }
    }

    const piIds = new Set(paymentIntents.data.map(pi => pi.id));

    const stripeTransactions = paymentIntents.data
      .filter(pi => {
        if (pi.status !== 'succeeded' && pi.status !== 'processing') return false;
        const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        if (charge && charge.refunded) return false;
        return true;
      })
      .map(pi => {
        const email = getPaymentEmail(pi);
        const stripeName = getCustomerName(pi);
        const dbName = email ? memberNameMap.get(email.toLowerCase()) : undefined;
        return {
          id: pi.id,
          amount: pi.amount,
          status: pi.status,
          description: pi.description || pi.metadata?.purpose || 'Payment',
          memberEmail: email,
          memberName: dbName || stripeName || email || 'Unknown',
          createdAt: new Date(pi.created * 1000).toISOString(),
          type: pi.metadata?.purpose || 'payment'
        };
      });

    const chargeTransactions = charges.data
      .filter(ch => ch.paid && !ch.refunded && !(ch.payment_intent && piIds.has(ch.payment_intent as string)))
      .map(ch => {
        const email = ch.billing_details?.email || (typeof ch.customer === 'object' && ch.customer && !('deleted' in ch.customer) ? ch.customer.email : '') || '';
        const stripeName = (typeof ch.customer === 'object' && ch.customer && !('deleted' in ch.customer) ? ch.customer.name : undefined) || ch.billing_details?.name || undefined;
        const dbName = email ? memberNameMap.get(email.toLowerCase()) : undefined;
        const piId = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
        return {
          id: piId || ch.id,
          amount: ch.amount,
          status: 'succeeded' as const,
          description: ch.description || 'Payment',
          memberEmail: email,
          memberName: dbName || stripeName || email || 'Unknown',
          createdAt: new Date(ch.created * 1000).toISOString(),
          type: 'payment'
        };
      });

    const passRedemptionTransactions = passRedemptions.map(pr => {
      const guestName = [pr.purchaserFirstName, pr.purchaserLastName].filter(Boolean).join(' ') || 'Guest';
      const productLabel = pr.productType
        ?.split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ')
        .replace(/day pass/i, 'Day Pass') || 'Day Pass';
      return {
        id: `pass-redemption-${pr.id}`,
        amount: 0,
        status: 'succeeded',
        description: `${productLabel} Redeemed`,
        memberEmail: pr.purchaserEmail || '',
        memberName: guestName,
        createdAt: pr.redeemedAt?.toISOString() || new Date().toISOString(),
        type: 'day_pass_redemption'
      };
    });

    const allTransactions = [...stripeTransactions, ...chargeTransactions, ...passRedemptionTransactions]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(allTransactions);
  } catch (error: unknown) {
    logger.error('[Stripe] Error fetching today transactions', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

router.get('/api/payments/refundable', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const payments = await getRefundablePayments();
    res.json(payments);
  } catch (error: unknown) {
    logger.error('[Payments] Error fetching refundable payments', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch refundable payments' });
  }
});

router.get('/api/payments/refunded', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { getRefundedPayments } = await import('../../core/stripe/paymentRepository');
    const payments = await getRefundedPayments();
    res.json(payments);
  } catch (error: unknown) {
    logger.error('[Payments] Error fetching refunded payments', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch refunded payments' });
  }
});

router.get('/api/payments/failed', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const payments = await getFailedPayments();
    res.json(payments);
  } catch (error: unknown) {
    logger.error('[Payments] Error fetching failed payments', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch failed payments' });
  }
});

router.get('/api/payments/pending-authorizations', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const authorizations = await getPendingAuthorizations();
    res.json(authorizations);
  } catch (error: unknown) {
    logger.error('[Payments] Error fetching pending authorizations', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch pending authorizations' });
  }
});

router.get('/api/payments/daily-summary', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const today = getTodayPacific();
    const stripe = await getStripeClient();
    
    const startOfDay = Math.floor(getPacificMidnightUTC().getTime() / 1000);
    const endOfDay = startOfDay + 86400;
    
    const allPaymentIntents: Stripe.PaymentIntent[] = [];
    let piHasMore = true;
    let piStartingAfter: string | undefined;
    
    while (piHasMore && allPaymentIntents.length < 5000) {
      const page = await stripe.paymentIntents.list({
        created: { gte: startOfDay, lt: endOfDay },
        limit: 100,
        expand: ['data.latest_charge'],
        ...(piStartingAfter && { starting_after: piStartingAfter })
      });
      allPaymentIntents.push(...page.data);
      piHasMore = page.has_more;
      if (page.data.length > 0) {
        piStartingAfter = page.data[page.data.length - 1].id;
      }
    }
    
    const allCharges: Stripe.Charge[] = [];
    let chHasMore = true;
    let chStartingAfter: string | undefined;
    
    while (chHasMore && allCharges.length < 5000) {
      const page = await stripe.charges.list({
        created: { gte: startOfDay, lt: endOfDay },
        limit: 100,
        ...(chStartingAfter && { starting_after: chStartingAfter })
      });
      allCharges.push(...page.data);
      chHasMore = page.has_more;
      if (page.data.length > 0) {
        chStartingAfter = page.data[page.data.length - 1].id;
      }
    }
    
    logger.info('[Daily Summary] Fetched PaymentIntents and Charges for', { extra: { allPaymentIntentsLength: allPaymentIntents.length, allChargesLength: allCharges.length, today } });

    const breakdown: Record<string, number> = {
      bookingFee: 0,
      guestFee: 0,
      overage: 0,
      merchandise: 0,
      membership: 0,
      cash: 0,
      check: 0,
      other: 0
    };

    let transactionCount = 0;
    const processedIds = new Set<string>();

    const categorizePurpose = (purpose: string, description?: string | null): string => {
      if (purpose === 'guest_fee') return 'guestFee';
      if (purpose === 'overage_fee') return 'overage';
      if (purpose === 'one_time_purchase') return 'merchandise';
      if (purpose === 'booking_fee' || purpose === 'booking_payment' || purpose === 'prepayment') return 'bookingFee';
      if (purpose === 'membership_renewal' || purpose === 'membership') return 'membership';
      const desc = (description || '').toLowerCase();
      if (desc.includes('subscription') || desc.includes('membership')) return 'membership';
      if (desc.includes('booking') || desc.includes('simulator') || desc.includes('bay')) return 'bookingFee';
      if (desc.includes('guest')) return 'guestFee';
      if (desc.includes('overage')) return 'overage';
      return 'other';
    };

    const piIdsForLookup = allPaymentIntents
      .filter(pi => pi.status === 'succeeded')
      .map(pi => pi.id);
    const localPurposeMap = new Map<string, string>();
    if (piIdsForLookup.length > 0) {
      const localRows = await db.execute(sql`SELECT stripe_payment_intent_id, purpose FROM stripe_payment_intents WHERE stripe_payment_intent_id = ANY(${piIdsForLookup})`);
      for (const row of localRows.rows as unknown as { stripe_payment_intent_id: string; purpose: string }[]) {
        if (row.purpose) localPurposeMap.set(row.stripe_payment_intent_id, row.purpose);
      }
    }

    for (const pi of allPaymentIntents) {
      if (pi.status !== 'succeeded') continue;
      const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
      if (charge && charge.refunded) continue;
      processedIds.add(pi.id);
      
      const purpose = pi.metadata?.purpose || localPurposeMap.get(pi.id) || 'other';
      const cents = pi.amount || 0;
      const category = categorizePurpose(purpose, pi.description);
      
      transactionCount += 1;
      breakdown[category] += cents;
    }

    const invoiceIds = new Set<string>();
    for (const ch of allCharges) {
      if (!ch.paid || ch.refunded) continue;
      if (ch.payment_intent && processedIds.has(ch.payment_intent as string)) continue;
      
      processedIds.add(ch.id);
      const cents = ch.amount || 0;
      
      transactionCount += 1;

      const invoiceId = (ch as StripeChargeExpanded).invoice;
      if (invoiceId) invoiceIds.add(typeof invoiceId === 'string' ? invoiceId : invoiceId.id);

      if (invoiceId) {
        const desc = (ch.description || '').toLowerCase();
        if (desc.includes('subscription') || desc.includes('membership')) {
          breakdown.membership += cents;
        } else if (desc.includes('booking') || desc.includes('simulator') || desc.includes('bay') || desc.includes('guest') || desc.includes('overage')) {
          breakdown.bookingFee += cents;
        } else {
          breakdown.membership += cents;
        }
      } else {
        breakdown.other += cents;
      }
    }

    const offlineResult = await db.execute(sql`SELECT 
        details->>'paymentMethod' as payment_method,
        details->>'category' as category,
        (details->>'amountCents')::int as amount_cents
       FROM admin_audit_log
       WHERE resource_type = 'billing'
         AND action = 'offline_payment'
         AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = ${today}`);

    for (const row of offlineResult.rows as unknown as DbOfflinePaymentRow[]) {
      const method = row.payment_method || 'other';
      const category = row.category || 'other';
      const cents = row.amount_cents || 0;
      
      transactionCount += 1;

      if (method === 'cash') {
        breakdown.cash += cents;
      } else if (method === 'check') {
        breakdown.check += cents;
      } else {
        if (category === 'guest_fee') {
          breakdown.guestFee += cents;
        } else if (category === 'overage') {
          breakdown.overage += cents;
        } else if (category === 'merchandise') {
          breakdown.merchandise += cents;
        } else if (category === 'membership') {
          breakdown.membership += cents;
        } else {
          breakdown.other += cents;
        }
      }
    }

    const totalCollected = Object.values(breakdown).reduce((sum, val) => sum + val, 0);

    res.json({
      date: today,
      totalCollected,
      breakdown,
      transactionCount
    });
  } catch (error: unknown) {
    logger.error('[Payments] Error getting daily summary', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get daily summary' });
  }
});

export default router;
