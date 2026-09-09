// Neoblox service worker.
//
// Two-stage caching, matching the install flow: while the site is just being viewed in a
// normal Safari/Chrome tab, we keep this light (shell only). Once the page detects it's
// running standalone — i.e. opened from the Home Screen icon after "Add to Home Screen" —
// it posts PRECACHE_FULL_GAME to us and we pull in the heavy assets (three.min.js, icons),
// so the installed app becomes fully offline-capable with its own real cache storage,
// not just a bookmark.

const CACHE_NAME = 'neoblox-v1';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json'];
const FULL_ASSETS = [
  '/three.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PRECACHE_FULL_GAME') {
    event.waitUntil(
      caches.open(CACHE_NAME)
        .then((cache) => cache.addAll(FULL_ASSETS))
        .catch(() => {})
    );
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Never cache the live WebSocket/API traffic — only static game assets.
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          try {
            if (url.origin === location.origin && resp && resp.status === 200) {
              const copy = resp.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
          } catch (e) {}
          return resp;
        })
        .catch(() => cached);
    })
  );
});
