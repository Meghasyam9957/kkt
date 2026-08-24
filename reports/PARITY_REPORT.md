# Parity Report — Google Sheets ↔ TypeScript

**LIVE PENDING** — LIVE parity is not configured. Still needed: PARITY_SHEET_ID, PARITY_SERVICE_ACCOUNT_FILE (or PARITY_SERVICE_ACCOUNT_JSON_BASE64).

## This run

| | |
|---|---|
| Run at | 2026-08-23T21:00:15.809Z |
| Offline evidence generated | 2026-08-23T20:59:13.768Z |
| Environment | parity harness — `LIVE_DATA_ENABLED` is not involved, and no application environment is started |
| Workbook | (unknown) |
| Workbook id | `(unknown)` (last six characters only) |
| Workbook timezone | (unknown) |
| Report month | (unknown) |

> The workbook is never written to. `CFG_REPORT_MONTH` is read to learn which month
> the report-month blocks describe, and is never set by anything in this repository.

## Coverage matrix

The LIVE suite has not run, so **no family has been compared against Google's formula
engine**. The families it will cover:

| Family | Comparisons | Status |
|---|---:|---|
| monthly revenue | 0 | NOT RUN |
| monthly expenses | 0 | NOT RUN |
| operating profit | 0 | NOT RUN |
| operating margin | 0 | NOT RUN |
| occupancy | 0 | NOT RUN |
| ADR | 0 | NOT RUN |
| RevPAR | 0 | NOT RUN |
| booking count | 0 | NOT RUN |
| cancellations | 0 | NOT RUN |
| ALOS | 0 | NOT RUN |
| CAPEX treatment | 0 | NOT RUN |
| cash flow | 0 | NOT RUN |
| rent | 0 | NOT RUN |
| payout reconciliation | 0 | NOT RUN |
| property performance | 0 | NOT RUN |
| platform performance | 0 | NOT RUN |
| investor waterfall | 0 | NOT RUN |
| loss carry-forward | 0 | NOT RUN |
| reserve | 0 | NOT RUN |
| management fee | 0 | NOT RUN |
| configured investor pool | 0 | NOT RUN |
| blank/TBD behaviour | 0 | NOT RUN |

## Layers

| Layer | What it proves | Checks | Failed |
|---|---|---:|---:|
| L1 contract | generated TS contract matches the V1 registry exactly | 62 | 0 |
| L2 cross-impl | TS engine agrees with V1’s own independent JS recomputation | 61 | 0 |
| L3 absolute | both agree with hand-computed expected values | 89 | 0 |
| LIVE | TS engine vs Google’s actual formula engine | — *not run* | — |

**OFFLINE: PASS** — 212/212 checks passed.
**LIVE PENDING**
**OVERALL PARITY GATE: PENDING** — offline PASS *and* LIVE PASS.

> **Parity gate REMAINS OPEN.** Offline passes, but the gate does not close until the
> LIVE suite passes against the actual Google Sheets formula engine.

> **LIVE parity: NOT RUN.** LIVE parity is not configured. Still needed: PARITY_SHEET_ID, PARITY_SERVICE_ACCOUNT_FILE (or PARITY_SERVICE_ACCOUNT_JSON_BASE64).
>
> Follow docs/LIVE_PARITY_RUNBOOK.md — deploy the V1 workbook, make a COPY, share it with a service account as Viewer, set PARITY_SHEET_ID and PARITY_SERVICE_ACCOUNT_FILE, then run `npm run parity`.
>
> The offline layers compare against V1’s JavaScript implementation of the same
> definitions, not against Google’s formula engine. Until LIVE parity runs, that
> last gap is unverified.

## Tolerances

These are floating-point allowances. **None of them is a business allowance** — no
difference is excused because it is small in rupees.

| Kind | Tolerance | Why |
|---|---|---|
| money | ₹0.01 | One paisa. Both engines do the same arithmetic in IEEE-754 doubles but accumulate sums in a different order, so the last bit can differ. Below a paisa nothing can be paid or owed, so it cannot represent a real discrepancy. |
| ratios — occupancy, operating margin, cancellation rate | 1e-9 | A pure division on both sides. 1e-9 is roughly a ten-millionth of a percentage point: far below any representable business quantity, far above double-precision noise. |
| ALOS | 1e-9 | Also a division (nights ÷ bookings), same reasoning. |
| counts — bookings, nights, tickets, units | **0** | Integers on both sides. A count off by one is a booking counted twice or a night missed; there is no rounding to hide behind. |
| dates and text — rent due dates, payment status | **0** | Exact string and date match. "Due soon" and "OVERDUE" are different answers, not nearby ones. |

