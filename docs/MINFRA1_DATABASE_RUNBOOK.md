# M-INFRA-1 — the database runbook

How to create, migrate, inspect and test MAKAM's database, and what to do when something
goes wrong. Everything here has been run; no command in this file is aspirational.

**Status: verified against local PostgreSQL only.** No hosted Supabase project exists for
this repository, no credentials for one exist, and nothing here has been applied to a
staging or production database. See §10.

---

## 1 · Prerequisites

| Need | Why |
|---|---|
| Node 20 | The repository's engine. `npm ci` installs everything else. |
| *(nothing else)* | The default database is **PGlite** — real PostgreSQL 18 compiled to WebAssembly, running in-process. No Docker, no daemon, no `psql`, no credentials. |

Docker and a PostgreSQL server are **optional**, and only for re-checking against a normal
server build (§4). CI does that on every push, so a developer never has to.

---

## 2 · The three commands

```bash
npm run db:check
```

Applies every structural migration to a database created a moment ago in memory, then
reports the schema it produced. Needs nothing configured. This is the answer to *"would a
clean database accept these migrations today?"* and it takes about ten seconds. It runs
inside `npm run gate` and as the first database step in CI.

```bash
npm run db:status
```

Against `DATABASE_URL`: what has been applied, when, and where the repository and the
database disagree. Reads only — it never writes, not even the ledger.

```bash
npm run db:migrate
```

Against `DATABASE_URL`: applies what is pending, in filename order, each migration in its
own transaction. Add `--include-seed` to also apply the demo identities (§6).

Every command prints its target first, with the credentials stripped out.

---

## 3 · The local development loop

```bash
npm ci
npm run db:check
npm run test:db
npm run dev
```

`npm run test:db` runs the four infrastructure suites — migrations, RLS, isolation,
boundaries — each against its own freshly created database. Nothing persists between runs
and nothing needs cleaning up.

The application itself still runs in DEMO against the in-process dataset; **pointing the
running application at a real database is not part of this milestone** (§10).

---

## 4 · Running against a real PostgreSQL server

