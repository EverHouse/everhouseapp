import { describe, it, expect } from 'vitest';
import {
  normalizeTierName,
  compareTiers,
  isTierAtLeast,
  TIER_NAMES,
  TIER_HIERARCHY,
  DEFAULT_TIER
} from '../../shared/constants/tiers';

describe('Tier Utilities - Production Code Tests', () => {
  
  describe('normalizeTierName', () => {
    it('should normalize valid tier names case-insensitively', () => {
      expect(normalizeTierName('PREMIUM')).toBe('Premium');
      expect(normalizeTierName('premium')).toBe('Premium');
      expect(normalizeTierName('Premium')).toBe('Premium');
    });
    
    it('should extract tier from compound strings', () => {
      expect(normalizeTierName('Founding Premium')).toBe('Premium');
      expect(normalizeTierName('VIP Member')).toBe('VIP');
      expect(normalizeTierName('Corporate Annual')).toBe('Corporate');
    });
    
    it('should return default tier for invalid input', () => {
      expect(normalizeTierName(null)).toBe(DEFAULT_TIER);
      expect(normalizeTierName(undefined)).toBe(DEFAULT_TIER);
      expect(normalizeTierName('')).toBe(DEFAULT_TIER);
      expect(normalizeTierName('invalid')).toBe(DEFAULT_TIER);
    });
    
    it('should handle all defined tier names', () => {
      TIER_NAMES.forEach(tier => {
        expect(normalizeTierName(tier.toLowerCase())).toBe(tier);
      });
    });
  });
  
  describe('compareTiers', () => {
    it('should return negative when first tier is lower', () => {
      expect(compareTiers('Social', 'Premium')).toBeLessThan(0);
      expect(compareTiers('Core', 'VIP')).toBeLessThan(0);
    });
    
    it('should return positive when first tier is higher', () => {
      expect(compareTiers('VIP', 'Social')).toBeGreaterThan(0);
      expect(compareTiers('Premium', 'Core')).toBeGreaterThan(0);
    });
    
    it('should return zero for equal tiers', () => {
      expect(compareTiers('Premium', 'Premium')).toBe(0);
    });
  });
  
  describe('isTierAtLeast', () => {
    it('should return true when tier meets requirement', () => {
      expect(isTierAtLeast('VIP', 'Premium')).toBe(true);
      expect(isTierAtLeast('Premium', 'Premium')).toBe(true);
      expect(isTierAtLeast('Corporate', 'Core')).toBe(true);
    });
    
    it('should return false when tier is below requirement', () => {
      expect(isTierAtLeast('Social', 'Premium')).toBe(false);
      expect(isTierAtLeast('Core', 'VIP')).toBe(false);
    });
  });
  
  describe('TIER_HIERARCHY', () => {
    it('should have VIP as highest tier', () => {
      const maxValue = Math.max(...Object.values(TIER_HIERARCHY));
      expect(TIER_HIERARCHY['VIP']).toBe(maxValue);
    });
    
    it('should have Social as lowest tier', () => {
      const minValue = Math.min(...Object.values(TIER_HIERARCHY));
      expect(TIER_HIERARCHY['Social']).toBe(minValue);
    });
    
    it('should have all TIER_NAMES represented', () => {
      TIER_NAMES.forEach(tier => {
        expect(TIER_HIERARCHY[tier]).toBeDefined();
        expect(typeof TIER_HIERARCHY[tier]).toBe('number');
      });
    });
  });
});
