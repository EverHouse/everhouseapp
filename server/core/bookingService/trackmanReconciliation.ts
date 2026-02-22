import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../logger';
import { getTierLimits, getMemberTierByEmail } from '../tierService';
import { PRICING } from '../billing/pricingConfig';
import { logPaymentAudit } from '../auditLog';
import { recordUsage } from './sessionManager';

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
    const result = await db.execute(sql`SELECT guest_fee_cents FROM membership_tiers WHERE LOWER(slug) = LOWER(${tier}) OR LOWER(name) = LOWER(${tier}) LIMIT 1`);
    
    if (result.rows.length > 0 && (result.rows[0] as Record<string, unknown>).guest_fee_cents) {
      return Math.round((result.rows[0] as Record<string, unknown>).guest_fee_cents as number / 100);
    }
  } catch (error: unknown) {
    logger.warn('[getTierOverageRate] Failed to fetch tier overage rate, using default', { extra: { tier, error } });
  }
  
  return DEFAULT_OVERAGE_RATE_PER_30_MIN;
}

function calculatePotentialFeeAdjustment(
  _durationMinutes: number,
  declaredCount: number,
  actualCount: number,
  _overageRatePer30Min: number = DEFAULT_OVERAGE_RATE_PER_30_MIN
): number {
  if (actualCount <= declaredCount) return 0;
  
  const additionalPlayers = actualCount - declaredCount;
  return additionalPlayers * (PRICING.GUEST_FEE_CENTS / 100);
}

export async function findAttendanceDiscrepancies(
  options: FindDiscrepanciesOptions = {}
): Promise<{ discrepancies: ReconciliationResult[]; stats: ReconciliationStats; totalCount: number }> {
  const { startDate, endDate, status = 'all', limit = 100, offset = 0 } = options;
  
  try {
    const baseConditions = sql`br.status = 'attended'
      AND br.trackman_booking_id IS NOT NULL
      AND br.trackman_player_count IS NOT NULL
      AND br.declared_player_count IS NOT NULL
      AND br.trackman_player_count != br.declared_player_count`;
    
    const dateStartFilter = startDate ? sql`AND br.request_date >= ${startDate}` : sql``;
    const dateEndFilter = endDate ? sql`AND br.request_date <= ${endDate}` : sql``;
    
    let statusFilter = sql``;
    if (status !== 'all') {
      if (status === 'pending') {
        statusFilter = sql`AND (br.reconciliation_status IS NULL OR br.reconciliation_status = 'pending')`;
      } else {
        statusFilter = sql`AND br.reconciliation_status = ${status}`;
      }
    }
    
    const whereClause = sql`${baseConditions} ${dateStartFilter} ${dateEndFilter} ${statusFilter}`;
    
    const countResult = await db.execute(sql`SELECT COUNT(*) as total FROM booking_requests br WHERE ${whereClause}`);
    const totalCount = parseInt((countResult.rows[0] as Record<string, unknown>).total as string, 10);
    
    const statsResult = await db.execute(sql`SELECT 
        COUNT(*) as total_discrepancies,
        COUNT(*) FILTER (WHERE reconciliation_status IS NULL OR reconciliation_status = 'pending') as pending_review,
        COUNT(*) FILTER (WHERE reconciliation_status = 'reviewed') as reviewed,
        COUNT(*) FILTER (WHERE reconciliation_status = 'adjusted') as adjusted
       FROM booking_requests br
       WHERE ${whereClause}`);
    
    const result = await db.execute(sql`SELECT 
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
       WHERE ${whereClause}
       ORDER BY br.request_date DESC, br.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`);
    
    let totalPotentialFeeAdjustment = 0;
    
    const discrepancies: ReconciliationResult[] = (result.rows as Array<Record<string, unknown>>).map(row => {
      const declaredCount = parseInt(row.declared_player_count as string) || 0;
      const actualCount = parseInt(row.trackman_player_count as string) || 0;
      const durationMinutes = parseInt(row.duration_minutes as string) || 0;
      
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
        bookingId: row.id as number,
        userEmail: row.user_email as string,
        userName: row.user_name as string | null,
        requestDate: row.request_date as string,
        startTime: row.start_time as string,
        endTime: row.end_time as string,
        durationMinutes,
        declaredCount,
        actualCount,
        discrepancy,
        discrepancyAmount: Math.abs(actualCount - declaredCount),
        requiresReview: discrepancy === 'under_declared' && !row.reconciliation_status,
        potentialFeeAdjustment,
        reconciliationStatus: row.reconciliation_status as string | null,
        reconciledBy: row.reconciled_by as string | null,
        reconciledAt: row.reconciled_at as Date | null,
        resourceId: row.resource_id as number | null,
        trackmanBookingId: row.trackman_booking_id as string | null
      };
    });
    
    const statsRow = statsResult.rows[0] as Record<string, unknown>;
    const stats: ReconciliationStats = {
      totalDiscrepancies: parseInt(statsRow.total_discrepancies as string) || 0,
      pendingReview: parseInt(statsRow.pending_review as string) || 0,
      reviewed: parseInt(statsRow.reviewed as string) || 0,
      adjusted: parseInt(statsRow.adjusted as string) || 0,
      totalPotentialFeeAdjustment
    };
    
    return { discrepancies, stats, totalCount };
  } catch (error: unknown) {
    logger.error('[findAttendanceDiscrepancies] Error:', { error });
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
    const bookingResult = await db.execute(sql`SELECT id, declared_player_count, trackman_player_count, duration_minutes, 
              user_email, reconciliation_status, session_id
       FROM booking_requests 
       WHERE id = ${bookingId}`);
    
    if (bookingResult.rowCount === 0) {
      return { success: false };
    }
    
    const booking = bookingResult.rows[0] as Record<string, unknown>;
    const previousStatus = booking.reconciliation_status as string;
    
    const updateResult = await db.execute(sql`UPDATE booking_requests 
       SET reconciliation_status = ${status},
           reconciled_by = ${staffEmail},
           reconciled_at = NOW(),
           reconciliation_notes = ${notes || null},
           updated_at = NOW()
       WHERE id = ${bookingId}
       RETURNING *`);
    
    if (status === 'adjusted') {
      const declaredCount = parseInt(booking.declared_player_count as string) || 0;
      const actualCount = parseInt(booking.trackman_player_count as string) || 0;
      const durationMinutes = parseInt(booking.duration_minutes as string) || 0;
      const feeAdjustment = calculatePotentialFeeAdjustment(durationMinutes, declaredCount, actualCount);
      
      await logPaymentAudit({
        bookingId,
        sessionId: booking.session_id as number,
        action: 'reconciliation_adjusted',
        staffEmail,
        reason: notes || `Attendance reconciliation: declared ${declaredCount}, actual ${actualCount}`,
        amountAffected: feeAdjustment.toString(),
        previousStatus: previousStatus || 'pending',
        newStatus: status,
        metadata: {
          declaredCount,
          actualCount,
          discrepancy: actualCount > declaredCount ? 'under_declared' : 'over_declared',
          durationMinutes,
          feeAdjustment
        },
      });
      
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
    
    return { success: true, booking: updateResult.rows[0] as Record<string, unknown> };
  } catch (error: unknown) {
    logger.error('[markAsReconciled] Error:', { error });
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
  } catch (error: unknown) {
    logger.error('[getReconciliationSummary] Error:', { error });
    throw error;
  }
}

