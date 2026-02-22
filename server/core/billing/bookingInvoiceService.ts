import { getStripeClient } from '../stripe/client';
import { db } from '../../db';
import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { notifyAllStaff } from '../notificationService';
import { bookingRequests } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { BookingFeeLineItem } from '../stripe/invoices';

export interface DraftInvoiceParams {
  customerId: string;
  bookingId: number;
  sessionId: number;
  trackmanBookingId?: string | null;
  feeLineItems: BookingFeeLineItem[];
  metadata?: Record<string, string>;
  purpose?: string;
}

export interface DraftInvoiceResult {
  invoiceId: string;
  totalCents: number;
}

export interface FinalizeAndPayResult {
  invoiceId: string;
  paymentIntentId: string;
  clientSecret: string;
  status: string;
  paidInFull: boolean;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  amountFromBalance: number;
  amountCharged: number;
}

function buildInvoiceDescription(
  bookingId: number,
  trackmanBookingId: string | null | undefined,
  feeLineItems: BookingFeeLineItem[]
): string {
  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);
  const bookingRef = trackmanBookingId ? `TM-${trackmanBookingId}` : `#${bookingId}`;
  return `Booking ${bookingRef} fees - Overage: $${(totalOverageCents / 100).toFixed(2)}, Guest fees: $${(totalGuestCents / 100).toFixed(2)}`;
}

function buildInvoiceMetadata(
  params: DraftInvoiceParams,
  feeLineItems: BookingFeeLineItem[]
): Record<string, string> {
  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);
  const meta: Record<string, string> = {
    ...(params.metadata || {}),
    source: 'ever_house_app',
    purpose: params.purpose || 'booking_fee',
    bookingId: params.bookingId.toString(),
    sessionId: params.sessionId.toString(),
    overageCents: totalOverageCents.toString(),
    guestCents: totalGuestCents.toString(),
    invoiceModel: 'single_per_booking',
  };
  if (params.trackmanBookingId) {
    meta.trackmanBookingId = String(params.trackmanBookingId);
  }
  return meta;
}

async function addLineItemsToInvoice(
  stripe: Stripe,
  invoiceId: string,
  customerId: string,
  feeLineItems: BookingFeeLineItem[]
): Promise<void> {
  for (const li of feeLineItems) {
    if (li.totalCents <= 0) continue;

    if (li.overageCents > 0) {
      const overageDesc = li.participantType === 'owner'
        ? `Overage fee — ${li.displayName}`
        : `Overage fee — ${li.displayName} (${li.participantType})`;
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoiceId,
        amount: li.overageCents,
        currency: 'usd',
        description: overageDesc,
        metadata: {
          participantId: li.participantId?.toString() || '',
          feeType: 'overage',
          participantType: li.participantType,
        },
      }, {
        idempotencyKey: `invitem_overage_${invoiceId}_${li.participantId || 'unknown'}`
      });
    }

    if (li.guestCents > 0) {
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoiceId,
        amount: li.guestCents,
        currency: 'usd',
        description: `Guest fee — ${li.displayName}`,
        metadata: {
          participantId: li.participantId?.toString() || '',
          feeType: 'guest',
          participantType: li.participantType,
        },
      }, {
        idempotencyKey: `invitem_guest_${invoiceId}_${li.participantId || 'unknown'}`
      });
    }
  }
}

