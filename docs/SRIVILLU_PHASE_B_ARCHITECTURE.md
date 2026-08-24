# Srivillu Phase B Architecture — Premium UI + Web Data Entry + Sheets Write-Back

**Status:** DRAFT for approval. No production code has been modified.
**Companions:** `SRIVILLU_DESIGN_SYSTEM.md` (visual rules) · `SRIVILLU_UI_REDESIGN_PLAN.md` (page-by-page UI work). Both remain valid; §14–§15 below record only what changes now that the app writes.
**Non-negotiables honoured throughout:** V1 business logic untouched · no financial calculation duplicated in the frontend · no browser access to Google Sheets · no Google/OpenAI credentials in the browser · Supabase holds no operational business records.

---

## 1. UI audit

Complete in `SRIVILLU_UI_REDESIGN_PLAN.md` §1 (19 ranked findings, verified in a real browser). Still accurate. **New findings relevant to write-back:**

- The app is read-only end to end: no mutation route exists, no form posts to a data API (only `/api/session` and `/api/demo`).
- The tested `ApiRouter` (guard → capability → investor scope → audit) exists as a **library that nothing serves** — there are no Next.js handlers binding it. Pages call `getDataProvider()` directly in server components.
- Three test-pinned boundaries shape where write code may live (details §7):
  - `tests/ui.test.tsx:477` — **no file under `app/`, `components/`, or `lib/data/` may contain `.append(`, `.batchUpdate(` or `.updateById(`**. All mutation logic goes in `lib/server/`; route handlers are thin.
  - `tests/security.test.ts:314` — `SettingsRepository` must expose **no writer**.
  - `tests/ui.test.tsx:463` & `client.ts` — `CFG_REPORT_MONTH` / `'01_DASHBOARD'!C3` is never written (Decision D1).

## 2. Current route map

**Pages** (all server components, `force-dynamic`, guarded by `checkPageAccess`):
`/` → redirect `/admin/dashboard` · `/signin` · `/admin` (role-aware redirect) · `/admin/dashboard` · `/admin/portfolio` (INVESTOR) · `/admin/properties` · `/admin/reservations` · `/admin/operations` (redirect) · `/admin/operations/today` · `/admin/finance/{revenue,expenses,cashflow,pnl}` · `/admin/investors{,/distributions,/reports}` · `/admin/analytics{,/performance}` · `/admin/ai` · `/admin/settings` · `/admin/demo{,/guest-journey}` (demo-only).

**HTTP APIs actually served:** `POST/DELETE /api/session` (auth) · `POST /api/demo` (scenario/reset/presentation/guest-journey; demo-env-gated before role).

**Declared-but-unserved API registry** (`lib/server/api/routes.ts`): 28 GET routes with capability, action, investor scoping — enumerated by the RBAC suite so every route is tested against every role automatically. **No mutating route is declared anywhere.**

## 3. Existing data provider map

`getDataProvider()` (`lib/data/providers/index.ts`) is the single selection point:

- **PRODUCTION** → `GoogleSheetsDashboardDataProvider` over the live client. Fixtures structurally unreachable.
- **DEMO** → demo workbook when configured (`LIVE_DATA_ENABLED=true` + `DEMO_GOOGLE_*`), else `FixtureDashboardDataProvider` over the in-process demo dataset (rebuilt on scenario change/reset).

Provider surface (the only data a page may render): `getDashboard, getProperties, getOperations, getInvestorRegister, getReservations, getRevenue, getExpenses, getCashFlow, getPnl, getMonthlySeries, getInvestorPreview, getSettings, getAvailableMonths, getPlatforms, getPropertyIds, getSourceMeta` — every payload wrapped in `Envelope<T> = {data, meta}` with provenance. A process-wide `ReadCache` (TTL, `invalidate(prefix)`, identity-scoped investor resources) sits over live reads.

## 4. Existing Google Sheets adapter

`lib/server/sheets/client.ts` — the only file touching the Sheets API.

