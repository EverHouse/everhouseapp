import Stripe from 'stripe';
import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../../../core/middleware';
import { paymentRateLimiter } from '../../../middleware/rateLimiting';
import { db } from '../../../db';
import { sql } from 'drizzle-orm';
import { getSessionUser } from '../../../types/session';
import { getInvoice } from '../../../core/stripe';
import { sendNotificationToUser, broadcastBillingUpdate, broadcastBookingInvoiceUpdate } from '../../../core/websocket';
import { logPaymentAudit } from '../../../core/auditLog';
import { alertOnExternalServiceError } from '../../../core/errorAlerts';
import { getErrorMessage } from '../../../utils/errorUtils';
import { listCustomerPaymentMethods } from '../../../core/stripe/customers';
import { logger } from '../../../core/logger';
import {
  StripeInvoiceExpanded,
  UserRow,
  StripeCustomerIdRow,
  finalizeInvoiceWithPi,
  retrieveInvoicePaymentIntent,
} from './shared';

const router = Router();

router.post('/api/member/invoices/:invoiceId/pay', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    if (!invoiceId || !(invoiceId as string).startsWith('in_')) {
      return res.status(400).json({ error: 'Invalid invoice ID' });
    }

    const userResult = await db.execute(sql`
      SELECT id, stripe_customer_id, first_name, last_name, email FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()}
    `);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0] as unknown as UserRow;
    const stripeCustomerId = user.stripe_customer_id;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found. Please contact support.' });
    }

    const invoiceResult = await getInvoice(invoiceId as string);

    if (!invoiceResult.success || !invoiceResult.invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.invoice;

    const { getStripeClient } = await import('../../../core/stripe/client');
    const stripe = await getStripeClient();
    const stripeInvoice = await stripe.invoices.retrieve(invoiceId as string);

    if (stripeInvoice.customer !== stripeCustomerId) {
      return res.status(403).json({ error: 'You do not have permission to pay this invoice' });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ error: 'This invoice has already been paid' });
    }

    if (invoice.status !== 'draft' && invoice.status !== 'open') {
      return res.status(400).json({ error: `Cannot pay invoice with status: ${invoice.status}` });
    }

    const amountDue = invoice.amountDue;
    if (amountDue < 50) {
      return res.status(400).json({ error: 'Invoice amount is too small to process' });
    }

    let invoicePiId: string;
    let invoicePiSecret: string;

    if (stripeInvoice.status === 'draft') {
      await stripe.invoices.update(invoiceId as string, {
        collection_method: 'charge_automatically',
        payment_settings: {
          payment_method_types: ['card', 'link'],
        },
      });
      const piResult = await finalizeInvoiceWithPi(stripe, invoiceId as string);
      if (piResult.paidInFull) {
        logger.info('[Stripe] Invoice auto-paid after finalization', { extra: { invoiceId } });
        const metaBookingId = stripeInvoice.metadata?.bookingId ? parseInt(stripeInvoice.metadata.bookingId, 10) : 0;
        if (metaBookingId) {
          await db.execute(sql`
            UPDATE booking_participants
             SET payment_status = 'paid', paid_at = NOW(), updated_at = NOW()
             WHERE booking_id = ${metaBookingId}
               AND payment_status IN ('pending', 'unpaid')
          `);
          await logPaymentAudit({
            bookingId: metaBookingId,
            action: 'payment_confirmed',
            staffEmail: 'system',
            amountAffected: amountDue / 100,
            paymentMethod: 'account_credit',
            metadata: { invoiceId, trigger: 'auto_pay_invoice_endpoint' },
          });
        }
        return res.json({
          paidInFull: true,
          invoiceId,
          paymentIntentId: '',
          totalAmount: amountDue / 100,
          balanceApplied: amountDue / 100,
          remainingAmount: 0,
        });
      }
      invoicePiId = piResult.piId;
      invoicePiSecret = piResult.clientSecret;
      logger.info('[Stripe] Finalized draft invoice as charge_automatically for interactive member payment', { extra: { invoiceId, paymentIntentId: invoicePiId } });
    } else if (stripeInvoice.status === 'open') {
      if (stripeInvoice.collection_method === 'send_invoice') {
        await stripe.invoices.update(invoiceId as string, {
          collection_method: 'charge_automatically',
          payment_settings: {
            payment_method_types: ['card', 'link'],
          },
        });
        logger.info('[Stripe] Switched open invoice from send_invoice to charge_automatically', { extra: { invoiceId } });
      }
      const piResult = await retrieveInvoicePaymentIntent(stripe, invoiceId as string);
      invoicePiId = piResult.piId;
      invoicePiSecret = piResult.clientSecret;
      logger.info('[Stripe] Invoice already open — using existing PI', { extra: { invoiceId, paymentIntentId: invoicePiId } });
    } else {
      throw new Error(`Invoice ${invoiceId} has unexpected status: ${stripeInvoice.status}`);
    }

    const primaryLine = invoice.lines?.[0];
    const description = primaryLine?.description || invoice.description || `Invoice ${invoiceId}`;

    logger.info('[Stripe] Returning invoice PI for interactive member payment', {
      extra: { invoiceId, paymentIntentId: invoicePiId, amount: amountDue }
    });

    try {
      await stripe.paymentIntents.update(invoicePiId, {
        setup_future_usage: 'off_session',
      });
    } catch (sfuErr: unknown) {
      logger.warn('[Stripe] Could not set setup_future_usage on invoice PI', {
        extra: { invoiceId, piId: invoicePiId, error: getErrorMessage(sfuErr) }
      });
    }

    let customerSessionSecret: string | undefined;
    try {
      const customerSession = await stripe.customerSessions.create({
        customer: stripeCustomerId,
        components: {
          payment_element: {
            enabled: true,
            features: {
              payment_method_redisplay: 'enabled',
              payment_method_save: 'enabled',
              payment_method_remove: 'enabled',
            },
          },
        },
      });
      customerSessionSecret = customerSession.client_secret;
    } catch (csErr: unknown) {
      logger.warn('[Stripe] Failed to create customer session for saved cards (invoice payment)', {
        extra: { invoiceId, error: getErrorMessage(csErr) }
      });
    }

    res.json({
      clientSecret: invoicePiSecret,
      paymentIntentId: invoicePiId,
      invoiceId: invoiceId,
      amount: amountDue / 100,
      description: description,
      currency: invoice.currency || 'usd',
      customerSessionClientSecret: customerSessionSecret,
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating invoice payment intent', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'create invoice payment intent');
    res.status(500).json({ 
      error: 'Payment initialization failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/member/invoices/:invoiceId/pay-saved-card', isAuthenticated, paymentRateLimiter, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    if (!invoiceId || !(invoiceId as string).startsWith('in_')) {
      return res.status(400).json({ error: 'Invalid invoice ID' });
    }

    const { paymentMethodId } = req.body;
    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      return res.status(400).json({ error: 'Missing paymentMethodId' });
    }

    const userResult = await db.execute(sql`
      SELECT id, stripe_customer_id, email FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()} AND archived_at IS NULL
    `);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0] as { id: string; stripe_customer_id: string | null; email: string };

    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No payment methods on file. Please use the standard payment form.' });
    }

    const savedMethods = await listCustomerPaymentMethods(user.stripe_customer_id);
    const selectedMethod = savedMethods.find(m => m.id === paymentMethodId);
    if (!selectedMethod) {
      return res.status(400).json({ error: 'Selected card is no longer available. Please use the standard payment form.' });
    }

    const { getStripeClient } = await import('../../../core/stripe/client');
    const stripe = await getStripeClient();
    const stripeInvoice = await stripe.invoices.retrieve(invoiceId as string);

    if (stripeInvoice.customer !== user.stripe_customer_id) {
      return res.status(403).json({ error: 'You do not have permission to pay this invoice' });
    }

    if (stripeInvoice.status === 'paid') {
      return res.status(400).json({ error: 'This invoice has already been paid' });
    }

    if (stripeInvoice.status !== 'draft' && stripeInvoice.status !== 'open') {
      return res.status(400).json({ error: `Cannot pay invoice with status: ${stripeInvoice.status}` });
    }

    const amountDue = stripeInvoice.amount_due;
    if (amountDue < 50) {
      return res.status(400).json({ error: 'Invoice amount is too small to process' });
    }

    if (stripeInvoice.status === 'draft') {
      await stripe.invoices.update(invoiceId as string, {
        collection_method: 'charge_automatically',
        payment_settings: {
          payment_method_types: ['card', 'link'],
        },
      });
      await stripe.invoices.finalizeInvoice(invoiceId as string);
    } else if (stripeInvoice.collection_method === 'send_invoice') {
      await stripe.invoices.update(invoiceId as string, {
        collection_method: 'charge_automatically',
        payment_settings: {
          payment_method_types: ['card', 'link'],
        },
      });
    }

    const paidInvoice = await stripe.invoices.pay(invoiceId as string, {
      payment_method: selectedMethod.id,
    });

    if (paidInvoice.status === 'paid') {
      try {
        await db.execute(sql`INSERT INTO billing_audit 
          (member_email, member_id, action, amount_cents, description, invoice_id, created_at)
          VALUES (${sessionEmail}, ${user.id}, 'member_saved_card_invoice', ${amountDue}, ${`Paid invoice ${invoiceId} with saved card •••• ${selectedMethod.last4}`}, ${invoiceId}, NOW())`);
      } catch (auditErr: unknown) {
        logger.warn('[MemberPayments] Failed to write invoice billing audit (non-blocking)', { extra: { error: getErrorMessage(auditErr) } });
      }

      broadcastBillingUpdate({
        memberEmail: sessionEmail,
        action: 'invoice_paid',
        status: 'paid'
      });

      logger.info('[MemberPayments] Member paid invoice with saved card', {
        extra: { invoiceId, memberEmail: sessionEmail, amountCents: amountDue, cardLast4: selectedMethod.last4 }
      });

      return res.json({
        success: true,
        cardBrand: selectedMethod.brand,
        cardLast4: selectedMethod.last4,
        amountCents: amountDue,
      });
    }

    const rawPi = (paidInvoice as unknown as StripeInvoiceExpanded).payment_intent;
    const piId = typeof rawPi === 'string' ? rawPi : rawPi?.id;
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status === 'requires_action') {
        return res.status(402).json({
          error: 'Your card requires additional verification. Please use the standard payment form.',
          requiresAction: true,
        });
      }
    }

    return res.status(400).json({
      error: 'Payment could not be completed with this card. Please try the standard payment form.',
    });
  } catch (error: unknown) {
    logger.error('[MemberPayments] Error processing saved card invoice payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'member saved card invoice payment');
    return res.status(500).json({
      error: 'Payment failed. Please try using the standard payment form.',
      retryable: true
    });
  }
});

