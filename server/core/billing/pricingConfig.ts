import { logger } from '../logger';
/**
 * Centralized pricing configuration - THE ONLY source of truth for fees
 * 
 * All fee calculations MUST import from this file.
 * NEVER hardcode $25 or 2500 cents anywhere else.
 */

let _overageRateCents = 2500;
let _guestFeeCents = 2500;

export const PRICING = {
  get OVERAGE_RATE_DOLLARS() { return _overageRateCents / 100; },
  get OVERAGE_RATE_CENTS() { return _overageRateCents; },
  OVERAGE_BLOCK_MINUTES: 30,
  get GUEST_FEE_DOLLARS() { return _guestFeeCents / 100; },
  get GUEST_FEE_CENTS() { return _guestFeeCents; },
};

export function updateOverageRate(cents: number): void {
  _overageRateCents = cents;
  logger.info('[PricingConfig] Overage rate updated from Stripe:', { extra: { detail: { cents, dollars: cents / 100 } } });
}

export function updateGuestFee(cents: number): void {
  _guestFeeCents = cents;
  logger.info('[PricingConfig] Guest fee updated from Stripe:', { extra: { detail: { cents, dollars: cents / 100 } } });
}

export function getOverageRateCents(): number {
  return _overageRateCents;
}

export function getGuestFeeCents(): number {
  return _guestFeeCents;
}

export function calculateOverageCents(overageMinutes: number): number {
  return Math.ceil(overageMinutes / PRICING.OVERAGE_BLOCK_MINUTES) * PRICING.OVERAGE_RATE_CENTS;
}

export function calculateOverageDollars(overageMinutes: number): number {
  return Math.ceil(overageMinutes / PRICING.OVERAGE_BLOCK_MINUTES) * PRICING.OVERAGE_RATE_DOLLARS;
}

export interface VolumeTier {
  minMembers: number;
  priceCents: number;
}

const DEFAULT_CORPORATE_VOLUME_TIERS: VolumeTier[] = [
  { minMembers: 50, priceCents: 24900 },
  { minMembers: 20, priceCents: 27500 },
  { minMembers: 10, priceCents: 29900 },
  { minMembers: 5, priceCents: 32500 },
];

const DEFAULT_CORPORATE_BASE_PRICE = 35000;
const DEFAULT_FAMILY_DISCOUNT_PERCENT = 20;

let _corporateVolumeTiers: VolumeTier[] = [...DEFAULT_CORPORATE_VOLUME_TIERS];
let _corporateBasePrice: number = DEFAULT_CORPORATE_BASE_PRICE;
let _familyDiscountPercent: number = DEFAULT_FAMILY_DISCOUNT_PERCENT;
let _corporatePricingProductId: string | null = null;

export function getCorporateVolumeTiers(): VolumeTier[] {
  return _corporateVolumeTiers;
}

export function getCorporateBasePrice(): number {
  return _corporateBasePrice;
}

export function getFamilyDiscountPercent(): number {
  return _familyDiscountPercent;
}

export function getCorporatePricingProductId(): string | null {
  return _corporatePricingProductId;
}

export function updateCorporateVolumePricing(tiers: VolumeTier[], basePrice: number, stripeProductId?: string): void {
  _corporateVolumeTiers = tiers.sort((a, b) => b.minMembers - a.minMembers);
  _corporateBasePrice = basePrice;
  if (stripeProductId) _corporatePricingProductId = stripeProductId;
  logger.info('[PricingConfig] Corporate volume pricing updated from Stripe:', { extra: { detail: { tiers: _corporateVolumeTiers, basePrice: _corporateBasePrice } } });
}

export function updateFamilyDiscountPercent(percent: number): void {
  _familyDiscountPercent = percent;
  logger.info('[PricingConfig] Family discount updated from Stripe:', { extra: { detail: { percent } } });
}
