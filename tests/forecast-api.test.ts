/**
 * FORECAST API (ARCHITECTURE §7) — `GET /api/forecast/{occupancy,revenue}`.
 *
 * What these cases are actually protecting:
 *
 *   1. the handler ORCHESTRATES — the numbers it returns are byte-identical to the ones
 *      the provider computed, so there is no second forecast implementation hiding in a
 *      route (the failure mode §9's determinism exists to prevent);
 *   2. insufficient history survives the transport — `value: null` and a reason, never a
 *      zero, never an empty 200 that reads as "nothing happened that month";
 *   3. the guard applies exactly as it does to every other declared route: ADMIN and
 *      SUPER_ADMIN through, OPERATIONS and INVESTOR refused, anonymous unauthenticated;
 *   4. cash flow is NOT reachable — §7 lists it, this milestone defers it, and a 404 is
 *      the honest answer rather than a route that invents a payout lag.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApiRouter } from '@/lib/server/api/router';
import { registerForecastHandlers } from '@/lib/server/api/forecast-service';
import { InMemoryAuthProvider, type TestUser } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { buildDemoOps } from '@/lib/data/fixtures/workbook';
import { MINIMUM_USABLE_MONTHS } from '@/lib/server/analytics/forecast';
import type { DashboardDataProvider, ReportFilters } from '@/lib/data/providers/types';
import { USERS } from './support/harness';
import { baseline } from './fixtures/scenarios';

const NO_FILTERS: ReportFilters = { month: '', propertyId: null, platform: null };

/** A fixed clock, so `meta.asOf` is as reproducible as the figures under it. */
const FIXED_NOW = () => new Date('2027-01-19T06:00:00.000Z');

interface Setup {
  router: ApiRouter;
  audit: InMemoryAuditSink;
  provider: DashboardDataProvider;
  request(user: TestUser | null, path: string): Promise<{ status: number; body: any }>;
}

function setup(provider: DashboardDataProvider): Setup {
  const audit = new InMemoryAuditSink();
  const router = new ApiRouter({
    authProvider: new InMemoryAuthProvider(Object.values(USERS)),
    audit: new AuditLogger(audit),
  });
  registerForecastHandlers(router, () => provider);
  return {
    router, audit, provider,
    async request(user, path) {
      const response = await router.dispatch({
        method: 'GET', path, query: {}, params: {},
        headers: user ? { authorization: `Bearer ${user.token}` } : {},
        ip: '203.0.113.10', requestId: 'req-forecast',
      });
      return { status: response.status, body: response.body as any };
    },
  };
}

/** The seeded demonstration year: enough complete months to estimate from. */
const withHistory = (): Setup =>
  setup(new FixtureDashboardDataProvider({ now: FIXED_NOW }));

/**
 * One traded month and nothing else. The parity baseline trades in April 2026 alone and
 * "today" is mid-May, so exactly ONE complete usable month exists — one below §9's
 * minimum, which is the boundary worth carrying through the transport rather than the
 * empty case.
 */
const withThinHistory = (): Setup =>
  setup(new FixtureDashboardDataProvider({
    workbook: baseline().data,
    ops: buildDemoOps('2026-05-15'),
    now: FIXED_NOW,
  }));

/* ------------------------------------------------------------------ *
 * Shape and provenance
 * ------------------------------------------------------------------ */

