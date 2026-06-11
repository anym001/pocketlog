// PocketLog Service Worker
// Strategy:
//   - Shell HTML/CSS/JS → network-first (/, /index.html, /styles.css, every
//                          app script from core.js to app.js plus db.js and
//                          /manifest.webmanifest), so updates become visible
//                          without a double reload; the cache only serves as
//                          the offline fallback.
//   - Static shell assets (icons, fonts, Chart.js vendor bundle) → cache-first.
//   - GET /api/...   → network-first, falling back to the cache.
//   - Write /api/... → pass through directly while online; offline, store in
//                       the outbox (frontend/db.js) and return 202.
//   - Background sync → flush the outbox once the network is back.
//
// __APP_VERSION__ is substituted in the Dockerfile from the APP_VERSION env.
// Every release thereby gets new cache keys; the activate hook clears old
// caches.

importScripts('/db.js');

const VERSION = '__APP_VERSION__';
const CACHE = `pocketlog-shell-${VERSION}`;
const API_CACHE = `pocketlog-api-${VERSION}`;

// Boot-critical shell: HTML, CSS, the full classic-script chain (a single
// missing module aborts init() with a ReferenceError offline), the offline
// outbox, Chart.js and both i18n bundles. A precache miss here must fail
// the install so the browser retries — a partially cached shell is worse
// than no new shell at all.
const SHELL_CRITICAL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/core.js',
  '/ledger.js',
  '/reports.js',
  '/booking.js',
  '/categories.js',
  '/goals.js',
  '/recurring.js',
  '/settings.js',
  '/utils.js',
  '/reportsData.js',
  '/state.js',
  '/i18n.js',
  '/manifest.webmanifest',
  '/db.js',
  '/vendor/chart.umd.min.js',
  // Both language bundles are precached so switching language works
  // offline, not just the one that happened to be active first.
  '/i18n/de.json',
  '/i18n/en.json',
];

// Cosmetic assets: best-effort precache, a miss only degrades visuals or a
// download nicety — never the boot.
const SHELL_OPTIONAL = [
  // Per-language CSV import samples.
  '/example-import-de.csv',
  '/example-import-en.csv',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/categories/sprite.svg',
  '/fonts/dm-sans-latin.woff2',
  '/fonts/dm-sans-latin-ext.woff2',
  '/fonts/dm-serif-display-latin.woff2',
  '/fonts/dm-serif-display-latin-ext.woff2',
];

// HTML shell + app code (styles.css, every app script from core.js to
// app.js, db.js): fetched fresh on every online request, cache only when
// offline. Icons, fonts and the versioned Chart.js bundle under /vendor/
// practically never change and stay cache-first.
function isNetworkFirstShell(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/styles.css' ||
    url.pathname === '/app.js' ||
    url.pathname === '/core.js' ||
    url.pathname === '/ledger.js' ||
    url.pathname === '/reports.js' ||
    url.pathname === '/booking.js' ||
    url.pathname === '/categories.js' ||
    url.pathname === '/goals.js' ||
    url.pathname === '/recurring.js' ||
    url.pathname === '/settings.js' ||
    url.pathname === '/utils.js' ||
    url.pathname === '/reportsData.js' ||
    url.pathname === '/state.js' ||
    url.pathname === '/i18n.js' ||
    url.pathname === '/db.js' ||
    url.pathname === '/manifest.webmanifest' ||
    // Translation bundles are tightly coupled to app.js's key usage: a
    // cache-first bundle would lag behind a fresh app.js between version
    // bumps and render raw keys for any newly added string. Network-first
    // keeps them in lockstep; they stay in the SHELL precache so offline
    // language switching still works (network-first falls back to cache).
    url.pathname === '/i18n/de.json' ||
    url.pathname === '/i18n/en.json'
  );
}

