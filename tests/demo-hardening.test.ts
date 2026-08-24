/**
 * PHASE 5B — DEMO HARDENING SUITE.
 *
 * Everything here protects the demonstration itself: that a client can never mistake
 * illustrative figures for agreed ones, that an operations board never leaks money, and
 * that no screen quietly reads demo fixtures in production.
 *
 * The last of those is not hypothetical. Three pages — Today, Properties and Investors —
 * imported the demo fixtures directly and would have rendered fictional tickets, units and
 * investors on a production deployment. The environment tests never caught it because they
 * tested the *provider*, and these pages bypassed the provider entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDemoDataset, DEMO_SAMPLE_BUSINESS_RULES, DEMO_INVESTOR_A, DEMO_INVESTOR_B,
} from '@/lib/data/demo/dataset';
import {
  demoStatus, setPresentationMode, resetDemoEnvironment, resetAvailable, setScenario,
  PresentationModeError, __resetDemoStoreForTests,
} from '@/lib/server/demo/store';
import { resolveEnvironment, DemoOnlyOperationError } from '@/lib/server/environment/config';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { computeMonthlySeries, computeByProperty, monthPeriod, fyMonthKeysFor } from '@/lib/server/analytics/kpi';
import { DEMO_SCENARIOS } from '@/lib/shared/environment';
import type { ReportFilters } from '@/lib/data/providers/types';

const ROOT = process.cwd();
const DEMO_ENV = resolveEnvironment({ APP_ENV: 'demo' });
const PRODUCTION_ENV = resolveEnvironment({ APP_ENV: 'production' });
const FILTERS: ReportFilters = { month: '', propertyId: null, platform: null };

beforeEach(() => { __resetDemoStoreForTests(); });
afterEach(() => { __resetDemoStoreForTests(); });

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/* ================================================================== *
 * 1 · No screen reads demo data behind the provider's back
 * ================================================================== */

describe('demo hardening · production can never render demo fixtures', () => {
  it('no page or component imports the demo dataset or fixtures directly', () => {
    // The exception is the demonstration screens themselves, which exist only in demo and
    // legitimately describe the dataset.
    const offenders = walk(path.join(ROOT, 'app'))
      .concat(walk(path.join(ROOT, 'components')))
      .filter((file) => !file.includes(path.join('app', 'admin', 'demo')))
      .filter((file) => !file.includes(path.join('components', 'demo')))
      .filter((file) => /@\/lib\/data\/(fixtures|demo)/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file).replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });

  it('the operations board comes from the provider, not from a fixture builder', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/admin/operations/today/page.tsx'), 'utf8');
    expect(source).toContain('provider.getOperations');
    expect(source).not.toContain('buildDemoOps');
  });

  it('the investor register and property master come from the provider', () => {
    const investors = fs.readFileSync(path.join(ROOT, 'app/admin/investors/page.tsx'), 'utf8');
    expect(investors).toContain('provider.getInvestorRegister');
    expect(investors).not.toContain('DEMO_INVESTORS');

    const properties = fs.readFileSync(path.join(ROOT, 'app/admin/properties/page.tsx'), 'utf8');
    expect(properties).not.toContain('DEMO_PROPERTIES');
  });
});

/* ================================================================== *
 * 2 · Demo financial assumptions are declared wherever they matter
 * ================================================================== */

