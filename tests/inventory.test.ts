/**
 * M-INV-1 — INVENTORY, PROCUREMENT AND ASSETS, ACROSS TWO TENANTS.
 *
 * THE ONE THING THIS SUITE EXISTS TO PROVE: there is still exactly ONE stock ledger.
 *
 * `15_INVENTORY` owns how much exists. This overlay owns why it moved. Every case below is
 * written so that a future change which starts recomputing a balance here — or which writes
 * the sheet by a second path — fails rather than passes quietly. That failure mode is the
 * expensive one: two systems that each believe they hold the stock figure produce a business
 * that cannot answer how many towels it owns.
 *
 * The harness mirrors production exactly where it matters:
 *
 *   the workbooks are SEPARATE     one in-memory sheets client per tenant, as production
 *                                  gives each customer their own spreadsheet
 *   the Postgres stores are ONE    a single InMemoryInventoryRepository, HR repository and
 *                                  finance repository shared by both tenants, so ONLY the
 *                                  tenant predicate separates them
 *
 * A harness that gave each tenant its own overlay would pass every isolation case here while
 * proving nothing — the workbook half would carry the whole result.
 *
 * The attacker: a fully-authenticated OPERATIONS supervisor in TENANT_A reaching for
 * TENANT_B — by naming their item, their employee, their property, their vendor, their
 * purchase order or their asset.
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
  InventoryService, statusOf,
  type WorkbookStockRow, type WorkbookAssetRow,
} from '@/lib/server/inventory/service';
import { MOVEMENT_TYPES, WASTAGE_REASONS } from '@/lib/server/inventory/types';
import { capabilitiesFor, roleHasCapability, FINANCIAL_CAPABILITIES } from '@/lib/shared/roles';
import type { TestUser } from '@/lib/server/auth/session';
import { TENANT_A, TENANT_B, USERS } from './support/harness';
import { createWriteHarness } from './support/write-harness';
import { readSource as read } from './support/source';

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const ADMIN_A: TestUser = {
  userId: 'u-adm-a', email: 'adm.a@example.test', role: 'ADMIN',
  tenantId: TENANT_A, token: 'tok-adm-a',
};
/* A SECOND administrator in the same tenant. Separation of duty is unprovable with one. */
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

/*
 * Each tenant's own property list. Both workbooks are copies of the same demo grid — two
 * customers may perfectly well number a unit HYD-501 — so isolation comes from the two
 * workbook INSTANCES and the tenant predicate, never from identifiers happening to differ.
 * The lists are disjoint so a cross-property attempt is expressible at all.
 */
const PROPERTIES: Record<string, string[]> = {
  [TENANT_A]: ['HYD-501', 'HYD-502'],
  [TENANT_B]: ['HYD-601'],
};

/** Demo workbook items, identical in both tenants' grids. */
const ROLLS = 'ITM-D-001';   // Toilet rolls   46 / min 24 — comfortably in stock
const TOWELS = 'ITM-D-002';  // Bath towels     4 / min 12 — below its own reorder level
const AC_ASSET = 'AST-D-0001';   // HYD-501, warranty well ahead
const TENANT_B_ASSET = 'AST-D-0002'; // HYD-601 — in A's grid too, but not A's property

const op = () => randomUUID();

/**
 * A tenant context for reading the shared overlay DIRECTLY, to check what the projection
 * chose not to emit. Every repository method demands one, so a test cannot accidentally read
 * across tenants either.
 */
const ctx = (tenantId: string) =>
  ({ tenantId, userId: 'test-reader', role: 'ADMIN' }) as never;

interface SheetFailure { fail: boolean }

