// View scaffold: every view has the same large title and one create action in
// the same spot (the FAB); the category view stays a quick-entry launcher.
//
// The regressions it pins: goals/budgets/recurring used to carry their own
// full-width "Create …" button and hid the bottom bar; hiding the bottom-bar
// search field must not hide the category search inside the editors (both use
// .search-wrap); and a category-view quick entry must close untouched without
// a "Discard?" prompt (the category preset used to count as an edit).
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, gotoPanel, modalSettled } = require('./helpers');

// Titles and labels are compared through the app's own tr(): the suite
// account's language is whatever an earlier spec left it at.
const FAB_TARGETS = [
  { panel: 'goals', title: 'nav.title.goals', overlay: 'goalModalOverlay' },
  { panel: 'budgets', title: 'nav.title.budgets', overlay: 'budgetModalOverlay' },
  { panel: 'recurring', title: 'nav.title.recurring', overlay: 'recurringModalOverlay' },
];

const t = (page, key) => page.evaluate((k) => window.I18N.t(k), key);

test('each view has its title and the FAB creates what the view lists', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await loginViaApi(page.context());
  await bootIntoApp(page);

  await gotoPanel(page, 'transactions');
  await expect(page.locator('#viewTitle')).toHaveText(await t(page, 'nav.title.transactions'));

  for (const v of FAB_TARGETS) {
    await gotoPanel(page, v.panel);
    await expect(page.locator('#viewTitle')).toHaveText(await t(page, v.title));
    // The FAB stays; only the search field leaves (nothing to search here).
    await expect(page.locator('.fab')).toBeVisible();
    await expect(page.locator('#searchInput')).toBeHidden();
    await page.click('.fab');
    await expect(page.locator(`#${v.overlay}`)).toHaveClass(/open/);
    await modalSettled(page, v.overlay);
    // The editor's own category search must survive the bottom-bar rule.
    await expect(page.locator(`#${v.overlay} .cat-chooser-search`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(`#${v.overlay}`)).not.toHaveClass(/open/);
  }

  // Reports: the FAB books a transaction, the large title is the report's own.
  await page.evaluate(() => window.openReport('overview'));
  await expect(page.locator('#viewHead')).toBeHidden();
  await expect(page.locator('.fab')).toHaveAttribute(
    'aria-label',
    await t(page, 'fab.newTransaction'),
  );

  expect(pageErrors).toEqual([]);
});

test('category view: the row books into it, the receipt button lists its bookings', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await loginViaApi(page.context());
  await bootIntoApp(page);

  await gotoPanel(page, 'categories');
  await expect(page.locator('#viewTitle')).toHaveText(await t(page, 'nav.title.categories'));
  const row = page.locator('#categoryViewList .cat-view-row').first();
  const catId = Number(JSON.parse(await row.getAttribute('data-args'))[0]);

  // Row → a new booking preset to the row's category…
  await row.click({ position: { x: 24, y: 24 } });
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  expect(await page.evaluate(() => appState.catChooser.transaction.selectedId)).toBe(catId);
  // …that closes untouched without asking to discard anything. Not awaited:
  // a dirty form would park closeModal on its confirm dialog.
  await page.evaluate(() => {
    window.closeModal();
  });
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('.confirm-modal')).toHaveCount(0);

  // Receipt button → that category's bookings; the FAB turns into "exit search".
  await page.locator('#categoryViewList .cat-view-list').first().click();
  await expect(page.locator('#panel-search')).toHaveClass(/active/);
  expect(await page.evaluate(() => appState.nav.categoryFilterId)).toBe(catId);
  await expect(page.locator('.fab')).toHaveAttribute('aria-label', await t(page, 'fab.exitSearch'));

  // Exiting search returns to the view without opening a booking.
  await page.click('.fab');
  await expect(page.locator('#panel-categories')).toHaveClass(/active/);
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  expect(pageErrors).toEqual([]);
});
