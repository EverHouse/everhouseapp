import { db } from '../db';
import { pool } from './db';
import { PoolClient } from 'pg';
import {
  bookingRequests,
  bookingParticipants,
  bookingSessions,
  guests,
  users
} from '../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from './logger';
import {
  createOrFindGuest,
  linkParticipants,
  getSessionParticipants,
  ensureSessionForBooking,
  type ParticipantInput
} from './bookingService/sessionManager';
import {
  enforceSocialTierRules,
  getMemberTier,
  getGuestPassesRemaining,
  getRemainingMinutes,
  type ParticipantForValidation
} from './bookingService/tierRules';
import {
  computeUsageAllocation,
  calculateOverageFee,
  type Participant as UsageParticipant
} from './bookingService/usageCalculator';
import { getTierLimits, getMemberTierByEmail } from './tierService';
import { useGuestPass, refundGuestPass, ensureGuestPassRecord } from '../routes/guestPasses';
import {
  findConflictingBookings,
  checkMemberAvailability
} from './bookingService/conflictDetection';
import { notifyMember } from './notificationService';
import { getStripeClient } from './stripe/client';
import { getOrCreateStripeCustomer } from './stripe/customers';
import { createBalanceAwarePayment } from './stripe/payments';
import { computeFeeBreakdown, getEffectivePlayerCount, invalidateCachedFees, recalculateSessionFees } from './billing/unifiedFeeService';
import { PRICING } from './billing/pricingConfig';
import { createPrepaymentIntent } from './billing/prepaymentService';
import { getErrorMessage } from '../utils/errorUtils';

export type RosterError = {
  status: number;
  error: string;
  code?: string;
  errorType?: string;
  extra?: Record<string, unknown>;
};

export type RosterResult<T> =
  | { ok: true; data: T }
  | { ok: false; err: RosterError };

function fail(status: number, error: string, extra?: Record<string, unknown>): RosterResult<never> {
  return { ok: false, err: { status, error, ...extra } };
}

function ok<T>(data: T): RosterResult<T> {
  return { ok: true, data };
}

export async function isStaffOrAdminCheck(email: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../replit_integrations/auth/replitAuth');
  const isAdmin = await isAdminEmail(email);
  if (isAdmin) return true;

  const authPool = getAuthPool();
  if (!authPool) return false;

  try {
    const result = await queryWithRetry(
      authPool,
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    return result.rows.length > 0;
  } catch (error: unknown) {
    logger.error('[isStaffOrAdminCheck] DB error, defaulting to false', { extra: { error: (error as Error).message } });
    return false;
  }
}

export async function getBookingWithSession(bookingId: number) {
  const result = await pool.query(
    `SELECT 
      br.id as booking_id,
      br.user_email as owner_email,
      br.user_name as owner_name,
      br.request_date,
      br.start_time,
      br.end_time,
      br.duration_minutes,
      br.declared_player_count,
      br.status,
      br.session_id,
      br.resource_id,
      br.notes,
      br.staff_notes,
      br.roster_version,
      r.name as resource_name,
      u.tier as owner_tier
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
    WHERE br.id = $1`,
    [bookingId]
  );
  return result.rows[0] || null;
}

export async function getParticipantsData(
  bookingId: number,
  userEmail: string,
  isStaff: boolean,
  isOwner: boolean,
  userId?: string
) {
  const booking = await getBookingWithSession(bookingId);
  if (!booking) return fail(404, 'Booking not found');

  if (!isOwner && !isStaff) {
    const participantCheck = await pool.query(
      `SELECT 1 FROM booking_participants bp
       JOIN booking_sessions bs ON bp.session_id = bs.id
       JOIN booking_requests br ON br.session_id = bs.id
       WHERE br.id = $1 AND bp.user_id = $2
       LIMIT 1`,
      [bookingId, userId || userEmail]
    );
    if (participantCheck.rows.length === 0) {
      return fail(403, 'Access denied');
    }
  }

  let participants: Record<string, unknown>[] = [];
  if (booking.session_id) {
    const participantRows = await db
      .select({
        id: bookingParticipants.id,
        sessionId: bookingParticipants.sessionId,
        userId: bookingParticipants.userId,
        guestId: bookingParticipants.guestId,
        participantType: bookingParticipants.participantType,
        displayName: bookingParticipants.displayName,
        slotDuration: bookingParticipants.slotDuration,
        paymentStatus: bookingParticipants.paymentStatus,
        inviteStatus: bookingParticipants.inviteStatus,
        createdAt: bookingParticipants.createdAt,
      })
      .from(bookingParticipants)
      .where(eq(bookingParticipants.sessionId, booking.session_id));

    participants = participantRows;
  }

  const declaredCount = booking.declared_player_count || 1;
  const ownerInParticipants = participants.some(p => p.participantType === 'owner');
  const currentCount = ownerInParticipants ? participants.length : (1 + participants.length);
  const remainingSlots = Math.max(0, declaredCount - currentCount);

  const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);
  let guestPassesRemaining = 0;
  let remainingMinutes = 0;

  let resourceTypeForRoster = 'simulator';
  if (booking.resource_id) {
    const resourceResult = await pool.query(
      'SELECT type FROM resources WHERE id = $1',
      [booking.resource_id]
    );
    resourceTypeForRoster = resourceResult.rows[0]?.type || 'simulator';
  }

  if (ownerTier) {
    [guestPassesRemaining, remainingMinutes] = await Promise.all([
      getGuestPassesRemaining(booking.owner_email),
      getRemainingMinutes(booking.owner_email, ownerTier, booking.request_date, resourceTypeForRoster)
    ]);
  }

  const guestCount = participants.filter(p => p.participantType === 'guest').length;

  return ok({
    booking: {
      id: booking.booking_id,
      ownerEmail: booking.owner_email,
      ownerName: booking.owner_name,
      requestDate: booking.request_date,
      startTime: booking.start_time,
      endTime: booking.end_time,
      durationMinutes: booking.duration_minutes,
      resourceId: booking.resource_id,
      resourceName: booking.resource_name,
      status: booking.status,
      sessionId: booking.session_id,
      notes: booking.notes || null,
      staffNotes: booking.staff_notes || null,
    },
    declaredPlayerCount: declaredCount,
    currentParticipantCount: currentCount,
    remainingSlots,
    participants,
    ownerTier,
    guestPassesRemaining,
    guestPassesUsed: guestCount,
    remainingMinutes,
    rosterVersion: booking.roster_version ?? 0,
  });
}

