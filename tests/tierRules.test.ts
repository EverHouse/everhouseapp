// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  normalizeTierName,
  compareTiers,
  isTierAtLeast,
  TIER_HIERARCHY,
  TIER_NAMES,
  DEFAULT_TIER,
} from '../shared/constants/tiers';

describe('Tier Constants', () => {
  it('defines five tiers', () => {
    expect(TIER_NAMES).toEqual(['Social', 'Core', 'Premium', 'Corporate', 'VIP']);
  });

  it('defaults to Social', () => {
    expect(DEFAULT_TIER).toBe('Social');
  });

  it('has ascending hierarchy values', () => {
    expect(TIER_HIERARCHY['Social']).toBeLessThan(TIER_HIERARCHY['Core']);
    expect(TIER_HIERARCHY['Core']).toBeLessThan(TIER_HIERARCHY['Premium']);
    expect(TIER_HIERARCHY['Premium']).toBeLessThan(TIER_HIERARCHY['Corporate']);
    expect(TIER_HIERARCHY['Corporate']).toBeLessThan(TIER_HIERARCHY['VIP']);
  });
});

describe('normalizeTierName', () => {
  it('returns null for null', () => {
    expect(normalizeTierName(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeTierName(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeTierName('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeTierName('   ')).toBeNull();
  });

  it('normalizes "vip" to VIP', () => {
    expect(normalizeTierName('vip')).toBe('VIP');
  });

  it('normalizes "VIP" to VIP', () => {
    expect(normalizeTierName('VIP')).toBe('VIP');
  });

  it('normalizes "corporate" to Corporate', () => {
    expect(normalizeTierName('corporate')).toBe('Corporate');
  });

  it('normalizes "PREMIUM" to Premium', () => {
    expect(normalizeTierName('PREMIUM')).toBe('Premium');
  });

  it('normalizes "core" to Core', () => {
    expect(normalizeTierName('core')).toBe('Core');
  });

  it('normalizes "social" to Social', () => {
    expect(normalizeTierName('social')).toBe('Social');
  });

  it('normalizes strings containing tier name like "VIP Membership"', () => {
    expect(normalizeTierName('VIP Membership')).toBe('VIP');
  });

  it('normalizes strings containing tier name like "Corporate Plan"', () => {
    expect(normalizeTierName('Corporate Plan')).toBe('Corporate');
  });

  it('returns null for unrecognized string', () => {
    expect(normalizeTierName('unknown_tier')).toBeNull();
  });

  it('handles non-string types gracefully', () => {
    expect(normalizeTierName(42 as unknown as string)).toBeNull();
  });

  it('handles leading/trailing whitespace', () => {
    expect(normalizeTierName('  Premium  ')).toBe('Premium');
  });

  it('prioritizes VIP over other matches', () => {
    expect(normalizeTierName('vip-corporate')).toBe('VIP');
  });
});

describe('compareTiers', () => {
  it('returns 0 for same tiers', () => {
    expect(compareTiers('Core', 'Core')).toBe(0);
  });

  it('returns negative when first tier is lower', () => {
    expect(compareTiers('Social', 'VIP')).toBeLessThan(0);
  });

  it('returns positive when first tier is higher', () => {
    expect(compareTiers('VIP', 'Social')).toBeGreaterThan(0);
  });

  it('correctly compares adjacent tiers', () => {
    expect(compareTiers('Core', 'Premium')).toBeLessThan(0);
    expect(compareTiers('Premium', 'Core')).toBeGreaterThan(0);
  });
});

describe('isTierAtLeast', () => {
  it('returns true when tiers are equal', () => {
    expect(isTierAtLeast('Premium', 'Premium')).toBe(true);
  });

  it('returns true when user tier is higher', () => {
    expect(isTierAtLeast('VIP', 'Core')).toBe(true);
  });

  it('returns false when user tier is lower', () => {
    expect(isTierAtLeast('Social', 'Premium')).toBe(false);
  });

  it('Social meets Social requirement', () => {
    expect(isTierAtLeast('Social', 'Social')).toBe(true);
  });

  it('VIP meets all requirements', () => {
    for (const tier of TIER_NAMES) {
      expect(isTierAtLeast('VIP', tier)).toBe(true);
    }
  });

  it('Social only meets Social requirement', () => {
    expect(isTierAtLeast('Social', 'Social')).toBe(true);
    expect(isTierAtLeast('Social', 'Core')).toBe(false);
    expect(isTierAtLeast('Social', 'Premium')).toBe(false);
    expect(isTierAtLeast('Social', 'Corporate')).toBe(false);
    expect(isTierAtLeast('Social', 'VIP')).toBe(false);
  });
});
