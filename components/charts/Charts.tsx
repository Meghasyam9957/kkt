'use client';
/**
 * CHARTS — hand-built SVG.
 *
 * No chart library, for three reasons that matter here: full control of the restrained
 * visual language (no default palettes, no gradients, no 3D), real accessibility (each
 * chart exposes an equivalent data table to assistive technology), and a small bundle.
 *
 * FOUNDATION (§15): the viewBox width is MEASURED from the container, not fixed — so a
 * phone renders a 360-unit chart, not a 720-unit chart scaled to half size with ~5px
 * text. Tick text is therefore always its real CSS size (the 11px floor applies inside
 * charts too). Narrow widths simplify — fewer gridlines, sparser labels — rather than
 * shrink. Series colours are the chart tokens (brand-derived, dark-theme aware); status
 * colours are never chart colours. Points are keyboard-reachable: focus mirrors hover.
 * Lines draw and bars grow once on first paint, and not at all under reduced motion.
 */
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { formatCurrencyCompact, formatCurrency, formatPercent } from '@/lib/shared/format';

const SERIES = {
  revenue: 'var(--chart-1)',
  expenses: 'var(--chart-3)',
  profit: 'var(--chart-2)',
  occupancy: 'var(--chart-1)',
  grid: 'var(--chart-grid)',
};

const DEFAULT_W = 720;

/**
 * The container's live width, via ResizeObserver. Before the first measurement (SSR,
 * first client frame, or a test DOM with no layout) the default holds — the chart is
 * correct immediately after hydration and never depends on measurement to render.
 */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_W);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const w = el.getBoundingClientRect().width;
      if (w >= 200) setWidth(Math.min(Math.round(w), 960));
    };
    apply();
    /*
     * ResizeObserver catches container-driven changes (a sidebar collapsing, a grid
     * reflowing). The window listener is a deliberate second channel: embedded and
     * background contexts can throttle observer delivery, and a viewport change must
     * never leave a chart drawn for the previous width.
     */
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(apply)
      : null;
    observer?.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [ref]);
  return width;
}

/** Narrow charts simplify (§15): fewer gridlines, sparser x labels — never smaller text. */
function densityFor(width: number, pointCount: number) {
  const narrow = width < 480;
  const gridFractions = narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const maxLabels = narrow ? 4 : 6;
  const labelStride = Math.max(1, Math.ceil(pointCount / maxLabels));
  return { gridFractions, labelStride };
}

interface Point { label: string; value: number }

