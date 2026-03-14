import { db } from '../../db';
import { bookingRequests, resources, notifications, bookingParticipants, stripePaymentIntents } from '../../../shared/schema';
import { eq, and, or, ne, sql, isNull, isNotNull } from 'drizzle-orm';
import { sendPushNotification } from '../../routes/push';
import { formatNotificationDateTime } from '../../utils/dateUtils';
import { logger } from '../logger';
import { notifyAllStaff } from '../notificationService';
import { bookingEvents } from '../bookingEvents';
import { sendNotificationToUser, broadcastAvailabilityUpdate } from '../websocket';
import { refundGuestPass } from '../../routes/guestPasses';
import { getCalendarNameForBayAsync } from '../../routes/bays/helpers';
import { getCalendarIdByName, deleteCalendarEvent } from '../calendar/index';
import { voidBookingInvoice } from '../billing/bookingInvoiceService';
import { getErrorMessage } from '../../utils/errorUtils';
import { toIntArrayLiteral } from '../../utils/sqlArrayLiteral';
import { queueJob } from '../jobQueue';
import { voidBookingPass } from '../../walletPass/bookingPassService';

interface CancelResult {
  success: boolean;
  status: 'cancelled' | 'cancellation_pending';
  bookingId: number;
  bookingData: {
    userEmail: string;
    userName: string | null;
    resourceId: number | null;
    requestDate: string;
    startTime: string;
    calendarEventId: string | null;
    sessionId: number | null;
    trackmanBookingId: string | null;
  };
  sideEffectErrors?: string[];
  alreadyCancelled?: boolean;
  error?: string;
  statusCode?: number;
}

interface SideEffectsManifest {
  stripeRefunds: Array<{ paymentIntentId: string; type: 'refund' | 'cancel'; idempotencyKey: string; amountCents?: number }>;
  stripeSnapshotRefunds: Array<{ paymentIntentId: string; idempotencyKey: string; amountCents?: number }>;
  balanceRefunds: Array<{ stripeCustomerId: string; amountCents: number; bookingId: number; balanceRecordId: string; description: string }>;
  invoiceVoid: { bookingId: number } | null;
  calendarDeletion: { eventId: string; resourceId: number | null } | null;
  notifications: {
    staffNotification?: { title: string; message: string };
    memberPush?: { email: string; title: string; body: string };
    memberWebSocket?: { email: string; title: string; message: string; bookingId: number };
  };
  availabilityBroadcast: { resourceId?: number; resourceType: string; date: string } | null;
  bookingEvent: { bookingId: number; memberEmail: string; status: string; actionBy: string; bookingDate: string; startTime: string } | null;
}

interface BookingRecord {
  id: number;
  userEmail: string;
  userName: string | null;
  resourceId: number | null;
  requestDate: string;
  startTime: string;
  status: string | null;
  calendarEventId: string | null;
  sessionId: number | null;
  trackmanBookingId: string | null;
  staffNotes: string | null;
}

interface FeeSnapshotRow {
  id: number;
  stripe_payment_intent_id: string;
  snapshot_status: string;
  total_cents: number;
}

interface BalancePaymentRow {
  stripe_payment_intent_id: string;
  stripe_customer_id: string;
  amount_cents: number;
}

