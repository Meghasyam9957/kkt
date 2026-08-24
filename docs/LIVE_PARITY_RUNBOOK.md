# LIVE Parity — Operator Runbook

**What this is.** A one-off check that the web application's calculations agree with the
Google Sheet's own calculations, to the paisa. Until it passes, we do not know they agree,
and nothing goes to production.

**What you need.** A Google account, about 20 minutes, and this document. You do not need
to understand the code. Most of the time is spent waiting for Google.

**Current status.**

```
OFFLINE = PASS 212/212
LIVE    = PENDING / NOT RUN
OVERALL = PENDING
```

**Two rules that never bend.**

> **The real workbook is never touched.** Everything below happens on a *copy*.
> **Nothing is ever written.** The tool only reads. The account it uses is given
> "Viewer", so it could not write even if it tried.

---

## The one command

Once set up, this is the whole workflow:

```bash
npm run parity
```

It does eleven things in order, and stops with a plain-English message the moment
something is not right:

| | It checks | If it is wrong you will see |
|---|---|---|
| 1 | the settings are filled in | which one is missing |
| 2 | the credential file works | what is wrong with it |
| 3 | it can open the workbook | who to share the sheet with |
| 4 | it is **not** the production workbook | it refuses to go further |
| 5 | all 22 tabs exist | which tabs are missing |
| 6 | all 60 named ranges exist | which ones are missing |
| 7 | the workbook has test data in it | how to add it |
| 8 | all 11 test situations exist | **exactly which one is missing, and how to create it** |
| 9 | the reporting month has data | which months do have data |
| 10 | *runs the comparison* | |
| 11 | *writes the report* | |

If any of 1–9 fails, **nothing is compared** and nothing is reported as passing.

---

# Part 1 — Setting up (once)

## Step 1. Make the parity copy

If the workbook is not yet in Google Sheets:

1. Go to **sheets.new** to create a blank spreadsheet.
2. Menu: **Extensions ▸ Apps Script**.
3. Open the file `homestay-ops/dist/HomestayOps_ALL_IN_ONE.gs`, select all of it, copy it,
   and paste it over whatever is in the script editor. Save (the disk icon).
4. In the toolbar, choose the function **setupWorkbook** and press **Run**. Approve the
   permission prompt when Google asks.
5. Wait for the **Done** message, then go back to the spreadsheet tab and reload the page.
6. You should now see 22 tabs along the bottom.

Now make the copy:

7. **File ▸ Make a copy.**
8. Name it **exactly**:

```
Srivillu Ops — PARITY COPY (do not use for business)
```

> The word **PARITY** in the title matters. The tool refuses to run against a workbook
> that does not identify itself as a copy — that is the safety catch that stops someone
> accidentally pointing it at the real thing.

9. Open the copy. Look at the web address. Copy out the long code between `/d/` and
   `/edit` — that is the **workbook id**:

```
https://docs.google.com/spreadsheets/d/1A2B3C4D5E6F7G8H9I0J/edit#gid=0
                                       └──── this part ────┘
```

## Step 2. Put test data in the copy

In the **copy**, use the menu: **🏠 Homestay Ops ▸ Seed FICTIONAL test data**.

This is not optional. Without it every number is zero on both sides, and the check would
"pass" having compared nothing at all. The tool refuses to run on an empty workbook.

> Everything it creates is invented — fake guests, fake amounts, fake investors. It exists
> to exercise the arithmetic, not to describe the business.

## Step 3. Set the reporting month

Some of the workbook's figures are calculated for whichever month is currently selected.
The tool reads that month and asks the application for the same one, so it has to point at
a month that actually has data.

1. In the **copy**, open the tab **02_SETTINGS**.
2. Find the row labelled **Report month** — the cell is the named range
   `CFG_REPORT_MONTH`.
3. Type the **first day of a month that has data** — the current month is the safe choice,
   because that is where the test data is densest. For example: `01/06/2026`.
4. Reload the page and wait a few seconds for the sheet to finish recalculating.

