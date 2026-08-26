/**
 * COPILOT VIEW STATES — what an interface has to be able to show, before it shows it.
 *
 * The copilot page is deliberately inert: no request is sent, no answer is rendered, and
 * it stays that way until an authorised credential, an approved model and an approved
 * budget exist in DEMO/UAT. This module is the part that can be settled now — the set of
 * outcomes a connected composer must handle, derived from the server contract rather than
 * guessed at later by whoever wires the fetch.
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
 * Fields on a copilot answer that exist for an operator and must never be rendered as
 * part of the conversation.
 *
 * `message` carries §8.4's clear-message text for whoever is running the deployment, and
 * can quote a classified provider failure; `usage` is the §8.4 log line, including model
 * and cost. Neither is a secret — the security suite proves no credential can reach
 * either — but neither is an answer, and a composer that printed them would be reporting
 * infrastructure to a person who asked about occupancy.
 */
export const COPILOT_OPERATOR_ONLY_FIELDS: readonly string[] = ['message', 'usage'];
