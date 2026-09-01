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
  // resolves mid-redirect and later steps race the second navigation. `main#main` exists
  // in every shell variant (the investor shell has no sidebar) once the page rendered.
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('main#main');
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
 * Brand mark — the official artwork, rendered as a file and never stretched
 *
 * These replace the cream-on-white colour checks that guarded the TYPOGRAPHIC
 * lockup. That lockup is the fallback now: with official artwork on disk the
 * shell renders the file itself, so `.sv-logo__word` is correctly absent and
 * the thing worth pinning is that the image is there, named, and undistorted.
 * ------------------------------------------------------------------ */
async function assertBrandImage(page: Page, scope: string) {
  const img = page.locator(`${scope} img.sv-logo__image`).first();
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('alt', 'MAKAM Home Stays');
  await expect(img).toHaveAttribute('src', '/brand/makam-logo.svg');

  const box = await img.evaluate((el) => {
    const image = el as HTMLImageElement;
    const r = image.getBoundingClientRect();
    return {
      w: r.width, h: r.height,
      natural: image.naturalWidth / image.naturalHeight,
      rendered: r.width / r.height,
    };
  });
  // The box must match the FILE's own ratio: that is what makes stretching impossible.
  expect(Math.abs(box.rendered - box.natural) / box.natural,
    `${scope}: logo must keep its intrinsic ratio`).toBeLessThan(0.005);
  expect(box.w, `${scope}: logo must actually be laid out`).toBeGreaterThan(0);
}

test('the official logo renders on the sign-in card', async ({ page }) => {
  await page.goto('/signin');
  await assertBrandImage(page, '.sv-signin');
});

test('the official logo renders in the rail, undistorted', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await assertBrandImage(page, '.sv-sidebar');
});

test('the investor shell carries the same official logo', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  await assertBrandImage(page, '.sv-invmast');
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
  // Since M-UI-2 the investor shell has NO rail at all — stronger than "no Copilot link".
  await expect(page.locator('.sv-sidebar')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Copilot');
  await page.goto('/admin/ai');
  await expect(page.locator('main')).toContainText(/[Nn]ot available/);
  await expect(page.getByLabel(/ask the copilot/i)).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * M-UI-0 — the operations financial boundary, proven in the real response
 * ------------------------------------------------------------------ */
test('operations opens the unit register without financial columns or values', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/properties?month=2027-01');
  await page.waitForSelector('.sv-table');

  const main = page.locator('main');
  await expect(main).not.toContainText('Net revenue');
  await expect(main).not.toContainText('Profit');
  await expect(main).not.toContainText('₹');
  await expect(main).toContainText('Status');
  await expect(main).toContainText('HYD-501');

  // Not merely undisplayed: the field names must be absent from the whole response —
  // HTML and any serialized payload alike. A value never projected cannot appear here.
  const content = await page.content();
  expect(content).not.toMatch(/netRevenue|directOperatingExpenses|revPar/);
});

test('operations opens the ledger and is sent to the workspace — no figures anywhere', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  // UI-4: the money-blind role is redirected BEFORE any booking is read for them,
  // rather than served the operational projection of a second, duplicate screen.
  await page.goto('/admin/reservations?month=2027-01');
  await expect(page).toHaveURL(/\/admin\/operations\/reservations/);
  // The filters travel across, so the reader lands where they were looking.
  await expect(page).toHaveURL(/month=2027-01/);
  await page.waitForSelector('.sv-table');

  const main = page.locator('main');
  await expect(main).not.toContainText('Gross value');
  await expect(main).not.toContainText('Expected payout');
  await expect(main).not.toContainText('₹');

  const content = await page.content();
  expect(content).not.toMatch(/grossValue|expectedPayout|actualPayout|payoutStatus/);

  // The register read routes are unimplemented over HTTP, for every role — a direct
  // request cannot fetch what the page projection withheld.
  for (const apiPath of ['/api/properties', '/api/reservations']) {
    const res = await page.request.get(apiPath);
    expect(res.status(), apiPath).toBe(501);
  }
});

