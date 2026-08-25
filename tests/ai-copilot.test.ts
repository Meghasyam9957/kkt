/**
 * THE COPILOT PATH, END TO END — with a mock where the model will be.
 *
 * The other AI suites test pieces: the context boundary, the guardrails, the provider
 * seam. This one asks the question a reviewer actually cares about — if someone calls the
 * copilot, does every rule run, in the right order, and does exactly one usage record come
 * out whichever rule decided the answer?
 *
 * Nothing here mocks a boundary. The provider is a local double because there is no model;
 * the capability model, the whitelist, the guest-name stripping, the environment stamp,
 * the budget gate and the post-response check are all the real ones.
 *
 * Ordering is asserted rather than assumed, because ordering is where these bugs live. If
 * the environment check moved after the budget gate, or the anti-fabrication check after
 * the usage record, the assertions below stop passing — each was confirmed by making that
 * exact change and watching it fail.
 */
import { describe, it, expect } from 'vitest';
import { answerCopilotQuestion, COPILOT_SYSTEM_PROMPT, type CopilotRuntime } from '@/lib/server/ai/copilot';
import { buildCopilotContext, CopilotNotPermittedError } from '@/lib/server/ai/copilot-context';
import { dispatchCompletion, resolveAiProvider } from '@/lib/server/ai/dispatch';
import { MockAiProvider, MOCK_REPLY } from '@/lib/server/ai/mock-provider';
import { InMemoryAiUsageSink, type AiTokenPricing } from '@/lib/server/ai/provider';
import { aiEnabled, AiEnvironmentMismatchError } from '@/lib/server/ai/guard';
import { ALL_FEATURES_OFF } from '@/lib/server/ai/guardrails';
import { DemoGridProvider } from '@/lib/data/providers/demo-grid-provider';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { resolveEnvironment } from '@/lib/server/environment/config';
import type { DashboardDataProvider, ReportFilters } from '@/lib/data/providers/types';
import type { Role } from '@/lib/server/auth/roles';
import type { EnvLike } from '@/lib/shared/env';

const FIXED_NOW = new Date('2027-01-19T06:00:00.000Z');

const serviceAccount = (who: string) =>
  Buffer.from(JSON.stringify({ client_email: `${who}@example.invalid` }), 'utf8').toString('base64');

function bothConfigured(appEnv: 'demo' | 'production'): EnvLike {
  return {
    APP_ENV: appEnv,
    DEMO_GOOGLE_SHEET_ID: 'demo-workbook-id-9876',
    DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: serviceAccount('demo'),
    DEMO_SUPABASE_URL: 'demo.supabase.invalid',
    DEMO_SUPABASE_SERVICE_ROLE_KEY: 'demo-service-role',
    PRODUCTION_GOOGLE_SHEET_ID: 'production-workbook-id-1234',
    PRODUCTION_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: serviceAccount('production'),
    PRODUCTION_SUPABASE_URL: 'production.supabase.invalid',
    PRODUCTION_SUPABASE_SERVICE_ROLE_KEY: 'production-service-role',
  };
}
const demoEnv = () => resolveEnvironment(bothConfigured('demo'));
const productionEnv = () => resolveEnvironment(bothConfigured('production'));

/** A local backend costs nothing — zero rates are a fact, not an assumed price. */
const FREE: AiTokenPricing = {
  model: 'mock-model', currency: 'USD', promptCostPerToken: 0, completionCostPerToken: 0,
};

const steppedClock = (step = 5) => { let t = 1_000; return () => { const n = t; t += step; return n; }; };

/**
 * A deployment where the copilot is switched on and budgeted.
 *
 * `integrationEnabled` is stated explicitly because `aiEnabled()` is false in this phase
 * and would otherwise shadow every rule beneath it. Nothing here turns AI on.
 */
