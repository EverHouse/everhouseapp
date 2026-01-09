import { getBaseTier, type BaseTier, DEFAULT_TIER } from './permissions';
import { normalizeTierName, extractTierTags } from '../../shared/constants/tiers';

export type { BaseTier };

export interface TierColor {
  bg: string;
  text: string;
  border: string;
}

export const TIER_COLORS: Record<BaseTier, TierColor> = {
  VIP: { bg: '#E5E4E2', text: '#374151', border: '#C0C0C0' },
  Premium: { bg: '#D4AF37', text: '#1a1a1a', border: '#B8960C' },
  Corporate: { bg: '#374151', text: '#FFFFFF', border: '#4B5563' },
  Core: { bg: '#293515', text: '#FFFFFF', border: '#3d4f20' },
  Social: { bg: '#CCB8E4', text: '#293515', border: '#B8A0D4' },
};

export const TAG_COLORS: Record<string, TierColor> = {
  'Founding Member': { bg: '#FEF3C7', text: '#92400E', border: '#FCD34D' },
  'Investor': { bg: '#DBEAFE', text: '#1E40AF', border: '#93C5FD' },
  'Referral': { bg: '#D1FAE5', text: '#065F46', border: '#6EE7B7' },
  default: { bg: '#F3F4F6', text: '#374151', border: '#D1D5DB' },
};

export const AVAILABLE_TAGS = ['Founding Member', 'Investor', 'Referral'];

export function parseTierString(tierString: string): { tier: BaseTier; tags: string[] } {
  return { 
    tier: normalizeTierName(tierString), 
    tags: extractTierTags(tierString) 
  };
}

export function getTierColor(tier: string): TierColor {
  const { tier: baseTier } = parseTierString(tier);
  return TIER_COLORS[baseTier] || TIER_COLORS.Social;
}

export function getTagColor(tag: string): TierColor {
  return TAG_COLORS[tag] || TAG_COLORS.default;
}

export function getDisplayTier(tierString: string): BaseTier {
  const { tier } = parseTierString(tierString);
  return tier;
}
