// Recurring-rule lifecycle against a running PocketLog build.
//
// Covers the domain logic the smoke only brushes: a monthly rule starting
// today materializes its occurrence through the catch-up (run on every
// /api/auth/me and transactions GET), skip-next advances the cursor without
// booking, deactivation sticks, and deleting the rule leaves the
// materialized transactions intact (source_rule_id → NULL).
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys, gotoPanel } = require('./helpers');

const RUN = Date.now();
const RULE_NAME = `FlowRule ${RUN}`;
// Materialized bookings carry the rule's description — unique so the search
// assertions only ever see this run's booking.
const RULE_DESC = `FlowRuleBooking ${RUN}`;

test('rule materializes, skip-next advances, delete keeps bookings', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // --- Create a monthly rule via the modal (defaults: type=out, monthly,
  //     start=today, first category, unlimited) ---
  await page.evaluate(() => window.openRecurringModal());
  await expect(page.locator('#recurringModalOverlay')).toHaveClass(/open/);
  await page.fill('#recEditName', RULE_NAME);
  await page.fill('#recEditAmount', '9,99');
  await page.fill('#recEditDescription', RULE_DESC);
  await page.evaluate(() => window.saveRecurringEdit());
  await expect(page.locator('#recurringModalOverlay')).not.toHaveClass(/open/);

  await gotoPanel(page, 'recurring');
  await expect(page.locator('#recurringViewList')).toContainText(RULE_NAME);
  await expectNoRawKeys(page, 'recurring view');

  // --- A fresh boot runs the catch-up: today's occurrence is booked and the
  //     cursor has moved past it ---
  await bootIntoApp(page);
  await page.evaluate((q) => window.onSearch(q), RULE_DESC.toLowerCase());
  await expect(page.locator('#searchResultsList')).toContainText(RULE_DESC);
  await page.evaluate(() => window.clearSearch());

  // appState.recurring.rules loads via its own call after the reload, so the
  // booking search passing does not yet guarantee the rules array is filled —
  // poll until the rule (and its server-advanced cursor) is present.
  await expect
    .poll(
      () =>
        page.evaluate((name) => appState.recurring.rules.some((x) => x.name === name), RULE_NAME),
      { timeout: 15000 },
    )
    .toBe(true);
  const rule = await page.evaluate((name) => {
    const r = appState.recurring.rules.find((x) => x.name === name);
    return { id: r.id, next: r.next_occurrence_date };
  }, RULE_NAME);
  expect(rule.next).toBeTruthy();

  // --- Skip-next advances the cursor without creating a booking ---
  await page.evaluate((id) => window.openRecurringModal(id), rule.id);
  await expect(page.locator('#recurringModalOverlay')).toHaveClass(/open/);
  await page.evaluate(() => window.skipNextRecurringOccurrence());
  await expect
    .poll(() =>
      page.evaluate(
        (id) => appState.recurring.rules.find((x) => x.id === id).next_occurrence_date,
        rule.id,
      ),
    )
    .not.toBe(rule.next);
  await page.evaluate(() => window.closeRecurringModal());

  // --- Deactivation sticks ---
  await page.evaluate((id) => window.openRecurringModal(id), rule.id);
  await expect(page.locator('#recurringModalOverlay')).toHaveClass(/open/);
  await page.uncheck('#recEditActive');
  await page.evaluate(() => window.saveRecurringEdit());
  await expect(page.locator('#recurringModalOverlay')).not.toHaveClass(/open/);
  await expect
    .poll(() =>
      page.evaluate((id) => appState.recurring.rules.find((x) => x.id === id).active, rule.id),
    )
    .toBe(false);

  // --- Delete: the rule disappears, the materialized booking survives ---
  await page.evaluate((id) => window.openRecurringModal(id), rule.id);
  await expect(page.locator('#recurringModalOverlay')).toHaveClass(/open/);
  await page.click('#recDeleteBtn');
  await page.click('.confirm-yes');
  await expect(page.locator('#recurringModalOverlay')).not.toHaveClass(/open/);
  await gotoPanel(page, 'recurring');
  await expect(page.locator('#recurringViewList')).not.toContainText(RULE_NAME);

  await page.evaluate((q) => window.onSearch(q), RULE_DESC.toLowerCase());
  await expect(page.locator('#searchResultsList')).toContainText(RULE_DESC);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
