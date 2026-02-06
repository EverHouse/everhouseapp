import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { getStripeClient } from '../../core/stripe/client';
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
        display_name: 'Ever House - Main Location',
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
      label: 'Ever House Simulated Reader',
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
    const { readerId, amount, currency = 'usd', description, metadata } = req.body;
    
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
        const existingCustomers = await stripe.customers.list({
          email: metadata.ownerEmail,
          limit: 1
        });
        if (existingCustomers.data.length > 0) {
          customerId = existingCustomers.data[0].id;
          try {
            await pool.query(
              `UPDATE users SET stripe_customer_id = $1, updated_at = NOW()
               WHERE LOWER(email) = LOWER($2) AND stripe_customer_id IS NULL`,
              [customerId, metadata.ownerEmail]
            );
          } catch (linkErr: any) {
            console.warn('[Terminal] Could not link existing Stripe customer (non-blocking):', linkErr.message);
          }
        } else {
          const customer = await stripe.customers.create({
            email: metadata.ownerEmail,
            name: metadata.ownerName || undefined,
            metadata: {
              source: 'terminal_pos',
            }
          });
          customerId = customer.id;

          try {
            const nameParts = (metadata.ownerName || '').trim().split(/\s+/);
            const firstName = nameParts[0] || '';
            const lastName = nameParts.slice(1).join(' ') || '';

            const existingUser = await pool.query(
              'SELECT id, stripe_customer_id FROM users WHERE LOWER(email) = LOWER($1)',
              [metadata.ownerEmail]
            );

            if (existingUser.rows.length === 0) {
              const crypto = await import('crypto');
              const visitorId = crypto.randomUUID();
              await pool.query(
                `INSERT INTO users (id, email, first_name, last_name, membership_status, stripe_customer_id, data_source, visitor_type, role, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'visitor', $5, 'APP', 'day_pass', 'visitor', NOW(), NOW())
                 ON CONFLICT (email) DO UPDATE SET
                   stripe_customer_id = COALESCE(users.stripe_customer_id, EXCLUDED.stripe_customer_id),
                   first_name = COALESCE(NULLIF(users.first_name, ''), EXCLUDED.first_name),
                   last_name = COALESCE(NULLIF(users.last_name, ''), EXCLUDED.last_name),
                   updated_at = NOW()`,
                [visitorId, metadata.ownerEmail, firstName, lastName, customer.id]
              );
              console.log(`[Terminal] Created/updated visitor record for POS customer: ${metadata.ownerEmail}`);
            } else if (!existingUser.rows[0].stripe_customer_id) {
              await pool.query(
                'UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2',
                [customer.id, existingUser.rows[0].id]
              );
              console.log(`[Terminal] Linked Stripe customer ${customer.id} to existing user: ${metadata.ownerEmail}`);
            }
          } catch (visitorErr: any) {
            console.warn('[Terminal] Could not create visitor record for new POS customer (non-blocking):', visitorErr.message);
          }
        }
      } catch (custErr: any) {
        console.warn('[Terminal] Could not create Stripe customer for new customer (non-blocking):', custErr.message);
      }
    }
    
    const finalMetadata = {
      ...(metadata || {}),
      source: metadata?.source || 'terminal',
      email: metadata?.ownerEmail || '',
      purpose: 'one_time_purchase'
    };

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: description || 'Terminal payment',
      metadata: finalMetadata,
      ...(customerId ? { customer: customerId } : {}),
      ...(metadata?.ownerEmail ? { receipt_email: metadata.ownerEmail } : {})
    });
    
    if (customerId || metadata?.ownerEmail) {
      try {
        await pool.query(
          `INSERT INTO stripe_payment_intents 
           (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, product_id, product_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
          [
            metadata?.userId || `guest-${customerId || 'terminal'}`,
            paymentIntent.id,
            customerId || null,
            Math.round(amount),
            'one_time_purchase',
            description || 'Terminal payment',
            'pending',
            null,
            metadata?.items || null
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
    
    if (existingUser?.membership_status === 'active') {
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
        await stripe.paymentMethods.attach(paymentIntent.payment_method as string, {
          customer: customerId
        });
        
        await stripe.customers.update(customerId, {
          invoice_settings: {
            default_payment_method: paymentIntent.payment_method as string
          }
        });
      } catch (attachError: any) {
        if (!attachError.message?.includes('already been attached')) {
          console.error('[Terminal] Error attaching payment method:', attachError);
        }
      }
    }
    
    await db.update(users)
      .set({ 
        membership_status: 'active',
        updated_at: new Date()
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

export default router;
