import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getMemberTierByEmail, getTierLimits } from '../tierService';
import { getDailyUsageFromLedger, getGuestPassInfo, calculateOverageFee } from '../bookingService/usageCalculator';
import { MemberService, isEmail, normalizeEmail, isUUID } from '../memberService';
import { FeeBreakdown, FeeComputeParams, FeeLineItem } from '../../../shared/models/billing';
import { logger } from '../logger';
import { PRICING } from './pricingConfig';

type SqlQueryParam = string | number | boolean | null | Date | string[];

export function getEffectivePlayerCount(declared: number | undefined, actual: number): number {
  const declaredCount = declared && declared > 0 ? declared : 1;
  return Math.max(declaredCount, actual, 1);
}

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

interface SessionData {
  sessionId: number;
  bookingId: number;
  sessionDate: string;
  startTime: string;
  sessionDuration: number;
  declaredPlayerCount: number;
  hostEmail: string;
  isConferenceRoom: boolean;
  participants: Array<{
    participantId: number;
    userId?: string;
    guestId?: number;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
  }>;
}

async function loadSessionData(sessionId?: number, bookingId?: number): Promise<SessionData | null> {
  if (!sessionId && !bookingId) return null;
  
  try {
    let sessionResult;
    
    if (sessionId) {
      sessionResult = await db.execute(sql`
        SELECT 
          bs.id as session_id,
          br.id as booking_id,
          bs.session_date,
          COALESCE(bs.start_time, br.start_time) as start_time,
          GREATEST(
            COALESCE(EXTRACT(EPOCH FROM (bs.end_time - bs.start_time)) / 60, 0),
            COALESCE(br.duration_minutes, 0)
          )::int as duration_minutes,
          COALESCE(br.declared_player_count, br.trackman_player_count, br.guest_count + 1, 1) as declared_player_count,
          br.user_email as host_email,
          COALESCE(r.type, 'simulator') as resource_type
        FROM booking_sessions bs
        JOIN booking_requests br ON br.session_id = bs.id
        LEFT JOIN resources r ON br.resource_id = r.id
        WHERE bs.id = ${sessionId}
        ORDER BY br.duration_minutes DESC
        LIMIT 1
      `);
    } else {
      sessionResult = await db.execute(sql`
        SELECT 
          bs.id as session_id,
          br.id as booking_id,
          COALESCE(bs.session_date, br.request_date) as session_date,
          br.start_time,
          GREATEST(
            COALESCE(EXTRACT(EPOCH FROM (bs.end_time - bs.start_time)) / 60, 0),
            COALESCE(br.duration_minutes, 0)
          )::int as duration_minutes,
          COALESCE(br.declared_player_count, br.trackman_player_count, br.guest_count + 1, 1) as declared_player_count,
          br.user_email as host_email,
          COALESCE(r.type, 'simulator') as resource_type
        FROM booking_requests br
        LEFT JOIN booking_sessions bs ON br.session_id = bs.id
        LEFT JOIN resources r ON br.resource_id = r.id
        WHERE br.id = ${bookingId}
        LIMIT 1
      `);
    }
    if (sessionResult.rows.length === 0) return null;
    
    const session = sessionResult.rows[0];
    
    let participants: Array<{
      participantId: number | undefined;
      userId: string | null;
      guestId?: number | null;
      email: string | null;
      displayName: string;
      participantType: 'owner' | 'member' | 'guest';
      usedGuestPass?: boolean;
    }> = [];
    
    // Try to load participants from session first
    if (session.session_id) {
      const participantsResult = await db.execute(
        sql`SELECT 
          bp.id as participant_id,
          bp.user_id,
          bp.guest_id,
          u.email,
          bp.display_name,
          bp.participant_type,
          bp.used_guest_pass
         FROM booking_participants bp
         LEFT JOIN users u ON bp.user_id = u.id
         WHERE bp.session_id = ${session.session_id}
         ORDER BY bp.participant_type = 'owner' DESC, bp.created_at ASC`
      );
      participants = participantsResult.rows.map(row => ({
        participantId: row.participant_id,
        userId: row.user_id,
        guestId: row.guest_id,
        email: row.email,
        displayName: row.display_name,
        participantType: row.participant_type as 'owner' | 'member' | 'guest',
        usedGuestPass: row.used_guest_pass ?? undefined
      }));
    }
    
    // If no participants from session, try booking_participants via booking_requests.session_id
    if (participants.length === 0 && session.booking_id) {
      const bpFallbackResult = await db.execute(
        sql`SELECT 
          bp.id as participant_id,
          bp.user_id,
          bp.guest_id,
          u.email,
          bp.display_name,
          bp.participant_type,
          bp.used_guest_pass
         FROM booking_participants bp
         JOIN booking_requests br ON br.session_id = bp.session_id
         LEFT JOIN users u ON bp.user_id = u.id
         WHERE br.id = ${session.booking_id}
         ORDER BY bp.participant_type = 'owner' DESC, bp.created_at ASC`
      );
      participants = bpFallbackResult.rows.map(row => ({
        participantId: row.participant_id,
        userId: row.user_id,
        guestId: row.guest_id,
        email: row.email,
        displayName: row.display_name,
        participantType: row.participant_type as 'owner' | 'member' | 'guest',
        usedGuestPass: row.used_guest_pass ?? undefined
      }));
    }
    
    // If still no participants, create one for the host
    if (participants.length === 0) {
      participants = [{
        participantId: undefined,
        userId: null,
        email: session.host_email,
        displayName: session.host_email,
        participantType: 'owner'
      }];
    }
    
    return {
      sessionId: session.session_id,
      bookingId: session.booking_id,
      sessionDate: session.session_date,
      startTime: session.start_time,
      sessionDuration: session.duration_minutes,
      declaredPlayerCount: parseInt(session.declared_player_count) || 1,
      hostEmail: session.host_email,
      isConferenceRoom: session.resource_type === 'conference_room',
      participants
    };
  } catch (error: unknown) {
    logger.error('[UnifiedFeeService] Error loading session data:', { error });
    return null;
  }
}

