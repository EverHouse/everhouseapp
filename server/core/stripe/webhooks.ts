import { getStripeSync, getStripeClient } from './client';
import { syncCompanyToHubSpot, queuePaymentSyncToHubSpot, queueDayPassSyncToHubSpot } from '../hubspot';
import { pool } from '../db';
import { db } from '../../db';
import { groupMembers } from '../../../shared/models/hubspot-billing';
import { eq } from 'drizzle-orm';
import { notifyPaymentSuccess, notifyPaymentFailed, notifyStaffPaymentFailed, notifyMember, notifyAllStaff } from '../notificationService';
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from '../../emails/paymentEmails';
import { sendMembershipRenewalEmail, sendMembershipFailedEmail } from '../../emails/membershipEmails';
import { sendPassWithQrEmail } from '../../emails/passEmails';
import { broadcastBillingUpdate, broadcastDayPassUpdate, sendNotificationToUser } from '../websocket';
import { recordDayPassPurchaseFromWebhook } from '../../routes/dayPasses';
import { handlePrimarySubscriptionCancelled } from './groupBilling';
import { computeFeeBreakdown } from '../billing/unifiedFeeService';
import { logPaymentFailure, logWebhookFailure } from '../monitoring';
import { logSystemAction } from '../auditLog';
import type { PoolClient } from 'pg';

const EVENT_DEDUP_WINDOW_DAYS = 7;

type DeferredAction = () => Promise<void>;

interface WebhookProcessingResult {
  processed: boolean;
  reason?: 'duplicate' | 'out_of_order' | 'error';
  deferredActions: DeferredAction[];
}

function extractResourceId(event: any): string | null {
  const obj = event.data?.object;
  if (!obj || !obj.id) return null;
  
  if (event.type.startsWith('payment_intent.')) return obj.id;
  if (event.type.startsWith('invoice.')) return obj.id;
  if (event.type.startsWith('customer.subscription.')) return obj.id;
  if (event.type.startsWith('checkout.session.')) return obj.id;
  if (event.type.startsWith('charge.')) return obj.payment_intent || obj.id;
  
  return null;
}

async function tryClaimEvent(
  client: PoolClient,
  eventId: string,
  eventType: string,
  eventTimestamp: number,
  resourceId: string | null
): Promise<{ claimed: boolean; reason?: 'duplicate' | 'out_of_order' }> {
  const claimed = await client.query(
    `INSERT INTO webhook_processed_events (event_id, event_type, resource_id, processed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType, resourceId]
  );

  if (claimed.rowCount === 0) {
    return { claimed: false, reason: 'duplicate' };
  }

  return { claimed: true };
}

async function checkResourceEventOrder(
  client: PoolClient,
  resourceId: string,
  eventType: string,
  eventTimestamp: number
): Promise<boolean> {
  const EVENT_PRIORITY: Record<string, number> = {
    // Payment intent lifecycle
    'payment_intent.created': 1,
    'payment_intent.processing': 2,
    'payment_intent.requires_action': 3,
    'payment_intent.succeeded': 10,
    'payment_intent.payment_failed': 10,
    'charge.succeeded': 11,
    'charge.refunded': 20,
    // Invoice lifecycle
    'invoice.created': 1,
    'invoice.finalized': 2,
    'invoice.payment_succeeded': 10,
    'invoice.payment_failed': 10,
    'invoice.paid': 11,
    'invoice.voided': 20,
    'invoice.marked_uncollectible': 20,
    // Subscription lifecycle (prevents cancelled user reactivation)
    'customer.subscription.created': 1,
    'customer.subscription.updated': 5,
    'customer.subscription.paused': 8,
    'customer.subscription.resumed': 9,
    'customer.subscription.deleted': 20,
  };

  const currentPriority = EVENT_PRIORITY[eventType] || 5;

  const result = await client.query(
    `SELECT event_type, processed_at FROM webhook_processed_events 
     WHERE resource_id = $1 AND event_type != $2
     ORDER BY processed_at DESC LIMIT 1`,
    [resourceId, eventType]
  );

  if (result.rows.length === 0) {
    return true;
  }

  const lastEventType = result.rows[0].event_type;
  const lastPriority = EVENT_PRIORITY[lastEventType] || 5;

  if (lastPriority > currentPriority) {
    console.log(`[Stripe Webhook] Out-of-order event: ${eventType} (priority ${currentPriority}) after ${lastEventType} (priority ${lastPriority}) for resource ${resourceId}`);
    return false;
  }

  return true;
}

async function executeDeferredActions(actions: DeferredAction[]): Promise<void> {
  for (const action of actions) {
    try {
      await action();
    } catch (err) {
      console.error('[Stripe Webhook] Deferred action failed (non-critical):', err);
    }
  }
}

interface CacheTransactionParams {
  stripeId: string;
  objectType: 'payment_intent' | 'charge' | 'invoice' | 'refund';
  amountCents: number;
  currency?: string;
  status: string;
  createdAt: Date;
  customerId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  description?: string | null;
  metadata?: Record<string, any> | null;
  source?: 'webhook' | 'backfill';
  paymentIntentId?: string | null;
  chargeId?: string | null;
  invoiceId?: string | null;
}

export async function upsertTransactionCache(params: CacheTransactionParams): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO stripe_transaction_cache 
       (stripe_id, object_type, amount_cents, currency, status, created_at, updated_at, 
        customer_id, customer_email, customer_name, description, metadata, source, 
        payment_intent_id, charge_id, invoice_id)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (stripe_id) DO UPDATE SET
         status = EXCLUDED.status,
         amount_cents = EXCLUDED.amount_cents,
         customer_email = COALESCE(EXCLUDED.customer_email, stripe_transaction_cache.customer_email),
         customer_name = COALESCE(EXCLUDED.customer_name, stripe_transaction_cache.customer_name),
         description = COALESCE(EXCLUDED.description, stripe_transaction_cache.description),
         metadata = COALESCE(EXCLUDED.metadata, stripe_transaction_cache.metadata),
         updated_at = NOW()`,
      [
        params.stripeId,
        params.objectType,
        params.amountCents,
        params.currency || 'usd',
        params.status,
        params.createdAt,
        params.customerId || null,
        params.customerEmail || null,
        params.customerName || null,
        params.description || null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.source || 'webhook',
        params.paymentIntentId || null,
        params.chargeId || null,
        params.invoiceId || null,
      ]
    );
  } catch (err) {
    console.error('[Stripe Cache] Error upserting transaction cache:', err);
  }
}

