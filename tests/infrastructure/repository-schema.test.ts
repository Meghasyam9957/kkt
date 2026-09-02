/**
 * WHERE THE REPOSITORIES AND THE REAL SCHEMA HAD STOPPED AGREEING.
 *
 * The Supabase repositories were tested with a "recorder" — a stub client that remembers
 * the query chain a method builds and asserts the filters are tenant-scoped. That is a good
 * test of the tenant boundary and it is worth keeping. What it cannot do is notice that a
 * column does not exist, that an enum has no such value, or that one of two twins forgot a
 * step: the recorder has no schema, so every query it accepts is "valid".
 *
 * Running the migrations for the first time (M-INFRA-1) exposed three defects that had been
 * invisible for exactly that reason, each of which would have failed on first contact with
 * a real database:
 *
 *   1. Approving attendance wrote 'APPROVED' into `hr_attendance.status`, whose enum has no
 *      such value. Attendance could never be approved — and payroll consumes only approved
 *      attendance, so payroll could never be run either.
 *   2. Every update stamped `updated_at`, on six tables that have no such column. Closing a
 *      salary structure — i.e. every salary revision — failed.
 *   3. The operations repository inserted a new assignment without superseding the current
 *      one, so the partial unique index refused it and no task could ever be reassigned.
 *      The in-memory twin superseded correctly; the two disagreed and nothing compared them.
 *
 * These tests are the ones that would have caught them, so the same class of defect cannot
 * come back quietly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDatabase, type TestDatabase } from './harness';
import { SupabaseHrRepository, WITHOUT_UPDATED_AT } from '@/lib/server/hr/supabase-repository';
import { SupabaseOperationsRepository } from '@/lib/server/operations/repository';

let db: TestDatabase;
beforeAll(async () => { db = await freshDatabase(); }, 180_000);
afterAll(async () => { await db?.close(); });

/**
 * A recorder that also understands `is` and `in`, which the supersession path uses.
 * Returns a row from an insert so callers that read `data.id` behave as they would.
 */
function recorder() {
  const calls: Array<{ table: string; op: string; filters: [string, unknown][]; row?: unknown }> = [];
  const chain = (entry: { filters: [string, unknown][] }) => {
    const c: Record<string, unknown> = {};
    for (const name of ['eq', 'is', 'in', 'gte', 'lte', 'order', 'limit', 'select']) {
      c[name] = (column?: string, value?: unknown) => {
        if (column !== undefined && ['eq', 'is', 'in'].includes(name)) {
          entry.filters.push([column, value]);
        }
        return c;
      };
    }
    c.single = async () => ({ data: { id: 'new-assignment-id' }, error: null });
    c.maybeSingle = async () => ({ data: null, error: null });
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return c;
  };
  const client = {
    from(table: string) {
      const make = (op: string, row?: unknown) => {
        const entry = { table, op, filters: [] as [string, unknown][], row };
        calls.push(entry);
        return chain(entry);
      };
      return {
        select: () => make('select'),
        insert: (row: unknown) => make('insert', row),
        update: (row: unknown) => make('update', row),
        delete: () => make('delete'),
      };
    },
  };
  return { client, calls };
}

const TENANT = { tenantId: 'aaaaaaaa-5555-4555-8555-000000000001', userId: 'u', role: 'ADMIN' as const };

