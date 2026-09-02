-- =====================================================================
-- 0010 · PRIVILEGE HARDENING
--
-- Two gaps found by running the schema and reading the catalog rather than the SQL
-- (M-INFRA-1). Neither is exploitable today. Both are the second lock that should already
-- have been there, and both are cheap.
--
-- ---------------------------------------------------------------------
-- 1. FOUR TABLES WERE HELD BY ROW LEVEL SECURITY ALONE
--
-- On a hosted Supabase project the `public` schema carries default privileges granting
-- `anon` and `authenticated` select/insert/update/delete on every new table. Migrations
-- 0004 through 0008 revoke those on the finance, HR, operations, tenants and
-- tenant_workbooks tables, so those carry two locks: no privilege, and no policy.
--
-- Four tables were left with their default grants:
--
--   audit_log        `revoke update, delete` only — yet the comment directly above it in
--                    0001 reads "no client may read, update or delete". SELECT and INSERT
--                    were still granted, so the stated intent and the SQL disagreed. RLS
--                    was the only thing denying them, and it did: verified empirically,
--                    a browser role reading it gets zero rows and inserting is refused
--                    with "new row violates row-level security policy". That is one lock
--                    where the comment promised two.
--
--   id_sequences,    no revoke at all. These guarantee that no identifier is ever issued
--   id_allocations   twice. They are reached only through allocate_ids() and
--                    seed_sequence_floor(), which are themselves revoked from browser
--                    roles, so the grants serve nobody.
--
--   app_users        no revoke of any kind — the only policy-bearing table without one,
--                    where `memberships` two migrations later got `revoke insert, update,
--                    delete`. The intent is identical ("provisioning happens through the
--                    service role only"); only the enforcement differed.
--
-- SELECT stays granted on `app_users` and `memberships` deliberately. Their self-read
-- policies are a real capability — a signed-in person reading their own row — and
-- revoking SELECT would silently make both policies unreachable, which is a different
-- change from the one intended here.
--
-- ---------------------------------------------------------------------
-- 2. SECURITY DEFINER FUNCTIONS DID NOT DEMOTE pg_temp
--
-- All four run as their owner and pin `search_path = public`. When search_path does not
-- mention pg_temp, PostgreSQL still searches the temporary schema FIRST for relations. A
-- caller able to create a temp table named `operations` or `id_sequences` could therefore
-- have a definer-rights function read or write their object instead of the real one.
--
-- Reaching that today requires EXECUTE on these functions, which is revoked from `public`,
-- `anon` and `authenticated` — so only the service role can call them, and an attacker
-- holding the service role has already won. This closes it anyway: listing pg_temp
-- explicitly puts it LAST in the search order, which is the documented way to demote it.
--
-- The bodies are not restated. ALTER FUNCTION changes only the setting, so there is no
-- second copy of this logic to drift out of step with 0003 and 0004.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The four tables gain their second lock
-- ---------------------------------------------------------------------

-- Append-only, and now enforced rather than only described.
revoke select, insert on audit_log from authenticated, anon;

-- Identifier uniqueness is reached only through the definer-rights functions.
revoke all on id_sequences   from authenticated, anon;
revoke all on id_allocations from authenticated, anon;

-- Matches `memberships`. SELECT is deliberately kept: app_users_self_read is a capability,
-- not an oversight.
revoke insert, update, delete on app_users from authenticated, anon;

-- ---------------------------------------------------------------------
-- 2. The definer-rights functions demote pg_temp
-- ---------------------------------------------------------------------

alter function allocate_ids(text, int, text, uuid)
  set search_path = public, pg_temp;

alter function seed_sequence_floor(text, bigint)
  set search_path = public, pg_temp;

alter function begin_operation(uuid, uuid, text, text, text, text)
  set search_path = public, pg_temp;

alter function set_operation_status(uuid, operation_status, text, text, jsonb, text)
  set search_path = public, pg_temp;
