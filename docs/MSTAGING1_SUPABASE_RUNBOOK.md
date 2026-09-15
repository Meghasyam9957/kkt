# M-STAGING-1 — the Supabase staging runbook

How to stand up a MAKAM staging project, point the suite at it, and run the verification this
milestone built.

> **Status, 2026-09-15.** A staging project exists and `.github/workflows/staging.yml` has
> reached it — but **no staging test has yet reached an assertion.** The first real run
> stopped at Node 20 (§1); the next stopped at a schema nothing had applied (§3). Neither says
> anything about authentication, RLS or tenant isolation. On a machine with nothing configured
> the suite reports `CONFIGURATION_REQUIRED` and skips 41 tests — the honest third outcome, not
> a pass. See [`MSTAGING1_SECURITY_EVIDENCE.md`](MSTAGING1_SECURITY_EVIDENCE.md) for what this
> means for every security claim.

---

## 1 · Prerequisites

| Need | Why |
|---|---|
| Node 22 or newer | The suite constructs real `@supabase/supabase-js` clients, which need Node's native global `WebSocket` (unflagged from Node 22). Under Node 20 every test fails inside `createClient()` before any request reaches Supabase — which is a runtime failure, not a verdict on auth or RLS. `.github/workflows/staging.yml` pins 22. |
| A Supabase project you can afford to lose | The suite creates users, tenants and rows, and deletes them again. Use a project created for this purpose. |
| That project's URL, anon key and service-role key | From the project's API settings. |
| That project's **Session pooler** connection string | For `db:migrate`, which applies the schema. See §2. |

Nothing else. The Supabase CLI is optional; migrations are applied by this repository's own
runner (`npm run db:migrate`), which needs only a PostgreSQL connection string.

---

## 2 · Configuration

Put these in `.env.local`, which is git-ignored. **Never** in source, a commit, a CI file, or
a chat message. For the workflow, the same names are secrets on the `staging` GitHub
Environment.

| Variable | What it is |
|---|---|
| `STAGING_SUPABASE_URL` | The project URL, e.g. `https://abcdefgh.supabase.co`. |
| `STAGING_SUPABASE_ANON_KEY` | The publishable key. This is the key a browser would carry. |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | The trusted server key. **Bypasses RLS entirely.** Server only, never a browser, never a log. |
| `STAGING_CONFIRMED_NOT_PRODUCTION` | Exactly `yes` (any case). An explicit statement that the project above is disposable. Any other value — `no`, `true`, `1` — is read as no confirmation, and both the suite and the migration step refuse. |
| `STAGING_DATABASE_URL` | PostgreSQL connection to the **same** project, for `db:migrate` and catalog inspection. **Required by the staging workflow**, which applies the migrations before the suite (§6). Use the **Session pooler** string from the project's *Connect* panel — user `postgres.<ref>`, host `aws-…pooler.supabase.com`, port 5432 — because GitHub-hosted runners have no IPv6 and the direct `db.<ref>.supabase.co` host is IPv6-only without the IPv4 add-on. Percent-encode any `/`, `?`, `#` or `%` in the password. Decide on encryption before saving it: see *Encryption* below. |

`STAGING_CONFIRMED_NOT_PRODUCTION` is not ceremony. A hosted Supabase host is, by definition,
somebody's real project; the suite refuses one that nobody has vouched for rather than
guessing from its name.

### The veto

If `PRODUCTION_SUPABASE_URL` or `PRODUCTION_DATABASE_URL` is set and resolves to the same
**hostname**, the target is classified `PRODUCTION` and refused — regardless of the staging
variables, and **no flag lifts it**. Set your production URL in the environment and the
refusal becomes structural rather than a matter of remembering.

A database connection string never shares a hostname with a project's API URL, so for
`db:migrate -- --staging` the veto also compares **project refs**: a connection string for the
project named in `PRODUCTION_SUPABASE_URL` is refused whichever host it uses. That comparison
needs `PRODUCTION_SUPABASE_URL` written as the project's own `https://<ref>.supabase.co`
address; a custom domain carries no ref, and then only the hostname comparison applies.

The guard judges the connection node-postgres will actually make. A string whose `?host=` or
`?user=` parameter redirects it away from the host and user it names is refused outright, and
so is one carrying `?options=`, which Supabase's pooler can route by.

The staging workflow gives the migration step `PRODUCTION_SUPABASE_URL` and deliberately not
`PRODUCTION_DATABASE_URL`: a production password has no business in a staging environment.

### Encryption

The string Supabase's dashboard gives carries no `sslmode`, and node-postgres then connects
**without TLS**: the migrations and the ledger cross the network unencrypted.
`db:migrate -- --staging` says so in its log whenever that is the case. To encrypt, append one
of these to `STAGING_DATABASE_URL`:

