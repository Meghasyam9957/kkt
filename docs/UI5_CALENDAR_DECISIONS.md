# UI-5 — decisions the availability calendar cannot make for you

The calendar is built and read-only. It answers *which unit is free, on which day* from
bookings that already exist, using the occupancy interval the engine already applies. It
invents nothing.

Building it surfaced exactly one gap between what a front office needs and what the
workbook can hold. It is recorded here rather than filled in.

---

## DECISION 1 — a unit cannot be held off-sale for a date range

### QUESTION

How should the product record that a unit is unavailable for **specific dates** for a
reason that is not a guest booking — a maintenance window, an owner or family stay, a
deep clean, a handover between leases, or inventory held back from the OTAs?

### EVIDENCE

Everything the workbook can say about a unit being unavailable is **undated**:

| Where | What it holds | Dated? |
|---|---|---|
| `03_PROPERTIES.PropertyStatus` | One of Available / Occupied / Cleaning / Inspection / Maintenance / Blocked | **No.** The generated contract's own note reads *"Manual base status (Available / Blocked / Maintenance). Live occupancy is derived on the Dashboard."* |
| `14_MAINTENANCE` | A ticket with `DateReported`, a priority and a status | **No window.** There is a report date and a resolution date, but no scheduled from/to during which the unit is out of use. |
| `04_RESERVATIONS` | A booking, with `CheckInDate` and `CheckOutDate` | Yes — but it is a *guest booking*, with a platform, a guest name and a payout. |

So the calendar shows `PropertyStatus` as a **standing label on the unit row**, not as
colour on any day. That is the honest rendering: a manual flag with no dates cannot claim
a span, and painting one over real bookings would hide a guest who is genuinely arriving.

There is **no owner-stay concept anywhere** in the domain, the contract or the code. None
was invented.

### OPTIONS

1. **A dated block sheet.** A new V1 sheet (`BLOCKS`: PropertyID, From, To, Reason,
   Notes) read exactly as reservations are. Every calendar state then has a home, and the
   same half-open interval covers it with no new rule.
   *Cost:* a workbook change, which is a V1 contract change and a regeneration.
2. **Blocks as bookings.** Record a hold as a reservation on a reserved platform value
   ("Owner", "Maintenance"). No schema change, and the calendar would show it today.
   *Cost:* it enters the booking register, so it reaches occupancy, ADR, the cancellation
   rate and the P&L unless every one of those is taught to exclude it — which is a
   business-rule change spread across the engine rather than one new sheet.
3. **Leave it.** Units are held off-sale by hand on the OTAs, and the calendar shows only
   guest bookings.
   *Cost:* the calendar cannot answer "can I sell this night?", only "is a guest in it?"

### RECOMMENDATION

**Option 1**, when a dated block is actually needed. It keeps a block a block: it never
touches revenue, occupancy or the cancellation rate, and it needs no exclusion rule
anywhere in the engine. Option 2 looks cheaper and is not — it puts non-revenue rows into
the register every financial figure is computed from, and each exclusion is a place the
figures can drift from the workbook.

Nothing is blocked on this. The calendar is complete and correct for guest bookings; this
decides only whether it can also speak for the nights nobody is selling.

---

## NOT DECISIONS — recorded so they are not re-opened

- **A cancellation frees the night.** `CANCELLED_STATUSES` are excluded from
  `OCCUPANCY_STATUSES`, so a cancelled booking occupies nothing and the unit reads free.
  That is the domain's answer, not the calendar's, and it is the answer somebody placing a
  booking needs.
- **The departure day is not occupied.** Half-open, `CheckInDate <= day < CheckOutDate`,
  the same bound `occupiedNights` applies. A same-day turnover is one unit-night, and
  back-to-back stays share the changeover date without overlapping.
- **No money on the calendar.** It is an operations surface; the view model carries
  booking identity, dates and status, and no financial field exists on it to withhold.
