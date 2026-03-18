import { db } from '../../db';
import { membershipTiers } from '../../../shared/schema';
import { eq } from 'drizzle-orm';
import { getStripeClient } from './client';
import { PRICING, getCorporateVolumeTiers, getCorporateBasePrice, updateCorporateVolumePricing, updateOverageRate, updateGuestFee, VolumeTier } from '../billing/pricingConfig';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../logger';

export async function ensureSimulatorOverageProduct(): Promise<{
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  action: 'created' | 'exists' | 'error';
}> {
  const OVERAGE_SLUG = 'simulator-overage-30min';
  const OVERAGE_NAME = 'Simulator Overage (30 min)';
  const OVERAGE_PRICE_CENTS = PRICING.OVERAGE_RATE_CENTS;
  const OVERAGE_DESCRIPTION = 'Per 30 minutes over tier privileges';

  try {
    const stripe = await getStripeClient();
    
    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, OVERAGE_SLUG))
      .limit(1);
    
    let tierId: number;
    let stripeProductId = existing[0]?.stripeProductId;
    let stripePriceId = existing[0]?.stripePriceId;
    
    if (existing.length === 0) {
      const [newTier] = await db.insert(membershipTiers).values({
        name: OVERAGE_NAME,
        slug: OVERAGE_SLUG,
        priceString: `$${PRICING.OVERAGE_RATE_DOLLARS}`,
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
      logger.info(`[Overage Product] Created database record: ${OVERAGE_NAME}`);
    } else {
      tierId = existing[0].id;
      if (existing[0].productType !== 'one_time') {
        await db.update(membershipTiers)
          .set({ productType: 'one_time' })
          .where(eq(membershipTiers.id, tierId));
        logger.info(`[Overage Product] Fixed productType to one_time`);
      }
    }
    
    if (!stripeProductId) {
      const product = await stripe.products.create({
        name: OVERAGE_NAME,
        description: OVERAGE_DESCRIPTION,
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: OVERAGE_SLUG,
          product_type: 'one_time',
          fee_type: 'simulator_overage',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `product_overage_${OVERAGE_SLUG}`
      });
      stripeProductId = product.id;
      logger.info(`[Overage Product] Created Stripe product: ${stripeProductId}`);
    }
    
    if (!stripePriceId) {
      const price = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: OVERAGE_PRICE_CENTS,
        currency: 'usd',
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: OVERAGE_SLUG,
          product_type: 'one_time',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `price_overage_${OVERAGE_SLUG}_${OVERAGE_PRICE_CENTS}`
      });
      stripePriceId = price.id;
      logger.info(`[Overage Product] Created Stripe price: ${stripePriceId}`);
    }
    
    await db.update(membershipTiers)
      .set({
        stripeProductId,
        stripePriceId,
      })
      .where(eq(membershipTiers.id, tierId));
    
    logger.info(`[Overage Product] ${OVERAGE_NAME} ready (${stripePriceId})`);

    try {
      const actualPrice = await stripe.prices.retrieve(stripePriceId);
      if (actualPrice.unit_amount && actualPrice.unit_amount > 0) {
        updateOverageRate(actualPrice.unit_amount);
      }
    } catch (priceReadErr: unknown) {
      logger.warn('[Overage Product] Failed to read Stripe price, using default:', { error: priceReadErr });
    }

    return { success: true, stripeProductId, stripePriceId, action: existing.length > 0 && existing[0].stripePriceId ? 'exists' : 'created' };
  } catch (error: unknown) {
    logger.error('[Overage Product] Error:', { extra: { detail: getErrorMessage(error) } });
    return { success: false, action: 'error' };
  }
}

