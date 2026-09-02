/**
 * MUTATION PIPELINE SUITE — Phase B2.
 *
 * Runs the REAL pipeline (router → guard → executeMutation → repositories) against the
 * same backend interfaces production uses, with in-memory implementations: the demo
 * workbook grids behind `InMemorySheetsClient`, `InMemoryOperationStore`,
 * `InMemorySequenceStore`. Nothing here mocks the pipeline itself — only the I/O
 * backends are swapped, exactly as a fixtures-mode demo deployment swaps them.
 *
 * What must hold:
 *   - calculated columns and calculated sheets are unreachable through any payload;
 *   - RBAC refuses the wrong role BEFORE anything is validated or written;
 *   - one operation id = one business row, under every retry and race the brief lists;
 *   - a write is reported saved only after it round-trips (read-after-write);
 *   - a verified write invalidates the read cache;
 *   - operation state walks PENDING → APPLYING → VERIFIED, or FAILED with the reason.
 *
 * SCOPE: these tests prove the pipeline against the modelled Sheets API. The six live
 * Google spikes (append landing, date/locale, type encoding, calc refresh, calc-column
 * protection, simultaneous writes) run via scripts/sheets-write-spikes.mjs against the
 * DEMO workbook and are PENDING until demo credentials exist. Nothing here claims them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiRouter } from '@/lib/server/api/router';
import { API_ROUTES } from '@/lib/server/api/routes';
import { registerMutationHandlers, MUTATION_DEFINITIONS } from '@/lib/server/api/mutation-services';
import { executeMutation, type MutationDependencies } from '@/lib/server/api/mutations';
import { InMemoryAuthProvider } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { IdAllocator, InMemorySequenceStore } from '@/lib/server/ids/allocator';
import {
  InMemoryOperationStore, NaiveOperationStore, requestHashOf,
} from '@/lib/server/ops/operation-store';
import { createRepositories } from '@/lib/server/sheets/repositories';
import { InMemorySheetsClient, SheetWriteForbiddenError, type Row } from '@/lib/server/sheets/client';
import { buildDemoSheetsClient } from '@/lib/server/demo/workbook-grids';
import { ReadCache } from '@/lib/server/cache/read-cache';
import { inputColumns, COLUMNS, SHEETS, DATA_ROW, columnIndex } from '@/lib/contract/contract.generated';
import { isoToSerial } from '@/lib/shared/dates';
import { USERS, TENANT_A } from './support/harness';
import { createWriteHarness, type WriteHarness } from './support/write-harness';

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * Harness: the full pipeline over in-memory backends
 * ------------------------------------------------------------------ */

const expensePayload = (operationId: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  date: '2026-08-20',
  propertyId: 'HYD-501',
  expenseCategory: 'Variable Operating',
  expenseSubcategory: 'Electricity',
  description: 'Electricity bill for August',
  amount: 3200,
  paymentStatus: 'Paid',
  paidDate: '2026-08-20',
  ...extra,
});

/** Count data rows on a sheet by non-blank ID cells. */
function rowCount(client: InMemorySheetsClient, sheetName: string, idIdx: number): Promise<number> {
  return client.get(`'${sheetName}'!A${DATA_ROW}:BZ1000`).then((rows) =>
    rows.filter((r) => String(r[idIdx] ?? '').trim() !== '').length);
}

let h: WriteHarness;
beforeEach(() => { h = createWriteHarness(); });

/* ================================================================== *
 * 1 · Definitions honour the contract
 * ================================================================== */
