import '@/lib/server/only';
/**
 * THE INVENTORY OVERLAY, ON POSTGRES.
 *
 *   1. NO LOGIC HERE. Every rule — lifecycle transitions, self-approval, which column a
 *      movement lands in, whether the workbook write may proceed — lives in the service. This
 *      file maps rows to domain objects and back.
 *   2. THREE HELPERS, ONE PLACE TO GET THE TENANT RIGHT. `scoped()` filters every read,
 *      `updateRow()` carries both predicates, and inserts stamp `tenant_id` LAST so a
 *      caller-supplied one is overwritten rather than honoured.
 *
 * M-INFRA-1 found three defects in twins exactly like this one — a column that did not exist,
 * an enum value that did not exist, and a missing step — none visible to a recorder-based
 * test, because a recorder has no schema. So the column names below are checked against the
 * real migrated schema by `tests/infrastructure/inventory-schema.test.ts`, and the behaviour
 * is re-asserted through real PostgREST by the staging suite when one is configured.
 */
import { requireTenant, type TenantContext } from '@/lib/server/tenant/context';
import type {
  InventoryRepository, MovementRow, MovementFilter, MovementTotals, VendorLink,
  AssetMaintenanceLink, NewRequest, NewPurchaseOrder, NewGoodsReceipt,
} from './repository';
import type {
  Movement, PurchaseRequest, RequestStatus, PurchaseOrder, PoStatus, GoodsReceipt,
} from './types';

const MOVEMENTS = 'inv_movements';
const VENDOR_LINKS = 'inv_vendor_links';
const REQUESTS = 'inv_purchase_requests';
const REQUEST_LINES = 'inv_purchase_request_lines';
const ORDERS = 'inv_purchase_orders';
const ORDER_LINES = 'inv_purchase_order_lines';
const RECEIPTS = 'inv_goods_receipts';
const RECEIPT_LINES = 'inv_goods_receipt_lines';
const ASSET_LINKS = 'inv_asset_maintenance_links';

/** Tables with no `updated_at` column, so an update never stamps one that is not there. */
export const INVENTORY_WITHOUT_UPDATED_AT: ReadonlySet<string> = new Set([
  MOVEMENTS, VENDOR_LINKS, REQUEST_LINES, ORDER_LINES, RECEIPTS, RECEIPT_LINES, ASSET_LINKS,
]);

export class SupabaseInventoryRepository implements InventoryRepository {
  // The Supabase client, as every other twin in this codebase takes it.
  constructor(private readonly client: any) {}

  private scoped(table: string, tenant: TenantContext, columns = '*') {
    const { tenantId } = requireTenant(tenant, `SupabaseInventoryRepository.${table}`);
    return this.client.from(table).select(columns).eq('tenant_id', tenantId);
  }

  private async insertRow(
    table: string, tenant: TenantContext, values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { tenantId } = requireTenant(tenant, `SupabaseInventoryRepository.${table}`);
    const { data, error } = await this.client
      .from(table)
      // `tenant_id` LAST: a caller-supplied one is overwritten, never honoured.
      .insert({ ...values, tenant_id: tenantId })
      .select('*')
      .single();
    if (error) throw new Error(String(error.message ?? `${table} insert failed`));
    return data as Record<string, unknown>;
  }

  private async updateRow(
    table: string, tenant: TenantContext, id: string, patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const { tenantId } = requireTenant(tenant, `SupabaseInventoryRepository.${table}`);
    const { data, error } = await this.client
      .from(table)
      .update(INVENTORY_WITHOUT_UPDATED_AT.has(table)
        ? { ...patch }
        : { ...patch, updated_at: new Date().toISOString() })
      // Both predicates, always. `id` alone updates another tenant's row the moment an
      // identifier leaks.
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(String(error.message ?? `${table} update failed`));
    return (data ?? null) as Record<string, unknown> | null;
  }

  private static rows(result: { data: unknown; error: unknown }): Record<string, unknown>[] {
    if (result.error) {
      throw new Error(String((result.error as { message?: string }).message ?? 'query failed'));
    }
    return (result.data ?? []) as Record<string, unknown>[];
  }

  /* ---- movements ---- */

  async recordMovement(t: TenantContext, row: MovementRow, actor: string): Promise<Movement> {
    const stamp = new Date().toISOString();
    const data = await this.insertRow(MOVEMENTS, t, {
      item_ref: row.itemRef,
      property_id: row.propertyId,
      movement_type: row.movementType,
      quantity: row.quantity,
      employee_id: row.employeeId,
      task_type: row.taskType,
      task_ref: row.taskRef,
      reason: row.reason,
      wastage_reason: row.wastageReason,
      counterparty_property_id: row.counterpartyPropertyId,
      workbook_applied: row.workbookApplied,
      applied_at: row.workbookApplied ? stamp : null,
      created_by: actor,
    });
    return toMovement(data);
  }

