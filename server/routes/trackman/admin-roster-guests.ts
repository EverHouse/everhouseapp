import { logger } from '../../core/logger';
import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { notifyMember } from '../../core/notificationService';
import { useGuestPass, ensureGuestPassRecord } from '../guestPasses';
import { getMemberTierByEmail } from '../../core/tierService';
import { recalculateSessionFees } from '../../core/billing/unifiedFeeService';
import { logFromRequest } from '../../core/auditLog';
import { ensureSessionForBooking } from '../../core/bookingService/sessionManager';
import { isPlaceholderGuestName } from '../../core/billing/pricingConfig';
import { refundGuestPassForParticipant } from '../../core/billing/guestPassConsumer';
import { getErrorMessage } from '../../utils/errorUtils';
import { createPacificDate } from '../../utils/dateUtils';
import { broadcastBookingRosterUpdate } from '../../core/websocket';
import { syncBookingInvoice } from '../../core/billing/bookingInvoiceService';
import { invalidateCachedFees } from '../../core/billing/unifiedFeeService';
import { findConflictingBookings } from '../../core/bookingService/conflictDetection';

interface DbRow {
  [key: string]: unknown;
}

const router = Router();

router.post('/api/admin/booking/:id/guests', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { guestEmail: rawGuestEmail, guestPhone: _guestPhone, slotId, forceAddAsGuest, quickAdd } = req.body;
    const guestEmail = rawGuestEmail?.trim()?.toLowerCase();
    let { guestName } = req.body;
    
    if (quickAdd && !guestName?.trim()) {
      guestName = 'Guest (info pending)';
    }
    
    if (!guestName?.trim()) {
      return res.status(400).json({ error: 'Guest name is required' });
    }
    
    if (!quickAdd && guestEmail && !forceAddAsGuest) {
      const memberMatch = await db.execute(sql`SELECT id, email, first_name, last_name, tier FROM users WHERE LOWER(email) = LOWER(${guestEmail.trim()})`);
      if (memberMatch.rowCount && memberMatch.rowCount > 0) {
        const member = memberMatch.rows[0] as DbRow;
        return res.status(409).json({
          error: 'Email belongs to an existing member',
          memberMatch: {
            id: member.id,
            email: member.email,
            name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
            tier: member.tier
          }
        });
      }
    }
    
    const bookingResult = await db.execute(sql`SELECT b.*, u.id as owner_id FROM booking_requests b 
       LEFT JOIN users u ON LOWER(u.email) = LOWER(b.user_email) 
       WHERE b.id = ${bookingId}`);
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = bookingResult.rows[0] as DbRow;
    const ownerEmail = booking.user_email;
    const sessionId = booking.session_id ? parseInt(booking.session_id as string, 10) : null;

    if (sessionId) {
      const durationMinutes = booking.duration_minutes || 60;
      const declaredPlayerCount = booking.declared_player_count || 1;
      const slotDuration = Math.floor(Number(durationMinutes)/ Math.max(declaredPlayerCount as number, 1));
      const trimmedName = guestName.trim();
      const isPlaceholder = isPlaceholderGuestName(trimmedName);

      let passUsed = false;
      if (!isPlaceholder && ownerEmail) {
        try {
          const ownerTier = await getMemberTierByEmail(ownerEmail as string);
          if (ownerTier) {
            await ensureGuestPassRecord(ownerEmail as string, ownerTier);
          }
          const passResult = await useGuestPass(ownerEmail as string, trimmedName, true);
          if (passResult.success) {
            passUsed = true;
            logger.info('[AddGuest] Guest pass used for guest', { extra: { bookingId, ownerEmail, guestName: trimmedName, remaining: passResult.remaining } });
          }
        } catch (passErr: unknown) {
          logger.info('[AddGuest] No guest pass available, guest will be charged', { extra: { bookingId, ownerEmail, guestName: trimmedName, error: getErrorMessage(passErr) } });
        }
      }

      await db.execute(sql`INSERT INTO booking_participants (session_id, participant_type, display_name, payment_status, used_guest_pass, slot_duration)
         VALUES (${sessionId}, 'guest', ${trimmedName}, ${passUsed ? 'paid' : 'pending'}, ${passUsed}, ${slotDuration})`);
      logger.info('[AddGuest] Created booking_participant for guest in session', { extra: { bookingId, sessionId, guestName: trimmedName, guestPassUsed: passUsed } });

      if (req.body.deferFeeRecalc !== true) {
        const allParticipants = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId}`);
        const participantIds = allParticipants.rows.map((r: DbRow) => r.id as number);
        if (participantIds.length > 0) {
          await invalidateCachedFees(participantIds, 'guest_added_admin');
        }
        await recalculateSessionFees(sessionId, 'roster_update');
        syncBookingInvoice(bookingId, sessionId).catch(err => {
          logger.warn('[AddGuest] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId } });
        });
      }

      await db.execute(sql`UPDATE booking_requests SET guest_count = COALESCE(guest_count, 0) + 1, updated_at = NOW() WHERE id = ${bookingId}`);
    } else {
      await db.execute(sql`UPDATE booking_requests SET guest_count = COALESCE(guest_count, 0) + 1, updated_at = NOW() WHERE id = ${bookingId}`);
    }

    let guestPassesRemaining = 0;
    if (ownerEmail) {
      const passesResult = await db.execute(sql`SELECT passes_total - passes_used as remaining FROM guest_passes WHERE LOWER(member_email) = LOWER(${ownerEmail})`);
      if (passesResult.rowCount && passesResult.rowCount > 0) {
        guestPassesRemaining = Number((passesResult.rows[0] as DbRow).remaining) || 0;
      }
    }

    await logFromRequest(req, {
      action: 'update_booking',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Guest added: ${guestName.trim()}`,
      details: { guestName: guestName.trim(), guestEmail: guestEmail?.trim() || null, sessionId }
    });

    broadcastBookingRosterUpdate({
      bookingId,
      sessionId: sessionId as number,
      action: 'participant_added',
      memberEmail: ownerEmail as string,
    });
    
    res.json({
      success: true,
      guestPassesRemaining
    });
  } catch (error: unknown) {
    logger.error('Add guest error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add guest' });
  }
});

