/**
 * M-SEC-1 — THE INVENTORY WRITE PATH, ATTACKED.
 *
 * `tests/inventory.test.ts` proves the domain behaves. This suite proves it cannot be made to
 * misbehave: that there is exactly ONE way to move stock, that two movements on one item
 * cannot lose an increment, that a retry cannot move it twice, that a foreign tenant's
 * identifier is nowhere a key, and that a repair cannot become a licence to rewrite the
 * authoritative figure.
 *
 * THE CONCURRENCY TESTS ARE DETERMINISTIC. Not one of them sleeps, polls a clock, or races a
 * timer. They work because `withItemLock` makes the ordering a property of the code rather
 * than of the machine — and each of them genuinely fails when the lock is removed, which is
 * what the mutation battery in the M-SEC-1 report exists to demonstrate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { API_ROUTES, assertWriteGovernance } from '@/lib/server/api/routes';
import { registerInventoryHandlers } from '@/lib/server/api/inventory-handlers';
import { registerHrHandlers } from '@/lib/server/api/hr-handlers';
import { registerFinanceHandlers } from '@/lib/server/api/finance-handlers';
import { MUTATION_DEFINITIONS } from '@/lib/server/api/mutation-services';
import { executeMutation, MutationError } from '@/lib/server/api/mutations';
import { InMemoryHrRepository } from '@/lib/server/hr/repository';
import { HrService } from '@/lib/server/hr/service';
import { InMemoryFinanceRepository } from '@/lib/server/finance/repository';
import { FinanceService } from '@/lib/server/finance/service';
import { InMemoryInventoryRepository } from '@/lib/server/inventory/repository';
import {
  InventoryService, type WorkbookStockRow, type WorkbookAssetRow,
} from '@/lib/server/inventory/service';
import { withItemLock, itemLockKey } from '@/lib/server/inventory/serialize';
import type { TestUser } from '@/lib/server/auth/session';
import { TENANT_A, TENANT_B, USERS } from './support/harness';
import { createWriteHarness } from './support/write-harness';
import { readSource as read } from './support/source';

/* ------------------------------------------------------------------ *
 * Harness — the M-INV-1 one, plus the seams an attacker needs
 * ------------------------------------------------------------------ */

const ADMIN_A: TestUser = {
  userId: 'u-adm-a', email: 'adm.a@example.test', role: 'ADMIN',
  tenantId: TENANT_A, token: 'tok-adm-a',
};
const ADMIN2_A: TestUser = {
  userId: 'u-adm-a2', email: 'adm.a2@example.test', role: 'ADMIN',
  tenantId: TENANT_A, token: 'tok-adm-a2',
};
const OPS_A: TestUser = {
  userId: 'u-ops-a', email: 'ops.a@example.test', role: 'OPERATIONS',
  tenantId: TENANT_A, token: 'tok-ops-a',
};
const ADMIN_B: TestUser = {
  userId: 'u-adm-b', email: 'adm.b@example.test', role: 'ADMIN',
  tenantId: TENANT_B, token: 'tok-adm-b',
};
const OPS_B: TestUser = {
  userId: 'u-ops-b', email: 'ops.b@example.test', role: 'OPERATIONS',
  tenantId: TENANT_B, token: 'tok-ops-b',
};

const PROPERTIES: Record<string, string[]> = {
  [TENANT_A]: ['HYD-501', 'HYD-502'],
  [TENANT_B]: ['HYD-601'],
};

const ROLLS = 'ITM-D-001';
const TOWELS = 'ITM-D-002';
const DETERGENT = 'ITM-D-004';

const op = () => randomUUID();
const ctx = (tenantId: string) =>
  ({ tenantId, userId: 'test-reader', role: 'ADMIN' }) as never;

interface Seams {
  /** Make the workbook refuse every write. */
  failSheet: boolean;
  /**
   * A foreign writer, interposed between the service's read and the mutation's compare.
   *
   * This is how a SECOND PROCESS is modelled: it moves the sheet at exactly the moment the
   * in-process mutex cannot protect against, which is the only window the design claims to
   * detect rather than prevent. `remaining` counts how many more times it fires, so a test
   * can choose between "one interloper, retried successfully" and "an item so hot the retry
   * budget runs out".
   */
  interpose: { remaining: number; column: 'Purchased' | 'Used'; by: number };
  /** Make the overlay refuse to record context AFTER the workbook has taken the write. */
  failContextRecord: boolean;
  /**
   * How many writes the precondition has refused.
   *
   * The direct evidence of serialisation. A collision that never happens leaves no refusal
   * behind, so with the item lock in place this stays at zero however many movements arrive
   * together — and without it, it does not.
   */
  stalePreconditions: number;
}

