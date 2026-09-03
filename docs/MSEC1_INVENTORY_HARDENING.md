# M-SEC-1 — Inventory write-path, concurrency and staging-readiness hardening

**What changed in one sentence:** stock can now be moved through exactly one path, two
movements on one item can no longer lose an increment inside a process, a retried delivery
can no longer move stock twice, and the Postgres repository that production actually runs is
tested for the first time.

Nothing here adds a business capability. It closes bypasses, races and verification blind
spots in what M-INV-1 shipped.

---

## 1. The canonical inventory write path

```
POST /api/inventory/movements
 → ApiRouter              authenticate → capability (inventory.movement) → handler
 → handler                payload-dependent capability: ADJUSTMENT ⇒ inventory.adjust
 → write() envelope       writes-enabled gate → idempotency → apply → audit
 → InventoryService.recordMovement
      withItemLock(tenant, itemRef)                    ← serialised, per item
        1. read the workbook's Purchased / Used
        2. next = current + quantity
        3. writeTotals(…, { expectedPurchased | expectedUsed })
             → executeMutation(MUTATION_DEFINITIONS['inventory.update'])
                 contract check (refuses calculated columns AND calculated preconditions)
                 → SheetRepository.updateByIdVerified(id, patch, where, expect)
                     get(range)  ← the read that locates the row
                     PRECONDITION checked against THAT read
                     batchUpdate → flush → re-read → verify
                 → operation ledger → audit
           on STALE_PRECONDITION: re-read, recompute, retry (bounded, 3)
        4. record inv_movements with workbook_applied
```

There is no other way. Two independent mechanisms enforce that:

- **`inventory.update` is unroutable.** `assertWriteGovernance` fails the build if any route
  names that action, and `tests/mutations.test.ts` keeps a named `INTENTIONALLY_UNROUTED`
  list so a second unrouted definition has to be written down deliberately.
- **No inventory-domain file may reach a sheets client.**
  `tests/inventory-hardening.test.ts` scans every file under `lib/server/inventory/` plus
  `inventory-handlers.ts` for a sheets-client import, a client construction, or a
  `createRepositories(` call.

### Every write path discovered, and what it carries

| Path | Auth | Tenant | Capability | Verified pipeline | Idempotent | Audits real caller | Can move stock |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `POST /api/inventory/movements` | ✓ | ✓ | ✓ (+adjust) | ✓ | ✓ | ✓ | **yes — the canonical path** |
| `POST /api/inventory/goods-receipts` | ✓ | ✓ | ✓ | ✓ via recordMovement | ✓ | ✓ | yes, by what arrived |
| `POST /api/inventory/movements/:id/repair` | ✓ | ✓ | ✓ `inventory.adjust` | ✓ | ✓ | ✓ | re-applies one recorded movement |
| `PATCH /api/inventory/:id` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **no — schema and mapping both refuse** |
| requests / orders / vendor-links / asset-links | ✓ | ✓ | ✓ | overlay only | ✓ | ✓ | no |
| `MUTATION_DEFINITIONS['inventory.update']` | — | via caller | — | is the pipeline | ✓ | ✓ | yes — **not routable** |
| `SheetRepository.updateById` / `.append` | — | — | — | is the primitive | — | — | yes — layer below; only the pipeline calls it |
| `InMemory` / `Supabase` `InventoryRepository` | — | ✓ arg | — | overlay only | — | — | no — context only, never the sheet |
| `restoreSeedSnapshot` (demo reset) | ✓ | ✓ | `demo.control` | **no — deliberate** | — | ✓ | yes, wholesale |
| `scripts/sheets-write-spikes.mjs` | — | — | — | no | — | — | yes — a script, not reachable from the app |

The last two are **known, accepted exceptions**, recorded rather than fixed:

- **Demo reset** restores a captured seed snapshot wholesale, which is the opposite of a
  movement and cannot be expressed as one. It runs behind `authorizeDemoOperation`, which
  checks the *environment before the caller* — in production the environment check throws, so
  the path does not exist there at all.
- **The write-spike script** holds its own service account and is a developer tool. It is not
  imported by anything the server runs.

---

## 2. The legacy endpoint decision

