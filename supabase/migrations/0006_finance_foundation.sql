-- =====================================================================
-- M-DATA-1 — THE FINANCE FOUNDATION
--
-- ***  THE SCOPE RULE IS AMENDED HERE, DELIBERATELY AND FOR THE FIRST TIME.  ***
--
-- Migration 0001 opened with: "SCOPE RULE (non-negotiable): this database holds NO
-- business data … If this database were wiped, nothing about the business would be
-- lost — only identity and history." 0003 restated it unchanged. 0004 and 0005 kept
-- it: tenants, memberships and workbook bindings are control plane, not business.
--
-- This migration breaks it. `finance_vendors`, `finance_bills`, `finance_receivables`
-- and `finance_payments` ARE business data. Wiping this database would now lose a real
-- record of who is owed what.
--
-- THE AMENDED RULE, which every later migration should be read against:
--
--   The V1 workbook remains the authority for every financial fact it already records —
--   revenue, expenses, capex, rent, the cash journal, the P&L and investor
--   distributions. This database additionally holds the RELATIONAL finance facts a
--   spreadsheet cannot express: entities with identity, documents with a lifecycle, and
--   obligations with a running balance. A fact lives in exactly one of the two. Where
--   they touch, the workbook wins and this database holds a reference to it.
--
-- The test for whether a finance table belongs here is therefore no longer "is it
-- business data" but: "can the workbook express this fact correctly, and does it
-- already?" If yes, it stays in the workbook. Everything below fails that test — see
-- the itemised list at the foot of this file for what was refused on those grounds.
--
-- This amendment is recorded in docs/MDATA1_FINANCE_ARCHITECTURE.md §1 as well, because
-- a rule stated in one migration and broken in another is how architecture decays.
-- =====================================================================

-- ---------------------------------------------------------------------
-- WHAT THIS DOES NOT DO, AND WHY THAT IS THE DESIGN
--
-- It does not create a `finance_expenses` table, or a `finance_revenue` table, or a
-- general ledger. The V1 workbook already owns those facts and owns them well:
--
--   06_EXPENSES   Date, PropertyID, ExpenseCategory/Subcategory, Vendor, Amount, Tax,
--                 TotalAmount (a workbook formula), PaymentMethod, PaymentStatus,
--                 PaidDate, ExpenseType, InvoiceRef, ApprovedBy
--   05_REVENUE    GrossAmount, Discount, Tax, PlatformFee, OtherDeduction,
--                 NetRevenue (a workbook formula), PayoutStatus, PayoutDate,
--                 PaymentAccount, ReconCheck (a workbook formula)
--   09_CASH_FLOW  Date, Type, Category, PropertyID, RefID, MoneyIn, MoneyOut, Account,
--                 PaymentMethod, RunningBalance (a workbook formula), ReconStatus
--
-- Copying any of that into Postgres would create a second source of truth for a fact
-- that already has one, and would put this application in the position of recomputing
-- figures the workbook's own formulas own — the exact failure the contract layer exists
-- to prevent. So the workbook keeps what it has.
--
-- WHAT IT DOES CREATE is the set of finance concepts the workbook genuinely cannot
-- express, because a spreadsheet has rows but no relationships, no lifecycle and no
-- enforceable state:
--
--   1. A VENDOR as an entity. `06_EXPENSES.Vendor` is free text — two spellings are two
--      vendors, and there is nowhere to record payment terms or a GSTIN.
--   2. PAYABLES and RECEIVABLES with due dates and running balances. 18_MONTHLY_CLOSE
--      already carries `PayablesReviewed` and `ReceivablesReviewed` checkboxes, so the
--      business already reviews these monthly — against no register at all. This is the
--      clearest evidence in the workbook that the register is missing rather than
--      speculative.
--   3. A PAYMENT as a settlement event with a lifecycle and an approver. A cash-flow row
--      records that money moved; it cannot record that a payment was drafted, approved by
--      one person and posted by another, nor that ₹8,000 of a ₹20,000 bill is settled.
--   4. An ACCOUNTING PERIOD that can REFUSE a mutation. 18_MONTHLY_CLOSE is a review
--      checklist with a calculated status; a checkbox cannot decline a write. This lock
--      governs the FINANCE tables below and nothing else — the workbook's close checklist
--      remains the human process for the workbook's own domains, so the two do not
--      compete for authority over the same question.
--
-- MONEY is integer minor units (paise) in `bigint`, never a float and never `numeric`
-- read into a float. See lib/server/finance/money.ts for the single conversion boundary.
-- Every amount carries its currency, so an amount is money rather than a number.
--
-- TENANCY. Every table carries `tenant_id`, every index leads with it, and every unique
-- constraint is scoped by it — two tenants may both have a vendor called "Sri Balaji
-- Electricals" and both number a bill INV-001. RLS is on and every browser role is
-- revoked: the application reaches these tables with the service role, having already
-- verified membership, exactly as it does for `tenant_workbooks`.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------

