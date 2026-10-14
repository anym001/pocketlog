// Instant start: a browser that had a signed-in user draws the last synced
// state from the service worker's API cache before the server has answered,
// then replaces it with fresh data. Reopening the app after a long pause on
// iOS hands it a dead connection that takes seconds to recover; without this
// the app showed nothing for that long.
//
// The service worker is blocked here so the page's own requests can be held
// or failed with page.route (a controlling worker would make them where the
// test cannot reach). Its API cache is filled by hand instead — the app reads
// it straight from Cache Storage, exactly as it would with a worker.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp } = require('./helpers');

test.use({ serviceWorkers: 'block' });

const RUN = Date.now();

// Boot once (writes the session hint), book a recognisable entry into the
// visible month, and store the boot slices the way the worker would.
async function primeInstantStart(page, desc) {
  await loginViaApi(page.context());
  await bootIntoApp(page);
  await page.evaluate(async (d) => {
    const c = appState.ledger.categories[0];
    await api('POST', '/transactions', {
      amount: '12.34',
      desc: d,
      category_id: c.id,
      date: _iso(appState.view.year, appState.view.month, 1),
      type: 'out',
      tags: [],
    });
    const cache = await caches.open('pocketlog-api-e2e');
    const paths = ['/categories', '/tags', '/goals', '/budgets', '/recurring'];
    paths.push(_monthTransactionsPath());
    for (const p of paths) {
      const res = await fetch(API + p, { credentials: 'same-origin' });
      await cache.put(new URL(API + p, location.href).href, res);
    }
  }, desc);
  expect(await page.evaluate(() => !!_readSessionHint())).toBe(true);
}

const appReady = (page) => page.evaluate(() => appState.boot.ready);

test('the last synced state shows before the session check returns', async ({ page }) => {
  const desc = `InstantCached ${RUN}`;
  await primeInstantStart(page, desc);

  // Hold every API request — the dead connection after a long pause. The
  // cached state has to appear without any of them answering.
  let release;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/**', async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  await expect(page.locator('#loginView')).toBeHidden();
  await expect(page.locator('.tx-row', { hasText: desc })).toBeVisible({ timeout: 2000 });
  expect(await appReady(page)).toBe(false);

  // The server answers: the fresh pass takes over without re-navigating.
  release();
  await expect.poll(() => appReady(page), { timeout: 15000 }).toBe(true);
  await expect(page.locator('.tx-row', { hasText: desc })).toBeVisible();
});

test('a session the server rejects ends on an empty login view, hint gone', async ({ page }) => {
  const desc = `InstantSignedOut ${RUN}`;
  await primeInstantStart(page, desc);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.reload();
  await expect(page.locator('#loginView')).toBeVisible();
  // Nothing of the cached state stays behind the login view.
  await expect(page.locator('.tx-row', { hasText: desc })).toHaveCount(0);
  expect(await page.evaluate(() => _readSessionHint())).toBeNull();
});

test('an unreachable server keeps the cached state and confirms later', async ({ page }) => {
  const desc = `InstantOffline ${RUN}`;
  await primeInstantStart(page, desc);
  await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.locator('.tx-row', { hasText: desc })).toBeVisible();
  await expect(page.locator('#loginView')).toBeHidden();
  await expect.poll(() => page.evaluate(() => appState.boot.authPending)).toBe(true);

  // Back online: the session is confirmed and the fresh pass runs.
  await page.unroute('**/api/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => appReady(page), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => appState.boot.authPending)).toBe(false);
});
