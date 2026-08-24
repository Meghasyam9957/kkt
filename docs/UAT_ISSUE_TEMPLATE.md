# UAT Issue Report

Copy everything below the line into an email, a document or a message — one copy per
problem. Do not try to bundle several problems into one report; separate ones get fixed
faster.

**You do not need to know why something went wrong.** Describing what you did and what you
saw is the whole job.

---

**Screen**
*Which page? The title at the top of it is enough — e.g. "Today's operations", or paste the
web address.*

**Role**
*Which account were you signed in as? Demo Administrator / Demo Operations Manager /
Investor Demo A / Investor Demo B / not signed in*

**Scenario** *(if you know it — the chip in the top-right of the header)*
*Normal day / High occupancy / Operations issue / Financial review / Investor review /
Guest support*

**Steps**
*What you did, in order. Number them. Be boring and literal — "clicked X, then Y" is more
useful than "tried to look at the bookings".*

1.
2.
3.

**Expected**
*What you thought would happen.*

**Actual**
*What actually happened. If a number looked wrong, write the number down.*

**Severity** *(your judgement — see the guide below)*
P0 / P1 / P2 / P3

**Screenshot**
*Attach one if you can. On Windows press `Windows + Shift + S`; on a Mac press
`Cmd + Shift + 4`. A photo of the screen with a phone is fine too.*

**Notes**
*Anything else. Does it happen every time or only sometimes? Which browser? Did anything
unusual happen just before?*

---

## Choosing a severity

Do not agonise over this — a rough guess is fine, and we will adjust it.

| | Means | Examples |
|---|---|---|
| **P0 Critical** | Wrong data, or someone can see something they should not | An investor can see another investor's figures · a number is plainly wrong · Operations can open a financial screen · real data appears anywhere |
| **P1 High** | A main task cannot be completed | A page will not load · sign-in fails · a screen is empty when it should have data · a filter does nothing |
| **P2 Medium** | It works, but it is awkward or unclear | A figure is hard to find · a label is confusing · a table is hard to read on a laptop · the wrong month is selected by default |
| **P3 Cosmetic** | It looks wrong but works | Misaligned text · an odd colour · a typo · uneven spacing |

**When in doubt, choose the higher one.** Anything involving a wrong number or something
visible that should not be is always **P0**, however small it looks.

---

## Please do not report these — they are not built yet

- You cannot add, edit or delete anything. Every screen is read-only in this version.
- The AI assistant does not answer questions. The screen is a placeholder.
- There is no WhatsApp, SMS or email to guests.
- The system does not read the real workbook yet.
- Housekeeping, Maintenance and Inventory in the menu all lead to the Today screen. Their
  own screens come later.
- Investor "Reports" is empty. Statements come in a later phase.

## Worth reporting even though everything is fictional

- Numbers that cannot be right — occupancy above 100%, negative guests, a total that does
  not match its parts.
- Anything that does not look like a real Hyderabad homestay would look.
- Anything you would need each morning that is not there.
- Anything you would not want an investor, a guest or a supplier to see.
