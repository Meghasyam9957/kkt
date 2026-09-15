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
   * The explicit declaration that the project above is disposable: exactly `yes`. Required,
   * because a hosted project that nobody has vouched for is somebody's real data.
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

/** Lower-cased, without the one trailing dot DNS allows: `x.supabase.co.` is `x.supabase.co`. */
function normalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * The hostname a URL names, normalised — so a production setting written with a trailing dot
 * still vetoes a target written without one, and the other way round.
 */
export function hostnameOf(url: string): string {
  try {
    return normalHostname(new URL(url).hostname || '');
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
 * Whether the confirmation variable says yes. Exactly `yes`, in any case: a check for
 * "non-empty" would read `no`, `false` or a stray value as consent to write to a project.
 */
function confirmedDisposable(env: EnvLike): boolean {
  return (env[STAGING_ENV_NAMES.confirmation] ?? '').trim().toLowerCase() === 'yes';
}

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

    if (isDeclared && confirmedDisposable(env)) {
      return {
        kind: 'STAGING', host, writable: true,
        because: `${host} is declared in ${STAGING_ENV_NAMES.url} and confirmed disposable `
          + `by ${STAGING_ENV_NAMES.confirmation}.`,
      };
    }
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: `${host} is a hosted Supabase project that has not been declared as staging. `
        + `Set ${STAGING_ENV_NAMES.url} to it and ${STAGING_ENV_NAMES.confirmation} to yes to `
        + 'say it is disposable. An unlabelled hosted project is somebody\'s real data.',
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

/**
 * THE SUPABASE PROJECT A URL BELONGS TO — or null when it cannot be told.
 *
 * A project's API URL and its database connection strings do not share a hostname, so the
 * hostname comparison `classifyTarget` makes cannot tie one to the other:
 *
 *   API             https://<ref>.supabase.co
 *   direct          postgresql://postgres@db.<ref>.supabase.co:5432/postgres
 *   session pooler  postgresql://postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432/postgres
 *
 * A pooler hostname is shared by every project in its region; only the username names the
 * project. The project ref is the one identifier all three carry. Any other shape — a custom
 * domain, a self-hosted instance, something unparseable — is null, and null is refused.
 */
export function supabaseProjectRef(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = normalHostname(parsed.hostname);

  const api = hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (api) return api[1]!;

  const direct = hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (direct) return direct[1]!;

  if (/\.pooler\.supabase\.com$/.test(hostname)) {
    let user: string;
    try {
      user = decodeURIComponent(parsed.username).toLowerCase();
    } catch {
      return null;
    }
    const pooled = user.match(/^[a-z0-9_]+\.([a-z0-9]+)$/);
    return pooled ? pooled[1]! : null;
  }

  return null;
}

/**
 * Where a PostgreSQL driver will ACTUALLY connect, as it resolved a connection string.
 *
 * Not necessarily the host and username written in the URL. node-postgres, like libpq, lets
 * query parameters override both — `?host=` and `?user=` — so a string can name the staging
 * project in its userinfo and authenticate somewhere else entirely. The guard below is handed
 * what the driver resolved, not only what the string appears to say.
 */
export interface ResolvedConnection {
  readonly host: string;
  readonly user: string;
}

/**
 * Whether a DATABASE connection may be written to as the confirmed staging project — the
 * question `db:migrate -- --staging` asks before it opens a connection.
 *
 * Built on `classifyTarget`, and stricter than it, never looser. STAGING only when all of:
 *
 *   1. No PRODUCTION_* setting names the project ref or the hostname of either the string or
 *      the connection the driver resolved. Decided first, as everywhere in this module, and
 *      nothing lifts it. (A pooler hostname shared with a production pooler string is refused
 *      too: generous about PRODUCTION.)
 *   2. The driver resolved exactly the host and user the string names, and the string carries
 *      no `options` — a routing hint the pooler reads and the driver does not resolve. Anything
 *      that redirects the connection is refused, because everything below vouches for what is
 *      written.
 *   3. STAGING_SUPABASE_URL is itself STAGING — declared, and confirmed by
 *      STAGING_CONFIRMED_NOT_PRODUCTION=yes. That is the existing guard, reused, not a second.
 *   4. The connection belongs to that same project, by ref. Confirming one project is
 *      disposable says nothing about another.
 *
 * The explanation names the host, never the username: on the pooler the username carries the
 * project ref, and it is half of a credential pair.
 */
export function classifyStagingDatabase(
  databaseUrl: string, resolved: ResolvedConnection, env: EnvLike,
): TargetClassification {
  const host = hostOf(databaseUrl);
  const hostname = hostnameOf(databaseUrl);
  if (hostname === '') {
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: 'The database URL could not be parsed, so it cannot be checked against the '
        + 'staging or production configuration.',
    };
  }
  // Parses: `hostnameOf` has just parsed the same string.
  const written = new URL(databaseUrl);
  const ref = supabaseProjectRef(databaseUrl);
  const resolvedHostname = normalHostname(resolved.host);

  // The driver's destination, written back as a URL so it is read exactly as the string is.
  const resolvedUrl = `postgresql://${encodeURIComponent(resolved.user)}@${resolved.host}/`;
  const refs = [ref, supabaseProjectRef(resolvedUrl)].filter((r): r is string => r !== null);
  const hostnames = [hostname, resolvedHostname].filter((h) => h !== '');

  for (const name of PRODUCTION_ENV_NAMES) {
    const configured = (env[name] ?? '').trim();
    if (configured === '') continue;
    const productionRef = supabaseProjectRef(configured);
    const productionHostname = hostnameOf(configured);
    const sameProject = productionRef !== null && refs.includes(productionRef);
    if (sameProject || (productionHostname !== '' && hostnames.includes(productionHostname))) {
      return {
        kind: 'PRODUCTION', host, writable: false,
        because: `This connection reaches the ${sameProject ? 'Supabase project' : 'host'} `
          + `configured in ${name}. Nothing overrides this.`,
      };
    }
  }

  let writtenUser: string | null;
  try {
    writtenUser = decodeURIComponent(written.username);
  } catch {
    writtenUser = null;
  }
  if (resolvedHostname !== hostname || resolved.user !== writtenUser) {
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: 'The driver would connect with a different host or user than this connection '
        + 'string names — a query parameter such as ?host= or ?user= overrides them. The guard '
        + 'can only vouch for what the string names, so the string must not redirect it.',
    };
  }
  if (written.searchParams.has('options')) {
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: 'This connection string carries an options parameter. Supabase\'s pooler can '
        + 'read a project reference from it, which the driver does not resolve and this guard '
        + 'cannot check. A staging migration needs no options; remove it.',
    };
  }

  const declared = (env[STAGING_ENV_NAMES.url] ?? '').trim();
  if (declared === '') {
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: `${STAGING_ENV_NAMES.url} is not set, so there is no confirmed staging project `
        + 'for this connection string to belong to.',
    };
  }

  const project = classifyTarget(declared, env);
  if (project.kind !== 'STAGING' || !project.writable) {
    return {
      kind: project.kind === 'PRODUCTION' ? 'PRODUCTION' : 'UNKNOWN', host, writable: false,
      because: `The declared staging project cannot be written to: ${project.because}`,
    };
  }

  const declaredRef = supabaseProjectRef(declared);
  if (ref === null || declaredRef === null) {
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: 'Cannot tell which Supabase project this connection string belongs to. Use the '
        + 'direct string (host db.<ref>.supabase.co) or the session pooler string (user '
        + 'postgres.<ref> on *.pooler.supabase.com) of the project whose API URL is '
        + 'https://<ref>.supabase.co.',
    };
  }
  if (ref !== declaredRef) {
    return {
      kind: 'UNKNOWN', host, writable: false,
      because: `This connection string belongs to a different Supabase project than `
        + `${STAGING_ENV_NAMES.url}. Confirming one project is disposable says nothing about `
        + 'another.',
    };
  }

  return {
    kind: 'STAGING', host, writable: true,
    because: `${host} reaches the project declared in ${STAGING_ENV_NAMES.url} and confirmed `
      + `disposable by ${STAGING_ENV_NAMES.confirmation}.`,
  };
}
