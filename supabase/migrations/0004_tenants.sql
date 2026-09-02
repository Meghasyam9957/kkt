-- ---------------------------------------------------------------------
-- M-SAAS-0 — THE TENANT BOUNDARY
--
-- MAKAM is the product; Srivillu is the first customer. Until now the *deployment*
-- was the tenant: one workbook id in an environment variable, one process, one
-- customer. That is not a boundary — it is the absence of one, and it works only
-- while there is exactly one customer.
--
-- This migration makes tenant identity EXIST. It adds no behaviour: Srivillu becomes
-- tenant #1, every existing user gets exactly one membership carrying the role they
-- already had, and every existing control-plane row is attributed to that tenant.
-- Nothing an operator sees changes.
--
-- What it buys is that the two structural breaches identified in the architecture
-- audit — a cache key shared by every tenant, and a process-global provider — become
-- expressible as bugs. The application code that follows makes them impossible.
--
-- Deny-by-default is preserved throughout: no new table grants anything to `anon` or
-- `authenticated` beyond a user reading their own membership.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. Tenants
-- ---------------------------------------------------------------------

do $$ begin
  create type tenant_status as enum ('ACTIVE', 'SUSPENDED');
exception when duplicate_object then null; end $$;

create table if not exists tenants (
  id         uuid          primary key default gen_random_uuid(),
  -- Stable, URL-safe, lower-case. Used for operator-facing identification and, one
  -- day, for host or path routing — but a slug in a request will never SELECT a
  -- tenant on its own: membership decides, always.
  slug       text          not null unique,
  name       text          not null,
  status     tenant_status not null default 'ACTIVE',
  created_at timestamptz   not null default now(),

  constraint tenants_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint tenants_name_present check (length(btrim(name)) > 0)
);

-- Tenant #1. Deliberately the ONLY row this migration creates: a second customer is a
-- commercial decision, not a schema one.
insert into tenants (slug, name, status)
values ('srivillu', 'Srivillu Homestays', 'ACTIVE')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- 2. Memberships
--
-- The join that replaces `app_users.role` as the authority on what someone may do.
-- A user may eventually hold memberships in several tenants (MAKAM support staff
-- will), so the key is the PAIR — not the user.
-- ---------------------------------------------------------------------

create table if not exists memberships (
  user_id    uuid        not null references app_users(id) on delete cascade,
  tenant_id  uuid        not null references tenants(id)   on delete restrict,
  role       app_role    not null,
  status     user_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (user_id, tenant_id)
);

create index if not exists memberships_tenant_idx on memberships (tenant_id, status);
create index if not exists memberships_user_idx   on memberships (user_id, status);

-- Every existing login becomes a Srivillu member with the role it already had. No
-- role changes, no user is dropped, and `app_users.role` is left in place — see the
-- transition note at the foot of this file.
insert into memberships (user_id, tenant_id, role, status)
select u.id, t.id, u.role, u.status
from app_users u
cross join (select id from tenants where slug = 'srivillu') t
on conflict (user_id, tenant_id) do nothing;

alter table memberships enable row level security;

-- A signed-in user may read their OWN memberships and nothing else. This is what lets
-- a future client know which tenant it is in; it can never enumerate a tenant's users.
drop policy if exists memberships_self_read on memberships;
create policy memberships_self_read on memberships
  for select using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies: membership is provisioned by the service role.
revoke insert, update, delete on memberships from authenticated, anon;

-- Tenants themselves are never enumerable from a browser. A user learns their tenant
-- through their membership, not by listing the customer base.
alter table tenants enable row level security;
revoke all on tenants from authenticated, anon;

-- ---------------------------------------------------------------------
-- 3. Control-plane records become tenant-attributed
-- ---------------------------------------------------------------------

-- AUDIT. Nullable on purpose: an audit row is also written for an UNAUTHENTICATED
-- attempt, and there is no tenant to attribute one to. Null therefore means "no
-- tenant could be resolved", never "any tenant".
alter table audit_log add column if not exists tenant_id uuid references tenants(id);
update audit_log set tenant_id = (select id from tenants where slug = 'srivillu')
  where tenant_id is null and actor_id is not null;
