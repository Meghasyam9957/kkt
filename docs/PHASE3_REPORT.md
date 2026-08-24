# Phase 3 Report — Authentication, RBAC, Isolation, Audit, Atomic IDs

**Built:** Supabase auth, role/capability model, three-layer authorization, investor
row-level isolation, audit logging, atomic ID allocation, RBAC + security test suites,
design-token foundation, live-parity environment prep.

**Not built (by instruction):** UI, dashboards, guest AI, OpenAI workflows, operational
write APIs. V1 untouched and re-verified green.

```
npx tsc --noEmit   clean (strict, noUncheckedIndexedAccess)
npx vitest run     269 passed, 2 skipped (live parity), 0 failed  — 9 suites

OVERALL PARITY GATE: PENDING   ← offline PASS, LIVE not yet run
```

---

## 1. RBAC test results

**112 / 112 combinations pass** — 28 routes × 4 roles, exhaustively, generated from the
route registry so any route added later is covered the moment it is declared.

| | |
|---|---:|
| Routes declared | 28 |
| Roles | 4 |
| Combinations tested | **112** |
| Expected ALLOW (all reached) | 56 |
| Expected DENY (all refused) | 56 |
| Failures | **0** |

Enforcement is at three independent levels, and the suite proves the API layer refuses a
request the UI layer would also hide — so hiding a menu item is never the control:

| Level | Mechanism | Proven by |
|---|---|---|
| 1. UI navigation | `rolesForRoute` / `canLoadRoute`, longest-prefix match | 4 tests |
| 2. API | `withAuth(capability)` around every route | 112-combination matrix |
| 3. Data / query | services take a server-resolved scope and filter again | isolation suite |

Additional authentication cases, all passing: unauthenticated → 401; forged/unknown token
→ 401; malformed `Authorization` header (5 variants) → 401; suspended account → 403 on
**every** route; session cookie accepted alongside bearer; undeclared endpoint → 404;
denial messages leak nothing about what exists.

**Role-model invariants asserted, not just documented:**
- OPERATIONS holds **no** financial capability (8 checked).
- INVESTOR holds **exactly one** capability: `investor.self.read`.
- ADMIN **cannot** write settings — business rules stay editable in the workbook only,
  under one audited path.
- Only SUPER_ADMIN can manage users or read the audit trail.
- Every route capability is granted to at least one role (no orphaned endpoints).
- Zero non-GET routes exist — the no-write-API instruction is enforced by test.

### One design change made during this phase

Investor-scoped routes were specified as "INVESTOR (+ADMIN read)". Implementing that
produced a management role arriving at an investor endpoint **with no scope**, forcing
either an unscoped query or an investor id supplied by the caller — the exact conditional
that breeds isolation bugs.

**Changed to:** `/api/investor/*` and `/investor/*` are INVESTOR-only. Management reviews
an investor through `/api/investors/:id` (`investors.read.all`), which legitimately takes
an id and is separately audited. The investor endpoints now have **no unscoped code path
at all**.

---

## 2. Investor isolation results

**18 / 18 attacks blocked across 15 distinct vectors. Zero unblocked.**

Investor A (`INV-001`) attempting to reach Investor B (`INV-002`):

| Vector | Result |
|---|---|
| `?investorId=INV-002` on all 4 investor routes | 403 |
| `?investor_id=INV-002` | 403 |
| Body `{ investorId }` | 403 |
| Body nested `{ filter: { investor: { investor_id } } }` | 403 |
| Body inside an array element | 403 |
| Header `X-Investor-Id` | 403 |
| URL path `/api/investor/INV-002/reports` | blocked (404) |
| Path param `/api/investors/INV-002` | 403 |
| All-investors endpoint `/api/investors` | 403 |
| Case/separator variants ×5 (`InvestorID`, `INVESTOR_ID`, `investor-id`, `Investor Id`, `investorid`) | 403 |
| **Supplying the caller's OWN id** | **403** |

That last one is deliberate. If a supplied id were ever acceptable, the safe path would
depend on a comparison — and comparisons are where these bugs live. The scope comes from
the session; there is nothing for a caller to tamper with.

**Positive path proven too** — isolation that returns nothing to anyone is not isolation:
A sees `INV-001` with 40% participation, B sees `INV-002` with 35%, their calculated
distributions differ, each sees exactly one row, and no response contains another
investor's identifier anywhere in the payload.

**Layer 3 tested independently of the guard:** `InvestorService` filters by investor id
itself, refuses an empty scope (rather than returning everything — the classic failure),
and errors on an unknown id instead of falling back.

**Disclosure scope:** every investor payload was scanned for guest PII, vendor/supplier
data, operational notes and cost detail. Portfolio figures expose net revenue, operating
profit, occupancy and distributable profit — and deliberately **not** `operatingExpenses`
or any expense breakdown.

