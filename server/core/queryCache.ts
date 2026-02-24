import { logger } from './logger';

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const caches = new Map<string, CacheEntry<unknown>>();

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
