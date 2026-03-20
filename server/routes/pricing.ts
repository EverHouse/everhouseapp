import { Router } from 'express';
import { PRICING, getCorporateVolumeTiers, getCorporateBasePrice, updateGuestFee, updateOverageRate } from '../core/billing/pricingConfig';
import { db } from '../db';
import { membershipTiers } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../core/logger';
import { isStaffOrAdmin } from '../core/middleware';
import { getErrorMessage } from '../utils/errorUtils';
import { autoPushFeeToStripe } from '../core/stripe/autoPush';
import { logFromRequest } from '../core/auditLog';

const router = Router();

// PUBLIC ROUTE - pricing information displayed on public website
router.get('/api/pricing', async (req, res) => {
  try {
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
  } catch (_e: unknown) {
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
  } catch (_e: unknown) {
    response.dayPassPrices = {};
  }

  res.json(response);
  } catch (error: unknown) {
    logger.error('Failed to fetch pricing', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

router.put('/api/pricing', isStaffOrAdmin, async (req, res) => {
  try {
    const { guestFeeDollars, overageRatePerBlockDollars } = req.body;

    let guestFeeCents: number | undefined;
    let overageRateCents: number | undefined;

    if (guestFeeDollars !== undefined) {
      guestFeeCents = Math.round(Number(guestFeeDollars) * 100);
      if (isNaN(guestFeeCents) || guestFeeCents < 0) {
        return res.status(400).json({ error: 'Invalid guest fee amount' });
      }
    }

    if (overageRatePerBlockDollars !== undefined) {
      overageRateCents = Math.round(Number(overageRatePerBlockDollars) * 100);
      if (isNaN(overageRateCents) || overageRateCents < 0) {
        return res.status(400).json({ error: 'Invalid overage rate amount' });
      }
    }

    const syncErrors: string[] = [];

    if (guestFeeCents !== undefined) {
      const result = await autoPushFeeToStripe('guest-pass', guestFeeCents);
      if (!result.success) {
        syncErrors.push(`Guest fee: ${result.error}`);
      } else {
        updateGuestFee(guestFeeCents);
        logFromRequest(req, 'update_guest_fee', 'pricing', 'guest-pass', `$${guestFeeCents / 100}`, {});
      }
    }

    if (overageRateCents !== undefined) {
      const result = await autoPushFeeToStripe('simulator-overage-30min', overageRateCents);
      if (!result.success) {
        syncErrors.push(`Overage rate: ${result.error}`);
      } else {
        updateOverageRate(overageRateCents);
        logFromRequest(req, 'update_overage_rate', 'pricing', 'simulator-overage-30min', `$${overageRateCents / 100}`, {});
      }
    }

    const synced = syncErrors.length === 0;

    logger.info('[Pricing] Fees updated by admin', {
      extra: {
        detail: {
          guestFeeDollars: PRICING.GUEST_FEE_DOLLARS,
          overageRatePerBlockDollars: PRICING.OVERAGE_RATE_DOLLARS,
          synced,
          syncErrors: syncErrors.length > 0 ? syncErrors : undefined,
        }
      }
    });

    res.json({
      guestFeeDollars: PRICING.GUEST_FEE_DOLLARS,
      overageRatePerBlockDollars: PRICING.OVERAGE_RATE_DOLLARS,
      overageBlockMinutes: PRICING.OVERAGE_BLOCK_MINUTES,
      synced,
      syncError: syncErrors.length > 0 ? syncErrors.join('; ') : undefined,
    });
  } catch (error: unknown) {
    logger.error('Failed to update pricing', { error: getErrorMessage(error) });
    return res.status(500).json({ error: 'Failed to update pricing' });
  }
});

export default router;
