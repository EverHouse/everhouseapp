import { logger } from '../logger';
import { getTierLimits, getMemberTierByEmail } from '../tierService';
import { pool } from '../db';
import { MemberService, isUUID, isEmail, normalizeEmail } from '../memberService';
import { PRICING } from '../billing/pricingConfig';

async function resolveToEmail(identifier: string | undefined): Promise<string> {
  if (!identifier) return '';
  
  if (isEmail(identifier)) {
    return normalizeEmail(identifier);
  }
  
  if (isUUID(identifier)) {
    const member = await MemberService.findById(identifier);
    if (member) {
      return member.normalizedEmail;
    }
  }
  
  return identifier;
}

export interface Participant {
  userId?: string;
  email?: string;
  guestId?: number;
  participantType: 'owner' | 'member' | 'guest';
  displayName: string;
}

export interface UsageAllocation {
  userId?: string;
  guestId?: number;
  participantType: 'owner' | 'member' | 'guest';
  displayName: string;
  minutesAllocated: number;
}

export interface OverageFeeResult {
  hasOverage: boolean;
  overageMinutes: number;
  overageFee: number;
}

export interface AllocationOptions {
  declaredSlots?: number;
  assignRemainderToOwner?: boolean;
}

export function computeUsageAllocation(
  sessionDuration: number,
  participants: Participant[],
  options?: AllocationOptions
): UsageAllocation[] {
  if (!participants || participants.length === 0) {
    return [];
  }
  
  const divisor = options?.declaredSlots && options.declaredSlots > 0 
    ? options.declaredSlots 
    : participants.length;
  
  const minutesPerParticipant = Math.floor(sessionDuration / divisor);
  const remainder = sessionDuration % divisor;
  
  const assignToOwner = options?.assignRemainderToOwner ?? false;
  
  if (assignToOwner) {
    return participants.map((participant) => ({
      userId: participant.userId,
      guestId: participant.guestId,
      participantType: participant.participantType,
      displayName: participant.displayName,
      minutesAllocated: minutesPerParticipant + (participant.participantType === 'owner' ? remainder : 0)
    }));
  }
  
  return participants.map((participant, index) => ({
    userId: participant.userId,
    guestId: participant.guestId,
    participantType: participant.participantType,
    displayName: participant.displayName,
    minutesAllocated: minutesPerParticipant + (index < remainder ? 1 : 0)
  }));
}

export function calculateOverageFee(
  minutesUsed: number,
  tierAllowance: number
): OverageFeeResult {
  if (tierAllowance >= 999 || minutesUsed <= tierAllowance) {
    return {
      hasOverage: false,
      overageMinutes: 0,
      overageFee: 0
    };
  }
  
  const overageMinutes = minutesUsed - tierAllowance;
  
  const thirtyMinBlocks = Math.ceil(overageMinutes / PRICING.OVERAGE_BLOCK_MINUTES);
  const overageFee = thirtyMinBlocks * PRICING.OVERAGE_RATE_DOLLARS;
  
  return {
    hasOverage: true,
    overageMinutes,
    overageFee
  };
}

export interface ParticipantBilling {
  participantId?: number;
  userId?: string;
  guestId?: number;
  email?: string;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  tierName: string | null;
  minutesAllocated: number;
  dailyAllowance: number;
  usedMinutesToday: number;
  remainingMinutesBefore: number;
  overageMinutes: number;
  overageFee: number;
  guestFee: number;
  guestPassUsed: boolean;
  totalFee: number;
}

export interface SessionBillingResult {
  sessionDuration: number;
  participantCount: number;
  guestCount: number;
  billingBreakdown: ParticipantBilling[];
  totalOverageFees: number;
  totalGuestFees: number;
  totalFees: number;
  guestPassesUsed: number;
  guestPassesAvailable: number;
}

