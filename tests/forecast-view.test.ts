/**
 * FORECAST INPUT SELECTION — the business rules that decide what reaches the §9 engine.
 *
 * The engine's arithmetic is covered in `forecast.test.ts`. What is covered here is the
 * layer above it: which rows the view hands over, and which it does not. Those decisions
 * carry the business rules — an ended lease, a blocked unit, a payout that lands next
 * month rather than this one — and until now they were only exercised through the
 * demonstration dataset, which happens not to contain any of the awkward cases.
 *
 * Every workbook here is hand-built so each expected figure can be checked by hand.
 */
import { describe, it, expect } from 'vitest';
import { WorkbookViews } from '@/lib/data/views/workbook-views';
import { buildDemoOps } from '@/lib/data/fixtures/workbook';
import { settings, PROPERTIES } from './fixtures/scenarios';
import { isoToSerial } from '@/lib/shared/dates';
import type {
  WorkbookData, ReservationRecord, ExpenseRecord, CashFlowRecord, RentRecord, PropertyRecord,
} from '@/lib/shared/domain';

const D = isoToSerial;

/** Mid-January 2027, so October–December 2026 are complete history and February is next. */
const TODAY = '2027-01-15';
const FORECAST_MONTH = '2027-02';
const WINDOW = ['2026-10', '2026-11', '2026-12'];

function expense(over: Partial<ExpenseRecord> & { Date: number; Amount: number }): ExpenseRecord {
  return {
    ExpenseID: `EXP-${over.Date}-${over.Amount}`,
    PropertyID: 'HYD-501',
    ExpenseCategory: 'Variable Operating',
    ExpenseSubcategory: 'Housekeeping',
    Tax: 0,
    PaymentStatus: 'Paid',
    ExpenseType: 'Operating',
    ...over,
  };
}

function booking(over: Partial<ReservationRecord>): ReservationRecord {
  return {
    BookingID: 'BK-TEST', Platform: 'Direct', PlatformResID: '', PropertyID: 'HYD-501',
    BookingStatus: 'Confirmed', GuestName: 'Test Guest', Adults: 2, Children: 0,
    CheckInDate: null, CheckOutDate: null,
    BaseRate: 0, RoomRevenue: 0, CleaningFee: 0, ExtraGuestFee: 0, OtherCharges: 0,
    Discount: 0, Taxes: 0, PlatformFee: 0, OtherDeductions: 0,
    ActualPayout: 0, PayoutDate: null,
    ...over,
  };
}

function cash(date: string, moneyIn: number, moneyOut: number): CashFlowRecord {
  return {
    TxnID: `CSH-${date}`, Date: D(date), Type: 'Operating', PropertyID: 'COMMON',
    MoneyIn: moneyIn, MoneyOut: moneyOut, ReconStatus: 'Matched',
  };
}

function rent(over: Partial<RentRecord> & { recordId: string; monthlyAmount: number }): RentRecord {
  return {
    propertyId: 'HYD-501', costType: 'Rent', landlordVendor: 'Landlord',
    dueDay: 5, agreementStart: '2026-01-01', agreementEnd: '2027-12-31',
    escalationPct: 0, lastPaidDate: null, paidForMonth: null,
    nextDueDate: null, paymentStatus: '', notes: '',
    ...over,
  };
}

/**
 * Three complete trading months, so every horizon clears §9's minimum and the cases below
 * are about selection rather than sufficiency.
 */
function workbookWith(over: Partial<WorkbookData> = {}, properties = PROPERTIES): WorkbookData {
  const traded = WINDOW.flatMap((month) => [
    expense({ Date: D(`${month}-10`), Amount: 10_000 }),
  ]);
  return {
    properties,
    reservations: [],
    revenue: [],
    expenses: traded,
    capex: [],
    cashflow: [],
    investors: [],
    distributions: [],
    settings: settings(),
    ...over,
  };
}

const forecastOf = (workbook: WorkbookData, rentRows: RentRecord[] = []) =>
  new WorkbookViews({ workbook, ops: buildDemoOps(TODAY), rent: rentRows }).forecast();

const cashTerms = (workbook: WorkbookData, rentRows: RentRecord[] = []) =>
  forecastOf(workbook, rentRows).cashflow.inputs.cash!;

/* ------------------------------------------------------------------ *
 * Scheduled rent and fixed costs — the obligation window
 * ------------------------------------------------------------------ */

