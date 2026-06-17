/* GroundTruth service worker — offline-first app shell.
 * Pre-caches the shell + libraries + locales so the app loads with no network.
 * Strategy: cache-first for same-origin static assets (with runtime caching),
 * network-first for /api/ GETs, cross-origin (map tiles) passed through. */
const CACHE = 'gt-shell-v10';

const ASSETS = [
  '/',
  '/index.html',
  '/analyst.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/css/styles.css',
  '/data/buildings-demo.geojson',
  '/js/i18n.js',
  '/js/shell.js',
  '/js/app.js',
  '/js/data.js',
  '/js/report.js',
  '/js/flow.js',
  '/js/submit.js',
  '/js/analyst.js',
  '/vendor/i18next.min.js',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  '/vendor/leaflet-heat.js',
  '/vendor/localforage.min.js',
  '/vendor/exifr.js',
  '/locales/en.json',
  '/locales/ar.json',
  '/locales/zh.json',
  '/locales/fr.json',
  '/locales/ru.json',
  '/locales/es.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Background Sync: when connectivity returns, ask any open client to flush its
// IndexedDB queue (the encrypted-photo blobs live in the page's localForage, so
// the page does the actual upload). The page also flushes on the 'online' event
// and via the manual "Sync now" button, so this is a best-effort enhancement.
self.addEventListener('sync', (event) => {
  if (event.tag === 'gt-sync-queue') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'gt-flush' }));
      })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (e.g. OpenStreetMap tiles): don't intercept here.
  if (url.origin !== self.location.origin) return;

  // API: network-first, fall back to cache if offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // Static/app shell: network-first (keeps content fresh when online), but
  // always update the cache and fall back to it when offline. This is the
  // offline-first guarantee — the app still loads with no network.
  event.respondWith(
    fetch(request)
      .then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(request).then(
          (cached) => cached || (request.mode === 'navigate' ? caches.match('/') : undefined)
        )
      )
  );
});
