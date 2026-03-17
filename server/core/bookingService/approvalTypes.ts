import { db } from '../../db';
import { bookingRequests } from '../../../shared/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import { logger } from '../logger';
import { cancelPendingPaymentIntentsForBooking } from '../billing/paymentIntentCleanup';
import { getStripeClient } from '../stripe/client';
import { PaymentStatusService } from '../billing/PaymentStatusService';

type _SqlQueryParam = string | number | boolean | null | Date;

export interface BookingRow {
  id: number;
  userEmail: string;
  userName: string | null;
  resourceId: number | null;
  resourcePreference: string | null;
  requestDate: string;
  startTime: string;
  durationMinutes: number;
  endTime: string;
  notes: string | null;
  status: string | null;
  staffNotes: string | null;
  suggestedTime: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  calendarEventId: string | null;
}

export interface BookingUpdateResult {
  id: number;
  userEmail: string;
  userName: string | null;
  userId: string | null;
  resourceId: number | null;
  requestDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  status: string | null;
  calendarEventId: string | null;
  trackmanBookingId: string | null;
  sessionId: number | null;
  requestParticipants: Array<{ email?: string; type: 'member' | 'guest'; userId?: string; name?: string }> | null;
  memberNotes: string | null;
  notes: string | null;
}

export interface CancelBookingData {
  userEmail: string;
  userName: string | null;
  resourceId: number | null;
  requestDate: string;
  startTime: string;
  calendarEventId: string | null;
  sessionId: number | null;
  status: string | null;
}

export interface CancelPushInfo {
  type: 'both' | 'staff' | 'member';
  email?: string;
  message: string;
  staffMessage?: string;
  memberMessage?: string;
  memberName?: string;
  bookingDate?: string;
  bookingTime?: string;
  bayName?: string;
}

export interface OverageRefundResult {
  refunded?: boolean;
  amountCents?: number;
  error?: string;
}

export function formatBookingRow(row: BookingRow) {
  return {
    id: row.id,
    user_email: row.userEmail,
    user_name: row.userName,
    resource_id: row.resourceId,
    resource_preference: row.resourcePreference,
    request_date: row.requestDate,
    start_time: row.startTime,
    duration_minutes: row.durationMinutes,
    end_time: row.endTime,
    notes: row.notes,
    status: row.status,
    staff_notes: row.staffNotes,
    suggested_time: row.suggestedTime,
    reviewed_by: row.reviewedBy,
    reviewed_at: row.reviewedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    calendar_event_id: row.calendarEventId
  };
}