test('admin keeps the financial registers intact', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');

  await page.goto('/admin/properties?month=2027-01');
  await page.waitForSelector('.sv-table');
  await expect(page.locator('main')).toContainText('Net revenue');
  await expect(page.locator('main')).toContainText('Profit');
  await expect(page.locator('main')).toContainText('₹');

  await page.goto('/admin/reservations?month=2027-01');
  await page.waitForSelector('.sv-table');
  await expect(page.locator('main')).toContainText('Gross value');
  await expect(page.locator('main')).toContainText('Expected payout');
  await expect(page.locator('main')).toContainText('₹');
});

/* ------------------------------------------------------------------ *
 * M-UI-2 — shell, navigation IA, role-aware entry
 * ------------------------------------------------------------------ */
test('the front door lands every signed-in role on its own home', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/operations\/today/);

  await page.goto('/signin');
  await signInAs(page, 'Investor Demo A');
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/portfolio/);
  await expect(page.locator('body')).not.toContainText('Not available for your role');
});

test('the investor shell is not the admin shell', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  await expect(page.locator('.sv-sidebar')).toHaveCount(0);
  await expect(page.locator('.sv-breadcrumb')).toHaveCount(0);
  await expect(page.locator('.sv-invmast')).toBeVisible();
  await expect(page.locator('.sv-invmast__audience')).toContainText('Investor');
  await expect(page.locator('h1')).toContainText('Portfolio');
  // Nothing operational or financial-management in their chrome.
  await expect(page.locator('.sv-invmast')).not.toContainText('Dashboard');
  await expect(page.locator('a.sv-topbar__icon')).toHaveCount(0);
});

test('operations navigation says Bookings once and never shows the booking ledger', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  const labels = await page.locator('.sv-nav__label').allInnerTexts();
  expect(labels.filter((l) => l === 'Bookings')).toHaveLength(1);
  expect(labels).not.toContain('Booking Ledger');
  expect(labels).not.toContain('Reservations');
  // UI-4: half of Today each, so they are entry points and not menu entries.
  expect(labels).not.toContain('Check-ins');
  expect(labels).not.toContain('Check-outs');
  expect(labels.join(' ')).not.toMatch(/Revenue|Expenses|P&L|Investors|Settings/);
});

test('the retired movement routes still work, and carry the day with them', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');

  // Not deleted — redirected. A bookmark must not break because a screen was merged.
  await page.goto('/admin/operations/checkins?date=2027-02-20');
  await expect(page).toHaveURL(/\/admin\/operations\/today\?date=2027-02-20/);
  await expect(page.locator('main')).toContainText('20 Feb 2027');

  await page.goto('/admin/operations/checkouts');
  await expect(page).toHaveURL(/\/admin\/operations\/today$/);
  await expect(page.locator('main')).toContainText('Departures');
});

