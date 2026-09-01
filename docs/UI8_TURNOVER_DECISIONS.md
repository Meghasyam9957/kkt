# UI-8 — what the turnover data can and cannot say

The brief asked for a connection between a booking and the turnover that follows it, and
was explicit that the connection had to be *proved* rather than assumed. It could not be.
This is the evidence, and what was built instead.

---

## DECISION 1 — there is no provable booking → turnover relationship

### QUESTION

`13_HOUSEKEEPING` carries a `BookingID` column. Can the product say "these are the
turnovers for this booking"?

### EVIDENCE

Five findings, each checked in the code rather than inferred:

| # | Finding | Where |
|---|---|---|
| 1 | The column exists and is writable (`role: in`, `type: listRange`). | generated contract, `HOUSEKEEPING` |
| 2 | `housekeeping.create` writes whatever it is handed: `bookingId: z.string().max(24).optional()`. **Optional, and never checked against the register.** `revenue.create` *does* check its `bookingId` against 04_RESERVATIONS — so the absence of that check here is a deliberate difference, not an oversight in one place. | `lib/server/api/schemas.ts`, `mutation-services.ts` |
| 3 | Nothing makes it unique, and nothing limits how many turnovers may name the same booking. Two `housekeeping.create` calls with the same `bookingId` both succeed and both allocate their own `TaskID`. | proved by test |
| 4 | **Every seeded turnover in both demo sources leaves it empty.** The fixture dataset has no such field, and the demo grid builder lays no `BookingID` cell at all. | `lib/data/fixtures/workbook.ts`, `lib/server/demo/workbook-grids.ts` |
| 5 | Until UI-8 the repository did not read it, so no view could have used it either way. | `repositories/index.ts` |

### WHAT THAT MEANS

The cardinality is **0..n turnovers per booking, 0..1 unvalidated reference per turnover**.
A reference may name a booking that does not exist. A booking with no referencing turnover
may still have been cleaned ten times.

So the field can be read in exactly one direction:

- **Forward — a turnover naming a booking.** The value is on the row. It is the only
  evidence there is, and it is what somebody recorded on purpose.
- **Backward — a booking listing its turnovers.** Impossible. "This booking has no
  turnovers" would be indistinguishable from "nobody filled in the column", which is the
  state of every seeded row in the product today. A screen that said it would be lying.

### OPTIONS

1. **Read it forward only.** The turnover register shows the reference it carries, with
   the guest's minimised name when the register actually holds that booking and an honest
   "not in the register" when it does not. The booking panel keeps showing **unit-level**
   state, titled for the unit.
   *Cost:* a front office cannot ask "what happened to my booking's unit afterwards" in
   one place.
2. **Add the join anyway**, listing turnovers on the booking panel.
   *Cost:* it reports absence as fact. Every booking in the demo would show "no turnovers"
   over a workbook that simply never filled the column.
3. **Make `BookingID` required and validated**, and backfill it.
   *Cost:* a V1 contract change, a validation rule, and a migration of existing rows — a
   business decision about how turnovers are raised, not a UI one.

### RECOMMENDATION — implemented as option 1

Nothing is blocked. If the business wants the backward direction, option 3 is the honest
route and it starts with a rule: *a turnover raised after a stay must name that stay*.
Until then the reference is a note, and the product treats it as one.

---

## DECISION 2 — no turnover is created automatically at check-out

### QUESTION

Should checking a guest out raise the housekeeping task for the unit?

### EVIDENCE

Nothing in the write pipeline chains one mutation to another. `reservation.checkOut`
writes to 04_RESERVATIONS and stops; `housekeeping.create` is its own operation with its
own operation id, its own audit record and its own idempotency. There is no mechanism for
one mutation to trigger another, and building one would be a new architectural behaviour
affecting every write in the product, not a screen.

### RECOMMENDATION — not built

The brief said not to invent an automation rule that the architecture does not already
support, and it does not. What UI-8 added instead is the **existing next step**: a checked
out booking's panel links to the turnover register for that unit, and a person decides. The
check-out toast already says the unit needs a turnover.

Worth noting for whoever picks this up: `MaintenanceRequired`, which UI-7 made writable at
check-out, is likewise a flag on the booking and raises no ticket. Same reason, same shape
of decision.

---

## RESOLVED — the inspection result is readable after all

UI-7 reported `InspectionStatus` as unavailable. That was half right and worth correcting:

- `FinalStatus` **is** the canonical turnover state, and `Failed Inspection` is one of its
  values — so the repository comment was correct that the inspection is folded into it.
- But `InspectionStatus` is a `role: in` column of its own with the `INSPECTION` list
  (Pending / Passed / Failed), and **`housekeeping.update` already writes it** — the
  mark-clean form has asked for it since it was built. It was written to the workbook and
  never read back, so a front office recorded an inspection result it could never see again.

UI-8 reads it and shows it verbatim beside the status. Nothing derives one from the other,
and `Failed Inspection` remains a `FinalStatus` value: they are related, not redundant.

`Cleaner` was in exactly the same position — written by both housekeeping mutations, never
read — and is now shown as *who is handling it*.

---

## NOT DECISIONS — recorded so they are not re-opened

- **Maintenance stays unit-level.** `14_MAINTENANCE` has no booking column at all, so
  there is not even an unvalidated reference to consider.
- **A turnover has no priority.** `13_HOUSEKEEPING` has no priority column; maintenance
  does. The register does not show one rather than inventing a ranking.
- **The demonstration data was not seeded with booking references.** Cleaners and
  inspection results were added to the demo dataset — fiction of the same kind it already
  carries — but `BookingID` was deliberately left empty, because seeding it would
  manufacture the very relationship this document declines to claim.