router.post('/api/member/invoices/:invoiceId/confirm', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { invoiceId } = req.params;
    const { paymentIntentId } = req.body;

    if (!invoiceId || !paymentIntentId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userResult = await db.execute(sql`
      SELECT stripe_customer_id FROM users WHERE LOWER(email) = ${sessionEmail.toLowerCase()}
    `);

    const confirmUser = (userResult.rows as unknown as StripeCustomerIdRow[])[0];
    const stripeCustomerId = confirmUser?.stripe_customer_id;
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const { getStripeClient } = await import('../../../core/stripe/client');
    const stripe = await getStripeClient();

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded' });
    }

    const invId = invoiceId as string;
    const invoice = await stripe.invoices.retrieve(invId, { expand: ['payment_intent'] });

    if (invoice.customer !== stripeCustomerId) {
      return res.status(403).json({ error: 'You do not have permission to confirm this invoice' });
    }

    const rawPi = (invoice as unknown as { payment_intent: string | Stripe.PaymentIntent | null }).payment_intent;
    const invoicePiId = typeof rawPi === 'string'
      ? rawPi
      : (typeof rawPi === 'object' && rawPi !== null) ? (rawPi as Stripe.PaymentIntent).id : null;

    if (invoicePiId !== paymentIntentId) {
      return res.status(400).json({ error: 'Payment does not match invoice' });
    }

    if (invoice.status === 'paid') {
      logger.info('[Stripe] Invoice paid via its own PI', { extra: { invoiceId: invId, paymentIntentId } });
    } else {
      logger.info('[Stripe] Invoice not yet marked paid — Stripe will settle automatically when PI webhook arrives', { extra: { invoiceId: invId, paymentIntentId, invoiceStatus: invoice.status } });
    }

    sendNotificationToUser(sessionEmail, {
      type: 'billing_update',
      title: 'Invoice Paid',
      message: 'Your invoice has been paid successfully.',
      data: { invoiceId: invId, status: 'paid' }
    });
    
    broadcastBillingUpdate({
      memberEmail: sessionEmail,
      action: 'invoice_paid',
      status: 'paid'
    });

    try {
      const invoiceMeta = (invoice as unknown as StripeInvoiceExpanded).metadata;
      const invoiceBookingId = invoiceMeta?.bookingId ? parseInt(invoiceMeta.bookingId, 10) : null;
      if (invoiceBookingId) {
        broadcastBookingInvoiceUpdate({
          bookingId: invoiceBookingId,
          action: 'invoice_paid',
          invoiceId: invId,
        });
      }
    } catch (_broadcastErr: unknown) { /* non-blocking */ }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming invoice payment', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error instanceof Error ? error : new Error(String(error)), 'confirm invoice payment');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

export default router;