---

## 3. Audit-log results

**84 requests → 84 records. No gaps, no duplicates, no ERROR rows, zero PII findings.**

Every specified field is captured: actor, role, action, entity type, entity id, timestamp,
result, plus reason, request id, IP and redacted metadata.

| Result | Count |
|---|---:|
| ALLOW | 25 |
| DENY | **59** |
| ERROR | 0 |
| Distinct actions | 28 |

Denials are recorded as carefully as successes — an audit trail that only shows what
worked cannot show an attack. An injection attempt records `result: DENY` with the reason
naming the vector (`query.investorId`), and unauthenticated attempts are logged with a
null actor rather than dropped.

**PII exclusion is structural.** Redaction happens inside `AuditLogger`, before any sink,
so no caller can opt out by forgetting. It covers key-based matching (case- and
separator-insensitive), nested objects, credentials/tokens, and value-level sweeps for
emails and long digit runs arriving under innocuous keys. Business identifiers
(`bookingId`, `investorId`, `propertyId`) survive — the log must stay useful. Oversized
strings are truncated so the log cannot be used as a data dump.

A failing sink logs loudly but never breaks the request it describes.

---

## 4. Atomic ID results

**200 concurrent allocations → 200 distinct ids, 0 duplicates, contiguous 1…200.**

The result that makes it meaningful:

| Implementation | Minted | Distinct | Duplicates |
|---|---:|---:|---:|
| Atomic allocator | 200 | **200** | **0** |
| `MAX + 1` (negative control) | 200 | 1 | **199** |

The forbidden pattern is implemented as `NaiveSequenceStore` and run through the *same*
test. It produces 199 duplicates. A concurrency test that cannot fail proves nothing;
this is what makes the zero above evidence rather than assertion.

Allocation is a single atomic Postgres statement (`INSERT … ON CONFLICT DO UPDATE …
RETURNING`) holding a row lock — never a read-then-write.

| Requirement | Status | Evidence |
|---|---|---|
| Concurrent-safe | ✅ | 200-way concurrency, 0 duplicates |
| No duplicates | ✅ | sequence only moves forward; contiguous block check |
| Retry-safe | ✅ | idempotency key replays the same block; 20 concurrent retries of one key → 1 id |
| Auditable | ✅ | every allocation logged with actor, scope, count, ids, and a `reused` flag |
| Format matches V1 | ✅ | `BK-2026-0001`, `REV-…`, `EXP-…`, `CAP-…`, `MNT-…`, `HK-…`, `INV-003` |

### An integration risk found and closed

V1's **Generate missing IDs** menu item uses `max(existing) + 1`. If the database started
at 1 while the workbook already contained `BK-2026-0007`, the web app would mint ids that
already exist in the sheet.

`seedFromExistingIds()` raises the sequence floor from the highest id present in the
workbook at cutover, and `seed_sequence_floor()` can never lower a sequence that has
advanced. Tested: after seeding from `[0001, 0007, 0003]`, the next allocation is `0008`.

**Operational rule for cutover:** once the web app is primary data entry, V1's *Generate
missing IDs* should not be used. Recorded in §6.

---

## 5. LIVE parity status

### PENDING — and the report says so

```
OFFLINE: PASS       212/212 checks
LIVE:    PENDING    not run — no credentials
OVERALL PARITY GATE: PENDING
```

The report generator was changed this phase to enforce the hard gate: it previously
computed PASS when LIVE had simply not run. It now reports **PENDING** and exits without
claiming success. Offline passing is necessary but not sufficient — it compares against
V1's *JavaScript*, not against Google's formula engine.

### Environment preparation — complete on my side

| Item | Status |
|---|---|
| `npm run parity:preflight` | ✅ built — verifies credentials, connectivity, all 22 tabs, all 60 named ranges, and that the workbook actually contains data |
| `npm run parity` | ✅ preflight → offline + live → report |
| LIVE suite | ✅ 312 comparisons (26 metrics × 12 months), read-only, never writes `CFG_REPORT_MONTH` |
| Runbook | ✅ `docs/LIVE_PARITY_RUNBOOK.md` |
| Report separation | ✅ OFFLINE and LIVE reported separately |

### What blocks it — and it is not something I can do

LIVE parity needs a deployed Google Sheet and a service-account key. Both require access
to your Google account. The runbook has the steps; they take about 20 minutes.

**Two honesty notes the preflight enforces:**

1. **Seed the copy first.** An empty workbook makes every comparison 0 vs 0 — passing
   while verifying nothing. The preflight warns explicitly.
