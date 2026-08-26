/**
 * B1 SMOKE — the browser facts the redesign must keep true, at every approved width.
 *
 * These are the regressions this phase fixed, pinned in a real browser so they cannot
 * quietly return: horizontal overflow, the invisible logo, the investor's dead-end
 * landing, four nav items active at once, and an inaccessible mobile drawer.
 */
import { test, expect, type Page } from '@playwright/test';

const WIDTHS = [375, 390, 768, 1024, 1440, 1920] as const;

async function signInAs(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  // `/admin` is a redirect hop to the role's landing screen; waiting for the URL alone
  // resolves mid-redirect and later steps race the second navigation. The shell's
  // sidebar only exists once the landing page has actually rendered.
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('.sv-sidebar');
}

/* ------------------------------------------------------------------ *
 * No horizontal overflow, at any width, signed out and signed in
 * ------------------------------------------------------------------ */
for (const width of WIDTHS) {
  test(`no horizontal overflow at ${width}px (sign-in and dashboard)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/signin');
    const signinOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(signinOverflow, 'sign-in page must not scroll sideways').toBeLessThanOrEqual(0);

    await signInAs(page, 'Demo Administrator');
    await page.goto('/admin/dashboard');
    await page.waitForSelector('.sv-kpi');
    const dashboardOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(dashboardOverflow, 'dashboard must not scroll sideways').toBeLessThanOrEqual(0);
  });
}

/* ------------------------------------------------------------------ *
 * Logo visibility — the cream-on-white regression, permanently pinned
 * ------------------------------------------------------------------ */
test('the wordmark is legible on the sign-in card (not cream on white)', async ({ page }) => {
  await page.goto('/signin');
  const word = page.locator('.sv-logo__word').first();
  await expect(word).toBeVisible();
  const color = await word.evaluate((el) => getComputedStyle(el).color);
  expect(color, 'wordmark must be olive ink on light surfaces').toBe('rgb(79, 95, 44)');
});

test('the wordmark stays cream inside the green sidebar', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  const word = page.locator('.sv-sidebar .sv-logo__word').first();
  await expect(word).toBeVisible();
  expect(await word.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(250, 246, 236)');
});

/* ------------------------------------------------------------------ *
 * Role redirects — nobody's first screen is "Not available for your role"
 * ------------------------------------------------------------------ */
test('an investor lands on their portfolio, never on an access-denied screen', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  await expect(page).toHaveURL(/\/admin\/portfolio/);
  await expect(page.locator('h1')).toContainText('Portfolio');
  await expect(page.locator('body')).not.toContainText('Not available for your role');
});

test('an operations manager lands on today\'s operations', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await expect(page).toHaveURL(/\/admin\/operations\/today/);
});

test('an admin lands on the dashboard', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

/* ------------------------------------------------------------------ *
 * Navigation — one active item, real icons, honest bell
 * ------------------------------------------------------------------ */
test('exactly one navigation item is active on the operations screen', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/operations/today');
  const active = page.locator('.sv-nav__link--active');
  await expect(active).toHaveCount(1);
  await expect(active).toContainText('Today');
  // …and the breadcrumb no longer claims this is Housekeeping.
  await expect(page.locator('.sv-breadcrumb')).not.toContainText('Housekeeping');
});

test('navigation uses drawn icons — no emoji glyphs anywhere in the shell', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  expect(await page.locator('.sv-nav__icon svg').count()).toBeGreaterThan(10);
  const shellText = await page.locator('.sv-sidebar, .sv-topbar').allInnerTexts();
  expect(shellText.join(' ')).not.toMatch(/[☰\u{1F514}]/u);
});

test('the bell shows a data-driven count for admins and is absent for investors', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  const bell = page.locator('a.sv-topbar__icon');
  await expect(bell).toHaveCount(1);
  const label = await bell.getAttribute('aria-label');
  expect(label).toMatch(/need attention|Nothing needs attention/);

  await page.goto('/signin');
  await signInAs(page, 'Investor Demo A');
  await expect(page.locator('a.sv-topbar__icon')).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * Mobile navigation — genuinely modal
 * ------------------------------------------------------------------ */
test('the mobile drawer traps focus and Escape closes it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, 'Demo Administrator');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.sv-sidebar--open')).toBeVisible();
  // Focus moved into the drawer.
  const focusInside = await page.evaluate(() =>
    !!document.activeElement && !!document.activeElement.closest('.sv-sidebar'));
  expect(focusInside).toBe(true);
  // The page behind is inert.
  expect(await page.locator('.sv-main[inert]').count()).toBe(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('.sv-sidebar--open')).toHaveCount(0);
  expect(await page.locator('.sv-main[inert]').count()).toBe(0);
});

/* ------------------------------------------------------------------ *
 * Reduced motion
 * ------------------------------------------------------------------ */
test('reduced motion zeroes the motion tokens', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/signin');
  const fast = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim());
  expect(fast).toBe('0ms');
  await context.close();
});

/* ------------------------------------------------------------------ *
 * States — error surfaces honestly, keyboard reaches the skip link
 * ------------------------------------------------------------------ */
test('a signed-out visitor deep-linking into admin is sent to sign in', async ({ page }) => {
  await page.goto('/admin/finance/pnl');
  await expect(page).toHaveURL(/\/signin/);
});

test('the skip link is the first tab stop', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.keyboard.press('Tab');
  const text = await page.evaluate(() => document.activeElement?.textContent ?? '');
  expect(text).toContain('Skip to main content');
});

/* ------------------------------------------------------------------ *
 * Forecast (ARCHITECTURE §9) — Phase 8 occupancy and revenue horizons
 * ------------------------------------------------------------------ */
test('the Forecast screen estimates the month ahead and shows its working', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/analytics/forecast');

  // All three horizons render, each labelled ESTIMATE as §9 requires.
  await expect(page.getByRole('heading', { name: 'Forecast', level: 1 })).toBeVisible();
  await expect(page.locator('.sv-badge', { hasText: 'ESTIMATE' })).toHaveCount(3);

  // The seeded year has enough history, so every horizon produces a figure rather than
  // the insufficient-data state — and the inputs behind them are on screen.
  const main = page.locator('main');
  await expect(main).toContainText('booking-on-hand');
  await expect(main).toContainText('complete months of trading history');
  // §9 needs a variance boundary no business rule states, so no HIGH/MEDIUM/LOW is
  // published — the screen says so and shows the inputs it could evaluate instead.
  await expect(main).toContainText(/Confidence: configuration required/);
  await expect(main, 'a withheld level must not become a silent gap')
    .toContainText(/Confidence not stated/);
  await expect(main).not.toContainText(/(HIGH|MEDIUM|LOW) confidence/);
  await expect(main, 'a forecast must never be presented as an unexplained number')
    .toContainText('Booking-on-hand');

  // §9 asks for a property-level ADR: the units behind the blended rate are on screen,
  // so the rate can be checked rather than trusted.
  await expect(main, 'the property-level rate must show the units it was blended from')
    .toContainText('Unit rates:');

  // Forecast vs actual, on BOTH horizons, in their own units.
  await expect(main).toContainText('Occupancy against actual');
  await expect(main).toContainText('Revenue against actual');

  // The demonstration data records no booking dates, so the re-estimate cannot rebuild
  // the books of the time. The screen must say which of the two it measured.
  await expect(main, 'an accuracy table must state what it actually measured')
    .toContainText(/records no booking date/);

  // §9's third horizon. The four terms are on screen, and so is the reason the figure is
  // deliberately conservative.
  await expect(main).toContainText('Cash flow');
  await expect(main).toContainText('Opening balance');
  await expect(main).toContainText('Expected payouts');
  await expect(main).toContainText('Less scheduled rent and fixed costs');
  await expect(main, 'a cash forecast must say what it does not count')
    .toContainText('Deliberately conservative');
});

test('Forecast is reachable from the navigation, and no longer lands on Performance', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.getByRole('link', { name: 'Forecast', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/analytics\/forecast/);
});

test('operations cannot open the forecast', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await expect(page.locator('.sv-sidebar')).not.toContainText('Forecast');
  await page.goto('/admin/analytics/forecast');
  await expect(page.locator('main')).toContainText(/[Nn]ot available/);
});

/* ------------------------------------------------------------------ *
 * Copilot — functional only. No screenshots are taken here.
 * ------------------------------------------------------------------ */

test('the copilot composer is usable and submits from the keyboard', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/ai');

  const input = page.getByLabel(/ask the copilot/i);
  await expect(input).toBeEnabled();
  // Empty question, nothing to send.
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

  await input.click();
  await page.keyboard.type('what needs attention today');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.keyboard.press('Enter');

  // Whatever the deployment answers, the question is echoed and the composer settles.
  await expect(page.locator('.sv-copilot__asked')).toContainText('what needs attention today');
  await expect(page.locator('.sv-copilot__thread')).toHaveAttribute('aria-busy', 'false');
});

test('an unconfigured deployment says so instead of inventing an answer', async ({ page }) => {
  /*
   * The e2e server runs DEMO with no AI variables set, so the copilot is refused. That is
   * the state worth pinning: the screen must report it rather than render a blank thread
   * or, far worse, a plausible-looking reply. If this deployment is ever configured with
   * the local mock, the answer block appears instead — labelled "Simulated" — and the
   * first assertion below is the one that still has to hold.
   */
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/ai');

  await page.getByLabel(/ask the copilot/i).fill('what needs attention today');
  await page.getByRole('button', { name: 'Send' }).click();

  const result = page.locator('.sv-copilot__result');
  await expect(result).not.toBeEmpty();
  // Nothing is presented as a model answer when the server produced none.
  await expect(page.locator('.sv-copilot__answer')).toHaveCount(0);
  await expect(result).toContainText('Configuration required');
});

test('the copilot page does not overflow sideways on a phone', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/admin/ai');
  await page.waitForSelector('.sv-copilot__composer');

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the copilot screen must not scroll horizontally at 375px').toBeLessThanOrEqual(0);
});

test('an investor cannot open the copilot', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  await expect(page.locator('.sv-sidebar')).not.toContainText('Copilot');
  await page.goto('/admin/ai');
  await expect(page.locator('main')).toContainText(/[Nn]ot available/);
  await expect(page.getByLabel(/ask the copilot/i)).toHaveCount(0);
});
