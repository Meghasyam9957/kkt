import '@/lib/server/only';
/**
 * INVENTORY, PROCUREMENT AND ASSET HANDLERS.
 *
 * The same envelope as finance, HR and operations — tenant, validate, idempotency, apply,
 * project — with two things worth naming.
 *
 * FIRST: a stock movement writes TWO stores, and the sheet goes first because stock is its
 * fact. The ordering and its failure mode are reasoned about in the service; this file only
 * carries the envelope.
 *
 * SECOND: two capabilities are checked HERE rather than on the route, because the route
 * carries one capability and these depend on the payload:
 *
 *   an ADJUSTMENT needs `inventory.adjust`, which OPERATIONS deliberately does not hold —
 *   correcting a count is how a discrepancy stops being a question anybody asks;
 *   APPROVING or REJECTING a request needs `procurement.approve`, while submitting and
 *   cancelling the same request need only `procurement.request` — asking and deciding are
 *   different powers travelling through one endpoint;
 *   a PRICE is projected only for a caller holding a financial capability.
 *
 * WHAT NO HANDLER HERE DOES: create a bill, a payment or an expense. Stock arriving and money
 * being owed are different claims, and `finance_bills` owns the second one.
 */
import { z } from 'zod';
import type { ApiRouter } from './router';
import { requireTenant, type TenantContext } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import { requestHashOf, type OperationStore } from '@/lib/server/ops/operation-store';
import type { HandlerContext } from '@/lib/server/auth/guard';
import { roleHasCapability } from '@/lib/shared/roles';
import { safeReason } from '@/lib/server/audit/reason';
import type { InventoryService } from '@/lib/server/inventory/service';
import { InventoryError, MOVEMENT_TYPES, WASTAGE_REASONS } from '@/lib/server/inventory/types';
import {
  stockItemView, movementView, reconciliationItemView, requestView, purchaseOrderView,
  goodsReceiptView, assetItemView,
} from '@/lib/server/inventory/projections';

export interface InventoryHandlerDeps {
  service: InventoryService;
  store: OperationStore;
  audit: AuditService;
  writesPermitted: boolean;
}

const line = z.object({
  itemRef: z.string().min(1).max(60).optional(),
  description: z.string().min(1).max(400).optional(),
  quantity: z.number().positive(),
  unit: z.string().max(30).optional(),
}).strict();

const movementSchema = z.object({
  operationId: z.string().uuid('an operation id is a uuid'),
  itemRef: z.string().min(1).max(60),
  movementType: z.enum(MOVEMENT_TYPES),
  quantity: z.number().positive('a movement moves a positive quantity'),
  employeeId: z.string().uuid().optional(),
  taskType: z.enum(['HOUSEKEEPING', 'MAINTENANCE']).optional(),
  taskRef: z.string().min(1).max(60).optional(),
  reason: z.string().max(500).optional(),
  wastageReason: z.enum(WASTAGE_REASONS).optional(),
  counterpartyPropertyId: z.string().min(1).max(60).optional(),
  adjusts: z.enum(['PURCHASED', 'USED']).optional(),
}).strict();

const requestSchema = z.object({
  operationId: z.string().uuid(),
  propertyId: z.string().min(1).max(60).optional(),
  priority: z.string().max(30).optional(),
  reason: z.string().max(500).optional(),
  lines: z.array(line).min(1).max(50),
}).strict();

const decisionSchema = z.object({
  operationId: z.string().uuid(),
  status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED']),
  note: z.string().max(500).optional(),
}).strict();

const poSchema = z.object({
  operationId: z.string().uuid(),
  vendorId: z.string().uuid(),
  propertyId: z.string().min(1).max(60).optional(),
  requestId: z.string().uuid().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(line.extend({
    expectedUnitPriceMinor: z.number().int().nonnegative().optional(),
  }).strict()).min(1).max(50),
}).strict();

const poStatusSchema = z.object({
  operationId: z.string().uuid(),
  status: z.enum(['SUBMITTED', 'APPROVED', 'SENT', 'CANCELLED']),
}).strict();

const receiptSchema = z.object({
  operationId: z.string().uuid(),
  poId: z.string().uuid(),
  propertyId: z.string().min(1).max(60).optional(),
  notes: z.string().max(500).optional(),
  lines: z.array(z.object({
    poLineId: z.string().uuid(),
    receivedQuantity: z.number().positive(),
    condition: z.string().max(30).optional(),
  }).strict()).min(1).max(50),
}).strict();

/**
 * A repair supplies an id and nothing else. Deliberately: the quantity, the item, the
 * employee and the reason are already on the recorded movement, and letting a caller restate
 * any of them would be letting them rewrite history while claiming to repair it.
 */
const repairSchema = z.object({
  operationId: z.string().uuid(),
}).strict();

