import '@/lib/server/only';
/**
 * TENANT -> DATA SOURCE.
 *
 * The registry says WHICH workbook a tenant owns. This module turns that answer into the
 * client that reads and writes it, and it is the only place in the application where that
 * happens. Both sides of the system come through here:
 *
 *   reads   getDataProvider(tenant)      -> lib/data/providers/index.ts
 *   writes  deps.reposFor(tenantId)      -> lib/server/api/service.ts
 *
 * Before this module the two were resolved separately and neither used the tenant: the
 * read side built a provider from `resolveEnvironment()`, and the write side built ONE
 * `Repositories` per process from a single sheets client. A second tenant would have read
 * and written the first tenant's workbook through both paths. Funnelling both through one
 * tenant-keyed resolver is what makes that shape impossible to reintroduce by accident —
 * there is no longer a way to obtain a client without naming whose it is.
 *
 * WHICH CREDENTIAL. The workbook id is per tenant; the Google credential is not. This
 * deployment holds one service identity that is granted access to each tenant workbook —
 * option 1 of the two recorded in docs/MSAAS1_DATA_BOUNDARY.md. It is the smaller change
 * and the larger blast radius, and it is chosen deliberately and written down rather than
 * arrived at silently. Per-tenant credentials are M-SAAS-2 work.
 */
import { processSlot } from '@/lib/server/runtime/process-state';
import {
  resolveEnvironment, liveDataEnabled, EnvironmentConfigError, type ResolvedEnvironment,
} from '@/lib/server/environment/config';
import { createLiveSheetsClient, createTenantSheetsClient } from '@/lib/server/sheets/config';
import type { GoogleSheetsClient } from '@/lib/server/sheets/client';
import { getSharedDemoClient } from '@/lib/server/demo/live-store';
import { DEMO_TENANT_ID } from '@/lib/data/demo/dataset';
import { isTenantId, MissingTenantError, type TenantId } from './context';
import {
  StaticTenantWorkbookRegistry, SupabaseTenantWorkbookRegistry, environmentBinding,
  type TenantWorkbookBinding, type TenantWorkbookRegistry,
} from './workbook-registry';

/**
 * What one tenant's data actually is, in this deployment, right now.
 *
 * `fixtures` is not a property of the tenant — it is a property of the deployment. A demo
 * with no workbook configured serves the generated dataset; production may never. The
 * binding chooses the workbook; the environment chooses whether there is one at all.
 */
export interface TenantDataSource {
  readonly tenantId: TenantId;
  readonly binding: TenantWorkbookBinding;
  /** True when this tenant is served by the generated demonstration dataset. */
  readonly fixtures: boolean;
  /** The client for this tenant's workbook — in-memory when `fixtures`. */
  readonly client: GoogleSheetsClient;
}

/* ------------------------------------------------------------------ *
 * The registry for this deployment
 * ------------------------------------------------------------------ */

const registrySlot = processSlot<TenantWorkbookRegistry>('tenant.workbookRegistry');
let injectedRegistry: TenantWorkbookRegistry | null = null;

/**
 * The registry this deployment uses.
 *
 * Supabase when the control plane is configured — the real answer. When it is not, the
 * deployment is a demonstration running on the identity chooser, which has exactly one
 * tenant and no database to hold a registry; that single binding is declared here rather
 * than inferred, and every OTHER tenant is refused by the same code path production uses.
 */
export function getTenantWorkbookRegistry(): TenantWorkbookRegistry {
  if (injectedRegistry) return injectedRegistry;
  const existing = registrySlot.read();
  if (existing) return existing;

  const resolved = resolveEnvironment();
  const created: TenantWorkbookRegistry = resolved.supabase
    ? new SupabaseTenantWorkbookRegistry(makeControlPlaneClient(resolved))
    : new StaticTenantWorkbookRegistry([environmentBinding(DEMO_TENANT_ID)]);

  registrySlot.write(created);
  return created;
}

