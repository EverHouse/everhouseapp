import { users } from '../../../shared/schema';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { logger } from '../../core/logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { finalizeInvoicePaidOutOfBand, voidBookingInvoice, syncBookingInvoice, getBookingInvoiceId } from '../../core/billing/bookingInvoiceService';
import { broadcastBookingInvoiceUpdate } from '../../core/websocket';

export interface SettleParticipantRow {
  payment_status: string;
  cached_fee_cents: number;
}

export interface BookingContextRow {
  booking_id: number;
  session_id: number | null;
  resource_id: number;
  owner_id: string;
  owner_email: string;
  owner_name: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  member_notes: string | null;
  declared_player_count: number;
  resource_name: string;
}

export interface UserIdRow {
  id: string;
}

export interface CountRow {
  count: string;
}

export interface MemberParticipantRow {
  id: number;
  display_name: string;
  user_id: string | null;
  resolved_user_id: string | null;
}

export interface ParticipantDetailRow {
  participant_id: number;
  display_name: string;
  participant_type: 'owner' | 'member' | 'guest';
  user_id: string | null;
  payment_status: string;
  waiver_reviewed_at: string | null;
  used_guest_pass: boolean;
  cached_total_fee: string;
}

export interface SnapshotRow {
  participant_fees: unknown;
}

export interface AuditRow {
  action: string;
  staff_email: string;
  staff_name: string | null;
  reason: string | null;
  created_at: Date;
}

export interface PaymentBookingRow {
  session_id: number | null;
  owner_email: string;
  resource_name: string;
  resource_id: number;
  booking_date: string;
  start_time: string;
  end_time: string;
  declared_player_count: number;
  owner_name: string;
}

export interface ParticipantStatusRow {
  payment_status: string;
  participant_type: string;
  display_name: string;
  session_date: string;
}

export interface PaymentIntentIdRow {
  stripe_payment_intent_id: string;
}

export interface PendingParticipantRow {
  id: number;
  payment_status: string;
}

export interface _IdRow {
  id: number;
}

export interface _IdSessionRow {
  id: number;
  session_id: number;
}

export interface _SessionBookingRow {
  session_id: number;
  booking_id: number;
}

export interface _ParticipantCheckRow {
  id: number;
  session_id: number;
  display_name: string;
  booking_id: number;
}

export interface _SessionIdRow {
  session_id: number;
}

export interface DirectAddBookingRow {
  session_id: number | null;
  resource_id: number;
  request_date: string;
  owner_email: string;
  user_name: string;
  start_time: string;
  end_time: string;
  resource_name?: string;
  user_email?: string;
}

export interface TierRow {
  tier_name: string;
  guest_passes: number;
}

export interface MemberMatchRow {
  id: string;
  display_name: string;
  email: string;
}

export interface FeeSumRow {
  total_cents: string;
  overage_cents: string;
  guest_cents: string;
}

export interface OwnerRow {
  id: string;
  name: string;
}

export interface MemberDetailRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  tier_name: string;
  can_book_simulators: boolean;
}

export interface MatchingGuestRow {
  id: number;
  display_name: string;
}

export interface QrBookingRow {
  id: number;
  start_time: string;
  end_time: string;
  bay_name: string;
  resource_type: string;
}

export interface _WaiverBookingRow {
  session_id: number;
  owner_email: string;
}

export interface ParticipantFee {
  participantId: number;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  userId: string | null;
  paymentStatus: 'pending' | 'paid' | 'waived';
  overageFee: number;
  guestFee: number;
  totalFee: number;
  tierAtBooking: string | null;
  dailyAllowance?: number;
  minutesUsed?: number;
  guestPassUsed?: boolean;
  prepaidOnline?: boolean;
  cachedFeeCents?: number | null;
}

export interface CheckinContext {
  bookingId: number;
  sessionId: number | null;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  memberNotes: string | null;
  participants: ParticipantFee[];
  totalOutstanding: number;
  hasUnpaidBalance: boolean;
  auditHistory: Array<{
    action: string;
    staffEmail: string;
    staffName: string | null;
    reason: string | null;
    createdAt: Date;
  }>;
}

export interface OverduePayment {
  bookingId: number;
  sessionId: number;
  ownerEmail: string;
  ownerName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  totalOutstanding: number;
}

