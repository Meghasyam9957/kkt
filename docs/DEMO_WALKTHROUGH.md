# Srivillu DEMO — Client Walkthrough Script (Phase D9)

A presenter's script for a 15–20 minute live demonstration. Read it beside the browser;
every button label, route and toast below is quoted from the interface as built, so if the
screen disagrees with this document, something is wrong — see the box at the end.

Everything shown runs on fictional data. No real guest, investor or payment appears at any
point.

**Total time: about 20 minutes at a spoken pace.** A brisk 15-minute run keeps every step
but shortens 4 (Properties), 7 (Housekeeping) and 9 (Inventory) to a single sentence each.

**One honesty rule for the whole session.** The demo runs on one of two backing stores: the
generated in-memory dataset (the default) or the demo Google workbook (`LIVE_DATA_ENABLED=true`).
The header's **Data source** line tells you which. Every spoken line in this script is
worded to be true in both modes — say "the system records it and reads it back before
claiming success", and never claim a Google Sheet was updated unless you are in workbook
mode and have verified it yourself beforehand.

---

## Before the demo (read this the day before, do it 15 minutes before)

1. **Reset to a known state.** Sign in as **Demo Administrator** → sidebar
   **Demonstration ▸ Demo controls** → **Reset demo environment** → **Yes, reset the demo**.
   Whatever the last demonstration created is now gone and the dataset is identical to
   every previous reset.
2. **Check the header strip.** Every internal page carries the **DEMO / UAT** badge plus
   **Environment**, **Data source** and **Last synced**. The badge means: fictional
   demonstration data, not business data. If the badge is missing, you are not on the demo
   deployment — stop and find out where you are before showing anyone anything.
3. **Note the demo's "today".** In the default (in-memory) mode the **Current scenario**
   card on Demo controls says "presenting <date>" — that is the date the Today board is
   built around, and you will need it when creating the reservation in step 5. In workbook
   mode the seeded story trades around the real current date, so "today" means today.
4. **Know where the working register lives:** sidebar **Operations ▸ Bookings**
   (`/admin/operations/reservations`) — reservation creation, check-in, check-out and
   cancel all happen there. (**Property ▸ Reservations** is the read-only financial
   register; **Operations ▸ Check-ins / Check-outs** are the focused arrival and departure
   boards.)
5. **Sign out.** The demonstration starts at the sign-in screen, not mid-session.
6. **Browser:** one full-screen desktop window at 100% zoom, bookmarks bar hidden, no
   devtools, no other tabs visible. The layout is responsive, but present it at desktop
   width — the dashboard is designed around that first viewport.
7. **Optional — Presentation mode.** Demo controls has **Enter presentation mode**, which
   hides the reset button so it cannot be pressed by accident on a shared screen. If you
   use it, remember step 14 needs **Re-enable the reset** first.
8. **Workbook mode only:** confirm beforehand that a test write succeeds and that the
   header reads the workbook as its data source. Scenario switching is not offered in
   workbook mode (the workbook tells one seeded story), and the reset restores the
   workbook to its captured **seed snapshot** — Demo controls must show "Seed snapshot
   captured …" (it was taken during provisioning; without it the reset refuses to run).

---

## Step 1 — Login (1 min)

**WHAT TO CLICK**
Open the app root — you are redirected to `/signin`. What appears depends on configuration:

- *Demo identity chooser* (no Supabase configured): four account buttons — **Demo
  Administrator**, **Demo Operations Manager**, **Investor Demo A** (INVESTOR · INV-001),
  **Investor Demo B** (INVESTOR · INV-002). Click **Demo Administrator**.
- *Real sign-in* (Supabase configured): an **Email address** and **Password** form with a
  **Sign in** button. Sign in as `admin.demo@srivillu.demo` with the password set through
  the invitation flow.

