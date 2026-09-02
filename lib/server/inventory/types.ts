import '@/lib/server/only';
/**
 * INVENTORY — the vocabulary, and where each word's meaning lives.
 *
 * The one thing to hold on to while reading this file: **no type here carries a stock
 * level.** `15_INVENTORY.CurrentStock` is a spreadsheet formula over OpeningStock, Purchased
 * and Used, and it has exactly one home. `StockItem` below reports what the workbook says;
 * nothing in this domain computes, caches or corrects it.
 *
 * What this domain adds is the sentence the workbook cannot say — "Ravi took two towels for
 * HK-D-0044 because the guest checked out" — plus the procurement workflow that happens
 * before stock arrives, and the vendor entity behind a free-text name.
 */
import type { TaskType } from '@/lib/server/operations/types';

/* ------------------------------------------------------------------ *
 * Stock, as the workbook reports it
 * ------------------------------------------------------------------ */

/**
 * How an item stands. Derived from the workbook's own numbers at read time — never stored,
 * because a stored status is a second opinion that goes stale.
 *
 * `UNAVAILABLE` is not "zero". It is "the sheet did not give us a number", which happens
 * with a blank cell or a broken formula, and saying zero would be inventing a fact.
 */
export const STOCK_STATUSES = [
  'IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NEGATIVE', 'UNAVAILABLE',
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export interface StockItem {
  /** 15_INVENTORY.ItemID — the workbook's own identity, never a name. */
  readonly itemRef: string;
  readonly propertyId: string | null;
  readonly category: string;
  readonly name: string;
  readonly unit: string;
  /** Exactly what the sheet's CurrentStock formula produced. Null when it produced nothing. */
  readonly currentStock: number | null;
  readonly minStock: number | null;
  readonly status: StockStatus;
  /** The vendor NAME in the cell, and who we understand that to be. */
  readonly vendorName: string | null;
  readonly vendorId: string | null;
}

/* ------------------------------------------------------------------ *
 * Movement context
 * ------------------------------------------------------------------ */

/**
 * The workbook has no movement vocabulary at all — it has two running totals — so these are
 * new rather than a mapping. Kept operational: every value names something that happens in a
 * homestay, and none of them is an accounting term.
 */
export const MOVEMENT_TYPES = [
  'PURCHASE', 'CONSUMPTION', 'TRANSFER_OUT', 'TRANSFER_IN',
  'ADJUSTMENT', 'WASTAGE', 'RETURN',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const WASTAGE_REASONS = ['DAMAGED', 'LOST', 'EXPIRED', 'BROKEN', 'OTHER'] as const;
export type WastageReason = (typeof WASTAGE_REASONS)[number];

/**
 * Which totals column a movement moves, and in which direction.
 *
 * This is the ONLY place the two vocabularies meet, and it is deliberately a lookup rather
 * than logic scattered through the service. `Purchased` and `Used` only ever increase — they
 * are cumulative — so a movement that reduces stock adds to `Used`, and one that adds stock
 * adds to `Purchased`. There is no third column and no way to write the balance.
 */
export const MOVEMENT_EFFECT: Readonly<Record<MovementType, 'PURCHASED' | 'USED'>> =
  Object.freeze({
    PURCHASE: 'PURCHASED',
    TRANSFER_IN: 'PURCHASED',
    CONSUMPTION: 'USED',
    TRANSFER_OUT: 'USED',
    WASTAGE: 'USED',
    RETURN: 'USED',
    /*
     * An ADJUSTMENT can go either way, so it is not in this table by direction — the caller
     * states which column it corrects, and the service refuses one that does not say.
     * Defaulting it would let a stock correction silently mean its opposite.
     */
    ADJUSTMENT: 'USED',
  });

export interface Movement {
  readonly id: string;
  readonly tenantId: string;
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
  /** Whether the authoritative workbook write landed. False is a repair queue, not a lie. */
  readonly workbookApplied: boolean;
  readonly appliedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface MovementInput {
  readonly itemRef: string;
  readonly movementType: MovementType;
  readonly quantity: number;
  readonly employeeId?: string | null;
  readonly taskType?: TaskType | null;
  readonly taskRef?: string | null;
  readonly reason?: string | null;
  readonly wastageReason?: WastageReason | null;
  readonly counterpartyPropertyId?: string | null;
  /** Required for ADJUSTMENT: which cumulative column this correction belongs to. */
  readonly adjusts?: 'PURCHASED' | 'USED';
}

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

/**
 * Whether the context this database holds agrees with the totals the workbook holds.
 *
 * The comparison is deliberately narrow. It does NOT recompute stock — that would be the
 * second ledger this whole design refuses. It compares the SUM OF RECORDED MOVEMENTS against
 * the workbook's own `Purchased` and `Used` totals, which is the only comparison that can be
 * made without inventing an authority.
 */
export const INVENTORY_RECONCILIATION_STATUSES = [
  /** Every movement we hold is accounted for in the workbook's totals. */
  'MATCHED',
  /** The workbook moved more than we have context for. Ordinary for anything pre-MAKAM. */
  'UNEXPLAINED_MOVEMENT',
  /** We hold context for more than the workbook moved. Something did not land. */
  'CONTEXT_AHEAD',
  /** A movement whose workbook write never landed. Repairable, and visible. */
  'UNAPPLIED_CONTEXT',
  /** The sheet gave no number to compare against. */
  'STOCK_UNAVAILABLE',
] as const;
export type InventoryReconciliationStatus =
  (typeof INVENTORY_RECONCILIATION_STATUSES)[number];

export interface ItemReconciliation {
  readonly itemRef: string;
  readonly name: string;
  readonly propertyId: string | null;
  readonly status: InventoryReconciliationStatus;
  /** What the workbook says moved, from its own cumulative columns. */
  readonly workbookPurchased: number | null;
  readonly workbookUsed: number | null;
  /** What this database has context for. A comparison, never an authority. */
  readonly contextPurchased: number;
  readonly contextUsed: number;
  readonly unappliedCount: number;
}

/* ------------------------------------------------------------------ *
 * Procurement
 * ------------------------------------------------------------------ */

export const REQUEST_STATUSES = [
  'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** What may follow what. Anything not listed is refused, rather than quietly permitted. */
export const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> =
  Object.freeze({
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: [],
    REJECTED: [],
    CANCELLED: [],
  });

export const PO_STATUSES = [
  'DRAFT', 'SUBMITTED', 'APPROVED', 'SENT',
  'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_TRANSITIONS: Readonly<Record<PoStatus, readonly PoStatus[]>> = Object.freeze({
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'CANCELLED'],
  APPROVED: ['SENT', 'CANCELLED'],
  // Receiving is what moves it on from here, and only a receipt does that.
  SENT: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'RECEIVED'],
  RECEIVED: [],
  CANCELLED: [],
});

/** Goods may only be received against an order somebody approved and sent. */
export const RECEIVABLE_PO_STATUSES: readonly PoStatus[] =
  ['SENT', 'PARTIALLY_RECEIVED'];

export interface PurchaseRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly propertyId: string | null;
  readonly status: RequestStatus;
  readonly priority: string;
  readonly reason: string | null;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: string;
  readonly lines: readonly RequestLine[];
}