`PATCH /api/inventory/:id` was classified **an obsolete bypass wearing a legitimate
endpoint's clothes**, and was **narrowed rather than removed**.

**The evidence.** It ran `inventory.update`, whose schema accepts absolute `purchased` and
`used`. The form behind it (`inventoryMovementFields`) asked an operator for *"Purchased
(units) — Cumulative purchased count for this item, as V1 records it."* So the endpoint let
any holder of `inventory.write`:

- set the running totals to any figure, with no employee, no task and no reason;
- leave reconciliation reporting `UNEXPLAINED_MOVEMENT` for the life of the item;
- and — because the number was one the product had never shown them — make stock *fall*
  after a purchase by typing it low.

**Why not removed.** It has real consumers (`components/pages/OpsTables.tsx`, two e2e specs)
and a legitimate job underneath the bypass: an item's reorder level, vendor name, last
purchase details and notes are **master data**, and editing them is not a stock movement.
Requiring a movement to change a reorder level would have been theatre.

**What it is now.** It runs a new definition, `inventory.master.update`, which has no
`purchased` and no `used`. Two independent reasons it cannot move stock:

1. the schema is `.strict()` and does not declare the fields — sending either is a 422;
2. `toColumns` cannot emit `Purchased` or `Used`, so even a schema change would not suffice.

The board's row action is relabelled **"Edit details"**, because that is what it does.

---

## 3. Concurrency — classified honestly

`Purchased` and `Used` are cumulative and the only write path sets them **absolutely**, so a
movement is read-modify-write. Read-after-write verification does *not* catch the resulting
lost update: each writer re-reads and finds exactly the value it wrote.

| Element | Class | Domain in which it holds |
|---|---|---|
| `withItemLock` per `(tenant, itemRef)` | **PREVENTED** | One Node process. Every movement on one item completes before the next begins, so no interleaving exists to lose an increment. |
| Precondition checked against the row-locating `get` | **PREVENTED** | Every interfering write Google had **already applied** when it served that read — another server, a person editing the sheet, an Apps Script. Nothing is written; the caller recomputes. |
| Bounded retry on `STALE_PRECONDITION` | **PREVENTED** | A *user-visible failure* from up to 3 consecutive overtakes. Sound only because the precondition throws strictly **before** `batchUpdate`, so the failure is a clean no-op. |
| Mandatory `expectedPurchased` / `expectedUsed` | **PREVENTED** | A cumulative total set with no stated origin. Structurally impossible: a 422 at schema validation. |
| `inventory.update` unroutable + `inventory.master.update` | **PREVENTED** | Every HTTP caller. No request sets a cumulative cell to an absolute number. |
| Over-receipt guard | **PREVENTED** | A retried goods receipt moving stock twice for lines that already arrived. |
| A writer landing **between** our `get` and our `batchUpdate` | **DETECTED** | Not at write time — both writers' values round-trip. Surfaced at the next reconciliation read as `CONTEXT_AHEAD`. |
| An edit made outside this application | **DETECTED** | Any environment. Surfaced as `UNEXPLAINED_MOVEMENT`. |
| A write that goes out and fails verification | **DETECTED** | Immediately, as `VERIFY_MISMATCH` → 502, effect explicitly unknown. Never auto-retried. |
| `UNAPPLIED_CONTEXT` | **REPAIRABLE** | `POST /api/inventory/movements/:id/repair`, `inventory.adjust`, audited. |
| Compare-and-swap on the workbook | **UNSUPPORTED** | The Google Sheets values API. `batchGet / get / append / batchUpdate / flush` is the whole interface and `batchUpdate` is unconditional — no precondition, no ETag, no revision token. |
| Cross-process mutual exclusion | **UNSUPPORTED** | `withItemLock` is `processSlot`-keyed and process-local. PostgREST is stateless, so session-level `pg_advisory_lock` releases the instant the request returns and would be a lock that never locks. A Postgres lease row was designed and **not built** — see §9. |
| Real-time notification of a residual loss | **UNSUPPORTED** | Detection is read-time. A loss sits unsurfaced until somebody opens the reconciliation screen. |

**We do not claim prevention where only detection exists.** The residual window — between
Google serving our read and accepting our write — is real, is narrower than it was (it used
to be a whole HTTP round trip), and is not closed.

---

