import { createHash } from 'crypto';
import { getStripeClient } from '../stripe/client';
import { db } from '../../db';
import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { notifyAllStaff } from '../notificationService';
import { broadcastBookingInvoiceUpdate } from '../websocket';
import { bookingRequests, membershipTiers } from '../../../shared/schema';
import { notifications } from '../../../shared/models/notifications';
import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { BookingFeeLineItem } from '../stripe/invoices';
import { PRICING } from './pricingConfig';
import { markPaymentRefunded } from './PaymentStatusService';
import { BOOKING_STATUS, PARTICIPANT_TYPE, RESOURCE_TYPE, PAYMENT_STATUS } from '../../../shared/constants/statuses';
import type { ParticipantType } from '../../../shared/constants/statuses';

interface _InvoiceWithPaymentIntent extends Stripe.Invoice {
  payment_intent: string | Stripe.PaymentIntent | null;
}

interface BookingInvoiceIdRow {
  stripe_invoice_id: string | null;
}

interface StripeCustomerIdRow {
  stripe_customer_id: string | null;
}

interface ParticipantFeeRow {
  id: number;
  display_name: string | null;
  participant_type: string;
  cached_fee_cents: number;
}

interface _RefundCountRow {
  cnt: string | number;
}

interface BookingInfoRow {
  user_email: string;
  session_id: number;
  trackman_booking_id: string | null;
  status: string;
  resource_id?: number;
  declared_player_count?: number;
  resource_type?: string;
}

interface PaymentIntentLookupRow {
  stripe_payment_intent_id: string;
  amount_cents: number;
}

interface InvoiceSyncRow {
  stripe_invoice_id: string | null;
  user_email: string;
  trackman_booking_id: string | null;
  status: string;
  resource_id: number | null;
  resource_type: string;
  declared_player_count: number | null;
}

interface TrackmanBookingIdRow {
  trackman_booking_id: string | null;
}

function safeBroadcast(params: Parameters<typeof broadcastBookingInvoiceUpdate>[0]): void {
  try {
    broadcastBookingInvoiceUpdate(params);
  } catch (err: unknown) {
    logger.warn('[BookingInvoice] Failed to broadcast invoice update', {
      extra: { bookingId: params.bookingId, action: params.action, error: getErrorMessage(err) }
    });
  }
}

export interface DraftInvoiceParams {
  customerId: string;
  bookingId: number;
  sessionId: number;
  trackmanBookingId?: string | null;
  feeLineItems: BookingFeeLineItem[];
  metadata?: Record<string, string>;
  purpose?: string;
}

export interface DraftInvoiceResult {
  invoiceId: string;
  totalCents: number;
}

export interface FinalizeAndPayResult {
  invoiceId: string;
  paymentIntentId: string;
  clientSecret: string;
  status: string;
  paidInFull: boolean;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  amountFromBalance: number;
  amountCharged: number;
}

export async function buildInvoiceDescription(
  bookingId: number,
  trackmanBookingId: string | null | undefined,
): Promise<string> {
  const bookingRef = trackmanBookingId ? `TM-${trackmanBookingId}` : `#${bookingId}`;
  try {
    const result = await db.execute(sql`
      SELECT br.request_date, br.start_time, br.end_time, r.name AS resource_name
      FROM booking_requests br
      LEFT JOIN resources r ON r.id = br.resource_id
      WHERE br.id = ${bookingId}
      LIMIT 1
    `);
    const row = result.rows[0] as { request_date: string; start_time: string; end_time: string; resource_name: string | null } | undefined;
    if (row) {
      const date = new Date(row.request_date);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
      const formatTime = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
      };
      const timeRange = `${formatTime(row.start_time)}–${formatTime(row.end_time)}`;
      const resource = row.resource_name || 'Unassigned';
      return `Booking ${bookingRef} — ${resource}, ${dateStr}, ${timeRange}`;
    }
  } catch (err: unknown) {
    logger.warn('[BookingInvoice] Could not fetch booking details for invoice description', {
      extra: { bookingId, error: getErrorMessage(err) }
    });
  }
  return `Booking ${bookingRef} fees`;
}

function buildInvoiceMetadata(
  params: DraftInvoiceParams,
  feeLineItems: BookingFeeLineItem[]
): Record<string, string> {
  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);
  const meta: Record<string, string> = {
    ...(params.metadata || {}),
    source: 'ever_house_app',
    purpose: params.purpose || 'booking_fee',
    bookingId: params.bookingId.toString(),
    sessionId: params.sessionId.toString(),
    overageCents: totalOverageCents.toString(),
    guestCents: totalGuestCents.toString(),
    invoiceModel: 'single_per_booking',
  };
  if (params.trackmanBookingId) {
    meta.trackmanBookingId = String(params.trackmanBookingId);
  }
  return meta;
}

async function getFeePriceIds(): Promise<{ overagePriceId: string | null; guestPriceId: string | null }> {
  const rows = await db.select({ slug: membershipTiers.slug, stripePriceId: membershipTiers.stripePriceId })
    .from(membershipTiers)
    .where(sql`${membershipTiers.slug} IN ('simulator-overage-30min', 'guest-pass')`);
  let overagePriceId: string | null = null;
  let guestPriceId: string | null = null;
  for (const r of rows) {
    if (r.slug === 'simulator-overage-30min') overagePriceId = r.stripePriceId;
    if (r.slug === 'guest-pass') guestPriceId = r.stripePriceId;
  }
  return { overagePriceId, guestPriceId };
}

