const RAW_BUILD_VERSION = '__BUILD_VERSION__';
const IS_DEV = RAW_BUILD_VERSION.includes('BUILD_VERSION');
const BUILD_VERSION = IS_DEV ? 'development' : RAW_BUILD_VERSION;
const CACHE_NAME = `ever-club-${BUILD_VERSION}`;
const API_CACHE = `api-cache-${BUILD_VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.ico'
];

const CACHEABLE_API_ENDPOINTS = ['events', 'wellness-classes', 'cafe-menu', 'hours', 'faqs', 'announcements', 'gallery'];

self.addEventListener('install', function(event) {
  console.log('[SW] Installing new version:', BUILD_VERSION);
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key.startsWith('ever-club-') || key.startsWith('ever-house-') || key.startsWith('api-cache-'))
          .map(key => {
            console.log('[SW] Pre-clearing cache during install:', key);
            return caches.delete(key);
          })
      );
    }).then(() => {
      return caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS));
    })
  );
});

self.addEventListener('activate', function(event) {
  console.log('[SW] Activating new version:', BUILD_VERSION);
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => {
          return key.startsWith('ever-club-') || key.startsWith('ever-house-') || key.startsWith('api-cache-');
        }).filter(key => {
          return key !== CACHE_NAME && key !== API_CACHE;
        }).map(key => {
          console.log('[SW] Deleting old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => {
      console.log('[SW] Claiming clients');
      return clients.claim();
    }).then(() => {
      return clients.matchAll({ type: 'window' }).then(clientList => {
        clientList.forEach(client => {
          client.postMessage({ type: 'SW_UPDATED', version: BUILD_VERSION });
        });
      });
    })
  );
});

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skip waiting requested');
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: BUILD_VERSION });
  }
});

self.addEventListener('fetch', function(event) {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    if (CACHEABLE_API_ENDPOINTS.some(ep => url.pathname.includes(ep))) {
      event.respondWith(
        fetch(request).then(response => {
          if (response.ok) {
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              const clone = response.clone();
              caches.open(API_CACHE).then(cache => cache.put(request, clone));
            }
          }
          return response;
        }).catch(() => caches.match(request))
      );
    }
    return;
  }

  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then(cachedResponse => {
            if (cachedResponse) {
              return cachedResponse;
            }
            return caches.match('/').then(fallback => {
              return fallback || new Response('App offline. Please refresh when online.', {
                status: 503,
                headers: { 'Content-Type': 'text/plain' }
              });
            });
          });
        })
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }
});

self.addEventListener('push', function(event) {
  if (!event.data) {
    return;
  }

  const data = event.data.json();
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/',
      dateOfArrival: Date.now(),
      primaryKey: data.id || 1
    },
    actions: data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Ever Club', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        for (const client of clientList) {
          if (client.url.includes(urlToOpen) && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});
