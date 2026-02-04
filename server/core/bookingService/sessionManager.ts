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
import { eq, and, isNull, sql } from 'drizzle-orm';
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
    
    // CRITICAL FIX: Track seen guests to prevent duplicate guest fees
    // If same guest is added twice (by mistake or duplicate API call), only add once
    const seenGuestKeys = new Set<string>();
    
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
      // CRITICAL: Use strict equality only - loose .includes() matching can wrongly filter
      // guests like "Johnson" when host is "John", or "Johnathan" when host is "John"
      const participantName = p.displayName?.toLowerCase().trim();
      if (ownerDisplayName && participantName && participantName === ownerDisplayName) {
        logger.warn('[linkParticipants] Skipping duplicate owner (by name)', {
          extra: { sessionId, ownerName: ownerDisplayName, duplicateName: participantName }
        });
        return false;
      }
      
      // CRITICAL FIX: Deduplicate guests - prevent double guest fees
      // Use both userId and displayName as dedup keys
      const guestKey = p.userId?.toLowerCase() || participantName || '';
      if (guestKey && seenGuestKeys.has(guestKey)) {
        logger.warn('[linkParticipants] Skipping duplicate guest', {
          extra: { sessionId, guestKey, displayName: p.displayName }
        });
        return false;
      }
      if (guestKey) {
        seenGuestKeys.add(guestKey);
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
    // Idempotency guard: Check if entry already exists for this session/member/source/fee-type combination
    // CRITICAL: Allow multiple entries for the same user if they represent different fee types
    // (e.g., one entry for guest fees, another for usage minutes)
    const hasGuestFee = input.guestFee && input.guestFee > 0;
    const hasMinutes = input.minutesCharged && input.minutesCharged > 0;
    
    const existingEntry = await dbCtx
      .select({ id: usageLedger.id, guestFee: usageLedger.guestFee, minutesCharged: usageLedger.minutesCharged })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.sessionId, sessionId),
          input.memberId 
            ? eq(usageLedger.memberId, input.memberId) 
            : isNull(usageLedger.memberId),
          eq(usageLedger.source, source)
        )
      );

    // Check for true duplicates - same fee type being recorded twice
    const isDuplicate = existingEntry.some(entry => {
      const existingHasGuestFee = parseFloat(entry.guestFee || '0') > 0;
      const existingHasMinutes = (entry.minutesCharged || 0) > 0;
      
      // Skip if recording same type of entry (guest fee vs minutes)
      if (hasGuestFee && existingHasGuestFee) return true;
      if (hasMinutes && !hasGuestFee && existingHasMinutes && !existingHasGuestFee) return true;
      return false;
    });

    if (isDuplicate) {
      logger.info(`[UsageLedger] Entry already exists for session ${sessionId}, member ${input.memberId} - skipping duplicate`, {
        extra: { sessionId, memberId: input.memberId, source, hasGuestFee, hasMinutes }
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

// Internal implementation that accepts an optional external client for transaction participation
async function deductGuestPassesInternal(
  memberEmail: string,
  passCount: number,
  tierName?: string,
  externalClient?: PoolClient
): Promise<{ success: boolean; passesDeducted: number }> {
  if (passCount <= 0) {
    return { success: true, passesDeducted: 0 };
  }
  
  // If external client provided, use it (caller manages transaction)
  // Otherwise, create our own client and manage transaction internally
  const client = externalClient || await pool.connect();
  const manageTransaction = !externalClient;
  
  try {
    if (manageTransaction) {
      await client.query('BEGIN');
    }
    
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
          if (manageTransaction) await client.query('COMMIT');
          logger.info('[deductGuestPasses] Passes deducted (backfilled)', { extra: { memberEmail, passCount } });
          return { success: true, passesDeducted: passCount };
        }
        if (manageTransaction) await client.query('ROLLBACK');
        return { success: false, passesDeducted: 0 };
      }
      
      // Normal update
      if (passes_used + passCount <= passes_total) {
        await client.query(
          `UPDATE guest_passes SET passes_used = passes_used + $2 
           WHERE LOWER(member_email) = LOWER($1)`,
          [memberEmail, passCount]
        );
        if (manageTransaction) await client.query('COMMIT');
        logger.info('[deductGuestPasses] Passes deducted', { extra: { memberEmail, passCount } });
        return { success: true, passesDeducted: passCount };
      }
      if (manageTransaction) await client.query('ROLLBACK');
      logger.warn('[deductGuestPasses] Insufficient passes', { extra: { memberEmail, passCount, passes_used, passes_total } });
      return { success: false, passesDeducted: 0 };
    }
    
    // No existing record - create with ON CONFLICT for race safety
    const { getTierLimits } = await import('../tierService');
    const tierLimits = tierName ? await getTierLimits(tierName) : null;
    // Default to 0 if no tier found - don't grant free passes to users without a tier
    const monthlyAllocation = tierLimits?.guest_passes_per_month ?? 0;
    
    if (passCount > monthlyAllocation) {
      if (manageTransaction) await client.query('ROLLBACK');
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
      if (manageTransaction) await client.query('COMMIT');
      logger.info('[deductGuestPasses] Passes deducted (new/conflict resolved)', { extra: { memberEmail, passCount } });
      return { success: true, passesDeducted: passCount };
    }
    
    // ON CONFLICT WHERE clause failed - insufficient passes after race
    if (manageTransaction) await client.query('ROLLBACK');
    logger.warn('[deductGuestPasses] Insufficient passes after race resolution', { extra: { memberEmail, passCount } });
    return { success: false, passesDeducted: 0 };
  } catch (error) {
    if (manageTransaction) await client.query('ROLLBACK');
    logger.error('[deductGuestPasses] Error:', { error: error as Error });
    return { success: false, passesDeducted: 0 };
  } finally {
    if (manageTransaction) client.release();
  }
}

