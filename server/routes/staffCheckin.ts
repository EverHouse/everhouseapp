import { Router, Request, Response } from 'express';
import { db } from '../db';
import { pool } from '../core/db';
import { bookingRequests, bookingParticipants, bookingSessions, usageLedger, bookingPaymentAudit, users } from '../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { logAndRespond, logger } from '../core/logger';
import { getSessionUser } from '../types/session';
import { notifyMember, notifyFeeWaived } from '../core/notificationService';
import { sendFeeWaivedEmail } from '../emails/paymentEmails';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants, recalculateSessionFees } from '../core/billing/unifiedFeeService';
import { consumeGuestPassForParticipant, canUseGuestPass } from '../core/billing/guestPassConsumer';
import { createPrepaymentIntent } from '../core/billing/prepaymentService';
import { cancelPaymentIntent } from '../core/stripe';
import { logFromRequest } from '../core/auditLog';
import { PRICING } from '../core/billing/pricingConfig';
import { enforceSocialTierRules, type ParticipantForValidation } from '../core/bookingService/tierRules';
import { broadcastMemberStatsUpdated } from '../core/websocket';
import { updateHubSpotContactVisitCount } from '../core/memberSync';
import { ensureSessionForBooking } from '../core/bookingService/sessionManager';
import { sendFirstVisitConfirmationEmail } from '../emails/firstVisitEmail';
import { getErrorMessage } from '../utils/errorUtils';
import { processWalkInCheckin } from '../core/walkInCheckinService';
import { finalizeInvoicePaidOutOfBand, voidBookingInvoice, syncBookingInvoice, getBookingInvoiceId } from '../core/billing/bookingInvoiceService';

const router = Router();

async function getMemberDisplayName(email: string): Promise<string> {
  try {
    const normalizedEmail = email.toLowerCase();
    const result = await db.select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .limit(1);
    
    if (result.length > 0 && (result[0].firstName || result[0].lastName)) {
      return [result[0].firstName, result[0].lastName].filter(Boolean).join(' ');
    }
  } catch (error: unknown) {
    logger.error('[StaffCheckin] Error looking up member name', { error: error instanceof Error ? error : new Error(String(error)) });
  }
  return email.split('@')[0];
}

async function settleBookingInvoiceAfterCheckin(bookingId: number, sessionId: number | null): Promise<void> {
  if (!sessionId) return;
  
  try {
    const resourceResult = await pool.query(
      `SELECT r.type FROM resources r JOIN booking_requests br ON br.resource_id = r.id WHERE br.id = $1`,
      [bookingId]
    );
    if (resourceResult.rows[0]?.type === 'conference_room') return;
    
    const invoiceId = await getBookingInvoiceId(bookingId);
    if (!invoiceId) return;
    
    const participantResult = await pool.query(
      `SELECT payment_status, cached_fee_cents FROM booking_participants WHERE session_id = $1`,
      [sessionId]
    );
    
    const participants = participantResult.rows;
    const allSettled = participants.every((p: { payment_status: string }) => 
      p.payment_status === 'paid' || p.payment_status === 'waived'
    );
    
    if (!allSettled) {
      syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
        logger.warn('[StaffCheckin] Non-blocking: Failed to sync invoice after partial action', {
          extra: { bookingId, sessionId, error: (err as Error).message }
        });
      });
      return;
    }
    
    const anyPaid = participants.some((p: { payment_status: string; cached_fee_cents: number }) => 
      p.payment_status === 'paid' && (p.cached_fee_cents || 0) > 0
    );
    
    if (anyPaid) {
      try {
        const userResult = await pool.query(
          `SELECT u.stripe_customer_id FROM users u 
           JOIN booking_requests br ON LOWER(u.email) = LOWER(br.user_email) 
           WHERE br.id = $1 LIMIT 1`,
          [bookingId]
        );
        const customerId = userResult.rows[0]?.stripe_customer_id;
        if (customerId) {
          await finalizeInvoicePaidOutOfBand({
            bookingId,
            paidVia: 'cash',
          });
          logger.info('[StaffCheckin] Finalized invoice as paid OOB after check-in confirm', {
            extra: { bookingId, invoiceId }
          });
        }
      } catch (finalizeErr: unknown) {
        logger.warn('[StaffCheckin] Non-blocking: Failed to finalize invoice OOB', {
          extra: { bookingId, invoiceId, error: (finalizeErr as Error).message }
        });
      }
    } else {
      voidBookingInvoice(bookingId).catch((err: unknown) => {
        logger.warn('[StaffCheckin] Non-blocking: Failed to void invoice after all waived', {
          extra: { bookingId, error: (err as Error).message }
        });
      });
    }
  } catch (err: unknown) {
    logger.warn('[StaffCheckin] Non-blocking: settleBookingInvoiceAfterCheckin failed', {
      extra: { bookingId, sessionId, error: (err as Error).message }
    });
  }
}

interface ParticipantFee {
  participantId: number;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  userId: string | null;
  paymentStatus: 'pending' | 'paid' | 'waived';
  overageFee: number;
  guestFee: number;
  totalFee: number;
  tierAtBooking: string | null;
  dailyAllowance?: number;
  minutesUsed?: number;
  waiverNeedsReview?: boolean;
  guestPassUsed?: boolean;
  prepaidOnline?: boolean;
  cachedFeeCents?: number | null;
}

interface CheckinContext {
  bookingId: number;
  sessionId: number | null;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  memberNotes: string | null;
  participants: ParticipantFee[];
  totalOutstanding: number;
  hasUnpaidBalance: boolean;
  auditHistory: Array<{
    action: string;
    staffEmail: string;
    staffName: string | null;
    reason: string | null;
    createdAt: Date;
  }>;
  overageMinutes: number;
  overageFeeCents: number;
  overagePaid: boolean;
  hasUnpaidOverage: boolean;
}

