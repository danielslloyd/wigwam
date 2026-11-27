// Network-first service worker: always tries for fresh files and falls back to the
// last copy when offline. It caches Wigwam's own files plus the Supabase library from
// the CDN, so the kids' app still opens without internet. Requests to Supabase and
// YouTube pass straight through (the kid files have their own cache, in device.js).
// Each file is stored once, under its path without the query string, so cache-busting
// URLs (?t=…) replace the previous copy instead of piling up.

const CACHE = 'wigwam-v3';
const CDN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Old copies of the app go; the kids' saved lists (wigwam-feed) stay.
  for (const name of await caches.keys()) if (name !== CACHE && /^(tellybox|wigwam-v)/.test(name)) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || (url.origin !== location.origin && url.origin !== CDN)) return;
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
