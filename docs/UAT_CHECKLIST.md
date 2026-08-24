# Srivillu Home Stays — UAT Checklist

**For the Operations Manager and anyone else testing the system. No technical knowledge
needed.**

Everything you will see is **made up**. The guests, the money, the investors — all
fictional. You cannot break anything, and you cannot affect the real business. If something
looks wrong, that is exactly what we want to know.

---

## Before you start

1. Ask whoever set this up for the web address (usually `http://localhost:3210`).
2. Open it in Chrome, Edge or Safari.
3. You should see a sign-in page with **DEMO / UAT** on it and four accounts to choose from.
4. Have this checklist open beside it. Tick as you go.

**How to record a result:** write **PASS** if it did what the "Expected" column says, or
**FAIL** if it did not. If you write FAIL, add a note — even one line helps. There is a
form for reporting problems properly in `docs/UAT_ISSUE_TEMPLATE.md`.

**If you get stuck at any point, that is a finding.** Write it down and move on to the next
section.

---

## A · ADMIN

Sign in as **Demo Administrator**.

| # | Action | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| A1 | Click **Demo Administrator** on the sign-in page | You land on the Dashboard. No password was asked for | | |
| A2 | Look at the top of the screen | You can see **DEMO / UAT**, the word **DEMO**, a data source and a "last synced" time | | |
| A3 | Read the yellow-bordered notice above the figures | It says the financial assumptions are demo values, not production terms, and lists 60% / 40% / 5% | | |
| A4 | Count the boxes of figures on the Dashboard | There are 14 | | |
| A5 | Open the **Reporting month** dropdown | Ten months are listed. August 2026 and March 2027 are **missing** | | |
| A6 | Pick **November 2026** | Every figure changes. The month name in the description changes too | | |
| A7 | Scroll to the four units | Each unit has its own figures. One is marked best performer, one weakest | | |
| A8 | Scroll to the charts | Four charts. The line follows the months, with a visible gap where the business did not trade | | |
| A9 | Go to **Property ▸ Properties** | All four units listed: HYD-501, HYD-502, HYD-601, HYD-602, with type, floor and guest capacity | | |
| A10 | Go to **Property ▸ Reservations** | A list of bookings. Guest names are shortened, e.g. "Priya M." — no full names, no phone numbers | | |
| A11 | Go to **Operations ▸ Today** | See section B — this is the operations screen | | |
| A12 | Go to **Finance ▸ Revenue** | A list of revenue entries with dates and amounts. The demo notice is at the top | | |
| A13 | Go to **Finance ▸ Expenses** | A list of costs. The demo notice is at the top | | |
| A14 | Go to **Finance ▸ P&L** | A profit and loss table, one column per month plus a total | | |
| A15 | In the P&L, find the month with the highest Repairs figure | January 2027 stands out — a large one-off repair | | |
| A16 | Go to **Investors ▸ Investors** | Three investors with capital and participation. Participation totals 100% | | |
| A17 | Go to **Investors ▸ Distributions** | A distribution breakdown, with the demo assumptions notice above it | | |
| A18 | Go to **Analytics ▸ Performance** | A month-by-month table and two charts | | |
| A19 | Go to **System ▸ Settings** | Business details and a list of business rules | | |
| A20 | Use the browser Back button a few times | Each page loads again correctly, still signed in | | |

---

## B · OPERATIONS

**This is the most important section for you.** Sign in as **Demo Operations Manager**
(use **Switch** at the top right).

