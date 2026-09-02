import '@/lib/server/only';
/**
 * THE POSTGRES FINANCE REPOSITORY — and why it is this boring.
 *
 * This codebase has already been bitten once by exactly the failure this file is shaped
 * to avoid. Migration 0004 added `audit_log.tenant_id`, `AuditRecord` carried the field,
 * and the in-memory sink stored it — but `SupabaseAuditSink.write` listed thirteen columns
 * without it. Every production audit row was unattributed while the entire suite was
 * green, because the suite only ever exercised the in-memory twin.
 *
 * That divergence cost attribution. The same divergence here — an in-memory repository
 * that filters by tenant and a Postgres one whose `.select()` lost its `.eq('tenant_id')`
 * — costs one customer's payment ledger appearing in another's, with a fully green suite
 * and no way to notice from a test run. There is no local Postgres in this project, no
 * migration runner and no CI, so nothing executes this file's SQL. Three consequences,
 * and they are the whole design:
 *
 *   1. NO LOGIC HERE. Every rule — lifecycle transitions, period locks, balances,
 *      property validation — lives in `service.ts`, which the suite actually runs. This
 *      file maps rows to objects and does nothing else. A rule expressed only in SQL
 *      would be a rule no test can reach.
 *
 *   2. ONE PLACE BUILDS A QUERY. `scoped()` and `insertRow()` are the only two ways this
 *      class touches the database, and both apply the tenant predicate themselves. There
 *      is no method that assembles its own `.from(...)`, so there is no method that can
 *      forget.
 *
 *   3. THE CHAIN IS ASSERTABLE. Every call goes through a client the tests replace with a
 *      recorder, so `tests/finance-isolation.test.ts` asserts the exact filter chain of
 *      every read and the exact column list of every insert. That is the only mechanism
 *      available for catching a lost predicate in code nothing executes.
 */
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import { paiseFromDatabase, DEFAULT_CURRENCY, type Paise, type CurrencyCode } from './money';
import {
  attributionFromRow,
  type FinanceRepository, type VendorInput, type BillInput, type ReceivableInput,
  type PaymentInput, type ObligationFilter, type PaymentFilter,
} from './repository';
import type {
  Vendor, Bill, Receivable, Payment, AccountingPeriod,
  EntityStatus, ObligationStatus, PaymentStatus,
} from './types';

const VENDORS = 'finance_vendors';
const BILLS = 'finance_bills';
const RECEIVABLES = 'finance_receivables';
const PAYMENTS = 'finance_payments';
const PERIODS = 'finance_periods';

export class SupabaseFinanceRepository implements FinanceRepository {
  constructor(private readonly client: any) {}

  /**
   * EVERY read starts here, and every read therefore carries the tenant.
   *
   * The predicate is applied before the caller can add anything, so a filter a caller
   * forgets narrows the result set — it never widens it past the tenant.
   */
  private scoped(table: string, tenant: TenantContext): any {
    const { tenantId } = requireTenant(tenant, `SupabaseFinanceRepository.${table}`);
    return this.client.from(table).select('*').eq('tenant_id', tenantId);
  }

  /** EVERY write starts here, and the tenant is stamped from the context, never the input. */
  private async insertRow(table: string, tenant: TenantContext, row: Record<string, unknown>): Promise<any> {
    const { tenantId } = requireTenant(tenant, `SupabaseFinanceRepository.${table}`);
    const { data, error } = await this.client
      .from(table)
      // `tenant_id` LAST, so a caller-supplied one in `row` is overwritten rather than
      // honoured. There is no path by which a request body decides whose row this is.
      .insert({ ...row, tenant_id: tenantId })
      .select('*')
      .single();
    if (error) throw new Error(String(error.message ?? `${table} insert failed`));
    return data;
  }

  private async updateRow(
    table: string, tenant: TenantContext, id: string, patch: Record<string, unknown>,
  ): Promise<any | null> {
    const { tenantId } = requireTenant(tenant, `SupabaseFinanceRepository.${table}`);
    const { data, error } = await this.client
      .from(table)
      .update({ ...patch, updated_at: new Date().toISOString() })
      // Both predicates, always. `id` alone would update another tenant's row whenever an
      // identifier was guessed or leaked.
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(String(error.message ?? `${table} update failed`));
    return data ?? null;
  }

  private static rows(result: { data: unknown; error: unknown }): any[] {
    if (result.error) throw new Error(String((result.error as { message?: string }).message ?? 'query failed'));
    return (result.data ?? []) as any[];
  }

