# PHASE D — DEMO/UAT ENVIRONMENT REPORT

Date: 2026-08-24 · Branch: master · Contract: `459a6a48fad6ea5f` (no drift)

## The one-paragraph truth

Every piece of Phase D that can exist as code, tests, or documentation is built, green,
and waiting. What does not yet exist is the **cloud resources themselves** — the demo
Google workbook, its service account, and the demo Supabase project — because creating
them requires the project owner's Google and Supabase accounts, which no credential on
this machine can reach (and account sign-in is not something this agent performs).
**docs/DEMO_PROVISIONING.md** is the exact, hand-off-ready runbook (~60–90 min, mostly
waiting for the workbook builder). The moment `.env.local` exists, the remaining Phase D
evidence is produced by four commands: `npm run demo:preflight` → `npm run demo:spikes`
→ `npm run demo:snapshot` → `npm run e2e:real`. Until the six spikes pass, no claim is
made anywhere — UI, docs, or this report — that Google Sheets write behaviour is proven.

## 1 · Google Sheets write spikes (D2)

**PENDING — not run.** `npm run demo:spikes` requires `DEMO_GOOGLE_SHEET_ID` /
`DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, which do not exist yet. The spike script is
in place, refuses production ids and non-demo workbook titles, and reports PENDING
honestly when unconfigured (verified: it exits with the six-line PENDING report).
`LIVE_DATA_ENABLED` stays `false` and the provisioning runbook forbids flipping it until
the report ends `VERDICT: ALL SPIKES PASS`.

## 2 · Demo workbook verification (D1)

**Tooling ready, PENDING execution.** New `npm run demo:preflight`
(scripts/demo-preflight.mjs) verifies, read-only, against the generated contract: all 22
tabs, all 60 required named ranges, header rows cell-for-cell, seeded records in eight
table sheets, live calculated columns (three probes), sheet protections, locale. It
refuses a workbook shared with production or parity ids and any title not marked
demo/test/copy/uat. Workbook creation itself is `setupWorkbook()` + `seedTestData()` from
the untouched V1 bundle, per the runbook.

## 3 · Provider status (D3)

**Code path complete and selected automatically.** With `APP_ENV=demo`,
`LIVE_DATA_ENABLED=true` and DEMO credentials present, `getDataProvider()` serves
`GoogleSheetsDashboardDataProvider` over `createLiveSheetsClient` (DEMO_* variables
only), and the mutation service binds the same live client — reads and writes hit the
real workbook with no fixture involvement. Environment resolution rejects shared
demo/production resources at startup (`tests/environment.test.ts`, 32 tests), and the
parity harness refuses a parity sheet equal to either (`tests/parity-preflight.test.ts`),
so DEMO ≠ PARITY ≠ PRODUCTION is enforced by tests in both directions.

## 4 · Demo authentication (D6)

**Code complete since Phase 5; provisioning automated this phase.** When
`DEMO_SUPABASE_*` is configured, sign-in switches automatically from the identity
chooser to real email/password through `SupabaseAuthProvider` (the chooser branch
becomes unreachable). New `npm run demo:users` (scripts/demo-users.mjs) creates the four
demo accounts through the Supabase admin API with **run-time-generated passwords printed
once and stored nowhere**, and upserts `app_users` with the real auth ids — replacing
migration 0002's manual invite-and-edit-uuids flow. It refuses to touch a project whose
`app_users` holds any non-`@srivillu.demo` account. **Not yet executed** — no demo
project exists.

## 5 · Role matrix

Unchanged from Phase C and still green in the pinned suites (RBAC, page-access, UI —
part of the 813): ADMIN full demo access; OPERATIONS holds
reservation/housekeeping/maintenance/inventory workflows and no finance capability;
INVESTOR sees exactly their own portfolio. The real-demo suite re-proves the same
matrix against live Supabase auth (tests 02, 15, 16) once credentials exist.

## 6 · Write and read-after-write tests (D4/D5)

**Against the in-memory demo store: proven** (Phase C, re-verified today — see §7).
**Against the real workbook: PENDING**, and encoded as `e2e/real-demo.spec.ts` so the
evidence is one command, not a promise: the scripted ₹4,321 expense through the drawer
(test 07), UI → Google → engine → dashboard arithmetic `MTD Expenses +4,321` asserted
numerically (test 18), reload persistence (test 19), full reservation lifecycle
(05/12/13/14), CAPEX/maintenance/inventory/housekeeping (08–11), duplicate-submit
exactly-one-row (06), calculated-column injection 422 (17). Every mutation runs the
same MutationPipeline: auth → RBAC → validation → idempotency → atomic id → verified
first-blank-row write → read-after-write → cache invalidation → audit.

## 7 · Test results (this build, fixtures environment)

| Gate | Result |
|---|---|
| `contract:check` | OK — no drift (`459a6a48fad6ea5f`) |
| `typecheck` | clean |
| `lint` | clean |
| `vitest` | **818 passed, 11 skipped, 0 failed** (25 files) |
| `next build` | clean |
| Playwright (full suite) | **44 passed, 20 skipped, 0 failed, 0 flaky** (3.3 min, from a cold server) |
| Playwright `real-demo` | the 20 skips above — **all PENDING** against fixtures; by design nothing can pass that suite on the in-memory provider |

The four Playwright tests previously recorded here as "flaky under dev-server cold
compiles" were not a timing artefact. They failed on a single worker with retries
disabled, which timing cannot explain; the cause was §7a below, and they now pass first
time.

## 7a · Demonstration state survived only until the next screen

Found and fixed after the first Phase D report. `next dev` re-evaluates the server module
graph whenever it compiles a route it has not served before, which reinitialised every
module-level singleton holding demonstration state — the in-memory workbook, the
operation ledger, the id sequences and the read cache.

Measured, before the fix: record an expense, open three not-yet-compiled screens, and
`/api/operations-log/<id>` went **200 → 404** while the row vanished from the ledger.
The documented walkthrough does exactly that — create a booking in step 5, open
Housekeeping in step 7 — so a record could have disappeared in front of a client.

Those singletons now live in a `globalThis`-keyed slot
(`lib/server/runtime/process-state.ts`), the standard Next.js remedy. Production is
unaffected: modules evaluate once there, so the first read initialises exactly as before.
Derived caches were left module-level deliberately, with one exception — the read cache,
whose *identity* is load-bearing because the mutation router calls `invalidate` on it;
two instances would have meant a write clearing a cache nobody reads.

Verified: same cold navigations now give **200 → 200** with the row intact;
`e2e/demo-state.spec.ts` pins it by navigating to screens no other spec visits.
`e2e/demo-reset.spec.ts` additionally covers the reset end to end for the first time —
it runs in its own Playwright project so it cannot wipe state underneath the other specs.

## 8 · Demo reset (D7)

**Built and proven at the client interface; live execution PENDING credentials.** The
reset now has two honest shapes behind the same admin-only, demo-environment-only
control (`authorizeDemoOperation`: environment first, then the `demo.control`
capability):

- **Fixtures:** regenerate the dataset from seed (unchanged behaviour).
- **Live workbook:** restore every table sheet's **input cells** to a captured seed
  snapshot — seeded rows rewritten, demonstration rows cleared, calculated columns
  never addressed (the client's `assertWritable` refuses them structurally) — then
  **verified by re-reading every sheet**; a reset that cannot prove the workbook matches
  the seed throws and says so. It then clears the demo project's `operations`,
  `id_allocations` and `id_sequences` tables (keeping `app_users` and `audit_log` —
  accounts survive, audit history is not erasable), resets in-process state, and only
  after a verified restore invalidates the read cache. Both reset and seed-capture are
  audited (`demo.reset.live`, `demo.seed.captured`) through the same sinks as mutations.

Snapshot capture: `npm run demo:snapshot` (CLI) or the new **Capture seed snapshot**
button on Demo controls; snapshots are contract-hash-locked (a snapshot from a drifted
contract is refused rather than restored wrongly). Without a snapshot the reset refuses
with a plain message. Impossible in production three ways: the route returns 404 via the
environment gate, the module throws standalone, and production has no demo-controls
page. Proof at the shared client interface: `tests/live-reset.test.ts` (8 tests —
capture shape, round-trip restore after simulated demo damage, idempotency, loud
read-back failure, contract-drift refusal, demo-only technical reset).

## 9 · Playwright real-demo suite (D8)

`e2e/real-demo.spec.ts` — 20 tests matching the brief 1:1, **serial** (real Google API
quota, shared state, reset last), reading the live/fixtures truth from the running app's
sign-in page: against fixtures every test skips as `PENDING`; nothing can "pass" this
suite on an in-memory provider. Sign-in adapts to chooser or real email/password
(passwords via `DEMO_E2E_*_PASSWORD` environment variables only). Seeded property ids
and trading months are read from the app's own forms — nothing about the workbook's
story is hard-coded.

## 10 · Client walkthrough (D9)

**docs/DEMO_WALKTHROUGH.md** — 14 steps ≈ 20 minutes, every step with WHAT TO CLICK /
WHAT TO SAY / WHAT THE SYSTEM SHOULD SHOW, all labels and toasts quoted from the code,
plus a pre-demo checklist and an "if something goes wrong" box. Honest in both modes
(fixtures or live workbook) including the reset semantics for each. A real product gap
it exposed was fixed rather than scripted around: the working reservations register was
URL-only, so the Operations navigation gained **Bookings**, **Check-ins** and
**Check-outs** (capability-mapped, one-active-item invariant preserved).

## 11 · Known limitations

- **The demo data story is V1's.** The live workbook's records come from
  `seedTestData()` untouched (Phase D's stop condition forbids modifying V1). The
  brief's suggested board (HYD-501 occupied, etc.) is fully realized in the in-memory
  scenarios; the workbook tells the seeder's equivalent story. If the owner wants the
  workbook's story hand-tuned for presentations, the path is: edit rows in the sheet →
  `npm run demo:snapshot` — the reset then preserves that curation.
- The walkthrough quotes fixture investor names ("Anand Rao", "Meera Krishnan") in two
  SHOULD-SHOW blocks; in workbook mode the equivalent INV-001/INV-002 identities come
  from the seeder and the names will differ.
- Scenario switching and the scripted guest journey are fixtures-only and are refused
  (409, plain message) and hidden when the live workbook is the data source.
- The live reset restores table-sheet input cells; `02_SETTINGS` changes made by hand in
  the workbook are outside the web app's write surface and are not reverted.
- Reset audit events reach Supabase only when the demo project is configured; with
  Google-only credentials they land in the in-memory sink (process-lifetime).

## 12 · Exact environment configuration

Demo (once provisioned; see docs/DEMO_PROVISIONING.md for the full runbook):

```
APP_ENV=demo
LIVE_DATA_ENABLED=false            # true ONLY after ALL SPIKES PASS
DEMO_GOOGLE_SHEET_ID=…
DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=…
DEMO_SUPABASE_URL=…
DEMO_SUPABASE_SERVICE_ROLE_KEY=…
DEMO_SUPABASE_ANON_KEY=…
DEMO_SUPABASE_AUTH_COOKIE=sb-<ref>-auth-token
# optional: DEMO_SEED_SNAPSHOT_PATH (default .demo/seed-snapshot.json)
```

No `PRODUCTION_*` variable is present anywhere on this machine; production writes remain
**OFF** (`PRODUCTION_WRITES_ENABLED` untouched, default false); no production resource
was read, written, or configured during Phase D. WhatsApp, OpenAI and all external guest
contact remain disabled. V1 (`homestay-ops/`) is untouched — `contract:check` proves the
web app still matches its generated contract exactly.

## What remains, and exactly who does what

**Owner (once, ~60–90 min):** follow docs/DEMO_PROVISIONING.md — build + seed the demo
workbook, create the service account and share the sheet, create the Supabase project,
apply migrations 0001+0003, write `.env.local`, run `npm run demo:users`.

**Then (agent or owner, ~15 min):** `npm run demo:preflight` → `npm run demo:spikes` →
flip `LIVE_DATA_ENABLED=true` → `npm run demo:snapshot` → `npm run e2e:real` → append
the live results to this report.

Phase D's stop condition cannot be met before those credentials exist; nothing else
blocks it.
