const CACHE = 'budget-v1';

// Files to cache immediately on install
const PRECACHE = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/icon-maskable.svg'
];

// ── INSTALL: precache app shell ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: delete old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: cache-first, fallback to network and cache the response ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Skip non-http(s) requests (e.g. chrome-extension://)
  if (!e.request.url.startsWith('http')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request).then(response => {
        // Only cache valid responses
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return response;
      }).catch(() => {
        // Offline fallback: serve the app shell for navigation requests
        if (e.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});
