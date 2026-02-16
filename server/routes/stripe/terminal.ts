import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { getStripeClient } from '../../core/stripe/client';
import { createInvoiceWithLineItems, type CartLineItem } from '../../core/stripe/payments';
import { logFromRequest } from '../../core/auditLog';
import { pool } from '../../core/db';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';

const router = Router();

router.post('/api/stripe/terminal/connection-token', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    const connectionToken = await stripe.terminal.connectionTokens.create();
    
    res.json({ secret: connectionToken.secret });
  } catch (error: unknown) {
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
  } catch (error: unknown) {
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
      action: 'terminal_reader_created' as any,
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
  } catch (error: unknown) {
    console.error('[Terminal] Error creating simulated reader:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to create simulated reader' });
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
      } catch (custErr: unknown) {
        console.warn('[Terminal] Could not resolve Stripe customer for existing member (non-blocking):', getErrorMessage(custErr));
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
          } catch (visitorErr: unknown) {
            console.warn('[Terminal] Could not create visitor record for new POS customer (non-blocking):', getErrorMessage(visitorErr));
          }
        }
      } catch (custErr: unknown) {
        console.warn('[Terminal] Could not create Stripe customer for new customer (non-blocking):', getErrorMessage(custErr));
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
          receiptEmail: metadata?.ownerEmail,
          forTerminal: true
        });

        invoiceId = invoiceResult.invoiceId;
        paymentIntent = await stripe.paymentIntents.retrieve(invoiceResult.paymentIntentId);
      } catch (invoiceErr: unknown) {
        console.error('[Terminal] Invoice creation failed, falling back to bare PI:', getErrorMessage(invoiceErr));
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
      } catch (dbErr: unknown) {
        console.warn('[Terminal] Non-blocking: Could not save local payment record:', getErrorMessage(dbErr));
      }
    }

    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntent.id
    });
    
    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: unknown) {
        console.error('[Terminal] Simulated card presentation error (non-blocking):', getErrorMessage(simErr));
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
  } catch (error: unknown) {
    console.error('[Terminal] Error processing payment:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to process payment' });
  }
});

router.get('/api/stripe/terminal/payment-status/:paymentIntentId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.params;
    const stripe = await getStripeClient();
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId as string);

    if (paymentIntent.status === 'succeeded' && paymentIntent.metadata?.invoice_id) {
      try {
        const inv = await stripe.invoices.retrieve(paymentIntent.metadata.invoice_id);
        if (inv.status === 'open') {
          await stripe.invoices.pay(paymentIntent.metadata.invoice_id, { paid_out_of_band: true });
          console.log(`[Terminal] Marked invoice ${paymentIntent.metadata.invoice_id} as paid after terminal PI ${paymentIntentId} succeeded`);
        }
      } catch (invErr: unknown) {
        console.warn(`[Terminal] Could not reconcile invoice ${paymentIntent.metadata.invoice_id}:`, getErrorMessage(invErr));
      }
    }
    
    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      amountReceived: paymentIntent.amount_received,
      currency: paymentIntent.currency,
      lastPaymentError: paymentIntent.last_payment_error ? {
        message: paymentIntent.last_payment_error.message || 'Payment failed',
        declineCode: paymentIntent.last_payment_error.decline_code || null,
        code: paymentIntent.last_payment_error.code || null,
      } : null
    });
  } catch (error: unknown) {
    console.error('[Terminal] Error checking payment status:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to check payment status' });
  }
});

