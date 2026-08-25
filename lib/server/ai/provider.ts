import '@/lib/server/only';
/**
 * AI PROVIDER SEAM — the shape any model backend must take to be usable here.
 *
 * The point of this file is that adding the real one is configuration, not surgery. A
 * provider receives an already-minimised payload and returns text plus its own token
 * counts; it decides nothing about what it was told, what that costs, or whether it was
 * allowed to run. Those live in the context boundary (§8.1/§8.3), the pricing supplied by
 * the caller, and the guardrails (§8.4) respectively — so an OpenAI adapter added later
 * inherits every rule already tested here without restating any of them.
 *
 * What a provider must NOT be given a chance to influence:
 *
 *   - **which facts it sees** — the payload arrives built, stamped with its environment,
 *     and this module never reaches for a repository, a workbook or a calculation engine;
 *   - **what a call costs** — pricing is a parameter. §10.2 lists per-token rates as
 *     "assumptions to confirm at build time", so no rate is written down anywhere here;
 *   - **whether it may run at all** — that is `aiFeatureStatus`, checked before dispatch.
 *
 * Nothing in this file opens a socket or reads a credential. The only provider shipped
 * today is the local mock, which does neither by construction.
 */
import { aiEnabled } from '@/lib/server/ai/guard';
import type { AiPayload } from '@/lib/server/ai/guard';
import type { AiFeature, AiUsageRecord } from '@/lib/server/ai/guardrails';

/* ------------------------------------------------------------------ *
 * The call
 * ------------------------------------------------------------------ */

/** §8.4 logs "prompt/completion tokens". A provider reports its own; nothing infers them. */
export interface AiTokenUsage {
  promptTokens: number;
  completionTokens: number;
  /**
   * How many of the prompt tokens the provider served from its own cache, when it says so.
   *
   * Preserved because the provider reports it and discarding a fact costs more than
   * carrying it. It is priced only when a cached rate is configured; otherwise these
   * tokens are billed here at the full input rate, which overstates the cost and can only
   * trip a cap early. Undefined means the provider did not report it — never zero, which
   * would claim it reported no cache hits.
   */
  cachedPromptTokens?: number;
}

export interface AiCompletionRequest {
  feature: AiFeature;
  /**
   * The model id. §8.4: "Model IDs live in config, changeable without a deploy" — so it
   * arrives as data. No module in this layer names a model.
   */
  model: string;
  /** The system instruction, authored by the caller. No prompt text is stored here. */
  system: string;
  /** The person's question, verbatim. */
  question: string;
  /**
   * The retrieved facts, already whitelisted and stripped by the context boundary, and
   * stamped with the environment that produced them. Passing the stamped payload rather
   * than its contents is what lets the dispatcher refuse a cross-environment send.
   */
  payload: AiPayload<unknown>;
}

export interface AiCompletionResult {
  text: string;
  usage: AiTokenUsage;
  /** The model that actually answered — a provider may resolve an alias. */
  model: string;
  finishReason: string;
}

/**
 * Anything that can answer a question from a payload.
 *
 * Deliberately one method. A wider interface would invite a provider to expose
 * capabilities the guardrails know nothing about, and the first such capability would be
 * the one nobody tested.
 */
