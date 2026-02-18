import { db } from '../db';
import { users } from '../../shared/schema';
import { sql } from 'drizzle-orm';
import { handleTierChange, queueTierSync } from './hubspot';
import { notifyMember } from './notificationService';

import { logger } from './logger';
function getTierRank(tier: string): number {
  const ranks: Record<string, number> = {
    'social': 1, 'core': 2, 'premium': 3, 'vip': 4, 'corporate': 5
  };
  return ranks[tier.toLowerCase()] || 0;
}

interface MemberTierUpdatePayload {
  email: string;
  newTier: string;
  oldTier: string | null;
  performedBy: string;
  performedByName: string;
  syncToHubspot?: boolean;
  tierId?: number;
  csvTier?: string;
}

export async function processMemberTierUpdate(payload: MemberTierUpdatePayload): Promise<void> {
  const {
    email,
    newTier,
    oldTier,
    performedBy,
    performedByName,
    syncToHubspot = true,
    tierId,
    csvTier
  } = payload;

  const normalizedEmail = email.toLowerCase().trim();

  try {
    // Fetch current user data
    const userResult = await db
      .select({
        id: users.id,
        email: users.email,
        tier: users.tier,
        firstName: users.firstName,
        lastName: users.lastName,
        billingProvider: users.billingProvider,
        stripeSubscriptionId: users.stripeSubscriptionId
      })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);

    if (userResult.length === 0) {
      logger.warn(`[MemberTierUpdateProcessor] Member not found: ${normalizedEmail}`);
      return;
    }

    const user = userResult[0];

    // Double-check that the tier actually needs to change
    if (user.tier === newTier) {
      logger.info(`[MemberTierUpdateProcessor] Member ${normalizedEmail} is already on tier ${newTier}, skipping`);
      return;
    }

    // Update database with new tier
    const tierIdValue = tierId || (newTier ? getTierIdFromTierName(newTier) : null);
    await db
      .update(users)
      .set({
        tier: newTier,
        tierId: tierIdValue,
        ...(csvTier && { membershipTier: csvTier }),
        updatedAt: new Date()
      })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);

    // Sync to HubSpot if requested
    if (syncToHubspot && newTier) {
      const hubspotResult = await handleTierChange(
        normalizedEmail,
        oldTier || 'None',
        newTier,
        performedBy,
        performedByName
      );

      if (!hubspotResult.success && hubspotResult.error) {
        logger.warn(`[MemberTierUpdateProcessor] HubSpot sync failed for ${normalizedEmail}, queuing for retry: ${hubspotResult.error}`);
        await queueTierSync({
          email: normalizedEmail,
          newTier,
          oldTier: oldTier || 'None',
          changedBy: performedBy,
          changedByName: performedByName
        });
      } else {
        logger.info(`[MemberTierUpdateProcessor] HubSpot sync successful for ${normalizedEmail}: ${oldTier || 'None'} → ${newTier}`);
      }
    }

    // Notify member of tier change
    const isUpgrade = newTier
      ? getTierRank(newTier) > getTierRank(oldTier || '')
      : false;
    const isFirstTier = !oldTier && newTier;
    const changeType = isFirstTier
      ? 'set'
      : newTier
      ? isUpgrade
        ? 'upgraded'
        : 'changed'
      : 'cleared';

    await notifyMember({
      userEmail: normalizedEmail,
      title: isFirstTier
        ? 'Membership Tier Assigned'
        : newTier
        ? isUpgrade
          ? 'Membership Upgraded'
          : 'Membership Updated'
        : 'Membership Cleared',
      message: isFirstTier
        ? `Your membership tier has been set to ${newTier}`
        : newTier
        ? `Your membership has been ${changeType} from ${oldTier} to ${newTier}`
        : `Your membership tier has been cleared (was ${oldTier})`,
      type: 'system',
      url: '/member/profile'
    });

    logger.info(`[MemberTierUpdateProcessor] Successfully updated ${normalizedEmail}: ${oldTier || 'None'} → ${newTier}`);
  } catch (error: unknown) {
    logger.error(`[MemberTierUpdateProcessor] Error updating tier for ${normalizedEmail}:`, { error: error });
    throw error;
  }
}

function getTierIdFromTierName(tierName: string): number | null {
  const tierIdMap: Record<string, number> = {
    Social: 1,
    Core: 2,
    Premium: 3,
    Corporate: 4,
    VIP: 5
  };
  return tierIdMap[tierName] || null;
}
