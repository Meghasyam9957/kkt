# Phase 5B — UAT / Client Demonstration Hardening

```
typecheck        CLEAN (strict, noUncheckedIndexedAccess)
lint             ✔ no ESLint warnings or errors
tests            538 passed, 2 skipped, 0 failed — 18 suites (was 504)
build            ✓ 27 routes
V1 integrity     PASS — 0 errors, 0 warnings; 1,837 formulas
OFFLINE parity   PASS 212/212
LIVE parity      PENDING — not run
OVERALL          PENDING
APP_ENV=demo · LIVE_DATA_ENABLED=false
```

# LIVE PARITY PENDING

Unchanged, as instructed. This system is **not** production ready.

---

## The defect this phase found

**Three screens read the demo fixtures directly, behind the provider's back.**
`Today`, `Properties` and `Investors` imported `buildDemoOps`, `DEMO_PROPERTIES` and
`DEMO_INVESTORS` from `lib/data/fixtures/`. In a production deployment those pages would
have rendered **fictional maintenance tickets, unit details and investors on live screens**.

Phase 5A's nine environment invariants did not catch it, and could not have: they test the
*provider*, and these three pages never called it. The isolation was real everywhere the
data flowed through the architecture, and absent in the three places that stepped around it.

**Fixed.** The provider contract gained `getOperations()` and `getInvestorRegister()`, and
`getProperties()` now returns the unit master alongside performance. All three pages read
through the provider like every other screen.

**Test added:** no file under `app/` or `components/` may import `lib/data/fixtures` or
`lib/data/demo` — the demonstration screens excepted, since they exist only in demo. I
verified it catches the regression by reintroducing one import and watching it name the
file.

That is the second time a boundary held everywhere the architecture was followed and failed
where something bypassed it. Both times the fix was the same: make the bypass impossible to
write, not merely wrong to write.

---

## 1 · UAT checklist

`docs/UAT_CHECKLIST.md` — 70 numbered steps, written for someone with no technical
background. Seven sections: **ADMIN** (20), **OPERATIONS** (16), **INVESTOR** (14),
**SECURITY** (8), **DATA** (10), **UX/UI** (8), **DEMO ENVIRONMENT** (17). Every step has
action, expected result, pass/fail and notes.

Three things it does deliberately:

- **Opens by saying nothing can be broken.** A tester who is afraid of the system tests it
  timidly.
- **Includes judgement questions**, not just mechanical ones — *"Would this help you run
  the four units each morning? What is missing?"* The Operations Manager's experience is
  the most valuable thing in the exercise and a pure click-through wastes it.
- **Lists what is not built**, so nobody spends the morning reporting the absence of data
  entry as a fault.

Several steps ask the tester to type a URL directly — that is where role isolation is
actually visible to a non-technical person.

## 2 · Client demo runbook

`docs/CLIENT_DEMO_RUNBOOK.md` — a 15-minute script covering the nine steps you listed, with
timings, the words to use, and what to point at.

It includes a **before they arrive** section (reset, check the scenario, enter presentation
mode), the seven questions you should expect with plain answers, and what to do if
something goes wrong mid-demonstration.

On step 9, "future AI capabilities", it is deliberately restrained. It separates *working
today*, *next and already designed*, and *under consideration, not promised* — and says out
loud that the guest journey's answers are fixed text with no AI behind them. Promising an
assistant that does not exist would be the easiest way to lose the room later.

One passage worth knowing about in advance, because it will come up:

> **"Can we start using it on Monday?"** — Not yet, and there is one specific reason: the
> calculation engine has not been checked against the live spreadsheet.

## 3 · Demo data audit

`npm run demo:audit` prints what the dataset actually contains, computed by the real KPI
engine. Evidence, not assertion.

**Records:** 4 properties · 273 reservations · 556 revenue lines · 310 expense lines ·
10 CAPEX · 256 cash movements · 3 investors · 3 distributions · housekeeping, maintenance,
inventory, guest requests, rent, assets and compliance registers.

**The trading year — 10 of 12 months carry data:**

