
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const MAX_CACHE_SIZE = 500;
const caches = new Map<string, CacheEntry<unknown>>();

function evictExpired(): number {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of caches) {
    if (entry.expiry <= now) {
      caches.delete(key);
      evicted++;
    }
  }
  return evicted;
}

export function getCached<T>(key: string): T | null {
  const entry = caches.get(key);
  if (entry && entry.expiry > Date.now()) {
    return entry.data as T;
  }
  if (entry) {
    caches.delete(key);
  }
  return null;
}

export function setCache<T>(key: string, data: T, ttlMs: number): void {
  if (caches.size >= MAX_CACHE_SIZE && !caches.has(key)) {
    evictExpired();
    if (caches.size >= MAX_CACHE_SIZE) {
      const oldestKey = caches.keys().next().value;
      if (oldestKey !== undefined) {
        caches.delete(oldestKey);
      }
    }
  }
  caches.set(key, { data, expiry: Date.now() + ttlMs });
}

export function invalidateCache(keyPrefix: string): void {
  for (const key of caches.keys()) {
    if (key.startsWith(keyPrefix)) {
      caches.delete(key);
    }
  }
}

export function clearAllCaches(): void {
  caches.clear();
}
