import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from '../../core/stripe/client';
import {
  cancelPaymentIntent,
} from '../../core/stripe';
import {
  getPaymentByIntentId,
  updatePaymentStatus,
  updatePaymentStatusAndAmount
} from '../../core/stripe/paymentRepository';
import { logFromRequest, logBillingAudit } from '../../core/auditLog';
import { getStaffInfo, MAX_RETRY_ATTEMPTS } from './helpers';
import { broadcastBillingUpdate, sendNotificationToUser } from '../../core/websocket';
import { alertOnExternalServiceError } from '../../core/errorAlerts';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { validateBody } from '../../middleware/validate';
import {
  adjustGuestPassesSchema,
  addPaymentNoteSchema,
  retryPaymentSchema,
  cancelPaymentSchema,
  refundPaymentSchema,
  capturePaymentSchema,
  voidAuthorizationSchema,
} from '../../../shared/validators/paymentAdmin';

interface DbLedgerRow {
  id: number;
  member_id: string;
  overage_fee: string;
  guest_fee: string;
  minutes_charged: number;
  stripe_payment_intent_id: string;
}

interface _StripeError extends Error {
  type?: string;
  decline_code?: string;
  code?: string;
}

const router = Router();

router.post('/api/stripe/cleanup-stale-intents', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const staleIntents = await db.execute(sql`SELECT spi.stripe_payment_intent_id, spi.id as local_id, br.status as booking_status
       FROM stripe_payment_intents spi
       LEFT JOIN booking_requests br ON spi.booking_id = br.id
       WHERE spi.status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')
       AND (br.status = 'cancelled' OR br.id IS NULL)`);
    
    const results: { id: string; success: boolean; error?: string }[] = [];
    
    for (const row of staleIntents.rows as Array<{ stripe_payment_intent_id: string; local_id: number; booking_status: string }>) {
      try {
        await cancelPaymentIntent(row.stripe_payment_intent_id as string);
        results.push({ id: row.stripe_payment_intent_id as string, success: true });
        logger.info('[Cleanup] Cancelled stale payment intent', { extra: { rowStripe_payment_intent_id: row.stripe_payment_intent_id } });
      } catch (err: unknown) {
        results.push({ id: row.stripe_payment_intent_id as string, success: false, error: getErrorMessage(err) });
        logger.error('[Cleanup] Failed to cancel', { extra: { stripe_payment_intent_id: row.stripe_payment_intent_id, error: getErrorMessage(err) } });
      }
    }
    
    res.json({ 
      success: true, 
      processed: results.length,
      cancelled: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      details: results 
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error cleaning up stale intents', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cleanup stale intents' });
  }
});