// Public API - standalone usage with internal transaction management
export async function deductGuestPasses(
  memberEmail: string,
  passCount: number,
  tierName?: string
): Promise<{ success: boolean; passesDeducted: number }> {
  return deductGuestPassesInternal(memberEmail, passCount, tierName);
}

// Transaction-aware version for use inside an existing transaction
export async function deductGuestPassesWithClient(
  client: PoolClient,
  memberEmail: string,
  passCount: number,
  tierName?: string
): Promise<{ success: boolean; passesDeducted: number }> {
  return deductGuestPassesInternal(memberEmail, passCount, tierName, client);
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
  declaredPlayerCount?: number;
  bookingId?: number;
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
      request.ownerEmail,
      request.declaredPlayerCount || request.participants.length
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
      
      // Step 5c: Deduct guest passes INSIDE the transaction for atomicity
      if (billingResult.guestPassesUsed > 0) {
        const emailLower = request.ownerEmail.toLowerCase().trim();
        const passesNeeded = billingResult.guestPassesUsed;
        
        if (request.bookingId) {
          // Path 1: Booking request flow - convert holds to usage
          const holdResult = await tx.execute(sql`
            SELECT id, passes_held FROM guest_pass_holds 
            WHERE booking_id = ${request.bookingId} AND LOWER(member_email) = ${emailLower}
            FOR UPDATE
          `);
          
          if (holdResult.rows && holdResult.rows.length > 0) {
            const passesToConvert = (holdResult.rows[0] as any).passes_held || 0;
            
            if (passesToConvert > 0) {
              // Verify we don't exceed total passes available
              const passCheck = await tx.execute(sql`
                SELECT passes_total, passes_used FROM guest_passes 
                WHERE LOWER(member_email) = ${emailLower}
                FOR UPDATE
              `);
              
              if (passCheck.rows && passCheck.rows.length > 0) {
                const { passes_total, passes_used } = passCheck.rows[0] as any;
                if (passes_used + passesToConvert > passes_total) {
                  throw new Error(
                    `Insufficient guest passes: have ${passes_total - passes_used}, need ${passesToConvert}. ` +
                    `Transaction rolled back.`
                  );
                }
              }
              
              // Convert hold to actual usage
              await tx.execute(sql`
                UPDATE guest_passes 
                SET passes_used = passes_used + ${passesToConvert}
                WHERE LOWER(member_email) = ${emailLower}
              `);
            }
            
            // Delete the hold
            await tx.execute(sql`
              DELETE FROM guest_pass_holds WHERE booking_id = ${request.bookingId}
            `);
            
            logger.info('[createSessionWithUsageTracking] Converted guest pass holds to usage (atomic)', {
              extra: { bookingId: request.bookingId, ownerEmail: request.ownerEmail, passesConverted: passesToConvert }
            });
          } else {
            throw new Error(
              `No guest pass holds found for booking ${request.bookingId}. ` +
              `Expected ${passesNeeded} passes. Transaction rolled back.`
            );
          }
        } else {
          // Path 2: Staff/Trackman flow without holds - direct atomic deduction
          const passCheck = await tx.execute(sql`
            SELECT id, passes_total, passes_used FROM guest_passes 
            WHERE LOWER(member_email) = ${emailLower}
            FOR UPDATE
          `);
          
          if (passCheck.rows && passCheck.rows.length > 0) {
            const { passes_total, passes_used } = passCheck.rows[0] as any;
            const available = passes_total - passes_used;
            
            if (available < passesNeeded) {
              throw new Error(
                `Insufficient guest passes for ${request.ownerEmail}: have ${available}, need ${passesNeeded}. ` +
                `Transaction rolled back.`
              );
            }
            
            await tx.execute(sql`
              UPDATE guest_passes 
              SET passes_used = passes_used + ${passesNeeded}
              WHERE LOWER(member_email) = ${emailLower}
            `);
            
            logger.info('[createSessionWithUsageTracking] Deducted guest passes (atomic, no holds)', {
              extra: { ownerEmail: request.ownerEmail, passesDeducted: passesNeeded }
            });
          } else {
            throw new Error(
              `No guest pass record found for ${request.ownerEmail}. ` +
              `Expected ${passesNeeded} passes. Transaction rolled back.`
            );
          }
        }
      }
      
      return { session, linkedParticipants, ledgerEntriesCreated };
    };
    
    // Step 5: Execute database writes - either within external transaction or our own
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