export const settlementInFlight = new Set<number>();

export async function _getMemberDisplayName(email: string): Promise<string> {
  try {
    const normalizedEmail = email.toLowerCase();
    const result = await db.select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .limit(1);
    
    if (result.length > 0 && (result[0].firstName || result[0].lastName)) {
      return [result[0].firstName, result[0].lastName].filter(Boolean).join(' ');
    }
  } catch (error: unknown) {
    logger.error('[StaffCheckin] Error looking up member name', { error: getErrorMessage(error) });
  }
  return email.split('@')[0];
}

export async function settleBookingInvoiceAfterCheckin(bookingId: number, sessionId: number | null, ownerEmail?: string): Promise<void> {
  if (!sessionId) return;
  
  if (settlementInFlight.has(bookingId)) {
    logger.info('[StaffCheckin] Settlement already in-flight for booking, skipping duplicate', { extra: { bookingId } });
    return;
  }
  settlementInFlight.add(bookingId);

  try {
    const invoiceId = await getBookingInvoiceId(bookingId);
    if (!invoiceId) {
      syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
        logger.warn('[StaffCheckin] Non-blocking: Failed to create invoice for booking with no existing invoice', {
          extra: { bookingId, sessionId, error: getErrorMessage(err) }
        });
      });
      return;
    }
    
    const participantResult = await db.execute(
      sql`SELECT payment_status, cached_fee_cents FROM booking_participants WHERE session_id = ${sessionId}`
    );
    
    const participants = participantResult.rows as unknown as SettleParticipantRow[];
    const allSettled = participants.every((p) => 
      p.payment_status === 'paid' || p.payment_status === 'waived'
    );
    
    if (!allSettled) {
      syncBookingInvoice(bookingId, sessionId).catch((err: unknown) => {
        logger.warn('[StaffCheckin] Non-blocking: Failed to sync invoice after partial action', {
          extra: { bookingId, sessionId, error: getErrorMessage(err) }
        });
      });
      return;
    }
    
    const anyPaid = participants.some((p) => 
      p.payment_status === 'paid' && (p.cached_fee_cents || 0) > 0
    );
    
    if (anyPaid) {
      try {
        const oobResult = await finalizeInvoicePaidOutOfBand({
          bookingId,
          paidVia: 'cash',
        });
        if (oobResult.success) {
          logger.info('[StaffCheckin] Finalized invoice as paid OOB after check-in confirm', {
            extra: { bookingId, invoiceId }
          });
          broadcastBookingInvoiceUpdate({ bookingId, sessionId, action: 'invoice_finalized', memberEmail: ownerEmail });
        } else {
          logger.warn('[StaffCheckin] Failed to finalize invoice OOB, deleting draft instead', {
            extra: { bookingId, invoiceId, error: oobResult.error }
          });
          voidBookingInvoice(bookingId).catch((err: unknown) => {
            logger.warn('[StaffCheckin] Non-blocking: Failed to void invoice after OOB failure', {
              extra: { bookingId, error: getErrorMessage(err) }
            });
          });
        }
      } catch (finalizeErr: unknown) {
        logger.warn('[StaffCheckin] Non-blocking: Failed to finalize invoice OOB, voiding draft', {
          extra: { bookingId, invoiceId, error: getErrorMessage(finalizeErr) }
        });
        voidBookingInvoice(bookingId).catch((err: unknown) => {
          logger.warn('[StaffCheckin] Non-blocking: Failed to void invoice after OOB exception', {
            extra: { bookingId, error: getErrorMessage(err) }
          });
        });
      }
    } else {
      voidBookingInvoice(bookingId).catch((err: unknown) => {
        logger.warn('[StaffCheckin] Non-blocking: Failed to void invoice after all waived', {
          extra: { bookingId, error: getErrorMessage(err) }
        });
      });
      broadcastBookingInvoiceUpdate({ bookingId, sessionId, action: 'invoice_voided', memberEmail: ownerEmail });
    }
  } catch (err: unknown) {
    logger.warn('[StaffCheckin] Non-blocking: settleBookingInvoiceAfterCheckin failed', {
      extra: { bookingId, sessionId, error: getErrorMessage(err) }
    });
  } finally {
    settlementInFlight.delete(bookingId);
  }
}