async function addLineItemsToInvoice(
  stripe: Stripe,
  invoiceId: string,
  customerId: string,
  feeLineItems: BookingFeeLineItem[]
): Promise<void> {
  const { overagePriceId, guestPriceId } = await getFeePriceIds();

  for (const li of feeLineItems) {
    if (li.totalCents <= 0) continue;

    if (li.overageCents > 0) {
      const overageDesc = li.participantType === PARTICIPANT_TYPE.OWNER
        ? `Overage fee — ${li.displayName}`
        : `Overage fee — ${li.displayName} (${li.participantType})`;

      const overageRateCents = PRICING.OVERAGE_RATE_CENTS;
      const quantity = overageRateCents > 0 ? Math.round(li.overageCents / overageRateCents) : 1;
      const overageRemainder = overageRateCents > 0 ? li.overageCents % overageRateCents : 0;

      if (overagePriceId && overageRateCents > 0 && quantity > 0 && overageRemainder === 0) {
        try {
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoiceId,
            pricing: { price: overagePriceId },
            quantity,
            description: overageDesc,
            metadata: {
              participantId: li.participantId?.toString() || '',
              feeType: 'overage',
              participantType: li.participantType,
            },
          }, {
            idempotencyKey: `invitem_overage_${invoiceId}_${li.participantId || 'unknown'}_${li.overageCents}`
          });
        } catch (priceErr: unknown) {
          const errObj = priceErr instanceof Error ? priceErr : null;
          const errType = errObj && 'type' in errObj ? (errObj as Record<string, unknown>).type : undefined;
          const errCode = errObj && 'code' in errObj ? (errObj as Record<string, unknown>).code : undefined;
          const isStalePrice = (errType === 'StripeInvalidRequestError' && errCode === 'resource_missing')
            || (errObj !== null && errObj.message.includes('No such price'));
          if (isStalePrice) {
            const errMsg = errObj ? errObj.message : String(priceErr);
            logger.warn('[BookingInvoice] Stale overage price ID, falling back to custom amount', { extra: { overagePriceId, error: errMsg } });
            await stripe.invoiceItems.create({
              customer: customerId,
              invoice: invoiceId,
              amount: li.overageCents,
              currency: 'usd',
              description: overageDesc,
              metadata: {
                participantId: li.participantId?.toString() || '',
                feeType: 'overage',
                participantType: li.participantType,
              },
            }, {
              idempotencyKey: `invitem_overage_fallback_${invoiceId}_${li.participantId || 'unknown'}_${li.overageCents}`
            });
          } else {
            throw priceErr;
          }
        }
      } else {
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoiceId,
          amount: li.overageCents,
          currency: 'usd',
          description: overageDesc,
          metadata: {
            participantId: li.participantId?.toString() || '',
            feeType: 'overage',
            participantType: li.participantType,
          },
        }, {
          idempotencyKey: `invitem_overage_${invoiceId}_${li.participantId || 'unknown'}_${li.overageCents}`
        });
      }
    }

    if (li.guestCents > 0) {
      const guestRateCents = PRICING.GUEST_FEE_CENTS;
      const guestQty = guestPriceId && guestRateCents > 0 ? Math.round(li.guestCents / guestRateCents) : 1;
      const guestRemainder = guestRateCents > 0 ? li.guestCents % guestRateCents : 0;

      if (guestPriceId && guestRateCents > 0 && guestQty > 0 && guestRemainder === 0) {
        try {
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoiceId,
            pricing: { price: guestPriceId },
            quantity: guestQty,
            description: `Guest fee — ${li.displayName}`,
            metadata: {
              participantId: li.participantId?.toString() || '',
              feeType: 'guest',
              participantType: li.participantType,
            },
          }, {
            idempotencyKey: `invitem_guest_${invoiceId}_${li.participantId || 'unknown'}_${li.guestCents}`
          });
        } catch (priceErr: unknown) {
          const errObj = priceErr instanceof Error ? priceErr : null;
          const errType = errObj && 'type' in errObj ? (errObj as Record<string, unknown>).type : undefined;
          const errCode = errObj && 'code' in errObj ? (errObj as Record<string, unknown>).code : undefined;
          const isStalePrice = (errType === 'StripeInvalidRequestError' && errCode === 'resource_missing')
            || (errObj !== null && errObj.message.includes('No such price'));
          if (isStalePrice) {
            const errMsg = errObj ? errObj.message : String(priceErr);
            logger.warn('[BookingInvoice] Stale guest price ID, falling back to custom amount', { extra: { guestPriceId, error: errMsg } });
            await stripe.invoiceItems.create({
              customer: customerId,
              invoice: invoiceId,
              amount: li.guestCents,
              currency: 'usd',
              description: `Guest fee — ${li.displayName}`,
              metadata: {
                participantId: li.participantId?.toString() || '',
                feeType: 'guest',
                participantType: li.participantType,
              },
            }, {
              idempotencyKey: `invitem_guest_fallback_${invoiceId}_${li.participantId || 'unknown'}_${li.guestCents}`
            });
          } else {
            throw priceErr;
          }
        }
      } else {
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoiceId,
          amount: li.guestCents,
          currency: 'usd',
          description: `Guest fee — ${li.displayName}`,
          metadata: {
            participantId: li.participantId?.toString() || '',
            feeType: 'guest',
            participantType: li.participantType,
          },
        }, {
          idempotencyKey: `invitem_guest_${invoiceId}_${li.participantId || 'unknown'}_${li.guestCents}`
        });
      }
    }
  }
}

export async function createDraftInvoiceForBooking(
  params: DraftInvoiceParams
): Promise<DraftInvoiceResult> {
  const stripe = await getStripeClient();
  const { customerId, bookingId, sessionId, trackmanBookingId, feeLineItems } = params;

  const existingResult = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  const existingInvoiceId = existingResult.rows[0]?.stripe_invoice_id as string | undefined;

  if (existingInvoiceId) {
    try {
      let existingInvoice;
      try {
        existingInvoice = await stripe.invoices.retrieve(existingInvoiceId);
      } catch (retrieveErr: unknown) {
        const stripeErr = retrieveErr as { statusCode?: number };
        if (stripeErr.statusCode === 404) {
          logger.warn('[BookingInvoice] Stale invoice reference — invoice not found in Stripe, clearing and creating new draft', {
            extra: { bookingId, invoiceId: existingInvoiceId }
          });
          await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
          existingInvoice = null;
        } else {
          throw retrieveErr;
        }
      }
      if (existingInvoice && existingInvoice.status === 'draft') {
        logger.info('[BookingInvoice] Draft invoice already exists, updating instead', {
          extra: { bookingId, invoiceId: existingInvoiceId }
        });
        return updateDraftInvoiceLineItems({ bookingId, sessionId, feeLineItems });
      }
      if (existingInvoice && existingInvoice.status === 'paid') {
        logger.info('[BookingInvoice] Invoice already paid, skipping draft creation', {
          extra: { bookingId, invoiceId: existingInvoiceId }
        });
        return { invoiceId: existingInvoiceId, totalCents: existingInvoice.amount_paid };
      }
      if (existingInvoice && existingInvoice.status === 'open') {
        const newTotal = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);
        if (existingInvoice.amount_due !== newTotal) {
          logger.info('[BookingInvoice] Open invoice amount stale, voiding and recreating', {
            extra: { bookingId, invoiceId: existingInvoiceId, oldAmount: existingInvoice.amount_due, newAmount: newTotal }
          });
          await stripe.invoices.voidInvoice(existingInvoiceId);
          await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL WHERE id = ${bookingId}`);
        } else {
          logger.info('[BookingInvoice] Open invoice exists with correct amount, reusing', {
            extra: { bookingId, invoiceId: existingInvoiceId }
          });
          return { invoiceId: existingInvoiceId, totalCents: existingInvoice.amount_due };
        }
      }
      if (existingInvoice && (existingInvoice.status === 'void' || existingInvoice.status === 'uncollectible')) {
        logger.info('[BookingInvoice] Existing invoice is void/uncollectible, clearing reference before creating new draft', {
          extra: { bookingId, invoiceId: existingInvoiceId, status: existingInvoice.status }
        });
        await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
      }
    } catch (retrieveErr: unknown) {
      logger.warn('[BookingInvoice] Could not retrieve existing invoice, creating new one', {
        extra: { bookingId, existingInvoiceId, error: getErrorMessage(retrieveErr) }
      });
    }
  }

  const description = await buildInvoiceDescription(bookingId, trackmanBookingId);
  const invoiceMetadata = buildInvoiceMetadata(params, feeLineItems);

  let invoice = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false,
    collection_method: 'charge_automatically',
    description,
    metadata: invoiceMetadata,
    pending_invoice_items_behavior: 'exclude',
    payment_settings: {
      payment_method_types: ['card', 'link'],
    },
  }, {
    idempotencyKey: `invoice_booking_draft_${bookingId}_${sessionId}_${createHash('sha256').update(JSON.stringify(feeLineItems.map(li => ({ id: li.participantId, o: li.overageCents, g: li.guestCents, t: li.totalCents })).sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''))))).digest('hex').substring(0, 12)}_${Math.floor(Date.now() / 60000)}`
  });

  if (invoice.status === 'void' || invoice.status === 'uncollectible') {
    logger.warn('[BookingInvoice] Idempotency key returned stale void/uncollectible invoice, retrying with fresh key', {
      extra: { bookingId, staleInvoiceId: invoice.id, status: invoice.status }
    });
    invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: false,
      collection_method: 'charge_automatically',
      description,
      metadata: invoiceMetadata,
      pending_invoice_items_behavior: 'exclude',
      payment_settings: {
        payment_method_types: ['card', 'link'],
      },
    }, {
      idempotencyKey: `invoice_booking_draft_${bookingId}_${sessionId}_retry_${Date.now()}`
    });
  }

  try {
    await addLineItemsToInvoice(stripe, invoice.id, customerId, feeLineItems);
  } catch (lineItemErr: unknown) {
    logger.error('[BookingInvoice] Failed to add line items, cleaning up orphaned invoice', {
      extra: { bookingId, invoiceId: invoice.id, error: getErrorMessage(lineItemErr) }
    });
    try {
      await stripe.invoices.del(invoice.id);
    } catch (deleteErr: unknown) {
      logger.error('[BookingInvoice] Failed to delete orphaned draft invoice in Stripe', {
        extra: { bookingId, invoiceId: invoice.id, error: getErrorMessage(deleteErr) }
      });
    }
    throw lineItemErr;
  }

  const totalCents = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

  try {
    await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = ${invoice.id}, updated_at = NOW() WHERE id = ${bookingId}`);
  } catch (dbErr: unknown) {
    logger.error('[BookingInvoice] Failed to link invoice to booking in DB, cleaning up Stripe invoice', {
      extra: { bookingId, invoiceId: invoice.id, error: getErrorMessage(dbErr) }
    });
    try {
      await stripe.invoices.del(invoice.id);
    } catch (deleteErr: unknown) {
      logger.error('[BookingInvoice] ORPHANED INVOICE: Failed to delete draft invoice after DB error', {
        extra: { bookingId, invoiceId: invoice.id, error: getErrorMessage(deleteErr) }
      });
    }
    throw dbErr;
  }

  logger.info('[BookingInvoice] Created draft invoice for booking', {
    extra: { bookingId, sessionId, invoiceId: invoice.id, totalCents, lineItems: feeLineItems.length }
  });

  safeBroadcast({ bookingId, sessionId, action: 'invoice_created', invoiceId: invoice.id, totalCents });

  return { invoiceId: invoice.id, totalCents };
}

