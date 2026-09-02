# M-INV-1 — Inventory, Procurement and Assets

**One sentence:** the workbook owns how much stock exists; Postgres owns why it moved, who
moved it, what was ordered, and which repair was about which asset.

Everything below follows from that sentence. If you read only one section, read
[The one ledger rule](#the-one-ledger-rule).

---

## 1. The one ledger rule

`15_INVENTORY` is the authoritative stock ledger. It holds `OpeningStock`, `Purchased` and
`Used` as inputs, and `CurrentStock` and `ReorderStatus` as **formulas the sheet owns**.

Nothing in this codebase recomputes a stock balance. Specifically:

| Question | Answered by | Never by |
| --- | --- | --- |
| How much is there? | `15_INVENTORY.CurrentStock`, the sheet's own formula | any code here |
| Is it below par? | `statusOf(currentStock, minStock)` — a *label* over the sheet's two numbers | a stored status column |
| How much has been bought/used in total? | `15_INVENTORY.Purchased` / `.Used` | a sum of `inv_movements` |
| Why did it move? | `inv_movements` | the workbook, which has no column for it |
| Who moved it? | `inv_movements.employee_id` | the workbook |

`inv_movements.quantity` is the size of **one event**. It is never summed into a balance
anywhere in the schema, and `tests/inventory.test.ts` reads migration `0011` to assert that no
`current_stock`, `balance`, `on_hand` or `closing_stock` column has appeared in that table.

### Why a "second ledger" is the expensive failure

Two systems that each believe they hold the stock figure produce a business that cannot answer
how many towels it owns. The disagreement surfaces at the worst moment — a delivery ordered
against a number nobody can reproduce — and by then both records have months of history
behind them. This is why the boundary is enforced by tests and by a schema scan, not by
convention.

---

## 2. The write path

A movement touches two stores and they cannot be written atomically. **The sheet goes first**,
because stock is its fact.

```
POST /api/inventory/movements
  → ApiRouter          authenticate → capability (inventory.movement) → handler
  → handler            payload-dependent capability: ADJUSTMENT needs inventory.adjust
  → write() envelope   writes-enabled gate → idempotency (OperationStore) → apply → audit
  → InventoryService.recordMovement
      1. validate (quantity, item exists in the CALLER'S workbook, employee, property, …)
      2. read the sheet's own Purchased/Used
      3. writeTotals()  ─────►  executeMutation(MUTATION_DEFINITIONS['inventory.update'])
                                  → contract check (refuses CurrentStock, ReorderStatus)
                                  → sheet write
                                  → read-after-write verification
                                  → audit
      4. record the context row in inv_movements, workbook_applied = (3) succeeded
```

There is **no second write path into `15_INVENTORY`**. `writeTotals` runs the existing
`inventory.update` mutation rather than reaching for a sheets client, so the sheet write keeps
its contract check, its verification, its operation ledger row and its audit record.

### Failure ordering, stated rather than hidden

| Order | Failure after the first store | Result |
| --- | --- | --- |
| **sheet then overlay** (chosen) | stock is correct, context is missing | the movement row is still written with `workbook_applied = false` — a visible repair item |
| overlay then sheet | this database asserts a movement the workbook never saw | the second ledger, and a wrong one |

### The concurrency limit

`Purchased` and `Used` are cumulative totals and the only write path sets them **absolutely**,
so recording a movement is a read-modify-write. Two movements on the same item at the same
moment can lose one increment. That is a genuine limitation of a spreadsheet as a ledger and
this milestone does not fix it — fixing it would mean becoming the second ledger.

What it *does* do is make the loss visible: both context rows are recorded, so the sum of
events and the workbook's totals disagree, and reconciliation reports `CONTEXT_AHEAD`. Before
this overlay existed the same lost update was completely undetectable.

**Pre-existing defect this milestone also fixed:** the only way to change stock used to be
`PATCH /api/inventory/:id` with an absolute `Purchased`/`Used` figure that the product had
never shown the operator. Typing it wrong made stock *fall* after a purchase, with nothing to
notice. The service now reads the current total and adds to it server-side.

---

## 3. Reconciliation — a comparison, never an authority

`GET /api/inventory/reconciliation` compares **sums of events** against **cumulative totals**.
It recomputes no stock, repairs nothing, and prefers neither store. Reading it writes nothing.

| Status | Meaning | Ordinary? |
| --- | --- | --- |
| `MATCHED` | every movement we hold is in the workbook's totals | yes |
| `UNEXPLAINED_MOVEMENT` | the sheet moved by more than we have context for | **yes** — everything predating this feature, and any edit made in the sheet |
| `CONTEXT_AHEAD` | we recorded a movement the totals never took | no — a write that did not land |
| `UNAPPLIED_CONTEXT` | a movement was recorded while the sheet refused it | no — needs repair |
| `STOCK_UNAVAILABLE` | the workbook row carries no totals to compare | — |

The first two are named separately on purpose. Merging them into "mismatch" would send
somebody to investigate ordinary history as though it were a bug.

---

## 4. What Postgres owns (migration `0011`)

Nine tables, all RLS-enabled and revoked from `authenticated`/`anon`, all reached only through
the service role behind the API.

| Table | Holds | Explicitly does **not** hold |
| --- | --- | --- |
| `inv_vendor_links` | which `finance_vendors` row a workbook vendor NAME means | a vendor. `finance_vendors` is the only vendor identity — no second supplier master |
| `inv_movements` | one event: type, quantity, employee, task, reason, wastage cause, counterparty | a balance, a valuation, a cost |
| `inv_purchase_requests` (+ lines) | somebody asked | a commitment |
| `inv_purchase_orders` (+ lines) | the business promised a vendor; `expected_unit_price_minor` | an amount owed |
| `inv_goods_receipts` (+ lines) | what physically arrived | a bill |
| `inv_asset_maintenance_links` | asset ↔ ticket | the asset. `16_ASSETS` is the register |

Integrity that is enforced twice, in the application AND in the schema:

- **Tenant scope** — every composite foreign key is `(tenant_id, id)`, so another customer's
  vendor, employee or order cannot be referenced. The service *also* resolves each identifier
  through a tenant-scoped repository, because the database is the last boundary and never the
  only one.
- **Separation of duty** — `inv_purchase_requests_no_self_approval` and
  `inv_purchase_orders_no_self_approval` are CHECK constraints; `InventoryService` refuses the
  same case first. A rule that lives only in application code holds only while every path
  remembers it, and procurement approval is exactly the rule somebody will one day want to
  skip "just this once".

---

## 5. Procurement — four things kept apart

| Step | Commits | Moves stock | Owes money |
| --- | --- | --- | --- |
| request | no | no | no |
| purchase order | to the vendor | **no** | no |
| goods receipt | — | **yes, by what arrived** | **no** |
| bill (`finance_bills`) | — | no | yes |

A receipt is accepted only against an order that is `SENT` or `PARTIALLY_RECEIVED`. Treating an
order as received stock is the commonest way an inventory system starts lying — twenty ordered
and eighteen delivered is the ordinary case, not the exception.

**No bill, payment or expense is created anywhere in this domain.** Stock arriving and money
being owed are different claims that routinely disagree, and a person raises the second one in
finance.

A received line for something not in `15_INVENTORY` (a replacement door handle) is recorded as
received and moves no stock — there is nothing to move, and creating an item would be a second
item master.

---

## 6. Capabilities

New in `lib/shared/roles.ts`:

| Capability | ADMIN | OPERATIONS | Why |
| --- | --- | --- | --- |
| `inventory.movement` | ✓ | ✓ | recording why stock moved is operational work |
| `inventory.adjust` | ✓ | — | correcting the count itself is how a discrepancy stops being a question anybody asks |
| `inventory.assets` | ✓ | ✓ | a supervisor needs to know which unit's air conditioner is broken |
| `procurement.read` | ✓ | ✓ | |
| `procurement.request` | ✓ | ✓ | asking is operational |
| `procurement.receive` | ✓ | ✓ | a supervisor signs for what arrived |
| `procurement.approve` | ✓ | — | committing the business to spend is a finance decision |

`procurement.approve` is listed in `FINANCIAL_CAPABILITIES`, so the invariants that already
existed — *OPERATIONS and INVESTOR hold no financial capability* — now cover procurement for
free. That is the intended way to extend this system: add to the list, and rules written before
the feature existed start guarding it.

Two checks are **payload-dependent** and therefore live in the handler rather than on the
route:

- an `ADJUSTMENT` movement additionally requires `inventory.adjust`;
- `APPROVED`/`REJECTED` on a request additionally requires `procurement.approve`, while
  `SUBMITTED`/`CANCELLED` need only `procurement.request` — otherwise a supervisor could not
  submit the request they had just written, which is not a control but a dead end.

### Money projection

`purchaseOrderView(po, maySeePrices)` and `assetItemView(asset, maySeeCost)` project money
**conditionally**, by capability read from the same table the handler reads. Withheld money is
`null` **with a flag** (`pricesWithheld`, `costWithheld`) so a screen can say "not shown to
you" rather than "nothing was paid". Those are very different sentences.

Compile-time `Disjoint<T, Withheld>` guards refuse to build if a withheld field ever appears in
a payload.

---

## 7. Route governance

`assertWriteGovernance` gained a sixth classification, `writesInventory`. Every non-GET route
must declare **exactly one** of `mutates | nonMutating | writesFinance | writesHr | writesOps |
writesInventory`, and an inventory-writing route must live under `/api/inventory/` and carry an
`inventory.*` or `procurement.*` capability.

Thirteen routes were added. `GET /api/inventory` (the operations board's stock list) is
unchanged.

---

## 8. Assets

`16_ASSETS` existed in the contract and in `lib/shared/domain.ts` with **no grid behind it and
no screen in front of it**, so every appliance the business owns was invisible to the product.
M-INV-1 added the demo grid, the repository and the screen. No Postgres asset table was
created: the register is the workbook's.

Two corrections the reading surfaced:

- `AssetRecord.condition` said `'Damaged'`, a value the sheet's own validation would refuse.
  The workbook's list is New / Good / Fair / Poor / **Broken**. Nothing had ever written the
  field, because nothing wrote assets at all, so the mismatch was invisible until something
  read it.
- The demo `15_INVENTORY` grid never laid `Category` or `Vendor`, though the dataset always
  carried both — so every demonstration item read back with no category and no vendor.

**Warranty is answered twice, on purpose.** `warrantyLabel` is the workbook's own calculated
`Warranty` cell, carried through verbatim. `warrantyState` is a forward-looking signal derived
from the `WarrantyExpiry` **input** column (`ACTIVE` / `EXPIRING` within 60 days / `EXPIRED` /
`UNKNOWN`). The sheet says whether a warranty is live today; the derived signal says whether it
is about to stop being live, which is the only version of the question anybody can act on.

### What is deliberately not modelled

No depreciation. No net book value. No useful-life amortisation. No inventory valuation, FIFO,
weighted average or COGS. No statutory tax treatment. No automatic expense recognition.

`purchaseCostMinor` is **what was paid**. Rendering a purchase price as a book value would be
an accounting claim nobody has made, and the difference between the two is somebody's tax
position. `tests/inventory.test.ts` scans the domain source for these terms as code.

---

## 9. Screens

| Route | Capability | What it is for |
| --- | --- | --- |
| `/admin/inventory` | `inventory.read` | stock, status, vendor identification, and the movement action |
| `/admin/inventory/movements` | `inventory.read` | one line per event; deliberately totals nothing |
| `/admin/inventory/procurement` | `procurement.read` | request → decide → order → send → receive |
| `/admin/inventory/assets` | `inventory.assets` | the register, with linked tickets |
| `/admin/inventory/reconciliation` | `inventory.read` | where the two records differ |

`/admin/operations/inventory` is unchanged — it remains the shift board's stock list.

The Today board's out-of-stock alert now points at Procurement. Before this milestone,
"reorder today" was advice with nowhere in the product to act on it.

**No screen enforces a rule the server owns.** The movement form asks for a wastage cause and a
correction's direction as optional fields; the server refuses with a named code and a sentence,
which the form shows. A second copy of those rules in the browser is a second thing to keep in
step.

---

## 10. Verification

| Check | Result |
| --- | --- |
| `tests/inventory.test.ts` | 58 cases — one-ledger, isolation, RBAC, workbook consistency, reconciliation, procurement lifecycle, assets, governance |
| Mutation battery | 20 deliberate regressions applied to shipped source; **20/20 caught** |
| `e2e/inventory.spec.ts` | 10 cases in a real browser |
| Migration `0011` against real PostgreSQL (PGlite) | applies clean; 39 tables, RLS on every one |

The two-tenant suite shares **one** in-memory overlay repository, HR repository and finance
repository between both tenants, so only the tenant predicate separates them. A harness that
gave each tenant its own store would pass every isolation case while proving nothing.