export interface AiProvider {
  /** Stable identifier, used to select the provider from configuration. */
  readonly id: string;
  /** True when this backend costs real money — the mock is the only one that does not. */
  readonly external: boolean;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

/* ------------------------------------------------------------------ *
 * Failure
 * ------------------------------------------------------------------ */

/**
 * How a call can fail, as the code has to branch on it.
 *
 * §8 does not enumerate these — it names "outcome" as a logged field and stops — so this
 * is a technical taxonomy, not a product one. It stays deliberately small: four ways that
 * differ in what a caller should do next, rather than a catalogue of provider error codes.
 * §10.3's ~10 s function limit is why TIMEOUT is first among them.
 */
export type AiProviderFailure =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  /**
   * The credential or the account rejected the call — a wrong key, a key without access
   * to the model, a disabled project. Retrying spends nothing and fixes nothing, so it is
   * the second non-retryable kind alongside a malformed answer.
   */
  | 'AUTHENTICATION';

/** Whether trying the same call again could plausibly succeed. */
const RETRYABLE: Record<AiProviderFailure, boolean> = {
  TIMEOUT: true,
  RATE_LIMITED: true,
  UNAVAILABLE: true,
  // A malformed answer will be malformed again for the same input. Retrying spends money
  // to reach the same place, which is the failure mode §8.4's cap exists to catch.
  INVALID_RESPONSE: false,
  AUTHENTICATION: false,
};

export class AiProviderError extends Error {
  readonly failure: AiProviderFailure;
  readonly retryable: boolean;
  constructor(failure: AiProviderFailure, message?: string) {
    super(message ?? `The AI provider failed: ${failure}.`);
    this.name = 'AiProviderError';
    this.failure = failure;
    this.retryable = RETRYABLE[failure];
  }
}

/* ------------------------------------------------------------------ *
 * Token estimation
 * ------------------------------------------------------------------ */

/**
 * A rough token count from text length.
 *
 * For two uses only: the mock, which has no tokeniser, and §8.4's "context caps … enforced
 * before the call", which needs a size before there is a response to read one from. **It
 * must never be used for billing.** A real provider reports its own counts in its
 * response, and those are the ones that go in the usage record — an estimate that drifts
 * from the invoice is worse than no estimate, because it looks authoritative.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/* ------------------------------------------------------------------ *
 * Cost
 * ------------------------------------------------------------------ */

/**
 * What a model costs, supplied by whoever configured it.
 *
 * Per **token**, not per thousand or per million, so there is no unit convention to guess
 * at — the caller converts published rates once, in the place that read them.
 *
 * The currency is stated rather than assumed. §10.2 does denominate its figures: both the
 * estimate and the recommended cap are in dollars. The business, however, runs in rupees,
 * and nothing reconciles the two — so what is unresolved is the denomination of an
 * *approved* cap and of the costs recorded against it, not whether §10.2 names a currency.
 */
export interface AiTokenPricing {
  model: string;
  /** ISO 4217. The currency the PROVIDER bills in. */
  currency: string;
  promptCostPerToken: number;
  completionCostPerToken: number;
  /**
   * The discounted rate for prompt tokens served from cache, when one is configured.
   * Optional because not every provider publishes one, and an absent rate must not be
   * read as free.
   */
  cachedPromptCostPerToken?: number;
}

export function computeCost(usage: AiTokenUsage, pricing: AiTokenPricing): number {
  // Clamped: a provider reporting more cached tokens than prompt tokens is reporting
  // nonsense, and the arithmetic must not turn nonsense into a discount.
  const cached = Math.min(Math.max(usage.cachedPromptTokens ?? 0, 0), usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  const cachedRate = pricing.cachedPromptCostPerToken ?? pricing.promptCostPerToken;
  return uncached * pricing.promptCostPerToken
    + cached * cachedRate
    + usage.completionTokens * pricing.completionCostPerToken;
}

/* ------------------------------------------------------------------ *
 * Where usage goes
 * ------------------------------------------------------------------ */

/**
 * §8.4: "Every call logged".
 *
 * An interface rather than a table. §1.3 permits Supabase to hold AI usage logs, but no
 * retention period is specified for them anywhere in the architecture, so the persistent
 * implementation is blocked on a decision rather than on work — see
 * docs/PHASE9_READINESS.md. The seam exists now so the dispatcher can be written and
 * tested against it, and so the day the table lands nothing above it changes.
 */
export interface AiUsageSink {
  record(usage: AiUsageRecord): Promise<void>;
}

/**
 * The sink for a deployment that has nowhere to write.
 *
 * §8.4 requires every call logged and §1.3 permits Supabase to hold that log, but no
 * retention period is specified for it anywhere in the architecture, so the table is
 * proposed rather than created. Until it exists this discards — which is honest while AI
 * is off, because the only records are refusals of calls that never happened.
 *
 * It refuses to be honest about anything more than that: the moment AI is genuinely
 * enabled, discarding a real call's cost and tokens would break the one control §8.4
 * relies on, so this throws instead. Enabling AI therefore requires providing a real
 * sink, rather than remembering to.
 */
export class DiscardingAiUsageSink implements AiUsageSink {
  async record(usage: AiUsageRecord): Promise<void> {
    if (aiEnabled()) {
      throw new Error(
        'AI is enabled but no usage sink is configured. §8.4 requires every call logged '
        + `(feature ${usage.feature}, model ${usage.model}); discarding it would leave the `
        + 'monthly budget cap with nothing to count. Configure a sink before enabling AI.',
      );
    }
  }
}

/** The sink used by tests, and the only one that retains anything. */
export class InMemoryAiUsageSink implements AiUsageSink {
  readonly records: Array<AiUsageRecord> = [];
  async record(usage: AiUsageRecord): Promise<void> {
    this.records.push(usage);
  }

  /**
   * What has been spent since this process started.
   *
   * This is what makes a cap enforceable at all: §8.4 wants a hard monthly cap, and a cap
   * needs a running total to compare against. The total is **process-local** — it starts
   * at zero on every restart and knows nothing about other instances — so it is honest
   * for a single demonstration process and wrong for anything that scales.
   * `availableSpendSource` in the AI configuration is where that limit is enforced rather
   * than merely described: production is refused because this is all there is.
   *
   * It is never a claim about the month.
   */
  spent(): number {
    return this.records.reduce((total, record) => total + record.cost, 0);
  }
}
