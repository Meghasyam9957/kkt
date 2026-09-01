import '@/lib/server/only';
/**
 * Repositories — the only place sheet rows become domain objects.
 *
 * Every column is addressed through the generated contract, so a column inserted in V1
 * cannot silently misalign a field here. Writes go through `buildInputRow`, which drops
 * `role: 'calc'` columns by construction — the app physically cannot overwrite a
 * workbook formula.
 */
import {
  SHEETS, COLUMNS, DATA_ROW, SHEET_META, dataRange, columnIndex, inputColumns,
  monthlyBlockRange, CALC, type SheetKey,
} from '@/lib/contract/contract.generated';
import type { GoogleSheetsClient, Row, Cell } from '../client';
import { toSerial, n as num, serialToIso, monthKeyOf, type Serial } from '@/lib/shared/dates';
import type {
  PropertyRecord, ReservationRecord, RevenueRecord, ExpenseRecord, CapexRecord,
  CashFlowRecord, InvestorRecord, DistributionRecord, BusinessSettings, WorkbookData,
  BookingStatus, MaintenanceTicket, HousekeepingTask, InventoryItem, OperationsData,
  RentRecord,
} from '@/lib/shared/domain';
import { BRAND } from '@/lib/shared/brand';

/* ------------------------------------------------------------------ *
 * Row helpers
 * ------------------------------------------------------------------ */

const str = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v).trim());

/** The report-month-dependent 99_CALC blocks, from the generated contract. */
const RM = CALC.reportMonthDependent;

/** 1 → 'A', 27 → 'AA'. Block widths come from the contract, not from literals. */
function colLetter(index: number): string {
  let out = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}

/** Typed accessor bound to one sheet's column layout. */
function reader(sheet: SheetKey, row: Row) {
  return {
    text: (key: string) => str(row[columnIndex(sheet, key)]),
    num: (key: string) => num(row[columnIndex(sheet, key)]),
    date: (key: string): Serial | null => toSerial(row[columnIndex(sheet, key)]),
    /**
     * A checkbox column. Returns `undefined` for a BLANK cell rather than false: nobody
     * recorded it is not the same claim as recorded as no, and only the caller can decide
     * how to present the difference.
     */
    bool: (key: string): boolean | undefined => {
      const value = row[columnIndex(sheet, key)];
      if (value === null || value === undefined || value === '') return undefined;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(text)) return true;
      if (['false', 'no', 'n', '0'].includes(text)) return false;
      return undefined;
    },
    /** Text, but `undefined` rather than '' when the cell is blank — see `bool`. */
    optionalText: (key: string): string | undefined => {
      const text = str(row[columnIndex(sheet, key)]);
      return text === '' ? undefined : text;
    },
  };
}

/** Rows whose identifier column is blank are spare template rows, not data. */
function withId(sheet: SheetKey, rows: Row[], idKey: string): Row[] {
  const idx = columnIndex(sheet, idKey);
  return rows.filter((r) => str(r[idx]) !== '');
}

/**
 * Build a sheet row from a partial domain record, INPUT columns only.
 * Calculated columns are emitted as `null` so the workbook's ARRAYFORMULA keeps ownership
 * of them — the write literally cannot carry a value for a formula cell.
 */
export function buildInputRow(sheet: SheetKey, values: Record<string, unknown>): Row {
  const cols = COLUMNS[sheet] ?? [];
  const writable = new Set(inputColumns(sheet).map((c) => c.key));
  for (const key of Object.keys(values)) {
    if (!writable.has(key)) {
      throw new Error(
        `Refusing to write ${sheet}.${key}: it is a calculated column owned by the V1 workbook.`,
      );
    }
  }
  return cols.map((c) => {
    if (c.role === 'calc') return null;
    const v = values[c.key];
    return v === undefined ? null : (v as Cell);
  });
}

/* ------------------------------------------------------------------ *
 * Repository base
 * ------------------------------------------------------------------ */

export abstract class SheetRepository<T> {
  constructor(protected readonly client: GoogleSheetsClient, protected readonly sheet: SheetKey) {}

  /** The full prepared data range for this sheet, e.g. `'04_RESERVATIONS'!A4:AP703`. */
  get range(): string {
    return dataRange(this.sheet);
  }

  protected abstract map(row: Row): T;
  protected abstract get idKey(): string;

  async readAll(): Promise<T[]> {
    const rows = await this.client.get(this.range);
    return withId(this.sheet, rows, this.idKey).map((r) => this.map(r));
  }

  /** Parse rows already fetched in a batch — avoids a second round trip. */
  fromRows(rows: Row[]): T[] {
    return withId(this.sheet, rows, this.idKey).map((r) => this.map(r));
  }