router.post('/api/stripe/terminal/cancel-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId, paymentIntentId } = req.body;
    
    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }
    
    const stripe = await getStripeClient();

    try {
      await stripe.terminal.readers.cancelAction(readerId);
    } catch (readerErr: unknown) {
      if (!getErrorMessage(readerErr)?.includes('no action')) {
        console.warn('[Terminal] Could not cancel reader action:', getErrorMessage(readerErr));
      }
    }

    let paymentAlreadySucceeded = false;

    if (paymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status === 'succeeded') {
          paymentAlreadySucceeded = true;
        } else if (pi.status !== 'canceled') {
          await stripe.paymentIntents.cancel(paymentIntentId);
          console.log(`[Terminal] Canceled PaymentIntent ${paymentIntentId}`);
        }
      } catch (piErr: unknown) {
        console.warn('[Terminal] Could not cancel PaymentIntent:', getErrorMessage(piErr));
      }
    }

    if (paymentAlreadySucceeded) {
      await logFromRequest(req, {
        action: 'terminal_payment_canceled',
        resourceType: 'payment',
        resourceId: paymentIntentId || readerId,
        resourceName: 'terminal_payment',
        details: { readerId, paymentIntentId: paymentIntentId || null, outcome: 'already_succeeded' }
      });
      return res.json({
        success: false,
        alreadySucceeded: true,
        message: 'Cannot cancel — payment already processed successfully'
      });
    }

    await logFromRequest(req, {
      action: 'terminal_payment_canceled',
      resourceType: 'payment',
      resourceId: paymentIntentId || readerId,
      resourceName: 'terminal_payment',
      details: { readerId, paymentIntentId: paymentIntentId || null, outcome: 'canceled' }
    });
    
    res.json({ 
      success: true,
      readerId,
      canceled: true
    });
  } catch (error: unknown) {
    console.error('[Terminal] Error canceling payment:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to cancel payment' });
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
    const allowedStatuses = ['pending', 'incomplete'];
    if (!allowedStatuses.includes(pendingUser.membership_status)) {
      return res.status(400).json({ 
        error: `Cannot process payment for member with status "${pendingUser.membership_status}". Expected "pending" or "incomplete" status.`
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
        const isStaleInline = pi.metadata?.subscription_id === subscriptionId && 
            pi.metadata?.source === 'membership_inline_payment';
        const isStaleTerminal = pi.metadata?.subscriptionId === subscriptionId && 
            pi.metadata?.paymentType === 'subscription_terminal';
        if ((isStaleInline || isStaleTerminal) &&
            (pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation' || pi.status === 'requires_action')) {
          try {
            await stripe.paymentIntents.cancel(pi.id);
            console.log(`[Terminal] Cancelled stale PI ${pi.id} for subscription ${subscriptionId}`);
          } catch (cancelErr: unknown) {
            console.error(`[Terminal] Failed to cancel stale PI ${pi.id}:`, getErrorMessage(cancelErr));
          }
        }
      }
    } catch (listErr: unknown) {
      console.error(`[Terminal] Error listing existing PIs:`, getErrorMessage(listErr));
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
          setup_future_usage: 'off_session',
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
      } catch (updateErr: unknown) {
        console.error(`[Terminal] Failed to update invoice PI ${invoicePI.id}:`, getErrorMessage(updateErr));
        return res.status(500).json({ 
          error: `Failed to configure invoice payment for terminal: ${getErrorMessage(updateErr)}`,
          paymentIntentId: invoicePI.id
        });
      }
    } else {
      console.warn(`[Terminal] No invoice PI found for subscription ${subscriptionId}, creating terminal PI linked to invoice`);
      paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: invoice.currency || 'usd',
        customer: customerId,
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        setup_future_usage: 'off_session',
        description: `Subscription activation - Invoice ${invoice.id}`,
        ...(email ? { receipt_email: email } : {}),
        metadata: {
          subscriptionId,
          invoiceId: invoice.id,
          invoiceAmountDue: String(amount),
          userId: userId || '',
          email: email || '',
          paymentType: 'subscription_terminal',
          fallback: 'true',
          requiresInvoiceReconciliation: 'true'
        }
      }, {
        idempotencyKey: `terminal_sub_${subscriptionId}_${invoice.id}`
      });
      console.log(`[Terminal] Created PI ${paymentIntent.id} for subscription ${subscriptionId} - will reconcile invoice after payment succeeds`);
    }
    
    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntent.id
    });
    
    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: unknown) {
        console.error('[Terminal] Simulated card presentation error (non-blocking):', getErrorMessage(simErr));
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
  } catch (error: unknown) {
    console.error('[Terminal] Error processing subscription payment:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to process subscription payment' });
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
      } catch (refundErr: unknown) {
        console.error(`[Terminal] CRITICAL: Failed to auto-refund PI ${paymentIntentId} for missing user ${userId}:`, getErrorMessage(refundErr));
      }
      return res.status(400).json({ 
        error: autoRefunded 
          ? 'Member account not found. Payment has been automatically refunded.'
          : 'Member account not found. Payment could not be automatically refunded. Please refund manually in Stripe.',
        autoRefunded
      });
    }
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge']
    });
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
    
    if (piMetadata.requiresInvoiceReconciliation === 'true' && latestInvoice && latestInvoice.status !== 'paid') {
      try {
        await stripe.invoices.pay(actualInvoiceId, { paid_out_of_band: true });
        console.log(`[Terminal] Reconciled invoice ${actualInvoiceId} as paid (out-of-band) after successful terminal payment ${paymentIntentId}`);
      } catch (invoicePayErr: unknown) {
        console.error(`[Terminal] Failed to reconcile invoice ${actualInvoiceId} after terminal payment:`, getErrorMessage(invoicePayErr));
      }
    }
    
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
    
    let cardSaved = false;
    let cardSaveWarning: string | null = null;
    if (paymentIntent.payment_method) {
      try {
        const pm = await stripe.paymentMethods.retrieve(paymentIntent.payment_method as string);
        let reusablePaymentMethodId: string | null = null;

        if (pm.type === 'card_present') {
          const latestCharge = (paymentIntent as any).latest_charge;
          const generatedCard = latestCharge?.payment_method_details?.card_present?.generated_card;

          if (generatedCard) {
            reusablePaymentMethodId = generatedCard;
            console.log(`[Terminal] Found generated_card ${generatedCard} from card_present payment`);
          } else {
            cardSaveWarning = 'No reusable card was generated from this terminal payment. The member will need to add a payment method manually, or their next renewal will fail.';
            console.warn(`[Terminal] ${cardSaveWarning} (PI: ${paymentIntentId})`);
          }
        } else {
          reusablePaymentMethodId = paymentIntent.payment_method as string;
        }

        if (reusablePaymentMethodId) {
          try {
            await stripe.paymentMethods.attach(reusablePaymentMethodId, {
              customer: customerId
            });
          } catch (attachErr: unknown) {
            if (!getErrorMessage(attachErr)?.includes('already been attached')) {
              throw attachErr;
            }
          }

          await stripe.customers.update(customerId, {
            invoice_settings: {
              default_payment_method: reusablePaymentMethodId
            }
          });

          await stripe.subscriptions.update(subscriptionId, {
            default_payment_method: reusablePaymentMethodId
          });

          cardSaved = true;
          console.log(`[Terminal] Saved payment method ${reusablePaymentMethodId} as default for customer ${customerId} and subscription ${subscriptionId}`);
        }
      } catch (attachError: unknown) {
        cardSaveWarning = `Failed to save payment method for future billing: ${getErrorMessage(attachError)}. The member may need to add a card manually.`;
        console.error(`[Terminal] ${cardSaveWarning}`);
      }
    } else {
      cardSaveWarning = 'No payment method found on the PaymentIntent. The member will need to add a payment method manually for future billing.';
      console.warn(`[Terminal] ${cardSaveWarning} (PI: ${paymentIntentId})`);
    }
    
    if (existingUser?.membershipStatus === 'active') {
      console.log(`[Terminal] User ${userId} already active, payment record ensured, card save attempted, returning early`);
      return res.json({
        success: true,
        membershipStatus: 'active',
        subscriptionId,
        paymentIntentId,
        alreadyActivated: true,
        cardSaved,
        cardSaveWarning
      });
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
        const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
        await syncMemberToHubSpot({
          email: updatedUser.email as string,
          status: updatedUser.membershipStatus || 'active',
          tier: updatedUser.tier || undefined,
          billingProvider: updatedUser.billingProvider || undefined,
          billingGroupRole: 'Primary',
        });
      } catch (hubspotError) {
        console.error('[Terminal] HubSpot sync error (non-blocking):', hubspotError);
      }
    }
    
    await logFromRequest(req, {
      action: 'terminal_subscription_activated' as any,
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
      paymentIntentId,
      cardSaved,
      cardSaveWarning
    });
  } catch (error: unknown) {
    console.error('[Terminal] Error confirming subscription payment:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to confirm subscription payment' });
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
  } catch (error: unknown) {
    console.error('[Terminal] Error refunding payment:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to refund payment' });
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
      readerLabel = (readerObj as any).label || readerId;
    } catch (e) { /* reader label is cosmetic, ignore */ }

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
    } catch (updateErr: unknown) {
      console.log(`[Terminal] First update attempt failed, trying stepwise:`, getErrorMessage(updateErr));
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
      } catch (simErr: unknown) {
        console.error('[Terminal] Simulated card presentation error (non-blocking):', getErrorMessage(simErr));
      }
    }

    await logFromRequest(req, {
      action: 'terminal_existing_payment_routed' as any,
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
  } catch (error: unknown) {
    console.error('[Terminal] Error processing existing payment:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to process existing payment on terminal' });
  }
});

