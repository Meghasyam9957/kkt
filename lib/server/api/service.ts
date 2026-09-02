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
import { registerFinanceHandlers } from './finance-handlers';
import { FinanceService } from '@/lib/server/finance/service';
import { InMemoryFinanceRepository, type FinanceRepository } from '@/lib/server/finance/repository';
import { SupabaseFinanceRepository } from '@/lib/server/finance/supabase-repository';
import { registerHrHandlers } from './hr-handlers';
import { HrService, periodStartOf } from '@/lib/server/hr/service';
import { InMemoryHrRepository, type HrRepository } from '@/lib/server/hr/repository';
import { SupabaseHrRepository } from '@/lib/server/hr/supabase-repository';
import { registerOperationsHandlers } from './operations-handlers';
import { OperationsPeopleService, type OperationalTask, type SheetWriteContext } from '@/lib/server/operations/service';
import {
  InMemoryOperationsRepository, SupabaseOperationsRepository,
  type OperationsRepository,
} from '@/lib/server/operations/repository';
import type { TaskType } from '@/lib/server/operations/types';
import { OPEN_HOUSEKEEPING_STATUSES, OPEN_MAINTENANCE_STATUSES } from '@/lib/shared/domain';
import { MUTATION_DEFINITIONS } from './mutation-services';
import { executeMutation } from './mutations';
import { randomUUID } from 'node:crypto';
import type { MutationDependencies } from './mutations';
import { resolveEnvironment, type ResolvedEnvironment } from '@/lib/server/environment/config';
import { createRepositories } from '@/lib/server/sheets/repositories';
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
import { resolveTenantDataSource } from '@/lib/server/tenant/data-source';
import type { TenantId } from '@/lib/server/tenant/context';
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

/**
 * THE finance service, for a server component.
 *
 * Pages read finance the same way they read the workbook: in process, without an HTTP
 * round trip. What they must NOT do is reach a repository directly — every method needs a
 * `TenantContext` and every rule lives in the service, so a page that skipped it would be
 * a second, unruled path to the same tables.
 *
 * It shares the process-slotted repository with the API handlers, so a demonstration
 * write made through a route is visible on the very next render, exactly as a workbook
 * write is.
 */
export function financeServiceFor(): FinanceService {
  const resolved = resolveEnvironment();
  const supabaseClient = resolved.supabase ? makeSupabaseClient(resolved) : null;
  return new FinanceService({
    repo: financeRepository(supabaseClient),
    // The caller's OWN workbook properties, resolved through the tenant registry.
    propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
    audit: getServiceAudit(),
  });
}

/**
 * ONE SET OF REPOSITORIES PER TENANT, resolved on the write.
 *
 * The write path used to be `repos: createRepositories(sheetsClient)` — a single client
 * built at router construction, from the environment, cached in a process slot for the
 * life of the process. Every tenant's writes went through it. The router is still built
 * once (it holds the operation ledger and the id sequences, which must be process-wide),
 * but the WORKBOOK is now resolved per write from the tenant registry, so a router shared
 * by two tenants no longer means a workbook shared by two tenants.
 *
 * `resolveTenantDataSource` caches the binding, so this is a map lookup on the warm path
 * rather than a control-plane round trip per write. It refuses an unregistered or
 * suspended tenant, and that refusal is what reaches the caller — a write with nowhere
 * legitimate to go does not fall back to somewhere illegitimate.
 *
 * Exported so it can be tested directly. Composed into `MutationDependencies` below, this
 * is otherwise reachable only through a fully-built router, and a seam no test can reach
 * is a seam a regression can walk through.
 */
export async function tenantRepositories(tenantId: TenantId) {
  return createRepositories((await resolveTenantDataSource(tenantId)).client);
}

