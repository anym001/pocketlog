// Unit tests for the service worker's network-first strategy, focused on the
// timeout fix: on a weak ("lie-fi") connection a request that already holds a
// cached copy must fall back to the cache within NETWORK_TIMEOUT_MS instead of
// hanging on the stalled network (the white-screen bug).
//
// Why a sandbox and not Playwright: a controlling service worker makes its own
// fetches in a separate execution context that Playwright's network controls
// (setOffline / route / CDP) do not reach — the SW keeps talking to the real
// server, so a browser-level test can't stall it. So we evaluate sw.js in a
// vm context with mocked `caches`, `fetch`, `Response` and timers, and call
// networkFirst() directly. That makes the timeout race deterministic.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const SW_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'sw.js');

// In-memory Cache Storage mock: name -> Map(url -> Response).
function makeCaches() {
  const store = new Map();
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  return {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name);
      return {
        async put(req, res) {
          m.set(keyOf(req), res);
        },
        async match(req) {
          return m.get(keyOf(req));
        },
      };
    },
    async match(req) {
      const k = keyOf(req);
      for (const m of store.values()) if (m.has(k)) return m.get(k);
      return undefined;
    },
    async delete(name) {
      return store.delete(name);
    },
    _store: store,
  };
}

// Fresh sandbox per test: evaluate sw.js and expose the functions + the const
// cache names (top-level `const`s aren't global object properties in a vm
// script, so sw.js can't reach them from outside — we append an export line).
function loadSw() {
  const src =
    readFileSync(SW_PATH, 'utf8') +
    '\n;self.__exports = { networkFirst, fetchWithTimeout, isAuthPath, ' +
    'CACHE, API_CACHE, NETWORK_TIMEOUT_MS };';
  const caches = makeCaches();
  const sandbox = {
    self: {
      addEventListener() {},
      location: { origin: 'https://app.test' },
      registration: {},
      clients: { matchAll: async () => [] },
      skipWaiting() {},
      PocketLogOutbox: {},
    },
    importScripts() {},
    caches,
    fetch: async () => new Response(null, { status: 200 }),
    Response: globalThis.Response,
    URL: globalThis.URL,
    Promise,
    Set,
    Error,
    JSON,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sw: sandbox.self.__exports, sandbox, caches };
}

const reqOf = (url, method = 'GET') => ({ url, method });
const resp = (body, init) => new Response(body, init);
const tick = () => new Promise((r) => setTimeout(r, 15));

const SHELL_URL = 'https://app.test/app.js';
const API_URL = 'https://app.test/api/transactions';
const ME_URL = 'https://app.test/api/auth/me';

describe('networkFirst — weak-connection timeout', () => {
  let sw, sandbox, caches;
  beforeEach(() => {
    ({ sw, sandbox, caches } = loadSw());
  });

  it('serves the cached copy when the network stalls past the timeout, then warms the cache in the background', async () => {
    const c = await caches.open(sw.CACHE);
    await c.put(reqOf(SHELL_URL), resp('CACHED'));

    // A "lie-fi" fetch: never resolves on its own — we resolve it by hand
    // *after* the timeout has already served the stale copy.
    let resolveFetch;
    sandbox.fetch = () => new Promise((res) => (resolveFetch = res));

    const result = await sw.networkFirst(reqOf(SHELL_URL), sw.CACHE);
    // The timeout fired and handed back the cached shell — no hang.
    expect(await result.clone().text()).toBe('CACHED');

    // The slow network finally answers; the still-running fetch repopulates
    // the cache so the next load is fresh.
    resolveFetch(resp('FRESH'));
    await tick();
    const cached = await caches.match(reqOf(SHELL_URL));
    expect(await cached.text()).toBe('FRESH');
  }, 8000); // Real 3s NETWORK_TIMEOUT_MS wait — give the test headroom.

  it('returns the fresh response and caches it when the network is healthy (cold cache)', async () => {
    sandbox.fetch = async () => resp('FRESH', { status: 200 });
    const result = await sw.networkFirst(reqOf(SHELL_URL), sw.CACHE);
    expect(await result.text()).toBe('FRESH');
    const cached = await caches.match(reqOf(SHELL_URL));
    expect(await cached.text()).toBe('FRESH');
  });

  it('updates the cache from the fresh response when the network wins the race (warm cache)', async () => {
    const c = await caches.open(sw.CACHE);
    await c.put(reqOf(SHELL_URL), resp('STALE'));
    sandbox.fetch = async () => resp('FRESH', { status: 200 });

    const result = await sw.networkFirst(reqOf(SHELL_URL), sw.CACHE);
    expect(await result.text()).toBe('FRESH');
    await tick(); // onFresh writes the cache a microtask later
    const cached = await caches.match(reqOf(SHELL_URL));
    expect(await cached.text()).toBe('FRESH');
  });

  it('falls back to the cache immediately when the network is fully offline', async () => {
    const c = await caches.open(sw.CACHE);
    await c.put(reqOf(SHELL_URL), resp('CACHED'));
    sandbox.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await sw.networkFirst(reqOf(SHELL_URL), sw.CACHE);
    expect(await result.text()).toBe('CACHED');
  });

  it('drops the API cache on a 401 (auth boundary)', async () => {
    const c = await caches.open(sw.API_CACHE);
    await c.put(reqOf(API_URL), resp('OLD-USER-DATA'));
    sandbox.fetch = async () => resp(null, { status: 401 });

    const result = await sw.networkFirst(reqOf(API_URL), sw.API_CACHE);
    expect(result.status).toBe(401);
    expect(caches._store.has(sw.API_CACHE)).toBe(false);
  });
});

describe('networkFirst — auth endpoints never serve stale', () => {
  let sw, sandbox, caches;
  beforeEach(() => {
    ({ sw, sandbox, caches } = loadSw());
  });

  it('returns 503 (not a cached copy) when an auth request fails, even if one is cached', async () => {
    // Pre-seed a cached /api/auth/me to prove it is deliberately ignored.
    const c = await caches.open(sw.API_CACHE);
    await c.put(reqOf(ME_URL), resp(JSON.stringify({ stale: true }), { status: 200 }));
    sandbox.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    const result = await sw.networkFirst(reqOf(ME_URL), sw.API_CACHE);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ offline: true });
  });

  it('does not arm the cache-fallback timeout for auth paths', async () => {
    // With no cached fallback armed, a stalled auth fetch must reject via the
    // catch (503) rather than be raced against the timeout. A never-resolving
    // fetch that still returns 503 quickly proves the timeout path was skipped.
    await (await caches.open(sw.API_CACHE)).put(reqOf(ME_URL), resp('stale'));
    let settled = false;
    sandbox.fetch = () =>
      new Promise((_res, rej) => setTimeout(() => rej(new TypeError('offline')), 5));
    const result = await sw.networkFirst(reqOf(ME_URL), sw.API_CACHE);
    settled = true;
    expect(settled).toBe(true);
    expect(result.status).toBe(503);
  });
});