  async markMovementApplied(t: TenantContext, id: string): Promise<Movement | null> {
    const row = await this.updateRow(MOVEMENTS, t, id, {
      workbook_applied: true, applied_at: new Date().toISOString(),
    });
    return row ? toMovement(row) : null;
  }

  async getMovement(t: TenantContext, id: string): Promise<Movement | null> {
    const rows = SupabaseInventoryRepository.rows(
      await this.scoped(MOVEMENTS, t).eq('id', id).limit(1));
    return rows[0] ? toMovement(rows[0]) : null;
  }

  async listMovements(t: TenantContext, filter: MovementFilter = {}): Promise<Movement[]> {
    let query = this.scoped(MOVEMENTS, t);
    if (filter.itemRef) query = query.eq('item_ref', filter.itemRef);
    if (filter.propertyId) query = query.eq('property_id', filter.propertyId);
    if (filter.taskType) query = query.eq('task_type', filter.taskType);
    if (filter.taskRef) query = query.eq('task_ref', filter.taskRef);
    if (filter.unappliedOnly) query = query.eq('workbook_applied', false);
    query = query.order('created_at', { ascending: false });
    if (filter.limit) query = query.limit(filter.limit);
    return SupabaseInventoryRepository.rows(await query).map(toMovement);
  }

  async movementTotals(t: TenantContext): Promise<Map<string, MovementTotals>> {
    /*
     * Summed in the application rather than by the database on purpose. A SQL aggregate would
     * be faster and would also be the first step towards a stored balance — a view, then a
     * materialised one, then a column. Reading the rows keeps this a comparison over events.
     */
    const rows = SupabaseInventoryRepository.rows(await this.scoped(MOVEMENTS, t))
      .map(toMovement);
    const totals = new Map<string, { purchased: number; used: number; unapplied: number }>();
    for (const m of rows) {
      const entry = totals.get(m.itemRef) ?? { purchased: 0, used: 0, unapplied: 0 };
      if (!m.workbookApplied) entry.unapplied += 1;
      else if (m.movementType === 'PURCHASE' || m.movementType === 'TRANSFER_IN'
        || (m.movementType === 'ADJUSTMENT' && (m.reason ?? '').startsWith('[+]'))) {
        entry.purchased += m.quantity;
      } else entry.used += m.quantity;
      totals.set(m.itemRef, entry);
    }
    return new Map([...totals].map(([k, v]) => [k, Object.freeze(v)]));
  }

  /* ---- vendor identity ---- */

  async linkVendor(
    t: TenantContext, name: string, vendorId: string, actor: string,
  ): Promise<VendorLink | null> {
    const { tenantId } = requireTenant(t, 'linkVendor');
    const { data, error } = await this.client
      .from(VENDOR_LINKS)
      .insert({ vendor_name: name.trim(), vendor_id: vendorId, linked_by: actor, tenant_id: tenantId })
      .select('*')
      .single();
    // 23505 is the unique index refusing a second meaning for one name — the concurrency
    // case, reported as null so the service can say so rather than crash.
    if (error) {
      if (String((error as { code?: string }).code) === '23505') return null;
      throw new Error(String(error.message ?? 'vendor link failed'));
    }
    return toVendorLink(data as Record<string, unknown>);
  }

  async listVendorLinks(t: TenantContext): Promise<VendorLink[]> {
    return SupabaseInventoryRepository.rows(await this.scoped(VENDOR_LINKS, t))
      .map(toVendorLink);
  }

  /* ---- procurement ---- */

  async createRequest(t: TenantContext, input: NewRequest, actor: string): Promise<PurchaseRequest> {
    const head = await this.insertRow(REQUESTS, t, {
      property_id: input.propertyId, priority: input.priority,
      reason: input.reason, requested_by: actor, status: 'DRAFT',
    });
    for (const line of input.lines) {
      await this.insertRow(REQUEST_LINES, t, {
        request_id: head.id, item_ref: line.itemRef, description: line.description,
        quantity: line.quantity, unit: line.unit,
      });
    }
    return (await this.getRequest(t, String(head.id)))!;
  }

  async getRequest(t: TenantContext, id: string): Promise<PurchaseRequest | null> {
    const heads = SupabaseInventoryRepository.rows(
      await this.scoped(REQUESTS, t).eq('id', id).limit(1));
    if (!heads[0]) return null;
    const lines = SupabaseInventoryRepository.rows(
      await this.scoped(REQUEST_LINES, t).eq('request_id', id));
    return toRequest(heads[0], lines);
  }

