import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isExpandedProduct } from '../../types/stripe-helpers';
import { getStripeClient } from '../../core/stripe/client';
import { listCustomerPaymentMethods } from '../../core/stripe/customers';
import {
  createPaymentIntent,
  confirmPaymentSuccess,
  getPaymentIntentStatus,
  cancelPaymentIntent,
  getOrCreateStripeCustomer,
  type BookingFeeLineItem
} from '../../core/stripe';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants, getEffectivePlayerCount } from '../../core/billing/unifiedFeeService';
import {
  getPaymentByIntentId,
} from '../../core/stripe/paymentRepository';
import { logFromRequest } from '../../core/auditLog';
import { getStaffInfo, SAVED_CARD_APPROVAL_THRESHOLD_CENTS } from './helpers';
import { broadcastBillingUpdate, broadcastBookingInvoiceUpdate } from '../../core/websocket';
import { alertOnExternalServiceError } from '../../core/errorAlerts';
import { getErrorMessage, getErrorCode, safeErrorDetail } from '../../utils/errorUtils';
import { toIntArrayLiteral } from '../../utils/sqlArrayLiteral';
import { getBookingInvoiceId, finalizeAndPayInvoice, createDraftInvoiceForBooking, finalizeInvoicePaidOutOfBand, buildInvoiceDescription } from '../../core/billing/bookingInvoiceService';
import { validateBody } from '../../middleware/validate';
import { createPaymentIntentSchema, markBookingPaidSchema, confirmPaymentSchema, cancelPaymentIntentSchema, createCustomerSchema, chargeSavedCardSchema } from '../../../shared/validators/payments';

interface DbMemberRow {
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

interface DbParticipantRow {
  id: number;
  session_id: number;
  cached_fee_cents: number;
  payment_status: string;
  participant_type: string;
  display_name: string;
  booking_id: number;
  trackman_booking_id?: string;
}

interface StripeError extends Error {
  type?: string;
  decline_code?: string;
  code?: string;
}

const router = Router();

router.get('/api/stripe/prices/recurring', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    
    const prices = await stripe.prices.list({
      active: true,
      type: 'recurring',
      expand: ['data.product'],
      limit: 100
    });
    
    const formattedPrices = prices.data.map(price => {
      const product = price.product;
      const productName = isExpandedProduct(product) ? product.name : 'Unknown Product';
      const amountDollars = (price.unit_amount || 0) / 100;
      const interval = price.recurring?.interval || 'month';
      
      return {
        id: price.id,
        productId: isExpandedProduct(product) ? product.id : (typeof product === 'string' ? product : 'unknown'),
        productName,
        nickname: price.nickname || null,
        amount: amountDollars,
        amountCents: price.unit_amount || 0,
        currency: price.currency,
        interval,
        displayString: `$${amountDollars}/${interval} - ${price.nickname || productName}`
      };
    });
    
    res.json({ prices: formattedPrices });
  } catch (error: unknown) {
    logger.error('[Stripe] Error fetching recurring prices', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch Stripe prices' });
  }
});

