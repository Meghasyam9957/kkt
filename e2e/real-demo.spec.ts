/**
 * D8 — THE REAL-DEMO SUITE: browser tests against the LIVE demo environment.
 *
 * These tests run only when the app under test is actually reading the real demo
 * workbook (APP_ENV=demo, LIVE_DATA_ENABLED=true, DEMO_* credentials configured). The
 * gate is read from the running app itself — the sign-in screen names its data source —
 * so a fixtures-backed process can never quietly "pass" this suite: every test SKIPS
 * with PENDING until the live environment exists. No in-memory provider is exercised
 * here by construction.
 *
 * Coverage, per the Phase D brief:
 *   1–4   admin / operations / investor A / investor B sign-in
 *   5–6   create reservation · duplicate submit lands exactly one row
 *   7     the scripted ₹4,321 expense
 *   8–11  CAPEX · maintenance · inventory · housekeeping
 *   12–14 check-in · check-out · cancel
 *   15–16 investor isolation · operations finance denial
 *   17    calculated-column injection refused
 *   18    dashboard reflects a web-created expense (+₹4,321, engine-computed)
 *   19    a browser reload still shows saved data
 *   20    demo reset restores the seed
 *
 * SERIAL on purpose: the app talks to the real Google Sheets API (60 reads/min quota),
 * demo state is shared, and the reset must run last. Parallel workers would trip quota
 * and interleave writes.
 *
 * Sign-in adapts to the environment: the demo identity chooser when Supabase is not yet
 * configured, real email/password when it is. Passwords are NEVER written here — supply
 * them via DEMO_E2E_*_PASSWORD variables (see docs/DEMO_PROVISIONING.md); tests that
 * need a missing password skip with instructions.
 */
import { test, expect, type Page, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.describe.configure({ mode: 'serial' });

/* ------------------------------------------------------------------ *
 * Environment gate + shared state (serial mode makes this determinate)
 * ------------------------------------------------------------------ */

let live = false;
let passwordAuth = false;
/** The workbook's latest trading month (ISO), read from the dashboard's filter. */
let month = '';
/** Booking created in test 5; checked in/out in tests 12–13. */
let lifecycleBookingId = '';

const ACCOUNTS = {
  admin:      { chooser: 'Demo Administrator',      email: 'admin.demo@srivillu.demo',      passwordVar: 'DEMO_E2E_ADMIN_PASSWORD' },
  operations: { chooser: 'Demo Operations Manager', email: 'operations.demo@srivillu.demo', passwordVar: 'DEMO_E2E_OPERATIONS_PASSWORD' },
  investorA:  { chooser: 'Investor Demo A',         email: 'investor.demo.a@srivillu.demo', passwordVar: 'DEMO_E2E_INVESTOR_A_PASSWORD' },
  investorB:  { chooser: 'Investor Demo B',         email: 'investor.demo.b@srivillu.demo', passwordVar: 'DEMO_E2E_INVESTOR_B_PASSWORD' },
} as const;

test.beforeAll(async ({ request }) => {
  const html = await (await request.get('/signin')).text();
  // Fixtures label themselves "(fixtures)"; the live demo workbook does not.
  live = html.includes('Demo Workbook') && !html.includes('(fixtures)');
  passwordAuth = !html.includes('sv-signin__identities');
});

const PENDING = 'PENDING — the live demo workbook is not this deployment\'s data source '
  + '(fixtures active). Configure DEMO_* credentials and LIVE_DATA_ENABLED=true; see '
  + 'docs/DEMO_PROVISIONING.md.';

function requireLive(): void {
  test.skip(!live, PENDING);
}

async function signIn(page: Page, who: keyof typeof ACCOUNTS): Promise<void> {
  const account = ACCOUNTS[who];
  await page.goto('/signin');
  if (passwordAuth) {
    const password = process.env[account.passwordVar];
    test.skip(!password, `Supabase auth is active; set ${account.passwordVar} for this suite `
      + '(passwords come from scripts/demo-users.mjs and are stored only in your password manager).');
    await page.getByLabel('Email address').fill(account.email);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
  } else {
    await page.getByRole('button', { name: new RegExp(account.chooser) }).click();
  }
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('.sv-sidebar');
}

async function postJson(page: Page, path: string, body: unknown): Promise<APIResponse> {
  return page.request.post(path, { data: body });
}

/** First real option of a labelled <select> inside a container, chosen not hard-coded:
 *  the workbook's seeded property ids are its own business. */
async function selectFirstOption(scope: ReturnType<Page['locator']>, label: RegExp): Promise<string> {
  const select = scope.getByLabel(label);
  const value = await select.locator('option:not([value=""])').first().getAttribute('value');
  expect(value, `a seeded option for ${label}`).toBeTruthy();
  await select.selectOption(value!);
  return value!;
}

const kpiValue = async (page: Page, label: string): Promise<number> => {
  const text = await page.locator('.sv-kpi', { hasText: label }).locator('.sv-kpi__value').innerText();
  return Number(text.replace(/[^\d-]/g, ''));
};

/* ================================================================== *
 * 1–4 · Sign-in, one account each
 * ================================================================== */

test('01 admin sign-in reaches a calculated dashboard', async ({ page }) => {
  requireLive();
  await signIn(page, 'admin');
  await page.goto('/admin/dashboard');
  await expect(page.locator('.sv-kpi__value').first()).toBeVisible();
  await expect(page.locator('.sv-demo-badge').first()).toContainText('DEMO / UAT');
  // The workbook's latest trading month drives every later write.
  month = await page.getByLabel('Reporting month').inputValue();
  expect(month).toMatch(/^\d{4}-\d{2}$/);
});

test('02 operations sign-in sees the board and no finance', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  const sidebar = page.locator('.sv-sidebar');
  await expect(sidebar).toContainText('Today');
  await expect(sidebar).not.toContainText('Expenses');
  await expect(sidebar).not.toContainText('P&L');
});

