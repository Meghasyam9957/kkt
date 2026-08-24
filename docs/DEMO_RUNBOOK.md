# Srivillu DEMO / UAT — Operator and Demonstration Runbook

Everything here runs on fictional data. No real guest, investor, payment or workbook is
involved at any point.

---

## Part 1 — Run the demo locally (5 minutes)

```bash
cd homestay-web
npm install
npm run dev -- --port 3210
```

Open **http://localhost:3210**. You are redirected to sign-in.

That is all the configuration required. No Google account, no Supabase project, no
credentials. `APP_ENV` defaults to `demo` and `LIVE_DATA_ENABLED` defaults to `false`, so
the app generates its own dataset.

To be explicit about it, create `.env.local`:

```
APP_ENV=demo
LIVE_DATA_ENABLED=false
```

### The four demonstration accounts

No passwords. The chooser lists them; click one.

| Account | Role | What it shows |
|---|---|---|
| `admin.demo` | ADMIN | Everything internal: dashboard, finance, investors, analytics, audit |
| `operations.demo` | OPERATIONS | The day-to-day board. No financial figures, no investor screens |
| `investor.demo.a` | INVESTOR · INV-001 | 40% participation, ₹12,00,000 |
| `investor.demo.b` | INVESTOR · INV-002 | 35% participation, ₹10,50,000 |

Use **Switch** in the top-right to change account mid-demonstration.

> **The demo chooser is not authentication.** It asks for no password, and anyone who can
> set a cookie on the demo host can become any of these four. That is acceptable because
> everything behind them is fictional — and it is why production has no such path at all.
> Configure the demo Supabase project (Part 4) to replace the chooser with real sign-in.

---

## Part 2 — The demonstration script (about 15 minutes)

### 0 · Before you start

Sign in as **admin.demo** → **Demonstration ▸ Demo controls** → **Reset demo environment**.
This guarantees a known starting state whatever the last demo did.

### 1 · The dashboard — "everything here is calculated" (3 min)

**admin.demo → Dashboard.**

- Note the **DEMO / UAT** badge, the **Environment**, the **Data source** and **Last synced**
  in the header. That strip appears on every internal page.
- Fourteen KPIs for the current month. **Nothing on this screen is typed in.** Every figure
  is computed from the demo ledger by the same engine that will read the real workbook.
- The **reporting month** picker holds ten months. Two are missing on purpose — August 2026
  and March 2027 — because the business did not trade in them. Say so; it demonstrates that
  the empty state is real rather than decorative.
- Scroll to the unit board: four units, each with its own status, and the strongest and
  weakest performer flagged.

> If someone asks why the margin looks high: the current month is 19 days in. Revenue is
> recognised at checkout while costs accrue across the month, so a month-to-date margin
> runs ahead of the full-month figure. The workbook behaves the same way.

### 2 · Scenario switching — "the same system, a different day" (3 min)

**Demonstration ▸ Demo controls.**

| Switch to | Then open | What has changed |
|---|---|---|
| **High occupancy** | Dashboard | All four units occupied; occupancy jumps to ~95% |
| **Operations issue** | Operations ▸ Today | A critical leak takes HYD-501 off-market, a failed inspection, three low-stock lines |
| **Guest support** | Operations ▸ Today | Four open guest requests instead of one |
| **Financial review** | Finance ▸ P&L | Last month's ₹96,500 structural repair and the margin it cost |
| **Investor review** | Investors ▸ Distributions | The waterfall with a distribution already paid |

The point to make: switching a scenario **adds records**, and every figure recomputes from
them. It is not a set of alternative screens.

### 3 · The operations view — "a different job, a different system" (2 min)

**Switch → operations.demo.**

- The navigation is much shorter: Today, Properties, Reservations, Housekeeping,
  Maintenance, Inventory. No Finance. No Investors. No Settings.
- Now type `/admin/finance/pnl` in the address bar. It says **"Not available for your
  role."** This is the point worth dwelling on: the menu is a convenience, and the refusal
  happens on the server whether or not the link was ever shown.

### 4 · The investor view — "they see their own position, and nothing else" (4 min)

**Switch → investor.demo.a.**

- The investor lands on **Portfolio**. One screen. No operations, no guests, no expenses,
  no other investor.
- Anand Rao: **₹12,00,000 capital, 40% participation**, and a calculated distribution.
- Try `/admin/dashboard` in the address bar — **not available for your role**.
- Now try `/admin/portfolio?investorId=INV-002`. **Still Anand's figures.** The page never
  accepts an investor id from the request; it reads it from the session.

**Switch → investor.demo.b.** Meera Krishnan: **₹10,50,000, 35%**, a different
distribution. Two investors, two sets of figures, no route between them.

### 5 · The guest journey — "a request becomes work" (3 min)

**Switch → admin.demo → Demonstration ▸ Guest journey.**

- Five steps: check-in, stay information, a question, a help request, operations sees it.
- Every response is a fixed fixture. **No AI is enabled in this phase** — say so plainly.
- Press **Raise the guest request**, then open **Operations ▸ Today**. The guest-request
  counter has increased. It is a real record in the dataset, not a message on a screen.

