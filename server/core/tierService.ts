import { db } from '../db';
import { sql } from 'drizzle-orm';
import { normalizeTierName, DEFAULT_TIER } from '../../shared/constants/tiers';
import { normalizeEmail } from './utils/emailNormalization';
import { normalizeToISODate } from '../utils/dateNormalize';

import { logger } from './logger';
export interface TierLimits {
  daily_sim_minutes: number;
  guest_passes_per_month: number;
  booking_window_days: number;
  daily_conf_room_minutes: number;
  can_book_simulators: boolean;
  can_book_conference: boolean;
  can_book_wellness: boolean;
  has_group_lessons: boolean;
  has_extended_sessions: boolean;
  has_private_lesson: boolean;
  has_simulator_guest_passes: boolean;
  has_discounted_merch: boolean;
  unlimited_access: boolean;
}

const DEFAULT_TIER_LIMITS: TierLimits = {
  daily_sim_minutes: 0,
  guest_passes_per_month: 0,
  booking_window_days: 7,
  daily_conf_room_minutes: 0,
  can_book_simulators: false,
  can_book_conference: false,
  can_book_wellness: true,
  has_group_lessons: false,
  has_extended_sessions: false,
  has_private_lesson: false,
  has_simulator_guest_passes: false,
  has_discounted_merch: false,
  unlimited_access: false,
};

const tierCache = new Map<string, { data: TierLimits; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getTierLimits(tierName: string): Promise<TierLimits> {
  if (!tierName) {
    return DEFAULT_TIER_LIMITS;
  }
  
  const normalizedTier = normalizeTierName(tierName);
  const cacheKey = normalizedTier.toLowerCase();
  const cached = tierCache.get(cacheKey);
  
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }
  
  try {
    const result = await db.execute(sql`SELECT daily_sim_minutes, guest_passes_per_month, booking_window_days, 
              daily_conf_room_minutes, can_book_simulators, can_book_conference,
              can_book_wellness, has_group_lessons, has_extended_sessions,
              has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
              unlimited_access
       FROM membership_tiers 
       WHERE LOWER(name) = LOWER(${normalizedTier}) OR LOWER(slug) = LOWER(${normalizedTier})
       LIMIT 1`);
    
    if (result.rows.length === 0) {
      logger.warn(`[getTierLimits] No tier found for "${normalizedTier}" (original: "${tierName}"), using defaults`);
      return DEFAULT_TIER_LIMITS;
    }
    
    const data = result.rows[0] as TierLimits;
    tierCache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL_MS });
    
    return data;
  } catch (error: unknown) {
    logger.error('[getTierLimits] Error fetching tier limits:', { error: error });
    return DEFAULT_TIER_LIMITS;
  }
}

export function clearTierCache(): void {
  tierCache.clear();
}

export function invalidateTierCache(tierName: string): void {
  const normalizedKey = normalizeTierName(tierName).toLowerCase();
  tierCache.delete(normalizedKey);
  tierCache.delete(tierName.toLowerCase());
}

export async function getMemberTierByEmail(email: string, options?: { allowInactive?: boolean }): Promise<string | null> {
  try {
    const normalizedEmailValue = normalizeEmail(email);
    const result = await db.execute(sql`SELECT u.tier, mt.name as tier_name, u.membership_status
       FROM users u
       LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
       WHERE LOWER(u.email) = LOWER(${normalizedEmailValue})
       LIMIT 1`);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const user = result.rows[0] as Record<string, unknown>;
    
    if (!options?.allowInactive) {
      const validStatuses = ['active', 'trialing', 'past_due'];
      if (!user.membership_status || !validStatuses.includes(user.membership_status as string)) {
        logger.warn(`[TierService] Denying tier access for ${email} (Status: ${user.membership_status || 'none'})`);
        return null;
      }
    }
    
    return (user.tier_name as string) || (user.tier as string) || null;
  } catch (error: unknown) {
    logger.error('[getMemberTierByEmail] Error:', { error: error });
    return null;
  }
}

