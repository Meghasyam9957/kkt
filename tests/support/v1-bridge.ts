/**
 * V1 BRIDGE — the independent side of the parity gate.
 *
 * Loads the real V1 Apps Script modules into a sandboxed mock of the Spreadsheet API,
 * writes a fixture into that mock workbook, and then asks **V1's own JavaScript
 * recomputation** (`qaRevNet90_`, `qaOpex90_`, `qaOccNights90_`, `runQaChecks`) for its
 * numbers.
 *
 * Why this is a real parity check and not self-confirmation: those V1 routines were
 * written independently of this TypeScript engine, they read the raw input columns
 * directly, and in V1 they exist precisely to cross-check the workbook's own formulas.
 * Agreement between them and the TS engine means two independent implementations of the
 * same V1 definitions produce identical numbers on identical data.
 *
 * Scope limit, stated plainly: the mock has no formula evaluator, so this validates the
 * TS engine against V1's *JavaScript* implementation of the definitions — not against
 * Google's formula engine. LIVE parity against a real spreadsheet remains required and is
 * implemented in `tests/parity.live.test.ts`.
 *
 * The V1 project is opened READ-ONLY. Nothing here writes to `homestay-ops/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serialToDate, monthKeyToSerial, type Serial } from '@/lib/shared/dates';
import type { WorkbookData } from '@/lib/shared/domain';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V1_ROOT = path.resolve(HERE, '..', '..', '..', 'homestay-ops');
const V1_SRC = path.join(V1_ROOT, 'src');
const require = createRequire(import.meta.url);

export interface V1QaRow {
  test: string;
  expected: number | string;
  actual: number | string;
  result: string;
  detail: string;
}

export interface V1MonthNumbers {
  netRevenue: number;
  operatingExpenses: number;
  operatingProfit: number;
  occupiedNights: number;
  roomGrossRevenue: number;
}

export class V1Bridge {
  private ctx: vm.Context;
  private env: any;
  /**
   * The SANDBOX's Date constructor.
   *
   * V1 guards values with `v instanceof Date`. A Date built in this (Node) realm is not
   * an instance of the vm realm's Date, so fixture dates constructed here would be
   * silently rejected by V1 and every cross-check would compare against zero. Dates
   * handed to V1 must therefore be built with V1's own constructor.
   */
  private SandboxDate!: DateConstructor;

  constructor() {
    const { makeEnv } = require(path.join(V1_ROOT, 'harness', 'mock.js'));
    this.env = makeEnv();
    this.ctx = vm.createContext({
      SpreadsheetApp: this.env.SpreadsheetApp,
      Charts: this.env.Charts,
      Utilities: this.env.Utilities,
      Logger: { log: () => {} },
      console: { log: () => {}, error: () => {}, warn: () => {} },
    });
    this.SandboxDate = vm.runInContext('Date', this.ctx) as DateConstructor;

    const first = ['00_constants.gs', '01_engine.gs'];
    const files = first.concat(
      fs.readdirSync(V1_SRC).filter((f) => f.endsWith('.gs') && !first.includes(f)).sort(),
    );
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(V1_SRC, file), 'utf8'), this.ctx, { filename: file });
    }
    this.run('setupWorkbook()');
  }

  /** Serial → local-midnight Date built in the SANDBOX realm (see SandboxDate). */
  private date(serial: Serial): Date {
    const utc = serialToDate(serial);
    return new this.SandboxDate(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }

  private run<T = unknown>(expression: string): T {
    return vm.runInContext(expression, this.ctx) as T;
  }

  private get g(): any {
    return this.ctx as any;
  }

  /** Write a fixture into the mock workbook using V1's own row writer. */
  loadFixture(data: WorkbookData): void {
    const g = this.g;
    const SHEETS = g.SHEETS;
    const ctxObj = g.newCtx_(this.env.ss);

    // Reset every transactional sheet so fixtures never inherit the previous scenario.
    for (const key of ['RESERVATIONS', 'REVENUE', 'EXPENSES', 'CAPEX', 'RENT', 'CASHFLOW',
      'HOUSEKEEPING', 'MAINTENANCE', 'INVENTORY', 'ASSETS', 'INVESTORS'] as const) {
      g.clearInputRows_(ctxObj, SHEETS[key]);
    }
    const distCols = g.COLUMNS[SHEETS.DIST];
    const distSheet = this.env.ss.getSheetByName(SHEETS.DIST);
    for (let i = 0; i < distCols.length; i++) {
      if (distCols[i].role === 'calc') continue;
      distSheet.getRange(g.DIST_TABLE.firstRow, i + 1, g.DIST_TABLE.rows, 1).clearContent();
    }

    const d = (s: Serial | null) => (s === null ? '' : this.date(s));

    // --- Business rules (named ranges, exactly where V1 put them) ---
    const setNamed = (name: string, value: unknown) => {
      const range = this.env.ss.getRangeByName(name);
      if (!range) throw new Error(`V1 named range missing: ${name}`);
      if (value === null || value === undefined) range.clearContent();
      else range.setValue(value);
    };
    const s = data.settings;
    setNamed('CFG_FY_START', this.date(s.fyStart));
    setNamed('CFG_INVESTOR_POOL_PCT', s.investorPoolPct);
    setNamed('CFG_OPERATOR_POOL_PCT', s.operatorPoolPct);
    setNamed('CFG_RESERVE_PCT', s.reservePct);
    setNamed('CFG_MGMT_FEE_PCT', s.mgmtFeePct);
    setNamed('CFG_LOSS_TREATMENT', s.lossTreatment);
    setNamed('CFG_PAYOUT_TOLERANCE', s.payoutToleranceInr);

    // --- Platform commissions (TBL_PLATFORMS rows) ---
    const names = this.env.ss.getRangeByName('TBL_PLATFORM_NAMES');
    const comms = this.env.ss.getRangeByName('TBL_PLATFORM_COMM');
    const platformNames = Object.keys(s.platformCommission);
    for (let i = 0; i < names.getNumRows(); i++) {
      const name = platformNames[i];
      if (name === undefined) {
        names.getCell(i + 1, 1).setValue('');
        comms.getCell(i + 1, 1).setValue('');
      } else {
        names.getCell(i + 1, 1).setValue(name);
        const c = s.platformCommission[name];
        comms.getCell(i + 1, 1).setValue(c === null ? '' : c);
      }
    }

    // --- Master + transactional rows ---
    g.clearInputRows_(ctxObj, SHEETS.PROPERTIES);
    g.writeRows_(ctxObj, SHEETS.PROPERTIES, data.properties.map((p) => ({
      PropertyID: p.PropertyID, Unit: p.Unit, BHKType: p.BHKType,
      MaxGuests: p.MaxGuests, PropertyStatus: p.PropertyStatus, ListingStatus: p.ListingStatus,
    })));

    g.writeRows_(ctxObj, SHEETS.RESERVATIONS, data.reservations.map((b) => ({
      BookingID: b.BookingID, Platform: b.Platform, PlatformResID: b.PlatformResID,
      PropertyID: b.PropertyID, BookingStatus: b.BookingStatus, GuestName: b.GuestName,
      Adults: b.Adults, Children: b.Children,
      CheckInDate: d(b.CheckInDate), CheckOutDate: d(b.CheckOutDate),
      BaseRate: b.BaseRate, RoomRevenue: b.RoomRevenue, CleaningFee: b.CleaningFee,
      ExtraGuestFee: b.ExtraGuestFee, OtherCharges: b.OtherCharges, Discount: b.Discount,
      Taxes: b.Taxes, PlatformFee: b.PlatformFee, OtherDeductions: b.OtherDeductions,
      ActualPayout: b.ActualPayout, PayoutDate: d(b.PayoutDate),
    })));

    g.writeRows_(ctxObj, SHEETS.REVENUE, data.revenue.map((r) => ({
      RevenueID: r.RevenueID, BookingID: r.BookingID, PropertyID: r.PropertyID,
      Date: d(r.Date), RevenueType: r.RevenueType, Platform: r.Platform,
      GrossAmount: r.GrossAmount, Discount: r.Discount, Tax: r.Tax,
      PlatformFee: r.PlatformFee, OtherDeduction: r.OtherDeduction, PayoutStatus: r.PayoutStatus,
    })));

    g.writeRows_(ctxObj, SHEETS.EXPENSES, data.expenses.map((e) => ({
      ExpenseID: e.ExpenseID, Date: d(e.Date), PropertyID: e.PropertyID,
      ExpenseCategory: e.ExpenseCategory, ExpenseSubcategory: e.ExpenseSubcategory,
      Amount: e.Amount, Tax: e.Tax, PaymentStatus: e.PaymentStatus, ExpenseType: e.ExpenseType,
    })));

    g.writeRows_(ctxObj, SHEETS.CAPEX, data.capex.map((c) => ({
      CapexID: c.CapexID, PropertyID: c.PropertyID, Date: d(c.Date),
      Category: c.Category, Quantity: c.Quantity, UnitCost: c.UnitCost,
    })));

    g.writeRows_(ctxObj, SHEETS.CASHFLOW, data.cashflow.map((c) => ({
      TxnID: c.TxnID, Date: d(c.Date), Type: c.Type, PropertyID: c.PropertyID,
      MoneyIn: c.MoneyIn, MoneyOut: c.MoneyOut, ReconStatus: c.ReconStatus,
    })));

    g.writeRows_(ctxObj, SHEETS.INVESTORS, data.investors.map((i) => ({
      InvestorID: i.InvestorID, InvestorName: i.InvestorName,
      InvestmentAmount: i.InvestmentAmount, ParticipationPct: i.ParticipationPct, Status: i.Status,
    })));

    g.writeRows_(ctxObj, SHEETS.DIST, data.distributions.map((x) => ({
      Period: d(x.Period), InvestorID: x.InvestorID,
      PaidAmount: x.PaidAmount, PaidDate: d(x.PaidDate),
    })), g.DIST_TABLE.firstRow);
  }

  /**
   * V1's own recomputation for one month, via the granular helpers.
   * Takes the month as a parameter — no shared reporting-month state is touched.
   */
  monthNumbers(monthKey: string): V1MonthNumbers {
    const g = this.g;
    const ctxObj = g.newCtx_(this.env.ss);
    const m = this.date(monthKeyToSerial(monthKey));

    const revVals = g.readTable90_(ctxObj, g.SHEETS.REVENUE);
    const expVals = g.readTable90_(ctxObj, g.SHEETS.EXPENSES);
    const resVals = g.readTable90_(ctxObj, g.SHEETS.RESERVATIONS);

    const netRevenue = g.qaRevNet90_(ctxObj, revVals, m);
    const operatingExpenses = g.qaOpex90_(ctxObj, expVals, m);
    return {
      netRevenue,
      operatingExpenses,
      operatingProfit: netRevenue - operatingExpenses,
      occupiedNights: g.qaOccNights90_(ctxObj, resVals, m),
      roomGrossRevenue: g.qaRoomGross90_(ctxObj, revVals, m),
    };
  }

  /** V1's expected-payout recomputation for a booking id (OTA reconciliation parity). */
  expectedPayout(bookingId: string): number {
    const g = this.g;
    const ctxObj = g.newCtx_(this.env.ss);
    const comm = g.commMap90_(ctxObj);
    const rows = g.readTable90_(ctxObj, g.SHEETS.RESERVATIONS);
    for (const row of rows) {
      if (String(g.cell90_(ctxObj, g.SHEETS.RESERVATIONS, row, 'BookingID') ?? '') === bookingId) {
        return g.qaExpPayout90_(ctxObj, row, comm);
      }
    }
    throw new Error(`V1 bridge: booking not found: ${bookingId}`);
  }

  /**
   * Full V1 QA pass (10 independent recomputations) for one month.
   *
   * This sets the reporting-month cell **in the local in-memory mock** because V1's QA
   * entry point reads it. That is a test-harness action against a throwaway copy; the
   * production adapter forbids that write outright (Decision D1, enforced in client.ts).
   */
  runQa(monthKey: string): V1QaRow[] {
    const g = this.g;
    this.env.ss.getRangeByName('CFG_REPORT_MONTH').setValue(this.date(monthKeyToSerial(monthKey)));
    this.run('runQaChecks()');

    const qaSheet = this.env.ss.getSheetByName(g.SHEETS.QA);
    const firstRow = g.QA.SCRIPT_FIRST_ROW;
    const rowCount = g.QA.SCRIPT_LAST_ROW - firstRow + 1;
    const values = qaSheet.getRange(firstRow, 1, rowCount, 5).getValues();
    return values
      .filter((r: unknown[]) => String(r[0] ?? '') !== '')
      .map((r: unknown[]) => ({
        test: String(r[0]),
        expected: r[1] as number | string,
        actual: r[2] as number | string,
        result: String(r[3] ?? ''),
        detail: String(r[4] ?? ''),
      }));
  }

  /** Value V1 computed for a named QA test, or undefined when that test did not run. */
  qaExpected(rows: V1QaRow[], testName: string): number | undefined {
    const row = rows.find((r) => r.test === testName);
    return typeof row?.expected === 'number' ? row.expected : undefined;
  }
}