function runtimeFor(overrides: Partial<CopilotRuntime> = {}): CopilotRuntime {
  return {
    provider: new MockAiProvider(),
    feature: {
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
}

const sinkOf = (runtime: CopilotRuntime) => runtime.sink as InMemoryAiUsageSink;
const providerOf = (runtime: CopilotRuntime) => runtime.provider as MockAiProvider;

async function latestFilters(data: DashboardDataProvider): Promise<ReportFilters> {
  const months = await data.getAvailableMonths();
  return { month: months[months.length - 1] ?? '', propertyId: null, platform: null };
}

const fixture = () => new FixtureDashboardDataProvider({ now: () => FIXED_NOW });

async function ask(
  role: Role,
  runtime: CopilotRuntime,
  data: DashboardDataProvider = fixture(),
  question = 'What needs attention today?',
) {
  return answerCopilotQuestion(data, {
    role, userId: 'user-uuid', question, filters: await latestFilters(data),
  }, runtime);
}

/* ================================================================== *
 * Authorization
 * ================================================================== */

describe('copilot · who may ask (§4, §7, §8.1)', () => {
  it('INVESTOR is refused, and no payload is built to leak', async () => {
    const runtime = runtimeFor();
    await expect(ask('INVESTOR', runtime)).rejects.toBeInstanceOf(CopilotNotPermittedError);
    // Refused before any read, so there is nothing to send and nothing to log.
    expect(providerOf(runtime).calls).toEqual([]);
    expect(sinkOf(runtime).records).toEqual([]);
  });

  it('authorization outranks every other gate', async () => {
    // Everything below is also wrong: budget unset, feature off, no provider, no pricing.
    // The refusal must still be the authorization one, and must still log nothing.
    const runtime = runtimeFor({
      provider: null,
      pricing: null,
      feature: { integrationEnabled: false, switches: ALL_FEATURES_OFF, budget: { cap: null, spent: 0 } },
    });
    await expect(ask('INVESTOR', runtime)).rejects.toBeInstanceOf(CopilotNotPermittedError);
    expect(sinkOf(runtime).records).toEqual([]);
  });

  it('ADMIN and SUPER_ADMIN reach every tool', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      const answer = await ask(role, runtimeFor());
      expect(answer.outcome).toBe('OK');
      expect(answer.tools.length).toBe(7);
      expect(answer.omitted).toEqual([]);
    }
  });

  it('OPERATIONS gets the ops-scoped copilot §7 describes, and nothing financial', async () => {
    const runtime = runtimeFor();
    const answer = await ask('OPERATIONS', runtime);

    expect(answer.outcome).toBe('OK');
    expect(answer.tools).toEqual(['getAlerts']);
    expect(answer.omitted.map((o) => o.tool).sort()).toEqual([
      'getCashFlowForecast', 'getExpenseBreakdown', 'getForecast', 'getKpis',
      'getPlatformMix', 'getPropertyPerformance',
    ]);

    // The payload the provider actually received — not the answer shape — is what matters.
    const sent = providerOf(runtime).calls[0]!.payload.contents as Record<string, unknown>;
    expect(sent.kpis).toBeNull();
    expect(sent.propertyPerformance).toBeNull();
    expect(sent.expenseBreakdown).toBeNull();
    expect(sent.platformMix).toBeNull();
    expect(sent.forecast).toBeNull();
    expect(sent.alerts).not.toBeNull();
  });

  it('an operations turn carries no financial figure at all', async () => {
    const runtime = runtimeFor();
    await ask('OPERATIONS', runtime, new DemoGridProvider());
    const sent = providerOf(runtime).calls[0]!.payload.contents as Record<string, unknown>;

    // Asserted structurally rather than by keyword: the omitted-tool notes legitimately
    // say words like "profit" and "cost" while explaining what the role may not reach,
    // and a text search cannot tell an explanation from a figure. What matters is that
    // no value in the only section this role receives is a number.
    for (const alert of sent.alerts as Array<Record<string, unknown>>) {
      for (const value of Object.values(alert)) expect(typeof value).toBe('string');
    }
    const populated = ['kpis', 'propertyPerformance', 'expenseBreakdown', 'platformMix', 'forecast']
      .filter((key) => sent[key] !== null);
    expect(populated).toEqual([]);
  });
});