export async function updateDraftInvoiceLineItems(params: {
  bookingId: number;
  sessionId: number;
  feeLineItems: BookingFeeLineItem[];
}): Promise<DraftInvoiceResult> {
  const stripe = await getStripeClient();
  const { bookingId, sessionId, feeLineItems } = params;

  const result = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  const invoiceId = (result.rows as unknown as BookingInvoiceIdRow[])[0]?.stripe_invoice_id;

  if (!invoiceId) {
    throw new Error(`No draft invoice found for booking ${bookingId}`);
  }

  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['lines.data'] });

  if (invoice.status !== 'draft') {
    logger.warn('[BookingInvoice] Cannot update non-draft invoice', {
      extra: { bookingId, invoiceId, status: invoice.status }
    });
    return { invoiceId, totalCents: invoice.amount_due };
  }

  const invoiceItems = await stripe.invoiceItems.list({ invoice: invoiceId, limit: 100 });
  for (const item of invoiceItems.data) {
    await stripe.invoiceItems.del(item.id);
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || '';
  await addLineItemsToInvoice(stripe, invoiceId, customerId, feeLineItems);

  const totalOverageCents = feeLineItems.reduce((sum, li) => sum + li.overageCents, 0);
  const totalGuestCents = feeLineItems.reduce((sum, li) => sum + li.guestCents, 0);
  const totalCents = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

  const trackmanResult = await db.execute(sql`SELECT trackman_booking_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  const trackmanBookingId = (trackmanResult.rows as unknown as TrackmanBookingIdRow[])[0]?.trackman_booking_id || null;

  await stripe.invoices.update(invoiceId, {
    description: await buildInvoiceDescription(bookingId, trackmanBookingId),
    metadata: {
      ...(invoice.metadata || {}),
      overageCents: totalOverageCents.toString(),
      guestCents: totalGuestCents.toString(),
      lastRosterUpdate: new Date().toISOString(),
    },
  });

  logger.info('[BookingInvoice] Updated draft invoice line items after roster change', {
    extra: { bookingId, sessionId, invoiceId, totalCents, lineItems: feeLineItems.length }
  });

  safeBroadcast({ bookingId, sessionId, action: 'invoice_updated', invoiceId, totalCents });

  return { invoiceId, totalCents };
}

export async function getBookingInvoiceId(bookingId: number): Promise<string | null> {
  const result = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
  return (result.rows as unknown as BookingInvoiceIdRow[])[0]?.stripe_invoice_id || null;
}

export async function getBookingInvoiceStatus(bookingId: number): Promise<{
  invoiceId: string | null;
  status: string | null;
  amountDue: number;
} | null> {
  const invoiceId = await getBookingInvoiceId(bookingId);
  if (!invoiceId) return null;

  try {
    const stripe = await getStripeClient();
    const invoice = await stripe.invoices.retrieve(invoiceId);
    return {
      invoiceId,
      status: invoice.status,
      amountDue: invoice.amount_due,
    };
  } catch (err) {
    logger.warn('[BookingInvoice] Failed to retrieve invoice status', { error: getErrorMessage(err) });
    return null;
  }
}

export async function finalizeAndPayInvoice(params: {
  bookingId: number;
  paymentMethodId?: string;
  offSession?: boolean;
}): Promise<FinalizeAndPayResult> {
  const stripe = await getStripeClient();
  const { bookingId, paymentMethodId, offSession } = params;

  const invoiceId = await getBookingInvoiceId(bookingId);
  if (!invoiceId) {
    throw new Error(`No invoice found for booking ${bookingId}`);
  }

  const invoice = await stripe.invoices.retrieve(invoiceId);

  if (invoice.status === 'paid') {
    safeBroadcast({
      bookingId,
      action: 'invoice_paid',
      invoiceId,
      paidInFull: true,
      totalCents: invoice.amount_paid,
    });
    return {
      invoiceId,
      paymentIntentId: extractPaymentIntentId(invoice) || `invoice-balance-${invoiceId}`,
      clientSecret: '',
      status: 'succeeded',
      paidInFull: true,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      amountFromBalance: invoice.amount_paid,
      amountCharged: 0,
    };
  }

  const existingPiResult = await db.execute(sql`SELECT spi.stripe_payment_intent_id, spi.amount_cents
     FROM stripe_payment_intents spi
     WHERE spi.booking_id = ${bookingId} AND spi.status = 'succeeded'
     AND spi.purpose IN ('booking_fee', 'overage_fee')
     ORDER BY spi.created_at DESC LIMIT 1`);

  if (existingPiResult.rows.length > 0) {
    const existingPi = (existingPiResult.rows as unknown as PaymentIntentLookupRow[])[0];
    try {
      const stripePi = await stripe.paymentIntents.retrieve(existingPi.stripe_payment_intent_id);
      const pmTypes = stripePi.payment_method_types || [];
      const isTerminal = pmTypes.includes('card_present') || pmTypes.includes('interac_present');
      const invoiceTotal = invoice.amount_due || invoice.total || 0;

      if (isTerminal && stripePi.status === 'succeeded' && invoiceTotal > 0 && stripePi.amount >= invoiceTotal) {
        logger.info('[BookingInvoice] Terminal payment already covers invoice, settling OOB instead of new charge', {
          extra: { bookingId, existingPiId: existingPi.stripe_payment_intent_id, piAmount: stripePi.amount, invoiceTotal }
        });

        const oobResult = await finalizeInvoicePaidOutOfBand({
          bookingId,
          terminalPaymentIntentId: existingPi.stripe_payment_intent_id,
          paidVia: 'terminal',
        });

        if (oobResult.success) {
          safeBroadcast({
            bookingId,
            action: 'invoice_paid',
            invoiceId,
            paidInFull: true,
          });
          return {
            invoiceId,
            paymentIntentId: existingPi.stripe_payment_intent_id,
            clientSecret: '',
            status: 'succeeded',
            paidInFull: true,
            hostedInvoiceUrl: oobResult.hostedInvoiceUrl || null,
            invoicePdf: oobResult.invoicePdf || null,
            amountFromBalance: 0,
            amountCharged: 0,
          };
        }
      }
    } catch (piCheckErr: unknown) {
      logger.warn('[BookingInvoice] Could not verify existing PI for terminal detection', {
        extra: { bookingId, piId: existingPi.stripe_payment_intent_id, error: getErrorMessage(piCheckErr) }
      });
    }
  }

  if (invoice.status === 'void' || invoice.status === 'uncollectible') {
    logger.info('[BookingInvoice] Invoice is void/uncollectible, clearing and recreating draft', {
      extra: { bookingId, invoiceId, status: invoice.status }
    });
    await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);

    const bookingInfoResult = await db.execute(sql`
      SELECT br.user_email, br.session_id, br.trackman_booking_id, br.resource_id,
             COALESCE(r.type, ${RESOURCE_TYPE.SIMULATOR}) as resource_type
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE br.id = ${bookingId} LIMIT 1
    `);
    const bookingInfo = bookingInfoResult.rows[0] as { user_email: string; session_id: number; trackman_booking_id: string | null; resource_type: string } | undefined;

    if (!bookingInfo) {
      throw new Error(`Booking ${bookingId} not found when trying to recreate invoice`);
    }

    const custResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${bookingInfo.user_email}) LIMIT 1`);
    const custId = (custResult.rows as unknown as StripeCustomerIdRow[])[0]?.stripe_customer_id;
    if (!custId) {
      logger.error('[BookingInvoice] No Stripe customer for invoice recovery', {
        extra: { bookingId, email: bookingInfo.user_email, invoiceId, invoiceStatus: invoice.status }
      });
      throw new Error(`No billing account found. Please contact support. (Booking #${bookingId})`);
    }

    const partResult = await db.execute(sql`
      SELECT id, display_name, participant_type, cached_fee_cents
      FROM booking_participants
      WHERE session_id = ${bookingInfo.session_id} AND cached_fee_cents > 0
    `);
    const newFeeLineItems: BookingFeeLineItem[] = (partResult.rows as unknown as ParticipantFeeRow[]).map((row) => {
      const isGuest = row.participant_type === PARTICIPANT_TYPE.GUEST;
      return {
        participantId: row.id,
        displayName: row.display_name || 'Unknown',
        participantType: row.participant_type as ParticipantType,
        overageCents: isGuest ? 0 : row.cached_fee_cents,
        guestCents: isGuest ? row.cached_fee_cents : 0,
        totalCents: row.cached_fee_cents,
      };
    });

    if (newFeeLineItems.length === 0) {
      throw new Error(`No fee line items found for booking ${bookingId} when recreating invoice`);
    }

    await createDraftInvoiceForBooking({
      customerId: custId,
      bookingId,
      sessionId: bookingInfo.session_id,
      trackmanBookingId: bookingInfo.trackman_booking_id || null,
      feeLineItems: newFeeLineItems,
      purpose: 'booking_fee',
    });

    return finalizeAndPayInvoice({ bookingId, paymentMethodId, offSession });
  }

  if (invoice.status !== 'draft' && invoice.status !== 'open') {
    throw new Error(`Invoice ${invoiceId} is in unexpected status: ${invoice.status}`);
  }

  let finalizedInvoice: Stripe.Invoice;
  if (invoice.status === 'draft') {
    finalizedInvoice = await stripe.invoices.finalizeInvoice(invoiceId);
  } else {
    finalizedInvoice = invoice;
  }

  if (finalizedInvoice.status === 'paid') {
    const paidInvoice = await stripe.invoices.retrieve(invoiceId, { expand: ['lines.data'] });
    const amountFromBalance = computeBalanceApplied(paidInvoice);
    safeBroadcast({
      bookingId,
      action: 'invoice_paid',
      invoiceId,
      paidInFull: true,
      totalCents: paidInvoice.amount_paid,
    });
    return {
      invoiceId,
      paymentIntentId: extractPaymentIntentId(paidInvoice) || `invoice-balance-${invoiceId}`,
      clientSecret: '',
      status: 'succeeded',
      paidInFull: true,
      hostedInvoiceUrl: paidInvoice.hosted_invoice_url ?? null,
      invoicePdf: paidInvoice.invoice_pdf ?? null,
      amountFromBalance,
      amountCharged: 0,
    };
  }

  if (offSession && paymentMethodId) {
    logger.info('[BookingInvoice] Paying invoice with saved card via invoices.pay()', {
      extra: { bookingId, invoiceId, paymentMethodId, invoiceStatus: finalizedInvoice.status }
    });
    try {
      const paidInvoice = await stripe.invoices.pay(invoiceId, {
        payment_method: paymentMethodId,
      });
      const amountFromBalance = computeBalanceApplied(paidInvoice);
      const amountCharged = paidInvoice.amount_paid - amountFromBalance;
      const resultPiId = extractPaymentIntentId(paidInvoice) || `invoice-pay-${invoiceId}`;

      const isPaid = paidInvoice.status === 'paid';
      if (isPaid) {
        safeBroadcast({
          bookingId,
          action: 'invoice_paid',
          invoiceId,
          paidInFull: true,
          totalCents: paidInvoice.amount_paid,
        });
      }

      return {
        invoiceId,
        paymentIntentId: resultPiId,
        clientSecret: '',
        status: isPaid ? 'succeeded' : 'requires_action',
        paidInFull: isPaid,
        hostedInvoiceUrl: paidInvoice.hosted_invoice_url ?? null,
        invoicePdf: paidInvoice.invoice_pdf ?? null,
        amountFromBalance,
        amountCharged: Math.max(0, amountCharged),
      };
    } catch (payErr: unknown) {
      const stripeErr = payErr as { type?: string; code?: string; decline_code?: string; payment_intent?: { id: string; status: string; client_secret: string } | string; raw?: { payment_intent?: { id: string; status: string; client_secret: string } | string } };
      const rawPi = typeof stripeErr.payment_intent === 'object' && stripeErr.payment_intent
        ? stripeErr.payment_intent
        : typeof stripeErr.raw?.payment_intent === 'object' && stripeErr.raw.payment_intent
          ? stripeErr.raw.payment_intent
          : null;
      const piId = rawPi?.id || (typeof stripeErr.payment_intent === 'string' ? stripeErr.payment_intent : undefined);
      logger.error('[BookingInvoice] invoices.pay() failed for saved card', {
        error: payErr instanceof Error ? payErr : new Error(String(payErr)),
        extra: {
          bookingId,
          invoiceId,
          paymentMethodId,
          stripeType: stripeErr.type,
          stripeCode: stripeErr.code,
          declineCode: stripeErr.decline_code,
          piStatus: rawPi?.status,
          piId,
        }
      });
      if (rawPi?.status === 'requires_action' && rawPi?.client_secret) {
        return {
          invoiceId,
          paymentIntentId: rawPi.id,
          clientSecret: rawPi.client_secret,
          status: 'requires_action' as const,
          paidInFull: false,
          hostedInvoiceUrl: null,
          invoicePdf: null,
          amountFromBalance: 0,
          amountCharged: 0,
        };
      }
      if (piId && !rawPi) {
        try {
          const retrievedPi = await stripe.paymentIntents.retrieve(piId);
          if (retrievedPi.status === 'requires_action' && retrievedPi.client_secret) {
            return {
              invoiceId,
              paymentIntentId: retrievedPi.id,
              clientSecret: retrievedPi.client_secret,
              status: 'requires_action' as const,
              paidInFull: false,
              hostedInvoiceUrl: null,
              invoicePdf: null,
              amountFromBalance: 0,
              amountCharged: 0,
            };
          }
        } catch { /* PI retrieval failed, fall through to rethrow */ }
      }
      throw payErr;
    }
  }

  let invoicePiId = extractPaymentIntentId(finalizedInvoice);

  if (!invoicePiId) {
    const expandedInvoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] });
    const expandedRawPi = (expandedInvoice as unknown as { payment_intent: string | Stripe.PaymentIntent | null }).payment_intent;
    if (typeof expandedRawPi === 'object' && expandedRawPi !== null) {
      invoicePiId = expandedRawPi.id;
      logger.info('[BookingInvoice] Retrieved invoice PI via expand', {
        extra: { bookingId, invoiceId, paymentIntentId: invoicePiId, piStatus: expandedRawPi.status }
      });
    }
  }

  if (!invoicePiId) {
    logger.warn('[BookingInvoice] No PaymentIntent after finalization even with expand — returning hosted URL as fallback', {
      extra: { bookingId, invoiceId, invoiceStatus: finalizedInvoice.status }
    });
    return {
      invoiceId,
      paymentIntentId: '',
      clientSecret: '',
      status: 'requires_payment_method',
      paidInFull: false,
      hostedInvoiceUrl: finalizedInvoice.hosted_invoice_url ?? null,
      invoicePdf: finalizedInvoice.invoice_pdf ?? null,
      amountFromBalance: 0,
      amountCharged: 0,
    };
  }

  const invoiceMeta = finalizedInvoice.metadata || {};
  await stripe.paymentIntents.update(invoicePiId, {
    metadata: {
      ...invoiceMeta,
      source: 'ever_house_app',
    },
    description: finalizedInvoice.description || undefined,
  });

  const paymentIntent = await stripe.paymentIntents.retrieve(invoicePiId);

  logger.info('[BookingInvoice] Invoice finalized, awaiting payment', {
    extra: { bookingId, invoiceId, paymentIntentId: invoicePiId }
  });

  return {
    invoiceId,
    paymentIntentId: invoicePiId,
    clientSecret: paymentIntent.client_secret || '',
    status: paymentIntent.status,
    paidInFull: false,
    hostedInvoiceUrl: finalizedInvoice.hosted_invoice_url ?? null,
    invoicePdf: finalizedInvoice.invoice_pdf ?? null,
    amountFromBalance: 0,
    amountCharged: 0,
  };
}

