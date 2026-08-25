/**
 * AI PROVIDER SEAM — the path around a model, tested without one.
 *
 * Everything here runs against the local mock. That is the point: if the gates, the cost
 * arithmetic, the usage log and §8.2's post-response check only work when a real provider
 * is wired in, they are untested on the day they first matter and unfixable on the day
 * they first fail.
 *
 * The property the whole file is really defending is that swapping in an authorised
 * OpenAI backend is a configuration change. Nothing below reaches past `AiProvider`, so
 * every assertion here is one a real provider inherits rather than one it has to repeat.
 *
 * AI stays off throughout. Where a test needs to see past the integration gate it says so
 * explicitly, with `integrationEnabled`, and the last block proves the gate is still shut.
 */
import { describe, it, expect } from 'vitest';
import {
  dispatchCompletion, resolveAiProvider, AI_PROVIDER_IDS,
  type AiDispatchContext, type AiRefusalReason,
} from '@/lib/server/ai/dispatch';
import { MockAiProvider, MOCK_REPLY } from '@/lib/server/ai/mock-provider';
import {
  AiProviderError, computeCost, estimateTokens, InMemoryAiUsageSink,
  type AiCompletionRequest, type AiProviderFailure, type AiTokenPricing,
} from '@/lib/server/ai/provider';
import { aiEnabled, buildAiPayload, AiEnvironmentMismatchError } from '@/lib/server/ai/guard';
import { ALL_FEATURES_OFF } from '@/lib/server/ai/guardrails';
import { buildCopilotContext } from '@/lib/server/ai/copilot-context';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { resolveEnvironment } from '@/lib/server/environment/config';
import type { EnvLike } from '@/lib/shared/env';

const FIXED_NOW = new Date('2027-01-19T06:00:00.000Z');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const serviceAccount = (who: string) =>
  Buffer.from(JSON.stringify({ client_email: `${who}@example.invalid` }), 'utf8').toString('base64');

/** Both environments configured, so a payload can be stamped with either. */
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

/** A local backend costs nothing. Zero rates are a fact here, not an assumed price. */
const FREE: AiTokenPricing = {
  model: 'mock-model', currency: 'USD', promptCostPerToken: 0, completionCostPerToken: 0,
};

function requestFor(contents: unknown = { period: '2027-01', note: 'facts' }): AiCompletionRequest {
  return {
    feature: 'copilot',
    model: 'mock-model',
    system: 'Answer only from the retrieved facts.',
    question: 'What needs attention today?',
    payload: buildAiPayload(contents, { resolved: demoEnv(), now: FIXED_NOW }),
  };
}

/** A monotonic clock that advances a fixed step per read, so latency is deterministic. */
function steppedClock(step = 7): () => number {
  let t = 1_000;
  return () => { const now = t; t += step; return now; };
}

function contextFor(overrides: Partial<AiDispatchContext> = {}): AiDispatchContext {
  return {
    feature: {
      integrationEnabled: true,
      switches: { ...ALL_FEATURES_OFF, copilot: true },
      budget: { cap: 25, spent: 0 },
    },
    pricing: FREE,
    sink: new InMemoryAiUsageSink(),
    userId: 'user-uuid',
    resolved: demoEnv(),
    now: steppedClock(),
    ...overrides,
  };
}

const sinkOf = (context: AiDispatchContext) => context.sink as InMemoryAiUsageSink;

/* ================================================================== *
 * The mock
 * ================================================================== */

