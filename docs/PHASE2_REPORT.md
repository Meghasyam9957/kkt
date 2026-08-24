# Phase 1–2 Report — Contract, Adapter, Engine, Parity Gate

**Scope built:** contract generation, Google Sheets server adapter, server-side KPI engine,
parity test suite. **No UI.** V1 untouched and re-verified green.

**Gate status: OFFLINE PASS (212/212) · LIVE NOT RUN — credentials required.**

```
npm run gate
  contract:check   OK — no drift (model 459a6a48fad6ea5f)
  typecheck        clean (strict, noUncheckedIndexedAccess)
  tests            60 passed, 2 skipped (live parity)
  parity report    212/212 offline · LIVE NOT RUN
  GATE: PASS
```

---

## A. Parity results

Four layers. Each proves something the others cannot.

| Layer | What it proves | Checks | Failed |
|---|---|---:|---:|
| **L1 contract** | generated TS contract matches the V1 registry exactly | 62 | 0 |
| **L2 cross-impl** | TS engine agrees with V1's own independent JS recomputation | 61 | 0 |
| **L3 absolute** | both agree with hand-computed values | 89 | 0 |
| **LIVE** | TS engine vs Google's actual formula engine | — | *not run* |
| **Offline total** | | **212** | **0** |

### The deepest cross-check — V1's own QA routine vs the engine (S1 baseline, Apr-2026)

| Metric | V1 (independent JS) | TypeScript | Difference |
|---|---:|---:|---:|
| MTD net revenue | 38,890 | 38,890 | 0 |
| MTD operating expenses | 4,680 | 4,680 | 0 |
| MTD operating profit | 34,210 | 34,210 | 0 |
| Occupied nights | 10 | 10 | 0 |
| Occupancy % | 0.08 | 0.08 | 0 |
| ADR | 4,500 | 4,500 | 0 |
| **Distributable profit** | **32,499.50** | **32,499.50** | **0** |
| **Investor pool amount** | **19,499.70** | **19,499.70** | **0** |
| Pending receivables | 0 | 0 | 0 |

### Loss carry-forward chain — the hardest logic in the system

| Month | Operating profit | Reserve | Carry applied | Distributable | Balance |
|---|---:|---:|---:|---:|---:|
| Apr | −20,000 | 0 | 0 | **0** | −20,000 |
| May | +30,000 | 1,500 | 20,000 | **8,500** | 0 |
| Jun | +15,000 | 750 | 0 | **14,250** | 0 |

Every figure matches V1 exactly. A loss produces **zero** distribution, the recovery consumes
only the *unrecovered* balance, and profits already distributable are never clawed back.

### Required edge cases — all covered, all passing

| # | Edge case | Scenario | Evidence |
|---|---|---|---|
| 1 | Zero revenue | S3 | net/ADR/RevPAR/occupancy/margin/ALOS all `0`, all finite — no NaN, no Infinity |
| 2 | Cancelled booking | S1 | excluded from occupancy (10 nights not 13) and from bookings count; counted in cancellation rate (1/4) |
| 3 | Partial payout | S6 | expected 17,850 vs actual 10,000 → pending receivables 7,850 |
| 4 | CAPEX | S1 | ₹45,000 CAPEX + ₹20,000 misfiled CAPEX-typed expense — **neither** reaches operating profit (OpEx stays 4,680) |
| 5 | Shared expenses | S1 | `COMMON` ₹1,500 in the business-wide total, excluded from per-property direct costs; Σ direct + COMMON = total OpEx reconciles |
| 6 | Loss month | S2 Apr | OP −20,000 → distributable 0, investor pool 0, reserve 0 |
| 7 | Carry-forward / recovery | S2 May–Jun | table above |
| 8 | Multiple investors | S8 | 40/35/25 split; Σ allocations = pool exactly; paid / partial / pending statuses correct |
| 9 | Investor rules unset (TBD) | S4 | pool ₹0, operator ₹0, reserve ₹0, status `Not configured`; operating profit still reported |
| 10 | Property filtering | S1 | HYD-501: net 22,250, direct OpEx 2,000, profit 20,250, ADR 5,000; Σ per-property net = month net |
| 11 | Platform filtering | S1 | Airbnb gross 34,000 / fees 4,950 / net 29,050; Σ platform net = month net |

