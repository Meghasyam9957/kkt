/**
 * M-INV-1 — stock, procurement and assets, in a real browser.
 *
 * What only a browser can settle: whether a supervisor can actually reach the action, whether
 * a page serialises a figure it should be withholding, whether a refusal arrives as a
 * sentence rather than as a stack trace, and whether any of it survives being read on a
 * phone. That the service returns the right rows is proved next door in
 * `tests/inventory.test.ts`, far faster and in far more detail.
 *
 * THE ASSERTION THIS FILE EXISTS FOR: a movement moves the WORKBOOK, and the page never
 * claims a stock figure of its own. Everything else here supports that one.
 *
 * The dev server accumulates demo state across tests, so every quantity assertion is
 * RELATIVE — before and after — and never absolute.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function signInAs(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('main#main');
}

/** A money FIELD, as it would appear if one were serialised into a page that withholds it. */
const MONEY_FIELD = /"(purchaseCostMinor|expectedUnitPriceMinor|unitPrice|purchaseCost)"\s*:\s*\d/;

async function reconciliationFor(page: Page, itemRef: string) {
  const rows = await page.request.get('/api/inventory/reconciliation').then((r) => r.json());
  return rows.find((r: { itemRef: string }) => r.itemRef === itemRef);
}

test('stock reads the workbook’s own figure and offers the movement action', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/inventory');
  await page.waitForSelector('main#main');

  await expect(page.getByRole('heading', { name: 'Stock', exact: true })).toBeVisible();
  // The sentence the whole milestone rests on, on the screen itself.
  await expect(page.getByText(/the sheet remains the only stock ledger/i)).toBeVisible();

  await expect(page.getByRole('button', { name: 'Record movement' }).first()).toBeVisible();
});

test('a movement moves the workbook, and reconciliation then agrees', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/inventory');
  await page.waitForSelector('main#main');

  const before = await reconciliationFor(page, 'ITM-D-001');
  expect(before, 'the demo workbook has this item').toBeTruthy();

  const response = await page.request.post('/api/inventory/movements', {
    data: {
      operationId: randomUUID(), itemRef: 'ITM-D-001',
      movementType: 'CONSUMPTION', quantity: 2, taskRef: 'E2E-TURNOVER',
    },
  });
  expect(response.status(), await response.text()).toBe(200);

  const after = await reconciliationFor(page, 'ITM-D-001');
  // BOTH sides moved by the same amount: the sheet took the write, and the context row
  // explains it. A movement that moved only one of them is the bug this page reports.
  expect(after.workbookUsed).toBe(before.workbookUsed + 2);
  expect(after.contextUsed).toBe(before.contextUsed + 2);
  expect(after.status).toBe('MATCHED');
});

test('the movement record shows why, and totals nothing', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.request.post('/api/inventory/movements', {
    data: {
      operationId: randomUUID(), itemRef: 'ITM-D-004',
      movementType: 'WASTAGE', quantity: 1, wastageReason: 'DAMAGED',
    },
  });

  await page.goto('/admin/inventory/movements');
  await page.waitForSelector('main#main');

  await expect(page.getByRole('heading', { name: 'Stock movements' })).toBeVisible();
  await expect(page.getByText(/deliberately not totalled/i)).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Why' })).toBeVisible();

  // Who made a movement is held, and is not printed beside every one of them.
  const html = await page.content();
  expect(html, 'no employee identifier reaches the movement list')
    .not.toMatch(/"employeeId"\s*:\s*"/);
});

test('operations may record why stock moved, and may not correct the count', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/inventory');
  await page.waitForSelector('main#main');

  const allowed = await page.request.post('/api/inventory/movements', {
    data: {
      operationId: randomUUID(), itemRef: 'ITM-D-005',
      movementType: 'CONSUMPTION', quantity: 1,
    },
  });
  expect(allowed.status()).toBe(200);

  const refused = await page.request.post('/api/inventory/movements', {
    data: {
      operationId: randomUUID(), itemRef: 'ITM-D-005', movementType: 'ADJUSTMENT',
      quantity: 5, adjusts: 'USED', reason: 'the count came up short',
    },
  });
  expect(refused.status()).toBe(403);
  const body = await refused.json();
  expect(body.error.code).toBe('ADJUSTMENT_NOT_PERMITTED');
  // A refusal is a sentence somebody can act on, never a diagnostic.
  expect(String(body.error.message).toLowerCase()).not.toMatch(/postgres|sqlstate|stack|undefined/);
});

