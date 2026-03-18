import Stripe from 'stripe';
import { db } from '../../../../db';
import { sql } from 'drizzle-orm';
import { notifyPaymentFailed, notifyStaffPaymentFailed, notifyAllStaff } from '../../../notificationService';
import { sendPaymentFailedEmail } from '../../../../emails/paymentEmails';
import { broadcastBillingUpdate, sendNotificationToUser } from '../../../websocket';
import { computeFeeBreakdown } from '../../../billing/unifiedFeeService';
import { logPaymentFailure } from '../../../monitoring';
import { sendErrorAlert } from '../../../errorAlerts';
import { logSystemAction, logPaymentAudit } from '../../../auditLog';
import { finalizeInvoicePaidOutOfBand } from '../../invoices';
import { queueJobInTransaction } from '../../../jobQueue';
import { logger } from '../../../logger';
import type { PoolClient } from 'pg';
import type { DeferredAction } from '../types';
import { upsertTransactionCache } from '../framework';
import { getErrorMessage } from '../../../../utils/errorUtils';


const MAX_RETRY_ATTEMPTS = 3;

export async function handleCreditNoteCreated(client: PoolClient, creditNote: Stripe.CreditNote): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  
  const { id, number, invoice, customer, total, currency, status, created, reason, memo, lines: _lines } = creditNote;
  
  logger.info(`[Stripe Webhook] Credit note created: ${id} (${number}), total: $${(total / 100).toFixed(2)}, reason: ${reason || 'none'}`);
  
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const invoiceId = typeof invoice === 'string' ? invoice : invoice?.id;
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'refund',
      amountCents: total,
      currency: currency || 'usd',
      status: status || 'issued',
      createdAt: new Date(created * 1000),
      customerId,
      invoiceId,
      description: memo ?? `Credit note ${number ?? id}`,
      metadata: { type: 'credit_note', reason: reason ?? '', number: number ?? '' },
      source: 'webhook',
    });
  });
  
  if (customerId) {
    const memberResult = await client.query(
      `SELECT email, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );
    
    if (memberResult.rows.length > 0) {
      const member = memberResult.rows[0];
      const amountStr = `$${(total / 100).toFixed(2)}`;
      
      deferredActions.push(async () => {
        try {
          await db.execute(
            sql`INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
             VALUES (${member.email.toLowerCase()}, ${'Credit Applied'}, ${`A credit of ${amountStr} has been applied to your account${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}.`}, ${'billing'}, ${'payment'}, NOW())`
          );
        } catch (err: unknown) {
          logger.error('[Stripe Webhook] Failed to create credit note notification:', { error: getErrorMessage(err) });
        }
      });
      
      logger.info(`[Stripe Webhook] Credit note ${id} for member ${member.email}: ${amountStr}`);
    }
  }
  
  return deferredActions;
}

export async function handleChargeRefunded(client: PoolClient, charge: Stripe.Charge): Promise<DeferredAction[]> {
  const { id, amount, amount_refunded, currency, customer, payment_intent, created, refunded } = charge;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Charge refunded: ${id}, refunded amount: $${(amount_refunded / 100).toFixed(2)}`);
  
  const status = refunded ? 'refunded' : 'partially_refunded';
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const paymentIntentId = typeof payment_intent === 'string' ? payment_intent : payment_intent?.id;
  
  const refunds = charge.refunds?.data || [];
  
  if (refunds.length > 0) {
    for (const refund of refunds) {
      if (refund?.id && refund?.amount) {
        deferredActions.push(async () => {
          await upsertTransactionCache({
            stripeId: refund.id,
            objectType: 'refund',
            amountCents: refund.amount,
            currency: refund.currency || currency || 'usd',
            status: refund.status || 'succeeded',
            createdAt: new Date(refund.created ? refund.created * 1000 : Date.now()),
            customerId,
            paymentIntentId,
            chargeId: id,
            source: 'webhook',
          });
        });
      }
    }
    logger.info(`[Stripe Webhook] Cached ${refunds.length} refund(s) for charge ${id}`);
  } else {
    logger.warn(`[Stripe Webhook] No refund objects found in charge.refunded event for charge ${id}`);
  }
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'charge',
      amountCents: amount,
      currency: currency || 'usd',
      status,
      createdAt: new Date(created * 1000),
      customerId,
      paymentIntentId,
      chargeId: id,
      source: 'webhook',
    });
  });
  
  if (paymentIntentId) {
    await client.query(
      `UPDATE stripe_payment_intents SET status = $1, updated_at = NOW() WHERE stripe_payment_intent_id = $2`,
      [status, paymentIntentId]
    );
    
    deferredActions.push(async () => {
      await upsertTransactionCache({
        stripeId: paymentIntentId,
        objectType: 'payment_intent',
        amountCents: amount,
        currency: currency || 'usd',
        status,
        createdAt: new Date(created * 1000),
        customerId,
        paymentIntentId,
        chargeId: id,
        source: 'webhook',
      });
    });
    
    if (refunded || amount_refunded >= amount) {
    const lockedRows = await client.query(
      `SELECT id FROM booking_participants
       WHERE stripe_payment_intent_id = $1 AND payment_status = 'paid'
       ORDER BY id ASC
       FOR UPDATE`,
      [paymentIntentId]
    );
    const lockedIds = lockedRows.rows.map((r: { id: number }) => r.id);

    const participantUpdate = lockedIds.length > 0
      ? await client.query(
        `WITH updated AS (
          UPDATE booking_participants
          SET payment_status = 'refunded', refunded_at = NOW()
          WHERE id = ANY($1::int[])
          RETURNING id, session_id, user_id
        )
        SELECT updated.id, updated.session_id, u.email AS user_email
        FROM updated
        LEFT JOIN users u ON u.id = updated.user_id`,
        [lockedIds]
      )
      : { rows: [], rowCount: 0 };
    
    if (participantUpdate.rowCount && participantUpdate.rowCount > 0) {
      logger.info(`[Stripe Webhook] Marked ${participantUpdate.rowCount} participant(s) as refunded for PI ${paymentIntentId} (full refund)`);
      
      for (const row of participantUpdate.rows) {
        const bookingLookup = await client.query(
          `SELECT br.id, br.user_email AS booking_owner_email FROM booking_sessions bs 
           JOIN booking_requests br ON br.trackman_booking_id = bs.trackman_booking_id 
           WHERE bs.id = $1 LIMIT 1`,
          [row.session_id]
        );
        const auditBookingId = bookingLookup.rows[0]?.id;
        const bookingOwnerEmail = bookingLookup.rows[0]?.booking_owner_email;
        if (auditBookingId) {
          await logPaymentAudit({
            bookingId: auditBookingId,
            sessionId: row.session_id,
            participantId: row.id,
            action: 'refund_processed',
            staffEmail: 'system',
            staffName: 'Stripe Webhook',
            amountAffected: 0,
            paymentMethod: 'stripe',
            metadata: { stripePaymentIntentId: paymentIntentId, source: 'manual_stripe_refund' },
          });
        }

        const guestPassCheck = await client.query(
          `SELECT id, display_name, used_guest_pass FROM booking_participants
           WHERE id = $1 AND used_guest_pass = true`,
          [row.id]
        );
        if (guestPassCheck.rowCount && guestPassCheck.rowCount > 0 && bookingOwnerEmail) {
          const guestName = guestPassCheck.rows[0].display_name;
          await client.query(
            `UPDATE guest_passes SET passes_used = GREATEST(0, passes_used - 1) WHERE LOWER(member_email) = LOWER($1)`,
            [bookingOwnerEmail]
          );
          await client.query(
            `UPDATE booking_participants SET used_guest_pass = false WHERE id = $1`,
            [row.id]
          );
          logger.info(`[Stripe Webhook] Refunded guest pass for participant ${row.id} (guest: ${guestName}) back to ${bookingOwnerEmail} (manual Stripe refund teardown)`);
        }

        const ledgerDelete = await client.query(
          `DELETE FROM usage_ledger WHERE session_id = $1 AND LOWER(member_id) = LOWER($2) RETURNING minutes_charged`,
          [row.session_id, row.user_email?.toLowerCase()]
        );
        if (ledgerDelete.rowCount && ledgerDelete.rowCount > 0) {
          const minutesRestored = ledgerDelete.rows.reduce((sum: number, r: { minutes_charged: number }) => sum + (r.minutes_charged || 0), 0);
          logger.info(`[Stripe Webhook] Restored ${minutesRestored} usage_ledger minutes for ${row.user_email} session ${row.session_id} (manual Stripe refund teardown)`);
        }

        if (auditBookingId) {
          await client.query(
            `DELETE FROM guest_pass_holds WHERE booking_id = $1`,
            [auditBookingId]
          );
        }
        
        if (row.user_email) {
          await client.query(
            `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [row.user_email.toLowerCase(), 'Payment Refunded', `Your booking payment of $${(amount_refunded / 100).toFixed(2)} has been refunded. It may take 5-10 business days to appear on your statement.`, 'billing', 'payment']
          );
          
          deferredActions.push(async () => {
            await sendNotificationToUser(row.user_email, {
              type: 'notification',
              title: 'Payment Refunded',
              message: `Your booking payment of $${(amount_refunded / 100).toFixed(2)} has been refunded. It may take 5-10 business days to appear on your statement.`,
              data: { sessionId: row.session_id, eventType: 'payment_refunded' }
            }, { action: 'payment_refunded', triggerSource: 'webhooks.ts' });
          });
        }
      }
    }
    } else {
      logger.info(`[Stripe Webhook] Partial refund of $${(amount_refunded / 100).toFixed(2)} for PI ${paymentIntentId} - skipping auto-participant update to preserve ledger`);
    }
  }
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({ action: 'payment_refunded', status, amount: amount_refunded });
  });

  if (paymentIntentId) {
    const terminalPaymentResult = await client.query(
      `UPDATE terminal_payments 
       SET status = $1, refunded_at = NOW(), refund_amount_cents = GREATEST(COALESCE(refund_amount_cents, 0), $2), updated_at = NOW()
       WHERE stripe_payment_intent_id = $3 AND status IN ('succeeded', 'partially_refunded')
       RETURNING id, user_id, user_email, stripe_subscription_id, amount_cents`,
      [status, amount_refunded, paymentIntentId]
    );
    
    if (terminalPaymentResult.rowCount && terminalPaymentResult.rowCount > 0) {
      const terminalPayment = terminalPaymentResult.rows[0];
      logger.info(`[Stripe Webhook] Terminal payment refunded for user ${terminalPayment.user_email}`);
      
      if (refunded) {
        const refundUserCheck = await client.query(
          `SELECT billing_provider FROM users WHERE id = $1`,
          [terminalPayment.user_id]
        );
        const refundBillingProvider = refundUserCheck.rows[0]?.billing_provider;

        if (refundBillingProvider && refundBillingProvider !== '' && refundBillingProvider !== 'stripe') {
          logger.info(`[Stripe Webhook] Skipping charge.refunded for ${terminalPayment.user_email} — billing_provider is '${refundBillingProvider}', not 'stripe'`);
        } else {
          logger.info(`[Stripe Webhook] Terminal payment fully refunded for user ${terminalPayment.user_id} — flagging for admin review (not auto-suspending)`);

          deferredActions.push(async () => {
            await notifyAllStaff(
              'Terminal Payment Refunded — Review Required',
              `A Terminal payment of $${(terminalPayment.amount_cents / 100).toFixed(2)} for ${terminalPayment.user_email} has been fully refunded ($${(amount_refunded / 100).toFixed(2)}). Please review whether membership status should be changed.`,
              'terminal_refund',
              { sendPush: true }
            );

            await logSystemAction({
              action: 'terminal_payment_refunded',
              resourceType: 'user',
              resourceId: terminalPayment.user_id,
              resourceName: terminalPayment.user_email,
              details: {
                source: 'stripe_webhook',
                stripe_payment_intent_id: paymentIntentId,
                stripe_subscription_id: terminalPayment.stripe_subscription_id,
                amount_cents: terminalPayment.amount_cents,
                refund_amount_cents: amount_refunded,
                membership_action: 'flagged_for_review'
              }
            });
          });
        }
      }
    }
  }

  const isPartialRefund = amount_refunded < amount;
  const memberEmail = charge.billing_details?.email || charge.receipt_email || 'unknown';
  for (const refund of refunds) {
    if (refund?.id) {
      deferredActions.push(async () => {
        await logSystemAction({
          action: isPartialRefund ? 'payment_refund_partial' : 'payment_refunded',
          resourceType: 'payment',
          resourceId: refund.id,
          resourceName: `Refund for ${memberEmail}`,
          details: {
            source: 'stripe_webhook',
            stripe_refund_id: refund.id,
            stripe_payment_intent_id: paymentIntentId,
            amount_cents: refund.amount,
            refund_reason: refund.reason || 'not_specified',
            member_email: memberEmail,
            is_partial: isPartialRefund
          }
        });
      });
    }
  }

  return deferredActions;
}

export async function handleChargeDisputeCreated(client: PoolClient, dispute: Stripe.Dispute): Promise<DeferredAction[]> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, amount, currency: _currency, charge, payment_intent, reason, status } = dispute;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Dispute created: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${reason}`);
  
  const paymentIntentId = typeof payment_intent === 'string' ? payment_intent : payment_intent?.id;
  
  if (paymentIntentId) {
    const terminalPaymentResult = await client.query(
      `UPDATE terminal_payments 
       SET disputed_at = NOW(), dispute_id = $1, dispute_status = $2, status = 'disputed', updated_at = NOW()
       WHERE stripe_payment_intent_id = $3 AND status IN ('succeeded', 'partially_refunded')
       RETURNING id, user_id, user_email, stripe_subscription_id, amount_cents`,
      [id, status, paymentIntentId]
    );
    
    if (terminalPaymentResult.rowCount && terminalPaymentResult.rowCount > 0) {
      const terminalPayment = terminalPaymentResult.rows[0];
      logger.info(`[Stripe Webhook] Terminal payment disputed for user ${terminalPayment.user_email}`);
      
      const disputeUserCheck = await client.query(
        `SELECT billing_provider FROM users WHERE id = $1`,
        [terminalPayment.user_id]
      );
      const disputeBillingProvider = disputeUserCheck.rows[0]?.billing_provider;

      if (disputeBillingProvider && disputeBillingProvider !== '' && disputeBillingProvider !== 'stripe') {
        logger.info(`[Stripe Webhook] Skipping charge.dispute.created for ${terminalPayment.user_email} — billing_provider is '${disputeBillingProvider}', not 'stripe'`);
      } else {
        await client.query(
          `UPDATE users SET membership_status = 'suspended', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'suspended' THEN NOW() ELSE membership_status_changed_at END, billing_provider = 'stripe', updated_at = NOW() WHERE id = $1`,
          [terminalPayment.user_id]
        );
        logger.info(`[Stripe Webhook] Suspended membership for user ${terminalPayment.user_id} due to payment dispute`);
      
        await client.query(
          `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            terminalPayment.user_email.toLowerCase(), 
            'Membership Suspended', 
            'Your membership has been suspended due to a payment dispute. Please contact staff immediately to resolve this issue.',
            'billing',
            'membership'
          ]
        );
      }
      
      deferredActions.push(async () => {
        await notifyAllStaff(
          'URGENT: Payment Dispute Received',
          `A payment dispute has been filed for ${terminalPayment.user_email}. Amount: $${(amount / 100).toFixed(2)}. Reason: ${reason || 'not specified'}. Membership has been suspended.`,
          'terminal_dispute',
          { sendPush: true }
        );
        
        await logSystemAction({
          action: 'terminal_payment_disputed',
          resourceType: 'user',
          resourceId: terminalPayment.user_id,
          resourceName: terminalPayment.user_email,
          details: {
            source: 'stripe_webhook',
            dispute_id: id,
            dispute_reason: reason,
            dispute_status: status,
            stripe_payment_intent_id: paymentIntentId,
            stripe_subscription_id: terminalPayment.stripe_subscription_id,
            amount_cents: terminalPayment.amount_cents,
            disputed_amount_cents: amount,
            membership_action: 'suspended'
          }
        });
      });
    }
  }
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({ action: 'payment_failed', status, amount });
  });
  
  return deferredActions;
}

export async function handleChargeDisputeClosed(client: PoolClient, dispute: Stripe.Dispute): Promise<DeferredAction[]> {
  const { id, amount, payment_intent, reason: _reason, status } = dispute;
  const deferredActions: DeferredAction[] = [];
  
  const disputeWon = status === 'won';
  logger.info(`[Stripe Webhook] Dispute closed: ${id}, status: ${status}, won: ${disputeWon}`);
  
  const paymentIntentId = typeof payment_intent === 'string' ? payment_intent : payment_intent?.id;
  
  if (paymentIntentId) {
    const terminalPaymentResult = await client.query(
      `UPDATE terminal_payments 
       SET dispute_status = $1, dispute_id = $2, disputed_at = COALESCE(disputed_at, NOW()), 
           status = $3, updated_at = NOW()
       WHERE stripe_payment_intent_id = $4 AND status IN ('succeeded', 'partially_refunded', 'disputed')
       RETURNING id, user_id, user_email, stripe_subscription_id, amount_cents`,
      [status, id, disputeWon ? 'succeeded' : 'disputed_lost', paymentIntentId]
    );
    
    if (terminalPaymentResult.rowCount && terminalPaymentResult.rowCount > 0) {
      const terminalPayment = terminalPaymentResult.rows[0];
      logger.info(`[Stripe Webhook] Terminal payment dispute closed for user ${terminalPayment.user_email}: ${status}`);
      
      let membershipAction: 'reactivated' | 'blocked_manual_review' | 'remained_suspended' | 'skipped_non_stripe' = 'remained_suspended';

      if (disputeWon) {
        const disputeClosedUserCheck = await client.query(
          `SELECT billing_provider, membership_status, stripe_subscription_id FROM users WHERE id = $1`,
          [terminalPayment.user_id]
        );
        const disputeClosedUser = disputeClosedUserCheck.rows[0];
        const disputeClosedBillingProvider = disputeClosedUser?.billing_provider;

        if (disputeClosedBillingProvider && disputeClosedBillingProvider !== '' && disputeClosedBillingProvider !== 'stripe') {
          logger.info(`[Stripe Webhook] Skipping charge.dispute.closed for ${terminalPayment.user_email} — billing_provider is '${disputeClosedBillingProvider}', not 'stripe'`);
          membershipAction = 'skipped_non_stripe';
        } else {
          const otherOpenDisputes = await client.query(
            `SELECT id FROM terminal_payments 
             WHERE user_id = $1 AND status = 'disputed' AND id != $2`,
            [terminalPayment.user_id, terminalPayment.id]
          );

          const blockingReasons: string[] = [];

          if (otherOpenDisputes.rowCount && otherOpenDisputes.rowCount > 0) {
            blockingReasons.push(`${otherOpenDisputes.rowCount} other open dispute(s)`);
          }

          if (disputeClosedUser?.stripe_subscription_id) {
            try {
              const stripeClient = await (await import('../../client')).getStripeClient();
              const sub = await stripeClient.subscriptions.retrieve(disputeClosedUser.stripe_subscription_id);
              if (sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'canceled') {
                blockingReasons.push(`subscription status is '${sub.status}'`);
              }
            } catch (subErr: unknown) {
              logger.warn(`[Stripe Webhook] Could not verify subscription status for dispute reactivation — blocking as precaution`, { error: getErrorMessage(subErr) });
              blockingReasons.push('subscription status could not be verified');
            }
          }

          if (blockingReasons.length > 0) {
            membershipAction = 'blocked_manual_review';
            logger.warn(`[Stripe Webhook] Dispute won for user ${terminalPayment.user_id} but cannot auto-reactivate: ${blockingReasons.join(', ')}`);

            deferredActions.push(async () => {
              await notifyAllStaff(
                'Dispute Won — Manual Review Required',
                `Payment dispute ${id} won for ${terminalPayment.user_email} ($${(amount / 100).toFixed(2)}), ` +
                `but auto-reactivation was blocked: ${blockingReasons.join('; ')}. ` +
                `Please review and reactivate manually if appropriate.`,
                'terminal_dispute_closed',
                { sendPush: true }
              );
            });
          } else {
            membershipAction = 'reactivated';
            await client.query(
              `UPDATE users SET membership_status = 'active', membership_status_changed_at = CASE WHEN membership_status IS DISTINCT FROM 'active' THEN NOW() ELSE membership_status_changed_at END, billing_provider = 'stripe', archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = $1`,
              [terminalPayment.user_id]
            );
            logger.info(`[Stripe Webhook] Reactivated membership for user ${terminalPayment.user_id} - dispute won`);
          
            await client.query(
              `INSERT INTO notifications (user_email, title, message, type, related_type, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW())`,
              [
                terminalPayment.user_email.toLowerCase(), 
                'Membership Reactivated', 
                'Your membership has been reactivated. The payment dispute has been resolved in your favor.',
                'billing',
                'membership'
              ]
            );
          }
        }
      }

      const disputeStaffTitle = membershipAction === 'reactivated'
        ? 'Dispute Won - Membership Reactivated'
        : membershipAction === 'blocked_manual_review'
          ? 'Dispute Won - Reactivation Blocked (Review Required)'
          : 'Dispute Lost - Membership Remains Suspended';
      const disputeStaffMessage = membershipAction === 'reactivated'
        ? `Payment dispute for ${terminalPayment.user_email} has been closed. Status: ${status}. Amount: $${(amount / 100).toFixed(2)}. Membership has been reactivated.`
        : membershipAction === 'blocked_manual_review'
          ? `Payment dispute for ${terminalPayment.user_email} has been closed (won). Amount: $${(amount / 100).toFixed(2)}. Auto-reactivation was blocked — manual review required.`
          : `Payment dispute for ${terminalPayment.user_email} has been closed. Status: ${status}. Amount: $${(amount / 100).toFixed(2)}. Membership remains suspended.`;
      
      deferredActions.push(async () => {
        await notifyAllStaff(
          disputeStaffTitle,
          disputeStaffMessage,
          'terminal_dispute_closed',
          { sendPush: true }
        );
        
        await logSystemAction({
          action: 'terminal_dispute_closed',
          resourceType: 'user',
          resourceId: terminalPayment.user_id,
          resourceName: terminalPayment.user_email,
          details: {
            source: 'stripe_webhook',
            dispute_id: id,
            dispute_status: status,
            dispute_won: disputeWon,
            stripe_payment_intent_id: paymentIntentId,
            stripe_subscription_id: terminalPayment.stripe_subscription_id,
            amount_cents: terminalPayment.amount_cents,
            disputed_amount_cents: amount,
            membership_action: membershipAction
          }
        });
      });
    }
  }
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({ action: 'payment_succeeded', status, amount });
  });
  
  return deferredActions;
}

export async function handleChargeDisputeUpdated(client: PoolClient, dispute: Stripe.Dispute): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];

  try {
    const { id, amount, payment_intent, reason, status, evidence_details } = dispute;

    const paymentIntentId = typeof payment_intent === 'string'
      ? payment_intent
      : payment_intent?.id || null;

    if (paymentIntentId) {
      await client.query(
        `UPDATE terminal_payments SET dispute_status = $1 WHERE stripe_payment_intent_id = $2`,
        [status, paymentIntentId]
      );
    }

    const statusDescriptions: Record<string, string> = {
      'needs_response': 'Needs Response',
      'under_review': 'Under Review',
      'won': 'Won',
      'lost': 'Lost',
      'warning_needs_response': 'Warning - Needs Response',
      'warning_under_review': 'Warning - Under Review',
      'warning_closed': 'Warning - Closed',
      'charge_refunded': 'Charge Refunded',
    };

    const statusDescription = statusDescriptions[status] || status;

    logger.info(`[Stripe Webhook] Dispute ${id} updated: status=${status} (${statusDescription}), amount=$${(amount / 100).toFixed(2)}, reason=${reason}`);

    deferredActions.push(async () => {
      try {
        await notifyAllStaff(
          'Dispute Status Updated',
          `Dispute ${id} status changed to ${statusDescription}. Amount: $${(amount / 100).toFixed(2)}. Reason: ${reason || 'unknown'}.${paymentIntentId ? ` Payment Intent: ${paymentIntentId}` : ''}`,
          'billing',
          { sendPush: status === 'needs_response' || status === 'warning_needs_response' }
        );
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to notify staff about dispute update:', { error: getErrorMessage(err) });
      }
    });

    deferredActions.push(async () => {
      try {
        await logSystemAction({
          action: 'charge_dispute_updated',
          resourceType: 'dispute',
          resourceId: id,
          details: {
            status,
            statusDescription,
            amount: amount / 100,
            reason,
            paymentIntentId,
            evidenceDueBy: evidence_details?.due_by ? new Date(evidence_details.due_by * 1000).toISOString() : null,
          },
        });
      } catch (err: unknown) {
        logger.error('[Stripe Webhook] Failed to log dispute update:', { error: getErrorMessage(err) });
      }
    });
  } catch (error: unknown) {
    logger.error('[Stripe Webhook] Error handling charge.dispute.updated:', { error: getErrorMessage(error) });
  }

  return deferredActions;
}

export async function handlePaymentIntentSucceeded(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, metadata, amount, currency, customer, receipt_email, description, created } = paymentIntent;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Payment succeeded: ${id}, amount: $${(amount / 100).toFixed(2)}`);

  const customerEmail = typeof customer === 'object' ? (customer as Stripe.Customer)?.email : receipt_email || metadata?.email;
  const customerName = typeof customer === 'object' ? (customer as Stripe.Customer)?.name : metadata?.memberName;
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'payment_intent',
      amountCents: amount,
      currency: currency || 'usd',
      status: 'succeeded',
      createdAt: new Date(created * 1000),
      customerId,
      customerEmail,
      customerName,
      description: description || metadata?.productName || 'Stripe payment',
      metadata,
      source: 'webhook',
      paymentIntentId: id,
    });
  });

  const bookingIdFromMeta = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;
  const sessionIdFromMeta = metadata?.sessionId ? parseInt(metadata.sessionId, 10) : NaN;
  const userIdFromMeta = metadata?.email || metadata?.memberEmail || customerEmail || '';

  await client.query(
    `INSERT INTO stripe_payment_intents 
       (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, booking_id, session_id, description, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded', NOW(), NOW())
     ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
       status = 'succeeded',
       updated_at = NOW(),
       booking_id = COALESCE(stripe_payment_intents.booking_id, EXCLUDED.booking_id),
       session_id = COALESCE(stripe_payment_intents.session_id, EXCLUDED.session_id)`,
    [
      userIdFromMeta,
      id,
      customerId || null,
      amount,
      metadata?.purpose || 'payment',
      isNaN(bookingIdFromMeta) ? null : bookingIdFromMeta,
      isNaN(sessionIdFromMeta) ? null : sessionIdFromMeta,
      description || metadata?.productName || 'Stripe payment',
    ]
  );

  const sessionId = metadata?.sessionId ? parseInt(metadata.sessionId, 10) : NaN;
  const bookingId = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;
  const amountDollars = (amount / 100).toFixed(2);
  
  interface ParticipantFee { id: number; amountCents: number; }
  let participantFees: ParticipantFee[] = [];
  let validatedParticipantIds: number[] = [];
  const feeSnapshotId = metadata?.feeSnapshotId ? parseInt(metadata.feeSnapshotId, 10) : NaN;
  
  if (!isNaN(feeSnapshotId)) {
    const snapshotResult = await client.query(
      `SELECT bfs.*
       FROM booking_fee_snapshots bfs
       WHERE bfs.id = $1 AND bfs.stripe_payment_intent_id = $2 AND bfs.status IN ('pending', 'failed')
       FOR UPDATE OF bfs`,
      [feeSnapshotId, id]
    );
    
    if (snapshotResult.rows.length === 0) {
      logger.error(`[Stripe Webhook] Fee snapshot ${feeSnapshotId} not found, already used, or locked by another process — queueing auto-refund for orphaned payment`);
      await queueJobInTransaction(client, 'stripe_auto_refund', {
        paymentIntentId: id,
        reason: 'duplicate',
        metadata: {
          reason: 'snapshot_not_found_or_already_used',
          feeSnapshotId: String(feeSnapshotId),
          bookingId: String(bookingId),
        },
        idempotencyKey: `refund_orphaned_snapshot_${id}_${feeSnapshotId}`,
        sessionId: !isNaN(sessionId) ? sessionId : undefined,
        reviewReason: `Auto-refund queued for orphaned payment: PI ${id}, $${amountDollars}. Fee snapshot ${feeSnapshotId} not found or already used.`,
      }, { priority: 10, maxRetries: 5 });
      return deferredActions;
    }
    
    const snapshot = snapshotResult.rows[0];
    
    if (Math.abs(snapshot.total_cents - amount) > 1) {
      logger.error(`[Stripe Webhook] CRITICAL: Amount mismatch: snapshot=${snapshot.total_cents}, payment=${amount} - flagging for review`);
      await client.query(
        `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
        [`Amount mismatch: expected ${snapshot.total_cents} cents, received ${amount} cents from Stripe`, snapshot.session_id]
      );
    }
    
    const capturedSessionId = snapshot.session_id;
    const capturedSnapshotTotal = snapshot.total_cents;
    deferredActions.push(async () => {
      try {
        const currentFees = await computeFeeBreakdown({ 
          sessionId: capturedSessionId, 
          source: 'stripe',
          excludeSessionFromUsage: true
        });
        
        if (Math.abs(currentFees.totals.totalCents - capturedSnapshotTotal) > 100) {
          logger.error(`[Stripe Webhook] Fee snapshot mismatch - potential drift detected`, { extra: { detail: {
            sessionId: capturedSessionId,
            snapshotTotal: capturedSnapshotTotal,
            currentTotal: currentFees.totals.totalCents,
            difference: currentFees.totals.totalCents - capturedSnapshotTotal
          } } });
        }
      } catch (verifyError: unknown) {
        logger.warn(`[Stripe Webhook] Could not verify fee breakdown for session ${capturedSessionId}:`, { error: getErrorMessage(verifyError) });
      }
    });
    
    const snapshotFees: ParticipantFee[] = snapshot.participant_fees;
    const participantIds = snapshotFees.map(pf => pf.id);
    
    const statusCheck = await client.query(
      `SELECT id, payment_status FROM booking_participants WHERE id = ANY($1::int[]) ORDER BY id ASC FOR UPDATE`,
      [participantIds]
    );
    
    const statusMap = new Map<number, string>();
    for (const row of statusCheck.rows) {
      statusMap.set(row.id, row.payment_status || 'pending');
    }
    
    for (const pf of snapshotFees) {
      const status = statusMap.get(pf.id);
      if (status === 'paid' || status === 'waived') {
        logger.warn(`[Stripe Webhook] Participant ${pf.id} already ${status} - skipping`);
        continue;
      }
      participantFees.push(pf);
      validatedParticipantIds.push(pf.id);
    }
    
    const unpaidTotal = participantFees.reduce((sum, pf) => sum + pf.amountCents, 0);
    if (amount > unpaidTotal + 1 && participantFees.length < snapshotFees.length) {
      const alreadyPaidCount = snapshotFees.length - participantFees.length;
      const overpaymentCents = amount - unpaidTotal;
      logger.error(`[Stripe Webhook] CRITICAL: Overpayment detected — auto-refunding`, { extra: { detail: {
        sessionId: snapshot.session_id,
        paymentIntentId: id,
        paymentAmount: amount,
        unpaidTotal,
        overpaymentCents,
        alreadyPaidCount,
        message: `Payment of ${amount} cents received but only ${unpaidTotal} cents was owed. ${alreadyPaidCount} participant(s) already paid separately.`
      } } });

      if (validatedParticipantIds.length === 0) {
        await queueJobInTransaction(client, 'stripe_auto_refund', {
          paymentIntentId: id,
          reason: 'duplicate',
          metadata: {
            reason: 'all_participants_already_paid',
            sessionId: String(snapshot.session_id),
            bookingId: String(bookingId),
            overpaymentCents: String(overpaymentCents),
          },
          idempotencyKey: `refund_overpayment_full_${id}_${bookingId}`,
          sessionId: snapshot.session_id,
          reviewReason: `Auto-refund failed for overpayment: PI ${id}, ${overpaymentCents} cents. All participants already paid.`,
        }, { priority: 10, maxRetries: 5 });
      } else {
        await queueJobInTransaction(client, 'stripe_auto_refund', {
          paymentIntentId: id,
          amountCents: overpaymentCents,
          reason: 'duplicate',
          metadata: {
            reason: 'partial_participants_already_paid',
            sessionId: String(snapshot.session_id),
            bookingId: String(bookingId),
            overpaymentCents: String(overpaymentCents),
          },
          idempotencyKey: `refund_overpayment_partial_${id}_${bookingId}_${overpaymentCents}`,
          sessionId: snapshot.session_id,
          reviewReason: `Partial auto-refund failed: PI ${id}, ${overpaymentCents} cents overpaid.`,
        }, { priority: 10, maxRetries: 5 });
      }
    }
    
    await client.query(
      `UPDATE booking_fee_snapshots SET status = 'completed', used_at = NOW() WHERE id = $1`,
      [feeSnapshotId]
    );
    
    if (validatedParticipantIds.length > 0) {
      await client.query(
        `UPDATE booking_participants
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
         WHERE id = ANY($1::int[])`,
        [validatedParticipantIds, id]
      );
      logger.info(`[Stripe Webhook] Updated ${validatedParticipantIds.length} participant(s) to paid within transaction`);
      
      for (const pf of participantFees) {
        await logPaymentAudit({
          bookingId,
          sessionId: isNaN(sessionId) ? null : sessionId,
          participantId: pf.id,
          action: 'payment_confirmed',
          staffEmail: 'system',
          staffName: 'Stripe Webhook',
          amountAffected: pf.amountCents / 100,
          paymentMethod: 'stripe',
          metadata: { stripePaymentIntentId: id },
        });
      }
      
      const localBookingId = bookingId;
      const localSessionId = sessionId;
      const localAmount = amount;
      deferredActions.push(async () => {
        broadcastBillingUpdate({
          action: 'booking_payment_updated',
          bookingId: localBookingId,
          sessionId: isNaN(localSessionId) ? undefined : localSessionId,
          amount: localAmount
        });
      });
    }
    
    logger.info(`[Stripe Webhook] Snapshot ${feeSnapshotId} processed (validation + payment update + audit)`);
    validatedParticipantIds = [];
    participantFees = [];
  } else if (metadata?.participantFees) {
    logger.warn(`[Stripe Webhook] No snapshot ID - falling back to DB cached fee validation`);
    let clientFees: ParticipantFee[];
    try {
      clientFees = JSON.parse(metadata.participantFees);
    } catch (parseErr: unknown) {
      logger.error(`[Stripe Webhook] Failed to parse participantFees metadata for PI ${id} - marking for review`, { error: getErrorMessage(parseErr) });
      await client.query(
        `INSERT INTO audit_log (action, resource_type, resource_id, details, created_at)
         VALUES ('parse_error', 'payment', $1, $2, NOW())`,
        [id, JSON.stringify({ error: 'Failed to parse participantFees metadata', raw: metadata.participantFees?.substring(0, 200) })]
      );
      clientFees = [];
    }
    if (clientFees.length === 0 && metadata?.participantFees) {
      logger.warn(`[Stripe Webhook] Empty or unparseable participantFees for PI ${id} - skipping participant updates`);
    }
    const participantIds = clientFees.map(pf => pf.id);
    
    const dbResult = await client.query(
      `SELECT bp.id, bp.payment_status, bp.cached_fee_cents
       FROM booking_participants bp
       WHERE bp.id = ANY($1::int[])
       ORDER BY bp.id ASC
       FOR UPDATE`,
      [participantIds]
    );
    
    const dbFeeMap = new Map<number, number>();
    const statusMap = new Map<number, string>();
    for (const row of dbResult.rows) {
      dbFeeMap.set(row.id, row.cached_fee_cents || 0);
      statusMap.set(row.id, row.payment_status || 'pending');
    }
    
    for (const pf of clientFees) {
      const cachedFee = dbFeeMap.get(pf.id);
      if (cachedFee === undefined) {
        logger.warn(`[Stripe Webhook] Fallback: participant ${pf.id} not in booking - skipping`);
        continue;
      }
      const status = statusMap.get(pf.id);
      if (status === 'paid' || status === 'waived') {
        logger.warn(`[Stripe Webhook] Fallback: participant ${pf.id} already ${status} - skipping`);
        continue;
      }
      if (cachedFee <= 0) {
        logger.warn(`[Stripe Webhook] Fallback: participant ${pf.id} has no cached fee - skipping`);
        continue;
      }
      participantFees.push({ id: pf.id, amountCents: cachedFee });
      validatedParticipantIds.push(pf.id);
    }
    
    const dbTotal = participantFees.reduce((sum, pf) => sum + pf.amountCents, 0);
    if (Math.abs(dbTotal - amount) > 1) {
      logger.error(`[Stripe Webhook] CRITICAL: Fallback total mismatch: db=${dbTotal}, payment=${amount} - flagging for review`);
      if (sessionId) {
        await client.query(
          `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
          [`Fallback amount mismatch: expected ${dbTotal} cents, received ${amount} cents from Stripe`, sessionId]
        );
      }
    }
    
    logger.info(`[Stripe Webhook] Fallback validated ${validatedParticipantIds.length} participants using DB cached fees`);
  }

  if (validatedParticipantIds.length === 0 && !isNaN(bookingId) && metadata?.paymentType === 'booking_fee') {
    logger.warn(`[Stripe Webhook] No snapshot or participantFees metadata for booking_fee PI ${id} — attempting booking-fee fallback`);
    const fallbackResult = await client.query(
      `SELECT bp.id, bp.cached_fee_cents FROM booking_participants bp
       WHERE bp.session_id = (SELECT session_id FROM booking_requests WHERE id = $1)
       AND bp.payment_status = 'pending' AND bp.cached_fee_cents > 0
       AND bp.stripe_payment_intent_id IS NULL
       ORDER BY bp.id ASC
       FOR UPDATE`,
      [bookingId]
    );

    if (fallbackResult.rows.length > 0) {
      const fallbackTotal = fallbackResult.rows.reduce((sum: number, r: { cached_fee_cents: number }) => sum + r.cached_fee_cents, 0);
      const tolerance = 50;

      if (Math.abs(fallbackTotal - amount) <= tolerance) {
        for (const row of fallbackResult.rows) {
          participantFees.push({ id: row.id, amountCents: row.cached_fee_cents });
          validatedParticipantIds.push(row.id);
        }
        logger.info(`[Stripe Webhook] Booking-fee fallback: matched ${validatedParticipantIds.length} participant(s) for booking ${bookingId} (pending=${fallbackTotal}, paid=${amount})`);
      } else {
        logger.warn(`[Stripe Webhook] Booking-fee fallback: amount mismatch for booking ${bookingId} (pending=${fallbackTotal}, paid=${amount}, tolerance=${tolerance}) — skipping auto-update`);
        if (!isNaN(sessionId)) {
          await client.query(
            `UPDATE booking_sessions SET needs_review = true, review_reason = $1 WHERE id = $2`,
            [`Booking-fee fallback amount mismatch: pending fees ${fallbackTotal} cents vs payment ${amount} cents`, sessionId]
          );
        }
      }
    } else {
      logger.info(`[Stripe Webhook] Booking-fee fallback: no pending participants found for booking ${bookingId}`);
    }
  }

  if (validatedParticipantIds.length > 0) {
    const updateResult = await client.query(
      `UPDATE booking_participants
       SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
       WHERE id = ANY($1::int[])
       RETURNING id`,
      [validatedParticipantIds, id]
    );
    logger.info(`[Stripe Webhook] Updated ${updateResult.rowCount} participant(s) to paid and cleared cached fees with intent ${id}`);
    
    const localBookingId = bookingId;
    const localSessionId = sessionId;
    const localAmount = amount;
    deferredActions.push(async () => {
      broadcastBillingUpdate({
        action: 'booking_payment_updated',
        bookingId: localBookingId,
        sessionId: isNaN(localSessionId) ? undefined : localSessionId,
        amount: localAmount
      });
    });
  }

  if (!isNaN(bookingId) && bookingId > 0) {
    if (participantFees.length > 0) {
      for (const pf of participantFees) {
        await logPaymentAudit({
          bookingId,
          sessionId: isNaN(sessionId) ? null : sessionId,
          participantId: pf.id,
          action: 'payment_confirmed',
          staffEmail: 'system',
          staffName: 'Stripe Webhook',
          amountAffected: pf.amountCents / 100,
          paymentMethod: 'stripe',
          metadata: { stripePaymentIntentId: id },
        });
      }
      logger.info(`[Stripe Webhook] Created ${participantFees.length} audit record(s) for booking ${bookingId}`);
    } else {
      await logPaymentAudit({
        bookingId,
        sessionId: isNaN(sessionId) ? null : sessionId,
        participantId: null,
        action: 'payment_confirmed',
        staffEmail: 'system',
        staffName: 'Stripe Webhook',
        amountAffected: parseFloat(amountDollars),
        paymentMethod: 'stripe',
        metadata: { stripePaymentIntentId: id },
      });
      logger.info(`[Stripe Webhook] Created payment audit record for booking ${bookingId}`);
    }
  }

  const pendingCreditRefund = metadata?.pendingCreditRefund ? parseInt(metadata.pendingCreditRefund, 10) : 0;
  if (pendingCreditRefund > 0 && customerId) {
    await queueJobInTransaction(client, 'stripe_credit_refund', {
      paymentIntentId: id,
      amountCents: pendingCreditRefund,
      email: metadata?.email || ''
    }, { webhookEventId: id, priority: 2, maxRetries: 5 });
    logger.info(`[Stripe Webhook] Queued credit refund of $${(pendingCreditRefund / 100).toFixed(2)} for ${metadata?.email || 'unknown'}`);
  }

  const creditToConsume = metadata?.creditToConsume ? parseInt(metadata.creditToConsume, 10) : 0;
  const alreadyConsumedSync = !!metadata?.balanceTransactionId;
  if (creditToConsume > 0 && customerId && !alreadyConsumedSync) {
    await queueJobInTransaction(client, 'stripe_credit_consume', {
      customerId,
      paymentIntentId: id,
      amountCents: creditToConsume,
      email: metadata?.email || ''
    }, { webhookEventId: id, priority: 2, maxRetries: 5 });
    logger.info(`[Stripe Webhook] Queued credit consumption of $${(creditToConsume / 100).toFixed(2)} for ${metadata?.email || 'unknown'}`);
  }

  const posInvoiceId = metadata?.draftInvoiceId || metadata?.invoice_id;
  if (posInvoiceId) {
    deferredActions.push(async () => {
      try {
        const isTerminalPayment = paymentIntent.payment_method_types?.includes('card_present') || metadata?.paidVia === 'terminal';
        const result = await finalizeInvoicePaidOutOfBand(posInvoiceId, isTerminalPayment ? { terminalPaymentIntentId: id } : undefined);
        if (result.success) {
          logger.info(`[Stripe Webhook] Invoice ${posInvoiceId} finalized and paid${isTerminalPayment ? ' via terminal PI' : ' out-of-band'} for PI ${id}`);
        } else {
          logger.error(`[Stripe Webhook] Failed to finalize invoice ${posInvoiceId}: ${result.error}`);
        }
      } catch (invoiceErr: unknown) {
        logger.error(`[Stripe Webhook] Error finalizing invoice ${posInvoiceId}:`, { error: getErrorMessage(invoiceErr) });
      }
    });
  }

  const paymentMemberEmail = metadata?.email || customerEmail || 'unknown';
  const paymentDescription = description || metadata?.productName || 'Stripe payment';
  deferredActions.push(async () => {
    await logSystemAction({
      action: 'payment_succeeded',
      resourceType: 'payment',
      resourceId: id,
      resourceName: `Payment from ${paymentMemberEmail}`,
      details: {
        source: 'stripe_webhook',
        amount_cents: amount,
        member_email: paymentMemberEmail,
        description: paymentDescription
      }
    });
  });

  if (metadata?.email && metadata?.purpose) {
    if (metadata.purpose === 'add_funds') {
      logger.info(`[Stripe Webhook] Skipping PI-level notifications for add_funds payment ${id} — already handled by checkout.session.completed`);
    } else {
      const email = metadata.email;
      const desc = paymentIntent.description || `Stripe payment: ${metadata.purpose}`;
      const _localBookingId = bookingId;
      const localAmount = amount;
      const localId = id;
      
      const userResult = await client.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
      const memberName = userResult.rows[0] 
        ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
        : email;

      await queueJobInTransaction(client, 'send_payment_receipt', {
        to: email,
        memberName,
        amount: localAmount / 100,
        description: desc,
        date: new Date().toISOString(),
        paymentMethod: 'card'
      }, { webhookEventId: localId, priority: 2 });

      await queueJobInTransaction(client, 'notify_payment_success', {
        userEmail: email,
        amount: localAmount / 100,
        description: desc
      }, { webhookEventId: localId, priority: 1 });

      await queueJobInTransaction(client, 'notify_all_staff', {
        title: 'Payment Received',
        message: `${memberName} (${email}) made a payment of $${(localAmount / 100).toFixed(2)} for: ${desc}`,
        type: 'payment_success'
      }, { webhookEventId: localId, priority: 0 });

      await queueJobInTransaction(client, 'broadcast_billing_update', {
        action: 'payment_succeeded',
        memberEmail: email,
        memberName,
        amount: localAmount / 100
      }, { webhookEventId: localId, priority: 0 });

      logger.info(`[Stripe Webhook] Queued ${5} jobs for payment ${localId} to ${email}`);
    }
  }

  return deferredActions;
}

export async function handlePaymentIntentStatusUpdate(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, status, amount, currency, customer, metadata, created } = paymentIntent;
  const deferredActions: DeferredAction[] = [];

  logger.info(`[Stripe Webhook] Payment intent status update: ${id} → ${status}`);

  await client.query(
    `UPDATE stripe_payment_intents SET status = $2, updated_at = NOW() WHERE stripe_payment_intent_id = $1`,
    [id, status]
  );

  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const customerEmail = typeof customer === 'object' ? (customer as Stripe.Customer)?.email : metadata?.email;
  const customerName = typeof customer === 'object' ? (customer as Stripe.Customer)?.name : metadata?.memberName;

  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'payment_intent',
      amountCents: amount,
      currency: currency || 'usd',
      status,
      createdAt: new Date(created * 1000),
      customerId,
      customerEmail,
      customerName,
      description: metadata?.description || `Payment ${status}`,
      metadata,
      source: 'webhook',
      paymentIntentId: id,
    });
  });

  return deferredActions;
}