Plus: single investor at 100% (S5), blocked unit leaving the capacity denominator (S7),
FY totals recomputing ratios instead of summing them, and investor-scoped queries returning
exactly one investor.

### What LIVE parity would add, and why it is still required

The offline layers compare against **V1's JavaScript implementation** of the workbook
definitions — genuinely independent code, but not Google's formula engine. Until the
workbook is deployed to Google Sheets and LIVE parity runs, the gap between
"V1's JS says X" and "the spreadsheet formula evaluates to X" is unverified.

That gap is exactly where Phase 1's worst bugs lived (case-insensitive `whenTextContains`,
named ranges inside CF formulas, pre-epoch `EOMONTH`). **I would not call this gate fully
closed until LIVE runs.** The harness is written and will execute the moment credentials
exist:

```bash
GOOGLE_SHEET_ID=<copy of the workbook> \
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<base64 service-account json> \
npm run parity
```

It compares all 26 monthly metrics across all 12 FY months (312 checks), read-only, without
touching `CFG_REPORT_MONTH`.

---

## B. Contract-generation results

`lib/contract/generate.mjs` evaluates `homestay-ops/src/00_constants.gs` in a sandbox and
emits typed TypeScript. The V1 file is opened **read-only**.

| Extracted | Count |
|---|---:|
| Sheets | 22 |
| Tabular sheets with column registries | 15 |
| Columns | **261** |
| — writable input columns | 227 |
| — workbook-owned formula columns | 34 |
| Dropdown lists (→ TS union types) | 31 |
| Required named ranges | 60 |
| 99_CALC monthly metrics | 35 |
| Business rules (with live/recorded-only flag) | 11 |

- **Contract model hash:** `459a6a48fad6ea5f` · **V1 source hash:** `ddb108025afb909d`
- Both are committed in `contract.lock.json`. `npm run contract:check` **fails CI** if the
  workbook contract changes without review — the drift can't happen quietly.

What this buys, concretely:

- Column letters are **derived from registry order**, so inserting a column in V1 cannot
  silently misalign a field.
- `role: 'calc'` travels with each column, making formula columns **unwritable by
  construction** rather than by convention.
- Enums (`BookingStatus`, `PaymentStatus`, …) become TypeScript unions, so an invalid status
  is a compile error.
- The four **recorded-only** business rules (profit definition, CAPEX recovery, distribution
  frequency, minimum cash reserve) are flagged in the contract, so the UI can label them
  honestly instead of implying they are applied.

---

## C. Adapter capabilities

`GoogleSheetsClient` is the only place the Sheets API is touched. Two implementations share
one interface and the same guards: `GoogleSheetsApiClient` (service account) and
`InMemorySheetsClient` (fixtures/tests, including named-range resolution).

| Capability | Status | Notes |
|---|---|---|
| Read sheet | ✅ | typed records via repositories |
| Read ranges | ✅ | `batchGet` — one round trip for many ranges |
| Read named ranges | ✅ | `CFG_*`, `TBL_PLATFORMS` (both backends) |
| Write input records | ✅ | input columns only, enforced structurally |
| Append records | ✅ | `values.append`, `INSERT_ROWS`, `USER_ENTERED` |
| Update records | ✅ | `updateById` patches individual input cells |
| Refresh calculation data | ✅ | `flush()` — settle window + round trip for read-after-write |
| Retrieve dashboard KPIs | ✅ | FY monthly block + alert stack + engine-computed breakdowns |
| Retry / backoff | ✅ | exponential backoff on 429/5xx |

