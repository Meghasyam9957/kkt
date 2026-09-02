/**
 * Domain records — the typed shapes the engine and API speak in.
 *
 * Field names mirror the V1 column keys exactly (from the generated contract), so a
 * reader can hold this file and `00_constants.gs` side by side without translating.
 * Dates are spreadsheet serials (see lib/shared/dates.ts).
 */
import type { Serial } from './dates';

export type BookingStatus =
  | 'Inquiry' | 'Confirmed' | 'Checked In' | 'Checked Out' | 'Cancelled' | 'No Show';

/** Statuses V1 counts as real stays for occupancy / ADR / booking counts. */
export const OCCUPANCY_STATUSES: readonly BookingStatus[] = ['Confirmed', 'Checked In', 'Checked Out'];
/** Statuses V1 counts as lost bookings for the cancellation rate. */
export const CANCELLED_STATUSES: readonly BookingStatus[] = ['Cancelled', 'No Show'];

export interface PropertyRecord {
  PropertyID: string;
  Unit: string;
  BHKType: string;
  MaxGuests: number;
  /** V1 excludes `Blocked` units from the active-unit count. */
  PropertyStatus: string;
  ListingStatus: string;
}

export interface ReservationRecord {
  BookingID: string;
  Platform: string;
  PlatformResID: string;
  PropertyID: string;
  /**
   * 04_RESERVATIONS BookingDate — when the booking was MADE, not when the stay is.
   *
   * Null when the source does not supply it. The generated demonstration dataset
   * does not: inventing lead times would fabricate the very evidence a historical
   * re-estimate is supposed to test. Anything reasoning about what was on the books
   * at a past date must therefore handle null rather than assume a date exists.
   */
  BookingDate: Serial | null;
  BookingStatus: BookingStatus | string;
  GuestName: string;
  Adults: number;
  Children: number;
  CheckInDate: Serial | null;
  CheckOutDate: Serial | null;
  BaseRate: number;
  RoomRevenue: number;
  CleaningFee: number;
  ExtraGuestFee: number;
  OtherCharges: number;
  Discount: number;
  Taxes: number;
  /** Actual OTA fee when known; blank/0 means "estimate from the Settings commission %". */
  PlatformFee: number;
  OtherDeductions: number;
  ActualPayout: number;
  PayoutDate: Serial | null;

  /*
   * FRONT-OFFICE DETAIL — 04_RESERVATIONS input columns that no calculation depends on.
   *
   * Optional on purpose, and `undefined` means "nobody has recorded this", which is a
   * different fact from "recorded as no". A blank MaintenanceRequired is not a unit
   * confirmed undamaged; it is a check nobody has made, and a detail panel that renders
   * the two the same way is lying quietly. The KPI engine reads none of them.
   *
   * CheckInTime and CheckOutTime are WRITTEN today by the check-in and check-out
   * mutations and were never read back anywhere — the times went into the workbook and
   * out of the product's sight.
   */
  /** Recorded AT check-in. The workbook carries no SCHEDULED arrival time. */
  CheckInTime?: string;
  CheckOutTime?: string;
  EarlyCheckIn?: boolean;
  LateCheckout?: boolean;
  /** 02_SETTINGS vocabulary — whether the guest's identity was verified, and how. */
  GuestVerification?: string;
  DamageReport?: string;
  MaintenanceRequired?: boolean;
  Notes?: string;
}

export interface RevenueRecord {
  RevenueID: string;
  BookingID: string;
  PropertyID: string;
  Date: Serial | null;
  RevenueType: string;
  Platform: string;
  GrossAmount: number;
  Discount: number;
  Tax: number;
  PlatformFee: number;
  OtherDeduction: number;
  PayoutStatus: string;
}

export interface ExpenseRecord {
  ExpenseID: string;
  Date: Serial | null;
  PropertyID: string;
  ExpenseCategory: string;
  ExpenseSubcategory: string;
  Amount: number;
  Tax: number;
  PaymentStatus: string;
  /** Only `Operating` rows reach the P&L. Blank is an entry error (V1 QA-31). */
  ExpenseType: string;
}

