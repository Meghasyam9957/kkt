import '@/lib/server/only';
/**
 * MUTATION SCHEMAS — layer 1 (shape) and layer 2 (vocabulary) of write validation.
 *
 * Vocabularies come FROM the generated V1 contract (`LISTS`), never retyped: when a list
 * changes in the workbook, contract regeneration changes these schemas without a code
 * edit. Layer 3 (referential business checks — does the property exist, is it active,
 * do the dates make sense) lives beside each mutation definition in mutation-services.
 *
 * NO SCHEMA COMPUTES A FIGURE. Derived money (totals, fees, payouts, variances) is
 * `role: calc` in the contract and simply has no field here — the workbook's formulas
 * own it, which is the entire point of the architecture.
 */
import { z } from 'zod';
import { LISTS } from '@/lib/contract/contract.generated';
import { isoToSerial } from '@/lib/shared/dates';

/* ------------------------------------------------------------------ *
 * Shared scalars
 * ------------------------------------------------------------------ */

const listEnum = (name: keyof typeof LISTS) =>
  z.enum(LISTS[name] as unknown as [string, ...string[]]);

/** ISO calendar date, transported as a string, written to the sheet as a SERIAL number
 *  so the workbook's locale can never re-interpret it (spike-verified strategy). */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const Money = z.number().finite().nonnegative();
export const PositiveMoney = z.number().finite().positive();

/** Every mutation carries the intent id minted when the flow started. */
export const OperationEnvelope = z.object({
  operationId: z.string().uuid('operationId must be a UUID minted when the form opened'),
});

export const isoToSheetSerial = (iso: string): number => isoToSerial(iso);

/* ------------------------------------------------------------------ *
 * Reservations — 04_RESERVATIONS
 * ------------------------------------------------------------------ */

export const ReservationCreate = OperationEnvelope.extend({
  platform: z.string().min(1),
  platformResId: z.string().max(64).optional(),
  propertyId: z.string().min(1),
  bookingDate: IsoDate,
  bookingStatus: listEnum('BOOKING_STATUS').default('Confirmed'),
  guestName: z.string().min(1).max(120),
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20).default(0),
  checkInDate: IsoDate,
  checkOutDate: IsoDate,
  baseRate: Money.optional(),
  roomRevenue: Money.optional(),
  cleaningFee: Money.optional(),
  extraGuestFee: Money.optional(),
  otherCharges: Money.optional(),
  discount: Money.optional(),
  notes: z.string().max(500).optional(),
}).strict();

export const ReservationUpdate = OperationEnvelope.extend({
  bookingStatus: listEnum('BOOKING_STATUS').optional(),
  guestName: z.string().min(1).max(120).optional(),
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  checkInDate: IsoDate.optional(),
  checkOutDate: IsoDate.optional(),
  actualPayout: Money.optional(),
  payoutDate: IsoDate.optional(),
  notes: z.string().max(500).optional(),
}).strict();

/**
 * Check-in / check-out / cancel are status transitions with their own envelopes.
 *
 * Everything beside the transition is OPTIONAL, and an omitted field is not written at
 * all (`stripUndefined`, mutations.ts). That is what lets a front desk record the arrival
 * time now and the verification later without a blank overwriting what is already there.
 *
 * Every field below is a `role: in` column of 04_RESERVATIONS with a vocabulary the
 * contract already owns — GuestVerification comes from the VERIFY list, not from here.
 * NO FIGURE APPEARS: a late checkout is a fact about the stay, and any charge for one is
 * a business decision this product has not been given.
 */
export const ReservationCheckIn = OperationEnvelope.extend({
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  guestVerification: listEnum('VERIFY').optional(),
  earlyCheckIn: z.boolean().optional(),
  notes: z.string().max(500).optional(),
}).strict();
export const ReservationCheckOut = OperationEnvelope.extend({
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  lateCheckout: z.boolean().optional(),
  damageReport: z.string().max(500).optional(),
  maintenanceRequired: z.boolean().optional(),
  notes: z.string().max(500).optional(),
}).strict();
export const ReservationCancel = OperationEnvelope.extend({
  reason: z.string().min(3).max(300),
  noShow: z.boolean().default(false),
}).strict();