export async function finalizeInvoicePaidOutOfBand(params: {
  bookingId: number;
  terminalPaymentIntentId?: string;
  paidVia?: string;
}): Promise<{
  success: boolean;
  invoiceId?: string;
  hostedInvoiceUrl?: string | null;
  invoicePdf?: string | null;
  error?: string;
}> {
  const stripe = await getStripeClient();
  const { bookingId, terminalPaymentIntentId, paidVia = 'terminal' } = params;

  const invoiceId = await getBookingInvoiceId(bookingId);
  if (!invoiceId) {
    return { success: false, error: `No invoice found for booking ${bookingId}` };
  }

  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (invoice.status === 'paid') {
      return {
        success: true,
        invoiceId,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdf: invoice.invoice_pdf,
      };
    }

    if (invoice.status !== 'draft' && invoice.status !== 'open') {
      return { success: false, error: `Invoice ${invoiceId} is in unexpected status: ${invoice.status}` };
    }

    let openInvoice: Stripe.Invoice;
    if (invoice.status === 'draft') {
      await stripe.invoices.update(invoiceId, { auto_advance: false });
      openInvoice = await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: false });
    } else {
      openInvoice = invoice;
    }

    const piId = extractPaymentIntentId(openInvoice);
    if (piId) {
      try {
        const existingPi = await stripe.paymentIntents.retrieve(piId);
        if (existingPi.status === 'succeeded') {
          const freshInvoice = await stripe.invoices.retrieve(invoiceId);
          if (freshInvoice.status === 'paid') {
            return {
              success: true,
              invoiceId,
              hostedInvoiceUrl: freshInvoice.hosted_invoice_url,
              invoicePdf: freshInvoice.invoice_pdf,
            };
          }
        } else if (existingPi.status === 'processing') {
          logger.warn('[BookingInvoice] Auto-generated PI is processing, waiting before OOB payment', {
            extra: { piId, invoiceId, bookingId }
          });
          await new Promise(resolve => setTimeout(resolve, 3000));
          const recheckPi = await stripe.paymentIntents.retrieve(piId);
          if (recheckPi.status === 'succeeded') {
            const freshInvoice = await stripe.invoices.retrieve(invoiceId);
            if (freshInvoice.status === 'paid') {
              return {
                success: true,
                invoiceId,
                hostedInvoiceUrl: freshInvoice.hosted_invoice_url,
                invoicePdf: freshInvoice.invoice_pdf,
              };
            }
          } else if (recheckPi.status !== 'canceled') {
            // Intentional direct cancel — NOT cancelPaymentIntent() — because we need the invoice to stay open for OOB payment below
            await stripe.paymentIntents.cancel(piId);
          }
        } else if (existingPi.status !== 'canceled') {
          // Intentional direct cancel — NOT cancelPaymentIntent() — because we need the invoice to stay open for OOB payment below
          await stripe.paymentIntents.cancel(piId);
        }
      } catch (cancelErr: unknown) {
        logger.warn('[BookingInvoice] Could not cancel auto-generated PI', {
          extra: { piId, error: getErrorMessage(cancelErr) }
        });
      }
    }

    const preOobInvoice = await stripe.invoices.retrieve(invoiceId);
    if (preOobInvoice.status === 'paid') {
      logger.info('[BookingInvoice] Invoice already paid before OOB step, skipping', {
        extra: { bookingId, invoiceId }
      });
      return {
        success: true,
        invoiceId,
        hostedInvoiceUrl: preOobInvoice.hosted_invoice_url,
        invoicePdf: preOobInvoice.invoice_pdf,
      };
    }

    if (terminalPaymentIntentId) {
      await stripe.invoices.pay(invoiceId, { payment_intent: terminalPaymentIntentId });
    } else {
      await stripe.invoices.pay(invoiceId, { paid_out_of_band: true });
    }

    const invoiceMeta: Record<string, string> = {
      ...(invoice.metadata || {}),
      paidVia,
    };
    if (terminalPaymentIntentId) {
      invoiceMeta.terminalPaymentIntentId = terminalPaymentIntentId;
    } else {
      invoiceMeta.paidOutOfBand = 'true';
    }
    await stripe.invoices.update(invoiceId, { metadata: invoiceMeta });

    const paidInvoice = await stripe.invoices.retrieve(invoiceId);

    logger.info(`[BookingInvoice] Invoice finalized and paid ${terminalPaymentIntentId ? 'via terminal PI' : 'out-of-band'}`, {
      extra: { bookingId, invoiceId, paidVia, terminalPaymentIntentId }
    });

    safeBroadcast({ bookingId, action: 'invoice_paid', invoiceId });

    return {
      success: true,
      invoiceId,
      hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
      invoicePdf: paidInvoice.invoice_pdf,
    };
  } catch (error: unknown) {
    logger.error('[BookingInvoice] Error finalizing invoice OOB', {
      extra: { bookingId, invoiceId, error: getErrorMessage(error) }
    });
    return { success: false, invoiceId, error: getErrorMessage(error) };
  }
}