/** Equivalent tabular data for screen readers — the chart itself is aria-hidden. */
function ChartTable({ caption, columns, rows }: {
  caption: string; columns: string[]; rows: Array<(string | number)[]>;
}) {
  return (
    <table className="sv-visually-hidden">
      <caption>{caption}</caption>
      <thead>
        <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (j === 0
              ? <th key={j} scope="row">{cell}</th>
              : <td key={j}>{cell}</td>))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The spoken half of the chart.
 *
 * An `<svg role="img">` is Children Presentational: everything inside it is pruned from
 * the accessibility tree, so a focusable bar's own `aria-label` announces nothing. The
 * shapes stay focusable (a sighted keyboard user gets the visual readout), and this live
 * region — OUTSIDE the img subtree, so it is never pruned — speaks the same figure.
 */
function ChartReadout({ text }: { text: string | null }) {
  return (
    <p className="sv-visually-hidden" aria-live="polite">{text ?? ''}</p>
  );
}

/**
 * A transparent full-height hit area, one per index, spanning the whole category pitch.
 * The painted bar can be 6px wide on a phone; the target must not be. Pointer events
 * cover mouse, pen and TOUCH in one handler, so tapping a month works.
 */
function HitArea({
  x, width, top, height, label, onActivate, onClear,
}: {
  x: number; width: number; top: number; height: number; label: string;
  onActivate: () => void; onClear: () => void;
}) {
  return (
    <rect
      x={x} y={top} width={Math.max(width, 1)} height={height}
      fill="transparent" tabIndex={0} aria-label={label}
      onPointerDown={onActivate}
      onMouseEnter={onActivate} onMouseLeave={onClear}
      onFocus={onActivate} onBlur={onClear}
    />
  );
}

function Legend({ items }: { items: Array<{ label: string; color: string; opacity?: number }> }) {
  return (
    <ul className="sv-chart__legend">
      {items.map((item) => (
        <li key={item.label}>
          {/* The swatch carries the mark's OWN treatment, opacity included — a solid
              swatch beside a 28%-opacity band reads as a different series. */}
          <span
            className="sv-chart__swatch"
            style={{ background: item.color, opacity: item.opacity ?? 1 }}
            aria-hidden="true"
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Nice round upper bound so gridlines land on readable numbers. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/* ================================================================== *
 * 1 · Revenue trend (line + area)
 * ================================================================== */

export function RevenueTrendChart({ points, title }: { points: Point[]; title: string }) {
  const id = useId();
  const figure = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = useMeasuredWidth(figure);
  const H = 260, PAD_L = W < 480 ? 52 : 64, PAD_R = 16, PAD_T = 16, PAD_B = 36;
  const { gridFractions, labelStride } = densityFor(W, points.length);

  const max = niceMax(Math.max(...points.map((p) => p.value), 1));
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const pitch = Math.max(innerW / Math.max(points.length, 1), 36);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(PAD_T + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD_T + innerH).toFixed(1)} Z`;

  if (points.length === 0) return null;

  return (
    <figure className="sv-chart" ref={figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className="sv-chart__svg" role="img"
        aria-label={`${title}. Line chart of ${points.length} months.`}>
        {gridFractions.map((f) => {
          const t = f * max;
          return (
            <g key={f}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke={SERIES.grid} strokeWidth="1" />
              <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" className="sv-chart__tick">
                {formatCurrencyCompact(t)}
              </text>
            </g>
          );
        })}
        <path d={area} fill={SERIES.revenue} opacity="0.10" />
        <path d={line} fill="none" stroke={SERIES.revenue} strokeWidth="2.5"
          strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="m-chart-line" />
        {points.map((p, i) => (
          <g key={p.label}>
            <circle cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 3.5}
              fill="var(--surface-card)" stroke={SERIES.revenue} strokeWidth="2" />
            {/* Full-pitch hit area: reachable by trackpad, finger and keyboard alike. */}
            <HitArea
              x={x(i) - pitch / 2} width={pitch} top={PAD_T} height={innerH}
              label={`${p.label}: ${formatCurrency(p.value)}`}
              onActivate={() => setHover(i)} onClear={() => setHover(null)} />
            {i % labelStride === 0 || i === points.length - 1 ? (
              /* The END labels are anchored inward. THIS chart spans the full inner
                 width, so its last point sits at exactly `W - PAD_R` and a centred label
                 there hangs half outside the viewBox — the year renders as "Feb 202".
                 The bar charts below do not need it: their points sit half a pitch in
                 from each edge already. */
              <text
                x={x(i)} y={H - 12}
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                className="sv-chart__tick"
              >{p.label}</text>
            ) : null}
          </g>
        ))}
        {hover !== null && points[hover] ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + innerH}
              stroke={SERIES.revenue} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
            <text x={Math.min(x(hover) + 8, W - PAD_R - 90)} y={y(points[hover]!.value) - 12}
              className="sv-chart__tooltip-text">
              {points[hover]!.label}: {formatCurrency(points[hover]!.value)}
            </text>
          </g>
        ) : null}
      </svg>
      <ChartReadout text={hover !== null && points[hover]
        ? `${points[hover]!.label}: ${formatCurrency(points[hover]!.value)}` : null} />
      <ChartTable caption={title} columns={['Month', 'Net revenue']}
        rows={points.map((p) => [p.label, formatCurrency(p.value)])} />
      <figcaption className="sv-visually-hidden" id={id}>{title}</figcaption>
    </figure>
  );
}

/* ================================================================== *
 * 2 · Occupancy trend (bars, 0–100%)
 * ================================================================== */

export function OccupancyTrendChart({ points, title }: { points: Point[]; title: string }) {
  const figure = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = useMeasuredWidth(figure);
  const H = 240, PAD_L = W < 480 ? 44 : 52, PAD_R = 16, PAD_T = 16, PAD_B = 36;
  const { gridFractions, labelStride } = densityFor(W, points.length);
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const pitch = innerW / Math.max(points.length, 1);
  const barW = Math.max(8, pitch * 0.55);
  const x = (i: number) => PAD_L + (i + 0.5) * pitch;
  const y = (v: number) => PAD_T + innerH - Math.min(v, 1) * innerH;

  if (points.length === 0) return null;

  return (
    <figure className="sv-chart" ref={figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className="sv-chart__svg" role="img"
        aria-label={`${title}. Bar chart of occupancy across ${points.length} months.`}>
        {gridFractions.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke={SERIES.grid} strokeWidth="1" />
            <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" className="sv-chart__tick">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <g key={p.label}>
            <rect x={x(i) - barW / 2} y={y(p.value)} width={barW}
              height={Math.max(1, PAD_T + innerH - y(p.value))}
              fill={SERIES.occupancy} opacity={hover === null || hover === i ? 0.9 : 0.6} rx="2"
              className="m-chart-bar" />
            {/* The target is the whole column, not the painted bar — which is ~14px wide
                on a phone, well under any usable tap size. */}
            <HitArea
              x={x(i) - pitch / 2} width={pitch} top={PAD_T} height={innerH}
              label={`${p.label}: ${formatPercent(p.value, 0)} occupancy`}
              onActivate={() => setHover(i)} onClear={() => setHover(null)} />
            {i % labelStride === 0 || i === points.length - 1 ? (
              <text x={x(i)} y={H - 12} textAnchor="middle" className="sv-chart__tick">{p.label}</text>
            ) : null}
            {hover === i ? (
              <text x={x(i)} y={y(p.value) - 8} textAnchor="middle" className="sv-chart__tooltip-text">
                {formatPercent(p.value, 0)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <ChartReadout text={hover !== null && points[hover]
        ? `${points[hover]!.label}: ${formatPercent(points[hover]!.value, 0)} occupancy` : null} />
      <ChartTable caption={title} columns={['Month', 'Occupancy']}
        rows={points.map((p) => [p.label, formatPercent(p.value)])} />
    </figure>
  );
}

/* ================================================================== *
 * 3 · Revenue vs Expenses vs Profit (grouped bars)
 * ================================================================== */

export interface TriplePoint { label: string; revenue: number; expenses: number; profit: number }

export function RevenueExpenseProfitChart({ points, title }: { points: TriplePoint[]; title: string }) {
  const figure = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = useMeasuredWidth(figure);
  const H = 280, PAD_L = W < 480 ? 52 : 64, PAD_R = 16, PAD_T = 16, PAD_B = 40;
  const { gridFractions, labelStride } = densityFor(W, points.length);
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;

  const maxValue = Math.max(...points.flatMap((p) => [p.revenue, p.expenses, Math.max(p.profit, 0)]), 1);
  const minValue = Math.min(...points.map((p) => p.profit), 0);
  const max = niceMax(maxValue);
  const min = minValue < 0 ? -niceMax(Math.abs(minValue)) : 0;
  const span = max - min;

  const groupW = innerW / Math.max(points.length, 1);
  const barW = Math.max(4, (groupW * 0.72) / 3);
  const y = (v: number) => PAD_T + innerH - ((v - min) / span) * innerH;
  const zeroY = y(0);

  if (points.length === 0) return null;

  const series = [
    { key: 'revenue' as const, label: 'Net revenue', color: SERIES.revenue },
    { key: 'expenses' as const, label: 'Operating expenses', color: SERIES.expenses },
    { key: 'profit' as const, label: 'Operating profit', color: SERIES.profit },
  ];

  return (
    <figure className="sv-chart" ref={figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className="sv-chart__svg" role="img"
        aria-label={`${title}. Grouped bar chart comparing revenue, expenses and profit.`}>
        {gridFractions.map((f) => {
          const value = min + f * span;
          return (
            <g key={f}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(value)} y2={y(value)}
                stroke={SERIES.grid} strokeWidth="1" />
              <text x={PAD_L - 8} y={y(value) + 4} textAnchor="end" className="sv-chart__tick">
                {formatCurrencyCompact(value)}
              </text>
            </g>
          );
        })}
        {min < 0 ? <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
          stroke="var(--chart-ref)" strokeWidth="1.5" /> : null}

        {points.map((p, i) => {
          const groupX = PAD_L + i * groupW + groupW / 2;
          return (
            <g key={p.label}>
              {/* One full-height target per month: the three painted bars are ~6px each
                  on a phone, so the group's own geometry is a comb of gaps. */}
              <HitArea
                x={groupX - groupW / 2} width={groupW} top={PAD_T} height={innerH}
                label={`${p.label}: revenue ${formatCurrency(p.revenue)}, expenses ${formatCurrency(p.expenses)}, profit ${formatCurrency(p.profit)}`}
                onActivate={() => setHover(i)} onClear={() => setHover(null)} />
              {series.map((s, si) => {
                const value = p[s.key];
                const barX = groupX - (barW * 3) / 2 + si * barW;
                const top = value >= 0 ? y(value) : zeroY;
                const height = Math.max(1, Math.abs(y(value) - zeroY));
                return (
                  <rect key={s.key} x={barX + 1} y={top} width={Math.max(barW - 2, 2)} height={height}
                    fill={s.color} opacity={hover === null || hover === i ? 0.92 : 0.6} rx="1.5"
                    className="m-chart-bar" />
                );
              })}
              {i % labelStride === 0 || i === points.length - 1 ? (
                <text x={groupX} y={H - 14} textAnchor="middle" className="sv-chart__tick">{p.label}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <ChartReadout text={hover !== null && points[hover]
        ? `${points[hover]!.label}: revenue ${formatCurrency(points[hover]!.revenue)}, expenses ${formatCurrency(points[hover]!.expenses)}, profit ${formatCurrency(points[hover]!.profit)}`
        : null} />
      {hover !== null && points[hover] ? (
        <p className="sv-chart__readout" aria-hidden="true">
          <strong>{points[hover]!.label}</strong>
          {` · revenue ${formatCurrency(points[hover]!.revenue)}`}
          {` · expenses ${formatCurrency(points[hover]!.expenses)}`}
          {` · profit ${formatCurrency(points[hover]!.profit)}`}
        </p>
      ) : null}
      <ChartTable caption={title} columns={['Month', 'Net revenue', 'Operating expenses', 'Operating profit']}
        rows={points.map((p) => [p.label, formatCurrency(p.revenue), formatCurrency(p.expenses), formatCurrency(p.profit)])} />
    </figure>
  );
}

/* ================================================================== *
 * 4 · Property comparison (horizontal bars)
 * ================================================================== */

export interface PropertyBar {
  propertyId: string; label: string; revenue: number; profit: number; occupancyPct: number;
}

export function PropertyPerformanceChart({ bars, title }: { bars: PropertyBar[]; title: string }) {
  const max = useMemo(() => niceMax(Math.max(...bars.map((b) => b.revenue), 1)), [bars]);
  if (bars.length === 0) return null;

  return (
    <figure className="sv-chart sv-chart--bars">
      <div role="img" aria-label={`${title}. Revenue and profit by property.`}>
        {bars.map((bar) => {
          const revenueWidth = (bar.revenue / max) * 100;
          const profitWidth = (Math.max(bar.profit, 0) / max) * 100;
          return (
            <div className="sv-bar-row" key={bar.propertyId}>
              <div className="sv-bar-row__label">
                <span className="sv-bar-row__id">{bar.propertyId}</span>
                <span className="sv-bar-row__meta">{bar.label}</span>
              </div>
              <div className="sv-bar-row__track">
                <div className="sv-bar-row__bar sv-bar-row__bar--revenue" style={{ width: `${revenueWidth}%` }} />
                <div className="sv-bar-row__bar sv-bar-row__bar--profit" style={{ width: `${profitWidth}%` }} />
              </div>
              <div className="sv-bar-row__values numeric">
                <span>{formatCurrency(bar.revenue)}</span>
                <span className={bar.profit < 0 ? 'sv-negative' : 'sv-muted'}>
                  {formatCurrency(bar.profit)} profit
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {/* Opacities mirror .sv-bar-row__bar--revenue / --profit: the revenue extent is a
          pale band the solid profit bar sits on top of. */}
      <Legend items={[
        { label: 'Net revenue', color: SERIES.revenue, opacity: 0.45 },
        { label: 'Operating profit', color: SERIES.profit, opacity: 0.95 },
      ]} />
      <ChartTable caption={title} columns={['Property', 'Net revenue', 'Operating profit', 'Occupancy']}
        rows={bars.map((b) => [b.propertyId, formatCurrency(b.revenue), formatCurrency(b.profit), formatPercent(b.occupancyPct)])} />
    </figure>
  );
}
