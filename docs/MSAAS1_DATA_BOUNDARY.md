# M-SAAS-1 — the data boundary

Where a MAKAM tenant's data lives, why it lives there, and what has to change before the
second real customer is onboarded.

Written at the close of M-SAAS-1. Everything in §1–§4 is implemented; §5 onward is
recorded so it is decided deliberately rather than arrived at.

---

## 1 · The path, end to end

```
authenticated user
      ↓   Supabase verifies the token; the user id is the only thing taken from it
verified membership              memberships (tenant_id, role, status)
      ↓   keyed by the VERIFIED user id — the query accepts no tenant, so none can be poisoned
tenant                           AuthContext.tenantId → ShellSession.tenantId → TenantContext
      ↓   frozen, request-scoped, fail-closed
tenant workbook registry         tenant_workbooks (source, workbook_ref, status)
      ↓   lookup(tenantId) — one argument, and it is not the caller's
tenant-scoped data source        lib/server/tenant/data-source.ts
      ↓   reads: getDataProvider(tenant)      writes: tenantRepositories(tenantId)
tenant business data             one Google workbook per tenant
```

No step accepts a query parameter, a path segment, a request body field, a header, a
cookie that is not cryptographically bound to the identity, or a `NEXT_PUBLIC_*` variable.
`tests/tenant-isolation.test.ts` asserts that both registry modules contain none of that
vocabulary, and drives the realistic version of the attempt through the live router.

---

## 2 · What stays in Google Sheets

The V1 workbook remains the operational and financial source of truth for the twenty-two
sheets it already owns: properties, reservations, revenue, expenses, capex, rent, cash
flow, P&L, investors, distributions, housekeeping, maintenance, inventory, assets,
compliance, monthly close, analytics and QA.

**Why it stays.** The workbook is not a database this application happens to use; it is
the business's own instrument, edited by people, carrying formulas that the application is
forbidden to overwrite (`role: 'calc'` columns are dropped by construction in
`buildInputRow`). Migrating it would move the arithmetic out of the customer's hands into
ours, which is a product decision, not an engineering one.

**How tenancy is enforced there.** By physical separation: one workbook per tenant, bound
in `tenant_workbooks`. There is no `tenant_id` column in the V1 contract and there is not
going to be one — a tenant's rows are the rows of their own workbook.

This has a consequence worth stating plainly, because it answers most of the IDOR
questions in [MSAAS1_ROUTE_MATRIX.md](MSAAS1_ROUTE_MATRIX.md) at once:

> An identifier belonging to another tenant is not *refused* by a row-level check. It
> simply **does not exist** in the workbook the caller's request resolves to.

That is a stronger guarantee than a per-row comparison, not a weaker one — there is no
check to forget, no query to write unscoped, and no join that a later feature can widen.
It is also why cross-tenant `:id` access is closed today even though the sheet rows carry
no tenant: `PATCH /api/reservations/BK-2026-0007` as tenant A reaches tenant A's workbook
and fails to find tenant B's booking there.

---

## 3 · What belongs in Postgres

Supabase is the **control plane**, and everything in it is tenant-scoped by column:

| Table | Holds | Tenant scoping |
|---|---|---|
| `tenants` | the customer list | RLS on; revoked from `anon`/`authenticated` entirely |
| `memberships` | who may act in which tenant, and as what | RLS; a user may read only their own row |
| `tenant_workbooks` | tenant → data source | RLS on; service role only. The list of workbook ids **is** the customer list |
| `audit_log` | who did what, allowed or denied | `tenant_id`, nullable — null means *unknown*, never *any* |
| `operations` | idempotency ledger | `tenant_id NOT NULL`; compared before the request hash |
| `id_sequences` / `id_allocations` | identifier floors | scope is `tenant:<id>:<sheet>:<year>` |

**What should join them later, and why.** The domains the target architecture names but
the workbook has no home for — employees, attendance, leave, payroll, advances, and the
transactional side of finance (payments, vendors) — belong in Postgres rather than in new
sheets. Three reasons, in order of weight:

1. **Referential integrity.** An attendance row without an employee, or a payroll run
   against a deleted employee, is a data-integrity failure a spreadsheet cannot prevent.
2. **Row-level security.** Employee records are the most sensitive data this product would
   hold. Postgres RLS scoped on `tenant_id` is a real boundary; a sheet tab is not.
3. **Volume and write concurrency.** Attendance is a high-frequency append. The workbook
   write path is verified-read-after-write against a rate-limited API — correct for tens
   of business events a day, wrong for thousands.

**How that migration happens without rewriting the KPI layer.** The `DashboardDataProvider`
interface is the seam. Every screen and every KPI reads through it; nothing reads a
repository directly. A Postgres-backed provider — or, more likely, a provider that reads
some slices from Postgres and some from the workbook — satisfies the same interface. The
analytics and forecasting code never learns where a record came from, which is exactly
what `lib/server/api/investor-data.ts` was corrected to respect in this milestone.

