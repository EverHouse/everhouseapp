import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

declare global {
  interface Window {
    clearPWACaches: () => Promise<void>;
  }
}

const isStandalonePWA = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

const pwaReload = () => {
  const url = new URL(window.location.href);
  url.searchParams.set('_r', Date.now().toString());
  window.location.replace(url.toString());
};

window.clearPWACaches = async () => {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    // eslint-disable-next-line no-console
    console.log('[App] All caches cleared');
  }
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(reg => reg.unregister()));
    // eslint-disable-next-line no-console
    console.log('[App] Service workers unregistered');
  }
  window.location.reload();
};

const isDev = window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname.endsWith('.replit.dev');

if ('serviceWorker' in navigator && !isDev) {
  let refreshing = false;
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (!hadController) {
      // eslint-disable-next-line no-console
      console.log('[App] First service worker install, skipping reload');
      return;
    }
    refreshing = true;
    // eslint-disable-next-line no-console
    console.log('[App] New service worker activated, reloading');
    if (isStandalonePWA()) {
      pwaReload();
    } else {
      window.location.reload();
    }
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        updateViaCache: 'none'
      });
      
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // eslint-disable-next-line no-console
              console.log('[App] New service worker installed, will auto-activate');
            }
          });
        }
      });
      
      setInterval(() => {
        registration.update().catch((err: unknown) => console.warn('[App] Service worker update check failed:', err));
      }, 60 * 60 * 1000);
      
    } catch (error: unknown) {
      console.error('[App] Service worker registration failed:', error);
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
        // eslint-disable-next-line no-console
        console.log('[App] Cleared caches after SW registration failure');
      }
    }
  });

  if (isStandalonePWA()) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      navigator.serviceWorker.getRegistration().then(reg => {
        if (reg) reg.update().catch(() => {});
      });
    });
  }
} else if ('serviceWorker' in navigator && isDev) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(r => r.unregister());
  });
}

if (window.location.search.includes('_r=')) {
  const url = new URL(window.location.href);
  url.searchParams.delete('_r');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

const removeSplash = () => {
  const splash = document.getElementById('app-splash');
  if (splash) {
    splash.style.opacity = '0';
    setTimeout(() => {
      splash.remove();
    }, 500);
  }
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

requestAnimationFrame(() => {
  removeSplash();
});
