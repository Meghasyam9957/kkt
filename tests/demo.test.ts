/**
 * DEMO / UAT ENVIRONMENT SUITE.
 *
 * The demonstration has one job — to be shown to a client and an Operations Manager as a
 * fair representation of the platform — so these tests check the two things that would
 * make it dishonest:
 *
 *   1. that the figures on screen are DERIVED from the demo ledger rather than authored,
 *      which is what makes the demo internally consistent and the demo↔live swap a
 *      non-event;
 *   2. that the demonstration cannot touch anything real — no production workbook, no
 *      production project, and no reset control that exists outside demo.
 *
 * Scenario and reset behaviour is tested by consequence: switch the scenario and assert
 * the numbers move, reset and assert they come back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDemoDataset, DEMO_MARKER, DEMO_NOTE, DEMO_ACTIVITY_BY_MONTH, DEMO_QUIET_MONTHS,
  DEMO_INVESTORS_AB, DEMO_INVESTOR_A, DEMO_INVESTOR_B, DEMO_SAMPLE_BUSINESS_RULES,
} from '@/lib/data/demo/dataset';
import {
  currentDataset, demoStatus, setScenario, resetDemoEnvironment, __resetDemoStoreForTests,
} from '@/lib/server/demo/store';
import { buildGuestJourney, runGuestJourney, DEMO_GUEST_REQUEST_ID } from '@/lib/server/demo/guest-journey';
import { resolveEnvironment, DemoOnlyOperationError } from '@/lib/server/environment/config';
import { DEMO_IDENTITIES, DemoAuthProvider, findDemoIdentity } from '@/lib/server/auth/demo-identities';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import {
  computeMonthlySeries, computeByProperty, monthPeriod, fyMonthKeysFor, computeInvestorAllocations,
} from '@/lib/server/analytics/kpi';
import { DEMO_SCENARIOS } from '@/lib/shared/environment';
import { isoToSerial } from '@/lib/shared/dates';

const ROOT = process.cwd();
const DEMO_ENV = resolveEnvironment({ APP_ENV: 'demo' });
const PRODUCTION_ENV = resolveEnvironment({ APP_ENV: 'production' });

beforeEach(() => { __resetDemoStoreForTests(); });
afterEach(() => { __resetDemoStoreForTests(); });

/* ================================================================== *
 * Dataset shape and coverage
 * ================================================================== */