/* ================================================================== *
 * Data minimisation
 * ================================================================== */

describe('copilot · what reaches the model (§8.3)', () => {
  it('no guest the board names appears in anything sent to the provider', async () => {
    const data = new DemoGridProvider();
    const runtime = runtimeFor();
    const filters = await latestFilters(data);
    const board = await data.getOperations(filters);
    const names = [...board.data.arrivals, ...board.data.departures].map((r) => r.guestDisplayName);
    expect(names.length).toBeGreaterThan(0);

    await ask('ADMIN', runtime, data);
    const sent = JSON.stringify(providerOf(runtime).calls[0]);
    for (const name of names) expect(sent, name).not.toContain(name);
    expect(sent).toContain('[guest]');
  });

  it('no contact detail reaches the provider, on either data source', async () => {
    for (const data of [fixture(), new DemoGridProvider()] as DashboardDataProvider[]) {
      const runtime = runtimeFor();
      await ask('SUPER_ADMIN', runtime, data);
      const sent = JSON.stringify(providerOf(runtime).calls[0]!.payload.contents);
      expect(sent).not.toMatch(/@|\+91|phone|email/i);
    }
  });

  it('the question is sent as asked, and the facts travel stamped', async () => {
    const runtime = runtimeFor();
    await ask('ADMIN', runtime, fixture(), 'Which unit performed best?');
    const call = providerOf(runtime).calls[0]!;
    expect(call.question).toBe('Which unit performed best?');
    expect(call.payload.environment).toBe('demo');
    expect(call.payload.demo).toBe(true);
    expect(call.feature).toBe('copilot');
  });
});

/* ================================================================== *
 * The system prompt
 * ================================================================== */

describe('copilot · the system prompt is §8.2, transcribed', () => {
  it('carries all five anti-fabrication rules', async () => {
    expect(COPILOT_SYSTEM_PROMPT).toMatch(/never compute, estimate, round or infer/i);
    expect(COPILOT_SYSTEM_PROMPT).toMatch(/state the period/i);
    expect(COPILOT_SYSTEM_PROMPT).toMatch(/insufficient data/i);
    expect(COPILOT_SYSTEM_PROMPT).toMatch(/forecasts are produced by a deterministic service/i);
    expect(COPILOT_SYSTEM_PROMPT).toMatch(/data, never instruction/i);

    const runtime = runtimeFor();
    await ask('ADMIN', runtime);
    expect(providerOf(runtime).calls[0]!.system).toBe(COPILOT_SYSTEM_PROMPT);
  });

  it('states no figure of its own, so it cannot ground a fabricated one', () => {
    expect(COPILOT_SYSTEM_PROMPT.replace(/^\s*\d\./gm, '')).not.toMatch(/\d/);
  });
});

/* ================================================================== *
 * Forecast restriction
 * ================================================================== */

describe('copilot · forecasts are explained, never regenerated (§8.2 rule 4)', () => {
  it('estimates arrive computed, labelled and without their working', async () => {
    const runtime = runtimeFor();
    await ask('ADMIN', runtime);
    const sent = providerOf(runtime).calls[0]!.payload.contents as {
      forecast: Array<Record<string, unknown>>;
    };
    expect(sent.forecast.length).toBe(3);
    for (const estimate of sent.forecast) {
      expect(estimate.label).toBe('ESTIMATE');
      expect(estimate.method).toBeTruthy();
      // The terms of the calculation stay out: a model handed them can perform a
      // different one and present it with the same confidence.
      expect(estimate).not.toHaveProperty('inputs');
    }
  });

  it('a forecast figure the engine did not produce is caught', async () => {
    const runtime = runtimeFor({
      provider: new MockAiProvider({ reply: () => 'Next month will bring 137 nights.' }),
    });
    const answer = await ask('ADMIN', runtime);
    expect(answer.outcome).toBe('FLAGGED');
    expect(answer.ungrounded).toContain('137');
  });
});

