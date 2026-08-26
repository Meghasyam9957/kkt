import '@/lib/server/only';
/**
 * AI CONFIGURATION — every value §8 leaves to a person, read from the environment.
 *
 * This module decides nothing. It reads what has been configured, converts published
 * pricing into the internal per-token representation, and reports what is absent **by
 * name**. Every gate that follows is a consequence of an absence rather than a policy
 * invented here: no cap means no call, no pricing means no call, and a provider currency
 * that differs from the budget currency means no call, because reconciling them needs an
 * exchange-rate policy nobody has approved.
 *
 * **The API key never enters the resolved object.** `AiRuntimeConfig` carries
 * `apiKeyPresent: boolean` and nothing more, so the configuration can be logged,
 * serialised or returned without leaking a secret — a property the security suite asserts
 * rather than trusts. The value itself is reachable only through `readAiApiKey`, which the
 * composition root calls once when it constructs the provider.
 *
 * Variables follow the environment's own namespacing (`DEMO_` / `PRODUCTION_`), so a demo
 * key and a production key are different variables and neither can stand in for the other.
 */
import type { EnvLike } from '@/lib/shared/env';
import type { AppEnv } from '@/lib/shared/environment';
import type { AiTokenPricing } from '@/lib/server/ai/provider';

/**
 * The unprefixed variable names, in one place so the security scan and the documentation
 * can enumerate them without a second list to fall out of step.
 */
export const AI_ENV_VARS = {
  enabled: 'AI_ENABLED',
  provider: 'AI_PROVIDER',
  apiKey: 'OPENAI_API_KEY',
  model: 'AI_MODEL_COPILOT',
  /*
   * Priced per MILLION tokens, because that is the unit OpenAI publishes and copying a
   * published figure without converting it is the mistake this name exists to prevent.
   * The internal contract is per token; the conversion happens here, once, and is tested.
   */
  priceInputPerMTok: 'AI_PRICE_INPUT_PER_MTOK',
  priceCachedInputPerMTok: 'AI_PRICE_CACHED_INPUT_PER_MTOK',
  priceOutputPerMTok: 'AI_PRICE_OUTPUT_PER_MTOK',
  /** The currency the PROVIDER bills in. */
  priceCurrency: 'AI_PRICE_CURRENCY',
  /** The currency the APPLICATION budget is expressed in. */
  budgetCurrency: 'AI_BUDGET_CURRENCY',
  budgetCap: 'AI_BUDGET_CAP',
} as const;

/** Tokens per unit of published pricing. Named so the arithmetic cannot be misread. */
export const TOKENS_PER_MTOK = 1_000_000;

/**
 * The provider ids configuration may name, and which of them is a real, paid backend.
 *
 * The vocabulary lives here rather than with the factories because it is *configuration*,
 * and because an id nobody implements has to be rejected while the configuration is being
 * read — not later, by a dispatcher quietly finding no provider and refusing a question
 * that looked like it should have worked.
 *
 * `mock` is a genuine choice, not a fallback: it is the deterministic local provider, and
 * it is reachable only by naming it. Nothing degrades into it. A deployment that asks for
 * `openai` and cannot have it is refused, because an assistant that silently answers from
 * a stub is indistinguishable from one that is working.
 */
export const SELECTABLE_AI_PROVIDERS = Object.freeze({
  openai: { real: true },
  mock: { real: false },
} as const);

export type AiProviderId = keyof typeof SELECTABLE_AI_PROVIDERS;

export function isSelectableAiProvider(id: string | null): id is AiProviderId {
  return id !== null && Object.hasOwn(SELECTABLE_AI_PROVIDERS, id);
}

/** Whether the named provider spends money against a real account. */
export function aiProviderIsReal(id: string | null): boolean {
  return isSelectableAiProvider(id) && SELECTABLE_AI_PROVIDERS[id].real;
}

/**
 * What a model id may look like.
 *
 * Deliberately permissive — it admits every published id, every dated snapshot and the
 * `ft:...::...` shape a fine-tune carries. What it excludes is whitespace, quotation marks
 * and control characters, which mean somebody pasted a sentence, a comment, or two ids
 * into one variable. That is not a model id in any naming scheme, so it is treated as
 * unconfigured here rather than sent to the provider to be rejected at our expense.
 *
 * It is a shape check, not an allowlist. Which model is approved is a management
 * decision, and a list of ids in source would go stale the first time OpenAI ships one.
 */
const MODEL_ID = /^[\w.:\-/]{1,128}$/;

export interface AiRuntimeConfig {
  /** `<PREFIX>AI_ENABLED` is the literal string 'true'. Never defaulted on. */
  enabled: boolean;
  providerId: string | null;
  /** Whether a key is configured. **Never the key itself.** */
  apiKeyPresent: boolean;
  model: string | null;
  /** Null unless every rate and the currency are configured. */
  pricing: AiTokenPricing | null;
  /** The approved monthly cap. Null until §13 Q6 is answered. */
  budgetCap: number | null;
  budgetCurrency: string | null;
  /**
   * True when the provider bills in one currency and the budget is expressed in another.
   * Reconciling them needs an exchange-rate policy, which is a management decision — so
   * this is reported and the call is refused, never converted at an invented rate.
   */
  currencyMismatch: boolean;
  /** Names of the variables that are absent. **Names only, never values.** */
  missing: string[];
}