- `GoogleSheetsClient` interface: `batchGet, get, append(sheet, rows), batchUpdate(edits), flush()`; two implementations (`GoogleSheetsApiClient` with service account + retry/backoff; `InMemorySheetsClient` mirroring Google semantics incl. named ranges and trailing-row trimming, with a write log).
- `assertWritable(range)` runs in **both** implementations: refuses `READ_ONLY_SHEETS` (`99_CALC, 10_MONTHLY_PNL, 19_ANALYTICS, 20_QA, 21_SYSTEM_GUIDE, 01_DASHBOARD`) and cell `C3` anywhere.
- `lib/server/sheets/repositories/index.ts` — typed repositories for **all eleven required entities** (Property, Reservation, Revenue, Expense, Capex, Rent, CashFlow, Housekeeping, Maintenance, Inventory, Investor) plus Distribution, Settings (read-only, pinned), Analytics. Base class already has `readAll`, `append(records)` and `updateById(id, patch)`, both routed through `buildInputRow` / an input-column whitelist that **throws on any `role: 'calc'` key**.

So the brief's "GoogleSheetsWriteAdapter + typed repositories" largely **exists**; Phase B2 hardens and serves it rather than inventing it.

## 5. Existing RBAC

- Roles `SUPER_ADMIN / ADMIN / OPERATIONS / INVESTOR`; 27 read-side capabilities; grants in `lib/shared/roles.ts` (OPERATIONS: zero financial; INVESTOR: `investor.self.read` only; `settings.write` exists but is SUPER_ADMIN-only and unused).
- Enforcement layers: nav filter (convenience) → `checkPageAccess` (pages) → `createGuard` (API: authn → capability → investor-scope with injection scanning of query/params/headers/body/path → audit every ALLOW/DENY/ERROR).
- Supabase `app_users` with DB-level constraints (INVESTOR must have `investor_id`, non-investor must not; unique investor mapping; RLS self-read only; provisioning service-role only).

## 6. Existing V1 generated contract

`lib/contract/contract.generated.ts`, hash `459a6a48fad6ea5f`, drift-checked in the gate. 22 sheets · 261 columns (`role: "in" | "calc"` per column, A1, type, list, range) · `ID_RULES` (prefix/pad per sheet, `{y}` year scoping) · `LISTS` (31 vocabularies — booking status, payment status, maintenance category/priority/status, HK status, cash type, revenue type…) · `READ_ONLY_SHEETS` · `FORBIDDEN_WRITE_CELL` · `dataRange`/`columnIndex`/`inputColumns` helpers. Input columns per writable sheet: RESERVATIONS 31 · EXPENSES 18 · CAPEX 18 · PROPERTIES 17 · CLOSE 18 · HOUSEKEEPING/MAINTENANCE 15 · REVENUE 15 · ASSETS 14 · RENT/CASHFLOW/INVENTORY 13 · COMPLIANCE 12 · INVESTORS 9 · DIST 6.

## 7. Existing write limitations (the honest gap list)

1. **Nothing serves writes.** No mutation routes declared, no handlers bound, no UI actions.
2. **No idempotency for business writes.** `id_allocations` gives idempotent ID minting, but nothing stops a retried request from appending the same row twice.
3. **`values.append` row-targeting is unverified against V1's prepared grid.** V1 table sheets have ~700 prepared rows with formats/validation, and calc columns are ARRAYFORMULA-filled. Where Google's append actually lands (after the last ARRAYFORMULA output? row 704, outside validation?) must be proven on a real workbook. The in-memory client's "first free row" is an assumption, not a fact.
4. **`updateById` has a locate-then-write race**: the row number found by scan can go stale if a human sorts/deletes rows in the open workbook between read and write.
5. **`flush()` is a fixed 400ms sleep + one read** — a hope, not a verification.
6. **Date/number write semantics unverified**: writes use `USER_ENTERED`; whether an ISO date string parses identically under the workbook's `en_IN` locale, or should be written as a RAW serial, is untested.
7. **No write capabilities exist** — every capability is `*.read`; RBAC cannot yet express "may create an expense".
8. **`ReadCache` has `invalidate()` but no writer calls it** — a write today would serve stale reads for up to a TTL.
9. **No `parity` environment** in `AppEnv` (`demo | production` only); parity lives in scripts with `PARITY_*` vars.
10. **Demo writes today mutate the in-process dataset only** (guest-request, scenario) — not exercised through any API pipeline.
11. **Audit sink for writes exists, but no before/after capture** and no operation-ID column convention.