export async function ensureGuestPassProduct(): Promise<{
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  action: 'created' | 'exists' | 'error';
}> {
  const GUEST_PASS_SLUG = 'guest-pass';
  const GUEST_PASS_NAME = 'Guest Fee';
  const GUEST_PASS_PRICE_CENTS = PRICING.GUEST_FEE_CENTS;
  const GUEST_PASS_DESCRIPTION = 'Guest fee for simulator use';

  try {
    const stripe = await getStripeClient();
    
    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, GUEST_PASS_SLUG))
      .limit(1);
    
    let tierId: number;
    let stripeProductId = existing[0]?.stripeProductId;
    let stripePriceId = existing[0]?.stripePriceId;
    
    if (existing.length === 0) {
      const [newTier] = await db.insert(membershipTiers).values({
        name: GUEST_PASS_NAME,
        slug: GUEST_PASS_SLUG,
        priceString: `$${GUEST_PASS_PRICE_CENTS / 100}`,
        description: GUEST_PASS_DESCRIPTION,
        buttonText: 'Purchase',
        sortOrder: 97,
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
        priceCents: GUEST_PASS_PRICE_CENTS,
      }).returning();
      tierId = newTier.id;
      logger.info(`[Guest Pass Product] Created database record: ${GUEST_PASS_NAME}`);
    } else {
      tierId = existing[0].id;
      const updates: Record<string, string> = {};
      if (existing[0].name !== GUEST_PASS_NAME) updates.name = GUEST_PASS_NAME;
      if (existing[0].productType !== 'one_time') updates.productType = 'one_time';
      if (Object.keys(updates).length > 0) {
        await db.update(membershipTiers)
          .set(updates)
          .where(eq(membershipTiers.id, tierId));
        logger.info(`[Guest Pass Product] Fixed DB record fields: ${Object.keys(updates).join(', ')}`);
      }
    }
    
    if (!stripeProductId) {
      const product = await stripe.products.create({
        name: GUEST_PASS_NAME,
        description: GUEST_PASS_DESCRIPTION,
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: GUEST_PASS_SLUG,
          product_type: 'one_time',
          fee_type: 'guest_pass',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `product_guest_pass_${GUEST_PASS_SLUG}`
      });
      stripeProductId = product.id;
      logger.info(`[Guest Pass Product] Created Stripe product: ${stripeProductId}`);
    } else {
      try {
        const existingProduct = await stripe.products.retrieve(stripeProductId);
        if (existingProduct.name !== GUEST_PASS_NAME) {
          await stripe.products.update(stripeProductId, { name: GUEST_PASS_NAME, description: GUEST_PASS_DESCRIPTION });
          logger.info(`[Guest Pass Product] Renamed Stripe product: ${existingProduct.name} -> ${GUEST_PASS_NAME}`);
        }
      } catch (renameErr: unknown) {
        logger.warn('[Guest Pass Product] Could not sync Stripe product name', { error: renameErr });
      }
    }
    
    if (!stripePriceId) {
      const price = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: GUEST_PASS_PRICE_CENTS,
        currency: 'usd',
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: GUEST_PASS_SLUG,
          product_type: 'one_time',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `price_guest_pass_${GUEST_PASS_SLUG}_${GUEST_PASS_PRICE_CENTS}`
      });
      stripePriceId = price.id;
      logger.info(`[Guest Pass Product] Created Stripe price: ${stripePriceId}`);
    }
    
    await db.update(membershipTiers)
      .set({
        stripeProductId,
        stripePriceId,
      })
      .where(eq(membershipTiers.id, tierId));
    
    logger.info(`[Guest Pass Product] ${GUEST_PASS_NAME} ready (${stripePriceId})`);

    try {
      const actualPrice = await stripe.prices.retrieve(stripePriceId);
      if (actualPrice.unit_amount && actualPrice.unit_amount > 0) {
        updateGuestFee(actualPrice.unit_amount);
      }
    } catch (priceReadErr: unknown) {
      logger.warn('[Guest Pass Product] Failed to read Stripe price, using default:', { error: priceReadErr });
    }

    return { success: true, stripeProductId, stripePriceId, action: existing.length > 0 && existing[0].stripePriceId ? 'exists' : 'created' };
  } catch (error: unknown) {
    logger.error('[Guest Pass Product] Error:', { extra: { detail: getErrorMessage(error) } });
    return { success: false, action: 'error' };
  }
}

