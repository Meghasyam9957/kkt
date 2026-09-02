/**
 * THE MIGRATIONS, RUN.
 *
 * Before this file existed, `supabase/migrations` was eight files of SQL that no database
 * had ever parsed. Every claim about the schema rested on reading them. This runs them
 * against a genuine PostgreSQL engine from an empty database and then asks the database
 * what it actually built — `information_schema` and `pg_catalog`, never the migration text
 * again, because re-reading the source to confirm the source proves nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  freshDatabase, loadMigrations, structuralMigrations, SEED_MIGRATIONS, type TestDatabase,
} from './harness';
import {
  assertNaming, assertTransactional, checksumOf, driftBetween, applyMigrations, readLedger,
} from '@/lib/server/db/migration-runner';
import { DEMO_AUTH_USERS } from '@/lib/server/db/supabase-compat';

let db: TestDatabase;
beforeAll(async () => { db = await freshDatabase(); }, 120_000);
afterAll(async () => { await db?.close(); });

describe('migrations · a clean database becomes the real schema', () => {
  it('applies every structural migration from nothing', async () => {
    const ledger = await readLedger(db);
    expect(ledger.map((r) => r.name)).toEqual(structuralMigrations().map((m) => m.name));
  });

  it('builds the tables the application expects', async () => {
    const rows = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema='public' and table_type='BASE TABLE' order by table_name`);
    const tables = rows.map((r) => r.table_name);

    // Named explicitly rather than counted: a count passes when one table is swapped for
    // another, which is the change most worth catching.
    for (const expected of [
      'app_users', 'audit_log', 'id_allocations', 'id_sequences', 'memberships', 'operations',
      'tenants', 'tenant_workbooks',
      'finance_vendors', 'finance_bills', 'finance_receivables', 'finance_payments',
      'finance_periods',
      'hr_employees', 'hr_departments', 'hr_designations', 'hr_shifts', 'hr_holidays',
      'hr_attendance', 'hr_leave_types', 'hr_leave_entitlements', 'hr_leave_requests',
      'hr_overtime', 'hr_employee_advances', 'hr_salary_structures', 'hr_salary_components',
      'hr_payroll_runs', 'hr_payroll_lines',
      'ops_task_assignments',
    ]) expect(tables, `${expected} must exist after migrating`).toContain(expected);
  });

  it('runs on the engine the report will name', () => {
    expect(['PGLITE', 'POSTGRES']).toContain(db.engine);
  });
});

describe('migrations · tenant ownership is mandatory in the schema, not by convention', () => {
  it('gives every tenant-owned table a NOT NULL tenant_id', async () => {
    const rows = await db.query<{ table_name: string; is_nullable: string }>(
      `select table_name, is_nullable from information_schema.columns
        where table_schema='public' and column_name='tenant_id' order by table_name`);
    expect(rows.length, 'tenant-owned tables must carry tenant_id').toBeGreaterThan(20);
    const nullable = rows.filter((r) => r.is_nullable === 'YES').map((r) => r.table_name);
    /*
     * A nullable tenant_id is a row nobody owns, and an isolation predicate cannot exclude
     * what it cannot attribute. Exactly ONE table is allowed it, and migration 0004 says
     * why: an audit row is written for an UNAUTHENTICATED attempt too, and there is no
     * tenant to attribute one to. Null there means "no tenant could be resolved", never
     * "any tenant".
     *
     * Asserted as an exact list rather than as an allowance, so a second nullable
     * tenant_id appearing anywhere fails this test on the day it is introduced.
     */
    expect(nullable, 'audit_log is the only documented exception').toEqual(['audit_log']);
  });

  it('indexes tenant_id everywhere it is stored', async () => {
    const owned = await db.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema='public' and column_name='tenant_id'`);
    const indexes = await db.query<{ tablename: string; indexdef: string }>(
      `select tablename, indexdef from pg_indexes where schemaname='public'`);

    const unindexed = owned
      .map((r) => r.table_name)
      .filter((t) => !indexes.some((i) => i.tablename === t
        // The leading column is what makes an index usable for a tenant-scoped scan.
        && /\(\s*tenant_id\b/.test(i.indexdef)));
    expect(unindexed, 'every tenant-scoped table needs tenant_id as a leading index column')
      .toEqual([]);
  });

  it('keeps money as integer minor units, never floating point', async () => {
    const rows = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema='public'
          and (column_name like '%_minor' or column_name like '%amount%')`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.data_type, `${r.table_name}.${r.column_name} must be an exact integer type`)
        .toBe('bigint');
    }
  });

  it('stores instants as timestamptz and calendar days as date', async () => {
    const rows = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema='public' and data_type like 'timestamp%'`);
    const naive = rows.filter((r) => r.data_type === 'timestamp without time zone');
    // A naive timestamp records a wall clock without saying whose, so the same row means
    // different instants to a server in Mumbai and one in Frankfurt.
    expect(naive.map((r) => `${r.table_name}.${r.column_name}`),
      'an instant must carry its zone').toEqual([]);
  });
});

describe('migrations · the runner', () => {
  it('refuses a filename that would break apply order', () => {
    expect(() => assertNaming(['0001_a.sql', '10_b.sql'])).toThrow(/filename order/i);
    expect(() => assertNaming(['0001_a.sql', '0001_b.sql'])).toThrow(/ordinal/i);
    expect(() => assertNaming(loadMigrations().map((m) => m.name))).not.toThrow();
  });

  it('refuses SQL that cannot be applied transactionally', () => {
    expect(() => assertTransactional({ name: 'x.sql', sql: 'create index concurrently i on t (a);' }))
      .toThrow(/CONCURRENTLY/i);
    // The word inside prose is not the construct.
    expect(() => assertTransactional({
      name: 'x.sql', sql: '-- we do not build indexes concurrently here\ncreate index i on t (a);',
    })).not.toThrow();
    for (const file of loadMigrations()) expect(() => assertTransactional(file)).not.toThrow();
  });

  it('is a no-op the second time, and records what it did', async () => {
    const again = await applyMigrations(db, structuralMigrations());
    expect(again.applied, 'nothing should re-apply').toEqual([]);
    expect(again.skipped.length).toBe(structuralMigrations().length);
  });

  it('reports an edited migration as drift instead of applying more on top', async () => {
    const files = structuralMigrations();
    const tampered = files.map((f, i) =>
      (i === 0 ? { ...f, sql: `${f.sql}\n-- edited after it was applied\n` } : f));

    const drift = driftBetween(tampered, await readLedger(db));
    expect(drift.map((d) => d.kind)).toContain('CHANGED');

    // And it refuses rather than continuing against a database it no longer describes.
    await expect(applyMigrations(db, tampered)).rejects.toThrow(/edited/i);
  });

  it('notices a migration that was applied but has left the repository', async () => {
    const drift = driftBetween(structuralMigrations().slice(1), await readLedger(db));
    expect(drift.some((d) => d.kind === 'MISSING_FILE')).toBe(true);
  });

  it('reports an unapplied migration as pending', () => {
    const drift = driftBetween(structuralMigrations(), []);
    expect(drift.every((d) => d.kind === 'PENDING')).toBe(true);
  });

  it('checksums the bytes, so whitespace is a change', () => {
    expect(checksumOf('select 1;')).not.toBe(checksumOf('select 1; '));
  });

  it('rolls a failing migration back entirely, and applies nothing after it', async () => {
    const scratch = await freshDatabase({ bare: true });
    try {
      await expect(applyMigrations(scratch, [
        { name: '0001_ok.sql', sql: 'create table kept (id int);' },
        { name: '0002_bad.sql', sql: 'create table half (id int); select * from nope_missing;' },
        { name: '0003_never.sql', sql: 'create table never_reached (id int);' },
      ])).rejects.toThrow(/0002_bad\.sql failed and was rolled back/);

      const tables = (await scratch.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema='public'`))
        .map((r) => r.table_name);
      expect(tables, 'the migration before the failure stands').toContain('kept');
      expect(tables, 'the failing migration leaves nothing behind').not.toContain('half');
      expect(tables, 'nothing after the failure is attempted').not.toContain('never_reached');

      const ledger = await readLedger(scratch);
      expect(ledger.map((r) => r.name), 'only the migration that truly applied is recorded')
        .toEqual(['0001_ok.sql']);
    } finally { await scratch.close(); }
  }, 120_000);
});

