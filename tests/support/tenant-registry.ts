/**
 * THE TENANT WORKBOOK REGISTRY, for tests.
 *
 * Production resolves a tenant's workbook from `tenant_workbooks` in the control plane.
 * A suite has no control plane, so it installs a static registry holding the same shape
 * and obeying the same constraints — including that at most one tenant may claim the
 * deployment's ENVIRONMENT workbook, and that two tenants may never share one. A helper
 * that quietly relaxed either would let an isolation test pass against a system that does
 * not isolate.
 *
 * Every suite that exercises the real `getDataProvider` (rather than injecting a double
 * through `__setDataProviderForTests`) must register its tenants, because an unregistered
 * tenant is refused — which is the point of the milestone, not an inconvenience of it.
 */
import {
  StaticTenantWorkbookRegistry, environmentBinding, workbookBinding,
  type TenantWorkbookBinding,
} from '@/lib/server/tenant/workbook-registry';
import {
  __setTenantWorkbookRegistryForTests, __resetTenantDataSourcesForTests,
} from '@/lib/server/tenant/data-source';
import type { TenantId } from '@/lib/server/tenant/context';

/** Install a registry holding exactly these bindings, and drop anything cached before it. */
export function useTenantWorkbooks(bindings: readonly TenantWorkbookBinding[]): void {
  __setTenantWorkbookRegistryForTests(new StaticTenantWorkbookRegistry(bindings));
}

/**
 * The common single-tenant case: this tenant reads whatever the environment configures,
 * exactly as Srivillu does.
 */
export function useEnvironmentTenant(tenantId: TenantId): void {
  useTenantWorkbooks([environmentBinding(tenantId)]);
}

/**
 * Two tenants on two DIFFERENT workbooks.
 *
 * The first keeps the environment's workbook (it stands in for Srivillu); the second
 * names its own. That asymmetry is deliberate — it is the exact shape of the first real
 * onboarding, so the isolation these tests prove is the isolation that will ship.
 */
export function useTwoTenantWorkbooks(
  first: TenantId,
  second: TenantId,
  secondWorkbookId = 'workbook-for-the-second-tenant',
): void {
  useTenantWorkbooks([environmentBinding(first), workbookBinding(second, secondWorkbookId)]);
}

/** Restore the deployment's own registry and forget every resolved binding. */
export function resetTenantWorkbooks(): void {
  __setTenantWorkbookRegistryForTests(null);
  __resetTenantDataSourcesForTests();
}
