// Playwright config for the UI smoke. Targets a *running* PocketLog
// instance (the booted Docker image in CI, or a local uvicorn) via
// BASE_URL. No webServer here on purpose — the smoke job already boots the
// container and health-checks it before these tests run.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Fail the build if someone leaves test.only in.
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8000',
    trace: 'on-first-retry',
  },
  projects: [
    // Mobile viewport throughout: PocketLog is mobile-first and switches to a
    // persistent sidebar at >=768px (the hamburger is hidden there). Pixel 5
    // is chromium-based (~393px wide), so the drawer/hamburger flows the
    // specs drive match the app's primary form factor.
    //
    // The smoke spec runs first (project dependency): it owns the one-time
    // first-run setup UI path and creates the suite account; the flow specs
    // (*.flow.spec.js) then authenticate against it via the API
    // (helpers.loginViaApi).
    { name: 'smoke', testMatch: /smoke\.spec\.js/, use: { ...devices['Pixel 5'] } },
    {
      name: 'flows',
      testMatch: /\.flow\.spec\.js$/,
      dependencies: ['smoke'],
      use: { ...devices['Pixel 5'] },
    },
  ],
});