export async function addParticipant(params: {
  bookingId: number;
  type: 'member' | 'guest';
  userId?: string;
  guest?: { name: string; email: string };
  rosterVersion?: number;
  userEmail: string;
  sessionUserId?: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  const { bookingId, type, userId, guest, rosterVersion, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) return fail(404, 'Booking not found');

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    return fail(403, 'Only the booking owner or staff can add participants');
  }

  const client = await pool.connect();
  let newRosterVersion: number;

  try {
    await client.query('BEGIN');

    const lockedBooking = await client.query(
      `SELECT roster_version FROM booking_requests WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (!lockedBooking.rows.length) {
      await client.query('ROLLBACK');
      return fail(404, 'Booking not found');
    }

    const currentVersion = lockedBooking.rows[0].roster_version ?? 0;

    if (rosterVersion !== undefined && currentVersion !== rosterVersion) {
      await client.query('ROLLBACK');
      return fail(409, 'Roster was modified by another user', {
        code: 'ROSTER_CONFLICT',
        extra: { currentVersion }
      });
    }

    let sessionId = booking.session_id;

    if (!sessionId) {
      logger.info('[roster] Creating session for booking without session_id', {
        extra: { bookingId, ownerEmail: booking.owner_email }
      });

      const sessionResult = await ensureSessionForBooking({
        bookingId,
        resourceId: booking.resource_id,
        sessionDate: booking.request_date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        ownerEmail: booking.owner_email,
        source: 'staff_manual',
        createdBy: userEmail
      }, client);

      sessionId = sessionResult.sessionId || null;

      if (!sessionId || sessionResult.error) {
        await client.query('ROLLBACK');
        return fail(500, 'Failed to create billing session for this booking. Staff has been notified.');
      }

      logger.info('[roster] Session created and linked to booking', {
        extra: { bookingId, sessionId }
      });
    }

    const existingParticipants = await getSessionParticipants(sessionId);
    const declaredCount = booking.declared_player_count || 1;

    const ownerInParticipants = existingParticipants.some(p => p.participantType === 'owner');
    const effectiveCount = ownerInParticipants ? existingParticipants.length : (1 + existingParticipants.length);

    if (effectiveCount >= declaredCount) {
      await client.query('ROLLBACK');
      return fail(400, 'Cannot add more participants. Maximum slot limit reached.', {
        extra: { declaredPlayerCount: declaredCount, currentCount: effectiveCount }
      });
    }

    let memberInfo: { id: string; email: string; firstName: string; lastName: string } | null = null;
    let matchingGuestId: number | null = null;
    let matchingGuestName: string | null = null;

    if (type === 'member') {
      const memberResult = await pool.query(
        `SELECT id, email, first_name, last_name FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
        [userId]
      );

      if (memberResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return fail(404, 'Member not found');
      }

      memberInfo = {
        id: memberResult.rows[0].id,
        email: memberResult.rows[0].email,
        firstName: memberResult.rows[0].first_name,
        lastName: memberResult.rows[0].last_name
      };

      const existingMember = existingParticipants.find(p =>
        p.userId === memberInfo!.id ||
        p.userId?.toLowerCase() === memberInfo!.email?.toLowerCase()
      );
      if (existingMember) {
        await client.query('ROLLBACK');
        return fail(400, 'This member is already a participant');
      }

      const memberFullName = `${memberInfo.firstName || ''} ${memberInfo.lastName || ''}`.trim().toLowerCase();
      const normalize = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();
      const normalizedMember = normalize(memberFullName);

      const isPlaceholderGuest = (name: string | null): boolean => {
        if (!name) return false;
        const normalized = name.trim().toLowerCase();
        return /^guest\s+\d+$/.test(normalized) ||
               /^guest\s*\(.*pending.*\)$/i.test(normalized);
      };

      let matchingGuest = existingParticipants.find(p => {
        if (p.participantType !== 'guest') return false;
        const normalizedGuest = normalize(p.displayName || '');
        return normalizedGuest === normalizedMember;
      });

      if (!matchingGuest) {
        matchingGuest = existingParticipants.find(p => {
          if (p.participantType !== 'guest') return false;
          return isPlaceholderGuest(p.displayName);
        });

        if (matchingGuest) {
          logger.info('[roster] Found placeholder guest to replace with member', {
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
        logger.warn('[roster] Conflict detected when adding member', {
          extra: {
            bookingId,
            memberEmail: memberInfo.email,
            conflictingBookingId: conflict.bookingId,
            conflictType: conflict.conflictType,
            date: booking.request_date
          }
        });

        await client.query('ROLLBACK');
        return fail(409, `This member has a scheduling conflict with another booking on ${booking.request_date}`, {
          errorType: 'booking_conflict',
          extra: {
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
        });
      }
    }

    const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);

    if (type === 'guest' && ownerTier) {
      const participantsForValidation: ParticipantForValidation[] = [
        ...existingParticipants.map(p => ({
          type: p.participantType as 'owner' | 'member' | 'guest',
          displayName: p.displayName
        })),
        { type: 'guest', displayName: guest!.name }
      ];

      const socialCheck = await enforceSocialTierRules(ownerTier, participantsForValidation);

      if (!socialCheck.allowed) {
        await client.query('ROLLBACK');
        return fail(403, socialCheck.reason || 'Social tier members cannot bring guests', {
          errorType: 'social_tier_blocked'
        });
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
    } else {
      await ensureGuestPassRecord(booking.owner_email, ownerTier || undefined);

      const guestPassResult = await useGuestPass(booking.owner_email, guest!.name, true);
      if (!guestPassResult.success) {
        await client.query('ROLLBACK');
        return fail(400, guestPassResult.error || 'No guest passes remaining', {
          errorType: 'no_guest_passes'
        });
      }

      const guestId = await createOrFindGuest(
        guest!.name,
        guest!.email,
        undefined,
        sessionUserId || userEmail
      );

      participantInput = {
        guestId,
        participantType: 'guest',
        displayName: guest!.name,
      };

      logger.info('[roster] Guest pass decremented', {
        extra: {
          bookingId,
          ownerEmail: booking.owner_email,
          guestName: guest!.name,
          remainingPasses: guestPassResult.remaining
        }
      });
    }

    const [newParticipant] = await linkParticipants(sessionId, [participantInput]);

    let guestPassesRemaining: number | undefined;
    if (type === 'guest' && newParticipant) {
      await client.query(
        `UPDATE booking_participants SET payment_status = 'paid' WHERE id = $1`,
        [newParticipant.id]
      );

      const passResult = await client.query(
        `SELECT passes_total - passes_used as remaining FROM guest_passes WHERE LOWER(member_email) = LOWER($1)`,
        [booking.owner_email]
      );
      guestPassesRemaining = passResult.rows[0]?.remaining ?? 0;
    }

    if (type === 'member' && memberInfo) {
      const slotResult = await client.query(
        `SELECT COALESCE(MAX(slot_number), 0) + 1 as next_slot FROM booking_members WHERE booking_id = $1`,
        [bookingId]
      );
      const nextSlot = slotResult.rows[0]?.next_slot || 2;

      const existingMemberRow = await client.query(
        `SELECT id FROM booking_members WHERE booking_id = $1 AND LOWER(user_email) = LOWER($2)`,
        [bookingId, memberInfo.email]
      );

      if (existingMemberRow.rows.length === 0) {
        await client.query(
          `INSERT INTO booking_members (booking_id, user_email, slot_number, is_primary, linked_at, linked_by, created_at)
           VALUES ($1, $2, $3, false, NOW(), $4, NOW())`,
          [bookingId, memberInfo.email.toLowerCase(), nextSlot, userEmail]
        );
      }

      logger.info('[roster] Member linked to booking_members', {
        extra: { bookingId, memberEmail: memberInfo.email, slotNumber: nextSlot }
      });

      try {
        const formattedDate = booking.request_date || 'upcoming date';
        const formattedTime = booking.start_time ? booking.start_time.substring(0, 5) : '';
        const timeDisplay = formattedTime ? ` at ${formattedTime}` : '';

        await notifyMember({
          userEmail: memberInfo.email.toLowerCase(),
          type: 'booking_update',
          title: 'Added to a booking',
          message: `${booking.owner_name || 'A member'} has added you to their simulator booking on ${formattedDate}${timeDisplay}`,
          relatedId: bookingId
        });

        logger.info('[roster] Notification sent', {
          extra: { bookingId, addedMember: memberInfo.email }
        });
      } catch (notifError: unknown) {
        logger.warn('[roster] Failed to send notification (non-blocking)', {
          error: notifError as Error,
          extra: { bookingId, memberEmail: memberInfo.email }
        });
      }

      if (matchingGuestId !== null) {
        const guestCheckResult = await client.query(
          `SELECT id, display_name, used_guest_pass FROM booking_participants 
           WHERE id = $1 AND session_id = $2 AND participant_type = 'guest' LIMIT 1`,
          [matchingGuestId, sessionId]
        );

        if (guestCheckResult.rows.length > 0) {
          const guestToRemove = guestCheckResult.rows[0];
          logger.info('[roster] Removing matching guest after successful member add', {
            extra: {
              bookingId,
              sessionId,
              guestParticipantId: guestToRemove.id,
              guestName: guestToRemove.display_name,
              memberEmail: memberInfo.email
            }
          });

          await client.query(
            `DELETE FROM booking_participants WHERE id = $1`,
            [guestToRemove.id]
          );

          if (guestToRemove.used_guest_pass === true) {
            const refundResult = await refundGuestPass(
              booking.owner_email,
              guestToRemove.display_name || undefined,
              true
            );

            if (refundResult.success) {
              logger.info('[roster] Guest pass refunded when replacing guest with member', {
                extra: {
                  bookingId,
                  ownerEmail: booking.owner_email,
                  guestName: guestToRemove.display_name,
                  remainingPasses: refundResult.remaining
                }
              });
            }
          }
        } else {
          logger.info('[roster] Matching guest already removed or changed, skipping delete', {
            extra: { bookingId, sessionId, originalGuestId: matchingGuestId }
          });
        }
      }
    }

    logger.info('[roster] Participant added', {
      extra: {
        bookingId,
        sessionId,
        participantType: type,
        participantId: newParticipant.id,
        addedBy: userEmail
      }
    });

    try {
      const allParticipants = await getSessionParticipants(sessionId);
      const participantIds = allParticipants.map(p => p.id);

      await invalidateCachedFees(participantIds, 'participant_added');

      const recalcResult = await recalculateSessionFees(sessionId, 'roster_update');
      logger.info('[roster] Session fees recalculated after adding participant', {
        extra: {
          sessionId,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.billingResult.totalFees,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });

      if (recalcResult.billingResult.totalFees > 0) {
        try {
          const ownerResult = await pool.query(
            `SELECT u.id, u.email, u.first_name, u.last_name 
             FROM users u 
             WHERE LOWER(u.email) = LOWER($1)
             LIMIT 1`,
            [booking.owner_email]
          );

          const owner = ownerResult.rows[0];
          const ownerUserId = owner?.id || null;
          const ownerName = owner ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || booking.owner_email : booking.owner_email;

          const feeResult = await pool.query(`
            SELECT SUM(COALESCE(cached_fee_cents, 0)) as total_cents,
                   SUM(CASE WHEN participant_type = 'owner' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as overage_cents,
                   SUM(CASE WHEN participant_type = 'guest' THEN COALESCE(cached_fee_cents, 0) ELSE 0 END) as guest_cents
            FROM booking_participants
            WHERE session_id = $1
          `, [sessionId]);

          const totalCents = parseInt(feeResult.rows[0]?.total_cents || '0');
          const overageCents = parseInt(feeResult.rows[0]?.overage_cents || '0');
          const guestCents = parseInt(feeResult.rows[0]?.guest_cents || '0');

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
              await pool.query(
                `UPDATE booking_participants SET payment_status = 'paid' WHERE session_id = $1 AND payment_status = 'pending'`,
                [sessionId]
              );
              logger.info('[roster] Prepayment fully covered by credit', {
                extra: { sessionId, bookingId, totalCents }
              });
            } else {
              logger.info('[roster] Created prepayment intent after adding participant', {
                extra: { sessionId, bookingId, totalCents }
              });
            }
          }
        } catch (prepayError: unknown) {
          logger.warn('[roster] Failed to create prepayment intent (non-blocking)', {
            error: prepayError as Error,
            extra: { sessionId, bookingId }
          });
        }
      }
    } catch (recalcError: unknown) {
      logger.warn('[roster] Failed to recalculate session fees (non-blocking)', {
        error: recalcError as Error,
        extra: { sessionId, bookingId }
      });
    }

    await client.query(
      `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`,
      [bookingId]
    );

    newRosterVersion = (lockedBooking.rows[0].roster_version ?? 0) + 1;

    await client.query('COMMIT');

    return ok({
      success: true,
      participant: newParticipant,
      message: `${type === 'member' ? 'Member' : 'Guest'} added successfully`,
      ...(type === 'guest' && { guestPassesRemaining }),
      newRosterVersion
    });
  } catch (txError: unknown) {
    await client.query('ROLLBACK');
    throw txError;
  } finally {
    client.release();
  }
}

export async function removeParticipant(params: {
  bookingId: number;
  participantId: number;
  rosterVersion?: number;
  userEmail: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  const { bookingId, participantId, rosterVersion, userEmail } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) return fail(404, 'Booking not found');

  if (!booking.session_id) {
    return fail(400, 'Booking does not have an active session');
  }

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  const [participant] = await db
    .select()
    .from(bookingParticipants)
    .where(and(
      eq(bookingParticipants.id, participantId),
      eq(bookingParticipants.sessionId, booking.session_id)
    ))
    .limit(1);

  if (!participant) {
    return fail(404, 'Participant not found');
  }

  let isSelf = false;
  if (participant.userId) {
    const userResult = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [userEmail]
    );
    if (userResult.rows.length > 0 && userResult.rows[0].id === participant.userId) {
      isSelf = true;
    }
  }

  if (!isOwner && !isStaff && !isSelf) {
    return fail(403, 'Only the booking owner, staff, or the participant themselves can remove this participant');
  }

  if (participant.participantType === 'owner') {
    return fail(400, 'Cannot remove the booking owner');
  }

  const client = await pool.connect();
  let newRosterVersion: number;

  try {
    await client.query('BEGIN');

    const lockedBooking = await client.query(
      `SELECT roster_version FROM booking_requests WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (!lockedBooking.rows.length) {
      await client.query('ROLLBACK');
      return fail(404, 'Booking not found');
    }

    const currentVersion = lockedBooking.rows[0].roster_version ?? 0;

    if (rosterVersion !== undefined && currentVersion !== rosterVersion) {
      await client.query('ROLLBACK');
      return fail(409, 'Roster was modified by another user', {
        code: 'ROSTER_CONFLICT',
        extra: { currentVersion }
      });
    }

    let guestPassesRemaining: number | undefined;
    if (participant.participantType === 'guest') {
      const refundResult = await refundGuestPass(
        booking.owner_email,
        participant.displayName || undefined,
        true
      );

      if (refundResult.success) {
        guestPassesRemaining = refundResult.remaining;
        logger.info('[roster] Guest pass refunded on participant removal', {
          extra: {
            bookingId,
            ownerEmail: booking.owner_email,
            guestName: participant.displayName,
            remainingPasses: refundResult.remaining
          }
        });
      } else {
        logger.warn('[roster] Failed to refund guest pass (non-blocking)', {
          extra: {
            bookingId,
            ownerEmail: booking.owner_email,
            error: refundResult.error
          }
        });
      }
    }

    await client.query(
      `DELETE FROM booking_participants WHERE id = $1`,
      [participantId]
    );

    if (participant.participantType === 'member' && participant.userId) {
      const memberResult = await client.query(
        `SELECT email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
        [participant.userId]
      );

      if (memberResult.rows.length > 0) {
        const memberEmail = memberResult.rows[0].email.toLowerCase();
        await client.query(
          `DELETE FROM booking_members WHERE booking_id = $1 AND LOWER(user_email) = LOWER($2)`,
          [bookingId, memberEmail]
        );

        logger.info('[roster] Member removed from booking_members', {
          extra: { bookingId, memberEmail }
        });
      }
    }

    logger.info('[roster] Participant removed', {
      extra: {
        bookingId,
        sessionId: booking.session_id,
        participantId,
        participantType: participant.participantType,
        removedBy: userEmail
      }
    });

    try {
      const remainingParticipants = await getSessionParticipants(booking.session_id);
      const participantIds = remainingParticipants.map(p => p.id);

      await invalidateCachedFees(participantIds, 'participant_removed');

      const recalcResult = await recalculateSessionFees(booking.session_id, 'roster_update');
      logger.info('[roster] Session fees recalculated after removing participant', {
        extra: {
          sessionId: booking.session_id,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.billingResult.totalFees,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });
    } catch (recalcError: unknown) {
      logger.warn('[roster] Failed to recalculate session fees (non-blocking)', {
        error: recalcError as Error,
        extra: { sessionId: booking.session_id, bookingId }
      });
    }

    await client.query(
      `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`,
      [bookingId]
    );

    newRosterVersion = (lockedBooking.rows[0].roster_version ?? 0) + 1;

    await client.query('COMMIT');

    return ok({
      success: true,
      message: 'Participant removed successfully',
      ...(participant.participantType === 'guest' && guestPassesRemaining !== undefined && { guestPassesRemaining }),
      newRosterVersion
    });
  } catch (txError: unknown) {
    await client.query('ROLLBACK');
    throw txError;
  } finally {
    client.release();
  }
}

export async function previewFees(params: {
  bookingId: number;
  provisionalParticipants?: Array<{ type: string; name: string; email?: string }>;
}): Promise<RosterResult<Record<string, unknown>>> {
  const { bookingId, provisionalParticipants = [] } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) return fail(404, 'Booking not found');

  let existingParticipants: Record<string, unknown>[] = [];
  if (booking.session_id) {
    existingParticipants = await getSessionParticipants(booking.session_id);
  }

  const allParticipants = [...existingParticipants];
  for (const prov of provisionalParticipants) {
    if (prov && prov.type && prov.name) {
      allParticipants.push({
        participantType: prov.type,
        displayName: prov.name,
        email: prov.email
      });
    }
  }

  const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);
  const durationMinutes = booking.duration_minutes || 60;
  const declaredPlayerCount = booking.declared_player_count || 1;

  let resourceCapacity: number | null = null;
  let isConferenceRoom = false;
  if (booking.resource_id) {
    const resourceResult = await pool.query(
      'SELECT capacity, type FROM resources WHERE id = $1',
      [booking.resource_id]
    );
    if (resourceResult.rows[0]?.capacity) {
      resourceCapacity = resourceResult.rows[0].capacity;
    }
    isConferenceRoom = resourceResult.rows[0]?.type === 'conference_room';
  }

  const ownerInAll = allParticipants.some(p => p.participantType === 'owner');
  const actualParticipantCount = ownerInAll ? allParticipants.length : (1 + allParticipants.length);

  const effectivePlayerCount = getEffectivePlayerCount(declaredPlayerCount, actualParticipantCount);

  const totalSlots = resourceCapacity
    ? Math.max(1, Math.min(effectivePlayerCount, resourceCapacity))
    : Math.max(1, effectivePlayerCount);

  let dailyAllowance = 60;
  let guestPassesPerMonth = 0;
  let remainingMinutesToday = 0;

  if (ownerTier) {
    const tierLimits = await getTierLimits(ownerTier);
    if (tierLimits) {
      dailyAllowance = isConferenceRoom
        ? tierLimits.daily_conf_room_minutes
        : tierLimits.daily_sim_minutes;
      guestPassesPerMonth = tierLimits.guest_passes_per_month;
    }
    const resourceTypeForRemaining = isConferenceRoom ? 'conference_room' : 'simulator';
    remainingMinutesToday = await getRemainingMinutes(booking.owner_email, ownerTier, booking.request_date, resourceTypeForRemaining);
  }

  const ownerInParticipants = allParticipants.some(p => p.participantType === 'owner');
  const participantsForFeeCalc: Array<{
    userId?: string;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
  }> = [];

  if (!ownerInParticipants) {
    participantsForFeeCalc.push({
      email: booking.owner_email,
      displayName: booking.owner_name || booking.owner_email,
      participantType: 'owner'
    });
  }

  for (const p of allParticipants) {
    participantsForFeeCalc.push({
      userId: p.userId,
      email: p.email,
      displayName: p.displayName,
      participantType: p.participantType as 'owner' | 'member' | 'guest'
    });
  }

  let breakdown;
  try {
    breakdown = await computeFeeBreakdown(
      booking.session_id
        ? {
            sessionId: booking.session_id,
            declaredPlayerCount: effectivePlayerCount,
            source: 'roster_update' as const,
            excludeSessionFromUsage: true,
            isConferenceRoom
          }
        : {
            sessionDate: booking.request_date,
            sessionDuration: durationMinutes,
            declaredPlayerCount: effectivePlayerCount,
            hostEmail: booking.owner_email,
            participants: participantsForFeeCalc,
            source: 'roster_update' as const,
            isConferenceRoom
          }
    );
  } catch (feeError: unknown) {
    logger.warn('[roster] Failed to compute unified fee breakdown, using fallback', {
      error: feeError as Error,
      extra: { bookingId, sessionId: booking.session_id }
    });

    const allocations = computeUsageAllocation(durationMinutes, participantsForFeeCalc.map(p => ({
      participantType: p.participantType,
      displayName: p.displayName
    })), {
      declaredSlots: totalSlots,
      assignRemainderToOwner: true
    });

    const guestCount = allParticipants.filter(p => p.participantType === 'guest').length;
    const memberCount = allParticipants.filter(p => p.participantType === 'member').length;
    const minutesPerPlayer = Math.floor(durationMinutes / totalSlots);
    const ownerAllocation = allocations.find(a => a.participantType === 'owner');
    const baseOwnerMinutes = ownerAllocation?.minutesAllocated || minutesPerPlayer;
    const filledSlots = participantsForFeeCalc.length;
    const unfilledSlots = Math.max(0, totalSlots - filledSlots);
    const unfilledMinutes = unfilledSlots * minutesPerPlayer;
    const ownerMinutes = baseOwnerMinutes + unfilledMinutes;
    const guestMinutes = allocations
      .filter(a => a.participantType === 'guest')
      .reduce((sum, a) => sum + a.minutesAllocated, 0);
    const totalOwnerResponsibleMinutes = ownerMinutes + guestMinutes;

    let overageFee = 0;
    let overageMinutes = 0;
    let minutesWithinAllowance = 0;

    if (dailyAllowance > 0 && dailyAllowance < 999) {
      const overageResult = calculateOverageFee(totalOwnerResponsibleMinutes, remainingMinutesToday);
      overageFee = overageResult.overageFee;
      overageMinutes = overageResult.overageMinutes;
      minutesWithinAllowance = Math.max(0, totalOwnerResponsibleMinutes - overageMinutes);
    } else if (dailyAllowance >= 999) {
      minutesWithinAllowance = totalOwnerResponsibleMinutes;
    }

    const guestPassesRemaining = ownerTier
      ? await getGuestPassesRemaining(booking.owner_email)
      : 0;

    return ok({
      booking: {
        id: booking.booking_id,
        durationMinutes,
        startTime: booking.start_time,
        endTime: booking.end_time,
      },
      participants: {
        total: allParticipants.length,
        members: memberCount,
        guests: guestCount,
        owner: 1,
      },
      timeAllocation: {
        totalMinutes: durationMinutes,
        declaredPlayerCount,
        actualParticipantCount,
        effectivePlayerCount,
        totalSlots,
        minutesPerParticipant: minutesPerPlayer,
        allocations: allocations.map(a => ({
          displayName: a.displayName,
          type: a.participantType,
          minutes: a.minutesAllocated,
        })),
      },
      ownerFees: {
        tier: ownerTier,
        dailyAllowance,
        remainingMinutesToday,
        ownerMinutesUsed: ownerMinutes,
        guestMinutesCharged: guestMinutes,
        totalMinutesResponsible: totalOwnerResponsibleMinutes,
        minutesWithinAllowance,
        overageMinutes,
        estimatedOverageFee: overageFee,
      },
      guestPasses: {
        monthlyAllowance: guestPassesPerMonth,
        remaining: guestPassesRemaining,
        usedThisBooking: guestCount,
        afterBooking: Math.max(0, guestPassesRemaining - guestCount),
      },
    });
  }

  const guestCount = allParticipants.filter(p => p.participantType === 'guest').length;
  const memberCount = allParticipants.filter(p => p.participantType === 'member').length;
  const minutesPerPlayer = Math.floor(durationMinutes / totalSlots);

  const ownerLineItem = breakdown.participants.find(p => p.participantType === 'owner');
  const ownerMinutes = ownerLineItem?.minutesAllocated || breakdown.metadata.sessionDuration;
  const guestMinutes = breakdown.participants
    .filter(p => p.participantType === 'guest')
    .reduce((sum, p) => sum + p.minutesAllocated, 0);
  const totalOwnerResponsibleMinutes = ownerMinutes + guestMinutes;

  const overageFee = Math.round(breakdown.totals.overageCents / 100);
  const overageMinutes = overageFee > 0 ? Math.ceil(overageFee / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES : 0;
  const minutesWithinAllowance = Math.max(0, totalOwnerResponsibleMinutes - overageMinutes);

  return ok({
    booking: {
      id: booking.booking_id,
      durationMinutes,
      startTime: booking.start_time,
      endTime: booking.end_time,
    },
    participants: {
      total: allParticipants.length,
      members: memberCount,
      guests: guestCount,
      owner: 1,
    },
    timeAllocation: {
      totalMinutes: durationMinutes,
      declaredPlayerCount,
      actualParticipantCount,
      effectivePlayerCount: breakdown.metadata.effectivePlayerCount,
      totalSlots,
      minutesPerParticipant: minutesPerPlayer,
      allocations: breakdown.participants.map(p => ({
        displayName: p.displayName,
        type: p.participantType,
        minutes: p.minutesAllocated,
        feeCents: p.totalCents,
      })),
    },
    ownerFees: {
      tier: ownerTier,
      dailyAllowance,
      remainingMinutesToday,
      ownerMinutesUsed: ownerMinutes,
      guestMinutesCharged: guestMinutes,
      totalMinutesResponsible: totalOwnerResponsibleMinutes,
      minutesWithinAllowance,
      overageMinutes,
      estimatedOverageFee: overageFee,
      estimatedGuestFees: Math.round(breakdown.totals.guestCents / 100),
      estimatedTotalFees: Math.round(breakdown.totals.totalCents / 100),
    },
    guestPasses: {
      monthlyAllowance: guestPassesPerMonth,
      remaining: breakdown.totals.guestPassesAvailable,
      usedThisBooking: breakdown.totals.guestPassesUsed,
      afterBooking: Math.max(0, breakdown.totals.guestPassesAvailable - guestCount),
    },
    unifiedBreakdown: breakdown,
  });
}

