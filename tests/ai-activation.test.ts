/**
 * DEMO/UAT ACTIVATION — the configuration contract, and every way it refuses.
 *
 * The question this suite answers is narrow and practical: if somebody sets the AI
 * variables on a demonstration deployment, what exactly has to be present before a
 * question reaches OpenAI, and what happens when each piece is missing or wrong?
 *
 * Every case below is an absence or a mistake, because those are the states a deployment
 * is actually in. The one "everything configured" case exists so the absences mean
 * something: without it, a suite of refusals would pass just as happily if the gate were
 * broken shut.
 *
 * Nothing here reaches the network, and no real credential exists in this repository. The
 * keys are fictional and structurally shaped so the security assertions have something to
 * fail against.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveAiConfig, aiProviderPermitted, aiProductionApproved, readAiApiKey,
  availableSpendSource, isSelectableAiProvider, aiProviderIsReal,
  AI_ENV_VARS, SELECTABLE_AI_PROVIDERS, TOKENS_PER_MTOK,
} from '@/lib/server/ai/config';
import {
  aiRateLimiterFor, aiRateLimitState, UnenforcedAiRateLimiter,
  AiRateLimiterNotPermittedError,
} from '@/lib/server/ai/rate-limit';
import { AI_PROVIDER_IDS, resolveAiProvider } from '@/lib/server/ai/dispatch';
import { budgetState } from '@/lib/server/ai/guardrails';
import { aiEnabled } from '@/lib/server/ai/guard';
import {
  copilotViewState, copilotShowsAnswer, copilotBudgetNotable,
  COPILOT_VIEW_STATES, COPILOT_OPERATOR_ONLY_FIELDS, copilotRefusalKind,
} from '@/lib/shared/ai-copilot-view';
import type { EnvLike } from '@/lib/shared/env';

const ROOT = resolve(__dirname, '..');
const readRepoFile = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

/** Fictional, and shaped like the real thing only so the scans have a target. */
const FAKE_KEY = 'sk-proj-000000000000000000000000';

/**
 * Everything a demonstration needs, in one place. Individual cases blank one field to
 * show which refusal that field is responsible for.
 */
const complete = (prefix: string, extra: Record<string, string> = {}): EnvLike => ({
  [`${prefix}AI_ENABLED`]: 'true',
  [`${prefix}AI_PROVIDER`]: 'openai',
  [`${prefix}OPENAI_API_KEY`]: FAKE_KEY,
  [`${prefix}AI_MODEL_COPILOT`]: 'a-configured-model-id',
  [`${prefix}AI_PRICE_INPUT_PER_MTOK`]: '0.25',
  [`${prefix}AI_PRICE_OUTPUT_PER_MTOK`]: '2.00',
  [`${prefix}AI_PRICE_CURRENCY`]: 'USD',
  [`${prefix}AI_BUDGET_CURRENCY`]: 'USD',
  [`${prefix}AI_BUDGET_CAP`]: '25',
  ...extra,
}) as EnvLike;

const demo = (extra: Record<string, string> = {}) => resolveAiConfig(complete('DEMO_', extra), 'DEMO_');

const permit = (
  env: Record<string, string> = {},
  appEnv: 'demo' | 'production' = 'demo',
  spend?: 'none' | 'process' | 'durable',
  rate: 'none' | 'enforced' = 'none',
) => {
  const prefix = appEnv === 'demo' ? 'DEMO_' : 'PRODUCTION_';
  const raw = complete(prefix, env);
  return aiProviderPermitted(
    resolveAiConfig(raw, prefix), appEnv, aiProductionApproved(raw, prefix), spend, rate,
  );
};

/* ================================================================== *
 * 1 · The configuration contract
 * ================================================================== */

