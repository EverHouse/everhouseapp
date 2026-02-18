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
          price: item.priceId,
          quantity: item.quantity || 1,
        });
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
      transactions: result.rows.map(row => ({
        id: row.id,
        type: row.type,
        amountCents: parseInt(row.amount_cents),
        currency: row.currency,
        status: row.status,
        description: row.description,
        createdAt: new Date(row.created_at),
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
