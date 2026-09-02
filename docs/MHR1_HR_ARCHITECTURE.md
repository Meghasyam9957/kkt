# M-HR-1 — the people foundation

What MAKAM's workforce domain is, where each fact lives, and what was deliberately not
built. §1–§11 are implemented; §12 onward is recorded so it is decided rather than drifted
into.

---

## 1 · Storage boundary — there was nothing to negotiate

`0006` amended the SCOPE RULE and stated the replacement: the workbook keeps every
financial fact it already records; this database holds the relational facts a spreadsheet
cannot express. **HR falls entirely on this side of that line, and not by preference — by
absence.**

A repository-wide search for `employee`, `staff`, `worker`, `attendance`, `salary`,
`payroll`, `designation`, `department`, `shift` and `overtime` returns nothing: not a sheet
in the 22-sheet contract, not a column, not a domain type, not a route, not a capability.
The two occurrences of "Leave" are the English verb in help text. So `0007` needs no
further amendment, and there is no competing authority anywhere.

| Layer | Holds |
|---|---|
| **Postgres** | employees, departments, designations, shifts, holidays, attendance, leave types/entitlements/requests, overtime, advances, salary structures and components, payroll runs and lines |
| **The workbook** | unchanged. Nothing in `0007` reads or writes a sheet |
| **`finance_payments`** | settlement of payroll lines and advances — two new nullable target columns |
| **Object storage** | employee documents. **Not provisioned; deliberately not modelled** (§12) |

---

## 2 · Employee model, and what it refuses to hold

No date of birth, no gender, no Aadhaar, no PAN, no bank account, no address, no
next-of-kin. Nothing here needs them, and **a column that exists is a column something
eventually writes to.** A test asserts these strings appear in no DDL line.

Bank details are absent even though payroll pays people: a destination account belongs to
whatever payment rail is eventually integrated, under its own security review, not in a row
this application selects with `select *`.

`employee_code` is tenant-scoped, derived from the highest existing code **in the caller's
own tenant**, so it cannot disclose another customer's headcount — proved by a test in which
tenant B's first hire is `EMP-0001` while tenant A is already on `EMP-0002`. The unique
index is the real guard; a concurrent duplicate is refused and a retry succeeds.

**Status is a lifecycle, not a delete flag.** `ACTIVE`, `ON_LEAVE`, `SUSPENDED`,
`NOTICE_PERIOD`, `EXITED`. History depends on people — an exited employee still owns last
quarter's attendance and payslips — so nobody is ever removed. `EXITED` requires a leaving
date and every other status forbids one, enforced in the service and by a check constraint,
so the two can never disagree.

---

## 3 · Attendance

**Statuses:** `PRESENT`, `ABSENT`, `HALF_DAY`, `LEAVE`, `HOLIDAY`, `WEEKLY_OFF`.

**`late` and `early_exit` are FLAGS, not statuses.** Somebody who arrived late was still
present, and a `LATE` status silently removes them from every worked-day count that filters
on `PRESENT`. Flags keep "was he there?" and "was he on time?" as separate questions with
separate answers. A flag on a day nobody attended is refused.

**Uniqueness is two partial indexes, not one constraint:**

```sql
unique (tenant_id, employee_id, attendance_date)            where shift_id is null
unique (tenant_id, employee_id, attendance_date, shift_id)  where shift_id is not null
```

A business that does not roster shifts records one row a day and the first index is the
whole rule. A business that runs split or night shifts records one row per shift, and the
second still stops a shift being entered twice. A single three-column unique would have
made split shifts unrepresentable — and hospitality has them. A single four-column unique
would have allowed unlimited shiftless duplicates, because NULL is distinct from NULL.

**Overnight convention, stated once:** a shift belongs to the date it *starts*. The night
of the 3rd into the 4th is attendance for the 3rd. `crosses_midnight` is explicit rather
than inferred from `end_time < start_time`, and the flag and the times must agree.

**Lifecycle:** `DRAFT → SUBMITTED → APPROVED | REJECTED`. Payroll consumes `APPROVED` and
nothing else, and refuses to calculate while anything in the period is still `SUBMITTED`.

**A missing record is not an absence.** There is no `NOT_RECORDED` status because a day
nobody recorded has no row — see §6, which is the most important paragraph in this document.

---

## 4 · Leave, overtime, advances

**Leave.** Types are tenant-configurable and seeded with nothing; `paid` is a property of
the type because whether casual leave is paid is policy. Balance is
`allocated − approved taken`, with "taken" summed from approved requests and **never
stored** — so no editable magic number exists. Overlapping requests are refused: an overlap
is the same absence counted twice and would be deducted twice. Self-approval is refused;
rejection requires a reason.

**Overtime** is a record of its own, not a column on attendance, because
`hr_attendance.overtime_minutes` is what a clock observed and `hr_overtime` is what a
manager approved to pay. **There is no rate and no multiplier** (§12).

