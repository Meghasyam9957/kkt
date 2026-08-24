import '@/lib/server/only';
/**
 * PROCESS-WIDE STATE that survives module re-evaluation.
 *
 * `next dev` compiles routes on demand, and compiling a route it has not served before
 * re-evaluates the server module graph. Module-level `let` bindings are reinitialised
 * when that happens, so anything held in one silently reverts to its initial value —
 * mid-session, with no error and no log line.
 *
 * That is fatal for the demonstration environment specifically, because its workbook,
 * its operation ledger and its minted-id sequences live in memory by design. Measured
 * on this codebase: create an expense, visit three not-yet-compiled screens, and the
 * expense is gone — `/api/operations-log/<id>` went 200 → 404 and the row vanished from
 * the ledger. During a client demonstration that is a booking disappearing between the
 * screen that created it and the screen that should show it.
 *
 * Keying the state off `globalThis` fixes it: the object survives module re-evaluation
 * because it is not owned by any module. This is the standard Next.js remedy for the
 * same problem with database clients.
 *
 * In production this changes nothing observable — modules are evaluated once, so the
 * first `read` initialises exactly as a module-level binding would have. It is a
 * development-lifetime correction, not a new storage mechanism, and it deliberately
 * does NOT persist across process restarts: demonstration state is meant to be
 * disposable.
 */

/** Symbol.for so the slot is shared even if this module is itself re-evaluated. */
const SLOT = Symbol.for('srivillu.process-state');

type Bag = Record<string, unknown>;

function bag(): Bag {
  const g = globalThis as unknown as Record<symbol, Bag | undefined>;
  const existing = g[SLOT];
  if (existing) return existing;
  const created: Bag = {};
  g[SLOT] = created;
  return created;
}

/**
 * A named slot of process-wide state.
 *
 * Returned as an accessor pair rather than a value because these singletons are
 * reassigned — a demo reset replaces the dataset, tests drop the cached router — and a
 * plain value could not be rebound in the shared bag.
 */
export interface ProcessSlot<T> {
  read(): T | null;
  write(value: T | null): void;
}

export function processSlot<T>(name: string): ProcessSlot<T> {
  return {
    read: () => (bag()[name] ?? null) as T | null,
    write: (value: T | null) => { bag()[name] = value; },
  };
}

/** Tests only: forget every slot, so a case starts from a genuinely empty process. */
export function __clearProcessState(): void {
  const g = globalThis as unknown as Record<symbol, Bag | undefined>;
  g[SLOT] = {};
}
