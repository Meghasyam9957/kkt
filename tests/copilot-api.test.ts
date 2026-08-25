/**
 * COPILOT API (ARCHITECTURE §7) — `POST /api/ai/copilot`.
 *
 * The service-level suite proves the rules; this proves the wire. What a caller gets
 * through the real router, with the real guard in front of it, for each of the ways a
 * turn can end — and that the handler adds nothing of its own on the way past.
 *
 * The route is the repository's first non-GET route that writes nothing. Its governance
 * lives with the registry and is asserted by the security and RBAC suites; what is
 * asserted here is the behaviour that flag is supposed to describe — no mutation
 * machinery is touched, and nothing but a question goes in.
 *
 * AI is off throughout. Where a test needs to see past the integration gate it says so
 * explicitly, and the production wiring is asserted separately to be shut.
 */
import { describe, it, expect } from 'vitest';
import { ApiRouter } from '@/lib/server/api/router';
import { registerCopilotHandlers } from '@/lib/server/api/copilot-service';
import { InMemoryAuthProvider, type TestUser } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { DemoGridProvider } from '@/lib/data/providers/demo-grid-provider';
import { MockAiProvider, MOCK_REPLY } from '@/lib/server/ai/mock-provider';
import { InMemoryAiUsageSink, type AiTokenPricing } from '@/lib/server/ai/provider';
import { ALL_FEATURES_OFF } from '@/lib/server/ai/guardrails';
import { aiEnabled } from '@/lib/server/ai/guard';
import type { CopilotRuntime } from '@/lib/server/ai/copilot';
import type { DashboardDataProvider } from '@/lib/data/providers/types';
import { resolveEnvironment } from '@/lib/server/environment/config';
import { USERS } from './support/harness';
import type { EnvLike } from '@/lib/shared/env';

const FIXED_NOW = new Date('2027-01-19T06:00:00.000Z');

const serviceAccount = (who: string) =>
  Buffer.from(JSON.stringify({ client_email: `${who}@example.invalid` }), 'utf8').toString('base64');

const demoEnv = () => resolveEnvironment({
  APP_ENV: 'demo',
  DEMO_GOOGLE_SHEET_ID: 'demo-workbook-id-9876',
  DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: serviceAccount('demo'),
  DEMO_SUPABASE_URL: 'demo.supabase.invalid',
  DEMO_SUPABASE_SERVICE_ROLE_KEY: 'demo-service-role',
} as EnvLike);

/** A local backend costs nothing — zero rates are a fact, not an assumed price. */
const FREE: AiTokenPricing = {
  model: 'mock-model', currency: 'USD', promptCostPerToken: 0, completionCostPerToken: 0,
};

const steppedClock = () => { let t = 1_000; return () => { const n = t; t += 3; return n; }; };


/**
 * A data provider that records which reads were made through it.
 *
 * The methods still run for real. A source scan of the handler proves what one file
 * imports; this measures what the whole request actually touches, through `filtersFrom`
 * and through the copilot service beneath it — which is the claim the route's
 * `nonMutating` flag is making.
 */
function recording(inner: DashboardDataProvider): { data: DashboardDataProvider; calls: string[] } {
  const calls: string[] = [];
  const data = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => { calls.push(String(prop)); return fn.apply(target, args); };
    },
  }) as DashboardDataProvider;
  return { data, calls };
}

interface Setup {
  audit: InMemoryAuditSink;
  runtime: CopilotRuntime;
  sink(): InMemoryAiUsageSink;
  provider(): MockAiProvider;
  post(user: TestUser | null, body?: unknown): Promise<{ status: number; body: any }>;
}

function setup(
  overrides: Partial<CopilotRuntime> = {},
  data: DashboardDataProvider = new FixtureDashboardDataProvider({ now: () => FIXED_NOW }),
): Setup {
  const audit = new InMemoryAuditSink();
  const runtime: CopilotRuntime = {
    provider: new MockAiProvider(),
    feature: {
      // Stated explicitly: aiEnabled() is false in this phase and would otherwise shadow
      // every rule beneath it. Nothing here turns AI on.
      integrationEnabled: true,
      switches: { ...ALL_FEATURES_OFF, copilot: true },
      budget: { cap: 25, spent: 0 },
    },
    pricing: FREE,
    sink: new InMemoryAiUsageSink(),
    model: 'mock-model',
    resolved: demoEnv(),
    now: FIXED_NOW,
    clock: steppedClock(),
    ...overrides,
  };
  const router = new ApiRouter({
    authProvider: new InMemoryAuthProvider(Object.values(USERS)),
    audit: new AuditLogger(audit),
  });
  // The same instance every request, so a test can read what accumulated across them.
  registerCopilotHandlers(router, () => data, () => runtime);

  return {
    audit,
    runtime,
    sink: () => runtime.sink as InMemoryAiUsageSink,
    provider: () => runtime.provider as MockAiProvider,
    async post(user, body = { question: 'What needs attention today?' }) {
      const response = await router.dispatch({
        method: 'POST', path: '/api/ai/copilot', query: {}, params: {},
        headers: user ? { authorization: `Bearer ${user.token}` } : {},
        body, ip: '203.0.113.10', requestId: 'req-copilot',
      });
      return { status: response.status, body: response.body as any };
    },
  };
}

