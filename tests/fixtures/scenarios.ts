/**
 * Parity fixtures.
 *
 * Every scenario uses a FIXED financial year (2026-04-01, the Indian FY) and round
 * numbers, so each expected value can be verified with a calculator and the parity report
 * is reproducible on any machine on any day. Nothing here depends on `new Date()`.
 *
 * All guest names are obviously fictional.
 */
import { isoToSerial } from '@/lib/shared/dates';
import { fillDistributionPending } from '@/lib/server/analytics/kpi';
import type {
  WorkbookData, BusinessSettings, PropertyRecord, ReservationRecord, RevenueRecord,
  ExpenseRecord, CapexRecord, CashFlowRecord, InvestorRecord, DistributionRecord,
} from '@/lib/shared/domain';

const D = isoToSerial;
export const FY_START = D('2026-04-01');

/* ------------------------------------------------------------------ *
 * Builders — defaults keep each scenario's intent readable.
 * ------------------------------------------------------------------ */

export function settings(overrides: Partial<BusinessSettings> = {}): BusinessSettings {
  return {
    businessName: 'Srivillu Home Stays',
    city: 'Hyderabad',
    country: 'India',
    currency: '₹',
    fyStart: FY_START,
    investorPoolPct: 0.6,
    operatorPoolPct: 0.4,
    reservePct: 0.05,
    mgmtFeePct: null,
    lossTreatment: 'Carry forward',
    profitDefinition: 'Operating Profit after Reserve',
    rentDueDays: 3,
    payoutToleranceInr: 100,
    payoutOverdueDays: 7,
    platformCommission: { Airbnb: 0.15, 'Booking.com': 0.18, Direct: 0 },
    platformPayoutLagDays: { Airbnb: 3, 'Booking.com': 5, Direct: 0 },
    ...overrides,
  };
}

export const PROPERTIES: PropertyRecord[] = [
  { PropertyID: 'HYD-501', Unit: '5th Floor — 2 BHK', BHKType: '2 BHK', MaxGuests: 6, PropertyStatus: 'Available', ListingStatus: 'Live' },
  { PropertyID: 'HYD-502', Unit: '5th Floor — 1 BHK', BHKType: '1 BHK', MaxGuests: 3, PropertyStatus: 'Available', ListingStatus: 'Live' },
  { PropertyID: 'HYD-601', Unit: '6th Floor — 2 BHK', BHKType: '2 BHK', MaxGuests: 6, PropertyStatus: 'Available', ListingStatus: 'Live' },
  { PropertyID: 'HYD-602', Unit: '6th Floor — 1 BHK', BHKType: '1 BHK', MaxGuests: 3, PropertyStatus: 'Available', ListingStatus: 'Live' },
];

let seq = 0;
const nextSeq = () => String(++seq).padStart(4, '0');

function booking(o: Partial<ReservationRecord> & {
  PropertyID: string; Platform: string; BookingStatus: string; ci: string | null; co: string | null;
}): ReservationRecord {
  return {
    BookingID: o.BookingID ?? `BK-2026-${nextSeq()}`,
    Platform: o.Platform,
    PlatformResID: o.PlatformResID ?? '',
    PropertyID: o.PropertyID,
    BookingStatus: o.BookingStatus,
    GuestName: o.GuestName ?? 'Test Guest',
    Adults: o.Adults ?? 2,
    Children: o.Children ?? 0,
    CheckInDate: o.ci === null ? null : D(o.ci),
    CheckOutDate: o.co === null ? null : D(o.co),
    BaseRate: o.BaseRate ?? 0,
    RoomRevenue: o.RoomRevenue ?? 0,
    CleaningFee: o.CleaningFee ?? 0,
    ExtraGuestFee: o.ExtraGuestFee ?? 0,
    OtherCharges: o.OtherCharges ?? 0,
    Discount: o.Discount ?? 0,
    Taxes: o.Taxes ?? 0,
    PlatformFee: o.PlatformFee ?? 0,
    OtherDeductions: o.OtherDeductions ?? 0,
    ActualPayout: o.ActualPayout ?? 0,
    PayoutDate: o.PayoutDate ?? null,
  };
}

function revenue(o: {
  date: string; type: string; platform: string; property: string; gross: number;
  fee?: number; tax?: number; discount?: number; otherDeduction?: number;
  bookingId?: string; payoutStatus?: string;
}): RevenueRecord {
  return {
    RevenueID: `REV-2026-${nextSeq()}`,
    BookingID: o.bookingId ?? '',
    PropertyID: o.property,
    Date: D(o.date),
    RevenueType: o.type,
    Platform: o.platform,
    GrossAmount: o.gross,
    Discount: o.discount ?? 0,
    Tax: o.tax ?? 0,
    PlatformFee: o.fee ?? 0,
    OtherDeduction: o.otherDeduction ?? 0,
    PayoutStatus: o.payoutStatus ?? 'Received',
  };
}