describe('demo hardening · illustrative terms are never presented as agreed', () => {
  const NOTICE = path.join(ROOT, 'components/demo/DemoAssumptionsNotice.tsx');

  it('the notice renders only in demo — production has no code path to it', () => {
    const source = fs.readFileSync(NOTICE, 'utf8');
    // The environment check is the first thing the function does, before it reads anything.
    expect(source).toMatch(/if \(resolveEnvironment\(\)\.env !== 'demo'\) return null;/);
  });

  it('the notice quotes the rules the arithmetic actually used', () => {
    const source = fs.readFileSync(NOTICE, 'utf8');
    // Read from the dataset, never typed in — otherwise the notice and the figures drift.
    expect(source).toContain('DEMO_SAMPLE_BUSINESS_RULES');
    expect(source).not.toMatch(/60%|40%|5%/);

    expect(DEMO_SAMPLE_BUSINESS_RULES.investorPoolPct).toBe(0.6);
    expect(DEMO_SAMPLE_BUSINESS_RULES.operatorPoolPct).toBe(0.4);
    expect(DEMO_SAMPLE_BUSINESS_RULES.reservePct).toBe(0.05);
  });

  it('every screen showing terms-dependent money declares the notice', () => {
    const required = [
      'app/admin/finance/revenue/page.tsx',
      'app/admin/finance/expenses/page.tsx',
      'app/admin/finance/cashflow/page.tsx',
      'app/admin/finance/pnl/page.tsx',
      'app/admin/investors/page.tsx',
      'app/admin/investors/distributions/page.tsx',
      'app/admin/investors/reports/page.tsx',
      'app/admin/analytics/performance/page.tsx',
      'app/admin/dashboard/page.tsx',
      'app/admin/portfolio/page.tsx',
    ];
    const missing = required.filter((relative) => {
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      return !/financial="(financial|investor)"/.test(source)
        && !source.includes('DemoAssumptionsNotice');
    });
    expect(missing).toEqual([]);
  });

  it('investor-facing screens use the wording written for an investor', () => {
    for (const relative of ['app/admin/portfolio/page.tsx', 'app/admin/investors/page.tsx']) {
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      expect(source, relative).toMatch(/scope="investor"|financial="investor"/);
    }
  });

  it('the operations board declares no notice, because it shows no money', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/admin/operations/today/page.tsx'), 'utf8');
    expect(source).not.toContain('DemoAssumptionsNotice');
  });
});

/* ================================================================== *
 * 3 · The operations board carries no financial figure
 * ================================================================== */

