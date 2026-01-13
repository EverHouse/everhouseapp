import { db } from '../../db';
import { pool } from '../db';
import { 
  bookingSessions, 
  bookingParticipants, 
  usageLedger,
  guests,
  InsertBookingSession,
  InsertBookingParticipant,
  InsertUsageLedger,
  BookingSession,
  BookingParticipant
} from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../logger';
import { getMemberTierByEmail } from '../tierService';

export type BookingSource = 'member_request' | 'staff_manual' | 'trackman_import';
export type ParticipantType = 'owner' | 'member' | 'guest';
export type PaymentMethod = 'guest_pass' | 'credit_card' | 'unpaid' | 'waived';

export interface CreateSessionRequest {
  resourceId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  trackmanBookingId?: string;
  createdBy?: string;
}

export interface ParticipantInput {
  userId?: string;
  guestId?: number;
  participantType: ParticipantType;
  displayName: string;
  slotDuration?: number;
  trackmanPlayerRowId?: string;
  invitedAt?: Date;
  inviteExpiresAt?: Date;
}

export interface RecordUsageInput {
  memberId?: string;
  minutesCharged: number;
  overageFee?: number;
  guestFee?: number;
  tierAtBooking?: string;
  paymentMethod?: PaymentMethod;
}

export async function createSession(
  request: CreateSessionRequest,
  participants: ParticipantInput[],
  source: BookingSource = 'member_request'
): Promise<{ session: BookingSession; participants: BookingParticipant[] }> {
  try {
    const sessionData: InsertBookingSession = {
      resourceId: request.resourceId,
      sessionDate: request.sessionDate,
      startTime: request.startTime,
      endTime: request.endTime,
      trackmanBookingId: request.trackmanBookingId,
      source,
      createdBy: request.createdBy
    };
    
    const [session] = await db
      .insert(bookingSessions)
      .values(sessionData)
      .returning();
    
    const linkedParticipants = await linkParticipants(session.id, participants);
    
    logger.info('[createSession] Session created', {
      extra: { 
        sessionId: session.id, 
        participantCount: linkedParticipants.length,
        source 
      }
    });
    
    return { session, participants: linkedParticipants };
  } catch (error) {
    logger.error('[createSession] Error creating session:', { error: error as Error });
    throw error;
  }
}

export async function linkParticipants(
  sessionId: number,
  participants: ParticipantInput[]
): Promise<BookingParticipant[]> {
  if (!participants || participants.length === 0) {
    return [];
  }
  
  try {
    const participantRecords: InsertBookingParticipant[] = participants.map(p => ({
      sessionId,
      userId: p.userId,
      guestId: p.guestId,
      participantType: p.participantType,
      displayName: p.displayName,
      slotDuration: p.slotDuration,
      trackmanPlayerRowId: p.trackmanPlayerRowId,
      inviteStatus: p.participantType === 'owner' ? 'accepted' : 'pending',
      invitedAt: p.invitedAt || new Date(),
      inviteExpiresAt: p.inviteExpiresAt
    }));
    
    const inserted = await db
      .insert(bookingParticipants)
      .values(participantRecords)
      .returning();
    
    return inserted;
  } catch (error) {
    logger.error('[linkParticipants] Error linking participants:', { error: error as Error });
    throw error;
  }
}

export async function recordUsage(
  sessionId: number,
  input: RecordUsageInput,
  source: BookingSource = 'member_request'
): Promise<void> {
  try {
    let tierAtBooking = input.tierAtBooking;
    
    if (!tierAtBooking && input.memberId) {
      const result = await pool.query(
        `SELECT email FROM users WHERE id = $1 LIMIT 1`,
        [input.memberId]
      );
      if (result.rows[0]?.email) {
        tierAtBooking = await getMemberTierByEmail(result.rows[0].email) || undefined;
      }
    }
    
    const usageData: InsertUsageLedger = {
      sessionId,
      memberId: input.memberId,
      minutesCharged: input.minutesCharged,
      overageFee: input.overageFee?.toString() ?? '0.00',
      guestFee: input.guestFee?.toString() ?? '0.00',
      tierAtBooking,
      paymentMethod: input.paymentMethod ?? 'unpaid',
      source
    };
    
    await db.insert(usageLedger).values(usageData);
    
    logger.info('[recordUsage] Usage recorded', {
      extra: { 
        sessionId, 
        memberId: input.memberId,
        minutes: input.minutesCharged,
        overageFee: input.overageFee,
        tier: tierAtBooking
      }
    });
  } catch (error) {
    logger.error('[recordUsage] Error recording usage:', { error: error as Error });
    throw error;
  }
}