router.post('/api/stripe/terminal/save-card', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId, customerId, email, userId } = req.body;

    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required' });
    }

    const stripe = await getStripeClient();

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card_present'],
      usage: 'off_session',
      metadata: {
        source: 'terminal',
        email: email || '',
        userId: userId || '',
        paymentType: 'save_card'
      }
    });

    const reader = await stripe.terminal.readers.processSetupIntent(readerId, {
      setup_intent: setupIntent.id,
      customer_consent_collected: true
    } as any);

    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: unknown) {
        console.error('[Terminal] Simulated card presentation error (non-blocking):', getErrorMessage(simErr));
      }
    }

    await logFromRequest(req, {
      action: 'terminal_save_card_initiated' as any,
      resourceType: 'setup_intent',
      resourceId: setupIntent.id,
      resourceName: email || customerId,
      details: {
        setupIntentId: setupIntent.id,
        readerId,
        customerId,
        userId: userId || null
      }
    });

    res.json({
      success: true,
      setupIntentId: setupIntent.id,
      readerId: reader.id,
      readerAction: reader.action
    });
  } catch (error: unknown) {
    console.error('[Terminal] Error initiating save card:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to initiate save card' });
  }
});

router.get('/api/stripe/terminal/setup-status/:setupIntentId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { setupIntentId } = req.params;
    const stripe = await getStripeClient();

    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId as string);

    res.json({
      id: setupIntent.id,
      status: setupIntent.status,
      paymentMethod: setupIntent.payment_method
    });
  } catch (error: unknown) {
    console.error('[Terminal] Error checking setup status:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to check setup status' });
  }
});