export async function voidBookingInvoice(bookingId: number): Promise<{
  success: boolean;
  error?: string;
}> {
  const stripe = await getStripeClient();

  const invoiceIds: string[] = [];
  const primaryInvoiceId = await getBookingInvoiceId(bookingId);
  if (primaryInvoiceId) {
    invoiceIds.push(primaryInvoiceId);
  }

  try {
    const searchResult = await stripe.invoices.search({
      query: `metadata["bookingId"]:"${bookingId}"`,
      limit: 20,
    });
    for (const inv of searchResult.data) {
      if (!invoiceIds.includes(inv.id)) {
        invoiceIds.push(inv.id);
      }
    }
  } catch (searchErr: unknown) {
    logger.warn('[BookingInvoice] Failed to search Stripe for booking invoices, falling back to primary only', {
      extra: { bookingId, error: getErrorMessage(searchErr) }
    });
  }

  if (invoiceIds.length === 0) {
    return { success: true };
  }

  const errors: string[] = [];

  for (const invoiceId of invoiceIds) {
    try {
      const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] });

      if (invoice.status === 'draft') {
        await stripe.invoices.del(invoiceId);
        logger.info('[BookingInvoice] Deleted draft invoice for cancelled booking', {
          extra: { bookingId, invoiceId }
        });
      } else if (invoice.status === 'open') {
        await stripe.invoices.voidInvoice(invoiceId);
        logger.info('[BookingInvoice] Voided open invoice for cancelled booking', {
          extra: { bookingId, invoiceId }
        });
      } else if (invoice.status === 'void' || invoice.status === 'uncollectible') {
        logger.info('[BookingInvoice] Invoice already voided or uncollectible, skipping', {
          extra: { bookingId, invoiceId, status: invoice.status }
        });
      } else if (invoice.status === 'paid') {
        const rawInvPi = (invoice as unknown as { payment_intent: string | { id: string } | null }).payment_intent;
        let invoicePI = typeof rawInvPi === 'string'
          ? rawInvPi
          : rawInvPi?.id;

        if (!invoicePI && invoice.amount_paid > 0) {
          const piLookup = await db.execute(sql`
            SELECT stripe_payment_intent_id, status FROM stripe_payment_intents 
            WHERE booking_id = ${bookingId} AND status IN ('succeeded', 'refunding', 'refunded') 
            ORDER BY updated_at DESC LIMIT 1`);
          if (piLookup.rows.length > 0) {
            invoicePI = (piLookup.rows[0] as { stripe_payment_intent_id: string }).stripe_payment_intent_id;
            logger.info('[BookingInvoice] Resolved PI from local DB for paid invoice refund', {
              extra: { bookingId, invoiceId, paymentIntentId: invoicePI }
            });
          }
        }

        if (invoicePI && invoice.amount_paid > 0) {
          const alreadyQueued = await db.execute(sql`
            SELECT 1 FROM stripe_payment_intents 
            WHERE stripe_payment_intent_id = ${invoicePI} AND status IN ('refunding', 'refunded')
            LIMIT 1`);

          if ((alreadyQueued.rows?.length || 0) === 0) {
            const idempotencyKey = `refund_paid_invoice_${bookingId}_${invoiceId}`;
            try {
              const invoiceCustomerEmail = typeof invoice.customer_email === 'string' ? invoice.customer_email : '';

              await db.execute(sql`
                INSERT INTO stripe_payment_intents 
                  (user_id, stripe_payment_intent_id, amount_cents, purpose, booking_id, description, status, created_at, updated_at)
                VALUES (${invoiceCustomerEmail}, ${invoicePI}, ${invoice.amount_paid}, 'booking_fee', ${bookingId}, 'Invoice payment refund', 'refunding', NOW(), NOW())
                ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = 'refunding', updated_at = NOW()`);

              const refundCreateParams: { payment_intent: string; reason: 'requested_by_customer'; metadata: Record<string, string>; } = {
                payment_intent: invoicePI,
                reason: 'requested_by_customer',
                metadata: {
                  reason: 'booking_cancellation_paid_invoice',
                  bookingId: bookingId.toString(),
                  invoiceId,
                },
              };
              const refund = await stripe.refunds.create(refundCreateParams, { idempotencyKey });
              logger.info('[BookingInvoice] Refund issued for paid invoice', {
                extra: { bookingId, invoiceId, paymentIntentId: invoicePI, refundId: refund.id, amountPaid: invoice.amount_paid }
              });

              try {
                await markPaymentRefunded({
                  paymentIntentId: invoicePI,
                  refundId: refund.id,
                });
              } catch (statusErr: unknown) {
                logger.warn('[BookingInvoice] Non-blocking: failed to mark payment refunded, setting refund_succeeded_sync_failed', {
                  extra: { paymentIntentId: invoicePI, error: getErrorMessage(statusErr) }
                });
                try {
                  await db.execute(sql`UPDATE stripe_payment_intents 
                     SET status = 'refund_succeeded_sync_failed', updated_at = NOW() 
                     WHERE stripe_payment_intent_id = ${invoicePI}`);
                } catch (syncErr: unknown) {
                  logger.error('[BookingInvoice] CRITICAL: Failed to set refund_succeeded_sync_failed status', {
                    error: getErrorMessage(syncErr),
                    extra: { paymentIntentId: invoicePI }
                  });
                }
              }
            } catch (refundErr: unknown) {
              logger.error('[BookingInvoice] Inline refund failed for paid invoice', {
                extra: { bookingId, invoiceId, paymentIntentId: invoicePI, error: getErrorMessage(refundErr) }
              });
              errors.push(`Failed to refund paid invoice ${invoiceId}: ${getErrorMessage(refundErr)}`);
            }
          } else {
            logger.info('[BookingInvoice] Paid invoice PI already being refunded, skipping', {
              extra: { bookingId, invoiceId, paymentIntentId: invoicePI }
            });
          }
        } else {
          logger.info('[BookingInvoice] Paid invoice has no payment intent or zero amount, skipping refund', {
            extra: { bookingId, invoiceId, amountPaid: invoice.amount_paid }
          });
        }
      }
    } catch (error: unknown) {
      const msg = `Failed to void/handle invoice ${invoiceId}: ${getErrorMessage(error)}`;
      errors.push(msg);
      logger.error('[BookingInvoice] Error processing invoice during cancellation', {
        extra: { bookingId, invoiceId, error: getErrorMessage(error) }
      });
    }
  }

  await db.update(bookingRequests).set({ stripeInvoiceId: null, updatedAt: new Date() }).where(eq(bookingRequests.id, bookingId));

  safeBroadcast({ bookingId, action: 'invoice_voided', invoiceId: invoiceIds[0] });

  if (errors.length > 0) {
    return { success: false, error: errors.join('; ') };
  }

  return { success: true };
}

