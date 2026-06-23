// Shared plumbing for the Playwright specs.
//
// One account serves the whole suite: the smoke spec creates it through the
// first-run setup UI (the `smoke` project runs first via project
// dependencies, keeping that unique fresh-container coverage), and the flow
// specs authenticate against it via the API.
const { expect } = require('@playwright/test');

const ADMIN_USER = 'smokeadmin';
const ADMIN_PASS = 'Smoke-Passw0rd-123';

// Authenticate a browser context through the API. Handles both the fresh
// instance (creates the admin; a parallel worker losing the race gets 409
// and falls through to login) and the already-provisioned one. The cookies
// land in the context's jar — context.request shares it — so a subsequent
// page.goto('/') boots straight into the app.
async function loginViaApi(context) {
  const status = await context.request.get('/api/auth/setup-status');
  expect(status.ok()).toBeTruthy();
  const { needs_setup: needsSetup } = await status.json();
  if (needsSetup) {
    const setup = await context.request.post('/api/auth/setup', {
      data: { username: ADMIN_USER, password: ADMIN_PASS, locale: 'de-DE' },
    });
    if (setup.ok()) return; // setup issues the session cookies itself
    expect(setup.status(), 'setup race must fall through to login').toBe(409);
  }
  const login = await context.request.post('/api/auth/login', {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  expect(login.ok(), 'API login for the suite account').toBeTruthy();
}

// Top-level i18n namespaces (must mirror the keys in frontend/i18n/*.json).
// A visible "<namespace>.<something>" string means a key fell through to its
// raw form because the bundle lacked it — exactly the goals.* regression.
const NAMESPACES = [
  'app',
  'common',
  'menu',
  'nav',
  'header',
  'summary',
  'search',
  'fab',
  'auth',
  'pwd',
  'settings',
  'display',
  'catIcons',
  'categories',
  'goals',
  'budget',
  'tags',
  'tx',
  'reports',
  'forecast',
  'importExport',
  'admin',
  'users',
  'account',
  'sync',
  'date',
  'info',
];
const RAW_KEY_RE = new RegExp('\\b(' + NAMESPACES.join('|') + ')\\.[A-Za-z][A-Za-z0-9]+');

async function expectNoRawKeys(page, where) {
  const text = await page.locator('body').innerText();
  const match = text.match(RAW_KEY_RE);
  expect(match ? match[0] : null, `Untranslated i18n key visible in ${where}`).toBeNull();
}

// Boot the app as a logged-in user and wait until it is actually ready for
// writes. The FAB reports visible even behind the auth overlay (toBeVisible
// ignores occlusion), so it proves nothing; and window._csrfToken is only
// populated once /api/auth/me returns — a non-GET fired before that goes out
// without the CSRF header and gets a 403.
async function bootIntoApp(page) {
  await page.goto('/');
  await expect(page.locator('#setupView')).toBeHidden();
  await expect(page.locator('#loginView')).toBeHidden();
  // Polled via evaluate + toPass: waitForFunction needs eval, which the
  // app's CSP (script-src 'self') forbids.
  await expect(async () => {
    expect(await page.evaluate(() => window._csrfToken)).toBeTruthy();
  }).toPass({ timeout: 15000, intervals: [100, 250, 500] });
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

module.exports = { ADMIN_USER, ADMIN_PASS, loginViaApi, bootIntoApp, expectNoRawKeys, gotoPanel };
