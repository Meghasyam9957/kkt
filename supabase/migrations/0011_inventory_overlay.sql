-- =====================================================================
-- M-INV-1 — INVENTORY CONTEXT, PROCUREMENT, AND THE VENDOR BEHIND A NAME
--
-- SCOPE RULE — no amendment needed. 0006 stated it and every migration since has stayed
-- inside it: the workbook keeps every fact it already records; this database holds the
-- relational facts a spreadsheet cannot express.
--
-- ---------------------------------------------------------------------
-- WHAT 15_INVENTORY ACTUALLY IS, having read it rather than assumed it
--
--   ItemID(in) PropertyID(in) Category(in) Item(in) Unit(in)
--   OpeningStock(in) Purchased(in) Used(in)
--   CurrentStock(CALC) MinStock(in) ReorderStatus(CALC)
--   LastPurchaseDate(in) LastPurchaseCost(in) Vendor(TEXT, in) Notes(in)
--
-- It is a PER-ITEM SNAPSHOT, not a ledger. `Purchased` and `Used` are RUNNING TOTALS, and
-- `CurrentStock` is a spreadsheet formula over them. No code in this application computes a
-- balance — verified by search — so there is exactly one stock ledger today and it is the
-- workbook's.
--
-- THAT IS ALSO ITS LIMIT. Because there is no row per movement, the workbook cannot answer:
--
--   who consumed it        two towels left; nobody knows whose hands
--   why                    a turnover, a breakage and a theft all just decrement `Used`
--   against which task     HK-D-0044 is invisible to the stock record
--   at whose instruction   an adjustment has no author
--
-- Those four are what this migration adds, and ONLY those four.
--
-- ---------------------------------------------------------------------
-- AUTHORITY, stated so the two stores cannot both claim the same fact
--
--   the workbook  owns HOW MUCH EXISTS. OpeningStock, Purchased, Used, the calculated
--                 CurrentStock and ReorderStatus, MinStock, the last purchase, and the
--                 vendor NAME. Every change to it still goes through the existing verified
--                 `inventory.update` mutation, which cannot write a calculated column.
--   this schema   owns WHO CAUSED A MOVEMENT AND WHY, the procurement workflow that
--                 precedes a purchase, and which vendor entity a workbook name refers to.
--
-- THE ECHOED QUANTITY, and why it is not a second ledger.
--
-- `inv_movements.quantity` stores the amount a movement moved. That is a copy of something
-- the workbook also knows, and it is worth being exact about why it is here and what it is
-- forbidden from becoming:
--
--   it IS      the size of one recorded event, so that "Ravi took two towels for HK-D-0044"
--              is a sentence this database can say. Without it the context is meaningless —
--              a reason with no magnitude explains nothing.
--   it IS NOT  a balance. Nothing here sums it into a stock level, no view derives one, and
--              no column anywhere in this schema holds a current quantity. `CurrentStock`
--              has exactly one home and this is not it.
--
-- The sum of these events is compared AGAINST the workbook's totals by reconciliation, and
-- a disagreement is REPORTED rather than resolved. That is the whole reason to keep the
-- number: a copy you never compare is a lie waiting to happen; a copy you do compare is
-- the only way to notice one.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Which vendor a workbook name means
--
-- 15_INVENTORY.Vendor, 16_ASSETS.Vendor and 06_EXPENSES.Vendor are all free TEXT, and
-- `finance_vendors` already holds the vendor entity with its terms and status. There is no
-- link between them, so "Sharma Supplies" on a stock row and the vendor a bill is raised
-- against are, to this system, unrelated strings.
--
-- This is the same shape M-OPS-2 used for a cleaner's name, for the same reason: the sheet
-- keeps the name because the business reads the sheet, and the overlay says who it is.
-- NO SECOND VENDOR TABLE — `finance_vendors` remains the only vendor identity.
-- ---------------------------------------------------------------------

create table if not exists inv_vendor_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  -- The name exactly as the workbook cell holds it, lower-cased for matching. Two spellings
  -- of one supplier are two links, which is honest: nobody has said they are the same.
  vendor_name   text not null,
  vendor_id     uuid not null,
  linked_by     text,
  created_at    timestamptz not null default now(),

  constraint inv_vendor_links_name_present check (length(btrim(vendor_name)) > 0),
  constraint inv_vendor_links_vendor_fk
    foreign key (tenant_id, vendor_id) references finance_vendors (tenant_id, id)
    on delete restrict
);

-- One meaning per name per tenant. A second meaning is a decision, not an accident.
create unique index if not exists inv_vendor_links_name_unique
  on inv_vendor_links (tenant_id, lower(btrim(vendor_name)));
