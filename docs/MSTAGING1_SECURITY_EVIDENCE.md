# M-STAGING-1 — security evidence

What is proven, where the proof lives, and — the part that matters most in this milestone —
what is **not** proven and why.

## The classification, applied honestly

| Label | Means |
|---|---|
| **PROVEN** | Exercised against real hosted Supabase |
| **LOCALLY PROVEN** | Exercised against real PostgreSQL (PGlite 18.3, or `postgres:16` in CI) |
| **UNPROVEN** | Not exercised |
| **BLOCKED** | Needs infrastructure or a credential that does not exist |

**Nothing in this document is PROVEN.** No hosted Supabase project exists for this
repository: every `STAGING_*` and `*_SUPABASE_*` variable is absent, there is no
`supabase/config.toml`, and no credential of any kind is present in the environment or the
tree. The verification suite is written, complete and runnable; it reports
`CONFIGURATION_REQUIRED` and skips 41 tests.

That is stated first because everything below is easy to misread as a claim about Supabase.
It is not. It is a claim about PostgreSQL, plus a suite that is ready to make the Supabase
claim the moment a project exists.

---

## 1 · Authentication and tenant resolution — **BLOCKED**

| Claim | Status | Where |
|---|---|---|
| GoTrue issues a session whose subject is the auth user | BLOCKED | `tests/staging/rls.staging.test.ts` |
| `auth.uid()` inside a policy equals that subject | BLOCKED | same |
| Tenant comes from the verified membership, not request input | LOCALLY PROVEN | `tests/infrastructure/rls.test.ts`, `tests/security.test.ts` |
| A signed-out caller learns nothing | BLOCKED | `tests/staging/rls.staging.test.ts` |

The application does not use Supabase Auth today — it runs a demo identity chooser under
`APP_ENV=demo`, and the production path is unexercised. So the auth chain is written and
waiting, not verified. The staging suite drives the real password sign-in deliberately rather
than minting a JWT, because the token PostgREST must accept is the one GoTrue actually
issues.

## 2 · RLS — **LOCALLY PROVEN**, not PROVEN

| Claim | Status |
|---|---|
| RLS is enabled on all 30 tables | LOCALLY PROVEN |
| Only two policies exist, neither mentioning a tenant | LOCALLY PROVEN |
| A browser role reads zero rows from every business table | LOCALLY PROVEN |
| Every write by a browser role is refused, and changes nothing | LOCALLY PROVEN |
| **The same, through PostgREST with a real JWT** | **BLOCKED** |

This is the distinction the milestone brief insists on, and it is a real one. Local tests
`SET ROLE authenticated` and set `request.jwt.claim.sub` directly. PostgREST does the same
thing from a verified JWT — but "does the same thing" is the assumption, and assumptions
about the layer under test are what this milestone exists to remove.

**Restating the model, because it is easy to overclaim:** MAKAM does not isolate tenants with
RLS policies. There are two policies and neither mentions a tenant. Isolation comes from
`REVOKE` plus deny-by-default plus application predicates run under the service role. RLS is
the lock on a door the application does not use — worth having, worth testing, and not the
tenant boundary.

## 3 · PostgREST and the repositories — **BLOCKED**

The gap M-INFRA-1 named as its top risk, and it is still open. The repositories speak to
PostgREST through `@supabase/supabase-js`; neither PGlite nor `postgres:16` provides
PostgREST, so no local test can exercise them end to end.

That gap is where three real defects were found — an approval written to a column whose enum
had no such value, an `updated_at` stamped on six tables that have none, and a reassignment
that never superseded. All three are fixed and pinned by
`tests/infrastructure/repository-schema.test.ts`, and all three are re-asserted through the
real stack in `tests/staging/repositories.staging.test.ts` — where they are BLOCKED.

**The class of defect is not closed.** Three were found by inspection once a real schema
existed; there is no reason to believe three is the number.

## 4 · Composite foreign keys — **LOCALLY PROVEN**

Migration `0009` made 24 cross-tenant-capable foreign keys carry the tenant. A catalog query
asserts no such key can be added again. Verified against real PostgreSQL; the staging suite
re-asserts it through the repositories, where it is BLOCKED.

## 5 · Service-role boundary — **LOCALLY PROVEN, and strengthened**

| Claim | Status |
|---|---|
| One module reads the key; all use sites are server-only | LOCALLY PROVEN |
| No client component imports server code by value | LOCALLY PROVEN |
| No `NEXT_PUBLIC_*` carries a secret | LOCALLY PROVEN |
| **A client import is now a BUILD error, not a runtime throw** | LOCALLY PROVEN |

M-INFRA-1 reported that `lib/server/only.ts` described the `server-only` package as "the
primary control" while not depending on it. That is now fixed: `server-only` is a real
dependency and is imported there. Next resolves it to a throwing module under the client
condition, so importing any server module from a Client Component fails `next build`.

Vitest resolves it to the package's own `empty.js` — the same file a React Server Component
build gets — via an alias in `vitest.config.mts`. Nothing is stubbed; tests exercise the real
module graph.

The public/server split: **public** is the Supabase URL and the anon key; **server** is the
service-role key, which bypasses RLS and must never reach a browser.