function harness() {
  const wb = createWriteHarness({}, {
    tenants: [TENANT_A, TENANT_B],
    users: [...Object.values(USERS), ADMIN_A, ADMIN2_A, OPS_A, ADMIN_B, OPS_B],
  });

  const invRepo = new InMemoryInventoryRepository();
  const hrRepo = new InMemoryHrRepository();
  const financeRepo = new InMemoryFinanceRepository();
  const seams: Seams = {
    failSheet: false,
    interpose: { remaining: 0, column: 'Used', by: 0 },
    failContextRecord: false,
    stalePreconditions: 0,
  };

  const hrService = new HrService({
    repo: hrRepo,
    propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
    isPeriodClosed: async () => false,
    audit: wb.deps.audit,
  });
  const financeService = new FinanceService({
    repo: financeRepo,
    propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
    audit: wb.deps.audit,
  });

  const stockRows = async (tenant: { tenantId: string }): Promise<readonly WorkbookStockRow[]> =>
    (await wb.reposFor(tenant.tenantId as never).inventory.readAll()).map((i) => ({
      itemRef: i.itemId, propertyId: i.propertyId || null, category: i.category,
      name: i.item, unit: i.unit, openingStock: i.openingStock,
      purchased: i.purchased, used: i.used, currentStock: i.currentStock,
      minStock: i.minStock, vendorName: i.vendor || null,
    }));

  const assetRows = async (tenant: { tenantId: string }): Promise<readonly WorkbookAssetRow[]> =>
    (await wb.reposFor(tenant.tenantId as never).assets.readAll()).map((a) => ({
      assetRef: a.assetId, propertyId: a.propertyId || null, category: a.category,
      name: a.asset, purchaseDate: a.purchaseDate || null,
      purchaseCostMinor: Math.round(a.purchaseCost * 100), vendorName: a.vendor || null,
      warrantyExpiry: a.warrantyExpiry, warrantyLabel: a.warrantyStatus,
      condition: a.condition, status: a.currentStatus, disposalDate: a.disposalDate,
    }));

  /*
   * A repository wrapper that can refuse to record context AFTER a successful sheet write —
   * the partial-failure window the two stores cannot close between them.
   */
  const repoProxy = new Proxy(invRepo, {
    get(target, prop, receiver) {
      if (prop !== 'recordMovement') return Reflect.get(target, prop, receiver);
      const original = invRepo.recordMovement.bind(invRepo);
      return async (...args: Parameters<typeof original>) => {
        const [, row] = args;
        if (seams.failContextRecord && row.workbookApplied) {
          throw new Error('overlay unavailable');
        }
        return original(...args);
      };
    },
  });

  const service = new InventoryService({
    repo: repoProxy,
    hr: hrService,
    stockRows: stockRows as never,
    assetRows: assetRows as never,
    propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
    vendor: (tenant, vendorId) => financeRepo.getVendor(tenant, vendorId),
    writeTotals: async (write, itemRef, totals, expected) => {
      if (seams.failSheet) {
        throw new MutationError(502, 'SHEETS_UNAVAILABLE', 'The workbook did not answer.');
      }
      /*
       * THE OTHER PROCESS. Fires between the service's read and the mutation's compare,
       * which is precisely the window an in-process mutex cannot cover.
       */
      if (seams.interpose.remaining > 0) {
        seams.interpose.remaining -= 1;
        const tenantId = (write.auth as { tenantId: string }).tenantId;
        const repos = wb.reposFor(tenantId as never);
        const current = (await repos.inventory.readAll()).find((i) => i.itemId === itemRef)!;
        const was = seams.interpose.column === 'Purchased' ? current.purchased : current.used;
        await repos.inventory.updateByIdVerified(itemRef,
          { [seams.interpose.column]: (was ?? 0) + seams.interpose.by });
      }
      try {
        await executeMutation(MUTATION_DEFINITIONS['inventory.update']!, {
          auth: write.auth,
          request: {
            method: 'PATCH', path: `/api/inventory/${itemRef}`,
            headers: {}, query: {}, params: { id: itemRef },
            body: { operationId: op(), ...totals, ...expected },
            requestId: write.requestId,
          },
        } as never, wb.deps);
      } catch (error) {
        if ((error as { code?: string })?.code === 'STALE_PRECONDITION') {
          seams.stalePreconditions += 1;
        }
        throw error;
      }
    },
    audit: wb.deps.audit,
  });

  registerInventoryHandlers(wb.router, async () => ({
    service, store: wb.store, audit: wb.deps.audit, writesPermitted: true,
  }));
  registerHrHandlers(wb.router, async () => ({
    service: hrService, store: wb.store, audit: wb.deps.audit, writesPermitted: true,
  }));
  registerFinanceHandlers(wb.router, async () => ({
    service: financeService, store: wb.store, audit: wb.deps.audit, writesPermitted: true,
  }));

  return { wb, invRepo, service, seams, request: wb.requestAs.bind(wb) };
}

type Harness = ReturnType<typeof harness>;
let h: Harness;
let vendorSeq = 0;
beforeEach(() => { h = harness(); vendorSeq = 0; });

async function itemRow(tenantId: string, itemRef: string) {
  return (await h.wb.reposFor(tenantId as never).inventory.readAll())
    .find((i) => i.itemId === itemRef)!;
}

function move(token: string, itemRef: string, quantity: number, extra: object = {}) {
  return h.request(token, 'POST', '/api/inventory/movements', {
    operationId: op(), itemRef, movementType: 'CONSUMPTION', quantity, ...extra,
  });
}

