import '@/lib/server/only';
/**
 * WHERE THE TEST SUITE'S DATABASE COMES FROM — and, more importantly, where it refuses to
 * come from.
 *
 * Two engines, one set of SQL:
 *
 *   PGLITE    (default) Real PostgreSQL compiled to WebAssembly, in-process, no daemon and
 *             no Docker. This is what runs on a developer machine. It is genuine
 *             PostgreSQL — roles, GRANT/REVOKE, RLS and policies all behave as PostgreSQL
 *             behaves, which is the entire reason it is trustworthy for these tests.
 *
 *   POSTGRES  A real PostgreSQL server, used when DATABASE_URL is set. This is what CI
 *             runs, against a throwaway service container. It exists so that every claim
 *             the WASM engine makes is re-checked on a normal server build, and so the
 *             suite cannot quietly come to depend on a PGlite quirk.
 *
 * THE REFUSAL, which matters more than either engine.
 *
 * These tests create tenants, employees, bills and audit rows, and several of them delete
 * everything they can reach in order to prove that they cannot. Pointed at a real customer
 * database that would be a catastrophe, so pointing it at one is made structurally hard
 * rather than merely discouraged:
 *
 *   1. The default is PGlite — an in-memory database that did not exist a moment ago and
 *      will not exist a moment later. Doing nothing is safe.
 *   2. Any DATABASE_URL whose host matches a configured PRODUCTION_SUPABASE_URL is refused.
 *      Following `scripts/parity-env.mjs`, this makes the refusal structural rather than a
 *      judgement call: the deployment's own configuration is what identifies production.
 *   3. Any hosted Supabase URL is refused by default, because a `*.supabase.co` host is by
 *      definition somebody's real project rather than a throwaway.
 *   4. The refusal in (3) lifts only for an explicit, deliberate confirmation variable.
 *      There is no flag that lifts (2).
 */

export interface EnvLike { readonly [key: string]: string | undefined }

export type TestDatabaseTarget =
  | { readonly kind: 'PGLITE' }
  | { readonly kind: 'POSTGRES'; readonly connectionString: string; readonly host: string };

/** Names in one place, so a reader can see the whole contract at once. */
export const DB_ENV_NAMES = {
  /** Set to run the suite against a real PostgreSQL server instead of PGlite. */
  url: 'DATABASE_URL',
  /** The deployment's own production configuration. Never a target; only ever a veto. */
  forbiddenUrls: ['PRODUCTION_SUPABASE_URL', 'PRODUCTION_DATABASE_URL'],
  /** Lifts the hosted-Supabase refusal only. Cannot lift a production-host match. */
  confirmation: 'DATABASE_TEST_CONFIRMED_NOT_PRODUCTION',
} as const;

export class UnsafeTestDatabaseError extends Error {
  override readonly name = 'UnsafeTestDatabaseError';
}

/** Host and port, for telling an operator which target was refused. */
export function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).host || '(no host)';
  } catch {
    // A malformed URL must not fall through to "looks fine". Callers treat this as unusable.
    return '(unparseable)';
  }
}

/**
 * Hostname WITHOUT the port, which is what every comparison below uses.
 *
 * The distinction is the whole guard. A production setting is normally written as
 * `https://db.example.com` while a connection string carries `db.example.com:5432` — so
 * comparing `host` to `host` finds no match, the refusal never fires, and the suite
 * cheerfully connects to production. Compared as hostnames they are the same machine,
 * which is the only question being asked.
 */
export function hostnameOf(connectionString: string): string {
  try {
    return (new URL(connectionString).hostname || '(no host)').toLowerCase();
  } catch {
    return '(unparseable)';
  }
}

/**
 * Redact a connection string down to something safe to print.
 *
 * Used in every error message this module produces, because the moment a connection string
 * appears in a failed assertion it is in the CI log, and CI logs outlive the run.
 */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    // The password is the obvious secret; the username is worth withholding too, since it
    // is half of a credential pair and identifies the project on hosted Supabase.
    url.username = url.username ? '***' : '';
    url.password = url.password ? '***' : '';
    return url.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

const HOSTED_SUPABASE = /(^|\.)supabase\.(co|com|in|net)$/i;

/**
 * Decide what the suite may connect to, or refuse.
 *
 * Pure, and takes the environment as an argument, so the refusals themselves are testable
 * without setting real environment variables in the test process.
 */
export function resolveTestDatabase(env: EnvLike): TestDatabaseTarget {
  const raw = (env[DB_ENV_NAMES.url] ?? '').trim();
  if (raw === '') return { kind: 'PGLITE' };

  const host = hostOf(raw);
  const hostname = hostnameOf(raw);
  if (host === '(unparseable)') {
    throw new UnsafeTestDatabaseError(
      `${DB_ENV_NAMES.url} is not a URL this runner can parse, so it cannot be checked `
      + 'against the production configuration. Refusing to connect to something unidentified.',
    );
  }

  // (2) The deployment's own production settings veto, and nothing lifts this.
  for (const name of DB_ENV_NAMES.forbiddenUrls) {
    const forbidden = (env[name] ?? '').trim();
    if (forbidden === '') continue;
    if (hostnameOf(forbidden) === hostname) {
      throw new UnsafeTestDatabaseError(
        `${DB_ENV_NAMES.url} points at ${host}, which is the host configured in ${name}. `
        + 'That is the production database. This suite creates and deletes rows; it will '
        + 'not run there, and no flag overrides this.',
      );
    }
  }

  // (3) A hosted project belongs to somebody, throwaway or not.
  if (HOSTED_SUPABASE.test(hostname) && (env[DB_ENV_NAMES.confirmation] ?? '').trim() === '') {
    throw new UnsafeTestDatabaseError(
      `${DB_ENV_NAMES.url} points at the hosted Supabase project ${host}. This suite writes `
      + `and deletes rows. If that project is genuinely disposable, set `
      + `${DB_ENV_NAMES.confirmation}=yes to say so explicitly. Prefer a local container.`,
    );
  }

  return { kind: 'POSTGRES', connectionString: raw, host };
}