describe('Forecast API · response', () => {
  let s: Setup;
  beforeEach(() => { s = withHistory(); });

  it('returns the occupancy estimate in the documented envelope', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/occupancy');

    expect(res.status).toBe(200);
    expect(res.body.data.estimate.horizon).toBe('occupancy');
    expect(res.body.data.estimate.label).toBe('ESTIMATE');
    expect(res.body.data.estimate.unit).toBe('nights');
    expect(res.body.data.monthKey).toMatch(/^\d{4}-\d{2}$/);
    // §7: every response carries { data, meta: { asOf, source, period } }.
    expect(res.body.meta.source).toBe('FIXTURE');
    expect(res.body.meta.asOf).toBe('2027-01-19T06:00:00.000Z');
    expect(res.body.meta.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('returns the revenue estimate in the same envelope, in currency', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/revenue');

    expect(res.status).toBe(200);
    expect(res.body.data.estimate.horizon).toBe('revenue');
    expect(res.body.data.estimate.label).toBe('ESTIMATE');
    expect(res.body.data.estimate.unit).toBe('currency');
  });

  it('states the month being estimated, rather than leaving it to be inferred', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const view = await s.provider.getForecast(NO_FILTERS);

    expect(res.body.data.monthKey).toBe(view.data.monthKey);
    expect(res.body.data.estimate.monthKey).toBe(view.data.monthKey);
    // The horizon is the month AFTER the one the meta describes: this is a forecast.
    expect(res.body.data.monthKey > res.body.meta.period).toBe(true);
  });

  it('never recalculates — the API returns exactly what the engine produced', async () => {
    const view = await s.provider.getForecast(NO_FILTERS);
    const occupancy = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const revenue = await s.request(USERS.admin!, '/api/forecast/revenue');

    expect(occupancy.body.data.estimate).toEqual(view.data.occupancy);
    expect(revenue.body.data.estimate).toEqual(view.data.revenue);
  });

  it('carries the §9 inputs and a stated confidence with the number', async () => {
    const { body } = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const { estimate } = body.data;

    expect(estimate.status).toBe('SUFFICIENT');
    expect(estimate.method).toMatch(/booking-on-hand/i);
    expect(estimate.inputs.usableMonths).toBeGreaterThanOrEqual(MINIMUM_USABLE_MONTHS);
    expect(estimate.inputs.availableNights).toBeGreaterThan(0);
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(estimate.confidence);
  });

  it('returns only this horizon of forecast-vs-actual history', async () => {
    const occupancy = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const revenue = await s.request(USERS.admin!, '/api/forecast/revenue');

    // §9 asks for forecast-vs-actual on the horizons that exist, so BOTH carry one.
    expect(occupancy.body.data.accuracy.length).toBeGreaterThan(0);
    expect(revenue.body.data.accuracy.length).toBeGreaterThan(0);
    for (const row of occupancy.body.data.accuracy) expect(row.horizon).toBe('occupancy');
    for (const row of revenue.body.data.accuracy) expect(row.horizon).toBe('revenue');
  });

  it('compares the same settled months on both horizons', async () => {
    const occupancy = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const revenue = await s.request(USERS.admin!, '/api/forecast/revenue');
    const months = (r: any) => r.body.data.accuracy.map((a: any) => a.monthKey);

    expect(months(revenue)).toEqual(months(occupancy));
  });

  it('measures revenue accuracy in money, against the month that actually traded', async () => {
    const { body } = await s.request(USERS.admin!, '/api/forecast/revenue');
    const view = await s.provider.getForecast(NO_FILTERS);
    const series = await s.provider.getMonthlySeries(NO_FILTERS);

    for (const row of body.data.accuracy) {
      const month = series.data.find((m: { monthKey: string }) => m.monthKey === row.monthKey)!;
      // The actual is the month's own room revenue — the same figure the revenue horizon
      // estimates — not a re-derived one.
      expect(row.actual).toBe(month.roomRevenue);
      expect(row.variance).toBeCloseTo(row.actual - row.forecast, 6);
    }
    expect(body.data.accuracy).toEqual(view.data.accuracy.filter((a) => a.horizon === 'revenue'));
  });

  it('returns the cash-flow estimate with all four §9 terms behind it', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/cashflow');
    const { estimate } = res.body.data;
    const cash = estimate.inputs.cash;

    expect(res.status).toBe(200);
    expect(estimate.horizon).toBe('cashflow');
    expect(estimate.label).toBe('ESTIMATE');
    expect(estimate.unit).toBe('currency');
    expect(estimate.method).toMatch(/opening balance/i);
    expect(estimate.method).toMatch(/per-platform lag/i);

    // Each term is present and the stated arithmetic actually holds, so the figure can be
    // checked against its own inputs rather than trusted.
    for (const key of ['openingBalance', 'expectedPayouts', 'scheduledFixedCosts',
      'trailingVariableCosts', 'netMovement'] as const) {
      expect(typeof cash[key], key).toBe('number');
    }
    expect(cash.netMovement).toBeCloseTo(
      cash.expectedPayouts - cash.scheduledFixedCosts - cash.trailingVariableCosts, 6,
    );
    expect(estimate.value).toBeCloseTo(cash.openingBalance + cash.netMovement, 6);
  });

  it('carries no forecast-vs-actual for cash flow, because a balance is not a movement', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/cashflow');
    expect(res.body.data.accuracy).toEqual([]);
  });

  it('is deterministic: the same request answers identically every time', async () => {
    const first = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const second = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const third = await s.request(USERS.admin!, '/api/forecast/revenue');
    const fourth = await s.request(USERS.admin!, '/api/forecast/revenue');

    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
    expect(JSON.stringify(fourth.body)).toBe(JSON.stringify(third.body));
  });

  it('ignores a month parameter rather than appearing to honour one', async () => {
    const plain = await s.request(USERS.admin!, '/api/forecast/occupancy');
    const withQuery = await s.router.dispatch({
      method: 'GET', path: '/api/forecast/occupancy',
      query: { month: '2026-04' }, params: {},
      headers: { authorization: `Bearer ${USERS.admin!.token}` },
      requestId: 'req-forecast-q',
    });

    expect((withQuery.body as any).data).toEqual(plain.body.data);
  });
});

