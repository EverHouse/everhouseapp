import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { logAndRespond, logger } from '../../core/logger';
import { getSessionUser } from '../../types/session';
import { notifyMember } from '../../core/notificationService';
import { computeFeeBreakdown, recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { consumeGuestPassForParticipant, canUseGuestPass } from '../../core/billing/guestPassConsumer';
import { cancelPaymentIntent } from '../../core/stripe';
import { logFromRequest, logPaymentAudit } from '../../core/auditLog';
import { PRICING } from '../../core/billing/pricingConfig';
import { broadcastMemberStatsUpdated, broadcastBookingInvoiceUpdate } from '../../core/websocket';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { getErrorMessage } from '../../utils/errorUtils';
import { toIntArrayLiteral, toTextArrayLiteral } from '../../utils/sqlArrayLiteral';
import { syncBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { settleBookingInvoiceAfterCheckin } from './shared';
import type {
  PaymentBookingRow,
  ParticipantStatusRow,
  PaymentIntentIdRow,
  PendingParticipantRow,
  UserIdRow,
  CountRow,
  OverduePayment,
} from './shared';

const router = Router();

router.patch('/api/bookings/:id/payments', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const staffEmail = sessionUser.email;
    const staffName = sessionUser.name || null;

    const { participantId, action, reason } = req.body;

    if (!action || !['confirm', 'waive', 'use_guest_pass', 'confirm_all', 'waive_all', 'cancel_all'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be confirm, waive, use_guest_pass, confirm_all, waive_all, or cancel_all' });
    }

    if (action === 'waive' && !reason) {
      return res.status(400).json({ error: 'Reason required for waiving payment' });
    }

    const bookingResult = await db.execute(sql`
      SELECT br.session_id, br.user_email as owner_email, r.name as resource_name,
             br.resource_id, br.request_date as booking_date, br.start_time, br.end_time,
             br.declared_player_count,
             COALESCE(br.user_name, u.first_name || ' ' || u.last_name) as owner_name
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
      WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = (bookingResult.rows as unknown as PaymentBookingRow[])[0];
    let sessionId: number | null = booking.session_id;

    if (sessionId) {
      try {
        await recalculateSessionFees(sessionId, 'staff_action');
        syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
          logger.warn('[StaffCheckin] Invoice sync failed after fee recalculation', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
        });
      } catch (calcError: unknown) {
        logger.error('[StaffCheckin] Failed to recalculate fees before payment action', { extra: { error: getErrorMessage(calcError) } });
      }
    }

    if (action === 'confirm' || action === 'waive' || action === 'use_guest_pass') {
      if (!participantId) {
        return res.status(400).json({ error: 'participantId required for individual payment action' });
      }

      const newStatus = action === 'confirm' ? 'paid' : 'waived';
      
      const participantResult = await db.execute(sql`SELECT bp.payment_status, bp.participant_type, bp.display_name, bs.session_date
         FROM booking_participants bp
         LEFT JOIN booking_sessions bs ON bp.session_id = bs.id
         WHERE bp.id = ${participantId}`);
      
      const participant = (participantResult.rows as unknown as ParticipantStatusRow[])[0];
      const previousStatus = participant?.payment_status || 'pending';
      const isGuest = participant?.participant_type === 'guest';
      const guestName = participant?.display_name || 'Guest';
      const sessionDate = participant?.session_date ? new Date(participant.session_date) : new Date();
      
      const useGuestPass = action === 'use_guest_pass' || 
        (action === 'waive' && isGuest && 
          (reason?.toLowerCase().includes('guest pass') || reason?.toLowerCase().includes('pass')));
      
      if (useGuestPass && sessionId) {
        if (!isGuest) {
          return res.status(400).json({ 
            error: 'Guest pass can only be used for guest participants, not members or owners'
          });
        }
        
        const passCheck = await canUseGuestPass(booking.owner_email);
        
        if (!passCheck.canUse) {
          return res.status(400).json({ 
            error: `No guest passes remaining. ${booking.owner_email} has ${passCheck.remaining}/${passCheck.total} passes available.`
          });
        }
        
        const consumeResult = await consumeGuestPassForParticipant(
          participantId,
          booking.owner_email,
          guestName,
          sessionId,
          sessionDate,
          staffEmail
        );
        
        if (!consumeResult.success) {
          return res.status(400).json({ 
            error: consumeResult.error || 'Failed to consume guest pass'
          });
        }
        
        await logPaymentAudit({
          bookingId,
          sessionId,
          participantId,
          action: 'guest_pass_used',
          staffEmail,
          staffName,
          reason: `Guest pass consumed for ${guestName}. ${consumeResult.passesRemaining} passes remaining.`,
          previousStatus,
          newStatus: 'waived',
        });

        logFromRequest(req, 'update_payment_status', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
          participantId,
          participantName: guestName,
          action: 'guest_pass_used',
          newStatus: 'waived',
          passesRemaining: consumeResult.passesRemaining
        });
        
        if (consumeResult.passesRemaining !== undefined) {
          try { broadcastMemberStatsUpdated(booking.owner_email, { guestPasses: consumeResult.passesRemaining }); } catch (err: unknown) {logger.error('[Broadcast] Stats update error', { error: getErrorMessage(err) }); }
        }
        
        settleBookingInvoiceAfterCheckin(bookingId, sessionId, booking.owner_email).catch((err: unknown) => {
          logger.error('[StaffCheckin] Failed to settle booking invoice after check-in', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
        });

        broadcastBookingInvoiceUpdate({ bookingId, sessionId, action: 'fees_waived', memberEmail: booking.owner_email });

        return res.json({ 
          success: true, 
          message: `Guest pass used for ${guestName}. ${consumeResult.passesRemaining} passes remaining.`,
          participantId,
          newStatus: 'waived',
          guestPassConsumed: true,
          passesRemaining: consumeResult.passesRemaining
        });
      }

      await db.execute(sql`UPDATE booking_participants SET payment_status = ${newStatus} WHERE id = ${participantId}`);

      await logPaymentAudit({
        bookingId,
        sessionId,
        participantId,
        action: action === 'confirm' ? 'payment_confirmed' : 'payment_waived',
        staffEmail,
        staffName,
        reason: reason || null,
        previousStatus,
        newStatus,
      });

      logFromRequest(req, 'update_payment_status', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        participantId,
        participantName: guestName,
        action: action === 'confirm' ? 'payment_confirmed' : 'payment_waived',
        previousStatus,
        newStatus,
        reason: reason || null
      });


      settleBookingInvoiceAfterCheckin(bookingId, sessionId, booking.owner_email).catch((err: unknown) => {
        logger.error('[StaffCheckin] Invoice settlement failed after check-in — requires manual review', {
          extra: { bookingId, sessionId, error: getErrorMessage(err) }
        });
      });

      broadcastBookingInvoiceUpdate({ 
        bookingId, 
        sessionId: sessionId ?? undefined, 
        action: action === 'confirm' ? 'payment_confirmed' : 'fees_waived', 
        memberEmail: booking.owner_email 
      });

      return res.json({ 
        success: true, 
        message: `Payment ${action === 'confirm' ? 'confirmed' : 'waived'} for participant`,
        participantId,
        newStatus
      });
    }

    if (action === 'cancel_all') {
      let cancelledCount = 0;
      let failedCount = 0;

      const intentIds = new Set<string>();

      const spiResult = await db.execute(sql`
        SELECT stripe_payment_intent_id FROM stripe_payment_intents
        WHERE booking_id = ${bookingId}
          AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation', 'requires_capture')
      `);
      for (const row of spiResult.rows as unknown as PaymentIntentIdRow[]) {
        if (row.stripe_payment_intent_id) {
          intentIds.add(row.stripe_payment_intent_id);
        }
      }

      if (sessionId) {
        const bpResult = await db.execute(sql`
          SELECT stripe_payment_intent_id FROM booking_participants
          WHERE session_id = ${sessionId}
            AND stripe_payment_intent_id IS NOT NULL
            AND stripe_payment_intent_id != ''
            AND payment_status = 'pending'
            AND stripe_payment_intent_id NOT LIKE 'balance-%'
        `);
        for (const row of bpResult.rows as unknown as PaymentIntentIdRow[]) {
          if (row.stripe_payment_intent_id) {
            intentIds.add(row.stripe_payment_intent_id);
          }
        }
      }

      for (const piId of intentIds) {
        try {
          const result = await cancelPaymentIntent(piId);
          if (result.success) {
            cancelledCount++;
          } else {
            failedCount++;
            logger.warn('[StaffCheckin] Failed to cancel payment intent', { extra: { piId, error: result.error } });
          }
        } catch (err: unknown) {
          failedCount++;
          logger.error('[StaffCheckin] Error cancelling payment intent', { extra: { piId, error: getErrorMessage(err) } });
        }
      }

      if (intentIds.size > 0) {
        const intentArray = Array.from(intentIds);
        await db.execute(sql`
          UPDATE stripe_payment_intents SET status = 'cancelled', updated_at = NOW()
          WHERE stripe_payment_intent_id = ANY(${toTextArrayLiteral(intentArray)}::text[])
        `);
      }

      if (sessionId) {
        await db.execute(sql`
          UPDATE booking_participants SET payment_status = 'waived'
          WHERE session_id = ${sessionId} AND payment_status = 'pending'
        `);
      }

      await logPaymentAudit({
        bookingId,
        sessionId,
        participantId: null,
        action: 'payment_cancelled',
        staffEmail,
        staffName,
        reason: reason || `Cancelled ${cancelledCount} payment intent(s)`,
        previousStatus: 'pending',
        newStatus: 'waived',
      });

      logFromRequest(req, 'cancel_payment', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        cancelledCount,
        failedCount,
        intentsCancelled: Array.from(intentIds)
      });

      return res.json({
        success: true,
        message: `${cancelledCount} payment(s) cancelled`,
        cancelledCount,
        failedCount
      });
    }

    if (action === 'confirm_all' || action === 'waive_all') {
      if (!sessionId) {
        if (!booking.resource_id || !booking.booking_date || !booking.start_time || !booking.end_time) {
          return res.status(400).json({ error: 'Booking is missing required fields to create a session' });
        }
        try {
          const bookingDuration = Math.round(
            (new Date(`2000-01-01T${booking.end_time}`).getTime() - 
             new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000
          );

          const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.owner_email})`);
          const userId = (userResult.rows as unknown as UserIdRow[])[0]?.id || null;

          const sessionResult = await ensureSessionForBooking({
            bookingId,
            resourceId: booking.resource_id,
            sessionDate: booking.booking_date,
            startTime: booking.start_time,
            endTime: booking.end_time,
            ownerEmail: booking.owner_email || '',
            ownerName: booking.owner_name,
            ownerUserId: userId?.toString() || undefined,
            source: 'staff_manual',
            createdBy: 'payment_action'
          });
          if (sessionResult.error) {
            logger.error('[Payment Action] Session creation failed', { extra: { bookingId, error: sessionResult.error } });
          }
          sessionId = sessionResult.sessionId || null;

          if (sessionId) {
            const playerCount = booking.declared_player_count || 1;
            const existingGuests = await db.execute(sql`
              SELECT COUNT(*) as count FROM booking_participants 
              WHERE session_id = ${sessionId} AND participant_type = 'guest'
            `);
            const existingGuestCount = parseInt((existingGuests.rows as unknown as CountRow[])[0]?.count || '0', 10);
            const guestsToCreate = playerCount - 1 - existingGuestCount;
            if (guestsToCreate > 0) {
              const guestNumbers = Array.from({length: guestsToCreate}, (_, i) => existingGuestCount + i + 2);
              const guestNames = guestNumbers.map(n => `Guest ${n}`);
              await db.execute(sql`
                INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
                SELECT ${sessionId}, NULL, 'guest', name, 'pending', ${bookingDuration}
                FROM unnest(${toTextArrayLiteral(guestNames)}::text[]) AS t(name)
              `);
            }

            await recalculateSessionFees(sessionId, 'staff_action');
            syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
              logger.warn('[StaffCheckin] Invoice sync failed after session creation', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
            });
          }
        } catch (sessionErr: unknown) {
          logger.error('[StaffCheckin] Failed to create session for payment action', { extra: { bookingId, error: getErrorMessage(sessionErr) } });
        }
      }

      if (!sessionId) {
        return res.status(400).json({ error: 'No session found for this booking and could not create one' });
      }

      const newStatus = action === 'confirm_all' ? 'paid' : 'waived';

      const pendingParticipants = await db.execute(sql`SELECT id, payment_status FROM booking_participants 
         WHERE session_id = ${sessionId} AND payment_status = 'pending'`);

      const typedPending = pendingParticipants.rows as unknown as PendingParticipantRow[];
      const pendingIds = typedPending.map(p => p.id);
      const previousStatuses = typedPending.map(p => p.payment_status);
      if (pendingIds.length > 0) {
        await db.execute(sql`UPDATE booking_participants SET payment_status = ${newStatus} WHERE id = ANY(${toIntArrayLiteral(pendingIds)}::int[])`);

        const auditAction = action === 'confirm_all' ? 'payment_confirmed' : 'payment_waived';
        for (let i = 0; i < pendingIds.length; i++) {
          await logPaymentAudit({
            bookingId,
            sessionId,
            participantId: pendingIds[i],
            action: auditAction,
            staffEmail,
            staffName,
            reason: reason || null,
            previousStatus: previousStatuses[i],
            newStatus,
          });
        }
      }

      if (action === 'confirm_all') {
        try {
          const existingSnapshotCheck = await db.execute(
            sql`SELECT id FROM booking_fee_snapshots WHERE session_id = ${sessionId} AND status IN ('completed', 'paid') LIMIT 1`
          );
          if (existingSnapshotCheck.rows.length === 0) {
            const breakdown = await computeFeeBreakdown({ sessionId: sessionId!, source: 'checkin' as const });
            const participantFees: Array<{id: number | null; amountCents: number; type: string; description: string}> = [];
            for (const p of breakdown.participants) {
              if (!p.participantId) continue;
              if (p.totalCents <= 0) continue;
              let feeType = 'booking_fee';
              let feeDesc = p.displayName || 'Fee';
              if (p.overageCents > 0 && p.guestCents === 0) {
                feeType = 'overage';
                feeDesc = `${p.displayName || 'Owner'} overage`;
              } else if (p.guestCents > 0 && p.overageCents === 0) {
                feeType = 'guest_fee';
                feeDesc = `Guest: ${p.displayName || 'Guest'}`;
              } else if (p.overageCents > 0 && p.guestCents > 0) {
                feeType = 'overage_and_guest';
                feeDesc = `${p.displayName || 'Member'} overage + guest fee`;
              }
              participantFees.push({ id: p.participantId, amountCents: p.totalCents, type: feeType, description: feeDesc });
            }
            if (breakdown.totals && breakdown.totals.guestCents > 0) {
              const emptySlotTotal = breakdown.participants
                .filter(p => !p.participantId && p.guestCents > 0)
                .reduce((sum, p) => sum + p.guestCents, 0);
              if (emptySlotTotal > 0) {
                const slotCount = breakdown.participants.filter(p => !p.participantId && p.guestCents > 0).length;
                const perSlot = slotCount > 0 ? (emptySlotTotal / slotCount / 100).toFixed(0) : '';
                participantFees.push({
                  id: null,
                  amountCents: emptySlotTotal,
                  type: 'guest_fee',
                  description: `${slotCount} empty slot${slotCount > 1 ? 's' : ''}${perSlot ? ` × $${perSlot}` : ''}`
                });
              }
            }
            const totalCents = breakdown.totals.totalCents;

            const insertResult = await db.execute(sql`
              INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status, created_at)
              VALUES (${bookingId}, ${sessionId}, ${JSON.stringify(participantFees)}, ${totalCents}, 'completed', NOW())
              ON CONFLICT (session_id) WHERE status = 'completed' DO NOTHING
              RETURNING id
            `);
            if (insertResult.rowCount === 0) {
              logger.info('[StaffCheckin] Fee snapshot race: another check-in already created snapshot for session', { extra: { sessionId } });
            } else {
              logger.info('[StaffCheckin] Created fee snapshot for booking , session , total cents', { extra: { bookingId, sessionId, totalCents } });
            }
          } else {
            logger.info('[StaffCheckin] Fee snapshot already exists for session , skipping', { extra: { sessionId } });
          }
        } catch (snapshotErr: unknown) {
          logger.error('[StaffCheckin] Failed to create fee snapshot', { extra: { error: getErrorMessage(snapshotErr) } });
        }

        const recentCheckinNotif = await db.execute(
          sql`SELECT id FROM notifications 
           WHERE user_email = ${booking.owner_email} AND title = 'Checked In' AND related_id = ${bookingId} AND related_type = 'booking'
           AND created_at > NOW() - INTERVAL '60 seconds'
           LIMIT 1`
        );
        if (recentCheckinNotif.rows.length === 0) {
          await notifyMember({
            userEmail: booking.owner_email,
            title: 'Checked In',
            message: `You've been checked in for your booking at ${booking.resource_name || 'the facility'}`,
            type: 'booking',
            relatedId: bookingId,
            relatedType: 'booking',
            url: '/sims'
          });
        } else {
          logger.info('[StaffCheckin] Skipped duplicate Checked In notification for booking', { extra: { bookingId, ownerEmail: booking.owner_email } });
        }
      }


      logFromRequest(req, 'update_payment_status', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        action: action === 'confirm_all' ? 'confirm_all' : 'waive_all',
        participantCount: typedPending.length,
        newStatus: newStatus,
        reason: reason || null
      });

      settleBookingInvoiceAfterCheckin(bookingId, sessionId, booking.owner_email).catch((err: unknown) => {
        logger.error('[StaffCheckin] Invoice settlement failed after check-in — requires manual review', {
          extra: { bookingId, sessionId, error: getErrorMessage(err) }
        });
      });

      broadcastBookingInvoiceUpdate({ 
        bookingId, 
        sessionId, 
        action: action === 'confirm_all' ? 'payment_confirmed' : 'fees_waived', 
        memberEmail: booking.owner_email 
      });

      return res.json({ 
        success: true, 
        message: `All payments ${action === 'confirm_all' ? 'confirmed' : 'waived'}`,
        updatedCount: typedPending.length
      });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update payment status', error);
  }
});

