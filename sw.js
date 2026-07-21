// Service worker: makes the viewer an installable, offline-capable PWA.
// Strategy: precache the app shell on install; cache-first at runtime so every
// module/asset fetched on the first online load is available offline afterward.

const CACHE = 'canviewer-v1';
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
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        return resp;
      }).catch(() => caches.match('./index.html')),
    ),
  );
});
