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
import { createRepositories } from '@/lib/server/sheets/repositories';
import { InMemorySheetsClient } from '@/lib/server/sheets/client';
import { buildDemoSheetsClient } from '@/lib/server/demo/workbook-grids';
import { ReadCache } from '@/lib/server/cache/read-cache';
import { USERS } from './harness';

export interface WriteHarness {
  router: ApiRouter;
  client: InMemorySheetsClient;
  store: InMemoryOperationStore;
  audit: InMemoryAuditSink;
  cache: ReadCache;
  deps: MutationDependencies;
  request(userKey: keyof typeof USERS | null, method: string, path: string, body?: unknown):
    Promise<{ status: number; body: any }>;
}

export function createWriteHarness(overrides: Partial<MutationDependencies> = {}): WriteHarness {
  const client = buildDemoSheetsClient();
  const store = new InMemoryOperationStore();
  const audit = new InMemoryAuditSink();
  const auditService = new AuditLogger(audit);
  const cache = new ReadCache({ ttlMs: 60_000 });
  const deps: MutationDependencies = {
    repos: createRepositories(client),
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

  return {
    router, client, store, audit, cache, deps,
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