## L2 cross-impl — TS engine agrees with V1’s own independent JS recomputation

### S1-baseline 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 38,890 | 38,890 | 0 | PASS |
| operating expenses | 4,680 | 4,680 | 0 | PASS |
| operating profit | 34,210 | 34,210 | 0 | PASS |
| occupied nights | 10 | 10 | 0 | PASS |
| room gross revenue | 45,000 | 45,000 | 0 | PASS |

### S2-loss-carryforward 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 10,000 | 10,000 | 0 | PASS |
| operating expenses | 30,000 | 30,000 | 0 | PASS |
| operating profit | -20,000 | -20,000 | 0 | PASS |
| occupied nights | 0 | 0 | 0 | PASS |
| room gross revenue | 10,000 | 10,000 | 0 | PASS |

### S2-loss-carryforward 2026-05

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 50,000 | 50,000 | 0 | PASS |
| operating expenses | 20,000 | 20,000 | 0 | PASS |
| operating profit | 30,000 | 30,000 | 0 | PASS |
| occupied nights | 0 | 0 | 0 | PASS |
| room gross revenue | 50,000 | 50,000 | 0 | PASS |

### S2-loss-carryforward 2026-06

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 20,000 | 20,000 | 0 | PASS |
| operating expenses | 5,000 | 5,000 | 0 | PASS |
| operating profit | 15,000 | 15,000 | 0 | PASS |
| occupied nights | 0 | 0 | 0 | PASS |
| room gross revenue | 20,000 | 20,000 | 0 | PASS |

### S3-zero-revenue 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 0 | 0 | 0 | PASS |
| operating expenses | 5,000 | 5,000 | 0 | PASS |
| operating profit | -5,000 | -5,000 | 0 | PASS |
| occupied nights | 0 | 0 | 0 | PASS |
| room gross revenue | 0 | 0 | 0 | PASS |

### S4-rules-tbd 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 38,890 | 38,890 | 0 | PASS |
| operating expenses | 4,680 | 4,680 | 0 | PASS |
| operating profit | 34,210 | 34,210 | 0 | PASS |
| occupied nights | 10 | 10 | 0 | PASS |
| room gross revenue | 45,000 | 45,000 | 0 | PASS |

### S5-single-investor 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 38,890 | 38,890 | 0 | PASS |
| operating expenses | 4,680 | 4,680 | 0 | PASS |
| operating profit | 34,210 | 34,210 | 0 | PASS |
| occupied nights | 10 | 10 | 0 | PASS |
| room gross revenue | 45,000 | 45,000 | 0 | PASS |

### S6-partial-payout 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 29,150 | 29,150 | 0 | PASS |
| operating expenses | 0 | 0 | 0 | PASS |
| operating profit | 29,150 | 29,150 | 0 | PASS |
| occupied nights | 7 | 7 | 0 | PASS |
| room gross revenue | 35,000 | 35,000 | 0 | PASS |

### S7-blocked-unit 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 38,890 | 38,890 | 0 | PASS |
| operating expenses | 4,680 | 4,680 | 0 | PASS |
| operating profit | 34,210 | 34,210 | 0 | PASS |
| occupied nights | 10 | 10 | 0 | PASS |
| room gross revenue | 45,000 | 45,000 | 0 | PASS |

### S8-distributions 2026-04

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 38,890 | 38,890 | 0 | PASS |
| operating expenses | 4,680 | 4,680 | 0 | PASS |
| operating profit | 34,210 | 34,210 | 0 | PASS |
| occupied nights | 10 | 10 | 0 | PASS |
| room gross revenue | 45,000 | 45,000 | 0 | PASS |

### S1-baseline QA

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| MTD net revenue | 38,890 | 38,890 | 0 | PASS |
| MTD operating expenses | 4,680 | 4,680 | 0 | PASS |
| MTD operating profit | 34,210 | 34,210 | 0 | PASS |
| Occupied nights (month) | 10 | 10 | 0 | PASS |
| Occupancy % | 0.08 | 0.08 | 0 | PASS |
| ADR (month) | 4,500 | 4,500 | 0 | PASS |
| Distributable profit (month) | 32,499.50 | 32,499.50 | 0 | PASS |
| Investor pool amount (month) | 19,499.70 | 19,499.70 | 0 | PASS |
| Pending receivables | 0 | 0 | 0 | PASS |

