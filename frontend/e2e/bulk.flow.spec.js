// Report drill-down + bulk-edit flow against a running PocketLog build.
//
// Pins two related UX regressions that share a single root cause: drilling
// into a category or tag from a report activated the search panel but never
// cleared body.in-report. CSS hides .bottom-bar under that class, so both
// the search-exit FAB *and* the multi-select selection bar were invisible —
// users could mark rows but had no way to act on them or return to the report.
//
// Covered in sequence:
//   1. Category drill-down: search panel opens, transaction visible in results.
//   2. body.in-report is gone (root cause).
//   3. .bottom-bar and the search-exit FAB are visible.
//   4. Entering selection mode shows the selection bar and all four bulk-action
//      buttons (the regression: bar was hidden because .bottom-bar was).
//   5. clearSearch() returns to the report panel via searchExitTarget and
//      reinstates body.in-report.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys, gotoPanel } = require('./helpers');

const RUN = Date.now();
const CAT = `FlowBulkCat ${RUN}`;
const TX_DESC = `FlowBulkTx ${RUN}`;

test('report drill-down: bottom bar visible, bulk selection bar works, exit returns to report', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // A dedicated category so the drill-down result list contains exactly
  // this run's transaction and nothing else.
  await page.evaluate(() => window.openCatModal());
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await page.fill('#catEditName', CAT);
  await page.evaluate(() => window.saveCategoryEdit());
  await expect(page.locator('#catModalOverlay')).not.toHaveClass(/open/);

  // An expense in that category so the report has a row to drill into.
  await gotoPanel(page, 'transactions');
  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await page.evaluate(() => window.setType('out'));
  await page.fill('#inputAmount', '20');
  await page.fill('#inputDesc', TX_DESC);
  await page.selectOption('#inputCat', { label: CAT });
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  // Navigate to the report panel and render the category breakdown so that
  // the category row for CAT is logically available.
  await gotoPanel(page, 'charts');
  await page.evaluate(() => window.renderReport('categories'));
  await expect(page.locator('#reportBody')).not.toBeEmpty();
  await expectNoRawKeys(page, 'category report view');

  // Drill into the category using the same JS entry point the cat-row onclick
  // calls — drives the exact code path the user hits.
  const catId = await page.evaluate(
    (name) => appState.ledger.categories.find((c) => c.name === name)?.id,
    CAT,
  );
  expect(catId, 'test category must exist in appState before drill-down').toBeTruthy();

  // drillDownCategory is async (fetches the report range's transactions);
  // evaluate awaits the returned Promise.
  await page.evaluate((id) => window.drillDownCategory(id), catId);

  // 1. Search panel active; the drilled-in transaction is visible.
  await expect(page.locator('#panel-search')).toHaveClass(/active/);
  await expect(page.locator('#searchResultsList')).toContainText(TX_DESC);
  await expectNoRawKeys(page, 'drill-down search results');

  // 2. body.in-report must be cleared (root-cause assertion).
  const hasInReport = await page.evaluate(() => document.body.classList.contains('in-report'));
  expect(hasInReport, 'body.in-report must be cleared when entering the drill-down').toBe(false);

  // 3. Bottom bar (housing both FAB and selection bar) must be visible.
  await expect(page.locator('.bottom-bar')).toBeVisible();
  await expect(page.locator('.fab')).toBeVisible();

  // 4. Enter selection mode: the selection bar must replace the FAB/search
  //    form and all four bulk-action buttons must be reachable.
  await page.evaluate(() => window.enterSelectionMode());
  await expect(page.locator('.selection-bar')).toBeVisible();
  await expect(page.locator('.selection-bar [data-bulk-action]')).toHaveCount(4);
  await expectNoRawKeys(page, 'selection bar');

  // Exit selection mode; the FAB is restored, the bar hides.
  await page.evaluate(() => window.exitSelectionMode());
  await expect(page.locator('.selection-bar')).not.toBeVisible();
  await expect(page.locator('.fab')).toBeVisible();

  // 5. clearSearch() must return to the charts panel via searchExitTarget
  //    and reinstate body.in-report.
  await page.evaluate(() => window.clearSearch());
  await expect(page.locator('#panel-charts')).toHaveClass(/active/);
  const hasInReportAfter = await page.evaluate(() =>
    document.body.classList.contains('in-report'),
  );
  expect(hasInReportAfter, 'body.in-report must be restored after exiting the drill-down').toBe(
    true,
  );
  await expectNoRawKeys(page, 'report panel after drill-down exit');

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
