# M-OPS-2 — people on operations

How a task in the workbook comes to mean a person in the HR database, what each store is
allowed to say, and what was deliberately left alone. §1–§11 are implemented; §12 onward is
recorded so it is decided rather than drifted into.

---

## 1 · The question this milestone had to answer first

Housekeeping and maintenance already recorded who was doing the work — as free text.
`08_HOUSEKEEPING.Cleaner` and `14_MAINTENANCE.AssignedTo` are name cells, filled by hand in
the customer's own spreadsheet, and M-HR-1 had just introduced a real employee register in
Postgres. Two places now knew about a worker, so **one of them had to stop being the
authority for something.**

The answer taken, and the whole design follows from it:

> **The workbook owns the TASK — its status, its inspection, its cost link, and the NAME
> written on it. The overlay owns WHICH EMPLOYEE that name refers to, who decided, when,
> and what it was before.**

Nothing was moved out of the workbook. Nothing was copied into Postgres. The sheet is not
demoted to a cache, and the database is not a second task list. What was added is the one
fact the sheet structurally cannot hold: a stable reference to a person, where the cell can
only hold a string.

That split is written into the migration header itself
([`0008_ops_task_assignments.sql`](../supabase/migrations/0008_ops_task_assignments.sql))
so the next person to read the schema finds the rule before the columns.

### What "the sheet keeps the name" costs, and why it is still right

Echoing the name back into `Cleaner` / `AssignedTo` means the cell is now a mutable copy of
a fact held elsewhere. That is a real cost and it is not hidden: the customer's own V1 menu
writes that cell, a supervisor can type over it, and both halves stay internally consistent
while disagreeing — the definition of a silent divergence.

It is still right, because the alternative is worse: a sheet whose assignee column silently
stops being filled by this application is a sheet the business can no longer read on its
own, and the business reads that sheet every day. So the echo stays, the name that was
written is stored alongside the reference (`display_name_written`), and
`OperationsPeopleService.reconcile()` reports every disagreement rather than resolving one.

---

## 2 · Storage boundary

| Layer | Holds |
|---|---|
| **The workbook** | the task, its identifier, its property, its status and lifecycle, its inspection, its cost link, and the assignee's **name** |
| **Postgres — `ops_task_assignments`** | which employee that name refers to, who assigned, when, any override reason, and the superseded history |
| **Postgres — `hr_*`** (M-HR-1) | the employee, their department, shift, attendance, leave |
| **Postgres — `finance_*`** (M-DATA-1) | money. Untouched by this milestone |

One table was added. No sheet was added, no column was added to a sheet, and no existing
sheet write path was replaced.

```sql
create unique index ops_assignment_one_current
  on ops_task_assignments (tenant_id, task_type, task_ref) where superseded_at is null;
```

**One current assignment per task, per tenant, enforced by the database rather than by a
read-then-write in application code.** Reassignment supersedes: the previous row keeps
`superseded_at` and `superseded_by`, so the history of who held a task is a record, not an
overwrite. `on delete restrict` throughout — an employee who has held work cannot be erased
out from under the record of it.

---

## 3 · Employee identity — six answers, not two

`resolveByName(tenant, name, asOf)` is the bridge from a historical name cell to a person,
and it never guesses. Its return type is a discriminated union of six cases
([`lib/server/operations/types.ts`](../lib/server/operations/types.ts)):

| Result | When | What it means |
|---|---|---|
| `EXACT` | exactly one employee, employed on `asOf`, `ACTIVE` | safe to bind |
| `AMBIGUOUS` | more than one name match | **a person chooses.** Not "the active one", not "the most recent" |
| `INACTIVE` | one match, employed then, not `ACTIVE` now | surfaced with the status |
| `HISTORICAL_MISMATCH` | one match, but not employed on `asOf` | a name that reads the same as someone who joined later |
| `NO_MATCH` | no employee carries that name | reported, not created |
| `UNRECORDED` | the cell is blank | nobody was named, which is not the same as nobody worked |