describe('demo hardening · the operations board shows work, never money', () => {
  const dataset = buildDemoDataset('OPERATIONS_ISSUE');
  const provider = new FixtureDashboardDataProvider({ workbook: dataset.workbook, ops: dataset.ops });

  it('exposes no revenue, rate, payout or profit field', async () => {
    const { data } = await provider.getOperations(FILTERS);
    const serialised = JSON.stringify(data).toLowerCase();
    for (const forbidden of ['revenue', 'payout', 'profit', 'margin', 'adr', 'revpar', 'expense']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it('shows guest names shortened, and never contact details', async () => {
    const { data } = await provider.getOperations(FILTERS);
    for (const row of [...data.arrivals, ...data.departures]) {
      // Given name + last initial, e.g. "Priya M."
      expect(row.guestDisplayName, row.guestDisplayName).toMatch(/^[^\s]+( [A-Z]\.)?$/);
    }
    const serialised = JSON.stringify(data);
    expect(serialised).not.toMatch(/@|\+91|phone|email/i);
  });

  it('puts the most pressing item first and says what to do about it', async () => {
    const { data } = await provider.getOperations(FILTERS);
    expect(data.urgent.length).toBeGreaterThan(0);
    expect(data.urgent[0]!.severity).toBe('critical');

    const order = { critical: 0, high: 1, watch: 2 } as const;
    const ranks = data.urgent.map((item) => order[item.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);

    for (const item of data.urgent) {
      expect(item.action.length, item.key).toBeGreaterThan(10);
      expect(item.propertyId, item.key).toMatch(/^(HYD-|COMMON)/);
    }
  });

  it('covers every operational surface the board is meant to show', async () => {
    const { data } = await provider.getOperations(FILTERS);
    expect(data.counters.checkIns + data.counters.checkOuts).toBeGreaterThan(0);
    expect(data.maintenance.length).toBeGreaterThan(0);
    expect(data.lowStock.length).toBeGreaterThan(0);
    expect(data.units.length).toBe(4);
    expect(data.cleaning.some((task) => task.status === 'Failed Inspection')).toBe(true);
  });

  it('filters to one property when asked', async () => {
    const { data } = await provider.getOperations({ ...FILTERS, propertyId: 'HYD-501' });
    for (const row of [...data.arrivals, ...data.departures, ...data.maintenance]) {
      expect(row.propertyId).toBe('HYD-501');
    }
  });
});

/* ================================================================== *
 * 4 · Presentation mode
 * ================================================================== */

describe('demo hardening · presentation mode', () => {
  it('is off by default, with every control available', () => {
    const status = demoStatus();
    expect(status.presentation.active).toBe(false);
    expect(resetAvailable()).toBe(true);
  });

  it('hides the reset when switched on', () => {
    setPresentationMode({ active: true, resetEnabled: false }, { resolved: DEMO_ENV });
    expect(demoStatus().presentation.active).toBe(true);
    expect(resetAvailable()).toBe(false);
  });

  it('REFUSES the reset when hidden — not merely invisible', () => {
    // A hidden control that still works when posted to is not hidden. This is the
    // assertion that makes the hiding mean something.
    setPresentationMode({ active: true, resetEnabled: false }, { resolved: DEMO_ENV });
    expect(() => resetDemoEnvironment({ resolved: DEMO_ENV })).toThrow(PresentationModeError);
  });

  it('an admin can explicitly re-enable the reset without leaving presentation mode', () => {
    setPresentationMode({ active: true, resetEnabled: false }, { resolved: DEMO_ENV });
    setPresentationMode({ resetEnabled: true }, { resolved: DEMO_ENV });

    expect(demoStatus().presentation.active).toBe(true);
    expect(resetAvailable()).toBe(true);
    expect(() => resetDemoEnvironment({ resolved: DEMO_ENV })).not.toThrow();
  });

  it('survives a scenario switch and a reset', () => {
    setPresentationMode({ active: true, resetEnabled: true }, { resolved: DEMO_ENV });
    setScenario('HIGH_OCCUPANCY', { resolved: DEMO_ENV });
    expect(demoStatus().presentation.active).toBe(true);

    // Losing presentation mode the moment someone resets in front of an audience is
    // exactly the wrong time for it.
    resetDemoEnvironment({ resolved: DEMO_ENV });
    expect(demoStatus().presentation.active).toBe(true);
  });

  it('cannot be changed in production', () => {
    expect(() => setPresentationMode({ active: true }, { resolved: PRODUCTION_ENV }))
      .toThrow(DemoOnlyOperationError);
  });

  it('is documented as a convenience, not a security control', () => {
    const store = fs.readFileSync(path.join(ROOT, 'lib/server/demo/store.ts'), 'utf8');
    expect(store).toMatch(/not a security boundary/i);
    const page = fs.readFileSync(path.join(ROOT, 'app/admin/demo/page.tsx'), 'utf8');
    expect(page).toMatch(/not a security control/i);
  });
});

/* ================================================================== *
 * 5 · Reset, re-verified under 5B conditions
 * ================================================================== */

describe('demo hardening · reset', () => {
  it('production rejects it, with an environment reason rather than a permission one', () => {
    let thrown: Error | null = null;
    try { resetDemoEnvironment({ resolved: PRODUCTION_ENV }); } catch (e) { thrown = e as Error; }
    expect(thrown).toBeInstanceOf(DemoOnlyOperationError);
    expect(thrown!.message).toMatch(/demonstration-only/i);
    expect(thrown!.message).toMatch(/no production equivalent/i);
  });

  it('restores a deterministic seed state', () => {
    setScenario('OPERATIONS_ISSUE', { resolved: DEMO_ENV });
    resetDemoEnvironment({ resolved: DEMO_ENV });
    const first = JSON.stringify(demoStatus());

    setScenario('GUEST_SUPPORT', { resolved: DEMO_ENV });
    resetDemoEnvironment({ resolved: DEMO_ENV });
    const second = JSON.parse(JSON.stringify(demoStatus()));

    expect(second.scenario).toBe('NORMAL_DAY');
    expect(second.mutations).toBe(0);
    expect(JSON.parse(first).scenario).toBe('NORMAL_DAY');
  });

  it('requires confirmation in the interface', () => {
    const page = fs.readFileSync(path.join(ROOT, 'app/admin/demo/page.tsx'), 'utf8');
    expect(page).toContain('ConfirmedAction');
    expect(page).toMatch(/resets fictional demonstration data only/i);
  });
});

/* ================================================================== *
 * 6 · Demo data quality — properties must not look alike
 * ================================================================== */

describe('demo hardening · the four properties are genuinely different', () => {
  const dataset = buildDemoDataset('NORMAL_DAY');
  const series = computeMonthlySeries(dataset.workbook, fyMonthKeysFor(dataset.workbook));
  const busiest = series.filter((m) => m.netRevenue > 0).sort((a, b) => b.netRevenue - a.netRevenue)[0]!;
  const byProperty = computeByProperty(dataset.workbook, monthPeriod(busiest.monthKey));

  it('reports all four units', () => {
    expect(byProperty.map((row) => row.propertyId).sort())
      .toEqual(['HYD-501', 'HYD-502', 'HYD-601', 'HYD-602']);
  });

  it('does not make them equally successful', () => {
    const revenues = byProperty.map((row) => row.netRevenue);
    const best = Math.max(...revenues);
    const worst = Math.min(...revenues);
    // A demo where every unit performs identically teaches a client nothing and looks
    // synthetic. The spread has to be visible.
    expect(best / Math.max(1, worst)).toBeGreaterThan(1.3);
  });

  it('varies occupancy between units', () => {
    const occupancies = byProperty.map((row) => row.occupancyPct);
    expect(Math.max(...occupancies) - Math.min(...occupancies)).toBeGreaterThan(0.1);
  });

  it('has at least one unit that is not profitable in some month', () => {
    const anyLoss = fyMonthKeysFor(dataset.workbook).some((monthKey) =>
      computeByProperty(dataset.workbook, monthPeriod(monthKey)).some((row) => row.profit < 0));
    expect(anyLoss).toBe(true);
  });

  it('varies occupancy across the year, not just across units', () => {
    const trading = series.filter((m) => m.occupiedNights > 0).map((m) => m.occupancyPct);
    expect(Math.max(...trading) - Math.min(...trading)).toBeGreaterThan(0.3);
  });
});

/* ================================================================== *
 * 7 · Every scenario still works, and stays demo-only
 * ================================================================== */

describe('demo hardening · scenario control', () => {
  it('all six scenarios build and describe themselves', () => {
    for (const scenario of DEMO_SCENARIOS) {
      const status = setScenario(scenario, { resolved: DEMO_ENV });
      expect(status.scenario, scenario).toBe(scenario);
      expect(status.highlights.length, scenario).toBeGreaterThan(0);
      expect(status.today, scenario).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('the scenario is surfaced in the header for an admin, and only in demo', () => {
    const layout = fs.readFileSync(path.join(ROOT, 'app/admin/layout.tsx'), 'utf8');
    expect(layout).toContain('demoControlsPermitted');
    expect(layout).toContain("roleHasCapability(session.role, 'demo.control')");

    const shell = fs.readFileSync(path.join(ROOT, 'components/shell/AppShell.tsx'), 'utf8');
    expect(shell).toContain('sv-scenario-chip');
    expect(shell).toContain('href="/admin/demo"');
  });

  it('production refuses every scenario', () => {
    for (const scenario of DEMO_SCENARIOS) {
      expect(() => setScenario(scenario, { resolved: PRODUCTION_ENV }), scenario)
        .toThrow(DemoOnlyOperationError);
    }
  });
});

/* ================================================================== *
 * 8 · Investor demonstration
 * ================================================================== */

describe('demo hardening · the two investors are visibly different', () => {
  it('differ in capital, participation and distribution', () => {
    const dataset = buildDemoDataset('INVESTOR_REVIEW');
    const a = dataset.workbook.investors.find((i) => i.InvestorID === DEMO_INVESTOR_A)!;
    const b = dataset.workbook.investors.find((i) => i.InvestorID === DEMO_INVESTOR_B)!;

    expect(a.InvestmentAmount).not.toBe(b.InvestmentAmount);
    expect(a.ParticipationPct).not.toBe(b.ParticipationPct);

    const paid = (id: string) => dataset.workbook.distributions
      .filter((d) => d.InvestorID === id).reduce((t, d) => t + d.PaidAmount, 0);
    expect(paid(DEMO_INVESTOR_A)).not.toBe(paid(DEMO_INVESTOR_B));
  });

  it('the portfolio screen offers no operational control', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/admin/portfolio/page.tsx'), 'utf8');
    // No form, no button, no action — an investor screen is something to read.
    expect(source).not.toMatch(/<form|<button|action="\/api/);
  });

  it('the portfolio screen states that the values are demonstration values', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/admin/portfolio/page.tsx'), 'utf8');
    expect(source).toContain('DemoAssumptionsNotice');
    expect(source).toContain('scope="investor"');
  });
});