function expense(o: {
  date: string; property: string; amount: number; tax?: number;
  subcategory?: string; category?: string; type?: string; status?: string;
}): ExpenseRecord {
  return {
    ExpenseID: `EXP-2026-${nextSeq()}`,
    Date: D(o.date),
    PropertyID: o.property,
    ExpenseCategory: o.category ?? 'Variable Operating',
    ExpenseSubcategory: o.subcategory ?? 'Housekeeping',
    Amount: o.amount,
    Tax: o.tax ?? 0,
    PaymentStatus: o.status ?? 'Paid',
    ExpenseType: o.type ?? 'Operating',
  };
}

const capex = (date: string, property: string, unitCost: number, qty = 1): CapexRecord => ({
  CapexID: `CAP-2026-${nextSeq()}`, PropertyID: property, Date: D(date),
  Category: 'Painting', Quantity: qty, UnitCost: unitCost,
});

const cash = (date: string, moneyIn: number, moneyOut: number, type = 'Booking Payout'): CashFlowRecord => ({
  TxnID: `CSH-2026-${nextSeq()}`, Date: D(date), Type: type, PropertyID: 'COMMON',
  MoneyIn: moneyIn, MoneyOut: moneyOut, ReconStatus: 'Reconciled',
});

export const THREE_INVESTORS: InvestorRecord[] = [
  { InvestorID: 'INV-001', InvestorName: 'Investor One', InvestmentAmount: 500000, ParticipationPct: 0.40, Status: 'Active' },
  { InvestorID: 'INV-002', InvestorName: 'Investor Two', InvestmentAmount: 400000, ParticipationPct: 0.35, Status: 'Active' },
  { InvestorID: 'INV-003', InvestorName: 'Investor Three', InvestmentAmount: 300000, ParticipationPct: 0.25, Status: 'Active' },
];

export const ONE_INVESTOR: InvestorRecord[] = [
  { InvestorID: 'INV-001', InvestorName: 'Sole Investor', InvestmentAmount: 1000000, ParticipationPct: 1.0, Status: 'Active' },
];

function empty(): Omit<WorkbookData, 'settings'> {
  return {
    properties: PROPERTIES, reservations: [], revenue: [], expenses: [],
    capex: [], cashflow: [], investors: [], distributions: [],
  };
}

export interface Scenario {
  id: string;
  title: string;
  /** What this scenario is here to prove. */
  covers: string;
  months: string[];
  data: WorkbookData;
}

/* ================================================================== *
 * Scenarios
 * ================================================================== */

/**
 * S1 — BASELINE. Normal trading month with a cancelled booking, a CAPEX row that must
 * stay out of operating profit, a COMMON (shared) expense, and a misfiled CAPEX-typed
 * expense row that must also stay out.
 *
 * Hand-computed for 2026-04 (30 days × 4 active units = 120 available nights):
 *   occupied nights   5 + 3 + 2                     =     10   (cancelled booking excluded)
 *   room revenue      25000 + 12000 + 8000          =  45000
 *   cleaning revenue  1000                          =   1000
 *   gross revenue                                    =  46000
 *   platform fees     3750 + 2160 + 1200            =   7110
 *   net revenue       46000 − 7110                  =  38890
 *   operating expense 2000 + 1500 + 1180            =   4680   (CAPEX-typed row excluded)
 *   operating profit  38890 − 4680                  =  34210
 *   ADR               45000 / 10                    =   4500
 *   RevPAR            45000 / 120                   =    375
 *   reserve (5%)                                     =   1710.5
 *   distributable     34210 − 1710.5                =  32499.5
 *   investor pool 60%                                =  19499.7
 */