describe('forecast inputs · scheduled fixed costs', () => {
  it('counts only agreements live in the month being forecast', () => {
    const terms = cashTerms(workbookWith(), [
      // Live across February 2027.
      rent({ recordId: 'RNT-1', monthlyAmount: 20_000 }),
      // Ended in December — the obligation is over and must not be charged.
      rent({ recordId: 'RNT-2', monthlyAmount: 999_000, agreementEnd: '2026-12-31' }),
      // Does not begin until June — not an obligation in February.
      rent({ recordId: 'RNT-3', monthlyAmount: 999_000, agreementStart: '2027-06-01' }),
      // Open-ended: no end date recorded, so it is still running.
      rent({ recordId: 'RNT-4', monthlyAmount: 5_000, agreementEnd: '' }),
    ]);

    expect(terms.scheduledFixedCosts).toBe(25_000);
  });

  it('counts an agreement ending inside the month, because that month is still owed', () => {
    const terms = cashTerms(workbookWith(), [
      rent({ recordId: 'RNT-1', monthlyAmount: 20_000, agreementEnd: `${FORECAST_MONTH}-15` }),
    ]);
    expect(terms.scheduledFixedCosts).toBe(20_000);
  });

  it('is zero when no obligation register is supplied, rather than guessing one', () => {
    expect(cashTerms(workbookWith()).scheduledFixedCosts).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Variable costs — the line the contract itself draws
 * ------------------------------------------------------------------ */

describe('forecast inputs · variable operating costs', () => {
  it('excludes Fixed Operating rows, so scheduled costs are never charged twice', () => {
    const expenses = WINDOW.flatMap((month) => [
      expense({ Date: D(`${month}-10`), Amount: 10_000 }),
      // Rent also reaches the P&L through 06_EXPENSES. If it were averaged in here it
      // would be subtracted a second time, on top of the obligation register.
      expense({ Date: D(`${month}-05`), Amount: 50_000, ExpenseCategory: 'Fixed Operating' }),
    ]);
    const terms = cashTerms(workbookWith({ expenses }), [rent({ recordId: 'RNT-1', monthlyAmount: 50_000 })]);

    expect(terms.trailingVariableCosts).toBe(10_000);
    expect(terms.scheduledFixedCosts).toBe(50_000);
  });

  it('excludes rows that are not Operating — a misfiled CAPEX row is not a running cost', () => {
    const expenses = WINDOW.map((month) =>
      expense({ Date: D(`${month}-10`), Amount: 10_000 }));
    expenses.push(expense({ Date: D('2026-11-20'), Amount: 900_000, ExpenseType: 'CAPEX' }));

    expect(cashTerms(workbookWith({ expenses })).trailingVariableCosts).toBe(10_000);
  });

  it('counts the tax on a cost, because that is what actually leaves the account', () => {
    const expenses = WINDOW.map((month) =>
      expense({ Date: D(`${month}-10`), Amount: 10_000, Tax: 1_800 }));
    expect(cashTerms(workbookWith({ expenses })).trailingVariableCosts).toBe(11_800);
  });

  it('averages the window months only, ignoring older spend', () => {
    const expenses = [
      expense({ Date: D('2026-05-10'), Amount: 900_000 }),
      ...WINDOW.map((month) => expense({ Date: D(`${month}-10`), Amount: 10_000 })),
    ];
    expect(cashTerms(workbookWith({ expenses })).trailingVariableCosts).toBe(10_000);
  });
});

/* ------------------------------------------------------------------ *
 * Opening balance
 * ------------------------------------------------------------------ */

describe('forecast inputs · opening balance', () => {
  it('is the cumulative ledger strictly before the month, not a restart at zero', () => {
    const terms = cashTerms(workbookWith({
      cashflow: [
        cash('2026-05-01', 100_000, 0),
        cash('2027-01-31', 0, 30_000),
        // Inside the forecast month: this is what the month is being forecast about, so
        // counting it as opening would be counting it twice.
        cash(`${FORECAST_MONTH}-15`, 500_000, 0),
      ],
    }));

    expect(terms.openingBalance).toBe(70_000);
  });

  it('can be negative, because an overdrawn account is a fact and not an error', () => {
    const terms = cashTerms(workbookWith({ cashflow: [cash('2026-05-01', 0, 40_000)] }));
    expect(terms.openingBalance).toBe(-40_000);
  });
});

/* ------------------------------------------------------------------ *
 * Expected payouts — §9's per-platform lag
 * ------------------------------------------------------------------ */

describe('forecast inputs · expected payouts', () => {
  // settings(): Airbnb lag 3 days, Booking.com 5, Direct 0.
  it('lands a payout by check-out plus that platform’s own lag', () => {
    const terms = cashTerms(workbookWith({
      reservations: [
        // Airbnb, out 30 Jan + 3 days = 2 Feb → inside the forecast month.
        booking({
          BookingID: 'BK-A', Platform: 'Airbnb', PlatformFee: 1_000,
          CheckInDate: D('2027-01-28'), CheckOutDate: D('2027-01-30'), RoomRevenue: 11_000,
        }),
        // Direct, out 30 Jan + 0 days = 30 Jan → lands BEFORE the month, so not counted.
        booking({
          BookingID: 'BK-D', Platform: 'Direct',
          CheckInDate: D('2027-01-28'), CheckOutDate: D('2027-01-30'), RoomRevenue: 500_000,
        }),
      ],
    }));

    // Only the Airbnb booking: 11,000 gross less its 1,000 fee.
    expect(terms.expectedPayouts).toBe(10_000);
  });

  it('excludes a cancelled booking — it will not be paid', () => {
    const terms = cashTerms(workbookWith({
      reservations: [
        booking({
          BookingID: 'BK-X', Platform: 'Airbnb', BookingStatus: 'Cancelled',
          CheckInDate: D(`${FORECAST_MONTH}-05`), CheckOutDate: D(`${FORECAST_MONTH}-08`),
          RoomRevenue: 90_000,
        }),
      ],
    }));

    expect(terms.expectedPayouts).toBe(0);
  });

  it('prefers a recorded payout over the estimate, and its recorded date over the lag', () => {
    const terms = cashTerms(workbookWith({
      reservations: [
        booking({
          BookingID: 'BK-R', Platform: 'Airbnb', PlatformFee: 1_000, RoomRevenue: 11_000,
          CheckInDate: D('2026-12-20'), CheckOutDate: D('2026-12-23'),
          // Checked out in December, but the OTA is paying late — in February.
          ActualPayout: 9_400, PayoutDate: D(`${FORECAST_MONTH}-09`),
        }),
      ],
    }));

    expect(terms.expectedPayouts).toBe(9_400);
  });

  it('ignores a booking with no check-out date rather than assuming one', () => {
    const terms = cashTerms(workbookWith({
      reservations: [booking({ BookingID: 'BK-N', Platform: 'Airbnb', RoomRevenue: 50_000 })],
    }));
    expect(terms.expectedPayouts).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Blocked units
 * ------------------------------------------------------------------ */

describe('forecast inputs · blocked units', () => {
  const blocked: PropertyRecord[] = PROPERTIES.map((p, i) =>
    (i === 0 ? { ...p, PropertyStatus: 'Blocked' } : p));

  it('lends no rate to the property-level blend, because it is not on sale', () => {
    const revenue = WINDOW.flatMap((month) => PROPERTIES.map((p) => ({
      RevenueID: `REV-${month}-${p.PropertyID}`, BookingID: '', PropertyID: p.PropertyID,
      Date: D(`${month}-10`), RevenueType: 'Room', Platform: 'Direct',
      GrossAmount: 30_000, Discount: 0, Tax: 0, PlatformFee: 0, OtherDeduction: 0,
      PayoutStatus: 'Received',
    })));
    const reservations = WINDOW.flatMap((month) => PROPERTIES.map((p) => booking({
      BookingID: `BK-${month}-${p.PropertyID}`, PropertyID: p.PropertyID,
      BookingStatus: 'Checked Out',
      CheckInDate: D(`${month}-10`), CheckOutDate: D(`${month}-15`),
      RoomRevenue: 30_000,
    })));

    const withBlocked = forecastOf(workbookWith({ revenue, reservations }, blocked));
    const rates = withBlocked.revenue.inputs.propertyRates.map((r) => r.propertyId);

    expect(rates).not.toContain(PROPERTIES[0]!.PropertyID);
    expect(rates.length).toBe(PROPERTIES.length - 1);
  });

  it('still produces a forecast, and one that stays inside the reduced capacity', () => {
    const view = forecastOf(workbookWith({}, blocked));
    // Three units on sale rather than four, and February has 28 days.
    expect(view.occupancy.inputs.availableNights).toBe(28 * (PROPERTIES.length - 1));
    if (view.occupancy.value !== null) {
      expect(view.occupancy.value).toBeLessThanOrEqual(view.occupancy.inputs.availableNights);
    }
  });
});
