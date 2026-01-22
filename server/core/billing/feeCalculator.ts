import { pool } from '../db';

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

const DEFAULT_GUEST_FEE_CENTS = 2500;

export async function calculateAndCacheParticipantFees(
  sessionId: number,
  participantIds: number[]
): Promise<FeeCalculationResult> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Join usage_ledger by resolving user_id to email via users table
    // This handles UUID-based user_ids, email-based member_ids, and fallback via booking_requests
    // When user_id is null, we can still match via the booking_request's user_email
    // Also join membership_tiers to get the tier-specific guest fee for the booking member
    const participantsResult = await client.query(
      `SELECT 
        bp.id as participant_id,
        bp.participant_type,
        bp.user_id,
        bp.payment_status,
        bp.cached_fee_cents,
        COALESCE(ul.overage_fee, 0) + COALESCE(ul.guest_fee, 0) as ledger_fee,
        mt.guest_fee_cents as tier_guest_fee_cents
       FROM booking_participants bp
       LEFT JOIN users u ON u.id = bp.user_id
       LEFT JOIN booking_requests br ON br.session_id = bp.session_id
       LEFT JOIN users booking_member ON LOWER(booking_member.email) = LOWER(br.user_email)
       LEFT JOIN membership_tiers mt ON mt.id = booking_member.tier_id
       LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
         AND (
           ul.member_id = bp.user_id 
           OR LOWER(ul.member_id) = LOWER(u.email)
           OR (bp.user_id IS NULL AND LOWER(ul.member_id) = LOWER(br.user_email))
         )
       WHERE bp.session_id = $1 AND bp.id = ANY($2::int[])`,
      [sessionId, participantIds]
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
        // Only charge guest fee if participant has no user_id (i.e., not a member)
        // Members incorrectly marked as guests should not be charged guest fees
        if (!row.user_id) {
          amountCents = row.tier_guest_fee_cents ?? DEFAULT_GUEST_FEE_CENTS;
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
      await client.query(
        `UPDATE booking_participants bp
         SET cached_fee_cents = updates.cents
         FROM (SELECT UNNEST($1::int[]) as id, UNNEST($2::int[]) as cents) as updates
         WHERE bp.id = updates.id`,
        [ids, cents]
      );
    }
    
    await client.query('COMMIT');
    
    const totalCents = fees.reduce((sum, f) => sum + f.amountCents, 0);
    
    return {
      fees,
      totalCents,
      success: true
    };
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('[FeeCalculator] Error calculating fees:', error);
    return {
      fees: [],
      totalCents: 0,
      success: false,
      error: error.message || 'Failed to calculate fees'
    };
  } finally {
    client.release();
  }
}

export async function clearCachedFees(participantIds: number[]): Promise<void> {
  if (participantIds.length === 0) return;
  
  try {
    await pool.query(
      `UPDATE booking_participants SET cached_fee_cents = 0 WHERE id = ANY($1::int[])`,
      [participantIds]
    );
  } catch (error) {
    console.error('[FeeCalculator] Error clearing cached fees:', error);
  }
}

export function estimateBookingFees(
  userTier: string,
  duration: number,
  playerCount: number,
  usedMinutesForDay: number,
  tierPermissions: { dailySimulatorMinutes?: number }
): {
  overageFee: number;
  guestFees: number;
  totalFee: number;
  guestCount: number;
  overageMinutes: number;
} {
  const safePlayerCount = Math.max(1, Math.floor(playerCount) || 1);
  const safeDuration = Math.max(0, duration || 0);
  
  const isSocialTier = userTier?.toLowerCase() === 'social';
  const dailyAllowance = tierPermissions.dailySimulatorMinutes || 0;
  const perPersonMins = Math.floor(safeDuration / safePlayerCount);

  const overageMinutes = isSocialTier
    ? safeDuration
    : Math.max(0, (usedMinutesForDay + perPersonMins) - dailyAllowance);
  const overageBlocks = Math.ceil(overageMinutes / 30);
  const overageFee = overageBlocks * 25;

  const guestCount = Math.max(0, safePlayerCount - 1);
  const guestFees = guestCount * 25;

  const totalFee = overageFee + guestFees;

  return { overageFee, guestFees, totalFee, guestCount, overageMinutes };
}
