import { useQuery } from '@tanstack/react-query';

interface CorporateTier {
  minMembers: number;
  priceDollars: number;
}

interface PricingConfig {
  guestFeeDollars: number;
  overageRatePerBlockDollars: number;
  overageBlockMinutes: number;
  corporatePricing: {
    basePriceDollars: number;
    tiers: CorporateTier[];
  };
  dayPassPrices: Record<string, number>;
  tierMinutes: Record<string, number>;
}

export function usePricing() {
  const { data } = useQuery<PricingConfig>({
    queryKey: ['pricing'],
    queryFn: async () => {
      const res = await fetch('/api/pricing', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch pricing');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return {
    guestFeeDollars: data?.guestFeeDollars ?? 25,
    overageRatePerBlockDollars: data?.overageRatePerBlockDollars ?? 25,
    overageBlockMinutes: data?.overageBlockMinutes ?? 30,
    getCorporatePrice: (memberCount: number): number => {
      const pricing = data?.corporatePricing;
      if (!pricing?.tiers?.length) return 350;
      const sorted = [...pricing.tiers].sort((a, b) => b.minMembers - a.minMembers);
      for (const tier of sorted) {
        if (memberCount >= tier.minMembers) return tier.priceDollars;
      }
      return pricing.basePriceDollars;
    },
    dayPassPrices: data?.dayPassPrices ?? {},
    tierMinutes: data?.tierMinutes ?? {},
    corporateTiers: data?.corporatePricing?.tiers ?? [],
    corporateBasePrice: data?.corporatePricing?.basePriceDollars ?? 350,
  };
}
