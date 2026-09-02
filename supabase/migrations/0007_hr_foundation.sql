-- =====================================================================
-- M-HR-1 — THE PEOPLE FOUNDATION
--
-- SCOPE RULE — no further amendment needed.
--
-- 0006 amended 0001's "this database holds NO business data" and stated the replacement:
-- the workbook keeps every financial fact it already records; this database holds the
-- relational facts a spreadsheet cannot express. HR falls entirely on this side of that
-- line, and not by preference — by absence. A repository-wide search for employee, staff,
-- worker, attendance, salary, payroll, designation, department, shift or overtime returns
-- NOTHING: not a sheet in the 22-sheet contract, not a column, not a domain type, not a
-- route, not a capability. The two occurrences of "Leave" in the contract are the English
-- verb in help text.
--
-- So there is no boundary to negotiate here and no authority to compete with. The whole
-- People domain is new, and it is relational from birth.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   No statutory payroll. PF, ESI, PT, TDS, gratuity, leave entitlement minimums and the
--   overtime multiplier are all absent, and their absence is the point: none has been
--   specified, and a plausible-looking wrong number in a payslip is worse than no number.
--   Every one of them is expressible as a salary component or an approved overtime record
--   once somebody decides the rule. See docs/MHR1_HR_ARCHITECTURE.md §14.
--
--   No net-pay stored as truth. A payroll line records its components and the figures
--   derived from them at calculation time, and the components are kept, so the arithmetic
--   is always re-checkable rather than asserted.
--
--   No second period lock. `finance_periods` (0006) governs payroll too. Two lock tables
--   is how a month comes to be closed in one place and open in another.
--
--   No second balance system. An advance's outstanding amount is computed from its
--   recoveries, never stored — the same rule 0006 applies to bills and receivables.
--
-- MONEY is integer paise in `bigint`, through lib/server/finance/money.ts. There is one
-- money module in this application and HR does not get a second one.
--
-- TENANCY. Every table carries `tenant_id`, every index leads with it, every unique
-- constraint is scoped by it, and RLS is on with every browser role revoked. The
-- application reaches these tables with the service role having already verified
-- membership, exactly as it does for finance.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------

do $$ begin
  create type hr_entity_status as enum ('ACTIVE', 'INACTIVE');
exception when duplicate_object then null; end $$;

