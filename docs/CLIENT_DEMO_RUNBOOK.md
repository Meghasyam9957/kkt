# Client Demonstration — 15 Minutes

For whoever is presenting. Read this once beforehand; you will not need it open during the
demonstration.

**Everything shown is fictional.** Say so at the start and the screen will keep saying it
for you — DEMO / UAT sits in the header of every page.

---

## Before they arrive (2 minutes)

```bash
cd homestay-web
npm run dev -- --port 3210
```

Then, in the browser:

1. Sign in as **Demo Administrator**.
2. **Demonstration ▸ Demo controls** → **Reset demo environment**. This guarantees a known
   starting state whatever the last demonstration did.
3. Confirm the scenario chip in the header reads **Normal day**.
4. **Enter presentation mode.** The reset control disappears, so it cannot be pressed by
   accident on a shared screen.
5. Leave the browser on **Dashboard**. Full screen. Close other tabs.

Have a second browser window ready if you want to show two roles side by side.

---

## The demonstration

### 1 · Admin login (1 min)

Show the sign-in screen before you sign in.

> "Four accounts, one per role. In the real system these are proper logins with passwords;
> here they are open because everything behind them is invented."

Point at **DEMO / UAT**. Sign in as **Demo Administrator**.

### 2 · Dashboard (3 min)

> "This is the operating position for the current month. Fourteen figures — and **not one
> of them is typed in.** Every number is calculated from the underlying records by the same
> engine that will read the real workbook."

Three things to point at:

- The **yellow notice**: the commercial terms behind any distribution figure are
  illustrative. Say it out loud too — it matters more than the badge.
- The **month picker**: ten months, and **August 2026 and March 2027 are missing.** The
  business did not trade in those months, so there is nothing to show. The system does not
  invent a zero.
- The **unit board**: four units, each with its own performance, and the best and weakest
  flagged.

> **If asked about the margin:** the current month is only part way through. Revenue is
> recognised when a guest checks out, while costs accrue across the whole month, so a
> month-to-date margin runs ahead of the full-month figure. The workbook does exactly the
> same thing.

### 3 · Property performance (2 min)

**Property ▸ Properties.**

> "Four units, and they do not perform alike. This one has the highest rate but the lowest
> occupancy; this one is the opposite. That is the kind of difference the operator needs to
> see, and it is why we do not average everything into one number."

Then go back to the Dashboard and change the month to **November 2026** — the peak — and
then to **April 2026**.

> "April was the start-up month. Low occupancy, and it lost money. A system that only ever
> shows good months is not much use."

### 4 · Today's operations (3 min)

**Switch → Demo Operations Manager.** This is the moment worth slowing down for.

> "Same system, different job. Notice the menu is much shorter. No Finance. No Investors."

On the Today screen:

> "It opens with **what needs a person**, most urgent first — and each one says what to do
> about it, not just what is wrong."

Then, deliberately, in the address bar type `/admin/finance/pnl`.

> "**Not available for your role.** The menu hiding the link is a convenience. The refusal
> happens on the server, whether or not the link was ever shown."

Switch the scenario to **Operations issue** (header chip → Demo controls → back to Today) and
show the critical water leak arriving at the top of the list.

> "Switching a scenario **adds records**. Everything you see recalculates from them — it is
> not a second set of screens."

### 5 · Financial overview (2 min)

**Switch → Demo Administrator. Finance ▸ P&L.**

> "Month by month, with the year to date. Revenue, deductions, costs by category, operating
> profit."

Point at January 2027:

> "That is a ₹96,500 structural repair, and you can see exactly what it did to the margin
> that month. That is the point of keeping the ledger properly."

Mention briefly: Revenue, Expenses and Cash Flow are the same shape, one level down.

### 6 · Investor portal (2 min)

**Switch → Investor Demo A.**

> "An investor signs in and gets exactly one screen. Their capital, their participation,
> their distribution, and the portfolio totals. No guests, no costs, no operations."

Point at the notice.

> "And it says plainly that these are demonstration values. Nothing here represents an
> agreement — the commercial terms have not been settled."

### 7 · Investor isolation (1 min)

Still as Investor A, in the address bar: `/admin/portfolio?investorId=INV-002`.

> "Still Anand's figures. The page never accepts an investor identity from the web address —
> it reads it from the session. There is no parameter to change."

**Switch → Investor Demo B.**

> "Different capital, different participation, different distribution. Two investors, and no
> route between them."

### 8 · Guest support concept (1 min)

**Switch → Demo Administrator → Demonstration ▸ Guest journey.**

> "A guest checks in, looks up their stay, asks a question, raises a request — and it lands
> in the operations queue."

Press **Raise the guest request**, then open **Operations ▸ Today** and point at the guest
request count.

> "That is a real record in the system, not a message on a screen. The same path a live one
> would take."

**Be explicit:** the answers in that journey are **fixed text**, not generated. There is no
AI in this version.

### 9 · What comes next (1 min)

Be plain about the difference between what they have just seen and what is planned.

**Working today, on demonstration data:** the calculation engine, all the read-only
screens, roles and access control, investor isolation, and the demonstration environment
itself.

**Next, and already designed:** reading the real workbook (waiting on one verification
step), proper logins, and then the ability to *enter* data — bookings, expenses, tickets —
rather than only read it.

**Under consideration, not promised:** an assistant that answers questions from the
operational data, and guest messaging. Neither is built. There is a placeholder screen so
you can see where it would live.

> "I would rather show you a placeholder than a demonstration of something that does not
> exist."

---

## Closing

> "Everything you have seen is calculated from a fictional ledger by the same engine that
> will read the real one. Nothing on those screens was typed in to make the demonstration
> look good — which also means that when it points at the real workbook, it will show you
> exactly what is there."

Reset the environment afterwards if the machine is shared.

---

## Questions you should expect

**"Is this using our real data?"**
No. Every guest, every rupee and every investor here is invented. The real workbook is on a
separate connection that this demonstration cannot reach — that is enforced by how the
system is configured, not by anyone remembering to be careful.

**"Are those the actual investor terms?"**
No, and the screen says so. They are illustrative values so the calculation can be shown
working. The real terms have not been agreed, and until they are, the system shows
"Configuration required" rather than a number.

**"Can we start using it on Monday?"**
Not yet, and there is one specific reason: the calculation engine has not been checked
against the live spreadsheet. That check takes about twenty minutes and needs a Google
account. Until it passes, we do not know the two agree — and everything on these screens
comes from that engine.

**"Can the operations team change anything?"**
Not in this version. Everything is read-only. Data entry is the next phase, and it is
deliberately after the verification step.

**"What happens if the spreadsheet is down?"**
The screens show the last figures they successfully read, clearly marked stale, with the
time of the last good read. They never show old figures as if they were current.

**"Can an investor see another investor?"**
No. We just demonstrated it — the identity comes from the login, and there is no parameter
to change it.

---

## If something goes wrong mid-demonstration

**A screen says "Not available for your role"** — you are signed in as the wrong account.
Use **Switch**. This is worth showing rather than hiding: it is the access control working.

**A figure looks wrong** — write down the screen and the month and move on. Do not debug in
front of the client.

**The scenario is not what you expected** — the header chip always shows what is currently
displayed. One click to change it.

**Everything looks reset** — restarting the server resets the demonstration. Sign in again;
nothing is lost.

**Do not** open the demo controls in front of the client unless you are demonstrating
scenarios deliberately. The reset button invites a question you do not need.
