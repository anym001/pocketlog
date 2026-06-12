// UI smoke against a running PocketLog build. Catches the class of bug that
// backend pytest + a /api/health ping cannot see: the frontend rendering
// broken for a real user — e.g. untranslated i18n keys leaking into the DOM
// (the goals.* / nav.goals regression), a view that fails to mount, an
// uncaught exception on load, or the app's mutable state (transactions /
// categories / reportRange and the render functions reading them) drifting
// out of sync.
//
// One test, one session: first-run setup, every core view, then the
// state-mutating flows a `state.js` refactor would touch — category, tag and
// recurring-rule creation; transaction CRUD; full-text search; report range +
// trend rendering; and the display settings (theme / currency / default view /
// locale) that re-style or force a full i18n re-render. The aim is breadth
// across the module-global clusters so a missed state read/write anywhere
// surfaces here. Staying in a single session (no second login) keeps it
// deterministic — the setup path is the only one a fresh CI container
// exercises. This behavioural net is what the pure-helper Vitest suite
// deliberately does NOT cover; together they are the precondition for safely
// encapsulating the module-global state.
const { test, expect } = require('@playwright/test');
// Shared suite plumbing: the account constants, the raw-i18n-key net and the
// panel navigation live in helpers.js since the flow specs need them too.
const { ADMIN_USER, ADMIN_PASS, expectNoRawKeys, gotoPanel } = require('./helpers');

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

  // --- Create a category (exercises the `categories` state mutation and the
  //     re-render that follows: the categories panel, the booking modal's
  //     dropdown, and the report grouping all read this list) ---
  const catName = 'SmokeCat ' + Date.now();
  // openCatModal()/saveCategoryEdit() are the functions the drawer's
  // "Kategorie erstellen" button and the modal's save button call. Driving
  // them directly avoids the animated drawer slide-in, which is flaky to
  // click; the modal markup and the state path are identical either way.
  await page.evaluate(() => window.openCatModal());
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await page.fill('#catEditName', catName);
  // saveCategoryEdit is async (POST /categories → reload → re-render);
  // evaluate awaits the returned promise so the assertions below are stable.
  await page.evaluate(() => window.saveCategoryEdit());
  await expect(page.locator('#catModalOverlay')).not.toHaveClass(/open/);
  await gotoPanel(page, 'categories');
  await expect(page.locator('#categoryViewList')).toContainText(catName);
  await expectNoRawKeys(page, 'categories view');

  // --- Create a tag (the `tags` state list feeds the tag picker, the search
  //     drill-down and the booking/recurring tag pills) ---
  const tagName = 'smoketag' + Date.now();
  await page.evaluate(() => window.openTagModal());
  await expect(page.locator('#tagModalOverlay')).toHaveClass(/open/);
  await page.fill('#tagEditName', tagName);
  await page.evaluate(() => window.saveTagEdit());
  await expect(page.locator('#tagModalOverlay')).not.toHaveClass(/open/);
  // renderTagList() writes the chip into the (closed) drawer tag list; the
  // node's text updates regardless of the drawer's visibility.
  await expect(page.locator('#tagList')).toContainText(tagName);

  // --- Create a recurring rule (the `recurringRules` list + its render, plus
  //     the materialization that books the first occurrence). Only name and
  //     amount need filling — openRecurringModal pre-selects type=out,
  //     monthly, start=today, the first seeded category and validity=unlimited. ---
  const recName = 'SmokeRule ' + Date.now();
  await page.evaluate(() => window.openRecurringModal());
  await expect(page.locator('#recurringModalOverlay')).toHaveClass(/open/);
  await page.fill('#recEditName', recName);
  await page.fill('#recEditAmount', '9,99');
  await page.evaluate(() => window.saveRecurringEdit());
  await expect(page.locator('#recurringModalOverlay')).not.toHaveClass(/open/);
  await gotoPanel(page, 'recurring');
  await expect(page.locator('#recurringViewList')).toContainText(recName);
  await expectNoRawKeys(page, 'recurring view');

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

  // --- Search: a query flips to the search panel and filters by description
  //     (exercises _searchQuery + the global _allTransactions pool and the
  //     search render reading that state), then clears back out ---
  await page.evaluate((q) => window.onSearch(q), desc);
  await expect(page.locator('#panel-search')).toHaveClass(/active/);
  await expect(page.locator('#searchResultsList')).toContainText(desc);
  await expectNoRawKeys(page, 'search results');
  await page.evaluate(() => window.clearSearch());
  await expect(page.locator('#panel-search')).not.toHaveClass(/active/);

  // --- Report view renders with that data (exercises the report aggregation
  //     over reportRange + the freshly mutated transaction state) ---
  await gotoPanel(page, 'charts');
  await expect(page.locator('#reportBody')).not.toBeEmpty();
  await expectNoRawKeys(page, 'report view');

  // Switching the range kind re-points reportRange and re-aggregates. The
  // segmented tabs are static buttons (no drawer animation), so a real click
  // is safe here. Today's transaction falls inside month/quarter/year alike,
  // so the body stays populated throughout.
  for (const kind of ['quarter', 'year', 'month']) {
    await page.click(`#rangeKindTabs button[data-kind="${kind}"]`);
    await expect(page.locator(`#rangeKindTabs button[data-kind="${kind}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
  await expect(page.locator('#reportBody')).not.toBeEmpty();
  await expectNoRawKeys(page, 'report view after range switch');

  // Render the spending-trend sub-view explicitly. It is not the default
  // report tab, so without this the trend math (the _bucket*/_trend*
  // calendar helpers in reportsData.js) would never execute in the browser
  // and a regression there would slip past the smoke. Driven through the
  // same renderReport entry point the report tab switch calls.
  await page.evaluate(() => window.renderReport('trend'));
  await expect(page.locator('#reportBody')).not.toBeEmpty();
  await expectNoRawKeys(page, 'report trend view');

  // --- Settings cluster (theme / currency / default view): display
  //     preferences that re-style or re-render live, separate from the ledger
  //     data. Driven through the same globals the display <select>s call. ---
  await gotoPanel(page, 'transactions');
  // Theme: applyTheme sets data-theme on <html> synchronously.
  await page.evaluate(() => window.saveTheme('dark'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Currency: re-renders every formatted amount via i18n:changed. The row
  // carries a formatted amount, so EUR→USD swaps its symbol; restore EUR so
  // the rest of the run is unaffected.
  await page.evaluate(() => window.saveCurrency('USD'));
  await expect(row).toContainText('$');
  await page.evaluate(() => window.saveCurrency('EUR'));
  await expect(row).toContainText('€');
  // Default view is a persisted preference with no immediate visual change;
  // assert it reached localStorage (the path still runs through pushSettings).
  await page.evaluate(() => window.saveDefaultView('charts'));
  expect(await page.evaluate(() => localStorage.getItem('pocketlog.defaultView'))).toBe('charts');

  // --- Edit modal opens, then delete the transaction ---
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

  // --- Locale switch: a state cluster entirely separate from the ledger
  //     (settings → I18N → i18n:changed → applyStatic re-translates every
  //     data-i18n node). Driven through the same global the display <select>
  //     calls. We force *both* directions and assert the concrete bundle
  //     value each time, so the check exercises a real re-render regardless of
  //     the locale this session happened to start in (a server that already
  //     persisted en-GB must not make this a no-op). reports.overview is the
  //     #reportTitle key: "Übersicht" (de) / "Overview" (en). ---
  await page.evaluate(() => window.saveLocale('de-DE'));
  await expect(page.locator('#reportTitle')).toHaveText('Übersicht');
  await page.evaluate(() => window.saveLocale('en-GB'));
  await expect(page.locator('#reportTitle')).toHaveText('Overview');
  await expectNoRawKeys(page, 'after locale switch to English');

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