export async function getSessionById(sessionId: number): Promise<BookingSession | null> {
  try {
    const sessions = await db
      .select()
      .from(bookingSessions)
      .where(eq(bookingSessions.id, sessionId))
      .limit(1);
    
    return sessions[0] || null;
  } catch (error) {
    logger.error('[getSessionById] Error:', { error: error as Error });
    return null;
  }
}

export async function getSessionParticipants(sessionId: number): Promise<BookingParticipant[]> {
  try {
    return await db
      .select()
      .from(bookingParticipants)
      .where(eq(bookingParticipants.sessionId, sessionId));
  } catch (error) {
    logger.error('[getSessionParticipants] Error:', { error: error as Error });
    return [];
  }
}

export async function updateParticipantInviteStatus(
  participantId: number,
  status: 'pending' | 'accepted' | 'declined'
): Promise<void> {
  try {
    await db
      .update(bookingParticipants)
      .set({ 
        inviteStatus: status,
        respondedAt: status !== 'pending' ? new Date() : undefined
      })
      .where(eq(bookingParticipants.id, participantId));
  } catch (error) {
    logger.error('[updateParticipantInviteStatus] Error:', { error: error as Error });
    throw error;
  }
}

export async function createOrFindGuest(
  name: string,
  email?: string,
  phone?: string,
  createdByMemberId?: string
): Promise<number> {
  try {
    if (email) {
      const existing = await db
        .select()
        .from(guests)
        .where(eq(guests.email, email.toLowerCase()))
        .limit(1);
      
      if (existing[0]) {
        await db
          .update(guests)
          .set({ lastVisitDate: new Date().toISOString().split('T')[0] })
          .where(eq(guests.id, existing[0].id));
        
        return existing[0].id;
      }
    }
    
    const [newGuest] = await db
      .insert(guests)
      .values({
        name,
        email: email?.toLowerCase(),
        phone,
        createdByMemberId,
        lastVisitDate: new Date().toISOString().split('T')[0]
      })
      .returning();
    
    return newGuest.id;
  } catch (error) {
    logger.error('[createOrFindGuest] Error:', { error: error as Error });
    throw error;
  }
}

export async function linkBookingRequestToSession(
  bookingRequestId: number,
  sessionId: number
): Promise<void> {
  try {
    await pool.query(
      `UPDATE booking_requests SET session_id = $1, updated_at = NOW() WHERE id = $2`,
      [sessionId, bookingRequestId]
    );
  } catch (error) {
    logger.error('[linkBookingRequestToSession] Error:', { error: error as Error });
    throw error;
  }
}

// Import tier rules for orchestration
import { enforceSocialTierRules, getMemberTier, type ParticipantForValidation } from './tierRules';
import { 
  computeUsageAllocation, 
  assignGuestTimeToHost, 
  calculateFullSessionBilling,
  type Participant as UsageParticipant 
} from './usageCalculator';
import { users } from '../../../shared/schema';

/**
 * Resolves a user ID (UUID) to their email address.
 * Returns null if the user is not found or if the input is already an email.
 */
async function resolveUserIdToEmail(userId: string): Promise<string | null> {
  // If it's already an email format (contains @), return it directly
  if (userId.includes('@')) {
    return userId;
  }
  
  try {
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    
    return user?.email || null;
  } catch (error) {
    logger.error('[resolveUserIdToEmail] Error resolving user ID', { 
      error: error as Error,
      extra: { userId }
    });
    return null;
  }
}

export interface OrchestratedSessionRequest {
  ownerEmail: string;
  resourceId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  participants: ParticipantInput[];
  trackmanBookingId?: string;
}

export interface OrchestratedSessionResult {
  success: boolean;
  session?: BookingSession;
  participants?: BookingParticipant[];
  usageLedgerEntries?: number;
  error?: string;
  errorType?: 'social_tier_blocked' | 'validation_failed' | 'database_error';
}

/**
 * Orchestrated session creation that:
 * 1. Enforces Social tier rules (blocks guests for Social hosts)
 * 2. Creates the session with linked participants
 * 3. Computes usage allocation across all participants
 * 4. Uses assignGuestTimeToHost for guest-minute reassignment with overage calculation
 * 5. Records usage ledger entries
 * 
 * Note: userId in ParticipantInput can be either a UUID or email.
 * This function resolves UUIDs to emails for tier lookups and ledger writes.
 * usage_ledger.member_id stores emails for consistency with existing data.
 */