> **The application never writes this cell.** Choosing a month on a web page is that
> person's private view; it must never change a shared cell that everyone else is looking
> at. Changing it *by hand in a parity copy* is a different thing entirely — that is a
> person editing a test spreadsheet, and it is expected here.
>
> To check a second month later, change this cell in the copy and run `npm run parity`
> again.

If you pick a month with no data, the tool tells you so and lists the months that do have
data. It will not run.

## Step 4. Set the parity-test business values

The real commercial terms have not been agreed, so in the real workbook they are left as
**TBD**. That is correct — but it means the investor calculations are all zero, and a
comparison of zero against zero proves nothing.

So set sample values **in the copy only**.

**The easy way.** In the copy: **🏠 Homestay Ops ▸ Run financial sensitivity test**. It
sets trial values, runs, and puts the originals back automatically.

**By hand**, in **02_SETTINGS** of the copy:

| Row label | Named range | Type this | What it means |
|---|---|---|---|
| Investor pool % | `CFG_INVESTOR_POOL_PCT` | `60%` | investor share of distributable profit |
| Operator pool % | `CFG_OPERATOR_POOL_PCT` | `40%` | operator share |
| Reserve % | `CFG_RESERVE_PCT` | `5%` | held back from profit |
| Management fee % | `CFG_MGMT_FEE_PCT` | `0%` | management fee |
| Loss treatment | `CFG_LOSS_TREATMENT` | `Carry forward` | how a loss month is handled |

> ### These are PARITY-TEST VALUES
>
> They have **no commercial meaning**. Nobody has agreed to them. They exist so the
> arithmetic can be exercised.
>
> **Never type them into the production workbook.** If you set them by hand here, set them
> back to `TBD` when you are done — or simply delete the parity copy, which is what
> Part 4 recommends anyway.

Without these, one of the eleven required situations — **loss recovery** — cannot happen
at all, and the tool will tell you it is missing.

## Step 5. Create the credential

The tool signs in to Google as a **service account** — a robot account with no password,
which is given read-only access to one spreadsheet.

1. Go to **console.cloud.google.com** and select or create a project.
2. **APIs & Services ▸ Library**, search **Google Sheets API**, press **Enable**.
3. **IAM & Admin ▸ Service Accounts ▸ Create service account**.
   Name it something like `homestay-parity`. Skip the optional steps and press **Done**.
4. Click the account you just made, open the **Keys** tab, then
   **Add key ▸ Create new key ▸ JSON ▸ Create**.
   A file downloads, named something like `project-name-a1b2c3.json`.
5. **Move that file somewhere outside this project folder.** For example:

   ```
   C:\keys\parity-key.json
   ```

> ### Treat that file exactly like a password
>
> - **Never** put it inside the project folder.
> - **Never** commit it to Git, attach it to an email, or paste its contents into chat.
> - It is only needed while you run the check. Part 4 explains how to delete it after.
>
> The tool never prints the key, and the report records only the last six characters of
> the workbook id.

## Step 6. Share the copy with the service account

1. Open the service account in the Cloud Console and copy its **email address**. It looks
   like:

   ```
   homestay-parity@your-project-name.iam.gserviceaccount.com
   ```

2. Open the **parity copy** in Google Sheets ▸ **Share**.
3. Paste that email address.
4. Change the role from Editor to **Viewer**. ← *This matters.*
5. Untick **Notify people**, then press **Share**.

> Viewer means the account **cannot write to the spreadsheet**, at Google's end, not just
> ours. Do not share the production workbook with this account. Ever.

## Step 7. Tell the tool where things are

There are exactly two settings.

| Setting | What goes in it | Example |
|---|---|---|
| `PARITY_SHEET_ID` | the workbook id from Step 1 | `1A2B3C4D5E6F7G8H9I0J` |
| `PARITY_SERVICE_ACCOUNT_FILE` | the **path to the key file** from Step 5 | `C:\keys\parity-key.json` |

### On Windows

Open **PowerShell**, go to the project folder, and paste these two lines — with your own
values:

```powershell
$env:PARITY_SHEET_ID = "1A2B3C4D5E6F7G8H9I0J"
```

```powershell
$env:PARITY_SERVICE_ACCOUNT_FILE = "C:\keys\parity-key.json"
```

> **Use the file path, not the file's contents.** Some older instructions tell you to
> convert the key into a long line of "base64" text. On Windows that is fiddly and the
> pasted value usually picks up a line break, which breaks it. The file path always works.
>
> These two lines apply to **this PowerShell window only**. Close the window and they are
> gone — which is a feature, not a nuisance. If you open a new window, paste them again.

### On macOS or Linux

```bash
export PARITY_SHEET_ID="1A2B3C4D5E6F7G8H9I0J"
```

```bash
export PARITY_SERVICE_ACCOUNT_FILE="$HOME/keys/parity-key.json"
```

### For an automated pipeline

Store the key as a secret and provide it base64-encoded instead of as a path:

```
PARITY_SHEET_ID=<id>
PARITY_SERVICE_ACCOUNT_JSON_BASE64=<base64 of key.json>
```

`.env` and `.env.local` are ignored by Git, and `.env.example` lists names only. A test in
this repository fails the build if a credential-shaped value is ever committed.

---

# Part 2 — Running it

## Step 8. Check you are ready

```bash
npm run parity:preflight
```

This does checks 1–9 and compares nothing, so you can run it as often as you like while
getting the workbook ready.

A good run looks like this:

```
LIVE parity preflight

  OK    workbook id is set (PARITY_SHEET_ID)  — …7G8H9I from PARITY_SHEET_ID
  OK    service-account credential is set and valid  — homestay-parity@… via PARITY_SERVICE_ACCOUNT_FILE (file)
  OK    workbook is not a configured environment workbook
  OK    workbook is reachable  — Srivillu Ops — PARITY COPY (do not use for business)
  OK    title identifies this as a parity copy
  ··    workbook timezone  — Asia/Kolkata
  OK    all 22 V1 tabs exist  — from the generated contract
  OK    all 60 named ranges exist
  OK    workbook contains fixture/test records  — 4 properties, 90 reservation(s), …
  OK    CFG_FY_START is set
  OK    CFG_REPORT_MONTH is a month with data  — 2026-06
  OK    all 11 required test scenarios exist  — 11 located
  WARN  business rules configured (parity-test values)  — set — the distribution chain will be exercised
  OK    no real guest contact data  — 703 row(s) scanned, nothing contact-shaped
  OK    no real investor contact data
  OK    no real landlord contact data
  WARN  guest records are visibly fictional  — 90/90 names carry a test marker
  OK    no production secrets stored in the workbook

PREFLIGHT: READY — run `npm run parity`.
```

**`WARN` lines are information, not problems.** They do not stop the run.

If something is wrong, you get a **What to do** section naming the fix. For example:

```
  ✗ all 11 required test scenarios exist
      MISSING: loss recovery
      • loss recovery
        Needs a loss month AND the business rules set (runbook step 4). With the
        rules TBD a carry-forward has nothing to be applied against, so this
        scenario cannot occur.
```

> The personal-data and secret checks look for **evidence** — things shaped like phone
> numbers, email addresses and API keys. Passing means nothing was detected. It is not
> proof the copy is clean, so give it a glance yourself too.

## Step 9. Run the comparison

```bash
npm run parity
```

It prints the preflight again, runs the comparison, and finishes with a coverage table and
one of exactly three verdicts:

```
Coverage
  Family                           Comparisons  Status
  monthly revenue                          396  PASS
  monthly expenses                         180  PASS
  operating profit                          24  PASS
  ...
  rent                                      10  PASS
  payout reconciliation                    270  PASS

  OFFLINE: PASS
  LIVE PASS
  OVERALL PARITY GATE: PASS
```

| Verdict | Meaning |
|---|---|
| **LIVE PASS** | Every comparison agreed, and every required family was actually compared. |
| **LIVE FAIL** | Something disagreed — or a family was never compared at all. |
| **LIVE PENDING** | The comparison has not run. |