export function getApiRouter(): ApiRouter {
  const existing = routerSlot.read();
  if (existing) return existing;
  const resolved = resolveEnvironment();

  const supabaseClient = resolved.supabase ? makeSupabaseClient(resolved) : null;

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
    reposFor: tenantRepositories,
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

  /*
   * FINANCE (M-DATA-1). The relational domain, in Postgres when a control plane is
   * configured and in memory otherwise — the same asymmetry every other backend here
   * has, so a demonstration exercises the real pipeline rather than a second one.
   *
   * The deps are built PER REQUEST from the caller's tenant, and the property list the
   * service validates against comes from that tenant's own provider. That is what makes
   * naming another customer's property indistinguishable from naming one that does not
   * exist: the question is only ever asked of the caller's own workbook.
   */
  const financeRepo = financeRepository(supabaseClient);
  registerFinanceHandlers(built, async () => ({
    service: new FinanceService({
      repo: financeRepo,
      propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
      audit,
    }),
    store: operationStore,
    audit,
    writesPermitted: resolved.writesPermitted,
  }));

  /*
   * PEOPLE (M-HR-1). Same composition as finance: Postgres when a control plane is
   * configured, in memory otherwise, built per request from the caller's tenant. The
   * property list the service validates against comes from that tenant's own provider, so
   * naming another customer's property is indistinguishable from naming a fiction.
   */
  const hrRepo = hrRepository(supabaseClient);
  registerHrHandlers(built, async () => ({
    service: new HrService({
      repo: hrRepo,
      propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
      // Finance's lock, not a second one.
      isPeriodClosed: async (tenant, isoDate) => {
        const period = await financeRepo.getPeriod(tenant, periodStartOf(isoDate));
        return period?.status === 'CLOSED';
      },
      audit,
    }),
    store: operationStore,
    audit,
    writesPermitted: resolved.writesPermitted,
  }));

  /*
   * PEOPLE ON OPERATIONS (M-OPS-2). The bridge, and the only place the two stores meet.
   *
   * `tasks` reads the CALLER'S OWN workbook through the tenant-resolved repositories, so a
   * task reference can only ever be checked against their own sheet — which is what makes
   * a foreign TaskID a miss rather than a refusal. `writeAssignee` runs the EXISTING
   * verified mutation pipeline rather than touching a sheets client, so the workbook write
   * keeps its contract check, its read-after-write and its audit record.
   */
  const opsRepo = operationsRepository(supabaseClient);
  registerOperationsHandlers(built, async () => ({
    service: new OperationsPeopleService({
      hr: new HrService({
        repo: hrRepo,
        propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
        isPeriodClosed: async (tenant, isoDate) => {
          const period = await financeRepo.getPeriod(tenant, periodStartOf(isoDate));
          return period?.status === 'CLOSED';
        },
        audit,
      }),
      assignments: opsRepo,
      tasks: async (tenant, taskType) => operationalTasks(await deps.reposFor(tenant.tenantId), taskType),
      propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
      writeAssignee: (write, taskType, taskRef, name) =>
        writeAssigneeThroughPipeline(deps, write, taskType, taskRef, name),
      audit,
    }),
    store: operationStore,
    audit,
    writesPermitted: resolved.writesPermitted,
  }));

  routerSlot.write(built);
  return built;
}

/**
 * THE operations-people service, for a server component.
 *
 * Pages read staffing the same way they read the workbook: in process. It shares the
 * process-slotted assignment store with the API handlers, so an assignment made through a
 * route is visible on the very next render.
 *
 * `writeAssignee` is deliberately absent-by-refusal here rather than wired: a page renders,
 * it does not assign, and a server component holding a live workbook writer is a write path
 * nobody declared. Assignment goes through the route, which has the capability check, the
 * idempotency envelope and the audit record.
 */
export function operationsServiceFor(): OperationsPeopleService {
  const resolved = resolveEnvironment();
  const supabaseClient = resolved.supabase ? makeSupabaseClient(resolved) : null;
  const financeRepo = financeRepository(supabaseClient);
  const hrRepo = hrRepository(supabaseClient);
  const audit = getServiceAudit();
  const router = getApiRouter();
  void router;

  return new OperationsPeopleService({
    hr: new HrService({
      repo: hrRepo,
      propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
      isPeriodClosed: async (tenant, isoDate) => {
        const period = await financeRepo.getPeriod(tenant, periodStartOf(isoDate));
        return period?.status === 'CLOSED';
      },
      audit,
    }),
    assignments: operationsRepository(supabaseClient),
    tasks: async (tenant, taskType) => operationalTasks(
      createRepositories((await resolveTenantDataSource(tenant.tenantId)).client), taskType,
    ),
    propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
    writeAssignee: async () => {
      throw new Error(
        'A rendered page does not assign work. Assignment goes through '
        + 'POST /api/operations/assignments, which carries the capability check, the '
        + 'idempotency envelope and the audit record.',
      );
    },
    audit,
  });
}

/**
 * The tenant's own tasks, as much of them as the assignment service needs.
 *
 * Nothing is copied into Postgres: this reads the workbook every time, so the sheet stays
 * the authority for status and for the name currently on the row.
 */
async function operationalTasks(
  repos: Awaited<ReturnType<MutationDependencies['reposFor']>>, taskType: TaskType,
): Promise<readonly OperationalTask[]> {
  if (taskType === 'HOUSEKEEPING') {
    return (await repos.housekeeping.readAll()).map((task) => ({
      taskRef: task.taskId,
      propertyId: task.propertyId || null,
      assigneeName: task.cleaner || null,
      status: task.status,
      // The application's own definition of "not finished", already established in
      // lib/shared/domain.ts. Not a second one.
      open: OPEN_HOUSEKEEPING_STATUSES.includes(task.status),
    }));
  }
  return (await repos.maintenance.readAll()).map((ticket) => ({
    taskRef: ticket.ticketId,
    propertyId: ticket.propertyId || null,
    assigneeName: ticket.assignedTo || null,
    status: ticket.status,
    open: OPEN_MAINTENANCE_STATUSES.includes(ticket.status),
  }));
}