router.get('/api/bookings/:id/staff-checkin-context', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const result = await db.execute(sql`
      SELECT 
        br.id as booking_id,
        br.session_id,
        br.resource_id,
        u.id as owner_id,
        br.user_email as owner_email,
        br.user_name as owner_name,
        br.request_date as booking_date,
        br.start_time,
        br.end_time,
        br.member_notes,
        br.declared_player_count,
        r.name as resource_name,
        br.overage_minutes,
        br.overage_fee_cents,
        br.overage_paid,
        br.overage_payment_intent_id
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE br.id = ${bookingId}
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = result.rows[0];
    const participants: ParticipantFee[] = [];
    let totalOutstanding = 0;
    
    // If booking has no session, try to find/create one for fee calculation
    let sessionId = booking.session_id;
    if (!sessionId && booking.resource_id) {
      try {
        const bookingDuration = Math.round(
          (new Date(`2000-01-01T${booking.end_time}`).getTime() - 
           new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000
        );
        
        const userResult = await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${booking.owner_email})`);
        const userId = userResult.rows[0]?.id || null;

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
          createdBy: 'checkin_context'
        });
        sessionId = sessionResult.sessionId || null;
        
        if (sessionId) {
          const playerCount = booking.declared_player_count || 1;
          const existingGuests = await db.execute(sql`
            SELECT COUNT(*) as count FROM booking_participants 
            WHERE session_id = ${sessionId} AND participant_type = 'guest'
          `);
          const existingGuestCount = parseInt(existingGuests.rows[0]?.count || '0');
          
          const guestsToCreate = playerCount - 1 - existingGuestCount;
          if (guestsToCreate > 0) {
            const guestNumbers = Array.from({length: guestsToCreate}, (_, i) => existingGuestCount + i + 2);
            const guestNames = guestNumbers.map(n => `Guest ${n}`);
            await db.execute(sql`
              INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
              SELECT ${sessionId}, NULL, 'guest', name, 'pending', ${bookingDuration}
              FROM unnest(${guestNames}::text[]) AS t(name)
            `);
          }
          
          await recalculateSessionFees(sessionId, 'checkin');
        }
      } catch (sessionError: unknown) {
        logger.warn('[Checkin Context] Failed to create session for booking', { extra: { bookingId, error: getErrorMessage(sessionError) } });
      }
    }

    if (sessionId) {
      try {
        const memberParticipants = await db.execute(sql`
          SELECT bp.id, bp.display_name, bp.user_id, u.id as resolved_user_id
          FROM booking_participants bp
          LEFT JOIN users u ON bp.user_id = u.id
          WHERE bp.session_id = ${sessionId} AND bp.participant_type = 'member'
        `);
        
        const orphanedIds: number[] = [];
        const orphanedNames: string[] = [];
        for (const p of memberParticipants.rows) {
          if (!p.user_id || !p.resolved_user_id) {
            orphanedIds.push(p.id);
            orphanedNames.push(p.display_name);
          }
        }
        
        if (orphanedIds.length > 0) {
          await db.execute(sql`
            DELETE FROM booking_participants WHERE id = ANY(${orphanedIds}::int[])
          `);
          
          logger.info('[Checkin Context Sync] Cleaned up orphaned participants for booking', { extra: { length: orphanedIds.length, bookingId, orphanedNames } });
          await recalculateSessionFees(sessionId, 'sync_cleanup');
        }
      } catch (syncError: unknown) {
        logger.warn('[Checkin Context Sync] Non-blocking sync cleanup failed for booking', { extra: { bookingId, error: getErrorMessage(syncError) } });
      }
      
      const participantsResult = await db.execute(sql`
        SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.user_id,
          bp.payment_status,
          bp.waiver_reviewed_at,
          bp.used_guest_pass,
          COALESCE(bp.cached_fee_cents, 0)::numeric / 100.0 as cached_total_fee
        FROM booking_participants bp
        WHERE bp.session_id = ${sessionId}
        ORDER BY 
          CASE bp.participant_type 
            WHEN 'owner' THEN 1 
            WHEN 'member' THEN 2 
            WHEN 'guest' THEN 3 
          END,
          bp.created_at
      `);

      // Compute fees in-memory for display, but DO NOT write to DB on GET request
      // This avoids the anti-pattern of writes during read operations
      const breakdown = await computeFeeBreakdown({
        sessionId: sessionId,
        source: 'checkin' as const
      });
      
      const feeMap = new Map<number, number>();
      for (const p of breakdown.participants) {
        if (p.participantId) {
          feeMap.set(p.participantId, p.totalCents / 100);
        }
      }
      
      const prepaidParticipantIds = new Set<number>();
      const snapshotResult = await db.execute(sql`
        SELECT participant_fees
        FROM booking_fee_snapshots
        WHERE booking_id = ${bookingId}
          AND status = 'completed'
          AND stripe_payment_intent_id IS NOT NULL
      `);
      
      for (const row of snapshotResult.rows) {
        const fees = row.participant_fees;
        if (Array.isArray(fees)) {
          for (const fee of fees) {
            if (fee && typeof fee.id === 'number') {
              prepaidParticipantIds.add(fee.id);
            }
          }
        }
      }
      
      for (const p of participantsResult.rows) {
        const calculatedFee = feeMap.get(p.participant_id) || 0;
        const cachedFee = parseFloat(p.cached_total_fee) || 0;
        
        // Use the lower of cached vs calculated fee - protects members from fee increases
        // while honoring tier upgrades that reduce their fees
        const totalFee = cachedFee > 0 ? Math.min(cachedFee, calculatedFee) : calculatedFee;
        
        const breakdownItem = breakdown.participants.find(bp => bp.participantId === p.participant_id);
        const overageFee = breakdownItem ? breakdownItem.overageCents / 100 : 0;
        const guestFee = breakdownItem ? breakdownItem.guestCents / 100 : 0;
        const tierAtBooking = breakdownItem?.tierName || null;
        const dailyAllowance = breakdownItem?.dailyAllowance ?? undefined;
        
        const waiverNeedsReview = 
          p.participant_type === 'guest' && 
          p.payment_status === 'waived' && 
          !p.used_guest_pass &&
          !p.waiver_reviewed_at;
        
        const rawCachedFee = p.cached_total_fee === null ? null : parseFloat(p.cached_total_fee);
        const cachedFeeCentsValue = rawCachedFee === null ? null : Math.round(rawCachedFee * 100);
        const minutesUsed = breakdownItem?.usedMinutesToday ?? undefined;
        
        participants.push({
          participantId: p.participant_id,
          displayName: p.display_name,
          participantType: p.participant_type,
          userId: p.user_id,
          paymentStatus: p.payment_status || 'pending',
          overageFee,
          guestFee,
          totalFee,
          tierAtBooking,
          dailyAllowance,
          minutesUsed,
          waiverNeedsReview,
          guestPassUsed: p.used_guest_pass || false,
          prepaidOnline: prepaidParticipantIds.has(p.participant_id),
          cachedFeeCents: cachedFeeCentsValue
        });

        if (p.payment_status !== 'paid' && p.payment_status !== 'waived') {
          totalOutstanding += totalFee;
        }
      }
    }

    const auditResult = await db.execute(sql`
      SELECT action, staff_email, staff_name, reason, created_at
      FROM booking_payment_audit
      WHERE booking_id = ${bookingId}
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const overageMinutes = booking.overage_minutes || 0;
    const overageFeeCents = booking.overage_fee_cents || 0;
    const overagePaid = booking.overage_paid ?? (overageFeeCents === 0);
    const hasUnpaidOverage = overageFeeCents > 0 && !overagePaid;

    const context: CheckinContext = {
      bookingId,
      sessionId: sessionId || null,
      ownerId: booking.owner_id || '',
      ownerEmail: booking.owner_email,
      ownerName: booking.owner_name || booking.owner_email,
      bookingDate: booking.booking_date,
      startTime: booking.start_time,
      endTime: booking.end_time,
      resourceName: booking.resource_name || 'Unknown',
      memberNotes: booking.member_notes,
      participants,
      totalOutstanding,
      hasUnpaidBalance: totalOutstanding > 0,
      auditHistory: auditResult.rows.map(a => ({
        action: a.action,
        staffEmail: a.staff_email,
        staffName: a.staff_name,
        reason: a.reason,
        createdAt: a.created_at
      })),
      overageMinutes,
      overageFeeCents,
      overagePaid,
      hasUnpaidOverage,
      ...(hasUnpaidOverage && booking.overage_payment_intent_id && { overagePaymentIntentId: booking.overage_payment_intent_id })
    };

    res.json(context);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to get check-in context', error);
  }
});

router.patch('/api/bookings/:id/payments', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id as string);
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

    const booking = bookingResult.rows[0];
    let sessionId = booking.session_id;

    // Ensure fees are calculated and persisted to DB before taking any payment action
    // This handles the case where we no longer write on GET requests
    if (sessionId) {
      try {
        await recalculateSessionFees(sessionId, 'staff_action');
      } catch (calcError: unknown) {
        logger.error('[StaffCheckin] Failed to recalculate fees before payment action', { extra: { calcError } });
        // Continue with existing values - non-blocking error
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
      
      const participant = participantResult.rows[0];
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
        
        await db.execute(sql`
          INSERT INTO booking_payment_audit 
            (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, previous_status, new_status)
          VALUES (${bookingId}, ${sessionId}, ${participantId}, ${'guest_pass_used'}, ${staffEmail}, ${staffName}, ${`Guest pass consumed for ${guestName}. ${consumeResult.passesRemaining} passes remaining.`}, ${previousStatus}, ${'waived'})
        `);

        logFromRequest(req, 'update_payment_status', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
          participantId,
          participantName: guestName,
          action: 'guest_pass_used',
          newStatus: 'waived',
          passesRemaining: consumeResult.passesRemaining
        });
        
        if (consumeResult.passesRemaining !== undefined) {
          try { broadcastMemberStatsUpdated(booking.owner_email, { guestPasses: consumeResult.passesRemaining }); } catch (err: unknown) {logger.error('[Broadcast] Stats update error:', err); }
        }
        
        settleBookingInvoiceAfterCheckin(bookingId, sessionId).catch(() => {});

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

      await db.execute(sql`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, previous_status, new_status)
        VALUES (${bookingId}, ${sessionId}, ${participantId}, ${action === 'confirm' ? 'payment_confirmed' : 'payment_waived'}, ${staffEmail}, ${staffName}, ${reason || null}, ${previousStatus}, ${newStatus})
      `);

      logFromRequest(req, 'update_payment_status', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        participantId,
        participantName: guestName,
        action: action === 'confirm' ? 'payment_confirmed' : 'payment_waived',
        previousStatus,
        newStatus,
        reason: reason || null
      });

      if (action === 'waive') {
        try {
          const participantEmailResult = await db.execute(sql`SELECT bp.user_email, bp.display_name, bp.cached_fee_cents
             FROM booking_participants bp
             WHERE bp.id = ${participantId}`);
          
          if (participantEmailResult.rows[0]) {
            const { user_email, display_name, cached_fee_cents } = participantEmailResult.rows[0];
            const recipientEmail = user_email || booking.owner_email;
            const feeAmount = (cached_fee_cents || 0) / 100;
            const memberName = display_name || await getMemberDisplayName(recipientEmail);
            
            await notifyFeeWaived(recipientEmail, feeAmount, reason, bookingId);
            
            await sendFeeWaivedEmail(recipientEmail, {
              memberName,
              originalAmount: feeAmount,
              reason,
              bookingDescription: `${booking.resource_name} on ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}`
            });
            
            logger.info('[StaffCheckin] Sent waiver notification to', { extra: { recipientEmail } });
          }
        } catch (notifyErr: unknown) {
          logger.error('[StaffCheckin] Failed to send waiver notification', { extra: { notifyErr } });
        }
      }

      settleBookingInvoiceAfterCheckin(bookingId, sessionId).catch(() => {});

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
          AND status IN ('pending', 'requires_payment_method', 'requires_action', 'requires_confirmation')
      `);
      for (const row of spiResult.rows) {
        if (row.stripe_payment_intent_id) {
          intentIds.add(row.stripe_payment_intent_id as string);
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
        for (const row of bpResult.rows) {
          if (row.stripe_payment_intent_id) {
            intentIds.add(row.stripe_payment_intent_id as string);
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
          WHERE stripe_payment_intent_id = ANY(${intentArray}::text[])
        `);
      }

      if (sessionId) {
        await db.execute(sql`
          UPDATE booking_participants SET payment_status = 'waived'
          WHERE session_id = ${sessionId} AND payment_status = 'pending'
        `);
      }

      await db.execute(sql`
        INSERT INTO booking_payment_audit
          (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, previous_status, new_status)
        VALUES (${bookingId}, ${sessionId}, ${null}, ${'payment_cancelled'}, ${staffEmail}, ${staffName}, ${reason || `Cancelled ${cancelledCount} payment intent(s)`}, ${'pending'}, ${'waived'})
      `);

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
          const userId = userResult.rows[0]?.id || null;

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
          sessionId = sessionResult.sessionId || null;

          if (sessionId) {
            const playerCount = booking.declared_player_count || 1;
            const existingGuests = await db.execute(sql`
              SELECT COUNT(*) as count FROM booking_participants 
              WHERE session_id = ${sessionId} AND participant_type = 'guest'
            `);
            const existingGuestCount = parseInt(existingGuests.rows[0]?.count || '0');
            const guestsToCreate = playerCount - 1 - existingGuestCount;
            if (guestsToCreate > 0) {
              const guestNumbers = Array.from({length: guestsToCreate}, (_, i) => existingGuestCount + i + 2);
              const guestNames = guestNumbers.map(n => `Guest ${n}`);
              await db.execute(sql`
                INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
                SELECT ${sessionId}, NULL, 'guest', name, 'pending', ${bookingDuration}
                FROM unnest(${guestNames}::text[]) AS t(name)
              `);
            }

            await recalculateSessionFees(sessionId, 'staff_action');
          }
        } catch (sessionErr: unknown) {
          logger.error('[StaffCheckin] Failed to create session for payment action', { extra: { sessionErr, bookingId } });
        }
      }

      if (!sessionId) {
        return res.status(400).json({ error: 'No session found for this booking and could not create one' });
      }

      const newStatus = action === 'confirm_all' ? 'paid' : 'waived';

      const pendingParticipants = await db.execute(sql`SELECT id, payment_status FROM booking_participants 
         WHERE session_id = ${sessionId} AND payment_status = 'pending'`);

      const pendingIds = pendingParticipants.rows.map(p => p.id);
      const previousStatuses = pendingParticipants.rows.map(p => p.payment_status);
      if (pendingIds.length > 0) {
        await db.execute(sql`UPDATE booking_participants SET payment_status = ${newStatus} WHERE id = ANY(${pendingIds}::int[])`);

        const auditAction = action === 'confirm_all' ? 'payment_confirmed' : 'payment_waived';
        await db.execute(sql`
          INSERT INTO booking_payment_audit 
            (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, previous_status, new_status)
          SELECT ${bookingId}, ${sessionId}, pid, ${auditAction}, ${staffEmail}, ${staffName}, ${reason || null}, prev_status, ${newStatus}
          FROM unnest(${pendingIds}::int[], ${previousStatuses}::text[]) AS t(pid, prev_status)
        `);
      }

      if (action === 'confirm_all') {
        const snapshotClient = await pool.connect();
        try {
          await snapshotClient.query('BEGIN');
          const existingSnapshot = await snapshotClient.query(
            `SELECT id FROM booking_fee_snapshots WHERE session_id = $1 AND status IN ('completed', 'paid') LIMIT 1`,
            [sessionId]
          );
          if (existingSnapshot.rows.length === 0) {
            const breakdown = await computeFeeBreakdown({ sessionId, source: 'checkin' as const });
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

            const insertResult = await snapshotClient.query(`
              INSERT INTO booking_fee_snapshots (booking_id, session_id, participant_fees, total_cents, status, created_at)
              VALUES ($1, $2, $3, $4, 'completed', NOW())
              ON CONFLICT (session_id) WHERE status = 'completed' DO NOTHING
              RETURNING id
            `, [bookingId, sessionId, JSON.stringify(participantFees), totalCents]);
            if (insertResult.rowCount === 0) {
              await snapshotClient.query('ROLLBACK');
              logger.info('[StaffCheckin] Fee snapshot race: another check-in already created snapshot for session', { extra: { sessionId } });
            } else {
              await snapshotClient.query('COMMIT');
              logger.info('[StaffCheckin] Created fee snapshot for booking , session , total cents', { extra: { bookingId, sessionId, totalCents } });
            }
          } else {
            await snapshotClient.query('ROLLBACK');
            logger.info('[StaffCheckin] Fee snapshot already exists for session , skipping', { extra: { sessionId } });
          }
        } catch (snapshotErr: unknown) {
          await snapshotClient.query('ROLLBACK').catch(() => {});
          logger.error('[StaffCheckin] Failed to create fee snapshot', { extra: { snapshotErr } });
        } finally {
          snapshotClient.release();
        }

        await notifyMember({
          userEmail: booking.owner_email,
          title: 'Checked In',
          message: `You've been checked in for your booking at ${booking.resource_name || 'the facility'}`,
          type: 'booking',
          relatedId: bookingId,
          relatedType: 'booking',
          url: '/sims'
        });
      }

      if (action === 'waive_all' && pendingParticipants.rows.length > 0) {
        try {
          const totalWaivedResult = await db.execute(sql`SELECT COALESCE(SUM(COALESCE(cached_fee_cents, 0)), 0) as total_cents
             FROM booking_participants
             WHERE id = ANY(${pendingParticipants.rows.map(p => p.id)}::int[])`);
          const totalWaived = (parseInt(totalWaivedResult.rows[0]?.total_cents) || 0) / 100;
          const ownerName = await getMemberDisplayName(booking.owner_email);
          
          await notifyFeeWaived(
            booking.owner_email,
            totalWaived,
            reason || 'Bulk waiver applied',
            bookingId
          );
          
          await sendFeeWaivedEmail(booking.owner_email, {
            memberName: ownerName,
            originalAmount: totalWaived,
            reason: reason || 'Bulk waiver applied',
            bookingDescription: `${booking.resource_name} on ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })} (${pendingParticipants.rows.length} participant${pendingParticipants.rows.length > 1 ? 's' : ''})`
          });
          
          logger.info('[StaffCheckin] Sent bulk waiver notification to for participants', { extra: { bookingOwner_email: booking.owner_email, pendingParticipantsRowsLength: pendingParticipants.rows.length } });
        } catch (notifyErr: unknown) {
          logger.error('[StaffCheckin] Failed to send bulk waiver notification', { extra: { notifyErr } });
        }
      }

      logFromRequest(req, 'update_payment_status', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        action: action === 'confirm_all' ? 'confirm_all' : 'waive_all',
        participantCount: pendingParticipants.rows.length,
        newStatus: newStatus,
        reason: reason || null
      });

      settleBookingInvoiceAfterCheckin(bookingId, sessionId).catch(() => {});

      return res.json({ 
        success: true, 
        message: `All payments ${action === 'confirm_all' ? 'confirmed' : 'waived'}`,
        updatedCount: pendingParticipants.rows.length
      });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to update payment status', error);
  }
});

