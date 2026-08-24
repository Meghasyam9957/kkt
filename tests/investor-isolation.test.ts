/**
 * INVESTOR ISOLATION — adversarial suite.
 *
 * Investor A (INV-001) attempts to reach Investor B's (INV-002) data through every
 * injection vector. Every negative case must fail closed.
 *
 * Note the strictness: a supplied investor id is refused **even when it matches the
 * caller's own**. If "sometimes you may pass an id" were ever true, the safe path would
 * depend on a comparison, and comparisons are where these bugs live.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, USERS, type Harness } from './support/harness';
import { findInvestorIdentityInjection } from '@/lib/server/auth/guard';
import { INVESTOR_ROUTES } from '@/lib/server/api/routes';
import { InvestorService, INVESTOR_FORBIDDEN_FIELDS } from '@/lib/server/api/investor-service';
import { distributionsMixed } from './fixtures/scenarios';

interface AttackRow { vector: string; route: string; status: number; blocked: boolean; }
const attacks: AttackRow[] = [];

let h: Harness;
beforeEach(() => { h = createHarness(); });

const A = () => USERS.investorA!;   // INV-001
const B = () => USERS.investorB!;   // INV-002

function recordAttack(vector: string, route: string, status: number) {
  const blocked = status === 403;
  attacks.push({ vector, route, status, blocked });
  return blocked;
}

describe('investor isolation · injection vectors', () => {
  it('query parameter: ?investorId=INV-002', async () => {
    for (const route of INVESTOR_ROUTES) {
      const res = await h.request(A(), 'GET', route.path, { query: { investorId: 'INV-002' } });
      expect(recordAttack('query.investorId', route.path, res.status), route.path).toBe(true);
    }
  });

  it('query parameter, snake_case: ?investor_id=INV-002', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/distributions', { query: { investor_id: 'INV-002' } });
    expect(recordAttack('query.investor_id', '/api/investor/distributions', res.status)).toBe(true);
  });

  it('request body: { investorId }', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/overview', { body: { investorId: 'INV-002' } });
    expect(recordAttack('body.investorId', '/api/investor/overview', res.status)).toBe(true);
  });

  it('nested request body: { filter: { investor: { investor_id } } }', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/overview', {
      body: { filter: { investor: { investor_id: 'INV-002' } } },
    });
    expect(recordAttack('body.nested.investor_id', '/api/investor/overview', res.status)).toBe(true);
  });

  it('body inside an array element', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/reports', {
      body: { filters: [{ ok: 1 }, { investorId: 'INV-002' }] },
    });
    expect(recordAttack('body.array.investorId', '/api/investor/reports', res.status)).toBe(true);
  });

  it('HTTP header: X-Investor-Id', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/distributions', {
      headers: { 'x-investor-id': 'INV-002' },
    });
    expect(recordAttack('header.x-investor-id', '/api/investor/distributions', res.status)).toBe(true);
  });

  it('URL path: /api/investor/INV-002/reports', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/INV-002/reports');
    // Undeclared path ⇒ 404; either way no data is returned.
    expect([403, 404]).toContain(res.status);
    attacks.push({ vector: 'path.investorId', route: '/api/investor/INV-002/reports', status: res.status, blocked: true });
    expect(res.body?.error).toBeDefined();
  });

  it('path parameter on a management route: /api/investors/INV-002', async () => {
    const res = await h.request(A(), 'GET', '/api/investors/INV-002');
    expect(recordAttack('path.managementRoute', '/api/investors/INV-002', res.status)).toBe(true);
  });

  it('calling the all-investors endpoint directly', async () => {
    const res = await h.request(A(), 'GET', '/api/investors');
    expect(recordAttack('route.investors.readAll', '/api/investors', res.status)).toBe(true);
  });

  it('case and separator variants are all caught', async () => {
    for (const key of ['InvestorID', 'INVESTOR_ID', 'investor-id', 'Investor Id', 'investorid']) {
      const res = await h.request(A(), 'GET', '/api/investor/overview', { query: { [key]: 'INV-002' } });
      expect(recordAttack(`query.${key}`, '/api/investor/overview', res.status), key).toBe(true);
    }
  });

  it('refuses a supplied id even when it matches the caller’s own', async () => {
    // Strictness by design: "sometimes an id is acceptable" is how these bugs start.
    const res = await h.request(A(), 'GET', '/api/investor/overview', { query: { investorId: 'INV-001' } });
    expect(recordAttack('query.ownId', '/api/investor/overview', res.status)).toBe(true);
  });
});

describe('investor isolation · positive path', () => {
  it('investor A receives only its own overview', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/overview');
    expect(res.status).toBe(200);
    expect(res.body.investorId).toBe('INV-001');
    expect(res.body.investorName).toBe('Investor One');
    expect(JSON.stringify(res.body)).not.toContain('INV-002');
    expect(JSON.stringify(res.body)).not.toContain('Investor Two');
  });

  it('investor B receives different figures from investor A', async () => {
    const a = await h.request(A(), 'GET', '/api/investor/distributions');
    const b = await h.request(B(), 'GET', '/api/investor/distributions');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // 40% vs 35% participation ⇒ different distributions, proving the scope is real.
    expect(a.body[0].participationPct).toBe(0.4);
    expect(b.body[0].participationPct).toBe(0.35);
    expect(a.body[0].calculatedDistribution).not.toBe(b.body[0].calculatedDistribution);
  });

  it('each investor sees exactly one row per period, never the whole table', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/distributions');
    expect(res.body).toHaveLength(1);
  });

  it('an investor response contains no other investor identifier anywhere', async () => {
    for (const route of INVESTOR_ROUTES) {
      const res = await h.request(A(), 'GET', route.path);
      if (res.status !== 200) continue;
      const payload = JSON.stringify(res.body);
      expect(payload, route.path).not.toContain('INV-002');
      expect(payload, route.path).not.toContain('INV-003');
    }
  });
});

describe('investor isolation · data layer (independent of the guard)', () => {
  const data = distributionsMixed().data;

  it('the service filters by investor id even if the guard were bypassed', () => {
    const service = new InvestorService(data);
    const rows = service.distributions('INV-001', ['2026-04']);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('INV-002');
  });

  it('the service refuses an empty scope rather than returning everything', () => {
    const service = new InvestorService(data);
    expect(() => service.distributions('', ['2026-04'])).toThrow(/requires a server-resolved investor id/i);
    expect(() => service.overview('', '2026-04')).toThrow();
  });

  it('an unknown investor id yields an error, not another investor’s data', () => {
    const service = new InvestorService(data);
    expect(() => service.overview('INV-999', '2026-04')).toThrow(/not found/i);
  });
});

describe('investor isolation · disclosure scope', () => {
  it('no investor payload contains guest PII or operational/cost detail', async () => {
    for (const route of INVESTOR_ROUTES) {
      const res = await h.request(A(), 'GET', route.path);
      if (res.status !== 200) continue;
      const payload = JSON.stringify(res.body);
      for (const field of INVESTOR_FORBIDDEN_FIELDS) {
        expect(payload, `${route.path} leaked ${field}`).not.toContain(`"${field}"`);
      }
      expect(payload.toLowerCase(), route.path).not.toContain('guest');
      expect(payload.toLowerCase(), route.path).not.toContain('vendor');
    }
  });

  it('portfolio figures are approved aggregates, not cost detail', async () => {
    const res = await h.request(A(), 'GET', '/api/investor/overview');
    const portfolio = res.body.portfolio;
    expect(portfolio).toHaveProperty('netRevenue');
    expect(portfolio).toHaveProperty('operatingProfit');
    expect(portfolio).toHaveProperty('distributableProfit');
    expect(portfolio).not.toHaveProperty('operatingExpenses');
    expect(portfolio).not.toHaveProperty('expenseBreakdown');
  });
});

describe('investor isolation · injection detector unit tests', () => {
  const base = { method: 'GET', path: '/api/investor/overview' };

  it('detects every documented vector', () => {
    expect(findInvestorIdentityInjection({ ...base, query: { investorId: 'X' } })).toContain('query');
    expect(findInvestorIdentityInjection({ ...base, params: { investor_id: 'X' } })).toContain('params');
    expect(findInvestorIdentityInjection({ ...base, headers: { 'x-investor-id': 'X' } })).toContain('headers');
    expect(findInvestorIdentityInjection({ ...base, body: { investorId: 'X' } })).toContain('body');
    expect(findInvestorIdentityInjection({ ...base, path: '/api/investor/INV-002/x' })).toContain('path');
  });

  it('does not false-positive on legitimate fields', () => {
    expect(findInvestorIdentityInjection({ ...base, query: { month: '2026-04' } })).toBeNull();
    expect(findInvestorIdentityInjection({ ...base, body: { propertyId: 'HYD-501' } })).toBeNull();
    expect(findInvestorIdentityInjection({ ...base, query: { investors: 'all' } })).toBeNull();
  });
});

describe('investor isolation · report', () => {
  it('writes the attack matrix', () => {
    const dir = path.resolve(process.cwd(), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const unblocked = attacks.filter((a) => !a.blocked);
    fs.writeFileSync(path.join(dir, 'investor-isolation.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      attempts: attacks.length,
      blocked: attacks.filter((a) => a.blocked).length,
      unblocked: unblocked.length,
      vectors: [...new Set(attacks.map((a) => a.vector))],
      rows: attacks,
    }, null, 2));
    expect(unblocked, `UNBLOCKED ATTACKS: ${JSON.stringify(unblocked)}`).toEqual([]);
    // Coverage floor: enough attempts, across enough distinct vectors, that a regression
    // in any single defence would surface here.
    expect(attacks.length).toBeGreaterThanOrEqual(15);
    expect(new Set(attacks.map((a) => a.vector)).size).toBeGreaterThanOrEqual(10);
  });
});
