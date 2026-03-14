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
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
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
          client.postMessage({ type: 'SW_ACTIVATED', version: BUILD_VERSION });
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
  var request = event.request;
  var url = new URL(request.url);

  if (request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    if (CACHEABLE_API_ENDPOINTS.some(function(ep) { return url.pathname.includes(ep); })) {
      event.respondWith(
        fetch(request).then(function(response) {
          if (response.ok) {
            var contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              var clone = response.clone();
              caches.open(API_CACHE).then(function(cache) { cache.put(request, clone); });
            }
          }
          return response;
        }).catch(function() { return caches.match(request); })
      );
    }
    return;
  }

  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(function(response) {
          if (response.ok && response.status !== 503) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) { cache.put(request, clone); });
          }
          if (response.status === 503) {
            return caches.match(request).then(function(cachedResponse) {
              if (cachedResponse) {
                console.log('[SW] Server returning 503, serving cached version');
                return cachedResponse;
              }
              return caches.match('/').then(function(fallback) {
                return fallback || response;
              });
            });
          }
          return response;
        })
        .catch(function() {
          return caches.match(request).then(function(cachedResponse) {
            if (cachedResponse) {
              return cachedResponse;
            }
            return caches.match('/').then(function(fallback) {
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
        .then(function(response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) { cache.put(request, clone); });
          }
          return response;
        })
        .catch(function() { return caches.match(request); })
    );
    return;
  }
});

self.addEventListener('push', function(event) {
  if (!event.data) {
    return;
  }

  var data = event.data.json();
  var tag = data.tag || undefined;
  var options = {
    body: data.body || 'You have a new notification',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/badge-72.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/',
      dateOfArrival: Date.now(),
      primaryKey: data.id || 1
    },
    actions: data.actions || [],
    requireInteraction: false
  };

  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Ever Club', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var urlToOpen = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if (client.url.indexOf(urlToOpen) !== -1 && 'focus' in client) {
            return client.focus();
          }
        }
        for (var j = 0; j < clientList.length; j++) {
          var existingClient = clientList[j];
          if ('focus' in existingClient && 'navigate' in existingClient) {
            return existingClient.navigate(urlToOpen).then(function() {
              return existingClient.focus();
            });
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});