create index if not exists inv_vendor_links_vendor_idx
  on inv_vendor_links (tenant_id, vendor_id);

-- ---------------------------------------------------------------------
-- 2. Movement context
--
-- The vocabulary is NEW, and deliberately so: the workbook has no movement type at all, so
-- there is nothing to map onto. It is kept small and operational — every value names a thing
-- that actually happens in a homestay, and none of them is an accounting term.
-- ---------------------------------------------------------------------

do $$ begin
  create type inv_movement_type as enum (
    'PURCHASE',      -- stock arrived, normally through a goods receipt
    'CONSUMPTION',   -- used doing the work: a turnover, a repair
    'TRANSFER_OUT',  -- left this property for another
    'TRANSFER_IN',   -- arrived from another property
    'ADJUSTMENT',    -- a count correction, and it must say why
    'WASTAGE',       -- gone, and not into a guest room
    'RETURN'         -- went back to the supplier
  );
exception when duplicate_object then null; end $$;

do $$ begin
  -- Why something was written off. `ADJUSTMENT` as a catch-all with no reason is how a
  -- shrinking stock level stops being a question anybody asks.
  create type inv_wastage_reason as enum ('DAMAGED', 'LOST', 'EXPIRED', 'BROKEN', 'OTHER');
exception when duplicate_object then null; end $$;

create table if not exists inv_movements (
  id             uuid not null default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete restrict,

  -- The workbook's own ItemID. A reference, never a copy of the item: the name, category,
  -- unit and stock level all stay in 15_INVENTORY.
  item_ref       text not null,
  property_id    text,

  movement_type  inv_movement_type not null,
  -- The size of THIS event. Never summed into a balance anywhere in this schema.
  quantity       numeric(14, 3) not null,

  -- WHO. An employee id, not a name — the M-OPS-2 rule, for the same reasons.
  employee_id    uuid,
  -- WHICH WORK. The workbook's own task reference, when the movement had a task.
  task_type      ops_task_type,
  task_ref       text,

  -- WHY. Free text for the operator, plus a coded reason where one is required.
  reason         text,
  wastage_reason inv_wastage_reason,
  -- Where a transfer went to or came from. A property id from the caller's own workbook.
  counterparty_property_id text,

  /*
   * DID THE AUTHORITATIVE WRITE LAND?
   *
   * Stock is the workbook's, so the sheet is written FIRST and this row records whether that
   * succeeded. A context row claiming a movement the workbook never saw would be a second
   * ledger in the worst possible way — one that is wrong. False here means "we recorded the
   * intent and the sheet did not take it", which reconciliation reports and a person repairs.
   */
  workbook_applied boolean not null default false,
  applied_at     timestamptz,

  created_by     text,
  created_at     timestamptz not null default now(),

  constraint inv_movements_pkey primary key (id),
  constraint inv_movements_item_present check (length(btrim(item_ref)) > 0),
  -- A movement of nothing is not a movement. Direction is carried by the TYPE, never by a
  -- negative number, so that "minus a wastage" can never mean "plus some stock".
  constraint inv_movements_quantity_positive check (quantity > 0),
  -- Wastage has to say what happened to it.
  constraint inv_movements_wastage_reason check (
    (movement_type = 'WASTAGE' and wastage_reason is not null)
    or (movement_type <> 'WASTAGE' and wastage_reason is null)),
  -- An adjustment has to say why in words. This is the high-risk movement.
  constraint inv_movements_adjustment_reason check (
    movement_type <> 'ADJUSTMENT' or length(btrim(coalesce(reason, ''))) > 0),
  -- A transfer names the other end.
  constraint inv_movements_transfer_counterparty check (
    (movement_type in ('TRANSFER_IN', 'TRANSFER_OUT')
      and counterparty_property_id is not null)
    or (movement_type not in ('TRANSFER_IN', 'TRANSFER_OUT')
      and counterparty_property_id is null)),
  -- A task reference and its type travel together or not at all.
  constraint inv_movements_task_pair check (
    (task_type is null and task_ref is null)
    or (task_type is not null and task_ref is not null)),
  constraint inv_movements_applied_at check (
    (workbook_applied and applied_at is not null)
    or (not workbook_applied and applied_at is null)),
  -- Composite: an employee from another tenant cannot be attributed a movement here.
  constraint inv_movements_employee_fk
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id)
    on delete restrict,
  constraint inv_movements_tenant_row_unique unique (tenant_id, id)
);

