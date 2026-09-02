/**
 * M-OPS-2 — the people half of Today, in a real browser.
 *
 * What these pin is the boundary rather than the happy path. The demo environment runs
 * the in-memory HR store with no employees in it, so the interesting question is not
 * "does the roster render five names" — it is:
 *
 *   does the section appear at all for the roles that hold `operations.staff.read`,
 *   does it say something true when there is nobody on the books,
 *   does the payload reaching the browser contain no compensation field,
 *   and is the assignment route still refused to a role that must not reach it.
 *
 * The last two are the ones worth a browser: a server-side projection can be verified in
 * a unit test, but "nothing about pay reached the client" is a claim about what was
 * actually serialised into the page, and that is only checkable here.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function signInAs(page: Page, label: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForURL(/\/admin\/(dashboard|portfolio|operations)/);
  await page.waitForSelector('main#main');
}

/** Every word that would mean money about a person. None may reach this page. */
const COMPENSATION = /\bsalary\b|\bwage\b|\bpayroll\b|\bgross\b|\bnet pay\b|\bctc\b|\bbank\b|\bifsc\b|\bupi\b|\badvance\b/i;

test('today shows who is working, beside what is happening', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/today');
  await page.waitForSelector('main#main');

  // The board is unchanged and still first: staffing is composed alongside it, not in
  // place of it, so a failure in one must not take the other with it.
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();

  const staffing = page.locator('.sv-card', { hasText: "Today's staff" });
  await expect(staffing).toBeVisible();

  /*
   * Nobody is on the books in demo, and the section says so in words. This is the
   * assertion the milestone actually cares about: an empty roster must read as "nobody has
   * been added yet", never as an empty table that looks like everyone is absent.
   */
  await expect(staffing).toContainText(/Nobody is on the books yet/i);
});

test('no compensation field reaches the browser on today', async ({ page }) => {
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/today');
  await page.waitForSelector('main#main');

  // The whole document, not the rendered text: a field serialised into the RSC payload
  // and never displayed would still have left the server.
  const html = await page.content();
  expect(html, 'no compensation term may be serialised into the operations page')
    .not.toMatch(COMPENSATION);
});

test('the staffing section is absent for a role without the capability', async ({ page }) => {
  await signInAs(page, 'Investor Demo A');

  // An investor cannot reach the operations board at all; asserting the section is absent
  // from a page they cannot open would prove nothing, so ask the API directly.
  const staffing = await page.request.get('/api/operations/staffing');
  expect([401, 403], 'an investor holds no operations capability')
    .toContain(staffing.status());

  const assign = await page.request.post('/api/operations/assignments', {
    data: {
      operationId: randomUUID(),
      taskType: 'HOUSEKEEPING',
      taskRef: 'HK-2026-0001',
      employeeId: '00000000-0000-4000-8000-000000000001',
    },
  });
  expect([401, 403], 'and certainly cannot assign somebody to work')
    .toContain(assign.status());
});

test('the staffing section stays usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInAs(page, 'Demo Operations Manager');
  await page.goto('/admin/operations/today');
  await page.waitForSelector('main#main');

  await expect(page.locator('.sv-card', { hasText: "Today's staff" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'today must not scroll sideways with the staffing section on it')
    .toBeLessThanOrEqual(0);
});