**WHAT TO SAY**
"This environment carries a DEMO / UAT badge on every screen because everything behind it
is fictional. In this demonstration setup we simply choose who to present as — there are no
passwords because there is nothing to protect. Where real authentication is configured,
this same screen is an ordinary email-and-password sign-in, and the chooser does not exist.
We'll start as the administrator, who sees everything."

**WHAT THE SYSTEM SHOULD SHOW**
The sign-in card shows the DEMO / UAT badge, the line "Fictional demonstration data. No
real guest, investor or payment information.", and the environment name and data source.
Clicking an identity (or Sign in) lands you on the Dashboard.

---

## Step 2 — Dashboard (2 min)

**WHAT TO CLICK**
Sidebar: **Overview ▸ Dashboard** (`/admin/dashboard`). Scroll top to bottom once, slowly.
Point at the month picker in the filter bar but do not linger.

**WHAT TO SAY**
"This is the management view, and the first thing to know is that nothing on it is typed
in — every figure is calculated from the underlying records by the same engine regardless
of which data source is behind it. The top row is the pulse of the month: revenue,
occupancy, profit, rates. Below it, what needs attention today, then how each of the four
units is doing — the system flags the best and the weakest performer itself. The charts
and the Position section underneath are the same records viewed over time."

**WHAT THE SYSTEM SHOULD SHOW**
In order down the page: a one-sentence summary line (month, net revenue, occupancy,
operating profit, and how many items need attention) · a KPI band of six cards with the
revenue card largest · a **Today** card with six counter tiles (Check-ins, Check-outs,
Pending cleaning, Open maintenance, Low stock items, Guest requests) · a **Unit
performance** board of four property cards, one flagged "Best performer this month" and one
"Weakest performer this month" · four charts (Revenue trend, Occupancy trend, Revenue
expenses and profit, Property performance) · a **Position** card of secondary KPIs · an
**Insights** card with an "Ask Copilot" button.

---

## Step 3 — Today's operations (1.5 min)

**WHAT TO CLICK**
Sidebar: **Operations ▸ Today** (`/admin/operations/today`).

**WHAT TO SAY**
"This is the morning board for whoever runs the day — and notice there is not a single
financial figure on it. What needs a person comes first, most pressing at the top, with the
action spelled out. Below that: who arrives today, who leaves, where every unit stands, and
the open work — turnovers, maintenance, low stock, guest requests. Every count here is
derived from a record; nothing on this board is entered by hand."

**WHAT THE SYSTEM SHOULD SHOW**
A **Needs attention** card first (an ordered list with Critical / High / Watch pills, or
"Nothing needs attention" after a fresh reset on a quiet scenario), then **Position for
<date>** with the same six counter tiles as the dashboard, then **Arriving today** /
**Departing today** side by side, **Unit status**, and the work queues: **Turnovers
outstanding**, **Open maintenance**, **Stock needing attention**, **Guest requests**.

---

## Step 4 — Properties (1 min)

**WHAT TO CLICK**
Sidebar: **Property ▸ Properties** (`/admin/properties`).

**WHAT TO SAY**
"The permanent register of the four units — type, floor, capacity, whether the listing is
live — with this month's performance beside each. The costs shown are direct costs only;
shared costs are deliberately not spread across units, because an allocated number invites
decisions it can't support. This register is read-only in this phase; editing it comes with
a later release."

**WHAT THE SYSTEM SHOULD SHOW**
A **Unit register** table: Property ID, Unit, Type, Floor, Bedrooms, Max guests, a
**Listing** pill (Live), Occupancy, Net revenue, Profit. Four rows, one per unit.

---

## Step 5 — Reservation creation (2 min)

**WHAT TO CLICK**
Sidebar: **Operations ▸ Bookings** (`/admin/operations/reservations`). Click **+ New
Reservation** (top right). A drawer titled **Create a reservation** opens. Fill: **Property**, **Platform**,
**Guest name** (any fictional name), **Adults** (defaults to 2), **Check-in** — use the
demo's "today" from your pre-demo note — and **Check-out** two nights later. Leave
**Status** on Confirmed. Optionally enter a **Base rate / night** and **Room revenue**.
Click **Create booking**.