const vendorLinkSchema = z.object({
  operationId: z.string().uuid(),
  vendorName: z.string().min(1).max(200),
  vendorId: z.string().uuid(),
}).strict();

const assetLinkSchema = z.object({
  operationId: z.string().uuid(),
  ticketRef: z.string().min(1).max(60),
  note: z.string().max(500).optional(),
}).strict();

interface Refusal {
  __mutationError: true;
  status: number; code: string; message: string; details?: unknown;
}

function refusal(status: number, code: string, message: string, details?: unknown): Refusal {
  return { __mutationError: true, status, code, message, ...(details ? { details } : {}) };
}

function fromInventoryError(error: unknown): Refusal {
  if (error instanceof InventoryError) {
    return refusal(error.httpStatus, error.code, error.message);
  }
  if (error instanceof Error
    && (error.name === 'HrError' || error.name === 'MutationError'
      || error.name === 'OperationsError')) {
    const status = (error as { httpStatus?: number; status?: number }).httpStatus
      ?? (error as { status?: number }).status ?? 422;
    return refusal(status, (error as { code?: string }).code ?? 'REFUSED', error.message);
  }
  throw error;
}

function parsed<T extends z.ZodTypeAny>(schema: T, body: unknown):
  | { ok: true; value: z.infer<T> }
  | { ok: false; refusal: Refusal } {
  const result = schema.safeParse(body ?? {});
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    refusal: refusal(422, 'VALIDATION', 'The request does not match the expected shape.',
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)),
  };
}

/**
 * Whether this caller may see money.
 *
 * Read from the capability table rather than from the role, so a future role that legitimately
 * holds a financial capability gets prices without anybody remembering to update a list here.
 */
function maySeeMoney(ctx: HandlerContext): boolean {
  return roleHasCapability(ctx.auth.role, 'finance.read')
    || roleHasCapability(ctx.auth.role, 'procurement.approve');
}

