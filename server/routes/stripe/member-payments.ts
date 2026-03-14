import Stripe from 'stripe';

type StripeInvoiceExpanded = Stripe.Invoice & {
  payment_intent: string | Stripe.PaymentIntent | null;
  confirmation_secret?: { client_secret: string; type: string } | null;
  metadata: Record<string, string> | null;
};

import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../core/middleware';
import { paymentRateLimiter } from '../../middleware/rateLimiting';
import { db } from '../../db';
import { membershipTiers } from '../../../shared/schema';
import { sql, ilike } from 'drizzle-orm';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';
import { getSessionUser } from '../../types/session';
import {
  createPaymentIntent,
  confirmPaymentSuccess,
  getOrCreateStripeCustomer,
  getInvoice,
  createBalanceAwarePayment,
  type BookingFeeLineItem,
} from '../../core/stripe';
import { resolveUserByEmail } from '../../core/stripe/customers';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants } from '../../core/billing/unifiedFeeService';
import { GUEST_FEE_CENTS } from './helpers';
import { sendNotificationToUser, broadcastBillingUpdate, broadcastBookingInvoiceUpdate } from '../../core/websocket';
import { alertOnExternalServiceError } from '../../core/errorAlerts';
import { getErrorMessage } from '../../utils/errorUtils';
import { toIntArrayLiteral } from '../../utils/sqlArrayLiteral';
import { getBookingInvoiceId, createDraftInvoiceForBooking, buildInvoiceDescription } from '../../core/billing/bookingInvoiceService';
import { PRICING } from '../../core/billing/pricingConfig';

function describeFee(
  isGuest: boolean,
  overageCents: number,
  guestCents: number,
): { feeType: 'overage' | 'guest' | 'mixed'; feeDescription: string } {
  if (isGuest && guestCents > 0) {
    return { feeType: 'guest', feeDescription: 'Guest Fee' };
  }
  if (overageCents > 0 && guestCents > 0) {
    return { feeType: 'mixed', feeDescription: 'Overage Fee + Guest Fee' };
  }
  if (overageCents > 0) {
    const overageRateCents = Math.round(PRICING.OVERAGE_RATE_DOLLARS * 100);
    const blocks = Math.round(overageCents / overageRateCents);
    const mins = blocks * 30;
    const label = blocks === 1 ? `Overage Fee × 1 (${mins} min)` : `Overage Fee × ${blocks} (${mins} min)`;
    return { feeType: 'overage', feeDescription: label };
  }
  if (guestCents > 0) {
    return { feeType: 'guest', feeDescription: 'Guest Fee' };
  }
  return { feeType: 'overage', feeDescription: '' };
}

async function finalizeInvoiceWithPi(
  stripe: Stripe,
  invoiceId: string,
): Promise<{ piId: string; clientSecret: string }> {
  const finalized = await stripe.invoices.finalizeInvoice(invoiceId, {
    auto_advance: false,
    expand: ['payment_intent', 'confirmation_secret'],
  }) as unknown as StripeInvoiceExpanded;

  if (finalized.confirmation_secret?.client_secret) {
    let piId: string | undefined;
    if (finalized.payment_intent) {
      piId = typeof finalized.payment_intent === 'string' ? finalized.payment_intent : (finalized.payment_intent as Stripe.PaymentIntent).id;
    }
    if (!piId) {
      const secretMatch = finalized.confirmation_secret.client_secret.match(/^(pi_[A-Za-z0-9]+)_secret_/);
      if (secretMatch) {
        piId = secretMatch[1];
      }
    }
    if (!piId) {
      const refetched = await stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] }) as unknown as StripeInvoiceExpanded;
      if (refetched.payment_intent) {
        piId = typeof refetched.payment_intent === 'string' ? refetched.payment_intent : (refetched.payment_intent as Stripe.PaymentIntent).id;
      }
    }
    if (!piId) {
      throw new Error(`Invoice ${invoiceId} finalized with confirmation_secret but no PaymentIntent ID could be resolved`);
    }
    logger.info('[Stripe] Got client_secret via confirmation_secret', { extra: { invoiceId, piId } });
    return { piId, clientSecret: finalized.confirmation_secret.client_secret };
  }

  if (finalized.payment_intent) {
    if (typeof finalized.payment_intent === 'string') {
      const fullPi = await stripe.paymentIntents.retrieve(finalized.payment_intent);
      if (fullPi.status !== 'canceled' && fullPi.client_secret) {
        return { piId: fullPi.id, clientSecret: fullPi.client_secret };
      }
    } else {
      const pi = finalized.payment_intent as Stripe.PaymentIntent;
      if (pi.status !== 'canceled' && pi.client_secret) {
        logger.info('[Stripe] Got client_secret via expanded payment_intent', { extra: { invoiceId, piId: pi.id } });
        return { piId: pi.id, clientSecret: pi.client_secret };
      }
      if (pi.id) {
        const fullPi = await stripe.paymentIntents.retrieve(pi.id);
        if (fullPi.client_secret) {
          return { piId: fullPi.id, clientSecret: fullPi.client_secret };
        }
      }
    }
  }

  throw new Error(`Invoice ${invoiceId} has no PaymentIntent after finalization (status: ${finalized.status})`);
}

async function retrieveInvoicePaymentIntent(
  stripe: Stripe,
  invoiceId: string,
): Promise<{ piId: string; clientSecret: string }> {
  const inv = await stripe.invoices.retrieve(invoiceId, {
    expand: ['payment_intent', 'confirmation_secret'],
  }) as unknown as StripeInvoiceExpanded;

  if (inv.confirmation_secret?.client_secret) {
    let piId: string | undefined;
    if (inv.payment_intent) {
      piId = typeof inv.payment_intent === 'string' ? inv.payment_intent : (inv.payment_intent as Stripe.PaymentIntent).id;
    }
    if (!piId) {
      const secretMatch = inv.confirmation_secret.client_secret.match(/^(pi_[A-Za-z0-9]+)_secret_/);
      if (secretMatch) {
        piId = secretMatch[1];
      }
    }
    if (!piId) {
      const refetched = await stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] }) as unknown as StripeInvoiceExpanded;
      if (refetched.payment_intent) {
        piId = typeof refetched.payment_intent === 'string' ? refetched.payment_intent : (refetched.payment_intent as Stripe.PaymentIntent).id;
      }
    }
    if (!piId) {
      throw new Error(`Invoice ${invoiceId} has confirmation_secret but no PaymentIntent ID could be resolved`);
    }
    return { piId, clientSecret: inv.confirmation_secret.client_secret };
  }

  if (inv.payment_intent) {
    if (typeof inv.payment_intent === 'string') {
      const fullPi = await stripe.paymentIntents.retrieve(inv.payment_intent);
      if (fullPi.status !== 'canceled' && fullPi.client_secret) {
        return { piId: fullPi.id, clientSecret: fullPi.client_secret };
      }
    } else {
      const pi = inv.payment_intent as Stripe.PaymentIntent;
      if (pi.status !== 'canceled' && pi.client_secret) {
        return { piId: pi.id, clientSecret: pi.client_secret };
      }
      if (pi.id) {
        const fullPi = await stripe.paymentIntents.retrieve(pi.id);
        if (fullPi.status !== 'canceled' && fullPi.client_secret) {
          return { piId: fullPi.id, clientSecret: fullPi.client_secret };
        }
      }
    }
  }

  throw new Error(`Invoice ${invoiceId} has no usable PaymentIntent (status: ${inv.status})`);
}

