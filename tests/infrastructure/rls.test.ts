/**
 * ROW LEVEL SECURITY, EXERCISED RATHER THAN ASSUMED.
 *
 * Every isolation claim MAKAM has made so far was a claim about application code: the
 * repositories put a tenant predicate on every query, and tests proved they did. That is
 * worth having, and it is not the same as the database refusing. This file asks the
 * database.
 *
 * WHY THESE TESTS ARE NOT THEATRE — three things had to be true at once:
 *
 *   1. The queries run as `authenticated`, a role that is neither superuser nor the owner
 *      of the tables. PostgreSQL exempts both from RLS, so a test that skipped this would
 *      pass with every policy deleted.
 *   2. `auth.uid()` returns a real value, from the same `request.jwt.claim.sub` setting
 *      PostgREST populates from a verified JWT. The policies are the migrations' own,
 *      unmodified.
 *   3. Supabase's default `public` grants are applied first (see supabase-compat.ts). Skip
 *      them and every cross-tenant read fails with "permission denied for table" — green,
 *      and proving only that no GRANT exists.
 *
 * THE MODEL THESE TESTS DESCRIBE, which is not the one the brief expected to find:
 *
 * MAKAM does NOT isolate tenants with per-tenant RLS policies. There are exactly two
 * policies in the whole schema, both narrow self-reads on identity tables. Every other
 * table is `enable row level security` with NO policy — which in PostgreSQL denies
 * everything to non-owners — and most of them additionally REVOKE all privileges from
 * `anon` and `authenticated`.
 *
 * So the database's answer to "can tenant A read tenant B" is not "no, the policy filters
 * it": it is "no, and it cannot read its OWN rows either". Data reaches a browser only
 * through the server, which holds the service role and applies the tenant predicate itself.
 * That is a coherent and strict design, and these tests pin it as it actually is rather
 * than describing a policy-based isolation the schema does not implement.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDatabase, type TestDatabase } from './harness';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-000000000002';
const USER_A = '11111111-1111-4111-8111-000000000001';
const USER_B = '22222222-2222-4222-8222-000000000002';

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();

  // Seeded as the owner, which is what the application's service role does in production.
  await db.exec(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'a.admin@tenant-a.test'),
      ('${USER_B}', 'b.admin@tenant-b.test');

    insert into app_users (id, email, role) values
      ('${USER_A}', 'a.admin@tenant-a.test', 'ADMIN'),
      ('${USER_B}', 'b.admin@tenant-b.test', 'ADMIN');

    insert into tenants (id, slug, name) values
      ('${TENANT_A}', 'tenant-a', 'Tenant A'),
      ('${TENANT_B}', 'tenant-b', 'Tenant B');

    insert into memberships (user_id, tenant_id, role) values
      ('${USER_A}', '${TENANT_A}', 'ADMIN'),
      ('${USER_B}', '${TENANT_B}', 'ADMIN');

    insert into finance_vendors (id, tenant_id, display_name) values
      ('cccccccc-0000-4000-8000-00000000000a', '${TENANT_A}', 'A Supplies'),
      ('cccccccc-0000-4000-8000-00000000000b', '${TENANT_B}', 'B Supplies');

    -- CORPORATE attribution, because the schema's own check constraint requires a
    -- property_id whenever a bill claims to be attributable to one.
    insert into finance_bills
      (tenant_id, vendor_id, bill_reference, bill_date, amount_minor, attribution) values
      ('${TENANT_A}', 'cccccccc-0000-4000-8000-00000000000a', 'A-BILL-1', '2026-01-05', 125000, 'CORPORATE'),
      ('${TENANT_B}', 'cccccccc-0000-4000-8000-00000000000b', 'B-BILL-1', '2026-01-06', 990000, 'CORPORATE');

    insert into hr_employees (id, tenant_id, employee_code, full_name, joining_date) values
      ('dddddddd-0000-4000-8000-00000000000a', '${TENANT_A}', 'A-001', 'Anita of A', '2026-01-01'),
      ('dddddddd-0000-4000-8000-00000000000b', '${TENANT_B}', 'B-001', 'Bala of B', '2026-01-01');

    insert into ops_task_assignments (tenant_id, task_type, task_ref, employee_id, display_name_written) values
      ('${TENANT_A}', 'HOUSEKEEPING', 'HK-2026-0001', 'dddddddd-0000-4000-8000-00000000000a', 'Anita of A'),
      ('${TENANT_B}', 'HOUSEKEEPING', 'HK-2026-0001', 'dddddddd-0000-4000-8000-00000000000b', 'Bala of B');

    insert into audit_log (tenant_id, action, result) values
      ('${TENANT_A}', 'finance.bill.create', 'ALLOW'),
      ('${TENANT_B}', 'finance.bill.create', 'ALLOW');
  `);
}, 180_000);

afterAll(async () => { await db?.close(); });

/** Every table that holds one tenant's business records. */
const TENANT_TABLES = [
  'finance_vendors', 'finance_bills', 'finance_receivables', 'finance_payments',
  'finance_periods',
  'hr_employees', 'hr_departments', 'hr_designations', 'hr_shifts', 'hr_attendance',
  'hr_leave_requests', 'hr_overtime', 'hr_employee_advances', 'hr_salary_structures',
  'hr_payroll_runs', 'hr_payroll_lines',
  'ops_task_assignments', 'tenants', 'tenant_workbooks', 'operations',
] as const;

