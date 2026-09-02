import '@/lib/server/only';
/**
 * THE FINANCE DOMAIN.
 *
 * Three facts, kept apart on purpose, because conflating any two of them is the commonest
 * financial modelling error in hospitality software:
 *
 *   REVENUE   a stay was sold        — 05_REVENUE, in the workbook, when it was EARNED
 *   EXPENSE   a cost was incurred    — 06_EXPENSES, in the workbook, when it was INCURRED
 *   PAYMENT   money actually moved   — here, when it SETTLED, and against what
 *
 * An OTA booking earns revenue in March and pays out in April, less commission. Three
 * dates, three amounts, three different questions. Nothing in this module treats a
 * payment as revenue, and nothing derives one from the other.
 *
 * What lives here is what the workbook cannot express: entities with identity, documents
 * with a lifecycle, and obligations with a running balance. What does NOT live here is any
 * fact the workbook already owns — see supabase/migrations/0006_finance_foundation.sql
 * for the full list and the reasoning.
 */
import type { Paise, CurrencyCode } from './money';

/* ------------------------------------------------------------------ *
 * Attribution — a cost belongs to a property, or to the business
 * ------------------------------------------------------------------ */

/**
 * Not every cost belongs to a property.
 *
 * Software licences, professional fees and platform overhead belong to the business as a
 * whole. Forcing them onto a property is how corporate overhead silently lands on
 * whichever property happens to sort first — and then shows up in that property's
 * profitability as if it were a cost of running it.
 *
 * A discriminated union rather than a nullable field, so "corporate" is a state the
 * compiler understands rather than an absence a reader has to interpret. Allocation of a
 * corporate cost ACROSS properties is deliberately not modelled: it needs a driver
 * (revenue share? night share? equal split?) that nobody has chosen.
 */
export type Attribution =
  | { readonly kind: 'PROPERTY'; readonly propertyId: string }
  | { readonly kind: 'CORPORATE' };

export const CORPORATE: Attribution = Object.freeze({ kind: 'CORPORATE' as const });

export function propertyAttribution(propertyId: string): Attribution {
  return Object.freeze({ kind: 'PROPERTY' as const, propertyId });
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * A payment's life. There is no DELETE: a payment that should not have existed is VOIDED,
 * and one that took effect and must be undone is REVERSED by a new payment that points at
 * it. Financial history is append-only, so the question "what did we believe on the 14th?"
 * always has an answer.
 */
export const PAYMENT_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'VOIDED', 'REVERSED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The only transitions that exist. Anything else is refused by name, so an invalid move
 * produces a sentence an operator can act on rather than a silently wrong state.
 *
 * POSTED is not terminal only because a posted payment can still be REVERSED — which is
 * an append, not an edit. VOIDED and REVERSED are terminal.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  Object.freeze({
    DRAFT: ['PENDING_APPROVAL', 'VOIDED'],
    PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'VOIDED'],
    APPROVED: ['POSTED', 'VOIDED'],
    POSTED: ['REVERSED'],
    VOIDED: [],
    REVERSED: [],
  });

/** Only a POSTED payment has moved money, so only a POSTED payment settles anything. */
export function countsTowardSettlement(status: PaymentStatus): boolean {
  return status === 'POSTED';
}

export type PaymentDirection = 'INCOMING' | 'OUTGOING';

/**
 * A bill or receivable has no settlement status of its own. Whether it is part-paid or
 * settled is ARITHMETIC over its posted payments — a stored `SETTLED` that disagrees with
 * the payment rows is the classic finance defect, and it is unrepresentable if the state
 * is never stored. OPEN and VOID are the only lifecycle an obligation has.
 */
export type ObligationStatus = 'OPEN' | 'VOID';

export type EntityStatus = 'ACTIVE' | 'INACTIVE';
export type PeriodStatus = 'OPEN' | 'CLOSED';

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