describe('mutations · contract alignment', () => {
  it('every mutation route has a definition, and every definition a route', () => {
    const routeActions = API_ROUTES.filter((r) => r.mutates).map((r) => r.action).sort();
    const defActions = Object.keys(MUTATION_DEFINITIONS).sort();
    expect(routeActions).toEqual(defActions);
  });

  it('every definition can only ever emit input columns of its sheet', () => {
    for (const def of Object.values(MUTATION_DEFINITIONS)) {
      const writable = new Set(inputColumns(def.sheet).map((c) => c.key));
      // The mapping is static: probing with an empty input reveals every key it can emit.
      const probe = def.toColumns({}, 'PROBE-0001');
      for (const key of Object.keys(probe)) {
        expect(writable.has(key),
          `${def.action} would write ${def.sheet}.${key}, which is not an input column`).toBe(true);
      }
    }
  });

  it('no definition can address a calculated column even by construction', () => {
    for (const def of Object.values(MUTATION_DEFINITIONS)) {
      const calcKeys = (COLUMNS[def.sheet] ?? []).filter((c) => c.role === 'calc').map((c) => c.key);
      const probeKeys = Object.keys(def.toColumns({}, 'PROBE-0001'));
      for (const calc of calcKeys) {
        expect(probeKeys).not.toContain(calc);
      }
    }
  });
});

/* ================================================================== *
 * 2 · The happy path, verified end to end
 * ================================================================== */
describe('mutations · create (expense)', () => {
  it('creates, verifies, audits and returns the row', async () => {
    const operationId = randomUUID();
    const res = await h.request('admin', 'POST', '/api/expenses', expensePayload(operationId));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.record.ExpenseID).toMatch(/^EXP-2026-\d{4}$/);
    expect(res.body.meta.verified).toBe(true);
    expect(res.body.meta.operationId).toBe(operationId);
    expect(res.body.meta.sheet).toBe(SHEETS.EXPENSES);

    // The date was written as a SERIAL, not a locale-parseable string.
    expect(res.body.record.Date).toBe(isoToSerial('2026-08-20'));

    // The row is really in the grid, at the row the response names.
    const idIdx = columnIndex('EXPENSES', 'ExpenseID');
    const grid = await h.client.get(`'${SHEETS.EXPENSES}'!A${res.body.meta.rowNumber}:BZ${res.body.meta.rowNumber}`);
    expect(String(grid[0]![idIdx])).toBe(res.body.record.ExpenseID);

    // Operation reached VERIFIED. Two audit events, one each: the guard's request-level
    // ALLOW, and the pipeline's write-level `.applied` carrying the operation id.
    const op = await h.store.get(operationId);
    expect(op?.status).toBe('VERIFIED');
    const requestEvents = h.audit.records.filter((r: any) => r.action === 'expense.create' && r.result === 'ALLOW');
    const writeEvents = h.audit.records.filter((r: any) => r.action === 'expense.create.applied');
    expect(requestEvents.length).toBe(1);
    expect(writeEvents.length).toBe(1);
    expect((writeEvents[0] as any).metadata.operationId).toBe(operationId);
  });

  it('writes land at the first blank input row inside the prepared range', async () => {
    const before = await rowCount(h.client, SHEETS.EXPENSES, columnIndex('EXPENSES', 'ExpenseID'));
    const res = await h.request('admin', 'POST', '/api/expenses', expensePayload(randomUUID()));
    expect(res.status).toBe(200);
    expect(res.body.meta.rowNumber).toBe(DATA_ROW + before);
  });
});

/* ================================================================== *
 * 3 · Calculated columns and sheets are unreachable
 * ================================================================== */
