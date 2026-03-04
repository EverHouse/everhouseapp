import { randomUUID } from 'crypto';
import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getStripeClient } from '../../core/stripe/client';
import { isPlaceholderEmail, listCustomerPaymentMethods } from '../../core/stripe/customers';
import { findOrCreateHubSpotContact } from '../../core/hubspot/members';
import {
  createPaymentIntent,
  confirmPaymentSuccess,
  getOrCreateStripeCustomer,
  createInvoiceWithLineItems,
  type CartLineItem,
} from '../../core/stripe';
import {
  getPaymentByIntentId,
} from '../../core/stripe/paymentRepository';
import { logFromRequest, logBillingAudit } from '../../core/auditLog';
import { sendPurchaseReceipt, PurchaseReceiptItem } from '../../emails/paymentEmails';
import { getStaffInfo, GUEST_FEE_CENTS, SAVED_CARD_APPROVAL_THRESHOLD_CENTS } from './helpers';
import { broadcastBillingUpdate } from '../../core/websocket';
import { alertOnExternalServiceError } from '../../core/errorAlerts';
import { getErrorMessage, getErrorCode, safeErrorDetail } from '../../utils/errorUtils';
import { normalizeTierName } from '../../utils/tierUtils';
import { validateBody } from '../../middleware/validate';
import { quickChargeSchema, confirmQuickChargeSchema, attachEmailSchema, chargeSavedCardPosSchema, sendReceiptSchema, chargeSubscriptionInvoiceSchema } from '../../../shared/validators/payments';

interface DbMemberRow {
  id: string;
  email: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  stripe_customer_id?: string;
  hubspot_id?: string;
  membership_tier?: string;
  membership_status?: string;
  tier?: string;
  membership_minutes?: number;
  billing_provider?: string;
}

interface DbBalanceRow {
  participant_id: number;
  session_id: number;
  session_date: string;
  resource_name: string;
  cached_fee_cents: number;
  ledger_fee: string;
  participant_type: string;
}

interface StripeError extends Error {
  type?: string;
  decline_code?: string;
  code?: string;
}

const router = Router();

