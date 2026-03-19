import { type BaseTier } from './permissions';
import { normalizeTierName } from '../../shared/constants/tiers';

export type { BaseTier };

export interface TierColor {
  bg: string;
  text: string;
  border: string;
}

export const VISITOR_COLORS: TierColor = { bg: '#EFF6FF', text: '#2563EB', border: '#BFDBFE' };

export const TIER_COLORS: Record<BaseTier, TierColor> = {
  VIP: { bg: '#E5E4E2', text: '#374151', border: '#C0C0C0' },
  Premium: { bg: '#D4AF37', text: '#1a1a1a', border: '#B8960C' },
  Corporate: { bg: '#374151', text: '#FFFFFF', border: '#4B5563' },
  Core: { bg: '#293515', text: '#FFFFFF', border: '#3d4f20' },
  Social: { bg: '#CCB8E4', text: '#293515', border: '#B8A0D4' },
};

export function parseTierString(tierString: string): { tier: BaseTier | null; tags: string[] } {
  return { 
    tier: normalizeTierName(tierString), 
    tags: [] 
  };
}

export function getTierColor(tier: string | null | undefined): TierColor {
  if (!tier) return VISITOR_COLORS;
  const { tier: baseTier } = parseTierString(tier);
  return (baseTier && TIER_COLORS[baseTier]) || VISITOR_COLORS;
}

export function getDisplayTier(tierString: string): BaseTier | null {
  const { tier } = parseTierString(tierString);
  return tier;
}
