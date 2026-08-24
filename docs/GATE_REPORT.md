# Gates A–C + Phase 5 Architecture — Report

```
contract:check   OK — no drift (model 459a6a48fad6ea5f)
typecheck        CLEAN (strict, noUncheckedIndexedAccess)
lint             ✔ no ESLint warnings or errors
tests            398 passed, 2 skipped (live parity), 0 failed — 14 suites
build            ✓ 21 routes; dashboard 94.8 kB first load
V1 integrity     PASS — 0 errors, 0 warnings; 1,837 formulas; 70 named ranges
OFFLINE parity   PASS 212/212
LIVE parity      PENDING — not run
OVERALL GATE     PENDING
LIVE_DATA_ENABLED = false
```

# LIVE PARITY PENDING

The system is **not** production ready. It has not been verified against Google's formula
engine.

---

## A. Human UI review status

**Ready for you. Not yet done — it needs a person.**

```bash
cd homestay-web
npm run dev -- --port 3210
```

All eleven URLs are listed with a per-page review checklist in
[`docs/UI_REVIEW.md`](UI_REVIEW.md). All 14 admin routes return HTTP 200.

**One defect was found, and it was serious: the application did not run in a browser at
all.** Every admin page threw `A server-only module was imported into client code` during
hydration and the React tree never mounted.

`AppShell` is a client component and imported `capabilitiesFor` from
`lib/server/auth/roles.ts` to decide which navigation entries to render. Every module under
`lib/server/**` carries a guard that throws in a browser. The guard was working correctly;
the import should not have existed.

It survived Phase 4 because nothing in Phase 4 opened a browser. Server rendering succeeds
— the guard only fires client-side — so `curl` returned complete correct HTML for all 16
routes and the design gate passed 18/18. **Every automated check was green while the app
was unusable.** That is exactly the gap this gate exists to close, and it is the strongest
argument for the human review being a gate rather than a formality.

**Fix:** the role/capability model moved to `lib/shared/roles.ts` — data and pure
functions, nothing secret, and navigation legitimately needs it.
`lib/server/auth/roles.ts` re-exports it and keeps its guard, so no other file changed and
**no grant changed**.

**Regression test:** `tests/security.test.ts` now walks the real import graph from every
`'use client'` entry point — aliased imports, relative imports, and re-export chains — and
fails if any server module is reachable by a value import. Verified by reintroducing the
defect and watching it fail with the path named:

```
components/shell/AppShell.tsx -> lib/server/auth/roles.ts
```

and by a second probe proving it follows multi-hop chains through barrel files.

**No design, layout, copy or colour was changed.** The instruction to leave the UI alone
was followed; this was a concrete defect, not a preference.

Verified in a real browser at 1440×900: dashboard and analytics render fully;
`reservations → finance/pnl → settings` produces zero console errors.

**Screenshots are not attached.** The browser in this environment renders at a scale too
small to judge typography, spacing or colour. It was enough to prove the pages mount; it is
not enough to sign off on how they look.

---

## B. Brand asset status

**Wired. Waiting on the files.**

Drop `srivillu-logo.png` and `srivillu-mark.svg` into `public/brand/` and they appear —
no code change, no restart in development.

| Requirement | How it is met |
|---|---|
| Full logo for large contexts | sidebar header, sign-in, print; `srivillu-logo.svg` preferred, PNG fallback |
| Mark for compact contexts | collapsed sidebar, mobile bar, favicon, avatar — a separate file because the badge is illegible below ~48 px |
| Correct aspect ratio | read **from the file** — PNG `IHDR`, SVG `viewBox`. Nothing hard-coded |
| No distortion | height is pinned, width is **never set**. Structurally impossible, not merely avoided |
| Graceful fallback | two layers: server detects absence (no flash), `onError` catches browser failure |

The fallback degrades in steps: full lockup → mark + wordmark text → placeholder mark +
wordmark text. The brand stays legible at every stage.

**The logo is never redrawn in code.** A test asserts the placeholder stays a placeholder —
bounded geometry, palette tokens only — and that it disappears entirely when real artwork is
present, rather than being layered underneath.

