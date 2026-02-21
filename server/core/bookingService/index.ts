/**
 * BookingService Module - Phase 2 Implementation
 * 
 * Central service layer for multi-member booking operations.
 * 
 * PHASE 2 SCOPE:
 * - Tier rules validation (enforceSocialTierRules, validateTierWindowAndBalance)
 * - Usage calculation (computeUsageAllocation, calculateOverageFee, assignGuestTimeToHost)
 * - Session management (createSession, recordUsage, linkParticipants)
 * - Unified availability (checkUnifiedAvailability, getAvailableSlots)
 * - Orchestrated session creation (createSessionWithUsageTracking)
 * 
 * KNOWN CONSTRAINTS:
 * - Weekly limits NOT implemented (only daily_sim_minutes enforced)
 * - usage_ledger.member_id uses EMAILS (matching existing data pattern)
 * - resolveUserIdToEmail() handles UUID→email conversion for tier lookups
 * 
 * INTEGRATION (Phase 3):
 * - Wire createSessionWithUsageTracking into booking routes
 * - Add UI for player count and duration selection
 */
export {
  validateTierWindowAndBalance,
  getRemainingMinutes,
  enforceSocialTierRules,
  getGuestPassesRemaining,
  getMemberTier,
  getTierLimits,
  type TierValidationResult,
  type SocialTierResult,
  type ParticipantForValidation,
  type TierLimits
} from './tierRules';

export {
  computeUsageAllocation,
  calculateOverageFee,
  assignGuestTimeToHost,
  computeTotalSessionCost,
  formatOverageFee,
  formatOverageFeeFromDollars,
  OVERAGE_RATE_PER_30_MIN,
  OVERAGE_RATE_PER_HOUR,
  type Participant,
  type UsageAllocation,
  type OverageFeeResult,
  type GuestTimeAssignment
} from './usageCalculator';

export {
  createSession,
  linkParticipants,
  recordUsage,
  getSessionById,
  getSessionParticipants,
  createOrFindGuest,
  linkBookingRequestToSession,
  createSessionWithUsageTracking,
  type BookingSource,
  type ParticipantType,
  type PaymentMethod,
  type CreateSessionRequest,
  type ParticipantInput,
  type RecordUsageInput,
  type OrchestratedSessionRequest,
  type OrchestratedSessionResult
} from './sessionManager';

export {
  checkUnifiedAvailability,
  getAvailableSlots,
  isResourceAvailableForDate,
  parseTimeToMinutes,
  hasTimeOverlap,
  type AvailabilityResult
} from './availabilityGuard';

export {
  approveBooking,
  declineBooking,
  updateGenericStatus,
  checkinBooking,
  devConfirmBooking,
  validateTrackmanId,
  formatBookingRow
} from './approvalService';

export { BookingStateService } from './bookingStateService';