**WHAT TO SAY**
"Now we stop looking and start doing. This form only asks for what a person actually knows —
dates, guest, platform, the rate. Totals, fees and the expected payout are calculated by
the system, never typed, so they cannot be typed wrongly. Watch the button: it says
Applying while the record is being written, and it only says Verified once the system has
read the saved record back."

**WHAT THE SYSTEM SHOULD SHOW**
The submit button steps through **Create booking → Applying… → Verified** (with a tick).
A green toast appears: "*BK-… created — totals and payout are calculated by the workbook.*"
The drawer closes and the new booking appears in the register with a **Confirmed** pill and
**Check In** / **Cancel** actions. If the row is not visible, the month filter is on a
different month than your check-in date — switch it.

---

## Step 6 — Check-in (1 min)

**WHAT TO CLICK**
Same register. On the booking you just created, click **Check In**. (The same action also
lives on the dedicated arrivals screen at `/admin/operations/checkins`.)

**WHAT TO SAY**
"The guest has arrived, so one click checks them in. There is no form because there is
nothing to ask. The server validates the transition — a booking that isn't confirmed can't
be checked in, and the rule lives on the server, not in the button."

**WHAT THE SYSTEM SHOULD SHOW**
The button reads **Applying…** then **Done** with a tick; a toast says "*BK-… checked
in.*" The status pill flips from **Confirmed** to **Checked In**, and the row's action
changes to **Check Out**.

---

## Step 7 — Housekeeping (1.5 min)

**WHAT TO CLICK**
Sidebar: **Operations ▸ Housekeeping** (`/admin/operations/housekeeping`). On any open
turnover in the **Turnovers** table, click **Mark Clean**. A dialog titled "*Turnover
HK-… — mark clean*" opens with two fields: **Cleaned by** (type a fictional name) and
**Inspection** (leave on Passed). Click **Mark Clean**.

**WHAT TO SAY**
"Every checkout generates a turnover — the unit isn't available again until someone says
it's clean and inspected. Marking it clean records who cleaned and the inspection result,
so the answer to 'who turned this unit over and when' is always in the record, not in
someone's memory."

**WHAT THE SYSTEM SHOULD SHOW**
The dialog button runs **Mark Clean → Applying… → Verified**; a toast says "*HK-…
completed — the unit is ready.*" The row's status changes to **Completed** ("Done" replaces
the action) and the "open" count in the card header drops by one.

---

## Step 8 — Maintenance (1.5 min)

**WHAT TO CLICK**
Sidebar: **Operations ▸ Maintenance** (`/admin/operations/maintenance`). Click **+ New
Maintenance Issue**; the drawer **Report a maintenance issue** opens. Fill **Property**,
**Category**, **What is wrong?** (a sentence), **Priority**; click **Create ticket**. Then,
on the new row, click **Resolve** — a dialog "*Resolve MNT-…*" opens with **Resolved on**
already set to today; click **Resolve**.

**WHAT TO SAY**
"Something breaks, someone reports it, and it appears on the board immediately — priority
first, so the most pressing thing is always at the top. When it's fixed, resolving it
records the date, and optionally the cost and the expense it links to — so maintenance and
money stay connected instead of living in two different notebooks."

**WHAT THE SYSTEM SHOULD SHOW**
First a toast "*MNT-… created — it appears on the board immediately.*" and a new row in
**Open tickets** with its priority pill. Then, after resolving: a toast "*MNT-…
resolved.*", the status showing **Resolved**, and the open-ticket count in the card header
down by one.

---

## Step 9 — Inventory (1 min)