An unmeasurable file is treated as absent: rendering artwork of unknown proportions is how
logos get squashed. The favicon is declared only when the mark exists, so an undelivered
asset does not 404 on every page load.

22 tests in `tests/brand.test.tsx`. They measure whatever is actually on disk — so
delivering the artwork strengthens the suite rather than bypassing it.

---

## C. LIVE parity result

# LIVE PARITY PENDING

```
OFFLINE  PASS   212/212     L1 contract 62 · L2 cross-impl 61 · L3 absolute 89
LIVE     PENDING — not run  (needs a deployed workbook + service account)
OVERALL  PENDING
```

Nothing in this phase could move it. It needs your Google account.

**The runbook is complete** — [`docs/LIVE_PARITY_RUNBOOK.md`](LIVE_PARITY_RUNBOOK.md),
all ten sections you specified: create the copy · share with the service account ·
environment variables · verify the 22 sheets · verify the 60 named ranges · seed test data
· sample business rules (copy only, exact cells) · exact command · expected output · tear
down. About 20 minutes.

The preflight script gained a guard this phase: it **warns loudly if the spreadsheet title
does not look like a copy**, because pointing at production is the easy mistake to make.
Advisory rather than fatal — parity is read-only, so the call is yours.

Two things the runbook is blunt about:

- **An unseeded workbook makes the gate meaningless.** Every month reads zero, every
  comparison is `0` against `0`, and it passes having verified nothing. The preflight fails
  on this rather than letting it through, and the suite additionally requires eleven named
  business scenarios to be present in the copy.
- **With the business rules TBD, the whole distribution chain compares 0 with 0.** §7 gives
  two ways to exercise it in the copy only, and the report lists those metrics under
  "Not compared" so the tally is never mistaken for coverage.

**The production workbook is never touched.** It is never shared with the service account,
the suite is read-only, and `CFG_REPORT_MONTH` is never written by anything.

---

## D. Supabase status

**Not provisioned. Seam built and tested; wiring is yours.**

`lib/server/auth/shell-session.ts` — three states, and the third is the important one:

| State | Condition | Behaviour |
|---|---|---|
| CONFIGURED | Supabase env present | verify cookie with Supabase → read role from `app_users` |
| DEMO | Supabase absent **and** live data off | demo administrator, marked `demo: true` |
| REFUSED | Supabase absent **and** live data **on** | **throws** |

Real business data served to an unauthenticated "Demo Administrator" must not be reachable
by configuration mistake. It fails closed, with the fix named in the message.

Role and investor id come from the account record keyed by the verified user id — never
from the token. Roles unchanged: `SUPER_ADMIN`, `ADMIN`, `OPERATIONS`, `INVESTOR`.

12 tests in `tests/session.test.ts`. `supabase/migrations/0001_identity_audit_ids.sql` is
ready to apply.

Still needed from you: create the project, apply the migration, create accounts, set
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Still needed from me, once that exists: the
sign-in screen (§I).

---

## E. Live provider status

**Built, tested, inert.** `LIVE_DATA_ENABLED=false`, so it is never constructed.

`GoogleSheetsDashboardDataProvider` implements the existing `DashboardDataProvider`
interface. **No page or component changed to accommodate it.**

The structural change that makes that true: Phase 4's fixture provider held both the demo
data *and* all view shaping, so adding a second provider that way would have meant two
implementations of every screen. The shaping moved out into
`lib/data/views/workbook-views.ts`. Both providers are now thin suppliers of rows, handing
the same structures to the same shaping layer over the same `kpi.ts`.

**There is one implementation of what a dashboard is.** A difference between demo and live
can only be a difference in rows — and that is tested, not asserted: both providers run over
identical data and whole view payloads are deep-equalled. KPI cards, trend series, ledgers,
P&L, cash flow, investor preview, settings.

- One page render = **at most one source read**, regardless of section count (asserted).
- **No write path exists.** No `append`, `batchUpdate` or `updateById` — asserted after
  comment stripping, so a commented-out call cannot pass for one.
- **Never silently falls back to fixtures.** Live enabled without a connection throws with
  the missing variable names. Source unreachable with nothing cached throws a distinct
  `LiveDataUnavailableError`.
