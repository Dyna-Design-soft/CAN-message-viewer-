// Service worker: makes the viewer an installable, offline-capable PWA.
//
// Strategy: NETWORK-FIRST for same-origin GETs, falling back to the cache when
// offline. Cache-first was a trap here — because the app is many ES modules
// cached incrementally, a deploy left returning users with a version-skewed
// bundle (old index.html + newly-fetched JS), which broke the app. Network-first
// always serves a consistent fresh set when online and still works offline from
// the last cached copy. Bump CACHE on shape changes so activate() purges stale
// caches.

const CACHE = 'canviewer-v2';
const CORE = [
  './',
  './index.html',
  './css/app.css',
  './src/graph/uplot.min.js',
  './src/graph/uplot.css',
  './src/main.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Network-first: fetch fresh, update the cache, fall back to cache offline.
  e.respondWith(
    fetch(req)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
