import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { isStaffOrAdmin } from '../../core/middleware';
import { logAndRespond, logger } from '../../core/logger';
import { getSessionUser } from '../../types/session';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { createPrepaymentIntent } from '../../core/billing/prepaymentService';
import { logFromRequest, logPaymentAudit } from '../../core/auditLog';
import { PRICING } from '../../core/billing/pricingConfig';
import { enforceSocialTierRules } from '../../core/bookingService/tierRules';
import { broadcastBookingRosterUpdate } from '../../core/websocket';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { getErrorMessage } from '../../utils/errorUtils';
import { toIntArrayLiteral } from '../../utils/sqlArrayLiteral';
import { syncBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { processWalkInCheckin } from '../../core/walkInCheckinService';
import type {
  DirectAddBookingRow,
  TierRow,
  MemberMatchRow,
  FeeSumRow,
  OwnerRow,
  MemberDetailRow,
  MatchingGuestRow,
  QrBookingRow,
} from './shared';

const router = Router();

router.post('/api/bookings/:id/staff-direct-add', isStaffOrAdmin, async (req: Request, res: Response) => {
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

    const { memberEmail: rawMemberEmail, guestName, guestEmail: rawGuestEmail, overrideReason, participantType } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    const guestEmail = rawGuestEmail?.trim()?.toLowerCase();

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

    const booking = (bookingResult.rows as unknown as DirectAddBookingRow[])[0];
    let sessionId: number | null = booking.session_id;
    
    const slotDuration = booking.start_time && booking.end_time 
      ? Math.round((new Date(`2000-01-01T${booking.end_time}`).getTime() - 
                   new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000)
      : 60;

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
        SELECT mt.name as tier_name, mt.guest_passes_per_year as guest_passes
        FROM users u
        LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
        WHERE LOWER(u.email) = LOWER(${booking.owner_email})
      `);

      if (ownerTierResult.rows.length > 0) {
        const ownerTier = (ownerTierResult.rows as unknown as TierRow[])[0];
        const tierCheck = await enforceSocialTierRules(
          ownerTier.tier_name || null,
          [{ type: 'guest', displayName: guestName }]
        );
        if (!tierCheck.allowed) {
          return res.status(400).json({ error: tierCheck.reason });
        }
      }

      if (!guestName) {
        return res.status(400).json({ error: 'guestName required for guest participant' });
      }

      let matchedMember: { id: string; display_name: string; email: string } | null = null;
      if (guestEmail) {
        const memberCheck = await db.execute(sql`
          SELECT id, COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) as display_name, email 
          FROM users 
          WHERE LOWER(email) = LOWER(${guestEmail}) AND archived_at IS NULL
        `);
        if (memberCheck.rows.length > 0) {
          matchedMember = (memberCheck.rows as unknown as MemberMatchRow[])[0];
        }
      }

      if (matchedMember) {
        const existingCheck = await db.execute(sql`
          SELECT id FROM booking_participants 
          WHERE session_id = ${sessionId} AND user_id = ${matchedMember.id}
        `);
        
        if (existingCheck.rows.length > 0) {
          return res.status(400).json({ 
            error: `${matchedMember.display_name} is already in this booking's roster` 
          });
        }

        await db.execute(sql`
          INSERT INTO booking_participants 
            (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
          VALUES (${sessionId}, ${matchedMember.id}, 'member', ${matchedMember.display_name}, 'pending', ${slotDuration})
        `);

        await logPaymentAudit({
          bookingId,
          sessionId,
          action: 'staff_direct_add',
          staffEmail,
          staffName,
          reason: overrideReason || 'Staff direct add - matched to member',
          metadata: { participantType: 'member', guestEmail, matchedUserId: matchedMember.id, matchedName: matchedMember.display_name },
        });

        try {
          await recalculateSessionFees(sessionId, 'staff_add_member');
          syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
            logger.warn('[Staff Add Member] Invoice sync failed after fee recalculation', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
          });
          
          try {
            const feeResult = await db.execute(sql`
              SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                     SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                     SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
              FROM booking_participants
              WHERE session_id = ${sessionId}
            `);
            
            const typedFees = feeResult.rows as unknown as FeeSumRow[];
            const totalCents = parseInt(typedFees[0]?.total_cents || '0', 10);
            const overageCents = parseInt(typedFees[0]?.overage_cents || '0', 10);
            const guestCents = parseInt(typedFees[0]?.guest_cents || '0', 10);
            
            if (totalCents > 0) {
              const ownerResult = await db.execute(sql`SELECT id, COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) as name 
                 FROM users WHERE LOWER(email) = LOWER(${booking.owner_email}) LIMIT 1`);
              const owner = (ownerResult.rows as unknown as OwnerRow[])[0];
              
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
            logger.warn('[Staff Add Member] Failed to create prepayment intent', { extra: { sessionId, error: getErrorMessage(prepayErr) } });
          }
        } catch (feeErr: unknown) {
          logger.warn('[Staff Add Guest->Member] Failed to recalculate fees', { extra: { sessionId, error: getErrorMessage(feeErr) } });
        }

        logFromRequest(req, 'direct_add_participant', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
          participantType: 'member',
          originalGuestEmail: guestEmail,
          matchedUserId: matchedMember.id,
          matchedName: matchedMember.display_name,
          sessionId,
          reason: overrideReason || 'Staff direct add - matched to member'
        });

        broadcastBookingRosterUpdate({
          bookingId,
          sessionId,
          action: 'participant_added',
          memberEmail: booking.owner_email,
        });

        return res.json({ 
          success: true, 
          message: `Found existing member "${matchedMember.display_name}" - added as member (not guest)`,
          sessionId,
          matchedAsMember: true,
          memberName: matchedMember.display_name
        });
      }

      await db.execute(sql`
        INSERT INTO booking_participants 
          (session_id, participant_type, display_name, payment_status, cached_fee_cents, used_guest_pass, slot_duration)
        VALUES (${sessionId}, 'guest', ${guestName}, 'pending', ${PRICING.GUEST_FEE_CENTS}, false, ${slotDuration})
      `);

      await logPaymentAudit({
        bookingId,
        sessionId,
        action: 'staff_direct_add',
        staffEmail,
        staffName,
        reason: overrideReason || 'Staff direct add',
        metadata: { participantType: 'guest', guestName, guestEmail: guestEmail || null },
      });

      try {
        await recalculateSessionFees(sessionId, 'staff_add_guest');
        syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
          logger.warn('[Staff Add Guest] Invoice sync failed after fee recalculation', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
        });
        
        try {
          const feeResult = await db.execute(sql`
            SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                   SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                   SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
            FROM booking_participants
            WHERE session_id = ${sessionId}
          `);
          
          const typedFees2 = feeResult.rows as unknown as FeeSumRow[];
          const totalCents = parseInt(typedFees2[0]?.total_cents || '0', 10);
          const overageCents = parseInt(typedFees2[0]?.overage_cents || '0', 10);
          const guestCents = parseInt(typedFees2[0]?.guest_cents || '0', 10);
          
          if (totalCents > 0) {
            const ownerResult = await db.execute(sql`SELECT id, COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) as name 
               FROM users WHERE LOWER(email) = LOWER(${booking.owner_email}) LIMIT 1`);
            const owner = (ownerResult.rows as unknown as OwnerRow[])[0];
            
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
          logger.warn('[Staff Add Guest] Failed to create prepayment intent', { extra: { sessionId, error: getErrorMessage(prepayErr) } });
        }
      } catch (feeErr: unknown) {
        logger.warn('[Staff Add Guest] Failed to recalculate fees', { extra: { sessionId, error: getErrorMessage(feeErr) } });
      }

      logFromRequest(req, 'direct_add_participant', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        participantType: 'guest',
        guestName,
        sessionId,
        reason: overrideReason || 'Staff direct add'
      });

      broadcastBookingRosterUpdate({
        bookingId,
        sessionId,
        action: 'participant_added',
        memberEmail: booking.owner_email,
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
        SELECT u.id, u.email, u.first_name, u.last_name, mt.name as tier_name, mt.can_book_simulators
        FROM users u
        LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
        WHERE LOWER(u.email) = LOWER(${memberEmail})
      `);

      if (memberResult.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const member = (memberResult.rows as unknown as MemberDetailRow[])[0];

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

      const matchingGuest = await db.execute(sql`SELECT bp.id, bp.display_name
         FROM booking_participants bp
         LEFT JOIN guests g ON bp.guest_id = g.id
         WHERE bp.session_id = ${sessionId} 
           AND bp.participant_type = 'guest'
           AND (LOWER(bp.display_name) = LOWER(${`${member.first_name || ''} ${member.last_name || ''}`.trim() || ''}) OR LOWER(g.email) = LOWER(${member.email}))`);
      
      const memberDisplayName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;

      if (matchingGuest.rowCount && matchingGuest.rowCount > 0) {
        const guestIds = (matchingGuest.rows as unknown as MatchingGuestRow[]).map(r => r.id);
        await db.execute(sql`DELETE FROM booking_participants WHERE id = ANY(${toIntArrayLiteral(guestIds)}::int[])`);
        logger.info('[Staff Add Member] Removed duplicate guest entries for member in session', { extra: { guestIdsLength: guestIds.length, memberEmail: member.email, sessionId } });
      }
      
      await db.execute(sql`
        INSERT INTO booking_participants 
          (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
        VALUES (${sessionId}, ${member.id}, 'member', ${memberDisplayName}, 'pending', ${slotDuration})
      `);

      await logPaymentAudit({
        bookingId,
        sessionId,
        action: tierOverrideApplied ? 'tier_override' : 'staff_direct_add',
        staffEmail,
        staffName,
        reason: overrideReason || 'Staff direct add',
        metadata: { 
          participantType: 'member', 
          memberEmail: member.email,
          memberName: memberDisplayName,
          tierName: member.tier_name,
          tierOverrideApplied
        },
      });

      try {
        await recalculateSessionFees(sessionId, 'staff_add_member');
        syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
          logger.warn('[Staff Add Member] Invoice sync failed after fee recalculation', { extra: { bookingId, sessionId, error: getErrorMessage(err) } });
        });
      } catch (feeErr: unknown) {
        logger.warn('[Staff Add Member] Failed to recalculate fees for session', { extra: { sessionId, error: getErrorMessage(feeErr) } });
      }

      logFromRequest(req, 'direct_add_participant', 'booking', bookingId.toString(), booking.resource_name || `Booking #${bookingId}`, {
        participantType: 'member',
        memberName: memberDisplayName,
        memberEmail: member.email,
        tierName: member.tier_name,
        tierOverrideApplied,
        sessionId,
        reason: overrideReason || 'Staff direct add'
      });

      broadcastBookingRosterUpdate({
        bookingId,
        sessionId,
        action: 'participant_added',
        memberEmail: booking.owner_email,
      });

      return res.json({ 
        success: true, 
        message: `Member "${memberDisplayName}" added directly by staff${tierOverrideApplied ? ' (tier override applied)' : ''}`,
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

    if (!result.success && !result.alreadyCheckedIn) {
      return res.status(result.error === 'Member not found' ? 404 : 500).json({ error: result.error });
    }

    let bookingInfo: { hasBooking: boolean; bookingId?: number; bookingDetails?: { bayName: string; startTime: string; endTime: string; resourceType: string } } = { hasBooking: false };

    if (result.memberEmail) {
      try {
        const bookingResult = await db.execute(sql`
          SELECT br.id, br.start_time, br.end_time, r.name as bay_name, r.type as resource_type
          FROM booking_requests br
          LEFT JOIN resources r ON br.resource_id = r.id
          WHERE (LOWER(br.user_email) = LOWER(${result.memberEmail})
                 OR LOWER(br.user_email) IN (SELECT LOWER(ule.linked_email) FROM user_linked_emails ule WHERE LOWER(ule.primary_email) = LOWER(${result.memberEmail}))
                 OR LOWER(br.user_email) IN (SELECT LOWER(ule.primary_email) FROM user_linked_emails ule WHERE LOWER(ule.linked_email) = LOWER(${result.memberEmail})))
            AND br.request_date = (CURRENT_DATE AT TIME ZONE 'America/Chicago')::date
            AND br.status IN ('approved', 'confirmed')
          ORDER BY ABS(EXTRACT(EPOCH FROM (br.start_time::time - (CURRENT_TIME AT TIME ZONE 'America/Chicago')::time))) ASC
          LIMIT 1
        `);

        if (bookingResult.rows.length > 0) {
          const booking = (bookingResult.rows as unknown as QrBookingRow[])[0];
          bookingInfo = {
            hasBooking: true,
            bookingId: booking.id,
            bookingDetails: {
              bayName: booking.bay_name || 'Unassigned',
              startTime: booking.start_time,
              endTime: booking.end_time,
              resourceType: booking.resource_type || 'golf_simulator'
            }
          };
        }
      } catch (bookingLookupErr: unknown) {
        logger.warn('[QRCheckin] Non-blocking: Failed to look up booking for member', {
          extra: { memberId, error: getErrorMessage(bookingLookupErr) }
        });
      }
    }

    if (result.alreadyCheckedIn && !bookingInfo.hasBooking) {
      return res.status(409).json({ error: result.error, alreadyCheckedIn: true });
    }

    if (result.alreadyCheckedIn && bookingInfo.hasBooking) {
      return res.json({
        success: true,
        alreadyCheckedIn: true,
        memberName: result.memberName,
        memberEmail: result.memberEmail,
        tier: result.tier,
        lifetimeVisits: result.lifetimeVisits,
        pinnedNotes: result.pinnedNotes || [],
        membershipStatus: result.membershipStatus,
        ...bookingInfo
      });
    }

    logFromRequest(req, 'qr_walkin_checkin', 'member', memberId, result.memberName, {
      memberEmail: result.memberEmail,
      tier: result.tier,
      lifetimeVisits: result.lifetimeVisits,
      type: bookingInfo.hasBooking ? 'booking_checkin' : 'walk_in'
    });

    res.json({
      success: true,
      memberName: result.memberName,
      memberEmail: result.memberEmail,
      tier: result.tier,
      lifetimeVisits: result.lifetimeVisits,
      pinnedNotes: result.pinnedNotes,
      membershipStatus: result.membershipStatus,
      ...bookingInfo
    });
  } catch (error: unknown) {
    logAndRespond(req, res, 500, 'Failed to process QR check-in', error);
  }
});

export default router;