test('03 investor A sees their own portfolio', async ({ page }) => {
  requireLive();
  await signIn(page, 'investorA');
  await page.waitForURL(/\/admin\/portfolio/);
  await expect(page.locator('main')).toContainText('INV-001');
});

test('04 investor B sees their own portfolio', async ({ page }) => {
  requireLive();
  await signIn(page, 'investorB');
  await page.waitForURL(/\/admin\/portfolio/);
  await expect(page.locator('main')).toContainText('INV-002');
});

/* ================================================================== *
 * 5–7 · Creation workflows through the web UI
 * ================================================================== */

test('05 create a reservation in the real workbook', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  await page.goto(`/admin/operations/reservations?month=${month}`);

  await page.getByRole('button', { name: '+ New Reservation' }).click();
  const drawer = page.locator('.sv-drawer');
  await selectFirstOption(drawer, /^Property/);
  await selectFirstOption(drawer, /^Platform \*/);
  await drawer.getByLabel(/^Guest name/).fill('Real Demo Lifecycle Guest');
  await drawer.getByLabel(/^Booked on/).fill(`${month}-01`);
  await drawer.getByLabel(/^Check-in/).fill(`${month}-20`);
  await drawer.getByLabel(/^Check-out/).fill(`${month}-22`);
  await drawer.locator('button[type=submit]').click();

  const toast = page.locator('.sv-toast--success .sv-toast__title').first();
  await expect(toast).toContainText(/BK-\d{4}-\d{4} created/, { timeout: 30_000 });
  lifecycleBookingId = (await toast.textContent())!.match(/BK-\d{4}-\d{4}/)![0];
});

test('06 a duplicate reservation submit lands exactly ONE business row', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  await page.goto(`/admin/operations/reservations?month=${month}`);
  const rowsBefore = await page.locator('tbody tr').count();

  await page.getByRole('button', { name: '+ New Reservation' }).click();
  const drawer = page.locator('.sv-drawer');
  await selectFirstOption(drawer, /^Property/);
  await selectFirstOption(drawer, /^Platform \*/);
  await drawer.getByLabel(/^Guest name/).fill('Duplicate Submit Guest');
  await drawer.getByLabel(/^Booked on/).fill(`${month}-01`);
  await drawer.getByLabel(/^Check-in/).fill(`${month}-23`);
  await drawer.getByLabel(/^Check-out/).fill(`${month}-24`);
  const submit = drawer.locator('button[type=submit]');
  await submit.click();
  await submit.click({ force: true }).catch(() => { /* already disabled — good */ });

  await expect(page.locator('.sv-toast--success .sv-toast__title').first())
    .toContainText(/created/, { timeout: 30_000 });
  await expect(page.locator('tbody tr')).toHaveCount(rowsBefore + 1);
});