describe('AI provider · the local mock', () => {
  it('is not external, and nothing external is registered', () => {
    // A registered provider that costs money is a deliberate act. When the authorised
    // OpenAI backend lands it must fail here first, so someone reads this file.
    expect(AI_PROVIDER_IDS).toEqual(['mock']);
    for (const id of AI_PROVIDER_IDS) expect(resolveAiProvider(id)!.external).toBe(false);
  });

  it('resolves by id, and refuses to guess when the id is unknown or absent', () => {
    expect(resolveAiProvider('mock')).toBeInstanceOf(MockAiProvider);
    expect(resolveAiProvider(null)).toBeNull();
    expect(resolveAiProvider('')).toBeNull();
    expect(resolveAiProvider('openai')).toBeNull();
  });

  it('states no figure of its own', () => {
    // If the default reply carried a number it could satisfy §8.2 rule 1 by coincidence,
    // and the rule's own test would be measuring luck.
    expect(MOCK_REPLY).not.toMatch(/\d/);
  });

  it('is deterministic — the same request answers identically', async () => {
    const provider = new MockAiProvider();
    const first = await provider.complete(requestFor());
    const second = await provider.complete(requestFor());
    expect(second).toEqual(first);
    expect(provider.calls.length).toBe(2);
  });

  it('reports token counts that move with the size of what it was given', async () => {
    const provider = new MockAiProvider();
    const small = await provider.complete(requestFor({ a: 1 }));
    const large = await provider.complete(requestFor({ a: 'x'.repeat(400) }));
    expect(large.usage.promptTokens).toBeGreaterThan(small.usage.promptTokens);
    expect(small.usage.completionTokens).toBe(estimateTokens(MOCK_REPLY));
  });

  it('answers the model it was asked for, and reports why it stopped', async () => {
    const result = await new MockAiProvider().complete(requestFor());
    expect(result.model).toBe('mock-model');
    expect(result.finishReason).toBe('stop');
  });

  it('can be told to fail, and says whether retrying could help', async () => {
    const retryable: Record<AiProviderFailure, boolean> = {
      TIMEOUT: true, RATE_LIMITED: true, UNAVAILABLE: true, INVALID_RESPONSE: false,
    };
    for (const [failure, expected] of Object.entries(retryable) as [AiProviderFailure, boolean][]) {
      const provider = new MockAiProvider({ fail: failure });
      await expect(provider.complete(requestFor())).rejects.toBeInstanceOf(AiProviderError);
      await provider.complete(requestFor()).catch((error: AiProviderError) => {
        expect(error.failure).toBe(failure);
        expect(error.retryable, failure).toBe(expected);
      });
    }
  });
});

/* ================================================================== *
 * Cost accounting
 * ================================================================== */

describe('AI provider · token and cost accounting (§8.4)', () => {
  it('cost is tokens times the rates the caller supplied', () => {
    expect(computeCost({ promptTokens: 1_000, completionTokens: 500 }, {
      model: 'm', currency: 'USD', promptCostPerToken: 0.000002, completionCostPerToken: 0.000008,
    })).toBeCloseTo(0.002 + 0.004, 10);
  });

  it('a free provider costs nothing, which is a fact rather than an assumption', () => {
    expect(computeCost({ promptTokens: 9_999, completionTokens: 9_999 }, FREE)).toBe(0);
  });

  it('no rate is written down anywhere in the AI layer', async () => {
    // §10.2 lists per-token pricing as an assumption to confirm at build time. A rate in
    // a source file would be a costing decision made by this repository.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'lib', 'server', 'ai');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const code = fs.readFileSync(path.join(dir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code, name).not.toMatch(/CostPerToken\s*[:=]\s*[\d.]/);
    }
  });

  it('the usage record carries the providers counts, never the estimate', async () => {
    const provider = new MockAiProvider();
    const request = requestFor();
    const answered = await provider.complete(request);
    const context = contextFor();
    const result = await dispatchCompletion(new MockAiProvider(), request, context);
    expect(result.usage.promptTokens).toBe(answered.usage.promptTokens);
    expect(result.usage.completionTokens).toBe(answered.usage.completionTokens);
  });
});

/* ================================================================== *
 * Dispatch — refusals
 * ================================================================== */

describe('AI dispatch · refusals are answers, and every one is logged', () => {
  const refusals: Array<[string, Partial<AiDispatchContext>, RegExp, AiRefusalReason]> = [
    ['the integration is off', {
      feature: {
        integrationEnabled: false,
        switches: { ...ALL_FEATURES_OFF, copilot: true },
        budget: { cap: 25, spent: 0 },
      },
    }, /no key is read/i, 'INTEGRATION_DISABLED'],
    ['no budget cap is configured', {
      feature: {
        integrationEnabled: true,
        switches: { ...ALL_FEATURES_OFF, copilot: true },
        budget: { cap: null, spent: 0 },
      },
    }, /until a cap is set/i, 'BUDGET_UNCONFIGURED'],
    ['the budget is spent', {
      feature: {
        integrationEnabled: true,
        switches: { ...ALL_FEATURES_OFF, copilot: true },
        budget: { cap: 25, spent: 25 },
      },
    }, /rather than continuing to spend/i, 'BUDGET_EXCEEDED'],
    ['the feature is switched off', {
      feature: {
        integrationEnabled: true,
        switches: ALL_FEATURES_OFF,
        budget: { cap: 25, spent: 0 },
      },
    }, /switched off/i, 'FEATURE_SWITCHED_OFF'],
    ['no pricing is configured', { pricing: null }, /cannot be costed/i, 'NO_PRICING'],
  ];

  for (const [label, overrides, message, reason] of refusals) {
    it(`refuses when ${label}, and never calls the provider`, async () => {
      const provider = new MockAiProvider();
      const context = contextFor(overrides);
      const result = await dispatchCompletion(provider, requestFor(), context);

      expect(result.outcome).toBe('REFUSED');
      expect(result.reason).toBe(reason);
      expect(result.text).toBeNull();
      expect(result.message).toMatch(message);
      expect(provider.calls).toEqual([]);

      // §8.4: every call logged. A refusal spent nothing and must still be visible —
      // a month of refusals otherwise looks exactly like a month of silence.
      expect(sinkOf(context).records.length).toBe(1);
      expect(sinkOf(context).records[0]).toMatchObject({
        outcome: 'REFUSED', promptTokens: 0, completionTokens: 0, cost: 0,
      });
    });
  }

  it('refuses when no provider is configured at all', async () => {
    const context = contextFor();
    const result = await dispatchCompletion(null, requestFor(), context);
    expect(result.outcome).toBe('REFUSED');
    expect(result.reason).toBe('NO_PROVIDER');
    expect(result.message).toMatch(/no ai provider is configured/i);
    expect(sinkOf(context).records.length).toBe(1);
  });

  it('configuring a provider does not enable AI', async () => {
    // The registry and the switches are separate gates on purpose. Resolving a backend
    // must never be the thing that turns a feature on.
    expect(aiEnabled()).toBe(false);
    const context = contextFor({
      feature: {
        switches: { copilot: true, guest: true, reviews: true, summaries: true },
        budget: { cap: 25, spent: 0 },
      },
    });
    const result = await dispatchCompletion(resolveAiProvider('mock'), requestFor(), context);
    expect(result.outcome).toBe('REFUSED');
    expect(result.usage.outcome).toBe('REFUSED');
  });
});

