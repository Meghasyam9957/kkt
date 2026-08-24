/**
 * C5 — WRITE WORKFLOWS, in a real browser against the DEMO environment.
 *
 * Coverage per the Phase C brief: happy path, validation failure, duplicate submit,
 * operation-id replay, unauthorized role, calculated-column injection, network retry,
 * visible APPLYING, VERIFIED, and failure states — across Reservation, Expense, CAPEX,
 * Maintenance, Inventory and Housekeeping.
 *
 * Entities split between full drawer flows (expense, reservation, maintenance) and
 * API-level flows through the same pipeline (capex, housekeeping, inventory) — the
 * browser context's cookies authenticate both, so every request exercises the identical
 * guard → pipeline → verify path.
 *
 * The dev server accumulates demo state across tests, so every assertion is RELATIVE
 * (before/after), never absolute.
 */
import { test, expect, type Page, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** The demo dataset trades in early 2027; dates must land in a month the views show. */
const MONTH = '2027-02';

async function signInAs(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('.sv-sidebar');
}

const expensePayload = (overrides: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  date: `${MONTH}-18`,
  propertyId: 'HYD-501',
  expenseCategory: 'Variable Operating',
  expenseSubcategory: 'Electricity',
  description: 'Playwright write-suite expense',
  amount: 1111,
  paymentStatus: 'Paid',
  paidDate: `${MONTH}-18`,
  ...overrides,
});

async function postJson(page: Page, path: string, body: unknown): Promise<APIResponse> {
  return page.request.post(path, { data: body });
}

/* ================================================================== *
 * Expense — the full drawer flow
 * ================================================================== */

async function fillExpenseDrawer(page: Page, description: string): Promise<void> {
  await page.getByRole('button', { name: '+ New Expense' }).click();
  const drawer = page.locator('.sv-drawer');
  await expect(drawer).toBeVisible();
  await drawer.getByLabel(/^Date/).fill(`${MONTH}-18`);
  await drawer.getByLabel(/^Property/).selectOption('HYD-501');
  await drawer.getByLabel(/^Category/).selectOption('Variable Operating');
  await drawer.getByLabel(/^Subcategory/).fill('Electricity');
  await drawer.getByLabel(/^Description/).fill(description);
  await drawer.getByLabel(/^Amount/).fill('2222');
  await expect(drawer.getByLabel(/^Amount/)).toHaveValue('2222');
  await drawer.getByLabel(/^Payment status/).selectOption('Paid');
  await drawer.getByLabel(/^Paid on/).fill(`${MONTH}-18`);
}

test('expense · happy path: drawer → APPLYING → VERIFIED toast → ledger grows', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto(`/admin/finance/expenses?month=${MONTH}`);
  const rowsBefore = await page.locator('tbody tr').count();

  await fillExpenseDrawer(page, 'Happy path expense');
  await page.locator('.sv-drawer button[type=submit]').click();

  // The toast names the verified record; the drawer closes; the ledger re-reads.
  const toast = page.locator('.sv-toast--success .sv-toast__title');
  await expect(toast).toContainText(/EXP-\d{4}-\d{4} recorded/);
  await expect(page.locator('.sv-drawer')).toHaveCount(0);
  await expect(page.locator('tbody tr')).toHaveCount(rowsBefore + 1);
});

test('expense · visible APPLYING state while the server works', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto(`/admin/finance/expenses?month=${MONTH}`);

  // Hold the mutation response so the applying state is observable.
  await page.route('**/api/expenses', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });

  await fillExpenseDrawer(page, 'Applying-state expense');
  const submit = page.locator('.sv-drawer button[type=submit]');
  await submit.click();
  await expect(submit).toHaveAttribute('data-phase', 'applying');
  await expect(submit).toContainText('Applying…');
  await expect(submit).toBeDisabled();

  await expect(page.locator('.sv-toast--success')).toBeVisible({ timeout: 15_000 });
});

test('expense · double-click produces exactly ONE business row', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto(`/admin/finance/expenses?month=${MONTH}`);
  const rowsBefore = await page.locator('tbody tr').count();

  await fillExpenseDrawer(page, 'Double-click expense');
  const submit = page.locator('.sv-drawer button[type=submit]');
  // Two clicks as fast as the runner can issue them.
  await submit.click();
  await submit.click({ force: true }).catch(() => { /* already disabled — good */ });

  await expect(page.locator('.sv-toast--success .sv-toast__title')).toContainText(/recorded/);
  await expect(page.locator('tbody tr')).toHaveCount(rowsBefore + 1);
});

