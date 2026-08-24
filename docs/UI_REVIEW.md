# GATE A — Human UI Review

The automated gate proves structure, content and accessibility. It does not prove the
screens look right. This document exists so a person can decide that.

**The design has not been changed for this gate.** One defect was found and fixed — the
app did not run in a browser at all (see §4). Everything else is exactly what Phase 4
shipped.

---

## 1. Run it

```bash
cd homestay-web
npm install
npm run dev
```

The app starts on **http://localhost:3000**. To match the port used in the verification
below, run it on 3210 instead:

```bash
npm run dev -- --port 3210
```

Nothing else is required. No credentials, no Google account, no Supabase. The app is on
fixture data (`LIVE_DATA_ENABLED=false`) and every screen says so.

Stop it with `Ctrl+C`.

---

## 2. The eleven URLs

| # | URL | What it is |
|---|---|---|
| 1 | http://localhost:3210/admin/dashboard | 14 KPIs, unit board, TODAY strip, 4 charts |
| 2 | http://localhost:3210/admin/properties | The 4-unit register |
| 3 | http://localhost:3210/admin/reservations | Bookings for the selected month |
| 4 | http://localhost:3210/admin/operations/today | Arrivals, departures, turnovers, tickets, stock |
| 5 | http://localhost:3210/admin/finance/revenue | Revenue ledger |
| 6 | http://localhost:3210/admin/finance/expenses | Operating expenses |
| 7 | http://localhost:3210/admin/finance/pnl | Monthly P&L, FY to date |
| 8 | http://localhost:3210/admin/investors | Capital register |
| 9 | http://localhost:3210/admin/investors/distributions | Waterfall — **CONFIGURATION REQUIRED** |
| 10 | http://localhost:3210/admin/analytics/performance | Monthly KPI table + trend charts |
| 11 | http://localhost:3210/admin/ai | Copilot placeholder (Phase 7) |

Three more exist and are worth a glance: `/admin/finance/cashflow`,
`/admin/investors/reports`, `/admin/settings`.

Every one of the 14 returns HTTP 200 and renders real content.

---

## 3. What to look at

Structure and content are already verified. These are the judgements a person has to make.

**Everywhere**
- Does it look like an operations tool a business would actually use, or like a demo?
- Density: too airy on a 1440px screen? too tight on a laptop?
- The serif is for identity and headline numbers only. Does that read as deliberate?
- Indian digit grouping throughout (₹2,27,605). Correct everywhere it appears?
- **DEMO DATA** badge in the header — unmissable, or does it fade into the chrome?

**Dashboard**
- 14 KPI cards. Too many for one screen? Is the ordering the order *you* scan in?
- The unit board flags a best and a weakest performer. Useful, or presumptuous?
- Four charts, hand-built. Do they read at a glance? Are the axes legible?
- The TODAY strip colours: amber = needs attention, red = urgent. Right thresholds?

**Investors ▸ Distributions**
- This is the screen that shows **CONFIGURATION REQUIRED** rather than ₹0. Does it read
  as "not set up yet" rather than "nothing to distribute"? That distinction is the point.

**P&L**
- Twelve columns plus a total. Does it scroll comfortably, or does it fight you?
- Are subtotals and totals distinguishable without reading the labels?

**Settings**
- The business rules are all TBD by design. Is that visibly a *pending decision* rather
  than a broken screen?

**Responsiveness** — resize to roughly 375px wide. Sidebar collapses to a menu button;
tables scroll inside their own container rather than pushing the page sideways.

**Dark mode** — the app follows your OS setting. Both themes are defined; worth a look at
whichever you did not just review.

### If something is wrong

Note the URL, what you expected, and what you saw. Design changes are cheap right now and
expensive after live data lands.

---

## 4. What was found and fixed

**The application did not run in a browser.** Every admin page threw
`A server-only module was imported into client code` on hydration, and the React tree
never mounted — the dev overlay covered the screen.

The cause: `AppShell` is a client component and imported `capabilitiesFor` from
`lib/server/auth/roles.ts` to decide which navigation entries to render. Every module under
`lib/server/**` carries a guard that throws in a browser. The guard was doing its job; the
import should never have been there.

It survived Phase 4 because nothing in Phase 4 opened a browser. Server rendering succeeds
— the guard only fires client-side — so `curl` returned complete, correct HTML for all 16
routes and the design gate passed 18/18. Every automated check was green while the app was
unusable. That is precisely the gap this gate exists to close.

**Fix:** the role/capability model moved to `lib/shared/roles.ts`. It is data and pure
functions with nothing secret in it, and navigation legitimately needs it.
`lib/server/auth/roles.ts` re-exports it for server consumers and keeps its guard, so no
other file changed.

**Regression test:** `tests/security.test.ts` now walks the real import graph from every
`'use client'` entry point — following aliased imports, relative imports and re-export
chains — and fails if any server module is reachable by a value import. It was verified by
reintroducing the defect and watching it fail with the offending path named:

```
components/shell/AppShell.tsx -> lib/server/auth/roles.ts
```

No design, layout, copy or colour was altered.

---

## 5. What was verified in a browser

Checked in a real browser at 1440×900:

- `/admin/dashboard` renders fully — sidebar, breadcrumb, DEMO DATA badge, filter bar,
  14 KPI cards, TODAY strip.
- `/admin/analytics/performance` renders both charts and the monthly KPI table.
- Navigating `reservations → finance/pnl → settings` produces **zero console errors**.
- All 14 admin routes return HTTP 200.

**Screenshots are not attached.** The browser in this environment renders at a scale too
small to judge typography, spacing or colour. It was enough to confirm the pages mount and
the layout is structurally right; it is not enough to sign off on how they look. That
judgement is yours, which is what §3 is for.

---

## 6. Known cosmetic gaps

Neither is a bug; both are waiting on inputs from you.

1. **The logo is not in the repository.** The shell shows a typographic lockup with a
   neutral placeholder mark. Drop the artwork into `public/brand/` and it appears — no code
   change (Gate B).
2. **The signed-in user is "Demo Administrator".** Real identity arrives with Supabase.
   The app refuses to start with live data while auth is unconfigured, so this cannot leak
   into production.
