import { db } from '../../db';
import { sql } from 'drizzle-orm';
import { membershipTiers } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from './client';
import Stripe from 'stripe';
import { clearTierCache } from '../tierService';
import { getErrorMessage, getErrorCode } from '../../utils/errorUtils';
import { logger } from '../logger';
import { type StripePaginationParams, type StripeProductWithMarketingFeatures, buildFeatureKeysForTier } from './productHelpers';

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

    logger.info(`[Feature Sync] Starting feature sync for ${tiers.length} active tiers`);

    const existingFeatures = new Map<string, string>();
    let hasMoreFeatures = true;
    let startingAfterFeature: string | undefined;

    while (hasMoreFeatures) {
      const params: StripePaginationParams = { limit: 100 };
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

    logger.info(`[Feature Sync] Found ${existingFeatures.size} existing Stripe features`);

    for (const tier of tiers) {
      if (!tier.stripeProductId) {
        logger.info(`[Feature Sync] Skipping ${tier.name}: No Stripe product ID`);
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
            }, {
              idempotencyKey: `feature_${feature.lookupKey}`
            });
            existingFeatures.set(feature.lookupKey, created.id);
            featuresCreated++;
            logger.info(`[Feature Sync] Created feature: ${feature.name} (${feature.lookupKey})`);
          } catch (err: unknown) {
            if (getErrorCode(err) === 'resource_already_exists') {
              const refetch = await stripe.entitlements.features.list({ lookup_key: feature.lookupKey, limit: 1 });
              if (refetch.data.length > 0) {
                existingFeatures.set(feature.lookupKey, refetch.data[0].id);
              }
            } else {
              logger.error(`[Feature Sync] Error creating feature ${feature.lookupKey}:`, { extra: { detail: getErrorMessage(err) } });
            }
          }
        }
      }

      const attachedFeatures = new Map<string, string>();
      let hasMoreAttached = true;
      let startingAfterAttached: string | undefined;

      while (hasMoreAttached) {
        const params: StripePaginationParams = { limit: 100 };
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
              logger.info(`[Feature Sync] Attached ${feature.lookupKey} to ${tier.name}`);
            } catch (err: unknown) {
              logger.error(`[Feature Sync] Error attaching ${feature.lookupKey} to ${tier.name}:`, { extra: { detail: getErrorMessage(err) } });
            }
          }
        }
      }

      for (const [attachedKey, attachmentId] of attachedFeatures) {
        if (!desiredKeys.has(attachedKey)) {
          try {
            await stripe.products.deleteFeature(tier.stripeProductId, attachmentId);
            featuresRemoved++;
            logger.info(`[Feature Sync] Removed ${attachedKey} from ${tier.name}`);
          } catch (err: unknown) {
            logger.error(`[Feature Sync] Error removing ${attachedKey} from ${tier.name}:`, { extra: { detail: getErrorMessage(err) } });
          }
        }
      }
    }

    logger.info(`[Feature Sync] Complete: ${featuresCreated} created, ${featuresAttached} attached, ${featuresRemoved} removed`);
    return { success: true, featuresCreated, featuresAttached, featuresRemoved };
  } catch (error: unknown) {
    logger.error('[Feature Sync] Fatal error:', { error: error });
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
    const cafeItemResult = await db.execute(sql`SELECT id, name, description, price, category, stripe_product_id, stripe_price_id FROM cafe_items WHERE is_active = true ORDER BY category, sort_order`);
    const cafeItemRows = cafeItemResult.rows as Array<{ id: number; name: string; description: string | null; price: string; category: string; stripe_product_id: string | null; stripe_price_id: string | null }>;

    logger.info(`[Cafe Sync] Starting sync for ${cafeItemRows.length} active cafe items`);

    const { findExistingStripeProduct } = await import('./productHelpers');

    for (const item of cafeItemRows) {
      try {
        const itemName = item.name;
        const itemId = String(item.id);
        const itemDescription = item.description || undefined;
        const itemCategory = item.category || '';
        const priceCents = Math.round(parseFloat(item.price) * 100);
        if (priceCents <= 0) {
          logger.info(`[Cafe Sync] Skipping ${itemName}: No price`);
          skipped++;
          continue;
        }

        const metadata: Record<string, string> = {
          source: 'ever_house_app',
          cafe_item_id: itemId,
          category: itemCategory,
          product_type: 'one_time',
          app_category: 'cafe',
        };

        let stripeProductId = item.stripe_product_id as string | null;
        let stripePriceId = item.stripe_price_id as string | null;

        if (stripeProductId) {
          await stripe.products.update(stripeProductId, {
            name: itemName,
            description: itemDescription,
            metadata,
          });
          logger.info(`[Cafe Sync] Updated product for ${itemName}`);
        } else {
          const existingProduct = await findExistingStripeProduct(
            stripe,
            itemName,
            'cafe_item_id',
            itemId
          );

          if (existingProduct) {
            stripeProductId = existingProduct.id;
            await stripe.products.update(stripeProductId, {
              name: itemName,
              description: itemDescription,
              metadata,
            });
            logger.info(`[Cafe Sync] Reusing existing Stripe product ${stripeProductId} for ${itemName}`);
          } else {
            const newProduct = await stripe.products.create({
              name: itemName,
              description: itemDescription,
              metadata,
            }, {
              idempotencyKey: `product_cafe_${itemId}`
            });
            stripeProductId = newProduct.id;
            logger.info(`[Cafe Sync] Created product for ${itemName}: ${stripeProductId}`);
          }
        }

        let needNewPrice = false;
        if (stripePriceId) {
          try {
            const existingPrice = await stripe.prices.retrieve(stripePriceId);
            if (existingPrice.unit_amount !== priceCents) {
              await stripe.prices.update(stripePriceId, { active: false });
              needNewPrice = true;
              logger.info(`[Cafe Sync] Price changed for ${itemName}, creating new price`);
            }
          } catch (err) {
            logger.debug('[Cafe Sync] Failed to retrieve existing Stripe price, will create new one', { error: err instanceof Error ? err.message : err });
            needNewPrice = true;
          }
        } else {
          needNewPrice = true;
        }

        if (needNewPrice) {
          const newPrice = await stripe.prices.create({
            product: stripeProductId as string,
            unit_amount: priceCents,
            currency: 'usd',
            metadata: {
              cafe_item_id: itemId,
            },
          }, {
            idempotencyKey: `price_cafe_${itemId}_${priceCents}`
          });
          stripePriceId = newPrice.id;
          logger.info(`[Cafe Sync] Created price for ${itemName}: ${stripePriceId}`);

          await stripe.products.update(stripeProductId as string, {
            default_price: stripePriceId,
          });
          logger.info(`[Cafe Sync] Updated default_price for ${itemName} to ${stripePriceId}`);
        }

        await db.execute(sql`UPDATE cafe_items SET stripe_product_id = ${stripeProductId}, stripe_price_id = ${stripePriceId} WHERE id = ${itemId}`);

        synced++;
      } catch (error: unknown) {
        logger.error(`[Cafe Sync] Error syncing ${String(item.name)}:`, { extra: { detail: getErrorMessage(error) } });
        failed++;
      }
    }

    logger.info(`[Cafe Sync] Complete: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    return { success: true, synced, failed, skipped };
  } catch (error: unknown) {
    logger.error('[Cafe Sync] Fatal error:', { error: error });
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

    logger.info(`[Reverse Sync] Starting tier feature pull for ${tiers.length} active tiers`);

    const tiersWithStripe = tiers.filter(t => t.stripeProductId);
    if (tiersWithStripe.length === 0) {
      logger.warn('[Reverse Sync] No tiers are linked to Stripe products yet. Run "Sync to Stripe" first. Skipping pull to preserve local data.');
      return { success: true, tiersUpdated: 0, errors: ['No tiers linked to Stripe products. Run "Sync to Stripe" first.'] };
    }

    for (const tier of tiers) {
      if (!tier.stripeProductId) {
        continue;
      }

      try {
        const attachedKeys = new Set<string>();
        let hasMore = true;
        let startingAfter: string | undefined;

        while (hasMore) {
          const params: StripePaginationParams = { limit: 100 };
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

        const stripeProduct = await stripe.products.retrieve(tier.stripeProductId);
        const marketingFeatures = (stripeProduct as StripeProductWithMarketingFeatures).marketing_features;
        if (Array.isArray(marketingFeatures) && marketingFeatures.length > 0) {
          const featureNames = marketingFeatures
            .map((f: { name: string }) => f.name)
            .filter((n: string) => n && n.trim());
          if (featureNames.length > 0) {
            await db.update(membershipTiers)
              .set({ highlightedFeatures: featureNames })
              .where(eq(membershipTiers.id, tier.id));
            logger.info(`[Reverse Sync] Updated highlighted features for "${tier.name}" from ${featureNames.length} Stripe marketing features`);
          } else {
            await db.update(membershipTiers)
              .set({ highlightedFeatures: [] })
              .where(eq(membershipTiers.id, tier.id));
            logger.info(`[Reverse Sync] Cleared highlighted features for "${tier.name}" (Stripe marketing features empty)`);
          }
        } else {
          await db.update(membershipTiers)
            .set({ highlightedFeatures: [] })
            .where(eq(membershipTiers.id, tier.id));
          logger.info(`[Reverse Sync] Cleared highlighted features for "${tier.name}" (no Stripe marketing features)`);
        }

        if (attachedKeys.size === 0) {
          logger.info(`[Reverse Sync] Tier "${tier.name}" has no Stripe entitlement features attached, preserving current DB permission values`);
          tiersUpdated++;
          continue;
        }

        const update: Record<string, boolean | number> = {
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
          guestPassesPerYear: 0,
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
            update.guestPassesPerYear = suffix === 'unlimited' ? 900 : (parseInt(suffix, 10) || 0);
          } else if (key.startsWith('booking_window_')) {
            const suffix = key.replace('booking_window_', '');
            update.bookingWindowDays = parseInt(suffix, 10) || 7;
          } else if (key.startsWith('conf_room_minutes_')) {
            const suffix = key.replace('conf_room_minutes_', '');
            update.dailyConfRoomMinutes = suffix === 'unlimited' ? 900 : (parseInt(suffix, 10) || 0);
          }
        }

        if (tier.dailySimMinutes && tier.dailySimMinutes > 0 && update.dailySimMinutes === 0) {
          const msg = `SAFETY: Skipping tier "${tier.name}" — dailySimMinutes would drop from ${tier.dailySimMinutes} to 0. This likely indicates a missing Stripe entitlement feature key.`;
          logger.warn(`[Reverse Sync] ${msg}`);
          errors.push(msg);
          continue;
        }

        if (tier.guestPassesPerYear && tier.guestPassesPerYear > 0 && update.guestPassesPerYear === 0) {
          const msg = `SAFETY: Skipping tier "${tier.name}" — guestPassesPerYear would drop from ${tier.guestPassesPerYear} to 0. This likely indicates a missing Stripe entitlement feature key.`;
          logger.warn(`[Reverse Sync] ${msg}`);
          errors.push(msg);
          continue;
        }

        (update as Record<string, boolean | number | Date>).updatedAt = new Date();

        await db.update(membershipTiers)
          .set(update)
          .where(eq(membershipTiers.id, tier.id));

        tiersUpdated++;
        logger.info(`[Reverse Sync] Updated tier "${tier.name}" from ${attachedKeys.size} Stripe features`);
      } catch (err: unknown) {
        const msg = `Error pulling features for tier "${tier.name}": ${getErrorMessage(err)}`;
        logger.error(`[Reverse Sync] ${msg}`);
        errors.push(msg);
      }
    }

    logger.info(`[Reverse Sync] Tier feature pull complete: ${tiersUpdated} updated, ${errors.length} errors`);
    clearTierCache();
    return { success: errors.length === 0, tiersUpdated, errors };
  } catch (error: unknown) {
    logger.error('[Reverse Sync] Fatal error pulling tier features:', { error: error });
    return { success: false, tiersUpdated, errors: [...errors, getErrorMessage(error)] };
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
    logger.info('[Reverse Sync] Starting cafe items pull from Stripe');

    const activeStripeProducts: Stripe.Product[] = [];
    const inactiveStripeProductIds: string[] = [];

    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const params: StripePaginationParams = { limit: 100, active: true };
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
      const params: StripePaginationParams = { limit: 100, active: false };
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

    logger.info(`[Reverse Sync] Found ${activeStripeProducts.length} active and ${inactiveStripeProductIds.length} inactive cafe products in Stripe`);

    const existingCafeCount = await db.execute(sql`SELECT COUNT(*) FROM cafe_items WHERE is_active = true`);
    const localCafeItems = parseInt(String((existingCafeCount.rows as unknown as Array<{ count: string }>)[0].count), 10);

    if (activeStripeProducts.length === 0 && localCafeItems > 0) {
      logger.warn(`[Reverse Sync] Stripe has 0 cafe products but local DB has ${localCafeItems} active items. Skipping pull to preserve local data. Run "Sync to Stripe" first to push cafe items.`);
      return { success: true, synced: 0, created: 0, deactivated: 0, errors: ['No cafe products found in Stripe. Run "Sync to Stripe" first to push local data.'] };
    }

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
          } catch (err) {
            logger.debug('[Reverse Sync] Failed to retrieve Stripe price by default_price ID', { error: err instanceof Error ? err.message : err });
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

        const existing = await db.execute(sql`SELECT id, is_active FROM cafe_items WHERE stripe_product_id = ${product.id} OR id = ${cafeItemId} LIMIT 1`);

        if (existing.rows.length > 0) {
          const existingRow = existing.rows[0] as unknown as { id: number; is_active: boolean };
          const existingId = existingRow.id;
          if (!existingRow.is_active) {
            logger.info(`[Reverse Sync] Skipped reactivation of locally-deleted cafe item "${product.name}" (id: ${existingId})`);
          } else {
            await db.execute(sql`UPDATE cafe_items SET
                name = ${product.name}, description = ${product.description || null}, price = ${priceDecimal}, category = ${category},
                image_url = COALESCE(${imageUrl}, image_url), stripe_product_id = ${product.id}, stripe_price_id = ${stripePriceId}
              WHERE id = ${existingId}`);
            synced++;
            logger.info(`[Reverse Sync] Updated cafe item "${product.name}" (id: ${existingId})`);
          }
        } else {
          await db.execute(sql`INSERT INTO cafe_items (name, description, price, category, image_url, icon, sort_order, is_active, stripe_product_id, stripe_price_id, created_at)
             VALUES (${product.name}, ${product.description || null}, ${priceDecimal}, ${category}, ${imageUrl}, ${'restaurant'}, ${0}, ${true}, ${product.id}, ${stripePriceId}, NOW())`);
          created++;
          logger.info(`[Reverse Sync] Created cafe item "${product.name}" from Stripe`);
        }
      } catch (err: unknown) {
        const msg = `Error syncing cafe product "${product.name}": ${getErrorMessage(err)}`;
        logger.error(`[Reverse Sync] ${msg}`);
        errors.push(msg);
      }
    }

    for (const stripeProductId of inactiveStripeProductIds) {
      try {
        const result = await db.execute(sql`UPDATE cafe_items SET is_active = false WHERE stripe_product_id = ${stripeProductId} AND is_active = true RETURNING id, name`);
        const deactivateResult = result as unknown as { rowCount: number; rows: Array<{ id: number; name: string }> };
        if (deactivateResult.rowCount && deactivateResult.rowCount > 0) {
          deactivated += deactivateResult.rowCount;
          for (const row of deactivateResult.rows) {
            logger.info(`[Reverse Sync] Deactivated cafe item "${row.name}" (Stripe product inactive)`);
          }
        }
      } catch (err: unknown) {
        const msg = `Error deactivating cafe item for Stripe product ${stripeProductId}: ${getErrorMessage(err)}`;
        logger.error(`[Reverse Sync] ${msg}`);
        errors.push(msg);
      }
    }

    const allKnownStripeIds = new Set([
      ...activeStripeProducts.map(p => p.id),
      ...inactiveStripeProductIds,
    ]);
    try {
      const orphanedResult = await db.execute(sql`
        SELECT id, name, stripe_product_id
        FROM cafe_items
        WHERE is_active = true
          AND stripe_product_id IS NOT NULL
      `);
      const orphanedRows = (orphanedResult.rows as Array<{ id: number; name: string; stripe_product_id: string }>)
        .filter(row => !allKnownStripeIds.has(row.stripe_product_id));
      for (const row of orphanedRows) {
        await db.execute(sql`UPDATE cafe_items SET is_active = false WHERE id = ${row.id}`);
        deactivated++;
        logger.info(`[Reverse Sync] Deactivated cafe item "${row.name}" (Stripe product deleted)`);
      }
    } catch (err: unknown) {
      const msg = `Error deactivating orphaned cafe items: ${getErrorMessage(err)}`;
      logger.error(`[Reverse Sync] ${msg}`);
      errors.push(msg);
    }

    logger.info(`[Reverse Sync] Cafe items pull complete: ${synced} synced, ${created} created, ${deactivated} deactivated, ${errors.length} errors`);
    return { success: errors.length === 0, synced, created, deactivated, errors };
  } catch (error: unknown) {
    logger.error('[Reverse Sync] Fatal error pulling cafe items:', { error: error });
    return { success: false, synced, created, deactivated, errors: [...errors, getErrorMessage(error)] };
  }
}
