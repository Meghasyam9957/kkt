# M-INFRA-1 — the security model, as the database actually implements it

What enforces the tenant boundary, what does not, and which of these claims now has evidence
behind it. Written after running the migrations for the first time, so several statements
here correct what earlier milestones assumed.

---

## 1 · The finding that reframes everything else

Before this milestone the architecture documents described tenant isolation as though row
level security participated in it. **It does not, and it never did.**

Running the schema and reading `pg_policies` gives the whole picture in one table:

| | |
|---|---|
| Tables with RLS enabled | **30 of 30** |
| Policies in the entire schema | **2** |
| Policies that mention `tenant_id` | **0** |
| Tables whose isolation depends on a policy | **0** |

The two policies are `app_users_self_read` and `memberships_self_read`. Both are
`FOR SELECT`, both are `auth.uid() = <column>`, and both are about a person reading their
own identity row. Neither has anything to say about tenants.

Every other table is `enable row level security` **with no policy at all**. In PostgreSQL
that denies everything to any role that is not the owner and not a superuser. So the
database's answer to *"can tenant A read tenant B?"* is not *"no, the policy filters it"* —
it is:

> **No. And tenant A cannot read its own rows either.**

This is a coherent design, and a strict one. It is simply a different design from the one
that was documented, and the difference matters when reasoning about what would happen if
something went wrong.

---

## 2 · What actually enforces the tenant boundary

Three layers, in the order an attacker would meet them:

**1 — Privilege.** 26 of 30 tables are `REVOKE`d outright from `anon` and `authenticated`.
A browser holding a valid anon key and a valid JWT cannot name them at all.

**2 — Row level security.** For the four tables that keep a grant, RLS is the only lock, and
it holds: reads return zero rows and writes are refused with *"new row violates row-level
security policy"*. Verified, not assumed — `tests/infrastructure/rls.test.ts`.

**3 — The application.** Every query that returns data is made by the server using the
**service role**, which bypasses RLS entirely. The tenant predicate is applied in TypeScript,
at three choke points (`scoped`, `insertRow`, `updateRow`) per repository.

Layer 3 is where isolation is *decided*. Layers 1 and 2 are why a mistake in layer 3 cannot
be reached from a browser: there is no anon-key path to the data at all.

**The corollary worth stating plainly:** RLS is not a backstop for an application bug here,
because the application does not go through RLS. If a repository forgot its tenant
predicate, RLS would not catch it. That is what makes the application-level isolation tests
from M-SAAS-1, M-DATA-1, M-HR-1 and M-OPS-2 load-bearing rather than belt-and-braces — and
it is why `0009` (§4) matters as much as it does.

---

## 3 · The service role boundary

The service role bypasses RLS completely, so it is the one credential whose escape would
make every other guarantee here irrelevant.

| Question | Answer | Evidence |
|---|---|---|
| How many modules read it? | One reads it from the environment; six use it, all under `lib/server/**` | `tests/infrastructure/boundaries.test.ts` |
| Can a client component reach it? | No — zero value-level imports from any `'use client'` module into `lib/server/**` | same |
| Is it in a `NEXT_PUBLIC_*` variable? | No, and a test refuses any `NEXT_PUBLIC` name matching a secret-ish pattern | same |
| Could a `.env` be committed? | No — `.gitignore` has `.env*` with `!.env.example` | same |
| Does `.env.example` carry values? | No — every secret-ish name ships empty, asserted per line | same |

The one client component that names a server module (`CopilotConsole.tsx`) does so as
`import type`, which the compiler erases. The test distinguishes type imports from value
imports for exactly that reason.

**Known gap (not closed here):** `lib/server/only.ts` describes the `server-only` npm package
as "the primary control", and that package is not a dependency. Enforcement is therefore a
runtime throw, not a build error. Adding it is a one-line change with a build-wide blast
radius, so it belongs in its own change rather than smuggled into an infrastructure
milestone.

---

## 4 · The hole this milestone found and closed

Twenty-four foreign keys across finance, HR and operations pointed at their parent row **by
id alone**. Every one accepted a child row in tenant A referencing a parent in tenant B:

```sql
insert into finance_bills (tenant_id, vendor_id, ...)
values (<tenant A>, <a vendor belonging to tenant B>, ...);   -- accepted, silently
```

The same was true of attendance against another tenant's employee, a payroll line against
another tenant's run, and a task assignment against another tenant's staff. Nothing in the
database objected. The only thing preventing it was application code remembering to check,
in every path, every time — and given §2, there was no second layer to catch a lapse.

`0009_tenant_referential_integrity.sql` gives each parent a `unique (tenant_id, id)` and
re-points all 24 keys at `(tenant_id, <ref>)`. A cross-tenant reference stops being something
the application must prevent and becomes something the database cannot represent.

The guard is written as a catalog query rather than a list of tables, so a *new* table with
a plain `parent_id references parent(id)` fails the test on the day it is written.

---

## 5 · Least privilege

`0010_privilege_hardening.sql` closed the remaining asymmetries:

- `audit_log` revoked `update, delete` but left `SELECT` and `INSERT` granted — while the
  comment two lines above claimed "no client may read". Now revoked, matching the intent.
- `id_sequences` and `id_allocations` had no revoke at all.
- `app_users` had no revoke, though `memberships` — same stated intent — had one.

`SELECT` is deliberately kept on `app_users` and `memberships`: revoking it would make their
self-read policies unreachable, which is a different change from the one intended.

After `0010`, no browser-facing role holds any write privilege on any table, and only those
two tables are readable at all.

### SECURITY DEFINER functions

Four exist: `allocate_ids`, `seed_sequence_floor`, `begin_operation`, `set_operation_status`.
All four:

- pin `search_path` (`public, pg_temp` after `0010` — listing `pg_temp` explicitly demotes it
  from its default first position, so a temporary table cannot shadow a real one),
- are `REVOKE`d from `public`, `anon` and `authenticated` — verified by test: an
  `authenticated` role calling `begin_operation` gets *"permission denied for function"*,
- take the tenant as a parameter and compare it **before** anything else.

`begin_operation` is the one worth reading: tenant is compared before the request hash, so a
second tenant presenting the same operation id is told `mismatch` — never `already applied`,
and never the first tenant's stored result. Verified against the real function.

---

## 6 · Application ↔ database: what is and is not proven

The repositories do not speak SQL. They speak to **PostgREST** through
`@supabase/supabase-js`, and depend on Supabase for more than PostgreSQL: GoTrue, the `auth`
schema, the three roles, service-role RLS bypass, four RPC endpoints, and the `{data, error}`
envelope with `error.code === '23505'` as a behavioural branch.

Neither PGlite nor a bare `postgres:16` provides PostgREST. So:

- **Proven:** the schema, the constraints, the indexes, the policies, the grants, the
  definer functions, the idempotency semantics and the identifier sequences — all exercised
  as SQL against a real engine.
- **Not proven:** the repositories driving that schema end to end. Pointing the application
  at a non-Supabase PostgreSQL is a re-platforming, not a driver swap.

That gap is exactly where three defects had been hiding, each of which would have failed on
first contact with a real database and none of which the query-chain recorder could see:

| Defect | Effect | Fixed |
|---|---|---|
| Approving attendance wrote `'APPROVED'` into `hr_attendance.status`, an enum with no such value | Attendance could never be approved, so payroll could never run | `attendanceApprovalPatch` writes `approval` |
| Every update stamped `updated_at`, on six tables that have none | Every salary revision failed | `WITHOUT_UPDATED_AT`, checked against the live schema by a test |
| The operations repository inserted without superseding | No task could ever be reassigned; the in-memory twin disagreed | supersede-then-insert, mirroring the twin |

`tests/infrastructure/repository-schema.test.ts` pins all three against the real schema.

---

## 7 · Environment separation

The test suite cannot reach production, structurally rather than by convention:

1. **Doing nothing is safe.** With no `DATABASE_URL`, the engine is an in-memory database
   that did not exist a moment earlier.
2. **The deployment's own configuration is the veto.** A `DATABASE_URL` whose *hostname*
   matches `PRODUCTION_SUPABASE_URL` or `PRODUCTION_DATABASE_URL` is refused, and **no flag
   lifts it**.
3. **Hosted Supabase is refused by default**, since a `*.supabase.co` host is by definition
   somebody's real project. Only an explicit confirmation variable lifts that one.
4. **CI proves the guard**, by running the suite with a production-marked host and passing
   only when the run is refused.

Hostnames are compared, not hosts. Comparing `db.example.com:5432` against
`https://db.example.com` finds no match, the refusal never fires, and the suite connects to
production — a bug this milestone had, caught by its own test.

---

## 8 · CI security

`.github/workflows/ci.yml` declares no `secrets`, no environment and no credentials. It
cannot leak a production secret because it is never given one. `permissions: contents: read`
— a job that cannot write cannot be turned into one that publishes.

Error output is safe by construction: every message this milestone's code produces about a
database names the **host only**. `redactConnectionString` strips username and password, and
a test asserts a refusal mentions the host and neither credential.

**Known gap (not closed here):** the audit record's `reason` field bypasses `redactMetadata`
and receives raw internal error messages. It is written by the server and readable only
through the SUPER_ADMIN capability, so it is not a browser-facing leak — but it is the one
field where an internal string reaches storage unfiltered, and it deserves its own change.

---

## 9 · What would still be true if RLS were removed entirely

Worth asking, because §2 means the answer is uncomfortable and should be said out loud:

- Browser roles would still be blocked from 26 of 30 tables by the revokes.
- The four RLS-only tables would become readable and writable by any signed-in user, which
  is why `0010` revoked three of them.
- **Nothing the application does would change**, because it uses the service role.

So RLS here is a second lock on a door the application does not use. It is worth having and
worth testing — it is what stands between a leaked anon key and the data — but it is not the
tenant boundary, and calling it one would misdescribe where the risk actually lives.

---

## 10 · Threat model, answered

| Question | Answer | Where |
|---|---|---|
| Can authenticated user A query B's rows through SQL? | No — revoked, or RLS-denied | `rls.test.ts` |
| Can A write B's rows through SQL? | No, and the seeded rows are asserted unchanged after every attempt | `rls.test.ts` |
| Can app code omit a tenant predicate? | Yes, in principle — and RLS would **not** catch it | §2 |
| Can a foreign employee or vendor be referenced? | **No, since `0009`** | `isolation.test.ts` |
| Can membership be forged to gain a tenant? | No — `memberships` is insert/update/delete-revoked and RLS-denied | `rls.test.ts` |
| Can the audit trail be forged or erased? | No — insert and delete both refused | `rls.test.ts` |
| Can an operation be replayed cross-tenant? | No — tenant compared before hash; B gets `mismatch`, never A's result | `isolation.test.ts` |
| Can identifier allocation collide across tenants? | No — scopes carry the tenant; both tenants mint their own `1` | `isolation.test.ts` |
| Can a browser obtain the service role? | No — one reader, server-only, no client import path | `boundaries.test.ts` |
| Can CI expose secrets? | It has none to expose | §8 |
| Can the test suite touch production? | No — refused, and CI proves the refusal | §7 |