## 4. Idempotency and partial failure

| Attack | Result |
|---|---|
| Duplicate request, same key, same body | Replayed. One movement, one increment. |
| Same key, different body | `409 OPERATION_MISMATCH`. |
| **Same key, different `:id` in the path** | `409 OPERATION_MISMATCH` — **fixed in M-SEC-1**; see below. |
| Another tenant's operation id | `409 OPERATION_MISMATCH`, never a replay of the other tenant's result. |
| Retry after workbook success, before context success | Operation recorded **failed**; the sheet did move. Surfaced, not hidden — a person must look. |
| Retry after workbook failure | Movement recorded `workbook_applied = false`. Nothing claims the stock changed. |
| Duplicate goods receipt | `409 PO_NOT_RECEIVABLE` (fully received) or `409 OVER_RECEIPT` (partially). Stock moves once. |
| Duplicate procurement transition | `409 INVALID_TRANSITION`. |

**The hash defect.** The inventory envelope hashed `entityId: operationId`, which makes the
hash *constant for a given operation id*. Two requests with one retried id and the same body
but different path ids hashed identically, so the second was answered `verified` and handed
the first one's stored result — approving request A twice, telling the caller B had
succeeded, and leaving B untouched. Finance and HR had always hashed
`ctx.request.params?.id`; inventory did not, and every existing test varied the operation id
too, so nothing saw it.

**The window that cannot be closed.** The workbook and Postgres are two stores with no shared
transaction. If the sheet takes the write and the overlay then refuses the context row, the
operation is marked failed and the stock has moved. That is reported, not swallowed: the
strongest recoverable state available is *"the caller is told, and a person decides"*.

---

## 5. Reconciliation and repair

Reconciliation is **read-only** and asserted to be: three consecutive reads leave both stores
byte-identical.

| Status | Meaning | Repairable? |
|---|---|---|
| `MATCHED` | events and totals agree | — |
| `UNEXPLAINED_MOVEMENT` | the sheet moved by more than we can explain | No. Ordinary for all pre-existing history and any hand edit. |
| `CONTEXT_AHEAD` | we recorded a movement the totals never took | **No — detected only.** See below. |
| `UNAPPLIED_CONTEXT` | recorded while the sheet refused | **Yes**, via repair. |
| `STOCK_UNAVAILABLE` | no totals to compare | — |

### The one repair

`POST /api/inventory/movements/:id/repair` — capability **`inventory.adjust`** (not
`inventory.movement`: re-applying changes the stock figure without anybody recording a new
fact, which is the correcting power, and OPERATIONS deliberately lacks it).

It takes **an id and nothing else**. It refuses a movement already applied, refuses another
tenant's, re-reads the *current* total and adds to that (replaying the original arithmetic
would discard every movement recorded since the failure), marks the row applied only if the
workbook took it, and writes an audit record. It never fabricates a movement, invents a
quantity, or alters the original context.

### Why `CONTEXT_AHEAD` has no repair

It is arithmetic, not caution. An `ADJUSTMENT` raises the workbook by N **and** records a
context row of N, so a gap of 4 becomes a gap of 4 again — it never converges. Re-applying
the original movement is refused because that row is already marked applied. What closes it
is a person deciding whether the workbook or the record is right. The product reports the
divergence precisely and does not pretend to resolve it.

---

## 6. Tenant isolation

Two tenants share **one** overlay repository in the suites, so only the tenant predicate
separates them. Every identifier the domain addresses — item, movement, request, order, order
**line**, receipt, receipt line, asset, vendor, employee, property, operation — is refused as
`404 not found` rather than "not yours", so a refusal cannot confirm a foreign id is real.

**Two holes were found and closed:**

- `receiveGoods` was the only property-taking path with no `assertOwnProperty`. A delivery
  could be attributed to a property the business does not operate, or to a string that is not
  a property at all, and stored. Not a cross-tenant read — receipts are tenant-scoped — but a
  hole in an otherwise uniform rule, which is the kind that survives review.
- The **Supabase repository was executed by no test at all** — see §7.

