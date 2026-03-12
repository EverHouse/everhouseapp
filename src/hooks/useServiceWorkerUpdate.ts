import { useState, useEffect, useCallback, useRef } from 'react';

interface ServiceWorkerUpdateState {
  updateAvailable: boolean;
  isUpdating: boolean;
  applyUpdate: () => void;
  dismissUpdate: () => void;
}

const UPDATE_CHECK_INTERVAL = 10 * 60 * 1000;
const DISMISS_COOLDOWN_KEY = 'sw-update-dismissed-at';
const DISMISS_COOLDOWN_MS = 30 * 60 * 1000;

export function useServiceWorkerUpdate(): ServiceWorkerUpdateState {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const isDismissCooldown = () => {
      const dismissedAt = sessionStorage.getItem(DISMISS_COOLDOWN_KEY);
      if (!dismissedAt) return false;
      return Date.now() - parseInt(dismissedAt, 10) < DISMISS_COOLDOWN_MS;
    };

    const showUpdate = (worker: ServiceWorker) => {
      if (isDismissCooldown()) return;
      console.log('[App] Update available, showing notification');
      setWaitingWorker(worker);
      setUpdateAvailable(true);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SW_UPDATED') {
        console.log('[App] Service worker updated to version:', event.data.version);
        setUpdateAvailable(false);
        setIsUpdating(false);
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);

    const detectWaiting = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting && registration.waiting.state === 'installed') {
        showUpdate(registration.waiting);
      }
    };

    const listenForUpdate = (registration: ServiceWorkerRegistration) => {
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              showUpdate(newWorker);
            } else {
              console.log('[App] First SW install, no update prompt needed');
            }
          }
        });
      });
    };

    const setupRegistration = async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        detectWaiting(registration);
        listenForUpdate(registration);
        registration.update().catch((err: unknown) => console.warn('[App] SW update check failed:', err));
      } catch (e) {
        console.error('[App] SW ready failed:', e);
      }
    };

    setupRegistration();

    const checkForUpdates = async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.update();
          detectWaiting(registration);
        }
      } catch (e) {
        console.warn('[App] SW update check failed:', e);
      }
    };

    const intervalId = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkForUpdates();
      }
    };
    visibilityHandlerRef.current = onVisibilityChange;
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleMessage);
      clearInterval(intervalId);
      if (visibilityHandlerRef.current) {
        document.removeEventListener('visibilitychange', visibilityHandlerRef.current);
      }
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (!waitingWorker) return;

    setIsUpdating(true);
    sessionStorage.removeItem(DISMISS_COOLDOWN_KEY);

    let refreshing = false;
    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    waitingWorker.postMessage({ type: 'SKIP_WAITING' });

    setTimeout(() => {
      if (!refreshing) {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        console.log('[App] Controller change timeout, forcing reload');
        window.location.reload();
      }
    }, 5000);
  }, [waitingWorker]);

  const dismissUpdate = useCallback(() => {
    setUpdateAvailable(false);
    sessionStorage.setItem(DISMISS_COOLDOWN_KEY, Date.now().toString());
  }, []);

  return {
    updateAvailable,
    isUpdating,
    applyUpdate,
    dismissUpdate
  };
}
