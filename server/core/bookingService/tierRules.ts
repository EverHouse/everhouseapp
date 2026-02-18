/**
 * Tier Rules Module for Multi-Member Booking System
 * 
 * SCOPE LIMITATIONS (Phase 2):
 * - Only DAILY limits are enforced (daily_sim_minutes from membership_tiers)
 * - Weekly limits are NOT implemented - no weekly_sim_minutes column exists in schema
 * - If weekly caps are needed, a future phase should add the column and aggregation logic
 */
import { pool } from '../db';
import { 
  getTierLimits, 
  getMemberTierByEmail, 
  checkDailyBookingLimit,
  getDailyBookedMinutes,
  TierLimits 
} from '../tierService';
import { logger } from '../logger';
import { getTodayPacific, getPacificDateParts } from '../../utils/dateUtils';

export interface TierValidationResult {
  allowed: boolean;
  reason?: string;
  remainingMinutes?: number;
  overageMinutes?: number;
  includedMinutes?: number;
  tier?: string;
}

export interface SocialTierResult {
  allowed: boolean;
  reason?: string;
}

export interface ParticipantForValidation {
  type: 'owner' | 'member' | 'guest';
  displayName?: string;
}

export async function validateTierWindowAndBalance(
  memberEmail: string,
  bookingDate: string,
  duration: number,
  declaredPlayerCount: number = 1,
  resourceType?: string
): Promise<TierValidationResult> {
  try {
    const tier = await getMemberTierByEmail(memberEmail);
    
    if (!tier) {
      return { 
        allowed: false, 
        reason: 'Member not found or no tier assigned' 
      };
    }
    
    const result = await checkDailyBookingLimit(memberEmail, bookingDate, duration, tier, resourceType);
    
    if (!result.allowed) {
      return {
        allowed: false,
        reason: result.reason,
        remainingMinutes: result.remainingMinutes,
        tier
      };
    }
    
    return {
      allowed: true,
      remainingMinutes: result.remainingMinutes,
      overageMinutes: result.overageMinutes,
      includedMinutes: result.includedMinutes,
      tier
    };
  } catch (error) {
    logger.error('[validateTierWindowAndBalance] Error:', { error: error as Error });
    throw error;
  }
}

export async function getRemainingMinutes(
  memberEmail: string,
  tier?: string,
  date?: string,
  resourceType?: string
): Promise<number> {
  try {
    const memberTier = tier || await getMemberTierByEmail(memberEmail);
    
    if (!memberTier) {
      return 0;
    }
    
    const limits = await getTierLimits(memberTier);
    const isConferenceRoom = resourceType === 'conference_room';
    
    // Use appropriate daily limit based on resource type
    const dailyLimit = isConferenceRoom 
      ? limits.daily_conf_room_minutes 
      : limits.daily_sim_minutes;
    
    if (limits.unlimited_access || dailyLimit >= 999) {
      return 999;
    }
    
    if (dailyLimit === 0) {
      return 0;
    }
    
    const targetDate = date || getTodayPacific();
    // Pass resource type to filter usage appropriately
    const bookedMinutes = await getDailyBookedMinutes(memberEmail, targetDate, resourceType || 'simulator');
    
    return Math.max(0, dailyLimit - bookedMinutes);
  } catch (error) {
    logger.error('[getRemainingMinutes] Error:', { error: error as Error });
    return 0;
  }
}

export async function enforceSocialTierRules(
  ownerTier: string,
  participants: ParticipantForValidation[]
): Promise<SocialTierResult> {
  try {
    const { isSocialTier } = await import('../../utils/tierUtils');
    
    // Non-Social tiers can always have guests
    if (!isSocialTier(ownerTier)) {
      return { allowed: true };
    }
    
    const limits = await getTierLimits(ownerTier);
    
    // Check if Social tier has 0 guest passes and participants include guests
    if (limits.guest_passes_per_month === 0) {
      const hasGuests = participants.some(p => p.type === 'guest');
      
      if (hasGuests) {
        return {
          allowed: false,
          reason: 'Social tier members cannot bring guests to simulator bookings. Your membership includes 0 guest passes per month.'
        };
      }
    }
    
    // Social hosts CAN have other members in their booking
    return { allowed: true };
  } catch (error) {
    logger.error('[enforceSocialTierRules] Error:', { error: error as Error });
    return { allowed: true };
  }
}

export async function getGuestPassesRemaining(memberEmail: string): Promise<number> {
  try {
    const tier = await getMemberTierByEmail(memberEmail);
    
    if (!tier) {
      return 0;
    }
    
    const limits = await getTierLimits(tier);
    
    const { year, month } = getPacificDateParts();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    
    const result = await pool.query(
      `SELECT COUNT(*) as guest_count
       FROM booking_participants bp
       JOIN booking_sessions bs ON bp.session_id = bs.id
       JOIN booking_requests br ON bs.id = br.session_id
       WHERE bp.participant_type = 'guest'
         AND bp.used_guest_pass = true
         AND bs.session_date >= $1
         AND bs.session_date <= $2
         AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
         AND EXISTS (
           SELECT 1 FROM booking_participants owner_bp
           WHERE owner_bp.session_id = bs.id
             AND owner_bp.participant_type = 'owner'
             AND owner_bp.user_id = (
               SELECT id FROM users WHERE LOWER(email) = LOWER($3) LIMIT 1
             )
         )`,
      [monthStart, monthEnd, memberEmail]
    );
    
    const usedPasses = parseInt(result.rows[0]?.guest_count || '0');
    
    return Math.max(0, limits.guest_passes_per_month - usedPasses);
  } catch (error) {
    logger.error('[getGuestPassesRemaining] Error:', { error: error as Error });
    return 0;
  }
}

export async function getMemberTier(email: string): Promise<string | null> {
  return getMemberTierByEmail(email);
}

export { getTierLimits };
export type { TierLimits };
