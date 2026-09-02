-- =====================================================================
-- M-OPS-2 — THE EMPLOYEE REFERENCE ON AN OPERATIONAL TASK
--
-- SCOPE RULE — no further amendment needed. 0006 stated it: the workbook keeps every fact
-- it already records; this database holds the relational facts a spreadsheet cannot
-- express. This migration is squarely inside that.
--
-- WHAT THE WORKBOOK ALREADY OWNS, AND KEEPS
--
--   13_HOUSEKEEPING  TaskID, BookingID, PropertyID, CheckoutDate, AssignedDate,
--                    Cleaner (TEXT — a name), StartTime, CompletionTime, the four
--                    checklist flags, InspectionStatus, FinalStatus, TurnaroundHrs (CALC)
--   14_MAINTENANCE   TicketID, DateReported, PropertyID, IssueCategory, Description,
--                    Priority, AssignedTo (TEXT — a name), Vendor, EstimatedCost,
--                    ActualCost, Status, DateResolved, DowntimeDays (CALC),
--                    ExpenseID (the authoritative link to 06_EXPENSES), AgeDays (CALC)
--
-- Both lifecycles already include an ASSIGNED state — HK_STATUS is
-- Pending/Assigned/In Progress/Completed/Failed Inspection, MAINT_STATUS is
-- Open/Assigned/In Progress/Waiting/Resolved/Closed — and `housekeeping.create` already
-- sets FinalStatus to 'Assigned' when a cleaner name is supplied. So ASSIGNMENT IS NOT A
-- NEW CONCEPT. The workbook models it, drives status from it, and will go on doing so.
--
-- WHAT IT CANNOT EXPRESS, and what this table is for:
--
--   1. WHICH PERSON. `Cleaner = 'Ravi'` is a name. Two people are called Ravi, one Ravi
--      changes their name, and a third leaves — and every one of those breaks a text match.
--      An employee id does not.
--   2. WHO ASSIGNED, AND WHEN. The sheet records the outcome, never the decision.
--   3. THE HISTORY. A reassignment overwrites a cell. The previous assignment is gone, and
--      with it the answer to "who was on this turnover when it was missed?".
--
-- AUTHORITY, stated so the two stores cannot both claim the same fact:
--
--   the workbook  owns the TASK, its status, its inspection, its cost link, AND THE NAME
--                 written on it. Unchanged, and still written through the existing verified
--                 mutation pipeline.
--   this table    owns WHICH EMPLOYEE that name refers to, who decided, when, and what
--                 came before.
--
-- They answer different questions, so neither overrules the other. `display_name_written`
-- records the name this application put in the sheet at the moment it assigned, which is
-- what makes a later divergence — somebody typing over the cell by hand — DETECTABLE
-- rather than silently trusted. See docs/MOPS2_PEOPLE_OPERATIONS.md §4.
-- =====================================================================

do $$ begin
  create type ops_task_type as enum ('HOUSEKEEPING', 'MAINTENANCE');
exception when duplicate_object then null; end $$;