**Known and deliberate:** `linkAssetTicket` resolves `assetRef` against the caller's own
workbook but stores `ticketRef` as given, because a customer legitimately references tickets
this product never created. Nothing crosses a tenant boundary. Any future screen joining
`linkedTickets` back to a maintenance row must do that lookup in the caller's own data and
treat a miss as ordinary; the reference is not proof the ticket is theirs.

---

## 7. The verification blind spot this milestone found

`lib/server/api/service.ts` returns `SupabaseInventoryRepository` the moment a Supabase client
exists — which is every configured deployment — and the in-memory twin only when one does
not. **Every isolation assertion written for M-INV-1 ran against the fallback.** The
repository production actually executes was constructed in exactly one place in the tree and
in no test: its tenant predicates were correct by inspection and by nothing else.

This is not hypothetical here. `SupabaseAuditSink` shipped with `tenant_id` missing from its
insert while the in-memory twin carried it and the whole suite stayed green.

`tests/inventory-isolation.test.ts` closes it by recording the query chain the repository
builds — the only way to see an `.eq('tenant_id', …)` that was never written. It asserts every
read carries the predicate, every insert stamps the tenant **last** (so a caller-supplied
`tenant_id` cannot win), every update carries **both** predicates, the repository refuses to
build any query without a tenant, no `updated_at` is sent to a table that has none, and the
two twins expose the same method surface.

---

## 8. Role projection

Unchanged from M-INV-1 and now attacked directly: no inventory or procurement payload emits
`tenantId`, `employeeId`, or any compensation field; OPERATIONS reads `pricesWithheld` /
`costWithheld` with `null` money rather than a blank that would read as "nothing was agreed";
`procurement.approve` remains in `FINANCIAL_CAPABILITIES`; INVESTOR reaches no inventory
route, readable or writable.

---

## 9. Staging readiness

**Nothing hosted was run, and no credentials were requested.** `resolveStaging` currently
returns `CONFIGURATION_REQUIRED`.

**READY TO RUN** (no external dependency)
- the whole offline gate: contract, typecheck, lint, secret scan, unit suites, build
- `npm run db:check` — migrations and RLS against **real PostgreSQL 18.3 via PGlite**
- `npm run e2e` — Playwright against the demo dev server

**CONFIGURATION REQUIRED** (names only; never values, never in chat)
| Variable | For |
|---|---|
| `STAGING_SUPABASE_URL` | the disposable staging project |
| `STAGING_SUPABASE_ANON_KEY` | publishable key |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | trusted server key |
| `STAGING_CONFIRMED_NOT_PRODUCTION` | explicit declaration the project is disposable |
| `STAGING_DATABASE_URL` | optional — direct connection for migrations and catalog checks |
| `PARITY_SHEET_ID`, `PARITY_SERVICE_ACCOUNT_FILE` | optional — live workbook parity |

A tenant row and a membership for the test principals must also exist in the staging control
plane before the staging suite can resolve a workbook.

**NOT VERIFIED**
- Anything against hosted Supabase: RLS as PostgREST enforces it, the composite FKs under a
  real writer, the Supabase repository against a real schema. PGlite proves the **migration
  and the policies**; it does not prove **Supabase**.
- Cross-process concurrency. Every concurrency test here runs in one process, which is the
  domain in which the lock is claimed to work. The multi-instance case is classified
  UNSUPPORTED above and is not tested because it cannot be prevented.

---

## 10. Residual limitations

1. **The residual write window is real.** Between Google serving our read and accepting our
   write, another process can still land. Detected at the next reconciliation, never
   prevented, and no notification is pushed — somebody must open the screen.
2. **A Postgres lease row would extend prevention across processes** and was deliberately not
   built: it needs a migration, a TTL, and a fail-closed story for lease-backend errors, and
   it is worthless in demo/dev where no Supabase exists. Designed, classified, not shipped.
3. **`reconcileStatus` reports one condition per item.** An item with both an unapplied
   context row and a lost update reports the first. No false `MATCHED` results from this —
   both conditions are non-`MATCHED` — but the second is hidden until the first is repaired.
4. **The two-store window** (§4) cannot be closed without a distributed transaction the
   provider does not offer.
5. **`stockApplied` was wrong until this milestone** — the receipt view was built from the
   receipt as *created*, before movements were attached, so a perfectly applied delivery
   reported `false` on every line. Fixed; worth knowing it shipped that way.
