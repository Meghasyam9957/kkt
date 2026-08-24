import '@/lib/server/only';
/**
 * LIVE DEMO RESET — restore the REAL demo workbook to its seeded fiction (Phase D7).
 *
 * The fixtures demo resets by regenerating its dataset. A real demo workbook cannot: its
 * seed came from V1's seedTestData(), which only Apps Script can run. So the reset is a
 * SNAPSHOT restore — capture the seeded input cells once, right after the workbook is
 * built, and a reset writes exactly those cells back.
 *
 * Three rules make this safe enough to put behind a button:
 *
 *   1. INPUT CELLS ONLY. Every write goes through the same GoogleSheetsClient the
 *      mutation pipeline uses, so calculated columns and reporting sheets are not just
 *      avoided — `assertWritable` refuses them. Restoring a row means writing its input
 *      cells; V1's prepared formulas recalculate the rest, exactly as they did at seeding.
 *
 *   2. THE SNAPSHOT MUST MATCH THE CONTRACT. A snapshot captured under one contract hash
 *      is refused under another: column letters could have moved, and a restore through a
 *      moved column map would scramble the workbook instead of restoring it.
 *
 *   3. VERIFIED, OR FAILED LOUDLY. After writing, every sheet is re-read and compared
 *      cell-for-cell. A reset that could not prove the workbook matches the seed throws
 *      with the first mismatches named — it never reports success on trust.
 *
 * Environment gating (demo-only, `demo.control` capability) lives with the caller in
 * `app/api/demo/route.ts` via `authorizeDemoOperation`; this module additionally refuses
 * to construct against anything but a demo-environment resolution, belt and braces.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  COLUMNS, SHEET_META, SHEETS, DATA_ROW, CONTRACT_HASH,
  type SheetKey, type ColumnSpec,
} from '@/lib/contract/contract.generated';
import type { GoogleSheetsClient, Cell, Row, CellEdit } from '@/lib/server/sheets/client';
import type { ResolvedEnvironment } from '@/lib/server/environment/config';

/** Every prepared table sheet the workbook lets us write. All 15 carry input columns. */
export const SNAPSHOT_SHEETS = Object.keys(COLUMNS) as SheetKey[];

export interface SeedSnapshot {
  version: 1;
  capturedAt: string;
  contractHash: string;
  /** Per sheet: input-column keys (capture order) and dense rows from DATA_ROW. */
  sheets: Partial<Record<SheetKey, { inputKeys: string[]; rows: Cell[][] }>>;
}

export interface SheetResetResult {
  /** Rows written back to their seeded values. */
  restoredRows: number;
  /** Rows beyond the seed whose input cells were cleared. */
  clearedRows: number;
}

export interface ResetReport {
  sheets: Partial<Record<SheetKey, SheetResetResult>>;
  restoredRows: number;
  clearedRows: number;
}

export class SeedSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedSnapshotError';
  }
}

const inputCols = (sheet: SheetKey): readonly ColumnSpec[] =>
  (COLUMNS[sheet] ?? []).filter((c) => c.role !== 'calc');

const blank = (v: Cell | undefined): boolean => v === null || v === undefined || v === '';

/** A1 of the whole data block, DATA_ROW to the end of the prepared range. */
function dataBlockRange(sheet: SheetKey): string {
  const cols = COLUMNS[sheet] ?? [];
  const last = cols[cols.length - 1]!;
  const meta = SHEET_META[sheet];
  return `'${meta.name}'!A${DATA_ROW}:${last.a1}${meta.lastDataRow ?? DATA_ROW + 996}`;
}

/** 0-based grid-column index for a spec (its 1-based contract index minus one). */
const gridIndex = (col: ColumnSpec): number => col.index - 1;

/** Extract one row's input cells, in input-column order. Blank normalizes to null: the
 *  live API cannot tell an empty cell from an empty string, so the snapshot must not. */
function inputCells(row: Row, cols: readonly ColumnSpec[]): Cell[] {
  return cols.map((c) => {
    const v = row[gridIndex(c)];
    return v === undefined || v === '' ? null : v;
  });
}

/** Index of the last row (exclusive) with any non-blank INPUT cell. Calc output alone
 *  does not make a row "used": prepared formulas fill calc cells of blank rows too. */
function usedRowCount(rows: Row[], cols: readonly ColumnSpec[]): number {
  let last = 0;
  rows.forEach((row, i) => {
    if (!inputCells(row, cols).every(blank)) last = i + 1;
  });
  return last;
}

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

