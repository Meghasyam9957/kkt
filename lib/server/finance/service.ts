import '@/lib/server/only';
/**
 * FINANCE RULES — the layer a test can actually execute.
 *
 * Nothing in this project runs Postgres: there is no local database, no migration runner
 * and no CI. So a rule expressed in SQL — a trigger, a `security definer` function, a
 * constraint that decides a workflow — is a rule nothing verifies. Every rule that matters
 * therefore lives here, in TypeScript, in front of both repository implementations. The
 * database's own constraints are defence in depth and are written as such; this is the
 * boundary.
 *
 * Four rules, and each one is a question the repository deliberately does not answer:
 *
 *   1. IS THE PERIOD OPEN?      A closed month refuses new money movement dated inside it.
 *   2. IS THIS PROPERTY MINE?   A property reference is checked against the caller's OWN
 *                               workbook, so it cannot confirm another tenant's property.
 *   3. IS THIS TRANSITION LEGAL? DRAFT → POSTED skips approval; it is refused by name.
 *   4. WHAT IS ACTUALLY SETTLED? Balances are computed from POSTED payments and never
 *                               stored, so they cannot drift from the payments.
 *
 * WHAT THIS MODULE DOES NOT COMPUTE, on purpose:
 *
 *   the P&L          10_MONTHLY_PNL is a workbook report whose OperatingProfit and
 *                    OperatingMarginPct are workbook formulas. It is in READ_ONLY_SHEETS
 *                    and is served by `provider.getPnl()`. A second operating result
 *                    computed here would be a second answer to a question that already
 *                    has an authoritative one.
 *   the cash flow    09_CASH_FLOW owns the money journal, with RunningBalance as a
 *                    workbook formula. What this module reports is narrower and says so:
 *                    money settled THROUGH THE FINANCE LEDGER, which is not the business's
 *                    cash position.
 *   OTA payouts      04_RESERVATIONS models ExpectedPayout → ActualPayout → PayoutVariance
 *                    in workbook formulas. Nothing here recomputes or second-guesses it.
 */
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import {
  ZERO, sumPaise, subtractPaise, type Paise,
} from './money';
import {
  PAYMENT_TRANSITIONS, countsTowardSettlement, notFound, refuse,
  type Attribution, type Bill, type BillWithBalance, type ObligationBalance,
  type Payment, type PaymentStatus, type Receivable, type ReceivableWithBalance,
  type AccountingPeriod,
} from './types';
import type {
  FinanceRepository, BillInput, ReceivableInput, PaymentInput, VendorInput,
  ObligationFilter, PaymentFilter,
} from './repository';
import type { Vendor } from './types';

export interface FinanceServiceDeps {
  repo: FinanceRepository;
  /**
   * The property identifiers in THIS TENANT'S OWN workbook.
   *
   * Wired from `getDataProvider(tenant).getPropertyIds()`, which is already resolved
   * through the tenant workbook registry. That is what makes property validation safe: the
   * only list a caller can be checked against is their own, so a refusal cannot reveal
   * that another tenant has a property by that name — the question is never asked.
   */
  propertyIds: (tenant: TenantContext) => Promise<readonly string[]>;
  audit: AuditService;
  now?: () => Date;
}

