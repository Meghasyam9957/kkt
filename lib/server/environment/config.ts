import '@/lib/server/only';
/**
 * ENVIRONMENT RESOLUTION — the trusted answer to "which system am I?"
 *
 * The design goal is that demo/production isolation is **structural**, not disciplinary.
 * Three things make it so:
 *
 *   1. Credentials are namespaced by environment. DEMO reads only `DEMO_*`; PRODUCTION
 *      reads only `PRODUCTION_*`. A demo deployment cannot reach the production workbook
 *      or the production Supabase project because it never looks at those variable names —
 *      not because a check was remembered.
 *
 *   2. There is no fallback. A missing resource is a startup failure with the variable
 *      named, never a quiet substitution. Silently using demo data in production, or the
 *      reverse, is the class of bug this whole module exists to prevent.
 *
 *   3. Shared resources are rejected. If the two environments are pointed at the same
 *      spreadsheet or the same Supabase project, resolution throws. That is a
 *      misconfiguration that would otherwise look like everything working.
 *
 * `APP_ENV` is read from server configuration only. Nothing from the browser — no header,
 * no cookie, no query string, no `NEXT_PUBLIC_*` variable — participates in this decision.
 */
import type { EnvLike } from '@/lib/shared/env';
import {
  isAppEnv, describeEnvironment,
  type AppEnv, type EnvironmentDescriptor, type PublicEnvironmentInfo,
} from '@/lib/shared/environment';

export class EnvironmentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentConfigError';
  }
}

export interface SheetsCredentials {
  spreadsheetId: string;
  serviceAccountJsonBase64: string;
}

export interface SupabaseCredentials {
  url: string;
  serviceRoleKey: string;
  anonKey: string | null;
}

export interface ResolvedEnvironment {
  env: AppEnv;
  descriptor: EnvironmentDescriptor;
  /** Prefix this environment's variables carry, e.g. 'DEMO_'. */
  prefix: string;
  /** Present only when fully configured. Null means "not configured", never "use the other one". */
  sheets: SheetsCredentials | null;
  supabase: SupabaseCredentials | null;
  /** Variable names that are absent. Names only — never values. */
  missing: string[];
  /**
   * Whether fixture data may be served. DEMO may run on fixtures before its workbook
   * exists; PRODUCTION may never, under any configuration.
   */
  fixturesPermitted: boolean;
  /** Whether demo-only controls (scenario switching, reset) may exist at all. */
  demoControlsPermitted: boolean;
  /**
   * Whether the mutation pipeline may execute business writes here (Phase B2).
   * DEMO defaults to true; PRODUCTION defaults to FALSE and stays false until the
   * production write phase is signed off — enabling it is a deliberate flag flip
   * (`PRODUCTION_WRITES_ENABLED=true`), not a deploy. When false, every mutation route
   * still authenticates, authorizes and audits, then returns a controlled
   * 403 WRITES_DISABLED — so the kill switch is also just this flag.
   */
  writesPermitted: boolean;
}

const PREFIX: Record<AppEnv, string> = { demo: 'DEMO_', production: 'PRODUCTION_' };

/** Variables each environment needs for a live (workbook-backed) deployment. */
const SHEETS_VARS = ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64'] as const;
const SUPABASE_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

/**
 * Read `APP_ENV`.
 *
 * Unset defaults to `demo`. That default is deliberate and one-directional: an
 * unconfigured deployment must never come up as production, because production is the one
 * that touches real money and real guests. Coming up as demo is inconvenient; coming up as
 * production by accident is a data incident.
 */
export function readAppEnv(env: EnvLike = process.env): AppEnv {
  const raw = (env.APP_ENV ?? '').trim().toLowerCase();
  if (raw === '') return 'demo';
  if (!isAppEnv(raw)) {
    throw new EnvironmentConfigError(
      `APP_ENV must be 'demo' or 'production' (got "${env.APP_ENV}"). ` +
      'Refusing to guess which system this is.',
    );
  }
  return raw;
}

function readNamespaced(env: EnvLike, prefix: string, name: string): string | undefined {
  const value = env[`${prefix}${name}`];
  return value && value.trim() !== '' ? value : undefined;
}

/**
 * Resolve the active environment and its credentials.
 *
 * Never throws for *absent* credentials — absence is a legitimate state (a demo running on
 * fixtures) and is reported in `missing` so the caller can decide. It DOES throw for
 * configuration that is actively unsafe: an unknown `APP_ENV`, or two environments sharing
 * a resource.
 */
export function resolveEnvironment(env: EnvLike = process.env): ResolvedEnvironment {
  const appEnv = readAppEnv(env);
  const prefix = PREFIX[appEnv];
  assertNoSharedResources(env);

  const missing: string[] = [];

  const sheetValues = SHEETS_VARS.map((name) => {
    const value = readNamespaced(env, prefix, name);
    if (!value) missing.push(`${prefix}${name}`);
    return value;
  });
  const sheets: SheetsCredentials | null = sheetValues.every(Boolean)
    ? { spreadsheetId: sheetValues[0] as string, serviceAccountJsonBase64: sheetValues[1] as string }
    : null;

  const supabaseValues = SUPABASE_VARS.map((name) => {
    const value = readNamespaced(env, prefix, name);
    if (!value) missing.push(`${prefix}${name}`);
    return value;
  });
  const supabase: SupabaseCredentials | null = supabaseValues.every(Boolean)
    ? {
      url: supabaseValues[0] as string,
      serviceRoleKey: supabaseValues[1] as string,
      anonKey: readNamespaced(env, prefix, 'SUPABASE_ANON_KEY') ?? null,
    }
    : null;

  return {
    env: appEnv,
    descriptor: describeEnvironment(appEnv),
    prefix,
    sheets,
    supabase,
    missing,
    // Production may never serve fixtures. Not "should not" — the flag is a constant.
    fixturesPermitted: appEnv === 'demo',
    demoControlsPermitted: appEnv === 'demo',
    writesPermitted: readWritesEnabled(env, appEnv, prefix),
  };
}

