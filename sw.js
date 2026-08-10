const CACHE_NAME = 'ww-shell-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './output.css',
  './favicon.svg'
];

// Cache the app shell on install
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(STATIC_ASSETS)));
});

// Clean up old caches on activate
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((k) => {
        if (k !== CACHE_NAME) return caches.delete(k);
      })
    ))
  );
  self.clients.claim();
});

// Intercept network requests
self.addEventListener('fetch', (e) => {
  // Ignore API calls; our frontend SWR logic handles weather data caching
  if (e.request.url.includes('api.') || e.request.url.includes('weather.json')) {
     return; 
  }

  // Serve static assets from cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return cached || fetch(e.request).catch(() => caches.match('./index.html'));
    })
  );
});