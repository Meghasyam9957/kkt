/**
 * Contract generator — Decision D2.
 *
 * Reads the V1 workbook contract (`homestay-ops/src/00_constants.gs`) and emits a
 * TypeScript module describing every sheet, column, enum, ID rule and 99_CALC address.
 * The V1 file is READ ONLY; nothing here writes to it.
 *
 *   node lib/contract/generate.mjs           → write contract.generated.ts + contract.lock.json
 *   node lib/contract/generate.mjs --check    → fail (exit 1) if the workbook contract drifted
 *
 * Why generate instead of hand-writing: column letters are derived from registry order, so
 * inserting a column in V1 can never silently misalign the web app, and `role: 'calc'`
 * travels with the column so calculated cells are unwritable by construction.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..');
const V1_CONSTANTS = path.resolve(WEB_ROOT, '..', 'homestay-ops', 'src', '00_constants.gs');
const OUT_TS = path.join(HERE, 'contract.generated.ts');
const OUT_LOCK = path.join(HERE, 'contract.lock.json');

const CHECK_ONLY = process.argv.includes('--check');

/* ------------------------------------------------------------------ *
 * 1. Evaluate the V1 constants file in a sandbox (no side effects — the
 *    file is pure data declarations plus one helper-free structure).
 * ------------------------------------------------------------------ */
function loadV1Contract() {
  if (!fs.existsSync(V1_CONSTANTS)) {
    throw new Error('V1 contract not found at ' + V1_CONSTANTS + ' — is homestay-ops/ present?');
  }
  const source = fs.readFileSync(V1_CONSTANTS, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: '00_constants.gs' });

  const required = ['SHEETS', 'COLUMNS', 'LISTS', 'CALC', 'PNL', 'DIST', 'DIST_TABLE',
    'DATA_ROW', 'ROWS', 'ID_RULES', 'SETTINGS_MAP', 'INITIAL_PROPERTIES', 'TAB_ORDER',
    'ANALYTICS', 'QA', 'DASH', 'FORMATS'];
  for (const key of required) {
    if (sandbox[key] === undefined) throw new Error('V1 contract is missing `' + key + '`');
  }
  return { sandbox, source };
}

/** Spreadsheet column index (1-based) → A1 letters. Mirrors V1 `colLetter_`. */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** '04_RESERVATIONS' → 'RESERVATIONS' (the SHEETS key), for stable TS identifiers. */
function sheetKeyFor(sheets, sheetName) {
  return Object.keys(sheets).find((k) => sheets[k] === sheetName);
}

/* ------------------------------------------------------------------ *
 * 2. Build the normalized contract model.
 * ------------------------------------------------------------------ */
