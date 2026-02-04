import { createPaymentIntent } from '../stripe/payments';
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

  try {
    const existingIntent = await pool.query(
      `SELECT stripe_payment_intent_id 
       FROM stripe_payment_intents 
       WHERE session_id = $1 
       AND purpose = 'prepayment' 
       AND status IN ('pending', 'requires_payment_method', 'requires_action')
       LIMIT 1`,
      [sessionId]
    );

    if (existingIntent.rows.length > 0) {
      console.log(`[Prepayment] Skipping - existing prepayment intent for session ${sessionId}`);
      return null;
    }

    const description = `Prepayment for booking #${bookingId} - Overage: $${(feeBreakdown.overageCents / 100).toFixed(2)}, Guest fees: $${(feeBreakdown.guestCents / 100).toFixed(2)}`;

    const result = await createPaymentIntent({
      userId: userId || `email-${userEmail}`,
      email: userEmail,
      memberName: userName || userEmail,
      amountCents: totalFeeCents,
      purpose: 'prepayment',
      bookingId,
      sessionId,
      description,
      metadata: {
        bookingId: bookingId.toString(),
        sessionId: sessionId.toString(),
        overageCents: feeBreakdown.overageCents.toString(),
        guestCents: feeBreakdown.guestCents.toString(),
        prepaymentType: 'booking_approval'
      }
    });

    console.log(`[Prepayment] Created payment intent ${result.paymentIntentId} for session ${sessionId}: $${(totalFeeCents / 100).toFixed(2)}`);

    return {
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret
    };
  } catch (error) {
    logger.error('[Prepayment] Failed to create prepayment intent', {
      error: error as Error,
      extra: { sessionId, bookingId, userEmail, totalFeeCents }
    });
    return null;
  }
}
