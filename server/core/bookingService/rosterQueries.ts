import { db } from '../../db';
import { bookingParticipants, bookingRequests, users, resources } from '../../../shared/schema';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { logger } from '../logger';
import {
  getSessionParticipants,
} from './sessionManager';
import {
  getGuestPassesRemaining,
  getRemainingMinutes,
} from './tierRules';
import {
  computeUsageAllocation,
  calculateOverageFee,
} from './usageCalculator';
import { getTierLimits, getMemberTierByEmail } from '../tierService';
import {
  computeFeeBreakdown,
  getEffectivePlayerCount,
} from '../billing/unifiedFeeService';
import { PRICING, isPlaceholderGuestName } from '../billing/pricingConfig';
import { checkBookingPaymentStatus } from '../billing/bookingInvoiceService';
import { getErrorMessage } from '../../utils/errorUtils';
import type { FeeBreakdown } from '../../../shared/models/billing';
import type { BookingParticipant } from '../../../shared/models/scheduling';
import {
  type BookingWithSession,
  type ParticipantRow,
  type BookingParticipantsResult,
  type SessionUser,
  type PreviewFeesResult,
  type FeeParticipantInput,
  type FallbackPreviewParams,
  type ProvisionalParticipant,
  isStaffOrAdminCheck,
  getBookingWithSession,
} from './rosterTypes';

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

    const needsNameFix = participants.filter(p => p.displayName && p.displayName.includes('@'));
    if (needsNameFix.length > 0) {
      const userIdsToLookup = needsNameFix
        .filter(p => p.participantType === 'member' && p.userId)
        .map(p => p.userId!);
      const emailsToLookup = needsNameFix
        .filter(p => p.participantType === 'owner' && !booking.owner_name && booking.owner_email)
        .map(() => booking.owner_email!);

      const allLookupIds = [...new Set(userIdsToLookup)];
      const allLookupEmails = [...new Set(emailsToLookup.map(e => e.toLowerCase()))];

      const nameMap = new Map<string, string>();

      if (allLookupIds.length > 0 || allLookupEmails.length > 0) {
        const nameResults = await db.select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        })
          .from(users)
          .where(
            allLookupIds.length > 0 && allLookupEmails.length > 0
              ? sql`${users.id} IN (${sql.join(allLookupIds.map(id => sql`${id}`), sql`, `)}) OR LOWER(${users.email}) IN (${sql.join(allLookupEmails.map(e => sql`${e}`), sql`, `)})`
              : allLookupIds.length > 0
                ? inArray(users.id, allLookupIds)
                : sql`LOWER(${users.email}) IN (${sql.join(allLookupEmails.map(e => sql`${e}`), sql`, `)})`
          );

        for (const row of nameResults) {
          const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
          if (fullName) {
            nameMap.set(row.id, fullName);
            if (row.email) nameMap.set(row.email.toLowerCase(), fullName);
          }
        }
      }

      const updatePromises: Promise<unknown>[] = [];
      for (let i = 0; i < participants.length; i++) {
        const p = participants[i];
        if (!p.displayName || !p.displayName.includes('@')) continue;

        let resolvedName: string | null = null;
        if (p.participantType === 'owner') {
          resolvedName = booking.owner_name || (booking.owner_email ? nameMap.get(booking.owner_email.toLowerCase()) || null : null);
        } else if (p.participantType === 'member' && p.userId) {
          resolvedName = nameMap.get(p.userId) || null;
        }

        if (resolvedName) {
          participants[i] = { ...p, displayName: resolvedName };
          updatePromises.push(
            db.update(bookingParticipants)
              .set({ displayName: resolvedName })
              .where(eq(bookingParticipants.id, p.id))
          );
        }
      }

      if (updatePromises.length > 0) {
        await Promise.all(updatePromises);
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

  const needsNameResolve = existingParticipants.filter(p => p.displayName && p.displayName.includes('@'));
  const previewNameMap = new Map<string, string>();

  if (needsNameResolve.length > 0) {
    const lookupUserIds = [...new Set(
      needsNameResolve.filter(p => p.userId).map(p => p.userId!)
    )];
    const lookupEmails = [...new Set(
      needsNameResolve
        .filter(p => p.participantType === 'owner' && !booking.owner_name && booking.owner_email)
        .map(() => booking.owner_email!.toLowerCase())
    )];

    if (lookupUserIds.length > 0 || lookupEmails.length > 0) {
      const nameResults = await db.select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
        .from(users)
        .where(
          lookupUserIds.length > 0 && lookupEmails.length > 0
            ? sql`${users.id} IN (${sql.join(lookupUserIds.map(id => sql`${id}`), sql`, `)}) OR LOWER(${users.email}) IN (${sql.join(lookupEmails.map(e => sql`${e}`), sql`, `)})`
            : lookupUserIds.length > 0
              ? inArray(users.id, lookupUserIds)
              : sql`LOWER(${users.email}) IN (${sql.join(lookupEmails.map(e => sql`${e}`), sql`, `)})`
        );

      for (const row of nameResults) {
        const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
        if (fullName) {
          previewNameMap.set(row.id, fullName);
          if (row.email) previewNameMap.set(row.email.toLowerCase(), fullName);
        }
      }
    }
  }

  for (const p of existingParticipants) {
    let resolvedName = p.displayName;
    if (resolvedName && resolvedName.includes('@')) {
      if (p.participantType === 'owner') {
        resolvedName = booking.owner_name || (booking.owner_email ? previewNameMap.get(booking.owner_email.toLowerCase()) || resolvedName : resolvedName);
      } else if (p.userId) {
        resolvedName = previewNameMap.get(p.userId) || resolvedName;
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
    let ownerName = booking.owner_name;
    if (!ownerName || ownerName.includes('@')) {
      const ownerNameResult = await db.select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(sql`LOWER(${users.email}) = LOWER(${booking.owner_email})`)
        .limit(1);
      if (ownerNameResult.length > 0) {
        const dbName = [ownerNameResult[0].firstName, ownerNameResult[0].lastName].filter(Boolean).join(' ').trim();
        if (dbName) ownerName = dbName;
      }
    }
    participantsForFeeCalc.push({
      email: booking.owner_email,
      displayName: ownerName || booking.owner_email,
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
      isConferenceRoom,
    });
  }

  const ownerLineItem = breakdown.participants.find(p => p.participantType === 'owner');
  const ownerMinutes = ownerLineItem?.minutesAllocated || breakdown.metadata.sessionDuration;
  const realGuestMinutes = breakdown.participants
    .filter(p => p.participantType === 'guest' && p.participantId !== undefined && p.displayName !== 'Empty Slot')
    .reduce((sum, p) => sum + p.minutesAllocated, 0);
  const totalOwnerResponsibleMinutes = ownerMinutes;
  const guestMinutes = realGuestMinutes;

  const overageFee = Math.round(breakdown.totals.overageCents / 100);
  const overageMinutes = overageFee > 0 ? Math.ceil(overageFee / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES : 0;
  const minutesWithinAllowance = Math.max(0, totalOwnerResponsibleMinutes - overageMinutes);

  let allPaid = false;
  if (booking.session_id) {
    const paymentStatus = await checkBookingPaymentStatus({
      bookingId: booking.booking_id,
      sessionId: booking.session_id,
    });
    allPaid = paymentStatus.allPaid;
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
        guestPassUsed: p.guestPassUsed ?? false,
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

async function buildFallbackPreview(params: FallbackPreviewParams): Promise<PreviewFeesResult> {
  const {
    booking, durationMinutes, declaredPlayerCount, totalSlots, minutesPerPlayer,
    actualParticipantCount, effectivePlayerCount, dailyAllowance,
    remainingMinutesToday, guestPassesPerMonth, ownerTier, allParticipants,
    participantsForFeeCalc, guestCount, memberCount, isConferenceRoom,
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

  const passEligibleGuests = participantsForFeeCalc.filter(p =>
    p.participantType === 'guest' && !isPlaceholderGuestName(p.displayName)
  ).length;
  const placeholderGuests = guestCount - passEligibleGuests;
  const passEligibleWithoutPass = Math.max(0, passEligibleGuests - Math.min(passEligibleGuests, guestPassesRemaining));
  const emptySlotGuestFees = !isConferenceRoom ? unfilledSlots * PRICING.GUEST_FEE_DOLLARS : 0;
  const realGuestFees = !isConferenceRoom ? (passEligibleWithoutPass + placeholderGuests) * PRICING.GUEST_FEE_DOLLARS : 0;
  const estimatedGuestFees = realGuestFees + emptySlotGuestFees;
  const estimatedTotalFees = overageFee + estimatedGuestFees;

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
      estimatedGuestFees,
      estimatedTotalFees,
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
