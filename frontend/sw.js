// PocketLog Service Worker
// Strategie:
//   - App-Shell wird beim Install precached und mit Cache-First ausgeliefert.
//   - GET /api/...      → network-first, Fallback auf Cache.
//   - Write /api/...    → online direkt durchreichen; offline in Outbox
//                          (frontend/db.js) ablegen und 202 zurückgeben.
//   - Background-Sync   → bei wieder hergestelltem Netz Outbox flushen.

importScripts('/db.js');

const CACHE = 'pocketlog-shell-v1';
const API_CACHE = 'pocketlog-api-v1';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/db.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        SHELL.map((url) =>
          c.add(url).catch(() => undefined) // fehlende optionale Ressourcen ignorieren
        )
      )
    )
  );
  self.skipWaiting();
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

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(API_CACHE);
    cache.put(request, fresh.clone());
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
  const res = await fetch(request);
  const cache = await caches.open(CACHE);
  cache.put(request, res.clone());
  return res;
}

async function handleWrite(request) {
  try {
    return await fetch(request.clone());
  } catch (e) {
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
      event.respondWith(networkFirst(req));
    } else {
      event.respondWith(handleWrite(req));
    }
    return;
  }

  if (req.method === 'GET') {
    event.respondWith(cacheFirst(req));
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'pocketlog-outbox') {
    event.waitUntil(
      self.PocketLogOutbox.drain('/api').then((flushed) => {
        if (flushed > 0) {
          self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
            clients.forEach((c) => c.postMessage({ type: 'SYNC_DONE', flushed }));
          });
        }
      })
    );
  }
});
