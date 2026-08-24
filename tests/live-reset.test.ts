/**
 * LIVE DEMO RESET (Phase D7) — capture/restore proven against the same client interface
 * the real workbook uses.
 *
 * The InMemorySheetsClient enforces the identical write-safety rules as the live client
 * (`assertWritable` runs in both), so what these tests prove — input cells restored,
 * added rows cleared, calc cells never addressed, read-back verified — holds for the
 * Google-backed client byte-for-byte at the interface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySheetsClient, type CellEdit } from '@/lib/server/sheets/client';
import { buildDemoSeed } from '@/lib/server/demo/workbook-grids';
import {
  captureSeedSnapshot, restoreSeedSnapshot, assertSnapshotUsable, resetDemoTechnicalState,
  SeedSnapshotError, SNAPSHOT_SHEETS, type SeedSnapshot,
} from '@/lib/server/demo/live-reset';
import { COLUMNS, SHEETS, DATA_ROW, CONTRACT_HASH } from '@/lib/contract/contract.generated';
import { resolveEnvironment } from '@/lib/server/environment/config';

function seededClient(): InMemorySheetsClient {
  const seed = buildDemoSeed();
  const client = new InMemorySheetsClient();
  for (const [sheetName, rows] of Object.entries(seed.grids)) client.setSheet(sheetName, rows);
  for (const [name, values] of seed.named) client.setNamedRange(name, values);
  return client;
}

const col = (sheet: keyof typeof COLUMNS, key: string) => {
  const spec = (COLUMNS[sheet] ?? []).find((c) => c.key === key);
  if (!spec) throw new Error(`no column ${String(sheet)}.${key}`);
  return spec;
};

describe('D7 · seed snapshot capture', () => {
  it('captures input cells for every table sheet, with positions preserved', async () => {
    const client = seededClient();
    const snapshot = await captureSeedSnapshot(client);

    expect(snapshot.version).toBe(1);
    expect(snapshot.contractHash).toBe(CONTRACT_HASH);
    for (const sheet of SNAPSHOT_SHEETS) {
      expect(snapshot.sheets[sheet], `snapshot must cover ${SHEETS[sheet]}`).toBeDefined();
    }
    // The demo seed trades: its transaction sheets must not come back empty.
    expect(snapshot.sheets.EXPENSES!.rows.length).toBeGreaterThan(0);
    expect(snapshot.sheets.RESERVATIONS!.rows.length).toBeGreaterThan(0);

    // Input keys follow the contract's input columns exactly.
    const expectedKeys = (COLUMNS.EXPENSES ?? []).filter((c) => c.role !== 'calc').map((c) => c.key);
    expect(snapshot.sheets.EXPENSES!.inputKeys).toEqual(expectedKeys);
    // Calculated columns are not captured — restoring must never address them.
    expect(snapshot.sheets.EXPENSES!.inputKeys).not.toContain('TotalAmount');
    expect(snapshot.sheets.RESERVATIONS!.inputKeys).not.toContain('GrossBookingValue');
  });
});

describe('D7 · restore returns the workbook to seed', () => {
  let client: InMemorySheetsClient;
  let snapshot: SeedSnapshot;

  beforeEach(async () => {
    client = seededClient();
    snapshot = await captureSeedSnapshot(client);
  });

  it('clears a row a demonstration added, restores an amended cell, and leaves calc cells alone', async () => {
    const expenses = SHEETS.EXPENSES;
    const idCol = col('EXPENSES', 'ExpenseID');
    const amountCol = col('EXPENSES', 'Amount');
    const totalCol = col('EXPENSES', 'TotalAmount');       // calc — must survive untouched
    const seedRows = snapshot.sheets.EXPENSES!.rows.length;
    const newRow = DATA_ROW + seedRows;                    // first blank input row

    // 1 · a demo "created" an expense (input cells only, as the pipeline writes them).
    await client.batchUpdate([
      { range: `'${expenses}'!${idCol.a1}${newRow}`, values: [['EXP-9999-0001']] },
      { range: `'${expenses}'!${amountCol.a1}${newRow}`, values: [[4321]] },
    ]);
    // The workbook's ARRAYFORMULA would fill the calc cell; simulate that output.
    const grid = await client.get(`'${expenses}'!A${newRow}:${totalCol.a1}${newRow}`);
    expect(grid.length).toBe(1);
    await forceCalcCell(client, expenses, `${totalCol.a1}${newRow}`, 4321);

    // 2 · a demo "amended" a seeded reservation (check-in flips its status).
    const statusCol = col('RESERVATIONS', 'BookingStatus');
    const statusIdx = snapshot.sheets.RESERVATIONS!.inputKeys.indexOf('BookingStatus');
    const seededStatus = snapshot.sheets.RESERVATIONS!.rows[0]![statusIdx];
    await client.batchUpdate([
      { range: `'${SHEETS.RESERVATIONS}'!${statusCol.a1}${DATA_ROW}`, values: [['Checked In']] },
    ]);

    // 3 · restore.
    const report = await restoreSeedSnapshot(client, snapshot);
    expect(report.sheets.EXPENSES!.clearedRows).toBe(1);
    expect(report.restoredRows).toBeGreaterThan(0);

    // The added row's INPUT cells are blank again…
    const idBack = await client.get(`'${expenses}'!${idCol.a1}${newRow}`);
    expect(idBack.length === 0 || idBack[0]![0] === '' || idBack[0]![0] === null).toBe(true);
    // …the amended cell carries its seeded value again…
    const statusBack = await client.get(`'${SHEETS.RESERVATIONS}'!${statusCol.a1}${DATA_ROW}`);
    expect(String(statusBack[0]![0])).toBe(String(seededStatus));
    // …and the calc cell was NEVER addressed by the reset (the workbook owns it).
    const calcBack = await client.get(`'${expenses}'!${totalCol.a1}${newRow}`);
    expect(calcBack[0]?.[0]).toBe(4321);
  });

  it('is idempotent: restoring an already-seeded workbook changes nothing and verifies clean', async () => {
    const report = await restoreSeedSnapshot(client, snapshot);
    expect(report.clearedRows).toBe(0);
    const again = await captureSeedSnapshot(client);
    expect(again.sheets).toEqual(snapshot.sheets);
  });

  it('FAILS LOUDLY when read-back does not match the seed, and refuses read-only sheets by construction', async () => {
    // A client that silently drops writes to one sheet models a mid-edit collision.
    const lying = new (class extends InMemorySheetsClient {
      override async batchUpdate(edits: CellEdit[]): Promise<void> {
        await super.batchUpdate(edits.filter((e) => !e.range.includes(SHEETS.EXPENSES)));
      }
    })();
    const seed = buildDemoSeed();
    for (const [sheetName, rows] of Object.entries(seed.grids)) lying.setSheet(sheetName, rows);

    const snap = await captureSeedSnapshot(lying);
    // Damage an expense input cell through the honest base class…
    const amountCol = col('EXPENSES', 'Amount');
    await InMemorySheetsClient.prototype.batchUpdate.call(lying, [
      { range: `'${SHEETS.EXPENSES}'!${amountCol.a1}${DATA_ROW}`, values: [[999999]] },
    ]);
    // …then restore through the lying override: the write is dropped, read-back differs.
    await expect(restoreSeedSnapshot(lying, snap)).rejects.toThrow(SeedSnapshotError);

    // And the snapshot never covers calculated/reporting sheets at all.
    for (const sheet of SNAPSHOT_SHEETS) {
      expect(['CALC', 'PNL', 'ANALYTICS', 'QA', 'GUIDE', 'DASHBOARD', 'SETTINGS']).not.toContain(sheet);
    }
  });
});

describe('D7 · snapshot safety checks', () => {
  it('refuses a snapshot from a different contract', async () => {
    const client = seededClient();
    const snapshot = await captureSeedSnapshot(client);
    const drifted = { ...snapshot, contractHash: 'deadbeefdeadbeef' };
    expect(() => assertSnapshotUsable(drifted)).toThrow(/captured under contract/);
    await expect(restoreSeedSnapshot(client, drifted)).rejects.toThrow(SeedSnapshotError);
  });

  it('refuses a snapshot missing a sheet or with drifted input columns', async () => {
    const client = seededClient();
    const snapshot = await captureSeedSnapshot(client);

    const missing = { ...snapshot, sheets: { ...snapshot.sheets } };
    delete (missing.sheets as Record<string, unknown>).EXPENSES;
    expect(() => assertSnapshotUsable(missing)).toThrow(/no entry for 06_EXPENSES/);

    const drifted = {
      ...snapshot,
      sheets: {
        ...snapshot.sheets,
        EXPENSES: { ...snapshot.sheets.EXPENSES!, inputKeys: [...snapshot.sheets.EXPENSES!.inputKeys].reverse() },
      },
    };
    expect(() => assertSnapshotUsable(drifted)).toThrow(/input columns for 06_EXPENSES/);
  });
});

describe('D7 · technical-state reset is demo-only', () => {
  it('throws outside the demo environment', async () => {
    const resolved = {
      ...resolveEnvironment({ APP_ENV: 'demo' }),
      env: 'production' as const,
    };
    await expect(resetDemoTechnicalState(resolved)).rejects.toThrow(/demo environment/);
  });

  it('reports the tables it would clear as skipped when Supabase is not configured', async () => {
    const resolved = resolveEnvironment({ APP_ENV: 'demo' });
    expect(resolved.supabase).toBeNull();
    const result = await resetDemoTechnicalState(resolved);
    expect(result.cleared).toEqual([]);
    expect(result.skipped).toEqual(['operations', 'id_allocations', 'id_sequences']);
  });
});

/** Poke a CALC cell directly into the grid, bypassing write-safety — this models the
 *  workbook's own formula output, which no client write path is allowed to produce. */
async function forceCalcCell(
  client: InMemorySheetsClient, sheetName: string, a1: string, value: number,
): Promise<void> {
  const rows = await client.get(`'${sheetName}'!A1:ZZ2000`);
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const colIdx = [...m[1]!].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const rowIdx = Number(m[2]) - 1;
  while (rows.length <= rowIdx) rows.push([]);
  const row = [...(rows[rowIdx] ?? [])];
  while (row.length <= colIdx) row.push(null);
  row[colIdx] = value;
  rows[rowIdx] = row;
  client.setSheet(sheetName, rows);
}
