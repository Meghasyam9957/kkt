# M-OPS-3 — finishing the operational workflow

M-OPS-2 gave a task a stable person instead of a name. It could not let anybody *do* that
from a screen, could not say where the workbook and the record had drifted apart, and could
not tell a supervisor which urgent work had nobody on it. This closes those four gaps.

§1–§9 are implemented. §10 onward is recorded so it is decided rather than drifted into.

---

## 1 · Assignment, from the screen a supervisor is already on

```
Today  →  Housekeeping / Maintenance  →  a row  →  Assign  →  choose  →  confirm
```

`components/operations/AssignTaskButton.tsx` is built entirely from `RowActionButton`, the
control every other write in the product uses. That was the point: it inherits one operation
id per opened intent, a visible APPLYING phase, no optimistic state, and a failure that stays
on screen with its code attached. A bespoke form would have had to re-earn all four, and
would have got one of them subtly wrong.

**What the browser sends:** `taskType`, `taskRef`, `employeeId`, and optionally
`overrideReason`. **What it does not send:** a tenant, a property, or any claim about
eligibility. Those are resolved server-side against the caller's own stores, and a reference
belonging to somebody else is simply not found there.

### The UI does not enforce eligibility, deliberately

The picker labels each person with their shift and today's attendance, because that is what a
supervisor chooses by. It does not grey anybody out and does not decide when a reason is
required. `OperationsPeopleService.assign` does. A second copy of that rule in the browser
would be a second thing to keep in step, and the first time they disagreed the browser would
be wrong.

When the server needs a reason it answers `409 OVERRIDE_REQUIRED` and says why, which the
form shows. The person then has the words in front of them, which is the right moment to ask.

### One assignment abstraction

There is no `POST /api/housekeeping/assign` and no `POST /api/maintenance/assign`.
`POST /api/operations/assignments` is the only way a task gains an owner — including the
reconciliation screen's "bind", because binding a name **is** assigning, with every check
that word already carries. A test asserts no second assigning route exists.

---

## 2 · Housekeeping and maintenance queues

Both queues gained a column naming who holds each task and an action to change it. The
column distinguishes three states, and the distinction is the whole point of M-OPS-2:

| Shown | Means |
|---|---|
| *Nobody yet* | No name in the sheet, no assignment. Ordinary — most tasks, most of the time. |
| **Name** | An assignment exists. This is the person the record names. |
| Name + `unlinked` | The sheet holds a name no assignment stands behind. Every pre-MAKAM row looks like this. |
| Name + `sheet says X` | The cell was edited after we wrote it. Reported, never silently resolved. |

The sheet write still goes through the existing `housekeeping.update` /
`maintenance.update` mutation definitions — the verified pipeline with its contract check,
read-after-write and audit record. No second write path into the workbook was created.

`MaintenanceRow` gained `assignedTo`, which the board projection had been dropping. Without
it a hand-edited cell was invisible on the one screen a technician's supervisor actually
looks at.

---

## 3 · Reconciliation

`GET /api/operations/reconciliation`, and a screen at `/admin/operations/reconciliation`.

M-OPS-2's `reconcile()` reported the three ways the two stores could *disagree* — enough to
notice a problem, not enough to act on one. It could not say whether a name was bindable,
ambiguous, or belonged to somebody who had already left. Those distinctions are the
difference between a list of complaints and a work queue.

Eight statuses, mutually exclusive, machine-safe:

| Status | Meaning | Recommends |
|---|---|---|
| `MATCHED` | The sheet and the record agree — including agreeing that nobody holds it. | — |
| `ECHO_MISMATCH` | An assignment exists; the cell holds a different name. | repair the echo |
| `ECHO_MISSING` | An assignment exists; the cell is empty. | repair the echo |
| `UNLINKED` | A name, no assignment, and exactly one person employed that day answers to it. | **bind** |
| `AMBIGUOUS` | More than one person answers to it. | review — never bind |
| `HISTORICAL` | The only match was not employed on the task's own date. | ignore |
| `MISSING_RELATION` | Nobody on the books answers to it. | review |
| `TASK_NOT_FOUND` | An assignment whose task has left the workbook. | review |

`ECHO_MISSING` is kept as its own status rather than folded into `ECHO_MISMATCH`. They need
the same repair but describe different events — a write that never landed versus a cell
somebody changed — and collapsing them would lose the only evidence of which happened.

**It resolves nothing and prefers neither store.** Deciding which of two records is right
about a human being is not a decision an application should make on its own.

---

## 4 · Historical name resolution — the part that matters most

A name is resolved **as of the task's own date**, never as of today.

```
Turnover dated 2026-05-04, cleaner cell reads "Ramesh"
Ramesh Gupta joined 2027-04-01
→ HISTORICAL, not a match
```

Getting this wrong writes a permanent, plausible, false statement about two people into an
operational record — and it would look right. `OperationalTask` gained `occurredOn` for
exactly this: a turnover's checkout date, a ticket's reported date. Without a task date,
historical resolution cannot be done correctly at all.

Where two people are employed on that date and share the name, the answer is `AMBIGUOUS` and
nothing is bound. The screen lists every candidate **by full name**, because the name they
both go by is by definition the one that cannot separate them — offering it twice would
present a choice with no information in it.

---

## 5 · Urgent work with no owner

`GET /api/operations/urgent`, and a card at the top of Today that renders nothing when there
is nothing.

The definition is narrow on purpose: **open, urgent, and unassigned.** The Today board
already raises every Critical and High ticket from the workbook alone, so a second alert per
ticket would be noise — and an alert for every unassigned task would be worse, because most
tasks are unassigned most of the time and a board that says so is a board nobody reads.