export async function getDailyUsageFromLedger(
  memberEmail: string,
  date: string,
  excludeSessionId?: number,
  resourceType?: string
): Promise<number> {
  try {
    const params: (string | number | null)[] = [memberEmail, date];
    let paramIdx = 3;

    let excludeClause = '';
    if (excludeSessionId) {
      excludeClause = `AND ul.session_id != $${paramIdx}`;
      params.push(excludeSessionId);
      paramIdx++;
    }

    let resourceTypeClause = '';
    if (resourceType) {
      resourceTypeClause = `AND EXISTS (
        SELECT 1 FROM resources r 
        WHERE r.id = bs.resource_id AND r.type = $${paramIdx}
      )`;
      params.push(resourceType);
    }

    const result = await pool.query(
      `SELECT COALESCE(SUM(minutes_charged), 0) as total_minutes
       FROM usage_ledger ul
       JOIN booking_sessions bs ON ul.session_id = bs.id
       WHERE LOWER(ul.member_id) = LOWER($1)
         AND bs.session_date = $2
         ${excludeClause}
         ${resourceTypeClause}`,
      params
    );
    
    // Safety check: warn if there are sessions with participants but no ledger entries
    try {
      const warningParams: (string | number | null)[] = [memberEmail, date];
      let warningExclude = '';
      if (excludeSessionId) {
        warningExclude = `AND bs.id != $3`;
        warningParams.push(excludeSessionId);
      }
      
      const missingCheck = await pool.query(
        `SELECT COUNT(DISTINCT bs.id) as missing_count
         FROM booking_sessions bs
         JOIN booking_participants bp ON bp.session_id = bs.id
         JOIN users u ON bp.user_id = u.id
         WHERE LOWER(u.email) = LOWER($1)
           AND bs.session_date = $2
           AND NOT EXISTS (
             SELECT 1 FROM usage_ledger ul 
             WHERE ul.session_id = bs.id 
             AND LOWER(ul.member_id) = LOWER($1)
           )
           ${warningExclude}`,
        warningParams
      );
      
      const missingCount = parseInt(missingCheck.rows[0]?.missing_count) || 0;
      if (missingCount > 0) {
        logger.warn('[getDailyUsageFromLedger] Sessions with participants but no ledger entries detected', {
          extra: { memberEmail, date, missingSessionCount: missingCount }
        });
      }
    } catch (checkError: unknown) {
      // Non-critical check, don't fail the main query
    }

    return parseInt(result.rows[0].total_minutes) || 0;
  } catch (error: unknown) {
    logger.error('[getDailyUsageFromLedger] Error:', { error });
    return 0;
  }
}

export async function getGuestPassInfo(
  memberEmail: string,
  tierName?: string
): Promise<{ remaining: number; hasGuestPassBenefit: boolean }> {
  try {
    const tierLimits = tierName ? await getTierLimits(tierName) : null;
    const hasGuestPassBenefit = (tierLimits?.has_simulator_guest_passes ?? false) || 
      (tierLimits?.guest_passes_per_month ?? 0) > 0;
    
    if (!hasGuestPassBenefit) {
      return { remaining: 0, hasGuestPassBenefit: false };
    }
    
    const result = await pool.query(
      `SELECT passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = LOWER($1)`,
      [memberEmail]
    );
    
    if (result.rows.length === 0) {
      const monthlyAllocation = tierLimits?.guest_passes_per_month ?? 0;
      return { remaining: monthlyAllocation, hasGuestPassBenefit: true };
    }
    
    const remaining = Math.max(0, result.rows[0].passes_total - result.rows[0].passes_used);
    return { remaining, hasGuestPassBenefit: true };
  } catch (error: unknown) {
    logger.error('[getGuestPassInfo] Error:', { error });
    return { remaining: 0, hasGuestPassBenefit: false };
  }
}

