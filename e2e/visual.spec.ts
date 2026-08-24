/**
 * C6 — VISUAL QA CAPTURE. Writes the review screenshots to reports/visual/phase-c/
 * (page × width), plus the write-flow keyframes (drawer open, applying, verified).
 * Not an assertion suite — the assertions live in smoke/writes; this produces the
 * evidence a human reviews.
 */
import { test, expect, type Page } from '@playwright/test';

// Capture crosses many cold-compiling routes at three widths — give it real time.
test.describe.configure({ timeout: 240_000 });

const OUT = 'reports/visual/phase-c';
const WIDTHS = [375, 768, 1440] as const;

async function signInAs(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('.sv-sidebar');
}

const PAGES: ReadonlyArray<{ name: string; path: string; as: string; ready: string }> = [
  { name: 'signin', path: '/signin', as: '', ready: '.sv-signin__identity, form' },
  { name: 'dashboard', path: '/admin/dashboard?month=2027-02', as: 'Demo Administrator', ready: '.sv-kpi-row' },
  { name: 'ops-today', path: '/admin/operations/today', as: 'Demo Operations Manager', ready: 'main h2' },
  { name: 'ops-reservations', path: '/admin/operations/reservations?month=2027-02', as: 'Demo Operations Manager', ready: 'tbody tr' },
  { name: 'finance-expenses', path: '/admin/finance/expenses?month=2027-02', as: 'Demo Administrator', ready: 'tbody tr' },
  { name: 'finance-capex', path: '/admin/finance/capex?month=2027-02', as: 'Demo Administrator', ready: 'main table' },
  { name: 'investor-portfolio', path: '/admin/portfolio', as: 'Investor Demo A', ready: '.sv-kpi, main h2' },
];

for (const spec of PAGES) {
  test(`capture · ${spec.name}`, async ({ page }) => {
    if (spec.as) await signInAs(page, spec.as);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(spec.path);
      await page.waitForSelector(spec.ready, { timeout: 30_000 }).catch(() => null);
      await page.screenshot({ path: `${OUT}/${spec.name}-${width}.png`, fullPage: width === 1440 });
    }
    expect(true).toBe(true);
  });
}

test('capture · expense write-flow keyframes', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/finance/expenses?month=2027-02');

  await page.getByRole('button', { name: '+ New Expense' }).click();
  await page.waitForSelector('.sv-drawer');
  await page.screenshot({ path: `${OUT}/flow-expense-1-drawer.png` });

  const drawer = page.locator('.sv-drawer');
  await drawer.getByLabel(/^Date/).fill('2027-02-18');
  await drawer.getByLabel(/^Property/).selectOption('HYD-501');
  await drawer.getByLabel(/^Category/).selectOption('Variable Operating');
  await drawer.getByLabel(/^Subcategory/).fill('Electricity');
  await drawer.getByLabel(/^Description/).fill('Visual QA keyframe expense');
  await drawer.getByLabel(/^Amount/).fill('1234');

  await page.route('**/api/expenses', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await drawer.locator('button[type=submit]').click();
  await page.waitForSelector('[data-phase="applying"]');
  await page.screenshot({ path: `${OUT}/flow-expense-2-applying.png` });

  await page.waitForSelector('.sv-toast--success', { timeout: 20_000 });
  await page.screenshot({ path: `${OUT}/flow-expense-3-verified.png` });
});
