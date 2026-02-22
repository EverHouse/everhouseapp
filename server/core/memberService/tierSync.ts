import { db } from '../../db';
import { sql } from 'drizzle-orm';
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
    const tierResult = await db.execute(sql`SELECT id, slug, name FROM membership_tiers 
       WHERE stripe_price_id = ${stripePriceId} OR founding_price_id = ${stripePriceId}`);
    
    if (tierResult.rows.length === 0) {
      logger.warn(`[TierSync] No tier found for price ${stripePriceId}`);
      return { success: false, error: `No tier found for price ID: ${stripePriceId}` };
    }
    
    const row = tierResult.rows[0] as Record<string, unknown>;
    const { id: tierId, slug: tierSlug, name: tierName } = row as { id: number; slug: string; name: string };
    
    const updateResult = await db.execute(sql`UPDATE users SET tier = ${tierSlug}, tier_id = ${tierId}, updated_at = NOW() 
       WHERE LOWER(email) = LOWER(${email})
       RETURNING id`);
    
    if (updateResult.rowCount === 0) {
      logger.warn(`[TierSync] No user found for email ${email}`);
      return { success: false, error: `No user found for email: ${email}` };
    }
    
    logger.info(`[TierSync] Synced ${email} to tier ${tierSlug} (${tierName})`);
    
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
    
    const updateResult = await db.execute(sql`UPDATE users SET membership_status = ${membershipStatus}, updated_at = NOW() 
       WHERE LOWER(email) = LOWER(${email})
       RETURNING id`);
    
    if (updateResult.rowCount === 0) {
      logger.warn(`[TierSync] No user found for email ${email}`);
      return { success: false, error: `No user found for email: ${email}` };
    }
    
    logger.info(`[TierSync] Updated ${email} membership_status to ${membershipStatus}`);
    
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
    const tierResult = await db.execute(sql`SELECT id, slug, name FROM membership_tiers 
       WHERE stripe_price_id = ${stripePriceId} OR founding_price_id = ${stripePriceId}`);
    
    if (tierResult.rows.length === 0) {
      return null;
    }
    
    return tierResult.rows[0] as { id: number; slug: string; name: string };
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
    const userResult = await db.execute(sql`SELECT u.id, u.email, u.tier, u.tier_id, u.stripe_subscription_id,
              mt.slug as tier_slug, mt.name as tier_name
       FROM users u
       LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
       WHERE LOWER(u.email) = LOWER(${email})`);
    
    if (userResult.rows.length === 0) {
      return { isConsistent: false, issues: ['User not found'] };
    }
    
    const user = userResult.rows[0] as Record<string, unknown>;
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