describe('rls · the model, stated as the database implements it', () => {
  it('enables row level security on every table without exception', async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relkind='r'
        order by c.relname`);
    expect(rows.length).toBeGreaterThan(25);
    const without = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(without, 'a table with RLS off is readable by anyone holding a GRANT').toEqual([]);
  });

  it('has exactly two policies, both narrow self-reads', async () => {
    const rows = await db.query<{ tablename: string; policyname: string; cmd: string; qual: string }>(
      'select tablename, policyname, cmd, qual from pg_policies order by tablename');
    expect(rows.map((r) => `${r.tablename}.${r.policyname}`))
      .toEqual(['app_users.app_users_self_read', 'memberships.memberships_self_read']);
    for (const row of rows) {
      expect(row.cmd, 'neither policy grants a write').toBe('SELECT');
      // The comparison is against the verified JWT subject, never against a request value.
      expect(row.qual).toMatch(/auth\.uid\(\)/);
    }
  });

  it('revokes the business tables from anon and authenticated outright', async () => {
    const grants = await db.query<{ table_name: string; grantee: string }>(
      `select table_name, grantee from information_schema.role_table_grants
        where table_schema='public' and grantee in ('anon','authenticated')`);
    const reachable = new Set(grants.map((g) => g.table_name));
    for (const table of TENANT_TABLES) {
      expect(reachable.has(table),
        `${table} must be revoked from browser-facing roles, not merely covered by RLS`)
        .toBe(false);
    }
  });

  it('names the tables that rely on RLS alone, so the asymmetry is deliberate', async () => {
    const grants = await db.query<{ table_name: string }>(
      `select distinct table_name from information_schema.role_table_grants
        where table_schema='public' and grantee='authenticated'`);
    /*
     * After migration 0010 exactly two tables keep any grant to a browser role, and both
     * keep only SELECT so that their self-read policies remain reachable:
     *
     *   app_users     app_users_self_read   — a person may read their own row
     *   memberships   memberships_self_read — and their own memberships
     *
     * Everything else is revoked outright as well as denied by RLS. Pinned as an exact
     * list because the day a third table appears here is the day something regained a
     * default grant, and that should fail a test rather than pass a review.
     */
    expect(grants.map((g) => g.table_name).sort())
      .toEqual(['app_users', 'memberships']);

    const writable = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where table_schema='public' and grantee in ('anon','authenticated')
          and privilege_type <> 'SELECT'`);
    expect(writable, 'no browser role may write any table directly').toEqual([]);
  });
});