export async function computeFeeBreakdown(params: FeeComputeParams): Promise<FeeBreakdown> {
  let sessionDate: string;
  let startTime: string | undefined;
  let sessionDuration: number;
  let declaredPlayerCount: number;
  let hostEmail: string;
  let isConferenceRoom: boolean;
  let participants: Array<{
    participantId?: number;
    userId?: string;
    guestId?: number | null;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
    usedGuestPass?: boolean;
  }>;
  let sessionId: number | undefined;
  let currentBookingId: number | undefined;
  
  if (params.sessionId || params.bookingId) {
    const sessionData = await loadSessionData(params.sessionId, params.bookingId);
    if (!sessionData) {
      throw new Error(`Session or booking not found: sessionId=${params.sessionId}, bookingId=${params.bookingId}`);
    }
    // Rule 15a Step 1: Cancelled/declined bookings always have $0 fees
    const statusCheck = await db.execute(
      sql`SELECT status FROM booking_requests WHERE id = ${sessionData.bookingId}`
    );
    const bookingStatus = statusCheck.rows[0]?.status;
    if (['cancelled', 'declined', 'cancellation_pending'].includes(bookingStatus)) {
      logger.info('[FeeBreakdown] Booking is cancelled/declined — returning $0', {
        extra: { bookingId: sessionData.bookingId, status: bookingStatus }
      });
      return {
        totals: { totalCents: 0, overageCents: 0, guestCents: 0, guestPassesUsed: 0, guestPassesAvailable: 0 },
        participants: [],
        metadata: {
          effectivePlayerCount: 0,
          declaredPlayerCount: 0,
          actualPlayerCount: 0,
          sessionDuration: 0,
          sessionDate: sessionData.sessionDate,
          source: params.source
        }
      };
    }

    sessionDate = sessionData.sessionDate;
    startTime = sessionData.startTime;
    sessionDuration = sessionData.sessionDuration;
    declaredPlayerCount = sessionData.declaredPlayerCount;
    hostEmail = sessionData.hostEmail;
    isConferenceRoom = params.isConferenceRoom ?? sessionData.isConferenceRoom;
    participants = sessionData.participants;
    sessionId = sessionData.sessionId;
    currentBookingId = sessionData.bookingId;
  } else {
    if (!params.sessionDate || !params.sessionDuration || !params.hostEmail || !params.participants) {
      throw new Error('Missing required parameters for fee calculation preview');
    }
    sessionDate = params.sessionDate;
    startTime = params.startTime;
    sessionDuration = params.sessionDuration;
    declaredPlayerCount = params.declaredPlayerCount || 1;
    hostEmail = params.hostEmail;
    isConferenceRoom = params.isConferenceRoom ?? false;
    participants = params.participants;
    sessionId = undefined;
    currentBookingId = params.bookingId;
  }
  
  const actualPlayerCount = participants.length;
  const effectivePlayerCount = getEffectivePlayerCount(declaredPlayerCount, actualPlayerCount);
  
  // For conference rooms, use full duration for owner (no splitting)
  // For simulators, divide duration by player count
  const minutesPerParticipant = isConferenceRoom 
    ? sessionDuration 
    : Math.floor(sessionDuration / effectivePlayerCount);
  const remainderMinutes = isConferenceRoom ? 0 : (sessionDuration % effectivePlayerCount);
  
  const resolvedHostEmail = await resolveToEmail(hostEmail);
  const hostTier = await getMemberTierByEmail(resolvedHostEmail);
  const hostTierLimits = hostTier ? await getTierLimits(hostTier) : null;
  const guestPassInfo = await getGuestPassInfo(resolvedHostEmail, hostTier || undefined);
  
  let guestPassesRemaining = guestPassInfo.remaining;
  const guestPassesAvailable = guestPassInfo.remaining;
  
  // Pre-fetch participant identifiers (both UUID and email)
  const participantIdentifiers: Array<{ participantId: number | undefined; userId: string | null; email: string | null }> = [];
  const resolvedEmails = await Promise.all(
    participants.map(p => resolveToEmail(p.email || p.userId))
  );
  resolvedEmails.forEach((email, idx) => {
    const p = participants[idx];
    participantIdentifiers.push({
      participantId: p.participantId,
      userId: p.userId || null,
      email: email || null
    });
  });

  // Collect all possible identifiers for usage lookup (both UUIDs and emails)
  const allIdentifiers: string[] = [];
  const emailList: string[] = [];
  for (const pi of participantIdentifiers) {
    if (pi.userId) allIdentifiers.push(pi.userId.toLowerCase());
    if (pi.email) {
      allIdentifiers.push(pi.email.toLowerCase());
      emailList.push(pi.email);
    }
  }

  // Batch fetch member tiers, roles, and membership status
  // Staff/admin users are always treated as having unlimited access ($0 fees)
  const tierMap = new Map<string, string>();
  const roleMap = new Map<string, string>();
  if (emailList.length > 0) {
    const tiersResult = await db.execute(
      sql`SELECT LOWER(email) as email, tier, role, membership_status FROM users WHERE LOWER(email) = ANY(${emailList.map(e => e.toLowerCase())}::text[])`
    );
    tiersResult.rows.forEach(r => {
      if (r.tier && ['active', 'trialing', 'past_due'].includes(r.membership_status)) {
        tierMap.set(r.email, r.tier);
      }
      if (r.role) roleMap.set(r.email, r.role);
    });
  }

  const isStaffRole = (email: string): boolean => {
    const role = roleMap.get(email.toLowerCase());
    return role === 'staff' || role === 'admin' || role === 'golf_instructor';
  };

  // Batch fetch daily usage - use booking_requests for preview mode (no sessionId)
  // because usage_ledger is only populated after session creation
  const usageMap = new Map<string, number>();
  const excludeId = params.excludeSessionFromUsage ? sessionId : undefined;
  const isPreviewMode = !sessionId && params.source === 'preview';
  
  if (allIdentifiers.length > 0) {
    if (isPreviewMode) {
      // For preview mode, query booking_requests directly (includes pending/approved/attended)
      // IMPORTANT: Only count bookings that START EARLIER than the current booking
      // This ensures the earliest booking uses the daily allowance first, and later bookings
      // accumulate overage correctly. This prevents charging overage on BOTH bookings
      // when a member has multiple bookings on the same day.
      // Note: We use UNION (not UNION ALL) and deduplicate by booking_id to prevent double-counting
      
      // If we have a bookingId but no startTime, fetch it from the database
      let effectiveStartTime = startTime;
      if (!startTime && currentBookingId) {
        const startTimeResult = await db.execute(
          sql`SELECT start_time FROM booking_requests WHERE id = ${currentBookingId}`
        );
        if (startTimeResult.rows.length > 0 && startTimeResult.rows[0].start_time) {
          effectiveStartTime = startTimeResult.rows[0].start_time;
        }
      }
      
      // Build the time filter - only count usage from earlier bookings
      const hasTimeFilter = effectiveStartTime !== undefined;
      const hasBookingIdFilter = currentBookingId !== undefined;
      
      // Filter by resource type to separate simulator vs conference room usage
      const resourceTypeFilter = isConferenceRoom ? 'conference_room' : 'simulator';
      
      const emailsLower = emailList.map(e => e.toLowerCase());
      
      const timeFilterFrag = hasTimeFilter
        ? sql`AND (
             COALESCE(br.start_time, '00:00:00') < ${effectiveStartTime} 
             OR (COALESCE(br.start_time, '00:00:00') = ${effectiveStartTime} AND br.id < COALESCE(${currentBookingId || 0}, 0))
           )`
        : hasBookingIdFilter
          ? sql`AND br.id != ${currentBookingId}`
          : sql``;
      
      const resourceTypeFrag = sql`AND EXISTS (SELECT 1 FROM resources r WHERE r.id = br.resource_id AND r.type = ${resourceTypeFilter})`;
      
      const usageResult = await db.execute(sql`
        WITH owned_bookings AS (
          SELECT LOWER(user_email) as identifier, 
                 br.id as booking_id,
                 FLOOR(duration_minutes::float / GREATEST(1, COALESCE(declared_player_count, 1))) as minutes_share
          FROM booking_requests br
          WHERE LOWER(user_email) = ANY(${emailsLower}::text[])
            AND request_date = ${sessionDate}
            AND status IN ('pending', 'approved', 'attended')
            ${timeFilterFrag}
            ${resourceTypeFrag}
        ),
        member_bookings AS (
          SELECT LOWER(u.email) as identifier,
                 br.id as booking_id,
                 FLOOR(br.duration_minutes::float / GREATEST(1, COALESCE(br.declared_player_count, 1))) as minutes_share
          FROM booking_participants bp
          JOIN booking_sessions bs ON bp.session_id = bs.id
          JOIN booking_requests br ON br.session_id = bs.id
          JOIN users u ON bp.user_id = u.id
          WHERE LOWER(u.email) = ANY(${emailsLower}::text[])
            AND br.request_date = ${sessionDate}
            AND br.status IN ('pending', 'approved', 'attended')
            AND LOWER(u.email) != LOWER(br.user_email)
            ${timeFilterFrag}
            ${resourceTypeFrag}
        ),
        session_participant_bookings AS (
          SELECT LOWER(u.email) as identifier,
                 br.id as booking_id,
                 FLOOR(br.duration_minutes::float / GREATEST(1, COALESCE(br.declared_player_count, 1))) as minutes_share
          FROM booking_participants bp
          JOIN booking_sessions bs ON bp.session_id = bs.id
          JOIN booking_requests br ON br.session_id = bs.id
          JOIN users u ON bp.user_id = u.id
          WHERE LOWER(u.email) = ANY(${emailsLower}::text[])
            AND br.request_date = ${sessionDate}
            AND br.status IN ('pending', 'approved', 'attended')
            AND LOWER(u.email) != LOWER(br.user_email)
            ${timeFilterFrag}
            ${resourceTypeFrag}
        ),
        all_usage AS (
          SELECT DISTINCT ON (identifier, booking_id) identifier, booking_id, minutes_share 
          FROM (
            SELECT identifier, booking_id, minutes_share FROM owned_bookings
            UNION ALL
            SELECT identifier, booking_id, minutes_share FROM member_bookings
            UNION ALL
            SELECT identifier, booking_id, minutes_share FROM session_participant_bookings
          ) combined
        )
        SELECT identifier, COALESCE(SUM(minutes_share), 0) as used
        FROM all_usage
        GROUP BY identifier
      `);
      (usageResult.rows as Array<Record<string, unknown>>).forEach(r => usageMap.set(r.identifier as string, parseInt(String(r.used)) || 0));
    } else {
      // Filter by resource type to separate simulator vs conference room usage
      const resourceTypeFilter = isConferenceRoom ? 'conference_room' : 'simulator';
      
      // IMPORTANT: Apply chronological ordering so the earliest booking of the day
      // uses the daily allowance first. Only count usage from bookings that start
      // EARLIER than the current booking. Without this, a later booking's usage_ledger
      // entry can make an earlier booking appear to have overage.
      const hasTimeFilter = startTime !== undefined;
      
      const excludeClauseLedgerFrag = excludeId 
        ? sql`AND ul.session_id != ${excludeId}` 
        : sql``;
      const excludeClauseGhostFrag = excludeId 
        ? sql`AND (
                 br.session_id IS NULL
                 OR (br.session_id != ${excludeId} AND NOT EXISTS (SELECT 1 FROM usage_ledger ul WHERE ul.session_id = br.session_id))
               )`
        : sql`AND (
                 br.session_id IS NULL
                 OR NOT EXISTS (SELECT 1 FROM usage_ledger ul WHERE ul.session_id = br.session_id)
               )`;
      
      const timeFilterLedgerFrag = hasTimeFilter 
        ? sql`AND (
                 COALESCE((SELECT MIN(br2.start_time) FROM booking_requests br2 WHERE br2.session_id = bs.id), '00:00:00') < ${startTime}
                 OR (
                   COALESCE((SELECT MIN(br2.start_time) FROM booking_requests br2 WHERE br2.session_id = bs.id), '00:00:00') = ${startTime}
                   AND COALESCE((SELECT MIN(br2.id) FROM booking_requests br2 WHERE br2.session_id = bs.id), 0) < ${currentBookingId || 0}
                 )
               )`
        : sql``;
      
      const timeFilterGhostFrag = hasTimeFilter
        ? sql`AND (
                 COALESCE(br.start_time, '00:00:00') < ${startTime}
                 OR (COALESCE(br.start_time, '00:00:00') = ${startTime} AND br.id < ${currentBookingId || 0})
               )`
        : sql``;
      
      const usageResult = await db.execute(sql`WITH ledger_usage AS (
             SELECT LOWER(ul.member_id) as identifier, COALESCE(SUM(ul.minutes_charged), 0) as mins
             FROM usage_ledger ul
             JOIN booking_sessions bs ON ul.session_id = bs.id
             JOIN resources r ON bs.resource_id = r.id
             WHERE LOWER(ul.member_id) = ANY(${allIdentifiers}::text[])
               AND bs.session_date = ${sessionDate}
               AND r.type = ${resourceTypeFilter}
               ${excludeClauseLedgerFrag}
               ${timeFilterLedgerFrag}
             GROUP BY LOWER(ul.member_id)
           ),
           ghost_usage AS (
             SELECT LOWER(br.user_email) as identifier, 
                    COALESCE(SUM(FLOOR(br.duration_minutes::float / GREATEST(1, COALESCE(br.declared_player_count, 1)))), 0) as mins
             FROM booking_requests br
             WHERE LOWER(br.user_email) = ANY(${allIdentifiers}::text[])
               AND br.request_date = ${sessionDate}
               AND br.status IN ('approved', 'confirmed', 'attended')
               ${excludeClauseGhostFrag}
               AND EXISTS (SELECT 1 FROM resources r WHERE r.id = br.resource_id AND r.type = ${resourceTypeFilter})
               ${timeFilterGhostFrag}
             GROUP BY LOWER(br.user_email)
           )
           SELECT identifier, COALESCE(SUM(mins), 0) as used
           FROM (
             SELECT * FROM ledger_usage
             UNION ALL
             SELECT * FROM ghost_usage
           ) combined
           GROUP BY identifier`);
      (usageResult.rows as Array<Record<string, unknown>>).forEach(r => usageMap.set(r.identifier as string, parseInt(String(r.used)) || 0));
    }
  }

  // Helper function to look up usage by BOTH userId and email
  function getUsageForParticipant(userId: string | null, email: string | null): number {
    if (userId && usageMap.has(userId.toLowerCase())) {
      return usageMap.get(userId.toLowerCase())!;
    }
    if (email && usageMap.has(email.toLowerCase())) {
      return usageMap.get(email.toLowerCase())!;
    }
    return 0;
  }
  
  const lineItems: FeeLineItem[] = [];
  let totalOverageCents = 0;
  let totalGuestCents = 0;
  let guestPassesUsed = 0;
  
  let participantIdx = 0;
  for (const participant of participants) {
    const lineItem: FeeLineItem = {
      participantId: participant.participantId,
      userId: participant.userId,
      displayName: participant.displayName,
      participantType: participant.participantType,
      minutesAllocated: 0,
      overageCents: 0,
      guestCents: 0,
      totalCents: 0,
      guestPassUsed: false
    };
    
    if (participant.participantType === 'guest') {
      // Conference rooms don't have guests - skip guest fee logic
      if (isConferenceRoom) {
        lineItem.minutesAllocated = 0;
        lineItem.guestCents = 0;
        lineItem.totalCents = 0;
        lineItems.push(lineItem);
        participantIdx++;
        continue;
      }
      
      lineItem.minutesAllocated = minutesPerParticipant;
      
      // "Pro in the Slot" rule: Staff/admin added as a guest are always $0
      const guestEmail = participant.email ? participant.email.toLowerCase() : '';
      if (guestEmail && isStaffRole(guestEmail)) {
        lineItem.guestCents = 0;
        lineItem.totalCents = 0;
        lineItem.isStaff = true;
        logger.info('[FeeBreakdown] Staff in guest slot — $0 fee (Pro in the Slot rule)', {
          extra: { guestEmail, participantId: participant.participantId }
        });
        lineItems.push(lineItem);
        participantIdx++;
        continue;
      }
      
      // Only charge guest fee if participant has NO user_id (i.e., not a member)
      // Members incorrectly marked as guests should not be charged guest fees
      // This matches the logic in feeCalculator.ts for consistency
      const isActualGuest = !participant.userId;
      const hasRealGuestId = !!participant.guestId;
      const isPlaceholderGuest = /^Guest \d+$/i.test(participant.displayName || '');
      const isRealNamedGuest = isActualGuest && (hasRealGuestId || !isPlaceholderGuest);
      
      if (!isActualGuest) {
        // Member mistakenly marked as guest - don't charge guest fee
        lineItem.guestCents = 0;
        logger.info('[FeeBreakdown] Skipping guest fee for member marked as guest', {
          extra: { participantId: participant.participantId, userId: participant.userId }
        });
      } else if (participant.usedGuestPass === true) {
        lineItem.guestPassUsed = true;
        guestPassesUsed++;
        lineItem.guestCents = 0;
      } else if (isRealNamedGuest && guestPassInfo.hasGuestPassBenefit && guestPassesRemaining > 0 && participant.usedGuestPass !== false) {
        lineItem.guestPassUsed = true;
        guestPassesRemaining--;
        guestPassesUsed++;
        lineItem.guestCents = 0;
      } else {
        lineItem.guestCents = PRICING.GUEST_FEE_CENTS;
        totalGuestCents += PRICING.GUEST_FEE_CENTS;
      }
      
      lineItem.totalCents = lineItem.guestCents;
    } else if (participant.participantType === 'owner') {
      lineItem.minutesAllocated = minutesPerParticipant + remainderMinutes;
      
      const pi = participantIdentifiers[participantIdx];
      const ownerEmail = pi?.email || hostEmail;

      // "Staff is Free" rule: Staff/admin owners always have unlimited access
      if (isStaffRole(ownerEmail)) {
        lineItem.isStaff = true;
        lineItem.tierName = 'Staff';
        lineItem.overageCents = 0;
        lineItem.totalCents = 0;
        logger.info('[FeeBreakdown] Staff owner — $0 fee (Staff is Free rule)', {
          extra: { ownerEmail }
        });
        lineItems.push(lineItem);
        participantIdx++;
        continue;
      }
      // Use batched tier data, fallback to individual query if not found
      let tierName = tierMap.get(ownerEmail.toLowerCase());
      if (!tierName && ownerEmail) {
        tierName = await getMemberTierByEmail(ownerEmail);
      }
      const tierLimits = tierName ? await getTierLimits(tierName) : null;
      // Use conference room minutes for conference room bookings, simulator minutes otherwise
      const dailyAllowance = isConferenceRoom 
        ? (tierLimits?.daily_conf_room_minutes ?? 0)
        : (tierLimits?.daily_sim_minutes ?? 0);
      const unlimitedAccess = tierLimits?.unlimited_access ?? false;
      
      // Use batched usage data - look up by BOTH userId and email
      const usedMinutesToday = getUsageForParticipant(participant.userId || null, ownerEmail);
      
      lineItem.tierName = tierName || undefined;
      lineItem.dailyAllowance = dailyAllowance;
      lineItem.usedMinutesToday = usedMinutesToday;
      
      logger.info('[FeeBreakdown] Owner fee calculation', {
        extra: {
          ownerEmail,
          tierName,
          dailyAllowance,
          unlimitedAccess,
          usedMinutesToday,
          minutesAllocated: minutesPerParticipant + remainderMinutes,
          willCalculateOverage: !unlimitedAccess && dailyAllowance < 999,
          isConferenceRoom
        }
      });
      
      if (!unlimitedAccess && dailyAllowance < 999) {
        const totalAfterSession = usedMinutesToday + minutesPerParticipant + remainderMinutes;
        const overageResult = calculateOverageFee(totalAfterSession, dailyAllowance);
        const priorOverage = calculateOverageFee(usedMinutesToday, dailyAllowance);
        
        const overageMinutes = Math.max(0, overageResult.overageMinutes - priorOverage.overageMinutes);
        const overageFee = Math.max(0, overageResult.overageFee - priorOverage.overageFee);
        
        logger.info('[FeeBreakdown] Overage calculation result', {
          extra: {
            totalAfterSession,
            overageResultMinutes: overageResult.overageMinutes,
            overageResultFee: overageResult.overageFee,
            priorOverageMinutes: priorOverage.overageMinutes,
            priorOverageFee: priorOverage.overageFee,
            finalOverageMinutes: overageMinutes,
            finalOverageFee: overageFee
          }
        });
        
        lineItem.overageCents = Math.round(overageFee * 100);
        totalOverageCents += lineItem.overageCents;
      }
      
      lineItem.totalCents = lineItem.overageCents;
    } else {
      // Conference rooms don't have additional members - only owner matters
      if (isConferenceRoom) {
        lineItem.minutesAllocated = 0;
        lineItem.overageCents = 0;
        lineItem.totalCents = 0;
        lineItems.push(lineItem);
        participantIdx++;
        continue;
      }
      
      lineItem.minutesAllocated = minutesPerParticipant;
      
      const pi = participantIdentifiers[participantIdx];
      const memberEmail = pi?.email || '';

      // "Staff is Free" rule: Staff/admin members added to bookings pay $0
      if (memberEmail && isStaffRole(memberEmail)) {
        lineItem.isStaff = true;
        lineItem.tierName = 'Staff';
        lineItem.overageCents = 0;
        lineItem.totalCents = 0;
        logger.info('[FeeBreakdown] Staff member in slot — $0 fee (Staff is Free rule)', {
          extra: { memberEmail }
        });
        lineItems.push(lineItem);
        participantIdx++;
        continue;
      }
      // Use batched tier data, fallback to individual query if not found
      let tierName = tierMap.get(memberEmail.toLowerCase());
      if (!tierName && memberEmail) {
        tierName = await getMemberTierByEmail(memberEmail);
      }
      const tierLimits = tierName ? await getTierLimits(tierName) : null;
      // Use conference room minutes for conference room bookings, simulator minutes otherwise
      const dailyAllowance = isConferenceRoom 
        ? (tierLimits?.daily_conf_room_minutes ?? 0)
        : (tierLimits?.daily_sim_minutes ?? 0);
      const unlimitedAccess = tierLimits?.unlimited_access ?? false;
      
      // Use batched usage data - look up by BOTH userId and email
      const usedMinutesToday = getUsageForParticipant(participant.userId || null, memberEmail);
      
      lineItem.tierName = tierName || undefined;
      lineItem.dailyAllowance = dailyAllowance;
      lineItem.usedMinutesToday = usedMinutesToday;
      
      if (!unlimitedAccess && dailyAllowance < 999) {
        const totalAfterSession = usedMinutesToday + minutesPerParticipant;
        const overageResult = calculateOverageFee(totalAfterSession, dailyAllowance);
        const priorOverage = calculateOverageFee(usedMinutesToday, dailyAllowance);
        
        const overageMinutes = Math.max(0, overageResult.overageMinutes - priorOverage.overageMinutes);
        const overageFee = Math.max(0, overageResult.overageFee - priorOverage.overageFee);
        
        lineItem.overageCents = Math.round(overageFee * 100);
        totalOverageCents += lineItem.overageCents;
      }
      
      lineItem.totalCents = lineItem.overageCents;
    }
    
    lineItems.push(lineItem);
    participantIdx++;
  }
  
  const actualGuestCount = participants.filter(p => p.participantType === 'guest').length;
  const actualMemberCount = participants.filter(p => p.participantType === 'member').length;
  const ownerCount = participants.filter(p => p.participantType === 'owner').length;
  const emptySlots = Math.max(0, effectivePlayerCount - ownerCount - actualMemberCount - actualGuestCount);

  // Owner absorbs time from both empty slots and guest slots for overage calculation
  const emptySlotMinutes = emptySlots > 0 ? emptySlots * minutesPerParticipant : 0;
  const guestSlotMinutes = actualGuestCount > 0 ? actualGuestCount * minutesPerParticipant : 0;
  const nonMemberMinutes = emptySlotMinutes + guestSlotMinutes;

  if (nonMemberMinutes > 0 && !isConferenceRoom) {
    const ownerLineItem = lineItems.find(li => li.participantType === 'owner');
    if (ownerLineItem && !ownerLineItem.isStaff) {
      ownerLineItem.minutesAllocated += nonMemberMinutes;

      const dailyAllowance = ownerLineItem.dailyAllowance ?? 0;
      const usedMinutesToday = ownerLineItem.usedMinutesToday ?? 0;
      const ownerTierLimits = ownerLineItem.tierName ? await getTierLimits(ownerLineItem.tierName) : null;
      const unlimitedAccess = ownerTierLimits?.unlimited_access ?? false;

      if (!unlimitedAccess && dailyAllowance < 999) {
        const totalAfterSession = usedMinutesToday + ownerLineItem.minutesAllocated;
        const overageResult = calculateOverageFee(totalAfterSession, dailyAllowance);
        const priorOverage = calculateOverageFee(usedMinutesToday, dailyAllowance);

        const overageFee = Math.max(0, overageResult.overageFee - priorOverage.overageFee);

        totalOverageCents -= ownerLineItem.overageCents;
        ownerLineItem.overageCents = Math.round(overageFee * 100);
        ownerLineItem.totalCents = ownerLineItem.overageCents;
        totalOverageCents += ownerLineItem.overageCents;

        logger.info('[FeeBreakdown] Owner overage recalculated with empty slot and guest slot time', {
          extra: {
            emptySlots,
            emptySlotMinutes,
            guestCount: actualGuestCount,
            guestSlotMinutes,
            totalNonMemberMinutes: nonMemberMinutes,
            newMinutesAllocated: ownerLineItem.minutesAllocated,
            totalAfterSession,
            newOverageCents: ownerLineItem.overageCents
          }
        });
      }
    }
  }

  if (emptySlots > 0 && !isConferenceRoom) {
    for (let i = 0; i < emptySlots; i++) {
      const emptyLineItem: FeeLineItem = {
        participantId: undefined,
        userId: undefined,
        displayName: 'Empty Slot',
        participantType: 'guest',
        minutesAllocated: minutesPerParticipant,
        overageCents: 0,
        guestCents: PRICING.GUEST_FEE_CENTS,
        totalCents: PRICING.GUEST_FEE_CENTS,
        guestPassUsed: false
      };

      totalGuestCents += PRICING.GUEST_FEE_CENTS;
      lineItems.push(emptyLineItem);
    }
  }
  
  return {
    totals: {
      totalCents: totalOverageCents + totalGuestCents,
      overageCents: totalOverageCents,
      guestCents: totalGuestCents,
      guestPassesUsed,
      guestPassesAvailable
    },
    participants: lineItems,
    metadata: {
      effectivePlayerCount,
      declaredPlayerCount,
      actualPlayerCount,
      sessionDuration,
      sessionDate,
      source: params.source
    }
  };
}

