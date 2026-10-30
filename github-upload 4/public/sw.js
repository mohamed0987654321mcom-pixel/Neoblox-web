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

const CACHE_NAME = 'neoblox-v11';
// The game's own code (the page + rbx/*) is network-first too, so updates always show up.
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json', '/rbx/hud.css', '/rbx/hud.js', '/rbx/home.css', '/rbx/home.js', '/rbx/studio.css', '/rbx/studio.js', '/rbx/ui.css', '/rbx/codeeditor.css', '/rbx/codeeditor.js', '/rbx/neoscript.js', '/rbx/neoscript-runtime.js', '/rbx/pictures.css', '/rbx/pictures.js', '/rbx/market.css', '/rbx/market.js', '/rbx/animate.js', '/rbx/vr.js'];
const FULL_ASSETS = [
  '/three.min.js',
  '/vendor/quickjs/quickjs.js',
  '/vendor/quickjs/quickjs.wasm',
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
  // uploaded pictures: left to the browser's normal cache (they can be deleted, and there can be many)
  if (url.pathname.startsWith('/img/')) return;
  if (url.origin !== location.origin) return;

  const isShell = event.request.mode === 'navigate' || NETWORK_FIRST_PATHS.has(url.pathname) || url.pathname.startsWith('/rbx/');

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