export async function recreateDraftInvoiceFromBooking(bookingId: number): Promise<{ success: boolean; invoiceId?: string }> {
  try {
    const bookingResult = await db.execute(sql`SELECT br.user_email, br.session_id, br.trackman_booking_id, br.status, br.resource_id,
              br.declared_player_count,
              COALESCE(r.type, ${RESOURCE_TYPE.SIMULATOR}) as resource_type
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.id = ${bookingId} LIMIT 1`);

    if (bookingResult.rows.length === 0) {
      logger.warn('[BookingInvoice] recreateDraftInvoiceFromBooking: booking not found', { extra: { bookingId } });
      return { success: false };
    }

    const booking = (bookingResult.rows as unknown as BookingInfoRow[])[0];

    if (booking.status !== BOOKING_STATUS.APPROVED) {
      logger.info('[BookingInvoice] recreateDraftInvoiceFromBooking: booking not approved, skipping', { extra: { bookingId, status: booking.status } });
      return { success: true };
    }

    const userResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${booking.user_email}) LIMIT 1`);

    const stripeCustomerId = (userResult.rows as unknown as StripeCustomerIdRow[])[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      logger.warn('[BookingInvoice] recreateDraftInvoiceFromBooking: no stripe_customer_id for user', { extra: { bookingId, email: booking.user_email } });
      return { success: false };
    }

    const participantResult = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
       FROM booking_participants
       WHERE session_id = ${booking.session_id} AND cached_fee_cents > 0`);

    const feeLineItems: BookingFeeLineItem[] = (participantResult.rows as unknown as ParticipantFeeRow[]).map((row) => {
      const totalCents = row.cached_fee_cents;
      const isGuest = row.participant_type === PARTICIPANT_TYPE.GUEST;
      return {
        participantId: row.id,
        displayName: row.display_name || 'Unknown',
        participantType: row.participant_type as ParticipantType,
        overageCents: isGuest ? 0 : totalCents,
        guestCents: isGuest ? totalCents : 0,
        totalCents,
      };
    });

    if (booking.resource_type !== RESOURCE_TYPE.CONFERENCE_ROOM) {
      const allParticipantResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM booking_participants WHERE session_id = ${booking.session_id}`);
      const actualCount = parseInt((allParticipantResult.rows[0] as { cnt: string }).cnt, 10) || 0;
      const declaredCount = booking.declared_player_count || actualCount;
      const emptySlots = Math.max(0, declaredCount - actualCount);
      if (emptySlots > 0) {
        const emptySlotFeeCents = emptySlots * PRICING.GUEST_FEE_CENTS;
        feeLineItems.push({
          displayName: `Empty Slot${emptySlots > 1 ? 's' : ''}`,
          participantType: PARTICIPANT_TYPE.GUEST,
          overageCents: 0,
          guestCents: emptySlotFeeCents,
          totalCents: emptySlotFeeCents,
        });
      }
    }

    const totalFees = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

    if (totalFees === 0) {
      logger.info('[BookingInvoice] recreateDraftInvoiceFromBooking: no fees, skipping draft creation', { extra: { bookingId } });
      return { success: true };
    }

    const draftResult = await createDraftInvoiceForBooking({
      customerId: stripeCustomerId as string,
      bookingId,
      sessionId: booking.session_id,
      trackmanBookingId: booking.trackman_booking_id || null,
      feeLineItems,
      purpose: 'booking_fee',
    });

    logger.info('[BookingInvoice] recreateDraftInvoiceFromBooking: draft invoice created', { extra: { bookingId, invoiceId: draftResult.invoiceId, totalCents: draftResult.totalCents } });
    return { success: true, invoiceId: draftResult.invoiceId };
  } catch (err: unknown) {
    logger.error('[BookingInvoice] recreateDraftInvoiceFromBooking failed', { extra: { bookingId, error: getErrorMessage(err) } });
    return { success: false };
  }
}

export async function syncBookingInvoice(bookingId: number, sessionId: number, _retryDepth = 0): Promise<void> {
  try {
    const invoiceResult = await db.execute(sql`SELECT br.stripe_invoice_id, br.user_email, br.trackman_booking_id, br.status, br.resource_id,
              COALESCE(r.type, ${RESOURCE_TYPE.SIMULATOR}) as resource_type,
              br.declared_player_count
       FROM booking_requests br
       LEFT JOIN resources r ON br.resource_id = r.id
       WHERE br.id = ${bookingId} LIMIT 1`);
    const booking = (invoiceResult.rows as unknown as InvoiceSyncRow[])[0];
    if (!booking) return;
    const stripeInvoiceId = booking.stripe_invoice_id;

    if (!stripeInvoiceId) {
      if (booking.status !== BOOKING_STATUS.APPROVED && booking.status !== BOOKING_STATUS.CONFIRMED && booking.status !== BOOKING_STATUS.ATTENDED) return;

      const participantResult = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
         FROM booking_participants
         WHERE session_id = ${sessionId} AND cached_fee_cents > 0`);

      const typedParticipants = participantResult.rows as unknown as ParticipantFeeRow[];

      const feeLineItems: BookingFeeLineItem[] = typedParticipants.map((row) => {
        const totalCents = row.cached_fee_cents;
        const isGuest = row.participant_type === PARTICIPANT_TYPE.GUEST;
        return {
          participantId: row.id,
          displayName: row.display_name || 'Unknown',
          participantType: row.participant_type as ParticipantType,
          overageCents: isGuest ? 0 : totalCents,
          guestCents: isGuest ? totalCents : 0,
          totalCents,
        };
      });

      if (booking.resource_type !== RESOURCE_TYPE.CONFERENCE_ROOM) {
        const allParticipantResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM booking_participants WHERE session_id = ${sessionId}`);
        const actualCount = parseInt((allParticipantResult.rows[0] as { cnt: string }).cnt, 10) || 0;
        const declaredCount = booking.declared_player_count || actualCount;
        const emptySlots = Math.max(0, declaredCount - actualCount);
        if (emptySlots > 0) {
          const emptySlotFeeCents = emptySlots * PRICING.GUEST_FEE_CENTS;
          feeLineItems.push({
            displayName: `Empty Slot${emptySlots > 1 ? 's' : ''}`,
            participantType: PARTICIPANT_TYPE.GUEST,
            overageCents: 0,
            guestCents: emptySlotFeeCents,
            totalCents: emptySlotFeeCents,
          });
        }
      }

      const totalFees = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);
      if (totalFees <= 0) return;

      const userResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${booking.user_email}) LIMIT 1`);
      const stripeCustomerId = (userResult.rows as unknown as StripeCustomerIdRow[])[0]?.stripe_customer_id;
      if (!stripeCustomerId) {
        logger.warn('[BookingInvoice] syncBookingInvoice: no stripe_customer_id for user, cannot create draft invoice', { extra: { bookingId, email: booking.user_email } });
        return;
      }

      const draftResult = await createDraftInvoiceForBooking({
        customerId: stripeCustomerId as string,
        bookingId,
        sessionId,
        trackmanBookingId: booking.trackman_booking_id || null,
        feeLineItems,
        purpose: 'booking_fee',
      });

      logger.info('[BookingInvoice] syncBookingInvoice created draft invoice (none existed, fees > $0)', {
        extra: { bookingId, sessionId, invoiceId: draftResult.invoiceId, totalCents: draftResult.totalCents }
      });

      safeBroadcast({ bookingId, sessionId, action: 'invoice_created', invoiceId: draftResult.invoiceId });
      return;
    }

    const stripe = await getStripeClient();
    let invoice;
    try {
      invoice = await stripe.invoices.retrieve(stripeInvoiceId);
    } catch (retrieveErr: unknown) {
      const stripeErr = retrieveErr as { statusCode?: number };
      if (stripeErr.statusCode === 404) {
        logger.warn('[BookingInvoice] syncBookingInvoice: stale invoice reference — invoice not found in Stripe, clearing and retrying', {
          extra: { bookingId, invoiceId: stripeInvoiceId, retryDepth: _retryDepth }
        });
        await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
        if (_retryDepth >= 1) {
          logger.error('[BookingInvoice] syncBookingInvoice: stale invoice retry exhausted — giving up', {
            extra: { bookingId, invoiceId: stripeInvoiceId }
          });
          return;
        }
        return syncBookingInvoice(bookingId, sessionId, _retryDepth + 1);
      }
      throw retrieveErr;
    }
    if (invoice.status !== 'draft') {
      if (invoice.status === 'open') {
        logger.warn('[BookingInvoice] syncBookingInvoice skipped: invoice is open (already finalized). Manual review may be needed.', {
          extra: { bookingId, invoiceId: stripeInvoiceId }
        });
      } else if (invoice.status === 'paid') {
        logger.warn('[BookingInvoice] syncBookingInvoice skipped: invoice already paid. Roster changed after payment — staff review needed.', {
          extra: { bookingId, invoiceId: stripeInvoiceId }
        });
        const existingNotification = await db.select({ id: notifications.id })
          .from(notifications)
          .where(sql`${notifications.title} = 'Roster Changed After Payment' AND ${notifications.relatedId} = ${bookingId} AND ${notifications.relatedType} = 'booking' AND ${notifications.message} LIKE ${'%' + stripeInvoiceId + '%'}`)
          .limit(1);
        if (existingNotification.length === 0) {
          await notifyAllStaff(
            'Roster Changed After Payment',
            `Booking #${bookingId} roster was modified after invoice ${stripeInvoiceId} was already paid. Staff review needed.`,
            'warning',
            { relatedId: bookingId, relatedType: 'booking' }
          );
        } else {
          logger.info('[BookingInvoice] Skipping duplicate "Roster Changed After Payment" notification for booking+invoice', {
            extra: { bookingId, invoiceId: stripeInvoiceId, existingNotificationId: existingNotification[0].id }
          });
        }
      } else if (invoice.status === 'void' || invoice.status === 'uncollectible') {
        logger.info('[BookingInvoice] syncBookingInvoice: invoice is void/uncollectible, clearing reference and recreating draft', {
          extra: { bookingId, invoiceId: stripeInvoiceId, status: invoice.status }
        });
        await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
        if (booking.status === BOOKING_STATUS.APPROVED || booking.status === BOOKING_STATUS.CONFIRMED || booking.status === BOOKING_STATUS.ATTENDED) {
          const voidRecoveryParts = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
             FROM booking_participants WHERE session_id = ${sessionId} AND cached_fee_cents > 0`);
          const voidRecoveryItems: BookingFeeLineItem[] = (voidRecoveryParts.rows as unknown as ParticipantFeeRow[]).map((row) => {
            const isGuest = row.participant_type === PARTICIPANT_TYPE.GUEST;
            return {
              participantId: row.id,
              displayName: row.display_name || 'Unknown',
              participantType: row.participant_type as ParticipantType,
              overageCents: isGuest ? 0 : row.cached_fee_cents,
              guestCents: isGuest ? row.cached_fee_cents : 0,
              totalCents: row.cached_fee_cents,
            };
          });
          const voidRecoveryTotal = voidRecoveryItems.reduce((sum, li) => sum + li.totalCents, 0);
          if (voidRecoveryTotal > 0) {
            const custResult = await db.execute(sql`SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${booking.user_email}) LIMIT 1`);
            const custId = (custResult.rows as unknown as StripeCustomerIdRow[])[0]?.stripe_customer_id;
            if (custId) {
              await createDraftInvoiceForBooking({
                customerId: custId,
                bookingId,
                sessionId,
                trackmanBookingId: booking.trackman_booking_id || null,
                feeLineItems: voidRecoveryItems,
                purpose: 'booking_fee',
              });
              logger.info('[BookingInvoice] syncBookingInvoice recreated draft invoice after void/uncollectible recovery', {
                extra: { bookingId, sessionId, totalCents: voidRecoveryTotal }
              });
            }
          }
        }
        return;
      }
      return;
    }

    const participantResult = await db.execute(sql`SELECT id, display_name, participant_type, cached_fee_cents
       FROM booking_participants
       WHERE session_id = ${sessionId} AND cached_fee_cents > 0`);

    const feeLineItems: BookingFeeLineItem[] = (participantResult.rows as unknown as ParticipantFeeRow[]).map((row) => {
      const totalCents = row.cached_fee_cents;
      const isGuest = row.participant_type === PARTICIPANT_TYPE.GUEST;
      return {
        participantId: row.id,
        displayName: row.display_name || 'Unknown',
        participantType: row.participant_type as ParticipantType,
        overageCents: isGuest ? 0 : totalCents,
        guestCents: isGuest ? totalCents : 0,
        totalCents,
      };
    });

    if (booking.resource_type !== RESOURCE_TYPE.CONFERENCE_ROOM) {
      const allParticipantResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM booking_participants WHERE session_id = ${sessionId}`);
      const actualCount = parseInt((allParticipantResult.rows[0] as { cnt: string }).cnt, 10) || 0;
      const declaredCount = booking.declared_player_count || actualCount;
      const emptySlots = Math.max(0, declaredCount - actualCount);
      if (emptySlots > 0) {
        const emptySlotFeeCents = emptySlots * PRICING.GUEST_FEE_CENTS;
        feeLineItems.push({
          displayName: `Empty Slot${emptySlots > 1 ? 's' : ''}`,
          participantType: PARTICIPANT_TYPE.GUEST,
          overageCents: 0,
          guestCents: emptySlotFeeCents,
          totalCents: emptySlotFeeCents,
        });
      }
    }

    const totalFees = feeLineItems.reduce((sum, li) => sum + li.totalCents, 0);

    if (totalFees > 0) {
      await updateDraftInvoiceLineItems({ bookingId, sessionId, feeLineItems });
      logger.info('[BookingInvoice] Draft invoice synced', {
        extra: { bookingId, sessionId, invoiceId: stripeInvoiceId, totalFees, lineItems: feeLineItems.length }
      });
    } else {
      await stripe.invoices.del(stripeInvoiceId);
      await db.execute(sql`UPDATE booking_requests SET stripe_invoice_id = NULL, updated_at = NOW() WHERE id = ${bookingId}`);
      logger.info('[BookingInvoice] Deleted draft invoice (fees now 0)', {
        extra: { bookingId, sessionId, invoiceId: stripeInvoiceId }
      });

      safeBroadcast({ bookingId, sessionId, action: 'invoice_deleted', invoiceId: stripeInvoiceId });
    }
  } catch (err: unknown) {
    logger.warn('[BookingInvoice] Non-blocking: syncBookingInvoice failed', {
      extra: { error: getErrorMessage(err), bookingId, sessionId }
    });
  }
}