export async function calculateSessionBilling(
  sessionDate: string,
  sessionDuration: number,
  participants: Participant[],
  hostEmail: string,
  options?: {
    excludeSessionId?: number;
    consumeGuestPasses?: boolean;
    resourceType?: string;
  }
): Promise<SessionBillingResult> {
  const billingBreakdown: ParticipantBilling[] = [];
  let totalOverageFees = 0;
  let totalGuestFees = 0;
  let guestPassesUsed = 0;
  
  const guestCount = participants.filter(p => p.participantType === 'guest').length;
  const hostTier = await getMemberTierByEmail(hostEmail);
  const guestPassInfo = await getGuestPassInfo(hostEmail, hostTier || undefined);
  let guestPassesRemaining = guestPassInfo.remaining;
  
  // Use proper allocation helper to distribute remainder minutes correctly
  const allocations = computeUsageAllocation(sessionDuration, participants);
  const allocationMap = new Map(allocations.map((a, idx) => [idx, a]));
  
  for (let idx = 0; idx < participants.length; idx++) {
    const participant = participants[idx];
    const allocation = allocationMap.get(idx)!;
    let billing: ParticipantBilling;
    
    if (participant.participantType === 'guest') {
      let guestFee = PRICING.GUEST_FEE_DOLLARS;
      let guestPassUsed = false;
      
      const isPlaceholderGuest = /^Guest \d+$/i.test(participant.displayName || '');
      const isRealNamedGuest = participant.guestId || !isPlaceholderGuest;
      if (isRealNamedGuest && guestPassInfo.hasGuestPassBenefit && guestPassesRemaining > 0) {
        guestPassUsed = true;
        guestPassesRemaining--;
        guestPassesUsed++;
        guestFee = 0;
      }
      
      billing = {
        guestId: participant.guestId,
        displayName: participant.displayName,
        participantType: 'guest',
        tierName: null,
        minutesAllocated: allocation.minutesAllocated,
        dailyAllowance: 0,
        usedMinutesToday: 0,
        remainingMinutesBefore: 0,
        overageMinutes: 0,
        overageFee: 0,
        guestFee,
        guestPassUsed,
        totalFee: guestFee
      };
      
      totalGuestFees += guestFee;
    } else {
      const memberEmail = await resolveToEmail(participant.email || participant.userId);
      const tierName = await getMemberTierByEmail(memberEmail);
      const tierLimits = tierName ? await getTierLimits(tierName) : null;
      const dailyAllowance = options?.resourceType === 'conference_room'
        ? (tierLimits?.daily_conf_room_minutes ?? 0)
        : (tierLimits?.daily_sim_minutes ?? 0);
      const unlimitedAccess = tierLimits?.unlimited_access ?? false;
      
      const usedMinutesToday = await getDailyUsageFromLedger(
        memberEmail,
        sessionDate,
        options?.excludeSessionId,
        options?.resourceType
      );
      
      const remainingMinutesBefore = unlimitedAccess || dailyAllowance >= 999
        ? 999
        : Math.max(0, dailyAllowance - usedMinutesToday);
      
      const minutesAllocated = allocation.minutesAllocated;
      
      let overageMinutes = 0;
      let overageFee = 0;
      
      if (!unlimitedAccess && dailyAllowance < 999) {
        const totalMinutesAfterSession = usedMinutesToday + minutesAllocated;
        const overageResult = calculateOverageFee(totalMinutesAfterSession, dailyAllowance);
        
        const priorOverage = calculateOverageFee(usedMinutesToday, dailyAllowance);
        overageMinutes = overageResult.overageMinutes - priorOverage.overageMinutes;
        overageFee = overageResult.overageFee - priorOverage.overageFee;
        
        if (overageMinutes < 0) overageMinutes = 0;
        if (overageFee < 0) overageFee = 0;
      }
      
      billing = {
        userId: participant.userId,
        email: memberEmail,
        displayName: participant.displayName,
        participantType: participant.participantType,
        tierName,
        minutesAllocated,
        dailyAllowance,
        usedMinutesToday,
        remainingMinutesBefore,
        overageMinutes,
        overageFee,
        guestFee: 0,
        guestPassUsed: false,
        totalFee: overageFee
      };
      
      totalOverageFees += overageFee;
    }
    
    billingBreakdown.push(billing);
  }
  
  return {
    sessionDuration,
    participantCount: participants.length,
    guestCount,
    billingBreakdown,
    totalOverageFees,
    totalGuestFees,
    totalFees: totalOverageFees + totalGuestFees,
    guestPassesUsed,
    guestPassesAvailable: guestPassInfo.remaining
  };
}

