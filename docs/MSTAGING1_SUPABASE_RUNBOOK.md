# M-STAGING-1 — the Supabase staging runbook

How to stand up a MAKAM staging project, point the suite at it, and run the verification this
milestone built.

> **No staging project exists for this repository today.** Every variable is unset, there is
> no `supabase/config.toml`, and no credential of any kind is present. The suite below is
> complete and runs on demand; it currently reports `CONFIGURATION_REQUIRED` and skips 41
> tests. That is the honest third outcome, not a pass. See
> [`MSTAGING1_SECURITY_EVIDENCE.md`](MSTAGING1_SECURITY_EVIDENCE.md) for what this means for
> every security claim.

---

## 1 · Prerequisites

| Need | Why |
|---|---|
| Node 20 | The repository's engine. |
| A Supabase project you can afford to lose | The suite creates users, tenants and rows, and deletes them again. Use a project created for this purpose. |
| That project's URL, anon key and service-role key | From the project's API settings. |

Nothing else. The Supabase CLI is optional; migrations are applied by this repository's own
runner (`npm run db:migrate`), which needs only a PostgreSQL connection string.

---

## 2 · Configuration

Put these in `.env.local`, which is git-ignored. **Never** in source, a commit, a CI file, or
a chat message.

| Variable | What it is |
|---|---|
| `STAGING_SUPABASE_URL` | The project URL, e.g. `https://abcdefgh.supabase.co`. |
| `STAGING_SUPABASE_ANON_KEY` | The publishable key. This is the key a browser would carry. |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | The trusted server key. **Bypasses RLS entirely.** Server only, never a browser, never a log. |
| `STAGING_CONFIRMED_NOT_PRODUCTION` | Set to `yes`. An explicit statement that the project above is disposable. |
| `STAGING_DATABASE_URL` | *(optional)* Direct PostgreSQL connection, for `db:migrate` and catalog inspection. |

`STAGING_CONFIRMED_NOT_PRODUCTION` is not ceremony. A hosted Supabase host is, by definition,
somebody's real project; the suite refuses one that nobody has vouched for rather than
guessing from its name.

### The veto

If `PRODUCTION_SUPABASE_URL` or `PRODUCTION_DATABASE_URL` is set and resolves to the same
**hostname**, the target is classified `PRODUCTION` and refused — regardless of the staging
variables, and **no flag lifts it**. Set your production URL in the environment and the
refusal becomes structural rather than a matter of remembering.

---

## 3 · Standing up a project

```bash
# 1. Apply the schema. Ten migrations, in order, each in its own transaction.
STAGING_DATABASE_URL=... DATABASE_URL=$STAGING_DATABASE_URL npm run db:status
DATABASE_URL=$STAGING_DATABASE_URL npm run db:migrate

# 2. Confirm what landed.
DATABASE_URL=$STAGING_DATABASE_URL npm run db:status
```

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
| `staging.yml` | `workflow_dispatch` only, bound to the `staging` GitHub Environment | the staging keys |

Ordinary pull requests must never need private credentials: a fork cannot be given them, and
a pipeline only its owners can run is one most contributors cannot use. The staging workflow
requires a typed confirmation, runs one at a time, and re-runs the suite with the staging URL
also marked as production — passing only if the suite refuses.

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
- If a real key is ever committed: **rotate first**, then remove it. The value is already in
  the reflog and in every clone; rewriting history does not un-leak it.

---

## 8 · Staging versus production — what actually differs

| | Staging | Production |
|---|---|---|
| Data | Synthetic, `MAKAM-STAGING`-stamped | Real customers |
| The suite | Creates and deletes freely | **Refused. There is no flag.** |
| Migrations | `npm run db:migrate` | `npm run db:migrate --confirm-production`, snapshot first |
| Rollback | Rebuild the project | Restore from snapshot, or forward-fix |
| Auth users | Created and deleted by the suite | Real people |

---

## 9 · Troubleshooting

| Symptom | Cause | Do |
|---|---|---|
| `CONFIGURATION_REQUIRED` listing four names | Nothing is configured. | Set them in `.env.local`. |
| `REFUSED — PRODUCTION` | The target matches a `PRODUCTION_*` setting. | The guard is working. Point it elsewhere. |
| `REFUSED — UNKNOWN` on a `supabase.co` host | Declared but not confirmed, or confirmed but not declared. | Set both `STAGING_SUPABASE_URL` and `STAGING_CONFIRMED_NOT_PRODUCTION`. |
| Sign-in fails for the synthetic users | Email confirmation is enforced on the project. | The suite passes `email_confirm: true`; check the project's auth settings allow admin-created users. |
| `relation "…" does not exist` | Migrations have not been applied. | `DATABASE_URL=$STAGING_DATABASE_URL npm run db:migrate`. |
| Tests leave rows behind | A run was interrupted before teardown. | Delete rows whose tenant slug begins `makam-staging-`. Never an unqualified delete. |

---

## 10 · What this runbook cannot tell you yet

Everything in §3 and §4 is written from the code, not from a run: **no step here has been
executed against a hosted Supabase project**, because none exists. The commands are real and
the suite is real, but the first person to run §3 should expect to find at least one thing
this document got wrong, and should correct it here.