function buildModel(v1) {
  const { SHEETS, COLUMNS, LISTS, CALC, PNL, DIST, DIST_TABLE, DATA_ROW, ROWS,
    ID_RULES, SETTINGS_MAP, INITIAL_PROPERTIES, TAB_ORDER, ANALYTICS, QA, DASH } = v1;

  const sheets = {};
  for (const [key, name] of Object.entries(SHEETS)) {
    sheets[key] = {
      key,
      name,
      dataRow: DATA_ROW,
      headerRow: DATA_ROW - 1,
      preparedRows: ROWS[name] ?? null,
      lastDataRow: ROWS[name] ? DATA_ROW + ROWS[name] - 1 : null,
    };
  }

  const columns = {};
  for (const [sheetName, cols] of Object.entries(COLUMNS)) {
    const key = sheetKeyFor(SHEETS, sheetName);
    if (!key) throw new Error('COLUMNS references unknown sheet: ' + sheetName);
    columns[key] = cols.map((c, i) => {
      const index = i + 1;
      const baseType = String(c.t).replace(/^calc-/, '');
      return {
        key: c.k,
        header: c.h,
        index,
        a1: colLetter(index),
        type: baseType,
        role: c.role === 'calc' ? 'calc' : 'in',
        list: c.list ?? null,      // LISTS key, for `t: 'list'`
        range: c.range ?? null,    // named range, for `t: 'listRange'`
        note: c.note ?? null,
      };
    });
  }

  // Named ranges that column validation depends on (must exist in the workbook).
  const requiredNamedRanges = new Set();
  for (const cols of Object.values(columns)) {
    for (const c of cols) {
      if (c.list) requiredNamedRanges.add('LIST_' + c.list);
      if (c.range) requiredNamedRanges.add(c.range);
    }
  }
  for (const section of SETTINGS_MAP.sections) {
    for (const item of section.items ?? []) if (item.name) requiredNamedRanges.add(item.name);
    if (section.table?.names) for (const n of Object.keys(section.table.names)) requiredNamedRanges.add(n);
    if (section.listCol?.name) requiredNamedRanges.add(section.listCol.name);
  }
  for (const d of SETTINGS_MAP.dynamicLists ?? []) requiredNamedRanges.add(d.name);

  // Business rules — which are LIVE in the V1 math vs recorded-only (per V1 notes).
  const rulesSection = SETTINGS_MAP.sections.find((s) => s.rules);
  const businessRules = (rulesSection?.items ?? []).map((it) => ({
    name: it.name,
    label: it.label,
    format: it.fmt,
    settingsCell: 'B' + it.row,
    recordedOnly: /RECORDED ONLY/i.test(it.note ?? ''),
  }));

  // 99_CALC addressing: the monthly block is FY-indexed (safe to read concurrently);
  // the KPI/property/platform/expense blocks key off CFG_REPORT_MONTH and MUST NOT be
  // read by the web app (Decision D1) — recorded here so the rule is machine-checkable.
  const calc = {
    sheet: SHEETS.CALC,
    firstMonthCol: CALC.FIRST_MONTH_COL,
    firstMonthColA1: colLetter(CALC.FIRST_MONTH_COL),
    months: CALC.MONTHS,
    lastMonthColA1: colLetter(CALC.FIRST_MONTH_COL + CALC.MONTHS - 1),
    totalCol: CALC.TOTAL_COL,
    totalColA1: colLetter(CALC.TOTAL_COL),
    monthlyRows: { ...CALC.M },
    monthlyBlockRange:
      colLetter(CALC.FIRST_MONTH_COL) + Math.min(...Object.values(CALC.M)) + ':' +
      colLetter(CALC.TOTAL_COL) + Math.max(...Object.values(CALC.M)),
    reportMonthDependent: {
      kpiValueColA1: colLetter(CALC.KPI_VALUE_COL),
      kpiRows: { ...CALC.K },
      propertyBlock: { ...CALC.PROP },
      platformBlock: { ...CALC.PLATFORM },
      expenseCategoryBlock: { ...CALC.EXPCAT },
    },
    alerts: {
      finalColA1: colLetter(CALC.ALERTS.FINAL_COL),
      finalRow: CALC.ALERTS.FINAL_ROW,
      finalRows: CALC.ALERTS.FINAL_ROWS,
      range:
        colLetter(CALC.ALERTS.FINAL_COL) + CALC.ALERTS.FINAL_ROW + ':' +
        colLetter(CALC.ALERTS.FINAL_COL + 2) + (CALC.ALERTS.FINAL_ROW + CALC.ALERTS.FINAL_ROWS - 1),
    },
  };

  return {
    generatedFrom: 'homestay-ops/src/00_constants.gs',
    sheets,
    tabOrder: TAB_ORDER,
    columns,
    lists: LISTS,
    idRules: ID_RULES,
    calc,
    pnl: { headerRow: PNL.HEADER_ROW, rows: PNL.ROWS, expenseLines: PNL.EXP_LINES },
    dist: { periodCell: DIST.PERIOD_CELL, waterfallRows: DIST.W, table: DIST_TABLE },
    analytics: ANALYTICS,
    qa: QA,
    dashboard: { reportMonthCell: DASH.REPORT_MONTH_CELL },
    businessRules,
    requiredNamedRanges: [...requiredNamedRanges].sort(),
    initialProperties: INITIAL_PROPERTIES,
    dataRow: DATA_ROW,
  };
}

/* ------------------------------------------------------------------ *
 * 3. Emit TypeScript.
 * ------------------------------------------------------------------ */
const j = (v) => JSON.stringify(v, null, 2);

function tsUnion(values) {
  return values.filter((v) => v !== '' && v != null).map((v) => JSON.stringify(v)).join(' | ') || 'string';
}

