'use client';
/**
 * DASHBOARD — the management command centre.
 *
 * The first viewport is arranged to answer, in order: how is the business performing
 * (KPIs), what needs attention today (TODAY strip), which unit is doing well or badly
 * (status board), and then the trends. Nothing decorative sits above the fold.
 *
 * This component renders. It does not calculate: every figure arrives from the provider,
 * which runs the server-side KPI engine. The only arithmetic here is picking which
 * property has the highest and lowest profit so the board can flag them.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import type { DashboardView as DashboardData, DataMeta, UrgentItem, KpiValue } from '@/lib/data/providers/types';
import { KPICard, KPIRow } from '@/components/ui/KPICard';
import { Card, CardHeader, CardBody, Section, StatusPill, EmptyState } from '@/components/ui/primitives';
import {
  RevenueTrendChart, OccupancyTrendChart, RevenueExpenseProfitChart, PropertyPerformanceChart,
} from '@/components/charts/Charts';
import {
  formatCurrency, formatPercent, formatMonthLong, formatDate, formatKpi, formatChange,
} from '@/lib/shared/format';
import type { UnitStatus, PropertyBoardRow } from '@/lib/data/providers/types';

/** The six figures the Pulse leads with; everything else is Position detail. */
const PULSE_KEYS = ['mtdRevenue', 'occupancy', 'mtdProfit', 'adr', 'revpar', 'netCash'] as const;

const STATUS_TONE: Record<UnitStatus, 'good' | 'info' | 'warn' | 'bad' | 'neutral'> = {
  Available: 'good',
  Occupied: 'info',
  Cleaning: 'warn',
  Maintenance: 'bad',
  Blocked: 'neutral',
};

