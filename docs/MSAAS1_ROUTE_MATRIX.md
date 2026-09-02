# M-SAAS-1 — route tenant-sensitivity matrix

Every route the application exposes, and what enforces tenancy on it after M-SAAS-1.

Roles: **SA** SUPER_ADMIN · **A** ADMIN · **O** OPERATIONS · **I** INVESTOR.

## How to read the "tenant-enforced" column

**YES — data source.** The handler obtains its data through `getDataProvider(tenant)` or
`tenantRepositories(tenantId)`, both of which resolve the tenant's own workbook from
`tenant_workbooks` and refuse an unregistered or suspended tenant. This is the enforcement
that M-SAAS-1 adds, and it is the one that matters: it is not a check that a handler
performs, it is the only way a handler can obtain data at all.

**N-A — no handler.** The route is declared, so the guard authenticates it,
capability-checks it and audits the attempt, and it then returns 501 NOT_IMPLEMENTED. No
data is served because no handler exists.

**N-A — no business data.** Session and gateway routes.

## Why there is no per-row tenant check

One workbook per tenant means an identifier belonging to another tenant does not exist in
the workbook the request resolves to. `PATCH /api/reservations/BK-2026-0007` as tenant A
reaches tenant A's workbook and finds nothing. There is no comparison to forget and no
query to widen. See [MSAAS1_DATA_BOUNDARY.md §2](MSAAS1_DATA_BOUNDARY.md).

That property is asserted, not assumed:
`tests/tenant-isolation.test.ts › refuses to amend a booking that belongs to the other
tenant` creates a real booking in tenant B and attempts a well-formed PATCH on it as a
fully-authorised ADMIN in tenant A. Before this milestone the same request would have
succeeded.

---

## Implemented read routes

| route | method | capability | roles | tenant obtained | business data | tenant-enforced |
|---|---|---|---|---|---|---|
| `/api/analytics/dashboard` | GET | `dashboard.financial.view` | SA A | `requireTenant(ctx.auth)` → `await provider(tenant)` | yes | **YES — data source** |
| `/api/analytics/timeseries` | GET | `analytics.read` | SA A | same | yes | **YES — data source** |
| `/api/analytics/by-property` | GET | `analytics.read` | SA A | same | yes | **YES — data source** |
| `/api/analytics/by-platform` | GET | `analytics.read` | SA A | same | yes | **YES — data source** |
| `/api/analytics/alerts` | GET | `operations.view` | SA A O | same | yes | **YES — data source** |
| `/api/forecast/occupancy` | GET | `analytics.read` | SA A | `requireTenant(ctx.auth)` | yes | **YES — data source** |
| `/api/forecast/revenue` | GET | `analytics.read` | SA A | same | yes | **YES — data source** |
| `/api/forecast/cashflow` | GET | `cashflow.read` | SA A | same | yes | **YES — data source** |
| `/api/operations-log/:id` | GET | `operations.view` | SA A O | `ctx.auth.tenantId` | operation metadata | **YES — row compared** |
| `/api/ai/copilot` | POST | `ai.operations` | SA A O | `requireTenant(ctx.auth, 'copilot')` | reads, writes none | **YES — data source** |

`/api/operations-log/:id` is the one route that compares a stored row's tenant directly,
because the operation ledger is in Postgres rather than the workbook. It now checks BOTH
the actor and the tenant: actor scoping stands in for tenant scoping only while a user id
belongs to one tenant, and `lib/server/auth/session.ts` already contemplates a support
principal holding memberships in several.

## Mutation intents

All twenty-four run `executeMutation`, and all obtain the tenant identically —
`requireTenant(ctx.auth, 'executeMutation').tenantId` — which now decides five things
rather than four: the identifier scope, the idempotency row, the cache invalidation
prefix, the audit attribution, **and the workbook the write lands in**.

