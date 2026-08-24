/**
 * PARITY GATE — the release gate for Phase 2.
 *
 * Three layers, each proving something the others cannot:
 *
 *   L1 CONTRACT  — the generated TypeScript contract matches the V1 registry exactly.
 *   L2 CROSS-IMPL— the TS engine and V1's own independent JavaScript recomputation
 *                  produce identical numbers on identical data.
 *   L3 ABSOLUTE  — hand-computed expected values, so both implementations agreeing on
 *                  the *wrong* number is still caught.
 *
 * Results are written to reports/parity.json for the parity report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { V1Bridge } from './support/v1-bridge';
import { allScenarios, baseline, lossAndRecovery, zeroRevenue, rulesUnset, singleInvestor,
  partialPayout, blockedUnit, distributionsMixed, FY_START } from './fixtures/scenarios';
import {
  computeMonthlySeries, computeByProperty, computeByPlatform, computeInvestorWaterfall,
  computeInvestorAllocations, computeFyTotals, monthPeriod, expectedPayout, pendingReceivables,
  investorShareCheck, fyMonthKeysFor,
} from '@/lib/server/analytics/kpi';
import { COLUMNS, SHEETS, LISTS, CALC, DATA_ROW } from '@/lib/contract/contract.generated';

/* ------------------------------------------------------------------ *
 * Report collection
 * ------------------------------------------------------------------ */

interface ParityRow {
  layer: 'L1 contract' | 'L2 cross-impl' | 'L3 absolute';
  scenario: string;
  metric: string;
  sheet: number | string;
  typescript: number | string;
  difference: number | string;
  pass: boolean;
}

const rows: ParityRow[] = [];
const TOLERANCE = 0.01; // ₹0.01 — floating point only, not a business allowance

function record(
  layer: ParityRow['layer'], scenario: string, metric: string,
  sheetValue: number | string, tsValue: number | string,
): ParityRow {
  const bothNumbers = typeof sheetValue === 'number' && typeof tsValue === 'number';
  const difference = bothNumbers ? Number((tsValue - sheetValue).toFixed(6)) : (sheetValue === tsValue ? 0 : 'MISMATCH');
  const pass = bothNumbers ? Math.abs(tsValue - sheetValue) <= TOLERANCE : sheetValue === tsValue;
  const row: ParityRow = { layer, scenario, metric, sheet: sheetValue, typescript: tsValue, difference, pass };
  rows.push(row);
  return row;
}

/** Assert through the recorder so every comparison reaches the report, pass or fail. */
function expectParity(
  layer: ParityRow['layer'], scenario: string, metric: string,
  sheetValue: number | string, tsValue: number | string,
) {
  const row = record(layer, scenario, metric, sheetValue, tsValue);
  expect(row.pass, `${scenario} · ${metric}: V1=${sheetValue} TS=${tsValue} Δ=${row.difference}`).toBe(true);
}

afterAll(() => {
  const dir = path.resolve(process.cwd(), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    passed: rows.filter((r) => r.pass).length,
    failed: rows.filter((r) => !r.pass).length,
    byLayer: ['L1 contract', 'L2 cross-impl', 'L3 absolute'].map((layer) => ({
      layer,
      total: rows.filter((r) => r.layer === layer).length,
      failed: rows.filter((r) => r.layer === layer && !r.pass).length,
    })),
    rows,
  };
  fs.writeFileSync(path.join(dir, 'parity.json'), JSON.stringify(summary, null, 2));
});

/* ================================================================== *
 * L1 — CONTRACT PARITY
 * ================================================================== */