test('a booking opens at its own address, and Back closes it', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/reservations');
  await page.waitForSelector('.sv-table');

  const first = page.locator('a.sv-bklink').first();
  const reference = (await first.innerText()).trim();
  await first.click();

  const drawer = page.locator('.sv-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(reference);
  await expect(page).toHaveURL(new RegExp(`booking=${reference}`));

  // No money on an operations surface, in the panel as on the list.
  await expect(drawer).not.toContainText('₹');
  await expect(drawer).not.toContainText('Payout');
  expect(await page.content()).not.toMatch(/grossValue|expectedPayout|actualPayout/);

  await page.goBack();
  await expect(page.locator('.sv-drawer')).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * UI-5 — the availability calendar
 * ------------------------------------------------------------------ */

test('the calendar shows units against days, and opens a booking from a bar', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/calendar');
  await page.waitForSelector('.sv-caltable');

  const units = await page.locator('.sv-caltable tbody tr').count();
  expect(units).toBeGreaterThan(0);
  const bar = page.locator('a.sv-calbar').first();
  await expect(bar).toBeVisible();
  const label = (await bar.getAttribute('aria-label'))!;
  const reference = label.match(/BK-\d{4}-\d{4}/)![0];

  await bar.click();

  // The SAME panel the Bookings workspace opens, carrying the SAME booking. A calendar
  // that imported the drawer but handed it nothing would say "not found" here.
  const drawer = page.locator('.sv-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(reference);
  await expect(drawer).not.toContainText('No booking');
  await expect(page).toHaveURL(new RegExp(`booking=${reference}`));

  // No money on an operations surface, in the grid or the panel.
  await expect(page.locator('main')).not.toContainText('\u20b9');
  expect(await page.content()).not.toMatch(/grossValue|expectedPayout|actualPayout/);
});

test('the calendar steps to a month with no bookings instead of snapping back', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  // A month past the trading year. The register clamps to months carrying revenue, and a
  // calendar that did the same could never be used to look ahead — which is what it is for.
  await page.goto('/admin/operations/calendar?month=2027-09');
  await page.waitForSelector('.sv-caltable');

  await expect(page.locator('.sv-calnav__month')).toContainText('September 2027');
  await expect(page.locator('.sv-caltable__day')).toHaveCount(30);
  await expect(page.locator('a.sv-calbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Back to this month/ })).toBeVisible();
});

test('a free day on the calendar leads to bookings for that unit', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/calendar?month=2027-09');
  await page.waitForSelector('.sv-caltable');

  const free = page.locator('a.sv-calfree').first();
  await expect(free).toHaveAttribute('aria-label', /is available on .+open bookings for this unit/);
  await free.click();
  await expect(page).toHaveURL(/\/admin\/operations\/reservations\?month=2027-09&property=HYD-/);
});

test('an investor is refused the calendar exactly as they are refused the register', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  await page.goto('/admin/operations/calendar');
  await expect(page.locator('h1')).toContainText('Not available');
  await expect(page.locator('.sv-caltable')).toHaveCount(0);
  // No booking reference reaches the response at all.
  expect(await page.content()).not.toMatch(/BK-20\d{2}-\d{4}/);
});

/* ------------------------------------------------------------------ *
 * UI-6 — the availability search
 * ------------------------------------------------------------------ */

test('the search and the calendar agree, in the running application, about one night', async ({ page }) => {
  /*
   * The two surfaces answer the same question from opposite directions. If they ever
   * disagree, one of them is telling somebody a unit is free when it is not — so this
   * counts the free cells for a day on the grid and the free units in the search for
   * that same night, and requires the same answer from both.
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, 'Demo Operations Manager');

  await page.goto('/admin/operations/calendar?month=2027-01&date=2027-01-19');
  await page.waitForSelector('.sv-caltable');
  const freeOnGrid = await page.locator('a.sv-calfree[aria-label*="19 Jan 2027"]').count();

  await page.goto('/admin/operations/availability?checkin=2027-01-19&checkout=2027-01-20');
  await page.waitForSelector('.sv-availcard');
  const freeInSearch = await page.locator('.sv-availcard--free').count();
  const total = await page.locator('.sv-availcard').count();

  expect(freeInSearch).toBe(freeOnGrid);
  expect(total).toBe(4);                     // every unit is accounted for, either way
  await expect(page.locator('[role="status"]').first())
    .toContainText(/free for 1 night|No units are free/);

  // No money on an operations surface.
  await expect(page.locator('main')).not.toContainText('₹');
  expect(await page.content()).not.toMatch(/grossValue|expectedPayout|actualPayout/);
});

test('the departure day is sellable, and a held night is not', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');

  // A month past the trading year: nothing is booked, so every unit is free.
  await page.goto('/admin/operations/availability?checkin=2027-09-10&checkout=2027-09-13');
  await page.waitForSelector('.sv-availcard');
  await expect(page.locator('.sv-availcard--free')).toHaveCount(4);
  await expect(page.locator('[role="status"]').first()).toContainText('4 of 4 units free for 3 nights');

  // Capacity narrows it with the master's own MaxGuests, not an invented rule.
  await page.goto('/admin/operations/availability?checkin=2027-09-10&checkout=2027-09-13&guests=4');
  await page.waitForSelector('.sv-availcard');
  await expect(page.locator('.sv-availcard--free')).toHaveCount(2);
  await expect(page.locator('.sv-availcard--held').first()).toContainText('Too small');
});

test('a range that cannot exist is refused in words, against the field that caused it', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/availability?checkin=2027-02-31&checkout=2027-03-05');

  const checkIn = page.locator('#avail-checkin');
  await expect(checkIn).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#avail-checkin-error')).toContainText('not a real calendar day');
  // Nothing was searched, so nothing is claimed.
  await expect(page.locator('.sv-availcard')).toHaveCount(0);

  // And a backwards range is refused too, on the field that is wrong.
  await page.goto('/admin/operations/availability?checkin=2027-03-10&checkout=2027-03-09');
  await expect(page.locator('#avail-checkout')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#avail-checkout-error')).toContainText('after check-in');
  await expect(page.locator('.sv-availcard')).toHaveCount(0);
});

test('choosing a unit opens the canonical booking form, prefilled and without money', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/availability?checkin=2027-09-10&checkout=2027-09-13&guests=2');
  await page.waitForSelector('.sv-availcard--free');

  const first = page.locator('.sv-availcard--free').first();
  await first.getByRole('button', { name: 'Select' }).click();

  const drawer = page.locator('.sv-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Place a booking in');
  // The search's own answers are already in the ONE booking form.
  await expect(drawer.getByLabel('Check-in')).toHaveValue('2027-09-10');
  await expect(drawer.getByLabel('Check-out')).toHaveValue('2027-09-13');
  await expect(drawer.getByLabel('Adults')).toHaveValue('2');
  // And no money field exists in it, because none was offered to this surface.
  for (const money of ['Base rate / night', 'Room revenue', 'Cleaning fee', 'Discount']) {
    await expect(drawer.getByLabel(money)).toHaveCount(0);
  }
  // The row the open form belongs to says so.
  await expect(first).toHaveAttribute('aria-current', 'true');
});

test('the calendar and the search hand each other the same date and property', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, 'Demo Operations Manager');

  await page.goto('/admin/operations/calendar?month=2027-09&date=2027-09-14&property=HYD-602');
  await page.waitForSelector('.sv-caltable');
  await page.getByRole('link', { name: /Find a unit for 14 Sep/ }).click();

  await expect(page).toHaveURL(/checkin=2027-09-14&checkout=2027-09-15&property=HYD-602/);
  await page.waitForSelector('.sv-availcard');
  await expect(page.locator('.sv-availcard')).toHaveCount(1);

  // …and back again, to the same day and the same unit.
  await page.locator('.sv-availcard').getByRole('link', { name: /View calendar/ }).click();
  await expect(page).toHaveURL(/month=2027-09&date=2027-09-14&property=HYD-602/);
  await page.waitForSelector('.sv-caltable');
});

test('an investor is refused the search exactly as they are refused the register', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  await page.goto('/admin/operations/availability?checkin=2027-01-19&checkout=2027-01-20');
  await expect(page.locator('h1')).toContainText('Not available');
  await expect(page.locator('.sv-availcard')).toHaveCount(0);
  // No booking reference reaches the response at all.
  expect(await page.content()).not.toMatch(/BK-20\d{2}-\d{4}/);
});

test('an unknown booking reference says so instead of showing an empty panel', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/reservations?booking=BK-9999-9999');
  const drawer = page.locator('.sv-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('No booking BK-9999-9999');
});

test('admin navigation is honest: one Settings, a Booking Ledger under Finance, no aliases', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  const labels = await page.locator('.sv-nav__label').allInnerTexts();
  expect(labels.filter((l) => l === 'Settings')).toHaveLength(1);
  expect(labels).not.toContain('Compliance');
  expect(labels).not.toContain('Audit');
  expect(labels).toContain('Booking Ledger');
  // The Finance breadcrumb segment is a real destination now.
  await page.goto('/admin/finance');
  await expect(page).toHaveURL(/\/admin\/finance\/revenue/);
});

test('the rail collapses to icons on desktop and comes back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, 'Demo Administrator');
  const rail = page.locator('.sv-sidebar');
  const wide = (await rail.boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse the navigation rail' }).click();
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeLessThan(80);
  await expect(page.locator('.sv-nav__label').first()).toBeHidden();
  await page.getByRole('button', { name: 'Expand the navigation rail' }).click();
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(wide);
});

test('the property filter names units in human terms, ID second', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/properties?month=2027-01');
  await page.waitForSelector('.sv-filters');
  const options = await page.locator('.sv-filter select').nth(1).locator('option').allInnerTexts();
  expect(options).toContain('5th Floor — 2 BHK · HYD-501');
  expect(options).not.toContain('HYD-501');
});

/* ------------------------------------------------------------------ *
 * Audit fixes — defects found by adversarial review of the foundation
 * ------------------------------------------------------------------ */
test('a touch user can dismiss the mobile navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, 'Demo Administrator');

  // The scrim was swept into the inert region, so every tap on it was swallowed.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.sv-sidebar--open')).toBeVisible();
  await expect(page.locator('.sv-scrim')).not.toHaveAttribute('inert', /.*/);
  // Tap the exposed strip beside the 248px drawer — where a thumb actually lands.
  // (The scrim's centre sits under the open drawer, so a default click hits the nav.)
  await page.locator('.sv-scrim').click({ position: { x: 340, y: 500 } });
  await expect(page.locator('.sv-sidebar--open')).toHaveCount(0);

  // …and the drawer carries its own exit, at a real touch size.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const close = page.getByRole('button', { name: 'Close menu' });
  const box = (await close.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(page.locator('.sv-sidebar--open')).toHaveCount(0);
});

test('the off-screen rail does not hold the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, 'Demo Administrator');
  // ~29 links used to sit off-canvas and fully focusable.
  const reachable = await page.evaluate(() => {
    const rail = document.querySelector('.sv-sidebar')!;
    let n = 0;
    rail.querySelectorAll('a,button').forEach((el) => {
      (el as HTMLElement).focus();
      if (document.activeElement === el) n += 1;
    });
    return n;
  });
  expect(reachable, 'the closed rail must be out of the tab order').toBe(0);
});

test('no screen scrolls sideways on the operations board at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/today');
  await page.waitForSelector('.sv-split');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the content column is centred on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await signInAs(page, 'Demo Administrator');
  const gaps = await page.evaluate(() => {
    const c = document.querySelector('.sv-content')!.getBoundingClientRect();
    const m = document.querySelector('.sv-main')!.getBoundingClientRect();
    return { left: Math.round(c.left - m.left), right: Math.round(m.right - c.right) };
  });
  expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(2);
  expect(gaps.left).toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ *
 * M-UI-3 — TODAY, the front-office command desk
 * ------------------------------------------------------------------ */
test('today opens on the operational day and answers what is happening', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.waitForSelector('.sv-summary');

  await expect(page.locator('.sv-daynav__label')).toContainText('Today');
  // Every summary tile is a real count, not a decorative card.
  const tiles = await page.locator('.sv-summary__tile').count();
  expect(tiles).toBe(7);
  // An operations board never shows money.
  await expect(page.locator('main')).not.toContainText('₹');
  const text = (await page.locator('main').innerText()).toLowerCase();
  for (const word of ['revenue', 'payout', 'profit', 'expense', 'revpar']) {
    expect(text, `operations must not see ${word}`).not.toContain(word);
  }
});

test('the day control steps through days and comes back, server-side', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.waitForSelector('.sv-daynav');
  const shown = await page.locator('.sv-daynav__date').innerText();

  await page.getByRole('button', { name: /Next day/ }).click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
  await expect(page.locator('.sv-daynav__date')).not.toHaveText(shown);
  // Browsing off today says so, rather than passing live queues off as history.
  await expect(page.locator('.sv-daynote')).toContainText('right now');

  await page.getByRole('button', { name: 'Back to today' }).click();
  await expect(page).not.toHaveURL(/date=/);
  await expect(page.locator('.sv-daynav__date')).toHaveText(shown);
});