### S6-partial-payout

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| expected payout BK-2026-0001 | 17,850 | 17,850 | 0 | PASS |
| expected payout BK-2026-0002 | 12,300 | 12,300 | 0 | PASS |

## L3 absolute — both agree with hand-computed expected values

### S1-baseline

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| active units | 4 | 4 | 0 | PASS |
| available nights (30d × 4) | 120 | 120 | 0 | PASS |
| occupied nights (cancelled excluded) | 10 | 10 | 0 | PASS |
| occupancy % | 0.083333 | 0.083333 | 0 | PASS |
| room revenue | 45,000 | 45,000 | 0 | PASS |
| cleaning revenue | 1,000 | 1,000 | 0 | PASS |
| gross revenue | 46,000 | 46,000 | 0 | PASS |
| platform fees | 7,110 | 7,110 | 0 | PASS |
| net revenue | 38,890 | 38,890 | 0 | PASS |
| operating expenses (CAPEX row excluded) | 4,680 | 4,680 | 0 | PASS |
| operating profit | 34,210 | 34,210 | 0 | PASS |
| ADR | 4,500 | 4,500 | 0 | PASS |
| RevPAR | 375 | 375 | 0 | PASS |
| bookings count | 3 | 3 | 0 | PASS |
| cancelled count | 1 | 1 | 0 | PASS |
| cancellation rate | 0.25 | 0.25 | 0 | PASS |
| ALOS (10 nights / 3 bookings) | 3.333333 | 3.333333 | 0 | PASS |
| CAPEX (memo, not OpEx) | 45,000 | 45,000 | 0 | PASS |
| reserve 5% | 1,710.50 | 1,710.50 | 0 | PASS |
| distributable profit | 32,499.50 | 32,499.50 | 0 | PASS |
| investor pool 60% | 19,499.70 | 19,499.70 | 0 | PASS |
| net cash | 20,000 | 20,000 | 0 | PASS |
| CAPEX excluded from OpEx | 4,680 | 4,680 | 0 | PASS |

### S2 Apr

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| operating profit (loss) | -20,000 | -20,000 | 0 | PASS |
| reserve on a loss = 0 | 0 | 0 | 0 | PASS |
| distributable (loss ⇒ 0) | 0 | 0 | 0 | PASS |
| investor pool (loss ⇒ 0) | 0 | 0 | 0 | PASS |
| carry-forward balance | -20,000 | -20,000 | 0 | PASS |
| distribution INV-001 on a loss | 0 | 0 | 0 | PASS |
| distribution INV-002 on a loss | 0 | 0 | 0 | PASS |
| distribution INV-003 on a loss | 0 | 0 | 0 | PASS |

### S2 May

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| operating profit | 30,000 | 30,000 | 0 | PASS |
| reserve 5% | 1,500 | 1,500 | 0 | PASS |
| carry-forward applied | 20,000 | 20,000 | 0 | PASS |
| distributable after recovery | 8,500 | 8,500 | 0 | PASS |
| balance cleared | 0 | 0 | 0 | PASS |

### S2 Jun

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| carry-forward applied (none left) | 0 | 0 | 0 | PASS |
| distributable | 14,250 | 14,250 | 0 | PASS |

### S3-zero-revenue

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| net revenue | 0 | 0 | 0 | PASS |
| occupancy | 0 | 0 | 0 | PASS |
| ADR | 0 | 0 | 0 | PASS |
| RevPAR | 0 | 0 | 0 | PASS |
| margin | 0 | 0 | 0 | PASS |
| ALOS | 0 | 0 | 0 | PASS |
| cancellation rate | 0 | 0 | 0 | PASS |
| investor pool | 0 | 0 | 0 | PASS |
| operating profit (expenses only) | -5,000 | -5,000 | 0 | PASS |

### S4-rules-tbd

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| investor pool with rules TBD | 0 | 0 | 0 | PASS |
| operator share with rules TBD | 0 | 0 | 0 | PASS |
| reserve with rule TBD | 0 | 0 | 0 | PASS |
| operating profit still reported | 34,210 | 34,210 | 0 | PASS |
| allocation INV-001 | 0 | 0 | 0 | PASS |
| allocation INV-002 | 0 | 0 | 0 | PASS |
| allocation INV-003 | 0 | 0 | 0 | PASS |