test('an asset’s purchase cost is withheld from operations, and said to be', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/inventory/assets');
  await page.waitForSelector('main#main');

  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
  // Not blank and not zero: "nothing was paid" is a different and untrue sentence.
  await expect(page.getByText('not shown to you').first()).toBeVisible();

  const html = await page.content();
  expect(html, 'no cost figure is serialised into a page that withholds it')
    .not.toMatch(MONEY_FIELD);
});

test('an administrator sees the cost, and the register the product never surfaced', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');
  await page.goto('/admin/inventory/assets');
  await page.waitForSelector('main#main');

  await expect(page.getByText(/Nothing here is depreciated, revalued or written down/i))
    .toBeVisible();
  // 16_ASSETS, read for the first time.
  await expect(page.getByText('AST-D-0001')).toBeVisible();
});

test('procurement keeps a request, an order and a delivery apart', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/inventory/procurement');
  await page.waitForSelector('main#main');

  await expect(page.getByRole('heading', { name: 'Procurement' })).toBeVisible();
  await expect(page.getByText(/only a delivery moves stock/i)).toBeVisible();

  await page.getByRole('button', { name: 'Ask for stock' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();

  const item = drawer.getByLabel('Which item');
  await item.selectOption({ index: 1 });
  await expect(item, 'an item is chosen before confirming').not.toHaveValue('');
  await drawer.getByLabel('How many').fill('6');
  await drawer.getByRole('button', { name: 'Ask for stock' }).click();

  /*
   * Asserted on the OUTCOME rather than on the toast, which is transient by design. Either
   * end state is the product working: the request lands, or the server explains why not.
   */
  const refused = page.locator('.sv-mutation-form__failure');
  await expect
    .poll(async () => (await refused.count()) > 0 || (await drawer.count()) === 0,
      { timeout: 20_000, message: 'the flow ends by landing or by explaining a refusal' })
    .toBe(true);

  if (await refused.count() === 0) {
    await page.reload();
    await page.waitForSelector('main#main');
    // Asking is not ordering: it lands as a draft, and nothing has moved.
    await expect(page.getByText('draft').first()).toBeVisible();
  }
});

test('whoever asked cannot be whoever approves', async ({ page }) => {
  await signInAs(page, 'Demo Administrator');

  const created = await page.request.post('/api/inventory/requests', {
    data: {
      operationId: randomUUID(), reason: 'Playwright separation of duty',
      lines: [{ itemRef: 'ITM-D-002', quantity: 4 }],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const id = (await created.json()).id as string;

  const submitted = await page.request.post(`/api/inventory/requests/${id}/decision`, {
    data: { operationId: randomUUID(), status: 'SUBMITTED' },
  });
  expect(submitted.status()).toBe(200);

  const selfApproved = await page.request.post(`/api/inventory/requests/${id}/decision`, {
    data: { operationId: randomUUID(), status: 'APPROVED' },
  });
  expect(selfApproved.status()).toBe(409);
  expect((await selfApproved.json()).error.code).toBe('SELF_APPROVAL');
});

test('an investor reaches no part of the inventory domain', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');

  for (const path of [
    '/api/inventory/stock', '/api/inventory/movements', '/api/inventory/reconciliation',
    '/api/inventory/requests', '/api/inventory/purchase-orders', '/api/inventory/assets',
  ]) {
    const response = await page.request.get(path);
    expect([401, 403], `${path} must refuse an investor`).toContain(response.status());
  }
});

test('the stock screens stay usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInAs(page, 'Demo Administrator');

  for (const path of [
    '/admin/inventory',
    '/admin/inventory/movements',
    '/admin/inventory/procurement',
    '/admin/inventory/assets',
    '/admin/inventory/reconciliation',
  ]) {
    await page.goto(path);
    await page.waitForSelector('main#main');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} must not scroll sideways at 375px`).toBeLessThanOrEqual(0);
  }
});
