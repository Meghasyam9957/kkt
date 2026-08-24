# LIVE Parity Gate — Status Report

```
OFFLINE = PASS 212/212
LIVE    = PENDING — NOT RUN
OVERALL = PENDING
```

**The status is unchanged, and it is not a failure.** LIVE parity has not run because it
cannot: it needs a Google Sheets workbook and a service-account key, and both have to be
created by someone with a Google account. Nothing in the codebase can produce them.

That distinction matters for the release decision. **LIVE = PENDING is not evidence of a
problem, and it is not evidence of correctness either.** It means the last gap — between
V1's JavaScript and what Google's formula engine actually evaluates — is still unmeasured.

Production must not be wired until it reads PASS.

---

## What was done instead

The suite was audited against the twenty-two metric families and eleven scenarios the gate
requires, then extended to cover all of them. That turned up a coverage gap, one product
defect, and two pre-existing failures on the operator's path — the exact commands the
runbook tells you to type. All four are fixed.

### 1 · The gate would have claimed more than it proved

The LIVE suite compared **26 rows of the 99_CALC monthly block × 12 months = 312 numbers**,
and nothing else. Measured against the required list:

| Required family | Before | Now |
|---|---|---|
| monthly revenue, expenses, operating profit | covered | covered |
| occupancy, ADR, RevPAR, booking count, cancellations | covered | covered |
| CAPEX treatment, cash flow, reserve, management fee | covered | covered |
| loss carry-forward, configured investor pool, investor waterfall | covered | covered |
| **operating margin** | **not compared** | 12 months |
| **ALOS** | **not compared** | 12 months |
| **cancellation rate** | **not compared** | 12 months |
| **carry-forward balance** | **not compared** | 12 months |
| **other revenue** | **not compared** | 12 months |
| **rent** | **no reader existed at all** | every 08_RENT row |
| **payout reconciliation** | **not compared** | 5 columns per booking |
| **property performance** | **not compared** | 8 columns per property |
| **platform performance** | **not compared** | 4 columns per platform |
| **blank/TBD behaviour** | implicit | asserted |

A run of the old suite would have printed `LIVE: PASS` while eight of the twenty-two
required families had never been compared. The report now tallies **each family
separately**, prints `NOT COVERED` for any with zero comparisons, and the suite fails on
it — so that particular way of being wrong is no longer available.

The suite also now checks that the copy **contains** the eleven required business
scenarios, and fails naming any that are missing. An absent scenario is a preparation gap;
recording it as a pass would be the exact dishonesty the gate exists to prevent.

### 2 · Pending Payables disagreed with the workbook by ₹71,500

`99_CALC.PendingPayables` is three components:

```
unpaid + part-paid expenses  +  rent past its due date  +  investor distributions calculated but unpaid
```

The web application counted **only the first**. It could not have counted the second —
`08_RENT_FIXED_COSTS` had no repository, so the rent register was never read — and it did
not read the distributions' `PendingAmount` column at all.

On V1's own seeded workbook, evaluated on the 20th of the month, four of the five rent rows
are past due:

| Row | Amount | Next due | Status |
|---|---:|---|---|
| RNT-001 | ₹26,000 | 5th | OVERDUE |
| RNT-002 | ₹17,000 | 5th | OVERDUE |
| RNT-003 | ₹27,000 | 5th | OVERDUE — never paid |
| RNT-004 | ₹18,000 | next month | Paid ✓ |
| RNT-005 | ₹1,500 | 10th | OVERDUE |

The workbook would report **₹71,500** of overdue rent on the same screen where the web
application reported **₹0**.

This is what the gate is for, and the old suite could not have found it: `PendingPayables`
is a report-month KPI scalar, and the old suite only read the FY monthly block.

**Fixed** by porting V1's `build_08_RENT` obligation rules
(`lib/server/analytics/rent.ts`), adding a `RentRepository`, reading the distributions'
pending column, and rewriting `pendingPayables()` to V1's definition. `tests/rent.test.ts`
covers every branch in 23 cases — including the OVERDUE path, which the demonstration data
never reaches.

**No demonstration figure changed.** In the demo dataset all rent is paid current and the
seeded distributions are fully paid, so Pending Payables is identical across all six
scenarios. Verified, not assumed.

### 3 · `npm run parity` crashed before it did anything

```json
"parity": "node scripts/live-parity-preflight.mjs; vitest run ... && node scripts/parity-report.mjs"
```