describe('activation · the variable names are the repository’s own convention', () => {
  it('reads the credential as <PREFIX>OPENAI_API_KEY, so DEMO_OPENAI_API_KEY is correct', () => {
    // The proposed name is not asserted against a comment — it is read through the same
    // function the composition root uses, from an environment that has only that name set.
    expect(AI_ENV_VARS.apiKey).toBe('OPENAI_API_KEY');
    const env = { DEMO_OPENAI_API_KEY: FAKE_KEY } as EnvLike;
    expect(readAiApiKey(env, 'DEMO_')).toBe(FAKE_KEY);
  });

  it('a demo key is invisible to production, and the reverse', () => {
    // The whole point of the prefix convention: neither environment can borrow the
    // other's credential, because neither has a code path that reads the other's name.
    const env = { DEMO_OPENAI_API_KEY: FAKE_KEY } as EnvLike;
    expect(readAiApiKey(env, 'PRODUCTION_')).toBeNull();
    expect(readAiApiKey({ PRODUCTION_OPENAI_API_KEY: FAKE_KEY } as EnvLike, 'DEMO_')).toBeNull();
  });

  it('every variable the code reads is documented in .env.example, with no value', () => {
    const example = readRepoFile('.env.example');
    for (const name of Object.values(AI_ENV_VARS)) {
      const line = `DEMO_${name}=`;
      expect(example, name).toContain(line);
      // Documented as a name only. A value on any of these lines would be a committed
      // secret, whatever it happened to say.
      const value = example.split('\n').find((l) => l.startsWith(line))!.slice(line.length);
      expect(value.trim(), name).toBe('');
    }
  });

  it('.env.example carries no key-shaped string at all', () => {
    expect(readRepoFile('.env.example')).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });

  it('reports what is absent by name, and never by value', () => {
    const config = resolveAiConfig({ DEMO_OPENAI_API_KEY: FAKE_KEY } as EnvLike, 'DEMO_');
    expect(config.missing).toContain('DEMO_AI_MODEL_COPILOT');
    expect(config.missing).toContain('DEMO_AI_BUDGET_CAP');
    expect(config.missing.join(' ')).not.toContain(FAKE_KEY);
    // The resolved object cannot carry the secret however it is serialised.
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    expect(config.apiKeyPresent).toBe(true);
  });
});

/* ================================================================== *
 * 2 · No silent fallback
 * ================================================================== */

describe('activation · nothing degrades into something that answers', () => {
  it('an unknown provider id is refused by name, not resolved to the mock', () => {
    // The failure this prevents: `openal`, `OpenAI`, `gpt` — a typo that used to read as
    // "enabled" and then refuse every question from somewhere much further downstream.
    for (const typo of ['openal', 'OpenAI', 'gpt-5', 'default', '']) {
      const result = permit({ DEMO_AI_PROVIDER: typo });
      expect(result.permitted, typo).toBe(false);
      expect(result.reason, typo).toBe(typo === '' ? 'NO_PROVIDER' : 'UNKNOWN_PROVIDER');
    }
    for (const typo of ['openal', 'OpenAI', 'gpt-5']) {
      expect(resolveAiProvider(typo), typo).toBeNull();
    }
  });

  it('the mock is reachable only by naming it, and is never a real provider', () => {
    expect(isSelectableAiProvider('mock')).toBe(true);
    expect(aiProviderIsReal('mock')).toBe(false);
    expect(aiProviderIsReal('openai')).toBe(true);
    expect(resolveAiProvider('mock')!.external).toBe(false);
  });

  it('the local mock needs no credential; the real provider still does', () => {
    /*
     * What makes a demonstration possible without a key. The mock opens no socket, so
     * requiring one would force a junk value into the single variable that must only ever
     * hold a real secret. Everything else — pricing, currency, the cap — is still
     * required, so the demo exercises the same budget machinery a real provider would.
     */
    expect(permit({ DEMO_AI_PROVIDER: 'mock', DEMO_OPENAI_API_KEY: '' }).permitted).toBe(true);
    expect(permit({ DEMO_AI_PROVIDER: 'openai', DEMO_OPENAI_API_KEY: '' }).reason).toBe('NO_API_KEY');
    // And the mock is not a way around the cap.
    expect(permit({ DEMO_AI_PROVIDER: 'mock', DEMO_OPENAI_API_KEY: '', DEMO_AI_BUDGET_CAP: '' }).reason)
      .toBe('NO_BUDGET_CAP');
  });

  it('every locally constructible provider is one configuration may name', () => {
    // The two lists live apart on purpose — `openai` needs a credential and is built by
    // the composition root — so this is the assertion that keeps them from drifting.
    for (const id of AI_PROVIDER_IDS) {
      expect(Object.keys(SELECTABLE_AI_PROVIDERS), id).toContain(id);
    }
  });

  it('missing pricing refuses rather than running uncosted', () => {
    expect(permit({ DEMO_AI_PRICE_INPUT_PER_MTOK: '' }).reason).toBe('NO_PRICING');
    expect(permit({ DEMO_AI_PRICE_OUTPUT_PER_MTOK: '' }).reason).toBe('NO_PRICING');
  });

  it('a missing cap refuses rather than running unlimited', () => {
    const result = permit({ DEMO_AI_BUDGET_CAP: '' });
    expect(result.permitted).toBe(false);
    expect(result.reason).toBe('NO_BUDGET_CAP');
    // And the budget itself reads as unconfigured, not as "no ceiling".
    expect(budgetState({ cap: null, spent: 0 })).toBe('UNCONFIGURED');
  });

  it('closes on any single absence', () => {
    for (const name of [
      'AI_ENABLED', 'AI_PROVIDER', 'OPENAI_API_KEY', 'AI_MODEL_COPILOT',
      'AI_PRICE_INPUT_PER_MTOK', 'AI_PRICE_OUTPUT_PER_MTOK', 'AI_BUDGET_CAP',
    ]) {
      expect(permit({ [`DEMO_${name}`]: '' }).permitted, name).toBe(false);
    }
    // The control: with nothing blanked, it opens. Otherwise the loop above proves nothing.
    expect(permit().permitted).toBe(true);
  });
});