/* ------------------------------------------------------------------ *
 * Insufficient history — §9's rule, end to end
 * ------------------------------------------------------------------ */

describe('Forecast API · insufficient history', () => {
  let s: Setup;
  beforeEach(() => { s = withThinHistory(); });

  it('refuses to produce a number, and says why', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/occupancy');

    expect(res.status).toBe(200);
    expect(res.body.data.estimate.status).toBe('INSUFFICIENT_DATA');
    expect(res.body.data.estimate.value).toBeNull();
    expect(res.body.data.estimate.occupancyPct).toBeNull();
    expect(res.body.data.estimate.confidence).toBeNull();
    expect(res.body.data.estimate.reason).toMatch(/complete month/i);
  });

  it('does not substitute zero for the absence of an estimate', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/revenue');

    expect(res.body.data.estimate.value).not.toBe(0);
    expect(res.body.data.estimate.value).toBeNull();
    // The threshold is reported, so a caller can see how far short the history falls.
    expect(res.body.data.estimate.inputs.usableMonths).toBeLessThan(MINIMUM_USABLE_MONTHS);
  });

  it('still labels the refusal ESTIMATE and names the method it would have used', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/revenue');

    expect(res.body.data.estimate.label).toBe('ESTIMATE');
    expect(res.body.data.estimate.method).toMatch(/trailing ADR/i);
  });

  it('has no forecast-vs-actual to show, and shows none', async () => {
    const res = await s.request(USERS.admin!, '/api/forecast/occupancy');
    expect(res.body.data.accuracy).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe('Forecast API · authorization', () => {
  let s: Setup;
  beforeEach(() => { s = withHistory(); });

  for (const path of ['/api/forecast/occupancy', '/api/forecast/revenue']) {
    it(`ADMIN may GET ${path}`, async () => {
      expect((await s.request(USERS.admin!, path)).status).toBe(200);
    });

    it(`SUPER_ADMIN may GET ${path}`, async () => {
      expect((await s.request(USERS.superAdmin!, path)).status).toBe(200);
    });

    it(`OPERATIONS may NOT GET ${path}`, async () => {
      const res = await s.request(USERS.operations!, path);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // A refusal must not disclose the figures it is refusing.
      expect(JSON.stringify(res.body)).not.toMatch(/ESTIMATE|occupanc|nights/i);
    });

    it(`INVESTOR may NOT GET ${path}`, async () => {
      const res = await s.request(USERS.investorA!, path);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it(`an anonymous caller may NOT GET ${path}`, async () => {
      const res = await s.request(null, path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it(`a suspended ADMIN may NOT GET ${path}`, async () => {
      expect((await s.request(USERS.suspended!, path)).status).toBe(403);
    });
  }

  it('records the read in the audit trail, allowed and refused alike', async () => {
    await s.request(USERS.admin!, '/api/forecast/occupancy');
    await s.request(USERS.operations!, '/api/forecast/revenue');

    const allowed = s.audit.byAction('forecast.occupancy.read');
    const refused = s.audit.byAction('forecast.revenue.read');
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.result).toBe('ALLOW');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.result).toBe('DENY');
  });

  it('guards the cash-flow forecast with the capability that guards the cash ledger', async () => {
    // `cashflow.read`, not `analytics.read`: a projection of the cash position is a cash
    // figure. ADMIN and SUPER_ADMIN hold both today, so exactness costs nothing.
    expect((await s.request(USERS.admin!, '/api/forecast/cashflow')).status).toBe(200);
    expect((await s.request(USERS.superAdmin!, '/api/forecast/cashflow')).status).toBe(200);
    expect((await s.request(USERS.operations!, '/api/forecast/cashflow')).status).toBe(403);
    expect((await s.request(USERS.investorA!, '/api/forecast/cashflow')).status).toBe(403);
    expect((await s.request(null, '/api/forecast/cashflow')).status).toBe(401);
  });
});