export async function createDraftInvoiceForBooking(
  params: DraftInvoiceParams
): Promise<DraftInvoiceResult> {
  const stripe = await getStripeClient();
  const { customerId, bookingId, sessionId, trackmanBookingId, feeLineItems } = params;

  const existingResult = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  const existingInvoiceId = existingResult.rows[0]?.stripe_invoice_id;

  if (existingInvoiceId) {
    try {
      const existingInvoice = await stripe.invoices.retrieve(existingInvoiceId);
      if (existingInvoice.status === 'draft') {
        logger.info('[BookingInvoice] Draft invoice already exists, updating instead', {
          extra: { bookingId, invoiceId: existingInvoiceId }
        });
        return updateDraftInvoiceLineItems({ bookingId, sessionId, feeLineItems });
      }
      if (existingInvoice.status === 'paid') {
        logger.info('[BookingInvoice] Invoice already paid, skipping draft creation', {
          extra: { bookingId, invoiceId: existingInvoiceId }
        });
        return { invoiceId: existingInvoiceId, totalCents: existingInvoice.amount_paid };
      }
    } catch (retrieveErr: unknown) {
      logger.warn('[BookingInvoice] Could not retrieve existing invoice, creating new one', {
        extra: { bookingId, existingInvoiceId, error: getErrorMessage(retrieveErr) }
      });
    }
  }

  const description = buildInvoiceDescription(bookingId, trackmanBookingId, feeLineItems);
  const invoiceMetadata = buildInvoiceMetadata(params, feeLineItems);

  const invoice = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false,
    collection_method: 'charge_automatically',
    description,
    metadata: invoiceMetadata,
    pending_invoice_items_behavior: 'exclude',
  }, {
    idempotencyKey: `invoice_booking_${bookingId}`
  });

  await addLineItemsToInvoice(stripe, invoice.id, customerId, feeLineItems);

  const totalCents = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

  await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = ${invoice.id}, updated_at = NOW() WHERE id = ${bookingId}`);

  logger.info('[BookingInvoice] Created draft invoice for booking', {
    extra: { bookingId, sessionId, invoiceId: invoice.id, totalCents, lineItems: feeLineItems.length }
  });

  return { invoiceId: invoice.id, totalCents };
}

export async function updateDraftInvoiceLineItems(params: {
  bookingId: number;
  sessionId: number;
  feeLineItems: BookingFeeLineItem[];
}): Promise<DraftInvoiceResult> {
  const stripe = await getStripeClient();
  const { bookingId, sessionId, feeLineItems } = params;

  const result = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  const invoiceId = (result.rows as Array<Record<string, unknown>>)[0]?.stripe_invoice_id;

  if (!invoiceId) {
    throw new Error(`No draft invoice found for booking ${bookingId}`);
  }

  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['lines.data'] });

  if (invoice.status !== 'draft') {
    logger.warn('[BookingInvoice] Cannot update non-draft invoice', {
      extra: { bookingId, invoiceId, status: invoice.status }
    });
    return { invoiceId, totalCents: invoice.amount_due };
  }

  const invoiceItems = await stripe.invoiceItems.list({ invoice: invoiceId, limit: 100 });
  for (const item of invoiceItems.data) {
    await stripe.invoiceItems.del(item.id);
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || '';
  await addLineItemsToInvoice(stripe, invoiceId, customerId, feeLineItems);

  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);
  const totalCents = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

  const trackmanResult = await db.execute(sql`SELECT trackman_booking_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  const trackmanBookingId = trackmanResult.rows[0]?.trackman_booking_id || null;
  const bookingRef = trackmanBookingId ? `TM-${trackmanBookingId}` : `#${bookingId}`;

  await stripe.invoices.update(invoiceId, {
    description: `Booking ${bookingRef} fees - Overage: $${(totalOverageCents / 100).toFixed(2)}, Guest fees: $${(totalGuestCents / 100).toFixed(2)}`,
    metadata: {
      ...(invoice.metadata || {}),
      overageCents: totalOverageCents.toString(),
      guestCents: totalGuestCents.toString(),
      lastRosterUpdate: new Date().toISOString(),
    },
  });

  logger.info('[BookingInvoice] Updated draft invoice line items after roster change', {
    extra: { bookingId, sessionId, invoiceId, totalCents, lineItems: feeLineItems.length }
  });

  return { invoiceId, totalCents };
}

export async function getBookingInvoiceId(bookingId: number): Promise<string | null> {
  const result = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  return (result.rows as Array<Record<string, unknown>>)[0]?.stripe_invoice_id as string || null;
}

