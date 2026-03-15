import { db } from '../../db';
import { getErrorCode, getErrorMessage } from '../../utils/errorUtils';
import { toIntArrayLiteral } from '../../utils/sqlArrayLiteral';
import { pool, safeRelease } from '../db';
import type { PoolClient } from 'pg';
import { 
  bookingSessions, 
  bookingParticipants, 
  bookingRequests,
  usageLedger,
  guests,
  users,
  InsertBookingSession,
  InsertBookingParticipant,
  InsertUsageLedger,
  BookingSession,
  BookingParticipant,
  bookingSourceEnum
} from '../../../shared/schema';
import { eq, and, isNull, sql, sql as drizzleSql, type SQL } from 'drizzle-orm';

export interface TxQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

function buildSqlFromRaw(text: string, values: unknown[]): SQL {
  if (values.length === 0) return drizzleSql.raw(text);

  const strings: string[] = [];
  const sqlValues: unknown[] = [];
  let lastIndex = 0;
  const regex = /\$(\d+)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    strings.push(text.slice(lastIndex, match.index));
    const paramIndex = parseInt(match[1]) - 1;
    sqlValues.push(values[paramIndex]);
    lastIndex = match.index + match[0].length;
  }
  strings.push(text.slice(lastIndex));

  const templateStrings = Object.assign([...strings], { raw: [...strings] });
  return drizzleSql(templateStrings as unknown as TemplateStringsArray, ...sqlValues);
}

export function createTxQueryClient(tx: { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> }): TxQueryClient {
  return {
    async query(text: string, values: unknown[] = []) {
      const sqlQuery = buildSqlFromRaw(text, values);
      const result = await tx.execute(sqlQuery);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? null };
    }
  };
}
import { logger } from '../logger';
import { getMemberTierByEmail } from '../tierService';
import { getTodayPacific } from '../../utils/dateUtils';

// Transaction context type - allows functions to participate in an outer transaction
export type TransactionContext = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type BookingSource = 'member_request' | 'staff_manual' | 'trackman_import' | 'trackman_webhook' | 'trackman' | 'auto-complete' | 'manual-auto-complete';
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
  const lockKey = `${request.resourceId}::${request.sessionDate}`;

  if (tx) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return createSessionInner(request, participants, source, tx);
  }

  return db.transaction(async (innerTx) => {
    await innerTx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return createSessionInner(request, participants, source, innerTx);
  });
}

async function createSessionInner(
  request: CreateSessionRequest,
  participants: ParticipantInput[],
  source: BookingSource,
  tx: TransactionContext
): Promise<{ session: BookingSession; participants: BookingParticipant[] }> {
  try {
    const sessionData: InsertBookingSession = {
      resourceId: request.resourceId,
      sessionDate: request.sessionDate,
      startTime: request.startTime,
      endTime: request.endTime,
      trackmanBookingId: request.trackmanBookingId,
      source: source as typeof bookingSourceEnum.enumValues[number],
      createdBy: request.createdBy
    };
    
    await tx.execute(sql`SET LOCAL app.bypass_overlap_check = 'true'`);
    const [session] = await tx
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
  } catch (error: unknown) {
    logger.error('[createSession] Error creating session:', { error: getErrorMessage(error) });
    throw error;
  }
}

