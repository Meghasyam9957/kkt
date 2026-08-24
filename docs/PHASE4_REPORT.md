# Phase 4 Report — Srivillu Admin Dashboard UI Shell

**Built:** the complete admin shell and all 16 read-only routes, on fixture data, with the
provider seam that lets the live Google Sheets adapter drop in without touching a page.

**Not built (by instruction):** live data, write APIs, OpenAI, forecasting, deployment.
`LIVE_DATA_ENABLED=false`. V1 untouched and re-verified green.

```
contract:check   OK — no drift (model 459a6a48fad6ea5f)
typecheck        CLEAN (strict, noUncheckedIndexedAccess)
lint             ✔ No ESLint warnings or errors
tests            317 passed, 2 skipped (live parity), 0 failed — 10 suites
build            ✓ 19 routes compiled
OVERALL PARITY GATE: PENDING   ← offline PASS, LIVE still not run
```

---

## 1. Files created / modified

**Created — 66 files, ~15,900 lines** (Phase 4 adds ~5,300 to the Phase 1–3 base).

| Area | Files |
|---|---|
| Data providers | `lib/data/providers/{types,fixture-provider,index}.ts` |
| Fixtures | `lib/data/fixtures/workbook.ts` (demo workbook + operational records) |
| App routes | `app/layout.tsx`, `app/page.tsx`, `app/admin/**` — 20 page/layout files |
| Shell | `components/shell/{AppShell,FilterContext,FilterBar,FreshnessIndicator,Logo,DataBoundary}.tsx` |
| UI system | `components/ui/{primitives,KPICard,DataTable}.tsx` |
| Charts | `components/charts/Charts.tsx` (4 charts, hand-built SVG) |
| Dashboard | `components/dashboard/DashboardView.tsx` |
| Pages shared | `components/pages/LedgerPage.tsx`, `lib/shared/page-helpers.tsx` |
| Formatting / nav / session | `lib/shared/{format,navigation,session,brand}.ts` |
| Styles | `styles/{tokens,app}.css` |
| Tests | `tests/ui.test.tsx` (48 tests) |
| Config | `next.config.mjs`, `.eslintrc.json`, `vitest.config.mts`, `tests/setup.ts` |

**Modified:** `lib/server/only.ts` (browser detection refined — see §7), `tsconfig.json`,
`package.json`, `.env.example`, `tests/security.test.ts` (one assertion tightened, §7).

---

## 2. UI routes — all 16 implemented, all verified rendering

Every route was fetched from a running server and checked for real content, not a shell:
**64/64 expected content strings rendered.**

| Route | Renders |
|---|---|
| `/admin` → `/admin/dashboard` | redirect |
| `/admin/dashboard` | 14 KPI cards, TODAY strip, unit board, 4 charts |
| `/admin/properties` | unit register with performance |
| `/admin/reservations` | booking table, minimised guest names |
| `/admin/operations` → `/today` | redirect |
| `/admin/operations/today` | counters, open maintenance, low stock |
| `/admin/finance/revenue` | revenue ledger with totals |
| `/admin/finance/expenses` | expense ledger with totals |
| `/admin/finance/cashflow` | cash ledger, running balance |
| `/admin/finance/pnl` | 10-month P&L, memo lines below the line |
| `/admin/investors` | capital register + CONFIGURATION REQUIRED |
| `/admin/investors/distributions` | waterfall + per-investor allocation |
| `/admin/investors/reports` | statement list (empty state, release in Phase 7) |
| `/admin/analytics` → `/performance` | redirect |
| `/admin/analytics/performance` | 2 charts + monthly KPI table |
| `/admin/settings` | business, rules (live vs recorded-only), channels |
| `/admin/ai` | Copilot shell, inert, "Phase 7" |

Bundle: dashboard **94.7 kB** first load; other pages 89–92 kB; shared chunk 87.3 kB.

---

## 3. Components

**Design system** — `Card`, `CardHeader`, `CardBody`, `StatusPill`, `Badge`, `Button`,
`Skeleton`, `LoadingBlock`, `EmptyState`, `ErrorState`, `ConfigurationRequired`,
`PageHeader`, `Section`, `TableScroller`, `DataTable`, `KPICard`, `KPIGrid`.

**Shell** — `AppShell` (sidebar + topbar + mobile drawer), `FilterProvider`/`FilterBar`,
`FreshnessIndicator`, `DataBoundary`, `SrivilluLogo`/`SrivilluMark`.

**Charts** — hand-built SVG, no chart library. That was a deliberate call: it gives full
control of the restrained visual language, a real accessibility story, and a smaller
bundle. Each chart exposes an **equivalent data table** to assistive technology and pairs
colour with a legend label, so colour is never the only channel.

### Design decisions worth naming

- **Serif for identity and headline numbers only** (Cormorant Garamond), Inter for the
  interface. The restraint is what separates this from a SaaS template.