export interface CapexRecord {
  CapexID: string;
  PropertyID: string;
  Date: Serial | null;
  Category: string;
  Quantity: number;
  UnitCost: number;
  /** Presentation fields (optional — the KPI engine does not depend on them). */
  Item?: string;
  PaymentStatus?: string;
}

export interface CashFlowRecord {
  TxnID: string;
  Date: Serial | null;
  Type: string;
  PropertyID: string;
  MoneyIn: number;
  MoneyOut: number;
  ReconStatus: string;
}

export interface InvestorRecord {
  InvestorID: string;
  InvestorName: string;
  InvestmentAmount: number;
  ParticipationPct: number;
  Status: string;
}

export interface DistributionRecord {
  Period: Serial | null;
  InvestorID: string;
  PaidAmount: number;
  PaidDate: Serial | null;
  /**
   * V1 calculated column (CalculatedDistribution − PaidAmount). Read, never written.
   * `99_CALC.PendingInvestorDistributions` sums it, and that feeds Pending Payables —
   * so the engine has to see the same column the workbook sees.
   */
  PendingAmount: number;
}

/**
 * Business rules read from 02_SETTINGS named ranges.
 * `null` means TBD/blank — the engine must then behave exactly as the workbook does:
 * calculate zero and report that configuration is required. It must never assume a value.
 */
export interface BusinessSettings {
  /**
   * Business identity, read from the workbook's own CFG_* cells rather than hard-coded in
   * the app. If the operator renames the business in 02_SETTINGS, the UI follows.
   */
  businessName: string;
  city: string;
  country: string;
  currency: string;
  fyStart: Serial;
  investorPoolPct: number | null;
  operatorPoolPct: number | null;
  reservePct: number | null;
  mgmtFeePct: number | null;
  lossTreatment: string;
  profitDefinition: string;
  payoutToleranceInr: number;
  payoutOverdueDays: number;
  /** Days before a rent due date at which 08_RENT flips to "Due soon". */
  rentDueDays: number;
  /** Platform → commission fraction (null = not configured). */
  platformCommission: Record<string, number | null>;
  /** Platform → payout lag in days. */
  platformPayoutLagDays: Record<string, number>;
}

export interface WorkbookData {
  properties: PropertyRecord[];
  reservations: ReservationRecord[];
  revenue: RevenueRecord[];
  expenses: ExpenseRecord[];
  capex: CapexRecord[];
  cashflow: CashFlowRecord[];
  investors: InvestorRecord[];
  distributions: DistributionRecord[];
  settings: BusinessSettings;
}

/** One column of the 99_CALC monthly block, computed server-side. */
export interface MonthlyMetrics {
  monthKey: string;
  monthStart: Serial;
  monthEnd: Serial;
  daysInMonth: number;
  activeUnits: number;
  availableNights: number;
  occupiedNights: number;
  occupancyPct: number;
  roomRevenue: number;
  cleaningRevenue: number;
  otherRevenue: number;
  grossRevenue: number;
  discounts: number;
  platformFees: number;
  taxes: number;
  netRevenue: number;
  operatingExpenses: number;
  operatingProfit: number;
  operatingMarginPct: number;
  adr: number;
  revPar: number;
  bookingsCount: number;
  cancelledCount: number;
  cancellationRatePct: number;
  alos: number;
  capexTotal: number;
  reserveAmt: number;
  mgmtFeeAmt: number;
  carryForwardApplied: number;
  carryForwardBalance: number;
  distributableProfit: number;
  investorPoolAmt: number;
  distributionsPaid: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
}

export interface PropertyPerformance {
  propertyId: string;
  unit: string;
  netRevenue: number;
  directOperatingExpenses: number;
  profit: number;
  occupiedNights: number;
  availableNights: number;
  occupancyPct: number;
  adr: number;
  revPar: number;
  bookings: number;
}

export interface PlatformPerformance {
  platform: string;
  bookings: number;
  grossRevenue: number;
  feesAndDeductions: number;
  netRevenue: number;
  shareOfNetRevenue: number;
}

