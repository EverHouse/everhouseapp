import { Router } from 'express';
import { PRICING, getCorporateVolumeTiers, getCorporateBasePrice, updateGuestFee, updateOverageRate } from '../core/billing/pricingConfig';
import { db } from '../db';
import { membershipTiers } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../core/logger';
import { isStaffOrAdmin } from '../core/middleware';
import { getErrorMessage } from '../utils/errorUtils';

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

async function pushFeeToStripe(slug: string, newCents: number): Promise<{ success: boolean; error?: string }> {
  try {
    const { getStripeClient } = await import('../core/stripe/client');
    const { markAppOriginated } = await import('../core/stripe/appOriginTracker');
    const stripe = await getStripeClient();

    const rows = await db.select()
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, slug))
      .limit(1);

    if (rows.length === 0 || !rows[0].stripeProductId) {
      return { success: false, error: `No Stripe product found for ${slug}` };
    }

    const row = rows[0];
    const stripeProductId = row.stripeProductId!;
    let needNewPrice = true;

    if (row.stripePriceId) {
      try {
        const existingPrice = await stripe.prices.retrieve(row.stripePriceId);
        if (existingPrice.active && existingPrice.unit_amount === newCents) {
          needNewPrice = false;
        } else if (existingPrice.active) {
          markAppOriginated(row.stripePriceId);
          await stripe.prices.update(row.stripePriceId, { active: false });
        }
      } catch {
        // price doesn't exist, create new
      }
    }

    if (needNewPrice) {
      markAppOriginated(stripeProductId);
      const newPrice = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: newCents,
        currency: 'usd',
        metadata: {
          tier_slug: slug,
          product_type: 'one_time',
          app_category: 'fee',
          source: 'ever_house_app',
        },
      });
      markAppOriginated(newPrice.id);

      await stripe.products.update(stripeProductId, { default_price: newPrice.id });

      await db.update(membershipTiers)
        .set({ stripePriceId: newPrice.id, priceCents: newCents, priceString: `$${newCents / 100}` })
        .where(eq(membershipTiers.id, row.id));

      logger.info(`[Pricing] Pushed new price ${newPrice.id} ($${newCents / 100}) to Stripe for ${slug}`);
    } else {
      await db.update(membershipTiers)
        .set({ priceCents: newCents, priceString: `$${newCents / 100}` })
        .where(eq(membershipTiers.id, row.id));
    }

    return { success: true };
  } catch (error: unknown) {
    logger.error(`[Pricing] Failed to push fee ${slug} to Stripe`, { error: getErrorMessage(error) });
    return { success: false, error: getErrorMessage(error) };
  }
}

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

    if (guestFeeCents !== undefined) updateGuestFee(guestFeeCents);
    if (overageRateCents !== undefined) updateOverageRate(overageRateCents);

    const syncErrors: string[] = [];

    if (guestFeeCents !== undefined) {
      const result = await pushFeeToStripe('guest-pass', guestFeeCents);
      if (!result.success) syncErrors.push(`Guest fee: ${result.error}`);
    }

    if (overageRateCents !== undefined) {
      const result = await pushFeeToStripe('simulator-overage-30min', overageRateCents);
      if (!result.success) syncErrors.push(`Overage rate: ${result.error}`);
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
    logger.error('Failed to update pricing', { error: error instanceof Error ? error : new Error(String(error)) });
    return res.status(500).json({ error: 'Failed to update pricing' });
  }
});

export default router;
