import { db } from '../db';
import { sql } from 'drizzle-orm';
import { setTierData } from '../../shared/constants/tiers';
import { setServerTierData } from '../utils/tierUtils';
import { clearTierCache } from './tierService';
import { logger } from './logger';
import { getErrorMessage } from '../utils/errorUtils';

interface TierRow {
  name: string;
  slug: string;
  sort_order: number | null;
  tier_type: string | null;
  product_type: string | null;
}

let registryLoaded = false;

export async function loadTierRegistry(): Promise<void> {
  try {
    const result = await db.execute(
      sql`SELECT name, slug, sort_order, tier_type, product_type FROM membership_tiers WHERE is_active = true ORDER BY sort_order ASC, id ASC`
    );

    const tiers = result.rows as unknown as TierRow[];

    const membershipTiers = tiers.filter(t => t.product_type === 'subscription' || t.product_type === null);

    const names: string[] = membershipTiers.map(t => t.name);
    const hierarchy: Record<string, number> = {};
    membershipTiers.forEach((t, i) => {
      hierarchy[t.name] = t.sort_order ?? (i + 1);
    });

    setTierData(names, hierarchy);

    const slugToName: Record<string, string> = {};
    const fuzzyPatterns: { pattern: string; slug: string }[] = [];
    for (const t of membershipTiers) {
      slugToName[t.slug] = t.name;
      const nameLower = t.name.toLowerCase();
      const slugLower = t.slug.toLowerCase();
      fuzzyPatterns.push({ pattern: nameLower, slug: t.slug });
      if (slugLower !== nameLower && !slugLower.includes(' ')) {
        fuzzyPatterns.push({ pattern: slugLower, slug: t.slug });
        const withSpaces = slugLower.replace(/-/g, ' ');
        if (withSpaces !== slugLower) {
          fuzzyPatterns.push({ pattern: withSpaces, slug: t.slug });
        }
      }
    }

    const allSlugs = membershipTiers.map(t => t.slug);
    setServerTierData(allSlugs, slugToName, fuzzyPatterns);

    registryLoaded = true;
    logger.info(`[TierRegistry] Loaded ${membershipTiers.length} tiers from DB: ${names.join(', ')}`);
  } catch (error: unknown) {
    logger.error('[TierRegistry] Failed to load tier data from DB, using defaults', {
      error: getErrorMessage(error),
    });
  }
}

export async function invalidateTierRegistry(): Promise<void> {
  clearTierCache();
  await loadTierRegistry();
  logger.info('[TierRegistry] Tier registry reloaded');
}

export function isTierRegistryLoaded(): boolean {
  return registryLoaded;
}
