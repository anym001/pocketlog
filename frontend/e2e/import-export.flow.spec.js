// CSV import/export flow against a running PocketLog build.
//
// The UI counterpart of the backend import contract (and of the bank
// importer's contract tests): the happy path lands in the app's live state,
// a re-import only dedups, and a broken file renders the *translated*
// per-row error list (the coded-errors pipeline: backend
// {row, code, params} → importExport.error.* → list items). Export is
// asserted through the session API — the UI's exportCSV() detours into
// navigator.share where available, which device emulation makes flaky.
const { test, expect } = require('@playwright/test');
const { loginViaApi, expectNoRawKeys } = require('./helpers');

// Unique, run-scoped names: re-running against a reused container never
// collides with earlier data, and the dedup assertions only see this run's
// rows. Dates are "today" so the rows land in the current month's pool.
const RUN = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);
const DESC_A = `FlowImport A ${RUN}`;
const DESC_B = `FlowImport B ${RUN}`;
const CAT = `FlowCat ${RUN}`;
const TAG = `flowtag${RUN}`;

const GOOD_CSV = [
  'date;type;amount;description;category;tags',
  `${TODAY};out;12.34;${DESC_A};${CAT};${TAG}`,
  `${TODAY};in;56.78;${DESC_B};${CAT};`,
].join('\n');

const BROKEN_CSV = [
  'date;type;amount;description;category;tags',
  `not-a-date;out;9.99;${DESC_A} broken;${CAT};`,
  `${TODAY};out;not-a-number;${DESC_B} broken;${CAT};`,
].join('\n');

async function importCsv(page, csv, name) {
  // Drive the hidden file input directly — the visible button only forwards
  // a click to it, and importCSV(event) fires on the change event either way.
  await page.setInputFiles('#importFile', {
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf-8'),
  });
}

async function exportedCsv(page) {
  const res = await page.context().request.get('/api/export/csv');
  expect(res.ok()).toBeTruthy();
  return res.text();
}

test('import lands in app state, re-import dedups, broken rows render translated', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await page.goto('/');
  await expect(page.locator('.fab')).toBeVisible();

  // --- Happy path: status goes ok, the new category/tag exist as app state,
  //     and the imported row is findable through the search panel ---
  await importCsv(page, GOOD_CSV, 'flow-import.csv');
  const status = page.locator('#importStatus');
  await expect(status).toHaveClass(/ok/);
  await expect(status).toContainText('2');
  await expectNoRawKeys(page, 'import status (happy path)');

  await page.evaluate((q) => window.onSearch(q), DESC_A.toLowerCase());
  await expect(page.locator('#panel-search')).toHaveClass(/active/);
  await expect(page.locator('#searchResultsList')).toContainText(DESC_A);
  await page.evaluate(() => window.clearSearch());

  // --- Idempotency: the same file again imports nothing new; the export
  //     (the durable record) carries each description exactly once ---
  await importCsv(page, GOOD_CSV, 'flow-import.csv');
  await expect(status).toContainText('2'); // deduped count in the summary
  const csv = await exportedCsv(page);
  expect(csv.split(DESC_A).length - 1).toBe(1);
  expect(csv.split(DESC_B).length - 1).toBe(1);
  expect(csv).toContain(CAT);
  expect(csv).toContain(TAG);

  // --- Broken rows: per-row errors arrive as backend codes and must render
  //     as translated list items (the importExport.error.* pipeline) ---
  await importCsv(page, BROKEN_CSV, 'flow-broken.csv');
  await expect(status).toHaveClass(/err/);
  await expect(page.locator('#importStatus .import-error-list li')).toHaveCount(2);
  await expectNoRawKeys(page, 'import status (broken rows)');

  // Nothing from the broken file may have reached the ledger.
  const after = await exportedCsv(page);
  expect(after).not.toContain('broken');

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