export async function handlePaymentIntentFailed(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, metadata, amount, last_payment_error, customer } = paymentIntent;
  const reason = last_payment_error?.message || 'Payment could not be processed';
  const errorCode = last_payment_error?.code || 'unknown';
  const declineCode = last_payment_error?.decline_code;
  
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Payment failed: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${reason}, code: ${errorCode}${declineCode ? `, decline_code: ${declineCode}` : ''}`);
  
  logPaymentFailure({
    paymentIntentId: id,
    customerId: typeof customer === 'string' ? customer : customer?.id,
    userEmail: metadata?.email,
    amountCents: amount,
    errorMessage: reason,
    errorCode
  });

  const existingResult = await client.query(
    `SELECT retry_count FROM stripe_payment_intents WHERE stripe_payment_intent_id = $1`,
    [id]
  );
  const currentRetryCount = existingResult.rows[0]?.retry_count || 0;
  
  const newRetryCount = currentRetryCount + 1;
  const requiresCardUpdate = newRetryCount >= MAX_RETRY_ATTEMPTS;

  await client.query(
    `UPDATE stripe_payment_intents 
     SET status = 'failed', 
         updated_at = NOW(),
         retry_count = $2,
         last_retry_at = NOW(),
         failure_reason = $3,
         dunning_notified_at = NOW(),
         requires_card_update = $4
     WHERE stripe_payment_intent_id = $1`,
    [id, newRetryCount, reason, requiresCardUpdate]
  );

  await client.query(
    `UPDATE booking_fee_snapshots SET status = 'failed' WHERE stripe_payment_intent_id = $1 AND status = 'pending'`,
    [id]
  );
  
  logger.info(`[Stripe Webhook] Updated payment ${id}: retry ${newRetryCount}/${MAX_RETRY_ATTEMPTS}, requires_card_update=${requiresCardUpdate}`);

  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const customerEmail = typeof customer === 'object' ? (customer as Stripe.Customer)?.email : metadata?.email;
  const customerName = typeof customer === 'object' ? (customer as Stripe.Customer)?.name : metadata?.memberName;
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: id,
      objectType: 'payment_intent',
      amountCents: amount,
      currency: paymentIntent.currency || 'usd',
      status: 'failed',
      createdAt: new Date(paymentIntent.created * 1000),
      customerId,
      customerEmail,
      customerName,
      description: metadata?.description || `Failed payment - ${reason}`,
      metadata,
      source: 'webhook',
      paymentIntentId: id,
    });
  });

  const failedPaymentEmail = metadata?.email || customerEmail || 'unknown';
  deferredActions.push(async () => {
    await logSystemAction({
      action: 'payment_failed',
      resourceType: 'payment',
      resourceId: id,
      resourceName: `Failed payment from ${failedPaymentEmail}`,
      details: {
        source: 'stripe_webhook',
        amount_cents: amount,
        member_email: failedPaymentEmail,
        failure_reason: reason,
        error_code: errorCode,
        decline_code: declineCode || null,
        retry_count: newRetryCount,
        requires_card_update: requiresCardUpdate
      }
    });
  });

  deferredActions.push(async () => {
    try {
      await sendErrorAlert({
        type: 'payment_failure',
        title: requiresCardUpdate
          ? `Payment failed ${newRetryCount}x — card update needed`
          : `Payment failed (attempt ${newRetryCount})`,
        message: `PaymentIntent ${id} for ${failedPaymentEmail}: $${(amount / 100).toFixed(2)} — ${reason}${declineCode ? ` (decline: ${declineCode})` : ''}`,
        userEmail: failedPaymentEmail !== 'unknown' ? failedPaymentEmail : undefined,
        details: {
          paymentIntentId: id,
          amount_cents: amount,
          error_code: errorCode,
          decline_code: declineCode || null,
          retry_count: newRetryCount,
          requires_card_update: requiresCardUpdate
        }
      });
    } catch (alertErr: unknown) {
      logger.error('[Stripe Webhook] Error alert send failed (non-blocking):', { error: getErrorMessage(alertErr) });
    }
  });

  const email = metadata?.email;
  if (!email) {
    logger.warn('[Stripe Webhook] No email in metadata for failed payment - cannot send notifications');
    return deferredActions;
  }

  const bookingId = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;
  const localAmount = amount;
  const localReason = reason;
  const localRequiresCardUpdate = requiresCardUpdate;
  const localRetryCount = newRetryCount;
  const localErrorCode = errorCode;
  const localDeclineCode = declineCode;

  deferredActions.push(async () => {
    try {
      const userResult = await db.execute(sql`SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1`);
      const memberName = userResult.rows[0] 
        ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
        : email;

      const memberMessage = localRequiresCardUpdate
        ? `Your payment of $${(localAmount / 100).toFixed(2)} failed after ${MAX_RETRY_ATTEMPTS} attempts. Please update your payment method.`
        : `Your payment of $${(localAmount / 100).toFixed(2)} could not be processed. Reason: ${localReason}`;

      await notifyPaymentFailed(email, localAmount / 100, memberMessage, { 
        sendEmail: false, 
        bookingId: !isNaN(bookingId) ? bookingId : undefined 
      });

      await sendPaymentFailedEmail(email, { 
        memberName, 
        amount: localAmount / 100, 
        reason: localRequiresCardUpdate 
          ? `Payment failed after ${MAX_RETRY_ATTEMPTS} attempts. Please update your card.`
          : localReason
      });

      logger.info(`[Stripe Webhook] Payment failed notifications sent to ${email} (retry=${localRetryCount}, requires_card_update=${localRequiresCardUpdate})`);

      const staffMessage = localRequiresCardUpdate
        ? `${memberName} (${email}) payment failed ${localRetryCount}x — card update required. Code: ${localErrorCode}${localDeclineCode ? ` / ${localDeclineCode}` : ''}`
        : `Payment of $${(localAmount / 100).toFixed(2)} failed for ${memberName} (${email}). Attempt ${localRetryCount}/${MAX_RETRY_ATTEMPTS}. Reason: ${localReason}`;
      
      await notifyStaffPaymentFailed(email, memberName, localAmount / 100, staffMessage);

      broadcastBillingUpdate({
        action: 'payment_failed',
        memberEmail: email,
        memberName,
        amount: localAmount / 100,
      });

      logger.info(`[Stripe Webhook] Staff notified about payment failure for ${email}`);
    } catch (error: unknown) {
      logger.error('[Stripe Webhook] Error sending payment failed notifications:', { error: getErrorMessage(error) });
    }
  });

  return deferredActions;
}

export async function handlePaymentIntentCanceled(client: PoolClient, paymentIntent: Stripe.PaymentIntent): Promise<DeferredAction[]> {
  const { id, metadata, amount, cancellation_reason } = paymentIntent;
  const deferredActions: DeferredAction[] = [];
  
  logger.info(`[Stripe Webhook] Payment canceled: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${cancellation_reason || 'not specified'}`);
  
  if (metadata?.paymentType === 'subscription_terminal') {
    const email = metadata?.email;
    const subscriptionId = metadata?.subscriptionId;
    
    try {
      await client.query(
        `INSERT INTO terminal_payments (
          user_id, user_email, stripe_payment_intent_id, stripe_subscription_id,
          amount_cents, currency, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET 
          status = 'canceled', updated_at = NOW()`,
        [
          metadata?.userId || null,
          email || 'unknown',
          id,
          subscriptionId || null,
          amount,
          paymentIntent.currency || 'usd',
          'canceled'
        ]
      );
    } catch (upsertErr: unknown) {
      logger.warn(`[Stripe Webhook] Upsert failed for canceled payment ${id}, attempting UPDATE fallback`, { error: getErrorMessage(upsertErr) });
      try {
        const updateResult = await client.query(
          `UPDATE terminal_payments SET status = 'canceled', updated_at = NOW() WHERE stripe_payment_intent_id = $1`,
          [id]
        );
        if (updateResult.rowCount === 0) {
          await client.query(
            `INSERT INTO terminal_payments (
              user_id, user_email, stripe_payment_intent_id, stripe_subscription_id,
              amount_cents, currency, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
            [
              metadata?.userId || null,
              email || 'unknown',
              id,
              subscriptionId || null,
              amount,
              paymentIntent.currency || 'usd',
              'canceled'
            ]
          );
        }
      } catch (fallbackErr: unknown) {
        logger.error(`[Stripe Webhook] Failed to record canceled payment ${id} even with fallback`, { error: getErrorMessage(fallbackErr) });
      }
    }
    
    logger.info(`[Stripe Webhook] Terminal payment canceled/abandoned: ${id} for ${email || 'unknown'}`);
    
    deferredActions.push(async () => {
      await notifyAllStaff(
        'Terminal Payment Canceled',
        `A card reader payment was canceled or timed out. Email: ${email || 'unknown'}, Amount: $${(amount / 100).toFixed(2)}, Subscription: ${subscriptionId || 'N/A'}`,
        'terminal_payment_canceled',
        { sendPush: true }
      );
      
      await logSystemAction({
        action: 'terminal_payment_canceled',
        resourceType: 'payment',
        resourceId: id,
        resourceName: email || 'Unknown',
        details: {
          source: 'stripe_webhook',
          cancellation_reason: cancellation_reason,
          stripe_payment_intent_id: id,
          stripe_subscription_id: subscriptionId,
          amount_cents: amount
        }
      });
    });
  }
  
  return deferredActions;
}
