// "Detailanalyse": one category or tag over the report period. It is the
// drill-down target of the other reports (a row in "Aufteilung", a month in
// "Trend"), offers the way back to where the drill-down came from, and keeps
// the ledger search — with its bulk actions — one link away.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys, gotoPanel } = require('./helpers');

const RUN = Date.now();
const CAT = `FlowDetailCat ${RUN}`;
const TAG = `flowdetail${RUN}`;

const t = (page, key) => page.evaluate((k) => window.I18N.t(k), key);

test('detail report: drill-down, breakdown, sorting, ledger link and the way back', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await loginViaApi(page.context());
  await bootIntoApp(page);

  // A dedicated category with two expenses (one tagged) and a tagged refund,
  // all inside the current month (the report's default period).
  const catId = await page.evaluate(
    async ({ cat, tag }) => {
      const c = await api('POST', '/categories', { name: cat });
      const now = new Date();
      const day = (d) => _iso(now.getFullYear(), now.getMonth(), d);
      const tx = (amount, d, type, tags, desc) =>
        api('POST', '/transactions', { amount, desc, category_id: c.id, date: day(d), type, tags });
      await tx('20.00', 1, 'out', [tag], 'DetailBig');
      await tx('5.00', 2, 'out', [], 'DetailSmall');
      await tx('3.00', 2, 'in', [tag], 'DetailRefund');
      await loadCategories();
      return c.id;
    },
    { cat: CAT, tag: TAG },
  );

  // "Aufteilung" → the category's row opens its detail, with a way back.
  await gotoPanel(page, 'charts');
  await page.evaluate(() => {
    window.openReport('breakdown');
    window.setRangeKind('month');
  });
  await page.click(`#reportBody .cat-row[data-args='["cat:${catId}"]']`);
  await expect(page.locator('#reportTitle')).toHaveText(await t(page, 'reports.detail'));
  await expect(page.locator('#reportBack')).toBeVisible();
  await expect(page.locator('#reportBackLabel')).toHaveText(await t(page, 'reports.breakdown'));
  await expect(page.locator('#detailActiveRow')).toContainText(CAT);
  await expect(page.locator('#reportRangeLabel')).toContainText('3');
  await expectNoRawKeys(page, 'detail report');

  // Both directions present → expenses, income, balance and the average.
  await expect(page.locator('#reportBody .report-kpis .summary-card')).toHaveCount(4);
  // Spending breakdown by tag: the tagged expense and the untagged rest; the
  // refund stays out of it.
  const inner = page.locator('#reportBody .report-section').filter({
    hasText: await t(page, 'reports.expensesByTag'),
  });
  await expect(inner.locator('.cat-row')).toHaveCount(2);
  await expect(inner).toContainText(await t(page, 'reports.untagged'));

  // Every booking, newest first; "Betrag" puts the largest first.
  const rows = page.locator('#detailTxList .report-tx-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).not.toContainText('DetailBig');
  await page.click('#detailSort [data-sort="amount"]');
  await expect(rows.first()).toContainText('DetailBig');
  await expect(page.locator('#detailSort [data-sort="amount"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // A tag row in the breakdown switches the detail to that tag; the way back
  // still leads to "Aufteilung".
  await inner.locator(`[data-tag-drill="${TAG}"]`).click();
  await expect(page.locator('#detailActiveRow')).toContainText(TAG);
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#reportBackLabel')).toHaveText(await t(page, 'reports.breakdown'));

  // The ledger link opens the search (bulk actions live there); exiting it
  // comes back to the detail report.
  await page.click('#reportBody .report-link');
  await expect(page.locator('#panel-search')).toHaveClass(/active/);
  await expect(page.locator('#searchResultsList')).toContainText('DetailBig');
  await page.evaluate(() => window.clearSearch());
  await expect(page.locator('#panel-charts')).toHaveClass(/active/);
  await expect(page.locator('#reportTitle')).toHaveText(await t(page, 'reports.detail'));

  // Back → the origin report, and the link is gone again.
  await page.click('#reportBack');
  await expect(page.locator('#reportTitle')).toHaveText(await t(page, 'reports.breakdown'));
  await expect(page.locator('#reportBack')).toBeHidden();

  // A wider period draws month bars instead of the running lines.
  await page.evaluate((id) => window.openDetail(`cat:${id}`), catId);
  await page.evaluate(() => window.setRangeKind('year'));
  await expect(page.locator('#detailChart')).toBeVisible();
  expect(await page.evaluate(() => chartInsts.detail.config.type)).toBe('bar');

  // "Trend": a tap on a month opens that month's detail for the entity.
  await page.evaluate(() => window.openReport('trend'));
  await expect(page.locator('#reportTitle')).toHaveText(await t(page, 'reports.trend'));
  await page.evaluate((id) => {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    _drillTrendMonth(`cat:${id}`, key);
  }, catId);
  await expect(page.locator('#reportTitle')).toHaveText(await t(page, 'reports.detail'));
  await expect(page.locator('#reportBackLabel')).toHaveText(await t(page, 'reports.trend'));
  expect(await page.evaluate(() => appState.reports.range.kind)).toBe('month');
  await expect(page.locator('#detailTxList .report-tx-row')).toHaveCount(3);

  // From the menu there is no origin to go back to.
  await page.evaluate(() => window.openReport('detail'));
  await expect(page.locator('#reportBack')).toBeHidden();

  expect(pageErrors).toEqual([]);
});
