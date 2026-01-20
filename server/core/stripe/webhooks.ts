import { getStripeSync } from './client';
import { syncPaymentToHubSpot, syncDayPassToHubSpot } from './hubspotSync';
import { pool } from '../db';
import { notifyPaymentSuccess, notifyPaymentFailed, notifyStaffPaymentFailed, notifyMember, notifyAllStaff } from '../notificationService';
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from '../../emails/paymentEmails';
import { sendMembershipRenewalEmail, sendMembershipFailedEmail } from '../../emails/membershipEmails';
import { sendPassWithQrEmail } from '../../emails/passEmails';
import { broadcastBillingUpdate } from '../websocket';
import { recordDayPassPurchaseFromWebhook } from '../../routes/dayPasses';

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

  if (event.type === 'payment_intent.succeeded') {
    await handlePaymentIntentSucceeded(event.data.object);
  } else if (event.type === 'payment_intent.payment_failed') {
    await handlePaymentIntentFailed(event.data.object);
  } else if (event.type === 'invoice.payment_succeeded') {
    await handleInvoicePaymentSucceeded(event.data.object);
  } else if (event.type === 'invoice.payment_failed') {
    await handleInvoicePaymentFailed(event.data.object);
  } else if (event.type === 'checkout.session.completed') {
    await handleCheckoutSessionCompleted(event.data.object);
  } else if (event.type === 'customer.subscription.created') {
    await handleSubscriptionCreated(event.data.object);
  } else if (event.type === 'customer.subscription.updated') {
    await handleSubscriptionUpdated(event.data.object, event.data.previous_attributes);
  } else if (event.type === 'customer.subscription.deleted') {
    await handleSubscriptionDeleted(event.data.object);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent: any): Promise<void> {
  const { id, metadata, amount } = paymentIntent;
  
  console.log(`[Stripe Webhook] Payment succeeded: ${id}, amount: $${(amount / 100).toFixed(2)}`);

  await pool.query(
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
    try {
      const snapshotResult = await pool.query(
        `SELECT bfs.*, bs.booking_id as verified_booking_id
         FROM booking_fee_snapshots bfs
         JOIN booking_sessions bs ON bfs.session_id = bs.id
         WHERE bfs.id = $1 AND bfs.stripe_payment_intent_id = $2 AND bfs.status = 'pending'`,
        [feeSnapshotId, id]
      );
      
      if (snapshotResult.rows.length === 0) {
        console.error(`[Stripe Webhook] Fee snapshot ${feeSnapshotId} not found or already used for intent ${id}`);
        return;
      }
      
      const snapshot = snapshotResult.rows[0];
      
      if (Math.abs(snapshot.total_cents - amount) > 1) {
        console.error(`[Stripe Webhook] Amount mismatch: snapshot=${snapshot.total_cents}, payment=${amount} - rejecting`);
        return;
      }
      
      const snapshotFees: ParticipantFee[] = snapshot.participant_fees;
      const participantIds = snapshotFees.map(pf => pf.id);
      
      const statusCheck = await pool.query(
        `SELECT id, payment_status FROM booking_participants WHERE id = ANY($1::int[])`,
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
      
      await pool.query(
        `UPDATE booking_fee_snapshots SET status = 'used', used_at = NOW() WHERE id = $1`,
        [feeSnapshotId]
      );
      
      console.log(`[Stripe Webhook] Validated ${validatedParticipantIds.length} participants from snapshot ${feeSnapshotId}`);
    } catch (err) {
      console.error('[Stripe Webhook] Failed to validate from snapshot:', err);
      return;
    }
  } else if (metadata?.participantFees && !isNaN(bookingId) && bookingId > 0) {
    console.warn(`[Stripe Webhook] No snapshot ID - falling back to DB cached fee validation`);
    try {
      const clientFees: ParticipantFee[] = JSON.parse(metadata.participantFees);
      const participantIds = clientFees.map(pf => pf.id);
      
      const dbResult = await pool.query(
        `SELECT bp.id, bp.payment_status, bp.cached_fee_cents
         FROM booking_participants bp
         INNER JOIN booking_sessions bs ON bp.session_id = bs.id
         WHERE bp.id = ANY($1::int[]) AND bs.booking_id = $2`,
        [participantIds, bookingId]
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
        participantFees = [];
        validatedParticipantIds = [];
        return;
      }
      
      console.log(`[Stripe Webhook] Fallback validated ${validatedParticipantIds.length} participants using DB cached fees`);
    } catch (err) {
      console.error('[Stripe Webhook] Fallback validation failed:', err);
    }
  }

  if (validatedParticipantIds.length > 0 && !isNaN(bookingId) && bookingId > 0) {
    try {
      const updateResult = await pool.query(
        `UPDATE booking_participants bp
         SET payment_status = 'paid', paid_at = NOW(), stripe_payment_intent_id = $3, cached_fee_cents = 0
         FROM booking_sessions bs
         WHERE bp.session_id = bs.id 
           AND bs.booking_id = $1 
           AND bp.id = ANY($2::int[])
         RETURNING bp.id`,
        [bookingId, validatedParticipantIds, id]
      );
      console.log(`[Stripe Webhook] Updated ${updateResult.rowCount} participant(s) to paid and cleared cached fees with intent ${id}`);
      
      broadcastBillingUpdate({
        action: 'booking_payment_updated',
        bookingId,
        sessionId: isNaN(sessionId) ? undefined : sessionId,
        amount
      });
    } catch (error) {
      console.error('[Stripe Webhook] Error updating participant payment status:', error);
    }
  } else if (validatedParticipantIds.length > 0) {
    console.error(`[Stripe Webhook] Cannot update participants - invalid bookingId: ${bookingId}`);
  }

  if (!isNaN(bookingId) && bookingId > 0) {
    try {
      if (participantFees.length > 0) {
        for (const pf of participantFees) {
          await pool.query(
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
        await pool.query(
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
    } catch (error) {
      console.error('[Stripe Webhook] Error creating payment audit:', error);
    }
  }

  if (metadata?.email && metadata?.purpose) {
    try {
      await syncPaymentToHubSpot({
        email: metadata.email,
        amountCents: amount,
        purpose: metadata.purpose,
        description: paymentIntent.description || `Stripe payment: ${metadata.purpose}`,
        paymentIntentId: id
      });
    } catch (error) {
      console.error('[Stripe Webhook] Error syncing to HubSpot:', error);
    }

    try {
      const email = metadata.email;
      const description = paymentIntent.description || `Stripe payment: ${metadata.purpose}`;
      
      const userResult = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
      const memberName = userResult.rows[0] 
        ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
        : email;

      await notifyPaymentSuccess(email, amount / 100, description, { 
        sendEmail: false, 
        bookingId: !isNaN(bookingId) ? bookingId : undefined 
      });

      await sendPaymentReceiptEmail(email, { 
        memberName, 
        amount: amount / 100, 
        description, 
        date: new Date(),
        transactionId: id
      });

      broadcastBillingUpdate({
        action: 'payment_succeeded',
        memberEmail: email,
        memberName,
        amount: amount / 100
      });

      console.log(`[Stripe Webhook] Payment notifications sent to ${email}`);
    } catch (error) {
      console.error('[Stripe Webhook] Error sending payment notifications:', error);
    }
  }
}

async function handlePaymentIntentFailed(paymentIntent: any): Promise<void> {
  const { id, metadata, amount, last_payment_error } = paymentIntent;
  const reason = last_payment_error?.message || 'Payment could not be processed';
  
  console.log(`[Stripe Webhook] Payment failed: ${id}, amount: $${(amount / 100).toFixed(2)}, reason: ${reason}`);

  try {
    await pool.query(
      `UPDATE stripe_payment_intents 
       SET status = 'failed', updated_at = NOW() 
       WHERE stripe_payment_intent_id = $1`,
      [id]
    );
  } catch (error) {
    console.error('[Stripe Webhook] Error updating payment intent status to failed:', error);
  }

  const email = metadata?.email;
  if (!email) {
    console.warn('[Stripe Webhook] No email in metadata for failed payment - cannot send notifications');
    return;
  }

  const bookingId = metadata?.bookingId ? parseInt(metadata.bookingId, 10) : NaN;

  try {
    const userResult = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
    const memberName = userResult.rows[0] 
      ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
      : email;

    await notifyPaymentFailed(email, amount / 100, reason, { 
      sendEmail: false, 
      bookingId: !isNaN(bookingId) ? bookingId : undefined 
    });

    await sendPaymentFailedEmail(email, { 
      memberName, 
      amount: amount / 100, 
      reason 
    });

    console.log(`[Stripe Webhook] Payment failed notifications sent to ${email}`);

    await notifyStaffPaymentFailed(email, memberName, amount / 100, reason);

    broadcastBillingUpdate({
      action: 'payment_failed',
      memberEmail: email,
      memberName,
      amount: amount / 100
    });

    console.log(`[Stripe Webhook] Staff notified about payment failure for ${email}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error sending payment failed notifications:', error);
  }
}

async function handleInvoicePaymentSucceeded(invoice: any): Promise<void> {
  try {
    if (!invoice.subscription) {
      console.log(`[Stripe Webhook] Skipping one-time invoice ${invoice.id} (no subscription)`);
      return;
    }

    const email = invoice.customer_email;
    const amountPaid = invoice.amount_paid || 0;
    const planName = invoice.lines?.data?.[0]?.description || 'Membership';
    const currentPeriodEnd = invoice.lines?.data?.[0]?.period?.end;
    const nextBillingDate = currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : new Date();

    if (!email) {
      console.warn(`[Stripe Webhook] No customer email on invoice ${invoice.id}`);
      return;
    }

    const userResult = await pool.query(
      'SELECT id, first_name, last_name FROM users WHERE email = $1',
      [email]
    );
    const memberName = userResult.rows[0]
      ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
      : email;
    const userId = userResult.rows[0]?.id;

    try {
      await syncPaymentToHubSpot({
        paymentIntentId: invoice.payment_intent || invoice.id,
        memberEmail: email,
        memberName,
        amountCents: amountPaid,
        description: `Membership Renewal: ${planName}`,
        purpose: 'membership_renewal',
        bookingId: undefined,
        userId,
      });
      console.log(`[Stripe Webhook] Synced invoice payment to HubSpot for ${email}`);
    } catch (hubspotError) {
      console.error('[Stripe Webhook] HubSpot sync failed for invoice payment:', hubspotError);
    }

    await notifyMember({
      userEmail: email,
      title: 'Membership Renewed',
      message: `Your ${planName} has been renewed successfully.`,
      type: 'membership_renewed',
    });

    await sendMembershipRenewalEmail(email, {
      memberName,
      amount: amountPaid / 100,
      planName,
      nextBillingDate,
    });

    broadcastBillingUpdate({
      action: 'invoice_paid',
      memberEmail: email,
      memberName,
      amount: amountPaid / 100,
      planName
    });

    console.log(`[Stripe Webhook] Membership renewal processed for ${email}, amount: $${(amountPaid / 100).toFixed(2)}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error handling invoice payment succeeded:', error);
  }
}

async function handleInvoicePaymentFailed(invoice: any): Promise<void> {
  try {
    if (!invoice.subscription) {
      console.log(`[Stripe Webhook] Skipping one-time invoice ${invoice.id} (no subscription)`);
      return;
    }

    const email = invoice.customer_email;
    const amountDue = invoice.amount_due || 0;
    const planName = invoice.lines?.data?.[0]?.description || 'Membership';
    const reason = invoice.last_finalization_error?.message || 'Payment declined';

    if (!email) {
      console.warn(`[Stripe Webhook] No customer email on failed invoice ${invoice.id}`);
      return;
    }

    const userResult = await pool.query(
      'SELECT first_name, last_name FROM users WHERE email = $1',
      [email]
    );
    const memberName = userResult.rows[0]
      ? `${userResult.rows[0].first_name || ''} ${userResult.rows[0].last_name || ''}`.trim() || email
      : email;

    await notifyMember({
      userEmail: email,
      title: 'Membership Payment Failed',
      message: `We were unable to process your ${planName} payment. Please update your payment method.`,
      type: 'membership_failed',
    }, { sendPush: true });

    await sendMembershipFailedEmail(email, {
      memberName,
      amount: amountDue / 100,
      planName,
      reason,
    });

    await notifyAllStaff(
      'Membership Payment Failed',
      `${memberName} (${email}) membership payment of $${(amountDue / 100).toFixed(2)} failed: ${reason}`,
      'membership_failed',
      { sendPush: true }
    );

    broadcastBillingUpdate({
      action: 'invoice_failed',
      memberEmail: email,
      memberName,
      amount: amountDue / 100,
      planName
    });

    console.log(`[Stripe Webhook] Membership payment failure processed for ${email}, amount: $${(amountDue / 100).toFixed(2)}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error handling invoice payment failed:', error);
  }
}

async function handleCheckoutSessionCompleted(session: any): Promise<void> {
  try {
    // Only handle day pass purchases
    if (session.metadata?.purpose !== 'day_pass') {
      console.log(`[Stripe Webhook] Skipping checkout session ${session.id} (not a day_pass)`);
      return;
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
      return;
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
      return;
    }

    console.log(`[Stripe Webhook] Day pass purchase recorded: ${result.purchaseId}`);

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

    // Sync to HubSpot for non-members
    try {
      await syncDayPassToHubSpot({
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
      console.error('[Stripe Webhook] HubSpot sync failed for day pass:', hubspotError);
    }
  } catch (error) {
    console.error('[Stripe Webhook] Error handling checkout session completed:', error);
  }
}

async function handleSubscriptionCreated(subscription: any): Promise<void> {
  try {
    const customerId = subscription.customer;
    const planName = subscription.items?.data?.[0]?.price?.nickname || 
                     subscription.items?.data?.[0]?.plan?.nickname || 
                     'Membership';

    const userResult = await pool.query(
      'SELECT email, first_name, last_name FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      console.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return;
    }

    const { email, first_name, last_name } = userResult.rows[0];
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

    console.log(`[Stripe Webhook] New subscription created for ${memberName} (${email}): ${planName}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error handling subscription created:', error);
  }
}

async function handleSubscriptionUpdated(subscription: any, previousAttributes?: any): Promise<void> {
  try {
    const customerId = subscription.customer;
    const status = subscription.status;
    const currentPriceId = subscription.items?.data?.[0]?.price?.id;

    if (previousAttributes?.items?.data) {
      const { handleSubscriptionItemsChanged } = await import('./familyBilling');
      const currentItems = subscription.items?.data?.map((i: any) => ({
        id: i.id,
        metadata: i.metadata,
      })) || [];
      const previousItems = previousAttributes.items.data.map((i: any) => ({
        id: i.id,
        metadata: i.metadata,
      }));
      
      const itemChanges = await handleSubscriptionItemsChanged({
        subscriptionId: subscription.id,
        currentItems,
        previousItems,
      });
      
      if (itemChanges.deactivated.length > 0) {
        console.log(`[Stripe Webhook] Family members deactivated via subscription item removal: ${itemChanges.deactivated.join(', ')}`);
      }
    }

    const userResult = await pool.query(
      'SELECT id, email, first_name, last_name, tier FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      console.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return;
    }

    const { id: userId, email, first_name, last_name, tier: currentTier } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    if (currentPriceId) {
      const tierResult = await pool.query(
        'SELECT slug, name FROM membership_tiers WHERE stripe_price_id = $1 OR founding_price_id = $1',
        [currentPriceId]
      );
      
      if (tierResult.rows.length > 0) {
        const newTierSlug = tierResult.rows[0].slug;
        const newTierName = tierResult.rows[0].name;
        
        // Compare slugs for consistency (users.tier stores slug, not name)
        if (newTierSlug && newTierSlug !== currentTier) {
          await pool.query(
            'UPDATE users SET tier = $1, updated_at = NOW() WHERE id = $2',
            [newTierSlug, userId]
          );
          
          console.log(`[Stripe Webhook] Tier updated via Stripe for ${email}: ${currentTier} -> ${newTierSlug}`);
          
          await notifyMember({
            userEmail: email,
            title: 'Membership Updated',
            message: `Your membership has been changed to ${newTierName}.`,
            type: 'system',
          });
        }
      }
    }

    if (status === 'past_due') {
      await notifyMember({
        userEmail: email,
        title: 'Membership Past Due',
        message: 'Your membership payment is past due. Please update your payment method to avoid service interruption.',
        type: 'membership_past_due',
      }, { sendPush: true });

      console.log(`[Stripe Webhook] Past due notification sent to ${email}`);
    } else if (status === 'canceled') {
      console.log(`[Stripe Webhook] Subscription canceled for ${email} - handled by subscription.deleted webhook`);
    } else if (status === 'unpaid') {
      await notifyMember({
        userEmail: email,
        title: 'Membership Unpaid',
        message: 'Your membership is unpaid. Please update your payment method to restore access.',
        type: 'membership_past_due',
      }, { sendPush: true });

      console.log(`[Stripe Webhook] Unpaid notification sent to ${email}`);
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
  }
}

async function handleSubscriptionDeleted(subscription: any): Promise<void> {
  try {
    const customerId = subscription.customer;

    const userResult = await pool.query(
      'SELECT email, first_name, last_name FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (userResult.rows.length === 0) {
      console.warn(`[Stripe Webhook] No user found for Stripe customer ${customerId}`);
      return;
    }

    const { email, first_name, last_name } = userResult.rows[0];
    const memberName = `${first_name || ''} ${last_name || ''}`.trim() || email;

    await notifyMember({
      userEmail: email,
      title: 'Membership Cancelled',
      message: 'Your membership has been cancelled. We hope to see you again soon.',
      type: 'membership_cancelled',
    });

    broadcastBillingUpdate({
      action: 'subscription_cancelled',
      memberEmail: email,
      memberName
    });

    console.log(`[Stripe Webhook] Membership cancellation processed for ${memberName} (${email})`);
  } catch (error) {
    console.error('[Stripe Webhook] Error handling subscription deleted:', error);
  }
}
