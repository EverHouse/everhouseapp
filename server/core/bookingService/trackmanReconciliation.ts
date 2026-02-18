import { pool } from '../db';
import { logger } from '../logger';
import { getTierLimits, getMemberTierByEmail } from '../tierService';
import { PRICING } from '../billing/pricingConfig';

export interface ReconciliationResult {
  bookingId: number;
  userEmail: string;
  userName: string | null;
  requestDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  declaredCount: number;
  actualCount: number;
  discrepancy: 'over_declared' | 'under_declared' | 'matched';
  discrepancyAmount: number;
  requiresReview: boolean;
  potentialFeeAdjustment: number;
  reconciliationStatus: string | null;
  reconciledBy: string | null;
  reconciledAt: Date | null;
  resourceId: number | null;
  trackmanBookingId: string | null;
}

export interface ReconciliationStats {
  totalDiscrepancies: number;
  pendingReview: number;
  reviewed: number;
  adjusted: number;
  totalPotentialFeeAdjustment: number;
}

export interface FindDiscrepanciesOptions {
  startDate?: string;
  endDate?: string;
  status?: 'pending' | 'reviewed' | 'adjusted' | 'all';
  limit?: number;
  offset?: number;
}

const DEFAULT_OVERAGE_RATE_PER_30_MIN = PRICING.OVERAGE_RATE_DOLLARS;

async function getTierOverageRate(tier: string | null): Promise<number> {
  if (!tier) return DEFAULT_OVERAGE_RATE_PER_30_MIN;
  
  try {
    const result = await pool.query(
      `SELECT guest_fee_cents FROM membership_tiers WHERE LOWER(slug) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1`,
      [tier]
    );
    
    if (result.rows.length > 0 && result.rows[0].guest_fee_cents) {
      return Math.round(result.rows[0].guest_fee_cents / 100);
    }
  } catch (error) {
    logger.warn('[getTierOverageRate] Failed to fetch tier overage rate, using default', { extra: { tier, error } });
  }
  
  return DEFAULT_OVERAGE_RATE_PER_30_MIN;
}

function calculatePotentialFeeAdjustment(
  durationMinutes: number,
  declaredCount: number,
  actualCount: number,
  overageRatePer30Min: number = DEFAULT_OVERAGE_RATE_PER_30_MIN
): number {
  if (actualCount <= declaredCount) return 0;
  
  const additionalPlayers = actualCount - declaredCount;
  const minutesPerPlayer = Math.floor(durationMinutes / actualCount);
  const additionalMinutes = minutesPerPlayer * additionalPlayers;
  
  const thirtyMinBlocks = Math.ceil(additionalMinutes / 30);
  return thirtyMinBlocks * overageRatePer30Min;
}

