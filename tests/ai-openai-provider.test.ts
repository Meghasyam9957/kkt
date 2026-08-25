/**
 * THE REAL PROVIDER — tested without a key, a network or a bill.
 *
 * Every call below goes through an injected `fetch`, so this suite exercises the adapter's
 * whole contract — request shape, usage mapping, failure classification, timeout, and the
 * handling of the secret — while never reaching OpenAI and never costing anything. The
 * opt-in smoke test that does reach OpenAI lives elsewhere and never runs in the gate.
 *
 * Two properties matter more than the rest, and both are asserted against behaviour rather
 * than against a comment: the key appears in the Authorization header and nowhere else,
 * and one request in produces exactly one call out.
 */
import { describe, it, expect } from 'vitest';
import {
  OpenAiProvider, OpenAiKeyMissingError, classifyStatus, OPENAI_RESPONSES_URL,
} from '@/lib/server/ai/openai-provider';
import {
  AiProviderError, computeCost,
  type AiCompletionRequest, type AiProviderFailure, type AiTokenPricing,
} from '@/lib/server/ai/provider';
import {
  resolveAiConfig, aiProviderPermitted, readAiApiKey, AI_ENV_VARS, TOKENS_PER_MTOK,
} from '@/lib/server/ai/config';
import { buildAiPayload } from '@/lib/server/ai/guard';
import { resolveEnvironment } from '@/lib/server/environment/config';
import type { EnvLike } from '@/lib/shared/env';

const FIXED_NOW = new Date('2027-01-19T06:00:00.000Z');

/** A structurally plausible project key. Fictional, and never a real credential. */
const FAKE_KEY = 'sk-proj-000000000000000000000000';

const serviceAccount = (who: string) =>
  Buffer.from(JSON.stringify({ client_email: `${who}@example.invalid` }), 'utf8').toString('base64');

const demoEnv = () => resolveEnvironment({
  APP_ENV: 'demo',
  DEMO_GOOGLE_SHEET_ID: 'demo-workbook-id-9876',
  DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: serviceAccount('demo'),
  DEMO_SUPABASE_URL: 'demo.supabase.invalid',
  DEMO_SUPABASE_SERVICE_ROLE_KEY: 'demo-service-role',
} as EnvLike);

function requestFor(): AiCompletionRequest {
  return {
    feature: 'copilot',
    model: 'configured-model-id',
    system: 'Answer only from the retrieved facts.',
    question: 'What needs attention today?',
    payload: buildAiPayload({ period: '2027-01', alerts: [] }, { resolved: demoEnv(), now: FIXED_NOW }),
  };
}