## 8. Proposed write API architecture

One pipeline, one place, serving every mutation identically in demo and production — only the backends differ.

```
Browser (form / action button — no fetch to Google, ever)
  → POST /api/... (Next.js catch-all app/api/[...path]/route.ts — THIN: parse, cookie→token, dispatch)
    → ApiRouter.dispatch (existing guard: authn → capability → investor-scope → audit)
      → MutationPipeline (new, lib/server/api/mutations.ts)
          1  schema validation        zod (already a dependency) — shape, types, vocab from LISTS
          2  contract validation      inputColumns() whitelist; any role:'calc' key → 422 CONTRACT_VIOLATION
          3  business validation      referential checks via repositories (property exists & active, dates, amounts)
          4  idempotency begin        Supabase operations table: INSERT operation_id ON CONFLICT → replay/in-flight
          5  ID allocation            existing IdAllocator, idempotencyKey = operation_id, floor pre-seeded
          6  sheet write              repository.append / updateById (assertWritable + buildInputRow underneath)
          7  read-after-write verify  re-read the written row by ID; compare every input cell we sent
          8  cache invalidation       ReadCache.invalidate per affected resource + dashboard/analytics
          9  operation VERIFIED       (or FAILED with reason — never silent)
         10  audit                    action, entity, entity ID, operation ID, redacted before/after
         11  response                 the verified record, plus meta {operationId, updatedRange, provenance}
```

Placement rules (test-enforced): steps 1–10 live under `lib/server/`; the `app/api` handler contains no `.append(`/`.batchUpdate(`/`.updateById(` and no business logic. UI components submit plain `<form>` POSTs or `fetch` to `/api/*` with the operation ID — they never import server modules (`import type` only, pinned).

Layer-skipping is made structurally hard: the only exported constructor is `createMutation(definition)` which composes all steps; repositories' write methods become inaccessible to route code except through it (mutation services are the only importers).

**Writes disabled by environment flag:** `<ENV>_WRITES_ENABLED`. Demo: `true`. Parity: refused at the environment layer (before role, same pattern as demo controls). Production: `false` until Phase G — the routes exist, the guard runs, and the response is a controlled 403 `WRITES_DISABLED`, so enabling production writes later is a flag flip after sign-off, not a deploy of new code paths.

## 9. Mutation endpoint list

All POST/PATCH; every one carries `operationId` (UUID) in the body; all declared in the same `API_ROUTES` registry so the existing RBAC enumeration tests cover each automatically. New capabilities in brackets; grants: SUPER_ADMIN all; ADMIN all except none-listed; OPERATIONS only those marked ⚙; INVESTOR none.

