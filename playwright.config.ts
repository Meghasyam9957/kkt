/**
 * Playwright — real-browser QA for Srivillu (dev-only tooling, Phase B approval).
 *
 * The app under test runs in DEMO with the in-process dataset: deterministic, no
 * network, no credentials. Production configuration is never loaded here.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // The app under test is `next dev`, which compiles each route on first hit; a cold
  // route can take >30s when many workers land at once. Generous timeout, few workers.
  timeout: 90_000,
  fullyParallel: true,
  // Two workers: the app under test is ONE `next dev` process compiling routes on first
  // hit; three workers starve it on this machine and assertions race the compiler.
  workers: 2,
  retries: 1,
  // Route-level cold compiles regularly exceed Playwright's 5s default for the FIRST
  // assertion after a navigation or mutation.
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'reports/playwright', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3213',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The reset wipes global demonstration state; every spec here counts rows before
      // and after its own writes, so it must not run underneath them.
      testIgnore: /demo-reset\.spec\.ts/,
    },
    {
      // Runs only once the whole suite above has finished, so it is free to discard the
      // demonstration data the other specs were relying on.
      name: 'demo-reset',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /demo-reset\.spec\.ts/,
      dependencies: ['chromium'],
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 3213',
    url: 'http://localhost:3213/signin',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { APP_ENV: 'demo' },
  },
});
