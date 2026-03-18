import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { logAndRespond } from '../../core/logger';
import { computeFeeBreakdown, recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { syncBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { getErrorMessage } from '../../utils/errorUtils';
import { toTextArrayLiteral, toIntArrayLiteral } from '../../utils/sqlArrayLiteral';
import { logger } from '../../core/logger';
import { getStripeClient } from '../../core/stripe/client';
import type {
  BookingContextRow,
  UserIdRow,
  CountRow,
  MemberParticipantRow,
  ParticipantDetailRow,
  SnapshotRow,
  AuditRow,
  ParticipantFee,
  CheckinContext,
} from './shared';

const router = Router();

router.get('/api/bookings/:id/staff-checkin-context', isStaffOrAdmin, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const bookingId = parseInt(req.params.id as string, 10);
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
        r.name as resource_name
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE br.id = ${bookingId}
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = (result.rows as unknown as BookingContextRow[])[0];
    const participants: ParticipantFee[] = [];
    let totalOutstanding = 0;
    
    let sessionId: number | null = booking.session_id;
    if (!sessionId && booking.resource_id) {
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
          createdBy: 'checkin_context'
        });
        if (sessionResult.error) {
          logger.error('[Checkin Context] Session creation failed', { extra: { bookingId, error: sessionResult.error } });
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
          
          await recalculateSessionFees(sessionId, 'checkin');
          syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
            logger.warn('[Checkin Context] Invoice sync failed after fee recalculation', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
          });
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
        for (const p of memberParticipants.rows as unknown as MemberParticipantRow[]) {
          if (!p.user_id || !p.resolved_user_id) {
            orphanedIds.push(p.id as number);
            orphanedNames.push(p.display_name as string);
          }
        }
        
        if (orphanedIds.length > 0) {
          await db.execute(sql`
            DELETE FROM booking_participants WHERE id = ANY(${toIntArrayLiteral(orphanedIds)}::int[])
          `);
          
          logger.info('[Checkin Context Sync] Cleaned up orphaned participants for booking', { extra: { length: orphanedIds.length, bookingId, orphanedNames } });
          await recalculateSessionFees(sessionId, 'sync_cleanup');
          syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
            logger.warn('[Checkin Context Sync] Invoice sync failed after cleanup', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
          });
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
      
      for (const row of snapshotResult.rows as unknown as SnapshotRow[]) {
        const fees = row.participant_fees;
        if (Array.isArray(fees)) {
          for (const fee of fees) {
            if (fee && typeof fee.id === 'number') {
              prepaidParticipantIds.add(fee.id);
            }
          }
        }
      }
      
      for (const p of participantsResult.rows as unknown as ParticipantDetailRow[]) {
        const calculatedFee = feeMap.get(p.participant_id) || 0;
        const cachedFee = parseFloat(p.cached_total_fee) || 0;
        
        const totalFee = cachedFee > 0 ? Math.min(cachedFee, calculatedFee) : calculatedFee;
        
        const breakdownItem = breakdown.participants.find(bp => bp.participantId === p.participant_id);
        const overageFee = breakdownItem ? breakdownItem.overageCents / 100 : 0;
        const guestFee = breakdownItem ? breakdownItem.guestCents / 100 : 0;
        const tierAtBooking = breakdownItem?.tierName || null;
        const dailyAllowance = breakdownItem?.dailyAllowance ?? undefined;
        
        const rawCachedFee = p.cached_total_fee === null ? null : parseFloat(p.cached_total_fee);
        const cachedFeeCentsValue = rawCachedFee === null ? null : Math.round(rawCachedFee * 100);
        const minutesUsed = breakdownItem?.usedMinutesToday ?? undefined;
        
        participants.push({
          participantId: p.participant_id,
          displayName: p.display_name,
          participantType: p.participant_type,
          userId: p.user_id,
          paymentStatus: (p.payment_status || 'pending') as 'pending' | 'paid' | 'waived',
          overageFee,
          guestFee,
          totalFee,
          tierAtBooking,
          dailyAllowance,
          minutesUsed,
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
      SELECT action, staff_email, staff_name, 
             details->>'reason' as reason, created_at
      FROM admin_audit_log
      WHERE resource_type = 'payment' AND resource_id = ${bookingId.toString()}
      ORDER BY created_at DESC
      LIMIT 20
    `);

    let memberAccountBalance: CheckinContext['memberAccountBalance'] | undefined;
    if (booking.owner_email) {
      try {
        const custResult = await db.execute(sql`
          SELECT stripe_customer_id FROM users WHERE LOWER(email) = LOWER(${booking.owner_email}) AND stripe_customer_id IS NOT NULL LIMIT 1
        `);
        const stripeCustomerId = (custResult.rows[0] as { stripe_customer_id: string } | undefined)?.stripe_customer_id || null;
        if (stripeCustomerId) {
          const stripe = await getStripeClient();
          const customer = await stripe.customers.retrieve(stripeCustomerId);
          if (!('deleted' in customer && customer.deleted)) {
            const balance = customer.balance || 0;
            const availableCreditCents = balance < 0 ? Math.abs(balance) : 0;
            if (availableCreditCents > 0) {
              memberAccountBalance = {
                availableCreditCents,
                availableCreditDollars: availableCreditCents / 100,
                stripeCustomerId,
              };
            }
          }
        }
      } catch (balanceErr: unknown) {
        logger.warn('[Checkin Context] Failed to fetch member account balance', { extra: { ownerEmail: booking.owner_email, error: getErrorMessage(balanceErr) } });
      }
    }

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
      memberAccountBalance,
      auditHistory: (auditResult.rows as unknown as AuditRow[]).map(a => ({
        action: a.action,
        staffEmail: a.staff_email,
        staffName: a.staff_name,
        reason: a.reason,
        createdAt: a.created_at
      })),
    };

    res.json(context);
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to get check-in context', error);
  }
});

export default router;