do $$ begin
  create type finance_entity_status as enum ('ACTIVE', 'INACTIVE');
exception when duplicate_object then null; end $$;

-- The payment lifecycle. POSTED is terminal-and-effective; VOIDED cancels something that
-- never took effect; REVERSED undoes something that did. There is no DELETE anywhere in
-- this schema — financial history is append-only, and a correction is a new row that
-- points at what it corrects.
do $$ begin
  create type finance_payment_status as enum (
    'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'VOIDED', 'REVERSED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type finance_direction as enum ('INCOMING', 'OUTGOING');
exception when duplicate_object then null; end $$;

-- Deliberately NOT an enum of settlement state. Whether a bill is part-paid or settled is
-- ARITHMETIC over its payments, not a flag somebody remembers to update — a stored
-- SETTLED that disagrees with the payment rows is the classic finance defect, and it is
-- unrepresentable if the state is never stored. OPEN and VOID are the only lifecycle a
-- bill has of its own.
do $$ begin
  create type finance_obligation_status as enum ('OPEN', 'VOID');
exception when duplicate_object then null; end $$;

do $$ begin
  create type finance_period_status as enum ('OPEN', 'CLOSED');
exception when duplicate_object then null; end $$;

-- An expense belongs to one property, or to the business as a whole. Forcing every cost
-- onto a property is how corporate overhead gets silently attributed to whichever
-- property happens to be first in the list.
do $$ begin
  create type finance_attribution as enum ('PROPERTY', 'CORPORATE');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 1. Vendors
-- ---------------------------------------------------------------------

create table if not exists finance_vendors (
  id            uuid                  primary key default gen_random_uuid(),
  tenant_id     uuid                  not null references tenants(id) on delete restrict,
  display_name  text                  not null,
  -- Optional and deliberately unvalidated against any government service: format only.
  -- Tax treatment is a future controlled module; storing the number is not a claim to
  -- implement GST.
  gstin         text,
  -- A contact reference, not a contact database: a name, a desk phone, an ops email.
  -- Never a bank account, never a credential — see the note at the foot of this file.
  contact_ref   text,
  -- Net days. Null means "not agreed", which is different from zero.
  payment_terms_days integer,
  status        finance_entity_status not null default 'ACTIVE',
  notes         text,
  created_by    text,
  created_at    timestamptz           not null default now(),
  updated_at    timestamptz           not null default now(),

  constraint finance_vendors_name_present check (length(btrim(display_name)) > 0),
  constraint finance_vendors_terms_sane   check (payment_terms_days is null
                                                 or (payment_terms_days >= 0 and payment_terms_days <= 365)),
  constraint finance_vendors_gstin_shape  check (gstin is null
                                                 or gstin ~ '^[0-9A-Z]{15}$')
);

-- Scoped by tenant: two customers may each have a vendor of the same name, and neither
-- learns of the other by being refused.
create unique index if not exists finance_vendors_name_unique
  on finance_vendors (tenant_id, lower(btrim(display_name)));
create index if not exists finance_vendors_tenant_idx
  on finance_vendors (tenant_id, status, display_name);

-- ---------------------------------------------------------------------
-- 2. Payables — what this tenant owes
-- ---------------------------------------------------------------------

create table if not exists finance_bills (
  id            uuid                       primary key default gen_random_uuid(),
  tenant_id     uuid                       not null references tenants(id) on delete restrict,
  vendor_id     uuid                       not null references finance_vendors(id) on delete restrict,

  -- The vendor's own reference. Unique within a tenant and vendor so the same invoice is
  -- not entered twice, which is the commonest way a business pays a bill twice.
  bill_reference text                      not null,
  bill_date     date                       not null,
  due_date      date,

  -- PROPERTY costs name a property; CORPORATE costs must not. The check makes the two
  -- structurally distinguishable rather than relying on a null being read correctly.
  attribution   finance_attribution        not null default 'PROPERTY',
  -- The workbook's PropertyID (e.g. 'HYD-501'). TEXT, not a foreign key: properties live
  -- in the tenant's own workbook, which is exactly why a property reference can only ever
  -- be validated against the CALLER'S workbook and can never confirm that another
  -- tenant's property exists.
  property_id   text,

  -- Money, in paise. `tax_minor` is recorded separately because a payable is settled on
  -- the gross while the P&L treatment of the tax component is a future tax module.
  amount_minor  bigint                     not null,
  tax_minor     bigint                     not null default 0,
  currency      char(3)                    not null default 'INR',

  status        finance_obligation_status  not null default 'OPEN',
  description   text,
  created_by    text,
  created_at    timestamptz                not null default now(),
  updated_at    timestamptz                not null default now(),
  voided_at     timestamptz,
  voided_by     text,
  void_reason   text,

  constraint finance_bills_reference_present check (length(btrim(bill_reference)) > 0),
  -- A payable is a positive obligation. A negative one is a credit note, which is a
  -- different document and is not modelled yet.
  constraint finance_bills_amount_positive  check (amount_minor > 0),
  constraint finance_bills_tax_sane         check (tax_minor >= 0 and tax_minor <= amount_minor),
  constraint finance_bills_due_after_issue  check (due_date is null or due_date >= bill_date),
  constraint finance_bills_attribution_shape check (
    (attribution = 'PROPERTY'  and property_id is not null and length(btrim(property_id)) > 0)
    or
    (attribution = 'CORPORATE' and property_id is null)
  ),
  constraint finance_bills_void_reason check (
    (status = 'VOID' and voided_at is not null and length(btrim(coalesce(void_reason, ''))) > 0)
    or status <> 'VOID'
  )
);

create unique index if not exists finance_bills_reference_unique
  on finance_bills (tenant_id, vendor_id, lower(btrim(bill_reference)));
create index if not exists finance_bills_tenant_due_idx
  on finance_bills (tenant_id, status, due_date);
create index if not exists finance_bills_tenant_property_idx
  on finance_bills (tenant_id, property_id, bill_date desc);

-- ---------------------------------------------------------------------
-- 3. Receivables — what others owe this tenant
--
-- Separate from payables rather than one signed table. They are answered by different
-- people, chased differently, and reviewed on different lines of 18_MONTHLY_CLOSE; one
-- table with a direction column would need a `where` clause on every single query, and a
-- forgotten one would show a debt as an asset.
--
-- *** AN OTA PAYOUT IS NOT A RECEIVABLE, and must never be entered as one. ***
--
-- 04_RESERVATIONS already models that chain end to end, and models it in workbook
-- formulas this application is forbidden to overwrite: GrossBookingValue -> EstPlatformFee
-- -> ExpectedPayout -> ActualPayout -> PayoutVariance -> PayoutStatus. Duplicating it here
-- would be a second, divergent answer to a question that already has an authoritative one.
--
-- The evidence that a receivables register is nonetheless missing rather than redundant is
-- in the close checklist itself: 18_MONTHLY_CLOSE carries `OtaPayoutsReconciled` AND
-- `ReceivablesReviewed` as SEPARATE lines. The business already distinguishes the two, and
-- reviews the second every month against no register at all.
--
-- So this table is for what the workbook does not model: a direct-booking guest balance, a
-- corporate account, a damage recovery, a deposit owed back. `booking_ref` links to a
-- workbook booking where one exists; it does not import that booking's payout arithmetic.
-- ---------------------------------------------------------------------

create table if not exists finance_receivables (
  id            uuid                       primary key default gen_random_uuid(),
  tenant_id     uuid                       not null references tenants(id) on delete restrict,

  -- Who owes it, as free text: a guest, an OTA, a corporate account. NOT a guest record —
  -- this product has no guest entity and deliberately does not acquire one here.
  counterparty  text                       not null,
  -- The workbook booking this arises from, when it arises from one. Text for the same
  -- reason property_id is: bookings live in the tenant's workbook.
  booking_ref   text,

  reference     text                       not null,
  issued_date   date                       not null,
  due_date      date,

  attribution   finance_attribution        not null default 'PROPERTY',
  property_id   text,

  amount_minor  bigint                     not null,
  tax_minor     bigint                     not null default 0,
  currency      char(3)                    not null default 'INR',

  status        finance_obligation_status  not null default 'OPEN',
  description   text,
  created_by    text,
  created_at    timestamptz                not null default now(),
  updated_at    timestamptz                not null default now(),
  voided_at     timestamptz,
  voided_by     text,
  void_reason   text,

  constraint finance_receivables_counterparty_present check (length(btrim(counterparty)) > 0),
  constraint finance_receivables_reference_present    check (length(btrim(reference)) > 0),
  constraint finance_receivables_amount_positive      check (amount_minor > 0),
  constraint finance_receivables_tax_sane             check (tax_minor >= 0 and tax_minor <= amount_minor),
  constraint finance_receivables_due_after_issue      check (due_date is null or due_date >= issued_date),
  constraint finance_receivables_attribution_shape check (
    (attribution = 'PROPERTY'  and property_id is not null and length(btrim(property_id)) > 0)
    or
    (attribution = 'CORPORATE' and property_id is null)
  ),
  constraint finance_receivables_void_reason check (
    (status = 'VOID' and voided_at is not null and length(btrim(coalesce(void_reason, ''))) > 0)
    or status <> 'VOID'
  )
);

create unique index if not exists finance_receivables_reference_unique
  on finance_receivables (tenant_id, lower(btrim(reference)));
create index if not exists finance_receivables_tenant_due_idx
  on finance_receivables (tenant_id, status, due_date);
create index if not exists finance_receivables_tenant_booking_idx
  on finance_receivables (tenant_id, booking_ref);

-- ---------------------------------------------------------------------
-- 4. Payments — settlement events
--
-- A payment is NOT revenue and NOT an expense, and conflating them is the commonest
-- financial modelling error in hospitality software:
--
--   revenue   a stay was sold           (05_REVENUE — when it was earned)
--   expense   a cost was incurred       (06_EXPENSES — when it was incurred)
--   payment   money actually moved      (here — when it settled, and against what)
--
-- An OTA booking earns revenue in March and pays out in April, less commission. Three
-- different facts on three different dates. This table records only the third.
-- ---------------------------------------------------------------------

create table if not exists finance_payments (
  id            uuid                   primary key default gen_random_uuid(),
  tenant_id     uuid                   not null references tenants(id) on delete restrict,

  direction     finance_direction      not null,
  amount_minor  bigint                 not null,
  currency      char(3)                not null default 'INR',
  paid_on       date                   not null,

  -- What it settles. At most one — a payment that settled both a payable and a
  -- receivable is two payments, and the constraint says so.
  bill_id       uuid                   references finance_bills(id)       on delete restrict,
  receivable_id uuid                   references finance_receivables(id) on delete restrict,

  attribution   finance_attribution    not null default 'CORPORATE',
  property_id   text,

  -- The tenant's account and instrument, as the vocabulary the workbook already uses
  -- (09_CASH_FLOW.Account and .PaymentMethod are list-ranges owned by 02_SETTINGS). Kept
  -- as text so the workbook stays the single vocabulary rather than this table becoming a
  -- second, divergent list.
  account_ref   text,
  method_ref    text,
  -- The 09_CASH_FLOW TxnID this movement was recorded as, once it has been. Null until
  -- then. This is the join between the settlement and the workbook's cash journal, and it
  -- is what a future reconciliation compares.
  cashflow_ref  text,
  external_ref  text,

  status        finance_payment_status not null default 'DRAFT',
  -- REVERSED payments point at the payment that reverses them, so history is a chain
  -- rather than an edit. A row is never deleted and an amount is never rewritten.
  reverses_id   uuid                   references finance_payments(id) on delete restrict,

  notes         text,
  created_by    text,
  approved_by   text,
  approved_at   timestamptz,
  posted_at     timestamptz,
  created_at    timestamptz            not null default now(),
  updated_at    timestamptz            not null default now(),

  constraint finance_payments_amount_positive check (amount_minor > 0),
  constraint finance_payments_one_target check (
    not (bill_id is not null and receivable_id is not null)
  ),
  -- A payable is settled by money going out; a receivable by money coming in. The reverse
  -- of either is a data-entry error that would silently invert a balance.
  constraint finance_payments_direction_matches_target check (
    (bill_id       is null or direction = 'OUTGOING')
    and
    (receivable_id is null or direction = 'INCOMING')
  ),
  constraint finance_payments_attribution_shape check (
    (attribution = 'PROPERTY'  and property_id is not null and length(btrim(property_id)) > 0)
    or
    (attribution = 'CORPORATE' and property_id is null)
  ),
  constraint finance_payments_approved_shape check (
    (status in ('APPROVED', 'POSTED') and approved_by is not null and approved_at is not null)
    or status not in ('APPROVED', 'POSTED')
  ),
  constraint finance_payments_posted_shape check (
    (status = 'POSTED' and posted_at is not null) or status <> 'POSTED'
  )
);

create index if not exists finance_payments_tenant_date_idx
  on finance_payments (tenant_id, paid_on desc);
create index if not exists finance_payments_tenant_status_idx
  on finance_payments (tenant_id, status, paid_on desc);
-- The settlement lookups: "how much of this bill is paid?" leads with the tenant even
-- though bill_id is already unique to one, so a query that forgot its tenant predicate
-- cannot ride this index and will be slow enough to notice.
create index if not exists finance_payments_bill_idx
  on finance_payments (tenant_id, bill_id) where bill_id is not null;
create index if not exists finance_payments_receivable_idx
  on finance_payments (tenant_id, receivable_id) where receivable_id is not null;
create index if not exists finance_payments_tenant_property_idx
  on finance_payments (tenant_id, property_id, paid_on desc);

-- ---------------------------------------------------------------------
-- 5. Accounting periods
--
-- One row per tenant per calendar month. A CLOSED period refuses finance mutations dated
-- within it; reopening is a privileged, audited act that records who and why. The
-- workbook's 18_MONTHLY_CLOSE remains the human review checklist — this is the
-- enforcement, because a checkbox cannot decline a write.
-- ---------------------------------------------------------------------

create table if not exists finance_periods (
  tenant_id     uuid                  not null references tenants(id) on delete restrict,
  -- The first day of the month it names. A date rather than a text key so ordering and
  -- range containment are the database's job.
  period_start  date                  not null,
  status        finance_period_status not null default 'OPEN',
  closed_at     timestamptz,
  closed_by     text,
  reopened_at   timestamptz,
  reopened_by   text,
  reopen_reason text,
  created_at    timestamptz           not null default now(),
  updated_at    timestamptz           not null default now(),

  primary key (tenant_id, period_start),

  constraint finance_periods_month_start check (extract(day from period_start) = 1),
  constraint finance_periods_closed_shape check (
    (status = 'CLOSED' and closed_at is not null and closed_by is not null)
    or status <> 'CLOSED'
  ),
  -- Reopening without a recorded reason is exactly the act that most needs one.
  constraint finance_periods_reopen_shape check (
    reopened_at is null
    or (reopened_by is not null and length(btrim(coalesce(reopen_reason, ''))) > 0)
  )
);

create index if not exists finance_periods_tenant_idx
  on finance_periods (tenant_id, period_start desc);

-- ---------------------------------------------------------------------
-- Deny by default
--
-- Identical to tenants and tenant_workbooks: RLS on, every browser role revoked. The
-- application reaches these tables with the service role having ALREADY verified
-- membership, so the enforcement layer is the repository — which is why every finance
-- repository takes a TenantContext and there is no method that omits it. See
-- lib/server/finance/repository.ts and the isolation suite that proves it.
--
-- RLS is enabled with no policy at all, which denies everything to `anon` and
-- `authenticated` outright. That is deliberate: a policy would imply a browser role is
-- meant to read finance directly, and none is.
-- ---------------------------------------------------------------------

alter table finance_vendors     enable row level security;
alter table finance_bills       enable row level security;
alter table finance_receivables enable row level security;
alter table finance_payments    enable row level security;
alter table finance_periods     enable row level security;

revoke all on finance_vendors     from authenticated, anon;
revoke all on finance_bills       from authenticated, anon;
revoke all on finance_receivables from authenticated, anon;
revoke all on finance_payments    from authenticated, anon;
revoke all on finance_periods     from authenticated, anon;

-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT
--
-- expense / revenue tables   The workbook owns these facts. Duplicating them would create
--                            a second source of truth and put this application in the
--                            business of recomputing figures a workbook formula owns.
-- a general ledger           09_CASH_FLOW is the money journal, with RunningBalance as a
--                            workbook formula. A double-entry ledger is a statutory
--                            accounting decision nobody has made.
-- expense_categories         02_SETTINGS already supplies the category vocabulary as a
--                            list-range. A second list would drift from the first.
-- finance_accounts /
--   payment_methods          Same reason: 09_CASH_FLOW.Account and .PaymentMethod are
--                            already list-ranges owned by the workbook.
-- budgets                    No requirement exists, and a budget without a planning
--                            process is a table nobody writes to.
-- reconciliations            Reconciliation needs a bank statement to reconcile against.
--                            No banking integration exists or is configured, and building
--                            a fake one would be worse than not having it. The foundation
--                            it needs is `finance_payments.cashflow_ref`, which is here.
-- units                      The property hierarchy is deferred by M-SAAS-1 and blocked on
--                            a business decision about what a "property" is.
-- attachments                Receipts and invoices need object storage, and no bucket is
--                            provisioned. A metadata table nothing can write to is a
--                            schema for a feature that does not exist; 06_EXPENSES.DriveLink
--                            and 07_CAPEX.DriveLink remain the interim answer. The shape it
--                            should take is recorded in the architecture document instead.
--
-- NO CREDENTIAL OF ANY KIND belongs in these tables. Not a bank account number, not a
-- card PAN, not a CVV, not a gateway secret, not a UPI PIN. `account_ref` and `method_ref`
-- are the workbook's own vocabulary ("HDFC Current", "UPI"); `external_ref` is a
-- transaction reference a bank statement would also show. If a future integration needs a
-- secret, it belongs in the deployment environment or a secret manager, never in a row.
-- ---------------------------------------------------------------------
