import '@/lib/server/only';
/**
 * DEMO STATE — the scenario, the working dataset, and the reset.
 *
 * The dataset is generated deterministically from seed, so "reset" is genuinely a return
 * to a known state rather than a best-effort cleanup: discard the working copy, rebuild
 * from the generator, and everything a demonstration did is gone.
 *
 * State lives in the server process. That is a deliberate limit, not an oversight — demo
 * state is demonstration scaffolding and has no business being persisted anywhere near a
 * database that also holds identity or audit records. A restart resets the demo, which is
 * the correct behaviour for a demonstration environment.
 *
 * **Every mutating operation here is demo-only.** Not by convention: `assertDemoOnly`
 * throws in production, and the tests prove production refuses each one.
 */
import {
  buildDemoDataset, DEMO_MARKER, type DemoDataset,
} from '@/lib/data/demo/dataset';
import {
  DEFAULT_DEMO_SCENARIO, isDemoScenario, type DemoScenario,
} from '@/lib/shared/environment';
import {
  resolveEnvironment, assertDemoOnly, DemoOnlyOperationError, type ResolvedEnvironment,
} from '@/lib/server/environment/config';

/** A change a demonstration made to the working dataset, and can undo by resetting. */
export interface DemoMutation {
  at: string;
  kind: 'guest-request' | 'scenario-change';
  detail: string;
}

/**
 * Presentation mode.
 *
 * A demonstration is given in front of people, often on a shared screen, and often with
 * someone else driving. Presentation mode removes the one control that could embarrass
 * that: the reset. It is a **convenience for the presenter, not a security boundary** —
 * RBAC and the environment guard remain authoritative and are checked regardless.
 *
 * `resetEnabled` is the deliberate escape hatch: an admin can switch the reset back on
 * without leaving presentation mode, which is what "unless explicitly enabled through
 * admin" means in practice.
 */
export interface PresentationState {
  active: boolean;
  /** Whether the reset control is available while presentation mode is on. */
  resetEnabled: boolean;
}

interface DemoState {
  scenario: DemoScenario;
  dataset: DemoDataset;
  mutations: DemoMutation[];
  /** When the working copy was last rebuilt from seed. */
  seededAt: string;
  presentation: PresentationState;
}

let state: DemoState | null = null;

function freshState(
  scenario: DemoScenario,
  now: Date,
  presentation: PresentationState = { active: false, resetEnabled: true },
): DemoState {
  return {
    scenario,
    dataset: buildDemoDataset(scenario),
    mutations: [],
    seededAt: now.toISOString(),
    // Presentation mode survives a reset. Losing it mid-demonstration — the moment someone
    // has just reset the data in front of an audience — is exactly the wrong time.
    presentation,
  };
}

function ensure(now: Date): DemoState {
  if (!state) state = freshState(DEFAULT_DEMO_SCENARIO, now);
  return state;
}

/* ------------------------------------------------------------------ *
 * Reads — permitted in any environment, because they answer "is there
 * demo state?" and the honest answer in production is "no".
 * ------------------------------------------------------------------ */

export function currentScenario(resolved: ResolvedEnvironment = resolveEnvironment()): DemoScenario | null {
  if (!resolved.demoControlsPermitted) return null;
  return ensure(new Date()).scenario;
}

export function currentDataset(now: Date = new Date()): DemoDataset {
  return ensure(now).dataset;
}

export interface DemoStatus {
  scenario: DemoScenario;
  seededAt: string;
  mutations: number;
  marker: string;
  today: string;
  highlights: string[];
  presentation: PresentationState;
}

export function demoStatus(now: Date = new Date()): DemoStatus {
  const current = ensure(now);
  return {
    scenario: current.scenario,
    seededAt: current.seededAt,
    mutations: current.mutations.length,
    marker: current.dataset.marker,
    today: current.dataset.today,
    highlights: current.dataset.highlights,
    presentation: { ...current.presentation },
  };
}

/**
 * Whether the reset may be offered right now.
 *
 * Presentation mode with the reset switched off is the only state that hides it. The
 * server checks this too — a hidden control that still works when posted to is not hidden,
 * it is merely invisible.
 */
export function resetAvailable(now: Date = new Date()): boolean {
  const current = ensure(now);
  return !current.presentation.active || current.presentation.resetEnabled;
}