/* ================================================================== *
 * 3 · The model id
 * ================================================================== */

describe('activation · the model comes from configuration and is checked for shape', () => {
  it('accepts every shape a published or fine-tuned id actually takes', () => {
    for (const id of [
      'a-configured-model-id', 'model-2027-01-19', 'model.mini', 'model_v2',
      'ft:some-model:an-org::AbC123', 'vendor/model-name',
    ]) {
      expect(demo({ DEMO_AI_MODEL_COPILOT: id }).model, id).toBe(id);
    }
  });

  it('treats a value that cannot be an id as unconfigured, and says which variable', () => {
    for (const wrong of [
      'two ids here', 'gpt "quoted"', 'model\tname', '#comment', 'model,other',
    ]) {
      const config = demo({ DEMO_AI_MODEL_COPILOT: wrong });
      expect(config.model, wrong).toBeNull();
      expect(config.missing, wrong).toContain('DEMO_AI_MODEL_COPILOT');
      // The wrong value is named nowhere — it may itself have been a pasted secret.
      expect(config.missing.join(' '), wrong).not.toContain(wrong);
    }
    expect(permit({ DEMO_AI_MODEL_COPILOT: 'two ids here' }).reason).toBe('NO_MODEL');
  });

  it('surrounding whitespace is trimmed rather than treated as an error', () => {
    expect(demo({ DEMO_AI_MODEL_COPILOT: '  a-model  ' }).model).toBe('a-model');
  });

  it('no model id is written into source', () => {
    // §8.4: "Model IDs live in config, changeable without a deploy."
    for (const file of ['lib/server/ai/openai-provider.ts', 'lib/server/ai/config.ts']) {
      expect(readRepoFile(file), file).not.toMatch(/\bgpt-[0-9]/i);
    }
  });
});

/* ================================================================== *
 * 4 · Budget and currency
 * ================================================================== */