  async listRequests(t: TenantContext, status?: RequestStatus): Promise<PurchaseRequest[]> {
    let query = this.scoped(REQUESTS, t);
    if (status) query = query.eq('status', status);
    const heads = SupabaseInventoryRepository.rows(
      await query.order('created_at', { ascending: false }));
    const lines = SupabaseInventoryRepository.rows(await this.scoped(REQUEST_LINES, t));
    return heads.map((h) => toRequest(h, lines.filter((l) => l.request_id === h.id)));
  }

  async transitionRequest(
    t: TenantContext, id: string, next: RequestStatus, actor: string, note: string | null,
  ): Promise<PurchaseRequest | null> {
    const decided = next === 'APPROVED' || next === 'REJECTED';
    const row = await this.updateRow(REQUESTS, t, id, {
      status: next,
      ...(decided
        ? { approved_by: actor, approved_at: new Date().toISOString(), decision_note: note }
        : {}),
    });
    return row ? this.getRequest(t, id) : null;
  }

  async createPurchaseOrder(
    t: TenantContext, input: NewPurchaseOrder, actor: string,
  ): Promise<PurchaseOrder> {
    const head = await this.insertRow(ORDERS, t, {
      vendor_id: input.vendorId, property_id: input.propertyId, request_id: input.requestId,
      order_date: input.orderDate, expected_date: input.expectedDate,
      created_by: actor, status: 'DRAFT',
    });
    for (const line of input.lines) {
      await this.insertRow(ORDER_LINES, t, {
        po_id: head.id, item_ref: line.itemRef, description: line.description,
        quantity: line.quantity, unit: line.unit,
        expected_unit_price_minor: line.expectedUnitPriceMinor,
      });
    }
    return (await this.getPurchaseOrder(t, String(head.id)))!;
  }

  async getPurchaseOrder(t: TenantContext, id: string): Promise<PurchaseOrder | null> {
    const heads = SupabaseInventoryRepository.rows(
      await this.scoped(ORDERS, t).eq('id', id).limit(1));
    if (!heads[0]) return null;
    const lines = SupabaseInventoryRepository.rows(
      await this.scoped(ORDER_LINES, t).eq('po_id', id));
    return toOrder(heads[0], lines);
  }

  async listPurchaseOrders(t: TenantContext, status?: PoStatus): Promise<PurchaseOrder[]> {
    let query = this.scoped(ORDERS, t);
    if (status) query = query.eq('status', status);
    const heads = SupabaseInventoryRepository.rows(
      await query.order('created_at', { ascending: false }));
    const lines = SupabaseInventoryRepository.rows(await this.scoped(ORDER_LINES, t));
    return heads.map((h) => toOrder(h, lines.filter((l) => l.po_id === h.id)));
  }

  async transitionPurchaseOrder(
    t: TenantContext, id: string, next: PoStatus, actor: string,
  ): Promise<PurchaseOrder | null> {
    const row = await this.updateRow(ORDERS, t, id, {
      status: next,
      ...(next === 'APPROVED'
        ? { approved_by: actor, approved_at: new Date().toISOString() } : {}),
    });
    return row ? this.getPurchaseOrder(t, id) : null;
  }

  async createGoodsReceipt(
    t: TenantContext, input: NewGoodsReceipt, actor: string,
  ): Promise<GoodsReceipt> {
    const head = await this.insertRow(RECEIPTS, t, {
      po_id: input.poId, property_id: input.propertyId,
      received_by: actor, notes: input.notes,
    });
    for (const line of input.lines) {
      await this.insertRow(RECEIPT_LINES, t, {
        receipt_id: head.id, po_line_id: line.poLineId,
        received_quantity: line.receivedQuantity, condition: line.condition,
      });
    }
    const all = await this.listGoodsReceipts(t, input.poId);
    return all.find((r) => r.id === String(head.id))!;
  }

  async listGoodsReceipts(t: TenantContext, poId?: string): Promise<GoodsReceipt[]> {
    let query = this.scoped(RECEIPTS, t);
    if (poId) query = query.eq('po_id', poId);
    const heads = SupabaseInventoryRepository.rows(
      await query.order('received_at', { ascending: false }));
    const lines = SupabaseInventoryRepository.rows(await this.scoped(RECEIPT_LINES, t));
    return heads.map((h) => toReceipt(h, lines.filter((l) => l.receipt_id === h.id)));
  }

  async attachMovementToReceiptLine(
    t: TenantContext, lineId: string, movementId: string,
  ): Promise<void> {
    await this.updateRow(RECEIPT_LINES, t, lineId, { movement_id: movementId });
  }

  /* ---- assets ---- */