/**
 * Ensures a booking has a valid session. If no session exists, creates one on-the-fly.
 * This resolves the "chicken-and-egg" problem where check-in requires a session,
 * but the session was only created by the billing modal (which never opens if check-in fails).
 * 
 * @param bookingId - The booking request ID
 * @param source - Source identifier for audit trail (e.g., 'checkin_auto_create', 'checkin_context')
 * @returns The session ID (existing or newly created), or null if creation failed
 */
export async function ensureBookingSession(
  bookingId: number,
  source: string = 'checkin_auto_create'
): Promise<{ sessionId: number | null; created: boolean; error?: string }> {
  try {
    const existingResult = await pool.query(`
      SELECT session_id, resource_id FROM booking_requests WHERE id = $1
    `, [bookingId]);

    if (existingResult.rows.length === 0) {
      return { sessionId: null, created: false, error: 'Booking not found' };
    }

    const existing = existingResult.rows[0];
    
    if (existing.session_id) {
      return { sessionId: existing.session_id, created: false };
    }

    if (!existing.resource_id) {
      return { sessionId: null, created: false, error: 'Booking has no resource assigned' };
    }

    const bookingDetails = await pool.query(`
      SELECT resource_id, request_date, start_time, end_time, declared_player_count, user_email, user_name
      FROM booking_requests WHERE id = $1
    `, [bookingId]);

    if (bookingDetails.rows.length === 0) {
      return { sessionId: null, created: false, error: 'Booking details not found' };
    }

    const bd = bookingDetails.rows[0];

    const sessionResult = await pool.query(`
      INSERT INTO booking_sessions (resource_id, session_date, start_time, end_time, source, created_by)
      VALUES ($1, $2, $3, $4, 'staff_manual', $5)
      ON CONFLICT (resource_id, session_date, start_time, end_time) DO NOTHING
      RETURNING id
    `, [bd.resource_id, bd.request_date, bd.start_time, bd.end_time, source]);

    let sessionId: number | null = sessionResult.rows[0]?.id || null;

    if (!sessionId) {
      const existingSession = await pool.query(`
        SELECT id FROM booking_sessions 
        WHERE resource_id = $1 AND session_date = $2 AND start_time = $3 AND end_time = $4
        LIMIT 1
      `, [bd.resource_id, bd.request_date, bd.start_time, bd.end_time]);
      sessionId = existingSession.rows[0]?.id || null;
    }

    if (!sessionId) {
      return { sessionId: null, created: false, error: 'Failed to create or find session' };
    }

    await pool.query(`UPDATE booking_requests SET session_id = $1 WHERE id = $2`, [sessionId, bookingId]);

    const userResult = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [bd.user_email]);
    const userId = userResult.rows[0]?.id || null;

    const existingOwner = await pool.query(`
      SELECT id FROM booking_participants 
      WHERE session_id = $1 AND participant_type = 'owner'
      LIMIT 1
    `, [sessionId]);

    if (existingOwner.rows.length === 0) {
      await pool.query(`
        INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status)
        VALUES ($1, $2, 'owner', $3, 'pending')
      `, [sessionId, userId, bd.user_name || 'Member']);
    }

    const playerCount = bd.declared_player_count || 1;
    const existingGuests = await pool.query(`
      SELECT COUNT(*) as count FROM booking_participants 
      WHERE session_id = $1 AND participant_type = 'guest'
    `, [sessionId]);
    const existingGuestCount = parseInt(existingGuests.rows[0]?.count || '0');

    if (existingGuestCount < playerCount - 1) {
      for (let i = existingGuestCount + 1; i < playerCount; i++) {
        await pool.query(`
          INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, payment_status)
          VALUES ($1, NULL, 'guest', $2, 'pending')
        `, [sessionId, `Guest ${i + 1}`]);
      }
    }

    const { recalculateSessionFees } = await import('../billing/unifiedFeeService');
    await recalculateSessionFees(sessionId, source);

    logger.info('[ensureBookingSession] Created session for booking', {
      extra: { bookingId, sessionId, source }
    });

    return { sessionId, created: true };
  } catch (error: any) {
    logger.error('[ensureBookingSession] Error:', { error });
    return { sessionId: null, created: false, error: error.message };
  }
}