  /* ---- vendors ---- */

  async createVendor(tenant: TenantContext, input: VendorInput, actor: string): Promise<Vendor> {
    return toVendor(await this.insertRow(VENDORS, tenant, {
      display_name: input.displayName.trim(),
      gstin: input.gstin?.trim() || null,
      contact_ref: input.contactRef?.trim() || null,
      payment_terms_days: input.paymentTermsDays ?? null,
      notes: input.notes?.trim() || null,
      created_by: actor,
    }));
  }

  async listVendors(tenant: TenantContext, status?: EntityStatus): Promise<Vendor[]> {
    let query = this.scoped(VENDORS, tenant);
    if (status) query = query.eq('status', status);
    return SupabaseFinanceRepository.rows(await query.order('display_name')).map(toVendor);
  }

  async getVendor(tenant: TenantContext, id: string): Promise<Vendor | null> {
    const { data, error } = await this.scoped(VENDORS, tenant).eq('id', id).maybeSingle();
    if (error) throw new Error(String(error.message ?? 'vendor read failed'));
    return data ? toVendor(data) : null;
  }

  async setVendorStatus(
    tenant: TenantContext, id: string, status: EntityStatus,
  ): Promise<Vendor | null> {
    const row = await this.updateRow(VENDORS, tenant, id, { status });
    return row ? toVendor(row) : null;
  }

  /* ---- bills ---- */

  async createBill(tenant: TenantContext, input: BillInput, actor: string): Promise<Bill> {
    return toBill(await this.insertRow(BILLS, tenant, {
      vendor_id: input.vendorId,
      bill_reference: input.billReference.trim(),
      bill_date: input.billDate,
      due_date: input.dueDate ?? null,
      attribution: input.attribution.kind,
      property_id: input.attribution.kind === 'PROPERTY' ? input.attribution.propertyId : null,
      amount_minor: input.amount,
      tax_minor: input.tax ?? 0,
      currency: input.currency ?? DEFAULT_CURRENCY,
      description: input.description?.trim() || null,
      created_by: actor,
    }));
  }

