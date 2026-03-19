/**
 * Tier Rules Module for Multi-Member Booking System
 * 
 * SCOPE LIMITATIONS (Phase 2):
 * - Only DAILY limits are enforced (daily_sim_minutes from membership_tiers)
 * - Weekly limits are NOT implemented - no weekly_sim_minutes column exists in schema
 * - If weekly caps are needed, a future phase should add the column and aggregation logic
 */
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { getErrorMessage } from '../../utils/errorUtils';
import { 
  getTierLimits, 
  getMemberTierByEmail, 
  checkDailyBookingLimit,
  getDailyBookedMinutes,
  TierLimits 
} from '../tierService';
import { logger } from '../logger';
import { getTodayPacific } from '../../utils/dateUtils';

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
  _declaredPlayerCount: number = 1,
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
  } catch (error: unknown) {
    logger.error('[validateTierWindowAndBalance] Error:', { error: getErrorMessage(error) });
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
  } catch (error: unknown) {
    logger.error('[getRemainingMinutes] Error:', { error: getErrorMessage(error) });
    return 0;
  }
}

export async function enforceSocialTierRules(
  ownerTier: string | null,
  _participants: ParticipantForValidation[]
): Promise<SocialTierResult> {
  try {
    const { isSocialTier } = await import('../../utils/tierUtils');
    
    // Non-Social tiers can always have guests
    if (!isSocialTier(ownerTier)) {
      return { allowed: true };
    }
    
    // Social hosts CAN have guests — they just pay guest fees since they have 0 complimentary passes.
    // The fee calculation system (unifiedFeeService) handles charging guest fees automatically.
    return { allowed: true };
  } catch (error: unknown) {
    logger.error('[enforceSocialTierRules] Error:', { error: getErrorMessage(error) });
    return { allowed: true };
  }
}

export async function getGuestPassesRemaining(memberEmail: string): Promise<number> {
  try {
    const result = await db.execute(
      sql`SELECT passes_total, passes_used FROM guest_passes WHERE LOWER(member_email) = LOWER(${memberEmail}) LIMIT 1`
    );
    
    if (result.rows.length > 0) {
      const row = result.rows[0] as { passes_total: number; passes_used: number };
      return Math.max(0, row.passes_total - row.passes_used);
    }
    
    const tier = await getMemberTierByEmail(memberEmail);
    if (!tier) return 0;
    const limits = await getTierLimits(tier);
    return limits.guest_passes_per_year;
  } catch (error: unknown) {
    logger.error('[getGuestPassesRemaining] Error:', { error: getErrorMessage(error) });
    return 0;
  }
}

export async function getMemberTier(email: string): Promise<string | null> {
  return getMemberTierByEmail(email);
}

export { getTierLimits };
export type { TierLimits };