/**
 * Read every table sheet's input cells into a snapshot. Run once, immediately after the
 * workbook is seeded — this is the state every later reset returns to.
 */
export async function captureSeedSnapshot(client: GoogleSheetsClient): Promise<SeedSnapshot> {
  const ranges = SNAPSHOT_SHEETS.map(dataBlockRange);
  const blocks = await client.batchGet(ranges);

  const sheets: SeedSnapshot['sheets'] = {};
  SNAPSHOT_SHEETS.forEach((sheet, i) => {
    const cols = inputCols(sheet);
    const rows = blocks[ranges[i]!] ?? [];
    const used = usedRowCount(rows, cols);
    sheets[sheet] = {
      inputKeys: cols.map((c) => c.key),
      // Dense from DATA_ROW to the last used row — interior blank rows keep their
      // position, so IDs land back on the exact rows they were seeded on.
      rows: rows.slice(0, used).map((row) => inputCells(row, cols)),
    };
  });

  return { version: 1, capturedAt: new Date().toISOString(), contractHash: CONTRACT_HASH, sheets };
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

/** Refuse a snapshot this build cannot safely restore. */
export function assertSnapshotUsable(snapshot: SeedSnapshot): void {
  if (snapshot.version !== 1) {
    throw new SeedSnapshotError(`Unknown seed snapshot version ${String(snapshot.version)}.`);
  }
  if (snapshot.contractHash !== CONTRACT_HASH) {
    throw new SeedSnapshotError(
      `The seed snapshot was captured under contract ${snapshot.contractHash}, but this build ` +
      `runs contract ${CONTRACT_HASH}. Column positions may have moved; restoring through a ` +
      'moved column map would corrupt the workbook. Re-capture the snapshot.',
    );
  }
  for (const sheet of SNAPSHOT_SHEETS) {
    const entry = snapshot.sheets[sheet];
    if (!entry) {
      throw new SeedSnapshotError(`The seed snapshot has no entry for ${SHEETS[sheet]}. Re-capture it.`);
    }
    const expected = inputCols(sheet).map((c) => c.key);
    if (entry.inputKeys.length !== expected.length
      || entry.inputKeys.some((k, i) => k !== expected[i])) {
      throw new SeedSnapshotError(
        `The seed snapshot's input columns for ${SHEETS[sheet]} do not match this build's ` +
        'contract. Re-capture the snapshot.',
      );
    }
  }
}

/**
 * Write the snapshot back: seeded rows get their captured input values, and any row the
 * demo added beyond the seed gets its input cells cleared. One column-slice write per
 * input column keeps the whole reset to a single `batchUpdate`, then the result is
 * verified by re-reading every sheet.
 */
export async function restoreSeedSnapshot(
  client: GoogleSheetsClient,
  snapshot: SeedSnapshot,
): Promise<ResetReport> {
  assertSnapshotUsable(snapshot);

  const ranges = SNAPSHOT_SHEETS.map(dataBlockRange);
  const current = await client.batchGet(ranges);

  const edits: CellEdit[] = [];
  const report: ResetReport = { sheets: {}, restoredRows: 0, clearedRows: 0 };

  SNAPSHOT_SHEETS.forEach((sheet, i) => {
    const cols = inputCols(sheet);
    const seed = snapshot.sheets[sheet]!;
    const now = current[ranges[i]!] ?? [];
    const nowUsed = usedRowCount(now, cols);
    const extent = Math.max(seed.rows.length, nowUsed);
    const meta = SHEET_META[sheet];

    if (extent > 0) {
      cols.forEach((col, c) => {
        edits.push({
          range: `'${meta.name}'!${col.a1}${DATA_ROW}:${col.a1}${DATA_ROW + extent - 1}`,
          values: Array.from({ length: extent }, (_, r) => {
            const v = seed.rows[r]?.[c];
            // '' clears the cell; null would leave the demo's value standing.
            return [v === null || v === undefined ? '' : v];
          }),
        });
      });
    }

    report.sheets[sheet] = {
      restoredRows: seed.rows.length,
      clearedRows: Math.max(0, nowUsed - seed.rows.length),
    };
    report.restoredRows += seed.rows.length;
    report.clearedRows += Math.max(0, nowUsed - seed.rows.length);
  });

  await client.batchUpdate(edits);
  await client.flush();
  await verifyRestore(client, snapshot);
  return report;
}

/** Re-read every sheet and require input cells to equal the snapshot exactly. */
async function verifyRestore(client: GoogleSheetsClient, snapshot: SeedSnapshot): Promise<void> {
  const ranges = SNAPSHOT_SHEETS.map(dataBlockRange);
  const blocks = await client.batchGet(ranges);
  const mismatches: string[] = [];

  SNAPSHOT_SHEETS.forEach((sheet, i) => {
    const cols = inputCols(sheet);
    const seed = snapshot.sheets[sheet]!;
    const rows = blocks[ranges[i]!] ?? [];
    const used = usedRowCount(rows, cols);

    if (used > seed.rows.length) {
      mismatches.push(`${SHEETS[sheet]}: ${used - seed.rows.length} row(s) beyond the seed still carry input values`);
      return;
    }
    for (let r = 0; r < seed.rows.length; r++) {
      const got = inputCells(rows[r] ?? [], cols);
      for (let c = 0; c < cols.length; c++) {
        const want = seed.rows[r]![c];
        const same = (blank(want) && blank(got[c]!)) || String(want) === String(got[c]);
        if (!same) {
          mismatches.push(
            `${SHEETS[sheet]}!${cols[c]!.a1}${DATA_ROW + r}: expected ${JSON.stringify(want)}, ` +
            `read back ${JSON.stringify(got[c])}`,
          );
          if (mismatches.length >= 5) return;
        }
      }
    }
  });

  if (mismatches.length > 0) {
    throw new SeedSnapshotError(
      'The reset wrote, but read-back does not match the seed. The workbook may be mid-edit ' +
      `by someone else. First mismatches: ${mismatches.slice(0, 5).join('; ')}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Snapshot storage
 * ------------------------------------------------------------------ */

/** Where the snapshot lives. Fictional data, but per-workbook state — kept out of git. */
export function seedSnapshotPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEMO_SEED_SNAPSHOT_PATH?.trim()
    || path.join(process.cwd(), '.demo', 'seed-snapshot.json');
}

export function saveSeedSnapshot(snapshot: SeedSnapshot, filePath: string = seedSnapshotPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 1), 'utf8');
}

export function loadSeedSnapshot(filePath: string = seedSnapshotPath()): SeedSnapshot | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SeedSnapshot;
  return parsed;
}

/** What the demo controls page shows about the snapshot without loading all of it. */
export function seedSnapshotStatus(filePath: string = seedSnapshotPath()):
  { exists: false } | { exists: true; capturedAt: string; contractMatches: boolean; seededRows: number } {
  const snapshot = loadSeedSnapshot(filePath);
  if (!snapshot) return { exists: false };
  return {
    exists: true,
    capturedAt: snapshot.capturedAt,
    contractMatches: snapshot.contractHash === CONTRACT_HASH,
    seededRows: Object.values(snapshot.sheets).reduce((n, s) => n + (s?.rows.length ?? 0), 0),
  };
}

/* ------------------------------------------------------------------ *
 * Demo Supabase technical state
 * ------------------------------------------------------------------ */

/**
 * Clear the demo project's operation/idempotency/ID-allocation state so the next
 * demonstration starts clean: no stale operation can replay against rows that no longer
 * exist, and IDs re-seed their floors from the restored workbook.
 *
 * `app_users` and `audit_log` are deliberately KEPT: accounts survive a reset, and an
 * audit trail that a reset could erase would not be an audit trail.
 */
export async function resetDemoTechnicalState(
  resolved: ResolvedEnvironment,
): Promise<{ cleared: string[]; skipped: string[] }> {
  if (resolved.env !== 'demo') {
    // authorizeDemoOperation already refused; this guard keeps the module safe alone.
    throw new SeedSnapshotError('Technical-state reset exists only in the demo environment.');
  }
  if (!resolved.supabase) return { cleared: [], skipped: ['operations', 'id_allocations', 'id_sequences'] };

  // Same lazy import pattern as the service layer — never in a client bundle path.
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(resolved.supabase.url, resolved.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });

  const cleared: string[] = [];
  const tables: Array<[string, string]> = [
    ['operations', 'operation_id'],
    ['id_allocations', 'idempotency_key'],
    ['id_sequences', 'scope'],
  ];
  for (const [table, pk] of tables) {
    const { error } = await supabase.from(table).delete().not(pk, 'is', null);
    if (error) {
      throw new SeedSnapshotError(`Could not clear demo table "${table}": ${error.message}`);
    }
    cleared.push(table);
  }
  return { cleared, skipped: [] };
}