router.post('/api/stripe/staff/quick-charge', isStaffOrAdmin, validateBody(quickChargeSchema), async (req: Request, res: Response) => {
  try {
    const { memberEmail: rawEmail, memberName, amountCents, description, productId, isNewCustomer, firstName, lastName, phone, dob, tierSlug, tierName, createUser, streetAddress, city, state, zipCode, cartItems, guestCheckout } = req.body;
    const memberEmail = rawEmail?.trim()?.toLowerCase();
    const { sessionUser, staffEmail } = getStaffInfo(req);

    if (!guestCheckout && !memberEmail) {
      return res.status(400).json({ error: 'Missing required fields: memberEmail, amountCents' });
    }

    if (guestCheckout) {
      const finalDescription = description || 'Guest POS sale';
      const stripe = await getStripeClient();

      const guestMetadata: Record<string, string> = {
        staffInitiated: 'true',
        staffEmail: staffEmail,
        chargeType: 'guest_pos_sale',
        guestCheckout: 'true',
        source: 'pos_guest_checkout',
      };
      if (productId) guestMetadata.productId = productId;

      let finalProductName: string | undefined;
      if (productId) {
        try {
          const product = await stripe.products.retrieve(productId);
          finalProductName = product.name;
          if (product.name) guestMetadata.productName = product.name;
        } catch (productError: unknown) {
          logger.warn('[Stripe] Could not retrieve product for guest checkout', { extra: { productId, error: getErrorMessage(productError) } });
        }
      }

      if (Array.isArray(cartItems) && cartItems.length > 0) {
        const itemNames = cartItems.map((item: { name?: string; quantity?: number }) =>
          item.quantity && item.quantity > 1 ? `${item.name || 'Item'} x${item.quantity}` : (item.name || 'Item')
        ).join(', ');
        guestMetadata.items = itemNames.substring(0, 490);
      }

      const numericAmount = Number(amountCents);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(numericAmount),
        currency: 'usd',
        description: finalDescription,
        metadata: guestMetadata,
        payment_method_types: ['card_present', 'card'],
      }, {
        idempotencyKey: `guest_pos_${staffEmail}_${numericAmount}_${Date.now()}`
      });

      try {
        await db.execute(sql`INSERT INTO stripe_payment_intents 
           (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, product_id, product_name)
           VALUES (${'guest-pos-' + Date.now()}, ${paymentIntent.id}, ${null}, ${Math.round(numericAmount)}, 'one_time_purchase', ${finalDescription}, 'pending', ${productId || null}, ${finalProductName || null})
           ON CONFLICT (stripe_payment_intent_id) DO NOTHING`);
      } catch (dbErr: unknown) {
        logger.warn('[GuestCheckout] Non-blocking: Could not save local payment record', { extra: { dbErr: getErrorMessage(dbErr) } });
      }

      logFromRequest(req, 'initiate_charge', 'payment', paymentIntent.id, 'guest-checkout', {
        amountCents: numericAmount,
        description: finalDescription,
        productId: productId || null,
        productName: finalProductName || null,
        source: 'pos_guest_checkout'
      });

      logger.info('[Stripe] Guest checkout PaymentIntent created', { extra: { paymentIntentId: paymentIntent.id, amount: numericAmount } });

      return res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        guestCheckout: true
      });
    }
    
    if (isPlaceholderEmail(memberEmail)) {
      return res.status(400).json({ error: 'Cannot charge placeholder emails. Please use a real email address.' });
    }

    let member: { id: string; email: string; first_name?: string; last_name?: string; stripe_customer_id?: string } | null = null;
    let resolvedName: string;
    let stripeCustomerId: string | undefined;

    if (isNewCustomer) {
      if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First name and last name are required for new customers' });
      }
      
      resolvedName = `${firstName} ${lastName}`.trim();
      
      const { resolveUserByEmail, getOrCreateStripeCustomer: getOrCreateCust } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(memberEmail);
      if (resolved) {
        const custResult = await getOrCreateCust(resolved.userId, memberEmail, resolvedName);
        stripeCustomerId = custResult.customerId;
        logger.info('[Stripe] customer for quick charge', { extra: { custResultIsNew_Created_Found_existing: custResult.isNew ? 'Created' : 'Found existing', stripeCustomerId, memberEmail } });
      } else {
        const custResult = await getOrCreateCust(memberEmail, memberEmail, resolvedName);
        stripeCustomerId = custResult.customerId;
        logger.info('[Stripe] customer for quick charge', { extra: { custResultIsNew_Created_Found_existing: custResult.isNew ? 'Created' : 'Found existing', stripeCustomerId, memberEmail } });

        try {
          const existingUser = await db.execute(sql`SELECT id, stripe_customer_id, archived_at FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);
          if (existingUser.rows.length === 0) {
            const visitorExclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${memberEmail.toLowerCase()}`);
            if (visitorExclusionCheck.rows.length > 0) {
              logger.warn('[QuickCharge] Skipping visitor creation for permanently deleted member', { extra: { memberEmail } });
            } else {
              const crypto = await import('crypto');
              const visitorId = crypto.randomUUID();
              await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, membership_status, stripe_customer_id, data_source, visitor_type, role, street_address, city, state, zip_code, created_at, updated_at)
                 VALUES (${visitorId}, ${memberEmail}, ${firstName}, ${lastName}, 'visitor', ${stripeCustomerId}, 'APP', 'day_pass', 'visitor', ${streetAddress || null}, ${city || null}, ${state || null}, ${zipCode || null}, NOW(), NOW())
                 ON CONFLICT (email) DO UPDATE SET
                   stripe_customer_id = COALESCE(users.stripe_customer_id, EXCLUDED.stripe_customer_id),
                   first_name = COALESCE(NULLIF(users.first_name, ''), EXCLUDED.first_name),
                   last_name = COALESCE(NULLIF(users.last_name, ''), EXCLUDED.last_name),
                   street_address = COALESCE(NULLIF(EXCLUDED.street_address, ''), users.street_address),
                   city = COALESCE(NULLIF(EXCLUDED.city, ''), users.city),
                   state = COALESCE(NULLIF(EXCLUDED.state, ''), users.state),
                   zip_code = COALESCE(NULLIF(EXCLUDED.zip_code, ''), users.zip_code),
                   archived_at = NULL,
                   archived_by = NULL,
                   updated_at = NOW()`);
              logger.info('[QuickCharge] Created visitor record for new customer', { extra: { memberEmail } });
              findOrCreateHubSpotContact(memberEmail, firstName, lastName, undefined, undefined, { role: 'visitor' }).catch((err) => {
                logger.error('[QuickCharge] Background HubSpot sync for visitor failed', { error: err instanceof Error ? err : new Error(String(err)) });
              });
            }
          } else if (!existingUser.rows[0].stripe_customer_id) {
            await db.execute(sql`UPDATE users SET stripe_customer_id = ${stripeCustomerId}, archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${existingUser.rows[0].id}`);
            if (existingUser.rows[0].archived_at) {
              logger.info('[Auto-Unarchive] User unarchived after receiving Stripe customer ID', { extra: { memberEmail } });
            }
            logger.info('[QuickCharge] Linked Stripe customer to existing user', { extra: { stripeCustomerId, memberEmail } });
          }
        } catch (visitorErr: unknown) {
          logger.warn('[QuickCharge] Could not create visitor record (non-blocking)', { extra: { visitorErr: getErrorMessage(visitorErr) } });
        }
      }
      
    } else {
      const memberResult = await db.execute(sql`SELECT id, email, first_name, last_name, stripe_customer_id 
         FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

      if (memberResult.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found in database. Use "Charge someone not in the system" to add a new customer.' });
      }

      member = memberResult.rows[0] as unknown as DbMemberRow;
      resolvedName = memberName || [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email.split('@')[0];
      stripeCustomerId = member.stripe_customer_id;
    }

    let finalProductName: string | undefined;
    let finalDescription = description || 'Staff quick charge';

    const customerEmail = member?.email || memberEmail;
    const numericAmount = Number(amountCents);
    
    if (!productId) {
      logger.warn('[Stripe] Quick charge for without productId - purchase reporting will be generic.', { extra: { customerEmail } });
      if (!description) {
        finalDescription = 'Staff quick charge (no product specified)';
      }
    }

    if (productId) {
      try {
        const stripe = await getStripeClient();
        const product = await stripe.products.retrieve(productId);
        
        finalProductName = product.name;
        if (product.name && !description) {
          finalDescription = `Quick charge - ${product.name}`;
        }
        
        logger.info('[Stripe] Quick charge with product: ()', { extra: { productId, productName: product.name } });
      } catch (productError: unknown) {
        logger.error('[Stripe] Warning: Could not retrieve product', { extra: { productId, error: getErrorMessage(productError) } });
        return res.status(400).json({ error: `Product ${productId} not found in Stripe` });
      }
    }

    if (Array.isArray(cartItems) && cartItems.length > 0 && stripeCustomerId) {
      try {
        const invoiceResult = await createInvoiceWithLineItems({
          customerId: stripeCustomerId,
          description: finalDescription,
          cartItems: cartItems as CartLineItem[],
          metadata: {
            staffInitiated: 'true',
            staffEmail: staffEmail,
            chargeType: 'quick_charge',
            memberId: member?.id?.toString() || 'guest',
            memberEmail: customerEmail,
            memberName: resolvedName,
            isNewCustomer: isNewCustomer ? 'true' : 'false',
          },
          receiptEmail: customerEmail
        });

        const dbUserId = member?.id?.toString() || `guest-${stripeCustomerId}`;
        try {
          await db.execute(sql`INSERT INTO stripe_payment_intents 
             (user_id, stripe_payment_intent_id, stripe_customer_id, amount_cents, purpose, description, status, product_id, product_name)
             VALUES (${dbUserId}, ${invoiceResult.paymentIntentId}, ${stripeCustomerId}, ${Math.round(numericAmount)}, 'one_time_purchase', ${finalDescription}, 'pending', ${productId || null}, ${finalProductName || null})
             ON CONFLICT (stripe_payment_intent_id) DO NOTHING`);
        } catch (dbErr: unknown) {
          logger.warn('[QuickCharge] Non-blocking: Could not save local payment record', { extra: { dbErr: getErrorMessage(dbErr) } });
        }

        logFromRequest(req, 'initiate_charge', 'payment', invoiceResult.paymentIntentId, customerEmail, {
          amountCents: numericAmount,
          description: finalDescription,
          invoiceId: invoiceResult.invoiceId,
          productId: productId || null,
          productName: finalProductName || null,
          isNewCustomer: !!isNewCustomer,
          source: 'pos_quick_charge_invoice'
        });

        return res.json({
          clientSecret: invoiceResult.clientSecret,
          paymentIntentId: invoiceResult.paymentIntentId
        });
      } catch (invoiceErr: unknown) {
        logger.error('[QuickCharge] Invoice creation failed, falling back to bare PI', { extra: { invoiceErr: getErrorMessage(invoiceErr) } });
      }
    }

    const result = await createPaymentIntent({
      userId: member?.id?.toString() || 'guest',
      email: customerEmail,
      memberName: resolvedName,
      amountCents: Math.round(numericAmount),
      purpose: 'one_time_purchase',
      description: finalDescription,
      productId,
      productName: finalProductName,
      stripeCustomerId,
      metadata: {
        staffInitiated: 'true',
        staffEmail: staffEmail,
        chargeType: 'quick_charge',
        memberId: member?.id?.toString() || 'guest',
        memberEmail: customerEmail,
        memberName: resolvedName,
        isNewCustomer: isNewCustomer ? 'true' : 'false',
        createUser: createUser ? 'true' : 'false',
        tierSlug: tierSlug || '',
        tierName: tierName || '',
        firstName: firstName || '',
        lastName: lastName || '',
        phone: phone || '',
        dob: dob || ''
      }
    });

    logFromRequest(req, 'initiate_charge', 'payment', result.paymentIntentId, customerEmail, {
      amountCents: numericAmount,
      description: finalDescription,
      productId: productId || null,
      productName: finalProductName || null,
      isNewCustomer: !!isNewCustomer,
      source: 'pos_quick_charge'
    });

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating quick charge', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'create quick charge');
    res.status(500).json({ 
      error: 'Payment processing failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/stripe/staff/quick-charge/confirm', isStaffOrAdmin, validateBody(confirmQuickChargeSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;
    const { staffEmail, staffName } = getStaffInfo(req);

    const result = await confirmPaymentSuccess(
      paymentIntentId,
      staffEmail,
      staffName
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Payment confirmation failed' });
    }

    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const metadata = paymentIntent.metadata || {};
    
    if (metadata.createUser === 'true' && metadata.tierSlug && metadata.memberEmail) {
      const tierSlug = metadata.tierSlug;
      const tierName = metadata.tierName || tierSlug;
      const memberEmail = metadata.memberEmail;
      const firstName = metadata.firstName || '';
      const lastName = metadata.lastName || '';
      const phone = metadata.phone || null;
      const dob = metadata.dob || null;
      const stripeCustomerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id;
      
      const tierResult = await db.execute(sql`SELECT name FROM membership_tiers WHERE slug = ${tierSlug} OR name = ${tierSlug}`);
      const validatedTierName = (tierResult.rows[0] as { name: string } | undefined)?.name || normalizeTierName(tierName);
      
      const { resolveUserByEmail } = await import('../../core/stripe/customers');
      const resolved = await resolveUserByEmail(memberEmail);
      if (resolved) {
        await db.execute(sql`UPDATE users SET tier = ${validatedTierName}, billing_provider = 'stripe', stripe_customer_id = COALESCE(${stripeCustomerId}, stripe_customer_id)
           WHERE id = ${resolved.userId}`);
        logger.info('[Stripe] Updated user with tier after payment confirmation (matched via )', { extra: { resolvedPrimaryEmail: resolved.primaryEmail, validatedTierName, resolvedMatchType: resolved.matchType } });
      } else {
        const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${memberEmail.toLowerCase()}`);
        if (exclusionCheck.rows.length > 0) {
          logger.warn('[Stripe] Skipping user creation for permanently deleted member after payment', { extra: { memberEmail } });
        } else {
          const userId = require('crypto').randomUUID();
          await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, phone, date_of_birth, tier, membership_status, billing_provider, stripe_customer_id, created_at)
             VALUES (${userId}, ${memberEmail.toLowerCase()}, ${firstName}, ${lastName}, ${phone}, ${dob}, ${validatedTierName}, 'inactive', 'stripe', ${stripeCustomerId || null}, NOW())`);
          logger.info('[Stripe] Created user with tier after payment confirmation', { extra: { memberEmail, validatedTierName } });
        }
      }

      if (metadata.createUser === 'true' && metadata.memberEmail) {
        findOrCreateHubSpotContact(
          metadata.memberEmail.toLowerCase(),
          metadata.firstName || '',
          metadata.lastName || '',
          metadata.phone || undefined
        ).catch((err) => {
          logger.error('[Stripe] Background HubSpot sync after payment confirmation failed', { error: err instanceof Error ? err : new Error(String(err)) });
        });
      }
    }

    const paymentRecord = await getPaymentByIntentId(paymentIntentId);
    
    broadcastBillingUpdate({
      action: 'payment_succeeded',
      memberEmail: (paymentRecord?.memberEmail || paymentRecord?.member_email) || undefined,
      amount: paymentRecord?.amountCents || paymentRecord?.amount_cents
    });

    logger.info('[Stripe] Quick charge confirmed: by', { extra: { paymentIntentId, staffEmail } });
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error confirming quick charge', { error: error instanceof Error ? error : new Error(String(error)) });
    await alertOnExternalServiceError('Stripe', error as Error, 'confirm quick charge');
    res.status(500).json({ 
      error: 'Payment confirmation failed. Please try again.',
      retryable: true
    });
  }
});

