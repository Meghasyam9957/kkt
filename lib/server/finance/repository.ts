import '@/lib/server/only';
/**
 * FINANCE PERSISTENCE — and the reason every method starts with a tenant.
 *
 * The workbook made cross-tenant leakage structurally hard: one workbook per tenant means
 * another customer's rows are not in the file you opened. Postgres removes that
 * protection. Every tenant's bills sit in ONE table, and the only thing between customer A
 * and customer B is a predicate somebody remembered to write.
 *
 * So it is not left to memory. Every method on this interface takes a `TenantContext` as
 * its FIRST argument, and none has an overload that omits it. A repository call that does
 * not say whose data it wants does not compile — which is the same guarantee
 * `getDataProvider` gained in M-SAAS-1, applied to a store that needs it more.
 *
 * The specific ways a relational finance store leaks, and what stops each here:
 *
 *   a missing predicate on a list      every list method applies it before any filter
 *   a missing predicate on a BY-ID read `getX` filters by tenant AND id; a foreign id is
 *                                      a miss, indistinguishable from a nonexistent one
 *   an aggregate over an unfiltered set  balances are computed from tenant-filtered reads
 *   a join that widens                 there are no cross-table joins; settlement is
 *                                      computed from two tenant-scoped reads
 *   a foreign-key check that confirms  creating a bill against another tenant's vendor
 *     another tenant's row exists      resolves the vendor through `getVendor`, which is
 *                                      tenant-scoped, so the answer is "no such vendor"
 *   an error that differs by cause     `notFound` is the single refusal for both
 *
 * Two implementations, and they mirror each other exactly. A suite that passes against the
 * in-memory one is testing the rules the Supabase one enforces — which matters more than
 * usual here, because there is no local Postgres in this project and no migration runner:
 * migrations are declarative files an operator applies. In-memory is therefore the only
 * place the semantics can actually be executed.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import type {
  Vendor, Bill, Receivable, Payment, AccountingPeriod,
  Attribution, EntityStatus, ObligationStatus, PaymentStatus, PaymentDirection,
} from './types';
import { CORPORATE, propertyAttribution } from './types';
import type { Paise, CurrencyCode } from './money';
import { DEFAULT_CURRENCY } from './money';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface VendorInput {
  displayName: string;
  gstin?: string | null;
  contactRef?: string | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
}

export interface BillInput {
  vendorId: string;
  billReference: string;
  billDate: string;
  dueDate?: string | null;
  attribution: Attribution;
  amount: Paise;
  tax?: Paise;
  currency?: CurrencyCode;
  description?: string | null;
}

export interface ReceivableInput {
  counterparty: string;
  bookingRef?: string | null;
  reference: string;
  issuedDate: string;
  dueDate?: string | null;
  attribution: Attribution;
  amount: Paise;
  tax?: Paise;
  currency?: CurrencyCode;
  description?: string | null;
}

export interface PaymentInput {
  direction: PaymentDirection;
  amount: Paise;
  currency?: CurrencyCode;
  paidOn: string;
  billId?: string | null;
  receivableId?: string | null;
  attribution: Attribution;
  accountRef?: string | null;
  methodRef?: string | null;
  cashflowRef?: string | null;
  externalRef?: string | null;
  notes?: string | null;
}

export interface DateRange {
  /** Inclusive ISO date. */
  from?: string;
  /** Inclusive ISO date. */
  to?: string;
}

export interface PaymentFilter extends DateRange {
  status?: PaymentStatus;
  direction?: PaymentDirection;
  propertyId?: string;
}

export interface ObligationFilter extends DateRange {
  status?: ObligationStatus;
  propertyId?: string;
}

/* ------------------------------------------------------------------ *
 * The interface
 * ------------------------------------------------------------------ */

export interface FinanceRepository {
  createVendor(tenant: TenantContext, input: VendorInput, actor: string): Promise<Vendor>;
  listVendors(tenant: TenantContext, status?: EntityStatus): Promise<Vendor[]>;
  getVendor(tenant: TenantContext, id: string): Promise<Vendor | null>;
  setVendorStatus(tenant: TenantContext, id: string, status: EntityStatus): Promise<Vendor | null>;

  createBill(tenant: TenantContext, input: BillInput, actor: string): Promise<Bill>;
  listBills(tenant: TenantContext, filter?: ObligationFilter): Promise<Bill[]>;
  getBill(tenant: TenantContext, id: string): Promise<Bill | null>;
  voidBill(tenant: TenantContext, id: string, actor: string, reason: string): Promise<Bill | null>;