  async listBills(tenant: TenantContext, filter: ObligationFilter = {}): Promise<Bill[]> {
    let query = this.scoped(BILLS, tenant);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.propertyId) query = query.eq('property_id', filter.propertyId);
    if (filter.from) query = query.gte('bill_date', filter.from);
    if (filter.to) query = query.lte('bill_date', filter.to);
    return SupabaseFinanceRepository.rows(
      await query.order('bill_date', { ascending: false }),
    ).map(toBill);
  }

  async getBill(tenant: TenantContext, id: string): Promise<Bill | null> {
    const { data, error } = await this.scoped(BILLS, tenant).eq('id', id).maybeSingle();
    if (error) throw new Error(String(error.message ?? 'bill read failed'));
    return data ? toBill(data) : null;
  }

  async voidBill(
    tenant: TenantContext, id: string, actor: string, reason: string,
  ): Promise<Bill | null> {
    const row = await this.updateRow(BILLS, tenant, id, {
      status: 'VOID', voided_at: new Date().toISOString(), voided_by: actor, void_reason: reason,
    });
    return row ? toBill(row) : null;
  }

  /* ---- receivables ---- */

  async createReceivable(
    tenant: TenantContext, input: ReceivableInput, actor: string,
  ): Promise<Receivable> {
    return toReceivable(await this.insertRow(RECEIVABLES, tenant, {
      counterparty: input.counterparty.trim(),
      booking_ref: input.bookingRef?.trim() || null,
      reference: input.reference.trim(),
      issued_date: input.issuedDate,
      due_date: input.dueDate ?? null,
      attribution: input.attribution.kind,
      property_id: input.attribution.kind === 'PROPERTY' ? input.attribution.propertyId : null,
      amount_minor: input.amount,
      tax_minor: input.tax ?? 0,
      currency: input.currency ?? DEFAULT_CURRENCY,
      description: input.description?.trim() || null,
      created_by: actor,
    }));
  }

  async listReceivables(
    tenant: TenantContext, filter: ObligationFilter = {},
  ): Promise<Receivable[]> {
    let query = this.scoped(RECEIVABLES, tenant);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.propertyId) query = query.eq('property_id', filter.propertyId);
    if (filter.from) query = query.gte('issued_date', filter.from);
    if (filter.to) query = query.lte('issued_date', filter.to);
    return SupabaseFinanceRepository.rows(
      await query.order('issued_date', { ascending: false }),
    ).map(toReceivable);
  }

  async getReceivable(tenant: TenantContext, id: string): Promise<Receivable | null> {
    const { data, error } = await this.scoped(RECEIVABLES, tenant).eq('id', id).maybeSingle();
    if (error) throw new Error(String(error.message ?? 'receivable read failed'));
    return data ? toReceivable(data) : null;
  }

  async voidReceivable(
    tenant: TenantContext, id: string, actor: string, reason: string,
  ): Promise<Receivable | null> {
    const row = await this.updateRow(RECEIVABLES, tenant, id, {
      status: 'VOID', voided_at: new Date().toISOString(), voided_by: actor, void_reason: reason,
    });
    return row ? toReceivable(row) : null;
  }

  /* ---- payments ---- */

  async createPayment(
    tenant: TenantContext, input: PaymentInput, actor: string,
  ): Promise<Payment> {
    return toPayment(await this.insertRow(PAYMENTS, tenant, {
      direction: input.direction,
      amount_minor: input.amount,
      currency: input.currency ?? DEFAULT_CURRENCY,
      paid_on: input.paidOn,
      bill_id: input.billId ?? null,
      receivable_id: input.receivableId ?? null,
      attribution: input.attribution.kind,
      property_id: input.attribution.kind === 'PROPERTY' ? input.attribution.propertyId : null,
      account_ref: input.accountRef?.trim() || null,
      method_ref: input.methodRef?.trim() || null,
      cashflow_ref: input.cashflowRef?.trim() || null,
      external_ref: input.externalRef?.trim() || null,
      notes: input.notes?.trim() || null,
      status: 'DRAFT',
      created_by: actor,
    }));
  }

  async listPayments(tenant: TenantContext, filter: PaymentFilter = {}): Promise<Payment[]> {
    let query = this.scoped(PAYMENTS, tenant);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.direction) query = query.eq('direction', filter.direction);
    if (filter.propertyId) query = query.eq('property_id', filter.propertyId);
    if (filter.from) query = query.gte('paid_on', filter.from);
    if (filter.to) query = query.lte('paid_on', filter.to);
    return SupabaseFinanceRepository.rows(
      await query.order('paid_on', { ascending: false }),
    ).map(toPayment);
  }

  async getPayment(tenant: TenantContext, id: string): Promise<Payment | null> {
    const { data, error } = await this.scoped(PAYMENTS, tenant).eq('id', id).maybeSingle();
    if (error) throw new Error(String(error.message ?? 'payment read failed'));
    return data ? toPayment(data) : null;
  }

  async transitionPayment(
    tenant: TenantContext, id: string, next: PaymentStatus, actor: string,
  ): Promise<Payment | null> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: next };
    if (next === 'APPROVED') { patch.approved_by = actor; patch.approved_at = now; }
    if (next === 'POSTED') { patch.posted_at = now; }
    const row = await this.updateRow(PAYMENTS, tenant, id, patch);
    return row ? toPayment(row) : null;
  }

  async paymentsFor(
    tenant: TenantContext, target: { billId: string } | { receivableId: string },
  ): Promise<Payment[]> {
    // Tenant first (from `scoped`), target second. The other order would compute a balance
    // from another customer's payments the moment an identifier collided or leaked.
    const query = 'billId' in target
      ? this.scoped(PAYMENTS, tenant).eq('bill_id', target.billId)
      : this.scoped(PAYMENTS, tenant).eq('receivable_id', target.receivableId);
    return SupabaseFinanceRepository.rows(await query).map(toPayment);
  }

  /* ---- periods ---- */

  async getPeriod(tenant: TenantContext, periodStart: string): Promise<AccountingPeriod | null> {
    const { data, error } = await this.scoped(PERIODS, tenant)
      .eq('period_start', periodStart).maybeSingle();
    if (error) throw new Error(String(error.message ?? 'period read failed'));
    return data ? toPeriod(data) : null;
  }

  async listPeriods(tenant: TenantContext): Promise<AccountingPeriod[]> {
    return SupabaseFinanceRepository.rows(
      await this.scoped(PERIODS, tenant).order('period_start', { ascending: false }),
    ).map(toPeriod);
  }

  async closePeriod(
    tenant: TenantContext, periodStart: string, actor: string,
  ): Promise<AccountingPeriod> {
    const { tenantId } = requireTenant(tenant, 'closePeriod');
    const { data, error } = await this.client
      .from(PERIODS)
      .upsert({
        tenant_id: tenantId,
        period_start: periodStart,
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
        closed_by: actor,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,period_start' })
      .select('*')
      .single();
    if (error) throw new Error(String(error.message ?? 'period close failed'));
    return toPeriod(data);
  }

  async reopenPeriod(
    tenant: TenantContext, periodStart: string, actor: string, reason: string,
  ): Promise<AccountingPeriod | null> {
    const { tenantId } = requireTenant(tenant, 'reopenPeriod');
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from(PERIODS)
      .update({
        status: 'OPEN', reopened_at: now, reopened_by: actor, reopen_reason: reason,
        updated_at: now,
      })
      .eq('tenant_id', tenantId)
      .eq('period_start', periodStart)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(String(error.message ?? 'period reopen failed'));
    return data ? toPeriod(data) : null;
  }
}

/* ------------------------------------------------------------------ *
 * Row → domain
 *
 * Money goes through `paiseFromDatabase`, which refuses anything that is not an exact
 * integer. A `bigint` column arrives from the driver as a string; reading it with `Number`
 * directly would be the one place a float could re-enter this domain.
 * ------------------------------------------------------------------ */

function toVendor(row: any): Vendor {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    displayName: String(row.display_name),
    gstin: row.gstin ?? null,
    contactRef: row.contact_ref ?? null,
    paymentTermsDays: row.payment_terms_days ?? null,
    status: row.status as EntityStatus,
    notes: row.notes ?? null,
    createdAt: String(row.created_at),
  });
}