describe('repository ↔ schema · attendance approval', () => {
  it('keeps the day’s fact and its sign-off in different columns', async () => {
    const day = await db.query<{ enumlabel: string }>(
      `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'hr_attendance_status' order by e.enumsortorder`);
    const signoff = await db.query<{ enumlabel: string }>(
      `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'hr_approval_status' order by e.enumsortorder`);

    // The distinction the defect collapsed: what happened, versus who agreed it happened.
    expect(day.map((r) => r.enumlabel)).not.toContain('APPROVED');
    expect(signoff.map((r) => r.enumlabel)).toContain('APPROVED');

    const columns = await db.query<{ column_name: string; udt_name: string }>(
      `select column_name, udt_name from information_schema.columns
        where table_name = 'hr_attendance' and column_name in ('status', 'approval')`);
    expect(columns.length, 'attendance carries both').toBe(2);
  });

  it('writes an approval into the approval column, not the status column', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseHrRepository(client);
    await repo.transitionAttendance(TENANT, 'a-1', 'APPROVED', 'supervisor');

    const update = calls.find((c) => c.table === 'hr_attendance' && c.op === 'update');
    expect(update, 'the transition must issue an update').toBeDefined();
    const patch = update!.row as Record<string, unknown>;

    expect(patch.approval, 'the sign-off belongs in `approval`').toBe('APPROVED');
    expect(patch.status,
      'writing it into `status` is rejected by the enum and destroys the day’s fact')
      .toBeUndefined();
    expect(patch.approved_by).toBe('supervisor');
  });

  it('still uses `status` for leave, overtime and advances, where that IS the approval', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseHrRepository(client);
    await repo.transitionLeaveRequest(TENANT, 'l-1', 'APPROVED', 'supervisor');

    const update = calls.find((c) => c.op === 'update');
    expect((update!.row as Record<string, unknown>).status).toBe('APPROVED');

    // And the schema agrees: on these tables `status` IS the approval enum.
    const typed = await db.query<{ udt_name: string }>(
      `select udt_name from information_schema.columns
        where table_name = 'hr_leave_requests' and column_name = 'status'`);
    expect(typed[0]!.udt_name).toBe('hr_approval_status');
  });
});

describe('repository ↔ schema · updated_at', () => {
  it('names exactly the tables that have no updated_at column', async () => {
    const missing = await db.query<{ table_name: string }>(
      `select t.table_name from information_schema.tables t
        where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
          and t.table_name like 'hr_%'
          and not exists (
            select 1 from information_schema.columns c
            where c.table_name = t.table_name and c.column_name = 'updated_at')
        order by t.table_name`);

    /*
     * The repository carries this list so that it can avoid stamping a column that is not
     * there. Comparing it to the live schema is what stops the list drifting: add
     * `updated_at` to one of these tables, or add a new table without one, and this fails
     * until the constant is corrected.
     */
    expect([...WITHOUT_UPDATED_AT].sort()).toEqual(missing.map((r) => r.table_name).sort());
  });

  it('does not stamp updated_at on a table that has none', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseHrRepository(client);
    await repo.closeSalaryStructure(TENANT, 's-1', '2026-03-31');

    const update = calls.find((c) => c.op === 'update');
    const patch = update!.row as Record<string, unknown>;
    expect(patch.effective_to).toBe('2026-03-31');
    expect(patch.updated_at,
      'hr_salary_structures has no updated_at; stamping it fails the whole revision')
      .toBeUndefined();
  });

  it('still stamps it where the column exists', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseHrRepository(client);
    await repo.transitionAttendance(TENANT, 'a-1', 'SUBMITTED', 'supervisor');
    const patch = calls.find((c) => c.op === 'update')!.row as Record<string, unknown>;
    expect(patch.updated_at, 'hr_attendance does have updated_at').toBeDefined();
  });
});

describe('repository ↔ schema · reassignment supersedes', () => {
  it('marks the current assignment superseded before inserting the replacement', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseOperationsRepository(client);

    await repo.assign(TENANT, {
      taskType: 'HOUSEKEEPING', taskRef: 'HK-2026-0001',
      employeeId: 'dddddddd-0000-4000-8000-00000000000a', propertyId: 'HYD-501',
      displayNameWritten: 'Anita', overrideReason: null,
    }, 'supervisor');

    const ops = calls.filter((c) => c.table === 'ops_task_assignments').map((c) => c.op);
    expect(ops[0], 'supersede first, or the unique index refuses the insert').toBe('update');
    expect(ops).toContain('insert');

    const supersede = calls.find((c) => c.op === 'update')!;
    expect((supersede.row as Record<string, unknown>).superseded_at).toBeDefined();

    const filters = Object.fromEntries(supersede.filters);
    expect(filters.tenant_id, 'scoped to the caller').toBe(TENANT.tenantId);
    expect(filters.task_ref).toBe('HK-2026-0001');
    expect(filters).toHaveProperty('superseded_at');
  });

  it('is exactly what the unique index requires', async () => {
    const index = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'ops_task_assignments' and indexname = 'ops_assignment_one_current'`);
    expect(index.length, 'the index this behaviour exists to satisfy').toBe(1);
    // Partial on "not yet superseded" — so superseding the old row is precisely what frees
    // the slot for the new one.
    expect(index[0]!.indexdef).toMatch(/superseded_at IS NULL/i);
    expect(index[0]!.indexdef).toMatch(/tenant_id/);
  });
});
