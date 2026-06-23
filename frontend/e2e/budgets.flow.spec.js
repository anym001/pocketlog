// Budget lifecycle against a running PocketLog build.
//
// Pins the 1:1 category↔budget contract end-to-end: consumption is derived
// from the linked category's expenses (never stored), a second budget on the
// same category is rejected (409 → translated toast), the category cannot be
// deleted while the budget references it, and deleting the budget leaves the
// bookings untouched.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys, gotoPanel } = require('./helpers');

const RUN = Date.now();
const CAT = `FlowBudgetCat ${RUN}`;
const TX_DESC = `FlowBudgetTx ${RUN}`;

test('budget usage, category conflicts and delete protection', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // --- A dedicated category, so the usage math sees only this run ---
  await page.evaluate(() => window.openCatModal());
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await page.fill('#catEditName', CAT);
  await page.evaluate(() => window.saveCategoryEdit());
  await expect(page.locator('#catModalOverlay')).not.toHaveClass(/open/);

  // --- Budget on that category: 100 per month ---
  await page.evaluate(() => window.openBudgetModal());
  await expect(page.locator('#budgetModalOverlay')).toHaveClass(/open/);
  await page.selectOption('#budgetEditCategory', { label: CAT });
  await page.fill('#budgetEditAmount', '100');
  await page.selectOption('#budgetEditFrequency', 'monthly');
  await page.evaluate(() => window.saveBudgetEdit());
  await expect(page.locator('#budgetModalOverlay')).not.toHaveClass(/open/);

  await gotoPanel(page, 'budgets');
  const card = page.locator('#budgetsViewList .budget-card', { hasText: CAT });
  await expect(card).toBeVisible();
  await expectNoRawKeys(page, 'budgets view');

  // --- An expense booking in the category drives the derived usage:
  //     25 of 100 → the card shows 25 % ---
  await gotoPanel(page, 'transactions');
  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await page.evaluate(() => window.setType('out'));
  await page.fill('#inputAmount', '25');
  await page.fill('#inputDesc', TX_DESC);
  await page.selectOption('#inputCat', { label: CAT });
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  await gotoPanel(page, 'budgets');
  await expect(card).toContainText('25%');

  // --- 1:1 contract: a second budget on the same category is a 409, surfaced
  //     as a translated toast; the twin is never created ---
  await page.evaluate(() => window.openBudgetModal());
  await expect(page.locator('#budgetModalOverlay')).toHaveClass(/open/);
  await page.selectOption('#budgetEditCategory', { label: CAT });
  await page.fill('#budgetEditAmount', '50');
  await page.evaluate(() => window.saveBudgetEdit());
  // .last(): error toasts dwell 5 s, so an earlier one may still be alive —
  // a bare locator would then be ambiguous under strict mode.
  await expect(page.locator('#toastHost .toast.error').last()).toBeVisible();
  await expectNoRawKeys(page, 'budget conflict toast');
  await page.evaluate(() => window.closeBudgetModal());

  // --- Delete protection: the category is blocked while the budget (and the
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

  // --- Deleting the budget keeps the bookings ---
  await page.evaluate((name) => {
    const cat = appState.ledger.categories.find((c) => c.name === name);
    const budget = appState.budgets.list.find((b) => b.category_id === cat.id);
    window.openBudgetModal(budget.id);
  }, CAT);
  await expect(page.locator('#budgetModalOverlay')).toHaveClass(/open/);
  await page.click('#budgetDeleteBtn');
  await page.click('.confirm-yes');
  await expect(page.locator('#budgetModalOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#budgetsViewList .budget-card', { hasText: CAT })).toHaveCount(0);

  await page.evaluate((q) => window.onSearch(q), TX_DESC.toLowerCase());
  await expect(page.locator('#searchResultsList')).toContainText(TX_DESC);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