  createReceivable(tenant: TenantContext, input: ReceivableInput, actor: string): Promise<Receivable>;
  listReceivables(tenant: TenantContext, filter?: ObligationFilter): Promise<Receivable[]>;
  getReceivable(tenant: TenantContext, id: string): Promise<Receivable | null>;
  voidReceivable(tenant: TenantContext, id: string, actor: string, reason: string): Promise<Receivable | null>;

  createPayment(tenant: TenantContext, input: PaymentInput, actor: string): Promise<Payment>;
  listPayments(tenant: TenantContext, filter?: PaymentFilter): Promise<Payment[]>;
  getPayment(tenant: TenantContext, id: string): Promise<Payment | null>;
  /** Records a transition that the SERVICE has already validated. */
  transitionPayment(
    tenant: TenantContext, id: string, next: PaymentStatus, actor: string,
  ): Promise<Payment | null>;
  paymentsFor(
    tenant: TenantContext, target: { billId: string } | { receivableId: string },
  ): Promise<Payment[]>;

  getPeriod(tenant: TenantContext, periodStart: string): Promise<AccountingPeriod | null>;
  listPeriods(tenant: TenantContext): Promise<AccountingPeriod[]>;
  closePeriod(tenant: TenantContext, periodStart: string, actor: string): Promise<AccountingPeriod>;
  reopenPeriod(
    tenant: TenantContext, periodStart: string, actor: string, reason: string,
  ): Promise<AccountingPeriod | null>;
}

/* ------------------------------------------------------------------ *
 * In-memory implementation
 * ------------------------------------------------------------------ */

interface Row { tenantId: string }

/**
 * Everything held in memory, and every read filtered by tenant exactly as the SQL is.
 *
 * The temptation in an in-memory double is to key the maps by tenant, which makes
 * isolation automatic and therefore untested — the suite would prove the Map works. These
 * maps are keyed by ID, exactly as a table is, and every read applies the predicate. That
 * way a mutation which removes the predicate FAILS here, which is the only reason this
 * double is worth having.
 */
export class InMemoryFinanceRepository implements FinanceRepository {
  private readonly vendors = new Map<string, Vendor>();
  private readonly bills = new Map<string, Bill>();
  private readonly receivables = new Map<string, Receivable>();
  private readonly payments = new Map<string, Payment>();
  private readonly periods = new Map<string, AccountingPeriod>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** THE predicate. Everything below reads through it; nothing reads around it. */
  private mine<T extends Row>(tenant: TenantContext, rows: Iterable<T>): T[] {
    const { tenantId } = requireTenant(tenant, 'FinanceRepository');
    return [...rows].filter((row) => row.tenantId === tenantId);
  }

  private oneOf<T extends Row & { id: string }>(
    tenant: TenantContext, map: Map<string, T>, id: string,
  ): T | null {
    const { tenantId } = requireTenant(tenant, 'FinanceRepository');
    const row = map.get(id);
    // Tenant checked here, not by the caller. A foreign id is a miss — the same answer as
    // an id that never existed, so nothing can be enumerated by comparing refusals.
    return row && row.tenantId === tenantId ? row : null;
  }

  private stamp(): string { return this.now().toISOString(); }

  /* ---- vendors ---- */

  async createVendor(tenant: TenantContext, input: VendorInput, actor: string): Promise<Vendor> {
    const { tenantId } = requireTenant(tenant, 'createVendor');
    void actor;
    const vendor: Vendor = Object.freeze({
      id: randomUUID(),
      tenantId,
      displayName: input.displayName.trim(),
      gstin: input.gstin?.trim() || null,
      contactRef: input.contactRef?.trim() || null,
      paymentTermsDays: input.paymentTermsDays ?? null,
      status: 'ACTIVE' as const,
      notes: input.notes?.trim() || null,
      createdAt: this.stamp(),
    });
    this.vendors.set(vendor.id, vendor);
    return vendor;
  }