export function baseline(): Scenario {
  seq = 0;
  const reservations = [
    booking({ BookingID: 'BK-2026-0001', PropertyID: 'HYD-501', Platform: 'Airbnb', BookingStatus: 'Checked Out',
      ci: '2026-04-05', co: '2026-04-10', RoomRevenue: 25000, CleaningFee: 1000, PlatformFee: 3750, ActualPayout: 22250 }),
    booking({ BookingID: 'BK-2026-0002', PropertyID: 'HYD-502', Platform: 'Booking.com', BookingStatus: 'Checked Out',
      ci: '2026-04-10', co: '2026-04-13', RoomRevenue: 12000, PlatformFee: 2160, ActualPayout: 9840 }),
    booking({ BookingID: 'BK-2026-0003', PropertyID: 'HYD-601', Platform: 'Direct', BookingStatus: 'Cancelled',
      ci: '2026-04-15', co: '2026-04-18', RoomRevenue: 9000 }),
    booking({ BookingID: 'BK-2026-0004', PropertyID: 'HYD-602', Platform: 'Airbnb', BookingStatus: 'Checked Out',
      ci: '2026-04-20', co: '2026-04-22', RoomRevenue: 8000, PlatformFee: 1200, ActualPayout: 6800 }),
  ];
  return {
    id: 'S1-baseline',
    title: 'Baseline trading month',
    covers: 'normal bookings, cancelled booking, CAPEX, shared (COMMON) expense, misfiled CAPEX expense',
    months: ['2026-04'],
    data: {
      ...empty(),
      reservations,
      revenue: [
        revenue({ date: '2026-04-10', type: 'Room', platform: 'Airbnb', property: 'HYD-501', gross: 25000, fee: 3750, bookingId: 'BK-2026-0001' }),
        revenue({ date: '2026-04-10', type: 'Cleaning Fee', platform: 'Airbnb', property: 'HYD-501', gross: 1000, bookingId: 'BK-2026-0001' }),
        revenue({ date: '2026-04-13', type: 'Room', platform: 'Booking.com', property: 'HYD-502', gross: 12000, fee: 2160, bookingId: 'BK-2026-0002' }),
        revenue({ date: '2026-04-22', type: 'Room', platform: 'Airbnb', property: 'HYD-602', gross: 8000, fee: 1200, bookingId: 'BK-2026-0004' }),
      ],
      expenses: [
        expense({ date: '2026-04-11', property: 'HYD-501', amount: 2000, subcategory: 'Housekeeping' }),
        expense({ date: '2026-04-01', property: 'COMMON', amount: 1500, subcategory: 'Internet', category: 'Fixed Operating' }),
        expense({ date: '2026-04-14', property: 'HYD-502', amount: 1000, tax: 180, subcategory: 'Electricity' }),
        // Misfiled: CAPEX typed into the expense ledger. V1 flags it (QA-15) and excludes it.
        expense({ date: '2026-04-06', property: 'HYD-501', amount: 20000, subcategory: 'Other', type: 'CAPEX' }),
      ],
      capex: [capex('2026-04-03', 'HYD-501', 45000)],
      cashflow: [cash('2026-04-15', 30000, 0), cash('2026-04-20', 0, 10000, 'Operating Expense')],
      investors: THREE_INVESTORS,
      distributions: [],
      settings: settings(),
    },
  };
}

/**
 * S2 — LOSS MONTH, then RECOVERY. Proves carry-forward consumes only the *unrecovered*
 * loss and never claws back profit that was already distributable.
 *
 *   Apr: net 10000 − opex 30000  → OP −20000 → distributable 0,  balance −20000
 *   May: net 50000 − opex 20000  → OP  30000 → reserve 1500, afterRM 28500,
 *        carry applied 20000     → distributable 8500,           balance 0
 *   Jun: net 20000 − opex  5000  → OP  15000 → reserve 750,  afterRM 14250,
 *        carry applied 0         → distributable 14250,          balance 0
 */
export function lossAndRecovery(): Scenario {
  seq = 0;
  return {
    id: 'S2-loss-carryforward',
    title: 'Loss month, then recovery',
    covers: 'loss month, loss carry-forward and recovery, zero distribution while in deficit',
    months: ['2026-04', '2026-05', '2026-06'],
    data: {
      ...empty(),
      revenue: [
        revenue({ date: '2026-04-10', type: 'Room', platform: 'Direct', property: 'HYD-501', gross: 10000 }),
        revenue({ date: '2026-05-10', type: 'Room', platform: 'Direct', property: 'HYD-501', gross: 50000 }),
        revenue({ date: '2026-06-10', type: 'Room', platform: 'Direct', property: 'HYD-501', gross: 20000 }),
      ],
      expenses: [
        expense({ date: '2026-04-15', property: 'COMMON', amount: 30000, subcategory: 'Repairs' }),
        expense({ date: '2026-05-15', property: 'COMMON', amount: 20000, subcategory: 'Repairs' }),
        expense({ date: '2026-06-15', property: 'COMMON', amount: 5000, subcategory: 'Repairs' }),
      ],
      investors: THREE_INVESTORS,
      settings: settings(),
    },
  };
}

/** S3 — ZERO REVENUE. No revenue at all; ratios must be 0, never NaN or Infinity. */
export function zeroRevenue(): Scenario {
  seq = 0;
  return {
    id: 'S3-zero-revenue',
    title: 'Zero revenue month',
    covers: 'zero revenue, divide-by-zero guards (ADR / RevPAR / occupancy / margin)',
    months: ['2026-04'],
    data: {
      ...empty(),
      expenses: [expense({ date: '2026-04-10', property: 'COMMON', amount: 5000, subcategory: 'Internet' })],
      investors: THREE_INVESTORS,
      settings: settings(),
    },
  };
}

