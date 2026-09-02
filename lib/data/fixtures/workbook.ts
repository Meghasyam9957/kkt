/**
 * DEMO WORKBOOK — a realistic 12-month dataset for a 4-unit Hyderabad homestay.
 *
 * This is raw ledger data, not pre-computed KPIs. Every figure the dashboard shows is
 * derived from these rows by the SAME `lib/server/analytics/kpi.ts` engine that will
 * serve live data. Consequences that matter:
 *
 *   - no business number is hard-coded in a component, a fixture or a provider;
 *   - the demo is internally consistent (property revenue sums to portfolio revenue,
 *     occupancy matches the bookings, the P&L ties to the ledgers) because it is
 *     computed, not authored;
 *   - swapping to the Google Sheets adapter changes the data source only.
 *
 * Deterministic: a seeded PRNG, never `Math.random()`, so the demo looks identical on
 * every machine and screenshots stay reproducible.
 *
 * Business rules are deliberately left NULL — management has not approved the commercial
 * terms, so the UI must show CONFIGURATION REQUIRED rather than an invented ₹0.
 */
import { isoToSerial, edate, monthStart, monthKeyOf, serialToIso } from '@/lib/shared/dates';
import type {
  WorkbookData, PropertyRecord, ReservationRecord, RevenueRecord, ExpenseRecord,
  CapexRecord, CashFlowRecord, InvestorRecord, DistributionRecord, BusinessSettings,
  MaintenanceTicket, HousekeepingTask, InventoryItem, GuestRequest, OperationsData,
} from '@/lib/shared/domain';

/** Financial year the demo runs over (Indian FY). */
export const DEMO_FY_START = isoToSerial('2026-04-01');

/** Mulberry32 — small, fast, deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_PROPERTIES: PropertyRecord[] = [
  { PropertyID: 'HYD-501', Unit: '5th Floor — 2 BHK', BHKType: '2 BHK', MaxGuests: 6, PropertyStatus: 'Available', ListingStatus: 'Live' },
  { PropertyID: 'HYD-502', Unit: '5th Floor — 1 BHK', BHKType: '1 BHK', MaxGuests: 3, PropertyStatus: 'Available', ListingStatus: 'Live' },
  { PropertyID: 'HYD-601', Unit: '6th Floor — 2 BHK', BHKType: '2 BHK', MaxGuests: 6, PropertyStatus: 'Available', ListingStatus: 'Live' },
  { PropertyID: 'HYD-602', Unit: '6th Floor — 1 BHK', BHKType: '1 BHK', MaxGuests: 3, PropertyStatus: 'Available', ListingStatus: 'Live' },
];

/** Per-unit commercial character, so the four units are genuinely distinguishable. */
const PROPERTY_PROFILE: Record<string, { nightlyRate: number; demand: number; cleaningFee: number }> = {
  'HYD-501': { nightlyRate: 4200, demand: 0.78, cleaningFee: 700 },
  'HYD-502': { nightlyRate: 2600, demand: 0.71, cleaningFee: 500 },
  'HYD-601': { nightlyRate: 4500, demand: 0.66, cleaningFee: 700 },   // weakest occupancy
  'HYD-602': { nightlyRate: 2800, demand: 0.83, cleaningFee: 500 },   // strongest occupancy
};

const PLATFORMS = [
  { name: 'Airbnb', share: 0.46, commission: 0.15, lag: 3 },
  { name: 'Booking.com', share: 0.31, commission: 0.18, lag: 5 },
  { name: 'Direct', share: 0.23, commission: 0, lag: 0 },
] as const;

/** Hyderabad seasonality: monsoon dip, festive and winter peaks. Index by FY month 0–11. */
const SEASONALITY = [0.94, 0.88, 0.82, 0.80, 0.86, 0.95, 1.14, 1.18, 1.06, 1.02, 0.98, 1.08];

export const DEMO_INVESTORS: InvestorRecord[] = [
  { InvestorID: 'INV-001', InvestorName: 'Anand Rao', InvestmentAmount: 1_200_000, ParticipationPct: 0.40, Status: 'Active' },
  { InvestorID: 'INV-002', InvestorName: 'Meera Krishnan', InvestmentAmount: 1_050_000, ParticipationPct: 0.35, Status: 'Active' },
  { InvestorID: 'INV-003', InvestorName: 'Suresh Reddy', InvestmentAmount: 750_000, ParticipationPct: 0.25, Status: 'Active' },
];