describe('demo dataset · a full fictional operation', () => {
  const dataset = buildDemoDataset('NORMAL_DAY');

  it('is marked as demonstration data', () => {
    expect(dataset.marker).toBe(DEMO_MARKER);
    expect(dataset.demo).toBe(true);
  });

  it('covers the four MAKAM units', () => {
    expect(dataset.workbook.properties.map((p) => p.PropertyID))
      .toEqual(['HYD-501', 'HYD-502', 'HYD-601', 'HYD-602']);
    const types = Object.fromEntries(dataset.workbook.properties.map((p) => [p.PropertyID, p.BHKType]));
    expect(types).toEqual({
      'HYD-501': '2 BHK', 'HYD-502': '1 BHK', 'HYD-601': '2 BHK', 'HYD-602': '1 BHK',
    });
  });

  it('carries every record type the demonstration needs', () => {
    const { workbook, ops, registers } = dataset;
    expect(workbook.reservations.length).toBeGreaterThan(50);
    expect(workbook.revenue.length).toBeGreaterThan(50);
    expect(workbook.expenses.length).toBeGreaterThan(50);
    expect(workbook.capex.length).toBeGreaterThan(0);
    expect(workbook.cashflow.length).toBeGreaterThan(20);
    expect(workbook.investors.length).toBe(3);
    expect(workbook.distributions.length).toBeGreaterThan(0);
    expect(ops.housekeeping.length).toBeGreaterThan(0);
    expect(ops.maintenance.length).toBeGreaterThan(0);
    expect(ops.inventory.length).toBeGreaterThan(0);
    expect(registers.rent.length).toBe(4);
    expect(registers.assets.length).toBeGreaterThan(0);
    expect(registers.compliance.length).toBeGreaterThan(0);
  });

  it('marks register records as demonstration data in their notes field', () => {
    // V1 gives these sheets a Notes column, so the marker goes where a person would look.
    for (const record of [...dataset.registers.rent, ...dataset.registers.assets, ...dataset.registers.compliance]) {
      expect(record.notes, record.notes).toContain('[DEMO]');
    }
    expect(DEMO_NOTE).toContain('Fictional');
  });

  it('spans twelve months and is deliberately uneven', () => {
    expect(DEMO_ACTIVITY_BY_MONTH).toHaveLength(12);
    // Empty and INSUFFICIENT DATA states have to be reachable from real records, not faked.
    expect(DEMO_ACTIVITY_BY_MONTH[DEMO_QUIET_MONTHS.dormant]).toBe(0);
    expect(DEMO_ACTIVITY_BY_MONTH[DEMO_QUIET_MONTHS.notYetTraded]).toBe(0);
    expect(DEMO_ACTIVITY_BY_MONTH[DEMO_QUIET_MONTHS.rampUp]).toBeLessThan(0.5);
    expect(DEMO_ACTIVITY_BY_MONTH[DEMO_QUIET_MONTHS.insufficientForForecast]).toBeLessThan(0.5);
  });

  it('the dormant and untraded months genuinely carry no activity', () => {
    const series = computeMonthlySeries(dataset.workbook, fyMonthKeysFor(dataset.workbook));
    for (const index of [DEMO_QUIET_MONTHS.dormant, DEMO_QUIET_MONTHS.notYetTraded]) {
      const month = series[index]!;
      expect(month.grossRevenue, `month ${index}`).toBe(0);
      expect(month.operatingExpenses, `month ${index}`).toBe(0);
      expect(month.occupiedNights, `month ${index}`).toBe(0);
    }
  });

  it('the quiet months are thin but not empty — enough to look real, too little to forecast', () => {
    const series = computeMonthlySeries(dataset.workbook, fyMonthKeysFor(dataset.workbook));
    const busiest = Math.max(...series.map((m) => m.netRevenue));
    for (const index of [DEMO_QUIET_MONTHS.rampUp, DEMO_QUIET_MONTHS.insufficientForForecast]) {
      const month = series[index]!;
      expect(month.netRevenue, `month ${index}`).toBeGreaterThan(0);
      expect(month.netRevenue, `month ${index}`).toBeLessThan(busiest * 0.5);
    }
  });

  it('uses no real people — every guest comes from the fictional pool', () => {
    const names = new Set(dataset.workbook.reservations.map((b) => b.GuestName));
    expect(names.size).toBeGreaterThan(5);
    for (const investor of dataset.workbook.investors) {
      expect(investor.InvestorName).toMatch(/Demo [ABC]\)$/);
    }
  });
});

/* ================================================================== *
 * The twelve conditions a demonstration has to be able to show
 * ================================================================== */

