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

function parseRecurringPeriod(period: string | null): { interval: 'month' | 'year' | 'week' | 'day'; intervalCount: number } | null {
  if (!period) {
    return null;
  }
  
  const cleanPeriod = period.trim().toUpperCase();
  const match = cleanPeriod.match(/^P(\d+)([YMWD])$/);
  if (!match) {
    return null;
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

/**
 * Search Stripe for existing products by name or metadata to prevent duplicates.
 * Returns the existing product if found, null otherwise.
 */
async function findExistingStripeProduct(
  stripe: any,
  productName: string,
  metadataKey?: string,
  metadataValue?: string
): Promise<{ id: string; default_price?: string | null } | null> {
  try {
    // First try to find by metadata if provided
    if (metadataKey && metadataValue) {
      const productsByMetadata = await stripe.products.search({
        query: `metadata['${metadataKey}']:'${metadataValue}'`,
        limit: 1,
      });
      if (productsByMetadata.data.length > 0) {
        console.log(`[Stripe Products] Found existing product by metadata: ${productsByMetadata.data[0].id}`);
        return productsByMetadata.data[0];
      }
    }
    
    // Fall back to searching by exact name
    const productsByName = await stripe.products.search({
      query: `name:'${productName.replace(/'/g, "\\'")}'`,
      limit: 1,
    });
    if (productsByName.data.length > 0) {
      console.log(`[Stripe Products] Found existing product by name "${productName}": ${productsByName.data[0].id}`);
      return productsByName.data[0];
    }
    
    return null;
  } catch (error) {
    console.error('[Stripe Products] Error searching for existing product:', error);
    return null;
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
      const isOneTimeName = /pass|pack|fee|merch/i.test(hubspotProduct.name);
      let recurringConfig = parseRecurringPeriod(hubspotProduct.recurringPeriod);
      if (isOneTimeName) recurringConfig = null;
      
      const currentPrice = await stripe.prices.retrieve(existing.stripePriceId);
      const priceChanged = currentPrice.unit_amount !== priceCents;
      const intervalChanged = recurringConfig 
        ? (currentPrice.recurring?.interval !== recurringConfig.interval || 
           currentPrice.recurring?.interval_count !== recurringConfig.intervalCount)
        : !!currentPrice.recurring;
      
      let newPriceId = existing.stripePriceId;
      
      if (priceChanged || intervalChanged) {
        await stripe.prices.update(existing.stripePriceId, { active: false });
        
        const pricePayload: any = {
          product: existing.stripeProductId,
          unit_amount: priceCents,
          currency: 'usd',
          metadata: {
            hubspot_product_id: hubspotProduct.id,
          },
        };
        if (recurringConfig) {
          pricePayload.recurring = {
            interval: recurringConfig.interval,
            interval_count: recurringConfig.intervalCount,
          };
        }
        const newPrice = await stripe.prices.create(pricePayload);
        newPriceId = newPrice.id;
      }
      
      await db.update(stripeProducts)
        .set({
          name: hubspotProduct.name,
          priceCents,
          billingInterval: recurringConfig?.interval || null,
          billingIntervalCount: recurringConfig?.intervalCount || null,
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
    
    // Check if product already exists in Stripe before creating
    const existingStripeProduct = await findExistingStripeProduct(
      stripe,
      hubspotProduct.name,
      'hubspot_product_id',
      hubspotProduct.id
    );
    
    let stripeProduct;
    if (existingStripeProduct) {
      // Use existing product, just update it
      stripeProduct = await stripe.products.update(existingStripeProduct.id, {
        name: hubspotProduct.name,
        description: hubspotProduct.description || undefined,
        metadata: {
          hubspot_product_id: hubspotProduct.id,
          hubspot_sku: hubspotProduct.sku || '',
        },
      });
      console.log(`[Stripe Products] Reusing existing Stripe product ${stripeProduct.id} for ${hubspotProduct.name}`);
    } else {
      stripeProduct = await stripe.products.create({
        name: hubspotProduct.name,
        description: hubspotProduct.description || undefined,
        metadata: {
          hubspot_product_id: hubspotProduct.id,
          hubspot_sku: hubspotProduct.sku || '',
        },
      });
    }
    
    const priceCents = Math.round(hubspotProduct.price * 100);
    const isOneTimeNameCreate = /pass|pack|fee|merch/i.test(hubspotProduct.name);
    let recurringConfigCreate = parseRecurringPeriod(hubspotProduct.recurringPeriod);
    if (isOneTimeNameCreate) recurringConfigCreate = null;
    
    const pricePayloadCreate: any = {
      product: stripeProduct.id,
      unit_amount: priceCents,
      currency: 'usd',
      metadata: {
        hubspot_product_id: hubspotProduct.id,
      },
    };
    if (recurringConfigCreate) {
      pricePayloadCreate.recurring = {
        interval: recurringConfigCreate.interval,
        interval_count: recurringConfigCreate.intervalCount,
      };
    }
    const stripePrice = await stripe.prices.create(pricePayloadCreate);
    
    await db.insert(stripeProducts).values({
      hubspotProductId: hubspotProduct.id,
      stripeProductId: stripeProduct.id,
      stripePriceId: stripePrice.id,
      name: hubspotProduct.name,
      priceCents,
      billingInterval: recurringConfigCreate?.interval || null,
      billingIntervalCount: recurringConfigCreate?.intervalCount || null,
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
          // Check if product already exists in Stripe before creating
          const existingStripeProduct = await findExistingStripeProduct(
            stripe,
            productName,
            'tier_id',
            tier.id.toString()
          );
          
          let stripeProduct;
          if (existingStripeProduct) {
            // Use existing product, just update it
            stripeProduct = await stripe.products.update(existingStripeProduct.id, createParams);
            console.log(`[Tier Sync] Reusing existing Stripe product ${stripeProduct.id} for ${tier.name}`);
          } else {
            stripeProduct = await stripe.products.create(createParams);
          }
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
    
    const tierProductNames = new Set(tiers.flatMap(t => [
      t.name,
      `${t.name} Membership`,
    ]));
    
    console.log(`[Stripe Cleanup] Found ${activeTierIds.size} active tiers, ${activeStripeProductIds.size} with Stripe products`);

    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const params: any = { limit: 100, active: true };
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
        }
        
        try {
          await stripe.products.update(product.id, { active: false });
          
          const reason = matchesTierName && !isFromApp
            ? `Duplicate product not linked to app (name matches tier)`
            : `Tier ID ${product.metadata?.tier_id} no longer active in app`;
          
          console.log(`[Stripe Cleanup] Archived orphan product: ${product.name} (${product.id})`);
          results.push({
            productId: product.id,
            productName: product.name,
            action: 'archived',
            reason,
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

/**
 * Ensure the Simulator Overage product exists in both database and Stripe.
 * Called on server startup to guarantee the fee product is available.
 */
export async function ensureSimulatorOverageProduct(): Promise<{
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  action: 'created' | 'exists' | 'error';
}> {
  const OVERAGE_SLUG = 'simulator-overage-30min';
  const OVERAGE_NAME = 'Simulator Overage (30 min)';
  const OVERAGE_PRICE_CENTS = 2500;
  const OVERAGE_DESCRIPTION = 'Per 30 minutes over tier privileges';

  try {
    const stripe = await getStripeClient();
    
    // Check if product exists in database
    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, OVERAGE_SLUG))
      .limit(1);
    
    let tierId: number;
    let stripeProductId = existing[0]?.stripeProductId;
    let stripePriceId = existing[0]?.stripePriceId;
    
    if (existing.length === 0) {
      // Create in database
      const [newTier] = await db.insert(membershipTiers).values({
        name: OVERAGE_NAME,
        slug: OVERAGE_SLUG,
        priceString: '$25',
        description: OVERAGE_DESCRIPTION,
        buttonText: 'Pay Now',
        sortOrder: 99,
        isActive: true,
        isPopular: false,
        showInComparison: false,
        highlightedFeatures: [],
        allFeatures: {},
        dailySimMinutes: 0,
        guestPassesPerMonth: 0,
        bookingWindowDays: 0,
        dailyConfRoomMinutes: 0,
        canBookSimulators: false,
        canBookConference: false,
        canBookWellness: false,
        hasGroupLessons: false,
        hasExtendedSessions: false,
        hasPrivateLesson: false,
        hasSimulatorGuestPasses: false,
        hasDiscountedMerch: false,
        unlimitedAccess: false,
        productType: 'one_time',
        priceCents: OVERAGE_PRICE_CENTS,
      }).returning();
      tierId = newTier.id;
      console.log(`[Overage Product] Created database record: ${OVERAGE_NAME}`);
    } else {
      tierId = existing[0].id;
    }
    
    // Create or verify Stripe product
    if (!stripeProductId) {
      const product = await stripe.products.create({
        name: OVERAGE_NAME,
        description: OVERAGE_DESCRIPTION,
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: OVERAGE_SLUG,
          product_type: 'one_time',
          fee_type: 'simulator_overage',
        },
      });
      stripeProductId = product.id;
      console.log(`[Overage Product] Created Stripe product: ${stripeProductId}`);
    }
    
    // Create or verify Stripe price
    if (!stripePriceId) {
      const price = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: OVERAGE_PRICE_CENTS,
        currency: 'usd',
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: OVERAGE_SLUG,
          product_type: 'one_time',
        },
      });
      stripePriceId = price.id;
      console.log(`[Overage Product] Created Stripe price: ${stripePriceId}`);
    }
    
    // Update database with Stripe IDs
    await db.update(membershipTiers)
      .set({
        stripeProductId,
        stripePriceId,
      })
      .where(eq(membershipTiers.id, tierId));
    
    console.log(`[Overage Product] ${OVERAGE_NAME} ready (${stripePriceId})`);
    return { success: true, stripeProductId, stripePriceId, action: existing.length > 0 && existing[0].stripePriceId ? 'exists' : 'created' };
  } catch (error: any) {
    console.error('[Overage Product] Error:', error.message);
    return { success: false, action: 'error' };
  }
}

function buildFeatureKeysForTier(tier: any): Array<{ lookupKey: string; name: string; metadata?: Record<string, string> }> {
  const features: Array<{ lookupKey: string; name: string; metadata?: Record<string, string> }> = [];

  const booleanMap: Array<{ field: string; key: string; name: string }> = [
    { field: 'canBookSimulators', key: 'can_book_simulators', name: 'Can Book Simulators' },
    { field: 'canBookConference', key: 'can_book_conference', name: 'Can Book Conference' },
    { field: 'canBookWellness', key: 'can_book_wellness', name: 'Can Book Wellness' },
    { field: 'hasGroupLessons', key: 'has_group_lessons', name: 'Has Group Lessons' },
    { field: 'hasExtendedSessions', key: 'has_extended_sessions', name: 'Has Extended Sessions' },
    { field: 'hasPrivateLesson', key: 'has_private_lesson', name: 'Has Private Lesson' },
    { field: 'hasSimulatorGuestPasses', key: 'has_simulator_guest_passes', name: 'Has Simulator Guest Passes' },
    { field: 'hasDiscountedMerch', key: 'has_discounted_merch', name: 'Has Discounted Merch' },
    { field: 'unlimitedAccess', key: 'unlimited_access', name: 'Unlimited Access' },
  ];

  for (const { field, key, name } of booleanMap) {
    if (tier[field]) {
      features.push({ lookupKey: key, name });
    }
  }

  const simMinutes = tier.dailySimMinutes ?? 0;
  if (simMinutes > 0) {
    if (simMinutes >= 900) {
      features.push({ lookupKey: 'daily_sim_minutes_unlimited', name: 'Daily Sim Minutes: Unlimited', metadata: { type: 'daily_sim_minutes', value: 'unlimited', unit: 'minutes' } });
    } else if (simMinutes === 60) {
      features.push({ lookupKey: 'daily_sim_minutes_60', name: 'Daily Sim Minutes: 60' });
    } else if (simMinutes === 90) {
      features.push({ lookupKey: 'daily_sim_minutes_90', name: 'Daily Sim Minutes: 90' });
    } else {
      features.push({ lookupKey: `daily_sim_minutes_${simMinutes}`, name: `Daily Sim Minutes: ${simMinutes}`, metadata: { type: 'daily_sim_minutes', value: simMinutes.toString(), unit: 'minutes' } });
    }
  }

  const guestPasses = tier.guestPassesPerMonth ?? 0;
  if (guestPasses > 0) {
    if (guestPasses >= 900) {
      features.push({ lookupKey: 'guest_passes_unlimited', name: 'Guest Passes: Unlimited/month', metadata: { type: 'guest_passes_per_month', value: 'unlimited', unit: 'passes' } });
    } else if (guestPasses === 4) {
      features.push({ lookupKey: 'guest_passes_4', name: 'Guest Passes: 4/month' });
    } else if (guestPasses === 8) {
      features.push({ lookupKey: 'guest_passes_8', name: 'Guest Passes: 8/month' });
    } else if (guestPasses === 15) {
      features.push({ lookupKey: 'guest_passes_15', name: 'Guest Passes: 15/month' });
    } else {
      features.push({ lookupKey: `guest_passes_${guestPasses}`, name: `Guest Passes: ${guestPasses}/month`, metadata: { type: 'guest_passes_per_month', value: guestPasses.toString(), unit: 'passes' } });
    }
  }

  const bookingWindow = tier.bookingWindowDays ?? 7;
  if (bookingWindow === 7) {
    features.push({ lookupKey: 'booking_window_7', name: 'Booking Window: 7 days' });
  } else if (bookingWindow === 10) {
    features.push({ lookupKey: 'booking_window_10', name: 'Booking Window: 10 days' });
  } else if (bookingWindow === 14) {
    features.push({ lookupKey: 'booking_window_14', name: 'Booking Window: 14 days' });
  } else {
    features.push({ lookupKey: `booking_window_${bookingWindow}`, name: `Booking Window: ${bookingWindow} days`, metadata: { type: 'booking_window', value: bookingWindow.toString(), unit: 'days' } });
  }

  const confMinutes = tier.dailyConfRoomMinutes ?? 0;
  if (confMinutes > 0) {
    if (confMinutes >= 900) {
      features.push({ lookupKey: 'conf_room_minutes_unlimited', name: 'Conference Room: Unlimited/day', metadata: { type: 'daily_conf_room_minutes', value: 'unlimited', unit: 'minutes' } });
    } else if (confMinutes === 60) {
      features.push({ lookupKey: 'conf_room_minutes_60', name: 'Conference Room: 60 min/day' });
    } else if (confMinutes === 90) {
      features.push({ lookupKey: 'conf_room_minutes_90', name: 'Conference Room: 90 min/day' });
    } else {
      features.push({ lookupKey: `conf_room_minutes_${confMinutes}`, name: `Conference Room: ${confMinutes} min/day`, metadata: { type: 'daily_conf_room_minutes', value: confMinutes.toString(), unit: 'minutes' } });
    }
  }

  return features;
}

export async function syncTierFeaturesToStripe(): Promise<{
  success: boolean;
  featuresCreated: number;
  featuresAttached: number;
  featuresRemoved: number;
}> {
  let featuresCreated = 0;
  let featuresAttached = 0;
  let featuresRemoved = 0;

  try {
    const stripe = await getStripeClient();
    const tiers = await db.select().from(membershipTiers).where(eq(membershipTiers.isActive, true));

    console.log(`[Feature Sync] Starting feature sync for ${tiers.length} active tiers`);

    const existingFeatures = new Map<string, string>();
    let hasMoreFeatures = true;
    let startingAfterFeature: string | undefined;

    while (hasMoreFeatures) {
      const params: any = { limit: 100 };
      if (startingAfterFeature) params.starting_after = startingAfterFeature;
      const featureList = await stripe.entitlements.features.list(params);
      for (const f of featureList.data) {
        existingFeatures.set(f.lookup_key, f.id);
      }
      hasMoreFeatures = featureList.has_more;
      if (featureList.data.length > 0) {
        startingAfterFeature = featureList.data[featureList.data.length - 1].id;
      }
    }

    console.log(`[Feature Sync] Found ${existingFeatures.size} existing Stripe features`);

    for (const tier of tiers) {
      if (!tier.stripeProductId) {
        console.log(`[Feature Sync] Skipping ${tier.name}: No Stripe product ID`);
        continue;
      }

      const desiredFeatures = buildFeatureKeysForTier(tier);
      const desiredKeys = new Set(desiredFeatures.map(f => f.lookupKey));

      for (const feature of desiredFeatures) {
        if (!existingFeatures.has(feature.lookupKey)) {
          try {
            const created = await stripe.entitlements.features.create({
              lookup_key: feature.lookupKey,
              name: feature.name,
              metadata: feature.metadata || {},
            });
            existingFeatures.set(feature.lookupKey, created.id);
            featuresCreated++;
            console.log(`[Feature Sync] Created feature: ${feature.name} (${feature.lookupKey})`);
          } catch (err: any) {
            if (err.code === 'resource_already_exists') {
              const refetch = await stripe.entitlements.features.list({ lookup_key: feature.lookupKey, limit: 1 });
              if (refetch.data.length > 0) {
                existingFeatures.set(feature.lookupKey, refetch.data[0].id);
              }
            } else {
              console.error(`[Feature Sync] Error creating feature ${feature.lookupKey}:`, err.message);
            }
          }
        }
      }

      const attachedFeatures = new Map<string, string>();
      let hasMoreAttached = true;
      let startingAfterAttached: string | undefined;

      while (hasMoreAttached) {
        const params: any = { limit: 100 };
        if (startingAfterAttached) params.starting_after = startingAfterAttached;
        const attached = await stripe.products.listFeatures(tier.stripeProductId, params);
        for (const af of attached.data) {
          if (af.entitlement_feature?.lookup_key) {
            attachedFeatures.set(af.entitlement_feature.lookup_key, af.id);
          }
        }
        hasMoreAttached = attached.has_more;
        if (attached.data.length > 0) {
          startingAfterAttached = attached.data[attached.data.length - 1].id;
        }
      }

      for (const feature of desiredFeatures) {
        if (!attachedFeatures.has(feature.lookupKey)) {
          const featureId = existingFeatures.get(feature.lookupKey);
          if (featureId) {
            try {
              await stripe.products.createFeature(tier.stripeProductId, {
                entitlement_feature: featureId,
              });
              featuresAttached++;
              console.log(`[Feature Sync] Attached ${feature.lookupKey} to ${tier.name}`);
            } catch (err: any) {
              console.error(`[Feature Sync] Error attaching ${feature.lookupKey} to ${tier.name}:`, err.message);
            }
          }
        }
      }

      for (const [attachedKey, attachmentId] of attachedFeatures) {
        if (!desiredKeys.has(attachedKey)) {
          try {
            await stripe.products.deleteFeature(tier.stripeProductId, attachmentId);
            featuresRemoved++;
            console.log(`[Feature Sync] Removed ${attachedKey} from ${tier.name}`);
          } catch (err: any) {
            console.error(`[Feature Sync] Error removing ${attachedKey} from ${tier.name}:`, err.message);
          }
        }
      }
    }

    console.log(`[Feature Sync] Complete: ${featuresCreated} created, ${featuresAttached} attached, ${featuresRemoved} removed`);
    return { success: true, featuresCreated, featuresAttached, featuresRemoved };
  } catch (error: any) {
    console.error('[Feature Sync] Fatal error:', error);
    return { success: false, featuresCreated, featuresAttached, featuresRemoved };
  }
}

export async function syncCafeItemsToStripe(): Promise<{
  success: boolean;
  synced: number;
  failed: number;
  skipped: number;
}> {
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const stripe = await getStripeClient();
    const { rows: cafeItemRows } = await pool.query('SELECT * FROM cafe_items WHERE is_active = true ORDER BY category, sort_order');

    console.log(`[Cafe Sync] Starting sync for ${cafeItemRows.length} active cafe items`);

    for (const item of cafeItemRows) {
      try {
        const priceCents = Math.round(parseFloat(item.price) * 100);
        if (priceCents <= 0) {
          console.log(`[Cafe Sync] Skipping ${item.name}: No price`);
          skipped++;
          continue;
        }

        const metadata = {
          source: 'ever_house_app',
          cafe_item_id: item.id.toString(),
          category: item.category,
          product_type: 'one_time',
        };

        let stripeProductId = item.stripe_product_id;
        let stripePriceId = item.stripe_price_id;

        if (stripeProductId) {
          await stripe.products.update(stripeProductId, {
            name: item.name,
            description: item.description || undefined,
            metadata,
          });
          console.log(`[Cafe Sync] Updated product for ${item.name}`);
        } else {
          const existingProduct = await findExistingStripeProduct(
            stripe,
            item.name,
            'cafe_item_id',
            item.id.toString()
          );

          if (existingProduct) {
            stripeProductId = existingProduct.id;
            await stripe.products.update(stripeProductId, {
              name: item.name,
              description: item.description || undefined,
              metadata,
            });
            console.log(`[Cafe Sync] Reusing existing Stripe product ${stripeProductId} for ${item.name}`);
          } else {
            const newProduct = await stripe.products.create({
              name: item.name,
              description: item.description || undefined,
              metadata,
            });
            stripeProductId = newProduct.id;
            console.log(`[Cafe Sync] Created product for ${item.name}: ${stripeProductId}`);
          }
        }

        let needNewPrice = false;
        if (stripePriceId) {
          try {
            const existingPrice = await stripe.prices.retrieve(stripePriceId);
            if (existingPrice.unit_amount !== priceCents) {
              await stripe.prices.update(stripePriceId, { active: false });
              needNewPrice = true;
              console.log(`[Cafe Sync] Price changed for ${item.name}, creating new price`);
            }
          } catch {
            needNewPrice = true;
          }
        } else {
          needNewPrice = true;
        }

        if (needNewPrice) {
          const newPrice = await stripe.prices.create({
            product: stripeProductId,
            unit_amount: priceCents,
            currency: 'usd',
            metadata: {
              cafe_item_id: item.id.toString(),
            },
          });
          stripePriceId = newPrice.id;
          console.log(`[Cafe Sync] Created price for ${item.name}: ${stripePriceId}`);
        }

        await pool.query(
          'UPDATE cafe_items SET stripe_product_id = $1, stripe_price_id = $2 WHERE id = $3',
          [stripeProductId, stripePriceId, item.id]
        );

        synced++;
      } catch (error: any) {
        console.error(`[Cafe Sync] Error syncing ${item.name}:`, error.message);
        failed++;
      }
    }

    console.log(`[Cafe Sync] Complete: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    return { success: true, synced, failed, skipped };
  } catch (error: any) {
    console.error('[Cafe Sync] Fatal error:', error);
    return { success: false, synced, failed, skipped };
  }
}

export async function pullTierFeaturesFromStripe(): Promise<{
  success: boolean;
  tiersUpdated: number;
  errors: string[];
}> {
  let tiersUpdated = 0;
  const errors: string[] = [];

  try {
    const stripe = await getStripeClient();
    const tiers = await db.select().from(membershipTiers).where(eq(membershipTiers.isActive, true));

    console.log(`[Reverse Sync] Starting tier feature pull for ${tiers.length} active tiers`);

    for (const tier of tiers) {
      if (!tier.stripeProductId) {
        continue;
      }

      try {
        const attachedKeys = new Set<string>();
        let hasMore = true;
        let startingAfter: string | undefined;

        while (hasMore) {
          const params: any = { limit: 100 };
          if (startingAfter) params.starting_after = startingAfter;
          const attached = await stripe.products.listFeatures(tier.stripeProductId, params);
          for (const af of attached.data) {
            if (af.entitlement_feature?.lookup_key) {
              attachedKeys.add(af.entitlement_feature.lookup_key);
            }
          }
          hasMore = attached.has_more;
          if (attached.data.length > 0) {
            startingAfter = attached.data[attached.data.length - 1].id;
          }
        }

        if (attachedKeys.size === 0) {
          console.log(`[Reverse Sync] Tier "${tier.name}" has no Stripe features attached, preserving current DB values`);
          continue;
        }

        const update: Record<string, any> = {
          canBookSimulators: false,
          canBookConference: false,
          canBookWellness: false,
          hasGroupLessons: false,
          hasExtendedSessions: false,
          hasPrivateLesson: false,
          hasSimulatorGuestPasses: false,
          hasDiscountedMerch: false,
          unlimitedAccess: false,
          dailySimMinutes: 0,
          guestPassesPerMonth: 0,
          bookingWindowDays: tier.bookingWindowDays || 7,
          dailyConfRoomMinutes: 0,
        };

        for (const key of attachedKeys) {
          if (key === 'can_book_simulators') update.canBookSimulators = true;
          else if (key === 'can_book_conference') update.canBookConference = true;
          else if (key === 'can_book_wellness') update.canBookWellness = true;
          else if (key === 'has_group_lessons') update.hasGroupLessons = true;
          else if (key === 'has_extended_sessions') update.hasExtendedSessions = true;
          else if (key === 'has_private_lesson') update.hasPrivateLesson = true;
          else if (key === 'has_simulator_guest_passes') update.hasSimulatorGuestPasses = true;
          else if (key === 'has_discounted_merch') update.hasDiscountedMerch = true;
          else if (key === 'unlimited_access') update.unlimitedAccess = true;
          else if (key.startsWith('daily_sim_minutes_')) {
            const suffix = key.replace('daily_sim_minutes_', '');
            update.dailySimMinutes = suffix === 'unlimited' ? 900 : (parseInt(suffix, 10) || 0);
          } else if (key.startsWith('guest_passes_')) {
            const suffix = key.replace('guest_passes_', '');
            update.guestPassesPerMonth = suffix === 'unlimited' ? 900 : (parseInt(suffix, 10) || 0);
          } else if (key.startsWith('booking_window_')) {
            const suffix = key.replace('booking_window_', '');
            update.bookingWindowDays = parseInt(suffix, 10) || 7;
          } else if (key.startsWith('conf_room_minutes_')) {
            const suffix = key.replace('conf_room_minutes_', '');
            update.dailyConfRoomMinutes = suffix === 'unlimited' ? 900 : (parseInt(suffix, 10) || 0);
          }
        }

        update.updatedAt = new Date();

        await db.update(membershipTiers)
          .set(update)
          .where(eq(membershipTiers.id, tier.id));

        tiersUpdated++;
        console.log(`[Reverse Sync] Updated tier "${tier.name}" from ${attachedKeys.size} Stripe features`);
      } catch (err: any) {
        const msg = `Error pulling features for tier "${tier.name}": ${err.message}`;
        console.error(`[Reverse Sync] ${msg}`);
        errors.push(msg);
      }
    }

    console.log(`[Reverse Sync] Tier feature pull complete: ${tiersUpdated} updated, ${errors.length} errors`);
    return { success: errors.length === 0, tiersUpdated, errors };
  } catch (error: any) {
    console.error('[Reverse Sync] Fatal error pulling tier features:', error);
    return { success: false, tiersUpdated, errors: [...errors, error.message] };
  }
}

export async function pullCafeItemsFromStripe(): Promise<{
  success: boolean;
  synced: number;
  created: number;
  deactivated: number;
  errors: string[];
}> {
  let synced = 0;
  let created = 0;
  let deactivated = 0;
  const errors: string[] = [];

  try {
    const stripe = await getStripeClient();
    console.log('[Reverse Sync] Starting cafe items pull from Stripe');

    const activeStripeProducts: any[] = [];
    const inactiveStripeProductIds: string[] = [];

    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const params: any = { limit: 100, active: true };
      if (startingAfter) params.starting_after = startingAfter;
      const products = await stripe.products.list(params);
      for (const product of products.data) {
        if (
          product.metadata?.source === 'ever_house_app' &&
          product.metadata?.product_type === 'one_time' &&
          product.metadata?.cafe_item_id
        ) {
          activeStripeProducts.push(product);
        }
      }
      hasMore = products.has_more;
      if (products.data.length > 0) {
        startingAfter = products.data[products.data.length - 1].id;
      }
    }

    hasMore = true;
    startingAfter = undefined;

    while (hasMore) {
      const params: any = { limit: 100, active: false };
      if (startingAfter) params.starting_after = startingAfter;
      const products = await stripe.products.list(params);
      for (const product of products.data) {
        if (
          product.metadata?.source === 'ever_house_app' &&
          product.metadata?.product_type === 'one_time' &&
          product.metadata?.cafe_item_id
        ) {
          inactiveStripeProductIds.push(product.id);
        }
      }
      hasMore = products.has_more;
      if (products.data.length > 0) {
        startingAfter = products.data[products.data.length - 1].id;
      }
    }

    console.log(`[Reverse Sync] Found ${activeStripeProducts.length} active and ${inactiveStripeProductIds.length} inactive cafe products in Stripe`);

    for (const product of activeStripeProducts) {
      try {
        let priceCents = 0;
        let stripePriceId: string | null = null;

        if (product.default_price) {
          const priceId = typeof product.default_price === 'string' ? product.default_price : product.default_price.id;
          try {
            const price = await stripe.prices.retrieve(priceId);
            priceCents = price.unit_amount || 0;
            stripePriceId = price.id;
          } catch {
          }
        }

        if (!stripePriceId) {
          const prices = await stripe.prices.list({ product: product.id, active: true, limit: 1 });
          if (prices.data.length > 0) {
            priceCents = prices.data[0].unit_amount || 0;
            stripePriceId = prices.data[0].id;
          }
        }

        const priceDecimal = (priceCents / 100).toFixed(2);
        const imageUrl = product.images?.[0] || null;
        const category = product.metadata?.category || 'other';
        const cafeItemId = parseInt(product.metadata?.cafe_item_id, 10) || -1;

        const existing = await pool.query(
          'SELECT id FROM cafe_items WHERE stripe_product_id = $1 OR id = $2 LIMIT 1',
          [product.id, cafeItemId]
        );

        if (existing.rows.length > 0) {
          await pool.query(
            `UPDATE cafe_items SET
              name = $1, description = $2, price = $3, category = $4,
              image_url = COALESCE($5, image_url), stripe_product_id = $6, stripe_price_id = $7,
              is_active = true
            WHERE id = $8`,
            [product.name, product.description || null, priceDecimal, category, imageUrl, product.id, stripePriceId, existing.rows[0].id]
          );
          synced++;
          console.log(`[Reverse Sync] Updated cafe item "${product.name}" (id: ${existing.rows[0].id})`);
        } else {
          await pool.query(
            `INSERT INTO cafe_items (name, description, price, category, image_url, icon, sort_order, is_active, stripe_product_id, stripe_price_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
            [product.name, product.description || null, priceDecimal, category, imageUrl, 'restaurant', 0, true, product.id, stripePriceId]
          );
          created++;
          console.log(`[Reverse Sync] Created cafe item "${product.name}" from Stripe`);
        }
      } catch (err: any) {
        const msg = `Error syncing cafe product "${product.name}": ${err.message}`;
        console.error(`[Reverse Sync] ${msg}`);
        errors.push(msg);
      }
    }

    for (const stripeProductId of inactiveStripeProductIds) {
      try {
        const result = await pool.query(
          'UPDATE cafe_items SET is_active = false WHERE stripe_product_id = $1 AND is_active = true RETURNING id, name',
          [stripeProductId]
        );
        if (result.rowCount && result.rowCount > 0) {
          deactivated += result.rowCount;
          for (const row of result.rows) {
            console.log(`[Reverse Sync] Deactivated cafe item "${row.name}" (Stripe product inactive)`);
          }
        }
      } catch (err: any) {
        const msg = `Error deactivating cafe item for Stripe product ${stripeProductId}: ${err.message}`;
        console.error(`[Reverse Sync] ${msg}`);
        errors.push(msg);
      }
    }

    console.log(`[Reverse Sync] Cafe items pull complete: ${synced} synced, ${created} created, ${deactivated} deactivated, ${errors.length} errors`);
    return { success: errors.length === 0, synced, created, deactivated, errors };
  } catch (error: any) {
    console.error('[Reverse Sync] Fatal error pulling cafe items:', error);
    return { success: false, synced, created, deactivated, errors: [...errors, error.message] };
  }
}