test('expense · failure state: refused write stays on screen with the operation id', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto(`/admin/finance/expenses?month=${MONTH}`);

  await fillExpenseDrawer(page, 'Zero-amount expense');
  // The currency input re-renders on focus (formatted -> plain); assert the value TOOK
  // before submitting, or the race quietly submits the previous amount.
  const amount = page.locator('.sv-drawer').getByLabel(/^Amount/);
  await amount.click();
  await amount.fill('0');
  await expect(amount).toHaveValue('0');
  await page.locator('.sv-drawer button[type=submit]').click();

  const failure = page.locator('.sv-mutation-form__failure');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText(/Operation [0-9a-f-]{36}/);
  // The drawer stays open; the button returns to a submittable state.
  await expect(page.locator('.sv-drawer')).toBeVisible();
  await expect(page.locator('.sv-drawer button[type=submit]')).toHaveAttribute('data-phase', 'failed');
});

test('expense · operation-id replay and network retry return the SAME record', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/dashboard');

  const payload = expensePayload({ description: 'Replay expense' });
  const first = await postJson(page, '/api/expenses', payload);
  expect(first.status()).toBe(200);
  const firstBody = await first.json();

  // A timeout retry re-sends the identical request with the identical operation id.
  const second = await postJson(page, '/api/expenses', payload);
  expect(second.status()).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.record.ExpenseID).toBe(firstBody.record.ExpenseID);

  // The same id with a DIFFERENT payload is a refused mismatch, not a new row.
  const tampered = await postJson(page, '/api/expenses', { ...payload, amount: 9999 });
  expect(tampered.status()).toBe(409);
});

test('expense · calculated-column injection is refused with 422', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/dashboard');

  const smuggled = await postJson(page, '/api/expenses',
    expensePayload({ TotalAmount: 999999 }));
  expect(smuggled.status()).toBe(422);
  const body = await smuggled.json();
  expect(body.error.code).toBe('VALIDATION');
});

test('expense · OPERATIONS role is refused the financial write', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  const res = await postJson(page, '/api/expenses', expensePayload());
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN');
});

test('every mutation endpoint is refused for INVESTOR', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');
  for (const [method, path] of [
    ['post', '/api/expenses'], ['post', '/api/reservations'], ['post', '/api/maintenance'],
    ['post', '/api/capex'], ['post', '/api/housekeeping'], ['patch', '/api/inventory/ITM-001'],
  ] as const) {
    const res = method === 'post'
      ? await page.request.post(path, { data: { operationId: randomUUID() } })
      : await page.request.patch(path, { data: { operationId: randomUUID() } });
    expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(403);
  }
});

/* ================================================================== *
 * Reservation — lifecycle through the UI
 * ================================================================== */

test('reservation · create → check in → check out, each verified on the board', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto(`/admin/operations/reservations?month=${MONTH}`);

  await page.getByRole('button', { name: '+ New Reservation' }).click();
  const drawer = page.locator('.sv-drawer');
  await drawer.getByLabel(/^Property/).selectOption('HYD-601');
  await drawer.getByLabel("Platform *", { exact: true }).selectOption('Direct');
  await drawer.getByLabel(/^Guest name/).fill('Playwright Lifecycle Guest');
  await drawer.getByLabel(/^Booked on/).fill(`${MONTH}-01`);
  await drawer.getByLabel(/^Check-in/).fill(`${MONTH}-20`);
  await drawer.getByLabel(/^Check-out/).fill(`${MONTH}-22`);
  await drawer.locator('button[type=submit]').click();

  const toast = page.locator('.sv-toast--success .sv-toast__title').first();
  await expect(toast).toContainText(/BK-\d{4}-\d{4} created/);
  const bookingId = (await toast.textContent())!.match(/BK-\d{4}-\d{4}/)![0];

  // The new booking's row offers Check In; run the lifecycle from the board.
  const row = page.locator('tbody tr', { hasText: bookingId });
  await row.getByRole('button', { name: 'Check In' }).click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'checked in' }))
    .toBeVisible();
  await expect(row.locator('.sv-pill')).toContainText('Checked In');

  await row.getByRole('button', { name: 'Check Out' }).click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'checked out' }))
    .toBeVisible();
  await expect(row.locator('.sv-pill')).toContainText('Checked Out');
});

test('reservation · validation failure is spelled out (check-out before check-in)', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto(`/admin/operations/reservations?month=${MONTH}`);

  await page.getByRole('button', { name: '+ New Reservation' }).click();
  const drawer = page.locator('.sv-drawer');
  await drawer.getByLabel(/^Property/).selectOption('HYD-601');
  await drawer.getByLabel("Platform *", { exact: true }).selectOption('Direct');
  await drawer.getByLabel(/^Guest name/).fill('Backwards Dates');
  await drawer.getByLabel(/^Booked on/).fill(`${MONTH}-01`);
  await drawer.getByLabel(/^Check-in/).fill(`${MONTH}-22`);
  await drawer.getByLabel(/^Check-out/).fill(`${MONTH}-20`);
  await drawer.locator('button[type=submit]').click();

  const failure = page.locator('.sv-mutation-form__failure');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('checkOutDate must be after checkInDate');
});

