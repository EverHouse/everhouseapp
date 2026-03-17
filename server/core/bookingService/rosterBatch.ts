import { db } from '../../db';
import { bookingParticipants, bookingRequests, users } from '../../../shared/schema';
import { eq, sql, and } from 'drizzle-orm';
import { logger } from '../logger';
import {
  linkParticipants,
  getSessionParticipants,
  ensureSessionForBooking,
} from './sessionManager';
import {
  enforceSocialTierRules,
  type ParticipantForValidation,
} from './tierRules';
import { getMemberTierByEmail } from '../tierService';
import {
  invalidateCachedFees,
  recalculateSessionFees,
} from '../billing/unifiedFeeService';
import { isPlaceholderGuestName } from '../billing/pricingConfig';
import { createPrepaymentIntent } from '../billing/prepaymentService';
import { findConflictingBookings } from './conflictDetection';
import { useGuestPass, refundGuestPass, ensureGuestPassRecord } from '../../routes/guestPasses';
import { createOrFindGuest } from './sessionManager';
import { getErrorMessage } from '../../utils/errorUtils';
import { syncBookingInvoice } from '../billing/bookingInvoiceService';
import { broadcastBookingRosterUpdate } from '../websocket';
import {
  type RosterOperation,
  type BatchRosterUpdateParams,
  type BatchRosterUpdateResult,
  createServiceError,
  enforceRosterLock,
  isStaffOrAdminCheck,
  getBookingWithSession,
} from './rosterTypes';