/** The month a date falls in, as the first day of it. */
export function periodStartOf(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export class FinanceService {
  constructor(private readonly deps: FinanceServiceDeps) {}

  private clock(): Date { return this.deps.now?.() ?? new Date(); }

  /* ---------------------------------------------------------------- *
   * Rule 1 · the period lock
   * ---------------------------------------------------------------- */

  /**
   * A closed month refuses money dated inside it.
   *
   * This governs the finance tables only. The workbook's 18_MONTHLY_CLOSE remains the
   * human close checklist for the workbook's own domains — two authorities over one
   * question is how they come to disagree, so they are given different questions.
   */
  async assertPeriodOpen(tenant: TenantContext, isoDate: string): Promise<void> {
    const period = await this.deps.repo.getPeriod(tenant, periodStartOf(isoDate));
    if (period && period.status === 'CLOSED') {
      throw refuse(
        'PERIOD_CLOSED',
        `${isoDate.slice(0, 7)} is closed. A closed period does not accept new money `
        + 'movement dated inside it; reopen the period, with a reason, or date the entry '
        + 'in an open one.',
        409,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Rule 2 · the property must be the caller's own
   * ---------------------------------------------------------------- */

  /**
   * Refuses a property that is not in the caller's workbook.
   *
   * The refusal is deliberately identical whether the property belongs to another tenant
   * or does not exist at all — the check never consults another tenant's data, so it
   * cannot distinguish the two even in principle. That is stronger than a comparison that
   * happens to answer the same way.
   */
  async assertPropertyIsOwn(tenant: TenantContext, attribution: Attribution): Promise<void> {
    if (attribution.kind === 'CORPORATE') return;
    const owned = await this.deps.propertyIds(tenant);
    if (!owned.includes(attribution.propertyId)) {
      throw refuse(
        'UNKNOWN_PROPERTY',
        `No property ${attribution.propertyId} in this workbook. A cost can only be `
        + 'attributed to a property this business operates, or to the business as a whole.',
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Vendors
   * ---------------------------------------------------------------- */

  async createVendor(tenant: TenantContext, input: VendorInput, actor: string): Promise<Vendor> {
    const name = input.displayName?.trim() ?? '';
    if (name === '') throw refuse('VALIDATION', 'A vendor needs a name.');
    if (input.gstin && !/^[0-9A-Z]{15}$/.test(input.gstin.trim())) {
      // Format only. This is not a claim to validate a GSTIN against any registry, and
      // no tax treatment follows from storing it — see the architecture document.
      throw refuse('VALIDATION', 'A GSTIN is 15 characters, digits and capitals only.');
    }
    const existing = await this.deps.repo.listVendors(tenant);
    if (existing.some((v) => v.displayName.toLowerCase() === name.toLowerCase())) {
      throw refuse('DUPLICATE_VENDOR', `This business already has a vendor called "${name}".`);
    }
    return this.deps.repo.createVendor(tenant, { ...input, displayName: name }, actor);
  }

  listVendors(tenant: TenantContext): Promise<Vendor[]> {
    return this.deps.repo.listVendors(tenant);
  }

  /* ---------------------------------------------------------------- *
   * Payables
   * ---------------------------------------------------------------- */

  async createBill(tenant: TenantContext, input: BillInput, actor: string): Promise<Bill> {
    if (input.amount <= 0) {
      throw refuse('VALIDATION', 'A bill is a positive obligation. A credit note is a different document and is not modelled.');
    }
    await this.assertPropertyIsOwn(tenant, input.attribution);
    await this.assertPeriodOpen(tenant, input.billDate);

    // The vendor is resolved THROUGH the tenant-scoped repository, so another tenant's
    // vendor id answers "no such vendor" rather than confirming it exists.
    const vendor = await this.deps.repo.getVendor(tenant, input.vendorId);
    if (!vendor) throw notFound('vendor');
    if (vendor.status !== 'ACTIVE') {
      throw refuse('VENDOR_INACTIVE', `${vendor.displayName} is no longer an active vendor.`);
    }

    const duplicates = await this.deps.repo.listBills(tenant);
    if (duplicates.some((b) => b.vendorId === vendor.id
      && b.reference.toLowerCase() === input.billReference.trim().toLowerCase())) {
      // Paying one invoice twice is the commonest way a business loses money to its own
      // process, so the same reference from the same vendor is refused outright.
      throw refuse('DUPLICATE_BILL',
        `${vendor.displayName} invoice ${input.billReference} is already recorded.`);
    }

    return this.deps.repo.createBill(tenant, input, actor);
  }

  async billsWithBalances(
    tenant: TenantContext, filter: ObligationFilter = {},
  ): Promise<BillWithBalance[]> {
    const bills = await this.deps.repo.listBills(tenant, filter);
    return Promise.all(bills.map(async (bill) => ({
      ...bill,
      balance: await this.balanceOf(tenant, bill, { billId: bill.id }),
    })));
  }

  async billWithBalance(tenant: TenantContext, id: string): Promise<BillWithBalance> {
    const bill = await this.deps.repo.getBill(tenant, id);
    if (!bill) throw notFound('bill');
    return { ...bill, balance: await this.balanceOf(tenant, bill, { billId: bill.id }) };
  }

  /* ---------------------------------------------------------------- *
   * Receivables
   * ---------------------------------------------------------------- */

  async createReceivable(
    tenant: TenantContext, input: ReceivableInput, actor: string,
  ): Promise<Receivable> {
    if (input.amount <= 0) throw refuse('VALIDATION', 'A receivable is a positive amount.');
    if (!input.counterparty?.trim()) throw refuse('VALIDATION', 'A receivable needs a counterparty.');
    await this.assertPropertyIsOwn(tenant, input.attribution);
    await this.assertPeriodOpen(tenant, input.issuedDate);
    return this.deps.repo.createReceivable(tenant, input, actor);
  }

  async receivablesWithBalances(
    tenant: TenantContext, filter: ObligationFilter = {},
  ): Promise<ReceivableWithBalance[]> {
    const rows = await this.deps.repo.listReceivables(tenant, filter);
    return Promise.all(rows.map(async (r) => ({
      ...r,
      balance: await this.balanceOf(tenant, r, { receivableId: r.id }),
    })));
  }

  async receivableWithBalance(tenant: TenantContext, id: string): Promise<ReceivableWithBalance> {
    const row = await this.deps.repo.getReceivable(tenant, id);
    if (!row) throw notFound('receivable');
    return { ...row, balance: await this.balanceOf(tenant, row, { receivableId: row.id }) };
  }

  /* ---------------------------------------------------------------- *
   * Rule 4 · balances, computed and never stored
   * ---------------------------------------------------------------- */

  private async balanceOf(
    tenant: TenantContext,
    obligation: { amount: Paise; currency: ObligationBalance['currency'] },
    target: { billId: string } | { receivableId: string },
  ): Promise<ObligationBalance> {
    const payments = await this.deps.repo.paymentsFor(tenant, target);
    // POSTED only. A payment awaiting approval has not moved money, and counting it would
    // report a bill as settled before anybody paid it.
    const settled = sumPaise(
      payments.filter((p) => countsTowardSettlement(p.status)).map((p) => p.amount),
    );
    const outstanding = subtractPaise(obligation.amount, settled);
    return Object.freeze({
      amount: obligation.amount,
      settled,
      outstanding,
      // Surfaced, not clamped. More settled than owed is a real event — a duplicate
      // payment, or one attached to the wrong bill — and Math.max(0, …) would hide it.
      overpaid: outstanding < 0,
      currency: obligation.currency,
    });
  }

  /* ---------------------------------------------------------------- *
   * Payments
   * ---------------------------------------------------------------- */

  async createPayment(
    tenant: TenantContext, input: PaymentInput, actor: string,
  ): Promise<Payment> {
    if (input.amount <= 0) throw refuse('VALIDATION', 'A payment moves a positive amount.');
    if (input.billId && input.receivableId) {
      throw refuse('VALIDATION',
        'A payment settles one thing. A payment against both a payable and a receivable is two payments.');
    }
    await this.assertPropertyIsOwn(tenant, input.attribution);
    await this.assertPeriodOpen(tenant, input.paidOn);

    if (input.billId) {
      if (input.direction !== 'OUTGOING') {
        throw refuse('VALIDATION', 'A payable is settled by money going out.');
      }
      // Tenant-scoped lookup: another tenant's bill id is simply not found.
      if (!await this.deps.repo.getBill(tenant, input.billId)) throw notFound('bill');
    }
    if (input.receivableId) {
      if (input.direction !== 'INCOMING') {
        throw refuse('VALIDATION', 'A receivable is settled by money coming in.');
      }
      if (!await this.deps.repo.getReceivable(tenant, input.receivableId)) {
        throw notFound('receivable');
      }
    }

    return this.deps.repo.createPayment(tenant, input, actor);
  }

  /* ---------------------------------------------------------------- *
   * Rule 3 · the lifecycle
   * ---------------------------------------------------------------- */

  async transitionPayment(
    tenant: TenantContext, id: string, next: PaymentStatus, actor: string,
  ): Promise<Payment> {
    const payment = await this.deps.repo.getPayment(tenant, id);
    if (!payment) throw notFound('payment');

    const allowed = PAYMENT_TRANSITIONS[payment.status];
    if (!allowed.includes(next)) {
      throw refuse('ILLEGAL_TRANSITION',
        `A ${payment.status} payment cannot become ${next}. `
        + (allowed.length === 0
          ? 'That payment is in a final state; a correction is a new payment, not an edit.'
          : `From here it may become: ${allowed.join(', ')}.`),
        409);
    }

    // Approving your own payment defeats the point of an approval. Refused here rather
    // than left to a policy nobody enforces.
    if (next === 'APPROVED' && payment.createdBy && payment.createdBy === actor) {
      throw refuse('SELF_APPROVAL',
        'A payment must be approved by someone other than the person who raised it.', 409);
    }

    // Posting is money movement, so it is subject to the period lock exactly as creation is.
    if (next === 'POSTED') await this.assertPeriodOpen(tenant, payment.paidOn);

    const updated = await this.deps.repo.transitionPayment(tenant, id, next, actor);
    if (!updated) throw notFound('payment');
    return updated;
  }

  listPayments(tenant: TenantContext, filter: PaymentFilter = {}): Promise<Payment[]> {
    return this.deps.repo.listPayments(tenant, filter);
  }

  /* ---------------------------------------------------------------- *
   * Periods
   * ---------------------------------------------------------------- */

  async closePeriod(
    tenant: TenantContext, periodStart: string, actor: string,
  ): Promise<AccountingPeriod> {
    assertMonthStart(periodStart);
    return this.deps.repo.closePeriod(tenant, periodStart, actor);
  }

  async reopenPeriod(
    tenant: TenantContext, periodStart: string, actor: string, reason: string,
  ): Promise<AccountingPeriod> {
    assertMonthStart(periodStart);
    if (!reason?.trim()) {
      // Reopening a closed month is the act that most needs a recorded reason.
      throw refuse('VALIDATION', 'Reopening a closed period requires a reason, which is recorded.');
    }
    const reopened = await this.deps.repo.reopenPeriod(tenant, periodStart, actor, reason.trim());
    if (!reopened) throw notFound('period');
    return reopened;
  }

  listPeriods(tenant: TenantContext): Promise<AccountingPeriod[]> {
    return this.deps.repo.listPeriods(tenant);
  }

  /* ---------------------------------------------------------------- *
   * Reporting foundation
   * ---------------------------------------------------------------- */

  /**
   * The tenant's obligations position and the money settled through this ledger.
   *
   * Deliberately NOT called a P&L or a cash-flow statement, and deliberately not
   * comparable to one. Every figure here is what the FINANCE LEDGER knows:
   *
   *   payables/receivables outstanding — obligations recorded here, minus posted payments
   *   settled in/out                   — POSTED payments only, in the range
   *
   * It does not include revenue (05_REVENUE), expenses (06_EXPENSES) or the cash journal
   * (09_CASH_FLOW). The operating result comes from 10_MONTHLY_PNL through
   * `provider.getPnl()`, where the workbook's own formulas own it.
   */
  async position(
    tenant: TenantContext, range: { from?: string; to?: string } = {},
  ): Promise<FinancePosition> {
    requireTenant(tenant, 'position');
    const [bills, receivables, payments] = await Promise.all([
      this.billsWithBalances(tenant, { status: 'OPEN' }),
      this.receivablesWithBalances(tenant, { status: 'OPEN' }),
      this.deps.repo.listPayments(tenant, { ...range, status: 'POSTED' }),
    ]);

    const outgoing = payments.filter((p) => p.direction === 'OUTGOING');
    const incoming = payments.filter((p) => p.direction === 'INCOMING');

    return Object.freeze({
      payablesOutstanding: sumPaise(bills.map((b) => b.balance.outstanding)),
      receivablesOutstanding: sumPaise(receivables.map((r) => r.balance.outstanding)),
      settledOut: sumPaise(outgoing.map((p) => p.amount)),
      settledIn: sumPaise(incoming.map((p) => p.amount)),
      openBills: bills.length,
      openReceivables: receivables.length,
      /*
       * An empty ledger is genuinely zero outstanding, not missing data — nobody is owed
       * anything, which is a fact rather than an absence. `INSUFFICIENT_DATA` is reserved
       * for a figure that could not be computed; this one always can.
       */
      overdue: countOverdue(bills, receivables, this.clock()),
    });
  }
}

export interface FinancePosition {
  readonly payablesOutstanding: Paise;
  readonly receivablesOutstanding: Paise;
  readonly settledOut: Paise;
  readonly settledIn: Paise;
  readonly openBills: number;
  readonly openReceivables: number;
  readonly overdue: { readonly bills: number; readonly receivables: number };
}

function countOverdue(
  bills: readonly BillWithBalance[],
  receivables: readonly ReceivableWithBalance[],
  now: Date,
): { bills: number; receivables: number } {
  const today = now.toISOString().slice(0, 10);
  const isOverdue = (due: string | null, outstanding: Paise): boolean =>
    due !== null && due < today && outstanding > ZERO;
  return {
    bills: bills.filter((b) => isOverdue(b.dueDate, b.balance.outstanding)).length,
    receivables: receivables.filter((r) => isOverdue(r.dueDate, r.balance.outstanding)).length,
  };
}

function assertMonthStart(periodStart: string): void {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) {
    throw refuse('VALIDATION', 'A period is a calendar month, named by its first day (YYYY-MM-01).');
  }
}