export async function isBookingInvoicePaid(bookingId: number): Promise<{ locked: boolean; invoiceId?: string; reason?: string }> {
  try {
    const bookingResult = await db.execute(sql`SELECT stripe_invoice_id FROM booking_requests WHERE id = ${bookingId} LIMIT 1`);
    const invoiceId = (bookingResult.rows as unknown as BookingInvoiceIdRow[])[0]?.stripe_invoice_id;
    if (!invoiceId) return { locked: false };

    try {
      const stripe = await getStripeClient();
      const invoice = await stripe.invoices.retrieve(invoiceId);
      if (invoice.status === 'paid') {
        return { locked: true, invoiceId, reason: 'Invoice has been paid' };
      }
      return { locked: false };
    } catch (stripeErr) {
      logger.warn('[BookingInvoice] Stripe check failed, falling back to local fee snapshot', {
        extra: { bookingId, invoiceId, error: getErrorMessage(stripeErr) }
      });
      try {
        const completedSnapshot = await db.execute(sql`
          SELECT id, total_cents FROM booking_fee_snapshots
          WHERE booking_id = ${bookingId}
            AND status = 'completed'
            AND total_cents > 0
          LIMIT 1
        `);
        const snapshot = (completedSnapshot.rows as unknown as Array<{ id: number; total_cents: number }>)[0];
        if (snapshot) {
          return { locked: true, invoiceId, reason: 'Invoice has been paid (verified from completed payment snapshot)' };
        }
        return { locked: false };
      } catch (fallbackErr) {
        logger.error('[BookingInvoice] Both Stripe and local fallback failed for invoice check', {
          extra: { bookingId, invoiceId, error: getErrorMessage(fallbackErr) }
        });
        return { locked: true, invoiceId, reason: 'Unable to verify invoice status — locked as a precaution' };
      }
    }
  } catch (dbErr) {
    logger.error('[BookingInvoice] DB query failed in isBookingInvoicePaid — locking as precaution', {
      extra: { bookingId, error: getErrorMessage(dbErr) }
    });
    return { locked: true, reason: 'Unable to verify invoice status — locked as a precaution' };
  }
}