router.post('/api/stripe/create-payment-intent', isStaffOrAdmin, validateBody(createPaymentIntentSchema), async (req: Request, res: Response) => {
  try {
    const { 
      userId, 
      email, 
      memberName, 
      amountCents, 
      purpose, 
      bookingId, 
      sessionId, 
      description,
      participantFees
    } = req.body;

    let finalDescription = description;
    let trackmanId: unknown = null;
    if (bookingId) {
      const trackmanLookup = await db.execute(sql`SELECT trackman_booking_id FROM booking_requests WHERE id = ${bookingId}`);
      trackmanId = (trackmanLookup.rows[0] as { trackman_booking_id?: string })?.trackman_booking_id;
      finalDescription = await buildInvoiceDescription(bookingId, (trackmanId as string) || null);
    }
    
    let resolvedUserId = userId || '';
    if (!resolvedUserId && email) {
      const { resolveUserByEmail } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(email);
      if (resolved) {
        resolvedUserId = resolved.userId;
      }
    }

    let snapshotId: number | null = null;
    const serverFees: Array<{id: number; amountCents: number}> = [];
    let serverTotal = Math.round(amountCents);
    let pendingFees: Array<{ participantId?: number; displayName: string; participantType: string; overageCents: number; guestCents: number; totalCents: number }> = [];
    const isBookingPayment = bookingId && sessionId && participantFees && Array.isArray(participantFees) && participantFees.length > 0;

    if (isBookingPayment) {
      const sessionCheck = await db.execute(sql`SELECT bs.id FROM booking_sessions bs
         JOIN booking_requests br ON br.session_id = bs.id
         WHERE bs.id = ${sessionId} AND br.id = ${bookingId}`);
      if (sessionCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid session/booking combination' });
      }

      const existingSucceeded = await db.execute(sql`SELECT spi.stripe_payment_intent_id, spi.amount_cents
         FROM stripe_payment_intents spi
         WHERE spi.booking_id = ${bookingId} AND spi.session_id = ${sessionId} AND spi.status = 'succeeded'
         ORDER BY spi.created_at DESC LIMIT 1`);
      if (existingSucceeded.rows.length > 0) {
        const succeededPi = existingSucceeded.rows[0] as { stripe_payment_intent_id: string; amount_cents: number };
        logger.info('[Stripe] Booking already has succeeded payment, preventing double charge', {
          extra: { bookingId, sessionId, existingPiId: succeededPi.stripe_payment_intent_id }
        });
        return res.status(200).json({
          alreadyPaid: true,
          message: 'Payment already completed',
          paymentIntentId: succeededPi.stripe_payment_intent_id
        });
      }

      const existingPendingSnapshot = await db.execute(sql`SELECT bfs.id, bfs.stripe_payment_intent_id, spi.status as pi_status
         FROM booking_fee_snapshots bfs
         LEFT JOIN stripe_payment_intents spi ON bfs.stripe_payment_intent_id = spi.stripe_payment_intent_id
         WHERE bfs.booking_id = ${bookingId} AND bfs.status = 'pending'
         ORDER BY bfs.created_at DESC
         LIMIT 1`);
      
      if (existingPendingSnapshot.rows.length > 0) {
        const existing = existingPendingSnapshot.rows[0] as { id: number; stripe_payment_intent_id: string | null; pi_status: string | null };
        if (existing.stripe_payment_intent_id) {
          try {
            const stripe = await getStripeClient();
            const pi = await stripe.paymentIntents.retrieve(existing.stripe_payment_intent_id as string);
            if (pi.status === 'succeeded') {
              await confirmPaymentSuccess(existing.stripe_payment_intent_id as string, 'system', 'Auto-sync');
              return res.status(200).json({ 
                alreadyPaid: true,
                message: 'Payment already completed' 
              });
            } else if (pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation') {
              if (pi.amount !== Math.round(amountCents)) {
                logger.warn('[Stripe] Stale payment intent : PI amount != requested , cancelling and creating new one', { extra: { existingStripe_payment_intent_id: existing.stripe_payment_intent_id, piAmount: pi.amount, MathRound_amountCents: Math.round(amountCents) } });
                try {
                  await cancelPaymentIntent(existing.stripe_payment_intent_id as string);
                } catch (cancelErr: unknown) {
                  logger.warn('[Stripe] Failed to cancel stale payment intent', { extra: { cancelErr } });
                }
                await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${existing.id}`);
              } else {
                logger.info('[Stripe] Reusing existing payment intent', { extra: { existingStripe_payment_intent_id: existing.stripe_payment_intent_id } });
                return res.json({ 
                  clientSecret: pi.client_secret, 
                  paymentIntentId: pi.id,
                  reused: true
                });
              }
            }
          } catch (_err: unknown) {
            logger.warn('[Stripe] Failed to check existing payment intent, creating new one');
          }
        }
      }

      const requestedIds: number[] = participantFees.map((pf: { id: number }) => pf.id);

      const participantCountResult = await db.execute(sql`SELECT COUNT(*) as count FROM booking_participants WHERE session_id = ${sessionId}`);
      const actualParticipantCount = parseInt((participantCountResult.rows[0] as { count: string })?.count || '1', 10);
      const effectivePlayerCount = getEffectivePlayerCount(actualParticipantCount, actualParticipantCount);

      let feeBreakdown;
      try {
        feeBreakdown = await computeFeeBreakdown({
          sessionId,
          declaredPlayerCount: effectivePlayerCount,
          source: 'stripe' as const
        });
        await applyFeeBreakdownToParticipants(sessionId, feeBreakdown);
        logger.info('[Stripe] Applied unified fees for session : $', { extra: { sessionId, feeBreakdownTotalsTotalCents_100_ToFixed_2: (feeBreakdown.totals.totalCents/100).toFixed(2) } });
      } catch (unifiedError: unknown) {
        logger.error('[Stripe] Unified fee service error', { extra: { unifiedError } });
        return res.status(500).json({ error: 'Failed to calculate fees' });
      }

      pendingFees = feeBreakdown.participants.filter(p => 
        p.participantId && requestedIds.includes(p.participantId) && p.totalCents > 0
      );
      
      if (pendingFees.length === 0) {
        return res.status(400).json({ error: 'No valid pending participants with fees to charge' });
      }
      
      for (const fee of pendingFees) {
        serverFees.push({ id: fee.participantId!, amountCents: fee.totalCents });
      }
      
      logger.info('[Stripe] Calculated authoritative fees using unified service', { extra: { pendingFeesLength: pendingFees.length } });

      serverTotal = serverFees.reduce((sum, f) => sum + f.amountCents, 0);
      
      if (serverTotal < 50) {
        return res.status(400).json({ error: 'Total amount must be at least $0.50' });
      }

      logger.info('[Stripe] Using authoritative cached fees from DB, total: $', { extra: { serverTotal_100_ToFixed_2: (serverTotal/100).toFixed(2) } });
      if (Math.abs(serverTotal - amountCents) > 1) {
        logger.warn('[Stripe] Client total mismatch: client=, server= - using server total', { extra: { amountCents, serverTotal } });
      }

      const snapshotResult = await db.execute(sql`INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
           VALUES (${bookingId}, ${sessionId}, ${JSON.stringify(serverFees)}, ${serverTotal}, 'pending') RETURNING id`);
      snapshotId = (snapshotResult.rows[0] as { id: number }).id;
      logger.info('[Stripe] Created fee snapshot for booking : $ with participants', { extra: { snapshotId, bookingId, serverTotal_100_ToFixed_2: (serverTotal/100).toFixed(2), serverFeesLength: serverFees.length } });
    } else {
      if (serverTotal < 50) {
        return res.status(400).json({ error: 'Amount must be at least $0.50' });
      }
      logger.info('[Stripe] Non-booking payment: $ for', { extra: { serverTotal_100_ToFixed_2: (serverTotal/100).toFixed(2), purpose } });
    }

    const metadata: Record<string, string> = {};
    if (snapshotId) {
      metadata.feeSnapshotId = snapshotId.toString();
    }
    if (serverFees.length > 0) {
      metadata.participantCount = serverFees.length.toString();
      const participantIds = serverFees.map(f => f.id).join(',');
      metadata.participantIds = participantIds.length > 490 ? participantIds.substring(0, 490) + '...' : participantIds;
    }
    if (trackmanId) {
      metadata.trackmanBookingId = String(trackmanId);
    }
    
    if (isBookingPayment) {
      const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(resolvedUserId, email, memberName || email.split('@')[0]);

      const participantIdsLiteral = toIntArrayLiteral(serverFees.map(f => f.id));
      const participantDetails = await db.execute(sql`SELECT id, display_name, participant_type FROM booking_participants WHERE id = ANY(${participantIdsLiteral}::int[])`);

      const feeLineItems: BookingFeeLineItem[] = [];
      for (const rawDetail of participantDetails.rows as Array<{ id: number; display_name: string; participant_type: string }>) {
        const fee = pendingFees.find(f => f.participantId === rawDetail.id);
        if (!fee || fee.totalCents <= 0) continue;
        feeLineItems.push({
          participantId: rawDetail.id,
          displayName: rawDetail.display_name || (rawDetail.participant_type === 'guest' ? 'Guest' : 'Member'),
          participantType: rawDetail.participant_type as 'owner' | 'member' | 'guest',
          overageCents: fee.overageCents || 0,
          guestCents: fee.guestCents || 0,
          totalCents: fee.totalCents,
        });
      }

      let invoiceResult;
      try {
        const existingInvoiceId = await getBookingInvoiceId(bookingId);
        if (existingInvoiceId) {
          invoiceResult = await finalizeAndPayInvoice({ bookingId });
        } else {
          await createDraftInvoiceForBooking({
            customerId: stripeCustomerId,
            bookingId,
            sessionId,
            trackmanBookingId: trackmanId ? String(trackmanId) : null,
            feeLineItems,
            metadata,
            purpose: 'booking_fee',
          });
          invoiceResult = await finalizeAndPayInvoice({ bookingId });
        }
      } catch (stripeErr: unknown) {
        if (snapshotId) {
          await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${snapshotId}`);
          logger.info('[Stripe] Deleted orphaned snapshot after invoice creation failed', { extra: { snapshotId } });
        }
        throw stripeErr;
      }

      if (invoiceResult.paidInFull) {
        if (snapshotId) {
          await db.execute(sql`UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${invoiceResult.paymentIntentId}, status = 'paid' WHERE id = ${snapshotId}`);
        }

        await db.execute(sql`INSERT INTO stripe_payment_intents 
           (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
           VALUES (${resolvedUserId || email}, ${invoiceResult.paymentIntentId}, ${stripeCustomerId}, ${serverTotal}, ${purpose}, ${bookingId}, ${sessionId}, ${finalDescription}, 'succeeded')
           ON CONFLICT (stripe_payment_intent_id) DO NOTHING`);

        logFromRequest(req, 'record_charge', 'payment', invoiceResult.paymentIntentId, email, {
          amount: serverTotal,
          description: description,
          paidByCredit: true,
          invoiceId: invoiceResult.invoiceId
        });

        return res.json({
          paidInFull: true,
          balanceApplied: invoiceResult.amountFromBalance || serverTotal,
          paymentIntentId: invoiceResult.paymentIntentId,
          invoiceId: invoiceResult.invoiceId,
          hostedInvoiceUrl: invoiceResult.hostedInvoiceUrl || null,
          invoicePdf: invoiceResult.invoicePdf || null,
          feeLineItems: feeLineItems.map(li => ({
            participantId: li.participantId,
            displayName: li.displayName,
            participantType: li.participantType,
            overageCents: li.overageCents,
            guestCents: li.guestCents,
            totalCents: li.totalCents,
          })),
        });
      }

      if (snapshotId) {
        await db.execute(sql`UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${invoiceResult.paymentIntentId} WHERE id = ${snapshotId}`);
      }

      await db.execute(sql`INSERT INTO stripe_payment_intents 
         (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
         VALUES (${resolvedUserId || email}, ${invoiceResult.paymentIntentId}, ${stripeCustomerId}, ${serverTotal}, ${purpose}, ${bookingId}, ${sessionId}, ${finalDescription}, 'pending')
         ON CONFLICT (stripe_payment_intent_id) DO NOTHING`);

      logFromRequest(req, 'record_charge', 'payment', invoiceResult.paymentIntentId, email, {
        amount: serverTotal,
        description: description,
        invoiceId: invoiceResult.invoiceId
      });
      
      return res.json({
        paymentIntentId: invoiceResult.paymentIntentId,
        clientSecret: invoiceResult.clientSecret,
        customerId: stripeCustomerId,
        invoiceId: invoiceResult.invoiceId,
        paidInFull: false,
        balanceApplied: 0,
        remainingCents: serverTotal,
        hostedInvoiceUrl: invoiceResult.hostedInvoiceUrl || null,
        invoicePdf: invoiceResult.invoicePdf || null,
        feeLineItems: feeLineItems.map(li => ({
          participantId: li.participantId,
          displayName: li.displayName,
          participantType: li.participantType,
          overageCents: li.overageCents,
          guestCents: li.guestCents,
          totalCents: li.totalCents,
        })),
      });
    }

    let result;
    try {
      result = await createPaymentIntent({
        userId: resolvedUserId,
        email,
        memberName: memberName || email.split('@')[0],
        amountCents: serverTotal,
        purpose,
        bookingId,
        sessionId,
        description: finalDescription,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined
      });
    } catch (stripeErr: unknown) {
      if (snapshotId) {
        await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${snapshotId}`);
        logger.info('[Stripe] Deleted orphaned snapshot after PaymentIntent creation failed', { extra: { snapshotId } });
      }
      throw stripeErr;
    }

    if (snapshotId) {
      await db.execute(sql`UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${result.paymentIntentId} WHERE id = ${snapshotId}`);
    }

    logFromRequest(req, 'record_charge', 'payment', result.paymentIntentId, email, {
      amount: serverTotal,
      description: description
    });
    
    res.json({
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret,
      customerId: result.customerId
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'create payment intent');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/stripe/confirm-payment', isStaffOrAdmin, validateBody(confirmPaymentSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      staffEmail,
      staffName
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const paymentRecord = await getPaymentByIntentId(paymentIntentId);
    
    broadcastBillingUpdate({
      action: 'payment_succeeded',
      memberEmail: paymentRecord?.memberEmail || paymentRecord?.member_email || undefined,
      amount: paymentRecord?.amountCents || paymentRecord?.amount_cents
    });

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'confirm payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.get('/api/stripe/payment-intent/:id', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const status = await getPaymentIntentStatus(id as string);

    if (!status) {
      return res.status(404).json({ error: 'Payment intent not found' });
    }

    res.json(status);
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get payment intent status' });
  }
});

router.post('/api/stripe/cancel-payment', isStaffOrAdmin, validateBody(cancelPaymentIntentSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;

    const result = await cancelPaymentIntent(paymentIntentId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    try {
      const piBookingResult = await db.execute(sql`SELECT booking_id FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${paymentIntentId} AND booking_id IS NOT NULL LIMIT 1`);
      if (piBookingResult.rows.length > 0) {
        const piBookingId = (piBookingResult.rows[0] as { booking_id: number }).booking_id;
        const { voidBookingInvoice, recreateDraftInvoiceFromBooking } = await import('../../core/billing/bookingInvoiceService');
        await voidBookingInvoice(piBookingId);
        await recreateDraftInvoiceFromBooking(piBookingId);
        logger.info('[Stripe] Voided invoice and re-created draft after staff cancelled payment', { extra: { bookingId: piBookingId, paymentIntentId } });
      }
    } catch (invoiceErr: unknown) {
      logger.warn('[Stripe] Failed to void/recreate invoice after payment cancellation', { extra: { paymentIntentId, error: String(invoiceErr) } });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error canceling payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'cancel payment');
    res.status(500).json({ 
      error: 'Payment cancellation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/stripe/create-customer', isStaffOrAdmin, validateBody(createCustomerSchema), async (req: Request, res: Response) => {
  try {
    const { userId, email: rawEmail, name } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();

    const result = await getOrCreateStripeCustomer(userId, email, name);

    res.json({
      customerId: result.customerId,
      isNew: result.isNew
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating customer', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'create customer');
    res.status(500).json({ 
      error: 'Customer creation failed. Please try again.',
      retryable: true
    });
  }
});

router.get('/api/billing/members/search', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { query, includeInactive } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.json({ members: [] });
    }
    
    const searchTerm = query.trim().toLowerCase();
    const searchPattern = `%${searchTerm}%`;
    
    const inactiveFilter = includeInactive !== 'true'
      ? sql` AND (membership_status IN ('active', 'trialing', 'past_due') OR membership_status IS NULL OR stripe_subscription_id IS NOT NULL)`
      : sql``;
    
    const result = await db.execute(sql`
      SELECT 
        id, email, first_name, last_name, 
        membership_tier, membership_status, 
        stripe_customer_id, hubspot_id
      FROM users 
      WHERE (
        LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ${searchPattern}
        OR LOWER(COALESCE(first_name, '')) LIKE ${searchPattern}
        OR LOWER(COALESCE(last_name, '')) LIKE ${searchPattern}
        OR LOWER(COALESCE(email, '')) LIKE ${searchPattern}
      )${inactiveFilter} AND archived_at IS NULL ORDER BY first_name, last_name LIMIT 10
    `);
    
    const members = (result.rows as unknown as DbMemberRow[]).map((row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email?.split('@')[0] || 'Unknown',
      membershipTier: row.membership_tier,
      membershipStatus: row.membership_status,
      stripeCustomerId: row.stripe_customer_id,
      hubspotId: row.hubspot_id,
    }));
    
    res.json({ members });
  } catch (error: unknown) {
    logger.error('[Billing] Error searching members', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to search members' });
  }
});

router.post('/api/stripe/staff/charge-saved-card', isStaffOrAdmin, validateBody(chargeSavedCardSchema), async (req: Request, res: Response) => {
  try {
    const { memberEmail: rawMemberEmail, bookingId, sessionId: _sessionId, participantIds } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    const { staffEmail, staffName, sessionUser } = getStaffInfo(req);

    const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id 
       FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0] as unknown as DbMemberRow;
    const _memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

    const participantResult = await db.execute(sql`SELECT bp.id, bp.session_id, bp.cached_fee_cents, bp.payment_status, bp.participant_type, bp.display_name,
       br.id as booking_id, bs.trackman_booking_id
       FROM booking_participants bp
       JOIN booking_sessions bs ON bp.session_id = bs.id
       LEFT JOIN booking_requests br ON br.session_id = bs.id
       WHERE bp.id IN (${sql.join(participantIds.map((id: number) => sql`${id}`), sql`, `)}) AND bp.payment_status = 'pending'`);

    if (participantResult.rows.length === 0) {
      return res.status(400).json({ error: 'No pending participants found for the provided IDs' });
    }

    const foundIds = new Set((participantResult.rows as unknown as DbParticipantRow[]).map((r) => r.id));
    const missingIds = participantIds.filter((id: number) => !foundIds.has(id));
    if (missingIds.length > 0) {
      logger.info('[Stripe] Some participant IDs already paid or not found, skipping', { extra: { missingIds, providedIds: participantIds } });
    }

    if (bookingId) {
      const wrongBooking = (participantResult.rows as unknown as DbParticipantRow[]).filter((r) => r.booking_id !== bookingId);
      if (wrongBooking.length > 0) {
        return res.status(400).json({ error: 'Participant IDs do not belong to the specified booking' });
      }
    }

    const authoritativeAmountCents = (participantResult.rows as Array<{ cached_fee_cents: number }>).reduce(
      (sum: number, r) => sum + (r.cached_fee_cents || 0), 0
    );

    if (authoritativeAmountCents < 50) {
      return res.status(400).json({ error: 'Total amount too small to charge (minimum $0.50)' });
    }

    if (authoritativeAmountCents >= SAVED_CARD_APPROVAL_THRESHOLD_CENTS) {
      if (sessionUser?.role !== 'admin') {
        return res.status(403).json({
          error: 'Charges above $500 require manager approval. Please ask an admin to process this charge.',
          requiresApproval: true,
          thresholdCents: SAVED_CARD_APPROVAL_THRESHOLD_CENTS
        });
      }
      logFromRequest(req, 'large_charge_approved', 'payment', null, memberEmail, {
        amountCents: authoritativeAmountCents,
        approvedBy: staffEmail,
        role: 'admin',
        chargeType: 'saved_card'
      });
    }

    const resolvedSessionId = participantResult.rows[0].session_id;
    const resolvedBookingId = participantResult.rows[0].booking_id;

    if (resolvedBookingId) {
      const existingPaymentResult = await db.execute(sql`
        SELECT stripe_payment_intent_id, status, amount_cents 
        FROM stripe_payment_intents 
        WHERE booking_id = ${resolvedBookingId} 
        AND status = 'succeeded'
        AND purpose IN ('prepayment', 'booking_fee')
        LIMIT 1`);

      if (existingPaymentResult.rows.length > 0) {
        const existingPayment = existingPaymentResult.rows[0] as { stripe_payment_intent_id: string; status: string; amount_cents: number };
        return res.status(409).json({ 
          error: 'Payment already collected for this booking',
          existingPaymentId: existingPayment.stripe_payment_intent_id
        });
      }
    }

    if (!member.stripe_customer_id) {
      return res.status(400).json({ 
        error: 'Member does not have a Stripe account. They need to make a payment first to save their card.',
        noStripeCustomer: true
      });
    }

    const _stripe = await getStripeClient();

    const paymentMethods = await listCustomerPaymentMethods(member.stripe_customer_id);

    if (paymentMethods.length === 0) {
      return res.status(400).json({ 
        error: 'Member has no saved card on file. They need to make a payment first to save their card.',
        noSavedCard: true
      });
    }

    const paymentMethod = paymentMethods[0];
    const cardLast4 = paymentMethod.last4 || '****';
    const cardBrand = paymentMethod.brand || 'card';

    const trackmanBookingId = (participantResult.rows[0] as unknown as DbParticipantRow)?.trackman_booking_id || null;

    const feeLineItems: BookingFeeLineItem[] = [];
    for (const r of participantResult.rows as unknown as DbParticipantRow[]) {
      if ((r.cached_fee_cents || 0) <= 0) continue;
      const isGuest = r.participant_type === 'guest';
      feeLineItems.push({
        participantId: r.id,
        displayName: r.display_name || (isGuest ? 'Guest' : 'Member'),
        participantType: r.participant_type as 'owner' | 'member' | 'guest',
        overageCents: isGuest ? 0 : r.cached_fee_cents,
        guestCents: isGuest ? r.cached_fee_cents : 0,
        totalCents: r.cached_fee_cents,
      });
    }

    if (resolvedBookingId) {
      const existingIntents = await db.execute(sql`SELECT stripe_payment_intent_id, status FROM stripe_payment_intents 
         WHERE booking_id = ${resolvedBookingId} AND status NOT IN ('succeeded', 'canceled', 'refunded')`);

      for (const row of existingIntents.rows as Array<{ stripe_payment_intent_id: string; status: string }>) {
        try {
          const stripeClient = await getStripeClient();
          const livePi = await stripeClient.paymentIntents.retrieve(row.stripe_payment_intent_id);
          if (livePi.status === 'succeeded' || livePi.status === 'processing' || livePi.status === 'requires_capture') {
            logger.warn('[Stripe] Existing PI is already processing/succeeded — cannot charge again', {
              extra: { bookingId: resolvedBookingId, piId: row.stripe_payment_intent_id, liveStatus: livePi.status }
            });
            return res.status(409).json({ error: 'A payment is already being processed for this booking. Please wait or check payment history.' });
          }
          if (livePi.status !== 'canceled') {
            const livePiInvoice = (livePi as unknown as { invoice: string | { id: string } | null }).invoice;
            if (livePiInvoice) {
              logger.info('[Stripe] Stale PI is invoice-generated — skipping cancel, invoice flow will handle it', {
                extra: { bookingId: resolvedBookingId, piId: row.stripe_payment_intent_id, invoiceId: typeof livePiInvoice === 'string' ? livePiInvoice : livePiInvoice.id }
              });
            } else {
              const { cancelPaymentIntent } = await import('../../core/stripe');
              const cancelResult = await cancelPaymentIntent(row.stripe_payment_intent_id);
              if (!cancelResult.success) {
                logger.warn('[Stripe] Could not cancel stale PI — checking if booking has invoice to fall through', {
                  extra: { bookingId: resolvedBookingId, piId: row.stripe_payment_intent_id, error: cancelResult.error }
                });
                const bookingInvoice = resolvedBookingId ? await getBookingInvoiceId(Number(resolvedBookingId)) : null;
                if (!bookingInvoice) {
                  throw new Error(cancelResult.error || 'Failed to cancel stale PI');
                }
              }
            }
          } else {
            await db.execute(sql`UPDATE stripe_payment_intents SET status = 'canceled', updated_at = NOW() WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id}`);
          }
          logger.info('[Stripe] Staff charge stale PI check complete', {
            extra: { bookingId: resolvedBookingId, piId: row.stripe_payment_intent_id, oldStatus: row.status }
          });
        } catch (cancelErr: unknown) {
          logger.error('[Stripe] Could not verify/cancel stale PI — blocking charge to prevent duplicate', {
            extra: { piId: row.stripe_payment_intent_id, error: getErrorMessage(cancelErr) }
          });
          return res.status(503).json({ error: 'Could not verify existing payment status. Please try again or use a different payment method.' });
        }
      }
    }

    let invoiceResult;
    const existingInvoiceId = resolvedBookingId ? await getBookingInvoiceId(Number(resolvedBookingId)) : null;
    
    if (existingInvoiceId) {
      try {
        invoiceResult = await finalizeAndPayInvoice({
          bookingId: Number(resolvedBookingId),
          paymentMethodId: paymentMethod.id,
          offSession: true,
        });
        logger.info('[Stripe] Staff charge using existing draft invoice', {
          extra: { bookingId: resolvedBookingId, invoiceId: existingInvoiceId, paymentIntentId: invoiceResult.paymentIntentId }
        });
      } catch (draftErr: unknown) {
        logger.warn('[Stripe] Failed to use existing draft invoice, falling back to new invoice', {
          extra: { bookingId: resolvedBookingId, existingInvoiceId, error: getErrorMessage(draftErr) }
        });
        invoiceResult = null;
      }
    }
    
    if (!invoiceResult) {
      if (existingInvoiceId) {
        try {
          const stripeClient = await getStripeClient();
          const oldInvoice = await stripeClient.invoices.retrieve(existingInvoiceId);
          if (oldInvoice.status === 'open') {
            logger.info('[Stripe] Staff charge: voiding broken open invoice before fresh draft', {
              extra: { bookingId: resolvedBookingId, invoiceId: existingInvoiceId }
            });
            await stripeClient.invoices.voidInvoice(existingInvoiceId);
          }
          await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${Number(resolvedBookingId)}`);
          await db.execute(sql`UPDATE stripe_payment_intents SET status = 'canceled', updated_at = NOW()
            WHERE booking_id = ${Number(resolvedBookingId)} AND status NOT IN ('succeeded', 'canceled', 'refunded')`);
        } catch (voidErr: unknown) {
          logger.warn('[Stripe] Staff charge: could not void existing invoice, proceeding with fresh draft', {
            extra: { bookingId: resolvedBookingId, invoiceId: existingInvoiceId, error: getErrorMessage(voidErr) }
          });
          await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${Number(resolvedBookingId)}`);
        }
      }
      await createDraftInvoiceForBooking({
        customerId: member.stripe_customer_id,
        bookingId: Number(resolvedBookingId),
        sessionId: Number(resolvedSessionId),
        trackmanBookingId,
        feeLineItems,
        metadata: {
          type: 'staff_saved_card_charge',
          staffEmail,
          staffName: staffName || '',
          memberEmail: member.email,
          memberId: member.id,
          participantIds: JSON.stringify(participantIds),
        },
        purpose: 'booking_fee',
      });
      invoiceResult = await finalizeAndPayInvoice({
        bookingId: Number(resolvedBookingId),
        paymentMethodId: paymentMethod.id,
        offSession: true,
      });
    }

    let successMessage: string;

    if (invoiceResult.status === 'succeeded') {
      const chargeDescription = await buildInvoiceDescription(Number(resolvedBookingId), trackmanBookingId);

      await db.transaction(async (tx) => {
        const safeParticipantIds = (participantIds || []).filter((id: unknown) => typeof id === 'number' && Number.isFinite(id) && id > 0).map((id: number) => Math.floor(id));
        if (safeParticipantIds.length > 0) {
          await tx.execute(sql`UPDATE booking_participants 
             SET payment_status = 'paid', 
                 stripe_payment_intent_id = ${invoiceResult.paymentIntentId},
                 paid_at = NOW()
             WHERE id IN (${sql.join(safeParticipantIds.map((id: number) => sql`${id}`), sql`, `)})`);
          logger.info('[Stripe] Staff charged via invoice: $ for', { extra: { totalDollars: (authoritativeAmountCents / 100).toFixed(2), memberEmail: member.email, participantIdsLength: participantIds.length, invoiceId: invoiceResult.invoiceId } });
        }

        await tx.execute(sql`INSERT INTO stripe_payment_intents 
            (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, status, purpose, description, booking_id, session_id)
           VALUES (${member.id}, ${invoiceResult.paymentIntentId}, ${member.stripe_customer_id}, ${authoritativeAmountCents}, 'succeeded', 'booking_fee', ${chargeDescription}, ${resolvedBookingId}, ${resolvedSessionId})
           ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = 'succeeded', updated_at = NOW()`);

      });

      logFromRequest(req, 'charge_saved_card', 'payment', invoiceResult.paymentIntentId, member.email, {
        amountCents: authoritativeAmountCents,
        cardCharged: invoiceResult.amountCharged || authoritativeAmountCents,
        balanceApplied: invoiceResult.amountFromBalance || 0,
        cardLast4,
        cardBrand,
        invoiceId: invoiceResult.invoiceId,
        bookingId: resolvedBookingId,
        sessionId: resolvedSessionId,
      });

      broadcastBillingUpdate({
        action: 'payment_succeeded',
        memberEmail: member.email,
        amount: authoritativeAmountCents
      });

      const balanceApplied = invoiceResult.amountFromBalance || 0;
      const amountCharged = invoiceResult.amountCharged || authoritativeAmountCents;
      successMessage = balanceApplied > 0
        ? `Charged ${cardBrand} ending in ${cardLast4}: $${(amountCharged / 100).toFixed(2)} (credit applied: $${(balanceApplied / 100).toFixed(2)})`
        : `Charged ${cardBrand} ending in ${cardLast4}: $${(authoritativeAmountCents / 100).toFixed(2)}`;

      res.json({ 
        success: true, 
        message: successMessage,
        paymentIntentId: invoiceResult.paymentIntentId,
        invoiceId: invoiceResult.invoiceId,
        cardLast4,
        cardBrand,
        amountCharged,
        balanceApplied,
        totalAmount: authoritativeAmountCents,
        hostedInvoiceUrl: invoiceResult.hostedInvoiceUrl || null,
        invoicePdf: invoiceResult.invoicePdf || null,
        feeLineItems: feeLineItems.map(li => ({
          participantId: li.participantId,
          displayName: li.displayName,
          participantType: li.participantType,
          overageCents: li.overageCents,
          guestCents: li.guestCents,
          totalCents: li.totalCents,
        })),
      });
    } else {
      logger.warn('[Stripe] Invoice charge requires action', { extra: { invoiceStatus: invoiceResult.status, memberEmail: member.email } });
      res.status(400).json({ 
        error: `Payment requires additional verification. Please use the standard payment flow.`,
        requiresAction: true,
        status: invoiceResult.status
      });
    }
  } catch (error: unknown) {
    logger.error('[Stripe] Error charging saved card', { error: error instanceof Error ? error : new Error(String(error)) });
    
    if ((error as StripeError).type === 'StripeCardError') {
      return res.status(400).json({ 
        error: `Card declined: ${safeErrorDetail(error)}`,
        cardError: true,
        declineCode: (error as StripeError).decline_code
      });
    }
    
    if (getErrorCode(error) === 'authentication_required') {
      return res.status(400).json({ 
        error: 'Card requires authentication. Please use the standard payment flow.',
        requiresAction: true
      });
    }

    await alertOnExternalServiceError('Stripe', error as Error, 'charge saved card');
    res.status(500).json({ 
      error: 'Failed to charge card. Please try again or use another payment method.',
      retryable: true
    });
  }
});

router.post('/api/stripe/staff/mark-booking-paid', isStaffOrAdmin, validateBody(markBookingPaidSchema), async (req: Request, res: Response) => {
  try {
    const { bookingId, sessionId, participantIds, paymentMethod: paidVia } = req.body;
    const { staffEmail, staffName: _staffName } = getStaffInfo(req);

    const oobResult = await finalizeInvoicePaidOutOfBand({
      bookingId,
      paidVia: paidVia || 'cash',
    });

    if (!oobResult.success) {
      logger.warn('[Stripe] No draft invoice to mark paid, proceeding with participant updates only', {
        extra: { bookingId, error: oobResult.error }
      });
    }

    const safeParticipantIds = (participantIds || []).filter((id: unknown) => typeof id === 'number' && Number.isFinite(id) && id > 0).map((id: number) => Math.floor(id));
    if (safeParticipantIds.length > 0) {
      await db.execute(sql`UPDATE booking_participants 
         SET payment_status = 'paid', 
             paid_at = NOW(),
             updated_at = NOW(),
             cached_fee_cents = 0
         WHERE id IN (${sql.join(safeParticipantIds.map((id: number) => sql`${id}`), sql`, `)})`);
    }

    if (sessionId) {
      await db.execute(sql`UPDATE usage_ledger 
         SET payment_method = ${paidVia || 'cash'}, updated_at = NOW()
         WHERE session_id = ${sessionId}
           AND payment_method IS DISTINCT FROM 'cash'
           AND payment_method IS DISTINCT FROM 'waived'`);
      logger.info('[Stripe] Updated usage_ledger payment_method for mark-booking-paid', {
        extra: { sessionId, paidVia: paidVia || 'cash' }
      });
    }

    logFromRequest(req, 'mark_booking_paid', 'payment', oobResult.invoiceId || null, null, {
      bookingId,
      participantIds: JSON.stringify(participantIds),
      paidVia: paidVia || 'cash',
      invoiceId: oobResult.invoiceId || null,
      staffEmail,
    });

    broadcastBillingUpdate({
      action: 'payment_confirmed',
      bookingId,
      status: 'paid'
    });

    broadcastBookingInvoiceUpdate({
      bookingId,
      action: 'payment_confirmed',
      sessionId,
    });

    logger.info('[Stripe] Staff marked booking as paid', {
      extra: { bookingId, paidVia: paidVia || 'cash', participantCount: safeParticipantIds.length, invoiceId: oobResult.invoiceId }
    });

    res.json({
      success: true,
      invoiceId: oobResult.invoiceId || null,
      hostedInvoiceUrl: oobResult.hostedInvoiceUrl || null,
      invoicePdf: oobResult.invoicePdf || null,
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error marking booking as paid', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to mark booking as paid' });
  }
});

router.get('/api/payments/future-bookings-with-fees', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    interface DbFutureBookingRow {
      booking_id: number;
      user_email: string;
      user_name: string;
      request_date: string;
      start_time: string;
      end_time: string;
      session_id: number;
      status: string;
      player_count: number;
      resource_name: string;
      resource_type: string;
      tier: string;
      first_name: string;
      last_name: string;
      pending_fee_cents: string;
      pending_intent_count: string;
      guest_count: string;
    }

    const result = await db.execute(sql`SELECT 
        br.id as booking_id,
        br.user_email,
        br.user_name,
        br.request_date,
        br.start_time,
        br.end_time,
        br.session_id,
        br.status,
        br.declared_player_count as player_count,
        r.name as resource_name,
        r.type as resource_type,
        u.tier,
        u.first_name,
        u.last_name,
        COALESCE(
          (SELECT SUM(COALESCE(bp.cached_fee_cents, 0)) FROM booking_participants bp WHERE bp.session_id = br.session_id AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)),
          0
        ) as pending_fee_cents,
        (SELECT COUNT(*) FROM stripe_payment_intents spi WHERE spi.booking_id = br.id AND spi.status NOT IN ('succeeded', 'canceled')) as pending_intent_count,
        (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id AND bp.participant_type = 'guest') as guest_count
      FROM booking_requests br
      LEFT JOIN resources r ON r.id = br.resource_id
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE br.status IN ('approved', 'confirmed')
      AND br.request_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
      ORDER BY br.request_date, br.start_time
      LIMIT 50`);

    const futureBookings = (result.rows as unknown as DbFutureBookingRow[]).map((row) => {
      const totalFeeCents = parseInt(row.pending_fee_cents, 10) || 0;
      
      return {
        bookingId: row.booking_id,
        memberEmail: row.user_email,
        memberName: row.first_name && row.last_name 
          ? `${row.first_name} ${row.last_name}` 
          : row.user_name || row.user_email,
        tier: row.tier,
        date: row.request_date,
        startTime: row.start_time,
        endTime: row.end_time,
        resourceName: row.resource_name,
        status: row.status,
        playerCount: row.player_count || 1,
        guestCount: parseInt(row.guest_count, 10) || 0,
        estimatedFeeCents: totalFeeCents,
        hasPaymentIntent: parseInt(row.pending_intent_count, 10) > 0
      };
    });

    res.json(futureBookings);
  } catch (error: unknown) {
    logger.error('[Payments] Error fetching future bookings with fees', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch future bookings' });
  }
});

export default router;
