/**
 * LIVE PARITY — the TypeScript KPI engine vs Google's own formula engine.
 *
 * This is the ONLY layer that compares against real spreadsheet formula results. The
 * offline layers compare against V1's JavaScript implementation of the same definitions,
 * which is strong but cannot catch a difference between that JavaScript and what Sheets
 * actually evaluates.
 *
 * It runs only when BOTH env vars are set:
 *   GOOGLE_SHEET_ID                       (a COPY of the workbook — never production)
 *   GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
 * Otherwise every case reports NOT RUN and the parity report says so plainly rather than
 * implying coverage that does not exist.
 *
 * READ-ONLY. It never writes to the spreadsheet, and it never touches CFG_REPORT_MONTH.
 * The report-month-dependent blocks are read exactly as the workbook currently stands,
 * and the engine is asked for the same month — reading is not selecting.
 *
 * WHAT IT COVERS. Every family below produces its own tally in the report, so a green
 * gate cannot mean "we compared revenue and called it parity":
 *
 *   monthly revenue · monthly expenses · operating profit · operating margin · occupancy
 *   ADR · RevPAR · booking count · cancellations · ALOS · CAPEX treatment · cash flow
 *   rent · payout reconciliation · property performance · platform performance
 *   investor waterfall · loss carry-forward · reserve · management fee
 *   configured investor pool · blank/TBD behaviour
 *
 * plus eleven named business scenarios, each of which must be PRESENT in the copy — an
 * absent scenario is reported as a preparation gap, never as a pass.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleSheetsApiClient } from '@/lib/server/sheets/client';
import {
  AnalyticsRepository, loadWorkbookData, loadOperationsData, loadRentRegister,
} from '@/lib/server/sheets/repositories';
import {
  computeMonthlySeries, computeByProperty, computeByPlatform, computeInvestorAllocations,
  fyMonthKeysFor, monthPeriod, pendingReceivables, pendingPayables,
  pendingInvestorDistributions, expectedPayout, estimatedPlatformFee, bookingNights,
  grossBookingValue, expenseTotal, revenueNet,
} from '@/lib/server/analytics/kpi';
import { computeRentSchedule } from '@/lib/server/analytics/rent';
import {
  SHEETS, COLUMNS, CALC, columnIndex, dataRange,
} from '@/lib/contract/contract.generated';
import {
  OPEN_MAINTENANCE_STATUSES, OPEN_HOUSEKEEPING_STATUSES, OCCUPANCY_STATUSES,
  CANCELLED_STATUSES,
} from '@/lib/shared/domain';
import type {
  MonthlyMetrics, WorkbookData, OperationsData, RentRecord,
} from '@/lib/shared/domain';
import { isoToSerial, monthKeyOf, type Serial } from '@/lib/shared/dates';
// Plain ESM module, shared with the parity scripts.
import { resolveParityEnv } from '../scripts/parity-env.mjs';

/*
 * `npm run parity` normalises the operator's variables before spawning this suite, so
 * either naming works. Resolving here too means a direct `vitest run` picks up the same
 * PARITY_* variables the runbook tells the operator to set.
 */
const PARITY_ENV = resolveParityEnv(process.env);
const SHEET_ID = PARITY_ENV.sheetId;
const SA_JSON = PARITY_ENV.base64;
const CREDENTIALS_PRESENT = PARITY_ENV.configured;
const REPORT = path.resolve(process.cwd(), 'reports', 'parity.live.json');

/* ------------------------------------------------------------------ *
 * Tolerances.
 *
 * These are floating-point allowances, NOT business allowances. A count that differs by
 * one is a defect, not a rounding artefact, so counts and text compare exactly.
 * ------------------------------------------------------------------ */
const TOL = {
  money: 0.01,      // one paisa
  ratio: 1e-9,      // occupancy, margin, cancellation rate — pure division
  nights: 1e-9,     // ALOS is a division; occupied nights are whole
  count: 0,         // bookings, tickets, units
  exact: 0,         // dates and text
} as const;

/** The metric families the release gate is required to validate. */
const FAMILY = {
  revenue: 'monthly revenue',
  expenses: 'monthly expenses',
  profit: 'operating profit',
  margin: 'operating margin',
  occupancy: 'occupancy',
  adr: 'ADR',
  revpar: 'RevPAR',
  bookings: 'booking count',
  cancellations: 'cancellations',
  alos: 'ALOS',
  capex: 'CAPEX treatment',
  cashflow: 'cash flow',
  rent: 'rent',
  payout: 'payout reconciliation',
  property: 'property performance',
  platform: 'platform performance',
  waterfall: 'investor waterfall',
  carryForward: 'loss carry-forward',
  reserve: 'reserve',
  mgmtFee: 'management fee',
  pool: 'configured investor pool',
  blankTbd: 'blank/TBD behaviour',
} as const;
type Family = typeof FAMILY[keyof typeof FAMILY];

/** The eleven scenarios the copy has to exercise. */
const SCENARIOS = [
  'zero revenue period', 'empty month', 'cancellation', 'partial payout',
  'expense spike', 'misfiled CAPEX', 'negative month', 'loss recovery',
  'multiple investors', 'property filtering', 'platform filtering',
] as const;
type ScenarioName = typeof SCENARIOS[number];

interface LiveRow {
  family: Family;
  section: string;
  subject: string;              // month, property, platform, booking id…
  metric: string;
  sheet: number | string;
  typescript: number | string;
  delta: number | null;
  tolerance: number;
  pass: boolean;
  /** The workbook address or formula the sheet value came from. */
  source: string;
  /** True where the comparison depends on the spreadsheet's clock. */
  clockSensitive?: boolean;
}

interface ScenarioResult {
  name: ScenarioName;
  present: boolean;
  detail: string;
  checks: number;
  failed: number;
}