interface OverduePayment {
  bookingId: number;
  sessionId: number;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  totalOutstanding: number;
  unreviewedWaivers: number;
}

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
          ), 0)::numeric as total_outstanding,
          SUM(CASE 
            WHEN bp.participant_type = 'guest' 
              AND bp.payment_status = 'waived' 
              AND bp.waiver_reviewed_at IS NULL
              AND COALESCE(bp.used_guest_pass, FALSE) = FALSE
            THEN 1 ELSE 0 
          END) as unreviewed_waivers
        FROM booking_requests br
        LEFT JOIN resources r ON br.resource_id = r.id
        LEFT JOIN booking_participants bp ON bp.session_id = br.session_id
        WHERE br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND br.request_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date - INTERVAL '30 days'
          AND br.session_id IS NOT NULL
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
        OR SUM(CASE 
            WHEN bp.participant_type = 'guest' 
              AND bp.payment_status = 'waived' 
              AND bp.waiver_reviewed_at IS NULL
              AND COALESCE(bp.used_guest_pass, FALSE) = FALSE
            THEN 1 ELSE 0 
          END) > 0
      )
      SELECT * FROM overdue_bookings
      ORDER BY booking_date DESC
    `);

    const overduePayments: OverduePayment[] = result.rows.map((row: Record<string, unknown>) => {
      const bookingDate = row.booking_date instanceof Date 
        ? row.booking_date.toISOString().split('T')[0]
        : String(row.booking_date || '').split('T')[0];
      const declaredPlayers = parseInt(String(row.declared_player_count)) || 1;
      const filledPlayers = parseInt(String(row.filled_participant_count)) || 0;
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
        totalOutstanding: dbOutstanding + unfilledGuestFees,
        unreviewedWaivers: parseInt(String(row.unreviewed_waivers)) || 0
      };
    });

    res.json(overduePayments);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to get overdue payments', error);
  }
});

router.post('/api/booking-participants/:id/mark-waiver-reviewed', isStaffOrAdmin, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const participantId = parseInt(req.params.id as string);
    if (isNaN(participantId)) {
      return res.status(400).json({ error: 'Invalid participant ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    await client.query('BEGIN');

    const participantCheck = await client.query(`
      SELECT bp.id, bp.session_id, bp.display_name, br.id as booking_id
      FROM booking_participants bp
      JOIN booking_requests br ON br.session_id = bp.session_id
      WHERE bp.id = $1 AND bp.payment_status = 'waived'
    `, [participantId]);

    if (participantCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Waived participant not found or no associated booking' });
    }

    const { session_id: sessionId, booking_id: bookingId, display_name } = participantCheck.rows[0];

    await client.query(`
      UPDATE booking_participants 
      SET waiver_reviewed_at = NOW()
      WHERE id = $1
    `, [participantId]);

    await client.query(`
      INSERT INTO booking_payment_audit 
        (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, amount_affected)
      VALUES ($1, $2, $3, 'payment_waived', $4, $5, 'Staff marked manual waiver as reviewed', 0)
    `, [bookingId, sessionId, participantId, sessionUser.email, sessionUser.name || null]);

    logFromRequest(req, 'review_waiver', 'waiver', participantId.toString(), display_name, {
      bookingId,
      sessionId,
      action: 'waiver_marked_reviewed'
    });

    await client.query('COMMIT');

    res.json({ success: true, participant: { id: participantId, displayName: display_name, waiverReviewedAt: new Date() } });
  } catch (error: unknown) {
    try { await client.query('ROLLBACK'); } catch {}
    logAndRespond(req, res, 500, 'Failed to mark waiver as reviewed', error);
  } finally {
    client.release();
  }
});

router.post('/api/bookings/:bookingId/mark-all-waivers-reviewed', isStaffOrAdmin, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const bookingId = parseInt(req.params.bookingId as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    await client.query('BEGIN');

    const bookingResult = await client.query(`
      SELECT br.session_id, br.user_email as owner_email
      FROM booking_requests br
      WHERE br.id = $1
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { session_id } = bookingResult.rows[0];

    const result = await client.query(`
      UPDATE booking_participants 
      SET waiver_reviewed_at = NOW()
      WHERE session_id = $1 
        AND payment_status = 'waived' 
        AND waiver_reviewed_at IS NULL
      RETURNING id
    `, [session_id]);

    for (const row of result.rows) {
      await client.query(`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, amount_affected)
        VALUES ($1, $2, $3, 'payment_waived', $4, $5, 'Staff marked manual waiver as reviewed', 0)
      `, [bookingId, session_id, row.id, sessionUser.email, sessionUser.name || null]);
    }

    logFromRequest(req, 'review_waiver', 'booking', bookingId.toString(), `Booking #${bookingId}`, {
      action: 'all_waivers_marked_reviewed',
      sessionId: session_id,
      waiverCount: result.rows.length,
      participantIds: result.rows.map(r => r.id)
    });

    await client.query('COMMIT');

    res.json({ success: true, updatedCount: result.rows.length });
  } catch (error: unknown) {
    try { await client.query('ROLLBACK'); } catch {}
    logAndRespond(req, res, 500, 'Failed to mark waivers as reviewed', error);
  } finally {
    client.release();
  }
});