> **A family showing `NOT COVERED` can never produce a PASS.** A number nobody compared is
> missing evidence, not agreement.

## Step 10. Send the report

```
reports/PARITY_REPORT.md
```

Send that file back. It contains the workbook name, the timestamp, the coverage table,
every comparison with both values and the difference, the scenario list, and the verdict.

---

# Part 3 — If it does not pass

**A failure is information, not an emergency.** Nothing is broken in the real business —
this is a test copy.

The report lists every disagreement like this:

| Metric | TypeScript | Google Sheets | Delta | Tolerance | Result |
|---|---:|---:|---:|---:|---|
| Monthly block · 2026-06 · NetRevenue | 2,43,433.00 | 2,43,180.00 | 253.00 | 0.01 | **FAIL** |

and follows it with a triage table naming the **exact cell** the sheet value came from and
a first guess at the cause.

**What to do:** send the report. Do not try to fix the spreadsheet.

The rule the development side follows is worth knowing:

> If the code and the workbook disagree, **the workbook wins** — it is what the business
> runs on today, so the code gets fixed.
>
> If the *workbook's own formula* turns out to be wrong, everything stops and it is
> reported as **MANAGEMENT / BUSINESS LOGIC REVIEW REQUIRED**. Nobody quietly changes a
> business formula to make a test go green.

### About the tolerances

The report explains these too. They allow for the last decimal place of computer
arithmetic — nothing more.

| Kind of number | Allowed difference | Why |
|---|---|---|
| Money | ₹0.01 | One paisa. Both sides add up the same figures in a different order, so the last fraction can differ. Below a paisa, nothing can be paid or owed. |
| Percentages (occupancy, margin) | 0.000000001 | A division on both sides. This is about a ten-millionth of a percentage point. |
| Counts (bookings, nights, tickets) | **none — must match exactly** | A count off by one is a real mistake. There is no rounding to hide behind. |
| Dates and words ("OVERDUE") | **none — must match exactly** | "Due soon" and "OVERDUE" are different answers, not close ones. |

**No tolerance is a business allowance.** A ₹200 difference is never excused for being
small.

---

# Part 4 — Cleaning up

When the check has passed and the report has been sent:

1. **Unshare the copy** — open the copy ▸ Share ▸ remove the service-account address.
2. **Delete the parity copy** — right-click it in Google Drive ▸ **Move to trash**, then
   empty the trash. It holds only invented data, but a spreadsheet that looks like the
   real one is a hazard of its own.
3. **Delete the key file** — `C:\keys\parity-key.json`. If this will run again from a
   pipeline, keep it as a stored secret instead, never on a laptop.
4. **Delete the service-account key** in the Cloud Console ▸ Service Accounts ▸ Keys.
5. **Close the PowerShell window.** The two settings disappear with it.
6. **Check the real workbook is untouched.** It was never shared with the service account
   and never opened by the tool. Its version history will show nothing.

Keep `reports/PARITY_REPORT.md`. It is the evidence that the gate closed.

---

# When to run this again

- Whenever the Google Sheet's formulas change.
- Before any production release.
- After any change to the calculation code.

---

# Quick reference

```powershell
$env:PARITY_SHEET_ID = "<the copy's id>"
```

```powershell
$env:PARITY_SERVICE_ACCOUNT_FILE = "C:\keys\parity-key.json"
```

```bash
npm run parity:preflight
```

```bash
npm run parity
```

| Setting | Meaning |
|---|---|
| `PARITY_SHEET_ID` | the parity copy's workbook id — **never** the production one |
| `PARITY_SERVICE_ACCOUNT_FILE` | path to `key.json` — the recommended form |
| `PARITY_SERVICE_ACCOUNT_JSON_BASE64` | the same key, base64-encoded — for pipelines |
| `PARITY_TITLE_CONFIRMED_NOT_PRODUCTION` | `yes` only if the copy genuinely cannot be renamed. Recorded in the report. |