-- An employment lifecycle, not a delete flag. INACTIVE, TERMINATED and DELETED are three
-- different facts and this enum refuses to conflate them: an employee who has left is
-- EXITED and their attendance and payroll history remains attached to them.
do $$ begin
  create type hr_employment_status as enum (
    'ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'NOTICE_PERIOD', 'EXITED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type hr_employment_type as enum (
    'FULL_TIME', 'PART_TIME', 'CONTRACT', 'CASUAL'
  );
exception when duplicate_object then null; end $$;

/*
 * ATTENDANCE STATUS — what the day WAS. Six values, and none of them overlap.
 *
 * LATE and EARLY_EXIT are deliberately NOT statuses. Somebody who arrived late was still
 * present, and making lateness a status means a late person is not PRESENT — which
 * silently removes them from every worked-day count that filters on PRESENT. They are
 * flags on the row (`late`, `early_exit`), so "was he there?" and "was he on time?" stay
 * separate questions with separate answers.
 *
 * There is no NOT_RECORDED value, because a day nobody recorded has no row. Absence of a
 * record is not absence from work, and the payroll engine reports the gap rather than
 * assuming either way.
 */
do $$ begin
  create type hr_attendance_status as enum (
    'PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF'
  );
exception when duplicate_object then null; end $$;

-- Raw attendance facts are separated from their approval, so payroll consumes only what a
-- human has signed off. DRAFT and SUBMITTED are not payroll input.
do $$ begin
  create type hr_approval_status as enum ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
exception when duplicate_object then null; end $$;

/*
 * PAYROLL LIFECYCLE — four states, deliberately fewer than the six a payroll package
 * usually carries.
 *
 * REVIEW is not a state: it is what a person does while a run is CALCULATED, and a state
 * nobody transitions out of programmatically is a label pretending to be a workflow.
 *
 * PAID is not a state either, and that omission is the whole point of the finance
 * integration. A payroll run does not pay anybody — it produces obligations, and money
 * moves when `finance_payments` posts against them. A PAID payroll status would be a
 * second answer to "has this been paid?", and it would be the wrong one the moment a
 * single employee's transfer failed.
 */
do $$ begin
  create type hr_payroll_status as enum ('DRAFT', 'CALCULATED', 'APPROVED', 'POSTED');
exception when duplicate_object then null; end $$;

-- A salary component either adds to gross or subtracts from it. Nothing else.
do $$ begin
  create type hr_component_kind as enum ('EARNING', 'DEDUCTION');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 1. Organisation master
--
-- Tenant-scoped and configurable. The seed vocabulary a deployment starts with is a
-- provisioning decision, not a schema one — hard-coding "Front Office, Housekeeping,
-- Maintenance" here would make one business's org chart every business's org chart.
-- ---------------------------------------------------------------------

create table if not exists hr_departments (
  id         uuid             primary key default gen_random_uuid(),
  tenant_id  uuid             not null references tenants(id) on delete restrict,
  name       text             not null,
  status     hr_entity_status not null default 'ACTIVE',
  created_at timestamptz      not null default now(),
  updated_at timestamptz      not null default now(),

  constraint hr_departments_name_present check (length(btrim(name)) > 0)
);

create unique index if not exists hr_departments_name_unique
  on hr_departments (tenant_id, lower(btrim(name)));

create table if not exists hr_designations (
  id         uuid             primary key default gen_random_uuid(),
  tenant_id  uuid             not null references tenants(id) on delete restrict,
  name       text             not null,
  status     hr_entity_status not null default 'ACTIVE',
  created_at timestamptz      not null default now(),
  updated_at timestamptz      not null default now(),

  constraint hr_designations_name_present check (length(btrim(name)) > 0)
);

create unique index if not exists hr_designations_name_unique
  on hr_designations (tenant_id, lower(btrim(name)));

-- ---------------------------------------------------------------------
-- 2. Employees
--
-- DATA MINIMISATION IS PART OF THE SCHEMA, not a policy laid over it. There is no
-- date_of_birth, no gender, no Aadhaar, no PAN, no bank account number, no address and no
-- next-of-kin — because nothing in this milestone needs them, and a column that exists is
-- a column something eventually writes to. `contact_ref` is one operational contact, the
-- same shape `finance_vendors.contact_ref` takes.
--
-- Bank details are conspicuously absent even though payroll pays people. Settlement is
-- `finance_payments`, whose `account_ref` is the tenant's OWN account vocabulary; where a
-- transfer needs a destination, that belongs in whatever payment rail is eventually
-- integrated, under its own security review, and never in a row this application selects
-- with `select *`.
-- ---------------------------------------------------------------------

create table if not exists hr_employees (
  id                  uuid                 primary key default gen_random_uuid(),
  tenant_id           uuid                 not null references tenants(id) on delete restrict,

  -- Tenant-scoped and human-readable. NOT the display name: two people share a name, one
  -- person changes theirs, and neither should disturb a payroll history.
  employee_code       text                 not null,
  full_name           text                 not null,
  preferred_name      text,
  contact_ref         text,
  email               text,

  department_id       uuid                 references hr_departments(id)  on delete restrict,
  designation_id      uuid                 references hr_designations(id) on delete restrict,
  employment_type     hr_employment_type   not null default 'FULL_TIME',

  joining_date        date                 not null,
  confirmation_date   date,
  exit_date           date,
  status              hr_employment_status not null default 'ACTIVE',

  -- The workbook's own PropertyID. TEXT, not a foreign key: properties live in the
  -- tenant's workbook, which is exactly why a property reference can only ever be
  -- validated against the CALLER'S workbook and can never confirm another tenant's
  -- property exists.
  primary_property_id text,
  -- Self-referencing, and the tenant equality is enforced in the service: a manager from
  -- another tenant is refused there, because a composite foreign key on (tenant_id, id)
  -- would be the only way to say it here and that shape is not worth the two extra
  -- indexes it costs across five referencing tables.
  manager_id          uuid                 references hr_employees(id) on delete restrict,

  -- 0=Sunday … 6=Saturday. Null means "no fixed weekly off", which is different from
  -- Sunday, and a default of Sunday would silently invent a rest day for a business that
  -- rotates them.
  weekly_off_day      smallint,

  notes               text,
  created_by          text,
  created_at          timestamptz          not null default now(),
  updated_at          timestamptz          not null default now(),

  constraint hr_employees_code_present  check (length(btrim(employee_code)) > 0),
  constraint hr_employees_name_present  check (length(btrim(full_name)) > 0),
  constraint hr_employees_weekly_off    check (weekly_off_day is null
                                               or (weekly_off_day between 0 and 6)),
  constraint hr_employees_exit_after_joining check (exit_date is null
                                                    or exit_date >= joining_date),
  constraint hr_employees_confirm_after_joining check (confirmation_date is null
                                                       or confirmation_date >= joining_date),
  -- An EXITED employee has a leaving date, and a leaving date means they have left. The
  -- two agreeing is the difference between a roster you can trust and one you cannot.
  constraint hr_employees_exit_consistent check (
    (status = 'EXITED' and exit_date is not null)
    or (status <> 'EXITED' and exit_date is null)
  ),
  constraint hr_employees_not_own_manager check (manager_id is null or manager_id <> id)
);

-- Scoped by tenant: two businesses may both number their first hire EMP-0001, and neither
-- learns of the other by being refused.
create unique index if not exists hr_employees_code_unique
  on hr_employees (tenant_id, lower(btrim(employee_code)));
create index if not exists hr_employees_tenant_status_idx
  on hr_employees (tenant_id, status, full_name);
create index if not exists hr_employees_tenant_property_idx
  on hr_employees (tenant_id, primary_property_id) where primary_property_id is not null;
create index if not exists hr_employees_manager_idx
  on hr_employees (tenant_id, manager_id) where manager_id is not null;

-- ---------------------------------------------------------------------
-- 3. Shifts
--
-- Hospitality runs overnight, so 22:00 → 06:00 must be an ordinary shift rather than an
-- invalid negative interval. `crosses_midnight` states it explicitly instead of leaving
-- every consumer to infer it from end_time < start_time — an inference that is correct
-- until somebody defines a 24-hour shift.
--
-- CONVENTION, stated once and relied on everywhere: an overnight shift belongs to the
-- date it STARTS. The night of the 3rd into the 4th is attendance for the 3rd.
-- ---------------------------------------------------------------------

create table if not exists hr_shifts (
  id               uuid             primary key default gen_random_uuid(),
  tenant_id        uuid             not null references tenants(id) on delete restrict,
  name             text             not null,
  start_time       time             not null,
  end_time         time             not null,
  crosses_midnight boolean          not null default false,
  -- Minutes after start_time before an arrival counts as late. Zero is a real answer.
  grace_minutes    smallint         not null default 0,
  status           hr_entity_status not null default 'ACTIVE',
  created_at       timestamptz      not null default now(),
  updated_at       timestamptz      not null default now(),

  constraint hr_shifts_name_present check (length(btrim(name)) > 0),
  constraint hr_shifts_grace_sane   check (grace_minutes between 0 and 240),
  -- The flag and the times must agree, so a mis-entered overnight shift is refused rather
  -- than silently treated as a zero-length day.
  constraint hr_shifts_midnight_consistent check (
    (crosses_midnight and end_time <= start_time)
    or (not crosses_midnight and end_time > start_time)
  )
);

create unique index if not exists hr_shifts_name_unique
  on hr_shifts (tenant_id, lower(btrim(name)));

-- ---------------------------------------------------------------------
-- 4. Holidays
--
-- Tenant-configurable, and empty by default. No national calendar is seeded: a public
-- holiday is a business decision about whether the property closes, and hard-coding one
-- country's list as immutable truth would be wrong for the first customer who works it.
-- ---------------------------------------------------------------------

create table if not exists hr_holidays (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants(id) on delete restrict,
  holiday_date date        not null,
  name         text        not null,
  -- Null means the whole business. A property-specific holiday names one.
  property_id  text,
  created_by   text,
  created_at   timestamptz not null default now(),

  constraint hr_holidays_name_present check (length(btrim(name)) > 0)
);

create unique index if not exists hr_holidays_date_unique
  on hr_holidays (tenant_id, holiday_date, coalesce(property_id, ''));

-- ---------------------------------------------------------------------
-- 5. Attendance
--
-- UNIQUENESS, and why it is two partial indexes rather than one constraint:
--
--   at most ONE shiftless record per employee per date
--   at most ONE record per employee per date PER SHIFT
--
-- A business that does not roster shifts records one row a day and the first index is the
-- whole rule. A business that runs split or double shifts records one row per shift, and
-- the second index still stops the same shift being entered twice. A single
-- `unique(tenant, employee, date)` would have made split shifts unrepresentable, and
-- hospitality has them; a single four-column unique would have allowed unlimited
-- shiftless duplicates, because NULL is distinct from NULL in a unique index.
-- ---------------------------------------------------------------------

create table if not exists hr_attendance (
  id              uuid                 primary key default gen_random_uuid(),
  tenant_id       uuid                 not null references tenants(id) on delete restrict,
  employee_id     uuid                 not null references hr_employees(id) on delete restrict,

  attendance_date date                 not null,
  shift_id        uuid                 references hr_shifts(id) on delete restrict,
  -- Where the day was worked. The workbook's PropertyID, validated against the caller's
  -- own workbook exactly as the employee's primary property is.
  property_id     text,

  status          hr_attendance_status not null,
  check_in_at     timestamptz,
  check_out_at    timestamptz,

  -- FLAGS, not statuses. A late arrival is still an arrival; see the enum comment.
  late            boolean              not null default false,
  early_exit      boolean              not null default false,

  -- Recorded here as an observation. It becomes payable only through an APPROVED
  -- `hr_overtime` record, so nobody is paid overtime because a clock said so.
  overtime_minutes integer             not null default 0,

  source          text                 not null default 'MANUAL',
  notes           text,

  approval        hr_approval_status   not null default 'DRAFT',
  submitted_by    text,
  approved_by     text,
  approved_at     timestamptz,

  created_by      text,
  created_at      timestamptz          not null default now(),
  updated_at      timestamptz          not null default now(),

  constraint hr_attendance_overtime_sane check (overtime_minutes >= 0 and overtime_minutes <= 1440),
  constraint hr_attendance_times_ordered check (
    check_in_at is null or check_out_at is null or check_out_at >= check_in_at
  ),
  -- Flags only mean something on a day somebody attended.
  constraint hr_attendance_flags_need_presence check (
    (not late and not early_exit) or status in ('PRESENT', 'HALF_DAY')
  ),
  constraint hr_attendance_approved_shape check (
    (approval = 'APPROVED' and approved_by is not null and approved_at is not null)
    or approval <> 'APPROVED'
  )
);

create unique index if not exists hr_attendance_day_unique
  on hr_attendance (tenant_id, employee_id, attendance_date) where shift_id is null;
create unique index if not exists hr_attendance_shift_unique
  on hr_attendance (tenant_id, employee_id, attendance_date, shift_id) where shift_id is not null;
create index if not exists hr_attendance_tenant_date_idx
  on hr_attendance (tenant_id, attendance_date desc);
create index if not exists hr_attendance_employee_idx
  on hr_attendance (tenant_id, employee_id, attendance_date desc);
create index if not exists hr_attendance_approval_idx
  on hr_attendance (tenant_id, approval, attendance_date desc);
create index if not exists hr_attendance_property_idx
  on hr_attendance (tenant_id, property_id, attendance_date desc) where property_id is not null;

-- ---------------------------------------------------------------------
-- 6. Leave
--
-- Leave TYPES are tenant-configurable and seeded with nothing. `paid` is a property of the
-- type rather than a hard-coded list, because whether casual leave is paid is a policy
-- this application must not decide on a customer's behalf.
--
-- ENTITLEMENT is an allocation per employee per type per year. It is what makes a balance
-- an arithmetic result rather than an editable number: available = allocated − approved
-- taken, and "taken" is summed from approved requests and never stored. Accrual — earning
-- 1.5 days a month rather than receiving 18 up front — is deliberately absent, because the
-- accrual rule is a policy nobody has stated.
-- ---------------------------------------------------------------------

create table if not exists hr_leave_types (
  id         uuid             primary key default gen_random_uuid(),
  tenant_id  uuid             not null references tenants(id) on delete restrict,
  code       text             not null,
  name       text             not null,
  paid       boolean          not null default true,
  status     hr_entity_status not null default 'ACTIVE',
  created_at timestamptz      not null default now(),

  constraint hr_leave_types_code_present check (length(btrim(code)) > 0),
  constraint hr_leave_types_name_present check (length(btrim(name)) > 0)
);

create unique index if not exists hr_leave_types_code_unique
  on hr_leave_types (tenant_id, upper(btrim(code)));

create table if not exists hr_leave_entitlements (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants(id) on delete restrict,
  employee_id   uuid        not null references hr_employees(id) on delete restrict,
  leave_type_id uuid        not null references hr_leave_types(id) on delete restrict,
  -- The leave year this allocation belongs to, named by its first day. Which month a
  -- leave year starts in is a tenant policy; the column records the answer rather than
  -- assuming January.
  year_start    date        not null,
  -- Half-days are real, so allocation is in halves rather than whole days.
  allocated_half_days integer not null,
  notes         text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint hr_entitlement_positive check (allocated_half_days >= 0)
);

create unique index if not exists hr_entitlement_unique
  on hr_leave_entitlements (tenant_id, employee_id, leave_type_id, year_start);

create table if not exists hr_leave_requests (
  id            uuid               primary key default gen_random_uuid(),
  tenant_id     uuid               not null references tenants(id) on delete restrict,
  employee_id   uuid               not null references hr_employees(id) on delete restrict,
  leave_type_id uuid               not null references hr_leave_types(id) on delete restrict,

  start_date    date               not null,
  end_date      date               not null,
  -- Counted in halves so a half-day is expressible without a fractional column.
  half_days     integer            not null,

  reason        text,
  status        hr_approval_status not null default 'DRAFT',
  requested_by  text,
  approved_by   text,
  approved_at   timestamptz,
  decision_note text,

  created_at    timestamptz        not null default now(),
  updated_at    timestamptz        not null default now(),

  constraint hr_leave_dates_ordered check (end_date >= start_date),
  constraint hr_leave_half_days_positive check (half_days > 0),
  constraint hr_leave_approved_shape check (
    (status = 'APPROVED' and approved_by is not null and approved_at is not null)
    or status <> 'APPROVED'
  ),
  -- A rejection that records no reason is a decision nobody can explain later.
  constraint hr_leave_rejected_shape check (
    status <> 'REJECTED' or length(btrim(coalesce(decision_note, ''))) > 0
  )
);

create index if not exists hr_leave_employee_idx
  on hr_leave_requests (tenant_id, employee_id, start_date desc);
create index if not exists hr_leave_status_idx
  on hr_leave_requests (tenant_id, status, start_date desc);

-- ---------------------------------------------------------------------
-- 7. Overtime
--
-- A record of its own, not a column on attendance, because the two answer different
-- questions and carry different authority: `hr_attendance.overtime_minutes` is what a
-- clock observed, and this is what a manager APPROVED to pay. Payroll consumes only the
-- second.
--
-- There is no rate and no multiplier. 1.5×, 2× and the statutory Indian position are all
-- unstated policy, and an invented multiplier in a payslip is a wrong number presented as
-- a right one. `rate_ref` names a salary component if a tenant has configured one; when it
-- is null the overtime is recorded, approved, and payable at whatever a person decides —
-- explicitly, rather than by a formula nobody chose.
-- ---------------------------------------------------------------------

create table if not exists hr_overtime (
  id            uuid               primary key default gen_random_uuid(),
  tenant_id     uuid               not null references tenants(id) on delete restrict,
  employee_id   uuid               not null references hr_employees(id) on delete restrict,

  overtime_date date               not null,
  minutes       integer            not null,
  property_id   text,
  reason        text               not null,
  rate_ref      text,

  status        hr_approval_status not null default 'DRAFT',
  approved_by   text,
  approved_at   timestamptz,
  created_by    text,
  created_at    timestamptz        not null default now(),
  updated_at    timestamptz        not null default now(),

  constraint hr_overtime_minutes_sane  check (minutes > 0 and minutes <= 1440),
  constraint hr_overtime_reason_present check (length(btrim(reason)) > 0),
  constraint hr_overtime_approved_shape check (
    (status = 'APPROVED' and approved_by is not null and approved_at is not null)
    or status <> 'APPROVED'
  )
);

create index if not exists hr_overtime_employee_idx
  on hr_overtime (tenant_id, employee_id, overtime_date desc);
create index if not exists hr_overtime_status_idx
  on hr_overtime (tenant_id, status, overtime_date desc);

-- ---------------------------------------------------------------------
-- 8. Employee advances
--
-- Money out to an employee, recovered later. The OUTSTANDING amount is never stored: it is
-- the advance minus what has been recovered, and recovery arrives from two places — a
-- payroll deduction line, and a direct repayment recorded as a finance payment. Storing a
-- balance would give this table a second opinion about a number finance already knows,
-- which is precisely the "second balance system" the brief forbids.
--
-- It is NOT a `finance_receivables` row, even though an employee who holds an advance owes
-- the business money. That table's counterparty is free text, so the link would be by
-- name, and its rows are readable by anyone with `finance.read` — which would put the
-- staff roster and their borrowing into a finance screen. The obligation lives here, under
-- HR capabilities; settlement lives in finance, where it belongs.
-- ---------------------------------------------------------------------

create table if not exists hr_employee_advances (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants(id) on delete restrict,
  employee_id  uuid        not null references hr_employees(id) on delete restrict,

  issued_on    date        not null,
  amount_minor bigint      not null,
  currency     char(3)     not null default 'INR',
  reason       text        not null,
  -- Halves, so a recovery plan can be stated without inventing an instalment schedule.
  notes        text,

  status       hr_approval_status not null default 'DRAFT',
  approved_by  text,
  approved_at  timestamptz,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint hr_advance_amount_positive check (amount_minor > 0),
  constraint hr_advance_reason_present  check (length(btrim(reason)) > 0),
  constraint hr_advance_approved_shape check (
    (status = 'APPROVED' and approved_by is not null and approved_at is not null)
    or status <> 'APPROVED'
  )
);

create index if not exists hr_advance_employee_idx
  on hr_employee_advances (tenant_id, employee_id, issued_on desc);
create index if not exists hr_advance_status_idx
  on hr_employee_advances (tenant_id, status, issued_on desc);

-- ---------------------------------------------------------------------
-- 9. Salary structures — effective-dated, never overwritten
--
-- A raise is a NEW ROW, not an UPDATE. `salary = 28000` written over `salary = 25000`
-- destroys the answer to "what were we paying in March?", which is the question every
-- payroll re-run and every dispute asks. `effective_to` is null for the current structure
-- and set when the next one begins.
--
-- Payroll resolves the structure whose range contains the period, so a mid-period change
-- is visible rather than silently applied to the whole month. Overlap is prevented in the
-- service rather than by an exclusion constraint, because `EXCLUDE USING gist` needs
-- btree_gist and this schema does not otherwise require an extension.
-- ---------------------------------------------------------------------

create table if not exists hr_salary_structures (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants(id) on delete restrict,
  employee_id    uuid        not null references hr_employees(id) on delete restrict,
  effective_from date        not null,
  effective_to   date,
  currency       char(3)     not null default 'INR',
  notes          text,
  created_by     text,
  created_at     timestamptz not null default now(),

  constraint hr_salary_range_ordered check (effective_to is null or effective_to >= effective_from)
);

create unique index if not exists hr_salary_effective_unique
  on hr_salary_structures (tenant_id, employee_id, effective_from);
create index if not exists hr_salary_employee_idx
  on hr_salary_structures (tenant_id, employee_id, effective_from desc);
-- At most one open-ended structure per employee: two would make "the current salary"
-- ambiguous, and the ambiguity would only surface in a payslip.
create unique index if not exists hr_salary_one_current
  on hr_salary_structures (tenant_id, employee_id) where effective_to is null;

/*
 * Components are explicit rows rather than a JSON blob, so gross and deductions are
 * summed by the database's own arithmetic and every element of a payslip is traceable to
 * a named line. `code` is the tenant's vocabulary — BASIC, HRA, CONVEYANCE, PF — and this
 * schema attaches no meaning to any of it. In particular PF, ESI, PT and TDS are ordinary
 * DEDUCTION components with amounts somebody entered; nothing here computes them.
 */
create table if not exists hr_salary_components (
  id           uuid              primary key default gen_random_uuid(),
  tenant_id    uuid              not null references tenants(id) on delete restrict,
  structure_id uuid              not null references hr_salary_structures(id) on delete cascade,
  code         text              not null,
  kind         hr_component_kind not null,
  amount_minor bigint            not null,
  created_at   timestamptz       not null default now(),

  constraint hr_component_code_present check (length(btrim(code)) > 0),
  constraint hr_component_amount_positive check (amount_minor > 0)
);

create unique index if not exists hr_component_unique
  on hr_salary_components (structure_id, upper(btrim(code)));
create index if not exists hr_component_tenant_idx
  on hr_salary_components (tenant_id, structure_id);

-- ---------------------------------------------------------------------
-- 10. Payroll
--
-- A run covers one calendar month for one tenant. Its lines are the obligations it
-- produces; settlement is finance's, and there is no PAID status here — see the enum.
-- ---------------------------------------------------------------------

create table if not exists hr_payroll_runs (
  id            uuid              primary key default gen_random_uuid(),
  tenant_id     uuid              not null references tenants(id) on delete restrict,
  -- The month, named by its first day — the same shape `finance_periods.period_start`
  -- uses, because the same period lock governs both.
  period_start  date              not null,
  status        hr_payroll_status not null default 'DRAFT',
  notes         text,

  created_by    text,
  calculated_at timestamptz,
  approved_by   text,
  approved_at   timestamptz,
  posted_by     text,
  posted_at     timestamptz,
  created_at    timestamptz       not null default now(),
  updated_at    timestamptz       not null default now(),

  constraint hr_payroll_month_start check (extract(day from period_start) = 1),
  constraint hr_payroll_approved_shape check (
    (status in ('APPROVED', 'POSTED') and approved_by is not null and approved_at is not null)
    or status not in ('APPROVED', 'POSTED')
  ),
  constraint hr_payroll_posted_shape check (
    (status = 'POSTED' and posted_by is not null and posted_at is not null)
    or status <> 'POSTED'
  )
);

-- One run per tenant per month. A second run for the same month would produce a second
-- set of obligations for the same salaries, which is how somebody gets paid twice.
create unique index if not exists hr_payroll_period_unique
  on hr_payroll_runs (tenant_id, period_start);
create index if not exists hr_payroll_status_idx
  on hr_payroll_runs (tenant_id, status, period_start desc);

/*
 * A payroll LINE is one employee's obligation for the period, and it keeps its inputs.
 *
 * `gross_minor`, `deductions_minor` and `net_minor` are recorded at calculation time
 * because a payslip must say what it said; the counts beside them — days worked, days on
 * leave, overtime minutes, days with no attendance record at all — are kept so the figure
 * is re-checkable rather than merely asserted. `unrecorded_days` is the honest one: a
 * period with gaps in its attendance produces a payroll line that SAYS so, instead of
 * quietly treating an unrecorded day as worked or as absent.
 */
create table if not exists hr_payroll_lines (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants(id) on delete restrict,
  run_id            uuid        not null references hr_payroll_runs(id) on delete cascade,
  employee_id       uuid        not null references hr_employees(id) on delete restrict,
  structure_id      uuid        references hr_salary_structures(id) on delete restrict,

  gross_minor       bigint      not null,
  deductions_minor  bigint      not null default 0,
  advance_recovery_minor bigint not null default 0,
  net_minor         bigint      not null,
  currency          char(3)     not null default 'INR',

  payable_days      integer     not null default 0,
  leave_days        integer     not null default 0,
  absent_days       integer     not null default 0,
  unrecorded_days   integer     not null default 0,
  overtime_minutes  integer     not null default 0,

  notes             text,
  created_at        timestamptz not null default now(),

  constraint hr_line_gross_sane      check (gross_minor >= 0),
  constraint hr_line_deductions_sane check (deductions_minor >= 0),
  constraint hr_line_recovery_sane   check (advance_recovery_minor >= 0),
  -- The arithmetic is asserted by the database as well as computed by the engine, so a
  -- line whose parts do not add up cannot be stored at all.
  constraint hr_line_net_consistent  check (
    net_minor = gross_minor - deductions_minor - advance_recovery_minor
  )
);

create unique index if not exists hr_line_employee_unique
  on hr_payroll_lines (run_id, employee_id);
create index if not exists hr_line_tenant_idx
  on hr_payroll_lines (tenant_id, run_id);
create index if not exists hr_line_employee_idx
  on hr_payroll_lines (tenant_id, employee_id);

-- ---------------------------------------------------------------------
-- 11. The finance handoff
--
-- A payroll line and an employee advance are things money settles against, exactly as a
-- vendor bill is. Rather than a second payment table, `finance_payments` gains two more
-- nullable targets — so settlement, its lifecycle, its period lock, its idempotency and
-- its audit are the ones finance already has, and there is one answer to "was this paid?".
--
-- A salary obligation could NOT have been a `finance_bills` row: that table requires
-- `vendor_id NOT NULL`, and making an employee a vendor would put the staff roster and
-- their pay into a screen every `finance.read` holder can open.
-- ---------------------------------------------------------------------

alter table finance_payments
  add column if not exists payroll_line_id uuid references hr_payroll_lines(id) on delete restrict;
alter table finance_payments
  add column if not exists employee_advance_id uuid references hr_employee_advances(id) on delete restrict;

-- The "at most one target" rule, restated across four columns. The old two-column check is
-- replaced rather than supplemented, so exactly one statement of the rule exists.
alter table finance_payments drop constraint if exists finance_payments_one_target;
alter table finance_payments add constraint finance_payments_one_target check (
  (case when bill_id             is not null then 1 else 0 end)
  + (case when receivable_id       is not null then 1 else 0 end)
  + (case when payroll_line_id     is not null then 1 else 0 end)
  + (case when employee_advance_id is not null then 1 else 0 end)
  <= 1
);

-- Direction must match what is being settled, for the new targets as for the old ones.
-- Salary and an advance both move money OUT; recovering an advance is a payroll deduction,
-- not an incoming payment, so there is no INCOMING case here.
alter table finance_payments drop constraint if exists finance_payments_direction_matches_target;
alter table finance_payments add constraint finance_payments_direction_matches_target check (
  (bill_id             is null or direction = 'OUTGOING')
  and (receivable_id       is null or direction = 'INCOMING')
  and (payroll_line_id     is null or direction = 'OUTGOING')
  and (employee_advance_id is null or direction = 'OUTGOING')
);

create index if not exists finance_payments_payroll_idx
  on finance_payments (tenant_id, payroll_line_id) where payroll_line_id is not null;
create index if not exists finance_payments_advance_idx
  on finance_payments (tenant_id, employee_advance_id) where employee_advance_id is not null;

-- ---------------------------------------------------------------------
-- Deny by default
--
-- Identical to tenants, tenant_workbooks and the finance tables: RLS on with no policy at
-- all, which denies everything to `anon` and `authenticated` outright. A policy would
-- imply a browser role is meant to read HR directly, and none is. The enforcement layer is
-- the repository, which takes a TenantContext on every method and has no method that
-- omits one; RLS is defence in depth and is never the boundary, because no test in this
-- project can reach it.
-- ---------------------------------------------------------------------

alter table hr_departments        enable row level security;
alter table hr_designations       enable row level security;
alter table hr_employees          enable row level security;
alter table hr_shifts             enable row level security;
alter table hr_holidays           enable row level security;
alter table hr_attendance         enable row level security;
alter table hr_leave_types        enable row level security;
alter table hr_leave_entitlements enable row level security;
alter table hr_leave_requests     enable row level security;
alter table hr_overtime           enable row level security;
alter table hr_employee_advances  enable row level security;
alter table hr_salary_structures  enable row level security;
alter table hr_salary_components  enable row level security;
alter table hr_payroll_runs       enable row level security;
alter table hr_payroll_lines      enable row level security;

revoke all on hr_departments        from authenticated, anon;
revoke all on hr_designations       from authenticated, anon;
revoke all on hr_employees          from authenticated, anon;
revoke all on hr_shifts             from authenticated, anon;
revoke all on hr_holidays           from authenticated, anon;
revoke all on hr_attendance         from authenticated, anon;
revoke all on hr_leave_types        from authenticated, anon;
revoke all on hr_leave_entitlements from authenticated, anon;
revoke all on hr_leave_requests     from authenticated, anon;
revoke all on hr_overtime           from authenticated, anon;
revoke all on hr_employee_advances  from authenticated, anon;
revoke all on hr_salary_structures  from authenticated, anon;
revoke all on hr_salary_components  from authenticated, anon;
revoke all on hr_payroll_runs       from authenticated, anon;
revoke all on hr_payroll_lines      from authenticated, anon;

-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT
--
-- shift roster            An employee has a default shift and an attendance row names the
--                         shift actually worked. A roster table is a scheduling product,
--                         and the brief asks for the minimum path Employee → Shift →
--                         Attendance → Payroll, which those two columns already give.
-- leave accrual           Earning leave monthly rather than receiving it annually is a
--                         policy nobody has stated. Entitlement is an allocation; accrual
--                         is a rule, and rules go in configuration.
-- statutory deductions    PF, ESI, PT, TDS, gratuity. Each is an ordinary DEDUCTION
--                         component once somebody specifies the rule. Computing one from
--                         a guess would be a wrong number on a payslip, presented as right.
-- overtime multiplier     Same reason. Approved overtime is recorded in minutes; what a
--                         minute is worth is unstated.
-- employee documents      Object storage is not provisioned. A metadata table nothing can
--                         write to is a schema for a feature that does not exist, and
--                         employee documents are the most sensitive thing this product
--                         would hold — they wait for a storage design with its own review.
-- bank account details    Payroll produces obligations; a payment rail settles them. A
--                         destination account belongs to that rail, under its own security
--                         review, not in a row this application selects with `select *`.
-- multi-property cost     An employee assigned to several properties has no defined cost
--   allocation            split, and inventing one would attribute salary to a property on
--                         no authority. Cost stays with the employee's primary property,
--                         or unattributed, and says which.
-- employee self-service   The role does not exist yet. The projection layer is built so it
--   role                  can be added without reshaping anything — see the architecture
--                         document — but a login nobody can obtain is not a feature.
-- ---------------------------------------------------------------------
