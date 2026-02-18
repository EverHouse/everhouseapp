import { Router } from 'express';
import { PRICING, getCorporateVolumeTiers, getCorporateBasePrice } from '../core/billing/pricingConfig';
import { db } from '../db';
import { membershipTiers } from '../../shared/schema';
import { eq } from 'drizzle-orm';

const router = Router();

router.get('/api/pricing', async (req, res) => {
  const response: Record<string, unknown> = {
    guestFeeDollars: PRICING.GUEST_FEE_DOLLARS,
    overageRatePerBlockDollars: PRICING.OVERAGE_RATE_DOLLARS,
    overageBlockMinutes: PRICING.OVERAGE_BLOCK_MINUTES,
  };

  const volumeTiers = getCorporateVolumeTiers();
  const basePrice = getCorporateBasePrice();
  response.corporatePricing = {
    basePriceDollars: basePrice / 100,
    tiers: volumeTiers.map(t => ({
      minMembers: t.minMembers,
      priceDollars: t.priceCents / 100,
    })),
  };

  try {
    const subscriptionTiers = await db.select({
      name: membershipTiers.name,
      dailySimMinutes: membershipTiers.dailySimMinutes,
    })
      .from(membershipTiers)
      .where(eq(membershipTiers.productType, 'subscription'));

    const tierMinutes: Record<string, number> = {};
    for (const t of subscriptionTiers) {
      if (t.name) {
        tierMinutes[t.name.toLowerCase()] = t.dailySimMinutes ?? 0;
      }
    }
    response.tierMinutes = tierMinutes;
  } catch (e: unknown) {
    response.tierMinutes = {};
  }

  try {
    const dayPassProducts = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.productType, 'one_time'));

    const dayPasses: Record<string, number> = {};
    for (const p of dayPassProducts) {
      if (p.isActive && p.priceCents && p.priceCents > 0 && p.slug) {
        dayPasses[p.slug] = p.priceCents / 100;
      }
    }
    response.dayPassPrices = dayPasses;
  } catch (e: unknown) {
    response.dayPassPrices = {};
  }

  res.json(response);
});

export default router;
