import { db } from '../../db';
import { bookingParticipants, bookingRequests, users } from '../../../shared/schema';
import { eq, sql, and } from 'drizzle-orm';
import { logger } from '../logger';
import {
  createOrFindGuest,
  linkParticipants,
  getSessionParticipants,
  ensureSessionForBooking,
  type ParticipantInput,
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
import { notifyMember } from '../notificationService';
import { useGuestPass, refundGuestPass, ensureGuestPassRecord } from '../../routes/guestPasses';
import { upsertVisitor } from '../visitors/matchingService';
import { getErrorMessage } from '../../utils/errorUtils';
import { syncBookingInvoice } from '../billing/bookingInvoiceService';
import { broadcastBookingRosterUpdate } from '../websocket';
import {
  type AddParticipantParams,
  type AddParticipantResult,
  createServiceError,
  enforceRosterLock,
  isStaffOrAdminCheck,
  getBookingWithSession,
} from './rosterTypes';

export async function addParticipant(params: AddParticipantParams): Promise<AddParticipantResult> {
  const { bookingId, type, userId, guest, rosterVersion, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  await enforceRosterLock(bookingId);

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);
  if (!isOwner && !isStaff) {
    throw createServiceError('Only the booking owner or staff can add participants', 403);
  }

  let newRosterVersion = 0;
  let deferredGuestPassRefund: { ownerEmail: string; guestName: string | undefined } | null = null;

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

    let sessionId = booking.session_id;

    if (!sessionId) {
      logger.info('[rosterService] Creating session for booking without session_id', {
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
        createdBy: userEmail
      });

      sessionId = sessionResult.sessionId || null;

      if (!sessionId || sessionResult.error) {
        throw createServiceError('Failed to create billing session for this booking. Staff has been notified.', 500);
      }

      logger.info('[rosterService] Session created and linked to booking', {
        extra: { bookingId, sessionId }
      });
    }

    const existingParticipants = await getSessionParticipants(sessionId);
    const declaredCount = booking.declared_player_count || 1;
    const ownerInParticipants = existingParticipants.some(p => p.participantType === 'owner');
    const effectiveCount = ownerInParticipants ? existingParticipants.length : (1 + existingParticipants.length);

    if (effectiveCount >= declaredCount) {
      throw createServiceError('Cannot add more participants. Maximum slot limit reached.', 400, {
        declaredPlayerCount: declaredCount,
        currentCount: effectiveCount
      });
    }

    let memberInfo: { id: string; email: string; firstName: string; lastName: string } | null = null;
    let matchingGuestId: number | null = null;
    let matchingGuestName: string | null = null;

    if (type === 'member') {
      const memberResult = await tx.select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName
      }).from(users)
        .where(sql`${users.id} = ${userId} OR LOWER(${users.email}) = LOWER(${userId})`)
        .limit(1);

      if (memberResult.length === 0) {
        throw createServiceError('Member not found', 404);
      }

      memberInfo = {
        id: memberResult[0].id,
        email: memberResult[0].email!,
        firstName: memberResult[0].firstName!,
        lastName: memberResult[0].lastName!
      };

      const existingMember = existingParticipants.find(p =>
        p.userId === memberInfo!.id ||
        p.userId?.toLowerCase() === memberInfo!.email?.toLowerCase()
      );
      if (existingMember) {
        throw createServiceError('This member is already a participant', 400);
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

        if (matchingGuest) {
          logger.info('[rosterService] Found placeholder guest to replace with member', {
            extra: {
              bookingId,
              placeholderName: matchingGuest.displayName,
              memberName: memberFullName,
              memberEmail: memberInfo.email
            }
          });
        }
      }

      if (matchingGuest) {
        matchingGuestId = matchingGuest.id;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        matchingGuestName = matchingGuest.displayName;
      }

      const conflictResult = await findConflictingBookings(
        memberInfo.email,
        booking.request_date,
        booking.start_time,
        booking.end_time,
        bookingId
      );

      if (conflictResult.hasConflict) {
        const conflict = conflictResult.conflicts[0];
        logger.warn('[rosterService] Conflict detected when adding member', {
          extra: {
            bookingId,
            memberEmail: memberInfo.email,
            conflictingBookingId: conflict.bookingId,
            conflictType: conflict.conflictType,
            date: booking.request_date
          }
        });

        throw createServiceError(
          `This member has a scheduling conflict with another booking on ${booking.request_date}`,
          409,
          {
            errorType: 'booking_conflict',
            conflict: {
              id: conflict.bookingId,
              bookingId: conflict.bookingId,
              date: booking.request_date,
              resourceName: conflict.resourceName,
              startTime: conflict.startTime,
              endTime: conflict.endTime,
              ownerName: conflict.ownerName,
              conflictType: conflict.conflictType
            }
          }
        );
      }
    }

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);

    if (type === 'guest' && ownerTier) {
      const guestDisplayName = guest?.name || 'Guest (info pending)';
      const participantsForValidation: ParticipantForValidation[] = [
        ...existingParticipants.map(p => ({
          type: p.participantType as 'owner' | 'member' | 'guest',
          displayName: p.displayName
        })),
        { type: 'guest', displayName: guestDisplayName }
      ];

      const socialCheck = await enforceSocialTierRules(ownerTier, participantsForValidation);

      if (!socialCheck.allowed) {
        throw createServiceError(
          socialCheck.reason || 'Social tier members cannot bring guests',
          403,
          { errorType: 'social_tier_blocked' }
        );
      }
    }

    let participantInput: ParticipantInput;

    if (type === 'member' && memberInfo) {
      const displayName = [memberInfo.firstName, memberInfo.lastName].filter(Boolean).join(' ') || memberInfo.email;
      participantInput = {
        userId: memberInfo.id,
        participantType: 'member',
        displayName,
      };
    } else if (type === 'guest' && params.useGuestPass === false && !guest) {
      participantInput = {
        participantType: 'guest',
        displayName: 'Guest (info pending)',
      };
    } else {
      const guestId = await createOrFindGuest(
        guest!.name,
        guest!.email,
        undefined,
        sessionUserId || userEmail
      );

      if (guest!.email) {
        const nameParts = guest!.name.trim().split(/\s+/);
        const firstName = nameParts[0] || undefined;
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
        upsertVisitor({
          email: guest!.email,
          firstName,
          lastName,
        }, false).then(visitorUser => {
          logger.info('[rosterService] Visitor record ensured for guest', {
            extra: { guestEmail: guest!.email, visitorUserId: visitorUser.id }
          });
        }).catch(err => {
          logger.error('[rosterService] Non-blocking visitor upsert failed', {
            extra: { guestEmail: guest!.email, error: getErrorMessage(err) }
          });
        });
      }

      if (params.useGuestPass !== false) {
        await ensureGuestPassRecord(booking.owner_email, ownerTier || undefined);
        const guestPassResult = await useGuestPass(booking.owner_email, guest!.name, true);
        if (!guestPassResult.success) {
          throw createServiceError(
            guestPassResult.error || 'No guest passes remaining',
            400,
            { errorType: 'no_guest_passes' }
          );
        }

        participantInput = {
          guestId,
          participantType: 'guest',
          displayName: guest!.name,
        };

        logger.info('[rosterService] Guest pass decremented', {
          extra: {
            bookingId,
            ownerEmail: booking.owner_email,
            guestName: guest!.name,
            remainingPasses: guestPassResult.remaining
          }
        });
      } else {
        participantInput = {
          guestId,
          participantType: 'guest',
          displayName: guest!.name,
        };
      }
    }

    const [newParticipant] = await linkParticipants(sessionId, [participantInput], tx);

    let guestPassesRemaining: number | undefined;
    if (type === 'guest' && newParticipant) {
      if (params.useGuestPass !== false) {
        await tx.update(bookingParticipants)
          .set({ paymentStatus: 'paid' as const, usedGuestPass: true })
          .where(eq(bookingParticipants.id, newParticipant.id));

        const passResult = await tx.execute(sql`
          SELECT passes_total - passes_used as remaining FROM guest_passes WHERE LOWER(member_email) = LOWER(${booking.owner_email})
        `);
        guestPassesRemaining = (passResult.rows[0] as Record<string, number>)?.remaining ?? 0;
      } else {
        await tx.update(bookingParticipants)
          .set({ paymentStatus: 'pending' as const, usedGuestPass: false })
          .where(eq(bookingParticipants.id, newParticipant.id));
      }
    }

    let notificationData: { memberEmail: string; formattedDate: string; timeDisplay: string; ownerName: string; bookingId: number } | null = null;

    if (type === 'member' && memberInfo) {
      const formattedDate = booking.request_date || 'upcoming date';
      const formattedTime = booking.start_time ? booking.start_time.substring(0, 5) : '';
      const timeDisplay = formattedTime ? ` at ${formattedTime}` : '';
      notificationData = {
        memberEmail: memberInfo.email.toLowerCase(),
        formattedDate,
        timeDisplay,
        ownerName: booking.owner_name || 'A member',
        bookingId
      };

      if (matchingGuestId !== null) {
        const guestCheckResult = await tx.execute(sql`
          SELECT id, display_name, used_guest_pass FROM booking_participants 
          WHERE id = ${matchingGuestId} AND session_id = ${sessionId} AND participant_type = 'guest' LIMIT 1
        `);

        interface GuestParticipantRow { id: number; display_name: string; used_guest_pass: boolean }
        if (guestCheckResult.rows.length > 0) {
          const guestToRemove = guestCheckResult.rows[0] as unknown as GuestParticipantRow;
          logger.info('[rosterService] Removing matching guest after successful member add', {
            extra: {
              bookingId,
              sessionId,
              guestParticipantId: guestToRemove.id,
              guestName: guestToRemove.display_name,
              memberEmail: memberInfo.email
            }
          });

          await tx.delete(bookingParticipants)
            .where(eq(bookingParticipants.id, guestToRemove.id));

          if (guestToRemove.used_guest_pass === true) {
            deferredGuestPassRefund = { ownerEmail: booking.owner_email, guestName: guestToRemove.display_name || undefined };
          }
        } else {
          logger.info('[rosterService] Matching guest already removed or changed, skipping delete', {
            extra: { bookingId, sessionId, originalGuestId: matchingGuestId }
          });
        }
      }
    }

    logger.info('[rosterService] Participant added', {
      extra: {
        bookingId,
        sessionId,
        participantType: type,
        participantId: newParticipant.id,
        addedBy: userEmail
      }
    });

    await tx.update(bookingRequests)
      .set({ rosterVersion: sql`COALESCE(roster_version, 0) + 1` })
      .where(eq(bookingRequests.id, bookingId));

    newRosterVersion = currentVersion + 1;

    return {
      participant: newParticipant,
      message: `${type === 'member' ? 'Member' : 'Guest'} added successfully`,
      ...(type === 'guest' && { guestPassesRemaining }),
      newRosterVersion,
      sessionId: sessionId!,
      notificationData,
    };
  });

  if (txResult.notificationData) {
    const nd = txResult.notificationData;
    notifyMember({
      userEmail: nd.memberEmail,
      type: 'booking_update',
      title: 'Added to a booking',
      message: `${nd.ownerName} has added you to their simulator booking on ${nd.formattedDate}${nd.timeDisplay}`,
      relatedId: nd.bookingId
    }).then(() => {
      logger.info('[rosterService] Notification sent', {
        extra: { bookingId, addedMember: nd.memberEmail }
      });
    }).catch((notifError: unknown) => {
      logger.warn('[rosterService] Failed to send notification (non-blocking)', {
        error: notifError as Error,
        extra: { bookingId, memberEmail: nd.memberEmail }
      });
    });
  }

  const gpRefund = deferredGuestPassRefund as unknown as { ownerEmail: string; guestName: string | undefined } | null;
  if (gpRefund) {
    try {
      const refundResult = await refundGuestPass(
        gpRefund.ownerEmail,
        gpRefund.guestName,
        true
      );
      if (refundResult.success) {
        logger.info('[rosterService] Guest pass refunded when replacing guest with member (deferred)', {
          extra: {
            bookingId,
            ownerEmail: gpRefund.ownerEmail,
            guestName: gpRefund.guestName,
            remainingPasses: refundResult.remaining
          }
        });
      } else {
        logger.error('[rosterService] Guest pass refund failed when replacing guest with member', {
          extra: { bookingId, ownerEmail: gpRefund.ownerEmail, guestName: gpRefund.guestName, error: refundResult.error }
        });
      }
    } catch (refundErr: unknown) {
      logger.warn('[rosterService] Failed to refund guest pass after tx (non-blocking)', {
        error: refundErr as Error,
        extra: { bookingId, ownerEmail: gpRefund.ownerEmail }
      });
    }
  }

  if (!params.deferFeeRecalc) {
    try {
      const sessionId = txResult.sessionId;
      const allParticipants = await getSessionParticipants(sessionId);
      const participantIds = allParticipants.map(p => p.id);

      await invalidateCachedFees(participantIds, 'participant_added');

      const recalcResult = await recalculateSessionFees(sessionId, 'roster_update');
      logger.info('[rosterService] Session fees recalculated after adding participant', {
        extra: {
          sessionId,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.totals.totalCents,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });

      syncBookingInvoice(bookingId, sessionId).catch(err => {
        logger.warn('[rosterService] Non-blocking: draft invoice sync failed after roster change', { extra: { error: getErrorMessage(err), bookingId, sessionId } });
      });

      broadcastBookingRosterUpdate({
        bookingId,
        sessionId,
        action: 'participant_added',
        memberEmail: booking.owner_email,
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
                  eq(bookingParticipants.sessionId, sessionId),
                  eq(bookingParticipants.paymentStatus, 'pending')
                ));
              logger.info('[rosterService] Prepayment fully covered by credit', {
                extra: { sessionId, bookingId, totalCents }
              });
            } else {
              logger.info('[rosterService] Created prepayment intent after adding participant', {
                extra: { sessionId, bookingId, totalCents }
              });
            }
          }
        } catch (prepayError: unknown) {
          logger.warn('[rosterService] Failed to create prepayment intent (non-blocking)', {
            error: prepayError as Error,
            extra: { sessionId, bookingId }
          });
        }
      }
    } catch (recalcError: unknown) {
      logger.warn('[rosterService] Failed to recalculate session fees (non-blocking)', {
        error: recalcError as Error,
        extra: { sessionId: txResult.sessionId, bookingId }
      });
    }
  }

  return {
    participant: txResult.participant,
    message: txResult.message,
    ...(txResult.guestPassesRemaining !== undefined && { guestPassesRemaining: txResult.guestPassesRemaining }),
    newRosterVersion: txResult.newRosterVersion
  };
}