| Append | What node-postgres does |
|---|---|
| `?sslmode=require&uselibpqcompat=true` | Encrypts, without verifying the server's certificate — libpq's meaning of `require`. Stops someone reading the traffic; does not stop someone impersonating the server. |
| `?sslmode=verify-full&sslrootcert=<path>` | Encrypts and verifies against Supabase's CA certificate, downloadable from the project's database settings. Needs that file on the runner — a change to the workflow, not a flag. |

Plain `?sslmode=require` on its own fails: without `uselibpqcompat`, node-postgres treats it as
full verification against the system's CAs, and Supabase issues its certificate from its own.
If the project enforces SSL, an unencrypted string is refused by the server. Which of these to
use is a decision for whoever owns the staging project; nothing in this repository makes it.

---

## 3 · Standing up a project

```bash
# The variables from §2 set in this shell.

# 1. Apply the schema: every structural migration, in filename order, each in its own
#    transaction. --staging refuses before it connects unless DATABASE_URL belongs to the
#    project in STAGING_SUPABASE_URL, that project is confirmed by
#    STAGING_CONFIRMED_NOT_PRODUCTION=yes, and it is not the production project.
DATABASE_URL=$STAGING_DATABASE_URL npm run db:migrate -- --staging

# 2. Confirm what landed. "No drift" is the only good answer.
DATABASE_URL=$STAGING_DATABASE_URL npm run db:status -- --staging
```

**The staging workflow runs exactly these two commands** before the suite (§6); running them
by hand is only needed without it.

**What a clean project receives.** Ten structural migrations — `0001`, then `0003` through
`0011` — creating the tables the suite writes to, their RLS and their revokes. `0004` and
`0005` also insert one row each: tenant #1 (`srivillu`) and its workbook binding. That is
schema, not test data; the suite neither needs it nor touches it.

`db:migrate` ends by sending `NOTIFY pgrst, 'reload schema'`, so PostgREST sees the new tables
without a restart. `db:status` changes nothing except creating the empty `schema_migrations`
ledger when it is absent. Re-running either is safe: a second `db:migrate` applies nothing.

`0002_demo_identities.sql` is excluded by default. It is a demo-project seed, not schema, and
it depends on four `auth.users` rows that only exist once those addresses have been invited
through the Supabase dashboard. Pass `--include-seed` only on a project where you have done
that; on a staging project used by this suite you do not need it at all — the suite creates
its own users.

---

## 4 · Running the verification

```bash
npm run test:staging
```

Three outcomes, kept deliberately distinct:

| Output | Meaning |
|---|---|
| `CONFIGURATION_REQUIRED — not set: …` | Nothing configured. Tests skip. **Not a pass and not a failure.** |
| `REFUSED — PRODUCTION: …` | Configured, but pointing somewhere it must not. **This is a failure.** |
| Tests run | The real stack was exercised. |

The banner is printed once at the top of the run, so which of the three you are looking at is
never in doubt.

### What it exercises

Two suites, 41 tests:

- `tests/staging/rls.staging.test.ts` — real GoTrue sign-in → real JWT → PostgREST → RLS.
  Positive tests first (a signed-in user reads their own identity and membership), then 19
  tables asserted unreachable, then writes, then membership-switching attacks.
- `tests/staging/repositories.staging.test.ts` — the **actual** MAKAM repositories against
  the real stack: HR, finance, operations, audit, the operation store and the identifier
  allocator.

---

## 5 · Seeding, and cleaning up

The suite seeds itself. `createStagingWorld()` builds two tenants, two GoTrue users and two
memberships through the real APIs, and tears them down afterwards.

Every row it creates is stamped `MAKAM-STAGING`, and **teardown deletes only rows it created**
— by id, never by an unqualified `DELETE`. A staging project may hold somebody else's work,
and a teardown that assumes otherwise is the thing that destroys it.

Before it creates anything, `createStagingWorld()` checks that PostgREST can see the schema.
If building a world fails partway, it removes what it had created, by id, before reporting the
failure.

The synthetic users live on `@makam-staging.invalid`. RFC 2606 reserves `.invalid`, so no
message these accounts generate can reach a real person.

### Resetting

There is deliberately **no reset command in this repository**. To rebuild a staging project,
use Supabase's own dashboard or CLI against that project, and confirm the project reference
by eye before you do. A `db reset` wired into an npm script is a keystroke away from being run
against the wrong target; the small inconvenience is the safety feature.

---

## 6 · CI

Two workflows, and the split is deliberate:

| Workflow | Trigger | Secrets |
|---|---|---|
| `ci.yml` | every push and pull request | **none** — throwaway `postgres:16` container |
| `staging.yml` | `workflow_dispatch` only, bound to the `staging` GitHub Environment | the staging keys and `STAGING_DATABASE_URL` |

