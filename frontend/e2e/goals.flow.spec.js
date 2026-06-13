// Savings-goal lifecycle against a running PocketLog build.
//
// Pins the 1:1 category↔goal contract end-to-end: progress is derived from
// the linked category's bookings (never stored), a second goal on the same
// category is rejected (409 → translated toast), the category cannot be
// deleted while the goal references it, and deleting the goal leaves the
// bookings untouched.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys, gotoPanel } = require('./helpers');

const RUN = Date.now();
const CAT = `FlowGoalCat ${RUN}`;
const GOAL = `FlowGoal ${RUN}`;
const TX_DESC = `FlowGoalTx ${RUN}`;

test('goal progress, category conflicts and delete protection', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // --- A dedicated category, so the progress math sees only this run ---
  await page.evaluate(() => window.openCatModal());
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await page.fill('#catEditName', CAT);
  await page.evaluate(() => window.saveCategoryEdit());
  await expect(page.locator('#catModalOverlay')).not.toHaveClass(/open/);

  // --- Goal on that category: save up to 500 starting today ---
  await page.evaluate(() => window.openGoalModal());
  await expect(page.locator('#goalModalOverlay')).toHaveClass(/open/);
  await page.fill('#goalEditName', GOAL);
  await page.selectOption('#goalEditCategory', { label: CAT });
  await page.fill('#goalEditInitial', '0');
  await page.fill('#goalEditTarget', '500');
  await page.evaluate(() => window.saveGoalEdit());
  await expect(page.locator('#goalModalOverlay')).not.toHaveClass(/open/);

  await gotoPanel(page, 'goals');
  const card = page.locator('#goalsViewList .goal-card', { hasText: GOAL });
  await expect(card).toBeVisible();
  await expectNoRawKeys(page, 'goals view');

  // --- An income booking in the category drives the derived progress:
  //     100 of 500 → the card shows 20 % ---
  await gotoPanel(page, 'transactions');
  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await page.evaluate(() => window.setType('in'));
  await page.fill('#inputAmount', '100');
  await page.fill('#inputDesc', TX_DESC);
  await page.selectOption('#inputCat', { label: CAT });
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  await gotoPanel(page, 'goals');
  await expect(card).toContainText('20');

  // --- 1:1 contract: a second goal on the same category is a 409, surfaced
  //     as a translated toast; the twin is never created ---
  await page.evaluate(() => window.openGoalModal());
  await expect(page.locator('#goalModalOverlay')).toHaveClass(/open/);
  await page.fill('#goalEditName', `${GOAL} twin`);
  await page.selectOption('#goalEditCategory', { label: CAT });
  await page.fill('#goalEditInitial', '0');
  await page.fill('#goalEditTarget', '300');
  await page.evaluate(() => window.saveGoalEdit());
  // .last(): error toasts dwell 5 s, so an earlier one may still be alive —
  // a bare locator would then be ambiguous under strict mode.
  await expect(page.locator('#toastHost .toast.error').last()).toBeVisible();
  await expectNoRawKeys(page, 'goal conflict toast');
  await page.evaluate(() => window.closeGoalModal());
  await expect(page.locator('#goalsViewList .goal-card', { hasText: `${GOAL} twin` })).toHaveCount(
    0,
  );

  // --- Delete protection: the category is blocked while the goal (and the
  //     booking) reference it ---
  await page.evaluate((name) => {
    const cat = appState.ledger.categories.find((c) => c.name === name);
    window.openCatModal(cat.id);
  }, CAT);
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await page.click('#catDeleteBtn');
  await page.click('.confirm-yes');
  await expect(page.locator('#toastHost .toast.error').last()).toBeVisible();
  await page.evaluate(() => window.closeCatModal());
  await expect
    .poll(() =>
      page.evaluate((name) => appState.ledger.categories.some((c) => c.name === name), CAT),
    )
    .toBe(true);

  // --- Deleting the goal keeps the bookings ---
  await page.evaluate((name) => {
    const goal = appState.goals.list.find((g) => g.name === name);
    window.openGoalModal(goal.id);
  }, GOAL);
  await expect(page.locator('#goalModalOverlay')).toHaveClass(/open/);
  await page.click('#goalDeleteBtn');
  await page.click('.confirm-yes');
  await expect(page.locator('#goalModalOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#goalsViewList .goal-card', { hasText: GOAL })).toHaveCount(0);

  await page.evaluate((q) => window.onSearch(q), TX_DESC.toLowerCase());
  await expect(page.locator('#searchResultsList')).toContainText(TX_DESC);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