  /** Every identifier currently in the sheet — the floor the ID allocator must clear. */
  async allIds(): Promise<string[]> {
    const rows = await this.client.get(this.range);
    const idIdx = columnIndex(this.sheet, this.idKey);
    return rows.map((r) => str(r[idIdx])).filter((id) => id !== '');
  }

  async append(records: Record<string, unknown>[]): Promise<{ updatedRange: string; updatedRows: number }> {
    return this.client.append(this.sheet, records.map((r) => buildInputRow(this.sheet, r)));
  }

  /**
   * Patch INPUT cells of the row carrying `id`. Calculated cells are never touched.
   * `where` narrows the match for sheets whose ID column alone is not unique
   * (12_INVESTOR_DISTRIBUTIONS is keyed by InvestorID *and* Period).
   */
  async updateById(
    id: string, patch: Record<string, unknown>, where?: (row: Row) => boolean,
  ): Promise<number> {
    const rows = await this.client.get(this.range);
    const idIdx = columnIndex(this.sheet, this.idKey);
    const offset = rows.findIndex((r) => str(r[idIdx]) === id && (!where || where(r)));
    if (offset < 0) throw new Error(`${this.sheet} row not found: ${id}`);

    const sheetName = SHEET_META[this.sheet].name;
    const rowNumber = DATA_ROW + offset;
    const writable = new Set(inputColumns(this.sheet).map((c) => c.key));
    const edits = Object.entries(patch).map(([key, value]) => {
      if (!writable.has(key)) {
        throw new Error(`Refusing to write ${this.sheet}.${key}: calculated column.`);
      }
      const col = (COLUMNS[this.sheet] ?? []).find((c) => c.key === key)!;
      return { range: `'${sheetName}'!${col.a1}${rowNumber}`, values: [[value as Cell]] };
    });
    await this.client.batchUpdate(edits);
    return rowNumber;
  }

  /* ================================================================ *
   * VERIFIED WRITES (Phase B2) — the only methods the mutation pipeline calls.
   *
   * Two facts about V1's grids shape this:
   *   1. Every table sheet is PREPARED: ~700 formatted rows with validation, and calc
   *      columns ARRAYFORMULA-filled. `values.append` decides its own landing row from
   *      Google's table detection, which against that grid is unproven — so creates
   *      target the FIRST BLANK INPUT ROW (blank ID cell inside the prepared range) with
   *      an exact `batchUpdate`, never an append.
   *   2. A human may sort or edit the open workbook mid-write. Every write is therefore
   *      verified by RE-READING the row and checking the ID cell still carries the
   *      expected identifier — a row that moved fails as ROW_MOVED (one relocate retry),
   *      never a blind write to a row number.
   * ================================================================ */

  /**
   * Create one record at the first blank input row, then verify it round-trips.
   * Returns the row number and the verified cell map. Throws SheetWriteVerifyError.
   */
  async createRowVerified(record: Record<string, unknown>): Promise<VerifiedWrite> {
    // buildInputRow both whitelists (throws on any calc/unknown key) and lays the row out.
    const rowValues = buildInputRow(this.sheet, record);
    const id = str(record[this.idKey] as Cell);
    if (!id) throw new Error(`${this.sheet} create requires ${this.idKey}`);

    for (let attempt = 0; attempt < 2; attempt++) {
      const rowNumber = await this.firstBlankInputRow();
      const sheetName = SHEET_META[this.sheet].name;
      // One edit per non-null INPUT cell — calc cells are not even addressed, so a
      // formula can never be overwritten by a blank.
      const edits = (COLUMNS[this.sheet] ?? [])
        .map((col, i) => ({ col, value: rowValues[i] }))
        .filter(({ col, value }) => col.role !== 'calc' && value !== null && value !== undefined)
        .map(({ col, value }) => ({
          range: `'${sheetName}'!${col.a1}${rowNumber}`,
          values: [[value as Cell]],
        }));
      await this.client.batchUpdate(edits);
      await this.client.flush();

      const verify = await this.verifyRow(rowNumber, id, record);
      if (verify.ok) return { rowNumber, cells: verify.cells };
      if (verify.reason === 'ROW_MOVED' && attempt === 0) continue;   // relocate once
      throw new SheetWriteVerifyError(verify.reason, verify.detail);
    }
    /* istanbul ignore next -- unreachable: the loop returns or throws */
    throw new SheetWriteVerifyError('ROW_MOVED', 'relocation retry exhausted');
  }