export function registerInventoryHandlers(
  router: ApiRouter,
  depsFor: (tenant: TenantContext) => Promise<InventoryHandlerDeps>,
): void {
  const svc = async (ctx: HandlerContext, where: string) => {
    const tenant = requireTenant(ctx.auth, where);
    return { tenant, deps: await depsFor(tenant) };
  };

  const propertyFrom = (ctx: HandlerContext): string | undefined => {
    const value = ctx.request.query?.property;
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  /**
   * One envelope for every inventory write: writes-enabled gate, idempotency, apply, audit.
   * Written once so a new endpoint cannot accidentally skip one of the four.
   */
  const write = async <T>(
    ctx: HandlerContext, action: string, entityType: string,
    operationId: string, payload: unknown,
    apply: (tenant: TenantContext, deps: InventoryHandlerDeps) => Promise<{ id: string; view: T }>,
  ): Promise<T | Refusal> => {
    const { tenant, deps } = await svc(ctx, action);
    if (!deps.writesPermitted) {
      return refusal(403, 'WRITES_DISABLED',
        'Operational writes are not enabled in this environment. Reads are unaffected.');
    }

    /*
     * THE PATH IDENTIFIES THE INTENT, and it must be in the hash.
     *
     * This read `entityId: operationId`, which makes the hash CONSTANT for a given operation
     * id — so two requests carrying the same id and the same body but a different `:id` in
     * the path hashed identically. The second was answered `verified` and handed the FIRST
     * one's stored result: approving request A and then request B with one retried operation
     * id approved A twice, told the caller B had succeeded, and left B untouched.
     *
     * Finance and HR have always hashed `ctx.request.params?.id`; inventory did not, and the
     * difference was invisible because every existing test varied the operation id too.
     */
    const requestHash = requestHashOf({
      action, entityId: ctx.request.params?.id ?? null, input: payload,
    });
    const begun = await deps.store.begin({
      operationId, tenantId: tenant.tenantId,
      actorId: ctx.auth.userId ?? null, actorRole: ctx.auth.role,
      action, requestHash,
    });

    if (begun.outcome === 'verified') return begun.result as T;
    if (begun.outcome === 'in-flight') {
      return refusal(409, 'OPERATION_IN_FLIGHT',
        `Operation ${operationId} is already being applied.`);
    }
    if (begun.outcome === 'failed') {
      return refusal(409, 'OPERATION_FAILED_BEFORE',
        `Operation ${operationId} already failed (${begun.error ?? 'no reason recorded'}).`);
    }
    if (begun.outcome === 'mismatch') {
      return refusal(409, 'OPERATION_MISMATCH',
        `Operation ${operationId} was first submitted with a different payload. `
        + 'An operation id identifies one intent; mint a new id for a new intent.');
    }

    try {
      await deps.store.markApplying(operationId);
      const { id, view } = await apply(tenant, deps);
      await deps.store.complete(operationId, { type: entityType, id }, view as unknown);
      await deps.audit.record({
        actor: ctx.auth, action: `${action}.applied`, entityType, entityId: id,
        result: 'ALLOW', requestId: ctx.request.requestId,
        // The operation and the entity. Never a quantity and never an employee name: a
        // trail of who used what is a staff-movement record nobody asked for.
        metadata: { operationId },
      });
      return view;
    } catch (error) {
      const reason = safeReason(error);
      await deps.store.fail(operationId, { type: entityType, id: '' }, reason);
      await deps.audit.record({
        actor: ctx.auth, action, entityType, result: 'ERROR', reason,
        requestId: ctx.request.requestId, metadata: { operationId },
      });
      return fromInventoryError(error);
    }
  };

  /* ---------------- Stock, movements, reconciliation ---------------- */

  router.register('GET', '/api/inventory/stock', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'inventory.stock');
    try {
      return (await deps.service.stock(tenant, propertyFrom(ctx))).map(stockItemView);
    } catch (error) { return fromInventoryError(error); }
  });

  router.register('GET', '/api/inventory/movements', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'inventory.movements');
    const itemRef = ctx.request.query?.item;
    try {
      const rows = await deps.service.movements(tenant, {
        ...(typeof itemRef === 'string' && itemRef ? { itemRef } : {}),
        ...(propertyFrom(ctx) ? { propertyId: propertyFrom(ctx) } : {}),
        limit: 200,
      });
      return rows.map(movementView);
    } catch (error) { return fromInventoryError(error); }
  });

  router.register('GET', '/api/inventory/reconciliation', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'inventory.reconciliation');
    try {
      return (await deps.service.reconciliation(tenant)).map(reconciliationItemView);
    } catch (error) { return fromInventoryError(error); }
  });

  router.register('POST', '/api/inventory/movements', async (ctx) => {
    const input = parsed(movementSchema, ctx.request.body);
    if (!input.ok) return input.refusal;

    /*
     * The payload-dependent capability. The route carries `inventory.movement`, which an
     * operations supervisor holds; correcting the count itself needs `inventory.adjust`,
     * which they deliberately do not.
     */
    if (input.value.movementType === 'ADJUSTMENT'
      && !roleHasCapability(ctx.auth.role, 'inventory.adjust')) {
      return refusal(403, 'ADJUSTMENT_NOT_PERMITTED',
        'Recording why stock moved and correcting the count are different powers. '
        + 'This account holds the first and not the second.');
    }

    const { operationId, ...movement } = input.value;
    return write(ctx, 'inventory.movement.record', 'INV_MOVEMENT', operationId, input.value,
      async (tenant, deps) => {
        const result = await deps.service.recordMovement(tenant, movement, ctx.auth.userId ?? 'unknown', {
          auth: ctx.auth, requestId: ctx.request.requestId ?? 'inv-movement',
        });
        return { id: result.movement.id, view: movementView(result.movement) };
      });
  });

  /**
   * REPAIR — re-apply a movement the workbook refused.
   *
   * Carries `inventory.adjust` rather than `inventory.movement`, and deliberately so: this
   * changes the stock figure without anybody recording a new fact about the world, which is
   * the same power as correcting a count. OPERATIONS holds the first and not the second.
   *
   * Every safety property of the canonical path still applies — the service re-reads the
   * current total, adds to it under the item's lock, and marks the row applied only if the
   * workbook took it.
   */
  router.register('POST', '/api/inventory/movements/:id/repair', async (ctx) => {
    const input = parsed(repairSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    return write(ctx, 'inventory.movement.repair', 'INV_MOVEMENT', input.value.operationId,
      input.value, async (tenant, deps) => {
        const result = await deps.service.repairMovement(
          tenant, id, ctx.auth.userId ?? 'unknown',
          { auth: ctx.auth, requestId: ctx.request.requestId ?? 'inv-repair' });
        return { id: result.movement.id, view: movementView(result.movement) };
      });
  });

  /* ---------------- Procurement ---------------- */

  router.register('GET', '/api/inventory/requests', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'inventory.requests');
    try {
      const rows = await deps.service.listRequests(tenant);
      return rows.map(requestView);
    } catch (error) { return fromInventoryError(error); }
  });

  router.register('POST', '/api/inventory/requests', async (ctx) => {
    const input = parsed(requestSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { operationId, ...body } = input.value;
    return write(ctx, 'inventory.request.create', 'INV_REQUEST', operationId, input.value,
      async (tenant, deps) => {
        const request = await deps.service.createRequest(tenant, body, ctx.auth.userId ?? 'unknown');
        return { id: request.id, view: requestView(request) };
      });
  });

  router.register('POST', '/api/inventory/requests/:id/decision', async (ctx) => {
    const input = parsed(decisionSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    /*
     * The payload-dependent capability, as with an adjustment above. The route carries
     * `procurement.request` so the person who wrote a request can submit it; deciding it is
     * the separate power, and separation of duty in the service refuses even a holder of
     * that power from deciding their own.
     */
    if ((input.value.status === 'APPROVED' || input.value.status === 'REJECTED')
      && !roleHasCapability(ctx.auth.role, 'procurement.approve')) {
      return refusal(403, 'DECISION_NOT_PERMITTED',
        'Asking for stock and deciding the request are different powers. '
        + 'This account holds the first and not the second.');
    }

    const id = ctx.request.params?.id ?? '';
    return write(ctx, 'inventory.request.decide', 'INV_REQUEST', input.value.operationId,
      input.value, async (tenant, deps) => {
        const request = await deps.service.decideRequest(
          tenant, id, input.value.status, ctx.auth.userId ?? 'unknown',
          input.value.note ?? null);
        return { id: request.id, view: requestView(request) };
      });
  });

  router.register('GET', '/api/inventory/purchase-orders', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'inventory.purchaseOrders');
    try {
      const rows = await deps.service.listPurchaseOrders(tenant);
      return rows.map((po) => purchaseOrderView(po, maySeeMoney(ctx)));
    } catch (error) { return fromInventoryError(error); }
  });

  router.register('POST', '/api/inventory/purchase-orders', async (ctx) => {
    const input = parsed(poSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { operationId, ...body } = input.value;
    return write(ctx, 'inventory.po.create', 'INV_PURCHASE_ORDER', operationId, input.value,
      async (tenant, deps) => {
        const po = await deps.service.createPurchaseOrder(tenant, body, ctx.auth.userId ?? 'unknown');
        return { id: po.id, view: purchaseOrderView(po, maySeeMoney(ctx)) };
      });
  });

  router.register('POST', '/api/inventory/purchase-orders/:id/status', async (ctx) => {
    const input = parsed(poStatusSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    return write(ctx, 'inventory.po.transition', 'INV_PURCHASE_ORDER', input.value.operationId,
      input.value, async (tenant, deps) => {
        const po = await deps.service.transitionPurchaseOrder(
          tenant, id, input.value.status, ctx.auth.userId ?? 'unknown');
        return { id: po.id, view: purchaseOrderView(po, maySeeMoney(ctx)) };
      });
  });

  router.register('POST', '/api/inventory/goods-receipts', async (ctx) => {
    const input = parsed(receiptSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { operationId, ...body } = input.value;
    return write(ctx, 'inventory.goodsReceipt.record', 'INV_GOODS_RECEIPT', operationId,
      input.value, async (tenant, deps) => {
        const result = await deps.service.receiveGoods(tenant, body, ctx.auth.userId ?? 'unknown', {
          auth: ctx.auth, requestId: ctx.request.requestId ?? 'inv-grn',
        });
        return {
          id: result.receipt.id,
          view: {
            ...goodsReceiptView(result.receipt),
            /*
             * How many lines did NOT reach the workbook. Surfaced rather than buried: a
             * delivery that arrived but whose stock did not move is a repair item, and a
             * receipt that quietly claimed otherwise would be the lie this design exists to
             * prevent.
             */
            linesNotApplied: result.unapplied,
          },
        };
      });
  });

  router.register('POST', '/api/inventory/vendor-links', async (ctx) => {
    const input = parsed(vendorLinkSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    return write(ctx, 'inventory.vendorLink.create', 'INV_VENDOR_LINK',
      input.value.operationId, input.value, async (tenant, deps) => {
        await deps.service.linkVendorName(
          tenant, input.value.vendorName, input.value.vendorId, ctx.auth.userId ?? 'unknown');
        return { id: input.value.vendorId, view: { linked: true } };
      });
  });

  /* ---------------- Assets ---------------- */

  router.register('GET', '/api/inventory/assets', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'inventory.assets');
    try {
      const rows = await deps.service.assets(tenant, propertyFrom(ctx));
      return rows.map((a) => assetItemView(a, maySeeMoney(ctx)));
    } catch (error) { return fromInventoryError(error); }
  });

  router.register('POST', '/api/inventory/assets/:id/tickets', async (ctx) => {
    const input = parsed(assetLinkSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const assetRef = ctx.request.params?.id ?? '';
    return write(ctx, 'inventory.asset.link', 'INV_ASSET_LINK', input.value.operationId,
      input.value, async (tenant, deps) => {
        await deps.service.linkAssetTicket(
          tenant, assetRef, input.value.ticketRef, ctx.auth.userId ?? 'unknown',
          input.value.note ?? null);
        return { id: assetRef, view: { linked: true } };
      });
  });
}
