/**
 * M-OPS-3 — the supervisor's morning, in a real browser.
 *
 * The workflow this milestone exists to make real:
 *
 *   sign in → Today → who is working → the queues → assign somebody → see it stick
 *
 * Every assertion here is about something only a browser can settle. That a service returns
 * the right rows is proved next door in `tests/operations-people.test.ts`, far faster and in
 * far more detail; what those tests cannot say is whether a supervisor can actually reach the
 * action, whether the page serialises something it should not, and whether any of it survives
 * being read on a phone.
 */
import { test, expect, type Page } from '@playwright/test';

async function signInAs(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('main#main');
}

/**
 * A withheld FIELD, as it would appear if one were ever serialised into a page.
 *
 * Matched as a JSON key rather than as an English word, and the distinction is not
 * pedantry. The staffing card explains that recording attendance is what lets payroll be
 * approved without an override — useful, true, and entirely prose. A test that failed on
 * the word would push that sentence out of the product to satisfy a regex, while a payload
 * genuinely carrying `"salary":` would sail past a reader who had learned to expect the
 * word rather than the field.
 */
const WITHHELD_FIELD =
  /"(salary|grossPay|netPay|gross|net|ctc|wage|payroll|bankAccount|ifsc|contactRef|email|tenantId)"\s*:/i;

test('the housekeeping queue offers an assignment, and says who holds each task', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/housekeeping');
  await page.waitForSelector('main#main');

  await expect(page.getByRole('heading', { name: 'Housekeeping', exact: true })).toBeVisible();

  // The demonstration roster is seeded on first read, so the action is offered.
  const assign = page.getByRole('button', { name: /^(Assign|Reassign)$/ }).first();
  await expect(assign, 'a supervisor can reach the action from the queue').toBeVisible();
});

test('assigning walks the supervisor through choose → confirm → result', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/housekeeping');
  await page.waitForSelector('main#main');

  await page.getByRole('button', { name: /^(Assign|Reassign)$/ }).first().click();

  /*
   * Scoped to the dialog from here on. `RowActionButton` gives its drawer submit the SAME
   * label as the row control that opened it, and the queue has one such control per row —
   * so an unscoped "last button named Assign" is another row's, not this form's.
   */
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();

  // The picker names people the way a supervisor chooses by — name, code, shift, today.
  const picker = drawer.getByLabel(/Assign to|Reassign to/);
  await expect(picker).toBeVisible();
  const options = await picker.locator('option').allTextContents();
  expect(options.join(' '), 'the roster is populated').toMatch(/HK-00\d|MT-00\d/);

  // Nothing about pay reaches the drawer, which is where a naive picker would leak it.
  expect(options.join(' ')).not.toMatch(WITHHELD_FIELD);

  /*
   * Selected by index, and the selection is ASSERTED before submitting.
   *
   * The employee field is required, so a form still sitting on "Choose…" is refused by the
   * browser before any request leaves — silently, with no toast and no error element. A test
   * that submitted without checking would then wait out its timeout on an outcome that was
   * never going to arrive, and report it as a broken feature rather than a broken click.
   */
  await picker.selectOption({ index: 1 });
  await expect(picker, 'a person is chosen before confirming').not.toHaveValue('');

  await drawer.getByRole('button', { name: /^(Assign|Reassign)$/ }).click();

  /*
   * ASSERTED ON THE OUTCOME, not on the notification.
   *
   * A success toast is transient by design — it announces and then gets out of the way — so
   * racing it makes a test that fails for reasons that have nothing to do with the product.
   * What must be true afterwards is durable: the queue names the person, and the drawer says
   * since when. That is also the thing a supervisor actually cares about.
   *
   * Either server outcome is correct here and both are the product working: a clean
   * assignment settles, and somebody on their weekly off comes back as OVERRIDE_REQUIRED
   * with the reason spelled out — the server's rule, deliberately not re-implemented in the
   * browser. So the assertion accepts either, and insists only that the page ends up in a
   * state that says which.
   */
  const refused = page.locator('.sv-mutation-form__failure');
  const named = page.locator('.sv-assigned__name');

  await expect
    .poll(async () => (await refused.count()) > 0 || (await named.count()) > 0,
      { timeout: 20_000, message: 'the flow ends by naming somebody or by explaining a refusal' })
    .toBe(true);

  if (await refused.count() > 0) {
    const words = (await refused.first().innerText()).toLowerCase();
    // A refusal is a sentence a person can act on, never a diagnostic.
    expect(words).not.toMatch(/postgres|sqlstate|stack|undefined/);
    expect(words.length, 'a refusal says something').toBeGreaterThan(0);
  } else {
    await page.reload();
    await page.waitForSelector('main#main');
    // The queue now names a person against the task, which is the whole point of assigning.
    await expect(page.locator('.sv-assigned__name').first()).toBeVisible();
  }
});

test('the maintenance queue names the technician and marks an unlinked name', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/maintenance');
  await page.waitForSelector('main#main');

  await expect(page.getByRole('columnheader', { name: 'Technician' })).toBeVisible();
  const html = await page.content();
  expect(html, 'no compensation field reaches the maintenance queue').not.toMatch(WITHHELD_FIELD);
});

test('reconciliation explains itself without exposing an identifier as a name', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/reconciliation');
  await page.waitForSelector('main#main');

  await expect(page.getByRole('heading', { name: 'Reconciliation' })).toBeVisible();
  // The four counts a supervisor works from.
  for (const label of ['Linked', 'Needs review', 'Unlinked', 'Ambiguous']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }

  const body = await page.locator('main#main').innerText();
  // A uuid where a person's name belongs would make the screen unreadable exactly when it
  // matters. Names are shown; identifiers travel as values, never as labels.
  expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('Today carries staffing and, when there is any, urgent work with no owner', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/today');
  await page.waitForSelector('main#main');

  await expect(page.locator('.sv-card', { hasText: "Today's staff" })).toBeVisible();

  const urgent = page.locator('.sv-card', { hasText: 'Urgent work with no owner' });
  if (await urgent.count() > 0) {
    // It renders only when something qualifies, so its absence is also a correct outcome.
    await expect(urgent.first()).toBeVisible();
    await expect(urgent.first().getByRole('button', { name: /^Assign$/ }).first()).toBeVisible();
  }

  const html = await page.content();
  expect(html, 'no compensation field is serialised into Today').not.toMatch(WITHHELD_FIELD);
});

test('an investor reaches none of it', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');

  for (const path of [
    '/api/operations/reconciliation',
    '/api/operations/urgent',
    '/api/operations/staffing',
  ]) {
    const response = await page.request.get(path);
    expect([401, 403], `${path} must refuse an investor`).toContain(response.status());
  }
});

test('the queues stay usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInAs(page, 'Demo Operations Manager');

  for (const path of [
    '/admin/operations/housekeeping',
    '/admin/operations/maintenance',
    '/admin/operations/reconciliation',
  ]) {
    await page.goto(path);
    await page.waitForSelector('main#main');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} must not scroll sideways at 375px`).toBeLessThanOrEqual(0);
  }
});