create index if not exists inv_movements_item_idx
  on inv_movements (tenant_id, item_ref, created_at desc);
create index if not exists inv_movements_property_idx
  on inv_movements (tenant_id, property_id, created_at desc) where property_id is not null;
create index if not exists inv_movements_task_idx
  on inv_movements (tenant_id, task_type, task_ref) where task_ref is not null;
create index if not exists inv_movements_employee_idx
  on inv_movements (tenant_id, employee_id, created_at desc) where employee_id is not null;
-- The repair queue: movements whose sheet write never landed.
create index if not exists inv_movements_unapplied_idx
  on inv_movements (tenant_id, created_at desc) where not workbook_applied;

-- ---------------------------------------------------------------------
-- 3. Procurement — the workflow that PRECEDES a purchase
--
-- The workbook records that stock arrived (`Purchased`, `LastPurchaseDate`, `LastCost`). It
-- has no notion of asking for something, of somebody approving it, of an order placed, or of
-- what was actually delivered against what was ordered. None of that is stock, which is why
-- none of it belongs in the sheet — and all of it is why a purchase currently has no story.
--
-- WHAT THIS IS NOT: a second finance system. No payable is created here, no bill, no payment
-- and no expense. A goods receipt records that things ARRIVED. Whether money is owed is
-- `finance_bills`, and a person decides it.
-- ---------------------------------------------------------------------