test('07 the scripted ₹4,321 expense goes through the drawer', async ({ page }) => {
  requireLive();
  await signIn(page, 'admin');
  await page.goto(`/admin/finance/expenses?month=${month}`);
  const rowsBefore = await page.locator('tbody tr').count();

  await page.getByRole('button', { name: '+ New Expense' }).click();
  const drawer = page.locator('.sv-drawer');
  await drawer.getByLabel(/^Date/).fill(`${month}-18`);
  await selectFirstOption(drawer, /^Property/);
  await selectFirstOption(drawer, /^Category/);
  await drawer.getByLabel(/^Subcategory/).fill('Electricity');
  await drawer.getByLabel(/^Description/).fill('Phase D scripted demo expense');
  const amount = drawer.getByLabel(/^Amount/);
  await amount.fill('4321');
  await expect(amount).toHaveValue('4321');
  await drawer.getByLabel(/^Payment status/).selectOption('Paid');
  await drawer.getByLabel(/^Paid on/).fill(`${month}-18`);
  await drawer.locator('button[type=submit]').click();

  await expect(page.locator('.sv-toast--success .sv-toast__title'))
    .toContainText(/EXP-\d{4}-\d{4} recorded/, { timeout: 30_000 });
  await expect(page.locator('tbody tr')).toHaveCount(rowsBefore + 1);
});

/* ================================================================== *
 * 8–11 · CAPEX, maintenance, inventory, housekeeping
 * ================================================================== */

test('08 CAPEX lands in the register', async ({ page }) => {
  requireLive();
  await signIn(page, 'admin');
  await page.goto('/admin/dashboard');
  const property = await firstSeededProperty(page);
  const res = await postJson(page, '/api/capex', {
    operationId: randomUUID(), propertyId: property, date: `${month}-10`,
    category: 'Furniture', item: 'Phase D demo bookshelf', quantity: 1, unitCost: 5500,
    paymentStatus: 'Paid',
  });
  expect(res.status()).toBe(200);
  const id = (await res.json()).record.CapexID as string;

  await page.goto(`/admin/finance/capex?month=${month}`);
  await expect(page.locator('tbody')).toContainText(id);
});

test('09 a maintenance issue appears on the board and resolves', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  await page.goto('/admin/operations/maintenance');

  await page.getByRole('button', { name: '+ New Maintenance Issue' }).click();
  const drawer = page.locator('.sv-drawer');
  await selectFirstOption(drawer, /^Property/);
  await drawer.getByLabel(/^Reported on/).fill(`${month}-18`);
  await selectFirstOption(drawer, /^Category/);
  await drawer.getByLabel(/What is wrong/).fill('Phase D: bathroom tap dripping');
  await drawer.getByLabel(/^Priority/).selectOption('High');
  await drawer.locator('button[type=submit]').click();

  const toast = page.locator('.sv-toast--success .sv-toast__title').first();
  await expect(toast).toContainText(/MNT-\d{4}-\d{4} created/, { timeout: 30_000 });
  const ticketId = (await toast.textContent())!.match(/MNT-\d{4}-\d{4}/)![0];

  const row = page.locator('tbody tr', { hasText: ticketId });
  await row.getByRole('button', { name: 'Resolve' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Resolved on/).fill(`${month}-19`);
  await dialog.locator('button[type=submit]').click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'resolved' }))
    .toBeVisible({ timeout: 30_000 });
});

test('10 an inventory movement updates the register', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  await page.goto('/admin/operations/inventory');
  const firstRow = page.locator('tbody tr').first();
  const itemId = (await firstRow.locator('code').first().textContent())!;

  await firstRow.getByRole('button', { name: 'Movement' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Purchased/).fill('5');
  await dialog.getByLabel(/Last purchase date/).fill(`${month}-18`);
  await dialog.locator('button[type=submit]').click();

  await expect(page.locator('.sv-toast--success .sv-toast__title'))
    .toContainText(`${itemId} updated`, { timeout: 30_000 });
});

test('11 a housekeeping task is created and completed', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  await page.goto('/admin/dashboard').catch(() => { /* operations land on the board */ });
  const property = await firstSeededProperty(page);
  const res = await postJson(page, '/api/housekeeping', {
    operationId: randomUUID(), propertyId: property, checkoutDate: `${month}-18`,
  });
  expect(res.status()).toBe(200);
  const taskId = (await res.json()).record.TaskID as string;

  await page.goto('/admin/operations/housekeeping');
  const row = page.locator('tbody tr', { hasText: taskId });
  await row.getByRole('button', { name: 'Mark Clean' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Cleaned by/).fill('Phase D Cleaner');
  await dialog.locator('button[type=submit]').click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'completed' }))
    .toBeVisible({ timeout: 30_000 });
});