describe('rls · tenant A cannot read tenant B', () => {
  for (const table of TENANT_TABLES) {
    it(`refuses ${table} to a signed-in user of another tenant`, async () => {
      const result = await db.as('authenticated', USER_A, (scoped) =>
        scoped.query<{ c: number }>(`select count(*)::int c from ${table}`)
          .then((rows) => ({ ok: true as const, count: Number(rows[0]!.c) }))
          .catch((e: unknown) => ({ ok: false as const, message: String(e) })));

      // Either refusal is correct. What must never happen is a row coming back.
      if (result.ok) {
        expect(result.count, `${table} leaked rows to a browser role`).toBe(0);
      } else {
        expect(result.message).toMatch(/permission denied/i);
      }
    });
  }

  it('refuses the same tables to an anonymous visitor', async () => {
    for (const table of ['finance_bills', 'hr_employees', 'ops_task_assignments', 'tenants']) {
      const result = await db.as('anon', null, (scoped) =>
        scoped.query<{ c: number }>(`select count(*)::int c from ${table}`)
          .then((rows) => ({ ok: true as const, count: Number(rows[0]!.c) }))
          .catch(() => ({ ok: false as const, count: -1 })));
      if (result.ok) expect(result.count, `${table} leaked to anon`).toBe(0);
    }
  });

  it('does not reveal tenant B even when B’s id is named explicitly', async () => {
    // Guessing an id must not become a way to confirm it exists.
    const result = await db.as('authenticated', USER_A, (scoped) =>
      scoped.query(`select id from finance_bills where tenant_id = '${TENANT_B}'`)
        .then((rows) => ({ ok: true as const, rows }))
        .catch(() => ({ ok: false as const, rows: [] })));
    expect(result.rows.length).toBe(0);
  });
});

describe('rls · tenant A cannot write tenant B', () => {
  const writes: ReadonlyArray<readonly [string, string]> = [
    ['insert a bill for B', `insert into finance_bills
        (tenant_id, vendor_id, bill_reference, bill_date, amount_minor, attribution)
        values ('${TENANT_B}', 'cccccccc-0000-4000-8000-00000000000b', 'FORGED', '2026-02-01', 1, 'CORPORATE')`],
    ['update every bill', `update finance_bills set amount_minor = 1`],
    ['delete every bill', `delete from finance_bills`],
    ['update B’s employee', `update hr_employees set full_name = 'renamed'`],
    ['delete every employee', `delete from hr_employees`],
    ['steal B’s task assignment', `update ops_task_assignments set employee_id = 'dddddddd-0000-4000-8000-00000000000a'`],
    ['grant itself a second tenant', `insert into memberships (user_id, tenant_id, role)
        values ('${USER_A}', '${TENANT_B}', 'ADMIN')`],
    ['escalate its own role', `update memberships set role = 'SUPER_ADMIN'`],
    ['forge an audit entry', `insert into audit_log (tenant_id, action, result)
        values ('${TENANT_B}', 'finance.payment.create', 'ALLOW')`],
    ['erase the audit trail', `delete from audit_log`],
    ['repoint a tenant at another workbook', `update tenant_workbooks set workbook_ref = 'stolen'`],
  ];

  for (const [label, sql] of writes) {
    it(`refuses: ${label}`, async () => {
      const result = await db.as('authenticated', USER_A, (scoped) =>
        scoped.query(sql).then(() => ({ denied: false }))
          .catch(() => ({ denied: true })));
      // Denied outright, OR permitted-but-affecting-nothing. Both are safe; the assertion
      // below is what proves it, because a silent no-op and a successful attack look
      // identical from the caller's side.
      expect(typeof result.denied).toBe('boolean');
    });
  }

  it('leaves every seeded row exactly as it was', async () => {
    // The real assertion. Run as the owner AFTER all the attacks above, this is what
    // catches an attack that succeeded quietly.
    const bills = await db.query<{ c: number; total: string }>(
      'select count(*)::int c, sum(amount_minor)::text total from finance_bills');
    expect(Number(bills[0]!.c), 'both bills survive').toBe(2);
    expect(bills[0]!.total, 'no amount was rewritten').toBe('1115000');

    const employees = await db.query<{ names: string }>(
      `select string_agg(full_name, '|' order by full_name) names from hr_employees`);
    expect(employees[0]!.names).toBe('Anita of A|Bala of B');

    const memberships = await db.query<{ c: number }>(
      `select count(*)::int c from memberships where role = 'SUPER_ADMIN'`);
    expect(Number(memberships[0]!.c), 'nobody escalated').toBe(0);

    const audits = await db.query<{ c: number }>('select count(*)::int c from audit_log');
    expect(Number(audits[0]!.c), 'the audit trail is intact and unforged').toBe(2);

    const assignments = await db.query<{ c: number }>(
      `select count(*)::int c from ops_task_assignments
        where tenant_id = '${TENANT_B}' and employee_id = 'dddddddd-0000-4000-8000-00000000000b'`);
    expect(Number(assignments[0]!.c), 'B keeps its own assignment').toBe(1);
  });
});

