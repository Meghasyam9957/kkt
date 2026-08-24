/**
 * GoogleSheetsClient — the ONLY place the Google Sheets API is touched.
 *
 * Two implementations:
 *   GoogleSheetsApiClient  — real API via a service account (server-side only).
 *   InMemorySheetsClient   — deterministic fixture backend for tests/parity.
 *
 * Guarantees enforced here:
 *   - reads are batched (one `values.batchGet` per logical page load);
 *   - `CFG_REPORT_MONTH` (01_DASHBOARD!C3) can never be written  — Decision D1;
 *   - calculated/reporting sheets can never be written;
 *   - every mutation returns the range it touched so the caller can audit it.
 */
import '@/lib/server/only';
import { SHEETS, FORBIDDEN_WRITE_CELL, READ_ONLY_SHEETS, type SheetKey } from '@/lib/contract/contract.generated';

export type Cell = string | number | boolean | null;
export type Row = Cell[];
export type A1Range = string;

export interface AppendResult {
  updatedRange: string;
  updatedRows: number;
}

export interface CellEdit {
  /** A1 of a single cell or a contiguous range, sheet-qualified. */
  range: A1Range;
  values: Row[];
}

export interface GoogleSheetsClient {
  /** One round trip for many ranges. Returns values keyed by the requested range. */
  batchGet(ranges: A1Range[]): Promise<Record<A1Range, Row[]>>;
  get(range: A1Range): Promise<Row[]>;
  append(sheet: SheetKey, rows: Row[]): Promise<AppendResult>;
  batchUpdate(edits: CellEdit[]): Promise<void>;
  /** Round trip that forces the workbook to settle before a read-after-write. */
  flush(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Write-safety guards. These run in BOTH implementations, so a test can
 * prove the rule holds rather than trusting the production path alone.
 * ------------------------------------------------------------------ */

const READ_ONLY_SHEET_NAMES: ReadonlySet<string> = new Set(
  (READ_ONLY_SHEETS as readonly string[]).map((k) => SHEETS[k as SheetKey]),
);

export class SheetWriteForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetWriteForbiddenError';
  }
}

/** Split "'04_RESERVATIONS'!A4:C9" → { sheetName, a1 }. */
export function parseQualifiedRange(range: A1Range): { sheetName: string; a1: string } {
  const m = /^'?([^'!]+)'?!(.+)$/.exec(range);
  if (!m || !m[1] || !m[2]) throw new Error(`Range must be sheet-qualified: ${range}`);
  return { sheetName: m[1], a1: m[2] };
}

/** Normalize "$C$3" / "c3" → "C3" for comparison against the forbidden cell. */
function normalizeA1(a1: string): string {
  return a1.replace(/\$/g, '').toUpperCase();
}

/** Throws if a write would touch a forbidden sheet or the shared reporting-month cell. */
export function assertWritable(range: A1Range): void {
  const { sheetName, a1 } = parseQualifiedRange(range);

  if (READ_ONLY_SHEET_NAMES.has(sheetName)) {
    throw new SheetWriteForbiddenError(
      `Refusing to write to '${sheetName}': it is a calculated/reporting surface owned by the V1 workbook.`,
    );
  }

  if (sheetName === SHEETS.DASHBOARD) {
    throw new SheetWriteForbiddenError(
      `Refusing to write to '${sheetName}'. The reporting month (${FORBIDDEN_WRITE_CELL}) is shared ` +
        `mutable state; per Decision D1 the web app computes period figures server-side instead.`,
    );
  }

  // Belt and braces: even if the dashboard were ever writable, never this cell.
  const start = normalizeA1(a1.split(':')[0] ?? '');
  if (start === normalizeA1(FORBIDDEN_WRITE_CELL)) {
    throw new SheetWriteForbiddenError(`Refusing to write the shared reporting-month cell (${FORBIDDEN_WRITE_CELL}).`);
  }
}

/* ------------------------------------------------------------------ *
 * Real client
 * ------------------------------------------------------------------ */

export interface GoogleSheetsApiConfig {
  spreadsheetId: string;
  /** Base64-encoded service-account JSON. Server-side env only. */
  serviceAccountJsonBase64: string;
  /** Retries for 429/5xx. */
  maxRetries?: number;
}

export class GoogleSheetsApiClient implements GoogleSheetsClient {
  private readonly spreadsheetId: string;
  private readonly credentials: Record<string, unknown>;
  private readonly maxRetries: number;
  private sheetsApi: any = null;