### 6 · Close (1 min)

Return to **Demo controls** and reset. Point out the sentence on the confirmation: *"This
resets fictional demonstration data only."* There is no equivalent control in production,
by design.

---

## Part 3 — What the demo year contains

Twelve months from April 2026, deliberately uneven.

| Month | What it is | Why it is there |
|---|---|---|
| Apr 2026 | Ramp-up — 20% occupancy, **a loss** | A new operation does lose money at first |
| May–Jul | Normal trading, 57–65% | The baseline |
| **Aug 2026** | **Dormant — no data at all** | The empty state has to be reachable from real records |
| Sep 2026 | Thin re-opening, 22% — **a loss** | The "not enough data to forecast" state |
| Oct–Dec | Festive peak, up to 91% | Shows the system under load |
| Jan 2027 | Winter trading, profit squeezed | Carries the ₹96,500 repair |
| Feb 2027 | **The current month**, traded to the 19th | Month-to-date behaviour |
| **Mar 2027** | **Not yet reached — no data** | Future months are empty, not zero |

Also present as real records: a cancellation, a **payout ₹2,600 short of expectation**, an
arrival today, a departure today, low stock, an open critical ticket, and investor
distributions actually paid.

---

## Part 4 — Provisioning the demo Supabase project (optional)

Only needed to replace the identity chooser with real sign-in.

1. **supabase.com ▸ New project**, named `srivillu-demo`. Choose a region near Hyderabad.
2. **SQL Editor** → run `supabase/migrations/0001_identity_audit_ids.sql`.
3. **Authentication ▸ Users ▸ Invite user** for each of the four demo addresses:
   `admin.demo@srivillu.demo`, `operations.demo@srivillu.demo`,
   `investor.demo.a@srivillu.demo`, `investor.demo.b@srivillu.demo`.
   Each person sets their own password from the invitation link. **Do not set passwords
   here and do not put them in a file.**
4. Copy the four user ids Supabase created.
5. **SQL Editor** → open `supabase/migrations/0002_demo_identities.sql`, replace the four
   placeholder UUIDs with the real ids, and run it.
6. **Settings ▸ API** → copy the project URL, the `anon` key and the `service_role` key.
7. Add to `.env.local`:

   ```
   DEMO_SUPABASE_URL=https://<ref>.supabase.co
   DEMO_SUPABASE_SERVICE_ROLE_KEY=<service role key>
   DEMO_SUPABASE_ANON_KEY=<anon key>
   DEMO_SUPABASE_AUTH_COOKIE=sb-<ref>-auth-token
   ```

8. Restart. The sign-in screen now asks for an email and a password; the chooser is gone.

> The service-role key is server-side only. It is read in `lib/server/**`, and the security
> suite fails the build if it appears anywhere a browser could reach.

---

## Part 5 — Provisioning the demo workbook (optional)

Only needed to demonstrate against a real Google Sheet rather than the generated dataset.

1. Deploy V1 into a **new** spreadsheet — `homestay-ops/dist/HomestayOps_ALL_IN_ONE.gs`,
   run `setupWorkbook`. Name it `Srivillu Ops — DEMO`.
2. 🏠 Homestay Ops ▸ **Seed FICTIONAL test data**.
3. Share it with the demo service account as **Editor** — Phase D writes through it
   (spikes, demo workflows, the reset), so Viewer is not enough.
4. Add to `.env.local`:

   ```
   DEMO_GOOGLE_SHEET_ID=<demo spreadsheet id>
   DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<base64 of the demo key.json>
   LIVE_DATA_ENABLED=true
   ```

   Flip `LIVE_DATA_ENABLED` to `true` only after `npm run demo:preflight` and the six
   write spikes (`npm run demo:spikes`) pass — the full order is in
   [DEMO_PROVISIONING.md](DEMO_PROVISIONING.md).

5. Restart. The header now reads **Data source: Demo Workbook**.

> **Three separate workbooks, always.** Demo, production, and the LIVE parity copy. The
> application refuses to start if `DEMO_GOOGLE_SHEET_ID` and `PRODUCTION_GOOGLE_SHEET_ID`
> are the same id.
>
> With `LIVE_DATA_ENABLED=true` the demo reads its workbook, and **scenario switching and
> reset no longer change what is on screen** — they operate on the generated dataset. Use
> one mode or the other for a demonstration, not both.

---

## Part 6 — Troubleshooting

**"Not available for your role"** — working as intended. You are signed in with a role that
does not use that screen. Use **Switch** to change account.

**Sign-in loops back to the sign-in page** — the session cookie is not being kept. Use
`http://localhost:3210` rather than `127.0.0.1`, and check that cookies are not blocked.

**The dashboard shows a month with no data** — a scenario reset returns the reporting month
to the current one. Pick a month from the picker; August 2026 and March 2027 are
deliberately empty.

**A demonstration left stray records behind** — Demo controls ▸ Reset. It rebuilds the
dataset from seed, so the result is identical every time.

**Everything reset itself on its own** — demo state lives in the server process, so
restarting `npm run dev` resets it. That is intended for a demonstration environment.
