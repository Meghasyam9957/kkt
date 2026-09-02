import '@/lib/server/only';
/**
 * THE INVENTORY OVERLAY STORE.
 *
 * Two twins, as every domain here has: an in-memory one the tests execute, and a Supabase one
 * with no logic in it at all. The rules live in the service; this only reads and writes rows.
 *
 * THE INVARIANT THAT MATTERS, and it is the same one every repository in this project holds:
 * every method takes a `TenantContext` first, every read is filtered by it, every update
 * carries BOTH predicates, and `tenant_id` is stamped LAST on insert so a caller-supplied one
 * is overwritten rather than honoured.
 *
 * NOTHING HERE SUMS A QUANTITY INTO A BALANCE. `movementTotals` adds up recorded movements so
 * that reconciliation can compare them against the workbook's own totals — a comparison, and
 * deliberately not a stock level. There is no method that returns "how much is there", because
 * that question has one answer and it lives in the sheet.
 */
import { randomUUID } from 'node:crypto';
import { requireTenant, type TenantContext } from '@/lib/server/tenant/context';
import type {
  Movement, MovementType, WastageReason, PurchaseRequest, RequestLine, RequestStatus,
  PurchaseOrder, PoLine, PoStatus, GoodsReceipt, GoodsReceiptLine,
} from './types';
import type { TaskType } from '@/lib/server/operations/types';

export interface VendorLink {
  readonly id: string;
  readonly tenantId: string;
  readonly vendorName: string;
  readonly vendorId: string;
  readonly linkedBy: string | null;
  readonly createdAt: string;
}

export interface AssetMaintenanceLink {
  readonly id: string;
  readonly tenantId: string;
  readonly assetRef: string;
  readonly ticketRef: string;
  readonly linkedBy: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface MovementRow {
  readonly itemRef: string;
  readonly propertyId: string | null;
  readonly movementType: MovementType;
  readonly quantity: number;
  readonly employeeId: string | null;
  readonly taskType: TaskType | null;
  readonly taskRef: string | null;
  readonly reason: string | null;
  readonly wastageReason: WastageReason | null;
  readonly counterpartyPropertyId: string | null;
  readonly workbookApplied: boolean;
}

/** Sums of recorded context, for comparison against the workbook. Never a balance. */
export interface MovementTotals {
  readonly purchased: number;
  readonly used: number;
  readonly unapplied: number;
}

export interface MovementFilter {
  readonly itemRef?: string;
  readonly propertyId?: string;
  readonly taskType?: TaskType;
  readonly taskRef?: string;
  readonly unappliedOnly?: boolean;
  readonly limit?: number;
}

export interface InventoryRepository {
  /* movements */
  recordMovement(t: TenantContext, row: MovementRow, actor: string): Promise<Movement>;
  markMovementApplied(t: TenantContext, id: string): Promise<Movement | null>;
  listMovements(t: TenantContext, filter?: MovementFilter): Promise<Movement[]>;
  getMovement(t: TenantContext, id: string): Promise<Movement | null>;
  /** Per item, the sums of what this database has context for. */
  movementTotals(t: TenantContext): Promise<Map<string, MovementTotals>>;

  /* vendor identity */
  linkVendor(t: TenantContext, name: string, vendorId: string, actor: string): Promise<VendorLink | null>;
  listVendorLinks(t: TenantContext): Promise<VendorLink[]>;

  /* procurement */
  createRequest(t: TenantContext, input: NewRequest, actor: string): Promise<PurchaseRequest>;
  getRequest(t: TenantContext, id: string): Promise<PurchaseRequest | null>;
  listRequests(t: TenantContext, status?: RequestStatus): Promise<PurchaseRequest[]>;
  transitionRequest(
    t: TenantContext, id: string, next: RequestStatus, actor: string, note: string | null,
  ): Promise<PurchaseRequest | null>;

  createPurchaseOrder(t: TenantContext, input: NewPurchaseOrder, actor: string): Promise<PurchaseOrder>;
  getPurchaseOrder(t: TenantContext, id: string): Promise<PurchaseOrder | null>;
  listPurchaseOrders(t: TenantContext, status?: PoStatus): Promise<PurchaseOrder[]>;
  transitionPurchaseOrder(
    t: TenantContext, id: string, next: PoStatus, actor: string,
  ): Promise<PurchaseOrder | null>;

