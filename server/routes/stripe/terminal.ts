import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { getStripeClient } from '../../core/stripe/client';
import { createInvoiceWithLineItems, type CartLineItem } from '../../core/stripe/payments';
import { logFromRequest } from '../../core/auditLog';
import { pool } from '../../core/db';

const router = Router();

router.post('/api/stripe/terminal/connection-token', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    const connectionToken = await stripe.terminal.connectionTokens.create();
    
    res.json({ secret: connectionToken.secret });
  } catch (error: any) {
    console.error('[Terminal] Error creating connection token:', error);
    res.status(500).json({ error: 'Failed to create connection token' });
  }
});

router.get('/api/stripe/terminal/readers', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    const readers = await stripe.terminal.readers.list({ limit: 100 });
    
    res.json({ 
      readers: readers.data.map(reader => ({
        id: reader.id,
        label: reader.label || reader.id,
        status: reader.status,
        deviceType: reader.device_type,
        location: reader.location,
        serialNumber: reader.serial_number
      }))
    });
  } catch (error: any) {
    console.error('[Terminal] Error listing readers:', error);
    res.status(500).json({ error: 'Failed to list readers' });
  }
});

router.post('/api/stripe/terminal/create-simulated-reader', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    
    let locations = await stripe.terminal.locations.list({ limit: 1 });
    let locationId: string;
    
    if (locations.data.length === 0) {
      const location = await stripe.terminal.locations.create({
        display_name: 'Ever Club - Main Location',
        address: {
          line1: '123 Main St',
          city: 'Los Angeles',
          state: 'CA',
          postal_code: '90001',
          country: 'US'
        }
      });
      locationId = location.id;
    } else {
      locationId = locations.data[0].id;
    }
    
    const reader = await stripe.terminal.readers.create({
      registration_code: 'simulated-wpe',
      label: 'Ever Club Simulated Reader',
      location: locationId
    });
    
    await logFromRequest(req, {
      action: 'terminal_reader_created',
      resourceType: 'terminal_reader',
      resourceId: reader.id,
      resourceName: reader.label || 'Simulated Reader',
      details: { deviceType: reader.device_type, location: locationId }
    });
    
    res.json({ 
      success: true,
      reader: {
        id: reader.id,
        label: reader.label,
        status: reader.status,
        deviceType: reader.device_type
      }
    });
  } catch (error: any) {
    console.error('[Terminal] Error creating simulated reader:', error);
    res.status(500).json({ error: error.message || 'Failed to create simulated reader' });
  }
});