router.post('/api/stripe/staff/quick-charge/attach-email', isStaffOrAdmin, validateBody(attachEmailSchema), async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, email: rawEmail } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    const { staffEmail } = getStaffInfo(req);

    if (isPlaceholderEmail(email)) {
      return res.status(400).json({ error: 'Cannot attach placeholder emails' });
    }

    const stripe = await getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (!paymentIntent) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const { resolveUserByEmail, getOrCreateStripeCustomer } = await import('../../core/stripe/customers');
    const resolved = await resolveUserByEmail(email);
    let stripeCustomerId: string;
    let userId: string | null = null;

    if (resolved) {
      const custResult = await getOrCreateStripeCustomer(resolved.userId, email, email.split('@')[0]);
      stripeCustomerId = custResult.customerId;
      userId = resolved.userId;
    } else {
      const custResult = await getOrCreateStripeCustomer(email, email, email.split('@')[0]);
      stripeCustomerId = custResult.customerId;

      try {
        const existingUser = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${email})`);
        if (existingUser.rows.length > 0) {
          userId = (existingUser.rows[0] as { id: string }).id;
          await db.execute(sql`UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ${stripeCustomerId}), updated_at = NOW() WHERE id = ${userId}`);
        } else {
          const exclusionCheck = await db.execute(sql`SELECT 1 FROM sync_exclusions WHERE email = ${email}`);
          if (exclusionCheck.rows.length === 0) {
            const crypto = await import('crypto');
            userId = crypto.randomUUID();
            await db.execute(sql`INSERT INTO users (id, email, membership_status, stripe_customer_id, data_source, visitor_type, role, created_at, updated_at)
               VALUES (${userId}, ${email}, 'visitor', ${stripeCustomerId}, 'APP', 'day_pass', 'visitor', NOW(), NOW())
               ON CONFLICT (email) DO UPDATE SET
                 stripe_customer_id = COALESCE(users.stripe_customer_id, EXCLUDED.stripe_customer_id),
                 updated_at = NOW()`);
            logger.info('[AttachEmail] Created visitor record for guest checkout', { extra: { email } });

            findOrCreateHubSpotContact(email, '', '', undefined, undefined, { role: 'visitor' }).catch((err) => {
              logger.error('[AttachEmail] Background HubSpot sync failed', { error: err instanceof Error ? err : new Error(String(err)) });
            });
          }
        }
      } catch (visitorErr: unknown) {
        logger.warn('[AttachEmail] Could not create visitor record (non-blocking)', { extra: { visitorErr: getErrorMessage(visitorErr) } });
      }
    }

    try {
      await stripe.paymentIntents.update(paymentIntentId, {
        customer: stripeCustomerId,
        receipt_email: email,
        metadata: {
          ...paymentIntent.metadata,
          attachedEmail: email,
          attachedBy: staffEmail,
        },
      });
      logger.info('[AttachEmail] Attached customer to PaymentIntent', { extra: { paymentIntentId, email, stripeCustomerId } });
    } catch (stripeErr: unknown) {
      logger.warn('[AttachEmail] Could not update PaymentIntent customer (non-blocking)', { extra: { stripeErr: getErrorMessage(stripeErr) } });
    }

    try {
      await db.execute(sql`UPDATE stripe_payment_intents 
         SET stripe_customer_id = ${stripeCustomerId}, 
             user_id = COALESCE(${userId}, user_id),
             updated_at = NOW()
         WHERE stripe_payment_intent_id = ${paymentIntentId}`);
    } catch (dbErr: unknown) {
      logger.warn('[AttachEmail] Could not update local payment record (non-blocking)', { extra: { dbErr: getErrorMessage(dbErr) } });
    }

    logFromRequest(req, 'attach_email_to_payment', 'payment', paymentIntentId, email, {
      stripeCustomerId,
      source: 'pos_guest_checkout'
    });

    res.json({ success: true, stripeCustomerId });
  } catch (error: unknown) {
    logger.error('[Stripe] Error attaching email to payment', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to attach email to payment' });
  }
});

router.post('/api/stripe/staff/charge-saved-card-pos', isStaffOrAdmin, validateBody(chargeSavedCardPosSchema), async (req: Request, res: Response) => {
  try {
    const { memberEmail: rawEmail, memberName, amountCents, description, productId, cartItems } = req.body;
    const memberEmail = rawEmail?.trim()?.toLowerCase();
    const { staffEmail, staffName, sessionUser } = getStaffInfo(req);

    const numericAmount = Number(amountCents);

    if (numericAmount >= SAVED_CARD_APPROVAL_THRESHOLD_CENTS) {
      if (sessionUser?.role !== 'admin') {
        return res.status(403).json({
          error: 'Charges above $500 require manager approval. Please ask an admin to process this charge.',
          requiresApproval: true,
          thresholdCents: SAVED_CARD_APPROVAL_THRESHOLD_CENTS
        });
      }
      logFromRequest(req, 'large_charge_approved', 'payment', undefined, memberEmail, {
        amountCents: numericAmount,
        approvedBy: staffEmail,
        role: 'admin',
        chargeType: 'saved_card_pos'
      });
    }

    const memberResult = await db.execute(sql`SELECT id, email, name, first_name, last_name, stripe_customer_id 
       FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberResult.rows[0] as unknown as DbMemberRow;
    const resolvedName = memberName || [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;

    if (!member.stripe_customer_id) {
      return res.status(400).json({
        error: 'Customer does not have a Stripe account yet. Use Online Card instead.',
        noStripeCustomer: true
      });
    }

    const stripe = await getStripeClient();

    const paymentMethods = await listCustomerPaymentMethods(member.stripe_customer_id);

    if (paymentMethods.length === 0) {
      return res.status(400).json({
        error: 'No saved card on file. Use Online Card instead.',
        noSavedCard: true
      });
    }

    const paymentMethod = paymentMethods[0];
    const cardLast4 = paymentMethod.last4 || '****';
    const cardBrand = paymentMethod.brand || 'card';

    if (Array.isArray(cartItems) && cartItems.length > 0) {
      try {
        const invoiceResult = await createInvoiceWithLineItems({
          customerId: member.stripe_customer_id,
          description: description || 'POS purchase',
          cartItems: cartItems as CartLineItem[],
          metadata: {
            type: 'staff_pos_saved_card',
            purpose: 'pos_purchase',
            staffEmail,
            staffName: staffName || staffEmail,
            memberId: member.id?.toString() || '',
            memberEmail: member.email,
            memberName: resolvedName,
            source: 'pos',
          }
        });

        const paymentIntent = await stripe.paymentIntents.confirm(invoiceResult.paymentIntentId, {
          payment_method: paymentMethod.id,
          off_session: true,
        });

        if (paymentIntent.status === 'succeeded') {
          await logBillingAudit({
            memberEmail: member.email,
            actionType: 'pos_saved_card_charge',
            actionDetails: {
              paymentIntentId: paymentIntent.id,
              memberId: member.id,
              amountCents: numericAmount,
              description: description || 'POS saved card charge',
            },
            performedBy: staffEmail,
          });

          logFromRequest(req, 'charge_saved_card', 'payment', paymentIntent.id, member.email, {
            amountCents: numericAmount,
            description: description || 'POS saved card charge',
            invoiceId: invoiceResult.invoiceId,
            cardLast4,
            cardBrand,
            source: 'pos'
          });

          return res.json({
            success: true,
            paymentIntentId: paymentIntent.id,
            cardLast4,
            cardBrand
          });
        } else if (paymentIntent.status === 'requires_action') {
          return res.status(400).json({
            error: 'Card requires additional verification. Use Online Card instead so the customer can authenticate.',
            requiresAction: true
          });
        } else {
          return res.status(400).json({
            error: `Payment not completed (status: ${paymentIntent.status}). Try Online Card instead.`
          });
        }
      } catch (invoiceErr: unknown) {
        logger.error('[Stripe] Invoice creation failed for saved card POS, falling back to bare PI', { extra: { invoiceErr: getErrorMessage(invoiceErr) } });
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: numericAmount,
      currency: 'usd',
      customer: member.stripe_customer_id,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      description: description || 'POS purchase',
      metadata: {
        type: 'staff_pos_saved_card',
        purpose: 'pos_purchase',
        staffEmail,
        staffName: staffName || staffEmail,
        memberId: member.id?.toString() || '',
        memberEmail: member.email,
        memberName: resolvedName,
        source: 'pos',
        productId: productId || ''
      }
    }, {
      idempotencyKey: `pos_saved_card_${member.id}_${numericAmount}_${randomUUID()}`
    });

    if (paymentIntent.status === 'succeeded') {
      await db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO stripe_payment_intents 
            (payment_intent_id, member_email, member_id, amount_cents, status, purpose, description, created_by)
           VALUES (${paymentIntent.id}, ${member.email}, ${member.id}, ${numericAmount}, 'succeeded', 'pos_charge', ${description || 'POS saved card charge'}, ${staffEmail})
           ON CONFLICT (payment_intent_id) DO UPDATE SET status = 'succeeded', updated_at = NOW()`);

        await logBillingAudit({
          memberEmail: member.email,
          actionType: 'pos_saved_card_charge',
          actionDetails: {
            paymentIntentId: paymentIntent.id,
            memberId: member.id,
            amountCents: numericAmount,
            description: description || 'POS saved card charge',
          },
          performedBy: staffEmail,
        });
      });

      logFromRequest(req, 'charge_saved_card', 'payment', paymentIntent.id, member.email, {
        amountCents: numericAmount,
        description: description || 'POS saved card charge',
        cardLast4,
        cardBrand,
        source: 'pos'
      });


      res.json({
        success: true,
        paymentIntentId: paymentIntent.id,
        cardLast4,
        cardBrand
      });
    } else if (paymentIntent.status === 'requires_action') {
      res.status(400).json({
        error: 'Card requires additional verification. Use Online Card instead so the customer can authenticate.',
        requiresAction: true
      });
    } else {
      res.status(400).json({
        error: `Payment not completed (status: ${paymentIntent.status}). Try Online Card instead.`
      });
    }
  } catch (error: unknown) {
    logger.error('[Stripe] Error with POS saved card charge', { error: error instanceof Error ? error : new Error(String(error)) });

    if ((error as StripeError).type === 'StripeCardError') {
      return res.status(400).json({
        error: `Card declined: ${safeErrorDetail(error)}`,
        cardError: true
      });
    }

    await alertOnExternalServiceError('Stripe', error as Error, 'pos saved card charge');
    res.status(500).json({
      error: 'Failed to charge card. Please try another payment method.',
      retryable: true
    });
  }
});

router.get('/api/stripe/staff/check-saved-card/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const memberEmail = decodeURIComponent(req.params.email as string).trim().toLowerCase();

    const { staffEmail } = getStaffInfo(req);
    logFromRequest(req, {
      action: 'staff_view_member_card_info',
      resourceType: 'payment_method',
      resourceId: memberEmail,
      resourceName: memberEmail,
      details: { viewedBy: staffEmail, targetEmail: memberEmail }
    });

    const memberResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);

    if (memberResult.rows.length === 0 || !memberResult.rows[0].stripe_customer_id) {
      return res.json({ hasSavedCard: false });
    }

    const paymentMethods = await listCustomerPaymentMethods((memberResult.rows[0] as { stripe_customer_id: string }).stripe_customer_id);

    if (paymentMethods.length === 0) {
      return res.json({ hasSavedCard: false });
    }

    res.json({ 
      hasSavedCard: true,
      cardLast4: paymentMethods[0].last4,
      cardBrand: paymentMethods[0].brand,
      cardExpMonth: paymentMethods[0].expMonth,
      cardExpYear: paymentMethods[0].expYear
    });
  } catch (error: unknown) {
    if ((error as StripeError)?.code === 'resource_missing') {
      logger.warn('[Stripe] Stale customer ID for — returning hasSavedCard: false', { extra: { reqParamsEmail: req.params.email } });
    } else {
      logger.error('[Stripe] Error checking saved card', { error: error instanceof Error ? error : new Error(String(error)) });
    }
    res.json({ hasSavedCard: false, error: 'Could not check saved card' });
  }
});

router.get('/api/staff/member-balance/:email', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const memberEmail = decodeURIComponent(req.params.email as string).trim().toLowerCase();

    const { staffEmail } = getStaffInfo(req);
    logFromRequest(req, {
      action: 'staff_view_member_balance',
      resourceType: 'balance',
      resourceId: memberEmail,
      resourceName: memberEmail,
      details: { viewedBy: staffEmail, targetEmail: memberEmail }
    });

    const result = await db.execute(sql`SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        bs.session_date,
        r.name as resource_name,
        bp.participant_type,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       LEFT JOIN users pu ON pu.id = bp.user_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email))
       WHERE LOWER(bp.user_id) = ${memberEmail}
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND bp.participant_type IN ('owner', 'member')
       ORDER BY bs.session_date DESC`);

    const guestResult = await db.execute(sql`SELECT 
        bp.id as participant_id,
        bp.session_id,
        bp.cached_fee_cents,
        bs.session_date,
        r.name as resource_name
       FROM booking_participants bp
       JOIN booking_sessions bs ON bs.id = bp.session_id
       LEFT JOIN resources r ON r.id = bs.resource_id
       JOIN booking_participants owner_bp ON owner_bp.session_id = bp.session_id 
         AND owner_bp.participant_type = 'owner'
       WHERE bp.participant_type = 'guest'
         AND (bp.payment_status = 'pending' OR bp.payment_status IS NULL)
         AND LOWER(owner_bp.user_id) = ${memberEmail}
         AND bp.cached_fee_cents > 0`);

    const items: Array<{participantId: number; sessionId: number; sessionDate: string; resourceName: string; amountCents: number; type: string}> = [];

    for (const row of result.rows as unknown as DbBalanceRow[]) {
      let amountCents = 0;
      if (row.cached_fee_cents > 0) {
        amountCents = row.cached_fee_cents;
      } else if (parseFloat(row.ledger_fee) > 0) {
        amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
      }
      if (amountCents > 0) {
        items.push({
          participantId: row.participant_id,
          sessionId: row.session_id,
          sessionDate: row.session_date,
          resourceName: row.resource_name || 'Unknown',
          amountCents,
          type: row.participant_type === 'owner' ? 'overage' : 'member_fee'
        });
      }
    }

    for (const row of guestResult.rows as unknown as DbBalanceRow[]) {
      items.push({
        participantId: row.participant_id,
        sessionId: row.session_id,
        sessionDate: row.session_date,
        resourceName: row.resource_name || 'Unknown',
        amountCents: row.cached_fee_cents || GUEST_FEE_CENTS,
        type: 'guest_fee'
      });
    }

    const totalCents = items.reduce((sum, item) => sum + item.amountCents, 0);

    res.json({ totalCents, items });
  } catch (error: unknown) {
    logger.error('[Staff] Error fetching member balance', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch member balance' });
  }
});


router.post('/api/purchases/send-receipt', isStaffOrAdmin, validateBody(sendReceiptSchema), async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, memberName, items, totalAmount, paymentMethod, paymentIntentId } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();

    const receiptItems: PurchaseReceiptItem[] = items.map((item: { name?: string; quantity?: number; unitPrice?: number; total?: number }) => ({
      name: item.name || 'Unknown Item',
      quantity: item.quantity || 1,
      unitPrice: item.unitPrice || 0,
      total: item.total || 0
    }));

    const result = await sendPurchaseReceipt(email, {
      memberName,
      items: receiptItems,
      totalAmount,
      paymentMethod: paymentMethod || 'card',
      paymentIntentId,
      date: new Date()
    });

    if (result.success) {
      logFromRequest(req, 'send_receipt', 'payment', paymentIntentId || undefined, memberName, {
        email,
        totalAmount,
        itemCount: items.length,
        paymentMethod
      });

      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send receipt' });
    }
  } catch (error: unknown) {
    logger.error('[Purchases] Error sending receipt', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send receipt email' });
  }
});

router.post('/api/stripe/staff/charge-subscription-invoice', isStaffOrAdmin, validateBody(chargeSubscriptionInvoiceSchema), async (req: Request, res: Response) => {
  try {
    const { subscriptionId, userId } = req.body;
    const { staffEmail } = getStaffInfo(req);

    const userResult = await db.execute(sql`SELECT id, email, first_name, last_name, membership_status 
       FROM users WHERE id = ${userId}`);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0] as { id: string; email: string; first_name: string; last_name: string; membership_status: string };
    const userEmail = user.email;

    const stripe = await getStripeClient();

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice', 'customer']
    });

    const invoice = subscription.latest_invoice as Stripe.Invoice;
    if (!invoice) {
      return res.status(400).json({ error: 'No invoice found for this subscription' });
    }

    if (invoice.status !== 'open' && subscription.status !== 'incomplete') {
      return res.status(400).json({ 
        error: `Invoice is not payable. Invoice status: ${invoice.status}, Subscription status: ${subscription.status}` 
      });
    }

    const customer = subscription.customer as Stripe.Customer;
    let paymentMethodId: string | null = null;

    if (customer?.invoice_settings?.default_payment_method) {
      paymentMethodId = typeof customer.invoice_settings.default_payment_method === 'string' 
        ? customer.invoice_settings.default_payment_method 
        : customer.invoice_settings.default_payment_method.id;
    }

    if (!paymentMethodId && typeof customer === 'object' && customer.id) {
      const paymentMethods = await listCustomerPaymentMethods(customer.id);
      if (paymentMethods.length > 0) {
        paymentMethodId = paymentMethods[0].id;
      }
    }

    if (!paymentMethodId) {
      return res.status(400).json({ 
        error: 'No saved card on file. Use the terminal reader or ask the member to update their payment method.',
        noSavedCard: true
      });
    }

    const paidInvoice = await stripe.invoices.pay(invoice.id, {
      payment_method: paymentMethodId
    });

    if (paidInvoice.status === 'paid') {
      await db.execute(sql`UPDATE users SET membership_status = 'active', billing_provider = 'stripe', archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = ${userId}`);
    }

    logFromRequest(req, 'charge_subscription_invoice', 'payment', invoice.id, userEmail as string, {
      subscriptionId,
      invoiceId: invoice.id,
      amountDue: invoice.amount_due,
      paymentMethodId,
      invoiceStatus: paidInvoice.status,
      chargedBy: staffEmail
    });

    broadcastBillingUpdate({
      action: 'subscription_updated',
      memberEmail: userEmail as string,
      customerId: customer?.id
    });

    res.json({
      success: true,
      invoiceId: invoice.id,
      invoiceStatus: paidInvoice.status,
      amountPaid: paidInvoice.amount_paid
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error charging subscription invoice', { error: error instanceof Error ? error : new Error(String(error)) });
    
    if ((error as StripeError).type === 'StripeCardError') {
      return res.status(400).json({ 
        error: `Card declined: ${safeErrorDetail(error)}`,
        declineCode: (error as StripeError).decline_code
      });
    }
    
    await alertOnExternalServiceError('Stripe', error as Error, 'charge subscription invoice');
    res.status(500).json({ 
      error: 'Failed to charge subscription invoice',
      retryable: true
    });
  }
});

export default router;