export interface Vendor {
  readonly id: string;
  readonly tenantId: string;
  readonly displayName: string;
  /** Format-checked only. Recording the number is not a claim to implement GST. */
  readonly gstin: string | null;
  /** A desk contact. Never a bank account, never a credential. */
  readonly contactRef: string | null;
  /** Net days. Null means "not agreed", which is not the same as zero. */
  readonly paymentTermsDays: number | null;
  readonly status: EntityStatus;
  readonly notes: string | null;
  readonly createdAt: string;
}

interface ObligationBase {
  readonly id: string;
  readonly tenantId: string;
  readonly reference: string;
  readonly dueDate: string | null;
  readonly attribution: Attribution;
  readonly amount: Paise;
  readonly tax: Paise;
  readonly currency: CurrencyCode;
  readonly status: ObligationStatus;
  readonly description: string | null;
  readonly createdAt: string;
}

/** What this tenant owes. A payable. */
export interface Bill extends ObligationBase {
  readonly vendorId: string;
  readonly billDate: string;
}

/** What others owe this tenant. A receivable. */
export interface Receivable extends ObligationBase {
  /** A guest, an OTA, a corporate account — free text. There is no guest entity. */
  readonly counterparty: string;
  /** The workbook booking this arises from, when it arises from one. */
  readonly bookingRef: string | null;
  readonly issuedDate: string;
}

export interface Payment {
  readonly id: string;
  readonly tenantId: string;
  readonly direction: PaymentDirection;
  readonly amount: Paise;
  readonly currency: CurrencyCode;
  readonly paidOn: string;
  readonly billId: string | null;
  readonly receivableId: string | null;
  readonly attribution: Attribution;
  /** The workbook vocabulary ("HDFC Current", "UPI"), never an account number. */
  readonly accountRef: string | null;
  readonly methodRef: string | null;
  /** The 09_CASH_FLOW TxnID this movement was recorded as. The reconciliation join. */
  readonly cashflowRef: string | null;
  readonly externalRef: string | null;
  readonly status: PaymentStatus;
  readonly reversesId: string | null;
  readonly notes: string | null;
  readonly createdBy: string | null;
  readonly approvedBy: string | null;
  readonly createdAt: string;
}

export interface AccountingPeriod {
  readonly tenantId: string;
  /** The first day of the month it names. */
  readonly periodStart: string;
  readonly status: PeriodStatus;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly reopenedAt: string | null;
  readonly reopenedBy: string | null;
  readonly reopenReason: string | null;
}

/* ------------------------------------------------------------------ *
 * Derived views
 * ------------------------------------------------------------------ */

/**
 * An obligation with its balance worked out.
 *
 * `settled` sums the POSTED payments against it and nothing else — a payment awaiting
 * approval has not moved money, and counting it would report a bill as paid before
 * anybody paid it. `outstanding` is exact integer subtraction; it can never drift from
 * the payments because it is never stored.
 *
 * `overpaid` is surfaced rather than clamped. A bill with more settled against it than it
 * is worth is a real event (a duplicate payment, or a payment attached to the wrong bill)
 * and hiding it behind `Math.max(0, …)` would hide the error that caused it.
 */
export interface ObligationBalance {
  readonly amount: Paise;
  readonly settled: Paise;
  readonly outstanding: Paise;
  readonly overpaid: boolean;
  readonly currency: CurrencyCode;
}

export interface BillWithBalance extends Bill { readonly balance: ObligationBalance }
export interface ReceivableWithBalance extends Receivable { readonly balance: ObligationBalance }

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

export class FinanceError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FinanceError';
  }
}

/**
 * Not found, or not yours — the SAME refusal, deliberately.
 *
 * A different answer for "no such bill" and "that bill belongs to someone else" is an
 * existence oracle: it lets one tenant enumerate another tenant's identifiers by watching
 * which ones answer differently. Every lookup in this domain carries the tenant predicate,
 * so a foreign id is simply a miss, and this is the only refusal either produces.
 */
export function notFound(what: string): FinanceError {
  return new FinanceError(404, 'NOT_FOUND', `No such ${what}.`);
}

export function refuse(code: string, message: string, status = 422): FinanceError {
  return new FinanceError(status, code, message);
}
