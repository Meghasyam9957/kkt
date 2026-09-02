import '@/lib/server/only';
/**
 * WHAT LEAVES THE SERVER, AND WHAT NEVER DOES.
 *
 * Same discipline as every other domain here: fresh object literals, never a spread, with
 * compile-time guards underneath that refuse to build if a withheld field ever appears.
 *
 * THE ONE INVENTORY-SPECIFIC RULE. An asset's purchase cost is a real figure that finance
 * legitimately needs and operations does not. It is therefore projected CONDITIONALLY, by
 * capability, rather than being either always present or always absent — and the absent case
 * is `null` with a flag saying it was withheld, so a screen can say "not shown to you"
 * instead of "nothing was paid". Those are very different sentences.
 *
 * `purchaseCostMinor` is what was PAID. It is not a net book value: no depreciation is
 * modelled anywhere in this product, and rendering a purchase price as a book value would be
 * an accounting claim nobody has made.
 */
import type {
  AssetView, ItemReconciliation, Movement, PurchaseOrder, PurchaseRequest, StockItem,
  GoodsReceipt,
} from './types';

export interface StockItemView {
  readonly itemRef: string;
  readonly propertyId: string | null;
  readonly category: string;
  readonly name: string;
  readonly unit: string;
  readonly currentStock: number | null;
  readonly minStock: number | null;
  readonly status: string;
  /** The name in the workbook cell, and whether we know who that is. */
  readonly vendorName: string | null;
  readonly vendorLinked: boolean;
}

export interface MovementView {
  readonly id: string;
  readonly itemRef: string;
  readonly propertyId: string | null;
  readonly movementType: string;
  readonly quantity: number;
  readonly taskType: string | null;
  readonly taskRef: string | null;
  readonly reason: string | null;
  readonly wastageReason: string | null;
  readonly counterpartyPropertyId: string | null;
  readonly workbookApplied: boolean;
  readonly createdAt: string;
}

export interface ReconciliationView {
  readonly itemRef: string;
  readonly name: string;
  readonly propertyId: string | null;
  readonly status: string;
  readonly workbookPurchased: number | null;
  readonly workbookUsed: number | null;
  readonly contextPurchased: number;
  readonly contextUsed: number;
  readonly unappliedCount: number;
}

export interface RequestView {
  readonly id: string;
  readonly propertyId: string | null;
  readonly status: string;
  readonly priority: string;
  readonly reason: string | null;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly lines: readonly {
    readonly id: string; readonly itemRef: string | null;
    readonly description: string | null; readonly quantity: number;
    readonly unit: string | null;
  }[];
}

export interface PurchaseOrderView {
  readonly id: string;
  readonly vendorId: string;
  readonly propertyId: string | null;
  readonly requestId: string | null;
  readonly status: string;
  readonly orderDate: string | null;
  readonly expectedDate: string | null;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly createdAt: string;
  readonly lines: readonly {
    readonly id: string; readonly itemRef: string | null;
    readonly description: string | null; readonly quantity: number;
    readonly unit: string | null;
    /** Paise. Null both when no price was agreed AND when the caller may not see one. */
    readonly expectedUnitPriceMinor: number | null;
  }[];
  /** True when a price exists but this caller is not entitled to it. */
  readonly pricesWithheld: boolean;
}

export interface GoodsReceiptView {
  readonly id: string;
  readonly poId: string;
  readonly propertyId: string | null;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly notes: string | null;
  readonly lines: readonly {
    readonly id: string; readonly poLineId: string;
    readonly receivedQuantity: number; readonly condition: string | null;
    readonly stockApplied: boolean;
  }[];
}

export interface AssetItemView {
  readonly assetRef: string;
  readonly propertyId: string | null;
  readonly category: string;
  readonly name: string;
  readonly purchaseDate: string | null;
  /** Null when no cost is recorded OR when this caller may not see it — see `costWithheld`. */
  readonly purchaseCostMinor: number | null;
  readonly costWithheld: boolean;
  readonly vendorName: string | null;
  readonly vendorLinked: boolean;
  readonly warrantyExpiry: string | null;
  /** The sheet's own word for it, and the derived signal beside it. Never one replacing the other. */
  readonly warrantyLabel: string;
  readonly warrantyState: string;
  readonly condition: string;
  readonly status: string;
  readonly disposalDate: string | null;
  readonly linkedTickets: readonly string[];
}

export function stockItemView(item: StockItem): StockItemView {
  return {
    itemRef: item.itemRef,
    propertyId: item.propertyId,
    category: item.category,
    name: item.name,
    unit: item.unit,
    currentStock: item.currentStock,
    minStock: item.minStock,
    status: item.status,
    vendorName: item.vendorName,
    // WHETHER we know the vendor, never WHICH — an operations screen has no use for a
    // finance identifier, and the boolean is the whole of what it needs.
    vendorLinked: item.vendorId !== null,
  };
}

export function movementView(movement: Movement): MovementView {
  return {
    id: movement.id,
    itemRef: movement.itemRef,
    propertyId: movement.propertyId,
    movementType: movement.movementType,
    quantity: movement.quantity,
    taskType: movement.taskType,
    taskRef: movement.taskRef,
    reason: movement.reason,
    wastageReason: movement.wastageReason,
    counterpartyPropertyId: movement.counterpartyPropertyId,
    workbookApplied: movement.workbookApplied,
    createdAt: movement.createdAt,
    // `employeeId` and `createdBy` are deliberately absent. Who used two towels is a
    // staff-movement record, and a stock list is not where it belongs.
  };
}