/**
 * Writes the assignee's name into the workbook through the EXISTING mutation pipeline.
 *
 * Reusing `housekeeping.update` / `maintenance.update` rather than reaching for a sheets
 * client means this write keeps everything that pipeline provides: the contract check that
 * refuses a calculated column, the read-after-write verification, the operation ledger and
 * the audit record. A second write path to the same sheet is exactly what the mutation
 * layer exists to prevent.
 *
 * It also moves the status the way the workbook already does — `housekeeping.create`
 * already sets FinalStatus to 'Assigned' when a cleaner is named, so assigning an existing
 * task does the same rather than leaving a named task sitting in Pending.
 */
async function writeAssigneeThroughPipeline(
  deps: MutationDependencies,
  write: SheetWriteContext,
  taskType: TaskType,
  taskRef: string,
  name: string,
): Promise<void> {
  const housekeeping = taskType === 'HOUSEKEEPING';
  const definition = MUTATION_DEFINITIONS[housekeeping ? 'housekeeping.update' : 'maintenance.update'];
  if (!definition) throw new Error(`No mutation definition for ${taskType}`);

  const body = housekeeping
    ? { operationId: randomUUID(), cleaner: name, finalStatus: 'Assigned' }
    : { operationId: randomUUID(), assignedTo: name, status: 'Assigned' };

  await executeMutation(definition, {
    // The REAL caller, not a synthesised one: the pipeline authenticates, audits and
    // allocates from this context, and a fabricated actor would put a write in the trail
    // under somebody who did not make it.
    auth: write.auth,
    request: {
      method: 'PATCH',
      path: housekeeping ? `/api/housekeeping/${taskRef}` : `/api/maintenance/${taskRef}`,
      headers: {},
      query: {},
      params: { id: taskRef },
      body,
      requestId: write.requestId,
    },
  }, deps);
}


/*
 * The AI usage sink lives for the life of the process, not the request.
 *
 * It is what accumulates spend, and a total that reset on every request would make the
 * cap meaningless. Process-wide for the same reason the operation ledger is — see
 * lib/server/runtime/process-state.ts.
 */
const aiSinkSlot = processSlot<AiUsageSink>('api.service.aiSink');

/*
 * The in-memory finance ledger, when there is no control plane, lives for the life of the
 * PROCESS rather than the router — for the same reason the operation ledger does. `next
 * dev` re-evaluates this module when it compiles a route it has not served, and a
 * module-level binding would discard a demonstration's recorded payments mid-session.
 */
const financeRepoSlot = processSlot<FinanceRepository>('api.service.financeRepo');
const hrRepoSlot = processSlot<HrRepository>('api.service.hrRepo');
const opsRepoSlot = processSlot<OperationsRepository>('api.service.opsRepo');

function operationsRepository(supabaseClient: unknown): OperationsRepository {
  if (supabaseClient) return new SupabaseOperationsRepository(supabaseClient);
  const existing = opsRepoSlot.read();
  if (existing) return existing;
  const created = new InMemoryOperationsRepository();
  opsRepoSlot.write(created);
  return created;
}

function hrRepository(supabaseClient: unknown): HrRepository {
  if (supabaseClient) return new SupabaseHrRepository(supabaseClient);
  const existing = hrRepoSlot.read();
  if (existing) return existing;
  const created = new InMemoryHrRepository();
  hrRepoSlot.write(created);
  return created;
}

/**
 * THE people service for a tenant, sharing finance's period lock.
 *
 * `isPeriodClosed` reads `finance_periods` through the finance repository rather than an
 * HR table of its own. Two lock tables is how a month comes to be closed in finance and
 * open in HR, and the first anybody would learn of it is a payslip dated into a closed
 * month.
 */
export function hrServiceFor(): HrService {
  const resolved = resolveEnvironment();
  const supabaseClient = resolved.supabase ? makeSupabaseClient(resolved) : null;
  const finance = financeRepository(supabaseClient);
  return new HrService({
    repo: hrRepository(supabaseClient),
    propertyIds: async (tenant) => (await getDataProvider(tenant)).getPropertyIds(),
    isPeriodClosed: async (tenant, isoDate) => {
      const period = await finance.getPeriod(tenant, periodStartOf(isoDate));
      return period?.status === 'CLOSED';
    },
    audit: getServiceAudit(),
  });
}

function financeRepository(supabaseClient: unknown): FinanceRepository {
  if (supabaseClient) return new SupabaseFinanceRepository(supabaseClient);
  const existing = financeRepoSlot.read();
  if (existing) return existing;
  const created = new InMemoryFinanceRepository();
  financeRepoSlot.write(created);
  return created;
}

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

function makeSupabaseClient(resolved: ResolvedEnvironment): any {
  // Lazy import keeps @supabase/supabase-js out of any client bundle path.
  const { createClient } = require('@supabase/supabase-js');
  return createClient(resolved.supabase!.url, resolved.supabase!.serviceRoleKey, {
    auth: { persistSession: false },
  });
}
