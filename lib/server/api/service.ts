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
import { DiscardingAiUsageSink, InMemoryAiUsageSink, type AiUsageSink } from '@/lib/server/ai/provider';
import { resolveAiProvider } from '@/lib/server/ai/dispatch';
import { OpenAiProvider } from '@/lib/server/ai/openai-provider';
import {
  resolveAiConfig, readAiApiKey, aiProviderPermitted, aiProductionApproved,
} from '@/lib/server/ai/config';
import { aiRateLimiterFor, aiRateLimitState } from '@/lib/server/ai/rate-limit';
import type { AiProvider } from '@/lib/server/ai/provider';
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
export function __resetApiService(): void {
  routerSlot.write(null);
  auditSlot.write(null);
  aiSinkSlot.write(null);
}

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


/*
 * The AI usage sink lives for the life of the process, not the request.
 *
 * It is what accumulates spend, and a total that reset on every request would make the
 * cap meaningless. Process-wide for the same reason the operation ledger is — see
 * lib/server/runtime/process-state.ts.
 */
const aiSinkSlot = processSlot<AiUsageSink>('api.service.aiSink');

function aiUsageSink(permitted: boolean): AiUsageSink {
  const existing = aiSinkSlot.read();
  if (existing) return existing;
  /*
   * When AI is permitted the sink must retain, because the cap is enforced against what
   * it accumulated. When AI is off, nothing real is recorded and the discarding sink is
   * honest — and it throws if AI is ever switched on behind its back, so a deployment
   * cannot end up spending money with nowhere to count it.
   *
   * Neither is §8.4's durable log. That table is blocked on the retention decision, and
   * an in-process array is not a data-retention system: it holds no question text, writes
   * nothing to disk and is gone on restart.
   */
  const sink: AiUsageSink = permitted ? new InMemoryAiUsageSink() : new DiscardingAiUsageSink();
  aiSinkSlot.write(sink);
  return sink;
}

/**
 * What the copilot runs with in this deployment.
 *
 * Every value is read from configuration and none is defaulted. When nothing is
 * configured — the state of every environment today — `aiProviderPermitted` refuses with
 * a named reason, the provider is never constructed, no key is read, and the route
 * answers REFUSED while still recording that it did.
 *
 * The API key is read exactly here, at the moment the provider is built, and is handed
 * straight to it. It is never stored on the runtime, never on the config object, and
 * never returned to a caller.
 */
function copilotRuntime(): CopilotRuntime {
  const resolved = resolveEnvironment();
  const config = resolveAiConfig(process.env, resolved.prefix);
  /*
   * §8.4's rate limits, in the only honest form available: demo runs unenforced and says
   * so, production has no limiter at all and is refused for that reason among others. No
   * limit value is chosen here because none has been approved — see rate-limit.ts.
   */
  const limiter = aiRateLimiterFor(resolved.env);
  const { permitted } = aiProviderPermitted(
    config, resolved.env, aiProductionApproved(process.env, resolved.prefix),
    undefined, aiRateLimitState(limiter),
  );

  const sink = aiUsageSink(permitted);
  const spent = sink instanceof InMemoryAiUsageSink ? sink.spent() : 0;

  return {
    provider: permitted ? buildAiProvider(config.providerId, resolved.prefix) : null,
    feature: {
      // §8.4's per-feature switches have no configured home yet, so nothing is on beyond
      // the integration gate itself. `aiEnabled()` decides that gate from the same
      // configuration this function just read.
      switches: permitted ? { ...ALL_FEATURES_OFF, copilot: true } : ALL_FEATURES_OFF,
      budget: { cap: config.budgetCap, spent },
    },
    pricing: config.pricing,
    sink,
    model: config.model ?? '',
  };
}

/**
 * Construct the configured provider, or nothing.
 *
 * An unknown id resolves to null rather than to the mock: a deployment that names a
 * provider this application does not have is misconfigured, and answering its questions
 * with a stub would hide that.
 */
function buildAiProvider(providerId: string | null, prefix: string): AiProvider | null {
  if (providerId === 'openai') {
    const apiKey = readAiApiKey(process.env, prefix);
    // Unreachable when permitted — `aiProviderPermitted` already required the key — but
    // the provider refuses without one rather than trusting that.
    return apiKey ? new OpenAiProvider({ apiKey }) : null;
  }
  return resolveAiProvider(providerId);
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
