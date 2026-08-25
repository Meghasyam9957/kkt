/**
 * PHASE 4 UI SUITE — the 14 required checks.
 *
 * Components are exercised directly with a controlled provider, so each test asserts real
 * rendered output rather than a snapshot. Where a rule matters (no hard-coded business
 * values, no credential access, never writing CFG_REPORT_MONTH) the test checks the
 * property, not just the happy path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';

import { FixtureDashboardDataProvider, minimizeGuestName } from '@/lib/data/providers/fixture-provider';
import { isDemoMode, isLiveDataEnabled, getDataProvider, __setDataProviderForTests } from '@/lib/data/providers';
import { buildDemoWorkbook, buildDemoOps, DEMO_PROPERTIES } from '@/lib/data/fixtures/workbook';
import { computeMonthlySeries, computeByProperty, monthPeriod, fyMonthKeysFor } from '@/lib/server/analytics/kpi';
import { DashboardContent } from '@/components/dashboard/DashboardView';
import { KPICard } from '@/components/ui/KPICard';
import { DataBoundary } from '@/components/shell/DataBoundary';
import { EnvironmentStatus } from '@/components/shell/EnvironmentStatus';
import { ENVIRONMENT_DESCRIPTORS, type PublicEnvironmentInfo } from '@/lib/shared/environment';
import { visibleNavigation } from '@/lib/shared/navigation';
import { capabilitiesFor, type Capability, type Role } from '@/lib/server/auth/roles';
import { canLoadRoute } from '@/lib/server/auth/guard';
import { InvestorService } from '@/lib/server/api/investor-service';
import type { DataMeta, DashboardView, KpiValue } from '@/lib/data/providers/types';

const ROOT = process.cwd();

/** What the server resolves and hands the client. Never computed in the browser. */
const DEMO_ENVIRONMENT: PublicEnvironmentInfo = {
  ...ENVIRONMENT_DESCRIPTORS.demo,
  dataSourceLabel: 'Demo Workbook (fixtures)',
  fixtures: true,
};
const PRODUCTION_ENVIRONMENT: PublicEnvironmentInfo = {
  ...ENVIRONMENT_DESCRIPTORS.production,
  fixtures: false,
};

/**
 * Source scans must read CODE, not documentation. A file that explains *why* it never
 * writes CFG_REPORT_MONTH would otherwise fail a scan looking for that identifier, which
 * would punish the comment rather than catch a defect.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const provider = new FixtureDashboardDataProvider({ now: () => new Date('2027-01-19T10:00:00Z') });

async function loadDashboard(month?: string): Promise<{ view: DashboardView; meta: DataMeta }> {
  const months = await provider.getAvailableMonths();
  const { data, meta } = await provider.getDashboard({ month: month ?? months[months.length - 1]! });
  return { view: data, meta };
}

beforeEach(() => cleanup());

/* ================================================================== *
 * 1 · Dashboard renders
 * ================================================================== */

describe('1 · dashboard renders', () => {
  it('renders KPIs, the today strip, the unit board and all four charts', async () => {
    const { view, meta } = await loadDashboard();
    render(<DashboardContent view={view} meta={meta} />);

    expect(screen.getByText('MTD Revenue')).toBeDefined();
    expect(screen.getByText('Today')).toBeDefined();
    expect(screen.getByText('Unit performance')).toBeDefined();

    for (const title of ['Revenue trend', 'Occupancy trend', 'Revenue, expenses and profit', 'Property performance']) {
      // Titles also appear as accessible chart names, so more than one match is correct.
      expect(screen.getAllByText(title).length, `chart missing: ${title}`).toBeGreaterThan(0);
    }
    // All four units appear on the board.
    for (const property of DEMO_PROPERTIES) {
      expect(screen.getAllByText(property.PropertyID).length).toBeGreaterThan(0);
    }
  });

  it('flags the best and weakest performing unit', async () => {
    const { view, meta } = await loadDashboard();
    render(<DashboardContent view={view} meta={meta} />);
    expect(screen.getByText('Best performer this month')).toBeDefined();
    expect(screen.getByText('Weakest performer this month')).toBeDefined();
  });
});

/* ================================================================== *
 * 2 · Fixture values appear correctly
 * ================================================================== */