2. **Business rules stay TBD.** That is correct for production and per your instruction,
   but it means the distributable-profit and investor-pool comparisons read 0 on both
   sides and pass trivially. To exercise that chain, set sample values **in the parity
   copy only**. The preflight states which mode is in effect. Nothing has been populated
   in any production workbook.

---

## 6. Remaining blockers

| # | Blocker | Owner | Blocks |
|---|---|---|---|
| B1 | **LIVE parity not run** — needs a deployed workbook + service account | You | Closing the parity gate; production sign-off |
| B2 | **Supabase project not provisioned** — migration written, not applied | You | Real login; Phase 4 against real accounts |
| B3 | Business rules TBD (investor pool, operator pool, reserve, loss treatment, mgmt fee, CAPEX recovery, distribution frequency, tax) | Management | Investor portal showing non-zero figures |
| B4 | Logo binary not in the repo | You | Nothing — tokens are in place; drop at `public/brand/srivillu-logo.png` |
| B5 | Rate limiting, secure response headers, CSRF | Me, Phase 11 | Production hardening (per the approved sequence) |
| B6 | Sheets read cache | Me, Phase 4 | Dashboard latency and Sheets quota headroom |

Nothing in B1–B4 blocks Phase 4 development; B1 and B2 block production.

**Not a blocker, but a decision to record:** once the web app becomes primary data entry,
V1's *Generate missing IDs* menu item must not be used, or it will mint ids the database
does not know about. The safe order at cutover is: run `seedFromExistingIds` once per
scope, then stop using the menu item.

---

## 7. Exact Phase 4 plan

**Phase 4 — Admin dashboard (read-only).** Awaiting your approval before any UI work.

### Prerequisites
- **B1 (LIVE parity)** should close first. Building a dashboard on unverified numbers is
  how wrong figures acquire a confident interface. If you would rather parallelise, I can
  build the shell and charts against fixtures and wire live data once the gate closes.
- **B2 (Supabase)** needed for real login; the in-memory provider covers development.

### Scope
1. **App shell** — Next.js App Router, `styles/tokens.css`, left navigation, top status
   bar, role-aware navigation (backed by the API guard, never instead of it).
2. **Login** — Supabase session, httpOnly cookies, middleware route guard.
3. **Dashboard read path** — `/api/analytics/dashboard` and `/timeseries` implemented over
   `loadWorkbookData` + the KPI engine. **No calculation in any component**; the UI
   renders values the server computed.
4. **KPI cards** — the 14 approved KPIs, each showing its source period and `asOf`
   freshness rather than implying real-time.
5. **Property performance** — HYD-501/502/601/602: occupancy, revenue, expenses, profit,
   ADR, RevPAR.
6. **Operations counters** — check-ins/outs today, cleaning pending, maintenance open,
   low stock, compliance alerts (read from the V1 alert stack).
7. **Charts** — revenue vs expenses vs profit, revenue by property, occupancy, OTA mix.
8. **Read cache** (B6) — short TTL, invalidated on write, so the dashboard is one batch
   read rather than one per widget.
9. **States** — explicit loading, empty and error states; `INSUFFICIENT DATA` wherever a
   figure cannot honestly be shown.

### Explicitly still out of scope
Operational write APIs, guest AI, OpenAI workflows, notifications, the investor and
operations portals (Phases 5–7), and any V1 modification.

### Exit criteria
Dashboard loads real Sheet data through the server layer; every figure traceable to the
KPI engine; zero business calculations in frontend code (asserted by test); RBAC holds on
every new endpoint; LIVE parity gate closed.

---

## Deliverables

| Path | Purpose |
|---|---|
| `supabase/migrations/0001_identity_audit_ids.sql` | roles, RLS, audit log, atomic ID functions — **no business data** |
| `lib/server/auth/roles.ts` | role → capability model |
| `lib/server/auth/session.ts` | Supabase + in-memory auth providers |
| `lib/server/auth/guard.ts` | `withAuth`, injection detector, route-role map |
| `lib/server/audit/{logger,redact}.ts` | audit service + PII redaction |
| `lib/server/ids/allocator.ts` | atomic allocator, Postgres + in-memory + negative control |
| `lib/server/api/{routes,router,investor-service}.ts` | route registry, dispatcher, scoped investor data |
| `styles/tokens.css` | design-token foundation (light + dark) |
| `scripts/live-parity-preflight.mjs` | live-parity environment verification |
| `docs/LIVE_PARITY_RUNBOOK.md` | step-by-step to close the gate |
| `tests/{rbac,investor-isolation,audit,ids,security}.test.ts` | 186 Phase 3 tests |
| `reports/*.json` | rbac-matrix, investor-isolation, audit-coverage, atomic-ids, security |

~10,600 lines total. `npm run gate` runs everything.
