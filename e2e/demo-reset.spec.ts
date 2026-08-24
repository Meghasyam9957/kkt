/**
 * THE DEMONSTRATION RESET — walkthrough step 14, through the interface a presenter uses.
 *
 * Every demonstration ends here, and it is the step with the least room for surprise: the
 * presenter has just spent twenty minutes creating a booking, an expense and a ticket in
 * front of a client, and now says "and we can put it all back". Until this spec existed
 * the reset was covered only at unit level, so nothing proved that the button, the
 * confirmation and the discard actually work together against the running server.
 *
 * ISOLATION: this test wipes global demonstration state, so it cannot run beside the
 * specs that create records — they count rows before and after, and a reset underneath
 * them invalidates the count. playwright.config.ts therefore puts it in its own project
 * that `dependencies` on the main one, which makes it run only after everything else has
 * finished. Do not move it back into the default project.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const MONTH = '2027-02';

async function signIn(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/admin\//);
  await page.waitForSelector('.sv-sidebar');
}

test('a demonstration write is created, then discarded by the reset', async ({ page }) => {
  test.slow();
  await signIn(page, 'Demo Administrator');

  // 1 · something a demonstration would have created, through the real pipeline.
  const created = await page.request.post('/api/expenses', {
    data: {
      operationId: randomUUID(), date: `${MONTH}-18`, propertyId: 'HYD-501',
      expenseCategory: 'Variable Operating', expenseSubcategory: 'Electricity',
      description: 'reset-coverage expense', amount: 4321,
      paymentStatus: 'Paid', paidDate: `${MONTH}-18`,
    },
  });
  expect(created.status()).toBe(200);
  const expenseId = (await created.json()).record.ExpenseID as string;

  await page.goto(`/admin/finance/expenses?month=${MONTH}`);
  await expect(page.locator('tbody')).toContainText(expenseId);

  // 2 · the control, and the confirmation the presenter reads aloud.
  await page.goto('/admin/demo');
  await page.getByRole('button', { name: 'Reset demo environment' }).click();
  await expect(page.getByText('Reset the demonstration environment?')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, reset the demo' }).click();
  await page.waitForURL(/\/admin\/demo/, { timeout: 60_000 });

  // 3 · the seed is genuinely back: the demonstration's own row is gone.
  await page.goto(`/admin/finance/expenses?month=${MONTH}`);
  await expect(
    page.locator('tbody'),
    'the reset left a demonstration write behind',
  ).not.toContainText(expenseId);
});
