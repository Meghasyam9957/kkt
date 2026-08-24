# Srivillu DEMO / UAT — Cloud Provisioning Runbook

This document walks you through provisioning the Phase D demo/UAT cloud resources **by
hand**: a demo Google workbook, a service account that can reach it, a demo Supabase
project, and the `.env.local` that ties them together. Nothing in this document is
executed by the application — you do every step yourself, once.

**Everything provisioned here is fictional and demo-only.** No production workbook,
production Supabase project, or real business data is touched at any point. If a step
ever seems to be pointing you at a production resource, stop — you are in the wrong
place.

Once provisioned, the demonstration itself is scripted in
[DEMO_RUNBOOK.md](DEMO_RUNBOOK.md). This document gets you to the point where that one
takes over.

**Total time: roughly 60–90 minutes, most of it waiting for the workbook builder.**

| Section | What you provision | Time |
|---|---|---|
| 1 | Demo Google workbook (V1 system + fictional data) | ~30–45 min, mostly waiting |
| 2 | Google Cloud service account + key | ~10 min |
| 3 | Share the workbook with the service account | ~2 min |
| 4 | Demo Supabase project | ~10 min |
| 5 | Apply the migrations | ~5 min |
| 6 | Write `.env.local` | ~5 min |
| 7 | Hand-off checks | ~10 min |

---

## 1 · The demo Google workbook (~30–45 min, mostly waiting)

You are creating a **new, dedicated demo copy** of the V1 workbook in your own Google
account. It must never be the production workbook, and its title must say so: the write
spikes in Section 7 **refuse to run** unless the workbook title contains `demo`, `test`,
`copy` or `uat` (case does not matter).

1. **Create a blank Google Sheet** — go to `sheets.new` in your browser.
2. **Title it** `Srivillu HomestayOps — DEMO/UAT` (click "Untitled spreadsheet" and
   type). Any title works as long as it contains one of the four safety words; this one
   is unambiguous at a glance.
3. **Open the script editor** — menu **Extensions ▸ Apps Script**.
4. **Paste the code** — delete the placeholder `function myFunction() {}`, then paste the
   **entire contents** of
   `homestay-ops/dist/HomestayOps_ALL_IN_ONE.gs`
   into the editor and press **Ctrl+S** to save.
5. **Run the builder** — in the toolbar function dropdown choose **`setupWorkbook`**,
   click **▶ Run**. Google asks for authorization the first time — review and allow. Two
   things it asks for are expected: permission to edit this spreadsheet, and permission
   to create a **trigger** — that trigger is how the builder continues itself across
   executions, and it removes itself when the build finishes.
6. **Wait — and do not press Run again.** The build makes roughly 4,500 spreadsheet
   calls and Google kills any single Apps Script execution at six minutes, so the
   builder checkpoints its place, schedules itself, and carries on by itself. Allow
   **5–15 minutes of wall clock**. You can close the browser; it continues without you.

   While it runs:
   - A **Setup Progress** tab shows the phase it is on (*Phase 3 of 8 — Building
     transaction sheets*). It **removes itself when the build is finished** — that, plus
     a *Done* toast, is how you know it has completed.
   - The script editor will say **"Execution completed"** several times along the way.
     That means one leg finished, not the whole build. Go by the Setup Progress tab.

   **If it times out or looks stuck:** do nothing for a minute or two first — the
   continuation trigger fires on its own and resumes from the exact step it stopped at,
   including after a hard kill. If the Setup Progress tab genuinely stops moving:
   reload the spreadsheet tab, open **🏠 Homestay Ops ▸ Setup status** to see the phase,
   the last step, and any error, then **🏠 Homestay Ops ▸ Resume setup** to restart the
   stalled build from where it stopped. Nothing already built is lost. Never run
   `setupWorkbook` a second time on a workbook you want to keep — a full re-run rebuilds
   every sheet.
