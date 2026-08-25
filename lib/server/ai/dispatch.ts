import '@/lib/server/only';
/**
 * AI DISPATCH — the one path a question travels, and every gate on it.
 *
 * `guard.ts` refuses when there is no provider at all; this refuses for every other
 * reason, in a fixed order, and records what happened either way. Assembling those checks
 * here rather than in each caller is the difference between a rule that holds and a rule
 * that held in the handler somebody remembered to put it in.
 *
 * The order, and why it is that order:
 *
 *   1. **Environment** (§8.1 / the guard's own invariant). A payload built against the
 *      demonstration workbook must never reach a production model. This throws rather than
 *      returning, following `dispatchToAi`: a mismatch is a bug worth surfacing even while
 *      the feature is switched off, because it means the caller built it in the wrong place.
 *   2. **May this feature run** (§8.4) — integration, then budget, then kill switch.
 *   3. **Is there a provider, and can its cost be computed.** No pricing means no cost,
 *      and no cost means the hard cap cannot be enforced — which is the silent overspend
 *      §8.4 forbids, so it is refused rather than run and reconciled later.
 *   4. **The call**, with provider failures caught and classified rather than thrown.
 *   5. **§8.2 rule 1** — the answer is read back against the facts that produced it.
 *
 * Only the first of those throws. The rest return an outcome, because §8.4 requires a
 * clear message on refusal and because "every call logged" is only achievable if a
 * refusal is a value the caller can hand to the sink rather than an exception it may
 * forget to catch.
 */
import { assertAiPayloadEnvironment } from '@/lib/server/ai/guard';
import {
  aiFeatureStatus, budgetState, findUngroundedFigures,
  type AiFeatureBlockedReason, type AiFeatureContext, type AiUsageRecord, type BudgetState,
} from '@/lib/server/ai/guardrails';
import {
  AiProviderError, computeCost,
  type AiCompletionRequest, type AiProvider, type AiTokenPricing, type AiTokenUsage,
  type AiUsageSink,
} from '@/lib/server/ai/provider';
import { MockAiProvider } from '@/lib/server/ai/mock-provider';
import type { ResolvedEnvironment } from '@/lib/server/environment/config';

/* ------------------------------------------------------------------ *
 * Provider selection
 * ------------------------------------------------------------------ */

/**
 * Every provider this application can be configured to use.
 *
 * One entry today. Adding the authorised OpenAI backend is a new module implementing
 * `AiProvider`, one line here, and the configuration that names it — no change to the
 * dispatcher, the guardrails, the context boundary or their tests. That is the whole
 * reason the seam is shaped this way.
 *
 * Note what selecting a provider does NOT do: it does not enable AI. `aiEnabled()` and
 * the per-feature switches are separate gates, checked below, so a configured provider
 * still answers nothing until someone deliberately turns a feature on.
 */
const PROVIDER_FACTORIES: Readonly<Record<string, () => AiProvider>> = Object.freeze({
  mock: () => new MockAiProvider(),
});

/** The ids configuration may name. */
export const AI_PROVIDER_IDS: readonly string[] = Object.keys(PROVIDER_FACTORIES);

/**
 * Resolve the configured provider, or null when none is named.
 *
 * The id is a parameter rather than an environment read, so this module reads no
 * configuration and can never be the place a credential is picked up.
 */
export function resolveAiProvider(id: string | null | undefined): AiProvider | null {
  if (!id) return null;
  const factory = PROVIDER_FACTORIES[id];
  return factory ? factory() : null;
}

/* ------------------------------------------------------------------ *
 * The result
 * ------------------------------------------------------------------ */

export type AiDispatchOutcome =
  /** Answered, and every figure in the answer came from the payload. */
  | 'OK'
  /** Answered, but §8.2 rule 1 found figures the tools never produced. */
  | 'FLAGGED'
  /** Never called: disabled, unbudgeted, switched off, unconfigured or unpriced. */
  | 'REFUSED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE';

/**
 * Why a call was refused, as a code rather than a sentence.
 *
 * The first four are §8.4's own blocking reasons, surfaced rather than invented; the last
 * two are this dispatcher's, and existed already as the messages on its two configuration
 * refusals. `outcome` collapses all six to REFUSED because §8.4's logged field list has no
 * slot for a reason — which is itself worth knowing, and is recorded in
 * docs/PHASE9_READINESS.md rather than fixed by adding a ninth column here.
 *
 * These are technical codes. **§8 specifies no mapping from them to anything a person
 * reads**, so none is written here; `message` carries §8.4's "clear message" for an
 * operator, and a user-facing mapping is left to whoever specifies one.
 */
export type AiRefusalReason = AiFeatureBlockedReason | 'NO_PROVIDER' | 'NO_PRICING';