| # | Action | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| B1 | Look at the menu on the left | Much shorter than the admin one. **No Finance. No Investors. No Settings** | | |
| B2 | Land on Today's operations | The first thing you see is **Needs attention** — a list of things to do | | |
| B3 | Read the first item in Needs attention | It says what happened **and** what to do about it | | |
| B4 | Look at the coloured labels | Critical items are at the top, then High, then Watch | | |
| B5 | Look for any money on this screen | **There is none.** No revenue, no rates, no payouts anywhere | | |
| B6 | Look at the six count boxes | Check-ins, check-outs, pending cleaning, open maintenance, low stock, guest requests | | |
| B7 | Check **Arriving today** | Guests due in, with nights and number of guests. Names shortened | | |
| B8 | Check **Departing today** | Units that will need cleaning today | | |
| B9 | Check **Unit status** | Each unit shows Occupied, Available, Cleaning or Maintenance, with a short reason | | |
| B10 | Check **Open maintenance** | Tickets listed most urgent first, with how many days each has been open | | |
| B11 | Check **Stock needing attention** | Items at or below their minimum, worst first | | |
| B12 | Check **Guest requests** | Open requests waiting on a reply | | |
| B13 | Use the **Property** filter, pick HYD-501 | Every list narrows to that unit only | | |
| B14 | **Type this in the address bar:** `/admin/finance/pnl` | **"Not available for your role."** You are still signed in — it is simply not your screen | | |
| B15 | Try `/admin/investors` the same way | Same refusal | | |
| B16 | Is anything missing that you would need each morning? | *(Your judgement — please write it down)* | | |

---

## C · INVESTOR

Sign in as **Investor Demo A**, then repeat as **Investor Demo B**.

| # | Action | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| C1 | Sign in as Investor Demo A | You land on **Portfolio**. That is the only screen in the menu | | |
| C2 | Read the notice at the top | It says clearly the values are demonstration values, not approved terms | | |
| C3 | Check the top row of figures | Capital ₹12,00,000, participation 40% | | |
| C4 | Check **Your distribution** | A calculated amount, a paid amount and a pending amount | | |
| C5 | Check **Portfolio performance** | Monthly revenue, profit and occupancy for the whole portfolio | | |
| C6 | Look for anything about guests, cleaning, suppliers or costs | **There is none.** No guest names, no tickets, no expense detail | | |
| C7 | Look for any other investor's name | **There is none** | | |
| C8 | Try `/admin/dashboard` in the address bar | "Not available for your role" | | |
| C9 | Try `/admin/operations/today` | "Not available for your role" | | |
| C10 | Try `/admin/portfolio?investorId=INV-002` | **Still your own figures.** The web address cannot change whose data you see | | |
| C11 | Switch to **Investor Demo B** | Capital ₹10,50,000, participation 35% — **different figures** | | |
| C12 | Check B's distribution against A's | The amounts are different | | |
| C13 | As B, look for Investor A anywhere | Nothing about Investor A appears | | |
| C14 | Would you be comfortable showing this to a real investor? | *(Your judgement)* | | |

---

## D · SECURITY

You do not need technical knowledge for these. You are checking that the system says no
when it should.

| # | Action | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| D1 | Sign out (**Switch**), then type `/admin/dashboard` in the address bar | You are sent to the sign-in page, not to the dashboard | | |
| D2 | As Operations, try `/admin/demo` | "Not available for your role" | | |
| D3 | As Investor A, try `/admin/demo` | "Not available for your role" | | |
| D4 | As Investor A, try `/admin/investors` | "Not available for your role" | | |
| D5 | As Operations, look for any button that changes data | There is none. Everything is read-only | | |
| D6 | As Admin, look for any Save, Edit or Delete button on a business screen | There is none. Nothing in this version writes data | | |
| D7 | On any screen, look at the header | It always says DEMO / UAT. It never disappears | | |
| D8 | As Investor A, check the menu for demo controls | There are none | | |

---

## E · DATA

Check the numbers look like a real business, not like filler.