export class BookingStateService {
  static async cancelBooking(params: {
    bookingId: number;
    source: 'staff' | 'member' | 'trackman_webhook' | 'system';
    cancelledBy?: string;
    staffNotes?: string;
    staffEmail?: string;
  }): Promise<CancelResult> {
    const { bookingId, source, cancelledBy, staffNotes, staffEmail: _staffEmail } = params;

    let booking: BookingRecord;
    try {
      const [existing] = await db.select({
        id: bookingRequests.id,
        userEmail: bookingRequests.userEmail,
        userName: bookingRequests.userName,
        resourceId: bookingRequests.resourceId,
        requestDate: bookingRequests.requestDate,
        startTime: bookingRequests.startTime,
        status: bookingRequests.status,
        calendarEventId: bookingRequests.calendarEventId,
        sessionId: bookingRequests.sessionId,
        trackmanBookingId: bookingRequests.trackmanBookingId,
        staffNotes: bookingRequests.staffNotes,
      })
        .from(bookingRequests)
        .where(eq(bookingRequests.id, bookingId));

      if (!existing) {
        return {
          success: false,
          status: 'cancelled',
          bookingId,
          bookingData: { userEmail: '', userName: null, resourceId: null, requestDate: '', startTime: '', calendarEventId: null, sessionId: null, trackmanBookingId: null },
          error: 'Booking request not found',
          statusCode: 404,
        };
      }
      booking = existing;
    } catch (err: unknown) {
      return {
        success: false,
        status: 'cancelled',
        bookingId,
        bookingData: { userEmail: '', userName: null, resourceId: null, requestDate: '', startTime: '', calendarEventId: null, sessionId: null, trackmanBookingId: null },
        error: getErrorMessage(err),
        statusCode: 500,
      };
    }

    if (booking.status === 'cancelled') {
      return {
        success: true,
        status: 'cancelled',
        bookingId,
        bookingData: this.extractBookingData(booking),
      };
    }

    if (booking.status === 'cancellation_pending' && source !== 'trackman_webhook') {
      return {
        success: true,
        status: 'cancellation_pending',
        bookingId,
        bookingData: this.extractBookingData(booking),
      };
    }

    const isTrackmanLinked = !!booking.trackmanBookingId && /^\d+$/.test(booking.trackmanBookingId);
    const wasApproved = booking.status === 'approved';
    const needsPendingCancel = isTrackmanLinked && wasApproved && source !== 'trackman_webhook';

    if (needsPendingCancel) {
      return this.handlePendingCancellationFlow(bookingId, booking, source, cancelledBy);
    }

    let resourceType = 'simulator';
    if (booking.resourceId) {
      const [resource] = await db.select({ type: resources.type }).from(resources).where(eq(resources.id, booking.resourceId));
      if (resource?.type === 'conference_room') resourceType = 'conference_room';
    }

    const memberCancelled = cancelledBy === booking.userEmail;
    const friendlyDateTime = formatNotificationDateTime(booking.requestDate, booking.startTime || '00:00');
    const statusLabel = wasApproved ? 'booking' : 'booking request';

    const manifest = await db.transaction(async (tx) => {
      const sideEffects: SideEffectsManifest = {
        stripeRefunds: [],
        stripeSnapshotRefunds: [],
        balanceRefunds: [],
        invoiceVoid: { bookingId },
        calendarDeletion: booking.calendarEventId ? { eventId: booking.calendarEventId, resourceId: booking.resourceId } : null,
        notifications: {},
        availabilityBroadcast: { resourceId: booking.resourceId || undefined, resourceType, date: booking.requestDate },
        bookingEvent: { bookingId, memberEmail: booking.userEmail, status: 'cancelled', actionBy: memberCancelled ? 'member' : 'staff', bookingDate: booking.requestDate, startTime: booking.startTime || '' },
      };

      const allSnapshots = await tx.execute(sql`
        SELECT id, stripe_payment_intent_id, status as snapshot_status, total_cents
        FROM booking_fee_snapshots
        WHERE booking_id = ${bookingId} AND stripe_payment_intent_id IS NOT NULL
      `);

      for (const snapshot of allSnapshots.rows as unknown as FeeSnapshotRow[]) {
        sideEffects.stripeSnapshotRefunds.push({
          paymentIntentId: snapshot.stripe_payment_intent_id,
          amountCents: snapshot.total_cents,
          idempotencyKey: `refund_cancel_snapshot_${bookingId}_${snapshot.stripe_payment_intent_id}`,
        });
      }

      const otherIntents = await tx.select({ stripePaymentIntentId: stripePaymentIntents.stripePaymentIntentId, amountCents: stripePaymentIntents.amountCents })
        .from(stripePaymentIntents)
        .where(and(
          eq(stripePaymentIntents.bookingId, bookingId),
        ));

      const snapshotPiIds = new Set((allSnapshots.rows as unknown as FeeSnapshotRow[]).map((s) => s.stripe_payment_intent_id));
      const piBookingAmounts = new Map<string, number>();
      for (const row of otherIntents) {
        piBookingAmounts.set(row.stripePaymentIntentId, row.amountCents || 0);
        if (!snapshotPiIds.has(row.stripePaymentIntentId)) {
          sideEffects.stripeRefunds.push({
            paymentIntentId: row.stripePaymentIntentId,
            type: 'refund',
            amountCents: row.amountCents || undefined,
            idempotencyKey: `refund_cancel_orphan_${bookingId}_${row.stripePaymentIntentId}`,
          });
        }
      }

      if (booking.sessionId) {
        const paidParticipants = await tx.select({
          id: bookingParticipants.id,
          stripePaymentIntentId: bookingParticipants.stripePaymentIntentId,
          cachedFeeCents: bookingParticipants.cachedFeeCents,
          displayName: bookingParticipants.displayName,
        })
          .from(bookingParticipants)
          .where(and(
            eq(bookingParticipants.sessionId, booking.sessionId),
            eq(bookingParticipants.paymentStatus, 'paid'),
            isNotNull(bookingParticipants.stripePaymentIntentId),
            ne(bookingParticipants.stripePaymentIntentId, ''),
            sql`${bookingParticipants.stripePaymentIntentId} NOT LIKE 'balance-%'`,
            isNull(bookingParticipants.refundedAt),
          ));

        for (const participant of paidParticipants) {
          if (participant.stripePaymentIntentId && !snapshotPiIds.has(participant.stripePaymentIntentId)) {
            const participantAmount = participant.cachedFeeCents && participant.cachedFeeCents > 0
              ? participant.cachedFeeCents
              : piBookingAmounts.get(participant.stripePaymentIntentId) || undefined;
            sideEffects.stripeRefunds.push({
              paymentIntentId: participant.stripePaymentIntentId,
              type: 'refund',
              amountCents: participantAmount,
              idempotencyKey: `refund_cancel_participant_${bookingId}_${participant.stripePaymentIntentId}`,
            });
          }
        }

        const balancePaymentRecords = await tx.execute(sql`
          SELECT stripe_payment_intent_id, stripe_customer_id, amount_cents
          FROM stripe_payment_intents
          WHERE booking_id = ${bookingId}
            AND stripe_payment_intent_id LIKE 'balance-%'
            AND status = 'succeeded'
        `);

        for (const rec of balancePaymentRecords.rows as unknown as BalancePaymentRow[]) {
          if (rec.stripe_customer_id && rec.amount_cents > 0) {
            sideEffects.balanceRefunds.push({
              stripeCustomerId: rec.stripe_customer_id,
              amountCents: rec.amount_cents,
              bookingId,
              balanceRecordId: rec.stripe_payment_intent_id,
              description: `Refund for cancelled booking #${bookingId}`,
            });
          }
        }

        await tx.update(bookingParticipants)
          .set({ cachedFeeCents: 0, paymentStatus: 'waived' })
          .where(and(
            eq(bookingParticipants.sessionId, booking.sessionId),
            or(
              eq(bookingParticipants.paymentStatus, 'pending'),
              isNull(bookingParticipants.paymentStatus),
            ),
          ));

        if (paidParticipants.length > 0) {
          const paidParticipantIds = paidParticipants.map(p => p.id);
          await tx.execute(sql`UPDATE booking_participants SET payment_status = 'refund_pending' WHERE id = ANY(${toIntArrayLiteral(paidParticipantIds)}::int[])`);
        }

      }

      await tx.execute(sql`
        DELETE FROM guest_pass_holds WHERE booking_id = ${bookingId}
      `);

      if (booking.sessionId) {
        await tx.execute(sql`
          DELETE FROM usage_ledger
          WHERE session_id = ${booking.sessionId}
          AND LOWER(member_id) = LOWER(${booking.userEmail})
          AND NOT EXISTS (
            SELECT 1 FROM booking_requests br
            WHERE br.session_id = ${booking.sessionId}
            AND br.id != ${bookingId}
            AND LOWER(br.user_email) = LOWER(${booking.userEmail})
            AND br.status NOT IN ('cancelled', 'declined', 'deleted')
          )
        `);
      }

      let updatedStaffNotes = staffNotes || '';
      if (source === 'trackman_webhook') {
        updatedStaffNotes = (booking.staffNotes || '') + ' [Cancelled via Trackman webhook]';
      } else if (booking.trackmanBookingId) {
        const trackmanNote = '[Cancelled in app - needs Trackman cancellation]';
        updatedStaffNotes = updatedStaffNotes ? `${updatedStaffNotes}\n${trackmanNote}` : trackmanNote;
      }

      await tx.update(bookingRequests)
        .set({
          status: 'cancelled',
          isUnmatched: false,
          staffNotes: updatedStaffNotes || undefined,
          updatedAt: new Date(),
        })
        .where(eq(bookingRequests.id, bookingId));

      if (memberCancelled) {
        const staffMessage = `${booking.userName || booking.userEmail} has cancelled their ${statusLabel} for ${friendlyDateTime}.`;
        const memberMessage = `Your ${statusLabel} for ${friendlyDateTime} has been cancelled.`;

        await tx.insert(notifications).values({
          userEmail: booking.userEmail,
          title: 'Booking Cancelled',
          message: memberMessage,
          type: 'booking_cancelled',
          relatedId: bookingId,
          relatedType: 'booking_request',
        });

        sideEffects.notifications.staffNotification = { title: 'Booking Cancelled by Member', message: staffMessage };
        sideEffects.notifications.memberPush = { email: booking.userEmail, title: 'Booking Cancelled', body: memberMessage };
        sideEffects.notifications.memberWebSocket = { email: booking.userEmail, title: 'Booking Cancelled', message: memberMessage, bookingId };
      } else {
        const memberMessage = source === 'trackman_webhook'
          ? `Your booking for ${friendlyDateTime} has been cancelled. Any applicable charges have been refunded.`
          : `Your ${statusLabel} for ${friendlyDateTime} has been cancelled by staff.`;

        await tx.insert(notifications).values({
          userEmail: booking.userEmail,
          title: 'Booking Cancelled',
          message: memberMessage,
          type: 'booking_cancelled',
          relatedId: bookingId,
          relatedType: 'booking_request',
        });

        if (source === 'trackman_webhook') {
          sideEffects.notifications.staffNotification = {
            title: 'Booking Cancelled via TrackMan',
            message: `Booking cancelled via TrackMan: ${booking.userName || booking.userEmail}'s booking for ${friendlyDateTime}`,
          };
        }

        sideEffects.notifications.memberPush = { email: booking.userEmail, title: 'Booking Cancelled', body: memberMessage };
        sideEffects.notifications.memberWebSocket = { email: booking.userEmail, title: 'Booking Cancelled', message: memberMessage, bookingId };
      }

      await tx.update(notifications)
        .set({ isRead: true })
        .where(and(
          eq(notifications.relatedId, bookingId),
          eq(notifications.relatedType, 'booking_request'),
          eq(notifications.type, 'booking'),
        ));

      return sideEffects;
    });

    const { errors } = await BookingStateService.executeSideEffects(manifest);

    return {
      success: true,
      status: 'cancelled',
      bookingId,
      bookingData: this.extractBookingData(booking),
      sideEffectErrors: errors.length > 0 ? errors : undefined,
    };
  }