  /**
   * Patch INPUT cells of the row carrying `id`, verified: the ID cell is re-checked
   * after the write and every patched cell must round-trip.
   */
  async updateByIdVerified(
    id: string, patch: Record<string, unknown>, where?: (row: Row) => boolean,
  ): Promise<VerifiedWrite> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const rowNumber = await this.updateById(id, patch, where);
      await this.client.flush();
      const verify = await this.verifyRow(rowNumber, id, patch);
      if (verify.ok) return { rowNumber, cells: verify.cells };
      if (verify.reason === 'ROW_MOVED' && attempt === 0) continue;   // relocate + rewrite once
      throw new SheetWriteVerifyError(verify.reason, verify.detail);
    }
    /* istanbul ignore next */
    throw new SheetWriteVerifyError('ROW_MOVED', 'relocation retry exhausted');
  }

  /** First row inside the prepared data range whose ID cell is blank. */
  private async firstBlankInputRow(): Promise<number> {
    const idCol = (COLUMNS[this.sheet] ?? []).find((c) => c.key === this.idKey)!;
    const meta = SHEET_META[this.sheet];
    const sheetName = meta.name;
    const lastRow = meta.lastDataRow ?? DATA_ROW + 696;
    const column = await this.client.get(`'${sheetName}'!${idCol.a1}${DATA_ROW}:${idCol.a1}${lastRow}`);
    for (let i = 0; i < lastRow - DATA_ROW + 1; i++) {
      if (str((column[i] ?? [])[0]) === '') return DATA_ROW + i;
    }
    throw new SheetWriteVerifyError(
      'SHEET_FULL',
      `${sheetName} has no blank input row left in its prepared range (${lastRow - DATA_ROW + 1} rows). ` +
      'Extend the prepared range in the workbook before creating more records.',
    );
  }

  /** Re-read one row; require the expected ID and that each written cell round-trips. */
  private async verifyRow(
    rowNumber: number, id: string, written: Record<string, unknown>,
  ): Promise<{ ok: true; cells: Record<string, Cell> } | { ok: false; reason: VerifyFailure; detail: string }> {
    const cols = COLUMNS[this.sheet] ?? [];
    const meta = SHEET_META[this.sheet];
    const last = cols[cols.length - 1]!;
    const rows = await this.client.get(`'${meta.name}'!A${rowNumber}:${last.a1}${rowNumber}`);
    const row = rows[0] ?? [];

    const foundId = str(row[columnIndex(this.sheet, this.idKey)]);
    if (foundId !== id) {
      return {
        ok: false, reason: 'ROW_MOVED',
        detail: `expected ${this.idKey}=${id} at row ${rowNumber}, found "${foundId}"`,
      };
    }

    const cells: Record<string, Cell> = {};
    for (const col of cols) cells[col.key] = (row[col.index - 1] ?? null) as Cell;

    for (const [key, sent] of Object.entries(written)) {
      if (sent === null || sent === undefined) continue;
      const got = cells[key];
      if (!cellsRoundTrip(sent, got)) {
        return {
          ok: false, reason: 'VERIFY_MISMATCH',
          detail: `${this.sheet}.${key} at row ${rowNumber}: sent ${JSON.stringify(sent)}, read back ${JSON.stringify(got)}`,
        };
      }
    }
    return { ok: true, cells };
  }
}

export type VerifyFailure = 'ROW_MOVED' | 'VERIFY_MISMATCH' | 'SHEET_FULL';

export class SheetWriteVerifyError extends Error {
  constructor(public readonly reason: VerifyFailure, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'SheetWriteVerifyError';
  }
}

export interface VerifiedWrite {
  rowNumber: number;
  /** The row as the workbook now holds it — calc cells included, for the response. */
  cells: Record<string, Cell>;
}

/**
 * Does a value we sent equal the value the workbook handed back?
 * Numbers compare numerically (the API may return 43000 for "43000"); everything else
 * compares as trimmed text. Dates are written as serial numbers by the schema layer,
 * so they take the numeric path. Booleans round-trip as booleans or TRUE/FALSE text.
 */
export function cellsRoundTrip(sent: unknown, got: Cell | undefined): boolean {
  if (got === undefined) return false;
  if (typeof sent === 'number' || (typeof sent === 'string' && sent !== '' && !Number.isNaN(Number(sent)))) {
    const sentNum = Number(sent);
    const gotNum = typeof got === 'number' ? got : Number(String(got));
    if (Number.isFinite(sentNum) && Number.isFinite(gotNum)) {
      return Math.abs(sentNum - gotNum) < 1e-9;
    }
  }
  if (typeof sent === 'boolean') {
    if (typeof got === 'boolean') return got === sent;
    return String(got).trim().toUpperCase() === (sent ? 'TRUE' : 'FALSE');
  }
  return String(sent).trim() === String(got ?? '').trim();
}

/* ------------------------------------------------------------------ *
 * Concrete repositories
 * ------------------------------------------------------------------ */