async function cleanupOldProcessedEvents(): Promise<void> {
  try {
    const result = await pool.query(
      `DELETE FROM webhook_processed_events WHERE processed_at < NOW() - INTERVAL '${EVENT_DEDUP_WINDOW_DAYS} days' RETURNING id`
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[Stripe Webhook] Cleaned up ${result.rowCount} old processed events (>${EVENT_DEDUP_WINDOW_DAYS} days)`);
    }
  } catch (err) {
    console.error('[Stripe Webhook] Error cleaning up old events:', err);
  }
}

export async function processStripeWebhook(
  payload: Buffer,
  signature: string
): Promise<void> {
  if (!Buffer.isBuffer(payload)) {
    throw new Error(
      'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
      'Received type: ' + typeof payload + '. ' +
      'This usually means express.json() parsed the body before reaching this handler.'
    );
  }

  const sync = await getStripeSync();
  await sync.processWebhook(payload, signature);

  const payloadString = payload.toString('utf8');
  const event = JSON.parse(payloadString);

  const resourceId = extractResourceId(event);
  const client = await pool.connect();
  let deferredActions: DeferredAction[] = [];

  try {
    await client.query('BEGIN');

    const claimResult = await tryClaimEvent(client, event.id, event.type, event.created, resourceId);
    
    if (!claimResult.claimed) {
      await client.query('ROLLBACK');
      console.log(`[Stripe Webhook] Skipping ${claimResult.reason} event: ${event.id} (${event.type})`);
      return;
    }

    if (resourceId) {
      const orderOk = await checkResourceEventOrder(client, resourceId, event.type, event.created);
      if (!orderOk) {
        await client.query('ROLLBACK');
        console.log(`[Stripe Webhook] Skipping out-of-order event: ${event.id} (${event.type}) for resource ${resourceId}`);
        return;
      }
    }

    console.log(`[Stripe Webhook] Processing event: ${event.id} (${event.type})`);

    if (event.type === 'payment_intent.succeeded') {
      deferredActions = await handlePaymentIntentSucceeded(client, event.data.object);
    } else if (event.type === 'payment_intent.payment_failed') {
      deferredActions = await handlePaymentIntentFailed(client, event.data.object);
    } else if (event.type === 'charge.refunded') {
      deferredActions = await handleChargeRefunded(client, event.data.object);
    } else if (event.type === 'invoice.payment_succeeded') {
      deferredActions = await handleInvoicePaymentSucceeded(client, event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      deferredActions = await handleInvoicePaymentFailed(client, event.data.object);
    } else if (event.type === 'invoice.created' || event.type === 'invoice.finalized' || event.type === 'invoice.updated') {
      deferredActions = await handleInvoiceLifecycle(client, event.data.object, event.type);
    } else if (event.type === 'invoice.voided' || event.type === 'invoice.marked_uncollectible') {
      deferredActions = await handleInvoiceVoided(client, event.data.object, event.type);
    } else if (event.type === 'checkout.session.completed') {
      deferredActions = await handleCheckoutSessionCompleted(client, event.data.object);
    } else if (event.type === 'customer.subscription.created') {
      deferredActions = await handleSubscriptionCreated(client, event.data.object);
    } else if (event.type === 'customer.subscription.updated') {
      deferredActions = await handleSubscriptionUpdated(client, event.data.object, event.data.previous_attributes);
    } else if (event.type === 'customer.subscription.deleted') {
      deferredActions = await handleSubscriptionDeleted(client, event.data.object);
    }

    await client.query('COMMIT');
    console.log(`[Stripe Webhook] Event ${event.id} committed successfully`);

    await executeDeferredActions(deferredActions);

    cleanupOldProcessedEvents().catch(() => {});
  } catch (handlerError) {
    await client.query('ROLLBACK');
    console.error(`[Stripe Webhook] Handler failed for ${event.type} (${event.id}), rolled back:`, handlerError);
    throw handlerError;
  } finally {
    client.release();
  }
}

async function handleChargeRefunded(client: PoolClient, charge: any): Promise<DeferredAction[]> {
  const { id, amount, amount_refunded, currency, customer, payment_intent, created, refunded } = charge;
  const deferredActions: DeferredAction[] = [];
  
  console.log(`[Stripe Webhook] Charge refunded: ${id}, refunded amount: $${(amount_refunded / 100).toFixed(2)}`);
  
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
    console.log(`[Stripe Webhook] Cached ${refunds.length} refund(s) for charge ${id}`);
  } else {
    console.warn(`[Stripe Webhook] No refund objects found in charge.refunded event for charge ${id}`);
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
    
    const participantUpdate = await client.query(
      `UPDATE booking_participants 
       SET payment_status = 'refunded', refunded_at = NOW()
       WHERE stripe_payment_intent_id = $1 AND payment_status = 'paid'
       RETURNING id, session_id, user_email`,
      [paymentIntentId]
    );
    
    if (participantUpdate.rowCount && participantUpdate.rowCount > 0) {
      console.log(`[Stripe Webhook] Marked ${participantUpdate.rowCount} participant(s) as refunded for PI ${paymentIntentId}`);
      
      for (const row of participantUpdate.rows) {
        await client.query(
          `INSERT INTO booking_payment_audit 
           (booking_id, session_id, participant_id, action, staff_email, staff_name, amount_affected, payment_method, metadata)
           SELECT bs.booking_id, $1, $2, 'refund_processed', 'system', 'Stripe Webhook', 0, 'stripe', $3
           FROM booking_sessions bs WHERE bs.id = $1`,
          [row.session_id, row.id, JSON.stringify({ stripePaymentIntentId: paymentIntentId })]
        );
        
        // Send refund notification to member
        if (row.user_email) {
          const userResult = await client.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [row.user_email]);
          const userId = userResult.rows[0]?.id;
          
          if (userId) {
            await client.query(
              `INSERT INTO notifications (user_id, title, message, type, link, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW())`,
              [userId, 'Payment Refunded', `Your booking payment of $${(amount_refunded / 100).toFixed(2)} has been refunded. It may take 5-10 business days to appear on your statement.`, 'billing', '/billing']
            );
          }
          
          deferredActions.push(async () => {
            sendNotificationToUser(row.user_email, {
              type: 'notification',
              title: 'Payment Refunded',
              message: `Your booking payment of $${(amount_refunded / 100).toFixed(2)} has been refunded. It may take 5-10 business days to appear on your statement.`,
              data: { sessionId: row.session_id, eventType: 'payment_refunded' }
            }, { action: 'payment_refunded', sessionId: row.session_id, triggerSource: 'webhooks.ts' });
          });
        }
      }
    }
  }
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({ type: 'refund', chargeId: id, status, amountRefunded: amount_refunded });
  });

  // Audit log for refunds
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

async function handlePaymentIntentSucceeded(client: PoolClient, paymentIntent: any): Promise<DeferredAction[]> {
  const { id, metadata, amount, currency, customer, receipt_email, description, created } = paymentIntent;
  const deferredActions: DeferredAction[] = [];
  
  console.log(`[Stripe Webhook] Payment succeeded: ${id}, amount: $${(amount / 100).toFixed(2)}`);

  const customerEmail = typeof customer === 'object' ? customer?.email : receipt_email || metadata?.email;
  const customerName = typeof customer === 'object' ? customer?.name : metadata?.memberName;
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

  await client.query(
    `UPDATE stripe_payment_intents 
     SET status = 'succeeded', updated_at = NOW() 
     WHERE stripe_payment_intent_id = $1`,
    [id]
  );

  const sessionId = metadata?.sessionId ? parseInt(metadata.sessionId, 10) : NaN;
  const bookingId = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;
  const amountDollars = (amount / 100).toFixed(2);
  
  interface ParticipantFee { id: number; amountCents: number; }
  let participantFees: ParticipantFee[] = [];
  let validatedParticipantIds: number[] = [];
  const feeSnapshotId = metadata?.feeSnapshotId ? parseInt(metadata.feeSnapshotId, 10) : NaN;
  
  if (!isNaN(feeSnapshotId)) {
    // Query fee snapshot directly - it already has booking_id and session_id
    const snapshotResult = await client.query(
      `SELECT bfs.*
       FROM booking_fee_snapshots bfs
       WHERE bfs.id = $1 AND bfs.stripe_payment_intent_id = $2 AND bfs.status = 'pending'
       FOR UPDATE OF bfs SKIP LOCKED`,
      [feeSnapshotId, id]
    );
    
    if (snapshotResult.rows.length === 0) {
      console.error(`[Stripe Webhook] Fee snapshot ${feeSnapshotId} not found, already used, or locked by another process`);
      return deferredActions;
    }
    
    const snapshot = snapshotResult.rows[0];
    
    if (Math.abs(snapshot.total_cents - amount) > 1) {
      console.error(`[Stripe Webhook] Amount mismatch: snapshot=${snapshot.total_cents}, payment=${amount} - rejecting`);
      throw new Error(`Amount mismatch: expected ${snapshot.total_cents}, got ${amount}`);
    }
    
    // Full fee recalculation verification - detect potential fee drift
    try {
      const currentFees = await computeFeeBreakdown({ 
        sessionId: snapshot.session_id, 
        source: 'webhook_verification' 
      });
      
      // Compare totals with tolerance (allow up to $1.00 difference for rounding)
      if (Math.abs(currentFees.totals.totalCents - snapshot.total_cents) > 100) {
        console.error(`[Stripe Webhook] Fee snapshot mismatch - potential drift detected`, {
          sessionId: snapshot.session_id,
          snapshotTotal: snapshot.total_cents,
          currentTotal: currentFees.totals.totalCents,
          difference: currentFees.totals.totalCents - snapshot.total_cents
        });
        // Don't reject payment but log for investigation
        // The payment already succeeded via Stripe, so we handle this gracefully
      }
    } catch (verifyError) {
      console.warn(`[Stripe Webhook] Could not verify fee breakdown for session ${snapshot.session_id}:`, verifyError);
      // Continue processing - verification is non-blocking
    }
    
    const snapshotFees: ParticipantFee[] = snapshot.participant_fees;
    const participantIds = snapshotFees.map(pf => pf.id);
    
    const statusCheck = await client.query(
      `SELECT id, payment_status FROM booking_participants WHERE id = ANY($1::int[]) FOR UPDATE`,
      [participantIds]
    );
    
    const statusMap = new Map<number, string>();
    for (const row of statusCheck.rows) {
      statusMap.set(row.id, row.payment_status || 'pending');
    }
    
    for (const pf of snapshotFees) {
      const status = statusMap.get(pf.id);
      if (status === 'paid' || status === 'waived') {
        console.warn(`[Stripe Webhook] Participant ${pf.id} already ${status} - skipping`);
        continue;
      }
      participantFees.push(pf);
      validatedParticipantIds.push(pf.id);
    }
    
    await client.query(
      `UPDATE booking_fee_snapshots SET status = 'completed', used_at = NOW() WHERE id = $1`,
      [feeSnapshotId]
    );
    
    if (validatedParticipantIds.length > 0) {
      // Update participants directly by ID - we already validated them from the snapshot
      await client.query(
        `UPDATE booking_participants
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
         WHERE id = ANY($1::int[])`,
        [validatedParticipantIds, id]
      );
      console.log(`[Stripe Webhook] Updated ${validatedParticipantIds.length} participant(s) to paid within transaction`);
      
      for (const pf of participantFees) {
        await client.query(
          `INSERT INTO booking_payment_audit 
           (booking_id, session_id, participant_id, action, staff_email, staff_name, amount_affected, payment_method, metadata)
           VALUES ($1, $2, $3, 'payment_confirmed', 'system', 'Stripe Webhook', $4, $5, $6)`,
          [bookingId, isNaN(sessionId) ? null : sessionId, pf.id, pf.amountCents / 100, 'stripe', JSON.stringify({ stripePaymentIntentId: id })]
        );
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
    
    console.log(`[Stripe Webhook] Snapshot ${feeSnapshotId} processed (validation + payment update + audit)`);
    validatedParticipantIds = [];
    participantFees = [];
  } else if (metadata?.participantFees) {
    console.warn(`[Stripe Webhook] No snapshot ID - falling back to DB cached fee validation`);
    const clientFees: ParticipantFee[] = JSON.parse(metadata.participantFees);
    const participantIds = clientFees.map(pf => pf.id);
    
    // Query participants directly by ID - simpler and more reliable
    const dbResult = await client.query(
      `SELECT bp.id, bp.payment_status, bp.cached_fee_cents
       FROM booking_participants bp
       WHERE bp.id = ANY($1::int[])`,
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
        console.warn(`[Stripe Webhook] Fallback: participant ${pf.id} not in booking - skipping`);
        continue;
      }
      const status = statusMap.get(pf.id);
      if (status === 'paid' || status === 'waived') {
        console.warn(`[Stripe Webhook] Fallback: participant ${pf.id} already ${status} - skipping`);
        continue;
      }
      if (cachedFee <= 0) {
        console.warn(`[Stripe Webhook] Fallback: participant ${pf.id} has no cached fee - skipping`);
        continue;
      }
      participantFees.push({ id: pf.id, amountCents: cachedFee });
      validatedParticipantIds.push(pf.id);
    }
    
    const dbTotal = participantFees.reduce((sum, pf) => sum + pf.amountCents, 0);
    if (Math.abs(dbTotal - amount) > 1) {
      console.error(`[Stripe Webhook] Fallback total mismatch: db=${dbTotal}, payment=${amount} - rejecting`);
      throw new Error(`Amount mismatch: expected ${dbTotal}, got ${amount}`);
    }
    
    console.log(`[Stripe Webhook] Fallback validated ${validatedParticipantIds.length} participants using DB cached fees`);
  }

  if (validatedParticipantIds.length > 0) {
    // Update participants directly by ID - we already validated them
    const updateResult = await client.query(
      `UPDATE booking_participants
       SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $2, cached_fee_cents = 0
       WHERE id = ANY($1::int[])
       RETURNING id`,
      [validatedParticipantIds, id]
    );
    console.log(`[Stripe Webhook] Updated ${updateResult.rowCount} participant(s) to paid and cleared cached fees with intent ${id}`);
    
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
        await client.query(
          `INSERT INTO booking_payment_audit 
           (booking_id, session_id, participant_id, action, staff_email, staff_name, amount_affected, payment_method, metadata)
           VALUES ($1, $2, $3, 'payment_confirmed', 'system', 'Stripe Webhook', $4, $5, $6)`,
          [
            bookingId, 
            isNaN(sessionId) ? null : sessionId,
            pf.id,
            pf.amountCents / 100,
            'stripe',
            JSON.stringify({ stripePaymentIntentId: id })
          ]
        );
      }
      console.log(`[Stripe Webhook] Created ${participantFees.length} audit record(s) for booking ${bookingId}`);
    } else {
      await client.query(
        `INSERT INTO booking_payment_audit 
         (booking_id, session_id, participant_id, action, staff_email, staff_name, amount_affected, payment_method, metadata)
         VALUES ($1, $2, NULL, 'payment_confirmed', 'system', 'Stripe Webhook', $3, $4, $5)`,
        [
          bookingId, 
          isNaN(sessionId) ? null : sessionId,
          parseFloat(amountDollars),
          'stripe',
          JSON.stringify({ stripePaymentIntentId: id })
        ]
      );
      console.log(`[Stripe Webhook] Created payment audit record for booking ${bookingId}`);
    }
  }

  // Process pending credit refund if exists (from balance-aware payments)
  const pendingCreditRefund = metadata?.pendingCreditRefund ? parseInt(metadata.pendingCreditRefund, 10) : 0;
  if (pendingCreditRefund > 0 && customerId) {
    const localCreditAmount = pendingCreditRefund;
    const localCustomerId = customerId;
    const localPiId = id;
    const localEmail = metadata?.email || '';
    
    deferredActions.push(async () => {
      try {
        const stripe = await getStripeClient();
        
        // Refund the credit portion back to the customer
        const refund = await stripe.refunds.create({
          payment_intent: localPiId,
          amount: localCreditAmount,
          reason: 'requested_by_customer',
          metadata: {
            type: 'account_credit_applied',
            originalPaymentIntent: localPiId,
            email: localEmail
          }
        });
        
        console.log(`[Stripe Webhook] Applied credit refund of $${(localCreditAmount / 100).toFixed(2)} for ${localEmail}, refund: ${refund.id}`);
      } catch (refundError: any) {
        console.error(`[Stripe Webhook] Failed to apply credit refund:`, refundError.message);
        // Log for manual reconciliation
        await pool.query(
          `INSERT INTO audit_log (action, resource_type, resource_id, details, created_at)
           VALUES ('credit_refund_failed', 'payment', $1, $2, NOW())`,
          [localPiId, JSON.stringify({ email: localEmail, amount: localCreditAmount, error: refundError.message })]
        );
      }
    });
  }

  // Audit log for successful payment
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
    const email = metadata.email;
    const desc = paymentIntent.description || `Stripe payment: ${metadata.purpose}`;
    const localBookingId = bookingId;
    const localAmount = amount;
    const localId = id;
    
    deferredActions.push(async () => {
      try {
        await queuePaymentSyncToHubSpot({
          email,
          amountCents: localAmount,
          purpose: metadata.purpose,
          description: desc,
          paymentIntentId: localId
        });
      } catch (error) {
        console.error('[Stripe Webhook] Error queuing HubSpot sync:', error);
      }
    });

    deferredActions.push(async () => {
      try {
        const userResult = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
        const memberName = userResult.rows[0] 
          ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
          : email;

        await notifyPaymentSuccess(email, localAmount / 100, desc, { 
          sendEmail: false, 
          bookingId: !isNaN(localBookingId) ? localBookingId : undefined 
        });

        await sendPaymentReceiptEmail(email, { 
          memberName, 
          amount: localAmount / 100, 
          description: desc, 
          date: new Date(),
          transactionId: localId
        });

        broadcastBillingUpdate({
          action: 'payment_succeeded',
          memberEmail: email,
          memberName,
          amount: localAmount / 100
        });

        await notifyAllStaff(
          'Payment Received',
          `${memberName} (${email}) made a payment of $${(localAmount / 100).toFixed(2)} for: ${desc}`,
          'payment_success',
          { sendPush: true }
        );

        console.log(`[Stripe Webhook] Payment notifications sent to ${email} and staff`);
      } catch (error) {
        console.error('[Stripe Webhook] Error sending payment notifications:', error);
      }
    });
  }

  return deferredActions;
}

const MAX_RETRY_ATTEMPTS = 3;

async function handlePaymentIntentFailed(client: PoolClient, paymentIntent: any): Promise<DeferredAction[]> {
  const { id, metadata, amount, last_payment_error, customer } = paymentIntent;
  const reason = last_payment_error?.message || 'Payment could not be processed';
  
  const deferredActions: DeferredAction[] = [];
  
  console.log(`[Stripe Webhook] Payment failed: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${reason}`);
  
  logPaymentFailure({
    paymentIntentId: id,
    customerId: customer,
    userEmail: metadata?.email,
    amountCents: amount,
    errorMessage: reason,
    errorCode: last_payment_error?.code
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
  
  console.log(`[Stripe Webhook] Updated payment ${id}: retry ${newRetryCount}/${MAX_RETRY_ATTEMPTS}, requires_card_update=${requiresCardUpdate}`);

  // customer is already destructured from paymentIntent at function entry
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  const customerEmail = typeof customer === 'object' ? customer?.email : metadata?.email;
  const customerName = typeof customer === 'object' ? customer?.name : metadata?.memberName;
  
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

  // Audit log for failed payment
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
        failure_reason: reason
      }
    });
  });

  const email = metadata?.email;
  if (!email) {
    console.warn('[Stripe Webhook] No email in metadata for failed payment - cannot send notifications');
    return deferredActions;
  }

  const bookingId = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;
  const localAmount = amount;
  const localReason = reason;
  const localRequiresCardUpdate = requiresCardUpdate;

  deferredActions.push(async () => {
    try {
      const userResult = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
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

      console.log(`[Stripe Webhook] Payment failed notifications sent to ${email} (requires_card_update=${localRequiresCardUpdate})`);

      const staffMessage = localRequiresCardUpdate
        ? `${memberName} (${email}) payment failed ${MAX_RETRY_ATTEMPTS}x - card update required`
        : `Payment of $${(localAmount / 100).toFixed(2)} failed for ${memberName} (${email}). Reason: ${localReason}`;
      
      await notifyStaffPaymentFailed(email, memberName, localAmount / 100, staffMessage);

      broadcastBillingUpdate({
        action: 'payment_failed',
        memberEmail: email,
        memberName,
        amount: localAmount / 100,
        requiresCardUpdate: localRequiresCardUpdate
      });

      console.log(`[Stripe Webhook] Staff notified about payment failure for ${email}`);
    } catch (error) {
      console.error('[Stripe Webhook] Error sending payment failed notifications:', error);
    }
  });

  return deferredActions;
}

async function handleInvoicePaymentSucceeded(client: PoolClient, invoice: any): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceEmail = invoice.customer_email;
  const invoiceAmountPaid = invoice.amount_paid || 0;
  const invoiceCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const invoiceCustomerName = typeof invoice.customer === 'object' ? invoice.customer?.name : undefined;
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: invoiceAmountPaid,
      currency: invoice.currency || 'usd',
      status: 'paid',
      createdAt: new Date(invoice.created * 1000),
      customerId: invoiceCustomerId,
      customerEmail: invoiceEmail,
      customerName: invoiceCustomerName,
      description: invoice.lines?.data?.[0]?.description || 'Invoice payment',
      metadata: invoice.metadata,
      source: 'webhook',
      invoiceId: invoice.id,
      paymentIntentId: invoice.payment_intent,
    });
  });
  
  if (!invoice.subscription) {
    console.log(`[Stripe Webhook] Skipping one-time invoice ${invoice.id} (no subscription)`);
    return deferredActions;
  }

  const email = invoice.customer_email;
  const amountPaid = invoice.amount_paid || 0;
  const planName = invoice.lines?.data?.[0]?.description || 'Membership';
  const currentPeriodEnd = invoice.lines?.data?.[0]?.period?.end;
  const nextBillingDate = currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : new Date();

  if (!email) {
    console.warn(`[Stripe Webhook] No customer email on invoice ${invoice.id}`);
    return deferredActions;
  }

  const userResult = await client.query(
    'SELECT id, first_name, last_name FROM users WHERE email = $1',
    [email]
  );
  const memberName = userResult.rows[0]
    ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
    : email;
  const userId = userResult.rows[0]?.id;

  await client.query(
    `UPDATE hubspot_deals 
     SET last_payment_status = 'current',
         last_payment_check = NOW(),
         last_sync_error = NULL,
         updated_at = NOW()
     WHERE LOWER(member_email) = LOWER($1)`,
    [email]
  );

  const priceId = invoice.lines?.data?.[0]?.price?.id;
  let restoreTierClause = '';
  let queryParams: any[] = [email];
  
  if (priceId) {
    const tierResult = await client.query(
      'SELECT slug FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
      [priceId]
    );
    if (tierResult.rows.length > 0) {
      restoreTierClause = ', tier = COALESCE(tier, $2)';
      queryParams = [email, tierResult.rows[0].slug];
    }
  }
  
  await client.query(
    `UPDATE users SET 
      grace_period_start = NULL,
      grace_period_email_count = 0,
      billing_provider = 'stripe'${restoreTierClause},
      updated_at = NOW()
    WHERE LOWER(email) = LOWER($1)`,
    queryParams
  );
  console.log(`[Stripe Webhook] Cleared grace period and set billing_provider for ${email}`);

  const localEmail = email;
  const localMemberName = memberName;
  const localAmountPaid = amountPaid;
  const localPlanName = planName;
  const localNextBillingDate = nextBillingDate;
  const localUserId = userId;
  const localPaymentIntent = invoice.payment_intent || invoice.id;

  deferredActions.push(async () => {
    try {
      await queuePaymentSyncToHubSpot({
        paymentIntentId: localPaymentIntent,
        email: localEmail,
        amountCents: localAmountPaid,
        description: `Membership Renewal: ${localPlanName}`,
        purpose: 'membership_renewal',
      });
      console.log(`[Stripe Webhook] Queued invoice payment HubSpot sync for ${localEmail}`);
    } catch (hubspotError) {
      console.error('[Stripe Webhook] Failed to queue HubSpot sync for invoice payment:', hubspotError);
    }
  });

  deferredActions.push(async () => {
    await notifyMember({
      userEmail: localEmail,
      title: 'Membership Renewed',
      message: `Your ${localPlanName} has been renewed successfully.`,
      type: 'membership_renewed',
    });

    await sendMembershipRenewalEmail(localEmail, {
      memberName: localMemberName,
      amount: localAmountPaid / 100,
      planName: localPlanName,
      nextBillingDate: localNextBillingDate,
    });

    await notifyAllStaff(
      'Membership Renewed',
      `${localMemberName} (${localEmail}) membership renewed: ${localPlanName} - $${(localAmountPaid / 100).toFixed(2)}`,
      'membership_renewed',
      { sendPush: true }
    );

    broadcastBillingUpdate({
      action: 'invoice_paid',
      memberEmail: localEmail,
      memberName: localMemberName,
      amount: localAmountPaid / 100,
      planName: localPlanName
    });

    console.log(`[Stripe Webhook] Membership renewal processed for ${localEmail}, amount: $${(localAmountPaid / 100).toFixed(2)}`);
  });

  return deferredActions;
}

async function handleInvoicePaymentFailed(client: PoolClient, invoice: any): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const invoiceCustomerName = typeof invoice.customer === 'object' ? invoice.customer?.name : undefined;
  
  logPaymentFailure({
    paymentIntentId: invoice.payment_intent,
    customerId: invoiceCustomerId,
    userEmail: invoice.customer_email,
    amountCents: invoice.amount_due,
    errorMessage: `Invoice payment failed: ${invoice.id}`,
    errorCode: 'invoice_payment_failed'
  });
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: invoice.amount_due || 0,
      currency: invoice.currency || 'usd',
      status: 'payment_failed',
      createdAt: new Date(invoice.created * 1000),
      customerId: invoiceCustomerId,
      customerEmail: invoice.customer_email,
      customerName: invoiceCustomerName,
      description: invoice.lines?.data?.[0]?.description || 'Invoice payment failed',
      metadata: invoice.metadata,
      source: 'webhook',
      invoiceId: invoice.id,
      paymentIntentId: invoice.payment_intent,
    });
  });
  
  if (!invoice.subscription) {
    console.log(`[Stripe Webhook] Skipping one-time invoice ${invoice.id} (no subscription)`);
    return deferredActions;
  }

  const email = invoice.customer_email;
  const amountDue = invoice.amount_due || 0;
  const planName = invoice.lines?.data?.[0]?.description || 'Membership';
  const reason = invoice.last_finalization_error?.message || 'Payment declined';

  if (!email) {
    console.warn(`[Stripe Webhook] No customer email on failed invoice ${invoice.id}`);
    return deferredActions;
  }

  const userResult = await client.query(
    'SELECT first_name, last_name FROM users WHERE email = $1',
    [email]
  );
  const memberName = userResult.rows[0]
    ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
    : email;

  await client.query(
    `UPDATE hubspot_deals 
     SET last_payment_status = 'failed',
         last_payment_check = NOW(),
         last_sync_error = $2,
         updated_at = NOW()
     WHERE LOWER(member_email) = LOWER($1)`,
    [email, `Payment failed: ${reason}`]
  );

  await client.query(
    `UPDATE users SET 
      grace_period_start = COALESCE(grace_period_start, NOW()),
      updated_at = NOW()
    WHERE LOWER(email) = LOWER($1) AND grace_period_start IS NULL`,
    [email]
  );
  console.log(`[Stripe Webhook] Started grace period for ${email}`);
  
  // Sync payment failure status to HubSpot
  try {
    const { syncMemberToHubSpot } = await import('../hubspot/stages');
    await syncMemberToHubSpot({ email, status: 'past_due', billingProvider: 'stripe' });
    console.log(`[Stripe Webhook] Synced ${email} payment failure status to HubSpot`);
  } catch (hubspotError) {
    console.error('[Stripe Webhook] HubSpot sync failed for payment failure:', hubspotError);
  }

  const localEmail = email;
  const localMemberName = memberName;
  const localAmountDue = amountDue;
  const localPlanName = planName;
  const localReason = reason;

  deferredActions.push(async () => {
    await notifyMember({
      userEmail: localEmail,
      title: 'Membership Payment Failed',
      message: `We were unable to process your ${localPlanName} payment. Please update your payment method.`,
      type: 'membership_failed',
    }, { sendPush: true });

    await sendMembershipFailedEmail(localEmail, {
      memberName: localMemberName,
      amount: localAmountDue / 100,
      planName: localPlanName,
      reason: localReason,
    });

    await notifyAllStaff(
      'Membership Payment Failed',
      `${localMemberName} (${localEmail}) membership payment of $${(localAmountDue / 100).toFixed(2)} failed: ${localReason}`,
      'membership_failed',
      { sendPush: true }
    );

    broadcastBillingUpdate({
      action: 'invoice_failed',
      memberEmail: localEmail,
      memberName: localMemberName,
      amount: localAmountDue / 100,
      planName: localPlanName
    });

    console.log(`[Stripe Webhook] Membership payment failure processed for ${localEmail}, amount: $${(localAmountDue / 100).toFixed(2)}`);
  });

  return deferredActions;
}

async function handleInvoiceLifecycle(client: PoolClient, invoice: any, eventType: string): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceEmail = invoice.customer_email;
  const amountDue = invoice.amount_due || 0;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const customerName = typeof invoice.customer === 'object' ? invoice.customer?.name : undefined;
  
  console.log(`[Stripe Webhook] Invoice ${eventType}: ${invoice.id}, status: ${invoice.status}, amount: $${(amountDue / 100).toFixed(2)}`);
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: amountDue,
      currency: invoice.currency || 'usd',
      status: invoice.status,
      createdAt: new Date(invoice.created * 1000),
      customerId,
      customerEmail: invoiceEmail,
      customerName,
      description: invoice.lines?.data?.[0]?.description || `Invoice ${invoice.number || invoice.id}`,
      metadata: invoice.metadata,
      source: 'webhook',
      invoiceId: invoice.id,
      paymentIntentId: invoice.payment_intent,
    });
  });
  
  if (invoice.status === 'open' && invoice.due_date) {
    const dueDate = new Date(invoice.due_date * 1000);
    const now = new Date();
    if (dueDate < now) {
      deferredActions.push(async () => {
        broadcastBillingUpdate({
          action: 'invoice_overdue',
          invoiceId: invoice.id,
          memberEmail: invoiceEmail,
          amount: amountDue / 100,
          dueDate: dueDate.toISOString()
        });
      });
    }
  }

  return deferredActions;
}

async function handleInvoiceVoided(client: PoolClient, invoice: any, eventType: string): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  const invoiceEmail = invoice.customer_email;
  const amountDue = invoice.amount_due || 0;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  
  const status = eventType === 'invoice.voided' ? 'void' : 'uncollectible';
  console.log(`[Stripe Webhook] Invoice ${status}: ${invoice.id}, removing from active invoices`);
  
  deferredActions.push(async () => {
    await upsertTransactionCache({
      stripeId: invoice.id,
      objectType: 'invoice',
      amountCents: amountDue,
      currency: invoice.currency || 'usd',
      status,
      createdAt: new Date(invoice.created * 1000),
      customerId,
      customerEmail: invoiceEmail,
      description: invoice.lines?.data?.[0]?.description || `Invoice ${invoice.number || invoice.id}`,
      metadata: invoice.metadata,
      source: 'webhook',
      invoiceId: invoice.id,
    });
  });
  
  const localInvoiceEmail = invoiceEmail;
  const localInvoiceId = invoice.id;
  const localStatus = status;
  
  deferredActions.push(async () => {
    broadcastBillingUpdate({
      action: 'invoice_removed',
      invoiceId: localInvoiceId,
      memberEmail: localInvoiceEmail,
      reason: localStatus
    });
  });

  return deferredActions;
}

async function handleCheckoutSessionCompleted(client: PoolClient, session: any): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    // Handle add_funds checkout - credit customer balance
    if (session.metadata?.purpose === 'add_funds') {
      const customerId = session.customer as string;
      const amountCents = parseInt(session.metadata.amountCents || '0', 10);
      const memberEmail = session.metadata.memberEmail;
      const amountDollars = amountCents / 100;
      
      console.log(`[Stripe Webhook] Processing add_funds checkout: $${amountDollars.toFixed(2)} for ${memberEmail} (session: ${session.id})`);
      
      if (!customerId) {
        console.error(`[Stripe Webhook] add_funds failed: No customer ID in session ${session.id}`);
        return deferredActions;
      }
      
      if (amountCents <= 0) {
        console.error(`[Stripe Webhook] add_funds failed: Invalid amount ${amountCents} in session ${session.id}`);
        return deferredActions;
      }
      
      if (!memberEmail) {
        console.error(`[Stripe Webhook] add_funds failed: No memberEmail in session ${session.id}`);
        return deferredActions;
      }
      
      try {
        const stripe = await getStripeClient();
        
        // Credit the customer's balance (negative amount = credit)
        // Use session ID as idempotency key to prevent double-credit on retries
        const transaction = await stripe.customers.createBalanceTransaction(
          customerId,
          {
            amount: -amountCents,
            currency: 'usd',
            description: `Account balance top-up via checkout (${session.id})`
          },
          {
            idempotencyKey: `add_funds_${session.id}`
          }
        );
        
        const newBalanceDollars = Math.abs(transaction.ending_balance) / 100;
        console.log(`[Stripe Webhook] Successfully added $${amountDollars.toFixed(2)} to balance for ${memberEmail}. New balance: $${newBalanceDollars.toFixed(2)}`);
        
        // Get member name for notifications
        const userResult = await pool.query(
          'SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)',
          [memberEmail]
        );
        const memberName = userResult.rows[0]
          ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || memberEmail
          : memberEmail;
        
        // 1. Send in-app + push notification to member
        await notifyMember({
          userEmail: memberEmail,
          title: 'Funds Added Successfully',
          message: `$${amountDollars.toFixed(2)} has been added to your account balance. New balance: $${newBalanceDollars.toFixed(2)}`,
          type: 'funds_added',
        }, { sendPush: true });
        
        // 2. Send in-app + push notification to all staff
        await notifyAllStaff(
          'Member Added Funds',
          `${memberName} (${memberEmail}) added $${amountDollars.toFixed(2)} to their account balance.`,
          'funds_added',
          { sendPush: true }
        );
        
        // 3. Send email receipt to member
        await sendPaymentReceiptEmail(memberEmail, {
          memberName,
          amount: amountDollars,
          description: 'Account Balance Top-Up',
          date: new Date(),
          transactionId: session.id
        });
        
        console.log(`[Stripe Webhook] All notifications sent for add_funds: ${memberEmail}`);
        
        // Broadcast update for real-time UI updates
        broadcastBillingUpdate({
          action: 'balance_updated',
          memberEmail: memberEmail,
          amountCents,
          newBalance: transaction.ending_balance
        });
        
      } catch (balanceError: any) {
        console.error(`[Stripe Webhook] Failed to credit balance for ${memberEmail}:`, balanceError.message);
        
        // Notify staff of the failure so they can manually resolve
        await notifyAllStaff(
          'Payment Processing Error',
          `Failed to add $${amountDollars.toFixed(2)} to balance for ${memberEmail}. Error: ${balanceError.message}. Manual intervention required.`,
          'payment_error',
          { sendPush: true }
        );
        
        throw balanceError; // Re-throw so Stripe will retry the webhook
      }
      
      return deferredActions;
    }
    
    // Handle corporate membership company sync if company_name is present
    const companyName = session.metadata?.company_name;
    const userEmail = session.metadata?.purchaser_email || session.customer_email;
    
    if (companyName && userEmail) {
      console.log(`[Stripe Webhook] Processing company sync for "${companyName}" (${userEmail})`);
      
      try {
        const companyResult = await syncCompanyToHubSpot({
          companyName,
          userEmail
        });

        if (companyResult.success && companyResult.hubspotCompanyId) {
          console.log(`[Stripe Webhook] Company synced to HubSpot: ${companyResult.hubspotCompanyId} (created: ${companyResult.created})`);
          
          // Update user with hubspot company ID
          await pool.query(
            `UPDATE users SET hubspot_company_id = $1, company_name = $2, updated_at = NOW() WHERE email = $3`,
            [companyResult.hubspotCompanyId, companyName, userEmail.toLowerCase()]
          );
          
          // Update billing_group with hubspot company ID if it exists
          await pool.query(
            `UPDATE billing_groups SET hubspot_company_id = $1, company_name = $2, updated_at = NOW() WHERE primary_email = $3`,
            [companyResult.hubspotCompanyId, companyName, userEmail.toLowerCase()]
          );
          
          console.log(`[Stripe Webhook] Updated user and billing_group with HubSpot company ID`);
        } else if (!companyResult.success) {
          console.error(`[Stripe Webhook] Company sync failed: ${companyResult.error}`);
        }
      } catch (companyError) {
        console.error('[Stripe Webhook] Error syncing company to HubSpot:', companyError);
      }
    }

    // Handle staff-initiated membership invites - auto-create user on checkout completion
    if (session.metadata?.source === 'staff_invite') {
      console.log(`[Stripe Webhook] Processing staff invite checkout: ${session.id}`);
      
      const email = session.customer_email?.toLowerCase();
      const firstName = session.metadata?.firstName;
      const lastName = session.metadata?.lastName;
      const tierId = session.metadata?.tierId ? parseInt(session.metadata.tierId, 10) : null;
      const tierName = session.metadata?.tierName;
      const customerId = session.customer as string;
      
      if (!email || !customerId) {
        console.error(`[Stripe Webhook] Missing email or customer ID for staff invite: ${session.id}`);
        return deferredActions;
      }
      
      // Check if user already exists
      const existingUser = await pool.query(
        'SELECT id, status FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );
      
      if (existingUser.rows.length > 0) {
        // User exists - update their Stripe customer ID, status, and billing provider
        console.log(`[Stripe Webhook] User ${email} exists, updating Stripe customer ID and billing provider`);
        await pool.query(
          `UPDATE users SET stripe_customer_id = $1, status = 'active', billing_provider = 'stripe', updated_at = NOW() WHERE LOWER(email) = LOWER($2)`,
          [customerId, email]
        );
        
        // Sync to HubSpot for existing user update
        try {
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          await syncMemberToHubSpot({ email, status: 'active', billingProvider: 'stripe', memberSince: new Date() });
          console.log(`[Stripe Webhook] Synced existing user ${email} to HubSpot`);
        } catch (hubspotError) {
          console.error('[Stripe Webhook] HubSpot sync failed for existing user:', hubspotError);
        }
      } else {
        // Create new user
        console.log(`[Stripe Webhook] Creating new user from staff invite: ${email}`);
        
        // Get tier slug from tier ID
        let tierSlug = null;
        if (tierId) {
          const tierResult = await pool.query(
            'SELECT slug FROM membership_tiers WHERE id = $1',
            [tierId]
          );
          if (tierResult.rows.length > 0) {
            tierSlug = tierResult.rows[0].slug;
          }
        }
        
        await pool.query(
          `INSERT INTO users (email, first_name, last_name, tier, status, stripe_customer_id, billing_provider, join_date, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', $5, 'stripe', NOW(), NOW(), NOW())
           ON CONFLICT (email) DO UPDATE SET 
             stripe_customer_id = EXCLUDED.stripe_customer_id,
             billing_provider = 'stripe',
             status = 'active',
             tier = COALESCE(EXCLUDED.tier, users.tier),
             updated_at = NOW()`,
          [email, firstName || '', lastName || '', tierSlug, customerId]
        );
        
        console.log(`[Stripe Webhook] Created user ${email} with tier ${tierSlug || 'none'}`);
      }
      
      // Sync to HubSpot with proper tier name and billing provider
      try {
        const { findOrCreateHubSpotContact } = await import('../hubspot/members');
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await findOrCreateHubSpotContact(
          email,
          firstName || '',
          lastName || '',
          undefined,
          tierName || undefined
        );
        
        await syncMemberToHubSpot({
          email,
          status: 'active',
          billingProvider: 'stripe',
          tier: tierName || undefined,
          memberSince: new Date()
        });
        console.log(`[Stripe Webhook] Synced ${email} to HubSpot: status=active, tier=${tierName}, billing=stripe, memberSince=now`);
      } catch (hubspotError) {
        console.error('[Stripe Webhook] HubSpot sync failed for staff invite:', hubspotError);
      }
      
      console.log(`[Stripe Webhook] Staff invite checkout completed for ${email}`);
      return deferredActions;
    }

    // Only handle day pass purchases
    if (session.metadata?.purpose !== 'day_pass') {
      console.log(`[Stripe Webhook] Skipping checkout session ${session.id} (not a day_pass or staff_invite)`);
      return deferredActions;
    }

    console.log(`[Stripe Webhook] Processing day pass checkout session: ${session.id}`);

    // Extract metadata
    const productSlug = session.metadata?.product_slug;
    const email = session.metadata?.purchaser_email;
    const firstName = session.metadata?.purchaser_first_name;
    const lastName = session.metadata?.purchaser_last_name;
    const phone = session.metadata?.purchaser_phone;
    const amountCents = session.amount_total || 0;

    // Get payment_intent_id
    let paymentIntentId: string | null = null;
    if (session.payment_intent) {
      paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent.id;
    }

    if (!productSlug || !email || !paymentIntentId) {
      console.error(`[Stripe Webhook] Missing required data for day pass: productSlug=${productSlug}, email=${email}, paymentIntentId=${paymentIntentId}`);
      return deferredActions;
    }

    const customerId = session.customer as string;

    // Record the day pass purchase
    const result = await recordDayPassPurchaseFromWebhook({
      productSlug,
      email,
      firstName,
      lastName,
      phone,
      amountCents,
      paymentIntentId,
      customerId
    });

    if (!result.success) {
      console.error(`[Stripe Webhook] Failed to record day pass purchase:`, result.error);
      throw new Error(`Failed to record day pass: ${result.error}`); // Throw so Stripe retries
    }

    console.log(`[Stripe Webhook] Day pass purchase recorded: ${result.purchaseId}`);

    broadcastDayPassUpdate({
      action: 'day_pass_purchased',
      passId: result.purchaseId!,
      purchaserEmail: email,
      purchaserName: [firstName, lastName].filter(Boolean).join(' ') || email,
      productType: productSlug,
      remainingUses: result.remainingUses ?? 1,
      quantity: result.quantity ?? 1,
      purchasedAt: new Date().toISOString(),
    });

    // Send email with QR code
    try {
      await sendPassWithQrEmail(email, {
        passId: parseInt(result.purchaseId!, 10),
        type: productSlug,
        quantity: 1,
        purchaseDate: new Date()
      });
      console.log(`[Stripe Webhook] QR pass email sent to ${email}`);
    } catch (emailError) {
      console.error('[Stripe Webhook] Failed to send QR pass email:', emailError);
    }

    // Notify staff about day pass purchase
    const purchaserName = [firstName, lastName].filter(Boolean).join(' ') || email;
    await notifyAllStaff(
      'Day Pass Purchased',
      `${purchaserName} (${email}) purchased a ${productSlug} day pass.`,
      'day_pass',
      { sendPush: false, sendWebSocket: true }
    );

    // Queue HubSpot sync for day pass (non-blocking)
    try {
      await queueDayPassSyncToHubSpot({
        email,
        firstName,
        lastName,
        phone,
        productSlug,
        amountCents,
        paymentIntentId,
        purchaseId: result.purchaseId
      });
    } catch (hubspotError) {
      console.error('[Stripe Webhook] Failed to queue HubSpot sync for day pass:', hubspotError);
    }
  } catch (error) {
    console.error('[Stripe Webhook] Error handling checkout session completed:', error);
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionCreated(client: PoolClient, subscription: any): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = subscription.customer;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const planName = subscription.items?.data?.[0]?.price?.nickname || 
                     subscription.items?.data?.[0]?.plan?.nickname || 
                     'Membership';

    const userResult = await pool.query(
      'SELECT email, first_name, last_name, tier, membership_status FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    let email: string;
    let first_name: string | null;
    let last_name: string | null;
    let currentTier: string | null;
    let currentStatus: string | null;

    if (userResult.rows.length === 0) {
      console.log(`[Stripe Webhook] No user found for Stripe customer ${customerId}, creating user from Stripe data`);
      
      const stripe = await getStripeClient();
      const customer = await stripe.customers.retrieve(customerId);
      
      if (!customer || customer.deleted) {
        console.error(`[Stripe Webhook] Customer ${customerId} not found or deleted`);
        return deferredActions;
      }
      
      const customerEmail = customer.email?.toLowerCase();
      if (!customerEmail) {
        console.error(`[Stripe Webhook] No email found for Stripe customer ${customerId}`);
        return deferredActions;
      }
      
      const customerName = customer.name || '';
      const nameParts = customerName.split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      
      let tierSlug: string | null = null;
      let tierName: string | null = null;
      
      if (priceId) {
        const tierResult = await pool.query(
          'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );
        if (tierResult.rows.length > 0) {
          tierSlug = tierResult.rows[0].slug;
          tierName = tierResult.rows[0].name;
        }
      }
      
      const actualStatus = subscription.status === 'trialing' ? 'trialing' : subscription.status === 'past_due' ? 'past_due' : 'active';
      await pool.query(
        `INSERT INTO users (email, first_name, last_name, tier, membership_status, stripe_customer_id, stripe_subscription_id, billing_provider, join_date, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $7, $5, $6, 'stripe', NOW(), NOW(), NOW())
         ON CONFLICT (email) DO UPDATE SET 
           stripe_customer_id = EXCLUDED.stripe_customer_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           membership_status = $7,
           billing_provider = 'stripe',
           tier = COALESCE(EXCLUDED.tier, users.tier),
           updated_at = NOW()`,
        [customerEmail, firstName, lastName, tierName, customerId, subscription.id, actualStatus]
      );
      
      console.log(`[Stripe Webhook] Created user ${customerEmail} with tier ${tierName || 'none'}, subscription ${subscription.id}`);
      
      try {
        const { findOrCreateHubSpotContact } = await import('../hubspot/members');
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        const contactResult = await findOrCreateHubSpotContact(
          customerEmail,
          firstName,
          lastName,
          undefined,
          tierName || undefined
        );
        
        if (contactResult?.contactId) {
          await syncMemberToHubSpot({
            email: customerEmail,
            status: subscription.status,
            billingProvider: 'stripe',
            tier: tierName || undefined,
            memberSince: new Date()
          });
          console.log(`[Stripe Webhook] Synced ${customerEmail} to HubSpot: status=${subscription.status}, tier=${tierName}, billing=stripe, memberSince=now`);
        }
      } catch (hubspotError) {
        console.error('[Stripe Webhook] HubSpot sync failed for subscription user creation:', hubspotError);
      }
      
      email = customerEmail;
      first_name = firstName;
      last_name = lastName;
      currentTier = tierSlug;
      currentStatus = 'active';
    } else {
      email = userResult.rows[0].email;
      first_name = userResult.rows[0].first_name;
      last_name = userResult.rows[0].last_name;
      currentTier = userResult.rows[0].tier;
      currentStatus = userResult.rows[0].membership_status;
    }

    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    await notifyMember({
      userEmail: email,
      title: 'Subscription Started',
      message: `Your ${planName} subscription has been activated. Welcome!`,
      type: 'membership_renewed',
    });

    await notifyAllStaff(
      'New Subscription Created',
      `${memberName} (${email}) has subscribed to ${planName}.`,
      'membership_renewed',
      { sendPush: false }
    );

    broadcastBillingUpdate({
      action: 'subscription_created',
      memberEmail: email,
      memberName,
      planName
    });

    // Closed-loop activation: Look up tier from price ID and update user
    if (priceId) {
      try {
        const tierResult = await pool.query(
          'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );

        if (tierResult.rows.length > 0) {
          const { slug: tierSlug, name: tierName } = tierResult.rows[0];
          
          // Update user's tier and conditionally activate if membership_status is pending/inactive/null/non-member
          const updateResult = await pool.query(
            `UPDATE users SET 
              tier = $1, 
              membership_status = CASE 
                WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member') THEN 'active' 
                ELSE membership_status 
              END, 
              updated_at = NOW() 
            WHERE email = $2 
            RETURNING id`,
            [tierSlug, email]
          );
          
          if (updateResult.rowCount && updateResult.rowCount > 0) {
            console.log(`[Stripe Webhook] User activation: ${email} tier updated to ${tierSlug}, membership_status conditionally set to active`);
            
            // Sync membership status, tier, and billing provider to HubSpot for existing users
            try {
              const { syncMemberToHubSpot } = await import('../hubspot/stages');
              await syncMemberToHubSpot({
                email,
                status: status, // Use actual subscription status (active, trialing, past_due)
                billingProvider: 'stripe',
                tier: tierName,
                memberSince: new Date()
              });
              console.log(`[Stripe Webhook] Synced existing user ${email} to HubSpot: tier=${tierName}, status=${status}, billing=stripe, memberSince=now`);
            } catch (hubspotError) {
              console.error('[Stripe Webhook] HubSpot sync failed for existing user subscription:', hubspotError);
            }
          } else {
            console.log(`[Stripe Webhook] User activation: ${email} - no update performed`);
          }

          // Update hubspot deal status
          try {
            const dealUpdateResult = await pool.query(
              `UPDATE hubspot_deals SET last_payment_status = 'current', last_payment_check = NOW() WHERE LOWER(member_email) = LOWER($1) RETURNING id`,
              [email]
            );
            
            if (dealUpdateResult.rowCount && dealUpdateResult.rowCount > 0) {
              console.log(`[Stripe Webhook] User activation: ${email} HubSpot deal updated to current payment status`);
            }
          } catch (hubspotError) {
            console.error('[Stripe Webhook] Error updating HubSpot deal:', hubspotError);
          }
        } else {
          // Fallback: try to match by product name
          const productId = subscription.items?.data?.[0]?.price?.product;
          if (productId) {
            try {
              const stripe = await getStripeClient();
              const product = await stripe.products.retrieve(productId as string);
              const productName = product.name?.toLowerCase() || '';
              
              // Match product name to tier - look for tier keywords
              const tierKeywords = ['vip', 'premium', 'corporate', 'core', 'social'];
              for (const keyword of tierKeywords) {
                if (productName.includes(keyword)) {
                  const keywordTierResult = await pool.query(
                    'SELECT slug, name FROM membership_tiers WHERE LOWER(slug) = $1 OR LOWER(name) = $1',
                    [keyword]
                  );
                  if (keywordTierResult.rows.length > 0) {
                    const { name: tierName } = keywordTierResult.rows[0];
                    
                    const updateResult = await pool.query(
                      `UPDATE users SET 
                        tier = $1, 
                        membership_status = CASE 
                          WHEN membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member') THEN 'active' 
                          ELSE membership_status 
                        END,
                        billing_provider = 'stripe',
                        updated_at = NOW() 
                      WHERE email = $2 
                      RETURNING id`,
                      [tierName, email]
                    );
                    
                    if (updateResult.rowCount && updateResult.rowCount > 0) {
                      console.log(`[Stripe Webhook] User activation (product name match): ${email} tier updated to ${tierName} from product "${product.name}"`);
                      
                      // Sync to HubSpot for product name matched tier
                      try {
                        const { syncMemberToHubSpot } = await import('../hubspot/stages');
                        await syncMemberToHubSpot({
                          email,
                          status: status, // Use actual subscription status
                          billingProvider: 'stripe',
                          tier: tierName,
                          memberSince: new Date()
                        });
                        console.log(`[Stripe Webhook] Synced ${email} to HubSpot: tier=${tierName}, status=${status}, billing=stripe, memberSince=now`);
                      } catch (hubspotError) {
                        console.error('[Stripe Webhook] HubSpot sync failed for product name match:', hubspotError);
                      }
                    }
                    break;
                  }
                }
              }
            } catch (productError) {
              console.error('[Stripe Webhook] Error fetching product for name match:', productError);
            }
          } else {
            console.warn(`[Stripe Webhook] No tier found for price ID ${priceId}`);
          }
        }
      } catch (tierError) {
        console.error('[Stripe Webhook] Error with closed-loop activation:', tierError);
      }
    }

    try {
      let restoreTierClause = '';
      let queryParams: any[] = [email];
      
      if (priceId) {
        const tierResult = await pool.query(
          'SELECT slug FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
          [priceId]
        );
        if (tierResult.rows.length > 0) {
          restoreTierClause = ', tier = COALESCE(tier, $2)';
          queryParams = [email, tierResult.rows[0].slug];
        }
      }
      
      await pool.query(
        `UPDATE users SET 
          grace_period_start = NULL,
          grace_period_email_count = 0,
          billing_provider = 'stripe'${restoreTierClause},
          updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)`,
        queryParams
      );
      console.log(`[Stripe Webhook] Cleared grace period and set billing_provider for ${email}`);
    } catch (gracePeriodError) {
      console.error('[Stripe Webhook] Error clearing grace period:', gracePeriodError);
    }

    console.log(`[Stripe Webhook] New subscription created for ${memberName} (${email}): ${planName}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error handling subscription created:', error);
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionUpdated(client: PoolClient, subscription: any, previousAttributes?: any): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = subscription.customer;
    const status = subscription.status;
    const currentPriceId = subscription.items?.data?.[0]?.price?.id;

    if (previousAttributes?.items?.data) {
      const { handleSubscriptionItemsChanged } = await import('./groupBilling');
      const currentItems = subscription.items?.data?.map((i: any) => ({
        id: i.id,
        metadata: i.metadata,
      })) || [];
      const previousItems = previousAttributes.items.data.map((i: any) => ({
        id: i.id,
        metadata: i.metadata,
      }));
      
      await handleSubscriptionItemsChanged(
        subscription.id,
        currentItems,
        previousItems,
      );
    }

    const userResult = await pool.query(
      'SELECT id, email, first_name, last_name, tier FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      console.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return deferredActions;
    }

    const { id: userId, email, first_name, last_name, tier: currentTier } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    if (currentPriceId) {
      let tierResult = await pool.query(
        'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
        [currentPriceId]
      );
      
      let newTierName: string | null = null;
      let matchMethod = 'price_id';
      
      if (tierResult.rows.length > 0) {
        newTierName = tierResult.rows[0].name;
      } else {
        // Fallback: try to match by product name
        const productId = subscription.items?.data?.[0]?.price?.product;
        if (productId) {
          try {
            const stripe = await getStripeClient();
            const product = await stripe.products.retrieve(productId as string);
            const productName = product.name?.toLowerCase() || '';
            
            const tierKeywords = ['vip', 'premium', 'corporate', 'core', 'social'];
            for (const keyword of tierKeywords) {
              if (productName.includes(keyword)) {
                const keywordTierResult = await pool.query(
                  'SELECT slug, name FROM membership_tiers WHERE LOWER(slug) = $1 OR LOWER(name) = $1',
                  [keyword]
                );
                if (keywordTierResult.rows.length > 0) {
                  newTierName = keywordTierResult.rows[0].name;
                  matchMethod = 'product_name';
                  console.log(`[Stripe Webhook] Tier matched by product name "${product.name}" -> ${newTierName}`);
                  break;
                }
              }
            }
          } catch (productError) {
            console.error('[Stripe Webhook] Error fetching product for name match:', productError);
          }
        }
      }
      
      // Compare names (users.tier stores the display name like 'Social', not slug)
      if (newTierName && newTierName !== currentTier) {
        await pool.query(
          'UPDATE users SET tier = $1, billing_provider = $3, updated_at = NOW() WHERE id = $2',
          [newTierName, userId, 'stripe']
        );
        
        console.log(`[Stripe Webhook] Tier updated via Stripe for ${email}: ${currentTier} -> ${newTierName} (matched by ${matchMethod})`);
        
        // Sync tier change to HubSpot
        try {
          const { syncMemberToHubSpot } = await import('../hubspot/stages');
          await syncMemberToHubSpot({ email, tier: newTierName, billingProvider: 'stripe' });
          console.log(`[Stripe Webhook] Synced ${email} tier=${newTierName} to HubSpot`);
        } catch (hubspotError) {
          console.error('[Stripe Webhook] HubSpot sync failed for tier change:', hubspotError);
        }
        
        await notifyMember({
          userEmail: email,
          title: 'Membership Updated',
          message: `Your membership has been changed to ${newTierName}.`,
          type: 'system',
        });
      }
    }

    if (status === 'active') {
      await pool.query(
        `UPDATE users SET membership_status = 'active', updated_at = NOW() 
         WHERE id = $1 AND (membership_status IS NULL OR membership_status IN ('pending', 'inactive', 'non-member', 'past_due'))`,
        [userId]
      );
      console.log(`[Stripe Webhook] Membership status set to active for ${email}`);
      
      // Sync status change to HubSpot
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await syncMemberToHubSpot({ email, status: 'active', billingProvider: 'stripe' });
        console.log(`[Stripe Webhook] Synced ${email} status=active to HubSpot`);
      } catch (hubspotError) {
        console.error('[Stripe Webhook] HubSpot sync failed for status active:', hubspotError);
      }
    } else if (status === 'past_due') {
      await pool.query(
        `UPDATE users SET membership_status = 'past_due', updated_at = NOW() WHERE id = $1`,
        [userId]
      );
      await notifyMember({
        userEmail: email,
        title: 'Membership Past Due',
        message: 'Your membership payment is past due. Please update your payment method to avoid service interruption.',
        type: 'membership_past_due',
      }, { sendPush: true });

      // Notify staff about subscription going past due
      await notifyAllStaff(
        'Membership Past Due',
        `${memberName} (${email}) subscription payment is past due.`,
        'membership_past_due',
        { sendPush: true, sendWebSocket: true }
      );

      console.log(`[Stripe Webhook] Past due notification sent to ${email}`);
      
      // Sync past_due status to HubSpot
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await syncMemberToHubSpot({ email, status: 'past_due', billingProvider: 'stripe' });
        console.log(`[Stripe Webhook] Synced ${email} status=past_due to HubSpot`);
      } catch (hubspotError) {
        console.error('[Stripe Webhook] HubSpot sync failed for status past_due:', hubspotError);
      }
    } else if (status === 'canceled') {
      console.log(`[Stripe Webhook] Subscription canceled for ${email} - handled by subscription.deleted webhook`);
    } else if (status === 'unpaid') {
      await pool.query(
        `UPDATE users SET membership_status = 'suspended', updated_at = NOW() WHERE id = $1`,
        [userId]
      );
      await notifyMember({
        userEmail: email,
        title: 'Membership Unpaid',
        message: 'Your membership is unpaid. Please update your payment method to restore access.',
        type: 'membership_past_due',
      }, { sendPush: true });

      // Notify staff about subscription going unpaid/suspended
      await notifyAllStaff(
        'Membership Suspended - Unpaid',
        `${memberName} (${email}) subscription is unpaid and has been suspended.`,
        'membership_past_due',
        { sendPush: true, sendWebSocket: true }
      );

      console.log(`[Stripe Webhook] Unpaid notification sent to ${email}`);
      
      // Sync suspended status to HubSpot
      try {
        const { syncMemberToHubSpot } = await import('../hubspot/stages');
        await syncMemberToHubSpot({ email, status: 'suspended', billingProvider: 'stripe' });
        console.log(`[Stripe Webhook] Synced ${email} status=suspended to HubSpot`);
      } catch (hubspotError) {
        console.error('[Stripe Webhook] HubSpot sync failed for status suspended:', hubspotError);
      }
    }

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: email,
      memberName,
      status
    });

    console.log(`[Stripe Webhook] Subscription status changed to '${status}' for ${memberName} (${email})`);
  } catch (error) {
    console.error('[Stripe Webhook] Error handling subscription updated:', error);
    throw error;
  }
  return deferredActions;
}

