# UI-6 — decisions the availability search cannot make for you

The search is built and read-only. It answers *which units are free for these dates* from
bookings that already exist, using the occupancy interval the engine already applies. It
invents nothing.

Building it surfaced one decision that UI-5 had only half met, and one that is genuinely
new. Both are recorded here rather than filled in.

---

## DECISION 1 — an undated master flag, in a dated answer

### QUESTION

`03_PROPERTIES.PropertyStatus` can read `Blocked` or `Maintenance`. Should a unit carrying
that flag be removed from availability results for a future date range?

### EVIDENCE

The flag is **undated**. The generated contract's own note reads *"Manual base status
(Available / Blocked / Maintenance). Live occupancy is derived on the Dashboard."* There
is no from/to anywhere on the property master, in `14_MAINTENANCE`, or in any other sheet
— the gap already recorded as [DECISION 1 in UI-5](UI5_CALENDAR_DECISIONS.md).

The calendar resolved the same tension by refusing to paint a day with it: an undated flag
that erased a booking would hide a guest who is genuinely arriving. A search is a
different shape of the same question, and the stakes point the other way as well as this
way:

| If the flag removes the unit | If the flag only cautions |
|---|---|
| A stale flag somebody set weeks ago silently withholds inventory from every future search. Nobody sees a unit that is not on the list. | A unit under a real, current maintenance hold is offered, and the person has to notice the caution. |

### OPTIONS

1. **Remove the unit from the results.** Treat `Blocked`/`Maintenance` as unsellable for
   every date. *Cost:* an undated value decides a dated question, and the removal is
   invisible — the failure mode is lost revenue nobody can audit.
2. **Show the unit, with the flag stated on the row.** *Cost:* the front office must read
   the caution.
3. **Ask for a dated block sheet first, and do nothing until it exists.** *Cost:* the
   search ships without an answer to a question people will ask on day one.

### RECOMMENDATION — implemented as option 2

The unit stays in **Available**, carries its standing status in words on the row, and
sorts behind every unit that needs no second thought. The reasoning: a wrong "not
available" is silent and a wrong "available with a caution" is not. It also keeps one rule
across both surfaces — *an undated flag never decides a date* — rather than one rule for
the calendar and its opposite here.

This is superseded the moment the workbook gains a dated block, which remains the standing
recommendation in UI-5's DECISION 1. Then `Blocked` for a range is a fact with dates, and
the search should honour it exactly as it honours a booking.

---

## DECISION 2 — the search does not offer a platform filter

### QUESTION

The calendar offers a platform filter. Should the availability search offer one too?

### EVIDENCE

A booking holds the unit whoever sold it. Filtering the register by platform and then
asking "is this unit free" produces a unit reported **free because the booking holding it
was hidden from the query** — the one lie an availability screen must not tell.

The calendar's filter is defensible on its own terms: it is a register view, and a reader
who set a platform filter knows they set one. It is worth noting, though, that a filtered
calendar cell reads "available" for a day held by a booking on another platform. Nothing
in this milestone changed it, and it is listed as follow-up work rather than fixed
silently.

### OPTIONS

1. **No platform filter on the search.** The question "can I sell this night" has no
   platform in it.
2. **Offer one, and exclude filtered bookings from occupancy.** Fast to build, and wrong.
3. **Offer one that narrows only which conflicts are NAMED, never which are counted.**
   Honest, and a control whose effect is hard to explain in a sentence.

### RECOMMENDATION — implemented as option 1

No platform filter. Availability is a property of the unit and the night, not of a sales
channel. If channel-scoped availability ever becomes a real requirement — it will, with a
channel manager — it arrives with allocation rules of its own and should be designed then,
not approximated now.

---

## NOT DECISIONS — recorded so they are not re-opened

- **The departure day is sellable.** Half-open, `CheckInDate <= night < CheckOutDate`, the
  same bound `occupiedNights` and the calendar apply. A booking arriving 12 Sep and
  leaving 15 Sep holds 12, 13 and 14; the unit is free again on the 15th, and a same-day
  turnover is one unit-night.
- **A cancellation frees the night.** `CANCELLED_STATUSES` are excluded from
  `OCCUPANCY_STATUSES`, so a cancelled booking holds nothing and the unit reads free.
- **Capacity is total headcount against `MaxGuests`.** The same comparison
  `reservation.create` validates with. Adults and children are not distinguished anywhere
  in the contract, so they are not distinguished here.
- **No price.** Availability is availability. Rate, total, discount, tax, commission and
  payout are a later business milestone and no field for any of them exists on this view.
- **Ninety nights is an input bound, not a policy.** The search walks every night asked
  for against every unit, so an unbounded range is a denial-of-service dressed as a
  question. It is stated on the form.
