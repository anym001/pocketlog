// Unit tests for the offline outbox replay (db.js → drain). Pins the
// regression where an offline edit appeared to save but reverted on
// reconnect: the page-side outbox drained without a CSRF token, the server
// rejected the replay with 403, and drain dead-lettered the user's change.
//
// fake-indexeddb gives db.js a real IndexedDB to talk to; fetch is stubbed so
// we can assert exactly what the replay sends and how each status is handled.
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import '../db.js';

const OB = globalThis.PocketLogOutbox;

// Minimal fetch Response stub: drain only reads .ok, .status and .text().
function reply(status) {
  return { ok: status >= 200 && status < 300, status, text: async () => '' };
}

let realFetch;
beforeEach(async () => {
  realFetch = globalThis.fetch;
  await OB.clear();
  await OB.failedClear();
  OB.setCsrfToken('');
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('PocketLogOutbox.drain', () => {
  it('replays with the CSRF header and removes the entry on success', async () => {
    OB.setCsrfToken('tok123');
    await OB.enqueue({ method: 'PUT', path: '/transactions/1', body: { amount: 27 } });
    const fetchMock = vi.fn(async () => reply(200));
    globalThis.fetch = fetchMock;

    const r = await OB.drain('/api');

    expect(r.ok).toBe(1);
    expect(r.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/transactions/1');
    expect(opts.method).toBe('PUT');
    expect(opts.headers['X-CSRF-Token']).toBe('tok123');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.body).toBe(JSON.stringify({ amount: 27 }));
    expect(await OB.count()).toBe(0);
  });

  // The actual bug: on iOS the drain runs in the page context (online event),
  // where the CSRF token used to never be set. Sending the replay anyway got a
  // 403 and the change was dead-lettered. drain must defer, not discard.
  it('defers without dead-lettering when no CSRF token is set', async () => {
    await OB.enqueue({ method: 'PUT', path: '/transactions/1', body: { amount: 27 } });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const r = await OB.drain('/api');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.deferred).toBe(1);
    expect(await OB.count()).toBe(1); // still queued for the next attempt
    expect(await OB.failedCount()).toBe(0); // and NOT dead-lettered
  });

  it('sends the CSRF header but no body/Content-Type for a DELETE', async () => {
    OB.setCsrfToken('tok');
    await OB.enqueue({ method: 'DELETE', path: '/transactions/9', body: null });
    const fetchMock = vi.fn(async () => reply(204));
    globalThis.fetch = fetchMock;

    await OB.drain('/api');

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-CSRF-Token']).toBe('tok');
    expect(opts.headers['Content-Type']).toBeUndefined();
    expect(opts.body).toBeUndefined();
  });

  it('dead-letters a 4xx rejection so it does not silently retry forever', async () => {
    OB.setCsrfToken('tok');
    await OB.enqueue({ method: 'PUT', path: '/transactions/1', body: { amount: 27 } });
    globalThis.fetch = vi.fn(async () => reply(400));

    const r = await OB.drain('/api');

    expect(r.ok).toBe(0);
    expect(r.failed).toBe(1);
    expect(await OB.count()).toBe(0);
    expect(await OB.failedCount()).toBe(1);
  });

  it('keeps the entry on a 5xx for a later retry', async () => {
    OB.setCsrfToken('tok');
    await OB.enqueue({ method: 'PUT', path: '/transactions/1', body: { amount: 27 } });
    globalThis.fetch = vi.fn(async () => reply(503));

    const r = await OB.drain('/api');

    expect(r.ok).toBe(0);
    expect(r.failed).toBe(0);
    expect(await OB.count()).toBe(1);
    expect(await OB.failedCount()).toBe(0);
  });

  it('keeps the entry and aborts on a 401 (re-login required)', async () => {
    OB.setCsrfToken('tok');
    await OB.enqueue({ method: 'PUT', path: '/transactions/1', body: { amount: 27 } });
    await OB.enqueue({ method: 'PUT', path: '/transactions/2', body: { amount: 5 } });
    const fetchMock = vi.fn(async () => reply(401));
    globalThis.fetch = fetchMock;

    const r = await OB.drain('/api');

    expect(r.ok).toBe(0);
    expect(r.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // aborts, doesn't burn the rest
    expect(await OB.count()).toBe(2);
    expect(await OB.failedCount()).toBe(0);
  });

  it('stops on a network error, keeping the entry queued', async () => {
    OB.setCsrfToken('tok');
    await OB.enqueue({ method: 'PUT', path: '/transactions/1', body: { amount: 27 } });
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    const r = await OB.drain('/api');

    expect(r.ok).toBe(0);
    expect(r.failed).toBe(0);
    expect(await OB.count()).toBe(1);
    expect(await OB.failedCount()).toBe(0);
  });
});
