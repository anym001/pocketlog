// UI smoke against a running PocketLog build. Catches the class of bug that
// backend pytest + a /api/health ping cannot see: the frontend rendering
// broken for a real user — e.g. untranslated i18n keys leaking into the DOM
// (the goals.* / nav.goals regression), a view that fails to mount, or an
// uncaught exception on load.
const { test, expect } = require('@playwright/test');

const ADMIN_USER = 'smokeadmin';
const ADMIN_PASS = 'Smoke-Passw0rd-123';

// Top-level i18n namespaces (must mirror the keys in frontend/i18n/*.json).
// A visible "<namespace>.<something>" string means a key fell through to its
// raw form because the bundle lacked it — exactly the goals.* regression.
const NAMESPACES = [
  'app', 'common', 'menu', 'nav', 'header', 'summary', 'search', 'fab',
  'auth', 'pwd', 'settings', 'display', 'catIcons', 'categories', 'goals',
  'tags', 'tx', 'reports', 'forecast', 'importExport', 'admin', 'users',
  'account', 'sync', 'date', 'info',
];
const RAW_KEY_RE = new RegExp(
  '\\b(' + NAMESPACES.join('|') + ')\\.[A-Za-z][A-Za-z0-9]+'
);

async function expectNoRawKeys(page, where) {
  const text = await page.locator('body').innerText();
  const match = text.match(RAW_KEY_RE);
  expect(match ? match[0] : null, `Untranslated i18n key visible in ${where}`).toBeNull();
}

test('first-run setup, then core UI renders without raw i18n keys', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');

  // Both auth views live in the DOM permanently (toggled via the [hidden]
  // attribute), so match on the *visible* one only — `.or()` over both would
  // resolve to 2 elements and trip Playwright's strict mode. The app reveals
  // one asynchronously after fetching /api/auth/setup-status.
  const setup = page.locator('#setupView:not([hidden])');
  const login = page.locator('#loginView:not([hidden])');
  await page
    .locator('#setupView:not([hidden]), #loginView:not([hidden])')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });

  // Fresh image → first-run setup screen. (Fallback: if an admin already
  // exists from a reused volume, log in instead.)
  if (await setup.count()) {
    await page.fill('#setupUsername', ADMIN_USER);
    await page.fill('#setupPassword', ADMIN_PASS);
    await page.fill('#setupPasswordConfirm', ADMIN_PASS);
    await page.click('#setupForm button[type="submit"]');
  } else {
    await page.fill('#loginUsername', ADMIN_USER);
    await page.fill('#loginPassword', ADMIN_PASS);
    await page.click('#loginSubmit');
  }

  // Setup/login dismisses the auth overlay (toggled via [hidden]). Wait for
  // that explicitly: the FAB behind the overlay already reports visible
  // (toBeVisible ignores occlusion), so without this the still-present
  // #setupView intercepts the hamburger click below on a slow runner.
  await expect(page.locator('#setupView')).toBeHidden();
  await expect(page.locator('#loginView')).toBeHidden();

  // Main app is up once the FAB (new-transaction button) is mounted.
  await expect(page.locator('.fab')).toBeVisible();
  await expectNoRawKeys(page, 'main view');

  // Drawer carries the nav labels (incl. nav.goals).
  await page.click('.hamburger-btn');
  await expect(page.locator('[data-panel="goals"]')).toBeVisible();
  await expectNoRawKeys(page, 'navigation drawer');

  // Navigate to the goals view. Drive the app's own navigation directly
  // rather than clicking the nav item — the drawer's open animation makes a
  // real click flaky, and the nav label itself was already asserted above.
  // Retry: the post-login init runs showPanel(loadDefaultView()) after the
  // category/tag/goal loads, which can land *after* our navigation on a slow
  // runner and steal the active panel. toPass re-navigates until it sticks.
  await expect(async () => {
    await page.evaluate(() => window.showPanel('goals'));
    await expect(page.locator('#panel-goals')).toHaveClass(/active/, { timeout: 1000 });
  }).toPass({ timeout: 15000, intervals: [200, 500, 1000] });
  await expectNoRawKeys(page, 'goals view');

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