**Advances.** Money out to an employee, recovered later. The outstanding amount is
**computed from recoveries, never stored** — the same rule finance applies to bills. It is
deliberately *not* a `finance_receivables` row: that table's counterparty is free text, so
the link would be by name, and its rows are readable by anyone with `finance.read` — which
would put the staff roster and their borrowing on a finance screen.

---

## 5 · Salary — effective-dated, never overwritten

A raise is a **new row**. The previous open-ended structure is closed the day before the new
one begins, so the history reads as a continuous sequence and "what were we paying in
March?" always has an answer. `salary = 28000` written over `salary = 25000` destroys
exactly that.

Payroll resolves the structure whose range contains the period. Back-dating behind an
existing structure is **refused** rather than resolved by a rule nobody chose — two
structures in force at once would make payroll guess. A partial unique index allows at most
one open-ended structure per employee.

Components are explicit rows, not a JSON blob, so gross and deductions are summed by real
arithmetic and every payslip line is traceable to a named component. **PF, ESI, PT and TDS
are ordinary `DEDUCTION` components with amounts somebody entered** — nothing computes them.

---

## 6 · Payroll — and the one thing it refuses

**Lifecycle: `DRAFT → CALCULATED → APPROVED → POSTED`.** Four states, not six.

- `REVIEW` is not a state; it is what a person does while a run is `CALCULATED`, and a
  state nothing transitions out of programmatically is a label pretending to be a workflow.
- **`PAID` is not a state, and that omission IS the finance integration.** A payroll run
  produces obligations; money moves when finance posts a payment against them. A `PAID`
  payroll status would be a second answer to "has this been paid?", and the wrong one the
  moment one employee's transfer failed.

**What the engine computes exactly:** gross and fixed deductions from the structure in
force; advance recovery, but only what the caller explicitly asked for and capped at what is
actually owed; day counts from approved attendance only.

**What it refuses to invent** — each an unstated policy, and a plausible wrong number on a
payslip is worse than a missing one:

- a loss-of-pay basis for absence (gross ÷ 30? ÷ working days? ÷ calendar days?)
- an overtime rate
- PF / ESI / PT / TDS
- an advance recovery schedule

Absence is therefore **counted and reported**, not priced. A negative net is refused rather
than stored.

### The quietest failure, and why approval refuses

> Payroll is the first thing this product computes whose output is a **payment**, from data
> entered by hand that the rules deliberately permit to be incomplete. Every other failure
> in this milestone is loud. This one is silent by construction: the `PRESENT` rows are
> counted, a plausible total comes out, an approver sees the total and not the gap, and
> money leaves the business.

So `unrecorded_days` is computed per line — days the person was employed, minus days with a
record — and **approval is refused while any line has one**, unless the approver passes
`acknowledgeGaps`, which is carried into the audit trail. A silent omission becomes a
deliberate, attributable act. Calculating is always allowed: looking at the gaps is exactly
what you want to do before deciding.

---

## 7 · Payroll → Finance

`finance_bills` requires `vendor_id NOT NULL`, so a salary obligation **cannot** be a bill.
Three options were considered and two rejected:

| Option | Verdict |
|---|---|
| Each employee is a vendor | **Rejected.** `GET /api/finance/vendors` is open to every `finance.read` holder, so the staff roster becomes a finance read — and `finance_vendors_name_unique` on the display name means two employees called Ramesh Kumar collide. A vendor-uniqueness rule applied to people is simply false. |
| Relax `vendor_id`, add `employee_id` | **Rejected.** A salary row would then be returned by `GET /api/finance/payables`, and excluding it needs a negative predicate on a live read path. A forgotten `where employee_id is null` leaks pay. |
| **Obligation in HR, settlement in finance** | **Chosen.** |

`finance_payments` gains `payroll_line_id` and `employee_advance_id` as nullable targets;
the "at most one target" and "direction matches target" constraints widen to cover them.
Balances, the payment lifecycle, the period lock, idempotency and audit are all finance's
existing ones — there is **one** settlement ledger and one answer to "was this paid?".

**One obligation per employee per run, never one aggregate.** A payment settles one thing,
so part-settlement of an aggregate could not say who was paid.

---

## 8 · Period lock — finance's, reused

`finance_periods` governs payroll and attendance. HR has **no lock of its own**: two lock
tables is how a month comes to be closed in finance and open in HR, and the first anybody
would learn of it is a payslip dated into a closed month. Reopening remains finance's
privileged, audited act.

---

## 9 · Tenant, property and field security

```
authenticated user → verified membership → tenant → HR capability
    → tenant-scoped repository → property scope → field projection
```

**Every repository method takes a `TenantContext` first and none has an overload that omits
it.** In the Postgres twin exactly three helpers touch the database and all apply the tenant
themselves; `tenant_id` is stamped **last** on insert so a caller-supplied one is
overwritten; every update carries both `tenant_id` and `id`; the payroll-line delete carries
both `tenant_id` and `run_id`.

**A foreign identifier is a miss, not a refusal.** The suite asserts that a real
other-tenant id and an id that never existed produce the same status, code *and* message.

