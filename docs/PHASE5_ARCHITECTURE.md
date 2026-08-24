# Phase 5 — Live Read-Only Platform: Architecture

**Status: mechanisms built and tested offline. Live data is NOT wired.**
`LIVE_DATA_ENABLED=false`. **LIVE PARITY PENDING.**

This document describes what exists now, what it does when the gates close, and what is
deliberately absent.

---

## 1. The request path

```
Browser
  │  no credentials, no Google client, no business calculation
  ▼
Next.js server component  ──►  getShellSession()      Supabase: verify cookie,
  │                                                   read role from app_users
  ▼
getDataProvider()
  │
  ├── LIVE_DATA_ENABLED=false ──► FixtureDashboardDataProvider
  └── LIVE_DATA_ENABLED=true  ──► GoogleSheetsDashboardDataProvider
                                        │
                                        ▼
                                  ReadCache (bounded TTL)
                                        │
                                        ▼
                                  repositories ──► GoogleSheetsApiClient (service account)
                                        │
                                        ▼
                                  WorkbookViews ──► kpi.ts  (the only business engine)
```

Both providers hand the same two structures — `WorkbookData` and `OperationsData` — to the
same `WorkbookViews`, which calls the same `kpi.ts`. **There is one implementation of what
a dashboard is.** A difference between demo and live can only be a difference in rows.

That claim is tested, not asserted: `tests/live-provider.test.ts` runs both providers over
identical data and deep-equals whole view payloads — KPI cards, trend series, ledgers, P&L,
cash flow, investor preview, settings.

The browser never talks to Google. There is no Google client in the client bundle, no
credential in any client-reachable module, and a test walks the import graph from every
`'use client'` entry point to keep it that way.

---

## 2. What changed structurally

Phase 4's fixture provider held both the demo data *and* all view shaping. Adding a second
provider that way would have meant two implementations of every screen.

So the shaping moved out:

| Module | Responsibility |
|---|---|
| `lib/server/analytics/kpi.ts` | every business number. Unchanged. |
| `lib/data/views/workbook-views.ts` | **new** — selection, labelling, presentation state |
| `lib/data/providers/fixture-provider.ts` | supplies demo rows. No shaping. |
| `lib/data/providers/sheets-provider.ts` | **new** — supplies live rows. No shaping. |

Both providers are now thin. That is the point: there is nowhere for them to diverge.

---

## 3. Reading the workbook

One page render costs **at most one source read**, regardless of how many sections it
draws. `source()` loads the whole workbook plus the operational sheets in three batched
round trips, behind the cache; every view slices that one payload. A test asserts that
dashboard → revenue → expenses → P&L performs no additional reads.

**Read only. No write path exists.** `sheets-provider.ts` contains no `append`,
`batchUpdate` or `updateById`, and a test asserts it — including after comments are
stripped, so a commented-out call cannot pass for one.

### The reporting month is never written

Decision D1 stands. `99_CALC`'s KPI, per-property, per-platform and per-category blocks all
key off `CFG_REPORT_MONTH` — a single shared mutable cell. Reading them for one user would
change what every other user sees.

So the live provider never touches them. It does not even import `AnalyticsRepository`
(asserted by test). The reporting period is a **function parameter** into the KPI engine
and **URL/session state** in the browser. Two operators can view different months
simultaneously and neither affects the workbook.

`assertWritable()` refuses the cell, the dashboard sheet, and every calculated sheet, in
both the real and in-memory clients.

### Operational sheets

`13_HOUSEKEEPING`, `14_MAINTENANCE`, `15_INVENTORY` are read for the TODAY panel and unit
status board. `CurrentStock` and `ReorderStatus` are workbook formulas — read as computed,
never recomputed, so the two can never disagree.

**Guest requests have no V1 sheet.** Reporting `0` would claim nobody has asked for
anything today. Instead the counter is declared unavailable and the UI renders "—  Not
tracked". Same principle as CONFIGURATION REQUIRED: absent is not zero.

---

## 4. Freshness

`DataMeta` carries `asOf`, `lastSuccessfulSyncAt`, `ageSeconds`, `cache` and `error`.
Three states:

| State | Meaning | Header says |
|---|---|---|
| `GOOD` | within TTL, source confirmed reachable | **Live · 2 minutes ago** |
| `STALE` | past TTL, **or** the last fetch attempt failed | **Stale · last synced 12 minutes ago** |
| `ERROR` | past TTL *and* failing | **Source unavailable** + last good time |

The rule that shapes this: **"Live" is reserved for a successful, recent fetch.** A failed
fetch flips the header out of "Live" immediately, even while the cached figures are still
inside their TTL — the numbers may be recent, but the source is no longer confirmed, and an
operator deserves to know that before acting on them.

The failure flag is cleared **only by a read that actually happens**. A cache hit is not
evidence the source recovered, so it does not clear it. (That was a real bug, caught by the
test that asserts recovery only after a successful refresh.)

Staleness is evaluated twice — server-side at fetch time, and client-side on a 30-second
timer — so a tab left open overnight cannot keep claiming to be current.

Error messages are classified before display: *not shared with the service account*,
*spreadsheet not found*, *rate limit reached*, or a generic *could not be read*. The
spreadsheet id, the service-account address and the raw exception never reach the screen.

---

## 5. Read cache

`lib/server/cache/read-cache.ts`. Five rules, one test block each
(`tests/cache.test.ts`, 22 cases).

**1 · Bounded TTL.** `SHEETS_CACHE_TTL_SECONDS`, default 90 s, **clamped to 5–600 s**. A
misconfigured value cannot produce a cache that never expires. Bounded in size too: 200
entries, LRU eviction.