test('an impossible date in the URL falls back instead of querying with it', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/today?date=2027-02-31');
  await page.waitForSelector('.sv-daynav');
  // Resolved server-side to the operational day: no error, no empty board.
  await expect(page.locator('.sv-daynav__label')).toContainText('Today');
  await expect(page.locator('.sv-summary')).toBeVisible();
});

test('a check-in runs the verified write path and the board re-reads', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.waitForSelector('.sv-summary');

  const checkIn = page.getByRole('button', { name: 'Check in' }).first();
  if (await checkIn.count() === 0) test.skip(true, 'no actionable arrival in the current demo state');

  const inHouseBefore = Number(await page.locator('.sv-summary__tile')
    .filter({ hasText: 'In house' }).locator('.sv-summary__value').innerText());

  await checkIn.click();
  const drawer = page.locator('.sv-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  // The booking is in front of the person before they commit — and carries no figure.
  await expect(drawer.locator('.sv-facts')).toContainText('Guest');
  await expect(drawer).not.toContainText('₹');

  await drawer.getByRole('button', { name: /Check in/ }).click();
  // Success is reported only after the server verified, and the count moves with it.
  await expect(page.locator('.sv-toast')).toContainText('checked in');
  await expect(drawer).toHaveCount(0);
  await expect.poll(async () => Number(await page.locator('.sv-summary__tile')
    .filter({ hasText: 'In house' }).locator('.sv-summary__value').innerText()))
    .toBe(inHouseBefore + 1);
});