export async function adjustLedgerForReconciliation(
  bookingId: number,
  staffEmail: string,
  notes?: string
): Promise<{ success: boolean; adjustmentAmount: number }> {
  try {
    const bookingResult = await db.execute(sql`SELECT br.id, br.declared_player_count, br.trackman_player_count, br.duration_minutes,
              br.user_email, br.session_id, u.tier
       FROM booking_requests br
       LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
       WHERE br.id = ${bookingId}`);
    
    if (bookingResult.rowCount === 0) {
      return { success: false, adjustmentAmount: 0 };
    }
    
    const booking = bookingResult.rows[0] as Record<string, unknown>;
    const declaredCount = parseInt(booking.declared_player_count as string) || 0;
    const actualCount = parseInt(booking.trackman_player_count as string) || 0;
    const durationMinutes = parseInt(booking.duration_minutes as string) || 0;
    
    if (actualCount <= declaredCount) {
      return { success: true, adjustmentAmount: 0 };
    }
    
    const overageRate = await getTierOverageRate(booking.tier as string | null);
    const feeAdjustment = calculatePotentialFeeAdjustment(durationMinutes, declaredCount, actualCount, overageRate);
    
    if (booking.session_id && feeAdjustment > 0) {
      await recordUsage(
        booking.session_id as number,
        {
          memberId: booking.user_email as string,
          minutesCharged: 0,
          overageFee: feeAdjustment,
          guestFee: 0,
          tierAtBooking: (booking.tier as string) || 'unknown',
          paymentMethod: 'unpaid',
        },
        'staff_manual'
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
  } catch (error: unknown) {
    logger.error('[adjustLedgerForReconciliation] Error:', { error });
    throw error;
  }
}