export class PropertyRepository extends SheetRepository<PropertyRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'PROPERTIES'); }
  protected get idKey() { return 'PropertyID'; }
  protected map(row: Row): PropertyRecord {
    const r = reader('PROPERTIES', row);
    return {
      PropertyID: r.text('PropertyID'), Unit: r.text('Unit'), BHKType: r.text('BHKType'),
      MaxGuests: r.num('MaxGuests'), PropertyStatus: r.text('PropertyStatus'),
      ListingStatus: r.text('ListingStatus'),
    };
  }
}

export class ReservationRepository extends SheetRepository<ReservationRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'RESERVATIONS'); }
  protected get idKey() { return 'BookingID'; }
  protected map(row: Row): ReservationRecord {
    const r = reader('RESERVATIONS', row);
    return {
      BookingID: r.text('BookingID'), Platform: r.text('Platform'), PlatformResID: r.text('PlatformResID'),
      PropertyID: r.text('PropertyID'), BookingDate: r.date('BookingDate'), BookingStatus: r.text('BookingStatus') as BookingStatus,
      GuestName: r.text('GuestName'), Adults: r.num('Adults'), Children: r.num('Children'),
      CheckInDate: r.date('CheckInDate'), CheckOutDate: r.date('CheckOutDate'),
      BaseRate: r.num('BaseRate'), RoomRevenue: r.num('RoomRevenue'), CleaningFee: r.num('CleaningFee'),
      ExtraGuestFee: r.num('ExtraGuestFee'), OtherCharges: r.num('OtherCharges'), Discount: r.num('Discount'),
      Taxes: r.num('Taxes'), PlatformFee: r.num('PlatformFee'), OtherDeductions: r.num('OtherDeductions'),
      ActualPayout: r.num('ActualPayout'), PayoutDate: r.date('PayoutDate'),
      // Front-office detail. Absent cells stay `undefined` so the screen can say
      // "not recorded" rather than inventing a negative nobody asserted.
      CheckInTime: r.optionalText('CheckInTime'), CheckOutTime: r.optionalText('CheckOutTime'),
      EarlyCheckIn: r.bool('EarlyCheckIn'), LateCheckout: r.bool('LateCheckout'),
      GuestVerification: r.optionalText('GuestVerification'),
      DamageReport: r.optionalText('DamageReport'),
      MaintenanceRequired: r.bool('MaintenanceRequired'),
      Notes: r.optionalText('Notes'),
    };
  }
}

export class RevenueRepository extends SheetRepository<RevenueRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'REVENUE'); }
  protected get idKey() { return 'RevenueID'; }
  protected map(row: Row): RevenueRecord {
    const r = reader('REVENUE', row);
    return {
      RevenueID: r.text('RevenueID'), BookingID: r.text('BookingID'), PropertyID: r.text('PropertyID'),
      Date: r.date('Date'), RevenueType: r.text('RevenueType'), Platform: r.text('Platform'),
      GrossAmount: r.num('GrossAmount'), Discount: r.num('Discount'), Tax: r.num('Tax'),
      PlatformFee: r.num('PlatformFee'), OtherDeduction: r.num('OtherDeduction'),
      PayoutStatus: r.text('PayoutStatus'),
    };
  }
}

export class ExpenseRepository extends SheetRepository<ExpenseRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'EXPENSES'); }
  protected get idKey() { return 'ExpenseID'; }
  protected map(row: Row): ExpenseRecord {
    const r = reader('EXPENSES', row);
    return {
      ExpenseID: r.text('ExpenseID'), Date: r.date('Date'), PropertyID: r.text('PropertyID'),
      ExpenseCategory: r.text('ExpenseCategory'), ExpenseSubcategory: r.text('ExpenseSubcategory'),
      Amount: r.num('Amount'), Tax: r.num('Tax'), PaymentStatus: r.text('PaymentStatus'),
      ExpenseType: r.text('ExpenseType'),
    };
  }
}

export class CapexRepository extends SheetRepository<CapexRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'CAPEX'); }
  protected get idKey() { return 'CapexID'; }
  protected map(row: Row): CapexRecord {
    const r = reader('CAPEX', row);
    return {
      CapexID: r.text('CapexID'), PropertyID: r.text('PropertyID'), Date: r.date('Date'),
      Category: r.text('Category'), Quantity: r.num('Quantity'), UnitCost: r.num('UnitCost'),
      Item: r.text('Item'), PaymentStatus: r.text('PaymentStatus'),
    };
  }
}

