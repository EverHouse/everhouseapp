import { db } from '../../db';
import { discountRules } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from './client';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';

import { logger } from '../logger';
export interface DiscountSyncResult {
  discountTag: string;
  discountPercent: number;
  success: boolean;
  stripeCouponId?: string;
  error?: string;
  action: 'created' | 'updated' | 'skipped';
}

export async function syncDiscountRulesToStripeCoupons(): Promise<{
  success: boolean;
  results: DiscountSyncResult[];
  synced: number;
  failed: number;
  skipped: number;
}> {
  const results: DiscountSyncResult[] = [];
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const stripe = await getStripeClient();
    const rules = await db.select().from(discountRules).where(eq(discountRules.isActive, true));

    logger.info(`[Discount Sync] Starting sync for ${rules.length} active discount rules`);

    for (const rule of rules) {
      try {
        if (rule.discountPercent <= 0 || rule.discountPercent > 100) {
          logger.info(`[Discount Sync] Skipping ${rule.discountTag}: Invalid percent (${rule.discountPercent})`);
          results.push({
            discountTag: rule.discountTag,
            discountPercent: rule.discountPercent,
            success: true,
            action: 'skipped',
          });
          skipped++;
          continue;
        }

        const couponId = `${rule.discountTag.replace(/\s+/g, '_').toUpperCase()}_${rule.discountPercent}PCT`;
        
        try {
          const existingCoupon = await stripe.coupons.retrieve(couponId);
          
          if (existingCoupon.percent_off !== rule.discountPercent) {
            await stripe.coupons.del(couponId);
            await stripe.coupons.create({
              id: couponId,
              percent_off: rule.discountPercent,
              duration: 'forever',
              name: `${rule.discountTag} (${rule.discountPercent}% off)`,
              metadata: {
                discount_tag: rule.discountTag,
                source: 'app_discount_rules',
              },
            });
            logger.info(`[Discount Sync] Updated coupon ${couponId} (changed percent)`);
            results.push({
              discountTag: rule.discountTag,
              discountPercent: rule.discountPercent,
              success: true,
              stripeCouponId: couponId,
              action: 'updated',
            });
            synced++;
          } else {
            logger.info(`[Discount Sync] Coupon ${couponId} already exists with correct percent`);
            results.push({
              discountTag: rule.discountTag,
              discountPercent: rule.discountPercent,
              success: true,
              stripeCouponId: couponId,
              action: 'skipped',
            });
            skipped++;
          }
        } catch (retrieveError: unknown) {
          if (getErrorCode(retrieveError) === 'resource_missing') {
            await stripe.coupons.create({
              id: couponId,
              percent_off: rule.discountPercent,
              duration: 'forever',
              name: `${rule.discountTag} (${rule.discountPercent}% off)`,
              metadata: {
                discount_tag: rule.discountTag,
                source: 'app_discount_rules',
              },
            });
            logger.info(`[Discount Sync] Created coupon ${couponId}`);
            results.push({
              discountTag: rule.discountTag,
              discountPercent: rule.discountPercent,
              success: true,
              stripeCouponId: couponId,
              action: 'created',
            });
            synced++;
          } else {
            throw retrieveError;
          }
        }
      } catch (error: unknown) {
        logger.error(`[Discount Sync] Error syncing ${rule.discountTag}:`, { error: error });
        results.push({
          discountTag: rule.discountTag,
          discountPercent: rule.discountPercent,
          success: false,
          error: getErrorMessage(error),
          action: 'skipped',
        });
        failed++;
      }
    }

    logger.info(`[Discount Sync] Complete: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    return { success: true, results, synced, failed, skipped };
  } catch (error: unknown) {
    logger.error('[Discount Sync] Fatal error:', { error: error });
    return { success: false, results, synced, failed, skipped };
  }
}

export async function getDiscountSyncStatus(): Promise<Array<{
  discountTag: string;
  discountPercent: number;
  expectedCouponId: string;
  existsInStripe: boolean;
}>> {
  try {
    const stripe = await getStripeClient();
    const rules = await db.select().from(discountRules).where(eq(discountRules.isActive, true));
    
    const statuses = [];
    
    for (const rule of rules) {
      if (rule.discountPercent <= 0 || rule.discountPercent > 100) continue;
      
      const couponId = `${rule.discountTag.replace(/\s+/g, '_').toUpperCase()}_${rule.discountPercent}PCT`;
      let existsInStripe = false;
      
      try {
        await stripe.coupons.retrieve(couponId);
        existsInStripe = true;
      } catch {
        existsInStripe = false;
      }
      
      statuses.push({
        discountTag: rule.discountTag,
        discountPercent: rule.discountPercent,
        expectedCouponId: couponId,
        existsInStripe,
      });
    }
    
    return statuses;
  } catch (error: unknown) {
    logger.error('[Discount Sync] Error getting status:', { error: error });
    return [];
  }
}

export async function findOrCreateCoupon(discountTag: string, discountPercent: number): Promise<string | null> {
  if (discountPercent <= 0 || discountPercent > 100) return null;
  
  try {
    const stripe = await getStripeClient();
    const couponId = `${discountTag.replace(/\s+/g, '_').toUpperCase()}_${discountPercent}PCT`;
    
    try {
      await stripe.coupons.retrieve(couponId);
      return couponId;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'resource_missing') {
        await stripe.coupons.create({
          id: couponId,
          percent_off: discountPercent,
          duration: 'forever',
          name: `${discountTag} (${discountPercent}% off)`,
          metadata: {
            discount_tag: discountTag,
            source: 'app_discount_rules',
          },
        });
        return couponId;
      }
      throw error;
    }
  } catch (error: unknown) {
    logger.error(`[Discount] Error finding/creating coupon for ${discountTag}:`, { error: error });
    return null;
  }
}
