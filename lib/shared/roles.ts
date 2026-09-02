/**
 * ROLE AND CAPABILITY MODEL — the single definition of who may do what.
 *
 * Authorization is expressed as capabilities, not as role checks sprinkled through
 * handlers. A handler declares the capability it needs; the role→capability table below
 * is the only place that mapping exists. Adding a role never requires touching a handler.
 *
 * This module is data + pure functions only, and it lives in `lib/shared` on purpose: the
 * app shell needs the capability table to decide which navigation entries to render, and
 * pulling a server-guarded module into a client component would break the browser bundle.
 *
 * Nothing here grants anything. Hiding a menu item is a convenience; every request is
 * still checked by the API guard, and the RBAC suite asserts that a hidden route is also
 * refused when called directly.
 */

export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'INVESTOR'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  // Financial surfaces
  'dashboard.financial.view',
  'revenue.read', 'expenses.read', 'capex.read', 'rent.read', 'cashflow.read', 'pnl.read',
  'analytics.read', 'reports.read',
  // Operational surfaces
  'operations.view', 'reservations.read', 'guests.read',
  'housekeeping.read', 'maintenance.read', 'inventory.read', 'compliance.read',
  'properties.read',
  // Investor surfaces
  'investors.read.all',   // every investor — management only
  'investor.self.read',   // the caller's OWN investor record, always server-scoped
  /*
   * Write capabilities (Phase B2). One per entity, named `<entity>.write`, so the
   * write-governance tests can verify mechanically that every mutating route demands
   * one and that INVESTOR holds none. There is deliberately NO `settings.write`-style
   * business-rule writer here beyond the pre-existing SUPER_ADMIN-only entry:
   * commercial rules remain management decisions made in the workbook.
   */
  'reservations.write', 'revenue.write', 'expenses.write', 'capex.write',
  'rent.write', 'cashflow.write',
  'housekeeping.write', 'maintenance.write', 'inventory.write',
  'investors.write', 'distributions.write', 'properties.write',
  /*
   * FINANCE (M-DATA-1). The relational finance domain — vendors, payables, receivables
   * and settlement — which lives in Postgres rather than the workbook.
   *
   * Four capabilities rather than one, because the separation that matters in finance is
   * between RAISING a payment and APPROVING it. Granting both to one role does not by
   * itself create a control failure — the service additionally refuses self-approval — but
   * expressing them separately is what lets a deployment ever separate them.
   *
   * `finance.period.manage` closes and reopens an accounting month. It is deliberately
   * NOT granted to ADMIN: reopening a closed period is the act that most needs a second
   * pair of hands, and it is recorded with a reason and an actor when it happens.
   */
  'finance.read', 'finance.write', 'finance.approve', 'finance.period.manage',
  /*
   * PEOPLE (M-HR-1). Split along the line that actually matters in HR, which is not
   * read-versus-write but PERSON-versus-PAY.
   *
   * Attendance, leave and shifts are operational facts: who is on shift tonight is the
   * same kind of question as which unit needs cleaning. Compensation is not. Somebody who
   * may see that a colleague was late is not thereby somebody who may see what that
   * colleague earns, and one `hr.read` capability covering both would have made that
   * distinction unexpressible.
   *
   * `hr.payroll.approve` sits above the rest for the same reason `finance.period.manage`
   * does: approving a payroll run is what turns a calculation into money somebody will be
   * paid, and it is the act that most needs a second pair of hands.
   */
  'hr.read', 'hr.manage', 'hr.approve',
  'hr.compensation.read', 'hr.compensation.manage', 'hr.payroll.approve',
  /*
   * PEOPLE ON OPERATIONS (M-OPS-2). Deliberately NOT `hr.read`.
   *
   * A supervisor needs to know who is on shift tonight and who owns which turnover. They do
   * not need a contact directory, and `hr.read` reaches `/api/hr/employees`, which carries
   * `contactRef` and `email`. Granting it to run a housekeeping board would widen an
   * operations login into the staff directory as a side effect.
   *
   * So these two are narrower by construction: `operations.staff.read` serves the roster
   * projection — name, code, department, designation, shift, attendance, open task count —
   * and nothing else exists on the type to leak.
   */
  'operations.staff.read', 'operations.assign',
  /*
   * INVENTORY, M-INV-1. `inventory.read` and `inventory.write` already existed and are
   * unchanged — the first shows stock, the second writes the workbook's own columns.
   *
   * Three narrower ones join them, because "may change stock" turned out to cover three
   * quite different powers:
   *
   *   inventory.movement  record WHY stock moved — a turnover consumed two towels, a sheet
   *                       was torn. Ordinary operational work.
   *   inventory.adjust    correct the count itself. This is the one that can make a
   *                       discrepancy disappear, so it is deliberately NOT operational.
   *   inventory.assets    read the asset register and link a ticket to an asset.
   */
  'inventory.movement', 'inventory.adjust', 'inventory.assets',
  /*
   * PROCUREMENT. Asking is operational; approving is not, and that split is the whole point
   * of separating duty. `procurement.approve` is listed in FINANCIAL_CAPABILITIES below, so
   * the invariant that OPERATIONS holds no financial capability guards it automatically — a
   * future grant of it to an operations login fails a test written long before procurement
   * existed.
   */
  'procurement.read', 'procurement.request', 'procurement.receive', 'procurement.approve',
  // Administration
  'settings.read', 'settings.write', 'users.manage', 'audit.read',
  /**
   * Demonstration controls: scenario switching and demo reset. Held by management roles
   * only, and additionally gated by the environment — the capability alone is not enough,
   * because production has no such controls to authorise.
   */
  'demo.control',
  // AI (declared now, enforced from the start; features arrive in later phases)
  'ai.copilot', 'ai.operations',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Role → capability grants.
 *
 * OPERATIONS deliberately holds NO financial capability: an operations login that can read
 * the P&L is an operations login that leaks the P&L. ADMIN deliberately cannot write
 * settings — business rules stay editable in the workbook only, under one audited path.
 */
