import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, EmptyState, Badge } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatPercent, formatMonthShort, formatMonthLong } from '@/lib/shared/format';
import type { ForecastView } from '@/lib/data/providers/types';
import type { ForecastEstimate, ForecastAccuracy } from '@/lib/server/analytics/forecast';

export const metadata = { title: 'Forecast — Srivillu Home Stays' };

export default async function ForecastPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="financial"
      capability="analytics.read"
      title="Forecast"
      description="Deterministic estimates for the month ahead. Every figure is calculated from recorded history — nothing here is predicted by a model, and a month without enough history is said to be so rather than shown as zero."
      searchParams={params}
      filters={[]}
      fetcher={(provider, f) => provider.getForecast(f)}
    >
      {(view) => <Forecast view={view} />}
    </ReadOnlyPage>
  );
}

/** HIGH / MEDIUM / LOW → the tone the design system already uses for standing. */
const CONFIDENCE_TONE = { HIGH: 'good', MEDIUM: 'warn', LOW: 'bad' } as const;

function Estimate({ estimate, children }: { estimate: ForecastEstimate; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        title={estimate.horizon === 'occupancy' ? 'Occupancy' : 'Revenue'}
        subtitle={estimate.method}
        action={<Badge tone="neutral">{estimate.label}</Badge>}
      />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

/**
 * §9: below the threshold the screen says so. It must never round an absence of history
 * into a zero, because a zero is a claim and this is the absence of one.
 */
function Insufficient({ estimate }: { estimate: ForecastEstimate }) {
  return (
    <Estimate estimate={estimate}>
      <EmptyState
        title="Forecast unavailable — insufficient historical data"
        message={estimate.reason ?? 'Not enough complete months of trading history.'}
      />
    </Estimate>
  );
}

function Forecast({ view }: { view: ForecastView }) {
  const { occupancy, revenue, accuracy, monthKey } = view;
  const period = formatMonthLong(monthKey);

  return (
    <>
      <div className="sv-chart-grid">
        {occupancy.status === 'INSUFFICIENT_DATA' ? (
          <Insufficient estimate={occupancy} />
        ) : (
          <Estimate estimate={occupancy}>
            <p className="sv-kpi__value">{formatPercent(occupancy.occupancyPct ?? 0, 1)}</p>
            <p className="sv-demo__meta">
              {period} · {Math.round(occupancy.value ?? 0)} of {occupancy.inputs.availableNights} nights ·{' '}
              <Badge tone={CONFIDENCE_TONE[occupancy.confidence ?? 'LOW']}>
                {occupancy.confidence} confidence
              </Badge>
            </p>
            <ul className="sv-demo__highlights">
              <li>{occupancy.inputs.bookingOnHandNights} nights already confirmed (booking-on-hand)</li>
              <li>{Math.round(occupancy.inputs.residualPickupNights)} nights expected still to be booked</li>
              <li>
                {occupancy.inputs.usableMonths} complete months of trading history ·{' '}
                rolling {occupancy.inputs.trailingMonthsUsed}-month pickup average
              </li>
            </ul>
          </Estimate>
        )}

        {revenue.status === 'INSUFFICIENT_DATA' ? (
          <Insufficient estimate={revenue} />
        ) : (
          <Estimate estimate={revenue}>
            <p className="sv-kpi__value">{formatCurrency(revenue.value ?? 0)}</p>
            <p className="sv-demo__meta">
              {period} · room revenue at a trailing ADR of{' '}
              {formatCurrency(revenue.inputs.trailingAdr ?? 0)} ·{' '}
              <Badge tone={CONFIDENCE_TONE[revenue.confidence ?? 'LOW']}>
                {revenue.confidence} confidence
              </Badge>
            </p>
            <ul className="sv-demo__highlights">
              <li>Forecast nights come from the occupancy estimate, never recalculated here</li>
              <li>
                {revenue.inputs.trailingMonthsUsed} month
                {revenue.inputs.trailingMonthsUsed === 1 ? '' : 's'} contributed a rate
              </li>
              {/*
                §9 asks for a property-level ADR. The blend is shown unit by unit so the
                rate can be checked against the units behind it rather than taken on trust.
              */}
              {revenue.inputs.adrBasis === 'property' ? (
                <li>
                  Unit rates:{' '}
                  {revenue.inputs.propertyRates
                    .map((r) => `${r.propertyId} ${formatCurrency(r.trailingAdr)} (${formatPercent(r.weight, 0)})`)
                    .join(' · ')}
                </li>
              ) : (
                <li>Portfolio rate — no per-unit history was available to blend</li>
              )}
            </ul>
          </Estimate>
        )}
      </div>

      <div style={{ height: 'var(--space-4)' }} />

      <Card>
        <CardHeader
          title="Forecast against actual"
          subtitle="Each completed month re-estimated from the months before it, so the method's accuracy is visible rather than asserted. Confirmed bookings are excluded from the re-estimate — the workbook keeps no record of what was on the books at the time, and counting today's would make every past month look perfectly predicted."
        />
        <CardBody className="sv-card__body--flush">
          {accuracy.length === 0 ? (
            <EmptyState
              title="No completed months to compare yet"
              message="Accuracy appears once the forecast has a settled month behind it."
            />
          ) : (
            <DataTable
              columns={ACCURACY_COLUMNS}
              rows={accuracy}
              caption="Forecast versus actual occupied nights"
              getRowKey={(a) => `${a.horizon}-${a.monthKey}`}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}

const ACCURACY_COLUMNS: Column<ForecastAccuracy>[] = [
  { key: 'month', header: 'Month', render: (a) => formatMonthShort(a.monthKey) },
  { key: 'forecast', header: 'Forecast nights', numeric: true, render: (a) => Math.round(a.forecast) },
  { key: 'actual', header: 'Actual nights', numeric: true, render: (a) => Math.round(a.actual) },
  {
    key: 'variance', header: 'Variance', numeric: true,
    render: (a) => (
      <span className={a.variance < 0 ? 'sv-negative' : ''}>
        {a.variance > 0 ? '+' : ''}{Math.round(a.variance)}
      </span>
    ),
  },
  {
    key: 'variancePct', header: 'Variance %', numeric: true,
    render: (a) => (a.variancePct === null ? '—' : formatPercent(a.variancePct, 1)),
  },
];
