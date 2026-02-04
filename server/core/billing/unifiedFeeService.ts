import { pool } from '../db';
import { getMemberTierByEmail, getTierLimits } from '../tierService';
import { getDailyUsageFromLedger, getGuestPassInfo, calculateOverageFee } from '../bookingService/usageCalculator';
import { MemberService, isEmail, normalizeEmail, isUUID } from '../memberService';
import { FeeBreakdown, FeeComputeParams, FeeLineItem } from '../../../shared/models/billing';
import { logger } from '../logger';
import { PRICING } from './pricingConfig';

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
  participants: Array<{
    participantId: number;
    userId?: string;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
  }>;
}

async function loadSessionData(sessionId?: number, bookingId?: number): Promise<SessionData | null> {
  if (!sessionId && !bookingId) return null;
  
  try {
    let query: string;
    let params: any[];
    
    if (sessionId) {
      query = `
        SELECT 
          bs.id as session_id,
          br.id as booking_id,
          bs.session_date,
          br.start_time,
          br.duration_minutes,
          COALESCE(br.declared_player_count, br.trackman_player_count, br.guest_count + 1, 1) as declared_player_count,
          br.user_email as host_email
        FROM booking_sessions bs
        JOIN booking_requests br ON br.session_id = bs.id
        WHERE bs.id = $1
        LIMIT 1
      `;
      params = [sessionId];
    } else {
      // First try with session join
      query = `
        SELECT 
          bs.id as session_id,
          br.id as booking_id,
          COALESCE(bs.session_date, br.request_date) as session_date,
          br.start_time,
          br.duration_minutes,
          COALESCE(br.declared_player_count, br.trackman_player_count, br.guest_count + 1, 1) as declared_player_count,
          br.user_email as host_email
        FROM booking_requests br
        LEFT JOIN booking_sessions bs ON br.session_id = bs.id
        WHERE br.id = $1
        LIMIT 1
      `;
      params = [bookingId];
    }
    
    const sessionResult = await pool.query(query, params);
    if (sessionResult.rows.length === 0) return null;
    
    const session = sessionResult.rows[0];
    
    let participants: Array<{
      participantId: number | undefined;
      userId: string | null;
      email: string | null;
      displayName: string;
      participantType: 'owner' | 'member' | 'guest';
    }> = [];
    
    // Try to load participants from session first
    if (session.session_id) {
      const participantsResult = await pool.query(
        `SELECT 
          bp.id as participant_id,
          bp.user_id,
          u.email,
          bp.display_name,
          bp.participant_type
         FROM booking_participants bp
         LEFT JOIN users u ON bp.user_id = u.id
         WHERE bp.session_id = $1
         ORDER BY bp.participant_type = 'owner' DESC, bp.created_at ASC`,
        [session.session_id]
      );
      participants = participantsResult.rows.map(row => ({
        participantId: row.participant_id,
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        participantType: row.participant_type as 'owner' | 'member' | 'guest'
      }));
    }
    
    // If no participants from session, try booking_members table
    if (participants.length === 0 && session.booking_id) {
      const bookingMembersResult = await pool.query(
        `SELECT 
          bm.id as participant_id,
          u.id as user_id,
          bm.user_email as email,
          COALESCE(u.full_name, bm.user_email) as display_name,
          CASE WHEN bm.user_email = $2 THEN 'owner' ELSE 'member' END as participant_type
         FROM booking_members bm
         LEFT JOIN users u ON LOWER(u.email) = LOWER(bm.user_email)
         WHERE bm.booking_id = $1
         ORDER BY bm.user_email = $2 DESC, bm.created_at ASC`,
        [session.booking_id, session.host_email]
      );
      participants = bookingMembersResult.rows.map(row => ({
        participantId: row.participant_id,
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        participantType: row.participant_type as 'owner' | 'member' | 'guest'
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
      participants
    };
  } catch (error) {
    logger.error('[UnifiedFeeService] Error loading session data:', { error: error as Error });
    return null;
  }
}

export async function computeFeeBreakdown(params: FeeComputeParams): Promise<FeeBreakdown> {
  let sessionDate: string;
  let startTime: string | undefined;
  let sessionDuration: number;
  let declaredPlayerCount: number;
  let hostEmail: string;
  let participants: Array<{
    participantId?: number;
    userId?: string;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
  }>;
  let sessionId: number | undefined;
  let currentBookingId: number | undefined;
  
  if (params.sessionId || params.bookingId) {
    const sessionData = await loadSessionData(params.sessionId, params.bookingId);
    if (!sessionData) {
      throw new Error(`Session or booking not found: sessionId=${params.sessionId}, bookingId=${params.bookingId}`);
    }
    sessionDate = sessionData.sessionDate;
    startTime = sessionData.startTime;
    sessionDuration = sessionData.sessionDuration;
    declaredPlayerCount = sessionData.declaredPlayerCount;
    hostEmail = sessionData.hostEmail;
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
    participants = params.participants;
    sessionId = undefined;
    currentBookingId = params.bookingId;
  }
  
  const actualPlayerCount = participants.length;
  const effectivePlayerCount = getEffectivePlayerCount(declaredPlayerCount, actualPlayerCount);
  
  const minutesPerParticipant = Math.floor(sessionDuration / effectivePlayerCount);
  
  const resolvedHostEmail = await resolveToEmail(hostEmail);
  const hostTier = await getMemberTierByEmail(resolvedHostEmail);
  const hostTierLimits = hostTier ? await getTierLimits(hostTier) : null;
  const guestPassInfo = await getGuestPassInfo(resolvedHostEmail, hostTier || undefined);
  
  let guestPassesRemaining = guestPassInfo.remaining;
  const guestPassesAvailable = guestPassInfo.remaining;
  
  // Pre-fetch participant identifiers (both UUID and email)
  const participantIdentifiers: Array<{ participantId: number | undefined; userId: string | null; email: string | null }> = [];
  for (const p of participants) {
    const email = await resolveToEmail(p.email || p.userId);
    participantIdentifiers.push({
      participantId: (p as any).participantId,
      userId: p.userId || null,
      email: email || null
    });
  }

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

  // Batch fetch member tiers
  const tierMap = new Map<string, string>();
  if (emailList.length > 0) {
    const tiersResult = await pool.query(
      `SELECT LOWER(email) as email, tier FROM users WHERE LOWER(email) = ANY($1::text[])`,
      [emailList.map(e => e.toLowerCase())]
    );
    tiersResult.rows.forEach(r => tierMap.set(r.email, r.tier));
  }

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
        const startTimeResult = await pool.query(
          `SELECT start_time FROM booking_requests WHERE id = $1`,
          [currentBookingId]
        );
        if (startTimeResult.rows.length > 0 && startTimeResult.rows[0].start_time) {
          effectiveStartTime = startTimeResult.rows[0].start_time;
        }
      }
      
      // Build the time filter - only count usage from earlier bookings
      const hasTimeFilter = effectiveStartTime !== undefined;
      const hasBookingIdFilter = currentBookingId !== undefined;
      
      // Filter clause: only count bookings that started earlier OR same time with lower ID
      // This ensures deterministic ordering and the current booking is excluded
      // IMPORTANT: Handle NULL start_time values with COALESCE - NULL times are treated as midnight (earliest)
      // This ensures legacy bookings without start_time don't break the ordering logic
      const timeFilterClause = hasTimeFilter 
        ? `AND (
             COALESCE(br.start_time, '00:00:00') < $3 
             OR (COALESCE(br.start_time, '00:00:00') = $3 AND br.id < COALESCE($4, 0))
           )`
        : hasBookingIdFilter
          ? `AND br.id != $3`
          : '';
      
      const queryParams = hasTimeFilter
        ? [emailList.map(e => e.toLowerCase()), sessionDate, effectiveStartTime, currentBookingId || 0]
        : hasBookingIdFilter
          ? [emailList.map(e => e.toLowerCase()), sessionDate, currentBookingId]
          : [emailList.map(e => e.toLowerCase()), sessionDate];
      
      const previewUsageQuery = `
        WITH owned_bookings AS (
          -- Bookings where the member is the owner
          -- Per-participant minutes = duration / player_count
          -- Only count bookings that start EARLIER than current booking
          SELECT LOWER(user_email) as identifier, 
                 br.id as booking_id,
                 FLOOR(duration_minutes::float / GREATEST(1, COALESCE(declared_player_count, 1))) as minutes_share
          FROM booking_requests br
          WHERE LOWER(user_email) = ANY($1::text[])
            AND request_date = $2
            AND status IN ('pending', 'approved', 'attended')
            ${timeFilterClause}
        ),
        member_bookings AS (
          -- Bookings where the member is a participant (via booking_members table)
          -- Exclude bookings where they are already the owner to prevent double-counting
          -- Only count bookings that start EARLIER than current booking
          SELECT LOWER(bm.user_email) as identifier,
                 br.id as booking_id,
                 FLOOR(br.duration_minutes::float / GREATEST(1, COALESCE(br.declared_player_count, 1))) as minutes_share
          FROM booking_members bm
          JOIN booking_requests br ON bm.booking_id = br.id
          WHERE LOWER(bm.user_email) = ANY($1::text[])
            AND br.request_date = $2
            AND br.status IN ('pending', 'approved', 'attended')
            AND LOWER(bm.user_email) != LOWER(br.user_email)
            ${timeFilterClause}
        ),
        session_participant_bookings AS (
          -- Bookings where the member is a participant (via booking_participants -> booking_sessions)
          -- This handles cases where sessions were created but booking not in booking_members
          -- Only count bookings that start EARLIER than current booking
          SELECT LOWER(u.email) as identifier,
                 br.id as booking_id,
                 FLOOR(br.duration_minutes::float / GREATEST(1, COALESCE(br.declared_player_count, 1))) as minutes_share
          FROM booking_participants bp
          JOIN booking_sessions bs ON bp.session_id = bs.id
          JOIN booking_requests br ON br.session_id = bs.id
          JOIN users u ON bp.user_id = u.id
          WHERE LOWER(u.email) = ANY($1::text[])
            AND br.request_date = $2
            AND br.status IN ('pending', 'approved', 'attended')
            AND LOWER(u.email) != LOWER(br.user_email)
            ${timeFilterClause}
        ),
        all_usage AS (
          -- Combine all sources and deduplicate by booking_id + identifier
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
        GROUP BY identifier`;
      const usageResult = await pool.query(previewUsageQuery, queryParams);
      usageResult.rows.forEach(r => usageMap.set(r.identifier, parseInt(r.used) || 0));
    } else {
      const usageQuery = excludeId 
        ? `WITH ledger_usage AS (
             SELECT LOWER(ul.member_id) as identifier, COALESCE(SUM(ul.minutes_charged), 0) as mins
             FROM usage_ledger ul
             JOIN booking_sessions bs ON ul.session_id = bs.id
             WHERE LOWER(ul.member_id) = ANY($1::text[])
               AND bs.session_date = $2
               AND ul.session_id != $3
             GROUP BY LOWER(ul.member_id)
           ),
           ghost_usage AS (
             SELECT LOWER(user_email) as identifier, 
                    COALESCE(SUM(FLOOR(duration_minutes::float / GREATEST(1, COALESCE(declared_player_count, 1)))), 0) as mins
             FROM booking_requests
             WHERE LOWER(user_email) = ANY($1::text[])
               AND request_date = $2
               AND status IN ('approved', 'confirmed', 'attended')
               AND session_id IS NULL
             GROUP BY LOWER(user_email)
           )
           SELECT identifier, COALESCE(SUM(mins), 0) as used
           FROM (
             SELECT * FROM ledger_usage
             UNION ALL
             SELECT * FROM ghost_usage
           ) combined
           GROUP BY identifier`
        : `WITH ledger_usage AS (
             SELECT LOWER(ul.member_id) as identifier, COALESCE(SUM(ul.minutes_charged), 0) as mins
             FROM usage_ledger ul
             JOIN booking_sessions bs ON ul.session_id = bs.id
             WHERE LOWER(ul.member_id) = ANY($1::text[])
               AND bs.session_date = $2
             GROUP BY LOWER(ul.member_id)
           ),
           ghost_usage AS (
             SELECT LOWER(user_email) as identifier, 
                    COALESCE(SUM(FLOOR(duration_minutes::float / GREATEST(1, COALESCE(declared_player_count, 1)))), 0) as mins
             FROM booking_requests
             WHERE LOWER(user_email) = ANY($1::text[])
               AND request_date = $2
               AND status IN ('approved', 'confirmed', 'attended')
               AND session_id IS NULL
             GROUP BY LOWER(user_email)
           )
           SELECT identifier, COALESCE(SUM(mins), 0) as used
           FROM (
             SELECT * FROM ledger_usage
             UNION ALL
             SELECT * FROM ghost_usage
           ) combined
           GROUP BY identifier`;
      const usageParams = excludeId 
        ? [allIdentifiers, sessionDate, excludeId]
        : [allIdentifiers, sessionDate];
      const usageResult = await pool.query(usageQuery, usageParams);
      usageResult.rows.forEach(r => usageMap.set(r.identifier, parseInt(r.used) || 0));
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
  
  for (const participant of participants) {
    const lineItem: FeeLineItem = {
      participantId: (participant as any).participantId,
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
      lineItem.minutesAllocated = minutesPerParticipant;
      
      // Only charge guest fee if participant has NO user_id (i.e., not a member)
      // Members incorrectly marked as guests should not be charged guest fees
      // This matches the logic in feeCalculator.ts for consistency
      const isActualGuest = !participant.userId;
      
      if (!isActualGuest) {
        // Member mistakenly marked as guest - don't charge guest fee
        lineItem.guestCents = 0;
        logger.info('[FeeBreakdown] Skipping guest fee for member marked as guest', {
          extra: { participantId: (participant as any).participantId, userId: participant.userId }
        });
      } else if (guestPassInfo.hasGuestPassBenefit && guestPassesRemaining > 0) {
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
      lineItem.minutesAllocated = minutesPerParticipant;
      
      const ownerEmail = await resolveToEmail(participant.email || participant.userId || hostEmail);
      // Use batched tier data, fallback to individual query if not found
      let tierName = tierMap.get(ownerEmail.toLowerCase());
      if (!tierName && ownerEmail) {
        tierName = await getMemberTierByEmail(ownerEmail);
      }
      const tierLimits = tierName ? await getTierLimits(tierName) : null;
      const dailyAllowance = tierLimits?.daily_sim_minutes ?? 0;
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
          minutesAllocated: minutesPerParticipant,
          willCalculateOverage: !unlimitedAccess && dailyAllowance < 999
        }
      });
      
      if (!unlimitedAccess && dailyAllowance < 999) {
        const totalAfterSession = usedMinutesToday + minutesPerParticipant;
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
        
        lineItem.overageCents = overageFee * 100;
        totalOverageCents += lineItem.overageCents;
      }
      
      lineItem.totalCents = lineItem.overageCents;
    } else {
      lineItem.minutesAllocated = minutesPerParticipant;
      
      const memberEmail = await resolveToEmail(participant.email || participant.userId);
      // Use batched tier data, fallback to individual query if not found
      let tierName = tierMap.get(memberEmail.toLowerCase());
      if (!tierName && memberEmail) {
        tierName = await getMemberTierByEmail(memberEmail);
      }
      const tierLimits = tierName ? await getTierLimits(tierName) : null;
      const dailyAllowance = tierLimits?.daily_sim_minutes ?? 0;
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
        
        lineItem.overageCents = overageFee * 100;
        totalOverageCents += lineItem.overageCents;
      }
      
      lineItem.totalCents = lineItem.overageCents;
    }
    
    lineItems.push(lineItem);
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
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const participant of breakdown.participants) {
      if (participant.participantId) {
        await client.query(
          `UPDATE booking_participants 
           SET cached_fee_cents = $1
           WHERE id = $2`,
          [participant.totalCents, participant.participantId]
        );
      }
    }
    
    await client.query('COMMIT');
    logger.info('[UnifiedFeeService] Applied fee breakdown to participants', {
      sessionId,
      participantCount: breakdown.participants.length,
      totalCents: breakdown.totals.totalCents
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[UnifiedFeeService] Error applying fee breakdown:', { error: error as Error });
    throw error;
  } finally {
    client.release();
  }
}

export async function invalidateCachedFees(
  participantIds: number[],
  reason: string
): Promise<void> {
  if (participantIds.length === 0) return;
  
  try {
    await pool.query(
      `UPDATE booking_participants 
       SET cached_fee_cents = 0 
       WHERE id = ANY($1::int[])`,
      [participantIds]
    );
    
    logger.info('[UnifiedFeeService] Invalidated cached fees', {
      participantIds,
      reason
    });
  } catch (error) {
    logger.error('[UnifiedFeeService] Error invalidating cached fees:', { error: error as Error });
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
  
  // Sync session fees to booking_requests for legacy compatibility
  // This ensures member Dashboard can show Pay Now button
  try {
    const ownerFee = breakdown.participants.find(p => p.participantType === 'owner');
    if (ownerFee) {
      await pool.query(`
        UPDATE booking_requests 
        SET overage_fee_cents = $1, 
            overage_minutes = $2,
            updated_at = NOW()
        WHERE session_id = $3
      `, [ownerFee.totalCents || 0, breakdown.overageMinutes || 0, sessionId]);
    }
  } catch (syncError) {
    logger.warn('[UnifiedFee] Failed to sync fees to booking_requests', { sessionId, error: syncError });
  }
  
  return breakdown;
}
