import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { PRICING } from './pricingConfig';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
export interface ParticipantFee {
  participantId: number;
  amountCents: number;
  source: 'cached' | 'ledger' | 'calculated';
}

export interface FeeCalculationResult {
  fees: ParticipantFee[];
  totalCents: number;
  success: boolean;
  error?: string;
}

export async function calculateAndCacheParticipantFees(
  sessionId: number,
  participantIds: number[]
): Promise<FeeCalculationResult> {
  try {
    const result = await db.transaction(async (tx) => {
      const participantsResult = await tx.execute(
        sql`SELECT 
          bp.id as participant_id,
          bp.participant_type,
          bp.user_id,
          bp.payment_status,
          bp.cached_fee_cents,
          CASE WHEN bp.participant_type != 'guest' THEN COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) ELSE 0 END as ledger_fee,
          mt.guest_fee_cents as tier_guest_fee_cents
         FROM booking_participants bp
         LEFT JOIN users u ON u.id = bp.user_id
         LEFT JOIN booking_requests br ON br.session_id = bp.session_id AND br.status != 'cancelled'
         LEFT JOIN users booking_member ON LOWER(booking_member.email) = LOWER(br.user_email)
         LEFT JOIN membership_tiers mt ON mt.id = booking_member.tier_id
         LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
           AND (
             ul.member_id = bp.user_id 
             OR LOWER(ul.member_id) = LOWER(u.email)
             OR (bp.user_id IS NULL AND bp.participant_type != 'guest' AND LOWER(ul.member_id) = LOWER(br.user_email))
           )
         WHERE bp.session_id = ${sessionId} AND bp.id = ANY(${participantIds}::int[])`
      );
      
      const fees: ParticipantFee[] = [];
      const feesToUpdate: Array<{id: number; cents: number}> = [];
      
      for (const row of participantsResult.rows) {
        if (row.payment_status === 'paid' || row.payment_status === 'waived') {
          continue;
        }
        
        let amountCents = 0;
        let source: 'cached' | 'ledger' | 'calculated' = 'calculated';
        
        if (row.cached_fee_cents > 0) {
          amountCents = row.cached_fee_cents;
          source = 'cached';
        } else if (parseFloat(row.ledger_fee) > 0) {
          amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
          source = 'ledger';
        } else if (row.participant_type === 'guest') {
          if (!row.user_id) {
            amountCents = row.tier_guest_fee_cents ?? PRICING.GUEST_FEE_CENTS;
            source = 'calculated';
          }
        }
        
        if (amountCents > 0) {
          fees.push({
            participantId: row.participant_id,
            amountCents,
            source
          });
          
          if (source !== 'cached') {
            feesToUpdate.push({ id: row.participant_id, cents: amountCents });
          }
        }
      }
      
      if (feesToUpdate.length > 0) {
        const ids = feesToUpdate.map(f => f.id);
        const cents = feesToUpdate.map(f => f.cents);
        await tx.execute(
          sql`UPDATE booking_participants bp
           SET cached_fee_cents = updates.cents
           FROM (SELECT UNNEST(${ids}::int[]) as id, UNNEST(${cents}::int[]) as cents) as updates
           WHERE bp.id = updates.id`
        );
      }
      
      const totalCents = fees.reduce((sum, f) => sum + f.amountCents, 0);
      
      return {
        fees,
        totalCents,
        success: true
      };
    });
    
    return result;
  } catch (error: unknown) {
    logger.error('[FeeCalculator] Error calculating fees:', { error: error });
    return {
      fees: [],
      totalCents: 0,
      success: false,
      error: getErrorMessage(error) || 'Failed to calculate fees'
    };
  }
}

export async function clearCachedFees(participantIds: number[]): Promise<void> {
  if (participantIds.length === 0) return;
  
  try {
    await db.execute(
      sql`UPDATE booking_participants SET cached_fee_cents = 0 WHERE id = ANY(${participantIds}::int[])`
    );
  } catch (error: unknown) {
    logger.error('[FeeCalculator] Error clearing cached fees:', { error: error });
  }
}

/**
 * @deprecated This function has zero callers in the codebase. Use computeFeeBreakdown() 
 * from unifiedFeeService.ts instead. The guest count assumption (playerCount - 1 = guests) 
 * overestimates fees. Kept for reference only.
 */
export function estimateBookingFees(
  userTier: string,
  duration: number,
  playerCount: number,
  usedMinutesForDay: number,
  tierPermissions: { dailySimulatorMinutes?: number; dailyConfRoomMinutes?: number },
  isConferenceRoom: boolean = false
): {
  overageFee: number;
  guestFees: number;
  totalFee: number;
  guestCount: number;
  overageMinutes: number;
} {
  const safePlayerCount = Math.max(1, Math.floor(playerCount) || 1);
  const safeDuration = Math.max(0, duration || 0);
  
  const dailyAllowance = isConferenceRoom 
    ? (tierPermissions.dailyConfRoomMinutes || 0)
    : (tierPermissions.dailySimulatorMinutes || 0);
  const perPersonMins = Math.floor(safeDuration / safePlayerCount);

  const overageMinutes = Math.max(0, (usedMinutesForDay + perPersonMins) - dailyAllowance);
  const overageBlocks = Math.ceil(overageMinutes / 30);
  const overageFee = overageBlocks * PRICING.OVERAGE_RATE_DOLLARS;

  const guestCount = Math.max(0, safePlayerCount - 1);
  const guestFees = guestCount * PRICING.GUEST_FEE_DOLLARS;

  const totalFee = overageFee + guestFees;

  return { overageFee, guestFees, totalFee, guestCount, overageMinutes };
}