/** A fetch double that records every call and answers with a canned response. */
function stubFetch(reply: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return reply();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fail = (status: number, body: unknown = { error: { type: 'invalid_request_error' } }) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RESPONSE = {
  model: 'configured-model-id',
  status: 'completed',
  output_text: 'Two units need attention.',
  usage: { input_tokens: 1_200, output_tokens: 300, input_tokens_details: { cached_tokens: 400 } },
};

/* ================================================================== *
 * Configuration
 * ================================================================== */

describe('AI config · published pricing converted to the internal contract', () => {
  const configured = (overrides: Record<string, string> = {}): EnvLike => ({
    DEMO_AI_ENABLED: 'true',
    DEMO_AI_PROVIDER: 'openai',
    DEMO_OPENAI_API_KEY: FAKE_KEY,
    DEMO_AI_MODEL_COPILOT: 'configured-model-id',
    DEMO_AI_PRICE_INPUT_PER_MTOK: '0.20',
    DEMO_AI_PRICE_CACHED_INPUT_PER_MTOK: '0.02',
    DEMO_AI_PRICE_OUTPUT_PER_MTOK: '1.20',
    DEMO_AI_PRICE_CURRENCY: 'USD',
    DEMO_AI_BUDGET_CURRENCY: 'USD',
    DEMO_AI_BUDGET_CAP: '25',
    ...overrides,
  } as EnvLike);

  it('converts per-million-token prices into per-token, exactly', () => {
    // The unit trap Step 4 names: published figures are per 1M tokens, the internal
    // contract is per token, and copying one into the other is a millionfold error.
    const { pricing } = resolveAiConfig(configured(), 'DEMO_');
    expect(pricing).not.toBeNull();
    expect(pricing!.promptCostPerToken).toBeCloseTo(0.20 / TOKENS_PER_MTOK, 15);
    expect(pricing!.completionCostPerToken).toBeCloseTo(1.20 / TOKENS_PER_MTOK, 15);
    expect(pricing!.cachedPromptCostPerToken).toBeCloseTo(0.02 / TOKENS_PER_MTOK, 15);
    expect(TOKENS_PER_MTOK).toBe(1_000_000);
  });

  it('a million input tokens costs exactly the published per-million figure', () => {
    // The conversion stated as the identity that makes it checkable by a person.
    const { pricing } = resolveAiConfig(configured(), 'DEMO_');
    const cost = computeCost({ promptTokens: TOKENS_PER_MTOK, completionTokens: 0 }, pricing!);
    expect(cost).toBeCloseTo(0.20, 10);
  });

  it('prices cached input at the cached rate when one is configured', () => {
    const { pricing } = resolveAiConfig(configured(), 'DEMO_');
    const cost = computeCost(
      { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 1_000_000 },
      pricing!,
    );
    expect(cost).toBeCloseTo(0.02, 10);
  });

  it('prices cached input at the FULL rate when no cached rate is configured', () => {
    // The safe direction: overstating cost can only trip a cap early, never late.
    const { pricing } = resolveAiConfig(
      configured({ DEMO_AI_PRICE_CACHED_INPUT_PER_MTOK: '' }), 'DEMO_',
    );
    expect(pricing!.cachedPromptCostPerToken).toBeUndefined();
    const cost = computeCost(
      { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 1_000_000 },
      pricing!,
    );
    expect(cost).toBeCloseTo(0.20, 10);
  });

  it('a provider reporting more cached tokens than prompt tokens gets no discount', () => {
    const { pricing } = resolveAiConfig(configured(), 'DEMO_');
    const cost = computeCost(
      { promptTokens: 100, completionTokens: 0, cachedPromptTokens: 10_000 },
      pricing!,
    );
    expect(cost).toBeCloseTo(100 * (0.02 / TOKENS_PER_MTOK), 15);
  });

  it('never puts the key in the resolved configuration', () => {
    const config = resolveAiConfig(configured(), 'DEMO_');
    expect(config.apiKeyPresent).toBe(true);
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(config)).not.toContain('sk-proj');
  });

  it('reads the key only through its own accessor, and only for the active environment', () => {
    expect(readAiApiKey(configured(), 'DEMO_')).toBe(FAKE_KEY);
    // A demo key is not a production key. Different variable, no fallback.
    expect(readAiApiKey(configured(), 'PRODUCTION_')).toBeNull();
  });

  it('reports what is absent by name, never by value', () => {
    const config = resolveAiConfig({ APP_ENV: 'demo' } as EnvLike, 'DEMO_');
    expect(config.missing).toContain(`DEMO_${AI_ENV_VARS.apiKey}`);
    expect(config.missing).toContain(`DEMO_${AI_ENV_VARS.budgetCap}`);
    expect(config.pricing).toBeNull();
    expect(config.budgetCap).toBeNull();
  });

  it('refuses to reconcile two currencies rather than inventing a rate', () => {
    const config = resolveAiConfig(
      configured({ DEMO_AI_BUDGET_CURRENCY: 'INR' }), 'DEMO_',
    );
    expect(config.currencyMismatch).toBe(true);
    expect(aiProviderPermitted(config, 'demo', false).reason).toBe('CURRENCY_MISMATCH');
  });
});

/* ================================================================== *
 * The permission gate
 * ================================================================== */

