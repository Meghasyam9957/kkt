import '@/lib/server/only';
/**
 * THE TENANT WORKBOOK REGISTRY — whose data is this?
 *
 * M-SAAS-0 made tenant identity exist and threaded it through the cache, the id
 * sequences, the operation ledger and the audit trail. It stopped one step short of the
 * data itself: `buildProviderFor(tenantId)` took a tenant and then resolved the workbook
 * from the environment, so every tenant read the same records. This module is that last
 * step, and it is deliberately the ONLY way a tenant becomes a data source.
 *
 *   authenticated user -> verified membership -> tenant -> REGISTRY -> provider -> data
 *
 * Three properties, each enforced by construction rather than by convention:
 *
 *   1. **Nothing a caller sends participates.** `lookup` accepts a tenant id and nothing
 *      else. There is no workbook parameter, no override and no options bag — so there is
 *      no argument for a request to poison, in this module or in any caller of it.
 *
 *   2. **Absent means refused.** An unregistered tenant throws. It does not fall back to
 *      the environment, to the first tenant, or to fixtures. A fallback here would
 *      silently serve one customer another customer's business data, which is the single
 *      worst outcome this system has.
 *
 *   3. **Suspended means refused too.** A binding that exists but is not ACTIVE is a
 *      deliberate "stop serving this tenant", and it is honoured as one.
 *
 * The two source kinds mirror `tenant_workbooks` in migration 0005 exactly. See that file
 * for why ENVIRONMENT exists and why at most one tenant may hold it.
 */
import { isTenantId, type TenantId } from './context';

/** Which kind of data source backs a tenant. Mirrors the `tenant_data_source` enum. */
export type TenantDataSourceKind = 'ENVIRONMENT' | 'GOOGLE_SHEETS';

/**
 * One tenant's binding to its data.
 *
 * Frozen for the same reason `TenantContext` is: a binding that could be edited after the
 * registry returned it would not be a boundary, it would be a suggestion.
 */
export interface TenantWorkbookBinding {
  readonly tenantId: TenantId;
  readonly kind: TenantDataSourceKind;
  /**
   * The Google spreadsheet id, or null when the deployment's environment owns the choice.
   *
   * Never a credential, and never sent to a browser: the registry is read with the
   * service role on the server, and no route returns this value.
   */
  readonly workbookId: string | null;
  readonly status: 'ACTIVE' | 'SUSPENDED';
}

/* ------------------------------------------------------------------ *
 * Refusals
 *
 * All three are 403 or 503 rather than 404: whether another customer exists is not
 * something this application confirms or denies to a caller who is not part of it.
 * ------------------------------------------------------------------ */

export class TenantWorkbookNotConfiguredError extends Error {
  readonly httpStatus = 403;
  constructor(tenantId: TenantId) {
    super(
      `Tenant ${tenantId} has no data source configured. Business data cannot be read or `
      + 'written for a tenant that is not registered in tenant_workbooks. This is refused '
      + 'rather than defaulted to the deployment workbook, which would serve one customer '
      + 'the records of another.',
    );
    this.name = 'TenantWorkbookNotConfiguredError';
  }
}

export class TenantWorkbookSuspendedError extends Error {
  readonly httpStatus = 403;
  constructor(tenantId: TenantId) {
    super(
      `Tenant ${tenantId} has a data source but it is SUSPENDED. Suspension is a `
      + 'deliberate instruction to stop serving this tenant and is honoured as one.',
    );
    this.name = 'TenantWorkbookSuspendedError';
  }
}

/**
 * The registry itself could not be consulted — the table is missing, or the control
 * plane is unreachable. Distinct from "this tenant is not registered" because the
 * operator action is completely different: apply migration 0005, versus provision a
 * tenant. 503, because it is this deployment that is unwell, not the request.
 */
export class TenantRegistryUnavailableError extends Error {
  readonly httpStatus = 503;
  constructor(reason: string) {
    super(
      `The tenant workbook registry could not be consulted: ${reason}. `
      + 'If this deployment has not applied supabase/migrations/0005_tenant_workbooks.sql, '
      + 'apply it and restart. No request is served from an unverified data source.',
    );
    this.name = 'TenantRegistryUnavailableError';
  }
}

/** Resolves a tenant to its data source, or refuses. The only such lookup in the system. */
export interface TenantWorkbookRegistry {
  lookup(tenantId: TenantId): Promise<TenantWorkbookBinding>;
}

/* ------------------------------------------------------------------ *
 * Binding constructors
 * ------------------------------------------------------------------ */

export function environmentBinding(tenantId: TenantId): TenantWorkbookBinding {
  return Object.freeze({
    tenantId, kind: 'ENVIRONMENT' as const, workbookId: null, status: 'ACTIVE' as const,
  });
}

export function workbookBinding(tenantId: TenantId, workbookId: string): TenantWorkbookBinding {
  return Object.freeze({
    tenantId, kind: 'GOOGLE_SHEETS' as const, workbookId, status: 'ACTIVE' as const,
  });
}

