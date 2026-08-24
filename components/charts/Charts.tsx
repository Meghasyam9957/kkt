'use client';
/**
 * CHARTS — hand-built SVG.
 *
 * No chart library, for three reasons that matter here: full control of the restrained
 * visual language (no default palettes, no gradients, no 3D), real accessibility (each
 * chart exposes an equivalent data table to assistive technology), and a small bundle.
 *
 * Every chart is responsive via viewBox, keyboard-reachable, and pairs colour with a
 * legend label so colour is never the only channel.
 */
import { useId, useMemo, useState } from 'react';
import { formatCurrencyCompact, formatCurrency, formatPercent } from '@/lib/shared/format';

const PALETTE = {
  revenue: '#4F5F2C',
  expenses: '#B5651D',
  profit: '#C9A227',
  occupancy: '#4F5F2C',
  grid: 'var(--border-subtle)',
  axis: 'var(--text-muted)',
};

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

function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="sv-chart__legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className="sv-chart__swatch" style={{ background: item.color }} aria-hidden="true" />
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
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 260, PAD_L = 64, PAD_R = 16, PAD_T = 16, PAD_B = 36;

  const max = niceMax(Math.max(...points.map((p) => p.value), 1));
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(PAD_T + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD_T + innerH).toFixed(1)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  if (points.length === 0) return null;

  return (
    <figure className="sv-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="sv-chart__svg" role="img"
        aria-label={`${title}. Line chart of ${points.length} months.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke={PALETTE.grid} strokeWidth="1" />
            <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" className="sv-chart__tick">
              {formatCurrencyCompact(t)}
            </text>
          </g>
        ))}
        <path d={area} fill={PALETTE.revenue} opacity="0.10" />
        <path d={line} fill="none" stroke={PALETTE.revenue} strokeWidth="2.5"
          strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={p.label}>
            <circle cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 3.5}
              fill="var(--surface-card)" stroke={PALETTE.revenue} strokeWidth="2" />
            {/* Generous invisible hit area — small dots are hard to hit on a trackpad. */}
            <rect x={x(i) - 18} y={PAD_T} width={36} height={innerH} fill="transparent"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            {i % Math.ceil(points.length / 6) === 0 || i === points.length - 1 ? (
              <text x={x(i)} y={H - 12} textAnchor="middle" className="sv-chart__tick">{p.label}</text>
            ) : null}
          </g>
        ))}
        {hover !== null && points[hover] ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + innerH}
              stroke={PALETTE.revenue} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
            <text x={Math.min(x(hover) + 8, W - PAD_R - 90)} y={y(points[hover]!.value) - 12}
              className="sv-chart__tooltip-text">
              {points[hover]!.label}: {formatCurrency(points[hover]!.value)}
            </text>
          </g>
        ) : null}
      </svg>
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
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240, PAD_L = 52, PAD_R = 16, PAD_T = 16, PAD_B = 36;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const barW = Math.max(8, (innerW / Math.max(points.length, 1)) * 0.55);
  const x = (i: number) => PAD_L + (i + 0.5) * (innerW / Math.max(points.length, 1));
  const y = (v: number) => PAD_T + innerH - Math.min(v, 1) * innerH;

  if (points.length === 0) return null;

  return (
    <figure className="sv-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="sv-chart__svg" role="img"
        aria-label={`${title}. Bar chart of occupancy across ${points.length} months.`}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke={PALETTE.grid} strokeWidth="1" />
            <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" className="sv-chart__tick">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <g key={p.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={x(i) - barW / 2} y={y(p.value)} width={barW}
              height={Math.max(1, PAD_T + innerH - y(p.value))}
              fill={PALETTE.occupancy} opacity={hover === null || hover === i ? 0.9 : 0.45} rx="2" />
            {i % Math.ceil(points.length / 6) === 0 || i === points.length - 1 ? (
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
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 280, PAD_L = 64, PAD_R = 16, PAD_T = 16, PAD_B = 40;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;

  const maxValue = Math.max(...points.flatMap((p) => [p.revenue, p.expenses, Math.max(p.profit, 0)]), 1);
  const minValue = Math.min(...points.map((p) => p.profit), 0);
  const max = niceMax(maxValue);
  const min = minValue < 0 ? -niceMax(Math.abs(minValue)) : 0;
  const span = max - min;

  const groupW = innerW / Math.max(points.length, 1);
  const barW = Math.max(5, (groupW * 0.72) / 3);
  const y = (v: number) => PAD_T + innerH - ((v - min) / span) * innerH;
  const zeroY = y(0);

  if (points.length === 0) return null;

  const series = [
    { key: 'revenue' as const, label: 'Net revenue', color: PALETTE.revenue },
    { key: 'expenses' as const, label: 'Operating expenses', color: PALETTE.expenses },
    { key: 'profit' as const, label: 'Operating profit', color: PALETTE.profit },
  ];

  return (
    <figure className="sv-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="sv-chart__svg" role="img"
        aria-label={`${title}. Grouped bar chart comparing revenue, expenses and profit.`}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const value = min + f * span;
          return (
            <g key={f}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(value)} y2={y(value)}
                stroke={PALETTE.grid} strokeWidth="1" />
              <text x={PAD_L - 8} y={y(value) + 4} textAnchor="end" className="sv-chart__tick">
                {formatCurrencyCompact(value)}
              </text>
            </g>
          );
        })}
        {min < 0 ? <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
          stroke="var(--text-muted)" strokeWidth="1.5" /> : null}

        {points.map((p, i) => {
          const groupX = PAD_L + i * groupW + groupW / 2;
          return (
            <g key={p.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {series.map((s, si) => {
                const value = p[s.key];
                const barX = groupX - (barW * 3) / 2 + si * barW;
                const top = value >= 0 ? y(value) : zeroY;
                const height = Math.max(1, Math.abs(y(value) - zeroY));
                return (
                  <rect key={s.key} x={barX + 1} y={top} width={barW - 2} height={height}
                    fill={s.color} opacity={hover === null || hover === i ? 0.92 : 0.4} rx="1.5" />
                );
              })}
              {i % Math.ceil(points.length / 6) === 0 || i === points.length - 1 ? (
                <text x={groupX} y={H - 14} textAnchor="middle" className="sv-chart__tick">{p.label}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      {hover !== null && points[hover] ? (
        <p className="sv-chart__readout">
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
      <Legend items={[
        { label: 'Net revenue', color: PALETTE.revenue },
        { label: 'Operating profit', color: PALETTE.profit },
      ]} />
      <ChartTable caption={title} columns={['Property', 'Net revenue', 'Operating profit', 'Occupancy']}
        rows={bars.map((b) => [b.propertyId, formatCurrency(b.revenue), formatCurrency(b.profit), formatPercent(b.occupancyPct)])} />
    </figure>
  );
}
