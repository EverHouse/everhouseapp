import { db } from '../../db';
import { bookingRequests, users, resources } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from '../logger';
import { getMemberTierByEmail } from '../tierService';
import { isBookingInvoicePaid } from '../billing/bookingInvoiceService';
import { getErrorMessage } from '../../utils/errorUtils';
import type { FeeBreakdown } from '../../../shared/models/billing';
import type { BookingParticipant } from '../../../shared/models/scheduling';

export interface BookingWithSession {
  booking_id: number;
  owner_email: string;
  owner_name: string | null;
  request_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  declared_player_count: number | null;
  status: string;
  session_id: number | null;
  resource_id: number | null;
  notes: string | null;
  staff_notes: string | null;
  roster_version: number | null;
  trackman_booking_id: string | null;
  resource_name: string | null;
  owner_tier: string | null;
}

export interface ParticipantRow {
  id: number;
  sessionId: number;
  userId: string | null;
  guestId: number | null;
  participantType: string;
  displayName: string;
  slotDuration: number | null;
  paymentStatus: string | null;
  createdAt: Date | null;
}

export interface BookingParticipantsResult {
  booking: {
    id: number;
    ownerEmail: string;
    ownerName: string | null;
    requestDate: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    resourceId: number | null;
    resourceName: string | null;
    status: string;
    sessionId: number | null;
    notes: string | null;
    staffNotes: string | null;
  };
  declaredPlayerCount: number;
  currentParticipantCount: number;
  remainingSlots: number;
  participants: ParticipantRow[];
  ownerTier: string | null;
  guestPassesRemaining: number;
  guestPassesUsed: number;
  remainingMinutes: number;
  rosterVersion: number;
}

interface ProvisionalParticipant {
  type: string;
  name: string;
  email?: string;
}

interface FeeParticipantInput {
  userId?: string;
  email?: string;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
}

interface AllocationItem {
  displayName: string;
  type: string;
  minutes: number;
  feeCents?: number;
}

interface PreviewFeesBookingInfo {
  id: number;
  durationMinutes: number;
  startTime: string;
  endTime: string;
}

interface PreviewFeesParticipantCounts {
  total: number;
  members: number;
  guests: number;
  owner: number;
}

interface PreviewFeesTimeAllocation {
  totalMinutes: number;
  declaredPlayerCount: number;
  actualParticipantCount: number;
  effectivePlayerCount: number;
  totalSlots: number;
  minutesPerParticipant: number;
  allocations: AllocationItem[];
}

interface PreviewFeesOwnerFees {
  tier: string | null;
  dailyAllowance: number;
  remainingMinutesToday: number;
  ownerMinutesUsed: number;
  guestMinutesCharged: number;
  totalMinutesResponsible: number;
  minutesWithinAllowance: number;
  overageMinutes: number;
  estimatedOverageFee: number;
  estimatedGuestFees?: number;
  estimatedTotalFees?: number;
}

interface PreviewFeesGuestPasses {
  monthlyAllowance: number;
  remaining: number;
  usedThisBooking: number;
  afterBooking: number;
}

export interface PreviewFeesResult {
  booking: PreviewFeesBookingInfo;
  participants: PreviewFeesParticipantCounts;
  timeAllocation: PreviewFeesTimeAllocation;
  ownerFees: PreviewFeesOwnerFees;
  guestPasses: PreviewFeesGuestPasses;
  unifiedBreakdown?: FeeBreakdown;
  allPaid?: boolean;
}

export interface SessionUser {
  id?: string;
  email: string;
}

export interface AddParticipantParams {
  bookingId: number;
  type: 'member' | 'guest';
  userId?: string;
  guest?: { name: string; email: string };
  rosterVersion?: number;
  userEmail: string;
  sessionUserId?: string;
  deferFeeRecalc?: boolean;
  useGuestPass?: boolean;
}

export interface AddParticipantResult {
  participant: BookingParticipant;
  message: string;
  guestPassesRemaining?: number;
  newRosterVersion: number;
}

export interface RemoveParticipantParams {
  bookingId: number;
  participantId: number;
  rosterVersion?: number;
  userEmail: string;
  sessionUserId?: string;
  deferFeeRecalc?: boolean;
}

export interface RemoveParticipantResult {
  message: string;
  guestPassesRemaining?: number;
  newRosterVersion: number;
}

