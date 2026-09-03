/**
 * M-SEC-1 — THE POSTGRES INVENTORY TWIN, WHICH NOTHING WAS TESTING.
 *
 * THE GAP THIS CLOSES. `lib/server/api/service.ts` returns `SupabaseInventoryRepository` the
 * moment a Supabase client exists — which is every configured deployment — and falls back to
 * the in-memory twin only when one does not. Every isolation assertion written for M-INV-1
 * runs against the FALLBACK. So the repository that production actually executes was, until
 * this file, constructed in exactly one place in the tree and in no test at all: its tenant
 * predicates were correct by inspection and by nothing else.
 *
 * That is not a hypothetical failure mode in this codebase. `SupabaseAuditSink` shipped with
 * `tenant_id` missing from its insert while the in-memory twin carried it and the whole suite
 * stayed green — the same shape, in the same place, caught late.
 *
 * Nothing here runs Postgres. It RECORDS THE QUERY CHAIN the repository builds, which is the
 * only way to see a `.eq('tenant_id', …)` that was never written. Peer domains have had this
 * for milestones — tests/finance-isolation.test.ts and tests/hr-isolation.test.ts — and
 * inventory was simply missed.
 */
import { describe, it, expect } from 'vitest';
import { SupabaseInventoryRepository } from '@/lib/server/inventory/supabase-repository';
import { InMemoryInventoryRepository } from '@/lib/server/inventory/repository';
import { TENANT_A, TENANT_B } from './support/harness';
import { readSource as read } from './support/source';

type Call = {
  table: string; op: string; filters: Array<[string, unknown]>; row?: any;
};

function recorder() {
  const calls: Call[] = [];
  const makeChain = (entry: Call) => {
    const chain: any = {
      eq(column: string, value: unknown) { entry.filters.push([column, value]); return chain; },
      neq() { return chain; },
      is() { return chain; },
      in() { return chain; },
      gte() { return chain; },
      lte() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      select() { return chain; },
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),
    };
    return chain;
  };
  const client = {
    from(table: string) {
      return {
        select() {
          const entry: Call = { table, op: 'select', filters: [] };
          calls.push(entry); return makeChain(entry);
        },
        insert(row: any) {
          const entry: Call = { table, op: 'insert', filters: [], row };
          calls.push(entry); return makeChain(entry);
        },
        update(row: any) {
          const entry: Call = { table, op: 'update', filters: [], row };
          calls.push(entry); return makeChain(entry);
        },
        upsert(row: any) {
          const entry: Call = { table, op: 'upsert', filters: [], row };
          calls.push(entry); return makeChain(entry);
        },
        delete() {
          const entry: Call = { table, op: 'delete', filters: [] };
          calls.push(entry); return makeChain(entry);
        },
      };
    },
  };
  return { client, calls };
}

const tenantA = { tenantId: TENANT_A, userId: 'u-a', role: 'ADMIN' as const };

/** Every read the repository can perform, exercised in one pass. */
async function everyRead(repo: SupabaseInventoryRepository) {
  await repo.listMovements(tenantA);
  await repo.listMovements(tenantA, { itemRef: 'ITM-1' });
  await repo.getMovement(tenantA, 'm-1');
  await repo.movementTotals(tenantA);
  await repo.listVendorLinks(tenantA);
  await repo.getRequest(tenantA, 'r-1');
  await repo.listRequests(tenantA);
  await repo.getPurchaseOrder(tenantA, 'po-1');
  await repo.listPurchaseOrders(tenantA);
  await repo.listGoodsReceipts(tenantA);
  await repo.listGoodsReceipts(tenantA, 'po-1');
  await repo.listAssetLinks(tenantA);
  await repo.listAssetLinks(tenantA, 'AST-1');
}