router.post('/api/stripe/terminal/confirm-save-card', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { setupIntentId, customerId, subscriptionId } = req.body;

    if (!setupIntentId) {
      return res.status(400).json({ error: 'SetupIntent ID is required' });
    }
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required' });
    }

    const stripe = await getStripeClient();

    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
      expand: ['payment_method']
    });

    if (setupIntent.status !== 'succeeded') {
      return res.status(400).json({
        error: `SetupIntent is in "${setupIntent.status}" state, expected "succeeded"`,
        status: setupIntent.status
      });
    }

    if (!setupIntent.payment_method) {
      return res.status(400).json({ error: 'No payment method found on SetupIntent' });
    }

    const pmId = typeof setupIntent.payment_method === 'string' 
      ? setupIntent.payment_method 
      : setupIntent.payment_method.id;

    const pm = typeof setupIntent.payment_method === 'string'
      ? await stripe.paymentMethods.retrieve(pmId)
      : setupIntent.payment_method;

    let reusablePaymentMethodId = pmId;

    if (pm.type === 'card_present' && (pm as any).card_present?.generated_card) {
      reusablePaymentMethodId = (pm as any).card_present.generated_card;
      console.log(`[Terminal] Found generated_card ${reusablePaymentMethodId} from SetupIntent card_present`);
    }

    if (!reusablePaymentMethodId) {
      return res.status(400).json({ error: 'Could not resolve a reusable payment method from the SetupIntent' });
    }

    let paymentMethodId = reusablePaymentMethodId;

    try {
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId
      });
    } catch (attachErr: unknown) {
      if (!getErrorMessage(attachErr)?.includes('already been attached')) {
        return res.status(500).json({ error: `Failed to attach payment method: ${getErrorMessage(attachErr)}` });
      }
    }

    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });

    if (subscriptionId) {
      await stripe.subscriptions.update(subscriptionId, {
        default_payment_method: paymentMethodId
      });
    }

    await logFromRequest(req, {
      action: 'terminal_card_saved' as any,
      resourceType: 'payment_method',
      resourceId: paymentMethodId,
      resourceName: customerId,
      details: {
        setupIntentId,
        customerId,
        subscriptionId: subscriptionId || null,
        paymentMethodId
      }
    });

    res.json({
      success: true,
      cardSaved: true,
      paymentMethodId
    });
  } catch (error: unknown) {
    console.error('[Terminal] Error confirming save card:', error);
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to confirm save card' });
  }
});

export default router;