export async function findAttendanceDiscrepancies(
  options: FindDiscrepanciesOptions = {}
): Promise<{ discrepancies: ReconciliationResult[]; stats: ReconciliationStats; totalCount: number }> {
  const { startDate, endDate, status = 'all', limit = 100, offset = 0 } = options;
  
  try {
    let whereConditions = `
      br.status = 'attended'
      AND br.trackman_booking_id IS NOT NULL
      AND br.trackman_player_count IS NOT NULL
      AND br.declared_player_count IS NOT NULL
      AND br.trackman_player_count != br.declared_player_count
    `;
    const params: (string | number | null)[] = [];
    let paramIndex = 1;
    
    if (startDate) {
      whereConditions += ` AND br.request_date >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }
    
    if (endDate) {
      whereConditions += ` AND br.request_date <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }
    
    if (status !== 'all') {
      if (status === 'pending') {
        whereConditions += ` AND (br.reconciliation_status IS NULL OR br.reconciliation_status = 'pending')`;
      } else {
        whereConditions += ` AND br.reconciliation_status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }
    }
    
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM booking_requests br WHERE ${whereConditions}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0].total, 10);
    
    const statsResult = await pool.query(
      `SELECT 
        COUNT(*) as total_discrepancies,
        COUNT(*) FILTER (WHERE reconciliation_status IS NULL OR reconciliation_status = 'pending') as pending_review,
        COUNT(*) FILTER (WHERE reconciliation_status = 'reviewed') as reviewed,
        COUNT(*) FILTER (WHERE reconciliation_status = 'adjusted') as adjusted
       FROM booking_requests br
       WHERE br.status = 'attended'
         AND br.trackman_booking_id IS NOT NULL
         AND br.trackman_player_count IS NOT NULL
         AND br.declared_player_count IS NOT NULL
         AND br.trackman_player_count != br.declared_player_count`,
      []
    );
    
    const limitParam = paramIndex;
    const offsetParam = paramIndex + 1;
    
    const result = await pool.query(
      `SELECT 
        br.id,
        br.user_email,
        br.user_name,
        TO_CHAR(br.request_date, 'YYYY-MM-DD') as request_date,
        br.start_time,
        br.end_time,
        br.duration_minutes,
        br.declared_player_count,
        br.trackman_player_count,
        br.reconciliation_status,
        br.reconciled_by,
        br.reconciled_at,
        br.reconciliation_notes,
        br.resource_id,
        br.trackman_booking_id
       FROM booking_requests br
       WHERE ${whereConditions}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...params, limit, offset]
    );
    
    let totalPotentialFeeAdjustment = 0;
    
    const discrepancies: ReconciliationResult[] = result.rows.map(row => {
      const declaredCount = parseInt(row.declared_player_count) || 0;
      const actualCount = parseInt(row.trackman_player_count) || 0;
      const durationMinutes = parseInt(row.duration_minutes) || 0;
      
      let discrepancy: 'over_declared' | 'under_declared' | 'matched';
      if (actualCount > declaredCount) {
        discrepancy = 'under_declared';
      } else if (actualCount < declaredCount) {
        discrepancy = 'over_declared';
      } else {
        discrepancy = 'matched';
      }
      
      const potentialFeeAdjustment = calculatePotentialFeeAdjustment(
        durationMinutes,
        declaredCount,
        actualCount
      );
      
      if (discrepancy === 'under_declared' && !row.reconciliation_status) {
        totalPotentialFeeAdjustment += potentialFeeAdjustment;
      }
      
      return {
        bookingId: row.id,
        userEmail: row.user_email,
        userName: row.user_name,
        requestDate: row.request_date,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes,
        declaredCount,
        actualCount,
        discrepancy,
        discrepancyAmount: Math.abs(actualCount - declaredCount),
        requiresReview: discrepancy === 'under_declared' && !row.reconciliation_status,
        potentialFeeAdjustment,
        reconciliationStatus: row.reconciliation_status,
        reconciledBy: row.reconciled_by,
        reconciledAt: row.reconciled_at,
        resourceId: row.resource_id,
        trackmanBookingId: row.trackman_booking_id
      };
    });
    
    const stats: ReconciliationStats = {
      totalDiscrepancies: parseInt(statsResult.rows[0].total_discrepancies) || 0,
      pendingReview: parseInt(statsResult.rows[0].pending_review) || 0,
      reviewed: parseInt(statsResult.rows[0].reviewed) || 0,
      adjusted: parseInt(statsResult.rows[0].adjusted) || 0,
      totalPotentialFeeAdjustment
    };
    
    return { discrepancies, stats, totalCount };
  } catch (error) {
    logger.error('[findAttendanceDiscrepancies] Error:', { error: error as Error });
    throw error;
  }
}