router.delete('/api/admin/booking/:id/guests/:guestId', isStaffOrAdmin, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id as string, 10);
    if (isNaN(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    const guestId = parseInt(req.params.guestId as string, 10);
    if (isNaN(guestId)) {
      return res.status(400).json({ error: 'Invalid guest ID' });
    }
    const staffEmail = req.session?.user?.email || 'admin';

    const bookingResult = await db.execute(sql`SELECT br.id, br.session_id, br.guest_count, br.user_email as owner_email
       FROM booking_requests br
       WHERE br.id = ${bookingId}`);

    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0] as DbRow;
    const sessionId = booking.session_id;

    let guestDisplayName = 'Unknown guest';
    let guestFound = false;

    if (sessionId) {
      const participantResult = await db.execute(sql`SELECT id, display_name, used_guest_pass FROM booking_participants WHERE id = ${guestId} AND session_id = ${sessionId} AND participant_type = 'guest'`);

      if (participantResult.rowCount && participantResult.rowCount > 0) {
        guestFound = true;
        const participant = participantResult.rows[0] as DbRow;
        guestDisplayName = (participant.display_name as string) || guestDisplayName;
        if (participant.used_guest_pass === true && booking.owner_email) {
          try {
            await refundGuestPassForParticipant(participant.id as number, booking.owner_email as string, guestDisplayName);
            logger.info('[RemoveGuest] Guest pass refunded for', { extra: { guestDisplayName } });
          } catch (err: unknown) {
            logger.error('[RemoveGuest] Failed to refund guest pass', { extra: { err } });
          }
        }
        await db.execute(sql`DELETE FROM booking_participants WHERE id = ${guestId}`);
      }
    }

    if (!guestFound) {
      return res.status(404).json({ error: 'Guest not found in booking_participants' });
    }

    if (booking.guest_count && Number(booking.guest_count) > 0) {
      await db.execute(sql`UPDATE booking_requests SET guest_count = GREATEST(0, guest_count - 1), updated_at = NOW() WHERE id = ${bookingId}`);
    }

    if (req.query.deferFeeRecalc !== 'true') {
      if (sessionId) {
        const remainingParticipants = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId}`);
        const participantIds = remainingParticipants.rows.map((r: DbRow) => r.id as number);
        if (participantIds.length > 0) {
          await invalidateCachedFees(participantIds, 'guest_removed_admin');
        }
        await recalculateSessionFees(sessionId as number, 'roster_update');
        syncBookingInvoice(bookingId, sessionId as number).catch(err => {
          logger.warn('[RemoveGuest] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId } });
        });
      }
    }

    await logFromRequest(req, {
      action: 'update_booking',
      resourceType: 'booking',
      resourceId: String(bookingId),
      resourceName: `Remove guest ${guestDisplayName}`,
      details: { guestId, guestDisplayName, staffEmail }
    });

    broadcastBookingRosterUpdate({
      bookingId,
      sessionId: sessionId as number,
      action: 'participant_removed',
      memberEmail: (booking.owner_email as string) || '',
    });

    res.json({
      success: true,
      message: `Guest ${guestDisplayName} removed successfully`
    });
  } catch (error: unknown) {
    logger.error('Remove guest error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove guest' });
  }
});

router.put('/api/admin/booking/:bookingId/members/:slotId/link', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    const { memberEmail: rawMemberEmail } = req.body;
    const memberEmail = rawMemberEmail?.trim()?.toLowerCase();
    const linkedBy = req.session?.user?.email || 'admin';
    
    if (!memberEmail) {
      return res.status(400).json({ error: 'memberEmail is required' });
    }
    
    const bookingResult = await db.execute(sql`SELECT request_date, start_time, end_time, status, session_id, resource_id, user_email, user_name, user_id, trackman_booking_id FROM booking_requests WHERE id = ${bookingId}`);
    
    if (!bookingResult.rows[0]) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const bookingRow = bookingResult.rows[0] as DbRow;
    if (bookingRow.request_date && bookingRow.start_time && bookingRow.end_time) {
      const conflictResult = await findConflictingBookings(
        memberEmail,
        String(bookingRow.request_date),
        String(bookingRow.start_time),
        String(bookingRow.end_time),
        parseInt(bookingId as string, 10)
      );
      if (conflictResult.hasConflict) {
        const conflict = conflictResult.conflicts[0];
        logger.warn('[Link Member] Conflict detected when linking member', {
          extra: { bookingId, memberEmail, conflictingBookingId: conflict.bookingId, conflictType: conflict.conflictType }
        });
        return res.status(409).json({
          error: `This member has a scheduling conflict with another booking`,
          conflict: {
            bookingId: conflict.bookingId,
            resourceName: conflict.resourceName,
            startTime: conflict.startTime,
            endTime: conflict.endTime,
            ownerName: conflict.ownerName,
            conflictType: conflict.conflictType
          }
        });
      }
    }

    let sessionId = bookingRow.session_id;
    
    if (!sessionId) {
      const bk = bookingRow;
      if (bk.resource_id && bk.request_date && bk.start_time && bk.end_time) {
        try {
          const sessionResult = await ensureSessionForBooking({
            bookingId: parseInt(bookingId as string, 10),
            resourceId: bk.resource_id as number,
            sessionDate: String(bk.request_date),
            startTime: String(bk.start_time),
            endTime: String(bk.end_time),
            ownerEmail: (bk.user_email as string) || memberEmail,
            ownerName: (bk.user_name as string) || undefined,
            ownerUserId: (bk.user_id as string) || undefined,
            trackmanBookingId: (bk.trackman_booking_id as string) || undefined,
            source: 'staff_manual',
            createdBy: linkedBy
          });
          if (sessionResult.error || !sessionResult.sessionId) {
            logger.error('[Link Member] Session creation failed', { extra: { bookingId, error: sessionResult.error || 'sessionId=0' } });
            return res.status(500).json({ error: 'Failed to create booking session' });
          }
          sessionId = sessionResult.sessionId;
          await db.execute(sql`UPDATE booking_requests SET session_id = ${sessionId} WHERE id = ${bookingId}`);
          logger.info('[Link Member] Created session for booking without one', { extra: { bookingId, sessionId } });
        } catch (sessErr: unknown) {
          logger.error('[Link Member] Failed to create session', { error: sessErr instanceof Error ? sessErr : new Error(String(sessErr)) });
          return res.status(500).json({ error: 'Failed to create booking session' });
        }
      }
    }

    if (sessionId) {
      const booking = bookingResult.rows[0] as DbRow;
      
      const slotDuration = booking.start_time && booking.end_time
        ? Math.round((new Date(`2000-01-01T${booking.end_time}`).getTime() - 
                     new Date(`2000-01-01T${booking.start_time}`).getTime()) / 60000)
        : 60;
      
      const memberInfo = await db.execute(sql`SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${memberEmail})`);
      
      if (!(memberInfo.rows[0] as DbRow)?.id) {
        logger.warn('[Link Member] User not found for email', { extra: { memberEmail } });
        return res.status(404).json({ error: 'Member not found in system' });
      }
      
      const userId = (memberInfo.rows[0] as DbRow).id;
      const displayName = `${(memberInfo.rows[0] as DbRow).first_name || ''} ${(memberInfo.rows[0] as DbRow).last_name || ''}`.trim() || memberEmail;

      const targetSlot = await db.execute(sql`SELECT id, participant_type, user_id FROM booking_participants WHERE id = ${slotId} AND session_id = ${sessionId}`);
      if (targetSlot.rowCount && targetSlot.rowCount > 0) {
        const slot = (targetSlot.rows[0] as DbRow);
        if (!slot.user_id && (slot.participant_type === 'owner' || slot.participant_type === 'member')) {
          await db.execute(sql`UPDATE booking_participants SET user_id = ${userId}, display_name = ${displayName} WHERE id = ${slotId}`);
          
          await db.execute(sql`DELETE FROM booking_participants WHERE session_id = ${sessionId} AND user_id = ${userId} AND id != ${slotId}`);

          if (slot.participant_type === 'owner') {
            await db.execute(sql`UPDATE booking_requests SET user_id = ${userId}, user_email = ${memberEmail.toLowerCase()}, user_name = ${displayName}, updated_at = NOW() WHERE id = ${bookingId}`);
            logger.info('[Link Member] Updated booking_requests owner to match linked owner slot', { extra: { bookingId, userId, displayName, memberEmail } });
          }
          
          if (req.body.deferFeeRecalc !== true) {
            try {
              const allParts = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId}`);
              const pIds = allParts.rows.map((r: DbRow) => r.id as number);
              if (pIds.length > 0) await invalidateCachedFees(pIds, 'member_linked_admin');
              await recalculateSessionFees(Number(sessionId), 'roster_update');
              syncBookingInvoice(Number(bookingId), Number(sessionId)).catch(err => {
                logger.warn('[Link Member] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId } });
              });
            } catch (feeErr: unknown) {
              logger.warn('[Link Member] Failed to recalculate fees for session', { extra: { sessionId, feeErr } });
            }
          }

          logger.info('[Link Member] Linked member to existing empty slot', { extra: { slotId, userId, displayName, sessionId, slotType: slot.participant_type } });

          if (bookingResult.rows[0]) {
            const bookingForNotif = bookingResult.rows[0] as DbRow;
            const bookingDate = bookingForNotif.request_date;
            const now = new Date();
            const bookingDateTime = createPacificDate(String(bookingDate), String(bookingForNotif.start_time));
            
            if (bookingDateTime > now && bookingForNotif.status === 'approved') {
              const notificationMessage = `You've been added to a simulator booking on ${new Date(bookingDate as string).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}.`;
              
              await notifyMember({
                userEmail: memberEmail.toLowerCase(),
                title: 'Added to Booking',
                message: notificationMessage,
                type: 'booking_approved',
                relatedId: Number(bookingId),
                relatedType: 'booking_request',
                url: '/sims'
              }, { sendPush: true }).catch(err => logger.error('[AdminRoster] Notification failed', { extra: { error: getErrorMessage(err) } }));
            }
          }

          logFromRequest(req, 'link_member_to_booking', 'booking', String(bookingId), memberEmail.toLowerCase(), {
            slotId,
            memberEmail: memberEmail.toLowerCase(),
            linkedBy,
            slotType: slot.participant_type
          });

          broadcastBookingRosterUpdate({
            bookingId: Number(bookingId),
            sessionId: sessionId as number,
            action: 'participant_added',
            memberEmail: memberEmail.toLowerCase(),
          });

          return res.json({ 
            success: true, 
            message: `Member ${memberEmail} linked to ${slot.participant_type} slot` 
          });
        }
      }

      const existingParticipant = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId} AND user_id = ${userId}`);
      
      if (existingParticipant.rowCount === 0) {
        const matchingGuest = await db.execute(sql`SELECT bp.id, bp.display_name, g.email as guest_email
           FROM booking_participants bp
           LEFT JOIN guests g ON bp.guest_id = g.id
           WHERE bp.session_id = ${sessionId} 
             AND bp.participant_type = 'guest'
             AND (LOWER(bp.display_name) = LOWER(${displayName}) OR LOWER(g.email) = LOWER(${memberEmail}))`);
        
        if (matchingGuest.rowCount && matchingGuest.rowCount > 0) {
          const guestIds = matchingGuest.rows.map((r: DbRow) => r.id);
          if (guestIds.length > 0) {
            await db.execute(sql`DELETE FROM booking_participants WHERE id IN (${sql.join(guestIds.map((id: unknown) => sql`${id}`), sql`, `)})`);
            logger.info('[Link Member] Removed duplicate guest entries for member in session', { extra: { guestIdsLength: guestIds.length, memberEmail, sessionId } });
          }
        }
        
        await db.execute(sql`INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status, slot_duration)
           VALUES (${sessionId}, ${userId}, 'member', ${displayName}, 'pending', ${slotDuration})`);
      }
      
      if (req.body.deferFeeRecalc !== true) {
        try {
          const allParts = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId}`);
          const pIds = allParts.rows.map((r: DbRow) => r.id as number);
          if (pIds.length > 0) await invalidateCachedFees(pIds, 'member_linked_admin');
          await recalculateSessionFees(Number(sessionId), 'roster_update');
          syncBookingInvoice(Number(bookingId), Number(sessionId)).catch(err => {
            logger.warn('[Link Member] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId } });
          });
        } catch (feeErr: unknown) {
          logger.warn('[Link Member] Failed to recalculate fees for session', { extra: { sessionId, feeErr } });
        }
      }
    } else {
      logger.warn('[Link Member] No session found and could not create one', { extra: { bookingId, slotId } });
      return res.status(400).json({ error: 'No active session for this booking. Try reassigning the booking owner first.' });
    }
    
    if (bookingResult.rows[0]) {
      const booking = bookingResult.rows[0] as DbRow;
      const bookingDate = booking.request_date;
      const now = new Date();
      const bookingDateTime = createPacificDate(String(bookingDate), String(booking.start_time));
      
      if (bookingDateTime > now && booking.status === 'approved') {
        const notificationMessage = `You've been added to a simulator booking on ${new Date(bookingDate as string).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}.`;
        
        await notifyMember({
          userEmail: memberEmail.toLowerCase(),
          title: 'Added to Booking',
          message: notificationMessage,
          type: 'booking_approved',
          relatedId: Number(bookingId),
          relatedType: 'booking_request',
          url: '/sims'
        }, { sendPush: true }).catch(err => logger.error('[AdminRoster] Notification failed', { extra: { error: getErrorMessage(err) } }));
      }
    }
    
    logFromRequest(req, 'link_member_to_booking', 'booking', String(bookingId), memberEmail.toLowerCase(), {
      slotId,
      memberEmail: memberEmail.toLowerCase(),
      linkedBy
    });

    broadcastBookingRosterUpdate({
      bookingId: parseInt(bookingId as string, 10),
      sessionId: sessionId as number,
      action: 'participant_added',
      memberEmail: memberEmail.toLowerCase(),
    });
    
    res.json({ 
      success: true, 
      message: `Member ${memberEmail} linked to slot` 
    });
  } catch (error: unknown) {
    logger.error('Link member error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to link member to slot' });
  }
});

