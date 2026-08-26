import '@/lib/server/only';
/**
 * AI RATE LIMITING — the seam, and nothing else.
 *
 * ARCHITECTURE §8.4 requires rate limits on AI: per user and per role. It does not say
 * what they are. No number appears in §8, none appears in §13's questions, and none has
 * been approved — so none is written here, and none is read from the environment either,
 * because naming a variable like `AI_MAX_CALLS_PER_HOUR` would already have chosen the
 * window even with the value left blank.
 *
 * What exists is the interface a real limiter will implement, and one implementation that
 * enforces nothing and says so. The distinction between "no limiter" and "a limiter with
 * generous settings" is the whole point: a deployment must be able to tell which of those
 * it is running, and `AiRateLimitState` is how it tells.
 *
 * The demo-only restriction is structural, not a comment. `UnenforcedAiRateLimiter`
 * refuses to be constructed in production, so an unlimited limiter cannot arrive there by
 * being the default anyone forgot to replace. Production is separately refused by
 * `aiProviderPermitted` with `NO_RATE_LIMIT_POLICY`; this is the second lock on the same
 * door, and it is here because the first one is a boolean somebody could pass wrongly.
 */
import type { AppEnv } from '@/lib/shared/environment';
import type { Role } from '@/lib/shared/roles';
import type { AiFeature } from '@/lib/server/ai/guardrails';
import type { AiRateLimitState } from '@/lib/server/ai/config';

/** Who is asking, and for what. The three dimensions §8.4 names, and no more. */
export interface AiRateLimitRequest {
  /** The Supabase user id of the person asking. */
  userId: string;
  role: Role;
  feature: AiFeature;
}

export interface AiRateLimitDecision {
  allowed: boolean;
  /**
   * Why not, when not. A code rather than a sentence, matching every other refusal in
   * this module tree — §8 specifies no user-facing wording for any of them.
   */
  reason: 'RATE_LIMITED' | null;
  /**
   * What the limiter is doing, carried on every decision so a caller cannot mistake
   * "allowed because you are within the limit" for "allowed because nothing is counting".
   */
  state: AiRateLimitState;
}

export interface AiRateLimiter {
  /** Stable identifier for logs and tests. */
  readonly id: string;
  /** `'none'` when this limiter enforces nothing. Never claimed falsely. */
  readonly state: AiRateLimitState;
  check(request: AiRateLimitRequest): Promise<AiRateLimitDecision>;
}

export class AiRateLimiterNotPermittedError extends Error {
  constructor() {
    super(
      'An unenforced AI rate limiter is a demonstration-only state and cannot be used in '
      + 'production. ARCHITECTURE §8.4 requires per-user and per-role limits; none has been '
      + 'specified, so production AI stays disabled until one is.',
    );
    this.name = 'AiRateLimiterNotPermittedError';
  }
}

/**
 * The limiter for a demonstration: it allows everything and reports `'none'`.
 *
 * Honest rather than convenient. A demo runs for a handful of invited people against a
 * small explicit cap that is checked before every call, so the cap is the control and the
 * absence of a limiter is a known, bounded gap. Production has neither of those
 * conditions, which is why this refuses to exist there.
 */
export class UnenforcedAiRateLimiter implements AiRateLimiter {
  readonly id = 'unenforced';
  readonly state: AiRateLimitState = 'none';

  constructor(appEnv: AppEnv) {
    if (appEnv === 'production') throw new AiRateLimiterNotPermittedError();
  }

  async check(_request: AiRateLimitRequest): Promise<AiRateLimitDecision> {
    void _request;
    return { allowed: true, reason: null, state: 'none' };
  }
}

/**
 * What this deployment has.
 *
 * Demo gets the unenforced limiter. Production gets nothing — deliberately `null` rather
 * than a permissive stand-in, so the type system makes a caller confront the absence
 * instead of inheriting a limiter that would have let everything through.
 */
export function aiRateLimiterFor(appEnv: AppEnv): AiRateLimiter | null {
  return appEnv === 'production' ? null : new UnenforcedAiRateLimiter(appEnv);
}

/** The state to hand `aiProviderPermitted`. No limiter and an unenforced one are both `'none'`. */
export function aiRateLimitState(limiter: AiRateLimiter | null): AiRateLimitState {
  return limiter?.state ?? 'none';
}
