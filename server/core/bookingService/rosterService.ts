import { db } from '../../db';
import { pool } from '../db';
import { bookingParticipants, bookingRequests } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../logger';
import {
  createOrFindGuest,
  linkParticipants,
  getSessionParticipants,
  ensureSessionForBooking,
  type ParticipantInput,
} from './sessionManager';
import {
  getGuestPassesRemaining,
  getRemainingMinutes,
} from './tierRules';
import {
  enforceSocialTierRules,
  type ParticipantForValidation,
} from './tierRules';
import {
  computeUsageAllocation,
  calculateOverageFee,
} from './usageCalculator';
import { getTierLimits, getMemberTierByEmail } from '../tierService';
import {
  computeFeeBreakdown,
  getEffectivePlayerCount,
  invalidateCachedFees,
  recalculateSessionFees,
} from '../billing/unifiedFeeService';
import { PRICING } from '../billing/pricingConfig';
import { createPrepaymentIntent } from '../billing/prepaymentService';
import { findConflictingBookings } from './conflictDetection';
import { notifyMember } from '../notificationService';
import { getStripeClient } from '../stripe/client';
import { getOrCreateStripeCustomer } from '../stripe/customers';
import { createBalanceAwarePayment } from '../stripe/payments';
import { useGuestPass, refundGuestPass, ensureGuestPassRecord } from '../../routes/guestPasses';
import { getErrorMessage } from '../../utils/errorUtils';
import type { FeeBreakdown } from '../../../shared/models/billing';
import type { BookingParticipant } from '../../../shared/models/scheduling';

export interface BookingWithSession {
  booking_id: number;
  owner_email: string;
  owner_name: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  declared_player_count: number | null;
  status: string;
  session_id: number | null;
  resource_id: number | null;
  notes: string | null;
  staff_notes: string | null;
  roster_version: number | null;
  resource_name: string | null;
  owner_tier: string | null;
}

export interface ParticipantRow {
  id: number;
  sessionId: number;
  userId: string | null;
  guestId: number | null;
  participantType: string;
  displayName: string;
  slotDuration: number | null;
  paymentStatus: string | null;
  createdAt: Date | null;
}

export interface BookingParticipantsResult {
  booking: {
    id: number;
    ownerEmail: string;
    ownerName: string | null;
    requestDate: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    resourceId: number | null;
    resourceName: string | null;
    status: string;
    sessionId: number | null;
    notes: string | null;
    staffNotes: string | null;
  };
  declaredPlayerCount: number;
  currentParticipantCount: number;
  remainingSlots: number;
  participants: ParticipantRow[];
  ownerTier: string | null;
  guestPassesRemaining: number;
  guestPassesUsed: number;
  remainingMinutes: number;
  rosterVersion: number;
}

interface ProvisionalParticipant {
  type: string;
  name: string;
  email?: string;
}

interface FeeParticipantInput {
  userId?: string;
  email?: string;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
}

interface AllocationItem {
  displayName: string;
  type: string;
  minutes: number;
  feeCents?: number;
}

interface PreviewFeesBookingInfo {
  id: number;
  durationMinutes: number;
  startTime: string;
  endTime: string;
}

interface PreviewFeesParticipantCounts {
  total: number;
  members: number;
  guests: number;
  owner: number;
}

interface PreviewFeesTimeAllocation {
  totalMinutes: number;
  declaredPlayerCount: number;
  actualParticipantCount: number;
  effectivePlayerCount: number;
  totalSlots: number;
  minutesPerParticipant: number;
  allocations: AllocationItem[];
}

interface PreviewFeesOwnerFees {
  tier: string | null;
  dailyAllowance: number;
  remainingMinutesToday: number;
  ownerMinutesUsed: number;
  guestMinutesCharged: number;
  totalMinutesResponsible: number;
  minutesWithinAllowance: number;
  overageMinutes: number;
  estimatedOverageFee: number;
  estimatedGuestFees?: number;
  estimatedTotalFees?: number;
}

interface PreviewFeesGuestPasses {
  monthlyAllowance: number;
  remaining: number;
  usedThisBooking: number;
  afterBooking: number;
}

export interface PreviewFeesResult {
  booking: PreviewFeesBookingInfo;
  participants: PreviewFeesParticipantCounts;
  timeAllocation: PreviewFeesTimeAllocation;
  ownerFees: PreviewFeesOwnerFees;
  guestPasses: PreviewFeesGuestPasses;
  unifiedBreakdown?: FeeBreakdown;
}

export interface SessionUser {
  id?: string;
  email: string;
}

export async function isStaffOrAdminCheck(email: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../../replit_integrations/auth/replitAuth');
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
    return (result as { rows: { id: string }[] }).rows.length > 0;
  } catch (error: unknown) {
    logger.error('[isStaffOrAdminCheck] DB error, defaulting to false', { extra: { error: (error as Error).message } });
    return false;
  }
}

export async function getBookingWithSession(bookingId: number): Promise<BookingWithSession | null> {
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
  return (result.rows[0] as BookingWithSession) || null;
}