describe('activation · the budget, and the currency it is expressed in', () => {
  it('computes a state once a cap is present', () => {
    expect(demo().budgetCap).toBe(25);
    expect(budgetState({ cap: 25, spent: 0 })).toBe('OK');
    expect(budgetState({ cap: 25, spent: 17.5 })).toBe('WARNING');
    expect(budgetState({ cap: 25, spent: 25 })).toBe('BREACHED');
  });

  it('refuses a currency mismatch instead of inventing a rate', () => {
    const result = permit({ DEMO_AI_BUDGET_CURRENCY: 'INR' });
    expect(result.permitted).toBe(false);
    expect(result.reason).toBe('CURRENCY_MISMATCH');
    // Nothing anywhere in the AI tree converts between currencies.
    for (const file of ['lib/server/ai/config.ts', 'lib/server/ai/provider.ts', 'lib/server/ai/dispatch.ts']) {
      expect(readRepoFile(file).toLowerCase(), file).not.toContain('exchange rate');
      expect(readRepoFile(file), file).not.toMatch(/\bfxRate\b|\bconvertCurrency\b/);
    }
  });

  it('converts published per-million pricing exactly once', () => {
    const pricing = demo().pricing!;
    expect(pricing.promptCostPerToken * TOKENS_PER_MTOK).toBeCloseTo(0.25, 10);
    expect(pricing.completionCostPerToken * TOKENS_PER_MTOK).toBeCloseTo(2.0, 10);
    expect(pricing.currency).toBe('USD');
  });
});

/* ================================================================== *
 * 5 · Where spend is counted
 * ================================================================== */

describe('activation · demo counts spend in a process, production counts it nowhere', () => {
  it('names the demo accumulator for what it is', () => {
    expect(availableSpendSource('demo')).toBe('process');
    expect(availableSpendSource('production')).toBe('none');
  });

  it('production is refused even fully configured and explicitly approved', () => {
    const approved = permit({ PRODUCTION_AI_PRODUCTION_APPROVED: 'true' }, 'production');
    expect(approved.permitted).toBe(false);
    expect(approved.reason).toBe('NO_SPEND_SOURCE');
  });

  it('a process-local total is not enough for production, only a durable one', () => {
    const withProcess = permit(
      { PRODUCTION_AI_PRODUCTION_APPROVED: 'true' }, 'production', 'process',
    );
    expect(withProcess.reason).toBe('NO_SPEND_SOURCE');
  });

  it('unapproved production is refused before anything else is considered', () => {
    expect(permit({}, 'production', 'durable', 'enforced').reason).toBe('PRODUCTION_NOT_APPROVED');
  });
});

/* ================================================================== *
 * 6 · Rate limiting
 * ================================================================== */

