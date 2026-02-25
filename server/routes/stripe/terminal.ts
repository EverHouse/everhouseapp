import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { getStripeClient } from '../../core/stripe/client';
import { createInvoiceWithLineItems, confirmPaymentSuccess, type CartLineItem } from '../../core/stripe/payments';
import { createDraftBookingFeeInvoice, type BookingFeeLineItem } from '../../core/stripe/invoices';
import { getBookingInvoiceId } from '../../core/billing/bookingInvoiceService';
import { logFromRequest } from '../../core/auditLog';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { findOrCreateHubSpotContact } from '../../core/hubspot/members';
import { getSessionUser } from '../../types/session';
import Stripe from 'stripe';

const router = Router();

router.post('/api/stripe/terminal/connection-token', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    const connectionToken = await stripe.terminal.connectionTokens.create();
    
    res.json({ secret: connectionToken.secret });
  } catch (error: unknown) {
    logger.error('[Terminal] Error creating connection token', { error: error instanceof Error ? error : new Error(String(error)) });
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
    logger.error('[Terminal] Error listing readers', { error: error instanceof Error ? error : new Error(String(error)) });
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
  } catch (error: unknown) {
    logger.error('[Terminal] Error creating simulated reader', { error: error instanceof Error ? error : new Error(String(error)) });
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
        logger.warn('[Terminal] Could not resolve Stripe customer for existing member (non-blocking)', { extra: { custErr: getErrorMessage(custErr) } });
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
                const terminalUserCheck = await db.execute(sql`SELECT archived_at FROM users WHERE id = ${resolvedTerminal.userId}`);
                await db.execute(sql`UPDATE users SET stripe_customer_id = ${customerId}, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${resolvedTerminal.userId}`);
                if ((terminalUserCheck.rows as Array<Record<string, unknown>>)[0]?.archived_at) {
                  logger.info('[Auto-Unarchive] User unarchived after receiving Stripe customer ID', { extra: { resolvedTerminalPrimaryEmail: resolvedTerminal.primaryEmail } });
                }
              }
              logger.info('[Terminal] Linked Stripe customer to existing user via', { extra: { resolvedTerminalPrimaryEmail: resolvedTerminal.primaryEmail, resolvedTerminalMatchType: resolvedTerminal.matchType } });
            } else {
              const termExclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${metadata.ownerEmail.toLowerCase()}`);
              if (termExclusionCheck.rows.length > 0) {
                logger.info('[Terminal] Skipping visitor creation for permanently deleted member', { extra: { email: metadata.ownerEmail } });
              } else {
                const crypto = await import('crypto');
                const visitorId = crypto.randomUUID();
                await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, membership_status, stripe_customer_id, data_source, visitor_type, role, created_at, updated_at)
                   VALUES (${visitorId}, ${metadata.ownerEmail}, ${firstName}, ${lastName}, 'visitor', ${customerId}, 'APP', 'day_pass', 'visitor', NOW(), NOW())
                   ON CONFLICT (email) DO UPDATE SET
                     stripe_customer_id = COALESCE(users.stripe_customer_id, EXCLUDED.stripe_customer_id),
                     first_name = COALESCE(NULLIF(users.first_name, ''), EXCLUDED.first_name),
                     last_name = COALESCE(NULLIF(users.last_name, ''), EXCLUDED.last_name),
                     archived_at = NULL,
                     archived_by = NULL,
                     updated_at = NOW()`);
                logger.info('[Terminal] Created/updated visitor record for POS customer', { extra: { metadataOwnerEmail: metadata.ownerEmail } });
                
                // Background sync visitor to HubSpot for CRM tracking
                findOrCreateHubSpotContact(
                  metadata.ownerEmail,
                  firstName || '',
                  lastName || '',
                  undefined,
                  undefined,
                  { role: 'visitor' }
                ).catch((err) => {
                  logger.error('[Terminal] Background HubSpot sync for day-pass visitor failed', { extra: { err: err instanceof Error ? err.message : String(err) } });
                });
              }
            }
          } catch (visitorErr: unknown) {
            logger.warn('[Terminal] Could not create visitor record for new POS customer (non-blocking)', { extra: { visitorErr: getErrorMessage(visitorErr) } });
          }
        }
      } catch (custErr: unknown) {
        logger.warn('[Terminal] Could not create Stripe customer for new customer (non-blocking)', { extra: { custErr: getErrorMessage(custErr) } });
      }
    }
    
    const isBookingFee = metadata?.paymentType === 'booking_fee';
    const finalMetadata: Record<string, string> = {
      ...(metadata || {}),
      source: metadata?.source || 'terminal',
      email: metadata?.ownerEmail || '',
      purpose: isBookingFee ? 'booking_fee' : 'one_time_purchase',
      readerId,
      readerLabel: metadata?.readerLabel || readerId,
    };

    if (isBookingFee && metadata?.sessionId) {
      try {
        const pendingParticipants = await db.execute(sql`SELECT id, cached_fee_cents FROM booking_participants
           WHERE session_id = ${parseInt(metadata.sessionId)} AND payment_status = 'pending' AND cached_fee_cents > 0`);
        if (pendingParticipants.rows.length > 0) {
          const fees = (pendingParticipants.rows as Array<Record<string, unknown>>).map((r: Record<string, unknown>) => ({
            id: r.id as number,
            amountCents: r.cached_fee_cents as number
          }));
          const serialized = JSON.stringify(fees);
          if (serialized.length <= 490) {
            finalMetadata.participantFees = serialized;
          } else {
            finalMetadata.participantFees = serialized.substring(0, 490);
            logger.warn('[Terminal] participantFees metadata truncated due to size', { extra: { sessionId: metadata.sessionId, count: fees.length } });
          }
          logger.info('[Terminal] Attached participantFees to booking_fee PI metadata', { extra: { sessionId: metadata.sessionId, count: fees.length } });
        }
      } catch (pfErr: unknown) {
        logger.warn('[Terminal] Could not attach participantFees to metadata (non-blocking)', { extra: { pfErr: getErrorMessage(pfErr) } });
      }
    }

    let finalDescription = description || 'Terminal payment';
    if (metadata?.bookingId) {
      try {
        const bookingLookup = await db.execute(sql`SELECT trackman_booking_id FROM booking_requests WHERE id = ${metadata.bookingId}`);
        const trackmanId = bookingLookup.rows[0]?.trackman_booking_id;
        const displayId = trackmanId || metadata.bookingId;
        if (finalDescription && !finalDescription.startsWith('#')) {
          finalDescription = `#${displayId} - ${finalDescription}`;
        }
      } catch (lookupErr: unknown) {
        logger.warn('[Terminal] Could not look up booking for description prefix', { extra: { lookupErr: getErrorMessage(lookupErr) } });
      }
    }

    let paymentIntent: Stripe.PaymentIntent;
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
        logger.error('[Terminal] Invoice creation failed, falling back to bare PI', { extra: { invoiceErr: getErrorMessage(invoiceErr) } });
        paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount),
          currency,
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          description: finalDescription,
          metadata: finalMetadata,
          ...(customerId ? { customer: customerId } : {}),
          ...(metadata?.ownerEmail ? { receipt_email: metadata.ownerEmail } : {})
        }, {
          idempotencyKey: `terminal_fallback_${customerId || 'anon'}_${amount}_${Math.floor(Date.now() / 300000)}`
        });
      }
    } else {
      if (isBookingFee && customerId && metadata?.sessionId) {
        try {
          const bookingIdVal = metadata?.bookingId ? parseInt(metadata.bookingId) : 0;

          if (bookingIdVal) {
            const existingInvoiceId = await getBookingInvoiceId(bookingIdVal);
            if (existingInvoiceId) {
              invoiceId = existingInvoiceId;
              finalMetadata.draftInvoiceId = existingInvoiceId;
              logger.info('[Terminal] Using existing draft invoice for terminal payment', {
                extra: { invoiceId: existingInvoiceId, bookingId: bookingIdVal }
              });
            }
          }

          if (!invoiceId) {
            const sessionIdVal = parseInt(metadata.sessionId);

            const participantRows = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
               FROM booking_participants
               WHERE session_id = ${sessionIdVal} AND payment_status = 'pending' AND cached_fee_cents > 0`);

            if (participantRows.rows.length > 0) {
              const feeLineItems: BookingFeeLineItem[] = (participantRows.rows as Array<Record<string, unknown>>).map((r: Record<string, unknown>) => {
                const isGuest = r.participant_type === 'guest';
                return {
                  participantId: r.id as number,
                  displayName: (r.display_name as string) || (isGuest ? 'Guest' : 'Member'),
                  participantType: r.participant_type as 'owner' | 'member' | 'guest',
                  overageCents: isGuest ? 0 : (r.cached_fee_cents as number),
                  guestCents: isGuest ? (r.cached_fee_cents as number) : 0,
                  totalCents: r.cached_fee_cents as number,
                };
              });

              const trackmanLookup = await db.execute(sql`SELECT trackman_booking_id FROM booking_requests WHERE id = ${bookingIdVal}`);
              const trackmanBookingId = trackmanLookup.rows[0]?.trackman_booking_id || null;

              const draftResult = await createDraftBookingFeeInvoice({
                customerId,
                bookingId: bookingIdVal,
                sessionId: sessionIdVal,
                trackmanBookingId: trackmanBookingId ? String(trackmanBookingId) : null,
                feeLineItems,
                metadata: finalMetadata,
                purpose: 'booking_fee',
              });

              invoiceId = draftResult.invoiceId;
              finalMetadata.draftInvoiceId = draftResult.invoiceId;
              logger.info('[Terminal] Created draft booking fee invoice for terminal payment', { extra: { invoiceId: draftResult.invoiceId, sessionId: sessionIdVal, bookingId: bookingIdVal } });
            }
          }
        } catch (draftErr: unknown) {
          logger.warn('[Terminal] Could not create draft booking fee invoice (non-blocking)', { extra: { detail: getErrorMessage(draftErr) } });
        }
      }

      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount),
        currency,
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: finalDescription,
        metadata: finalMetadata,
        ...(customerId ? { customer: customerId } : {}),
        ...(metadata?.ownerEmail ? { receipt_email: metadata.ownerEmail } : {})
      }, {
        idempotencyKey: `terminal_${customerId || 'anon'}_${amount}_${Math.floor(Date.now() / 300000)}`
      });
    }
    
    if (customerId || metadata?.ownerEmail) {
      try {
        const bookingIdVal = isBookingFee && metadata?.bookingId ? parseInt(metadata.bookingId) || null : null;
        const sessionIdVal = isBookingFee && metadata?.sessionId ? parseInt(metadata.sessionId) || null : null;
        await db.execute(sql`INSERT INTO stripe_payment_intents 
           (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, product_id, product_name, booking_id, session_id)
           VALUES (${metadata?.userId || `guest-${customerId || 'terminal'}`}, ${paymentIntent.id}, ${customerId || null}, ${Math.round(amount)}, ${isBookingFee ? 'booking_fee' : 'one_time_purchase'}, ${finalDescription}, 'pending', ${null}, ${metadata?.items || null}, ${bookingIdVal}, ${sessionIdVal})
           ON CONFLICT (stripe_payment_intent_id) DO NOTHING`);
      } catch (dbErr: unknown) {
        logger.warn('[Terminal] Non-blocking: Could not save local payment record', { extra: { dbErr: getErrorMessage(dbErr) } });
      }
    }

    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntent.id
    });
    
    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: unknown) {
        logger.error('[Terminal] Simulated card presentation error (non-blocking)', { extra: { simErr: getErrorMessage(simErr) } });
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
    logger.error('[Terminal] Error processing payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to process payment' });
  }
});

router.get('/api/stripe/terminal/payment-status/:paymentIntentId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.params;
    if ((paymentIntentId as string).startsWith('seti_') || (paymentIntentId as string).startsWith('free_')) {
      return res.json({ status: 'succeeded', freeActivation: true });
    }
    const stripe = await getStripeClient();
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId as string);

    const draftInvoiceId = paymentIntent.metadata?.draftInvoiceId || paymentIntent.metadata?.invoice_id;
    if (paymentIntent.status === 'succeeded' && draftInvoiceId) {
      try {
        const inv = await stripe.invoices.retrieve(draftInvoiceId);
        if (inv.status === 'draft' || inv.status === 'open') {
          const { finalizeInvoicePaidOutOfBand } = await import('../../core/stripe/invoices');
          const oobResult = await finalizeInvoicePaidOutOfBand(draftInvoiceId);
          if (oobResult.success) {
            try {
              await stripe.invoices.update(draftInvoiceId, {
                metadata: {
                  ...(inv.metadata || {}),
                  terminalPaymentIntentId: paymentIntentId as string,
                  paidVia: 'terminal',
                },
              });
            } catch (metaErr: unknown) {
              logger.warn('[Terminal] Could not update invoice metadata after OOB payment', { extra: { detail: getErrorMessage(metaErr) } });
            }
            logger.info('[Terminal] Invoice finalized and marked paid (out-of-band) after terminal payment', { extra: { invoiceId: draftInvoiceId, paymentIntentId } });
          } else {
            logger.warn('[Terminal] Could not finalize invoice out-of-band', { extra: { invoiceId: draftInvoiceId, error: oobResult.error } });
          }
        } else if (inv.status === 'paid') {
          logger.info('[Terminal] Invoice already paid, no action needed', { extra: { invoiceId: draftInvoiceId } });
        }
      } catch (invErr: unknown) {
        logger.warn('[Terminal] Could not process invoice after terminal payment', { extra: { invoiceId: draftInvoiceId, error: getErrorMessage(invErr) } });
      }
    }

    const bookingIdFromMeta = paymentIntent.metadata?.bookingId;
    if (paymentIntent.status === 'succeeded' && bookingIdFromMeta && !draftInvoiceId) {
      try {
        const bookingInvoiceId = await getBookingInvoiceId(parseInt(bookingIdFromMeta));
        if (bookingInvoiceId) {
          const { finalizeInvoicePaidOutOfBand: finalizeBookingInvoiceOOB } = await import('../../core/billing/bookingInvoiceService');
          const oobResult = await finalizeBookingInvoiceOOB({
            bookingId: parseInt(bookingIdFromMeta),
            terminalPaymentIntentId: paymentIntentId as string,
            paidVia: 'terminal',
          });
          if (oobResult.success) {
            logger.info('[Terminal] Booking invoice finalized OOB after terminal payment', {
              extra: { invoiceId: bookingInvoiceId, paymentIntentId }
            });
          }
        }
      } catch (bookingInvErr: unknown) {
        logger.warn('[Terminal] Could not finalize booking invoice after terminal payment', {
          extra: { bookingId: bookingIdFromMeta, error: getErrorMessage(bookingInvErr) }
        });
      }
    }

    if (paymentIntent.status === 'succeeded') {
      try {
        const localRecord = await db.execute(sql`SELECT id, status FROM stripe_payment_intents WHERE stripe_payment_intent_id = ${paymentIntentId}`);
        if (localRecord.rows.length > 0 && localRecord.rows[0].status !== 'succeeded') {
          const result = await confirmPaymentSuccess(paymentIntentId as string, 'system', 'Terminal auto-sync');
          logger.info('[Terminal] Auto-synced payment via confirmPaymentSuccess', { extra: { paymentIntentId, result } });
        }
      } catch (syncErr: unknown) {
        logger.warn('[Terminal] Non-blocking: Could not auto-sync payment status', { extra: { syncErr: getErrorMessage(syncErr) } });
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
    logger.error('[Terminal] Error checking payment status', { error: error instanceof Error ? error : new Error(String(error)) });
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
        logger.warn('[Terminal] Could not cancel reader action', { extra: { readerErr: getErrorMessage(readerErr) } });
      }
    }

    let paymentAlreadySucceeded = false;

    if (paymentIntentId && !paymentIntentId.startsWith('seti_') && !paymentIntentId.startsWith('free_')) {
      try {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status === 'succeeded') {
          paymentAlreadySucceeded = true;
        } else if (pi.status !== 'canceled') {
          await stripe.paymentIntents.cancel(paymentIntentId);
          logger.info('[Terminal] Canceled PaymentIntent', { extra: { paymentIntentId } });
        }

        const draftInvId = pi.metadata?.draftInvoiceId || pi.metadata?.invoice_id;
        if (draftInvId && !paymentAlreadySucceeded) {
          try {
            const draftInv = await stripe.invoices.retrieve(draftInvId);
            if (draftInv.status === 'draft') {
              await stripe.invoices.del(draftInvId);
              logger.info('[Terminal] Deleted draft invoice after payment cancellation', { extra: { invoiceId: draftInvId } });
            } else if (draftInv.status === 'open') {
              await stripe.invoices.voidInvoice(draftInvId);
              logger.info('[Terminal] Voided open invoice after payment cancellation', { extra: { invoiceId: draftInvId } });
            }
          } catch (invCleanupErr: unknown) {
            logger.warn('[Terminal] Could not clean up draft invoice after cancel', { extra: { invoiceId: draftInvId, error: getErrorMessage(invCleanupErr) } });
          }
        }
      } catch (piErr: unknown) {
        logger.warn('[Terminal] Could not cancel PaymentIntent', { extra: { piErr: getErrorMessage(piErr) } });
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
    logger.error('[Terminal] Error canceling payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to cancel payment' });
  }
});

router.post('/api/stripe/terminal/process-subscription-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId, subscriptionId, userId, email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    if (!readerId) {
      return res.status(400).json({ error: 'Reader ID is required' });
    }
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Subscription ID is required' });
    }
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    const userCheck = await db.execute(sql`SELECT id, email, membership_status FROM users WHERE id = ${userId}`);
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
    
    const invoice = subscription.latest_invoice as Stripe.Invoice;
    if (!invoice) {
      return res.status(400).json({ error: 'No invoice found for subscription' });
    }
    
    const amount = invoice.amount_due;
    if (!amount || amount <= 0) {
      logger.info('[Terminal] $0 subscription — marking as paid out-of-band and activating member', { extra: { subscriptionId, userId } });
      try {
        await stripe.invoices.pay(invoice.id, { paid_out_of_band: true });
      } catch (payErr: unknown) {
        logger.warn('[Terminal] Could not mark $0 invoice as paid (may already be paid)', { extra: { error: getErrorMessage(payErr) } });
      }
      await db.execute(sql`UPDATE users SET membership_status = 'active', updated_at = NOW() WHERE id = ${Number(userId)}`);
      return res.json({ 
        success: true,
        freeActivation: true,
        paymentIntentId: `free_${subscriptionId}`,
        message: 'No payment required — $0 subscription activated'
      });
    }
    
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || '';
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
            logger.info('[Terminal] Cancelled stale PI for subscription', { extra: { piId: pi.id, subscriptionId } });
          } catch (cancelErr: unknown) {
            logger.error('[Terminal] Failed to cancel stale PI', { extra: { id: pi.id, error: getErrorMessage(cancelErr) } });
          }
        }
      }
    } catch (listErr: unknown) {
      logger.error('[Terminal] Error listing existing PIs:', { extra: { error: getErrorMessage(listErr) } });
    }

    const invoicePI = (typeof invoice.payment_intent === 'object' && invoice.payment_intent !== null) ? invoice.payment_intent as Stripe.PaymentIntent : null;
    let paymentIntent: Stripe.PaymentIntent;
    
    if (invoicePI && invoicePI.id) {
      if (invoicePI.status !== 'requires_payment_method' && invoicePI.status !== 'requires_confirmation') {
        return res.status(400).json({ 
          error: `Invoice PaymentIntent is in unexpected state: ${invoicePI.status}. Expected requires_payment_method or requires_confirmation.`,
          paymentIntentStatus: invoicePI.status
        });
      }
      
      let readerLabel = readerId;
      try {
        const readerObj = await stripe.terminal.readers.retrieve(readerId);
        readerLabel = readerObj.label || readerId;
      } catch (_) { /* use readerId as fallback label */ }

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
            paymentType: 'subscription_terminal',
            source: 'terminal',
            readerId,
            readerLabel,
          }
        });
        logger.info('[Terminal] Using invoice PI for subscription', { extra: { invoicePIId: invoicePI.id, subscriptionId } });
      } catch (updateErr: unknown) {
        logger.info('[Terminal] Cannot update invoice PI for terminal (likely automatic_payment_methods), creating new card_present PI', { extra: { id: invoicePI.id, error: getErrorMessage(updateErr) } });

        let subDescription = 'Membership activation';
        try {
          const userTier = await db.execute(sql`SELECT t.name AS tier_name FROM users u JOIN membership_tiers t ON u.membership_tier = t.id WHERE u.id = ${userId}`);
          if (userTier.rows[0]?.tier_name) {
            subDescription = `Membership activation - ${userTier.rows[0].tier_name}`;
          }
        } catch (_) { /* use default description */ }

        paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: invoice.currency || 'usd',
          customer: customerId,
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          setup_future_usage: 'off_session',
          description: subDescription,
          ...(email ? { receipt_email: email } : {}),
          metadata: {
            subscriptionId,
            invoiceId: invoice.id,
            invoiceAmountDue: String(amount),
            userId: userId || '',
            email: email || '',
            paymentType: 'subscription_terminal',
            source: 'terminal',
            readerId,
            readerLabel,
            fallback: 'true',
            requiresInvoiceReconciliation: 'true',
            originalPaymentIntentId: invoicePI.id,
          }
        }, {
          idempotencyKey: `terminal_sub_fallback_${subscriptionId}_${invoice.id}`
        });
        logger.info('[Terminal] Created fallback PI for subscription terminal payment', { extra: { newPiId: paymentIntent.id, originalPiId: invoicePI.id, subscriptionId } });
      }
    } else {
      logger.warn('[Terminal] No invoice PI found for subscription, creating terminal PI linked to invoice', { extra: { subscriptionId } });
      let readerLabel = readerId;
      try {
        const readerObj = await stripe.terminal.readers.retrieve(readerId);
        readerLabel = readerObj.label || readerId;
      } catch (_) { /* use readerId as fallback label */ }

      let subDescription = 'Membership activation';
      try {
        const userTier = await db.execute(sql`SELECT t.name AS tier_name FROM users u JOIN membership_tiers t ON u.membership_tier = t.id WHERE u.id = ${userId}`);
        if (userTier.rows[0]?.tier_name) {
          subDescription = `Membership activation - ${userTier.rows[0].tier_name}`;
        }
      } catch (_) { /* use default description */ }

      paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: invoice.currency || 'usd',
        customer: customerId,
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        setup_future_usage: 'off_session',
        description: subDescription,
        ...(email ? { receipt_email: email } : {}),
        metadata: {
          subscriptionId,
          invoiceId: invoice.id,
          invoiceAmountDue: String(amount),
          userId: userId || '',
          email: email || '',
          paymentType: 'subscription_terminal',
          source: 'terminal',
          readerId,
          readerLabel: readerId,
          fallback: 'true',
          requiresInvoiceReconciliation: 'true'
        }
      }, {
        idempotencyKey: `terminal_sub_${subscriptionId}_${invoice.id}`
      });
      logger.info('[Terminal] Created PI for subscription - will reconcile invoice after payment succeeds', { extra: { paymentIntentId: paymentIntent.id, subscriptionId } });
    }
    
    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntent.id
    });
    
    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: unknown) {
        logger.error('[Terminal] Simulated card presentation error (non-blocking)', { extra: { simErr: getErrorMessage(simErr) } });
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
    logger.error('[Terminal] Error processing subscription payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to process subscription payment' });
  }
});

router.post('/api/stripe/terminal/confirm-subscription-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, subscriptionId, userId, invoiceId } = req.body;
    
    if (!paymentIntentId || !subscriptionId || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (paymentIntentId.startsWith('seti_') || paymentIntentId.startsWith('free_')) {
      return res.json({ success: true, message: '$0 subscription — no payment confirmation needed' });
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
          await stripe.refunds.create({ payment_intent: paymentIntentId, reason: 'requested_by_customer' }, {
            idempotencyKey: `refund_terminal_activation_${paymentIntentId}`
          });
          autoRefunded = true;
          logger.error('[Terminal] Auto-refunded PI - user not found during activation', { extra: { paymentIntentId, userId } });
        } else {
          logger.error('[Terminal] Cannot refund PI in status "" - user not found', { extra: { paymentIntentId, piStatus: pi.status, userId } });
        }
      } catch (refundErr: unknown) {
        logger.error('[Terminal] CRITICAL: Failed to auto-refund PI  for missing user', { extra: { paymentIntentId, userId, error: getErrorMessage(refundErr) } });
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
    const latestInvoice = subscription.latest_invoice as Stripe.Invoice;
    const actualInvoiceId = latestInvoice?.id || invoiceId;
    
    if (latestInvoice) {
      const expectedAmount = latestInvoice.status === 'paid' 
        ? latestInvoice.amount_paid 
        : latestInvoice.amount_due;
      
      if (paymentIntent.amount !== expectedAmount) {
        logger.error('[Terminal] Amount mismatch: PI = $, invoice = $', { extra: { paymentIntentId, paymentIntentAmount_100_ToFixed_2: (paymentIntent.amount / 100).toFixed(2), actualInvoiceId, expectedAmount_100_ToFixed_2: (expectedAmount / 100).toFixed(2) } });
        return res.status(400).json({ 
          error: 'Payment amount mismatch',
          details: `Payment was $${(paymentIntent.amount / 100).toFixed(2)} but invoice ${latestInvoice.status === 'paid' ? 'was paid for' : 'requires'} $${(expectedAmount / 100).toFixed(2)}`,
          paymentAmount: paymentIntent.amount,
          invoiceAmount: expectedAmount,
          invoiceStatus: latestInvoice.status
        });
      }
    }
    
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || '';
    
    if (piMetadata.requiresInvoiceReconciliation === 'true' && latestInvoice && latestInvoice.status !== 'paid') {
      try {
        if (latestInvoice.status === 'open') {
          const invoicePiId = typeof latestInvoice.payment_intent === 'string'
            ? latestInvoice.payment_intent
            : (typeof latestInvoice.payment_intent === 'object' && latestInvoice.payment_intent !== null) ? (latestInvoice.payment_intent as Stripe.PaymentIntent).id : null;
          if (invoicePiId) {
            try {
              await stripe.paymentIntents.cancel(invoicePiId);
              logger.info('[Terminal] Cancelled invoice-generated PI before paying with terminal PI', { extra: { invoicePiId, actualInvoiceId } });
            } catch (cancelErr: unknown) {
              logger.warn('[Terminal] Could not cancel invoice PI (may already be cancelled)', { extra: { invoicePiId, error: getErrorMessage(cancelErr) } });
            }
          }
          await stripe.invoices.pay(actualInvoiceId, {
            paid_out_of_band: true
          });
          logger.info('[Terminal] Reconciled subscription invoice after terminal payment', { extra: { actualInvoiceId, paymentIntentId } });
        } else {
          logger.info('[Terminal] Invoice not in open state, skipping reconciliation', { extra: { actualInvoiceId, status: latestInvoice.status } });
        }
      } catch (invoicePayErr: unknown) {
        logger.error('[Terminal] Failed to reconcile invoice after terminal payment', { extra: { actualInvoiceId, error: getErrorMessage(invoicePayErr) } });
      }
    }
    
    const existingPaymentRecord = await db.select().from(terminalPayments)
      .where(eq(terminalPayments.stripePaymentIntentId, paymentIntentId));
    
    if (existingPaymentRecord.length === 0) {
      const staffEmail = getSessionUser(req)?.email || 'unknown';
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
      logger.info('[Terminal] Payment record created for PI', { extra: { paymentIntentId } });
    }
    
    let cardSaved = false;
    let cardSaveWarning: string | null = null;
    if (paymentIntent.payment_method) {
      try {
        const pm = await stripe.paymentMethods.retrieve(paymentIntent.payment_method as string);
        let reusablePaymentMethodId: string | null = null;

        if (pm.type === 'card_present') {
          const latestCharge = paymentIntent.latest_charge as Stripe.Charge | null;
          const generatedCard = latestCharge?.payment_method_details?.card_present?.generated_card;

          if (generatedCard) {
            reusablePaymentMethodId = generatedCard;
            logger.info('[Terminal] Found generated_card from card_present payment', { extra: { generatedCard } });
          } else {
            cardSaveWarning = 'No reusable card was generated from this terminal payment. The member will need to add a payment method manually, or their next renewal will fail.';
            logger.warn('[Terminal] (PI: )', { extra: { cardSaveWarning, paymentIntentId } });
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
          logger.info('[Terminal] Saved payment method as default for customer and subscription', { extra: { reusablePaymentMethodId, customerId, subscriptionId } });
        }
      } catch (attachError: unknown) {
        cardSaveWarning = `Failed to save payment method for future billing: ${getErrorMessage(attachError)}. The member may need to add a card manually.`;
        logger.error('[Terminal]', { extra: { cardSaveWarning } });
      }
    } else {
      cardSaveWarning = 'No payment method found on the PaymentIntent. The member will need to add a payment method manually for future billing.';
      logger.warn('[Terminal] (PI: )', { extra: { cardSaveWarning, paymentIntentId } });
    }
    
    if (existingUser?.membershipStatus === 'active') {
      logger.info('[Terminal] User already active, payment record ensured, card save attempted, returning early', { extra: { userId } });
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
      } catch (hubspotError: unknown) {
        logger.error('[Terminal] HubSpot sync error (non-blocking)', { extra: { hubspotError } });
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
      paymentIntentId,
      cardSaved,
      cardSaveWarning
    });
  } catch (error: unknown) {
    logger.error('[Terminal] Error confirming subscription payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to confirm subscription payment' });
  }
});

router.post('/api/stripe/terminal/refund-payment', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment Intent ID is required' });
    }
    if (paymentIntentId.startsWith('seti_') || paymentIntentId.startsWith('free_')) {
      return res.json({ success: true, message: 'No refund needed — $0 subscription' });
    }
    
    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `Cannot refund payment in "${paymentIntent.status}" state` });
    }
    
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer'
    }, {
      idempotencyKey: `refund_terminal_${paymentIntentId}`
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
    
    logger.info('[Terminal] Auto-refunded PI , refund', { extra: { paymentIntentId, refundId: refund.id } });
    
    res.json({ success: true, refundId: refund.id });
  } catch (error: unknown) {
    logger.error('[Terminal] Error refunding payment', { error: error instanceof Error ? error : new Error(String(error)) });
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
    if (paymentIntentId.startsWith('seti_')) {
      return res.status(400).json({ error: 'Cannot process a SetupIntent as a payment. This is a $0 subscription — no payment is needed.' });
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
    } catch (e: unknown) { /* reader label is cosmetic, ignore */ }

    const updateParams: Stripe.PaymentIntentUpdateParams = {
      payment_method_types: ['card_present'],
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

    let terminalPiId = paymentIntentId;
    try {
      await stripe.paymentIntents.update(paymentIntentId, updateParams);
    } catch (updateErr: unknown) {
      const errMsg = getErrorMessage(updateErr);
      logger.info('[Terminal] Cannot update existing PI for terminal, creating new card_present PI:', { extra: { error: errMsg } });

      const customerId = typeof paymentIntent.customer === 'string'
        ? paymentIntent.customer
        : paymentIntent.customer?.id || null;

      if (!customerId) {
        return res.status(400).json({ error: 'Payment Intent has no customer — cannot create terminal payment' });
      }

      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
        logger.info('[Terminal] Cancelled original PI to create terminal-compatible PI', { extra: { originalPiId: paymentIntentId } });
      } catch (cancelErr: unknown) {
        logger.warn('[Terminal] Could not cancel original PI (may already be cancelled)', { extra: { error: getErrorMessage(cancelErr) } });
      }

      const newPi = await stripe.paymentIntents.create({
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        customer: customerId,
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        setup_future_usage: 'off_session',
        description: paymentIntent.description || 'Terminal payment',
        metadata: {
          ...paymentIntent.metadata,
          readerId,
          readerLabel,
          terminalPayment: 'true',
          originalPaymentIntentId: paymentIntentId,
        },
      });
      terminalPiId = newPi.id;
      logger.info('[Terminal] Created new card_present PI for terminal', { extra: { newPiId: newPi.id, originalPiId: paymentIntentId } });
    }

    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: terminalPiId
    });

    if (reader.device_type?.startsWith('simulated')) {
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      } catch (simErr: unknown) {
        logger.error('[Terminal] Simulated card presentation error (non-blocking)', { extra: { simErr: getErrorMessage(simErr) } });
      }
    }

    await logFromRequest(req, {
      action: 'terminal_existing_payment_routed',
      resourceType: 'payment',
      resourceId: terminalPiId,
      details: {
        paymentIntentId: terminalPiId,
        originalPaymentIntentId: terminalPiId !== paymentIntentId ? paymentIntentId : undefined,
        readerId,
        originalStatus: paymentIntent.status,
        amount: paymentIntent.amount
      }
    });

    res.json({
      success: true,
      paymentIntentId: terminalPiId,
      readerId: reader.id,
      readerAction: reader.action
    });
  } catch (error: unknown) {
    logger.error('[Terminal] Error processing existing payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to process existing payment on terminal' });
  }
});

router.post('/api/stripe/terminal/save-card', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { readerId, customerId, email: rawEmail, userId } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();

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
        logger.error('[Terminal] Simulated card presentation error (non-blocking)', { extra: { simErr: getErrorMessage(simErr) } });
      }
    }

    await logFromRequest(req, {
      action: 'terminal_save_card_initiated',
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
    logger.error('[Terminal] Error initiating save card', { error: error instanceof Error ? error : new Error(String(error)) });
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
    logger.error('[Terminal] Error checking setup status', { error: error instanceof Error ? error : new Error(String(error)) });
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

    if (pm.type === 'card_present' && (pm.card_present as any)?.generated_card) {
      reusablePaymentMethodId = (pm.card_present as any).generated_card;
      logger.info('[Terminal] Found generated_card from SetupIntent card_present', { extra: { reusablePaymentMethodId } });
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
      action: 'terminal_card_saved',
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

    try {
      const memberCheck = await db.execute(sql`SELECT email, billing_provider, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS display_name FROM users WHERE stripe_customer_id = ${customerId} LIMIT 1`);
      if (memberCheck.rows.length > 0) {
        const member = memberCheck.rows[0] as { email: string; billing_provider: string | null; display_name: string };
        if (member.billing_provider === 'mindbody') {
          const { notifyAllStaff } = await import('../../core/notificationService');
          await notifyAllStaff(
            'MindBody Member Card Saved',
            `MindBody member ${member.display_name} now has a card on file — eligible for Stripe migration`,
            'billing_migration'
          );
          logger.info('[Terminal] Notified staff: MindBody member card saved via terminal', { extra: { email: member.email } });
        }
      }
    } catch (migrationNotifyErr: unknown) {
      logger.warn('[Terminal] Could not check/notify for MindBody migration eligibility (non-blocking)', { extra: { error: getErrorMessage(migrationNotifyErr) } });
    }

    res.json({
      success: true,
      cardSaved: true,
      paymentMethodId
    });
  } catch (error: unknown) {
    logger.error('[Terminal] Error confirming save card', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to confirm save card' });
  }
});

export default router;
