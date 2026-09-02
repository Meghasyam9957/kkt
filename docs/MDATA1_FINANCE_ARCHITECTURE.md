# M-DATA-1 — the finance foundation

What MAKAM's finance domain is, where each fact lives, and what was deliberately not built.

Written at the close of M-DATA-1. §1–§11 are implemented; §12 onward is recorded so it is
decided rather than drifted into.

---

## 1 · The scope rule, amended

Migration `0001` opened with a rule that `0003` restated and `0004`/`0005` kept:

> SCOPE RULE (non-negotiable): this database holds NO business data. … If this database
> were wiped, nothing about the business would be lost — only identity and history.

**`0006` breaks it, deliberately, and says so in its own banner.** `finance_vendors`,
`finance_bills`, `finance_receivables` and `finance_payments` are business data. The
amended rule, which every later migration should be read against:

> The V1 workbook remains the authority for every financial fact it already records. This
> database additionally holds the **relational** finance facts a spreadsheet cannot
> express: entities with identity, documents with a lifecycle, and obligations with a
> running balance. A fact lives in exactly one of the two. Where they touch, the workbook
> wins and this database holds a reference to it.

The test for a finance table is no longer "is it business data" but **"can the workbook
express this fact correctly, and does it already?"**

---

## 2 · Data ownership

### Stays in the workbook — untouched

| Sheet | Why it stays |
|---|---|
| `05_REVENUE` | Owns revenue recognition. `NetRevenue` is a workbook formula. |
| `06_EXPENSES` | Already carries Vendor, Tax, PaymentMethod, PaymentStatus, PaidDate, ExpenseType, InvoiceRef, ApprovedBy. `TotalAmount` is a formula. |
| `07_CAPEX_SETUP` | `TotalCost` is a formula. |
| `08_RENT_FIXED_COSTS` | `NextDueDate` and `PaymentStatus` are formulas. |
| `09_CASH_FLOW` | **This is the money journal** — MoneyIn/MoneyOut/Account/PaymentMethod/ReconStatus, with `RunningBalance` as a formula. |
| `10_MONTHLY_PNL` | A row-addressed report. `OperatingProfit` and `OperatingMarginPct` are formulas, and the sheet is in `READ_ONLY_SHEETS`. |
| `11`/`12` investors | The distribution waterfall, entirely in formulas. |
| `04_RESERVATIONS` | **The OTA payout chain**: `GrossBookingValue → EstPlatformFee → ExpectedPayout → ActualPayout → PayoutVariance → PayoutStatus`, all formulas. |

Copying any of it would create a second source of truth and put this application in the
business of recomputing figures a workbook formula owns — the exact failure the contract
layer exists to prevent.

### Moved to Postgres — five tables

| Table | The fact the workbook cannot hold |
|---|---|
| `finance_vendors` | A vendor with **identity**. `06_EXPENSES.Vendor` is free text: two spellings are two vendors, and there is nowhere for terms or a GSTIN. |
| `finance_bills` | A payable with a **due date and a running balance**. |
| `finance_receivables` | The same, owed inward. |
| `finance_payments` | A settlement **event with a lifecycle and an approver**. A cash-flow row records that money moved; it cannot record that ₹8,000 of a ₹20,000 bill is settled, nor that one person raised it and another approved it. |
| `finance_periods` | A month that can **refuse a write**. `18_MONTHLY_CLOSE` is a review checklist with a calculated status; a checkbox cannot decline anything. |

**The evidence that payables and receivables were missing rather than speculative** is in
the close checklist itself: `18_MONTHLY_CLOSE` carries `PayablesReviewed` **and**
`ReceivablesReviewed` as separate lines. The business already reviews both every month,
against no register at all — and the fact that they are separate lines from
`OtaPayoutsReconciled` is why a receivable here is *not* an OTA payout.

### Object storage — deferred, not designed away

Receipts, invoices, bills and proof documents belong in tenant-prefixed object storage. No
bucket is provisioned, so no attachment table was created: a metadata table nothing can
write to is a schema for a feature that does not exist. `06_EXPENSES.DriveLink` and
`07_CAPEX.DriveLink` remain the interim answer. The shape when it lands:
`{id, tenant_id, object_type, object_id, storage_key, mime_type, size_bytes, created_by}`,
with `storage_key` tenant-prefixed so a mis-scoped read is a miss rather than a hit.

---

## 3 · Money

**Integer minor units — paise — in `bigint`, with a branded `Paise` type in TypeScript.**
One module owns the boundary: [`lib/server/finance/money.ts`](../lib/server/finance/money.ts).

Why not `numeric(14,2)`, which would round-trip the workbook's rupee figures without
reinterpretation? Because `numeric` reaches JavaScript as a string or a float, and the
moment it becomes a float the guarantee is gone — there would be no line at which the
value stopped being floating point. Paise in a JS `number` is exact integer arithmetic up
to 2^53 (₹90,071 crore, checked rather than assumed), and every operation here is integer
addition, subtraction or comparison.

