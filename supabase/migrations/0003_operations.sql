-- =====================================================================
-- Homestay Ops — Phase B2: mutation operation state (idempotency).
--
-- SCOPE RULE (unchanged, non-negotiable): this database holds NO business data.
-- An operation row records that a request happened and how it ended — the business
-- record itself lives in the V1 workbook. Wiping this table loses replay protection
-- for in-flight retries and nothing else.
-- =====================================================================

do $$ begin
  create type operation_status as enum ('PENDING', 'APPLYING', 'VERIFIED', 'FAILED');
exception when duplicate_object then null; end $$;

create table if not exists operations (
  -- Client-generated per user INTENT (minted when the form opens, not on click).
  -- The primary key is the idempotency guarantee: one intent, one row, one business write.
  operation_id  uuid primary key,
  actor_id      text,
  actor_role    text,
  action        text        not null,             -- e.g. 'expense.create'
  entity_type   text,
  entity_id     text,                             -- filled once allocated/known
  -- sha256 of the canonicalised payload. The same operation_id arriving with a
  -- DIFFERENT hash is a bug or an attack, never a retry — it is refused, not replayed.
  request_hash  text        not null,
  status        operation_status not null default 'PENDING',
  result        jsonb,                            -- the verified response body (redacted)
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists operations_actor_idx  on operations (actor_id, created_at desc);
create index if not exists operations_entity_idx on operations (entity_type, entity_id);
create index if not exists operations_status_idx on operations (created_at desc) where status <> 'VERIFIED';

-- Service-role only; a browser can never read or write operation state directly.
alter table operations enable row level security;
revoke all on operations from authenticated, anon;

/**
 * Begin (or re-encounter) an operation, atomically.
 *
 * One statement decides which of the five worlds the caller is in:
 *   inserted     — this request is the winner; proceed to write.
 *   verified     — an earlier identical request finished; replay its stored result.
 *   in_flight    — an identical request is being applied right now; poll, do not write.
 *   failed       — the earlier attempt failed; a NEW operation id is required (silent
 *                  auto-retry of a failed business write is how double entries happen).
 *   mismatch     — same id, different payload; refuse outright.
 */
create or replace function begin_operation(
  p_id     uuid,
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
  insert into operations (operation_id, actor_id, actor_role, action, request_hash)
       values (p_id, p_actor, p_role, p_action, p_hash)
  on conflict (operation_id) do nothing;

  if found then
    return query select 'inserted'::text, 'PENDING'::operation_status, null::jsonb, null::text;
    return;
  end if;

  select * into v_row from operations where operation_id = p_id;

  if v_row.request_hash <> p_hash then
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

create or replace function set_operation_status(
  p_id     uuid,
  p_status operation_status,
  p_entity_type text default null,
  p_entity_id   text default null,
  p_result jsonb default null,
  p_error  text  default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update operations
     set status      = p_status,
         entity_type = coalesce(p_entity_type, entity_type),
         entity_id   = coalesce(p_entity_id, entity_id),
         result      = coalesce(p_result, result),
         error       = coalesce(p_error, error),
         updated_at  = now()
   where operation_id = p_id;
$$;

revoke all on function begin_operation(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function set_operation_status(uuid, operation_status, text, text, jsonb, text) from public, anon, authenticated;