export async function getBookingParticipants(
  bookingId: number,
  sessionUser: SessionUser
): Promise<BookingParticipantsResult> {
  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
  }

  const userEmail = sessionUser.email?.toLowerCase() || '';
  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    const participantCheck = await pool.query(
      `SELECT 1 FROM booking_participants bp
       JOIN booking_sessions bs ON bp.session_id = bs.id
       JOIN booking_requests br ON br.session_id = bs.id
       WHERE br.id = $1 AND bp.user_id = $2
       LIMIT 1`,
      [bookingId, sessionUser.id || userEmail]
    );
    if (participantCheck.rows.length === 0) {
      throw Object.assign(new Error('Access denied'), { statusCode: 403 });
    }
  }

  let participants: ParticipantRow[] = [];
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
        createdAt: bookingParticipants.createdAt,
      })
      .from(bookingParticipants)
      .where(eq(bookingParticipants.sessionId, booking.session_id));

    participants = participantRows;

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.displayName && p.displayName.includes('@')) {
        if (p.participantType === 'owner') {
          let ownerName = booking.owner_name;
          if (!ownerName && booking.owner_email) {
            const ownerLookup = await pool.query(
              `SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
              [booking.owner_email]
            );
            if (ownerLookup.rows.length > 0) {
              ownerName = [ownerLookup.rows[0].first_name, ownerLookup.rows[0].last_name].filter(Boolean).join(' ') || null;
            }
          }
          if (ownerName) {
            participants[i] = { ...p, displayName: ownerName };
            await pool.query(
              `UPDATE booking_participants SET display_name = $1 WHERE id = $2`,
              [ownerName, p.id]
            );
          }
        } else if (p.participantType === 'member' && p.userId) {
          const userResult = await pool.query(
            `SELECT first_name, last_name FROM users WHERE id = $1 LIMIT 1`,
            [p.userId]
          );
          if (userResult.rows.length > 0) {
            const { first_name, last_name } = userResult.rows[0];
            const fullName = [first_name, last_name].filter(Boolean).join(' ');
            if (fullName) {
              participants[i] = { ...p, displayName: fullName };
              await pool.query(
                `UPDATE booking_participants SET display_name = $1 WHERE id = $2`,
                [participants[i].displayName, p.id]
              );
            }
          }
        }
      }
    }
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

  return {
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
  };
}

export async function previewRosterFees(
  bookingId: number,
  provisionalParticipants: ProvisionalParticipant[],
  sessionUser: SessionUser
): Promise<PreviewFeesResult> {
  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
  }

  const userEmail = sessionUser.email?.toLowerCase() || '';
  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }

  let existingParticipants: BookingParticipant[] = [];
  if (booking.session_id) {
    existingParticipants = await getSessionParticipants(booking.session_id);
  }

  const allParticipants: Array<{ participantType: string; displayName: string; email?: string; userId?: string | null }> = [];
  for (const p of existingParticipants) {
    let resolvedName = p.displayName;
    if (resolvedName && resolvedName.includes('@')) {
      if (p.participantType === 'owner') {
        if (booking.owner_name) {
          resolvedName = booking.owner_name;
        } else if (booking.owner_email) {
          const ownerLookup = await pool.query(
            `SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
            [booking.owner_email]
          );
          if (ownerLookup.rows.length > 0) {
            const fullName = [ownerLookup.rows[0].first_name, ownerLookup.rows[0].last_name].filter(Boolean).join(' ');
            if (fullName) resolvedName = fullName;
          }
        }
      } else if (p.userId) {
        const userResult = await pool.query(
          `SELECT first_name, last_name FROM users WHERE id = $1 LIMIT 1`,
          [p.userId]
        );
        if (userResult.rows.length > 0) {
          const fullName = [userResult.rows[0].first_name, userResult.rows[0].last_name].filter(Boolean).join(' ');
          if (fullName) resolvedName = fullName;
        }
      }
    }
    allParticipants.push({
      participantType: p.participantType,
      displayName: resolvedName,
      email: undefined as string | undefined,
      userId: p.userId
    });
  }
  for (const prov of provisionalParticipants) {
    if (prov && prov.type && prov.name) {
      allParticipants.push({
        participantType: prov.type,
        displayName: prov.name,
        email: prov.email,
        userId: undefined
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
  const participantsForFeeCalc: FeeParticipantInput[] = [];

  if (!ownerInParticipants) {
    participantsForFeeCalc.push({
      email: booking.owner_email,
      displayName: booking.owner_name || booking.owner_email,
      participantType: 'owner'
    });
  }

  for (const p of allParticipants) {
    participantsForFeeCalc.push({
      userId: p.userId ?? undefined,
      email: p.email,
      displayName: p.displayName,
      participantType: p.participantType as 'owner' | 'member' | 'guest'
    });
  }

  const guestCount = allParticipants.filter(p => p.participantType === 'guest').length;
  const memberCount = allParticipants.filter(p => p.participantType === 'member').length;
  const minutesPerPlayer = Math.floor(durationMinutes / totalSlots);

  let breakdown: FeeBreakdown | undefined;
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
    logger.warn('[rosterService] Failed to compute unified fee breakdown, using fallback', {
      error: feeError as Error,
      extra: { bookingId, sessionId: booking.session_id }
    });
  }

  if (!breakdown) {
    return buildFallbackPreview({
      booking,
      durationMinutes,
      declaredPlayerCount,
      totalSlots,
      minutesPerPlayer,
      actualParticipantCount,
      effectivePlayerCount,
      dailyAllowance,
      remainingMinutesToday,
      guestPassesPerMonth,
      ownerTier,
      allParticipants,
      participantsForFeeCalc,
      guestCount,
      memberCount,
    });
  }

  const ownerLineItem = breakdown.participants.find(p => p.participantType === 'owner');
  const ownerMinutes = ownerLineItem?.minutesAllocated || breakdown.metadata.sessionDuration;
  const guestMinutes = breakdown.participants
    .filter(p => p.participantType === 'guest')
    .reduce((sum, p) => sum + p.minutesAllocated, 0);
  const totalOwnerResponsibleMinutes = ownerMinutes + guestMinutes;

  const overageFee = Math.round(breakdown.totals.overageCents / 100);
  const overageMinutes = overageFee > 0 ? Math.ceil(overageFee / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES : 0;
  const minutesWithinAllowance = Math.max(0, totalOwnerResponsibleMinutes - overageMinutes);

  return {
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
  };
}

interface FallbackPreviewParams {
  booking: BookingWithSession;
  durationMinutes: number;
  declaredPlayerCount: number;
  totalSlots: number;
  minutesPerPlayer: number;
  actualParticipantCount: number;
  effectivePlayerCount: number;
  dailyAllowance: number;
  remainingMinutesToday: number;
  guestPassesPerMonth: number;
  ownerTier: string | null;
  allParticipants: Array<{ participantType: string; displayName: string }>;
  participantsForFeeCalc: FeeParticipantInput[];
  guestCount: number;
  memberCount: number;
}

async function buildFallbackPreview(params: FallbackPreviewParams): Promise<PreviewFeesResult> {
  const {
    booking, durationMinutes, declaredPlayerCount, totalSlots, minutesPerPlayer,
    actualParticipantCount, effectivePlayerCount, dailyAllowance,
    remainingMinutesToday, guestPassesPerMonth, ownerTier, allParticipants,
    participantsForFeeCalc, guestCount, memberCount,
  } = params;

  const allocations = computeUsageAllocation(durationMinutes, participantsForFeeCalc.map(p => ({
    participantType: p.participantType,
    displayName: p.displayName
  })), {
    declaredSlots: totalSlots,
    assignRemainderToOwner: true
  });

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

  return {
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
  };
}

// ─── Mutation Interfaces ───────────────────────────────────────

export interface AddParticipantParams {
  bookingId: number;
  type: 'member' | 'guest';
  userId?: string;
  guest?: { name: string; email: string };
  rosterVersion?: number;
  userEmail: string;
  sessionUserId?: string;
  deferFeeRecalc?: boolean;
}

export interface AddParticipantResult {
  participant: BookingParticipant;
  message: string;
  guestPassesRemaining?: number;
  newRosterVersion: number;
}

export interface RemoveParticipantParams {
  bookingId: number;
  participantId: number;
  rosterVersion?: number;
  userEmail: string;
  sessionUserId?: string;
  deferFeeRecalc?: boolean;
}

export interface RemoveParticipantResult {
  message: string;
  guestPassesRemaining?: number;
  newRosterVersion: number;
}

export interface GuestFeeCheckoutParams {
  bookingId: number;
  guestName: string;
  guestEmail: string;
  userEmail: string;
  sessionUserId?: string;
}

export interface GuestFeeCheckoutResult {
  paidInFull: boolean;
  paymentRequired?: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  amount: number;
  balanceApplied?: number;
  remainingCents?: number;
  participantId: number;
}

export interface ConfirmGuestPaymentParams {
  bookingId: number;
  paymentIntentId: string;
  participantId: number;
  userEmail: string;
}

export interface ConfirmGuestPaymentResult {
  message: string;
}

export interface CancelGuestPaymentParams {
  bookingId: number;
  participantId: number;
  paymentIntentId?: string;
  userEmail: string;
}

export interface CancelGuestPaymentResult {
  message: string;
}

export interface UpdatePlayerCountParams {
  bookingId: number;
  playerCount: number;
  staffEmail: string;
  deferFeeRecalc?: boolean;
}

export interface UpdatePlayerCountResult {
  previousCount: number;
  newCount: number;
  feesRecalculated: boolean;
}

function createServiceError(message: string, statusCode: number, extra?: Record<string, unknown>): Error & { statusCode: number; extra?: Record<string, unknown> } {
  const err = new Error(message) as Error & { statusCode: number; extra?: Record<string, unknown> };
  err.statusCode = statusCode;
  if (extra) err.extra = extra;
  return err;
}

// ─── addParticipant ────────────────────────────────────────────

export async function addParticipant(params: AddParticipantParams): Promise<AddParticipantResult> {
  const { bookingId, type, userId, guest, rosterVersion, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);
  if (!isOwner && !isStaff) {
    throw createServiceError('Only the booking owner or staff can add participants', 403);
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
      throw createServiceError('Booking not found', 404);
    }

    const currentVersion = lockedBooking.rows[0].roster_version ?? 0;

    if (rosterVersion !== undefined && currentVersion !== rosterVersion) {
      await client.query('ROLLBACK');
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
      }, client);

      sessionId = sessionResult.sessionId || null;

      if (!sessionId || sessionResult.error) {
        await client.query('ROLLBACK');
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
      await client.query('ROLLBACK');
      throw createServiceError('Cannot add more participants. Maximum slot limit reached.', 400, {
        declaredPlayerCount: declaredCount,
        currentCount: effectiveCount
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
        throw createServiceError('Member not found', 404);
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
        throw createServiceError('This member is already a participant', 400);
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

        await client.query('ROLLBACK');
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
    } else {
      await ensureGuestPassRecord(booking.owner_email, ownerTier || undefined);

      const guestPassResult = await useGuestPass(booking.owner_email, guest!.name, true);
      if (!guestPassResult.success) {
        await client.query('ROLLBACK');
        throw createServiceError(
          guestPassResult.error || 'No guest passes remaining',
          400,
          { errorType: 'no_guest_passes' }
        );
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

      logger.info('[rosterService] Guest pass decremented', {
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

    if (type === 'guest' && guest) {
      const guestSlotResult = await client.query(
        `SELECT COALESCE(MAX(slot_number), 0) + 1 as next_slot FROM booking_guests WHERE booking_id = $1`,
        [bookingId]
      );
      const nextGuestSlot = guestSlotResult.rows[0]?.next_slot || 1;

      await client.query(
        `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT DO NOTHING`,
        [bookingId, guest.name.trim(), guest.email?.trim() || null, nextGuestSlot]
      );

      logger.info('[rosterService] Guest synced to booking_guests for staff view', {
        extra: { bookingId, guestName: guest.name, slotNumber: nextGuestSlot }
      });
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

      logger.info('[rosterService] Member linked to booking_members', {
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

        logger.info('[rosterService] Notification sent', {
          extra: { bookingId, addedMember: memberInfo.email }
        });
      } catch (notifError: unknown) {
        logger.warn('[rosterService] Failed to send notification (non-blocking)', {
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
          logger.info('[rosterService] Removing matching guest after successful member add', {
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

          if (guestToRemove.display_name) {
            await client.query(
              `DELETE FROM booking_guests WHERE booking_id = $1 AND LOWER(guest_name) = LOWER($2)`,
              [bookingId, guestToRemove.display_name]
            );
          }

          if (guestToRemove.used_guest_pass === true) {
            const refundResult = await refundGuestPass(
              booking.owner_email,
              guestToRemove.display_name || undefined,
              true
            );

            if (refundResult.success) {
              logger.info('[rosterService] Guest pass refunded when replacing guest with member', {
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

    if (!params.deferFeeRecalc) {
      try {
        const allParticipants = await getSessionParticipants(sessionId);
        const participantIds = allParticipants.map(p => p.id);

        await invalidateCachedFees(participantIds, 'participant_added');

        const recalcResult = await recalculateSessionFees(sessionId, 'roster_update');
        logger.info('[rosterService] Session fees recalculated after adding participant', {
          extra: {
            sessionId,
            bookingId,
            participantsUpdated: recalcResult.participantsUpdated,
            totalFees: recalcResult.billingResult.totalFees,
            ledgerUpdated: recalcResult.ledgerUpdated
          }
        });

        if (Number(recalcResult.billingResult.totalFees) > 0) {
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
          extra: { sessionId, bookingId }
        });
      }
    }

    await client.query(
      `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`,
      [bookingId]
    );

    newRosterVersion = (lockedBooking.rows[0].roster_version ?? 0) + 1;

    await client.query('COMMIT');

    return {
      participant: newParticipant,
      message: `${type === 'member' ? 'Member' : 'Guest'} added successfully`,
      ...(type === 'guest' && { guestPassesRemaining }),
      newRosterVersion
    };
  } catch (txError: unknown) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw txError;
  } finally {
    client.release();
  }
}

// ─── removeParticipant ─────────────────────────────────────────

export async function removeParticipant(params: RemoveParticipantParams): Promise<RemoveParticipantResult> {
  const { bookingId, participantId, rosterVersion, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

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
    const userResult = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [userEmail]
    );
    if (userResult.rows.length > 0 && userResult.rows[0].id === participant.userId) {
      isSelf = true;
    }
  }

  if (!isOwner && !isStaff && !isSelf) {
    throw createServiceError('Only the booking owner, staff, or the participant themselves can remove this participant', 403);
  }

  if (participant.participantType === 'owner') {
    throw createServiceError('Cannot remove the booking owner', 400);
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
      throw createServiceError('Booking not found', 404);
    }

    const currentVersion = lockedBooking.rows[0].roster_version ?? 0;

    if (rosterVersion !== undefined && currentVersion !== rosterVersion) {
      await client.query('ROLLBACK');
      throw createServiceError('Roster was modified by another user', 409, {
        code: 'ROSTER_CONFLICT',
        currentVersion
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
        logger.info('[rosterService] Guest pass refunded on participant removal', {
          extra: {
            bookingId,
            ownerEmail: booking.owner_email,
            guestName: participant.displayName,
            remainingPasses: refundResult.remaining
          }
        });
      } else {
        logger.warn('[rosterService] Failed to refund guest pass (non-blocking)', {
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

    if (participant.participantType === 'guest') {
      const guestName = participant.displayName;
      if (guestName) {
        await client.query(
          `DELETE FROM booking_guests WHERE booking_id = $1 AND LOWER(guest_name) = LOWER($2)`,
          [bookingId, guestName]
        );
        logger.info('[rosterService] Guest removed from booking_guests for staff view', {
          extra: { bookingId, guestName }
        });
      }
    }

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

        logger.info('[rosterService] Member removed from booking_members', {
          extra: { bookingId, memberEmail }
        });
      }
    }

    logger.info('[rosterService] Participant removed', {
      extra: {
        bookingId,
        sessionId: booking.session_id,
        participantId,
        participantType: participant.participantType,
        removedBy: userEmail
      }
    });

    if (!params.deferFeeRecalc) {
      try {
        const remainingParticipants = await getSessionParticipants(booking.session_id!);
        const participantIds = remainingParticipants.map(p => p.id);

        await invalidateCachedFees(participantIds, 'participant_removed');

        const recalcResult = await recalculateSessionFees(booking.session_id!, 'roster_update');
        logger.info('[rosterService] Session fees recalculated after removing participant', {
          extra: {
            sessionId: booking.session_id,
            bookingId,
            participantsUpdated: recalcResult.participantsUpdated,
            totalFees: recalcResult.billingResult.totalFees,
            ledgerUpdated: recalcResult.ledgerUpdated
          }
        });
      } catch (recalcError: unknown) {
        logger.warn('[rosterService] Failed to recalculate session fees (non-blocking)', {
          error: recalcError as Error,
          extra: { sessionId: booking.session_id, bookingId }
        });
      }
    }

    await client.query(
      `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`,
      [bookingId]
    );

    newRosterVersion = (lockedBooking.rows[0].roster_version ?? 0) + 1;

    await client.query('COMMIT');

    return {
      message: 'Participant removed successfully',
      ...(participant.participantType === 'guest' && guestPassesRemaining !== undefined && { guestPassesRemaining }),
      newRosterVersion
    };
  } catch (txError: unknown) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw txError;
  } finally {
    client.release();
  }
}

// ─── initiateGuestFeeCheckout ──────────────────────────────────

export async function initiateGuestFeeCheckout(params: GuestFeeCheckoutParams): Promise<GuestFeeCheckoutResult> {
  const { bookingId, guestName, guestEmail, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    throw createServiceError('Only the booking owner or staff can add guests', 403);
  }

  let sessionId = booking.session_id;

  if (!sessionId) {
    logger.info('[rosterService] Creating session for guest fee checkout', {
      extra: { bookingId, ownerEmail: booking.owner_email }
    });

    await ensureSessionForBooking({
      bookingId,
      resourceId: booking.resource_id!,
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
      throw createServiceError('Failed to create billing session for this booking. Staff has been notified.', 500);
    }
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
      throw createServiceError(
        socialCheck.reason || 'Social tier members cannot bring guests',
        403,
        { errorType: 'social_tier_blocked' }
      );
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
    throw createServiceError('Failed to add guest participant', 500);
  }

  try {
    const guestSlotResult = await pool.query(
      `SELECT COALESCE(MAX(slot_number), 0) + 1 as next_slot FROM booking_guests WHERE booking_id = $1`,
      [bookingId]
    );
    const nextGuestSlot = guestSlotResult.rows[0]?.next_slot || 1;

    await pool.query(
      `INSERT INTO booking_guests (booking_id, guest_name, guest_email, slot_number, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT DO NOTHING`,
      [bookingId, guestName.trim(), guestEmail.trim(), nextGuestSlot]
    );

    logger.info('[rosterService] Guest synced to booking_guests for staff view (fee checkout)', {
      extra: { bookingId, guestName: guestName.trim(), slotNumber: nextGuestSlot }
    });
  } catch (syncError) {
    logger.warn('[rosterService] Failed to sync guest to booking_guests (non-blocking)', {
      error: syncError as Error,
      extra: { bookingId, guestName }
    });
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

    logger.info('[rosterService] Guest fee fully covered by account credit', {
      extra: {
        bookingId,
        sessionId,
        participantId: newParticipant.id,
        guestName: guestName.trim(),
        amount: guestFeeCents,
        balanceApplied: paymentResult.balanceApplied
      }
    });

    return {
      paidInFull: true,
      paymentRequired: false,
      amount: guestFeeCents,
      balanceApplied: paymentResult.balanceApplied,
      participantId: newParticipant.id
    };
  }

  logger.info('[rosterService] Guest fee checkout initiated', {
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

  return {
    paidInFull: false,
    clientSecret: paymentResult.clientSecret,
    paymentIntentId: paymentResult.paymentIntentId,
    amount: guestFeeCents,
    balanceApplied: paymentResult.balanceApplied,
    remainingCents: paymentResult.remainingCents,
    participantId: newParticipant.id
  };
}

// ─── confirmGuestPayment ───────────────────────────────────────

export async function confirmGuestPayment(params: ConfirmGuestPaymentParams): Promise<ConfirmGuestPaymentResult> {
  const { bookingId, paymentIntentId, participantId, userEmail } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    throw createServiceError('Only the booking owner or staff can confirm payment', 403);
  }

  const participantCheck = await pool.query(
    `SELECT bp.id, bp.session_id FROM booking_participants bp WHERE bp.id = $1`,
    [participantId]
  );

  if (participantCheck.rows.length === 0) {
    throw createServiceError('Participant not found', 404);
  }

  if (booking.session_id && participantCheck.rows[0].session_id !== booking.session_id) {
    throw createServiceError('Participant does not belong to this booking', 403);
  }

  const stripe = await getStripeClient();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status !== 'succeeded') {
    throw createServiceError('Payment not yet confirmed', 400, {
      status: paymentIntent.status
    });
  }

  const piBookingId = paymentIntent.metadata?.bookingId;
  const piParticipantId = paymentIntent.metadata?.participantId;
  const piOwnerEmail = paymentIntent.metadata?.ownerEmail;

  if (piBookingId !== bookingId.toString() || piParticipantId !== participantId.toString()) {
    throw createServiceError('Payment intent does not match this booking/participant', 400);
  }

  if (piOwnerEmail && piOwnerEmail.toLowerCase() !== booking.owner_email?.toLowerCase()) {
    throw createServiceError('Payment intent owner does not match booking owner', 403);
  }

  await db.update(bookingParticipants)
    .set({ paymentStatus: 'paid' })
    .where(eq(bookingParticipants.id, participantId));

  await pool.query(
    `INSERT INTO legacy_purchases 
      (user_id, member_email, item_name, item_category, item_price_cents, quantity, subtotal_cents, 
       discount_percent, discount_amount_cents, tax_cents, item_total_cents, 
       payment_method, sale_date, linked_booking_session_id, is_comp, is_synced, stripe_payment_intent_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())`,
    [
      null,
      booking.owner_email?.toLowerCase(),
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
      booking.session_id,
      false,
      false,
      paymentIntentId
    ]
  );

  logger.info('[rosterService] Guest fee payment confirmed', {
    extra: {
      bookingId,
      participantId,
      paymentIntentId,
      guestName: paymentIntent.metadata?.guestName
    }
  });

  return { message: 'Guest fee payment confirmed' };
}

// ─── cancelGuestPayment ────────────────────────────────────────

export async function cancelGuestPayment(params: CancelGuestPaymentParams): Promise<CancelGuestPaymentResult> {
  const { bookingId, participantId, paymentIntentId, userEmail } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);

  if (!isOwner && !isStaff) {
    throw createServiceError('Only the booking owner or staff can cancel guest payment', 403);
  }

  const participantResult = await pool.query(
    `SELECT bp.id, bp.session_id, bp.payment_status, bp.guest_id, bp.display_name
     FROM booking_participants bp WHERE bp.id = $1`,
    [participantId]
  );

  if (participantResult.rows.length === 0) {
    throw createServiceError('Participant not found', 404);
  }

  const participant = participantResult.rows[0];

  if (booking.session_id && participant.session_id !== booking.session_id) {
    throw createServiceError('Participant does not belong to this booking', 403);
  }

  if (participant.payment_status === 'paid') {
    throw createServiceError('Cannot cancel a paid participant', 400);
  }

  await db.delete(bookingParticipants)
    .where(eq(bookingParticipants.id, participantId));

  if (paymentIntentId) {
    try {
      const stripe = await getStripeClient();
      await stripe.paymentIntents.cancel(paymentIntentId);
    } catch (stripeErr: unknown) {
      logger.warn('[rosterService] Failed to cancel Stripe payment intent', {
        extra: { paymentIntentId, error: getErrorMessage(stripeErr) }
      });
    }
  }

  logger.info('[rosterService] Guest fee payment cancelled, participant removed', {
    extra: {
      bookingId,
      participantId,
      guestName: participant.display_name
    }
  });

  return { message: 'Guest payment cancelled' };
}

// ─── updateDeclaredPlayerCount ─────────────────────────────────

export async function updateDeclaredPlayerCount(params: UpdatePlayerCountParams): Promise<UpdatePlayerCountResult> {
  const { bookingId, playerCount, staffEmail } = params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: SELECT booking info (inside transaction for consistency)
    const bookingResult = await client.query(`
      SELECT br.id, br.declared_player_count, br.session_id, br.user_email, br.status
      FROM booking_requests br
      WHERE br.id = $1
    `, [bookingId]);

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw createServiceError('Booking not found', 404);
    }

    const booking = bookingResult.rows[0];
    const previousCount = booking.declared_player_count || 1;

    // Step 2: UPDATE declared_player_count
    await client.query(`
      UPDATE booking_requests 
      SET declared_player_count = $1
      WHERE id = $2
    `, [playerCount, bookingId]);

    // Step 3 & 4: Only modify booking_members for legacy bookings without sessions
    if (!booking.session_id) {
      // Step 3: INSERT new booking_member slots (if increasing count)
      if (playerCount > previousCount) {
        const slotResult = await client.query(
          `SELECT COALESCE(MAX(slot_number), 0) as max_slot, COUNT(*) as count FROM booking_members WHERE booking_id = $1`,
          [bookingId]
        );
        const maxSlot = parseInt(slotResult.rows[0].max_slot) || 0;
        const currentMemberCount = parseInt(slotResult.rows[0].count) || 0;
        const slotsToCreate = playerCount - currentMemberCount;

        if (slotsToCreate > 0) {
          await client.query(`
            INSERT INTO booking_members (booking_id, slot_number, user_email, is_primary, created_at)
            SELECT $1, slot_num, NULL, false, NOW()
            FROM generate_series($2, $3) AS slot_num
            ON CONFLICT (booking_id, slot_number) DO NOTHING
          `, [bookingId, maxSlot + 1, maxSlot + slotsToCreate]);
          logger.info('[rosterService] Created empty booking member slots', {
            extra: { bookingId, slotsCreated: slotsToCreate, previousCount, newCount: playerCount }
          });
        }
      } else if (playerCount < previousCount) {
        // Step 4: DELETE empty slots (if decreasing count)
        const deleted = await client.query(`
          DELETE FROM booking_members 
          WHERE booking_id = $1 
            AND slot_number > $2 
            AND is_primary = false 
            AND (user_email IS NULL OR user_email = '')
        `, [bookingId, playerCount]);
        if (deleted.rowCount && deleted.rowCount > 0) {
          logger.info('[rosterService] Cleaned up empty slots after player count decrease', {
            extra: { bookingId, slotsRemoved: deleted.rowCount, previousCount, newCount: playerCount }
          });
        }
      }
    } else {
      // Skip legacy booking_members sync for session-based booking
      logger.info('[rosterService] Skipping legacy booking_members sync for session-based booking', {
        extra: { bookingId, sessionId: booking.session_id, playerCount }
      });
    }

    // Commit the transaction
    await client.query('COMMIT');

    // Step 5 (OUTSIDE transaction): Recalculate fees - non-critical, fire-and-forget
    if (!params.deferFeeRecalc) {
      if (booking.session_id) {
        try {
          await recalculateSessionFees(booking.session_id, 'roster_update');
        } catch (feeError: unknown) {
          logger.error('[rosterService] Failed to recalculate session fees after player count update', {
            error: feeError as Error,
            extra: { bookingId, sessionId: booking.session_id }
          });
          // Don't throw - this is non-critical
        }
      }
    }

    logger.info('[rosterService] Player count updated', {
      extra: { bookingId, previousCount, newCount: playerCount, staffEmail }
    });

    return {
      previousCount,
      newCount: playerCount,
      feesRecalculated: !!booking.session_id
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[rosterService] Transaction failed while updating player count', {
      error: error as Error,
      extra: { bookingId, playerCount, errorMessage }
    });
    throw error;
  } finally {
    client.release();
  }
}

// ─── Batch Roster Update ──────────────────────────────────────

export interface RosterOperation {
  type: 'add_member' | 'remove_participant' | 'add_guest' | 'update_player_count';
  memberIdOrEmail?: string;
  participantId?: number;
  guest?: { name: string; email: string; phone?: string };
  playerCount?: number;
}

export interface BatchRosterUpdateParams {
  bookingId: number;
  rosterVersion: number;
  operations: RosterOperation[];
  staffEmail: string;
}

export interface BatchRosterUpdateResult {
  message: string;
  newRosterVersion: number;
  operationResults: Array<{ type: string; success: boolean; error?: string }>;
  feesRecalculated: boolean;
}

export async function applyRosterBatch(params: BatchRosterUpdateParams): Promise<BatchRosterUpdateResult> {
  const { bookingId, rosterVersion, operations, staffEmail } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  const isStaff = await isStaffOrAdminCheck(staffEmail);
  if (!isStaff) {
    throw createServiceError('Only staff or admin can perform batch roster updates', 403);
  }

  const client = await pool.connect();
  const operationResults: Array<{ type: string; success: boolean; error?: string }> = [];
  let sessionId = booking.session_id;
  let newRosterVersion: number;

  try {
    await client.query('BEGIN');

    const lockedBooking = await client.query(
      `SELECT roster_version FROM booking_requests WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );

    if (!lockedBooking.rows.length) {
      await client.query('ROLLBACK');
      throw createServiceError('Booking not found', 404);
    }

    const currentVersion = lockedBooking.rows[0].roster_version ?? 0;

    if (currentVersion !== rosterVersion) {
      await client.query('ROLLBACK');
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
      }, client);

      sessionId = sessionResult.sessionId || null;

      if (!sessionId || sessionResult.error) {
        await client.query('ROLLBACK');
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

            const prevResult = await client.query(
              `SELECT declared_player_count FROM booking_requests WHERE id = $1`,
              [bookingId]
            );
            const previousCount = prevResult.rows[0]?.declared_player_count || 1;

            await client.query(
              `UPDATE booking_requests SET declared_player_count = $1 WHERE id = $2`,
              [pc, bookingId]
            );

            if (pc > previousCount) {
              const slotResult = await client.query(
                `SELECT COALESCE(MAX(slot_number), 0) as max_slot, COUNT(*) as count FROM booking_members WHERE booking_id = $1`,
                [bookingId]
              );
              const maxSlot = parseInt(slotResult.rows[0].max_slot) || 0;
              const currentMemberCount = parseInt(slotResult.rows[0].count) || 0;
              const slotsToCreate = pc - currentMemberCount;

              if (slotsToCreate > 0) {
                await client.query(`
                  INSERT INTO booking_members (booking_id, slot_number, user_email, is_primary, created_at)
                  SELECT $1, slot_num, NULL, false, NOW()
                  FROM generate_series($2, $3) AS slot_num
                  ON CONFLICT (booking_id, slot_number) DO NOTHING
                `, [bookingId, maxSlot + 1, maxSlot + slotsToCreate]);
              }
            } else if (pc < previousCount) {
              await client.query(`
                DELETE FROM booking_members 
                WHERE booking_id = $1 
                  AND slot_number > $2 
                  AND is_primary = false 
                  AND (user_email IS NULL OR user_email = '')
              `, [bookingId, pc]);
            }

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

            const partResult = await client.query(
              `SELECT id, user_id, guest_id, participant_type, display_name, used_guest_pass
               FROM booking_participants WHERE id = $1 AND session_id = $2 LIMIT 1`,
              [op.participantId, sessionId]
            );

            if (partResult.rows.length === 0) {
              operationResults.push({ type: op.type, success: false, error: 'Participant not found in this session' });
              break;
            }

            const participant = partResult.rows[0];

            if (participant.participant_type === 'owner') {
              operationResults.push({ type: op.type, success: false, error: 'Cannot remove the booking owner' });
              break;
            }

            if (participant.participant_type === 'guest') {
              try {
                await refundGuestPass(booking.owner_email, participant.display_name || undefined, true);
              } catch (refundErr: unknown) {
                logger.warn('[rosterService:batch] Failed to refund guest pass (non-blocking)', {
                  error: refundErr as Error,
                  extra: { bookingId, participantId: op.participantId }
                });
              }
            }

            await client.query(
              `DELETE FROM booking_participants WHERE id = $1`,
              [op.participantId]
            );

            if (participant.participant_type === 'member' && participant.user_id) {
              const memberResult = await client.query(
                `SELECT email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
                [participant.user_id]
              );

              if (memberResult.rows.length > 0) {
                const memberEmail = memberResult.rows[0].email.toLowerCase();
                await client.query(
                  `DELETE FROM booking_members WHERE booking_id = $1 AND LOWER(user_email) = LOWER($2)`,
                  [bookingId, memberEmail]
                );
              }
            }

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

            const memberResult = await pool.query(
              `SELECT id, email, first_name, last_name FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
              [op.memberIdOrEmail]
            );

            if (memberResult.rows.length === 0) {
              operationResults.push({ type: op.type, success: false, error: 'Member not found' });
              break;
            }

            const memberInfo = {
              id: memberResult.rows[0].id,
              email: memberResult.rows[0].email,
              firstName: memberResult.rows[0].first_name,
              lastName: memberResult.rows[0].last_name
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
            }

            if (matchingGuest) {
              const guestCheckResult = await client.query(
                `SELECT id, display_name, used_guest_pass FROM booking_participants 
                 WHERE id = $1 AND session_id = $2 AND participant_type = 'guest' LIMIT 1`,
                [matchingGuest.id, sessionId]
              );

              if (guestCheckResult.rows.length > 0) {
                const guestToRemove = guestCheckResult.rows[0];
                await client.query(
                  `DELETE FROM booking_participants WHERE id = $1`,
                  [guestToRemove.id]
                );

                if (guestToRemove.used_guest_pass === true) {
                  try {
                    await refundGuestPass(booking.owner_email, guestToRemove.display_name || undefined, true);
                  } catch (refundErr: unknown) {
                    logger.warn('[rosterService:batch] Failed to refund guest pass on replacement (non-blocking)', {
                      error: refundErr as Error,
                      extra: { bookingId, guestName: guestToRemove.display_name }
                    });
                  }
                }
              }
            }

            const displayName = [memberInfo.firstName, memberInfo.lastName].filter(Boolean).join(' ') || memberInfo.email;
            await linkParticipants(sessionId!, [{ userId: memberInfo.id, participantType: 'member', displayName }]);

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
                [bookingId, memberInfo.email.toLowerCase(), nextSlot, staffEmail]
              );
            }

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
            }]);

            if (newGuestParticipant) {
              await client.query(
                `UPDATE booking_participants SET payment_status = 'paid' WHERE id = $1`,
                [newGuestParticipant.id]
              );
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

    await client.query(
      `UPDATE booking_requests SET roster_version = COALESCE(roster_version, 0) + 1 WHERE id = $1`,
      [bookingId]
    );

    newRosterVersion = currentVersion + 1;

    await client.query('COMMIT');
  } catch (txError: unknown) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw txError;
  } finally {
    client.release();
  }

  let feesRecalculated = false;
  if (sessionId) {
    try {
      const allParticipants = await getSessionParticipants(sessionId);
      const participantIds = allParticipants.map(p => p.id);

      await invalidateCachedFees(participantIds, 'batch_roster_update');

      const recalcResult = await recalculateSessionFees(sessionId, 'roster_update');
      feesRecalculated = true;

      logger.info('[rosterService:batch] Session fees recalculated after batch update', {
        extra: {
          sessionId,
          bookingId,
          participantsUpdated: recalcResult.participantsUpdated,
          totalFees: recalcResult.billingResult.totalFees,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });

      if (Number(recalcResult.billingResult.totalFees) > 0) {
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
