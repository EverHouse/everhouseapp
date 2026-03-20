export type TierName = string;

const DEFAULT_TIER_NAMES = ['Social', 'Core', 'Premium', 'Corporate', 'VIP'] as const;
const DEFAULT_TIER_HIERARCHY: Record<string, number> = {
  'Social': 1,
  'Core': 2,
  'Premium': 3,
  'Corporate': 4,
  'VIP': 5,
};

let _tierNames: string[] = [...DEFAULT_TIER_NAMES];
let _tierHierarchy: Record<string, number> = { ...DEFAULT_TIER_HIERARCHY };

export const TIER_NAMES: string[] = _tierNames;

export const DEFAULT_TIER: string = 'Social';

export const TIER_HIERARCHY: Record<string, number> = _tierHierarchy;

export function setTierData(names: string[], hierarchy: Record<string, number>): void {
  _tierNames.length = 0;
  _tierNames.push(...names);
  for (const key of Object.keys(_tierHierarchy)) {
    delete _tierHierarchy[key];
  }
  Object.assign(_tierHierarchy, hierarchy);
}

export function normalizeTierName(tierString: string | null | undefined): string | null {
  if (!tierString || typeof tierString !== 'string') {
    return null;
  }

  const normalized = tierString.trim();
  if (normalized.length === 0) {
    return null;
  }

  for (const name of _tierNames) {
    if (name.toLowerCase() === normalized.toLowerCase()) {
      return name;
    }
  }

  const lowered = normalized.toLowerCase();
  const reversedNames = [..._tierNames].reverse();
  for (const name of reversedNames) {
    if (lowered.includes(name.toLowerCase())) {
      return name;
    }
  }

  return null;
}

export function compareTiers(tier1: string, tier2: string): number {
  return (_tierHierarchy[tier1] ?? 0) - (_tierHierarchy[tier2] ?? 0);
}

export function isTierAtLeast(userTier: string, requiredTier: string): boolean {
  return (_tierHierarchy[userTier] ?? 0) >= (_tierHierarchy[requiredTier] ?? 0);
}

export function isValidTierName(tier: string): boolean {
  return _tierNames.some(t => t.toLowerCase() === tier.toLowerCase());
}

export function getValidTierNames(): readonly string[] {
  return _tierNames;
}
