import '@/lib/server/only';
/**
 * FINANCE HANDLERS — the HTTP edge of the relational finance domain.
 *
 * Every handler is the same five steps in the same order, and the order is the point:
 *
 *   1. TENANT       `requireTenant(ctx.auth, …)` — from the guard's authenticated context
 *                   and nowhere else. There is no branch that reads a tenant from the
 *                   request, so there is nothing for a caller to poison.
 *   2. VALIDATE     zod, `.strict()`, so an unrecognised key is a 422 rather than an
 *                   ignored field. A `tenantId` in the body is refused BY NAME.
 *   3. IDEMPOTENCY  (writes only) the same tenant-aware operation store the workbook
 *                   mutations use. A retried payment does not become two payments, and
 *                   an operation id from another tenant is a mismatch, never a replay.
 *   4. APPLY        the service, which owns every rule.
 *   5. PROJECT      a role-safe view model. No database row reaches a client.
 *
 * MONEY CROSSES AS MINOR UNITS. `amountMinor: 250000` is ₹2,500.00 exactly. A decimal
 * rupee field would arrive as a float and there would be no boundary at which it stopped
 * being one; an integer of paise has no representation error to lose.
 */
import { z } from 'zod';
import type { ApiRouter } from './router';
import { requireTenant } from '@/lib/server/tenant/context';
import type { TenantContext } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import { requestHashOf, type OperationStore } from '@/lib/server/ops/operation-store';
import type { HandlerContext } from '@/lib/server/auth/guard';
import { FinanceService } from '@/lib/server/finance/service';
import { FinanceError } from '@/lib/server/finance/types';
import { CORPORATE, propertyAttribution, type Attribution } from '@/lib/server/finance/types';
import { paise } from '@/lib/server/finance/money';
import {
  vendorView, billView, receivableView, paymentView, positionView, periodView,
} from '@/lib/server/finance/projections';
import { safeReason } from '@/lib/server/audit/reason';

export interface FinanceHandlerDeps {
  /** Built per request from the caller's tenant. There is no ambient service. */
  service: FinanceService;
  store: OperationStore;
  audit: AuditService;
  /** When false, every finance write is refused with a controlled 403, reads unaffected. */
  writesPermitted: boolean;
}

/* ------------------------------------------------------------------ *
 * Input shapes
 * ------------------------------------------------------------------ */

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Paise. Integer by construction, so no float ever reaches the domain. */
const MINOR = z.number().int('amounts are whole paise').positive('an amount must be positive');

/**
 * A cost belongs to one property or to the business.
 *
 * `propertyId` is validated against the CALLER'S OWN workbook in the service, so naming
 * another tenant's property produces the same refusal as naming one that does not exist.
 */
const attributionSchema = z.object({
  kind: z.enum(['PROPERTY', 'CORPORATE']),
  propertyId: z.string().min(1).optional(),
}).strict().refine(
  (a) => (a.kind === 'PROPERTY' ? !!a.propertyId : !a.propertyId),
  'a PROPERTY attribution names a property and a CORPORATE one does not',
);

function toAttribution(input: { kind: 'PROPERTY' | 'CORPORATE'; propertyId?: string }): Attribution {
  return input.kind === 'PROPERTY' ? propertyAttribution(input.propertyId!) : CORPORATE;
}

/** Every write carries one, and the same id twice is the same intent twice. */
const operationId = z.string().uuid('an operation id is a uuid');