- **Status colour is never brand colour.** On an operations board a colour must carry one
  meaning; if brand green also meant "available", the two would compete. Brand green stays
  in chrome.
- **Financial figures use Indian digit grouping** (₹2,27,605) and tabular numerals, so
  digits line up down a column and read naturally to the people using them.
- **One hairline border, flat surfaces, no gradients**, generous whitespace.
- **Every attention state is spelled out** — `Needs attention` is announced to screen
  readers alongside the colour.

---

## 4. Data-provider architecture

```
page (server component)
  └─ getDataProvider()                  ← the ONE configuration-driven switch
       ├─ FixtureDashboardDataProvider  ← Phase 4
       └─ GoogleSheetsDashboardDataProvider  ← Phase 5
            │
            └─ both call the SAME lib/server/analytics/kpi.ts engine
```

**The key property:** the fixture provider does not carry numbers. It runs the production
KPI engine over a raw demo *ledger*, so every figure on screen is computed by the code that
will serve live data. Three consequences:

1. No business number is hard-coded in a component, a fixture, or the provider.
2. The demo is internally consistent because it is computed — verified by test:
   **Σ property net revenue = MTD net revenue, exactly.**
3. Swapping providers changes the data source only; no page or component changes.

The demo workbook is deterministic (seeded PRNG, fixed FY 2026-04), so screenshots and
tests are reproducible on any machine on any day. It carries **10 months of trading data
out of 12** — the empty months are real, and exercise the empty states rather than
pretending a full year exists.

**Business rules are deliberately left NULL.** The distribution engine stays idle and the
UI shows `CONFIGURATION REQUIRED`, never ₹0. Operating profit is still reported accurately
— only the *split* is withheld.

**Filters** live in the URL query string (`FilterProvider`), giving shareable links and
working history for free. The workbook is never written: `CFG_REPORT_MONTH` is one shared
mutable cell, so writing it would corrupt other users' reads and change what the operator
sees on the spreadsheet. Asserted by test.

**Live-data safety:** with `LIVE_DATA_ENABLED=true` and no adapter configured,
`getDataProvider()` **throws**. It will never silently serve demo numbers while the UI says
"live" — fabricated figures presented as real are the worst failure this screen can have.

---

## 5. Tests — 317 passing (48 new in Phase 4)

All 14 required checks, plus accessibility:

| # | Required check | Status |
|---|---|---|
| 1 | Dashboard renders | ✅ KPIs, today, board, all 4 charts, best/weakest flags |
| 2 | Fixture values appear correctly | ✅ incl. Σ property = portfolio total |
| 3 | KPI cards render correct periods | ✅ + rising expenses read as worsening, not "up good" |
| 4 | Filters update UI state | ✅ month / property / platform, + unknown-month fallback |
| 5 | Demo-mode indicator | ✅ badge shown on fixtures, absent on live, **throws** if live+unconfigured |
| 6 | Loading states | ✅ skeletons, `role="status"` |
| 7 | Empty states | ✅ meaningful messages, never a blank box |
| 8 | Error states | ✅ actionable + working Retry; null payload treated as error, not empty |
| 9 | Unauthorized roles cannot render restricted routes | ✅ nav filtered **and** route guard asserted |
| 10 | No client component accesses credentials | ✅ source scan; AI page proven inert |
| 11 | Dashboard never writes CFG_REPORT_MONTH | ✅ no code reference, no sheet write anywhere in UI |
| 12 | Financial values sourced from the provider | ✅ no derivation, no commercial constants in components |
| 13 | Property metrics match fixture source records | ✅ row-by-row against the engine |
| 14 | Investor preview isolated | ✅ no client-supplied ID path; guest names minimised; no contact details |
| + | Accessibility | ✅ chart data tables, accessible names, status announced not colour-only |

---

## 6. Local preview

```bash
cd homestay-web
npm install
npm run dev          # http://localhost:3000/admin/dashboard
```

Other useful commands:

```bash
npm run build        # production build — 19 routes
npm run test         # 317 tests
npm run gate         # contract + typecheck + lint + tests + build + parity report
```

**Screenshots:** I could not capture images — the browser pane could not composite frames
in this environment. Instead I verified the running application by fetching every route
from the dev server and asserting its rendered HTML: all 16 routes returned 200, and
**64/64 expected content strings** were present. The design gate below was run the same way.

**Design gate on the live dashboard HTML — 18/18:** DEMO DATA badge, Srivillu wordmark,
data-source statement, all 14 KPIs, CONFIGURATION REQUIRED state, all 4 charts, all 4
properties, best/weakest flags, skip link, chart data tables for assistive tech, Indian
digit grouping, all 8 nav sections, breadcrumb, `aria-current` on the active item, text
summaries under charts, TODAY panel.

*(One check initially flagged `₹0` in the markup. It is a chart Y-axis zero tick, which a
value axis requires; the actual rule — an unset business rule must not render as ₹0 — holds,
and is asserted separately in the UI suite.)*