  constructor(config: GoogleSheetsApiConfig) {
    if (!config.spreadsheetId) throw new Error('GOOGLE_SHEET_ID is not configured');
    if (!config.serviceAccountJsonBase64) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not configured');
    this.spreadsheetId = config.spreadsheetId;
    this.maxRetries = config.maxRetries ?? 4;
    try {
      this.credentials = JSON.parse(Buffer.from(config.serviceAccountJsonBase64, 'base64').toString('utf8'));
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64-encoded JSON');
    }
  }

  private async api(): Promise<any> {
    if (this.sheetsApi) return this.sheetsApi;
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: this.credentials as any,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheetsApi = google.sheets({ version: 'v4', auth: await auth.getClient() as any });
    return this.sheetsApi;
  }

  /** Exponential backoff on 429/5xx — Sheets quota is 60 reads/min/user. */
  private async withRetry<T = any>(op: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await op();
      } catch (err: any) {
        lastError = err;
        const status = err?.code ?? err?.response?.status;
        const retryable = status === 429 || (typeof status === 'number' && status >= 500);
        if (!retryable || attempt === this.maxRetries) break;
        const delay = Math.min(2 ** attempt * 250 + Math.random() * 200, 4000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error(`Sheets ${label} failed: ${(lastError as Error)?.message ?? lastError}`);
  }

  async batchGet(ranges: A1Range[]): Promise<Record<A1Range, Row[]>> {
    if (ranges.length === 0) return {};
    const api = await this.api();
    const res = await this.withRetry<any>(
      () =>
        api.spreadsheets.values.batchGet({
          spreadsheetId: this.spreadsheetId,
          ranges,
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
        }),
      'batchGet',
    );
    const out: Record<A1Range, Row[]> = {};
    const valueRanges = res.data?.valueRanges ?? [];
    ranges.forEach((range, i) => {
      out[range] = (valueRanges[i]?.values ?? []) as Row[];
    });
    return out;
  }

  async get(range: A1Range): Promise<Row[]> {
    const res = await this.batchGet([range]);
    return res[range] ?? [];
  }

  /**
   * Workbook properties — title and timezone. Read-only.
   *
   * The timezone matters: every TODAY()-based formula in V1 evaluates in the
   * spreadsheet's timezone, so anything comparing against those formulas has to ask for
   * the same day rather than the server's.
   */
  async spreadsheetMetadata(): Promise<{ title: string; timeZone: string }> {
    const api = await this.api();
    const res = await this.withRetry<any>(
      () => api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, includeGridData: false }),
      'spreadsheets.get',
    );
    return {
      title: String(res.data?.properties?.title ?? ''),
      timeZone: String(res.data?.properties?.timeZone ?? ''),
    };
  }

  async append(sheet: SheetKey, rows: Row[]): Promise<AppendResult> {
    const sheetName = SHEETS[sheet];
    assertWritable(`'${sheetName}'!A1`);
    const api = await this.api();
    const res = await this.withRetry<any>(
      () =>
        api.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: `'${sheetName}'!A:A`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: rows },
        }),
      'append',
    );
    return {
      updatedRange: res.data?.updates?.updatedRange ?? '',
      updatedRows: res.data?.updates?.updatedRows ?? 0,
    };
  }

  async batchUpdate(edits: CellEdit[]): Promise<void> {
    for (const edit of edits) assertWritable(edit.range);
    if (edits.length === 0) return;
    const api = await this.api();
    await this.withRetry(
      () =>
        api.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: edits.map((e) => ({ range: e.range, values: e.values })),
          },
        }),
      'batchUpdate',
    );
  }

  async flush(): Promise<void> {
    // Sheets recalculates asynchronously after a write. A tiny settle window plus a
    // cheap round trip makes read-after-write return workbook-computed values.
    await new Promise((r) => setTimeout(r, 400));
    await this.get(`'${SHEETS.SETTINGS}'!A1`);
  }
}

/* ------------------------------------------------------------------ *
 * In-memory client (tests, parity fixtures, local development)
 * ------------------------------------------------------------------ */

