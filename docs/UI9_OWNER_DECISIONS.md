# UI-9 — there is no owner, and no property to own

UI-9 asked for an owner experience: *what properties do I own, and how is each one
performing*. The product cannot answer either half of that question, and the reason is not
a missing screen. This is the evidence, what was built instead, and what a real decision
would have to settle.

---

## DECISION 1 — "owner" is not a concept this product has

### QUESTION

Can a person sign in and see the properties they own?

### EVIDENCE

**There is no ownership relation anywhere, in either direction.**

`10_INVESTORS` holds: `InvestorID`, `InvestorName`, `InvestmentAmount`, `InvestmentDate`,
`ParticipationPct`, `Status`, `AgreementRef`, `Contact`, `Notes`. No property column.

`03_PROPERTIES` holds: `PropertyID`, `Floor`, `Unit`, `BHKType`, `Bedrooms`, `MaxGuests`,
`PropertyStatus`, `ListingStatus`, the two OTA listing ids, `MonthlyRent`,
`SecurityDeposit`, `LeaseStart`, `LeaseEnd`, `Landlord`, `MaintenanceCharge`, `Notes`. No
investor column, and no owner column.

And the shape of those property fields says why. `MonthlyRent`, `SecurityDeposit`,
`LeaseStart`, `LeaseEnd` and `Landlord` describe a business that **leases** its units. The
`Landlord` is a free-text name of the third party the business pays rent to — not a user,
not a role, not a party with a position in the product.

The investor is not a property owner either. `ParticipationPct` carries the contract's own
note: *"Share **WITHIN the investor pool**. Active investors must total 100%."* An investor
holds a share of the **business**, not of a unit. That is why
`InvestorService.portfolio()` is portfolio-level and why the existing screen says so in as
many words: *"Portfolio-level figures; nothing below is specific to a guest or a unit."*

The word "owner" appears in exactly one place in the entire codebase: `Owner Capital In`
and `Owner Drawing`, two values in the `CASH_TYPE` list. They are cash-flow categories for
the proprietor's own money movements. There is no owner entity behind them.

### WHAT THAT MEANS

"My properties" cannot be built. Not "is hard to build" — there is no relation to filter
on, so *every* investor would see *every* property. That would be two failures at once:

1. **An invented ownership model.** The screen would assert a relationship the business has
   not defined.
2. **A disclosure widening.** Per-property revenue, occupancy and operating result to a
   party whose approved scope is portfolio-level only. That is a business decision about
   what investors may see, and it has not been made.

### OPTIONS

1. **Build within the model that exists** — a portfolio experience, stated as portfolio
   level, with the naming gap documented.
   *Cost:* the brief's per-property questions stay unanswered.
2. **Add ownership to the contract** — an owner entity, an owner↔property relation, an
   owner role and grant, and a decision on per-property disclosure.
   *Cost:* a V1 contract change, a role change, and a commercial decision about what an
   owner is entitled to see. All three are business decisions.
3. **Treat every investor as an owner of everything.** *Cost:* both failures above.

### RECOMMENDATION — implemented as option 1

Option 2 is the honest route to what UI-9 described, and it is **blocked pending a business
decision**. It needs answers to:

- Is an owner a distinct party from an investor, or the same party renamed?
- Does an owner own **units** (a per-property stake) or a **share of the business** (what
  `ParticipationPct` already models)? The two are different products.
- If units: is `Landlord` that party, or a different one? The business leases from
  landlords, so a landlord is a creditor, not a shareholder.
- What is an owner entitled to see per property — occupancy only, or revenue, or the
  operating result including cost detail the investor scope currently excludes?

Until those are answered, no per-property figure can be shown to a non-management role
without inventing the answer.

---

## DECISION 2 — no statement can be released, and the reason is two-fold

### QUESTION

Can an investor be shown a financial statement for a period?

### EVIDENCE

`InvestorService.reports(investorId, approvedMonths)` exists and is correct — it offers a
statement only for months management has approved. It is also **entirely uncalled**,
because nothing supplies `approvedMonths`: `18_MONTHLY_CLOSE` is a sheet in the contract
that no repository reads.

Separately, the distribution rules are unset in the demonstration environment, so
`computeInvestorWaterfall` reports `configured: false` and the existing management screen
already says a statement cannot be released while that is true — *"a statement showing ₹0
would misrepresent the position"*.

### RECOMMENDATION — the unavailable state, naming both preconditions

Wiring the monthly-close read would supply half of one precondition and still produce no
statement, because there is no statement document and no approved distribution rule behind
it. The investor's own screen therefore states what is missing, in the same words the
management screen uses, and offers nothing that looks like a statement.

---

## NOT DECISIONS — recorded so they are not re-opened

- **No forecast on the investor screen.** The deterministic forecast exists and is
  management's, under `analytics.read`, which the investor role does not hold. Showing it
  would widen a capability — a decision, not an implementation.
- **Expenses stay out.** `operatingExpenses`, `expenses` and `vendor` are in
  `INVESTOR_FORBIDDEN_FIELDS` and the portfolio view carries none of them. Operating
  profit is approved; the costs behind it are not.
- **The investor shell is already dedicated.** A masthead with no management sidebar, and
  one route. It was never "the admin console with the menu hidden" — the navigation for
  every management entry is filtered by capability, and the investor holds none of them.
