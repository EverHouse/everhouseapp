import { useQuery } from '@tanstack/react-query';
import { fetchWithCredentials } from './queries/useFetch';

interface TierRow {
  id: number;
  name: string;
  slug: string;
  sort_order: number;
  product_type: string | null;
}

export function useTierNames() {
  const { data, isLoading } = useQuery({
    queryKey: ['tier-names-active'],
    queryFn: () => fetchWithCredentials<TierRow[]>('/api/membership-tiers?active=true'),
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
  });

  const tiers = data
    ? data
        .filter(t => t.product_type === 'subscription' || t.product_type === null)
        .map(t => t.name)
    : [];

  return { tiers, isLoading };
}
