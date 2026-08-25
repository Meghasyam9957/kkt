/**
 * ANALYTICS API (ARCHITECTURE §7) — `GET /api/analytics/*`.
 *
 * These endpoints, unlike the forecast, genuinely describe a chosen period, so §7's
 * filter conventions apply and are tested here: `?month=`, `?propertyId=`, `?platform=`.
 *
 * The two properties worth defending:
 *   1. the handler orchestrates — what it returns equals what the provider computed, so
 *      an API caller and an operator reading the dashboard see one set of numbers;
 *   2. a month cannot be steered somewhere the workbook has nothing for, and when the
 *      request is redirected to a month that does carry data, `meta.period` says so
 *      rather than letting the caller assume it got what it asked for.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApiRouter } from '@/lib/server/api/router';
import { registerAnalyticsHandlers, filtersFrom } from '@/lib/server/api/analytics-service';
import { InMemoryAuthProvider, type TestUser } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import type { DashboardDataProvider } from '@/lib/data/providers/types';
import { USERS } from './support/harness';

const FIXED_NOW = () => new Date('2027-01-19T06:00:00.000Z');

interface Setup {
  audit: InMemoryAuditSink;
  provider: DashboardDataProvider;
  request(
    user: TestUser | null, path: string, query?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
}

function setup(): Setup {
  const audit = new InMemoryAuditSink();
  const provider = new FixtureDashboardDataProvider({ now: FIXED_NOW });
  const router = new ApiRouter({
    authProvider: new InMemoryAuthProvider(Object.values(USERS)),
    audit: new AuditLogger(audit),
  });
  registerAnalyticsHandlers(router, () => provider);
  return {
    audit, provider,
    async request(user, path, query = {}) {
      const response = await router.dispatch({
        method: 'GET', path, query, params: {},
        headers: user ? { authorization: `Bearer ${user.token}` } : {},
        ip: '203.0.113.10', requestId: 'req-analytics',
      });
      return { status: response.status, body: response.body as any };
    },
  };
}

const PATHS = [
  '/api/analytics/dashboard',
  '/api/analytics/timeseries',
  '/api/analytics/by-property',
  '/api/analytics/by-platform',
] as const;

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

describe('Analytics API · response', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  for (const path of PATHS) {
    it(`${path} answers in the documented envelope`, async () => {
      const res = await s.request(USERS.admin!, path);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      // §7: every response carries { data, meta: { asOf, source, period } }.
      expect(res.body.meta.source).toBe('FIXTURE');
      expect(res.body.meta.asOf).toBe('2027-01-19T06:00:00.000Z');
      expect(res.body.meta.period).toMatch(/^\d{4}-\d{2}$/);
    });
  }

  it('returns the twelve-month block whole, not a subset chosen in the handler', async () => {
    const res = await s.request(USERS.admin!, '/api/analytics/timeseries');
    const series = await s.provider.getMonthlySeries({ month: '', propertyId: null, platform: null });

    expect(res.body.data).toEqual(series.data);
    // §7 names revenue, expenses, profit, occupancy, ADR and RevPAR; every one is present.
    for (const field of ['netRevenue', 'operatingExpenses', 'operatingProfit',
      'occupancyPct', 'adr', 'revPar'] as const) {
      expect(res.body.data[0]).toHaveProperty(field);
    }
  });

  it('never recalculates — each endpoint equals what the provider computed', async () => {
    const filters = { month: '2026-11', propertyId: null, platform: null };
    const dashboard = await s.request(USERS.admin!, '/api/analytics/dashboard', { month: '2026-11' });
    const byProperty = await s.request(USERS.admin!, '/api/analytics/by-property', { month: '2026-11' });
    const byPlatform = await s.request(USERS.admin!, '/api/analytics/by-platform', { month: '2026-11' });

    expect(dashboard.body.data).toEqual((await s.provider.getDashboard(filters)).data);
    expect(byProperty.body.data).toEqual((await s.provider.getProperties(filters)).data);
    expect(byPlatform.body.data).toEqual((await s.provider.getDashboard(filters)).data.platforms);
  });

  it('is deterministic: the same request answers identically every time', async () => {
    for (const path of PATHS) {
      const first = await s.request(USERS.admin!, path);
      const second = await s.request(USERS.admin!, path);
      expect(JSON.stringify(second.body), path).toBe(JSON.stringify(first.body));
    }
  });
});

/* ------------------------------------------------------------------ *
 * §7 filter conventions
 * ------------------------------------------------------------------ */