export function reconciliationItemView(row: ItemReconciliation): ReconciliationView {
  return {
    itemRef: row.itemRef,
    name: row.name,
    propertyId: row.propertyId,
    status: row.status,
    workbookPurchased: row.workbookPurchased,
    workbookUsed: row.workbookUsed,
    contextPurchased: row.contextPurchased,
    contextUsed: row.contextUsed,
    unappliedCount: row.unappliedCount,
  };
}

export function requestView(request: PurchaseRequest): RequestView {
  return {
    id: request.id,
    propertyId: request.propertyId,
    status: request.status,
    priority: request.priority,
    reason: request.reason,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    approvedAt: request.approvedAt,
    createdAt: request.createdAt,
    lines: request.lines.map((l) => ({
      id: l.id, itemRef: l.itemRef, description: l.description,
      quantity: l.quantity, unit: l.unit,
    })),
  };
}

/**
 * A purchase order, with prices only for a caller entitled to them.
 *
 * `maySeePrices` is the caller's financial entitlement, decided by the handler from the
 * capability table rather than guessed here. An operations supervisor sees what was ordered
 * and how much of it — which is everything they need to receive a delivery — and not what it
 * cost.
 */
export function purchaseOrderView(po: PurchaseOrder, maySeePrices: boolean): PurchaseOrderView {
  const hasPrices = po.lines.some((l) => l.expectedUnitPriceMinor !== null);
  return {
    id: po.id,
    vendorId: po.vendorId,
    propertyId: po.propertyId,
    requestId: po.requestId,
    status: po.status,
    orderDate: po.orderDate,
    expectedDate: po.expectedDate,
    createdBy: po.createdBy,
    approvedBy: po.approvedBy,
    createdAt: po.createdAt,
    lines: po.lines.map((l) => ({
      id: l.id, itemRef: l.itemRef, description: l.description,
      quantity: l.quantity, unit: l.unit,
      expectedUnitPriceMinor: maySeePrices ? l.expectedUnitPriceMinor : null,
    })),
    // So a screen can say "not shown to you" rather than implying nothing was agreed.
    pricesWithheld: hasPrices && !maySeePrices,
  };
}

export function goodsReceiptView(receipt: GoodsReceipt): GoodsReceiptView {
  return {
    id: receipt.id,
    poId: receipt.poId,
    propertyId: receipt.propertyId,
    receivedBy: receipt.receivedBy,
    receivedAt: receipt.receivedAt,
    notes: receipt.notes,
    lines: receipt.lines.map((l) => ({
      id: l.id, poLineId: l.poLineId,
      receivedQuantity: l.receivedQuantity, condition: l.condition,
      // Whether the workbook took it. The movement's identifier is of no use to a screen.
      stockApplied: l.movementId !== null,
    })),
  };
}

export function assetItemView(asset: AssetView, maySeeCost: boolean): AssetItemView {
  return {
    assetRef: asset.assetRef,
    propertyId: asset.propertyId,
    category: asset.category,
    name: asset.name,
    purchaseDate: asset.purchaseDate,
    purchaseCostMinor: maySeeCost ? asset.purchaseCostMinor : null,
    costWithheld: asset.purchaseCostMinor !== null && !maySeeCost,
    vendorName: asset.vendorName,
    vendorLinked: asset.vendorId !== null,
    warrantyExpiry: asset.warrantyExpiry,
    warrantyLabel: asset.warrantyLabel,
    warrantyState: asset.warrantyState,
    condition: asset.condition,
    status: asset.status,
    disposalDate: asset.disposalDate,
    linkedTickets: [...asset.linkedTickets],
  };
}

/* ------------------------------------------------------------------ *
 * Compile-time guards
 * ------------------------------------------------------------------ */

/** `true` only when T carries no key from F. */
type Disjoint<T, F extends PropertyKey> = Extract<keyof T, F> extends never ? true : never;

/**
 * What an inventory payload must never carry, whatever the caller's role.
 *
 * `purchaseCost` and `unitPrice` are here in their bare forms while the guarded, explicitly
 * named `purchaseCostMinor` and `expectedUnitPriceMinor` are not — the point is that a
 * figure only ever travels through the conditional projections above, where a capability
 * decides it. A field that arrived by any other name would not have been through that gate.
 */
type Withheld =
  | 'salary' | 'gross' | 'net' | 'wage' | 'payroll' | 'compensation'
  | 'bankAccount' | 'ifsc' | 'contactRef' | 'email'
  | 'tenantId' | 'employeeId'
  | 'purchaseCost' | 'unitPrice' | 'cost' | 'valuation' | 'bookValue' | 'depreciation';

/*
 * `createdBy` IS WITHHELD IN THE OPERATIONS PROJECTIONS AND IS NOT WITHHELD HERE, and the
 * difference is deliberate rather than an oversight — the guard caught it and this is the
 * answer.
 *
 * There it is an internal actor stamp on an assignment, and a trail of who put whom on which
 * turnover is a staff-movement record nobody asked for. Here it is the fact the whole control
 * rests on: a purchase request names who asked and who approved, and separation of duty is
 * unreadable — and unauditable — if a screen cannot show that they were different people.
 *
 * `employeeId` stays withheld. Which member of staff used two towels is attribution this
 * database keeps and a stock list has no business displaying.
 */

export const STOCK_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<StockItemView, Withheld> = true;
export const MOVEMENT_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<MovementView, Withheld> = true;
export const RECONCILIATION_VIEW_CARRIES_NOTHING_WITHHELD:
  Disjoint<ReconciliationView, Withheld> = true;
export const REQUEST_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<RequestView, Withheld> = true;
export const PO_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<PurchaseOrderView, Withheld> = true;
export const RECEIPT_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<GoodsReceiptView, Withheld> = true;
export const ASSET_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<AssetItemView, Withheld> = true;
