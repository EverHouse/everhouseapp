import { pool } from '../db';
import { db } from '../../db';
import { stripeProducts, membershipTiers } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from './client';
import { getHubSpotClientWithFallback } from '../integrations';

export interface HubSpotProduct {
  id: string;
  name: string;
  price: number;
  sku: string | null;
  description: string | null;
  recurringPeriod: string | null;
}

export interface StripeProductWithPrice {
  id: number;
  hubspotProductId: string;
  stripeProductId: string;
  stripePriceId: string;
  name: string;
  priceCents: number;
  billingInterval: string;
  billingIntervalCount: number;
  isActive: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ProductSyncStatus {
  hubspotProductId: string;
  name: string;
  price: number;
  isSynced: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
}

function parseRecurringPeriod(period: string | null): { interval: 'month' | 'year' | 'week' | 'day'; intervalCount: number } {
  if (!period) {
    return { interval: 'month', intervalCount: 1 };
  }
  
  const cleanPeriod = period.trim().toUpperCase();
  const match = cleanPeriod.match(/^P(\d+)([YMWD])$/);
  if (!match) {
    return { interval: 'month', intervalCount: 1 };
  }
  
  const count = parseInt(match[1], 10);
  const unit = match[2];
  
  switch (unit) {
    case 'Y':
      return { interval: 'year', intervalCount: count };
    case 'M':
      return { interval: 'month', intervalCount: count };
    case 'W':
      return { interval: 'week', intervalCount: count };
    case 'D':
      return { interval: 'day', intervalCount: count };
    default:
      return { interval: 'month', intervalCount: 1 };
  }
}

export async function fetchHubSpotProducts(): Promise<HubSpotProduct[]> {
  try {
    const { client: hubspot, source } = await getHubSpotClientWithFallback();
    console.log(`[Stripe Products] Using HubSpot ${source} for products API`);
    
    const properties = ['name', 'price', 'hs_sku', 'description', 'hs_recurring_billing_period'];
    let allProducts: any[] = [];
    let after: string | undefined = undefined;
    
    do {
      const response = await hubspot.crm.products.basicApi.getPage(100, after, properties);
      allProducts = allProducts.concat(response.results);
      after = response.paging?.next?.after;
    } while (after);
    
    return allProducts.map((product: any) => ({
      id: product.id,
      name: product.properties.name || '',
      price: parseFloat(product.properties.price) || 0,
      sku: product.properties.hs_sku || null,
      description: product.properties.description || null,
      recurringPeriod: product.properties.hs_recurring_billing_period || null,
    }));
  } catch (error: any) {
    if (error.code === 403 && error.body?.category === 'MISSING_SCOPES') {
      console.error('[Stripe Products] Missing HubSpot scopes. Add HUBSPOT_PRIVATE_APP_TOKEN secret with a Private App that has crm.objects.products.read scope.');
      throw new Error('HubSpot products access denied. Please add HUBSPOT_PRIVATE_APP_TOKEN secret with your Private App token that has products read permission.');
    }
    console.error('[Stripe Products] Error fetching HubSpot products:', error);
    throw error;
  }
}

export async function syncHubSpotProductToStripe(hubspotProduct: HubSpotProduct): Promise<{
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    
    const existingSync = await db.select()
      .from(stripeProducts)
      .where(eq(stripeProducts.hubspotProductId, hubspotProduct.id))
      .limit(1);
    
    if (existingSync.length > 0) {
      const existing = existingSync[0];
      
      await stripe.products.update(existing.stripeProductId, {
        name: hubspotProduct.name,
        description: hubspotProduct.description || undefined,
        metadata: {
          hubspot_product_id: hubspotProduct.id,
          hubspot_sku: hubspotProduct.sku || '',
        },
      });
      
      const priceCents = Math.round(hubspotProduct.price * 100);
      const { interval, intervalCount } = parseRecurringPeriod(hubspotProduct.recurringPeriod);
      
      const currentPrice = await stripe.prices.retrieve(existing.stripePriceId);
      const priceChanged = currentPrice.unit_amount !== priceCents;
      const intervalChanged = currentPrice.recurring?.interval !== interval || 
                              currentPrice.recurring?.interval_count !== intervalCount;
      
      let newPriceId = existing.stripePriceId;
      
      if (priceChanged || intervalChanged) {
        await stripe.prices.update(existing.stripePriceId, { active: false });
        
        const newPrice = await stripe.prices.create({
          product: existing.stripeProductId,
          unit_amount: priceCents,
          currency: 'usd',
          recurring: {
            interval,
            interval_count: intervalCount,
          },
          metadata: {
            hubspot_product_id: hubspotProduct.id,
          },
        });
        newPriceId = newPrice.id;
      }
      
      await db.update(stripeProducts)
        .set({
          name: hubspotProduct.name,
          priceCents,
          billingInterval: interval,
          billingIntervalCount: intervalCount,
          stripePriceId: newPriceId,
          updatedAt: new Date(),
        })
        .where(eq(stripeProducts.hubspotProductId, hubspotProduct.id));
      
      console.log(`[Stripe Products] Updated product ${hubspotProduct.name} (${hubspotProduct.id})`);
      
      return {
        success: true,
        stripeProductId: existing.stripeProductId,
        stripePriceId: newPriceId,
      };
    }
    
    const stripeProduct = await stripe.products.create({
      name: hubspotProduct.name,
      description: hubspotProduct.description || undefined,
      metadata: {
        hubspot_product_id: hubspotProduct.id,
        hubspot_sku: hubspotProduct.sku || '',
      },
    });
    
    const priceCents = Math.round(hubspotProduct.price * 100);
    const { interval, intervalCount } = parseRecurringPeriod(hubspotProduct.recurringPeriod);
    
    const stripePrice = await stripe.prices.create({
      product: stripeProduct.id,
      unit_amount: priceCents,
      currency: 'usd',
      recurring: {
        interval,
        interval_count: intervalCount,
      },
      metadata: {
        hubspot_product_id: hubspotProduct.id,
      },
    });
    
    await db.insert(stripeProducts).values({
      hubspotProductId: hubspotProduct.id,
      stripeProductId: stripeProduct.id,
      stripePriceId: stripePrice.id,
      name: hubspotProduct.name,
      priceCents,
      billingInterval: interval,
      billingIntervalCount: intervalCount,
      isActive: true,
    });
    
    console.log(`[Stripe Products] Created product ${hubspotProduct.name} (${hubspotProduct.id}) -> ${stripeProduct.id}`);
    
    return {
      success: true,
      stripeProductId: stripeProduct.id,
      stripePriceId: stripePrice.id,
    };
  } catch (error: any) {
    console.error('[Stripe Products] Error syncing product:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function syncAllHubSpotProductsToStripe(): Promise<{
  success: boolean;
  synced: number;
  failed: number;
  errors: Array<{ productId: string; error: string }>;
}> {
  try {
    const hubspotProducts = await fetchHubSpotProducts();
    
    let synced = 0;
    let failed = 0;
    const errors: Array<{ productId: string; error: string }> = [];
    
    for (const product of hubspotProducts) {
      const result = await syncHubSpotProductToStripe(product);
      if (result.success) {
        synced++;
      } else {
        failed++;
        errors.push({ productId: product.id, error: result.error || 'Unknown error' });
      }
    }
    
    console.log(`[Stripe Products] Sync complete: ${synced} synced, ${failed} failed`);
    
    return { success: true, synced, failed, errors };
  } catch (error: any) {
    console.error('[Stripe Products] Error syncing all products:', error);
    return {
      success: false,
      synced: 0,
      failed: 0,
      errors: [{ productId: 'all', error: error.message }],
    };
  }
}

export async function getStripeProducts(): Promise<StripeProductWithPrice[]> {
  try {
    const products = await db.select().from(stripeProducts);
    return products;
  } catch (error: any) {
    console.error('[Stripe Products] Error getting products:', error);
    return [];
  }
}

export async function getProductSyncStatus(): Promise<ProductSyncStatus[]> {
  try {
    const hubspotProducts = await fetchHubSpotProducts();
    const syncedProducts = await db.select().from(stripeProducts);
    
    const syncedMap = new Map(syncedProducts.map(p => [p.hubspotProductId, p]));
    
    return hubspotProducts.map(product => {
      const synced = syncedMap.get(product.id);
      return {
        hubspotProductId: product.id,
        name: product.name,
        price: product.price,
        isSynced: !!synced,
        stripeProductId: synced?.stripeProductId,
        stripePriceId: synced?.stripePriceId,
      };
    });
  } catch (error: any) {
    console.error('[Stripe Products] Error getting sync status:', error);
    return [];
  }
}

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

// Helper to build privilege metadata for Stripe products
function buildPrivilegeMetadata(tier: any): Record<string, string> {
  const metadata: Record<string, string> = {
    tier_id: tier.id.toString(),
    tier_slug: tier.slug,
    product_type: tier.productType || 'subscription',
    source: 'ever_house_app',
  };
  
  // Add privilege/limit metadata (prefixed for clarity)
  if (tier.dailySimMinutes != null) {
    metadata.privilege_daily_sim_minutes = tier.dailySimMinutes.toString();
  }
  if (tier.guestPassesPerMonth != null) {
    metadata.privilege_guest_passes = tier.guestPassesPerMonth.toString();
  }
  if (tier.bookingWindowDays != null) {
    metadata.privilege_booking_window_days = tier.bookingWindowDays.toString();
  }
  if (tier.dailyConfRoomMinutes != null) {
    metadata.privilege_conf_room_minutes = tier.dailyConfRoomMinutes.toString();
  }
  if (tier.unlimitedAccess) {
    metadata.privilege_unlimited_access = 'true';
  }
  if (tier.canBookSimulators) {
    metadata.privilege_can_book_simulators = 'true';
  }
  if (tier.canBookConference) {
    metadata.privilege_can_book_conference = 'true';
  }
  if (tier.canBookWellness) {
    metadata.privilege_can_book_wellness = 'true';
  }
  if (tier.hasGroupLessons) {
    metadata.privilege_group_lessons = 'true';
  }
  if (tier.hasPrivateLesson) {
    metadata.privilege_private_lesson = 'true';
  }
  if (tier.hasSimulatorGuestPasses) {
    metadata.privilege_sim_guest_passes = 'true';
  }
  if (tier.hasDiscountedMerch) {
    metadata.privilege_discounted_merch = 'true';
  }
  
  // Include highlighted features as JSON (truncated to fit Stripe's 500 char limit per value)
  if (tier.highlightedFeatures && Array.isArray(tier.highlightedFeatures) && tier.highlightedFeatures.length > 0) {
    const featuresJson = JSON.stringify(tier.highlightedFeatures.slice(0, 5));
    if (featuresJson.length <= 500) {
      metadata.highlighted_features = featuresJson;
    }
  }
  
  return metadata;
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

    console.log(`[Tier Sync] Starting sync for ${tiers.length} active tiers`);

    for (const tier of tiers) {
      try {
        if (!tier.priceCents || tier.priceCents <= 0) {
          console.log(`[Tier Sync] Skipping ${tier.name}: No price configured`);
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
        const isOneTime = tier.productType === 'one_time';
        const productName = isOneTime ? tier.name : `${tier.name} Membership`;
        let stripeProductId = tier.stripeProductId;
        let stripePriceId = tier.stripePriceId;

        // Build privilege metadata for this tier
        const privilegeMetadata = buildPrivilegeMetadata(tier);

        // Build marketing features for Stripe Pricing Tables
        const featuresArray = tier.highlightedFeatures as string[] | null;
        const hasMarketingFeatures = Array.isArray(featuresArray) && featuresArray.length > 0;
        const marketingFeatures = hasMarketingFeatures
          ? featuresArray.slice(0, 15).map((f: string) => ({ name: f }))
          : [];

        if (stripeProductId) {
          const updateParams: any = {
            name: productName,
            description: tier.description || undefined,
            metadata: privilegeMetadata,
          };
          if (hasMarketingFeatures) {
            updateParams.marketing_features = marketingFeatures;
          }
          await stripe.products.update(stripeProductId, updateParams);
          console.log(`[Tier Sync] Updated existing product for ${tier.name} with privileges${hasMarketingFeatures ? ' and features' : ''}`);

          // Price metadata (subset of privilege metadata for reference)
          const priceMetadata = { tier_id: tier.id.toString(), tier_slug: tier.slug, product_type: tier.productType || 'subscription' };
          
          if (stripePriceId) {
            const existingPrice = await stripe.prices.retrieve(stripePriceId);
            if (existingPrice.unit_amount !== tier.priceCents) {
              await stripe.prices.update(stripePriceId, { active: false });
              const priceParams: any = {
                product: stripeProductId,
                unit_amount: tier.priceCents,
                currency: 'usd',
                metadata: priceMetadata,
              };
              if (!isOneTime) {
                priceParams.recurring = { interval: billingInterval };
              }
              const newPrice = await stripe.prices.create(priceParams);
              stripePriceId = newPrice.id;
              console.log(`[Tier Sync] Created new price for ${tier.name} (price changed)`);
            }
          } else {
            const priceParams: any = {
              product: stripeProductId,
              unit_amount: tier.priceCents,
              currency: 'usd',
              metadata: priceMetadata,
            };
            if (!isOneTime) {
              priceParams.recurring = { interval: billingInterval };
            }
            const newPrice = await stripe.prices.create(priceParams);
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
          // Create new product with privilege metadata and marketing features
          const createParams: any = {
            name: productName,
            description: tier.description || undefined,
            metadata: privilegeMetadata,
          };
          if (hasMarketingFeatures) {
            createParams.marketing_features = marketingFeatures;
          }
          const stripeProduct = await stripe.products.create(createParams);
          stripeProductId = stripeProduct.id;

          const priceMetadata = { tier_id: tier.id.toString(), tier_slug: tier.slug, product_type: tier.productType || 'subscription' };
          const priceParams: any = {
            product: stripeProductId,
            unit_amount: tier.priceCents,
            currency: 'usd',
            metadata: priceMetadata,
          };
          if (!isOneTime) {
            priceParams.recurring = { interval: billingInterval };
          }
          const stripePrice = await stripe.prices.create(priceParams);
          stripePriceId = stripePrice.id;

          await db.update(membershipTiers)
            .set({
              stripeProductId,
              stripePriceId,
              updatedAt: new Date(),
            })
            .where(eq(membershipTiers.id, tier.id));

          console.log(`[Tier Sync] Created product and price for ${tier.name} with privileges`);
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
      } catch (error: any) {
        console.error(`[Tier Sync] Error syncing tier ${tier.name}:`, error);
        results.push({
          tierId: tier.id,
          tierName: tier.name,
          tierSlug: tier.slug,
          success: false,
          error: error.message,
          action: 'skipped',
        });
        failed++;
      }
    }

    console.log(`[Tier Sync] Complete: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    return { success: true, results, synced, failed, skipped };
  } catch (error: any) {
    console.error('[Tier Sync] Fatal error:', error);
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
  } catch (error: any) {
    console.error('[Tier Sync] Error getting status:', error);
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
    
    console.log(`[Stripe Cleanup] Found ${activeTierIds.size} active tiers, ${activeStripeProductIds.size} with Stripe products`);

    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const params: any = { limit: 100, active: true };
      if (startingAfter) params.starting_after = startingAfter;
      
      const products = await stripe.products.list(params);
      
      for (const product of products.data) {
        if (product.metadata?.source !== 'ever_house_app') {
          continue;
        }
        
        const tierId = product.metadata?.tier_id;
        
        if (!tierId) {
          console.log(`[Stripe Cleanup] Skipping ${product.name}: No tier_id metadata`);
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
        
        try {
          await stripe.products.update(product.id, { active: false });
          
          console.log(`[Stripe Cleanup] Archived orphan product: ${product.name} (tier_id: ${tierId})`);
          results.push({
            productId: product.id,
            productName: product.name,
            action: 'archived',
            reason: `Tier ID ${tierId} no longer active in app`,
          });
          archived++;
        } catch (archiveError: any) {
          console.error(`[Stripe Cleanup] Error archiving ${product.name}:`, archiveError);
          results.push({
            productId: product.id,
            productName: product.name,
            action: 'error',
            reason: archiveError.message,
          });
          errors++;
        }
      }
      
      hasMore = products.has_more;
      if (products.data.length > 0) {
        startingAfter = products.data[products.data.length - 1].id;
      }
    }
    
    console.log(`[Stripe Cleanup] Complete: ${archived} archived, ${skipped} skipped, ${errors} errors`);
    return { success: true, archived, skipped, errors, results };
  } catch (error: any) {
    console.error('[Stripe Cleanup] Fatal error:', error);
    return { success: false, archived, skipped, errors, results };
  }
}
