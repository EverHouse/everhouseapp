import { getStripeClient } from './client';
import { findExistingStripeProduct, buildPrivilegeMetadata, resolveAppCategory, type TierRecord } from './productHelpers';
import { markAppOriginated } from './appOriginTracker';
import { archiveStalePricesForProduct } from './productSync';
import { syncSingleTierFeaturesToStripe } from './productCatalogSync';
import { logger } from '../logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { db } from '../../db';
import { membershipTiers } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import Stripe from 'stripe';

export interface AutoPushTierResult {
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  error?: string;
}

function pick<T>(obj: Record<string, unknown>, camelKey: string, snakeKey: string): T | undefined {
  return (obj[camelKey] ?? obj[snakeKey]) as T | undefined;
}

export async function autoPushTierToStripe(tierRow: Record<string, unknown> & { id: number; name: string; slug: string }): Promise<AutoPushTierResult> {
  try {
    const stripe = await getStripeClient();

    const isActive = pick<boolean>(tierRow, 'isActive', 'is_active') ?? true;
    const rawStripeProductIdForDeactivation = pick<string | null>(tierRow, 'stripeProductId', 'stripe_product_id') ?? null;

    if (!isActive && rawStripeProductIdForDeactivation) {
      try {
        markAppOriginated(rawStripeProductIdForDeactivation);
        await stripe.products.update(rawStripeProductIdForDeactivation, { active: false });
        logger.info(`[AutoPush] Archived Stripe product ${rawStripeProductIdForDeactivation} for deactivated tier "${tierRow.name}"`);
      } catch (archiveErr: unknown) {
        logger.error(`[AutoPush] Failed to archive Stripe product for tier "${tierRow.name}":`, { error: getErrorMessage(archiveErr) });
      }
      return { success: true, stripeProductId: rawStripeProductIdForDeactivation };
    }

    if (!isActive) {
      logger.info(`[AutoPush] Skipping push for inactive tier "${tierRow.name}" (no Stripe product to archive)`);
      return { success: true };
    }

    const description = pick<string | null>(tierRow, 'description', 'description') ?? null;
    let priceCents = pick<number | null>(tierRow, 'priceCents', 'price_cents') ?? null;
    if (!priceCents || priceCents <= 0) {
      const priceString = pick<string | null>(tierRow, 'priceString', 'price_string') ?? null;
      if (priceString) {
        const parsed = parseFloat(priceString.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) {
          priceCents = Math.round(parsed * 100);
        }
      }
    }
    const productType = pick<string | null>(tierRow, 'productType', 'product_type') ?? null;
    const billingInterval = pick<string | null>(tierRow, 'billingInterval', 'billing_interval') ?? null;
    const highlightedFeatures = pick<unknown>(tierRow, 'highlightedFeatures', 'highlighted_features');
    const rawStripeProductId = pick<string | null>(tierRow, 'stripeProductId', 'stripe_product_id') ?? null;
    const rawStripePriceId = pick<string | null>(tierRow, 'stripePriceId', 'stripe_price_id') ?? null;

    const isOneTime = productType === 'one_time' || productType === 'fee' || productType === 'config';
    const productName = isOneTime ? tierRow.name : `${tierRow.name} Membership`;

    const normalizedTier = {
      id: tierRow.id,
      name: tierRow.name,
      slug: tierRow.slug,
      productType,
      description,
      priceCents,
      billingInterval,
      highlightedFeatures: highlightedFeatures as string[] | null,
      stripeProductId: rawStripeProductId,
      stripePriceId: rawStripePriceId,
      dailySimMinutes: pick<number | null>(tierRow, 'dailySimMinutes', 'daily_sim_minutes') ?? null,
      guestPassesPerYear: pick<number | null>(tierRow, 'guestPassesPerYear', 'guest_passes_per_year') ?? null,
      bookingWindowDays: pick<number | null>(tierRow, 'bookingWindowDays', 'booking_window_days') ?? null,
      dailyConfRoomMinutes: pick<number | null>(tierRow, 'dailyConfRoomMinutes', 'daily_conf_room_minutes') ?? null,
      canBookSimulators: pick<boolean>(tierRow, 'canBookSimulators', 'can_book_simulators') ?? false,
      canBookConference: pick<boolean>(tierRow, 'canBookConference', 'can_book_conference') ?? false,
      canBookWellness: pick<boolean>(tierRow, 'canBookWellness', 'can_book_wellness') ?? false,
      hasGroupLessons: pick<boolean>(tierRow, 'hasGroupLessons', 'has_group_lessons') ?? false,
      hasExtendedSessions: pick<boolean>(tierRow, 'hasExtendedSessions', 'has_extended_sessions') ?? false,
      hasPrivateLesson: pick<boolean>(tierRow, 'hasPrivateLesson', 'has_private_lesson') ?? false,
      hasSimulatorGuestPasses: pick<boolean>(tierRow, 'hasSimulatorGuestPasses', 'has_simulator_guest_passes') ?? false,
      hasDiscountedMerch: pick<boolean>(tierRow, 'hasDiscountedMerch', 'has_discounted_merch') ?? false,
      unlimitedAccess: pick<boolean>(tierRow, 'unlimitedAccess', 'unlimited_access') ?? false,
    };

    const privilegeMetadata = buildPrivilegeMetadata(normalizedTier as Parameters<typeof buildPrivilegeMetadata>[0]);

    const isSubscription = !isOneTime;
    const featuresArray = highlightedFeatures as string[] | null;
    const hasMarketingFeatures = isSubscription && Array.isArray(featuresArray) && featuresArray.length > 0;
    const marketingFeatures = hasMarketingFeatures
      ? featuresArray.slice(0, 15).map((f: string) => ({ name: f }))
      : [];

    let stripeProductId = rawStripeProductId;
    let stripePriceId = rawStripePriceId;

    if (stripeProductId) {
      const updateParams: Stripe.ProductUpdateParams & { marketing_features?: Array<{ name: string }> } = {
        name: productName,
        description: description || undefined,
        metadata: privilegeMetadata,
      };
      if (isSubscription) {
        updateParams.marketing_features = hasMarketingFeatures ? marketingFeatures : [];
      }
      markAppOriginated(stripeProductId);
      await stripe.products.update(stripeProductId, updateParams);
      logger.info(`[AutoPush] Updated Stripe product for tier "${tierRow.name}"`);
    } else {
      const createParams: Stripe.ProductCreateParams & { marketing_features?: Array<{ name: string }> } = {
        name: productName,
        description: description || undefined,
        metadata: privilegeMetadata,
      };
      if (hasMarketingFeatures) {
        createParams.marketing_features = marketingFeatures;
      }

      const existingProduct = await findExistingStripeProduct(stripe, productName, 'tier_id', tierRow.id.toString());
      let stripeProduct;
      if (existingProduct) {
        markAppOriginated(existingProduct.id);
        stripeProduct = await stripe.products.update(existingProduct.id, createParams);
        logger.info(`[AutoPush] Reusing existing Stripe product ${stripeProduct.id} for tier "${tierRow.name}"`);
      } else {
        stripeProduct = await stripe.products.create(createParams, {
          idempotencyKey: `autopush_product_tier_${tierRow.id}_${tierRow.slug}_${Date.now()}`
        });
        markAppOriginated(stripeProduct.id);
        logger.info(`[AutoPush] Created new Stripe product ${stripeProduct.id} for tier "${tierRow.name}"`);
      }
      stripeProductId = stripeProduct.id;
    }

    if (isSubscription && stripeProductId) {
      syncSingleTierFeaturesToStripe(normalizedTier as TierRecord, stripeProductId).catch(err => {
        logger.error(`[AutoPush] Background feature sync failed for tier "${tierRow.name}":`, { error: getErrorMessage(err) });
      });
    }

    if (priceCents && priceCents > 0) {
      const priceMetadata = {
        tier_id: tierRow.id.toString(),
        tier_slug: tierRow.slug,
        product_type: productType || 'subscription',
        app_category: resolveAppCategory(productType),
        source: 'ever_house_app',
      };

      let needNewPrice = false;

      if (stripePriceId) {
        try {
          const existingPrice = await stripe.prices.retrieve(stripePriceId);
          if (!existingPrice.active) {
            needNewPrice = true;
          } else if (existingPrice.unit_amount !== priceCents) {
            markAppOriginated(stripePriceId);
            await stripe.prices.update(stripePriceId, { active: false });
            needNewPrice = true;
            logger.info(`[AutoPush] Price changed for tier "${tierRow.name}", creating new price`);
          }
        } catch (priceErr: unknown) {
          const errMsg = getErrorMessage(priceErr);
          if (errMsg.includes('No such price') || errMsg.includes('resource_missing')) {
            needNewPrice = true;
          } else {
            throw priceErr;
          }
        }
      } else {
        needNewPrice = true;
      }

      if (needNewPrice) {
        const priceParams: Stripe.PriceCreateParams = {
          product: stripeProductId,
          unit_amount: priceCents,
          currency: 'usd',
          metadata: priceMetadata,
        };
        if (!isOneTime) {
          const interval = (billingInterval as 'month' | 'year' | 'week' | 'day') || 'month';
          priceParams.recurring = { interval };
        }
        const newPrice = await stripe.prices.create(priceParams, {
          idempotencyKey: `autopush_price_tier_${tierRow.id}_${priceCents}_${Date.now()}`
        });
        markAppOriginated(newPrice.id);
        stripePriceId = newPrice.id;

        markAppOriginated(stripeProductId);
        await stripe.products.update(stripeProductId, { default_price: stripePriceId });

        archiveStalePricesForProduct(stripeProductId, stripePriceId).catch(err => {
          logger.error(`[AutoPush] Background stale price cleanup failed for tier "${tierRow.name}":`, { error: getErrorMessage(err) });
        });

        logger.info(`[AutoPush] Created new price ${stripePriceId} for tier "${tierRow.name}"`);
      }

      await db.update(membershipTiers)
        .set({
          stripeProductId,
          stripePriceId,
          updatedAt: new Date(),
        })
        .where(eq(membershipTiers.id, tierRow.id));
    } else if (!rawStripeProductId && stripeProductId) {
      await db.update(membershipTiers)
        .set({
          stripeProductId,
          updatedAt: new Date(),
        })
        .where(eq(membershipTiers.id, tierRow.id));
    }

    return { success: true, stripeProductId: stripeProductId || undefined, stripePriceId: stripePriceId || undefined };
  } catch (error: unknown) {
    logger.error(`[AutoPush] Error pushing tier "${tierRow.name}" to Stripe:`, { error: getErrorMessage(error) });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function autoPushCafeItemToStripe(item: {
  id: number;
  name: string;
  description?: string | null;
  price: string;
  category: string;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
}): Promise<{ success: boolean; stripeProductId?: string; stripePriceId?: string; error?: string }> {
  try {
    const stripe = await getStripeClient();
    const priceCents = Math.round(parseFloat(item.price) * 100);
    if (priceCents <= 0) {
      return { success: true };
    }

    const metadata: Record<string, string> = {
      source: 'ever_house_app',
      cafe_item_id: item.id.toString(),
      category: item.category || '',
      product_type: 'one_time',
      app_category: 'cafe',
    };

    let stripeProductId = item.stripeProductId || null;
    let stripePriceId = item.stripePriceId || null;

    if (stripeProductId) {
      markAppOriginated(stripeProductId);
      await stripe.products.update(stripeProductId, {
        name: item.name,
        description: item.description || undefined,
        metadata,
      });
      logger.info(`[AutoPush] Updated Stripe product for cafe item "${item.name}"`);
    } else {
      const existingProduct = await findExistingStripeProduct(stripe, item.name, 'cafe_item_id', item.id.toString());
      if (existingProduct) {
        stripeProductId = existingProduct.id;
        markAppOriginated(stripeProductId);
        await stripe.products.update(stripeProductId, {
          name: item.name,
          description: item.description || undefined,
          metadata,
          active: true,
        });
        logger.info(`[AutoPush] Reusing existing Stripe product ${stripeProductId} for cafe item "${item.name}"`);
      } else {
        const newProduct = await stripe.products.create({
          name: item.name,
          description: item.description || undefined,
          metadata,
        }, {
          idempotencyKey: `autopush_product_cafe_${item.id}_${Date.now()}`
        });
        stripeProductId = newProduct.id;
        markAppOriginated(stripeProductId);
        logger.info(`[AutoPush] Created new Stripe product ${stripeProductId} for cafe item "${item.name}"`);
      }
    }

    let needNewPrice = false;
    if (stripePriceId) {
      try {
        const existingPrice = await stripe.prices.retrieve(stripePriceId);
        if (!existingPrice.active) {
          needNewPrice = true;
        } else if (existingPrice.unit_amount !== priceCents) {
          markAppOriginated(stripePriceId);
          await stripe.prices.update(stripePriceId, { active: false });
          needNewPrice = true;
          logger.info(`[AutoPush] Price changed for cafe item "${item.name}", creating new price`);
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
          product_type: 'one_time',
          app_category: 'cafe',
          source: 'ever_house_app',
        },
      }, {
        idempotencyKey: `autopush_price_cafe_${item.id}_${priceCents}_${Date.now()}`
      });
      markAppOriginated(newPrice.id);
      stripePriceId = newPrice.id;

      markAppOriginated(stripeProductId);
      await stripe.products.update(stripeProductId, { default_price: stripePriceId });

      archiveStalePricesForProduct(stripeProductId, stripePriceId).catch(err => {
        logger.error(`[AutoPush] Background stale price cleanup failed for cafe item "${item.name}":`, { error: getErrorMessage(err) });
      });

      logger.info(`[AutoPush] Created new price ${stripePriceId} for cafe item "${item.name}"`);
    }

    await db.execute(sql`UPDATE cafe_items SET stripe_product_id = ${stripeProductId}, stripe_price_id = ${stripePriceId} WHERE id = ${item.id}`);

    return { success: true, stripeProductId: stripeProductId || undefined, stripePriceId: stripePriceId || undefined };
  } catch (error: unknown) {
    logger.error(`[AutoPush] Error pushing cafe item "${item.name}" to Stripe:`, { error: getErrorMessage(error) });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function autoPushFeeToStripe(slug: string, priceCents: number): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = await getStripeClient();

    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, slug))
      .limit(1);

    if (existing.length === 0) {
      return { success: false, error: `No tier record found for slug "${slug}"` };
    }

    const tier = existing[0];
    let stripeProductId = tier.stripeProductId;
    let stripePriceId = tier.stripePriceId;

    if (!stripeProductId) {
      return { success: false, error: `Tier "${slug}" has no Stripe product. Run "Sync to Stripe" first.` };
    }

    let needNewPrice = false;
    if (stripePriceId) {
      try {
        const existingPrice = await stripe.prices.retrieve(stripePriceId);
        if (!existingPrice.active || existingPrice.unit_amount !== priceCents) {
          if (existingPrice.active) {
            markAppOriginated(stripePriceId);
            await stripe.prices.update(stripePriceId, { active: false });
          }
          needNewPrice = true;
        }
      } catch {
        needNewPrice = true;
      }
    } else {
      needNewPrice = true;
    }

    if (needNewPrice) {
      const feeType = slug.includes('guest') ? 'guest_pass' : slug.includes('overage') ? 'simulator_overage' : 'general';
      const newPrice = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: priceCents,
        currency: 'usd',
        metadata: {
          tier_id: tier.id.toString(),
          tier_slug: slug,
          product_type: 'one_time',
          app_category: 'fee',
          fee_type: feeType,
          source: 'ever_house_app',
        },
      }, {
        idempotencyKey: `autopush_fee_${slug}_${priceCents}_${Date.now()}`
      });
      markAppOriginated(newPrice.id);
      stripePriceId = newPrice.id;

      markAppOriginated(stripeProductId);
      await stripe.products.update(stripeProductId, { default_price: stripePriceId });

      archiveStalePricesForProduct(stripeProductId, stripePriceId).catch(err => {
        logger.error(`[AutoPush] Background stale price cleanup failed for fee "${slug}":`, { error: getErrorMessage(err) });
      });

      await db.update(membershipTiers)
        .set({
          stripePriceId,
          priceCents,
          priceString: `$${(priceCents / 100).toFixed(2)}`,
          updatedAt: new Date(),
        })
        .where(eq(membershipTiers.id, tier.id));

      logger.info(`[AutoPush] Updated fee "${slug}" to ${priceCents} cents in Stripe`);
    }

    return { success: true };
  } catch (error: unknown) {
    logger.error(`[AutoPush] Error pushing fee "${slug}" to Stripe:`, { error: getErrorMessage(error) });
    return { success: false, error: getErrorMessage(error) };
  }
}
