import '@/lib/server/only';
/**
 * WHICH ENVIRONMENT A TOOL OR TEST IS ABOUT TO TOUCH.
 *
 * M-INFRA-1 gave the database tooling a two-way answer — in-memory or a real server — and a
 * refusal for production. A hosted Supabase project needs a finer one, because "a real
 * server" now covers a throwaway container in CI and somebody's actual staging project, and
 * those deserve different treatment.
 *
 *   LOCAL       PGlite, or a PostgreSQL on localhost. Disposable by construction.
 *   TEST        A throwaway server that is not localhost — a CI service container.
 *   STAGING     A hosted Supabase project explicitly declared as staging.
 *   PRODUCTION  The host named in the deployment's own production configuration.
 *
 * THE ASYMMETRY IS DELIBERATE. Classification is generous about calling something
 * PRODUCTION and stingy about calling anything STAGING:
 *
 *   - A host matching a `PRODUCTION_*` setting is PRODUCTION, full stop, and no flag lifts
 *     it. The deployment's own configuration is what identifies production, so the refusal
 *     is structural rather than a judgement call (the same stance `scripts/parity-env.mjs`
 *     takes about the production workbook).
 *   - A hosted Supabase project is only STAGING when somebody has said so explicitly. An
 *     unlabelled `*.supabase.co` host is UNKNOWN, and UNKNOWN is refused. Guessing "this
 *     looks like staging" is exactly the guess that ends with a test suite deleting rows
 *     from a real customer's database.
 *
 * This module classifies and explains. It does not connect to anything.
 */

export interface EnvLike { readonly [key: string]: string | undefined }

export type EnvironmentKind = 'LOCAL' | 'TEST' | 'STAGING' | 'PRODUCTION' | 'UNKNOWN';

export interface TargetClassification {
  readonly kind: EnvironmentKind;
  /** Host and port. Never a credential — this string reaches logs and assertions. */
  readonly host: string;
  /** Why it was classified this way, in a sentence an operator can act on. */
  readonly because: string;
  /** Whether a suite that creates and deletes rows may run here. */
  readonly writable: boolean;
}

/** Names in one place, so the whole contract is readable at a glance. */
export const STAGING_ENV_NAMES = {
  /** The staging project's URL. Its presence is what makes STAGING claimable at all. */
  url: 'STAGING_SUPABASE_URL',
  /** Publishable key. Safe to hold; it is the key a browser would carry. */
  anonKey: 'STAGING_SUPABASE_ANON_KEY',
  /** Trusted server key. Never reaches a browser, never printed, never committed. */
  serviceRoleKey: 'STAGING_SUPABASE_SERVICE_ROLE_KEY',
  /**
   * The explicit declaration that the project above is disposable. Required, because a
   * hosted project that nobody has vouched for is somebody's real data.
   */
  confirmation: 'STAGING_CONFIRMED_NOT_PRODUCTION',
  /** Direct PostgreSQL connection, for migrations and catalog inspection. */
  databaseUrl: 'STAGING_DATABASE_URL',
} as const;

/** The deployment's own production settings. Only ever a veto, never a target. */
export const PRODUCTION_ENV_NAMES = [
  'PRODUCTION_SUPABASE_URL',
  'PRODUCTION_DATABASE_URL',
] as const;

