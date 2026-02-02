/**
 * @deprecated This module is deprecated in favor of React Query caching.
 * All components have been migrated to use useQuery/useMutation hooks from @tanstack/react-query.
 * React Query provides automatic caching, stale-while-revalidate, background refetching,
 * and optimistic updates which replace all functionality here.
 * 
 * This file is retained for backward compatibility with DataContext but should not be used
 * for new features. The notifications sync is the only remaining active use.
 * 
 * See: src/hooks/queries/ for the replacement hooks.
 */
import { useUserStore } from '../stores/userStore';
import { useNotificationStore } from '../stores/notificationStore';

const SYNC_INTERVAL = 5 * 60 * 1000;
const THROTTLE_MS = 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;

interface SyncCache {
  data: any;
  timestamp: number;
}

const lastFetch: Record<string, number> = {};
const failedFetches: Record<string, number> = {};

const isOnline = () => navigator.onLine;
const isVisible = () => document.visibilityState === 'visible';

export const getCached = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(`sync_${key}`);
    if (!raw) return null;
    const cache: SyncCache = JSON.parse(raw);
    return cache.data as T;
  } catch {
    return null;
  }
};

export const setCache = (key: string, data: any) => {
  const cache: SyncCache = { data, timestamp: Date.now() };
  try {
    localStorage.setItem(`sync_${key}`, JSON.stringify(cache));
  } catch (e) {
  }
};

const shouldFetch = (key: string): boolean => {
  const last = lastFetch[key] || 0;
  return Date.now() - last > THROTTLE_MS;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const fetchAndCache = async <T>(
  key: string,
  url: string,
  onUpdate?: (data: T) => void,
  retryCount: number = 0
): Promise<T | null> => {
  if (!shouldFetch(key) && retryCount === 0) return getCached<T>(key);
  if (!isOnline()) return getCached<T>(key);

  if (retryCount === 0) {
    lastFetch[key] = Date.now();
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (res.status === 304) {
      failedFetches[key] = 0;
      return getCached<T>(key);
    }
    
    if (res.ok) {
      const contentType = res.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const data = await res.json();
        setCache(key, data);
        failedFetches[key] = 0;
        onUpdate?.(data);
        return data;
      }
    } else if (res.status >= 500 && retryCount < MAX_RETRIES) {
      await delay(RETRY_DELAY * (retryCount + 1));
      return fetchAndCache(key, url, onUpdate, retryCount + 1);
    }
  } catch (e: any) {
    const isAbort = e.name === 'AbortError';
    const isNetworkError = e.message?.includes('Failed to fetch') || e.message?.includes('NetworkError');
    
    if (!isAbort) {
      const errorType = isNetworkError ? 'network' : 'unknown';
      console.warn(`[sync] Failed to fetch ${key} (${errorType}):`, e.message || e);
    }
    
    failedFetches[key] = (failedFetches[key] || 0) + 1;
    
    if (retryCount < MAX_RETRIES && failedFetches[key] <= MAX_RETRIES) {
      const backoffDelay = RETRY_DELAY * Math.pow(2, retryCount);
      await delay(backoffDelay);
      return fetchAndCache(key, url, onUpdate, retryCount + 1);
    }
    
    if (failedFetches[key] > MAX_RETRIES) {
      console.warn(`[sync] ${key} fetch failed ${failedFetches[key]} times, using cached data`);
    }
  }
  return getCached<T>(key);
};

const syncAll = async () => {
  if (!isVisible() || !isOnline()) return;

  const user = useUserStore.getState().user;
  // Only sync if user is authenticated with a valid email
  // This prevents "Failed to fetch" errors before session is verified
  if (!user?.email) {
    return;
  }
  
  try {
    await fetchAndCache(
      'notifications', 
      `/api/notifications?user_email=${encodeURIComponent(user.email)}&unread_only=true`,
      (data: any[]) => {
        useNotificationStore.getState().setUnreadCount(data.length);
        window.dispatchEvent(new CustomEvent('notifications-read'));
      }
    );
  } catch (err) {
    // Silently fail if session isn't ready - don't log console errors
  }
};

let intervalId: number | null = null;
let visibilityListenerAdded = false;

export const startBackgroundSync = () => {
  if (intervalId) return;
  
  syncAll();
  intervalId = window.setInterval(syncAll, SYNC_INTERVAL);

  if (!visibilityListenerAdded) {
    visibilityListenerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (isVisible()) syncAll();
    });
  }
};

export const stopBackgroundSync = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
};