export interface UpdatePlayerCountParams {
  bookingId: number;
  playerCount: number;
  staffEmail: string;
  deferFeeRecalc?: boolean;
}

export interface UpdatePlayerCountResult {
  previousCount: number;
  newCount: number;
  feesRecalculated: boolean;
}

export interface RosterOperation {
  type: 'add_member' | 'remove_participant' | 'add_guest' | 'update_player_count';
  memberIdOrEmail?: string;
  participantId?: number;
  guest?: { name: string; email: string; phone?: string };
  playerCount?: number;
}

export interface BatchRosterUpdateParams {
  bookingId: number;
  rosterVersion: number;
  operations: RosterOperation[];
  staffEmail: string;
}

export interface BatchRosterUpdateResult {
  message: string;
  newRosterVersion: number;
  operationResults: Array<{ type: string; success: boolean; error?: string }>;
  feesRecalculated: boolean;
}

export { type ProvisionalParticipant, type FeeParticipantInput, type AllocationItem };

export interface FallbackPreviewParams {
  booking: BookingWithSession;
  durationMinutes: number;
  declaredPlayerCount: number;
  totalSlots: number;
  minutesPerPlayer: number;
  actualParticipantCount: number;
  effectivePlayerCount: number;
  dailyAllowance: number;
  remainingMinutesToday: number;
  guestPassesPerMonth: number;
  ownerTier: string | null;
  allParticipants: Array<{ participantType: string; displayName: string }>;
  participantsForFeeCalc: FeeParticipantInput[];
  guestCount: number;
  memberCount: number;
  isConferenceRoom: boolean;
}

export function createServiceError(message: string, statusCode: number, extra?: Record<string, unknown>): Error & { statusCode: number; extra?: Record<string, unknown> } {
  const err = new Error(message) as Error & { statusCode: number; extra?: Record<string, unknown> };
  err.statusCode = statusCode;
  if (extra) err.extra = extra;
  return err;
}

export async function enforceRosterLock(bookingId: number, options?: { forceOverride?: boolean; overrideReason?: string; staffEmail?: string }): Promise<void> {
  if (options?.forceOverride && options?.overrideReason) {
    logger.warn('[RosterService] Roster lock overridden by staff', {
      extra: { bookingId, staffEmail: options.staffEmail, overrideReason: options.overrideReason }
    });
    return;
  }

  const lockStatus = await isBookingInvoicePaid(bookingId);
  if (lockStatus.locked) {
    const err = new Error(`ROSTER_LOCKED: This booking's invoice has already been paid. To make roster changes, please contact a manager to void or refund the existing invoice first.`) as Error & { statusCode: number };
    err.statusCode = 423;
    throw err;
  }
}

export async function isStaffOrAdminCheck(email: string): Promise<boolean> {
  const { isAdminEmail, getAuthPool, queryWithRetry } = await import('../../replit_integrations/auth/replitAuth');
  const isAdmin = await isAdminEmail(email);
  if (isAdmin) return true;

  const authPool = getAuthPool();
  if (!authPool) return false;

  try {
    const result = await queryWithRetry(
      authPool,
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    return (result as { rows: { id: string }[] }).rows.length > 0;
  } catch (error: unknown) {
    logger.error('[isStaffOrAdminCheck] DB error, defaulting to false', { extra: { error: getErrorMessage(error) } });
    return false;
  }
}

export async function getBookingWithSession(bookingId: number): Promise<BookingWithSession | null> {
  const result = await db.execute(sql`SELECT 
      br.id as booking_id,
      br.user_email as owner_email,
      br.user_name as owner_name,
      br.request_date,
      br.start_time,
      br.end_time,
      br.duration_minutes,
      br.declared_player_count,
      br.status,
      br.session_id,
      br.resource_id,
      br.notes,
      br.staff_notes,
      br.roster_version,
      br.trackman_booking_id,
      r.name as resource_name,
      u.tier as owner_tier
    FROM booking_requests br
    LEFT JOIN resources r ON br.resource_id = r.id
    LEFT JOIN users u ON LOWER(br.user_email) = LOWER(u.email)
    WHERE br.id = ${bookingId}`);
  return (result.rows[0] as unknown as BookingWithSession) || null;
}