export async function createSessionWithUsageTracking(
  request: OrchestratedSessionRequest,
  source: BookingSource = 'member_request'
): Promise<OrchestratedSessionResult> {
  try {
    // Step 1: Get owner's tier and enforce Social tier rules
    const ownerTier = await getMemberTier(request.ownerEmail);
    
    if (ownerTier) {
      const participantsForValidation: ParticipantForValidation[] = request.participants.map(p => ({
        type: p.participantType,
        displayName: p.displayName
      }));
      
      const socialCheck = await enforceSocialTierRules(ownerTier, participantsForValidation);
      
      if (!socialCheck.allowed) {
        return {
          success: false,
          error: socialCheck.reason,
          errorType: 'social_tier_blocked'
        };
      }
    }
    
    // Step 2: Resolve all participant user IDs to emails for tier lookups
    // Build a map of userId -> email for quick lookup
    const userIdToEmail = new Map<string, string>();
    for (const p of request.participants) {
      if (p.userId) {
        const email = await resolveUserIdToEmail(p.userId);
        if (email) {
          userIdToEmail.set(p.userId, email);
        }
      }
    }
    
    // Step 3: Create session and link participants
    const { session, participants: linkedParticipants } = await createSession(
      {
        resourceId: request.resourceId,
        sessionDate: request.sessionDate,
        startTime: request.startTime,
        endTime: request.endTime,
        trackmanBookingId: request.trackmanBookingId,
        createdBy: request.ownerEmail
      },
      request.participants,
      source
    );
    
    // Step 4: Build participants for billing calculation
    const billingParticipants: UsageParticipant[] = request.participants.map(p => ({
      userId: p.userId,
      email: p.userId ? userIdToEmail.get(p.userId) : undefined,
      guestId: p.guestId,
      participantType: p.participantType,
      displayName: p.displayName
    }));
    
    // Step 5: Calculate billing using the new centralized billing calculator
    const billingResult = await calculateFullSessionBilling(
      request.sessionDate,
      request.durationMinutes,
      billingParticipants,
      request.ownerEmail
    );
    
    // Step 6: Record usage ledger entries based on billing breakdown
    let ledgerEntriesCreated = 0;
    
    for (const billing of billingResult.billingBreakdown) {
      if (billing.participantType === 'guest') {
        // Guest fees are assigned to the host, but with minutesCharged=0 
        // to avoid double-counting in host's daily usage
        if (billing.guestFee > 0) {
          await recordUsage(session.id, {
            memberId: request.ownerEmail,
            minutesCharged: 0,  // Don't add to host's usage minutes
            overageFee: 0,
            guestFee: billing.guestFee,
            tierAtBooking: ownerTier || undefined,
            paymentMethod: 'unpaid'
          }, source);
          ledgerEntriesCreated++;
        }
      } else {
        // Record member/owner usage with their calculated overage fee
        const memberEmail = billing.email || billing.userId || '';
        await recordUsage(session.id, {
          memberId: memberEmail,
          minutesCharged: billing.minutesAllocated,
          overageFee: billing.overageFee,
          guestFee: 0,
          tierAtBooking: billing.tierName || undefined,
          paymentMethod: 'unpaid'
        }, source);
        ledgerEntriesCreated++;
      }
    }
    
    logger.info('[createSessionWithUsageTracking] Session created with new billing', {
      extra: {
        sessionId: session.id,
        totalOverageFees: billingResult.totalOverageFees,
        totalGuestFees: billingResult.totalGuestFees,
        guestPassesUsed: billingResult.guestPassesUsed
      }
    });
    
    logger.info('[createSessionWithUsageTracking] Session created with usage tracking', {
      extra: {
        sessionId: session.id,
        participantCount: linkedParticipants.length,
        ledgerEntries: ledgerEntriesCreated,
        source
      }
    });
    
    return {
      success: true,
      session,
      participants: linkedParticipants,
      usageLedgerEntries: ledgerEntriesCreated
    };
  } catch (error) {
    logger.error('[createSessionWithUsageTracking] Error:', { error: error as Error });
    return {
      success: false,
      error: (error as Error).message,
      errorType: 'database_error'
    };
  }
}