- Error messages are classified before display — *not shared*, *not found*, *rate limit*,
  or generic. The spreadsheet id and service-account address never reach the screen.

Operational sheets 13/14/15 feed the TODAY panel and unit board. **Guest requests have no
V1 sheet**, so rather than report `0` — which would claim nobody asked for anything — the
counter renders "—  Not tracked". Absent is not zero, same principle as CONFIGURATION
REQUIRED.

22 tests in `tests/live-provider.test.ts`, running against an in-memory backend seeded
through the real contract layout, so repositories, column indexes and named-range reads are
genuinely exercised. What is **not** exercised is Google's formula engine — that is Gate C,
and this suite makes no claim about it.

### Reporting month

Unchanged and enforced three ways: the live provider does not import
`AnalyticsRepository` (asserted), `assertWritable()` refuses the cell and the whole
dashboard sheet, and the period is a function parameter into the engine plus URL state in
the browser. Two operators can view different months simultaneously.

---

## F. Freshness and cache design

### Freshness

| State | Meaning | Header |
|---|---|---|
| `GOOD` | within TTL, source confirmed reachable | **Live · 2 minutes ago** |
| `STALE` | past TTL, **or** the last fetch failed | **Stale · last synced 12 minutes ago** |
| `ERROR` | past TTL **and** failing | **Source unavailable** + last good time |

**"Live" is reserved for a successful, recent fetch.** A failed fetch flips the header out
of "Live" immediately, even while cached figures are still inside their TTL — the numbers
may be recent, but the source is no longer confirmed, and an operator deserves to know that
before acting on them.

The failure flag clears **only on a read that actually happens**. A cache hit is not
evidence the source recovered. (That was a real bug — the first implementation cleared it
on any non-erroring call, so the header quietly returned to "Live" while the workbook was
still down. The test that asserts recovery-only-after-refresh caught it.)

Staleness is evaluated twice — server-side at fetch, client-side on a 30-second timer — so
a tab left open overnight cannot keep claiming to be current.

**Demo mode renders byte-identically to Phase 4.** The new states exist only on the live
path, so the screens you are reviewing in Gate A are unchanged.

### Cache — five rules, one test block each (22 cases)

**1 · Bounded TTL.** Default 90 s, **clamped to 5–600 s**. A misconfigured value cannot
produce a cache that never expires. Bounded in size too: 200 entries, LRU.

**2 · Refresh is always a real read.** Bypasses the entry, and refuses to join a request
already in flight — otherwise "Refresh" could be answered by a fetch that began before the
user asked for anything.

**3 · The key contains the filters.** `resource | identity | sorted filters`.
Order-independent, so equivalent filters share one entry.

**4 · A failure never overwrites good data.** The previous value survives and is served
marked stale with the error attached. With nothing cached it throws — an outage is an
outage.

**5 · Identity is in every key.** Investor-scoped resources **throw** if cached without an
investor id. Serving investor A's figures to investor B from a shared entry is structurally
impossible.

### Invalidation

| Trigger | Effect |
|---|---|
| TTL expiry | stale; next read refetches |
| explicit `refresh()` | real read, replaces entry |
| `invalidate(prefix)` | drops every entry under a resource |
| `invalidateIdentity(id)` | drops one investor's entries only |
| LRU pressure | least-recently-used evicted |
| failed fetch | **nothing dropped** (rule 4) |

There is no write path this phase, so nothing else can make an entry wrong. **When writes
arrive in Phase 6, every mutation must call `invalidate()` for what it touches** — otherwise
an operator saves a booking and does not see it. That is the one thing to remember about
this cache.

Single-flight is built in: concurrent readers of a key share one round trip. Google allows
~60 reads/minute/user; without it, four operators on the dashboard would exhaust that.

---

## G. RBAC regression results

**All green. No isolation rule weakened, no grant changed.**

| Suite | Tests | Result |
|---|---|---|
| RBAC matrix | 130 | pass |
| Investor isolation | 23 | pass |
| Audit logging | 18 | pass |
| Security (incl. 2 new boundary tests) | 23 | pass |
| Atomic IDs | 17 | pass |

