import '@/lib/server/only';
/**
 * INVENTORY — the rules, in the layer a test can execute.
 *
 * ONE SENTENCE TO KEEP IN MIND: the workbook owns how much exists, and this owns why it
 * moved. Every method below is written so that those two never both claim the same fact.
 *
 * THE WRITE ORDER, AND WHY IT IS THAT WAY.
 *
 * A movement touches two stores and they cannot be written atomically. The sheet goes FIRST,
 * because stock is its fact:
 *
 *   sheet then overlay (this order): a failure after the sheet leaves stock correct and the
 *     context missing. The movement row is still written, with `workbookApplied` TRUE only if
 *     the sheet actually took it — so an unapplied row is a visible repair item, never a
 *     claim that something happened.
 *   overlay then sheet: a failure would leave this database asserting a movement the workbook
 *     never saw. That is the second ledger this whole design exists to avoid, and it would be
 *     a wrong one.
 *
 * THE CONCURRENCY LIMIT, STATED RATHER THAN HIDDEN.
 *
 * `15_INVENTORY.Purchased` and `.Used` are cumulative totals and the only write path sets
 * them ABSOLUTELY, so recording a movement is a read-modify-write. Two movements on the same
 * item at the same moment can lose one of the increments — a genuine limitation of a
 * spreadsheet as a ledger, and not one this milestone can fix without becoming the second
 * ledger.
 *
 * What it CAN do, and does, is make the loss visible: both context rows are recorded, so the
 * sum of movements and the workbook's total disagree, and reconciliation reports
 * CONTEXT_AHEAD. Before this milestone the same lost update was completely undetectable.
 */
import { requireTenant, type TenantContext } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import type { HandlerContext } from '@/lib/server/auth/guard';
import type { HrService } from '@/lib/server/hr/service';
import type { InventoryRepository, MovementFilter } from './repository';
import {
  notFound, refuse,
  MOVEMENT_EFFECT, PO_TRANSITIONS, RECEIVABLE_PO_STATUSES, REQUEST_TRANSITIONS,
  type AssetView, type GoodsReceipt, type ItemReconciliation, type Movement,
  type MovementInput, type PoStatus, type PurchaseOrder, type PurchaseRequest,
  type RequestStatus, type StockItem, type StockStatus,
} from './types';

/** What the workbook says about one stock row. Read every time; never cached, never copied. */
export interface WorkbookStockRow {
  readonly itemRef: string;
  readonly propertyId: string | null;
  readonly category: string;
  readonly name: string;
  readonly unit: string;
  readonly openingStock: number | null;
  readonly purchased: number | null;
  readonly used: number | null;
  /** The sheet's own CurrentStock formula result. */
  readonly currentStock: number | null;
  readonly minStock: number | null;
  readonly vendorName: string | null;
}

/** One row of 16_ASSETS, as read. */
export interface WorkbookAssetRow {
  readonly assetRef: string;
  readonly propertyId: string | null;
  readonly category: string;
  readonly name: string;
  readonly purchaseDate: string | null;
  readonly purchaseCostMinor: number | null;
  readonly vendorName: string | null;
  readonly warrantyExpiry: string | null;
  /** The sheet's own calculated WarrantyStatus text. Read, never recomputed. */
  readonly warrantyLabel: string;
  readonly condition: string;
  readonly status: string;
  readonly disposalDate: string | null;
}

/** What the sheet write needs to run the verified pipeline AS THE CALLER. */
export interface SheetWriteContext {
  readonly auth: HandlerContext['auth'];
  readonly requestId: string;
}