export class PresentationModeError extends Error {
  constructor() {
    super(
      'The demo reset is switched off while presentation mode is active. ' +
      'Turn it back on from Demonstration controls, or leave presentation mode.',
    );
    this.name = 'PresentationModeError';
  }
}

export const PRESENTATION_OPERATION = 'Change presentation mode';

/** Demo only, like every other control here. */
export function setPresentationMode(
  next: Partial<PresentationState>,
  options: { resolved?: ResolvedEnvironment; now?: Date } = {},
): DemoStatus {
  const resolved = options.resolved ?? resolveEnvironment();
  assertDemoOnly(PRESENTATION_OPERATION, resolved);

  const now = options.now ?? new Date();
  const current = ensure(now);
  current.presentation = { ...current.presentation, ...next };
  return demoStatus(now);
}

/* ------------------------------------------------------------------ *
 * Writes — demo only, every one of them
 * ------------------------------------------------------------------ */

export const SCENARIO_SWITCH_OPERATION = 'Switch demo scenario';
export const DEMO_RESET_OPERATION = 'Reset demo environment';

/**
 * Change the active scenario.
 *
 * Rebuilds the dataset, because a scenario is a different day in the trading year and the
 * operational records that go with it — not a display filter over the same numbers.
 */
export function setScenario(
  scenario: string,
  options: { resolved?: ResolvedEnvironment; now?: Date } = {},
): DemoStatus {
  const resolved = options.resolved ?? resolveEnvironment();
  assertDemoOnly(SCENARIO_SWITCH_OPERATION, resolved);

  if (!isDemoScenario(scenario)) {
    throw new Error(`Unknown demo scenario: ${scenario}`);
  }
  const now = options.now ?? new Date();
  const previous = ensure(now).scenario;

  state = freshState(scenario, now, ensure(now).presentation);
  state.mutations.push({
    at: now.toISOString(),
    kind: 'scenario-change',
    detail: `${previous} → ${scenario}`,
  });
  return demoStatus(now);
}

export interface DemoResetResult {
  scenario: DemoScenario;
  seededAt: string;
  /** What the reset actually undid, so the confirmation can be specific. */
  discardedMutations: number;
  marker: string;
}

/**
 * Reset the demonstration environment.
 *
 * Discards the working dataset and rebuilds it from seed: transactional records return to
 * their seeded state, the scenario returns to NORMAL_DAY, investor figures return to their
 * seeded values, and any demonstration-created records (guest requests, scenario changes)
 * are gone.
 *
 * There is no production equivalent and there will not be one. This resets fictional data;
 * the same operation against a real workbook would be a destructive act with no legitimate
 * purpose, which is why the guard is an environment check rather than a permission.
 */
export function resetDemoEnvironment(
  options: { resolved?: ResolvedEnvironment; now?: Date } = {},
): DemoResetResult {
  const resolved = options.resolved ?? resolveEnvironment();
  assertDemoOnly(DEMO_RESET_OPERATION, resolved);

  const now = options.now ?? new Date();
  const current = ensure(now);
  const discarded = current.mutations.length;

  // Second stop: the control is hidden in presentation mode, and refused if posted anyway.
  if (!resetAvailable(now)) throw new PresentationModeError();

  state = freshState(DEFAULT_DEMO_SCENARIO, now, current.presentation);

  return {
    scenario: state.scenario,
    seededAt: state.seededAt,
    discardedMutations: discarded,
    marker: DEMO_MARKER,
  };
}

/**
 * Record a guest request raised during the demo guest journey, so it appears in the
 * operations queue exactly as a real one would.
 */
export function recordDemoGuestRequest(
  request: { requestId: string; propertyId: string; summary: string },
  options: { resolved?: ResolvedEnvironment; now?: Date } = {},
): void {
  const resolved = options.resolved ?? resolveEnvironment();
  assertDemoOnly('Raise demo guest request', resolved);

  const now = options.now ?? new Date();
  const current = ensure(now);
  const alreadyPresent = current.dataset.ops.guestRequests
    .some((r) => r.requestId === request.requestId);
  if (!alreadyPresent) {
    current.dataset.ops.guestRequests.push({
      ...request,
      raisedOn: current.dataset.today,
      status: 'Open',
    });
  }
  current.mutations.push({
    at: now.toISOString(),
    kind: 'guest-request',
    detail: `${request.requestId} · ${request.propertyId}`,
  });
}

/** Test seam: forget all demo state. */
export function __resetDemoStoreForTests(): void {
  state = null;
}

export { DemoOnlyOperationError };