router.post('/api/bookings/bulk-review-all-waivers', isStaffOrAdmin, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE booking_participants
      SET waiver_reviewed_at = NOW()
      WHERE payment_status = 'waived'
        AND waiver_reviewed_at IS NULL
        AND (used_guest_pass IS NULL OR used_guest_pass = FALSE)
        AND created_at < NOW() - INTERVAL '12 hours'
      RETURNING id, session_id
    `);

    const sessionIds = result.rows.map(r => r.session_id);
    const participantIds = result.rows.map(r => r.id);

    if (sessionIds.length > 0) {
      const bookingLookup = await client.query(
        `SELECT br.session_id, br.id as booking_id 
         FROM booking_requests br 
         WHERE br.session_id = ANY($1::int[])`,
        [sessionIds]
      );
      const sessionToBooking = new Map(bookingLookup.rows.map(r => [r.session_id, r.booking_id]));

      const bookingIds = result.rows.map(r => sessionToBooking.get(r.session_id) || null);

      await client.query(`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, amount_affected)
        SELECT bid, sid, pid, 'payment_waived', $1, $2, 'Bulk reviewed by staff', 0
        FROM unnest($3::int[], $4::int[], $5::int[]) AS t(bid, sid, pid)
      `, [sessionUser.email, sessionUser.name || null, bookingIds, sessionIds, participantIds]);
    }

    const updatedCount = result.rows.length;

    logFromRequest(req, 'review_waiver', 'bulk_waiver', 'all', 'Bulk waiver review', {
      action: 'bulk_review_all_stale_waivers',
      count: updatedCount
    });

    await client.query('COMMIT');

    res.json({ success: true, updatedCount });
  } catch (error: unknown) {
    try { await client.query('ROLLBACK'); } catch {}
    logAndRespond(req, res, 500, 'Failed to bulk review waivers', error);
  } finally {
    client.release();
  }
});

router.get('/api/bookings/stale-waivers', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const result = await db.execute(sql`
      SELECT bp.id, bp.display_name, bp.created_at, bp.session_id,
             br.id as request_id, br.request_date, br.start_time, br.end_time,
             br.user_name as booking_owner,
             r.name as resource_name
      FROM booking_participants bp
      JOIN booking_sessions bs ON bp.session_id = bs.id
      JOIN booking_requests br ON br.session_id = bs.id
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE bp.payment_status = 'waived'
        AND bp.waiver_reviewed_at IS NULL
        AND (bp.used_guest_pass IS NULL OR bp.used_guest_pass = FALSE)
        AND bp.created_at < NOW() - INTERVAL '12 hours'
      ORDER BY bp.created_at DESC
    `);

    res.json(result.rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      displayName: row.display_name,
      createdAt: row.created_at,
      sessionId: row.session_id,
      requestId: row.request_id,
      requestDate: row.request_date,
      startTime: row.start_time,
      endTime: row.end_time,
      bookingOwner: row.booking_owner,
      resourceName: row.resource_name
    })));
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to get stale waivers', error);
  }
});

router.post('/api/bookings/:id/staff-direct-add', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id as string);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const staffEmail = sessionUser.email;
    const staffName = sessionUser.name || null;

    const { memberEmail, guestName, guestEmail, overrideReason, participantType } = req.body;

    if (!participantType || !['member', 'guest'].includes(participantType)) {
      return res.status(400).json({ error: 'participantType must be member or guest' });
    }

    const bookingResult = await db.execute(sql`
      SELECT br.session_id, br.resource_id, br.request_date, br.user_email as owner_email, br.user_name, br.start_time, br.end_time
      FROM booking_requests br
      WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    let sessionId = booking.session_id;
    
    // Calculate booking duration for slot_duration on new participants
    const slotDuration = booking.start_time && booking.end_time 
      ? Math.round((new Date(`2000-01-01T${booking.end_time}`).getTime() - 
                   new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000)
      : 60; // fallback to 60 if times missing

    if (!sessionId) {
      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id,
        sessionDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: booking.owner_email || booking.user_email || '',
        ownerName: booking.user_name,
        source: 'staff_manual',
        createdBy: staffEmail
      });
      sessionId = sessionResult.sessionId || null;
      if (!sessionId || sessionResult.error) {
        return res.status(500).json({ error: 'Failed to create billing session. Staff has been notified.' });
      }
    }

    if (participantType === 'guest') {
      const ownerTierResult = await db.execute(sql`
        SELECT mt.name as tier_name, mt.guest_passes_per_month as guest_passes
        FROM users u
        LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
        WHERE LOWER(u.email) = LOWER(${booking.owner_email})
      `);

      if (ownerTierResult.rows.length > 0) {
        const ownerTier = ownerTierResult.rows[0];
        // Use shared tier rules instead of hardcoded check
        const tierCheck = await enforceSocialTierRules(
          ownerTier.tier_name || 'Social',
          [{ type: 'guest', displayName: guestName }]
        );
        if (!tierCheck.allowed) {
          return res.status(400).json({ error: tierCheck.reason });
        }
      }

      if (!guestName) {
        return res.status(400).json({ error: 'guestName required for guest participant' });
      }

      // Check if guest email matches an existing member
      let matchedMember: { id: string; name: string; email: string } | null = null;
      if (guestEmail) {
        const memberCheck = await db.execute(sql`
          SELECT id, COALESCE(name, email) as name, email 
          FROM users 
          WHERE LOWER(email) = LOWER(${guestEmail}) AND archived_at IS NULL
        `);
        if (memberCheck.rows.length > 0) {
          matchedMember = memberCheck.rows[0];
        }
      }

      // If we found a matching member, add them as a member participant instead
      if (matchedMember) {
        // Check if already in roster
        const existingCheck = await db.execute(sql`
          SELECT id FROM booking_participants 
          WHERE session_id = ${sessionId} AND user_id = ${matchedMember.id}
        `);
        
        if (existingCheck.rows.length > 0) {
          return res.status(400).json({ 
            error: `${matchedMember.name} is already in this booking's roster` 
          });
        }

        await db.execute(sql`
          INSERT INTO booking_participants 
            (session_id, user_id, participant_type, display_name, invite_status, payment_status, slot_duration)
          VALUES (${sessionId}, ${matchedMember.id}, 'member', ${matchedMember.name}, 'accepted', 'pending', ${slotDuration})
        `);

        await db.execute(sql`
          INSERT INTO booking_payment_audit 
            (booking_id, session_id, action, staff_email, staff_name, reason, metadata)
          VALUES (${bookingId}, ${sessionId}, 'staff_direct_add', ${staffEmail}, ${staffName}, ${overrideReason || 'Staff direct add - matched to member'}, ${JSON.stringify({ participantType: 'member', guestEmail, matchedUserId: matchedMember.id, matchedName: matchedMember.name })})
        `);

        try {
          await recalculateSessionFees(sessionId, 'staff_add_member');
          
          // Create prepayment intent for any new fees (e.g., overage)
          try {
            const feeResult = await db.execute(sql`
              SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                     SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                     SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
              FROM booking_participants
              WHERE session_id = ${sessionId}
            `);
            
            const totalCents = parseInt(feeResult.rows[0]?.total_cents || '0');
            const overageCents = parseInt(feeResult.rows[0]?.overage_cents || '0');
            const guestCents = parseInt(feeResult.rows[0]?.guest_cents || '0');
            
            if (totalCents > 0) {
              const ownerResult = await db.execute(sql`SELECT id, COALESCE(first_name || ' ' || last_name, email) as name 
                 FROM users WHERE LOWER(email) = LOWER(${booking.owner_email}) LIMIT 1`);
              const owner = ownerResult.rows[0];
              
              const prepayResult = await createPrepaymentIntent({
                sessionId,
                bookingId,
                userId: owner?.id || null,
                userEmail: booking.owner_email,
                userName: owner?.name || booking.owner_email,
                totalFeeCents: totalCents,
                feeBreakdown: { overageCents, guestCents }
              });
              if (prepayResult?.paidInFull) {
                await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = ${sessionId} AND payment_status = 'pending'`);
                logger.info('[Staff Add Member] Prepayment fully covered by credit', { extra: { sessionId, amountDollars: (totalCents/100).toFixed(2) } });
              } else {
                logger.info('[Staff Add Member] Created prepayment intent', { extra: { sessionId, amountDollars: (totalCents/100).toFixed(2) } });
              }
            }
          } catch (prepayErr: unknown) {
            logger.warn('[Staff Add Member] Failed to create prepayment intent', { extra: { sessionId, error: String(prepayErr) } });
          }
        } catch (feeErr: unknown) {
          logger.warn('[Staff Add Guest->Member] Failed to recalculate fees', { extra: { sessionId, error: String(feeErr) } });
        }

        logFromRequest(req, 'direct_add_participant', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
          participantType: 'member',
          originalGuestEmail: guestEmail,
          matchedUserId: matchedMember.id,
          matchedName: matchedMember.name,
          sessionId,
          reason: overrideReason || 'Staff direct add - matched to member'
        });

        return res.json({ 
          success: true, 
          message: `Found existing member "${matchedMember.name}" - added as member (not guest)`,
          sessionId,
          matchedAsMember: true,
          memberName: matchedMember.name
        });
      }

      // No matching member - add as true guest
      await db.execute(sql`
        INSERT INTO booking_participants 
          (session_id, participant_type, display_name, invite_status, payment_status, cached_fee_cents, used_guest_pass, slot_duration)
        VALUES (${sessionId}, 'guest', ${guestName}, 'accepted', 'pending', ${PRICING.GUEST_FEE_CENTS}, false, ${slotDuration})
      `);

      await db.execute(sql`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, action, staff_email, staff_name, reason, metadata)
        VALUES (${bookingId}, ${sessionId}, 'staff_direct_add', ${staffEmail}, ${staffName}, ${overrideReason || 'Staff direct add'}, ${JSON.stringify({ participantType: 'guest', guestName, guestEmail: guestEmail || null })})
      `);

      // Recalculate fees to update all participant fees
      try {
        await recalculateSessionFees(sessionId, 'staff_add_guest');
        
        // Create prepayment intent for the new fees
        try {
          const feeResult = await db.execute(sql`
            SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                   SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                   SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
            FROM booking_participants
            WHERE session_id = ${sessionId}
          `);
          
          const totalCents = parseInt(feeResult.rows[0]?.total_cents || '0');
          const overageCents = parseInt(feeResult.rows[0]?.overage_cents || '0');
          const guestCents = parseInt(feeResult.rows[0]?.guest_cents || '0');
          
          if (totalCents > 0) {
            const ownerResult = await db.execute(sql`SELECT id, COALESCE(first_name || ' ' || last_name, email) as name 
               FROM users WHERE LOWER(email) = LOWER(${booking.owner_email}) LIMIT 1`);
            const owner = ownerResult.rows[0];
            
            const prepayResult = await createPrepaymentIntent({
              sessionId,
              bookingId,
              userId: owner?.id || null,
              userEmail: booking.owner_email,
              userName: owner?.name || booking.owner_email,
              totalFeeCents: totalCents,
              feeBreakdown: { overageCents, guestCents }
            });
            if (prepayResult?.paidInFull) {
              await db.execute(sql`UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = ${sessionId} AND payment_status = 'pending'`);
              logger.info('[Staff Add Guest] Prepayment fully covered by credit', { extra: { sessionId, amountDollars: (totalCents/100).toFixed(2) } });
            } else {
              logger.info('[Staff Add Guest] Created prepayment intent', { extra: { sessionId, amountDollars: (totalCents/100).toFixed(2) } });
            }
          }
        } catch (prepayErr: unknown) {
          logger.warn('[Staff Add Guest] Failed to create prepayment intent', { extra: { sessionId, error: String(prepayErr) } });
        }
      } catch (feeErr: unknown) {
        logger.warn('[Staff Add Guest] Failed to recalculate fees', { extra: { sessionId, error: String(feeErr) } });
      }

      logFromRequest(req, 'direct_add_participant', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        participantType: 'guest',
        guestName,
        sessionId,
        reason: overrideReason || 'Staff direct add'
      });

      return res.json({ 
        success: true, 
        message: `Guest "${guestName}" added directly by staff`,
        sessionId
      });
    }

    if (participantType === 'member') {
      if (!memberEmail) {
        return res.status(400).json({ error: 'memberEmail required for member participant' });
      }

      const memberResult = await db.execute(sql`
        SELECT u.id, u.email, u.name, mt.name as tier_name, mt.can_book_simulators
        FROM users u
        LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
        WHERE LOWER(u.email) = LOWER(${memberEmail})
      `);

      if (memberResult.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const member = memberResult.rows[0];

      const existingParticipant = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId} AND user_id = ${member.id}`);

      if (existingParticipant.rows.length > 0) {
        return res.status(400).json({ error: 'Member is already in this booking' });
      }

      let tierOverrideApplied = false;
      if (!member.can_book_simulators && !overrideReason) {
        return res.status(400).json({ 
          error: `Member's tier (${member.tier_name || 'Unknown'}) cannot book simulators. Provide overrideReason to add anyway.`,
          requiresOverride: true
        });
      }
      if (!member.can_book_simulators && overrideReason) {
        tierOverrideApplied = true;
      }

      // Check if there's a guest entry with matching name that should be converted
      const matchingGuest = await db.execute(sql`SELECT bp.id, bp.display_name
         FROM booking_participants bp
         LEFT JOIN guests g ON bp.guest_id = g.id
         WHERE bp.session_id = ${sessionId} 
           AND bp.participant_type = 'guest'
           AND (LOWER(bp.display_name) = LOWER(${member.name || ''}) OR LOWER(g.email) = LOWER(${member.email}))`);
      
      if (matchingGuest.rowCount && matchingGuest.rowCount > 0) {
        // Remove the guest entry since this person is actually a member
        const guestIds = matchingGuest.rows.map(r => r.id);
        await db.execute(sql`DELETE FROM booking_participants WHERE id = ANY(${guestIds}::int[])`);
        logger.info('[Staff Add Member] Removed duplicate guest entries for member in session', { extra: { guestIdsLength: guestIds.length, memberEmail: member.email, sessionId } });
      }
      
      await db.execute(sql`
        INSERT INTO booking_participants 
          (session_id, user_id, participant_type, display_name, invite_status, payment_status, slot_duration)
        VALUES (${sessionId}, ${member.id}, 'member', ${member.name || member.email}, 'accepted', 'pending', ${slotDuration})
      `);

      await db.execute(sql`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, action, staff_email, staff_name, reason, metadata)
        VALUES (${bookingId}, ${sessionId}, ${tierOverrideApplied ? 'tier_override' : 'staff_direct_add'}, ${staffEmail}, ${staffName}, ${overrideReason || 'Staff direct add'}, ${JSON.stringify({ 
          participantType: 'member', 
          memberEmail: member.email,
          memberName: member.name,
          tierName: member.tier_name,
          tierOverrideApplied
        })})
      `);

      // Recalculate fees to update all participant fees
      try {
        await recalculateSessionFees(sessionId, 'staff_add_member');
      } catch (feeErr: unknown) {
        logger.warn('[Staff Add Member] Failed to recalculate fees for session', { extra: { sessionId, feeErr } });
      }

      logFromRequest(req, 'direct_add_participant', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        participantType: 'member',
        memberName: member.name,
        memberEmail: member.email,
        tierName: member.tier_name,
        tierOverrideApplied,
        sessionId,
        reason: overrideReason || 'Staff direct add'
      });

      return res.json({ 
        success: true, 
        message: `Member "${member.name || member.email}" added directly by staff${tierOverrideApplied ? ' (tier override applied)' : ''}`,
        sessionId,
        tierOverrideApplied
      });
    }

    res.status(400).json({ error: 'Invalid participant type' });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to add participant directly', error);
  }
});

