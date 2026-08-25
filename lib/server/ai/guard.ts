import '@/lib/server/only';
/**
 * AI ENVIRONMENT GUARD.
 *
 * No AI is integrated in this phase, no model is called and no API key is read anywhere in
 * this codebase. What exists here is the seam a future integration must pass through, and
 * the invariant it must satisfy:
 *
 *   **A payload built in one environment can never be sent to the other environment's AI.**
 *
 * Building the guard before the feature is deliberate. The moment an AI integration lands,
 * the interesting question is not "does it work" but "can demonstration data reach a
 * production model, or production data reach a demonstration one" — and that question is
 * far easier to answer correctly now, while the answer is still free.
 *
 * Every payload is stamped with the environment that produced it at construction time. The
 * stamp is not a parameter a caller chooses; it comes from the same server-side resolution
 * that decides which workbook was read, so a payload cannot claim an environment it did not
 * come from.
 */
import {
  resolveEnvironment, type ResolvedEnvironment,
} from '@/lib/server/environment/config';
import { resolveAiConfig, aiProviderPermitted, aiProductionApproved } from '@/lib/server/ai/config';
import type { AppEnv } from '@/lib/shared/environment';

/** Anything destined for a model carries where it came from. */
export interface AiPayload<T = unknown> {
  /** Stamped at construction from the resolved environment. Never caller-supplied. */
  readonly environment: AppEnv;
  /** True when the contents are fictional demonstration data. */
  readonly demo: boolean;
  readonly createdAt: string;
  readonly contents: T;
}

export class AiEnvironmentMismatchError extends Error {
  constructor(payloadEnv: AppEnv, targetEnv: AppEnv) {
    super(
      `Refusing to send a ${payloadEnv} payload to the ${targetEnv} AI configuration. ` +
      'Demonstration data must never reach a production model, and production data must ' +
      'never reach a demonstration one.',
    );
    this.name = 'AiEnvironmentMismatchError';
  }
}

export class AiNotEnabledError extends Error {
  constructor() {
    super(
      'AI is not enabled in this phase. No model is configured, no key is read, and no ' +
      'request is made. The guard exists so the integration cannot arrive without one.',
    );
    this.name = 'AiNotEnabledError';
  }
}

/**
 * Build a payload, stamped with the environment that produced it.
 *
 * The stamp comes from server-side resolution, not from an argument — a caller cannot
 * label demonstration data as production, or the reverse.
 */
export function buildAiPayload<T>(
  contents: T,
  options: { resolved?: ResolvedEnvironment; now?: Date } = {},
): AiPayload<T> {
  const resolved = options.resolved ?? resolveEnvironment();
  return {
    environment: resolved.env,
    demo: resolved.env === 'demo',
    createdAt: (options.now ?? new Date()).toISOString(),
    contents,
  };
}

/**
 * Assert a payload may be sent to the AI configuration of the active environment.
 *
 * Called immediately before any dispatch. It throws on mismatch rather than dropping the
 * payload silently, because a silently discarded prompt looks like a broken feature while a
 * silently *delivered* one is a data leak.
 */
export function assertAiPayloadEnvironment(
  payload: AiPayload,
  options: { resolved?: ResolvedEnvironment } = {},
): void {
  const resolved = options.resolved ?? resolveEnvironment();
  if (payload.environment !== resolved.env) {
    throw new AiEnvironmentMismatchError(payload.environment, resolved.env);
  }
}

/**
 * Whether a real AI integration is configured AND permitted in this environment.
 *
 * It used to be a hard-coded `false`, on the grounds that nothing read a key so nothing
 * could be configured. A provider exists now, so this asks the configuration instead —
 * and the answer is still `false` everywhere nothing is set up, which is every deployment
 * that has not deliberately turned it on.
 *
 * Every clause behind it is an absence rather than a default: no enable flag, no provider,
 * no key, no model, no pricing, no cap, mismatched currencies, or nowhere to keep a
 * running total of spend. `aiProviderPermitted` names which one refused.
 *
 * It never throws. A misconfigured environment must read as "AI is off", not as an
 * exception thrown from inside a usage sink — the safe direction for a gate is closed.
 */
export function aiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const resolved = resolveEnvironment(env);
    const config = resolveAiConfig(env, resolved.prefix);
    return aiProviderPermitted(config, resolved.env, aiProductionApproved(env, resolved.prefix)).permitted;
  } catch {
    return false;
  }
}

/** The dispatch point. It refuses, on purpose, and will keep refusing until Phase 9. */
export function dispatchToAi(payload: AiPayload, options: { resolved?: ResolvedEnvironment } = {}): never {
  // Environment check first: a mismatched payload is a bug worth surfacing even while the
  // feature is switched off, because it means the caller built it in the wrong place.
  assertAiPayloadEnvironment(payload, options);
  throw new AiNotEnabledError();
}