/* ================================================================== *
 * Dispatch — the answered path
 * ================================================================== */

describe('AI dispatch · a call that goes through', () => {
  it('answers, costs, times and logs exactly one call', async () => {
    const provider = new MockAiProvider();
    const context = contextFor({ now: steppedClock(7) });
    const result = await dispatchCompletion(provider, requestFor(), context);

    expect(result.outcome).toBe('OK');
    expect(result.reason).toBeNull();
    expect(result.text).toBe(MOCK_REPLY);
    expect(result.ungrounded).toEqual([]);
    expect(result.message).toBeNull();
    expect(provider.calls.length).toBe(1);

    const [record] = sinkOf(context).records;
    expect(sinkOf(context).records.length).toBe(1);
    expect(record).toMatchObject({
      feature: 'copilot', model: 'mock-model', userId: 'user-uuid',
      currency: 'USD', cost: 0, outcome: 'OK',
    });
    expect(record!.latencyMs).toBeGreaterThan(0);
    expect(record!.promptTokens).toBeGreaterThan(0);
  });

  it('passes the whole stamped payload to the provider, not its contents', async () => {
    // The stamp is what makes a cross-environment send refusable. Unwrapping it before
    // the provider would leave the check with nothing to check.
    const provider = new MockAiProvider();
    const request = requestFor();
    await dispatchCompletion(provider, request, contextFor());
    expect(provider.calls[0]!.payload.environment).toBe('demo');
    expect(provider.calls[0]!.payload.demo).toBe(true);
  });

  it('the soft warning does not stop the call', async () => {
    const context = contextFor({
      feature: {
        integrationEnabled: true,
        switches: { ...ALL_FEATURES_OFF, copilot: true },
        budget: { cap: 100, spent: 85 },
      },
    });
    expect((await dispatchCompletion(new MockAiProvider(), requestFor(), context)).outcome)
      .toBe('OK');
  });
});

/* ================================================================== *
 * Dispatch — §8.2 rule 1
 * ================================================================== */

describe('AI dispatch · numbers may only come from tool results (§8.2 rule 1)', () => {
  it('a figure taken from the real copilot context passes', async () => {
    const data = new FixtureDashboardDataProvider({ now: () => FIXED_NOW });
    const months = await data.getAvailableMonths();
    const contents = (await buildCopilotContext(
      data,
      { month: months[months.length - 1] ?? '', propertyId: null, platform: null },
      { role: 'ADMIN', now: FIXED_NOW },
    )).contents;
    const nights = contents.propertyPerformance![0]!.occupiedNights;

    const request: AiCompletionRequest = {
      ...requestFor(),
      payload: buildAiPayload(contents, { resolved: demoEnv(), now: FIXED_NOW }),
    };
    const provider = new MockAiProvider({ reply: () => `That unit sold ${nights} nights.` });
    const result = await dispatchCompletion(provider, request, contextFor());

    expect(result.outcome).toBe('OK');
    expect(result.ungrounded).toEqual([]);
  });

  it('a figure the facts never contained is flagged, and the answer still comes back', async () => {
    const provider = new MockAiProvider({ reply: () => 'Revenue was 9,999,999.' });
    const context = contextFor();
    const result = await dispatchCompletion(provider, requestFor(), context);

    expect(result.outcome).toBe('FLAGGED');
    // Flagged, not suppressed: §8.2 says to flag, and what a caller does about a flag is
    // not specified anywhere, so it is not decided here.
    expect(result.text).toBe('Revenue was 9,999,999.');
    expect(result.ungrounded).toEqual(['9999999']);
    expect(result.message).toMatch(/absent from the retrieved facts/i);
    expect(sinkOf(context).records[0]!.outcome).toBe('FLAGGED');
  });
});