describe('migrations · the demo seed is not structural', () => {
  it('names 0002 as environment-scoped, with a reason', () => {
    expect(Object.keys(SEED_MIGRATIONS)).toEqual(['0002_demo_identities.sql']);
    expect(SEED_MIGRATIONS['0002_demo_identities.sql']).toMatch(/demo/i);
    expect(structuralMigrations().map((m) => m.name))
      .not.toContain('0002_demo_identities.sql');
  });

  it('cannot apply on a clean database until the invited logins exist', async () => {
    // A genuinely clean project: the platform exists, but nobody has been invited yet.
    const scratch = await freshDatabase({ bare: true, withDemoAuthUsers: false });
    try {
      await applyMigrations(scratch, structuralMigrations());

      const seed = loadMigrations().find((m) => m.name === '0002_demo_identities.sql')!;
      const refused = await scratch.attemptScript(seed.sql);
      expect(refused.outcome, 'app_users has a foreign key into auth.users').toBe('DENIED');
      expect(refused.outcome === 'DENIED' && refused.message).toMatch(/foreign key|violates/i);

      // Once the addresses have been invited — which is what the header instructs — it runs.
      await scratch.exec(DEMO_AUTH_USERS);
      await scratch.exec(seed.sql);
      const users = await scratch.query<{ c: number }>('select count(*)::int c from app_users');
      expect(Number(users[0]!.c)).toBe(4);
    } finally { await scratch.close(); }
  }, 120_000);
});
