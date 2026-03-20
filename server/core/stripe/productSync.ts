import { db } from '../../db';
import { membershipTiers } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from './client';
import Stripe from 'stripe';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';
import { findExistingStripeProduct, buildPrivilegeMetadata, type StripePaginationParams } from './productHelpers';

export interface TierSyncResult {
  tierId: number;
  tierName: string;
  tierSlug: string;
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  foundingPriceId?: string;
  error?: string;
  action: 'created' | 'updated' | 'skipped';
}

export async function syncMembershipTiersToStripe(): Promise<{
  success: boolean;
  results: TierSyncResult[];
  synced: number;
  failed: number;
  skipped: number;
}> {
  const results: TierSyncResult[] = [];
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const stripe = await getStripeClient();
    const tiers = await db.select().from(membershipTiers).where(eq(membershipTiers.isActive, true));

    logger.info(`[Tier Sync] Starting sync for ${tiers.length} active tiers`);

    for (const tier of tiers) {
      try {
        const NON_SUBSCRIPTION_PRODUCT_TYPES = ['one_time', 'config', 'fee'];
        if (tier.productType && NON_SUBSCRIPTION_PRODUCT_TYPES.includes(tier.productType)) {
          logger.info(`[Tier Sync] Skipping ${tier.name}: Non-subscription product_type "${tier.productType}"`);
          results.push({
            tierId: tier.id,
            tierName: tier.name,
            tierSlug: tier.slug,
            success: true,
            action: 'skipped',
          });
          skipped++;
          continue;
        }

        if (!tier.priceCents || tier.priceCents <= 0) {
          logger.info(`[Tier Sync] Skipping ${tier.name}: No price configured`);
          results.push({
            tierId: tier.id,
            tierName: tier.name,
            tierSlug: tier.slug,
            success: true,
            action: 'skipped',
          });
          skipped++;
          continue;
        }

        const billingInterval = (tier.billingInterval as 'month' | 'year' | 'week' | 'day') || 'month';
        const productName = `${tier.name} Membership`;
        let stripeProductId = tier.stripeProductId;
        let stripePriceId = tier.stripePriceId;

        const privilegeMetadata = buildPrivilegeMetadata(tier);

        const featuresArray = tier.highlightedFeatures as string[] | null;
        const hasMarketingFeatures = Array.isArray(featuresArray) && featuresArray.length > 0;
        const marketingFeatures = hasMarketingFeatures
          ? featuresArray.slice(0, 15).map((f: string) => ({ name: f }))
          : [];

        if (stripeProductId) {
          const updateParams: Stripe.ProductUpdateParams & { marketing_features?: Array<{ name: string }> } = {
            name: productName,
            description: tier.description || undefined,
            metadata: privilegeMetadata,
          };
          if (hasMarketingFeatures) {
            updateParams.marketing_features = marketingFeatures;
          }
          await stripe.products.update(stripeProductId, updateParams);
          logger.info(`[Tier Sync] Updated existing product for ${tier.name} with privileges${hasMarketingFeatures ? ' and features' : ''}`);

          const priceMetadata = { tier_id: tier.id.toString(), tier_slug: tier.slug, product_type: tier.productType || 'subscription' };
          
          if (stripePriceId) {
            try {
              const existingPrice = await stripe.prices.retrieve(stripePriceId);
              if (!existingPrice.active) {
                logger.warn(`[Tier Sync] Price ${stripePriceId} for ${tier.name} is inactive, will create replacement`);
                const priceParams: Stripe.PriceCreateParams = {
                  product: stripeProductId,
                  unit_amount: tier.priceCents,
                  currency: 'usd',
                  metadata: priceMetadata,
                  recurring: { interval: billingInterval },
                };
                const newPrice = await stripe.prices.create(priceParams);
                stripePriceId = newPrice.id;
                logger.info(`[Tier Sync] Created replacement price for ${tier.name} (old was inactive)`);
              } else if (existingPrice.unit_amount !== tier.priceCents) {
                await stripe.prices.update(stripePriceId, { active: false });
                const priceParams: Stripe.PriceCreateParams = {
                  product: stripeProductId,
                  unit_amount: tier.priceCents,
                  currency: 'usd',
                  metadata: priceMetadata,
                  recurring: { interval: billingInterval },
                };
                const newPrice = await stripe.prices.create(priceParams);
                stripePriceId = newPrice.id;
                logger.info(`[Tier Sync] Created new price for ${tier.name} (price changed)`);
              }
            } catch (priceErr: unknown) {
              const errMsg = getErrorMessage(priceErr);
              if (errMsg.includes('No such price') || errMsg.includes('resource_missing')) {
                logger.warn(`[Tier Sync] Price ${stripePriceId} for ${tier.name} not found in Stripe, will create replacement`);
                const priceParams: Stripe.PriceCreateParams = {
                  product: stripeProductId,
                  unit_amount: tier.priceCents,
                  currency: 'usd',
                  metadata: priceMetadata,
                  recurring: { interval: billingInterval },
                };
                const newPrice = await stripe.prices.create(priceParams);
                stripePriceId = newPrice.id;
                logger.info(`[Tier Sync] Created replacement price for ${tier.name} (old was missing)`);
              } else {
                throw priceErr;
              }
            }
          } else {
            const priceParams: Stripe.PriceCreateParams = {
              product: stripeProductId,
              unit_amount: tier.priceCents,
              currency: 'usd',
              metadata: priceMetadata,
              recurring: { interval: billingInterval },
            };
            const newPrice = await stripe.prices.create(priceParams, {
              idempotencyKey: `price_tier_${tier.id}_${tier.priceCents}_new`
            });
            stripePriceId = newPrice.id;
          }

          await db.update(membershipTiers)
            .set({ stripePriceId, updatedAt: new Date() })
            .where(eq(membershipTiers.id, tier.id));

          results.push({
            tierId: tier.id,
            tierName: tier.name,
            tierSlug: tier.slug,
            success: true,
            stripeProductId,
            stripePriceId,
            action: 'updated',
          });
          synced++;
        } else {
          const createParams: Stripe.ProductCreateParams & { marketing_features?: Array<{ name: string }> } = {
            name: productName,
            description: tier.description || undefined,
            metadata: privilegeMetadata,
          };
          if (hasMarketingFeatures) {
            createParams.marketing_features = marketingFeatures;
          }
          const existingStripeProduct = await findExistingStripeProduct(
            stripe,
            productName,
            'tier_id',
            tier.id.toString()
          );
          
          let stripeProduct;
          if (existingStripeProduct) {
            stripeProduct = await stripe.products.update(existingStripeProduct.id, createParams);
            logger.info(`[Tier Sync] Reusing existing Stripe product ${stripeProduct.id} for ${tier.name}`);
          } else {
            stripeProduct = await stripe.products.create(createParams, {
              idempotencyKey: `product_tier_${tier.id}_${tier.slug}`
            });
          }
          stripeProductId = stripeProduct.id;

          const priceMetadata = { tier_id: tier.id.toString(), tier_slug: tier.slug, product_type: tier.productType || 'subscription' };
          const priceParams: Stripe.PriceCreateParams = {
            product: stripeProductId,
            unit_amount: tier.priceCents,
            currency: 'usd',
            metadata: priceMetadata,
            recurring: { interval: billingInterval },
          };
          const stripePrice = await stripe.prices.create(priceParams, {
            idempotencyKey: `price_tier_${tier.id}_${tier.priceCents}_create`
          });
          stripePriceId = stripePrice.id;

          await db.update(membershipTiers)
            .set({
              stripeProductId,
              stripePriceId,
              updatedAt: new Date(),
            })
            .where(eq(membershipTiers.id, tier.id));

          logger.info(`[Tier Sync] Created product and price for ${tier.name} with privileges`);
          results.push({
            tierId: tier.id,
            tierName: tier.name,
            tierSlug: tier.slug,
            success: true,
            stripeProductId,
            stripePriceId,
            action: 'created',
          });
          synced++;
        }
      } catch (error: unknown) {
        logger.error(`[Tier Sync] Error syncing tier ${tier.name}:`, { error: error });
        results.push({
          tierId: tier.id,
          tierName: tier.name,
          tierSlug: tier.slug,
          success: false,
          error: getErrorMessage(error),
          action: 'skipped',
        });
        failed++;
      }
    }

    logger.info(`[Tier Sync] Complete: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    return { success: true, results, synced, failed, skipped };
  } catch (error: unknown) {
    logger.error('[Tier Sync] Fatal error:', { error: error });
    return {
      success: false,
      results,
      synced,
      failed,
      skipped,
    };
  }
}

export async function getTierSyncStatus(): Promise<Array<{
  tierId: number;
  tierName: string;
  tierSlug: string;
  priceCents: number | null;
  hasStripeProduct: boolean;
  hasStripePrice: boolean;
  stripeProductId: string | null;
  stripePriceId: string | null;
}>> {
  try {
    const tiers = await db.select().from(membershipTiers).where(eq(membershipTiers.isActive, true));
    
    return tiers.map(tier => ({
      tierId: tier.id,
      tierName: tier.name,
      tierSlug: tier.slug,
      priceCents: tier.priceCents,
      hasStripeProduct: !!tier.stripeProductId,
      hasStripePrice: !!tier.stripePriceId,
      stripeProductId: tier.stripeProductId,
      stripePriceId: tier.stripePriceId,
    }));
  } catch (error: unknown) {
    logger.error('[Tier Sync] Error getting status:', { error: error });
    return [];
  }
}

export interface OrphanCleanupResult {
  productId: string;
  productName: string;
  action: 'archived' | 'skipped' | 'error';
  reason?: string;
}

export async function cleanupOrphanStripeProducts(): Promise<{
  success: boolean;
  archived: number;
  skipped: number;
  errors: number;
  results: OrphanCleanupResult[];
}> {
  const results: OrphanCleanupResult[] = [];
  let archived = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const stripe = await getStripeClient();
    
    const tiers = await db.select().from(membershipTiers).where(eq(membershipTiers.isActive, true));
    const activeTierIds = new Set(tiers.map(t => t.id.toString()));
    const activeStripeProductIds = new Set(tiers.map(t => t.stripeProductId).filter(Boolean));
    
    const tierProductNames = new Set(tiers.flatMap(t => [
      t.name,
      `${t.name} Membership`,
    ]));
    
    logger.info(`[Stripe Cleanup] Found ${activeTierIds.size} active tiers, ${activeStripeProductIds.size} with Stripe products`);

    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const params: StripePaginationParams = { limit: 100, active: true };
      if (startingAfter) params.starting_after = startingAfter;
      
      const products = await stripe.products.list(params);
      
      for (const product of products.data) {
        if (activeStripeProductIds.has(product.id)) {
          continue;
        }
        
        const isFromApp = product.metadata?.source === 'ever_house_app';
        const matchesTierName = tierProductNames.has(product.name);
        
        if (!isFromApp && !matchesTierName) {
          continue;
        }
        
        if (isFromApp) {
          const tierId = product.metadata?.tier_id;
          
          if (!tierId) {
            logger.info(`[Stripe Cleanup] Skipping ${product.name}: No tier_id metadata`);
            results.push({
              productId: product.id,
              productName: product.name,
              action: 'skipped',
              reason: 'No tier_id metadata - may be manually created',
            });
            skipped++;
            continue;
          }
          
          if (activeTierIds.has(tierId)) {
            continue;
          }
        }
        
        try {
          await stripe.products.update(product.id, { active: false });
          
          const reason = matchesTierName && !isFromApp
            ? `Duplicate product not linked to app (name matches tier)`
            : `Tier ID ${product.metadata?.tier_id} no longer active in app`;
          
          logger.info(`[Stripe Cleanup] Archived orphan product: ${product.name} (${product.id})`);
          results.push({
            productId: product.id,
            productName: product.name,
            action: 'archived',
            reason,
          });
          archived++;
        } catch (archiveError: unknown) {
          logger.error(`[Stripe Cleanup] Error archiving ${product.name}:`, { error: archiveError });
          results.push({
            productId: product.id,
            productName: product.name,
            action: 'error',
            reason: getErrorMessage(archiveError),
          });
          errors++;
        }
      }
      
      hasMore = products.has_more;
      if (products.data.length > 0) {
        startingAfter = products.data[products.data.length - 1].id;
      }
    }
    
    logger.info(`[Stripe Cleanup] Complete: ${archived} archived, ${skipped} skipped, ${errors} errors`);
    return { success: true, archived, skipped, errors, results };
  } catch (error: unknown) {
    logger.error('[Stripe Cleanup] Fatal error:', { error: error });
    return { success: false, archived, skipped, errors, results };
  }
}
