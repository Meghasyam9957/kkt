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
import { withItemLock, itemLockKey } from './serialize';
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
    /*
     * WHAT THE CALLER BELIEVED THE RUNNING TOTAL WAS when it did the arithmetic above.
     * The mutation refuses the write if the sheet has moved on since — see
     * `expectedTotalsUnchanged` in lib/server/api/mutation-services.ts. It is a compare a
     * moment before a write, not a compare-and-swap: Google Sheets offers no conditional
     * write, so this DETECTS a concurrent movement rather than preventing one.
     */
    expected: { expectedPurchased?: number; expectedUsed?: number },
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
    const { tenantId } = requireTenant(tenant, 'inventory.movement');
    /*
     * ONE MOVEMENT AT A TIME, PER ITEM.
     *
     * Everything from reading the sheet's running total to writing the new one and recording
     * why runs inside the lock, because the read and the write are two halves of one
     * arithmetic step and anything interleaving between them loses an increment. Keyed by
     * item, so a busy morning across forty items is still forty concurrent movements.
     *
     * Within a process this PREVENTS the loss. Across processes it cannot — two servers hold
     * two mutexes — which is what the expected-totals comparison below is for. See
     * ./serialize.ts.
     */
    return withItemLock(itemLockKey(tenantId, input.itemRef),
      () => this.recordMovementLocked(tenant, input, actor, write));
  }

  private async recordMovementLocked(
    tenant: TenantContext, input: MovementInput, actor: string, write: SheetWriteContext,
  ): Promise<{ movement: Movement; applied: boolean }> {

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
     * READ, ADD, WRITE — now with the starting point carried along and re-checked, and with
     * a bounded retry when somebody outside this process moved the item first. The full
     * concurrency model is at the top of this file and in ./serialize.ts.
     */
    let applied = false;
    try {
      await this.writeTotalsWithRetry(tenant, input, row, effect, write);
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

  /**
   * Write the new cumulative total, re-reading and recomputing if the sheet moved first.
   *
   * A refusal carrying STALE_TOTALS means another writer — necessarily in another process,
   * because this one holds the item's lock — changed the running total between our read and
   * our write. Nothing was written, so re-reading and adding the same quantity to the NEW
   * total is correct rather than a double count: the movement is still the same movement.
   *
   * Bounded, because an unbounded retry against a genuinely hot item is an outage rather than
   * a fix. Exhausting the attempts raises a named conflict the caller can act on; it does not
   * fall back to writing a figure we know to be stale.
   */
  private async writeTotalsWithRetry(
    tenant: TenantContext, input: MovementInput, first: WorkbookStockRow,
    effect: 'PURCHASED' | 'USED', write: SheetWriteContext,
  ): Promise<void> {
    let row = first;
    for (let attempt = 0; attempt <= STALE_RETRY_LIMIT; attempt += 1) {
      const current = (effect === 'PURCHASED' ? row.purchased : row.used) ?? 0;
      const next = current + input.quantity;
      try {
        await this.deps.writeTotals(
          write, input.itemRef,
          effect === 'PURCHASED' ? { purchased: next } : { used: next },
          effect === 'PURCHASED' ? { expectedPurchased: current } : { expectedUsed: current },
        );
        return;
      } catch (error) {
        if (!isStalePrecondition(error)) throw error;
        if (attempt === STALE_RETRY_LIMIT) {
          throw refuse('CONCURRENT_MOVEMENT',
            'This item is being moved by somebody else faster than this movement can be '
            + 'applied. Nothing has been written. Try again in a moment.', 409);
        }
        const fresh = (await this.deps.stockRows(tenant))
          .find((r) => r.itemRef === input.itemRef);
        if (!fresh) throw notFound('item');
        row = fresh;
      }
    }
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
   * Repair — the one thing an operator may re-apply, and nothing else
   * ---------------------------------------------------------------- */

  /**
   * Re-apply a movement whose sheet write never landed.
   *
   * THE ONLY REPAIRABLE STATE IS `UNAPPLIED_CONTEXT`, and the reason is worth stating
   * carefully, because the neighbouring state looks superficially similar.
   *
   *   UNAPPLIED_CONTEXT   a movement was recorded, the sheet refused it, and NOTHING claims
   *                       the stock changed. The context — item, quantity, employee, task,
   *                       reason — is already recorded and is not in doubt. Re-applying it
   *                       replays a decision somebody already made and audited. This is
   *                       repairable.
   *
   *   CONTEXT_AHEAD       the workbook's totals are behind what we hold context for: a write
   *                       landed and was later overwritten, or was lost between two servers.
   *                       DETECTED, AND NOT REPAIRABLE HERE — and the reason is arithmetic
   *                       rather than caution. An ADJUSTMENT raises the workbook by N and
   *                       records a context row of N, so a gap of 4 becomes a gap of 4 again:
   *                       it never converges. Re-applying the original movement is refused
   *                       too, because that row is already marked applied and re-applying it
   *                       would move stock a second time on the strength of a guess about
   *                       what happened.
   *
   *                       What closes it is a person looking: deciding whether the workbook
   *                       or the record is right, correcting the sheet, and saying so. The
   *                       product reports the divergence precisely and does not pretend to
   *                       resolve it.
   *
   * WHAT THIS NEVER DOES: fabricate a movement, invent a quantity, alter the original
   * context, or turn unexplained workbook history into a product-originated movement. It
   * re-applies exactly the row that is already there, and marks that row applied only if the
   * workbook actually took it.
   */
  async repairMovement(
    tenant: TenantContext, movementId: string, actor: string, write: SheetWriteContext,
  ): Promise<{ movement: Movement; applied: boolean }> {
    const { tenantId } = requireTenant(tenant, 'inventory.movement.repair');

    const movement = await this.deps.repo.getMovement(tenant, movementId);
    if (!movement) throw notFound('movement');
    if (movement.workbookApplied) {
      throw refuse('ALREADY_APPLIED',
        'The workbook already took this movement. There is nothing to repair, and re-applying '
        + 'it would move the stock a second time.', 409);
    }

    return withItemLock(itemLockKey(tenantId, movement.itemRef), async () => {
      const row = (await this.deps.stockRows(tenant))
        .find((r) => r.itemRef === movement.itemRef);
      if (!row) throw notFound('item');

      const effect = effectOfMovement(movement);
      /*
       * Re-read and re-add, rather than replaying the number computed the first time. The
       * original arithmetic was against a total that is now old, and writing that stale
       * figure would silently discard every movement recorded since the failure.
       */
      await this.writeTotalsWithRetry(
        tenant,
        { itemRef: movement.itemRef, quantity: movement.quantity } as MovementInput,
        row, effect, write,
      );

      const applied = await this.deps.repo.markMovementApplied(tenant, movementId);
      if (!applied) throw notFound('movement');

      await this.deps.audit.record({
        actor: write.auth, action: 'inventory.movement.repair.applied',
        entityType: 'INV_MOVEMENT', entityId: movementId, result: 'ALLOW',
        requestId: write.requestId,
        // The movement and the item. Never the quantity or the employee: a repair trail is
        // not the place to accumulate a record of who used what.
        metadata: { itemRef: movement.itemRef },
      });

      return { movement: applied, applied: true };
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
    /*
     * The property a receipt is attributed to, checked like every other property this domain
     * accepts. It was the ONE path that took a caller-supplied property id and never asked
     * whether the caller owned it — so a delivery could be attributed to a unit the business
     * does not operate, or to a string that is not a property at all, and it would be stored
     * and shown back on every screen that reads receipts.
     *
     * Not a cross-tenant read: receipts are tenant-scoped, and the other customer never saw
     * anything. It is a hole in an otherwise uniform rule, which is exactly the kind that
     * survives review — every sibling does this, and this one silently did not.
     */
    if (input.propertyId) await this.assertOwnProperty(tenant, input.propertyId);

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

    /*
     * OVER-RECEIPT GUARD — what stops a retry from moving the stock twice.
     *
     * A goods receipt is not atomic with the workbook: it creates the receipt, then moves the
     * sheet line by line. If that sequence dies halfway the operation is recorded as failed,
     * and the honest way to finish the delivery is to submit it again with a fresh operation
     * id — which, before this guard, created a SECOND receipt and moved the stock a SECOND
     * time for the lines that had already succeeded.
     *
     * Comparing what has already been received against what was ordered catches exactly that,
     * because the duplicate is the receipt that takes a line past its order. This is a fact
     * about the ORDER, not about stock: it counts receipt lines, never a balance, and the
     * workbook remains the only thing that knows how much exists.
     *
     * A genuine over-delivery is refused too, and that is the intended trade: a vendor who
     * sent more than was ordered is a conversation somebody should have, not a number that
     * should quietly appear in the stock figure.
     */
    const priorReceipts = await this.deps.repo.listGoodsReceipts(tenant, input.poId);
    const alreadyReceived = new Map<string, number>();
    for (const prior of priorReceipts) {
      for (const line of prior.lines) {
        alreadyReceived.set(line.poLineId,
          (alreadyReceived.get(line.poLineId) ?? 0) + line.receivedQuantity);
      }
    }
    for (const line of input.lines) {
      const ordered = byLine.get(line.poLineId)!.quantity;
      const total = (alreadyReceived.get(line.poLineId) ?? 0) + line.receivedQuantity;
      if (total > ordered) {
        throw refuse('OVER_RECEIPT',
          `That line ordered ${ordered} and ${alreadyReceived.get(line.poLineId) ?? 0} `
          + `already arrived; receiving ${line.receivedQuantity} more would exceed the order. `
          + 'Nothing has been written. If the vendor genuinely sent more, raise an order for '
          + 'the difference rather than recording it against this one.', 409);
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
      || ((alreadyReceived.get(l.id) ?? 0)
        + (input.lines.find((r) => r.poLineId === l.id)?.receivedQuantity ?? 0)) >= l.quantity);
    await this.deps.repo.transitionPurchaseOrder(
      tenant, po.id, fully ? 'RECEIVED' : 'PARTIALLY_RECEIVED', actor);

    /*
     * RE-READ BEFORE REPORTING, because `receipt` above is the object as it was CREATED —
     * before any movement was attached to any of its lines. Reporting that object told every
     * caller `stockApplied: false` on every line of a delivery that had in fact moved the
     * workbook perfectly. A supervisor reading "the stock did not move" after a receipt that
     * worked will record the delivery again, which is the one thing an over-receipt guard
     * should never have to catch.
     */
    const settled = (await this.deps.repo.listGoodsReceipts(tenant, input.poId))
      .find((r) => r.id === receipt.id) ?? receipt;

    return { receipt: settled, movements, unapplied };
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

  /**
   * Say that a maintenance ticket was about this asset. The sheet holds only prose.
   *
   * THE ASSET IS RESOLVED; THE TICKET REFERENCE IS NOT, and that asymmetry is deliberate
   * rather than an oversight. `assetRef` must name a row in the caller's own `16_ASSETS` or
   * the link is refused. `ticketRef` is stored as given — it is the workbook's own free-text
   * maintenance note in structured form, and a customer legitimately references tickets this
   * product never created, including ones from before it existed.
   *
   * WHAT THAT COSTS, stated so nobody has to rediscover it: a link may name a ticket that
   * does not exist, or that exists in another customer's workbook. Nothing crosses a tenant
   * boundary — the link itself is tenant-scoped and the other customer sees none of it — but
   * ANY future screen that joins `linkedTickets` back to a maintenance row must do the lookup
   * in the caller's own data and treat a miss as ordinary. It must not treat this reference
   * as proof the ticket is theirs, because it is not.
   */
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

/** How many times a movement will recompute against a total somebody else moved first. */
const STALE_RETRY_LIMIT = 3;

/**
 * Did the write refuse because the total it was computed from had already moved?
 *
 * `STALE_PRECONDITION` is raised only by the repository's precondition check, which runs
 * strictly BEFORE `batchUpdate`. That ordering is the whole reason a retry is safe here:
 * nothing was written, so recomputing against the current total and trying again cannot
 * double-count. A verify failure — where the write went out and the read-back disagreed —
 * carries a different code precisely so it is never retried this way.
 */
function isStalePrecondition(error: unknown): boolean {
  return (error as { code?: string })?.code === 'STALE_PRECONDITION';
}

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

/**
 * Which column a RECORDED movement corrects — read back from the row, never re-derived from
 * a caller's input, because the caller of a repair supplies nothing but an id.
 *
 * The same rule the repository uses for totals: an adjustment carries its direction in the
 * `[+]` / `[-]` prefix its reason was written with, and everything else is fixed by type.
 */
function effectOfMovement(m: Movement): 'PURCHASED' | 'USED' {
  if (m.movementType === 'ADJUSTMENT') {
    return (m.reason ?? '').startsWith('[+]') ? 'PURCHASED' : 'USED';
  }
  return MOVEMENT_EFFECT[m.movementType];
}

/** Actor comparison for separation of duty. Trimmed and case-folded, never exact-match only. */
function sameActor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