async function aVendor(token: string, displayName?: string) {
  const res = await h.request(token, 'POST', '/api/finance/vendors', {
    operationId: op(), displayName: displayName ?? `Vendor ${(vendorSeq += 1)}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.id);
}

async function aSentOrder(itemRef: string, quantity: number) {
  const vendorId = await aVendor(ADMIN_A.token);
  const created = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
    operationId: op(), vendorId, lines: [{ itemRef, quantity }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const poId = String(created.body.id);
  for (const [token, status] of [
    [ADMIN_A.token, 'SUBMITTED'], [ADMIN2_A.token, 'APPROVED'], [ADMIN_A.token, 'SENT'],
  ] as const) {
    const r = await h.request(token, 'POST', `/api/inventory/purchase-orders/${poId}/status`,
      { operationId: op(), status });
    expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const list = await h.request(ADMIN_A.token, 'GET', '/api/inventory/purchase-orders');
  const po = list.body.find((p: any) => p.id === poId);
  return { poId, lineId: String(po.lines[0].id) };
}

/* ================================================================== *
 * 1 · WRITE-PATH ARCHITECTURE (PHASE A / B)
 * ================================================================== */

describe('write path · exactly one way to move stock', () => {
  it('no inventory domain file reaches a sheets client', () => {
    /*
     * The architecture rule this milestone was asked for. Every stock write must go through
     * executeMutation, which owns the contract check, the read-after-write, the operation
     * ledger and the audit record. A file here importing a client would be a way around all
     * four, and the next person to want a quick fix will reach for exactly that.
     */
    for (const file of [
      'lib/server/inventory/service.ts',
      'lib/server/inventory/repository.ts',
      'lib/server/inventory/supabase-repository.ts',
      'lib/server/inventory/projections.ts',
      'lib/server/inventory/types.ts',
      'lib/server/inventory/serialize.ts',
      'lib/server/inventory/page-context.ts',
      'lib/server/api/inventory-handlers.ts',
    ]) {
      const source = read(file);
      expect(source, `${file} must not import a sheets client`)
        .not.toMatch(/from\s+['"][^'"]*sheets\/client['"]/);
      expect(source, `${file} must not construct a sheets client`)
        .not.toMatch(/new\s+(GoogleSheetsApiClient|InMemorySheetsClient)\b/);
      // …nor reach the workbook through a repository set it built itself.
      expect(source, `${file} must not build its own repositories`)
        .not.toMatch(/\bcreateRepositories\s*\(/);
    }
  });

  it('the internal stock mutation is not reachable from any route', () => {
    // Belt: the route table has no such action.
    expect(API_ROUTES.filter((r) => r.action === 'inventory.update')).toEqual([]);

    // Braces: governance refuses one if it is ever added.
    const failures: string[] = [];
    assertWriteGovernance(
      [...API_ROUTES, {
        method: 'PATCH', path: '/api/inventory/:id', capability: 'inventory.write',
        mutates: true, action: 'inventory.update', entityType: 'INVENTORY', summary: 'x',
      } as never],
      (ok, message) => { if (!ok) failures.push(message); },
    );
    expect(failures.join(' ')).toMatch(/inventory\.update.*must not be routable/s);
  });

  it('the item-details mutation cannot emit a stock column, whatever it is sent', () => {
    const def = MUTATION_DEFINITIONS['inventory.master.update']!;
    // Sent every stock field an attacker might try; the mapping has nowhere to put them.
    const emitted = def.toColumns(
      { purchased: 5, used: 5, currentStock: 5, reorderStatus: 'Low', minStock: 2 } as never,
      'ITM-D-001',
    );
    expect(Object.keys(emitted)).not.toContain('Purchased');
    expect(Object.keys(emitted)).not.toContain('Used');
    expect(Object.keys(emitted)).not.toContain('CurrentStock');
    expect(Object.keys(emitted)).not.toContain('ReorderStatus');
    // And the schema refuses them before the mapping is ever consulted.
    expect(def.schema.safeParse({ operationId: randomUUID(), used: 1 }).success).toBe(false);
    expect(def.schema.safeParse({ operationId: randomUUID(), purchased: 1 }).success).toBe(false);
  });

  it('a PATCH aimed at a collection path cannot move stock through the :id route', async () => {
    /*
     * ROUTE SHADOWING, and why it is now harmless rather than merely unlikely.
     *
     * `PATCH /api/inventory/:id` compiles to ^/api/inventory/[^/]+$, so a PATCH to
     * /api/inventory/movements or /reconciliation matches it and is dispatched as an edit to
     * an item whose ItemID is literally "movements". Before M-SEC-1 that route accepted
     * absolute `purchased` and `used`, so the shadow was a second way to aim a stock write.
     * It now runs `inventory.master.update`, which has no such fields — so the shadow can
     * still be ENTERED and can no longer do anything.
     */
    const before = await itemRow(TENANT_A, ROLLS);
    for (const collection of [
      'stock', 'movements', 'requests', 'reconciliation',
      'purchase-orders', 'goods-receipts', 'vendor-links', 'assets',
    ]) {
      const stock = await h.request(ADMIN_A.token, 'PATCH', `/api/inventory/${collection}`,
        { operationId: op(), used: 99, purchased: 99 });
      // Refused for shape, before anything is looked up or written.
      expect(stock.status, `PATCH /api/inventory/${collection}`).toBe(422);
    }
    const after = await itemRow(TENANT_A, ROLLS);
    expect(after.used).toBe(before.used);
    expect(after.purchased).toBe(before.purchased);
  });

  it('every non-GET inventory route is governed and answers', async () => {
    const failures: string[] = [];
    assertWriteGovernance(API_ROUTES, (ok, m) => { if (!ok) failures.push(m); });
    expect(failures).toEqual([]);

    /*
     * Every governed route must actually have a handler behind it. Probed by the router's
     * OWN "no such endpoint" message rather than by the 404 status: a registered route may
     * legitimately answer 404 for an entity that does not exist, and asserting on the status
     * alone would call a working route dead.
     */
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/inventory/'))) {
      if (route.method === 'GET') continue;
      const path = route.path.replace(':id', 'PROBE');
      const res = await h.request(ADMIN_A.token, route.method, path, { operationId: op() });
      expect(String(res.body?.error?.message ?? ''), `${route.method} ${path} is unregistered`)
        .not.toMatch(/No such endpoint/i);
    }
  });
});

/* ================================================================== *
 * 2 · CONCURRENCY (PHASE C)
 * ================================================================== */

describe('concurrency · an increment cannot be lost', () => {
  it('serialises rather than colliding — concurrent movements need no retry at all', async () => {
    /*
     * WHAT THIS TEST ISOLATES, and why the sum alone did not.
     *
     * Asserting only the final total cannot tell prevention from recovery: without the lock
     * the movements collide, the precondition refuses them, and the retry recomputes until
     * the arithmetic comes out right anyway. The total is correct either way, so a mutation
     * removing the lock survived a suite that checked only the total.
     *
     * A COLLISION THAT NEVER HAPPENS LEAVES NO REFUSAL BEHIND. Counting the precondition
     * refusals is therefore the direct evidence of serialisation: with the lock there are
     * none, because no two movements on this item are ever in flight together.
     */
    expect(h.seams.stalePreconditions).toBe(0);

    const results = await Promise.all([1, 2, 3, 4, 5].map((q) => move(OPS_A.token, ROLLS, q)));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);

    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(15);
    expect(h.seams.stalePreconditions,
      'a serialised item never has to recover from a collision').toBe(0);
  });

  it('every quantity lands when five movements arrive at once', async () => {
    /*
     * DETERMINISTIC, and it genuinely fails without the lock: `stockRows` awaits before any
     * write happens, so five unsynchronised movements all read 0 and the last writer wins.
     * With the lock each reads what the one before it wrote.
     */
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((q) => move(OPS_A.token, ROLLS, q)),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);

    // 1+2+3+4+5. Not "the last one", which is what a lost update looks like.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(15);
    expect((await h.invRepo.listMovements(ctx(TENANT_A))).length).toBe(5);
  });

  it('does not serialise different items — the lock is per item, not global', async () => {
    const order: string[] = [];
    const slow = withItemLock(itemLockKey(TENANT_A, ROLLS), async () => {
      // Held open until the other item has finished, which it only can if it is not queued.
      await Promise.resolve();
      order.push('rolls-end');
    });
    await withItemLock(itemLockKey(TENANT_A, TOWELS), async () => { order.push('towels'); });
    await slow;
    expect(order[0]).toBe('towels');
  });

  it('does not serialise across tenants holding the same item id', async () => {
    const [a, b] = await Promise.all([
      move(OPS_A.token, ROLLS, 4),
      move(OPS_B.token, ROLLS, 7),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Two workbooks, two totals, neither waiting on the other.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(4);
    expect((await itemRow(TENANT_B, ROLLS)).used).toBe(7);
  });

  it('a failed movement releases the item rather than wedging it', async () => {
    h.seams.failSheet = true;
    const failed = await move(OPS_A.token, ROLLS, 3);
    expect(failed.status).toBe(502);

    h.seams.failSheet = false;
    const ok = await move(OPS_A.token, ROLLS, 2);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(2);
  });

  it('DETECTS another process moving the item, and recomputes rather than clobbering', async () => {
    // One interloper adds 10 to Used between our read and our compare.
    h.seams.interpose = { remaining: 1, column: 'Used', by: 10 };

    const res = await move(OPS_A.token, ROLLS, 3);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    /*
     * 10 from the other process, 3 from ours. Without the compare, ours would have written
     * 0+3 over their 10 and their movement would be gone with nothing to show it had ever
     * happened — the exact loss this milestone set out to close.
     */
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(13);
  });

  it('gives up with a named conflict rather than writing a figure known to be stale', async () => {
    // An item so hot that every attempt is beaten. The retry budget is finite on purpose.
    h.seams.interpose = { remaining: 99, column: 'Used', by: 1 };

    const res = await move(OPS_A.token, ROLLS, 3);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONCURRENT_MOVEMENT');
    // Our 3 is nowhere: only the interloper's increments landed.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(4);
  });

  it('the compare guard is armed on the real definition, not only in this harness', () => {
    const def = MUTATION_DEFINITIONS['inventory.update']!;
    expect(def.expect, 'inventory.update must carry the stock precondition').toBeDefined();
    /*
     * BOTH columns, asserted separately. Checking only `used` left the `purchased` branch of
     * the pairing rule untested — a mutation removing it survived the whole battery, which is
     * precisely the blind spot a battery exists to find.
     */
    const schema = def.schema;
    expect(schema.safeParse({ operationId: randomUUID(), used: 5 }).success).toBe(false);
    expect(schema.safeParse({ operationId: randomUUID(), purchased: 5 }).success).toBe(false);
    expect(schema.safeParse({ operationId: randomUUID(), used: 5, expectedUsed: 2 }).success)
      .toBe(true);
    expect(schema.safeParse({
      operationId: randomUUID(), purchased: 5, expectedPurchased: 2,
    }).success).toBe(true);
    const source = read('lib/server/api/service.ts');
    // The composition root must FORWARD the expectations; a three-argument callback would
    // satisfy the type and silently disarm the guard in production only.
    expect(source).toMatch(/writeTotals:\s*\(write,\s*itemRef,\s*totals,\s*expected\)/);
    expect(source).toMatch(/\.\.\.totals,\s*\.\.\.expected/);
  });
});

/* ================================================================== *
 * 3 · IDEMPOTENCY, RETRY AND PARTIAL FAILURE (PHASE D)
 * ================================================================== */

describe('idempotency · one logical mutation, however many requests', () => {
  it('applies a repeated movement exactly once', async () => {
    const body = {
      operationId: op(), itemRef: ROLLS, movementType: 'CONSUMPTION' as const, quantity: 2,
    };
    const first = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', body);
    const again = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', body);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(2);
    expect((await h.invRepo.listMovements(ctx(TENANT_A))).length).toBe(1);
  });

  it('refuses the same operation id carrying a different intent', async () => {
    const operationId = op();
    await h.request(OPS_A.token, 'POST', '/api/inventory/movements', {
      operationId, itemRef: ROLLS, movementType: 'CONSUMPTION', quantity: 2,
    });
    const changed = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', {
      operationId, itemRef: ROLLS, movementType: 'CONSUMPTION', quantity: 200,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('OPERATION_MISMATCH');
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(2);
  });

  it('does not replay one entity’s result for a request about another', async () => {
    /*
     * The idempotency hash used to omit the path parameter, so two decisions carrying one
     * retried operation id hashed identically however different the entities were. The second
     * was answered `verified` with the FIRST one's stored result: A was approved, B was
     * silently untouched, and the caller was told B had succeeded.
     */
    const first = await h.request(OPS_A.token, 'POST', '/api/inventory/requests', {
      operationId: op(), lines: [{ itemRef: ROLLS, quantity: 2 }],
    });
    const second = await h.request(OPS_A.token, 'POST', '/api/inventory/requests', {
      operationId: op(), lines: [{ itemRef: TOWELS, quantity: 3 }],
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const shared = op();
    const a = await h.request(OPS_A.token,
      'POST', `/api/inventory/requests/${first.body.id}/decision`,
      { operationId: shared, status: 'SUBMITTED' });
    const b = await h.request(OPS_A.token,
      'POST', `/api/inventory/requests/${second.body.id}/decision`,
      { operationId: shared, status: 'SUBMITTED' });

    expect(a.status, JSON.stringify(a.body)).toBe(200);
    // Same key, different entity: a DIFFERENT intent, and refused as one.
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('OPERATION_MISMATCH');
    // Above all, B must never come back wearing A's identity.
    expect(JSON.stringify(b.body)).not.toContain(first.body.id);

    const rows = (await h.request(OPS_A.token, 'GET', '/api/inventory/requests')).body;
    expect(rows.find((r: any) => r.id === first.body.id).status).toBe('SUBMITTED');
    expect(rows.find((r: any) => r.id === second.body.id).status).toBe('DRAFT');
  });

  it('never reports applied when the workbook refused', async () => {
    h.seams.failSheet = true;
    const res = await move(OPS_A.token, ROLLS, 3);
    expect(res.status).toBe(502);

    const rows = await h.invRepo.listMovements(ctx(TENANT_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workbookApplied).toBe(false);
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);
  });

  it('surfaces the workbook-succeeded-context-failed window instead of hiding it', async () => {
    /*
     * The one window two stores cannot close between them. The sheet has taken the write and
     * the overlay then refuses the context row. What must NOT happen is a silent success:
     * the caller has to learn that the stock moved and the reason did not.
     */
    h.seams.failContextRecord = true;
    const res = await move(OPS_A.token, ROLLS, 3);
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The workbook did move — and the operation is recorded as failed, so a retry needs a
    // fresh id and a person has to look, rather than a duplicate landing unnoticed.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(3);
    const failedOps = h.wb.audit.records.filter((r) => r.result === 'ERROR');
    expect(failedOps.length).toBeGreaterThan(0);
  });

  it('a duplicate goods receipt cannot move the stock twice', async () => {
    const { poId, lineId } = await aSentOrder(ROLLS, 10);

    const first = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 10 }],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await itemRow(TENANT_A, ROLLS)).purchased).toBe(10);

    // A NEW operation id — the honest way to retry a delivery that appeared to fail.
    const duplicate = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 10 }],
    });
    expect(duplicate.status).toBe(409);
    /*
     * Refused by whichever guard reaches it first, and BOTH are correct. A fully received
     * order has already moved to RECEIVED, which is not a receivable status — so the
     * lifecycle catches this one before the over-receipt arithmetic needs to. The test below
     * exercises the case where the over-receipt guard is the operative one.
     */
    expect(['OVER_RECEIPT', 'PO_NOT_RECEIVABLE']).toContain(duplicate.body.error.code);
    expect((await itemRow(TENANT_A, ROLLS)).purchased).toBe(10);
  });

  it('refuses the receipt that would take a line past what was ordered', async () => {
    const { poId, lineId } = await aSentOrder(DETERGENT, 10);
    // Six arrive. The order stays receivable, so the lifecycle guard cannot help here.
    const partial = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 6 }],
    });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);

    // A retry of the SAME six would take the line to twelve against an order of ten.
    const overdone = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 6 }],
    });
    expect(overdone.status).toBe(409);
    expect(overdone.body.error.code).toBe('OVER_RECEIPT');
    expect((await itemRow(TENANT_A, DETERGENT)).purchased).toBe(6);
  });

  it('still allows the rest of a short delivery to arrive later', async () => {
    const { poId, lineId } = await aSentOrder(TOWELS, 10);
    const partial = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 6 }],
    });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);

    const rest = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 4 }],
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect((await itemRow(TENANT_A, TOWELS)).purchased).toBe(10);
  });

  it('reports stockApplied truthfully on the receipt it returns', async () => {
    /*
     * This read false on every line of a perfectly applied delivery until M-SEC-1, because
     * the view was built from the receipt as CREATED — before any movement was attached. A
     * supervisor told the stock had not moved records the delivery again, which is the one
     * thing an over-receipt guard should never have to catch.
     */
    const { poId, lineId } = await aSentOrder(DETERGENT, 4);
    const res = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 4 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lines[0].stockApplied).toBe(true);
    expect(res.body.linesNotApplied).toBe(0);
    expect((await itemRow(TENANT_A, DETERGENT)).purchased).toBe(4);
  });

  it('refuses a repeated procurement transition rather than double-advancing', async () => {
    const { poId } = await aSentOrder(ROLLS, 5);
    const again = await h.request(ADMIN_A.token,
      'POST', `/api/inventory/purchase-orders/${poId}/status`,
      { operationId: op(), status: 'SENT' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });
});

/* ================================================================== *
 * 4 · REPAIR (PHASE E)
 * ================================================================== */

describe('repair · explicit, privileged, and never inventive', () => {
  async function anUnappliedMovement() {
    h.seams.failSheet = true;
    await move(OPS_A.token, ROLLS, 3);
    h.seams.failSheet = false;
    const rows = await h.invRepo.listMovements(ctx(TENANT_A));
    expect(rows[0]!.workbookApplied).toBe(false);
    return rows[0]!.id;
  }

  it('re-applies a movement the workbook refused, preserving its original context', async () => {
    const id = await anUnappliedMovement();

    const res = await h.request(ADMIN_A.token, 'POST', `/api/inventory/movements/${id}/repair`,
      { operationId: op() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(3);
    const [row] = await h.invRepo.listMovements(ctx(TENANT_A));
    expect(row!.workbookApplied).toBe(true);
    // The SAME movement, not a new one, and its quantity and reason are untouched.
    expect(row!.id).toBe(id);
    expect(row!.quantity).toBe(3);
    expect(await h.invRepo.listMovements(ctx(TENANT_A))).toHaveLength(1);
  });

  it('adds to the CURRENT total, not the one the failed attempt computed', async () => {
    const id = await anUnappliedMovement();
    // Somebody moved the item while the repair was outstanding.
    await move(OPS_A.token, ROLLS, 5);
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(5);

    await h.request(ADMIN_A.token, `POST`, `/api/inventory/movements/${id}/repair`,
      { operationId: op() });
    // 5 + 3. Replaying the original arithmetic would have written 3 and discarded the 5.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(8);
  });

  it('is refused to OPERATIONS — re-applying is the correcting power, not the recording one', async () => {
    const id = await anUnappliedMovement();
    const res = await h.request(OPS_A.token, 'POST', `/api/inventory/movements/${id}/repair`,
      { operationId: op() });
    expect(res.status).toBe(403);
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);
  });

  it('refuses to re-apply a movement the workbook already took', async () => {
    await move(OPS_A.token, ROLLS, 3);
    const [row] = await h.invRepo.listMovements(ctx(TENANT_A));

    const res = await h.request(ADMIN_A.token,
      'POST', `/api/inventory/movements/${row!.id}/repair`, { operationId: op() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_APPLIED');
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(3);
  });

  it('cannot repair another tenant’s movement', async () => {
    const id = await anUnappliedMovement();
    const res = await h.request(ADMIN_B.token, 'POST', `/api/inventory/movements/${id}/repair`,
      { operationId: op() });
    expect(res.status).toBe(404);
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);
  });

  it('accepts nothing but an id — a repair may not restate the movement', async () => {
    const id = await anUnappliedMovement();
    for (const extra of [{ quantity: 999 }, { itemRef: TOWELS }, { movementType: 'PURCHASE' }]) {
      const res = await h.request(ADMIN_A.token,
        'POST', `/api/inventory/movements/${id}/repair`, { operationId: op(), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);
  });

  it('leaves CONTEXT_AHEAD to a stated adjustment rather than repairing it', async () => {
    await move(OPS_A.token, ROLLS, 4);
    // The workbook loses it — a hand edit, or a write overwritten by another server.
    await h.wb.reposFor(TENANT_A).inventory.updateByIdVerified(ROLLS, { Used: 0 });

    const rec = await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');
    expect(rec.body.find((r: any) => r.itemRef === ROLLS).status).toBe('CONTEXT_AHEAD');

    /*
     * There is deliberately no repair for this. We know a quantity is missing; we do not know
     * that re-adding it is right, because the workbook may have been corrected by hand. The
     * operator states an ADJUSTMENT instead — audited, reasoned, and honest about being a
     * correction rather than impersonating the lost movement.
     */
    const [row] = await h.invRepo.listMovements(ctx(TENANT_A));
    const res = await h.request(ADMIN_A.token,
      'POST', `/api/inventory/movements/${row!.id}/repair`, { operationId: op() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_APPLIED');
  });

  it('reading reconciliation still mutates neither store', async () => {
    await move(OPS_A.token, ROLLS, 4);
    const before = await itemRow(TENANT_A, ROLLS);
    const movementsBefore = (await h.invRepo.listMovements(ctx(TENANT_A))).length;

    for (let i = 0; i < 3; i += 1) {
      await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');
    }

    const after = await itemRow(TENANT_A, ROLLS);
    expect(after.used).toBe(before.used);
    expect(after.purchased).toBe(before.purchased);
    expect((await h.invRepo.listMovements(ctx(TENANT_A))).length).toBe(movementsBefore);
  });
});

/* ================================================================== *
 * 5 · TENANT ISOLATION, ADVERSARIALLY (PHASE F)
 * ================================================================== */

describe('isolation · a foreign identifier is never a key', () => {
  it('cannot repair, receive against, or transition anything of the other tenant’s', async () => {
    const { poId, lineId } = await aSentOrder(ROLLS, 6);

    const attacks: Array<[string, string, object]> = [
      ['POST', `/api/inventory/purchase-orders/${poId}/status`, { operationId: op(), status: 'CANCELLED' }],
      ['POST', '/api/inventory/goods-receipts', { operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 1 }] }],
    ];
    for (const [method, path, body] of attacks) {
      const res = await h.request(ADMIN_B.token, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await itemRow(TENANT_B, ROLLS)).purchased).toBe(0);
  });

  it('cannot attribute a delivery to a property it does not operate', async () => {
    /*
     * The one property-taking path in the domain that never asked whether the caller owned
     * the property it was handed. Nothing crossed a tenant boundary — receipts are
     * tenant-scoped — but a delivery could be attributed to another customer's unit, or to a
     * string that is not a property at all, and every screen reading receipts would show it.
     */
    const { poId, lineId } = await aSentOrder(ROLLS, 5);
    for (const propertyId of ['HYD-601', 'ZZZ-NOT-A-PROPERTY']) {
      const res = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
        operationId: op(), poId, propertyId,
        lines: [{ poLineId: lineId, receivedQuantity: 1 }],
      });
      expect(res.status, propertyId).toBe(404);
    }
    // A property the caller DOES operate is still accepted.
    const ok = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, propertyId: 'HYD-501',
      lines: [{ poLineId: lineId, receivedQuantity: 1 }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('cannot receive a line id belonging to another of its OWN orders', async () => {
    const first = await aSentOrder(ROLLS, 5);
    const second = await aSentOrder(TOWELS, 5);
    const crossed = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId: first.poId,
      lines: [{ poLineId: second.lineId, receivedQuantity: 5 }],
    });
    expect(crossed.status).toBe(404);
    expect((await itemRow(TENANT_A, TOWELS)).purchased).toBe(0);
  });

  it('cannot replay another tenant’s operation id', async () => {
    const operationId = op();
    const body = {
      operationId, itemRef: ROLLS, movementType: 'CONSUMPTION' as const, quantity: 2,
    };
    const mine = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', body);
    expect(mine.status).toBe(200);

    const theirs = await h.request(OPS_B.token, 'POST', '/api/inventory/movements', body);
    expect(theirs.status).toBe(409);
    expect(theirs.body.error.code).toBe('OPERATION_MISMATCH');
    // Never handed A's stored result, and B's own workbook untouched.
    expect(JSON.stringify(theirs.body)).not.toContain(mine.body.id);
    expect((await itemRow(TENANT_B, ROLLS)).used).toBe(0);
  });

  it('sees none of the other tenant’s procurement, movements or receipts', async () => {
    await aSentOrder(ROLLS, 5);
    await move(OPS_A.token, TOWELS, 1);

    expect((await h.request(ADMIN_B.token, 'GET', '/api/inventory/purchase-orders')).body)
      .toEqual([]);
    expect((await h.request(ADMIN_B.token, 'GET', '/api/inventory/requests')).body).toEqual([]);
    expect((await h.request(OPS_B.token, 'GET', '/api/inventory/movements')).body).toEqual([]);
    expect(await h.invRepo.listGoodsReceipts(ctx(TENANT_B))).toEqual([]);
  });

  it('refuses every inventory route without a token', async () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/inventory'))) {
      const path = route.path.replace(':id', 'PROBE');
      const res = await h.request(null, route.method, path, { operationId: op() });
      expect(res.status, `${route.method} ${path}`).toBe(401);
    }
  });
});

/* ================================================================== *
 * 6 · ROLE PROJECTION (PHASE G)
 * ================================================================== */

describe('projection · what a role may not be handed', () => {
  it('emits no actor, tenant or compensation field on any inventory payload', async () => {
    await move(OPS_A.token, ROLLS, 2);
    const { poId, lineId } = await aSentOrder(TOWELS, 3);
    await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 3 }],
    });

    for (const path of [
      '/api/inventory/stock', '/api/inventory/movements', '/api/inventory/reconciliation',
      '/api/inventory/assets', '/api/inventory/purchase-orders', '/api/inventory/requests',
    ]) {
      const res = await h.request(OPS_A.token, 'GET', path);
      expect(res.status, path).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body, `${path} leaks a withheld field`)
        .not.toMatch(/"(tenantId|employeeId|salary|grossPay|netPay|payroll|bankAccount|ifsc)"\s*:/);
    }
  });

  it('withholds money from OPERATIONS on every surface that carries it', async () => {
    const vendorId = await aVendor(ADMIN_A.token);
    const created = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
      operationId: op(), vendorId,
      lines: [{ itemRef: ROLLS, quantity: 4, expectedUnitPriceMinor: 9_900 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const asOps = (await h.request(OPS_A.token, 'GET', '/api/inventory/purchase-orders')).body[0];
    expect(asOps.pricesWithheld).toBe(true);
    expect(asOps.lines[0].expectedUnitPriceMinor).toBeNull();
    expect(JSON.stringify(asOps)).not.toContain('9900');

    const assets = (await h.request(OPS_A.token, 'GET', '/api/inventory/assets')).body;
    for (const a of assets) {
      expect(a.costWithheld).toBe(true);
      expect(a.purchaseCostMinor).toBeNull();
    }
  });

  it('an INVESTOR reaches nothing, readable or writable', async () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/inventory'))) {
      const path = route.path.replace(':id', 'PROBE');
      const res = await h.request(USERS.investorA!.token, route.method, path,
        { operationId: op() });
      expect(res.status, `${route.method} ${path}`).toBe(403);
    }
  });
});

/* ================================================================== *
 * 7 · WORKBOOK CONTRACT (PHASE H)
 * ================================================================== */

describe('workbook · the sheet stays the only stock ledger', () => {
  it('no overlay table carries anything that could be read as a balance', () => {
    const migration = read('supabase/migrations/0011_inventory_overlay.sql');
    const withoutProse = migration
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(withoutProse)
      .not.toMatch(/\b(current_stock|on_hand|balance|closing_stock|stock_level|qty_on_hand)\b/);
  });

  it('nothing in the domain computes a stock figure from movement rows', () => {
    const service = read('lib/server/inventory/service.ts');
    // The reconciliation comparison sums events on PURPOSE; what must not exist is a sum
    // presented as stock. `currentStock` may only ever be read from the workbook row.
    expect(service).toMatch(/currentStock:\s*row\.currentStock/);
    expect(service).not.toMatch(/currentStock\s*[:=]\s*[^r\n]*(openingStock|purchased\s*[-+])/);
  });

  it('models no accounting treatment anywhere in the domain', () => {
    const domain = [
      'lib/server/inventory/service.ts', 'lib/server/inventory/repository.ts',
      'lib/server/inventory/types.ts', 'lib/server/inventory/serialize.ts',
      'lib/server/api/inventory-handlers.ts',
    ].map(read).join('\n');
    for (const forbidden of [
      /\bdepreciat/i, /\bnet_?book/i, /\bfifo\b/i, /\bweighted[ _]?average/i, /\bcogs\b/i,
    ]) {
      const offending = domain.split('\n').filter((l) => forbidden.test(l)
        && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
      expect(offending, `${forbidden} appears as code`).toEqual([]);
    }
  });
});
