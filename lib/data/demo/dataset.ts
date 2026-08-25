/**
 * SRIVILLU DEMO / UAT DATASET.
 *
 * A complete fictional operation for the four Hyderabad units, built so the platform can
 * be demonstrated to the client and the Operations Manager without a single real guest,
 * investor or rupee being involved.
 *
 * Two rules shape everything here.
 *
 * **Nothing on a dashboard is authored.** This module produces raw transactional records
 * only — bookings, revenue lines, expense lines, cash movements, tickets, stock counts.
 * Every KPI, chart and total the client sees is computed from these rows by the same
 * `lib/server/analytics/kpi.ts` that will serve production. If a demo figure looks wrong,
 * the ledger is wrong; the demo cannot flatter itself.
 *
 * **The year is not twelve identical months.** It contains a ramp-up, a dormant period, a
 * quiet month, an expense spike and a peak season, because the empty state, the
 * INSUFFICIENT DATA state and the "something needs attention" state all have to be
 * reachable from real data in front of a client.
 *
 * Every record is fictional. Guest names are drawn from a fixed pool, investors are
 * invented, and nothing here is derived from, or may be replaced by, production data.
 */
import { isoToSerial, serialToIso, edate, monthStart, monthKeyOf } from '@/lib/shared/dates';
import {
  buildDemoWorkbook, DEMO_PROPERTIES, DEMO_FY_START, DEMO_SETTINGS,
} from '@/lib/data/fixtures/workbook';
import type {
  WorkbookData, OperationsData, BusinessSettings, ReservationRecord, ExpenseRecord,
  DistributionRecord, InvestorRecord, MaintenanceTicket, HousekeepingTask, InventoryItem,
  GuestRequest, AssetRecord, ComplianceRecord, RentRecord, GuestSession,
} from '@/lib/shared/domain';
import {
  DEFAULT_DEMO_SCENARIO, type DemoScenario,
} from '@/lib/shared/environment';
import { fillDistributionPending } from '@/lib/server/analytics/kpi';
import { computeRentSchedule } from '@/lib/server/analytics/rent';

/** Stamped on the dataset and asserted by tests. Nothing production-shaped carries it. */
export const DEMO_MARKER = 'SRIVILLU-DEMO';

/** Appended to every free-text field the V1 contract provides, so a row is identifiable. */
export const DEMO_NOTE = '[DEMO] Fictional demonstration record.';

/**
 * Illustrative commercial rules — **demonstration values only**.
 *
 * Management has NOT approved these terms. They exist so the distribution waterfall can be
 * shown working end to end; the settings screen labels them as demonstration values, and
 * the production settings remain NULL and continue to render CONFIGURATION REQUIRED.
 * A test asserts these numbers can never reach a production code path.
 */
export const DEMO_SAMPLE_BUSINESS_RULES: BusinessSettings = {
  ...DEMO_SETTINGS,
  investorPoolPct: 0.60,
  operatorPoolPct: 0.40,
  reservePct: 0.05,
  mgmtFeePct: 0,
  lossTreatment: 'Carry forward',
  profitDefinition: 'Operating Profit after Reserve',
};

/**
 * The demo trading year.
 *
 * 0  Apr — ramp-up, fitting out, few guests. Loses money, as a ramp-up does.
 * 1-3      normal trading
 * 4  Aug — DORMANT: units off-market for the monsoon refit. Genuinely empty.
 * 5  Sep — quiet re-opening: too little data to forecast from
 * 6-7      festive peak
 * 8-9      winter trading; month 9 carries the expense spike
 * 10 Feb — the current month, traded up to the presentation day
 * 11 Mar — not yet reached. No data at all.
 */
export const DEMO_ACTIVITY_BY_MONTH = [0.28, 1, 1, 1, 0, 0.34, 1.05, 1.12, 1, 1, 1, 0];

/** Months a viewer should expect to be empty or thin, named so the demo script can say so. */
export const DEMO_QUIET_MONTHS = {
  rampUp: 0,
  dormant: 4,
  insufficientForForecast: 5,
  notYetTraded: 11,
} as const;

export const DEMO_INVESTOR_A = 'INV-001';
export const DEMO_INVESTOR_B = 'INV-002';

/**
 * Demo investors. A and B differ in investment, participation AND distribution on purpose:
 * the isolation demonstration is only convincing if the two portfolios are visibly
 * different, so "I am seeing my own figures" is something the client can verify by eye.
 */