**Object storage** (employee documents, expense receipts, invoices, property documents,
maintenance photos) belongs in Supabase Storage with a `tenant_id`-prefixed path and
per-tenant bucket policies. Nothing is implemented; no binary attachment exists today.

---

## 4 · Credentials, and the blast radius we accepted

The split M-SAAS-1 implements:

- the **workbook** is per tenant, from `tenant_workbooks`
- the **credential** is per deployment, from `PRODUCTION_GOOGLE_*` / `DEMO_GOOGLE_*`

`createTenantSheetsClient` (`lib/server/sheets/config.ts`) is the only place they meet, and
it is the only module in the application that reads a Google credential.

**The consequence, stated rather than implied: one service account is granted access to
every tenant workbook, so compromising it reaches every tenant.** That is a real
concentration of risk and it was chosen, not overlooked. The alternative is §5.

Two options, and why the first is in place:

**Option 1 — one controlled service identity (implemented).** One service account; each
customer shares their workbook with it. Onboarding is a share and a row. No secret is
stored per tenant, so there is no per-tenant secret to leak, rotate, or mis-scope — the
attack surface is one credential, held in the deployment environment, never in source and
never in a client bundle.

**Option 2 — per-tenant credentials (not implemented).** A service account per tenant, or
per-tenant OAuth. Compromise is contained to one customer. It requires a place to keep N
secrets (Supabase Vault, or a KMS), an encryption-at-rest story, a rotation story, and an
onboarding flow that provisions a Google service account per customer. None of that
infrastructure exists in this project, and standing it up badly — plaintext secrets in a
table, say — would be worse than option 1, not better.

**Recommended trigger for moving to option 2:** the first tenant whose data would be
materially damaging to another tenant if disclosed, or the first regulated customer,
whichever comes first. Not a tenant count.

Constraints observed throughout: no credential in source, none in the client bundle, no
`NEXT_PUBLIC` secret, no service-account JSON committed, no secret in a log line. The
tenant diagnostics in `data-source.ts` emit the tenant id and the source kind only — never
the workbook id, because the list of workbook ids is the customer list.

---

## 5 · Property hierarchy — deliberately not migrated

Target:

```
Tenant → Property → Unit → Booking
```

Today `03_PROPERTIES` rows are the unit (`PropertyID`, e.g. `HYD-501`), and a booking
names one directly. There is no property-above-unit level, and no ownership relationship
of any kind in the contract.

**Not attempted here, on purpose.** Restructuring the property schema means changing the
V1 workbook contract, which every KPI, projection and screen reads through the generated
contract module. Doing it in the same milestone that moves the data source would put two
independent risks in one change, and M-SAAS-1's whole point is that Srivillu's behaviour
is unchanged.

What a future milestone needs, in order:

1. A `properties` concept distinct from units. The contract's `PropertyID` becomes a unit
   id; a new grouping level gets its own identifier.
2. A decision — **business, not engineering** — about what a "property" is: a building, a
   legal entity, an investment vehicle, or a marketing listing. `docs/UI9_OWNER_DECISIONS.md`
   records that the repository supports only the Investor model today and does not have an
   Owner model at all; the same gap governs this.
3. Only then, per-object scoping. With one workbook per tenant, an object-level tenant
   check adds nothing across tenants; it becomes necessary when a domain moves to Postgres
   and rows from several tenants share a table.

---

## 6 · M-SAAS-2 — recommended scope

In dependency order, smallest defensible units first:

1. **`TENANT_ADMIN` role, and the audit read that goes with it.** The data access layer is
   ready: `AuditReader.readForTenant` cannot be called without a tenant, and there is no
   unscoped read to reach for. What is missing is the role, the capability grant, and the
   handler for `GET /api/audit` — which is declared and returns 501 today.
2. **Tenant provisioning.** Creating a tenant, its first membership and its workbook
   binding is a service-role operation with no interface. It should be a script with an
   audit trail before it is a screen.
3. **Drop `app_users.role`.** Migration 0004 kept it as the fallback for a user with no
   membership. Once every deployment has run 0004 and the fallback is provably unused, the
   column and its investor constraints move to `memberships`.
4. **Per-tenant secrets** (§4 option 2), when the trigger there is met.
5. **The people domain in Postgres** — employees first, then attendance, then payroll —
   behind the existing provider interface, with `tenant_id` and RLS from the first
   migration rather than added later. This is the point at which object-level tenant
   checks stop being redundant.
6. **Property hierarchy** (§5), after the business decision it depends on.

Explicitly **not** recommended for M-SAAS-2: enabling AI (blocked on the management
decisions in `docs/DECISIONS_REQUIRED.md`, and its budget accounting is process-global
rather than per tenant), and any second real customer before items 1 and 2 exist.