The `asOf` parameter is what separates the last two from each other. A turnover from March
carrying the name "Ramesh" must not resolve to the Ramesh who joined in July, and a match
on spelling alone would do exactly that — the record would look correct and be wrong about
a person. `joiningDate <= asOf && (exitDate === null || exitDate >= asOf)` is checked before
the status is, so "was not here yet" and "is not here now" are different answers.

**A name is never an identifier.** `display_name_written` exists so a divergence can be
detected; nothing is ever looked up by it at write time. Assignment takes an `employeeId`.

---

## 4 · Assignment

`POST /api/operations/assignments`, capability `operations.assign`, one handler
([`operations-handlers.ts`](../lib/server/api/operations-handlers.ts)), one service method
([`service.ts`](../lib/server/operations/service.ts)).

The order is fixed and every step is a refusal:

1. **The employee**, through the tenant-scoped HR repository. A foreign id is a miss.
2. **The task**, from the caller's **own** workbook. A foreign `TaskID` simply is not there.
3. **Open?** A completed task is `409 TASK_CLOSED` — finished work does not need assigning.
4. **The property**, against the caller's own list. Belt and braces: the task came from
   their sheet, but a task naming a property the workbook no longer lists is a data problem
   worth surfacing rather than assigning around.
5. **Eligibility** (§5).
6. **Write.**

Because both identifiers are resolved independently against the caller's own store, **the
pair `(task, employee)` can only ever be formed from two things the caller already owns.**
There is no code path that accepts a task reference from one tenant and an employee from
another; there is nowhere for such a pair to be constructed.

### Two stores, no transaction — the order and why

Sheet first, then overlay. Two stores cannot be written atomically, so the order was chosen
by what each failure leaves behind:

- **Sheet then overlay** (chosen): a failure leaves a name in the workbook with no employee
  reference. That is indistinguishable from every historical row, which `resolveByName`
  already handles honestly, and a retry repairs it — writing the same name into the same
  cell twice is the same state.
- **Overlay then sheet**: a failure would leave an assignment that the partial unique index
  then refuses to replace. The supervisor could not repair it without an administrator.

The workbook write does **not** reach for a sheets client. It runs the existing
`housekeeping.update` / `maintenance.update` mutation definitions through `executeMutation`,
as the real caller, so it keeps that pipeline's contract check (which refuses a calculated
column), its read-after-write verification, its operation ledger and its audit record. A
second write path into the same sheet is precisely what the mutation layer exists to
prevent.

If the unique index refuses the overlay row, somebody assigned the same task between our
read and our write: `409 ALREADY_ASSIGNED`, with an instruction to reload and decide again.
Last-writer-wins was not an option — the loser's decision would vanish without either
supervisor knowing.

---

## 5 · Eligibility — blocked, warned, never silent

| Employee state | Result |
|---|---|
| `EXITED` | **BLOCKED** — has left the business |
| `SUSPENDED` | **BLOCKED** — a deliberate instruction to stop assigning work |
| `ON_LEAVE` | **WARN** |
| `NOTICE_PERIOD` | **WARN** — still employed, still assignable, worth saying |
| the day is their weekly off | **WARN** — a rest day is not a prohibition |
| approved leave covers the day | **WARN** |

A `WARN` without an `overrideReason` is `409 OVERRIDE_REQUIRED`. The assignment is
permitted — a supervisor genuinely may need to call somebody in — but it is never silent:
the reason is required, stored on the row, and the response carries `warnings` so the
interface can show what was overridden rather than bury it.

Leave that is *requested but not approved* is not a reason. Nobody has agreed to it yet.

---

## 6 · Today staffing

`GET /api/operations/staffing`, and the same read in process for the Today page
([`components/operations/TodayStaffing.tsx`](../components/operations/TodayStaffing.tsx)).

The section sits **beside** `TodayBoard`, not inside it: the board is the workbook's
operational payload and staffing is the people domain, so neither read waits on the other,
and the board renders unchanged for a viewer without `operations.staff.read`.