export interface AiDispatchResult {
  outcome: AiDispatchOutcome;
  /** Set only when the outcome is REFUSED. Distinguishes the six ways that happens. */
  reason: AiRefusalReason | null;
  /** Null unless the provider answered. Never a fabricated stand-in. */
  text: string | null;
  /**
   * §8.2 rule 1's flags. Present with the text rather than instead of it: the rule says
   * to flag, and what a caller should do about a flag — refuse the turn, re-ask, annotate
   * it — is not specified anywhere in §8, so it is not decided here.
   */
  ungrounded: readonly string[];
  /** Why, whenever the outcome is not OK. §8.4: never a silent anything. */
  message: string | null;
  /**
   * Where spend stood against the cap when this turn was decided (§8.4).
   *
   * Derived from the budget itself, NOT from `AiFeatureStatus.warning`. That boolean
   * answers "did this call run past 70%", which is false on every refusal path by
   * construction — including a refusal *caused* by the budget — so at 85% spend with the
   * feature switched off it reports `false`, and at 120% it reports `false` again because
   * BREACHED is a different state. §8.4's concern is the spend position, so the state is
   * what travels.
   *
   * It states a fact and asks for nothing. Where a person should see it, in what words,
   * and what they should do about it are undecided — see docs/DECISIONS_REQUIRED.md.
   */
  budgetState: BudgetState;
  /** §8.4's log line for this call, refusals included. Already handed to the sink. */
  usage: AiUsageRecord;
}

export interface AiDispatchContext {
  /** Switches and budget (§8.4). Its `integrationEnabled` defaults to `aiEnabled()`. */
  feature: AiFeatureContext;
  /** Null until §10.2's per-token rates are confirmed. Null refuses the call. */
  pricing: AiTokenPricing | null;
  sink: AiUsageSink;
  /** The Supabase user id of the person asking. */
  userId: string;
  resolved?: ResolvedEnvironment;
  /** Injectable so latency is measurable without a real clock in a test. */
  now?: () => number;
}

const NO_TOKENS: AiTokenUsage = { promptTokens: 0, completionTokens: 0 };

const FAILURE_MESSAGE = 'The AI provider did not return an answer.';

/**
 * Send one question, or explain why it was not sent.
 *
 * Always records exactly one usage row, refusals and failures included. A refusal costs
 * nothing and consumed no tokens, and saying so is more useful to a usage dashboard than
 * omitting it: a month of refusals looks like silence otherwise.
 */
export async function dispatchCompletion(
  provider: AiProvider | null,
  request: AiCompletionRequest,
  context: AiDispatchContext,
): Promise<AiDispatchResult> {
  // 1 · Environment. Throws, deliberately — see the header.
  assertAiPayloadEnvironment(request.payload, { resolved: context.resolved });

  const clock = context.now ?? Date.now;
  const started = clock();

  // Pure in the budget, so it is read once and reported identically on every path below —
  // including the paths that refuse before the budget is consulted at all.
  const budget = budgetState(context.feature.budget);

  const finish = async (
    outcome: AiDispatchOutcome,
    reason: AiRefusalReason | null,
    text: string | null,
    ungrounded: readonly string[],
    message: string | null,
    usage: AiTokenUsage,
    cost: number,
    currency: string,
  ): Promise<AiDispatchResult> => {
    const record: AiUsageRecord = {
      feature: request.feature,
      model: request.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cost,
      currency,
      latencyMs: clock() - started,
      userId: context.userId,
      outcome,
    };
    await context.sink.record(record);
    return { outcome, reason, text, ungrounded, message, budgetState: budget, usage: record };
  };

  const refuse = (reason: AiRefusalReason, message: string) =>
    // A refusal has no model cost and no currency to state it in. Reporting the
    // configured currency, or none, is the only honest pair of options; the configured
    // one keeps every row in a usage table comparable.
    finish('REFUSED', reason, null, [], message, NO_TOKENS, 0, context.pricing?.currency ?? '');

  // 2 · May this feature run at all (§8.4)?
  const status = aiFeatureStatus(request.feature, context.feature);
  if (!status.enabled) {
    return refuse(status.reason!, status.message ?? 'This AI feature is not available.');
  }

  // 3 · Is there something to call, and can the call be costed?
  if (!provider) {
    return refuse('NO_PROVIDER', 'No AI provider is configured for this deployment.');
  }
  if (!context.pricing) {
    return refuse(
      'NO_PRICING',
      'No token pricing is configured, so this call cannot be costed and the monthly cap '
      + 'cannot be enforced. Running anyway is the silent overspend the cap exists to prevent.',
    );
  }

  // 4 · The call.
  let answer;
  try {
    answer = await provider.complete(request);
  } catch (error) {
    if (!(error instanceof AiProviderError)) throw error;
    return finish(
      error.failure, null, null, [], `${FAILURE_MESSAGE} ${error.message}`,
      NO_TOKENS, 0, context.pricing.currency,
    );
  }

  // 5 · §8.2 rule 1 — read the answer back against the facts that produced it.
  const ungrounded = findUngroundedFigures(answer.text, request.payload.contents);
  const cost = computeCost(answer.usage, context.pricing);
  return finish(
    ungrounded.length === 0 ? 'OK' : 'FLAGGED',
    null,
    answer.text,
    ungrounded,
    ungrounded.length === 0
      ? null
      : `The answer states ${ungrounded.length} figure(s) absent from the retrieved facts: `
        + `${ungrounded.join(', ')}.`,
    answer.usage,
    cost,
    context.pricing.currency,
  );
}