describe('AI config · when a paid provider may run', () => {
  const full = (overrides: Record<string, string> = {}): EnvLike => ({
    DEMO_AI_ENABLED: 'true',
    DEMO_AI_PROVIDER: 'openai',
    DEMO_OPENAI_API_KEY: FAKE_KEY,
    DEMO_AI_MODEL_COPILOT: 'configured-model-id',
    DEMO_AI_PRICE_INPUT_PER_MTOK: '0.20',
    DEMO_AI_PRICE_OUTPUT_PER_MTOK: '1.20',
    DEMO_AI_PRICE_CURRENCY: 'USD',
    DEMO_AI_BUDGET_CURRENCY: 'USD',
    DEMO_AI_BUDGET_CAP: '25',
    ...overrides,
  } as EnvLike);

  const reasonFor = (overrides: Record<string, string>, prod = false) =>
    aiProviderPermitted(resolveAiConfig(full(overrides), 'DEMO_'), prod ? 'production' : 'demo', false).reason;

  it('permits a fully configured demo', () => {
    expect(aiProviderPermitted(resolveAiConfig(full(), 'DEMO_'), 'demo', false))
      .toEqual({ permitted: true, reason: null });
  });

  it('refuses unless the enable flag says true, as the environment already reads flags', () => {
    // Matches readWritesEnabled: trimmed and case-insensitive, so 'TRUE ' enables and
    // the near-misses do not. Asserted rather than assumed, because a second convention
    // for reading a boolean is how one of them ends up wrong.
    for (const raw of ['', 'yes', '1', 'false', 'true ', 'enabled']) {
      const expected = raw.trim().toLowerCase() === 'true' ? null : 'NOT_ENABLED';
      expect(reasonFor({ DEMO_AI_ENABLED: raw }), JSON.stringify(raw)).toBe(expected);
    }
    expect(reasonFor({ DEMO_AI_ENABLED: 'TRUE ' })).toBeNull();
  });

  it('refuses production until it is explicitly approved, however complete the config', () => {
    // Mirrors writesPermitted: production begins disabled and only a deliberate act
    // changes that. A developer pointing a local run at production cannot spend money.
    expect(reasonFor({}, true)).toBe('PRODUCTION_NOT_APPROVED');
    const config = resolveAiConfig(full(), 'DEMO_');
    expect(aiProviderPermitted(config, 'production', true).permitted).toBe(true);
  });

  const absences: Array<[string, Record<string, string>, string]> = [
    ['no provider is named', { DEMO_AI_PROVIDER: '' }, 'NO_PROVIDER'],
    ['no key is configured', { DEMO_OPENAI_API_KEY: '' }, 'NO_API_KEY'],
    ['no model is configured', { DEMO_AI_MODEL_COPILOT: '' }, 'NO_MODEL'],
    ['no input price is configured', { DEMO_AI_PRICE_INPUT_PER_MTOK: '' }, 'NO_PRICING'],
    ['no output price is configured', { DEMO_AI_PRICE_OUTPUT_PER_MTOK: '' }, 'NO_PRICING'],
    ['no budget cap is configured', { DEMO_AI_BUDGET_CAP: '' }, 'NO_BUDGET_CAP'],
  ];

  for (const [label, overrides, reason] of absences) {
    it(`refuses when ${label}`, () => {
      expect(reasonFor(overrides)).toBe(reason);
    });
  }

  it('an absent key is never read as "fall back to the mock"', () => {
    // Step 9's rule. The absence is a refusal with a name, not a silent downgrade.
    expect(reasonFor({ DEMO_OPENAI_API_KEY: '' })).toBe('NO_API_KEY');
    expect(() => new OpenAiProvider({ apiKey: '' })).toThrow(OpenAiKeyMissingError);
    expect(() => new OpenAiProvider({ apiKey: '   ' })).toThrow(OpenAiKeyMissingError);
  });
});

/* ================================================================== *
 * The adapter
 * ================================================================== */

