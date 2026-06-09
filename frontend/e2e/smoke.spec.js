// UI smoke against a running PocketLog build. Catches the class of bug that
// backend pytest + a /api/health ping cannot see: the frontend rendering
// broken for a real user — e.g. untranslated i18n keys leaking into the DOM
// (the goals.* / nav.goals regression), a view that fails to mount, an
// uncaught exception on load, or the app's mutable state (transactions /
// categories / reportRange and the render functions reading them) drifting
// out of sync.
//
// One test, one session: first-run setup, then every core view, then a real
// transaction CRUD round-trip + report render. Staying in a single session
// (no second login) keeps it deterministic — the setup path is the only one a
// fresh CI container exercises. This behavioural net is what the pure-helper
// Vitest suite deliberately does NOT cover.
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

// Drive the app's own navigation directly rather than clicking the nav item:
// the drawer's open animation makes a real click flaky, and the post-login
// init runs showPanel(loadDefaultView()) after the data loads, which can land
// *after* our navigation on a slow runner and steal the active panel. toPass
// re-navigates until the target panel sticks.
async function gotoPanel(page, id) {
  await expect(async () => {
    await page.evaluate((p) => window.showPanel(p), id);
    await expect(page.locator(`#panel-${id}`)).toHaveClass(/active/, { timeout: 1000 });
  }).toPass({ timeout: 15000, intervals: [200, 500, 1000] });
}

test('first-run setup, core views, and a transaction CRUD round-trip', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');

  // Both auth views live in the DOM permanently (toggled via the [hidden]
  // attribute), so match on the *visible* one only. The app reveals one
  // asynchronously after fetching /api/auth/setup-status.
  const setup = page.locator('#setupView:not([hidden])');
  await page
    .locator('#setupView:not([hidden]), #loginView:not([hidden])')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });

  // Fresh image → first-run setup. (Fallback: a reused volume already has an
  // admin, so log in instead — not a path CI normally hits.)
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

  // Auth overlay dismissed (toggled via [hidden]). Wait for that explicitly:
  // the FAB behind the overlay already reports visible (toBeVisible ignores
  // occlusion), so without this a still-present overlay would intercept clicks
  // on a slow runner.
  await expect(page.locator('#setupView')).toBeHidden();
  await expect(page.locator('#loginView')).toBeHidden();
  await expect(page.locator('.fab')).toBeVisible();
  await expectNoRawKeys(page, 'main view');

  // Drawer carries the nav labels (incl. nav.goals).
  await page.click('.hamburger-btn');
  await expect(page.locator('[data-panel="goals"]')).toBeVisible();
  await expectNoRawKeys(page, 'navigation drawer');

  // Goals view renders (the goals.* i18n regression lived here).
  await gotoPanel(page, 'goals');
  await expectNoRawKeys(page, 'goals view');

  // --- Create a transaction via the booking modal ---
  await gotoPanel(page, 'transactions');
  const desc = 'Smoke ' + Date.now();
  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  // de-DE is the default locale, so the amount field expects a comma decimal
  // (parseAmount treats '.' as a thousands separator there).
  await page.fill('#inputAmount', '12,50');
  await page.fill('#inputDesc', desc);
  // Category select is pre-populated with the seeded categories and the date
  // defaults to today, so the row lands in the current month's view.
  await page.click('#submitBtn');

  // Modal closes and the new row shows up in the ledger.
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  const row = page.locator('#transactionList .tx-row', { hasText: desc });
  await expect(row).toBeVisible();
  await expectNoRawKeys(page, 'ledger after create');

  // --- Report view renders with that data (exercises the report aggregation
  //     over reportRange + the freshly mutated transaction state) ---
  await gotoPanel(page, 'charts');
  await expect(page.locator('#reportBody')).not.toBeEmpty();
  await expectNoRawKeys(page, 'report view');

  // --- Edit modal opens, then delete the transaction ---
  await gotoPanel(page, 'transactions');
  const id = await row.getAttribute('data-id');
  // Open the edit modal through the same entry point the inline onclick uses
  // (avoids the swipe/tap gesture handler, which is flaky to drive).
  await page.evaluate((txId) => window.editTransaction(Number(txId)), id);
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#deleteBtn')).toBeVisible();
  await page.click('#deleteBtn');
  // Custom confirm dialog (not window.confirm).
  await page.click('.confirm-yes');

  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#transactionList .tx-row', { hasText: desc })).toHaveCount(0);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