Per person: who, their shift, their status today, and how many open tasks they currently
hold. Per department: scheduled, present, absent, on leave, weekly off, late — and gaps.

Three distinctions the screen refuses to collapse:

- **A day nobody has recorded is not an absence.** It is `NOT_RECORDED`, counted as a gap,
  and named as one on screen. Absence is a claim somebody made; a gap is a claim nobody
  made.
- **Only approved attendance counts.** The board reads
  `listAttendance(..., { approval: 'APPROVED' })`, the same authority payroll consumes, so
  the two cannot tell different stories about the same day.
- **An overnight shift is ordinary.** `crossesMidnight` travels to the view so 22:00–06:00
  renders as "(next day)" rather than as a negative span.

Somebody with no property assignment is shown as unassigned rather than attributed to
whichever property sorts first.

---

## 7 · What this integration does NOT do

Four negatives, each load-bearing, each stated in the service header and each held by a
mutation test (§10):

| | |
|---|---|
| **Assignment does not record attendance** | Being given work is not evidence of having worked. Attendance is recorded and approved by a person and stays the authority for whether a day was worked. |
| **Task completion does not change payroll** | Payroll consumes approved attendance and approved overtime. Nothing here writes either. |
| **Task completion does not create an expense** | `14_MAINTENANCE.ExpenseID` is the authoritative link to `06_EXPENSES` and a person decides it. Work having been done is not the same claim as money having been spent. |
| **Nothing here owns task status** | Both lifecycles live in the workbook's own `LISTS` sheet, and `OPEN_HOUSEKEEPING_STATUSES` / `OPEN_MAINTENANCE_STATUSES` in `lib/shared/domain.ts` remain the single definition of "not finished". No second lifecycle was invented. |

Assignment does move the sheet's status to `Assigned`, because `housekeeping.create`
already does exactly that when a cleaner is named. Following the workbook's existing
behaviour is not inventing a lifecycle; leaving a named task sitting in `Pending` would
have been a third story about the same row.

---

## 8 · Tenant and property boundaries

Every repository method takes `TenantContext` first, `requireTenant` is fail-closed, and
`InMemoryOperationsRepository` filters through a single `mine()` predicate so there is one
place for the tenant check rather than five.

The case that matters, and that a test now pins: **identifier sequences are tenant-scoped**
(M-SAAS-0), so two customers both mint `HK-2026-0001` for their own first turnover. The
collision is correct and expected. An assignment lookup missing its tenant predicate would
therefore let one business supersede the other's roster — not as an exotic attack, but as
the normal case.

Property scope is checked against the caller's own workbook, and a property they do not own
is refused **identically to one that does not exist** — the question is only ever asked of
their own sheet, so refusal patterns enumerate nothing.

`SupabaseOperationsRepository` carries no logic. `scoped()` on every read, both predicates
on every update, `tenant_id` stamped last on insert. Postgres error `23505` is translated
to `null` — the concurrency case above — rather than surfacing as a crash.

---

## 9 · Role and field projection

Two capabilities were added to `lib/shared/roles.ts`:

- `operations.staff.read` — the staffing board, the assignment list, the metrics
- `operations.assign` — the write

Both are held by `OPERATIONS`, `ADMIN` and `SUPER_ADMIN`. **Neither is in
`FINANCIAL_CAPABILITIES`**, so the "OPERATIONS holds no financial capability" invariant
that M-DATA-1 established is unchanged and still enforced by the same test.

The withholding is structural, not a filter. `StaffDay` — the type the staffing board is
built from — **has no salary field, no bank field, no contact reference and no email to
withhold.** The projections in
[`lib/server/operations/projections.ts`](../lib/server/operations/projections.ts) carry
compile-time `Disjoint<T, Withheld>` guards over a union including
`salary | gross | net | … | contactRef | email | tenantId | assignedBy | createdBy`, so
adding one of those fields to an operations payload fails the build rather than shipping.