/**
 * Business rules INTENTIONALLY unset.
 * Management has not approved the commercial terms, so the distribution engine stays idle
 * and the UI shows CONFIGURATION REQUIRED. Populating these would fabricate an agreement.
 */
export const DEMO_SETTINGS: BusinessSettings = {
  businessName: 'MAKAM Home Stays',
  city: 'Hyderabad',
  country: 'India',
  currency: '₹',
  fyStart: DEMO_FY_START,
  investorPoolPct: null,
  operatorPoolPct: null,
  reservePct: null,
  mgmtFeePct: null,
  lossTreatment: 'TBD',
  profitDefinition: 'TBD',
  payoutToleranceInr: 100,
  payoutOverdueDays: 7,
  rentDueDays: 3,
  platformCommission: Object.fromEntries(PLATFORMS.map((p) => [p.name, p.commission])),
  platformPayoutLagDays: Object.fromEntries(PLATFORMS.map((p) => [p.name, p.lag])),
};

const GUEST_FIRST = ['Aarav', 'Diya', 'Rohan', 'Ishita', 'Kabir', 'Nisha', 'Arjun', 'Sara',
  'Vikram', 'Ananya', 'Rahul', 'Priya', 'Karthik', 'Divya', 'Manoj', 'Sneha'];
const GUEST_LAST = ['Sharma', 'Nair', 'Iyer', 'Gupta', 'Menon', 'Reddy', 'Patel', 'Kulkarni'];

const EXPENSE_PLAN: Array<{ sub: string; category: string; base: number; perProperty: boolean; variance: number }> = [
  { sub: 'Rent', category: 'Fixed Operating', base: 22_000, perProperty: true, variance: 0 },
  { sub: 'Housekeeping', category: 'Variable Operating', base: 5_800, perProperty: true, variance: 0.18 },
  { sub: 'Electricity', category: 'Variable Operating', base: 3_100, perProperty: true, variance: 0.25 },
  { sub: 'Water', category: 'Variable Operating', base: 900, perProperty: true, variance: 0.2 },
  { sub: 'Laundry', category: 'Variable Operating', base: 2_400, perProperty: true, variance: 0.22 },
  { sub: 'Consumables', category: 'Variable Operating', base: 1_600, perProperty: true, variance: 0.2 },
  { sub: 'Internet', category: 'Fixed Operating', base: 1_500, perProperty: false, variance: 0 },
  { sub: 'Society Maintenance', category: 'Fixed Operating', base: 4_800, perProperty: false, variance: 0 },
  { sub: 'Software', category: 'Fixed Operating', base: 999, perProperty: false, variance: 0 },
  { sub: 'Accounting', category: 'Fixed Operating', base: 2_500, perProperty: false, variance: 0 },
  { sub: 'Advertising', category: 'Marketing', base: 4_200, perProperty: false, variance: 0.3 },
  { sub: 'Repairs', category: 'Variable Operating', base: 2_800, perProperty: false, variance: 0.6 },
  { sub: 'Pest Control', category: 'Variable Operating', base: 1_800, perProperty: false, variance: 0.1 },
  { sub: 'Payment Gateway Fee', category: 'OTA / Payment', base: 620, perProperty: false, variance: 0.25 },
];

const CAPEX_PLAN: Array<{ monthIndex: number; property: string; category: string; cost: number }> = [
  { monthIndex: 0, property: 'HYD-501', category: 'Painting', cost: 48_000 },
  { monthIndex: 0, property: 'HYD-501', category: 'Furniture', cost: 132_000 },
  { monthIndex: 0, property: 'HYD-502', category: 'Painting', cost: 34_000 },
  { monthIndex: 1, property: 'HYD-502', category: 'Mattress / Bed', cost: 38_000 },
  { monthIndex: 1, property: 'HYD-601', category: 'Furniture', cost: 126_000 },
  { monthIndex: 2, property: 'HYD-601', category: 'AC', cost: 42_000 },
  { monthIndex: 2, property: 'HYD-602', category: 'Kitchen', cost: 26_000 },
  { monthIndex: 3, property: 'COMMON', category: 'Security / Smart Lock', cost: 36_000 },
  { monthIndex: 5, property: 'HYD-602', category: 'TV', cost: 29_000 },
  { monthIndex: 7, property: 'COMMON', category: 'Linen', cost: 22_000 },
];