/**
 * `LIVE_DATA_ENABLED` — whether this deployment reads its workbook rather than the
 * generated demonstration dataset.
 *
 * It lives here, beside the other environment reads, because two modules now need the
 * same answer: `lib/data/providers` (which serves it to pages as `isLiveDataEnabled`) and
 * `lib/server/tenant/data-source.ts` (which decides what a tenant's binding resolves to).
 * Two independent reads of one variable is how the read side and the write side of a
 * system drift into disagreeing about which data they are looking at.
 */
export function liveDataEnabled(env: EnvLike = process.env): boolean {
  return String(env.LIVE_DATA_ENABLED ?? 'false').toLowerCase() === 'true';
}

/**
 * `<PREFIX>WRITES_ENABLED`. Demo defaults ON (a demo that cannot demonstrate writing is
 * not a demo); production defaults OFF and only the explicit string 'true' enables it.
 */
function readWritesEnabled(env: EnvLike, appEnv: AppEnv, prefix: string): boolean {
  const raw = (env[`${prefix}WRITES_ENABLED`] ?? '').trim().toLowerCase();
  if (raw === '') return appEnv === 'demo';
  return raw === 'true';
}

/**
 * Two environments pointed at one resource is a configuration mistake that looks like
 * everything working — right up until a demo reset runs against the real workbook.
 */
function assertNoSharedResources(env: EnvLike): void {
  const pairs: Array<[string, string, string]> = [
    ['GOOGLE_SHEET_ID', 'Google spreadsheet', 'a separate demo workbook'],
    ['SUPABASE_URL', 'Supabase project', 'a separate srivillu-demo project'],
  ];
  for (const [name, what, remedy] of pairs) {
    const demo = env[`DEMO_${name}`]?.trim();
    const production = env[`PRODUCTION_${name}`]?.trim();
    if (demo && production && demo === production) {
      throw new EnvironmentConfigError(
        `DEMO_${name} and PRODUCTION_${name} refer to the same ${what}. ` +
        `Demo and production must never share one; create ${remedy}.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Requirement helpers — used where absence must stop the request
 * ------------------------------------------------------------------ */

export function requireSheets(resolved: ResolvedEnvironment): SheetsCredentials {
  if (resolved.sheets) return resolved.sheets;
  throw new EnvironmentConfigError(
    `The ${resolved.descriptor.name} Google Sheets connection is not configured. ` +
    `Missing: ${resolved.missing.filter((m) => m.includes('GOOGLE')).join(', ')}. ` +
    'Set them in the server environment and restart. ' +
    'This deployment will not fall back to another environment or to demo fixtures.',
  );
}

export function requireSupabase(resolved: ResolvedEnvironment): SupabaseCredentials {
  if (resolved.supabase) return resolved.supabase;
  throw new EnvironmentConfigError(
    `The ${resolved.descriptor.name} Supabase project is not configured. ` +
    `Missing: ${resolved.missing.filter((m) => m.includes('SUPABASE')).join(', ')}. ` +
    'Set them in the server environment and restart.',
  );
}

/**
 * Guard for anything that must exist only in demo: scenario switching, demo reset, the
 * demo identity chooser. Throwing is the point — a production build that somehow reached
 * one of these must fail rather than proceed.
 */
export class DemoOnlyOperationError extends Error {
  constructor(operation: string, env: AppEnv) {
    super(
      `"${operation}" is a demonstration-only operation and is not available in ` +
      `${describeEnvironment(env).name}. It exists to reset fictional data; there is no ` +
      'production equivalent by design.',
    );
    this.name = 'DemoOnlyOperationError';
  }
}

export function assertDemoOnly(operation: string, resolved: ResolvedEnvironment): void {
  if (!resolved.demoControlsPermitted) {
    throw new DemoOnlyOperationError(operation, resolved.env);
  }
}

export function publicEnvironmentInfo(
  resolved: ResolvedEnvironment,
  fixtures: boolean,
): PublicEnvironmentInfo {
  return {
    env: resolved.env,
    name: resolved.descriptor.name,
    banner: resolved.descriptor.banner,
    /*
     * The client-facing label is the descriptor's ("Demo Workbook"), full stop. The
     * "(fixtures)" suffix was developer vocabulary leaking into every header; whether
     * fixtures back the demo is still carried — as the `fixtures` boolean below, for
     * code — and the DEMO / UAT badge already tells the person which system they are in.
     */
    dataSourceLabel: resolved.descriptor.dataSourceLabel,
    demoControls: resolved.demoControlsPermitted,
    fixtures,
  };
}

export type { PublicEnvironmentInfo };
