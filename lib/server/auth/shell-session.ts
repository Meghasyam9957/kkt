import '@/lib/server/only';
import type { EnvLike } from '@/lib/shared/env';
/**
 * SHELL SESSION — who the rendered pages are talking to.
 *
 * This resolves the signed-in user for the app shell (name, email, role) so navigation can
 * hide what a role cannot use. It is presentation state and grants nothing: every API
 * route resolves its own AuthContext from the database via `lib/server/auth/session.ts`,
 * and the RBAC suite asserts that a hidden route is also refused when called directly.
 *
 * Which authenticator applies is decided by the environment, and the two are asymmetric on
 * purpose:
 *
 *   PRODUCTION  Supabase, always. If it is not configured the request fails. There is no
 *               demo identity, no anonymous fallback and no default administrator.
 *
 *   DEMO        Supabase when the demo project is configured; otherwise the demo identity
 *               chooser, which needs no password because it guards nothing — the data
 *               behind it is fictional.
 *
 * The combination "real business data, unauthenticated caller" is therefore unreachable:
 * production has no code path that does not go through Supabase.
 */
import { SupabaseAuthProvider, AuthenticationError, type AuthProvider, type AuthContext } from './session';
import { DemoAuthProvider, DEMO_SESSION_COOKIE, DEMO_IDENTITIES } from './demo-identities';
import type { Role } from '@/lib/shared/roles';
import { resolveEnvironment, requireSupabase, type ResolvedEnvironment } from '@/lib/server/environment/config';

export interface ShellSession {
  /** The authenticated principal's id — Supabase auth uuid, or `demo:<key>`. */
  userId: string;
  name: string;
  email: string;
  role: Role;
  /**
   * The tenant this session acts in — resolved from the user's membership by the auth
   * provider, immutable for the request, and never taken from the client. Every read or
   * write of business data requires it.
   */
  tenantId: string;
  /** Present only for INVESTOR. Server-resolved; never taken from the client. */
  investorId: string | null;
  /** True when this is a demonstration identity rather than a real account. */
  demo: boolean;
}

export interface SupabaseStatus {
  configured: boolean;
  /** Names of the absent variables — never values. */
  missing: string[];
  /** Which environment's project this describes. */
  environment: string;
}

export function supabaseStatus(env: EnvLike = process.env): SupabaseStatus {
  const resolved = resolveEnvironment(env);
  return {
    configured: resolved.supabase !== null,
    missing: resolved.missing.filter((name) => name.includes('SUPABASE')),
    environment: resolved.descriptor.name,
  };
}

/**
 * Name of the cookie carrying the Supabase access token. Configurable because the default
 * is project-scoped (`sb-<ref>-auth-token`) and differs per deployment.
 */
export function sessionCookieName(env: EnvLike = process.env): string {
  const resolved = resolveEnvironment(env);
  return env[`${resolved.prefix}SUPABASE_AUTH_COOKIE`] || env.SUPABASE_AUTH_COOKIE || 'sb-access-token';
}

export interface ShellSessionDeps {
  /** Returns the raw session token from the request, or null. */
  readToken?: () => Promise<string | null>;
  provider?: AuthProvider;
  env?: EnvLike;
  resolved?: ResolvedEnvironment;
}

/** Reads whichever cookie the active authenticator uses. */
async function readCookie(name: string): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers');
    return cookies().get(name)?.value ?? null;
  } catch {
    // Outside a request scope (tests, scripts) there is no cookie to read.
    return null;
  }
}

export class AuthNotConfiguredError extends Error {
  constructor(environment: string, missing: string[]) {
    super(
      `${environment} requires Supabase authentication and it is not configured. ` +
      `Missing: ${missing.join(', ')}. ` +
      'Refusing to serve business data without an authenticated caller.',
    );
    this.name = 'AuthNotConfiguredError';
  }
}

/** Which authenticator this deployment uses. Rendered on the sign-in screen. */
export type AuthMode = 'supabase' | 'demo-identity';

export function authMode(env: EnvLike = process.env): AuthMode {
  const resolved = resolveEnvironment(env);
  if (resolved.supabase) return 'supabase';
  if (resolved.env === 'demo') return 'demo-identity';
  // Production without Supabase has no mode; callers surface that as a failure.
  return 'supabase';
}

/**
 * Resolve the shell session, or throw.
 *
 * Throws `AuthNotConfiguredError` when production lacks Supabase, and rethrows
 * authentication failures so the caller can redirect to sign-in rather than quietly
 * showing an administrator's navigation to a signed-out visitor.
 */
export async function getShellSession(deps: ShellSessionDeps = {}): Promise<ShellSession> {
  const env = deps.env ?? process.env;
  const resolved = deps.resolved ?? resolveEnvironment(env);

  const selected = deps.provider
    ? {
      provider: deps.provider,
      token: await (deps.readToken ?? (() => readCookie(sessionCookieName(env))))(),
    }
    : await selectProvider(resolved, env, deps.readToken);

  const context: AuthContext = await selected.provider.resolve(selected.token);

  return {
    userId: context.userId,
    name: displayName(context),
    email: context.email,
    role: context.role,
    tenantId: context.tenantId,
    investorId: context.investorId,
    demo: context.userId.startsWith('demo:'),
  };
}

async function selectProvider(
  resolved: ResolvedEnvironment,
  env: EnvLike,
  readToken?: () => Promise<string | null>,
): Promise<{ provider: AuthProvider; token: string | null }> {
  if (resolved.supabase) {
    const credentials = requireSupabase(resolved);
    return {
      provider: new SupabaseAuthProvider({
        url: credentials.url,
        serviceRoleKey: credentials.serviceRoleKey,
      }),
      token: await (readToken ?? (() => readCookie(sessionCookieName(env))))(),
    };
  }

  if (resolved.env !== 'demo') {
    throw new AuthNotConfiguredError(
      resolved.descriptor.name,
      resolved.missing.filter((name) => name.includes('SUPABASE')),
    );
  }

  return {
    provider: new DemoAuthProvider(resolved),
    token: await (readToken ?? (() => readCookie(DEMO_SESSION_COOKIE)))(),
  };
}

/** Supabase stores no display name by default; derive a readable one from the address. */
function displayName(context: AuthContext): string {
  const identity = DEMO_IDENTITIES.find((i) => i.email === context.email);
  if (identity) return identity.name;

  const local = context.email.split('@')[0] ?? context.email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || context.email;
}

export { AuthenticationError, DEMO_SESSION_COOKIE, DEMO_IDENTITIES };