export async function calculateFullSessionBilling(
  sessionDate: string,
  sessionDuration: number,
  participants: Participant[],
  hostEmail: string,
  declaredPlayerCount: number = 1,
  options?: {
    excludeSessionId?: number;
    resourceType?: string;
  }
): Promise<SessionBillingResult> {
  const billingBreakdown: ParticipantBilling[] = [];
  let totalOverageFees = 0;
  let totalGuestFees = 0;
  let guestPassesUsed = 0;
  
  const guestCount = participants.filter(p => p.participantType === 'guest').length;
  const memberCount = participants.filter(p => p.participantType !== 'guest').length;
  
  // Calculate effective player count using Math.max to match unifiedFeeService logic
  // This fixes the "bait-and-switch" fee bug where declared player count differs from actual participants
  const effectivePlayerCount = Math.max(declaredPlayerCount, participants.length);
  const perPersonMinutes = Math.floor(sessionDuration / effectivePlayerCount);
  const ownerRemainder = sessionDuration % effectivePlayerCount;
  const ownerAllocatedMinutes = perPersonMinutes + ownerRemainder;
  
  const hostTier = await getMemberTierByEmail(hostEmail);
  const guestPassInfo = await getGuestPassInfo(hostEmail, hostTier || undefined);
  let guestPassesRemaining = guestPassInfo.remaining;
  
  const hostTierLimits = hostTier ? await getTierLimits(hostTier) : null;
  const hostDailyAllowance = options?.resourceType === 'conference_room'
    ? (hostTierLimits?.daily_conf_room_minutes ?? 0)
    : (hostTierLimits?.daily_sim_minutes ?? 0);
  const hostUnlimitedAccess = hostTierLimits?.unlimited_access ?? false;
  
  const hostUsedMinutesToday = await getDailyUsageFromLedger(
    hostEmail,
    sessionDate,
    options?.excludeSessionId,
    options?.resourceType
  );
  
  let hostOverageFee = 0;
  let hostOverageMinutes = 0;
  
  if (!hostUnlimitedAccess && hostDailyAllowance < 999) {
    const hostTotalMinutesAfterSession = hostUsedMinutesToday + ownerAllocatedMinutes;
    const hostOverageResult = calculateOverageFee(hostTotalMinutesAfterSession, hostDailyAllowance);
    const hostPriorOverage = calculateOverageFee(hostUsedMinutesToday, hostDailyAllowance);
    
    hostOverageMinutes = Math.max(0, hostOverageResult.overageMinutes - hostPriorOverage.overageMinutes);
    hostOverageFee = Math.max(0, hostOverageResult.overageFee - hostPriorOverage.overageFee);
  }
  
  // Use proper allocation helper to distribute remainder minutes correctly for non-owner participants
  const allocations = computeUsageAllocation(sessionDuration, participants, {
    declaredSlots: effectivePlayerCount
  });
  const allocationMap = new Map(allocations.map((a, idx) => [idx, a]));
  
  for (let idx = 0; idx < participants.length; idx++) {
    const participant = participants[idx];
    const allocation = allocationMap.get(idx)!;
    let billing: ParticipantBilling;
    
    if (participant.participantType === 'guest') {
      let guestFee = PRICING.GUEST_FEE_DOLLARS;
      let guestPassUsed = false;
      
      const isPlaceholderGuest = /^Guest \d+$/i.test(participant.displayName || '');
      const isRealNamedGuest = participant.guestId || !isPlaceholderGuest;
      if (isRealNamedGuest && guestPassInfo.hasGuestPassBenefit && guestPassesRemaining > 0) {
        guestPassUsed = true;
        guestPassesRemaining--;
        guestPassesUsed++;
        guestFee = 0;
      }
      
      billing = {
        guestId: participant.guestId,
        displayName: participant.displayName,
        participantType: 'guest',
        tierName: null,
        minutesAllocated: allocation.minutesAllocated,
        dailyAllowance: 0,
        usedMinutesToday: 0,
        remainingMinutesBefore: 0,
        overageMinutes: 0,
        overageFee: 0,
        guestFee,
        guestPassUsed,
        totalFee: guestFee
      };
      
      totalGuestFees += guestFee;
    } else if (participant.participantType === 'owner') {
      const resolvedHostEmail = await resolveToEmail(hostEmail);
      const hostRemainingBefore = hostUnlimitedAccess || hostDailyAllowance >= 999
        ? 999
        : Math.max(0, hostDailyAllowance - hostUsedMinutesToday);
      
      billing = {
        userId: participant.userId,
        email: resolvedHostEmail,
        displayName: participant.displayName,
        participantType: 'owner',
        tierName: hostTier,
        minutesAllocated: ownerAllocatedMinutes,
        dailyAllowance: hostDailyAllowance,
        usedMinutesToday: hostUsedMinutesToday,
        remainingMinutesBefore: hostRemainingBefore,
        overageMinutes: hostOverageMinutes,
        overageFee: hostOverageFee,
        guestFee: 0,
        guestPassUsed: false,
        totalFee: hostOverageFee
      };
      
      totalOverageFees += hostOverageFee;
    } else {
      const memberEmail = await resolveToEmail(participant.email || participant.userId);
      const tierName = await getMemberTierByEmail(memberEmail);
      const tierLimits = tierName ? await getTierLimits(tierName) : null;
      const dailyAllowance = options?.resourceType === 'conference_room'
        ? (tierLimits?.daily_conf_room_minutes ?? 0)
        : (tierLimits?.daily_sim_minutes ?? 0);
      const unlimitedAccess = tierLimits?.unlimited_access ?? false;
      
      const usedMinutesToday = await getDailyUsageFromLedger(
        memberEmail,
        sessionDate,
        options?.excludeSessionId,
        options?.resourceType
      );
      
      const remainingMinutesBefore = unlimitedAccess || dailyAllowance >= 999
        ? 999
        : Math.max(0, dailyAllowance - usedMinutesToday);
      
      const minutesAllocated = allocation.minutesAllocated;
      
      let overageMinutes = 0;
      let overageFee = 0;
      
      if (!unlimitedAccess && dailyAllowance < 999) {
        const totalMinutesAfterSession = usedMinutesToday + minutesAllocated;
        const overageResult = calculateOverageFee(totalMinutesAfterSession, dailyAllowance);
        const priorOverage = calculateOverageFee(usedMinutesToday, dailyAllowance);
        
        overageMinutes = Math.max(0, overageResult.overageMinutes - priorOverage.overageMinutes);
        overageFee = Math.max(0, overageResult.overageFee - priorOverage.overageFee);
      }
      
      billing = {
        userId: participant.userId,
        email: memberEmail,
        displayName: participant.displayName,
        participantType: 'member',
        tierName,
        minutesAllocated,
        dailyAllowance,
        usedMinutesToday,
        remainingMinutesBefore,
        overageMinutes,
        overageFee,
        guestFee: 0,
        guestPassUsed: false,
        totalFee: overageFee
      };
      
      totalOverageFees += overageFee;
    }
    
    billingBreakdown.push(billing);
  }
  
  return {
    sessionDuration,
    participantCount: participants.length,
    guestCount,
    billingBreakdown,
    totalOverageFees,
    totalGuestFees,
    totalFees: totalOverageFees + totalGuestFees,
    guestPassesUsed,
    guestPassesAvailable: guestPassInfo.remaining
  };
}

