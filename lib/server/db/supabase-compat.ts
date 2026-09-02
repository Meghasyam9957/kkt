import '@/lib/server/only';
/**
 * WHAT A HOSTED SUPABASE PROJECT PROVIDES BEFORE THE FIRST MIGRATION RUNS.
 *
 * The eight migrations are written against a Supabase project, and they reference four
 * things a bare PostgreSQL server does not have: the roles `anon`, `authenticated` and
 * `service_role`, the `auth` schema, `auth.users`, and `auth.uid()`. On Supabase those
 * exist because Supabase creates them at project creation. On a plain PostgreSQL 16 server
 * or an embedded PGlite they do not exist, so the migrations cannot run at all.
 *
 * READ THIS BEFORE TRUSTING ANY RLS TEST THAT USES IT:
 *
 * This file is a STAND-IN FOR THE PLATFORM, never a stand-in for the policies. Not one line
 * of the repository's own security lives here. Every `create policy`, every `revoke`, every
 * `enable row level security` still comes from the migrations, unmodified, and runs exactly
 * as written. What this provides is the ground they stand on. If that distinction ever
 * blurs — if a policy or a grant that belongs to the product migrates into this file — the
 * RLS tests stop proving anything about the product and start proving something about the
 * harness.
 *
 * THE ONE SUBTLETY THAT MAKES OR BREAKS THE TESTS — `defaultGrants`.
 *
 * A hosted Supabase project grants `anon` and `authenticated` broad table privileges on the
 * `public` schema by default, so that PostgREST can reach new tables without a grant being
 * written for each one. Row Level Security is what holds the line, and that is the whole
 * design: privileges are wide, policies are narrow.
 *
 * A bare PostgreSQL server grants nothing. So if the tests ran WITHOUT these default
 * grants, every cross-tenant read would be refused with "permission denied for table" — the
 * suite would be green, and it would have proved only that no GRANT exists. It would pass
 * just as happily with every policy deleted. That is precisely the fake RLS test the
 * milestone brief forbids.
 *
 * Applying the default grants first reproduces the real deployment target: privileges wide
 * open, and RLS the only thing between tenant A and tenant B. Then a test that reads across
 * tenants and gets nothing has proved something worth knowing.
 *
 * (The migrations then narrow this again with their own explicit REVOKEs on the finance, HR
 * and operations tables — defence in depth on top of RLS. The tests verify both layers, and
 * verify which tables have only the RLS layer.)
 */

/**
 * Roles. `service_role` carries BYPASSRLS because that is what it does on Supabase: it is
 * the trusted server identity the application uses, and it is never given to a browser.
 *
 * `nologin` throughout — these are `SET ROLE` targets in tests, not accounts. Nothing here
 * has or needs a password, so nothing here can leak one.
 */
const ROLES = `
do $$ begin create role anon         nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role  nologin noinherit bypassrls; exception when duplicate_object then null; end $$;
`;

/**
 * The `auth` schema, reduced to exactly the four things the migrations actually reference:
 * `auth.users(id)` (two foreign keys in 0001) and `auth.uid()` (the two SELECT policies in
 * 0001 and 0004). Nothing else from GoTrue is modelled, because nothing else is used.
 *
 * `auth.uid()` reads `request.jwt.claim.sub` from the session, which is how Supabase itself
 * implements it — PostgREST sets that GUC from the verified JWT before running the query.
 * A test sets the same GUC. The POLICY under test is unchanged and does the same comparison
 * it will do in production.
 *
 * It is `stable`, not `immutable`: the value changes between statements as the session's
 * claims change, and marking it immutable would let the planner cache one tenant's answer
 * for another's query.
 */
const AUTH_SCHEMA = `
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text unique
);

create or replace function auth.uid() returns uuid
  language sql stable
  set search_path = ''
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.role() returns text
  language sql stable
  set search_path = ''
as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

grant usage on schema auth to anon, authenticated, service_role;
`;

/**
 * The default privileges a hosted Supabase project applies to the `public` schema.
 *
 * `alter default privileges` affects tables created AFTER it runs, which is why this must be
 * applied BEFORE the migrations — the same order as a real project, where the defaults are
 * set at creation and every migration since has created tables under them.
 */
const DEFAULT_GRANTS = `
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
`;

export interface CompatOptions {
  /**
   * Apply Supabase's default `public` grants. Defaults to true, and should stay true for
   * any test that claims to exercise RLS — see the note at the top of this file. Set it
   * false only to demonstrate what the suite would prove without them.
   */
  readonly defaultGrants?: boolean;
}

/**
 * The SQL a bare PostgreSQL server needs before migration 0001 will run.
 *
 * Ordered deliberately: roles first (the grants reference them), then the auth schema (0001
 * has a foreign key into it), then the default privileges (which must precede every
 * `create table` they are meant to cover).
 */
export function supabaseCompatSql(options: CompatOptions = {}): string {
  const withGrants = options.defaultGrants !== false;
  return [ROLES, AUTH_SCHEMA, withGrants ? DEFAULT_GRANTS : ''].join('\n');
}

/**
 * The four demonstration logins that migration 0002 inserts into `app_users`.
 *
 * 0002 has foreign keys into `auth.users`, and its own header explains why: on a real demo
 * project a person invites those four addresses through the Supabase dashboard, GoTrue
 * creates the rows, and only then can 0002 run. Seeding them here reproduces that
 * precondition rather than working around it — without these rows 0002 fails on a clean
 * database, which is a true fact about 0002 and is asserted as one in the test suite.
 *
 * These are fictional addresses on a domain that does not exist. No password is set here,
 * and none can be: `auth.users` as modelled above has no password column.
 */
export const DEMO_AUTH_USERS = `
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'admin.demo@srivillu.demo'),
  ('00000000-0000-0000-0000-000000000002', 'operations.demo@srivillu.demo'),
  ('00000000-0000-0000-0000-000000000003', 'investor.demo.a@srivillu.demo'),
  ('00000000-0000-0000-0000-000000000004', 'investor.demo.b@srivillu.demo')
on conflict (id) do nothing;
`;
