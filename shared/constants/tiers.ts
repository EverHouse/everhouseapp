export const TIER_NAMES = ['Social', 'Core', 'Premium', 'Corporate', 'VIP'] as const;
export type TierName = typeof TIER_NAMES[number];

export const DEFAULT_TIER: TierName = 'Social';

export const TIER_HIERARCHY: Record<TierName, number> = {
  'Social': 1,
  'Core': 2,
  'Premium': 3,
  'Corporate': 4,
  'VIP': 5,
};

export function normalizeTierName(tierString: string | null | undefined): TierName | null {
  if (!tierString || typeof tierString !== 'string') {
    return null;
  }

  const normalized = tierString.trim().toLowerCase();
  
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.includes('vip')) {
    return 'VIP';
  }
  if (normalized.includes('corporate')) {
    return 'Corporate';
  }
  if (normalized.includes('premium')) {
    return 'Premium';
  }
  if (normalized.includes('core')) {
    return 'Core';
  }
  if (normalized.includes('social')) {
    return 'Social';
  }

  console.warn(`[normalizeTierName] Unrecognized tier "${tierString}", returning null. If this is a new tier, add it to shared/constants/tiers.ts`);
  return null;
}

export function compareTiers(tier1: TierName, tier2: TierName): number {
  return TIER_HIERARCHY[tier1] - TIER_HIERARCHY[tier2];
}

export function isTierAtLeast(userTier: TierName, requiredTier: TierName): boolean {
  return TIER_HIERARCHY[userTier] >= TIER_HIERARCHY[requiredTier];
}