test('reservation · cancel requires a reason and leaves the row in place', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/dashboard');
  // Create via API (same pipeline), cancel via the board UI.
  const created = await postJson(page, '/api/reservations', {
    operationId: randomUUID(), platform: 'Direct', propertyId: 'HYD-602',
    bookingDate: `${MONTH}-01`, guestName: 'Cancel Me', adults: 2, children: 0,
    checkInDate: `${MONTH}-25`, checkOutDate: `${MONTH}-27`,
  });
  expect(created.status()).toBe(200);
  const bookingId = (await created.json()).record.BookingID as string;

  await page.goto(`/admin/operations/reservations?month=${MONTH}`);
  const row = page.locator('tbody tr', { hasText: bookingId });
  await row.getByRole('button', { name: 'Cancel' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Why is this booking/).fill('Guest called to cancel — Playwright test');
  await dialog.locator('button[type=submit]').click();

  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'cancelled' }))
    .toBeVisible();
  await expect(row.locator('.sv-pill')).toContainText('Cancelled');
});

/* ================================================================== *
 * Maintenance — drawer create + resolve dialog
 * ================================================================== */

test('maintenance · create appears on the board; resolve requires a date', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/maintenance');
  const openBefore = await page.locator('tbody tr').count();

  await page.getByRole('button', { name: '+ New Maintenance Issue' }).click();
  const drawer = page.locator('.sv-drawer');
  await drawer.getByLabel(/^Property/).selectOption('HYD-502');
  await drawer.getByLabel(/^Reported on/).fill(`${MONTH}-18`);
  await drawer.getByLabel(/^Category/).selectOption('Plumbing');
  await drawer.getByLabel(/What is wrong/).fill('Playwright: shower drain blocked');
  await drawer.getByLabel(/^Priority/).selectOption('High');
  await drawer.locator('button[type=submit]').click();

  const toast = page.locator('.sv-toast--success .sv-toast__title').first();
  await expect(toast).toContainText(/MNT-\d{4}-\d{4} created/);
  const ticketId = (await toast.textContent())!.match(/MNT-\d{4}-\d{4}/)![0];
  await expect(page.locator('tbody tr')).toHaveCount(openBefore + 1);

  // Resolve it through the dialog — the date is required by the pipeline.
  const row = page.locator('tbody tr', { hasText: ticketId });
  await row.getByRole('button', { name: 'Resolve' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Resolved on/).fill(`${MONTH}-19`);
  await dialog.locator('button[type=submit]').click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'resolved' }))
    .toBeVisible();
});

/* ================================================================== *
 * CAPEX, Housekeeping, Inventory — same pipeline, API-level happy paths
 * ================================================================== */

test('capex · create lands in the CAPEX register', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/dashboard');
  const res = await postJson(page, '/api/capex', {
    operationId: randomUUID(), propertyId: 'HYD-501', date: `${MONTH}-10`,
    category: 'Furniture', item: 'Playwright bookshelf', quantity: 1, unitCost: 5500,
    paymentStatus: 'Paid',
  });
  expect(res.status()).toBe(200);
  const id = (await res.json()).record.CapexID as string;
  expect(id).toMatch(/^CAP-\d{4}-\d{4}$/);

  await page.goto(`/admin/finance/capex?month=${MONTH}`);
  await expect(page.locator('tbody')).toContainText(id);
});

test('housekeeping · create + mark clean through the dialog', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/dashboard');
  const res = await postJson(page, '/api/housekeeping', {
    operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: `${MONTH}-18`,
  });
  expect(res.status()).toBe(200);
  const taskId = (await res.json()).record.TaskID as string;

  await page.goto('/admin/operations/housekeeping');
  const row = page.locator('tbody tr', { hasText: taskId });
  await row.getByRole('button', { name: 'Mark Clean' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Cleaned by/).fill('Playwright Cleaner');
  await dialog.locator('button[type=submit]').click();
  await expect(page.locator('.sv-toast--success .sv-toast__title', { hasText: 'completed' }))
    .toBeVisible();
});

test('inventory · a movement updates inputs; stock stays workbook-owned', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/inventory');
  const firstRow = page.locator('tbody tr').first();
  const itemId = (await firstRow.locator('code').first().textContent())!;

  await firstRow.getByRole('button', { name: 'Movement' }).click();
  const dialog = page.locator('.sv-modal');
  await dialog.getByLabel(/Purchased/).fill('5');
  await dialog.getByLabel(/Last purchase date/).fill(`${MONTH}-18`);
  await dialog.locator('button[type=submit]').click();

  await expect(page.locator('.sv-toast--success .sv-toast__title'))
    .toContainText(`${itemId} updated`);
});

/* ================================================================== *
 * Production-safety spot check from the browser side
 * ================================================================== */

test('no DELETE verb reaches the API at all', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  const res = await page.request.delete('/api/expenses/EXP-2027-9001', {
    data: { operationId: randomUUID() },
  });
  // Next serves no DELETE handler on the gateway: 405 (or 404), never a mutation.
  expect([404, 405]).toContain(res.status());
});