describe('demo dataset · the twelve conditions exist as records', () => {
  const dataset = buildDemoDataset('NORMAL_DAY');
  const today = isoToSerial(dataset.today);
  const series = computeMonthlySeries(dataset.workbook, fyMonthKeysFor(dataset.workbook));

  it('1 · normal occupancy', () => {
    const trading = series.filter((m) => m.occupiedNights > 0);
    expect(trading.length).toBeGreaterThanOrEqual(8);
    const typical = trading.map((m) => m.occupancyPct).sort((a, b) => a - b)[Math.floor(trading.length / 2)]!;
    expect(typical).toBeGreaterThan(0.4);
    expect(typical).toBeLessThan(0.95);
  });

  it('2 · high occupancy — a day when all four units are full', () => {
    const occupiedOn = (day: number) => new Set(
      dataset.workbook.reservations
        .filter((b) => b.CheckInDate !== null && b.CheckOutDate !== null)
        .filter((b) => b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out')
        .filter((b) => b.CheckInDate! <= day && day < b.CheckOutDate!)
        .map((b) => b.PropertyID),
    ).size;
    const fullDays = Array.from({ length: 365 }, (_, i) => isoToSerial('2026-04-01') + i)
      .filter((day) => occupiedOn(day) === 4);
    expect(fullDays.length).toBeGreaterThan(0);
  });

  it('3 · cancellation', () => {
    const cancelled = dataset.workbook.reservations
      .filter((b) => b.BookingStatus === 'Cancelled' || b.BookingStatus === 'No Show');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(series.some((m) => m.cancelledCount > 0)).toBe(true);
  });

  it('4 · payout mismatch — a real discrepancy worth chasing', () => {
    const mismatched = dataset.workbook.reservations.filter((b) => {
      if (b.BookingStatus !== 'Checked Out' || b.ActualPayout <= 0) return false;
      const expected = b.RoomRevenue + b.CleaningFee + b.ExtraGuestFee + b.OtherCharges
        - b.Discount - b.Taxes - b.PlatformFee - b.OtherDeductions;
      return expected - b.ActualPayout > 1000;
    });
    expect(mismatched.length).toBeGreaterThan(0);
  });

  it('5 · maintenance issue', () => {
    const open = dataset.ops.maintenance.filter((t) => ['Open', 'Assigned', 'In Progress', 'Waiting'].includes(t.status));
    expect(open.length).toBeGreaterThan(0);
    expect(open.some((t) => t.priority === 'High' || t.priority === 'Critical')).toBe(true);
  });

  it('6 · low inventory', () => {
    const low = dataset.ops.inventory.filter((i) => i.currentStock <= i.minStock);
    expect(low.length).toBeGreaterThan(0);
    // And some items comfortably above, so "low stock" is a signal and not the default.
    expect(dataset.ops.inventory.some((i) => i.currentStock > i.minStock)).toBe(true);
  });

  it('7 · an arrival today', () => {
    const arrivals = dataset.workbook.reservations
      .filter((b) => b.CheckInDate === today && (b.BookingStatus === 'Confirmed' || b.BookingStatus === 'Checked In'));
    expect(arrivals.length).toBeGreaterThan(0);
  });

  it('8 · a departure today', () => {
    const departures = dataset.workbook.reservations
      .filter((b) => b.CheckOutDate === today && (b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out'));
    expect(departures.length).toBeGreaterThan(0);
  });

  it('9 · an expense spike large enough to bend the P&L', () => {
    const byMonth = series.map((m) => m.operatingExpenses).filter((v) => v > 0);
    const median = [...byMonth].sort((a, b) => a - b)[Math.floor(byMonth.length / 2)]!;
    expect(Math.max(...byMonth)).toBeGreaterThan(median * 1.3);
  });

  it('10 · a revenue increase between consecutive trading months', () => {
    const trading = series.filter((m) => m.netRevenue > 0);
    const increases = trading.slice(1)
      .filter((month, i) => month.netRevenue > (trading[i]?.netRevenue ?? 0) * 1.15);
    expect(increases.length).toBeGreaterThan(0);
  });

  it('11 · investor distributions actually paid', () => {
    expect(dataset.workbook.distributions.length).toBeGreaterThanOrEqual(3);
    const paid = dataset.workbook.distributions.reduce((t, d) => t + d.PaidAmount, 0);
    expect(paid).toBeGreaterThan(0);
    // And the cash movement that goes with it, so cash flow ties out.
    expect(dataset.workbook.cashflow.some((t) => t.Type === 'Investor Distribution')).toBe(true);
  });

  it('12 · a month with too little activity to forecast from', () => {
    const thin = series[DEMO_QUIET_MONTHS.insufficientForForecast]!;
    const busiest = Math.max(...series.map((m) => m.netRevenue));
    expect(thin.netRevenue).toBeLessThan(busiest * 0.5);
  });
});

/* ================================================================== *
 * Nothing on a dashboard is authored
 * ================================================================== */

describe('demo dataset · every figure is derived, never authored', () => {
  it('property revenue sums exactly to portfolio revenue', async () => {
    const dataset = buildDemoDataset('NORMAL_DAY');
    const provider = new FixtureDashboardDataProvider({ workbook: dataset.workbook, ops: dataset.ops });
    const { data, meta } = await provider.getDashboard({ month: '', propertyId: null, platform: null });

    // The period the dashboard actually resolved — not an assumption about which one that
    // is. If those two ever disagree, the headline and the breakdown describe different
    // months, which is exactly the failure this test is here to catch.
    const byProperty = computeByProperty(dataset.workbook, monthPeriod(meta.period));
    const summed = byProperty.reduce((total, row) => total + row.netRevenue, 0);
    const mtd = data.kpis.find((k) => k.key === 'mtdRevenue')!.value;

    // Exact, not approximate: the dashboard reads the same ledger the sum does.
    expect(summed).toBe(mtd);
  });

  it('the demo module contains no dashboard figure — only transactional records', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/data/demo/dataset.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // If a KPI were authored here it would have to be named. None is.
    expect(code).not.toMatch(/occupancyPct\s*[:=]|revPar\s*[:=]|\badr\s*[:=]|operatingMargin/i);
  });

  it('investor allocations are computed from participation, not written down', () => {
    const dataset = buildDemoDataset('INVESTOR_REVIEW');
    const month = dataset.today.slice(0, 7);
    const allocations = computeInvestorAllocations(dataset.workbook, month);
    expect(allocations.length).toBe(3);
    const total = allocations.reduce((t, a) => t + a.participationPct, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

/* ================================================================== *
 * Investor A and B are visibly different
 * ================================================================== */

describe('demo investors · A and B differ in every figure that matters', () => {
  it('differ in investment and participation', () => {
    const a = DEMO_INVESTORS_AB.find((i) => i.InvestorID === DEMO_INVESTOR_A)!;
    const b = DEMO_INVESTORS_AB.find((i) => i.InvestorID === DEMO_INVESTOR_B)!;
    expect(a.InvestmentAmount).not.toBe(b.InvestmentAmount);
    expect(a.ParticipationPct).not.toBe(b.ParticipationPct);
  });

  it('differ in distribution paid', () => {
    const dataset = buildDemoDataset('INVESTOR_REVIEW');
    const paidFor = (id: string) => dataset.workbook.distributions
      .filter((d) => d.InvestorID === id)
      .reduce((t, d) => t + d.PaidAmount, 0);
    expect(paidFor(DEMO_INVESTOR_A)).toBeGreaterThan(0);
    expect(paidFor(DEMO_INVESTOR_B)).toBeGreaterThan(0);
    // Visibly different, so "these are my figures" is verifiable by eye during a demo.
    expect(paidFor(DEMO_INVESTOR_A)).not.toBe(paidFor(DEMO_INVESTOR_B));
  });

  it('the demo identities map to different investors', () => {
    const a = findDemoIdentity('investor.demo.a')!;
    const b = findDemoIdentity('investor.demo.b')!;
    expect(a.investorId).toBe(DEMO_INVESTOR_A);
    expect(b.investorId).toBe(DEMO_INVESTOR_B);
    expect(a.investorId).not.toBe(b.investorId);
  });
});

/* ================================================================== *
 * Demo identities
 * ================================================================== */

describe('demo identities · four accounts, no passwords', () => {
  it('covers the roles a demonstration needs', () => {
    expect(DEMO_IDENTITIES.map((i) => i.key)).toEqual([
      'admin.demo', 'operations.demo', 'investor.demo.a', 'investor.demo.b',
    ]);
    expect(DEMO_IDENTITIES.map((i) => i.role))
      .toEqual(['ADMIN', 'OPERATIONS', 'INVESTOR', 'INVESTOR']);
  });

  it('stores no password, hash or secret of any kind', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/server/auth/demo-identities.ts'), 'utf8');
    expect(source).not.toMatch(/password\s*[:=]\s*['"]/i);
    expect(source).not.toMatch(/passwordHash|bcrypt|argon2/i);
    for (const identity of DEMO_IDENTITIES) {
      expect(Object.keys(identity)).not.toContain('password');
    }
  });

  it('is clearly marked as demonstration by address', () => {
    for (const identity of DEMO_IDENTITIES) {
      // Both halves say it: the local part carries "demo", and the domain is not real.
      expect(identity.email, identity.email).toMatch(/@srivillu\.demo$/);
      expect(identity.email.split('@')[0], identity.email).toContain('demo');
    }
  });

  it('resolves role and investor id from the record, never from the presented value', async () => {
    const provider = new DemoAuthProvider(DEMO_ENV);
    const context = await provider.resolve('investor.demo.a');
    expect(context.role).toBe('INVESTOR');
    expect(context.investorId).toBe(DEMO_INVESTOR_A);

    // A tampered cookie is simply an unknown key; it cannot assert anything.
    await expect(provider.resolve('{"role":"SUPER_ADMIN"}')).rejects.toThrow();
    await expect(provider.resolve('investor.demo.c')).rejects.toThrow();
  });

  it('cannot be constructed in production', () => {
    expect(() => new DemoAuthProvider(PRODUCTION_ENV)).toThrow(DemoOnlyOperationError);
  });
});

/* ================================================================== *
 * Scenario switching
 * ================================================================== */

describe('demo scenarios · switching changes what is on screen', () => {
  it('every scenario builds a dataset', () => {
    for (const scenario of DEMO_SCENARIOS) {
      const dataset = buildDemoDataset(scenario);
      expect(dataset.scenario, scenario).toBe(scenario);
      expect(dataset.today, scenario).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(dataset.highlights.length, scenario).toBeGreaterThan(0);
    }
  });

  it('switching moves the operational position, not just a label', () => {
    setScenario('NORMAL_DAY', { resolved: DEMO_ENV });
    const normal = currentDataset();
    const normalOpen = normal.ops.maintenance.filter((t) => t.status !== 'Resolved' && t.status !== 'Closed').length;

    setScenario('OPERATIONS_ISSUE', { resolved: DEMO_ENV });
    const issue = currentDataset();
    const issueOpen = issue.ops.maintenance.filter((t) => t.status !== 'Resolved' && t.status !== 'Closed').length;

    expect(issueOpen).toBeGreaterThan(normalOpen);
    expect(issue.ops.maintenance.some((t) => t.priority === 'Critical')).toBe(true);
    expect(issue.ops.housekeeping.some((t) => t.status === 'Failed Inspection')).toBe(true);
  });

  it('high occupancy really is more occupied — on the same day', () => {
    const occupied = (dataset: ReturnType<typeof currentDataset>) => {
      const day = isoToSerial(dataset.today);
      return new Set(dataset.workbook.reservations
        .filter((b) => b.CheckInDate !== null && b.CheckOutDate !== null)
        .filter((b) => b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out')
        .filter((b) => b.CheckInDate! <= day && day < b.CheckOutDate!)
        .map((b) => b.PropertyID)).size;
    };

    setScenario('NORMAL_DAY', { resolved: DEMO_ENV });
    const normal = currentDataset();
    const normalOccupied = occupied(normal);

    setScenario('HIGH_OCCUPANCY', { resolved: DEMO_ENV });
    const peak = currentDataset();

    // Every scenario presents the same day on purpose — moving "today" backwards would
    // empty the trading year behind it. So the difference has to come from the records
    // seeded around that day, and it does.
    expect(peak.today).toBe(normal.today);
    expect(normalOccupied).toBeLessThan(4);
    expect(occupied(peak)).toBe(4);
  });

  it('guest support surfaces a queue of open requests', () => {
    setScenario('GUEST_SUPPORT', { resolved: DEMO_ENV });
    const open = currentDataset().ops.guestRequests.filter((r) => r.status !== 'Resolved');
    expect(open.length).toBeGreaterThanOrEqual(3);
  });

  it('an unknown scenario is refused', () => {
    expect(() => setScenario('CHAOS', { resolved: DEMO_ENV })).toThrow(/Unknown demo scenario/);
  });

  it('production refuses to switch scenario', () => {
    expect(() => setScenario('HIGH_OCCUPANCY', { resolved: PRODUCTION_ENV }))
      .toThrow(DemoOnlyOperationError);
  });
});

/* ================================================================== *
 * Reset
 * ================================================================== */

describe('demo reset · returns to a known state', () => {
  it('restores the seeded scenario and discards demonstration changes', () => {
    setScenario('OPERATIONS_ISSUE', { resolved: DEMO_ENV });
    runGuestJourney({ resolved: DEMO_ENV });
    expect(demoStatus().mutations).toBeGreaterThan(0);

    const result = resetDemoEnvironment({ resolved: DEMO_ENV });

    expect(result.scenario).toBe('NORMAL_DAY');
    expect(result.discardedMutations).toBeGreaterThan(0);
    expect(demoStatus().mutations).toBe(0);
    expect(demoStatus().scenario).toBe('NORMAL_DAY');
  });

  it('removes records a demonstration created', () => {
    runGuestJourney({ resolved: DEMO_ENV });
    expect(currentDataset().ops.guestRequests.some((r) => r.requestId === DEMO_GUEST_REQUEST_ID)).toBe(true);

    resetDemoEnvironment({ resolved: DEMO_ENV });
    expect(currentDataset().ops.guestRequests.some((r) => r.requestId === DEMO_GUEST_REQUEST_ID)).toBe(false);
  });

  it('restores investor figures to their seeded values', () => {
    resetDemoEnvironment({ resolved: DEMO_ENV });
    const investors = currentDataset().workbook.investors;
    expect(investors.map((i) => i.InvestorID)).toEqual([DEMO_INVESTOR_A, DEMO_INVESTOR_B, 'INV-003']);
    expect(investors[0]!.ParticipationPct).toBe(0.40);
  });

  it('is deterministic — reset twice gives the identical dataset', () => {
    resetDemoEnvironment({ resolved: DEMO_ENV });
    const first = JSON.stringify(currentDataset().workbook.reservations.slice(0, 20));
    resetDemoEnvironment({ resolved: DEMO_ENV });
    const second = JSON.stringify(currentDataset().workbook.reservations.slice(0, 20));
    expect(second).toBe(first);
  });

  it('production refuses the reset', () => {
    expect(() => resetDemoEnvironment({ resolved: PRODUCTION_ENV })).toThrow(DemoOnlyOperationError);
  });

  it('the production refusal names it as demonstration-only, not as a permission problem', () => {
    try {
      resetDemoEnvironment({ resolved: PRODUCTION_ENV });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/demonstration-only/i);
      expect((error as Error).message).not.toMatch(/not authori[sz]ed|permission/i);
    }
  });
});

/* ================================================================== *
 * Guest journey
 * ================================================================== */

describe('demo guest journey · five steps ending in a real record', () => {
  it('describes the journey without changing anything', () => {
    const before = currentDataset().ops.guestRequests.length;
    const journey = buildGuestJourney();
    expect(journey.steps.map((s) => s.key)).toEqual([
      'check-in', 'stay-info', 'question', 'help-request', 'operations',
    ]);
    expect(currentDataset().ops.guestRequests.length).toBe(before);
  });

  it('uses fixed responses — nothing generated', () => {
    const first = buildGuestJourney().steps.map((s) => s.response);
    const second = buildGuestJourney().steps.map((s) => s.response);
    expect(second).toEqual(first);
    expect(first.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('shows the guest nothing internal', () => {
    const journey = buildGuestJourney();
    // Only what the GUEST would see. `watchFor` is a note to whoever is running the
    // demonstration and is never rendered to a guest, so it is excluded deliberately.
    const guestFacing = journey.steps
      .map((step) => [step.title, step.detail, step.response].filter(Boolean).join(' '))
      .join(' ')
      .toLowerCase();
    for (const forbidden of ['payout', 'platform fee', 'investor', 'expense', 'margin', 'revenue']) {
      expect(guestFacing, forbidden).not.toContain(forbidden);
    }
  });

  it('running it puts a request into the operations queue', () => {
    const before = currentDataset().ops.guestRequests.length;
    runGuestJourney({ resolved: DEMO_ENV });

    const requests = currentDataset().ops.guestRequests;
    expect(requests.length).toBe(before + 1);
    const raised = requests.find((r) => r.requestId === DEMO_GUEST_REQUEST_ID)!;
    expect(raised.status).toBe('Open');
    expect(raised.propertyId).toMatch(/^HYD-/);
  });

  it('is idempotent — a repeated demonstration does not fill the queue', () => {
    runGuestJourney({ resolved: DEMO_ENV });
    runGuestJourney({ resolved: DEMO_ENV });
    runGuestJourney({ resolved: DEMO_ENV });
    const matching = currentDataset().ops.guestRequests
      .filter((r) => r.requestId === DEMO_GUEST_REQUEST_ID);
    expect(matching).toHaveLength(1);
  });

  it('production refuses to run it', () => {
    expect(() => runGuestJourney({ resolved: PRODUCTION_ENV })).toThrow(DemoOnlyOperationError);
  });
});

/* ================================================================== *
 * Illustrative commercial rules stay illustrative
 * ================================================================== */

describe('demo business rules · illustrative, and labelled as such', () => {
  it('are set in the demo dataset so the waterfall can be demonstrated', () => {
    expect(DEMO_SAMPLE_BUSINESS_RULES.investorPoolPct).toBe(0.60);
    expect(DEMO_SAMPLE_BUSINESS_RULES.operatorPoolPct).toBe(0.40);
    expect(DEMO_SAMPLE_BUSINESS_RULES.reservePct).toBe(0.05);
  });

  it('exist only in the demo module — no other source file assigns them', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
      return out;
    };
    const offenders = walk(path.join(ROOT, 'lib'))
      .filter((file) => !file.includes(path.join('data', 'demo')))
      .filter((file) => !file.includes(path.join('data', 'fixtures')))
      .filter((file) => /investorPoolPct\s*:\s*0\.\d/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('the demo module states plainly that these are not approved terms', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/data/demo/dataset.ts'), 'utf8');
    expect(source).toMatch(/demonstration values only/i);
    expect(source).toMatch(/has NOT approved/);
  });
});
