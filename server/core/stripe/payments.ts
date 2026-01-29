import crypto from 'crypto';
import { pool } from '../db';
import { db } from '../../db';
import { billingAuditLog } from '../../../shared/schema';
import { getStripeClient } from './client';
import { getOrCreateStripeCustomer } from './customers';
import { PaymentStatusService } from '../billing/PaymentStatusService';

/**
 * Generate a deterministic idempotency key for Stripe payment intents.
 * This prevents duplicate charges when users click pay multiple times.
 * 
 * @param bookingId - The booking ID
 * @param sessionId - The session ID (optional)
 * @param participantIds - Array of participant IDs being charged
 * @param amountCents - Total amount in cents
 * @returns A 32-character hex string for use as idempotency key
 */
export function generatePaymentIdempotencyKey(
  bookingId: number,
  sessionId: number | null,
  participantIds: number[],
  amountCents: number
): string {
  const data = `${bookingId}-${sessionId || 'none'}-${participantIds.sort((a, b) => a - b).join(',')}-${amountCents}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

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

  // Generate deterministic idempotency key to prevent duplicate payment intents
  // Uses a combination of booking/session IDs, amount, and purpose for uniqueness
  // IMPORTANT: Avoid non-deterministic values like Date.now() to ensure true idempotency
  const idempotencyComponents = [
    purpose,
    bookingId?.toString() || 'no-booking',
    sessionId?.toString() || 'no-session',
    amountCents.toString(),
    metadata?.feeSnapshotId || `${userId}-${email}`.replace(/[^a-zA-Z0-9-]/g, '')
  ];
  const idempotencyKey = `pi_${idempotencyComponents.join('_')}`;
  
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer: customerId,
    description: description,
    metadata: stripeMetadata,
    automatic_payment_methods: {
      enabled: true,
    },
  }, {
    idempotencyKey
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

    // Use centralized PaymentStatusService to update all related tables atomically
    const result = await PaymentStatusService.markPaymentSucceeded({
      paymentIntentId,
      staffEmail: performedBy,
      staffName: performedByName,
      amountCents: paymentIntent.amount
    });

    if (!result.success) {
      console.error(`[Stripe] PaymentStatusService failed:`, result.error);
      // Fall back to updating just stripe_payment_intents
      const queryClient = txClient || pool;
      await queryClient.query(
        `UPDATE stripe_payment_intents 
         SET status = 'succeeded', updated_at = NOW() 
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId]
      );
    }

    // Log to billing audit log
    const localRecord = await pool.query(
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
          stripeCustomerId: record.stripe_customer_id,
          participantsUpdated: result.participantsUpdated,
          snapshotsUpdated: result.snapshotsUpdated
        },
        newValue: `Stripe payment of $${(record.amount_cents / 100).toFixed(2)} for ${record.purpose}`,
        performedBy,
        performedByName
      });
    }

    console.log(`[Stripe] Payment ${paymentIntentId} confirmed as succeeded (${result.participantsUpdated || 0} participants updated)`);
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
 * Create a payment for member self-service that applies customer balance.
 * 
 * Safe Flow (credit applied AFTER successful payment):
 * 1. Check customer's available credit
 * 2. If full coverage: Consume credit immediately, payment complete
 * 3. If partial/no coverage: Create PaymentIntent for FULL amount, store pending credit in metadata
 * 4. On successful payment (webhook), refund the credit portion to the customer
 * 
 * This ensures no credit is lost if payment fails.
 */
