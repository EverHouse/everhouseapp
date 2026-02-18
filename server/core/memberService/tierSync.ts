import { pool } from '../db';
import { getErrorMessage } from '../../utils/errorUtils';

import { logger } from '../logger';
export interface TierSyncResult {
  success: boolean;
  newTier?: string;
  newTierId?: number;
  error?: string;
}

export async function syncMemberTierFromStripe(
  email: string,
  stripePriceId: string
): Promise<TierSyncResult> {
  try {
    const tierResult = await pool.query(
      `SELECT id, slug, name FROM membership_tiers 
       WHERE stripe_price_id = $1 OR founding_price_id = $1`,
      [stripePriceId]
    );
    
    if (tierResult.rows.length === 0) {
      logger.warn(`[TierSync] No tier found for price ${stripePriceId}`);
      return { success: false, error: `No tier found for price ID: ${stripePriceId}` };
    }
    
    const { id: tierId, slug: tierSlug, name: tierName } = tierResult.rows[0];
    
    const updateResult = await pool.query(
      `UPDATE users SET tier = $1, tier_id = $2, updated_at = NOW() 
       WHERE LOWER(email) = LOWER($3)
       RETURNING id`,
      [tierSlug, tierId, email]
    );
    
    if (updateResult.rowCount === 0) {
      logger.warn(`[TierSync] No user found for email ${email}`);
      return { success: false, error: `No user found for email: ${email}` };
    }
    
    logger.info(`[TierSync] Synced ${email} to tier ${tierSlug} (${tierName})`);
    
    // Sync tier change to HubSpot
    try {
      const { syncMemberToHubSpot } = await import('../hubspot/stages');
      await syncMemberToHubSpot({ email, tier: tierName, billingProvider: 'stripe' });
      logger.info(`[TierSync] Synced ${email} tier=${tierName} to HubSpot`);
    } catch (hubspotError) {
      logger.error('[TierSync] HubSpot sync failed:', { error: hubspotError });
    }
    
    return { success: true, newTier: tierSlug, newTierId: tierId };
  } catch (error: unknown) {
    logger.error('[TierSync] Error syncing tier:', { error: error });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function syncMemberStatusFromStripe(
  email: string,
  stripeStatus: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'trialing'
): Promise<{ success: boolean; error?: string }> {
  try {
    let membershipStatus: string;
    
    switch (stripeStatus) {
      case 'active':
      case 'trialing':
        membershipStatus = 'active';
        break;
      case 'past_due':
        membershipStatus = 'past_due';
        break;
      case 'canceled':
        membershipStatus = 'cancelled';
        break;
      case 'unpaid':
        membershipStatus = 'suspended';
        break;
      case 'incomplete':
        membershipStatus = 'pending';
        break;
      default:
        membershipStatus = 'inactive';
    }
    
    const updateResult = await pool.query(
      `UPDATE users SET membership_status = $1, updated_at = NOW() 
       WHERE LOWER(email) = LOWER($2)
       RETURNING id`,
      [membershipStatus, email]
    );
    
    if (updateResult.rowCount === 0) {
      logger.warn(`[TierSync] No user found for email ${email}`);
      return { success: false, error: `No user found for email: ${email}` };
    }
    
    logger.info(`[TierSync] Updated ${email} membership_status to ${membershipStatus}`);
    
    // Sync status change to HubSpot
    try {
      const { syncMemberToHubSpot } = await import('../hubspot/stages');
      await syncMemberToHubSpot({ email, status: membershipStatus, billingProvider: 'stripe' });
      logger.info(`[TierSync] Synced ${email} status=${membershipStatus} to HubSpot`);
    } catch (hubspotError) {
      logger.error('[TierSync] HubSpot sync failed:', { error: hubspotError });
    }
    
    return { success: true };
  } catch (error: unknown) {
    logger.error('[TierSync] Error syncing status:', { error: error });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getTierFromPriceId(stripePriceId: string): Promise<{
  id: number;
  slug: string;
  name: string;
} | null> {
  try {
    const tierResult = await pool.query(
      `SELECT id, slug, name FROM membership_tiers 
       WHERE stripe_price_id = $1 OR founding_price_id = $1`,
      [stripePriceId]
    );
    
    if (tierResult.rows.length === 0) {
      return null;
    }
    
    return tierResult.rows[0];
  } catch (error: unknown) {
    logger.error('[TierSync] Error getting tier from price ID:', { error: error });
    return null;
  }
}

export async function validateTierConsistency(email: string): Promise<{
  isConsistent: boolean;
  issues: string[];
  recommendation?: string;
}> {
  try {
    const userResult = await pool.query(
      `SELECT u.id, u.email, u.tier, u.tier_id, u.stripe_subscription_id,
              mt.slug as tier_slug, mt.name as tier_name
       FROM users u
       LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
       WHERE LOWER(u.email) = LOWER($1)`,
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return { isConsistent: false, issues: ['User not found'] };
    }
    
    const user = userResult.rows[0];
    const issues: string[] = [];
    
    if (user.tier_id && user.tier !== user.tier_slug) {
      issues.push(`tier (${user.tier}) doesn't match tier_id's slug (${user.tier_slug})`);
    }
    
    if (!user.tier_id && user.tier) {
      issues.push(`tier set to "${user.tier}" but tier_id is null`);
    }
    
    if (user.tier_id && !user.tier) {
      issues.push(`tier_id set to ${user.tier_id} but tier is null`);
    }
    
    return {
      isConsistent: issues.length === 0,
      issues,
      recommendation: issues.length > 0 
        ? 'Run syncMemberTierFromStripe with the subscription price ID to fix consistency'
        : undefined
    };
  } catch (error: unknown) {
    logger.error('[TierSync] Error validating tier consistency:', { error: error });
    return { isConsistent: false, issues: [getErrorMessage(error) || 'Unknown error'] };
  }
}