router.post('/api/payments/adjust-guest-passes', isStaffOrAdmin, validateBody(adjustGuestPassesSchema), async (req: Request, res: Response) => {
  try {
    const { memberId, memberEmail: rawEmail, memberName, adjustment, reason } = req.body;
    const memberEmail = rawEmail?.trim()?.toLowerCase();
    const { staffEmail, staffName } = getStaffInfo(req);

    const existingResult = await db.execute(sql`SELECT id, passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = ${memberEmail.toLowerCase()}`);

    let previousCount = 0;
    let newCount = 0;
    let passesUsed = 0;

    if (existingResult.rows.length === 0) {
      newCount = Math.max(0, adjustment);
      await db.execute(sql`INSERT INTO guest_passes (member_email, passes_used, passes_total) VALUES (${memberEmail.toLowerCase()}, 0, ${newCount})`);
      logger.info('[GuestPasses] Created new record for with passes', { extra: { memberEmail, newCount } });
    } else {
      const current = existingResult.rows[0] as { id: number; passes_used: number; passes_total: number };
      previousCount = (current.passes_total as number) || 0;
      passesUsed = (current.passes_used as number) || 0;
      newCount = Math.max(0, previousCount + adjustment);

      await db.execute(sql`UPDATE guest_passes SET passes_total = ${newCount} WHERE id = ${current.id}`);
      logger.info('[GuestPasses] Updated : -> ()', { extra: { memberEmail, previousCount, newCount, adjustment_0: adjustment > 0 ? '+' : '', adjustment } });
    }

    await logBillingAudit({
      memberEmail,
      actionType: 'guest_pass_adjustment',
      actionDetails: {
        adjustment,
        reason,
        previousCount,
        newCount,
        memberId: memberId || null,
        memberName: memberName || null
      },
      previousValue: previousCount.toString(),
      newValue: newCount.toString(),
      performedBy: staffEmail,
      performedByName: staffName
    });

    res.json({ 
      success: true, 
      previousCount,
      newCount,
      remaining: newCount - passesUsed
    });
  } catch (error: unknown) {
    logger.error('[GuestPasses] Error adjusting guest passes', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to adjust guest passes' });
  }
});

router.post('/api/payments/add-note', isStaffOrAdmin, validateBody(addPaymentNoteSchema), async (req: Request, res: Response) => {
  try {
    const { transactionId, note, performedBy, performedByName } = req.body;

    const { staffEmail, staffName } = getStaffInfo(req);
    const finalPerformedBy = performedBy || staffEmail;
    const finalPerformedByName = performedByName || staffName;

    const piResult = await db.execute(sql`SELECT u.email as member_email 
       FROM stripe_payment_intents spi
       LEFT JOIN users u ON u.id = spi.user_id
       WHERE spi.stripe_payment_intent_id = ${transactionId}`);

    let memberEmail = 'unknown';
    if (piResult.rows.length > 0 && piResult.rows[0].member_email) {
      memberEmail = (piResult.rows[0] as { member_email: string }).member_email;
    }

    await logBillingAudit({
      memberEmail,
      actionType: 'payment_note_added',
      actionDetails: { paymentIntentId: transactionId, note },
      newValue: note,
      performedBy: finalPerformedBy,
      performedByName: finalPerformedByName
    });

    logger.info('[Payments] Note added to transaction by', { extra: { transactionId, finalPerformedByName } });
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Payments] Error adding note', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add note' });
  }
});

