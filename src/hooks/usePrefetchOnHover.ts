import { useCallback, useRef } from 'react';
import { useQueryClient, QueryKey } from '@tanstack/react-query';

const prefetchedKeys = new Set<string>();

function serializeKey(key: QueryKey): string {
  return JSON.stringify(key);
}

interface PrefetchOnHoverOptions<T> {
  queryKey: QueryKey;
  queryFn: () => Promise<T>;
  staleTime?: number;
  enabled?: boolean;
}

export function usePrefetchOnHover<T>({
  queryKey,
  queryFn,
  staleTime = 30_000,
  enabled = true,
}: PrefetchOnHoverOptions<T>) {
  const queryClient = useQueryClient();
  const serialized = serializeKey(queryKey);
  const serializedRef = useRef(serialized);
  // eslint-disable-next-line react-hooks/refs
  serializedRef.current = serialized;

  const triggerPrefetch = useCallback(() => {
    if (!enabled) return;
    const key = serializedRef.current;
    if (prefetchedKeys.has(key)) return;
    prefetchedKeys.add(key);

    queryClient.prefetchQuery({
      queryKey,
      queryFn,
      staleTime,
    });
  }, [queryClient, queryKey, queryFn, staleTime, enabled]);

  const handlers = {
    onMouseEnter: triggerPrefetch,
    onFocus: triggerPrefetch,
  };

  return handlers;
}

export function prefetchQueryDirect<T>(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: QueryKey,
  queryFn: () => Promise<T>,
  staleTime = 30_000,
) {
  const key = serializeKey(queryKey);
  if (prefetchedKeys.has(key)) return;
  prefetchedKeys.add(key);

  queryClient.prefetchQuery({
    queryKey,
    queryFn,
    staleTime,
  });
}