describe('L1 · contract parity with the V1 workbook', () => {
  let v1: any;

  beforeAll(async () => {
    const vmMod = await import('node:vm');
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const v1Root = path.resolve(process.cwd(), '..', 'homestay-ops');
    const sandbox: any = {};
    vmMod.createContext(sandbox);
    vmMod.runInContext(fs.readFileSync(path.join(v1Root, 'src', '00_constants.gs'), 'utf8'), sandbox);
    v1 = sandbox;
    void req;
  });

  it('sheet names match exactly', () => {
    for (const [key, name] of Object.entries(SHEETS)) {
      expectParity('L1 contract', 'contract', `SHEETS.${key}`, v1.SHEETS[key], name);
    }
  });

  it('every column key, order, A1 letter and role matches', () => {
    let checked = 0;
    for (const [sheetKey, cols] of Object.entries(COLUMNS)) {
      const sheetName = (SHEETS as Record<string, string>)[sheetKey]!;
      const v1Cols = v1.COLUMNS[sheetName];
      expect(v1Cols, `V1 has no columns for ${sheetName}`).toBeDefined();
      expect(cols.length).toBe(v1Cols.length);
      cols.forEach((col, i) => {
        expect(col.key, `${sheetKey}[${i}] key`).toBe(v1Cols[i].k);
        expect(col.header, `${sheetKey}.${col.key} header`).toBe(v1Cols[i].h);
        expect(col.role, `${sheetKey}.${col.key} role`).toBe(v1Cols[i].role === 'calc' ? 'calc' : 'in');
        expect(col.index, `${sheetKey}.${col.key} index`).toBe(i + 1);
        checked++;
      });
    }
    expectParity('L1 contract', 'contract', 'columns verified', checked, checked);
    expect(checked).toBe(261);
  });

  it('dropdown lists match exactly', () => {
    for (const [name, values] of Object.entries(LISTS)) {
      expect(values, `LISTS.${name}`).toEqual(v1.LISTS[name]);
    }
    expectParity('L1 contract', 'contract', 'lists verified', Object.keys(v1.LISTS).length, Object.keys(LISTS).length);
  });

  it('99_CALC monthly row addresses match', () => {
    for (const [metric, row] of Object.entries(CALC.monthlyRows)) {
      expectParity('L1 contract', 'contract', `99_CALC row ${metric}`, v1.CALC.M[metric], row);
    }
  });

  it('data row and 12-month layout match', () => {
    expectParity('L1 contract', 'contract', 'DATA_ROW', v1.DATA_ROW, DATA_ROW);
    expectParity('L1 contract', 'contract', 'CALC.months', v1.CALC.MONTHS, CALC.months);
    expectParity('L1 contract', 'contract', 'CALC.firstMonthCol', v1.CALC.FIRST_MONTH_COL, CALC.firstMonthCol);
  });
});

/* ================================================================== *
 * L2 — CROSS-IMPLEMENTATION PARITY (TS engine vs V1's own JS)
 * ================================================================== */

describe('L2 · TypeScript engine vs V1 independent recomputation', () => {
  let bridge: V1Bridge;

  beforeAll(() => {
    bridge = new V1Bridge();
  });

  for (const scenario of allScenarios()) {
    it(`${scenario.id} — ${scenario.title}`, () => {
      bridge.loadFixture(scenario.data);
      const series = computeMonthlySeries(scenario.data, scenario.months);

      for (const month of scenario.months) {
        const ts = series.find((m) => m.monthKey === month)!;
        const v1 = bridge.monthNumbers(month);
        const tag = `${scenario.id} ${month}`;

        expectParity('L2 cross-impl', tag, 'net revenue', v1.netRevenue, ts.netRevenue);
        expectParity('L2 cross-impl', tag, 'operating expenses', v1.operatingExpenses, ts.operatingExpenses);
        expectParity('L2 cross-impl', tag, 'operating profit', v1.operatingProfit, ts.operatingProfit);
        expectParity('L2 cross-impl', tag, 'occupied nights', v1.occupiedNights, ts.occupiedNights);
        expectParity('L2 cross-impl', tag, 'room gross revenue', v1.roomGrossRevenue, ts.roomRevenue);
      }
    });
  }

  it('full V1 QA pass agrees with the engine (baseline, April)', () => {
    const scenario = baseline();
    bridge.loadFixture(scenario.data);
    const qa = bridge.runQa('2026-04');
    const ts = computeMonthlySeries(scenario.data, ['2026-04'])[0]!;

    const map: Array<[string, number]> = [
      ['MTD net revenue', ts.netRevenue],
      ['MTD operating expenses', ts.operatingExpenses],
      ['MTD operating profit', ts.operatingProfit],
      ['Occupied nights (month)', ts.occupiedNights],
      ['Occupancy %', ts.occupancyPct],
      ['ADR (month)', ts.adr],
      ['Distributable profit (month)', ts.distributableProfit],
      ['Investor pool amount (month)', ts.investorPoolAmt],
      ['Pending receivables', pendingReceivables(scenario.data)],
    ];
    for (const [testName, tsValue] of map) {
      const v1Value = bridge.qaExpected(qa, testName);
      expect(v1Value, `V1 QA did not produce "${testName}"`).toBeTypeOf('number');
      expectParity('L2 cross-impl', 'S1-baseline QA', testName, v1Value!, Number(tsValue.toFixed(2)));
    }
  });

  it('expected payout agrees per booking (OTA reconciliation)', () => {
    const scenario = partialPayout();
    bridge.loadFixture(scenario.data);
    for (const b of scenario.data.reservations) {
      expectParity(
        'L2 cross-impl', 'S6-partial-payout', `expected payout ${b.BookingID}`,
        bridge.expectedPayout(b.BookingID),
        expectedPayout(b, scenario.data.settings),
      );
    }
  });
});