do $$ begin
  create type inv_request_status as enum (
    'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type inv_po_status as enum (
    'DRAFT', 'SUBMITTED', 'APPROVED', 'SENT',
    'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
exception when duplicate_object then null; end $$;

create table if not exists inv_purchase_requests (
  id           uuid not null default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete restrict,
  property_id  text,
  status       inv_request_status not null default 'DRAFT',
  -- Operational urgency, in the words the maintenance board already uses.
  priority     text not null default 'Medium',
  reason       text,
  requested_by text not null,
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  /*
   * SEPARATION OF DUTY. Whoever approves must not be whoever asked — checked here as well as
   * in the service, because a rule that lives only in application code is a rule that holds
   * only while every path remembers it.
   */
  approved_by  text,
  approved_at  timestamptz,
  decision_note text,
  updated_at   timestamptz not null default now(),

  constraint inv_purchase_requests_pkey primary key (id),
  constraint inv_purchase_requests_requester check (length(btrim(requested_by)) > 0),
  constraint inv_purchase_requests_no_self_approval check (
    approved_by is null or btrim(lower(approved_by)) <> btrim(lower(requested_by))),
  constraint inv_purchase_requests_decided check (
    (status in ('APPROVED', 'REJECTED') and approved_by is not null and approved_at is not null)
    or status not in ('APPROVED', 'REJECTED')),
  constraint inv_purchase_requests_tenant_row_unique unique (tenant_id, id)
);

create index if not exists inv_purchase_requests_status_idx
  on inv_purchase_requests (tenant_id, status, created_at desc);

create table if not exists inv_purchase_request_lines (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  request_id  uuid not null,
  -- An existing workbook item, or a description of something not yet stocked.
  item_ref    text,
  description text,
  quantity    numeric(14, 3) not null,
  unit        text,
  notes       text,

  constraint inv_purchase_request_lines_pkey primary key (id),
  constraint inv_purchase_request_lines_quantity check (quantity > 0),
  constraint inv_purchase_request_lines_names_something check (
    item_ref is not null or length(btrim(coalesce(description, ''))) > 0),
  constraint inv_purchase_request_lines_request_fk
    foreign key (tenant_id, request_id) references inv_purchase_requests (tenant_id, id)
    on delete cascade,
  constraint inv_purchase_request_lines_tenant_row_unique unique (tenant_id, id)
);

create index if not exists inv_purchase_request_lines_request_idx
  on inv_purchase_request_lines (tenant_id, request_id);

create table if not exists inv_purchase_orders (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  -- The vendor entity finance already knows. Not a name, and not a second supplier master.
  vendor_id     uuid not null,
  property_id   text,
  request_id    uuid,
  status        inv_po_status not null default 'DRAFT',
  order_date    date,
  expected_date date,
  notes         text,
  created_by    text not null,
  approved_by   text,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint inv_purchase_orders_pkey primary key (id),
  constraint inv_purchase_orders_creator check (length(btrim(created_by)) > 0),
  constraint inv_purchase_orders_no_self_approval check (
    approved_by is null or btrim(lower(approved_by)) <> btrim(lower(created_by))),
  constraint inv_purchase_orders_expected_after_order check (
    expected_date is null or order_date is null or expected_date >= order_date),
  constraint inv_purchase_orders_vendor_fk
    foreign key (tenant_id, vendor_id) references finance_vendors (tenant_id, id)
    on delete restrict,
  constraint inv_purchase_orders_request_fk
    foreign key (tenant_id, request_id) references inv_purchase_requests (tenant_id, id)
    on delete restrict,
  constraint inv_purchase_orders_tenant_row_unique unique (tenant_id, id)
);

create index if not exists inv_purchase_orders_status_idx
  on inv_purchase_orders (tenant_id, status, created_at desc);
create index if not exists inv_purchase_orders_vendor_idx
  on inv_purchase_orders (tenant_id, vendor_id);

create table if not exists inv_purchase_order_lines (
  id           uuid not null default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete restrict,
  po_id        uuid not null,
  item_ref     text,
  description  text,
  quantity     numeric(14, 3) not null,
  unit         text,
  /*
   * Expected price, in paise, exactly like every other money column in this schema — integer
   * minor units, never a float. NULLABLE because a purchase order can legitimately be placed
   * before a price is agreed, and inventing a zero would be a figure nobody quoted.
   *
   * It is an EXPECTATION, not a payable. What is owed is a `finance_bills` row and a person
   * raises it.
   */
  expected_unit_price_minor bigint,

  constraint inv_purchase_order_lines_pkey primary key (id),
  constraint inv_purchase_order_lines_quantity check (quantity > 0),
  constraint inv_purchase_order_lines_price_sane check (
    expected_unit_price_minor is null or expected_unit_price_minor >= 0),
  constraint inv_purchase_order_lines_names_something check (
    item_ref is not null or length(btrim(coalesce(description, ''))) > 0),
  constraint inv_purchase_order_lines_po_fk
    foreign key (tenant_id, po_id) references inv_purchase_orders (tenant_id, id)
    on delete cascade,
  constraint inv_purchase_order_lines_tenant_row_unique unique (tenant_id, id)
);

create index if not exists inv_purchase_order_lines_po_idx
  on inv_purchase_order_lines (tenant_id, po_id);

-- ---------------------------------------------------------------------
-- 4. Goods receipt — the only event that may increase stock
--
-- A purchase order is a promise. Stock arriving is a fact, and they are routinely different:
-- part of an order turns up, some of it is damaged, some never comes. Treating a placed order
-- as received stock is the single most common way an inventory system starts lying.
-- ---------------------------------------------------------------------

create table if not exists inv_goods_receipts (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  po_id       uuid not null,
  property_id text,
  received_by text not null,
  received_at timestamptz not null default now(),
  notes       text,
  created_at  timestamptz not null default now(),

  constraint inv_goods_receipts_pkey primary key (id),
  constraint inv_goods_receipts_receiver check (length(btrim(received_by)) > 0),
  constraint inv_goods_receipts_po_fk
    foreign key (tenant_id, po_id) references inv_purchase_orders (tenant_id, id)
    on delete restrict,
  constraint inv_goods_receipts_tenant_row_unique unique (tenant_id, id)
);

create index if not exists inv_goods_receipts_po_idx
  on inv_goods_receipts (tenant_id, po_id, received_at desc);

create table if not exists inv_goods_receipt_lines (
  id                uuid not null default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete restrict,
  receipt_id        uuid not null,
  po_line_id        uuid not null,
  received_quantity numeric(14, 3) not null,
  -- The workbook's own CONDITION vocabulary: New / Good / Fair / Poor / Broken.
  condition         text,
  notes             text,
  /*
   * The movement this receipt caused, once the workbook write has landed. Nullable because
   * the sheet write can fail — and when it does, this stays null and the receipt is visibly
   * incomplete rather than silently claiming stock arrived.
   */
  movement_id       uuid,

  constraint inv_goods_receipt_lines_pkey primary key (id),
  constraint inv_goods_receipt_lines_quantity check (received_quantity > 0),
  constraint inv_goods_receipt_lines_receipt_fk
    foreign key (tenant_id, receipt_id) references inv_goods_receipts (tenant_id, id)
    on delete cascade,
  constraint inv_goods_receipt_lines_po_line_fk
    foreign key (tenant_id, po_line_id) references inv_purchase_order_lines (tenant_id, id)
    on delete restrict,
  constraint inv_goods_receipt_lines_movement_fk
    foreign key (tenant_id, movement_id) references inv_movements (tenant_id, id)
    on delete restrict,
  constraint inv_goods_receipt_lines_tenant_row_unique unique (tenant_id, id)
);

create index if not exists inv_goods_receipt_lines_receipt_idx
  on inv_goods_receipt_lines (tenant_id, receipt_id);

-- ---------------------------------------------------------------------
-- 5. An asset's maintenance history, as references rather than prose
--
-- 16_ASSETS ALREADY EXISTS and is a complete asset register: AssetID, PropertyID, Category,
-- Asset, PurchaseDate, PurchaseCost, Vendor, WarrantyExpiry, UsefulLifeMonths, Condition,
-- CurrentStatus (In Use / In Storage / Under Repair / Disposed), WarrantyStatus (CALC),
-- MaintenanceHistory, DisposalDate, Notes.
--
-- SO NO ASSET TABLE IS CREATED HERE. The register is the workbook's, it stays the workbook's,
-- and this milestone surfaces it rather than copying it. A second asset master would be
-- exactly the "second maintenance system" the brief forbids.
--
-- What the sheet cannot express is the LINK: `MaintenanceHistory` is a free-text cell, so
-- "which tickets has this air-conditioner had?" is a question only a human reading prose can
-- answer. This table answers it in references.
-- ---------------------------------------------------------------------

create table if not exists inv_asset_maintenance_links (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  -- 16_ASSETS.AssetID and 14_MAINTENANCE.TicketID. Both stay where they are.
  asset_ref   text not null,
  ticket_ref  text not null,
  linked_by   text,
  note        text,
  created_at  timestamptz not null default now(),

  constraint inv_asset_maintenance_links_pkey primary key (id),
  constraint inv_asset_maintenance_links_asset check (length(btrim(asset_ref)) > 0),
  constraint inv_asset_maintenance_links_ticket check (length(btrim(ticket_ref)) > 0),
  constraint inv_asset_maintenance_links_tenant_row_unique unique (tenant_id, id)
);

-- One link per pair. Linking the same ticket twice says nothing new.
create unique index if not exists inv_asset_maintenance_links_pair
  on inv_asset_maintenance_links (tenant_id, asset_ref, ticket_ref);
create index if not exists inv_asset_maintenance_links_asset_idx
  on inv_asset_maintenance_links (tenant_id, asset_ref, created_at desc);

-- ---------------------------------------------------------------------
-- 6. Deny by default — identical to every other table in this schema
-- ---------------------------------------------------------------------

alter table inv_vendor_links             enable row level security;
alter table inv_movements                enable row level security;
alter table inv_purchase_requests        enable row level security;
alter table inv_purchase_request_lines   enable row level security;
alter table inv_purchase_orders          enable row level security;
alter table inv_purchase_order_lines     enable row level security;
alter table inv_goods_receipts           enable row level security;
alter table inv_goods_receipt_lines      enable row level security;
alter table inv_asset_maintenance_links  enable row level security;

revoke all on inv_vendor_links             from authenticated, anon;
revoke all on inv_movements                from authenticated, anon;
revoke all on inv_purchase_requests        from authenticated, anon;
revoke all on inv_purchase_request_lines   from authenticated, anon;
revoke all on inv_purchase_orders          from authenticated, anon;
revoke all on inv_purchase_order_lines     from authenticated, anon;
revoke all on inv_goods_receipts           from authenticated, anon;
revoke all on inv_goods_receipt_lines      from authenticated, anon;
revoke all on inv_asset_maintenance_links  from authenticated, anon;

-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT
--
-- a stock balance column   `CurrentStock` is a workbook formula and has one home. Nothing
--                          here holds, derives or caches a stock level.
-- an item master           15_INVENTORY.ItemID is already stable identity, with the name,
--                          category and unit beside it. A second item table would be a
--                          second answer to "what is this thing called".
-- an asset table           16_ASSETS is a complete register. This milestone surfaces it.
-- a supplier master        `finance_vendors` is the vendor. `inv_vendor_links` says which
--                          vendor a workbook NAME means; it does not describe one.
-- a payable                `finance_bills` owns what is owed. A goods receipt records that
--                          things arrived, which is a different claim from money being due.
-- an expense               06_EXPENSES owns spending and `ExpenseID` is its key. Receiving
--                          stock does not create one: whether an arrival is an expense, and
--                          in which period, is an accounting decision a person makes.
-- valuation, COGS,         Every one is an accounting policy nobody has stated. Quantity is
-- FIFO, weighted average,  not value, and a system that guesses the difference produces
-- depreciation             figures that look authoritative and are not.
-- a negative quantity      Direction is the movement TYPE. A negative number would let one
--                          column mean two opposite things.
-- ---------------------------------------------------------------------