export const DEMO_INVESTORS_AB: InvestorRecord[] = [
  { InvestorID: DEMO_INVESTOR_A, InvestorName: 'Anand Rao (Demo A)', InvestmentAmount: 1_200_000, ParticipationPct: 0.40, Status: 'Active' },
  { InvestorID: DEMO_INVESTOR_B, InvestorName: 'Meera Krishnan (Demo B)', InvestmentAmount: 1_050_000, ParticipationPct: 0.35, Status: 'Active' },
  { InvestorID: 'INV-003', InvestorName: 'Suresh Reddy (Demo C)', InvestmentAmount: 750_000, ParticipationPct: 0.25, Status: 'Active' },
];

export interface DemoRegisters {
  rent: RentRecord[];
  assets: AssetRecord[];
  compliance: ComplianceRecord[];
}

export interface DemoDataset {
  readonly marker: typeof DEMO_MARKER;
  readonly demo: true;
  scenario: DemoScenario;
  /** The civil date the scenario presents as "today". */
  today: string;
  workbook: WorkbookData;
  ops: OperationsData;
  registers: DemoRegisters;
  guestSessions: GuestSession[];
  /** Human notes describing what this scenario is showing. For the demo script. */
  highlights: string[];
}

/* ------------------------------------------------------------------ *
 * Scenario timing
 * ------------------------------------------------------------------ */

const monthDay = (monthIndex: number, day: number): string =>
  serialToIso(edate(monthStart(DEMO_FY_START), monthIndex) + day - 1);

/**
 * Every scenario presents the SAME day.
 *
 * That is deliberate, and it was not the first design. Giving each scenario its own day had
 * an unwanted consequence: moving "today" back to November made December, January and
 * February future months, and the trading year emptied out behind the scenario. One shared
 * day keeps eleven months of history intact whichever scenario is showing.
 *
 * The scenarios differ by what is seeded AROUND that day — stays filling every unit, a
 * critical ticket, a queue of guest requests — so each still genuinely changes the screen.
 * Nothing is faked; the records are real and the engine computes their consequences.
 */
const PRESENTATION_MONTH = 10;
const PRESENTATION_DAY = 19;

const SCENARIO_TODAY: Record<DemoScenario, string> = {
  NORMAL_DAY: monthDay(PRESENTATION_MONTH, PRESENTATION_DAY),
  HIGH_OCCUPANCY: monthDay(PRESENTATION_MONTH, PRESENTATION_DAY),
  OPERATIONS_ISSUE: monthDay(PRESENTATION_MONTH, PRESENTATION_DAY),
  // Two days later, so the month-to-date figures a financial review looks at are fuller.
  FINANCIAL_REVIEW: monthDay(PRESENTATION_MONTH, PRESENTATION_DAY + 2),
  INVESTOR_REVIEW: monthDay(PRESENTATION_MONTH, PRESENTATION_DAY),
  GUEST_SUPPORT: monthDay(PRESENTATION_MONTH, PRESENTATION_DAY),
};

/** The month carrying a deliberate maintenance-driven expense spike. */
const EXPENSE_SPIKE_MONTH = 9;

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

export function buildDemoDataset(scenario: DemoScenario = DEFAULT_DEMO_SCENARIO): DemoDataset {
  const today = SCENARIO_TODAY[scenario];
  const todaySerial = isoToSerial(today);

  // Illustrative rules are applied for every scenario, so the distribution chain is
  // demonstrable throughout. They are labelled as demonstration values wherever shown.
  const workbook = buildDemoWorkbook(12, {
    activityByMonth: DEMO_ACTIVITY_BY_MONTH,
    settings: DEMO_SAMPLE_BUSINESS_RULES,
    // One "now" for the whole year, so a stay that finished in April reads as finished
    // rather than as still-confirmed.
    asOf: todaySerial,
  });
  workbook.investors = DEMO_INVESTORS_AB;

  applyScenarioSeeds(workbook, todaySerial, scenario);
  // The workbook owns PendingAmount as a formula. Fill it once every payment is seeded,
  // so the demo register agrees with the waterfall instead of restating it by hand.
  workbook.distributions = fillDistributionPending(workbook);

  const ops = buildDemoOperations(today, scenario);
  const registers = buildDemoRegisters(today, todaySerial, workbook.settings.rentDueDays);
  const guestSessions = buildGuestSessions(workbook, todaySerial);

  return {
    marker: DEMO_MARKER,
    demo: true,
    scenario,
    today,
    workbook,
    ops,
    registers,
    guestSessions,
    highlights: highlightsFor(scenario),
  };
}