export async function createBalanceAwarePayment(params: {
  stripeCustomerId: string;
  userId: string;
  email: string;
  memberName: string;
  amountCents: number;
  purpose: PaymentPurpose;
  description: string;
  bookingId?: number;
  sessionId?: number;
  metadata?: Record<string, string>;
}): Promise<{
  paidInFull: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  balanceTransactionId?: string;
  totalCents: number;
  balanceApplied: number;
  remainingCents: number;
  error?: string;
}> {
  const { stripeCustomerId, userId, email, memberName, amountCents, purpose, description, bookingId, sessionId, metadata = {} } = params;

  try {
    const stripe = await getStripeClient();

    // Get customer's current balance (negative = credit, positive = owes)
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.deleted) {
      throw new Error('Customer has been deleted');
    }
    const customerBalance = (customer as any).balance || 0;
    // Available credit is the absolute value of a negative balance
    const availableCredit = customerBalance < 0 ? Math.abs(customerBalance) : 0;

    // Calculate how much credit can be applied
    const balanceToApply = Math.min(availableCredit, amountCents);
    const remainingCents = amountCents - balanceToApply;

    // Case 1: Balance covers the FULL amount - consume credit immediately
    if (remainingCents === 0 && balanceToApply > 0) {
      const balanceTransaction = await stripe.customers.createBalanceTransaction(
        stripeCustomerId,
        {
          amount: balanceToApply, // Positive = consume credit (reduces negative balance)
          currency: 'usd',
          description: `Applied account credit: ${description}`,
        }
      );

      // Log to database
      await pool.query(
        `INSERT INTO stripe_payment_intents 
         (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [email, `balance-${balanceTransaction.id}`, stripeCustomerId, amountCents, purpose, bookingId || null, sessionId || null, description, 'succeeded']
      );

      console.log(`[Stripe] Member payment fully covered by balance: $${(amountCents / 100).toFixed(2)} for ${email}`);

      return {
        paidInFull: true,
        balanceTransactionId: balanceTransaction.id,
        totalCents: amountCents,
        balanceApplied: balanceToApply,
        remainingCents: 0,
      };
    }

    // Case 2: Need card payment
    // Charge the FULL amount; if there's credit, we'll refund that portion after payment succeeds
    const stripeMetadata: Record<string, string> = {
      ...metadata,
      userId,
      email,
      purpose,
      source: 'ever_house_app',
      memberPayment: 'true',
    };
    if (bookingId) stripeMetadata.bookingId = bookingId.toString();
    if (sessionId) stripeMetadata.sessionId = sessionId.toString();
    
    // Store pending credit to refund after payment succeeds
    if (balanceToApply > 0) {
      stripeMetadata.pendingCreditRefund = balanceToApply.toString();
    }

    // Generate idempotency key to prevent duplicate charges
    // Uses booking/session IDs, participant IDs, and amount for uniqueness
    const participantIds: number[] = metadata?.participantIds 
      ? metadata.participantIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      : [];
    const idempotencyKey = bookingId && sessionId
      ? generatePaymentIdempotencyKey(bookingId, sessionId, participantIds, amountCents)
      : `pi_${purpose}_${userId.replace(/[^a-zA-Z0-9-]/g, '')}_${amountCents}_${Date.now()}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents, // Charge FULL amount, credit applied as refund on success
      currency: 'usd',
      customer: stripeCustomerId,
      description: balanceToApply > 0 
        ? `${description} ($${(balanceToApply / 100).toFixed(2)} credit will be applied)` 
        : description,
      metadata: stripeMetadata,
      automatic_payment_methods: { enabled: true },
    }, {
      idempotencyKey
    });

    // Log to database
    await pool.query(
      `INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [email, paymentIntent.id, stripeCustomerId, amountCents, purpose, bookingId || null, sessionId || null, description, 'pending']
    );

    console.log(`[Stripe] Member payment: total $${(amountCents / 100).toFixed(2)}, pending credit refund: $${(balanceToApply / 100).toFixed(2)}`);

    return {
      paidInFull: false,
      clientSecret: paymentIntent.client_secret || undefined,
      paymentIntentId: paymentIntent.id,
      totalCents: amountCents,
      balanceApplied: balanceToApply, // This will be refunded after payment succeeds
      remainingCents, // For UI display only - actual charge is full amount
    };
  } catch (error: any) {
    console.error(`[Stripe] Error creating balance-aware payment:`, error);
    return {
      paidInFull: false,
      totalCents: amountCents,
      balanceApplied: 0,
      remainingCents: amountCents,
      error: error.message,
    };
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
