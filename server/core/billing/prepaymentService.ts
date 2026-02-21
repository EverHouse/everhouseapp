import { getOrCreateStripeCustomer } from '../stripe/customers';
import { type BookingFeeLineItem } from '../stripe/invoices';
import { createDraftInvoiceForBooking } from './bookingInvoiceService';
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
  invoiceId: string;
  paidInFull: boolean;
  paymentIntentId?: string;
  clientSecret?: string;
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

  if (!userEmail || !userEmail.includes('@')) {
    logger.info('[Prepayment] Skipping - no valid owner email (ghost booking prevention)', {
      extra: { bookingId, sessionId, userEmail: userEmail || '(empty)' }
    });
    return null;
  }

  const unmatchedCheck = await pool.query(
    `SELECT is_unmatched, user_email, user_name FROM booking_requests WHERE id = $1 LIMIT 1`,
    [bookingId]
  );
  if (unmatchedCheck.rows.length > 0) {
    const booking = unmatchedCheck.rows[0];
    if (booking.is_unmatched && (!booking.user_email || !booking.user_email.includes('@'))) {
      logger.info('[Prepayment] Skipping - unmatched booking without assigned member (ghost booking prevention)', {
        extra: { bookingId, sessionId, isUnmatched: booking.is_unmatched, userEmail: booking.user_email || '(empty)', userName: booking.user_name }
      });
      return null;
    }
  }

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
    const existingInvoice = await pool.query(
      `SELECT stripe_invoice_id FROM booking_requests WHERE id = $1 LIMIT 1`,
      [bookingId]
    );

    if (existingInvoice.rows[0]?.stripe_invoice_id) {
      logger.info('[Prepayment] Skipping - draft invoice already exists for booking', { extra: { bookingId, invoiceId: existingInvoice.rows[0].stripe_invoice_id } });
      return null;
    }

    const resourceTypeResult = await pool.query(
      `SELECT COALESCE(r.type, 'simulator') as resource_type
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.id = $1 LIMIT 1`,
      [bookingId]
    );
    const resourceType = resourceTypeResult.rows[0]?.resource_type || 'simulator';

    if (resourceType === 'conference_room') {
      logger.info('[Prepayment] Skipping - conference room bookings do not use invoices', { 
        extra: { bookingId, resourceType } 
      });
      return null;
    }

    const trackmanResult = await pool.query(
      `SELECT trackman_booking_id FROM booking_requests WHERE id = $1 LIMIT 1`,
      [bookingId]
    );
    const trackmanBookingId = trackmanResult.rows[0]?.trackman_booking_id || null;

    const { customerId } = await getOrCreateStripeCustomer(userId || userEmail, userEmail, userName);

    const feeLineItems = await buildParticipantLineItems(sessionId, feeBreakdown);

    const result = await createDraftInvoiceForBooking({
      customerId,
      bookingId,
      sessionId,
      trackmanBookingId,
      feeLineItems,
      metadata: {
        prepaymentType: 'booking_approval',
      },
      purpose: 'prepayment',
    });

    logger.info('[Prepayment] Created draft invoice for booking approval', { 
      extra: { 
        invoiceId: result.invoiceId,
        sessionId, 
        amountDollars: (totalFeeCents / 100).toFixed(2),
        lineItems: feeLineItems.length
      } 
    });

    return {
      invoiceId: result.invoiceId,
      paidInFull: false
    };
  } catch (error: unknown) {
    logger.error('[Prepayment] Failed to create draft invoice', {
      error,
      extra: { sessionId, bookingId, userEmail, totalFeeCents }
    });
    return null;
  }
}

async function buildParticipantLineItems(
  sessionId: number,
  aggregateFees: { overageCents: number; guestCents: number }
): Promise<BookingFeeLineItem[]> {
  try {
    const participantsResult = await pool.query(
      `SELECT id, participant_type, display_name, cached_fee_cents
       FROM booking_participants
       WHERE session_id = $1 AND cached_fee_cents > 0
       ORDER BY participant_type, id`,
      [sessionId]
    );

    if (participantsResult.rows.length === 0) {
      return buildFallbackLineItems(aggregateFees);
    }

    const lineItems: BookingFeeLineItem[] = [];
    for (const row of participantsResult.rows) {
      const feeCents = parseInt(row.cached_fee_cents) || 0;
      if (feeCents <= 0) continue;

      const isGuest = row.participant_type === 'guest';
      lineItems.push({
        participantId: row.id,
        displayName: row.display_name || (isGuest ? 'Guest' : 'Member'),
        participantType: row.participant_type as 'owner' | 'member' | 'guest',
        overageCents: isGuest ? 0 : feeCents,
        guestCents: isGuest ? feeCents : 0,
        totalCents: feeCents,
      });
    }

    return lineItems.length > 0 ? lineItems : buildFallbackLineItems(aggregateFees);
  } catch (error: unknown) {
    logger.warn('[Prepayment] Failed to load participant line items, using aggregate fallback', { error });
    return buildFallbackLineItems(aggregateFees);
  }
}

function buildFallbackLineItems(
  aggregateFees: { overageCents: number; guestCents: number }
): BookingFeeLineItem[] {
  const items: BookingFeeLineItem[] = [];
  if (aggregateFees.overageCents > 0) {
    items.push({
      displayName: 'Booking Owner',
      participantType: 'owner',
      overageCents: aggregateFees.overageCents,
      guestCents: 0,
      totalCents: aggregateFees.overageCents,
    });
  }
  if (aggregateFees.guestCents > 0) {
    items.push({
      displayName: 'Guest Fees',
      participantType: 'guest',
      overageCents: 0,
      guestCents: aggregateFees.guestCents,
      totalCents: aggregateFees.guestCents,
    });
  }
  return items;
}