  async listVendors(tenant: TenantContext, status?: EntityStatus): Promise<Vendor[]> {
    return this.mine(tenant, this.vendors.values())
      .filter((v) => (status ? v.status === status : true))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getVendor(tenant: TenantContext, id: string): Promise<Vendor | null> {
    return this.oneOf(tenant, this.vendors, id);
  }

  async setVendorStatus(
    tenant: TenantContext, id: string, status: EntityStatus,
  ): Promise<Vendor | null> {
    const existing = this.oneOf(tenant, this.vendors, id);
    if (!existing) return null;
    const updated: Vendor = Object.freeze({ ...existing, status });
    this.vendors.set(id, updated);
    return updated;
  }

  /* ---- bills ---- */

  async createBill(tenant: TenantContext, input: BillInput, actor: string): Promise<Bill> {
    const { tenantId } = requireTenant(tenant, 'createBill');
    void actor;
    const bill: Bill = Object.freeze({
      id: randomUUID(),
      tenantId,
      vendorId: input.vendorId,
      reference: input.billReference.trim(),
      billDate: input.billDate,
      dueDate: input.dueDate ?? null,
      attribution: input.attribution,
      amount: input.amount,
      tax: (input.tax ?? 0) as Paise,
      currency: input.currency ?? DEFAULT_CURRENCY,
      status: 'OPEN' as const,
      description: input.description?.trim() || null,
      createdAt: this.stamp(),
    });
    this.bills.set(bill.id, bill);
    return bill;
  }

  async listBills(tenant: TenantContext, filter: ObligationFilter = {}): Promise<Bill[]> {
    return this.mine(tenant, this.bills.values())
      .filter((b) => matchesObligation(b.status, b.attribution, b.billDate, filter))
      .sort((a, b) => b.billDate.localeCompare(a.billDate));
  }

  async getBill(tenant: TenantContext, id: string): Promise<Bill | null> {
    return this.oneOf(tenant, this.bills, id);
  }

  async voidBill(
    tenant: TenantContext, id: string, actor: string, reason: string,
  ): Promise<Bill | null> {
    void actor; void reason;
    const existing = this.oneOf(tenant, this.bills, id);
    if (!existing) return null;
    const updated: Bill = Object.freeze({ ...existing, status: 'VOID' as ObligationStatus });
    this.bills.set(id, updated);
    return updated;
  }

  /* ---- receivables ---- */

  async createReceivable(
    tenant: TenantContext, input: ReceivableInput, actor: string,
  ): Promise<Receivable> {
    const { tenantId } = requireTenant(tenant, 'createReceivable');
    void actor;
    const receivable: Receivable = Object.freeze({
      id: randomUUID(),
      tenantId,
      counterparty: input.counterparty.trim(),
      bookingRef: input.bookingRef?.trim() || null,
      reference: input.reference.trim(),
      issuedDate: input.issuedDate,
      dueDate: input.dueDate ?? null,
      attribution: input.attribution,
      amount: input.amount,
      tax: (input.tax ?? 0) as Paise,
      currency: input.currency ?? DEFAULT_CURRENCY,
      status: 'OPEN' as const,
      description: input.description?.trim() || null,
      createdAt: this.stamp(),
    });
    this.receivables.set(receivable.id, receivable);
    return receivable;
  }

  async listReceivables(
    tenant: TenantContext, filter: ObligationFilter = {},
  ): Promise<Receivable[]> {
    return this.mine(tenant, this.receivables.values())
      .filter((r) => matchesObligation(r.status, r.attribution, r.issuedDate, filter))
      .sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));
  }

  async getReceivable(tenant: TenantContext, id: string): Promise<Receivable | null> {
    return this.oneOf(tenant, this.receivables, id);
  }

  async voidReceivable(
    tenant: TenantContext, id: string, actor: string, reason: string,
  ): Promise<Receivable | null> {
    void actor; void reason;
    const existing = this.oneOf(tenant, this.receivables, id);
    if (!existing) return null;
    const updated: Receivable = Object.freeze({ ...existing, status: 'VOID' as ObligationStatus });
    this.receivables.set(id, updated);
    return updated;
  }

  /* ---- payments ---- */

  async createPayment(
    tenant: TenantContext, input: PaymentInput, actor: string,
  ): Promise<Payment> {
    const { tenantId } = requireTenant(tenant, 'createPayment');
    const payment: Payment = Object.freeze({
      id: randomUUID(),
      tenantId,
      direction: input.direction,
      amount: input.amount,
      currency: input.currency ?? DEFAULT_CURRENCY,
      paidOn: input.paidOn,
      billId: input.billId ?? null,
      receivableId: input.receivableId ?? null,
      attribution: input.attribution,
      accountRef: input.accountRef?.trim() || null,
      methodRef: input.methodRef?.trim() || null,
      cashflowRef: input.cashflowRef?.trim() || null,
      externalRef: input.externalRef?.trim() || null,
      status: 'DRAFT' as const,
      reversesId: null,
      notes: input.notes?.trim() || null,
      createdBy: actor,
      approvedBy: null,
      createdAt: this.stamp(),
    });
    this.payments.set(payment.id, payment);
    return payment;
  }

  async listPayments(tenant: TenantContext, filter: PaymentFilter = {}): Promise<Payment[]> {
    return this.mine(tenant, this.payments.values())
      .filter((p) => (filter.status ? p.status === filter.status : true))
      .filter((p) => (filter.direction ? p.direction === filter.direction : true))
      .filter((p) => (filter.propertyId
        ? p.attribution.kind === 'PROPERTY' && p.attribution.propertyId === filter.propertyId
        : true))
      .filter((p) => withinRange(p.paidOn, filter))
      .sort((a, b) => b.paidOn.localeCompare(a.paidOn));
  }

  async getPayment(tenant: TenantContext, id: string): Promise<Payment | null> {
    return this.oneOf(tenant, this.payments, id);
  }

  async transitionPayment(
    tenant: TenantContext, id: string, next: PaymentStatus, actor: string,
  ): Promise<Payment | null> {
    const existing = this.oneOf(tenant, this.payments, id);
    if (!existing) return null;
    const updated: Payment = Object.freeze({
      ...existing,
      status: next,
      approvedBy: next === 'APPROVED' ? actor : existing.approvedBy,
    });
    this.payments.set(id, updated);
    return updated;
  }

  async paymentsFor(
    tenant: TenantContext, target: { billId: string } | { receivableId: string },
  ): Promise<Payment[]> {
    // Tenant first, target second. The other order would compute a balance from another
    // customer's payments whenever an id collided.
    return this.mine(tenant, this.payments.values()).filter((p) => (
      'billId' in target ? p.billId === target.billId : p.receivableId === target.receivableId
    ));
  }

  /* ---- periods ---- */

  private periodKey(tenantId: string, periodStart: string): string {
    return `${tenantId}|${periodStart}`;
  }

  async getPeriod(tenant: TenantContext, periodStart: string): Promise<AccountingPeriod | null> {
    const { tenantId } = requireTenant(tenant, 'getPeriod');
    return this.periods.get(this.periodKey(tenantId, periodStart)) ?? null;
  }

  async listPeriods(tenant: TenantContext): Promise<AccountingPeriod[]> {
    return this.mine(tenant, this.periods.values())
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  }

  async closePeriod(
    tenant: TenantContext, periodStart: string, actor: string,
  ): Promise<AccountingPeriod> {
    const { tenantId } = requireTenant(tenant, 'closePeriod');
    const period: AccountingPeriod = Object.freeze({
      tenantId,
      periodStart,
      status: 'CLOSED' as const,
      closedAt: this.stamp(),
      closedBy: actor,
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: null,
    });
    this.periods.set(this.periodKey(tenantId, periodStart), period);
    return period;
  }

  async reopenPeriod(
    tenant: TenantContext, periodStart: string, actor: string, reason: string,
  ): Promise<AccountingPeriod | null> {
    const { tenantId } = requireTenant(tenant, 'reopenPeriod');
    const existing = this.periods.get(this.periodKey(tenantId, periodStart));
    if (!existing) return null;
    const period: AccountingPeriod = Object.freeze({
      ...existing,
      status: 'OPEN' as const,
      reopenedAt: this.stamp(),
      reopenedBy: actor,
      reopenReason: reason,
    });
    this.periods.set(this.periodKey(tenantId, periodStart), period);
    return period;
  }
}

/* ------------------------------------------------------------------ *
 * Shared filter helpers
 * ------------------------------------------------------------------ */

function withinRange(date: string, range: DateRange): boolean {
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

function matchesObligation(
  status: ObligationStatus,
  attribution: Attribution,
  date: string,
  filter: ObligationFilter,
): boolean {
  if (filter.status && status !== filter.status) return false;
  if (filter.propertyId) {
    if (attribution.kind !== 'PROPERTY') return false;
    if (attribution.propertyId !== filter.propertyId) return false;
  }
  return withinRange(date, filter);
}

/** Row → domain, shared by the Supabase repository. Exported so both agree on one mapping. */
export function attributionFromRow(kind: string, propertyId: string | null): Attribution {
  return kind === 'PROPERTY' && propertyId ? propertyAttribution(propertyId) : CORPORATE;
}