Two functions are the *only* places rupees and paise meet: `rupeesToPaise` (which
**refuses** more than two decimal places rather than rounding them away) and
`paiseToRupeesForDisplay` (named so the warning is in the name). `paiseFromDatabase`
refuses anything that is not an exact integer, because a `bigint` column arriving as a
string is where a float would otherwise re-enter.

Every amount carries `currency`. One currency is configured; the column exists so that
stays a fact about the data rather than an assumption in the code.

**Money is never divided in this domain.** Allocation of a corporate cost across
properties would require one, and there is no approved rounding rule, so allocation is not
modelled (§12).

---

## 4 · Payment ≠ revenue ≠ expense

The distinction the whole design rests on:

| | Question | Home | Date |
|---|---|---|---|
| **Revenue** | What did we earn? | `05_REVENUE` | When it was earned |
| **Expense** | What did it cost? | `06_EXPENSES` | When it was incurred |
| **Payment** | Did money actually move? | `finance_payments` | When it settled |

An OTA booking earns revenue in March and pays out in April, less commission — three
facts, three dates, three amounts. Nothing in this module treats a payment as revenue, and
nothing derives one from the other.

---

## 5 · Transaction lifecycle

```
DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──post──▶ POSTED ──▶ REVERSED
  │                      │                          │
  └────────────────── void ─────────────────────────┴──▶ VOIDED
```

**There is no delete, anywhere.** `VOIDED` cancels something that never took effect;
`REVERSED` undoes something that did, by appending a new payment that points at it.
`VOIDED` and `REVERSED` are terminal, so a correction is always a new record.

Two rules the state machine alone would not give:

- **Only `POSTED` settles anything.** A payment awaiting approval has not moved money, and
  counting it would report a bill as paid before anybody paid it.
- **Self-approval is refused.** A payment must be approved by someone other than whoever
  raised it. `finance.approve` is a separate capability so a deployment can also separate
  the people; the service refuses it regardless.

**Balances are never stored.** Whether a bill is part-paid is arithmetic over its posted
payments, so a stored `SETTLED` that disagrees with the payment rows is unrepresentable
rather than merely unlikely. Overpayment is **surfaced**, not clamped: `Math.max(0, …)`
would hide the duplicate payment that caused it.

---

## 6 · Tenant enforcement

```
authenticated user → verified membership → tenant → finance capability
    → tenant-scoped repository → property scope → field projection
```

The workbook made cross-tenant leakage structurally hard: one workbook per tenant means
another customer's rows are not in the file you opened. **Postgres removes that
protection** — every tenant's bills sit in one table, and the only thing between customer
A and customer B is a predicate.

So the predicate is made structural. **Every repository method takes a `TenantContext` as
its first argument and none has an overload that omits it.** In the Supabase twin, exactly
two private helpers touch the database (`scoped()` and `insertRow()`) and both apply the
tenant themselves — there is no method that assembles its own query, so there is no method
that can forget. `tenant_id` is stamped **last** in every insert, so a caller-supplied one
is overwritten rather than honoured. Every update carries *both* `tenant_id` and `id`.

**A foreign identifier is a miss, not a refusal.** `getBill(tenant, id)` filters by both,
so another tenant's bill id produces `NOT_FOUND` — byte-identical to a bill that never
existed. The isolation suite asserts the two responses are the same status, code *and*
message, which is what closes the enumeration oracle.

**The test harness shares ONE repository between both tenants**
([`tests/finance-isolation.test.ts`](../tests/finance-isolation.test.ts)). A harness that
gave each tenant its own store would pass every case while proving only that two Maps are
two Maps.

---

## 7 · Property scope

A cost belongs to one property **or to the business**. `Attribution` is a discriminated
union rather than a nullable field, so "corporate" is a state the compiler understands
rather than an absence a reader has to interpret. Forcing every cost onto a property is
how corporate overhead silently lands on whichever property sorts first.

Property references are `text`, not foreign keys — properties live in the tenant's own
workbook. **That is what makes the check safe**: `assertPropertyIsOwn` validates against
the caller's own `getPropertyIds()`, resolved through the tenant workbook registry. Naming
another tenant's property is refused *identically* to naming one that does not exist — not
because the answers were made to match, but because the question is never asked of another
tenant's data.

---

## 8 · RBAC and field-level security

| Capability | SUPER_ADMIN | ADMIN | OPERATIONS | INVESTOR |
|---|:-:|:-:|:-:|:-:|
| `finance.read` | ✔ | ✔ | | |
| `finance.write` | ✔ | ✔ | | |
| `finance.approve` | ✔ | ✔ | | |
| `finance.period.manage` | ✔ | | | |

`finance.period.manage` is **deliberately withheld from ADMIN**: reopening a closed month
is the act that most needs a second pair of hands, and it is recorded with an actor and a
reason when it happens.

All four are listed in `FINANCIAL_CAPABILITIES`, which is what makes the *existing*
security suite cover them — "OPERATIONS holds no financial capability" was written before
finance existed and now guards it for free.