**WHAT TO CLICK**
Sidebar: **Operations ▸ Inventory** (`/admin/operations/inventory`). On any item in the
**Stock register**, click **Movement**. In the "*Stock movement — <item>*" dialog, enter a
small **Purchased (units)** or **Used (units)** count and click **Movement**.

**WHAT TO SAY**
"Stock works the same way as everything else: people record what happened — bought this
many, used this many — and the system calculates what's left. The 'in stock' figure is
never typed, so it can't drift from reality by a typo, and anything at or below its minimum
gets flagged on the Today board automatically."

**WHAT THE SYSTEM SHOULD SHOW**
The dialog button runs to **Verified**; a toast says "*ITM-… updated — current stock is
recalculated by the workbook.*" The row's **In stock** figure and **State** pill (In stock
/ Low / Out of stock) reflect the recalculation.

---

## Step 10 — Expense (2 min)

**WHAT TO CLICK**
Sidebar: **Finance ▸ Expenses** (`/admin/finance/expenses`). Click **+ New Expense**; the
drawer **Record an expense** opens. **Date** is already today. Choose a **Property** (note
the COMMON option for shared costs), a **Category** from the list, type a **Subcategory**
(the placeholder suggests the style) and a one-line **Description**. Enter **Amount**:
**₹4,321**. Leave **Payment status** on Paid and **Expense type** on Operating. Click
**Record expense**.

**WHAT TO SAY**
"Recording money out is the same discipline as everything else. The category list is the
business's own vocabulary, not a free-text field, so the books stay consistent. And note
the expense type: operating costs reach the profit and loss, capital purchases are kept
separate — the system won't quietly blur that line. We'll record four thousand three
hundred and twenty-one rupees and then go and find it in the P&L."

**WHAT THE SYSTEM SHOULD SHOW**
The button runs **Record expense → Applying… → Verified**; a toast says "*EXP-… recorded —
the P&L reflects it on the next refresh.*" A new row appears in the **Operating expenses**
ledger dated today with Amount ₹4,321, and the table's footer total has moved by exactly
₹4,321.

---

## Step 11 — P&L (1.5 min)

**WHAT TO CLICK**
Sidebar: **Finance ▸ P&L** (`/admin/finance/pnl`). If the new expense is not yet visible in
the current month's column, refresh the page once — the toast said "on the next refresh"
and it meant it.

**WHAT TO SAY**
"This is the whole year on one screen — month by month, revenue down to operating profit,
using the business's own expense line mapping so this statement reconciles to the books
rather than re-categorising them. The expense we just recorded is already inside the
current month's figures. And notice capital spend and investor distributions sit below the
line as memo items — they never distort operating profit."

**WHAT THE SYSTEM SHOULD SHOW**
A **Monthly P&L** page with a **Profit & loss** table: one column per month plus an **FY
total** column, section headings, bolded subtotal and total lines, and muted memo lines
below the line. The current month's operating expenses include the ₹4,321 just recorded
(the visible movement is in the expense lines and operating profit for that month).

---

## Step 12 — Investor login (1.5 min)

**WHAT TO CLICK**
Click the account control at the top right (the avatar, labelled **Switch**). On the
sign-in screen choose **Investor Demo A**.

**WHAT TO SAY**
"Now the most important part of the whole demonstration: what an investor sees. This
account belongs to an investor with a forty percent participation. Their world is one
screen — their capital, their share, the portfolio's headline performance, and their
distribution. No guests, no expenses, no unit detail, no other investor. Look at the menu:
everything you saw in the last fifteen minutes is simply not there."

