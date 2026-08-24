# Phase 5A — Demo/UAT Environment + Production-Safe Authentication

```
contract:check   OK — no drift (model 459a6a48fad6ea5f)
typecheck        CLEAN (strict, noUncheckedIndexedAccess)
lint             ✔ no ESLint warnings or errors
tests            504 passed, 2 skipped, 0 failed — 17 suites (was 398)
build            ✓ 27 routes
V1 integrity     PASS — 0 errors, 0 warnings; 1,837 formulas; 70 named ranges
OFFLINE parity   PASS 212/212
LIVE parity      PENDING — not run
OVERALL          PENDING
APP_ENV=demo · LIVE_DATA_ENABLED=false
```

# LIVE PARITY PENDING

This system is **not** production ready. The TypeScript engine has still never been
compared against Google's formula engine.

---

## The defect this phase found

**Every page under `/admin` was unguarded.** An operations login could type
`/admin/finance/pnl` and read the profit and loss statement in full. An investor login
could read everything.

The RBAC suite had 130 passing cases — all of them against the **API route table**. The
Next.js *pages* had no authorisation at all. Navigation hid the links, and that was the only
thing standing between an operations manager and the financial statements.

It survived four phases because Phase 4 rendered everything as one fixed administrator.
With no second role in existence, there was nothing a page could have refused, so nothing
looked wrong. The moment real roles arrived, "hidden in the menu" became the whole control.

**Fixed.** Every page now declares the capability it requires and is refused without it,
checked on the server before any data is read. Verified over HTTP with real sessions:

| | `/admin/dashboard` | `/admin/finance/pnl` | `/admin/investors` | `/admin/demo` | `/admin/operations/today` | `/admin/portfolio` |
|---|---|---|---|---|---|---|
| **ADMIN** | OK | OK | OK | OK | OK | denied |
| **OPERATIONS** | denied | denied | denied | denied | OK | denied |
| **INVESTOR** | denied | denied | denied | denied | denied | OK |

`tests/page-access.test.ts` now fails if any admin page ships without declaring a
capability, so the gap cannot reopen quietly. That completeness check matters more than the
matrix: the matrix tests what exists, the completeness check tests what gets added next.

---

## 1 · Demo environment architecture

Isolation is **structural**, not disciplinary. Credentials are namespaced by environment:

```
APP_ENV=demo         reads DEMO_GOOGLE_SHEET_ID, DEMO_SUPABASE_URL, …
APP_ENV=production   reads PRODUCTION_GOOGLE_SHEET_ID, PRODUCTION_SUPABASE_URL, …
```

A demo deployment cannot reach the production workbook because **no code path looks at a
`PRODUCTION_` variable** — not because a check catches it. Three rules follow:

- **No fallback.** A missing resource is a failure naming the variable, never a quiet
  substitution.
- **No shared resources.** If `DEMO_GOOGLE_SHEET_ID` equals `PRODUCTION_GOOGLE_SHEET_ID`,
  resolution throws. Same for Supabase. That misconfiguration would otherwise look like
  everything working.
- **Unset means demo.** Coming up as demo is an inconvenience; coming up as production by
  accident is a data incident.

Production is deliberately asymmetric: **it has no fixture mode.** `APP_ENV=production`
with `LIVE_DATA_ENABLED=false` refuses to start a request rather than serving demonstration
figures under a live label.

The three workbooks stay separate: demo, production, and the LIVE parity copy (which only
the parity harness reads, through the unprefixed variables).

## 2 · Demo dataset design

**Nothing on a dashboard is authored.** The dataset is raw transactional records only —
bookings, revenue lines, expense lines, cash movements, tickets, stock counts. Every KPI,
chart and total is computed by the same `kpi.ts` that will serve production. A test asserts
the property sums equal the portfolio total *exactly*.

Twelve months from April 2026, deliberately uneven:

| | | |
|---|---|---|
| Apr 2026 | ramp-up, 20% occupancy | **a loss** — new operations do lose money |
| May–Jul | 57–65% | the baseline |
| **Aug 2026** | **dormant, no data** | the empty state, reachable from real records |
| Sep 2026 | thin re-opening, 22% | **a loss**; too little to forecast from |
| Oct–Dec | festive peak, to 91% | the system under load |
| Jan 2027 | profit squeezed | carries the ₹96,500 repair |
| Feb 2027 | **current month**, to the 19th | month-to-date behaviour |
| **Mar 2027** | **not yet traded** | future months are empty, not zero |

