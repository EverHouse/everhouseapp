import { logger } from '../core/logger';

const DEFAULT_TIER_SLUGS = ['social', 'core', 'premium', 'corporate', 'vip', 'staff', 'group-lessons'];
const DEFAULT_CANONICAL_NAMES: Record<string, string> = {
  social: 'Social',
  core: 'Core',
  premium: 'Premium',
  corporate: 'Corporate',
  vip: 'VIP',
  staff: 'Staff',
  'group-lessons': 'Group Lessons',
};
const DEFAULT_FUZZY_PATTERNS: { pattern: string; slug: string }[] = [
  { pattern: 'vip', slug: 'vip' },
  { pattern: 'premium', slug: 'premium' },
  { pattern: 'corporate', slug: 'corporate' },
  { pattern: 'core', slug: 'core' },
  { pattern: 'social', slug: 'social' },
  { pattern: 'staff', slug: 'staff' },
  { pattern: 'group lesson', slug: 'group-lessons' },
  { pattern: 'group-lesson', slug: 'group-lessons' },
];

let _tierSlugs: string[] = [...DEFAULT_TIER_SLUGS];
let _canonicalTierNames: Record<string, string> = { ...DEFAULT_CANONICAL_NAMES };
let _fuzzyTierPatterns: { pattern: string; slug: string }[] = [...DEFAULT_FUZZY_PATTERNS];

export type TierSlug = string;

export const TIER_SLUGS: string[] = _tierSlugs;
export const CANONICAL_TIER_NAMES: Record<string, string> = _canonicalTierNames;

export function setServerTierData(
  slugs: string[],
  slugToName: Record<string, string>,
  fuzzyPatterns: { pattern: string; slug: string }[]
): void {
  const mergedSlugs = new Set([...slugs]);
  for (const s of DEFAULT_TIER_SLUGS) {
    mergedSlugs.add(s);
  }
  _tierSlugs.length = 0;
  _tierSlugs.push(...mergedSlugs);

  for (const key of Object.keys(_canonicalTierNames)) {
    if (!(key in DEFAULT_CANONICAL_NAMES) && !(key in slugToName)) {
      delete _canonicalTierNames[key];
    }
  }
  Object.assign(_canonicalTierNames, DEFAULT_CANONICAL_NAMES, slugToName);

  _fuzzyTierPatterns.length = 0;
  const seenPatterns = new Set<string>();
  for (const p of fuzzyPatterns) {
    if (!seenPatterns.has(p.pattern)) {
      _fuzzyTierPatterns.push(p);
      seenPatterns.add(p.pattern);
    }
  }
  for (const p of DEFAULT_FUZZY_PATTERNS) {
    if (!seenPatterns.has(p.pattern)) {
      _fuzzyTierPatterns.push(p);
      seenPatterns.add(p.pattern);
    }
  }
}

export function normalizeTierSlug(rawName: string | null | undefined): string | null {
  if (!rawName || typeof rawName !== 'string') {
    logger.warn('[normalizeTierSlug] Empty or invalid tier name, returning null', { rawName });
    return null;
  }

  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    logger.warn('[normalizeTierSlug] Empty tier name after trim, returning null');
    return null;
  }

  const lowered = trimmed.toLowerCase();

  for (const slug of _tierSlugs) {
    if (lowered === slug) {
      return slug;
    }
  }

  for (const [slug, canonicalName] of Object.entries(_canonicalTierNames)) {
    if (lowered === canonicalName.toLowerCase()) {
      return slug;
    }
  }

  for (const { pattern, slug } of _fuzzyTierPatterns) {
    if (lowered.includes(pattern)) {
      logger.warn('[normalizeTierSlug] Fuzzy match used for tier normalization', {
        rawName,
        matchedPattern: pattern,
        normalizedSlug: slug,
      });
      return slug;
    }
  }

  logger.error('[normalizeTierSlug] No tier match found, returning null', { rawName });
  return null;
}

export function normalizeTierName(rawName: string | null | undefined): string | null {
  const slug = normalizeTierSlug(rawName);
  return slug ? (_canonicalTierNames[slug] ?? null) : null;
}

export function isSocialTier(tierName: string | null | undefined): boolean {
  return normalizeTierSlug(tierName) === 'social';
}

export function isStaffTier(tierName: string | null | undefined): boolean {
  return normalizeTierSlug(tierName) === 'staff';
}

function tryNormalizeTierSlug(rawName: string): string | null {
  const trimmed = rawName.trim();
  if (trimmed.length === 0) return null;

  const lowered = trimmed.toLowerCase();

  for (const slug of _tierSlugs) {
    if (lowered === slug) return slug;
  }

  for (const [slug, canonicalName] of Object.entries(_canonicalTierNames)) {
    if (lowered === canonicalName.toLowerCase()) {
      return slug;
    }
  }

  for (const { pattern, slug } of _fuzzyTierPatterns) {
    if (lowered.includes(pattern)) {
      return slug;
    }
  }

  return null;
}

export function denormalizeTierForHubSpot(rawName: string | null | undefined): string | null {
  if (!rawName || typeof rawName !== 'string') {
    return null;
  }

  const slug = tryNormalizeTierSlug(rawName);
  
  if (!slug || slug === 'staff') {
    return null;
  }
  
  const baseName = _canonicalTierNames[slug];
  if (!baseName) return null;
  return `${baseName} Membership`;
}

export async function denormalizeTierForHubSpotAsync(rawName: string | null | undefined): Promise<string | null> {
  if (!rawName || typeof rawName !== 'string') {
    return null;
  }

  const slug = tryNormalizeTierSlug(rawName);

  if (!slug || slug === 'staff') {
    return null;
  }

  const { getSettingValue } = await import('../core/settingsHelper');
  const baseName = _canonicalTierNames[slug] ?? slug;
  const defaultTier = `${baseName} Membership`;
  return getSettingValue(`hubspot.tier.${slug}`, defaultTier);
}