router.post('/api/stripe/terminal/process-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId, amount, currency = 'usd', description, metadata, cartItems } = req.body;
    
    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }
    
    const stripe = await getStripeClient();
    
    let customerId: string | undefined;
    if (metadata?.userId && metadata?.ownerEmail) {
      try {
        const { getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
        const result = await getOrCreateStripeCustomer(
          metadata.userId,
          metadata.ownerEmail,
          metadata.ownerName
        );
        customerId = result.customerId;
      } catch (custErr: any) {
        console.warn('[Terminal] Could not resolve Stripe customer for existing member (non-blocking):', custErr.message);
      }
    } else if (metadata?.ownerEmail) {
      try {
        const { resolveUserByEmail, getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
        const resolved = await resolveUserByEmail(metadata.ownerEmail);
        if (resolved) {
          const custResult = await getOrCreateStripeCustomer(resolved.userId, metadata.ownerEmail, metadata.ownerName);
          customerId = custResult.customerId;
        } else {
          const custResult = await getOrCreateStripeCustomer(metadata.ownerEmail, metadata.ownerEmail, metadata.ownerName);
          customerId = custResult.customerId;

          try {
            const nameParts = (metadata.ownerName || '').trim().split(/\s+/);
            const firstName = nameParts[0] || '';
            const lastName = nameParts.slice(1).join(' ') || '';

            // Check if this email resolves to an existing user via linked email
            const { resolveUserByEmail: resolveTerminalUser } = await import('../../core/stripe/customers');
            const resolvedTerminal = await resolveTerminalUser(metadata.ownerEmail);
            if (resolvedTerminal) {
              if (!resolvedTerminal.stripeCustomerId) {
                const terminalUserCheck = await pool.query('SELECT archived_at FROM users WHERE id = $1', [resolvedTerminal.userId]);
                await pool.query(
                  'UPDATE users SET stripe_customer_id = $1, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = $2',
                  [customerId, resolvedTerminal.userId]
                );
                if (terminalUserCheck.rows[0]?.archived_at) {
                  console.log(`[Auto-Unarchive] User ${resolvedTerminal.primaryEmail} unarchived after receiving Stripe customer ID`);
                }
              }
              console.log(`[Terminal] Linked Stripe customer to existing user ${resolvedTerminal.primaryEmail} via ${resolvedTerminal.matchType}`);
            } else {
              const crypto = await import('crypto');
              const visitorId = crypto.randomUUID();
              await pool.query(
                `INSERT INTO users (id, email, first_name, last_name, membership_status, stripe_customer_id, data_source, visitor_type, role, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'visitor', $5, 'APP', 'day_pass', 'visitor', NOW(), NOW())
                 ON CONFLICT (email) DO UPDATE SET
                   stripe_customer_id = COALESCE(users.stripe_customer_id, EXCLUDED.stripe_customer_id),
                   first_name = COALESCE(NULLIF(users.first_name, ''), EXCLUDED.first_name),
                   last_name = COALESCE(NULLIF(users.last_name, ''), EXCLUDED.last_name),
                   archived_at = NULL,
                   archived_by = NULL,
                   updated_at = NOW()`,
                [visitorId, metadata.ownerEmail, firstName, lastName, customerId]
              );
              console.log(`[Terminal] Created/updated visitor record for POS customer: ${metadata.ownerEmail}`);
            }
          } catch (visitorErr: any) {
            console.warn('[Terminal] Could not create visitor record for new POS customer (non-blocking):', visitorErr.message);
          }
        }
      } catch (custErr: any) {
        console.warn('[Terminal] Could not create Stripe customer for new customer (non-blocking):', custErr.message);
      }
    }
    
    const isBookingFee = metadata?.paymentType === 'booking_fee';
    const finalMetadata = {
      ...(metadata || {}),
      source: metadata?.source || 'terminal',
      email: metadata?.ownerEmail || '',
      purpose: isBookingFee ? 'booking_fee' : 'one_time_purchase'
    };

    let finalDescription = description || 'Terminal payment';
    if (metadata?.bookingId) {
      try {
        const bookingLookup = await pool.query(
          'SELECT trackman_booking_id FROM booking_requests WHERE id = $1',
          [metadata.bookingId]
        );
        const trackmanId = bookingLookup.rows[0]?.trackman_booking_id;
        const displayId = trackmanId || metadata.bookingId;
        if (finalDescription && !finalDescription.startsWith('#')) {
          finalDescription = `#${displayId} - ${finalDescription}`;
        }
      } catch (lookupErr) {
        console.warn('[Terminal] Could not look up booking for description prefix:', (lookupErr as Error).message);
      }
    }

    let paymentIntent: any;
    let invoiceId: string | null = null;

    if (Array.isArray(cartItems) && cartItems.length > 0 && customerId) {
      try {
        const invoiceResult = await createInvoiceWithLineItems({
          customerId,
          description: finalDescription,
          cartItems: cartItems as CartLineItem[],
          metadata: finalMetadata,
          receiptEmail: metadata?.ownerEmail
        });

        invoiceId = invoiceResult.invoiceId;

        paymentIntent = await stripe.paymentIntents.update(invoiceResult.paymentIntentId, {
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          metadata: finalMetadata,
        });
      } catch (invoiceErr: any) {
        console.error('[Terminal] Invoice creation failed, falling back to bare PI:', invoiceErr.message);
        paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount),
          currency,
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          description: finalDescription,
          metadata: finalMetadata,
          ...(customerId ? { customer: customerId } : {}),
          ...(metadata?.ownerEmail ? { receipt_email: metadata.ownerEmail } : {})
        });
      }
    } else {
      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount),
        currency,
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: finalDescription,
        metadata: finalMetadata,
        ...(customerId ? { customer: customerId } : {}),
        ...(metadata?.ownerEmail ? { receipt_email: metadata.ownerEmail } : {})
      });
    }
    
    if (customerId || metadata?.ownerEmail) {
      try {
        const bookingIdVal = isBookingFee && metadata?.bookingId ? parseInt(metadata.bookingId) || null : null;
        const sessionIdVal = isBookingFee && metadata?.sessionId ? parseInt(metadata.sessionId) || null : null;
        await pool.query(
          `INSERT INTO stripe_payment_intents 
           (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, product_id, product_name, booking_id, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
          [
            metadata?.userId || `guest-${customerId || 'terminal'}`,
            paymentIntent.id,
            customerId || null,
            Math.round(amount),
            isBookingFee ? 'booking_fee' : 'one_time_purchase',
            finalDescription,
            'pending',
            null,
            metadata?.items || null,
            bookingIdVal,
            sessionIdVal
          ]
        );
      } catch (dbErr: any) {
        console.warn('[Terminal] Non-blocking: Could not save local payment record:', dbErr.message);
      }
    }

    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntent.id
    });
    
    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: any) {
        console.error('[Terminal] Simulated card presentation error (non-blocking):', simErr.message);
      }
    }
    
    await logFromRequest(req, {
      action: 'terminal_payment_initiated',
      resourceType: 'payment',
      resourceId: paymentIntent.id,
      resourceName: metadata?.ownerEmail || metadata?.paymentType || 'terminal_payment',
      details: {
        paymentIntentId: paymentIntent.id,
        amount: Math.round(amount),
        readerId,
        customerId: customerId || null,
        paymentType: metadata?.paymentType || 'generic',
        bookingId: metadata?.bookingId || null
      }
    });
    
    res.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      readerId: reader.id,
      readerAction: reader.action
    });
  } catch (error: any) {
    console.error('[Terminal] Error processing payment:', error);
    res.status(500).json({ error: error.message || 'Failed to process payment' });
  }
});

router.get('/api/stripe/terminal/payment-status/:paymentIntentId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.params;
    const stripe = await getStripeClient();
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      amountReceived: paymentIntent.amount_received,
      currency: paymentIntent.currency
    });
  } catch (error: any) {
    console.error('[Terminal] Error checking payment status:', error);
    res.status(500).json({ error: error.message || 'Failed to check payment status' });
  }
});

router.post('/api/stripe/terminal/cancel-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId } = req.body;
    
    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }
    
    const stripe = await getStripeClient();
    const reader = await stripe.terminal.readers.cancelAction(readerId);
    
    res.json({ 
      success: true,
      readerId: reader.id,
      status: reader.status
    });
  } catch (error: any) {
    console.error('[Terminal] Error canceling payment:', error);
    res.status(500).json({ error: error.message || 'Failed to cancel payment' });
  }
});

router.post('/api/stripe/terminal/process-subscription-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId, subscriptionId, userId, email } = req.body;
    
    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Subscription ID is required' });
    }
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    const userCheck = await pool.query(
      'SELECT id, email, membership_status FROM users WHERE id = $1',
      [userId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(400).json({ error: 'User not found. Cannot process payment without a linked member account.' });
    }
    const pendingUser = userCheck.rows[0];
    if (pendingUser.membership_status !== 'pending') {
      return res.status(400).json({ 
        error: `Cannot process payment for member with status "${pendingUser.membership_status}". Expected "pending" status.`
      });
    }
    
    const stripe = await getStripeClient();
    
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent']
    });
    
    const invoice = subscription.latest_invoice as any;
    if (!invoice) {
      return res.status(400).json({ error: 'No invoice found for subscription' });
    }
    
    const amount = invoice.amount_due;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invoice has no amount due' });
    }
    
    const customerId = subscription.customer as string;
    try {
      const existingPIs = await stripe.paymentIntents.list({
        customer: customerId,
        limit: 10
      });
      for (const pi of existingPIs.data) {
        if (pi.metadata?.subscription_id === subscriptionId && 
            pi.metadata?.source === 'membership_inline_payment' &&
            (pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation' || pi.status === 'requires_action')) {
          try {
            await stripe.paymentIntents.cancel(pi.id);
            console.log(`[Terminal] Cancelled stale inline PI ${pi.id} for subscription ${subscriptionId}`);
          } catch (cancelErr: any) {
            console.error(`[Terminal] Failed to cancel stale PI ${pi.id}:`, cancelErr.message);
          }
        }
      }
    } catch (listErr: any) {
      console.error(`[Terminal] Error listing existing PIs:`, listErr.message);
    }

    const invoicePI = invoice.payment_intent as any;
    let paymentIntent: any;
    
    if (invoicePI && invoicePI.id) {
      if (invoicePI.status !== 'requires_payment_method' && invoicePI.status !== 'requires_confirmation') {
        return res.status(400).json({ 
          error: `Invoice PaymentIntent is in unexpected state: ${invoicePI.status}. Expected requires_payment_method or requires_confirmation.`,
          paymentIntentStatus: invoicePI.status
        });
      }
      
      try {
        paymentIntent = await stripe.paymentIntents.update(invoicePI.id, {
          payment_method_types: ['card_present'],
          ...(email ? { receipt_email: email } : {}),
          metadata: {
            subscriptionId,
            invoiceId: invoice.id,
            userId: userId || '',
            email: email || '',
            paymentType: 'subscription_terminal'
          }
        });
        console.log(`[Terminal] Using invoice PI ${invoicePI.id} for subscription ${subscriptionId}`);
      } catch (updateErr: any) {
        console.error(`[Terminal] Failed to update invoice PI ${invoicePI.id}:`, updateErr.message);
        return res.status(500).json({ 
          error: `Failed to configure invoice payment for terminal: ${updateErr.message}`,
          paymentIntentId: invoicePI.id
        });
      }
    } else {
      console.warn(`[Terminal] No invoice PI found for subscription ${subscriptionId}, creating separate PI as fallback`);
      paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: invoice.currency || 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: 'Subscription creation',
        ...(email ? { receipt_email: email } : {}),
        metadata: {
          subscriptionId,
          invoiceId: invoice.id,
          invoiceAmountDue: String(amount),
          userId: userId || '',
          email: email || '',
          paymentType: 'subscription_terminal'
        }
      }, {
        idempotencyKey: `terminal_sub_${subscriptionId}_${invoice.id}`
      });
    }
    
    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntent.id
    });
    
    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: any) {
        console.error('[Terminal] Simulated card presentation error (non-blocking):', simErr.message);
      }
    }
    
    await logFromRequest(req, {
      action: 'terminal_payment_initiated',
      resourceType: 'subscription',
      resourceId: subscriptionId,
      resourceName: email || userId,
      details: { 
        paymentIntentId: paymentIntent.id,
        invoiceId: invoice.id,
        amount,
        readerId,
        userId
      }
    });
    
    res.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      invoiceId: invoice.id,
      amount,
      readerId: reader.id,
      readerAction: reader.action
    });
  } catch (error: any) {
    console.error('[Terminal] Error processing subscription payment:', error);
    res.status(500).json({ error: error.message || 'Failed to process subscription payment' });
  }
});

router.post('/api/stripe/terminal/confirm-subscription-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, subscriptionId, userId, invoiceId } = req.body;
    
    if (!paymentIntentId || !subscriptionId || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const { db } = await import('../../db');
    const { users, terminalPayments } = await import('../../../shared/schema');
    const { eq } = await import('drizzle-orm');
    
    const [existingUser] = await db.select().from(users).where(eq(users.id, userId));
    
    const stripe = await getStripeClient();
    
    if (!existingUser) {
      let autoRefunded = false;
      try {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status === 'succeeded') {
          await stripe.refunds.create({ payment_intent: paymentIntentId, reason: 'requested_by_customer' });
          autoRefunded = true;
          console.error(`[Terminal] Auto-refunded PI ${paymentIntentId} - user ${userId} not found during activation`);
        } else {
          console.error(`[Terminal] Cannot refund PI ${paymentIntentId} in status "${pi.status}" - user ${userId} not found`);
        }
      } catch (refundErr: any) {
        console.error(`[Terminal] CRITICAL: Failed to auto-refund PI ${paymentIntentId} for missing user ${userId}:`, refundErr.message);
      }
      return res.status(400).json({ 
        error: autoRefunded 
          ? 'Member account not found. Payment has been automatically refunded.'
          : 'Member account not found. Payment could not be automatically refunded. Please refund manually in Stripe.',
        autoRefunded
      });
    }
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: 'Payment not yet completed',
        status: paymentIntent.status
      });
    }
    
    const piMetadata = paymentIntent.metadata || {};
    if (piMetadata.subscriptionId !== subscriptionId) {
      return res.status(400).json({ 
        error: 'PaymentIntent subscription mismatch',
        details: 'The payment does not match the subscription being confirmed'
      });
    }
    if (piMetadata.userId !== userId) {
      return res.status(400).json({ 
        error: 'PaymentIntent user mismatch',
        details: 'The payment does not match the user being activated'
      });
    }
    
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice']
    });
    const latestInvoice = subscription.latest_invoice as any;
    const actualInvoiceId = latestInvoice?.id || invoiceId;
    
    if (latestInvoice) {
      const expectedAmount = latestInvoice.status === 'paid' 
        ? latestInvoice.amount_paid 
        : latestInvoice.amount_due;
      
      if (paymentIntent.amount !== expectedAmount) {
        console.error(`[Terminal] Amount mismatch: PI ${paymentIntentId} = $${(paymentIntent.amount / 100).toFixed(2)}, invoice ${actualInvoiceId} = $${(expectedAmount / 100).toFixed(2)}`);
        return res.status(400).json({ 
          error: 'Payment amount mismatch',
          details: `Payment was $${(paymentIntent.amount / 100).toFixed(2)} but invoice ${latestInvoice.status === 'paid' ? 'was paid for' : 'requires'} $${(expectedAmount / 100).toFixed(2)}`,
          paymentAmount: paymentIntent.amount,
          invoiceAmount: expectedAmount,
          invoiceStatus: latestInvoice.status
        });
      }
    }
    
    const customerId = subscription.customer as string;
    
    const existingPaymentRecord = await db.select().from(terminalPayments)
      .where(eq(terminalPayments.stripePaymentIntentId, paymentIntentId));
    
    if (existingPaymentRecord.length === 0) {
      const staffEmail = (req as any).user?.email || 'unknown';
      await db.insert(terminalPayments).values({
        userId,
        userEmail: existingUser?.email || piMetadata.email || 'unknown',
        stripePaymentIntentId: paymentIntentId,
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: actualInvoiceId || null,
        stripeCustomerId: customerId,
        amountCents: paymentIntent.amount,
        currency: paymentIntent.currency || 'usd',
        readerId: piMetadata.readerId || null,
        readerLabel: piMetadata.readerLabel || null,
        status: 'succeeded',
        processedBy: staffEmail,
      });
      console.log(`[Terminal] Payment record created for PI ${paymentIntentId}`);
    }
    
    if (existingUser?.membershipStatus === 'active') {
      console.log(`[Terminal] User ${userId} already active, payment record ensured, returning early`);
      return res.json({
        success: true,
        membershipStatus: 'active',
        subscriptionId,
        paymentIntentId,
        alreadyActivated: true
      });
    }
    
    if (paymentIntent.payment_method) {
      try {
        const pm = await stripe.paymentMethods.retrieve(paymentIntent.payment_method as string);
        if (pm.type !== 'card_present') {
          await stripe.paymentMethods.attach(paymentIntent.payment_method as string, {
            customer: customerId
          });
          await stripe.customers.update(customerId, {
            invoice_settings: {
              default_payment_method: paymentIntent.payment_method as string
            }
          });
        }
      } catch (attachError: any) {
        if (!attachError.message?.includes('already been attached')) {
          console.error('[Terminal] Error attaching payment method:', attachError);
        }
      }
    }
    
    await db.update(users)
      .set({ 
        membershipStatus: 'active',
        updatedAt: new Date()
      })
      .where(eq(users.id, userId));
    
    const [updatedUser] = await db.select().from(users).where(eq(users.id, userId));
    
    if (updatedUser) {
      try {
        const { syncMemberToHubSpot } = await import('../../core/hubspot');
        await syncMemberToHubSpot(updatedUser);
      } catch (hubspotError) {
        console.error('[Terminal] HubSpot sync error (non-blocking):', hubspotError);
      }
    }
    
    await logFromRequest(req, {
      action: 'terminal_subscription_activated',
      resourceType: 'user',
      resourceId: userId,
      resourceName: updatedUser?.email || userId,
      details: { 
        subscriptionId, 
        paymentIntentId,
        invoiceId: actualInvoiceId,
        amount: paymentIntent.amount,
        paymentMethod: 'card_present'
      }
    });
    
    res.json({
      success: true,
      membershipStatus: 'active',
      subscriptionId,
      paymentIntentId
    });
  } catch (error: any) {
    console.error('[Terminal] Error confirming subscription payment:', error);
    res.status(500).json({ error: error.message || 'Failed to confirm subscription payment' });
  }
});

router.post('/api/stripe/terminal/refund-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment Intent ID is required' });
    }
    
    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `Cannot refund payment in "${paymentIntent.status}" state` });
    }
    
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer'
    });
    
    await logFromRequest(req, {
      action: 'terminal_payment_refunded',
      resourceType: 'payment',
      resourceId: paymentIntentId,
      resourceName: paymentIntent.metadata?.email || paymentIntent.metadata?.userId || 'unknown',
      details: {
        refundId: refund.id,
        amount: paymentIntent.amount,
        reason: 'activation_failed'
      }
    });
    
    console.log(`[Terminal] Auto-refunded PI ${paymentIntentId}, refund ${refund.id}`);
    
    res.json({ success: true, refundId: refund.id });
  } catch (error: any) {
    console.error('[Terminal] Error refunding payment:', error);
    res.status(500).json({ error: error.message || 'Failed to refund payment' });
  }
});

router.post('/api/stripe/terminal/process-existing-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId, paymentIntentId } = req.body;

    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment Intent ID is required' });
    }

    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    const allowedStatuses = ['requires_payment_method', 'requires_confirmation'];
    if (!allowedStatuses.includes(paymentIntent.status)) {
      return res.status(400).json({
        error: `Payment Intent is in "${paymentIntent.status}" state and cannot be sent to the terminal`,
        status: paymentIntent.status
      });
    }

    let readerLabel = readerId;
    try {
      const readerObj = await stripe.terminal.readers.retrieve(readerId);
      readerLabel = readerObj.label || readerId;
    } catch {}

    const updateParams: any = {
      payment_method_types: ['card_present'],
      automatic_payment_methods: { enabled: false },
      metadata: {
        ...paymentIntent.metadata,
        readerId,
        readerLabel,
        terminalPayment: 'true',
      },
    };
    if (paymentIntent.setup_future_usage) {
      updateParams.setup_future_usage = '';
    }

    try {
      await stripe.paymentIntents.update(paymentIntentId, updateParams);
    } catch (updateErr: any) {
      console.log(`[Terminal] First update attempt failed, trying stepwise:`, updateErr.message);
      await stripe.paymentIntents.update(paymentIntentId, {
        automatic_payment_methods: { enabled: false },
        ...(paymentIntent.setup_future_usage ? { setup_future_usage: '' } : {}),
        metadata: {
          ...paymentIntent.metadata,
          readerId,
          readerLabel,
          terminalPayment: 'true',
        },
      } as any);
      await stripe.paymentIntents.update(paymentIntentId, {
        payment_method_types: ['card_present']
      });
    }

    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntentId
    });

    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: any) {
        console.error('[Terminal] Simulated card presentation error (non-blocking):', simErr.message);
      }
    }

    await logFromRequest(req, {
      action: 'terminal_existing_payment_routed',
      resourceType: 'payment',
      resourceId: paymentIntentId,
      details: {
        paymentIntentId,
        readerId,
        originalStatus: paymentIntent.status,
        amount: paymentIntent.amount
      }
    });

    res.json({
      success: true,
      paymentIntentId,
      readerId: reader.id,
      readerAction: reader.action
    });
  } catch (error: any) {
    console.error('[Terminal] Error processing existing payment:', error);
    res.status(500).json({ error: error.message || 'Failed to process existing payment on terminal' });
  }
});

export default router;