export interface RequestLine {
  readonly id: string;
  readonly itemRef: string | null;
  readonly description: string | null;
  readonly quantity: number;
  readonly unit: string | null;
}

export interface PurchaseOrder {
  readonly id: string;
  readonly tenantId: string;
  readonly vendorId: string;
  readonly propertyId: string | null;
  readonly requestId: string | null;
  readonly status: PoStatus;
  readonly orderDate: string | null;
  readonly expectedDate: string | null;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly lines: readonly PoLine[];
}

export interface PoLine {
  readonly id: string;
  readonly itemRef: string | null;
  readonly description: string | null;
  readonly quantity: number;
  readonly unit: string | null;
  /** Paise, or null where no price was agreed. An expectation, never a payable. */
  readonly expectedUnitPriceMinor: number | null;
}

export interface GoodsReceipt {
  readonly id: string;
  readonly tenantId: string;
  readonly poId: string;
  readonly propertyId: string | null;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly notes: string | null;
  readonly lines: readonly GoodsReceiptLine[];
}

export interface GoodsReceiptLine {
  readonly id: string;
  readonly poLineId: string;
  readonly receivedQuantity: number;
  readonly condition: string | null;
  /** Null when the workbook write for this line did not land. */
  readonly movementId: string | null;
}

/* ------------------------------------------------------------------ *
 * Assets — the workbook's register, read
 * ------------------------------------------------------------------ */

/**
 * 16_ASSETS is a complete register and stays the workbook's. This is what one row looks like
 * once read, plus the maintenance tickets linked to it — the one thing the sheet cannot hold,
 * because `MaintenanceHistory` there is a paragraph of prose.
 *
 * `purchaseCost` is what was paid, in paise. It is NOT a net book value: no depreciation is
 * modelled anywhere in this product, and calling a purchase price a book value would be an
 * accounting claim nobody has made.
 */
export interface AssetView {
  readonly assetRef: string;
  readonly propertyId: string | null;
  readonly category: string;
  readonly name: string;
  readonly purchaseDate: string | null;
  readonly purchaseCostMinor: number | null;
  readonly vendorName: string | null;
  readonly vendorId: string | null;
  readonly warrantyExpiry: string | null;
  /**
   * The workbook's OWN `WarrantyStatus` cell, carried through verbatim.
   *
   * It is a calculated column, so it is read and never recomputed. It is here so the sheet's
   * answer is visible beside the derived one below rather than silently replaced by it.
   */
  readonly warrantyLabel: string;
  /**
   * The forward-looking operational signal, derived from the `WarrantyExpiry` INPUT column.
   *
   * This is not a second version of `warrantyLabel`. The sheet says whether a warranty is
   * live today; this says whether it is about to stop being live, which is the only version
   * of the question anybody can act on — a warranty noticed the day after it lapsed is a
   * repair somebody now pays for.
   */
  readonly warrantyState: 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'UNKNOWN';
  readonly condition: string;
  readonly status: string;
  readonly disposalDate: string | null;
  readonly linkedTickets: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

export class InventoryError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

/** Not found, or not yours — the same refusal, so nothing is enumerable. */
export function notFound(what: string): InventoryError {
  return new InventoryError(404, 'NOT_FOUND', `No such ${what}.`);
}

export function refuse(code: string, message: string, status = 422): InventoryError {
  return new InventoryError(status, code, message);
}