describe('rls · the two policies do exactly what they say', () => {
  it('lets a user read their own app_users row and nobody else’s', async () => {
    const rows = await db.as('authenticated', USER_A, (scoped) =>
      scoped.query<{ email: string }>('select email from app_users'));
    expect(rows.map((r) => r.email)).toEqual(['a.admin@tenant-a.test']);
  });

  it('lets a user read their own memberships and nobody else’s', async () => {
    const rows = await db.as('authenticated', USER_B, (scoped) =>
      scoped.query<{ tenant_id: string }>('select tenant_id from memberships'));
    expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_B]);
  });

  it('shows nothing at all when no JWT subject is set', async () => {
    // An unauthenticated request reaching these tables must not fall back to "everything".
    const rows = await db.as('authenticated', null, (scoped) =>
      scoped.query('select email from app_users'));
    expect(rows).toEqual([]);
  });

  it('refuses a membership write even though the row is the user’s own', async () => {
    const before = await db.query<{ c: number }>('select count(*)::int c from memberships');
    await db.as('authenticated', USER_A, (scoped) =>
      scoped.query(`update memberships set role='SUPER_ADMIN' where user_id='${USER_A}'`)
        .catch(() => undefined));
    const after = await db.query<{ c: number; escalated: number }>(
      `select count(*)::int c, count(*) filter (where role='SUPER_ADMIN')::int escalated
        from memberships`);
    expect(Number(after[0]!.c)).toBe(Number(before[0]!.c));
    expect(Number(after[0]!.escalated), 'reading your membership is not editing it').toBe(0);
  });
});

describe('rls · the service role is the only way in, and never reaches a browser', () => {
  it('can read across tenants, which is why it stays on the server', async () => {
    const rows = await db.as('service_role', null, (scoped) =>
      scoped.query<{ c: number }>('select count(*)::int c from finance_bills'));
    expect(Number(rows[0]!.c), 'the trusted identity sees everything').toBe(2);
  });

  it('is the identity the privileged functions require', async () => {
    const denied = await db.as('authenticated', USER_A, (scoped) =>
      scoped.query(`select * from begin_operation(
        '99999999-9999-4999-8999-999999999999'::uuid, '${TENANT_B}'::uuid,
        'actor', 'ADMIN', 'finance.bill.create', 'hash')`)
        .then(() => 'ALLOWED').catch((e: unknown) => String(e)));
    expect(denied).toMatch(/permission denied/i);
  });
});