7. **Reload the spreadsheet tab** so the **🏠 Homestay Ops** menu appears.
8. **Seed the fictional dataset** — menu **🏠 Homestay Ops ▸ Seed FICTIONAL test data**
   (the underlying function is `seedTestData`; running it from the Apps Script function
   dropdown does the same thing). Confirm the *"Overwrites current entries with
   FICTIONAL test data"* prompt with **Yes**. This fills the workbook with clearly
   fictional records: sample business rules in `02_SETTINGS`, three investors
   (INV-001/002/003) in `11_INVESTORS`, ~14 reservations, plus revenue, expenses, capex,
   rent, assets, housekeeping, maintenance, inventory, compliance, monthly-close,
   distribution and cash-flow rows — all with dates relative to today.
9. **Sanity-check the tabs.** You should see, left to right:

   `01_DASHBOARD` · `02_SETTINGS` · `03_PROPERTIES` · `04_RESERVATIONS` · `05_REVENUE` ·
   `06_EXPENSES` · `07_CAPEX_SETUP` · `08_RENT_FIXED_COSTS` · `09_CASH_FLOW` ·
   `10_MONTHLY_PNL` · `11_INVESTORS` · `12_INVESTOR_DISTRIBUTIONS` · `13_HOUSEKEEPING` ·
   `14_MAINTENANCE` · `15_INVENTORY` · `16_ASSETS` · `17_COMPLIANCE` ·
   `18_MONTHLY_CLOSE` · `19_ANALYTICS` · `20_QA_CHECKS` · `21_SYSTEM_GUIDE`

   (`99_CALC` is a hidden calculation sheet — View ▸ Hidden sheets shows it; leave it
   alone.) Open `01_DASHBOARD` and `10_MONTHLY_PNL` and confirm they show figures, not
   blanks.

---

## 2 · The Google Cloud service account (~10 min)

The web app reads (and, in the spikes, writes) the demo workbook as a **service
account** — a machine identity with its own email address and key file. It needs **no
IAM roles**; its only access will be the explicit share in Section 3.

1. Go to **console.cloud.google.com** and sign in with the same Google account that owns
   the workbook.
2. **Create a new project** — the project picker (top bar) ▸ **New project**. Name it
   `srivillu-demo`. Wait for it to create, then make sure it is the selected project.
3. **Enable the Sheets API** — search for **"Google Sheets API"** in the console search
   bar, open it, click **Enable**.
4. **Create the service account** — navigation menu ▸ **IAM & Admin ▸ Service
   Accounts** ▸ **Create service account**. Name it something recognisable, e.g.
   `srivillu-demo-reader`. When asked to grant roles, **grant none** — skip both
   optional steps and finish.
5. **Create a key** — open the service account you just created ▸ **Keys** tab ▸
   **Add key ▸ Create new key ▸ JSON** ▸ **Create**. A `.json` file downloads.
6. **Move the key file OUTSIDE the repository** — e.g. `C:\Users\User\secrets\
   srivillu-demo-key.json`. It is a password in a file. **Never commit it, never copy it
   into the project tree**, not even temporarily.