| Endpoint | Action | Sheet | Capability |
|---|---|---|---|
| POST `/api/reservations` | create booking | 04 | `reservations.write` ⚙ |
| PATCH `/api/reservations/:id` | amend input fields | 04 | `reservations.write` ⚙ |
| POST `/api/reservations/:id/check-in` | status → Checked In (+ times) | 04 | `reservations.write` ⚙ |
| POST `/api/reservations/:id/check-out` | status → Checked Out | 04 | `reservations.write` ⚙ |
| POST `/api/reservations/:id/cancel` | status → Cancelled (+ reason) | 04 | `reservations.write` ⚙ |
| POST `/api/revenue` | record revenue row | 05 | `revenue.write` |
| PATCH `/api/revenue/:id` | amend (e.g. payout status/date) | 05 | `revenue.write` |
| POST `/api/expenses` | record expense | 06 | `expenses.write` |
| PATCH `/api/expenses/:id` | amend | 06 | `expenses.write` |
| POST `/api/capex` | record CAPEX item | 07 | `capex.write` |
| PATCH `/api/capex/:id` | amend | 07 | `capex.write` |
| PATCH `/api/rent/:id` | record rent payment fields | 08 | `rent.write` |
| POST `/api/cashflow` | record cash movement | 09 | `cashflow.write` |
| PATCH `/api/cashflow/:id` | reconcile / amend | 09 | `cashflow.write` |
| POST `/api/housekeeping` | create task | 13 | `housekeeping.write` ⚙ |
| PATCH `/api/housekeeping/:id` | assign / complete / inspect | 13 | `housekeeping.write` ⚙ |
| POST `/api/maintenance` | create ticket | 14 | `maintenance.write` ⚙ |
| PATCH `/api/maintenance/:id` | progress / resolve / close | 14 | `maintenance.write` ⚙ |
| POST `/api/inventory/movements` | stock movement (purchased/used deltas as new input values) | 15 | `inventory.write` ⚙ |
| PATCH `/api/inventory/:id` | amend item inputs | 15 | `inventory.write` ⚙ |
| POST `/api/guest-requests` | raise request | ops | `operations.write` ⚙ |
| PATCH `/api/guest-requests/:id` | progress / close | ops | `operations.write` ⚙ |
| POST `/api/investors` | add investor (management) | 11 | `investors.write` |
| PATCH `/api/investors/:id` | amend input fields | 11 | `investors.write` |
| PATCH `/api/distributions/:period` | record PaidAmount/PaidDate/Status inputs | 12 | `distributions.write` |
| POST `/api/properties` / PATCH `/:id` | property master upkeep | 03 | `properties.write` |

Explicitly **not** in this phase: any DELETE (cancellation is a status change; removal stays a management action in the workbook) · settings writes (`SettingsRepository` writer is test-forbidden; workbook owns business rules) · anything touching 99_CALC, P&L, Analytics, QA, Guide, Dashboard, `CFG_REPORT_MONTH` · investor-initiated writes of any kind.

## 10. Validation schemas

`lib/server/api/schemas/` — zod, one file per entity, three layers deep:

1. **Shape**: types, required fields, `operationId: z.string().uuid()`.
2. **Vocabulary — from the contract, never retyped**: `z.enum(LISTS.BOOKING_STATUS)`, `LISTS.PAYMENT_STATUS` (`Pending/Partial/Paid/Failed`), `LISTS.MAINT_CATEGORY/PRIORITY/STATUS`, `LISTS.HK_STATUS`, `LISTS.CASH_TYPE`, `LISTS.REVENUE_TYPE`, `LISTS.EXPENSE_TYPE`… A vocabulary change in V1 flows through contract regeneration, not a code edit.
3. **Business rules** (checks, not calculations): reservation — property exists & `PropertyStatus` active, `checkOut > checkIn`, `1 ≤ guests ≤ MaxGuests`, platform ∈ configured platforms, status transitions legal (Inquiry→Confirmed→Checked In→Checked Out; Cancelled/No Show from permitted states only); expense — amount > 0, category+subcategory from lists, date sane (not far-future), property or COMMON, ExpenseType Operating/CAPEX with the CAPEX-belongs-in-07 warning surfaced not silently "fixed"; maintenance — property/category/priority/status valid; inventory — item exists, movement quantity > 0, direction ∈ {purchased, used}; cash — type ∈ CASH_TYPE, exactly one of in/out non-zero (mirrors the QA rule as a *check*).

No schema computes a financial figure. Derived money (taxes, totals, fees, distributions) is left blank for the workbook's formulas — that is the whole point of `role: calc`.

## 11. Idempotency design

New migration `0003_operations.sql` — technical state only, wipeable without business loss:

```sql
create table operations (
  operation_id  uuid primary key,          -- client-generated per user intent
  actor_id      uuid,   actor_role text,
  action        text not null,             -- 'expense.create'
  entity_type   text,   entity_id text,    -- filled when known
  request_hash  text not null,             -- sha256 of the canonicalised payload
  status        text not null check (status in ('PENDING','APPLYING','VERIFIED','FAILED')),
  result        jsonb,                     -- the verified response body
  error         text,
  created_at    timestamptz default now(), updated_at timestamptz default now()
);
```

Protocol: the UI mints `operationId` when the form opens (not on click). Pipeline begins with `INSERT … ON CONFLICT (operation_id) DO NOTHING`:

- Insert won → proceed (PENDING → APPLYING → write → verify → VERIFIED + result).
- Conflict, status VERIFIED → **return the stored result, 200, no second row** — same payload or not, same intent ID means same operation; a *different* `request_hash` under the same ID is a 409 `OPERATION_MISMATCH`.
- Conflict, status APPLYING/PENDING → 409 `OPERATION_IN_FLIGHT` with retry-after; the UI polls `GET /api/operations/:id`.
- Conflict, status FAILED → the stored failure is returned; a fresh attempt requires a fresh operation ID (deliberate: silent auto-retry of a failed business write is how double entries happen).

The ID allocator receives `operationId` as its idempotency key, so even a crash between allocation and write cannot mint a second identifier on retry. Covered tests: double-click, retry, timeout-retry, duplicate, parallel-identical (§12).

## 12. Concurrency strategy

- **Distinct concurrent creates** (the 20×booking/expense/maintenance tests): IDs serialise in Postgres (`allocate_ids` row lock — already proven by the existing 17-test atomic-ID suite with its deliberately broken `NaiveSequenceStore` control); each append is a single Sheets API call. Assert: 20 unique IDs, 20 rows, 20 operations, no lost writes, correct authorization per role, exactly the expected audit events.
- **Identical concurrent requests**: the `operations` primary key makes one winner; losers replay/poll. Assert: 1 row, 1 ID, N responses all carrying the same record.
- **Update/update races on one row**: field-level last-write-wins is accepted for input cells *within different fields*; same-field conflicts are mitigated by read-after-write verification (the loser's verify sees the winner's value and reports `VERIFY_CONFLICT` rather than lying). Documented as a known limit — Sheets has no row versioning.
- **Update vs human edit in the open workbook** (row moved/sorted/deleted): every `updateById` write includes the ID cell in its verify read; if the row at the located index no longer carries the expected ID, the operation is FAILED with `ROW_MOVED`, one automatic relocate-and-retry is attempted inside the same operation, then it surfaces. Never a blind write to a row number.
- **Append landing row**: to remove dependence on `values.append`'s table detection against V1's prepared grid, the primary create path is: read the ID column, find the first blank input row inside the prepared range, `batchUpdate` that exact row, verify by ID. `values.append` remains a fallback once the B2 live spike proves its behaviour. Two concurrent creates targeting the same blank row are serialised by a per-sheet in-process mutex plus verify-by-ID (the loser relocates to the next blank row).
- One Node process is assumed (current deployment); the in-process mutex is documented as invalid under multi-instance deployment, where the operations table + verify-by-ID remains the correctness backstop.

## 13. Google Sheets write strategy