interface BookingRow {
  id: number;
  session_id: number | null;
  user_email: string;
  user_name: string | null;
  status: string;
  trackman_booking_id: string | null;
  user_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

interface ParticipantRow {
  id: number;
  participant_type: string;
  display_name: string | null;
  cached_fee_cents: number;
}

interface SnapshotRow {
  id: number;
  participant_fees: string;
  status: string;
  stripe_payment_intent_id: string | null;
  total_cents: number;
}

interface UserRow {
  id: string;
  stripe_customer_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

interface StripeCustomerIdRow {
  stripe_customer_id: string | null;
}

interface BalanceParticipantRow {
  participant_id: number;
  session_id: number;
  participant_type: string;
  display_name: string | null;
  payment_status: string | null;
  cached_fee_cents: number;
  session_date: string;
  start_time: string;
  end_time: string;
  resource_name: string | null;
  ledger_fee: string;
  owner_email?: string;
}

interface GuestBalanceRow {
  participant_id: number;
  session_id: number;
  participant_type: string;
  display_name: string | null;
  payment_status: string | null;
  cached_fee_cents: number;
  session_date: string;
  start_time: string;
  end_time: string;
  resource_name: string | null;
  owner_email: string;
}

interface UncachedSessionRow {
  session_id: number;
}

interface SessionDataRow {
  session_date: string;
  resource_name: string | null;
  participant_type: string | null;
  display_name: string | null;
}

interface UnfilledRow {
  session_id: number;
  session_date: string;
  start_time: string;
  end_time: string;
  resource_name: string | null;
  declared_player_count: string;
  non_owner_count: string;
}

interface BalancePayParticipantRow {
  participant_id: number;
  session_id: number;
  cached_fee_cents: number;
  ledger_fee: string;
  pending_snapshot_count: string;
  total_snapshot_count: string;
}

interface BalancePayGuestRow {
  participant_id: number;
  session_id: number;
  cached_fee_cents: number;
  pending_snapshot_count: string;
  total_snapshot_count: string;
}

interface IdRow {
  id: number;
}

async function handleExistingInvoicePayment(params: {
  bookingId: number;
  sessionId: number;
  bookingEmail: string;
  serverFees: Array<{ id: number; amountCents: number }>;
  serverTotal: number;
  pendingFees: Array<{ participantId: number | null; displayName: string; totalCents: number; overageCents?: number; guestCents?: number; participantType?: string; minutesAllocated?: number }>;
  resolvedUserId: string | null;
  stripeCustomerId: string;
  trackmanId: string | null;
}): Promise<Record<string, unknown> | null> {
  const { bookingId, sessionId, bookingEmail, serverFees, serverTotal, pendingFees, resolvedUserId, stripeCustomerId, trackmanId } = params;

  const existingInvoiceId = await getBookingInvoiceId(bookingId);
  if (!existingInvoiceId) return null;

  try {
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    const existingInvoice = await stripe.invoices.retrieve(existingInvoiceId);
    if (existingInvoice.status === 'open' && existingInvoice.amount_due !== serverTotal) {
      logger.info('[Stripe] Existing open invoice amount stale, voiding and falling back to new invoice', {
        extra: { bookingId, invoiceId: existingInvoiceId, oldAmount: existingInvoice.amount_due, newAmount: serverTotal }
      });
      await stripe.invoices.voidInvoice(existingInvoiceId);
      await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
      await db.execute(sql`UPDATE stripe_payment_intents SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status = 'pending'`);
      return null;
    }

    if (existingInvoice.status === 'draft') {
      const draftTotal = existingInvoice.lines?.data?.reduce((sum: number, li: { amount: number }) => sum + li.amount, 0) ?? 0;
      if (draftTotal !== serverTotal) {
        logger.info('[Stripe] Existing draft invoice amount stale, deleting and falling back to new invoice', {
          extra: { bookingId, invoiceId: existingInvoiceId, oldAmount: draftTotal, newAmount: serverTotal }
        });
        await stripe.invoices.del(existingInvoiceId);
        await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
        await db.execute(sql`UPDATE stripe_payment_intents SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status = 'pending'`);
        return null;
      }
    }

    const participantFeesList = pendingFees.map(f => {
      const isGuest = f.participantType === 'guest';
      const { feeType, feeDescription } = describeFee(isGuest, f.overageCents || 0, f.guestCents || 0);
      return {
        id: f.participantId,
        displayName: f.displayName,
        amount: f.totalCents / 100,
        feeType,
        feeDescription,
        participantType: f.participantType || 'member',
      };
    });

    if (existingInvoice.status === 'void' || existingInvoice.status === 'uncollectible') {
      logger.info('[Stripe] Existing invoice is void/uncollectible, clearing and falling back to new invoice', {
        extra: { bookingId, invoiceId: existingInvoiceId, status: existingInvoice.status }
      });
      await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
      return null;
    }

    if (existingInvoice.status === 'paid') {
      const paidParticipantIds = pendingFees.map(f => f.participantId!).filter(Boolean);
      if (paidParticipantIds.length > 0) {
        await db.execute(sql`
          UPDATE booking_participants
           SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW(),
               cached_fee_cents = 0
           WHERE id = ANY(${toIntArrayLiteral(paidParticipantIds)}::int[])
        `);
      }
      return {
        paidInFull: true,
        invoiceId: existingInvoiceId,
        paymentIntentId: '',
        totalAmount: serverTotal / 100,
        balanceApplied: serverTotal / 100,
        remainingAmount: 0,
        participantFees: participantFeesList,
      };
    }

    let invoicePiId: string;
    let invoicePiSecret: string;

    if (existingInvoice.status === 'draft') {
      await stripe.invoices.update(existingInvoiceId, {
        collection_method: 'charge_automatically',
      });
      const piResult = await finalizeInvoiceWithPi(stripe, existingInvoiceId);
      invoicePiId = piResult.piId;
      invoicePiSecret = piResult.clientSecret;
      logger.info('[Stripe] Finalized draft invoice as charge_automatically for interactive member payment', { extra: { bookingId, invoiceId: existingInvoiceId, paymentIntentId: invoicePiId } });
    } else {
      if (existingInvoice.collection_method === 'send_invoice') {
        await stripe.invoices.update(existingInvoiceId, {
          collection_method: 'charge_automatically',
        });
        logger.info('[Stripe] Switched existing open invoice from send_invoice to charge_automatically', { extra: { bookingId, invoiceId: existingInvoiceId } });
      }
      const piResult = await retrieveInvoicePaymentIntent(stripe, existingInvoiceId);
      invoicePiId = piResult.piId;
      invoicePiSecret = piResult.clientSecret;
    }

    logger.info('[Stripe] Returning invoice PI for interactive member payment (existing invoice)', {
      extra: { bookingId, invoiceId: existingInvoiceId, paymentIntentId: invoicePiId }
    });

    await db.execute(sql`
      INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status, stripe_payment_intent_id)
       VALUES (${bookingId}, ${sessionId}, ${JSON.stringify(serverFees)}, ${serverTotal}, 'pending', ${invoicePiId})
    `);

    const piDescription = await buildInvoiceDescription(bookingId, trackmanId);

    await db.execute(sql`
      INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES (${resolvedUserId || bookingEmail}, ${invoicePiId}, ${stripeCustomerId},
       ${serverTotal}, ${'booking_fee'}, ${bookingId}, ${sessionId},
       ${piDescription}, 'pending')
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `);

    return {
      paidInFull: false,
      clientSecret: invoicePiSecret,
      paymentIntentId: invoicePiId,
      invoiceId: existingInvoiceId,
      totalAmount: serverTotal / 100,
      balanceApplied: 0,
      remainingAmount: serverTotal / 100,
      participantFees: participantFeesList,
      description: piDescription,
    };
  } catch (invoiceErr: unknown) {
    logger.warn('[Stripe] Failed to use existing draft invoice, falling back to new invoice', {
      extra: { bookingId, existingInvoiceId, error: getErrorMessage(invoiceErr) }
    });

    try {
      const { getStripeClient } = await import('../../core/stripe');
      const stripe = await getStripeClient();
      const staleInvoice = await stripe.invoices.retrieve(existingInvoiceId);
      if (staleInvoice.status === 'draft') {
        await stripe.invoices.del(existingInvoiceId);
        logger.info('[Stripe] Deleted stale draft invoice before retry', { extra: { bookingId, invoiceId: existingInvoiceId } });
      } else if (staleInvoice.status === 'open') {
        await stripe.invoices.voidInvoice(existingInvoiceId);
        logger.info('[Stripe] Voided stale open invoice before retry', { extra: { bookingId, invoiceId: existingInvoiceId } });
      }
    } catch (cleanupErr: unknown) {
      logger.warn('[Stripe] Could not clean up stale invoice', { extra: { bookingId, invoiceId: existingInvoiceId, error: getErrorMessage(cleanupErr) } });
    }

    await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
    await db.execute(sql`UPDATE stripe_payment_intents SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status = 'pending'`);

    return null;
  }
}

const router = Router();

router.post('/api/member/bookings/:id/pay-fees', isAuthenticated, paymentRateLimiter, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const bookingResult = await db.execute(sql`
      SELECT br.id, br.session_id, br.user_email, br.user_name, br.status, br.trackman_booking_id, u.id as user_id, u.first_name, u.last_name
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
       WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as unknown as BookingRow;

    if (booking.status === 'cancelled' || booking.status === 'cancellation_pending' || booking.status === 'declined') {
      return res.status(400).json({ error: 'Cannot pay for a cancelled or declined booking' });
    }

    if (booking.user_email?.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Only the booking owner can pay fees' });
    }

    if (!booking.session_id) {
      return res.status(400).json({ error: 'Booking has no session' });
    }

    let breakdown;
    try {
      breakdown = await computeFeeBreakdown({
        sessionId: booking.session_id,
        source: 'stripe' as const
      });
      await applyFeeBreakdownToParticipants(booking.session_id, breakdown);
    } catch (feeError: unknown) {
      logger.error('[Stripe] Failed to compute fees', { extra: { feeError } });
      return res.status(500).json({ error: 'Failed to calculate fees' });
    }

    const pendingParticipants = await db.execute(sql`
      SELECT bp.id, bp.participant_type, bp.display_name, bp.cached_fee_cents
       FROM booking_participants bp
       WHERE bp.session_id = ${booking.session_id} 
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.cached_fee_cents > 0
    `);

    if (pendingParticipants.rows.length === 0) {
      return res.status(400).json({ error: 'No unpaid fees found' });
    }

    const typedParticipants = pendingParticipants.rows as unknown as ParticipantRow[];
    const participantIds = typedParticipants.map(r => r.id);

    const pendingFees = breakdown.participants.filter(p => 
      p.participantId && participantIds.includes(p.participantId) && p.totalCents > 0
    );

    if (pendingFees.length === 0) {
      return res.status(400).json({ error: 'No fees to charge' });
    }

    const serverTotal = pendingFees.reduce((sum, p) => sum + p.totalCents, 0);

    if (serverTotal === 0) {
      const zeroFeeParticipantIds = pendingFees.map(p => p.participantId!);
      await db.transaction(async (tx) => {
        if (zeroFeeParticipantIds.length > 0) {
          await tx.execute(sql`
            UPDATE booking_participants 
             SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW(), cached_fee_cents = 0
             WHERE id = ANY(${toIntArrayLiteral(zeroFeeParticipantIds)}::int[])
          `);
        }
      });
      logger.info('[Stripe] $0 fee booking — bypassed Stripe, marked participants as paid', { extra: { bookingId, participantCount: zeroFeeParticipantIds.length } });
      
      sendNotificationToUser(booking.user_email, {
        type: 'billing_update',
        title: 'Booking Confirmed',
        message: 'Your booking fees have been resolved — no payment required.',
        data: { bookingId, status: 'paid' }
      });
      broadcastBillingUpdate({ memberEmail: booking.user_email, action: 'payment_confirmed', bookingId, status: 'paid' });
      broadcastBookingInvoiceUpdate({ bookingId, action: 'payment_confirmed' });
      
      return res.json({
        paidInFull: true,
        totalAmount: 0,
        balanceApplied: 0,
        remainingAmount: 0,
        participantFees: pendingFees.map(f => ({
          id: f.participantId,
          displayName: f.displayName,
          amount: 0
        }))
      });
    }

    if (serverTotal < 50) {
      return res.status(400).json({ error: 'Total amount must be at least $0.50' });
    }

    const serverFees = pendingFees.map(p => ({ id: p.participantId!, amountCents: p.totalCents }));

    const trackmanId = booking.trackman_booking_id;
    const memberName = [booking.first_name, booking.last_name].filter(Boolean).join(' ') || booking.user_name || booking.user_email.split('@')[0];
    let resolvedUserId = booking.user_id;
    if (!resolvedUserId) {
      const resolved = await resolveUserByEmail(booking.user_email);
      resolvedUserId = resolved?.userId || booking.user_email;
    }
    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      resolvedUserId,
      booking.user_email,
      memberName
    );

    const existingInvoiceResult = await handleExistingInvoicePayment({
      bookingId,
      sessionId: booking.session_id,
      bookingEmail: booking.user_email,
      serverFees,
      serverTotal,
      pendingFees,
      resolvedUserId,
      stripeCustomerId,
      trackmanId,
    });
    if (existingInvoiceResult) {
      return res.json(existingInvoiceResult);
    }

    const feeLineItems: BookingFeeLineItem[] = [];
    for (const p of typedParticipants) {
      const fee = pendingFees.find(f => f.participantId === p.id);
      if (!fee || fee.totalCents <= 0) continue;
      const isGuest = p.participant_type === 'guest';
      feeLineItems.push({
        participantId: p.id,
        displayName: p.display_name || (isGuest ? 'Guest' : 'Member'),
        participantType: p.participant_type as 'owner' | 'member' | 'guest',
        overageCents: isGuest ? 0 : fee.totalCents,
        guestCents: isGuest ? fee.totalCents : 0,
        totalCents: fee.totalCents,
      });
    }

    const snapshotResult = await db.execute(sql`
      INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
       VALUES (${bookingId}, ${booking.session_id}, ${JSON.stringify(serverFees)}, ${serverTotal}, 'pending') RETURNING id
    `);
    const snapshotId = (snapshotResult.rows[0] as unknown as IdRow).id;

    const draftResult = await createDraftInvoiceForBooking({
      customerId: stripeCustomerId,
      bookingId,
      sessionId: booking.session_id,
      trackmanBookingId: trackmanId || null,
      feeLineItems,
      metadata: {
        feeSnapshotId: snapshotId.toString(),
        participantCount: serverFees.length.toString(),
        participantIds: serverFees.map(f => f.id).join(',').substring(0, 490),
        memberPayment: 'true',
      },
      purpose: 'booking_fee',
    });

    const participantFeesList = pendingFees.map(f => {
      const participant = typedParticipants.find(p => p.id === f.participantId);
      const pType = participant?.participant_type as 'owner' | 'member' | 'guest' | undefined;
      const isGuest = pType === 'guest';
      const overageCents = 'overageCents' in f ? (f as { overageCents: number }).overageCents : 0;
      const guestCents = 'guestCents' in f ? (f as { guestCents: number }).guestCents : 0;

      const { feeType, feeDescription } = describeFee(isGuest, overageCents, guestCents);

      return {
        id: f.participantId,
        displayName: participant?.display_name || (isGuest ? 'Guest' : 'Member'),
        amount: f.totalCents / 100,
        feeType,
        feeDescription,
        participantType: pType || 'member',
      };
    });

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();

    await stripe.invoices.update(draftResult.invoiceId, {
      collection_method: 'charge_automatically',
    });

    const { piId: invoicePiId, clientSecret: invoicePiSecret } = await finalizeInvoiceWithPi(stripe, draftResult.invoiceId);
    logger.info('[Stripe] Finalized new invoice as charge_automatically for interactive member payment', { extra: { bookingId, invoiceId: draftResult.invoiceId, paymentIntentId: invoicePiId } });

    logger.info('[Stripe] Returning invoice PI for interactive member payment (new invoice)', {
      extra: { bookingId, invoiceId: draftResult.invoiceId, paymentIntentId: invoicePiId }
    });

    await db.execute(sql`
      UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${invoicePiId}, status = 'pending' WHERE id = ${snapshotId}
    `);
    const newPiDescription = await buildInvoiceDescription(bookingId, trackmanId);

    await db.execute(sql`
      INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES (${resolvedUserId || booking.user_email}, ${invoicePiId}, ${stripeCustomerId},
       ${serverTotal}, ${'booking_fee'}, ${bookingId}, ${booking.session_id},
       ${newPiDescription}, 'pending')
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `);

    res.json({
      paidInFull: false,
      clientSecret: invoicePiSecret,
      paymentIntentId: invoicePiId,
      invoiceId: draftResult.invoiceId,
      totalAmount: serverTotal / 100,
      balanceApplied: 0,
      remainingAmount: serverTotal / 100,
      participantFees: participantFeesList,
      description: newPiDescription,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const stripeCode = (error as { code?: string })?.code;
    const stripeType = (error as { type?: string })?.type;
    logger.error('[Stripe] Error creating member payment intent', { 
      error: error instanceof Error ? error : new Error(String(error)),
      extra: { stripeCode, stripeType, message: errMsg }
    });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create member payment intent');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/bookings/:id/confirm-payment', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const bookingResult = await db.execute(sql`
      SELECT br.id, br.session_id, br.user_email, br.user_name
       FROM booking_requests br
       WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as unknown as BookingRow;

    if (booking.user_email?.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Only the booking owner can confirm payment' });
    }

    const snapshotResult = await db.execute(sql`
      SELECT id, participant_fees, status
       FROM booking_fee_snapshots
       WHERE booking_id = ${bookingId} AND stripe_payment_intent_id = ${paymentIntentId}
    `);

    if (snapshotResult.rows.length === 0) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    const snapshot = snapshotResult.rows[0] as unknown as SnapshotRow;

    if (snapshot.status === 'completed') {
      return res.json({ success: true, message: 'Payment already confirmed' });
    }

    const currentFees = await computeFeeBreakdown({ sessionId: booking.session_id!, source: 'stripe' as const });
    const snapshotFees = typeof snapshot.participant_fees === 'string' ? JSON.parse(snapshot.participant_fees) : snapshot.participant_fees;
    const snapshotTotal = Array.isArray(snapshotFees) 
      ? snapshotFees.reduce((sum: number, f: Record<string, unknown>) => sum + ((f.amountCents as number) || 0), 0)
      : 0;
    const currentTotal = currentFees.totals.totalCents;

    if (Math.abs(currentTotal - snapshotTotal) > 100) {
      logger.warn('[Stripe] Fee drift detected during confirm-payment — proceeding since Stripe already charged', {
        extra: { bookingId, snapshotTotal, currentTotal, difference: currentTotal - snapshotTotal, paymentIntentId }
      });
      try {
        await db.execute(sql`
          UPDATE booking_sessions SET needs_review = true, review_reason = ${`Fee drift: snapshot ${snapshotTotal} cents vs current ${currentTotal} cents (diff: ${currentTotal - snapshotTotal}). Payment ${paymentIntentId} already succeeded.`} WHERE id = ${booking.session_id}
        `);
      } catch (flagErr: unknown) {
        logger.error('[Stripe] Failed to flag session for review after fee drift', { extra: { error: getErrorMessage(flagErr) } });
      }
    }

    const confirmResult = await confirmPaymentSuccess(
      paymentIntentId,
      sessionEmail,
      booking.user_name || 'Member'
    );

    if (!confirmResult.success) {
      return res.status(400).json({ error: confirmResult.error || 'Payment verification failed' });
    }

    let participantFees: Array<{ id: number; amountCents?: number }> = [];
    try {
      participantFees = JSON.parse(typeof snapshot.participant_fees === 'string' ? snapshot.participant_fees : '[]');
    } catch (parseErr: unknown) {
      logger.error('[MemberPayments] Failed to parse participant_fees for snapshot', { extra: { snapshot_id: snapshot.id, data: ':', parseErr } });
    }
    const participantIds = participantFees.map((pf) => pf.id);

    try {
      await db.transaction(async (tx) => {
        if (participantIds.length > 0) {
          await tx.execute(sql`
            UPDATE booking_participants 
             SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW(), stripe_payment_intent_id = ${paymentIntentId}, cached_fee_cents = 0
             WHERE id = ANY(${toIntArrayLiteral(participantIds)}::int[])
          `);
        }

        await tx.execute(sql`
          UPDATE booking_fee_snapshots SET status = 'completed' WHERE id = ${snapshot.id}
        `);
      });

      logger.info('[Stripe] Member payment confirmed for booking , participants marked as paid (transaction committed)', { extra: { bookingId, participantIdsLength: participantIds.length } });

      try {
        const invoiceIdResult = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} AND stripe_invoice_id IS NOT NULL LIMIT 1`);
        const invoiceId = (invoiceIdResult.rows[0] as Record<string, unknown> | undefined)?.stripe_invoice_id as string | undefined;
        if (invoiceId) {
          const { getStripeClient } = await import('../../core/stripe/client');
          const stripe = await getStripeClient();
          const inv = await stripe.invoices.retrieve(invoiceId);
          if (inv.status === 'paid') {
            logger.info('[Stripe] Invoice paid via its own PI', { extra: { bookingId, invoiceId } });
          } else {
            logger.info('[Stripe] Invoice not yet marked paid — Stripe will settle automatically when PI webhook arrives', { extra: { bookingId, invoiceId, paymentIntentId, invoiceStatus: inv.status } });
          }
        }
      } catch (invoiceCheckErr: unknown) {
        logger.warn('[Stripe] Non-blocking: Failed to check invoice status after confirm-payment', { extra: { bookingId, error: getErrorMessage(invoiceCheckErr) } });
      }

      sendNotificationToUser(sessionEmail, {
        type: 'billing_update',
        title: 'Payment Successful',
        message: 'Your payment has been processed successfully.',
        data: { bookingId, status: 'paid' }
      });
      
      broadcastBillingUpdate({
        memberEmail: sessionEmail,
        action: 'payment_confirmed',
        bookingId,
        status: 'paid'
      });

      broadcastBookingInvoiceUpdate({
        bookingId,
        action: 'payment_confirmed',
      });
    } catch (txError: unknown) {
      logger.error('[Stripe] Transaction rolled back for member payment confirmation', { extra: { txError } });
      throw txError;
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming member payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm member payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/invoices/:invoiceId/pay', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    if (!invoiceId || !(invoiceId as string).startsWith('in_')) {
      return res.status(400).json({ error: 'Invalid invoice ID' });
    }

    const userResult = await db.execute(sql`
      SELECT id, stripe_customer_id, first_name, last_name, email FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()}
    `);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0] as unknown as UserRow;
    const stripeCustomerId = user.stripe_customer_id;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found. Please contact support.' });
    }

    const invoiceResult = await getInvoice(invoiceId as string);

    if (!invoiceResult.success || !invoiceResult.invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.invoice;

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    const stripeInvoice = await stripe.invoices.retrieve(invoiceId as string);

    if (stripeInvoice.customer !== stripeCustomerId) {
      return res.status(403).json({ error: 'You do not have permission to pay this invoice' });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ error: 'This invoice has already been paid' });
    }

    if (invoice.status !== 'draft' && invoice.status !== 'open') {
      return res.status(400).json({ error: `Cannot pay invoice with status: ${invoice.status}` });
    }

    const amountDue = invoice.amountDue;
    if (amountDue < 50) {
      return res.status(400).json({ error: 'Invoice amount is too small to process' });
    }

    let invoicePiId: string;
    let invoicePiSecret: string;

    if (stripeInvoice.status === 'draft') {
      await stripe.invoices.update(invoiceId as string, {
        collection_method: 'charge_automatically',
      });
      const piResult = await finalizeInvoiceWithPi(stripe, invoiceId as string);
      invoicePiId = piResult.piId;
      invoicePiSecret = piResult.clientSecret;
      logger.info('[Stripe] Finalized draft invoice as charge_automatically for interactive member payment', { extra: { invoiceId, paymentIntentId: invoicePiId } });
    } else if (stripeInvoice.status === 'open') {
      if (stripeInvoice.collection_method === 'send_invoice') {
        await stripe.invoices.update(invoiceId as string, {
          collection_method: 'charge_automatically',
        });
        logger.info('[Stripe] Switched open invoice from send_invoice to charge_automatically', { extra: { invoiceId } });
      }
      const piResult = await retrieveInvoicePaymentIntent(stripe, invoiceId as string);
      invoicePiId = piResult.piId;
      invoicePiSecret = piResult.clientSecret;
      logger.info('[Stripe] Invoice already open — using existing PI', { extra: { invoiceId, paymentIntentId: invoicePiId } });
    } else {
      throw new Error(`Invoice ${invoiceId} has unexpected status: ${stripeInvoice.status}`);
    }

    const primaryLine = invoice.lines?.[0];
    const description = primaryLine?.description || invoice.description || `Invoice ${invoiceId}`;

    logger.info('[Stripe] Returning invoice PI for interactive member payment', {
      extra: { invoiceId, paymentIntentId: invoicePiId, amount: amountDue }
    });

    res.json({
      clientSecret: invoicePiSecret,
      paymentIntentId: invoicePiId,
      invoiceId: invoiceId,
      amount: amountDue / 100,
      description: description,
      currency: invoice.currency || 'usd'
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating invoice payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create invoice payment intent');
    res.status(500).json({ 
      error: 'Payment initialization failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/invoices/:invoiceId/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    const { paymentIntentId } = req.body;

    if (!invoiceId || !paymentIntentId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userResult = await db.execute(sql`
      SELECT stripe_customer_id FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()}
    `);

    const confirmUser = (userResult.rows as unknown as StripeCustomerIdRow[])[0];
    const stripeCustomerId = confirmUser?.stripe_customer_id;
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded' });
    }

    const invId = invoiceId as string;
    const invoice = await stripe.invoices.retrieve(invId, { expand: ['payment_intent'] });

    if (invoice.customer !== stripeCustomerId) {
      return res.status(403).json({ error: 'You do not have permission to confirm this invoice' });
    }

    const rawPi = (invoice as unknown as { payment_intent: string | Stripe.PaymentIntent | null }).payment_intent;
    const invoicePiId = typeof rawPi === 'string'
      ? rawPi
      : (typeof rawPi === 'object' && rawPi !== null) ? (rawPi as Stripe.PaymentIntent).id : null;

    if (invoicePiId !== paymentIntentId) {
      return res.status(400).json({ error: 'Payment does not match invoice' });
    }

    if (invoice.status === 'paid') {
      logger.info('[Stripe] Invoice paid via its own PI', { extra: { invoiceId: invId, paymentIntentId } });
    } else {
      logger.info('[Stripe] Invoice not yet marked paid — Stripe will settle automatically when PI webhook arrives', { extra: { invoiceId: invId, paymentIntentId, invoiceStatus: invoice.status } });
    }

    sendNotificationToUser(sessionEmail, {
      type: 'billing_update',
      title: 'Invoice Paid',
      message: 'Your invoice has been paid successfully.',
      data: { invoiceId: invId, status: 'paid' }
    });
    
    broadcastBillingUpdate({
      memberEmail: sessionEmail,
      action: 'invoice_paid',
      status: 'paid'
    });

    try {
      const invoiceMeta = (invoice as unknown as StripeInvoiceExpanded).metadata;
      const invoiceBookingId = invoiceMeta?.bookingId ? parseInt(invoiceMeta.bookingId) : null;
      if (invoiceBookingId) {
        broadcastBookingInvoiceUpdate({
          bookingId: invoiceBookingId,
          action: 'invoice_paid',
          invoiceId: invId,
        });
      }
    } catch (_broadcastErr: unknown) { /* non-blocking */ }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming invoice payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm invoice payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/guest-passes/purchase', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { quantity } = req.body;

    if (!quantity || ![1, 3, 5].includes(quantity)) {
      return res.status(400).json({ error: 'Invalid quantity. Must be 1, 3, or 5.' });
    }

    const passProduct = await db.query.membershipTiers.findFirst({
      where: ilike(membershipTiers.name, '%Guest Pass%')
    });

    if (!passProduct || !passProduct.stripePriceId || !passProduct.priceCents) {
      return res.status(500).json({
        error: 'Guest Pass product is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.'
      });
    }

    const unitPriceCents = passProduct.priceCents;
    const amountCents = unitPriceCents * quantity;

    const userResult = await db.execute(sql`
      SELECT id, stripe_customer_id, first_name, last_name FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()}
    `);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0] as unknown as UserRow;
    const memberName = [user.first_name, user.last_name].filter(Boolean).join(' ') || sessionEmail.split('@')[0];

    let stripeCustomerId = user.stripe_customer_id;
    if (!stripeCustomerId) {
      const customerResult = await getOrCreateStripeCustomer(user.id, sessionEmail, memberName);
      stripeCustomerId = customerResult.customerId;
    }

    const description = `${quantity} Guest Pass${quantity > 1 ? 'es' : ''} - Ever Club`;

    const result = await createBalanceAwarePayment({
      stripeCustomerId: stripeCustomerId!,
      userId: user.id?.toString() || sessionEmail,
      email: sessionEmail,
      memberName,
      amountCents,
      purpose: 'one_time_purchase',
      description,
      metadata: {
        guestPassPurchase: 'true',
        quantity: quantity.toString(),
        priceId: passProduct.stripePriceId,
        member_email: sessionEmail,
        source: 'ever_house_member_portal'
      }
    });

    if (result.error) {
      throw new Error(result.error);
    }

    logger.info('[Stripe] Guest pass purchase for : passes, $ (balance: $)', { extra: { sessionEmail, quantity, amountCents_100_ToFixed_2: (amountCents / 100).toFixed(2), resultBalanceApplied_100_ToFixed_2: (result.balanceApplied / 100).toFixed(2) } });

    if (result.paidInFull) {
      const existingPass = await db.execute(sql`
        SELECT id, passes_total FROM guest_passes WHERE LOWER(member_email) = LOWER(${sessionEmail})
      `);

      if (existingPass.rows.length > 0) {
        await db.execute(sql`
          UPDATE guest_passes SET passes_total = passes_total + ${quantity} WHERE LOWER(member_email) = LOWER(${sessionEmail})
        `);
        logger.info('[Stripe] Added guest passes to existing record for (paid by credit)', { extra: { quantity, sessionEmail } });
      } else {
        await db.execute(sql`
          INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES (${sessionEmail}, 0, ${quantity})
        `);
        logger.info('[Stripe] Created new guest pass record with passes for (paid by credit)', { extra: { quantity, sessionEmail } });
      }

      return res.json({
        paidInFull: true,
        quantity,
        amountCents,
        balanceApplied: result.balanceApplied
      });
    }

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      quantity,
      amountCents,
      paidInFull: false,
      balanceApplied: result.balanceApplied,
      remainingCents: result.remainingCents
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating guest pass payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create guest pass payment intent');
    res.status(500).json({ 
      error: 'Payment initialization failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/guest-passes/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { paymentIntentId, quantity } = req.body;

    if (!paymentIntentId || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (![1, 3, 5].includes(quantity)) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded' });
    }

    if (paymentIntent.metadata?.purpose !== 'one_time_purchase' || paymentIntent.metadata?.guestPassPurchase !== 'true') {
      return res.status(400).json({ error: 'Invalid payment type' });
    }

    const paymentQuantity = parseInt(paymentIntent.metadata?.quantity || '0');
    if (paymentQuantity !== quantity) {
      return res.status(400).json({ error: 'Quantity mismatch' });
    }

    const passProduct = await db.query.membershipTiers.findFirst({
      where: ilike(membershipTiers.name, '%Guest Pass%')
    });

    if (!passProduct || !passProduct.stripePriceId || !passProduct.priceCents) {
      return res.status(500).json({
        error: 'Guest Pass product is not set up in Stripe yet. This usually resolves itself on server restart. Try refreshing in a minute.'
      });
    }

    const expectedAmount = passProduct.priceCents * quantity;
    const creditApplied = parseInt(paymentIntent.metadata?.creditToConsume || '0');
    const expectedChargeAmount = expectedAmount - creditApplied;
    if (paymentIntent.amount !== expectedChargeAmount && paymentIntent.amount !== expectedAmount) {
      logger.error('[Stripe] Amount mismatch for guest pass purchase: expected (or after credit), got', { extra: { expectedAmount, expectedChargeAmount, paymentIntentAmount: paymentIntent.amount } });
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    const existingPass = await db.execute(sql`
      SELECT id, passes_total FROM guest_passes WHERE LOWER(member_email) = LOWER(${sessionEmail})
    `);

    if (existingPass.rows.length > 0) {
      await db.execute(sql`
        UPDATE guest_passes SET passes_total = passes_total + ${quantity} WHERE LOWER(member_email) = LOWER(${sessionEmail})
      `);
      logger.info('[Stripe] Added guest passes to existing record for', { extra: { quantity, sessionEmail } });
    } else {
      await db.execute(sql`
        INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES (${sessionEmail}, 0, ${quantity})
      `);
      logger.info('[Stripe] Created new guest pass record with passes for', { extra: { quantity, sessionEmail } });
    }

    res.json({ success: true, passesAdded: quantity });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming guest pass purchase', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm guest pass purchase');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

const balanceQuerySchema = z.object({
  email: z.string().email().optional(),
}).passthrough();

router.get('/api/member/balance', isAuthenticated, validateQuery(balanceQuerySchema), async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const queryEmail = req.query.email as string | undefined;
    // Allow staff and admins to view another member's balance (for View As mode)
    const canViewOthers = sessionUser.isStaff || sessionUser.role === 'admin';
    if (queryEmail && canViewOthers) {
      memberEmail = queryEmail.trim().toLowerCase();
    }

    // Only show fees where there's a pending fee snapshot OR no snapshot at all (legacy)
    // Exclude sessions where all snapshots are cancelled/paid (orphaned cached_fee_cents)
    // Also exclude cancelled/declined bookings and sessions older than 90 days
    const result = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.participant_type,
        bp.display_name,
        bp.payment_status,
        bp.cached_fee_cents,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
       WHERE LOWER(pu.email) = ${memberEmail}
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
         AND bs.session_date >= CURRENT_DATE - INTERVAL '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br2
           WHERE br2.session_id = bs.id
             AND br2.status IN ('cancelled', 'declined', 'cancellation_pending')
         )
         AND NOT EXISTS (
           SELECT 1 FROM booking_fee_snapshots bfs
           WHERE bfs.session_id = bp.session_id
             AND bfs.status IN ('completed', 'paid')
         )
       ORDER BY bs.session_date DESC, bs.start_time DESC
    `);