/**
 * S4 — INVESTOR RULES UNSET (TBD). The workbook's central safety property: with the
 * pool % blank the engine must produce ₹0 and say so, never invent a split.
 */
export function rulesUnset(): Scenario {
  const s = baseline();
  return {
    ...s,
    id: 'S4-rules-tbd',
    title: 'Investor rules unset (TBD)',
    covers: 'investor rules unset/TBD — engine must calculate ₹0 and report "not configured"',
    data: {
      ...s.data,
      settings: settings({ investorPoolPct: null, operatorPoolPct: null, reservePct: null, lossTreatment: 'TBD' }),
    },
  };
}

/** S5 — SINGLE INVESTOR at 100% of the pool. */
export function singleInvestor(): Scenario {
  const s = baseline();
  return {
    ...s, id: 'S5-single-investor', title: 'Single investor',
    covers: 'one investor holding 100% of the investor pool',
    data: { ...s.data, investors: ONE_INVESTOR },
  };
}

/**
 * S6 — PARTIAL PAYOUT + OTA reconciliation.
 *   BK-2026-0001: gross value 20000+1000 = 21000, fee entered 3150 → expected 17850,
 *                 actual 10000 → 7850 still receivable.
 *   BK-2026-0002: fee blank → estimated at the Booking.com commission (18% of 15000 = 2700)
 *                 → expected 12300, actual 12300 → settled.
 */
export function partialPayout(): Scenario {
  seq = 0;
  return {
    id: 'S6-partial-payout',
    title: 'Partial payout and fee estimation',
    covers: 'partial payout, pending receivables, entered fee vs commission-estimated fee',
    months: ['2026-04'],
    data: {
      ...empty(),
      reservations: [
        booking({ BookingID: 'BK-2026-0001', PropertyID: 'HYD-501', Platform: 'Airbnb', BookingStatus: 'Checked Out',
          ci: '2026-04-05', co: '2026-04-09', RoomRevenue: 20000, CleaningFee: 1000, PlatformFee: 3150, ActualPayout: 10000 }),
        booking({ BookingID: 'BK-2026-0002', PropertyID: 'HYD-502', Platform: 'Booking.com', BookingStatus: 'Checked Out',
          ci: '2026-04-12', co: '2026-04-15', RoomRevenue: 15000, PlatformFee: 0, ActualPayout: 12300 }),
      ],
      revenue: [
        revenue({ date: '2026-04-09', type: 'Room', platform: 'Airbnb', property: 'HYD-501', gross: 20000, fee: 3150, bookingId: 'BK-2026-0001', payoutStatus: 'Partial' }),
        revenue({ date: '2026-04-15', type: 'Room', platform: 'Booking.com', property: 'HYD-502', gross: 15000, fee: 2700, bookingId: 'BK-2026-0002' }),
      ],
      investors: THREE_INVESTORS,
      settings: settings(),
    },
  };
}

/** S7 — BLOCKED UNIT. Active-unit count drops to 3, so available nights fall with it. */
export function blockedUnit(): Scenario {
  const s = baseline();
  return {
    ...s, id: 'S7-blocked-unit', title: 'Blocked unit excluded from capacity',
    covers: 'Blocked property excluded from active units / available nights',
    data: {
      ...s.data,
      properties: PROPERTIES.map((p) => (p.PropertyID === 'HYD-601' ? { ...p, PropertyStatus: 'Blocked' } : p)),
    },
  };
}

/** S8 — DISTRIBUTIONS PAID: full, partial and unpaid across three investors. */
export function distributionsMixed(): Scenario {
  const s = baseline();
  const distributions: DistributionRecord[] = [
    // PendingAmount is a V1 formula column; it is filled from the engine below rather
    // than hand-authored, so the fixture cannot drift from the waterfall it describes.
    { Period: D('2026-04-01'), InvestorID: 'INV-001', PaidAmount: 7799.88, PaidDate: D('2026-05-05'), PendingAmount: 0 },
    { Period: D('2026-04-01'), InvestorID: 'INV-002', PaidAmount: 3000, PaidDate: D('2026-05-05'), PendingAmount: 0 },
    { Period: D('2026-04-01'), InvestorID: 'INV-003', PaidAmount: 0, PaidDate: null, PendingAmount: 0 },
  ];
  const data = { ...s.data, distributions };
  return {
    ...s, id: 'S8-distributions', title: 'Distributions paid / partial / pending',
    covers: 'multiple investors with differing participation, paid vs partial vs pending',
    data: { ...data, distributions: fillDistributionPending(data) },
  };
}

/** Every scenario, in report order. */
export function allScenarios(): Scenario[] {
  return [
    baseline(), lossAndRecovery(), zeroRevenue(), rulesUnset(),
    singleInvestor(), partialPayout(), blockedUnit(), distributionsMixed(),
  ];
}
