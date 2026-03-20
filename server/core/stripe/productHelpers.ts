import { membershipTiers } from '../../../shared/schema';
import Stripe from 'stripe';
import { logger } from '../logger';

export type TierRecord = typeof membershipTiers.$inferSelect;

export type StripeProductWithMarketingFeatures = Stripe.Product & {
  marketing_features?: Array<{ name: string }>;
};

export interface StripePaginationParams {
  limit: number;
  active?: boolean;
  starting_after?: string;
}

export async function findExistingStripeProduct(
  stripe: Stripe,
  productName: string,
  metadataKey?: string,
  metadataValue?: string
): Promise<Stripe.Product | null> {
  try {
    if (metadataKey && metadataValue) {
      const productsByMetadata = await stripe.products.search({
        query: `metadata['${metadataKey}']:'${metadataValue}'`,
        limit: 1,
      });
      if (productsByMetadata.data.length > 0) {
        logger.info(`[Stripe Products] Found existing product by metadata: ${productsByMetadata.data[0].id}`);
        return productsByMetadata.data[0];
      }
    }
    
    const productsByName = await stripe.products.search({
      query: `name:'${productName.replace(/'/g, "\\'")}'`,
      limit: 1,
    });
    if (productsByName.data.length > 0) {
      logger.info(`[Stripe Products] Found existing product by name "${productName}": ${productsByName.data[0].id}`);
      return productsByName.data[0];
    }
    
    return null;
  } catch (error: unknown) {
    logger.error('[Stripe Products] Error searching for existing product:', { error: error });
    return null;
  }
}

export function resolveAppCategory(productType: string | null | undefined): string {
  if (productType === 'one_time' || productType === 'fee') return 'fee';
  if (productType === 'config') return 'config';
  return 'membership';
}

export function buildPrivilegeMetadata(tier: TierRecord): Record<string, string> {
  const NON_SUBSCRIPTION_PRODUCT_TYPES = ['one_time', 'config', 'fee'];
  const isSubscription = !tier.productType || !NON_SUBSCRIPTION_PRODUCT_TYPES.includes(tier.productType);
  const resolvedProductType = isSubscription
    ? (tier.productType || 'subscription')
    : tier.productType!;
  const appCategory = resolveAppCategory(tier.productType);

  const metadata: Record<string, string> = {
    tier_id: tier.id.toString(),
    tier_slug: tier.slug,
    product_type: resolvedProductType,
    source: 'ever_house_app',
    app_category: appCategory,
  };

  if (!isSubscription) {
    if (tier.slug.includes('guest')) metadata.fee_type = 'guest_pass';
    else if (tier.slug.includes('overage')) metadata.fee_type = 'simulator_overage';
    else if (tier.slug.includes('day-pass')) metadata.fee_type = 'day_pass';
    else metadata.fee_type = 'general';
    return metadata;
  }

  if (tier.dailySimMinutes != null) {
    metadata.privilege_daily_sim_minutes = tier.dailySimMinutes.toString();
  }
  if (tier.guestPassesPerYear != null) {
    metadata.privilege_guest_passes = tier.guestPassesPerYear.toString();
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
  
  if (tier.highlightedFeatures && Array.isArray(tier.highlightedFeatures) && tier.highlightedFeatures.length > 0) {
    const featuresJson = JSON.stringify(tier.highlightedFeatures.slice(0, 5));
    if (featuresJson.length <= 500) {
      metadata.highlighted_features = featuresJson;
    }
  }
  
  return metadata;
}

export function buildFeatureKeysForTier(tier: TierRecord): Array<{ lookupKey: string; name: string; metadata?: Record<string, string> }> {
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
    if (tier[field as keyof typeof tier]) {
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

  const guestPasses = tier.guestPassesPerYear ?? 0;
  if (guestPasses > 0) {
    if (guestPasses >= 900) {
      features.push({ lookupKey: 'guest_passes_unlimited', name: 'Guest Passes: Unlimited/year', metadata: { type: 'guest_passes_per_year', value: 'unlimited', unit: 'passes' } });
    } else if (guestPasses === 4) {
      features.push({ lookupKey: 'guest_passes_4', name: 'Guest Passes: 4/year' });
    } else if (guestPasses === 8) {
      features.push({ lookupKey: 'guest_passes_8', name: 'Guest Passes: 8/year' });
    } else if (guestPasses === 15) {
      features.push({ lookupKey: 'guest_passes_15', name: 'Guest Passes: 15/year' });
    } else {
      features.push({ lookupKey: `guest_passes_${guestPasses}`, name: `Guest Passes: ${guestPasses}/year`, metadata: { type: 'guest_passes_per_year', value: guestPasses.toString(), unit: 'passes' } });
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