router.get('/api/bookings/overdue-payments', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await db.execute(sql`
      WITH overdue_bookings AS (
        SELECT 
          br.id as booking_id,
          br.session_id,
          br.user_email as owner_email,
          br.user_name as owner_name,
          br.request_date as booking_date,
          br.start_time,
          br.end_time,
          r.name as resource_name,
          br.declared_player_count,
          COUNT(DISTINCT bp.id) FILTER (WHERE bp.id IS NOT NULL) as filled_participant_count,
          COALESCE(SUM(
            CASE 
              WHEN bp.payment_status = 'pending'
              THEN COALESCE(bp.cached_fee_cents, 0) / 100.0
              ELSE 0 
            END
          ), 0)::numeric as total_outstanding
        FROM booking_requests br
        LEFT JOIN resources r ON br.resource_id = r.id
        LEFT JOIN booking_participants bp ON bp.session_id = br.session_id
        WHERE br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND br.request_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date - INTERVAL '30 days'
          AND br.session_id IS NOT NULL
          AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
          AND br.is_unmatched IS NOT TRUE
          AND br.user_email NOT LIKE '%unmatched%'
          AND br.user_email NOT LIKE '%@trackman.import%'
          AND NOT EXISTS (
            SELECT 1 FROM booking_fee_snapshots bfs 
            WHERE bfs.session_id = br.session_id AND bfs.status IN ('completed', 'paid')
          )
        GROUP BY br.id, br.session_id, br.user_email, br.user_name, 
                 br.request_date, br.start_time, br.end_time, r.name, br.declared_player_count
        HAVING SUM(
          CASE WHEN bp.payment_status = 'pending' 
               AND COALESCE(bp.cached_fee_cents, 0) > 0
          THEN 1 ELSE 0 END
        ) > 0
      )
      SELECT * FROM overdue_bookings
      ORDER BY booking_date DESC
    `);

    const overduePayments: OverduePayment[] = result.rows.map((row: Record<string, unknown>) => {
      const bookingDate = row.booking_date instanceof Date 
        ? row.booking_date.toISOString().split('T')[0]
        : String(row.booking_date || '').split('T')[0];
      const declaredPlayers = parseInt(String(row.declared_player_count), 10) || 1;
      const filledPlayers = parseInt(String(row.filled_participant_count), 10) || 0;
      const unfilledGuests = Math.max(0, declaredPlayers - filledPlayers);
      const guestFeePerSlot = PRICING.GUEST_FEE_DOLLARS;
      const unfilledGuestFees = unfilledGuests * guestFeePerSlot;
      const dbOutstanding = parseFloat(String(row.total_outstanding)) || 0;
      return {
        bookingId: row.booking_id as number,
        sessionId: row.session_id as number,
        ownerEmail: row.owner_email as string,
        ownerName: (row.owner_name || row.owner_email) as string,
        bookingDate,
        startTime: row.start_time as string,
        endTime: row.end_time as string,
        resourceName: (row.resource_name || 'Unknown') as string,
        totalOutstanding: dbOutstanding + unfilledGuestFees
      };
    });

    res.json(overduePayments);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to get overdue payments', error);
  }
});

export default router;
