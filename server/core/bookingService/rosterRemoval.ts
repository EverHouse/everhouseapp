import { db } from '../../db';
import { bookingParticipants, bookingRequests, users } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from '../logger';
import { getSessionParticipants } from './sessionManager';
import {
  invalidateCachedFees,
  recalculateSessionFees,
} from '../billing/unifiedFeeService';
import { refundGuestPass } from '../../routes/guestPasses';
import { getErrorMessage } from '../../utils/errorUtils';
import { syncBookingInvoice } from '../billing/bookingInvoiceService';
import { broadcastBookingRosterUpdate } from '../websocket';
import {
  type RemoveParticipantParams,
  type RemoveParticipantResult,
  type UpdatePlayerCountParams,
  type UpdatePlayerCountResult,
  createServiceError,
  enforceRosterLock,
  isStaffOrAdminCheck,
  getBookingWithSession,
} from './rosterTypes';

export async function removeParticipant(params: RemoveParticipantParams): Promise<RemoveParticipantResult> {
  const { bookingId, participantId, rosterVersion, userEmail, sessionUserId: _sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  await enforceRosterLock(bookingId);

  if (!booking.session_id) {
    throw createServiceError('Booking does not have an active session', 400);
  }

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  const [participant] = await db
    .select()
    .from(bookingParticipants)
    .where(eq(bookingParticipants.id, participantId))
    .limit(1);

  if (!participant || participant.sessionId !== booking.session_id) {
    throw createServiceError('Participant not found', 404);
  }

  let isSelf = false;
  if (participant.userId) {
    const userResult = await db.select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${userEmail})`)
      .limit(1);
    if (userResult.length > 0 && userResult[0].id === participant.userId) {
      isSelf = true;
    }
  }

  if (!isOwner && !isStaff && !isSelf) {
    throw createServiceError('Only the booking owner, staff, or the participant themselves can remove this participant', 403);
  }

  if (participant.participantType === 'owner') {
    throw createServiceError('Cannot remove the booking owner', 400);
  }

  let newRosterVersion: number;
  let deferredRemoveRefund: { ownerEmail: string; guestName: string | undefined } | null = null;

  const txResult = await db.transaction(async (tx) => {
    const lockedBooking = await tx.execute(sql`
      SELECT roster_version FROM booking_requests WHERE id = ${bookingId} FOR UPDATE
    `);

    if (!lockedBooking.rows.length) {
      throw createServiceError('Booking not found', 404);
    }

    const currentVersion = (lockedBooking.rows[0] as Record<string, number>).roster_version ?? 0;

    if (rosterVersion !== undefined && currentVersion !== rosterVersion) {
      throw createServiceError('Roster was modified by another user', 409, {
        code: 'ROSTER_CONFLICT',
        currentVersion
      });
    }

    if (participant.participantType === 'guest' && participant.usedGuestPass === true) {
      deferredRemoveRefund = { ownerEmail: booking.owner_email, guestName: participant.displayName || undefined };
    }

    await tx.delete(bookingParticipants)
      .where(eq(bookingParticipants.id, participantId));

    logger.info('[rosterService] Participant removed', {
      extra: {
        bookingId,
        sessionId: booking.session_id,
        participantId,
        participantType: participant.participantType,
        removedBy: userEmail
      }
    });

    await tx.update(bookingRequests)
      .set({ rosterVersion: sql`COALESCE(roster_version, 0) + 1` })
      .where(eq(bookingRequests.id, bookingId));

    newRosterVersion = currentVersion + 1;

    return {
      sessionId: booking.session_id,
      deferFeeRecalc: !!params.deferFeeRecalc,
      newRosterVersion,
      guestPassesRemaining: undefined as number | undefined
    };
  });

  const rmRefund = deferredRemoveRefund as unknown as { ownerEmail: string; guestName: string | undefined } | null;
  if (rmRefund) {
    try {
      const refundResult = await refundGuestPass(
        rmRefund.ownerEmail,
        rmRefund.guestName,
        true
      );
      if (refundResult.success) {
        txResult.guestPassesRemaining = refundResult.remaining;
        logger.info('[rosterService] Guest pass refunded on participant removal (deferred)', {
          extra: {
            bookingId,
            ownerEmail: rmRefund.ownerEmail,
            guestName: rmRefund.guestName,
            remainingPasses: refundResult.remaining
          }
        });
      } else {
        logger.warn('[rosterService] Failed to refund guest pass (non-blocking)', {
          extra: {
            bookingId,
            ownerEmail: rmRefund.ownerEmail,
            error: refundResult.error
          }
        });
      }
    } catch (refundErr: unknown) {
      logger.warn('[rosterService] Failed to refund guest pass after tx (non-blocking)', {
        error: refundErr as Error,
        extra: { bookingId, ownerEmail: rmRefund.ownerEmail }
      });
    }
  }

  if (!txResult.deferFeeRecalc && txResult.sessionId) {
    try {
      const remainingParticipants = await getSessionParticipants(txResult.sessionId);
      const participantIds = remainingParticipants.map(p => p.id);

      await invalidateCachedFees(participantIds, 'participant_removed');

      const recalcResult = await recalculateSessionFees(txResult.sessionId, 'roster_update');
      logger.info('[rosterService] Session fees recalculated after removing participant', {
        extra: {
          sessionId: txResult.sessionId,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.totals.totalCents,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });

      syncBookingInvoice(bookingId, txResult.sessionId).catch(err => {
        logger.warn('[rosterService] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId: txResult.sessionId } });
      });

      broadcastBookingRosterUpdate({
        bookingId,
        sessionId: txResult.sessionId,
        action: 'participant_removed',
        memberEmail: booking.owner_email,
      });
    } catch (recalcError: unknown) {
      logger.warn('[rosterService] Failed to recalculate session fees (non-blocking)', {
        error: recalcError as Error,
        extra: { sessionId: txResult.sessionId, bookingId }
      });
    }
  }

  return {
    message: 'Participant removed successfully',
    ...(participant.participantType === 'guest' && txResult.guestPassesRemaining !== undefined && { guestPassesRemaining: txResult.guestPassesRemaining }),
    newRosterVersion: txResult.newRosterVersion
  };
}

export async function updateDeclaredPlayerCount(params: UpdatePlayerCountParams): Promise<UpdatePlayerCountResult> {
  const { bookingId, playerCount, staffEmail } = params;

  await enforceRosterLock(bookingId);

  const txResult = await db.transaction(async (tx) => {
    const bookingResult = await tx.execute(sql`
      SELECT br.id, br.declared_player_count, br.session_id, br.user_email, br.status
      FROM booking_requests br
      WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      throw createServiceError('Booking not found', 404);
    }

    interface PlayerCountBookingRow { id: number; declared_player_count: number | null; session_id: number | null; user_email: string; status: string | null }
    const booking = bookingResult.rows[0] as unknown as PlayerCountBookingRow;
    const previousCount = booking.declared_player_count || 1;

    await tx.update(bookingRequests)
      .set({ declaredPlayerCount: playerCount })
      .where(eq(bookingRequests.id, bookingId));

    if (booking.session_id) {
      logger.info('[rosterService] Skipping legacy booking_members sync for session-based booking', {
        extra: { bookingId, sessionId: booking.session_id, playerCount }
      });
    }

    logger.info('[rosterService] Player count updated', {
      extra: { bookingId, previousCount, newCount: playerCount, staffEmail }
    });

    return {
      previousCount,
      sessionId: booking.session_id as number | null,
      ownerEmail: String(booking.user_email || ''),
    };
  });

  if (!params.deferFeeRecalc && txResult.sessionId) {
    try {
      await recalculateSessionFees(txResult.sessionId, 'roster_update');

      syncBookingInvoice(bookingId, txResult.sessionId).catch(err => {
        logger.warn('[rosterService] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId: txResult.sessionId } });
      });

      broadcastBookingRosterUpdate({
        bookingId,
        sessionId: txResult.sessionId,
        action: 'roster_updated',
        memberEmail: txResult.ownerEmail,
      });
    } catch (feeError: unknown) {
      logger.error('[rosterService] Failed to recalculate session fees after player count update', {
        error: feeError as Error,
        extra: { bookingId, sessionId: txResult.sessionId }
      });
    }
  }

  return {
    previousCount: txResult.previousCount,
    newCount: playerCount,
    feesRecalculated: !!txResult.sessionId
  };
}
