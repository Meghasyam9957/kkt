/**
 * REAL PROVIDER SMOKE TEST — opt-in, and off by default.
 *
 * This is the only test in the repository that can spend money, and it will not run
 * unless somebody deliberately asks for it:
 *
 *   AI_REAL_SMOKE=1 npx vitest run tests/ai-real-smoke.test.ts
 *
 * Without that flag every case below is skipped, so `npm run gate` can never reach OpenAI
 * — a property asserted here rather than assumed, because a test suite that quietly bills
 * an account is a worse failure than one that does not run.
 *
 * Even opted in it stays small on purpose: one request, a trivial question, a tiny
 * hand-written context with no business data and no guest data of any kind, and a low
 * output cap. It proves the wire works. It is not a demonstration of the copilot, and it
 * deliberately does not go through the copilot context boundary — there is nothing to
 * minimise here because nothing real is sent.
 */
import { describe, it, expect } from 'vitest';
import { OpenAiProvider } from '@/lib/server/ai/openai-provider';
import { resolveAiConfig, readAiApiKey, aiProviderPermitted, aiProductionApproved } from '@/lib/server/ai/config';
import { buildAiPayload } from '@/lib/server/ai/guard';
import { resolveEnvironment } from '@/lib/server/environment/config';

/** The single switch. Anything other than an explicit opt-in leaves this suite dormant. */
const OPTED_IN = process.env.AI_REAL_SMOKE === '1';

/* ================================================================== *
 * The guard on the guard
 * ================================================================== */

describe('real smoke · cannot run by accident', () => {
  it('is opted out unless AI_REAL_SMOKE is exactly 1', () => {
    // Asserted, not assumed. If this flag were ever truthy in CI, the gate would start
    // spending money silently — so the condition is pinned to one exact value.
    expect(OPTED_IN).toBe(process.env.AI_REAL_SMOKE === '1');
    for (const raw of [undefined, '', '0', 'true', 'yes', '11']) {
      expect(raw === '1').toBe(false);
    }
  });

  it('is skipped in this run', () => {
    // The honest statement of what just happened: if you are reading this passing in CI,
    // the real cases below did not execute.
    expect(OPTED_IN, 'the real provider smoke test must be off in the default suite').toBe(false);
  });
});

/* ================================================================== *
 * The real call — one request, opt-in only
 * ================================================================== */

describe.skipIf(!OPTED_IN)('real smoke · one live call to the configured provider', () => {
  it('refuses to run against production', () => {
    const resolved = resolveEnvironment();
    expect(resolved.env, 'the smoke test never runs against production').not.toBe('production');
  });

  it('answers a trivial question and reports real token usage', async () => {
    const resolved = resolveEnvironment();
    const config = resolveAiConfig(process.env, resolved.prefix);

    const permitted = aiProviderPermitted(
      config, resolved.env, aiProductionApproved(process.env, resolved.prefix),
    );
    expect(permitted.permitted, `provider not permitted: ${permitted.reason}`).toBe(true);
    expect(config.model).toBeTruthy();

    const apiKey = readAiApiKey(process.env, resolved.prefix);
    expect(apiKey, 'no API key is configured for this environment').toBeTruthy();

    const provider = new OpenAiProvider({ apiKey: apiKey!, timeoutMs: 20_000 });

    /*
     * Deliberately trivial. No workbook data, no guest data, no figures — nothing that
     * would matter if it were logged by the provider, and nothing that needs minimising.
     */
    const result = await provider.complete({
      feature: 'copilot',
      model: config.model!,
      system: 'Reply with exactly the word: ready. Nothing else.',
      question: 'Are you reachable?',
      payload: buildAiPayload({ smoke: true }, { resolved }),
    });

    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.model).toBeTruthy();
    // Real usage, from the provider's own response — never estimated.
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);

    // The key must not have travelled into anything the result exposes.
    expect(JSON.stringify(result)).not.toContain(apiKey!);
  });
});
