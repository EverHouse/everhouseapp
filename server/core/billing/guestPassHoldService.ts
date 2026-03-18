import { db } from '../../db';
import { sql } from 'drizzle-orm';
import type { TransactionContext } from '../bookingService/sessionManager';

import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
export interface GuestPassHoldResult {
  success: boolean;
  error?: string;
  holdId?: number;
  passesHeld?: number;
  passesAvailable?: number;
}

export async function getAvailableGuestPasses(
  memberEmail: string,
  tierName?: string,
  txCtx?: TransactionContext
): Promise<number> {
  const executor = txCtx || db;
  const emailLower = memberEmail.toLowerCase().trim();
  
  const tierResult = await executor.execute(sql`
    SELECT mt.guest_passes_per_year 
    FROM users u 
    JOIN membership_tiers mt ON u.tier_id = mt.id
    WHERE LOWER(u.email) = ${emailLower}
  `);
  const tierGuestPasses = (tierResult.rows[0] as Record<string, unknown>)?.guest_passes_per_year as number ?? 4;
  
  const guestPassResult = await executor.execute(sql`
    SELECT passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = ${emailLower}
  `);
  
  let passesUsed = 0;
  let passesTotal = tierGuestPasses;
  
  if (guestPassResult.rows.length > 0) {
    const row = guestPassResult.rows[0] as Record<string, unknown>;
    passesUsed = (row.passes_used as number) || 0;
    passesTotal = (row.passes_total as number) || tierGuestPasses;
    if (tierGuestPasses > passesTotal) {
      await executor.execute(sql`
        UPDATE guest_passes SET passes_total = ${tierGuestPasses} WHERE LOWER(member_email) = ${emailLower}
      `);
      passesTotal = tierGuestPasses;
    }
  }
  
  const holdsResult = await executor.execute(sql`
    SELECT COALESCE(SUM(passes_held), 0) as total_held 
    FROM guest_pass_holds 
    WHERE LOWER(member_email) = ${emailLower} 
    AND (expires_at IS NULL OR expires_at > NOW())
  `);
  const passesHeld = parseInt(String((holdsResult.rows[0] as Record<string, unknown>)?.total_held || '0'), 10);
  
  const available = Math.max(0, passesTotal - passesUsed - passesHeld);
  return available;
}

export async function createGuestPassHold(
  memberEmail: string,
  bookingId: number,
  passesNeeded: number,
  txCtx?: TransactionContext
): Promise<GuestPassHoldResult> {
  if (passesNeeded <= 0) {
    return { success: true, passesHeld: 0 };
  }
  
  const emailLower = memberEmail.toLowerCase().trim();
  
  const doWork = async (executor: TransactionContext) => {
    await executor.execute(sql`
      INSERT INTO guest_passes (member_email, passes_used, passes_total)
      VALUES (${emailLower}, 0, 0)
      ON CONFLICT (member_email) DO NOTHING
    `);

    await executor.execute(sql`
      SELECT id FROM guest_passes WHERE LOWER(member_email) = ${emailLower} ORDER BY id ASC FOR UPDATE
    `);
    
    const available = await getAvailableGuestPasses(emailLower, undefined, executor);
    const passesToHold = Math.min(passesNeeded, available);
    
    if (passesToHold <= 0 && passesNeeded > 0) {
      return {
        success: false,
        error: `Not enough guest passes available. Requested: ${passesNeeded}, Available: ${available}`,
        passesAvailable: available
      };
    }
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    
    const insertResult = await executor.execute(sql`
      INSERT INTO guest_pass_holds (member_email, booking_id, passes_held, expires_at)
      VALUES (${emailLower}, ${bookingId}, ${passesToHold}, ${expiresAt})
      RETURNING id
    `);
    
    return {
      success: true,
      holdId: (insertResult.rows[0] as Record<string, unknown>).id as number,
      passesHeld: passesToHold,
      passesAvailable: available - passesToHold
    };
  };

  try {
    if (txCtx) {
      return await doWork(txCtx);
    }
    return await db.transaction(async (tx) => {
      return await doWork(tx);
    });
  } catch (error: unknown) {
    logger.error('[GuestPassHoldService] Error creating hold:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error)
    };
  }
}

export async function releaseGuestPassHold(
  bookingId: number
): Promise<{ success: boolean; passesReleased: number }> {
  try {
    const result = await db.execute(sql`
      DELETE FROM guest_pass_holds WHERE booking_id = ${bookingId} RETURNING passes_held
    `);
    
    const passesReleased = (result.rows as Array<Record<string, unknown>>).reduce(
      (sum, row) => sum + ((row.passes_held as number) || 0), 0
    );
    logger.info(`[GuestPassHoldService] Released ${passesReleased} guest pass holds for booking ${bookingId}`);
    
    return { success: true, passesReleased };
  } catch (error: unknown) {
    logger.error('[GuestPassHoldService] Error releasing hold:', { error: error });
    return { success: false, passesReleased: 0 };
  }
}

export async function convertHoldToUsage(
  bookingId: number,
  memberEmail: string
): Promise<{ success: boolean; passesConverted: number }> {
  const emailLower = memberEmail.toLowerCase().trim();
  
  try {
    return await db.transaction(async (tx) => {
      const holdResult = await tx.execute(sql`
        SELECT id, passes_held FROM guest_pass_holds 
        WHERE booking_id = ${bookingId} AND LOWER(member_email) = ${emailLower}
        FOR UPDATE
      `);
      
      if (holdResult.rows.length === 0) {
        return { success: true, passesConverted: 0 };
      }
      
      const passesToConvert = (holdResult.rows[0] as Record<string, unknown>).passes_held as number;
      
      if (passesToConvert > 0) {
        const updateResult = await tx.execute(sql`
          UPDATE guest_passes 
          SET passes_used = passes_used + ${passesToConvert}
          WHERE LOWER(member_email) = ${emailLower}
        `);
        if ((updateResult.rowCount ?? 0) === 0) {
          const tierResult = await tx.execute(sql`
            SELECT mt.guest_passes_per_year 
            FROM users u JOIN membership_tiers mt ON u.tier_id = mt.id
            WHERE LOWER(u.email) = ${emailLower} LIMIT 1
          `);
          const tierAllocation = (tierResult.rows[0] as Record<string, unknown>)?.guest_passes_per_year as number ?? 4;
          await tx.execute(sql`
            INSERT INTO guest_passes (member_email, passes_total, passes_used)
            VALUES (${emailLower}, ${tierAllocation}, ${passesToConvert})
            ON CONFLICT (member_email) DO UPDATE SET passes_used = guest_passes.passes_used + ${passesToConvert}
          `);
          logger.info(`[GuestPassHoldService] Created guest_passes row for ${emailLower} during hold-to-usage conversion`);
        }
      }
      
      await tx.execute(sql`
        DELETE FROM guest_pass_holds WHERE booking_id = ${bookingId}
      `);
      
      logger.info(`[GuestPassHoldService] Converted ${passesToConvert} held passes to usage for booking ${bookingId}`);
      return { success: true, passesConverted: passesToConvert };
    });
  } catch (error: unknown) {
    logger.error('[GuestPassHoldService] Error converting hold:', { error: error });
    return { success: false, passesConverted: 0 };
  }
}

export async function cleanupExpiredHolds(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM guest_pass_holds WHERE expires_at < NOW() RETURNING id
  `);
  
  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    logger.info(`[GuestPassHoldService] Cleaned up ${deleted} expired guest pass holds`);
  }
  return deleted;
}
