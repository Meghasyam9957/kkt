/**
 * THE CONTROL PLANE AND THE DOMAINS, AGAINST A REAL DATABASE.
 *
 * The RLS suite next door proves what a browser role can and cannot reach. This one proves
 * what the SCHEMA ITSELF enforces once the trusted server is already inside: the
 * constraints, the uniqueness, the delete behaviour, the SECURITY DEFINER functions, and
 * the two data migrations whose correctness nothing else checks.
 *
 * These are the guarantees that survive an application bug. A missing tenant predicate in
 * TypeScript is a bug; a missing unique index is a business that mints the same invoice
 * number twice and only finds out from a customer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDatabase, structuralMigrations, type TestDatabase } from './harness';
import { applyMigrations } from '@/lib/server/db/migration-runner';
import { scopeFor } from '@/lib/server/ids/allocator';

const A = 'aaaaaaaa-3333-4333-8333-000000000001';
const B = 'bbbbbbbb-4444-4444-8444-000000000002';

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into tenants (id, slug, name) values
      ('${A}', 'iso-a', 'Isolation A'), ('${B}', 'iso-b', 'Isolation B');
    insert into hr_employees (id, tenant_id, employee_code, full_name, joining_date) values
      ('eeeeeeee-0000-4000-8000-00000000000a', '${A}', 'A-1', 'Anita', '2026-01-01'),
      ('eeeeeeee-0000-4000-8000-00000000000b', '${B}', 'B-1', 'Bala',  '2026-01-01');
  `);
}, 180_000);

afterAll(async () => { await db?.close(); });

describe('schema · a reference cannot cross a tenant boundary', () => {
  /**
   * The guard, asked of the catalog rather than of any one table.
   *
   * This is the test that would have caught the original hole, and it is written so that it
   * catches the NEXT one: a new table with a plain `<parent>_id references <parent>(id)`
   * fails here on the day it is written, rather than years later when two customers'
   * records have quietly become entangled.
   */
  it('makes every foreign key between tenant-owned tables carry the tenant', async () => {
    const owned = new Set((await db.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema='public' and column_name='tenant_id'`)).map((r) => r.table_name));

    const keys = await db.query<{ conname: string; child: string; parent: string; cols: string }>(`
      select con.conname, c.relname as child, p.relname as parent,
        (select string_agg(a.attname, ',' order by k.ord)
           from unnest(con.conkey) with ordinality k(att, ord)
           join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.att) as cols
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_class p on p.oid = con.confrelid
      join pg_namespace n on n.oid = c.relnamespace
      where con.contype = 'f' and n.nspname = 'public'`);

    const crossable = keys
      .filter((k) => owned.has(k.child) && owned.has(k.parent))
      .filter((k) => !k.cols.split(',').includes('tenant_id'))
      .map((k) => `${k.child}.${k.cols} -> ${k.parent}`);

    expect(crossable,
      'a foreign key between two tenant-owned tables must include tenant_id, or one '
      + 'tenant can reference another tenant’s row').toEqual([]);
  });

  it('still allows a reference to a table nobody owns', async () => {
    // Not everything is tenant-scoped: app_users and auth.users are global by design, and
    // this must not have swept them up.
    const global = await db.query<{ c: number }>(`
      select count(*)::int c from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_class p on p.oid = con.confrelid
      where con.contype='f' and p.relname = 'tenants'`);
    expect(Number(global[0]!.c), 'tenant_id still points at the tenants table')
      .toBeGreaterThan(10);
  });
});

describe('idempotency · the operation store, tenant before hash', () => {
  const OP = '77777777-7777-4777-8777-777777777777';

  it('replays for the same tenant and refuses the same id from another', async () => {
    const call = (tenant: string, hash: string) => db.query<{ outcome: string }>(
      'select * from begin_operation($1,$2,$3,$4,$5,$6)',
      [OP, tenant, 'actor-1', 'ADMIN', 'finance.bill.create', hash]);

    expect((await call(A, 'H1'))[0]!.outcome).toBe('inserted');
    expect((await call(A, 'H1'))[0]!.outcome, 'same intent, still running').toBe('in_flight');
    expect((await call(A, 'H2'))[0]!.outcome, 'same id, different intent').toBe('mismatch');

    /*
     * The one that matters. Tenant B presents the SAME operation id and the same payload
     * hash, and is told "mismatch" — not "already applied", and never A's stored result.
     * The tenant is compared before the hash precisely so B cannot learn that A has an
     * operation by that id, nor what its outcome was.
     */
    expect((await call(B, 'H1'))[0]!.outcome).toBe('mismatch');

    const rows = await db.query<{ tenant_id: string }>(
      'select tenant_id from operations where operation_id = $1', [OP]);
    expect(rows.length, 'one operation id, one row, one owner').toBe(1);
    expect(rows[0]!.tenant_id).toBe(A);
  });

  it('never returns another tenant a stored result', async () => {
    const done = '88888888-8888-4888-8888-888888888888';
    await db.query('select * from begin_operation($1,$2,$3,$4,$5,$6)',
      [done, A, 'actor', 'ADMIN', 'act', 'HX']);
    await db.query('select set_operation_status($1,$2,$3,$4,$5,$6)',
      [done, 'VERIFIED', 'BILL', 'bill-1', JSON.stringify({ secret: 'A only' }), null]);

    const forB = await db.query<{ outcome: string; result: unknown }>(
      'select * from begin_operation($1,$2,$3,$4,$5,$6)',
      [done, B, 'actor', 'ADMIN', 'act', 'HX']);
    expect(forB[0]!.outcome).toBe('mismatch');
    expect(forB[0]!.result, 'B must not receive A’s payload').toBeNull();

    const forA = await db.query<{ outcome: string; result: { secret: string } }>(
      'select * from begin_operation($1,$2,$3,$4,$5,$6)',
      [done, A, 'actor', 'ADMIN', 'act', 'HX']);
    expect(forA[0]!.outcome).toBe('verified');
    expect(forA[0]!.result.secret).toBe('A only');
  });
});

describe('identifiers · two tenants, one number line each', () => {
  it('mints the same first number for both without colliding', async () => {
    const alloc = (tenant: string, key: string) => db.query<{ first_value: string }>(
      'select * from allocate_ids($1,$2,$3,$4)',
      [scopeFor(tenant, 'RESERVATIONS', 2026), 1, key, null]);

    expect(String((await alloc(A, 'a-1'))[0]!.first_value)).toBe('1');
    // Not a bug: each customer's first booking of the year is their number 1.
    expect(String((await alloc(B, 'b-1'))[0]!.first_value)).toBe('1');
    expect(String((await alloc(A, 'a-2'))[0]!.first_value)).toBe('2');

    const scopes = await db.query<{ scope: string; last_value: string }>(
      'select scope, last_value from id_sequences order by scope');
    const mine = scopes.filter((s) => s.scope.includes(A) || s.scope.includes(B));
    expect(mine.length, 'one sequence row per tenant').toBe(2);
  });

  it('replays an allocation for the same idempotency key rather than burning numbers', async () => {
    const scope = scopeFor(A, 'EXPENSES', 2026);
    const first = await db.query<{ first_value: string; reused: boolean }>(
      'select * from allocate_ids($1,$2,$3,$4)', [scope, 3, 'same-key', null]);
    const again = await db.query<{ first_value: string; reused: boolean }>(
      'select * from allocate_ids($1,$2,$3,$4)', [scope, 3, 'same-key', null]);
    expect(again[0]!.first_value).toBe(first[0]!.first_value);
    expect(again[0]!.reused).toBe(true);
  });

  /**
   * The coupling nothing else guards.
   *
   * Migration 0004 RENAMES existing global scopes to `tenant:<uuid>:<old scope>` so that
   * Srivillu's allocation continues from the floor it had already reached. The application
   * builds its lookup key with `scopeFor()`. If those two string formats ever disagree, the
   * renamed row becomes unreachable, allocation silently restarts at 1, and the business
   * mints booking numbers it has already used — with nothing failing anywhere.
   *
   * So this drives the actual migration against an actual pre-0004 row.
   */
  it('carries an existing Srivillu sequence across the tenant rename, at its floor', async () => {
    const scratch = await freshDatabase({ bare: true });
    try {
      const all = structuralMigrations();
      const upTo0003 = all.filter((m) => m.name < '0004');
      await applyMigrations(scratch, upTo0003);

      // A pre-tenant database, mid-life: Srivillu has already issued 417 bookings.
      await scratch.exec(
        `insert into id_sequences (scope, last_value) values ('04_RESERVATIONS:BK:2026', 417)`);

      await applyMigrations(scratch, all.filter((m) => m.name >= '0004'));

      const srivillu = (await scratch.query<{ id: string }>(
        `select id from tenants where slug = 'srivillu'`))[0]!.id;
      const expected = scopeFor(srivillu, 'RESERVATIONS', 2026);

      const rows = await scratch.query<{ scope: string; last_value: string }>(
        'select scope, last_value from id_sequences');
      expect(rows.map((r) => r.scope),
        'the renamed scope must be exactly what scopeFor() will look up').toContain(expected);
      expect(rows.find((r) => r.scope === expected)!.last_value.toString(),
        'the floor is carried, not reset').toBe('417');

      // And the next booking is 418, not a repeat of 1.
      const next = await scratch.query<{ first_value: string }>(
        'select * from allocate_ids($1,$2,$3,$4)', [expected, 1, 'after-rename', null]);
      expect(String(next[0]!.first_value)).toBe('418');
    } finally { await scratch.close(); }
  }, 180_000);
});

describe('audit · attributed, and only where a tenant could be resolved', () => {
  it('persists the tenant on an attributed event', async () => {
    await db.exec(
      `insert into audit_log (tenant_id, actor_id, action, result)
       values ('${A}', null, 'finance.bill.create', 'ALLOW')`);
    const rows = await db.query<{ c: number }>(
      `select count(*)::int c from audit_log where tenant_id = '${A}'`);
    expect(Number(rows[0]!.c)).toBeGreaterThan(0);
  });

  it('accepts a null tenant only for an attempt that had none', async () => {
    // A refused sign-in has no tenant to attribute, and inventing one would be a lie in
    // the permanent record.
    const result = await db.attempt(
      `insert into audit_log (tenant_id, action, result, reason)
       values (null, 'auth.signin', 'DENY', 'no membership') returning id`);
    expect(result.outcome).toBe('ALLOWED');
  });

  it('refuses an audit row attributed to a tenant that does not exist', async () => {
    const result = await db.attempt(
      `insert into audit_log (tenant_id, action, result)
       values ('99999999-9999-4999-8999-999999999999', 'x', 'ALLOW') returning id`);
    expect(result.outcome, 'the foreign key is what makes attribution meaningful').toBe('DENIED');
  });
});

describe('finance · the schema refuses impossible money', () => {
  const vendor = 'ffffffff-0000-4000-8000-00000000000a';
  beforeAll(async () => {
    await db.exec(`insert into finance_vendors (id, tenant_id, display_name)
      values ('${vendor}', '${A}', 'A Supplies') on conflict do nothing`);
  });

  const bill = (extra: string) => `insert into finance_bills
    (tenant_id, vendor_id, bill_reference, bill_date, amount_minor, attribution ${extra ? ', ' + extra.split('=')[0]!.trim() : ''})
    values ('${A}', '${vendor}', 'REF-${Math.random().toString(36).slice(2, 8)}', '2026-01-05', 1000, 'CORPORATE'
      ${extra ? ', ' + extra.split('=').slice(1).join('=') : ''}) returning id`;

  it('refuses a bill for a vendor belonging to another tenant', async () => {
    await db.exec(`insert into finance_vendors (id, tenant_id, display_name)
      values ('ffffffff-0000-4000-8000-00000000000b', '${B}', 'B Supplies') on conflict do nothing`);
    const result = await db.attempt(`insert into finance_bills
      (tenant_id, vendor_id, bill_reference, bill_date, amount_minor, attribution)
      values ('${A}', 'ffffffff-0000-4000-8000-00000000000b', 'CROSS', '2026-01-05', 1000, 'CORPORATE')
      returning id`);
    /*
     * Before migration 0009 the database ACCEPTED this: the foreign key pointed at the
     * vendor by id alone, so tenant A could raise a bill against tenant B's supplier and
     * nothing anywhere objected. 0009 made the key composite, so the tenant must match for
     * the reference to resolve.
     */
    expect(result.outcome, 'a bill may not reference another tenant’s vendor').toBe('DENIED');
    const leaked = await db.query<{ c: number }>(
      `select count(*)::int c from finance_bills b join finance_vendors v on v.id = b.vendor_id
        where b.tenant_id <> v.tenant_id`);
    expect(Number(leaked[0]!.c)).toBe(0);
  });

  it('refuses a non-positive amount', async () => {
    expect((await db.attempt(bill('amount_minor = 0'))).outcome).toBe('DENIED');
  });

  it('refuses tax larger than the bill', async () => {
    const result = await db.attempt(`insert into finance_bills
      (tenant_id, vendor_id, bill_reference, bill_date, amount_minor, tax_minor, attribution)
      values ('${A}', '${vendor}', 'TAXY', '2026-01-05', 1000, 5000, 'CORPORATE') returning id`);
    expect(result.outcome).toBe('DENIED');
  });

  it('refuses a due date before the bill date', async () => {
    const result = await db.attempt(`insert into finance_bills
      (tenant_id, vendor_id, bill_reference, bill_date, due_date, amount_minor, attribution)
      values ('${A}', '${vendor}', 'EARLY', '2026-01-05', '2026-01-01', 1000, 'CORPORATE') returning id`);
    expect(result.outcome).toBe('DENIED');
  });

  it('refuses a property-attributed bill with no property', async () => {
    const result = await db.attempt(`insert into finance_bills
      (tenant_id, vendor_id, bill_reference, bill_date, amount_minor, attribution)
      values ('${A}', '${vendor}', 'NOPROP', '2026-01-05', 1000, 'PROPERTY') returning id`);
    expect(result.outcome).toBe('DENIED');
  });

  it('holds a paise value far beyond a float’s exact range', async () => {
    // 2^53 paise is where a double stops counting in ones. bigint does not.
    const big = '9007199254740993';
    const inserted = await db.query<{ id: string }>(`insert into finance_bills
      (tenant_id, vendor_id, bill_reference, bill_date, amount_minor, attribution)
      values ('${A}', '${vendor}', 'BIG', '2026-01-05', ${big}, 'CORPORATE') returning id`);
    const back = await db.query<{ amount_minor: string }>(
      'select amount_minor::text from finance_bills where id = $1', [inserted[0]!.id]);
    expect(back[0]!.amount_minor, 'stored and returned exactly').toBe(big);
  });
});

describe('hr · attendance uniqueness, and salary that is never overwritten', () => {
  const emp = 'eeeeeeee-0000-4000-8000-00000000000a';

  it('allows one unshifted attendance record per employee per day', async () => {
    await db.exec(`insert into hr_attendance (tenant_id, employee_id, attendance_date, status)
      values ('${A}', '${emp}', '2026-03-02', 'PRESENT')`);
    const again = await db.attempt(
      `insert into hr_attendance (tenant_id, employee_id, attendance_date, status)
       values ('${A}', '${emp}', '2026-03-02', 'PRESENT') returning id`);
    expect(again.outcome, 'a day cannot be recorded twice').toBe('DENIED');
  });

  it('lets the other tenant record the same date for its own employee', async () => {
    const ok = await db.attempt(
      `insert into hr_attendance (tenant_id, employee_id, attendance_date, status)
       values ('${B}', 'eeeeeeee-0000-4000-8000-00000000000b', '2026-03-02', 'PRESENT') returning id`);
    expect(ok.outcome, 'the uniqueness is per tenant, not global').toBe('ALLOWED');
  });

  it('refuses attendance for an employee of another tenant', async () => {
    const result = await db.attempt(
      `insert into hr_attendance (tenant_id, employee_id, attendance_date, status)
       values ('${A}', 'eeeeeeee-0000-4000-8000-00000000000b', '2026-03-09', 'PRESENT') returning id`);
    expect(result.outcome, 'attendance may not be recorded against another tenant’s staff')
      .toBe('DENIED');
    const crossed = await db.query<{ c: number }>(
      `select count(*)::int c from hr_attendance a join hr_employees e on e.id = a.employee_id
        where a.tenant_id <> e.tenant_id`);
    expect(Number(crossed[0]!.c)).toBe(0);
  });

  it('will not let an employee who has worked be deleted out of the record', async () => {
    const result = await db.attempt(`delete from hr_employees where id = '${emp}' returning id`);
    expect(result.outcome, 'history references the person').toBe('DENIED');
  });
});

describe('operations · one current assignment, and a history that survives', () => {
  const emp = 'eeeeeeee-0000-4000-8000-00000000000a';

  it('permits only one current assignment per task', async () => {
    await db.exec(`insert into ops_task_assignments
      (tenant_id, task_type, task_ref, employee_id, display_name_written)
      values ('${A}', 'MAINTENANCE', 'MT-2026-0001', '${emp}', 'Anita')`);
    const second = await db.attempt(`insert into ops_task_assignments
      (tenant_id, task_type, task_ref, employee_id, display_name_written)
      values ('${A}', 'MAINTENANCE', 'MT-2026-0001', '${emp}', 'Anita again') returning id`);
    expect(second.outcome, 'the partial unique index is the concurrency guard').toBe('DENIED');
  });

  it('accepts a replacement once the previous one is superseded', async () => {
    await db.exec(`update ops_task_assignments set superseded_at = now()
      where tenant_id = '${A}' and task_ref = 'MT-2026-0001' and superseded_at is null`);
    const replacement = await db.attempt(`insert into ops_task_assignments
      (tenant_id, task_type, task_ref, employee_id, display_name_written)
      values ('${A}', 'MAINTENANCE', 'MT-2026-0001', '${emp}', 'Anita') returning id`);
    expect(replacement.outcome).toBe('ALLOWED');

    const history = await db.query<{ c: number }>(
      `select count(*)::int c from ops_task_assignments
        where tenant_id = '${A}' and task_ref = 'MT-2026-0001'`);
    expect(Number(history[0]!.c), 'the previous assignment is kept, not overwritten').toBe(2);
  });

  it('lets the other tenant hold the same task reference at the same time', async () => {
    const theirs = await db.attempt(`insert into ops_task_assignments
      (tenant_id, task_type, task_ref, employee_id, display_name_written)
      values ('${B}', 'MAINTENANCE', 'MT-2026-0001', 'eeeeeeee-0000-4000-8000-00000000000b', 'Bala')
      returning id`);
    // Identifier sequences are tenant-scoped, so this collision is the normal case.
    expect(theirs.outcome).toBe('ALLOWED');
  });
});

describe('tenant workbooks · at most one environment binding, globally', () => {
  it('refuses a second tenant claiming the environment workbook', async () => {
    await db.exec(`insert into tenant_workbooks (tenant_id, source, status)
      values ('${A}', 'ENVIRONMENT', 'ACTIVE') on conflict do nothing`);
    const second = await db.attempt(`insert into tenant_workbooks (tenant_id, source, status)
      values ('${B}', 'ENVIRONMENT', 'ACTIVE') returning tenant_id`);
    expect(second.outcome,
      'two tenants sharing the environment workbook would read each other’s business')
      .toBe('DENIED');
  });

  it('refuses two tenants pointing at the same workbook id', async () => {
    await db.exec(`insert into tenant_workbooks (tenant_id, source, workbook_ref, status)
      values ('${B}', 'GOOGLE_SHEETS', 'sheet-xyz', 'ACTIVE')`);
    const clash = await db.attempt(`insert into tenant_workbooks
      (tenant_id, source, workbook_ref, status)
      values ('${A}', 'GOOGLE_SHEETS', 'sheet-xyz', 'ACTIVE')
      on conflict (tenant_id) do update set workbook_ref = excluded.workbook_ref
      returning tenant_id`);
    expect(clash.outcome).toBe('DENIED');
  });
});