export interface GuestTimeAssignment {
  hostEmail: string;
  guestMinutes: number;
  totalHostMinutes: number;
  overageFee: number;
  guestFee: number;
  guestPassUsed: boolean;
}

export async function assignGuestTimeToHost(
  hostEmail: string,
  guestCount: number,
  sessionDuration: number,
  existingHostMinutes: number = 0
): Promise<GuestTimeAssignment> {
  try {
    const tier = await getMemberTierByEmail(hostEmail);
    const tierLimits = tier ? await getTierLimits(tier) : null;
    const dailyAllowance = tierLimits?.daily_sim_minutes ?? 0;
    const unlimitedAccess = tierLimits?.unlimited_access ?? false;
    
    const guestPassInfo = await getGuestPassInfo(hostEmail, tier || undefined);
    
    let guestFee = 0;
    let guestPassUsed = false;
    
    for (let i = 0; i < guestCount; i++) {
      if (guestPassInfo.hasGuestPassBenefit && guestPassInfo.remaining > i) {
        guestPassUsed = true;
      } else {
        guestFee += PRICING.GUEST_FEE_DOLLARS;
      }
    }
    
    const totalMinutes = existingHostMinutes + sessionDuration;
    
    let overageFee = 0;
    if (!unlimitedAccess && dailyAllowance < 999) {
      const overageResult = calculateOverageFee(totalMinutes, dailyAllowance);
      const priorOverage = calculateOverageFee(existingHostMinutes, dailyAllowance);
      overageFee = Math.max(0, overageResult.overageFee - priorOverage.overageFee);
    }
    
    return {
      hostEmail,
      guestMinutes: sessionDuration,
      totalHostMinutes: totalMinutes,
      overageFee,
      guestFee,
      guestPassUsed
    };
  } catch (error: unknown) {
    logger.error('[assignGuestTimeToHost] Error:', { error });
    throw error;
  }
}