All twelve required conditions exist as records and are asserted individually: normal and
high occupancy, a cancellation, a payout **₹2,600 short**, an open critical ticket, low
stock, an arrival today, a departure today, an expense spike, a revenue increase,
distributions paid, and a month too thin to forecast.

Record types: reservations, revenue, expenses, CAPEX, rent, cash flow, housekeeping,
maintenance, inventory, assets, compliance, investors, distributions, analytics.

**On marking records.** Rent, asset and compliance records carry `[DEMO] Fictional
demonstration record.` in their Notes field — V1 provides one, so the marker sits where a
person would look. Financial records do **not** carry a flag, deliberately: V1's column
contract has no such column, and adding one would make demo rows structurally different
from production rows — which would defeat the point of demonstrating on the same shapes.
They are marked at the dataset level (`marker: 'SRIVILLU-DEMO'`), on every payload
(`meta.demo`), and in the interface (DEMO / UAT).

**Two design decisions worth flagging:**

*Illustrative commercial rules are applied in demo.* Investor pool 60%, operator 40%,
reserve 5%. Without them the investor journey shows CONFIGURATION REQUIRED and cannot be
demonstrated at all. They are labelled as demonstration values on the portfolio screen, and
a test asserts they can never reach a production code path. **Management has approved
nothing; production settings remain NULL.**

*Every scenario presents the same day.* An earlier version gave each its own day, which
emptied the trading year behind it — moving "today" to November made December onwards
future months. Scenarios now differ by the records seeded **around** a shared day.

## 3 · Demo user accounts

| Account | Role | Figures |
|---|---|---|
| `admin.demo@srivillu.demo` | ADMIN | full internal read, including audit |
| `operations.demo@srivillu.demo` | OPERATIONS | no financial, no investor |
| `investor.demo.a@srivillu.demo` | INVESTOR · INV-001 | ₹12,00,000 · 40% · ₹34,422 |
| `investor.demo.b@srivillu.demo` | INVESTOR · INV-002 | ₹10,50,000 · 35% · ₹30,119 |

**No password exists anywhere in this codebase.** A test asserts it. Passwords are set
through Supabase's invitation flow, by the person, once the project is provisioned.

A and B differ in investment, participation *and* distribution on purpose: isolation is
only convincing if a client can see two different sets of figures.

## 4 · Authentication setup

| | Authenticator | Behaviour |
|---|---|---|
| PRODUCTION | Supabase, always | Not configured → the request fails. No demo identity, no anonymous fallback, no default administrator |
| DEMO + Supabase | Supabase | Real sign-in, real passwords |
| DEMO, no Supabase | Identity chooser | Four fictional accounts, no password |

Role and investor id always come from the **account record**, keyed by the verified user
id — never from the token, a header, a cookie or a query string.

> **The demo chooser is not authentication, and is not presented as such.** Anyone who can
> set a cookie on the demo host can become any of the four demo identities. That is
> acceptable because everything behind them is fictional. It is also why
> `DemoAuthProvider`'s **constructor** throws in production: there is no production code
> path to it, and a test proves it.

ADMIN gained `audit.read` this phase — the brief lists audit under ADMIN and asks for full
internal read access. That widens ADMIN; it weakens nothing. OPERATIONS and INVESTOR still
cannot read the audit trail, and `users.manage` remains SUPER_ADMIN alone.

## 5 · Isolation test results

**All nine invariants tested. 30 cases in `tests/environment.test.ts`, all passing.**

| # | Invariant | How it holds |
|---|---|---|
| 1 | Demo cannot read the production sheet | Demo resolves `DEMO_*` only; with production credentials the *only* ones present, demo finds nothing and throws |
| 2 | Demo cannot write it | No write path exists at all; reset touches no spreadsheet (asserted after comment-stripping) |
| 3 | Demo cannot reach production Supabase | Same namespacing; shared-project configuration is refused outright |
| 4 | Production cannot use demo data | `fixturesPermitted` is a constant `false`; `LIVE_DATA_ENABLED=false` refuses to start |
| 5 | Demo AI cannot receive production data | Payloads stamped at construction from the resolved environment; mismatch throws |
| 6 | Production AI cannot receive demo data | Same guard, both directions |
| 7 | Switching `APP_ENV` is deliberate and visible | Same variables resolve to different workbooks; the header states environment and source |
| 8 | No browser value selects the environment | `NEXT_PUBLIC_*` ignored; the resolver reads `APP_ENV` and nothing else — asserted by source scan |
| 9 | Selection is server-side only | Server-only module; no client component reads `APP_ENV` or resolves anything |