export interface InventoryServiceDeps {
  repo: InventoryRepository;
  hr: HrService;
  /** The caller's OWN workbook stock rows. A foreign item is therefore simply not there. */
  stockRows: (tenant: TenantContext) => Promise<readonly WorkbookStockRow[]>;
  /** The caller's OWN workbook asset rows. */
  assetRows: (tenant: TenantContext) => Promise<readonly WorkbookAssetRow[]>;
  /** The caller's own property identifiers. */
  propertyIds: (tenant: TenantContext) => Promise<readonly string[]>;
  /**
   * Resolves a vendor WITHIN THE CALLER'S OWN TENANT, through finance's repository.
   *
   * Postgres carries a composite `(tenant_id, vendor_id)` foreign key that already refuses
   * another customer's vendor. This asks the question in the application layer as well, for
   * the reason the whole product is built that way: the database is the last boundary, never
   * the only one. The in-memory backend has no foreign keys at all, so without this the rule
   * would exist in exactly one of the two places it must hold.
   *
   * A vendor belonging to somebody else resolves to null — indistinguishable from a vendor
   * that was never created.
   */
  vendor: (tenant: TenantContext, vendorId: string) => Promise<{ readonly id: string } | null>;
  /**
   * Writes the item's cumulative totals through the EXISTING verified `inventory.update`
   * mutation. Never a sheets client: that pipeline carries the contract check which refuses
   * a calculated column, the read-after-write verification, the operation ledger and the
   * audit record.
   */
  writeTotals: (
    write: SheetWriteContext, itemRef: string,
    totals: { purchased?: number; used?: number },
  ) => Promise<void>;
  audit: AuditService;
  now?: () => Date;
}

export class InventoryService {
  constructor(private readonly deps: InventoryServiceDeps) {}

  private today(): string {
    return (this.deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  }

  /* ---------------------------------------------------------------- *
   * Stock, as the workbook reports it
   * ---------------------------------------------------------------- */

  async stock(tenant: TenantContext, propertyId?: string): Promise<StockItem[]> {
    requireTenant(tenant, 'inventory.stock');
    if (propertyId) await this.assertOwnProperty(tenant, propertyId);

    const [rows, links] = await Promise.all([
      this.deps.stockRows(tenant),
      this.deps.repo.listVendorLinks(tenant),
    ]);
    const byName = new Map(links.map((l) => [l.vendorName.trim().toLowerCase(), l.vendorId]));

    return rows
      .filter((row) => !propertyId || row.propertyId === propertyId)
      .map((row) => Object.freeze({
        itemRef: row.itemRef,
        propertyId: row.propertyId,
        category: row.category,
        name: row.name,
        unit: row.unit,
        currentStock: row.currentStock,
        minStock: row.minStock,
        status: statusOf(row.currentStock, row.minStock),
        vendorName: row.vendorName,
        vendorId: row.vendorName
          ? byName.get(row.vendorName.trim().toLowerCase()) ?? null
          : null,
      }));
  }

  /** Items at or below their own reorder level. The rule is the sheet's numbers, not ours. */
  async lowStock(tenant: TenantContext, propertyId?: string): Promise<StockItem[]> {
    const items = await this.stock(tenant, propertyId);
    return items.filter((i) => i.status === 'LOW_STOCK' || i.status === 'OUT_OF_STOCK'
      || i.status === 'NEGATIVE');
  }

  /* ---------------------------------------------------------------- *
   * Movement — the sentence the workbook cannot say
   * ---------------------------------------------------------------- */

  /**
   * Record a movement: validate, write the sheet, then record why.
   *
   * Order and every refusal are described at the top of this file. Each identifier is
   * resolved against a store scoped to the caller's own tenant, so the pair (item, employee)
   * can only ever be formed from two things they already own.
   */
  async recordMovement(
    tenant: TenantContext, input: MovementInput, actor: string, write: SheetWriteContext,
  ): Promise<{ movement: Movement; applied: boolean }> {
    requireTenant(tenant, 'inventory.movement');

    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw refuse('INVALID_QUANTITY',
        'A movement moves a positive quantity. Direction is the movement type.');
    }

    // The item, from the caller's OWN workbook. A foreign ItemID is simply not there.
    const row = (await this.deps.stockRows(tenant))
      .find((r) => r.itemRef === input.itemRef);
    if (!row) throw notFound('item');

    /*
     * The ITEM'S OWN property is deliberately not checked against the property list.
     *
     * It came from the caller's own workbook, so it is theirs by construction — and
     * 15_INVENTORY.PropertyID is bound to LIST_PROPERTY_IDS_ALL, which legitimately includes
     * `COMMON` for stock that belongs to no single unit. Asserting it against the property
     * register would refuse every shared item in the business, which is most of the linen.
     *
     * A property the CALLER names is a different matter, and is checked.
     */
    if (input.counterpartyPropertyId) {
      await this.assertOwnProperty(tenant, input.counterpartyPropertyId);
    }

    // The employee, through the tenant-scoped HR repository. A foreign id is a miss.
    if (input.employeeId) {
      const employee = await this.deps.hr.getEmployee(tenant, input.employeeId);
      if (!employee) throw notFound('employee');
    }

    if (input.movementType === 'WASTAGE' && !input.wastageReason) {
      throw refuse('WASTAGE_REASON_REQUIRED',
        'Wastage has to say what happened to it — damaged, lost, expired, broken or other.');
    }
    if (input.movementType === 'ADJUSTMENT') {
      if (!input.reason?.trim()) {
        throw refuse('ADJUSTMENT_REASON_REQUIRED',
          'A stock correction has to say why. This is the movement nobody can audit later.');
      }
      if (!input.adjusts) {
        throw refuse('ADJUSTMENT_DIRECTION_REQUIRED',
          'Say whether this correction adds stock or removes it. Guessing would let a '
          + 'correction mean its opposite.');
      }
    }
    if ((input.movementType === 'TRANSFER_IN' || input.movementType === 'TRANSFER_OUT')
      && !input.counterpartyPropertyId) {
      throw refuse('TRANSFER_COUNTERPARTY_REQUIRED', 'A transfer names the other property.');
    }

    const effect = input.movementType === 'ADJUSTMENT'
      ? input.adjusts! : MOVEMENT_EFFECT[input.movementType];

    /*
     * READ, ADD, WRITE. The sheet holds cumulative totals and the mutation sets them
     * absolutely, so the new total is computed from what the sheet says right now. The
     * limitation this carries is described at the top of the file, and reconciliation is
     * what makes it visible rather than silent.
     */
    const current = (effect === 'PURCHASED' ? row.purchased : row.used) ?? 0;
    const next = current + input.quantity;

    let applied = false;
    try {
      await this.deps.writeTotals(write, input.itemRef,
        effect === 'PURCHASED' ? { purchased: next } : { used: next });
      applied = true;
    } catch (error) {
      /*
       * The sheet refused. The context is still recorded, marked unapplied, so the attempt is
       * visible and repairable — but nothing anywhere claims the stock changed.
       */
      await this.deps.repo.recordMovement(tenant, {
        ...toRow(input, row), workbookApplied: false,
      }, actor);
      throw error;
    }

    const movement = await this.deps.repo.recordMovement(tenant, {
      ...toRow(input, row), workbookApplied: applied,
    }, actor);

    return { movement, applied };
  }

