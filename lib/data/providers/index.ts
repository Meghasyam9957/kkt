/**
 * PROVIDER SELECTION — the one place a data source is chosen.
 *
 * Page components import `getDataProvider()` and never a concrete implementation, so the
 * source changes here and nowhere else.
 *
 * The selection is driven by the resolved environment, and the two environments are not
 * symmetrical on purpose:
 *
 *   PRODUCTION is always workbook-backed. There is no configuration under which it serves
 *   fixtures — not a flag, not a fallback, not an error path. Demonstration figures
 *   presented as business figures is the worst failure this system can have, so the
 *   fixture provider is simply unreachable from production.
 *
 *   DEMO may run either way: on the demo workbook when one is configured, or on the
 *   generated demo dataset when it is not. Both are fictional, and both are labelled
 *   DEMO / UAT in the interface.
 *
 * Note for anyone editing this file: it is client-reachable by import path. It must never
 * read a credential — that happens in `lib/server/sheets/config.ts`, and the security
 * suite enforces the boundary.
 */
import { FixtureDashboardDataProvider } from './fixture-provider';
import { DemoGridProvider } from './demo-grid-provider';
import { GoogleSheetsDashboardDataProvider } from './sheets-provider';
import { ReadCache, configuredTtlMs } from '@/lib/server/cache/read-cache';
import {
  resolveEnvironment, liveDataEnabled, EnvironmentConfigError,
} from '@/lib/server/environment/config';
import { processSlot } from '@/lib/server/runtime/process-state';
import { demoStatus } from '@/lib/server/demo/store';
import type { DashboardDataProvider } from './types';
import {
  isTenantId, MissingTenantError, type TenantContext, type TenantId,
} from '@/lib/server/tenant/context';
import {
  resolveTenantDataSource, __resetTenantDataSourcesForTests, type TenantDataSource,
} from '@/lib/server/tenant/data-source';

export * from './types';
export { FixtureDashboardDataProvider } from './fixture-provider';
export { minimizeGuestName, formatMonthLabel } from '@/lib/data/views/workbook-views';
export { GoogleSheetsDashboardDataProvider, LiveDataUnavailableError } from './sheets-provider';

/** Whether this deployment reads its workbook rather than the generated demo dataset. */
export function isLiveDataEnabled(): boolean {
  // The read itself lives beside the other environment reads so the tenant data-source
  // resolver and this module cannot drift into disagreeing about which data is live.
  return liveDataEnabled();
}

/** True while the figures on screen are fictional. Drives the DEMO / UAT badge. */
export function isDemoMode(): boolean {
  return resolveEnvironment().env === 'demo';
}

/**
 * PROVIDERS, ONE PER TENANT — never one per process.
 *
 * `liveProvider` used to be a module-level binding: the first request to need a provider
 * constructed it, and every later request in that process got the same object bound to
 * whichever workbook the environment named. With one customer that is a cache; with two
 * it is a cross-tenant breach, because the second customer would be served the first
 * customer's data source.
 *
 * The registry below holds one THIN provider object per tenant — not one workbook per
 * tenant. The data itself lives in the shared `ReadCache`, whose keys now begin with the
 * tenant, so memory does not grow with the customer list simply by having a registry.
 */
interface CachedProvider {
  /**
   * What this instance was built for. A provider is reused only while its tenant's
   * binding — and, for a demonstration, its dataset version — is still the one it was
   * constructed against. Comparing a fingerprint rather than trusting the tenant key
   * means a re-pointed or suspended tenant gets a NEW provider rather than the old
   * workbook's, which is the difference between a cache and a stale data source.
   */
  fingerprint: string;
  provider: DashboardDataProvider;
}

const providerSlot = processSlot<Map<TenantId, CachedProvider>>('data.providers.byTenant');
let injected: DashboardDataProvider | null = null;

function providerRegistry(): Map<TenantId, CachedProvider> {
  const existing = providerSlot.read();
  if (existing) return existing;
  const created = new Map<TenantId, CachedProvider>();
  providerSlot.write(created);
  return created;
}

/**
 * One cache per process, shared by every provider instance, so concurrent operators on
 * different screens cost one workbook read between them rather than one each.
 *
 * "Per process" has to mean it literally, which is why this is not a module-level
 * binding. The mutation router captures this cache once and calls `invalidate` on it
 * after a verified write. `next dev` re-evaluating this module would hand pages a
 * SECOND, empty cache while the router kept invalidating the first — so a write would
 * clear a cache nobody reads, and screens would serve pre-write figures until the TTL
 * expired. One instance, reachable from both sides, is what makes invalidation mean
 * anything. See lib/server/runtime/process-state.ts.
 */