describe('Analytics API · filters', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('honours ?month= when that month carries data, and says which it served', async () => {
    const res = await s.request(USERS.admin!, '/api/analytics/dashboard', { month: '2026-11' });
    expect(res.body.meta.period).toBe('2026-11');
  });

  it('will not be steered at a month the workbook has nothing for', async () => {
    const res = await s.request(USERS.admin!, '/api/analytics/dashboard', { month: '1999-01' });
    // Falls back to the latest month that does carry data — and reports THAT month, so
    // the substitution is visible rather than passed off as the month requested.
    expect(res.body.meta.period).not.toBe('1999-01');
    expect(res.body.meta.period).toMatch(/^\d{4}-\d{2}$/);
    const months = await s.provider.getAvailableMonths();
    expect(months).toContain(res.body.meta.period);
  });

  it('ignores a malformed month rather than failing the report', async () => {
    const res = await s.request(USERS.admin!, '/api/analytics/timeseries', { month: 'not-a-month' });
    expect(res.status).toBe(200);
    expect(res.body.meta.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('scopes by ?propertyId= using §7 spelling', async () => {
    const all = await s.request(USERS.admin!, '/api/analytics/by-property');
    const one = await s.request(USERS.admin!, '/api/analytics/by-property', { propertyId: 'HYD-501' });

    expect(all.body.data.length).toBeGreaterThan(1);
    expect(one.body.data.map((p: { propertyId: string }) => p.propertyId)).toEqual(['HYD-501']);
  });

  it('scopes by ?platform=', async () => {
    const one = await s.request(USERS.admin!, '/api/analytics/by-platform', { platform: 'Airbnb' });
    expect(one.body.data.map((p: { platform: string }) => p.platform)).toEqual(['Airbnb']);
  });

  it('resolves filters against the months that actually carry data', async () => {
    const months = await s.provider.getAvailableMonths();
    const base = { method: 'GET', path: '/api/analytics/dashboard' };

    expect(await filtersFrom(s.provider, { ...base, query: { month: months[0]! } }))
      .toEqual({ month: months[0], propertyId: null, platform: null });
    expect((await filtersFrom(s.provider, { ...base, query: { month: '1999-01' } })).month)
      .toBe(months[months.length - 1]);
    // Repeated query keys arrive as an array; only the first is meaningful.
    expect((await filtersFrom(s.provider, { ...base, query: { month: ['1999-01', months[0]!] } })).month)
      .toBe(months[months.length - 1]);
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe('Analytics API · authorization', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  for (const path of PATHS) {
    it(`ADMIN and SUPER_ADMIN may GET ${path}`, async () => {
      expect((await s.request(USERS.admin!, path)).status).toBe(200);
      expect((await s.request(USERS.superAdmin!, path)).status).toBe(200);
    });

    it(`OPERATIONS may NOT GET ${path} — it holds no financial capability`, async () => {
      const res = await s.request(USERS.operations!, path);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it(`INVESTOR may NOT GET ${path}`, async () => {
      expect((await s.request(USERS.investorA!, path)).status).toBe(403);
    });

    it(`an anonymous caller may NOT GET ${path}`, async () => {
      expect((await s.request(null, path)).status).toBe(401);
    });
  }

  it('a refused analytics read discloses none of the figures it refused', async () => {
    const res = await s.request(USERS.operations!, '/api/analytics/dashboard');
    expect(JSON.stringify(res.body)).not.toMatch(/revenue|profit|occupanc|adr/i);
  });

  it('records every read in the audit trail, allowed and refused alike', async () => {
    await s.request(USERS.admin!, '/api/analytics/timeseries');
    await s.request(USERS.operations!, '/api/analytics/timeseries');

    const records = s.audit.byAction('analytics.timeseries.read');
    expect(records.map((r) => r.result)).toEqual(['ALLOW', 'DENY']);
  });
});

/* ------------------------------------------------------------------ *
 * Alerts — §7's ADMIN + OPS endpoint
 *
 * The one analytics read OPERATIONS may reach, because it is the only one that carries no
 * money. That difference is the point of these cases: the same guard that refuses
 * OPERATIONS every other analytics path must admit it here, and the payload must stay
 * free of anything that would make admitting it wrong.
 * ------------------------------------------------------------------ */

describe('Analytics API · alerts', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  const ALERT_FIELDS = ['key', 'severity', 'propertyId', 'title', 'action', 'reference'];

  it('returns the operations board’s urgent list, unmodified', async () => {
    const res = await s.request(USERS.admin!, '/api/analytics/alerts');
    const board = await s.provider.getOperations({ month: '', propertyId: null, platform: null });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(board.data.urgent);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.source).toBe('FIXTURE');
    expect(res.body.meta.asOf).toBe('2027-01-19T06:00:00.000Z');
  });

  it('keeps the most pressing item first, as the board does', async () => {
    const { body } = await s.request(USERS.admin!, '/api/analytics/alerts');
    const order = { critical: 0, high: 1, watch: 2 } as const;
    const ranks: number[] = body.data.map((a: { severity: keyof typeof order }) => order[a.severity]);

    // The invariant is the ordering, not any particular severity: which severities exist
    // depends on the data, and this fixture workbook happens to carry no Critical ticket.
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(ranks[0]).toBe(Math.min(...ranks));
  });

  it('says what happened AND what to do, on every item', async () => {
    const { body } = await s.request(USERS.admin!, '/api/analytics/alerts');
    for (const alert of body.data) {
      expect(Object.keys(alert).sort()).toEqual([...ALERT_FIELDS].sort());
      expect(alert.title.length, alert.key).toBeGreaterThan(0);
      expect(alert.action.length, alert.key).toBeGreaterThan(10);
      expect(alert.propertyId, alert.key).toMatch(/^(HYD-|COMMON)/);
    }
  });

  it('carries no financial figure at all — which is why OPERATIONS may read it', async () => {
    const { body } = await s.request(USERS.admin!, '/api/analytics/alerts');
    for (const alert of body.data) {
      for (const [field, value] of Object.entries(alert)) {
        expect(typeof value, `${alert.key}.${field}`).toBe('string');
      }
    }
    expect(JSON.stringify(body.data)).not.toMatch(/₹|revenue|profit|margin|payout/i);
  });

  it('leaks no guest contact detail', async () => {
    // The same guard the operations board is already held to.
    const { body } = await s.request(USERS.admin!, '/api/analytics/alerts');
    expect(JSON.stringify(body.data)).not.toMatch(/@|\+91|phone|email/i);
  });

  it('is deterministic: the same request answers identically every time', async () => {
    const first = await s.request(USERS.admin!, '/api/analytics/alerts');
    const second = await s.request(USERS.admin!, '/api/analytics/alerts');
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });
});

describe('Analytics API · alerts authorization', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('admits OPERATIONS, unlike every other analytics read', async () => {
    // §7 lists this route as ADMIN + OPS. It is guarded by `operations.view`, which is
    // exactly that set — so the difference from the financial analytics routes is a
    // capability difference, not a special case in the handler.
    expect((await s.request(USERS.operations!, '/api/analytics/alerts')).status).toBe(200);
    expect((await s.request(USERS.operations!, '/api/analytics/dashboard')).status).toBe(403);
  });

  it('admits ADMIN and SUPER_ADMIN', async () => {
    expect((await s.request(USERS.admin!, '/api/analytics/alerts')).status).toBe(200);
    expect((await s.request(USERS.superAdmin!, '/api/analytics/alerts')).status).toBe(200);
  });

  it('refuses INVESTOR', async () => {
    const res = await s.request(USERS.investorA!, '/api/analytics/alerts');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses an anonymous caller', async () => {
    const res = await s.request(null, '/api/analytics/alerts');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a suspended account', async () => {
    expect((await s.request(USERS.suspended!, '/api/analytics/alerts')).status).toBe(403);
  });

  it('records the read in the audit trail, allowed and refused alike', async () => {
    await s.request(USERS.operations!, '/api/analytics/alerts');
    await s.request(USERS.investorA!, '/api/analytics/alerts');

    const records = s.audit.byAction('analytics.alerts.read');
    expect(records.map((r) => r.result)).toEqual(['ALLOW', 'DENY']);
  });
});
