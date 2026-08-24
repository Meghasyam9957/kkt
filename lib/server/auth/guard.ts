import '@/lib/server/only';
/**
 * AUTHORIZATION GUARD — enforcement layer 2 (API) and the gateway to layer 3 (data).
 *
 * Layer 1 (UI navigation) is convenience only. Every request passes through here, so a
 * hand-crafted curl call is checked exactly as a click is.
 */
import { AuthenticationError, AuthorizationError, type AuthContext, type AuthProvider } from './session';
import { roleHasCapability, type Capability, type Role } from './roles';
import type { AuditService } from '@/lib/server/audit/logger';

export interface ApiRequest {
  method: string;
  /** Path without the query string, e.g. '/api/investor/distributions'. */
  path: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  /** Path parameters extracted by the router, e.g. { id: 'BK-2026-0001' }. */
  params?: Record<string, string>;
  ip?: string;
  requestId?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T | { error: { code: string; message: string } };
}

export interface HandlerContext {
  auth: AuthContext;
  request: ApiRequest;
  /**
   * Present ONLY for investor-scoped routes. Equals the caller's own investor id,
   * resolved server-side. Handlers must use this and never read an id from the request.
   */
  investorId?: string;
}

export type Handler<T = unknown> = (ctx: HandlerContext) => Promise<T>;

export interface GuardOptions {
  capability: Capability;
  /** Applies investor row-level scoping and rejects client-supplied investor identity. */
  investorScoped?: boolean;
  /** Action name recorded in the audit log, e.g. 'investor.distributions.read'. */
  action: string;
  entityType?: string;
}

export interface GuardDependencies {
  authProvider: AuthProvider;
  audit: AuditService;
}

/* ------------------------------------------------------------------ *
 * Investor identity injection defence
 * ------------------------------------------------------------------ */

/**
 * Keys that would be an attempt to choose an investor identity from the client side.
 * Matching is case- and separator-insensitive, so `investorId`, `investor_id`,
 * `INVESTOR-ID` and `Investor Id` are all caught.
 */
const INVESTOR_KEY_PATTERN = /^investor[\s_-]*id$/i;

function normalizeKey(key: string): string {
  return key.replace(/[\s_-]+/g, '').toLowerCase();
}

const isInvestorKey = (key: string): boolean =>
  INVESTOR_KEY_PATTERN.test(key) || normalizeKey(key) === 'investorid';