export interface DemoWorkbookOptions {
  /**
   * Per-FY-month activity multiplier, indexed 0-11. `0` produces a genuinely empty month;
   * a low value produces a quiet one. Used to build a year that contains ramp-up, trading
   * and dormant periods rather than twelve identical months — the empty and
   * INSUFFICIENT DATA states have to be reachable from real data, not faked.
   */
  activityByMonth?: number[];
  /** Business rules. Left NULL by default; the demo supplies illustrative values. */
  settings?: BusinessSettings;
  /**
   * The day the whole dataset is "as of", as a spreadsheet serial.
   *
   * When supplied, booking status is derived from it globally: a stay that finished is
   * Checked Out, one spanning the day is Checked In, one still ahead is Confirmed. Without
   * it each month falls back to its own internal midpoint, which leaves Confirmed bookings
   * scattered through months that finished long ago.
   */
  asOf?: number;
}

/**
 * Build the demo workbook.
 *
 * @param monthsOfHistory how many FY months carry data (default 10 — the remaining
 *        months are genuinely empty, which exercises the empty and INSUFFICIENT DATA
 *        states instead of pretending a full year exists).
 */
export function buildDemoWorkbook(
  monthsOfHistory = 10,
  options: DemoWorkbookOptions = {},
): WorkbookData {
  const rand = prng(20260401);
  const reservations: ReservationRecord[] = [];
  const revenue: RevenueRecord[] = [];
  const expenses: ExpenseRecord[] = [];
  const capex: CapexRecord[] = [];
  const cashflow: CashFlowRecord[] = [];
  const distributions: DistributionRecord[] = [];

  const activity = (index: number) => options.activityByMonth?.[index] ?? 1;
  let lastActiveMonth = monthsOfHistory - 1;
  while (lastActiveMonth > 0 && activity(lastActiveMonth) === 0) lastActiveMonth--;

  let bookingSeq = 0, revenueSeq = 0, expenseSeq = 0, capexSeq = 0, cashSeq = 0;
  const id = (prefix: string, year: number, n: number) => `${prefix}-${year}-${String(n).padStart(4, '0')}`;

  for (let m = 0; m < monthsOfHistory; m++) {
    const ms = edate(monthStart(DEMO_FY_START), m);
    const me = edate(ms, 1);
    const days = me - ms;
    const year = Number(monthKeyOf(ms).slice(0, 4));
    const monthActivity = activity(m);
    const season = (SEASONALITY[m] ?? 1) * monthActivity;

    for (const property of DEMO_PROPERTIES) {
      const profile = PROPERTY_PROFILE[property.PropertyID]!;
      const targetNights = Math.min(days - 1, Math.round(days * profile.demand * season));

      let cursor = ms + Math.floor(rand() * 3);
      let nightsBooked = 0;

      while (nightsBooked < targetNights && cursor < me - 1) {
        const stay = Math.min(1 + Math.floor(rand() * 5), targetNights - nightsBooked, me - cursor - 1);
        if (stay < 1) break;

        // Platform mix by cumulative share.
        const roll = rand();
        let acc = 0;
        const platform = PLATFORMS.find((p) => (acc += p.share) >= roll) ?? PLATFORMS[2];

        const rateJitter = 0.9 + rand() * 0.28;
        const nightlyRate = Math.round((profile.nightlyRate * season * rateJitter) / 50) * 50;
        const roomRevenue = nightlyRate * stay;
        const cleaningFee = profile.cleaningFee;
        const extraGuestFee = rand() > 0.82 ? 600 : 0;
        const discount = rand() > 0.88 ? Math.round(roomRevenue * 0.08 / 50) * 50 : 0;
        const grossValue = roomRevenue + cleaningFee + extraGuestFee - discount;
        const platformFee = Math.round(grossValue * platform.commission);

        const checkIn = cursor;
        const checkOut = cursor + stay;
        // One "now" for the whole dataset when the caller supplies it; otherwise a
        // per-month midpoint, which is what the Phase 4 fixtures were built against.
        const today = options.asOf ?? ms + Math.floor(days * 0.62);

        // ~6% of bookings fall over, which the cancellation-rate KPI needs to be real.
        const cancelled = rand() > 0.94;
        const status = cancelled
          ? (rand() > 0.5 ? 'Cancelled' : 'No Show')
          : checkOut <= today ? 'Checked Out'
            : checkIn <= today ? 'Checked In' : 'Confirmed';

        const settled = status === 'Checked Out' && rand() > 0.12;
        const bookingId = id('BK', year, ++bookingSeq);

        reservations.push({
          BookingID: bookingId,
          Platform: platform.name,
          PlatformResID: platform.name === 'Direct' ? '' : `${platform.name.slice(0, 2).toUpperCase()}${100000 + bookingSeq}`,
          PropertyID: property.PropertyID,
          // Not modelled — see ReservationRecord.BookingDate. The seeded year
          // therefore cannot support a faithful historical re-estimate, and the
          // forecast screen says so rather than implying one.
          BookingDate: null,
          BookingStatus: status,
          GuestName: `${GUEST_FIRST[Math.floor(rand() * GUEST_FIRST.length)]} ${GUEST_LAST[Math.floor(rand() * GUEST_LAST.length)]}`,
          Adults: 1 + Math.floor(rand() * Math.min(4, property.MaxGuests)),
          Children: rand() > 0.75 ? 1 : 0,
          CheckInDate: checkIn,
          CheckOutDate: checkOut,
          BaseRate: nightlyRate,
          RoomRevenue: roomRevenue,
          CleaningFee: cleaningFee,
          ExtraGuestFee: extraGuestFee,
          OtherCharges: 0,
          Discount: discount,
          Taxes: 0,
          PlatformFee: platformFee,
          OtherDeductions: 0,
          ActualPayout: settled ? grossValue - platformFee : 0,
          PayoutDate: settled ? checkOut + platform.lag : null,
        });

        // Revenue is recognised for stays that actually happened.
        if (!cancelled && status !== 'Confirmed') {
          const recognisedOn = Math.min(checkOut, me - 1);
          revenue.push({
            RevenueID: id('REV', year, ++revenueSeq), BookingID: bookingId,
            PropertyID: property.PropertyID, Date: recognisedOn, RevenueType: 'Room',
            Platform: platform.name, GrossAmount: roomRevenue, Discount: discount, Tax: 0,
            PlatformFee: platformFee, OtherDeduction: 0,
            PayoutStatus: settled ? 'Received' : 'Pending',
          });
          revenue.push({
            RevenueID: id('REV', year, ++revenueSeq), BookingID: bookingId,
            PropertyID: property.PropertyID, Date: recognisedOn, RevenueType: 'Cleaning Fee',
            Platform: platform.name, GrossAmount: cleaningFee, Discount: 0, Tax: 0,
            PlatformFee: 0, OtherDeduction: 0,
            PayoutStatus: settled ? 'Received' : 'Pending',
          });
          if (extraGuestFee > 0) {
            revenue.push({
              RevenueID: id('REV', year, ++revenueSeq), BookingID: bookingId,
              PropertyID: property.PropertyID, Date: recognisedOn, RevenueType: 'Extra Guest Fee',
              Platform: platform.name, GrossAmount: extraGuestFee, Discount: 0, Tax: 0,
              PlatformFee: 0, OtherDeduction: 0,
              PayoutStatus: settled ? 'Received' : 'Pending',
            });
          }
          if (settled) {
            cashflow.push({
              TxnID: id('CSH', year, ++cashSeq), Date: checkOut + platform.lag,
              Type: platform.name === 'Direct' ? 'Direct Booking Receipt' : 'Booking Payout',
              PropertyID: property.PropertyID, MoneyIn: grossValue - platformFee, MoneyOut: 0,
              ReconStatus: 'Reconciled',
            });
          }
        }

        nightsBooked += stay;
        cursor = checkOut + (rand() > 0.55 ? 1 : 0);
      }
    }

    // ---- Expenses -------------------------------------------------------
    // A dormant month books nothing and spends nothing. Leaving the fixed costs running
    // would make an "empty" month show a loss, which is a different story from "we were
    // not trading yet".
    for (const plan of monthActivity === 0 ? [] : EXPENSE_PLAN) {
      const targets = plan.perProperty ? DEMO_PROPERTIES.map((p) => p.PropertyID) : ['COMMON'];
      for (const target of targets) {
        const jitter = 1 + (rand() - 0.5) * 2 * plan.variance;
        const amount = Math.round((plan.base * jitter) / 10) * 10;
        if (amount <= 0) continue;
        const dueOn = ms + 2 + Math.floor(rand() * (days - 4));
        // A ledger does not contain next month's bills. Without this, a month the business
        // has not reached yet shows costs and no revenue, which reads as a loss it never made.
        if (options.asOf !== undefined && dueOn > options.asOf) continue;
        // The most recent month that actually traded — not simply the last index, which
        // may be a dormant month with no bills to leave outstanding.
        const isCurrentMonth = m === lastActiveMonth;
        expenses.push({
          ExpenseID: id('EXP', year, ++expenseSeq),
          Date: dueOn,
          PropertyID: target,
          ExpenseCategory: plan.category,
          ExpenseSubcategory: plan.sub,
          Amount: amount,
          Tax: plan.category === 'Marketing' || plan.sub === 'Software' ? Math.round(amount * 0.18) : 0,
          // The latest month has some bills still outstanding — that is what makes
          // "pending payables" a real number rather than always zero.
          PaymentStatus: isCurrentMonth && rand() > 0.7 ? 'Pending' : 'Paid',
          ExpenseType: 'Operating',
        });
      }
    }

    // ---- Rent and utility cash out --------------------------------------
    if (monthActivity === 0) continue;
    if (options.asOf !== undefined && ms + 4 > options.asOf) continue;
    cashflow.push({
      TxnID: id('CSH', year, ++cashSeq), Date: ms + 4, Type: 'Rent / Fixed Cost',
      PropertyID: 'COMMON', MoneyIn: 0, MoneyOut: 88_000, ReconStatus: 'Reconciled',
    });
    if (options.asOf !== undefined && ms + 18 > options.asOf) continue;
    cashflow.push({
      TxnID: id('CSH', year, ++cashSeq), Date: ms + 18, Type: 'Operating Expense',
      PropertyID: 'COMMON', MoneyIn: 0, MoneyOut: 26_000 + Math.round(rand() * 9000),
      ReconStatus: m === lastActiveMonth ? 'Unreconciled' : 'Reconciled',
    });
  }

  // ---- CAPEX + the capital that funded it -------------------------------
  for (const item of CAPEX_PLAN) {
    if (item.monthIndex >= monthsOfHistory) continue;
    const ms = edate(monthStart(DEMO_FY_START), item.monthIndex);
    const year = Number(monthKeyOf(ms).slice(0, 4));
    capex.push({
      CapexID: id('CAP', year, ++capexSeq), PropertyID: item.property, Date: ms + 5,
      Category: item.category, Quantity: 1, UnitCost: item.cost,
    });
    cashflow.push({
      TxnID: id('CSH', year, ++cashSeq), Date: ms + 6, Type: 'CAPEX',
      PropertyID: item.property, MoneyIn: 0, MoneyOut: item.cost, ReconStatus: 'Reconciled',
    });
  }

  const fyYear = Number(monthKeyOf(DEMO_FY_START).slice(0, 4));
  for (const investor of DEMO_INVESTORS) {
    cashflow.push({
      TxnID: id('CSH', fyYear, ++cashSeq), Date: DEMO_FY_START, Type: 'Investor Capital In',
      PropertyID: 'COMMON', MoneyIn: investor.InvestmentAmount, MoneyOut: 0, ReconStatus: 'Reconciled',
    });
  }

  // No distribution rows: with the business rules unset there is nothing to distribute,
  // and inventing payments would imply an agreement that does not exist.

  return {
    properties: DEMO_PROPERTIES,
    reservations, revenue, expenses, capex, cashflow,
    investors: DEMO_INVESTORS,
    distributions,
    settings: options.settings ?? DEMO_SETTINGS,
  };
}

