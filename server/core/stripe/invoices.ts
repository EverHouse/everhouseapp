import { getStripeClient } from './client';
import Stripe from 'stripe';

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
      collection_method: 'send_invoice',
      days_until_due: 30,
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

    console.log(`[Stripe Invoices] Created draft invoice ${invoice.id} for customer ${customerId}`);

    return {
      success: true,
      invoice: mapInvoice(updatedInvoice),
    };
  } catch (error: any) {
    console.error('[Stripe Invoices] Error creating invoice:', error);
    return {
      success: false,
      error: error.message,
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

    console.log(`[Stripe Invoices] Generated preview for customer ${customerId}, price ${priceId}`);

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
  } catch (error: any) {
    console.error('[Stripe Invoices] Error previewing invoice:', error);
    return {
      success: false,
      error: error.message,
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

    console.log(`[Stripe Invoices] Finalized and sent invoice ${invoiceId}`);

    return {
      success: true,
      invoice: mapInvoice(finalized),
    };
  } catch (error: any) {
    console.error('[Stripe Invoices] Error finalizing invoice:', error);
    return {
      success: false,
      error: error.message,
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

    console.log(`[Stripe Invoices] Listed ${invoices.data.length} invoices for customer ${customerId}`);

    return {
      success: true,
      invoices: invoices.data.map(mapInvoice),
    };
  } catch (error: any) {
    console.error('[Stripe Invoices] Error listing invoices:', error);
    return {
      success: false,
      error: error.message,
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
  } catch (error: any) {
    console.error('[Stripe Invoices] Error getting invoice:', error);
    return {
      success: false,
      error: error.message,
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

    console.log(`[Stripe Invoices] Voided invoice ${invoiceId}`);

    return { success: true };
  } catch (error: any) {
    console.error('[Stripe Invoices] Error voiding invoice:', error);
    return {
      success: false,
      error: error.message,
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
