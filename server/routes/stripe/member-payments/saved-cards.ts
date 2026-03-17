import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../../core/middleware';
import { paymentRateLimiter } from '../../../middleware/rateLimiting';
import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { getSessionUser } from '../../../types/session';
import { type BookingFeeLineItem } from '../../../core/stripe';
import { computeFeeBreakdown } from '../../../core/billing/unifiedFeeService';
import { broadcastBillingUpdate, broadcastBookingInvoiceUpdate } from '../../../core/websocket';
import { alertOnExternalServiceError } from '../../../core/errorAlerts';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getBookingInvoiceId, createDraftInvoiceForBooking, finalizeAndPayInvoice, buildInvoiceDescription } from '../../../core/billing/bookingInvoiceService';
import { listCustomerPaymentMethods } from '../../../core/stripe/customers';
import { logger } from '../../../core/logger';
import { getStripeDeclineMessage } from './shared';

const router = Router();

router.get('/api/member/payment-methods', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${sessionEmail}) AND archived_at IS NULL`);
    const stripeCustomerId = (userResult.rows[0] as { stripe_customer_id: string | null } | undefined)?.stripe_customer_id;

    if (!stripeCustomerId) {
      return res.json({ paymentMethods: [] });
    }

    const methods = await listCustomerPaymentMethods(stripeCustomerId);
    return res.json({ paymentMethods: methods });
  } catch (error: unknown) {
    logger.error('[MemberPayments] Error fetching payment methods', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.json({ paymentMethods: [] });
  }
});

router.post('/api/member/bookings/:id/pay-saved-card', isAuthenticated, paymentRateLimiter, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const { paymentMethodId } = req.body;
    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      return res.status(400).json({ error: 'Missing paymentMethodId' });
    }

    const bookingResult = await db.execute(sql`
      SELECT br.id, br.session_id, br.user_email, br.user_name, br.status,
             bs.trackman_booking_id, bs.session_date, bs.start_time, bs.end_time
      FROM booking_requests br
      JOIN booking_sessions bs ON br.session_id = bs.id
      WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as {
      id: number; session_id: number; user_email: string; user_name: string; status: string;
      trackman_booking_id: string | null; session_date: string; start_time: string; end_time: string;
    };

    if (booking.user_email.toLowerCase() !== sessionEmail.toLowerCase()) {
      return res.status(403).json({ error: 'You can only pay for your own bookings' });
    }

    const userResult = await db.execute(sql`SELECT id, stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${sessionEmail}) AND archived_at IS NULL`);
    const user = userResult.rows[0] as { id: string; stripe_customer_id: string | null } | undefined;

    if (!user?.stripe_customer_id) {
      return res.status(400).json({ error: 'No payment methods on file. Please use the standard payment form.' });
    }

    const savedMethods = await listCustomerPaymentMethods(user.stripe_customer_id);
    const selectedMethod = savedMethods.find(m => m.id === paymentMethodId);
    if (!selectedMethod) {
      return res.status(400).json({ error: 'Selected card is no longer available. Please use the standard payment form.' });
    }

    const existingPaymentResult = await db.execute(sql`
      SELECT stripe_payment_intent_id FROM stripe_payment_intents 
      WHERE booking_id = ${bookingId} AND status = 'succeeded'
      AND purpose IN ('prepayment', 'booking_fee')
      LIMIT 1
    `);
    if (existingPaymentResult.rows.length > 0) {
      return res.status(409).json({ error: 'Payment has already been collected for this booking.' });
    }

    const feeBreakdown = await computeFeeBreakdown({ bookingId, source: 'stripe' });
    if (feeBreakdown.totals.totalCents < 50) {
      return res.status(400).json({ error: 'No fees due for this booking, or total is below the minimum charge.' });
    }

    const participantResult = await db.execute(sql`
      SELECT id, cached_fee_cents, payment_status, participant_type, display_name
      FROM booking_participants
      WHERE session_id = ${booking.session_id} AND payment_status = 'pending' AND (cached_fee_cents > 0 OR cached_fee_cents IS NOT NULL)
    `);

    const pendingParticipants = (participantResult.rows as Array<{
      id: number; cached_fee_cents: number; payment_status: string;
      participant_type: string; display_name: string | null;
    }>).filter(r => (r.cached_fee_cents || 0) > 0);

    if (pendingParticipants.length === 0) {
      return res.status(400).json({ error: 'No pending fees found for this booking.' });
    }

    const feeLineItems: BookingFeeLineItem[] = pendingParticipants.map(r => {
      const isGuest = r.participant_type === 'guest';
      return {
        participantId: r.id,
        displayName: r.display_name || (isGuest ? 'Guest' : 'Member'),
        participantType: r.participant_type as 'owner' | 'member' | 'guest',
        overageCents: isGuest ? 0 : r.cached_fee_cents,
        guestCents: isGuest ? r.cached_fee_cents : 0,
        totalCents: r.cached_fee_cents,
      };
    });

    const existingInvoiceId = await getBookingInvoiceId(bookingId);

    let invoiceResult;

    if (existingInvoiceId) {
      try {
        invoiceResult = await finalizeAndPayInvoice({
          bookingId,
          paymentMethodId: selectedMethod.id,
          offSession: true,
        });
      } catch (draftErr: unknown) {
        logger.warn('[MemberPayments] Failed to use existing invoice for saved card, will clean up and retry', {
          extra: { bookingId, existingInvoiceId, error: getErrorMessage(draftErr) }
        });
        invoiceResult = null;
      }
    }

    if (!invoiceResult) {
      const stalePis = await db.execute(sql`SELECT stripe_payment_intent_id FROM stripe_payment_intents 
         WHERE booking_id = ${bookingId} AND status NOT IN ('succeeded', 'canceled', 'refunded')`);
      for (const row of stalePis.rows as Array<{ stripe_payment_intent_id: string }>) {
        try {
          const { getStripeClient } = await import('../../../core/stripe/client');
          const stripeClient = await getStripeClient();
          const livePi = await stripeClient.paymentIntents.retrieve(row.stripe_payment_intent_id);
          if (livePi.status === 'succeeded' || livePi.status === 'processing' || livePi.status === 'requires_capture') {
            logger.warn('[MemberPayments] Existing PI is already processing/succeeded — blocking duplicate charge', {
              extra: { bookingId, piId: row.stripe_payment_intent_id, liveStatus: livePi.status }
            });
            return res.status(409).json({ error: 'A payment is already being processed for this booking.' });
          }
          if (livePi.status !== 'canceled') {
            const livePiInvoice = (livePi as unknown as { invoice: string | { id: string } | null }).invoice;
            if (livePiInvoice) {
              logger.info('[MemberPayments] Stale PI is invoice-generated — skipping cancel, invoice flow will handle it', {
                extra: { bookingId, piId: row.stripe_payment_intent_id, invoiceId: typeof livePiInvoice === 'string' ? livePiInvoice : livePiInvoice.id }
              });
            } else {
              const { cancelPaymentIntent } = await import('../../../core/stripe');
              const cancelResult = await cancelPaymentIntent(row.stripe_payment_intent_id);
              if (!cancelResult.success) {
                logger.warn('[MemberPayments] Could not cancel stale PI — checking if booking has invoice to fall through', {
                  extra: { bookingId, piId: row.stripe_payment_intent_id, error: cancelResult.error }
                });
              }
            }
          } else {
            await db.execute(sql`UPDATE stripe_payment_intents SET status = 'canceled', updated_at = NOW() WHERE stripe_payment_intent_id = ${row.stripe_payment_intent_id}`);
          }
        } catch (_cancelErr) {
          logger.error('[MemberPayments] Could not verify/cancel stale PI — blocking charge to prevent duplicate', {
            extra: { bookingId, piId: row.stripe_payment_intent_id }
          });
          return res.status(503).json({ error: 'Could not verify existing payment status. Please try again.' });
        }
      }

      if (existingInvoiceId) {
        try {
          const { getStripeClient } = await import('../../../core/stripe/client');
          const stripeClient = await getStripeClient();
          const oldInvoice = await stripeClient.invoices.retrieve(existingInvoiceId);
          if (oldInvoice.status === 'open') {
            logger.info('[MemberPayments] Voiding broken open invoice before creating fresh draft', {
              extra: { bookingId, invoiceId: existingInvoiceId }
            });
            await stripeClient.invoices.voidInvoice(existingInvoiceId);
          }
          await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
          await db.execute(sql`UPDATE stripe_payment_intents SET status = 'canceled', updated_at = NOW()
            WHERE booking_id = ${bookingId} AND status NOT IN ('succeeded', 'canceled', 'refunded')`);
        } catch (voidErr: unknown) {
          logger.warn('[MemberPayments] Could not void existing invoice, proceeding with fresh draft', {
            extra: { bookingId, invoiceId: existingInvoiceId, error: getErrorMessage(voidErr) }
          });
          await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
        }
      }
      await createDraftInvoiceForBooking({
        customerId: user.stripe_customer_id,
        bookingId,
        sessionId: booking.session_id,
        trackmanBookingId: booking.trackman_booking_id || null,
        feeLineItems,
        metadata: {
          type: 'member_saved_card_prepayment',
          memberEmail: sessionEmail,
          memberId: user.id,
          participantIds: JSON.stringify(pendingParticipants.map(p => p.id)),
        },
        purpose: 'prepayment',
      });
      invoiceResult = await finalizeAndPayInvoice({
        bookingId,
        paymentMethodId: selectedMethod.id,
        offSession: true,
      });
    }

    if (invoiceResult.status === 'succeeded') {
      const chargeDescription = await buildInvoiceDescription(bookingId, booking.trackman_booking_id || null);
      const participantIds = pendingParticipants.map(p => p.id);
      const totalCents = pendingParticipants.reduce((sum, p) => sum + (p.cached_fee_cents || 0), 0);

      await db.transaction(async (tx) => {
        if (participantIds.length > 0) {
          await tx.execute(sql`UPDATE booking_participants 
             SET payment_status = 'paid', 
                 stripe_payment_intent_id = ${invoiceResult!.paymentIntentId},
                 paid_at = NOW()
             WHERE id IN (${sql.join(participantIds.map(id => sql`${id}`), sql`, `)})`);
        }

        await tx.execute(sql`INSERT INTO stripe_payment_intents 
            (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, status, purpose, description, booking_id, session_id)
           VALUES (${user!.id}, ${invoiceResult!.paymentIntentId}, ${user!.stripe_customer_id}, ${totalCents}, 'succeeded', 'prepayment', ${chargeDescription}, ${bookingId}, ${booking.session_id})
           ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = 'succeeded', updated_at = NOW()`);
      });

      try {
        await db.execute(sql`INSERT INTO billing_audit 
          (member_email, member_id, action, amount_cents, description, booking_id, session_id, payment_intent_id, invoice_id, created_at)
          VALUES (${sessionEmail}, ${user.id}, 'member_saved_card_prepayment', ${totalCents}, ${chargeDescription}, ${bookingId}, ${booking.session_id}, ${invoiceResult.paymentIntentId}, ${invoiceResult.invoiceId}, NOW())`);
      } catch (auditErr: unknown) {
        logger.warn('[MemberPayments] Failed to write billing audit (non-blocking)', { extra: { error: getErrorMessage(auditErr) } });
      }

      broadcastBillingUpdate({
        memberEmail: sessionEmail,
        action: 'payment_confirmed',
        bookingId,
        status: 'paid'
      });

      broadcastBookingInvoiceUpdate({
        bookingId,
        action: 'payment_confirmed',
      });

      logger.info('[MemberPayments] Member paid with saved card', {
        extra: { bookingId, memberEmail: sessionEmail, totalCents, cardLast4: selectedMethod.last4, invoiceId: invoiceResult.invoiceId }
      });

      return res.json({
        success: true,
        cardBrand: selectedMethod.brand,
        cardLast4: selectedMethod.last4,
        amountCents: totalCents,
      });
    }

    if (invoiceResult.status === 'requires_action') {
      return res.status(402).json({
        error: 'Your card requires additional verification. Please use the standard payment form.',
        requiresAction: true,
      });
    }

    return res.status(400).json({
      error: 'Payment could not be completed with this card. Please try the standard payment form.',
      status: invoiceResult.status,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const stripeCode = (error as { code?: string })?.code;
    const stripeType = (error as { type?: string })?.type;
    const stripeDeclineCode = (error as { decline_code?: string })?.decline_code;
    const bookingIdForLog = parseInt(req.params.id as string, 10);
    if (isNaN(bookingIdForLog)) return res.status(400).json({ error: 'Invalid booking IDForLog' });
    logger.error('[MemberPayments] Error processing saved card payment', {
      error: error instanceof Error ? error : new Error(String(error)),
      extra: {
        stripeCode,
        stripeType,
        stripeDeclineCode,
        message: errMsg,
        bookingId: isNaN(bookingIdForLog) ? req.params.id : bookingIdForLog,
        paymentMethodId: req.body?.paymentMethodId,
        endpoint: 'pay-saved-card',
      }
    });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'member saved card payment');
    const friendlyMessage = getStripeDeclineMessage(error);
    const statusCode = friendlyMessage ? 402 : 500;
    return res.status(statusCode).json({
      error: friendlyMessage || 'Payment failed. Please try using the standard payment form.',
      retryable: !friendlyMessage,
    });
  }
});

export default router;