**Property and manager references** are validated through the caller's own workbook and the
tenant-scoped repository, so naming another tenant's property or manager is refused
identically to naming a fiction — not because the answers were made to match, but because
the question is never asked of another tenant's data.

**Field security.** One structural property does most of the work: **the employee record
carries no compensation field at all.** Salary lives in `hr_salary_structures`, payroll in
`hr_payroll_lines` — so `employeeView` cannot leak pay even if edited carelessly. Beyond
that: fresh object literals, never a spread, with `Disjoint` compile-time guards for the
withheld list *and* for a pay-shaped field list.

The workforce overview **builds** its money halves only for a compensation reader. A payload
carrying a figure the client is told not to render has already disclosed it.

---

## 10 · RBAC

| Capability | SUPER_ADMIN | ADMIN | OPERATIONS | INVESTOR |
|---|:-:|:-:|:-:|:-:|
| `hr.read` · `hr.manage` · `hr.approve` | ✔ | ✔ | | |
| `hr.compensation.read` · `hr.compensation.manage` | ✔ | ✔ | | |
| `hr.payroll.approve` | ✔ | | | |

The split is **person versus pay**, not read versus write. Somebody who may see that a
colleague was late is not thereby somebody who may see what that colleague earns.

`hr.payroll.approve` is withheld from ADMIN for the same reason `finance.period.manage` is:
approving a run is what turns a calculation into money people will be paid.

**Only the compensation half joins `FINANCIAL_CAPABILITIES`.** Listing attendance would make
that constant mean "anything HR touches", and the day an operations supervisor is granted
`hr.read` to mark their own team present, a correct grant would fail a financial invariant it
has nothing to do with.

---

## 11 · Audit and idempotency

Every HR write records actor, tenant, action, entity type, entity id, result and the
operation id — **and nothing else**. That matters more here than in finance:
`redactMetadata` strips known PII keys but **leaves numbers untouched**, so a payroll payload
copied into the trail would put salary in a table every `audit.read` holder can query.

Idempotency reuses the tenant-aware operation store. The cross-tenant replay test sends a
**byte-identical** payload from both tenants — an earlier version used different employees,
so the request hashes differed and the store refused on the hash, meaning the tenant
predicate could have been removed entirely and the test would still have passed.

---

## 12 · Deliberately not built

| | Why |
|---|---|
| Shift roster | An employee has a default shift and an attendance row names the shift worked. A roster table is a scheduling product. |
| Leave accrual | Earning leave monthly rather than annually is policy nobody has stated. |
| PF / ESI / PT / TDS / gratuity | Each is an ordinary `DEDUCTION` component once the rule is specified. Computing one from a guess is a wrong number presented as right. |
| Overtime multiplier | Same. Minutes are recorded; what a minute is worth is unstated. |
| Loss-of-pay basis | The divisor has never been decided. Absence is counted and reported. |
| Employee documents | Object storage is not provisioned, and employee documents are the most sensitive thing this product would hold. A metadata table nothing can write to is a schema for a feature that does not exist. When it lands it needs tenant + employee + role + document-type enforcement and time-limited access, never a permanent public URL. |
| Bank account details | Belongs to a payment rail under its own security review. |
| Multi-property cost allocation | An employee across several properties has no defined split. Cost sits with the primary property or is reported as **unattributed** — never silently assigned. |
| Employee self-service | The role does not exist. A route accepting an employee id from a caller with no employee identity would be worse than no route; a test asserts no such route exists. |

**A caveat rather than a defect:** a per-property salary total over a property with one
employee *is* that employee's pay. That is not a new disclosure today, because the only
capability reaching the breakdown also reaches the payroll lines. It becomes real the day a
role gets aggregates without lines — and that role does not exist.

---

## 13 · What employee self-service will need

The projection layer is built so it can be added without reshaping anything:

1. An `EMPLOYEE` role, and `hr_employees.user_id` linking a person to a login.
2. An `employeeScoped` route flag copying the **investor** mechanism in `guard.ts` exactly:
   scan query, params, headers and body for an employee identity, refuse **unconditionally**
   on the presence of the key — even when it matches the caller's own — and *deny* a
   non-employee on an employee-scoped route rather than running it unscoped. That "sometimes
   scoped" branch is where row-level isolation bugs are born.
3. **No `:id` segment on any employee-scoped route.** The identity comes from the session.
4. `RosterEmployeeView` already exists as the narrower shape for a staffing board.

---

## 14 · Decisions still open

Not guessed, and not blocking anything built here:

- **Statutory payroll** — PF, ESI, PT, TDS, gratuity rates and applicability.
- **Legal leave entitlement minimums** and the accrual rule.
- **The statutory overtime multiplier.**
- **The loss-of-pay divisor.**
- **Employee classification** thresholds for contract versus full-time treatment.
- **Cash versus accrual** (inherited from M-DATA-1 §13) — it decides whether a payroll
  obligation is an expense when incurred or when paid.
- **Multi-property cost allocation** driver.

Each is a business decision. Every one of them is expressible in what exists — as a salary
component, an approved overtime record, or an explicit deduction — the moment somebody
states the rule.
