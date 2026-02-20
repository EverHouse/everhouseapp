import { getStripeClient } from './client';
import { pool } from '../db';
import Stripe from 'stripe';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
export interface InvoiceItem {
  priceId?: string;
  quantity?: number;
  amountCents?: number;
  description?: string;
}

export interface CreateInvoiceParams {
  customerId: string;
  items: InvoiceItem[];
  description?: string;
  metadata?: Record<string, string>;
}

export interface InvoiceResult {
  id: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  customerEmail: string | null;
  description: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  created: Date;
  dueDate: Date | null;
  paidAt: Date | null;
  lines: Array<{
    description: string | null;
    amount: number;
    quantity: number | null;
  }>;
}

export async function createInvoice(params: CreateInvoiceParams): Promise<{
  success: boolean;
  invoice?: InvoiceResult;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    const { customerId, items, description, metadata = {} } = params;

    if (!items || items.length === 0) {
      return { success: false, error: 'At least one invoice item is required' };
    }

    const invoice = await stripe.invoices.create({
      customer: customerId,
      description: description || undefined,
      collection_method: 'charge_automatically',
      metadata: {
        ...metadata,
        source: 'ever_house_app',
      },
    });

    for (const item of items) {
      if (item.priceId) {
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
          price: item.priceId as string,
          quantity: item.quantity ?? 1,
        } as any);
      } else if (item.amountCents && item.description) {
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
          amount: item.amountCents,
          currency: 'usd',
          description: item.description,
        });
      }
    }

    const updatedInvoice = await stripe.invoices.retrieve(invoice.id, {
      expand: ['lines.data'],
    });

    logger.info(`[Stripe Invoices] Created draft invoice ${invoice.id} for customer ${customerId}`);

    return {
      success: true,
      invoice: mapInvoice(updatedInvoice),
    };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error creating invoice:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

export async function previewInvoice(params: {
  customerId: string;
  priceId: string;
}): Promise<{
  success: boolean;
  preview?: {
    amountDue: number;
    currency: string;
    lines: Array<{
      description: string | null;
      amount: number;
      quantity: number | null;
    }>;
    periodStart: Date;
    periodEnd: Date;
  };
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    const { customerId, priceId } = params;

    const preview = await stripe.invoices.createPreview({
      customer: customerId,
      subscription_details: {
        items: [{ price: priceId }],
      },
    });

    logger.info(`[Stripe Invoices] Generated preview for customer ${customerId}, price ${priceId}`);

    return {
      success: true,
      preview: {
        amountDue: preview.amount_due,
        currency: preview.currency,
        lines: preview.lines.data.map(line => ({
          description: line.description,
          amount: line.amount,
          quantity: line.quantity,
        })),
        periodStart: new Date(preview.period_start * 1000),
        periodEnd: new Date(preview.period_end * 1000),
      },
    };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error previewing invoice:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

export async function finalizeAndSendInvoice(invoiceId: string): Promise<{
  success: boolean;
  invoice?: InvoiceResult;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();

    const finalized = await stripe.invoices.finalizeInvoice(invoiceId);

    await stripe.invoices.sendInvoice(invoiceId);

    logger.info(`[Stripe Invoices] Finalized and sent invoice ${invoiceId}`);

    return {
      success: true,
      invoice: mapInvoice(finalized),
    };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error finalizing invoice:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

export async function listCustomerInvoices(customerId: string): Promise<{
  success: boolean;
  invoices?: InvoiceResult[];
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();

    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 100,
      expand: ['data.lines.data'],
    });

    logger.info(`[Stripe Invoices] Listed ${invoices.data.length} invoices for customer ${customerId}`);

    return {
      success: true,
      invoices: invoices.data.map(mapInvoice),
    };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error listing invoices:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

export async function getInvoice(invoiceId: string): Promise<{
  success: boolean;
  invoice?: InvoiceResult;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();

    const invoice = await stripe.invoices.retrieve(invoiceId, {
      expand: ['lines.data'],
    });

    return {
      success: true,
      invoice: mapInvoice(invoice),
    };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error getting invoice:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

export async function voidInvoice(invoiceId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();

    await stripe.invoices.voidInvoice(invoiceId);

    logger.info(`[Stripe Invoices] Voided invoice ${invoiceId}`);

    return { success: true };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error voiding invoice:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Charge a one-time fee via invoice with auto-pay.
 * This automatically applies customer balance credits before charging the card.
 */
export async function chargeOneTimeFee(params: {
  customerId: string;
  amountCents: number;
  description: string;
  metadata?: Record<string, string>;
}): Promise<{
  success: boolean;
  invoice?: InvoiceResult;
  amountFromBalance?: number;
  amountCharged?: number;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    const { customerId, amountCents, description, metadata = {} } = params;

    // Create invoice first (in draft state)
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'charge_automatically',
      auto_advance: true,
      pending_invoice_items_behavior: 'exclude',
      metadata: {
        ...metadata,
        source: 'ever_house_app',
        fee_type: 'one_time',
      },
    });

    // Create invoice item attached to this specific invoice
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: amountCents,
      currency: 'usd',
      description,
    });

    // Finalize the invoice - this applies customer balance automatically
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    // If there's still an amount due after balance is applied, pay it
    if (finalizedInvoice.amount_due > 0 && finalizedInvoice.status === 'open') {
      try {
        await stripe.invoices.pay(invoice.id);
      } catch (payError: unknown) {
        // Payment might fail if no card on file - invoice remains open
        logger.warn(`[Stripe Invoices] Auto-pay failed for invoice ${invoice.id}: ${getErrorMessage(payError)}`);
      }
    }

    // Retrieve final state
    const paidInvoice = await stripe.invoices.retrieve(invoice.id, {
      expand: ['lines.data'],
    });

    // Calculate how much came from balance vs card
    const startingBalance = paidInvoice.starting_balance || 0;
    const endingBalance = paidInvoice.ending_balance || 0;
    const amountFromBalance = Math.max(0, Math.abs(startingBalance) - Math.abs(endingBalance));
    const amountCharged = paidInvoice.amount_paid - amountFromBalance;

    logger.info(`[Stripe Invoices] Charged one-time fee ${invoice.id}: $${(amountCents / 100).toFixed(2)} (balance: $${(amountFromBalance / 100).toFixed(2)}, card: $${(amountCharged / 100).toFixed(2)})`);

    return {
      success: true,
      invoice: mapInvoice(paidInvoice),
      amountFromBalance,
      amountCharged: Math.max(0, amountCharged),
    };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error charging one-time fee:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