Operations gained the ability to see **who is working and what they are doing**. It gained
nothing about what anybody is paid.

---

## 10 · Audit, idempotency, concurrency

**Audit.** The assignment records `{operationId, taskType, taskRef, overridden}` — and
deliberately **no employee name**. `redactMetadata` strips known PII keys, but a name under
an unknown key would survive it, and an audit trail listing who was put on which turnover is
a staff-movement record nobody asked for. The employee id is on the assignment row itself,
which is tenant-scoped and capability-gated. `tenant_id` is on every audit row (M-SAAS-1).

**Idempotency.** The same tenant-aware `OperationStore` as finance and HR: the tenant is
compared **before** the request hash, so a replay from another tenant is a tenant refusal
rather than a hash mismatch. A retried assignment replays the stored result; a different
payload under the same operation id is `409 OPERATION_MISMATCH`.

**Concurrency.** The partial unique index, described in §2 and §4.

---

## 11 · Divergence reporting

`reconcile(tenant)` lists three kinds of disagreement between the sheet and the overlay:

| Kind | Meaning |
|---|---|
| `SHEET_EDITED` | the cell no longer holds the name this application wrote |
| `ECHO_MISSING` | an assignment exists, the cell is blank |
| `UNLINKED_NAME` | a name in the sheet with no assignment behind it |

`UNLINKED_NAME` is the normal state of every historical row and of every row the customer
fills in themselves, so it is **reported, never treated as an error**. `reconcile` resolves
nothing and prefers neither store — it tells a person what disagrees and lets them decide,
because deciding which of two stores is right about a name is not a decision an application
should make on its own.

---

## 12 · Deliberately not built

| Not built | Why |
|---|---|
| **Employee productivity scores, rankings, leaderboards** | Turning task counts into a comparison between people is an appraisal. Whether this business appraises on task volume is a decision nobody has made. Counts by property answer the operational question — where is work piling up — without becoming one about individuals. |
| **Auto-assignment / round-robin / skill matching** | Requires skills, competencies and a workload policy nobody has stated. Assignment is a supervisor's decision. |
| **Background sync between the sheet and the overlay** | Nothing runs on a timer. Divergence is computed when asked. An invisible process rewriting the customer's spreadsheet is not something to introduce quietly. |
| **Bulk / multi-task assignment** | Each assignment carries its own eligibility decision and its own override reason. Batching them makes the override meaningless. |
| **Assignment from the UI** | The staffing section is read-only in this milestone. The write path exists, is capability-gated, audited and tested through the route; the drawer is not built. |
| **Employee self-service, clock-in, geofencing, biometric** | Out of scope by the brief. Needs a device story and a consent story first. |
| **Task cost → expense automation** | §7. A person decides `ExpenseID`. |

---

## 13 · Decisions still open

None of these are guesses this milestone should make:

1. **Does a completed task ever imply overtime?** Currently no — overtime is recorded and
   approved independently. If a business wants task duration to feed overtime, that is a
   pay rule and a pay rule is theirs to state.
2. **Should a supervisor be able to assign across properties?** Currently yes, if the task's
   property is in their workbook. Whether an employee with a primary property may be given
   work at another is a staffing policy.
3. **Should `AMBIGUOUS` be resolvable once and remembered?** A "these two names are the same
   person" mapping is a data-cleanup feature with its own audit needs.
4. **What happens to current assignments when an employee exits?** Today they remain as
   history and the employee cannot be given new work. Whether exit should force reassignment
   of open tasks is an operational rule.

---

## 14 · Status

Migrations `0006`, `0007` and `0008` are **declarative files that have not been applied to
any database.** There is no local Postgres, no migration runner and no CI in this
repository. Everything above is verified against the in-memory twins and, for the Supabase
twins, against recorded query chains — which proves the query shape, not the behaviour of a
live database.

This is a foundation with test evidence behind each claim. It is not a deployed system.
