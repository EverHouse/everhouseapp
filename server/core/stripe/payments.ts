import crypto from 'crypto';
import Stripe from 'stripe';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logBillingAudit } from '../auditLog';
import { getStripeClient } from './client';
import { getOrCreateStripeCustomer } from './customers';
import { PaymentStatusService } from '../billing/PaymentStatusService';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
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

export type PaymentPurpose = 'guest_fee' | 'overage_fee' | 'one_time_purchase' | 'prepayment';

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

  if (bookingId) {
    const existingIntentResult = await db.execute(sql`SELECT stripe_payment_intent_id, status, amount_cents 
       FROM stripe_payment_intents 
       WHERE booking_id = ${bookingId} 
       AND amount_cents = ${amountCents}
       AND purpose IN ('prepayment', 'booking_fee')
       AND status NOT IN ('canceled', 'cancelled', 'refunded', 'failed', 'succeeded')
       LIMIT 1`);

    if (existingIntentResult.rows.length > 0) {
      const existingIntent = existingIntentResult.rows[0];
      const stripeClient = await getStripeClient();
      const existingPI = await stripeClient.paymentIntents.retrieve(existingIntent.stripe_payment_intent_id);
      logger.info(`[Stripe] Reusing existing PaymentIntent ${existingPI.id} for booking #${bookingId}`);
      return {
        paymentIntentId: existingPI.id,
        clientSecret: existingPI.client_secret!,
        customerId,
        status: existingPI.status
      };
    }
  }

  const stripe = await getStripeClient();

  const stripeMetadata: Record<string, string> = {
    userId,
    email,
    purpose,
    source: 'even_house_app'
  };
  
  if (bookingId) stripeMetadata.bookingId = bookingId.toString();
  if (!bookingId) stripeMetadata.type = 'conference_booking';
  if (sessionId) stripeMetadata.sessionId = sessionId.toString();
  if (metadata?.participantFees) stripeMetadata.participantFees = metadata.participantFees;
  if (metadata?.trackmanBookingId) stripeMetadata.trackmanBookingId = metadata.trackmanBookingId;
  if (productId) stripeMetadata.productId = productId;
  if (productName) stripeMetadata.productName = productName;

  // Generate idempotency key to prevent duplicate payment intents
  // Booking payments use deterministic keys (same booking = same key = dedup)
  // Non-booking purchases (merch, cafe) use timestamp for uniqueness per transaction
  const isBookingPayment = !!(bookingId || sessionId);
  const idempotencyComponents = [
    purpose,
    bookingId?.toString() || 'no-booking',
    sessionId?.toString() || 'no-session',
    amountCents.toString(),
    metadata?.feeSnapshotId || `${userId}-${email}`.replace(/[^a-zA-Z0-9-]/g, '')
  ];
  if (!isBookingPayment) {
    idempotencyComponents.push(Date.now().toString());
  }
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
  
  await db.execute(sql`INSERT INTO stripe_payment_intents 
     (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status, product_id, product_name)
     VALUES (${dbUserId}, ${paymentIntent.id}, ${customerId}, ${amountCents}, ${purpose}, ${bookingId || null}, ${sessionId || null}, ${description}, 'pending', ${productId || null}, ${productName || null})`);

  logger.info(`[Stripe] Created PaymentIntent ${paymentIntent.id} for ${purpose}: $${(amountCents / 100).toFixed(2)}${productName ? ` (${productName})` : ''}`);

  return {
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret!,
    customerId,
    status: paymentIntent.status
  };
}