export async function markAsReconciled(
  bookingId: number,
  staffEmail: string,
  status: 'reviewed' | 'adjusted',
  notes?: string
): Promise<{ success: boolean; booking?: Record<string, unknown> }> {
  try {
    const bookingResult = await pool.query(
      `SELECT id, declared_player_count, trackman_player_count, duration_minutes, 
              user_email, reconciliation_status, session_id
       FROM booking_requests 
       WHERE id = $1`,
      [bookingId]
    );
    
    if (bookingResult.rowCount === 0) {
      return { success: false };
    }
    
    const booking = bookingResult.rows[0];
    const previousStatus = booking.reconciliation_status;
    
    const updateResult = await pool.query(
      `UPDATE booking_requests 
       SET reconciliation_status = $1,
           reconciled_by = $2,
           reconciled_at = NOW(),
           reconciliation_notes = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, staffEmail, notes || null, bookingId]
    );
    
    if (status === 'adjusted') {
      const declaredCount = parseInt(booking.declared_player_count) || 0;
      const actualCount = parseInt(booking.trackman_player_count) || 0;
      const durationMinutes = parseInt(booking.duration_minutes) || 0;
      const feeAdjustment = calculatePotentialFeeAdjustment(durationMinutes, declaredCount, actualCount);
      
      await pool.query(
        `INSERT INTO booking_payment_audit 
         (booking_id, session_id, action, staff_email, reason, amount_affected, previous_status, new_status, metadata)
         VALUES ($1, $2, 'reconciliation_adjusted', $3, $4, $5, $6, $7, $8)`,
        [
          bookingId,
          booking.session_id,
          staffEmail,
          notes || `Attendance reconciliation: declared ${declaredCount}, actual ${actualCount}`,
          feeAdjustment.toString(),
          previousStatus || 'pending',
          status,
          JSON.stringify({
            declaredCount,
            actualCount,
            discrepancy: actualCount > declaredCount ? 'under_declared' : 'over_declared',
            durationMinutes,
            feeAdjustment
          })
        ]
      );
      
      logger.info('[markAsReconciled] Booking reconciled with fee adjustment', {
        extra: {
          bookingId,
          staffEmail,
          status,
          declaredCount,
          actualCount,
          feeAdjustment,
          memberEmail: booking.user_email
        }
      });
    } else {
      logger.info('[markAsReconciled] Booking marked as reviewed', {
        extra: {
          bookingId,
          staffEmail,
          status,
          notes
        }
      });
    }
    
    return { success: true, booking: updateResult.rows[0] };
  } catch (error) {
    logger.error('[markAsReconciled] Error:', { error: error as Error });
    throw error;
  }
}

export async function getReconciliationSummary(): Promise<{
  stats: ReconciliationStats;
  recentDiscrepancies: ReconciliationResult[];
}> {
  try {
    const { discrepancies, stats } = await findAttendanceDiscrepancies({
      status: 'pending',
      limit: 10
    });
    
    return {
      stats,
      recentDiscrepancies: discrepancies
    };
  } catch (error) {
    logger.error('[getReconciliationSummary] Error:', { error: error as Error });
    throw error;
  }
}

export async function adjustLedgerForReconciliation(
  bookingId: number,
  staffEmail: string,
  notes?: string
): Promise<{ success: boolean; adjustmentAmount: number }> {
  try {
    const bookingResult = await pool.query(
      `SELECT br.id, br.declared_player_count, br.trackman_player_count, br.duration_minutes,
              br.user_email, br.session_id, u.tier
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE br.id = $1`,
      [bookingId]
    );
    
    if (bookingResult.rowCount === 0) {
      return { success: false, adjustmentAmount: 0 };
    }
    
    const booking = bookingResult.rows[0];
    const declaredCount = parseInt(booking.declared_player_count) || 0;
    const actualCount = parseInt(booking.trackman_player_count) || 0;
    const durationMinutes = parseInt(booking.duration_minutes) || 0;
    
    if (actualCount <= declaredCount) {
      return { success: true, adjustmentAmount: 0 };
    }
    
    const overageRate = await getTierOverageRate(booking.tier);
    const feeAdjustment = calculatePotentialFeeAdjustment(durationMinutes, declaredCount, actualCount, overageRate);
    
    if (booking.session_id && feeAdjustment > 0) {
      await pool.query(
        `INSERT INTO usage_ledger 
         (session_id, member_id, minutes_charged, overage_fee, tier_at_booking, payment_method, source)
         VALUES ($1, $2, $3, $4, $5, 'unpaid', 'staff_manual')`,
        [
          booking.session_id,
          booking.user_email,
          0,
          feeAdjustment.toString(),
          booking.tier || 'unknown'
        ]
      );
    }
    
    await markAsReconciled(bookingId, staffEmail, 'adjusted', notes);
    
    logger.info('[adjustLedgerForReconciliation] Ledger adjusted', {
      extra: {
        bookingId,
        sessionId: booking.session_id,
        memberEmail: booking.user_email,
        adjustmentAmount: feeAdjustment,
        staffEmail
      }
    });
    
    return { success: true, adjustmentAmount: feeAdjustment };
  } catch (error) {
    logger.error('[adjustLedgerForReconciliation] Error:', { error: error as Error });
    throw error;
  }
}
