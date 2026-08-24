/**
 * DEMONSTRATION STATE DURABILITY.
 *
 * The demo environment keeps its workbook, its operation ledger and its id sequences in
 * memory. `next dev` compiles routes on demand, and compiling a route it has not served
 * before re-evaluates the server module graph — which used to reinitialise every one of
 * those, silently, mid-session.
 *
 * The symptom was not subtle once looked for: record an expense, open three screens the
 * session had not visited yet, and the expense was gone — `/api/operations-log/<id>`
 * answered 404 after answering 200, and the row had vanished from the ledger. On the
 * documented demonstration path (create a booking in step 5, open Housekeeping in step 7)
 * that is a record disappearing in front of a client.
 *
 * This test navigates deliberately to screens the write flows never touch, so the routes
 * really are cold, and then asserts the write is still there. It fails if process-wide
 * state regresses to module-level bindings.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const MONTH = '2027-02';

/** Screens no other spec visits, so this run compiles them for the first time here. */
const COLD_ROUTES = [
  '/admin/analytics/performance',
  '/admin/settings',
  '/admin/investors/reports',
];

async function signIn(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/admin\//);
  await page.waitForSelector('.sv-sidebar');
}

test('a recorded expense survives navigating to routes compiled for the first time', async ({ page }) => {
  test.slow();
  await signIn(page, 'Demo Administrator');

  const operationId = randomUUID();
  const created = await page.request.post('/api/expenses', {
    data: {
      operationId, date: `${MONTH}-18`, propertyId: 'HYD-501',
      expenseCategory: 'Variable Operating', expenseSubcategory: 'Electricity',
      description: 'demo-state durability expense', amount: 1234,
      paymentStatus: 'Paid', paidDate: `${MONTH}-18`,
    },
  });
  expect(created.status()).toBe(200);
  const expenseId = (await created.json()).record.ExpenseID as string;

  // The operation ledger knows it now.
  expect((await page.request.get(`/api/operations-log/${operationId}`)).status()).toBe(200);

  for (const route of COLD_ROUTES) await page.goto(route);

  // …and still knows it after the compiler has rebuilt the module graph underneath.
  expect(
    (await page.request.get(`/api/operations-log/${operationId}`)).status(),
    'the operation ledger was discarded by a cold route compile',
  ).toBe(200);

  await page.goto(`/admin/finance/expenses?month=${MONTH}`);
  await expect(
    page.locator('tbody'),
    'the recorded expense was discarded by a cold route compile',
  ).toContainText(expenseId);
});