export class CashFlowRepository extends SheetRepository<CashFlowRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'CASHFLOW'); }
  protected get idKey() { return 'TxnID'; }
  protected map(row: Row): CashFlowRecord {
    const r = reader('CASHFLOW', row);
    return {
      TxnID: r.text('TxnID'), Date: r.date('Date'), Type: r.text('Type'),
      PropertyID: r.text('PropertyID'), MoneyIn: r.num('MoneyIn'), MoneyOut: r.num('MoneyOut'),
      ReconStatus: r.text('ReconStatus'),
    };
  }
}

export class InvestorRepository extends SheetRepository<InvestorRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'INVESTORS'); }
  protected get idKey() { return 'InvestorID'; }
  protected map(row: Row): InvestorRecord {
    const r = reader('INVESTORS', row);
    return {
      InvestorID: r.text('InvestorID'), InvestorName: r.text('InvestorName'),
      InvestmentAmount: r.num('InvestmentAmount'), ParticipationPct: r.num('ParticipationPct'),
      Status: r.text('Status'),
    };
  }
}

/** 12_INVESTOR_DISTRIBUTIONS: the allocation table starts below the waterfall block. */
export class DistributionRepository extends SheetRepository<DistributionRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'DIST'); }
  protected get idKey() { return 'InvestorID'; }
  override get range(): string {
    const cols = COLUMNS.DIST ?? [];
    const last = cols[cols.length - 1]!;
    const first = (SHEET_META.DIST as any).name;
    const { table } = DIST_TABLE_INFO;
    return `'${first}'!A${table.firstRow}:${last.a1}${table.firstRow + table.rows - 1}`;
  }
  protected map(row: Row): DistributionRecord {
    const r = reader('DIST', row);
    return {
      Period: r.date('Period'), InvestorID: r.text('InvestorID'),
      PaidAmount: r.num('PaidAmount'), PaidDate: r.date('PaidDate'),
      PendingAmount: r.num('PendingAmount'),
    };
  }
  override fromRows(rows: Row[]): DistributionRecord[] {
    const periodIdx = columnIndex('DIST', 'Period');
    const investorIdx = columnIndex('DIST', 'InvestorID');
    return rows
      .filter((r) => str(r[periodIdx]) !== '' && str(r[investorIdx]) !== '')
      .map((r) => this.map(r));
  }
  override async readAll(): Promise<DistributionRecord[]> {
    return this.fromRows(await this.client.get(this.range));
  }
}

// The distribution table's coordinates come from the generated contract.
import { DIST as DIST_CONTRACT } from '@/lib/contract/contract.generated';
const DIST_TABLE_INFO = { table: DIST_CONTRACT.table };

/* ------------------------------------------------------------------ *
 * Settings (02_SETTINGS) — business rules and platform commissions
 * ------------------------------------------------------------------ */

export class SettingsRepository {
  constructor(private readonly client: GoogleSheetsClient) {}

  /** Named-range reads: the workbook owns these addresses, we only reference them. */
  private static readonly NAMED = [
    'CFG_BIZ_NAME', 'CFG_CITY', 'CFG_COUNTRY', 'CFG_CURRENCY',
    'CFG_FY_START', 'CFG_INVESTOR_POOL_PCT', 'CFG_OPERATOR_POOL_PCT', 'CFG_RESERVE_PCT',
    'CFG_MGMT_FEE_PCT', 'CFG_LOSS_TREATMENT', 'CFG_PROFIT_DEFINITION',
    'CFG_PAYOUT_TOLERANCE', 'CFG_PAYOUT_OVERDUE_DAYS', 'CFG_RENT_DUE_DAYS',
  ] as const;

  async read(): Promise<BusinessSettings> {
    const ranges = [...SettingsRepository.NAMED, 'TBL_PLATFORMS'];
    const res = await this.client.batchGet(ranges as unknown as string[]);
    const scalar = (name: string): Cell => (res[name]?.[0]?.[0] ?? null) as Cell;

    const platformCommission: Record<string, number | null> = {};
    const platformPayoutLagDays: Record<string, number> = {};
    for (const row of res.TBL_PLATFORMS ?? []) {
      const name = str(row[0]);
      if (!name) continue;
      const commission = row[1];
      platformCommission[name] = typeof commission === 'number' ? commission : null;
      platformPayoutLagDays[name] = num(row[2]);
    }

    const pct = (v: Cell): number | null => (typeof v === 'number' ? v : null);
    // A blank identity cell falls back to the brand constant rather than rendering an
    // empty page header. Everything else stays exactly as the workbook has it.
    const identity = (name: string, fallback: string): string => str(scalar(name)) || fallback;
    return {
      businessName: identity('CFG_BIZ_NAME', BRAND.name),
      city: identity('CFG_CITY', BRAND.city),
      country: identity('CFG_COUNTRY', 'India'),
      currency: identity('CFG_CURRENCY', '₹'),
      fyStart: toSerial(scalar('CFG_FY_START')) ?? 0,
      investorPoolPct: pct(scalar('CFG_INVESTOR_POOL_PCT')),
      operatorPoolPct: pct(scalar('CFG_OPERATOR_POOL_PCT')),
      reservePct: pct(scalar('CFG_RESERVE_PCT')),
      mgmtFeePct: pct(scalar('CFG_MGMT_FEE_PCT')),
      lossTreatment: str(scalar('CFG_LOSS_TREATMENT')),
      profitDefinition: str(scalar('CFG_PROFIT_DEFINITION')),
      payoutToleranceInr: num(scalar('CFG_PAYOUT_TOLERANCE')),
      payoutOverdueDays: num(scalar('CFG_PAYOUT_OVERDUE_DAYS')),
      rentDueDays: num(scalar('CFG_RENT_DUE_DAYS')),
      platformCommission,
      platformPayoutLagDays,
    };
  }
}

