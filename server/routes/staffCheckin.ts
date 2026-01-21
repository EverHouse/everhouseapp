import { Router, Request, Response } from 'express';
import { db } from '../db';
import { pool } from '../core/db';
import { bookingRequests, bookingParticipants, bookingSessions, usageLedger, bookingPaymentAudit, users } from '../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { logAndRespond } from '../core/logger';
import { getSessionUser } from '../types/session';
import { notifyMember, notifyFeeWaived } from '../core/notificationService';
import { sendFeeWaivedEmail } from '../emails/paymentEmails';
import { calculateAndCacheParticipantFees } from '../core/billing/feeCalculator';
import { consumeGuestPassForParticipant, canUseGuestPass } from '../core/billing/guestPassConsumer';

const router = Router();

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
  waiverNeedsReview?: boolean;
  guestPassUsed?: boolean;
  prepaidOnline?: boolean;
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
    const bookingId = parseInt(req.params.id);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const result = await pool.query(`
      SELECT 
        br.id as booking_id,
        br.session_id,
        u.id as owner_id,
        br.user_email as owner_email,
        br.user_name as owner_name,
        br.request_date as booking_date,
        br.start_time,
        br.end_time,
        br.member_notes,
        r.name as resource_name,
        br.overage_minutes,
        br.overage_fee_cents,
        br.overage_paid
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      LEFT JOIN users u ON LOWER(u.email) = LOWER(br.user_email)
      WHERE br.id = $1
    `, [bookingId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = result.rows[0];
    const participants: ParticipantFee[] = [];
    let totalOutstanding = 0;

    if (booking.session_id) {
      const participantsResult = await pool.query(`
        SELECT 
          bp.id as participant_id,
          bp.display_name,
          bp.participant_type,
          bp.user_id,
          bp.payment_status,
          bp.waiver_reviewed_at,
          bp.used_guest_pass,
          COALESCE(ul.overage_fee, 0)::numeric as overage_fee,
          COALESCE(ul.guest_fee, 0)::numeric as guest_fee,
          ul.tier_at_booking
        FROM booking_participants bp
        LEFT JOIN users u ON u.id = bp.user_id
        LEFT JOIN booking_requests br ON br.session_id = bp.session_id
        LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
          AND (
            ul.member_id = bp.user_id 
            OR LOWER(ul.member_id) = LOWER(u.email)
            OR (bp.user_id IS NULL AND LOWER(ul.member_id) = LOWER(br.user_email))
          )
        WHERE bp.session_id = $1
        ORDER BY 
          CASE bp.participant_type 
            WHEN 'owner' THEN 1 
            WHEN 'member' THEN 2 
            WHEN 'guest' THEN 3 
          END,
          bp.created_at
      `, [booking.session_id]);

      const allParticipantIds = participantsResult.rows.map(p => p.participant_id);
      const feeResult = await calculateAndCacheParticipantFees(booking.session_id, allParticipantIds);
      
      const feeMap = new Map<number, number>();
      for (const f of feeResult.fees) {
        feeMap.set(f.participantId, f.amountCents / 100);
      }
      
      const prepaidParticipantIds = new Set<number>();
      const snapshotResult = await pool.query(`
        SELECT participant_fees
        FROM booking_fee_snapshots
        WHERE booking_id = $1
          AND status = 'completed'
          AND stripe_payment_intent_id IS NOT NULL
      `, [bookingId]);
      
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
        const ledgerOverageFee = parseFloat(p.overage_fee) || 0;
        const ledgerGuestFee = parseFloat(p.guest_fee) || 0;
        const calculatedFee = feeMap.get(p.participant_id) || 0;
        
        const totalFee = calculatedFee > 0 ? calculatedFee : (ledgerOverageFee + ledgerGuestFee);
        
        const waiverNeedsReview = 
          p.participant_type === 'guest' && 
          p.payment_status === 'waived' && 
          !p.used_guest_pass &&
          !p.waiver_reviewed_at;
        
        participants.push({
          participantId: p.participant_id,
          displayName: p.display_name,
          participantType: p.participant_type,
          userId: p.user_id,
          paymentStatus: p.payment_status || 'pending',
          overageFee: ledgerOverageFee,
          guestFee: ledgerGuestFee > 0 ? ledgerGuestFee : (p.participant_type === 'guest' && calculatedFee > 0 ? calculatedFee : 0),
          totalFee,
          tierAtBooking: p.tier_at_booking,
          waiverNeedsReview,
          guestPassUsed: p.used_guest_pass || false,
          prepaidOnline: prepaidParticipantIds.has(p.participant_id)
        });

        if (p.payment_status !== 'paid' && p.payment_status !== 'waived') {
          totalOutstanding += totalFee;
        }
      }
    }

    const auditResult = await pool.query(`
      SELECT action, staff_email, staff_name, reason, created_at
      FROM booking_payment_audit
      WHERE booking_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [bookingId]);

    const overageMinutes = booking.overage_minutes || 0;
    const overageFeeCents = booking.overage_fee_cents || 0;
    const overagePaid = booking.overage_paid ?? (overageFeeCents === 0);
    const hasUnpaidOverage = overageFeeCents > 0 && !overagePaid;

    const context: CheckinContext = {
      bookingId,
      sessionId: booking.session_id,
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
      hasUnpaidOverage
    };

    res.json(context);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to get check-in context', error);
  }
});

router.patch('/api/bookings/:id/payments', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id);
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

    if (!action || !['confirm', 'waive', 'use_guest_pass', 'confirm_all', 'waive_all'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be confirm, waive, use_guest_pass, confirm_all, or waive_all' });
    }

    if (action === 'waive' && !reason) {
      return res.status(400).json({ error: 'Reason required for waiving payment' });
    }

    const bookingResult = await pool.query(`
      SELECT br.session_id, br.user_email as owner_email, r.name as resource_name
      FROM booking_requests br
      LEFT JOIN resources r ON br.resource_id = r.id
      WHERE br.id = $1
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    const sessionId = booking.session_id;

    if (action === 'confirm' || action === 'waive' || action === 'use_guest_pass') {
      if (!participantId) {
        return res.status(400).json({ error: 'participantId required for individual payment action' });
      }

      const newStatus = action === 'confirm' ? 'paid' : 'waived';
      
      const participantResult = await pool.query(
        `SELECT bp.payment_status, bp.participant_type, bp.display_name, bs.session_date
         FROM booking_participants bp
         LEFT JOIN booking_sessions bs ON bp.session_id = bs.id
         WHERE bp.id = $1`,
        [participantId]
      );
      
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
        
        await pool.query(`
          INSERT INTO booking_payment_audit 
            (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, previous_status, new_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          bookingId,
          sessionId,
          participantId,
          'guest_pass_used',
          staffEmail,
          staffName,
          `Guest pass consumed for ${guestName}. ${consumeResult.passesRemaining} passes remaining.`,
          previousStatus,
          'waived'
        ]);
        
        return res.json({ 
          success: true, 
          message: `Guest pass used for ${guestName}. ${consumeResult.passesRemaining} passes remaining.`,
          participantId,
          newStatus: 'waived',
          guestPassConsumed: true,
          passesRemaining: consumeResult.passesRemaining
        });
      }

      await pool.query(
        `UPDATE booking_participants SET payment_status = $1 WHERE id = $2`,
        [newStatus, participantId]
      );

      await pool.query(`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, previous_status, new_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        bookingId,
        sessionId,
        participantId,
        action === 'confirm' ? 'payment_confirmed' : 'payment_waived',
        staffEmail,
        staffName,
        reason || null,
        previousStatus,
        newStatus
      ]);

      if (action === 'waive') {
        try {
          const participantEmailResult = await pool.query(
            `SELECT bp.user_email, bp.display_name, bp.cached_fee_cents
             FROM booking_participants bp
             WHERE bp.id = $1`,
            [participantId]
          );
          
          if (participantEmailResult.rows[0]) {
            const { user_email, display_name, cached_fee_cents } = participantEmailResult.rows[0];
            const recipientEmail = user_email || booking.owner_email;
            const feeAmount = (cached_fee_cents || 0) / 100;
            const memberName = display_name || recipientEmail.split('@')[0];
            
            await notifyFeeWaived(recipientEmail, feeAmount, reason, bookingId);
            
            await sendFeeWaivedEmail(recipientEmail, {
              memberName,
              originalAmount: feeAmount,
              reason,
              bookingDescription: `${booking.resource_name} on ${new Date().toLocaleDateString()}`
            });
            
            console.log(`[StaffCheckin] Sent waiver notification to ${recipientEmail}`);
          }
        } catch (notifyErr) {
          console.error('[StaffCheckin] Failed to send waiver notification:', notifyErr);
        }
      }

      return res.json({ 
        success: true, 
        message: `Payment ${action === 'confirm' ? 'confirmed' : 'waived'} for participant`,
        participantId,
        newStatus
      });
    }

    if (action === 'confirm_all' || action === 'waive_all') {
      if (!sessionId) {
        return res.status(400).json({ error: 'No session found for this booking' });
      }

      const newStatus = action === 'confirm_all' ? 'paid' : 'waived';

      const pendingParticipants = await pool.query(
        `SELECT id, payment_status FROM booking_participants 
         WHERE session_id = $1 AND payment_status = 'pending'`,
        [sessionId]
      );

      for (const p of pendingParticipants.rows) {
        await pool.query(
          `UPDATE booking_participants SET payment_status = $1 WHERE id = $2`,
          [newStatus, p.id]
        );

        await pool.query(`
          INSERT INTO booking_payment_audit 
            (booking_id, session_id, participant_id, action, staff_email, staff_name, reason, previous_status, new_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          bookingId,
          sessionId,
          p.id,
          action === 'confirm_all' ? 'payment_confirmed' : 'payment_waived',
          staffEmail,
          staffName,
          reason || null,
          p.payment_status,
          newStatus
        ]);
      }

      if (action === 'confirm_all') {
        await notifyMember({
          userEmail: booking.owner_email,
          title: 'Checked In',
          message: `You've been checked in for your booking at ${booking.resource_name || 'the facility'}`,
          type: 'booking',
          relatedId: bookingId,
          relatedType: 'booking',
          url: '/#/bookings'
        });
      }

      if (action === 'waive_all' && pendingParticipants.rows.length > 0) {
        try {
          const totalWaivedResult = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(cached_fee_cents, 0)), 0) as total_cents
             FROM booking_participants
             WHERE id = ANY($1)`,
            [pendingParticipants.rows.map(p => p.id)]
          );
          const totalWaived = (parseInt(totalWaivedResult.rows[0]?.total_cents) || 0) / 100;
          const ownerName = booking.owner_email.split('@')[0];
          
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
            bookingDescription: `${booking.resource_name} on ${new Date().toLocaleDateString()} (${pendingParticipants.rows.length} participant${pendingParticipants.rows.length > 1 ? 's' : ''})`
          });
          
          console.log(`[StaffCheckin] Sent bulk waiver notification to ${booking.owner_email} for ${pendingParticipants.rows.length} participants`);
        } catch (notifyErr) {
          console.error('[StaffCheckin] Failed to send bulk waiver notification:', notifyErr);
        }
      }

      return res.json({ 
        success: true, 
        message: `All payments ${action === 'confirm_all' ? 'confirmed' : 'waived'}`,
        updatedCount: pendingParticipants.rows.length
      });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error: any) {
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
    const result = await pool.query(`
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
          COALESCE(SUM(
            CASE 
              WHEN bp.payment_status = 'pending' AND COALESCE(bp.cached_fee_cents, 0) > 0
              THEN COALESCE(bp.cached_fee_cents, 0) / 100.0
              WHEN bp.payment_status = 'pending' 
              THEN COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0)
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
        LEFT JOIN users pu ON pu.id = bp.user_id
        LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
          AND (ul.member_id = bp.user_id OR LOWER(ul.member_id) = LOWER(pu.email) OR LOWER(ul.member_id) = LOWER(br.user_email))
        WHERE br.request_date < CURRENT_DATE
          AND br.request_date >= CURRENT_DATE - INTERVAL '30 days'
          AND br.session_id IS NOT NULL
        GROUP BY br.id, br.session_id, br.user_email, br.user_name, 
                 br.request_date, br.start_time, br.end_time, r.name
        HAVING SUM(
          CASE WHEN bp.payment_status = 'pending' 
               AND (COALESCE(bp.cached_fee_cents, 0) > 0 
                    OR COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) > 0)
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

    const overduePayments: OverduePayment[] = result.rows.map(row => {
      const bookingDate = row.booking_date instanceof Date 
        ? row.booking_date.toISOString().split('T')[0]
        : String(row.booking_date || '').split('T')[0];
      return {
        bookingId: row.booking_id,
        sessionId: row.session_id,
        ownerEmail: row.owner_email,
        ownerName: row.owner_name || row.owner_email,
        bookingDate,
        startTime: row.start_time,
        endTime: row.end_time,
        resourceName: row.resource_name || 'Unknown',
        totalOutstanding: parseFloat(row.total_outstanding) || 0,
        unreviewedWaivers: parseInt(row.unreviewed_waivers) || 0
      };
    });

    res.json(overduePayments);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to get overdue payments', error);
  }
});