  async movements(tenant: TenantContext, filter: MovementFilter = {}): Promise<Movement[]> {
    requireTenant(tenant, 'inventory.movements');
    if (filter.propertyId) await this.assertOwnProperty(tenant, filter.propertyId);
    return this.deps.repo.listMovements(tenant, filter);
  }

  /* ---------------------------------------------------------------- *
   * Reconciliation — a comparison, never an authority
   * ---------------------------------------------------------------- */

  /**
   * Where the context this database holds and the totals the workbook holds disagree.
   *
   * It compares SUMS OF EVENTS against CUMULATIVE TOTALS. It does not recompute stock and it
   * does not decide who is right: a workbook that moved more than we have context for is the
   * ordinary state of anything that predates this feature, and context ahead of the workbook
   * means a write did not land. Both are reported; neither is repaired here.
   */
  async reconciliation(tenant: TenantContext): Promise<ItemReconciliation[]> {
    requireTenant(tenant, 'inventory.reconciliation');
    const [rows, totals] = await Promise.all([
      this.deps.stockRows(tenant),
      this.deps.repo.movementTotals(tenant),
    ]);

    return rows.map((row) => {
      const context = totals.get(row.itemRef) ?? { purchased: 0, used: 0, unapplied: 0 };
      const status = reconcileStatus(row, context);
      return Object.freeze({
        itemRef: row.itemRef,
        name: row.name,
        propertyId: row.propertyId,
        status,
        workbookPurchased: row.purchased,
        workbookUsed: row.used,
        contextPurchased: context.purchased,
        contextUsed: context.used,
        unappliedCount: context.unapplied,
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * Vendor identity
   * ---------------------------------------------------------------- */

  /**
   * Say which vendor entity a workbook name means.
   *
   * The vendor itself stays in `finance_vendors` — this only records the correspondence, and
   * refuses a second meaning for one name because that is a decision somebody has to make
   * rather than a duplicate to accumulate.
   */
  async linkVendorName(
    tenant: TenantContext, name: string, vendorId: string, actor: string,
  ): Promise<void> {
    requireTenant(tenant, 'inventory.vendorLink');
    if (!name.trim()) throw refuse('VENDOR_NAME_REQUIRED', 'A link needs a name to link.');
    await this.assertOwnVendor(tenant, vendorId);

    const link = await this.deps.repo.linkVendor(tenant, name, vendorId, actor);
    if (!link) {
      throw refuse('ALREADY_LINKED',
        `"${name.trim()}" already means somebody. Change the existing link rather than `
        + 'adding a second meaning.', 409);
    }
  }

  /* ---------------------------------------------------------------- *
   * Procurement
   * ---------------------------------------------------------------- */

  async createRequest(
    tenant: TenantContext,
    input: {
      propertyId?: string | null; priority?: string; reason?: string | null;
      lines: readonly { itemRef?: string | null; description?: string | null;
        quantity: number; unit?: string | null }[];
    },
    actor: string,
  ): Promise<PurchaseRequest> {
    requireTenant(tenant, 'inventory.request.create');
    if (input.propertyId) await this.assertOwnProperty(tenant, input.propertyId);
    if (input.lines.length === 0) {
      throw refuse('EMPTY_REQUEST', 'A request asks for something.');
    }
    for (const line of input.lines) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw refuse('INVALID_QUANTITY', 'Every line asks for a positive quantity.');
      }
    }

    return this.deps.repo.createRequest(tenant, {
      propertyId: input.propertyId ?? null,
      priority: input.priority ?? 'Medium',
      reason: input.reason ?? null,
      lines: input.lines.map((l) => ({
        itemRef: l.itemRef ?? null, description: l.description ?? null,
        quantity: l.quantity, unit: l.unit ?? null,
      })),
    }, actor);
  }

  /**
   * Move a request along its lifecycle.
   *
   * SEPARATION OF DUTY: whoever asked may not be whoever approves. Checked here and again by
   * a check constraint, because a rule that lives only in application code holds only while
   * every path remembers it — and procurement approval is exactly the rule somebody will one
   * day want to skip "just this once".
   */
  async decideRequest(
    tenant: TenantContext, id: string, next: RequestStatus, actor: string,
    note: string | null,
  ): Promise<PurchaseRequest> {
    requireTenant(tenant, 'inventory.request.decide');
    const request = await this.deps.repo.getRequest(tenant, id);
    if (!request) throw notFound('purchase request');

    const allowed = REQUEST_TRANSITIONS[request.status];
    if (!allowed.includes(next)) {
      throw refuse('INVALID_TRANSITION',
        `A ${request.status.toLowerCase()} request cannot become ${next.toLowerCase()}.`, 409);
    }
    if ((next === 'APPROVED' || next === 'REJECTED')
      && sameActor(actor, request.requestedBy)) {
      throw refuse('SELF_APPROVAL',
        'The person who asked for something cannot be the person who approves it.', 409);
    }

    const updated = await this.deps.repo.transitionRequest(tenant, id, next, actor, note);
    if (!updated) throw notFound('purchase request');
    return updated;
  }

  async listRequests(tenant: TenantContext): Promise<PurchaseRequest[]> {
    requireTenant(tenant, 'inventory.requests');
    return this.deps.repo.listRequests(tenant);
  }

  async listPurchaseOrders(tenant: TenantContext): Promise<PurchaseOrder[]> {
    requireTenant(tenant, 'inventory.purchaseOrders');
    return this.deps.repo.listPurchaseOrders(tenant);
  }

  async createPurchaseOrder(
    tenant: TenantContext,
    input: {
      vendorId: string; propertyId?: string | null; requestId?: string | null;
      orderDate?: string | null; expectedDate?: string | null;
      lines: readonly { itemRef?: string | null; description?: string | null;
        quantity: number; unit?: string | null; expectedUnitPriceMinor?: number | null }[];
    },
    actor: string,
  ): Promise<PurchaseOrder> {
    requireTenant(tenant, 'inventory.po.create');
    if (input.propertyId) await this.assertOwnProperty(tenant, input.propertyId);
    if (input.lines.length === 0) throw refuse('EMPTY_ORDER', 'An order orders something.');
    await this.assertOwnVendor(tenant, input.vendorId);

    // An order raised against a request must be raised against an APPROVED one.
    if (input.requestId) {
      const request = await this.deps.repo.getRequest(tenant, input.requestId);
      if (!request) throw notFound('purchase request');
      if (request.status !== 'APPROVED') {
        throw refuse('REQUEST_NOT_APPROVED',
          'An order can only follow a request somebody approved.', 409);
      }
    }

    return this.deps.repo.createPurchaseOrder(tenant, {
      vendorId: input.vendorId,
      propertyId: input.propertyId ?? null,
      requestId: input.requestId ?? null,
      orderDate: input.orderDate ?? null,
      expectedDate: input.expectedDate ?? null,
      lines: input.lines.map((l) => ({
        itemRef: l.itemRef ?? null, description: l.description ?? null,
        quantity: l.quantity, unit: l.unit ?? null,
        expectedUnitPriceMinor: l.expectedUnitPriceMinor ?? null,
      })),
    }, actor);
  }

  async transitionPurchaseOrder(
    tenant: TenantContext, id: string, next: PoStatus, actor: string,
  ): Promise<PurchaseOrder> {
    requireTenant(tenant, 'inventory.po.transition');
    const po = await this.deps.repo.getPurchaseOrder(tenant, id);
    if (!po) throw notFound('purchase order');

    if (!PO_TRANSITIONS[po.status].includes(next)) {
      throw refuse('INVALID_TRANSITION',
        `A ${po.status.toLowerCase().replace('_', ' ')} order cannot become `
        + `${next.toLowerCase().replace('_', ' ')}.`, 409);
    }
    if (next === 'APPROVED' && sameActor(actor, po.createdBy)) {
      throw refuse('SELF_APPROVAL',
        'The person who raised an order cannot be the person who approves it.', 409);
    }

    const updated = await this.deps.repo.transitionPurchaseOrder(tenant, id, next, actor);
    if (!updated) throw notFound('purchase order');
    return updated;
  }

  /* ---------------------------------------------------------------- *
   * Goods receipt — the only event that may increase stock
   * ---------------------------------------------------------------- */

  /**
   * Record what actually arrived, and move the workbook by that much.
   *
   * A purchase order is a promise; this is a fact, and they differ routinely. Treating an
   * order as received stock is the most common way an inventory system starts lying, so a
   * receipt is only accepted against an order somebody approved AND sent.
   *
   * NO BILL AND NO EXPENSE IS CREATED. Things arriving and money being owed are different
   * claims: `finance_bills` owns the second one and a person raises it.
   */
  async receiveGoods(
    tenant: TenantContext,
    input: {
      poId: string; propertyId?: string | null; notes?: string | null;
      lines: readonly { poLineId: string; receivedQuantity: number; condition?: string | null }[];
    },
    actor: string,
    write: SheetWriteContext,
  ): Promise<{ receipt: GoodsReceipt; movements: readonly Movement[]; unapplied: number }> {
    requireTenant(tenant, 'inventory.goodsReceipt');
    const po = await this.deps.repo.getPurchaseOrder(tenant, input.poId);
    if (!po) throw notFound('purchase order');

    if (!RECEIVABLE_PO_STATUSES.includes(po.status)) {
      throw refuse('PO_NOT_RECEIVABLE',
        `Goods can only be received against an order that has been approved and sent. `
        + `This one is ${po.status.toLowerCase().replace('_', ' ')}.`, 409);
    }
    if (input.lines.length === 0) throw refuse('EMPTY_RECEIPT', 'A receipt receives something.');

    const byLine = new Map(po.lines.map((l) => [l.id, l]));
    for (const line of input.lines) {
      if (!byLine.has(line.poLineId)) throw notFound('order line');
      if (!Number.isFinite(line.receivedQuantity) || line.receivedQuantity <= 0) {
        throw refuse('INVALID_QUANTITY', 'A receipt receives a positive quantity.');
      }
    }

    const receipt = await this.deps.repo.createGoodsReceipt(tenant, {
      poId: input.poId,
      propertyId: input.propertyId ?? po.propertyId,
      notes: input.notes ?? null,
      lines: input.lines.map((l) => ({
        poLineId: l.poLineId, receivedQuantity: l.receivedQuantity,
        condition: l.condition ?? null,
      })),
    }, actor);

    // Each received line that names a stocked item moves the workbook. A line for something
    // not in 15_INVENTORY is recorded as received and moves no stock — there is nothing to
    // move, and inventing an item would be a second item master.
    const movements: Movement[] = [];
    let unapplied = 0;
    for (const line of receipt.lines) {
      const poLine = byLine.get(line.poLineId)!;
      if (!poLine.itemRef) continue;
      try {
        const { movement } = await this.recordMovement(tenant, {
          itemRef: poLine.itemRef,
          movementType: 'PURCHASE',
          quantity: line.receivedQuantity,
          reason: `Goods receipt against ${po.id}`,
        }, actor, write);
        await this.deps.repo.attachMovementToReceiptLine(tenant, line.id, movement.id);
        movements.push(movement);
      } catch {
        // One line failing must not discard the rest of a delivery that genuinely arrived.
        unapplied += 1;
      }
    }

    const fully = po.lines.every((l) => !l.itemRef
      || input.lines.some((r) => r.poLineId === l.id && r.receivedQuantity >= l.quantity));
    await this.deps.repo.transitionPurchaseOrder(
      tenant, po.id, fully ? 'RECEIVED' : 'PARTIALLY_RECEIVED', actor);

    return { receipt, movements, unapplied };
  }

  /* ---------------------------------------------------------------- *
   * Assets — the workbook's register, read
   * ---------------------------------------------------------------- */

  async assets(tenant: TenantContext, propertyId?: string): Promise<AssetView[]> {
    requireTenant(tenant, 'inventory.assets');
    if (propertyId) await this.assertOwnProperty(tenant, propertyId);

    const [rows, links, vendorLinks] = await Promise.all([
      this.deps.assetRows(tenant),
      this.deps.repo.listAssetLinks(tenant),
      this.deps.repo.listVendorLinks(tenant),
    ]);
    const byName = new Map(vendorLinks.map((l) => [l.vendorName.trim().toLowerCase(), l.vendorId]));
    const ticketsFor = new Map<string, string[]>();
    for (const link of links) {
      (ticketsFor.get(link.assetRef) ?? ticketsFor.set(link.assetRef, []).get(link.assetRef)!)
        .push(link.ticketRef);
    }

    const today = this.today();
    return rows
      .filter((row) => !propertyId || row.propertyId === propertyId)
      .map((row) => Object.freeze({
        assetRef: row.assetRef,
        propertyId: row.propertyId,
        category: row.category,
        name: row.name,
        purchaseDate: row.purchaseDate,
        // What was paid. NOT a book value: no depreciation is modelled anywhere here.
        purchaseCostMinor: row.purchaseCostMinor,
        vendorName: row.vendorName,
        vendorId: row.vendorName
          ? byName.get(row.vendorName.trim().toLowerCase()) ?? null : null,
        warrantyExpiry: row.warrantyExpiry,
        warrantyLabel: row.warrantyLabel,
        warrantyState: warrantyStateOf(row.warrantyExpiry, today),
        condition: row.condition,
        status: row.status,
        disposalDate: row.disposalDate,
        linkedTickets: ticketsFor.get(row.assetRef) ?? [],
      }));
  }

  /** Say that a maintenance ticket was about this asset. The sheet holds only prose. */
  async linkAssetTicket(
    tenant: TenantContext, assetRef: string, ticketRef: string, actor: string,
    note: string | null,
  ): Promise<void> {
    requireTenant(tenant, 'inventory.assetLink');
    const asset = (await this.deps.assetRows(tenant)).find((a) => a.assetRef === assetRef);
    if (!asset) throw notFound('asset');

    const link = await this.deps.repo.linkAssetTicket(tenant, assetRef, ticketRef, actor, note);
    if (!link) {
      throw refuse('ALREADY_LINKED', 'That ticket is already linked to this asset.', 409);
    }
  }

  /* ---------------------------------------------------------------- *
   * Shared refusals
   * ---------------------------------------------------------------- */

  /**
   * The vendor must be one finance already knows, IN THIS TENANT.
   *
   * Answered as "no such vendor" rather than "not yours", so a caller cannot use the refusal
   * to learn that somebody else's vendor id is real.
   */
  private async assertOwnVendor(tenant: TenantContext, vendorId: string): Promise<void> {
    const vendor = await this.deps.vendor(tenant, vendorId);
    if (!vendor) throw notFound('vendor');
  }

  private async assertOwnProperty(tenant: TenantContext, propertyId: string): Promise<void> {
    const owned = await this.deps.propertyIds(tenant);
    // A property the caller does not own is refused identically to one that does not exist.
    if (!owned.includes(propertyId)) throw notFound('property');
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/**
 * How an item stands, from the sheet's own two numbers.
 *
 * NEGATIVE is surfaced rather than clamped. A spreadsheet can hold a negative balance —
 * somebody recorded more used than ever arrived — and showing zero would hide a real
 * counting problem behind a tidy number.
 */
export function statusOf(currentStock: number | null, minStock: number | null): StockStatus {
  if (currentStock === null || !Number.isFinite(currentStock)) return 'UNAVAILABLE';
  if (currentStock < 0) return 'NEGATIVE';
  if (currentStock === 0) return 'OUT_OF_STOCK';
  if (minStock !== null && Number.isFinite(minStock) && currentStock <= minStock) {
    return 'LOW_STOCK';
  }
  return 'IN_STOCK';
}

/** Warranty, in the three words an operator cares about. 60 days is the "soon" window. */
function warrantyStateOf(expiry: string | null, today: string): AssetView['warrantyState'] {
  if (!expiry) return 'UNKNOWN';
  const end = Date.parse(`${expiry}T00:00:00.000Z`);
  const now = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(end) || Number.isNaN(now)) return 'UNKNOWN';
  if (end < now) return 'EXPIRED';
  return end - now <= 60 * 86_400_000 ? 'EXPIRING' : 'ACTIVE';
}

function reconcileStatus(
  row: WorkbookStockRow, context: { purchased: number; used: number; unapplied: number },
): ItemReconciliation['status'] {
  if (context.unapplied > 0) return 'UNAPPLIED_CONTEXT';
  if (row.purchased === null && row.used === null) return 'STOCK_UNAVAILABLE';

  const workbookPurchased = row.purchased ?? 0;
  const workbookUsed = row.used ?? 0;
  // Context ahead means we recorded a movement the totals never took — a lost update, which
  // was completely invisible before this overlay existed.
  if (context.purchased > workbookPurchased || context.used > workbookUsed) {
    return 'CONTEXT_AHEAD';
  }
  // The workbook moved more than we can explain. Ordinary for everything predating this.
  if (context.purchased < workbookPurchased || context.used < workbookUsed) {
    return 'UNEXPLAINED_MOVEMENT';
  }
  return 'MATCHED';
}

function toRow(input: MovementInput, row: WorkbookStockRow) {
  return {
    itemRef: input.itemRef,
    propertyId: row.propertyId,
    movementType: input.movementType,
    quantity: input.quantity,
    employeeId: input.employeeId ?? null,
    taskType: input.taskType ?? null,
    taskRef: input.taskRef ?? null,
    // An adjustment's direction is carried in the reason so a reader — and the totals — can
    // see which way a correction went without a second column.
    reason: input.movementType === 'ADJUSTMENT'
      ? `${input.adjusts === 'PURCHASED' ? '[+]' : '[-]'} ${input.reason ?? ''}`.trim()
      : (input.reason ?? null),
    wastageReason: input.wastageReason ?? null,
    counterpartyPropertyId: input.counterpartyPropertyId ?? null,
  };
}

/** Actor comparison for separation of duty. Trimmed and case-folded, never exact-match only. */
function sameActor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