export async function ensureDayPassCoworkingProduct(): Promise<{
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  action: 'created' | 'exists' | 'error';
}> {
  const COWORKING_SLUG = 'day-pass-coworking';
  const COWORKING_NAME = 'Day Pass - Coworking';
  const COWORKING_PRICE_CENTS = 3500;
  const COWORKING_DESCRIPTION = 'Full day workspace access';

  try {
    const stripe = await getStripeClient();
    
    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, COWORKING_SLUG))
      .limit(1);
    
    let tierId: number;
    let stripeProductId = existing[0]?.stripeProductId;
    let stripePriceId = existing[0]?.stripePriceId;
    
    if (existing.length === 0) {
      const [newTier] = await db.insert(membershipTiers).values({
        name: COWORKING_NAME,
        slug: COWORKING_SLUG,
        priceString: `$${COWORKING_PRICE_CENTS / 100}`,
        description: COWORKING_DESCRIPTION,
        buttonText: 'Purchase',
        sortOrder: 96,
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
        priceCents: COWORKING_PRICE_CENTS,
      }).returning();
      tierId = newTier.id;
      logger.info(`[Day Pass Coworking Product] Created database record: ${COWORKING_NAME}`);
    } else {
      tierId = existing[0].id;
      if (existing[0].productType !== 'one_time') {
        await db.update(membershipTiers)
          .set({ productType: 'one_time' })
          .where(eq(membershipTiers.id, tierId));
        logger.info(`[Day Pass Coworking Product] Fixed productType to one_time`);
      }
    }
    
    if (!stripeProductId) {
      const product = await stripe.products.create({
        name: COWORKING_NAME,
        description: COWORKING_DESCRIPTION,
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: COWORKING_SLUG,
          product_type: 'one_time',
          fee_type: 'day_pass_coworking',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `product_daypass_${COWORKING_SLUG}`
      });
      stripeProductId = product.id;
      logger.info(`[Day Pass Coworking Product] Created Stripe product: ${stripeProductId}`);
    }
    
    if (!stripePriceId) {
      const price = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: COWORKING_PRICE_CENTS,
        currency: 'usd',
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: COWORKING_SLUG,
          product_type: 'one_time',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `price_daypass_${COWORKING_SLUG}_${COWORKING_PRICE_CENTS}`
      });
      stripePriceId = price.id;
      logger.info(`[Day Pass Coworking Product] Created Stripe price: ${stripePriceId}`);
    }
    
    await db.update(membershipTiers)
      .set({
        stripeProductId,
        stripePriceId,
      })
      .where(eq(membershipTiers.id, tierId));
    
    logger.info(`[Day Pass Coworking Product] ${COWORKING_NAME} ready (${stripePriceId})`);
    return { success: true, stripeProductId, stripePriceId, action: existing.length > 0 && existing[0].stripePriceId ? 'exists' : 'created' };
  } catch (error: unknown) {
    logger.error('[Day Pass Coworking Product] Error:', { extra: { detail: getErrorMessage(error) } });
    return { success: false, action: 'error' };
  }
}

