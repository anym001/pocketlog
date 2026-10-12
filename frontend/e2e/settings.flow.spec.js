// Settings split view (≥768 px): a settings sub-panel opens in the content
// pane while the sidebar keeps the settings list, and every way out puts the
// panel node back into the drawer. The rest of the suite runs on a phone
// viewport, so this spec pins the tablet/desktop path explicitly.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp } = require('./helpers');

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

const inHost = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#settingsHost > .drawer-panel')].map((e) => e.id),
  );

test('settings sub-panels open in the content pane and return to the drawer', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await loginViaApi(page.context());
  await bootIntoApp(page);

  await page.evaluate(() => window.drawerNav('dpSettings'));
  await page.click('#dpSettings [data-args=\'["dpAccount"]\']');
  expect(await inHost(page)).toEqual(['dpAccount']);
  await expect(page.locator('body')).toHaveClass(/settings-detail/);
  await expect(page.locator('#dpSettings')).toHaveAttribute('data-state', 'active');
  await expect(page.locator('#dpSettings [data-args=\'["dpAccount"]\']')).toHaveClass(/active/);
  await expect(page.locator('.bottom-bar')).toBeHidden();

  // Switching entries swaps the detail; the previous one goes home.
  await page.click('#dpSettings [data-args=\'["dpInfo"]\']');
  expect(await inHost(page)).toEqual(['dpInfo']);
  await expect(page.locator('#drawer #dpAccount')).toHaveCount(1);

  // The in-pane back button closes the detail and stays in Settings.
  await page.click('#settingsHost .drawer-back-btn');
  expect(await inHost(page)).toEqual([]);
  await expect(page.locator('#drawer #dpInfo')).toHaveCount(1);
  await expect(page.locator('#dpSettings')).toHaveAttribute('data-state', 'active');

  // Esc closes it too.
  await page.click('#dpSettings [data-args=\'["dpTags"]\']');
  await page.keyboard.press('Escape');
  expect(await inHost(page)).toEqual([]);
  await expect(page.locator('body')).not.toHaveClass(/settings-detail/);

  // Shrinking to a phone hands the open panel back to the drawer as its
  // active sub-panel; widening again moves it back out. The breakpoint
  // listener fires asynchronously after a resize, so these checks poll.
  await page.click('#dpSettings [data-args=\'["dpImport"]\']');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#drawer #dpImport')).toHaveAttribute('data-state', 'active');
  await expect.poll(() => inHost(page)).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => inHost(page)).toEqual(['dpImport']);

  // Picking a destination closes the detail.
  await page.evaluate(() => window.showPanel('transactions'));
  expect(await inHost(page)).toEqual([]);
  await expect(page.locator('#panel-transactions')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