Only needed to re-check the WASM engine's answers against a normal server build. With any
throwaway PostgreSQL 16+ (the image must include `contrib`, for `pgcrypto`):

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
```

The harness creates a uniquely named database per test file and drops it afterwards, so
files never see each other's rows. CI does exactly this on every push.

---

## 5 · Environment variables, by purpose

Values live in `.env.local`, which is git-ignored. `.env.example` carries the names with
every value empty and is the only dotenv file in version control.

| Name | Purpose |
|---|---|
| `DATABASE_URL` | The PostgreSQL server the tools and the test suite talk to. **Unset is the safe default** and selects the in-memory engine. |
| `PRODUCTION_SUPABASE_URL`, `PRODUCTION_DATABASE_URL` | The deployment's own production settings. Used here **only as a veto**: a `DATABASE_URL` on the same host is refused. |
| `DATABASE_TEST_CONFIRMED_NOT_PRODUCTION` | Lifts the refusal of a *hosted Supabase* host, for a project you know is disposable. It does **not** lift a production-host match; nothing does. |

---

## 6 · The migrations

Ten files, applied in filename order. Nine are structural; one is not.

| | |
|---|---|
| `0001_identity_audit_ids` | app_users, audit_log, id sequences, the allocator functions |
| `0002_demo_identities` | **Not structural.** See below. |
| `0003_operations` | the idempotency store and its functions |
| `0004_tenants` | tenants, memberships; makes audit, operations and identifier sequences tenant-scoped |
| `0005_tenant_workbooks` | tenant → workbook binding |
| `0006_finance_foundation` | vendors, bills, receivables, payments, periods |
| `0007_hr_foundation` | 15 people tables |
| `0008_ops_task_assignments` | the task-assignment overlay |
| `0009_tenant_referential_integrity` | **M-INFRA-1.** 14 `unique (tenant_id, id)` and 24 composite foreign keys |
| `0010_privilege_hardening` | **M-INFRA-1.** Revokes on four tables; `pg_temp` demoted in four definer functions |

**`0002` is a demo-project seed, not schema.** Its own header says so. It inserts four
fictional logins whose ids must already exist in `auth.users`, which happens only after
somebody invites those addresses through the Supabase dashboard — so on a genuinely clean
database it fails, by design, on a foreign key. The runner therefore excludes it unless
`--include-seed` is passed, and a test asserts both halves of that behaviour.

Its header claims the placeholder ids "are not valid uuids" and therefore cannot be applied
by accident. That is **not accurate** — all four parse as uuids. The foreign key into
`auth.users` is what actually prevents the accident, and it does so reliably.

### Conventions

- `NNNN_lower_snake.sql`. The zero-padding is load-bearing: filename order **is** apply
  order, and the runner refuses a name that would sort wrongly.
- Every migration must be applicable inside a transaction. `CREATE INDEX CONCURRENTLY`
  cannot be, so the runner refuses it; introducing one is a deliberate change to the runner
  and to this document.
- Every migration is written to be idempotent (`if not exists`, `do $$ … exception when
  duplicate_object`), which is belt and braces — the ledger already prevents a second run.

---

## 7 · How migration state is tracked, and how drift is found

The runner keeps `schema_migrations (name, checksum, applied_at)`, created by the runner
itself rather than by a migration. `checksum` is the SHA-256 of the file's exact bytes.

`npm run db:status` reports three kinds of disagreement:

| Kind | Meaning | Normal? |
|---|---|---|
| `PENDING` | in the repository, not yet applied here | Yes, before a deploy |
| `CHANGED` | applied, and the file has been edited since | **No** |
| `MISSING_FILE` | applied here, no longer in the repository | **No** |

`db:migrate` **refuses to run at all** when anything is `CHANGED`. Applying further
migrations on top of a database that no longer matches the repository produces a schema
nobody can reason about, and the failure would surface much later and somewhere else.

**Never edit an applied migration.** Write a follow-up. `0009` and `0010` are that pattern:
both fix real defects in `0006`–`0008` without touching them.

The ledger row is written in the *same transaction* as the migration's DDL, so a migration
can never be recorded as applied unless it actually applied, and never half-apply.

---

## 8 · Testing row level security

`tests/infrastructure/rls.test.ts`. Three things make it real rather than decorative, and
all three are required:

1. **Queries run as `authenticated` or `anon`.** PostgreSQL exempts superusers from RLS
   entirely and table owners unless `FORCE` is set. The migrations run as the owner, so a
   test that queried without `set local role` would bypass every policy and pass no matter
   what the policies said.
2. **`auth.uid()` returns a real value**, from the `request.jwt.claim.sub` setting that
   PostgREST populates from a verified JWT. The policies under test are the migrations' own,
   unmodified.
3. **Supabase's default `public` grants are applied first.** Without them every cross-tenant
   read fails with *"permission denied for table"* — green, and proving only that no GRANT
   exists. It would pass with every policy deleted.

`lib/server/db/supabase-compat.ts` supplies the platform objects a hosted Supabase project
provides and a bare PostgreSQL does not: the three roles, the `auth` schema, `auth.users`,
`auth.uid()`, and those default grants. **It contains none of the product's own security.**

---

## 9 · Production and staging

Not yet applicable — no such database exists for this repository (§10). When one does:

1. Take a snapshot first. These migrations are **forward-only**.
2. `npm run db:status` against it, and read the output.
3. `npm run db:migrate`. Against a host matching `PRODUCTION_*`, the command refuses unless
   `--confirm-production` is passed, and prints the host either way.
4. `npm run db:status` again.

### Rollback

**There is no down migration and there will not be one.** Several of these migrations are
not reversible in any meaningful sense — `0004` renames identifier sequence scopes in place,
`0009` rewrites foreign keys — and a `down` that silently loses data is worse than none.

The strategy is, in order:

1. **Restore from snapshot.** The only true rollback, and why step 1 above is not optional.
2. **Forward fix.** Write `00NN+1` that corrects the problem. This is the normal path.

`0009` and `0010` are themselves forward fixes and are safe to re-run: both are written so
that applying them to an already-correct database changes nothing.

---

## 10 · What has NOT been verified

Stated plainly because the rest of this document would otherwise imply more than was done:

- **No hosted Supabase project has been touched.** None is configured; no credentials for
  one exist anywhere in this repository or environment.
- **Nothing has been applied to a staging or production database.** The migrations have run
  against local PostgreSQL — PGlite here, `postgres:16` in CI — and nowhere else.
- **The running application has not been pointed at a real database.** The repositories
  speak to Supabase through PostgREST, which neither engine provides; see
  `MINFRA1_SECURITY.md` §6.
- **RLS has not been exercised through PostgREST**, only through direct SQL as the
  `authenticated` and `anon` roles. That tests the policies, which is the part that can be
  wrong; it does not test Supabase's JWT handling.
- **No Supabase CLI project is configured.** There is no `supabase/config.toml`, and
  `supabase start` needs Docker, which is not installed on the development machine.

---

## 11 · Troubleshooting

| Symptom | Cause | Do |
|---|---|---|
| `extension "pgcrypto" is not available` | The server has no `contrib`. | Use an image that ships it — the official `postgres` images do. |
| `relation "auth.users" does not exist` | Applying migrations to a bare PostgreSQL without the platform objects. | Apply `supabaseCompatSql()` first, as the harness and `db:check` do. |
| `role "authenticated" does not exist` | Same cause. | Same fix. |
| `Refusing to migrate: N already-applied migration(s) have been edited` | Someone edited a migration after it ran. | Restore the file to its applied bytes and write a follow-up migration instead. |
| `DATABASE_URL points at … the production database` | The target matches a `PRODUCTION_*` setting. | This is the guard working. Point it somewhere disposable. |
| `points at the hosted Supabase project …` | A `*.supabase.co` host. | Use a local container, or set `DATABASE_TEST_CONFIRMED_NOT_PRODUCTION=yes` if it is genuinely disposable. |
| `0002` fails on a foreign key | Expected on a clean database. | Invite the four demo addresses first, or leave it excluded. |

---

## 12 · What CI does

`.github/workflows/ci.yml`, on every push to `master` and every pull request. **No secrets
are declared or used.**

- **checks** — `contract:check`, `typecheck`, `lint`, `db:check`, `test`, `build`, offline
  parity.
- **database** — a throwaway `postgres:16` service container; runs the four infrastructure
  suites against it, then runs them again with a `PRODUCTION_DATABASE_URL` pointing at that
  same host and **passes only if the suite refuses to run**.

That last step is a test of the guard itself, in the place where it matters most.
