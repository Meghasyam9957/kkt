-- ---------------------------------------------------------------------
-- M-SAAS-1 — THE TENANT WORKBOOK REGISTRY
--
-- M-SAAS-0 made tenant identity exist. It did not make tenant DATA exist: every
-- tenant still resolved to whatever workbook the deployment's environment named,
-- because `buildProviderFor(tenantId)` accepted a tenant and then ignored it. Two
-- tenants provisioned on that code would have read and written the same workbook.
--
-- This migration is the durable answer to "whose data is this?". It is the only
-- place a tenant is bound to a data source, it is readable by nothing but the
-- service role, and there is no request input anywhere in its lookup path.
--
--   authenticated user -> verified membership -> tenant -> THIS TABLE -> provider
--
-- Two source kinds, and the distinction is the whole design:
--
--   ENVIRONMENT     This tenant's data source is the one this deployment's
--                   environment already configures (PRODUCTION_GOOGLE_SHEET_ID, or
--                   the demo workbook, or the fixture dataset when no workbook is
--                   configured). It is how Srivillu keeps behaving EXACTLY as it
--                   does today while becoming a registry-resolved tenant like any
--                   other. `workbook_ref` is null because the environment owns it.
--
--   GOOGLE_SHEETS   A named workbook, read with the deployment's service-account
--                   credential. This is what every customer after the first uses.
--
-- The partial unique index below is the load-bearing constraint: AT MOST ONE tenant
-- may claim the environment's workbook. Without it, "ENVIRONMENT" would degrade into
-- exactly the bug this milestone removes — every tenant inheriting the first
-- customer's data source by default.
-- ---------------------------------------------------------------------

do $$ begin
  create type tenant_data_source as enum ('ENVIRONMENT', 'GOOGLE_SHEETS');
exception when duplicate_object then null; end $$;

create table if not exists tenant_workbooks (
  -- PRIMARY KEY, not merely a foreign key: exactly one binding per tenant. A tenant
  -- with two data sources is not a feature, it is an unanswerable question about
  -- which one a booking was written to.
  tenant_id    uuid               primary key references tenants(id) on delete cascade,
  source       tenant_data_source not null,
  -- The Google spreadsheet id. NEVER a credential, and never sent to a browser.
  workbook_ref text,
  status       tenant_status      not null default 'ACTIVE',
  created_at   timestamptz        not null default now(),
  updated_at   timestamptz        not null default now(),

  -- The two kinds are structurally distinguishable; neither can masquerade as the
  -- other. An ENVIRONMENT row carrying a workbook id would be ambiguous about which
  -- of the two wins, and a GOOGLE_SHEETS row without one would silently fall back.
  constraint tenant_workbooks_ref_matches_source check (
    (source = 'ENVIRONMENT'   and workbook_ref is null)
    or
    (source = 'GOOGLE_SHEETS' and workbook_ref is not null and btrim(workbook_ref) <> '')
  )
);

-- AT MOST ONE tenant may resolve to the deployment's environment workbook.
-- This is the constraint that stops "ENVIRONMENT" from becoming a default.
create unique index if not exists tenant_workbooks_single_environment
  on tenant_workbooks (source) where source = 'ENVIRONMENT';

-- Two tenants pointed at one workbook is a cross-tenant data breach expressed as a
-- configuration mistake. The database refuses it rather than trusting provisioning.
create unique index if not exists tenant_workbooks_ref_unique
  on tenant_workbooks (workbook_ref) where workbook_ref is not null;

-- Tenant #1 keeps the workbook it already has. No identifier changes, no data moves,
-- and the application resolves it through the registry from now on rather than
-- reaching for the environment on its own.
insert into tenant_workbooks (tenant_id, source, workbook_ref, status)
select t.id, 'ENVIRONMENT', null, 'ACTIVE'
from tenants t
where t.slug = 'srivillu'
on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------
-- Deny by default.
--
-- A workbook id is not a secret in the cryptographic sense, but the LIST of them is
-- the customer list, and a tenant learning another tenant's workbook id learns a
-- direct object reference to attempt. No browser role reads this table: the server
-- resolves a binding with the service role, having already verified membership.
-- ---------------------------------------------------------------------

alter table tenant_workbooks enable row level security;
revoke all on tenant_workbooks from authenticated, anon;

-- ---------------------------------------------------------------------
-- AUDIT — finish what 0004 started.
--
-- 0004 added `audit_log.tenant_id`, and the application's AuditRecord carries it,
-- but the Supabase sink never wrote the column: every production audit row has
-- landed unattributed since. The column stays NULLABLE — an unauthenticated attempt
-- genuinely has no tenant — so this is an application fix (see
-- lib/server/audit/logger.ts); the index below is what makes the tenant-scoped read
-- it enables cheap.
-- ---------------------------------------------------------------------

create index if not exists audit_log_tenant_action_idx
  on audit_log (tenant_id, action, occurred_at desc);