  createGoodsReceipt(t: TenantContext, input: NewGoodsReceipt, actor: string): Promise<GoodsReceipt>;
  listGoodsReceipts(t: TenantContext, poId?: string): Promise<GoodsReceipt[]>;
  attachMovementToReceiptLine(t: TenantContext, lineId: string, movementId: string): Promise<void>;

  /* assets */
  linkAssetTicket(
    t: TenantContext, assetRef: string, ticketRef: string, actor: string, note: string | null,
  ): Promise<AssetMaintenanceLink | null>;
  listAssetLinks(t: TenantContext, assetRef?: string): Promise<AssetMaintenanceLink[]>;
}

export interface NewRequest {
  readonly propertyId: string | null;
  readonly priority: string;
  readonly reason: string | null;
  readonly lines: readonly Omit<RequestLine, 'id'>[];
}

export interface NewPurchaseOrder {
  readonly vendorId: string;
  readonly propertyId: string | null;
  readonly requestId: string | null;
  readonly orderDate: string | null;
  readonly expectedDate: string | null;
  readonly lines: readonly Omit<PoLine, 'id'>[];
}

export interface NewGoodsReceipt {
  readonly poId: string;
  readonly propertyId: string | null;
  readonly notes: string | null;
  readonly lines: readonly { poLineId: string; receivedQuantity: number; condition: string | null }[];
}

/* ------------------------------------------------------------------ *
 * In memory — the twin the tests execute
 * ------------------------------------------------------------------ */

export class InMemoryInventoryRepository implements InventoryRepository {
  private movements = new Map<string, Movement>();
  private vendorLinks = new Map<string, VendorLink>();
  private requests = new Map<string, PurchaseRequest>();
  private orders = new Map<string, PurchaseOrder>();
  private receipts = new Map<string, GoodsReceipt>();
  private assetLinks = new Map<string, AssetMaintenanceLink>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The single tenant predicate. One place to get it right, one place to break it. */
  private mine<T extends { tenantId: string }>(t: TenantContext, rows: Iterable<T>): T[] {
    const { tenantId } = requireTenant(t, 'InventoryRepository');
    return [...rows].filter((row) => row.tenantId === tenantId);
  }

  async recordMovement(t: TenantContext, row: MovementRow, actor: string): Promise<Movement> {
    const { tenantId } = requireTenant(t, 'recordMovement');
    const stamp = this.now().toISOString();
    const movement: Movement = Object.freeze({
      id: randomUUID(),
      tenantId,
      itemRef: row.itemRef,
      propertyId: row.propertyId,
      movementType: row.movementType,
      quantity: row.quantity,
      employeeId: row.employeeId,
      taskType: row.taskType,
      taskRef: row.taskRef,
      reason: row.reason,
      wastageReason: row.wastageReason,
      counterpartyPropertyId: row.counterpartyPropertyId,
      workbookApplied: row.workbookApplied,
      appliedAt: row.workbookApplied ? stamp : null,
      createdBy: actor,
      createdAt: stamp,
    });
    this.movements.set(movement.id, movement);
    return movement;
  }

  async markMovementApplied(t: TenantContext, id: string): Promise<Movement | null> {
    const existing = this.mine(t, this.movements.values()).find((m) => m.id === id);
    if (!existing) return null;
    const updated = Object.freeze({
      ...existing, workbookApplied: true, appliedAt: this.now().toISOString(),
    });
    this.movements.set(id, updated);
    return updated;
  }

  async getMovement(t: TenantContext, id: string): Promise<Movement | null> {
    return this.mine(t, this.movements.values()).find((m) => m.id === id) ?? null;
  }

  async listMovements(t: TenantContext, filter: MovementFilter = {}): Promise<Movement[]> {
    let rows = this.mine(t, this.movements.values());
    if (filter.itemRef) rows = rows.filter((m) => m.itemRef === filter.itemRef);
    if (filter.propertyId) rows = rows.filter((m) => m.propertyId === filter.propertyId);
    if (filter.taskType) rows = rows.filter((m) => m.taskType === filter.taskType);
    if (filter.taskRef) rows = rows.filter((m) => m.taskRef === filter.taskRef);
    if (filter.unappliedOnly) rows = rows.filter((m) => !m.workbookApplied);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }

  async movementTotals(t: TenantContext): Promise<Map<string, MovementTotals>> {
    const totals = new Map<string, { purchased: number; used: number; unapplied: number }>();
    for (const m of this.mine(t, this.movements.values())) {
      const entry = totals.get(m.itemRef) ?? { purchased: 0, used: 0, unapplied: 0 };
      if (!m.workbookApplied) {
        // Context whose sheet write never landed is counted separately, never as movement.
        entry.unapplied += 1;
      } else if (effectOf(m) === 'PURCHASED') entry.purchased += m.quantity;
      else entry.used += m.quantity;
      totals.set(m.itemRef, entry);
    }
    return new Map([...totals].map(([k, v]) => [k, Object.freeze(v)]));
  }

  async linkVendor(
    t: TenantContext, name: string, vendorId: string, actor: string,
  ): Promise<VendorLink | null> {
    const { tenantId } = requireTenant(t, 'linkVendor');
    const key = name.trim().toLowerCase();
    // One meaning per name. A second is refused, exactly as the unique index refuses it.
    if (this.mine(t, this.vendorLinks.values())
      .some((l) => l.vendorName.trim().toLowerCase() === key)) return null;

    const link: VendorLink = Object.freeze({
      id: randomUUID(), tenantId, vendorName: name.trim(), vendorId,
      linkedBy: actor, createdAt: this.now().toISOString(),
    });
    this.vendorLinks.set(link.id, link);
    return link;
  }

  async listVendorLinks(t: TenantContext): Promise<VendorLink[]> {
    return this.mine(t, this.vendorLinks.values());
  }

  async createRequest(
    t: TenantContext, input: NewRequest, actor: string,
  ): Promise<PurchaseRequest> {
    const { tenantId } = requireTenant(t, 'createRequest');
    const request: PurchaseRequest = Object.freeze({
      id: randomUUID(), tenantId,
      propertyId: input.propertyId, status: 'DRAFT' as const,
      priority: input.priority, reason: input.reason,
      requestedBy: actor, approvedBy: null, approvedAt: null, decisionNote: null,
      createdAt: this.now().toISOString(),
      lines: input.lines.map((l) => Object.freeze({ ...l, id: randomUUID() })),
    });
    this.requests.set(request.id, request);
    return request;
  }

  async getRequest(t: TenantContext, id: string): Promise<PurchaseRequest | null> {
    return this.mine(t, this.requests.values()).find((r) => r.id === id) ?? null;
  }