export interface CartLineItem {
  productId: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export interface CreatePOSInvoiceParams {
  customerId: string;
  description: string;
  cartItems: CartLineItem[];
  metadata?: Record<string, string>;
  receiptEmail?: string;
  forTerminal?: boolean;
}

export interface InvoicePaymentResult {
  invoiceId: string;
  paymentIntentId: string;
  clientSecret: string;
  status: string;
}

export async function createInvoiceWithLineItems(params: CreatePOSInvoiceParams): Promise<InvoicePaymentResult> {
  const stripe = await getStripeClient();
  const { customerId, description, cartItems, metadata = {}, receiptEmail, forTerminal = false } = params;

  const cartTotal = cartItems.reduce((sum, item) => sum + (item.priceCents * item.quantity), 0);

  const checkoutNonce = crypto.randomBytes(8).toString('hex');
  const invoiceIdempotencyKey = `invoice_pos_${customerId}_${checkoutNonce}`;
  const invoice = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false,
    collection_method: 'charge_automatically',
    description,
    metadata: {
      ...metadata,
      source: 'pos',
    },
    pending_invoice_items_behavior: 'exclude',
  }, {
    idempotencyKey: invoiceIdempotencyKey
  });

  try {
    for (let idx = 0; idx < cartItems.length; idx++) {
      const item = cartItems[idx];
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoice.id,
        description: item.name,
        amount: item.priceCents * item.quantity,
        currency: 'usd',
        metadata: {
          productId: item.productId,
        },
      }, {
        idempotencyKey: `invitem_pos_${invoice.id}_${item.productId}_${idx}`
      });
    }

    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    if (forTerminal) {
      const invoicePiId = typeof (finalizedInvoice as unknown as Stripe.Invoice & { payment_intent: string | Stripe.PaymentIntent | null }).payment_intent === 'string'
        ? (finalizedInvoice as unknown as { payment_intent: string }).payment_intent
        : ((finalizedInvoice as unknown as { payment_intent: Stripe.PaymentIntent | null }).payment_intent)?.id;
      if (invoicePiId) {
        try {
          await stripe.paymentIntents.cancel(invoicePiId);
          logger.info(`[Stripe] Cancelled invoice-generated PI ${invoicePiId} — will use standalone card_present PI instead`);
        } catch (cancelErr: unknown) {
          logger.warn(`[Stripe] Could not cancel invoice PI ${invoicePiId}: ${getErrorMessage(cancelErr)}`);
        }
      }

      const standalonePi = await stripe.paymentIntents.create({
        amount: finalizedInvoice.amount_due,
        currency: finalizedInvoice.currency || 'usd',
        customer: customerId,
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description,
        metadata: {
          ...metadata,
          source: 'pos',
          invoice_id: finalizedInvoice.id,
        },
        ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
      }, {
        idempotencyKey: `terminal_standalone_${customerId}_${finalizedInvoice.id}`
      });

      logger.info(`[Stripe] Created invoice ${invoice.id} with standalone terminal PI: ${standalonePi.id}, total: ${cartTotal}`);

      return {
        invoiceId: finalizedInvoice.id,
        paymentIntentId: standalonePi.id,
        clientSecret: standalonePi.client_secret!,
        status: standalonePi.status,
      };
    }

    const finalizedInvoiceData = finalizedInvoice as unknown as { payment_intent: string | Stripe.PaymentIntent | null };
    const paymentIntentId = typeof finalizedInvoiceData.payment_intent === 'string'
      ? finalizedInvoiceData.payment_intent
      : (finalizedInvoiceData.payment_intent as Stripe.PaymentIntent | null)?.id;

    if (!paymentIntentId) {
      throw new Error('Invoice finalization did not create a PaymentIntent');
    }

    if (receiptEmail) {
      await stripe.paymentIntents.update(paymentIntentId, {
        receipt_email: receiptEmail,
      });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    logger.info(`[Stripe] Created invoice ${invoice.id} with ${cartItems.length} line items, PI: ${paymentIntentId}, total: ${cartTotal}`);

    return {
      invoiceId: finalizedInvoice.id,
      paymentIntentId,
      clientSecret: paymentIntent.client_secret!,
      status: paymentIntent.status,
    };
  } catch (error: unknown) {
    try {
      const currentInvoice = await stripe.invoices.retrieve(invoice.id);
      if (currentInvoice.status === 'draft') {
        await stripe.invoices.del(invoice.id);
        logger.info(`[POS Invoice] Deleted draft invoice ${invoice.id} after error`);
      } else if (currentInvoice.status === 'open') {
        await stripe.invoices.voidInvoice(invoice.id);
        logger.info(`[POS Invoice] Voided open invoice ${invoice.id} after error`);
      }
    } catch (cleanupErr: unknown) {
      logger.error(`[POS Invoice] Failed to clean up invoice ${invoice.id}:`, { extra: { detail: getErrorMessage(cleanupErr) } });
    }
    throw error;
  }
}