export async function acceptInvite(params: {
  bookingId: number;
  userEmail: string;
  onBehalfOf?: string;
  sessionUserRole?: string;
  sessionUserEmail?: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  let userEmail = params.userEmail;

  if (params.onBehalfOf && typeof params.onBehalfOf === 'string') {
    if (params.sessionUserRole !== 'admin') {
      return fail(403, 'Only admins can accept invites on behalf of others');
    }
    userEmail = params.onBehalfOf.toLowerCase();
    logger.info('[Invite Accept] Admin acting on behalf of member', {
      extra: { adminEmail: params.sessionUserEmail, targetEmail: userEmail, bookingId: params.bookingId }
    });
  }

  const booking = await getBookingWithSession(params.bookingId);
  if (!booking) return fail(404, 'Booking not found');

  if (!booking.session_id) {
    return fail(400, 'Booking has no session - cannot accept invite');
  }

  const participantResult = await db
    .select({
      id: bookingParticipants.id,
      sessionId: bookingParticipants.sessionId,
      userId: bookingParticipants.userId,
      inviteStatus: bookingParticipants.inviteStatus,
      displayName: bookingParticipants.displayName,
      participantType: bookingParticipants.participantType
    })
    .from(bookingParticipants)
    .innerJoin(users, eq(bookingParticipants.userId, users.id))
    .where(and(
      eq(bookingParticipants.sessionId, booking.session_id),
      sql`LOWER(${users.email}) = ${userEmail}`
    ))
    .limit(1);

  if (!participantResult[0]) {
    return fail(404, 'You are not a participant on this booking');
  }

  const participant = participantResult[0];

  if (participant.inviteStatus === 'accepted') {
    return ok({ success: true, message: 'Invite already accepted' });
  }

  const conflictResult = await findConflictingBookings(
    userEmail,
    booking.request_date,
    booking.start_time,
    booking.end_time,
    params.bookingId
  );

  if (conflictResult.hasConflict) {
    const conflict = conflictResult.conflicts[0];
    logger.warn('[Invite Accept] Conflict detected when accepting invite', {
      extra: {
        bookingId: params.bookingId,
        userEmail,
        conflictingBookingId: conflict.bookingId,
        conflictType: conflict.conflictType,
        date: booking.request_date
      }
    });

    return fail(409, `Cannot accept invite: you have a scheduling conflict with another booking on ${booking.request_date}`, {
      errorType: 'booking_conflict',
      extra: {
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
    });
  }

  await db
    .update(bookingParticipants)
    .set({
      inviteStatus: 'accepted',
      respondedAt: new Date()
    })
    .where(eq(bookingParticipants.id, participant.id));

  logger.info('[Invite Accept] Member accepted invite', {
    extra: { bookingId: params.bookingId, userEmail, sessionId: booking.session_id }
  });

  const invitedMemberName = participant.displayName || userEmail;
  await notifyMember({
    userEmail: booking.user_email || booking.owner_email,
    title: 'Invite Accepted',
    message: `${invitedMemberName} accepted your invite to the booking on ${booking.request_date}`,
    type: 'booking_update',
    relatedId: params.bookingId,
    relatedType: 'booking',
    url: '/sims'
  });

  return ok({ success: true, message: 'Invite accepted successfully' });
}

export async function declineInvite(params: {
  bookingId: number;
  userEmail: string;
  onBehalfOf?: string;
  sessionUserRole?: string;
  sessionUserEmail?: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  let userEmail = params.userEmail;

  if (params.onBehalfOf && typeof params.onBehalfOf === 'string') {
    if (params.sessionUserRole !== 'admin') {
      return fail(403, 'Only admins can decline invites on behalf of others');
    }
    userEmail = params.onBehalfOf.toLowerCase();
    logger.info('[Invite Decline] Admin acting on behalf of member', {
      extra: { adminEmail: params.sessionUserEmail, targetEmail: userEmail, bookingId: params.bookingId }
    });
  }

  const booking = await getBookingWithSession(params.bookingId);
  if (!booking) return fail(404, 'Booking not found');

  if (!booking.session_id) {
    return fail(400, 'Booking has no session - cannot decline invite');
  }

  const participantResult = await db
    .select({
      id: bookingParticipants.id,
      sessionId: bookingParticipants.sessionId,
      userId: bookingParticipants.userId,
      inviteStatus: bookingParticipants.inviteStatus,
      displayName: bookingParticipants.displayName,
      participantType: bookingParticipants.participantType
    })
    .from(bookingParticipants)
    .innerJoin(users, eq(bookingParticipants.userId, users.id))
    .where(and(
      eq(bookingParticipants.sessionId, booking.session_id),
      sql`LOWER(${users.email}) = ${userEmail}`
    ))
    .limit(1);

  if (!participantResult[0]) {
    return fail(404, 'You are not a participant on this booking');
  }

  const participant = participantResult[0];

  const { bookingMembers } = await import('../../shared/schema');

  await db
    .delete(bookingMembers)
    .where(and(
      eq(bookingMembers.bookingId, params.bookingId),
      sql`LOWER(${bookingMembers.userEmail}) = ${userEmail}`
    ));

  await db
    .delete(bookingParticipants)
    .where(eq(bookingParticipants.id, participant.id));

  logger.info('[Invite Decline] Member declined invite', {
    extra: { bookingId: params.bookingId, userEmail, sessionId: booking.session_id, participantId: participant.id }
  });

  const declinedMemberName = participant.displayName || userEmail;
  await notifyMember({
    userEmail: booking.user_email || booking.owner_email,
    title: 'Invite Declined',
    message: `${declinedMemberName} declined your invite to the booking on ${booking.request_date}`,
    type: 'booking_update',
    relatedId: params.bookingId,
    relatedType: 'booking',
    url: '/sims'
  });

  return ok({ success: true, message: 'Invite declined successfully' });
}

export async function guestFeeCheckout(params: {
  bookingId: number;
  guestName: string;
  guestEmail: string;
  userEmail: string;
  sessionUserId?: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  const { bookingId, guestName, guestEmail, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) return fail(404, 'Booking not found');

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    return fail(403, 'Only the booking owner or staff can add guests');
  }

  let sessionId = booking.session_id;

  if (!sessionId) {
    logger.info('[roster] Creating session for guest fee checkout', {
      extra: { bookingId, ownerEmail: booking.owner_email }
    });

    await ensureSessionForBooking({
      bookingId,
      resourceId: booking.resource_id,
      sessionDate: booking.request_date,
      startTime: booking.start_time,
      endTime: booking.end_time,
      ownerEmail: booking.owner_email,
      source: 'staff_manual',
      createdBy: userEmail
    });

    const updatedBooking = await db.select({ session_id: bookingRequests.sessionId })
      .from(bookingRequests)
      .where(eq(bookingRequests.id, bookingId))
      .limit(1);
    sessionId = updatedBooking[0]?.session_id ?? null;

    if (!sessionId) {
      return fail(500, 'Failed to create billing session for this booking. Staff has been notified.');
    }
  }

  const existingParticipants = await getSessionParticipants(sessionId);
  const declaredCount = booking.declared_player_count || 1;
  const ownerInParticipants = existingParticipants.some(p => p.participantType === 'owner');
  const effectiveCount = ownerInParticipants ? existingParticipants.length : (1 + existingParticipants.length);

  if (effectiveCount >= declaredCount) {
    return fail(400, 'Cannot add more participants. Maximum slot limit reached.', {
      extra: { declaredPlayerCount: declaredCount, currentCount: effectiveCount }
    });
  }

  const ownerTier = booking.owner_tier || await getMemberTierByEmail(booking.owner_email);

  if (ownerTier) {
    const participantsForValidation: ParticipantForValidation[] = [
      ...existingParticipants.map(p => ({
        type: p.participantType as 'owner' | 'member' | 'guest',
        displayName: p.displayName
      })),
      { type: 'guest', displayName: guestName.trim() }
    ];

    const socialCheck = await enforceSocialTierRules(ownerTier, participantsForValidation);

    if (!socialCheck.allowed) {
      return fail(403, socialCheck.reason || 'Social tier members cannot bring guests', {
        errorType: 'social_tier_blocked'
      });
    }
  }

  const guestId = await createOrFindGuest(
    guestName.trim(),
    guestEmail.trim(),
    undefined,
    sessionUserId || userEmail
  );

  const participantInput: ParticipantInput = {
    guestId,
    participantType: 'guest',
    displayName: guestName.trim(),
  };

  const [newParticipant] = await linkParticipants(sessionId, [participantInput]);

  if (!newParticipant) {
    return fail(500, 'Failed to add guest participant');
  }

  const guestFeeCents = PRICING.GUEST_FEE_CENTS;

  await db.update(bookingParticipants)
    .set({
      paymentStatus: 'pending',
      cachedFeeCents: guestFeeCents
    })
    .where(eq(bookingParticipants.id, newParticipant.id));

  const ownerUserResult = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [booking.owner_email]
  );
  const ownerUserId = ownerUserResult.rows[0]?.id?.toString() || booking.owner_email;

  const customer = await getOrCreateStripeCustomer(
    ownerUserId,
    booking.owner_email,
    booking.owner_name || undefined
  );

  const paymentResult = await createBalanceAwarePayment({
    stripeCustomerId: customer.customerId,
    userId: ownerUserId,
    email: booking.owner_email,
    memberName: booking.owner_name || booking.owner_email.split('@')[0],
    amountCents: guestFeeCents,
    purpose: 'guest_fee',
    description: `Guest fee for ${guestName.trim()} - Booking #${bookingId}`,
    bookingId,
    sessionId,
    metadata: {
      participantId: newParticipant.id.toString(),
      guestName: guestName.trim(),
      guestEmail: guestEmail.trim(),
      ownerEmail: booking.owner_email
    }
  });

  if (paymentResult.error) {
    throw new Error(paymentResult.error);
  }

  if (paymentResult.paidInFull) {
    await db.update(bookingParticipants)
      .set({ paymentStatus: 'paid' })
      .where(eq(bookingParticipants.id, newParticipant.id));

    logger.info('[roster] Guest fee fully covered by account credit', {
      extra: {
        bookingId,
        sessionId,
        participantId: newParticipant.id,
        guestName: guestName.trim(),
        amount: guestFeeCents,
        balanceApplied: paymentResult.balanceApplied
      }
    });

    return ok({
      success: true,
      paidInFull: true,
      paymentRequired: false,
      amount: guestFeeCents,
      balanceApplied: paymentResult.balanceApplied,
      participantId: newParticipant.id
    });
  }

  logger.info('[roster] Guest fee checkout initiated', {
    extra: {
      bookingId,
      sessionId,
      participantId: newParticipant.id,
      guestName: guestName.trim(),
      amount: guestFeeCents,
      paymentIntentId: paymentResult.paymentIntentId,
      balanceApplied: paymentResult.balanceApplied
    }
  });

  return ok({
    success: true,
    paidInFull: false,
    clientSecret: paymentResult.clientSecret,
    paymentIntentId: paymentResult.paymentIntentId,
    amount: guestFeeCents,
    balanceApplied: paymentResult.balanceApplied,
    remainingCents: paymentResult.remainingCents,
    participantId: newParticipant.id
  });
}

export async function confirmGuestPayment(params: {
  bookingId: number;
  paymentIntentId: string;
  participantId: number;
  userEmail: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  const { bookingId, paymentIntentId, participantId, userEmail } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) return fail(404, 'Booking not found');

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    return fail(403, 'Only the booking owner or staff can confirm payment');
  }

  const participantCheck = await pool.query(
    `SELECT bp.id, bp.session_id FROM booking_participants bp WHERE bp.id = $1`,
    [participantId]
  );

  if (participantCheck.rows.length === 0) {
    return fail(404, 'Participant not found');
  }

  if (booking.session_id && participantCheck.rows[0].session_id !== booking.session_id) {
    return fail(403, 'Participant does not belong to this booking');
  }

  const stripe = await getStripeClient();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status !== 'succeeded') {
    return fail(400, 'Payment not yet confirmed', {
      extra: { status: paymentIntent.status }
    });
  }

  const piBookingId = paymentIntent.metadata?.bookingId;
  const piParticipantId = paymentIntent.metadata?.participantId;
  const piOwnerEmail = paymentIntent.metadata?.ownerEmail;

  if (piBookingId !== bookingId.toString() || piParticipantId !== participantId.toString()) {
    return fail(400, 'Payment intent does not match this booking/participant');
  }

  if (piOwnerEmail && piOwnerEmail.toLowerCase() !== booking.owner_email?.toLowerCase()) {
    return fail(403, 'Payment intent owner does not match booking owner');
  }

  await db.update(bookingParticipants)
    .set({
      paymentStatus: 'paid'
    })
    .where(eq(bookingParticipants.id, participantId));

  await pool.query(
    `INSERT INTO legacy_purchases 
      (user_id, member_email, item_name, item_category, item_price_cents, quantity, subtotal_cents, 
       discount_percent, discount_amount_cents, tax_cents, item_total_cents, 
       payment_method, sale_date, linked_booking_session_id, is_comp, is_synced, stripe_payment_intent_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())`,
    [
      null,
      booking?.owner_email?.toLowerCase(),
      `Guest Fee - ${paymentIntent.metadata?.guestName || 'Guest'}`,
      'guest_fee',
      paymentIntent.amount || PRICING.GUEST_FEE_CENTS,
      1,
      paymentIntent.amount || PRICING.GUEST_FEE_CENTS,
      0,
      0,
      0,
      paymentIntent.amount || PRICING.GUEST_FEE_CENTS,
      'stripe',
      new Date(),
      booking?.session_id,
      false,
      false,
      paymentIntentId
    ]
  );

  logger.info('[roster] Guest fee payment confirmed', {
    extra: {
      bookingId,
      participantId,
      paymentIntentId,
      guestName: paymentIntent.metadata?.guestName
    }
  });

  return ok({ success: true, message: 'Guest fee payment confirmed' });
}

