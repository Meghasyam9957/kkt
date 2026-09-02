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
import { FINANCIAL_CAPABILITIES, type Capability } from '@/lib/server/auth/roles';
import type { TenantContext } from '@/lib/server/tenant/context';
import type { DashboardDataProvider } from '@/lib/data/providers/types';

/**
 * How a read handler obtains its data source.
 *
 * A FUNCTION OF THE TENANT, not a thunk. A handler has an authenticated context and must
 * say whose data it is asking for; there is no ambient answer, so a handler that forgot
 * would not compile.
 */
/*
 * ASYNC since M-SAAS-1. The provider is no longer chosen from the environment; it is
 * looked up from the tenant workbook registry, which is durable control-plane state. A
 * handler therefore awaits its data source, and cannot obtain one without naming whose.
 */
export type TenantProviderFactory = (tenant: TenantContext) => Promise<DashboardDataProvider>;

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
  /**
   * True on a non-GET route that changes NO business data.
   *
   * The write-governance rule was written as "every non-GET route is a mutation", which
   * held while every non-GET route was one. Two of the three suites enforcing it already
   * name the real invariant in their own titles — "every WRITE PATH is declared, flagged
   * and capability-gated" — and infer it from the HTTP verb because nothing yet needed
   * the distinction. §7's `POST /api/ai/copilot` does: asking a question allocates no id,
   * writes no sheet, has no entity and is not idempotent, so declaring it a mutation
   * would put a false statement in the registry and hand it a `.write` capability it must
   * never hold.
   *
   * So the classification is explicit rather than inferred, and every non-GET route now
   * declares exactly one of the two — which is a stricter rule than the one it replaces,
   * because a POST declaring neither is now a failure rather than an omission nobody
   * notices. What a non-mutating route must additionally satisfy is asserted in the
   * governance suites, including that the set of them is exactly the one route below.
   */
  nonMutating?: true;
  /**
   * True on a non-GET route that writes the RELATIONAL FINANCE domain (M-DATA-1).
   *
   * A third classification rather than a reuse of either existing one, because neither is
   * true of it. `mutates` means "runs the workbook mutation pipeline" — the governance
   * suite cross-checks every `mutates` route against `MUTATION_DEFINITIONS`, and a finance
   * route has no sheet, no ID_RULES entry and no calc columns to protect. `nonMutating`
   * means "changes no business data", and a payment plainly does.
   *
   * What a finance-writing route must satisfy instead is asserted in
   * `assertWriteGovernance` below, and it is not a weaker bar: a finance capability rather
   * than any `.write`, a `/api/finance/` path, never investor-scoped, and a handler that
   * runs the finance operation pipeline — idempotency through the same tenant-aware
   * operation store the workbook writes use, then audit. The one rule it genuinely cannot
   * inherit is the contract check, because there is no V1 column to check against.
   */
  writesFinance?: true;
  /**
   * True on a non-GET route that writes the PEOPLE domain (M-HR-1).
   *
   * A fourth classification for the same reason `writesFinance` was a third: `mutates`
   * means "runs the workbook mutation pipeline" and is cross-checked against
   * MUTATION_DEFINITIONS, and HR has no sheet; `nonMutating` means "changes no business
   * data", and an employee record plainly is some.
   *
   * It is kept separate from `writesFinance` rather than merged into a general
   * "writes Postgres" flag because the two demand different capability families, and one
   * flag would let an HR route satisfy the governance check with a finance capability.
   */
  writesHr?: true;
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

  /* ---------------- Admin — AI (ARCHITECTURE §7 / §8) ----------------
   * §7 lists this as "ADMIN (OPS: ops-scoped)". `ai.operations` is exactly that set —
   * SUPER_ADMIN, ADMIN and OPERATIONS — and the "ops-scoped" half needs no rule here:
   * the copilot context boundary grants each tool only to a caller holding the
   * capability that already guards the same data, and OPERATIONS holds no financial
   * capability, so its context is the alerts alone. The same resolution as
   * GET /api/analytics/alerts, for the same reason.
   *
   * `nonMutating` rather than `mutates`: see the field's definition above. The handler
   * calls the copilot service and does nothing else — no calculation, no provider
   * choice, no pricing, no budget, no filtering.
   */
  { method: 'POST', path: '/api/ai/copilot', capability: 'ai.operations', nonMutating: true,
    action: 'ai.copilot.ask', summary: 'Ask the management copilot a question' },

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

  /* ---------------- Finance (M-DATA-1) ----------------
   * The relational finance domain: vendors, payables, receivables and settlement, held
   * in Postgres because a spreadsheet has rows but no relationships, no lifecycle and no
   * enforceable state. It does NOT duplicate the workbook — revenue (05), expenses (06),
   * the cash journal (09) and the P&L (10) keep their authority there, and nothing below
   * recomputes any of them.
   *
   * Every write is POST, because finance history is append-only: a correction is a new
   * record that points at what it corrects, never an edit of the original. That is why
   * there is no PATCH here and no DELETE anywhere.
   *
   * Reads carry `finance.read`; writes `finance.write`; approving a payment somebody else
   * raised carries `finance.approve`; closing and reopening a month carries
   * `finance.period.manage`, which ADMIN does not hold.                                */
  { method: 'GET', path: '/api/finance/overview', capability: 'finance.read',
    action: 'finance.overview.read',
    summary: 'Obligations position and money settled through the finance ledger' },
  { method: 'GET', path: '/api/finance/vendors', capability: 'finance.read',
    action: 'finance.vendors.read', summary: 'Vendor master for this tenant' },
  { method: 'POST', path: '/api/finance/vendors', capability: 'finance.write',
    writesFinance: true, action: 'finance.vendor.create', entityType: 'FINANCE_VENDOR',
    summary: 'Register a vendor' },
  { method: 'GET', path: '/api/finance/payables', capability: 'finance.read',
    action: 'finance.payables.read', summary: 'Vendor bills with outstanding balances' },
  { method: 'POST', path: '/api/finance/payables', capability: 'finance.write',
    writesFinance: true, action: 'finance.bill.create', entityType: 'FINANCE_BILL',
    summary: 'Record a vendor bill' },
  { method: 'GET', path: '/api/finance/receivables', capability: 'finance.read',
    action: 'finance.receivables.read', summary: 'Amounts owed to this tenant, with balances' },
  { method: 'POST', path: '/api/finance/receivables', capability: 'finance.write',
    writesFinance: true, action: 'finance.receivable.create', entityType: 'FINANCE_RECEIVABLE',
    summary: 'Record an amount owed to the business' },
  { method: 'GET', path: '/api/finance/payments', capability: 'finance.read',
    action: 'finance.payments.read', summary: 'Settlement events' },
  { method: 'POST', path: '/api/finance/payments', capability: 'finance.write',
    writesFinance: true, action: 'finance.payment.create', entityType: 'FINANCE_PAYMENT',
    summary: 'Raise a payment, as a draft' },
  /* A draft is submitted for approval before it can be approved. Without this route
   * PENDING_APPROVAL would be unreachable and the state would be decorative — which is
   * exactly what the lifecycle test caught when it was missing.                        */
  { method: 'POST', path: '/api/finance/payments/:id/submit', capability: 'finance.write',
    writesFinance: true, action: 'finance.payment.submit', entityType: 'FINANCE_PAYMENT',
    summary: 'Submit a draft payment for approval' },
  /* Approval is a separate capability from raising, and the service additionally refuses
   * a payment approved by the person who raised it.                                    */
  { method: 'POST', path: '/api/finance/payments/:id/approve', capability: 'finance.approve',
    writesFinance: true, action: 'finance.payment.approve', entityType: 'FINANCE_PAYMENT',
    summary: 'Approve a payment raised by someone else' },
  { method: 'POST', path: '/api/finance/payments/:id/post', capability: 'finance.write',
    writesFinance: true, action: 'finance.payment.post', entityType: 'FINANCE_PAYMENT',
    summary: 'Post an approved payment — the point money is recorded as moved' },
  { method: 'POST', path: '/api/finance/payments/:id/void', capability: 'finance.write',
    writesFinance: true, action: 'finance.payment.void', entityType: 'FINANCE_PAYMENT',
    summary: 'Void a payment that never took effect' },
  { method: 'GET', path: '/api/finance/periods', capability: 'finance.read',
    action: 'finance.periods.read', summary: 'Accounting periods and their status' },
  { method: 'POST', path: '/api/finance/periods/close', capability: 'finance.period.manage',
    writesFinance: true, action: 'finance.period.close', entityType: 'FINANCE_PERIOD',
    summary: 'Close a month to further finance movement' },
  { method: 'POST', path: '/api/finance/periods/reopen', capability: 'finance.period.manage',
    writesFinance: true, action: 'finance.period.reopen', entityType: 'FINANCE_PERIOD',
    summary: 'Reopen a closed month, with a recorded reason' },

  /* ---------------- People (M-HR-1) ----------------
   * The workforce domain, in Postgres because none of it existed anywhere: no sheet, no
   * column, no type. Capabilities split along the line that matters in HR — PERSON versus
   * PAY. `hr.read` / `hr.manage` / `hr.approve` cover people, attendance, leave and
   * shifts; `hr.compensation.*` covers salary, advances and payroll; `hr.payroll.approve`
   * sits above both, because approving a run is what turns a calculation into money.
   *
   * Every write is a POST: people history is append-only, and a correction is a new record
   * rather than an edit of one payroll may already have consumed.                       */
  { method: 'GET', path: '/api/hr/overview', capability: 'hr.read',
    action: 'hr.overview.read', summary: 'Headcount, attendance and payroll status' },
  { method: 'GET', path: '/api/hr/employees', capability: 'hr.read',
    action: 'hr.employees.read', summary: 'The people this business employs' },
  { method: 'GET', path: '/api/hr/attendance', capability: 'hr.read',
    action: 'hr.attendance.read', summary: 'Attendance register for a period' },
  { method: 'GET', path: '/api/hr/leave', capability: 'hr.read',
    action: 'hr.leave.read', summary: 'Leave requests and their state' },
  { method: 'GET', path: '/api/hr/overtime', capability: 'hr.read',
    action: 'hr.overtime.read', summary: 'Approved and pending overtime' },
  { method: 'GET', path: '/api/hr/shifts', capability: 'hr.read',
    action: 'hr.shifts.read', summary: 'Shift definitions, including overnight ones' },

  { method: 'POST', path: '/api/hr/departments', capability: 'hr.manage', writesHr: true,
    action: 'hr.department.create', entityType: 'HR_DEPARTMENT', summary: 'Add a department' },
  { method: 'POST', path: '/api/hr/designations', capability: 'hr.manage', writesHr: true,
    action: 'hr.designation.create', entityType: 'HR_DESIGNATION', summary: 'Add a designation' },
  { method: 'POST', path: '/api/hr/shifts', capability: 'hr.manage', writesHr: true,
    action: 'hr.shift.create', entityType: 'HR_SHIFT', summary: 'Define a shift' },
  { method: 'POST', path: '/api/hr/leave-types', capability: 'hr.manage', writesHr: true,
    action: 'hr.leaveType.create', entityType: 'HR_LEAVE_TYPE', summary: 'Define a leave type' },
  { method: 'POST', path: '/api/hr/employees', capability: 'hr.manage', writesHr: true,
    action: 'hr.employee.create', entityType: 'HR_EMPLOYEE', summary: 'Add a person' },
  { method: 'POST', path: '/api/hr/employees/:id/status', capability: 'hr.manage', writesHr: true,
    action: 'hr.employee.status', entityType: 'HR_EMPLOYEE',
    summary: 'Change employment status — never a deletion' },
  { method: 'POST', path: '/api/hr/attendance', capability: 'hr.manage', writesHr: true,
    action: 'hr.attendance.record', entityType: 'HR_ATTENDANCE', summary: 'Record a day' },
  { method: 'POST', path: '/api/hr/attendance/:id/submit', capability: 'hr.manage', writesHr: true,
    action: 'hr.attendance.submit', entityType: 'HR_ATTENDANCE',
    summary: 'Submit a day for approval' },
  { method: 'POST', path: '/api/hr/attendance/:id/approve', capability: 'hr.approve', writesHr: true,
    action: 'hr.attendance.approve', entityType: 'HR_ATTENDANCE',
    summary: 'Approve a day — payroll consumes only approved attendance' },
  { method: 'POST', path: '/api/hr/leave', capability: 'hr.manage', writesHr: true,
    action: 'hr.leave.request', entityType: 'HR_LEAVE', summary: 'Raise a leave request' },
  { method: 'POST', path: '/api/hr/leave/:id/submit', capability: 'hr.manage', writesHr: true,
    action: 'hr.leave.submit', entityType: 'HR_LEAVE', summary: 'Submit leave for approval' },
  { method: 'POST', path: '/api/hr/leave/:id/approve', capability: 'hr.approve', writesHr: true,
    action: 'hr.leave.approve', entityType: 'HR_LEAVE', summary: 'Approve leave' },
  { method: 'POST', path: '/api/hr/leave/:id/reject', capability: 'hr.approve', writesHr: true,
    action: 'hr.leave.reject', entityType: 'HR_LEAVE', summary: 'Reject leave, with a reason' },
  { method: 'POST', path: '/api/hr/overtime', capability: 'hr.manage', writesHr: true,
    action: 'hr.overtime.record', entityType: 'HR_OVERTIME', summary: 'Record overtime worked' },
  { method: 'POST', path: '/api/hr/overtime/:id/submit', capability: 'hr.manage', writesHr: true,
    action: 'hr.overtime.submit', entityType: 'HR_OVERTIME',
    summary: 'Submit overtime for approval' },
  { method: 'POST', path: '/api/hr/overtime/:id/approve', capability: 'hr.approve', writesHr: true,
    action: 'hr.overtime.approve', entityType: 'HR_OVERTIME',
    summary: 'Approve overtime — payroll consumes only approved overtime' },

  /* ---- Compensation. A strictly smaller audience than the roster above. ---- */
  { method: 'GET', path: '/api/hr/salary', capability: 'hr.compensation.read',
    action: 'hr.salary.read', summary: 'Effective-dated salary history for one person' },
  { method: 'GET', path: '/api/hr/advances', capability: 'hr.compensation.read',
    action: 'hr.advances.read', summary: 'Employee advances and what is outstanding' },
  { method: 'GET', path: '/api/hr/payroll', capability: 'hr.compensation.read',
    action: 'hr.payroll.read', summary: 'Payroll runs and their status' },
  { method: 'GET', path: '/api/hr/payroll/:id', capability: 'hr.compensation.read',
    action: 'hr.payrollRun.read', summary: 'One run and its lines' },
  { method: 'POST', path: '/api/hr/salary', capability: 'hr.compensation.manage', writesHr: true,
    action: 'hr.salary.create', entityType: 'HR_SALARY',
    summary: 'Record a salary structure — a raise is a new row, never an overwrite' },
  { method: 'POST', path: '/api/hr/advances', capability: 'hr.compensation.manage', writesHr: true,
    action: 'hr.advance.create', entityType: 'HR_ADVANCE', summary: 'Issue an advance' },
  { method: 'POST', path: '/api/hr/advances/:id/submit', capability: 'hr.compensation.manage',
    writesHr: true, action: 'hr.advance.submit', entityType: 'HR_ADVANCE',
    summary: 'Submit an advance for approval' },
  { method: 'POST', path: '/api/hr/advances/:id/approve', capability: 'hr.approve', writesHr: true,
    action: 'hr.advance.approve', entityType: 'HR_ADVANCE', summary: 'Approve an advance' },
  { method: 'POST', path: '/api/hr/payroll', capability: 'hr.compensation.manage', writesHr: true,
    action: 'hr.payroll.open', entityType: 'HR_PAYROLL',
    summary: 'Open a payroll run for a month' },
  { method: 'POST', path: '/api/hr/payroll/:id/calculate', capability: 'hr.compensation.manage',
    writesHr: true, action: 'hr.payroll.calculate', entityType: 'HR_PAYROLL',
    summary: 'Calculate the run from approved attendance, leave and overtime' },
  { method: 'POST', path: '/api/hr/payroll/:id/approve', capability: 'hr.payroll.approve',
    writesHr: true, action: 'hr.payroll.approve', entityType: 'HR_PAYROLL',
    summary: 'Approve a calculated run — refused while attendance has gaps, unless acknowledged' },
  { method: 'POST', path: '/api/hr/payroll/:id/post', capability: 'hr.payroll.approve',
    writesHr: true, action: 'hr.payroll.post', entityType: 'HR_PAYROLL',
    summary: 'Post an approved run — this creates obligations, it does not pay them' },

  /* ---------------- Administration ---------------- */
  { method: 'GET', path: '/api/settings', capability: 'settings.read',
    action: 'settings.read', summary: 'Business rules (read-only; the workbook owns them)' },
  { method: 'GET', path: '/api/audit', capability: 'audit.read',
    /*
     * DECLARED, NOT IMPLEMENTED. No handler is registered, so this authenticates,
     * capability-checks, records the attempt and returns 501.
     *
     * The summary used to read "SUPER_ADMIN only", which was never true: `audit.read` is
     * held by ADMIN as well (lib/shared/roles.ts). That mattered, because ADMIN is the
     * exact role a per-tenant TENANT_ADMIN will be modelled on — so the registry was
     * documenting a narrower gate than it enforced, for the one route where the
     * difference is a cross-tenant read.
     *
     * When a handler is written it must read through `AuditReader.readForTenant`
     * (lib/server/audit/logger.ts), which cannot be called without a tenant.
     */
    action: 'audit.read', summary: 'Audit trail — SUPER_ADMIN and ADMIN (not implemented)' },
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