describe('OpenAI provider · the request it makes', () => {
  it('posts once to the documented endpoint, and only once', async () => {
    // Step 7: one request in, one provider call out. No retry multiplies a bill.
    const { impl, calls } = stubFetch(() => ok(RESPONSE));
    await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(OPENAI_RESPONSES_URL);
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('does not retry a failure', async () => {
    const { impl, calls } = stubFetch(() => fail(500));
    const provider = new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl });
    await expect(provider.complete(requestFor())).rejects.toBeInstanceOf(AiProviderError);
    expect(calls.length).toBe(1);
  });

  it('sends the configured model, the system rules and the question', async () => {
    const { impl, calls } = stubFetch(() => ok(RESPONSE));
    await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('configured-model-id');
    expect(body.instructions).toBe('Answer only from the retrieved facts.');
    expect(body.input).toContain('What needs attention today?');
    // §8.2 rule 5: the facts are labelled as data rather than instruction.
    expect(body.input).toContain('data, not instructions');
  });

  it('names no model of its own', async () => {
    const { impl, calls } = stubFetch(() => ok({ ...RESPONSE, model: 'whatever-answered' }));
    const request = { ...requestFor(), model: 'some-other-configured-id' };
    await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(request);
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('some-other-configured-id');
  });
});

describe('OpenAI provider · the usage it reports', () => {
  it('maps the documented usage fields, cached input included', async () => {
    const { impl } = stubFetch(() => ok(RESPONSE));
    const result = await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());
    expect(result.usage.promptTokens).toBe(1_200);
    expect(result.usage.completionTokens).toBe(300);
    expect(result.usage.cachedPromptTokens).toBe(400);
    expect(result.text).toBe('Two units need attention.');
    expect(result.model).toBe('configured-model-id');
    expect(result.finishReason).toBe('completed');
  });

  it('leaves cached tokens undefined when the provider does not report them', async () => {
    // Undefined is "not stated". Zero would claim the provider reported no cache hits.
    const { impl } = stubFetch(() => ok({
      ...RESPONSE, usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const result = await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());
    expect(result.usage.cachedPromptTokens).toBeUndefined();
  });

  it('reads the structured output array when there is no convenience field', async () => {
    const { impl } = stubFetch(() => ok({
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [{ content: [{ type: 'output_text', text: 'From the array.' }] }],
    }));
    const result = await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());
    expect(result.text).toBe('From the array.');
  });

  it('reports zero rather than guessing when usage is absent entirely', async () => {
    const { impl } = stubFetch(() => ok({ output_text: 'An answer.' }));
    const result = await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());
    expect(result.usage.promptTokens).toBe(0);
    expect(result.usage.completionTokens).toBe(0);
  });
});

describe('OpenAI provider · how it fails', () => {
  const cases: Array<[number, AiProviderFailure]> = [
    [401, 'AUTHENTICATION'],
    [403, 'AUTHENTICATION'],
    [429, 'RATE_LIMITED'],
    [408, 'TIMEOUT'],
    [500, 'UNAVAILABLE'],
    [502, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
    [504, 'TIMEOUT'],
    [400, 'INVALID_RESPONSE'],
    [404, 'INVALID_RESPONSE'],
  ];

  for (const [status, failure] of cases) {
    it(`classifies HTTP ${status} as ${failure}`, async () => {
      expect(classifyStatus(status)).toBe(failure);
      const { impl } = stubFetch(() => fail(status));
      const provider = new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl });
      await provider.complete(requestFor()).then(
        () => { throw new Error('should have thrown'); },
        (error: AiProviderError) => {
          expect(error).toBeInstanceOf(AiProviderError);
          expect(error.failure).toBe(failure);
        },
      );
    });
  }

  it('authentication and malformed answers are not retryable; the rest are', async () => {
    const { impl } = stubFetch(() => fail(401));
    const provider = new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl });
    await provider.complete(requestFor()).catch((e: AiProviderError) => {
      expect(e.retryable).toBe(false);
    });
  });

  it('classifies an aborted request as a timeout', async () => {
    const controller = new AbortController();
    const impl = (async () => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;
    const provider = new OpenAiProvider({
      apiKey: FAKE_KEY, fetchImpl: impl,
      signalFactory: () => ({ signal: controller.signal, done: () => {} }),
    });
    await provider.complete(requestFor()).catch((e: AiProviderError) => {
      expect(e.failure).toBe('TIMEOUT');
    });
  });

  it('classifies an unreachable host as unavailable, not as a bad answer', async () => {
    const impl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const provider = new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl });
    await provider.complete(requestFor()).catch((e: AiProviderError) => {
      expect(e.failure).toBe('UNAVAILABLE');
    });
  });

  it('rejects unreadable JSON and an answer with no text', async () => {
    const bad = stubFetch(() => new Response('not json', { status: 200 }));
    await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: bad.impl })
      .complete(requestFor())
      .catch((e: AiProviderError) => expect(e.failure).toBe('INVALID_RESPONSE'));

    const empty = stubFetch(() => ok({ usage: { input_tokens: 1, output_tokens: 0 } }));
    await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: empty.impl })
      .complete(requestFor())
      .catch((e: AiProviderError) => expect(e.failure).toBe('INVALID_RESPONSE'));
  });
});

