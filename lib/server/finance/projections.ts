import '@/lib/server/only';
/**
 * WHAT A ROLE MAY SEE OF A FINANCE RECORD.
 *
 * A database row is not a view model. Returning one to a client returns whatever the
 * schema happens to hold — including columns added later by someone who was not thinking
 * about who reads them, which is how field-level leaks arrive long after a review passed.
 *
 * So nothing here spreads a record. Every projection is a fresh object literal listing
 * exactly the fields that role gets, and the compile-time `Disjoint` guards at the foot of
 * the file refuse to build if a withheld field is ever added to a projected type. That is
 * the same mechanism `lib/data/views/role-projections.ts` uses for the operational booking
 * views, and it is used here for the same reason: a reviewer can miss a new field, and a
 * compiler cannot.
 *
 * Three audiences, and the differences are deliberate:
 *
 *   FINANCE (finance.read)    the record, including amounts, counterparties and approvals.
 *   OPERATIONS               nothing at all. OPERATIONS holds no finance capability, and
 *                            `FINANCIAL_CAPABILITIES` now lists the finance ones so the
 *                            existing security suite proves it. There is no partial
 *                            operational view of a payment, because there is no operational
 *                            question a payment answers.
 *   THE BROWSER              never an internal id it does not need, never a tenant id, and
 *                            never `createdBy`/`approvedBy` beyond a display name — see
 *                            `FinancePaymentView` for what actually crosses.
 *
 * MONEY CROSSES AS MINOR UNITS plus a currency, never as a formatted string and never as a
 * float. Formatting is the client's job (`formatCurrency`), and a number that has already
 * been rounded for display is a number that cannot be added up again.
 */
import type {
  Vendor, Payment, BillWithBalance, ReceivableWithBalance, ObligationBalance, Attribution,
  AccountingPeriod,
} from './types';
import type { FinancePosition } from './service';

/* ------------------------------------------------------------------ *
 * What is withheld
 * ------------------------------------------------------------------ */

/**
 * Fields that must never reach a browser payload.
 *
 * `tenantId` heads the list. A client that knows its own tenant id gains nothing from it
 * and a client that learns another one has an identifier to try — and although every
 * query is tenant-scoped server-side, handing out the key to a door is not made safe by
 * the door being locked.
 */
export const FINANCE_FIELDS_WITHHELD_FROM_CLIENTS = [
  'tenantId', 'createdBy', 'approvedBy', 'reversesId',
] as const;

/* ------------------------------------------------------------------ *
 * Client-facing shapes
 * ------------------------------------------------------------------ */

export interface MoneyView {
  /** Minor units. Exact, addable, and formatted only at the moment of display. */
  readonly minor: number;
  readonly currency: string;
}

export interface AttributionView {
  readonly kind: 'PROPERTY' | 'CORPORATE';
  /** Present only for PROPERTY. The workbook's own PropertyID, which the caller owns. */
  readonly propertyId: string | null;
}