| | Net revenue | Operating profit | Occupancy | |
|---|---:|---:|---:|---|
| Apr 2026 | ₹23,239 | **−₹1,38,764** | 20.0% | ramp-up |
| May 2026 | ₹2,46,537 | ₹85,261 | 64.5% | |
| Jun 2026 | ₹1,87,712 | ₹24,411 | 57.5% | |
| Jul 2026 | ₹2,00,490 | ₹36,995 | 59.7% | |
| **Aug 2026** | — | — | — | **dormant, empty** |
| Sep 2026 | ₹36,732 | **−₹1,27,518** | 22.5% | too thin to forecast |
| Oct 2026 | ₹3,44,130 | ₹1,83,149 | 67.7% | peak |
| Nov 2026 | ₹4,96,752 | ₹3,35,740 | 90.8% | peak |
| Dec 2026 | ₹3,11,743 | ₹1,46,696 | 71.8% | |
| Jan 2027 | ₹2,91,518 | ₹32,015 | 70.2% | repair spike squeezes profit |
| Feb 2027 | ₹2,43,433 | ₹1,50,973 | 79.5% | current month, to the 19th |
| **Mar 2027** | — | — | — | **not yet traded** |

**Properties are not equally successful.** In the busiest month: revenue spread 1.35×,
occupancy 83.3%–100%, ADR ₹3,898–₹6,014. HYD-601 carries the highest rate and the lowest
occupancy; HYD-602 the opposite. A test enforces both spreads, so a future change cannot
flatten them without failing.

**Every condition present, verified by count:** arrivals today 1 · departures today 2 ·
cancellations 14 (≈7%) · payout mismatches 1 · open maintenance 3 · outstanding turnovers 1
· low stock 2 · open guest requests 1 · unpaid bills 2 · distributions paid 3 · **months
with a loss 2** · **empty months 2**.

**Channels:** Airbnb ₹1,63,581 (10 bookings) · Booking.com ₹1,03,771 (9) · Direct
₹2,29,400 (14).

## 4 · Security regression results

**No regression. 345 cases across the nine security-relevant suites, all passing.**

| Suite | Cases | Result |
|---|---:|---|
| RBAC matrix | 131 | pass |
| Investor isolation | 23 | pass |
| Environment isolation (the nine invariants) | 30 | pass |
| Audit logging | 18 | pass |
| Secret exposure / server boundary | 23 | pass |
| Page authorisation | 13 | pass |
| Demo environment | 52 | pass |
| Demo hardening *(new)* | 34 | pass |
| Session | 21 | pass |

**Production behaviour verified by running it**, not only by unit test. With
`APP_ENV=production` and nothing configured:

```
/admin/dashboard   HTTP 500   "Refusing to serve business data without an
                               authenticated caller" · names PRODUCTION_SUPABASE_URL
/admin/demo        HTTP 500   no demonstration controls exist
/signin            HTTP 200   password form only — no identity chooser
DEMO / UAT badge   absent on every response
Assumptions notice absent on every response
```

That is the whole production-safety claim, demonstrated rather than asserted.

## 5 · Investor demo results

Verified over HTTP with real sessions:

| | Investor Demo A | Investor Demo B |
|---|---|---|
| Capital | ₹12,00,000 | ₹10,50,000 |
| Participation | 40% | 35% |
| Calculated distribution | ₹34,422 | ₹30,119 |
| Paid | ₹46,000 | ₹40,250 |
| Names visible on their page | Anand only | Meera only |

**Isolation attempts, all refused:** `?investorId=INV-002` · `?investor=…&investorId=…` ·
`X-Investor-Id` header · `/admin/investors` direct · `/admin/dashboard` direct ·
`/admin/operations/today` direct. The page reads the investor id from the session and
references no `searchParams`, `params` or `headers()` at all — a test asserts that.

**No operational control on the investor screen.** A test asserts the file contains no
`<form>`, no `<button>` and no `action="/api…"`. An investor screen is something to read.

**The demonstration notice** appears above the figures with investor-specific wording:
*"Management has approved no terms; nothing here represents an agreement or an
entitlement."*

## 6 · Environment isolation results

All nine Phase 5A invariants still pass, plus what 5B added:

- The three fixture-reading screens are closed, and the import is now structurally
  forbidden (§ the defect).
- **DEMO / UAT** appears on every authenticated demo page, and nowhere in production —
  confirmed on a running production build.
- The assumptions notice returns `null` before reading anything when the environment is not
  demo, so production has no code path that renders it.
- Presentation mode, scenario switching and reset all throw in production.
- The scenario chip only renders for a role holding `demo.control`, in demo.