/* ================================================================== *
 * Authorization
 * ================================================================== */

describe('copilot API · authorization (§7)', () => {
  it('ADMIN may ask, and gets an answer with its provenance', async () => {
    const s = setup();
    const res = await s.post(USERS.admin!);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('OK');
    expect(res.body.answer).toBe(MOCK_REPLY);
    // §8.1's A1 — answer plus source period plus provenance.
    expect(res.body.period).toMatch(/^\d{4}-\d{2}$/);
    expect(res.body.source).toBe('FIXTURE');
    expect(res.body.tools.length).toBe(7);
  });

  it('SUPER_ADMIN may ask', async () => {
    expect((await setup().post(USERS.superAdmin!)).status).toBe(200);
  });

  it('OPERATIONS may ask, and receives only the ops-scoped context', async () => {
    const s = setup();
    const res = await s.post(USERS.operations!);

    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual(['getAlerts']);
    expect(res.body.omitted.length).toBe(6);

    // What the provider actually received, not what came back.
    const sent = s.provider().calls[0]!.payload.contents as Record<string, unknown>;
    for (const financial of ['kpis', 'propertyPerformance', 'expenseBreakdown', 'platformMix', 'forecast']) {
      expect(sent[financial], financial).toBeNull();
    }
    expect(sent.alerts).not.toBeNull();
  });

  it('INVESTOR is refused, and reaches neither the provider nor the log', async () => {
    const s = setup();
    const res = await s.post(USERS.investorA!);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(s.provider().calls).toEqual([]);
    expect(s.sink().records).toEqual([]);
  });

  it('an unauthenticated request is refused before anything is read', async () => {
    const s = setup();
    const res = await s.post(null);

    expect(res.status).toBe(401);
    expect(s.provider().calls).toEqual([]);
    expect(s.sink().records).toEqual([]);
  });

  it('a suspended account is refused', async () => {
    // 401 or 403 — the security suite accepts either on every route, and which one it is
    // is the guard's business rather than this route's.
    expect([401, 403]).toContain((await setup().post(USERS.suspended!)).status);
  });

  it('the ask is audited under its own action', async () => {
    const s = setup();
    await s.post(USERS.admin!);
    expect(s.audit.byAction('ai.copilot.ask').length).toBe(1);
  });
});

/* ================================================================== *
 * Validation
 * ================================================================== */