export async function ensureSessionForBooking(params: {
  bookingId: number;
  resourceId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  ownerEmail: string;
  ownerName?: string;
  ownerUserId?: string;
  trackmanBookingId?: string;
  source: BookingSource;
  createdBy: string;
}, client?: PoolClient | TxQueryClient): Promise<{ sessionId: number; created: boolean; error?: string }> {
  if (!params.startTime || !params.endTime) {
    return { sessionId: 0, created: false, error: 'Missing start_time or end_time' };
  }

  const [sh, sm] = params.startTime.split(':').map(Number);
  const [eh, em] = params.endTime.split(':').map(Number);
  if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) {
    return { sessionId: 0, created: false, error: `Invalid time format: start=${params.startTime}, end=${params.endTime}` };
  }

  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  if (startMins === endMins) {
    return { sessionId: 0, created: false, error: `Zero-duration booking: start=${params.startTime}, end=${params.endTime}` };
  }

  const attemptSessionCreation = async (): Promise<{ sessionId: number; created: boolean }> => {
    let sessionId: number | null = null;
    let created = false;

    const lockClient: TxQueryClient = client || await pool.connect();
    const manageLockClient = !client;
    try {
      const lockKey = `${params.resourceId}::${params.sessionDate}`;
      if (!manageLockClient) {
        await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
      } else {
        await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [lockKey]);
      }
      try {

    let reusedStaleSession = false;

    if (params.trackmanBookingId) {
      const trackmanMatch = await lockClient.query(
        `SELECT bs.id FROM booking_sessions bs
         WHERE bs.trackman_booking_id = $1
         LIMIT 1`,
        [params.trackmanBookingId]
      );
      if (trackmanMatch.rows.length > 0) {
        sessionId = (trackmanMatch.rows[0] as { id: number }).id;
        const activeCheck = await lockClient.query(
          `SELECT COUNT(*) as cnt FROM booking_requests
           WHERE session_id = $1 AND status NOT IN ('cancelled', 'deleted', 'declined')`,
          [sessionId]
        );
        if (parseInt(String(activeCheck.rows[0].cnt)) === 0) {
          reusedStaleSession = true;
        }
      }
    }

    if (manageLockClient) {
      await lockClient.query('BEGIN');
    }
    try {

    if (!sessionId) {
      try {
        await lockClient.query(`SET LOCAL app.bypass_overlap_check = 'true'`);
        const insertResult = await lockClient.query(
          `INSERT INTO booking_sessions (resource_id, session_date, start_time, end_time, trackman_booking_id, source, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (trackman_booking_id) WHERE trackman_booking_id IS NOT NULL
           DO UPDATE SET updated_at = NOW()
           RETURNING id, (xmax = 0) AS was_inserted`,
          [params.resourceId, params.sessionDate, params.startTime, params.endTime, params.trackmanBookingId || null, params.source, params.createdBy]
        );
        sessionId = (insertResult.rows[0] as { id: number; was_inserted: boolean }).id;
        const wasInserted = (insertResult.rows[0] as { id: number; was_inserted: boolean }).was_inserted;
        created = wasInserted;
        if (!wasInserted) {
          const activeCheck = await lockClient.query(
            `SELECT COUNT(*) as cnt FROM booking_requests
             WHERE session_id = $1 AND status NOT IN ('cancelled', 'deleted', 'declined')`,
            [sessionId]
          );
          if (parseInt(String(activeCheck.rows[0].cnt)) === 0) {
            reusedStaleSession = true;
          }
        }
      } catch (insertErr: unknown) {
        const errMsg = getErrorMessage(insertErr);
        if (errMsg.includes('range lower bound') || errMsg.includes('range upper bound') || getErrorCode(insertErr) === '22000') {
          logger.warn('[SessionManager] INSERT trigger failed due to corrupt session range data, retrying with bypass', { error: getErrorMessage(insertErr) });
        }
        throw insertErr;
      }
    }

    if (reusedStaleSession) {
      await lockClient.query(
        `DELETE FROM booking_participants WHERE session_id = $1`,
        [sessionId]
      );
      logger.info('[SessionManager] Cleared stale participants from reused session (all prior bookings cancelled)', {
        extra: { sessionId, newOwnerEmail: params.ownerEmail }
      });
    }

    const existingOwner = await lockClient.query(
      `SELECT bp.id, bp.user_id, bp.display_name, u.email as owner_email
       FROM booking_participants bp
       LEFT JOIN users u ON bp.user_id = u.id
       WHERE bp.session_id = $1 AND bp.participant_type = 'owner'
       LIMIT 1`,
      [sessionId]
    );

    let ownerDisplayName = params.ownerName;
    let resolvedUserId: string | null = params.ownerUserId || null;

    if (!resolvedUserId || !ownerDisplayName || ownerDisplayName.includes('@')) {
      const nameResult = await lockClient.query(
        `SELECT id, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [params.ownerEmail]
      );
      if (nameResult.rows.length > 0) {
        const { id, first_name, last_name } = nameResult.rows[0] as { id: string | null; first_name: string | null; last_name: string | null };
        if (!resolvedUserId) {
          resolvedUserId = id || null;
        }
        if (!ownerDisplayName || ownerDisplayName.includes('@')) {
          const fullName = [first_name, last_name].filter(Boolean).join(' ');
          if (fullName) {
            ownerDisplayName = fullName;
          }
        }
      }
    }

    let slotDuration = 60;
    try {
      const [startH, startM] = params.startTime.split(':').map(Number);
      const [endH, endM] = params.endTime.split(':').map(Number);
      let endMinutes = endH * 60 + endM;
      const startMinutes = startH * 60 + startM;
      if (endMinutes <= startMinutes) endMinutes += 1440;
      slotDuration = endMinutes - startMinutes;
      if (slotDuration <= 0) slotDuration = 60;
    } catch (err) { logger.warn('[Booking] Non-critical slot duration calculation failed:', { error: err }); }

    if (existingOwner.rows.length === 0) {
      await lockClient.query(
        `INSERT INTO booking_participants (session_id, user_id, participant_type, display_name, slot_duration, invited_at)
         VALUES ($1, $2, 'owner', $3, $4, NOW())`,
        [sessionId, resolvedUserId, ownerDisplayName || params.ownerEmail, slotDuration]
      );
    }

    await lockClient.query(
      `UPDATE booking_requests SET session_id = $1, updated_at = NOW() WHERE id = $2`,
      [sessionId, params.bookingId]
    );

    if (manageLockClient) {
      await lockClient.query('COMMIT');
    }

    } catch (txErr) {
      if (manageLockClient) {
        try { await lockClient.query('ROLLBACK'); } catch (_) { /* rollback best-effort */ }
      }
      throw txErr;
    }

    return { sessionId: sessionId!, created };

      } finally {
        if (manageLockClient) {
          await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]).catch((unlockErr: unknown) => { logger.warn('[SessionManager] Advisory lock release failed', { error: getErrorMessage(unlockErr) }); });
        }
      }
    } finally {
      if (manageLockClient) {
        safeRelease(lockClient as unknown as PoolClient);
      }
    }
  };

  try {
    return await attemptSessionCreation();
  } catch (firstError: unknown) {
    if (client) {
      throw firstError;
    }

    logger.error('[ensureSessionForBooking] First attempt failed, retrying in 500ms...', { error: getErrorMessage(firstError) });

    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      return await attemptSessionCreation();
    } catch (retryError: unknown) {
      const errorMsg = getErrorMessage(retryError);
      logger.error('[ensureSessionForBooking] Retry also failed, flagging booking for staff review', { error: getErrorMessage(retryError) });

      try {
        const existing = await db
          .select({ staffNotes: bookingRequests.staffNotes })
          .from(bookingRequests)
          .where(eq(bookingRequests.id, params.bookingId))
          .limit(1);

        const existingNotes = existing[0]?.staffNotes || '';
        const shortError = errorMsg.length > 80 ? errorMsg.substring(0, 80) + '...' : errorMsg;
        const failureNote = `[SESSION_CREATION_FAILED] Auto session failed (${getTodayPacific()}): ${shortError}. Please create a session manually.`;
        const updatedNotes = existingNotes ? `${existingNotes}\n${failureNote}` : failureNote;

        await db
          .update(bookingRequests)
          .set({ staffNotes: updatedNotes })
          .where(eq(bookingRequests.id, params.bookingId));
      } catch (noteError: unknown) {
        logger.error('[ensureSessionForBooking] Failed to write staff note on booking', { error: getErrorMessage(noteError) });
      }

      return { sessionId: 0, created: false, error: errorMsg };
    }
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
      if (ownerDisplayName && participantName && participantName === ownerDisplayName) {
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
      invitedAt: new Date(),
    }));
    
    const inserted = await dbCtx
      .insert(bookingParticipants)
      .values(participantRecords)
      .returning();
    
    return inserted;
  } catch (error: unknown) {
    logger.error('[linkParticipants] Error linking participants:', { error: getErrorMessage(error) });
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
          eq(usageLedger.source, source as typeof bookingSourceEnum.enumValues[number])
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
      if (input.memberId.includes('@')) {
        tierAtBooking = await getMemberTierByEmail(input.memberId) || undefined;
      } else {
        const userResult = await dbCtx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, input.memberId))
          .limit(1);
        
        if (userResult[0]?.email) {
          tierAtBooking = await getMemberTierByEmail(userResult[0].email) || undefined;
        }
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
      source: source as typeof bookingSourceEnum.enumValues[number]
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
  } catch (error: unknown) {
    // Handle PostgreSQL unique constraint violation (23505) as a fallback
    // This handles race conditions where two concurrent requests pass the existence check
    if (getErrorCode(error) === '23505') {
      logger.info(`[UsageLedger] Duplicate entry prevented for session ${sessionId} (constraint violation)`, {
        extra: { sessionId, memberId: input.memberId, source }
      });
      return { success: true, alreadyRecorded: true };
    }
    logger.error('[recordUsage] Error recording usage:', { error: getErrorMessage(error) });
    throw error;
  }
}

export async function getSessionById(sessionId: number): Promise<BookingSession | null> {
  const sessions = await db
    .select()
    .from(bookingSessions)
    .where(eq(bookingSessions.id, sessionId))
    .limit(1);
  
  return sessions[0] || null;
}

export async function getSessionParticipants(sessionId: number): Promise<BookingParticipant[]> {
  return await db
    .select()
    .from(bookingParticipants)
    .where(eq(bookingParticipants.sessionId, sessionId));
}

export async function createOrFindGuest(
  name: string,
  email?: string,
  phone?: string,
  createdByMemberId?: string
): Promise<number> {
  try {
    const today = getTodayPacific();

    if (email) {
      const normalizedEmail = email.toLowerCase();
      const [upserted] = await db
        .insert(guests)
        .values({
          name,
          email: normalizedEmail,
          phone,
          createdByMemberId,
          lastVisitDate: today
        })
        .onConflictDoUpdate({
          target: guests.email,
          set: { lastVisitDate: today }
        })
        .returning();

      return upserted.id;
    }

    const [newGuest] = await db
      .insert(guests)
      .values({
        name,
        email: undefined,
        phone,
        createdByMemberId,
        lastVisitDate: today
      })
      .returning();

    return newGuest.id;
  } catch (error: unknown) {
    logger.error('[createOrFindGuest] Error:', { error: getErrorMessage(error) });
    throw error;
  }
}

export async function linkBookingRequestToSession(
  bookingRequestId: number,
  sessionId: number
): Promise<void> {
  try {
    await db.execute(
      sql`UPDATE booking_requests SET session_id = ${sessionId}, updated_at = NOW() WHERE id = ${bookingRequestId}`
    );
  } catch (error: unknown) {
    logger.error('[linkBookingRequestToSession] Error:', { error: getErrorMessage(error) });
    throw error;
  }
}

async function resolveMonthlyAllocation(tierName?: string): Promise<number> {
  const { getTierLimits } = await import('../tierService');
  const tierLimits = tierName ? await getTierLimits(tierName) : null;
  return tierLimits?.guest_passes_per_month ?? 0;
}

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
      const { passes_used, passes_total } = lockResult.rows[0];
      
      const effectiveTotal = (!passes_total || passes_total === 0)
        ? await resolveMonthlyAllocation(tierName)
        : passes_total;

      const needsBackfill = !passes_total || passes_total === 0;

      if (passes_used + passCount > effectiveTotal) {
        if (manageTransaction) await client.query('ROLLBACK');
        logger.warn('[deductGuestPasses] Insufficient passes', { extra: { memberEmail, passCount, passes_used, passes_total: effectiveTotal } });
        return { success: false, passesDeducted: 0 };
      }

      const updateQuery = needsBackfill
        ? `UPDATE guest_passes SET passes_total = $3, passes_used = passes_used + $2 WHERE LOWER(member_email) = LOWER($1)`
        : `UPDATE guest_passes SET passes_used = passes_used + $2 WHERE LOWER(member_email) = LOWER($1)`;
      const updateParams = needsBackfill
        ? [memberEmail, passCount, effectiveTotal]
        : [memberEmail, passCount];

      await client.query(updateQuery, updateParams);
      if (manageTransaction) await client.query('COMMIT');
      logger.info(`[deductGuestPasses] Passes deducted${needsBackfill ? ' (backfilled)' : ''}`, { extra: { memberEmail, passCount } });
      return { success: true, passesDeducted: passCount };
    }
    
    const monthlyAllocation = await resolveMonthlyAllocation(tierName);
    
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
  } catch (error: unknown) {
    if (manageTransaction) {
      try { await client.query('ROLLBACK'); } catch (_) { /* rollback best-effort */ }
    }
    logger.error('[deductGuestPasses] Error:', { error: getErrorMessage(error) });
    throw error;
  } finally {
    if (manageTransaction) safeRelease(client);
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  computeUsageAllocation, 
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  } catch (error: unknown) {
    logger.error('[resolveUserIdToEmail] Error resolving user ID', { 
      error: getErrorMessage(error),
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
    
    const resourceResult = await db.execute(sql`SELECT type FROM resources WHERE id = ${request.resourceId}`);
    const resourceType = String((resourceResult.rows[0] as { type?: string })?.type || 'simulator');

    // Step 4+5: Acquire a user-level advisory lock to serialize billing reads and
    // session writes for the same member on the same day. Without this lock, two
    // concurrent bookings can both read 0 prior usage and skip overage fees.
    const userLockKey = `usage::${request.ownerEmail.toLowerCase()}::${request.sessionDate}`;
    let userLockHash = 0;
    for (let i = 0; i < userLockKey.length; i++) {
      userLockHash = ((userLockHash << 5) - userLockHash + userLockKey.charCodeAt(i)) | 0;
    }

    // When an externalTx is provided, the caller owns the transaction. Use a
    // transaction-scoped lock on that connection so it stays held until the
    // caller commits. When we manage the transaction ourselves, use a
    // session-level lock on a separate client so it spans both the billing
    // read and the write transaction.
    if (externalTx) {
      await externalTx.execute(sql`SELECT pg_advisory_xact_lock(${userLockHash})`);
    }

    const lockClient = externalTx ? null : await pool.connect();
    try {
    if (lockClient) {
      await lockClient.query(`SELECT pg_advisory_lock($1)`, [userLockHash]);
    }
    try {

    const billingResult = await calculateFullSessionBilling(
      request.sessionDate,
      request.durationMinutes,
      billingParticipants,
      request.ownerEmail,
      request.declaredPlayerCount || request.participants.length,
      { resourceType }
    );
    
    const executeDbWrites = async (tx: TransactionContext) => {
      const result = await createSession(
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
      const session = result.session;
      const linkedParticipants = result.participants;
      
      // Record usage ledger entries within the same transaction
      // IMPORTANT: Aggregate fees per member to avoid idempotency guard blocking valid entries
      const feesByMember = new Map<string, {
        minutesCharged: number;
        overageFee: number;
        guestFee: number;
        tierName?: string;
      }>();

      for (const billing of billingResult.billingBreakdown) {
        if (billing.participantType === 'guest') {
          if (billing.guestFee > 0) {
            const key = request.ownerEmail;
            const existing = feesByMember.get(key) || { minutesCharged: 0, overageFee: 0, guestFee: 0, tierName: ownerTier || undefined };
            existing.guestFee += billing.guestFee;
            feesByMember.set(key, existing);
          }
        } else {
          const memberEmail = billing.email || billing.userId || '';
          const key = memberEmail;
          const existing = feesByMember.get(key) || { minutesCharged: 0, overageFee: 0, guestFee: 0, tierName: billing.tierName || undefined };
          existing.minutesCharged += billing.minutesAllocated;
          existing.overageFee += billing.overageFee;
          feesByMember.set(key, existing);
        }
      }

      let ledgerEntriesCreated = 0;
      for (const [memberId, fees] of feesByMember) {
        await recordUsage(session.id, {
          memberId,
          minutesCharged: fees.minutesCharged,
          overageFee: fees.overageFee,
          guestFee: fees.guestFee,
          tierAtBooking: fees.tierName,
          paymentMethod: 'unpaid'
        }, source, tx);
        ledgerEntriesCreated++;
      }
      
      // Step 5c: Deduct guest passes INSIDE the transaction for atomicity
      let actualPassesDeducted = 0;
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
            const passesHeld = (holdResult.rows[0] as { passes_held: number }).passes_held as number || 0;
            const passesToConvert = Math.min(passesHeld, billingResult.guestPassesUsed);
            
            if (passesToConvert > 0) {
              // Verify we don't exceed total passes available
              const passCheck = await tx.execute(sql`
                SELECT passes_total, passes_used FROM guest_passes 
                WHERE LOWER(member_email) = ${emailLower}
                FOR UPDATE
              `);
              
              if (passCheck.rows && passCheck.rows.length > 0) {
                const passRow = passCheck.rows[0] as { passes_total: number; passes_used: number };
                const passes_total = passRow.passes_total as number;
                const passes_used = passRow.passes_used as number;
                if (passes_used + passesToConvert > passes_total) {
                  logger.warn('[createSessionWithUsageTracking] Insufficient guest passes for hold conversion, extra guests will be charged as paid', {
                    extra: { ownerEmail: request.ownerEmail, available: passes_total - passes_used, needed: passesToConvert }
                  });
                  const canConvert = Math.max(0, passes_total - passes_used);
                  if (canConvert > 0) {
                    await tx.execute(sql`
                      UPDATE guest_passes 
                      SET passes_used = ${passes_total}
                      WHERE LOWER(member_email) = ${emailLower}
                    `);
                    actualPassesDeducted = canConvert;
                  }
                } else {
                  await tx.execute(sql`
                    UPDATE guest_passes 
                    SET passes_used = passes_used + ${passesToConvert}
                    WHERE LOWER(member_email) = ${emailLower}
                  `);
                  actualPassesDeducted = passesToConvert;
                }
              } else {
                const tierResult = await tx.execute(sql`
                  SELECT mt.guest_passes_per_month 
                  FROM users u 
                  JOIN membership_tiers mt ON u.tier = mt.name 
                  WHERE LOWER(u.email) = ${emailLower}
                `);
                const monthlyAllocation = tierResult.rows?.[0] 
                  ? (tierResult.rows[0] as { guest_passes_per_month: number }).guest_passes_per_month as number || 0 
                  : 0;
                
                if (monthlyAllocation < passesToConvert) {
                  logger.warn('[createSessionWithUsageTracking] Member tier has insufficient guest pass allocation for hold conversion, extra guests will be charged as paid', {
                    extra: { ownerEmail: request.ownerEmail, monthlyAllocation, passesToConvert }
                  });
                  if (monthlyAllocation > 0) {
                    await tx.execute(sql`
                      INSERT INTO guest_passes (member_email, passes_total, passes_used)
                      VALUES (${emailLower}, ${monthlyAllocation}, ${monthlyAllocation})
                    `);
                    actualPassesDeducted = monthlyAllocation;
                  }
                } else {
                  await tx.execute(sql`
                    INSERT INTO guest_passes (member_email, passes_total, passes_used)
                    VALUES (${emailLower}, ${monthlyAllocation}, ${passesToConvert})
                  `);
                  actualPassesDeducted = passesToConvert;
                  logger.info('[createSessionWithUsageTracking] Created guest pass record for first-time user (hold conversion)', {
                    extra: { ownerEmail: request.ownerEmail, monthlyAllocation, passesToConvert }
                  });
                }
              }
            }
            
            // Delete the hold
            await tx.execute(sql`
              DELETE FROM guest_pass_holds WHERE booking_id = ${request.bookingId}
            `);
            
            if (passesToConvert < billingResult.guestPassesUsed) {
              logger.warn('[createSessionWithUsageTracking] Guest pass hold shortfall — extra guests will be charged as paid', {
                extra: { bookingId: request.bookingId, ownerEmail: request.ownerEmail, passesHeld, guestPassesUsed: billingResult.guestPassesUsed, passesConverted: passesToConvert }
              });
            }
            
            logger.info('[createSessionWithUsageTracking] Converted guest pass holds to usage (atomic)', {
              extra: { bookingId: request.bookingId, ownerEmail: request.ownerEmail, passesConverted: passesToConvert }
            });
          } else {
            // Hold was lost (transient DB error during booking creation) — fall back to direct deduction
            logger.warn('[createSessionWithUsageTracking] No guest pass holds found, falling back to direct deduction', {
              extra: { bookingId: request.bookingId, passesNeeded }
            });
            
            const passCheck = await tx.execute(sql`
              SELECT id, passes_total, passes_used FROM guest_passes 
              WHERE LOWER(member_email) = ${emailLower}
              FOR UPDATE
            `);
            
            if (passCheck.rows && passCheck.rows.length > 0) {
              const passRow = passCheck.rows[0] as { id: number; passes_total: number; passes_used: number };
              const passes_total = passRow.passes_total as number;
              const passes_used = passRow.passes_used as number;
              const available = passes_total - passes_used;
              
              if (available < passesNeeded) {
                logger.warn('[createSessionWithUsageTracking] Insufficient guest passes for direct deduction (hold fallback), extra guests will be charged as paid', {
                  extra: { ownerEmail: request.ownerEmail, available, needed: passesNeeded }
                });
                const canDeduct = Math.max(0, available);
                if (canDeduct > 0) {
                  await tx.execute(sql`
                    UPDATE guest_passes 
                    SET passes_used = ${passes_total}
                    WHERE LOWER(member_email) = ${emailLower}
                  `);
                  actualPassesDeducted = canDeduct;
                }
              } else {
                await tx.execute(sql`
                  UPDATE guest_passes 
                  SET passes_used = passes_used + ${passesNeeded}
                  WHERE LOWER(member_email) = ${emailLower}
                `);
                actualPassesDeducted = passesNeeded;
              }
              
              logger.info('[createSessionWithUsageTracking] Directly deducted guest passes (hold fallback)', {
                extra: { bookingId: request.bookingId, ownerEmail: request.ownerEmail, passesDeducted: actualPassesDeducted, passesNeeded }
              });
            } else {
              // First-time guest pass user (hold fallback) — create record with tier allocation
              const tierResult = await tx.execute(sql`
                SELECT mt.guest_passes_per_month 
                FROM users u 
                JOIN membership_tiers mt ON u.tier = mt.name 
                WHERE LOWER(u.email) = ${emailLower}
              `);
              const monthlyAllocation = tierResult.rows?.[0] 
                ? (tierResult.rows[0] as { guest_passes_per_month: number }).guest_passes_per_month as number || 0 
                : 0;
              
              if (monthlyAllocation < passesNeeded) {
                logger.info('[createSessionWithUsageTracking] Member tier has insufficient guest pass allocation, guests will be charged as paid', {
                  extra: { ownerEmail: request.ownerEmail, monthlyAllocation, passesNeeded }
                });
                // Don't throw — guests will be billed via fee calculator as paid guests
              } else {
                await tx.execute(sql`
                  INSERT INTO guest_passes (member_email, passes_total, passes_used)
                  VALUES (${emailLower}, ${monthlyAllocation}, ${passesNeeded})
                `);
                actualPassesDeducted = passesNeeded;
                
                logger.info('[createSessionWithUsageTracking] Created guest pass record for first-time user (hold fallback)', {
                  extra: { ownerEmail: request.ownerEmail, monthlyAllocation, passesDeducted: passesNeeded }
                });
              }
            }
          }
        } else {
          // Path 2: Staff/Trackman flow without holds - direct atomic deduction
          const passCheck = await tx.execute(sql`
            SELECT id, passes_total, passes_used FROM guest_passes 
            WHERE LOWER(member_email) = ${emailLower}
            FOR UPDATE
          `);
          
          if (passCheck.rows && passCheck.rows.length > 0) {
            const passRow = passCheck.rows[0] as { id: number; passes_total: number; passes_used: number };
            const passes_total = passRow.passes_total as number;
            const passes_used = passRow.passes_used as number;
            const available = passes_total - passes_used;
            
            if (available < passesNeeded) {
              logger.warn('[createSessionWithUsageTracking] Insufficient guest passes for direct deduction, extra guests will be charged as paid', {
                extra: { ownerEmail: request.ownerEmail, available, needed: passesNeeded }
              });
              const canDeduct = Math.max(0, available);
              if (canDeduct > 0) {
                await tx.execute(sql`
                  UPDATE guest_passes 
                  SET passes_used = ${passes_total}
                  WHERE LOWER(member_email) = ${emailLower}
                `);
                actualPassesDeducted = canDeduct;
              }
            } else {
              await tx.execute(sql`
                UPDATE guest_passes 
                SET passes_used = passes_used + ${passesNeeded}
                WHERE LOWER(member_email) = ${emailLower}
              `);
              actualPassesDeducted = passesNeeded;
            }
            
            logger.info('[createSessionWithUsageTracking] Deducted guest passes (atomic, no holds)', {
              extra: { ownerEmail: request.ownerEmail, passesDeducted: actualPassesDeducted, passesNeeded }
            });
          } else {
            // First-time guest pass user — create record with tier allocation
            const tierResult = await tx.execute(sql`
              SELECT mt.guest_passes_per_month 
              FROM users u 
              JOIN membership_tiers mt ON u.tier = mt.name 
              WHERE LOWER(u.email) = ${emailLower}
            `);
            const monthlyAllocation = tierResult.rows?.[0] 
              ? (tierResult.rows[0] as { guest_passes_per_month: number }).guest_passes_per_month as number || 0 
              : 0;
            
            if (monthlyAllocation < passesNeeded) {
              logger.info('[createSessionWithUsageTracking] Member tier has insufficient guest pass allocation, guests will be charged as paid', {
                extra: { ownerEmail: request.ownerEmail, monthlyAllocation, passesNeeded }
              });
              // Don't throw — guests will be billed via fee calculator as paid guests
            } else {
              await tx.execute(sql`
                INSERT INTO guest_passes (member_email, passes_total, passes_used)
                VALUES (${emailLower}, ${monthlyAllocation}, ${passesNeeded})
              `);
              actualPassesDeducted = passesNeeded;
              
              logger.info('[createSessionWithUsageTracking] Created guest pass record for first-time user', {
                extra: { ownerEmail: request.ownerEmail, monthlyAllocation, passesDeducted: passesNeeded }
              });
            }
          }
        }
      }
      
      if (actualPassesDeducted > 0) {
        const guestParticipantIds = linkedParticipants
          .filter(p => p.participantType === 'guest')
          .slice(0, actualPassesDeducted)
          .map(p => p.id);
        
        if (guestParticipantIds.length > 0) {
          await tx.execute(sql`
            UPDATE booking_participants 
            SET used_guest_pass = true, payment_status = 'paid'
            WHERE id = ANY(${toIntArrayLiteral(guestParticipantIds)}::int[])
          `);
          
          logger.info('[createSessionWithUsageTracking] Marked guest participants with used_guest_pass=true', {
            extra: { sessionId: session.id, guestParticipantIds, count: guestParticipantIds.length }
          });
        }
      }

      if (request.bookingId) {
        await tx.execute(
          sql`UPDATE booking_requests SET session_id = ${session.id}, updated_at = NOW() WHERE id = ${request.bookingId}`
        );
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

    const result = {
      success: true as const,
      session: txResult.session,
      participants: txResult.linkedParticipants,
      usageLedgerEntries: txResult.ledgerEntriesCreated
    };

    return result;

    } finally {
      if (lockClient) {
        await lockClient.query(`SELECT pg_advisory_unlock($1)`, [userLockHash]).catch((unlockErr: unknown) => { logger.warn('[SessionManager] Advisory lock release failed', { error: getErrorMessage(unlockErr) }); });
      }
    }
    } finally {
      if (lockClient) {
        safeRelease(lockClient);
      }
    }
  } catch (error: unknown) {
    logger.error('[createSessionWithUsageTracking] Error:', { error: getErrorMessage(error) });
    return {
      success: false,
      error: getErrorMessage(error),
      errorType: 'database_error'
    };
  }
}