export interface FinanceVendorView {
  readonly id: string;
  readonly displayName: string;
  readonly gstin: string | null;
  readonly contactRef: string | null;
  readonly paymentTermsDays: number | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export interface FinanceBalanceView {
  readonly amount: MoneyView;
  readonly settled: MoneyView;
  readonly outstanding: MoneyView;
  /** Surfaced, never hidden: more settled than owed is an error worth seeing. */
  readonly overpaid: boolean;
}

export interface FinanceBillView {
  readonly id: string;
  readonly vendorId: string;
  readonly reference: string;
  readonly billDate: string;
  readonly dueDate: string | null;
  readonly attribution: AttributionView;
  readonly balance: FinanceBalanceView;
  readonly status: 'OPEN' | 'VOID';
  readonly description: string | null;
}

export interface FinanceReceivableView {
  readonly id: string;
  readonly counterparty: string;
  readonly bookingRef: string | null;
  readonly reference: string;
  readonly issuedDate: string;
  readonly dueDate: string | null;
  readonly attribution: AttributionView;
  readonly balance: FinanceBalanceView;
  readonly status: 'OPEN' | 'VOID';
  readonly description: string | null;
}

export interface FinancePaymentView {
  readonly id: string;
  readonly direction: 'INCOMING' | 'OUTGOING';
  readonly amount: MoneyView;
  readonly paidOn: string;
  readonly billId: string | null;
  readonly receivableId: string | null;
  readonly attribution: AttributionView;
  /** The workbook's own vocabulary ("HDFC Current", "UPI"). Never an account number. */
  readonly accountRef: string | null;
  readonly methodRef: string | null;
  readonly cashflowRef: string | null;
  readonly status: string;
  readonly notes: string | null;
}

export interface FinancePositionView {
  readonly payablesOutstanding: MoneyView;
  readonly receivablesOutstanding: MoneyView;
  readonly settledOut: MoneyView;
  readonly settledIn: MoneyView;
  readonly openBills: number;
  readonly openReceivables: number;
  readonly overdueBills: number;
  readonly overdueReceivables: number;
}

export interface FinancePeriodView {
  readonly periodStart: string;
  readonly status: 'OPEN' | 'CLOSED';
  readonly closedAt: string | null;
  readonly reopenedAt: string | null;
  readonly reopenReason: string | null;
}

/* ------------------------------------------------------------------ *
 * Projections — fresh literals, never a spread
 * ------------------------------------------------------------------ */

function moneyView(minor: number, currency: string): MoneyView {
  return { minor, currency };
}

function attributionView(attribution: Attribution): AttributionView {
  return attribution.kind === 'PROPERTY'
    ? { kind: 'PROPERTY', propertyId: attribution.propertyId }
    : { kind: 'CORPORATE', propertyId: null };
}

function balanceView(balance: ObligationBalance): FinanceBalanceView {
  return {
    amount: moneyView(balance.amount, balance.currency),
    settled: moneyView(balance.settled, balance.currency),
    outstanding: moneyView(balance.outstanding, balance.currency),
    overpaid: balance.overpaid,
  };
}

export function vendorView(vendor: Vendor): FinanceVendorView {
  return {
    id: vendor.id,
    displayName: vendor.displayName,
    gstin: vendor.gstin,
    contactRef: vendor.contactRef,
    paymentTermsDays: vendor.paymentTermsDays,
    status: vendor.status,
  };
}

export function billView(bill: BillWithBalance): FinanceBillView {
  return {
    id: bill.id,
    vendorId: bill.vendorId,
    reference: bill.reference,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    attribution: attributionView(bill.attribution),
    balance: balanceView(bill.balance),
    status: bill.status,
    description: bill.description,
  };
}

export function receivableView(row: ReceivableWithBalance): FinanceReceivableView {
  return {
    id: row.id,
    counterparty: row.counterparty,
    bookingRef: row.bookingRef,
    reference: row.reference,
    issuedDate: row.issuedDate,
    dueDate: row.dueDate,
    attribution: attributionView(row.attribution),
    balance: balanceView(row.balance),
    status: row.status,
    description: row.description,
  };
}

export function paymentView(payment: Payment): FinancePaymentView {
  return {
    id: payment.id,
    direction: payment.direction,
    amount: moneyView(payment.amount, payment.currency),
    paidOn: payment.paidOn,
    billId: payment.billId,
    receivableId: payment.receivableId,
    attribution: attributionView(payment.attribution),
    accountRef: payment.accountRef,
    methodRef: payment.methodRef,
    cashflowRef: payment.cashflowRef,
    status: payment.status,
    notes: payment.notes,
  };
}

export function positionView(position: FinancePosition, currency = 'INR'): FinancePositionView {
  return {
    payablesOutstanding: moneyView(position.payablesOutstanding, currency),
    receivablesOutstanding: moneyView(position.receivablesOutstanding, currency),
    settledOut: moneyView(position.settledOut, currency),
    settledIn: moneyView(position.settledIn, currency),
    openBills: position.openBills,
    openReceivables: position.openReceivables,
    overdueBills: position.overdue.bills,
    overdueReceivables: position.overdue.receivables,
  };
}

export function periodView(period: AccountingPeriod): FinancePeriodView {
  return {
    periodStart: period.periodStart,
    status: period.status,
    closedAt: period.closedAt,
    reopenedAt: period.reopenedAt,
    reopenReason: period.reopenReason,
  };
}

/* ------------------------------------------------------------------ *
 * Compile-time guards
 *
 * If a withheld field is ever added to one of the client-facing types, these are the
 * lines that refuse to compile. Exported so no lint rule ever tidies them away.
 * ------------------------------------------------------------------ */

/** `true` only when T carries no key from F. */
type Disjoint<T, F extends PropertyKey> = Extract<keyof T, F> extends never ? true : never;

type Withheld = (typeof FINANCE_FIELDS_WITHHELD_FROM_CLIENTS)[number];

export const VENDOR_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<FinanceVendorView, Withheld> = true;
export const BILL_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<FinanceBillView, Withheld> = true;
export const RECEIVABLE_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<FinanceReceivableView, Withheld> = true;
export const PAYMENT_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<FinancePaymentView, Withheld> = true;
export const POSITION_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<FinancePositionView, Withheld> = true;
export const PERIOD_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<FinancePeriodView, Withheld> = true;