function mapInvoice(invoice: Stripe.Invoice): InvoiceResult {
  return {
    id: invoice.id,
    status: invoice.status || 'draft',
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    customerEmail: invoice.customer_email,
    description: invoice.description,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
    invoicePdf: invoice.invoice_pdf,
    created: new Date(invoice.created * 1000),
    dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    paidAt: invoice.status_transitions?.paid_at 
      ? new Date(invoice.status_transitions.paid_at * 1000) 
      : null,
    lines: invoice.lines?.data.map(line => ({
      description: line.description,
      amount: line.amount,
      quantity: line.quantity,
    })) || [],
  };
}

export interface BookingFeeLineItem {
  participantId?: number;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  overageCents: number;
  guestCents: number;
  totalCents: number;
}

export interface CreateBookingFeeInvoiceParams {
  customerId: string;
  bookingId: number;
  sessionId: number;
  trackmanBookingId?: string | null;
  feeLineItems: BookingFeeLineItem[];
  metadata?: Record<string, string>;
  purpose?: string;
  offSession?: boolean;
  paymentMethodId?: string;
}

export interface BookingFeeInvoiceResult {
  invoiceId: string;
  paymentIntentId: string;
  clientSecret: string;
  status: string;
  paidInFull?: boolean;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  amountFromBalance?: number;
  amountCharged?: number;
}