const vendorSchema = z.object({
  operationId,
  displayName: z.string().min(1).max(200),
  gstin: z.string().length(15).optional(),
  contactRef: z.string().max(200).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const billSchema = z.object({
  operationId,
  vendorId: z.string().uuid(),
  billReference: z.string().min(1).max(120),
  billDate: ISO_DATE,
  dueDate: ISO_DATE.optional(),
  attribution: attributionSchema,
  amountMinor: MINOR,
  taxMinor: z.number().int().min(0).optional(),
  description: z.string().max(2000).optional(),
}).strict();

const receivableSchema = z.object({
  operationId,
  counterparty: z.string().min(1).max(200),
  bookingRef: z.string().max(120).optional(),
  reference: z.string().min(1).max(120),
  issuedDate: ISO_DATE,
  dueDate: ISO_DATE.optional(),
  attribution: attributionSchema,
  amountMinor: MINOR,
  taxMinor: z.number().int().min(0).optional(),
  description: z.string().max(2000).optional(),
}).strict();

const paymentSchema = z.object({
  operationId,
  direction: z.enum(['INCOMING', 'OUTGOING']),
  amountMinor: MINOR,
  paidOn: ISO_DATE,
  billId: z.string().uuid().optional(),
  receivableId: z.string().uuid().optional(),
  attribution: attributionSchema,
  accountRef: z.string().max(120).optional(),
  methodRef: z.string().max(60).optional(),
  cashflowRef: z.string().max(120).optional(),
  externalRef: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const transitionSchema = z.object({ operationId }).strict();

const closePeriodSchema = z.object({
  operationId,
  periodStart: z.string().regex(/^\d{4}-\d{2}-01$/, 'a period is named by its first day'),
}).strict();

const reopenPeriodSchema = closePeriodSchema.extend({
  reason: z.string().min(3).max(500),
}).strict();

/* ------------------------------------------------------------------ *
 * The write envelope
 * ------------------------------------------------------------------ */

interface Refusal {
  __mutationError: true;
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function refusal(status: number, code: string, message: string, details?: unknown): Refusal {
  return { __mutationError: true, status, code, message, ...(details ? { details } : {}) };
}

function fromFinanceError(error: unknown): Refusal {
  if (error instanceof FinanceError) {
    return refusal(error.httpStatus, error.code, error.message);
  }
  if (error instanceof Error && error.name === 'MoneyError') {
    return refusal(422, 'MONEY', error.message);
  }
  throw error;
}

/**
 * Idempotency, audit and the write gate, in one place.
 *
 * The operation store is the SAME one the workbook mutations use, so a finance retry is
 * protected by machinery that already refuses a cross-tenant operation id before it
 * compares anything else. Two customers presenting the same id get a mismatch, not a
 * replay of one another's result.
 */
async function financeWrite<T>(
  deps: FinanceHandlerDeps,
  ctx: HandlerContext,
  action: string,
  entityType: string,
  body: { operationId: string } & Record<string, unknown>,
  apply: (tenant: TenantContext) => Promise<{ id: string; view: T }>,
): Promise<T | Refusal> {
  if (!deps.writesPermitted) {
    return refusal(403, 'WRITES_DISABLED',
      'Finance writes are not enabled in this environment. Reads are unaffected.');
  }

  const tenant = requireTenant(ctx.auth, `finance:${action}`);
  const requestHash = requestHashOf({ action, entityId: ctx.request.params?.id ?? null, input: body });

  const begun = await deps.store.begin({
    operationId: body.operationId,
    tenantId: tenant.tenantId,
    actorId: ctx.auth.userId ?? null,
    actorRole: ctx.auth.role,
    action,
    requestHash,
  });

  if (begun.outcome === 'verified') return begun.result as T;
  if (begun.outcome === 'in-flight') {
    return refusal(409, 'OPERATION_IN_FLIGHT', `Operation ${body.operationId} is already being applied.`);
  }
  if (begun.outcome === 'failed') {
    return refusal(409, 'OPERATION_FAILED_BEFORE',
      `Operation ${body.operationId} already failed (${begun.error ?? 'no reason recorded'}). `
      + 'Review it, then submit again with a new operation id.');
  }
  if (begun.outcome === 'mismatch') {
    return refusal(409, 'OPERATION_MISMATCH',
      `Operation ${body.operationId} was first submitted with a different payload. `
      + 'An operation id identifies one intent; mint a new id for a new intent.');
  }

  try {
    await deps.store.markApplying(body.operationId);
    const { id, view } = await apply(tenant);
    await deps.store.complete(body.operationId, { type: entityType, id }, view);
    await deps.audit.record({
      actor: ctx.auth,
      action: `${action}.applied`,
      entityType,
      entityId: id,
      result: 'ALLOW',
      requestId: ctx.request.requestId,
      /*
       * The operation id and the entity, and NOTHING ELSE. A finance payload carries
       * amounts, counterparties and references; the audit trail records that a payment
       * was raised and which one, not a copy of its contents. What actually happened is
       * recoverable from the record itself, which is tenant-scoped; a second copy in the
       * audit log would be a second place to leak it from.
       */
      metadata: { operationId: body.operationId },
    });
    return view;
  } catch (error) {
    // Authored refusals keep their sentence; an upstream failure becomes a code. This
    // string is persisted in the ledger AND returned by GET /api/operations-log/:id.
    const reason = safeReason(error);
    await deps.store.fail(body.operationId, { type: entityType, id: '' }, reason);
    await deps.audit.record({
      actor: ctx.auth, action, entityType, result: 'ERROR', reason,
      requestId: ctx.request.requestId, metadata: { operationId: body.operationId },
    });
    return fromFinanceError(error);
  }
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

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export function registerFinanceHandlers(
  router: ApiRouter,
  depsFor: (tenant: TenantContext) => Promise<FinanceHandlerDeps>,
): void {
  /* ---- reads ---- */

  router.register('GET', '/api/finance/overview', async (ctx) => {
    const tenant = requireTenant(ctx.auth, 'finance.overview');
    const deps = await depsFor(tenant);
    return positionView(await deps.service.position(tenant, rangeFrom(ctx)));
  });

  router.register('GET', '/api/finance/vendors', async (ctx) => {
    const tenant = requireTenant(ctx.auth, 'finance.vendors');
    const deps = await depsFor(tenant);
    return (await deps.service.listVendors(tenant)).map(vendorView);
  });

  router.register('GET', '/api/finance/payables', async (ctx) => {
    const tenant = requireTenant(ctx.auth, 'finance.payables');
    const deps = await depsFor(tenant);
    return (await deps.service.billsWithBalances(tenant, rangeFrom(ctx))).map(billView);
  });

  router.register('GET', '/api/finance/receivables', async (ctx) => {
    const tenant = requireTenant(ctx.auth, 'finance.receivables');
    const deps = await depsFor(tenant);
    return (await deps.service.receivablesWithBalances(tenant, rangeFrom(ctx))).map(receivableView);
  });

  router.register('GET', '/api/finance/payments', async (ctx) => {
    const tenant = requireTenant(ctx.auth, 'finance.payments');
    const deps = await depsFor(tenant);
    return (await deps.service.listPayments(tenant, rangeFrom(ctx))).map(paymentView);
  });

  router.register('GET', '/api/finance/periods', async (ctx) => {
    const tenant = requireTenant(ctx.auth, 'finance.periods');
    const deps = await depsFor(tenant);
    return (await deps.service.listPeriods(tenant)).map(periodView);
  });

  /* ---- writes ---- */

  router.register('POST', '/api/finance/vendors', async (ctx) => {
    const input = parsed(vendorSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const deps = await depsFor(requireTenant(ctx.auth, 'finance.vendor.create'));
    return financeWrite(deps, ctx, 'finance.vendor.create', 'FINANCE_VENDOR', input.value,
      async (tenant) => {
        const vendor = await deps.service.createVendor(tenant, {
          displayName: input.value.displayName,
          gstin: input.value.gstin ?? null,
          contactRef: input.value.contactRef ?? null,
          paymentTermsDays: input.value.paymentTermsDays ?? null,
          notes: input.value.notes ?? null,
        }, actorOf(ctx));
        return { id: vendor.id, view: vendorView(vendor) };
      });
  });

  router.register('POST', '/api/finance/payables', async (ctx) => {
    const input = parsed(billSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const deps = await depsFor(requireTenant(ctx.auth, 'finance.bill.create'));
    return financeWrite(deps, ctx, 'finance.bill.create', 'FINANCE_BILL', input.value,
      async (tenant) => {
        const bill = await deps.service.createBill(tenant, {
          vendorId: input.value.vendorId,
          billReference: input.value.billReference,
          billDate: input.value.billDate,
          dueDate: input.value.dueDate ?? null,
          attribution: toAttribution(input.value.attribution),
          amount: paise(input.value.amountMinor, 'bill.amount'),
          tax: paise(input.value.taxMinor ?? 0, 'bill.tax'),
          description: input.value.description ?? null,
        }, actorOf(ctx));
        const withBalance = await deps.service.billWithBalance(tenant, bill.id);
        return { id: bill.id, view: billView(withBalance) };
      });
  });

  router.register('POST', '/api/finance/receivables', async (ctx) => {
    const input = parsed(receivableSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const deps = await depsFor(requireTenant(ctx.auth, 'finance.receivable.create'));
    return financeWrite(deps, ctx, 'finance.receivable.create', 'FINANCE_RECEIVABLE', input.value,
      async (tenant) => {
        const row = await deps.service.createReceivable(tenant, {
          counterparty: input.value.counterparty,
          bookingRef: input.value.bookingRef ?? null,
          reference: input.value.reference,
          issuedDate: input.value.issuedDate,
          dueDate: input.value.dueDate ?? null,
          attribution: toAttribution(input.value.attribution),
          amount: paise(input.value.amountMinor, 'receivable.amount'),
          tax: paise(input.value.taxMinor ?? 0, 'receivable.tax'),
          description: input.value.description ?? null,
        }, actorOf(ctx));
        const withBalance = await deps.service.receivableWithBalance(tenant, row.id);
        return { id: row.id, view: receivableView(withBalance) };
      });
  });

  router.register('POST', '/api/finance/payments', async (ctx) => {
    const input = parsed(paymentSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const deps = await depsFor(requireTenant(ctx.auth, 'finance.payment.create'));
    return financeWrite(deps, ctx, 'finance.payment.create', 'FINANCE_PAYMENT', input.value,
      async (tenant) => {
        const payment = await deps.service.createPayment(tenant, {
          direction: input.value.direction,
          amount: paise(input.value.amountMinor, 'payment.amount'),
          paidOn: input.value.paidOn,
          billId: input.value.billId ?? null,
          receivableId: input.value.receivableId ?? null,
          attribution: toAttribution(input.value.attribution),
          accountRef: input.value.accountRef ?? null,
          methodRef: input.value.methodRef ?? null,
          cashflowRef: input.value.cashflowRef ?? null,
          externalRef: input.value.externalRef ?? null,
          notes: input.value.notes ?? null,
        }, actorOf(ctx));
        return { id: payment.id, view: paymentView(payment) };
      });
  });

  for (const [suffix, next, action] of [
    ['submit', 'PENDING_APPROVAL', 'finance.payment.submit'],
    ['approve', 'APPROVED', 'finance.payment.approve'],
    ['post', 'POSTED', 'finance.payment.post'],
    ['void', 'VOIDED', 'finance.payment.void'],
  ] as const) {
    router.register('POST', `/api/finance/payments/:id/${suffix}`, async (ctx) => {
      const input = parsed(transitionSchema, ctx.request.body);
      if (!input.ok) return input.refusal;
      const id = ctx.request.params?.id ?? '';
      const deps = await depsFor(requireTenant(ctx.auth, action));
      return financeWrite(deps, ctx, action, 'FINANCE_PAYMENT', input.value, async (tenant) => {
        const payment = await deps.service.transitionPayment(tenant, id, next, actorOf(ctx));
        return { id: payment.id, view: paymentView(payment) };
      });
    });
  }

  router.register('POST', '/api/finance/periods/close', async (ctx) => {
    const input = parsed(closePeriodSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const deps = await depsFor(requireTenant(ctx.auth, 'finance.period.close'));
    return financeWrite(deps, ctx, 'finance.period.close', 'FINANCE_PERIOD', input.value,
      async (tenant) => {
        const period = await deps.service.closePeriod(tenant, input.value.periodStart, actorOf(ctx));
        return { id: period.periodStart, view: periodView(period) };
      });
  });

  router.register('POST', '/api/finance/periods/reopen', async (ctx) => {
    const input = parsed(reopenPeriodSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const deps = await depsFor(requireTenant(ctx.auth, 'finance.period.reopen'));
    return financeWrite(deps, ctx, 'finance.period.reopen', 'FINANCE_PERIOD', input.value,
      async (tenant) => {
        const period = await deps.service.reopenPeriod(
          tenant, input.value.periodStart, actorOf(ctx), input.value.reason,
        );
        return { id: period.periodStart, view: periodView(period) };
      });
  });
}

/** Who acted. From the authenticated context, never from the payload. */
function actorOf(ctx: HandlerContext): string {
  return ctx.auth.userId ?? 'unknown';
}

/**
 * A date window from the query string.
 *
 * Allow-listed and shape-checked: anything that is not a plain ISO date is dropped rather
 * than passed through to a repository filter.
 */
function rangeFrom(ctx: HandlerContext): { from?: string; to?: string } {
  const iso = (value: unknown): string | undefined =>
    (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
  const from = iso(ctx.request.query?.from);
  const to = iso(ctx.request.query?.to);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}
