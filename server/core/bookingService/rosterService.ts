import { db } from '../../db';
import { bookingParticipants, bookingRequests, users, resources } from '../../../shared/schema';
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
import { getOrCreateStripeCustomer } from '../stripe/customers';
import { createBalanceAwarePayment } from '../stripe/payments';
import { useGuestPass, refundGuestPass, ensureGuestPassRecord } from '../../routes/guestPasses';
import { getErrorMessage } from '../../utils/errorUtils';
import type { FeeBreakdown } from '../../../shared/models/billing';
import type { BookingParticipant } from '../../../shared/models/scheduling';
import { syncBookingInvoice, isBookingInvoicePaid } from '../billing/bookingInvoiceService';
import { broadcastBookingRosterUpdate } from '../websocket';

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
  trackman_booking_id: string | null;
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
  allPaid?: boolean;
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
  const result = await db.execute(sql`SELECT 
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
      br.trackman_booking_id,
      r.name as resource_name,
      u.tier as owner_tier
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
    WHERE br.id = ${bookingId}`);
  return (result.rows[0] as unknown as BookingWithSession) || null;
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
    const participantCheck = await db.execute(sql`SELECT 1 FROM booking_participants bp
       JOIN booking_sessions bs ON bp.session_id = bs.id
       JOIN booking_requests br ON br.session_id = bs.id
       WHERE br.id = ${bookingId} AND bp.user_id = ${sessionUser.id || userEmail}
       LIMIT 1`);
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
            const ownerLookup = await db.select({ firstName: users.firstName, lastName: users.lastName })
              .from(users)
              .where(sql`LOWER(${users.email}) = LOWER(${booking.owner_email})`)
              .limit(1);
            if (ownerLookup.length > 0) {
              ownerName = [ownerLookup[0].firstName, ownerLookup[0].lastName].filter(Boolean).join(' ') || null;
            }
          }
          if (ownerName) {
            participants[i] = { ...p, displayName: ownerName };
            await db.update(bookingParticipants)
              .set({ displayName: ownerName })
              .where(eq(bookingParticipants.id, p.id));
          }
        } else if (p.participantType === 'member' && p.userId) {
          const userResult = await db.select({ firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(eq(users.id, p.userId))
            .limit(1);
          if (userResult.length > 0) {
            const { firstName, lastName } = userResult[0];
            const fullName = [firstName, lastName].filter(Boolean).join(' ');
            if (fullName) {
              participants[i] = { ...p, displayName: fullName };
              await db.update(bookingParticipants)
                .set({ displayName: participants[i].displayName })
                .where(eq(bookingParticipants.id, p.id));
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
    const resourceResult = await db.select({ type: resources.type })
      .from(resources)
      .where(eq(resources.id, booking.resource_id))
      .limit(1);
    resourceTypeForRoster = resourceResult[0]?.type || 'simulator';
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
          const ownerLookup = await db.select({ firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(sql`LOWER(${users.email}) = LOWER(${booking.owner_email})`)
            .limit(1);
          if (ownerLookup.length > 0) {
            const fullName = [ownerLookup[0].firstName, ownerLookup[0].lastName].filter(Boolean).join(' ');
            if (fullName) resolvedName = fullName;
          }
        }
      } else if (p.userId) {
        const userResult = await db.select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, p.userId))
          .limit(1);
        if (userResult.length > 0) {
          const fullName = [userResult[0].firstName, userResult[0].lastName].filter(Boolean).join(' ');
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
    const resourceResult = await db.select({ capacity: resources.capacity, type: resources.type })
      .from(resources)
      .where(eq(resources.id, booking.resource_id))
      .limit(1);
    if (resourceResult[0]?.capacity) {
      resourceCapacity = resourceResult[0].capacity;
    }
    isConferenceRoom = resourceResult[0]?.type === 'conference_room';
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

  let allPaid = false;
  if (booking.session_id) {
    const [paidCheck, feeSnapshotCheck] = await Promise.all([
      db.execute(sql`SELECT 
           COUNT(*) FILTER (WHERE payment_status IN ('paid', 'waived')) as paid_count,
           COUNT(*) FILTER (WHERE cached_fee_cents > 0 OR payment_status IN ('paid', 'waived')) as total_with_fees,
           COUNT(*) FILTER (WHERE payment_status = 'pending' OR (payment_status IS NULL AND cached_fee_cents > 0)) as pending_count
         FROM booking_participants 
         WHERE session_id = ${booking.session_id}`),
      db.execute(sql`SELECT id, total_cents FROM booking_fee_snapshots WHERE session_id = ${booking.session_id} AND status IN ('completed', 'paid') ORDER BY created_at DESC LIMIT 1`),
    ]);

    const paidCount = parseInt((paidCheck.rows[0] as Record<string, string>)?.paid_count || '0');
    const totalWithFees = parseInt((paidCheck.rows[0] as Record<string, string>)?.total_with_fees || '0');
    const pendingCount = parseInt((paidCheck.rows[0] as Record<string, string>)?.pending_count || '0');
    const hasCompletedFeeSnapshot = feeSnapshotCheck.rows.length > 0;
    const hasPaidFees = paidCount > 0;
    const hasOriginalFees = totalWithFees > 0;

    allPaid = (hasCompletedFeeSnapshot && pendingCount === 0) || (pendingCount === 0 && hasPaidFees);

    if (allPaid) {
      const invoicePaid = await isBookingInvoicePaid(booking.booking_id);
      if (!invoicePaid) {
        allPaid = false;
      }
    }
  }

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
    allPaid,
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
    allPaid: false,
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
  useGuestPass?: boolean;
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

async function enforceRosterLock(bookingId: number, options?: { forceOverride?: boolean; overrideReason?: string; staffEmail?: string }): Promise<void> {
  if (options?.forceOverride && options?.overrideReason) {
    logger.warn('[RosterService] Roster lock overridden by staff', {
      extra: { bookingId, staffEmail: options.staffEmail, overrideReason: options.overrideReason }
    });
    return;
  }

  const lockStatus = await isBookingInvoicePaid(bookingId);
  if (lockStatus.locked) {
    throw new Error(`ROSTER_LOCKED: ${lockStatus.reason}. Booking ID: ${bookingId}`);
  }
}

// ─── addParticipant ────────────────────────────────────────────

export async function addParticipant(params: AddParticipantParams): Promise<AddParticipantResult> {
  const { bookingId, type, userId, guest, rosterVersion, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  try {
    await enforceRosterLock(bookingId);
  } catch (lockErr: unknown) {
    if (lockErr instanceof Error && lockErr.message.startsWith('ROSTER_LOCKED:')) throw lockErr;
    logger.warn('[rosterService] Roster lock check failed (non-blocking)', { extra: { bookingId, error: getErrorMessage(lockErr) } });
  }

  const isOwner = booking.owner_email?.toLowerCase() === userEmail;
  const isStaff = await isStaffOrAdminCheck(userEmail);
  if (!isOwner && !isStaff) {
    throw createServiceError('Only the booking owner or staff can add participants', 403);
  }

  let newRosterVersion: number;
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
      const memberResult = await db.select({
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
      const guestId = await createOrFindGuest(
        guest!.name,
        guest!.email,
        undefined,
        sessionUserId || userEmail
      );

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

    const [newParticipant] = await linkParticipants(sessionId, [participantInput]);

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

        if (guestCheckResult.rows.length > 0) {
          const guestToRemove = guestCheckResult.rows[0] as Record<string, unknown>;
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
            .where(eq(bookingParticipants.id, guestToRemove.id as number));

          if (guestToRemove.used_guest_pass === true) {
            deferredGuestPassRefund = { ownerEmail: booking.owner_email, guestName: guestToRemove.display_name as string || undefined };
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

  if (deferredGuestPassRefund) {
    try {
      const refundResult = await refundGuestPass(
        deferredGuestPassRefund.ownerEmail,
        deferredGuestPassRefund.guestName,
        true
      );
      if (refundResult.success) {
        logger.info('[rosterService] Guest pass refunded when replacing guest with member (deferred)', {
          extra: {
            bookingId,
            ownerEmail: deferredGuestPassRefund.ownerEmail,
            guestName: deferredGuestPassRefund.guestName,
            remainingPasses: refundResult.remaining
          }
        });
      }
    } catch (refundErr: unknown) {
      logger.warn('[rosterService] Failed to refund guest pass after tx (non-blocking)', {
        error: refundErr as Error,
        extra: { bookingId, ownerEmail: deferredGuestPassRefund.ownerEmail }
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
          totalFees: recalcResult.billingResult.totalFees,
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

      if (Number(recalcResult.billingResult.totalFees) > 0) {
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

          const totalCents = parseInt((feeResult.rows[0] as Record<string, string>)?.total_cents || '0');
          const overageCents = parseInt((feeResult.rows[0] as Record<string, string>)?.overage_cents || '0');
          const guestCents = parseInt((feeResult.rows[0] as Record<string, string>)?.guest_cents || '0');

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

// ─── removeParticipant ─────────────────────────────────────────

export async function removeParticipant(params: RemoveParticipantParams): Promise<RemoveParticipantResult> {
  const { bookingId, participantId, rosterVersion, userEmail, sessionUserId } = params;

  const booking = await getBookingWithSession(bookingId);
  if (!booking) {
    throw createServiceError('Booking not found', 404);
  }

  try {
    await enforceRosterLock(bookingId);
  } catch (lockErr: unknown) {
    if (lockErr instanceof Error && lockErr.message.startsWith('ROSTER_LOCKED:')) throw lockErr;
    logger.warn('[rosterService] Roster lock check failed (non-blocking)', { extra: { bookingId, error: getErrorMessage(lockErr) } });
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

    let guestPassesRemaining: number | undefined;
    if (participant.participantType === 'guest') {
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
      guestPassesRemaining,
      newRosterVersion
    };
  });

  if (deferredRemoveRefund) {
    try {
      const refundResult = await refundGuestPass(
        deferredRemoveRefund.ownerEmail,
        deferredRemoveRefund.guestName,
        true
      );
      if (refundResult.success) {
        txResult.guestPassesRemaining = refundResult.remaining;
        logger.info('[rosterService] Guest pass refunded on participant removal (deferred)', {
          extra: {
            bookingId,
            ownerEmail: deferredRemoveRefund.ownerEmail,
            guestName: deferredRemoveRefund.guestName,
            remainingPasses: refundResult.remaining
          }
        });
      } else {
        logger.warn('[rosterService] Failed to refund guest pass (non-blocking)', {
          extra: {
            bookingId,
            ownerEmail: deferredRemoveRefund.ownerEmail,
            error: refundResult.error
          }
        });
      }
    } catch (refundErr: unknown) {
      logger.warn('[rosterService] Failed to refund guest pass after tx (non-blocking)', {
        error: refundErr as Error,
        extra: { bookingId, ownerEmail: deferredRemoveRefund.ownerEmail }
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
          totalFees: recalcResult.billingResult.totalFees,
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

// ─── updateDeclaredPlayerCount ─────────────────────────────────

export async function updateDeclaredPlayerCount(params: UpdatePlayerCountParams): Promise<UpdatePlayerCountResult> {
  const { bookingId, playerCount, staffEmail } = params;

  try {
    await enforceRosterLock(bookingId);
  } catch (lockErr: unknown) {
    if (lockErr instanceof Error && lockErr.message.startsWith('ROSTER_LOCKED:')) throw lockErr;
    logger.warn('[rosterService] Roster lock check failed (non-blocking)', { extra: { bookingId, error: getErrorMessage(lockErr) } });
  }

  const txResult = await db.transaction(async (tx) => {
    const bookingResult = await tx.execute(sql`
      SELECT br.id, br.declared_player_count, br.session_id, br.user_email, br.status
      FROM booking_requests br
      WHERE br.id = ${bookingId}
    `);

    if (bookingResult.rows.length === 0) {
      throw createServiceError('Booking not found', 404);
    }

    const booking = bookingResult.rows[0] as Record<string, unknown>;
    const previousCount = (booking.declared_player_count as number) || 1;

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

  try {
    await enforceRosterLock(bookingId);
  } catch (lockErr: unknown) {
    if (lockErr instanceof Error && lockErr.message.startsWith('ROSTER_LOCKED:')) throw lockErr;
    logger.warn('[rosterService] Roster lock check failed (non-blocking)', { extra: { bookingId, error: getErrorMessage(lockErr) } });
  }

  const isStaff = await isStaffOrAdminCheck(staffEmail);
  if (!isStaff) {
    throw createServiceError('Only staff or admin can perform batch roster updates', 403);
  }

  const operationResults: Array<{ type: string; success: boolean; error?: string }> = [];
  let sessionId = booking.session_id;
  let newRosterVersion: number;
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

            const participant = partResult.rows[0] as Record<string, unknown>;

            if (participant.participant_type === 'owner') {
              operationResults.push({ type: op.type, success: false, error: 'Cannot remove the booking owner' });
              break;
            }

            if (participant.participant_type === 'guest' && participant.used_guest_pass === true) {
              deferredBatchRefunds.push({ ownerEmail: booking.owner_email, guestName: participant.display_name as string || undefined });
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

            const memberResult = await db.select({
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
              const guestCheckResult = await tx.execute(sql`
                SELECT id, display_name, used_guest_pass FROM booking_participants 
                WHERE id = ${matchingGuest.id} AND session_id = ${sessionId} AND participant_type = 'guest' LIMIT 1
              `);

              if (guestCheckResult.rows.length > 0) {
                const guestToRemove = guestCheckResult.rows[0] as Record<string, unknown>;
                await tx.delete(bookingParticipants)
                  .where(eq(bookingParticipants.id, guestToRemove.id as number));

                if (guestToRemove.used_guest_pass === true) {
                  deferredBatchRefunds.push({ ownerEmail: booking.owner_email, guestName: guestToRemove.display_name as string || undefined });
                }
              }
            }

            const displayName = [memberInfo.firstName, memberInfo.lastName].filter(Boolean).join(' ') || memberInfo.email;
            await linkParticipants(sessionId!, [{ userId: memberInfo.id, participantType: 'member', displayName }]);

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
      await refundGuestPass(refund.ownerEmail, refund.guestName, true);
      logger.info('[rosterService:batch] Guest pass refunded (deferred)', {
        extra: { bookingId, ownerEmail: refund.ownerEmail, guestName: refund.guestName }
      });
    } catch (refundErr: unknown) {
      logger.warn('[rosterService:batch] Failed to refund guest pass after tx (non-blocking)', {
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
          totalFees: recalcResult.billingResult.totalFees,
          ledgerUpdated: recalcResult.ledgerUpdated
        }
      });

      if (Number(recalcResult.billingResult.totalFees) > 0) {
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

          const totalCents = parseInt((feeResult.rows[0] as Record<string, string>)?.total_cents || '0');
          const overageCents = parseInt((feeResult.rows[0] as Record<string, string>)?.overage_cents || '0');
          const guestCents = parseInt((feeResult.rows[0] as Record<string, string>)?.guest_cents || '0');

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