export async function createBookingFeeInvoice(
  params: CreateBookingFeeInvoiceParams
): Promise<BookingFeeInvoiceResult> {
  const stripe = await getStripeClient();
  const {
    customerId,
    bookingId,
    sessionId,
    trackmanBookingId,
    feeLineItems,
    metadata = {},
    purpose = 'booking_fee',
    offSession = false,
    paymentMethodId,
  } = params;

  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);
  const totalCents = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

  const bookingRef = trackmanBookingId ? `TM-${trackmanBookingId}` : `#${bookingId}`;
  const description = `Booking ${bookingRef} fees - Overage: $${(totalOverageCents / 100).toFixed(2)}, Guest fees: $${(totalGuestCents / 100).toFixed(2)}`;

  const invoiceMetadata: Record<string, string> = {
    ...metadata,
    source: 'ever_house_app',
    purpose,
    bookingId: bookingId.toString(),
    sessionId: sessionId.toString(),
    overageCents: totalOverageCents.toString(),
    guestCents: totalGuestCents.toString(),
  };
  if (trackmanBookingId) {
    invoiceMetadata.trackmanBookingId = String(trackmanBookingId);
  }

  const invoice = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false,
    collection_method: 'charge_automatically',
    description,
    metadata: invoiceMetadata,
    pending_invoice_items_behavior: 'exclude',
  });

  try {
    for (const li of feeLineItems) {
      if (li.totalCents <= 0) continue;

      if (li.overageCents > 0) {
        const overageDesc = li.participantType === 'owner'
          ? `Overage fee — ${li.displayName}`
          : `Overage fee — ${li.displayName} (${li.participantType})`;
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
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
          invoice: invoice.id,
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

    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    if (finalizedInvoice.status === 'paid') {
      const paidInvoice = await stripe.invoices.retrieve(invoice.id, { expand: ['lines.data'] });
      const startingBalance = paidInvoice.starting_balance || 0;
      const endingBalance = paidInvoice.ending_balance || 0;
      const amountFromBalance = Math.max(0, Math.abs(startingBalance) - Math.abs(endingBalance));

      logger.info(`[Stripe Invoices] Booking fee invoice ${invoice.id} fully paid via customer balance: $${(totalCents / 100).toFixed(2)}`, {
        extra: { bookingId, sessionId, amountFromBalance }
      });

      return {
        invoiceId: invoice.id,
        paymentIntentId: `invoice-balance-${invoice.id}`,
        clientSecret: '',
        status: 'succeeded',
        paidInFull: true,
        hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
        invoicePdf: paidInvoice.invoice_pdf,
        amountFromBalance,
        amountCharged: 0,
      };
    }

    const invoicePiId = typeof (finalizedInvoice as unknown as { payment_intent: string | Stripe.PaymentIntent | null }).payment_intent === 'string'
      ? (finalizedInvoice as unknown as { payment_intent: string }).payment_intent
      : ((finalizedInvoice as unknown as { payment_intent: Stripe.PaymentIntent | null }).payment_intent)?.id;

    if (!invoicePiId) {
      throw new Error('Invoice finalization did not create a PaymentIntent');
    }

    await stripe.paymentIntents.update(invoicePiId, {
      metadata: invoiceMetadata,
      description,
    });

    if (offSession && paymentMethodId) {
      const pi = await stripe.paymentIntents.confirm(invoicePiId, {
        payment_method: paymentMethodId,
        off_session: true,
      });

      const paidInvoice = await stripe.invoices.retrieve(invoice.id, { expand: ['lines.data'] });
      const startingBalance = paidInvoice.starting_balance || 0;
      const endingBalance = paidInvoice.ending_balance || 0;
      const amountFromBalance = Math.max(0, Math.abs(startingBalance) - Math.abs(endingBalance));
      const amountCharged = paidInvoice.amount_paid - amountFromBalance;

      logger.info(`[Stripe Invoices] Booking fee invoice ${invoice.id} charged off-session: $${(totalCents / 100).toFixed(2)} (PI: ${invoicePiId})`, {
        extra: { bookingId, sessionId, status: pi.status }
      });

      return {
        invoiceId: invoice.id,
        paymentIntentId: invoicePiId,
        clientSecret: pi.client_secret || '',
        status: pi.status,
        hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
        invoicePdf: paidInvoice.invoice_pdf,
        amountFromBalance,
        amountCharged: Math.max(0, amountCharged),
      };
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(invoicePiId);

    logger.info(`[Stripe Invoices] Booking fee invoice ${invoice.id} created: $${(totalCents / 100).toFixed(2)} with ${feeLineItems.length} line items (PI: ${invoicePiId})`, {
      extra: { bookingId, sessionId }
    });

    return {
      invoiceId: invoice.id,
      paymentIntentId: invoicePiId,
      clientSecret: paymentIntent.client_secret || '',
      status: paymentIntent.status,
      hostedInvoiceUrl: finalizedInvoice.hosted_invoice_url,
      invoicePdf: finalizedInvoice.invoice_pdf,
    };
  } catch (error: unknown) {
    try {
      const currentInvoice = await stripe.invoices.retrieve(invoice.id);
      if (currentInvoice.status === 'draft') {
        await stripe.invoices.del(invoice.id);
        logger.info(`[Stripe Invoices] Deleted draft invoice ${invoice.id} after error`);
      } else if (currentInvoice.status === 'open') {
        await stripe.invoices.voidInvoice(invoice.id);
        logger.info(`[Stripe Invoices] Voided open invoice ${invoice.id} after error`);
      }
    } catch (cleanupErr: unknown) {
      logger.error(`[Stripe Invoices] Failed to clean up invoice ${invoice.id}:`, { extra: { detail: getErrorMessage(cleanupErr) } });
    }
    throw error;
  }
}

export async function createDraftBookingFeeInvoice(
  params: CreateBookingFeeInvoiceParams
): Promise<{ invoiceId: string }> {
  const stripe = await getStripeClient();
  const {
    customerId,
    bookingId,
    sessionId,
    trackmanBookingId,
    feeLineItems,
    metadata = {},
    purpose = 'booking_fee',
  } = params;

  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);

  const bookingRef = trackmanBookingId ? `TM-${trackmanBookingId}` : `#${bookingId}`;
  const description = `Booking ${bookingRef} fees - Overage: $${(totalOverageCents / 100).toFixed(2)}, Guest fees: $${(totalGuestCents / 100).toFixed(2)}`;

  const invoiceMetadata: Record<string, string> = {
    ...metadata,
    source: 'ever_house_app',
    purpose,
    bookingId: bookingId.toString(),
    sessionId: sessionId.toString(),
    overageCents: totalOverageCents.toString(),
    guestCents: totalGuestCents.toString(),
    terminalDraft: 'true',
  };
  if (trackmanBookingId) {
    invoiceMetadata.trackmanBookingId = String(trackmanBookingId);
  }

  const invoice = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false,
    collection_method: 'charge_automatically',
    description,
    metadata: invoiceMetadata,
    pending_invoice_items_behavior: 'exclude',
  });

  for (const li of feeLineItems) {
    if (li.totalCents <= 0) continue;

    if (li.overageCents > 0) {
      const overageDesc = li.participantType === 'owner'
        ? `Overage fee — ${li.displayName}`
        : `Overage fee — ${li.displayName} (${li.participantType})`;
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoice.id,
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
        invoice: invoice.id,
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

  logger.info(`[Stripe Invoices] Created DRAFT booking fee invoice ${invoice.id} for terminal payment`, {
    extra: { bookingId, sessionId, lineItems: feeLineItems.length }
  });

  return { invoiceId: invoice.id };
}

export async function finalizeInvoicePaidOutOfBand(invoiceId: string): Promise<{
  success: boolean;
  hostedInvoiceUrl?: string | null;
  invoicePdf?: string | null;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (invoice.status === 'paid') {
      return {
        success: true,
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

    const rawPi = openInvoice.payment_intent;
    const piId = typeof rawPi === 'string' ? rawPi : rawPi?.id;

    if (piId) {
      try {
        const existingPi = await stripe.paymentIntents.retrieve(piId);
        if (existingPi.status === 'succeeded') {
          logger.info(`[Stripe Invoices] Invoice PI ${piId} already succeeded — invoice may have been auto-collected. Skipping OOB.`, { extra: { invoiceId } });
          const freshInvoice = await stripe.invoices.retrieve(invoiceId);
          if (freshInvoice.status === 'paid') {
            return {
              success: true,
              hostedInvoiceUrl: freshInvoice.hosted_invoice_url,
              invoicePdf: freshInvoice.invoice_pdf,
            };
          }
        } else if (existingPi.status !== 'canceled') {
          await stripe.paymentIntents.cancel(piId);
        }
      } catch (cancelErr: unknown) {
        logger.warn(`[Stripe Invoices] Could not cancel invoice PI ${piId} for out-of-band payment`, { extra: { detail: getErrorMessage(cancelErr) } });
      }
    }

    const paidInvoice = await stripe.invoices.pay(invoiceId, {
      paid_out_of_band: true,
    });

    logger.info(`[Stripe Invoices] Invoice ${invoiceId} finalized and marked paid out-of-band`, {
      extra: { status: paidInvoice.status }
    });

    return {
      success: true,
      hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
      invoicePdf: paidInvoice.invoice_pdf,
    };
  } catch (error: unknown) {
    logger.error(`[Stripe Invoices] Error finalizing invoice ${invoiceId} out-of-band:`, { error: error });
    return { success: false, error: getErrorMessage(error) };
  }
}

export interface CachedTransaction {
  id: string;
  type: string;
  amountCents: number;
  currency: string;
  status: string;
  description: string;
  createdAt: Date;
}

export async function getCustomerPaymentHistory(customerId: string, limit = 50): Promise<{
  success: boolean;
  transactions?: CachedTransaction[];
  error?: string;
}> {
  try {
    const result = await pool.query(
      `SELECT 
        stripe_id as id,
        object_type as type,
        amount_cents,
        currency,
        status,
        COALESCE(description, 'Payment') as description,
        created_at
      FROM stripe_transaction_cache
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
      [customerId, limit]
    );
    
    return {
      success: true,
      transactions: result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        type: row.type as string,
        amountCents: parseInt(String(row.amount_cents)),
        currency: row.currency as string,
        status: row.status as string,
        description: row.description as string,
        createdAt: new Date(row.created_at as string),
      })),
    };
  } catch (error: unknown) {
    logger.error('[Stripe Invoices] Error getting cached payment history:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}
