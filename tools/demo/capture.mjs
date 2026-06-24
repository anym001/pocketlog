// Capture the README screenshots from a seeded PocketLog instance.
//
// Prerequisite: a running instance already seeded by seed.py (same demo
// account). Produces a two-tier gallery:
//   - a wide desktop hero (sidebar layout, dark theme)
//   - a row of mobile views (Pixel 5, the app's primary form factor, light):
//     ledger, category report, goals, budgets, categories, recurring
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

async function boot(context, theme) {
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
  await page.evaluate((t) => window.saveTheme(t), theme);
  return page;
}

async function showPanel(page, id) {
  await page.evaluate((p) => window.showPanel(p), id);
  await page.locator(`#panel-${id}`).and(page.locator('.active')).waitFor({ timeout: 10000 });
  await page.waitForTimeout(600); // let charts/render settle
}

async function categoryReport(page) {
  await page.evaluate(() => window.showPanel('charts'));
  await page.evaluate(() => window.renderReport('breakdown'));
  await page.locator('#reportBody').waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  console.log(`wrote ${name}.png`);
}

async function captureMobile(browser) {
  const context = await browser.newContext({
    ...devices['Pixel 5'],
    baseURL: BASE_URL,
    colorScheme: 'light',
  });
  const page = await boot(context, 'light');

  await showPanel(page, 'transactions');
  await shot(page, 'ledger');

  await categoryReport(page);
  await shot(page, 'reports');

  await showPanel(page, 'goals');
  await shot(page, 'goals');

  await showPanel(page, 'budgets');
  await shot(page, 'budgets');

  await showPanel(page, 'categories');
  await shot(page, 'categories');

  await showPanel(page, 'recurring');
  await shot(page, 'recurring');

  await context.close();
}

async function captureDesktop(browser) {
  // The wide README hero: the persistent sidebar layout (≥768px) in dark
  // theme, showing the ledger — the app's primary view.
  const context = await browser.newContext({
    baseURL: BASE_URL,
    colorScheme: 'dark',
    viewport: { width: 1280, height: 832 },
    deviceScaleFactor: 2,
  });
  const page = await boot(context, 'dark');
  await showPanel(page, 'transactions');
  await shot(page, 'desktop');
  await context.close();
}

async function main() {
  const browser = await chromium.launch();
  await captureMobile(browser);
  await captureDesktop(browser);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