export async function ensureDayPassGolfSimProduct(): Promise<{
  success: boolean;
  stripeProductId?: string;
  stripePriceId?: string;
  action: 'created' | 'exists' | 'error';
}> {
  const GOLF_SIM_SLUG = 'day-pass-golf-sim';
  const GOLF_SIM_NAME = 'Day Pass - Golf Sim';
  const GOLF_SIM_PRICE_CENTS = 5000;
  const GOLF_SIM_DESCRIPTION = '60 minute golf simulator session';

  try {
    const stripe = await getStripeClient();
    
    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, GOLF_SIM_SLUG))
      .limit(1);
    
    let tierId: number;
    let stripeProductId = existing[0]?.stripeProductId;
    let stripePriceId = existing[0]?.stripePriceId;
    
    if (existing.length === 0) {
      const [newTier] = await db.insert(membershipTiers).values({
        name: GOLF_SIM_NAME,
        slug: GOLF_SIM_SLUG,
        priceString: `$${GOLF_SIM_PRICE_CENTS / 100}`,
        description: GOLF_SIM_DESCRIPTION,
        buttonText: 'Purchase',
        sortOrder: 95,
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
        priceCents: GOLF_SIM_PRICE_CENTS,
      }).returning();
      tierId = newTier.id;
      logger.info(`[Day Pass Golf Sim Product] Created database record: ${GOLF_SIM_NAME}`);
    } else {
      tierId = existing[0].id;
      if (existing[0].productType !== 'one_time') {
        await db.update(membershipTiers)
          .set({ productType: 'one_time' })
          .where(eq(membershipTiers.id, tierId));
        logger.info(`[Day Pass Golf Sim Product] Fixed productType to one_time`);
      }
    }
    
    if (!stripeProductId) {
      const product = await stripe.products.create({
        name: GOLF_SIM_NAME,
        description: GOLF_SIM_DESCRIPTION,
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: GOLF_SIM_SLUG,
          product_type: 'one_time',
          fee_type: 'day_pass_golf_sim',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `product_daypass_${GOLF_SIM_SLUG}`
      });
      stripeProductId = product.id;
      logger.info(`[Day Pass Golf Sim Product] Created Stripe product: ${stripeProductId}`);
    }
    
    if (!stripePriceId) {
      const price = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: GOLF_SIM_PRICE_CENTS,
        currency: 'usd',
        metadata: {
          tier_id: tierId.toString(),
          tier_slug: GOLF_SIM_SLUG,
          product_type: 'one_time',
          app_category: 'fee',
        },
      }, {
        idempotencyKey: `price_daypass_${GOLF_SIM_SLUG}_${GOLF_SIM_PRICE_CENTS}`
      });
      stripePriceId = price.id;
      logger.info(`[Day Pass Golf Sim Product] Created Stripe price: ${stripePriceId}`);
    }
    
    await db.update(membershipTiers)
      .set({
        stripeProductId,
        stripePriceId,
      })
      .where(eq(membershipTiers.id, tierId));
    
    logger.info(`[Day Pass Golf Sim Product] ${GOLF_SIM_NAME} ready (${stripePriceId})`);
    return { success: true, stripeProductId, stripePriceId, action: existing.length > 0 && existing[0].stripePriceId ? 'exists' : 'created' };
  } catch (error: unknown) {
    logger.error('[Day Pass Golf Sim Product] Error:', { extra: { detail: getErrorMessage(error) } });
    return { success: false, action: 'error' };
  }
}

const CORPORATE_PRICING_SLUG = 'corporate-volume-pricing';
const CORPORATE_PRICING_NAME = 'Corporate Volume Pricing';