export async function validateTrackmanId(trackmanBookingId: string, bookingId: number): Promise<{ valid: boolean; error?: string; statusCode?: number; unlinkedFromBookingId?: number }> {
  if (!/^\d+$/.test(trackmanBookingId)) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Trackman Booking ID must be a number (e.g., 19510379). UUIDs and other formats are not valid Trackman IDs.'
    };
  }

  const [duplicate] = await db.select({ id: bookingRequests.id, status: bookingRequests.status, userEmail: bookingRequests.userEmail })
    .from(bookingRequests)
    .where(and(
      eq(bookingRequests.trackmanBookingId, trackmanBookingId),
      ne(bookingRequests.id, bookingId)
    ))
    .limit(1);

  if (duplicate) {
    const terminalStatuses = ['cancelled', 'cancellation_pending', 'declined', 'no_show'];
    if (terminalStatuses.includes(duplicate.status || '')) {
      await db.update(bookingRequests)
        .set({ trackmanBookingId: null })
        .where(eq(bookingRequests.id, duplicate.id));
    } else {
      const [currentBooking] = await db.select({ userEmail: bookingRequests.userEmail })
        .from(bookingRequests)
        .where(eq(bookingRequests.id, bookingId))
        .limit(1);

      const sameEmail = currentBooking?.userEmail && duplicate.userEmail &&
        currentBooking.userEmail.toLowerCase() === duplicate.userEmail.toLowerCase();

      if (sameEmail) {
        const duplicateId = duplicate.id as number;

        const _orphanedSession = await db.transaction(async (tx) => {
          await tx.update(bookingRequests)
            .set({
              trackmanBookingId: null,
              status: 'declined',
              isUnmatched: false,
              staffNotes: sql`COALESCE(staff_notes, '') || ' [Auto-declined: Trackman ID re-linked to booking #' || ${bookingId}::text || ' for the same member]'`,
              reviewedBy: 'system_relink',
              reviewedAt: sql`NOW()`,
              updatedAt: sql`NOW()`
            })
            .where(eq(bookingRequests.id, duplicateId));

          const [session] = await tx.execute(sql`
            SELECT id FROM booking_sessions WHERE id = (
              SELECT session_id FROM booking_requests WHERE id = ${duplicateId}
            )
          `).then(r => r.rows as Array<{ id: number }>);

          if (session?.id) {
            await tx.execute(sql`UPDATE booking_requests SET session_id = NULL WHERE session_id = ${session.id}`);
            await tx.execute(sql`DELETE FROM booking_participants WHERE session_id = ${session.id}`);
            await tx.execute(sql`DELETE FROM booking_sessions WHERE id = ${session.id}`);
            logger.info('[ValidateTrackmanId] Cleaned up orphaned session', {
              extra: { sessionId: session.id, declinedBookingId: duplicateId }
            });
          }

          await tx.execute(sql`UPDATE booking_fee_snapshots SET status = 'cancelled', updated_at = NOW() WHERE booking_id = ${duplicateId} AND status IN ('pending', 'requires_action')`);

          return session;
        });

        try {
          await cancelPendingPaymentIntentsForBooking(duplicateId);
          logger.info('[ValidateTrackmanId] Cleaned up payment intents for orphaned booking', {
            extra: { declinedBookingId: duplicateId }
          });
        } catch (piErr: unknown) {
          logger.warn('[ValidateTrackmanId] Payment intent cleanup failed for orphaned booking (non-blocking)', {
            extra: { declinedBookingId: duplicateId, error: piErr instanceof Error ? piErr.message : String(piErr) }
          });
        }

        try {
          const stripe = await getStripeClient();

          const allSnapshots = await db.execute(sql`
            SELECT id, stripe_payment_intent_id, total_cents
            FROM booking_fee_snapshots
            WHERE booking_id = ${duplicateId} AND stripe_payment_intent_id IS NOT NULL
          `);
          for (const snapshot of allSnapshots.rows as unknown as Array<{ id: number; stripe_payment_intent_id: string; total_cents: number }>) {
            try {
              const pi = await stripe.paymentIntents.retrieve(snapshot.stripe_payment_intent_id);
              if (pi.status === 'succeeded') {
                const refund = await stripe.refunds.create({
                  payment_intent: snapshot.stripe_payment_intent_id,
                  reason: 'requested_by_customer'
                }, {
                  idempotencyKey: `refund_trackman_relink_snapshot_${duplicateId}_${snapshot.stripe_payment_intent_id}`
                });
                await PaymentStatusService.markPaymentRefunded({
                  paymentIntentId: snapshot.stripe_payment_intent_id,
                  bookingId: duplicateId,
                  refundId: refund.id,
                  amountCents: pi.amount
                });
                logger.info('[ValidateTrackmanId] Refunded fee snapshot for orphaned booking', {
                  extra: { paymentIntentId: snapshot.stripe_payment_intent_id, refundId: refund.id, declinedBookingId: duplicateId }
                });
              }
            } catch (snapErr: unknown) {
              logger.warn('[ValidateTrackmanId] Fee snapshot refund failed (non-blocking)', {
                extra: { paymentIntentId: snapshot.stripe_payment_intent_id, error: snapErr instanceof Error ? snapErr.message : String(snapErr) }
              });
            }
          }

          const invoices = await stripe.invoices.search({
            query: `metadata["booking_id"]:"${duplicateId}"`,
            limit: 5
          });
          for (const invoice of invoices.data) {
            if (invoice.status === 'draft') {
              await stripe.invoices.del(invoice.id);
              logger.info('[ValidateTrackmanId] Deleted draft invoice for orphaned booking', {
                extra: { invoiceId: invoice.id, declinedBookingId: duplicateId }
              });
            } else if (invoice.status === 'open') {
              await stripe.invoices.voidInvoice(invoice.id);
              logger.info('[ValidateTrackmanId] Voided open invoice for orphaned booking', {
                extra: { invoiceId: invoice.id, declinedBookingId: duplicateId }
              });
            }
          }
        } catch (invoiceErr: unknown) {
          logger.warn('[ValidateTrackmanId] Stripe cleanup failed for orphaned booking (non-blocking)', {
            extra: { declinedBookingId: duplicateId, error: invoiceErr instanceof Error ? invoiceErr.message : String(invoiceErr) }
          });
        }

        logger.info('[ValidateTrackmanId] Declined orphaned same-member booking', {
          extra: { declinedBookingId: duplicateId, relinkToBookingId: bookingId, trackmanBookingId }
        });

        return { valid: true, unlinkedFromBookingId: duplicateId };
      }

      return {
        valid: false,
        statusCode: 409,
        error: `Trackman Booking ID ${trackmanBookingId} is already linked to another booking (#${duplicate.id}). Each Trackman booking can only be linked once.`
      };
    }
  }

  return { valid: true };
}