function makeControlPlaneClient(resolved: ResolvedEnvironment): unknown {
  // Lazy require keeps @supabase/supabase-js out of any client bundle path, exactly as
  // lib/server/api/service.ts does for the same reason.
  const { createClient } = require('@supabase/supabase-js');
  return createClient(resolved.supabase!.url, resolved.supabase!.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* ------------------------------------------------------------------ *
 * Resolution, with a bounded cache
 * ------------------------------------------------------------------ */

/**
 * How long a resolved binding is trusted before the registry is asked again.
 *
 * A binding changes when a customer is provisioned, re-pointed or suspended — rare,
 * deliberate, operator-initiated events. Reading the control plane on every page render
 * would add a database round trip to a read path that currently makes none, so the answer
 * is held briefly.
 *
 * The honest cost: SUSPENDING a tenant takes effect within this window rather than
 * instantly. That bound is deliberate and is recorded in the milestone report rather than
 * described as immediate. It is not a cross-tenant risk — a stale binding is still THIS
 * tenant's binding — it is a latency on revocation.
 */
const BINDING_TTL_MS = 30_000;

interface CachedSource {
  source: TenantDataSource;
  expiresAt: number;
}

const sourceSlot = processSlot<Map<TenantId, CachedSource>>('tenant.dataSources');

function sourceCache(): Map<TenantId, CachedSource> {
  const existing = sourceSlot.read();
  if (existing) return existing;
  const created = new Map<TenantId, CachedSource>();
  sourceSlot.write(created);
  return created;
}

/**
 * THE data source for one tenant.
 *
 * The tenant id is the only input and it is never optional: a caller that cannot say
 * whose data it wants does not get any. Every call site obtains it from an authenticated
 * session — `checkPageAccess().tenant` on a page, `ctx.auth` in a handler — so a request
 * can never name its own.
 *
 * Refusals propagate rather than degrade. An unregistered tenant, a suspended one, or an
 * unreachable control plane each throw; none of them falls back to another tenant's
 * workbook or to fixtures.
 */
export async function resolveTenantDataSource(
  tenantId: TenantId,
  now: () => number = Date.now,
): Promise<TenantDataSource> {
  if (!isTenantId(tenantId)) throw new MissingTenantError('resolveTenantDataSource');

  const cache = sourceCache();
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > now()) return cached.source;

  let binding;
  try {
    binding = await getTenantWorkbookRegistry().lookup(tenantId);
  } catch (error) {
    // A refused resolution is the security-relevant event on this path: an unregistered
    // tenant, a suspended one, or a control plane that could not answer. Recorded with
    // the tenant and the reason CLASS only — see `describeSelection` for what is never
    // written here.
    console.warn('[tenant] data source refused', {
      tenantId, reason: (error as Error).name || 'UnknownError',
    });
    throw error;
  }

  const source = buildDataSource(binding);
  console.info('[tenant] data source resolved', describeSelection(source));

  cache.set(tenantId, { source, expiresAt: now() + BINDING_TTL_MS });
  return source;
}

/**
 * What may be said about a tenant's data source in a log line.
 *
 * The tenant id and the KIND, and nothing else. Never the workbook id: the list of them
 * is the customer list, and one tenant's id in another tenant's log is a direct object
 * reference to attempt. Never a credential, obviously — none reaches this module. Never
 * business data. A last-six-characters suffix is available from
 * `liveSheetsConfigStatus` for operators who need to confirm which workbook a DEPLOYMENT
 * is on; that is a deployment-level question and is answered in a deployment-level place.
 */
function describeSelection(source: TenantDataSource): Record<string, unknown> {
  return {
    tenantId: source.tenantId,
    kind: source.binding.kind,
    fixtures: source.fixtures,
  };
}

function buildDataSource(binding: TenantWorkbookBinding): TenantDataSource {
  const resolved = resolveEnvironment();

  if (binding.kind === 'GOOGLE_SHEETS') {
    /*
     * A named workbook is always live data. Fixtures are a property of a deployment that
     * has no workbook at all; a tenant that names one cannot be served fictional figures,
     * because doing so would present demonstration numbers as that customer's business.
     */
    return Object.freeze({
      tenantId: binding.tenantId,
      binding,
      fixtures: false,
      client: createTenantSheetsClient(resolved, binding.workbookId as string),
    });
  }

  /* ---- ENVIRONMENT ------------------------------------------------
   * EXACTLY the rule this deployment already applied, preserved to the letter so
   * Srivillu's behaviour is unchanged by becoming registry-resolved: LIVE_DATA_ENABLED
   * decides, not the mere presence of credentials. A deployment with a workbook
   * configured but live data switched off still serves fixtures, as it did before.
   */
  if (liveDataEnabled()) {
    return Object.freeze({
      tenantId: binding.tenantId,
      binding,
      fixtures: false,
      // Reads PRODUCTION_* or DEMO_* per the resolved environment, and throws with the
      // missing variable names rather than reaching for the other environment's workbook.
      client: createLiveSheetsClient(resolved),
    });
  }

  if (!resolved.fixturesPermitted) {
    // Production with live data switched off. `lib/data/providers` refuses this before
    // reaching here; this is the second of the two layers, and it refuses rather than
    // serving the demonstration dataset, which production may never do.
    throw new EnvironmentConfigError(
      'This environment may not serve demonstration fixtures, and live data is not '
      + 'enabled. Set LIVE_DATA_ENABLED=true and configure the workbook. No tenant is '
      + 'served fictional figures here.',
    );
  }

  // THE shared demonstration store — the same instance the mutation pipeline writes to,
  // so a verified write is visible on the very next render.
  return Object.freeze({
    tenantId: binding.tenantId,
    binding,
    fixtures: true,
    client: getSharedDemoClient(),
  });
}

/* ------------------------------------------------------------------ *
 * Test seams
 * ------------------------------------------------------------------ */

/** Inject a registry (or null to restore the deployment's own) and drop cached sources. */
export function __setTenantWorkbookRegistryForTests(
  registry: TenantWorkbookRegistry | null,
): void {
  injectedRegistry = registry;
  registrySlot.write(null);
  sourceSlot.write(null);
}

/** Forget every resolved binding, so a case starts from a genuinely cold registry. */
export function __resetTenantDataSourcesForTests(): void {
  sourceSlot.write(null);
}
