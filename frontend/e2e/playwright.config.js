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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