export async function getDailyBookedMinutes(email: string, date: string, resourceType?: string): Promise<number> {
  try {
    const normalizedDate = normalizeToISODate(date);
    
    const resourceFilter = resourceType ? sql`AND EXISTS (
          SELECT 1 FROM resources r 
          WHERE r.id = br.resource_id AND r.type = ${resourceType}
        )` : sql``;
    
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(br.duration_minutes), 0) as total_minutes
      FROM booking_requests br
      WHERE LOWER(br.user_email) = LOWER(${email})
        AND br.request_date = ${normalizedDate}
        AND br.status IN ('pending', 'approved', 'attended', 'confirmed')
        ${resourceFilter}`);
    
    return parseInt((result.rows[0] as Record<string, unknown>).total_minutes as string) || 0;
  } catch (error: unknown) {
    logger.error('[getDailyBookedMinutes] Error:', { error: error });
    return 0;
  }
}

export async function getDailyParticipantMinutes(email: string, date: string, excludeBookingId?: number, resourceType?: string): Promise<number> {
  try {
    const normalizedDate = normalizeToISODate(date);

    const excludeClause = excludeBookingId ? sql`AND br.id != ${excludeBookingId}` : sql``;
    const resourceTypeClause = resourceType ? sql`AND EXISTS (SELECT 1 FROM resources r WHERE r.id = br.resource_id AND r.type = ${resourceType})` : sql``;

    const participantsResult = await db.execute(sql`SELECT COALESCE(SUM(
         br.duration_minutes::float / GREATEST(
           COALESCE(
             NULLIF(br.declared_player_count, 0),
             NULLIF(br.trackman_player_count, 0),
             (SELECT COUNT(*) FROM booking_participants bp2 WHERE bp2.session_id = br.session_id),
             GREATEST(COALESCE(br.guest_count, 0) + 1, 1)
           ),
           1
         )
       ), 0) as total_minutes
       FROM booking_participants bp
       JOIN booking_sessions bs ON bp.session_id = bs.id
       JOIN booking_requests br ON br.session_id = bs.id
       JOIN users u ON bp.user_id = u.id
       WHERE LOWER(u.email) = LOWER(${email})
         AND br.request_date = ${normalizedDate}
         AND br.status IN ('pending', 'approved', 'attended')
         AND LOWER(br.user_email) != LOWER(${email})
         ${excludeClause}
         ${resourceTypeClause}`);

    return parseFloat((participantsResult.rows[0] as Record<string, unknown>).total_minutes as string) || 0;
  } catch (error: unknown) {
    logger.error('[getDailyParticipantMinutes] Error:', { error: error });
    return 0;
  }
}

export async function getTotalDailyUsageMinutes(
  email: string, 
  date: string, 
  excludeBookingId?: number,
  resourceType?: string
): Promise<{ ownerMinutes: number; participantMinutes: number; totalMinutes: number }> {
  try {
    const ownerExcludeClause = excludeBookingId ? sql`AND id != ${excludeBookingId}` : sql``;
    const ownerResourceTypeClause = resourceType ? sql`AND EXISTS (SELECT 1 FROM resources r WHERE r.id = br.resource_id AND r.type = ${resourceType})` : sql``;

    const [ownerResult, participantMinutes] = await Promise.all([
      db.execute(sql`SELECT COALESCE(SUM(
           duration_minutes::float / GREATEST(
             COALESCE(
               NULLIF(declared_player_count, 0),
               NULLIF(trackman_player_count, 0),
               (SELECT COUNT(*) FROM booking_participants bp WHERE bp.session_id = br.session_id),
               GREATEST(COALESCE(guest_count, 0) + 1, 1)
             ),
             1
           )
         ), 0) as total_minutes
         FROM booking_requests br
         WHERE LOWER(user_email) = LOWER(${email})
           AND request_date = ${date}
           AND status IN ('pending', 'approved')
           ${ownerExcludeClause}
           ${ownerResourceTypeClause}`),
      getDailyParticipantMinutes(email, date, excludeBookingId, resourceType)
    ]);

    const ownerMinutes = parseFloat((ownerResult.rows[0] as Record<string, unknown>).total_minutes as string) || 0;

    return {
      ownerMinutes,
      participantMinutes,
      totalMinutes: ownerMinutes + participantMinutes
    };
  } catch (error: unknown) {
    logger.error('[getTotalDailyUsageMinutes] Error:', { error: error });
    return { ownerMinutes: 0, participantMinutes: 0, totalMinutes: 0 };
  }
}

export async function checkDailyBookingLimit(
  email: string, 
  date: string, 
  requestedMinutes: number,
  providedTier?: string,
  resourceType?: string
): Promise<{ allowed: boolean; reason?: string; remainingMinutes?: number; overageMinutes?: number; includedMinutes?: number }> {
  const tier = providedTier || await getMemberTierByEmail(email);
  
  if (!tier) {
    return { allowed: false, reason: 'Member not found or no tier assigned' };
  }
  
  const limits = await getTierLimits(tier);
  
  if (resourceType === 'conference_room') {
    if (!limits.can_book_conference) {
      return { allowed: false, reason: 'Your membership tier does not include conference room booking' };
    }
  } else if (!limits.can_book_simulators) {
    return { allowed: false, reason: 'Your membership tier does not include simulator booking' };
  }
  
  const bookingWindowDays = limits.booking_window_days ?? 7;
  const bookingDate = new Date(date + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const maxBookingDate = new Date(today);
  maxBookingDate.setDate(maxBookingDate.getDate() + bookingWindowDays);
  
  if (bookingDate > maxBookingDate) {
    const formattedMaxDate = maxBookingDate.toLocaleDateString('en-US', { 
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' 
    });
    return { 
      allowed: false, 
      reason: `Your membership tier (${tier}) allows booking up to ${bookingWindowDays} days in advance. The latest date you can book is ${formattedMaxDate}.`
    };
  }
  
  const isConferenceRoom = resourceType === 'conference_room';
  const dailyLimit = isConferenceRoom 
    ? (limits.daily_conf_room_minutes ?? 0)
    : (limits.daily_sim_minutes ?? 0);
  
  if (limits.unlimited_access || dailyLimit >= 999) {
    return { allowed: true, remainingMinutes: 999, overageMinutes: 0, includedMinutes: requestedMinutes };
  }
  
  const alreadyBooked = await getDailyBookedMinutes(email, date, resourceType);
  const remainingMinutes = Math.max(0, dailyLimit - alreadyBooked);
  
  const includedMinutes = Math.min(requestedMinutes, remainingMinutes);
  const overageMinutes = Math.max(0, requestedMinutes - remainingMinutes);
  
  return { 
    allowed: true, 
    remainingMinutes: Math.max(0, remainingMinutes - requestedMinutes),
    overageMinutes,
    includedMinutes
  };
}

export { DEFAULT_TIER_LIMITS };