const cacheSlot = processSlot<ReadCache>('data.providers.readCache');
export function getReadCache(): ReadCache {
  const existing = cacheSlot.read();
  if (existing) return existing;
  const created = new ReadCache({ ttlMs: configuredTtlMs() });
  cacheSlot.write(created);
  return created;
}

/**
 * THE data provider for one tenant.
 *
 * The tenant is an explicit, required argument. There is no ambient "current tenant" and
 * no default: a caller that cannot say whose data it wants does not get any, which is
 * what `MissingTenantError` means. Every call site obtains the context from the
 * authenticated session — `checkPageAccess().tenant` on a page, `ctx.auth` in a handler —
 * so a request can never name its own.
 *
 * WHY THIS IS ASYNC (M-SAAS-1). It used to be synchronous, because the answer came from
 * the environment and the environment is a synchronous read. It now comes from the tenant
 * workbook registry, which is durable state in the control plane — so the workbook a
 * tenant reads is a fact about that tenant rather than a fact about the deployment. That
 * is the entire point of the milestone, and the `await` is what it costs.
 *
 * MAKAM is one workbook per tenant. Today exactly one tenant is registered, and its
 * binding is ENVIRONMENT — so Srivillu reads precisely the workbook it always did. What
 * changed is that the answer is now looked up rather than assumed, and an unregistered
 * tenant is refused instead of quietly inheriting the first customer's data.
 */
export async function getDataProvider(tenant: TenantContext): Promise<DashboardDataProvider> {
  // The test seam stays ahead of the tenant check so a suite can inject a double, but it
  // is still refused a provider without a tenant — the seam does not weaken the rule.
  if (!tenant || !isTenantId(tenant.tenantId)) throw new MissingTenantError('getDataProvider');
  if (injected) return injected;

  /*
   * The environment gate runs BEFORE the registry is consulted. A production deployment
   * that has not enabled live data must fail on that fact alone, without a control-plane
   * round trip and without its answer depending on which tenant asked.
   */
  assertEnvironmentCanServeData();

  const source = await resolveTenantDataSource(tenant.tenantId);
  const fingerprint = fingerprintOf(source);

  const registry = providerRegistry();
  const existing = registry.get(tenant.tenantId);
  if (existing && existing.fingerprint === fingerprint) return existing.provider;

  const provider = buildProviderFor(source);
  registry.set(tenant.tenantId, { fingerprint, provider });
  return provider;
}

function assertEnvironmentCanServeData(): void {
  const resolved = resolveEnvironment();
  if (resolved.env === 'production' && !isLiveDataEnabled()) {
    throw new EnvironmentConfigError(
      'APP_ENV=production requires LIVE_DATA_ENABLED=true. Production has no fixture ' +
      'mode: serving demonstration figures as business figures is not a state this ' +
      'application will enter.',
    );
  }
}

/**
 * What a cached provider was built for.
 *
 * For a workbook-backed tenant that is the binding: re-point or suspend the tenant and
 * the fingerprint changes, so the old provider — and the workbook behind it — is dropped
 * rather than reused.
 *
 * For a demonstration it also carries the dataset version, because the fixtures provider
 * derives its views from the shared demo store: a scenario switch, a reset or a
 * guest-journey request must produce a provider that re-reads. (`DemoGridProvider` tracks
 * write versions itself; this outer key guards the dataset-served slices outside it.)
 */
function fingerprintOf(source: TenantDataSource): string {
  if (source.fixtures) {
    const status = demoStatus();
    return `fixtures|${status.scenario}|${status.seededAt}|${status.mutations}`;
  }
  return `${source.binding.kind}|${source.binding.workbookId ?? 'environment'}`;
}

function buildProviderFor(source: TenantDataSource): DashboardDataProvider {
  /*
   * The fixtures-demo provider reads from the SHARED demo store — the same in-memory
   * workbook the mutation pipeline writes to (Phase C). That is what makes "record an
   * expense and the P&L moves" real behaviour in a demo with no Google workbook.
   *
   * It is shared across tenants because the demonstration deployment HAS one tenant; a
   * deployment with two would have two registry bindings and therefore two workbooks.
   */
  if (source.fixtures) return new DemoGridProvider();

  return new GoogleSheetsDashboardDataProvider({
    tenantId: source.tenantId,
    // This tenant's workbook, resolved from the registry — not the environment's.
    client: source.client,
    cache: getReadCache(),
  });
}

/** Test seam: inject a provider (including one that throws, for error states). */
export function __setDataProviderForTests(provider: DashboardDataProvider | null): void {
  injected = provider;
  if (provider === null) {
    // Every per-tenant instance goes, not just "the" one — there is no longer a single
    // provider to clear, and a leftover entry would serve a later case stale data.
    providerSlot.write(null);
    __resetTenantDataSourcesForTests();
  }
}

/** Test seam: forget the shared cache between cases. */
export function __resetReadCacheForTests(): void {
  cacheSlot.write(null);
}
