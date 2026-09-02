import '@/lib/server/only';
/**
 * THE TENANT BOUNDARY.
 *
 * MAKAM is the product; a tenant is one customer. Every piece of business data belongs
 * to exactly one, and nothing in this application may read or write any of it without
 * saying which.
 *
 * Three rules, and all three are enforced by construction rather than by convention:
 *
 *   1. **A tenant is resolved from the authenticated user's membership, and from
 *      nowhere else.** Not a query parameter, not a route segment, not a header, not a
 *      cookie value that is not cryptographically bound to the identity. The resolution
 *      happens inside the auth providers — the same place, and the only place, that
 *      already resolves role and investor scope.
 *
 *   2. **It is immutable within a request.** `requireTenant` returns a frozen object.
 *      There is no setter, no ambient mutable holder and no way to swap it half-way
 *      through a call chain.
 *
 *   3. **Missing means refused, never "all".** An absent tenant throws
 *      `MissingTenantError`. That is the opposite of the failure mode that makes
 *      multi-tenant systems leak, where a null scope quietly widens to everything —
 *      exactly the shape `IDENTITY_SCOPED_RESOURCES` already refuses for investors.
 *
 * There is no global tenant. A module-level "current tenant" would be wrong in the same
 * way a module-level provider is wrong: one process serves many requests, and whichever
 * request wrote last would decide what every other request sees.
 */
import type { Role } from '@/lib/shared/roles';

/** A tenant's stable identifier. Opaque to the application: never parsed, never ordered. */
export type TenantId = string;

/**
 * Who is asking, and on whose behalf.
 *
 * Carries the role alongside the tenant because every consumer that needs one needs the
 * other, and passing them separately is how they drift apart.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly role: Role;
}

export class MissingTenantError extends Error {
  readonly httpStatus = 403;
  constructor(where: string) {
    super(
      `No tenant context at ${where}. Business data cannot be read or written without a ` +
      'tenant; this is refused rather than widened.',
    );
    this.name = 'MissingTenantError';
  }
}

/**
 * Build the context, or refuse.
 *
 * `where` names the call site so a failure says which boundary was crossed without one,
 * rather than surfacing as an undefined further down.
 */
export function requireTenant(
  input: { tenantId?: string | null; userId?: string | null; role?: Role | null },
  where: string,
): TenantContext {
  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  if (tenantId === '') throw new MissingTenantError(where);
  if (!input.userId || !input.role) throw new MissingTenantError(where);

  // Frozen: a context that could be edited after the guard checked it would not be a
  // boundary, it would be a suggestion.
  return Object.freeze({ tenantId, userId: input.userId, role: input.role });
}

/** True when a value can serve as a tenant identifier at all. Used by fail-closed guards. */
export function isTenantId(value: unknown): value is TenantId {
  return typeof value === 'string' && value.trim() !== '';
}
