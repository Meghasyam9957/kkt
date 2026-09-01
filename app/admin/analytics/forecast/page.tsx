import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, EmptyState, Badge } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatPercent, formatMonthShort, formatMonthLong } from '@/lib/shared/format';
import type { ForecastView } from '@/lib/data/providers/types';
import type {
  ForecastEstimate, ForecastAccuracy, ConfidenceAssessment,
} from '@/lib/server/analytics/forecast';

export const metadata = { title: 'Forecast — MAKAM Home Stays' };

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

/**
 * §9's confidence, or an honest refusal to state one.
 *
 * §9 derives confidence from three inputs and no business rule states a boundary for the
 * third, variance. Printing HIGH/MEDIUM/LOW from two of the three would put §9's own
 * words on a figure §9's rule did not produce — and this is the label a manager reads as
 * a reason to act or wait. So the two evaluable inputs are shown and the level is not.
 */
function ConfidenceBadge({ confidence }: { confidence: ConfidenceAssessment }) {
  if (confidence.level !== null) {
    return <Badge tone={CONFIDENCE_TONE[confidence.level]}>{confidence.level} confidence</Badge>;
  }
  return <Badge tone="neutral">Confidence: configuration required</Badge>;
}

/** The two §9 inputs that can be evaluated, so withholding the level costs no information. */
function ConfidenceInputs({ confidence }: { confidence: ConfidenceAssessment }) {
  return (
    <li>
      Confidence not stated: {confidence.unavailable?.message}{' '}
      Behind it — {confidence.historyMonths} complete month
      {confidence.historyMonths === 1 ? '' : 's'} of history and{' '}
      {formatPercent(confidence.bookingOnHandCoverage, 0)} of the estimate already confirmed.
    </li>
  );
}

const HORIZON_TITLES = {
  occupancy: 'Occupancy',
  revenue: 'Revenue',
  cashflow: 'Cash flow',
} as const;

function Estimate({ estimate, children }: { estimate: ForecastEstimate; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        title={HORIZON_TITLES[estimate.horizon]}
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
  const { occupancy, revenue, cashflow, accuracy, monthKey } = view;
  const period = formatMonthLong(monthKey);
  const cash = cashflow.inputs.cash;

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
              <ConfidenceBadge confidence={occupancy.confidence} />
            </p>
            <ul className="sv-demo__highlights">
              <li>{occupancy.inputs.bookingOnHandNights} nights already confirmed (booking-on-hand)</li>
              <li>{Math.round(occupancy.inputs.residualPickupNights)} nights expected still to be booked</li>
              <li>
                {occupancy.inputs.usableMonths} complete months of trading history ·{' '}
                rolling {occupancy.inputs.trailingMonthsUsed}-month pickup average
              </li>
              <ConfidenceInputs confidence={occupancy.confidence} />
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
              <ConfidenceBadge confidence={revenue.confidence} />
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
              <ConfidenceInputs confidence={revenue.confidence} />
            </ul>
          </Estimate>
        )}
      </div>

      <div style={{ height: 'var(--space-4)' }} />

      {cashflow.status === 'INSUFFICIENT_DATA' || cash === null ? (
        <Insufficient estimate={cashflow} />
      ) : (
        <Estimate estimate={cashflow}>
          <p className="sv-kpi__value">
            <span className={(cashflow.value ?? 0) < 0 ? 'sv-negative' : ''}>
              {formatCurrency(cashflow.value ?? 0)}
            </span>
          </p>
          <p className="sv-demo__meta">
            Projected balance at the end of {period} ·{' '}
            <ConfidenceBadge confidence={cashflow.confidence} />
          </p>
          {/*
            The four §9 terms, each shown as its own line. A cash forecast that shows only
            its result is one an operator cannot argue with, and this is the horizon they
            are most likely to act on.
          */}
          <ul className="sv-demo__highlights">
            <li>Opening balance {formatCurrency(cash.openingBalance)}</li>
            <li>
              Expected payouts {formatCurrency(cash.expectedPayouts)} — confirmed bookings,
              landing at check-out plus each platform&rsquo;s own lag
            </li>
            <li>
              Less scheduled rent and fixed costs {formatCurrency(cash.scheduledFixedCosts)}{' '}
              — from the obligation register, without assumed escalation
            </li>
            <li>
              Less variable operating spend {formatCurrency(cash.trailingVariableCosts)} —
              rolling {cash.variableMonthsUsed}-month average
            </li>
            <li>
              Net movement{' '}
              <span className={cash.netMovement < 0 ? 'sv-negative' : ''}>
                {formatCurrency(cash.netMovement)}
              </span>
            </li>
            <li>
              Deliberately conservative: only bookings that already exist are counted as
              cash. The {Math.round(occupancy.inputs.residualPickupNights)} nights the
              occupancy estimate expects still to be booked are not — they have no payout
              date, and a balance inflated by bookings nobody has made is how a real
              payment gets missed.
            </li>
            <ConfidenceInputs confidence={cashflow.confidence} />
          </ul>
        </Estimate>
      )}

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

const RE_ESTIMATED =
  "Each completed month re-estimated from the months before it, so the method's accuracy is "
  + 'visible rather than asserted. Later rates are excluded, because pricing a past month at '
  + 'a rate the estimate could not have known would flatter it.';

/**
 * What the re-estimate had to work with, said plainly.
 *
 * §9's method is booking-on-hand PLUS pickup. When the books of the time can be rebuilt,
 * these figures measure that method. When they cannot, they measure the pickup half alone
 * and therefore understate it — which the reader is told, because an accuracy table that
 * quietly measures something else is worse than none.
 */
function accuracySubtitle(rows: ForecastAccuracy[]): string {
  if (rows.some((r) => r.basis === 'unavailable')) {
    return `${RE_ESTIMATED} Confirmed bookings are excluded too: this data records no booking `
      + 'date, so which bookings existed at the time cannot be reconstructed, and counting '
      + "today's would make every past month look perfectly predicted. What is measured is "
      + 'therefore the pickup basis on its own — the full method, with the month’s '
      + 'confirmed bookings behind it, is more accurate than these figures suggest.';
  }
  return `${RE_ESTIMATED} Booking-on-hand is rebuilt from the bookings that had actually been `
    + 'made when each month opened, so this measures the whole method rather than half of it. '
    + 'One limit remains: a booking cancelled later is absent from the rebuild, because the '
    + 'workbook records only its status today.';
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
      <CardHeader title={title} subtitle={accuracySubtitle(rows)} />
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