export function computeTotalSessionCost(
  allocations: UsageAllocation[],
  tierAllowances: Map<string, number>
): number {
  let totalCost = 0;
  
  for (const allocation of allocations) {
    if (allocation.participantType === 'guest') {
      continue;
    }
    
    if (allocation.userId) {
      const allowance = tierAllowances.get(allocation.userId) ?? 0;
      const overage = calculateOverageFee(allocation.minutesAllocated, allowance);
      totalCost += overage.overageFee;
    }
  }
  
  return totalCost;
}

export function formatOverageFee(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatOverageFeeFromDollars(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

export const OVERAGE_RATE_PER_30_MIN = PRICING.OVERAGE_RATE_DOLLARS;
export const OVERAGE_RATE_PER_HOUR = PRICING.OVERAGE_RATE_DOLLARS * 2;
export const FLAT_GUEST_FEE = PRICING.GUEST_FEE_DOLLARS;

export interface RecalculationResult {
  sessionId: number;
  billingResult: SessionBillingResult;
  ledgerUpdated: boolean;
  participantsUpdated: number;
}

export async function recalculateSessionFees(
  sessionId: number
): Promise<RecalculationResult> {
  try {
    // Query raw start_time and end_time as TIME strings to handle cross-midnight sessions properly
    const sessionResult = await pool.query(
      `SELECT bs.id, bs.session_date, bs.start_time::text, bs.end_time::text,
              br.user_email as host_email, br.declared_player_count,
              r.type as resource_type
       FROM booking_sessions bs
       LEFT JOIN booking_requests br ON br.session_id = bs.id
       LEFT JOIN resources r ON bs.resource_id = r.id
       WHERE bs.id = $1`,
      [sessionId]
    );
    
    if (sessionResult.rows.length === 0) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    const session = sessionResult.rows[0];
    const sessionDate = session.session_date;
    
    // Calculate duration manually to handle cross-midnight sessions
    // start_time and end_time are TIME types stored as 'HH:MM:SS'
    const startTimeParts = session.start_time.split(':').map(Number);
    const endTimeParts = session.end_time.split(':').map(Number);
    const startMinutes = startTimeParts[0] * 60 + startTimeParts[1];
    let endMinutes = endTimeParts[0] * 60 + endTimeParts[1];
    
    // Handle cross-midnight: if end_time < start_time, add 24 hours to end
    if (endMinutes < startMinutes) {
      endMinutes += 24 * 60; // Add 24 hours worth of minutes
    }
    
    const sessionDuration = Math.round(endMinutes - startMinutes) || 60;
    const hostEmail = session.host_email;
    
    const participantsResult = await pool.query(
      `SELECT bp.id, bp.user_id, bp.guest_id, bp.display_name, bp.participant_type,
              u.email as member_email
       FROM booking_participants bp
       LEFT JOIN users u ON bp.user_id = u.id
       WHERE bp.session_id = $1
       ORDER BY 
         CASE bp.participant_type 
           WHEN 'owner' THEN 1 
           WHEN 'member' THEN 2 
           WHEN 'guest' THEN 3 
         END`,
      [sessionId]
    );
    
    const participants: Participant[] = participantsResult.rows.map(p => ({
      userId: p.user_id,
      email: p.member_email || p.user_id,
      guestId: p.guest_id,
      participantType: p.participant_type as 'owner' | 'member' | 'guest',
      displayName: p.display_name
    }));
    
    const declaredPlayerCount = session.declared_player_count || participants.length || 1;
    const resourceType = session.resource_type;
    const billingResult = await calculateFullSessionBilling(
      sessionDate,
      sessionDuration,
      participants,
      hostEmail || participants.find(p => p.participantType === 'owner')?.email || '',
      declaredPlayerCount,
      { excludeSessionId: sessionId, resourceType }
    );
    
    const client = await pool.connect();
    let participantsUpdated = 0;
    
    try {
      await client.query('BEGIN');
      
      await client.query(`DELETE FROM usage_ledger WHERE session_id = $1`, [sessionId]);
      
      const resolvedBillings = await Promise.all(
        billingResult.billingBreakdown.map(async (billing) => {
          if (billing.participantType === 'guest') {
            return billing.guestFee > 0 ? {
              memberId: hostEmail || 'guest',
              minutesCharged: billing.minutesAllocated,
              overageFee: 0,
              guestFee: billing.guestFee,
              tierAtBooking: null as string | null,
            } : null;
          } else {
            const resolvedEmail = await resolveToEmail(billing.email || billing.userId);
            return {
              memberId: resolvedEmail,
              minutesCharged: billing.minutesAllocated,
              overageFee: billing.overageFee,
              guestFee: 0,
              tierAtBooking: billing.tierName,
            };
          }
        })
      );

      const validBillings = resolvedBillings.filter(b => b !== null);
      if (validBillings.length > 0) {
        const memberIds = validBillings.map(b => b.memberId);
        const minutesCharged = validBillings.map(b => b.minutesCharged);
        const overageFees = validBillings.map(b => b.overageFee);
        const guestFees = validBillings.map(b => b.guestFee);
        const tiersAtBooking = validBillings.map(b => b.tierAtBooking);

        await client.query(`
          INSERT INTO usage_ledger (session_id, member_id, minutes_charged, overage_fee, guest_fee, tier_at_booking, payment_method, source)
          SELECT $1, member_id, minutes_charged, overage_fee, guest_fee, tier_at_booking, 'unpaid', 'recalculation'
          FROM unnest($2::text[], $3::int[], $4::numeric[], $5::numeric[], $6::text[])
          AS t(member_id, minutes_charged, overage_fee, guest_fee, tier_at_booking)
        `, [sessionId, memberIds, minutesCharged, overageFees, guestFees, tiersAtBooking]);
      }
      participantsUpdated = validBillings.length;
      
      await client.query('COMMIT');
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
    logger.info('[recalculateSessionFees] Session fees recalculated', {
      extra: {
        sessionId,
        participantsUpdated,
        totalFees: billingResult.totalFees
      }
    });
    
    return {
      sessionId,
      billingResult,
      ledgerUpdated: true,
      participantsUpdated
    };
  } catch (error: unknown) {
    logger.error('[recalculateSessionFees] Error:', { error });
    throw error;
  }
}

export { PRICING };