7. **Base64-encode it** for the environment file. In PowerShell:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\User\secrets\srivillu-demo-key.json"))
   ```

   Copy the (long, single-line) output — it becomes
   `DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` in Section 6.
8. **Note the service account's email** — it is the `client_email` field inside the
   JSON file, and also shown on the service account's page. It looks like
   `srivillu-demo-reader@srivillu-demo.iam.gserviceaccount.com`. You need it next.

---

## 3 · Share the workbook with the service account (~2 min)

1. Open the demo workbook ▸ **Share** (top right).
2. Paste the service account's `client_email` address.
3. Set the role to **Editor** — the write spikes in Section 7 create and clear real rows,
   which Viewer access cannot do.
4. **Untick "Notify people"** (a robot does not read email), then **Share/Send**.

That share is the service account's entire access. It can touch this one workbook and
nothing else in your Drive — which is exactly the point.

---

## 4 · The demo Supabase project (~10 min)

This project holds identity, sessions, audit and operation state — **no business data**
(that rule is written into the migration headers). It must be a **new project used for
nothing else. Never the production project, and never a project shared with anything
else.** Everything in it is disposable.

1. Go to **supabase.com**, sign in, and create a **New project**.
2. Name it `srivillu-demo`. The **free tier is fine**. Choose a region near Hyderabad.
   Supabase asks for a database password — let it generate one; you will not need it for
   anything in this runbook.
3. Wait for the project to finish provisioning (a minute or two).
4. Collect the three credentials from **Settings ▸ API**:

   | What | Where on the API settings page | Becomes |
   |---|---|---|
   | Project URL | "Project URL" — `https://<ref>.supabase.co` | `DEMO_SUPABASE_URL` |
   | `anon` key | Project API keys — the public/anon key | `DEMO_SUPABASE_ANON_KEY` |
   | `service_role` key | Project API keys — the service_role key (click reveal) | `DEMO_SUPABASE_SERVICE_ROLE_KEY` |

   The `service_role` key bypasses row-level security. It is server-side only — the
   security suite fails the build if it appears anywhere a browser could reach — but
   treat it like the key file: never commit it, never paste it anywhere except
   `.env.local`.

---

## 5 · Apply the migrations (~5 min)

Run two of the three migration files by hand, in order, in the Supabase **SQL Editor**:

1. **SQL Editor ▸ New query** → paste the entire contents of
   `supabase/migrations/0001_identity_audit_ids.sql` → **Run**. This creates the
   identity, audit and atomic-ID schema.
2. **New query** → paste the entire contents of
   `supabase/migrations/0003_operations.sql` → **Run**. This creates the mutation
   operation-state (idempotency) table.

**Do NOT run `0002_demo_identities.sql` by hand.** That file's manual flow (invite four
users, copy four UUIDs, edit placeholders) is superseded in this phase:
`node scripts/demo-users.mjs` (added in this phase) creates the four demo auth users
**and** their `app_users` rows automatically using the service-role key, generating
their passwords rather than hard-coding them anywhere. You run it after `.env.local`
exists; the placeholders in 0002 are deliberately invalid UUIDs precisely so the file
cannot be applied blindly.

---

## 6 · Write `.env.local` (~5 min)

Create `homestay-web/.env.local` (it is git-ignored) with exactly this shape:

```
# ---- DEMO / UAT only. No PRODUCTION_* variable may appear in this file. ----
APP_ENV=demo

# false until the six write spikes pass (Section 7). Then, and only then, true.
LIVE_DATA_ENABLED=false

DEMO_GOOGLE_SHEET_ID=<the workbook id — see below>
DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<the base64 string from Section 2 step 7>

DEMO_SUPABASE_URL=https://<ref>.supabase.co
DEMO_SUPABASE_SERVICE_ROLE_KEY=<service_role key from Section 4>
DEMO_SUPABASE_ANON_KEY=<anon key from Section 4>
DEMO_SUPABASE_AUTH_COOKIE=sb-<ref>-auth-token
```

**Reading the workbook id out of the URL:** open the demo workbook and look at the
address bar —

```
https://docs.google.com/spreadsheets/d/THIS_LONG_STRING_IS_THE_ID/edit#gid=0
```

everything between `/d/` and the next `/` is `DEMO_GOOGLE_SHEET_ID`.

`<ref>` in the two Supabase lines is the project reference — the subdomain of your
Project URL.

**No `PRODUCTION_*` variables may be present in this file.** The isolation is
structural — a demo deployment has no code path that reads a `PRODUCTION_` variable —
but keeping them out of the file entirely means there is nothing to leak and nothing to
mix up. `.env.example` documents the full variable catalogue; this file gets the DEMO
block only.

With `.env.local` in place, create the four demo users:

```bash
cd homestay-web
node scripts/demo-users.mjs
```

---

## 7 · Hand-off checks (~10 min)

Four checks, in order. All four passing is the definition of "provisioned".

**1 — The structural preflight** (read-only).

```bash
cd homestay-web
npm run demo:preflight
```