**On 5 and 6:** no AI is integrated, no model is called, and no API key is read anywhere —
a test scans for that. The guard was built before the feature on purpose: the question
"can demo data reach a production model" is far easier to answer correctly now, while the
answer is still free.

**Investor A vs B, verified over HTTP with real sessions:**

| Attack | Result |
|---|---|
| `?investorId=INV-002` | Ignored — A still sees Anand's figures |
| `?investor=INV-002&investorId=INV-002` | Ignored |
| `X-Investor-Id: INV-002` header | Ignored |
| `/admin/investors` direct | Refused |
| Nested body input | No write route exists to accept one |

A's page contains "Anand" and not "Meera". B's contains "Meera" and not "Anand". The page
never accepts an investor id — a test asserts it references no `searchParams`, `params` or
`headers()` at all.

Phase 3's 23 investor-isolation cases and all 131 RBAC cases remain green.

## 6 · Reset and scenario mechanism

The dataset is generated deterministically from seed, so **reset is a genuine return to a
known state** rather than a best-effort cleanup: discard the working copy, rebuild.

Reset restores seeded records, returns the scenario to Normal day, restores investor
figures, and discards everything a demonstration created. Verified end to end over HTTP:
1 guest request → run journey → 2 → run again → still 2 (idempotent) → reset → 1.

Both operations are guarded **environment first, capability second**. The order matters: in
production the environment check throws before the request even reaches the question of who
is asking, so there is no privileged account that could reach a destructive demo operation
against real data.

The confirmation says *"This resets fictional demonstration data only."*

Demo state lives in the server process — a restart resets it. That is a deliberate limit:
demonstration scaffolding has no business being persisted near identity or audit records.

## 7 · Production safety guarantees

1. Production reads `PRODUCTION_*` only. No code path reads the other environment.
2. Production has **no fixture mode**, under any configuration.
3. Production has **no demo identity path** — the provider's constructor throws.
4. Production has **no reset and no scenario switch** — the routes 404 and the operations
   throw.
5. Production **never displays DEMO / UAT** — it has no banner text to display.
6. Two environments sharing a workbook or a project is refused at startup.
7. `CFG_REPORT_MONTH` is still never written. Still no write path of any kind: zero non-GET
   routes.
8. No credential in any client-reachable module; the import-graph walker proves no server
   module is reachable from a `'use client'` entry point.
9. V1 is untouched: 0 errors, 0 warnings, 1,837 formulas, 70 named ranges.

## 8 · Remaining LIVE parity blocker

# LIVE PARITY PENDING

```
OFFLINE  PASS 212/212
LIVE     PENDING — never run
OVERALL  PENDING
```

Unchanged, and nothing in this phase could change it: it needs your Google account. The
ten-section runbook is ready — `docs/LIVE_PARITY_RUNBOOK.md`, about 20 minutes.

Until it passes, the TypeScript engine's agreement with Google's formula engine is
unverified. **The demo does not reduce this risk — it increases the cost of ignoring it**,
because the client is about to be shown figures produced by that engine.

## 9 · Provisioning the Supabase projects

Two projects. Never one.

**srivillu-demo**

1. supabase.com ▸ New project ▸ `srivillu-demo`, region near Hyderabad.
2. SQL Editor → run `supabase/migrations/0001_identity_audit_ids.sql`.
3. Authentication ▸ Users ▸ Invite, for each of the four `@srivillu.demo` addresses. Each
   person sets their own password from the link. **Do not set passwords yourself.**
4. Copy the four user ids Supabase created.
5. Open `supabase/migrations/0002_demo_identities.sql`, replace the four placeholder UUIDs,
   run it. The file refuses to run against a project holding non-demo accounts.
