/**
 * LIVE PROVIDER SUITE — GoogleSheetsDashboardDataProvider.
 *
 * The central claim being tested is the one the whole architecture rests on:
 *
 *   Given the same rows, the live provider and the fixture provider produce the SAME
 *   views. Switching the source therefore cannot change what any screen says.
 *
 * It is asserted by deep-equality on entire view payloads, not by spot-checking a few
 * numbers — a divergence anywhere in shaping, ordering, labelling or rounding fails here.
 *
 * The backend is `InMemorySheetsClient` seeded through the real contract layout, so the
 * repositories, column indexes and named-range reads are all genuinely exercised. What is
 * NOT exercised is Google's formula engine — that is the LIVE parity gate's job, and this
 * suite makes no claim about it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GoogleSheetsDashboardDataProvider, LiveDataUnavailableError } from '@/lib/data/providers/sheets-provider';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { ReadCache } from '@/lib/server/cache/read-cache';
import { InMemorySheetsClient, type A1Range, type Row } from '@/lib/server/sheets/client';
import { buildDemoWorkbook, buildDemoOps } from '@/lib/data/fixtures/workbook';
import { seedSheetsClient } from './support/in-memory-workbook';
import type { GoogleSheetsClient } from '@/lib/server/sheets/client';
import type { SheetKey } from '@/lib/contract/contract.generated';
import type { ReportFilters } from '@/lib/data/providers/types';

const workbook = buildDemoWorkbook();
const ops = buildDemoOps();
const FILTERS: ReportFilters = { month: '', propertyId: null, platform: null };

/**
 * Noon IST on the fixture's operational date, so the live provider's notion of "today"
 * matches the demo's. Without this the two sources would describe different days and the
 * unit-status board would legitimately differ — which would say nothing about parity.
 */
const DEMO_NOW = new Date(`${ops.today}T12:00:00+05:30`);

function liveProvider(options: {
  client?: GoogleSheetsClient;
  cache?: ReadCache;
  now?: () => Date;
} = {}) {
  return new GoogleSheetsDashboardDataProvider({
    tenantId: 'tenant-test',
    client: options.client ?? seedSheetsClient(workbook, ops),
    cache: options.cache ?? new ReadCache({ ttlMs: 60_000 }),
    now: options.now ?? (() => DEMO_NOW),
  });
}

/** Counts round trips, and can be told to start failing. */
class CountingClient implements GoogleSheetsClient {
  reads = 0;
  failing = false;
  constructor(private readonly inner: InMemorySheetsClient) {}
  async batchGet(ranges: A1Range[]): Promise<Record<A1Range, Row[]>> {
    this.reads++;
    if (this.failing) throw new Error('Sheets batchGet failed: 503 backend error');
    return this.inner.batchGet(ranges);
  }
  async get(range: A1Range): Promise<Row[]> {
    this.reads++;
    if (this.failing) throw new Error('Sheets get failed: 503 backend error');
    return this.inner.get(range);
  }
  async append(sheet: SheetKey, rows: Row[]) { return this.inner.append(sheet, rows); }
  async batchUpdate(edits: Parameters<GoogleSheetsClient['batchUpdate']>[0]) { return this.inner.batchUpdate(edits); }
  async flush() { return this.inner.flush(); }
}

/* ================================================================== *
 * The provider swap is a no-op
 * ================================================================== */

