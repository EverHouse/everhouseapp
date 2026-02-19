import { createPaymentIntent, createBalanceAwarePayment } from '../stripe/payments';
import { getOrCreateStripeCustomer } from '../stripe/customers';
import { pool } from '../db';
import { logger } from '../logger';

export interface CreatePrepaymentIntentParams {
  sessionId: number;
  bookingId: number;
  userId: string | null;
  userEmail: string;
  userName: string;
  totalFeeCents: number;
  feeBreakdown: { overageCents: number; guestCents: number };
}

export interface PrepaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  paidInFull?: boolean;
  balanceTransactionId?: string;
}

export async function createPrepaymentIntent(
  params: CreatePrepaymentIntentParams
): Promise<PrepaymentIntentResult | null> {
  const {
    sessionId,
    bookingId,
    userId,
    userEmail,
    userName,
    totalFeeCents,
    feeBreakdown
  } = params;

  if (totalFeeCents <= 0) {
    return null;
  }

  // Safety net: never create prepayments for staff or unlimited-tier members
  if (userEmail) {
    const exemptCheck = await pool.query(
      `SELECT u.role, u.tier, COALESCE(tf.unlimited_access, false) as unlimited_access
       FROM users u 
       LEFT JOIN tier_features tf ON LOWER(u.tier) = LOWER(tf.tier_name)
       WHERE LOWER(u.email) = LOWER($1) LIMIT 1`,
      [userEmail]
    );
    if (exemptCheck.rows.length > 0) {
      const { role, tier, unlimited_access } = exemptCheck.rows[0];
      const normalizedRole = (role || '').toLowerCase();
      if (['staff', 'admin', 'golf_instructor'].includes(normalizedRole) || unlimited_access) {
        logger.info('[Prepayment] Skipping - exempt from fees', { 
          extra: { userEmail, role, tier, unlimited_access, bookingId } 
        });
        return null;
      }
    }
  }

  try {
    const existingIntent = await pool.query(
      `SELECT stripe_payment_intent_id, status 
       FROM stripe_payment_intents 
       WHERE session_id = $1 
       AND purpose = 'prepayment' 
       AND status NOT IN ('canceled', 'cancelled', 'refunded', 'failed')
       LIMIT 1`,
      [sessionId]
    );

    if (existingIntent.rows.length > 0) {
      logger.info('[Prepayment] Skipping - existing prepayment intent by session_id', { extra: { sessionId } });
      return null;
    }

    const existingByBooking = await pool.query(
      `SELECT stripe_payment_intent_id, status 
       FROM stripe_payment_intents 
       WHERE booking_id = $1 
       AND purpose = 'prepayment' 
       AND status NOT IN ('canceled', 'cancelled', 'refunded', 'failed', 'succeeded')
       LIMIT 1`,
      [bookingId]
    );

    if (existingByBooking.rows.length > 0) {
      logger.info('[Prepayment] Skipping - existing prepayment intent by booking_id', { extra: { bookingId, existingPaymentIntentId: existingByBooking.rows[0].stripe_payment_intent_id } });
      return null;
    }

    const description = `Prepayment for booking #${bookingId} - Overage: $${(feeBreakdown.overageCents / 100).toFixed(2)}, Guest fees: $${(feeBreakdown.guestCents / 100).toFixed(2)}`;

    const { customerId } = await getOrCreateStripeCustomer(userId || userEmail, userEmail, userName);

    const result = await createBalanceAwarePayment({
      stripeCustomerId: customerId,
      userId: userId || `email-${userEmail}`,
      email: userEmail,
      memberName: userName || userEmail,
      amountCents: totalFeeCents,
      purpose: 'prepayment',
      description,
      bookingId,
      sessionId,
      metadata: {
        bookingId: bookingId.toString(),
        sessionId: sessionId.toString(),
        overageCents: feeBreakdown.overageCents.toString(),
        guestCents: feeBreakdown.guestCents.toString(),
        prepaymentType: 'booking_approval'
      }
    });

    if (result.error) {
      logger.error('[Prepayment] Balance-aware payment error', { extra: { error: result.error, sessionId, bookingId } });
      return null;
    }

    if (result.paidInFull) {
      logger.info('[Prepayment] Fully covered by account credit', { 
        extra: { balanceTransactionId: result.balanceTransactionId, sessionId, amountDollars: (totalFeeCents / 100).toFixed(2) } 
      });
      return {
        paymentIntentId: 'balance-' + result.balanceTransactionId,
        clientSecret: '',
        paidInFull: true,
        balanceTransactionId: result.balanceTransactionId
      };
    }

    logger.info('[Prepayment] Created payment intent', { 
      extra: { paymentIntentId: result.paymentIntentId, sessionId, amountDollars: (totalFeeCents / 100).toFixed(2), balanceApplied: result.balanceApplied } 
    });

    return {
      paymentIntentId: result.paymentIntentId!,
      clientSecret: result.clientSecret!,
      paidInFull: false
    };
  } catch (error: unknown) {
    logger.error('[Prepayment] Failed to create prepayment intent', {
      error,
      extra: { sessionId, bookingId, userEmail, totalFeeCents }
    });
    return null;
  }
}