router.post('/api/booking-participants/:id/mark-waiver-reviewed', isStaffOrAdmin, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const participantId = parseInt(req.params.id);
    if (isNaN(participantId)) {
      client.release();
      return res.status(400).json({ error: 'Invalid participant ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      client.release();
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
      client.release();
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

    await client.query('COMMIT');
    client.release();

    res.json({ success: true, participant: { id: participantId, display_name, waiver_reviewed_at: new Date() } });
  } catch (error: any) {
    await client.query('ROLLBACK');
    client.release();
    logAndRespond(req, res, 500, 'Failed to mark waiver as reviewed', error);
  }
});

router.post('/api/bookings/:bookingId/mark-all-waivers-reviewed', isStaffOrAdmin, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const bookingId = parseInt(req.params.bookingId);
    if (isNaN(bookingId)) {
      client.release();
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      client.release();
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
      client.release();
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

    await client.query('COMMIT');
    client.release();

    res.json({ success: true, updatedCount: result.rows.length });
  } catch (error: any) {
    await client.query('ROLLBACK');
    client.release();
    logAndRespond(req, res, 500, 'Failed to mark waivers as reviewed', error);
  }
});

router.post('/api/bookings/:id/staff-direct-add', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const bookingId = parseInt(req.params.id);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }

    const sessionUser = getSessionUser(req);
    if (!sessionUser?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const staffEmail = sessionUser.email;
    const staffName = sessionUser.name || null;

    const { memberEmail, guestName, overrideReason, participantType } = req.body;

    if (!participantType || !['member', 'guest'].includes(participantType)) {
      return res.status(400).json({ error: 'participantType must be member or guest' });
    }

    const bookingResult = await pool.query(`
      SELECT br.session_id, br.user_email as owner_email
      FROM booking_requests br
      WHERE br.id = $1
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    let sessionId = booking.session_id;

    if (!sessionId) {
      const sessionResult = await pool.query(`
        INSERT INTO booking_sessions (resource_id, session_date, start_time, end_time, source, created_by)
        SELECT resource_id, request_date, start_time, end_time, 'staff_manual', $2
        FROM booking_requests WHERE id = $1
        RETURNING id
      `, [bookingId, staffEmail]);
      
      sessionId = sessionResult.rows[0].id;
      
      await pool.query(
        `UPDATE booking_requests SET session_id = $1 WHERE id = $2`,
        [sessionId, bookingId]
      );
    }

    if (participantType === 'guest') {
      const ownerTierResult = await pool.query(`
        SELECT mt.name as tier_name, mt.guest_passes
        FROM users u
        JOIN members m ON m.user_id = u.id
        JOIN member_tiers mt ON m.tier_id = mt.id
        WHERE LOWER(u.email) = LOWER($1)
      `, [booking.owner_email]);

      if (ownerTierResult.rows.length > 0) {
        const ownerTier = ownerTierResult.rows[0];
        if (ownerTier.tier_name?.toLowerCase() === 'social' || ownerTier.guest_passes === 0) {
          return res.status(400).json({ 
            error: 'Cannot add guests for Social tier members. This is a business rule that cannot be overridden.' 
          });
        }
      }

      if (!guestName) {
        return res.status(400).json({ error: 'guestName required for guest participant' });
      }

      await pool.query(`
        INSERT INTO booking_participants 
          (session_id, participant_type, display_name, invite_status, payment_status, cached_fee_cents)
        VALUES ($1, 'guest', $2, 'accepted', 'pending', 2500)
      `, [sessionId, guestName]);

      await pool.query(`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, action, staff_email, staff_name, reason, metadata)
        VALUES ($1, $2, 'staff_direct_add', $3, $4, $5, $6)
      `, [
        bookingId,
        sessionId,
        staffEmail,
        staffName,
        overrideReason || 'Staff direct add',
        JSON.stringify({ participantType: 'guest', guestName })
      ]);

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

      const memberResult = await pool.query(`
        SELECT u.id, u.email, u.name, mt.name as tier_name, mt.can_book_simulators
        FROM users u
        LEFT JOIN members m ON m.user_id = u.id
        LEFT JOIN member_tiers mt ON m.tier_id = mt.id
        WHERE LOWER(u.email) = LOWER($1)
      `, [memberEmail]);

      if (memberResult.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const member = memberResult.rows[0];

      const existingParticipant = await pool.query(
        `SELECT id FROM booking_participants WHERE session_id = $1 AND user_id = $2`,
        [sessionId, member.id]
      );

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

      await pool.query(`
        INSERT INTO booking_participants 
          (session_id, user_id, participant_type, display_name, invite_status, payment_status)
        VALUES ($1, $2, 'member', $3, 'accepted', 'pending')
      `, [sessionId, member.id, member.name || member.email]);

      await pool.query(`
        INSERT INTO booking_payment_audit 
          (booking_id, session_id, action, staff_email, staff_name, reason, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        bookingId,
        sessionId,
        tierOverrideApplied ? 'tier_override' : 'staff_direct_add',
        staffEmail,
        staffName,
        overrideReason || 'Staff direct add',
        JSON.stringify({ 
          participantType: 'member', 
          memberEmail: member.email,
          memberName: member.name,
          tierName: member.tier_name,
          tierOverrideApplied
        })
      ]);

      return res.json({ 
        success: true, 
        message: `Member "${member.name || member.email}" added directly by staff${tierOverrideApplied ? ' (tier override applied)' : ''}`,
        sessionId,
        tierOverrideApplied
      });
    }

    res.status(400).json({ error: 'Invalid participant type' });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to add participant directly', error);
  }
});

export default router;