/** The binding invariants migration 0005 enforces in SQL, checked in code as well. */
function assertBindingShape(binding: TenantWorkbookBinding): void {
  if (binding.kind === 'ENVIRONMENT' && binding.workbookId !== null) {
    throw new Error(
      `Tenant ${binding.tenantId}: an ENVIRONMENT binding must not name a workbook — `
      + 'it would be ambiguous which of the two wins.',
    );
  }
  if (binding.kind === 'GOOGLE_SHEETS' && (binding.workbookId ?? '').trim() === '') {
    throw new Error(
      `Tenant ${binding.tenantId}: a GOOGLE_SHEETS binding must name a workbook — `
      + 'one without would silently fall back to the deployment workbook.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Static registry — demonstration deployments and tests
 * ------------------------------------------------------------------ */

/**
 * A registry held in memory.
 *
 * Used by the two deployments that have no control-plane database: a demonstration
 * running on the identity chooser, and the test suite. It mirrors the SQL constraints —
 * including that at most one tenant may hold the ENVIRONMENT source, and that two tenants
 * may never share a workbook — so a suite passing against it is testing the rules
 * production enforces rather than a laxer imitation of them.
 */
export class StaticTenantWorkbookRegistry implements TenantWorkbookRegistry {
  private readonly bindings = new Map<TenantId, TenantWorkbookBinding>();

  constructor(bindings: readonly TenantWorkbookBinding[] = []) {
    for (const binding of bindings) this.set(binding);
  }

  set(binding: TenantWorkbookBinding): this {
    if (!isTenantId(binding.tenantId)) {
      throw new Error('A workbook binding needs a tenant; refusing to register one without.');
    }
    assertBindingShape(binding);

    for (const existing of this.bindings.values()) {
      if (existing.tenantId === binding.tenantId) continue;
      if (binding.kind === 'ENVIRONMENT' && existing.kind === 'ENVIRONMENT') {
        throw new Error(
          `Tenants ${existing.tenantId} and ${binding.tenantId} both claim the `
          + 'environment workbook of this deployment. At most one may — otherwise '
          + 'ENVIRONMENT becomes the default that this milestone exists to remove.',
        );
      }
      if (binding.workbookId !== null && existing.workbookId === binding.workbookId) {
        throw new Error(
          `Tenants ${existing.tenantId} and ${binding.tenantId} are pointed at the same `
          + 'workbook. That is a cross-tenant data breach expressed as configuration.',
        );
      }
    }

    this.bindings.set(binding.tenantId, Object.freeze({ ...binding }));
    return this;
  }

  async lookup(tenantId: TenantId): Promise<TenantWorkbookBinding> {
    const binding = this.bindings.get(tenantId);
    if (!binding) throw new TenantWorkbookNotConfiguredError(tenantId);
    if (binding.status !== 'ACTIVE') throw new TenantWorkbookSuspendedError(tenantId);
    return binding;
  }
}

/* ------------------------------------------------------------------ *
 * Supabase registry — the real control plane
 * ------------------------------------------------------------------ */

/**
 * Reads `tenant_workbooks` with the service role.
 *
 * Keyed by the tenant id the auth provider already resolved from a verified membership.
 * The query accepts nothing else, so — exactly as with the membership query it mirrors —
 * there is no parameter for a caller to poison.
 */
export class SupabaseTenantWorkbookRegistry implements TenantWorkbookRegistry {
  constructor(private readonly client: any) {}

  async lookup(tenantId: TenantId): Promise<TenantWorkbookBinding> {
    if (!isTenantId(tenantId)) throw new TenantWorkbookNotConfiguredError(String(tenantId));

    const { data, error } = await this.client
      .from('tenant_workbooks')
      .select('tenant_id, source, workbook_ref, status')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    // A query error is the control plane failing, NOT a missing tenant. Reporting it as
    // "not configured" would send an operator to provision a tenant that already exists.
    if (error) throw new TenantRegistryUnavailableError(String(error.message ?? 'query failed'));
    if (!data) throw new TenantWorkbookNotConfiguredError(tenantId);

    if (data.source !== 'ENVIRONMENT' && data.source !== 'GOOGLE_SHEETS') {
      throw new TenantRegistryUnavailableError(
        `unknown data source "${String(data.source)}" for tenant ${tenantId}`,
      );
    }
    const kind: TenantDataSourceKind = data.source;

    const binding: TenantWorkbookBinding = Object.freeze({
      tenantId,
      kind,
      workbookId: kind === 'GOOGLE_SHEETS' ? String(data.workbook_ref ?? '') : null,
      status: data.status === 'ACTIVE' ? ('ACTIVE' as const) : ('SUSPENDED' as const),
    });

    if (binding.status !== 'ACTIVE') throw new TenantWorkbookSuspendedError(tenantId);
    // A row that violates the SQL check constraint should be impossible; if one exists,
    // refusing is the only safe reading of it.
    assertBindingShape(binding);
    return binding;
  }
}
