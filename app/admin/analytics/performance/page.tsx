import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, EmptyState, Badge } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RevenueTrendChart, OccupancyTrendChart } from '@/components/charts/Charts';
import { formatCurrency, formatPercent, formatMonthShort } from '@/lib/shared/format';
import type { MonthlyMetrics } from '@/lib/shared/domain';

export const metadata = { title: 'Performance — Srivillu Home Stays' };

export default async function PerformancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="financial"
      capability="analytics.read"
      title="Performance"
      description="Portfolio KPIs across the financial year. Months without trading data are shown as such rather than as zeros."
      searchParams={params}
      filters={['month']}
      fetcher={(provider, f) => provider.getMonthlySeries(f)}
    >
      {(series) => <Performance series={series} />}
    </ReadOnlyPage>
  );
}

function Performance({ series }: { series: MonthlyMetrics[] }) {
  const active = series.filter((m) => m.grossRevenue > 0 || m.operatingExpenses > 0);

  if (active.length === 0) {
    return (
      <Card>
        <CardHeader title="Performance" />
        <CardBody>
          <EmptyState title="No trading history yet" message="KPIs appear once revenue or expenses are recorded." />
        </CardBody>
      </Card>
    );
  }

  const columns: Column<MonthlyMetrics>[] = [
    { key: 'month', header: 'Month', render: (m) => formatMonthShort(m.monthKey) },
    { key: 'occupancy', header: 'Occupancy', numeric: true, render: (m) => formatPercent(m.occupancyPct, 0) },
    { key: 'adr', header: 'ADR', numeric: true, render: (m) => formatCurrency(m.adr) },
    { key: 'revpar', header: 'RevPAR', numeric: true, render: (m) => formatCurrency(m.revPar) },
    { key: 'net', header: 'Net revenue', numeric: true, render: (m) => formatCurrency(m.netRevenue) },
    { key: 'opex', header: 'Operating expenses', numeric: true, render: (m) => formatCurrency(m.operatingExpenses) },
    {
      key: 'profit', header: 'Operating profit', numeric: true,
      render: (m) => <span className={m.operatingProfit < 0 ? 'sv-negative' : ''}>{formatCurrency(m.operatingProfit)}</span>,
    },
    { key: 'margin', header: 'Margin', numeric: true, render: (m) => formatPercent(m.operatingMarginPct) },
    { key: 'bookings', header: 'Bookings', numeric: true, render: (m) => m.bookingsCount },
    { key: 'alos', header: 'ALOS', numeric: true, render: (m) => m.alos.toFixed(1) },
    { key: 'cancel', header: 'Cancellation', numeric: true, render: (m) => formatPercent(m.cancellationRatePct, 0) },
  ];

  return (
    <>
      <div className="sv-chart-grid">
        <Card>
          <CardHeader title="Revenue" subtitle="Net revenue by month." />
          <CardBody>
            <RevenueTrendChart title="Net revenue by month"
              points={active.map((m) => ({ label: formatMonthShort(m.monthKey), value: m.netRevenue }))} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Occupancy" subtitle="Occupied nights over available nights." />
          <CardBody>
            <OccupancyTrendChart title="Occupancy by month"
              points={active.map((m) => ({ label: formatMonthShort(m.monthKey), value: m.occupancyPct }))} />
          </CardBody>
        </Card>
      </div>

      <div style={{ height: 'var(--space-4)' }} />

      <Card>
        <CardHeader
          title="Monthly KPIs"
          subtitle={`${active.length} months with trading data out of ${series.length} in the financial year.`}
          action={<Badge tone="warn">Forecasting: Phase 8</Badge>}
        />
        <CardBody className="sv-card__body--flush">
          <DataTable columns={columns} rows={active} caption="Monthly KPI table" getRowKey={(m) => m.monthKey} />
        </CardBody>
      </Card>
    </>
  );
}