| route | method | capability | roles | sheet | tenant-enforced |
|---|---|---|---|---|---|
| `POST /api/reservations` | POST | `reservations.write` | SA A O | 04 | **YES — data source** |
| `PATCH /api/reservations/:id` | PATCH | `reservations.write` | SA A O | 04 | **YES — data source** |
| `POST /api/reservations/:id/check-in` | POST | `reservations.write` | SA A O | 04 | **YES — data source** |
| `POST /api/reservations/:id/check-out` | POST | `reservations.write` | SA A O | 04 | **YES — data source** |
| `POST /api/reservations/:id/cancel` | POST | `reservations.write` | SA A O | 04 | **YES — data source** |
| `POST /api/revenue`, `PATCH /api/revenue/:id` | POST/PATCH | `revenue.write` | SA A | 05 | **YES — data source** |
| `POST /api/expenses`, `PATCH /api/expenses/:id` | POST/PATCH | `expenses.write` | SA A | 06 | **YES — data source** |
| `POST /api/capex`, `PATCH /api/capex/:id` | POST/PATCH | `capex.write` | SA A | 07 | **YES — data source** |
| `PATCH /api/rent/:id` | PATCH | `rent.write` | SA A | 08 | **YES — data source** |
| `POST /api/cashflow`, `PATCH /api/cashflow/:id` | POST/PATCH | `cashflow.write` | SA A | 09 | **YES — data source** |
| `POST /api/housekeeping`, `PATCH /api/housekeeping/:id` | POST/PATCH | `housekeeping.write` | SA A O | 13 | **YES — data source** |
| `POST /api/maintenance`, `PATCH /api/maintenance/:id` | POST/PATCH | `maintenance.write` | SA A O | 14 | **YES — data source** |
| `PATCH /api/inventory/:id` | PATCH | `inventory.write` | SA A O | 15 | **YES — data source** |
| `POST /api/investors`, `PATCH /api/investors/:id` | POST/PATCH | `investors.write` | SA A | 11 | **YES — data source** |
| `PATCH /api/distributions/:id` | PATCH | `distributions.write` | SA A | 12 | **YES — data source** |
| `POST /api/properties`, `PATCH /api/properties/:id` | POST/PATCH | `properties.write` | SA A | 03 | **YES — data source** |

Referential checks inside a mutation (`propertyId` must exist, `bookingId` must exist)
read through the same tenant-resolved repositories the write uses, so a validation that
passes and a write that lands are looking at one customer's workbook. That was not true
before this milestone: validation and write shared a process-global client.

`POST /api/properties` is the one route where the caller mints the primary key
(`/^HYD-\d{3}$/`). Uniqueness is checked within the caller's own workbook, which is the
correct scope — two tenants may now both hold `HYD-501`, and they are different units in
different businesses.

## Declared, no handler — guard runs, then 501

`/api/analytics/parity`, `/api/revenue`, `/api/expenses`, `/api/capex`, `/api/rent`,
`/api/cashflow`, `/api/pnl`, `/api/investors`, `/api/investors/:id`,
`/api/operations/today`, `/api/reservations`, `/api/reservations/:id`,
`/api/housekeeping`, `/api/maintenance`, `/api/inventory`, `/api/compliance`,
`/api/properties`, `/api/investor/overview`, `/api/investor/performance`,
`/api/investor/distributions`, `/api/investor/reports`, `/api/settings`, `/api/audit`,
`/api/users` — all **N-A**.

Two carry an obligation for whoever implements them:

- **`/api/audit`** must read through `AuditReader.readForTenant`, which cannot be called
  without a tenant. Its registry summary said "SUPER_ADMIN only" and was wrong — `audit.read`
  is held by ADMIN too, and ADMIN is the role a `TENANT_ADMIN` will be modelled on.
  Corrected in this milestone.
- **`/api/users`** reads `app_users` / `memberships` in Postgres, where rows from every
  tenant share a table. It is the first route where a per-row `tenant_id` predicate will be
  genuinely load-bearing rather than redundant.

## Outside the registry

| route | method | tenant | notes |
|---|---|---|---|
| `POST /api/session` | POST | establishes it | Demo: the identity chooser, behind `assertDemoOnly`; the cookie is a lookup key that asserts nothing. Supabase: email/password → cookie. |
| `DELETE /api/session` | DELETE | n-a | clears both cookies |
| `POST /api/demo` | POST | `session.tenantId` | `demo.control`, demo environment only. Its cache flush is now scoped to the acting tenant; it was `invalidate('')`, which emptied every tenant's cache in the process. |
| `/api/[...path]` | GET/POST/PATCH | — | transport only; lifts the cookie into an Authorization header. No DELETE export, by design. |

## What is still not tenant-enforced

**The AI copilot's budget and usage accounting.** `aiSinkSlot` is one process-wide sink, so
the spend cap is enforced against a total accumulated across all tenants — once AI is on,
one tenant's questions would exhaust another's allowance. Unreachable today: `aiEnabled()`
is false, no provider is constructed, and production is refused three further ways. It must
be per tenant before AI is enabled, and is listed as such rather than fixed here, because
enabling AI is blocked on the management decisions in `docs/DECISIONS_REQUIRED.md`.
