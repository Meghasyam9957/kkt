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
import { createLiveSheetsClient } from '@/lib/server/sheets/config';
import { ReadCache, configuredTtlMs } from '@/lib/server/cache/read-cache';
import { resolveEnvironment, EnvironmentConfigError } from '@/lib/server/environment/config';
import { processSlot } from '@/lib/server/runtime/process-state';
import { currentDataset, demoStatus } from '@/lib/server/demo/store';
import type { DashboardDataProvider } from './types';
import {
  isTenantId, MissingTenantError, type TenantContext, type TenantId,
} from '@/lib/server/tenant/context';

export * from './types';
export { FixtureDashboardDataProvider } from './fixture-provider';
export { minimizeGuestName, formatMonthLabel } from '@/lib/data/views/workbook-views';
export { GoogleSheetsDashboardDataProvider, LiveDataUnavailableError } from './sheets-provider';

/** Whether this deployment reads its workbook rather than the generated demo dataset. */
export function isLiveDataEnabled(): boolean {
  const raw = process.env.LIVE_DATA_ENABLED ?? 'false';
  return String(raw).toLowerCase() === 'true';
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
const providerSlot = processSlot<Map<TenantId, DashboardDataProvider>>('data.providers.byTenant');
let injected: DashboardDataProvider | null = null;

function providerRegistry(): Map<TenantId, DashboardDataProvider> {
  const existing = providerSlot.read();
  if (existing) return existing;
  const created = new Map<TenantId, DashboardDataProvider>();
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

/*
 * The fixtures-demo provider reads from the SHARED demo store — the same in-memory
 * workbook the mutation pipeline writes to (Phase C). It re-derives every view when the
 * store's version moves: a scenario switch, a reset, a guest-journey request, or a web
 * write. That is what makes "record an expense and the P&L moves" real behaviour in a
 * demo with no Google workbook configured.
 */
const demoProviders = new Map<string, { key: string; provider: DashboardDataProvider }>();

function demoFixtureProvider(tenantId: TenantId): DashboardDataProvider {
  const status = demoStatus();
  // The DemoGridProvider tracks write versions itself; this outer key only guards the
  // dataset-served slices (guest requests) that sit outside the grid store.
  const key = `${status.scenario}|${status.seededAt}|${status.mutations}`;
  /*
   * Keyed by TENANT as well. One deployment configures one workbook, so today two
   * tenants would read the same records — but they must not share an instance, because
   * an instance is what a later milestone binds to a workbook. Keeping them separate
   * now means that milestone changes what a provider READS, not who holds one.
   */
  const existing = demoProviders.get(tenantId);
  if (existing && existing.key === key) return existing.provider;

  const provider = new DemoGridProvider();
  demoProviders.set(tenantId, { key, provider });
  return provider;
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
 * MAKAM is one workbook per tenant. Today exactly one tenant is configured and its
 * workbook is the environment's, which is why the resolution below is unchanged; what
 * changed is that the ANSWER is now keyed by who asked.
 */
export function getDataProvider(tenant: TenantContext): DashboardDataProvider {
  // The test seam stays ahead of the tenant check so a suite can inject a double, but it
  // is still refused a provider without a tenant — the seam does not weaken the rule.
  if (!tenant || !isTenantId(tenant.tenantId)) throw new MissingTenantError('getDataProvider');
  if (injected) return injected;

  const registry = providerRegistry();
  const existing = registry.get(tenant.tenantId);
  if (existing) return existing;

  const created = buildProviderFor(tenant.tenantId);
  registry.set(tenant.tenantId, created);
  return created;
}

function buildProviderFor(tenantId: TenantId): DashboardDataProvider {
  const resolved = resolveEnvironment();

  if (resolved.env === 'production') {
    if (!isLiveDataEnabled()) {
      throw new EnvironmentConfigError(
        'APP_ENV=production requires LIVE_DATA_ENABLED=true. Production has no fixture ' +
        'mode: serving demonstration figures as business figures is not a state this ' +
        'application will enter.',
      );
    }
    // createLiveSheetsClient reads PRODUCTION_* only, and throws with the missing
    // variable names if they are absent. It cannot reach the demo workbook.
    return new GoogleSheetsDashboardDataProvider({
      tenantId,
      client: createLiveSheetsClient(resolved),
      cache: getReadCache(),
    });
  }

  /* ---- demo ---- */
  if (isLiveDataEnabled()) {
    // The DEMO workbook, read through DEMO_* credentials only.
    return new GoogleSheetsDashboardDataProvider({
      tenantId,
      client: createLiveSheetsClient(resolved),
      cache: getReadCache(),
    });
  }

  return demoFixtureProvider(tenantId);
}

/** Test seam: inject a provider (including one that throws, for error states). */
export function __setDataProviderForTests(provider: DashboardDataProvider | null): void {
  injected = provider;
  if (provider === null) {
    // Every per-tenant instance goes, not just "the" one — there is no longer a single
    // provider to clear, and a leftover entry would serve a later case stale data.
    providerSlot.write(null);
    demoProviders.clear();
  }
}

/** Test seam: forget the shared cache between cases. */
export function __resetReadCacheForTests(): void {
  cacheSlot.write(null);
}
