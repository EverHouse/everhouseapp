import { 
  normalizeTierName, 
  TierName,
  DEFAULT_TIER,
  TIER_NAMES 
} from '../../shared/constants/tiers';

export type BaseTier = TierName;

export function getBaseTier(tierName: string): BaseTier | null {
  return normalizeTierName(tierName);
}

export function isVIPMember(tierName: string): boolean {
  if (!tierName) return false;
  return normalizeTierName(tierName) === 'VIP';
}

export function getDisplayTierName(tierName: string): string {
  return normalizeTierName(tierName) || tierName || '';
}

export type MembershipTier = BaseTier;

export { DEFAULT_TIER, TIER_NAMES };