    const guestResult = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.participant_type,
        bp.display_name,
        bp.payment_status,
        bp.cached_fee_cents,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        owner_u.email as owner_email
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       JOIN users owner_u ON owner_u.id = owner_bp.user_id
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_u.email) = ${memberEmail}
         AND bp.cached_fee_cents > 0
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
         AND bs.session_date >= CURRENT_DATE - INTERVAL '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM booking_requests br2
           WHERE br2.session_id = bs.id
             AND br2.status IN ('cancelled', 'declined', 'cancellation_pending')
         )
         AND NOT EXISTS (
           SELECT 1 FROM booking_fee_snapshots bfs
           WHERE bfs.session_id = bp.session_id
             AND bfs.status IN ('completed', 'paid')
         )
       ORDER BY bs.session_date DESC, bs.start_time DESC
    `);

    const breakdown: Array<{
      id: number;
      sessionId: number;
      type: 'overage' | 'guest';
      description: string;
      date: string;
      amountCents: number;
    }> = [];

    for (const row of result.rows as unknown as BalanceParticipantRow[]) {
      let amountCents = 0;
      
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      
      if (amountCents > 0) {
        const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';
        breakdown.push({
          id: row.participant_id,
          sessionId: row.session_id,
          type: 'overage',
          description: `${row.resource_name || 'Booking'} - ${dateStr}`,
          date: row.session_date,
          amountCents
        });
      }
    }

    for (const row of guestResult.rows as unknown as GuestBalanceRow[]) {
      const amountCents = row.cached_fee_cents || GUEST_FEE_CENTS;
      const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';
      breakdown.push({
        id: row.participant_id,
        sessionId: row.session_id,
        type: 'guest',
        description: `Guest: ${row.display_name} - ${dateStr}`,
        date: row.session_date,
        amountCents
      });
    }

    const existingSessionIds = new Set(breakdown.map(b => b.sessionId));
    try {
      const uncachedResult = await db.execute(sql`
        SELECT DISTINCT bs.id as session_id
         FROM booking_participants bp
         JOIN booking_sessions bs ON bs.id = bp.session_id
         JOIN users pu ON pu.id = bp.user_id
         WHERE LOWER(pu.email) = ${memberEmail}
           AND bp.participant_type = 'owner'
           AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
           AND COALESCE(bp.cached_fee_cents, 0) = 0
           AND bs.session_date >= CURRENT_DATE - INTERVAL '90 days'
           AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
           AND NOT EXISTS (
             SELECT 1 FROM booking_requests br2
             WHERE br2.session_id = bs.id
               AND br2.status IN ('cancelled', 'declined', 'cancellation_pending')
           )
           AND NOT EXISTS (
             SELECT 1 FROM booking_fee_snapshots bfs
             WHERE bfs.session_id = bs.id
               AND bfs.status IN ('completed', 'paid')
           )
         LIMIT 20
      `);

      const uncachedSessions = (uncachedResult.rows as unknown as UncachedSessionRow[])
        .map(r => r.session_id)
        .filter(sid => !existingSessionIds.has(sid));

      if (uncachedSessions.length > 0) {
        logger.info('[Member Balance] Computing fees on-the-fly for sessions', { extra: { uncachedSessionsLength: uncachedSessions.length } });

        const allCacheUpdates: Array<{ id: number; cents: number }> = [];

        for (const sessionId of uncachedSessions) {
          try {
            const feeResult = await computeFeeBreakdown({ sessionId, source: 'stripe' as const });

            for (const p of feeResult.participants) {
              if (p.totalCents > 0 && p.participantId) {
                const sessionDataResult = await db.execute(sql`
                  SELECT bs.session_date, r.name as resource_name, bp.participant_type, bp.display_name
                   FROM booking_sessions bs
                   LEFT JOIN resources r ON r.id = bs.resource_id
                   LEFT JOIN booking_participants bp ON bp.id = ${p.participantId}
                   WHERE bs.id = ${sessionId}
                `);
                const sData = sessionDataResult.rows[0] as unknown as SessionDataRow | undefined;
                const dateStr = sData?.session_date ? new Date(sData.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';

                const isGuest = sData?.participant_type === 'guest';
                breakdown.push({
                  id: p.participantId,
                  sessionId,
                  type: isGuest ? 'guest' : 'overage',
                  description: isGuest
                    ? `Guest: ${sData?.display_name || 'Guest'} - ${dateStr}`
                    : `${sData?.resource_name || 'Booking'} - ${dateStr}`,
                  date: sData?.session_date || dateStr,
                  amountCents: p.totalCents
                });

                allCacheUpdates.push({ id: p.participantId, cents: p.totalCents });
              }
            }
          } catch (sessionErr: unknown) {
            logger.error('[Member Balance] Failed to compute fees for session', { extra: { sessionId, sessionErr } });
          }
        }

        if (allCacheUpdates.length > 0) {
          try {
            const ids = allCacheUpdates.map(u => u.id);
            const cents = allCacheUpdates.map(u => u.cents);
            await db.execute(sql`
              UPDATE booking_participants bp
               SET cached_fee_cents = updates.cents
               FROM (SELECT UNNEST(${ids}::int[]) as id, UNNEST(${cents}::int[]) as cents) as updates
               WHERE bp.id = updates.id
            `);
          } catch (cacheErr: unknown) {
            logger.error('[Member Balance] Failed to write-through cache', { extra: { cacheErr } });
          }
        }
      }
    } catch (uncachedErr: unknown) {
      logger.error('[Member Balance] Error computing on-the-fly fees', { extra: { uncachedErr } });
    }

    const unfilledResult = await db.execute(sql`
      SELECT 
        bs.id as session_id,
        bs.session_date,
        bs.start_time,
        bs.end_time,
        r.name as resource_name,
        COALESCE(br.declared_player_count, 1) as declared_player_count,
        (SELECT COUNT(*) FROM booking_participants bp2 
         WHERE bp2.session_id = bs.id 
           AND bp2.participant_type != 'owner'
           AND bp2.payment_status IS NOT NULL) as non_owner_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN booking_requests br ON br.session_id = bs.id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       WHERE LOWER(pu.email) = ${memberEmail}
         AND bp.participant_type = 'owner'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND COALESCE(br.declared_player_count, 1) > 1
         AND (bs.session_date AT TIME ZONE 'America/Los_Angeles')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
         AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
       GROUP BY bs.id, bs.session_date, bs.start_time, bs.end_time, r.name, br.declared_player_count, bp.user_id
    `);

    for (const row of unfilledResult.rows as unknown as UnfilledRow[]) {
      const declaredCount = parseInt(row.declared_player_count, 10) || 1;
      const nonOwnerCount = parseInt(row.non_owner_count, 10) || 0;
      const unfilledSlots = Math.max(0, declaredCount - 1 - nonOwnerCount);
      
      if (unfilledSlots > 0) {
        const dateStr = row.session_date ? new Date(row.session_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '';
        for (let i = 0; i < unfilledSlots; i++) {
          breakdown.push({
            id: -row.session_id * 1000 - i,
            sessionId: row.session_id,
            type: 'guest',
            description: `Guest fee (unfilled) - ${dateStr}`,
            date: row.session_date,
            amountCents: GUEST_FEE_CENTS
          });
        }
      }
    }

    const totalCents = breakdown.reduce((sum, item) => sum + item.amountCents, 0);

    res.json({
      totalCents,
      totalDollars: totalCents / 100,
      itemCount: breakdown.length,
      breakdown
    });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error getting balance', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

router.post('/api/member/balance/pay', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let memberEmail = sessionUser.email.toLowerCase();
    const requestEmail = (req.body?.memberEmail as string | undefined)?.trim()?.toLowerCase();
    // Allow staff and admins to pay on behalf of another member (for View As mode)
    const canActForOthers = sessionUser.isStaff || sessionUser.role === 'admin';
    if (requestEmail && canActForOthers) {
      memberEmail = requestEmail.toLowerCase();
    }
    const applyCredit = req.body?.applyCredit !== false; // Default to true
    
    // Use email as the primary identifier for Stripe customer
    const memberName = memberEmail;

    // Only include fees where there's a pending fee snapshot OR no snapshot at all (legacy)
    const result = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
       WHERE LOWER(pu.email) = ${memberEmail}
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
    `);

    const guestResult = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id AND bfs.status = 'pending') as pending_snapshot_count,
        (SELECT COUNT(*) FROM booking_fee_snapshots bfs WHERE bfs.session_id = bp.session_id) as total_snapshot_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       JOIN users owner_u ON owner_u.id = owner_bp.user_id
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_u.email) = ${memberEmail}
         AND bp.cached_fee_cents > 0
         AND (bs.source IS NULL OR bs.source::text NOT IN ('trackman_import', 'trackman_webhook'))
    `);

    const participantFees: Array<{id: number; amountCents: number}> = [];

    for (const row of result.rows as unknown as BalancePayParticipantRow[]) {
      let amountCents = 0;
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      if (amountCents > 0) {
        participantFees.push({ id: row.participant_id, amountCents });
      }
    }

    for (const row of guestResult.rows as unknown as BalancePayGuestRow[]) {
      const amountCents = row.cached_fee_cents || GUEST_FEE_CENTS;
      participantFees.push({ id: row.participant_id, amountCents });
    }

    const totalCents = participantFees.reduce((sum, f) => sum + f.amountCents, 0);

    if (totalCents < 50) {
      return res.status(400).json({ error: 'No outstanding balance to pay or amount too small' });
    }

    let snapshotId: number | null = null;
    let existingPaymentIntentId: string | null = null;

    await db.transaction(async (tx) => {
      // Check for existing pending snapshot (balance payment snapshots have null booking_id and session_id)
      const existingSnapshot = await tx.execute(sql`
        SELECT id, stripe_payment_intent_id, total_cents, participant_fees
         FROM booking_fee_snapshots 
         WHERE booking_id IS NULL AND session_id IS NULL AND status = 'pending' 
         AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at DESC
         LIMIT 1
      `);
      
      if (existingSnapshot.rows.length > 0) {
        const existing = existingSnapshot.rows[0] as unknown as SnapshotRow;
        const parsedFees = typeof existing.participant_fees === 'string' ? JSON.parse(existing.participant_fees) : (existing.participant_fees || {});
        const existingApplyCredit = parsedFees.applyCredit !== false;
        const existingParticipantIds = (parsedFees.fees || []).map((p: Record<string, unknown>) => p.id).sort().join(',');
        const newParticipantIds = participantFees.map(p => p.id).sort().join(',');
        const participantsMatch = existingParticipantIds === newParticipantIds;
        
        if (existing.stripe_payment_intent_id && 
            existing.total_cents === totalCents && 
            participantsMatch &&
            existingApplyCredit === applyCredit) {
          snapshotId = existing.id;
          existingPaymentIntentId = existing.stripe_payment_intent_id;
          logger.info('[Member Balance] Reusing existing pending snapshot', { extra: { snapshotId } });
        } else {
          // Expire stale snapshot (applyCredit changed or amounts/participants changed)
          await tx.execute(sql`
            UPDATE booking_fee_snapshots SET status = 'expired' WHERE id = ${existing.id}
          `);
          logger.info('[Member Balance] Expiring stale snapshot (applyCredit: -> , amountMatch: , participantsMatch: )', { extra: { existingId: existing.id, existingApplyCredit, applyCredit, existingTotal_cents_totalCents: existing.total_cents === totalCents, participantsMatch } });
        }
      }
      
      if (!snapshotId) {
        // Store applyCredit preference with the fees in the snapshot
        const snapshotData = {
          fees: participantFees,
          applyCredit
        };
        const snapshotResult = await tx.execute(sql`
          INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status)
           VALUES (NULL, NULL, ${JSON.stringify(snapshotData)}, ${totalCents}, 'pending') RETURNING id
        `);
        snapshotId = (snapshotResult.rows[0] as unknown as IdRow).id;
      }
    });
    
    // If we have an existing valid payment intent, return it
    if (existingPaymentIntentId) {
      try {
        const { getStripeClient } = await import('../../core/stripe/client');
        const stripe = await getStripeClient();
        const existingIntent = await stripe.paymentIntents.retrieve(existingPaymentIntentId);
        if (existingIntent.status === 'requires_payment_method' || existingIntent.status === 'requires_confirmation') {
          logger.info('[Member Balance] Returning existing payment intent', { extra: { existingPaymentIntentId } });
          
          // Get customer balance for response
          const customer = await stripe.customers.retrieve((existingIntent.customer as string) || '');
          let availableCredit = 0;
          if (!('deleted' in customer) || !customer.deleted) {
            const customerBalance = ('balance' in customer ? (customer.balance as number) : 0) || 0;
            availableCredit = customerBalance < 0 ? Math.abs(customerBalance) : 0;
          }
          
          return res.json({
            paidInFull: false,
            clientSecret: existingIntent.client_secret,
            paymentIntentId: existingPaymentIntentId,
            totalCents,
            balanceApplied: 0,
            remainingCents: totalCents,
            availableCreditCents: availableCredit,
            itemCount: participantFees.length,
            participantFees,
            creditApplied: false
          });
        }
      } catch (_intentError: unknown) {
        logger.info('[Member Balance] Could not reuse intent , creating new one', { extra: { existingPaymentIntentId } });
      }
    }

    // Get or create Stripe customer for balance-aware payment
    const resolvedMember = await resolveUserByEmail(memberEmail);
    const resolvedMemberUserId = resolvedMember?.userId || memberEmail;
    const { customerId: stripeCustomerId } = await getOrCreateStripeCustomer(
      resolvedMemberUserId,
      memberEmail,
      memberName
    );

    // Get customer's available credit balance
    const { getStripeClient } = await import('../../core/stripe/client');
    const stripe = await getStripeClient();
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    let availableCreditCents = 0;
    if (!('deleted' in customer) || !customer.deleted) {
      const customerBalance = ('balance' in customer ? (customer.balance as number) : 0) || 0;
      availableCreditCents = customerBalance < 0 ? Math.abs(customerBalance) : 0;
    }

    let paymentResult: {
      paidInFull: boolean;
      clientSecret?: string;
      paymentIntentId?: string;
      balanceTransactionId?: string;
      totalCents: number;
      balanceApplied: number;
      remainingCents: number;
      error?: string;
    };

    if (applyCredit && availableCreditCents > 0) {
      // Use balance-aware payment to apply account credits first
      paymentResult = await createBalanceAwarePayment({
        stripeCustomerId,
        userId: memberEmail,
        email: memberEmail,
        memberName,
        amountCents: totalCents,
        purpose: 'overage_fee',
        description: `Outstanding balance payment - ${participantFees.length} item(s)`,
        metadata: {
          feeSnapshotId: snapshotId!.toString(),
          participantCount: participantFees.length.toString(),
          participantIds: participantFees.map(f => f.id).join(',').substring(0, 490),
          balancePayment: 'true'
        }
      });
    } else {
      // Use standard payment without balance application
      const intentResult = await createPaymentIntent({
        userId: memberEmail,
        email: memberEmail,
        memberName,
        amountCents: totalCents,
        purpose: 'overage_fee',
        description: `Outstanding balance payment - ${participantFees.length} item(s)`,
        stripeCustomerId,
        metadata: {
          feeSnapshotId: snapshotId!.toString(),
          participantCount: participantFees.length.toString(),
          participantIds: participantFees.map(f => f.id).join(',').substring(0, 490),
          balancePayment: 'true'
        }
      });
      paymentResult = {
        paidInFull: false,
        clientSecret: intentResult.clientSecret,
        paymentIntentId: intentResult.paymentIntentId,
        totalCents,
        balanceApplied: 0,
        remainingCents: totalCents
      };
    }

    if (paymentResult.error) {
      await db.execute(sql`DELETE FROM booking_fee_snapshots WHERE id = ${snapshotId}`);
      throw new Error(paymentResult.error);
    }

    const balancePaymentRef = paymentResult.paymentIntentId || paymentResult.balanceTransactionId || 'unknown';
    await db.execute(sql`
      UPDATE booking_fee_snapshots SET stripe_payment_intent_id = ${balancePaymentRef} WHERE id = ${snapshotId}
    `);

    // If fully paid by balance, mark participants as paid
    if (paymentResult.paidInFull) {
      const participantIds = participantFees.map(f => f.id);
      await db.execute(sql`
        UPDATE booking_participants 
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = ${balancePaymentRef}, cached_fee_cents = 0
         WHERE id = ANY(${toIntArrayLiteral(participantIds)}::int[])
      `);
      
      await db.execute(sql`
        UPDATE booking_fee_snapshots SET status = 'paid' WHERE id = ${snapshotId}
      `);
    }

    // Determine if credit was actually applied
    const creditApplied = applyCredit && availableCreditCents > 0 && paymentResult.balanceApplied > 0;

    logger.info('[Member Balance] Payment created: $ (balance: $, remaining: $, applyCredit: , creditApplied: )', { extra: { totalCents_100_ToFixed_2: (totalCents / 100).toFixed(2), paymentResultBalanceApplied_100_ToFixed_2: (paymentResult.balanceApplied / 100).toFixed(2), paymentResultRemainingCents_100_ToFixed_2: (paymentResult.remainingCents / 100).toFixed(2), applyCredit, creditApplied } });

    res.json({
      paidInFull: paymentResult.paidInFull,
      clientSecret: paymentResult.clientSecret,
      paymentIntentId: paymentResult.paymentIntentId,
      balanceTransactionId: paymentResult.balanceTransactionId,
      totalCents,
      balanceApplied: paymentResult.balanceApplied,
      remainingCents: paymentResult.remainingCents,
      availableCreditCents,
      itemCount: participantFees.length,
      participantFees,
      creditApplied,
      error: paymentResult.error
    });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error creating payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create balance payment');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/balance/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      sessionUser.email,
      sessionUser.name || 'Member'
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Member Balance] Error confirming payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm balance payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/bookings/:bookingId/cancel-payment', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    const { paymentIntentId } = req.body;

    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    const verification = await db.execute(sql`
      SELECT spi.id FROM stripe_payment_intents spi
       JOIN booking_requests br ON spi.booking_id = br.id
       WHERE spi.stripe_payment_intent_id = ${paymentIntentId} 
       AND spi.booking_id = ${bookingId}
       AND br.user_email = ${sessionUser.email.toLowerCase()}
       AND spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')
    `);

    if (verification.rows.length === 0) {
      return res.status(404).json({ error: 'Payment intent not found or already processed' });
    }

    const { cancelPaymentIntent } = await import('../../core/stripe');
    const result = await cancelPaymentIntent(paymentIntentId);

    if (result.success) {
      logger.info('[Member Payment] User cancelled abandoned PI for booking', { extra: { sessionUserEmail: sessionUser.email, paymentIntentId, bookingId } });

      // Void the finalized invoice and re-create draft for next payment attempt
      try {
        const { voidBookingInvoice, recreateDraftInvoiceFromBooking } = await import('../../core/billing/bookingInvoiceService');
        await voidBookingInvoice(bookingId);
        await recreateDraftInvoiceFromBooking(bookingId);
        logger.info('[Member Payment] Voided invoice and re-created draft after abandoned payment', { extra: { bookingId } });
      } catch (invoiceErr: unknown) {
        logger.warn('[Member Payment] Failed to void/recreate invoice after payment cancellation', { extra: { bookingId, error: String(invoiceErr) } });
      }
    }

    res.json({ success: result.success });
  } catch (error: unknown) {
    logger.error('[Member Payment] Error cancelling payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ success: false, error: 'Failed to cancel payment' });
  }
});

export default router;