describe('copilot API · validation', () => {
  const invalid: Array<[string, unknown]> = [
    ['an empty body', {}],
    ['no question', { notAQuestion: 'hello' }],
    ['an empty question', { question: '' }],
    ['a whitespace-only question', { question: '   ' }],
    ['a question that is not a string', { question: 42 }],
    ['a null question', { question: null }],
    ['an array instead of an object', []],
    ['a string instead of an object', 'what needs attention?'],
  ];

  for (const [label, body] of invalid) {
    it(`refuses ${label} with the shape the write pipeline uses`, async () => {
      const s = setup();
      const res = await s.post(USERS.admin!, body);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toBe('The request does not match the expected shape.');
      // Nothing reached the model, and nothing was logged as a call.
      expect(s.provider().calls).toEqual([]);
      expect(s.sink().records).toEqual([]);
    });
  }

  it('refuses an unexpected field rather than ignoring it', async () => {
    // A caller sending `month` believes this endpoint accepts one. Answering anyway
    // would confirm a contract that does not exist.
    const res = await setup().post(USERS.admin!, { question: 'How are we doing?', month: '2027-01' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/month/);
  });

  it('trims the question and sends it as asked', async () => {
    const s = setup();
    await s.post(USERS.admin!, { question: '  Which unit performed best?  ' });
    expect(s.provider().calls[0]!.question).toBe('Which unit performed best?');
  });
});

/* ================================================================== *
 * Every ending, exactly one usage row
 * ================================================================== */

describe('copilot API · every attempt produces exactly one usage record (§8.4)', () => {
  const attempts: Array<[string, Partial<CopilotRuntime>, string, string | null]> = [
    ['AI is disabled', {
      feature: {
        integrationEnabled: false,
        switches: { ...ALL_FEATURES_OFF, copilot: true },
        budget: { cap: 25, spent: 0 },
      },
    }, 'REFUSED', 'INTEGRATION_DISABLED'],
    ['the budget is unconfigured', {
      feature: {
        integrationEnabled: true,
        switches: { ...ALL_FEATURES_OFF, copilot: true },
        budget: { cap: null, spent: 0 },
      },
    }, 'REFUSED', 'BUDGET_UNCONFIGURED'],
    ['the budget is exceeded', {
      feature: {
        integrationEnabled: true,
        switches: { ...ALL_FEATURES_OFF, copilot: true },
        budget: { cap: 25, spent: 25 },
      },
    }, 'REFUSED', 'BUDGET_EXCEEDED'],
    ['the copilot is switched off', {
      feature: { integrationEnabled: true, switches: ALL_FEATURES_OFF, budget: { cap: 25, spent: 0 } },
    }, 'REFUSED', 'FEATURE_SWITCHED_OFF'],
    ['no provider is configured', { provider: null }, 'REFUSED', 'NO_PROVIDER'],
    ['no pricing is configured', { pricing: null }, 'REFUSED', 'NO_PRICING'],
    ['the provider is unavailable', { provider: new MockAiProvider({ fail: 'UNAVAILABLE' }) }, 'UNAVAILABLE', null],
    ['the provider times out', { provider: new MockAiProvider({ fail: 'TIMEOUT' }) }, 'TIMEOUT', null],
    ['the provider answers invalidly', { provider: new MockAiProvider({ fail: 'INVALID_RESPONSE' }) }, 'INVALID_RESPONSE', null],
    ['the mock answers', {}, 'OK', null],
  ];

  for (const [label, overrides, outcome, reason] of attempts) {
    it(`returns 200 with outcome ${outcome} when ${label}`, async () => {
      const s = setup(overrides);
      const res = await s.post(USERS.admin!);

      // A refusal is an answer, not an HTTP error: the caller was authorised, and §8.4
      // wants a clear message rather than a status code standing in for one.
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe(outcome);
      expect(res.body.reason).toBe(reason);
      if (outcome !== 'OK') expect(res.body.message).toBeTruthy();

      expect(s.sink().records.length).toBe(1);
      expect(s.sink().records[0]).toMatchObject({
        feature: 'copilot', userId: USERS.admin!.userId, outcome,
      });
    });
  }

  it('a refusal never reaches the provider and costs nothing', async () => {
    for (const [label, overrides, outcome] of attempts) {
      if (outcome !== 'REFUSED') continue;
      const s = setup(overrides);
      await s.post(USERS.admin!);
      if (s.runtime.provider) expect(s.provider().calls, label).toEqual([]);
      expect(s.sink().records[0], label).toMatchObject({
        promptTokens: 0, completionTokens: 0, cost: 0,
      });
    }
  });

  it('two questions produce two records, never one and never three', async () => {
    const s = setup();
    await s.post(USERS.admin!);
    await s.post(USERS.admin!, { question: 'And which unit is weakest?' });
    expect(s.sink().records.length).toBe(2);
  });
});

/* ================================================================== *
 * §8.2 rule 1 over the wire
 * ================================================================== */

describe('copilot API · fabricated figures are caught (§8.2 rule 1)', () => {
  it('a figure the facts never contained is flagged and named', async () => {
    const s = setup({ provider: new MockAiProvider({ reply: () => 'Net revenue was 6,543,210.' }) });
    const res = await s.post(USERS.admin!);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('FLAGGED');
    expect(res.body.ungrounded).toEqual(['6543210']);
    // Flagged, not suppressed: §8.2 says to flag, and what to do about a flag is not
    // specified anywhere, so the wire does not decide it either.
    expect(res.body.answer).toBe('Net revenue was 6,543,210.');
    expect(s.sink().records[0]!.outcome).toBe('FLAGGED');
  });

  it('the default mock answer states no figure at all', async () => {
    const res = await setup().post(USERS.admin!);
    expect(res.body.ungrounded).toEqual([]);
    expect(MOCK_REPLY).not.toMatch(/\d/);
  });
});

/* ================================================================== *
 * Data minimisation over the wire
 * ================================================================== */

describe('copilot API · guest data cannot cross the wire (§8.3)', () => {
  it('no guest the board names appears in the request or the response', async () => {
    const data = new DemoGridProvider();
    const s = setup({}, data);
    const months = await data.getAvailableMonths();
    const board = await data.getOperations({
      month: months[months.length - 1] ?? '', propertyId: null, platform: null,
    });
    const names = [...board.data.arrivals, ...board.data.departures].map((r) => r.guestDisplayName);
    expect(names.length).toBeGreaterThan(0);

    const res = await s.post(USERS.admin!);
    const sent = JSON.stringify(s.provider().calls[0]);
    for (const name of names) {
      expect(sent, name).not.toContain(name);
      expect(JSON.stringify(res.body), name).not.toContain(name);
    }
  });

  it('no contact detail appears anywhere in the exchange', async () => {
    const s = setup({}, new DemoGridProvider());
    const res = await s.post(USERS.admin!);
    expect(JSON.stringify(s.provider().calls[0]!.payload.contents)).not.toMatch(/@|\+91|phone|email/i);
    expect(JSON.stringify(res.body)).not.toMatch(/@|\+91|phone|email/i);
  });
});

/* ================================================================== *
 * The route writes nothing, and reaches nothing
 * ================================================================== */

describe('copilot API · a POST that writes nothing', () => {
  it('a whole request touches only the whitelisted reads', async () => {
    // Transitive, not a text scan: this covers filtersFrom and everything the copilot
    // service reaches beneath it. A ledger read or a refresh appearing here would mean
    // the route reaches further than its declaration claims.
    const { data, calls } = recording(new FixtureDashboardDataProvider({ now: () => FIXED_NOW }));
    const s = setup({}, data);
    expect((await s.post(USERS.admin!)).status).toBe(200);

    expect([...new Set(calls)].sort()).toEqual([
      'getAvailableMonths', 'getDashboard', 'getForecast', 'getOperations', 'getPnl', 'getProperties',
    ]);
    for (const forbidden of [
      'getReservations', 'getRevenue', 'getExpenses', 'getCapex', 'getCashFlow',
      'getInvestorRegister', 'getInvestorPreview', 'refresh',
    ]) {
      expect(calls, forbidden).not.toContain(forbidden);
    }
  });

  it('an OPERATIONS request reads less, not the same and then filters', async () => {
    // Minimisation is a read boundary, not a projection: a role that may not see the
    // financial tools must not cause them to be fetched either.
    const { data, calls } = recording(new FixtureDashboardDataProvider({ now: () => FIXED_NOW }));
    await setup({}, data).post(USERS.operations!);
    expect([...new Set(calls)].sort()).toEqual(['getAvailableMonths', 'getOperations']);
  });

  it('the route is actually wired in the production router, not merely declared', async () => {
    // A declared-but-unbound route returns 501 and skips every gate below the guard.
    // 24 routes are legitimately unimplemented; this one must not be among them.
    const { getApiRouter, __resetApiService } = await import('@/lib/server/api/service');
    __resetApiService();
    const unimplemented = getApiRouter().unimplemented().map((r) => `${r.method} ${r.path}`);
    __resetApiService();
    expect(unimplemented).not.toContain('POST /api/ai/copilot');
  });

  it('makes no network call for a whole request', async () => {
    const escaped: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      escaped.push(String(input));
      throw new Error('A network call escaped the copilot route.');
    }) as typeof globalThis.fetch;
    try {
      const res = await setup({}, new DemoGridProvider()).post(USERS.admin!);
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
    expect(escaped).toEqual([]);
  });

  it('the production wiring is shut, and says which gate shut it', async () => {
    // The composition root configures no provider, no pricing, no cap and no switches.
    // Each absence is a named refusal rather than a default, and aiEnabled() wins first.
    expect(aiEnabled()).toBe(false);
    const { getApiRouter, __resetApiService } = await import('@/lib/server/api/service');
    __resetApiService();
    const response = await getApiRouter().dispatch({
      method: 'POST', path: '/api/ai/copilot', query: {}, params: {},
      headers: { authorization: 'Bearer t-admin' },
      body: { question: 'What needs attention today?' },
      ip: '203.0.113.10', requestId: 'req-prod',
    });
    __resetApiService();
    // Either the demo identity resolves and the copilot refuses, or the environment has
    // no auth provider configured for this token — both are a shut door, never an answer.
    const body = response.body as { outcome?: string; reason?: string };
    if (response.status === 200) {
      expect(body.outcome).toBe('REFUSED');
      expect(body.reason).toBe('INTEGRATION_DISABLED');
    } else {
      expect([401, 403]).toContain(response.status);
    }
  });
});