/* ------------------------------------------------------------------ *
 * The twelve required conditions, seeded as real records
 * ------------------------------------------------------------------ */

/**
 * Inject the conditions a demonstration has to be able to show. Each one is a record in
 * the ledger, not a flag on a view — so the KPI engine computes its consequences the same
 * way it will compute production's.
 */
function applyScenarioSeeds(
  workbook: WorkbookData,
  today: number,
  scenario: DemoScenario,
): void {
  const year = Number(monthKeyOf(today).slice(0, 4));
  let seq = 9000;
  const bookingId = () => `BK-${year}-${String(++seq).padStart(4, '0')}`;

  /**
   * Recognise revenue for a seeded stay that actually happened.
   *
   * V1 keeps bookings and revenue in separate ledgers, so a seeded booking with no revenue
   * line would add occupied nights without income — depressing ADR and RevPAR and making
   * the demo look internally inconsistent. Every seeded stay that has started therefore
   * gets the revenue rows a real one would have.
   */
  const recognise = (booking: ReservationRecord, settled: boolean): void => {
    if (booking.BookingStatus !== 'Checked In' && booking.BookingStatus !== 'Checked Out') return;
    const on = Math.min(booking.CheckOutDate ?? today, today);
    const payoutStatus = settled ? 'Received' : 'Pending';
    workbook.revenue.push({
      RevenueID: `REV-${year}-${String(++seq).padStart(4, '0')}`,
      BookingID: booking.BookingID, PropertyID: booking.PropertyID, Date: on,
      RevenueType: 'Room', Platform: booking.Platform,
      GrossAmount: booking.RoomRevenue, Discount: booking.Discount, Tax: booking.Taxes,
      PlatformFee: booking.PlatformFee, OtherDeduction: booking.OtherDeductions,
      PayoutStatus: payoutStatus,
    });
    if (booking.CleaningFee > 0) {
      workbook.revenue.push({
        RevenueID: `REV-${year}-${String(++seq).padStart(4, '0')}`,
        BookingID: booking.BookingID, PropertyID: booking.PropertyID, Date: on,
        RevenueType: 'Cleaning Fee', Platform: booking.Platform,
        GrossAmount: booking.CleaningFee, Discount: 0, Tax: 0,
        PlatformFee: 0, OtherDeduction: 0, PayoutStatus: payoutStatus,
      });
    }
    if (settled && booking.ActualPayout > 0) {
      workbook.cashflow.push({
        TxnID: `CSH-${year}-${String(++seq).padStart(4, '0')}`,
        Date: booking.PayoutDate ?? on,
        Type: booking.Platform === 'Direct' ? 'Direct Booking Receipt' : 'Booking Payout',
        PropertyID: booking.PropertyID,
        MoneyIn: booking.ActualPayout, MoneyOut: 0, ReconStatus: 'Reconciled',
      });
    }
  };

  const base = (overrides: Partial<ReservationRecord>): ReservationRecord => ({
    BookingID: bookingId(),
    Platform: 'Direct',
    PlatformResID: '',
    PropertyID: 'HYD-501',
    // The demonstration dataset does not model when a booking was made. Inventing
    // lead times would fabricate exactly the evidence a historical re-estimate is
    // meant to test, so the gap is declared rather than filled.
    BookingDate: null,
    BookingStatus: 'Confirmed',
    GuestName: 'Demo Guest',
    Adults: 2,
    Children: 0,
    CheckInDate: today,
    CheckOutDate: today + 2,
    BaseRate: 4200,
    RoomRevenue: 8400,
    CleaningFee: 700,
    ExtraGuestFee: 0,
    OtherCharges: 0,
    Discount: 0,
    Taxes: 0,
    PlatformFee: 0,
    OtherDeductions: 0,
    ActualPayout: 0,
    PayoutDate: null,
    ...overrides,
  });

  /** Add a seeded booking and the revenue it implies. */
  const seed = (booking: ReservationRecord, settled = false): void => {
    workbook.reservations.push(booking);
    recognise(booking, settled);
  };

  /* 7 · upcoming check-in — an arrival today, awaiting the guest. */
  seed(base({
    PropertyID: 'HYD-502', Platform: 'Airbnb', PlatformResID: 'AI900017',
    GuestName: 'Priya Menon', BookingStatus: 'Confirmed',
    CheckInDate: today, CheckOutDate: today + 3,
    BaseRate: 2800, RoomRevenue: 8400, CleaningFee: 500, PlatformFee: 1335,
  }));

  /* 8 · upcoming checkout — a departure today, still in house. */
  seed(base({
    PropertyID: 'HYD-601', Platform: 'Booking.com', PlatformResID: 'BO900018',
    GuestName: 'Rahul Iyer', BookingStatus: 'Checked In',
    CheckInDate: today - 2, CheckOutDate: today,
    BaseRate: 4500, RoomRevenue: 9000, CleaningFee: 700, PlatformFee: 1746,
  }));

  /* 3 · cancellation — a recent, visible cancellation in the current month. */
  seed(base({
    PropertyID: 'HYD-602', Platform: 'Airbnb', PlatformResID: 'AI900019',
    GuestName: 'Sneha Kulkarni', BookingStatus: 'Cancelled',
    CheckInDate: today + 4, CheckOutDate: today + 6,
    BaseRate: 2800, RoomRevenue: 5600, CleaningFee: 500, PlatformFee: 915,
  }));

  /* 4 · payout mismatch — the platform paid materially less than expected. The
   *     reconciliation view has to be able to surface a real discrepancy, so one exists. */
  seed(base({
    PropertyID: 'HYD-501', Platform: 'Booking.com', PlatformResID: 'BO900020',
    GuestName: 'Karthik Nair', BookingStatus: 'Checked Out',
    CheckInDate: today - 9, CheckOutDate: today - 6,
    BaseRate: 4400, RoomRevenue: 13_200, CleaningFee: 700, PlatformFee: 2502,
    // Expected ≈ 11,398. Short by ~2,600: an unexplained deduction worth chasing.
    ActualPayout: 8_800, PayoutDate: today - 1,
  }), true);

  /* 2 · high occupancy — every unit occupied across the peak weekend. Added always, so
   *     the peak month reads as a peak month regardless of which day is being shown. */
  const peakStart = edate(monthStart(DEMO_FY_START), 7) + 22;
  for (const property of DEMO_PROPERTIES) {
    seed(base({
      PropertyID: property.PropertyID, Platform: 'Direct',
      GuestName: 'Festive Group Booking', BookingStatus: 'Checked Out',
      CheckInDate: peakStart, CheckOutDate: peakStart + 4,
      BaseRate: 5200, RoomRevenue: 20_800, CleaningFee: 700,
      ActualPayout: 21_500, PayoutDate: peakStart + 4,
    }), true);
  }

  /* 9 · expense spike — a one-off structural repair, large enough to bend the P&L. */
  const spikeMonth = edate(monthStart(DEMO_FY_START), EXPENSE_SPIKE_MONTH);
  const spike: ExpenseRecord = {
    ExpenseID: `EXP-${year}-9001`,
    Date: spikeMonth + 11,
    PropertyID: 'HYD-601',
    ExpenseCategory: 'Variable Operating',
    ExpenseSubcategory: 'Repairs',
    Amount: 96_500,
    Tax: 0,
    PaymentStatus: 'Paid',
    ExpenseType: 'Operating',
  };
  workbook.expenses.push(spike);

  /* 11 · investor distribution — payments actually made, so the distribution screens show
   *      paid vs pending rather than an empty table. Split unevenly across A/B/C in line
   *      with their participation, and only for months that traded. */
  const distributionMonth = edate(monthStart(DEMO_FY_START), PRESENTATION_MONTH - 1);
  const paid: Array<[string, number]> = [
    [DEMO_INVESTOR_A, 46_000],
    [DEMO_INVESTOR_B, 40_250],
    ['INV-003', 28_750],
  ];
  for (const [investorId, amount] of paid) {
    const record: DistributionRecord = {
      Period: distributionMonth,
      InvestorID: investorId,
      PaidAmount: amount,
      PaidDate: edate(distributionMonth, 1) + 6,
      PendingAmount: 0,   // filled from the waterfall once every payment is in place
    };
    workbook.distributions.push(record);
    workbook.cashflow.push({
      TxnID: `CSH-${year}-90${workbook.distributions.length}`,
      Date: record.PaidDate ?? distributionMonth,
      Type: 'Investor Distribution',
      PropertyID: 'COMMON',
      MoneyIn: 0,
      MoneyOut: amount,
      ReconStatus: 'Reconciled',
    });
  }

  /* Scenario-specific additions layered on top of the always-present conditions. */
  if (scenario === 'HIGH_OCCUPANCY') {
    // Everything booked, and a waiting list of arrivals over the next three days.
    for (const [index, property] of DEMO_PROPERTIES.entries()) {
      seed(base({
        PropertyID: property.PropertyID, Platform: index % 2 ? 'Airbnb' : 'Direct',
        GuestName: 'Peak Season Guest', BookingStatus: 'Checked In',
        CheckInDate: today - 1, CheckOutDate: today + 2 + index,
        BaseRate: 5400, RoomRevenue: 5400 * (3 + index), CleaningFee: 700,
      }));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Operational records
 * ------------------------------------------------------------------ */

function buildDemoOperations(today: string, scenario: DemoScenario): OperationsData {
  const shift = (days: number) => serialToIso(isoToSerial(today) + days);

  const maintenance: MaintenanceTicket[] = [
    { ticketId: 'MNT-D-0011', propertyId: 'HYD-601', category: 'AC / Appliance', priority: 'High',
      status: 'In Progress', description: 'Bedroom AC not cooling', reportedOn: shift(-2) },
    { ticketId: 'MNT-D-0012', propertyId: 'HYD-502', category: 'Plumbing', priority: 'Medium',
      status: 'Open', description: 'Slow drain in the bathroom', reportedOn: shift(-1) },
    { ticketId: 'MNT-D-0013', propertyId: 'HYD-501', category: 'Furniture', priority: 'Low',
      status: 'Assigned', description: 'Loose dining chair', reportedOn: shift(-4) },
    { ticketId: 'MNT-D-0009', propertyId: 'HYD-602', category: 'Electrical', priority: 'Medium',
      status: 'Resolved', description: 'Balcony light replaced', reportedOn: shift(-9) },
  ];

  const housekeeping: HousekeepingTask[] = [
    { taskId: 'HK-D-0044', propertyId: 'HYD-502', checkoutDate: today, status: 'Pending' },
    { taskId: 'HK-D-0043', propertyId: 'HYD-602', checkoutDate: shift(-1), status: 'Completed' },
    { taskId: 'HK-D-0042', propertyId: 'HYD-501', checkoutDate: shift(-2), status: 'Completed' },
  ];

  /* 6 · low inventory — two items below their reorder point, two comfortably above. */
  const inventory: InventoryItem[] = [
    { itemId: 'ITM-D-002', propertyId: 'COMMON', item: 'Bath towels', unit: 'pcs', currentStock: 4, minStock: 12 },
    { itemId: 'ITM-D-005', propertyId: 'COMMON', item: 'Shampoo sachets', unit: 'pcs', currentStock: 18, minStock: 30 },
    { itemId: 'ITM-D-001', propertyId: 'COMMON', item: 'Toilet rolls', unit: 'rolls', currentStock: 46, minStock: 24 },
    { itemId: 'ITM-D-004', propertyId: 'COMMON', item: 'Detergent', unit: 'kg', currentStock: 9, minStock: 5 },
  ];

  const guestRequests: GuestRequest[] = [
    { requestId: 'GR-D-0007', propertyId: 'HYD-501', summary: 'Late checkout requested (2 PM)',
      raisedOn: today, status: 'Open' },
  ];

  /* 5 · maintenance issue — escalated to critical, with a unit taken out of service. */
  if (scenario === 'OPERATIONS_ISSUE') {
    maintenance.unshift({
      ticketId: 'MNT-D-0020', propertyId: 'HYD-501', category: 'Plumbing', priority: 'Critical',
      status: 'Open', description: 'Water leak in the 5th floor bathroom — unit off-market',
      reportedOn: today,
    });
    housekeeping.unshift({
      taskId: 'HK-D-0050', propertyId: 'HYD-601', checkoutDate: today, status: 'Failed Inspection',
    });
    inventory.push({
      itemId: 'ITM-D-007', propertyId: 'COMMON', item: 'Bed linen sets', unit: 'sets',
      currentStock: 2, minStock: 10,
    });
  }

  /* Guest support — a queue of open requests to work through. */
  if (scenario === 'GUEST_SUPPORT') {
    guestRequests.push(
      { requestId: 'GR-D-0008', propertyId: 'HYD-502', summary: 'Extra towels and a hairdryer',
        raisedOn: today, status: 'Open' },
      { requestId: 'GR-D-0009', propertyId: 'HYD-601', summary: 'Wi-Fi password not working',
        raisedOn: today, status: 'In Progress' },
      { requestId: 'GR-D-0010', propertyId: 'HYD-602', summary: 'Airport pickup on Thursday',
        raisedOn: shift(-1), status: 'Open' },
    );
  }

  return {
    today,
    maintenance,
    housekeeping,
    inventory,
    guestRequests,
    // The demo records guest requests, so — unlike a live V1 read — nothing is untracked.
    unavailableCounters: [],
  };
}

/* ------------------------------------------------------------------ *
 * Registers — rent, assets, compliance
 * ------------------------------------------------------------------ */

/** Fill V1's two calculated rent columns with the engine's port of the same rules. */
function withRentSchedule(
  record: Omit<RentRecord, 'nextDueDate' | 'paymentStatus'>,
  todaySerial: number,
  rentDueDays: number,
): RentRecord {
  return { ...record, ...computeRentSchedule(record, todaySerial, rentDueDays) };
}

function buildDemoRegisters(today: string, todaySerial: number, rentDueDays: number): DemoRegisters {
  const fyStartIso = serialToIso(DEMO_FY_START);
  const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;

  const rent: RentRecord[] = DEMO_PROPERTIES.map((property, i) => withRentSchedule({
    recordId: `RNT-D-000${i + 1}`,
    propertyId: property.PropertyID,
    costType: 'Rent',
    landlordVendor: `Demo Landlord ${i + 1}`,
    monthlyAmount: property.BHKType === '2 BHK' ? 26_000 : 18_000,
    dueDay: 5,
    agreementStart: fyStartIso,
    agreementEnd: serialToIso(edate(DEMO_FY_START, 36)),
    escalationPct: 0.05,
    lastPaidDate: serialToIso(isoToSerial(monthOf(today)) + 4),
    paidForMonth: monthOf(today),
    notes: DEMO_NOTE,
  }, todaySerial, rentDueDays));

  const assets: AssetRecord[] = [
    { assetId: 'AST-D-0001', propertyId: 'HYD-501', category: 'Appliance', asset: 'Split AC 1.5T',
      purchaseDate: serialToIso(DEMO_FY_START + 12), purchaseCost: 42_000, vendor: 'Demo Appliances',
      warrantyExpiry: serialToIso(edate(DEMO_FY_START, 24)), usefulLifeMonths: 84,
      condition: 'Good', currentStatus: 'In Use', notes: DEMO_NOTE },
    { assetId: 'AST-D-0002', propertyId: 'HYD-601', category: 'Appliance', asset: 'Split AC 1.5T',
      purchaseDate: serialToIso(DEMO_FY_START + 40), purchaseCost: 42_000, vendor: 'Demo Appliances',
      warrantyExpiry: serialToIso(edate(DEMO_FY_START, 3)), usefulLifeMonths: 84,
      condition: 'Fair', currentStatus: 'Under Repair', notes: `${DEMO_NOTE} Linked to MNT-D-0011.` },
    { assetId: 'AST-D-0003', propertyId: 'HYD-602', category: 'Electronics', asset: '43" Smart TV',
      purchaseDate: serialToIso(edate(DEMO_FY_START, 5) + 8), purchaseCost: 29_000, vendor: 'Demo Electronics',
      warrantyExpiry: serialToIso(edate(DEMO_FY_START, 29)), usefulLifeMonths: 60,
      condition: 'New', currentStatus: 'In Use', notes: DEMO_NOTE },
    { assetId: 'AST-D-0004', propertyId: 'COMMON', category: 'Security', asset: 'Smart lock set (4)',
      purchaseDate: serialToIso(edate(DEMO_FY_START, 3) + 5), purchaseCost: 36_000, vendor: 'Demo Security',
      warrantyExpiry: serialToIso(edate(DEMO_FY_START, 15)), usefulLifeMonths: 48,
      condition: 'Good', currentStatus: 'In Use', notes: DEMO_NOTE },
  ];

  const compliance: ComplianceRecord[] = [
    { complianceId: 'CMP-D-0001', requirement: 'Trade licence', propertyId: 'COMMON',
      authority: 'GHMC (demo)', responsiblePerson: 'Operations Manager (demo)', status: 'Valid',
      issueDate: fyStartIso, expiryDate: serialToIso(edate(DEMO_FY_START, 12)),
      documentRef: 'DEMO/TL/001', notes: DEMO_NOTE },
    { complianceId: 'CMP-D-0002', requirement: 'Fire safety certificate', propertyId: 'COMMON',
      authority: 'Fire Services (demo)', responsiblePerson: 'Operations Manager (demo)',
      status: 'Expiring Soon', issueDate: serialToIso(edate(DEMO_FY_START, -6)),
      expiryDate: serialToIso(isoToSerial(today) + 21), documentRef: 'DEMO/FS/002', notes: DEMO_NOTE },
    { complianceId: 'CMP-D-0003', requirement: 'GST registration', propertyId: 'COMMON',
      authority: 'GSTN (demo)', responsiblePerson: 'Accountant (demo)', status: 'Valid',
      issueDate: serialToIso(edate(DEMO_FY_START, -18)), expiryDate: null,
      documentRef: 'DEMO/GST/003', notes: DEMO_NOTE },
    { complianceId: 'CMP-D-0004', requirement: 'Police guest registration', propertyId: 'COMMON',
      authority: 'Local police (demo)', responsiblePerson: 'Operations Manager (demo)',
      status: 'In Progress', issueDate: null, expiryDate: null,
      documentRef: 'DEMO/PGR/004', notes: `${DEMO_NOTE} Renewal submitted.` },
  ];

  return { rent, assets, compliance };
}

/* ------------------------------------------------------------------ *
 * Guest sessions — for the demo guest journey
 * ------------------------------------------------------------------ */

function buildGuestSessions(workbook: WorkbookData, today: number): GuestSession[] {
  const relevant = workbook.reservations
    .filter((b) => b.CheckInDate !== null && b.CheckOutDate !== null)
    .filter((b) => b.CheckInDate! <= today + 1 && b.CheckOutDate! >= today)
    .filter((b) => b.BookingStatus === 'Confirmed' || b.BookingStatus === 'Checked In')
    .slice(0, 4);

  return relevant.map<GuestSession>((booking, i) => ({
    sessionId: `GS-D-000${i + 1}`,
    bookingId: booking.BookingID,
    propertyId: booking.PropertyID,
    // Given name + last initial. A guest portal never needs more than a list view does.
    guestDisplayName: minimalName(booking.GuestName),
    checkIn: serialToIso(booking.CheckInDate!),
    checkOut: serialToIso(booking.CheckOutDate!),
    status: booking.CheckInDate! > today ? 'Arriving'
      : booking.CheckOutDate! <= today ? 'Departed' : 'In House',
    demo: true,
  }));
}

function minimalName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0]) return parts[0] ?? 'Guest';
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0)}.`;
}

/* ------------------------------------------------------------------ *
 * Demo script notes
 * ------------------------------------------------------------------ */

function highlightsFor(scenario: DemoScenario): string[] {
  switch (scenario) {
    case 'HIGH_OCCUPANCY':
      return [
        'All four units are occupied — occupancy and RevPAR are at their peak.',
        'The unit board shows no availability and a queue of staggered departures.',
      ];
    case 'OPERATIONS_ISSUE':
      return [
        'A critical water leak has taken HYD-501 off-market — the board shows Maintenance.',
        'HYD-601 failed its housekeeping inspection and is not ready to sell.',
        'Three stock lines are below their reorder point.',
      ];
    case 'FINANCIAL_REVIEW':
      return [
        'The previous month carries a ₹96,500 structural repair.',
        'The P&L shows the spike in Repairs & Maintenance and the margin it cost.',
        'Some current-month bills are still unpaid, so pending payables is a real figure.',
      ];
    case 'INVESTOR_REVIEW':
      return [
        'A distribution has been paid; the waterfall shows reserve, pool and allocations.',
        'Investor A and Investor B see different investments, participation and payments.',
        'Commercial rules shown are ILLUSTRATIVE demonstration values, not approved terms.',
      ];
    case 'GUEST_SUPPORT':
      return [
        'Four open guest requests, one arrival today and one departure today.',
        'The guest journey ends with the request appearing in the operations queue.',
      ];
    case 'NORMAL_DAY':
    default:
      return [
        'A representative mid-month day: mixed occupancy, one turnover pending.',
        'One payout is short of expectation and is visible on the reservations screen.',
      ];
  }
}