export async function getBookingInvoiceStatus(bookingId: number): Promise<{
  invoiceId: string | null;
  status: string | null;
  amountDue: number;
} | null> {
  const invoiceId = await getBookingInvoiceId(bookingId);
  if (!invoiceId) return null;

  try {
    const stripe = await getStripeClient();
    const invoice = await stripe.invoices.retrieve(invoiceId);
    return {
      invoiceId,
      status: invoice.status,
      amountDue: invoice.amount_due,
    };
  } catch (err) {
    logger.warn('[BookingInvoice] Failed to retrieve invoice status', { error: err instanceof Error ? err.message : err });
    return null;
  }
}

export async function finalizeAndPayInvoice(params: {
  bookingId: number;
  paymentMethodId?: string;
  offSession?: boolean;
}): Promise<FinalizeAndPayResult> {
  const stripe = await getStripeClient();
  const { bookingId, paymentMethodId, offSession } = params;

  const invoiceId = await getBookingInvoiceId(bookingId);
  if (!invoiceId) {
    throw new Error(`No invoice found for booking ${bookingId}`);
  }

  const invoice = await stripe.invoices.retrieve(invoiceId);

  if (invoice.status === 'paid') {
    return {
      invoiceId,
      paymentIntentId: extractPaymentIntentId(invoice) || `invoice-balance-${invoiceId}`,
      clientSecret: '',
      status: 'succeeded',
      paidInFull: true,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      invoicePdf: invoice.invoice_pdf,
      amountFromBalance: invoice.amount_paid,
      amountCharged: 0,
    };
  }

  const existingPiResult = await db.execute(sql`SELECT spi.stripe_payment_intent_id, spi.amount_cents
     FROM stripe_payment_intents spi
     WHERE spi.booking_id = ${bookingId} AND spi.status = 'succeeded'
     AND spi.purpose IN ('booking_fee', 'overage_fee')
     ORDER BY spi.created_at DESC LIMIT 1`);

  if (existingPiResult.rows.length > 0) {
    const existingPi = existingPiResult.rows[0];
    try {
      const stripePi = await stripe.paymentIntents.retrieve(existingPi.stripe_payment_intent_id);
      const pmTypes = stripePi.payment_method_types || [];
      const isTerminal = pmTypes.includes('card_present') || pmTypes.includes('interac_present');
      const invoiceTotal = invoice.amount_due || invoice.total || 0;

      if (isTerminal && stripePi.status === 'succeeded' && invoiceTotal > 0 && stripePi.amount >= invoiceTotal) {
        logger.info('[BookingInvoice] Terminal payment already covers invoice, settling OOB instead of new charge', {
          extra: { bookingId, existingPiId: existingPi.stripe_payment_intent_id, piAmount: stripePi.amount, invoiceTotal }
        });

        const oobResult = await finalizeInvoicePaidOutOfBand({
          bookingId,
          terminalPaymentIntentId: existingPi.stripe_payment_intent_id,
          paidVia: 'terminal',
        });

        if (oobResult.success) {
          return {
            invoiceId,
            paymentIntentId: existingPi.stripe_payment_intent_id,
            clientSecret: '',
            status: 'succeeded',
            paidInFull: true,
            hostedInvoiceUrl: oobResult.hostedInvoiceUrl || null,
            invoicePdf: oobResult.invoicePdf || null,
            amountFromBalance: 0,
            amountCharged: 0,
          };
        }
      }
    } catch (piCheckErr: unknown) {
      logger.warn('[BookingInvoice] Could not verify existing PI for terminal detection', {
        extra: { bookingId, piId: existingPi.stripe_payment_intent_id, error: getErrorMessage(piCheckErr) }
      });
    }
  }

  if (invoice.status !== 'draft' && invoice.status !== 'open') {
    throw new Error(`Invoice ${invoiceId} is in unexpected status: ${invoice.status}`);
  }

  let finalizedInvoice: Stripe.Invoice;
  if (invoice.status === 'draft') {
    finalizedInvoice = await stripe.invoices.finalizeInvoice(invoiceId);
  } else {
    finalizedInvoice = invoice;
  }

  if (finalizedInvoice.status === 'paid') {
    const paidInvoice = await stripe.invoices.retrieve(invoiceId, { expand: ['lines.data'] });
    const amountFromBalance = computeBalanceApplied(paidInvoice);
    return {
      invoiceId,
      paymentIntentId: extractPaymentIntentId(paidInvoice) || `invoice-balance-${invoiceId}`,
      clientSecret: '',
      status: 'succeeded',
      paidInFull: true,
      hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
      invoicePdf: paidInvoice.invoice_pdf,
      amountFromBalance,
      amountCharged: 0,
    };
  }

  const invoicePiId = extractPaymentIntentId(finalizedInvoice);
  if (!invoicePiId) {
    throw new Error('Invoice finalization did not create a PaymentIntent');
  }

  const invoiceMeta = finalizedInvoice.metadata || {};
  await stripe.paymentIntents.update(invoicePiId, {
    metadata: {
      ...invoiceMeta,
      source: 'ever_house_app',
    },
    description: finalizedInvoice.description || undefined,
  });

  if (offSession && paymentMethodId) {
    const pi = await stripe.paymentIntents.confirm(invoicePiId, {
      payment_method: paymentMethodId,
      off_session: true,
    });

    const paidInvoice = await stripe.invoices.retrieve(invoiceId, { expand: ['lines.data'] });
    const amountFromBalance = computeBalanceApplied(paidInvoice);
    const amountCharged = paidInvoice.amount_paid - amountFromBalance;

    logger.info('[BookingInvoice] Invoice paid off-session via saved card', {
      extra: { bookingId, invoiceId, paymentIntentId: invoicePiId, status: pi.status }
    });

    return {
      invoiceId,
      paymentIntentId: invoicePiId,
      clientSecret: pi.client_secret || '',
      status: pi.status,
      paidInFull: pi.status === 'succeeded',
      hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
      invoicePdf: paidInvoice.invoice_pdf,
      amountFromBalance,
      amountCharged: Math.max(0, amountCharged),
    };
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(invoicePiId);

  logger.info('[BookingInvoice] Invoice finalized, awaiting payment', {
    extra: { bookingId, invoiceId, paymentIntentId: invoicePiId }
  });

  return {
    invoiceId,
    paymentIntentId: invoicePiId,
    clientSecret: paymentIntent.client_secret || '',
    status: paymentIntent.status,
    paidInFull: false,
    hostedInvoiceUrl: finalizedInvoice.hosted_invoice_url,
    invoicePdf: finalizedInvoice.invoice_pdf,
    amountFromBalance: 0,
    amountCharged: 0,
  };
}

export async function finalizeInvoicePaidOutOfBand(params: {
  bookingId: number;
  terminalPaymentIntentId?: string;
  paidVia?: string;
}): Promise<{
  success: boolean;
  invoiceId?: string;
  hostedInvoiceUrl?: string | null;
  invoicePdf?: string | null;
  error?: string;
}> {
  const stripe = await getStripeClient();
  const { bookingId, terminalPaymentIntentId, paidVia = 'terminal' } = params;

  const invoiceId = await getBookingInvoiceId(bookingId);
  if (!invoiceId) {
    return { success: false, error: `No invoice found for booking ${bookingId}` };
  }

  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (invoice.status === 'paid') {
      return {
        success: true,
        invoiceId,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdf: invoice.invoice_pdf,
      };
    }

    if (invoice.status !== 'draft' && invoice.status !== 'open') {
      return { success: false, error: `Invoice ${invoiceId} is in unexpected status: ${invoice.status}` };
    }

    let openInvoice: Stripe.Invoice;
    if (invoice.status === 'draft') {
      await stripe.invoices.update(invoiceId, { auto_advance: false });
      openInvoice = await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: false });
    } else {
      openInvoice = invoice;
    }

    const piId = extractPaymentIntentId(openInvoice);
    if (piId) {
      try {
        const existingPi = await stripe.paymentIntents.retrieve(piId);
        if (existingPi.status === 'succeeded') {
          const freshInvoice = await stripe.invoices.retrieve(invoiceId);
          if (freshInvoice.status === 'paid') {
            return {
              success: true,
              invoiceId,
              hostedInvoiceUrl: freshInvoice.hosted_invoice_url,
              invoicePdf: freshInvoice.invoice_pdf,
            };
          }
        } else if (existingPi.status === 'processing') {
          logger.warn('[BookingInvoice] Auto-generated PI is processing, waiting before OOB payment', {
            extra: { piId, invoiceId, bookingId }
          });
          await new Promise(resolve => setTimeout(resolve, 3000));
          const recheckPi = await stripe.paymentIntents.retrieve(piId);
          if (recheckPi.status === 'succeeded') {
            const freshInvoice = await stripe.invoices.retrieve(invoiceId);
            if (freshInvoice.status === 'paid') {
              return {
                success: true,
                invoiceId,
                hostedInvoiceUrl: freshInvoice.hosted_invoice_url,
                invoicePdf: freshInvoice.invoice_pdf,
              };
            }
          } else if (recheckPi.status !== 'canceled') {
            await stripe.paymentIntents.cancel(piId);
          }
        } else if (existingPi.status !== 'canceled') {
          await stripe.paymentIntents.cancel(piId);
        }
      } catch (cancelErr: unknown) {
        logger.warn('[BookingInvoice] Could not cancel auto-generated PI', {
          extra: { piId, error: getErrorMessage(cancelErr) }
        });
      }
    }

    const preOobInvoice = await stripe.invoices.retrieve(invoiceId);
    if (preOobInvoice.status === 'paid') {
      logger.info('[BookingInvoice] Invoice already paid before OOB step, skipping', {
        extra: { bookingId, invoiceId }
      });
      return {
        success: true,
        invoiceId,
        hostedInvoiceUrl: preOobInvoice.hosted_invoice_url,
        invoicePdf: preOobInvoice.invoice_pdf,
      };
    }

    await stripe.invoices.pay(invoiceId, { paid_out_of_band: true });

    const oobMeta: Record<string, string> = {
      ...(invoice.metadata || {}),
      paidVia,
      paidOutOfBand: 'true',
    };
    if (terminalPaymentIntentId) {
      oobMeta.terminalPaymentIntentId = terminalPaymentIntentId;
    }
    await stripe.invoices.update(invoiceId, { metadata: oobMeta });

    const paidInvoice = await stripe.invoices.retrieve(invoiceId);

    logger.info('[BookingInvoice] Invoice finalized and paid out-of-band', {
      extra: { bookingId, invoiceId, paidVia, terminalPaymentIntentId }
    });

    return {
      success: true,
      invoiceId,
      hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
      invoicePdf: paidInvoice.invoice_pdf,
    };
  } catch (error: unknown) {
    logger.error('[BookingInvoice] Error finalizing invoice OOB', {
      extra: { bookingId, invoiceId, error: getErrorMessage(error) }
    });
    return { success: false, invoiceId, error: getErrorMessage(error) };
  }
}