The capability table moved file — `lib/server/auth/roles.ts` → `lib/shared/roles.ts`,
re-exported — **byte for byte, no grant edited**. All 130 RBAC cases import through the
unchanged server path and pass.

Investor routes remain INVESTOR-only. Investor identity is never accepted from the
frontend. `OPERATIONS` still holds no financial capability; `INVESTOR` holds no PII or
financial capability. Zero non-GET routes exist.

Two security tests added:
- the import-graph walker described in §A;
- an assertion that the client-needed role model lives outside `lib/server` and the server
  entry point still carries its guard.

---

## H. Remaining blockers

**Yours — nothing in this codebase can do them:**

1. **LIVE parity has not run.** Needs a deployed workbook, a copy, and a service account.
   Runbook ready, ~20 min. **This is the blocker; everything else waits behind it.**
2. **Supabase is not provisioned.** Project, migration, accounts, two env vars.
3. **The logo files are not in the repository.** Everything is wired; drop them in.
4. **Business rules are unapproved.** Investor screens correctly show CONFIGURATION
   REQUIRED. Going live in this state means investors see accurate operating profit and no
   distribution figure at all — honest, but confirm that is what you want them to see.
5. **The human UI review has not happened.** Gate A is prepared, not closed.

**Mine, once the above unblock:**

6. **No sign-in screen.** `getShellSession()` throws `AuthenticationError` for a missing
   session; that needs to become a redirect to sign-in rather than an error page. It is the
   only UI Phase 5 still needs, and it was not built because it cannot be tested without
   Supabase and would have added unreviewed UI during a UI freeze.
7. **No Refresh control.** `provider.refresh()` exists and is tested; nothing calls it.
8. **ID sequences are not seeded** from the existing workbook IDs, and V1's "Generate
   missing IDs" menu item still uses MAX+1. Both must be handled at cutover — before any
   write path exists, so there is time.
9. **No screenshots** (§A) — an environment limitation, not a code one.

---

## I. Phase 6 proposal

**Do not start Phase 6 until Gates A–C are closed.** In particular, building write paths on
an unverified calculation engine would mean writing data derived from numbers nobody has
checked against Google.

### First — finish Phase 5 (small, all unblocked by the gates)

Sign-in screen and redirect · seed ID sequences and retire V1's MAX+1 menu item · a Refresh
control wired to `provider.refresh()` · flip `LIVE_DATA_ENABLED=true` and confirm the live
screens against the workbook by eye.

### Then — Phase 6: first write paths

Scope, smallest useful slice first:

1. **Expense entry** — the safest first write. Append-only, one sheet, no cross-sheet
   consequences, and the least damaging thing to get wrong.
2. **Booking creation and editing** — the highest-value write and the one with real
   coupling: reservations drive revenue, occupancy and payout expectations.
3. **Housekeeping and maintenance status updates** — small edits, high daily use.

Every write needs the same five things:

- **Atomic ID allocation** through `IdAllocator` — never MAX+1. Built and tested in
  Phase 3; this is where it finally gets used.
- **Idempotency keys**, so a retried submit does not create a duplicate booking.
- **Cache invalidation** on every mutation. The most likely Phase 6 bug is a write that
  succeeds and a screen that still shows the old figure.
- **Audit entries** with actor, action, before/after — the logger exists and redacts before
  any sink.
- **`buildInputRow` only**, which drops calculated columns by construction. The app must
  remain unable to overwrite a workbook formula.

Two rules to carry in unchanged: **still never write `CFG_REPORT_MONTH`**, and **still
never write a calculated or reporting sheet**. `assertWritable()` already enforces both;
Phase 6 must not add an exception.

### Explicitly not Phase 6

OpenAI or any AI feature · guest messaging (WhatsApp/SMS) · the investor portal going live
· settings editing from the web (business rules stay in the workbook under one audited
path) · production forecasting · public deployment.

### Recommended order of your decisions

1. Run LIVE parity — it gates everything.
2. Provision Supabase.
3. Review the UI (§A) and tell me anything you want changed while changes are still cheap.
4. Drop the logo files.
5. Resolve the commercial rules, or confirm investors should see CONFIGURATION REQUIRED.

---

**LIVE PARITY PENDING. This system is not production ready.**