export function DashboardContent({ view, meta, urgent = [] }: {
  view: DashboardData; meta: DataMeta;
  /** The operations board's attention list, fetched by the page alongside the KPIs. */
  urgent?: UrgentItem[];
}) {
  const { best, weakest } = useMemo(() => {
    if (view.properties.length < 2) return { best: null, weakest: null };
    const sorted = [...view.properties].sort((a, b) => b.profit - a.profit);
    return { best: sorted[0]!.propertyId, weakest: sorted[sorted.length - 1]!.propertyId };
  }, [view.properties]);

  const byKey = useMemo(() => new Map(view.kpis.map((k) => [k.key, k])), [view.kpis]);
  const pulse = PULSE_KEYS.map((k) => byKey.get(k)).filter((k): k is KpiValue => !!k);
  const position = view.kpis.filter((k) => !(PULSE_KEYS as readonly string[]).includes(k.key));

  return (
    <>
      {/* ---------- 1 · Lead sentence ---------- */}
      <Section>
        <p className="sv-lead">{leadSentence(byKey, meta.period, urgent.length)}</p>
      </Section>

      {/* ---------- 2 · Pulse ---------- */}
      <Section>
        <KPIRow>
          {pulse.map((kpi, i) => (
            <KPICard
              key={kpi.key} kpi={kpi} period={meta.period}
              emphasis={i === 0 ? 'hero' : 'primary'}
            />
          ))}
        </KPIRow>
      </Section>

      {/* ---------- 3 · Today (attention) ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="Today"
            subtitle={`Operational position for ${formatDate(view.today.date)}`}
          />
          <CardBody>
            <TodayStrip today={view.today} />
            {urgent.length > 0 ? <UrgentList items={urgent} /> : null}
          </CardBody>
        </Card>
      </Section>

      {/* ---------- Unit status board ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="Unit performance"
            subtitle={`Status now, with revenue and profit for ${formatMonthLong(meta.period)}. Direct costs only — shared costs are not allocated per unit.`}
          />
          <CardBody>
            {view.properties.length === 0 ? (
              <EmptyState
                title="No properties match this filter"
                message="Clear the property filter to see all four units."
              />
            ) : (
              <div className="sv-board">
                {view.properties.map((property) => (
                  <PropertyCard
                    key={property.propertyId}
                    property={property}
                    flag={property.propertyId === best ? 'best'
                      : property.propertyId === weakest ? 'weak' : null}
                  />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </Section>

      {/* ---------- Charts ---------- */}
      <Section>
        <div className="sv-chart-grid">
          <Card>
            <CardHeader title="Revenue trend" subtitle="Net revenue by month, after platform fees, discounts and taxes." />
            <CardBody>
              {view.trend.length === 0 ? (
                <EmptyState title="No revenue history" message="Revenue appears here once bookings are recorded." />
              ) : (
                <>
                  <RevenueTrendChart
                    title="Net revenue by month"
                    points={view.trend.map((t) => ({ label: t.label, value: t.netRevenue }))}
                  />
                  <p className="sv-chart__summary">{revenueSummary(view.trend)}</p>
                </>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Occupancy trend" subtitle="Occupied nights as a share of available nights." />
            <CardBody>
              {view.trend.length === 0 ? (
                <EmptyState title="No occupancy history" message="Occupancy appears here once stays are recorded." />
              ) : (
                <>
                  <OccupancyTrendChart
                    title="Occupancy by month"
                    points={view.trend.map((t) => ({ label: t.label, value: t.occupancyPct }))}
                  />
                  <p className="sv-chart__summary">{occupancySummary(view.trend)}</p>
                </>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Revenue, expenses and profit" subtitle="Operating expenses only — CAPEX is excluded from operating profit." />
            <CardBody>
              <RevenueExpenseProfitChart
                title="Revenue, expenses and profit by month"
                points={view.trend.map((t) => ({
                  label: t.label, revenue: t.netRevenue,
                  expenses: t.operatingExpenses, profit: t.operatingProfit,
                }))}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Property performance" subtitle={`Net revenue and operating profit for ${formatMonthLong(meta.period)}.`} />
            <CardBody>
              <PropertyPerformanceChart
                title="Property performance"
                bars={view.properties.map((p) => ({
                  propertyId: p.propertyId, label: p.bhkType,
                  revenue: p.netRevenue, profit: p.profit, occupancyPct: p.occupancyPct,
                }))}
              />
            </CardBody>
          </Card>
        </div>
      </Section>

      {/* ---------- 6 · Position ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="Position"
            subtitle="The month's standing detail: units, money owed and owing, open work."
          />
          <CardBody>
            <div className="sv-kpi-grid sv-kpi-grid--secondary">
              {position.map((kpi) => (
                <KPICard key={kpi.key} kpi={kpi} period={meta.period} emphasis="secondary" />
              ))}
            </div>
          </CardBody>
        </Card>
      </Section>

      {/* ---------- 7 · Insights ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="Insights"
            subtitle="Derived from this month's figures — observations, not advice."
            action={<Link className="sv-btn sv-btn--ghost sv-btn--sm" href="/admin/ai">Ask Copilot</Link>}
          />
          <CardBody>
            <ul className="sv-insights">
              {insights(byKey, urgent.length).map((line) => (
                <li key={line} className="sv-insights__item">{line}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Lead sentence + insights — FORMATTING of engine figures, never arithmetic.
 * Every number below is a KpiValue the server computed; these compose words around
 * them (and read changeRatio, which the engine also computed).
 * ------------------------------------------------------------------ */

function leadSentence(byKey: Map<string, KpiValue>, period: string, urgentCount: number): string {
  const revenue = byKey.get('mtdRevenue');
  const occupancy = byKey.get('occupancy');
  const profit = byKey.get('mtdProfit');
  const parts: string[] = [formatMonthLong(period)];
  if (revenue) parts.push(`net revenue ${formatKpi(revenue.value, revenue.format)}`);
  if (occupancy) parts.push(`occupancy ${formatKpi(occupancy.value, occupancy.format)}`);
  if (profit) {
    const change = formatChange(profit.changeRatio ?? null);
    parts.push(`operating profit ${formatKpi(profit.value, profit.format)}${change ? ` (${change} on last month)` : ''}`);
  }
  const attention = urgentCount === 0
    ? 'Nothing needs urgent attention.'
    : urgentCount === 1 ? 'One item needs attention.' : `${urgentCount} items need attention.`;
  return `${parts.join(' · ')}. ${attention}`;
}

function insights(byKey: Map<string, KpiValue>, urgentCount: number): string[] {
  const lines: string[] = [];
  const occupancy = byKey.get('occupancy');
  const adr = byKey.get('adr');
  if (occupancy?.changeRatio != null && adr?.changeRatio != null
    && occupancy.changeRatio > 0 && adr.changeRatio < 0) {
    lines.push(`Occupancy improved ${formatChange(occupancy.changeRatio)} while ADR moved ${formatChange(adr.changeRatio)} — volume is up, rate is down. Worth watching which way that trade is running.`);
  } else if (occupancy?.changeRatio != null && occupancy.changeRatio < 0) {
    lines.push(`Occupancy is ${formatChange(occupancy.changeRatio)} on last month — the calendar has more open nights than it did.`);
  }
  const payables = byKey.get('payables');
  const receivables = byKey.get('receivables');
  if (receivables && payables && receivables.value > payables.value) {
    lines.push(`More money is owed to the business (${formatKpi(receivables.value, receivables.format)}) than it owes (${formatKpi(payables.value, payables.format)}) — chasing payouts matters more than paying bills this week.`);
  }
  const maintenance = byKey.get('openMaintenance');
  if (maintenance && maintenance.value > 0) {
    lines.push(`${maintenance.value} maintenance ticket${maintenance.value === 1 ? '' : 's'} open — unresolved tickets turn into blocked nights.`);
  }
  if (urgentCount === 0 && lines.length === 0) {
    lines.push('A quiet month so far: nothing urgent, and the figures are moving without drama.');
  }
  return lines;
}

function UrgentList({ items }: { items: UrgentItem[] }) {
  return (
    <ul className="sv-urgentlist">
      {items.map((item) => (
        <li key={item.key} className={`sv-urgentlist__item sv-urgentlist__item--${item.severity}`}>
          <span className="sv-urgentlist__property numeric">{item.propertyId}</span>
          <span className="sv-urgentlist__text">
            <span className="sv-urgentlist__title">{item.title}</span>
            <span className="sv-urgentlist__action">{item.action}</span>
          </span>
          <Link className="sv-btn sv-btn--ghost sv-btn--sm" href="/admin/operations/today">Open</Link>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */

function TodayStrip({ today }: { today: DashboardData['today'] }) {
  // A counter the data source cannot supply is shown as "not tracked", never as 0 —
  // zero would read as "nothing outstanding", which is a different claim entirely.
  const missing = new Set(today.unavailable ?? []);
  const tiles = [
    { key: 'checkIns', label: 'Check-ins', value: today.checkIns, tone: 'normal' as const },
    { key: 'checkOuts', label: 'Check-outs', value: today.checkOuts, tone: 'normal' as const },
    { key: 'pendingCleaning', label: 'Pending cleaning', value: today.pendingCleaning, tone: today.pendingCleaning > 0 ? 'attention' as const : 'normal' as const },
    { key: 'openMaintenance', label: 'Open maintenance', value: today.openMaintenance, tone: today.openMaintenance > 0 ? 'urgent' as const : 'normal' as const },
    { key: 'lowStock', label: 'Low stock items', value: today.lowStock, tone: today.lowStock > 0 ? 'attention' as const : 'normal' as const },
    { key: 'guestRequests', label: 'Guest requests', value: today.guestRequests, tone: today.guestRequests > 0 ? 'attention' as const : 'normal' as const },
  ];
  return (
    <div className="sv-today">
      {tiles.map((tile) => {
        const unavailable = missing.has(tile.key);
        return (
          <div
            key={tile.label}
            className={`sv-today__tile ${!unavailable && tile.tone !== 'normal' ? `sv-today__tile--${tile.tone}` : ''}`}
          >
            {unavailable ? (
              <span className="sv-today__count sv-today__count--none" title="This source does not record it">—</span>
            ) : (
              <span className="sv-today__count numeric">{tile.value}</span>
            )}
            <span className="sv-today__label">{tile.label}</span>
            {unavailable ? <span className="sv-today__note">Not tracked</span> : null}
            {/* Status is never colour alone — needs-attention is spelled out. */}
            {!unavailable && tile.tone !== 'normal' ? (
              <span className="sv-visually-hidden">Needs attention</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PropertyCard({ property, flag }: { property: PropertyBoardRow; flag: 'best' | 'weak' | null }) {
  return (
    <article className={`sv-board__card sv-board__card--${property.status.toLowerCase()}`}>
      <div className="sv-board__head">
        <div>
          <p className="sv-board__id">{property.propertyId}</p>
          <p className="sv-board__unit">{property.bhkType} · Floor {property.floor} · up to {property.maxGuests} guests</p>
        </div>
        <StatusPill tone={STATUS_TONE[property.status]}>{property.status}</StatusPill>
      </div>

      <p className="sv-board__detail">{property.statusDetail ?? 'Ready for the next booking'}</p>

      {flag ? (
        <p className={`sv-board__flag sv-board__flag--${flag}`}>
          {flag === 'best' ? 'Best performer this month' : 'Weakest performer this month'}
        </p>
      ) : null}

      <div className="sv-board__metrics">
        <Metric label="Occupancy" value={formatPercent(property.occupancyPct, 0)} />
        <Metric label="Revenue" value={formatCurrency(property.netRevenue)} />
        <Metric label="Direct costs" value={formatCurrency(property.directOperatingExpenses)} />
        <Metric label="Profit" value={formatCurrency(property.profit)} negative={property.profit < 0} />
        <Metric label="ADR" value={formatCurrency(property.adr)} />
        <Metric label="RevPAR" value={formatCurrency(property.revPar)} />
      </div>
    </article>
  );
}

function Metric({ label, value, negative = false }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="sv-board__metric">
      <span className="sv-board__metric-label">{label}</span>
      <span className={`sv-board__metric-value numeric ${negative ? 'sv-negative' : ''}`}>{value}</span>
    </div>
  );
}

/* ---- Text summaries: a chart that needs a caption should get one ---- */

function revenueSummary(trend: DashboardData['trend']): string {
  if (trend.length < 2) return 'At least two months of history are needed to describe a trend.';
  const first = trend[0]!, last = trend[trend.length - 1]!;
  const best = [...trend].sort((a, b) => b.netRevenue - a.netRevenue)[0]!;
  const direction = last.netRevenue >= first.netRevenue ? 'higher' : 'lower';
  return `Net revenue in ${last.label} is ${formatCurrency(last.netRevenue)}, ${direction} than ${first.label} (${formatCurrency(first.netRevenue)}). The strongest month so far is ${best.label} at ${formatCurrency(best.netRevenue)}.`;
}

function occupancySummary(trend: DashboardData['trend']): string {
  if (trend.length === 0) return '';
  const average = trend.reduce((sum, t) => sum + t.occupancyPct, 0) / trend.length;
  const best = [...trend].sort((a, b) => b.occupancyPct - a.occupancyPct)[0]!;
  const worst = [...trend].sort((a, b) => a.occupancyPct - b.occupancyPct)[0]!;
  return `Occupancy averages ${formatPercent(average)} across ${trend.length} months, peaking at ${formatPercent(best.occupancyPct)} in ${best.label} and dipping to ${formatPercent(worst.occupancyPct)} in ${worst.label}.`;
}
