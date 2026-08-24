-- =====================================================================
-- Homestay Ops — Phase 3 schema: identity, audit, atomic IDs.
--
-- SCOPE RULE (non-negotiable): this database holds NO business data.
-- Reservations, revenue, expenses, investors and every financial figure live in the
-- V1 Google Sheets workbook. If this database were wiped, nothing about the business
-- would be lost — only identity and history. That is the test for whether a table
-- belongs here.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. Roles and identity
-- ---------------------------------------------------------------------

do $$ begin
  create type app_role as enum ('SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'INVESTOR');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_status as enum ('ACTIVE', 'SUSPENDED');
exception when duplicate_object then null; end $$;

create table if not exists app_users (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text        not null unique,
  role         app_role    not null,
  -- REQUIRED when role = 'INVESTOR'. Maps to 11_INVESTORS.InvestorID in the workbook.
  -- This is the ONLY source of an investor's identity; it is never accepted from a request.
  investor_id  text,
  status       user_status not null default 'ACTIVE',
  display_name text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now(),

  -- An INVESTOR without an investor_id could otherwise see an unscoped result set.
  constraint investor_must_have_investor_id
    check (role <> 'INVESTOR' or (investor_id is not null and length(investor_id) > 0)),
  -- A non-investor must not carry one, so scoping logic can never be confused.
  constraint non_investor_has_no_investor_id
    check (role = 'INVESTOR' or investor_id is null)
);

create index if not exists app_users_role_idx        on app_users (role);
create index if not exists app_users_investor_id_idx on app_users (investor_id) where investor_id is not null;

-- One workbook investor maps to at most one login.
create unique index if not exists app_users_investor_id_unique
  on app_users (investor_id) where investor_id is not null;

-- RLS: a user may read only their own row. Role escalation via the client is impossible
-- because no client-side policy grants UPDATE on `role` or `investor_id`.
alter table app_users enable row level security;

drop policy if exists app_users_self_read on app_users;
create policy app_users_self_read on app_users
  for select using (auth.uid() = id);

-- No INSERT/UPDATE/DELETE policies: provisioning happens through the service role only.

-- ---------------------------------------------------------------------
-- 2. Audit log
-- ---------------------------------------------------------------------

do $$ begin
  create type audit_result as enum ('ALLOW', 'DENY', 'ERROR');
exception when duplicate_object then null; end $$;

create table if not exists audit_log (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz  not null default now(),
  actor_id     uuid,                    -- null for unauthenticated attempts
  actor_email  text,
  actor_role   text,
  action       text         not null,   -- e.g. 'investor.distributions.read'
  entity_type  text,                    -- e.g. 'RESERVATION', 'INVESTOR'
  entity_id    text,
  result       audit_result not null,
  reason       text,                    -- why a DENY happened
  request_id   text,
  ip           inet,
  user_agent   text,
  -- Redacted before insert. Guest PII must never reach this column (see audit/redact.ts).
  metadata     jsonb        not null default '{}'::jsonb
);

create index if not exists audit_log_occurred_at_idx on audit_log (occurred_at desc);
create index if not exists audit_log_actor_idx       on audit_log (actor_id, occurred_at desc);
create index if not exists audit_log_action_idx      on audit_log (action, occurred_at desc);
create index if not exists audit_log_denies_idx      on audit_log (occurred_at desc) where result = 'DENY';

-- Append-only: no client may read, update or delete. Reads go through the service role
-- behind the SUPER_ADMIN capability check.
alter table audit_log enable row level security;
revoke update, delete on audit_log from authenticated, anon;

-- ---------------------------------------------------------------------
-- 3. Atomic ID allocation
--
-- Deliberately NOT `MAX(existing) + 1`: that reads then writes, so two concurrent
-- requests can read the same maximum and mint the same identifier. Allocation here is a
-- single atomic statement holding a row lock, so concurrency is resolved by Postgres.
-- ---------------------------------------------------------------------

create table if not exists id_sequences (
  scope      text        primary key,   -- e.g. '04_RESERVATIONS:BK:2026'
  last_value bigint      not null default 0,
  updated_at timestamptz not null default now(),
  constraint last_value_non_negative check (last_value >= 0)
);

-- Retry safety: the same idempotency key always yields the same identifiers, so a client
-- retry after a network timeout cannot mint a second booking id.
create table if not exists id_allocations (
  idempotency_key text        primary key,
  scope           text        not null,
  first_value     bigint      not null,
  count           int         not null check (count > 0),
  actor_id        uuid,
  created_at      timestamptz not null default now()
);

create index if not exists id_allocations_scope_idx on id_allocations (scope, created_at desc);

alter table id_sequences   enable row level security;
alter table id_allocations enable row level security;
-- No policies: allocation is service-role only, never reachable from a browser.

/**
 * Allocate `p_count` consecutive numbers in `p_scope`.
 * Returns the FIRST allocated value and whether it was replayed from an earlier request.
 *
 * Atomicity: the INSERT ... ON CONFLICT DO UPDATE is one statement, so Postgres holds a
 * row lock for its duration. Concurrent callers serialise; none can observe a stale value.
 */
create or replace function allocate_ids(
  p_scope text,
  p_count int,
  p_key   text default null,
  p_actor uuid default null
)
returns table (first_value bigint, reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first bigint;
  v_existing id_allocations%rowtype;
begin
  if p_count is null or p_count < 1 then
    raise exception 'allocate_ids: count must be >= 1 (got %)', p_count;
  end if;

  -- Replay path: a retry with the same key returns the identical block.
  if p_key is not null then
    select * into v_existing from id_allocations where idempotency_key = p_key;
    if found then
      if v_existing.scope <> p_scope or v_existing.count <> p_count then
        raise exception 'allocate_ids: idempotency key % reused with different parameters', p_key;
      end if;
      return query select v_existing.first_value, true;
      return;
    end if;
  end if;

  -- Atomic bump. `last_value` after the statement is the LAST id of the new block.
  insert into id_sequences as s (scope, last_value)
       values (p_scope, p_count)
  on conflict (scope)
    do update set last_value = s.last_value + p_count, updated_at = now()
    returning s.last_value - p_count + 1 into v_first;

  if p_key is not null then
    begin
      insert into id_allocations (idempotency_key, scope, first_value, count, actor_id)
           values (p_key, p_scope, v_first, p_count, p_actor);
    exception when unique_violation then
      -- A concurrent request with the same key won the race. Return ITS block and let
      -- ours lapse: a gap in the sequence is harmless, a duplicate identifier is not.
      select * into v_existing from id_allocations where idempotency_key = p_key;
      return query select v_existing.first_value, true;
      return;
    end;
  end if;

  return query select v_first, false;
end;
$$;

revoke all on function allocate_ids(text, int, text, uuid) from public, anon, authenticated;

/**
 * Raise a sequence's floor without ever lowering it.
 *
 * Used once per scope at cutover to seed from the highest identifier already present in
 * the workbook, so web-allocated ids cannot collide with ids typed directly into the
 * sheet (or minted earlier by V1's "Generate missing IDs" menu item).
 */
create or replace function seed_sequence_floor(p_scope text, p_floor bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_value bigint;
begin
  insert into id_sequences as s (scope, last_value)
       values (p_scope, greatest(p_floor, 0))
  on conflict (scope)
    do update set last_value = greatest(s.last_value, excluded.last_value), updated_at = now()
    returning s.last_value into v_value;
  return v_value;
end;
$$;

revoke all on function seed_sequence_floor(text, bigint) from public, anon, authenticated;
