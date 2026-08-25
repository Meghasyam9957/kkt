import '@/lib/server/only';
/**
 * AI GUARDRAILS — ARCHITECTURE §8.2 and §8.4.
 *
 * §8.2 is titled "Anti-fabrication rules (AIGuardrails)", so this module has a name in the
 * architecture before it has a caller. What is here is the part of §8 that is *decided*:
 * pure rules that need no model, no key, no network and no management answer. What is not
 * here is everything §8 leaves to a person — the budget figure, the model identifiers, the
 * token caps, the rate limits. Those are supplied to these functions, never defaulted by
 * them, so a missing answer surfaces as a refusal rather than as an invented number.
 *
 * The refusal direction is deliberate throughout. §8.4 says a budget breach must degrade
 * AI to disabled "with a clear message — never a silent overspend", and §13's sixth
 * question marks the cap itself as blocking Phase 9. An unset cap is therefore treated
 * exactly like a breached one: off, and saying why. That turns an unanswered management
 * question into a mechanical stop instead of a note in a document.
 *
 * Nothing here reads a credential or opens a socket, and no provider SDK is imported.
 */
import { aiEnabled } from '@/lib/server/ai/guard';

/* ------------------------------------------------------------------ *
 * §8.4 — per-feature kill switches
 * ------------------------------------------------------------------ */

