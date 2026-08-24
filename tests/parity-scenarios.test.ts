/**
 * The two pieces of the preflight that decide whether the operator is blocked, and what
 * they are told when they are.
 *
 *  · `detectScenarios` — does the parity copy contain each of the eleven required business
 *    conditions? A false "present" lets a run claim coverage it does not have; a false
 *    "missing" blocks a perfectly good workbook.
 *  · `explainConnectionError` — the operator sees this at the exact moment the gate is
 *    being closed, so "DECODER routines::unsupported" is not an acceptable answer.
 *
 * Both are pure, and both are judged from the workbook's own figures rather than from the
 * TypeScript engine — so a bug in the engine cannot make a condition look absent.
 */
import { describe, it, expect } from 'vitest';
import { detectScenarios, explainConnectionError, REQUIRED_SCENARIOS }
  from '../scripts/parity-preflight.mjs';

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07'];
const twelve = (...values: number[]) =>
  Array.from({ length: MONTHS.length }, (_, i) => values[i] ?? 0);

/** A copy in which every scenario is present — the shape a seeded workbook produces. */
function healthy(overrides: Record<string, unknown> = {}) {
  return {
    monthKeys: MONTHS,
    grossRevenue: twelve(100_000, 0, 120_000, 90_000),          // May is a zero-revenue month
    operatingExpenses: twelve(40_000, 0, 200_000, 45_000),      // June is a spike; May is empty
    operatingProfit: twelve(20_000, 0, -90_000, 15_000),        // June is a loss
    bookingsCount: twelve(12, 0, 14, 11),
    cancelledCount: twelve(0, 0, 2, 0),
    carryForwardApplied: twelve(0, 0, 0, 90_000),               // recovered in July
    bookings: [
      { id: 'BK-001', expectedPayout: 10_000, actualPayout: 10_000 },
      { id: 'BK-002', expectedPayout: 10_000, actualPayout: 6_000 },   // short-paid
    ],
    expenses: [
      { id: 'EXP-001', type: 'Operating' },
      { id: 'EXP-002', type: 'CAPEX' },                                // misfiled
    ],
    activeInvestors: 3,
    propertyCount: 4,
    platformsInReportMonth: ['Airbnb', 'Direct'],
    payoutTolerance: 100,
    reportMonth: '2026-06',
    ...overrides,
  };
}

type Detected = Record<string, { present: boolean; where: string }>;
const detect = (input: Record<string, unknown>) =>
  detectScenarios(input as never) as Detected;

const presence = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(detectScenarios(input as never))
    .map(([name, r]) => [name, (r as { present: boolean }).present]));

describe('scenario detection · a properly seeded copy', () => {
  it('finds all eleven', () => {
    const detected = detect(healthy());
    const missing = REQUIRED_SCENARIOS.filter((name: string) => !detected[name]!.present);
    expect(missing).toEqual([]);
  });

  it('says where each one was found, so the report can show it', () => {
    const detected = detect(healthy());
    expect(detected['zero revenue period']!.where).toBe('2026-05');
    expect(detected['cancellation']!.where).toContain('2026-06');
    expect(detected['partial payout']!.where).toContain('BK-002');
    expect(detected['misfiled CAPEX']!.where).toContain('EXP-002');
    expect(detected['negative month']!.where).toContain('2026-06');
    expect(detected['loss recovery']!.where).toContain('2026-07');
  });
});

describe('scenario detection · each one can actually go missing', () => {
  it.each([
    ['zero revenue period', { grossRevenue: twelve(100_000, 80_000, 120_000, 90_000) }],
    ['empty month', { operatingExpenses: twelve(40_000, 1_000, 200_000, 45_000) }],
    ['cancellation', { cancelledCount: twelve(0, 0, 0, 0) }],
    ['partial payout', { bookings: [{ id: 'BK-001', expectedPayout: 10_000, actualPayout: 10_000 }] }],
    // May stays at zero so the empty-month scenario is untouched; only the spike goes.
    ['expense spike', { operatingExpenses: twelve(40_000, 0, 42_000, 43_000) }],
    ['misfiled CAPEX', { expenses: [{ id: 'EXP-001', type: 'Operating' }] }],
    ['negative month', { operatingProfit: twelve(20_000, 0, 90_000, 15_000) }],
    ['loss recovery', { carryForwardApplied: twelve(0, 0, 0, 0) }],
    ['multiple investors', { activeInvestors: 1 }],
    ['property filtering', { propertyCount: 1 }],
    ['platform filtering', { platformsInReportMonth: ['Airbnb'] }],
  ])('reports "%s" as missing when it is', (scenario, override) => {
    const detected = presence(healthy(override));
    expect(detected[scenario as string]).toBe(false);
    // …and only that one. A detector that trips several at once is not diagnostic.
    const alsoMissing = REQUIRED_SCENARIOS.filter((n: string) => n !== scenario && !detected[n]);
    expect(alsoMissing).toEqual([]);
  });
});

