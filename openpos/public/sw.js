'use strict';
// ---------------------------------------------------------------------------
// sw.js — the storefront's offline promise.
// The shell is cached so the shop opens with no network; the catalogue is
// served fresh when there is a network and from the cache when there is not.
// Nothing here ever invents a price: an offline catalogue is the last one the
// shop itself published, and the banner on the page says so.
// ---------------------------------------------------------------------------
const CACHE = 'openpos-store-v1';
const SHELL = ['/store.html', '/assets/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Catalogue & shop details: fresh when possible, last known when not.
  if (url.pathname.startsWith('/api/store/catalogue') || url.pathname === '/api/store') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/api/store/catalogue', copy)).catch(() => {});
          return res;
        })
        .catch(async () => (await caches.match('/api/store/catalogue')) || (await caches.match(req)) || Response.error())
    );
    return;
  }

  // Everything else: cache first, then network.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && SHELL.includes(url.pathname)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