- Writes only via repositories → `buildInputRow`/whitelist → `assertWritable`. Calc columns are `null` in every append and rejected by name in every patch (403/422 `CONTRACT_VIOLATION`, never silently dropped — changed from today's throw-only behaviour to a typed error).
- Forbidden surfaces (99_CALC, P&L, Analytics, QA, Guide, Dashboard, C3) stay client-level refusals in both real and in-memory clients so tests prove the rule.
- Value semantics: **B2 opens with a live-workbook spike** (on the demo copy) that writes each input type — date, currency, percent, boolean, list value — via both `USER_ENTERED` and `RAW`, reads back serials, and fixes the write encoding per type in one table in `client.ts`. No production write happens before that table exists. (Read side already uses `UNFORMATTED_VALUE`/`SERIAL_NUMBER`.)
- `flush()` becomes verification-based: poll the written row (and for creates, one dependent calc cell of that row, e.g. Nights) until stable or a 5s budget, then report `verified: true/false` honestly in the response meta.
- Read-after-write is compared cell-by-cell against what was sent (normalised for serial dates); any mismatch → FAILED `VERIFY_MISMATCH` with both values in the (redacted) audit record.
- Every written row carries provenance in its Notes/free-text input column where one exists: `via web · <operationId short>` — visible in the workbook, satisfying "Updated via Web App". "View in Workbook" deep-link (`#gid=…&range=A{row}`) is shown to ADMIN/SUPER_ADMIN only; investors never see workbook URLs.
- Rate/quota: writes share the existing retry/backoff; mutations are never batched across unrelated user intents (one intent = one operation = one verify).

## 14. UI redesign system (delta to the approved plan)

`SRIVILLU_DESIGN_SYSTEM.md` stands. Additions for a writing product:

- **New primitives** (extending the §4 component plan, still one Button/Card system): `DatePicker` (native `<input type="date">` styled, en-IN display), `CurrencyInput` (₹, Indian grouping, integer paise-free per V1), `Textarea`, `Toast` (verified/failed outcomes, `role="status"`), `ConfirmationDialog` (destructive status changes: cancel booking, close ticket), `ActivityLog` (per-entity audit slice), form field row with explicit **INPUT / CALCULATED / READ-ONLY** marking — calculated fields render as ledger values with a lock glyph and "Calculated by the workbook" note, never as disabled inputs.
- **Write affordances per surface**: Admin ledgers gain a primary "+ New …" masthead action and row drawers with Edit; Operations Today gains the action set (Check In, Check Out, Mark Clean, Mark Ready, Resolve Issue, + New buttons); Investor surface gains nothing (read-only, no buttons — test-pinned); Guest portal request form arrives in Phase I.
- **Optimistic UI is forbidden**: a mutation shows APPLYING state until the server returns VERIFIED; the toast then states what was written and where ("EXP-2026-0187 recorded · row 214"). Failure states show the operation error verbatim with the operation ID for support.
- **Correction of the Phase A skills statement**: a `design` plugin is now available in this session (design-system, design-critique, accessibility-review, design-handoff, ux-copy) plus a `dataviz` skill. Phase B1 will use `design:accessibility-review` and `design:design-critique` as review gates on the new shell and forms; still no scroll/GSAP skill exists and none will be claimed.

## 15. Public website storyboard

Unchanged — `SRIVILLU_UI_REDESIGN_PLAN.md` §6 (eleven beats, CSS scroll-timeline + IO fallback, no GSAP/Lenis by default, "Enquire for rates", placeholders labelled until photography arrives). The public site performs **no reads or writes** against the business API; `/enquire` remains contact options only. Route `/login` (brief §17) is added as an alias page linking to `/signin`.

## 16. Demo environment architecture

Three environments, server-resolved only (`APP_ENV`), never switchable from a client:

| | DEMO | PARITY | PRODUCTION |
|---|---|---|---|
| Workbook | `DEMO_GOOGLE_SHEET_ID` (fictional copy) or in-process dataset | `PARITY_SHEET_ID` (technical copy) | `PRODUCTION_GOOGLE_SHEET_ID` |
| Supabase | demo project (`DEMO_SUPABASE_*`) | none needed beyond scripts | production project |
| Users | demo identities / demo Supabase | service account only | real accounts, Supabase invitations |
| Reads | full | parity suite only | full |
| Writes | **enabled** — full pipeline | **refused at environment layer** | flag-gated, off until Phase G |
| Badge | DEMO / UAT | n/a (no UI) | none |

Changes required: extend `AppEnv` to `'demo' | 'parity' | 'production'` with `PARITY_` prefix, `writesPermitted` and `fixturesPermitted:false` on the parity descriptor, and the no-shared-resources assertion extended pairwise across all three. This **touches pinned environment tests** (`ENVIRONMENT_DESCRIPTORS` values, `PublicEnvironmentInfo` keys) — updated deliberately in the same change, documented in the phase report.

Demo write path = production write path: same routes, same pipeline, same Supabase-backed operations/IDs (demo project), same audit — only credentials differ. The in-process demo dataset remains for zero-config demos: it plugs `InMemorySheetsClient`, `InMemorySequenceStore` and an in-memory operations store into the *same* pipeline, so the ten demo workflows (§24 of the brief) run identically with or without a demo workbook. Demo reset also clears the demo operations/ID state so replays start clean.

## 17. Playwright test strategy

`@playwright/test` as a devDependency (approved direction from the Phase A plan §16; now mandated by the brief). Structure:

- `playwright/` project with three configs: `public` (no auth), `app` (demo identities via the sign-in flow), `a11y-motion` (reduced-motion + keyboard).
- App under test runs `APP_ENV=demo` with the in-process dataset (deterministic, no network); a second CI-optional project targets the demo workbook for one end-to-end write smoke.
- Viewport matrix 375/390/768/1024/1440/1920 for: public pages, login, admin dashboard, operations today, investor portal, guest portal.
- Write workflows in DEMO: create reservation → appears in ledger + dashboard count; check-in/out; add expense → P&L row total changes (asserting the workbook/fixture calc surface, not client math); create+resolve maintenance; housekeeping completion; inventory movement; duplicate-submit (same operationId) produces one row; a devtools-style raw `fetch` writing a calc column gets 422; an OPERATIONS token posting an expense gets 403; an INVESTOR token posting anything gets 403.
- Cross-cutting assertions on every page visit: no horizontal overflow (`scrollWidth === clientWidth`), logo visible (bounding box + non-transparent colour — the cream-on-white regression), keyboard path through nav/drawer/form, reduced-motion renders static, screenshots to `reports/visual/<phase>/` with a contact sheet.
- Playwright complements — never replaces — the vitest suites; `npm run gate` stays the merge gate, `npm run e2e` is the browser gate.

## 18. Migration / rollback strategy

- **Database**: additive migrations only (`0003_operations.sql`). Rollback = drop table; no business data at risk (the scope rule: Supabase wipeable without business loss — preserved).
- **Capabilities**: added, never renamed; existing grants untouched, so all Phase 3 RBAC/isolation tests keep their meaning. Registry-driven tests auto-cover new routes.
- **Write enablement is a flag, not a deploy**: `<ENV>_WRITES_ENABLED`. Kill switch: flip production to `false` → the UI's action buttons disappear (server-rendered from environment) and the API returns controlled 403s; reads unaffected.
- **Sequence floors**: before enabling writes in any environment, `seedFromExistingIds` runs per sheet/scope from the live workbook (script + report). Floors only ever rise (`seed_sequence_floor` guarantees it).
- **Data rollback**: a bad web-created row is corrected the way V1 corrects anything — a status change through the app, or a management edit in the workbook; the operation ID in the row's provenance note and the audit before/after make every web write traceable. No automated deletion exists to misfire.
- **Cutover order** (matches phases): demo workbook writes (D) → live parity re-run including new write-touched families (E) → production reads (F) → seed floors, then production writes behind the flag with a one-day ADMIN-only soak (G).
- **UI rollback**: B1 ships behind the existing pages' structure (class names pinned); each phase is an independently revertable change set.

## 19. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `values.append` lands outside V1's prepared/validated rows | High | B2 live spike on the demo copy; primary path = first-blank-row `batchUpdate` + verify-by-ID; append only if proven |
| `USER_ENTERED` date/locale misparse writes wrong dates | High | B2 type-encoding spike; read-after-write compares serials; no production writes before the table exists |
| Human edits the open workbook mid-write (sort/delete) | Medium | Verify-by-ID, `ROW_MOVED` retry-once, honest failure; guidance: avoid sorting input sheets during hours |
| Retry storms duplicating rows | Medium | Operations table + allocator idempotency; Playwright double-click/parallel tests |
| Multi-instance deployment invalidates the in-process mutex | Medium | Documented single-instance assumption; operations table + verify remains correct; revisit before scaling |
| Stale reads after writes (cache) | Medium | `invalidate()` wired into step 8; TTL stays the backstop |
| Sheets quota under bursty writes | Low-Med | One write per intent, existing backoff, no polling loops beyond the 5s verify budget |
| New capabilities loosen OPERATIONS/INVESTOR | High if wrong | Registry enumeration auto-tests every new route per role; isolation suite untouched; INVESTOR gains nothing |
| Environment tests pinned to two envs break on adding `parity` | Low | Updated deliberately in the same change, called out in the report |
| Demo diverges from production write path | Medium | Same pipeline objects, injected backends; a test asserts the pipeline module IDs are identical across envs |
| Supabase demo project still not provisioned (open since Phase 5) | Blocker for D | Listed in decisions below |
| Brand artwork still absent | Blocker for brand moments | Same ask as Phase A |

## 20. Implementation phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **B1** UI/design foundation | Design system build (tokens, icons, primitives incl. form controls, one Button/Card), shell (rail/masthead), the five high-severity Phase A defects, public landing, dashboard restructure — all read-only | Gate green; Playwright visual matrix for existing pages; `design:accessibility-review` pass |
| **B2** Secure write architecture | `0003_operations.sql`; write capabilities + registry mutations; catch-all API handler binding `ApiRouter`; `MutationPipeline`; zod schemas; live spikes (append landing, type encoding) on the demo copy; cache invalidation; concurrency + idempotency + calc-rejection test suites (vitest, InMemory backends) | Every §9 endpoint served and refused correctly per role; 20×3 concurrency suite green; no UI mutation buttons yet |
| **C** Admin + Operations CRUD | Forms, drawers, action buttons on admin ledgers and operations screens; INPUT/CALCULATED marking; toasts/activity log | Playwright write workflows green in demo (in-process) |
| **D** Demo/UAT | Demo Supabase + demo workbook wired; ten demo write workflows end-to-end on the real Sheets API; seeded floors in demo | Demo walkthrough repeatable after reset |
| **E** LIVE parity | Existing parity gate re-run on the parity copy, extended to verify write-touched families reconcile after scripted writes | `LIVE PASS` verdict |
| **F** Production read-only | Production env configured, reads live, writes flag off | Prod isolation + auth checks green |
| **G** Production writes | Floors seeded from the live workbook; flag on; ADMIN-only soak; then OPERATIONS | Sign-off after soak |
| **H** Investor | Investor statement UI (read-only) on live data | Isolation suite green |
| **I** Guest | Guest portal + guest-request write path | Guest copy constraints green |
| **J** OpenAI | Copilot backend (server-side key, read-only grounding) | — |
| **K** Automation | Scheduled refresh/report automation | — |

Nothing is collapsed: each phase is its own change set, report and approval.

---

## Decisions required before B1/B2 start

1. Confirm the **mutation endpoint list and role grants** (§9) — especially: OPERATIONS may create/amend reservations (⚙ rows), and distributions paid-fields are ADMIN.
2. Confirm **no DELETE endpoints** and **no settings writes** in this phase.
3. Approve **Playwright** as a devDependency (§17).
4. Approve adding the **`parity` environment** to `AppEnv` (touches pinned environment tests, §16).
5. Provision the **demo Supabase project** (needed by D) and drop the **brand artwork** into `public/brand/` (carried over).
6. Confirm the Phase A open decisions (public `/`, warmer status palette, "Enquire for rates") still stand as answered by this brief — §17 confirms two of them; the status palette retune still needs a yes/no.
