import { 
  normalizeTierName, 
  TierName,
  DEFAULT_TIER,
  TIER_NAMES 
} from '../../shared/constants/tiers';

export type BaseTier = TierName;

export function getBaseTier(tierName: string): BaseTier {
  return normalizeTierName(tierName);
}

export function isFoundingMember(_tierName: string, isFounding?: boolean): boolean {
  return isFounding === true;
}

export function isVIPMember(tierName: string): boolean {
  if (!tierName) return false;
  return normalizeTierName(tierName) === 'VIP';
}

export function getDisplayTierName(tierName: string): string {
  return normalizeTierName(tierName);
}

export type MembershipTier = BaseTier;

export { DEFAULT_TIER, TIER_NAMES };
