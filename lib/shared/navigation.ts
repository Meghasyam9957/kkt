/**
 * NAVIGATION MODEL.
 *
 * Each item declares the capability it needs. Navigation is filtered by that capability,
 * which keeps the menu honest — but it is presentation only. The API guard
 * (`lib/server/auth/guard.ts`) is the actual control and refuses the request regardless
 * of what the menu shows.
 */
import type { Capability } from '@/lib/shared/roles';

export interface NavItem {
  label: string;
  href: string;
  capability: Capability;
  /** Marks a screen that is intentionally a shell in this phase. */
  badge?: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
  /**
   * Sections that exist only in the demonstration environment. Filtered out entirely in
   * production — not hidden by a capability, absent from the menu.
   */
  demoOnly?: boolean;
}

export const NAVIGATION: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { label: 'Dashboard', href: '/admin/dashboard', capability: 'dashboard.financial.view' },
      // The investor's own screen. It carries a different capability from every management
      // entry, so it appears for investors and for nobody else.
      { label: 'Portfolio', href: '/admin/portfolio', capability: 'investor.self.read' },
    ],
  },
  {
    title: 'Property',
    items: [
      { label: 'Properties', href: '/admin/properties', capability: 'properties.read' },
      { label: 'Reservations', href: '/admin/reservations', capability: 'reservations.read' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Today', href: '/admin/operations/today', capability: 'operations.view' },
      // Real routes since Phase C — no more aliases, so exactly one item is ever active.
      // "Bookings" is the WORKING reservations register (create, check in, check out,
      // cancel); Property ▸ Reservations remains the read-only financial register.
      { label: 'Bookings', href: '/admin/operations/reservations', capability: 'reservations.read' },
      { label: 'Check-ins', href: '/admin/operations/checkins', capability: 'operations.view' },
      { label: 'Check-outs', href: '/admin/operations/checkouts', capability: 'operations.view' },
      { label: 'Housekeeping', href: '/admin/operations/housekeeping', capability: 'housekeeping.read' },
      { label: 'Maintenance', href: '/admin/operations/maintenance', capability: 'maintenance.read' },
      { label: 'Inventory', href: '/admin/operations/inventory', capability: 'inventory.read' },
      { label: 'Guest Requests', href: '/admin/operations/requests', capability: 'operations.view' },
    ],
  },
  {
    title: 'Finance',
    items: [
      { label: 'Revenue', href: '/admin/finance/revenue', capability: 'revenue.read' },
      { label: 'Expenses', href: '/admin/finance/expenses', capability: 'expenses.read' },
      { label: 'CAPEX', href: '/admin/finance/capex', capability: 'capex.read' },
      { label: 'Cash Flow', href: '/admin/finance/cashflow', capability: 'cashflow.read' },
      { label: 'P&L', href: '/admin/finance/pnl', capability: 'pnl.read' },
    ],
  },
  {
    title: 'Investors',
    items: [
      { label: 'Investors', href: '/admin/investors', capability: 'investors.read.all' },
      { label: 'Distributions', href: '/admin/investors/distributions', capability: 'investors.read.all' },
      { label: 'Reports', href: '/admin/investors/reports', capability: 'reports.read' },
    ],
  },
  {
    title: 'Analytics',
    items: [
      { label: 'Performance', href: '/admin/analytics/performance', capability: 'analytics.read' },
      // Roadmap language ("Phase 8") does not belong in a client-facing menu; the
      // Forecast screen itself says honestly that forecasting is not yet available.
      { label: 'Forecast', href: '/admin/analytics', capability: 'analytics.read' },
    ],
  },
  {
    title: 'AI',
    items: [
      { label: 'Srivillu Copilot', href: '/admin/ai', capability: 'ai.copilot' },
    ],
  },
  {
    title: 'Demonstration',
    demoOnly: true,
    items: [
      { label: 'Demo controls', href: '/admin/demo', capability: 'demo.control' },
      { label: 'Guest journey', href: '/admin/demo/guest-journey', capability: 'demo.control' },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Compliance', href: '/admin/settings', capability: 'compliance.read' },
      { label: 'Settings', href: '/admin/settings', capability: 'settings.read' },
      { label: 'Audit', href: '/admin/settings', capability: 'audit.read' },
    ],
  },
];

/**
 * Sections containing at least one item the role may see.
 *
 * Demonstration sections are removed unless the server says this is a demo deployment.
 * That is an environment decision, not a permission one: in production those screens do
 * not exist, so there is nothing to grant access to.
 */
export function visibleNavigation(
  hasCapability: (capability: Capability) => boolean,
  options: { demoControls?: boolean } = {},
): NavSection[] {
  return NAVIGATION
    .filter((section) => !section.demoOnly || options.demoControls === true)
    .map((section) => ({ ...section, items: section.items.filter((i) => hasCapability(i.capability)) }))
    .filter((section) => section.items.length > 0);
}

/**
 * Breadcrumb trail from a pathname, e.g. /admin/finance/pnl → Admin › Finance › P&L.
 *
 * A nav label is used only when exactly ONE item claims that href. Several items alias
 * `/admin/operations` (Housekeeping, Maintenance, Inventory), and picking the first made
 * the trail on Today read "Admin › Housekeeping › Today" — a label chosen by array
 * order, not by where the user actually is. Ambiguous hrefs fall back to the path word.
 */
export function breadcrumbFor(pathname: string): Array<{ label: string; href: string }> {
  const segments = pathname.split('/').filter(Boolean);
  const trail: Array<{ label: string; href: string }> = [];
  let href = '';
  for (const segment of segments) {
    href += `/${segment}`;
    const claimants = NAVIGATION.flatMap((s) => s.items).filter((i) => i.href === href);
    const label = claimants.length === 1 ? claimants[0]!.label : titleCase(segment);
    trail.push({ label, href });
  }
  return trail;
}

function titleCase(segment: string): string {
  if (segment === 'pnl') return 'P&L';
  if (segment === 'ai') return 'AI';
  return segment.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
