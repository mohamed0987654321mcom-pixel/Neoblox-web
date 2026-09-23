// Neoblox service worker.
//
// Two-stage caching, matching the install flow: while the site is just being viewed in a
// normal Safari/Chrome tab, we keep this light (shell only). Once the page detects it's
// running standalone — i.e. opened from the Home Screen icon after "Add to Home Screen" —
// it posts PRECACHE_FULL_GAME to us and we pull in the heavy assets (three.min.js, icons),
// so the installed app becomes fully offline-capable with its own real cache storage,
// not just a bookmark.
//
// IMPORTANT: the HTML shell (/, /index.html, /manifest.json) is served network-first —
// always try the live server first so a new deploy shows up immediately, and only fall
// back to the cached copy if the network is unreachable (offline). Only the heavy, rarely-
// changing assets (three.min.js, icons) are cache-first, since those are what "offline
// play" actually depends on and there's no benefit to re-fetching them every load.
// Bump CACHE_NAME whenever this file changes so the activate handler below clears out any
// previous cache instead of leaving it (and whatever it served) around forever.

const CACHE_NAME = 'neoblox-v2';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json'];
const FULL_ASSETS = [
  '/three.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/favicon-32.png',
];
const NETWORK_FIRST_PATHS = new Set(SHELL_ASSETS);

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
  const url = new URL(event.request.url);
  // Never touch the live WebSocket/API traffic — only static game assets.
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/')) return;
  if (url.origin !== location.origin) return;

  const isShell = event.request.mode === 'navigate' || NETWORK_FIRST_PATHS.has(url.pathname);

  if (isShell) {
    // Network-first: always prefer whatever's actually live, so a new deploy is visible
    // on the very next load instead of being masked by a stale cached copy.
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          try {
            if (resp && resp.status === 200) {
              const copy = resp.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
          } catch (e) {}
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for the heavy, rarely-changing assets — this is what makes offline play work.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          try {
            if (resp && resp.status === 200) {
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
