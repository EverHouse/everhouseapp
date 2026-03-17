import Stripe from 'stripe';
import { logger } from '../../../core/logger';
import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../../utils/errorUtils';
import { toIntArrayLiteral } from '../../../utils/sqlArrayLiteral';
import { getBookingInvoiceId, buildInvoiceDescription } from '../../../core/billing/bookingInvoiceService';
import { logPaymentAudit } from '../../../core/auditLog';
import { PRICING } from '../../../core/billing/pricingConfig';

export type StripeInvoiceExpanded = Stripe.Invoice & {
  payment_intent: string | Stripe.PaymentIntent | null;
  confirmation_secret?: { client_secret: string; type: string } | null;
  metadata: Record<string, string> | null;
};

export function getStripeDeclineMessage(error: unknown): string {
  const stripeError = error as {
    type?: string;
    code?: string;
    decline_code?: string;
    message?: string;
  };

  if (stripeError.code === 'card_declined' || stripeError.decline_code) {
    const declineCode = stripeError.decline_code || '';
    switch (declineCode) {
      case 'insufficient_funds':
        return 'Your card has insufficient funds. Please try a different card.';
      case 'lost_card':
      case 'stolen_card':
        return 'This card has been reported lost or stolen. Please use a different card.';
      case 'expired_card':
        return 'Your card has expired. Please update your card details or use a different card.';
      case 'incorrect_cvc':
        return 'The CVC code is incorrect. Please check and try again.';
      case 'processing_error':
        return 'There was a processing error with your card. Please try again in a few minutes.';
      case 'incorrect_number':
        return 'The card number is incorrect. Please check and try again.';
      case 'do_not_honor':
      case 'generic_decline':
      default:
        return 'Your card was declined. Please try a different card or contact your bank.';
    }
  }

  if (stripeError.code === 'expired_card') {
    return 'Your card has expired. Please update your card details or use a different card.';
  }

  if (stripeError.code === 'incorrect_cvc') {
    return 'The CVC code is incorrect. Please check and try again.';
  }

  if (stripeError.code === 'payment_intent_unexpected_state') {
    return 'This payment has already been processed.';
  }

  if (stripeError.code === 'processing_error') {
    return 'There was a processing error with your card. Please try again in a few minutes.';
  }

  if (stripeError.code === 'amount_too_small') {
    return 'The payment amount is too small to process.';
  }

  if (stripeError.type === 'StripeCardError') {
    return stripeError.message || 'Your card was declined. Please try a different card.';
  }

  return '';
}

export function describeFee(
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

export type FinalizeResult =
  | { paidInFull: false; piId: string; clientSecret: string }
  | { paidInFull: true };

export async function finalizeInvoiceWithPi(
  stripe: Stripe,
  invoiceId: string,
): Promise<FinalizeResult> {
  const finalized = await stripe.invoices.finalizeInvoice(invoiceId, {
    auto_advance: false,
    expand: ['payment_intent', 'confirmation_secret'],
  }) as unknown as StripeInvoiceExpanded;

  if (finalized.status === 'paid') {
    logger.info('[Stripe] Invoice auto-paid after finalization (credit balance or $0 total)', {
      extra: { invoiceId, amountDue: finalized.amount_due, amountPaid: finalized.amount_paid }
    });
    return { paidInFull: true };
  }

  if (finalized.payment_intent) {
    if (typeof finalized.payment_intent === 'string') {
      const fullPi = await stripe.paymentIntents.retrieve(finalized.payment_intent);
      if (fullPi.status !== 'canceled' && fullPi.client_secret) {
        return { paidInFull: false, piId: fullPi.id, clientSecret: fullPi.client_secret };
      }
    } else {
      const pi = finalized.payment_intent as Stripe.PaymentIntent;
      if (pi.status !== 'canceled' && pi.client_secret) {
        logger.info('[Stripe] Got client_secret via expanded payment_intent', { extra: { invoiceId, piId: pi.id } });
        return { paidInFull: false, piId: pi.id, clientSecret: pi.client_secret };
      }
      if (pi.id) {
        const fullPi = await stripe.paymentIntents.retrieve(pi.id);
        if (fullPi.client_secret) {
          return { paidInFull: false, piId: fullPi.id, clientSecret: fullPi.client_secret };
        }
      }
    }
  }

  if (finalized.confirmation_secret?.client_secret) {
    let piId: string | undefined;
    const secretMatch = finalized.confirmation_secret.client_secret.match(/^(pi_[A-Za-z0-9]+)_secret_/);
    if (secretMatch) {
      piId = secretMatch[1];
    }
    if (!piId) {
      const refetched = await stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] }) as unknown as StripeInvoiceExpanded;
      if (refetched.payment_intent) {
        piId = typeof refetched.payment_intent === 'string' ? refetched.payment_intent : (refetched.payment_intent as Stripe.PaymentIntent).id;
      }
    }
    if (piId) {
      const directPi = await stripe.paymentIntents.retrieve(piId);
      if (directPi.client_secret && directPi.status !== 'canceled') {
        logger.info('[Stripe] Got PI client_secret via direct retrieve after finalization (confirmation_secret path)', { extra: { invoiceId, piId } });
        return { paidInFull: false, piId, clientSecret: directPi.client_secret };
      }
      logger.info('[Stripe] PI has no client_secret after finalization, using confirmation_secret', { extra: { invoiceId, piId, piStatus: directPi.status } });
      return { paidInFull: false, piId, clientSecret: finalized.confirmation_secret.client_secret };
    }
  }

  throw new Error(`Invoice ${invoiceId} has no PaymentIntent after finalization (status: ${finalized.status})`);
}