export interface InvestorWaterfall {
  monthKey: string;
  grossRevenue: number;
  discounts: number;
  platformFees: number;
  taxes: number;
  netRevenue: number;
  operatingExpenses: number;
  operatingProfit: number;
  reserve: number;
  mgmtFee: number;
  carryForwardApplied: number;
  distributableProfit: number;
  investorPoolPct: number | null;
  investorPoolAmt: number;
  operatorShare: number;
  /** Mirrors the workbook's own gate: unset rules ⇒ engine idle, never an invented figure. */
  configured: boolean;
  configurationMessage: string;
}

export interface InvestorAllocation {
  monthKey: string;
  investorId: string;
  investorName: string;
  participationPct: number;
  poolAmount: number;
  calculatedDistribution: number;
  paidAmount: number;
  pendingAmount: number;
  status: 'Paid' | 'Partial' | 'Pending' | 'None' | 'Not configured';
}


/* ------------------------------------------------------------------ *
 * OPERATIONAL DATA — V1 sheets 13_HOUSEKEEPING / 14_MAINTENANCE / 15_INVENTORY.
 *
 * Shaped once here so the fixture source and the Google Sheets source produce the
 * SAME structure. The TODAY panel and the unit-status board are derived from these
 * records; no counter is ever authored directly.
 * ------------------------------------------------------------------ */

export interface MaintenanceTicket {
  /**
   * 14_MAINTENANCE.AssignedTo — a NAME, and the column has always held one. Read from
   * M-OPS-2 onward because the assignment overlay has to compare what the sheet says
   * against what this application wrote; without it a hand-edit of the cell would be
   * undetectable. Nothing writes it except the existing `maintenance.update` mutation.
   */
  assignedTo: string;
  ticketId: string;
  propertyId: string;
  category: string;
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  status: 'Open' | 'Assigned' | 'In Progress' | 'Waiting' | 'Resolved' | 'Closed';
  description: string;
  reportedOn: string;
}

export interface HousekeepingTask {
  taskId: string;
  propertyId: string;
  checkoutDate: string;
  /**
   * 13_HOUSEKEEPING FinalStatus — THE turnover's own state, and the canonical one.
   * `Failed Inspection` lives here, which is why the inspection result below is a
   * sub-step rather than a second lifecycle.
   */
  status: 'Pending' | 'Assigned' | 'In Progress' | 'Completed' | 'Failed Inspection';
  /**
   * InspectionStatus — Pending / Passed / Failed, from the INSPECTION list.
   *
   * Written by `housekeeping.update` (the mark-clean form asks for it) and, until now,
   * never read back: a front office recorded an inspection result it could never see
   * again. It is a SUB-STEP of `status`, not a competing state, and nothing derives one
   * from the other. Empty where the turnover has not reached an inspection.
   */
  inspectionStatus: string;
  /** Cleaner — who is handling it. Written by create and update; empty when unassigned. */
  cleaner: string;
  /**
   * BookingID, as recorded ON THE TURNOVER — and nothing more than that.
   *
   * The column exists and `housekeeping.create` writes whatever it is given, but NOTHING
   * validates it against 04_RESERVATIONS (compare `revenue.create`, which does check),
   * nothing makes it unique, and nothing requires it: every seeded turnover in both demo
   * sources leaves it empty. So a value here may be READ FORWARD — this turnover names
   * that booking — and must never be read backward: the absence of a reference is not
   * evidence that a booking had no turnover. See docs/UI8_TURNOVER_DECISIONS.md.
   */
  bookingId: string;
}

export interface InventoryItem {
  itemId: string;
  propertyId: string;
  item: string;
  unit: string;
  currentStock: number;
  minStock: number;
  /**
   * INV_CATEGORY — Toiletries, Cleaning Supplies, Kitchen / Pantry, Linen, Guest Amenities,
   * Other. Read from M-INV-1 so stock can be grouped by the workbook's own vocabulary
   * rather than a second one invented here.
   */
  category: string;
  /**
   * THE CUMULATIVE TOTALS, read from M-INV-1 onward.
   *
   * These were written by `inventory.update` and never read back, which is why recording a
   * movement asked an operator to retype a running total the product had never shown them —
   * and why getting it wrong made stock fall after a purchase with nothing to notice.
   * Reading them is what lets the server compute the new total itself.
   *
   * `currentStock` above stays the workbook's formula over these. Nothing recomputes it.
   */
  openingStock: number;
  purchased: number;
  used: number;
  /** 15_INVENTORY.Vendor — a NAME, like every other vendor cell in this workbook. */
  vendor: string;
}