6. Settings ▸ API → copy the URL, the `anon` key and the `service_role` key.
7. Put them in `.env.local` as `DEMO_SUPABASE_URL`, `DEMO_SUPABASE_ANON_KEY`,
   `DEMO_SUPABASE_SERVICE_ROLE_KEY`, plus `DEMO_SUPABASE_AUTH_COOKIE=sb-<ref>-auth-token`.

**srivillu-production**

1. New project ▸ `srivillu-production`.
2. Run `0001_identity_audit_ids.sql`. **Never run `0002`.**
3. Invite the real people. Give each the correct role, and map every investor account to
   its investor id in `app_users`.
4. Settings ▸ API → set the `PRODUCTION_SUPABASE_*` variables.

The `service_role` key is server-side only. The security suite fails the build if it can
reach a browser.

## 10 · Configuring DEMO locally

```bash
cd homestay-web
npm install
npm run dev -- --port 3210
```

Open http://localhost:3210 and pick an account. Nothing else is required — no Google
account, no Supabase, no credentials.

To be explicit, `.env.local`:

```
APP_ENV=demo
LIVE_DATA_ENABLED=false
```

Full detail, including the optional demo workbook, is in `docs/DEMO_RUNBOOK.md`.

## 11 · Demonstrating to the client

The full script is `docs/DEMO_RUNBOOK.md` Part 2 — about 15 minutes. In outline:

0. **Reset first.** Admin ▸ Demo controls ▸ Reset. A known starting state.
1. **Dashboard (3 min)** — fourteen KPIs, all calculated. Ten months in the picker: August
   and March are missing because the business did not trade. The empty state is real.
2. **Scenario switching (3 min)** — High occupancy → the dashboard fills. Operations issue
   → a critical leak takes a unit off-market. The scenario *adds records*; everything
   recomputes.
3. **Operations (2 min)** — a much shorter menu, then type `/admin/finance/pnl`: **"Not
   available for your role."** The refusal is on the server, not in the menu. This is the
   moment worth dwelling on.
4. **Investor (4 min)** — A sees ₹12,00,000 and 40%. Try `?investorId=INV-002`: still A's
   figures. Switch to B: ₹10,50,000 and 35%. Two investors, no route between them.
5. **Guest journey (3 min)** — five steps, fixed responses, no AI. Raise the request, then
   open Operations ▸ Today and watch the counter move. A real record, not a mock-up.

**Two things to say out loud:**

- Every figure is fictional, and the platform is showing it in the DEMO / UAT badge.
- The commercial terms on the investor screen are illustrative. Management has approved
  nothing.

**One thing to be ready for:** the current-month margin looks high because the month is 19
days in — revenue is recognised at checkout while costs accrue across the month. The
workbook behaves identically. Say so before someone asks.

---

## What Phase 5A did not do

No write path of any kind. No OpenAI, WhatsApp or SMS. No autonomous guest messaging. No
second business database — Supabase holds identity, audit, ID sequences and AI logs only.
No production forecasting. No public deployment. No change to V1 formulas or to the V1 data
model. Investor commercial terms remain unapproved and unset in production.

## Remaining blockers

**Yours:**

1. **LIVE parity has not run.** The blocker. ~20 minutes, needs your Google account.
2. **Neither Supabase project exists.** §9.
3. **The logo files are still not in `public/brand/`.** Everything is wired.
4. **The commercial terms are unapproved.** Production shows CONFIGURATION REQUIRED, which
   is correct — confirm that is what investors should see, or settle the terms.
5. **The human UI review has not happened.** `docs/UI_REVIEW.md` — now with three roles and
   a sign-in screen to look at, not just one.

**Mine, once those unblock:**

6. The demo identity chooser needs replacing with Supabase sign-in for any demonstration
   outside a trusted room.
7. No Refresh control in the UI. `provider.refresh()` exists and is tested.
8. ID sequences are not seeded from the workbook, and V1's "Generate missing IDs" still
   uses MAX+1. Both must be handled at cutover, before any write path exists.
9. Housekeeping, Maintenance and Inventory still point at `/admin/operations` — the demo
   covers them through the Today board, but they deserve their own screens.

---

**LIVE PARITY PENDING. Not production ready. Phase 6 not started, and not to be started
without your approval.**
