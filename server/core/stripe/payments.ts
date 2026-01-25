import { pool } from '../db';
import { db } from '../../db';
import { billingAuditLog } from '../../../shared/schema';
import { getStripeClient } from './client';
import { getOrCreateStripeCustomer } from './customers';

export type PaymentPurpose = 'guest_fee' | 'overage_fee' | 'one_time_purchase';

export interface CreatePaymentIntentParams {
  userId: string;
  email: string;
  memberName: string;
  amountCents: number;
  purpose: PaymentPurpose;
  bookingId?: number;
  sessionId?: number;
  description: string;
  metadata?: Record<string, string>;
  productId?: string;
  productName?: string;
  stripeCustomerId?: string;
}

export interface PaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  customerId: string;
  status: string;
}

export async function createPaymentIntent(
  params: CreatePaymentIntentParams
): Promise<PaymentIntentResult> {
  const {
    userId,
    email,
    memberName,
    amountCents,
    purpose,
    bookingId,
    sessionId,
    description,
    metadata = {},
    productId,
    productName,
    stripeCustomerId
  } = params;

  let customerId: string;
  if (stripeCustomerId) {
    customerId = stripeCustomerId;
  } else {
    const result = await getOrCreateStripeCustomer(userId, email, memberName);
    customerId = result.customerId;
  }

  const stripe = await getStripeClient();

  const stripeMetadata: Record<string, string> = {
    userId,
    email,
    purpose,
    source: 'even_house_app'
  };
  
  if (bookingId) stripeMetadata.bookingId = bookingId.toString();
  if (sessionId) stripeMetadata.sessionId = sessionId.toString();
  if (metadata?.participantFees) stripeMetadata.participantFees = metadata.participantFees;
  if (productId) stripeMetadata.productId = productId;
  if (productName) stripeMetadata.productName = productName;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer: customerId,
    description: description,
    metadata: stripeMetadata,
    automatic_payment_methods: {
      enabled: true,
    },
  });

  const dbUserId = userId === 'guest' ? `guest-${customerId}` : userId;
  
  await pool.query(
    `INSERT INTO stripe_payment_intents 
     (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status, product_id, product_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [dbUserId, paymentIntent.id, customerId, amountCents, purpose, bookingId || null, sessionId || null, description, 'pending', productId || null, productName || null]
  );

  console.log(`[Stripe] Created PaymentIntent ${paymentIntent.id} for ${purpose}: $${(amountCents / 100).toFixed(2)}${productName ? ` (${productName})` : ''}`);

  return {
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret!,
    customerId,
    status: paymentIntent.status
  };
}

export async function confirmPaymentSuccess(
  paymentIntentId: string,
  performedBy: string,
  performedByName?: string,
  txClient?: any
): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return { success: false, error: `Payment status is ${paymentIntent.status}, not succeeded` };
    }

    const queryClient = txClient || pool;

    await queryClient.query(
      `UPDATE stripe_payment_intents 
       SET status = 'succeeded', updated_at = NOW() 
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );

    const localRecord = await queryClient.query(
      'SELECT * FROM stripe_payment_intents WHERE stripe_payment_intent_id = $1',
      [paymentIntentId]
    );

    if (localRecord.rows[0]) {
      const record = localRecord.rows[0];
      
      await db.insert(billingAuditLog).values({
        memberEmail: paymentIntent.metadata.email || '',
        hubspotDealId: null,
        actionType: 'stripe_payment_succeeded',
        actionDetails: {
          paymentIntentId,
          amountCents: record.amount_cents,
          purpose: record.purpose,
          bookingId: record.booking_id,
          sessionId: record.session_id,
          stripeCustomerId: record.stripe_customer_id
        },
        newValue: `Stripe payment of $${(record.amount_cents / 100).toFixed(2)} for ${record.purpose}`,
        performedBy,
        performedByName
      });
    }

    console.log(`[Stripe] Payment ${paymentIntentId} confirmed as succeeded`);
    return { success: true };
  } catch (error: any) {
    console.error('[Stripe] Error confirming payment:', error);
    return { success: false, error: error.message };
  }
}