/** Recursively search a payload for any attempt to supply an investor identity. */
export function findInvestorIdentityInjection(request: ApiRequest): string | null {
  const scan = (value: unknown, where: string, depth = 0): string | null => {
    if (depth > 6 || value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = scan(value[i], `${where}[${i}]`, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isInvestorKey(key)) return `${where}.${key}`;
      const hit = scan(child, `${where}.${key}`, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  for (const [key] of Object.entries(request.query ?? {})) {
    if (isInvestorKey(key)) return `query.${key}`;
  }
  for (const [key] of Object.entries(request.params ?? {})) {
    if (isInvestorKey(key)) return `params.${key}`;
  }
  for (const [key] of Object.entries(request.headers ?? {})) {
    if (isInvestorKey(key) || normalizeKey(key) === 'xinvestorid') return `headers.${key}`;
  }
  const bodyHit = scan(request.body, 'body');
  if (bodyHit) return bodyHit;

  // A path segment that looks like an investor id, e.g. /api/investor/INV-002/reports.
  if (/\/INV-\d+/i.test(request.path)) return `path:${request.path}`;

  return null;
}

/* ------------------------------------------------------------------ *
 * The guard
 * ------------------------------------------------------------------ */

export function createGuard(deps: GuardDependencies) {
  /**
   * Wrap a handler with authentication, capability authorization, investor scoping and
   * audit logging. Every outcome — allow, deny, error — is recorded.
   */
  return function withAuth<T>(options: GuardOptions, handler: Handler<T>) {
    return async function guarded(request: ApiRequest): Promise<ApiResponse<T>> {
      const token = extractToken(request);
      let auth: AuthContext | null = null;

      try {
        // --- 1. Authenticate -------------------------------------------------
        auth = await deps.authProvider.resolve(token);

        // --- 2. Authorize by capability -------------------------------------
        if (!roleHasCapability(auth.role, options.capability)) {
          return await denied(deps, request, auth, options,
            `Role ${auth.role} lacks capability ${options.capability}`);
        }

        // --- 3. Investor scoping --------------------------------------------
        let investorId: string | undefined;
        if (options.investorScoped) {
          // Any client-supplied investor identity is a scoping attack, not a preference.
          // Refused even when the value happens to match the caller's own id, so the
          // pattern never becomes normalised.
          const injection = findInvestorIdentityInjection(request);
          if (injection) {
            return await denied(deps, request, auth, options,
              `Client-supplied investor identity is not accepted (${injection})`);
          }
          // An investor-scoped route ALWAYS runs with a scope. A management role has no
          // investor identity, so rather than running unscoped (or accepting an id from
          // the caller) it is refused here and directed to the management endpoint.
          // This removes the "sometimes scoped" branch entirely — that conditional is
          // where row-level isolation bugs are born.
          if (auth.role !== 'INVESTOR') {
            return await denied(deps, request, auth, options,
              `Investor-scoped route requires an investor account; management must use /api/investors/:id`);
          }
          if (!auth.investorId) {
            return await denied(deps, request, auth, options, 'Investor account has no investor mapping');
          }
          investorId = auth.investorId;
        }

        // --- 4. Execute ------------------------------------------------------
        const result = await handler({ auth, request, ...(investorId ? { investorId } : {}) });

        await deps.audit.record({
          actor: auth, action: options.action, entityType: options.entityType,
          entityId: entityIdOf(request), result: 'ALLOW',
          requestId: request.requestId, ip: request.ip,
          metadata: { method: request.method, path: request.path, ...(investorId ? { scoped: true } : {}) },
        });

        return { status: 200, body: result };
      } catch (error) {
        const isAuthn = error instanceof AuthenticationError;
        const isAuthz = error instanceof AuthorizationError;
        const status = isAuthn ? 401 : isAuthz ? 403 : 500;

        await deps.audit.record({
          actor: auth, action: options.action, entityType: options.entityType,
          entityId: entityIdOf(request),
          result: isAuthn || isAuthz ? 'DENY' : 'ERROR',
          reason: (error as Error).message,
          requestId: request.requestId, ip: request.ip,
          metadata: { method: request.method, path: request.path },
        });

        return {
          status,
          body: {
            error: {
              code: isAuthn ? 'UNAUTHENTICATED' : isAuthz ? 'FORBIDDEN' : 'INTERNAL',
              // Internal failures never leak their message to the caller.
              message: status === 500 ? 'Internal error' : (error as Error).message,
            },
          },
        };
      }
    };
  };
}

async function denied(
  deps: GuardDependencies, request: ApiRequest, auth: AuthContext | null,
  options: GuardOptions, reason: string,
): Promise<ApiResponse<never>> {
  await deps.audit.record({
    actor: auth, action: options.action, entityType: options.entityType,
    entityId: entityIdOf(request), result: 'DENY', reason,
    requestId: request.requestId, ip: request.ip,
    metadata: { method: request.method, path: request.path },
  });
  // The caller learns it is forbidden, not why — no probing for what exists.
  return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Not authorized' } } };
}

function extractToken(request: ApiRequest): string | null {
  const header = request.headers?.authorization ?? request.headers?.Authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  const cookie = request.headers?.cookie;
  if (typeof cookie === 'string') {
    const match = /(?:^|;\s*)sb-access-token=([^;]+)/.exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

/** Non-PII entity identifier for the audit trail (never a guest name). */
function entityIdOf(request: ApiRequest): string | undefined {
  const id = request.params?.id;
  return typeof id === 'string' ? id : undefined;
}

/* ------------------------------------------------------------------ *
 * Route-level authorization (enforcement layer 1's server-side twin)
 * ------------------------------------------------------------------ */

/** Page-route prefixes → the roles allowed to load them. Used by the middleware. */
export const ROUTE_ROLES: ReadonlyArray<{ prefix: string; roles: readonly Role[] }> = [
  { prefix: '/admin',      roles: ['ADMIN', 'SUPER_ADMIN'] },
  { prefix: '/operations', roles: ['OPERATIONS', 'ADMIN', 'SUPER_ADMIN'] },
  // INVESTOR only: the investor portal always renders the signed-in investor's own data.
  // Management reviews an investor through /admin/investors, which is separately audited.
  { prefix: '/investor',   roles: ['INVESTOR'] },
];

/** Longest-prefix match, so /admin/settings cannot be widened by a shorter rule. */
export function rolesForRoute(pathname: string): readonly Role[] | null {
  let best: { prefix: string; roles: readonly Role[] } | null = null;
  for (const entry of ROUTE_ROLES) {
    if (pathname === entry.prefix || pathname.startsWith(entry.prefix + '/')) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  return best?.roles ?? null;
}

export function canLoadRoute(role: Role, pathname: string): boolean {
  const roles = rolesForRoute(pathname);
  if (!roles) return true;         // unguarded (e.g. /login)
  return roles.includes(role);
}