describe('live provider · identical rows produce identical views', () => {
  const fixture = new FixtureDashboardDataProvider({ workbook, ops });
  let live: GoogleSheetsDashboardDataProvider;
  beforeEach(() => { live = liveProvider(); });

  it('reads the same properties, reservations and platforms out of the sheet', async () => {
    const [a, b] = await Promise.all([fixture.getDashboard(FILTERS), live.getDashboard(FILTERS)]);
    expect(b.data.properties).toEqual(a.data.properties);
    expect(b.data.platforms).toEqual(a.data.platforms);
    expect(b.data.availableMonths).toEqual(a.data.availableMonths);
  });

  it('produces byte-identical KPI cards — values, comparisons and unavailable states', async () => {
    const [a, b] = await Promise.all([fixture.getDashboard(FILTERS), live.getDashboard(FILTERS)]);
    expect(b.data.kpis).toEqual(a.data.kpis);
    // Including the one that must NOT show a number while the rules are unset.
    const distribution = b.data.kpis.find((k) => k.key === 'investorDistributions')!;
    expect(distribution.unavailable?.reason).toBe('CONFIGURATION_REQUIRED');
  });

  it('produces the same trend series', async () => {
    const [a, b] = await Promise.all([fixture.getDashboard(FILTERS), live.getDashboard(FILTERS)]);
    expect(b.data.trend).toEqual(a.data.trend);
  });

  it('produces the same ledgers, P&L and cash flow', async () => {
    for (const call of ['getRevenue', 'getExpenses', 'getCashFlow', 'getPnl', 'getReservations'] as const) {
      const [a, b] = await Promise.all([fixture[call](FILTERS), live[call](FILTERS)]);
      expect(b.data, call).toEqual(a.data);
    }
  });

  it('produces the same monthly series and investor preview', async () => {
    const [a, b] = await Promise.all([fixture.getMonthlySeries(FILTERS), live.getMonthlySeries(FILTERS)]);
    expect(b.data).toEqual(a.data);

    const [c, d] = await Promise.all([fixture.getInvestorPreview(FILTERS), live.getInvestorPreview(FILTERS)]);
    expect(d.data).toEqual(c.data);
    expect(d.data.configured).toBe(false);
  });

  it('reads business identity from the workbook rather than a constant', async () => {
    const [a, b] = await Promise.all([fixture.getSettings(), live.getSettings()]);
    expect(b.data).toEqual(a.data);
    expect(b.data.businessName).toBe(workbook.settings.businessName);
  });

  it('honours filters identically', async () => {
    const filtered: ReportFilters = { month: '', propertyId: 'HYD-501', platform: 'Airbnb' };
    const [a, b] = await Promise.all([fixture.getDashboard(filtered), live.getDashboard(filtered)]);
    expect(b.data.properties).toEqual(a.data.properties);
    expect(b.data.platforms).toEqual(a.data.platforms);
  });

  it('derives the TODAY panel from the operational sheets, not from counters', async () => {
    const { data } = await live.getDashboard(FILTERS);
    // 14_MAINTENANCE in the seeded workbook holds three tickets that are still open.
    expect(data.today.openMaintenance).toBe(
      ops.maintenance.filter((t) => ['Open', 'Assigned', 'In Progress', 'Waiting'].includes(t.status)).length);
    expect(data.today.lowStock).toBe(
      ops.inventory.filter((i) => i.currentStock <= i.minStock).length);
  });

  it('declares guest requests untracked rather than reporting zero of them', async () => {
    // V1 has no guest-request sheet. Reporting 0 would claim nobody has asked for
    // anything, which is a different statement from "we do not record this".
    const { data } = await live.getDashboard(FILTERS);
    expect(data.today.unavailable).toContain('guestRequests');
  });
});

/* ================================================================== *
 * Provenance and freshness
 * ================================================================== */