| # | Action | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| E1 | On the Dashboard, compare the four units | They are **not** all the same. Different occupancy, different revenue | | |
| E2 | Look through the reporting months | Some are strong, some are weak, two are empty | | |
| E3 | Pick **April 2026** | A poor month — very low occupancy and a loss. This is the start-up period | | |
| E4 | Pick **September 2026** | Also weak — the units had been off-market | | |
| E5 | Pick **November 2026** | The best month — around 91% occupancy | | |
| E6 | Look at Reservations for any month | A mix of Airbnb, Booking.com and Direct. Some cancellations | | |
| E7 | On Reservations, look at the payout column | At least one booking was paid less than expected | | |
| E8 | Do the amounts read correctly in Indian format? | ₹2,27,605 — not ₹227,605 | | |
| E9 | Do any figures look impossible? | *(Your judgement — occupancy above 100%, negative guests, etc.)* | | |
| E10 | Does anything look obviously wrong for a Hyderabad homestay? | *(Your judgement — this is where your experience matters most)* | | |

---

## F · UX / UI

| # | Action | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| F1 | Can you read every figure without leaning in? | Yes | | |
| F2 | Is it obvious which screen you are on? | Every page has a title and a one-line explanation | | |
| F3 | Make the browser window narrow (or open it on a phone) | The menu becomes a button. Tables scroll sideways instead of breaking | | |
| F4 | Where a figure is unavailable, is it clear why? | It says "Configuration required", not ₹0 | | |
| F5 | Do the colours mean something consistent? | Red = urgent, amber = attention, green = fine — everywhere | | |
| F6 | Are the charts readable at a glance? | Yes | | |
| F7 | Pick a screen and count how long to find one specific figure | *(Your judgement — anything over ~10 seconds is worth reporting)* | | |
| F8 | Is anything confusing, ugly or in the wrong place? | *(Your judgement — please be blunt)* | | |

---

## G · DEMO ENVIRONMENT

Sign in as **Demo Administrator**.

| # | Action | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| G1 | Look at the top-right of the header | A **Scenario** chip showing what is currently displayed | | |
| G2 | Click it | You reach **Demonstration controls** | | |
| G3 | Click **High occupancy**, then go to the Dashboard | All four units occupied. Occupancy jumps | | |
| G4 | Click **Operations issue**, then Operations ▸ Today | A **Critical** item appears at the top — a water leak | | |
| G5 | Click **Guest support**, then Operations ▸ Today | Four guest requests instead of one | | |
| G6 | Click **Financial review**, then Finance ▸ P&L | The repair spike is visible in the previous month | | |
| G7 | Click **Investor review**, then Investors ▸ Distributions | The distribution breakdown is populated | | |
| G8 | Go back to **Normal day** | Everything returns to the everyday picture | | |
| G9 | On Demo controls, click **Enter presentation mode** | It says presentation mode is ON, and the Reset control disappears | | |
| G10 | Look for the Reset control | It is gone, replaced by a note explaining why | | |
| G11 | Click **Re-enable the reset** | The Reset control comes back, presentation mode stays on | | |
| G12 | Click **Leave presentation mode** | Everything is available again | | |
| G13 | Go to **Demonstration ▸ Guest journey** | Five steps, from check-in to operations seeing the request | | |
| G14 | Click **Raise the guest request** | It confirms the request is in the queue | | |
| G15 | Go to Operations ▸ Today | The guest requests count has gone **up by one** | | |
| G16 | Return to Demo controls and click **Reset demo environment** | A confirmation appears saying it resets fictional data only | | |
| G17 | Confirm the reset, then check Operations ▸ Today | The extra guest request is gone. Everything is back to the start | | |

---

## When you have finished

1. Count your FAILs.
2. For each one, fill in `docs/UAT_ISSUE_TEMPLATE.md` — one copy per problem.
3. Send them all together, with this checklist.

**Please also answer these three, in your own words:**

- Would this help you run the four units each morning? What is missing?
- Is there anything here you would not want an investor to see?
- If this went live tomorrow, what would worry you most?

**A reminder of what is not built yet**, so you do not report these as faults: you cannot
add or edit anything (bookings, expenses, tickets are all read-only in this version); the
AI assistant does not answer questions; there is no WhatsApp or SMS; and the system does
not yet read the real workbook.