describe('2 · fixture values appear correctly', () => {
  it('renders the exact figure the engine computed, formatted for display', async () => {
    const { view, meta } = await loadDashboard();
    const revenueKpi = view.kpis.find((k) => k.key === 'mtdRevenue')!;
    render(<DashboardContent view={view} meta={meta} />);

    const expected = new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', maximumFractionDigits: 0,
    }).format(revenueKpi.value);
    // Appears in the KPI card and again in the chart's screen-reader data table.
    const matches = screen.getAllByText(expected);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((el) => el.classList.contains('sv-kpi__value'))).toBe(true);
  });

  it('the dashboard total equals the sum of its property rows', async () => {
    const { view } = await loadDashboard();
    const mtdRevenue = view.kpis.find((k) => k.key === 'mtdRevenue')!.value;
    const propertySum = view.properties.reduce((t, p) => t + p.netRevenue, 0);
    expect(Math.round(propertySum)).toBe(Math.round(mtdRevenue));
  });
});

/* ================================================================== *
 * 3 · KPI cards render the correct period
 * ================================================================== */

describe('3 · KPI cards render correct periods', () => {
  it('labels each card with the reporting month', async () => {
    const { view, meta } = await loadDashboard('2026-11');
    expect(meta.period).toBe('2026-11');
    render(<KPICard kpi={view.kpis[0]!} period={meta.period} />);
    expect(screen.getByText('November 2026')).toBeDefined();
  });

  it('shows a comparison only when a previous period exists', () => {
    const withChange: KpiValue = {
      key: 'k', label: 'MTD Revenue', value: 100, format: 'currency',
      previousValue: 80, changeRatio: 0.25, higherIsBetter: true,
    };
    const { unmount } = render(<KPICard kpi={withChange} period="2027-01" />);
    expect(screen.getByText('+25.0%')).toBeDefined();
    unmount();

    const noChange: KpiValue = { key: 'k', label: 'MTD Revenue', value: 100, format: 'currency', changeRatio: null };
    render(<KPICard kpi={noChange} period="2027-01" />);
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('treats rising expenses as a worsening, not an improvement', () => {
    const kpi: KpiValue = {
      key: 'exp', label: 'MTD Expenses', value: 120, format: 'currency',
      changeRatio: 0.2, higherIsBetter: false,
    };
    const { container } = render(<KPICard kpi={kpi} period="2027-01" />);
    expect(container.querySelector('.sv-kpi__delta--down')).not.toBeNull();
    expect(container.querySelector('.sv-kpi__delta--up')).toBeNull();
  });
});

/* ================================================================== *
 * 4 · Filters update UI state
 * ================================================================== */

describe('4 · filters change the data', () => {
  it('a property filter narrows the board and the figures', async () => {
    const all = await provider.getDashboard({ month: '2027-01' });
    const filtered = await provider.getDashboard({ month: '2027-01', propertyId: 'HYD-501' });

    expect(all.data.properties).toHaveLength(4);
    expect(filtered.data.properties).toHaveLength(1);
    expect(filtered.data.properties[0]!.propertyId).toBe('HYD-501');
  });

  it('a platform filter narrows the channel mix', async () => {
    const filtered = await provider.getDashboard({ month: '2027-01', platform: 'Airbnb' });
    expect(filtered.data.platforms).toHaveLength(1);
    expect(filtered.data.platforms[0]!.platform).toBe('Airbnb');
  });

  it('a month filter changes the reported period and its figures', async () => {
    const a = await provider.getDashboard({ month: '2026-11' });
    const b = await provider.getDashboard({ month: '2026-12' });
    expect(a.meta.period).toBe('2026-11');
    expect(b.meta.period).toBe('2026-12');
    expect(a.data.kpis.find((k) => k.key === 'mtdRevenue')!.value)
      .not.toBe(b.data.kpis.find((k) => k.key === 'mtdRevenue')!.value);
  });

  it('an unknown month falls back to the latest with data rather than erroring', async () => {
    const { meta } = await provider.getDashboard({ month: '2099-01' });
    const months = await provider.getAvailableMonths();
    expect(meta.period).toBe(months[months.length - 1]);
  });
});

/* ================================================================== *
 * 5 · Demo-mode indicator
 * ================================================================== */

describe('5 · demo mode is unmistakable', () => {
  it('LIVE_DATA_ENABLED is false in this phase', () => {
    expect(isLiveDataEnabled()).toBe(false);
    expect(isDemoMode()).toBe(true);
  });

  it('renders the DEMO / UAT badge, the environment and the data source together', () => {
    const meta: DataMeta = {
      source: 'FIXTURE', asOf: new Date().toISOString(), period: '2027-01',
      freshness: 'GOOD', demo: true,
    };
    render(<EnvironmentStatus environment={DEMO_ENVIRONMENT} meta={meta} />);
    // All three questions answered in one place: which system, which source, how old.
    expect(screen.getByText('DEMO / UAT')).toBeDefined();
    expect(screen.getByText('Environment')).toBeDefined();
    expect(screen.getByText('DEMO')).toBeDefined();
    expect(screen.getByText('Data source')).toBeDefined();
    expect(screen.getByText('Demo Workbook (fixtures)')).toBeDefined();
    expect(screen.getByText('Last synced')).toBeDefined();
  });

  it('production shows no demo badge and names the real workbook', () => {
    const meta: DataMeta = {
      source: 'GOOGLE_SHEETS', asOf: new Date().toISOString(), period: '2027-01',
      freshness: 'GOOD', demo: false,
    };
    render(<EnvironmentStatus environment={PRODUCTION_ENVIRONMENT} meta={meta} />);
    expect(screen.queryByText('DEMO / UAT')).toBeNull();
    expect(screen.queryByText(/DEMO/)).toBeNull();
    expect(screen.getByText('PRODUCTION')).toBeDefined();
    expect(screen.getByText('Srivillu Operations Workbook')).toBeDefined();
  });

  it('every fixture payload is marked demo', async () => {
    const { meta } = await loadDashboard();
    expect(meta.demo).toBe(true);
    expect(meta.source).toBe('FIXTURE');
  });

  it('refuses to serve fixtures while claiming to be live', () => {
    __setDataProviderForTests(null);
    const original = { ...process.env };
    process.env.LIVE_DATA_ENABLED = 'true';
    delete process.env.DEMO_GOOGLE_SHEET_ID;
    delete process.env.DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

    // A silent fallback here would present demo numbers as business numbers. The
    // assertion is on the BEHAVIOUR, not the wording: it must fail, it must name what is
    // missing so an operator can fix it, and it must say plainly that it will not
    // substitute another source.
    let thrown: Error | null = null;
    try { getDataProvider(); } catch (error) { thrown = error as Error; }
    expect(thrown, 'live mode with no connection must throw').not.toBeNull();
    expect(thrown!.message).toMatch(/DEMO_GOOGLE_SHEET_ID/);
    expect(thrown!.message).toMatch(/will not fall back/i);

    process.env = original;
    __setDataProviderForTests(null);
  });

  it('with live enabled AND configured, the provider is the Sheets one — never a fixture', () => {
    __setDataProviderForTests(null);
    const original = { ...process.env };
    process.env.LIVE_DATA_ENABLED = 'true';
    process.env.APP_ENV = 'demo';
    process.env.DEMO_GOOGLE_SHEET_ID = 'demo-spreadsheet-id';
    // Built at runtime so no credential-shaped literal exists in the source tree.
    process.env.DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = Buffer
      .from(JSON.stringify({ client_email: 'demo@example.invalid' }), 'utf8')
      .toString('base64');

    const provider = getDataProvider();
    expect(provider.kind).toBe('GOOGLE_SHEETS');

    process.env = original;
    __setDataProviderForTests(null);
  });
});

/* ================================================================== *
 * 6–8 · Loading, empty and error states
 * ================================================================== */

describe('6 · loading states render', () => {
  it('DataBoundary shows a skeleton and announces it politely', () => {
    const { container } = render(
      <DataBoundary loading data={null}>{() => <p>never</p>}</DataBoundary>,
    );
    expect(container.querySelectorAll('.sv-skeleton').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.queryByText('never')).toBeNull();
  });

  it('KPICard has a loading state rather than rendering a blank card', () => {
    const kpi: KpiValue = { key: 'k', label: 'MTD Revenue', value: 1, format: 'currency' };
    const { container } = render(<KPICard kpi={kpi} period="2027-01" loading />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe('7 · empty states render', () => {
  it('shows a meaningful message instead of a blank box', () => {
    render(
      <DataBoundary
        data={[]}
        emptyTitle="No reservations for this period"
        emptyMessage="Try a different month."
      >{() => <p>rows</p>}</DataBoundary>,
    );
    expect(screen.getByText('No reservations for this period')).toBeDefined();
    expect(screen.queryByText('rows')).toBeNull();
  });

  it('the dashboard renders an empty board when a filter matches nothing', async () => {
    const { view, meta } = await loadDashboard();
    render(<DashboardContent view={{ ...view, properties: [] }} meta={meta} />);
    expect(screen.getByText('No properties match this filter')).toBeDefined();
  });
});

describe('8 · error states render', () => {
  it('shows an actionable message and a retry action', async () => {
    const onRetry = vi.fn();
    render(
      <DataBoundary error="Unable to load revenue data." data={null} onRetry={onRetry}>
        {() => <p>rows</p>}
      </DataBoundary>,
    );
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('Unable to load revenue data.')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('treats a null payload as an error, not as empty', () => {
    render(<DataBoundary data={null}>{() => <p>rows</p>}</DataBoundary>);
    expect(screen.getByRole('alert')).toBeDefined();
  });
});

/* ================================================================== *
 * 9 · Unauthorized roles cannot render restricted routes
 * ================================================================== */

describe('9 · role-aware rendering', () => {
  const hasCapability = (role: Role) => (capability: Capability) =>
    capabilitiesFor(role).includes(capability);

  it('an operations user sees no finance navigation', () => {
    const sections = visibleNavigation(hasCapability('OPERATIONS'));
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    for (const hidden of ['Revenue', 'Expenses', 'Cash Flow', 'P&L', 'Investors', 'Distributions']) {
      expect(labels, `OPERATIONS must not see ${hidden}`).not.toContain(hidden);
    }
    expect(labels).toContain('Today');
  });

  it('an investor sees only their own portfolio — no management navigation at all', () => {
    // Phase 5A gave the investor role a screen of its own. Before that they had none,
    // which meant signing in landed them on a refusal. The list must stay exactly this
    // long: one entry, and it is theirs.
    const items = visibleNavigation(hasCapability('INVESTOR')).flatMap((s) => s.items);
    expect(items.map((i) => i.label)).toEqual(['Portfolio']);
    expect(items[0]!.href).toBe('/admin/portfolio');
    expect(items[0]!.capability).toBe('investor.self.read');
  });

  it('management never sees the investor-only portfolio entry', () => {
    for (const role of ['ADMIN', 'OPERATIONS', 'SUPER_ADMIN'] as const) {
      const labels = visibleNavigation(hasCapability(role)).flatMap((s) => s.items.map((i) => i.label));
      if (role === 'SUPER_ADMIN') continue;   // holds every capability by definition
      expect(labels, role).not.toContain('Portfolio');
    }
  });

  it('an admin sees finance and investor navigation', () => {
    const labels = visibleNavigation(hasCapability('ADMIN')).flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain('P&L');
    expect(labels).toContain('Investors');
    expect(labels).toContain('Dashboard');
  });

  it('navigation hiding is backed by the route guard, not a substitute for it', () => {
    expect(canLoadRoute('OPERATIONS', '/admin/finance/pnl')).toBe(false);
    expect(canLoadRoute('INVESTOR', '/admin/dashboard')).toBe(false);
    expect(canLoadRoute('ADMIN', '/admin/dashboard')).toBe(true);
  });
});

/* ================================================================== *
 * 10 · No client component accesses credentials
 * ================================================================== */

describe('10 · no credential access in client code', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('no component or page reads a secret', () => {
    const secret = /process\.env\.(OPENAI_API_KEY|GOOGLE_SERVICE_ACCOUNT[A-Z_]*|SUPABASE_SERVICE_ROLE_KEY)/;
    const offenders = walk(path.join(ROOT, 'components'))
      .concat(walk(path.join(ROOT, 'app')))
      .filter((f) => secret.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('no client component imports the Sheets adapter or the OpenAI SDK', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, 'components')).concat(walk(path.join(ROOT, 'app')))) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes("'use client'")) continue;
      if (/from ['"]openai|@\/lib\/server\/sheets\/client|googleapis/.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the AI page makes no model call', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'app/admin/ai/page.tsx'), 'utf8');
    const code = codeOnly(raw);
    // The comment may discuss OpenAI; the code must not reach for it.
    expect(code).not.toMatch(/from ['\"]openai|api\.openai\.com|fetch\s*\(/i);
    // §11 puts the AI copilot at Phase 9. Phase 7 (the investor portal) has shipped, so
    // naming it here told a client the wrong thing about what they were waiting for.
    expect(raw).toContain('Phase 9');
    // The composer is inert, not merely styled to look inert.
    expect(raw).toMatch(/disabled/);
  });
});

/* ================================================================== *
 * 11 · The dashboard never writes CFG_REPORT_MONTH
 * ================================================================== */

describe('11 · CFG_REPORT_MONTH is never written', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('no UI file references the shared reporting-month cell in code', () => {
    const offenders = walk(path.join(ROOT, 'app'))
      .concat(walk(path.join(ROOT, 'components')), walk(path.join(ROOT, 'lib/data')))
      .filter((f) => /CFG_REPORT_MONTH/.test(codeOnly(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the rule is documented where the period is actually chosen', () => {
    // The scan above ignores comments, so assert the explanation exists rather than
    // letting a future edit silently remove the reason.
    const source = fs.readFileSync(path.join(ROOT, 'components/shell/FilterContext.tsx'), 'utf8');
    expect(source).toContain('CFG_REPORT_MONTH');
  });

  it('no UI file performs any sheet write', () => {
    const offenders = walk(path.join(ROOT, 'app'))
      .concat(walk(path.join(ROOT, 'components')), walk(path.join(ROOT, 'lib/data')))
      .filter((f) => /\.(append|batchUpdate|updateById)\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('period selection lives in the URL, not in shared state', () => {
    const source = fs.readFileSync(path.join(ROOT, 'components/shell/FilterContext.tsx'), 'utf8');
    expect(source).toContain('useSearchParams');
    expect(source).not.toMatch(/append|batchUpdate|setValue/);
  });
});

/* ================================================================== *
 * 12 · Financial values come from the provider
 * ================================================================== */

describe('12 · no hard-coded business values in the UI', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(tsx?)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('no component computes revenue, profit or occupancy arithmetic', () => {
    // Deriving a business figure in a component creates a second definition of it.
    const forbidden = /netRevenue\s*[-+*/]\s*operatingExpenses|grossAmount\s*-\s*|occupiedNights\s*\/\s*availableNights/i;
    const offenders = walk(path.join(ROOT, 'components'))
      .concat(walk(path.join(ROOT, 'app')))
      .filter((f) => forbidden.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('no component contains a commercial constant', () => {
    const forbidden = /\b0\.(15|18|65|60|40|05)\b/;
    const offenders = walk(path.join(ROOT, 'components'))
      .concat(walk(path.join(ROOT, 'app')))
      .filter((f) => forbidden.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('KPI values pass through the provider unchanged', async () => {
    const { view } = await loadDashboard('2027-01');
    const series = computeMonthlySeries(buildDemoWorkbook(), fyMonthKeysFor(buildDemoWorkbook()));
    const january = series.find((m) => m.monthKey === '2027-01')!;
    expect(view.kpis.find((k) => k.key === 'mtdRevenue')!.value).toBe(january.netRevenue);
    expect(view.kpis.find((k) => k.key === 'mtdProfit')!.value).toBe(january.operatingProfit);
    expect(view.kpis.find((k) => k.key === 'occupancy')!.value).toBe(january.occupancyPct);
  });

  it('an unset business rule renders as unavailable, never as ₹0', async () => {
    const { view, meta } = await loadDashboard();
    const distributions = view.kpis.find((k) => k.key === 'investorDistributions')!;
    expect(distributions.unavailable?.reason).toBe('CONFIGURATION_REQUIRED');

    render(<KPICard kpi={distributions} period={meta.period} />);
    expect(screen.getByText('Not configured')).toBeDefined();
    expect(screen.getByText('Management rules not configured')).toBeDefined();
    expect(screen.queryByText('₹0')).toBeNull();
  });
});

/* ================================================================== *
 * 13 · Property metrics match the fixture source records
 * ================================================================== */

describe('13 · property metrics match source records', () => {
  it('each property row equals the engine computed directly from the workbook', async () => {
    const workbook = buildDemoWorkbook();
    const expected = computeByProperty(workbook, monthPeriod('2027-01'));
    const { view } = await loadDashboard('2027-01');

    for (const row of expected) {
      const rendered = view.properties.find((p) => p.propertyId === row.propertyId)!;
      expect(rendered.netRevenue, `${row.propertyId} revenue`).toBe(row.netRevenue);
      expect(rendered.profit, `${row.propertyId} profit`).toBe(row.profit);
      expect(rendered.occupiedNights, `${row.propertyId} nights`).toBe(row.occupiedNights);
      expect(rendered.adr, `${row.propertyId} ADR`).toBe(row.adr);
    }
  });

  it('unit status is derived from the operational records, not authored', async () => {
    const ops = buildDemoOps();
    const { view } = await loadDashboard();
    const maintenanceUnits = view.properties.filter((p) => p.status === 'Maintenance');
    for (const unit of maintenanceUnits) {
      const ticket = ops.maintenance.find(
        (t) => t.propertyId === unit.propertyId && ['Critical', 'High'].includes(t.priority),
      );
      expect(ticket, `${unit.propertyId} shows Maintenance without an open high-priority ticket`).toBeDefined();
      expect(unit.statusDetail).toBe(ticket!.description);
    }
  });

  it('today counters equal the operational records', async () => {
    const ops = buildDemoOps();
    const { view } = await loadDashboard();
    expect(view.today.lowStock).toBe(ops.inventory.filter((i) => i.currentStock <= i.minStock).length);
    expect(view.today.guestRequests).toBe(ops.guestRequests.filter((r) => r.status !== 'Resolved').length);
  });
});

/* ================================================================== *
 * 14 · Investor preview stays isolated
 * ================================================================== */

describe('14 · investor preview isolation', () => {
  it('the admin preview exposes no route that accepts an investor id from the client', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/admin/investors/distributions/page.tsx'), 'utf8');
    expect(source).not.toMatch(/searchParams\.[a-zA-Z]*investor/i);
    expect(source).not.toMatch(/investorId\s*[:=]\s*(params|searchParams)/i);
  });

  it('the investor service still refuses an empty scope', () => {
    const service = new InvestorService(buildDemoWorkbook());
    expect(() => service.distributions('', ['2027-01'])).toThrow(/server-resolved investor id/i);
  });

  it('the investor preview shows CONFIGURATION REQUIRED rather than a fabricated split', async () => {
    const { data } = await provider.getInvestorPreview({ month: '2027-01' });
    expect(data.configured).toBe(false);
    expect(data.waterfall.investorPoolAmt).toBe(0);
    expect(data.configurationMessage).toMatch(/MANAGEMENT DECISION REQUIRED/i);
    // Operating profit is still reported honestly — only the split is withheld.
    expect(data.waterfall.operatingProfit).not.toBe(0);
  });

  it('guest names are minimised wherever they appear in a list', async () => {
    const { data } = await provider.getReservations({ month: '2027-01' });
    for (const row of data) {
      expect(row.guestDisplayName, row.bookingId).toMatch(/^[^\s]+ [A-Z]\.$|^Guest$|^[^\s]+$/);
    }
    expect(minimizeGuestName('Ananya Krishnan')).toBe('Ananya K.');
  });

  it('no reservation row carries contact details', async () => {
    const { data } = await provider.getReservations({ month: '2027-01' });
    const payload = JSON.stringify(data);
    expect(payload).not.toMatch(/@|phone|mobile|email/i);
  });
});

/* ================================================================== *
 * Accessibility spot-checks
 * ================================================================== */

describe('accessibility', () => {
  it('charts expose an equivalent data table to assistive technology', async () => {
    const { view, meta } = await loadDashboard();
    const { container } = render(<DashboardContent view={view} meta={meta} />);
    const hiddenTables = container.querySelectorAll('table.sv-visually-hidden');
    expect(hiddenTables.length).toBeGreaterThanOrEqual(4);
    expect(within(hiddenTables[0] as HTMLElement).getByText(/Month/)).toBeDefined();
  });

  it('attention states are announced, not signalled by colour alone', async () => {
    const { view, meta } = await loadDashboard();
    const { container } = render(<DashboardContent view={view} meta={meta} />);
    const tiles = container.querySelectorAll('.sv-today__tile--attention, .sv-today__tile--urgent');
    for (const tile of Array.from(tiles)) {
      expect(tile.querySelector('.sv-visually-hidden')?.textContent).toBe('Needs attention');
    }
  });

  it('every chart has an accessible name', async () => {
    const { view, meta } = await loadDashboard();
    const { container } = render(<DashboardContent view={view} meta={meta} />);
    for (const img of Array.from(container.querySelectorAll('[role="img"]'))) {
      expect(img.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(10);
    }
  });
});