interface NotCompared {
  family: Family | 'report-month KPIs';
  metric: string;
  reason: string;
}

const rows: LiveRow[] = [];
const notCompared: NotCompared[] = [];
const scenarioResults: ScenarioResult[] = [];

function compare(
  family: Family, section: string, subject: string, metric: string,
  sheet: number | string, ts: number | string, tolerance: number, source: string,
  clockSensitive = false,
): boolean {
  const numeric = typeof sheet === 'number' && typeof ts === 'number';
  const delta = numeric ? Number(((ts as number) - (sheet as number)).toFixed(6)) : null;
  const pass = numeric
    ? Math.abs((ts as number) - (sheet as number)) <= tolerance
    : String(sheet).trim() === String(ts).trim();
  rows.push({
    family, section, subject, metric, sheet, typescript: ts, delta, tolerance, pass, source,
    ...(clockSensitive ? { clockSensitive: true } : {}),
  });
  return pass;
}

/** Fails the suite listing every mismatch, rather than only the first. */
function assertSection(section: string): void {
  const failures = rows.filter((r) => r.section === section && !r.pass);
  expect(
    failures.map((f) => `${f.subject} ${f.metric}: sheet=${f.sheet} ts=${f.typescript} Δ=${f.delta} (tol ${f.tolerance}) [${f.source}]`),
    `${section}: ${failures.length} mismatch(es)`,
  ).toEqual([]);
}

/** 99_CALC monthly-block row → engine field, family and tolerance. All 31 numeric rows. */
const MONTHLY: Array<[string, keyof MonthlyMetrics, Family, number]> = [
  ['DaysInMonth', 'daysInMonth', FAMILY.occupancy, TOL.count],
  ['ActiveUnits', 'activeUnits', FAMILY.occupancy, TOL.count],
  ['AvailableNights', 'availableNights', FAMILY.occupancy, TOL.count],
  ['OccupiedNights', 'occupiedNights', FAMILY.occupancy, TOL.count],
  ['OccupancyPct', 'occupancyPct', FAMILY.occupancy, TOL.ratio],
  ['RoomRevenue', 'roomRevenue', FAMILY.revenue, TOL.money],
  ['CleaningRevenue', 'cleaningRevenue', FAMILY.revenue, TOL.money],
  ['OtherRevenue', 'otherRevenue', FAMILY.revenue, TOL.money],
  ['GrossRevenue', 'grossRevenue', FAMILY.revenue, TOL.money],
  ['Discounts', 'discounts', FAMILY.revenue, TOL.money],
  ['PlatformFees', 'platformFees', FAMILY.revenue, TOL.money],
  ['Taxes', 'taxes', FAMILY.revenue, TOL.money],
  ['NetRevenue', 'netRevenue', FAMILY.revenue, TOL.money],
  ['OperatingExpenses', 'operatingExpenses', FAMILY.expenses, TOL.money],
  ['OperatingProfit', 'operatingProfit', FAMILY.profit, TOL.money],
  ['OperatingMarginPct', 'operatingMarginPct', FAMILY.margin, TOL.ratio],
  ['ADR', 'adr', FAMILY.adr, TOL.money],
  ['RevPAR', 'revPar', FAMILY.revpar, TOL.money],
  ['BookingsCount', 'bookingsCount', FAMILY.bookings, TOL.count],
  ['CancelledCount', 'cancelledCount', FAMILY.cancellations, TOL.count],
  ['CancellationRatePct', 'cancellationRatePct', FAMILY.cancellations, TOL.ratio],
  ['ALOS', 'alos', FAMILY.alos, TOL.nights],
  ['CapexTotal', 'capexTotal', FAMILY.capex, TOL.money],
  ['ReserveAmt', 'reserveAmt', FAMILY.reserve, TOL.money],
  ['MgmtFeeAmt', 'mgmtFeeAmt', FAMILY.mgmtFee, TOL.money],
  ['CarryForwardApplied', 'carryForwardApplied', FAMILY.carryForward, TOL.money],
  ['CarryForwardBalance', 'carryForwardBalance', FAMILY.carryForward, TOL.money],
  ['DistributableProfit', 'distributableProfit', FAMILY.waterfall, TOL.money],
  ['InvestorPoolAmt', 'investorPoolAmt', FAMILY.pool, TOL.money],
  ['DistributionsPaid', 'distributionsPaid', FAMILY.waterfall, TOL.money],
  ['CashIn', 'cashIn', FAMILY.cashflow, TOL.money],
  ['CashOut', 'cashOut', FAMILY.cashflow, TOL.money],
  ['NetCash', 'netCash', FAMILY.cashflow, TOL.money],
];

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

