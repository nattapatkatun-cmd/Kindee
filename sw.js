const CACHE_NAME = 'kindee-v2';
const STATIC_ASSETS = [
  '/Kindee/',
  '/Kindee/index.html',
  'https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(['/Kindee/', '/Kindee/index.html']).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for HTML, cache-first for other assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always network for Firebase, Gemini, Google APIs
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('generativelanguage.googleapis.com') ||
    url.hostname.includes('workers.dev') ||
    url.hostname.includes('script.google.com')
  ) {
    return;
  }

  if (url.origin === self.location.origin) {
    const isHTML = event.request.destination === 'document' ||
                   url.pathname.endsWith('.html') ||
                   url.pathname.endsWith('/');

    if (isHTML) {
      // Network-first: always fetch fresh HTML, fallback to cache offline
      event.respondWith(
        fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => caches.match(event.request))
      );
    } else {
      // Cache-first for JS/CSS/images
      event.respondWith(
        caches.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          }).catch(() => caches.match('/Kindee/index.html'));
        })
      );
    }
  }
});
