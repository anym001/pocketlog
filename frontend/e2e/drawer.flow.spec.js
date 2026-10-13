// The drawer's two management lists — categories and tags.
//
// Nothing in the suite touched the drawer before this file. Two behaviours
// worth pinning live here:
//
//   1. The filter field is conditional. It costs a full row of a 300px panel,
//      so it appears only above DRAWER_FILTER_MIN entries and goes away again
//      when the list shrinks back under it. A threshold that silently drifts
//      would either clutter every short list or strand a long one, and neither
//      shows up in a screenshot of the state you happen to be in.
//   2. The tag rows are operable by keyboard. They were pointer-only while the
//      category rows beside them were not, and the CSS had focus states that
//      could never fire.
//
// Also covered: filtering narrows the list, and a query that matches nothing
// says so with different copy than an account that has nothing yet.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys } = require('./helpers');

const RUN = Date.now();
// Comfortably over the threshold on its own, so the count does not depend on
// what other specs left behind.
const TAGS = Array.from({ length: 14 }, (_, i) => `DrawerTag${RUN}_${String(i).padStart(2, '0')}`);
const ODD = `DrawerOdd${RUN}`;

const openTagPanel = async (page) => {
  await page.evaluate(() => window.openDrawer && window.openDrawer());
  await page.evaluate(() => window.drawerNav('dpTags'));
  await expect(page.locator('#dpTags')).toBeVisible();
};

const rowCount = (page) => page.locator('#tagList .cat-pill-edit').count();

// Distance from the "create" button to whatever follows it. The list is not
// the button's adjacent sibling any more — the filter field sits between them
// — so the gap comes from a different rule in each state and zero in one of
// them is a real regression, not a cosmetic one.
const gapBelowCreateButton = (page) =>
  page.evaluate(() => {
    const btn = document.querySelector('#dpTags .action-list');
    const wrap = document.getElementById('dpTagSearchWrap');
    const next = wrap.hidden ? document.getElementById('tagList') : wrap;
    return next.getBoundingClientRect().top - btn.getBoundingClientRect().bottom;
  });

test('drawer tag list: filter appears with the list, and rows work by keyboard', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // Start from a known set: whatever this account already has, plus enough of
  // our own to clear the threshold.
  await page.evaluate(
    async (names) => {
      for (const name of names) {
        try {
          await api('POST', '/tags', { name });
        } catch (e) {
          /* a rerun against the same instance already has it */
        }
      }
      await loadTags();
    },
    [...TAGS, ODD],
  );

  await openTagPanel(page);
  await expect(page.locator('#dpTagSearchWrap')).toBeVisible();
  expect(await gapBelowCreateButton(page), 'gap with the field shown').toBeGreaterThan(0);
  const total = await rowCount(page);
  expect(total).toBeGreaterThan(10);

  // Filtering narrows to the one row that matches.
  await page.fill('#dpTagSearch', ODD.toLowerCase());
  await expect(page.locator('#tagList .cat-pill-edit')).toHaveCount(1);
  // The row also carries its all-time usage count; the name is its label.
  await expect(page.locator('#tagList .cat-pill-edit .drawer-nav-label')).toHaveText(ODD);

  // A miss reads as a miss, not as an empty account.
  await page.fill('#dpTagSearch', `${ODD}-nothing-matches-this`);
  await expect(page.locator('#tagList .cat-pill-edit')).toHaveCount(0);
  await expect(page.locator('#tagList')).toHaveText(/gefunden|found/i);

  await page.fill('#dpTagSearch', '');
  await expect(page.locator('#tagList .cat-pill-edit')).toHaveCount(total);

  await expectNoRawKeys(page, 'drawer tag panel');

  // The row takes focus and Enter opens the rename modal on it — it was a bare
  // div with a click listener before.
  const first = page.locator('#tagList .cat-pill-edit').first();
  const name = (await first.locator('.drawer-nav-label').textContent()).trim();
  await first.focus();
  await expect(first).toBeFocused();
  await first.press('Enter');
  await expect(page.locator('#tagModalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#tagEditName')).toHaveValue(name);
  await page.evaluate(() => closeTagModal());
  await expect(page.locator('#tagModalOverlay')).not.toHaveClass(/open/);

  // Back under the threshold the field goes away, and it must not leave a
  // filter running behind it with no control left to clear.
  await page.evaluate(async (names) => {
    for (const n of names) {
      try {
        await api('DELETE', `/tags/${encodeURIComponent(n)}`);
      } catch (e) {
        /* already gone */
      }
    }
    await loadTags();
  }, TAGS);
  await openTagPanel(page);
  // The account is shared with the other specs, so "our tags are gone" does
  // not guarantee the list dropped under the threshold. Assert the rule the
  // field actually follows — visible exactly while the list is long enough —
  // rather than a count this spec cannot own.
  const remaining = await rowCount(page);
  const overThreshold = remaining > 10;
  await expect(page.locator('#dpTagSearchWrap'))[overThreshold ? 'toBeVisible' : 'toBeHidden']();
  if (!overThreshold) {
    expect(await page.evaluate(() => appState.drawer.filter.tags)).toBe('');
  }
  // The list must not butt against the button — with the field hidden it
  // contributes no margin of its own, which is the case that regressed.
  expect(await gapBelowCreateButton(page), 'gap below the create button').toBeGreaterThan(0);

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});