export async function confirmPaymentSuccess(
  paymentIntentId: string,
  performedBy: string,
  performedByName?: string,
  txClient?: { query: (text: string, values?: unknown[]) => Promise<unknown> }
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
      logger.error(`[Stripe] PaymentStatusService failed:`, { error: result.error });
      if (txClient) {
        await txClient.query(
          `UPDATE stripe_payment_intents 
           SET status = 'succeeded', updated_at = NOW() 
           WHERE stripe_payment_intent_id = $1`,
          [paymentIntentId]
        );
      } else {
        await db.execute(sql`UPDATE stripe_payment_intents 
           SET status = 'succeeded', updated_at = NOW() 
           WHERE stripe_payment_intent_id = ${paymentIntentId}`);
      }
    }

    const localRecord = await db.execute(sql`SELECT id, user_id, stripe_payment_intent_id, amount_cents, purpose, booking_id, session_id, product_name, status FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${paymentIntentId}`);

    if (localRecord.rows[0]) {
      const record = localRecord.rows[0];
      
      await logBillingAudit({
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

    logger.info(`[Stripe] Payment ${paymentIntentId} confirmed as succeeded (${result.participantsUpdated || 0} participants updated)`);
    return { success: true };
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming payment:', { error: error });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getPaymentIntentStatus(
  paymentIntentId: string
): Promise<{ status: string; amountCents: number; purpose: string } | null> {
  const result = await db.execute(sql`SELECT status, amount_cents, purpose FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${paymentIntentId}`);

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

    await db.execute(sql`UPDATE stripe_payment_intents 
       SET status = 'canceled', updated_at = NOW() 
       WHERE stripe_payment_intent_id = ${paymentIntentId}`);

    logger.info(`[Stripe] Payment ${paymentIntentId} canceled`);
    return { success: true };
  } catch (error: unknown) {
    logger.error('[Stripe] Error canceling payment:', { error: error });
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Create a payment for member self-service that applies customer balance.
 * 
 * Safe Flow (credit consumed AFTER successful payment):
 * 1. Check customer's available credit
 * 2. If full coverage: Consume credit immediately, payment complete
 * 3. If partial coverage: Create PaymentIntent for REMAINING amount (after credit), store credit amount in metadata
 * 4. On successful payment (webhook), consume the credit via a balance transaction
 * 
 * This ensures no credit is lost if payment fails — credit is only consumed after the card charge succeeds.
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
    const customerBalance = (customer as Stripe.Customer).balance || 0;
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

      await db.execute(sql`INSERT INTO stripe_payment_intents 
         (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
         VALUES (${email}, ${`balance-${balanceTransaction.id}`}, ${stripeCustomerId}, ${amountCents}, ${purpose}, ${bookingId || null}, ${sessionId || null}, ${description}, 'succeeded')`);

      logger.info(`[Stripe] Member payment fully covered by balance: $${(amountCents / 100).toFixed(2)} for ${email}`);

      return {
        paidInFull: true,
        balanceTransactionId: balanceTransaction.id,
        totalCents: amountCents,
        balanceApplied: balanceToApply,
        remainingCents: 0,
      };
    }

    // Case 2: Need card payment
    // Charge only the remaining amount after credit; credit will be consumed via balance transaction in webhook
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
    
    // Store credit to consume after payment succeeds (webhook will create balance transaction)
    if (balanceToApply > 0) {
      stripeMetadata.creditToConsume = balanceToApply.toString();
    }

    // Generate idempotency key to prevent duplicate charges
    // Uses booking/session IDs, participant IDs, and amount for uniqueness
    const participantIds: number[] = metadata?.participantIds 
      ? metadata.participantIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      : [];
    const idempotencyKey = bookingId && sessionId
      ? generatePaymentIdempotencyKey(bookingId, sessionId, participantIds, remainingCents)
      : `pi_${purpose}_${userId.replace(/[^a-zA-Z0-9-]/g, '')}_${remainingCents}_${Math.floor(Date.now() / 300000)}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: remainingCents,
      currency: 'usd',
      customer: stripeCustomerId,
      description: balanceToApply > 0 
        ? `${description} ($${(balanceToApply / 100).toFixed(2)} account credit applied)` 
        : description,
      metadata: stripeMetadata,
      automatic_payment_methods: { enabled: true },
    }, {
      idempotencyKey
    });

    await db.execute(sql`INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES (${email}, ${paymentIntent.id}, ${stripeCustomerId}, ${amountCents}, ${purpose}, ${bookingId || null}, ${sessionId || null}, ${description}, 'pending')`);

    logger.info(`[Stripe] Member payment: total $${(amountCents / 100).toFixed(2)}, card charge: $${(remainingCents / 100).toFixed(2)}, credit to consume: $${(balanceToApply / 100).toFixed(2)}`);

    return {
      paidInFull: false,
      clientSecret: paymentIntent.client_secret || undefined,
      paymentIntentId: paymentIntent.id,
      totalCents: amountCents,
      balanceApplied: balanceToApply,
      remainingCents,
    };
  } catch (error: unknown) {
    logger.error(`[Stripe] Error creating balance-aware payment:`, { error: error });
    return {
      paidInFull: false,
      totalCents: amountCents,
      balanceApplied: 0,
      remainingCents: amountCents,
      error: getErrorMessage(error),
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
    }, {
      idempotencyKey: `invoice_charge_${stripeCustomerId}_${purpose}_${bookingId || 'none'}_${amountCents}`
    });

    // Create invoice item attached to this specific invoice
    await stripe.invoiceItems.create({
      customer: stripeCustomerId,
      invoice: invoice.id,
      amount: amountCents,
      currency: 'usd',
      description,
    }, {
      idempotencyKey: `invitem_charge_${invoice.id}_${purpose}`
    });

    // Finalize - this applies customer balance credits automatically
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    // Attempt to pay any remaining balance
    if (finalizedInvoice.amount_due > 0 && finalizedInvoice.status === 'open') {
      try {
        await stripe.invoices.pay(invoice.id);
      } catch (payError: unknown) {
        logger.warn(`[Stripe] Auto-pay failed for invoice ${invoice.id}: ${getErrorMessage(payError)}`);
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

    await db.execute(sql`INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status)
       VALUES (${email}, ${`invoice-${invoice.id}`}, ${stripeCustomerId}, ${amountCents}, ${purpose}, ${bookingId || null}, ${sessionId || null}, ${description}, ${paidInvoice.status === 'paid' ? 'succeeded' : paidInvoice.status})`);

    logger.info(`[Stripe] Charged ${purpose} via invoice ${invoice.id}: $${(amountCents / 100).toFixed(2)} (balance: $${(amountFromBalance / 100).toFixed(2)}, card: $${(amountCharged / 100).toFixed(2)})`);

    return {
      success: paidInvoice.status === 'paid',
      invoiceId: invoice.id,
      amountFromBalance,
      amountCharged,
      error: paidInvoice.status !== 'paid' ? `Invoice status: ${paidInvoice.status}` : undefined,
    };
  } catch (error: unknown) {
    logger.error(`[Stripe] Error charging ${purpose} with balance:`, { error: error });
    return {
      success: false,
      amountFromBalance: 0,
      amountCharged: 0,
      error: getErrorMessage(error),
    };
  }
}