`;` is a POSIX separator. npm runs scripts through `cmd.exe` on Windows, which read the
semicolon as part of the filename:

```
Error: Cannot find module 'C:\...\scripts\live-parity-preflight.mjs;'
```

The first command in the runbook, on the machine the runbook is written for. Now chained
with `&&`, and the preflight exits `0` when credentials are simply absent — "not
configured" is a reported state, not a broken one, and it must not stop the offline layers
from running and publishing a report that says LIVE is PENDING.

### 4 · The preflight crashed on this machine's Node

It read the contract through `import(..., { with: { type: 'json' } })`. Node 20.8 rejects
that syntax (it wants `assert`), and Node 22 rejects `assert`. The line had never executed,
because every previous run exited at the missing-credentials check before reaching it. It
now reads the file with `readFileSync` — no syntax feature involved, so no Node version can
be the thing that fails at the gate.

### 5 · A malformed range, caught before shipping

The new preflight reads `02_SETTINGS` to scan for stored secrets. That sheet is a labelled
key/value page, not a table, so it has no column registry — the range builder produced
`'02_SETTINGS'!A4:` with no end column, which the Sheets API rejects, and the whole
preflight would have died on the batch read. It now reads the whole tab.

---

## One thing that needs your decision, not a code change

**"Pending Investor Distributions" has two definitions running at once.**

- `99_CALC` Q22 sums the register's `PendingAmount` column, **across every period**. That
  is what the workbook computes, so it is what the engine now ports, and it is the figure
  that feeds Pending Payables.
- The web dashboard shows a tile under the same name computed differently: **unpaid
  allocations for the reporting month**, including a period that has no register row yet.

In the demonstration data they differ by ₹86,055 — the dashboard tile reads ₹86,055 while
Pending Payables (₹5,050) counts none of it. On the same screen.

Which one is right is a business question — *does an allocation the register has not
recorded yet count as money owed?* — so it has not been changed unilaterally. The behaviour
is pinned by a test, the LIVE report prints both numbers from the real workbook under
**Not compared** marked `DECISION REQUIRED`, and Pending Payables moves with whichever
answer you give.

---

## Preparation checklist — all nine points automated

The preflight now works through the checklist against the actual workbook rather than
asking the operator to confirm it by eye:

| # | Point | How it is checked |
|---|---|---|
| 1 | is a COPY, not production | refuses `PRODUCTION_GOOGLE_SHEET_ID` / `DEMO_GOOGLE_SHEET_ID` outright |
| 2 | title says PARITY / TEST | title match, advisory — the call is the operator's |
| 3 | all 22 sheets exist | from the generated contract, not a typed list |
| 4 | all named ranges exist | all 60, from the contract |
| 5 | contains fixture records | revenue months, reservation and expense counts |
| 6 | demo business rules configured | reads `CFG_INVESTOR_POOL_PCT`, warns when TBD |
| 7 | no real guest data | scans for contact-shaped strings |
| 8 | no real investor data | same, plus the landlord register |
| 9 | no production secrets | seven known key formats |

Points 7–9 are heuristics and are labelled as such: they detect **evidence**, and cannot
prove absence. The preflight prints that caveat rather than implying more than it knows.
The scanners have 35 unit tests, including the false positives that matter — a booking id,
a date serial and a rupee amount must not read as a phone number.

---

## What the report will produce

`reports/PARITY_REPORT.md`, in the requested shape:

```
| Metric | TypeScript | Google Sheets | Delta | Tolerance | Result |
```

plus the run's identity (timestamp, workbook, timezone, report month, service account),
a per-family coverage matrix, the eleven scenarios with where each was found, a
**Not compared** table with reasons, and — on any failure — a triage table naming the
source cell or named range and a candidate cause. Nothing is truncated. Machine-readable
output is `reports/parity.live.json` and `reports/parity.preflight.json`.

The verdict is one of exactly three strings, and it is **computed, never asserted**:

| Verdict | When |
|---|---|
| `LIVE PASS` | every comparison agreed **and** every required family was actually compared |
| `LIVE FAIL` | something disagreed, **or** a family was never compared |
| `LIVE PENDING` | the comparison has not run |

**A family with zero comparisons can never produce a PASS.** A metric nobody compared is
missing evidence, and missing evidence is not agreement. Thirteen tests run the real
report script against synthetic evidence to prove that rule holds — including the case
where nothing fails and one family is simply absent.