**Repositories:** Property, Reservation, Revenue, Expense, Capex, CashFlow, Investor,
Distribution, Settings, Analytics. `loadWorkbookData()` fetches the entire workbook in
**≤2 batch calls** (asserted by test).

### Protections that are structural, not advisory

| Guarantee | How | Test |
|---|---|---|
| Cannot write `CFG_REPORT_MONTH` | `assertWritable` rejects the cell **and** the whole dashboard sheet | ✅ |
| Cannot write calculated sheets | `99_CALC`, `10_MONTHLY_PNL`, `19_ANALYTICS`, `20_QA_CHECKS`, `21_SYSTEM_GUIDE` rejected | ✅ |
| Cannot write a formula column | `buildInputRow` throws on a `calc` key and emits `null` for every calc cell | ✅ |
| Cannot patch a formula column | `updateById` rejects calc keys | ✅ |
| No report-month-dependent reader exists | `AnalyticsRepository` exposes only `readMonthlyBlock` / `readAlerts` | ✅ |

18 adapter tests, all passing.

---

## D. Failed cases

**None outstanding.** 212/212 offline checks pass, 60/60 tests pass.

Two real defects were found and fixed **during** this phase — both worth recording because
they are the kind that produce confidently wrong numbers:

1. **Cross-realm `Date` rejection (parity harness).** Fixture dates built in the Node realm
   failed V1's `v instanceof Date` guard inside the vm sandbox, so V1 silently returned `0`
   for every metric. Had the harness been written to compare "0 vs 0" cases only, this would
   have produced a **green parity report that verified nothing**. Fixed by constructing
   fixture dates with the sandbox's own `Date`. I then explicitly verified that 53 of 61
   L2 checks carry non-zero V1 values, and that every remaining zero is a genuinely-empty
   scenario.
2. **Named ranges unsupported in the fixture backend.** `SettingsRepository` reads `CFG_*` as
   ranges — which the live API supports and the in-memory backend did not. The tests would
   have passed against a backend the production code could not actually use. Fixed by adding
   named-range resolution to the fixture client.

**Deliberately not "fixed" (correct behaviour, recorded so it is not mistaken for a bug):**

- A blank `ExpenseType` row is **excluded** from operating expenses. That matches V1 exactly
  (V1 flags it as QA-31). The engine does not silently reclassify it.
- `COMMON` costs are excluded from per-property profit. Allocation is an open management
  decision; the engine does not invent a rule. The reconciliation is asserted:
  Σ direct + COMMON = total OpEx.