export async function cancelGuestPayment(params: {
  bookingId: number;
  participantId: number;
  paymentIntentId?: string;
  userEmail: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  const { bookingId, participantId, paymentIntentId, userEmail } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) return fail(404, 'Booking not found');

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    return fail(403, 'Only the booking owner or staff can cancel guest payment');
  }

  const participantResult = await pool.query(
    `SELECT bp.id, bp.session_id, bp.payment_status, bp.guest_id, bp.display_name
     FROM booking_participants bp WHERE bp.id = $1`,
    [participantId]
  );

  if (participantResult.rows.length === 0) {
    return fail(404, 'Participant not found');
  }

  const participant = participantResult.rows[0];

  if (booking.session_id && participant.session_id !== booking.session_id) {
    return fail(403, 'Participant does not belong to this booking');
  }

  if (participant.payment_status === 'paid') {
    return fail(400, 'Cannot cancel a paid participant');
  }

  await db.delete(bookingParticipants)
    .where(eq(bookingParticipants.id, participantId));

  if (paymentIntentId) {
    try {
      const stripe = await getStripeClient();
      await stripe.paymentIntents.cancel(paymentIntentId);
    } catch (stripeErr: unknown) {
      logger.warn('[roster] Failed to cancel Stripe payment intent', {
        extra: { paymentIntentId, error: getErrorMessage(stripeErr) }
      });
    }
  }

  logger.info('[roster] Guest fee payment cancelled, participant removed', {
    extra: {
      bookingId,
      participantId,
      guestName: participant.display_name
    }
  });

  return ok({ success: true, message: 'Guest payment cancelled' });
}