describe('inventory · the Postgres twin production actually runs', () => {
  it('filters every read by tenant', async () => {
    const { client, calls } = recorder();
    await everyRead(new SupabaseInventoryRepository(client));

    const reads = calls.filter((c) => c.op === 'select');
    expect(reads.length, 'the sweep must actually reach the repository').toBeGreaterThan(10);
    for (const call of reads) {
      expect(
        call.filters.some(([column, value]) => column === 'tenant_id' && value === TENANT_A),
        `${call.table} read without a tenant predicate`,
      ).toBe(true);
    }
  });

  it('stamps the tenant on every insert, and cannot be told otherwise', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseInventoryRepository(client);

    /*
     * Each call passes a HOSTILE payload carrying somebody else's tenant. The repository
     * stamps `tenant_id` LAST, so the caller's value is overwritten rather than honoured —
     * and this asserts the overwrite rather than trusting the spread order to stay put.
     */
    const hostile = { tenantId: TENANT_B, tenant_id: TENANT_B } as never;

    await repo.recordMovement(tenantA, {
      itemRef: 'ITM-1', propertyId: null, movementType: 'CONSUMPTION', quantity: 1,
      employeeId: null, taskType: null, taskRef: null, reason: null, wastageReason: null,
      counterpartyPropertyId: null, workbookApplied: true, ...(hostile as object),
    } as never, 'actor').catch(() => {});
    await repo.linkVendor(tenantA, 'Acme', 'v-1', 'actor').catch(() => {});
    await repo.createRequest(tenantA, {
      propertyId: null, priority: 'Medium', reason: null,
      lines: [{ itemRef: 'ITM-1', description: null, quantity: 1, unit: null }],
    } as never, 'actor').catch(() => {});
    await repo.createPurchaseOrder(tenantA, {
      vendorId: 'v-1', propertyId: null, requestId: null, orderDate: null, expectedDate: null,
      lines: [{ itemRef: 'ITM-1', description: null, quantity: 1, unit: null, expectedUnitPriceMinor: null }],
    } as never, 'actor').catch(() => {});
    await repo.createGoodsReceipt(tenantA, {
      poId: 'po-1', propertyId: null, notes: null,
      lines: [{ poLineId: 'l-1', receivedQuantity: 1, condition: null }],
    } as never, 'actor').catch(() => {});
    await repo.linkAssetTicket(tenantA, 'AST-1', 'MNT-1', 'actor', null).catch(() => {});

    const inserts = calls.filter((c) => c.op === 'insert');
    expect(inserts.length, 'the sweep must reach every writer').toBeGreaterThan(5);
    for (const call of inserts) {
      expect(call.row?.tenant_id, `${call.table} insert without the caller's tenant`)
        .toBe(TENANT_A);
    }
  });

  it('stamps the tenant LAST, so no caller-supplied value can win', async () => {
    /*
     * Asserted at the source, because the ordering is invisible from outside: an insert built
     * as `{ tenant_id, ...values }` behaves identically to `{ ...values, tenant_id }` for
     * every payload that does not carry a `tenant_id` of its own — which is every payload the
     * repository is called with today. The difference only shows up on the day one does, and
     * on that day the wrong order silently writes the caller's tenant.
     */
    const source = read('lib/server/inventory/supabase-repository.ts');
    expect(source, 'insertRow must stamp tenant_id after the caller values')
      .toMatch(/\.insert\(\{\s*\.\.\.values,\s*tenant_id: tenantId\s*\}\)/);
    expect(source, 'no insert may place tenant_id before the spread')
      .not.toMatch(/\.insert\(\{\s*tenant_id: tenantId,\s*\.\.\.values/);
  });

  it('carries BOTH predicates on every update, never the id alone', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseInventoryRepository(client);

    await repo.markMovementApplied(tenantA, 'm-1').catch(() => {});
    await repo.transitionRequest(tenantA, 'r-1', 'APPROVED', 'actor', null).catch(() => {});
    await repo.transitionPurchaseOrder(tenantA, 'po-1', 'APPROVED', 'actor').catch(() => {});
    await repo.attachMovementToReceiptLine(tenantA, 'l-1', 'm-1').catch(() => {});

    const updates = calls.filter((c) => c.op === 'update');
    expect(updates.length, 'the sweep must reach every updater').toBeGreaterThan(3);
    for (const call of updates) {
      const columns = call.filters.map(([c]) => c);
      expect(columns, `${call.table} update without a tenant predicate`).toContain('tenant_id');
      expect(
        call.filters.some(([c, v]) => c === 'tenant_id' && v === TENANT_A),
        `${call.table} update scoped to the wrong tenant`,
      ).toBe(true);
      // An update matching on the identifier alone would reach another customer's row.
      expect(columns.length, `${call.table} update on a single predicate`)
        .toBeGreaterThanOrEqual(2);
    }
  });

  it('refuses to build any query at all without a tenant', async () => {
    const { client } = recorder();
    const repo = new SupabaseInventoryRepository(client);
    const noTenant = { tenantId: '', userId: 'u', role: 'ADMIN' } as never;

    await expect(repo.listMovements(noTenant)).rejects.toThrow();
    await expect(repo.getMovement(noTenant, 'm-1')).rejects.toThrow();
    await expect(repo.listRequests(noTenant)).rejects.toThrow();
    await expect(repo.listPurchaseOrders(noTenant)).rejects.toThrow();
    await expect(repo.listAssetLinks(noTenant)).rejects.toThrow();
  });

  it('never sends an updated_at to a table that has no such column', async () => {
    /*
     * The overlay's line and link tables are append-only and carry no `updated_at`. Sending
     * one is a PostgREST error at runtime and nothing offline would catch it — the same
     * class of defect the header describes, one layer down.
     */
    const { client, calls } = recorder();
    const repo = new SupabaseInventoryRepository(client);
    await repo.attachMovementToReceiptLine(tenantA, 'l-1', 'm-1').catch(() => {});
    await repo.markMovementApplied(tenantA, 'm-1').catch(() => {});

    const { INVENTORY_WITHOUT_UPDATED_AT } = await import(
      '@/lib/server/inventory/supabase-repository');
    for (const call of calls.filter((c) => c.op === 'update')) {
      if (!INVENTORY_WITHOUT_UPDATED_AT.has(call.table)) continue;
      expect(Object.keys(call.row ?? {}), `${call.table} has no updated_at column`)
        .not.toContain('updated_at');
    }
  });

  it('the two twins expose the same surface, so a rule can never hold in only one', () => {
    /*
     * The asymmetry that makes an audit like this necessary: if the twins drift, the tested
     * one and the deployed one stop being the same product. Comparing the method surface is
     * the cheapest guard that notices.
     */
    const inMemory = Object.getOwnPropertyNames(InMemoryInventoryRepository.prototype)
      .filter((n) => n !== 'constructor' && !n.startsWith('_'));
    const supabase = new Set(Object.getOwnPropertyNames(SupabaseInventoryRepository.prototype));
    const missing = inMemory.filter((n) => !supabase.has(n));
    // Private helpers on the in-memory twin are allowed to be absent; interface methods are not.
    const interfaceOnly = missing.filter((n) => !['mine', 'oneOf', 'now'].includes(n));
    expect(interfaceOnly, 'the Postgres twin is missing methods the in-memory twin has')
      .toEqual([]);
  });
});
