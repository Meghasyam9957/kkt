import '@/lib/server/only';
/**
 * WHAT AN INVENTORY SCREEN NEEDS BEFORE IT CAN OFFER AN ACTION.
 *
 * Assembled once, here, for the same reason `assign-context.ts` exists in operations: four
 * screens each asking the roster, the vendor list and the property list their own way is four
 * chances to ask a slightly different question, and the one that drifts is the one nobody
 * notices until it offers somebody an option the server then refuses.
 *
 * NOTHING HERE IS A PERMISSION CHECK. It decides what a form can OFFER; the server decides
 * what may happen. `maySeeMoney` below picks the projection, and the handler picks it again
 * from the same capability table — a page cannot widen what a payload carries by asking
 * nicely.
 */
import { inventoryServiceFor, hrServiceFor, financeServiceFor } from '@/lib/server/api/service';
import { roleHasCapability, type Role } from '@/lib/shared/roles';
import { ensureDemoWorkforce } from '@/lib/server/operations/demo-workforce';
import { MOVEMENT_TYPES, WASTAGE_REASONS } from './types';
import type { TenantContext } from '@/lib/server/tenant/context';

export interface Option { readonly value: string; readonly label: string }

export interface InventoryPageContext {
  /** Everyone who could be named on a movement. Empty when the roster is empty. */
  readonly staff: readonly Option[];
  /** Every item in the workbook, for a form that has to name one. */
  readonly items: readonly Option[];
  /** Finance's vendors — the only vendor identity there is. */
  readonly vendors: readonly Option[];
  /** The caller's own properties, for a transfer's other end. */
  readonly properties: readonly Option[];
  /** Movement types this caller may actually record. */
  readonly movementTypes: readonly Option[];
  readonly wastageReasons: readonly Option[];
  /** Whether this caller is entitled to see a price or a purchase cost. */
  readonly maySeeMoney: boolean;
  /** Whether this caller may correct the count itself. */
  readonly mayAdjust: boolean;
  /** Whether this caller may approve a request or an order. */
  readonly mayApprove: boolean;
}

/**
 * Whether a caller may see money.
 *
 * Read from the capability table rather than from the role, exactly as the handler reads it,
 * so the page and the payload can never disagree about who sees a price.
 */
export function maySeeMoney(role: Role): boolean {
  return roleHasCapability(role, 'finance.read') || roleHasCapability(role, 'procurement.approve');
}

/** The words a person uses, for the vocabulary the schema stores. */
const MOVEMENT_LABELS: Record<string, string> = {
  PURCHASE: 'Purchase — stock arrived',
  CONSUMPTION: 'Consumption — used in the work',
  TRANSFER_IN: 'Transfer in — came from another property',
  TRANSFER_OUT: 'Transfer out — went to another property',
  WASTAGE: 'Wastage — damaged, lost or expired',
  RETURN: 'Return — went back to the vendor',
  ADJUSTMENT: 'Correction — the count itself was wrong',
};

const WASTAGE_LABELS: Record<string, string> = {
  DAMAGED: 'Damaged', LOST: 'Lost', EXPIRED: 'Expired', BROKEN: 'Broken', OTHER: 'Something else',
};

export async function inventoryPageContext(
  tenant: TenantContext, role: Role,
): Promise<InventoryPageContext> {
  /*
   * The demonstration needs people in it before "who used this" means anything. Shared with
   * the operations surfaces, run once per process, and refuses to run anywhere real — see
   * demo-workforce.ts. A configured deployment awaits an already-resolved promise.
   */
  await ensureDemoWorkforce();

  const inventory = inventoryServiceFor();

  /*
   * The roster is read through the HR service, which resolves it in the caller's own tenant.
   * A page that could not read people still works — the employee field simply has nothing to
   * offer, and attribution stays optional, because a movement is a fact whether or not
   * anybody recorded who made it.
   */
  const staffAllowed = roleHasCapability(role, 'operations.staff.read')
    || roleHasCapability(role, 'hr.read');
  const vendorsAllowed = roleHasCapability(role, 'finance.read');

  const [items, employees, vendors, properties] = await Promise.all([
    inventory.stock(tenant),
    staffAllowed ? hrServiceFor().listEmployees(tenant, 'ACTIVE') : Promise.resolve([]),
    vendorsAllowed ? financeServiceFor().listVendors(tenant) : Promise.resolve([]),
    inventoryPropertyIds(tenant),
  ]);

  const mayAdjust = roleHasCapability(role, 'inventory.adjust');

  return {
    staff: employees.map((e) => ({
      value: e.id, label: `${e.preferredName ?? e.fullName} · ${e.employeeCode}`,
    })),
    items: items.map((i) => ({ value: i.itemRef, label: `${i.name} (${i.unit})` })),
    vendors: vendors.map((v) => ({ value: v.id, label: v.displayName })),
    properties: properties.map((id) => ({ value: id, label: id })),
    /*
     * A correction is offered only to somebody who may make one. This is CONVENIENCE, not
     * the control: `POST /api/inventory/movements` checks `inventory.adjust` itself, and
     * hiding an option a caller could still POST would be theatre.
     */
    movementTypes: MOVEMENT_TYPES
      .filter((type) => type !== 'ADJUSTMENT' || mayAdjust)
      .map((type) => ({ value: type, label: MOVEMENT_LABELS[type] ?? type })),
    wastageReasons: WASTAGE_REASONS.map((r) => ({ value: r, label: WASTAGE_LABELS[r] ?? r })),
    maySeeMoney: maySeeMoney(role),
    mayAdjust,
    mayApprove: roleHasCapability(role, 'procurement.approve'),
  };
}

/** The caller's own property identifiers, through the same provider every domain uses. */
async function inventoryPropertyIds(tenant: TenantContext): Promise<readonly string[]> {
  const { getDataProvider } = await import('@/lib/data/providers');
  return (await getDataProvider(tenant)).getPropertyIds();
}