self.addEventListener('install', (event) => {
  // skipWaiting must run AFTER precaching settles. Calling it outside
  // waitUntil() races: the new SW could activate and start serving
  // requests while the precache promises are still in flight, and
  // a cache-first lookup that hits a not-yet-cached URL would 404.
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        // Critical first and without a catch: a miss rejects the install,
        // the browser retries later and the previous SW keeps serving.
        await c.addAll(SHELL_CRITICAL);
        await Promise.all(
          SHELL_OPTIONAL.map(
            (url) => c.add(url).catch(() => undefined), // ignore missing optional resources
          ),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

// Auth and health endpoints must NEVER come from the cache. Their
// responses determine the frontend's auth state (login, setup or
// force-change view) — a stale cached response would pin the user in a
// view their real session state no longer matches. Health is the online
// probe.
const NEVER_CACHE_PATHS = new Set([
  '/api/health',
  '/api/auth/me',
  '/api/auth/setup-status',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/change-password',
]);

function isAuthPath(url) {
  return url.pathname.startsWith('/api/auth/');
}

async function networkFirst(request, cacheName) {
  const url = new URL(request.url);
  try {
    const fresh = await fetch(request);
    // Auth boundary: a 401 on /api/* means the session expired or a
    // different Authentik identity is signed in. Drop the API cache so
    // the next online request repopulates it from scratch — never serve
    // a previous identity's data from cache. Threat model is one user
    // per device, so we don't keep per-user buckets.
    if (cacheName === API_CACHE && fresh.status === 401) {
      await caches.delete(API_CACHE);
    } else if (fresh.status === 304) {
      // The backend started emitting validators (ETag/Last-Modified).
      // 304 has no body — we must serve the cached entry, or the page
      // would receive an empty response and break.
      const cached = await caches.match(request);
      if (cached) return cached;
      // No cache hit: rare race (deploy mid-flight). Force the page to
      // retry by reporting it as a transient 503.
      return new Response(JSON.stringify({ offline: true }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    } else if (fresh.ok) {
      // Only cache successful responses. Caching 4xx/5xx would let a
      // transient error linger as the offline fallback.
      const cache = await caches.open(cacheName);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (e) {
    // Auth-state-dependent endpoints must never serve stale responses
    // from the cache-fallback branch. If the network is down, return a
    // 503 so the page sees the failure and stays on whatever view it
    // is — instead of being redirected based on a yesterday-old me.
    if (isAuthPath(url)) {
      return new Response(JSON.stringify({ offline: true }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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

// Endpoints that must NEVER enter the outbox. Auth operations make no
// sense offline — a login attempt replayed on the next reconnect with
// queued credentials would be a capital security hole, and a logout
// replay would immediately tear down the user's fresh session.
const NEVER_QUEUE_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/change-password',
]);

async function handleWrite(request) {
  try {
    return await fetch(request.clone());
  } catch (e) {
    const url = new URL(request.url);
    if (NEVER_QUEUE_PATHS.has(url.pathname)) {
      return new Response(JSON.stringify({ offline: true }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Outbox replays writes as JSON. Anything else — multipart file
    // uploads (CSV-Import), urlencoded forms — can't round-trip through
    // IndexedDB, so we must NOT silently queue them with an empty body.
    // Surface a 503 so the caller sees the failure and can retry online.
    const contentType = request.headers.get('Content-Type') || '';
    const isQueueable = request.method === 'DELETE' || contentType.includes('application/json');
    if (!isQueueable) {
      return new Response(JSON.stringify({ offline: true }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body =
      request.method === 'DELETE'
        ? null
        : await request
            .clone()
            .json()
            .catch(() => null);
    await self.PocketLogOutbox.enqueue({
      method: request.method,
      path: url.pathname.replace(/^\/api/, '') + url.search,
      body,
    });
    if ('sync' in self.registration) {
      try {
        await self.registration.sync.register('pocketlog-outbox');
      } catch (_) {}
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
    // Auth and health endpoints: never from the cache — the state must
    // come live from the server, otherwise the user lands in a view that
    // doesn't match their real session.
    if (req.method === 'GET' && NEVER_CACHE_PATHS.has(url.pathname)) {
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
      }),
    );
  }
});

// Incoming messages from the frontend.
// - SET_CSRF: the current CSRF token the outbox must send along on
//             replay. Set on every login and in init().
// - CLEAR_API_CACHE: after logout or a 401 reload — the API cache and
//             the CSRF token held by the SW must go, so the next login
//             doesn't leak old data or a stale token into outbox
//             replays.
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'SET_CSRF' && self.PocketLogOutbox?.setCsrfToken) {
    self.PocketLogOutbox.setCsrfToken(msg.token || '');
  } else if (msg.type === 'CLEAR_API_CACHE') {
    if (self.PocketLogOutbox?.setCsrfToken) {
      self.PocketLogOutbox.setCsrfToken('');
    }
    event.waitUntil(caches.delete(API_CACHE));
  }
});