Tolerances are floating-point allowances, not business allowances:

| Kind | Tolerance |
|---|---|
| money | ₹0.01 |
| ratios and ALOS | 1e-9 |
| counts | **0** — a count off by one is a defect |
| dates and text | **0** |

The previous suite allowed **₹1** on money and **0.0005** on ratios. Both are now tighter.

---

## Read-only, and V1 untouched

- The suite reads. `PARITY_ALLOW_WRITES` is not a supported mode and is asserted unset.
- `CFG_REPORT_MONTH` is **read** to learn which month the report-month blocks describe.
  It is never written. A test walks `lib/`, `app/` and `components/` and fails if any
  application file calls a report-month reader — the readers exist for the harness alone.
- The service account is granted Viewer, so an accidental write is impossible at Google's
  end as well as ours.
- V1 harness: **PASS — 0 errors, 0 warnings, 1,837 formulas, 70 named ranges.** No file in
  `homestay-ops/` was modified.

---

## To run it

**One command.** About twenty minutes of setup, most of it waiting for Google, then:

```bash
npm run parity
```

Step-by-step, written for a non-technical operator with Windows instructions throughout:
[`LIVE_PARITY_RUNBOOK.md`](LIVE_PARITY_RUNBOOK.md).

Setup, in short:

1. Deploy V1 to a blank sheet, then **File ▸ Make a copy** named so the title says PARITY.
2. In the copy: 🏠 **Homestay Ops ▸ Seed FICTIONAL test data**.
3. In the copy's `02_SETTINGS`: set `CFG_REPORT_MONTH` to a month that has data, and set
   the parity-test business rules — without them the distribution chain compares 0 with 0
   and the loss-recovery scenario cannot occur at all.
4. Google Cloud: create a service account, enable the Sheets API, download the JSON key,
   and keep it **outside** the repository.
5. Share the **copy** with the service-account address as **Viewer**.
6. Set two variables, then run:

```powershell
$env:PARITY_SHEET_ID = "<id of the parity copy>"
```

```powershell
$env:PARITY_SERVICE_ACCOUNT_FILE = "C:\keys\parity-key.json"
```

Then send back `reports/PARITY_REPORT.md`. If it fails, the triage table names the cell —
and the invariant holds: if the V1 formula itself is wrong, that is
**MANAGEMENT / BUSINESS LOGIC REVIEW REQUIRED**, not a code change.

### The credential

| | |
|---|---|
| What it is | a Google **service account** — a robot account with no password |
| Its address | `homestay-parity@<project>.iam.gserviceaccount.com`, from the Cloud Console. Not secret; you need it to share the sheet. |
| The credential | the **JSON key file** Google downloads (`key.json`) |
| Where to put it | anywhere **outside this repository** — e.g. `C:\keys\parity-key.json` |
| How to point at it | `PARITY_SERVICE_ACCOUNT_FILE` = the **path** to that file |
| Alternative | `PARITY_SERVICE_ACCOUNT_JSON_BASE64` = the same file, base64-encoded. For pipelines; the path form is far easier to get right on Windows. |
| Access to grant | **Viewer**, on the copy only. Never share the production workbook with it. |
| Never | commit it, email it, or paste its contents anywhere |

The tool never prints the key. The report records only the last six characters of the
workbook id. `.env` and `.env.local` are git-ignored, `.env.example` carries names only,
and a test fails the build if a credential-shaped literal is ever committed.

### Windows

The whole workflow is one Node process now — no `&&`, no `;`, no `$(...)`, no shell at
all. Child processes are spawned as `process.execPath <script>` with `shell: false`, which
behaves identically on Windows, macOS and Linux. Tests assert it:

- `npm run parity` must be exactly `node scripts/parity.mjs`
- no npm script may contain `;`, `$(`, a backtick, `export `, `unset `, `2>/dev/null` or `||`
- the orchestrator must name `node_modules/vitest/vitest.mjs` directly rather than let a
  shell resolve `vitest` — which hits a `.cmd` shim on Windows

## Current gate state

| Gate | Status |
|---|---|
| OFFLINE parity | **PASS** 212/212 |
| LIVE parity | **PENDING — not run** |
| **OVERALL PARITY** | **PENDING** |
| Production environment isolation | not provisioned |
| Production authentication | not provisioned |

**Phase 6 not started.** Production remains unapproved on all three counts.