export class InMemorySheetsClient implements GoogleSheetsClient {
  /** sheetName → dense grid of cells, 0-based [row][col]. */
  private grid = new Map<string, Row[]>();
  /**
   * Named ranges. The live API accepts a named range wherever it accepts an A1 range
   * (that is how SettingsRepository reads CFG_*), so the fixture backend must too —
   * otherwise tests would pass against a backend the production code cannot use.
   */
  private named = new Map<string, Row[]>();
  public readonly writeLog: Array<{ kind: 'append' | 'update'; range: string; rows: number }> = [];

  constructor(initial?: Record<string, Row[]>) {
    if (initial) for (const [name, rows] of Object.entries(initial)) this.grid.set(name, rows.map((r) => [...r]));
  }

  setSheet(sheetName: string, rows: Row[]): void {
    this.grid.set(sheetName, rows.map((r) => [...r]));
  }

  /** Define a named range's contents, e.g. setNamedRange('CFG_FY_START', [[46113]]). */
  setNamedRange(name: string, values: Row[]): void {
    this.named.set(name, values.map((r) => [...r]));
  }

  private static parseBounds(a1: string): { r1: number; c1: number; r2: number | null; c2: number | null } {
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a1.replace(/\$/g, '').toUpperCase());
    if (!m || !m[1]) throw new Error(`Cannot parse A1: ${a1}`);
    const toCol = (s: string) => [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    const c1 = toCol(m[1]);
    const r1 = m[2] ? Number(m[2]) : 1;
    const c2 = m[3] ? toCol(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) : m[3] ? null : r1; // "A4:C" = open-ended rows
    return { r1, c1, r2, c2 };
  }

  async batchGet(ranges: A1Range[]): Promise<Record<A1Range, Row[]>> {
    const out: Record<A1Range, Row[]> = {};
    for (const range of ranges) out[range] = await this.get(range);
    return out;
  }

  async get(range: A1Range): Promise<Row[]> {
    // Named ranges resolve first, exactly as they do server-side at Google.
    const named = this.named.get(range);
    if (named) return named.map((r) => [...r]);
    if (!range.includes('!')) return [];   // unknown name → empty, as the API returns

    const { sheetName, a1 } = parseQualifiedRange(range);
    const sheet = this.grid.get(sheetName) ?? [];
    const { r1, c1, r2, c2 } = InMemorySheetsClient.parseBounds(a1);
    const lastRow = r2 ?? sheet.length;
    const out: Row[] = [];
    for (let r = r1; r <= lastRow; r++) {
      const source = sheet[r - 1] ?? [];
      const lastCol = c2 ?? source.length;
      const row: Row = [];
      for (let c = c1; c <= lastCol; c++) row.push(source[c - 1] ?? null);
      out.push(row);
    }
    // Google trims wholly-empty trailing rows; mirror that so callers behave identically.
    while (out.length > 0 && (out[out.length - 1] ?? []).every((v) => v === null || v === '')) out.pop();
    return out;
  }

  async append(sheet: SheetKey, rows: Row[]): Promise<AppendResult> {
    const sheetName = SHEETS[sheet];
    assertWritable(`'${sheetName}'!A1`);
    const existing = this.grid.get(sheetName) ?? [];
    let firstFree = existing.length;
    while (firstFree > 0 && (existing[firstFree - 1] ?? []).every((v) => v === null || v === '')) firstFree--;
    for (let i = 0; i < rows.length; i++) existing[firstFree + i] = [...(rows[i] ?? [])];
    this.grid.set(sheetName, existing);
    const result = { updatedRange: `'${sheetName}'!A${firstFree + 1}`, updatedRows: rows.length };
    this.writeLog.push({ kind: 'append', range: result.updatedRange, rows: rows.length });
    return result;
  }

  async batchUpdate(edits: CellEdit[]): Promise<void> {
    for (const edit of edits) assertWritable(edit.range);
    for (const edit of edits) {
      const { sheetName, a1 } = parseQualifiedRange(edit.range);
      const sheet = this.grid.get(sheetName) ?? [];
      const { r1, c1 } = InMemorySheetsClient.parseBounds(a1);
      edit.values.forEach((row, dr) => {
        const target = sheet[r1 - 1 + dr] ?? [];
        row.forEach((v, dc) => { target[c1 - 1 + dc] = v; });
        sheet[r1 - 1 + dr] = target;
      });
      this.grid.set(sheetName, sheet);
      this.writeLog.push({ kind: 'update', range: edit.range, rows: edit.values.length });
    }
  }

  async flush(): Promise<void> { /* no-op: the fixture backend has no async recalculation */ }
}
