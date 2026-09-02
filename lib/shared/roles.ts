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