/* ================================================================== *
 * Dispatch — provider failure
 * ================================================================== */

describe('AI dispatch · provider failure is classified, not thrown at the caller', () => {
  const failures: AiProviderFailure[] = ['TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE', 'INVALID_RESPONSE'];

  for (const failure of failures) {
    it(`${failure} becomes an outcome with a message and a usage row`, async () => {
      const context = contextFor();
      const result = await dispatchCompletion(
        new MockAiProvider({ fail: failure }), requestFor(), context,
      );
      expect(result.outcome).toBe(failure);
      expect(result.reason).toBeNull();
      expect(result.text).toBeNull();
      expect(result.message).toMatch(/did not return an answer/i);
      expect(sinkOf(context).records.length).toBe(1);
      expect(sinkOf(context).records[0]).toMatchObject({
        outcome: failure, promptTokens: 0, completionTokens: 0, cost: 0,
      });
    });
  }

  it('an error that is not a provider failure is not swallowed', async () => {
    // A bug in the adapter must surface as a bug. Classifying everything would turn a
    // programming error into a tidy "the model was unavailable".
    const broken = {
      id: 'broken', external: false,
      complete: async () => { throw new TypeError('adapter bug'); },
    };
    await expect(dispatchCompletion(broken, requestFor(), contextFor()))
      .rejects.toBeInstanceOf(TypeError);
  });
});

/* ================================================================== *
 * Environment isolation
 * ================================================================== */

describe('AI dispatch · a payload cannot cross environments', () => {
  it('a demonstration payload is refused against a production configuration', async () => {
    const context = contextFor({ resolved: productionEnv() });
    await expect(dispatchCompletion(new MockAiProvider(), requestFor(), context))
      .rejects.toBeInstanceOf(AiEnvironmentMismatchError);
  });

  it('the environment is checked before anything else, and logs nothing', async () => {
    // Ordering matters: a mismatched payload is a bug worth surfacing even while the
    // feature is switched off, because it means the caller built it in the wrong place.
    const provider = new MockAiProvider();
    const context = contextFor({
      resolved: productionEnv(),
      feature: { integrationEnabled: false, switches: ALL_FEATURES_OFF, budget: { cap: null, spent: 0 } },
    });
    await expect(dispatchCompletion(provider, requestFor(), context)).rejects.toThrow();
    expect(provider.calls).toEqual([]);
    expect(sinkOf(context).records).toEqual([]);
  });

  it('a production payload is refused against a demonstration configuration', async () => {
    const request: AiCompletionRequest = {
      ...requestFor(),
      payload: buildAiPayload({ note: 'real' }, { resolved: productionEnv(), now: FIXED_NOW }),
    };
    await expect(dispatchCompletion(new MockAiProvider(), request, contextFor()))
      .rejects.toBeInstanceOf(AiEnvironmentMismatchError);
  });
});

/* ================================================================== *
 * Still off
 * ================================================================== */

describe('AI dispatch · nothing leaves the machine, and AI is still off', () => {
  it('a full dispatch makes no network call', async () => {
    /*
     * The isolation suite scans the AI layer for `fetch`, URLs and the node http modules.
     * That proves the absence of code; this proves the absence of a call, which is the
     * claim actually being made. The trap throws as well as recording, so a call would
     * fail the test even if the assertion below were ever loosened.
     */
    const escaped: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      escaped.push(String(input));
      throw new Error('A network call escaped the AI layer.');
    }) as typeof globalThis.fetch;

    try {
      const data = new FixtureDashboardDataProvider({ now: () => FIXED_NOW });
      const months = await data.getAvailableMonths();
      const payload = await buildCopilotContext(
        data,
        { month: months[months.length - 1] ?? '', propertyId: null, platform: null },
        { role: 'ADMIN', resolved: demoEnv(), now: FIXED_NOW },
      );
      const result = await dispatchCompletion(
        resolveAiProvider('mock'),
        { ...requestFor(), payload },
        contextFor(),
      );
      expect(result.outcome).toBe('OK');
    } finally {
      globalThis.fetch = original;
    }

    expect(escaped).toEqual([]);
  });

  it('aiEnabled remains false after every test above', () => {
    expect(aiEnabled()).toBe(false);
  });
});