/* ================================================================== *
 * L3 — ABSOLUTE PARITY (hand-computed expectations)
 * ================================================================== */

describe('L3 · hand-computed expectations', () => {
  it('S1 baseline — every headline figure', () => {
    const s = baseline();
    const m = computeMonthlySeries(s.data, ['2026-04'])[0]!;
    const tag = 'S1-baseline';
    expectParity('L3 absolute', tag, 'active units', 4, m.activeUnits);
    expectParity('L3 absolute', tag, 'available nights (30d × 4)', 120, m.availableNights);
    expectParity('L3 absolute', tag, 'occupied nights (cancelled excluded)', 10, m.occupiedNights);
    expectParity('L3 absolute', tag, 'occupancy %', 10 / 120, m.occupancyPct);
    expectParity('L3 absolute', tag, 'room revenue', 45000, m.roomRevenue);
    expectParity('L3 absolute', tag, 'cleaning revenue', 1000, m.cleaningRevenue);
    expectParity('L3 absolute', tag, 'gross revenue', 46000, m.grossRevenue);
    expectParity('L3 absolute', tag, 'platform fees', 7110, m.platformFees);
    expectParity('L3 absolute', tag, 'net revenue', 38890, m.netRevenue);
    expectParity('L3 absolute', tag, 'operating expenses (CAPEX row excluded)', 4680, m.operatingExpenses);
    expectParity('L3 absolute', tag, 'operating profit', 34210, m.operatingProfit);
    expectParity('L3 absolute', tag, 'ADR', 4500, m.adr);
    expectParity('L3 absolute', tag, 'RevPAR', 375, m.revPar);
    expectParity('L3 absolute', tag, 'bookings count', 3, m.bookingsCount);
    expectParity('L3 absolute', tag, 'cancelled count', 1, m.cancelledCount);
    expectParity('L3 absolute', tag, 'cancellation rate', 1 / 4, m.cancellationRatePct);
    expectParity('L3 absolute', tag, 'ALOS (10 nights / 3 bookings)', 10 / 3, m.alos);
    expectParity('L3 absolute', tag, 'CAPEX (memo, not OpEx)', 45000, m.capexTotal);
    expectParity('L3 absolute', tag, 'reserve 5%', 1710.5, m.reserveAmt);
    expectParity('L3 absolute', tag, 'distributable profit', 32499.5, m.distributableProfit);
    expectParity('L3 absolute', tag, 'investor pool 60%', 19499.7, m.investorPoolAmt);
    expectParity('L3 absolute', tag, 'net cash', 20000, m.netCash);
  });

  it('S1 baseline — CAPEX never enters operating profit', () => {
    const s = baseline();
    const m = computeMonthlySeries(s.data, ['2026-04'])[0]!;
    // 45,000 CAPEX + a 20,000 CAPEX-typed expense row are both outside OpEx.
    expectParity('L3 absolute', 'S1-baseline', 'CAPEX excluded from OpEx', 4680, m.operatingExpenses);
    expect(m.operatingExpenses).toBeLessThan(m.capexTotal);
  });

  it('S2 — loss month, carry-forward and recovery', () => {
    const s = lossAndRecovery();
    const series = computeMonthlySeries(s.data, s.months);
    const [apr, may, jun] = series as [typeof series[0], typeof series[0], typeof series[0]];

    expectParity('L3 absolute', 'S2 Apr', 'operating profit (loss)', -20000, apr.operatingProfit);
    expectParity('L3 absolute', 'S2 Apr', 'reserve on a loss = 0', 0, apr.reserveAmt);
    expectParity('L3 absolute', 'S2 Apr', 'distributable (loss ⇒ 0)', 0, apr.distributableProfit);
    expectParity('L3 absolute', 'S2 Apr', 'investor pool (loss ⇒ 0)', 0, apr.investorPoolAmt);
    expectParity('L3 absolute', 'S2 Apr', 'carry-forward balance', -20000, apr.carryForwardBalance);

    expectParity('L3 absolute', 'S2 May', 'operating profit', 30000, may.operatingProfit);
    expectParity('L3 absolute', 'S2 May', 'reserve 5%', 1500, may.reserveAmt);
    expectParity('L3 absolute', 'S2 May', 'carry-forward applied', 20000, may.carryForwardApplied);
    expectParity('L3 absolute', 'S2 May', 'distributable after recovery', 8500, may.distributableProfit);
    expectParity('L3 absolute', 'S2 May', 'balance cleared', 0, may.carryForwardBalance);

    expectParity('L3 absolute', 'S2 Jun', 'carry-forward applied (none left)', 0, jun.carryForwardApplied);
    expectParity('L3 absolute', 'S2 Jun', 'distributable', 14250, jun.distributableProfit);
  });

  it('S2 — a loss NEVER produces a positive investor distribution', () => {
    const s = lossAndRecovery();
    const alloc = computeInvestorAllocations(s.data, '2026-04');
    for (const a of alloc) {
      expectParity('L3 absolute', 'S2 Apr', `distribution ${a.investorId} on a loss`, 0, a.calculatedDistribution);
    }
  });

  it('S3 — zero revenue yields zeros, never NaN or Infinity', () => {
    const s = zeroRevenue();
    const m = computeMonthlySeries(s.data, ['2026-04'])[0]!;
    for (const [name, value] of Object.entries({
      'net revenue': m.netRevenue, occupancy: m.occupancyPct, ADR: m.adr,
      RevPAR: m.revPar, margin: m.operatingMarginPct, ALOS: m.alos,
      'cancellation rate': m.cancellationRatePct, 'investor pool': m.investorPoolAmt,
    })) {
      expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
      expectParity('L3 absolute', 'S3-zero-revenue', name, 0, value);
    }
    expectParity('L3 absolute', 'S3-zero-revenue', 'operating profit (expenses only)', -5000, m.operatingProfit);
  });

  it('S4 — unset investor rules calculate zero and report "not configured"', () => {
    const s = rulesUnset();
    const w = computeInvestorWaterfall(s.data, '2026-04');
    expect(w.configured).toBe(false);
    expect(w.configurationMessage).toContain('MANAGEMENT DECISION REQUIRED');
    expectParity('L3 absolute', 'S4-rules-tbd', 'investor pool with rules TBD', 0, w.investorPoolAmt);
    expectParity('L3 absolute', 'S4-rules-tbd', 'operator share with rules TBD', 0, w.operatorShare);
    expectParity('L3 absolute', 'S4-rules-tbd', 'reserve with rule TBD', 0, w.reserve);
    // Profit itself is unaffected — only the *split* is withheld.
    expectParity('L3 absolute', 'S4-rules-tbd', 'operating profit still reported', 34210, w.operatingProfit);
    for (const a of computeInvestorAllocations(s.data, '2026-04')) {
      expect(a.status).toBe('Not configured');
      expectParity('L3 absolute', 'S4-rules-tbd', `allocation ${a.investorId}`, 0, a.calculatedDistribution);
    }
  });

  it('S5 — single investor takes the whole pool', () => {
    const s = singleInvestor();
    const alloc = computeInvestorAllocations(s.data, '2026-04');
    expect(alloc).toHaveLength(1);
    expectParity('L3 absolute', 'S5-single-investor', 'sole investor distribution', 19499.7, alloc[0]!.calculatedDistribution);
  });

  it('S8 — three investors reconcile exactly to the pool', () => {
    const s = distributionsMixed();
    const w = computeInvestorWaterfall(s.data, '2026-04');
    const alloc = computeInvestorAllocations(s.data, '2026-04');
    const sum = alloc.reduce((t, a) => t + a.calculatedDistribution, 0);

    expectParity('L3 absolute', 'S8-distributions', 'Σ allocations = investor pool', w.investorPoolAmt, Number(sum.toFixed(6)));
    expect(sum).toBeLessThanOrEqual(w.investorPoolAmt + 0.01);

    expectParity('L3 absolute', 'S8-distributions', 'INV-001 40%', 7799.88, alloc[0]!.calculatedDistribution);
    expectParity('L3 absolute', 'S8-distributions', 'INV-002 35%', 6824.895, alloc[1]!.calculatedDistribution);
    expectParity('L3 absolute', 'S8-distributions', 'INV-003 25%', 4874.925, alloc[2]!.calculatedDistribution);

    expect(alloc[0]!.status).toBe('Paid');
    expect(alloc[1]!.status).toBe('Partial');
    expect(alloc[2]!.status).toBe('Pending');
    expectParity('L3 absolute', 'S8-distributions', 'INV-002 pending', 3824.895, alloc[1]!.pendingAmount);
    expectParity('L3 absolute', 'S8-distributions', 'INV-003 pending', 4874.925, alloc[2]!.pendingAmount);

    const share = investorShareCheck(s.data);
    expect(share.ok).toBe(true);
    expectParity('L3 absolute', 'S8-distributions', 'active participation total', 1, share.total);
  });

  it('S8 — investor isolation: a filtered query returns only that investor', () => {
    const s = distributionsMixed();
    const own = computeInvestorAllocations(s.data, '2026-04', { investorId: 'INV-002' });
    expect(own).toHaveLength(1);
    expect(own[0]!.investorId).toBe('INV-002');
    expectParity('L3 absolute', 'S8-distributions', 'investor-scoped rows', 1, own.length);
  });

  it('S6 — partial payout and commission-estimated fee', () => {
    const s = partialPayout();
    const [b1, b2] = s.data.reservations as [any, any];
    expectParity('L3 absolute', 'S6-partial-payout', 'expected payout (fee entered)', 17850, expectedPayout(b1, s.data.settings));
    expectParity('L3 absolute', 'S6-partial-payout', 'expected payout (fee estimated 18%)', 12300, expectedPayout(b2, s.data.settings));
    expectParity('L3 absolute', 'S6-partial-payout', 'pending receivables', 7850, pendingReceivables(s.data));
  });

  it('S7 — a Blocked unit leaves the capacity denominator', () => {
    const s = blockedUnit();
    const m = computeMonthlySeries(s.data, ['2026-04'])[0]!;
    expectParity('L3 absolute', 'S7-blocked-unit', 'active units', 3, m.activeUnits);
    expectParity('L3 absolute', 'S7-blocked-unit', 'available nights (30 × 3)', 90, m.availableNights);
    expectParity('L3 absolute', 'S7-blocked-unit', 'RevPAR on 90 nights', 500, m.revPar);
  });

  it('property filtering — per-property figures sum back to the whole', () => {
    const s = baseline();
    const p = monthPeriod('2026-04');
    const all = computeByProperty(s.data, p);
    const one = computeByProperty(s.data, p, { propertyId: 'HYD-501' });

    expect(all).toHaveLength(4);
    expect(one).toHaveLength(1);
    expectParity('L3 absolute', 'property filter', 'HYD-501 net revenue', 22250, one[0]!.netRevenue);
    expectParity('L3 absolute', 'property filter', 'HYD-501 direct OpEx', 2000, one[0]!.directOperatingExpenses);
    expectParity('L3 absolute', 'property filter', 'HYD-501 profit', 20250, one[0]!.profit);
    expectParity('L3 absolute', 'property filter', 'HYD-501 occupied nights', 5, one[0]!.occupiedNights);
    expectParity('L3 absolute', 'property filter', 'HYD-501 ADR', 5000, one[0]!.adr);

    // Direct costs only: the COMMON row (1,500) is deliberately unallocated.
    const directSum = all.reduce((t, r) => t + r.directOperatingExpenses, 0);
    const monthly = computeMonthlySeries(s.data, ['2026-04'])[0]!;
    expectParity('L3 absolute', 'property filter', 'Σ direct OpEx + COMMON = total OpEx',
      monthly.operatingExpenses, directSum + 1500);

    const netSum = all.reduce((t, r) => t + r.netRevenue, 0);
    expectParity('L3 absolute', 'property filter', 'Σ property net revenue = month net revenue',
      monthly.netRevenue, netSum);
  });

  it('platform filtering — OTA mix sums back to the whole', () => {
    const s = baseline();
    const p = monthPeriod('2026-04');
    const mix = computeByPlatform(s.data, p);
    const airbnb = mix.find((x) => x.platform === 'Airbnb')!;
    const bcom = mix.find((x) => x.platform === 'Booking.com')!;

    expectParity('L3 absolute', 'platform filter', 'Airbnb gross (25000+1000+8000)', 34000, airbnb.grossRevenue);
    expectParity('L3 absolute', 'platform filter', 'Airbnb fees (3750+1200)', 4950, airbnb.feesAndDeductions);
    expectParity('L3 absolute', 'platform filter', 'Airbnb net', 29050, airbnb.netRevenue);
    expectParity('L3 absolute', 'platform filter', 'Airbnb bookings', 2, airbnb.bookings);
    expectParity('L3 absolute', 'platform filter', 'Booking.com net', 9840, bcom.netRevenue);

    const monthly = computeMonthlySeries(s.data, ['2026-04'])[0]!;
    const netSum = mix.reduce((t, r) => t + r.netRevenue, 0);
    expectParity('L3 absolute', 'platform filter', 'Σ platform net = month net revenue', monthly.netRevenue, netSum);

    const filtered = computeByPlatform(s.data, p, { platform: 'Airbnb' });
    expect(filtered).toHaveLength(1);
    expectParity('L3 absolute', 'platform filter', 'filtered rows', 1, filtered.length);
  });

  it('FY totals sum additive rows and RECOMPUTE ratios', () => {
    const s = lossAndRecovery();
    const series = computeMonthlySeries(s.data, fyMonthKeysFor(s.data));
    const fy = computeFyTotals(series);
    expectParity('L3 absolute', 'FY totals', 'FY net revenue (10k+50k+20k)', 80000, fy.netRevenue);
    expectParity('L3 absolute', 'FY totals', 'FY operating expenses', 55000, fy.operatingExpenses);
    expectParity('L3 absolute', 'FY totals', 'FY operating profit', 25000, fy.operatingProfit);
    // A summed occupancy column would exceed 1; a recomputed one cannot.
    expect(fy.occupancyPct).toBeLessThanOrEqual(1);
    expectParity('L3 absolute', 'FY totals', 'FY occupancy (no bookings)', 0, fy.occupancyPct);
  });

  it('financial year starts where 02_SETTINGS says it does', () => {
    const s = baseline();
    const keys = fyMonthKeysFor(s.data);
    expect(keys).toHaveLength(12);
    expectParity('L3 absolute', 'FY window', 'first FY month', '2026-04', keys[0]!);
    expectParity('L3 absolute', 'FY window', 'last FY month', '2027-03', keys[11]!);
    expect(FY_START).toBeGreaterThan(0);
  });
});