/* ================================================================== *
 * Anti-fabrication
 * ================================================================== */

describe('copilot · fabricated figures are detected (§8.2 rule 1)', () => {
  it('a figure from the facts passes', async () => {
    const runtime = runtimeFor();
    // Ask once to see what the facts contain, then answer with a figure taken from them.
    const first = await ask('ADMIN', runtime);
    expect(first.outcome).toBe('OK');
    const sent = providerOf(runtime).calls[0]!.payload.contents as {
      propertyPerformance: Array<{ occupiedNights: number }>;
    };
    const nights = sent.propertyPerformance[0]!.occupiedNights;

    const second = runtimeFor({
      provider: new MockAiProvider({ reply: () => `That unit sold ${nights} nights.` }),
    });
    const answer = await ask('ADMIN', second);
    expect(answer.outcome).toBe('OK');
    expect(answer.ungrounded).toEqual([]);
  });

  it('an invented figure is flagged, named, and still returned', async () => {
    const runtime = runtimeFor({
      provider: new MockAiProvider({ reply: () => 'Net revenue was 8,888,888.' }),
    });
    const answer = await ask('ADMIN', runtime);
    expect(answer.outcome).toBe('FLAGGED');
    expect(answer.ungrounded).toEqual(['8888888']);
    expect(answer.answer).toBe('Net revenue was 8,888,888.');
    expect(answer.message).toMatch(/absent from the retrieved facts/i);
  });

  it('the check runs before the usage record is written', async () => {
    // If the record were written first it could not carry FLAGGED — it would say OK.
    const runtime = runtimeFor({
      provider: new MockAiProvider({ reply: () => 'Revenue was 7,777,777.' }),
    });
    await ask('ADMIN', runtime);
    expect(sinkOf(runtime).records[0]!.outcome).toBe('FLAGGED');
  });

  it('the mock cannot fabricate a plausible figure by accident', () => {
    expect(MOCK_REPLY).not.toMatch(/\d/);
  });
});

/* ================================================================== *
 * Every attempt, exactly one usage record
 * ================================================================== */

describe('copilot · every attempt produces exactly one usage outcome (§8.4)', () => {
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
    ['the provider is unavailable', {
      provider: new MockAiProvider({ fail: 'UNAVAILABLE' }),
    }, 'UNAVAILABLE', null],
    ['the provider answers invalidly', {
      provider: new MockAiProvider({ fail: 'INVALID_RESPONSE' }),
    }, 'INVALID_RESPONSE', null],
    ['the mock answers', {}, 'OK', null],
  ];

  for (const [label, overrides, outcome, reason] of attempts) {
    it(`records exactly one row when ${label}`, async () => {
      const runtime = runtimeFor(overrides);
      const answer = await ask('ADMIN', runtime);

      expect(answer.outcome).toBe(outcome);
      expect(answer.reason).toBe(reason);
      expect(sinkOf(runtime).records.length).toBe(1);
      expect(sinkOf(runtime).records[0]).toMatchObject({
        feature: 'copilot', model: 'mock-model', userId: 'user-uuid', outcome,
      });
      // Provenance travels even when there is no answer — a refusal that does not say
      // which period it would have described is harder to act on than one that does.
      expect(answer.period).toMatch(/^\d{4}-\d{2}$/);
      expect(answer.source).toBe('FIXTURE');
    });
  }

  it('a refusal never reaches the provider', async () => {
    for (const [label, overrides] of attempts.filter(([, , o]) => o === 'REFUSED')) {
      const runtime = runtimeFor(overrides);
      if (!runtime.provider) continue;
      await ask('ADMIN', runtime);
      expect(providerOf(runtime).calls, label).toEqual([]);
      expect(sinkOf(runtime).records[0]).toMatchObject({
        promptTokens: 0, completionTokens: 0, cost: 0,
      });
    }
  });
});