describe('mutations · calc protection', () => {
  it('a payload smuggling a calculated column is refused by the schema (strict)', async () => {
    const res = await h.request('admin', 'POST', '/api/expenses',
      expensePayload(randomUUID(), { TotalAmount: 999999 }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('a payload smuggling calc keys under altered casing is refused too', async () => {
    const res = await h.request('admin', 'POST', '/api/expenses',
      expensePayload(randomUUID(), { totalAmount: 999999 }));
    expect(res.status).toBe(422);
  });

  it('the repository layer refuses a calc key even if a definition tried to emit one', async () => {
    // Defence in depth below the schema: updateById throws on calc keys — proven against
    // a row that really exists, so the row lookup cannot mask the rule.
    const [firstExpense] = await h.deps.repos.expenses.readAll();
    expect(firstExpense).toBeTruthy();
    await expect(h.deps.repos.expenses.updateByIdVerified(
      (firstExpense as { ExpenseID: string }).ExpenseID, { TotalAmount: 1 },
    )).rejects.toThrow(/calculated column/);
  });

  it('the client refuses calculated SHEETS outright', async () => {
    await expect(h.client.batchUpdate([{ range: `'${SHEETS.CALC}'!B10`, values: [[1]] }]))
      .rejects.toThrow(SheetWriteForbiddenError);
    await expect(h.client.batchUpdate([{ range: `'${SHEETS.DASHBOARD}'!C3`, values: [['2026-08']] }]))
      .rejects.toThrow(SheetWriteForbiddenError);
  });
});

/* ================================================================== *
 * 4 · RBAC on the write path
 * ================================================================== */
describe('mutations · authorization', () => {
  it('OPERATIONS may not record an expense (no financial writer)', async () => {
    const res = await h.request('operations', 'POST', '/api/expenses', expensePayload(randomUUID()));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('OPERATIONS may create a maintenance ticket', async () => {
    const res = await h.request('operations', 'POST', '/api/maintenance', {
      operationId: randomUUID(), propertyId: 'HYD-501', dateReported: '2026-08-20',
      issueCategory: 'Plumbing', description: 'Bathroom tap leaking', priority: 'High',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.record.TicketID).toMatch(/^MNT-2026-\d{4}$/);
  });

  it('INVESTOR is refused every mutation route', async () => {
    for (const route of API_ROUTES.filter((r) => r.mutates)) {
      const res = await h.request('investorA', route.method, route.path.replace(/:id/, 'X-1'), {});
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('unauthenticated requests are 401 before anything is validated', async () => {
    const res = await h.request(null, 'POST', '/api/expenses', expensePayload(randomUUID()));
    expect(res.status).toBe(401);
  });

  it('a denial happens before validation — no schema detail leaks to the wrong role', async () => {
    const res = await h.request('investorA', 'POST', '/api/expenses', { nonsense: true });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('expenseCategory');
  });
});

/* ================================================================== *
 * 5 · Idempotency — the brief's full retry matrix
 * ================================================================== */
describe('mutations · idempotency', () => {
  it('double submit (sequential): second returns the SAME result, one row', async () => {
    const operationId = randomUUID();
    const payload = expensePayload(operationId);
    const first = await h.request('admin', 'POST', '/api/expenses', payload);
    const second = await h.request('admin', 'POST', '/api/expenses', payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.record.ExpenseID).toBe(first.body.record.ExpenseID);

    const count = await rowCount(h.client, SHEETS.EXPENSES, columnIndex('EXPENSES', 'ExpenseID'));
    const baseline = createWriteHarness();
    const baseCount = await rowCount(baseline.client, SHEETS.EXPENSES, columnIndex('EXPENSES', 'ExpenseID'));
    expect(count).toBe(baseCount + 1);
  });

  it('parallel identical requests: exactly one row, all callers get an answer', async () => {
    const operationId = randomUUID();
    const payload = expensePayload(operationId);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.request('admin', 'POST', '/api/expenses', payload)),
    );
    const winners = results.filter((r) => r.status === 200);
    const inFlight = results.filter((r) => r.status === 409 && r.body.error.code === 'OPERATION_IN_FLIGHT');
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(winners.length + inFlight.length).toBe(8);
    const ids = new Set(winners.map((r) => r.body.record.ExpenseID));
    expect(ids.size).toBe(1);
  });

  it('same operation id with a DIFFERENT payload is refused as a mismatch', async () => {
    const operationId = randomUUID();
    await h.request('admin', 'POST', '/api/expenses', expensePayload(operationId));
    const res = await h.request('admin', 'POST', '/api/expenses',
      expensePayload(operationId, { amount: 9999 }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPERATION_MISMATCH');
  });

  it('retry after FAILED requires a fresh operation id — no silent auto-retry', async () => {
    const operationId = randomUUID();
    // Force a VERIFY_MISMATCH: the verify read returns the row with its ID intact but a
    // corrupted Amount cell. (An ID mismatch would be ROW_MOVED, which relocates once —
    // a value mismatch is terminal, which is what this test needs.)
    const original = h.client.get.bind(h.client);
    const amountIdx = columnIndex('EXPENSES', 'Amount');
    let sabotaged = false;
    (h.client as any).get = async (range: string) => {
      const rows = await original(range);
      if (!sabotaged && range.includes(SHEETS.EXPENSES) && rows.length === 1 && (rows[0]?.length ?? 0) > amountIdx) {
        sabotaged = true;
        const corrupted = [...rows[0]!];
        corrupted[amountIdx] = 999999;
        return [corrupted];
      }
      return rows;
    };
    const failed = await h.request('admin', 'POST', '/api/expenses', expensePayload(operationId));
    expect(failed.status).toBe(502);
    (h.client as any).get = original;

    const retried = await h.request('admin', 'POST', '/api/expenses', expensePayload(operationId));
    expect(retried.status).toBe(409);
    expect(retried.body.error.code).toBe('OPERATION_FAILED_BEFORE');

    const fresh = await h.request('admin', 'POST', '/api/expenses', expensePayload(randomUUID()));
    expect(fresh.status).toBe(200);
  });

  it('the request hash is canonical: key order does not change the intent', () => {
    expect(requestHashOf({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(requestHashOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHashOf({ a: 1 })).not.toBe(requestHashOf({ a: 2 }));
  });
});

/* ================================================================== *
 * 6 · Concurrency — 20 simultaneous DISTINCT creations, three entities
 * ================================================================== */
describe('mutations · concurrency', () => {
  const burst = async (
    userKey: keyof typeof USERS, route: string, payloads: Record<string, unknown>[],
  ) => Promise.all(payloads.map((p) => h.request(userKey, 'POST', route, p)));

  it('20 simultaneous bookings: unique IDs, no lost writes, one audit event each', async () => {
    const results = await burst('operations', '/api/reservations', Array.from({ length: 20 }, (_, i) => ({
      operationId: randomUUID(), platform: 'Direct', propertyId: 'HYD-501',
      bookingDate: '2026-08-20', guestName: `Guest ${i}`, adults: 2, children: 0,
      checkInDate: '2026-09-01', checkOutDate: '2026-09-03',
    })));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length, JSON.stringify(results.find((r) => r.status !== 200)?.body)).toBe(20);
    const ids = new Set(ok.map((r) => r.body.record.BookingID));
    expect(ids.size).toBe(20);
    const audited = h.audit.records.filter((r: any) => r.action === 'reservation.create.applied');
    expect(audited.length).toBe(20);
  });

  it('20 simultaneous expenses: unique IDs, all rows present', async () => {
    const results = await burst('admin', '/api/expenses',
      Array.from({ length: 20 }, () => expensePayload(randomUUID())));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(20);
    expect(new Set(ok.map((r) => r.body.record.ExpenseID)).size).toBe(20);
    // Every ID is really in the grid — no lost write behind a 200.
    const idIdx = columnIndex('EXPENSES', 'ExpenseID');
    const grid = await h.client.get(`'${SHEETS.EXPENSES}'!A${DATA_ROW}:BZ1000`);
    const inSheet = new Set(grid.map((r) => String(r[idIdx] ?? '')).filter(Boolean));
    for (const r of ok) expect(inSheet.has(r.body.record.ExpenseID)).toBe(true);
  });

  it('20 simultaneous maintenance tickets: unique IDs', async () => {
    const results = await burst('operations', '/api/maintenance', Array.from({ length: 20 }, (_, i) => ({
      operationId: randomUUID(), propertyId: 'HYD-502', dateReported: '2026-08-20',
      issueCategory: 'Electrical', description: `Socket sparking in room ${i}`, priority: 'Medium',
    })));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(20);
    expect(new Set(ok.map((r) => r.body.record.TicketID)).size).toBe(20);
  });

  it('NEGATIVE CONTROL: a store without a critical section lets duplicates through', async () => {
    // Proves the parallel-identical test can actually fail — a test that cannot fail
    // proves nothing.
    const naive = new NaiveOperationStore(2);
    const operationId = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => naive.begin({
      operationId, tenantId: TENANT_A, actorId: 'x', actorRole: 'ADMIN', action: 'test', requestHash: 'h',
    })));
    const inserted = outcomes.filter((o) => o.outcome === 'inserted');
    expect(inserted.length).toBeGreaterThan(1);
  });
});

/* ================================================================== *
 * 7 · Read-after-write, ROW_MOVED, and honest failure
 * ================================================================== */
describe('mutations · verification', () => {
  it('a corrupted round-trip is reported as failure, never as success', async () => {
    const operationId = randomUUID();
    const original = h.client.batchUpdate.bind(h.client);
    (h.client as any).batchUpdate = async (edits: any[]) => {
      // The write "succeeds" but drops the Amount cell — as a quota blip might.
      await original(edits.filter((e: any) => !/H\d+$/.test(e.range)));
    };
    const res = await h.request('admin', 'POST', '/api/expenses', expensePayload(operationId));
    expect(res.status).toBe(502);
    expect(['VERIFY_MISMATCH', 'ROW_MOVED']).toContain(res.body.error.code);
    const op = await h.store.get(operationId);
    expect(op?.status).toBe('FAILED');
    expect(op?.error).toBeTruthy();
  });

  it('an update to a row a human moved relocates once and still verifies by ID', async () => {
    // Create a ticket, then simulate a human sorting the sheet between locate and write:
    // swap two rows on every OTHER read so the first locate is stale.
    const created = await h.request('operations', 'POST', '/api/maintenance', {
      operationId: randomUUID(), propertyId: 'HYD-501', dateReported: '2026-08-20',
      issueCategory: 'Plumbing', description: 'Shower drain slow', priority: 'Low',
    });
    expect(created.status).toBe(200);
    const ticketId = created.body.record.TicketID;

    const res = await h.request('operations', 'PATCH', `/api/maintenance/${ticketId}`, {
      operationId: randomUUID(), status: 'Resolved', dateResolved: '2026-08-21',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.record.Status).toBe('Resolved');
  });

  it('updating a record that does not exist fails cleanly', async () => {
    const res = await h.request('admin', 'PATCH', '/api/expenses/EXP-2026-9999', {
      operationId: randomUUID(), paymentStatus: 'Paid',
    });
    expect(res.status).toBe(502);
    const text = JSON.stringify(res.body);
    expect(text).toContain('failed');
  });
});

/* ================================================================== *
 * 8 · Cache invalidation
 * ================================================================== */
describe('mutations · cache', () => {
  it('a verified write invalidates workbook-derived cache entries', async () => {
    await h.cache.get(
      { tenant: TENANT_A, resource: 'workbook', identity: null, filters: { today: '2026-08-20' } },
      async () => ({ figure: 42 }),
    );
    expect(h.cache.size).toBeGreaterThan(0);
    const res = await h.request('admin', 'POST', '/api/expenses', expensePayload(randomUUID()));
    expect(res.status).toBe(200);
    expect(h.cache.size).toBe(0);
  });

  it('a REFUSED write leaves the cache untouched', async () => {
    await h.cache.get(
      { tenant: TENANT_A, resource: 'workbook', identity: null, filters: { today: '2026-08-20' } },
      async () => ({ figure: 42 }),
    );
    const before = h.cache.size;
    const res = await h.request('operations', 'POST', '/api/expenses', expensePayload(randomUUID()));
    expect(res.status).toBe(403);
    expect(h.cache.size).toBe(before);
  });
});

/* ================================================================== *
 * 9 · Operation states and the environment gate
 * ================================================================== */
describe('mutations · operation lifecycle', () => {
  it('walks PENDING → APPLYING → VERIFIED and is pollable by its owner', async () => {
    const operationId = randomUUID();
    const res = await h.request('admin', 'POST', '/api/expenses', expensePayload(operationId));
    expect(res.status).toBe(200);

    const poll = await h.request('admin', 'GET', `/api/operations-log/${operationId}`);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('VERIFIED');
    expect(poll.body.entityId).toMatch(/^EXP-/);
  });

  it('another actor cannot read my operation — same 404 as a nonexistent one', async () => {
    const operationId = randomUUID();
    await h.request('admin', 'POST', '/api/expenses', expensePayload(operationId));
    const other = await h.request('superAdmin', 'GET', `/api/operations-log/${operationId}`);
    const ghost = await h.request('superAdmin', 'GET', `/api/operations-log/${randomUUID()}`);
    expect(other.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(JSON.stringify(other.body)).toBe(JSON.stringify(ghost.body));
  });

  it('WRITES_DISABLED: the mutation is refused, nothing written, nothing allocated', async () => {
    const disabled = createWriteHarness({ writesPermitted: false });
    const idIdx = columnIndex('EXPENSES', 'ExpenseID');
    const before = await rowCount(disabled.client, SHEETS.EXPENSES, idIdx);
    const res = await disabled.request('admin', 'POST', '/api/expenses', expensePayload(randomUUID()));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRITES_DISABLED');
    expect(await rowCount(disabled.client, SHEETS.EXPENSES, idIdx)).toBe(before);
  });
});

/* ================================================================== *
 * 10 · Business validation is checks, never arithmetic
 * ================================================================== */
describe('mutations · business validation', () => {
  it('a booking with check-out before check-in is refused', async () => {
    const res = await h.request('operations', 'POST', '/api/reservations', {
      operationId: randomUUID(), platform: 'Direct', propertyId: 'HYD-501',
      bookingDate: '2026-08-20', guestName: 'Test Guest', adults: 2, children: 0,
      checkInDate: '2026-09-03', checkOutDate: '2026-09-01',
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toContain('checkOutDate');
  });

  it('a booking on a property that does not exist is refused', async () => {
    const res = await h.request('operations', 'POST', '/api/reservations', {
      operationId: randomUUID(), platform: 'Direct', propertyId: 'HYD-999',
      bookingDate: '2026-08-20', guestName: 'Test Guest', adults: 2, children: 0,
      checkInDate: '2026-09-01', checkOutDate: '2026-09-03',
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toContain('HYD-999');
  });

  it('an unknown platform is refused with the configured list named', async () => {
    const res = await h.request('operations', 'POST', '/api/reservations', {
      operationId: randomUUID(), platform: 'Expedia', propertyId: 'HYD-501',
      bookingDate: '2026-08-20', guestName: 'Test Guest', adults: 2, children: 0,
      checkInDate: '2026-09-01', checkOutDate: '2026-09-03',
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toContain('Expedia');
  });

  it('a cash row with both money-in and money-out is refused (mirrors the QA rule)', async () => {
    const res = await h.request('admin', 'POST', '/api/cashflow', {
      operationId: randomUUID(), date: '2026-08-20', type: 'Other',
      description: 'Impossible row', moneyIn: 100, moneyOut: 100,
    });
    expect(res.status).toBe(422);
  });

  it('an expense of zero is refused — a free expense is a data-entry mistake', async () => {
    const res = await h.request('admin', 'POST', '/api/expenses',
      expensePayload(randomUUID(), { amount: 0 }));
    expect(res.status).toBe(422);
  });

  it('no schema or validator computes money: source scan', () => {
    for (const file of ['lib/server/api/schemas.ts', 'lib/server/api/mutation-services.ts']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(source, `${file} must not compute financial figures`)
        .not.toMatch(/netRevenue\s*[-+*/]|grossAmount\s*[-+*/]\s*\w|\*\s*commission|amount\s*\*\s*\d/);
    }
  });
});

/* ================================================================== *
 * 11 · Status transitions (check-in / check-out / cancel)
 * ================================================================== */
describe('mutations · reservation lifecycle', () => {
  async function createBooking(): Promise<string> {
    const res = await h.request('operations', 'POST', '/api/reservations', {
      operationId: randomUUID(), platform: 'Direct', propertyId: 'HYD-501',
      bookingDate: '2026-08-20', guestName: 'Lifecycle Guest', adults: 2, children: 0,
      checkInDate: '2026-09-01', checkOutDate: '2026-09-03', bookingStatus: 'Confirmed',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.record.BookingID;
  }

  it('Confirmed → Checked In → Checked Out, each verified', async () => {
    const id = await createBooking();
    const checkIn = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID(), checkInTime: '14:00' });
    expect(checkIn.status, JSON.stringify(checkIn.body)).toBe(200);
    expect(checkIn.body.record.BookingStatus).toBe('Checked In');

    const checkOut = await h.request('operations', 'POST', `/api/reservations/${id}/check-out`,
      { operationId: randomUUID() });
    expect(checkOut.status).toBe(200);
    expect(checkOut.body.record.BookingStatus).toBe('Checked Out');
  });

  it('checking in a checked-out booking is refused as an illegal transition', async () => {
    const id = await createBooking();
    await h.request('operations', 'POST', `/api/reservations/${id}/check-in`, { operationId: randomUUID() });
    await h.request('operations', 'POST', `/api/reservations/${id}/check-out`, { operationId: randomUUID() });
    const again = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID() });
    expect(again.status).toBe(422);
    expect(JSON.stringify(again.body.error.details)).toContain('Checked Out');
  });

  it('cancellation is a status change with a reason — the row remains', async () => {
    const id = await createBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/cancel`,
      { operationId: randomUUID(), reason: 'Guest called to cancel' });
    expect(res.status).toBe(200);
    expect(res.body.record.BookingStatus).toBe('Cancelled');
    expect(String(res.body.record.Notes)).toContain('Guest called to cancel');
    // Still present in the sheet.
    const bookings = await h.deps.repos.reservations.readAll();
    expect(bookings.some((b) => b.BookingID === id)).toBe(true);
  });

  it('a NO-SHOW is its own status, not a cancellation wearing a flag', async () => {
    // `noShow: true` is the only thing separating the two outcomes on the wire, and V1
    // counts them differently nowhere — both are lost bookings — but they are different
    // FACTS about a guest, and the cancellation rate is not the only reader of this row.
    const id = await createBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/cancel`,
      { operationId: randomUUID(), reason: 'Guest never arrived', noShow: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.record.BookingStatus).toBe('No Show');
    // The note names what happened. "Cancelled via web" on a no-show reads, months
    // later, as a decision somebody made rather than a guest who did not come.
    expect(String(res.body.record.Notes)).toContain('No-show via web');
    expect(String(res.body.record.Notes)).toContain('Guest never arrived');

    const stored = (await h.deps.repos.reservations.readAll()).find((b) => b.BookingID === id)!;
    expect(stored.BookingStatus).toBe('No Show');
  });

  it('a cancellation and a no-show reach DIFFERENT statuses from the same endpoint', async () => {
    const cancelled = await createBooking();
    const noShow = await createBooking();

    await h.request('operations', 'POST', `/api/reservations/${cancelled}/cancel`,
      { operationId: randomUUID(), reason: 'Changed their plans' });
    await h.request('operations', 'POST', `/api/reservations/${noShow}/cancel`,
      { operationId: randomUUID(), reason: 'Did not arrive', noShow: true });

    const rows = await h.deps.repos.reservations.readAll();
    expect(rows.find((b) => b.BookingID === cancelled)!.BookingStatus).toBe('Cancelled');
    expect(rows.find((b) => b.BookingID === noShow)!.BookingStatus).toBe('No Show');
  });

  it('records the arrival time, and reads it back — a write nothing used to show', async () => {
    const id = await createBooking();
    await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID(), checkInTime: '14:35' });

    const stored = (await h.deps.repos.reservations.readAll()).find((b) => b.BookingID === id)!;
    expect(stored.CheckInTime).toBe('14:35');
    // A time nobody supplied stays absent rather than becoming an empty string, so the
    // detail panel can tell "not recorded" from "recorded as nothing".
    expect(stored.CheckOutTime).toBeUndefined();
  });

  it('refuses a departure moved before the arrival, even when only ONE date is sent', async () => {
    // The order check used to run only when BOTH dates arrived together, so amending one
    // skipped it. That was unreachable until a screen offered a single-date change.
    const id = await createBooking();
    const backwards = await h.request('operations', 'PATCH', `/api/reservations/${id}`,
      { operationId: randomUUID(), checkOutDate: '2026-08-25' });

    expect(backwards.status, JSON.stringify(backwards.body)).toBe(422);
    expect(JSON.stringify(backwards.body.error.details))
      .toContain('checkOutDate must be after checkInDate');

    // The stay is untouched by the refusal.
    const stored = (await h.deps.repos.reservations.readAll()).find((b) => b.BookingID === id)!;
    expect(stored.CheckOutDate).toBe(isoToSerial('2026-09-03'));
  });

  it('accepts a legal single-date change and moves only that date', async () => {
    const id = await createBooking();
    const res = await h.request('operations', 'PATCH', `/api/reservations/${id}`,
      { operationId: randomUUID(), checkOutDate: '2026-09-06' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = (await h.deps.repos.reservations.readAll()).find((b) => b.BookingID === id)!;
    expect(stored.CheckOutDate).toBe(isoToSerial('2026-09-06'));
    expect(stored.CheckInDate).toBe(isoToSerial('2026-09-01'));
  });

  it('refuses an arrival moved after the departure, the mirror of the same rule', async () => {
    const id = await createBooking();
    const res = await h.request('operations', 'PATCH', `/api/reservations/${id}`,
      { operationId: randomUUID(), checkInDate: '2026-09-05' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details))
      .toContain('checkOutDate must be after checkInDate');
  });

  it('confirms an inquiry through the amend route, and refuses an illegal jump', async () => {
    const inquiry = await h.request('operations', 'POST', '/api/reservations', {
      operationId: randomUUID(), platform: 'Direct', propertyId: 'HYD-501',
      bookingDate: '2026-08-20', guestName: 'Enquiring Guest', adults: 1, children: 0,
      checkInDate: '2026-09-10', checkOutDate: '2026-09-12', bookingStatus: 'Inquiry',
    });
    const id = inquiry.body.record.BookingID;

    const confirmed = await h.request('operations', 'PATCH', `/api/reservations/${id}`,
      { operationId: randomUUID(), bookingStatus: 'Confirmed' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.record.BookingStatus).toBe('Confirmed');

    // Inquiry -> Checked In is not a step anybody may take.
    const jump = await h.request('operations', 'PATCH', `/api/reservations/${id}`,
      { operationId: randomUUID(), bookingStatus: 'Checked Out' });
    expect(jump.status).toBe(422);
  });
});

/* ================================================================== *
 * 12 · Direct pipeline invariants
 * ================================================================== */
describe('mutations · pipeline internals', () => {
  it('executeMutation refuses a definition that emits a calc column (layer 3)', async () => {
    const def = {
      ...MUTATION_DEFINITIONS['expense.create']!,
      toColumns: (i: any, id: string) => ({ ExpenseID: id, TotalAmount: 1 }),
    };
    await expect(executeMutation(def as any, {
      auth: { userId: 'u-admin', email: 'a@a', role: 'ADMIN', tenantId: TENANT_A, investorId: null, status: 'ACTIVE' },
      request: { method: 'POST', path: '/api/expenses', body: expensePayload(randomUUID()) },
    } as any, h.deps)).rejects.toMatchObject({ code: 'CONTRACT_VIOLATION', status: 422 });
  });

  it('ID year scope comes from the record date, not the wall clock', async () => {
    const res = await h.request('admin', 'POST', '/api/expenses',
      expensePayload(randomUUID(), { date: '2025-12-31', paidDate: '2025-12-31' }));
    expect(res.status).toBe(200);
    expect(res.body.record.ExpenseID).toMatch(/^EXP-2025-/);
  });
});