export function hostnameOf(url: string): string {
  try {
    return (new URL(url).hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || '(no host)';
  } catch {
    return '(unparseable)';
  }
}

const HOSTED_SUPABASE = /(^|\.)supabase\.(co|com|in|net)$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

/**
 * Classify a URL against the environment it was read from.
 *
 * Order matters and is the security property: PRODUCTION is decided before anything else,
 * so a host that is both named in `PRODUCTION_SUPABASE_URL` and confirmed as staging is
 * still PRODUCTION. A contradiction resolves to the safe reading, not the convenient one.
 */
export function classifyTarget(url: string, env: EnvLike): TargetClassification {
  const host = hostOf(url);
  const hostname = hostnameOf(url);

  if (hostname === '') {
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: 'The URL could not be parsed, so it cannot be checked against the production '
        + 'configuration. Something unidentified is not something to write to.',
    };
  }

  for (const name of PRODUCTION_ENV_NAMES) {
    const configured = (env[name] ?? '').trim();
    if (configured !== '' && hostnameOf(configured) === hostname) {
      return {
        kind: 'PRODUCTION', host, writable: false,
        because: `${host} is the host configured in ${name}. Nothing overrides this.`,
      };
    }
  }

  if (LOCAL_HOSTS.has(hostname)) {
    return {
      kind: 'LOCAL', host, writable: true,
      because: `${host} is a loopback address — a database on this machine.`,
    };
  }

  if (HOSTED_SUPABASE.test(hostname)) {
    const declared = (env[STAGING_ENV_NAMES.url] ?? '').trim();
    const isDeclared = declared !== '' && hostnameOf(declared) === hostname;
    const confirmed = (env[STAGING_ENV_NAMES.confirmation] ?? '').trim() !== '';

    if (isDeclared && confirmed) {
      return {
        kind: 'STAGING', host, writable: true,
        because: `${host} is declared in ${STAGING_ENV_NAMES.url} and confirmed disposable `
          + `by ${STAGING_ENV_NAMES.confirmation}.`,
      };
    }
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: `${host} is a hosted Supabase project that has not been declared as staging. `
        + `Set ${STAGING_ENV_NAMES.url} to it and ${STAGING_ENV_NAMES.confirmation} to say `
        + 'it is disposable. An unlabelled hosted project is somebody\'s real data.',
    };
  }

  // A named host that is neither loopback nor hosted Supabase: a CI service container
  // reached by service name, a VM, a tunnel. Writable, but say which it is.
  return {
    kind: 'TEST', host, writable: true,
    because: `${host} is neither a loopback address, a hosted Supabase project, nor the `
      + 'configured production host.',
  };
}

export type StagingAvailability =
  | { readonly available: true; readonly url: string; readonly anonKey: string;
      readonly serviceRoleKey: string; readonly databaseUrl: string | null;
      readonly classification: TargetClassification }
  /** Not configured. This is a legitimate outcome, never a failure and never a pass. */
  | { readonly available: false; readonly reason: 'CONFIGURATION_REQUIRED';
      readonly missing: readonly string[] }
  /** Configured, but pointing somewhere it must not. This IS a failure. */
  | { readonly available: false; readonly reason: 'REFUSED';
      readonly classification: TargetClassification };

/**
 * Whether a real staging suite may run, and against what.
 *
 * THREE OUTCOMES, kept distinct on purpose. A suite that cannot tell "nobody configured
 * this" from "this was refused" from "this failed" will eventually report one as another,
 * and the one that matters is a refusal reported as a pass.
 */
export function resolveStaging(env: EnvLike): StagingAvailability {
  const url = (env[STAGING_ENV_NAMES.url] ?? '').trim();
  const anonKey = (env[STAGING_ENV_NAMES.anonKey] ?? '').trim();
  const serviceRoleKey = (env[STAGING_ENV_NAMES.serviceRoleKey] ?? '').trim();
  const confirmation = (env[STAGING_ENV_NAMES.confirmation] ?? '').trim();

  const missing = [
    ...(url === '' ? [STAGING_ENV_NAMES.url] : []),
    ...(anonKey === '' ? [STAGING_ENV_NAMES.anonKey] : []),
    ...(serviceRoleKey === '' ? [STAGING_ENV_NAMES.serviceRoleKey] : []),
    ...(confirmation === '' ? [STAGING_ENV_NAMES.confirmation] : []),
  ];
  if (missing.length > 0) return { available: false, reason: 'CONFIGURATION_REQUIRED', missing };

  const classification = classifyTarget(url, env);
  if (classification.kind !== 'STAGING' || !classification.writable) {
    return { available: false, reason: 'REFUSED', classification };
  }

  return {
    available: true,
    url,
    anonKey,
    serviceRoleKey,
    databaseUrl: (env[STAGING_ENV_NAMES.databaseUrl] ?? '').trim() || null,
    classification,
  };
}

/**
 * A one-line description safe to print anywhere.
 *
 * Deliberately mentions the KEYS only by whether they are present. A length would narrow a
 * brute-force search; a prefix would identify the project. Neither is worth the diagnostic.
 */
export function describeStaging(result: StagingAvailability): string {
  if (result.available) {
    return `STAGING ${result.classification.host} — anon key present, service key present`
      + `${result.databaseUrl ? ', direct database URL present' : ', no direct database URL'}`;
  }
  if (result.reason === 'CONFIGURATION_REQUIRED') {
    return `CONFIGURATION_REQUIRED — not set: ${result.missing.join(', ')}`;
  }
  return `REFUSED — ${result.classification.kind}: ${result.classification.because}`;
}