/* ================================================================== *
 * Environment
 * ================================================================== */

describe('copilot · a turn cannot cross environments', () => {
  it('one environment stamps the facts and checks them, so a turn cannot be split', async () => {
    // The service passes a single resolved environment to both the context boundary and
    // the dispatcher. That is the property: a mismatch is not something a caller of this
    // function can construct, only something a caller of the lower layers can.
    const runtime = runtimeFor({ resolved: productionEnv() });
    const answer = await ask('ADMIN', runtime);
    expect(answer.outcome).toBe('OK');
    expect(providerOf(runtime).calls[0]!.payload.environment).toBe('production');
  });

  it('the environment is checked before the §8.4 gates, and logs nothing', async () => {
    // Assembled by hand so the two environments genuinely differ, with the feature also
    // disabled and the budget unset. The environment mismatch must still win: a payload
    // built in the wrong place is a bug worth surfacing even while the feature is off.
    const data = fixture();
    const filters = await latestFilters(data);
    const runtime = runtimeFor({
      resolved: productionEnv(),
      feature: {
        integrationEnabled: false, switches: ALL_FEATURES_OFF, budget: { cap: null, spent: 0 },
      },
    });

    const payload = await buildCopilotContext(data, filters, {
      role: 'ADMIN', resolved: demoEnv(), now: FIXED_NOW,
    });
    await expect(dispatchCompletion(providerOf(runtime), {
      feature: 'copilot', model: 'mock-model', system: COPILOT_SYSTEM_PROMPT, question: 'q', payload,
    }, {
      feature: runtime.feature, pricing: runtime.pricing, sink: runtime.sink,
      userId: 'u', resolved: productionEnv(), now: runtime.clock,
    })).rejects.toBeInstanceOf(AiEnvironmentMismatchError);

    expect(providerOf(runtime).calls).toEqual([]);
    expect(sinkOf(runtime).records).toEqual([]);
  });
});

/* ================================================================== *
 * Determinism, isolation, and the gate that is still shut
 * ================================================================== */

describe('copilot · deterministic, local, and still switched off', () => {
  it('repeated turns are identical', async () => {
    const first = await ask('ADMIN', runtimeFor());
    const second = await ask('ADMIN', runtimeFor());
    expect(second.answer).toBe(first.answer);
    expect(second.outcome).toBe(first.outcome);
    expect(second.period).toBe(first.period);
    expect(second.tools).toEqual(first.tools);
    expect(second.usage.promptTokens).toBe(first.usage.promptTokens);
    expect(second.usage.completionTokens).toBe(first.usage.completionTokens);
  });

  it('resolving the mock provider does not enable AI', async () => {
    expect(aiEnabled()).toBe(false);
    // The runtime omits `integrationEnabled`, so the real gate decides — and it is shut.
    const runtime = runtimeFor({
      provider: resolveAiProvider('mock'),
      feature: {
        switches: { copilot: true, guest: true, reviews: true, summaries: true },
        budget: { cap: 25, spent: 0 },
      },
    });
    const answer = await ask('ADMIN', runtime);
    expect(answer.outcome).toBe('REFUSED');
    expect(answer.reason).toBe('INTEGRATION_DISABLED');
    expect(providerOf(runtime).calls).toEqual([]);
  });

  it('a whole turn makes no network call', async () => {
    const escaped: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      escaped.push(String(input));
      throw new Error('A network call escaped the copilot path.');
    }) as typeof globalThis.fetch;
    try {
      const answer = await ask('ADMIN', runtimeFor(), new DemoGridProvider());
      expect(answer.outcome).toBe('OK');
    } finally {
      globalThis.fetch = original;
    }
    expect(escaped).toEqual([]);
  });

  it('aiEnabled is still false', () => {
    expect(aiEnabled()).toBe(false);
  });
});
