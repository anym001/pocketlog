// PocketLog Service Worker
// Strategie:
//   - Shell-HTML/CSS/JS → network-first (/, /index.html, /styles.css,
//                          /app.js, /db.js, /manifest.webmanifest), damit
//                          Updates ohne Doppel-Reload sichtbar werden;
//                          Cache dient nur als Offline-Fallback.
//   - Statische Shell-Assets (Icons, Fonts, Chart.js Vendor-Bundle) → cache-first.
//   - GET /api/...   → network-first, Fallback auf Cache.
//   - Write /api/... → online direkt durchreichen; offline in Outbox
//                       (frontend/db.js) ablegen und 202 zurückgeben.
//   - Background-Sync → bei wieder hergestelltem Netz Outbox flushen.
//
// __APP_VERSION__ wird im Dockerfile aus der ENV APP_VERSION ersetzt.
// Jede Release bekommt damit neue Cache-Keys; alte Caches räumt der
// activate-Hook ab.

importScripts('/db.js');

const VERSION = '__APP_VERSION__';
const CACHE = `pocketlog-shell-${VERSION}`;
const API_CACHE = `pocketlog-api-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/db.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/categories/sprite.svg',
  '/fonts/dm-sans-latin.woff2',
  '/fonts/dm-sans-latin-ext.woff2',
  '/fonts/dm-serif-display-latin.woff2',
  '/fonts/dm-serif-display-latin-ext.woff2',
  '/vendor/chart.umd.min.js',
];

// HTML-Shell + App-Code (styles.css, app.js, db.js): bei jedem Online-Request
// frisch holen, Cache nur falls offline. Icons, Fonts und der versionierte
// Chart.js-Bundle unter /vendor/ ändern sich praktisch nie und bleiben
// cache-first.
function isNetworkFirstShell(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/styles.css' ||
    url.pathname === '/app.js' ||
    url.pathname === '/db.js' ||
    url.pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('install', (event) => {
  // skipWaiting must run AFTER precaching settles. Calling it outside
  // waitUntil() races: the new SW could activate and start serving
  // requests while the SHELL.map promises are still in flight, and
  // a cache-first lookup that hits a not-yet-cached URL would 404.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.all(
          SHELL.map((url) =>
            c.add(url).catch(() => undefined) // fehlende optionale Ressourcen ignorieren
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

async function networkFirst(request, cacheName) {
  try {
    const fresh = await fetch(request);
    // Auth boundary: a 401 on /api/* means the session expired or a
    // different Authentik identity is signed in. Drop the API cache so
    // the next online request repopulates it from scratch — never serve
    // a previous identity's data from cache. Threat model is one user
    // per device, so we don't keep per-user buckets.
    if (cacheName === API_CACHE && fresh.status === 401) {
      await caches.delete(API_CACHE);
    } else if (fresh.ok) {
      // Only cache successful responses. Caching 4xx/5xx would let a
      // transient error linger as the offline fallback. If the backend
      // ever starts emitting ETag/Last-Modified, 304 Not Modified will
      // arrive here as `ok === false` and must be treated explicitly —
      // the cached version is still valid in that case.
      const cache = await caches.open(cacheName);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  // Offline and not in cache: the fetch will throw. Surface that as a
  // proper 503 instead of leaking an unhandled rejection — keeps
  // browser devtools quiet and matches the network-first error shape.
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE);
    cache.put(request, res.clone());
    return res;
  } catch (e) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function handleWrite(request) {
  try {
    return await fetch(request.clone());
  } catch (e) {
    // Outbox replays writes as JSON. Anything else — multipart file
    // uploads (CSV-Import), urlencoded forms — can't round-trip through
    // IndexedDB, so we must NOT silently queue them with an empty body.
    // Surface a 503 so the caller sees the failure and can retry online.
    const contentType = request.headers.get('Content-Type') || '';
    const isQueueable =
      request.method === 'DELETE' ||
      contentType.includes('application/json');
    if (!isQueueable) {
      return new Response(JSON.stringify({ offline: true }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = request.method === 'DELETE'
      ? null
      : await request.clone().json().catch(() => null);
    const url = new URL(request.url);
    await self.PocketLogOutbox.enqueue({
      method: request.method,
      path: url.pathname.replace(/^\/api/, '') + url.search,
      body,
    });
    if ('sync' in self.registration) {
      try { await self.registration.sync.register('pocketlog-outbox'); } catch (_) {}
    }
    return new Response(JSON.stringify({ queued: true }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (isApi(url)) {
    // /api/health dient als Online-Probe — niemals aus dem Cache beantworten,
    // sonst wirkt der Sync-Button selbst im Flugmodus erfolgreich.
    if (req.method === 'GET' && url.pathname === '/api/health') {
      event.respondWith(fetch(req));
      return;
    }
    if (req.method === 'GET') {
      event.respondWith(networkFirst(req, API_CACHE));
    } else {
      event.respondWith(handleWrite(req));
    }
    return;
  }

  if (req.method === 'GET') {
    if (isNetworkFirstShell(url)) {
      event.respondWith(networkFirst(req, CACHE));
    } else {
      event.respondWith(cacheFirst(req));
    }
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'pocketlog-outbox') {
    event.waitUntil(
      self.PocketLogOutbox.drain('/api').then(({ ok, failed }) => {
        if (ok > 0 || failed > 0) {
          self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
            clients.forEach((c) => c.postMessage({ type: 'SYNC_DONE', ok, failed }));
          });
        }
      })
    );
  }
});