export async function applyRosterBatch(params: BatchRosterUpdateParams): Promise<BatchRosterUpdateResult> {
  const { bookingId, rosterVersion, operations, staffEmail } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  await enforceRosterLock(bookingId);

  const isStaff = await isStaffOrAdminCheck(staffEmail);
  if (!isStaff) {
    throw createServiceError('Only staff or admin can perform batch roster updates', 403);
  }

  const operationResults: Array<{ type: string; success: boolean; error?: string }> = [];
  let sessionId = booking.session_id;
  let newRosterVersion = 0;
  const deferredBatchRefunds: Array<{ ownerEmail: string; guestName: string | undefined }> = [];

  await db.transaction(async (tx) => {
    const lockedBooking = await tx.execute(sql`
      SELECT roster_version FROM booking_requests WHERE id = ${bookingId} FOR UPDATE
    `);

    if (!lockedBooking.rows.length) {
      throw createServiceError('Booking not found', 404);
    }

    const currentVersion = (lockedBooking.rows[0] as Record<string, number>).roster_version ?? 0;

    if (currentVersion !== rosterVersion) {
      throw createServiceError('Roster was modified by another user', 409, {
        code: 'ROSTER_CONFLICT',
        currentVersion
      });
    }

    if (!sessionId) {
      logger.info('[rosterService:batch] Creating session for booking without session_id', {
        extra: { bookingId, ownerEmail: booking.owner_email }
      });

      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id!,
        sessionDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: booking.owner_email,
        source: 'staff_manual',
        createdBy: staffEmail
      });

      sessionId = sessionResult.sessionId || null;

      if (!sessionId || sessionResult.error) {
        throw createServiceError('Failed to create billing session for this booking. Staff has been notified.', 500);
      }

      logger.info('[rosterService:batch] Session created and linked to booking', {
        extra: { bookingId, sessionId }
      });
    }

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);

    for (const op of operations) {
      try {
        switch (op.type) {
          case 'update_player_count': {
            const pc = op.playerCount;
            if (typeof pc !== 'number' || pc < 1 || pc > 4) {
              operationResults.push({ type: op.type, success: false, error: 'Player count must be between 1 and 4' });
              break;
            }

            const prevResult = await tx.execute(sql`
              SELECT declared_player_count FROM booking_requests WHERE id = ${bookingId}
            `);
            const previousCount = (prevResult.rows[0] as Record<string, number>)?.declared_player_count || 1;

            await tx.update(bookingRequests)
              .set({ declaredPlayerCount: pc })
              .where(eq(bookingRequests.id, bookingId));

            logger.info('[rosterService:batch] Player count updated', {
              extra: { bookingId, previousCount, newCount: pc }
            });
            operationResults.push({ type: op.type, success: true });
            break;
          }

          case 'remove_participant': {
            if (!op.participantId) {
              operationResults.push({ type: op.type, success: false, error: 'participantId is required' });
              break;
            }

            const partResult = await tx.execute(sql`
              SELECT id, user_id, guest_id, participant_type, display_name, used_guest_pass
              FROM booking_participants WHERE id = ${op.participantId} AND session_id = ${sessionId} LIMIT 1
            `);

            if (partResult.rows.length === 0) {
              operationResults.push({ type: op.type, success: false, error: 'Participant not found in this session' });
              break;
            }

            interface BatchParticipantRow { id: number; user_id: string | null; guest_id: number | null; participant_type: string; display_name: string; used_guest_pass: boolean | null }
            const participant = partResult.rows[0] as unknown as BatchParticipantRow;

            if (participant.participant_type === 'owner') {
              operationResults.push({ type: op.type, success: false, error: 'Cannot remove the booking owner' });
              break;
            }

            if (participant.participant_type === 'guest' && participant.used_guest_pass === true) {
              deferredBatchRefunds.push({ ownerEmail: booking.owner_email, guestName: participant.display_name || undefined });
            }

            await tx.delete(bookingParticipants)
              .where(eq(bookingParticipants.id, op.participantId));

            logger.info('[rosterService:batch] Participant removed', {
              extra: { bookingId, participantId: op.participantId, participantType: participant.participant_type }
            });
            operationResults.push({ type: op.type, success: true });
            break;
          }

          case 'add_member': {
            if (!op.memberIdOrEmail) {
              operationResults.push({ type: op.type, success: false, error: 'memberIdOrEmail is required' });
              break;
            }

            const memberResult = await tx.select({
              id: users.id,
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName
            }).from(users)
              .where(sql`${users.id} = ${op.memberIdOrEmail} OR LOWER(${users.email}) = LOWER(${op.memberIdOrEmail})`)
              .limit(1);

            if (memberResult.length === 0) {
              operationResults.push({ type: op.type, success: false, error: 'Member not found' });
              break;
            }

            const memberInfo = {
              id: memberResult[0].id,
              email: memberResult[0].email!,
              firstName: memberResult[0].firstName!,
              lastName: memberResult[0].lastName!
            };

            const existingParticipants = await getSessionParticipants(sessionId!);

            const existingMember = existingParticipants.find(p =>
              p.userId === memberInfo.id ||
              p.userId?.toLowerCase() === memberInfo.email?.toLowerCase()
            );
            if (existingMember) {
              operationResults.push({ type: op.type, success: false, error: 'This member is already a participant' });
              break;
            }

            const conflictResult = await findConflictingBookings(
              memberInfo.email,
              booking.request_date,
              booking.start_time,
              booking.end_time,
              bookingId
            );

            if (conflictResult.hasConflict) {
              operationResults.push({ type: op.type, success: false, error: `Member has a scheduling conflict on ${booking.request_date}` });
              break;
            }

            const memberFullName = `${memberInfo.firstName || ''} ${memberInfo.lastName || ''}`.trim().toLowerCase();
            const normalize = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();
            const normalizedMember = normalize(memberFullName);

            let matchingGuest = existingParticipants.find(p => {
              if (p.participantType !== 'guest') return false;
              const normalizedGuest = normalize(p.displayName || '');
              return normalizedGuest === normalizedMember;
            });

            if (!matchingGuest) {
              matchingGuest = existingParticipants.find(p => {
                if (p.participantType !== 'guest') return false;
                return isPlaceholderGuestName(p.displayName);
              });
            }

            if (matchingGuest) {
              const guestCheckResult = await tx.execute(sql`
                SELECT id, display_name, used_guest_pass FROM booking_participants 
                WHERE id = ${matchingGuest.id} AND session_id = ${sessionId} AND participant_type = 'guest' LIMIT 1
              `);

              if (guestCheckResult.rows.length > 0) {
                interface BatchGuestRow { id: number; display_name: string; used_guest_pass: boolean | null }
                const guestToRemove = guestCheckResult.rows[0] as unknown as BatchGuestRow;
                await tx.delete(bookingParticipants)
                  .where(eq(bookingParticipants.id, guestToRemove.id));

                if (guestToRemove.used_guest_pass === true) {
                  deferredBatchRefunds.push({ ownerEmail: booking.owner_email, guestName: guestToRemove.display_name || undefined });
                }
              }
            }

            const displayName = [memberInfo.firstName, memberInfo.lastName].filter(Boolean).join(' ') || memberInfo.email;
            await linkParticipants(sessionId!, [{ userId: memberInfo.id, participantType: 'member', displayName }], tx);

            logger.info('[rosterService:batch] Member added', {
              extra: { bookingId, memberEmail: memberInfo.email }
            });
            operationResults.push({ type: op.type, success: true });
            break;
          }

          case 'add_guest': {
            if (!op.guest || !op.guest.name || !op.guest.email) {
              operationResults.push({ type: op.type, success: false, error: 'Guest name and email are required' });
              break;
            }

            if (ownerTier) {
              const existingParticipants = await getSessionParticipants(sessionId!);
              const participantsForValidation: ParticipantForValidation[] = [
                ...existingParticipants.map(p => ({
                  type: p.participantType as 'owner' | 'member' | 'guest',
                  displayName: p.displayName
                })),
                { type: 'guest', displayName: op.guest.name }
              ];

              const socialCheck = await enforceSocialTierRules(ownerTier, participantsForValidation);

              if (!socialCheck.allowed) {
                operationResults.push({ type: op.type, success: false, error: socialCheck.reason || 'Social tier members cannot bring guests' });
                break;
              }
            }

            await ensureGuestPassRecord(booking.owner_email, ownerTier || undefined);

            const guestPassResult = await useGuestPass(booking.owner_email, op.guest.name, true);
            if (!guestPassResult.success) {
              operationResults.push({ type: op.type, success: false, error: guestPassResult.error || 'No guest passes remaining' });
              break;
            }

            const guestId = await createOrFindGuest(
              op.guest.name,
              op.guest.email,
              op.guest.phone,
              staffEmail
            );

            const [newGuestParticipant] = await linkParticipants(sessionId!, [{
              guestId,
              participantType: 'guest',
              displayName: op.guest.name,
            }], tx);

            if (newGuestParticipant) {
              await tx.update(bookingParticipants)
                .set({ paymentStatus: 'paid' as const })
                .where(eq(bookingParticipants.id, newGuestParticipant.id));
            }

            logger.info('[rosterService:batch] Guest added', {
              extra: { bookingId, guestName: op.guest.name, guestEmail: op.guest.email }
            });
            operationResults.push({ type: op.type, success: true });
            break;
          }

          default:
            operationResults.push({ type: op.type, success: false, error: `Unknown operation type: ${op.type}` });
        }
      } catch (opError: unknown) {
        const errorMsg = getErrorMessage(opError);
        logger.error('[rosterService:batch] Operation failed', {
          error: opError as Error,
          extra: { bookingId, operationType: op.type }
        });
        operationResults.push({ type: op.type, success: false, error: errorMsg });
      }
    }

    await tx.update(bookingRequests)
      .set({ rosterVersion: sql`COALESCE(roster_version, 0) + 1` })
      .where(eq(bookingRequests.id, bookingId));

    newRosterVersion = currentVersion + 1;
  });

  for (const refund of deferredBatchRefunds) {
    try {
      const refundResult = await refundGuestPass(refund.ownerEmail, refund.guestName, true);
      if (refundResult.success) {
        logger.info('[rosterService:batch] Guest pass refunded (deferred)', {
          extra: { bookingId, ownerEmail: refund.ownerEmail, guestName: refund.guestName }
        });
      } else {
        logger.error('[rosterService:batch] Guest pass refund failed (deferred)', {
          extra: { bookingId, ownerEmail: refund.ownerEmail, guestName: refund.guestName, error: refundResult.error }
        });
      }
    } catch (refundErr: unknown) {
      logger.warn('[rosterService:batch] Guest pass refund threw after tx (non-blocking)', {
        error: refundErr as Error,
        extra: { bookingId, ownerEmail: refund.ownerEmail, guestName: refund.guestName }
      });
    }
  }

  let feesRecalculated = false;
  if (sessionId) {
    try {
      const allParticipants = await getSessionParticipants(sessionId);
      const participantIds = allParticipants.map(p => p.id);

      await invalidateCachedFees(participantIds, 'batch_roster_update');

      const recalcResult = await recalculateSessionFees(sessionId, 'roster_update');
      feesRecalculated = true;

      syncBookingInvoice(bookingId, sessionId).catch(err => {
        logger.warn('[rosterService] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId } });
      });

      broadcastBookingRosterUpdate({
        bookingId,
        sessionId,
        action: 'roster_updated',
        memberEmail: booking.owner_email,
      });

      logger.info('[rosterService:batch] Session fees recalculated after batch update', {
        extra: {
          sessionId,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.totals.totalCents,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });

      if (recalcResult.totals.totalCents > 0) {
        try {
          const ownerResult = await db.select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName
          }).from(users)
            .where(sql`LOWER(${users.email}) = LOWER(${booking.owner_email})`)
            .limit(1);

          const owner = ownerResult[0];
          const ownerUserId = owner?.id || null;
          const ownerName = owner ? `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || booking.owner_email : booking.owner_email;

          const feeResult = await db.execute(sql`
            SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                   SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                   SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
            FROM booking_participants
            WHERE session_id = ${sessionId}
          `);

          const totalCents = parseInt((feeResult.rows[0] as Record<string, string>)?.total_cents || '0', 10);
          const overageCents = parseInt((feeResult.rows[0] as Record<string, string>)?.overage_cents || '0', 10);
          const guestCents = parseInt((feeResult.rows[0] as Record<string, string>)?.guest_cents || '0', 10);

          if (totalCents > 0) {
            const prepayResult = await createPrepaymentIntent({
              sessionId,
              bookingId,
              userId: ownerUserId,
              userEmail: booking.owner_email,
              userName: ownerName,
              totalFeeCents: totalCents,
              feeBreakdown: { overageCents, guestCents }
            });

            if (prepayResult?.paidInFull) {
              await db.update(bookingParticipants)
                .set({ paymentStatus: 'paid' })
                .where(and(
                  eq(bookingParticipants.sessionId, sessionId!),
                  eq(bookingParticipants.paymentStatus, 'pending')
                ));
              logger.info('[rosterService:batch] Prepayment fully covered by credit', {
                extra: { sessionId, bookingId, totalCents }
              });
            } else {
              logger.info('[rosterService:batch] Created prepayment intent after batch update', {
                extra: { sessionId, bookingId, totalCents }
              });
            }
          }
        } catch (prepayError: unknown) {
          logger.warn('[rosterService:batch] Failed to create prepayment intent (non-blocking)', {
            error: prepayError as Error,
            extra: { sessionId, bookingId }
          });
        }
      }
    } catch (recalcError: unknown) {
      logger.warn('[rosterService:batch] Failed to recalculate session fees (non-blocking)', {
        error: recalcError as Error,
        extra: { sessionId, bookingId }
      });
    }
  }

  return {
    message: `Batch roster update completed: ${operationResults.filter(r => r.success).length}/${operations.length} operations succeeded`,
    newRosterVersion,
    operationResults,
    feesRecalculated
  };
}