describe.skipIf(!CREDENTIALS_PRESENT)('LIVE · TypeScript engine vs Google Sheets formulas', () => {
  let client: GoogleSheetsApiClient;
  let analytics: AnalyticsRepository;
  let data: WorkbookData;
  let ops: OperationsData;
  let rent: RentRecord[];
  let series: MonthlyMetrics[];
  let monthKeys: string[];
  let monthlyBlock: Record<string, number[]>;
  let reportMonth: { monthStart: Serial | null; monthKey: string };
  let sheetToday: string;
  let title = '';
  let timeZone = '';

  beforeAll(async () => {
    client = new GoogleSheetsApiClient({
      spreadsheetId: SHEET_ID!,
      serviceAccountJsonBase64: SA_JSON!,
    });

    // The engine's "today" must be the spreadsheet's today, or every TODAY()-based
    // formula would be compared against a different day and the gate would go red on a
    // timezone, not on a defect.
    const meta = await client.spreadsheetMetadata();
    title = meta.title;
    timeZone = meta.timeZone;
    sheetToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    analytics = new AnalyticsRepository(client);
    [data, ops, rent, monthlyBlock, reportMonth] = await Promise.all([
      loadWorkbookData(client),
      loadOperationsData(client, sheetToday),
      loadRentRegister(client),
      analytics.readMonthlyBlock(),
      analytics.readReportMonth(),
    ]);
    monthKeys = fyMonthKeysFor(data);
    series = computeMonthlySeries(data, monthKeys);
  }, 180_000);

  /* ================================================================ *
   * 1 · The FY monthly block — 33 rows × 12 months.
   * ================================================================ */
  it('agrees on every monthly-block metric, for all 12 FY months', () => {
    const section = 'Monthly block';
    for (const [sheetMetric, engineField, family, tolerance] of MONTHLY) {
      const sheetValues = monthlyBlock[sheetMetric];
      expect(sheetValues, `99_CALC row missing: ${sheetMetric}`).toBeDefined();

      series.forEach((month, i) => {
        const rowNumber = (CALC.monthlyRows as Record<string, number>)[sheetMetric];
        const cell = `${CALC.sheet}!${colA1(CALC.firstMonthCol + i)}${rowNumber}`;
        compare(family, section, month.monthKey, sheetMetric,
          sheetValues![i] ?? 0, Number(month[engineField]), tolerance, cell);
      });
    }
    assertSection(section);
  });

  /* ================================================================ *
   * 2 · Report-month KPI scalars (column Q).
   *
   * Read for whatever month CFG_REPORT_MONTH is set to; the engine is asked for the
   * same month. Nothing is written to choose it.
   * ================================================================ */
  it('agrees on the report-month KPI scalars', async () => {
    const section = 'Report-month KPIs';
    const kpis = await analytics.readReportMonthKpis();
    const monthKey = reportMonth.monthKey;
    expect(monthKey, 'CFG_REPORT_MONTH resolves to no month').not.toBe('');

    const month = series.find((m) => m.monthKey === monthKey);
    const col = CALC.reportMonthDependent.kpiValueColA1;
    const at = (metric: string) =>
      `${CALC.sheet}!${col}${(CALC.reportMonthDependent.kpiRows as Record<string, number>)[metric]}`;
    const check = (
      family: Family, metric: string, ts: number, tolerance: number, clockSensitive = false,
    ) => compare(family, section, monthKey, metric, num(kpis[metric]), ts, tolerance,
      at(metric), clockSensitive);

    // Figures that come straight from the monthly block for the report month.
    if (month) {
      check(FAMILY.revenue, 'MTDNetRevenue', month.netRevenue, TOL.money);
      check(FAMILY.expenses, 'MTDExpenses', month.operatingExpenses, TOL.money);
      check(FAMILY.profit, 'MTDOperatingProfit', month.operatingProfit, TOL.money);
      check(FAMILY.occupancy, 'OccupancyPct', month.occupancyPct, TOL.ratio);
      check(FAMILY.adr, 'ADR', month.adr, TOL.money);
      check(FAMILY.revpar, 'RevPAR', month.revPar, TOL.money);
    } else {
      notCompared.push({
        family: 'report-month KPIs',
        metric: 'MTD figures',
        reason: `CFG_REPORT_MONTH (${monthKey}) is outside the financial year starting ${monthKeys[0]}.`,
      });
    }

    check(FAMILY.occupancy, 'TotalUnits',
      data.properties.filter((p) => p.PropertyID !== '').length, TOL.count);

    // Payout reconciliation and the obligation side of the ledger.
    check(FAMILY.payout, 'PendingReceivables', pendingReceivables(data), TOL.money);
    check(FAMILY.waterfall, 'PendingInvestorDistributions',
      pendingInvestorDistributions(data), TOL.money);
    check(FAMILY.rent, 'PendingPayables', pendingPayables(data, rent), TOL.money);

    // Operational counters. Clock-sensitive: the sheet evaluates TODAY() in its own
    // timezone, which is why the engine was given that same date.
    check(FAMILY.occupancy, 'OpenMaintTickets',
      ops.maintenance.filter((t) => OPEN_MAINTENANCE_STATUSES.includes(t.status)).length,
      TOL.count, true);
    check(FAMILY.occupancy, 'PendingCleanings',
      ops.housekeeping.filter((t) => OPEN_HOUSEKEEPING_STATUSES.includes(t.status)).length,
      TOL.count, true);
    check(FAMILY.occupancy, 'LowStockItems',
      ops.inventory.filter((i) => i.currentStock <= i.minStock).length, TOL.count, true);

    const today = isoToSerial(sheetToday);
    const lookahead = 7;   // CFG_CHECKIN_LOOKAHEAD default; compared as a window, below
    check(FAMILY.bookings, 'UpcomingCheckins', data.reservations.filter((b) =>
      b.BookingStatus === 'Confirmed' && b.CheckInDate !== null
      && b.CheckInDate >= today && b.CheckInDate <= today + lookahead).length, TOL.count, true);
    check(FAMILY.bookings, 'UpcomingCheckouts', data.reservations.filter((b) =>
      b.BookingStatus === 'Checked In' && b.CheckOutDate !== null
      && b.CheckOutDate >= today && b.CheckOutDate <= today + lookahead).length, TOL.count, true);

    /*
     * A definitional divergence the workbook has to settle, not the harness.
     *
     * 99_CALC Q22 sums the register's PendingAmount column across every period. The web
     * dashboard shows a figure under the same name that is computed differently: unpaid
     * ALLOCATIONS for the reporting month, including periods with no register row yet.
     *
     * The register definition is the one asserted above, because it is what the workbook
     * computes and the workbook is the business reference. Both numbers are recorded here
     * so the decision is made on evidence rather than on which one someone saw first.
     */
    {
      const registerSum = pendingInvestorDistributions(data);
      const allocationSum = computeInvestorAllocations(data, monthKey)
        .reduce((total, a) => total + a.pendingAmount, 0);
      if (Math.abs(registerSum - allocationSum) > TOL.money) {
        notCompared.push({
          family: FAMILY.waterfall,
          metric: 'Pending Investor Distributions — dashboard definition',
          reason: `DECISION REQUIRED. 99_CALC Q22 sums the register column across all periods `
            + `(₹${registerSum.toFixed(2)}, compared above and in agreement). The dashboard KPI `
            + `sums unpaid allocations for ${monthKey} only (₹${allocationSum.toFixed(2)}), which `
            + `counts a period that has no register row yet. Both are defensible; which one the `
            + `business means is a management call, and Pending Payables changes with it.`,
        });
      }
    }

    // Honest gaps rather than silent omissions.
    notCompared.push({
      family: 'report-month KPIs', metric: 'ComplianceDue',
      reason: '17_COMPLIANCE has no repository — the engine has no equivalent to compare.',
    });
    for (const metric of ['AvailableUnits', 'OccupiedUnits', 'CleaningUnits', 'MaintenanceUnits', 'BlockedUnits']) {
      notCompared.push({
        family: 'report-month KPIs', metric,
        reason: 'Derived from the 99_CALC property block’s StatusNow column, which is compared directly in the property-block section.',
      });
    }

    assertSection(section);
  });

  /* ================================================================ *
   * 3 · Per-property block — property performance.
   * ================================================================ */
  it('agrees on per-property performance for the report month', async () => {
    const section = 'Property block';
    const block = await analytics.readPropertyBlock();
    expect(block.length, 'the property block is empty').toBeGreaterThan(0);

    const period = monthPeriod(reportMonth.monthKey);
    const engine = new Map(
      computeByProperty(data, period).map((p) => [p.propertyId, p]),
    );
    const cols = CALC.reportMonthDependent.propertyBlock.cols as Record<string, number>;
    const firstRow = CALC.reportMonthDependent.propertyBlock.firstRow;

    block.forEach((sheetRow, i) => {
      const id = text(sheetRow.PropertyID);
      const ts = engine.get(id);
      expect(ts, `engine has no property ${id}`).toBeDefined();
      if (!ts) return;
      const at = (c: string) => `${CALC.sheet}!${colA1(cols[c]!)}${firstRow + i}`;
      const c = (metric: string, sheetValue: unknown, tsValue: number, tol: number, family: Family) =>
        compare(family, section, id, metric, num(sheetValue), tsValue, tol, at(metric));

      c('RevenueMTD', sheetRow.RevenueMTD, ts.netRevenue, TOL.money, FAMILY.property);
      c('ExpensesMTD', sheetRow.ExpensesMTD, ts.directOperatingExpenses, TOL.money, FAMILY.property);
      c('ProfitMTD', sheetRow.ProfitMTD, ts.profit, TOL.money, FAMILY.property);
      c('OccNightsMTD', sheetRow.OccNightsMTD, ts.occupiedNights, TOL.count, FAMILY.occupancy);
      c('OccPctMTD', sheetRow.OccPctMTD, ts.occupancyPct, TOL.ratio, FAMILY.occupancy);
      c('ADR', sheetRow.ADR, ts.adr, TOL.money, FAMILY.adr);
      c('RevPAR', sheetRow.RevPAR, ts.revPar, TOL.money, FAMILY.revpar);
      c('BookingsMTD', sheetRow.BookingsMTD, ts.bookings, TOL.count, FAMILY.bookings);
    });
    assertSection(section);
  });

  /* ================================================================ *
   * 4 · Per-platform block — platform performance.
   * ================================================================ */
  it('agrees on per-platform mix for the report month', async () => {
    const section = 'Platform block';
    const block = await analytics.readPlatformBlock();
    expect(block.length, 'the platform block is empty').toBeGreaterThan(0);

    const period = monthPeriod(reportMonth.monthKey);
    const engine = new Map(computeByPlatform(data, period).map((p) => [p.platform, p]));
    const cols = CALC.reportMonthDependent.platformBlock.cols as Record<string, number>;
    const firstRow = CALC.reportMonthDependent.platformBlock.firstRow;

    block.forEach((sheetRow, i) => {
      const name = text(sheetRow.Platform);
      const ts = engine.get(name);
      expect(ts, `engine has no platform ${name}`).toBeDefined();
      if (!ts) return;
      const at = (c: string) => `${CALC.sheet}!${colA1(cols[c]!)}${firstRow + i}`;
      compare(FAMILY.platform, section, name, 'Bookings',
        num(sheetRow.Bookings), ts.bookings, TOL.count, at('Bookings'));
      compare(FAMILY.platform, section, name, 'GrossRevenue',
        num(sheetRow.GrossRevenue), ts.grossRevenue, TOL.money, at('GrossRevenue'));
      compare(FAMILY.platform, section, name, 'Fees',
        num(sheetRow.Fees), ts.feesAndDeductions, TOL.money, at('Fees'));
      compare(FAMILY.platform, section, name, 'NetRevenue',
        num(sheetRow.NetRevenue), ts.netRevenue, TOL.money, at('NetRevenue'));
    });
    assertSection(section);
  });

  /* ================================================================ *
   * 5 · Expense category block.
   * ================================================================ */
  it('agrees on operating expenses by category for the report month', async () => {
    const section = 'Expense categories';
    const block = await analytics.readExpenseCategoryBlock();
    const period = monthPeriod(reportMonth.monthKey);
    const cols = CALC.reportMonthDependent.expenseCategoryBlock.cols as Record<string, number>;
    const firstRow = CALC.reportMonthDependent.expenseCategoryBlock.firstRow;

    block.forEach((sheetRow, i) => {
      const category = text(sheetRow.Category);
      const ts = data.expenses
        .filter((e) => e.ExpenseCategory === category && e.ExpenseType === 'Operating'
          && e.Date !== null && e.Date >= period.start && e.Date < period.end)
        .reduce((s, e) => s + expenseTotal(e), 0);
      compare(FAMILY.expenses, section, category, 'Amount',
        num(sheetRow.Amount), ts, TOL.money,
        `${CALC.sheet}!${colA1(cols.Amount!)}${firstRow + i}`);
    });
    assertSection(section);
  });

  /* ================================================================ *
   * 6 · Rent register — 08_RENT_FIXED_COSTS calculated columns.
   * ================================================================ */
  it('agrees on the rent obligation engine, row by row', () => {
    const section = 'Rent register';
    expect(rent.length, '08_RENT_FIXED_COSTS is empty').toBeGreaterThan(0);
    const today = isoToSerial(sheetToday);

    for (const record of rent) {
      const engine = computeRentSchedule(record, today, data.settings.rentDueDays);
      const at = (col: string) =>
        `${SHEETS.RENT}!${(COLUMNS.RENT ?? []).find((c) => c.key === col)?.a1 ?? '?'} (${record.recordId})`;
      compare(FAMILY.rent, section, record.recordId, 'NextDueDate',
        record.nextDueDate ?? '', engine.nextDueDate ?? '', TOL.exact, at('NextDueDate'), true);
      compare(FAMILY.rent, section, record.recordId, 'PaymentStatus',
        record.paymentStatus, engine.paymentStatus, TOL.exact, at('PaymentStatus'), true);
    }
    assertSection(section);
  });

  /* ================================================================ *
   * 7 · Row-level formula columns — payout reconciliation.
   *
   * 04_RESERVATIONS carries six calculated columns. They are the workbook's own answer
   * to "what should this booking have paid us", which is what reconciliation means.
   * ================================================================ */
  it('agrees on every calculated reservation column, booking by booking', async () => {
    const section = 'Payout reconciliation';
    const raw = await client.get(dataRange('RESERVATIONS'));
    const idx = (key: string) => columnIndex('RESERVATIONS', key);
    const byId = new Map(data.reservations.map((b) => [b.BookingID, b]));
    let compared = 0;

    for (const row of raw) {
      const id = text(row[idx('BookingID')]);
      const booking = byId.get(id);
      if (!booking) continue;
      compared++;
      const at = (col: string) =>
        `${SHEETS.RESERVATIONS}!${(COLUMNS.RESERVATIONS ?? []).find((c) => c.key === col)?.a1 ?? '?'} (${id})`;

      compare(FAMILY.bookings, section, id, 'Nights',
        num(row[idx('Nights')]), bookingNights(booking), TOL.count, at('Nights'));
      compare(FAMILY.revenue, section, id, 'GrossBookingValue',
        num(row[idx('GrossBookingValue')]), grossBookingValue(booking), TOL.money,
        at('GrossBookingValue'));
      compare(FAMILY.payout, section, id, 'EstPlatformFee',
        num(row[idx('EstPlatformFee')]), estimatedPlatformFee(booking, data.settings),
        TOL.money, at('EstPlatformFee'));
      compare(FAMILY.payout, section, id, 'ExpectedPayout',
        num(row[idx('ExpectedPayout')]), expectedPayout(booking, data.settings), TOL.money,
        at('ExpectedPayout'));
      compare(FAMILY.payout, section, id, 'PayoutVariance',
        num(row[idx('PayoutVariance')]),
        booking.ActualPayout - expectedPayout(booking, data.settings), TOL.money,
        at('PayoutVariance'));
    }

    expect(compared, 'no reservations to reconcile').toBeGreaterThan(0);
    assertSection(section);
  });

  /* ================================================================ *
   * 8 · Row-level formula columns — revenue and expense totals.
   * ================================================================ */
  it('agrees on every calculated revenue and expense column', async () => {
    const section = 'Row totals';
    const [revRaw, expRaw] = await Promise.all([
      client.get(dataRange('REVENUE')),
      client.get(dataRange('EXPENSES')),
    ]);

    const revById = new Map(data.revenue.map((r) => [r.RevenueID, r]));
    for (const row of revRaw) {
      const id = text(row[columnIndex('REVENUE', 'RevenueID')]);
      const record = revById.get(id);
      if (!record) continue;
      compare(FAMILY.revenue, section, id, 'NetRevenue',
        num(row[columnIndex('REVENUE', 'NetRevenue')]), revenueNet(record), TOL.money,
        `${SHEETS.REVENUE}!NetRevenue (${id})`);
    }

    const expById = new Map(data.expenses.map((e) => [e.ExpenseID, e]));
    for (const row of expRaw) {
      const id = text(row[columnIndex('EXPENSES', 'ExpenseID')]);
      const record = expById.get(id);
      if (!record) continue;
      compare(FAMILY.expenses, section, id, 'TotalAmount',
        num(row[columnIndex('EXPENSES', 'TotalAmount')]), expenseTotal(record), TOL.money,
        `${SHEETS.EXPENSES}!TotalAmount (${id})`);
    }
    assertSection(section);
  });

  /* ================================================================ *
   * 9 · Investor waterfall and the blank/TBD contract.
   * ================================================================ */
  it('agrees on the investor waterfall, and on what "not configured" means', () => {
    const section = 'Investor waterfall';
    const configured = data.settings.investorPoolPct !== null;

    for (const month of series) {
      const i = monthKeys.indexOf(month.monthKey);
      const at = (metric: string) =>
        `${CALC.sheet}!${colA1(CALC.firstMonthCol + i)}${(CALC.monthlyRows as Record<string, number>)[metric]}`;

      if (!configured) {
        // The blank/TBD contract: an unset pool calculates zero, never an assumed rate.
        compare(FAMILY.blankTbd, section, month.monthKey, 'InvestorPoolAmt (TBD)',
          num(monthlyBlock.InvestorPoolAmt?.[i]), 0, TOL.money, at('InvestorPoolAmt'));
        compare(FAMILY.blankTbd, section, month.monthKey, 'ReserveAmt (TBD)',
          num(monthlyBlock.ReserveAmt?.[i]), 0, TOL.money, at('ReserveAmt'));
      }

      // Allocations must reconcile to the pool the workbook computed.
      const allocations = computeInvestorAllocations(data, month.monthKey);
      const allocated = allocations.reduce((s, a) => s + a.calculatedDistribution, 0);
      const sheetPool = num(monthlyBlock.InvestorPoolAmt?.[i]);
      const shareTotal = data.investors
        .filter((inv) => inv.Status === 'Active')
        .reduce((s, inv) => s + inv.ParticipationPct, 0);
      compare(FAMILY.waterfall, section, month.monthKey, 'allocations reconcile to pool',
        sheetPool * shareTotal, allocated, TOL.money, at('InvestorPoolAmt'));
    }

    if (!configured) {
      notCompared.push({
        family: FAMILY.pool,
        metric: 'distribution chain with a live rate',
        reason: 'CFG_INVESTOR_POOL_PCT is TBD in this copy, so the pool, reserve and management-fee comparisons are 0-vs-0. Set a SAMPLE rate in the parity COPY to exercise them.',
      });
    }
    assertSection(section);
  });

  /* ================================================================ *
   * 10 · The eleven required business scenarios.
   *
   * Each must be PRESENT in the copy. An absent scenario is a preparation gap and fails
   * the gate — it is never recorded as a pass.
   * ================================================================ */
  it('exercises all eleven required scenarios, and each is present in the copy', () => {
    const before = rows.length;
    const scenario = (name: ScenarioName, present: boolean, detail: string) => {
      const checks = rows.length - before;
      scenarioResults.push({
        name, present, detail, checks,
        failed: rows.slice(before).filter((r) => !r.pass).length,
      });
    };
    const monthOf = (key: string) => monthKeys.indexOf(key);
    const sheetAt = (metric: string, i: number) => num(monthlyBlock[metric]?.[i]);

    /* 1 — zero revenue period */
    {
      const start = rows.length;
      const month = series.find((m) => m.grossRevenue === 0);
      if (month) {
        const i = monthOf(month.monthKey);
        compare(FAMILY.revenue, 'Scenario', month.monthKey, 'zero revenue · NetRevenue',
          sheetAt('NetRevenue', i), month.netRevenue, TOL.money, `${CALC.sheet} NetRevenue`);
        compare(FAMILY.adr, 'Scenario', month.monthKey, 'zero revenue · ADR is 0 not #DIV/0',
          sheetAt('ADR', i), month.adr, TOL.money, `${CALC.sheet} ADR`);
      }
      scenarioResults.push({
        name: 'zero revenue period', present: Boolean(month),
        detail: month ? `${month.monthKey}` : 'no month in the copy has zero gross revenue',
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 2 — empty month */
    {
      const start = rows.length;
      const month = series.find((m) => m.bookingsCount === 0 && m.operatingExpenses === 0);
      if (month) {
        const i = monthOf(month.monthKey);
        for (const metric of ['NetRevenue', 'OperatingExpenses', 'OperatingProfit'] as const) {
          compare(FAMILY.profit, 'Scenario', month.monthKey, `empty month · ${metric}`,
            sheetAt(metric, i), Number(month[metric === 'NetRevenue' ? 'netRevenue'
              : metric === 'OperatingExpenses' ? 'operatingExpenses' : 'operatingProfit']),
            TOL.money, `${CALC.sheet} ${metric}`);
        }
      }
      scenarioResults.push({
        name: 'empty month', present: Boolean(month),
        detail: month ? month.monthKey : 'every month in the copy has activity',
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 3 — cancellation */
    {
      const start = rows.length;
      const month = series.find((m) => m.cancelledCount > 0);
      if (month) {
        const i = monthOf(month.monthKey);
        compare(FAMILY.cancellations, 'Scenario', month.monthKey, 'cancellation · CancelledCount',
          sheetAt('CancelledCount', i), month.cancelledCount, TOL.count, `${CALC.sheet} CancelledCount`);
        compare(FAMILY.cancellations, 'Scenario', month.monthKey, 'cancellation · rate',
          sheetAt('CancellationRatePct', i), month.cancellationRatePct, TOL.ratio,
          `${CALC.sheet} CancellationRatePct`);
        compare(FAMILY.occupancy, 'Scenario', month.monthKey, 'cancellation · nights excluded',
          sheetAt('OccupiedNights', i), month.occupiedNights, TOL.count, `${CALC.sheet} OccupiedNights`);
      }
      scenarioResults.push({
        name: 'cancellation', present: Boolean(month),
        detail: month ? `${month.monthKey}, ${month.cancelledCount} cancelled`
          : `no cancelled booking in the copy (statuses counted: ${CANCELLED_STATUSES.join(', ')})`,
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 4 — partial payout */
    {
      const start = rows.length;
      const booking = data.reservations.find((b) => {
        const expected = expectedPayout(b, data.settings);
        return b.ActualPayout > 0 && expected - b.ActualPayout > data.settings.payoutToleranceInr;
      });
      // The per-booking comparison already ran in section 7; this records that the
      // condition exists and that its reconciliation columns agreed.
      const failedForBooking = booking
        ? rows.filter((r) => r.subject === booking.BookingID && !r.pass).length
        : 0;
      scenarioResults.push({
        name: 'partial payout', present: Boolean(booking),
        detail: booking
          ? `${booking.BookingID}: expected ${expectedPayout(booking, data.settings).toFixed(2)}, actual ${booking.ActualPayout.toFixed(2)}`
          : 'no booking is short-paid beyond the configured tolerance',
        checks: booking ? 5 : 0, failed: failedForBooking,
      });
      void start;
    }

    /* 5 — expense spike */
    {
      const start = rows.length;
      const active = series.filter((m) => m.operatingExpenses > 0)
        .map((m) => m.operatingExpenses).sort((a, b) => a - b);
      const median = active.length ? active[Math.floor(active.length / 2)]! : 0;
      const month = series.find((m) => median > 0 && m.operatingExpenses > median * 1.5);
      if (month) {
        const i = monthOf(month.monthKey);
        compare(FAMILY.expenses, 'Scenario', month.monthKey, 'expense spike · OperatingExpenses',
          sheetAt('OperatingExpenses', i), month.operatingExpenses, TOL.money,
          `${CALC.sheet} OperatingExpenses`);
        compare(FAMILY.margin, 'Scenario', month.monthKey, 'expense spike · margin',
          sheetAt('OperatingMarginPct', i), month.operatingMarginPct, TOL.ratio,
          `${CALC.sheet} OperatingMarginPct`);
      }
      scenarioResults.push({
        name: 'expense spike', present: Boolean(month),
        detail: month ? `${month.monthKey}: ${month.operatingExpenses.toFixed(0)} vs median ${median.toFixed(0)}`
          : 'no month exceeds 1.5x the median operating expense',
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 6 — misfiled CAPEX */
    {
      const start = rows.length;
      const misfiled = data.expenses.filter((e) => e.ExpenseType === 'CAPEX');
      if (misfiled.length) {
        const key = monthKeyOf(misfiled[0]!.Date ?? 0);
        const month = series.find((m) => m.monthKey === key);
        if (month) {
          const i = monthOf(key);
          // The point of the scenario: a CAPEX-typed row must NOT reach operating profit.
          compare(FAMILY.capex, 'Scenario', key, 'misfiled CAPEX · excluded from OperatingExpenses',
            sheetAt('OperatingExpenses', i), month.operatingExpenses, TOL.money,
            `${CALC.sheet} OperatingExpenses`);
          compare(FAMILY.capex, 'Scenario', key, 'misfiled CAPEX · OperatingProfit',
            sheetAt('OperatingProfit', i), month.operatingProfit, TOL.money,
            `${CALC.sheet} OperatingProfit`);
        }
      }
      scenarioResults.push({
        name: 'misfiled CAPEX', present: misfiled.length > 0,
        detail: misfiled.length
          ? `${misfiled.length} expense row(s) typed CAPEX, e.g. ${misfiled[0]!.ExpenseID}`
          : 'no 06_EXPENSES row carries ExpenseType = CAPEX',
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 7 — negative month */
    {
      const start = rows.length;
      const month = series.find((m) => m.operatingProfit < 0);
      if (month) {
        const i = monthOf(month.monthKey);
        compare(FAMILY.profit, 'Scenario', month.monthKey, 'negative month · OperatingProfit',
          sheetAt('OperatingProfit', i), month.operatingProfit, TOL.money,
          `${CALC.sheet} OperatingProfit`);
        compare(FAMILY.waterfall, 'Scenario', month.monthKey, 'negative month · no distribution',
          sheetAt('InvestorPoolAmt', i), month.investorPoolAmt, TOL.money,
          `${CALC.sheet} InvestorPoolAmt`);
        expect(month.investorPoolAmt, 'a loss produced a positive investor pool')
          .toBeLessThanOrEqual(0);
      }
      scenarioResults.push({
        name: 'negative month', present: Boolean(month),
        detail: month ? `${month.monthKey}: ${month.operatingProfit.toFixed(0)}`
          : 'no month in the copy is loss-making',
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 8 — loss recovery (carry-forward applied after a loss) */
    {
      const start = rows.length;
      const recovery = series.find((m, i) => i > 0 && m.carryForwardApplied !== 0);
      if (recovery) {
        const i = monthOf(recovery.monthKey);
        compare(FAMILY.carryForward, 'Scenario', recovery.monthKey, 'loss recovery · CarryForwardApplied',
          sheetAt('CarryForwardApplied', i), recovery.carryForwardApplied, TOL.money,
          `${CALC.sheet} CarryForwardApplied`);
        compare(FAMILY.carryForward, 'Scenario', recovery.monthKey, 'loss recovery · CarryForwardBalance',
          sheetAt('CarryForwardBalance', i), recovery.carryForwardBalance, TOL.money,
          `${CALC.sheet} CarryForwardBalance`);
        compare(FAMILY.waterfall, 'Scenario', recovery.monthKey, 'loss recovery · DistributableProfit',
          sheetAt('DistributableProfit', i), recovery.distributableProfit, TOL.money,
          `${CALC.sheet} DistributableProfit`);
      }
      scenarioResults.push({
        name: 'loss recovery', present: Boolean(recovery),
        detail: recovery ? `${recovery.monthKey}: ${recovery.carryForwardApplied.toFixed(0)} applied`
          : 'no month applies a carried-forward loss (needs a loss month followed by a profitable one, with the pool configured)',
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 9 — multiple investors */
    {
      const start = rows.length;
      const active = data.investors.filter((i) => i.Status === 'Active');
      if (active.length >= 2) {
        const month = series.find((m) => m.investorPoolAmt > 0) ?? series[0]!;
        const allocations = computeInvestorAllocations(data, month.monthKey);
        const i = monthOf(month.monthKey);
        compare(FAMILY.waterfall, 'Scenario', month.monthKey, 'multiple investors · allocations sum to pool',
          sheetAt('InvestorPoolAmt', i) * active.reduce((s, x) => s + x.ParticipationPct, 0),
          allocations.reduce((s, a) => s + a.calculatedDistribution, 0), TOL.money,
          `${CALC.sheet} InvestorPoolAmt`);
        // Isolation: one investor's filtered view returns only that investor.
        const first = active[0]!;
        const filtered = computeInvestorAllocations(data, month.monthKey, { investorId: first.InvestorID });
        expect(filtered.map((a) => a.investorId)).toEqual([first.InvestorID]);
      }
      scenarioResults.push({
        name: 'multiple investors', present: active.length >= 2,
        detail: `${active.length} active investor(s)`,
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 10 — property filtering */
    {
      const start = rows.length;
      const period = monthPeriod(reportMonth.monthKey);
      const all = computeByProperty(data, period);
      const month = series.find((m) => m.monthKey === reportMonth.monthKey);
      const i = monthOf(reportMonth.monthKey);
      if (month && all.length) {
        // Per-property net revenue must sum back to the portfolio figure the sheet holds.
        compare(FAMILY.property, 'Scenario', reportMonth.monthKey, 'property filtering · sums to portfolio',
          sheetAt('NetRevenue', i), all.reduce((s, p) => s + p.netRevenue, 0), TOL.money,
          `${CALC.sheet} NetRevenue`);
        const one = all[0]!;
        const filtered = computeByProperty(data, period, { propertyId: one.propertyId });
        expect(filtered.map((p) => p.propertyId)).toEqual([one.propertyId]);
        expect(filtered[0]!.netRevenue).toBeCloseTo(one.netRevenue, 6);
      }
      scenarioResults.push({
        name: 'property filtering', present: all.length > 1,
        detail: `${all.length} propert${all.length === 1 ? 'y' : 'ies'} in the copy`,
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    /* 11 — platform filtering */
    {
      const start = rows.length;
      const period = monthPeriod(reportMonth.monthKey);
      const all = computeByPlatform(data, period);
      const used = all.filter((p) => p.grossRevenue !== 0 || p.bookings !== 0);
      const i = monthOf(reportMonth.monthKey);
      if (used.length) {
        compare(FAMILY.platform, 'Scenario', reportMonth.monthKey, 'platform filtering · sums to portfolio',
          sheetAt('GrossRevenue', i), all.reduce((s, p) => s + p.grossRevenue, 0), TOL.money,
          `${CALC.sheet} GrossRevenue`);
        const one = used[0]!;
        const filtered = computeByPlatform(data, period, { platform: one.platform });
        expect(filtered.map((p) => p.platform)).toEqual([one.platform]);
      }
      scenarioResults.push({
        name: 'platform filtering', present: used.length > 1,
        detail: `${used.length} platform(s) with activity in ${reportMonth.monthKey}`,
        checks: rows.length - start, failed: rows.slice(start).filter((r) => !r.pass).length,
      });
    }

    void scenario;
    const missing = scenarioResults.filter((s) => !s.present);
    expect(
      missing.map((m) => `${m.name} — ${m.detail}`),
      'the parity copy does not contain every required scenario. An absent scenario is a preparation gap, not a pass.',
    ).toEqual([]);
    assertSection('Scenario');
  });

  /* ================================================================ *
   * Never wrote. Then publish the report.
   * ================================================================ */
  it('never wrote to the spreadsheet, and every required family was covered', () => {
    expect(process.env.PARITY_ALLOW_WRITES).toBeUndefined();

    const covered = new Set(rows.map((r) => r.family));
    const uncovered = Object.values(FAMILY).filter((f) => !covered.has(f));
    expect(uncovered, 'metric families with no LIVE comparison at all').toEqual([]);

    const byFamily = Object.values(FAMILY).map((family) => {
      const familyRows = rows.filter((r) => r.family === family);
      return { family, checks: familyRows.length, failed: familyRows.filter((r) => !r.pass).length };
    });
    const bySection = [...new Set(rows.map((r) => r.section))].map((section) => {
      const sectionRows = rows.filter((r) => r.section === section);
      return { section, checks: sectionRows.length, failed: sectionRows.filter((r) => !r.pass).length };
    });

    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      spreadsheetId: `…${SHEET_ID!.slice(-6)}`,   // never log the full id
      spreadsheetTitle: title,
      timeZone,
      sheetToday,
      reportMonth: reportMonth.monthKey,
      months: monthKeys,
      total: rows.length,
      failed: rows.filter((r) => !r.pass).length,
      byFamily,
      bySection,
      scenarios: scenarioResults,
      notCompared,
      rows,
    }, null, 2));
  });
});

/** 1 → 'A'. Block widths and column positions come from the contract, never literals. */
function colA1(index: number): string {
  let out = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}

describe.skipIf(CREDENTIALS_PRESENT)('LIVE parity (not run)', () => {
  it('reports NOT RUN when credentials are absent', () => {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      status: 'NOT RUN',
      reason: `LIVE parity is not configured. Still needed: ${PARITY_ENV.missing.join(', ')}.`,
      required: 'Follow docs/LIVE_PARITY_RUNBOOK.md — deploy the V1 workbook, make a COPY, share it with a service account as Viewer, set PARITY_SHEET_ID and PARITY_SERVICE_ACCOUNT_FILE, then run `npm run parity`.',
      // Names only — the structured `scenarios` array is written by a real run, and the
      // report must not mistake a list of names for evidence that they were found.
      families: Object.values(FAMILY),
      requiredScenarios: SCENARIOS,
      total: 0, failed: 0, byFamily: [], bySection: [], scenarios: [], notCompared: [], rows: [],
    }, null, 2));
    expect(CREDENTIALS_PRESENT).toBe(false);
    // Guard against the coverage list silently shrinking while the suite cannot run.
    expect(Object.values(FAMILY)).toHaveLength(22);
    expect(SCENARIOS).toHaveLength(11);
    expect(OCCUPANCY_STATUSES.length + CANCELLED_STATUSES.length).toBeGreaterThan(0);
  });
});