  static async completePendingCancellation(params: {
    bookingId: number;
    staffEmail: string;
    source: 'trackman_webhook' | 'staff_manual';
  }): Promise<CancelResult> {
    const { bookingId, staffEmail, source } = params;

    const [existing] = await db.select({
      id: bookingRequests.id,
      userEmail: bookingRequests.userEmail,
      userName: bookingRequests.userName,
      resourceId: bookingRequests.resourceId,
      requestDate: bookingRequests.requestDate,
      startTime: bookingRequests.startTime,
      status: bookingRequests.status,
      calendarEventId: bookingRequests.calendarEventId,
      sessionId: bookingRequests.sessionId,
      trackmanBookingId: bookingRequests.trackmanBookingId,
      staffNotes: bookingRequests.staffNotes,
    })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId));

    if (!existing) {
      return {
        success: false,
        status: 'cancelled',
        bookingId,
        bookingData: { userEmail: '', userName: null, resourceId: null, requestDate: '', startTime: '', calendarEventId: null, sessionId: null, trackmanBookingId: null },
        error: 'Booking not found',
        statusCode: 404,
      };
    }

    if (existing.status !== 'cancellation_pending') {
      if (existing.status === 'cancelled') {
        return {
          success: false,
          status: 'cancelled',
          bookingId,
          bookingData: this.extractBookingData(existing),
          alreadyCancelled: true,
          error: 'Booking is already cancelled',
          statusCode: 400,
        };
      }
      return {
        success: false,
        status: 'cancelled',
        bookingId,
        bookingData: this.extractBookingData(existing),
        error: `Cannot complete cancellation — booking status is '${existing.status}', expected 'cancellation_pending'`,
        statusCode: 400,
      };
    }

    let resourceType = 'simulator';
    if (existing.resourceId) {
      const [resource] = await db.select({ type: resources.type }).from(resources).where(eq(resources.id, existing.resourceId));
      if (resource?.type === 'conference_room') resourceType = 'conference_room';
    }

    const friendlyDateTime = formatNotificationDateTime(existing.requestDate, existing.startTime || '00:00');
    const completedByLabel = source === 'trackman_webhook' ? 'Trackman webhook' : `staff (${staffEmail})`;

    const manifest = await db.transaction(async (tx) => {
      const sideEffects: SideEffectsManifest = {
        stripeRefunds: [],
        stripeSnapshotRefunds: [],
        balanceRefunds: [],
        invoiceVoid: { bookingId },
        calendarDeletion: existing.calendarEventId ? { eventId: existing.calendarEventId, resourceId: existing.resourceId } : null,
        notifications: {},
        availabilityBroadcast: { resourceId: existing.resourceId || undefined, resourceType, date: existing.requestDate },
        bookingEvent: { bookingId, memberEmail: existing.userEmail, status: 'cancelled', actionBy: 'staff', bookingDate: existing.requestDate, startTime: existing.startTime || '' },
      };

      const pendingIntents = await tx.select({ stripePaymentIntentId: stripePaymentIntents.stripePaymentIntentId })
        .from(stripePaymentIntents)
        .where(and(
          eq(stripePaymentIntents.bookingId, bookingId),
          sql`${stripePaymentIntents.status} IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')`,
        ));

      for (const row of pendingIntents) {
        sideEffects.stripeRefunds.push({
          paymentIntentId: row.stripePaymentIntentId,
          type: 'cancel',
          idempotencyKey: `cancel_complete_${bookingId}_${row.stripePaymentIntentId}`,
        });
      }

      const allSnapshots = await tx.execute(sql`
        SELECT id, stripe_payment_intent_id, status as snapshot_status, total_cents
        FROM booking_fee_snapshots
        WHERE booking_id = ${bookingId} AND stripe_payment_intent_id IS NOT NULL
      `);

      for (const snapshot of allSnapshots.rows as unknown as FeeSnapshotRow[]) {
        sideEffects.stripeSnapshotRefunds.push({
          paymentIntentId: snapshot.stripe_payment_intent_id,
          amountCents: snapshot.total_cents,
          idempotencyKey: `refund_complete_cancel_snapshot_${bookingId}_${snapshot.stripe_payment_intent_id}`,
        });
      }

      if (existing.sessionId) {
        await tx.update(bookingParticipants)
          .set({ cachedFeeCents: 0, paymentStatus: 'waived' })
          .where(and(
            eq(bookingParticipants.sessionId, existing.sessionId),
            eq(bookingParticipants.paymentStatus, 'pending'),
          ));

        const paidParticipants = await tx.select({
          id: bookingParticipants.id,
          stripePaymentIntentId: bookingParticipants.stripePaymentIntentId,
          cachedFeeCents: bookingParticipants.cachedFeeCents,
          displayName: bookingParticipants.displayName,
        })
          .from(bookingParticipants)
          .where(and(
            eq(bookingParticipants.sessionId, existing.sessionId),
            eq(bookingParticipants.paymentStatus, 'paid'),
            isNotNull(bookingParticipants.stripePaymentIntentId),
            ne(bookingParticipants.stripePaymentIntentId, ''),
            sql`${bookingParticipants.stripePaymentIntentId} NOT LIKE 'balance-%'`,
            isNull(bookingParticipants.refundedAt),
          ));

        const snapshotPiIds = new Set((allSnapshots.rows as unknown as FeeSnapshotRow[]).map((s) => s.stripe_payment_intent_id));
        const piAmounts = new Map<string, number>();
        for (const row of allSnapshots.rows as unknown as FeeSnapshotRow[]) {
          piAmounts.set(row.stripe_payment_intent_id, row.total_cents);
        }
        const piIntentRecords = await tx.select({ stripePaymentIntentId: stripePaymentIntents.stripePaymentIntentId, amountCents: stripePaymentIntents.amountCents })
          .from(stripePaymentIntents)
          .where(eq(stripePaymentIntents.bookingId, bookingId));
        for (const row of piIntentRecords) {
          if (!piAmounts.has(row.stripePaymentIntentId)) {
            piAmounts.set(row.stripePaymentIntentId, row.amountCents || 0);
          }
        }

        for (const participant of paidParticipants) {
          if (participant.stripePaymentIntentId && !snapshotPiIds.has(participant.stripePaymentIntentId)) {
            sideEffects.stripeRefunds.push({
              paymentIntentId: participant.stripePaymentIntentId,
              type: 'refund',
              amountCents: piAmounts.get(participant.stripePaymentIntentId) || undefined,
              idempotencyKey: `refund_complete_participant_${bookingId}_${participant.stripePaymentIntentId}`,
            });
          }
        }

        if (paidParticipants.length > 0) {
          const paidParticipantIds = paidParticipants.map(p => p.id);
          await tx.execute(sql`UPDATE booking_participants SET payment_status = 'refund_pending' WHERE id = ANY(${toIntArrayLiteral(paidParticipantIds)}::int[])`);
        }

        const balancePaymentRecords = await tx.execute(sql`
          SELECT stripe_payment_intent_id, stripe_customer_id, amount_cents
          FROM stripe_payment_intents
          WHERE booking_id = ${bookingId}
            AND stripe_payment_intent_id LIKE 'balance-%'
            AND status = 'succeeded'
        `);

        for (const rec of balancePaymentRecords.rows as unknown as BalancePaymentRow[]) {
          if (rec.stripe_customer_id && rec.amount_cents > 0) {
            sideEffects.balanceRefunds.push({
              stripeCustomerId: rec.stripe_customer_id,
              amountCents: rec.amount_cents,
              bookingId,
              balanceRecordId: rec.stripe_payment_intent_id,
              description: `Refund for cancelled booking #${bookingId}`,
            });
          }
        }

        const guestParticipants = await tx.select({
          id: bookingParticipants.id,
          displayName: bookingParticipants.displayName,
          usedGuestPass: bookingParticipants.usedGuestPass,
        })
          .from(bookingParticipants)
          .where(and(
            eq(bookingParticipants.sessionId, existing.sessionId),
            eq(bookingParticipants.participantType, 'guest'),
          ));

        for (const guest of guestParticipants) {
          if (guest.usedGuestPass) {
            try {
              await refundGuestPass(existing.userEmail || '', guest.displayName || undefined, false);
            } catch (guestErr: unknown) {
              logger.error('[BookingStateService] Failed to refund guest pass', { extra: { error: getErrorMessage(guestErr) } });
            }
          }
        }
      }

      await tx.execute(sql`
        DELETE FROM guest_pass_holds WHERE booking_id = ${bookingId}
      `);

      if (existing.sessionId) {
        await tx.execute(sql`
          DELETE FROM usage_ledger
          WHERE session_id = ${existing.sessionId}
          AND LOWER(member_id) = LOWER(${existing.userEmail})
          AND NOT EXISTS (
            SELECT 1 FROM booking_requests br
            WHERE br.session_id = ${existing.sessionId}
            AND br.id != ${bookingId}
            AND LOWER(br.user_email) = LOWER(${existing.userEmail})
            AND br.status NOT IN ('cancelled', 'declined', 'deleted')
          )
        `);
      }

      const noteAppend = source === 'trackman_webhook'
        ? '\n[Cancellation completed via Trackman webhook]'
        : `\n[Cancellation completed manually by ${staffEmail}]`;

      await tx.update(bookingRequests)
        .set({
          status: 'cancelled',
          isUnmatched: false,
          staffNotes: sql`COALESCE(staff_notes, '') || ${noteAppend}`,
          updatedAt: new Date(),
        })
        .where(eq(bookingRequests.id, bookingId));

      const memberMessage = `Your booking for ${friendlyDateTime} has been cancelled and any charges have been refunded.`;

      await tx.insert(notifications).values({
        userEmail: existing.userEmail || '',
        title: 'Booking Cancelled',
        message: memberMessage,
        type: 'booking_cancelled',
        relatedId: bookingId,
        relatedType: 'booking_request',
      });

      const staffTitle = source === 'trackman_webhook' ? 'Cancellation Completed via TrackMan' : 'Cancellation Completed';
      const staffMsg = `Cancellation completed via ${completedByLabel}: ${existing.userName || existing.userEmail}'s booking for ${friendlyDateTime}`;

      sideEffects.notifications.staffNotification = { title: staffTitle, message: staffMsg };
      sideEffects.notifications.memberPush = { email: existing.userEmail || '', title: 'Booking Cancelled', body: memberMessage };
      sideEffects.notifications.memberWebSocket = { email: existing.userEmail || '', title: 'Booking Cancelled', message: memberMessage, bookingId };

      return sideEffects;
    });

    const { errors } = await BookingStateService.executeSideEffects(manifest);

    logger.info('[BookingStateService] Completed pending cancellation', { extra: { bookingId, staffEmail, source, errorCount: errors.length } });

    return {
      success: true,
      status: 'cancelled',
      bookingId,
      bookingData: this.extractBookingData(existing),
      sideEffectErrors: errors.length > 0 ? errors : undefined,
    };
  }

  private static async handlePendingCancellationFlow(
    bookingId: number,
    booking: BookingRecord,
    _source: string,
    _cancelledBy?: string,
  ): Promise<CancelResult> {
    let bayName = 'Bay';
    if (booking.resourceId) {
      const [resource] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, booking.resourceId));
      if (resource?.name) bayName = resource.name;
    }

    const memberName = booking.userName || booking.userEmail || 'Member';
    const bookingDate = booking.requestDate;
    const bookingTime = booking.startTime?.substring(0, 5) || '';

    await db.transaction(async (tx) => {
      await tx.update(bookingRequests)
        .set({
          status: 'cancellation_pending',
          cancellationPendingAt: new Date(),
          staffNotes: (booking.staffNotes || '') + '\n[Staff initiated cancellation - awaiting Trackman cancellation]',
          updatedAt: new Date(),
        })
        .where(eq(bookingRequests.id, bookingId));

      await tx.insert(notifications).values({
        userEmail: booking.userEmail,
        title: 'Booking Cancellation in Progress',
        message: `Your booking for ${bookingDate} at ${bookingTime} is being cancelled. You'll be notified once it's fully processed.`,
        type: 'cancellation_pending',
        relatedId: bookingId,
        relatedType: 'booking_request',
      });
    });

    const staffMessage = `Booking cancellation pending for ${memberName} on ${bookingDate} at ${bookingTime} (${bayName}). Please cancel in Trackman to complete.`;
    notifyAllStaff(
      'Cancel in Trackman Required',
      staffMessage,
      'booking_cancelled',
      { relatedId: bookingId, relatedType: 'booking_request', url: '/admin/bookings' },
    ).catch(err => logger.error('[BookingStateService] Staff cancellation notification failed', { extra: { error: getErrorMessage(err) } }));

    if (booking.userEmail) {
      sendPushNotification(booking.userEmail, {
        title: 'Booking Cancellation in Progress',
        body: `Your booking for ${bookingDate} at ${bookingTime} is being cancelled. You'll be notified once it's fully processed.`,
        url: '/sims',
      }).catch(err => logger.error('[BookingStateService] Member push notification failed', { extra: { error: getErrorMessage(err) } }));
    }

    return {
      success: true,
      status: 'cancellation_pending',
      bookingId,
      bookingData: this.extractBookingData(booking),
    };
  }

  private static async executeSideEffects(manifest: SideEffectsManifest): Promise<{ errors: string[] }> {
    const errors: string[] = [];

    for (const snapshotRefund of manifest.stripeSnapshotRefunds) {
      try {
        await queueJob('stripe_auto_refund', {
          paymentIntentId: snapshotRefund.paymentIntentId,
          reason: 'requested_by_customer',
          metadata: { reason: 'booking_cancellation_snapshot' },
          amountCents: snapshotRefund.amountCents || undefined,
          idempotencyKey: snapshotRefund.idempotencyKey,
        }, { maxRetries: 5 });
        logger.info('[BookingStateService] Queued snapshot refund job', { extra: { paymentIntentId: snapshotRefund.paymentIntentId } });
      } catch (err: unknown) {
        const msg = `Failed to queue snapshot refund ${snapshotRefund.paymentIntentId.substring(0, 12)}: ${getErrorMessage(err)}`;
        errors.push(msg);
        logger.error('[BookingStateService] Failed to queue snapshot refund job', { extra: { paymentIntentId: snapshotRefund.paymentIntentId, error: getErrorMessage(err) } });
      }
    }

    for (const refundItem of manifest.stripeRefunds) {
      try {
        if (refundItem.type === 'cancel') {
          await queueJob('stripe_cancel_payment_intent', {
            paymentIntentId: refundItem.paymentIntentId,
            markParticipantsRefunded: true,
          }, { maxRetries: 5 });
          logger.info('[BookingStateService] Queued payment intent cancellation job', { extra: { paymentIntentId: refundItem.paymentIntentId } });
        } else {
          await queueJob('stripe_auto_refund', {
            paymentIntentId: refundItem.paymentIntentId,
            reason: 'requested_by_customer',
            metadata: { reason: 'booking_cancellation' },
            amountCents: refundItem.amountCents || undefined,
            idempotencyKey: refundItem.idempotencyKey,
          }, { maxRetries: 5 });
          logger.info('[BookingStateService] Queued refund job', { extra: { paymentIntentId: refundItem.paymentIntentId } });
        }
      } catch (err: unknown) {
        const msg = `Failed to queue refund ${refundItem.paymentIntentId.substring(0, 12)}: ${getErrorMessage(err)}`;
        errors.push(msg);
        logger.error('[BookingStateService] Failed to queue refund job', { extra: { paymentIntentId: refundItem.paymentIntentId, error: getErrorMessage(err) } });
      }
    }

    for (const balanceRefund of manifest.balanceRefunds) {
      try {
        await queueJob('stripe_balance_refund', {
          stripeCustomerId: balanceRefund.stripeCustomerId,
          amountCents: balanceRefund.amountCents,
          description: balanceRefund.description,
          balanceRecordId: balanceRefund.balanceRecordId,
          bookingId: balanceRefund.bookingId,
          idempotencyKey: `balance_refund_${balanceRefund.bookingId}_${balanceRefund.balanceRecordId}`,
        }, { maxRetries: 5 });
        logger.info('[BookingStateService] Queued balance refund job', {
          extra: { bookingId: balanceRefund.bookingId, balanceRecordId: balanceRefund.balanceRecordId, amountCents: balanceRefund.amountCents }
        });
      } catch (err: unknown) {
        const msg = `Failed to queue balance refund for ${balanceRefund.balanceRecordId}: ${getErrorMessage(err)}`;
        errors.push(msg);
        logger.error('[BookingStateService] Failed to queue balance refund job', { extra: { ...balanceRefund, error: getErrorMessage(err) } });
      }
    }

    if (manifest.invoiceVoid) {
      try {
        await voidBookingInvoice(manifest.invoiceVoid.bookingId);
      } catch (err: unknown) {
        const msg = `Failed to void invoice for booking ${manifest.invoiceVoid.bookingId}: ${getErrorMessage(err)}`;
        errors.push(msg);
        logger.error('[BookingStateService] Invoice void failed', { extra: { bookingId: manifest.invoiceVoid.bookingId, error: getErrorMessage(err) } });
      }
    }

    if (manifest.calendarDeletion) {
      try {
        const calendarName = await getCalendarNameForBayAsync(manifest.calendarDeletion.resourceId);
        if (calendarName) {
          const calendarId = await getCalendarIdByName(calendarName);
          if (calendarId) {
            await deleteCalendarEvent(manifest.calendarDeletion.eventId, calendarId);
          }
        }
      } catch (err: unknown) {
        logger.error('[BookingStateService] Calendar deletion failed', { extra: { eventId: manifest.calendarDeletion.eventId, error: getErrorMessage(err) } });
      }
    }

    if (manifest.notifications.staffNotification) {
      notifyAllStaff(
        manifest.notifications.staffNotification.title,
        manifest.notifications.staffNotification.message,
        'booking_cancelled',
        { url: '/admin/bookings' },
      ).catch(err => logger.error('[BookingStateService] Staff notification failed', { extra: { error: getErrorMessage(err) } }));
    }

    if (manifest.notifications.memberPush) {
      sendPushNotification(manifest.notifications.memberPush.email, {
        title: manifest.notifications.memberPush.title,
        body: manifest.notifications.memberPush.body,
        url: '/sims',
      }).catch(err => logger.error('[BookingStateService] Member push failed', { extra: { error: getErrorMessage(err) } }));
    }

    if (manifest.notifications.memberWebSocket) {
      const ws = manifest.notifications.memberWebSocket;
      sendNotificationToUser(ws.email, {
        type: 'notification',
        title: ws.title,
        message: ws.message,
        data: { bookingId: ws.bookingId, eventType: 'booking_cancelled' },
      }, { action: 'booking_cancelled', bookingId: ws.bookingId, triggerSource: 'bookingStateService' });
    }

    if (manifest.availabilityBroadcast) {
      broadcastAvailabilityUpdate({
        resourceId: manifest.availabilityBroadcast.resourceId,
        resourceType: manifest.availabilityBroadcast.resourceType,
        date: manifest.availabilityBroadcast.date,
        action: 'cancelled',
      });
    }

    if (manifest.bookingEvent) {
      bookingEvents.publish('booking_cancelled', {
        bookingId: manifest.bookingEvent.bookingId,
        memberEmail: manifest.bookingEvent.memberEmail,
        bookingDate: manifest.bookingEvent.bookingDate,
        startTime: manifest.bookingEvent.startTime,
        status: manifest.bookingEvent.status,
        actionBy: manifest.bookingEvent.actionBy as 'member' | 'staff',
      }, { notifyMember: false, notifyStaff: true, cleanupNotifications: false }).catch(err => logger.error('[BookingStateService] Booking event publish failed', { extra: { error: getErrorMessage(err) } }));

      voidBookingPass(manifest.bookingEvent.bookingId).catch(err => logger.error('[BookingStateService] Failed to void booking wallet pass:', { extra: { error: getErrorMessage(err) } }));
    }

    return { errors };
  }

  private static extractBookingData(booking: BookingRecord): CancelResult['bookingData'] {
    return {
      userEmail: booking.userEmail,
      userName: booking.userName,
      resourceId: booking.resourceId,
      requestDate: booking.requestDate,
      startTime: booking.startTime,
      calendarEventId: booking.calendarEventId,
      sessionId: booking.sessionId,
      trackmanBookingId: booking.trackmanBookingId,
    };
  }
}