describe('live provider · provenance', () => {
  it('never marks live payloads as demo', async () => {
    const live = liveProvider();
    const { meta } = await live.getDashboard(FILTERS);
    expect(meta.demo).toBe(false);
    expect(meta.source).toBe('GOOGLE_SHEETS');
    expect(meta.freshness).toBe('GOOD');
    expect(meta.lastSuccessfulSyncAt).not.toBeNull();
  });

  it('reports cache outcome so a hit is distinguishable from a read', async () => {
    const live = liveProvider();
    expect((await live.getDashboard(FILTERS)).meta.cache).toBe('MISS');
    expect((await live.getDashboard(FILTERS)).meta.cache).toBe('HIT');
  });

  it('one page load costs one set of round trips, not one per section', async () => {
    const counting = new CountingClient(seedSheetsClient(workbook, ops));
    const live = liveProvider({ client: counting });

    await live.getDashboard(FILTERS);
    const afterFirst = counting.reads;
    await Promise.all([live.getRevenue(FILTERS), live.getExpenses(FILTERS), live.getPnl(FILTERS)]);

    expect(counting.reads).toBe(afterFirst);      // all served from the one cached read
  });

  it('stops calling data live once a fetch has failed, even inside the TTL', async () => {
    const counting = new CountingClient(seedSheetsClient(workbook, ops));
    const live = liveProvider({ client: counting });
    await live.getDashboard(FILTERS);

    counting.failing = true;
    await live.refresh();                          // fails, but must not lose the good data

    const { data, meta } = await live.getDashboard(FILTERS);
    expect(data.kpis.length).toBeGreaterThan(0);   // last good figures still available
    // The figures are recent, but the source is no longer confirmed reachable — so the
    // header must not say "Live". STALE is the honest description.
    expect(meta.freshness).toBe('STALE');
    expect(meta.error).toBeTruthy();
    expect(meta.lastSuccessfulSyncAt).not.toBeNull();
  });

  it('escalates to ERROR once the cached data is also past its TTL', async () => {
    let clock = Date.now();
    const cache = new ReadCache({ ttlMs: 60_000, now: () => clock });
    const counting = new CountingClient(seedSheetsClient(workbook, ops));
    const live = liveProvider({ client: counting, cache });
    await live.getDashboard(FILTERS);

    counting.failing = true;
    clock += 60_001;                               // the entry expires

    const { data, meta } = await live.getDashboard(FILTERS);
    expect(data.kpis.length).toBeGreaterThan(0);   // still served, never blanked
    expect(meta.freshness).toBe('ERROR');
  });

  it('returns to live once the source recovers', async () => {
    const counting = new CountingClient(seedSheetsClient(workbook, ops));
    const live = liveProvider({ client: counting });
    await live.getDashboard(FILTERS);

    counting.failing = true;
    await live.refresh();
    expect((await live.getDashboard(FILTERS)).meta.freshness).toBe('STALE');

    counting.failing = false;
    await live.refresh();
    const { meta } = await live.getDashboard(FILTERS);
    expect(meta.freshness).toBe('GOOD');
    expect(meta.error).toBeNull();
  });

  it('the failure message says what to fix without leaking the spreadsheet id', async () => {
    const inner = seedSheetsClient(workbook, ops);
    const counting = new CountingClient(inner);
    const live = liveProvider({ client: counting });
    await live.getDashboard(FILTERS);

    counting.failing = true;
    await live.refresh();
    const { meta } = await live.getDashboard(FILTERS);

    expect(meta.error).not.toMatch(/spreadsheet id|[A-Za-z0-9_-]{30,}/);
    expect(meta.error).toMatch(/could not be read|rate limit|shared|found/i);
  });

  it('throws a clear, distinct error when nothing can be read at all', async () => {
    const counting = new CountingClient(seedSheetsClient(workbook, ops));
    counting.failing = true;
    const live = liveProvider({ client: counting });

    await expect(live.getDashboard(FILTERS)).rejects.toBeInstanceOf(LiveDataUnavailableError);
    await expect(live.getDashboard(FILTERS)).rejects.toThrow(/no recent data is cached/i);
  });

  it('the header metadata never throws, even with the source down', async () => {
    // A failed header would take the whole shell down and tell the operator nothing.
    const counting = new CountingClient(seedSheetsClient(workbook, ops));
    counting.failing = true;
    const live = liveProvider({ client: counting });

    const meta = await live.getSourceMeta();
    expect(meta.freshness).toBe('ERROR');
    expect(meta.demo).toBe(false);
    expect(meta.error).toBeTruthy();
  });
});

/* ================================================================== *
 * Workbook safety
 * ================================================================== */

describe('live provider · the workbook is never modified', () => {
  it('a full page load performs no write of any kind', async () => {
    const client = seedSheetsClient(workbook, ops);
    const live = liveProvider({ client });

    await live.getDashboard(FILTERS);
    await live.getRevenue(FILTERS);
    await live.getExpenses(FILTERS);
    await live.getPnl(FILTERS);
    await live.getSettings();
    await live.getInvestorPreview(FILTERS);
    await live.refresh();

    expect(client.writeLog).toEqual([]);
  });

  it('the provider contains no write call and no reporting-month reference', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'lib', 'data', 'providers', 'sheets-provider.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\.append\(|\.batchUpdate\(|\.updateById\(/);
    expect(code).not.toContain('CFG_REPORT_MONTH');
  });

  it('reads only the report-month-independent parts of the workbook', async () => {
    // 99_CALC's KPI/property/platform blocks key off the shared reporting cell. Reading
    // them would mean writing that cell, which is exactly what Decision D1 forbids.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'lib', 'data', 'providers', 'sheets-provider.ts'), 'utf8');
    expect(source).not.toContain('AnalyticsRepository');
  });
});

/* ================================================================== *
 * Bundling boundary
 * ================================================================== */

describe('live provider · stays out of the browser bundle', () => {
  it('no client component imports a provider implementation at runtime', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();

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

    const offenders: string[] = [];
    for (const file of walk(path.join(root, 'components')).concat(walk(path.join(root, 'lib')))) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes("'use client'")) continue;
      // Type-only imports are erased at build time and are fine. A value import would
      // drag the Sheets client — and googleapis — into the browser bundle.
      const valueImport = /import\s+(?!type\s)[^;]*from\s+['"]@\/lib\/data\/providers/.test(source);
      if (valueImport) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});
