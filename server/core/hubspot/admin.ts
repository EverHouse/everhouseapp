import { db } from '../../db';
import { pool } from '../db';
import { discountRules } from '../../../shared/schema';
import { eq } from 'drizzle-orm';

import { logger } from '../logger';
export async function getAllDiscountRules(): Promise<any[]> {
  try {
    const rules = await db.select().from(discountRules).orderBy(discountRules.discountPercent);
    return rules;
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error fetching discount rules:', { error: error });
    return [];
  }
}

export async function updateDiscountRule(
  discountTag: string,
  discountPercent: number,
  description?: string
): Promise<boolean> {
  try {
    await db.update(discountRules)
      .set({
        discountPercent,
        description,
        updatedAt: new Date()
      })
      .where(eq(discountRules.discountTag, discountTag));
    
    return true;
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error updating discount rule:', { error: error });
    return false;
  }
}

export async function getBillingAuditLog(memberEmail: string, limit: number = 50): Promise<any[]> {
  try {
    const result = await pool.query(
      `SELECT * FROM billing_audit_log 
       WHERE member_email = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [memberEmail.toLowerCase(), limit]
    );
    return result.rows;
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error fetching billing audit log:', { error: error });
    return [];
  }
}