/* ================================================================== *
 * 12–14 · Reservation lifecycle
 * ================================================================== */

test('12 check-in flips the booking on the real board', async ({ page }) => {
  requireLive();
  expect(lifecycleBookingId, 'test 05 must have created the booking').toBeTruthy();
  await signIn(page, 'operations');
  await page.goto(`/admin/operations/reservations?month=${month}`);

  const row = page.locator('tbody tr', { hasText: lifecycleBookingId });
  await row.getByRole('button', { name: 'Check In' }).click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'checked in' }))
    .toBeVisible({ timeout: 30_000 });
  await expect(row.locator('.sv-pill')).toContainText('Checked In');
});

test('13 check-out completes the stay', async ({ page }) => {
  requireLive();
  expect(lifecycleBookingId, 'test 05 must have created the booking').toBeTruthy();
  await signIn(page, 'operations');
  await page.goto(`/admin/operations/reservations?month=${month}`);

  const row = page.locator('tbody tr', { hasText: lifecycleBookingId });
  await row.getByRole('button', { name: 'Check Out' }).click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'checked out' }))
    .toBeVisible({ timeout: 30_000 });
  await expect(row.locator('.sv-pill')).toContainText('Checked Out');
});

test('14 cancelling requires a reason and keeps the row', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  await page.goto(`/admin/operations/reservations?month=${month}`);
  const property = await firstSeededProperty(page);

  const created = await postJson(page, '/api/reservations', {
    operationId: randomUUID(), platform: 'Direct', propertyId: property,
    bookingDate: `${month}-01`, guestName: 'Phase D Cancel Guest', adults: 2, children: 0,
    checkInDate: `${month}-25`, checkOutDate: `${month}-27`,
  });
  expect(created.status()).toBe(200);
  const bookingId = (await created.json()).record.BookingID as string;

  await page.goto(`/admin/operations/reservations?month=${month}`);
  const row = page.locator('tbody tr', { hasText: bookingId });
  await row.getByRole('button', { name: 'Cancel' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Why is this booking/).fill('Guest cancelled — Phase D suite');
  await dialog.locator('button[type=submit]').click();

  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'cancelled' }))
    .toBeVisible({ timeout: 30_000 });
  await expect(row.locator('.sv-pill')).toContainText('Cancelled');
});

/* ================================================================== *
 * 15–17 · Role boundaries against real auth
 * ================================================================== */

test('15 investor A cannot read investor B', async ({ page }) => {
  requireLive();
  await signIn(page, 'investorA');
  await page.waitForURL(/\/admin\/portfolio/);
  await expect(page.locator('main')).toContainText('INV-001');
  await expect(page.locator('main')).not.toContainText('INV-002');

  // The identity is server-resolved; a tampered query string changes nothing.
  await page.goto('/admin/portfolio?investorId=INV-002');
  await expect(page.locator('main')).toContainText('INV-001');
  await expect(page.locator('main')).not.toContainText('INV-002');
});

test('16 operations cannot create finance records', async ({ page }) => {
  requireLive();
  await signIn(page, 'operations');
  const res = await postJson(page, '/api/expenses', {
    operationId: randomUUID(), date: `${month}-18`, propertyId: 'ANY',
    expenseCategory: 'Variable Operating', description: 'Denied', amount: 1,
  });
  expect(res.status()).toBe(403);
  await page.goto('/admin/finance/expenses');
  await expect(page.locator('main')).toContainText(/[Nn]ot available/);
});

test('17 calculated-column injection is refused by the live pipeline', async ({ page }) => {
  requireLive();
  await signIn(page, 'admin');
  const property = await firstSeededProperty(page);
  const res = await postJson(page, '/api/expenses', {
    operationId: randomUUID(), date: `${month}-18`, propertyId: property,
    expenseCategory: 'Variable Operating', description: 'Injection probe', amount: 100,
    TotalAmount: 999999,
  });
  expect(res.status()).toBe(422);
});

