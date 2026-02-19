import { pool } from '../db';
import { PoolClient } from 'pg';

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
  externalClient?: PoolClient
): Promise<number> {
  const client = externalClient || await pool.connect();
  const emailLower = memberEmail.toLowerCase().trim();
  
  try {
    const tierResult = await client.query(
      `SELECT mt.guest_passes_per_month 
       FROM users u 
       JOIN membership_tiers mt ON LOWER(u.tier) = LOWER(mt.name)
       WHERE LOWER(u.email) = $1`,
      [emailLower]
    );
    const tierGuestPasses = tierResult.rows[0]?.guest_passes_per_month ?? 4;
    
    const guestPassResult = await client.query(
      `SELECT passes_used, passes_total FROM guest_passes WHERE LOWER(member_email) = $1`,
      [emailLower]
    );
    
    let passesUsed = 0;
    let passesTotal = tierGuestPasses;
    
    if (guestPassResult.rows.length > 0) {
      passesUsed = guestPassResult.rows[0].passes_used || 0;
      passesTotal = guestPassResult.rows[0].passes_total || tierGuestPasses;
      if (tierGuestPasses > passesTotal) {
        await client.query(
          `UPDATE guest_passes SET passes_total = $1 WHERE LOWER(member_email) = $2`,
          [tierGuestPasses, emailLower]
        );
        passesTotal = tierGuestPasses;
      }
    }
    
    const holdsResult = await client.query(
      `SELECT COALESCE(SUM(passes_held), 0) as total_held 
       FROM guest_pass_holds 
       WHERE LOWER(member_email) = $1 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [emailLower]
    );
    const passesHeld = parseInt(holdsResult.rows[0]?.total_held || '0', 10);
    
    const available = Math.max(0, passesTotal - passesUsed - passesHeld);
    return available;
  } finally {
    if (!externalClient) {
      client.release();
    }
  }
}

export async function createGuestPassHold(
  memberEmail: string,
  bookingId: number,
  passesNeeded: number,
  externalClient?: PoolClient
): Promise<GuestPassHoldResult> {
  if (passesNeeded <= 0) {
    return { success: true, passesHeld: 0 };
  }
  
  const client = externalClient || await pool.connect();
  const emailLower = memberEmail.toLowerCase().trim();
  const manageTransaction = !externalClient;
  
  try {
    if (manageTransaction) {
      await client.query('BEGIN');
    }
    
    await client.query(
      `SELECT id FROM guest_passes WHERE LOWER(member_email) = $1 FOR UPDATE`,
      [emailLower]
    );
    
    const available = await getAvailableGuestPasses(emailLower, undefined, client);
    const passesToHold = Math.min(passesNeeded, available);
    
    if (passesToHold <= 0 && passesNeeded > 0) {
      if (manageTransaction) {
        await client.query('ROLLBACK');
      }
      return {
        success: false,
        error: `Not enough guest passes available. Requested: ${passesNeeded}, Available: ${available}`,
        passesAvailable: available
      };
    }
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    
    const insertResult = await client.query(
      `INSERT INTO guest_pass_holds (member_email, booking_id, passes_held, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [emailLower, bookingId, passesToHold, expiresAt]
    );
    
    if (manageTransaction) {
      await client.query('COMMIT');
    }
    
    return {
      success: true,
      holdId: insertResult.rows[0].id,
      passesHeld: passesToHold,
      passesAvailable: available - passesToHold
    };
  } catch (error: unknown) {
    if (manageTransaction) {
      await client.query('ROLLBACK');
    }
    logger.error('[GuestPassHoldService] Error creating hold:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error)
    };
  } finally {
    if (!externalClient) {
      client.release();
    }
  }
}

export async function releaseGuestPassHold(
  bookingId: number
): Promise<{ success: boolean; passesReleased: number }> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `DELETE FROM guest_pass_holds WHERE booking_id = $1 RETURNING passes_held`,
      [bookingId]
    );
    
    const passesReleased = result.rows.reduce((sum, row) => sum + (row.passes_held || 0), 0);
    logger.info(`[GuestPassHoldService] Released ${passesReleased} guest pass holds for booking ${bookingId}`);
    
    return { success: true, passesReleased };
  } catch (error: unknown) {
    logger.error('[GuestPassHoldService] Error releasing hold:', { error: error });
    return { success: false, passesReleased: 0 };
  } finally {
    client.release();
  }
}

export async function convertHoldToUsage(
  bookingId: number,
  memberEmail: string
): Promise<{ success: boolean; passesConverted: number }> {
  const client = await pool.connect();
  const emailLower = memberEmail.toLowerCase().trim();
  
  try {
    await client.query('BEGIN');
    
    const holdResult = await client.query(
      `SELECT id, passes_held FROM guest_pass_holds 
       WHERE booking_id = $1 AND LOWER(member_email) = $2
       FOR UPDATE`,
      [bookingId, emailLower]
    );
    
    if (holdResult.rows.length === 0) {
      await client.query('COMMIT');
      return { success: true, passesConverted: 0 };
    }
    
    const passesToConvert = holdResult.rows[0].passes_held;
    
    if (passesToConvert > 0) {
      await client.query(
        `UPDATE guest_passes 
         SET passes_used = passes_used + $1
         WHERE LOWER(member_email) = $2`,
        [passesToConvert, emailLower]
      );
    }
    
    await client.query(
      `DELETE FROM guest_pass_holds WHERE booking_id = $1`,
      [bookingId]
    );
    
    await client.query('COMMIT');
    
    logger.info(`[GuestPassHoldService] Converted ${passesToConvert} held passes to usage for booking ${bookingId}`);
    return { success: true, passesConverted: passesToConvert };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    logger.error('[GuestPassHoldService] Error converting hold:', { error: error });
    return { success: false, passesConverted: 0 };
  } finally {
    client.release();
  }
}

export async function cleanupExpiredHolds(): Promise<number> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `DELETE FROM guest_pass_holds WHERE expires_at < NOW() RETURNING id`
    );
    
    const deleted = result.rowCount || 0;
    if (deleted > 0) {
      logger.info(`[GuestPassHoldService] Cleaned up ${deleted} expired guest pass holds`);
    }
    return deleted;
  } finally {
    client.release();
  }
}
