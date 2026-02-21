import { getStripeClient } from '../stripe/client';
import { pool } from '../db';
import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
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
      });
    }
  }
}

export async function createDraftInvoiceForBooking(
  params: DraftInvoiceParams
): Promise<DraftInvoiceResult> {
  const stripe = await getStripeClient();
  const { customerId, bookingId, sessionId, trackmanBookingId, feeLineItems } = params;

  const existingResult = await pool.query(
    `SELECT stripe_invoice_id FROM booking_requests WHERE id = $1 LIMIT 1`,
    [bookingId]
  );
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
  });

  await addLineItemsToInvoice(stripe, invoice.id, customerId, feeLineItems);

  const totalCents = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

  await pool.query(
    `UPDATE booking_requests SET stripe_invoice_id = $1, updated_at = NOW() WHERE id = $2`,
    [invoice.id, bookingId]
  );

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

  const result = await pool.query(
    `SELECT stripe_invoice_id FROM booking_requests WHERE id = $1 LIMIT 1`,
    [bookingId]
  );
  const invoiceId = result.rows[0]?.stripe_invoice_id;

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

  const existingLines = invoice.lines?.data || [];
  for (const line of existingLines) {
    if (line.invoice_item && typeof line.invoice_item === 'string') {
      await stripe.invoiceItems.del(line.invoice_item);
    }
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || '';
  await addLineItemsToInvoice(stripe, invoiceId, customerId, feeLineItems);

  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);
  const totalCents = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

  const trackmanResult = await pool.query(
    `SELECT trackman_booking_id FROM booking_requests WHERE id = $1 LIMIT 1`,
    [bookingId]
  );
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
  const result = await pool.query(
    `SELECT stripe_invoice_id FROM booking_requests WHERE id = $1 LIMIT 1`,
    [bookingId]
  );
  return result.rows[0]?.stripe_invoice_id || null;
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
  } catch {
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
      openInvoice = await stripe.invoices.finalizeInvoice(invoiceId);
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
        } else if (existingPi.status !== 'canceled') {
          await stripe.paymentIntents.cancel(piId);
        }
      } catch (cancelErr: unknown) {
        logger.warn('[BookingInvoice] Could not cancel auto-generated PI', {
          extra: { piId, error: getErrorMessage(cancelErr) }
        });
      }
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
      logger.warn('[BookingInvoice] Cannot void paid invoice', {
        extra: { bookingId, invoiceId }
      });
      return { success: false, error: 'Invoice already paid' };
    }

    await pool.query(
      `UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = $1`,
      [bookingId]
    );

    return { success: true };
  } catch (error: unknown) {
    logger.error('[BookingInvoice] Error voiding invoice', {
      extra: { bookingId, invoiceId, error: getErrorMessage(error) }
    });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function syncBookingInvoice(bookingId: number, sessionId: number): Promise<void> {
  try {
    const invoiceResult = await pool.query(
      `SELECT stripe_invoice_id FROM booking_requests WHERE id = $1 LIMIT 1`,
      [bookingId]
    );
    const stripeInvoiceId = invoiceResult.rows[0]?.stripe_invoice_id;
    if (!stripeInvoiceId) return;

    const stripe = await getStripeClient();
    const invoice = await stripe.invoices.retrieve(stripeInvoiceId);
    if (invoice.status !== 'draft') return;

    const participantResult = await pool.query(
      `SELECT id, display_name, participant_type, cached_fee_cents
       FROM booking_participants
       WHERE session_id = $1 AND cached_fee_cents > 0`,
      [sessionId]
    );

    const feeLineItems: BookingFeeLineItem[] = participantResult.rows.map((row: { id: number; display_name: string; participant_type: string; cached_fee_cents: number }) => {
      const totalCents = row.cached_fee_cents;
      const isGuest = row.participant_type === 'guest';
      return {
        participantId: row.id,
        displayName: row.display_name || 'Unknown',
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
      await pool.query(
        `UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = $1`,
        [bookingId]
      );
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