## 6 · Audit reason and error redaction — **LOCALLY PROVEN, and a real leak closed**

M-INFRA-1 flagged `audit.reason` as a suspected raw-error path. It was worse than suspected:

- `redactMetadata` applied to **one** field, `metadata`. `reason` bypassed it entirely.
- The guard's catch-all set `reason` to the raw message of **any** unhandled exception —
  including every PostgREST failure the repositories rethrow, i.e. PostgreSQL's own text
  naming relations, columns and constraints.
- The same raw string was stored in the operation ledger and **returned to the browser** by
  `GET /api/operations-log/:id`, and interpolated into a 409 body rendered on screen.
- It had no length cap.

`lib/server/audit/reason.ts` closes this with an **allow-list**: a message survives only when
this application authored it — the deliberate, reviewed refusals in the domain error classes.
Everything else becomes a coarse code (`DATABASE_ERROR`, `UPSTREAM_ERROR`, `TIMEOUT`,
`INTERNAL_ERROR`) classified from the error's *shape*, never from its text.

Allow-list rather than deny-list on purpose: blocking known-dangerous patterns assumes we can
enumerate every shape a leak takes, and every new upstream invents one nobody predicted.

The full error still reaches the server log, where the operator can read it and the browser
cannot. The two existing tests that assert an audit reason names the missing capability still
pass unchanged — which is the design working: our own sentences survive, upstream text does
not.

`boundReason` is belt and braces at the sink: URLs and JWT-shaped tokens stripped, 512
characters maximum, applied to whatever any future call site hands it.

## 7 · Environment protection — **LOCALLY PROVEN**

`classifyTarget` returns LOCAL / TEST / STAGING / PRODUCTION / UNKNOWN, and the ordering is
the security property: **PRODUCTION is decided first**, so a host that is both declared as
staging and named as production is PRODUCTION. There is no flag that lifts it, and a test
asserts the contradiction resolves that way.

An undeclared hosted Supabase host is UNKNOWN and refused. Guessing "this looks like staging"
is the guess that ends with a suite deleting a customer's rows.

Hostnames are compared, not hosts — the bug M-INFRA-1's own guard had, where
`db.example.com:5432` never matched `https://db.example.com` and the refusal could never
fire.

## 8 · Secret scanning — **LOCALLY PROVEN**

`npm run scan:secrets` scans tracked files for credential shapes and **never prints the
match** — only file, line and rule name. Tests prove it catches a service-role JWT, a
password-bearing connection string to a routable host, a private-key block and an OpenAI key,
and that it ignores RFC 2606 reserved hosts and the empty names in `.env.example`.

One bug was caught by its own tests during construction: the scanner `statSync`ed before
reading, so an injected reader was never used — it would have reported a clean tree because
it read no files at all. Exactly the failure a secret scanner must not have.

## 9 · Attack scenarios

| # | Attack | Status |
|---|---|---|
| 1 | Tenant id in the JSON body | LOCALLY PROVEN — strict schemas; tenant never read from a body |
| 2 | Tenant id in the query string | LOCALLY PROVEN |
| 3 | Another tenant's property id | LOCALLY PROVEN |
| 4 | Another tenant's employee id | LOCALLY PROVEN — composite FK, `0009` |
| 5 | Another tenant's payment id | LOCALLY PROVEN |
| 6 | Another tenant's operation id | LOCALLY PROVEN — tenant compared before hash |
| 7 | Reading another tenant's audit | LOCALLY PROVEN |
| 8 | Calling a service-role-only RPC | LOCALLY PROVEN — `42501`; BLOCKED through PostgREST |
| 9 | Browser reaching the service role | LOCALLY PROVEN — now a build error |
| 10 | Test runner reaching production | LOCALLY PROVEN — refused, and CI proves the refusal |

## 10 · FORCE ROW LEVEL SECURITY — analysed, deliberately not enabled

A table's owner bypasses RLS unless `FORCE` is set, and no table sets it. The question is
whether to.

**Not enabled, and the reason is that it cannot be decided locally.** On a hosted project the
tables would be owned by whichever role applies the migrations — typically `postgres`, whose
`BYPASSRLS` attribute differs between Supabase and a stock server. Enabling `FORCE` against
an owner that lacks `BYPASSRLS` locks that role out of its own tables and breaks migrations
and admin access.

It also buys little here: the application connects as `service_role` (which has `BYPASSRLS`),
and browser roles are neither owner nor superuser, so RLS already applies to them — proven
locally. `FORCE` would only matter if something connected as the table owner, and nothing
does.

**Decision: revisit on a real staging project**, where the owner and its attributes can be
read rather than guessed. Enabling it blind to satisfy a checklist is how an infrastructure
change breaks an application.

## 11 · What would change these labels

One thing: an authorized Supabase project. With `STAGING_SUPABASE_URL`,
`STAGING_SUPABASE_ANON_KEY`, `STAGING_SUPABASE_SERVICE_ROLE_KEY` and
`STAGING_CONFIRMED_NOT_PRODUCTION` set, `npm run test:staging` moves rows 1, 2, 3 and 8 of
this document from BLOCKED to PROVEN in a single run — or finds that they were never true,
which is the more valuable outcome and the reason the suite exists.
