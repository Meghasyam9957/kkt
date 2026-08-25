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
import { registerForecastHandlers } from './forecast-service';
import { registerAnalyticsHandlers } from './analytics-service';
import { registerCopilotHandlers } from './copilot-service';
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
import { getDataProvider, getReadCache } from '@/lib/data/providers';
import { ALL_FEATURES_OFF } from '@/lib/server/ai/guardrails';
import { DiscardingAiUsageSink } from '@/lib/server/ai/provider';
import { resolveAiProvider } from '@/lib/server/ai/dispatch';
import type { CopilotRuntime } from '@/lib/server/ai/copilot';
import { getSharedDemoClient } from '@/lib/server/demo/live-store';
import { processSlot } from '@/lib/server/runtime/process-state';

/*
 * Process-wide, not module-level. When Supabase is absent the router owns the ONLY copy
 * of the operation ledger and the id sequences, both in memory. `next dev` re-evaluates
 * this module when it compiles a new route, and a module-level binding would discard
 * them mid-session: a verified operation would answer 404 on the very next poll.
 * See lib/server/runtime/process-state.ts.
 */
const routerSlot = processSlot<ApiRouter>('api.service.router');
const auditSlot = processSlot<AuditLogger>('api.service.audit');

/**
 * Reset the service singletons. Tests use it between cases; the LIVE demo reset uses it
 * so in-memory operation/sequence state (when Supabase is absent) is genuinely discarded
 * rather than surviving a reset that claims the environment is back to seed.
 */
export function __resetApiService(): void { routerSlot.write(null); auditSlot.write(null); }

/**
 * The service's audit logger — same sinks the mutation pipeline writes through, so
 * demonstration-control actions (live reset, seed capture) land in the same trail.
 */
export function getServiceAudit(): AuditLogger {
  getApiRouter();
  return auditSlot.read()!;
}

export function getApiRouter(): ApiRouter {
  const existing = routerSlot.read();
  if (existing) return existing;
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
  auditSlot.write(audit);

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

  const built = new ApiRouter({ authProvider, audit });
  registerMutationHandlers(built, API_ROUTES, deps);
  // Read side (Phase 8). The provider is passed as a function, not an instance: it
  // resolves per request, so a demonstration dataset switch is reflected immediately
  // and production's environment check happens on the request rather than at boot.
  registerForecastHandlers(built, getDataProvider);
  registerAnalyticsHandlers(built, getDataProvider);
  registerCopilotHandlers(built, getDataProvider, copilotRuntime);
  routerSlot.write(built);
  return built;
}


/**
 * What the copilot runs with in this deployment: nothing configured, deliberately.
 *
 * Every value below is a decision nobody has made — §13's sixth question for the cap,
 * §8.4 for the model ids and the switch storage, §10.2 for the pricing, §1.3 plus a
 * retention answer for the log. Each is therefore left unset rather than defaulted, and
 * the guardrails turn each absence into a named refusal instead of a silent assumption.
 *
 * The practical effect today: `aiEnabled()` is false, so the route answers REFUSED with
 * INTEGRATION_DISABLED and records that it did. The path is real; only the configuration
 * is missing.
 */
function copilotRuntime(): CopilotRuntime {
  return {
    // No provider id is configured, so nothing resolves — not even the mock, which is
    // reachable only by a caller that names it.
    provider: resolveAiProvider(null),
    feature: { switches: ALL_FEATURES_OFF, budget: { cap: null, spent: 0 } },
    pricing: null,
    sink: new DiscardingAiUsageSink(),
    model: '',
  };
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
