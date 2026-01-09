import { pool } from './db';
import { normalizeTierName, DEFAULT_TIER } from '../../shared/constants/tiers';

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
    const result = await pool.query(
      `SELECT daily_sim_minutes, guest_passes_per_month, booking_window_days, 
              daily_conf_room_minutes, can_book_simulators, can_book_conference,
              can_book_wellness, has_group_lessons, has_extended_sessions,
              has_private_lesson, has_simulator_guest_passes, has_discounted_merch,
              unlimited_access
       FROM membership_tiers 
       WHERE LOWER(name) = LOWER($1) OR LOWER(slug) = LOWER($1)
       LIMIT 1`,
      [normalizedTier]
    );
    
    if (result.rows.length === 0) {
      console.warn(`[getTierLimits] No tier found for "${normalizedTier}" (original: "${tierName}"), using defaults`);
      return DEFAULT_TIER_LIMITS;
    }
    
    const data = result.rows[0] as TierLimits;
    tierCache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL_MS });
    
    return data;
  } catch (error) {
    console.error('[getTierLimits] Error fetching tier limits:', error);
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

export async function getMemberTierByEmail(email: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT u.tier, mt.name as tier_name
       FROM users u
       LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
       WHERE LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [email]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0].tier_name || result.rows[0].tier || null;
  } catch (error) {
    console.error('[getMemberTierByEmail] Error:', error);
    return null;
  }
}

export async function getDailyBookedMinutes(email: string, date: string): Promise<number> {
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(duration_minutes), 0) as total_minutes
       FROM booking_requests
       WHERE LOWER(user_email) = LOWER($1)
         AND request_date = $2
         AND status IN ('pending', 'approved')`,
      [email, date]
    );
    
    return parseInt(result.rows[0].total_minutes) || 0;
  } catch (error) {
    console.error('[getDailyBookedMinutes] Error:', error);
    return 0;
  }
}

export async function checkDailyBookingLimit(
  email: string, 
  date: string, 
  requestedMinutes: number,
  providedTier?: string
): Promise<{ allowed: boolean; reason?: string; remainingMinutes?: number; overageMinutes?: number; includedMinutes?: number }> {
  // Use provided tier first (from view-as-member), fall back to database lookup
  const tier = providedTier || await getMemberTierByEmail(email);
  
  if (!tier) {
    return { allowed: false, reason: 'Member not found or no tier assigned' };
  }
  
  const limits = await getTierLimits(tier);
  
  if (!limits.can_book_simulators) {
    return { allowed: false, reason: 'Your membership tier does not include simulator booking' };
  }
  
  // Check booking window restriction (how far in advance user can book)
  const bookingWindowDays = limits.booking_window_days ?? 7;
  const bookingDate = new Date(date + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const maxBookingDate = new Date(today);
  maxBookingDate.setDate(maxBookingDate.getDate() + bookingWindowDays);
  
  if (bookingDate > maxBookingDate) {
    const formattedMaxDate = maxBookingDate.toLocaleDateString('en-US', { 
      weekday: 'short', month: 'short', day: 'numeric' 
    });
    return { 
      allowed: false, 
      reason: `Your membership tier (${tier}) allows booking up to ${bookingWindowDays} days in advance. The latest date you can book is ${formattedMaxDate}.`
    };
  }
  
  const dailyLimit = limits.daily_sim_minutes ?? 0;
  
  if (limits.unlimited_access || dailyLimit >= 999) {
    return { allowed: true, remainingMinutes: 999, overageMinutes: 0, includedMinutes: requestedMinutes };
  }
  
  // If daily limit is 0 but can_book_simulators is true, this is pay-as-you-go (e.g., Social tier)
  // All time is charged as overage. They can still book, just with 0 included minutes.
  // Only block if can_book_simulators is explicitly false (already checked above at line 145)
  
  const alreadyBooked = await getDailyBookedMinutes(email, date);
  const remainingMinutes = Math.max(0, dailyLimit - alreadyBooked);
  
  // Allow bookings - calculate included vs overage for billing
  // Members can book longer sessions and pay overage fees ($25/30 min)
  // For tiers with 0 daily minutes (pay-as-you-go), all time is overage
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