/* ------------------------------------------------------------------ *
 * AnalyticsRepository — the ONLY 99_CALC reader.
 * ------------------------------------------------------------------ */

export class AnalyticsRepository {
  constructor(private readonly client: GoogleSheetsClient) {}

  /**
   * The FY monthly block. Safe to read concurrently: it is keyed by CFG_FY_START, not by
   * the shared reporting-month cell. Returned as metric → 12 monthly values.
   */
  async readMonthlyBlock(): Promise<Record<string, number[]>> {
    const rows = await this.client.get(monthlyBlockRange());
    const firstRow = Math.min(...Object.values(CALC.monthlyRows));
    const out: Record<string, number[]> = {};
    for (const [metric, rowNumber] of Object.entries(CALC.monthlyRows)) {
      const row = rows[rowNumber - firstRow] ?? [];
      const values: number[] = [];
      for (let i = 0; i < CALC.months; i++) values.push(num(row[CALC.firstMonthCol - 1 + i]));
      out[metric] = values;
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Report-month-dependent blocks — PARITY READERS.
   *
   * These blocks recalculate from the shared CFG_REPORT_MONTH cell. The application
   * never reads them, because it must never write that cell to choose a month
   * (Decision D1) — it computes its own breakdowns from the transactional records.
   *
   * The LIVE parity harness does read them, for the one thing it cannot get any other
   * way: what Google's formula engine actually produced for per-property,
   * per-platform, per-category and KPI-scalar figures. It reads them EXACTLY AS THEY
   * STAND — whatever month the workbook is currently set to — and `readReportMonth()`
   * reports which month that is so the engine can be asked for the same window.
   *
   * Reading is not selecting. Nothing here writes.
   * ---------------------------------------------------------------- */

  /** Which month the report-month blocks currently describe. Read-only. */
  async readReportMonth(): Promise<{ monthStart: Serial | null; monthKey: string }> {
    const cell = `'${CALC.sheet}'!${RM.kpiValueColA1}${RM.kpiRows.ReportMonthStart}`;
    const serial = toSerial((await this.client.get(cell))[0]?.[0]);
    return { monthStart: serial, monthKey: serial === null ? '' : monthKeyOf(serial) };
  }

  /** The 22 KPI scalars in column Q, as metric → value. */
  async readReportMonthKpis(): Promise<Record<string, number>> {
    const rowNumbers = Object.values(RM.kpiRows);
    const first = Math.min(...rowNumbers);
    const last = Math.max(...rowNumbers);
    const col = RM.kpiValueColA1;
    const rows = await this.client.get(`'${CALC.sheet}'!${col}${first}:${col}${last}`);
    const out: Record<string, number> = {};
    for (const [metric, rowNumber] of Object.entries(RM.kpiRows)) {
      out[metric] = num(rows[rowNumber - first]?.[0]);
    }
    return out;
  }

  /** Per-property performance for the report month, keyed by PropertyID. */
  async readPropertyBlock(): Promise<Array<Record<string, Cell>>> {
    return this.readCalcBlock(RM.propertyBlock, 'PropertyID');
  }

  /** Per-platform mix for the report month, keyed by Platform. */
  async readPlatformBlock(): Promise<Array<Record<string, Cell>>> {
    return this.readCalcBlock(RM.platformBlock, 'Platform');
  }

  /** Operating expenses by category for the report month. */
  async readExpenseCategoryBlock(): Promise<Array<Record<string, Cell>>> {
    return this.readCalcBlock(RM.expenseCategoryBlock, 'Category');
  }

  /** Shared row reader for the three tabular 99_CALC blocks. Blank key rows are spares. */
  private async readCalcBlock(
    block: { firstRow: number; lastRow: number; cols: Record<string, number> },
    keyColumn: string,
  ): Promise<Array<Record<string, Cell>>> {
    const width = Math.max(...Object.values(block.cols));
    const range = `'${CALC.sheet}'!A${block.firstRow}:${colLetter(width)}${block.lastRow}`;
    const out: Array<Record<string, Cell>> = [];
    for (const row of await this.client.get(range)) {
      const record: Record<string, Cell> = {};
      for (const [key, col] of Object.entries(block.cols)) record[key] = row[col - 1] ?? null;
      if (str(record[keyColumn]) === '') continue;   // spare template row
      out.push(record);
    }
    return out;
  }

  /** The dashboard alert stack (severity | area | message), already prioritised by V1. */
  async readAlerts(): Promise<Array<{ severity: string; area: string; message: string }>> {
    const rows = await this.client.get(`'${CALC.sheet}'!${CALC.alerts.range}`);
    return rows
      .filter((r) => str(r[0]) !== '')
      .map((r) => ({ severity: str(r[0]), area: str(r[1]), message: str(r[2]) }));
  }
}

/** A blank date column stays null — never an empty string that reads like a value. */
const isoOrNull = (serial: Serial | null): string | null =>
  (serial === null ? null : serialToIso(serial));

/**
 * 08_RENT_FIXED_COSTS. `NextDueDate` and `PaymentStatus` are V1 formula columns; they are
 * read as the workbook computed them. `computeRentSchedule` is the engine's port of the
 * same rules, and LIVE parity compares the two.
 */
export class RentRepository extends SheetRepository<RentRecord> {
  constructor(client: GoogleSheetsClient) { super(client, 'RENT'); }
  protected get idKey() { return 'RecordID'; }
  protected map(row: Row): RentRecord {
    const r = reader('RENT', row);
    return {
      recordId: r.text('RecordID'),
      propertyId: r.text('PropertyID'),
      costType: r.text('CostType'),
      landlordVendor: r.text('LandlordVendor'),
      monthlyAmount: r.num('MonthlyAmount'),
      dueDay: r.num('DueDay'),
      agreementStart: isoOrEmpty(r.date('AgreementStart')),
      agreementEnd: isoOrEmpty(r.date('AgreementEnd')),
      escalationPct: r.num('EscalationPct'),
      lastPaidDate: isoOrNull(r.date('LastPaidDate')),
      paidForMonth: isoOrNull(r.date('PaidForMonth')),
      nextDueDate: isoOrNull(r.date('NextDueDate')),
      paymentStatus: r.text('PaymentStatus'),
      notes: r.text('Notes'),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Operational repositories — V1 sheets 13 / 14 / 15.
 *
 * These feed the TODAY panel and the unit-status board. They are READ-ONLY here:
 * housekeeping and maintenance updates are write paths, and write paths are not part of
 * this phase.
 * ------------------------------------------------------------------ */

/** V1 stores dates as spreadsheet serials; the operational views speak ISO. */
const isoOrEmpty = (serial: Serial | null): string => (serial === null ? '' : serialToIso(serial));

export class HousekeepingRepository extends SheetRepository<HousekeepingTask> {
  constructor(client: GoogleSheetsClient) { super(client, 'HOUSEKEEPING'); }
  protected get idKey() { return 'TaskID'; }
  protected map(row: Row): HousekeepingTask {
    const r = reader('HOUSEKEEPING', row);
    return {
      taskId: r.text('TaskID'),
      propertyId: r.text('PropertyID'),
      checkoutDate: isoOrEmpty(r.date('CheckoutDate')),
      // FinalStatus is the turnover's own state; InspectionStatus is a sub-step of it.
      status: r.text('FinalStatus') as HousekeepingTask['status'],
      // Read, not derived. The mark-clean form writes this and the board could not show
      // it back; `Failed Inspection` remains a FinalStatus value and is not computed here.
      inspectionStatus: r.text('InspectionStatus'),
      cleaner: r.text('Cleaner'),
      /* Recorded on the row, unvalidated by anything. Carried so the register can show
         what somebody wrote; never used to answer "which turnovers belong to a booking". */
      bookingId: r.text('BookingID'),
    };
  }
}

export class MaintenanceRepository extends SheetRepository<MaintenanceTicket> {
  constructor(client: GoogleSheetsClient) { super(client, 'MAINTENANCE'); }
  protected get idKey() { return 'TicketID'; }
  protected map(row: Row): MaintenanceTicket {
    const r = reader('MAINTENANCE', row);
    return {
      ticketId: r.text('TicketID'),
      propertyId: r.text('PropertyID'),
      category: r.text('IssueCategory'),
      priority: r.text('Priority') as MaintenanceTicket['priority'],
      status: r.text('Status') as MaintenanceTicket['status'],
      description: r.text('Description'),
      reportedOn: isoOrEmpty(r.date('DateReported')),
    };
  }
}

export class InventoryRepository extends SheetRepository<InventoryItem> {
  constructor(client: GoogleSheetsClient) { super(client, 'INVENTORY'); }
  protected get idKey() { return 'ItemID'; }
  protected map(row: Row): InventoryItem {
    const r = reader('INVENTORY', row);
    return {
      itemId: r.text('ItemID'),
      propertyId: r.text('PropertyID'),
      item: r.text('Item'),
      unit: r.text('Unit'),
      // CurrentStock and ReorderStatus are workbook formulas. We read what V1 computed
      // rather than recomputing opening + purchased - used, so the two can never disagree.
      currentStock: r.num('CurrentStock'),
      minStock: r.num('MinStock'),
    };
  }
}

/**
 * Load the operational snapshot in ONE batch round trip.
 *
 * `today` is supplied by the caller (Asia/Kolkata civil date) so the value is explicit and
 * testable rather than depending on the server's timezone.
 *
 * Guest requests have no V1 sheet. Rather than report zero — which reads as "nobody asked
 * for anything today" — the counter is declared unavailable and the UI says so.
 */
export async function loadOperationsData(
  client: GoogleSheetsClient,
  today: string,
): Promise<OperationsData> {
  const housekeeping = new HousekeepingRepository(client);
  const maintenance = new MaintenanceRepository(client);
  const inventory = new InventoryRepository(client);

  const ranges = [housekeeping.range, maintenance.range, inventory.range];
  const res = await client.batchGet(ranges);
  const at = (i: number): Row[] => res[ranges[i] as string] ?? [];

  return {
    today,
    housekeeping: housekeeping.fromRows(at(0)),
    maintenance: maintenance.fromRows(at(1)),
    inventory: inventory.fromRows(at(2)),
    guestRequests: [],
    unavailableCounters: ['guestRequests'],
  };
}

/* ------------------------------------------------------------------ *
 * Aggregate loader — one batch round trip for the whole workbook
 * ------------------------------------------------------------------ */

export interface Repositories {
  properties: PropertyRepository;
  reservations: ReservationRepository;
  revenue: RevenueRepository;
  expenses: ExpenseRepository;
  capex: CapexRepository;
  cashflow: CashFlowRepository;
  investors: InvestorRepository;
  distributions: DistributionRepository;
  settings: SettingsRepository;
  analytics: AnalyticsRepository;
  housekeeping: HousekeepingRepository;
  maintenance: MaintenanceRepository;
  inventory: InventoryRepository;
  rent: RentRepository;
}

export function createRepositories(client: GoogleSheetsClient): Repositories {
  return {
    properties: new PropertyRepository(client),
    reservations: new ReservationRepository(client),
    revenue: new RevenueRepository(client),
    expenses: new ExpenseRepository(client),
    capex: new CapexRepository(client),
    cashflow: new CashFlowRepository(client),
    investors: new InvestorRepository(client),
    distributions: new DistributionRepository(client),
    settings: new SettingsRepository(client),
    analytics: new AnalyticsRepository(client),
    housekeeping: new HousekeepingRepository(client),
    maintenance: new MaintenanceRepository(client),
    inventory: new InventoryRepository(client),
    rent: new RentRepository(client),
  };
}

/**
 * Load everything the KPI engine needs in ONE `values.batchGet`.
 * This is the call the dashboard makes — not one request per widget.
 */
/** The rent register. Separate from `loadWorkbookData` because it is not a P&L input. */
export async function loadRentRegister(client: GoogleSheetsClient): Promise<RentRecord[]> {
  return new RentRepository(client).readAll();
}

export async function loadWorkbookData(client: GoogleSheetsClient): Promise<WorkbookData> {
  const repos = createRepositories(client);
  const settings = await repos.settings.read();

  const ranges = [
    repos.properties.range, repos.reservations.range, repos.revenue.range,
    repos.expenses.range, repos.capex.range, repos.cashflow.range,
    repos.investors.range, repos.distributions.range,
  ];
  const res = await client.batchGet(ranges);
  const at = (i: number): Row[] => res[ranges[i] as string] ?? [];

  return {
    properties: repos.properties.fromRows(at(0)),
    reservations: repos.reservations.fromRows(at(1)),
    revenue: repos.revenue.fromRows(at(2)),
    expenses: repos.expenses.fromRows(at(3)),
    capex: repos.capex.fromRows(at(4)),
    cashflow: repos.cashflow.fromRows(at(5)),
    investors: repos.investors.fromRows(at(6)),
    distributions: repos.distributions.fromRows(at(7)),
    settings,
  };
}