create table if not exists ops_task_assignments (
  id            uuid          primary key default gen_random_uuid(),
  tenant_id     uuid          not null references tenants(id) on delete restrict,

  task_type     ops_task_type not null,
  /*
   * The workbook's own TaskID or TicketID. TEXT, not a foreign key, for the same reason
   * `property_id` is text everywhere else in this schema: the task lives in the tenant's
   * own workbook. That is not a weakness — it is what makes a task reference resolvable
   * ONLY against the caller's workbook, so a foreign task id cannot be confirmed to exist.
   */
  task_ref      text          not null,

  employee_id   uuid          not null references hr_employees(id) on delete restrict,
  /*
   * Where the work is. Recorded on the assignment rather than read from the task each
   * time, because the question "who was working at this property in May" must survive a
   * task later being re-pointed.
   */
  property_id   text,

  /*
   * The name this application wrote into 13_HOUSEKEEPING.Cleaner or
   * 14_MAINTENANCE.AssignedTo at the moment of assignment.
   *
   * Not a duplicate of the employee's name — a RECORD OF WHAT WAS WRITTEN. If somebody
   * edits the sheet by hand afterwards, the two disagree, and the application can say so
   * instead of quietly preferring one. A copy nobody compares is duplication; a copy
   * compared on every read is a checksum.
   */
  display_name_written text   not null,

  assigned_by   text,
  assigned_at   timestamptz   not null default now(),

  /*
   * Supersession, never deletion. A reassignment closes the previous row and inserts a new
   * one, so the history is a chain and "who was on this when it was missed?" always has an
   * answer.
   */
  superseded_at timestamptz,
  superseded_by uuid          references ops_task_assignments(id) on delete restrict,

  /*
   * A supervisor may deliberately assign somebody on a weekly off or a partial day. That
   * is a legitimate operational decision, so it is permitted — but never silently: the
   * reason is required when an eligibility warning was overridden, and it is audited.
   */
  override_reason text,

  created_at    timestamptz   not null default now(),

  constraint ops_assignment_task_ref_present check (length(btrim(task_ref)) > 0),
  constraint ops_assignment_name_present     check (length(btrim(display_name_written)) > 0),
  constraint ops_assignment_superseded_shape check (
    (superseded_at is null and superseded_by is null)
    or (superseded_at is not null)
  ),
  constraint ops_assignment_not_self_superseding check (superseded_by is null or superseded_by <> id)
);

/*
 * AT MOST ONE CURRENT ASSIGNMENT PER TASK, and this index is the concurrency control.
 *
 * Two supervisors assigning the same turnover at the same moment both read "unassigned"
 * and both insert; the second insert violates this index and is refused. That is
 * optimistic concurrency enforced by the database rather than a lock the application would
 * have to hold across two stores — and the loser is told the task was just assigned,
 * rather than silently producing a second current assignment nobody can reconcile.
 */
create unique index if not exists ops_assignment_one_current
  on ops_task_assignments (tenant_id, task_type, task_ref) where superseded_at is null;

create index if not exists ops_assignment_task_idx
  on ops_task_assignments (tenant_id, task_type, task_ref, assigned_at desc);
create index if not exists ops_assignment_employee_idx
  on ops_task_assignments (tenant_id, employee_id, assigned_at desc);
create index if not exists ops_assignment_property_idx
  on ops_task_assignments (tenant_id, property_id, assigned_at desc) where property_id is not null;

-- ---------------------------------------------------------------------
-- Deny by default — identical to every other table in this schema.
--
-- RLS on with no policy denies everything to `anon` and `authenticated` outright. The
-- enforcement layer is the repository, which takes a TenantContext on every method and has
-- no method that omits one; RLS is defence in depth and is never the boundary, because no
-- test in this project can reach it.
-- ---------------------------------------------------------------------

alter table ops_task_assignments enable row level security;
revoke all on ops_task_assignments from authenticated, anon;

-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT
--
-- a generic task table     Housekeeping and maintenance have DIFFERENT lifecycles and
--                          different fields, and both already live in the workbook. One
--                          table for both would be a third source of truth for facts two
--                          sheets already own. What IS identical between them is the
--                          assignment fact, and that is the only thing here.
-- completion timestamps    13_HOUSEKEEPING.CompletionTime and 14_MAINTENANCE.DateResolved
--                          already record them, and TurnaroundHrs/DowntimeDays are workbook
--                          formulas over them. Copying either would be a second answer.
-- inspection result        13_HOUSEKEEPING.InspectionStatus owns it.
-- task status              Both sheets own theirs, and their vocabularies are already
--                          defined in the contract's LISTS. Nothing here duplicates them.
-- a maintenance cost event 14_MAINTENANCE.ExpenseID is the authoritative link to
--                          06_EXPENSES and is already writable by `maintenance.update`.
--                          Completing a task creates no expense here: whether work has a
--                          cost is a decision a person makes, not one an assignment implies.
-- a shift roster           M-HR-1 deferred it, and nothing here needs it: an employee has a
--                          default shift and an attendance row names the shift worked.
-- employee productivity    Ranking people on task counts is a business decision nobody has
--                          made, and a metric that becomes an appraisal by accident is
--                          worse than no metric.
-- ---------------------------------------------------------------------