/* ================================================================== *
 * 18–19 · Dataflow: UI → Google → engine → dashboard, and persistence
 * ================================================================== */

test('18 the dashboard reflects a web-created expense: +₹4,321 exactly', async ({ page }) => {
  requireLive();
  test.slow();
  await signIn(page, 'admin');
  await page.goto(`/admin/dashboard?month=${month}`);
  const before = await kpiValue(page, 'MTD Expenses');

  const property = await firstSeededProperty(page);
  const res = await postJson(page, '/api/expenses', {
    operationId: randomUUID(), date: `${month}-19`, propertyId: property,
    expenseCategory: 'Variable Operating', description: 'Dashboard dataflow expense',
    amount: 4321, paymentStatus: 'Paid', paidDate: `${month}-19`,
  });
  expect(res.status()).toBe(200);

  // The verified write invalidated the read cache; the next render re-reads the
  // workbook, and the V1-semantics engine — not React — moves the figure.
  await page.goto(`/admin/dashboard?month=${month}`);
  const after = await kpiValue(page, 'MTD Expenses');
  expect(after).toBe(before + 4321);
});

test('19 saved data survives a full browser reload', async ({ page }) => {
  requireLive();
  await signIn(page, 'admin');
  const property = await firstSeededProperty(page);
  const res = await postJson(page, '/api/expenses', {
    operationId: randomUUID(), date: `${month}-20`, propertyId: property,
    expenseCategory: 'Variable Operating', description: 'Reload persistence expense',
    amount: 777, paymentStatus: 'Paid', paidDate: `${month}-20`,
  });
  expect(res.status()).toBe(200);
  const id = (await res.json()).record.ExpenseID as string;

  await page.goto(`/admin/finance/expenses?month=${month}`);
  await expect(page.locator('tbody')).toContainText(id);
  await page.reload();
  await expect(page.locator('tbody')).toContainText(id);
});

/* ================================================================== *
 * 20 · Demo reset — LAST, by serial order
 * ================================================================== */

test('20 the reset removes demo writes and restores the seed', async ({ page }) => {
  requireLive();
  test.slow();
  await signIn(page, 'admin');

  // A snapshot must exist BEFORE the marker below, or "restore" would preserve it.
  await page.goto('/admin/demo');
  const capture = page.getByRole('button', { name: /Capture seed snapshot/ });
  if (await capture.count()) {
    await capture.click();
    await page.waitForURL(/\/admin\/demo/);
  }
  await expect(page.locator('main')).toContainText(/Seed snapshot captured/);

  const property = await firstSeededProperty(page);
  const res = await postJson(page, '/api/expenses', {
    operationId: randomUUID(), date: `${month}-21`, propertyId: property,
    expenseCategory: 'Variable Operating', description: 'Reset marker expense',
    amount: 999, paymentStatus: 'Paid', paidDate: `${month}-21`,
  });
  expect(res.status()).toBe(200);
  const marker = (await res.json()).record.ExpenseID as string;
  await page.goto(`/admin/finance/expenses?month=${month}`);
  await expect(page.locator('tbody')).toContainText(marker);

  await page.goto('/admin/demo');
  await page.getByRole('button', { name: 'Reset demo environment' }).click();
  await page.getByRole('button', { name: 'Yes, reset the demo' }).click();
  await page.waitForURL(/\/admin\/demo/, { timeout: 120_000 });

  await page.goto(`/admin/finance/expenses?month=${month}`);
  await expect(page.locator('tbody')).not.toContainText(marker);
});

/** A property id the workbook actually seeded — read from a form's own options, never
 *  hard-coded: the workbook's property ids are its own business. Admin reads it from
 *  the expense drawer; operations from the reservation drawer. */
async function firstSeededProperty(page: Page): Promise<string> {
  const admin = { url: `/admin/finance/expenses?month=${month}`, button: '+ New Expense' };
  const ops = { url: `/admin/operations/reservations?month=${month}`, button: '+ New Reservation' };
  for (const { url, button } of [admin, ops]) {
    await page.goto(url);
    if (!(await page.getByRole('button', { name: button }).count())) continue;
    await page.getByRole('button', { name: button }).click();
    const value = await page.locator('.sv-drawer').getByLabel(/^Property/)
      .locator('option:not([value=""])').first().getAttribute('value');
    await page.keyboard.press('Escape');
    if (value) return value;
  }
  throw new Error('No seeded property id could be read from any drawer.');
}