function emitTypeScript(model, hash) {
  const sheetKeys = Object.keys(model.sheets);
  const L = [];

  L.push('/* eslint-disable */');
  L.push('/**');
  L.push(' * AUTO-GENERATED — DO NOT EDIT BY HAND.');
  L.push(' * Source: ' + model.generatedFrom);
  L.push(' * Regenerate: npm run contract:generate     Verify: npm run contract:check');
  L.push(' * Contract hash: ' + hash);
  L.push(' */');
  L.push('');

  L.push('export const CONTRACT_HASH = ' + JSON.stringify(hash) + ';');
  L.push('export const DATA_ROW = ' + model.dataRow + ';');
  L.push('export const HEADER_ROW = ' + (model.dataRow - 1) + ';');
  L.push('');

  // Sheet names
  L.push('export const SHEETS = ' + j(Object.fromEntries(sheetKeys.map((k) => [k, model.sheets[k].name]))) + ' as const;');
  L.push('export type SheetKey = keyof typeof SHEETS;');
  L.push('export type SheetName = (typeof SHEETS)[SheetKey];');
  L.push('');
  L.push('export const SHEET_META = ' + j(model.sheets) + ' as const;');
  L.push('export const TAB_ORDER = ' + j(model.tabOrder) + ' as const;');
  L.push('');

  // Column registry
  L.push('export interface ColumnSpec {');
  L.push('  readonly key: string;');
  L.push('  readonly header: string;');
  L.push('  readonly index: number;');
  L.push('  readonly a1: string;');
  L.push('  readonly type: string;');
  L.push('  /** `in` = user input (writable by the app). `calc` = workbook formula (NEVER writable). */');
  L.push('  readonly role: "in" | "calc";');
  L.push('  readonly list: string | null;');
  L.push('  readonly range: string | null;');
  L.push('  readonly note: string | null;');
  L.push('}');
  L.push('');
  L.push('export const COLUMNS: Readonly<Record<string, readonly ColumnSpec[]>> = ' + j(model.columns) + ';');
  L.push('');

  // Per-sheet key unions for the sheets the app reads/writes most
  for (const [sheetKey, cols] of Object.entries(model.columns)) {
    const typeName = sheetKey.split('_').map((p) => p.charAt(0) + p.slice(1).toLowerCase()).join('');
    L.push('export type ' + typeName + 'Column = ' + tsUnion(cols.map((c) => c.key)) + ';');
  }
  L.push('');

  // Enums
  L.push('export const LISTS = ' + j(model.lists) + ' as const;');
  L.push('');
  for (const [name, values] of Object.entries(model.lists)) {
    const typeName = name.split('_').map((p) => p.charAt(0) + p.slice(1).toLowerCase()).join('');
    L.push('export type ' + typeName + ' = ' + tsUnion(values) + ';');
  }
  L.push('');

  // IDs, 99_CALC, P&L, distributions, business rules
  L.push('export const ID_RULES = ' + j(model.idRules) + ' as const;');
  L.push('');
  L.push('/**');
  L.push(' * 99_CALC addressing.');
  L.push(' * `monthlyRows` is FY-indexed (keyed by CFG_FY_START) and is SAFE to read.');
  L.push(' * Everything under `reportMonthDependent` keys off the shared CFG_REPORT_MONTH cell;');
  L.push(' * per Decision D1 the web app must NOT read those blocks and must NEVER write that');
  L.push(' * cell — those figures are computed server-side instead.');
  L.push(' */');
  L.push('export const CALC = ' + j(model.calc) + ' as const;');
  L.push('export type MonthlyMetric = keyof typeof CALC.monthlyRows;');
  L.push('');
  L.push('export const PNL = ' + j(model.pnl) + ' as const;');
  L.push('export const DIST = ' + j(model.dist) + ' as const;');
  L.push('export const ANALYTICS_MAP = ' + j(model.analytics) + ' as const;');
  L.push('export const QA_MAP = ' + j(model.qa) + ' as const;');
  L.push('export const DASHBOARD_MAP = ' + j(model.dashboard) + ' as const;');
  L.push('');
  L.push('/** Cell the web app must never write (Decision D1). */');
  L.push('export const FORBIDDEN_WRITE_CELL = ' + JSON.stringify(model.dashboard.reportMonthCell) + ';');
  L.push('/** Sheets the web app must never write to (calculated / reporting surfaces). */');
  L.push('export const READ_ONLY_SHEETS = ' + j(['CALC', 'PNL', 'ANALYTICS', 'QA', 'GUIDE', 'DASHBOARD']) + ' as const;');
  L.push('');
  L.push('export const BUSINESS_RULES = ' + j(model.businessRules) + ' as const;');
  L.push('export const REQUIRED_NAMED_RANGES = ' + j(model.requiredNamedRanges) + ' as const;');
  L.push('export const INITIAL_PROPERTIES = ' + j(model.initialProperties) + ' as const;');
  L.push('');

  // Helpers
  L.push('/** Column spec lookup. Throws on unknown keys so drift fails loudly, not silently. */');
  L.push('export function column(sheet: SheetKey, key: string): ColumnSpec {');
  L.push('  const found = COLUMNS[sheet]?.find((c) => c.key === key);');
  L.push('  if (!found) throw new Error(`Unknown column ${sheet}.${key} — regenerate the contract`);');
  L.push('  return found;');
  L.push('}');
  L.push('');
  L.push('/** Zero-based position of a column in a row array read from the sheet. */');
  L.push('export function columnIndex(sheet: SheetKey, key: string): number {');
  L.push('  return column(sheet, key).index - 1;');
  L.push('}');
  L.push('');
  L.push('/** Full data range for a sheet, e.g. "\'04_RESERVATIONS\'!A4:AP703". */');
  L.push('export function dataRange(sheet: SheetKey): string {');
  L.push('  const meta = SHEET_META[sheet];');
  L.push('  const cols = COLUMNS[sheet];');
  L.push('  if (!cols || !meta.lastDataRow) throw new Error(`No tabular data range for ${sheet}`);');
  L.push('  const last = cols[cols.length - 1];');
  L.push('  if (!last) throw new Error(`No columns registered for ${sheet}`);');
  L.push('  return `\'${meta.name}\'!A${DATA_ROW}:${last.a1}${meta.lastDataRow}`;');
  L.push('}');
  L.push('');
  L.push('/** The FY monthly block in 99_CALC — the only KPI block safe to read directly. */');
  L.push('export function monthlyBlockRange(): string {');
  L.push('  return `\'${CALC.sheet}\'!A${Math.min(...Object.values(CALC.monthlyRows))}:${CALC.totalColA1}${Math.max(...Object.values(CALC.monthlyRows))}`;');
  L.push('}');
  L.push('');
  L.push('/** Input (writable) columns only — calculated columns are excluded by construction. */');
  L.push('export function inputColumns(sheet: SheetKey): readonly ColumnSpec[] {');
  L.push('  return (COLUMNS[sheet] ?? []).filter((c) => c.role === "in");');
  L.push('}');
  L.push('');

  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 4. Run.
 * ------------------------------------------------------------------ */
function main() {
  const { sandbox, source } = loadV1Contract();
  const model = buildModel(sandbox);
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  const modelHash = crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 16);

  const lock = {
    generatedFrom: model.generatedFrom,
    v1SourceHash: sourceHash,
    contractModelHash: modelHash,
    counts: {
      sheets: Object.keys(model.sheets).length,
      tabularSheets: Object.keys(model.columns).length,
      columns: Object.values(model.columns).reduce((n, c) => n + c.length, 0),
      inputColumns: Object.values(model.columns).reduce((n, c) => n + c.filter((x) => x.role === 'in').length, 0),
      calcColumns: Object.values(model.columns).reduce((n, c) => n + c.filter((x) => x.role === 'calc').length, 0),
      lists: Object.keys(model.lists).length,
      namedRanges: model.requiredNamedRanges.length,
      monthlyMetrics: Object.keys(model.calc.monthlyRows).length,
      businessRules: model.businessRules.length,
    },
  };

  if (CHECK_ONLY) {
    if (!fs.existsSync(OUT_LOCK)) {
      console.error('FAIL: contract.lock.json missing — run `npm run contract:generate`.');
      process.exit(1);
    }
    const prev = JSON.parse(fs.readFileSync(OUT_LOCK, 'utf8'));
    const drifted = prev.v1SourceHash !== lock.v1SourceHash || prev.contractModelHash !== lock.contractModelHash;
    if (drifted) {
      console.error('FAIL: the V1 workbook contract has changed since the last review.');
      console.error('  V1 source hash : ' + prev.v1SourceHash + ' -> ' + lock.v1SourceHash);
      console.error('  Contract model : ' + prev.contractModelHash + ' -> ' + lock.contractModelHash);
      console.error('  Review the change, then run `npm run contract:generate` to accept it.');
      process.exit(1);
    }
    console.log('contract:check OK — no drift (model ' + lock.contractModelHash + ')');
    return;
  }

  fs.writeFileSync(OUT_TS, emitTypeScript(model, modelHash));
  fs.writeFileSync(OUT_LOCK, JSON.stringify(lock, null, 2) + '\n');
  fs.writeFileSync(path.join(HERE, 'contract.model.json'), JSON.stringify(model, null, 2) + '\n');

  console.log('Generated ' + path.relative(WEB_ROOT, OUT_TS));
  for (const [k, v] of Object.entries(lock.counts)) console.log('  ' + k.padEnd(18) + v);
  console.log('  contract model hash  ' + modelHash);
}

main();