export async function getPaymentIntentStatus(
  paymentIntentId: string
): Promise<{ status: string; amountCents: number; purpose: string } | null> {
  const result = await pool.query(
    'SELECT status, amount_cents, purpose FROM stripe_payment_intents WHERE stripe_payment_intent_id = $1',
    [paymentIntentId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    status: result.rows[0].status,
    amountCents: result.rows[0].amount_cents,
    purpose: result.rows[0].purpose
  };
}

export async function cancelPaymentIntent(
  paymentIntentId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = await getStripeClient();
    await stripe.paymentIntents.cancel(paymentIntentId);

    await pool.query(
      `UPDATE stripe_payment_intents 
       SET status = 'canceled', updated_at = NOW() 
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntentId]
    );

    console.log(`[Stripe] Payment ${paymentIntentId} canceled`);
    return { success: true };
  } catch (error: any) {
    console.error('[Stripe] Error canceling payment:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Charge a fee using invoice (applies customer balance automatically).
 * Use this for backend-initiated charges like overage fees and guest fees.
 * Customer balance is applied first before charging the card.
 */
export async function chargeWithBalance(params: {
  stripeCustomerId: string;
  email: string;
  amountCents: number;
  purpose: PaymentPurpose;
  description: string;
  bookingId?: number;
  sessionId?: number;
  metadata?: Record<string, string>;
}): Promise<{
  success: boolean;
  invoiceId?: string;
  amountFromBalance: number;
  amountCharged: number;
  error?: string;
}> {
  const { stripeCustomerId, email, amountCents, purpose, description, bookingId, sessionId, metadata = {} } = params;

  try {
    const stripe = await getStripeClient();

    // Create invoice first (in draft state)
    const invoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: 'charge_automatically',
      auto_advance: true,
      pending_invoice_items_behavior: 'exclude',
      metadata: {
        ...metadata,
        email,
        purpose,
        source: 'ever_house_app',
        ...(bookingId ? { bookingId: bookingId.toString() } : {}),
        ...(sessionId ? { sessionId: sessionId.toString() } : {}),
      },
    });

    // Create invoice item attached to this specific invoice
    await stripe.invoiceItems.create({
      customer: stripeCustomerId,
      invoice: invoice.id,
      amount: amountCents,
      currency: 'usd',
      description,
    });

    // Finalize - this applies customer balance credits automatically
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    // Attempt to pay any remaining balance
    if (finalizedInvoice.amount_due > 0 && finalizedInvoice.status === 'open') {
      try {
        await stripe.invoices.pay(invoice.id);
      } catch (payError: any) {
        console.warn(`[Stripe] Auto-pay failed for invoice ${invoice.id}: ${payError.message}`);
      }
    }

    // Get final state
    const paidInvoice = await stripe.invoices.retrieve(invoice.id);

    // Calculate balance usage
    const startingBalance = paidInvoice.starting_balance || 0;
    const endingBalance = paidInvoice.ending_balance || 0;
    // Starting balance is negative (credit), ending is also negative
    // Amount from balance = how much the credit decreased
    const amountFromBalance = Math.max(0, Math.abs(startingBalance) - Math.abs(endingBalance));
    const amountCharged = Math.max(0, (paidInvoice.amount_paid || 0) - amountFromBalance);

    // Log to database
    await pool.query(
      `INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [email, `invoice-${invoice.id}`, stripeCustomerId, amountCents, purpose, bookingId || null, sessionId || null, description, paidInvoice.status === 'paid' ? 'succeeded' : paidInvoice.status]
    );

    console.log(`[Stripe] Charged ${purpose} via invoice ${invoice.id}: $${(amountCents / 100).toFixed(2)} (balance: $${(amountFromBalance / 100).toFixed(2)}, card: $${(amountCharged / 100).toFixed(2)})`);

    return {
      success: paidInvoice.status === 'paid',
      invoiceId: invoice.id,
      amountFromBalance,
      amountCharged,
      error: paidInvoice.status !== 'paid' ? `Invoice status: ${paidInvoice.status}` : undefined,
    };
  } catch (error: any) {
    console.error(`[Stripe] Error charging ${purpose} with balance:`, error);
    return {
      success: false,
      amountFromBalance: 0,
      amountCharged: 0,
      error: error.message,
    };
  }
}