/**
 * Write governance, in one place so the three suites that enforce it cannot drift.
 *
 * The rule used to read "every non-GET route is a mutation". That was true while every
 * non-GET route was one, and it is what two of the three suites already call it in their
 * own titles — a WRITE path, flagged and capability-gated. §7's POST /api/ai/copilot is
 * a non-GET route that writes nothing, so the classification is now declared rather than
 * inferred from the verb, and every non-GET route must declare exactly ONE of the two.
 *
 * That is stricter than what it replaces: a POST declaring neither used to be impossible
 * to express and is now an explicit failure.
 */
export function assertWriteGovernance(
  routes: readonly RouteDefinition[],
  check: (condition: boolean, message: string) => void,
): void {
  const nonGet = routes.filter((r) => r.method !== 'GET');
  check(nonGet.length > 0, 'there must be non-GET routes to govern');

  for (const route of nonGet) {
    const where = `${route.method} ${route.path}`;
    const mutating = route.mutates === true;
    const exempt = route.nonMutating === true;
    const finance = route.writesFinance === true;
    const people = route.writesHr === true;

    const classifications = [mutating, exempt, finance, people].filter(Boolean).length;
    check(classifications === 1,
      `${where} must declare exactly one of mutates:true, writesFinance:true, writesHr:true `
      + 'or nonMutating:true');
    check(route.method !== 'DELETE',
      `${where}: no DELETE route may exist — removal is a status transition`);
    check((route.investorScoped ?? false) === false,
      `${where}: a non-GET route must never be investor-scoped`);

    if (mutating) {
      check(route.capability.endsWith('.write'),
        `${where} must demand a .write capability (has ${route.capability})`);
    } else if (people) {
      /*
       * The people class. The same bar as finance, with one difference that matters: an HR
       * route is NOT required to hold a capability listed in FINANCIAL_CAPABILITIES,
       * because attendance and shifts are operational facts rather than financial ones.
       * The compensation half of HR IS in that list, and the isolation suite asserts that
       * per capability rather than per route.
       */
      check(route.path.startsWith('/api/hr/'),
        `${where}: an HR-writing route lives under /api/hr/`);
      check(route.capability.startsWith('hr.'),
        `${where}: an HR-writing route demands an HR capability (has ${route.capability})`);
      check(route.method === 'POST',
        `${where}: an HR write is a POST — people history is append-only, and a correction `
        + 'is a new record rather than an edit of an old one');
    } else if (finance) {
      /*
       * The finance class. Every clause here is what stops it becoming the loophole the
       * non-mutating exemption was carefully written not to be.
       */
      check(route.path.startsWith('/api/finance/'),
        `${where}: a finance-writing route lives under /api/finance/`);
      check(route.capability.startsWith('finance.'),
        `${where}: a finance-writing route demands a finance capability (has ${route.capability})`);
      check(FINANCIAL_CAPABILITIES.includes(route.capability),
        `${where}: ${route.capability} must be listed in FINANCIAL_CAPABILITIES, so the `
        + 'existing "OPERATIONS holds no financial capability" invariant covers it');
      check(route.method === 'POST',
        `${where}: a finance write is a POST — finance history is append-only, and a `
        + 'correction is a new record rather than an edit of an old one');
    } else {
      // The exempt class is deliberately narrow, and every clause below is what stops it
      // becoming a door for a business write that would rather not be governed.
      check(route.method === 'POST',
        `${where}: a non-mutating route may only be POST`);
      check(!route.capability.endsWith('.write'),
        `${where}: a non-mutating route must not hold a write capability (has ${route.capability})`);
      check(route.path.startsWith('/api/ai/'),
        `${where}: the non-mutating exemption exists for AI interaction only`);
      check(route.entityType === undefined,
        `${where}: a non-mutating route has no entity to name`);
    }
  }

  // The exemption is an enumerated set, not a category anyone may join. A second entry
  // fails here until it is written down, and writing it down means reading this function.
  check(
    JSON.stringify(routes.filter((r) => r.nonMutating).map((r) => `${r.method} ${r.path}`))
      === JSON.stringify(['POST /api/ai/copilot']),
    'the non-mutating route set must be exactly [POST /api/ai/copilot]',
  );
}

/**
 * Non-GET routes that write nothing.
 *
 * Enumerated so the governance suites can assert what is in it, not merely that each
 * member is well-formed: a second entry fails the suite until someone writes it down,
 * and writing it down means reading what the exemption costs.
 */
export const NON_MUTATING_ROUTES = API_ROUTES.filter((r) => r.nonMutating);

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