export async function voidBookingInvoice(bookingId: number): Promise<{
  success: boolean;
  error?: string;
}> {
  const stripe = await getStripeClient();
  const invoiceId = await getBookingInvoiceId(bookingId);

  if (!invoiceId) {
    return { success: true };
  }

  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (invoice.status === 'draft') {
      await stripe.invoices.del(invoiceId);
      logger.info('[BookingInvoice] Deleted draft invoice for cancelled booking', {
        extra: { bookingId, invoiceId }
      });
    } else if (invoice.status === 'open') {
      await stripe.invoices.voidInvoice(invoiceId);
      logger.info('[BookingInvoice] Voided open invoice for cancelled booking', {
        extra: { bookingId, invoiceId }
      });
    } else if (invoice.status === 'void' || invoice.status === 'uncollectible') {
      logger.info('[BookingInvoice] Invoice already voided or uncollectible, clearing reference', {
        extra: { bookingId, invoiceId, status: invoice.status }
      });
    } else if (invoice.status === 'paid') {
      const paymentIntentId = typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent?.id;
      if (paymentIntentId) {
        try {
          const refund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
            reason: 'requested_by_customer'
          }, {
            idempotencyKey: `refund_void_invoice_${bookingId}_${invoiceId}`
          });
          logger.info('[BookingInvoice] Refunded paid invoice for cancelled booking', {
            extra: { bookingId, invoiceId, refundId: refund.id, amountCents: refund.amount }
          });
        } catch (refundErr: unknown) {
          logger.error('[BookingInvoice] Failed to refund paid invoice', {
            extra: { bookingId, invoiceId, error: getErrorMessage(refundErr) }
          });
          notifyAllStaff(
            'Invoice Refund Failed',
            `Failed to automatically refund paid invoice ${invoiceId} for booking #${bookingId}. Please refund manually in Stripe.`,
            'warning',
            { relatedId: bookingId, relatedType: 'booking' }
          ).catch((err: unknown) => { logger.warn('[BookingInvoice] Failed to notify staff about refund failure', { extra: { bookingId, error: getErrorMessage(err) } }); });
          return { success: false, error: 'Failed to refund paid invoice' };
        }
      } else {
        logger.warn('[BookingInvoice] Paid invoice has no payment intent, cannot auto-refund', {
          extra: { bookingId, invoiceId }
        });
        notifyAllStaff(
          'Paid Invoice — Manual Refund Needed',
          `Cancelled booking #${bookingId} has a paid invoice (${invoiceId}) with no payment intent attached. Please refund manually in Stripe.`,
          'warning',
          { relatedId: bookingId, relatedType: 'booking' }
        ).catch((err: unknown) => { logger.warn('[BookingInvoice] Failed to notify staff about manual refund', { extra: { bookingId, error: getErrorMessage(err) } }); });
        return { success: false, error: 'Invoice has no payment intent for refund' };
      }
    }

    await db.update(bookingRequests).set({ stripeInvoiceId: null, updatedAt: new Date() }).where(eq(bookingRequests.id, bookingId));

    return { success: true };
  } catch (error: unknown) {
    logger.error('[BookingInvoice] Error voiding invoice', {
      extra: { bookingId, invoiceId, error: getErrorMessage(error) }
    });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function recreateDraftInvoiceFromBooking(bookingId: number): Promise<{ success: boolean; invoiceId?: string }> {
  try {
    const bookingResult = await db.execute(sql`SELECT br.user_email, br.session_id, br.trackman_booking_id, br.status
       FROM booking_requests br
       WHERE br.id = ${bookingId} LIMIT 1`);

    if (bookingResult.rows.length === 0) {
      logger.warn('[BookingInvoice] recreateDraftInvoiceFromBooking: booking not found', { extra: { bookingId } });
      return { success: false };
    }

    const booking = bookingResult.rows[0];

    if (booking.status !== 'approved') {
      logger.info('[BookingInvoice] recreateDraftInvoiceFromBooking: booking not approved, skipping', { extra: { bookingId, status: booking.status } });
      return { success: true };
    }

    const userResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${booking.user_email}) LIMIT 1`);

    const stripeCustomerId = (userResult.rows as Array<Record<string, unknown>>)[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      logger.warn('[BookingInvoice] recreateDraftInvoiceFromBooking: no stripe_customer_id for user', { extra: { bookingId, email: booking.user_email } });
      return { success: false };
    }

    const participantResult = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
       FROM booking_participants
       WHERE session_id = ${booking.session_id} AND cached_fee_cents > 0`);

    const feeLineItems: BookingFeeLineItem[] = (participantResult.rows as Array<Record<string, unknown>>).map((row: Record<string, unknown>) => {
      const totalCents = row.cached_fee_cents as number;
      const isGuest = row.participant_type === 'guest';
      return {
        participantId: row.id as number,
        displayName: (row.display_name as string) || 'Unknown',
        participantType: row.participant_type as 'owner' | 'member' | 'guest',
        overageCents: isGuest ? 0 : totalCents,
        guestCents: isGuest ? totalCents : 0,
        totalCents,
      };
    });

    const totalFees = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

    if (totalFees === 0) {
      logger.info('[BookingInvoice] recreateDraftInvoiceFromBooking: no fees, skipping draft creation', { extra: { bookingId } });
      return { success: true };
    }

    const draftResult = await createDraftInvoiceForBooking({
      customerId: stripeCustomerId,
      bookingId,
      sessionId: booking.session_id,
      trackmanBookingId: booking.trackman_booking_id || null,
      feeLineItems,
      purpose: 'booking_fee',
    });

    logger.info('[BookingInvoice] recreateDraftInvoiceFromBooking: draft invoice created', { extra: { bookingId, invoiceId: draftResult.invoiceId, totalCents: draftResult.totalCents } });
    return { success: true, invoiceId: draftResult.invoiceId };
  } catch (err: unknown) {
    logger.error('[BookingInvoice] recreateDraftInvoiceFromBooking failed', { extra: { bookingId, error: getErrorMessage(err) } });
    return { success: false };
  }
}