const read = (env: EnvLike, prefix: string, name: string): string | undefined => {
  const value = env[`${prefix}${name}`];
  return value && value.trim() !== '' ? value : undefined;
};

const readNumber = (env: EnvLike, prefix: string, name: string): number | null => {
  const raw = read(env, prefix, name);
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * The API key, read at the moment a provider is constructed and never stored anywhere
 * else. Separate from `resolveAiConfig` on purpose: a configuration object that cannot
 * contain the secret cannot leak it, however it is logged.
 */
export function readAiApiKey(
  env: EnvLike = process.env,
  prefix: string,
): string | null {
  return read(env, prefix, AI_ENV_VARS.apiKey) ?? null;
}

/**
 * Read the AI configuration for one environment.
 *
 * Never throws for absence — absence is the normal state and the reason every gate below
 * refuses. It reports what is missing so a deployment can be diagnosed without guessing.
 */
export function resolveAiConfig(env: EnvLike = process.env, prefix = ''): AiRuntimeConfig {
  const missing: string[] = [];
  const required = (name: string): string | null => {
    const value = read(env, prefix, name);
    if (value === undefined) missing.push(`${prefix}${name}`);
    return value ?? null;
  };

  const enabled = (read(env, prefix, AI_ENV_VARS.enabled) ?? '').trim().toLowerCase() === 'true';
  const providerId = required(AI_ENV_VARS.provider);
  const apiKeyPresent = read(env, prefix, AI_ENV_VARS.apiKey) !== undefined;
  if (!apiKeyPresent) missing.push(`${prefix}${AI_ENV_VARS.apiKey}`);
  const rawModel = required(AI_ENV_VARS.model);
  const trimmedModel = rawModel?.trim() ?? null;
  const model = trimmedModel !== null && MODEL_ID.test(trimmedModel) ? trimmedModel : null;
  // Present but unusable is reported the same way as absent: by name, in `missing`. A
  // deployment reading "DEMO_AI_MODEL_COPILOT" in that list can see what to fix without
  // the value — which may be wrong but is still nobody's business to print.
  if (rawModel !== null && model === null) missing.push(`${prefix}${AI_ENV_VARS.model}`);

  const inputPerMTok = readNumber(env, prefix, AI_ENV_VARS.priceInputPerMTok);
  const outputPerMTok = readNumber(env, prefix, AI_ENV_VARS.priceOutputPerMTok);
  const cachedPerMTok = readNumber(env, prefix, AI_ENV_VARS.priceCachedInputPerMTok);
  const priceCurrency = required(AI_ENV_VARS.priceCurrency);
  if (inputPerMTok === null) missing.push(`${prefix}${AI_ENV_VARS.priceInputPerMTok}`);
  if (outputPerMTok === null) missing.push(`${prefix}${AI_ENV_VARS.priceOutputPerMTok}`);

  const budgetCap = readNumber(env, prefix, AI_ENV_VARS.budgetCap);
  if (budgetCap === null) missing.push(`${prefix}${AI_ENV_VARS.budgetCap}`);
  const budgetCurrency = required(AI_ENV_VARS.budgetCurrency);

  const pricing: AiTokenPricing | null =
    model !== null && priceCurrency !== null && inputPerMTok !== null && outputPerMTok !== null
      ? {
        model,
        currency: priceCurrency,
        promptCostPerToken: inputPerMTok / TOKENS_PER_MTOK,
        completionCostPerToken: outputPerMTok / TOKENS_PER_MTOK,
        // Optional by design: when the published cached rate is not configured, cached
        // input is priced at the full input rate. That overstates the cost slightly,
        // which is the safe direction for a cap — it can only trip early, never late.
        ...(cachedPerMTok !== null
          ? { cachedPromptCostPerToken: cachedPerMTok / TOKENS_PER_MTOK }
          : {}),
      }
      : null;

  const currencyMismatch = priceCurrency !== null && budgetCurrency !== null
    && priceCurrency.trim().toUpperCase() !== budgetCurrency.trim().toUpperCase();

  return {
    enabled, providerId, apiKeyPresent, model, pricing,
    budgetCap, budgetCurrency, currencyMismatch, missing,
  };
}

/**
 * Where a running total of this month's spend could be read from.
 *
 *   none      nothing accumulates it — a cap cannot be enforced, so nothing may run
 *   process   an in-process accumulator: correct for one instance, wrong for several
 *   durable   a shared store that survives a restart and is seen by every instance
 *
 * This is a statement about what exists, not a policy. Today `durable` is unreachable:
 * §1.3 permits Supabase to hold AI usage logs but no retention period is specified for
 * them, so the table is proposed rather than created — see docs/DECISIONS_REQUIRED.md.
 */
export type AiSpendSource = 'none' | 'process' | 'durable';

/**
 * What this deployment actually has.
 *
 * Demo has the in-process accumulator on its usage sink, which is honest for a single
 * demonstration instance. Production has nothing, and a cap that cannot be measured
 * against is not a cap — so production cannot run a paid provider today whatever else is
 * configured. That is a consequence of the missing retention decision, not a policy
 * invented here.
 */
export function availableSpendSource(appEnv: AppEnv): AiSpendSource {
  return appEnv === 'demo' ? 'process' : 'none';
}

/**
 * `<PREFIX>AI_PRODUCTION_APPROVED`. Production begins disabled and only the explicit
 * string 'true' changes that, mirroring how `writesPermitted` treats production writes:
 * the environment that spends real money against a real account does not acquire that
 * ability by inheriting a demo default.
 */
export function aiProductionApproved(env: EnvLike = process.env, prefix = ''): boolean {
  return (env[`${prefix}AI_PRODUCTION_APPROVED`] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Whether a rate-limit policy is actually being enforced for AI (§8.4).
 *
 *   none      no policy exists; nothing is counted and nothing is refused
 *   enforced  a limiter is in place and is applying an approved policy
 *
 * Like `AiSpendSource`, this states what exists rather than choosing it. §8.4 requires
 * per-user and per-role limits but names no numbers and no window, and a limit is a
 * number — so no default is written here and none is read from the environment. See
 * lib/server/ai/rate-limit.ts.
 */
export type AiRateLimitState = 'none' | 'enforced';

/** Why a configured AI integration is nonetheless not permitted to run. */
export type AiNotPermittedReason =
  | 'NOT_ENABLED'
  | 'NO_PROVIDER'
  | 'NO_API_KEY'
  | 'NO_MODEL'
  | 'NO_PRICING'
  | 'NO_BUDGET_CAP'
  | 'CURRENCY_MISMATCH'
  | 'PRODUCTION_NOT_APPROVED'
  | 'NO_SPEND_SOURCE'
  /** The configured id names no provider this application has. Never a fallback. */
  | 'UNKNOWN_PROVIDER'
  /** §8.4 requires rate limits; none is specified, so production may not run. */
  | 'NO_RATE_LIMIT_POLICY';

/**
 * Whether a real, paid provider may run in this environment — and if not, precisely why.
 *
 * Every clause is an absence or an explicit refusal, never a default. The production
 * clause mirrors `writesPermitted`: production begins disabled and stays disabled until
 * somebody flips a flag on purpose, because production is the environment that spends real
 * money against a real account.
 */
export function aiProviderPermitted(
  config: AiRuntimeConfig,
  appEnv: AppEnv,
  productionApproved: boolean,
  spendSource: AiSpendSource = availableSpendSource(appEnv),
  rateLimit: AiRateLimitState = 'none',
): { permitted: boolean; reason: AiNotPermittedReason | null } {
  const no = (reason: AiNotPermittedReason) => ({ permitted: false, reason });
  if (!config.enabled) return no('NOT_ENABLED');
  if (appEnv === 'production' && !productionApproved) return no('PRODUCTION_NOT_APPROVED');
  if (!config.providerId) return no('NO_PROVIDER');
  /*
   * A misspelt id is refused here, while the configuration is being read, rather than
   * resolving to nothing and surfacing later as NO_PROVIDER from the dispatcher. The
   * difference matters: `aiEnabled()` would otherwise answer `true` for a deployment whose
   * every question refuses, which is the sort of thing that gets diagnosed at a demo.
   */
  if (!isSelectableAiProvider(config.providerId)) return no('UNKNOWN_PROVIDER');
  if (!config.apiKeyPresent) return no('NO_API_KEY');
  if (!config.model) return no('NO_MODEL');
  if (!config.pricing) return no('NO_PRICING');
  if (config.currencyMismatch) return no('CURRENCY_MISMATCH');
  if (config.budgetCap === null) return no('NO_BUDGET_CAP');
  /*
   * Last, and the one that cannot be configured away today. §8.4's cap is a *hard* cap;
   * enforcing it needs a running total, and production has nowhere to keep one. A
   * per-instance count would under-report across instances, which is the silent overspend
   * the cap exists to prevent — so it is refused rather than approximated.
   */
  if (spendSource === 'none') return no('NO_SPEND_SOURCE');
  if (appEnv === 'production' && spendSource !== 'durable') return no('NO_SPEND_SOURCE');
  /*
   * And §8.4's other unmet requirement. Rate limits exist to stop one account emptying a
   * month's budget in an afternoon; a demonstration with a handful of invited users and a
   * small explicit cap can be watched instead, which is why this clause is production-only
   * and why the demo state is called `none` rather than dressed up as a limiter.
   */
  if (appEnv === 'production' && rateLimit !== 'enforced') return no('NO_RATE_LIMIT_POLICY');
  return { permitted: true, reason: null };
}