function toBill(row: any): Bill {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    vendorId: String(row.vendor_id),
    reference: String(row.bill_reference),
    billDate: String(row.bill_date),
    dueDate: row.due_date ?? null,
    attribution: attributionFromRow(String(row.attribution), row.property_id ?? null),
    amount: paiseFromDatabase(row.amount_minor, 'bill.amount'),
    tax: paiseFromDatabase(row.tax_minor ?? 0, 'bill.tax'),
    currency: (row.currency ?? DEFAULT_CURRENCY) as CurrencyCode,
    status: row.status as ObligationStatus,
    description: row.description ?? null,
    createdAt: String(row.created_at),
  });
}

function toReceivable(row: any): Receivable {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    counterparty: String(row.counterparty),
    bookingRef: row.booking_ref ?? null,
    reference: String(row.reference),
    issuedDate: String(row.issued_date),
    dueDate: row.due_date ?? null,
    attribution: attributionFromRow(String(row.attribution), row.property_id ?? null),
    amount: paiseFromDatabase(row.amount_minor, 'receivable.amount'),
    tax: paiseFromDatabase(row.tax_minor ?? 0, 'receivable.tax'),
    currency: (row.currency ?? DEFAULT_CURRENCY) as CurrencyCode,
    status: row.status as ObligationStatus,
    description: row.description ?? null,
    createdAt: String(row.created_at),
  });
}

function toPayment(row: any): Payment {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    direction: row.direction,
    amount: paiseFromDatabase(row.amount_minor, 'payment.amount') as Paise,
    currency: (row.currency ?? DEFAULT_CURRENCY) as CurrencyCode,
    paidOn: String(row.paid_on),
    billId: row.bill_id ?? null,
    receivableId: row.receivable_id ?? null,
    attribution: attributionFromRow(String(row.attribution), row.property_id ?? null),
    accountRef: row.account_ref ?? null,
    methodRef: row.method_ref ?? null,
    cashflowRef: row.cashflow_ref ?? null,
    externalRef: row.external_ref ?? null,
    status: row.status as PaymentStatus,
    reversesId: row.reverses_id ?? null,
    notes: row.notes ?? null,
    createdBy: row.created_by ?? null,
    approvedBy: row.approved_by ?? null,
    createdAt: String(row.created_at),
  });
}

function toPeriod(row: any): AccountingPeriod {
  return Object.freeze({
    tenantId: String(row.tenant_id),
    periodStart: String(row.period_start),
    status: row.status,
    closedAt: row.closed_at ?? null,
    closedBy: row.closed_by ?? null,
    reopenedAt: row.reopened_at ?? null,
    reopenedBy: row.reopened_by ?? null,
    reopenReason: row.reopen_reason ?? null,
  });
}