export async function applyFeeBreakdownToParticipants(
  sessionId: number,
  breakdown: FeeBreakdown
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const idsToUpdate = breakdown.participants
        .filter(p => p.participantId)
        .map(p => p.participantId!);
      const feesToUpdate = breakdown.participants
        .filter(p => p.participantId)
        .map(p => p.totalCents);

      if (idsToUpdate.length > 0) {
        await tx.execute(
          sql`UPDATE booking_participants bp
           SET cached_fee_cents = t.fee
           FROM unnest(${idsToUpdate}::int[], ${feesToUpdate}::int[]) AS t(id, fee)
           WHERE bp.id = t.id`
        );
      }
    });
    logger.info('[UnifiedFeeService] Applied fee breakdown to participants', {
      sessionId,
      participantCount: breakdown.participants.length,
      totalCents: breakdown.totals.totalCents
    });
  } catch (error: unknown) {
    logger.error('[UnifiedFeeService] Error applying fee breakdown:', { error });
    throw error;
  }
}

export async function invalidateCachedFees(
  participantIds: number[],
  reason: string
): Promise<void> {
  if (participantIds.length === 0) return;
  
  try {
    await db.execute(
      sql`UPDATE booking_participants 
       SET cached_fee_cents = 0 
       WHERE id = ANY(${participantIds}::int[])`
    );
    
    logger.info('[UnifiedFeeService] Invalidated cached fees', {
      participantIds,
      reason
    });
  } catch (error: unknown) {
    logger.error('[UnifiedFeeService] Error invalidating cached fees:', { error });
  }
}

export async function recalculateSessionFees(
  sessionId: number,
  source: FeeComputeParams['source']
): Promise<FeeBreakdown> {
  const breakdown = await computeFeeBreakdown({
    sessionId,
    source,
    excludeSessionFromUsage: true
  });
  
  await applyFeeBreakdownToParticipants(sessionId, breakdown);
  
  return breakdown;
}
