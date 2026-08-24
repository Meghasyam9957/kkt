/**
 * ADAPTER SAFETY — the guarantees that protect the V1 workbook.
 *
 * These assert the *structural* protections, not good intentions: the app must be unable
 * to write a formula column, unable to write the shared reporting-month cell, and unable
 * to write a calculated sheet, even if a future caller asks it to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  InMemorySheetsClient, assertWritable, SheetWriteForbiddenError, parseQualifiedRange,
} from '@/lib/server/sheets/client';
import {
  buildInputRow, ReservationRepository, RevenueRepository, ExpenseRepository,
  PropertyRepository, InvestorRepository, loadWorkbookData, createRepositories,
} from '@/lib/server/sheets/repositories';
import {
  SHEETS, COLUMNS, DATA_ROW, inputColumns, dataRange, monthlyBlockRange, CALC,
  FORBIDDEN_WRITE_CELL,
} from '@/lib/contract/contract.generated';
import { baseline } from './fixtures/scenarios';

/** Build an in-memory workbook whose grids match the contract layout. */
function makeClient(): InMemorySheetsClient {
  const client = new InMemorySheetsClient();
  for (const sheetKey of Object.keys(COLUMNS)) {
    const cols = COLUMNS[sheetKey]!;
    const headerRow = cols.map((c) => c.header);
    const blank = Array(cols.length).fill(null);
    client.setSheet((SHEETS as Record<string, string>)[sheetKey]!, [
      [], [], headerRow, ...Array.from({ length: 20 }, () => [...blank]),
    ]);
  }
  return client;
}

describe('write safety — Decision D1 and calculated-column protection', () => {
  it('refuses to write the shared reporting-month cell', () => {
    expect(() => assertWritable(`'${SHEETS.DASHBOARD}'!${FORBIDDEN_WRITE_CELL}`))
      .toThrow(SheetWriteForbiddenError);
  });

  it('refuses to write anywhere on the dashboard', () => {
    expect(() => assertWritable(`'${SHEETS.DASHBOARD}'!A50`)).toThrow(SheetWriteForbiddenError);
  });

  it('refuses to write calculated / reporting sheets', () => {
    for (const sheet of [SHEETS.CALC, SHEETS.PNL, SHEETS.ANALYTICS, SHEETS.QA, SHEETS.GUIDE]) {
      expect(() => assertWritable(`'${sheet}'!A4`), sheet).toThrow(SheetWriteForbiddenError);
    }
  });

  it('allows writes to transactional input sheets', () => {
    for (const sheet of [SHEETS.RESERVATIONS, SHEETS.REVENUE, SHEETS.EXPENSES, SHEETS.CASHFLOW]) {
      expect(() => assertWritable(`'${sheet}'!A4`), sheet).not.toThrow();
    }
  });

  it('rejects unqualified ranges rather than guessing the sheet', () => {
    expect(() => parseQualifiedRange('A1:B2')).toThrow();
  });

  it('buildInputRow refuses a calculated column by name', () => {
    // 04_RESERVATIONS.Nights is an ARRAYFORMULA owned by the workbook.
    expect(() => buildInputRow('RESERVATIONS', { BookingID: 'BK-1', Nights: 5 }))
      .toThrow(/calculated column/i);
  });

  it('buildInputRow emits null for every calculated column', () => {
    const row = buildInputRow('RESERVATIONS', { BookingID: 'BK-1', RoomRevenue: 1000 });
    const cols = COLUMNS.RESERVATIONS!;
    cols.forEach((col, i) => {
      if (col.role === 'calc') {
        expect(row[i], `${col.key} must be left to the workbook`).toBeNull();
      }
    });
    expect(row).toHaveLength(cols.length);
  });

  it('every sheet has calculated columns that stay unwritable', () => {
    const writable = inputColumns('RESERVATIONS').map((c) => c.key);
    expect(writable).not.toContain('Nights');
    expect(writable).not.toContain('ExpectedPayout');
    expect(writable).not.toContain('RowIssues');
    expect(writable).toContain('BookingID');
    expect(writable).toContain('RoomRevenue');
  });

  it('updateById refuses to patch a calculated column', async () => {
    const client = makeClient();
    const repo = new ReservationRepository(client);
    await repo.append([{ BookingID: 'BK-1', PropertyID: 'HYD-501', RoomRevenue: 100 }]);
    await expect(repo.updateById('BK-1', { Nights: 9 })).rejects.toThrow(/calculated column/i);
  });
});

