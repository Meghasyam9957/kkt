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

      <div className="sv-chart-grid">
        <Accuracy
          title="Occupancy against actual"
          unit="nights"
          rows={accuracy.filter((a) => a.horizon === 'occupancy')}
        />
        <Accuracy
          title="Revenue against actual"
          unit="currency"
          rows={accuracy.filter((a) => a.horizon === 'revenue')}
        />
      </div>
    </>
  );
}

/**
 * One horizon's forecast-vs-actual. Nights and rupees get separate tables rather than
 * separate rows: a single column of numbers where some are nights and some are money is
 * a table nobody can read at a glance, and misreading it is a costly kind of mistake.
 */
function Accuracy({
  title, unit, rows,
}: { title: string; unit: 'nights' | 'currency'; rows: ForecastAccuracy[] }) {
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle="Each completed month re-estimated from the months before it, so the method's accuracy is visible rather than asserted. Confirmed bookings and later rates are both excluded from the re-estimate — the workbook keeps no record of what was on the books at the time, and counting today's would make every past month look perfectly predicted."
      />
      <CardBody className="sv-card__body--flush">
        {rows.length === 0 ? (
          <EmptyState
            title="No completed months to compare yet"
            message="Accuracy appears once the forecast has a settled month behind it."
          />
        ) : (
          <DataTable
            columns={accuracyColumns(unit)}
            rows={rows}
            caption={`Forecast versus actual ${unit === 'nights' ? 'occupied nights' : 'room revenue'}`}
            getRowKey={(a) => `${a.horizon}-${a.monthKey}`}
          />
        )}
      </CardBody>
    </Card>
  );
}

const accuracyColumns = (unit: 'nights' | 'currency'): Column<ForecastAccuracy>[] => {
  const amount = (value: number) =>
    unit === 'currency' ? formatCurrency(value) : String(Math.round(value));
  return [
    { key: 'month', header: 'Month', render: (a) => formatMonthShort(a.monthKey) },
    { key: 'forecast', header: 'Forecast', numeric: true, render: (a) => amount(a.forecast) },
    { key: 'actual', header: 'Actual', numeric: true, render: (a) => amount(a.actual) },
    {
      key: 'variance', header: 'Variance', numeric: true,
      render: (a) => (
        <span className={a.variance < 0 ? 'sv-negative' : ''}>
          {a.variance > 0 ? '+' : ''}{amount(a.variance)}
        </span>
      ),
    },
    {
      key: 'variancePct', header: 'Variance %', numeric: true,
      render: (a) => (a.variancePct === null ? '—' : formatPercent(a.variancePct, 1)),
    },
  ];
};