**WHAT THE SYSTEM SHOULD SHOW**
The investor lands on **Portfolio** (`/admin/portfolio`), titled "*Portfolio — Anand Rao
(Demo A)*". Six fact tiles: **Your capital** (₹12,00,000), **Your participation** (40%),
**Status**, **Portfolio net revenue**, **Portfolio operating profit**, **Portfolio
occupancy**. Below: a **Your distribution** card (a calculated figure, or "Configuration
required" if terms are not approved — that wording is deliberate) and a **Portfolio
performance** table by month. The sidebar has collapsed to the investor's own entries.

---

## Step 13 — Investor isolation (1.5 min)

**WHAT TO CLICK**
Three deliberate attempts to break out, in this order:

1. Type `/admin/dashboard` in the address bar.
2. Type `/admin/portfolio?investorId=INV-002` in the address bar.
3. Click **Switch**, choose **Investor Demo B**.

**WHAT TO SAY**
"Let's try to cheat. Going straight to the management dashboard by its address gets a plain
refusal — the menu hiding it was a courtesy; the server refusing it is the control. Asking
the portfolio page for the other investor's number changes nothing, because the page never
accepts an investor identity from the address — it comes from the signed-in session and
nowhere else. And signing in as the second investor shows different figures entirely: two
investors, two positions, and no route from one to the other."

**WHAT THE SYSTEM SHOULD SHOW**
(1) A page titled "**Not available for your role**" — "You are signed in. This screen is
simply not part of what this role uses." (2) The identical Investor A portfolio, ignoring
the query string. (3) "*Portfolio — Meera Krishnan (Demo B)*" with **Your capital**
₹10,50,000 and **Your participation** 35% — visibly different from A.

---

## Step 14 — Demo reset (1 min)

**WHAT TO CLICK**
**Switch** → **Demo Administrator** → sidebar **Demonstration ▸ Demo controls**
(`/admin/demo`) → scroll to **Reset demo environment** → click **Reset demo environment**
→ read the confirmation aloud → click **Yes, reset the demo**. (If you used presentation
mode, click **Re-enable the reset** first.)

**WHAT TO SAY**
"Last thing. Everything we created in the past twenty minutes — the booking, the expense,
the ticket — was real to the system, so we reset the demonstration environment to its
seeded state. Read the confirmation: it resets fictional demonstration data only. There is
no such button in production, by design — this control exists only because this
environment's data is generated."

**WHAT THE SYSTEM SHOULD SHOW**
The button reveals an inline confirmation titled "**Reset the demonstration
environment?**" with the sentence "*This resets fictional demonstration data only. No
business workbook, no guest record and no investor figure is touched…*". After confirming,
the page returns to Demo controls. In the default mode, the **Current scenario** card shows
a fresh "Dataset seeded" timestamp and "**0 changes since**". **In workbook mode**, the
reset restores the demo workbook's input rows to the captured seed snapshot — verified by
reading the sheet back — and clears the demo project's operation state; it needs a moment
longer, and it refuses (with a plain message) if no seed snapshot was ever captured. Either
way, the booking and expense from steps 5 and 10 are gone: open **Finance ▸ Expenses** and
show the ₹4,321 row missing if the audience wants proof.

---

## If something goes wrong

- **A form shows a red failure box instead of Verified.** It stays on screen with the
  message, the reasons, and a line reading "Operation <id>". Say exactly this: "The system
  refused the change and is telling us why — and that operation id is the reference we
  would look up in the audit trail. It never pretends a save worked." A refusal with
  reasons is the system behaving correctly; read the reasons, fix the input, submit again.
- **"Writes are not enabled in this environment."** The environment's write flag is off.
  Reads are unaffected — carry on with the read-only steps and say the write phase is
  disabled on this deployment.
- **"Not available for your role."** You are signed in as the wrong account for that
  screen. Use **Switch** (top right). This is the product working, not failing — say so.
- **A created row is not visible.** Check the month/property filters first — the register
  shows the selected month, and your new record may be filed under a different one.
- **The toast said "on the next refresh" and the figure hasn't moved.** Refresh the page
  once. Reads are cached briefly; the toast wording is the system being honest about that.
- **Everything looks wrong at once.** Demo controls ▸ Reset rebuilds the dataset from seed
  and returns you to a known state in seconds. That is what it is for.
