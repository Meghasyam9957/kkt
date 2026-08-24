import '@/lib/server/only';
/**
 * API SERVICE — builds THE router, once per process, from the resolved environment.
 *
 * Demo and production run the SAME pipeline objects; only the injected backends differ:
 *
 *   backend            demo (workbook)        demo (no workbook)     production
 *   sheets client      demo Google Sheet      InMemory (demo data)   production Google Sheet
 *   operation store    demo Supabase          InMemory               production Supabase
 *   id sequences       demo Supabase          InMemory               production Supabase
 *   audit sink         demo Supabase + memory memory                 production Supabase
 *
 * There is no "demo mutation architecture" — that would be a second code path that
 * production never exercises, which is how demos lie. A demo with no configured
 * workbook/Supabase still runs every layer against in-process backends.
 */
import { API_ROUTES } from './routes';
import { ApiRouter } from './router';
import { registerMutationHandlers } from './mutation-services';
import type { MutationDependencies } from './mutations';
import { resolveEnvironment, type ResolvedEnvironment } from '@/lib/server/environment/config';
import { createRepositories } from '@/lib/server/sheets/repositories';
import { createLiveSheetsClient } from '@/lib/server/sheets/config';
import { InMemorySheetsClient, type GoogleSheetsClient } from '@/lib/server/sheets/client';
import {
  IdAllocator, PostgresSequenceStore, InMemorySequenceStore, type SequenceStore,
} from '@/lib/server/ids/allocator';
import {
  PostgresOperationStore, InMemoryOperationStore, type OperationStore,
} from '@/lib/server/ops/operation-store';
import { AuditLogger, InMemoryAuditSink, SupabaseAuditSink, CompositeAuditSink } from '@/lib/server/audit/logger';
import { SupabaseAuthProvider } from '@/lib/server/auth/session';
import { DemoAuthProvider } from '@/lib/server/auth/demo-identities';
import { getReadCache } from '@/lib/data/providers';
import { getSharedDemoClient } from '@/lib/server/demo/live-store';

let router: ApiRouter | null = null;
let serviceAudit: AuditLogger | null = null;

/**
 * Reset the service singletons. Tests use it between cases; the LIVE demo reset uses it
 * so in-memory operation/sequence state (when Supabase is absent) is genuinely discarded
 * rather than surviving a reset that claims the environment is back to seed.
 */
export function __resetApiService(): void { router = null; serviceAudit = null; }

/**
 * The service's audit logger — same sinks the mutation pipeline writes through, so
 * demonstration-control actions (live reset, seed capture) land in the same trail.
 */
export function getServiceAudit(): AuditLogger {
  getApiRouter();
  return serviceAudit!;
}

export function getApiRouter(): ApiRouter {
  if (router) return router;
  const resolved = resolveEnvironment();

  const supabaseClient = resolved.supabase ? makeSupabaseClient(resolved) : null;

  const sheetsClient: GoogleSheetsClient = resolved.sheets
    ? createLiveSheetsClient(resolved)
    : demoInMemoryClient(resolved);

  const sequences: SequenceStore = supabaseClient
    ? new PostgresSequenceStore(supabaseClient)
    : new InMemorySequenceStore();

  const operationStore: OperationStore = supabaseClient
    ? new PostgresOperationStore(supabaseClient)
    : new InMemoryOperationStore();

  const audit = new AuditLogger(
    supabaseClient
      ? new CompositeAuditSink([new SupabaseAuditSink(supabaseClient), new InMemoryAuditSink()])
      : new InMemoryAuditSink(),
  );
  serviceAudit = audit;

  const authProvider = resolved.supabase
    ? new SupabaseAuthProvider({ url: resolved.supabase.url, serviceRoleKey: resolved.supabase.serviceRoleKey })
    : new DemoAuthProvider(resolved);

  const deps: MutationDependencies = {
    repos: createRepositories(sheetsClient),
    store: operationStore,
    allocator: new IdAllocator(sequences, audit),
    audit,
    cache: getReadCache(),
    writesPermitted: resolved.writesPermitted,
  };

  router = new ApiRouter({ authProvider, audit });
  registerMutationHandlers(router, API_ROUTES, deps);
  return router;
}

/**
 * Demo with no configured workbook: the same client interface production uses, backed by
 * the deterministic demo grids. Only reachable when the environment permits fixtures —
 * production throws in `createLiveSheetsClient` long before this could run.
 */
function demoInMemoryClient(resolved: ResolvedEnvironment): GoogleSheetsClient {
  if (!resolved.fixturesPermitted) {
    // createLiveSheetsClient would already have thrown; this is belt and braces.
    throw new Error('No workbook configured and fixtures are not permitted in this environment.');
  }
  // THE shared store — the same instance the read provider derives its views from, so a
  // verified write is visible on the very next page render.
  return getSharedDemoClient();
}

function makeSupabaseClient(resolved: ResolvedEnvironment): any {
  // Lazy import keeps @supabase/supabase-js out of any client bundle path.
  const { createClient } = require('@supabase/supabase-js');
  return createClient(resolved.supabase!.url, resolved.supabase!.serviceRoleKey, {
    auth: { persistSession: false },
  });
}
