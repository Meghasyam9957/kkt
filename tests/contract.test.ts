/**
 * CONTRACT INTEGRITY — proves the generated contract is current and self-consistent.
 * A drift here means the V1 workbook changed and the web app has not been reviewed
 * against it; CI must fail rather than let the two diverge quietly.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  SHEETS, COLUMNS, LISTS, CALC, ID_RULES, BUSINESS_RULES, REQUIRED_NAMED_RANGES,
  READ_ONLY_SHEETS, FORBIDDEN_WRITE_CELL, column, columnIndex, inputColumns, CONTRACT_HASH,
} from '@/lib/contract/contract.generated';

describe('generated contract', () => {
  it('is up to date with the V1 workbook (no drift)', () => {
    const out = execFileSync(process.execPath, ['lib/contract/generate.mjs', '--check'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(out).toContain('contract:check OK');
  });

  it('carries a stable hash committed alongside it', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'lib/contract/contract.lock.json'), 'utf8'));
    expect(lock.contractModelHash).toBe(CONTRACT_HASH);
  });

  it('covers all 22 V1 sheets', () => {
    expect(Object.keys(SHEETS)).toHaveLength(22);
    expect(SHEETS.RESERVATIONS).toBe('04_RESERVATIONS');
    expect(SHEETS.CALC).toBe('99_CALC');
  });

  it('column A1 letters follow registry order without gaps', () => {
    for (const [sheetKey, cols] of Object.entries(COLUMNS)) {
      cols.forEach((col, i) => {
        expect(col.index, `${sheetKey}.${col.key}`).toBe(i + 1);
        expect(columnIndex(sheetKey as never, col.key)).toBe(i);
      });
    }
  });

  it('every list-validated column points at a list that exists', () => {
    for (const cols of Object.values(COLUMNS)) {
      for (const col of cols) {
        if (col.list) expect(LISTS[col.list as keyof typeof LISTS], col.list).toBeDefined();
        if (col.range) expect(REQUIRED_NAMED_RANGES).toContain(col.range);
      }
    }
  });

  it('ID prefixes match the V1 conventions', () => {
    expect(ID_RULES['04_RESERVATIONS'].prefix).toBe('BK-{y}-');
    expect(ID_RULES['05_REVENUE'].prefix).toBe('REV-{y}-');
    expect(ID_RULES['06_EXPENSES'].prefix).toBe('EXP-{y}-');
    expect(ID_RULES['07_CAPEX_SETUP'].prefix).toBe('CAP-{y}-');
    expect(ID_RULES['14_MAINTENANCE'].prefix).toBe('MNT-{y}-');
    expect(ID_RULES['13_HOUSEKEEPING'].prefix).toBe('HK-{y}-');
    expect(ID_RULES['11_INVESTORS'].prefix).toBe('INV-');
  });

  it('marks the shared reporting-month cell as forbidden', () => {
    expect(FORBIDDEN_WRITE_CELL).toBe('C3');
    expect(READ_ONLY_SHEETS).toContain('CALC');
    expect(READ_ONLY_SHEETS).toContain('PNL');
  });

  it('records which business rules are live vs recorded-only', () => {
    const byName = Object.fromEntries(BUSINESS_RULES.map((r) => [r.name, r]));
    expect(byName.CFG_INVESTOR_POOL_PCT!.recordedOnly).toBe(false);
    expect(byName.CFG_RESERVE_PCT!.recordedOnly).toBe(false);
    // These four are collected by V1 but deliberately not wired into the math.
    expect(byName.CFG_PROFIT_DEFINITION!.recordedOnly).toBe(true);
    expect(byName.CFG_CAPEX_RECOVERY!.recordedOnly).toBe(true);
    expect(byName.CFG_DIST_FREQUENCY!.recordedOnly).toBe(true);
    expect(byName.CFG_MIN_CASH_RESERVE!.recordedOnly).toBe(true);
  });

  it('separates input columns from workbook-owned formula columns', () => {
    const all = Object.values(COLUMNS).flat();
    expect(all.filter((c) => c.role === 'in')).toHaveLength(227);
    expect(all.filter((c) => c.role === 'calc')).toHaveLength(34);
    expect(inputColumns('RESERVATIONS').every((c) => c.role === 'in')).toBe(true);
  });

  it('the FY monthly block is addressable and report-month independent', () => {
    expect(CALC.months).toBe(12);
    expect(CALC.firstMonthColA1).toBe('B');
    expect(CALC.lastMonthColA1).toBe('M');
    expect(CALC.monthlyRows.NetRevenue).toBeGreaterThan(0);
    expect(CALC.monthlyRows.CarryForwardBalance).toBeGreaterThan(0);
    // The report-month-dependent blocks are recorded but live under a separate key so
    // no reader can mistake them for safe.
    expect(CALC.reportMonthDependent.kpiValueColA1).toBe('Q');
  });

  it('column() throws loudly on an unknown key rather than returning undefined', () => {
    expect(() => column('RESERVATIONS', 'NoSuchColumn')).toThrow(/Unknown column/);
  });
});