describe('scenario detection · the judgement calls', () => {
  it('a short payment within tolerance is NOT a partial payout', () => {
    const detected = presence(healthy({
      bookings: [{ id: 'BK-001', expectedPayout: 10_000, actualPayout: 9_950 }],
      payoutTolerance: 100,
    }));
    expect(detected['partial payout']).toBe(false);
  });

  it('an unpaid booking is not a partial payout either — nothing arrived to be short', () => {
    const detected = presence(healthy({
      bookings: [{ id: 'BK-001', expectedPayout: 10_000, actualPayout: 0 }],
    }));
    expect(detected['partial payout']).toBe(false);
  });

  it('a carry-forward in the first month is not a recovery — nothing preceded it', () => {
    expect(presence(healthy({ carryForwardApplied: twelve(50_000, 0, 0, 0) }))['loss recovery'])
      .toBe(false);
  });

  it('takes the median of months that traded, not of all twelve', () => {
    // Two empty months would drag a naive median toward zero and make every active month
    // look like a spike.
    const detected = detect(healthy({ operatingExpenses: twelve(0, 0, 40_000, 44_000) }));
    expect(detected['expense spike']!.present).toBe(false);
  });

  it('one platform is not a filtering scenario; two are', () => {
    expect(presence(healthy({ platformsInReportMonth: [] }))['platform filtering']).toBe(false);
    expect(presence(healthy({ platformsInReportMonth: ['Airbnb'] }))['platform filtering']).toBe(false);
    expect(presence(healthy({ platformsInReportMonth: ['Airbnb', 'Direct'] }))['platform filtering']).toBe(true);
  });

  it('survives an entirely empty workbook without throwing', () => {
    expect(() => detectScenarios({} as never)).not.toThrow();
    const detected = detect({});
    // Absent data must read as "condition not found", never as "found".
    expect(REQUIRED_SCENARIOS.filter((n: string) => detected[n]!.present)).toEqual([]);
  });
});

describe('connection failures · what the operator is told', () => {
  const resolved = { clientEmail: 'parity@example.iam.gserviceaccount.com' };
  const explain = (message: string) =>
    explainConnectionError(new Error(message), resolved as never);

  it('a corrupted key file says so, and how to replace it', () => {
    const { summary, fix } = explain('error:1E08010C:DECODER routines::unsupported');
    expect(summary).toContain('not a usable service-account key');
    expect(fix).toContain('Create new key');
    expect(fix).not.toContain('spreadsheet id');   // the old message blamed the wrong thing
  });

  it('a permission error names the address to share with', () => {
    const { summary, fix } = explain('The caller does not have permission');
    expect(summary).toBe('access denied');
    expect(fix).toContain(resolved.clientEmail);
    expect(fix).toContain('Viewer');
  });

  it('a wrong id explains where the id comes from', () => {
    const { summary, fix } = explain('Requested entity was not found. (404)');
    expect(summary).toContain('no workbook with that id');
    expect(fix).toContain('/d/');
  });

  it('a rejected credential suggests the clock and a deleted key', () => {
    const { fix } = explain('invalid_grant: Invalid JWT Signature.');
    expect(fix).toContain('clock');
    expect(fix).toContain('deleted');
  });

  it('a disabled API points at the Library page', () => {
    const { summary, fix } = explain('Google Sheets API has not been used in project 1234 before or it is disabled');
    expect(summary).toContain('not enabled');
    expect(fix).toContain('Library');
  });

  it('a network failure is not mistaken for a credential problem', () => {
    const { summary } = explain('getaddrinfo ENOTFOUND sheets.googleapis.com');
    expect(summary).toContain('could not reach Google');
  });

  it('an unrecognised error still gives something to check, and repeats the message', () => {
    const { summary, fix } = explain('something nobody has seen before');
    expect(summary).toBe('something nobody has seen before');
    expect(fix).toContain('PARITY_SHEET_ID');
  });

  it('never echoes a credential back into the message', () => {
    const withKey = { clientEmail: 'a@b.iam.gserviceaccount.com', credentials: { private_key: 'SECRET-KEY-MATERIAL' } };
    const { summary, fix } = explainConnectionError(new Error('403 permission'), withKey as never);
    expect(`${summary} ${fix}`).not.toContain('SECRET-KEY-MATERIAL');
  });
});