- The V1 QA-row comparison rounds to 2 dp (V1's own display rounding), so occupancy compares
  as `0.08`. Exact-precision occupancy is covered separately in L3 (`10/120`).

---

## E. Architecture risks

| # | Risk | Status after this phase |
|---|---|---|
| R1 | Shared `CFG_REPORT_MONTH` state | **Closed structurally.** The adapter refuses the write; no report-month-dependent reader exists; period is a parameter. |
| R2 | TS engine drifts from workbook KPIs | **Mitigated, not closed.** 212 offline checks + CI drift gate. Closes fully when LIVE parity runs. |
| R6 | Someone edits the workbook structure | **Closed.** `contract:check` fails CI on any contract change. |
| **R17** | **Parity harness that appears to pass while verifying nothing** | **New — found and closed.** See D.1. Now guarded by non-zero-value verification. |
| R3 | Sheets concurrency (no transactions, duplicate IDs) | **Open — next phase.** Atomic ID allocation, idempotency keys and the per-sheet write lock are designed but not built. |
| R4 | Sheets latency/quota | **Partly mitigated.** Batched reads + backoff shipped; the cache layer is not built yet. |
| R5 | Recalculation lag after write | **Partly mitigated.** `flush()` exists; read-after-write is not yet wired into the write path. |
| R7 | Single spreadsheet = single point of failure | **Open.** Snapshot/restore not built. |
| R11 | DPDP Act obligations | **Open — management decision.** |
| R15 | Two front doors (sheet + web) | **Decided:** the web app becomes primary data entry; the workbook stays the source/control layer. Enforcement (who may type where) is still an operational decision. |

**One new architectural note.** The engine computes the FY carry-forward chain from FY start
on every waterfall call, because month *N*'s balance depends on every prior month. That is
correct and cheap at this scale, but it means investor figures are only meaningful for months
inside the configured financial year. Multi-year reporting will need an explicit FY-selection
design — flagged now rather than discovered later.

---

## F. Exact next implementation phase

**Phase 3 — Authentication + RBAC** (per the approved sequence), with one prerequisite:

### Prerequisite (blocks final gate closure, not Phase 3)

**Deploy the V1 workbook to Google Sheets and run LIVE parity.** Needs:
1. `setupWorkbook()` run on a fresh sheet (Phase 1 deployment guide).
2. A **copy** shared with a service account as Editor.
3. `GOOGLE_SHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` set.
4. `npm run parity` → expect 312 LIVE checks.

Phase 3 can proceed in parallel; it does not depend on the workbook existing.

### Phase 3 scope

1. Supabase project + `app_users` (role, `investor_id`, status). Public signup **disabled**.
2. Session handling — httpOnly cookies, server-side refresh.
3. Three enforcement layers: middleware route guard → `withAuth([roles])` API wrapper →
   repository-level investor scoping using the **server-resolved** `investor_id`.
4. `tests/rbac.test.ts` — every route × every role, including negative cases
   (INVESTOR reaching admin APIs, one investor requesting another's data).
5. Audit log table + `AuditService` (actor, role, sheet, record, before/after, timestamp).
6. Atomic ID allocation (`id_sequences`) + idempotency keys — closing R3 before the first
   real write path in Phase 5.

**Exit criteria:** all four roles authenticate; every route blocks unauthorized access at the
API layer (not just the UI); investor isolation proven by test; audit rows written for every
mutation.

### Two items needing you

1. **Business name for the workbook.** `CFG_BIZ_NAME` in `02_SETTINGS` should be set to
   **Srivillu Home Stays**. That is a data entry in the sheet, not a code change — I have not
   touched V1 to make it.
2. **Logo file.** The image could not be written from the conversation. Drop the master at
   `homestay-web/public/brand/srivillu-logo.png` (see `public/brand/README.md` for the other
   exports). The palette is already extracted into `lib/shared/brand.ts`; nothing blocks on
   the file arriving.

---

## Deliverables

| Path | Purpose |
|---|---|
| `lib/contract/generate.mjs` | contract generator (+ `--check` drift gate) |
| `lib/contract/contract.generated.ts` | 261-column typed contract — do not hand-edit |
| `lib/contract/contract.lock.json` | committed hashes for drift detection |
| `lib/server/sheets/client.ts` | `GoogleSheetsClient` + write guards + fixture backend |
| `lib/server/sheets/repositories/index.ts` | 10 repositories + single-batch loader |
| `lib/server/analytics/kpi.ts` | the KPI engine — the only copy of any business calculation |
| `lib/shared/{dates,domain,brand}.ts` | serial-space dates, domain types, brand tokens |
| `tests/parity.test.ts` | L1/L2/L3 parity suite |
| `tests/parity.live.test.ts` | LIVE parity (skips + reports NOT RUN without credentials) |
| `tests/adapter.test.ts` | write-safety and adapter capability tests |
| `tests/contract.test.ts` | contract integrity + drift |
| `tests/support/v1-bridge.ts` | drives V1 in a sandbox for independent recomputation |
| `reports/PARITY_REPORT.md` | the parity report (sheet / TS / difference / pass-fail) |

~7,700 lines. `npm run gate` runs everything.