export async function ensureCorporateVolumePricingProduct(): Promise<{
  success: boolean;
  stripeProductId?: string;
  action: 'created' | 'exists' | 'error';
}> {
  try {
    const stripe = await getStripeClient();
    
    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, CORPORATE_PRICING_SLUG))
      .limit(1);
    
    let tierId: number;
    let stripeProductId = existing[0]?.stripeProductId;
    
    if (existing.length === 0) {
      const [newTier] = await db.insert(membershipTiers).values({
        name: CORPORATE_PRICING_NAME,
        slug: CORPORATE_PRICING_SLUG,
        priceString: 'Volume',
        description: 'Corporate volume pricing configuration',
        buttonText: '',
        sortOrder: 98,
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
        productType: 'config',
        priceCents: 0,
      }).returning();
      tierId = newTier.id;
      logger.info(`[Corporate Pricing] Created database record: ${CORPORATE_PRICING_NAME}`);
    } else {
      tierId = existing[0].id;
    }
    
    if (!stripeProductId) {
      const existingProducts = await stripe.products.search({
        query: `metadata['config_type']:'corporate_volume_pricing' AND metadata['tier_slug']:'${CORPORATE_PRICING_SLUG}'`,
        limit: 1,
      });
      
      if (existingProducts.data.length > 0) {
        stripeProductId = existingProducts.data[0].id;
        await db.update(membershipTiers)
          .set({ stripeProductId })
          .where(eq(membershipTiers.id, tierId));
        logger.info(`[Corporate Pricing] Re-linked existing Stripe product: ${stripeProductId}`);
      } else {
        const tiers = getCorporateVolumeTiers();
        const basePrice = getCorporateBasePrice();
        
        const metadata: Record<string, string> = {
          tier_id: tierId.toString(),
          tier_slug: CORPORATE_PRICING_SLUG,
          product_type: 'config',
          config_type: 'corporate_volume_pricing',
          volume_base_price: basePrice.toString(),
          app_category: 'config',
        };
        
        for (const tier of tiers) {
          metadata[`volume_tier_${tier.minMembers}`] = tier.priceCents.toString();
        }
        
        const product = await stripe.products.create({
          name: CORPORATE_PRICING_NAME,
          description: 'Configuration product for corporate volume pricing tiers. Edit metadata to change pricing.',
          metadata,
        }, {
          idempotencyKey: `product_corporate_${CORPORATE_PRICING_SLUG}_${tierId}`
        });
        stripeProductId = product.id;
        
        await db.update(membershipTiers)
          .set({ stripeProductId })
          .where(eq(membershipTiers.id, tierId));
        
        logger.info(`[Corporate Pricing] Created Stripe product: ${stripeProductId}`);
      }
    }
    
    updateCorporateVolumePricing(getCorporateVolumeTiers(), getCorporateBasePrice(), stripeProductId);
    
    logger.info(`[Corporate Pricing] ${CORPORATE_PRICING_NAME} ready (${stripeProductId})`);
    return { success: true, stripeProductId, action: existing.length > 0 && existing[0].stripeProductId ? 'exists' : 'created' };
  } catch (error: unknown) {
    logger.error('[Corporate Pricing] Error:', { extra: { detail: getErrorMessage(error) } });
    return { success: false, action: 'error' };
  }
}

export async function pullCorporateVolumePricingFromStripe(): Promise<boolean> {
  try {
    const stripe = await getStripeClient();
    
    const existing = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, CORPORATE_PRICING_SLUG))
      .limit(1);
    
    if (existing.length === 0 || !existing[0].stripeProductId) {
      logger.info('[Corporate Pricing] No Stripe product linked, using defaults');
      return false;
    }
    
    const product = await stripe.products.retrieve(existing[0].stripeProductId);
    const metadata = product.metadata || {};
    
    const tiers: VolumeTier[] = [];
    const basePrice = metadata.volume_base_price ? parseInt(metadata.volume_base_price, 10) : getCorporateBasePrice();
    
    for (const [key, value] of Object.entries(metadata)) {
      const match = key.match(/^volume_tier_(\d+)$/);
      if (match) {
        const minMembers = parseInt(match[1], 10);
        const priceCents = parseInt(value, 10);
        if (!isNaN(minMembers) && !isNaN(priceCents)) {
          tiers.push({ minMembers, priceCents });
        }
      }
    }
    
    if (tiers.length > 0) {
      updateCorporateVolumePricing(tiers, basePrice, existing[0].stripeProductId);
      logger.info(`[Corporate Pricing] Pulled ${tiers.length} volume tiers from Stripe`);
      return true;
    }
    
    logger.info('[Corporate Pricing] No volume tiers found in Stripe metadata, using defaults');
    return false;
  } catch (error: unknown) {
    logger.error('[Corporate Pricing] Pull failed:', { extra: { detail: getErrorMessage(error) } });
    return false;
  }
}