async function handleSubscriptionDeleted(client: PoolClient, subscription: any): Promise<DeferredAction[]> {
  const deferredActions: DeferredAction[] = [];
  try {
    const customerId = subscription.customer;
    const subscriptionId = subscription.id;

    // CRITICAL: Handle group billing cancellation via centralized function
    // This ensures sub-members lose access when primary cancels
    try {
      await handlePrimarySubscriptionCancelled(subscriptionId);
    } catch (groupErr) {
      console.error('[Stripe Webhook] Error in handlePrimarySubscriptionCancelled:', groupErr);
      // Don't throw - continue to process other cancellation logic
    }

    const userResult = await pool.query(
      'SELECT email, first_name, last_name FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      console.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return deferredActions;
    }

    const { email, first_name, last_name } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    // Check if there was a billing group and notify staff of orphaned members
    const billingGroupResult = await pool.query(
      `SELECT bg.id, bg.group_name, bg.is_active
       FROM billing_groups bg
       WHERE LOWER(bg.primary_email) = LOWER($1)`,
      [email]
    );

    if (billingGroupResult.rows.length > 0) {
      const billingGroup = billingGroupResult.rows[0];
      
      // Get count of members that were just deactivated for notification
      const deactivatedMembersResult = await pool.query(
        `SELECT gm.member_email
         FROM group_members gm
         WHERE gm.billing_group_id = $1 AND gm.is_active = false 
         AND gm.removed_at >= NOW() - INTERVAL '1 minute'`,
        [billingGroup.id]
      );

      if (deactivatedMembersResult.rows.length > 0) {
        const orphanedEmails = deactivatedMembersResult.rows.map((m: any) => m.member_email);
        
        console.warn(
          `[Stripe Webhook] ORPHAN BILLING WARNING: Primary member ${memberName} (${email}) ` +
          `subscription cancelled with ${orphanedEmails.length} group members deactivated: ${orphanedEmails.join(', ')}`
        );

        await notifyAllStaff({
          title: 'Orphan Billing Alert',
          message: `Primary member ${memberName} (${email}) subscription was cancelled. ` +
            `${orphanedEmails.length} group member(s) have been automatically deactivated: ${orphanedEmails.join(', ')}.`,
          type: 'billing_alert',
        });
      }

      // Deactivate the billing group itself
      if (billingGroup.is_active) {
        await pool.query(
          `UPDATE billing_groups SET is_active = false, updated_at = NOW() WHERE id = $1`,
          [billingGroup.id]
        );
        console.log(`[Stripe Webhook] Deactivated billing group ${billingGroup.id} for cancelled primary member`);
      }
    }

    // CRITICAL: Update the user's membership status to cancelled, preserve tier in last_tier
    await pool.query(
      `UPDATE users SET 
        last_tier = tier,
        tier = NULL,
        membership_status = 'cancelled',
        stripe_subscription_id = NULL,
        grace_period_start = NULL,
        grace_period_email_count = 0,
        updated_at = NOW()
      WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    console.log(`[Stripe Webhook] Updated ${email} membership_status to cancelled, tier cleared`);

    // Sync cancelled status to HubSpot (include billing_provider to ensure it stays as 'stripe')
    try {
      const { syncMemberToHubSpot } = await import('../hubspot/stages');
      await syncMemberToHubSpot({ email, status: 'cancelled', billingProvider: 'stripe' });
      console.log(`[Stripe Webhook] Synced ${email} status=cancelled to HubSpot`);
    } catch (hubspotError) {
      console.error('[Stripe Webhook] HubSpot sync failed for status cancelled:', hubspotError);
    }

    await notifyMember({
      userEmail: email,
      title: 'Membership Cancelled',
      message: 'Your membership has been cancelled. We hope to see you again soon.',
      type: 'membership_cancelled',
    });

    // Notify staff about membership cancellation
    await notifyAllStaff(
      'Membership Cancelled',
      `${memberName} (${email}) has cancelled their membership.`,
      'membership_cancelled',
      { sendPush: true, sendWebSocket: true }
    );

    broadcastBillingUpdate({
      action: 'subscription_cancelled',
      memberEmail: email,
      memberName
    });

    console.log(`[Stripe Webhook] Membership cancellation processed for ${memberName} (${email})`);
  } catch (error) {
    console.error('[Stripe Webhook] Error handling subscription deleted:', error);
    throw error;
  }
  return deferredActions;
}