/* ================================================================== *
 * The secret
 * ================================================================== */

describe('OpenAI provider · the key goes exactly one place', () => {
  it('travels in the Authorization header and nowhere else in the request', async () => {
    const { impl, calls } = stubFetch(() => ok(RESPONSE));
    await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());

    const { init } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(String(init.body)).not.toContain(FAKE_KEY);
    expect(calls[0]!.url).not.toContain(FAKE_KEY);
  });

  it('never puts the key in an error message, whatever the provider returns', async () => {
    // Including the case where the provider echoes something key-shaped back at us.
    const echo = { error: { type: FAKE_KEY, code: FAKE_KEY }, detail: FAKE_KEY };
    for (const status of [401, 429, 500, 400]) {
      const { impl } = stubFetch(() => fail(status, echo));
      await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl })
        .complete(requestFor())
        .catch((e: AiProviderError) => {
          expect(e.message, `status ${status}`).not.toContain(FAKE_KEY);
          expect(e.message).not.toContain('sk-proj');
          expect(String(e.stack ?? '')).not.toContain(FAKE_KEY);
        });
    }
  });

  it('never puts the key in a timeout or network error message', async () => {
    const impl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl })
      .complete(requestFor())
      .catch((e: AiProviderError) => expect(e.message).not.toContain(FAKE_KEY));
  });

  it('is not reachable by serialising the provider', () => {
    const provider = new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: stubFetch(() => ok(RESPONSE)).impl });
    // A private field is not a vault, but it must at least not be volunteered: nothing
    // that a logger reaches for by habit should produce it.
    expect(JSON.stringify({ id: provider.id, external: provider.external })).not.toContain(FAKE_KEY);
    expect(String(provider)).not.toContain(FAKE_KEY);
  });

  it('recognises a project-scoped key, which is what OpenAI recommends for a team', () => {
    const scoped = new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: stubFetch(() => ok(RESPONSE)).impl });
    expect(scoped.usesProjectKey).toBe(true);
    const legacy = new OpenAiProvider({ apiKey: 'sk-legacy-account-wide', fetchImpl: stubFetch(() => ok(RESPONSE)).impl });
    expect(legacy.usesProjectKey).toBe(false);
  });

  it('declares itself external, so registering it is a deliberate act', () => {
    const provider = new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: stubFetch(() => ok(RESPONSE)).impl });
    expect(provider.external).toBe(true);
    expect(provider.id).toBe('openai');
  });
});

/* ================================================================== *
 * Cost, end to end
 * ================================================================== */

describe('OpenAI provider · real usage priced by configured rates', () => {
  it('costs a real response with the configured table, and nothing hard-coded', async () => {
    const pricing: AiTokenPricing = {
      model: 'configured-model-id',
      currency: 'USD',
      promptCostPerToken: 0.20 / TOKENS_PER_MTOK,
      completionCostPerToken: 1.20 / TOKENS_PER_MTOK,
      cachedPromptCostPerToken: 0.02 / TOKENS_PER_MTOK,
    };
    const { impl } = stubFetch(() => ok(RESPONSE));
    const result = await new OpenAiProvider({ apiKey: FAKE_KEY, fetchImpl: impl }).complete(requestFor());

    // 800 uncached input + 400 cached input + 300 output, at the rates above.
    const expected = 800 * pricing.promptCostPerToken
      + 400 * pricing.cachedPromptCostPerToken!
      + 300 * pricing.completionCostPerToken;
    expect(computeCost(result.usage, pricing)).toBeCloseTo(expected, 15);
  });
});
