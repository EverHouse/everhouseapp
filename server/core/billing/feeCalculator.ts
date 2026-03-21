import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { PRICING } from './pricingConfig';
import { getErrorMessage } from '../../utils/errorUtils';

import { toIntArrayLiteral } from '../../utils/sqlArrayLiteral';
import { logger } from '../logger';
import { PAYMENT_STATUS, PARTICIPANT_TYPE } from '../../../shared/constants/statuses';

interface ParticipantFeeRow {
  participant_id: number;
  participant_type: string;
  user_id: number | null;
  payment_status: string | null;
  cached_fee_cents: number;
  ledger_fee: string;
  tier_guest_fee_cents: number | null;
}

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
         LEFT JOIN booking_requests br ON br.session_id = bp.session_id AND br.status NOT IN ('cancelled', 'deleted')
         LEFT JOIN users booking_member ON LOWER(booking_member.email) = LOWER(br.user_email)
         LEFT JOIN membership_tiers mt ON mt.id = booking_member.tier_id
         LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
           AND (
             ul.member_id = bp.user_id 
             OR LOWER(ul.member_id) = LOWER(u.email)
             OR (bp.user_id IS NULL AND bp.participant_type != 'guest' AND LOWER(ul.member_id) = LOWER(br.user_email))
           )
         WHERE bp.session_id = ${sessionId} AND bp.id = ANY(${toIntArrayLiteral(participantIds)}::int[])`
      );
      
      const fees: ParticipantFee[] = [];
      const feesToUpdate: Array<{id: number; cents: number}> = [];
      
      for (const row of participantsResult.rows as unknown as ParticipantFeeRow[]) {
        if (row.payment_status === PAYMENT_STATUS.PAID || row.payment_status === PAYMENT_STATUS.WAIVED) {
          continue;
        }
        
        let amountCents = 0;
        let source: 'cached' | 'ledger' | 'calculated' = 'calculated';
        
        if (row.cached_fee_cents > 0) {
          amountCents = row.cached_fee_cents;
          source = 'cached';
        } else if (row.ledger_fee != null && !isNaN(parseFloat(row.ledger_fee)) && parseFloat(row.ledger_fee) > 0) {
          amountCents = Math.round(parseFloat(row.ledger_fee) * 100);
          source = 'ledger';
        } else if (row.participant_type === PARTICIPANT_TYPE.GUEST) {
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
        const idsLiteral = toIntArrayLiteral(ids);
        const centsLiteral = toIntArrayLiteral(cents);
        await tx.execute(
          sql`UPDATE booking_participants bp
           SET cached_fee_cents = updates.cents
           FROM unnest(${idsLiteral}::int[], ${centsLiteral}::int[]) AS updates(id, cents)
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
    logger.error('[FeeCalculator] Error calculating fees:', { error: getErrorMessage(error) });
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
  
  await db.execute(
    sql`UPDATE booking_participants SET cached_fee_cents = 0 WHERE id = ANY(${toIntArrayLiteral(participantIds)}::int[])`
  );
}