/** §8.4 names these four exactly: "copilot / guest / reviews / summaries". */
export const AI_FEATURES = ['copilot', 'guest', 'reviews', 'summaries'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * The switch positions, as read from wherever they are stored.
 *
 * §8.4 places them "in admin settings" and this application has no such store: business
 * settings are read from the workbook and are not writable from the web app (§13's fifth
 * question, answered that way). Locating them is Phase 9 work and a decision, so this
 * module accepts the positions rather than inventing a home for them.
 */
export type AiFeatureSwitches = Readonly<Record<AiFeature, boolean>>;

/** The position in this phase, and the correct default in any phase: nothing is on. */
export const ALL_FEATURES_OFF: AiFeatureSwitches = Object.freeze({
  copilot: false, guest: false, reviews: false, summaries: false,
});

/* ------------------------------------------------------------------ *
 * §8.4 — hard monthly budget cap
 * ------------------------------------------------------------------ */

/** §8.4: "a soft warning at 70%". The ratio is the architecture's, not a choice made here. */
export const BUDGET_WARNING_RATIO = 0.7;

/**
 * Spend against the cap, in whatever unit the two are expressed in.
 *
 * `cap` is null until §13's sixth question is answered. The unit is deliberately not named
 * here: §10.2 states its own figures in dollars — the estimate and the recommended cap
 * alike — while the business runs in rupees, and nothing reconciles the two. What an
 * *approved* cap is denominated in, and how costs are accounted against it, is therefore
 * still open. Comparing like with like needs no answer to that; recording a cost does,
 * which is why `AiUsageRecord` below carries the currency instead of assuming one.
 */
export interface BudgetPosition {
  cap: number | null;
  spent: number;
}

export type BudgetState = 'UNCONFIGURED' | 'OK' | 'WARNING' | 'BREACHED';

export function budgetState({ cap, spent }: BudgetPosition): BudgetState {
  if (cap === null) return 'UNCONFIGURED';
  if (spent >= cap) return 'BREACHED';
  if (spent >= cap * BUDGET_WARNING_RATIO) return 'WARNING';
  return 'OK';
}

/* ------------------------------------------------------------------ *
 * §8.4 — the one place that decides whether a feature may run
 * ------------------------------------------------------------------ */

export type AiFeatureBlockedReason =
  | 'INTEGRATION_DISABLED'
  | 'BUDGET_UNCONFIGURED'
  | 'BUDGET_EXCEEDED'
  | 'FEATURE_SWITCHED_OFF';

export interface AiFeatureStatus {
  feature: AiFeature;
  enabled: boolean;
  /** Null when enabled. Otherwise the single reason it is not, most fundamental first. */
  reason: AiFeatureBlockedReason | null;
  /** §8.4's clear message. Present whenever the feature is off. */
  message: string | null;
  /** True past 70% of the cap while still running — the soft warning, not a block. */
  warning: boolean;
}

const BLOCKED_MESSAGE: Record<AiFeatureBlockedReason, string> = {
  INTEGRATION_DISABLED:
    'AI is not enabled in this deployment. No model is configured and no key is read.',
  BUDGET_UNCONFIGURED:
    'No monthly AI budget cap is configured. Running without one is the silent overspend '
    + 'the cap exists to prevent, so the feature stays off until a cap is set.',
  BUDGET_EXCEEDED:
    'The monthly AI budget cap has been reached. AI features are disabled for the rest of '
    + 'the period rather than continuing to spend.',
  FEATURE_SWITCHED_OFF:
    'This AI feature is switched off in settings.',
};

export interface AiFeatureContext {
  switches: AiFeatureSwitches;
  budget: BudgetPosition;
  /**
   * Defaults to `aiEnabled()`. Injectable for the same reason `assertAiPayloadEnvironment`
   * takes a resolved environment: the budget and switch rules have to be provable now,
   * and in this phase the integration gate is false, so it would otherwise shadow every
   * other rule and leave them untested until the day they are relied on.
   */
  integrationEnabled?: boolean;
}

/**
 * Whether one feature may run, and if not, the single reason why.
 *
 * The order is fixed and matters: the integration gate outranks the budget, and the budget
 * outranks the switch, because §8.4 requires a breach to disable features regardless of
 * how they are set. Reporting one reason rather than a list keeps the message a person can
 * act on — the most fundamental blocker is the one they have to clear first.
 */
export function aiFeatureStatus(
  feature: AiFeature,
  context: AiFeatureContext,
): AiFeatureStatus {
  const state = budgetState(context.budget);
  const blocked = (reason: AiFeatureBlockedReason): AiFeatureStatus => ({
    feature, enabled: false, reason, message: BLOCKED_MESSAGE[reason], warning: false,
  });

  if (!(context.integrationEnabled ?? aiEnabled())) return blocked('INTEGRATION_DISABLED');
  if (state === 'UNCONFIGURED') return blocked('BUDGET_UNCONFIGURED');
  if (state === 'BREACHED') return blocked('BUDGET_EXCEEDED');
  if (!context.switches[feature]) return blocked('FEATURE_SWITCHED_OFF');
  return { feature, enabled: true, reason: null, message: null, warning: state === 'WARNING' };
}

export class AiFeatureDisabledError extends Error {
  readonly reason: AiFeatureBlockedReason;
  constructor(status: AiFeatureStatus) {
    super(`AI feature "${status.feature}" is not available. ${status.message ?? ''}`.trim());
    this.name = 'AiFeatureDisabledError';
    this.reason = status.reason ?? 'INTEGRATION_DISABLED';
  }
}

/** Throw rather than proceed. A disabled feature that returns an empty answer looks broken. */
export function assertAiFeatureEnabled(feature: AiFeature, context: AiFeatureContext): void {
  const status = aiFeatureStatus(feature, context);
  if (!status.enabled) throw new AiFeatureDisabledError(status);
}

/* ------------------------------------------------------------------ *
 * §8.2 rule 1 — numbers may only come from tool results
 * ------------------------------------------------------------------ */

/**
 * Every number in a piece of text, canonicalised for comparison.
 *
 * Canonicalisation removes only presentation: the digit grouping this application
 * actually emits (`formatCurrency` groups Indian-style with commas) and trailing zeros
 * after a decimal point. Currency marks, percent signs and the sign fall outside the
 * match entirely, so they never form part of a token.
 * It deliberately does NOT remove leading zeros — "03" from a month key must not satisfy
 * a claim about "3" nights — and it does not convert ratios to percentages, because a
 * figure the tools never produced is exactly what this rule exists to catch.
 */
export function numericTokens(text: string): string[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((raw) => {
    const digits = raw.replace(/,/g, '');
    if (!digits.includes('.')) return digits;
    return digits.replace(/0+$/, '').replace(/\.$/, '');
  });
}

/**
 * §8.2's first rule, as a post-response check: every figure in an answer must appear in
 * the tool payload that answered it.
 *
 * The payload is serialised and read the same way the answer is, so anything the tools
 * genuinely returned — including identifiers, month keys and dates — grounds a figure
 * that repeats it. What survives is a number the model produced itself.
 *
 * This flags rather than judges, which is what §8.2 asks for. A rounded or re-expressed
 * figure ("about ₹1.8 lakh", "79%" for a ratio of 0.7946) is reported here too, because
 * it is literally not in the payload; what a caller should DO about a flag — refuse the
 * turn, re-ask, or annotate it — §8 does not say, and this module does not decide.
 */
export function findUngroundedFigures(answer: string, toolPayload: unknown): string[] {
  const grounded = new Set(numericTokens(JSON.stringify(toolPayload) ?? ''));
  const seen = new Set<string>();
  return numericTokens(answer).filter((token) => {
    if (grounded.has(token) || seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * §8.4 — what every call must record
 * ------------------------------------------------------------------ */

/**
 * §8.4: "Every call logged: feature, model, prompt/completion tokens, computed cost,
 * latency, user, outcome".
 *
 * The field list is the architecture's, written out so a logger cannot ship without one
 * of them. Two value domains are deliberately open because §8 fixes neither: `currency`,
 * for the reason given on `BudgetPosition`, and `outcome`, which §8.4 names without
 * enumerating. Narrowing either here would be this file answering a question that belongs
 * to whoever builds the usage dashboard.
 *
 * There is no persistence for this yet. §1.3 permits Supabase to hold "AI conversation +
 * token logs", but no retention period is specified anywhere in the architecture for them,
 * so the table is proposed rather than created — see docs/PHASE9_READINESS.md.
 */
export interface AiUsageRecord {
  feature: AiFeature;
  /** §8.4: "Model IDs live in config". Recorded as given; this module chooses no model. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Computed by the caller from the pricing in force. No pricing table lives here. */
  cost: number;
  /** ISO 4217, stated rather than assumed. */
  currency: string;
  latencyMs: number;
  /** The Supabase user id of the person who asked. Never an investor-scoped identifier. */
  userId: string;
  outcome: string;
}
