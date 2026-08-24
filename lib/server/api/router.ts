import '@/lib/server/only';
/**
 * ROUTER — binds route definitions to guarded handlers.
 *
 * Every registered route is wrapped by the guard; there is no path to a handler that
 * skips authentication, authorization, investor scoping or audit logging. A route with no
 * registered handler returns 404 *after* the guard has run, so probing for hidden
 * endpoints still produces an audit trail.
 *
 * Next.js route handlers will be thin adapters over `dispatch` — the authorization
 * behaviour proven by the test suite is the behaviour production runs.
 */
import { createGuard, type ApiRequest, type ApiResponse, type Handler, type GuardDependencies } from '@/lib/server/auth/guard';
import { API_ROUTES, findRoute, type RouteDefinition } from './routes';

export interface RouterOptions extends GuardDependencies {
  handlers?: Partial<Record<string, Handler<unknown>>>;
}

const routeKey = (route: Pick<RouteDefinition, 'method' | 'path'>): string => `${route.method} ${route.path}`;

export class ApiRouter {
  private readonly withAuth: ReturnType<typeof createGuard>;
  private readonly handlers = new Map<string, Handler<unknown>>();

  constructor(private readonly options: RouterOptions) {
    this.withAuth = createGuard(options);
    for (const [key, handler] of Object.entries(options.handlers ?? {})) {
      if (handler) this.handlers.set(key, handler);
    }
  }

  /** Register (or replace) the handler for a declared route. */
  register(method: RouteDefinition['method'], path: string, handler: Handler<unknown>): this {
    const route = API_ROUTES.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`Cannot register a handler for an undeclared route: ${method} ${path}`);
    this.handlers.set(routeKey(route), handler);
    return this;
  }

  /**
   * Dispatch a request. Unknown routes are 404 without touching the guard; declared
   * routes are always guarded, whether or not a handler is registered.
   */
  async dispatch(request: ApiRequest): Promise<ApiResponse<unknown>> {
    const route = findRoute(request.method, request.path);
    if (!route) {
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such endpoint' } } };
    }

    const params = extractParams(route.path, request.path);
    const enriched: ApiRequest = { ...request, params: { ...params, ...(request.params ?? {}) } };

    // A declared-but-unimplemented route still passes through the guard, so authorization
    // and audit behave identically to an implemented one. It returns a sentinel rather
    // than throwing, so a genuine handler failure stays distinguishable from "not built".
    const handler = this.handlers.get(routeKey(route))
      ?? (async () => NOT_IMPLEMENTED);

    const guarded = this.withAuth(
      {
        capability: route.capability,
        action: route.action,
        ...(route.investorScoped ? { investorScoped: true } : {}),
        ...(route.entityType ? { entityType: route.entityType } : {}),
      },
      handler,
    );

    const response = await guarded(enriched);

    // 501, never a 200 with empty data — the latter is indistinguishable from
    // "you are allowed and there is genuinely nothing here".
    if (response.status === 200 && response.body === NOT_IMPLEMENTED) {
      return { status: 501, body: { error: { code: 'NOT_IMPLEMENTED', message: 'Endpoint not implemented yet' } } };
    }

    // A handler that refused with a typed mutation error: unwrap it into the response
    // status it names. This is the ONLY translation — handlers cannot mint their own
    // status codes any other way, so every refusal shape stays uniform.
    const body = response.body as { __mutationError?: boolean; status?: number; code?: string; message?: string; details?: unknown } | null;
    if (response.status === 200 && body && body.__mutationError === true) {
      return {
        status: body.status ?? 500,
        body: {
          error: {
            code: body.code ?? 'ERROR',
            message: body.message ?? 'Request refused',
            ...(body.details !== undefined ? { details: body.details } : {}),
          },
        },
      } as ApiResponse<unknown>;
    }
    return response;
  }

  /** Routes declared but not yet implemented — surfaced in the Phase 3 report. */
  unimplemented(): RouteDefinition[] {
    return API_ROUTES.filter((r) => !this.handlers.has(routeKey(r)));
  }
}

/** Unique marker returned by the placeholder handler for a declared-but-unbuilt route. */
export const NOT_IMPLEMENTED: unique symbol = Symbol('NOT_IMPLEMENTED');

/** '/api/investors/:id' + '/api/investors/INV-001' → { id: 'INV-001' } */
export function extractParams(pattern: string, actual: string): Record<string, string> {
  const patternParts = pattern.split('/');
  const actualParts = actual.split('/');
  const params: Record<string, string> = {};
  if (patternParts.length !== actualParts.length) return params;
  patternParts.forEach((part, i) => {
    if (part.startsWith(':')) {
      const value = actualParts[i];
      if (value !== undefined) params[part.slice(1)] = value;
    }
  });
  return params;
}
