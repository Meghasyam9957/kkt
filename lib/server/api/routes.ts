import '@/lib/server/only';
/**
 * API ROUTE REGISTRY — every endpoint and the capability it requires, in one table.
 *
 * Phase 3 declared the read side; Phase B2 adds the mutation routes. The registry is
 * deliberately data rather than code so the RBAC suite can enumerate it and test *every*
 * route against *every* role — including routes added later, which are covered the
 * moment they appear here. Write governance (also test-enforced): every non-GET route
 * carries `mutates: true` and a `.write` capability, none is investor-scoped, and no
 * DELETE exists — removal is a status transition, decided by a person.
 *
 * Handlers are thin: they resolve data through the repositories and the KPI engine. No
 * business calculation is ever performed in a handler, and none is duplicated in the UI.
 */
import type { Capability } from '@/lib/server/auth/roles';

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  capability: Capability;
  /** Applies investor row-level scoping and refuses client-supplied investor identity. */
  investorScoped?: boolean;
  action: string;
  entityType?: string;
  /** True on every mutation route. The write-governance tests key on this flag. */
  mutates?: boolean;
  summary: string;
}

export const API_ROUTES: readonly RouteDefinition[] = [
  /* ---------------- Admin — analytics & financial ---------------- */
  { method: 'GET', path: '/api/analytics/dashboard', capability: 'dashboard.financial.view',
    action: 'analytics.dashboard.read', summary: 'KPI set, property performance, ops counters' },
  { method: 'GET', path: '/api/analytics/timeseries', capability: 'analytics.read',
    action: 'analytics.timeseries.read', summary: '12-month FY trend from the 99_CALC monthly block' },
  { method: 'GET', path: '/api/analytics/by-property', capability: 'analytics.read',
    action: 'analytics.byProperty.read', summary: 'Per-property performance for a period' },
  { method: 'GET', path: '/api/analytics/by-platform', capability: 'analytics.read',
    action: 'analytics.byPlatform.read', summary: 'OTA mix for a period' },
  { method: 'GET', path: '/api/analytics/parity', capability: 'audit.read',
    action: 'analytics.parity.read', summary: 'Server-vs-workbook reconciliation report' },
  /*
   * §7 lists this as ADMIN + OPS, and `operations.view` is exactly that set — the same
   * capability that guards the board these alerts are computed from.
   *
   * §7 also notes the source as "the V1 alerts stack, filtered by role". Neither half of
   * THAT note survives contact with the architecture. The V1 stack lives in 99_CALC (E121:G180,
   * read by AnalyticsRepository.readAlerts, which has no callers), and the read
   * provider is forbidden to touch that class — Decision D1, enforced by
   * tests/live-provider.test.ts, because those blocks key off the shared reporting
   * cell. This application computes its alerts server-side instead, per §1.1's fifth
   * principle. And there is nothing to filter by role: UrgentItem carries no amount,
   * rate or margin by design, so every role the guard admits may see all of it.
   */
  { method: 'GET', path: '/api/analytics/alerts', capability: 'operations.view',
    action: 'analytics.alerts.read', summary: 'Operational alerts, most pressing first' },

  /* ---------------- Admin — forecasting (ARCHITECTURE §7 / §9) ----------------
   * Deterministic estimates, never a model. Each path returns the §9 estimate whole:
   * its ESTIMATE label, method, inputs, month count and confidence travel with the
   * number — or with the explicit absence of one below the 2-month threshold.
   * Cash flow carries `cashflow.read` rather than `analytics.read`: it is a cash figure,
   * and the capability that guards the cash ledger is the one that should guard a
   * projection of it. Today the two are held by the same roles, which is precisely why
   * it costs nothing to be exact now.                                                */
  { method: 'GET', path: '/api/forecast/occupancy', capability: 'analytics.read',
    action: 'forecast.occupancy.read', summary: 'Occupancy estimate for the month ahead (booking-on-hand + residual pickup)' },
  { method: 'GET', path: '/api/forecast/revenue', capability: 'analytics.read',
    action: 'forecast.revenue.read', summary: 'Revenue estimate for the month ahead (forecast nights × trailing ADR)' },
  { method: 'GET', path: '/api/forecast/cashflow', capability: 'cashflow.read',
    action: 'forecast.cashflow.read', summary: 'Projected closing cash balance for the month ahead' },

  { method: 'GET', path: '/api/revenue',  capability: 'revenue.read',  action: 'revenue.read',  entityType: 'REVENUE',  summary: 'Revenue ledger' },
  { method: 'GET', path: '/api/expenses', capability: 'expenses.read', action: 'expenses.read', entityType: 'EXPENSE',  summary: 'Operating expenses' },
  { method: 'GET', path: '/api/capex',    capability: 'capex.read',    action: 'capex.read',    entityType: 'CAPEX',    summary: 'CAPEX / setup spend' },
  { method: 'GET', path: '/api/rent',     capability: 'rent.read',     action: 'rent.read',     entityType: 'RENT',     summary: 'Rent & fixed costs' },
  { method: 'GET', path: '/api/cashflow', capability: 'cashflow.read', action: 'cashflow.read', entityType: 'CASHFLOW', summary: 'Cash movements' },
  { method: 'GET', path: '/api/pnl',      capability: 'pnl.read',      action: 'pnl.read',      summary: 'Monthly P&L' },

  /* ---------------- Admin — investor management ---------------- */
  { method: 'GET', path: '/api/investors', capability: 'investors.read.all',
    action: 'investors.readAll', entityType: 'INVESTOR', summary: 'All investors — management only' },
  { method: 'GET', path: '/api/investors/:id', capability: 'investors.read.all',
    action: 'investors.readOne', entityType: 'INVESTOR', summary: 'One investor — management only' },

  /* ---------------- Operations ---------------- */
  { method: 'GET', path: '/api/operations/today', capability: 'operations.view',
    action: 'operations.today.read', summary: 'Arrivals, departures, tasks, alerts for today' },
  { method: 'GET', path: '/api/reservations', capability: 'reservations.read',
    action: 'reservations.read', entityType: 'RESERVATION', summary: 'Reservations' },
  { method: 'GET', path: '/api/reservations/:id', capability: 'reservations.read',
    action: 'reservations.readOne', entityType: 'RESERVATION', summary: 'One reservation' },
  { method: 'GET', path: '/api/housekeeping', capability: 'housekeeping.read',
    action: 'housekeeping.read', entityType: 'HOUSEKEEPING', summary: 'Housekeeping tasks' },
  { method: 'GET', path: '/api/maintenance', capability: 'maintenance.read',
    action: 'maintenance.read', entityType: 'MAINTENANCE', summary: 'Maintenance tickets' },
  { method: 'GET', path: '/api/inventory', capability: 'inventory.read',
    action: 'inventory.read', entityType: 'INVENTORY', summary: 'Stock levels' },
  { method: 'GET', path: '/api/compliance', capability: 'compliance.read',
    action: 'compliance.read', entityType: 'COMPLIANCE', summary: 'Compliance tracker' },
  { method: 'GET', path: '/api/properties', capability: 'properties.read',
    action: 'properties.read', entityType: 'PROPERTY', summary: 'Property master' },

  /* ---------------- Investor portal (server-scoped) ----------------
   * No route accepts an investor identifier in any form. The scope comes from the
   * session, so there is nothing for a caller to tamper with.                        */
  { method: 'GET', path: '/api/investor/overview', capability: 'investor.self.read',
    investorScoped: true, action: 'investor.overview.read', entityType: 'INVESTOR',
    summary: 'Own capital, participation %, approved portfolio KPIs' },
  { method: 'GET', path: '/api/investor/performance', capability: 'investor.self.read',
    investorScoped: true, action: 'investor.performance.read',
    summary: 'Approved revenue / profit / occupancy trends' },
  { method: 'GET', path: '/api/investor/distributions', capability: 'investor.self.read',
    investorScoped: true, action: 'investor.distributions.read', entityType: 'DISTRIBUTION',
    summary: 'Own calculated / paid / pending distributions' },
  { method: 'GET', path: '/api/investor/reports', capability: 'investor.self.read',
    investorScoped: true, action: 'investor.reports.read',
    summary: 'Approved reports available to this investor' },

  /* ---------------- Administration ---------------- */
  { method: 'GET', path: '/api/settings', capability: 'settings.read',
    action: 'settings.read', summary: 'Business rules (read-only; the workbook owns them)' },
  { method: 'GET', path: '/api/audit', capability: 'audit.read',
    action: 'audit.read', summary: 'Audit trail — SUPER_ADMIN only' },
  { method: 'GET', path: '/api/users', capability: 'users.manage',
    action: 'users.read', entityType: 'USER', summary: 'Application accounts — SUPER_ADMIN only' },

  /* ---------------- Operations state (Phase B2) ----------------
   * Read-side companion to the mutation pipeline: a client that received 409
   * OPERATION_IN_FLIGHT polls here. Every signed-in role may poll its OWN operations;
   * the handler scopes by actor, and the guard still authenticates and audits.       */
  { method: 'GET', path: '/api/operations-log/:id', capability: 'operations.view',
    action: 'operation.status.read', summary: 'Status of one mutation operation (own operations only)' },

  /* ================================================================ *
   * MUTATIONS (Phase B2). Rules, enforced by the write-governance tests:
   *   - every non-GET route declares `mutates: true` and a `.write` capability;
   *   - none is investor-scoped, and INVESTOR holds no write capability;
   *   - there is NO DELETE anywhere — removal is a status transition;
   *   - every handler runs the MutationPipeline; there is no other write path.
   * ================================================================ */

  /* ---- Reservations (ADMIN + OPERATIONS) ---- */
  { method: 'POST', path: '/api/reservations', capability: 'reservations.write', mutates: true,
    action: 'reservation.create', entityType: 'RESERVATION', summary: 'Create a booking in 04_RESERVATIONS' },
  { method: 'PATCH', path: '/api/reservations/:id', capability: 'reservations.write', mutates: true,
    action: 'reservation.update', entityType: 'RESERVATION', summary: 'Amend input fields of a booking' },
  { method: 'POST', path: '/api/reservations/:id/check-in', capability: 'reservations.write', mutates: true,
    action: 'reservation.checkIn', entityType: 'RESERVATION', summary: 'Status → Checked In' },
  { method: 'POST', path: '/api/reservations/:id/check-out', capability: 'reservations.write', mutates: true,
    action: 'reservation.checkOut', entityType: 'RESERVATION', summary: 'Status → Checked Out' },
  { method: 'POST', path: '/api/reservations/:id/cancel', capability: 'reservations.write', mutates: true,
    action: 'reservation.cancel', entityType: 'RESERVATION', summary: 'Status → Cancelled (no deletion)' },

  /* ---- Finance (ADMIN only — OPERATIONS holds no financial writer) ---- */
  { method: 'POST', path: '/api/revenue', capability: 'revenue.write', mutates: true,
    action: 'revenue.create', entityType: 'REVENUE', summary: 'Record a revenue row in 05_REVENUE' },
  { method: 'PATCH', path: '/api/revenue/:id', capability: 'revenue.write', mutates: true,
    action: 'revenue.update', entityType: 'REVENUE', summary: 'Amend revenue input fields' },
  { method: 'POST', path: '/api/expenses', capability: 'expenses.write', mutates: true,
    action: 'expense.create', entityType: 'EXPENSE', summary: 'Record an expense in 06_EXPENSES' },
  { method: 'PATCH', path: '/api/expenses/:id', capability: 'expenses.write', mutates: true,
    action: 'expense.update', entityType: 'EXPENSE', summary: 'Amend expense input fields' },
  { method: 'POST', path: '/api/capex', capability: 'capex.write', mutates: true,
    action: 'capex.create', entityType: 'CAPEX', summary: 'Record a CAPEX item in 07_CAPEX_SETUP' },
  { method: 'PATCH', path: '/api/capex/:id', capability: 'capex.write', mutates: true,
    action: 'capex.update', entityType: 'CAPEX', summary: 'Amend CAPEX input fields' },
  { method: 'PATCH', path: '/api/rent/:id', capability: 'rent.write', mutates: true,
    action: 'rent.update', entityType: 'RENT', summary: 'Record rent payment fields in 08_RENT_FIXED_COSTS' },
  { method: 'POST', path: '/api/cashflow', capability: 'cashflow.write', mutates: true,
    action: 'cashflow.create', entityType: 'CASHFLOW', summary: 'Record a cash movement in 09_CASH_FLOW' },
  { method: 'PATCH', path: '/api/cashflow/:id', capability: 'cashflow.write', mutates: true,
    action: 'cashflow.update', entityType: 'CASHFLOW', summary: 'Reconcile / amend a cash movement' },

  /* ---- Operations board (ADMIN + OPERATIONS) ---- */
  { method: 'POST', path: '/api/housekeeping', capability: 'housekeeping.write', mutates: true,
    action: 'housekeeping.create', entityType: 'HOUSEKEEPING', summary: 'Create a task in 13_HOUSEKEEPING' },
  { method: 'PATCH', path: '/api/housekeeping/:id', capability: 'housekeeping.write', mutates: true,
    action: 'housekeeping.update', entityType: 'HOUSEKEEPING', summary: 'Assign / complete / inspect a task' },
  { method: 'POST', path: '/api/maintenance', capability: 'maintenance.write', mutates: true,
    action: 'maintenance.create', entityType: 'MAINTENANCE', summary: 'Create a ticket in 14_MAINTENANCE' },
  { method: 'PATCH', path: '/api/maintenance/:id', capability: 'maintenance.write', mutates: true,
    action: 'maintenance.update', entityType: 'MAINTENANCE', summary: 'Progress / resolve / close a ticket' },
  { method: 'PATCH', path: '/api/inventory/:id', capability: 'inventory.write', mutates: true,
    action: 'inventory.update', entityType: 'INVENTORY', summary: 'Record stock movement fields in 15_INVENTORY' },

  /* ---- Management registers (ADMIN only) ---- */
  { method: 'POST', path: '/api/investors', capability: 'investors.write', mutates: true,
    action: 'investor.create', entityType: 'INVESTOR', summary: 'Add an investor to 11_INVESTORS' },
  { method: 'PATCH', path: '/api/investors/:id', capability: 'investors.write', mutates: true,
    action: 'investor.update', entityType: 'INVESTOR', summary: 'Amend investor input fields' },
  { method: 'PATCH', path: '/api/distributions/:id', capability: 'distributions.write', mutates: true,
    action: 'distribution.update', entityType: 'DISTRIBUTION',
    summary: 'Record paid amount/date/status inputs in 12_INVESTOR_DISTRIBUTIONS' },
  { method: 'POST', path: '/api/properties', capability: 'properties.write', mutates: true,
    action: 'property.create', entityType: 'PROPERTY', summary: 'Add a unit to 03_PROPERTIES (explicit PropertyID)' },
  { method: 'PATCH', path: '/api/properties/:id', capability: 'properties.write', mutates: true,
    action: 'property.update', entityType: 'PROPERTY', summary: 'Amend property master input fields' },
] as const;

/** Routes exposing investor-facing data, used by the isolation suite. */
export const INVESTOR_ROUTES = API_ROUTES.filter((r) => r.investorScoped);

/** Routes an INVESTOR must never reach, used by the RBAC suite. */
export const NON_INVESTOR_ROUTES = API_ROUTES.filter((r) => !r.investorScoped);

export function findRoute(method: string, path: string): RouteDefinition | undefined {
  return API_ROUTES.find((route) => {
    if (route.method !== method.toUpperCase()) return false;
    if (!route.path.includes(':')) return route.path === path;
    const pattern = new RegExp('^' + route.path.replace(/:[^/]+/g, '[^/]+') + '$');
    return pattern.test(path);
  });
}