const GRANTS: Record<Role, readonly Capability[]> = {
  SUPER_ADMIN: [...CAPABILITIES],

  ADMIN: [
    'dashboard.financial.view',
    'revenue.read', 'expenses.read', 'capex.read', 'rent.read', 'cashflow.read', 'pnl.read',
    'analytics.read', 'reports.read',
    'operations.view', 'reservations.read', 'guests.read',
    'housekeeping.read', 'maintenance.read', 'inventory.read', 'compliance.read',
    'properties.read',
    'investors.read.all',
    // Full business administration (Phase B role decisions): every entity writer.
    // Business RULES stay out of reach — no 'settings.write'.
    'reservations.write', 'revenue.write', 'expenses.write', 'capex.write',
    'rent.write', 'cashflow.write',
    'housekeeping.write', 'maintenance.write', 'inventory.write',
    'investors.write', 'distributions.write', 'properties.write',
    'settings.read',            // read-only: no 'settings.write'
    // Finance: may run the ledger and approve payments they did not raise. NOT
    // 'finance.period.manage' — closing and reopening a month stays above this role.
    'finance.read', 'finance.write', 'finance.approve',
    /*
     * People: the full HR desk, including compensation — this role already holds
     * `pnl.read`, so withholding the salary line from somebody who can read the profit
     * and loss it sits inside would be theatre rather than a control.
     *
     * NOT 'hr.payroll.approve'. Turning a calculation into money people will be paid
     * stays above this role, exactly as closing a finance period does.
     */
    'hr.read', 'hr.manage', 'hr.approve',
    'hr.compensation.read', 'hr.compensation.manage',
    'operations.staff.read', 'operations.assign',
    'inventory.movement', 'inventory.adjust', 'inventory.assets',
    'procurement.read', 'procurement.request', 'procurement.receive', 'procurement.approve',
    'audit.read',               // full internal READ access, per the Phase 5A role brief
    'demo.control',             // demo-only in practice; the environment gate decides
    'ai.copilot', 'ai.operations',
  ],

  OPERATIONS: [
    'operations.view', 'reservations.read', 'guests.read',
    'housekeeping.read', 'maintenance.read', 'inventory.read',
    'properties.read',
    // Operational writers only (Phase B role decisions): reservations incl.
    // check-in/check-out, housekeeping, maintenance, inventory. NO financial writer,
    // NO investor writer, NO property-master or settings writer.
    'reservations.write', 'housekeeping.write', 'maintenance.write', 'inventory.write',
    /*
     * Who is working, and who owns which task. This is the operational half of the people
     * domain and nothing more: no compensation capability, and not `hr.read` either — see
     * the capability list for why the narrower pair exists.
     */
    'operations.staff.read', 'operations.assign',
    /*
     * Stock is operational work: a supervisor records what a turnover used, asks for more,
     * and signs for what arrived. What they do NOT get is `inventory.adjust` — correcting a
     * count is how a discrepancy stops being a question anybody asks — or
     * `procurement.approve`, because whoever asks for something must not be whoever
     * approves it.
     */
    'inventory.movement', 'inventory.assets',
    'procurement.read', 'procurement.request', 'procurement.receive',
    'ai.operations',
  ],

  INVESTOR: [
    'investor.self.read',
  ],
};