router.put('/api/admin/booking/:bookingId/members/:slotId/unlink', isStaffOrAdmin, async (req, res) => {
  try {
    const { bookingId, slotId } = req.params;
    
    const bookingResult = await db.execute(sql`SELECT session_id FROM booking_requests WHERE id = ${bookingId}`);
    
    if (!(bookingResult.rows[0] as DbRow)?.session_id) {
      return res.status(404).json({ error: 'Booking has no session - cannot unlink participant' });
    }
    
    const sessionId = (bookingResult.rows[0] as DbRow).session_id;
    
    const participantResult = await db.execute(sql`SELECT bp.id, u.email as member_email FROM booking_participants bp LEFT JOIN users u ON bp.user_id = u.id WHERE bp.id = ${slotId} AND bp.session_id = ${sessionId} AND bp.participant_type = 'member'`);
    
    if (participantResult.rowCount === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    
    const slot = participantResult.rows[0] as DbRow;
    if (!slot.member_email) {
      return res.status(400).json({ error: 'Slot is already empty' });
    }
    
    const memberEmail = slot.member_email;
    
    await db.execute(sql`DELETE FROM booking_participants WHERE id = ${slotId} AND participant_type = 'member'`);
    
    if (req.query.deferFeeRecalc !== 'true') {
      try {
        const remainingParts = await db.execute(sql`SELECT id FROM booking_participants WHERE session_id = ${sessionId}`);
        const pIds = remainingParts.rows.map((r: DbRow) => r.id as number);
        if (pIds.length > 0) await invalidateCachedFees(pIds, 'member_unlinked_admin');
        await recalculateSessionFees(Number(sessionId), 'roster_update');
        syncBookingInvoice(Number(bookingId), Number(sessionId)).catch(err => {
          logger.warn('[unlink] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId } });
        });
      } catch (feeError: unknown) {
        logger.warn('[unlink] Failed to recalculate session fees (non-blocking)', { extra: { feeError } });
      }
    }
    
    logFromRequest(req, 'unlink_member_from_booking', 'booking', String(bookingId), String(memberEmail).toLowerCase(), {
      slotId
    });

    broadcastBookingRosterUpdate({
      bookingId: parseInt(bookingId as string, 10),
      sessionId: sessionId as number,
      action: 'participant_removed',
      memberEmail: String(memberEmail).toLowerCase(),
    });
    
    res.json({ 
      success: true, 
      message: `Member ${memberEmail} unlinked from slot` 
    });
  } catch (error: unknown) {
    logger.error('Unlink member error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to unlink member from slot' });
  }
});


export default router;