export interface GuestRequest {
  requestId: string;
  propertyId: string;
  summary: string;
  raisedOn: string;
  status: 'Open' | 'In Progress' | 'Resolved';
}

export interface OperationsData {
  /** ISO date the operational snapshot describes. */
  today: string;
  maintenance: MaintenanceTicket[];
  housekeeping: HousekeepingTask[];
  inventory: InventoryItem[];
  guestRequests: GuestRequest[];
  /**
   * Counters this data source genuinely cannot supply — e.g. guest requests have no V1
   * sheet, so a live read has no records to count. Listing the key here makes the UI
   * render "not tracked" instead of a zero that reads like a real business outcome.
   */
  unavailableCounters: string[];
}

/** Ticket states that mean "still needs someone". Shared by both data sources. */
export const OPEN_MAINTENANCE_STATUSES: readonly string[] =
  ['Open', 'Assigned', 'In Progress', 'Waiting'];

/** Housekeeping states that mean the turnover is not finished. */
export const OPEN_HOUSEKEEPING_STATUSES: readonly string[] =
  ['Pending', 'Assigned', 'In Progress', 'Failed Inspection'];


/* ------------------------------------------------------------------ *
 * REGISTERS — V1 sheets 08_RENT_FIXED_COSTS / 16_ASSETS / 17_COMPLIANCE.
 *
 * Read-only reference data, kept out of `WorkbookData` so the P&L calculations take
 * exactly the inputs they need — rent reaches the P&L through 06_EXPENSES, not from
 * here. The rent register owns the *obligation* view instead: what is due and what is
 * late. `pendingPayables()` takes it as an explicit argument for that reason.
 * ------------------------------------------------------------------ */

export interface RentRecord {
  recordId: string;
  propertyId: string;
  costType: string;
  landlordVendor: string;
  monthlyAmount: number;
  dueDay: number;
  agreementStart: string;
  agreementEnd: string;
  escalationPct: number;
  lastPaidDate: string | null;
  /** The month this payment COVERS, not the month it was paid in. V1's covered-month rule. */
  paidForMonth: string | null;
  /** V1 calculated columns — ported in `lib/server/analytics/rent.ts`. */
  nextDueDate: string | null;
  paymentStatus: string;
  notes: string;
}

export interface AssetRecord {
  assetId: string;
  propertyId: string;
  category: string;
  asset: string;
  purchaseDate: string;
  purchaseCost: number;
  vendor: string;
  warrantyExpiry: string | null;
  usefulLifeMonths: number;
  /**
   * CONDITION — the workbook's own list is New / Good / Fair / Poor / BROKEN.
   *
   * This union said 'Damaged', a value the sheet's validation would refuse. Nothing had ever
   * written it, because nothing writes assets at all, so the mismatch was invisible until
   * M-INV-1 came to read the register.
   */
  condition: 'New' | 'Good' | 'Fair' | 'Poor' | 'Broken';
  currentStatus: 'In Use' | 'In Storage' | 'Under Repair' | 'Disposed';
  /** WarrantyStatus is a workbook formula. Read, never recomputed. */
  warrantyStatus: string;
  /** Free prose in the sheet. The ticket references live in the overlay instead. */
  maintenanceHistory: string;
  disposalDate: string | null;
  notes: string;
}

export interface ComplianceRecord {
  complianceId: string;
  requirement: string;
  propertyId: string;
  authority: string;
  responsiblePerson: string;
  status: 'Valid' | 'Expiring Soon' | 'Expired' | 'Not Applicable' | 'In Progress';
  issueDate: string | null;
  expiryDate: string | null;
  documentRef: string;
  notes: string;
}

/**
 * A demonstration guest session. There is no V1 sheet for this and none is implied — it
 * exists so the guest journey can be shown end to end with deterministic, fictional data.
 */
export interface GuestSession {
  sessionId: string;
  bookingId: string;
  propertyId: string;
  guestDisplayName: string;
  checkIn: string;
  checkOut: string;
  status: 'Arriving' | 'In House' | 'Departed';
  /** Always true: these records exist only in the demo environment. */
  demo: true;
}