export async function retrieveInvoicePaymentIntent(
  stripe: Stripe,
  invoiceId: string,
): Promise<{ piId: string; clientSecret: string }> {
  const inv = await stripe.invoices.retrieve(invoiceId, {
    expand: ['payment_intent', 'confirmation_secret'],
  }) as unknown as StripeInvoiceExpanded;

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
    if (piId) {
      const directPi = await stripe.paymentIntents.retrieve(piId);
      if (directPi.client_secret && directPi.status !== 'canceled') {
        logger.info('[Stripe] Got PI client_secret via direct retrieve (confirmation_secret path)', { extra: { invoiceId, piId } });
        return { piId, clientSecret: directPi.client_secret };
      }
      logger.info('[Stripe] PI has no client_secret, using confirmation_secret', { extra: { invoiceId, piId, piStatus: directPi.status } });
      return { piId, clientSecret: inv.confirmation_secret.client_secret };
    }
  }

  throw new Error(`Invoice ${invoiceId} has no usable PaymentIntent (status: ${inv.status})`);
}

export interface BookingRow {
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

export interface ParticipantRow {
  id: number;
  participant_type: string;
  display_name: string | null;
  cached_fee_cents: number;
}

export interface SnapshotRow {
  id: number;
  participant_fees: string;
  status: string;
  stripe_payment_intent_id: string | null;
  total_cents: number;
}

export interface UserRow {
  id: string;
  stripe_customer_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

export interface StripeCustomerIdRow {
  stripe_customer_id: string | null;
}

export interface BalanceParticipantRow {
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

export interface GuestBalanceRow {
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

export interface UncachedSessionRow {
  session_id: number;
}

export interface SessionDataRow {
  session_date: string;
  resource_name: string | null;
  participant_type: string | null;
  display_name: string | null;
}

export interface UnfilledRow {
  session_id: number;
  session_date: string;
  start_time: string;
  end_time: string;
  resource_name: string | null;
  declared_player_count: string;
  non_owner_count: string;
}

export interface BalancePayParticipantRow {
  participant_id: number;
  session_id: number;
  cached_fee_cents: number;
  ledger_fee: string;
  pending_snapshot_count: string;
  total_snapshot_count: string;
}

export interface BalancePayGuestRow {
  participant_id: number;
  session_id: number;
  cached_fee_cents: number;
  pending_snapshot_count: string;
  total_snapshot_count: string;
}

export interface IdRow {
  id: number;
}

export async function handleExistingInvoicePayment(params: {
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

  try {
    const { getStripeClient } = await import('../../../core/stripe/client');
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
        payment_settings: {
          payment_method_types: ['card', 'link'],
        },
      });
      const piResult = await finalizeInvoiceWithPi(stripe, existingInvoiceId);
      if (piResult.paidInFull) {
        const paidParticipantIds = pendingFees.map(f => f.participantId!).filter(Boolean);
        if (paidParticipantIds.length > 0) {
          await db.execute(sql`
            UPDATE booking_participants
             SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW()
             WHERE id = ANY(${toIntArrayLiteral(paidParticipantIds)}::int[])
          `);
        }
        logger.info('[Stripe] Existing draft invoice auto-paid after finalization', { extra: { bookingId, invoiceId: existingInvoiceId } });
        await logPaymentAudit({
          bookingId,
          sessionId,
          action: 'payment_confirmed',
          staffEmail: 'system',
          amountAffected: serverTotal / 100,
          paymentMethod: 'account_credit',
          metadata: { invoiceId: existingInvoiceId, trigger: 'auto_pay_existing_draft' },
        });
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
      if (!piResult.clientSecret?.startsWith('pi_')) {
        logger.warn('[Stripe] Finalized draft invoice returned non-standard client_secret, voiding for fresh invoice', {
          extra: { bookingId, invoiceId: existingInvoiceId, piId: piResult.piId }
        });
        await stripe.invoices.voidInvoice(existingInvoiceId);
        await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
        await db.execute(sql`UPDATE stripe_payment_intents SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status = 'pending'`);
        return null;
      }
      invoicePiId = piResult.piId;
      invoicePiSecret = piResult.clientSecret;
      logger.info('[Stripe] Finalized draft invoice as charge_automatically for interactive member payment', { extra: { bookingId, invoiceId: existingInvoiceId, paymentIntentId: invoicePiId } });
    } else {
      if (existingInvoice.collection_method === 'send_invoice') {
        await stripe.invoices.update(existingInvoiceId, {
          collection_method: 'charge_automatically',
          payment_settings: {
            payment_method_types: ['card', 'link'],
          },
        });
        logger.info('[Stripe] Switched existing open invoice from send_invoice to charge_automatically', { extra: { bookingId, invoiceId: existingInvoiceId } });
      }
      try {
        const piResult = await retrieveInvoicePaymentIntent(stripe, existingInvoiceId);
        if (piResult.clientSecret.startsWith('pi_')) {
          invoicePiId = piResult.piId;
          invoicePiSecret = piResult.clientSecret;
        } else {
          logger.warn('[Stripe] Existing invoice PI has non-standard client_secret (confirmation_secret), voiding for fresh invoice', {
            extra: { bookingId, invoiceId: existingInvoiceId, piId: piResult.piId }
          });
          await stripe.invoices.voidInvoice(existingInvoiceId);
          await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
          await db.execute(sql`UPDATE stripe_payment_intents SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status = 'pending'`);
          return null;
        }
      } catch (piErr: unknown) {
        logger.warn('[Stripe] Could not retrieve usable PI from existing open invoice, voiding for fresh invoice', {
          extra: { bookingId, invoiceId: existingInvoiceId, error: getErrorMessage(piErr) }
        });
        try {
          await stripe.invoices.voidInvoice(existingInvoiceId);
        } catch { /* void may fail if already void */ }
        await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
        await db.execute(sql`UPDATE stripe_payment_intents SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${bookingId} AND status = 'pending'`);
        return null;
      }
    }

    logger.info('[Stripe] Returning invoice PI for interactive member payment (existing invoice)', {
      extra: { bookingId, invoiceId: existingInvoiceId, paymentIntentId: invoicePiId }
    });

    try {
      await stripe.paymentIntents.update(invoicePiId, {
        setup_future_usage: 'off_session',
      });
    } catch (sfuErr: unknown) {
      logger.warn('[Stripe] Could not set setup_future_usage on existing invoice PI', {
        extra: { bookingId, piId: invoicePiId, error: getErrorMessage(sfuErr) }
      });
    }

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

    let customerSessionSecret: string | undefined;
    try {
      const customerSession = await stripe.customerSessions.create({
        customer: stripeCustomerId,
        components: {
          payment_element: {
            enabled: true,
            features: {
              payment_method_redisplay: 'enabled',
              payment_method_save: 'enabled',
              payment_method_remove: 'enabled',
            },
          },
        },
      });
      customerSessionSecret = customerSession.client_secret;
    } catch (csErr: unknown) {
      logger.warn('[Stripe] Failed to create customer session for saved cards (existing invoice)', {
        extra: { bookingId, error: getErrorMessage(csErr) }
      });
    }

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
      customerSessionClientSecret: customerSessionSecret,
    };
  } catch (invoiceErr: unknown) {
    logger.warn('[Stripe] Failed to use existing invoice, checking status before fallback', {
      extra: { bookingId, existingInvoiceId, error: getErrorMessage(invoiceErr) }
    });

    try {
      const { getStripeClient } = await import('../../../core/stripe');
      const stripe = await getStripeClient();
      const staleInvoice = await stripe.invoices.retrieve(existingInvoiceId);

      if (staleInvoice.status === 'paid') {
        logger.info('[Stripe] Invoice was actually paid (auto-pay from credit balance), returning paidInFull', {
          extra: { bookingId, invoiceId: existingInvoiceId }
        });
        const paidParticipantIds = pendingFees.map(f => f.participantId!).filter(Boolean);
        if (paidParticipantIds.length > 0) {
          await db.execute(sql`
            UPDATE booking_participants
             SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW()
             WHERE id = ANY(${toIntArrayLiteral(paidParticipantIds)}::int[])
          `);
        }
        await logPaymentAudit({
          bookingId,
          sessionId,
          action: 'payment_confirmed',
          staffEmail: 'system',
          amountAffected: serverTotal / 100,
          paymentMethod: 'account_credit',
          metadata: { invoiceId: existingInvoiceId, trigger: 'auto_pay_recovery' },
        });
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
