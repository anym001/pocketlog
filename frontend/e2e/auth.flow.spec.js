// Auth lifecycle against a running PocketLog build.
//
// Runs entirely on a throwaway user the admin creates, so the shared suite
// account (smokeadmin, reused by every other flow spec) is never mutated.
// Covers: an admin-created account is forced onto the change-password view on
// first login, the password policy surfaces a translated (non-raw-key) error,
// and changing the password invalidates every *other* session while keeping
// the one that performed the change.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys } = require('./helpers');

const RUN = Date.now();
const USER = `flowuser${RUN}`;
// All satisfy the policy (>= 12 chars, four classes). TEMP is admin-set, so
// the user lands in force-change; the two strong passwords differ so the
// modal's "must differ" check passes.
const TEMP_PASS = 'Flow-Temp-Pass-1';
const PASS_1 = 'Flow-Strong-Pass-1';
const PASS_2 = 'Flow-Strong-Pass-2';

// Authenticate a fresh context via the API. The login response seeds the
// context cookie jar; the browser (not the Node-side request client) then
// attaches the Secure cookies over http to 127.0.0.1 on the next navigation.
async function apiLogin(context, username, password) {
  const res = await context.request.post('/api/auth/login', {
    data: { username, password },
  });
  expect(res.ok(), `login for ${username}`).toBeTruthy();
}

// Raw status of a session probe, fetched through the browser so the Secure
// session cookie is attached. Uses fetch (not the app's api()) to avoid the
// 401-triggered location.reload() in the app helper.
const sessionStatus = (page) =>
  page.evaluate(() => fetch('/api/transactions').then((r) => r.status));

test('force-change on first login, password policy, and session invalidation', async ({
  browser,
}) => {
  // --- Admin creates a throwaway user (admin-created ⇒ force_change_password) ---
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await loginViaApi(adminCtx);
  await bootIntoApp(adminPage);
  const created = await adminPage.evaluate(
    ([u, p]) =>
      window
        .api('POST', '/admin/users', { username: u, password: p })
        .then(() => true)
        .catch((e) => e.message),
    [USER, TEMP_PASS],
  );
  expect(created).toBe(true);

  // --- First login lands on the forced change-password view ---
  const userCtx = await browser.newContext();
  const userPage = await userCtx.newPage();
  const errs = [];
  userPage.on('pageerror', (e) => errs.push(e.message));
  await apiLogin(userCtx, USER, TEMP_PASS);
  await userPage.goto('/');
  await expect(userPage.locator('#forcePwView')).toBeVisible();
  await expectNoRawKeys(userPage, 'force-change view');

  // Weak password → translated policy error, no raw key, still on the view.
  await userPage.fill('#forcePwNew', 'weak');
  await userPage.fill('#forcePwConfirm', 'weak');
  await userPage.evaluate(() => window.submitForcePassword());
  await expect(userPage.locator('#forcePwError')).toBeVisible();
  await expectNoRawKeys(userPage, 'force-change error');
  await expect(userPage.locator('#forcePwView')).toBeVisible();

  // Strong password → the app proceeds to the main view.
  await userPage.fill('#forcePwNew', PASS_1);
  await userPage.fill('#forcePwConfirm', PASS_1);
  await userPage.evaluate(() => window.submitForcePassword());
  await expect(userPage.locator('#forcePwView')).toBeHidden();
  await expect(userPage.locator('.fab')).toBeVisible();
  await expect.poll(() => userPage.evaluate(() => window._csrfToken)).toBeTruthy();

  // --- A second, independent session for the same user ---
  const otherCtx = await browser.newContext();
  const otherPage = await otherCtx.newPage();
  await apiLogin(otherCtx, USER, PASS_1);
  await otherPage.goto('/');
  await expect(otherPage.locator('.fab')).toBeVisible();
  // Don't let the app's own 401 handler reload this page mid-assertion.
  await otherPage.evaluate(() => {
    window._suppressAuthReload = true;
  });
  expect(await sessionStatus(otherPage)).toBe(200);

  // --- Change the password in the first session → the other one dies ---
  await userPage.evaluate(() => window.openChangePasswordModal());
  await expect(userPage.locator('#pwModalOverlay')).toHaveClass(/open/);
  await userPage.fill('#pwModalCurrent', PASS_1);
  await userPage.fill('#pwModalNew', PASS_2);
  await userPage.fill('#pwModalConfirm', PASS_2);
  await userPage.evaluate(() => window.submitChangePassword());
  await expect(userPage.locator('#pwModalOverlay')).not.toHaveClass(/open/);

  // The session that changed the password stays valid …
  expect(await sessionStatus(userPage)).toBe(200);
  // … every other session is invalidated.
  await expect.poll(() => sessionStatus(otherPage)).toBe(401);

  expect(errs, `Uncaught page errors: ${errs.join(' | ')}`).toEqual([]);

  await adminCtx.close();
  await userCtx.close();
  await otherCtx.close();
});