router.get('/api/payments/:paymentIntentId/notes', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.params;

    const result = await db.execute(sql`SELECT id, details->>'note' as note, staff_name as performed_by_name, created_at
       FROM admin_audit_log
       WHERE resource_type = 'billing'
         AND action = 'payment_note_added'
         AND details->>'paymentIntentId' = ${paymentIntentId}
       ORDER BY created_at DESC`);

    const notes = (result.rows as Array<{ id: number; note: string; performed_by_name: string; created_at: string }>).map((row) => ({
      id: row.id,
      note: row.note,
      performedByName: row.performed_by_name,
      createdAt: row.created_at
    }));

    res.json({ notes });
  } catch (error: unknown) {
    logger.error('[Payments] Error fetching notes', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

router.post('/api/payments/retry', isStaffOrAdmin, validateBody(retryPaymentSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const retryResult = await db.execute(sql`SELECT retry_count, requires_card_update FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${paymentIntentId}`);
    
    const currentRetryCount = (retryResult.rows[0] as { retry_count: number; requires_card_update: boolean })?.retry_count || 0;
    const requiresCardUpdate = (retryResult.rows[0] as { retry_count: number; requires_card_update: boolean })?.requires_card_update || false;

    if (requiresCardUpdate) {
      return res.status(400).json({ 
        error: 'This payment has reached the maximum retry limit. The member needs to update their payment method.',
        requiresCardUpdate: true,
        retryCount: currentRetryCount
      });
    }

    if (currentRetryCount >= MAX_RETRY_ATTEMPTS) {
      return res.status(400).json({ 
        error: `Maximum retry limit (${MAX_RETRY_ATTEMPTS}) reached. Member must update their card.`,
        requiresCardUpdate: true,
        retryCount: currentRetryCount
      });
    }

    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['invoice'] });
    
    if (paymentIntent.status === 'succeeded') {
      await updatePaymentStatus(paymentIntentId, 'succeeded');
      return res.json({ 
        success: true, 
        message: 'Payment was already successful',
        status: 'succeeded'
      });
    }

    if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(paymentIntent.status)) {
      return res.status(400).json({ 
        error: `Cannot retry payment with status: ${paymentIntent.status}` 
      });
    }

    const piInvoice = (paymentIntent as unknown as Record<string, unknown>).invoice;
    let invoiceId: string | null = null;
    if (piInvoice) {
      invoiceId = typeof piInvoice === 'string' ? piInvoice : (piInvoice as { id: string }).id;
    }
    if (!invoiceId && payment.bookingId) {
      const { getBookingInvoiceId } = await import('../../core/billing/bookingInvoiceService');
      invoiceId = await getBookingInvoiceId(payment.bookingId);
    }

    let retrySucceeded = false;
    let retryStatus = '';
    let retryFailureReason = '';

    if (invoiceId) {
      logger.info('[Payments] Retrying invoice-generated PI via invoices.pay()', { extra: { paymentIntentId, invoiceId } });
      const invoice = await stripe.invoices.retrieve(invoiceId);
      if (invoice.status === 'paid') {
        await updatePaymentStatus(paymentIntentId, 'succeeded');
        return res.json({ success: true, message: 'Invoice already paid', status: 'succeeded' });
      }
      if (invoice.status !== 'open') {
        return res.status(400).json({ error: `Invoice is ${invoice.status}, cannot retry payment` });
      }
      const paidInvoice = await stripe.invoices.pay(invoiceId);
      retrySucceeded = paidInvoice.status === 'paid';
      if (retrySucceeded) {
        retryStatus = 'succeeded';
        retryFailureReason = '';
      } else {
        retryStatus = 'requires_payment_method';
        retryFailureReason = `Invoice retry failed (invoice status: ${paidInvoice.status})`;
      }
    } else {
      const confirmedIntent = await stripe.paymentIntents.confirm(paymentIntentId);
      retrySucceeded = confirmedIntent.status === 'succeeded';
      retryStatus = confirmedIntent.status;
      retryFailureReason = confirmedIntent.last_payment_error?.message || `Status: ${confirmedIntent.status}`;
    }

    const newRetryCount = currentRetryCount + 1;
    const nowReachesLimit = newRetryCount >= MAX_RETRY_ATTEMPTS;

    if (retrySucceeded) {
      await db.execute(sql`UPDATE stripe_payment_intents 
         SET status = 'succeeded', 
             updated_at = NOW(),
             retry_count = ${newRetryCount},
             last_retry_at = NOW(),
             requires_card_update = FALSE
         WHERE stripe_payment_intent_id = ${paymentIntentId}`);

      await logBillingAudit({
        memberEmail: payment.member_email || 'unknown',
        actionType: 'payment_retry_succeeded',
        actionDetails: {
          paymentIntentId,
          retryAttempt: newRetryCount,
          amount: payment.amount_cents,
          viaInvoice: !!invoiceId
        },
        newValue: `Retry #${newRetryCount} succeeded: $${(payment.amount_cents / 100).toFixed(2)}`,
        performedBy: staffEmail,
        performedByName: staffName
      });

      logger.info('[Payments] Retry # succeeded for', { extra: { newRetryCount, paymentIntentId, viaInvoice: !!invoiceId } });

      res.json({
        success: true,
        status: 'succeeded',
        retryCount: newRetryCount,
        message: 'Payment retry successful'
      });
    } else {
      await db.execute(sql`UPDATE stripe_payment_intents 
         SET status = ${retryStatus}, 
             updated_at = NOW(),
             retry_count = ${newRetryCount},
             last_retry_at = NOW(),
             failure_reason = ${retryFailureReason},
             requires_card_update = ${nowReachesLimit}
         WHERE stripe_payment_intent_id = ${paymentIntentId}`);

      await logBillingAudit({
        memberEmail: payment.member_email || 'unknown',
        actionType: 'payment_retry_failed',
        actionDetails: {
          paymentIntentId,
          retryAttempt: newRetryCount,
          newStatus: retryStatus,
          reachedLimit: nowReachesLimit,
          viaInvoice: !!invoiceId
        },
        newValue: `Retry #${newRetryCount} failed: ${retryStatus}${nowReachesLimit ? ' (limit reached)' : ''}`,
        performedBy: staffEmail,
        performedByName: staffName
      });

      logger.info('[Payments] Retry # failed for', { extra: { newRetryCount, paymentIntentId, retryStatus } });

      res.status(422).json({
        success: false,
        status: retryStatus,
        retryCount: newRetryCount,
        requiresCardUpdate: nowReachesLimit,
        message: nowReachesLimit 
          ? 'Maximum retry attempts reached. Member must update their payment method.'
          : `Payment requires further action: ${retryStatus}`
      });
    }
  } catch (error: unknown) {
    logger.error('[Payments] Error retrying payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'retry payment');
    res.status(500).json({ 
      error: 'Payment retry failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/payments/cancel', isStaffOrAdmin, validateBody(cancelPaymentSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status === 'succeeded') {
      return res.status(400).json({ error: 'Cannot cancel a succeeded payment. Use refund instead.' });
    }

    if (payment.status === 'canceled') {
      return res.json({ success: true, message: 'Payment was already canceled' });
    }

    const cancelResult = await cancelPaymentIntent(paymentIntentId);
    if (!cancelResult.success && cancelResult.error) {
      logger.warn('[Payments] cancelPaymentIntent returned error during staff cancel', { extra: { paymentIntentId, error: cancelResult.error } });
    }

    await logBillingAudit({
      memberEmail: payment.member_email || 'unknown',
      actionType: 'payment_canceled',
      actionDetails: {
        paymentIntentId,
        amount: payment.amountCents,
        description: payment.description
      },
      newValue: `Canceled payment: $${(payment.amountCents / 100).toFixed(2)}`,
      performedBy: staffEmail,
      performedByName: staffName
    });

    await logFromRequest(req, {
      action: 'cancel_payment',
      resourceType: 'billing',
      resourceId: paymentIntentId,
      resourceName: `$${(payment.amountCents / 100).toFixed(2)} - ${payment.description || 'Payment'}`,
      details: { memberEmail: payment.member_email }
    });

    logger.info('[Payments] Payment canceled by', { extra: { paymentIntentId, staffEmail } });

    res.json({ success: true, message: 'Payment canceled successfully' });
  } catch (error: unknown) {
    logger.error('[Payments] Error canceling payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to cancel payment' });
  }
});

