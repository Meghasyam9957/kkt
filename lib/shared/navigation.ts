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
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Today', href: '/admin/operations/today', capability: 'operations.view' },
      // THE booking screen: search it, open a booking, run its lifecycle. Finance ▸
      // Booking Ledger is the financial view of the same rows, and the only other
      // place a booking is rendered anywhere in the product.
      { label: 'Bookings', href: '/admin/operations/reservations', capability: 'reservations.read' },
      // The same booking data seen as a grid, so it carries the same capability. There is
      // exactly one calendar in the product and this is its only menu entry.
      { label: 'Availability', href: '/admin/operations/calendar', capability: 'reservations.read' },
      // The same availability question asked the other way round — "I need a unit for
      // these dates" — over the same bookings, so it carries the same capability.
      { label: 'Find a unit', href: '/admin/operations/availability', capability: 'reservations.read' },
      /*
       * "Check-ins" and "Check-outs" are gone as menu entries, not as routes. They were
       * half of Today each, rendered by a second component over the same payload; both
       * paths now redirect to Today, and three menu labels pointing at one screen is the
       * aliasing this menu was cleaned of in Phase C.
       */
      { label: 'Housekeeping', href: '/admin/operations/housekeeping', capability: 'housekeeping.read' },
      { label: 'Maintenance', href: '/admin/operations/maintenance', capability: 'maintenance.read' },
      { label: 'Inventory', href: '/admin/operations/inventory', capability: 'inventory.read' },
      { label: 'Guest Requests', href: '/admin/operations/requests', capability: 'operations.view' },
      /*
       * Where the workbook's name and the assignment record disagree. Carries
       * `operations.staff.read` rather than `operations.view`: it names people, and the
       * narrower capability is the one that exists for exactly that.
       */
      { label: 'Reconciliation', href: '/admin/operations/reconciliation', capability: 'operations.staff.read' },
    ],
  },
  {
    title: 'People',
    items: [
      /*
       * The workforce register (M-HR-1). It carries `hr.read`, which covers people,
       * attendance, leave and shifts but NOT compensation — salary and payroll are a
       * strictly smaller audience, and the page assembles their figures only for a caller
       * who holds `hr.compensation.read`.
       */
      { label: 'People', href: '/admin/hr', capability: 'hr.read' },
    ],
  },
  {
    title: 'Finance',
    items: [
      { label: 'Revenue', href: '/admin/finance/revenue', capability: 'revenue.read' },
      /*
       * The relational finance ledger (M-DATA-1): payables, receivables and the vendor
       * master, which live in Postgres rather than the workbook because a spreadsheet has
       * rows but no relationships, no lifecycle and no running balance.
       *
       * It carries `finance.read`, not `revenue.read`. The two answer different questions
       * — what was earned, versus what is owed — and giving the ledger the revenue
       * capability would have quietly widened who sees the supplier list.
       */
      { label: 'Ledger', href: '/admin/finance/ledger', capability: 'finance.read' },
      /*
       * The financial VIEW of the bookings under Operations ▸ Bookings — gross value,
       * expected payout, payout status — so it sits with the money screens under a
       * ledger name, and its menu visibility follows a financial capability.
       *
       * The page keeps `reservations.read`, because the rows are the same rows, and
       * sends a role with no financial capability to the workspace before reading a
       * booking for them. It used to render them the operational projection instead,
       * which made this route a second copy of the workspace under a second name.
       */
      { label: 'Booking Ledger', href: '/admin/reservations', capability: 'revenue.read' },
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
      // Points at the real screen since Phase 8. `/admin/analytics` remains a redirect to
      // Performance, so an old link still lands somewhere sensible.
      { label: 'Forecast', href: '/admin/analytics/forecast', capability: 'analytics.read' },
    ],
  },
  {
    title: 'AI',
    items: [
      { label: 'MAKAM Copilot', href: '/admin/ai', capability: 'ai.copilot' },
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
      /*
       * ONE entry, because one screen exists. "Compliance" and "Audit" used to sit here
       * as aliases of the same route — three labels lighting up for one page is a menu
       * telling a story the application cannot back. Dedicated compliance and audit
       * screens are future milestones; until they exist they are not links.
       */
      { label: 'Settings', href: '/admin/settings', capability: 'settings.read' },
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
