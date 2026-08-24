/**
 * Display formatting. Presentation only — no business logic, no derivation.
 * Indian numbering throughout (₹1,84,300 not ₹184,300): this is a Hyderabad business and
 * the figures are read by people who count in lakhs.
 */
import type { KpiFormat } from '@/lib/data/providers/types';

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
const INR_PRECISE = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const NUMBER = new Intl.NumberFormat('en-IN');

export function formatCurrency(value: number, precise = false): string {
  if (!Number.isFinite(value)) return '—';
  return (precise ? INR_PRECISE : INR).format(value);
}

/** Compact form for chart axes: ₹2.3L, ₹45K. Never used where an exact figure matters. */
export function formatCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  if (abs >= 1000) return `${sign}₹${Math.round(abs / 1000)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return NUMBER.format(Math.round(value));
}

export function formatKpi(value: number, format: KpiFormat): string {
  switch (format) {
    case 'currency': return formatCurrency(value);
    case 'percent': return formatPercent(value);
    case 'nights': return `${formatNumber(value)} nights`;
    default: return formatNumber(value);
  }
}

/** Signed change, e.g. "+12.4%". Returns null when there is nothing to compare against. */
export function formatChange(ratio: number | null | undefined): string | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
  const pct = ratio * 100;
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

/** '2027-01' → 'January 2027'. */
export function formatMonthLong(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1))
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** '2027-01' → 'Jan 2027'. */
export function formatMonthShort(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1))
    .toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** '2027-01-19' → '19 Jan 2027'. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** '19 Jan' — for dense tables where the year is implied by the period filter. */
export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Human freshness, e.g. "Updated 2 minutes ago".
 * Deliberately plain: the point is to tell the reader how much to trust the number.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'Unknown';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return 'Updated just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

/** Freshness thresholds: good under 15 minutes, stale beyond. */
export function freshnessFromTimestamp(iso: string, now: Date = new Date()): 'GOOD' | 'STALE' | 'ERROR' {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'ERROR';
  const minutes = (now.getTime() - then) / 60000;
  return minutes < 15 ? 'GOOD' : 'STALE';
}