export function capabilitiesFor(role: Role): readonly Capability[] {
  return GRANTS[role];
}

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return GRANTS[role].includes(capability);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Capabilities that expose guest personal data. Investor-facing code paths must never
 * require one of these — asserted by the security suite, not left to review.
 */
export const PII_CAPABILITIES: readonly Capability[] = ['guests.read', 'reservations.read'];

/** Capabilities that expose internal financial detail — writers included, so the
 * "OPERATIONS holds no financial capability" invariant covers mutation too. */
export const FINANCIAL_CAPABILITIES: readonly Capability[] = [
  'dashboard.financial.view', 'revenue.read', 'expenses.read', 'capex.read',
  'rent.read', 'cashflow.read', 'pnl.read', 'investors.read.all',
  'revenue.write', 'expenses.write', 'capex.write', 'rent.write', 'cashflow.write',
  'investors.write', 'distributions.write',
  /*
   * The M-DATA-1 finance domain belongs in this list, and listing it here is what makes
   * the existing invariants cover it for free: the security suite already asserts that
   * OPERATIONS and INVESTOR hold NO financial capability, so a future grant of
   * `finance.read` to an operations login fails a test that was written before finance
   * existed. That is the intended way to extend this system — add to the list, and the
   * rules that already exist start guarding the new thing.
   */
  'finance.read', 'finance.write', 'finance.approve', 'finance.period.manage',
  /*
   * Approving a purchase commits the business to spending money, which is a finance decision
   * whatever the thing being bought is. Listing it here means the assertions that already
   * exist — that OPERATIONS and INVESTOR hold no financial capability — cover procurement
   * for free, and separation of duty cannot be quietly undone by a grant.
   */
  'procurement.approve',
  /*
   * ONLY the compensation half of HR belongs here, and the omission is deliberate.
   *
   * `hr.compensation.read`, `hr.compensation.manage` and `hr.payroll.approve` expose pay,
   * so the existing "OPERATIONS holds no financial capability" invariant should guard them
   * — and now does, without a new test.
   *
   * `hr.read`, `hr.manage` and `hr.approve` are NOT here, because attendance and shifts
   * are operational facts rather than financial ones. Listing them would make this
   * constant mean "anything HR touches", and the day an operations supervisor is granted
   * `hr.read` to mark their own team present, a correct grant would fail a financial
   * invariant it has nothing to do with.
   */
  'hr.compensation.read', 'hr.compensation.manage', 'hr.payroll.approve',
];

/**
 * True when the role holds ANY financial capability — the column gate for the shared
 * registers (/admin/properties, /admin/reservations), which OPERATIONS may open for their
 * operational columns while the financial columns stay with the roles the money screens
 * belong to. Derived from the grants table at call time, so it can never disagree with
 * FINANCIAL_CAPABILITIES or with a future change to a role's grants.
 */
export function roleSeesFinancialFigures(role: Role): boolean {
  return FINANCIAL_CAPABILITIES.some((capability) => roleHasCapability(role, capability));
}

/** Every mutation capability. INVESTOR must hold none of these — asserted in tests. */
export const WRITE_CAPABILITIES: readonly Capability[] = [
  'reservations.write', 'revenue.write', 'expenses.write', 'capex.write',
  'rent.write', 'cashflow.write',
  'housekeeping.write', 'maintenance.write', 'inventory.write',
  'investors.write', 'distributions.write', 'properties.write',
  'settings.write',
];
