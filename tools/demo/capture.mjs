// Capture the README screenshots from a seeded PocketLog instance.
//
// Prerequisite: a running instance already seeded by seed.py (same demo
// account). Renders the key views in the app's primary form factor (Pixel 5,
// the mobile-first viewport the UI is designed for) and writes PNGs to
// docs/screenshots/. Light theme throughout, plus one dark-theme shot to show
// theming.
//
// Env: BASE_URL (default http://127.0.0.1:8000),
//      ADMIN_USERNAME / ADMIN_PASSWORD (must match seed.py),
//      OUT_DIR (default ../../docs/screenshots relative to this file).
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium, devices } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const USERNAME = process.env.ADMIN_USERNAME || 'demo';
const PASSWORD = process.env.ADMIN_PASSWORD || 'Demo-Account-2026!';
const OUT_DIR = process.env.OUT_DIR || resolve(HERE, '../../docs/screenshots');

async function boot(context) {
  const login = await context.request.post('/api/auth/login', {
    data: { username: USERNAME, password: PASSWORD },
  });
  if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()}`);
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('.fab').waitFor({ state: 'visible', timeout: 15000 });
  // _csrfToken is set once /api/auth/me resolves; poll via evaluate (the app's
  // CSP forbids waitForFunction's eval).
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => window._csrfToken)) break;
    await page.waitForTimeout(150);
  }
  return page;
}

async function showPanel(page, id) {
  await page.evaluate((p) => window.showPanel(p), id);
  await page.locator(`#panel-${id}`).and(page.locator('.active')).waitFor({ timeout: 10000 });
  await page.waitForTimeout(600); // let charts/render settle
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  console.log(`wrote ${name}.png`);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['Pixel 5'],
    baseURL: BASE_URL,
    colorScheme: 'light',
  });
  const page = await boot(context);
  await page.evaluate(() => window.saveTheme('light'));

  await showPanel(page, 'transactions');
  await shot(page, 'ledger');

  await page.evaluate(() => window.showPanel('charts'));
  await page.evaluate(() => window.renderReport('categories'));
  await page.locator('#reportBody').waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await shot(page, 'reports');

  await showPanel(page, 'goals');
  await shot(page, 'goals');

  // Dark-theme variant of the ledger to showcase theming.
  await page.evaluate(() => window.saveTheme('dark'));
  await showPanel(page, 'transactions');
  await shot(page, 'ledger-dark');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