**Projections, not rows.** Nothing spreads a record: every view model is a fresh object
literal, and compile-time `Disjoint` guards refuse to build if `tenantId`, `createdBy`,
`approvedBy` or `reversesId` is ever added to one. The suite additionally asserts the
**rendered response** for every finance route as OPERATIONS — capability tables and
rendered data have disagreed in this project's history, so both are checked.

Money crosses as minor units plus a currency, never as a formatted string: a number
rounded for display cannot be added up again.

---

## 9 · Idempotency

Finance writes reuse the **same tenant-aware operation store** the workbook mutations use.
A retried payment does not become two payments; two concurrent identical requests produce
one row; and an operation id presented by another tenant is a `mismatch` — checked before
the request hash, so it reveals nothing about the other tenant's operation.

---

## 10 · Audit

Every finance write records actor, tenant, action, entity type, entity id, result and the
operation id — **and nothing else**. A finance payload carries amounts, counterparties and
references; a copy of it in the audit log would be a second place to leak it from. What
happened is recoverable from the record itself, which is tenant-scoped.

---

## 11 · Reporting semantics

`FinanceService.position()` reports **only what this ledger knows**: payables outstanding,
receivables outstanding, and money settled in/out from POSTED payments.

It is **not** a P&L and **not** a cash-flow statement, and is labelled accordingly on
screen:

- **Operating result** comes from `10_MONTHLY_PNL` via `provider.getPnl()`, where the
  workbook's formulas own it. A second operating result computed here would be a second
  answer. Its exclusions are the workbook's: depreciation, statutory tax treatment,
  financing costs and owner distributions are not in it.
- **Cash position** comes from `09_CASH_FLOW`, with `RunningBalance` as a workbook
  formula. "Settled through the finance ledger" is a narrower figure and says so.

An empty ledger reports **zero outstanding**, which is a fact — nobody is owed anything —
not `INSUFFICIENT_DATA`. That reason is reserved for a figure that could not be computed;
this one always can.

---

## 12 · Deliberately not built

| | Why |
|---|---|
| Expense / revenue tables | The workbook owns those facts. |
| A general ledger | `09_CASH_FLOW` is the journal. Double-entry is a statutory accounting decision nobody has made. |
| Expense categories, accounts, payment methods | `02_SETTINGS` supplies the vocabulary as list-ranges. A second list drifts from the first. |
| Budgets | No budget concept exists anywhere. Nothing would read it. |
| Reconciliation | Needs a bank statement to reconcile against. No banking integration exists or is configured, and a fake one would be worse than none. The foundation it needs — `finance_payments.cashflow_ref` — is in place. |
| Corporate cost allocation | Needs a driver (revenue share? night share? equal split?) that nobody has chosen, and a rounding rule for the division. |
| Units / property hierarchy | Deferred by M-SAAS-1, blocked on a business decision about what a "property" is. |
| Tax calculation and filing | **A future controlled module.** `tax_minor` and `gstin` are recorded; no rule follows from them. Storing a GSTIN is not a claim to validate it, and nothing here computes GST. |
| Owner statements | The investor model is not an ownership model. `UI9_OWNER_DECISIONS.md` records that gap; nothing here invents one. |

---

## 13 · One decision this milestone did not make

**Cash-basis versus accrual-basis accounting has not been decided, and was not guessed.**

The foundation does not require it: revenue recognition stays in the workbook, and
payments record settlement only, so the two are already separate facts on separate dates.
The question becomes live the moment someone asks for a *combined* statement — "what did
we make in May?" has two defensible answers, and they differ by exactly the receivables
and payables this milestone introduces.

Related, and equally not decided: **whether a guest advance is revenue or a liability**.
The design sidesteps it — an advance is a `finance_payments` row and a
`finance_receivables` settlement, and neither claims to be revenue. Recognition remains
the workbook's.

Both are business decisions. Neither blocks anything built here.

---

## 14 · What M-HR-1 inherits

The stated goal of this milestone was a boundary strong enough that payroll can post costs
into finance without redesigning it. Concretely, M-HR-1 gets:

- **`tenant_id` on every table, and a repository that cannot be called without one.** An
  `employees` table follows the same pattern; the isolation suite extends rather than
  restarts.
- **A vendor-shaped precedent for an employee master** — an entity with identity, status
  and tenant-scoped uniqueness.
- **The payables model for salary.** A payroll run is a set of obligations with due dates
  settled by payments; that is exactly `finance_bills` + `finance_payments`, and a salary
  payable needs a `employee_id` column rather than a new table.
- **The period lock.** Payroll dated into a closed month is refused by machinery that
  already exists.
- **Approval separation.** Raising and approving are already distinct capabilities with a
  self-approval refusal — which matters more for salary than for a utility bill.

The one thing M-HR-1 must add rather than inherit is **field-level sensitivity for salary**.
Finance projections withhold `tenantId` and actor fields; salary needs a stricter rule,
because an ADMIN who may see a utility bill is not automatically someone who may see a
colleague's pay. That belongs in the same `Disjoint`-guarded projection layer, with its own
withheld list.