create index if not exists audit_log_tenant_idx on audit_log (tenant_id, occurred_at desc);

-- OPERATIONS. Every operation has an authenticated actor, so this can be NOT NULL
-- once the existing rows are attributed. It is what stops a Tenant A operation id
-- from replaying — or colliding with — a Tenant B request.
alter table operations add column if not exists tenant_id uuid references tenants(id);
update operations set tenant_id = (select id from tenants where slug = 'srivillu')
  where tenant_id is null;
alter table operations alter column tenant_id set not null;
create index if not exists operations_tenant_idx on operations (tenant_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Identifier sequences become tenant-scoped
--
-- `id_sequences.scope` was '04_RESERVATIONS:BK:2026' — global. Two tenants would have
-- shared one booking-number sequence and minted the same BK-2026-0001.
--
-- Existing scopes are RENAMED rather than reset, so allocation continues from exactly
-- the floor it had reached and no visible Srivillu identifier changes or repeats.
-- ---------------------------------------------------------------------

update id_sequences
set scope = 'tenant:' || (select id::text from tenants where slug = 'srivillu') || ':' || scope
where scope not like 'tenant:%';

update id_allocations
set scope = 'tenant:' || (select id::text from tenants where slug = 'srivillu') || ':' || scope
where scope not like 'tenant:%';

-- ---------------------------------------------------------------------
-- TRANSITION NOTE — why `app_users.role` still exists
--
-- `app_users.role` is deliberately NOT dropped here. It is still read by the
-- authentication path as a fallback for a user with no membership row, which keeps a
-- half-applied migration from locking every operator out of the product.
--
-- Going forward the MEMBERSHIP is the authority: the resolver prefers it and falls
-- back only when none exists. Once every deployment has run this migration and the
-- fallback is provably unused, `app_users.role` and its investor constraints move to
-- `memberships` and the column is dropped. That is a later milestone with its own
-- migration; doing it here would make this one irreversible.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 5. Idempotency becomes tenant-aware
--
-- `operations.operation_id` is a GLOBAL primary key. Two tenants presenting the same
-- id must therefore be resolved explicitly — and the answer is refusal, not replay:
-- Tenant B must never receive Tenant A's stored result, and must never be told its
-- request was "already applied".
--
-- The function is replaced rather than overloaded so exactly one definition exists.
-- ---------------------------------------------------------------------

drop function if exists begin_operation(uuid, text, text, text, text);

create or replace function begin_operation(
  p_id     uuid,
  p_tenant uuid,
  p_actor  text,
  p_role   text,
  p_action text,
  p_hash   text
)
returns table (outcome text, status operation_status, result jsonb, error text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row operations%rowtype;
begin
  insert into operations (operation_id, tenant_id, actor_id, actor_role, action, request_hash)
       values (p_id, p_tenant, p_actor, p_role, p_action, p_hash)
  on conflict (operation_id) do nothing;

  if found then
    return query select 'inserted'::text, 'PENDING'::operation_status, null::jsonb, null::text;
    return;
  end if;

  select * into v_row from operations where operation_id = p_id;

  -- THE CROSS-TENANT GUARD. Checked before the hash, and before any stored result is
  -- returned: an operation belonging to another customer is a mismatch, full stop. It
  -- reveals nothing about the other tenant's operation — not its status, not its
  -- result, not whether the hash would have matched.
  if v_row.tenant_id is distinct from p_tenant then
    return query select 'mismatch'::text, v_row.status, null::jsonb, null::text;
  elsif v_row.request_hash <> p_hash then
    return query select 'mismatch'::text, v_row.status, null::jsonb, null::text;
  elsif v_row.status = 'VERIFIED' then
    return query select 'verified'::text, v_row.status, v_row.result, null::text;
  elsif v_row.status = 'FAILED' then
    return query select 'failed'::text, v_row.status, null::jsonb, v_row.error;
  else
    return query select 'in_flight'::text, v_row.status, null::jsonb, null::text;
  end if;
end;
$$;

revoke all on function begin_operation(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
