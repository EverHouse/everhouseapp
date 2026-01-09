import { useUserStore } from '../stores/userStore';

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
    if (e.name !== 'AbortError') {
      console.error(`[sync] Failed to fetch ${key}:`, e);
    }
    
    failedFetches[key] = (failedFetches[key] || 0) + 1;
    
    if (retryCount < MAX_RETRIES && failedFetches[key] <= MAX_RETRIES) {
      await delay(RETRY_DELAY * (retryCount + 1));
      return fetchAndCache(key, url, onUpdate, retryCount + 1);
    }
  }
  return getCached<T>(key);
};

const syncAll = async () => {
  if (!isVisible() || !isOnline()) return;

  const tasks = [
    fetchAndCache('events', '/api/events'),
    fetchAndCache('cafe_menu', '/api/cafe-menu'),
  ];

  const user = useUserStore.getState().user;
  if (user?.email) {
    tasks.push(
      fetchAndCache(
        'notifications', 
        `/api/notifications?user_email=${encodeURIComponent(user.email)}&unread_only=true`,
        (data: any[]) => {
          useUserStore.setState({ unreadNotifications: data.length });
          window.dispatchEvent(new CustomEvent('notifications-read'));
        }
      )
    );
  }

  await Promise.allSettled(tasks);
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