describe('activation · §8.4 rate limits, absent and saying so', () => {
  it('an unenforced limiter allows the call but never claims to be enforcing', async () => {
    const limiter = new UnenforcedAiRateLimiter('demo');
    const decision = await limiter.check({ userId: 'u1', role: 'ADMIN', feature: 'copilot' });
    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe('none');
    expect(decision.reason).toBeNull();
  });

  it('refuses to exist in production', () => {
    expect(() => new UnenforcedAiRateLimiter('production')).toThrow(AiRateLimiterNotPermittedError);
    expect(aiRateLimiterFor('production')).toBeNull();
    expect(aiRateLimiterFor('demo')!.state).toBe('none');
    expect(aiRateLimitState(null)).toBe('none');
  });

  it('keeps production disabled even with a durable spend source and approval', () => {
    // The clause that outlives the retention decision: solving spend accounting does not
    // supply a rate-limit policy, and §8.4 requires one.
    const result = permit(
      { PRODUCTION_AI_PRODUCTION_APPROVED: 'true' }, 'production', 'durable', 'none',
    );
    expect(result.permitted).toBe(false);
    expect(result.reason).toBe('NO_RATE_LIMIT_POLICY');
    // With both supplied, production would open — so the refusal above is that clause and
    // not some other one still standing.
    expect(permit(
      { PRODUCTION_AI_PRODUCTION_APPROVED: 'true' }, 'production', 'durable', 'enforced',
    ).permitted).toBe(true);
  });

  it('chooses no limit value anywhere', () => {
    // A limit is a number. §8.4 names none, so none is written — and no environment
    // variable is declared for one either, because naming `..._PER_HOUR` would already
    // have chosen the window.
    const source = readRepoFile('lib/server/ai/rate-limit.ts');
    expect(source).not.toMatch(/\b\d+\s*(?:\/|per\b)/i);
    expect(source).not.toMatch(/RATE_LIMIT[A-Z_]*\s*=\s*['"`]?[A-Z_]*(?:PER|MAX|WINDOW)/);
    expect(readRepoFile('.env.example')).not.toMatch(/AI_RATE_LIMIT/);
  });
});

/* ================================================================== *
 * 7 · The parity harness stays out of it
 * ================================================================== */

describe('activation · parity has no AI, by construction', () => {
  it('PARITY_ variables cannot configure AI in either environment', () => {
    const parityEnv = {
      PARITY_AI_ENABLED: 'true',
      PARITY_AI_PROVIDER: 'openai',
      PARITY_OPENAI_API_KEY: FAKE_KEY,
      PARITY_AI_MODEL_COPILOT: 'a-model',
      PARITY_AI_BUDGET_CAP: '25',
    } as EnvLike;
    for (const prefix of ['DEMO_', 'PRODUCTION_', '']) {
      const config = resolveAiConfig(parityEnv, prefix);
      expect(config.enabled, prefix).toBe(false);
      expect(config.apiKeyPresent, prefix).toBe(false);
      expect(readAiApiKey(parityEnv, prefix), prefix).toBeNull();
    }
  });

  it('no parity script imports anything from the AI tree', () => {
    for (const script of ['scripts/parity.mjs', 'scripts/parity-report.mjs']) {
      const source = readRepoFile(script);
      expect(source, script).not.toMatch(/server\/ai\//);
      expect(source, script).not.toMatch(/openai/i);
    }
  });
});

/* ================================================================== *
 * 8 · The gate, end to end
 * ================================================================== */

describe('activation · aiEnabled reads the same configuration', () => {
  const full = (prefix: string, appEnv: string, extra: Record<string, string> = {}) => ({
    APP_ENV: appEnv,
    [`${prefix}GOOGLE_SHEET_ID`]: 'workbook-id',
    [`${prefix}GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`]: Buffer
      .from(JSON.stringify({ client_email: `${appEnv}@example.invalid` }), 'utf8').toString('base64'),
    [`${prefix}SUPABASE_URL`]: `${appEnv}.supabase.invalid`,
    [`${prefix}SUPABASE_SERVICE_ROLE_KEY`]: 'service-role',
    ...complete(prefix, extra),
  }) as unknown as NodeJS.ProcessEnv;

  it('is false in this repository, because nothing here is configured', () => {
    expect(aiEnabled()).toBe(false);
  });

  it('is true only for a demo that configured all of it deliberately', () => {
    expect(aiEnabled(full('DEMO_', 'demo'))).toBe(true);
    expect(aiEnabled(full('DEMO_', 'demo', { DEMO_AI_ENABLED: 'false' }))).toBe(false);
    expect(aiEnabled(full('DEMO_', 'demo', { DEMO_AI_PROVIDER: 'openal' }))).toBe(false);
  });

  it('is false for production however it is configured today', () => {
    expect(aiEnabled(full('PRODUCTION_', 'production'))).toBe(false);
    expect(aiEnabled(full('PRODUCTION_', 'production', {
      PRODUCTION_AI_PRODUCTION_APPROVED: 'true',
    }))).toBe(false);
  });
});

/* ================================================================== *
 * 9 · What a connected interface would have to render
 * ================================================================== */

describe('copilot view states · complete, and free of wording', () => {
  it('maps every server outcome to exactly one state', () => {
    expect(copilotViewState(null)).toBe('idle');
    expect(copilotViewState({ outcome: 'OK', reason: null })).toBe('answered');
    expect(copilotViewState({ outcome: 'FLAGGED', reason: null })).toBe('flagged');
    for (const outcome of ['TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE', 'INVALID_RESPONSE', 'AUTHENTICATION'] as const) {
      expect(copilotViewState({ outcome, reason: null }), outcome).toBe('failed');
    }
  });

  it('separates "no AI here" from "not this turn"', () => {
    for (const reason of ['INTEGRATION_DISABLED', 'NO_PROVIDER'] as const) {
      expect(copilotViewState({ outcome: 'REFUSED', reason }), reason).toBe('unavailable');
    }
    for (const reason of ['BUDGET_EXCEEDED', 'BUDGET_UNCONFIGURED', 'FEATURE_SWITCHED_OFF', 'NO_PRICING'] as const) {
      expect(copilotViewState({ outcome: 'REFUSED', reason }), reason).toBe('refused');
    }
  });

  it('only an answered or flagged turn may render as an answer', () => {
    for (const state of COPILOT_VIEW_STATES) {
      expect(copilotShowsAnswer(state), state).toBe(state === 'answered' || state === 'flagged');
    }
  });

  it('surfaces the budget position only when it is not simply fine', () => {
    expect(copilotBudgetNotable('OK')).toBe(false);
    for (const state of ['WARNING', 'BREACHED', 'UNCONFIGURED'] as const) {
      expect(copilotBudgetNotable(state), state).toBe(true);
    }
  });

  it('invents no user-facing text', () => {
    // Every export is a state or a predicate. A sentence here would be an answer to a
    // question docs/DECISIONS_REQUIRED.md records as open.
    const source = readRepoFile('lib/shared/ai-copilot-view.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const strings = code.match(/'[^']*'/g) ?? [];
    for (const literal of strings) {
      // No spaces, no punctuation: identifiers and state names only.
      expect(literal, literal).toMatch(/^'[A-Za-z@/_.-]*'$/);
    }
  });

  it('names the fields a composer must never render', () => {
    /*
     * `usage` only. `message` was on this list and should not have been: §8.4 requires a
     * budget breach to degrade "with a clear message — never a silent overspend", so
     * suppressing it would produce the silence the rule forbids. It belongs in the system
     * region, which is a different rule from "never rendered".
     */
    expect(COPILOT_OPERATOR_ONLY_FIELDS).toEqual(['usage']);
  });

  it('groups refusals by what a person could do about them', () => {
    expect(copilotRefusalKind('BUDGET_EXCEEDED')).toBe('budget');
    expect(copilotRefusalKind('FEATURE_SWITCHED_OFF')).toBe('disabled');
    for (const reason of [
      'INTEGRATION_DISABLED', 'NO_PROVIDER', 'NO_PRICING', 'BUDGET_UNCONFIGURED', null,
    ] as const) {
      expect(copilotRefusalKind(reason), String(reason)).toBe('configuration');
    }
  });

  it('reaches no server module at runtime', () => {
    // The imports are type-only, so this file is safe for a client component: nothing it
    // pulls in can carry a credential, a provider error body or a usage row to a browser.
    const source = readRepoFile('lib/shared/ai-copilot-view.ts');
    for (const line of source.split('\n').filter((l) => l.includes('@/lib/server'))) {
      expect(line.trim(), line).toMatch(/^import type /);
    }
  });
});

/* ================================================================== *
 * 10 · The interface is still not connected
 * ================================================================== */

describe('copilot page · connected, and still holding no configuration', () => {
  const page = () => readRepoFile('app/admin/ai/page.tsx');
  const console_ = () => readRepoFile('components/copilot/CopilotConsole.tsx');

  it('the page stays a server component and fetches nothing itself', () => {
    // Everything AI-shaped happens over one guarded route. The page renders a shell, so
    // no provider state, model id or configuration is serialised into the page payload.
    expect(page()).not.toContain("'use client'");
    expect(page()).not.toMatch(/\bfetch\(/);
  });

  it('neither the page nor the console names a credential', () => {
    for (const [label, source] of [['page', page()], ['console', console_()]] as const) {
      expect(source, label).not.toMatch(/OPENAI|sk-[A-Za-z0-9_-]{8,}|apiKey/i);
    }
  });

  it('the console reaches exactly one path, on its own origin', () => {
    const fetched = [...console_().matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(fetched).toEqual(['/api/ai/copilot']);
  });

  it('fabricates no answer', () => {
    /*
     * The rule that survived connecting the page: answer text is rendered from the
     * server's field and from nowhere else. A hard-coded sentence dressed as a reply
     * would be the one failure nobody looking at the screen could detect.
     */
    const source = console_();
    expect(source).toContain('answer.answer');
    // The only literal strings near the answer region are the flag label and the
    // simulated badge, both of which describe the answer rather than being one.
    expect(source).not.toMatch(/answer:\s*'[^']{40,}'/);
  });

  it('labels a stub as a stub', () => {
    // ARCHITECTURE has no rule for this because no architecture anticipates a demo being
    // mistaken for a product. The mock says so, on the answer, every time.
    expect(console_()).toContain('answer.simulated');
  });
});