/** Operational snapshot for the TODAY panel — derived, never authored. */
export const DEMO_TODAY_ISO = serialToIso(edate(monthStart(DEMO_FY_START), 9) + 18);

/* ------------------------------------------------------------------ *
 * OPERATIONAL FIXTURES (V1 sheets 13/14/15 + guest requests)
 *
 * These exist so the TODAY panel and the unit status board are DERIVED from records
 * rather than carrying hard-coded counters in the provider. The Sheets provider will
 * read the same shapes from 13_HOUSEKEEPING / 14_MAINTENANCE / 15_INVENTORY.
 * ------------------------------------------------------------------ */

/**
 * The operational shapes are the SHARED domain types — not fixture-specific ones. That is
 * deliberate: if the demo could describe a maintenance ticket in a way the live reader
 * cannot, the two sources would drift and the provider swap would stop being a no-op.
 * The `Demo*` names are kept as aliases so existing imports keep working.
 */
export type DemoMaintenanceTicket = MaintenanceTicket;
export type DemoHousekeepingTask = HousekeepingTask;
export type DemoInventoryItem = InventoryItem;
export type DemoGuestRequest = GuestRequest;
export type DemoOpsData = OperationsData;

export function buildDemoOps(today = DEMO_TODAY_ISO): DemoOpsData {
  const shift = (days: number) => serialToIso(isoToSerial(today) + days);
  return {
    today,
    maintenance: [
      { ticketId: 'MNT-2027-0011', propertyId: 'HYD-601', category: 'AC / Appliance', priority: 'High',
        status: 'In Progress', assignedTo: '', description: 'Bedroom AC not cooling', reportedOn: shift(-2) },
      { ticketId: 'MNT-2027-0012', propertyId: 'HYD-502', category: 'Plumbing', priority: 'Medium',
        status: 'Open', assignedTo: '', description: 'Slow drain in bathroom', reportedOn: shift(-1) },
      { ticketId: 'MNT-2027-0013', propertyId: 'HYD-501', category: 'Furniture', priority: 'Low',
        status: 'Assigned', assignedTo: '', description: 'Loose dining chair', reportedOn: shift(-4) },
      { ticketId: 'MNT-2027-0009', propertyId: 'HYD-602', category: 'Electrical', priority: 'Medium',
        status: 'Resolved', assignedTo: '', description: 'Balcony light replaced', reportedOn: shift(-9) },
    ],
    /* `bookingId` is empty on every one of these, deliberately — see the note in
       lib/data/demo/dataset.ts and docs/UI8_TURNOVER_DECISIONS.md. */
    housekeeping: [
      { taskId: 'HK-2027-0044', propertyId: 'HYD-502', checkoutDate: today, status: 'Pending',
        inspectionStatus: 'Pending', cleaner: '', bookingId: '' },
      { taskId: 'HK-2027-0043', propertyId: 'HYD-602', checkoutDate: shift(-1), status: 'Completed',
        inspectionStatus: 'Passed', cleaner: 'Lakshmi', bookingId: '' },
      { taskId: 'HK-2027-0042', propertyId: 'HYD-501', checkoutDate: shift(-2), status: 'Completed',
        inspectionStatus: 'Passed', cleaner: 'Sunita', bookingId: '' },
    ],
    inventory: [
      { itemId: 'ITM-002', propertyId: 'COMMON', item: 'Bath towels', unit: 'pcs', currentStock: 4, minStock: 12 },
      { itemId: 'ITM-005', propertyId: 'COMMON', item: 'Shampoo sachets', unit: 'pcs', currentStock: 18, minStock: 30 },
      { itemId: 'ITM-001', propertyId: 'COMMON', item: 'Toilet rolls', unit: 'rolls', currentStock: 46, minStock: 24 },
      { itemId: 'ITM-004', propertyId: 'COMMON', item: 'Detergent', unit: 'kg', currentStock: 9, minStock: 5 },
    ],
    guestRequests: [
      { requestId: 'GR-2027-0007', propertyId: 'HYD-501', summary: 'Late checkout requested (2 PM)',
        raisedOn: today, status: 'Open' },
    ],
    // The demo can supply every counter. A live read cannot (see the Sheets provider).
    unavailableCounters: [],
  };
}