/* ------------------------------------------------------------------ *
 * UI-7 — the stay: arrival, in house, departure
 * ------------------------------------------------------------------ */

/** A booking in the register that is currently at `status`, opened in its detail panel. */
async function openBookingWithStatus(page: Page, status: string): Promise<string | null> {
  await page.goto('/admin/operations/reservations');
  await page.waitForSelector('.sv-bklink');
  const row = page.locator('tbody tr').filter({ hasText: status }).first();
  if (await row.count() === 0) return null;
  const link = row.locator('a.sv-bklink').first();
  const label = (await link.getAttribute('aria-label')) ?? '';
  const reference = label.match(/BK-\d{4}-\d{4}/)?.[0] ?? null;
  await link.click();
  await expect(page.locator('.sv-drawer')).toBeVisible();
  return reference;
}

test('a stay runs arrival to departure through the one detail panel', async ({ page }) => {
  test.slow();
  await signInAs(page, 'Demo Operations Manager');

  const reference = await openBookingWithStatus(page, 'Confirmed');
  if (!reference) test.skip(true, 'no confirmed booking in the current demo state');

  /* ---- before: the panel says the guest is expected ---- */
  const drawer = page.locator('.sv-drawer');
  await expect(drawer.locator('.sv-stay')).toContainText('Arriving');
  // An operations surface, so there is no figure anywhere on it.
  await expect(drawer).not.toContainText('₹');

  /* ---- arrival ---- */
  await drawer.getByRole('button', { name: 'Check in' }).click();
  const arrival = page.locator('.sv-drawer').last();
  // The booking is in front of the person before they commit.
  await expect(arrival.locator('.sv-staycontext')).toContainText('night');
  await arrival.getByLabel('Arrival time').fill('14:35');
  await arrival.getByLabel('ID checked?').selectOption('Verified');
  await arrival.getByLabel('Early arrival').selectOption('true');
  await arrival.getByRole('button', { name: /Check in/ }).click();

  // Reported only after the server verified, and the panel re-reads from the workbook.
  // By text, not by position: the arrival toast is still on screen when the departure
  // one arrives, and "the last toast" is a race with the dismiss timer.
  await expect(page.locator('.sv-toast', { hasText: 'is checked in' })).toBeVisible();
  await expect(page.locator('.sv-stay')).toContainText('In house');
  await expect(page.locator('.sv-stay')).toContainText('Arrived at 14:35');
  await expect(page.locator('.sv-bkdetail')).toContainText('Verified');

  /* ---- departure ---- */
  await page.locator('.sv-bkdetail').getByRole('button', { name: 'Check out' }).click();
  const departure = page.locator('.sv-drawer').last();
  await departure.getByLabel('Departure time').fill('11:20');
  await departure.getByLabel('Late departure').selectOption('true');
  await departure.getByLabel('Damage found').fill('Chipped mug in the kitchen.');
  await departure.getByLabel('Needs maintenance').selectOption('true');
  await departure.getByRole('button', { name: /Check out/ }).click();

  await expect(page.locator('.sv-toast', { hasText: 'is checked out' })).toBeVisible();
  await expect(page.locator('.sv-stay')).toContainText('Stay complete');
  await expect(page.locator('.sv-stay')).toContainText('Departed at 11:20');
  const detail = page.locator('.sv-bkdetail');
  await expect(detail).toContainText('Chipped mug in the kitchen.');
  // Nothing further is offered: the transition table has nowhere left to go.
  await expect(detail.getByRole('button', { name: 'Check in' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Check out' })).toHaveCount(0);
  // And still no money, after two writes.
  await expect(detail).not.toContainText('₹');
});

test('the panel names the unit state without claiming the stay caused it', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  const reference = await openBookingWithStatus(page, 'Confirmed');
  if (!reference) test.skip(true, 'no confirmed booking in the current demo state');

  const headings = await page.locator('.sv-bkdetail__heading').allTextContents();
  expect(headings).toContain('This unit, right now');
  // Titled for the unit: the domain reads no booking-to-turnover link, so none is claimed.
  await expect(page.locator('.sv-bkdetail')).toContainText('Open maintenance');
});

test('an arrival cannot be recorded twice from the panel', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  const reference = await openBookingWithStatus(page, 'Checked In');
  if (!reference) test.skip(true, 'no in-house booking in the current demo state');

  const detail = page.locator('.sv-bkdetail');
  await expect(detail.locator('.sv-stay')).toContainText('In house');
  // The one legal next step, and only that one.
  await expect(detail.getByRole('button', { name: 'Check in' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Check out' })).toHaveCount(1);
});

for (const width of [375, 390, 768, 1024, 1440] as const) {
  test(`the arrival drawer is usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signInAs(page, 'Demo Operations Manager');

    const reference = await openBookingWithStatus(page, 'Confirmed');
    if (!reference) test.skip(true, 'no confirmed booking in the current demo state');

    await page.locator('.sv-drawer').getByRole('button', { name: 'Check in' }).click();
    const arrival = page.locator('.sv-drawer').last();
    await expect(arrival).toBeVisible();

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `the arrival drawer must not scroll the page at ${width}px`)
      .toBeLessThanOrEqual(0);

    /*
     * The confirm button is the reason the sheet is open, so it has to be a real target
     * wherever a finger will reach it. The product's rule is `@media (pointer: coarse)`
     * — 44px on any touch device at any width — plus the bottom-sheet treatment below
     * 640px. On a desktop mouse it stays the design system's 40px, because one button
     * taller than every other button in the product is not a design, it is a mistake.
     */
    const confirm = arrival.getByRole('button', { name: /^Check in$/ });
    const box = (await confirm.boundingBox())!;
    expect(box.height, 'the confirm button is a real target')
      .toBeGreaterThanOrEqual(width <= 640 ? 44 : 40);
    expect(box.x + box.width, 'the confirm button is inside the viewport')
      .toBeLessThanOrEqual(width + 1);
    if (width <= 640) {
      // A bottom sheet on a phone: the action spans it rather than hiding in a corner.
      expect(box.width).toBeGreaterThan(width * 0.7);
    }

    // Reachable and operable from the keyboard alone.
    await arrival.getByLabel('Arrival time').focus();
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('type'));
    expect(focused).toBe('time');
  });
}

test('today is keyboard-operable with a visible focus ring', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.waitForSelector('.sv-oprow');

  const action = page.locator('.sv-oprow__action .sv-btn').first();
  if (await action.count() === 0) test.skip(true, 'no actionable row in the current demo state');
  // Real keyboard focus, so :focus-visible genuinely applies.
  await action.focus();
  await page.keyboard.press('Tab');
  await action.focus();
  const ring = await action.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { visible: el.matches(':focus-visible'), width: cs.outlineWidth, style: cs.outlineStyle };
  });
  expect(ring.visible).toBe(true);
  expect(ring.style).not.toBe('none');
  expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
});

test('an investor cannot open today, and sees no operational data', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  await page.goto('/admin/operations/today');
  await expect(page.locator('h1')).toContainText('Not available');
  await expect(page.locator('.sv-summary')).toHaveCount(0);
  await expect(page.locator('.sv-oprow')).toHaveCount(0);
  // No guest name or booking reference reaches the response at all.
  expect(await page.content()).not.toMatch(/BK-20\d{2}-\d{4}/);
});

for (const width of [375, 390, 768, 1024, 1440] as const) {
  test(`today does not scroll sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signInAs(page, 'Demo Operations Manager');
    await page.waitForSelector('.sv-summary');
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `Today must not scroll sideways at ${width}px`).toBeLessThanOrEqual(0);
  });

  test(`the calendar does not scroll sideways at ${width}px`, async ({ page }) => {
    /*
     * The widest screen in the product: a month of columns against every unit. It
     * overflowed the PAGE at 1024 until the shared table scroller was made a containing
     * block — `.sv-visually-hidden` is absolutely positioned, so inside a scroller with
     * no positioned ancestor it escaped the clipping entirely.
     */
    await page.setViewportSize({ width, height: 900 });
    await signInAs(page, 'Demo Operations Manager');
    await page.goto('/admin/operations/calendar');
    // Below 900px the day view replaces the grid rather than squeezing it.
    await page.waitForSelector(width >= 900 ? '.sv-caltable' : '.sv-calday__strip');

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `the calendar must not scroll sideways at ${width}px`).toBeLessThanOrEqual(0);

    if (width < 900) {
      // One thumb: the day pips and the row actions are real targets.
      const pip = page.locator('.sv-calday__pip').first();
      const box = await pip.boundingBox();
      expect(box!.width, 'day pips are tappable').toBeGreaterThanOrEqual(44);
      expect(box!.height, 'day pips are tappable').toBeGreaterThanOrEqual(44);
    }
  });

  test(`the availability search does not scroll sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signInAs(page, 'Demo Operations Manager');
    await page.goto('/admin/operations/availability?checkin=2027-09-10&checkout=2027-09-13');
    await page.waitForSelector('.sv-availcard');

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `the search must not scroll sideways at ${width}px`).toBeLessThanOrEqual(0);

    /*
     * Page overflow alone is NOT the guarantee. A card with `overflow: hidden` swallows a
     * form laid out wider than the phone: the page never scrolls, and the Guests field is
     * simply not on screen. So every control has to be INSIDE the viewport, not merely
     * fail to widen the document.
     */
    const escaped = await page.$$eval('.sv-availform__fields .sv-input',
      (els, w) => els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > w + 1 || r.left < -1;
        })
        .map((el) => el.id),
      width);
    expect(escaped, `every search control must be inside ${width}px`).toEqual([]);

    // A stacked form and a real thumb target for the one action that matters.
    const select = page.locator('.sv-availcard--free').first().getByRole('button', { name: 'Select' });
    const box = await select.boundingBox();
    expect(box!.height, 'Select is tappable').toBeGreaterThanOrEqual(44);

    const dateBox = await page.locator('#avail-checkin').boundingBox();
    expect(dateBox!.width, 'the date input is not squeezed').toBeGreaterThanOrEqual(120);
  });
}
