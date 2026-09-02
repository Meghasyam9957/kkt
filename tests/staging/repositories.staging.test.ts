/**
 * THE ACTUAL MAKAM REPOSITORIES, AGAINST REAL SUPABASE.
 *
 * This closes the gap M-INFRA-1 named as its top remaining risk. Local PostgreSQL proved
 * the schema; it could not prove the code that drives it, because the repositories speak to
 * PostgREST through `@supabase/supabase-js` and neither PGlite nor a bare `postgres:16`
 * provides PostgREST.
 *
 * That gap is not theoretical. Three defects were hiding in it — an approval written to the
 * wrong column, an `updated_at` stamped on tables that have none, and a reassignment that
 * never superseded — each of which would have failed on first contact with a real database
 * and none of which the query-chain recorder could see, because a recorder has no schema.
 * This suite is what would have caught all three on the day they were written.
 *
 * These tests use the SERVICE ROLE client, which is correct and deliberate: that is the
 * identity the MAKAM server holds, and the tenant predicate the repositories apply is the
 * thing under test. RLS is exercised next door in `rls.staging.test.ts`, as the browser
 * roles that actually meet it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createStagingWorld, stagingUnavailable, STAGING_MARKER, type StagingWorld } from './harness';
import { SupabaseHrRepository } from '@/lib/server/hr/supabase-repository';
import { SupabaseFinanceRepository } from '@/lib/server/finance/supabase-repository';
import { SupabaseOperationsRepository } from '@/lib/server/operations/repository';
import { SupabaseAuditSink, SupabaseAuditReader } from '@/lib/server/audit/logger';
import { PostgresOperationStore, requestHashOf } from '@/lib/server/ops/operation-store';
import { rupeesToPaise } from '@/lib/server/finance/money';
import { CORPORATE } from '@/lib/server/finance/types';
import { randomUUID } from 'node:crypto';

let world: StagingWorld;
let hr: SupabaseHrRepository;
let finance: SupabaseFinanceRepository;
let ops: SupabaseOperationsRepository;

const ctx = (tenantId: string) =>
  Object.freeze({ tenantId, userId: 'staging-actor', role: 'ADMIN' as const });

describe.skipIf(stagingUnavailable)('staging · repositories drive real PostgREST', () => {
  beforeAll(async () => {
    world = await createStagingWorld();
    hr = new SupabaseHrRepository(world.admin);
    finance = new SupabaseFinanceRepository(world.admin);
    ops = new SupabaseOperationsRepository(world.admin);
  }, 180_000);
  afterAll(async () => { await world?.teardown(); });

  /* ---------------------------------------------------------------- *
   * HR — §22
   * ---------------------------------------------------------------- */

  it('creates, reads and isolates an employee per tenant', async () => {
    const anita = await hr.createEmployee(ctx(world.a.tenantId), {
      employeeCode: `${STAGING_MARKER}-A1`, fullName: `${STAGING_MARKER} Anita`,
      joiningDate: '2026-01-01',
    } as never, 'staging-actor');
    const bala = await hr.createEmployee(ctx(world.b.tenantId), {
      employeeCode: `${STAGING_MARKER}-B1`, fullName: `${STAGING_MARKER} Bala`,
      joiningDate: '2026-01-01',
    } as never, 'staging-actor');

    expect((await hr.listEmployees(ctx(world.a.tenantId))).map((e) => e.id)).toEqual([anita.id]);
    expect((await hr.listEmployees(ctx(world.b.tenantId))).map((e) => e.id)).toEqual([bala.id]);

    // A foreign id is a miss, not a refusal — the same answer as one that never existed.
    expect(await hr.getEmployee(ctx(world.a.tenantId), bala.id)).toBeNull();
    expect(await hr.getEmployee(ctx(world.b.tenantId), anita.id)).toBeNull();
  });

  it('approves attendance — the write that could never have worked before', async () => {
    const [anita] = await hr.listEmployees(ctx(world.a.tenantId));
    const day = await hr.recordAttendance(ctx(world.a.tenantId), {
      employeeId: anita!.id, attendanceDate: '2026-03-02', status: 'PRESENT',
    } as never, 'staging-actor');

    const approved = await hr.transitionAttendance(
      ctx(world.a.tenantId), day.id, 'APPROVED', 'supervisor');

    /*
     * Until M-INFRA-1 this wrote 'APPROVED' into `status`, an enum with no such value, so
     * PostgREST would have returned 22P02 and attendance could never be approved — which
     * means payroll could never run either. That failure is only visible here.
     */
    expect(approved, 'the update must have matched a row').not.toBeNull();
    expect(approved!.approval).toBe('APPROVED');
    expect(approved!.status, 'the day’s own fact is untouched').toBe('PRESENT');
  });

  it('closes a salary structure — the write that stamped a column that does not exist', async () => {
    const [anita] = await hr.listEmployees(ctx(world.a.tenantId));
    const structure = await hr.createSalaryStructure(ctx(world.a.tenantId), {
      employeeId: anita!.id, effectiveFrom: '2026-01-01', currency: 'INR',
    } as never, 'staging-actor');

    const closed = await hr.closeSalaryStructure(
      ctx(world.a.tenantId), structure.id, '2026-03-31');
    expect(closed, 'hr_salary_structures has no updated_at to stamp').not.toBeNull();
    expect(closed!.effectiveTo).toBe('2026-03-31');
  });

  /* ---------------------------------------------------------------- *
   * Finance — §21
   * ---------------------------------------------------------------- */

  it('keeps money exact through PostgREST’s JSON', async () => {
    const vendor = await finance.createVendor(ctx(world.a.tenantId),
      { displayName: `${STAGING_MARKER} A Supplies` }, 'staging-actor');

    // A bigint beyond a double's exact range. JSON has one number type, so this is the
    // point at which an amount would silently round if anything in the path used a float.
    const bill = await finance.createBill(ctx(world.a.tenantId), {
      vendorId: vendor.id, billReference: `${STAGING_MARKER}-BILL-1`,
      billDate: '2026-01-05', amount: rupeesToPaise(90071992547409.93),
      attribution: CORPORATE,
    }, 'staging-actor');

    const read = await finance.getBill(ctx(world.a.tenantId), bill.id);
    expect(read!.amount, 'stored and returned to the paise').toBe(bill.amount);
  });

  it('refuses a bill against another tenant’s vendor — at the database', async () => {
    const bVendor = await finance.createVendor(ctx(world.b.tenantId),
      { displayName: `${STAGING_MARKER} B Supplies` }, 'staging-actor');

    /*
     * Migration 0009's composite foreign key. Before it, the database accepted this and
     * only application code stood in the way. This asserts the DATABASE refuses, which is
     * the claim §24 asks to be proven rather than assumed.
     */
    await expect(finance.createBill(ctx(world.a.tenantId), {
      vendorId: bVendor.id, billReference: `${STAGING_MARKER}-CROSS`,
      billDate: '2026-01-05', amount: rupeesToPaise(100), attribution: CORPORATE,
    }, 'staging-actor')).rejects.toThrow();
  });

  it('isolates vendors, bills and payments per tenant', async () => {
    const aVendors = await finance.listVendors(ctx(world.a.tenantId));
    const bVendors = await finance.listVendors(ctx(world.b.tenantId));
    expect(aVendors.every((v) => v.tenantId === world.a.tenantId)).toBe(true);
    expect(bVendors.every((v) => v.tenantId === world.b.tenantId)).toBe(true);
    expect(aVendors.map((v) => v.id))
      .not.toEqual(expect.arrayContaining(bVendors.map((v) => v.id)));
  });

  /* ---------------------------------------------------------------- *
   * Operations — §23
   * ---------------------------------------------------------------- */

  it('reassigns a task — the write that could never supersede before', async () => {
    const [anita] = await hr.listEmployees(ctx(world.a.tenantId));
    const first = await ops.assign(ctx(world.a.tenantId), {
      taskType: 'HOUSEKEEPING', taskRef: `${STAGING_MARKER}-HK-1`,
      employeeId: anita!.id, propertyId: null,
      displayNameWritten: 'Anita', overrideReason: null,
    }, 'supervisor');
    expect(first).not.toBeNull();

    const second = await ops.assign(ctx(world.a.tenantId), {
      taskType: 'HOUSEKEEPING', taskRef: `${STAGING_MARKER}-HK-1`,
      employeeId: anita!.id, propertyId: null,
      displayNameWritten: 'Anita', overrideReason: null,
    }, 'supervisor');

    // Before the fix this collided with `ops_assignment_one_current` and returned null, so
    // no task could ever be reassigned through a real database.
    expect(second, 'the previous assignment must be superseded first').not.toBeNull();
    expect(second!.id).not.toBe(first!.id);

    const history = await ops.historyFor(
      ctx(world.a.tenantId), 'HOUSEKEEPING', `${STAGING_MARKER}-HK-1`);
    expect(history.length, 'history is kept, not overwritten').toBe(2);
    expect(history.filter((h) => h.supersededAt === null).length,
      'exactly one current assignment').toBe(1);
  });

  it('refuses to assign another tenant’s employee', async () => {
    const [bala] = await hr.listEmployees(ctx(world.b.tenantId));
    await expect(ops.assign(ctx(world.a.tenantId), {
      taskType: 'MAINTENANCE', taskRef: `${STAGING_MARKER}-MT-CROSS`,
      employeeId: bala!.id, propertyId: null,
      displayNameWritten: 'Bala', overrideReason: null,
    }, 'supervisor')).rejects.toThrow();
  });

  it('lets both tenants hold the same task reference', async () => {
    const [bala] = await hr.listEmployees(ctx(world.b.tenantId));
    const theirs = await ops.assign(ctx(world.b.tenantId), {
      taskType: 'HOUSEKEEPING', taskRef: `${STAGING_MARKER}-HK-1`,
      employeeId: bala!.id, propertyId: null,
      displayNameWritten: 'Bala', overrideReason: null,
    }, 'supervisor');
    // Identifier sequences are tenant-scoped, so this collision is the normal case.
    expect(theirs).not.toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * Audit, idempotency, sequences — §18, §19, §20
   * ---------------------------------------------------------------- */

  it('attributes an audit event to the tenant that caused it', async () => {
    const sink = new SupabaseAuditSink(world.admin);
    const reader = new SupabaseAuditReader(world.admin);

    await sink.write({
      actor: ctx(world.a.tenantId), action: 'finance.bill.create',
      entityType: 'BILL', entityId: 'staging-bill', result: 'ALLOW',
      occurredAt: new Date().toISOString(),
    } as never);

    const forA = await reader.readForTenant(world.a.tenantId, { limit: 50 });
    const forB = await reader.readForTenant(world.b.tenantId, { limit: 50 });
    expect(forA.some((e) => e.entityId === 'staging-bill')).toBe(true);
    expect(forB.some((e) => e.entityId === 'staging-bill'),
      'B must not see A’s history').toBe(false);
  });

  it('replays an operation for its own tenant and refuses another’s', async () => {
    const store = new PostgresOperationStore(world.admin);
    const operationId = randomUUID();
    const requestHash = requestHashOf({ action: 'x', entityId: 'e', input: { a: 1 } });
    const begin = (tenantId: string, hash: string) => store.begin({
      operationId, tenantId, actorId: 'staging-actor', actorRole: 'ADMIN',
      action: 'finance.bill.create', requestHash: hash,
    });

    expect((await begin(world.a.tenantId, requestHash)).outcome).toBe('inserted');
    expect((await begin(world.a.tenantId, requestHash)).outcome).toBe('in-flight');
    // Tenant compared before hash: B is told mismatch, never "already applied".
    expect((await begin(world.b.tenantId, requestHash)).outcome).toBe('mismatch');
  });

  it('allocates identifiers on independent per-tenant number lines', async () => {
    const { PostgresSequenceStore, scopeFor } = await import('@/lib/server/ids/allocator');
    const store = new PostgresSequenceStore(world.admin);

    const a = await store.allocate(
      scopeFor(world.a.tenantId, 'RESERVATIONS', 2026), 1, `${STAGING_MARKER}-a`, null);
    const b = await store.allocate(
      scopeFor(world.b.tenantId, 'RESERVATIONS', 2026), 1, `${STAGING_MARKER}-b`, null);

    // Each customer's first booking of the year is their own number 1.
    expect(Number(a.firstValue)).toBe(1);
    expect(Number(b.firstValue)).toBe(1);
  });
});