  async listRequests(t: TenantContext, status?: RequestStatus): Promise<PurchaseRequest[]> {
    const rows = this.mine(t, this.requests.values());
    return (status ? rows.filter((r) => r.status === status) : rows)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async transitionRequest(
    t: TenantContext, id: string, next: RequestStatus, actor: string, note: string | null,
  ): Promise<PurchaseRequest | null> {
    const existing = await this.getRequest(t, id);
    if (!existing) return null;
    const decided = next === 'APPROVED' || next === 'REJECTED';
    const updated = Object.freeze({
      ...existing,
      status: next,
      approvedBy: decided ? actor : existing.approvedBy,
      approvedAt: decided ? this.now().toISOString() : existing.approvedAt,
      decisionNote: decided ? note : existing.decisionNote,
    });
    this.requests.set(id, updated);
    return updated;
  }

  async createPurchaseOrder(
    t: TenantContext, input: NewPurchaseOrder, actor: string,
  ): Promise<PurchaseOrder> {
    const { tenantId } = requireTenant(t, 'createPurchaseOrder');
    const po: PurchaseOrder = Object.freeze({
      id: randomUUID(), tenantId,
      vendorId: input.vendorId, propertyId: input.propertyId, requestId: input.requestId,
      status: 'DRAFT' as const,
      orderDate: input.orderDate, expectedDate: input.expectedDate,
      createdBy: actor, approvedBy: null, approvedAt: null,
      createdAt: this.now().toISOString(),
      lines: input.lines.map((l) => Object.freeze({ ...l, id: randomUUID() })),
    });
    this.orders.set(po.id, po);
    return po;
  }

  async getPurchaseOrder(t: TenantContext, id: string): Promise<PurchaseOrder | null> {
    return this.mine(t, this.orders.values()).find((p) => p.id === id) ?? null;
  }

  async listPurchaseOrders(t: TenantContext, status?: PoStatus): Promise<PurchaseOrder[]> {
    const rows = this.mine(t, this.orders.values());
    return (status ? rows.filter((p) => p.status === status) : rows)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async transitionPurchaseOrder(
    t: TenantContext, id: string, next: PoStatus, actor: string,
  ): Promise<PurchaseOrder | null> {
    const existing = await this.getPurchaseOrder(t, id);
    if (!existing) return null;
    const approving = next === 'APPROVED';
    const updated = Object.freeze({
      ...existing,
      status: next,
      approvedBy: approving ? actor : existing.approvedBy,
      approvedAt: approving ? this.now().toISOString() : existing.approvedAt,
    });
    this.orders.set(id, updated);
    return updated;
  }

  async createGoodsReceipt(
    t: TenantContext, input: NewGoodsReceipt, actor: string,
  ): Promise<GoodsReceipt> {
    const { tenantId } = requireTenant(t, 'createGoodsReceipt');
    const receipt: GoodsReceipt = Object.freeze({
      id: randomUUID(), tenantId,
      poId: input.poId, propertyId: input.propertyId,
      receivedBy: actor, receivedAt: this.now().toISOString(), notes: input.notes,
      lines: input.lines.map((l) => Object.freeze({
        id: randomUUID(), poLineId: l.poLineId,
        receivedQuantity: l.receivedQuantity, condition: l.condition,
        movementId: null,
      })),
    });
    this.receipts.set(receipt.id, receipt);
    return receipt;
  }

  async listGoodsReceipts(t: TenantContext, poId?: string): Promise<GoodsReceipt[]> {
    const rows = this.mine(t, this.receipts.values());
    return (poId ? rows.filter((r) => r.poId === poId) : rows)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  async attachMovementToReceiptLine(
    t: TenantContext, lineId: string, movementId: string,
  ): Promise<void> {
    for (const receipt of this.mine(t, this.receipts.values())) {
      if (!receipt.lines.some((l) => l.id === lineId)) continue;
      const lines: GoodsReceiptLine[] = receipt.lines.map((l) =>
        (l.id === lineId ? Object.freeze({ ...l, movementId }) : l));
      this.receipts.set(receipt.id, Object.freeze({ ...receipt, lines }));
      return;
    }
  }

  async linkAssetTicket(
    t: TenantContext, assetRef: string, ticketRef: string, actor: string, note: string | null,
  ): Promise<AssetMaintenanceLink | null> {
    const { tenantId } = requireTenant(t, 'linkAssetTicket');
    // The pair is unique: linking the same ticket twice says nothing new.
    if (this.mine(t, this.assetLinks.values())
      .some((l) => l.assetRef === assetRef && l.ticketRef === ticketRef)) return null;

    const link: AssetMaintenanceLink = Object.freeze({
      id: randomUUID(), tenantId, assetRef, ticketRef,
      linkedBy: actor, note, createdAt: this.now().toISOString(),
    });
    this.assetLinks.set(link.id, link);
    return link;
  }

  async listAssetLinks(t: TenantContext, assetRef?: string): Promise<AssetMaintenanceLink[]> {
    const rows = this.mine(t, this.assetLinks.values());
    return assetRef ? rows.filter((l) => l.assetRef === assetRef) : rows;
  }
}

/**
 * Which cumulative column a movement lands in.
 *
 * An ADJUSTMENT carries its own direction in `reason` — the service refuses one that does not
 * state it — so here it is read from the row rather than assumed. Everything else is fixed by
 * its type.
 */
function effectOf(m: Movement): 'PURCHASED' | 'USED' {
  if (m.movementType === 'PURCHASE' || m.movementType === 'TRANSFER_IN') return 'PURCHASED';
  if (m.movementType === 'ADJUSTMENT') {
    return (m.reason ?? '').startsWith('[+]') ? 'PURCHASED' : 'USED';
  }
  return 'USED';
}
