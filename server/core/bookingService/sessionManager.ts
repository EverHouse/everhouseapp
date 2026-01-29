import { db } from '../../db';
import { pool } from '../db';
import { 
  bookingSessions, 
  bookingParticipants, 
  usageLedger,
  guests,
  users,
  InsertBookingSession,
  InsertBookingParticipant,
  InsertUsageLedger,
  BookingSession,
  BookingParticipant
} from '../../../shared/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { logger } from '../logger';
import { getMemberTierByEmail } from '../tierService';

// Transaction context type - allows functions to participate in an outer transaction
export type TransactionContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  source: BookingSource = 'member_request',
  tx?: TransactionContext
): Promise<{ session: BookingSession; participants: BookingParticipant[] }> {
  const dbCtx = tx || db;
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
    
    const [session] = await dbCtx
      .insert(bookingSessions)
      .values(sessionData)
      .returning();
    
    const linkedParticipants = await linkParticipants(session.id, participants, tx);
    
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
  participants: ParticipantInput[],
  tx?: TransactionContext
): Promise<BookingParticipant[]> {
  const dbCtx = tx || db;
  if (!participants || participants.length === 0) {
    return [];
  }
  
  try {
    const owner = participants.find(p => p.participantType === 'owner');
    const ownerUserId = owner?.userId?.toLowerCase();
    const ownerDisplayName = owner?.displayName?.toLowerCase().trim();
    
    const filteredParticipants = participants.filter(p => {
      if (p.participantType === 'owner') {
        return true;
      }
      
      // Skip if userId matches owner
      if (ownerUserId && p.userId?.toLowerCase() === ownerUserId) {
        logger.warn('[linkParticipants] Skipping duplicate owner (by userId)', {
          extra: { sessionId, userId: p.userId, displayName: p.displayName }
        });
        return false;
      }
      
      // Skip if displayName matches owner (catches name-only duplicates)
      const participantName = p.displayName?.toLowerCase().trim();
      if (ownerDisplayName && participantName && (
        participantName === ownerDisplayName ||
        ownerDisplayName.includes(participantName) ||
        participantName.includes(ownerDisplayName)
      )) {
        logger.warn('[linkParticipants] Skipping duplicate owner (by name)', {
          extra: { sessionId, ownerName: ownerDisplayName, duplicateName: participantName }
        });
        return false;
      }
      
      return true;
    });
    
    const participantRecords: InsertBookingParticipant[] = filteredParticipants.map(p => ({
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
    
    const inserted = await dbCtx
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
  source: BookingSource = 'member_request',
  tx?: TransactionContext
): Promise<{ success: boolean; alreadyRecorded?: boolean }> {
  const dbCtx = tx || db;
  try {
    // Idempotency guard: Check if entry already exists for this session/member/source combination
    const existingEntry = await dbCtx
      .select({ id: usageLedger.id })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.sessionId, sessionId),
          input.memberId 
            ? eq(usageLedger.memberId, input.memberId) 
            : isNull(usageLedger.memberId),
          eq(usageLedger.source, source)
        )
      )
      .limit(1);

    if (existingEntry.length > 0) {
      logger.info(`[UsageLedger] Entry already exists for session ${sessionId}, member ${input.memberId} - skipping duplicate`, {
        extra: { sessionId, memberId: input.memberId, source }
      });
      return { success: true, alreadyRecorded: true };
    }

    let tierAtBooking = input.tierAtBooking;
    
    // If tier not provided, look it up - use transaction context for consistency
    if (!tierAtBooking && input.memberId) {
      const userResult = await dbCtx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.memberId))
        .limit(1);
      
      if (userResult[0]?.email) {
        tierAtBooking = await getMemberTierByEmail(userResult[0].email) || undefined;
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
    
    await dbCtx.insert(usageLedger).values(usageData);
    
    logger.info('[recordUsage] Usage recorded', {
      extra: { 
        sessionId, 
        memberId: input.memberId,
        minutes: input.minutesCharged,
        overageFee: input.overageFee,
        tier: tierAtBooking
      }
    });
    
    return { success: true, alreadyRecorded: false };
  } catch (error: any) {
    // Handle PostgreSQL unique constraint violation (23505) as a fallback
    // This handles race conditions where two concurrent requests pass the existence check
    if (error.code === '23505') {
      logger.info(`[UsageLedger] Duplicate entry prevented for session ${sessionId} (constraint violation)`, {
        extra: { sessionId, memberId: input.memberId, source }
      });
      return { success: true, alreadyRecorded: true };
    }
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

export async function deductGuestPasses(
  memberEmail: string,
  passCount: number,
  tierName?: string
): Promise<{ success: boolean; passesDeducted: number }> {
  if (passCount <= 0) {
    return { success: true, passesDeducted: 0 };
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Try to lock existing row first
    const lockResult = await client.query(
      `SELECT passes_used, passes_total 
       FROM guest_passes 
       WHERE LOWER(member_email) = LOWER($1) 
       FOR UPDATE`,
      [memberEmail]
    );
    
    if (lockResult.rows.length > 0) {
      // Existing row found - check and update
      const { passes_used, passes_total } = lockResult.rows[0];
      
      // Handle backfill if passes_total is 0
      if (!passes_total || passes_total === 0) {
        const { getTierLimits } = await import('../tierService');
        const tierLimits = tierName ? await getTierLimits(tierName) : null;
        // Default to 0 if no tier found - don't grant free passes to users without a tier
        const monthlyAllocation = tierLimits?.guest_passes_per_month ?? 0;
        
        if (passes_used + passCount <= monthlyAllocation) {
          await client.query(
            `UPDATE guest_passes 
             SET passes_total = $3, passes_used = passes_used + $2
             WHERE LOWER(member_email) = LOWER($1)`,
            [memberEmail, passCount, monthlyAllocation]
          );
          await client.query('COMMIT');
          logger.info('[deductGuestPasses] Passes deducted (backfilled)', { extra: { memberEmail, passCount } });
          return { success: true, passesDeducted: passCount };
        }
        await client.query('ROLLBACK');
        return { success: false, passesDeducted: 0 };
      }
      
      // Normal update
      if (passes_used + passCount <= passes_total) {
        await client.query(
          `UPDATE guest_passes SET passes_used = passes_used + $2 
           WHERE LOWER(member_email) = LOWER($1)`,
          [memberEmail, passCount]
        );
        await client.query('COMMIT');
        logger.info('[deductGuestPasses] Passes deducted', { extra: { memberEmail, passCount } });
        return { success: true, passesDeducted: passCount };
      }
      await client.query('ROLLBACK');
      logger.warn('[deductGuestPasses] Insufficient passes', { extra: { memberEmail, passCount, passes_used, passes_total } });
      return { success: false, passesDeducted: 0 };
    }
    
    // No existing record - create with ON CONFLICT for race safety
    const { getTierLimits } = await import('../tierService');
    const tierLimits = tierName ? await getTierLimits(tierName) : null;
    // Default to 0 if no tier found - don't grant free passes to users without a tier
    const monthlyAllocation = tierLimits?.guest_passes_per_month ?? 0;
    
    if (passCount > monthlyAllocation) {
      await client.query('ROLLBACK');
      return { success: false, passesDeducted: 0 };
    }
    
    // Use INSERT ... ON CONFLICT to safely handle race conditions
    const insertResult = await client.query(
      `INSERT INTO guest_passes (member_email, passes_used, passes_total)
       VALUES (LOWER($1), $2, $3)
       ON CONFLICT (member_email) DO UPDATE 
       SET passes_used = guest_passes.passes_used + $2
       WHERE guest_passes.passes_used + $2 <= guest_passes.passes_total
       RETURNING passes_used, passes_total`,
      [memberEmail, passCount, monthlyAllocation]
    );
    
    if (insertResult.rows.length > 0) {
      await client.query('COMMIT');
      logger.info('[deductGuestPasses] Passes deducted (new/conflict resolved)', { extra: { memberEmail, passCount } });
      return { success: true, passesDeducted: passCount };
    }
    
    // ON CONFLICT WHERE clause failed - insufficient passes after race
    await client.query('ROLLBACK');
    logger.warn('[deductGuestPasses] Insufficient passes after race resolution', { extra: { memberEmail, passCount } });
    return { success: false, passesDeducted: 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[deductGuestPasses] Error:', { error: error as Error });
    return { success: false, passesDeducted: 0 };
  } finally {
    client.release();
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
  source: BookingSource = 'member_request',
  externalTx?: TransactionContext
): Promise<OrchestratedSessionResult> {
  try {
    // Step 1: Get owner's tier and enforce Social tier rules (pre-transaction validation)
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
    
    // Step 2: Resolve all participant user IDs to emails for tier lookups (pre-transaction)
    const userIdToEmail = new Map<string, string>();
    for (const p of request.participants) {
      if (p.userId) {
        const email = await resolveUserIdToEmail(p.userId);
        if (email) {
          userIdToEmail.set(p.userId, email);
        }
      }
    }
    
    // Step 3: Build participants for billing calculation (pre-transaction)
    const billingParticipants: UsageParticipant[] = request.participants.map(p => ({
      userId: p.userId,
      email: p.userId ? userIdToEmail.get(p.userId) : undefined,
      guestId: p.guestId,
      participantType: p.participantType,
      displayName: p.displayName
    }));
    
    // Step 4: Calculate billing using the centralized billing calculator (pre-transaction)
    const billingResult = await calculateFullSessionBilling(
      request.sessionDate,
      request.durationMinutes,
      billingParticipants,
      request.ownerEmail
    );
    
    // Step 5: Execute database writes - either within external transaction or our own
    // This ensures all-or-nothing: if any step fails, everything rolls back
    const executeDbWrites = async (tx: TransactionContext) => {
      // Create session and link participants within transaction
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
        source,
        tx
      );
      
      // Record usage ledger entries within the same transaction
      let ledgerEntriesCreated = 0;
      
      for (const billing of billingResult.billingBreakdown) {
        if (billing.participantType === 'guest') {
          // Guest fees are assigned to the host, but with minutesCharged=0 
          // to avoid double-counting in host's daily usage
          if (billing.guestFee > 0) {
            await recordUsage(session.id, {
              memberId: request.ownerEmail,
              minutesCharged: 0,
              overageFee: 0,
              guestFee: billing.guestFee,
              tierAtBooking: ownerTier || undefined,
              paymentMethod: 'unpaid'
            }, source, tx);
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
          }, source, tx);
          ledgerEntriesCreated++;
        }
      }
      
      return { session, linkedParticipants, ledgerEntriesCreated };
    };
    
    // Use external transaction if provided, otherwise create our own
    const txResult = externalTx 
      ? await executeDbWrites(externalTx)
      : await db.transaction(executeDbWrites);
    
    logger.info('[createSessionWithUsageTracking] Session created with new billing', {
      extra: {
        sessionId: txResult.session.id,
        totalOverageFees: billingResult.totalOverageFees,
        totalGuestFees: billingResult.totalGuestFees,
        guestPassesUsed: billingResult.guestPassesUsed
      }
    });
    
    // Step 6: Deduct guest passes (outside transaction - separate concern)
    if (billingResult.guestPassesUsed > 0) {
      const deductResult = await deductGuestPasses(
        request.ownerEmail, 
        billingResult.guestPassesUsed,
        ownerTier || undefined
      );

      if (!deductResult.success) {
        logger.warn('Failed to deduct guest passes during session creation', { 
          extra: { email: request.ownerEmail, passesToDeduct: billingResult.guestPassesUsed }
        });
      }
    }
    
    logger.info('[createSessionWithUsageTracking] Session created with usage tracking', {
      extra: {
        sessionId: txResult.session.id,
        participantCount: txResult.linkedParticipants.length,
        ledgerEntries: txResult.ledgerEntriesCreated,
        source
      }
    });
    
    return {
      success: true,
      session: txResult.session,
      participants: txResult.linkedParticipants,
      usageLedgerEntries: txResult.ledgerEntriesCreated
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