Ordinary pull requests must never need private credentials: a fork cannot be given them, and
a pipeline only its owners can run is one most contributors cannot use. The staging workflow
requires a typed confirmation, runs one at a time, applies the migrations to the confirmed
staging project (`db:migrate -- --staging`), runs the suite, and re-runs the suite with the
staging URL also marked as production — passing only if the suite refuses.

If the API secrets are set but `STAGING_DATABASE_URL` is not, the run fails at the migration
step with `CONFIGURATION_REQUIRED` rather than testing a project that has no schema. A refused
or failed migration fails the step, and the suite does not run.

`npm run scan:secrets` runs in both, and in `npm run gate`.

---

## 7 · Secret handling

- **Never** in source, a commit, a log, a test snapshot, a report, or a chat message.
- `.gitignore` covers `.env*` with `!.env.example`; the example ships names with empty values
  and a test asserts that per line.
- `npm run scan:secrets` scans tracked files for credential **shapes** — JWTs, connection
  strings with passwords, private-key blocks, OpenAI and AWS keys. It **never prints the
  match**, only the file, line and rule: a scanner that echoes what it found puts the secret
  in the CI log, where it outlives the commit that leaked it.
- The database command prints its target with the username, the password and any
  password-like query parameter replaced by `***`.
- If a real key is ever committed: **rotate first**, then remove it. The value is already in
  the reflog and in every clone; rewriting history does not un-leak it.

---

## 8 · Staging versus production — what actually differs

| | Staging | Production |
|---|---|---|
| Data | Synthetic, `MAKAM-STAGING`-stamped | Real customers |
| The suite | Creates and deletes freely | **Refused. There is no flag.** |
| Migrations | `npm run db:migrate -- --staging` | `npm run db:migrate -- --confirm-production`, snapshot first |
| Rollback | Rebuild the project | Restore from snapshot, or forward-fix |
| Auth users | Created and deleted by the suite | Real people |

---

## 9 · Troubleshooting

| Symptom | Cause | Do |
|---|---|---|
| `CONFIGURATION_REQUIRED` listing four names | Nothing is configured. | Set them in `.env.local`. |
| `REFUSED — PRODUCTION` | The target matches a `PRODUCTION_*` setting. | The guard is working. Point it elsewhere. |
| `REFUSED — UNKNOWN` on a `supabase.co` host | Declared but not confirmed, confirmed with something other than `yes`, or confirmed but not declared. | Set `STAGING_SUPABASE_URL`, and `STAGING_CONFIRMED_NOT_PRODUCTION` to exactly `yes`. |
| Sign-in fails for the synthetic users | Email confirmation is enforced on the project. | The suite passes `email_confirm: true`; check the project's auth settings allow admin-created users. |
| `relation "…" does not exist` | Migrations have not been applied. | `DATABASE_URL=$STAGING_DATABASE_URL npm run db:migrate -- --staging`. |
| `Could not find the table 'public.tenants' in the schema cache` (PGRST205) | The migrations have not been applied to this project — or were, and PostgREST has not reloaded. | Apply them (§3); `db:migrate` asks PostgREST to reload. The harness checks this before it creates anything, and waits up to 30 s for a reload. |
| `CONFIGURATION_REQUIRED — STAGING_DATABASE_URL is not set` in the workflow | The environment has the API secrets but no database connection. | Add the Session pooler string (§2) as `STAGING_DATABASE_URL` on the `staging` environment. |
| `REFUSED — …` from `db:migrate -- --staging` | The connection is not the confirmed staging project's, no project is confirmed, or the string redirects the driver. | Read the reason; it says which. Nothing lifts a production match. |
| `[MISSING_FILE]` from `db:status`, failing the workflow | The project's ledger records a migration this commit does not have — another branch's, or `0002` applied with `--include-seed`. | The schema is not the one this commit describes, so its tests would prove nothing. Rebuild the project (§5), or run the branch that has that migration. |
| `ENETUNREACH`, or a timeout, reaching `db.<ref>.supabase.co` | The direct host is IPv6; GitHub-hosted runners are IPv4-only. | Use the Session pooler string. |
| `self-signed certificate in certificate chain` | `sslmode=require` without `uselibpqcompat=true`: node-postgres verifies against the system's CAs, and Supabase issues its certificate from its own. | See *Encryption* (§2). |
| Tests leave rows behind | A run was interrupted before teardown. | Delete rows whose tenant slug begins `makam-staging-`. Never an unqualified delete. |

---

## 10 · What this runbook cannot tell you yet

§1–§3 were written from the code before any hosted project existed. The first real runs found
two things this document got wrong — Node 20, and no step anywhere that applied the schema —
and both are corrected above. **Nothing in §4 has yet been observed to reach an assertion
against a hosted project**, and the encryption options in §2 are read from node-postgres's
parser, not yet observed against Supabase. Expect the first run that does to find something
else, and correct it here.
