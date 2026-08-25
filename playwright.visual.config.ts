/**
 * VISUAL EVIDENCE CAPTURE — a deliberate command, never a side effect.
 *
 * `e2e/visual.spec.ts` does not assert; it WRITES the screenshots in
 * reports/visual/phase-c/, which are tracked, human-reviewed phase sign-off evidence.
 * While it sat in the default project, any `npx playwright test` silently rewrote that
 * record with whatever demonstration rows happened to exist at that moment — the
 * committed set drifted by exactly one ₹1,234 expense once `demo-state.spec.ts` joined
 * the suite.
 *
 * A separate project inside the main config would not have fixed it: Playwright runs
 * every declared project by default, so the capture would still have fired. Hence a
 * config of its own, selected explicitly:
 *
 *     npm run e2e:visual
 *
 * Everything else — base URL, web server, timeouts, viewports, the capture calls
 * themselves — is inherited from playwright.config.ts unchanged.
 */
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  projects: [
    {
      name: 'visual',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /visual\.spec\.ts/,
    },
  ],
  /*
   * One worker, unlike the default two. The capture shares the in-process demo store
   * with itself: its own write-flow keyframes record an expense, and under two workers
   * that expense can land in a dashboard being photographed on the other worker. Serial
   * capture is what makes a re-run comparable to the last one.
   */
  workers: 1,
});