### S5-single-investor

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| sole investor distribution | 19,499.70 | 19,499.70 | 0 | PASS |

### S8-distributions

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| Σ allocations = investor pool | 19,499.70 | 19,499.70 | 0 | PASS |
| INV-001 40% | 7,799.88 | 7,799.88 | 0 | PASS |
| INV-002 35% | 6,824.895 | 6,824.895 | 0 | PASS |
| INV-003 25% | 4,874.925 | 4,874.925 | 0 | PASS |
| INV-002 pending | 3,824.895 | 3,824.895 | 0 | PASS |
| INV-003 pending | 4,874.925 | 4,874.925 | 0 | PASS |
| active participation total | 1 | 1 | 0 | PASS |
| investor-scoped rows | 1 | 1 | 0 | PASS |

### S6-partial-payout

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| expected payout (fee entered) | 17,850 | 17,850 | 0 | PASS |
| expected payout (fee estimated 18%) | 12,300 | 12,300 | 0 | PASS |
| pending receivables | 7,850 | 7,850 | 0 | PASS |

### S7-blocked-unit

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| active units | 3 | 3 | 0 | PASS |
| available nights (30 × 3) | 90 | 90 | 0 | PASS |
| RevPAR on 90 nights | 500 | 500 | 0 | PASS |

### property filter

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| HYD-501 net revenue | 22,250 | 22,250 | 0 | PASS |
| HYD-501 direct OpEx | 2,000 | 2,000 | 0 | PASS |
| HYD-501 profit | 20,250 | 20,250 | 0 | PASS |
| HYD-501 occupied nights | 5 | 5 | 0 | PASS |
| HYD-501 ADR | 5,000 | 5,000 | 0 | PASS |
| Σ direct OpEx + COMMON = total OpEx | 4,680 | 4,680 | 0 | PASS |
| Σ property net revenue = month net revenue | 38,890 | 38,890 | 0 | PASS |

### platform filter

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| Airbnb gross (25000+1000+8000) | 34,000 | 34,000 | 0 | PASS |
| Airbnb fees (3750+1200) | 4,950 | 4,950 | 0 | PASS |
| Airbnb net | 29,050 | 29,050 | 0 | PASS |
| Airbnb bookings | 2 | 2 | 0 | PASS |
| Booking.com net | 9,840 | 9,840 | 0 | PASS |
| Σ platform net = month net revenue | 38,890 | 38,890 | 0 | PASS |
| filtered rows | 1 | 1 | 0 | PASS |

### FY totals

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| FY net revenue (10k+50k+20k) | 80,000 | 80,000 | 0 | PASS |
| FY operating expenses | 55,000 | 55,000 | 0 | PASS |
| FY operating profit | 25,000 | 25,000 | 0 | PASS |
| FY occupancy (no bookings) | 0 | 0 | 0 | PASS |

### FY window

| Metric | Sheet / V1 | TypeScript | Difference | Result |
|---|---:|---:|---:|---|
| first FY month | 2026-04 | 2026-04 | 0 | PASS |
| last FY month | 2027-03 | 2027-03 | 0 | PASS |

## L1 contract — generated TS contract matches the V1 registry exactly

62 contract checks, 0 failed. Sheet names, all 261 columns (key, header, order, input/calculated role), 31 dropdown lists, every 99_CALC row address and the 12-month layout.

---

## Method

- **L1** evaluates `homestay-ops/src/00_constants.gs` and compares it field by field with the generated TypeScript contract.
- **L2** loads the real V1 Apps Script modules into a sandboxed Spreadsheet mock, writes the same fixture into that workbook, and asks V1’s own recomputation routines for their numbers. Those routines were written independently of this engine.
- **L3** compares both against values computed by hand from the fixture, so two implementations agreeing on a wrong number is still caught.
- **LIVE** reads a real spreadsheet through the service-account adapter and compares against what Google’s formula engine produced: the 99_CALC monthly block, the report-month KPI scalars, the per-property, per-platform and per-category blocks, the 08_RENT obligation columns, and every calculated column on 04_RESERVATIONS, 05_REVENUE and 06_EXPENSES. Read-only; `CFG_REPORT_MONTH` is read, never written.

Fixtures use a fixed financial year (2026-04-01) so the offline report is reproducible on any machine on any day.