router.post('/api/staff/qr-checkin', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { memberId } = req.body;
    if (!memberId) {
      return res.status(400).json({ error: 'Member ID required' });
    }

    const sessionUser = getSessionUser(req);
    const staffEmail = sessionUser?.email || 'unknown';
    const staffName = sessionUser?.name || null;

    const result = await processWalkInCheckin({
      memberId,
      checkedInBy: staffEmail,
      checkedInByName: staffName,
      source: 'qr'
    });

    if (result.alreadyCheckedIn) {
      return res.status(409).json({ error: result.error, alreadyCheckedIn: true });
    }

    if (!result.success) {
      return res.status(result.error === 'Member not found' ? 404 : 500).json({ error: result.error });
    }

    logFromRequest(req, 'qr_walkin_checkin', 'member', memberId, result.memberName, {
      memberEmail: result.memberEmail,
      tier: result.tier,
      lifetimeVisits: result.lifetimeVisits,
      type: 'walk_in'
    });

    res.json({
      success: true,
      memberName: result.memberName,
      memberEmail: result.memberEmail,
      tier: result.tier,
      lifetimeVisits: result.lifetimeVisits,
      pinnedNotes: result.pinnedNotes,
      membershipStatus: result.membershipStatus
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to process QR check-in', error);
  }
});

export default router;