This verifies the workbook is the one the application expects: every contract tab, all
required named ranges, header rows in the contract's positions, seeded records, live
calculated columns, and sheet protections. It must end **`VERDICT: PASS`**. If it fails,
fix the workbook (usually by re-running the seeder), not the preflight.

**2 — The six write spikes.**

```bash
npm run demo:spikes
```

This runs the six live write experiments against the demo workbook (and only ever the
demo workbook — it refuses production ids, refuses `APP_ENV=production`, and refuses any
workbook whose title does not contain demo/test/copy/uat): blank-row landing, date
serial encoding, type encoding, calc refresh after write, calc-column protection, and
ten simultaneous writes. Every spike row is labelled `SPIKE` and cleared at the end, so
the workbook stays presentable.

The report must end **`VERDICT: ALL SPIKES PASS`**. Until it does, `LIVE_DATA_ENABLED`
stays `false`. Once it does, flip `LIVE_DATA_ENABLED=true` in `.env.local` — and then
**capture the seed snapshot**, while the workbook is still exactly as the seeder left it:

```bash
npm run demo:snapshot
```

That snapshot (`.demo/seed-snapshot.json`, git-ignored) is the state the admin-only
**Reset demo environment** control restores. Without it, the reset refuses to run —
there is nothing trusted to restore to.

**3 — The app runs.**

```bash
npm run dev
```

Open the printed localhost URL. With `LIVE_DATA_ENABLED=true` the header should read
**Data source: Demo Workbook**.

**4 — Real sign-in.** With the demo Supabase project configured, the sign-in page shows
a **real email/password form** — the passwordless identity chooser is gone. Sign in as
one of the four demo accounts (credentials from the `demo-users.mjs` run) and confirm
you land on the right screen for the role.

**Optionally, prove the whole thing in one command.** The Phase D real-demo browser
suite runs every workflow against this environment end to end — sign-ins, creates,
lifecycle, isolation, the ₹4,321 dashboard arithmetic, and the reset:

```bash
$env:DEMO_E2E_ADMIN_PASSWORD="…"; $env:DEMO_E2E_OPERATIONS_PASSWORD="…"
$env:DEMO_E2E_INVESTOR_A_PASSWORD="…"; $env:DEMO_E2E_INVESTOR_B_PASSWORD="…"
npm run e2e:real
```

(The passwords are the ones `demo-users.mjs` printed; they are read from the environment
only and appear in no file. Without the demo workbook live, every test in this suite
skips as PENDING rather than passing against fixtures.)

From here, the demonstration itself is [DEMO_WALKTHROUGH.md](DEMO_WALKTHROUGH.md), with
operator details in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).

---

## Final checklist

- [ ] Demo workbook exists, titled with DEMO/UAT, built by `setupWorkbook`, Setup Progress tab gone
- [ ] **🏠 Homestay Ops ▸ Seed FICTIONAL test data** run; dashboard and P&L show figures
- [ ] All 21 visible tabs present (`01_DASHBOARD` … `21_SYSTEM_GUIDE`)
- [ ] Google Cloud project `srivillu-demo` with Sheets API enabled
- [ ] Service account created, **no roles**, JSON key downloaded
- [ ] `key.json` stored **outside** the repository; never committed
- [ ] Key base64-encoded into `DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
- [ ] Workbook shared with the service account's `client_email` as **Editor**, notify unticked
- [ ] New Supabase project `srivillu-demo`, used for nothing else
- [ ] Migrations `0001` and `0003` applied in the SQL Editor; `0002` **not** run by hand
- [ ] `.env.local` written — DEMO block only, **no `PRODUCTION_*` variables**
- [ ] `node scripts/demo-users.mjs` created the four demo accounts
- [ ] `npm run demo:preflight` → **VERDICT: PASS**
- [ ] `npm run demo:spikes` → **ALL SPIKES PASS**
- [ ] Only then: `LIVE_DATA_ENABLED=true`
- [ ] `npm run demo:snapshot` captured the seed (enables the admin reset)
- [ ] `npm run dev` → email/password sign-in works for a demo account