**2 · An explicit refresh is always a real read.** `refresh: true` bypasses the entry
entirely. It also refuses to join a request already in flight — otherwise "Refresh" could
be answered by a fetch that began before the user asked for anything.

**3 · The key contains the filters.** `resource | identity | sorted filters`. Different
months, properties and platforms are different entries. Key building is order-independent,
so equivalent filters share one entry rather than silently duplicating.

**4 · A failure never overwrites good data.** On a failed load the previous value survives
and is returned marked stale with the error attached. With nothing cached, it throws — an
outage is an outage, and inventing something to show would be worse.

**5 · Identity is part of every key.** Investor-scoped resources
(`investor.overview`, `investor.statements`, `investor.distributions`,
`investor.allocations`) **throw** if cached without an investor id. Serving investor A's
figures to investor B out of a shared entry is the failure this makes structurally
impossible. `invalidateIdentity()` evicts one investor without touching another.

### Invalidation behaviour

| Trigger | Effect |
|---|---|
| TTL expiry | entry becomes stale; next read refetches |
| explicit `refresh()` | real read, replaces the entry |
| `invalidate(prefix)` | drops every entry under a resource |
| `invalidateIdentity(id)` | drops everything cached for one investor |
| LRU pressure | least-recently-used entry evicted |
| failed fetch | **nothing is dropped** — rule 4 |

There is no write path in this phase, so nothing else can make an entry wrong. **When
writes arrive in Phase 6, every mutation must call `invalidate()` for the resources it
touches** — otherwise an operator will save a booking and not see it. That is the single
most important thing to remember about this cache.

Single-flight is built in: concurrent readers of the same key share one round trip. Google
allows ~60 reads/minute/user; without this, four operators on the dashboard would exhaust
it.

---

## 6. Authentication

`lib/server/auth/shell-session.ts`. Roles unchanged: `SUPER_ADMIN`, `ADMIN`,
`OPERATIONS`, `INVESTOR`.

| State | Condition | Behaviour |
|---|---|---|
| CONFIGURED | Supabase env present | verify cookie with Supabase → read role from `app_users` |
| DEMO | Supabase absent **and** live data off | fixed demo administrator, marked `demo: true` |
| REFUSED | Supabase absent **and** live data on | **throws** |

The third row is the one that matters. Real business data served to an unauthenticated
"Demo Administrator" must not be reachable by configuration mistake, so it fails closed
with the fix named in the message.

Role and investor id come from the **account record**, keyed by the verified user id —
never from the token, a header, a cookie or a query string. A token claiming
`{"role":"SUPER_ADMIN"}` is simply an unknown token. Unchanged from Phase 3 and still
covered by 130 RBAC cases plus 23 investor-isolation cases.

The `Role` and `Capability` model now lives in `lib/shared/roles.ts` so client navigation
can read the capability table without importing a server module (see the Gate A finding).
`lib/server/auth/roles.ts` re-exports it and keeps its guard. **No grant changed** — the
table moved file, byte for byte.

---

## 7. Brand assets

`lib/server/brand/assets.ts` resolves `public/brand/` on the server and reports what is
actually there, with the intrinsic dimensions **read from the file** — PNG `IHDR`, SVG
`viewBox`. Nothing is assumed, so nothing can be stretched.

Rendering pins height and never sets width. Distortion is structurally impossible rather
than merely avoided. Failure degrades in steps: full lockup → mark + wordmark text →
drawn placeholder + wordmark text. The favicon is declared only when the mark exists, so
an undelivered asset does not become a 404 on every page load.

The app never redraws the logo. A test asserts the placeholder stays a placeholder: bounded
geometry, palette tokens only, and it disappears entirely when real artwork is present.

---

## 8. What Phase 5 deliberately does not do

No write paths of any kind: no booking creation or editing, no expense entry, no
housekeeping or maintenance updates, no inventory changes, no investor changes, no settings
changes. `ALL_ROUTES` contains zero non-GET routes and a test asserts it.

No OpenAI, no WhatsApp, no SMS, no autonomous guest messaging. No second business database
— Supabase holds identity, audit, ID sequences and AI logs only; the workbook remains the
single source of business truth. No production forecasting. No public deployment.

Business rules stay unset. Operating profit is reported accurately; the *split* is
withheld and shown as CONFIGURATION REQUIRED until management approves the terms.

---

## 9. To go live

In order. Each step is a prerequisite for the next.

1. **Close the LIVE parity gate** — `docs/LIVE_PARITY_RUNBOOK.md`, ~20 minutes. Everything
   below rests on it. Until it passes, the TypeScript engine is unverified against Google's
   formula engine.
2. **Provision Supabase** — apply `supabase/migrations/0001_identity_audit_ids.sql`, create
   the accounts, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. **Build the sign-in screen** — the only UI Phase 5 still needs. `getShellSession()`
   already throws `AuthenticationError` for a missing session; that has to become a
   redirect to sign-in rather than an error page.
4. **Seed the ID sequences** from the existing workbook IDs (`seedFromExistingIds`) and
   retire V1's "Generate missing IDs" menu item, which uses MAX+1 and would collide.
5. **Point at the workbook** — set `GOOGLE_SHEET_ID` and
   `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, then `LIVE_DATA_ENABLED=true`. No page or
   component changes. If the connection is not configured, the app refuses to start a
   request rather than serving demo data under a live label.
6. **Add a Refresh control** — `provider.refresh()` exists and is tested; nothing in the UI
   calls it yet.

Steps 1, 2 and 4 need your Google and Supabase accounts. Nothing in this codebase can do
them.