export async function syncBookingInvoice(bookingId: number, sessionId: number): Promise<void> {
  try {
    const invoiceResult = await db.execute(sql`SELECT br.stripe_invoice_id, br.user_email, br.trackman_booking_id, br.status, br.resource_id,
              COALESCE(r.type, 'simulator') as resource_type
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.id = ${bookingId} LIMIT 1`);
    const booking = invoiceResult.rows[0];
    if (!booking) return;
    const stripeInvoiceId = booking.stripe_invoice_id;

    if (!stripeInvoiceId) {
      if (booking.status !== 'approved') return;

      if (booking.resource_type === 'conference_room') {
        logger.info('[BookingInvoice] syncBookingInvoice: skipping conference room booking', { extra: { bookingId } });
        return;
      }

      const participantResult = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
         FROM booking_participants
         WHERE session_id = ${sessionId} AND cached_fee_cents > 0`);

      const totalFees = (participantResult.rows as Array<Record<string, unknown>>).reduce((sum: number, r: Record<string, unknown>) => sum + (r.cached_fee_cents as number), 0);
      if (totalFees <= 0) return;

      const userResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${booking.user_email}) LIMIT 1`);
      const stripeCustomerId = (userResult.rows as Array<Record<string, unknown>>)[0]?.stripe_customer_id;
      if (!stripeCustomerId) {
        logger.warn('[BookingInvoice] syncBookingInvoice: no stripe_customer_id for user, cannot create draft invoice', { extra: { bookingId, email: booking.user_email } });
        return;
      }

      const feeLineItems: BookingFeeLineItem[] = (participantResult.rows as Array<Record<string, unknown>>).map((row: Record<string, unknown>) => {
        const totalCents = row.cached_fee_cents as number;
        const isGuest = row.participant_type === 'guest';
        return {
          participantId: row.id as number,
          displayName: (row.display_name as string) || 'Unknown',
          participantType: row.participant_type as 'owner' | 'member' | 'guest',
          overageCents: isGuest ? 0 : totalCents,
          guestCents: isGuest ? totalCents : 0,
          totalCents,
        };
      });

      const draftResult = await createDraftInvoiceForBooking({
        customerId: stripeCustomerId as string,
        bookingId,
        sessionId,
        trackmanBookingId: booking.trackman_booking_id || null,
        feeLineItems,
        purpose: 'booking_fee',
      });

      logger.info('[BookingInvoice] syncBookingInvoice created draft invoice (none existed, fees > $0)', {
        extra: { bookingId, sessionId, invoiceId: draftResult.invoiceId, totalCents: draftResult.totalCents }
      });
      return;
    }

    const stripe = await getStripeClient();
    const invoice = await stripe.invoices.retrieve(stripeInvoiceId);
    if (invoice.status !== 'draft') {
      if (invoice.status === 'open') {
        logger.warn('[BookingInvoice] syncBookingInvoice skipped: invoice is open (already finalized). Manual review may be needed.', {
          extra: { bookingId, invoiceId: stripeInvoiceId }
        });
      } else if (invoice.status === 'paid') {
        logger.warn('[BookingInvoice] syncBookingInvoice skipped: invoice already paid. Roster changed after payment — staff review needed.', {
          extra: { bookingId, invoiceId: stripeInvoiceId }
        });
        notifyAllStaff(
          'Roster Changed After Payment',
          `Booking #${bookingId} roster was modified after invoice ${stripeInvoiceId} was already paid. Staff review needed.`,
          'warning',
          { relatedId: bookingId, relatedType: 'booking' }
        ).catch((err: unknown) => { logger.warn('[BookingInvoice] Failed to notify staff about roster change after payment', { extra: { bookingId, error: getErrorMessage(err) } }); });
      } else if (invoice.status === 'void' || invoice.status === 'uncollectible') {
        logger.info('[BookingInvoice] syncBookingInvoice skipped: invoice is void/uncollectible', {
          extra: { bookingId, invoiceId: stripeInvoiceId }
        });
      }
      return;
    }

    const participantResult = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
       FROM booking_participants
       WHERE session_id = ${sessionId} AND cached_fee_cents > 0`);

    const feeLineItems: BookingFeeLineItem[] = (participantResult.rows as Array<Record<string, unknown>>).map((row: Record<string, unknown>) => {
      const totalCents = row.cached_fee_cents as number;
      const isGuest = row.participant_type === 'guest';
      return {
        participantId: row.id as number,
        displayName: (row.display_name as string) || 'Unknown',
        participantType: row.participant_type as 'owner' | 'member' | 'guest',
        overageCents: isGuest ? 0 : totalCents,
        guestCents: isGuest ? totalCents : 0,
        totalCents,
      };
    });

    const totalFees = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

    if (totalFees > 0) {
      await updateDraftInvoiceLineItems({ bookingId, sessionId, feeLineItems });
      logger.info('[BookingInvoice] Draft invoice synced', {
        extra: { bookingId, sessionId, invoiceId: stripeInvoiceId, totalFees, lineItems: feeLineItems.length }
      });
    } else {
      await stripe.invoices.del(stripeInvoiceId);
      await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
      logger.info('[BookingInvoice] Deleted draft invoice (fees now 0)', {
        extra: { bookingId, sessionId, invoiceId: stripeInvoiceId }
      });
    }
  } catch (err: unknown) {
    logger.warn('[BookingInvoice] Non-blocking: syncBookingInvoice failed', {
      extra: { error: getErrorMessage(err), bookingId, sessionId }
    });
  }
}

export async function isBookingInvoicePaid(bookingId: number): Promise<{ locked: boolean; invoiceId?: string; reason?: string }> {
  try {
    const result = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
    const invoiceId = (result.rows as Array<Record<string, unknown>>)[0]?.stripe_invoice_id as string;
    if (!invoiceId) return { locked: false };

    const stripe = await getStripeClient();
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.status === 'paid') {
      return { locked: true, invoiceId, reason: 'Invoice has been paid' };
    }
    return { locked: false };
  } catch (err) {
    logger.warn('[BookingInvoice] Failed to check if booking invoice is paid', { error: err instanceof Error ? err.message : err });
    return { locked: false };
  }
}

function extractPaymentIntentId(invoice: Stripe.Invoice): string | null {
  const rawPi = (invoice as unknown as { payment_intent: string | Stripe.PaymentIntent | null }).payment_intent;
  if (typeof rawPi === 'string') return rawPi;
  if (rawPi && typeof rawPi === 'object' && 'id' in rawPi) return rawPi.id;
  return null;
}

function computeBalanceApplied(invoice: Stripe.Invoice): number {
  const startingBalance = invoice.starting_balance || 0;
  const endingBalance = invoice.ending_balance || 0;
  return Math.max(0, Math.abs(startingBalance) - Math.abs(endingBalance));
}