**The notice reads its percentages from the demo dataset**, never from typed-in text. A
test forbids the literals `60%`, `40%` and `5%` appearing in the component, so the notice
and the arithmetic behind the figures cannot drift apart.

## 7 · Remaining LIVE parity blocker

# LIVE PARITY PENDING

```
OFFLINE  PASS 212/212
LIVE     PENDING — never run
OVERALL  PENDING
```

Unchanged and untouched, as instructed. Nothing in this phase could move it — it needs your
Google account. Runbook: `docs/LIVE_PARITY_RUNBOOK.md`, ten sections, about 20 minutes.

The demonstration makes this more pressing, not less. You are about to show a client figures
produced by an engine that has never been compared with the spreadsheet those figures will
eventually come from.

## 8 · Running the client demonstration locally

```bash
cd homestay-web
npm install
npm run dev -- --port 3210
```

Open **http://localhost:3210**. Nothing else is required — no Google account, no Supabase,
no credentials.

**Then, before the client arrives:**

1. Sign in as **Demo Administrator** (click it; there is no password).
2. **Demonstration ▸ Demo controls** → **Reset demo environment** → confirm.
3. Check the header chip reads **Normal day**.
4. Click **Enter presentation mode** — this hides the reset so it cannot be pressed by
   accident on a shared screen.
5. Go to **Dashboard**, full screen, other tabs closed.

**During:** follow `docs/CLIENT_DEMO_RUNBOOK.md`. The script is nine steps and about
15 minutes. Use **Switch** in the top right to change role.

**Two sentences to say out loud, early:**

> "Everything here is fictional — no real guest, no real money, no real investor."
> "The investor terms on screen are illustrative. Management has approved nothing."

**One thing to be ready for:** the current month's margin looks high because the month is
only 19 days in — revenue is recognised at checkout while costs accrue across the whole
month. The workbook behaves identically. Say it before someone asks.

**Afterwards:** Demo controls → leave presentation mode → reset.

For UAT rather than a demonstration, hand the Operations Manager `docs/UAT_CHECKLIST.md`
and `docs/UAT_ISSUE_TEMPLATE.md`. They need no technical support to work through either.

---

## Also in this phase

**Today's operations was rebuilt as a presentation view.** It opens with **Needs
attention** — critical first, each item saying what happened *and* what to do — then the
counters, then arrivals, departures, unit status, turnovers, tickets, stock and requests.

**It contains no money at all.** Verified on the running page: zero currency symbols. Not
"no financial section" — no rupee sign anywhere on it. Operations holds no financial
capability, and a board that shows revenue beside a cleaning task both leaks it and pulls
attention to the wrong decision.

**Presentation mode** hides the reset and **refuses it if posted anyway** (HTTP 409), so
the hiding means something rather than being decorative. An admin can re-enable the reset
without leaving presentation mode. It survives a scenario switch and a reset — losing it
the moment someone has just reset in front of an audience is exactly the wrong time. It is
documented, in the code and on the page, as a convenience and **not** a security control;
RBAC and the environment guard remain authoritative.

**The scenario is now in the header** as a chip showing what is displayed, linking to the
switch in one click — for admins, in demo, only.

**New dependency:** `tsx` (dev-only), used by `npm run demo:audit`.

---

## Remaining blockers

**Yours:**

1. **LIVE parity has not run.** The blocker. ~20 minutes, your Google account.
2. **Neither Supabase project exists** — `docs/PHASE5A_REPORT.md` §9.
3. **The logo files are still not in `public/brand/`.** Everything is wired.
4. **The commercial terms are unapproved.** Production correctly shows CONFIGURATION
   REQUIRED; the demo uses illustrative values and labels them on every screen.
5. **UAT has not been run.** The checklist is ready; it needs the Operations Manager.

**Mine, once those unblock:**

6. The demo identity chooser needs replacing with Supabase sign-in for any demonstration
   outside a trusted room. It asks for no password by design.
7. No Refresh control in the UI. `provider.refresh()` exists and is tested.
8. ID sequences are not seeded from the workbook, and V1's "Generate missing IDs" still
   uses MAX+1. Both must be handled at cutover, before any write path exists.
9. Housekeeping, Maintenance and Inventory still point at the Today board rather than
   having their own screens.

---

**LIVE PARITY PENDING. Not production ready. Phase 6 not started, and not to be started
without your approval.**