function extractPaymentIntentId(invoice: Stripe.Invoice): string | null {
  const rawPi = (invoice as unknown as { payment_intent: string | Stripe.PaymentIntent | null }).payment_intent;
  if (typeof rawPi === 'string') return rawPi;
  if (rawPi && typeof rawPi === 'object' && 'id' in rawPi) return rawPi.id;
  return null;
}

function computeBalanceApplied(invoice: Stripe.Invoice): number {
  const startingBalance = invoice.starting_balance || 0;
  const endingBalance = invoice.ending_balance || 0;
  return Math.max(0, Math.abs(startingBalance) - Math.abs(endingBalance));
}

export interface BookingPaymentStatus {
  allPaid: boolean;
  hasPaidFees: boolean;
  pendingFeeCount: number;
  totalWithFees: number;
  paidCount: number;
  hasCompletedSnapshot: boolean;
}

export async function checkBookingPaymentStatus(params: {
  bookingId: number;
  sessionId: number;
  hasEmptySlots?: boolean;
}): Promise<BookingPaymentStatus> {
  const { bookingId, sessionId, hasEmptySlots = false } = params;

  const [paidCheck, feeSnapshotCheck] = await Promise.all([
    db.execute(sql`SELECT 
         COUNT(*) FILTER (WHERE payment_status IN (${PAYMENT_STATUS.PAID}, ${PAYMENT_STATUS.WAIVED})) as paid_count,
         COUNT(*) FILTER (WHERE cached_fee_cents > 0 OR payment_status IN (${PAYMENT_STATUS.PAID}, ${PAYMENT_STATUS.WAIVED})) as total_with_fees,
         COUNT(*) FILTER (WHERE cached_fee_cents > 0 AND payment_status NOT IN (${PAYMENT_STATUS.PAID}, ${PAYMENT_STATUS.WAIVED})) as pending_count
       FROM booking_participants 
       WHERE session_id = ${sessionId}`),
    db.execute(sql`SELECT id, total_cents FROM booking_fee_snapshots 
       WHERE session_id = ${sessionId} AND status IN ('completed', 'paid') 
       ORDER BY created_at DESC LIMIT 1`),
  ]);

  interface PaidRow { paid_count: string; total_with_fees: string; pending_count: string }
  const row = paidCheck.rows[0] as unknown as PaidRow;
  const paidCount = parseInt(row?.paid_count || '0', 10);
  const totalWithFees = parseInt(row?.total_with_fees || '0', 10);
  const pendingFeeCount = parseInt(row?.pending_count || '0', 10);
  const hasCompletedSnapshot = feeSnapshotCheck.rows.length > 0;
  const hasPaidFees = paidCount > 0;

  let allPaid = !hasEmptySlots && (
    (hasCompletedSnapshot && pendingFeeCount === 0) ||
    (pendingFeeCount === 0 && hasPaidFees)
  );

  if (allPaid) {
    const invoiceStatus = await isBookingInvoicePaid(bookingId);
    if (invoiceStatus.locked === false && hasPaidFees) {
      const hasSucceededPi = await db.execute(
        sql`SELECT 1 FROM stripe_payment_intents WHERE booking_id = ${bookingId} AND status = 'succeeded' LIMIT 1`
      );
      if (hasSucceededPi.rows.length === 0) {
        allPaid = false;
      }
    }
  }

  return { allPaid, hasPaidFees, pendingFeeCount, totalWithFees, paidCount, hasCompletedSnapshot };
}