export async function updatePlayerCount(params: {
  bookingId: number;
  playerCount: number;
  staffEmail: string;
}): Promise<RosterResult<Record<string, unknown>>> {
  const { bookingId, playerCount, staffEmail } = params;

  const bookingResult = await pool.query(`
    SELECT br.id, br.declared_player_count, br.session_id, br.user_email, br.status
    FROM booking_requests br
    WHERE br.id = $1
  `, [bookingId]);

  if (bookingResult.rows.length === 0) {
    return fail(404, 'Booking not found');
  }

  const booking = bookingResult.rows[0];
  const previousCount = booking.declared_player_count || 1;

  await pool.query(`
    UPDATE booking_requests 
    SET declared_player_count = $1
    WHERE id = $2
  `, [playerCount, bookingId]);

  if (playerCount > previousCount) {
    const slotResult = await pool.query(
      `SELECT COALESCE(MAX(slot_number), 0) as max_slot, COUNT(*) as count FROM booking_members WHERE booking_id = $1`,
      [bookingId]
    );
    const maxSlot = parseInt(slotResult.rows[0].max_slot) || 0;
    const currentMemberCount = parseInt(slotResult.rows[0].count) || 0;
    const slotsToCreate = playerCount - currentMemberCount;

    if (slotsToCreate > 0) {
      await pool.query(`
        INSERT INTO booking_members (booking_id, slot_number, user_email, is_primary, created_at)
        SELECT $1, slot_num, NULL, false, NOW()
        FROM generate_series($2, $3) AS slot_num
        ON CONFLICT (booking_id, slot_number) DO NOTHING
      `, [bookingId, maxSlot + 1, maxSlot + slotsToCreate]);
      logger.info('[roster] Created empty booking member slots', {
        extra: { bookingId, slotsCreated: slotsToCreate, previousCount, newCount: playerCount }
      });
    }
  } else if (playerCount < previousCount) {
    const deleted = await pool.query(`
      DELETE FROM booking_members 
      WHERE booking_id = $1 
        AND slot_number > $2 
        AND is_primary = false 
        AND (user_email IS NULL OR user_email = '')
    `, [bookingId, playerCount]);
    if (deleted.rowCount && deleted.rowCount > 0) {
      logger.info('[roster] Cleaned up empty slots after player count decrease', {
        extra: { bookingId, slotsRemoved: deleted.rowCount, previousCount, newCount: playerCount }
      });
    }
  }

  if (booking.session_id) {
    await recalculateSessionFees(booking.session_id, 'staff_action');
  }

  logger.info('[roster] Player count updated', {
    extra: { bookingId, previousCount, newCount: playerCount, staffEmail }
  });

  return ok({
    success: true,
    previousCount,
    newCount: playerCount,
    feesRecalculated: !!booking.session_id,
    memberEmail: booking.user_email
  });
}