What nobody could see is the *intersection*: urgency is a workbook fact, ownership is an
overlay fact, and until now nothing held both.

**Urgent means what the workbook already means by it.** `Critical` and `High` — the same test
`buildUrgent` applies. There is no `URGENT` priority in this product and none was invented.

### Alerts, deduplication, and lifecycle

There is no alert store, and that is the design rather than a shortcut.

Every item is derived on each render from two reads, so:

- **a refresh cannot duplicate one** — there is nothing to append to, and the key
  (`mnt-<ticketId>`) matches the board's own identity convention, so one ticket is one thing
  wherever it surfaces;
- **assigning it removes it**, because it stops meeting the definition;
- **resolving or closing it removes it**, for the same reason.

So §17's OPEN and RESOLVED are consequences of the facts, not states anybody must remember to
update. **ACKNOWLEDGED is deliberately not built.** It would need a store whose only purpose
is to stop showing urgent work that still has no owner — a feature for hiding the signal.

---

## 6 · Operational history

`AssignTaskButton` shows the chain in the drawer, newest first, using the existing `Timeline`
primitive: who holds it now and since when, and who held it before, with handover times.

History is shown in the same panel as the action because "who had this before" is exactly the
question a reassignment raises — sending somebody to another screen to answer it is how a
reassignment gets made twice.

Each entry shows the name **as written at the time**. Somebody renamed since should not
silently rewrite what the record says happened. Nothing is ever removed: reassignment
supersedes, and the panel says so.

---

## 7 · Boundaries this milestone did not move

| | |
|---|---|
| **Attendance** | Assignment displays attendance as context and changes nothing. Being given work is not evidence of having worked. |
| **Payroll** | Untouched. A completed task changes no pay. |
| **Finance** | No expense is created. `14_MAINTENANCE.ExpenseID` remains the authoritative link and a person decides it. |
| **Task status** | Both lifecycles stay in the workbook's `LISTS`. `OPEN_*_STATUSES` remain the single definition of "not finished". |
| **Compensation** | `operations.staff.read` and `operations.assign` are still outside `FINANCIAL_CAPABILITIES`. The new views carry `Disjoint<T, Withheld>` guards, so adding a pay field fails the build. |

Mutations that make assignment write attendance or open a payroll run are both caught by
tests.

---

## 8 · Tenant and property scope

Every read and write resolves through the caller's own stores. A foreign task reference, a
foreign employee id and a foreign property are all **not found** — the same answer as one
that never existed, so refusal patterns enumerate nothing.

The test harness shares one operations repository and one HR repository between two tenants,
so only the predicate separates them. Identifier sequences are tenant-scoped, which means
both tenants mint the same task reference — and the urgent test uses that collision as its
proof: A assigns theirs, B still sees theirs, because a derivation matching on reference
alone would have silenced both.

`UNKNOWN_PROPERTY` fires when a task names a property the workbook no longer lists — a unit
sold, a listing retired. It reads as unreachable and is not: a test removes a property while
its turnovers remain.

---

## 9 · Concurrency

Unchanged and still the database's job. Two supervisors assigning the same task: one wins,
the other gets `409 ALREADY_ASSIGNED` and is told to reload and decide again. No silent
last-writer-wins.

---

## 10 · Scheduling — not built, and not pretended

Reconciliation runs **when the page is opened, or when the API is called.** Nothing runs on a
timer. There is no cron in this repository and none was added.

When scheduling arrives it should call `reconciliationReport` and store or notify on the
exceptions; the service is already callable and takes no ambient state. The screen says
plainly that it compared when it was opened.

---

## 11 · Demonstration fixtures

The demo environment had no employees, so every people-facing screen said "nobody is on the
books yet" in the one environment anybody looks at. `lib/data/demo/workforce.ts` seeds seven
fictional staff into the in-process store, once per process, **only when the environment is
demo and no Supabase client is configured.**

No contact detail, no email, no pay, no identity document — `EmployeeInput` can carry some of
those and none is supplied. Demonstration data that looks like real personal data is how real
personal data ends up in a fixture.

Two of the seven share the preferred name "Ramesh" with joining dates two years apart, which
is what makes the ambiguous and historical cases demonstrable rather than theoretical.

---

## 12 · Deliberately not built

| Not built | Why |
|---|---|
| Bulk assignment | Each assignment carries its own eligibility decision and override reason. Batching them makes the override meaningless. |
| Auto-assignment, round-robin, skill matching | Needs a competency model and a workload policy nobody has stated. |
| Productivity scores, rankings | Turning task counts into a comparison between people is an appraisal. Nobody has decided this business appraises on task volume. |
| Task cost → expense automation | A person decides `ExpenseID`. Work done is not the same claim as money spent. |
| Alert acknowledgement | See §5. A store for suppressing unowned urgent work is a feature for hiding it. |
| Scheduled reconciliation | See §10. |
| Employee self-service | Out of scope; needs a device and consent story first. |

---

## 13 · Decisions still open

1. **Should an `ECHO_MISMATCH` be repairable in one click?** The action is safe — write our
   name back — but it silently overrules whatever the customer typed. Currently it is
   described and left to a person.
2. **Should `AMBIGUOUS` be resolvable once and remembered?** A "these two names are the same
   person" mapping is a data-cleanup feature with its own audit needs.
3. **Should assignment be possible across properties?** Currently yes, if the task's property
   is in the caller's workbook. Whether an employee with a primary property may be given work
   at another is a staffing policy.
4. **What happens to open assignments when an employee exits?** Today they remain as history
   and the person cannot be given new work.