router.post('/api/payments/refund', isStaffOrAdmin, validateBody(refundPaymentSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amountCents, reason } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status !== 'succeeded' && payment.status !== 'refunding') {
      return res.status(400).json({ error: `Cannot refund payment with status: ${payment.status}` });
    }

    const stripe = await getStripeClient();

    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: paymentIntentId
    };

    if (amountCents && amountCents > 0 && amountCents < payment.amountCents) {
      refundParams.amount = amountCents;
    }

    const refund = await stripe.refunds.create(refundParams, {
      idempotencyKey: `refund_${paymentIntentId}_${amountCents || 'full'}_${staffEmail}`
    });

    const refundedAmount = refund.amount;
    const isPartialRefund = refundedAmount < payment.amountCents;
    const newStatus = isPartialRefund ? 'partially_refunded' : 'refunded';

    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE stripe_payment_intents SET status = ${newStatus}, updated_at = NOW() WHERE stripe_payment_intent_id = ${paymentIntentId}`);

      const existingReversal = await tx.execute(sql`SELECT id FROM usage_ledger WHERE session_id = ${payment.sessionId ?? null} AND stripe_payment_intent_id = ${paymentIntentId} AND source = 'staff_manual' AND COALESCE(overage_fee, 0) < 0 LIMIT 1`);
      if (existingReversal.rows.length > 0) {
        logger.info('[Payments] Refund ledger reversal already exists (idempotency catch), skipping duplicate', { extra: { refundId: refund.id, paymentIntentId } });
        return;
      }

      if (payment.sessionId) {
        await tx.execute(sql`UPDATE booking_participants 
           SET payment_status = 'refunded', updated_at = NOW() 
           WHERE session_id = ${payment.sessionId} AND stripe_payment_intent_id = ${paymentIntentId}`);

        let ledgerResult = await tx.execute(sql`SELECT id, member_id, overage_fee, guest_fee, minutes_charged, stripe_payment_intent_id
           FROM usage_ledger 
           WHERE session_id = ${payment.sessionId} 
             AND stripe_payment_intent_id = ${paymentIntentId}
             AND (COALESCE(overage_fee, 0) > 0 OR COALESCE(guest_fee, 0) > 0)
           ORDER BY created_at ASC`);

        if (ledgerResult.rows.length === 0) {
          logger.warn('[Payments] [OPS_REVIEW_REQUIRED] No ledger entries found with payment_intent_id , falling back to session-wide entries for session .', { extra: { paymentIntentId, paymentSessionId: payment.sessionId } });
          ledgerResult = await tx.execute(sql`SELECT id, member_id, overage_fee, guest_fee, minutes_charged, stripe_payment_intent_id
             FROM usage_ledger 
             WHERE session_id = ${payment.sessionId} 
               AND (COALESCE(overage_fee, 0) > 0 OR COALESCE(guest_fee, 0) > 0)
             ORDER BY created_at ASC`);
        }

        if (ledgerResult.rows.length > 0) {
          const totalLedgerFeeCents = (ledgerResult.rows as Array<{ overage_fee: string; guest_fee: string }>).reduce((sum: number, entry) => {
            return sum + Math.round((parseFloat(entry.overage_fee) || 0) * 100) + Math.round((parseFloat(entry.guest_fee) || 0) * 100);
          }, 0);

          const refundCents = refundedAmount;
          const refundProportion = totalLedgerFeeCents > 0 
            ? Math.min(1, refundCents / totalLedgerFeeCents)
            : 1;

          let totalReversedOverageCents = 0;
          let totalReversedGuestCents = 0;
          const targetReversalCents = refundCents;

          const reversalAmounts: Array<{
            memberId: string;
            reversedOverageCents: number;
            reversedGuestCents: number;
          }> = [];

          for (const entry of ledgerResult.rows as unknown as DbLedgerRow[]) {
            const originalOverageCents = Math.round((parseFloat(entry.overage_fee) || 0) * 100);
            const originalGuestCents = Math.round((parseFloat(entry.guest_fee) || 0) * 100);

            const reversedOverageCents = isPartialRefund 
              ? Math.round(originalOverageCents * refundProportion)
              : originalOverageCents;
            const reversedGuestCents = isPartialRefund 
              ? Math.round(originalGuestCents * refundProportion)
              : originalGuestCents;

            reversalAmounts.push({
              memberId: entry.member_id,
              reversedOverageCents,
              reversedGuestCents
            });

            totalReversedOverageCents += reversedOverageCents;
            totalReversedGuestCents += reversedGuestCents;
          }

          if (isPartialRefund && reversalAmounts.length > 0) {
            const actualReversalCents = totalReversedOverageCents + totalReversedGuestCents;
            const remainderCents = targetReversalCents - actualReversalCents;

            if (remainderCents !== 0) {
              if (reversalAmounts[0].reversedOverageCents > 0 || reversalAmounts[0].reversedGuestCents === 0) {
                reversalAmounts[0].reversedOverageCents += remainderCents;
              } else {
                reversalAmounts[0].reversedGuestCents += remainderCents;
              }
              logger.info('[Payments] Applied rounding remainder of $ to first reversal entry', { extra: { remainderCents_100_ToFixed_2: (remainderCents / 100).toFixed(2) } });
            }
          }

          let reversalCount = 0;
          for (let i = 0; i < ledgerResult.rows.length; i++) {
            const amounts = reversalAmounts[i];

            if (amounts.reversedOverageCents !== 0 || amounts.reversedGuestCents !== 0) {
              await tx.execute(sql`INSERT INTO usage_ledger 
                 (session_id, member_id, minutes_charged, overage_fee, guest_fee, payment_method, source, stripe_payment_intent_id)
                 VALUES (${payment.sessionId}, ${amounts.memberId}, 0, ${(-amounts.reversedOverageCents / 100).toFixed(2)}, ${(-amounts.reversedGuestCents / 100).toFixed(2)}, 'waived', 'staff_manual', ${paymentIntentId})`);
              reversalCount++;
            }
          }

          const reversalType = isPartialRefund 
            ? `partial (${(refundProportion * 100).toFixed(1)}%)`
            : 'full';
          logger.info('[Payments] Created ledger reversal(s) for session , refund: $, linked to payment', { extra: { reversalCount, reversalType, paymentSessionId: payment.sessionId, refundCents_100_ToFixed_2: (refundCents / 100).toFixed(2), paymentIntentId } });
        }

        logger.info('[Payments] Updated ledger and participants for session', { extra: { paymentSessionId: payment.sessionId } });
      }

      await logBillingAudit({
        memberEmail: payment.memberEmail || 'unknown',
        actionType: 'payment_refunded',
        actionDetails: {
          paymentIntentId,
          refundId: refund.id,
          refundAmount: refundedAmount,
          reason: reason || 'No reason provided',
          originalAmount: payment.amountCents,
          isPartialRefund,
          sessionId: payment.sessionId
        },
        newValue: `Refunded $${(refundedAmount / 100).toFixed(2)} of $${(payment.amountCents / 100).toFixed(2)}`,
        performedBy: staffEmail,
        performedByName: staffName
      });
    });

    logger.info('[Payments] Refund created for : $', { extra: { refundId: refund.id, paymentIntentId, refundedAmount_100_ToFixed_2: (refundedAmount / 100).toFixed(2) } });

    const memberEmail = payment.memberEmail || payment.member_email;
    
    if (memberEmail) {
      sendNotificationToUser(memberEmail, {
        type: 'billing_update',
        title: 'Refund Processed',
        message: `A refund of $${(refundedAmount / 100).toFixed(2)} has been processed to your payment method.`,
        data: { paymentIntentId, refundId: refund.id, amount: refundedAmount }
      });
    }
    
    broadcastBillingUpdate({
      action: 'payment_refunded',
      memberEmail,
      amount: refundedAmount,
      status: newStatus
    });

    res.json({
      success: true,
      refundId: refund.id,
      refundedAmount,
      newStatus
    });
  } catch (error: unknown) {
    logger.error('[Payments] Error creating refund', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create refund' });
  }
});

router.post('/api/payments/capture', isStaffOrAdmin, validateBody(capturePaymentSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amountCents } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment authorization not found' });
    }

    if (payment.status !== 'requires_capture') {
      return res.status(400).json({ error: `Cannot capture payment with status: ${payment.status}` });
    }

    const stripe = await getStripeClient();

    const captureParams: Stripe.PaymentIntentCaptureParams = {};
    if (amountCents && amountCents > 0 && amountCents <= payment.amount_cents) {
      captureParams.amount_to_capture = amountCents;
    }

    const capturedPaymentIntent = await stripe.paymentIntents.capture(paymentIntentId, captureParams);

    const capturedAmount = capturedPaymentIntent.amount_received || amountCents || payment.amount_cents;

    await updatePaymentStatusAndAmount(paymentIntentId, 'succeeded', capturedAmount);

    await logBillingAudit({
      memberEmail: payment.member_email || 'unknown',
      actionType: 'payment_captured',
      actionDetails: {
        paymentIntentId,
        originalAmount: payment.amount_cents,
        capturedAmount,
        isPartialCapture: amountCents && amountCents < payment.amount_cents
      },
      previousValue: `Pre-authorized: $${(payment.amount_cents / 100).toFixed(2)}`,
      newValue: `Captured: $${(capturedAmount / 100).toFixed(2)}`,
      performedBy: staffEmail,
      performedByName: staffName
    });

    logger.info('[Payments] Captured : $', { extra: { paymentIntentId, capturedAmount_100_ToFixed_2: (capturedAmount / 100).toFixed(2) } });

    res.json({
      success: true,
      capturedAmount,
      paymentIntentId
    });
  } catch (error: unknown) {
    logger.error('[Payments] Error capturing payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to capture payment' });
  }
});

router.post('/api/payments/void-authorization', isStaffOrAdmin, validateBody(voidAuthorizationSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, reason } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    const payment = await getPaymentByIntentId(paymentIntentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment authorization not found' });
    }

    if (payment.status !== 'requires_capture') {
      return res.status(400).json({ error: `Cannot void payment with status: ${payment.status}` });
    }

    const cancelResult = await cancelPaymentIntent(paymentIntentId);
    if (!cancelResult.success && cancelResult.error) {
      return res.status(400).json({ error: cancelResult.error });
    }

    await logBillingAudit({
      memberEmail: payment.member_email || 'unknown',
      actionType: 'authorization_voided',
      actionDetails: {
        paymentIntentId,
        amount: payment.amount_cents,
        reason: reason || 'No reason provided'
      },
      previousValue: `Pre-authorized: $${(payment.amount_cents / 100).toFixed(2)}`,
      newValue: 'Voided',
      performedBy: staffEmail,
      performedByName: staffName
    });

    logger.info('[Payments] Voided authorization : $ -', { extra: { paymentIntentId, paymentAmount_cents_100_ToFixed_2: (payment.amount_cents / 100).toFixed(2), reason_No_reason: reason || 'No reason' } });

    res.json({
      success: true,
      paymentIntentId
    });
  } catch (error: unknown) {
    logger.error('[Payments] Error voiding authorization', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to void authorization' });
  }
});

export default router;
