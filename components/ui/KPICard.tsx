/**
 * KPICard — the dashboard's atom.
 *
 * Renders a value the server computed. It receives a `KpiValue` and formats it; it never
 * derives, sums or adjusts a business figure. That rule is what keeps a single definition
 * of every number in `lib/server/analytics/kpi.ts`.
 *
 * Three states, all first-class: value, loading, and unavailable (configuration required
 * or insufficient data). The unavailable state is not a zero — see ConfigurationRequired.
 */
import type { KpiValue } from '@/lib/data/providers/types';
import { formatKpi, formatChange, formatMonthLong } from '@/lib/shared/format';
import { Skeleton } from './primitives';

export function KPICard({ kpi, period, loading = false, emphasis = 'primary', sourceNote }: {
  kpi: KpiValue; period: string; loading?: boolean;
  /**
   * Visual weight (Verandah Ledger §12): `hero` is the one figure that leads the screen,
   * `primary` the Pulse row, `secondary` a ledger line in the Position block. Every
   * variant keeps the same anatomy and the same honest states.
   */
  emphasis?: 'hero' | 'primary' | 'secondary';
  /** Provenance line, e.g. "Updated 4 min ago". Supplied by the page from envelope meta. */
  sourceNote?: string;
}) {
  const variant = emphasis !== 'primary' ? ` sv-kpi--${emphasis}` : '';
  if (loading) {
    return (
      <div className={`sv-kpi${variant}`} aria-busy="true">
        <Skeleton height={11} width="58%" />
        <div style={{ height: 10 }} />
        <Skeleton height={26} width="72%" />
        <div style={{ height: 8 }} />
        <Skeleton height={10} width="42%" />
      </div>
    );
  }

  if (kpi.unavailable) {
    return (
      <div className={`sv-kpi sv-kpi--unavailable${variant}`}>
        <p className="sv-kpi__label">{kpi.label}</p>
        <p className="sv-kpi__unavailable-value">
          {kpi.unavailable.reason === 'CONFIGURATION_REQUIRED' ? 'Not configured' : 'Insufficient data'}
        </p>
        <p className="sv-kpi__unavailable-note">{kpi.unavailable.message}</p>
      </div>
    );
  }

  const change = formatChange(kpi.changeRatio);
  // Direction is about the business, not the arithmetic: expenses rising is not "up good".
  const isImprovement = change === null || kpi.higherIsBetter === undefined
    ? null
    : (kpi.changeRatio ?? 0) === 0 ? null
      : ((kpi.changeRatio ?? 0) > 0) === kpi.higherIsBetter;

  const trendClass = isImprovement === null ? 'sv-kpi__delta--flat'
    : isImprovement ? 'sv-kpi__delta--up' : 'sv-kpi__delta--down';

  return (
    <div className={`sv-kpi${variant}`}>
      <p className="sv-kpi__label" title={kpi.hint}>{kpi.label}</p>
      <p className="sv-kpi__value numeric">{formatKpi(kpi.value, kpi.format)}</p>
      <div className="sv-kpi__foot">
        <span className="sv-kpi__period">{formatMonthLong(period)}</span>
        {change ? (
          <span className={`sv-kpi__delta ${trendClass}`}>
            {/* Arrow is decorative; the signed number carries the meaning. */}
            <span aria-hidden="true">{(kpi.changeRatio ?? 0) > 0 ? '▲' : '▼'}</span>
            <span className="sv-visually-hidden">
              {isImprovement === null ? 'change' : isImprovement ? 'improved by' : 'worsened by'}
            </span>
            {change}
          </span>
        ) : null}
      </div>
      {kpi.hint ? <p className="sv-kpi__hint">{kpi.hint}</p> : null}
      {sourceNote ? <p className="sv-kpi__source">{sourceNote}</p> : null}
    </div>
  );
}

export function KPIGrid({ children }: { children: React.ReactNode }) {
  return <div className="sv-kpi-grid">{children}</div>;
}

/**
 * The Pulse — primary figures as ONE ledger band (hairline-bounded, vertical hairlines
 * between cells), not a wall of identical tiles. The hero cell spans two columns.
 */
export function KPIRow({ children }: { children: React.ReactNode }) {
  return <div className="sv-kpi-row">{children}</div>;
}
