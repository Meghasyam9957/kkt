/**
 * THE WRITE PIPELINE, over in-memory backends.
 *
 * Runs the REAL path — router → guard → executeMutation → repositories — against the same
 * interfaces production uses, with the demo workbook grids behind `InMemorySheetsClient`.
 * Nothing here mocks the pipeline itself; only the I/O backends are swapped, exactly as a
 * fixtures-mode deployment swaps them.
 *
 * Extracted from `tests/mutations.test.ts` when UI-7 needed the same harness to prove the
 * arrival and departure writes. One harness, so a suite cannot accidentally test a
 * different pipeline from the one the mutation suite guards.
 */
import { randomUUID } from 'node:crypto';
import { ApiRouter } from '@/lib/server/api/router';
import { API_ROUTES } from '@/lib/server/api/routes';
import { registerMutationHandlers } from '@/lib/server/api/mutation-services';
import type { MutationDependencies } from '@/lib/server/api/mutations';
import { InMemoryAuthProvider } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { IdAllocator, InMemorySequenceStore } from '@/lib/server/ids/allocator';
import { InMemoryOperationStore } from '@/lib/server/ops/operation-store';
import { createRepositories, type Repositories } from '@/lib/server/sheets/repositories';
import { InMemorySheetsClient } from '@/lib/server/sheets/client';
import { buildDemoSheetsClient } from '@/lib/server/demo/workbook-grids';
import { ReadCache } from '@/lib/server/cache/read-cache';
import { USERS, TENANT_A } from './harness';
import type { TenantId } from '@/lib/server/tenant/context';
import { TenantWorkbookNotConfiguredError } from '@/lib/server/tenant/workbook-registry';

export interface WriteHarness {
  router: ApiRouter;
  /** TENANT_A's workbook — the one the single-tenant cases write to and read back. */
  client: InMemorySheetsClient;
  /** TENANT_A's repositories, for reading a write back at the data layer. */
  repos: Repositories;
  store: InMemoryOperationStore;
  audit: InMemoryAuditSink;
  cache: ReadCache;
  deps: MutationDependencies;
  /** One tenant's workbook. Throws for a tenant this harness never registered. */
  clientFor(tenantId: TenantId): InMemorySheetsClient;
  /** One tenant's repositories. Throws for a tenant this harness never registered. */
  reposFor(tenantId: TenantId): Repositories;
  request(userKey: keyof typeof USERS | null, method: string, path: string, body?: unknown):
    Promise<{ status: number; body: any }>;
}

export interface WriteHarnessOptions {
  /**
   * Which tenants this harness serves, each with its OWN in-memory workbook.
   *
   * Defaults to TENANT_A alone, which is what every single-tenant case wants. Pass both
   * to prove isolation: two genuinely separate workbooks means "Tenant A wrote into
   * Tenant B's records" is an observable event rather than an assertion about intent.
   */
  tenants?: readonly TenantId[];
}

export function createWriteHarness(
  overrides: Partial<MutationDependencies> = {},
  options: WriteHarnessOptions = {},
): WriteHarness {
  const tenants = options.tenants ?? [TENANT_A];

  /*
   * ONE WORKBOOK PER TENANT — separate `InMemorySheetsClient` instances, not one client
   * shared behind two names. A shared client would make every isolation test pass
   * vacuously, which is the failure mode this harness exists to avoid.
   */
  const clients = new Map<TenantId, InMemorySheetsClient>();
  const repositories = new Map<TenantId, Repositories>();
  for (const tenantId of tenants) {
    const tenantClient = buildDemoSheetsClient();
    clients.set(tenantId, tenantClient);
    repositories.set(tenantId, createRepositories(tenantClient));
  }

  const client = clients.get(TENANT_A) ?? clients.get(tenants[0]!)!;
  const store = new InMemoryOperationStore();
  const audit = new InMemoryAuditSink();
  const auditService = new AuditLogger(audit);
  const cache = new ReadCache({ ttlMs: 60_000 });
  const deps: MutationDependencies = {
    // Mirrors production: an unregistered tenant is REFUSED, never given a default
    // workbook. A harness that fell back would test a laxer rule than the one shipped.
    reposFor: async (tenantId) => {
      const found = repositories.get(tenantId);
      if (!found) throw new TenantWorkbookNotConfiguredError(tenantId);
      return found;
    },
    store,
    allocator: new IdAllocator(new InMemorySequenceStore(1), auditService),
    audit: auditService,
    cache,
    writesPermitted: true,
    ...overrides,
  };
  const router = new ApiRouter({
    authProvider: new InMemoryAuthProvider(Object.values(USERS)),
    audit: auditService,
  });
  registerMutationHandlers(router, API_ROUTES, deps);

  function requireTenantWorkbook<T>(map: Map<TenantId, T>, tenantId: TenantId): T {
    const found = map.get(tenantId);
    if (!found) throw new TenantWorkbookNotConfiguredError(tenantId);
    return found;
  }

  return {
    router, client, store, audit, cache, deps,
    repos: repositories.get(TENANT_A) ?? repositories.get(tenants[0]!)!,
    clientFor: (tenantId) => requireTenantWorkbook(clients, tenantId),
    reposFor: (tenantId) => requireTenantWorkbook(repositories, tenantId),
    async request(userKey, method, requestPath, body) {
      const headers: Record<string, string> = {};
      if (userKey) headers.authorization = `Bearer ${USERS[userKey]!.token}`;
      const response = await router.dispatch({
        method, path: requestPath, headers, body, query: {}, requestId: `req-${randomUUID().slice(0, 8)}`,
      });
      return { status: response.status, body: response.body as any };
    },
  };
}
