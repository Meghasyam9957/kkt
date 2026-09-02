/**
 * Srivillu icon set — bespoke inline SVG, the only icons in the product.
 *
 * Why not a library: a client-reachable icon package is bundle weight the admin never
 * needs and an import-graph risk the security suite scans for. These are hand-drawn on a
 * 20×20 grid, 1.5px stroke, round caps, `currentColor` — so they take the ink of
 * whatever text they sit beside and can never carry a colour of their own.
 *
 * Accessibility contract:
 *   - decorative (the default): `aria-hidden`, no role — the adjacent text is the label.
 *   - standalone (`label` given): `role="img"` with a DESCRIPTIVE aria-label. The test
 *     suite requires every role="img" label to be longer than 10 characters, so labels
 *     here are sentences ("Open the navigation menu"), not nouns ("menu").
 *
 * This file must remain import-free (React types only): it is used by client components,
 * and anything they transitively value-import is scanned by the security suite.
 */
import type { SVGProps } from 'react';

export type IconName = keyof typeof PATHS;

/** 20×20, stroke-drawn. Each entry is the path data (and only paths — no fills). */
const PATHS = {
  dashboard: 'M3.5 11.5 10 5l6.5 6.5M5.5 9.8V16h9V9.8',
  property: 'M3.5 16.5h13M5 16.5V8l5-4 5 4v8.5M8.5 16.5v-4h3v4',
  reservation: 'M4.5 5.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM7 3.5v3M13 3.5v3M3.5 9.5h13',
  today: 'M10 5.5V10l3 2M10 16.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z',
  housekeeping: 'M6 16.5 8.5 8l6-4.5 1.5 2L11.5 11l-2 5.5h-3.5ZM12.5 5.5l2 2.5',
  maintenance: 'M11.5 6.5a3 3 0 0 1 4-2.8l-2 2 .8 2 2 .8 2-2a3 3 0 0 1-4.6 3.4L7 16.5a1.4 1.4 0 0 1-2-2l6.5-6.6Z',
  inventory: 'M4 6.5 10 3.5l6 3v7l-6 3-6-3v-7ZM10 9.5l6-3M10 9.5 4 6.5M10 9.5v7',
  guest: 'M10 9.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM4.5 16.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
  revenue: 'M6 4h8M6 7h8M7 4c4 0 5.5 1.5 5.5 3S11 10 9 10H7l5.5 6',
  expense: 'M4.5 15.5v-11h8l3 3v8h-11ZM12 4.5v3.5h3.5M7 10.5h6M7 13h6',
  cashflow: 'M4 7.5h9.5l-2-2M16 12.5H6.5l2 2',
  pnl: 'M4.5 4.5v11h11M7.5 12.5v-3M10.5 12.5v-6M13.5 12.5V8',
  investor: 'M7.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 15.5c.5-2.6 2-4 4-4s3.5 1.4 4 4M13 8.7a2.3 2.3 0 1 0-1.6-4M13.6 11.6c1.8.3 2.7 1.6 3 3.9',
  distribution: 'M10 3.5v8M6.5 8.5 10 12l3.5-3.5M4.5 15.5h11',
  report: 'M5.5 3.5h7l3 3v10h-10v-13ZM12 3.5V7h3.5M8 10.5h5M8 13h5',
  performance: 'M4 14.5l4-4 2.5 2.5 5-5.5M12 7.5h3.5V11',
  forecast: 'M4 15.5c2-.5 3-4 5-4s2.5 2 4 2 2.5-3.5 3-6M4 4.5v11h12',
  copilot: 'M10 3.5c-3.6 0-6.5 2.5-6.5 5.6 0 1.8 1 3.4 2.5 4.4v3l2.8-1.5c.4.1.8.1 1.2.1 3.6 0 6.5-2.5 6.5-5.6S13.6 3.5 10 3.5ZM7.5 9h.01M10 9h.01M12.5 9h.01',
  compliance: 'M10 3.5 5 5.5v4c0 3.5 2 6 5 7 3-1 5-3.5 5-7v-4l-5-2ZM7.8 10l1.6 1.6 2.8-3',
  settings: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 3.5v2M10 14.5v2M16.5 10h-2M5.5 10h-2M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4M14.6 14.6l-1.4-1.4M6.8 6.8 5.4 5.4',
  audit: 'M8.5 13a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM11.8 11.8l4.7 4.7',
  bell: 'M10 4a4 4 0 0 1 4 4c0 3 .8 4 1.5 4.7H4.5C5.2 12 6 11 6 8a4 4 0 0 1 4-4ZM8.5 15.5a1.6 1.6 0 0 0 3 0',
  menu: 'M4 6h12M4 10h12M4 14h12',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  chevronDown: 'M6 8.5l4 4 4-4',
  chevronRight: 'M8.5 6l4 4-4 4',
  arrowRight: 'M4 10h12M11.5 5.5 16 10l-4.5 4.5',
  check: 'M4.5 10.5 8.5 14 15.5 6.5',
  warning: 'M10 4 3.5 15.5h13L10 4ZM10 8.5v3.5M10 14.2h.01',
  info: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM10 9.5V13.5M10 6.8h.01',
  external: 'M8.5 5.5H5A1.5 1.5 0 0 0 3.5 7v8A1.5 1.5 0 0 0 5 16.5h8a1.5 1.5 0 0 0 1.5-1.5v-3.5M11.5 3.5h5v5M9 11l7.5-7.5',
  filter: 'M4 5.5h12L11.5 11v4l-3 1.5V11L4 5.5Z',
  calendar: 'M4.5 5.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM7 3.5v3M13 3.5v3M3.5 9.5h13M7 12.5h.01M10 12.5h.01M13 12.5h.01',
  signout: 'M8 16.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5h3M13 13.5 16.5 10 13 6.5M16.5 10H8',
} as const;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  /** px. Icons default to 16 in text, 20 in nav/buttons. */
  size?: number;
  /**
   * Standalone label. When given, the icon speaks for itself (`role="img"`).
   * Must be descriptive — a short sentence, not a word.
   */
  label?: string;
}

export function Icon({ name, size = 16, label, ...rest }: IconProps) {
  const a11y = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...a11y}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Nav sections use a fixed icon per label so the mapping lives in exactly one place. */
export const NAV_ICONS: Readonly<Record<string, IconName>> = {
  Dashboard: 'dashboard',
  Portfolio: 'pnl',
  Properties: 'property',
  Reservations: 'reservation',
  Availability: 'calendar',
  'Find a unit': 'audit',
  'Booking Ledger': 'reservation',
  Today: 'today',
  Bookings: 'reservation',
  Housekeeping: 'housekeeping',
  Maintenance: 'maintenance',
  Inventory: 'inventory',
  'Guest Requests': 'guest',
  Revenue: 'revenue',
  // The payables/receivables ledger. It borrows the cash-flow glyph because both are
  // about money moving rather than money earned — and a new glyph for a new screen is
  // how an icon set stops meaning anything.
  Ledger: 'cashflow',
  Expenses: 'expense',
  CAPEX: 'inventory',
  'Cash Flow': 'cashflow',
  'P&L': 'pnl',
  Investors: 'investor',
  Distributions: 'distribution',
  Reports: 'report',
  Performance: 'performance',
  Forecast: 'forecast',
  'MAKAM Copilot': 'copilot',
  Compliance: 'compliance',
  Settings: 'settings',
  Audit: 'audit',
  'Demo controls': 'settings',
  'Guest journey': 'guest',
};
