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

// Some paths reload the page themselves; a poll landing mid-navigation just
// counts as "not ready yet".
const appReady = (page) => page.evaluate(() => appState.boot.ready).catch(() => false);

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
  expect(await page.evaluate(() => caches.has('pocketlog-api-e2e'))).toBe(false);
});

test('an unreachable server keeps the cached state and confirms later', async ({ page }) => {
  const desc = `InstantOffline ${RUN}`;
  await primeInstantStart(page, desc);
  await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.locator('.tx-row', { hasText: desc })).toBeVisible();
  await expect(page.locator('#loginView')).toBeHidden();
  await expect.poll(() => page.evaluate(() => appState.boot.authPending)).toBe(true);
  // The header says it: not connected, last synced state.
  await expect(page.locator('#syncDot')).toHaveClass(/offline/);

  // Back online: the session is confirmed and the fresh pass runs.
  await page.unroute('**/api/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => appReady(page), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => appState.boot.authPending)).toBe(false);
});

test('writes stay blocked until the server has confirmed the session', async ({ page }) => {
  const desc = `InstantWriteGate ${RUN}`;
  await primeInstantStart(page, desc);
  let writes = 0;
  let release;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/**', async (route) => {
    if (route.request().method() !== 'GET') writes++;
    await held;
    await route.continue();
  });
  await page.reload();
  await expect(page.locator('.tx-row', { hasText: desc })).toBeVisible({ timeout: 2000 });

  // Before the confirmation a write never leaves the page (nor lands in the
  // outbox): the cached state could belong to a session revoked elsewhere.
  const blocked = await page.evaluate(async () => {
    try {
      await api('DELETE', '/transactions/1');
      return false;
    } catch (e) {
      return e.status === 0;
    }
  });
  expect(blocked).toBe(true);
  // The auth helper's writes too (admin user management).
  const adminBlocked = await page.evaluate(async () => {
    try {
      await authFetch('POST', '/admin/users', { username: 'x', password: 'y' });
      return false;
    } catch (e) {
      return e.status === 0;
    }
  });
  expect(adminBlocked).toBe(true);
  expect(writes).toBe(0);

  release();
  await expect.poll(() => appReady(page), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => appState.boot.sessionConfirmed)).toBe(true);
});

test('no session cookie, no cached state', async ({ page, context }) => {
  const desc = `InstantNoCookie ${RUN}`;
  await primeInstantStart(page, desc);
  // The session ended (cookies expired or cleared) — the hint alone must not
  // put the cached finances on screen, even for a moment.
  await context.clearCookies();
  let release;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/**', async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  await page.waitForTimeout(1000);
  await expect(page.locator('.tx-row', { hasText: desc })).toHaveCount(0);
  release();
  await expect(page.locator('#loginView')).toBeVisible();
  await expect(page.locator('.tx-row', { hasText: desc })).toHaveCount(0);
  expect(await page.evaluate(() => _readSessionHint())).toBeNull();
  expect(await page.evaluate(() => caches.has('pocketlog-api-e2e'))).toBe(false);
});

test('a confirmed session of another account discards the cached state', async ({ page }) => {
  const desc = `InstantOtherUser ${RUN}`;
  await primeInstantStart(page, desc);
  const realId = await page.evaluate(() => appState.admin.me.id);
  // The cached state was written for another account on this browser.
  await page.evaluate(() => {
    const h = JSON.parse(localStorage.getItem('pocketlog.sessionHint'));
    localStorage.setItem('pocketlog.sessionHint', JSON.stringify({ ...h, id: h.id + 1000 }));
  });
  await page.reload();
  // Reset + reload, then a regular boot for the real account.
  await expect.poll(() => appReady(page), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => caches.has('pocketlog-api-e2e'))).toBe(false);
  expect(await page.evaluate(() => appState.boot.fromCache)).toBe(false);
  expect(await page.evaluate(() => _readSessionHint().id)).toBe(realId);
});

test('an auth proxy redirect drops the cached state and re-authenticates once', async ({
  page,
}) => {
  const desc = `InstantGate ${RUN}`;
  await primeInstantStart(page, desc);
  // SSO forward auth in front of PocketLog: its session ended, so it answers
  // API calls with a redirect to its own login.
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 302, headers: { Location: 'https://sso.invalid/login' } }),
  );
  await page.reload();
  // One navigation to /?reauth (which a real proxy would answer with its
  // login page); the loop guard then stops on PocketLog's own login view.
  await expect(page).toHaveURL(/[?&]reauth=\d+/);
  await expect(page.locator('#loginView')).toBeVisible();
  await expect(page.locator('.tx-row', { hasText: desc })).toHaveCount(0);
  expect(await page.evaluate(() => _readSessionHint())).toBeNull();
  expect(await page.evaluate(() => caches.has('pocketlog-api-e2e'))).toBe(false);
});

test('signing out before the session is confirmed ends it on the server', async ({
  page,
  context,
}) => {
  const desc = `InstantLogout ${RUN}`;
  await primeInstantStart(page, desc);
  // Only the session check is unreachable; the sign-out itself gets through.
  await page.route('**/api/auth/me', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.locator('.tx-row', { hasText: desc })).toBeVisible();
  expect(await page.evaluate(() => appState.boot.sessionConfirmed)).toBe(false);

  await page.evaluate(() => logoutWithConfirm());
  await expect(page.locator('#loginView')).toBeVisible();
  // Not just a local reset: the server no longer knows the session.
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);
  await expect(page.locator('.tx-row', { hasText: desc })).toHaveCount(0);
  expect(await page.evaluate(() => caches.has('pocketlog-api-e2e'))).toBe(false);
});

test("another account signing in never inherits this browser's data", async ({ page, context }) => {
  const desc = `InstantHandover ${RUN}`;
  await primeInstantStart(page, desc);
  // A second household member.
  const other = { username: `member${RUN}`, password: 'Member-Passw0rd-123' };
  const csrf = (await context.cookies()).find((c) => c.name === 'pocketlog_csrf').value;
  const created = await context.request.post('/api/admin/users', {
    data: other,
    headers: { 'X-CSRF-Token': csrf },
  });
  expect(created.ok()).toBeTruthy();
  const { id: otherId } = await created.json();
  // The first account left an offline write behind, then its session ended.
  await page.evaluate(() =>
    window.PocketLogOutbox.enqueue({ method: 'DELETE', path: '/transactions/1', body: null }),
  );
  await context.clearCookies();
  await page.reload();
  await expect(page.locator('#loginView')).toBeVisible();

  await page.fill('#loginUsername', other.username);
  await page.fill('#loginPassword', other.password);
  await page.click('#loginSubmit');
  await expect(page.locator('#loginView')).toBeHidden();
  // Cache and outbox of the first account are gone before anything loads.
  expect(await page.evaluate(() => caches.has('pocketlog-api-e2e'))).toBe(false);
  expect(await page.evaluate(() => window.PocketLogOutbox.count())).toBe(0);
  expect(await page.evaluate(() => _readDataOwner())).toBe(otherId);
});
