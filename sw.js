// Network-first service worker: always tries for fresh files (so whitelist
// changes show up straight away) and falls back to the last copy when offline.
// Only same-origin files are cached; YouTube requests pass straight through.
// Each file is stored once, under its path without the query string, so cache-busting
// URLs (?t=…, ?v=…) replace the previous copy instead of piling up.

const CACHE = 'wigwam-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name); // v1 kept every copy
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.origin + url.pathname;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key)),
  );
});
