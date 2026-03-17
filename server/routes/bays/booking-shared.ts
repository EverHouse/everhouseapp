import { db } from '../../db';
import { users } from '../../../shared/schema';
import { sql, inArray } from 'drizzle-orm';
import { getMemberTierByEmail, getTierLimits, getDailyBookedMinutes } from '../../core/tierService';
import { logger } from '../../core/logger';
import { computeFeeBreakdown, applyFeeBreakdownToParticipants } from '../../core/billing/unifiedFeeService';
import { PRICING } from '../../core/billing/pricingConfig';

export class BookingValidationError extends Error {
  constructor(public statusCode: number, public errorBody: Record<string, unknown>) {
    super(typeof errorBody.error === 'string' ? errorBody.error : 'Booking validation error');
    this.name = 'BookingValidationError';
  }
}

export interface SanitizedParticipant {
  email: string;
  type: 'member' | 'guest';
  userId?: string;
  name?: string;
}

export interface InvoicePayResult {
  paidInFull: boolean;
  status: string;
  clientSecret?: string | null;
  amountFromBalance?: number;
}

export interface BookingInsertRow {
  id: number;
  userEmail: string;
  userName: string | null;
  resourceId: number | null;
  resourcePreference: string | null;
  requestDate: string;
  startTime: string;
  durationMinutes: number;
  endTime: string;
  notes: string | null;
  status: string | null;
  declaredPlayerCount: number | null;
  memberNotes: string | null;
  guardianName: string | null;
  guardianRelationship: string | null;
  guardianPhone: string | null;
  guardianConsentAt: Date | null;
  requestParticipants: SanitizedParticipant[];
  createdAt: Date | null;
  updatedAt: Date | null;
  staffNotes?: string | null;
  suggestedTime?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  calendarEventId?: string | null;
  _invoicePayResult?: InvoicePayResult;
}