function harness() {
  // Separate workbooks, exactly as production gives each tenant its own.
  const wb = createWriteHarness({}, {
    tenants: [TENANT_A, TENANT_B],
    users: [...Object.values(USERS), ADMIN_A, ADMIN2_A, OPS_A, ADMIN_B, OPS_B],
  });

  // ONE relational store of each kind, for both tenants. Only the predicate separates them.
  const invRepo = new InMemoryInventoryRepository();
  const hrRepo = new InMemoryHrRepository();
  const financeRepo = new InMemoryFinanceRepository();
  const sheet: SheetFailure = { fail: false };

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

  /** The caller's OWN workbook rows — the reason a foreign ItemID is a miss, not a refusal. */
  const stockRows = async (tenant: { tenantId: string }): Promise<readonly WorkbookStockRow[]> =>
    (await wb.reposFor(tenant.tenantId as never).inventory.readAll()).map((i) => ({
      itemRef: i.itemId,
      propertyId: i.propertyId || null,
      category: i.category,
      name: i.item,
      unit: i.unit,
      openingStock: i.openingStock,
      purchased: i.purchased,
      used: i.used,
      currentStock: i.currentStock,
      minStock: i.minStock,
      vendorName: i.vendor || null,
    }));

  const assetRows = async (tenant: { tenantId: string }): Promise<readonly WorkbookAssetRow[]> =>
    (await wb.reposFor(tenant.tenantId as never).assets.readAll()).map((a) => ({
      assetRef: a.assetId,
      propertyId: a.propertyId || null,
      category: a.category,
      name: a.asset,
      purchaseDate: a.purchaseDate || null,
      purchaseCostMinor: Number.isFinite(a.purchaseCost) ? Math.round(a.purchaseCost * 100) : null,
      vendorName: a.vendor || null,
      warrantyExpiry: a.warrantyExpiry,
      warrantyLabel: a.warrantyStatus,
      condition: a.condition,
      status: a.currentStatus,
      disposalDate: a.disposalDate,
    }));

  const service = new InventoryService({
    repo: invRepo,
    hr: hrService,
    stockRows: stockRows as never,
    assetRows: assetRows as never,
    propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
    vendor: (tenant, vendorId) => financeRepo.getVendor(tenant, vendorId),
    // THE REAL PIPELINE, per tenant, exactly as the composition root wires it.
    writeTotals: async (write, itemRef, totals) => {
      if (sheet.fail) {
        throw new MutationError(502, 'SHEETS_UNAVAILABLE', 'The workbook did not answer.');
      }
      await executeMutation(MUTATION_DEFINITIONS['inventory.update']!, {
        auth: write.auth,
        request: {
          method: 'PATCH', path: `/api/inventory/${itemRef}`,
          headers: {}, query: {}, params: { id: itemRef },
          body: { operationId: op(), ...totals },
          requestId: write.requestId,
        },
      } as never, wb.deps);
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

  return {
    wb, invRepo, hrRepo, financeRepo, service, sheet,
    request: wb.requestAs.bind(wb),
  };
}

type Harness = ReturnType<typeof harness>;
let h: Harness;
beforeEach(() => { h = harness(); vendorSeq = 0; });

/* ---- fixtures expressed through the real routes, never through a repository ---- */

let vendorSeq = 0;
async function aVendor(token: string, displayName?: string) {
  // Unique by default: finance refuses a duplicate display name, which is right and not
  // what any of these cases is about.
  displayName = displayName ?? `Demo Supplies ${(vendorSeq += 1)}`;
  const res = await h.request(token, 'POST', '/api/finance/vendors', {
    operationId: op(), displayName,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.id);
}

async function anEmployee(token: string, fullName = 'Lakshmi Narayan') {
  const res = await h.request(token, 'POST', '/api/hr/employees', {
    operationId: op(), fullName, joiningDate: '2020-01-01',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.id);
}

async function itemRow(tenantId: string, itemRef: string) {
  const rows = await h.wb.reposFor(tenantId as never).inventory.readAll();
  return rows.find((i) => i.itemId === itemRef)!;
}

/** Consume stock as an operations supervisor would after a turnover. */
async function consume(token: string, itemRef: string, quantity: number, extra: object = {}) {
  return h.request(token, 'POST', '/api/inventory/movements', {
    operationId: op(), itemRef, movementType: 'CONSUMPTION', quantity, ...extra,
  });
}

/** A request, approved by somebody else, ordered, sent — the state a receipt needs. */
async function aSentOrder(itemRef: string, quantity: number, unitPrice: number | null = 12_500) {
  const vendorId = await aVendor(ADMIN_A.token);
  const created = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
    operationId: op(), vendorId,
    lines: [{
      itemRef, quantity,
      ...(unitPrice === null ? {} : { expectedUnitPriceMinor: unitPrice }),
    }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const poId = String(created.body.id);

  for (const status of ['SUBMITTED', 'APPROVED', 'SENT'] as const) {
    const moved = await h.request(
      // APPROVED must come from somebody other than the raiser.
      status === 'APPROVED' ? ADMIN2_A.token : ADMIN_A.token,
      'POST', `/api/inventory/purchase-orders/${poId}/status`,
      { operationId: op(), status },
    );
    expect(moved.status, `${status}: ${JSON.stringify(moved.body)}`).toBe(200);
  }
  const list = await h.request(ADMIN_A.token, 'GET', '/api/inventory/purchase-orders');
  const po = list.body.find((p: any) => p.id === poId);
  return { poId, vendorId, lineId: String(po.lines[0].id) };
}

/* ================================================================== *
 * 1 · ONE LEDGER — the rule the whole milestone rests on
 * ================================================================== */

describe('inventory · one stock ledger', () => {
  it('reads the workbook’s own CurrentStock and never recomputes it', async () => {
    const res = await h.request(OPS_A.token, 'GET', '/api/inventory/stock');
    expect(res.status).toBe(200);

    const rolls = res.body.find((i: any) => i.itemRef === ROLLS);
    const sheetRow = await itemRow(TENANT_A, ROLLS);
    // Byte for byte the sheet's figure — not opening + purchased − used computed here.
    expect(rolls.currentStock).toBe(sheetRow.currentStock);
    expect(rolls.minStock).toBe(sheetRow.minStock);
  });

  it('derives status from the sheet’s two numbers, and surfaces a negative rather than hiding it', () => {
    expect(statusOf(46, 24)).toBe('IN_STOCK');
    expect(statusOf(4, 12)).toBe('LOW_STOCK');
    expect(statusOf(12, 12)).toBe('LOW_STOCK');   // at the reorder level IS low
    expect(statusOf(0, 12)).toBe('OUT_OF_STOCK');
    // A spreadsheet can hold a negative balance. Clamping it to zero would hide a real
    // counting problem behind a tidy number.
    expect(statusOf(-3, 12)).toBe('NEGATIVE');
    expect(statusOf(null, 12)).toBe('UNAVAILABLE');
  });

  it('moves the workbook through the existing verified mutation, not a second write path', async () => {
    const before = await itemRow(TENANT_A, ROLLS);
    expect(before.used).toBe(0);

    const res = await consume(OPS_A.token, ROLLS, 2, { taskType: 'HOUSEKEEPING', taskRef: 'HK-1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await itemRow(TENANT_A, ROLLS);
    expect(after.used).toBe(2);
    // The mutation pipeline ran: its own audit record is present, alongside the movement's.
    expect(h.wb.audit.byAction('inventory.update.applied').length).toBe(1);
    expect(h.wb.audit.byAction('inventory.movement.record.applied').length).toBe(1);
  });

  it('adds to the sheet’s running total rather than making the caller retype it', async () => {
    await consume(OPS_A.token, ROLLS, 2);
    await consume(OPS_A.token, ROLLS, 3);
    // 0 → 2 → 5. Before this milestone the caller sent an absolute figure they had never
    // been shown, and getting it wrong made stock fall after a purchase.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(5);
  });

  it('never writes a calculated column — the contract refuses CurrentStock outright', async () => {
    const res = await h.request(ADMIN_A.token, 'PATCH', `/api/inventory/${ROLLS}`, {
      operationId: op(), currentStock: 999,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await itemRow(TENANT_A, ROLLS)).currentStock).toBe(46);
  });

  it('holds no balance of its own — the overlay stores events, and totals are sums of them', async () => {
    await consume(OPS_A.token, ROLLS, 2);
    await consume(OPS_A.token, ROLLS, 3);

    const totals = await h.invRepo.movementTotals(ctx(TENANT_A));
    expect(totals.get(ROLLS)).toEqual({ purchased: 0, used: 5, unapplied: 0 });

    /*
     * The source itself, because a comment is not a guarantee. If a `currentStock` or
     * `balance` column ever appears in the movement row, this fails — which is the moment
     * a second ledger would have been born.
     */
    const migration = read('supabase/migrations/0011_inventory_overlay.sql');
    const movementTable = migration.slice(
      migration.indexOf('create table if not exists inv_movements'),
      migration.indexOf('create index if not exists inv_movements'),
    );
    /*
     * Commentary stripped first: the prose says the word "balance" precisely in order to
     * forbid it, and a scan that failed on its own explanation would teach the next author
     * to delete the explanation rather than keep the rule.
     */
    const columns = movementTable
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(columns).not.toMatch(/\b(current_stock|balance|on_hand|closing_stock)\b/);
  });

  it('models no depreciation, valuation, COGS or automatic expense anywhere in the domain', () => {
    /*
     * `projections.ts` is scanned separately below. It NAMES these fields on purpose, in the
     * compile-time guard that refuses to build if one ever appears in a payload — and a scan
     * that failed on the safeguard would teach the next author to delete the safeguard.
     */
    const domain = [
      'lib/server/inventory/service.ts',
      'lib/server/inventory/repository.ts',
      'lib/server/inventory/types.ts',
      'lib/server/api/inventory-handlers.ts',
    ].map(read).join('\n');

    // Named in prose above; absent as code. `depreciat` catches every inflection.
    for (const forbidden of [
      /\bdepreciat/i, /\bnet_?book/i, /\bfifo\b/i, /\bweighted[ _]?average/i,
      /\bcogs\b/i, /\bcost[ _]?of[ _]?goods/i,
    ]) {
      const offending = domain.split('\n')
        .filter((l) => forbidden.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
      expect(offending, `${forbidden} appears as code`).toEqual([]);
    }
    /*
     * In projections the words are present ON PURPOSE, in the compile-time guard that
     * refuses to build if one of them ever reaches a payload. Assert the safeguard EXISTS
     * rather than that the words are absent — a scan that punished the guard would teach
     * the next author to delete it.
     */
    const projections = read('lib/server/inventory/projections.ts');
    const guard = projections.slice(projections.indexOf('type Withheld ='));
    for (const field of ['valuation', 'bookValue', 'depreciation', 'purchaseCost']) {
      expect(guard, field).toContain(`'${field}'`);
    }

    // Receiving goods creates no bill and no expense: money owed is finance's claim.
    const service = read('lib/server/inventory/service.ts');
    expect(service).not.toMatch(/createBill|recordExpense|createExpense/);
  });
});

/* ================================================================== *
 * 2 · THE SECURITY MATRIX (§52)
 * ================================================================== */

describe('inventory · isolation between tenants', () => {
  it('cannot move stock using another tenant’s employee', async () => {
    const employeeB = await anEmployee(ADMIN_B.token, 'Imran Qureshi');

    const res = await consume(OPS_A.token, ROLLS, 1, { employeeId: employeeB });
    expect(res.status).toBe(404);
    // "No such employee", never "not yours" — the refusal must not confirm the id is real.
    expect(String(res.body.error.message)).toMatch(/employee/i);
    expect(await h.invRepo.listMovements(ctx(TENANT_A))).toHaveLength(0);
  });

  it('cannot move stock into another tenant’s property', async () => {
    const res = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', {
      operationId: op(), itemRef: ROLLS, movementType: 'TRANSFER_OUT', quantity: 1,
      counterpartyPropertyId: 'HYD-601',
    });
    expect(res.status).toBe(404);
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);
  });

  it('cannot raise an order against another tenant’s vendor', async () => {
    const vendorB = await aVendor(ADMIN_B.token, 'Their Supplier');

    const res = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
      operationId: op(), vendorId: vendorB, lines: [{ itemRef: ROLLS, quantity: 10 }],
    });
    expect(res.status).toBe(404);
    expect(String(res.body.error.message)).toMatch(/vendor/i);
  });

  it('cannot link a workbook vendor name to another tenant’s vendor', async () => {
    const vendorB = await aVendor(ADMIN_B.token, 'Their Supplier');
    const res = await h.request(ADMIN_A.token, 'POST', '/api/inventory/vendor-links', {
      operationId: op(), vendorName: 'Demo Supplies', vendorId: vendorB,
    });
    expect(res.status).toBe(404);
    expect(await h.invRepo.listVendorLinks(ctx(TENANT_A))).toHaveLength(0);
  });

  it('cannot see, decide or receive against another tenant’s procurement', async () => {
    const { poId, lineId } = await aSentOrder(ROLLS, 10);

    const theirs = await h.request(ADMIN_B.token, 'GET', '/api/inventory/purchase-orders');
    expect(theirs.body).toEqual([]);

    const transition = await h.request(
      ADMIN_B.token, 'POST', `/api/inventory/purchase-orders/${poId}/status`,
      { operationId: op(), status: 'CANCELLED' },
    );
    expect(transition.status).toBe(404);

    const receipt = await h.request(ADMIN_B.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 10 }],
    });
    expect(receipt.status).toBe(404);
    // And B's own workbook is untouched by A's order.
    expect((await itemRow(TENANT_B, ROLLS)).purchased).toBe(0);
  });

  it('cannot read another tenant’s movements even for an item id it also has', async () => {
    await consume(OPS_A.token, ROLLS, 4);

    const mine = await h.request(OPS_A.token, 'GET', `/api/inventory/movements?item=${ROLLS}`);
    expect(mine.body).toHaveLength(1);

    // The SAME item id exists in B's workbook. The predicate, not the identifier, separates.
    const theirs = await h.request(OPS_B.token, 'GET', `/api/inventory/movements?item=${ROLLS}`);
    expect(theirs.body).toEqual([]);
  });

  it('cannot filter assets by a property it does not own', async () => {
    const ok = await h.request(OPS_A.token, 'GET', '/api/inventory/assets?property=HYD-501');
    expect(ok.status).toBe(200);
    expect(ok.body.map((a: any) => a.assetRef)).toContain(AC_ASSET);

    const no = await h.request(OPS_A.token, 'GET', '/api/inventory/assets?property=HYD-601');
    expect(no.status).toBe(404);
  });

  it('a movement recorded by one tenant never appears in the other’s reconciliation', async () => {
    await consume(OPS_A.token, ROLLS, 6);

    const a = (await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation'))
      .body.find((r: any) => r.itemRef === ROLLS);
    expect(a.contextUsed).toBe(6);
    expect(a.workbookUsed).toBe(6);

    const b = (await h.request(ADMIN_B.token, 'GET', '/api/inventory/reconciliation'))
      .body.find((r: any) => r.itemRef === ROLLS);
    expect(b.contextUsed).toBe(0);
    expect(b.workbookUsed).toBe(0);
  });

  it('refuses every inventory route without a token', async () => {
    for (const [method, path] of [
      ['GET', '/api/inventory/stock'], ['GET', '/api/inventory/movements'],
      ['GET', '/api/inventory/reconciliation'], ['GET', '/api/inventory/requests'],
      ['GET', '/api/inventory/purchase-orders'], ['GET', '/api/inventory/assets'],
      ['POST', '/api/inventory/movements'], ['POST', '/api/inventory/requests'],
      ['POST', '/api/inventory/purchase-orders'], ['POST', '/api/inventory/goods-receipts'],
      ['POST', '/api/inventory/vendor-links'],
    ] as const) {
      const res = await h.request(null, method, path, { operationId: op() });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('inventory · what each role may do', () => {
  it('OPERATIONS records why stock moved but may not correct the count', async () => {
    expect(roleHasCapability('OPERATIONS', 'inventory.movement')).toBe(true);
    expect(roleHasCapability('OPERATIONS', 'inventory.adjust')).toBe(false);

    const ok = await consume(OPS_A.token, ROLLS, 2);
    expect(ok.status).toBe(200);

    const adjust = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', {
      operationId: op(), itemRef: ROLLS, movementType: 'ADJUSTMENT', quantity: 5,
      adjusts: 'USED', reason: 'Stock count came up short',
    });
    expect(adjust.status).toBe(403);
    expect(adjust.body.error.code).toBe('ADJUSTMENT_NOT_PERMITTED');
    // The refusal changed nothing: still just the consumption.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(2);
  });

  it('ADMIN may correct the count, and the correction has to say which way and why', async () => {
    const missing = await h.request(ADMIN_A.token, 'POST', '/api/inventory/movements', {
      operationId: op(), itemRef: ROLLS, movementType: 'ADJUSTMENT', quantity: 5,
      adjusts: 'USED',
    });
    expect(missing.body.error.code).toBe('ADJUSTMENT_REASON_REQUIRED');

    const directionless = await h.request(ADMIN_A.token, 'POST', '/api/inventory/movements', {
      operationId: op(), itemRef: ROLLS, movementType: 'ADJUSTMENT', quantity: 5,
      reason: 'Annual count',
    });
    expect(directionless.body.error.code).toBe('ADJUSTMENT_DIRECTION_REQUIRED');

    const done = await h.request(ADMIN_A.token, 'POST', '/api/inventory/movements', {
      operationId: op(), itemRef: ROLLS, movementType: 'ADJUSTMENT', quantity: 5,
      adjusts: 'USED', reason: 'Annual count',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // The direction is legible in the record itself, without a second column.
    expect(done.body.reason).toBe('[-] Annual count');
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(5);
  });

  it('OPERATIONS may ask for stock but never approve the asking', async () => {
    expect(roleHasCapability('OPERATIONS', 'procurement.request')).toBe(true);
    expect(roleHasCapability('OPERATIONS', 'procurement.approve')).toBe(false);

    const created = await h.request(OPS_A.token, 'POST', '/api/inventory/requests', {
      operationId: op(), lines: [{ itemRef: TOWELS, quantity: 24 }], reason: 'Below par',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const approve = await h.request(
      OPS_A.token, 'POST', `/api/inventory/requests/${created.body.id}/decision`,
      { operationId: op(), status: 'APPROVED' },
    );
    expect(approve.status).toBe(403);
  });

  it('OPERATIONS holds no financial capability — procurement approval included', () => {
    for (const capability of FINANCIAL_CAPABILITIES) {
      expect(capabilitiesFor('OPERATIONS'), capability).not.toContain(capability);
      expect(capabilitiesFor('INVESTOR'), capability).not.toContain(capability);
    }
    expect(FINANCIAL_CAPABILITIES).toContain('procurement.approve');
  });

  it('an INVESTOR reaches no part of the inventory domain', async () => {
    for (const path of [
      '/api/inventory/stock', '/api/inventory/movements', '/api/inventory/reconciliation',
      '/api/inventory/requests', '/api/inventory/purchase-orders', '/api/inventory/assets',
    ]) {
      const res = await h.request(USERS.investorA!.token, 'GET', path);
      expect(res.status, path).toBe(403);
    }
  });

  it('withholds prices from a caller with no financial entitlement, and says it withheld them', async () => {
    const { poId } = await aSentOrder(ROLLS, 10, 12_500);

    const asAdmin = (await h.request(ADMIN_A.token, 'GET', '/api/inventory/purchase-orders'))
      .body.find((p: any) => p.id === poId);
    expect(asAdmin.lines[0].expectedUnitPriceMinor).toBe(12_500);
    expect(asAdmin.pricesWithheld).toBe(false);

    const asOps = (await h.request(OPS_A.token, 'GET', '/api/inventory/purchase-orders'))
      .body.find((p: any) => p.id === poId);
    // Not zero and not absent: null WITH a flag, so a screen can say "not shown to you"
    // rather than "nothing was agreed". Those are very different sentences.
    expect(asOps.lines[0].expectedUnitPriceMinor).toBeNull();
    expect(asOps.pricesWithheld).toBe(true);
    // Everything needed to receive a delivery is still there.
    expect(asOps.lines[0].quantity).toBe(10);
    expect(asOps.status).toBe('SENT');
  });

  it('withholds an asset’s purchase cost the same way', async () => {
    const asAdmin = (await h.request(ADMIN_A.token, 'GET', '/api/inventory/assets'))
      .body.find((a: any) => a.assetRef === AC_ASSET);
    expect(asAdmin.purchaseCostMinor).toBe(4_200_000);  // ₹42,000 in paise
    expect(asAdmin.costWithheld).toBe(false);

    const asOps = (await h.request(OPS_A.token, 'GET', '/api/inventory/assets'))
      .body.find((a: any) => a.assetRef === AC_ASSET);
    expect(asOps.purchaseCostMinor).toBeNull();
    expect(asOps.costWithheld).toBe(true);
  });

  it('never leaks who moved what onto a stock or movement list', async () => {
    const employee = await anEmployee(ADMIN_A.token);
    await consume(OPS_A.token, ROLLS, 2, { employeeId: employee });

    const movements = await h.request(ADMIN_A.token, 'GET', '/api/inventory/movements');
    const body = JSON.stringify(movements.body);
    // A trail of who used two towels is a staff-movement record, and a stock list is not
    // where it belongs. The overlay HOLDS it; the projection does not emit it.
    expect(body).not.toContain(employee);
    expect(movements.body[0]).not.toHaveProperty('employeeId');
    expect(movements.body[0]).not.toHaveProperty('createdBy');
    expect((await h.invRepo.listMovements(ctx(TENANT_A)))[0]!.employeeId)
      .toBe(employee);
  });
});

/* ================================================================== *
 * 3 · WORKBOOK CONSISTENCY (§53)
 * ================================================================== */

describe('inventory · the workbook and the overlay', () => {
  it('writes the sheet FIRST, so a failure leaves stock right and context missing', async () => {
    h.sheet.fail = true;

    const res = await consume(OPS_A.token, ROLLS, 3);
    expect(res.status).toBe(502);
    // Nothing anywhere claims the stock changed.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);

    // The ATTEMPT is recorded, marked unapplied, so it is visible and repairable rather
    // than lost. An overlay-first design would have left this database asserting a
    // movement the workbook never saw.
    const rows = await h.invRepo.listMovements(ctx(TENANT_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workbookApplied).toBe(false);
    expect(rows[0]!.quantity).toBe(3);
  });

  it('every movement type points the right column, and only ADJUSTMENT may choose', async () => {
    const employee = await anEmployee(ADMIN_A.token);
    const cases: Array<[typeof MOVEMENT_TYPES[number], object, 'purchased' | 'used']> = [
      ['PURCHASE', {}, 'purchased'],
      ['TRANSFER_IN', { counterpartyPropertyId: 'HYD-502' }, 'purchased'],
      ['CONSUMPTION', { employeeId: employee }, 'used'],
      ['TRANSFER_OUT', { counterpartyPropertyId: 'HYD-502' }, 'used'],
      ['WASTAGE', { wastageReason: WASTAGE_REASONS[0] }, 'used'],
      ['RETURN', {}, 'used'],
    ];

    for (const [movementType, extra, column] of cases) {
      const before = await itemRow(TENANT_A, ROLLS);
      const res = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', {
        operationId: op(), itemRef: ROLLS, movementType, quantity: 1, ...extra,
      });
      expect(res.status, `${movementType}: ${JSON.stringify(res.body)}`).toBe(200);

      const after = await itemRow(TENANT_A, ROLLS);
      expect(after[column], movementType).toBe((before[column] ?? 0) + 1);
      const other = column === 'purchased' ? 'used' : 'purchased';
      expect(after[other], movementType).toBe(before[other]);
    }
  });

  it('wastage has to say what happened to it, and a transfer has to name the other end', async () => {
    const wastage = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', {
      operationId: op(), itemRef: ROLLS, movementType: 'WASTAGE', quantity: 2,
    });
    expect(wastage.body.error.code).toBe('WASTAGE_REASON_REQUIRED');

    const transfer = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', {
      operationId: op(), itemRef: ROLLS, movementType: 'TRANSFER_OUT', quantity: 2,
    });
    expect(transfer.body.error.code).toBe('TRANSFER_COUNTERPARTY_REQUIRED');

    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);
  });

  it('refuses a quantity of zero or below — direction is the movement type', async () => {
    for (const quantity of [0, -5]) {
      const res = await consume(OPS_A.token, ROLLS, quantity);
      expect(res.status, String(quantity)).toBe(422);
    }
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(0);
  });

  it('refuses an item that is not in the caller’s workbook', async () => {
    const res = await consume(OPS_A.token, 'ITM-NOT-REAL', 1);
    expect(res.status).toBe(404);
    expect(await h.invRepo.listMovements(ctx(TENANT_A))).toHaveLength(0);
  });

  it('accepts stock that belongs to no single unit — COMMON is most of the linen', async () => {
    // The demo items are all COMMON. Asserting the item's own property against the property
    // register would refuse every shared item in the business.
    expect((await itemRow(TENANT_A, ROLLS)).propertyId).toBe('COMMON');
    const res = await consume(OPS_A.token, ROLLS, 1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('applies a repeated operation id exactly once', async () => {
    const operationId = op();
    const body = {
      operationId, itemRef: ROLLS, movementType: 'CONSUMPTION' as const, quantity: 2,
    };

    const first = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', body);
    const again = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', body);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    // Once, not twice — the whole point of the envelope.
    expect((await itemRow(TENANT_A, ROLLS)).used).toBe(2);
    expect(await h.invRepo.listMovements(ctx(TENANT_A))).toHaveLength(1);
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

  it('refuses another tenant’s operation id rather than replaying its result', async () => {
    const operationId = op();
    const body = {
      operationId, itemRef: ROLLS, movementType: 'CONSUMPTION' as const, quantity: 2,
    };
    const mine = await h.request(OPS_A.token, 'POST', '/api/inventory/movements', body);
    expect(mine.status).toBe(200);

    /*
     * An operation id is globally unique, so two tenants CAN present the same one. The
     * ledger compares the tenant BEFORE the request hash, so B is refused — never handed
     * A's stored result, and never told its own request had already been applied.
     */
    const theirs = await h.request(OPS_B.token, 'POST', '/api/inventory/movements', body);
    expect(theirs.status).toBe(409);
    expect(theirs.body.error.code).toBe('OPERATION_MISMATCH');
    expect(JSON.stringify(theirs.body)).not.toContain(mine.body.id);
    expect((await itemRow(TENANT_B, ROLLS)).used).toBe(0);
  });

  it('links a workbook vendor NAME to finance’s vendor, and refuses a second meaning', async () => {
    const vendorId = await aVendor(ADMIN_A.token, 'Demo Supplies');
    const other = await aVendor(ADMIN_A.token, 'Someone Else');

    const linked = await h.request(ADMIN_A.token, 'POST', '/api/inventory/vendor-links', {
      operationId: op(), vendorName: 'Demo Supplies', vendorId,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);

    const stock = await h.request(OPS_A.token, 'GET', '/api/inventory/stock');
    const rolls = stock.body.find((i: any) => i.itemRef === ROLLS);
    expect(rolls.vendorName).toBe('Demo Supplies');
    // WHETHER we know who that is — never WHICH, on an operations screen.
    expect(rolls.vendorLinked).toBe(true);
    expect(rolls).not.toHaveProperty('vendorId');

    // An item whose name nobody has linked yet is honest about it.
    const towels = stock.body.find((i: any) => i.itemRef === TOWELS);
    expect(towels.vendorName).toBe('Demo Linen Co');
    expect(towels.vendorLinked).toBe(false);

    const second = await h.request(ADMIN_A.token, 'POST', '/api/inventory/vendor-links', {
      operationId: op(), vendorName: 'demo supplies', vendorId: other,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_LINKED');
  });
});

/* ================================================================== *
 * 4 · RECONCILIATION (§54) — a comparison, never an authority
 * ================================================================== */

describe('inventory · reconciliation', () => {
  const rowFor = (body: any[], itemRef: string) => body.find((r) => r.itemRef === itemRef);

  it('reports MATCHED when the sums of events equal the workbook’s totals', async () => {
    await consume(OPS_A.token, ROLLS, 4);
    const res = await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');
    const row = rowFor(res.body, ROLLS);
    expect(row.status).toBe('MATCHED');
    expect(row.workbookUsed).toBe(4);
    expect(row.contextUsed).toBe(4);
  });

  it('reports UNEXPLAINED_MOVEMENT when the workbook moved without context', async () => {
    // The pre-existing write path, still open and still legitimate: somebody edits the
    // sheet, or uses PATCH directly. Everything predating this milestone looks like this.
    const patched = await h.request(ADMIN_A.token, 'PATCH', `/api/inventory/${ROLLS}`, {
      operationId: op(), used: 7,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const res = await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');
    const row = rowFor(res.body, ROLLS);
    expect(row.status).toBe('UNEXPLAINED_MOVEMENT');
    expect(row.workbookUsed).toBe(7);
    expect(row.contextUsed).toBe(0);
  });

  it('reports CONTEXT_AHEAD when a recorded movement never reached the totals', async () => {
    await consume(OPS_A.token, ROLLS, 4);
    // The lost update this design cannot prevent, made to happen: the sheet total goes
    // backwards while the movement record stands.
    await h.request(ADMIN_A.token, 'PATCH', `/api/inventory/${ROLLS}`, {
      operationId: op(), used: 0,
    });

    const res = await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');
    const row = rowFor(res.body, ROLLS);
    // Before this overlay existed the same loss was completely undetectable.
    expect(row.status).toBe('CONTEXT_AHEAD');
    expect(row.contextUsed).toBe(4);
    expect(row.workbookUsed).toBe(0);
  });

  it('reports UNAPPLIED_CONTEXT when a sheet write did not land', async () => {
    h.sheet.fail = true;
    await consume(OPS_A.token, ROLLS, 3);
    h.sheet.fail = false;

    const res = await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');
    const row = rowFor(res.body, ROLLS);
    expect(row.status).toBe('UNAPPLIED_CONTEXT');
    expect(row.unappliedCount).toBe(1);
    // The unapplied attempt is NOT counted as movement — it never happened.
    expect(row.contextUsed).toBe(0);
  });

  it('repairs nothing and decides nobody is right — it only reports', async () => {
    await h.request(ADMIN_A.token, 'PATCH', `/api/inventory/${ROLLS}`, {
      operationId: op(), used: 7,
    });
    const before = await itemRow(TENANT_A, ROLLS);

    await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');
    await h.request(ADMIN_A.token, 'GET', '/api/inventory/reconciliation');

    const after = await itemRow(TENANT_A, ROLLS);
    expect(after.used).toBe(before.used);
    expect(after.currentStock).toBe(before.currentStock);
    // Reading a report writes nothing, so it cannot become a repair loop.
    expect(await h.invRepo.listMovements(ctx(TENANT_A))).toHaveLength(0);
  });
});

/* ================================================================== *
 * 5 · THE PROCUREMENT LIFECYCLE (§55)
 * ================================================================== */

describe('inventory · procurement', () => {
  it('runs request → approval → order → send → receipt, and only the receipt moves stock', async () => {
    const requested = await h.request(OPS_A.token, 'POST', '/api/inventory/requests', {
      operationId: op(), lines: [{ itemRef: TOWELS, quantity: 24 }], reason: 'Below par',
    });
    expect(requested.body.status).toBe('DRAFT');

    for (const [token, status] of [
      [OPS_A.token, 'SUBMITTED'], [ADMIN_A.token, 'APPROVED'],
    ] as const) {
      const moved = await h.request(
        token, 'POST', `/api/inventory/requests/${requested.body.id}/decision`,
        { operationId: op(), status },
      );
      expect(moved.status, `${status}: ${JSON.stringify(moved.body)}`).toBe(200);
      expect(moved.body.status).toBe(status);
    }

    const vendorId = await aVendor(ADMIN_A.token);
    const order = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
      operationId: op(), vendorId, requestId: requested.body.id,
      lines: [{ itemRef: TOWELS, quantity: 24, expectedUnitPriceMinor: 15_000 }],
    });
    expect(order.status, JSON.stringify(order.body)).toBe(200);

    // A PROMISE, not a fact. Nothing has arrived, so nothing has moved.
    expect((await itemRow(TENANT_A, TOWELS)).purchased).toBe(0);

    for (const [token, status] of [
      [ADMIN_A.token, 'SUBMITTED'], [ADMIN2_A.token, 'APPROVED'], [ADMIN_A.token, 'SENT'],
    ] as const) {
      const moved = await h.request(
        token, 'POST', `/api/inventory/purchase-orders/${order.body.id}/status`,
        { operationId: op(), status },
      );
      expect(moved.status, `${status}: ${JSON.stringify(moved.body)}`).toBe(200);
    }
    expect((await itemRow(TENANT_A, TOWELS)).purchased).toBe(0);

    const lineId = order.body.lines[0].id;
    // Twenty ordered, eighteen arrived — which is the ordinary case, not the exception.
    const receipt = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId: order.body.id,
      lines: [{ poLineId: lineId, receivedQuantity: 18 }],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expect(receipt.body.linesNotApplied).toBe(0);

    // The workbook moved by WHAT ARRIVED, never by what was ordered.
    expect((await itemRow(TENANT_A, TOWELS)).purchased).toBe(18);
  });

  it('refuses a request approved by the person who raised it', async () => {
    const requested = await h.request(OPS_A.token, 'POST', '/api/inventory/requests', {
      operationId: op(), lines: [{ itemRef: TOWELS, quantity: 24 }],
    });
    await h.request(OPS_A.token, 'POST', `/api/inventory/requests/${requested.body.id}/decision`,
      { operationId: op(), status: 'SUBMITTED' });

    // ADMIN_A holds procurement.approve, so this is a genuine separation-of-duty refusal
    // rather than a capability one.
    const own = await h.request(
      ADMIN_A.token, 'POST', '/api/inventory/requests', {
        operationId: op(), lines: [{ itemRef: TOWELS, quantity: 24 }],
      });
    await h.request(ADMIN_A.token, `POST`, `/api/inventory/requests/${own.body.id}/decision`,
      { operationId: op(), status: 'SUBMITTED' });
    const selfApprove = await h.request(
      ADMIN_A.token, 'POST', `/api/inventory/requests/${own.body.id}/decision`,
      { operationId: op(), status: 'APPROVED' },
    );
    expect(selfApprove.status).toBe(409);
    expect(selfApprove.body.error.code).toBe('SELF_APPROVAL');

    const byAnother = await h.request(
      ADMIN2_A.token, 'POST', `/api/inventory/requests/${own.body.id}/decision`,
      { operationId: op(), status: 'APPROVED' },
    );
    expect(byAnother.status, JSON.stringify(byAnother.body)).toBe(200);
  });

  it('refuses an order approved by the person who raised it', async () => {
    const vendorId = await aVendor(ADMIN_A.token);
    const order = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
      operationId: op(), vendorId, lines: [{ itemRef: ROLLS, quantity: 10 }],
    });
    await h.request(ADMIN_A.token, 'POST', `/api/inventory/purchase-orders/${order.body.id}/status`,
      { operationId: op(), status: 'SUBMITTED' });

    const self = await h.request(
      ADMIN_A.token, 'POST', `/api/inventory/purchase-orders/${order.body.id}/status`,
      { operationId: op(), status: 'APPROVED' },
    );
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
  });

  it('refuses an order raised against a request nobody approved', async () => {
    const requested = await h.request(OPS_A.token, 'POST', '/api/inventory/requests', {
      operationId: op(), lines: [{ itemRef: TOWELS, quantity: 24 }],
    });
    const vendorId = await aVendor(ADMIN_A.token);

    const order = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
      operationId: op(), vendorId, requestId: requested.body.id,
      lines: [{ itemRef: TOWELS, quantity: 24 }],
    });
    expect(order.status).toBe(409);
    expect(order.body.error.code).toBe('REQUEST_NOT_APPROVED');
  });

  it('refuses a receipt against an order that was never approved and sent', async () => {
    const vendorId = await aVendor(ADMIN_A.token);
    const order = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
      operationId: op(), vendorId, lines: [{ itemRef: ROLLS, quantity: 10 }],
    });

    const early = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId: order.body.id,
      lines: [{ poLineId: order.body.lines[0].id, receivedQuantity: 10 }],
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('PO_NOT_RECEIVABLE');
    // Treating an order as received stock is the commonest way an inventory system
    // starts lying, so nothing moved.
    expect((await itemRow(TENANT_A, ROLLS)).purchased).toBe(0);
  });

  it('refuses a lifecycle jump rather than quietly allowing it', async () => {
    const { poId } = await aSentOrder(ROLLS, 10);
    const backwards = await h.request(
      ADMIN_A.token, 'POST', `/api/inventory/purchase-orders/${poId}/status`,
      { operationId: op(), status: 'SUBMITTED' },
    );
    expect(backwards.status).toBe(409);
    expect(backwards.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('receives a line for something not stocked without inventing an item', async () => {
    const vendorId = await aVendor(ADMIN_A.token);
    const order = await h.request(ADMIN_A.token, 'POST', '/api/inventory/purchase-orders', {
      operationId: op(), vendorId,
      lines: [{ description: 'Replacement door handle', quantity: 1 }],
    });
    for (const [token, status] of [
      [ADMIN_A.token, 'SUBMITTED'], [ADMIN2_A.token, 'APPROVED'], [ADMIN_A.token, 'SENT'],
    ] as const) {
      await h.request(token, 'POST', `/api/inventory/purchase-orders/${order.body.id}/status`,
        { operationId: op(), status });
    }

    const receipt = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId: order.body.id,
      lines: [{ poLineId: order.body.lines[0].id, receivedQuantity: 1 }],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    // Recorded as received; no stock moved, because there is nothing to move. Creating an
    // item here would be a second item master.
    expect(receipt.body.lines[0].stockApplied).toBe(false);
    const items = await h.wb.reposFor(TENANT_A).inventory.readAll();
    expect(items).toHaveLength(4);
  });

  it('creates no bill, payment or expense when goods arrive', async () => {
    const { poId, lineId } = await aSentOrder(ROLLS, 10);
    await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId, lines: [{ poLineId: lineId, receivedQuantity: 10 }],
    });

    // Things arriving and money being owed are different claims. `finance_bills` owns the
    // second one, and a person raises it.
    const bills = await h.request(ADMIN_A.token, 'GET', '/api/finance/payables');
    expect(bills.body).toEqual([]);
    expect(h.wb.audit.records.map((r) => r.action)
      .filter((a) => a.startsWith('finance.bill') || a.startsWith('finance.payment')))
      .toEqual([]);
  });

  it('refuses a receipt line that names an order line from a different order', async () => {
    const first = await aSentOrder(ROLLS, 10);
    const second = await aSentOrder(TOWELS, 5);

    const crossed = await h.request(OPS_A.token, 'POST', '/api/inventory/goods-receipts', {
      operationId: op(), poId: first.poId,
      lines: [{ poLineId: second.lineId, receivedQuantity: 5 }],
    });
    expect(crossed.status).toBe(404);
    expect((await itemRow(TENANT_A, TOWELS)).purchased).toBe(0);
  });
});

/* ================================================================== *
 * 6 · THE ASSET REGISTER (§56)
 * ================================================================== */

describe('inventory · assets', () => {
  it('surfaces 16_ASSETS, which existed in the workbook with nothing reading it', async () => {
    const res = await h.request(OPS_A.token, 'GET', '/api/inventory/assets');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);

    const ac = res.body.find((a: any) => a.assetRef === AC_ASSET);
    expect(ac.name).toBe('Split AC 1.5T');
    expect(ac.category).toBe('Appliance');
    expect(ac.condition).toBe('Good');
    expect(ac.status).toBe('In Use');
  });

  it('reads the sheet’s own warranty cell and derives the forward-looking signal separately', async () => {
    const res = await h.request(ADMIN_A.token, 'GET', '/api/inventory/assets');
    const ac = res.body.find((a: any) => a.assetRef === AC_ASSET);

    // Two different questions, both answered, neither replacing the other.
    expect(ac).toHaveProperty('warrantyLabel');
    expect(['ACTIVE', 'EXPIRING', 'EXPIRED', 'UNKNOWN']).toContain(ac.warrantyState);

    const sheetRow = (await h.wb.reposFor(TENANT_A).assets.readAll())
      .find((a) => a.assetId === AC_ASSET)!;
    expect(ac.warrantyLabel).toBe(sheetRow.warrantyStatus);
    expect(ac.warrantyExpiry).toBe(sheetRow.warrantyExpiry);
  });

  it('links a maintenance ticket to an asset, which the sheet could only say in prose', async () => {
    const linked = await h.request(
      OPS_A.token, 'POST', `/api/inventory/assets/${AC_ASSET}/tickets`,
      { operationId: op(), ticketRef: 'MNT-D-0011', note: 'Compressor replaced' },
    );
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);

    const assets = await h.request(OPS_A.token, 'GET', '/api/inventory/assets');
    const ac = assets.body.find((a: any) => a.assetRef === AC_ASSET);
    expect(ac.linkedTickets).toEqual(['MNT-D-0011']);

    const again = await h.request(
      OPS_A.token, 'POST', `/api/inventory/assets/${AC_ASSET}/tickets`,
      { operationId: op(), ticketRef: 'MNT-D-0011' },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_LINKED');
  });

  it('refuses a link to an asset that is not in the caller’s workbook', async () => {
    const res = await h.request(
      OPS_A.token, 'POST', '/api/inventory/assets/AST-NOT-REAL/tickets',
      { operationId: op(), ticketRef: 'MNT-D-0011' },
    );
    expect(res.status).toBe(404);
    expect(await h.invRepo.listAssetLinks(ctx(TENANT_A))).toHaveLength(0);
  });

  it('keeps one tenant’s asset links out of the other’s register', async () => {
    await h.request(OPS_A.token, 'POST', `/api/inventory/assets/${TENANT_B_ASSET}/tickets`,
      { operationId: op(), ticketRef: 'MNT-A-0001' });

    // The asset id exists in BOTH grids, so only the predicate can separate the links.
    const theirs = await h.request(OPS_B.token, 'GET', '/api/inventory/assets');
    const asset = theirs.body.find((a: any) => a.assetRef === TENANT_B_ASSET);
    expect(asset.linkedTickets).toEqual([]);
  });

  it('records no depreciation and no book value — a purchase cost is what was paid', async () => {
    const res = await h.request(ADMIN_A.token, 'GET', '/api/inventory/assets');
    const ac = res.body.find((a: any) => a.assetRef === AC_ASSET);
    for (const forbidden of [
      'netBookValue', 'bookValue', 'depreciation', 'accumulatedDepreciation',
      'depreciatedValue', 'usefulLifeMonths',
    ]) {
      expect(ac, forbidden).not.toHaveProperty(forbidden);
    }
    expect(ac.purchaseCostMinor).toBe(4_200_000);
  });
});

/* ================================================================== *
 * 7 · GOVERNANCE — the route table cannot drift
 * ================================================================== */

describe('inventory · route governance', () => {
  it('every inventory route is classified, and every write is registered', () => {
    const failures: string[] = [];
    assertWriteGovernance(API_ROUTES, (ok, message) => { if (!ok) failures.push(message); });
    expect(failures).toEqual([]);
  });

  it('every inventory-writing route lives under the prefix and carries a domain capability', () => {
    const writes = API_ROUTES.filter((r) => (r as any).writesInventory === true);
    expect(writes.length).toBeGreaterThan(0);
    for (const route of writes) {
      expect(route.path, route.path).toMatch(/^\/api\/inventory\//);
      expect(route.capability, route.path)
        .toMatch(/^(inventory|procurement)\./);
      expect(route.method, route.path).not.toBe('GET');
    }
  });

  it('classifies each non-GET inventory route exactly once', () => {
    const kinds = ['mutates', 'nonMutating', 'writesFinance', 'writesHr', 'writesOps',
      'writesInventory'] as const;
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/inventory'))) {
      if (route.method === 'GET') continue;
      const declared = kinds.filter((k) => (route as any)[k] === true);
      expect(declared, `${route.method} ${route.path}`).toHaveLength(1);
    }
  });

  it('every registered inventory handler answers, so no route is dead', async () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/inventory/'))) {
      if (route.method !== 'GET') continue;
      const res = await h.request(ADMIN_A.token, 'GET', route.path);
      expect(res.status, route.path).toBe(200);
    }
  });
});