describe('adapter capabilities', () => {
  it('appends and reads back a reservation', async () => {
    const client = makeClient();
    const repo = new ReservationRepository(client);
    const result = await repo.append([
      { BookingID: 'BK-2026-0001', PropertyID: 'HYD-501', Platform: 'Airbnb',
        BookingStatus: 'Confirmed', RoomRevenue: 12000, GuestName: 'Test Guest' },
    ]);
    expect(result.updatedRows).toBe(1);

    const all = await repo.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.BookingID).toBe('BK-2026-0001');
    expect(all[0]!.RoomRevenue).toBe(12000);
    expect(all[0]!.Platform).toBe('Airbnb');
  });

  it('updates an input cell by record id and leaves other cells alone', async () => {
    const client = makeClient();
    const repo = new ReservationRepository(client);
    await repo.append([{ BookingID: 'BK-1', PropertyID: 'HYD-501', RoomRevenue: 100, GuestName: 'A' }]);
    await repo.updateById('BK-1', { RoomRevenue: 250 });

    const [row] = await repo.readAll();
    expect(row!.RoomRevenue).toBe(250);
    expect(row!.GuestName).toBe('A');
    expect(client.writeLog.some((w) => w.kind === 'update')).toBe(true);
  });

  it('skips blank template rows when reading', async () => {
    const client = makeClient();
    const repo = new RevenueRepository(client);
    await repo.append([{ RevenueID: 'REV-1', GrossAmount: 500 }]);
    const all = await repo.readAll();
    expect(all).toHaveLength(1); // not the 20 blank prepared rows
  });

  it('reads the whole workbook in a single batch round trip', async () => {
    const client = makeClient();
    let batchCalls = 0;
    const original = client.batchGet.bind(client);
    client.batchGet = async (ranges) => { batchCalls++; return original(ranges); };

    await loadWorkbookData(client);
    // One batch for the settings named ranges, one for every ledger.
    expect(batchCalls).toBeLessThanOrEqual(2);
  });

  it('exposes exactly the repositories the architecture specifies', () => {
    const repos = createRepositories(makeClient());
    for (const name of ['properties', 'reservations', 'revenue', 'expenses', 'capex',
      'cashflow', 'investors', 'distributions', 'settings', 'analytics'] as const) {
      expect(repos[name], name).toBeDefined();
    }
  });

  it('round-trips a full fixture through the sheet layer without loss', async () => {
    const client = makeClient();
    const scenario = baseline();
    const repos = createRepositories(client);

    await repos.properties.append(scenario.data.properties.map((p) => ({ ...p })));
    await repos.reservations.append(scenario.data.reservations.map((b) => ({ ...b })));
    await repos.revenue.append(scenario.data.revenue.map((r) => ({ ...r })));
    await repos.expenses.append(scenario.data.expenses.map((e) => ({ ...e })));
    await repos.investors.append(scenario.data.investors.map((i) => ({ ...i })));

    expect(await repos.properties.readAll()).toHaveLength(4);
    expect(await repos.reservations.readAll()).toHaveLength(4);
    expect(await repos.revenue.readAll()).toHaveLength(4);
    expect(await repos.expenses.readAll()).toHaveLength(4);
    expect(await repos.investors.readAll()).toHaveLength(3);

    const revenue = await repos.revenue.readAll();
    expect(revenue.reduce((s, r) => s + r.GrossAmount, 0)).toBe(46000);
  });
});

describe('range construction from the contract', () => {
  it('builds sheet-qualified data ranges from registry order', () => {
    const range = dataRange('RESERVATIONS');
    expect(range).toContain(SHEETS.RESERVATIONS);
    expect(range).toContain(`A${DATA_ROW}`);
  });

  it('the monthly block range covers the FY block and nothing report-month dependent', () => {
    const range = monthlyBlockRange();
    expect(range).toContain(SHEETS.CALC);
    // Column N is the FY total; the report-month KPI block lives further right at Q.
    expect(range).toContain(CALC.totalColA1);
    expect(range).not.toContain(CALC.reportMonthDependent.kpiValueColA1 + '3');
  });

  /**
   * Decision D1: the application must never write CFG_REPORT_MONTH to choose a reporting
   * period, so it must never depend on the 99_CALC blocks that key off it.
   *
   * The readers exist — LIVE parity needs them to see what Google's formula engine
   * produced — but nothing the application serves may call them. This walks the source
   * instead of the prototype, because "the method does not exist" stopped being the
   * invariant the moment parity needed it. What matters is who calls it.
   */
  it('no application code path reads a report-month-dependent block', () => {
    const READERS = /readReportMonth|readReportMonthKpis|readPropertyBlock|readPlatformBlock|readExpenseCategoryBlock/;
    const roots = ['lib/data', 'lib/server', 'app', 'components'];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // The repository is where the readers are DEFINED; everywhere else is a caller.
        if (full.split(path.sep).join('/').endsWith('lib/server/sheets/repositories/index.ts')) continue;
        if (READERS.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(process.cwd(), full).split(path.sep).join('/'));
        }
      }
    };
    for (const root of roots) {
      const abs = path.resolve(process.cwd(), root);
      if (fs.existsSync(abs)) walk(abs);
    }

    expect(offenders, `report-month readers called outside the parity harness: ${offenders.join(', ')}`)
      .toEqual([]);
  });
});