test('the drawer keeps focus to itself while open, and out of the way while closed', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // Closed, the drawer is only pushed off-screen — `inert` is what keeps its
  // ~70 controls from being the first thing every keyboard user walks through.
  await expect.poll(() => page.evaluate(() => document.getElementById('drawer').inert)).toBe(true);

  // Opening it hands focus over. The trap listens on the drawer itself, so it
  // can only wrap around once focus is already inside; without this the menu
  // opened and tabbing carried on through the page behind it.
  await page.click('.hamburger-btn');
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect.poll(() => page.evaluate(() => document.getElementById('drawer').inert)).toBe(false);
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement.closest('#drawer')), {
      message: 'focus moved into the open drawer',
    })
    .toBe(true);

  // Six tabs stay inside — the trap wraps rather than leaking into the page.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => !!document.activeElement.closest('#drawer')),
      `tab ${i + 1} stayed inside the drawer`,
    ).toBe(true);
  }

  // Boot's own panel restore runs at the end of a long load chain, well after
  // the auth overlay came down — it must not shut a drawer opened in that
  // window. Pinned as the contract rather than by timing: a navigation closes
  // the drawer, boot's restore does not.
  expect(
    await page.evaluate(() => document.getElementById('drawer').classList.contains('open')),
  ).toBe(true);
  await page.evaluate(() => window.showPanel('transactions', { keepDrawer: true }));
  await expect(page.locator('#drawer'), "boot's panel restore leaves the drawer open").toHaveClass(
    /open/,
  );
  await page.evaluate(() => window.showPanel('transactions'));
  await expect(page.locator('#drawer'), 'picking a destination closes the drawer').not.toHaveClass(
    /open/,
  );
  await page.click('.hamburger-btn');
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement.closest('#drawer')))
    .toBe(true);

  // Closing gives focus back and re-arms inert — in that order, or the browser
  // would drop focus to <body> as the subtree goes inert.
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  await expect.poll(() => page.evaluate(() => document.getElementById('drawer').inert)).toBe(true);
  expect(
    await page.evaluate(() => !!document.activeElement.closest('#drawer')),
    'focus is not stranded in the now-inert drawer',
  ).toBe(false);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

// Phone widths: the menus stay a narrow sheet over the app, a settings detail
// page takes the full width (DESIGN_CONVENTIONS "menus narrow, pages wide").
test('on a phone, menus stay narrow and settings detail pages use the full width', async ({
  page,
}) => {
  await loginViaApi(page.context());
  await bootIntoApp(page);
  const drawerWidth = () => page.evaluate(() => document.getElementById('drawer').offsetWidth);
  const viewport = page.viewportSize().width;

  await page.evaluate(() => window.openDrawer());
  await page.evaluate(() => window.drawerNav('dpSettings'));
  await expect.poll(drawerWidth).toBeLessThan(viewport);

  await page.evaluate(() => window.drawerNav('dpTags'));
  await expect(page.locator('#drawer')).toHaveClass(/detail-active/);
  await expect.poll(drawerWidth).toBe(viewport);

  // Back to the settings list: narrow again.
  await page.evaluate(() => window.drawerBack());
  await expect(page.locator('#drawer')).not.toHaveClass(/detail-active/);
  await expect.poll(drawerWidth).toBeLessThan(viewport);
});
