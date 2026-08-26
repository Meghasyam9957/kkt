/**
 * COPILOT VIEW STATES — what an interface has to be able to show, before it shows it.
 *
 * The set of outcomes a connected composer must handle, derived from the server contract
 * rather than decided in a component. The page reads these; it does not classify a
 * response itself, so there is one place where "what did the server just say" is answered
 * and one place to change when a new outcome appears.
 *
 * Two things it deliberately does NOT contain:
 *
 *   **No wording.** Every value here is a state, not a sentence. §8 specifies no
 *   user-facing text for any refusal, and inventing some would quietly answer a question
 *   listed as undecided in docs/DECISIONS_REQUIRED.md.
 *
 *   **No server import at runtime.** The types come in as types and are erased at compile
 *   time, so a client component may import this without dragging `lib/server/only` — and
 *   without any path existing by which a key, a provider error body or a usage row could
 *   arrive in a browser bundle through this file.
 */
import type { AiDispatchOutcome, AiRefusalReason } from '@/lib/server/ai/dispatch';
import type { BudgetState } from '@/lib/server/ai/guardrails';

/**
 * The states a composer must render.
 *
 *   idle         nothing asked yet — the state the page is in today
 *   loading      a question is in flight
 *   answered     an answer, every figure in it grounded in retrieved facts
 *   flagged      an answer, but §8.2 rule 1 found figures the tools never produced
 *   refused      the deployment has AI but declined this turn (budget, switch, pricing)
 *   unavailable  this deployment has no AI configured at all
 *   failed       the provider was called and did not answer
 *
 * `refused` and `unavailable` are separate because they are different facts about the
 * deployment, and a person reading the screen acts differently on each: one is "not now",
 * the other is "not here". Collapsing them is how an unconfigured demo comes to look like
 * a broken feature.
 */
export const COPILOT_VIEW_STATES = [
  'idle', 'loading', 'answered', 'flagged', 'refused', 'unavailable', 'failed',
] as const;
export type CopilotViewState = (typeof COPILOT_VIEW_STATES)[number];

/**
 * The refusal reasons that mean "this deployment has no AI", as opposed to "not this
 * turn". Both come back as `REFUSED`; only these two are permanent for the deployment.
 */
const UNAVAILABLE_REASONS: readonly AiRefusalReason[] = ['INTEGRATION_DISABLED', 'NO_PROVIDER'];

/** Which server outcome maps to which state. Exhaustive over `AiDispatchOutcome`. */
export function copilotViewState(
  result: { outcome: AiDispatchOutcome; reason: AiRefusalReason | null } | null,
): CopilotViewState {
  if (result === null) return 'idle';
  switch (result.outcome) {
    case 'OK': return 'answered';
    case 'FLAGGED': return 'flagged';
    case 'REFUSED':
      return result.reason !== null && UNAVAILABLE_REASONS.includes(result.reason)
        ? 'unavailable'
        : 'refused';
    case 'TIMEOUT':
    case 'RATE_LIMITED':
    case 'UNAVAILABLE':
    case 'INVALID_RESPONSE':
    case 'AUTHENTICATION':
      return 'failed';
  }
}

/**
 * Why a turn was refused, grouped by what a person could do about it.
 *
 *   configuration  the deployment is not set up — a cap, pricing, a provider, the switch
 *   disabled       set up, but this feature is deliberately switched off (§8.4)
 *   budget         set up and on, but the month's cap is spent (§8.4)
 *
 * Three groups rather than seven codes, because the seven differ in ways only an operator
 * acts on while these three differ in ways the *screen* acts on. The codes still travel;
 * this only decides which region renders them.
 */
export type CopilotRefusalKind = 'configuration' | 'disabled' | 'budget';

export function copilotRefusalKind(reason: AiRefusalReason | null): CopilotRefusalKind {
  if (reason === 'BUDGET_EXCEEDED') return 'budget';
  if (reason === 'FEATURE_SWITCHED_OFF') return 'disabled';
  /*
   * Everything else — INTEGRATION_DISABLED, NO_PROVIDER, NO_PRICING, BUDGET_UNCONFIGURED,
   * and an absent reason — is "not set up". Defaulting here rather than enumerating is
   * deliberate: a refusal code added later lands in the group that points at the
   * deployment, instead of falling through to a branch that tells somebody their question
   * was declined for a reason nobody can name.
   */
  return 'configuration';
}

/** Whether the state carries answer text to display. Nothing else may render as an answer. */
export function copilotShowsAnswer(state: CopilotViewState): boolean {
  return state === 'answered' || state === 'flagged';
}

/**
 * Whether the budget position is worth surfacing at all (§8.4's 70% soft warning).
 *
 * A fact, with no instruction attached and no words chosen. Where it belongs on the
 * screen, and what it should say, is still an open decision.
 */
export function copilotBudgetNotable(state: BudgetState): boolean {
  return state === 'WARNING' || state === 'BREACHED' || state === 'UNCONFIGURED';
}

/**
 * Fields on a copilot answer that must never be rendered anywhere in the interface.
 *
 * `usage` is §8.4's log line — model id, token counts, computed cost, latency. It is not
 * a secret (the security suite proves no credential reaches it) but it is infrastructure
 * reporting, and it has no business on a screen where somebody asked about occupancy.
 *
 * **`message` is deliberately NOT on this list.** It was, and that was too strict: §8.4
 * requires a budget breach to degrade "with a clear message — never a silent overspend",
 * and `message` is that clear message. Suppressing it would produce exactly the silence
 * the rule forbids. It belongs in the system region, never inside an answer — which is
 * the distinction `copilotShowsAnswer` draws.
 */
export const COPILOT_OPERATOR_ONLY_FIELDS: readonly string[] = ['usage'];