/** Legal booking-status transitions. A cancellation is a transition, never a deletion. */
export const RESERVATION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  'Inquiry': ['Confirmed', 'Cancelled'],
  'Confirmed': ['Checked In', 'Cancelled', 'No Show'],
  'Checked In': ['Checked Out'],
  'Checked Out': [],
  'Cancelled': [],
  'No Show': [],
};

/* ------------------------------------------------------------------ *
 * Revenue — 05_REVENUE
 * ------------------------------------------------------------------ */

export const RevenueCreate = OperationEnvelope.extend({
  bookingId: z.string().max(24).optional(),
  propertyId: z.string().min(1),
  date: IsoDate,
  revenueType: listEnum('REVENUE_TYPE'),
  platform: z.string().min(1),
  grossAmount: PositiveMoney,
  payoutStatus: listEnum('PAYOUT_STATUS').default('Pending'),
  payoutDate: IsoDate.optional(),
  paymentAccount: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
}).strict();

export const RevenueUpdate = OperationEnvelope.extend({
  payoutStatus: listEnum('PAYOUT_STATUS').optional(),
  payoutDate: IsoDate.optional(),
  paymentAccount: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Expenses — 06_EXPENSES
 * ------------------------------------------------------------------ */

export const ExpenseCreate = OperationEnvelope.extend({
  date: IsoDate,
  propertyId: z.string().min(1),
  expenseCategory: listEnum('EXPENSE_CATEGORY'),
  expenseSubcategory: z.string().min(1).max(60),
  description: z.string().min(3).max(300),
  vendor: z.string().max(120).optional(),
  amount: PositiveMoney,
  tax: Money.default(0),
  paymentMethod: listEnum('PAYMENT_METHOD').optional(),
  paymentStatus: listEnum('PAYMENT_STATUS').default('Pending'),
  paidDate: IsoDate.optional(),
  recurring: listEnum('RECURRING').optional(),
  expenseType: listEnum('EXPENSE_TYPE').default('Operating'),
}).strict();

export const ExpenseUpdate = OperationEnvelope.extend({
  paymentStatus: listEnum('PAYMENT_STATUS').optional(),
  paidDate: IsoDate.optional(),
  vendor: z.string().max(120).optional(),
  description: z.string().min(3).max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * CAPEX — 07_CAPEX_SETUP
 * ------------------------------------------------------------------ */

export const CapexCreate = OperationEnvelope.extend({
  propertyId: z.string().min(1),
  date: IsoDate,
  category: listEnum('CAPEX_CATEGORY'),
  item: z.string().min(3).max(200),
  quantity: z.number().int().min(1).max(999).default(1),
  unitCost: PositiveMoney,
  vendor: z.string().max(120).optional(),
  paymentStatus: listEnum('PAYMENT_STATUS').default('Paid'),
  assetId: z.string().max(24).optional(),
  usefulLifeMonths: z.number().int().min(1).max(600).optional(),
  warrantyExpiry: IsoDate.optional(),
}).strict();

export const CapexUpdate = OperationEnvelope.extend({
  paymentStatus: listEnum('PAYMENT_STATUS').optional(),
  vendor: z.string().max(120).optional(),
  assetId: z.string().max(24).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Rent — 08_RENT_FIXED_COSTS (register rows exist; the web records payments)
 * ------------------------------------------------------------------ */

export const RentUpdate = OperationEnvelope.extend({
  lastPaidDate: IsoDate.optional(),
  paidForMonth: IsoDate.optional(),
  notes: z.string().max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Cash flow — 09_CASH_FLOW
 * ------------------------------------------------------------------ */

export const CashflowCreate = OperationEnvelope.extend({
  date: IsoDate,
  type: listEnum('CASH_TYPE'),
  refId: z.string().max(24).optional(),
  description: z.string().min(3).max(300),
  moneyIn: Money.default(0),
  moneyOut: Money.default(0),
  account: z.string().max(60).optional(),
  reconStatus: listEnum('RECON_STATUS').default('Unreconciled'),
  notes: z.string().max(300).optional(),
}).strict();

export const CashflowUpdate = OperationEnvelope.extend({
  reconStatus: listEnum('RECON_STATUS').optional(),
  notes: z.string().max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Housekeeping — 13_HOUSEKEEPING
 * ------------------------------------------------------------------ */

export const HousekeepingCreate = OperationEnvelope.extend({
  bookingId: z.string().max(24).optional(),
  propertyId: z.string().min(1),
  checkoutDate: IsoDate,
  cleaner: z.string().max(80).optional(),
  notes: z.string().max(300).optional(),
}).strict();

export const HousekeepingUpdate = OperationEnvelope.extend({
  cleaner: z.string().max(80).optional(),
  inspectionStatus: listEnum('INSPECTION').optional(),
  finalStatus: listEnum('HK_STATUS').optional(),
  linenChanged: z.boolean().optional(),
  toiletriesRestocked: z.boolean().optional(),
  kitchenChecked: z.boolean().optional(),
  damageChecked: z.boolean().optional(),
  notes: z.string().max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Maintenance — 14_MAINTENANCE
 * ------------------------------------------------------------------ */

export const MaintenanceCreate = OperationEnvelope.extend({
  propertyId: z.string().min(1),
  dateReported: IsoDate,
  issueCategory: listEnum('MAINT_CATEGORY'),
  description: z.string().min(3).max(300),
  priority: listEnum('MAINT_PRIORITY'),
  reportedBy: z.string().max(80).optional(),
  estimatedCost: Money.optional(),
  notes: z.string().max(300).optional(),
}).strict();

export const MaintenanceUpdate = OperationEnvelope.extend({
  status: listEnum('MAINT_STATUS').optional(),
  priority: listEnum('MAINT_PRIORITY').optional(),
  assignedTo: z.string().max(80).optional(),
  dateResolved: IsoDate.optional(),
  actualCost: Money.optional(),
  expenseId: z.string().max(24).optional(),
  vendor: z.string().max(120).optional(),
  notes: z.string().max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Inventory — 15_INVENTORY (movements are input-field updates on an item row)
 * ------------------------------------------------------------------ */

/**
 * THE STOCK WRITE. Not reachable over HTTP — see `InventoryMasterUpdate` below for the
 * endpoint, and `lib/server/api/routes.ts` for the governance rule that keeps them apart.
 *
 * `purchased` and `used` are CUMULATIVE ABSOLUTE totals, because that is what
 * `15_INVENTORY` holds. Only `InventoryService.recordMovement` may set them, and it
 * computes them by adding a movement to what the sheet said a moment ago.
 *
 * `expectedPurchased` / `expectedUsed` are the COMPARE half of a compare-before-write.
 * They say what the caller believed the running total was when it did that arithmetic. The
 * mutation refuses if the sheet has moved on, which is the only way this design can notice a
 * concurrent movement from another process — Google Sheets offers no conditional write to
 * do it properly. Neither field is a sheet column: `toColumns` never emits them, so the
 * contract check never sees them.
 */
export const InventoryUpdate = OperationEnvelope.extend({
  purchased: z.number().int().min(0).optional(),
  used: z.number().int().min(0).optional(),
  expectedPurchased: z.number().int().min(0).optional(),
  expectedUsed: z.number().int().min(0).optional(),
  minStock: z.number().int().min(0).optional(),
  lastPurchaseDate: IsoDate.optional(),
  lastPurchaseCost: Money.optional(),
  vendor: z.string().max(120).optional(),
  notes: z.string().max(300).optional(),
}).strict().superRefine((v, ctx) => {
  /*
   * A CUMULATIVE TOTAL MAY NEVER BE SET WITHOUT SAYING WHERE IT CAME FROM.
   *
   * Without this the precondition is opt-in, and an opt-in safety check is one a future
   * caller omits by accident and nobody notices until two increments have gone missing. The
   * pairing is what makes "set Purchased to 40" mean "add to the 35 I read" rather than
   * "make it 40 whatever it says now".
   */
  if (v.purchased !== undefined && v.expectedPurchased === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['expectedPurchased'],
      message: 'setting Purchased requires expectedPurchased — the total it was computed from',
    });
  }
  if (v.used !== undefined && v.expectedUsed === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['expectedUsed'],
      message: 'setting Used requires expectedUsed — the total it was computed from',
    });
  }
});

/**
 * THE ITEM-MASTER WRITE, and the only inventory update reachable over HTTP.
 *
 * Editing an item's reorder level, its vendor name or its notes is not a stock movement and
 * must not require one. Moving stock IS a movement and must never happen without the
 * employee, the task and the reason that `POST /api/inventory/movements` collects.
 *
 * `purchased` and `used` are therefore ABSENT here rather than optional, and the schema is
 * `.strict()`, so sending either is a 422 rather than a silently ignored field. Until
 * M-SEC-1 this endpoint accepted both: a caller could set the running totals to any absolute
 * figure, with no employee, no task and no reason, leaving reconciliation to report
 * UNEXPLAINED_MOVEMENT for the life of the item and nobody able to say what had happened.
 */
export const InventoryMasterUpdate = OperationEnvelope.extend({
  minStock: z.number().int().min(0).optional(),
  lastPurchaseDate: IsoDate.optional(),
  lastPurchaseCost: Money.optional(),
  vendor: z.string().max(120).optional(),
  notes: z.string().max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Investors — 11_INVESTORS (management only)
 * ------------------------------------------------------------------ */

export const InvestorCreate = OperationEnvelope.extend({
  investorName: z.string().min(2).max(120),
  investmentAmount: PositiveMoney,
  investmentDate: IsoDate,
  /**
   * A management-decided figure, entered — never defaulted, never derived. The workbook's
   * ShareCheck formula flags a register that does not sum to 100%.
   */
  participationPct: z.number().min(0).max(100),
  status: listEnum('INVESTOR_STATUS').default('Active'),
  agreementRef: z.string().max(60).optional(),
  contact: z.string().max(120).optional(),
  notes: z.string().max(300).optional(),
}).strict();

export const InvestorUpdate = OperationEnvelope.extend({
  status: listEnum('INVESTOR_STATUS').optional(),
  agreementRef: z.string().max(60).optional(),
  contact: z.string().max(120).optional(),
  notes: z.string().max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Distributions — 12_INVESTOR_DISTRIBUTIONS (paid fields only; the pool is calc)
 * ------------------------------------------------------------------ */

export const DistributionUpdate = OperationEnvelope.extend({
  /** Which period's row — DIST rows are keyed by (InvestorID, Period), not by ID alone. */
  period: IsoDate,
  paidAmount: Money.optional(),
  paidDate: IsoDate.optional(),
  paymentRef: z.string().max(60).optional(),
  notes: z.string().max(300).optional(),
}).strict();

/* ------------------------------------------------------------------ *
 * Properties — 03_PROPERTIES (explicit human-assigned ID; no ID rule exists)
 * ------------------------------------------------------------------ */

export const PropertyCreate = OperationEnvelope.extend({
  propertyId: z.string().regex(/^HYD-\d{3}$/, 'Property IDs look like HYD-501'),
  unit: z.string().min(3).max(120),
  bhkType: listEnum('BHK'),
  maxGuests: z.number().int().min(1).max(20),
  propertyStatus: listEnum('PROPERTY_STATUS').default('Available'),
  listingStatus: listEnum('LISTING_STATUS').default('Draft'),
}).strict();

export const PropertyUpdate = OperationEnvelope.extend({
  unit: z.string().min(3).max(120).optional(),
  maxGuests: z.number().int().min(1).max(20).optional(),
  propertyStatus: listEnum('PROPERTY_STATUS').optional(),
  listingStatus: listEnum('LISTING_STATUS').optional(),
}).strict();