  async linkAssetTicket(
    t: TenantContext, assetRef: string, ticketRef: string, actor: string, note: string | null,
  ): Promise<AssetMaintenanceLink | null> {
    const { tenantId } = requireTenant(t, 'linkAssetTicket');
    const { data, error } = await this.client
      .from(ASSET_LINKS)
      .insert({
        asset_ref: assetRef, ticket_ref: ticketRef, linked_by: actor, note,
        tenant_id: tenantId,
      })
      .select('*')
      .single();
    if (error) {
      if (String((error as { code?: string }).code) === '23505') return null;
      throw new Error(String(error.message ?? 'asset link failed'));
    }
    return toAssetLink(data as Record<string, unknown>);
  }

  async listAssetLinks(t: TenantContext, assetRef?: string): Promise<AssetMaintenanceLink[]> {
    let query = this.scoped(ASSET_LINKS, t);
    if (assetRef) query = query.eq('asset_ref', assetRef);
    return SupabaseInventoryRepository.rows(await query).map(toAssetLink);
  }
}

/* ------------------------------------------------------------------ *
 * Row → domain
 * ------------------------------------------------------------------ */

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => String(v ?? '');
const nul = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toMovement(row: Record<string, unknown>): Movement {
  return Object.freeze({
    id: str(row.id), tenantId: str(row.tenant_id),
    itemRef: str(row.item_ref), propertyId: nul(row.property_id),
    movementType: row.movement_type as Movement['movementType'],
    quantity: num(row.quantity),
    employeeId: nul(row.employee_id),
    taskType: (row.task_type ?? null) as Movement['taskType'],
    taskRef: nul(row.task_ref),
    reason: nul(row.reason),
    wastageReason: (row.wastage_reason ?? null) as Movement['wastageReason'],
    counterpartyPropertyId: nul(row.counterparty_property_id),
    workbookApplied: Boolean(row.workbook_applied),
    appliedAt: nul(row.applied_at),
    createdBy: nul(row.created_by),
    createdAt: str(row.created_at),
  });
}

function toVendorLink(row: Record<string, unknown>): VendorLink {
  return Object.freeze({
    id: str(row.id), tenantId: str(row.tenant_id),
    vendorName: str(row.vendor_name), vendorId: str(row.vendor_id),
    linkedBy: nul(row.linked_by), createdAt: str(row.created_at),
  });
}

function toAssetLink(row: Record<string, unknown>): AssetMaintenanceLink {
  return Object.freeze({
    id: str(row.id), tenantId: str(row.tenant_id),
    assetRef: str(row.asset_ref), ticketRef: str(row.ticket_ref),
    linkedBy: nul(row.linked_by), note: nul(row.note), createdAt: str(row.created_at),
  });
}

function toRequest(
  row: Record<string, unknown>, lines: Record<string, unknown>[],
): PurchaseRequest {
  return Object.freeze({
    id: str(row.id), tenantId: str(row.tenant_id),
    propertyId: nul(row.property_id), status: row.status as PurchaseRequest['status'],
    priority: str(row.priority), reason: nul(row.reason),
    requestedBy: str(row.requested_by), approvedBy: nul(row.approved_by),
    approvedAt: nul(row.approved_at), decisionNote: nul(row.decision_note),
    createdAt: str(row.created_at),
    lines: lines.map((l) => Object.freeze({
      id: str(l.id), itemRef: nul(l.item_ref), description: nul(l.description),
      quantity: num(l.quantity), unit: nul(l.unit),
    })),
  });
}

function toOrder(row: Record<string, unknown>, lines: Record<string, unknown>[]): PurchaseOrder {
  return Object.freeze({
    id: str(row.id), tenantId: str(row.tenant_id),
    vendorId: str(row.vendor_id), propertyId: nul(row.property_id),
    requestId: nul(row.request_id), status: row.status as PurchaseOrder['status'],
    orderDate: nul(row.order_date), expectedDate: nul(row.expected_date),
    createdBy: str(row.created_by), approvedBy: nul(row.approved_by),
    approvedAt: nul(row.approved_at), createdAt: str(row.created_at),
    lines: lines.map((l) => Object.freeze({
      id: str(l.id), itemRef: nul(l.item_ref), description: nul(l.description),
      quantity: num(l.quantity), unit: nul(l.unit),
      expectedUnitPriceMinor: l.expected_unit_price_minor === null
        || l.expected_unit_price_minor === undefined
        ? null : Number(l.expected_unit_price_minor),
    })),
  });
}

function toReceipt(row: Record<string, unknown>, lines: Record<string, unknown>[]): GoodsReceipt {
  return Object.freeze({
    id: str(row.id), tenantId: str(row.tenant_id),
    poId: str(row.po_id), propertyId: nul(row.property_id),
    receivedBy: str(row.received_by), receivedAt: str(row.received_at),
    notes: nul(row.notes),
    lines: lines.map((l) => Object.freeze({
      id: str(l.id), poLineId: str(l.po_line_id),
      receivedQuantity: num(l.received_quantity), condition: nul(l.condition),
      movementId: nul(l.movement_id),
    })),
  });
}