---

## 7. Known issues

1. **No screenshots.** The browser pane could not render in this environment. Verification
   was done against real served HTML (see §6), which proves content and structure but not
   pixel appearance. **Please open the dev server and look at it** before Phase 5 — the
   design gate deserves human eyes.
2. **Logo asset still missing.** `public/brand/srivillu-logo.png` and `srivillu-mark.svg`
   are not in the repo. The shell uses a typographic lockup plus a neutral SVG placeholder
   built from the approved palette. It does **not** attempt to redraw your badge. Dropping
   the files in requires no code change.
3. **Session is a stub.** `getSessionUser()` returns a fixed demo administrator so the shell
   could be built and tested. It grants nothing — every API route still resolves its own
   `AuthContext` server-side. Replaced by the Supabase session in Phase 5.
4. **Ops counters partly illustrative.** Housekeeping, maintenance, inventory and guest
   requests come from `buildDemoOps()` fixtures, because the demo workbook models sheets
   03–09 only. The Sheets provider will read 13/14/15 for the same shapes. The counters are
   *derived from records*, not hard-coded — but they are demo records.
5. **Sidebar duplicates some destinations.** Housekeeping / Maintenance / Inventory and
   Compliance / Audit currently point at existing pages, because their dedicated screens are
   Phase 5–6 scope. They are reachable and labelled, not broken links.
6. **Two Phase 3 items adjusted, both narrowing rather than loosening:**
   - `lib/server/only.ts` now detects a *real browser* (`window` present **and** no
     `process.versions.node`) instead of merely `window`. A DOM test environment defines
     `window` while running in Node, and a test that verifies rendered figures against the
     engine is a legitimate importer. The `server-only` package remains the build-time
     control.
   - The `.env.example` assertion previously required values be empty or numeric, which
     rejected `LIVE_DATA_ENABLED=false`. It now forbids anything long or opaque enough to
     *be* a credential — the invariant actually worth enforcing.
7. **Toolchain pins.** ESLint 8 + `eslint-config-next@14` (Next 14's lint runner rejects
   ESLint 9); `@vitejs/plugin-react@4` (Vitest 2 bundles Vite 5); happy-dom instead of jsdom
   (jsdom's current dependency chain needs ESM in a CJS context on Node 20.8).
8. **Directory naming.** The brief specified `src/lib/data/providers/`. The project has no
   `src/` directory, so this is at `lib/data/providers/`. Interface, fixture implementation
   and configuration-driven switch are exactly as specified.

---

## 8. LIVE parity status

**PENDING — unchanged, and still the hard gate.**

```
OFFLINE: PASS       212/212 checks
LIVE:    PENDING    not run — no credentials
OVERALL PARITY GATE: PENDING
```

Nothing in Phase 4 could move this: it needs a deployed workbook and a service-account key,
both of which require access to your Google account. `docs/LIVE_PARITY_RUNBOOK.md` has the
steps (~20 minutes) and `npm run parity:preflight` verifies the environment before running.

This matters more now than it did last phase. **The dashboard is currently a beautiful,
consistent view of demo data.** The moment it points at the real workbook, every figure on
screen inherits whatever gap exists between the TypeScript engine and Google's formula
engine — and that gap is exactly what LIVE parity measures.

---

## 9. Next phase recommendation

**Phase 5 — live data, in this order.** My recommendation is to spend the phase making the
existing screens true rather than adding new ones.

1. **Close the LIVE parity gate** (B1). Prerequisite, not a task — everything below is
   built on it.
2. **Provision Supabase** (B2), apply `0001_identity_audit_ids.sql`, replace the session
   stub with real login. The shell, role-aware navigation and guard are already built and
   tested.
3. **`GoogleSheetsDashboardDataProvider`** — implement the same interface over
   `loadWorkbookData`. No page changes; flip `LIVE_DATA_ENABLED=true`.
4. **Read cache** — short TTL, invalidated on write, so a dashboard load stays one batch
   read and comfortably inside the Sheets quota.
5. **Freshness becomes real** — `asOf` from the actual read; the DEMO DATA badge disappears
   on its own because `meta.demo` is derived, not hard-coded.
6. **Operational sheets** — read 13/14/15 so the TODAY counters come from live records.
7. **Then, and only then, write paths** (Phase 6): the atomic ID allocator, idempotency and
   audit are already built and tested; they need the sequence seeded from the workbook at
   cutover, and V1's *Generate missing IDs* menu item retired.

**One thing I'd flag for you rather than decide myself:** the business rules are still TBD,
so the investor screens correctly show CONFIGURATION REQUIRED. Going live with real data
while those remain unset means investors see accurate operating profit and no distribution
figure at all. That is the honest behaviour — but it is worth confirming that is what you
want investors to see, or resolving the commercial terms before the investor portal ships
in Phase 7.
