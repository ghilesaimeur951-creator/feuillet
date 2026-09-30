/* Feuillet service worker — offline support.
 * App shell: precached at install (versioned by build id).
 * Vendor engines (pdf.js, Tesseract, language models): cached on first use (cache-first).
 * Never caches cross-origin requests (the app makes none). */
const BUILD_ID = '__BUILD_ID__';
const SHELL = `feuillet-shell-${BUILD_ID}`;
const VENDOR = 'feuillet-vendor-v1';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('feuillet-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  const path = url.pathname.slice(scope.pathname.length);

  // Navigation: network first (fresh index), offline fallback to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('./', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./', { cacheName: SHELL }).then((r) => r || caches.match('index.html'))),
    );
    return;
  }

  // Heavy vendor files (engines, models): cache-first, stored on first use.
  if (path.startsWith('vendor/')) {
    event.respondWith(
      caches.open(VENDOR).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone()).catch(() => {});
        return res;
      }),
    );
    return;
  }

  // Everything else: cache-first from the shell, then network.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