export async function calculateFeeEstimate(params: {
  ownerEmail: string;
  durationMinutes: number;
  guestCount: number;
  requestDate: string;
  playerCount: number;
  sessionId?: number;
  bookingId?: number;
  resourceType?: string;
  guestsWithInfo?: number;
  memberEmails?: string[];
  memberEmailToUserId?: Map<string, string>;
}) {
  const { ownerEmail, durationMinutes, guestCount, requestDate, playerCount, sessionId, bookingId, resourceType } = params;
  
  const ownerTier = await getMemberTierByEmail(ownerEmail);
  const tierLimits = ownerTier ? await getTierLimits(ownerTier) : null;
  
  const isConferenceRoom = resourceType === 'conference_room';
  const dailyAllowance = isConferenceRoom 
    ? (tierLimits?.daily_conf_room_minutes || 0)
    : (tierLimits?.daily_sim_minutes || 0);
  const isUnlimitedTier = dailyAllowance >= 999;
  const isSocialTier = !isConferenceRoom && (tierLimits?.daily_sim_minutes || 0) === 0;
  
  const usedMinutesToday = requestDate ? await getDailyBookedMinutes(ownerEmail, requestDate, isConferenceRoom ? 'conference_room' : 'simulator') : 0;
  const perPersonMins = Math.floor(durationMinutes / playerCount);
  
  const participants: Array<{
    userId?: string;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
  }> = [
    { email: ownerEmail, displayName: 'Owner', participantType: 'owner' }
  ];
  
  const memberEmails = params.memberEmails || [];
  const emailToUserId = params.memberEmailToUserId || new Map<string, string>();
  for (let i = 0; i < memberEmails.length; i++) {
    const memberEmail = memberEmails[i];
    if (!memberEmail) continue;
    const memberUserId = emailToUserId.get(memberEmail);
    participants.push({ 
      userId: memberUserId,
      email: memberEmail, 
      displayName: `Member ${i + 1}`, 
      participantType: 'member' 
    });
  }
  
  const namedGuestCount = params.guestsWithInfo ?? guestCount;
  for (let i = 0; i < guestCount; i++) {
    if (i < namedGuestCount) {
      participants.push({ displayName: `Estimated Guest ${i + 1}`, participantType: 'guest' });
    } else {
      participants.push({ displayName: `Guest ${i + 1}`, participantType: 'guest' });
    }
  }
  
  try {
    logger.info('[FeeEstimate] Calculating for', { extra: { ownerEmail_ownerTier_durationMinutes_playerCount_perPersonMins_dailyAllowance_usedMinutesToday_isConferenceRoom_isUnlimitedTier_guestCount_requestDate: {
      ownerEmail,
      ownerTier,
      durationMinutes,
      playerCount,
      perPersonMins,
      dailyAllowance,
      usedMinutesToday,
      isConferenceRoom,
      isUnlimitedTier,
      guestCount,
      requestDate
    } } });
    
    const breakdown = await computeFeeBreakdown(
      sessionId 
        ? { sessionId, declaredPlayerCount: playerCount, source: 'preview' as const, isConferenceRoom, excludeSessionFromUsage: true }
        : {
            sessionDate: requestDate,
            sessionDuration: durationMinutes,
            declaredPlayerCount: playerCount,
            hostEmail: ownerEmail,
            participants,
            source: 'preview' as const,
            isConferenceRoom,
            bookingId
          }
    );

    if (sessionId && bookingId) {
      try {
        await applyFeeBreakdownToParticipants(sessionId, breakdown);
      } catch (syncErr: unknown) {
        logger.warn('[FeeEstimate] Non-blocking cache sync failed', { extra: { syncErr } });
      }
    }
    
    logger.info('[FeeEstimate] Unified breakdown result', { extra: { overageCents_breakdown_totals_overageCents_guestCents_breakdown_totals_guestCents_totalCents_breakdown_totals_totalCents_participants_breakdown_participants_map_p_type_p_participantType_tierName_p_tierName_dailyAllowance_p_dailyAllowance_usedMinutesToday_p_usedMinutesToday_minutesAllocated_p_minutesAllocated_overageCents_p_overageCents_guestCents_p_guestCents: {
      overageCents: breakdown.totals.overageCents,
      guestCents: breakdown.totals.guestCents,
      totalCents: breakdown.totals.totalCents,
      participants: breakdown.participants.map(p => ({
        type: p.participantType,
        tierName: p.tierName,
        dailyAllowance: p.dailyAllowance,
        usedMinutesToday: p.usedMinutesToday,
        minutesAllocated: p.minutesAllocated,
        overageCents: p.overageCents,
        guestCents: p.guestCents
      }))
    } } });
    
    const overageFee = Math.round(breakdown.totals.overageCents / 100);
    const guestFees = Math.round(breakdown.totals.guestCents / 100);
    const guestsUsingPasses = breakdown.totals.guestPassesUsed;
    const guestsCharged = Math.max(0, guestCount - guestsUsingPasses);
    
    const ownerLineItem = breakdown.participants.find(p => p.participantType === 'owner');
    const overageMinutes = ownerLineItem?.overageCents ? Math.ceil((ownerLineItem.overageCents / 100) / PRICING.OVERAGE_RATE_DOLLARS) * PRICING.OVERAGE_BLOCK_MINUTES : 0;
    
    return {
      ownerEmail,
      ownerTier,
      durationMinutes,
      playerCount,
      perPersonMins,
      tierInfo: {
        dailyAllowance,
        usedMinutesToday,
        remainingMinutes: Math.max(0, dailyAllowance - usedMinutesToday),
        isSocialTier,
        isUnlimitedTier
      },
      feeBreakdown: {
        overageMinutes,
        overageFee,
        guestCount,
        guestPassesRemaining: breakdown.totals.guestPassesAvailable,
        guestsUsingPasses,
        guestsCharged,
        guestFees,
        guestFeePerUnit: Math.round(PRICING.GUEST_FEE_CENTS / 100),
        overageRatePerBlock: Math.round(PRICING.OVERAGE_RATE_CENTS / 100),
      },
      totalFee: Math.round(breakdown.totals.totalCents / 100),
      note: isSocialTier 
        ? 'Social tier pays for all simulator time'
        : isUnlimitedTier 
          ? 'Unlimited access - no overage fees' 
          : overageFee > 0 
            ? `${overageMinutes} min over daily allowance`
            : 'Within daily allowance',
      unifiedBreakdown: breakdown
    };
  } catch (error: unknown) {
    logger.error('[FeeEstimate] Unified service error', { error: error instanceof Error ? error : new Error(String(error)) });
    throw new Error('Unable to calculate fee estimate. Please try again.', { cause: error });
  }
}
