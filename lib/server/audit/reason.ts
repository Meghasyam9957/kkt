import '@/lib/server/only';
/**
 * WHAT A FAILURE IS ALLOWED TO SAY, ONCE IT IS WRITTEN DOWN.
 *
 * An audit `reason` and an operation ledger's `error` are the two strings this application
 * PERSISTS about a failure, and the ledger's is handed back to the browser by
 * `GET /api/operations-log/:id`. Both were, until now, whatever `Error.message` happened to
 * contain.
 *
 * That was survivable while the database was a stub. Against real Supabase it is not: the
 * repositories rethrow `PostgrestError.message` verbatim, so the string is PostgreSQL's own
 * — naming the relation, the column, the constraint, sometimes the failing row. Stored
 * forever in the audit trail, and rendered on screen. Nobody chose that; it is simply what
 * a default `Error.message` does when the layer beneath it starts being real.
 *
 * THE RULE HERE IS ALLOW-LIST, NOT DENY-LIST.
 *
 * A message is kept only when this application WROTE it — the refusals in the domain error
 * classes are deliberate, reviewed sentences meant for a person ("Operations may not record
 * a payment", "lacks capability finance.write"). Everything else is replaced by a code that
 * says what kind of failure it was and nothing about its internals.
 *
 * Blocking a list of dangerous-looking patterns would be the other way round, and it would
 * be wrong: it assumes we can enumerate every shape a leak takes, and every new upstream —
 * a driver, a provider, a proxy — invents one nobody predicted. Keeping only what we
 * authored needs no such prediction.
 *
 * The full error is still available where it belongs: `console.error` on the server, which
 * the operator can read and the browser cannot.
 */

/** Bounded to the same 512 characters `redactMetadata` allows any stored string. */
const MAX_REASON = 512;

/**
 * Error classes whose `message` this repository authored on purpose.
 *
 * Matched on `name` rather than `instanceof` deliberately: these are thrown across module
 * boundaries and sometimes rebuilt from a serialised shape, so an identity check would
 * silently start failing closed — replacing good, reviewed refusal text with a bare code
 * and making every refusal in the product less useful. The name is what survives.
 */
const AUTHORED: ReadonlySet<string> = new Set([
  'AuthenticationError',
  'AuthorizationError',
  'MutationError',
  'HrError',
  'FinanceError',
  'OperationsError',
  'MissingTenantError',
  'CacheTenantError',
  'CacheIdentityError',
  'TenantWorkbookNotConfiguredError',
  'TenantWorkbookSuspendedError',
  'RegistryUnavailableError',
  'UnsafeTestDatabaseError',
  'AiNotEnabledError',
  'AiFeatureDisabledError',
  'AiEnvironmentMismatchError',
  'AiRateLimiterNotPermittedError',
  'CopilotNotPermittedError',
  'AuthNotConfiguredError',
  'OpenAiKeyMissingError',
]);

/**
 * Codes for the kinds of failure that are NOT ours to describe.
 *
 * Deliberately coarse. A finer taxonomy would have to be derived from the upstream message,
 * which is the thing being withheld — so the classification is made from the error's own
 * name and shape, never from its text.
 */
export type ReasonCode =
  | 'DATABASE_ERROR'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

function classify(error: { name?: string; code?: unknown }): ReasonCode {
  const name = error.name ?? '';
  const code = typeof error.code === 'string' ? error.code : '';

  // PostgREST and node-postgres both surface five-character SQLSTATEs.
  if (/^[0-9A-Z]{5}$/.test(code)) return 'DATABASE_ERROR';
  if (name === 'PostgrestError' || name === 'DatabaseError') return 'DATABASE_ERROR';
  if (name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'TIMEOUT';
  if (name === 'TypeError' || name === 'FetchError'
    || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
    return 'UPSTREAM_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * The string that may be persisted and shown.
 *
 * Returns the authored message for an error this application raised on purpose, and a bare
 * code for anything else. Never returns an upstream message, and never returns undefined —
 * a failure with no reason recorded is worse than one recorded as INTERNAL_ERROR.
 */
export function safeReason(error: unknown): string {
  if (error === null || error === undefined) return 'INTERNAL_ERROR';

  if (typeof error === 'object') {
    const shaped = error as { name?: string; message?: unknown; code?: unknown };
    if (typeof shaped.name === 'string' && AUTHORED.has(shaped.name)
      && typeof shaped.message === 'string') {
      return bound(shaped.message);
    }
    return classify(shaped);
  }

  // A thrown string is not an authored refusal — it is whatever a library felt like.
  return 'INTERNAL_ERROR';
}

/**
 * A last line of defence for a reason that is ALREADY a string.
 *
 * The audit sink applies this to whatever it is handed, so a future call site that forgets
 * `safeReason` still cannot store an unbounded blob or a credential-bearing URL. It does not
 * replace the allow-list above; it bounds what gets past it.
 */
export function boundReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  return bound(reason);
}

function bound(text: string): string {
  const withoutUrls = text
    // A URL in a diagnostic is the one shape that can carry a credential outright
    // (postgres://user:pass@host). Replaced wholesale rather than parsed.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    // Long opaque tokens: JWTs and API keys. Three base64url segments, or a long run.
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[token]')
    .replace(/\b(?:sk|eyJ|sbp)_[A-Za-z0-9_-]{16,}\b/g, '[token]');

  const collapsed = withoutUrls.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_REASON
    ? `${collapsed.slice(0, MAX_REASON - 1)}…`
    : collapsed;
}
