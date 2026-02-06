import { getStripeClient } from '../server/core/stripe/client';
import Stripe from 'stripe';

interface FeatureDefinition {
  name: string;
  lookupKey: string;
}

interface TierFeatureMapping {
  productId: string;
  tierName: string;
  featureLookupKeys: string[];
}

const FEATURES: FeatureDefinition[] = [
  { name: 'Can Book Simulators', lookupKey: 'can_book_simulators' },
  { name: 'Can Book Conference Room', lookupKey: 'can_book_conference' },
  { name: 'Can Book Wellness', lookupKey: 'can_book_wellness' },
  { name: 'Has Group Lessons', lookupKey: 'has_group_lessons' },
  { name: 'Has Extended Sessions', lookupKey: 'has_extended_sessions' },
  { name: 'Has Private Lessons', lookupKey: 'has_private_lesson' },
  { name: 'Has Simulator Guest Passes', lookupKey: 'has_simulator_guest_passes' },
  { name: 'Has Discounted Merch', lookupKey: 'has_discounted_merch' },
  { name: 'Unlimited Access', lookupKey: 'unlimited_access' },
  { name: 'Daily Sim Minutes: 60', lookupKey: 'daily_sim_minutes_60' },
  { name: 'Daily Sim Minutes: 90', lookupKey: 'daily_sim_minutes_90' },
  { name: 'Daily Sim Minutes: Unlimited', lookupKey: 'daily_sim_minutes_unlimited' },
  { name: 'Guest Passes: 4/month', lookupKey: 'guest_passes_4' },
  { name: 'Guest Passes: 8/month', lookupKey: 'guest_passes_8' },
  { name: 'Guest Passes: 15/month', lookupKey: 'guest_passes_15' },
  { name: 'Guest Passes: Unlimited', lookupKey: 'guest_passes_unlimited' },
  { name: 'Booking Window: 7 days', lookupKey: 'booking_window_7' },
  { name: 'Booking Window: 10 days', lookupKey: 'booking_window_10' },
  { name: 'Booking Window: 14 days', lookupKey: 'booking_window_14' },
  { name: 'Conference Room: 60 min/day', lookupKey: 'conf_room_minutes_60' },
  { name: 'Conference Room: 90 min/day', lookupKey: 'conf_room_minutes_90' },
  { name: 'Conference Room: Unlimited', lookupKey: 'conf_room_minutes_unlimited' },
];

const TIER_MAPPINGS: TierFeatureMapping[] = [
  {
    productId: 'prod_TvPigbHawx68zE',
    tierName: 'Social',
    featureLookupKeys: [
      'can_book_simulators',
      'can_book_conference',
      'can_book_wellness',
      'booking_window_7',
      'conf_room_minutes_60',
    ],
  },
  {
    productId: 'prod_TvPiNr4wsw66lm',
    tierName: 'Core',
    featureLookupKeys: [
      'can_book_simulators',
      'can_book_conference',
      'can_book_wellness',
      'daily_sim_minutes_60',
      'guest_passes_4',
      'booking_window_7',
      'conf_room_minutes_60',
    ],
  },
  {
    productId: 'prod_TvPi5o6JPjLPff',
    tierName: 'Premium',
    featureLookupKeys: [
      'can_book_simulators',
      'can_book_conference',
      'can_book_wellness',
      'has_group_lessons',
      'has_extended_sessions',
      'has_private_lesson',
      'has_simulator_guest_passes',
      'has_discounted_merch',
      'daily_sim_minutes_90',
      'guest_passes_8',
      'booking_window_10',
      'conf_room_minutes_90',
    ],
  },
  {
    productId: 'prod_TvPiEbUVjwJ0sk',
    tierName: 'Corporate',
    featureLookupKeys: [
      'can_book_simulators',
      'can_book_conference',
      'can_book_wellness',
      'daily_sim_minutes_90',
      'guest_passes_15',
      'booking_window_10',
      'conf_room_minutes_90',
    ],
  },
  {
    productId: 'prod_TvPi24vIgsrWbN',
    tierName: 'VIP',
    featureLookupKeys: [
      'can_book_simulators',
      'can_book_conference',
      'can_book_wellness',
      'has_group_lessons',
      'has_extended_sessions',
      'has_private_lesson',
      'has_simulator_guest_passes',
      'has_discounted_merch',
      'unlimited_access',
      'daily_sim_minutes_unlimited',
      'guest_passes_unlimited',
      'booking_window_14',
      'conf_room_minutes_unlimited',
    ],
  },
  {
    productId: 'prod_TvPid8Ks9dtQ0M',
    tierName: 'Base',
    featureLookupKeys: [
      'can_book_simulators',
      'can_book_conference',
      'can_book_wellness',
      'has_simulator_guest_passes',
      'booking_window_7',
      'conf_room_minutes_60',
    ],
  },
];

async function main() {
  console.log('=== Stripe Features Setup ===\n');

  const stripe = await getStripeClient();

  const existingFeatures = await stripe.entitlements.features.list({ limit: 100 });
  const existingByKey = new Map<string, Stripe.Entitlements.Feature>();
  for (const f of existingFeatures.data) {
    existingByKey.set(f.lookup_key, f);
  }
  console.log(`Found ${existingByKey.size} existing features in Stripe\n`);

  const featureIdByKey = new Map<string, string>();

  console.log('--- Creating Features ---');
  for (const def of FEATURES) {
    const existing = existingByKey.get(def.lookupKey);
    if (existing) {
      console.log(`  [skip] "${def.name}" (${def.lookupKey}) already exists: ${existing.id}`);
      featureIdByKey.set(def.lookupKey, existing.id);
    } else {
      const feature = await stripe.entitlements.features.create({
        name: def.name,
        lookup_key: def.lookupKey,
      });
      console.log(`  [created] "${def.name}" (${def.lookupKey}): ${feature.id}`);
      featureIdByKey.set(def.lookupKey, feature.id);
    }
  }

  console.log(`\nTotal features: ${featureIdByKey.size}\n`);

  console.log('--- Attaching Features to Products ---');
  for (const tier of TIER_MAPPINGS) {
    console.log(`\n  ${tier.tierName} (${tier.productId}):`);

    const existingProductFeatures = await stripe.products.listFeatures(tier.productId, { limit: 100 });
    const alreadyAttached = new Set<string>();
    for (const pf of existingProductFeatures.data) {
      if (pf.entitlement_feature) {
        alreadyAttached.add(pf.entitlement_feature.id);
      }
    }

    for (const lookupKey of tier.featureLookupKeys) {
      const featureId = featureIdByKey.get(lookupKey);
      if (!featureId) {
        console.log(`    [error] Feature "${lookupKey}" not found`);
        continue;
      }

      if (alreadyAttached.has(featureId)) {
        console.log(`    [skip] "${lookupKey}" already attached`);
      } else {
        await stripe.products.createFeature(tier.productId, {
          entitlement_feature: featureId,
        });
        console.log(`    [attached] "${lookupKey}"`);
      }
    }
  }

  console.log('\n=== Setup Complete ===');
  console.log('Go to your Stripe dashboard > Product Catalog > Features tab to see everything.');
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
