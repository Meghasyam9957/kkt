import '@/lib/server/only';
/**
 * OPERATIONS ↔ PEOPLE HANDLERS.
 *
 * The same five steps as the finance and HR handlers — tenant, validate, idempotency,
 * apply, project — with one difference worth naming: the write here touches TWO stores.
 * It writes the assignee's name into the tenant's workbook through the existing verified
 * mutation pipeline, and the employee reference into the overlay. The ordering and its
 * failure mode are reasoned about in `lib/server/operations/service.ts`; this file just
 * carries the envelope.
 *
 * WHAT NO HANDLER HERE DOES: touch attendance, or payroll, or create an expense. Assigning
 * work is not evidence somebody worked, completing a task is not either, and work having
 * been done is not the same claim as money having been spent.
 */
import { z } from 'zod';
import type { ApiRouter } from './router';
import { requireTenant, type TenantContext } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import { requestHashOf, type OperationStore } from '@/lib/server/ops/operation-store';
import type { HandlerContext } from '@/lib/server/auth/guard';
import type { OperationsPeopleService } from '@/lib/server/operations/service';
import { OperationsError, TASK_TYPES } from '@/lib/server/operations/types';
import {
  staffingView, assignmentView, metricsView,
} from '@/lib/server/operations/projections';
import { safeReason } from '@/lib/server/audit/reason';

export interface OperationsHandlerDeps {
  service: OperationsPeopleService;
  store: OperationStore;
  audit: AuditService;
  writesPermitted: boolean;
}

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const assignSchema = z.object({
  operationId: z.string().uuid('an operation id is a uuid'),
  taskType: z.enum(TASK_TYPES),
  /** The workbook's own TaskID or TicketID. */
  taskRef: z.string().min(1).max(60),
  employeeId: z.string().uuid(),
  /**
   * Required when the employee is on leave, on their weekly off, or working their notice.
   * The service refuses without it rather than assigning silently.
   */
  overrideReason: z.string().min(3).max(500).optional(),
}).strict();

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

function fromOperationsError(error: unknown): Refusal {
  if (error instanceof OperationsError) {
    return refusal(error.httpStatus, error.code, error.message);
  }
  // A refusal raised by the HR or workbook layer beneath — a period lock, a contract
  // violation — is a real answer and keeps its own status.
  if (error instanceof Error && (error.name === 'HrError' || error.name === 'MutationError')) {
    const status = (error as { httpStatus?: number; status?: number }).httpStatus
      ?? (error as { status?: number }).status ?? 422;
    const code = (error as { code?: string }).code ?? 'REFUSED';
    return refusal(status, code, error.message);
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

export function registerOperationsHandlers(
  router: ApiRouter,
  depsFor: (tenant: TenantContext) => Promise<OperationsHandlerDeps>,
): void {
  const svc = async (ctx: HandlerContext, where: string) => {
    const tenant = requireTenant(ctx.auth, where);
    return { tenant, deps: await depsFor(tenant) };
  };

  /** A property named in the query is validated against the caller's own workbook. */
  const propertyFrom = (ctx: HandlerContext): string | undefined => {
    const value = ctx.request.query?.property;
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  router.register('GET', '/api/operations/staffing', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'operations.staffing');
    const raw = ctx.request.query?.date;
    const date = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : new Date().toISOString().slice(0, 10);
    try {
      return staffingView(await deps.service.staffingBoard(tenant, date, propertyFrom(ctx)));
    } catch (error) {
      return fromOperationsError(error);
    }
  });

  router.register('GET', '/api/operations/assignments', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'operations.assignments');
    const taskType = ctx.request.query?.taskType;
    const taskRef = ctx.request.query?.taskRef;

    // One task's history, when both are named; otherwise the current board.
    if (typeof taskType === 'string' && typeof taskRef === 'string'
      && (TASK_TYPES as readonly string[]).includes(taskType) && taskRef !== '') {
      try {
        const history = await deps.service.historyFor(tenant, taskType as never, taskRef);
        return history.map(assignmentView);
      } catch (error) {
        return fromOperationsError(error);
      }
    }

    const filter = {
      ...(typeof taskType === 'string' && (TASK_TYPES as readonly string[]).includes(taskType)
        ? { taskType: taskType as never } : {}),
      ...(propertyFrom(ctx) ? { propertyId: propertyFrom(ctx) } : {}),
    };
    const rows = await deps.service.list(tenant, filter);
    return Promise.all(rows.map(async (row) => assignmentView(
      await deps.service.currentFor(tenant, row.taskType, row.taskRef) ?? {
        assignment: row, employeeCode: null, displayName: null,
        employeeStatus: null, sheetDiverged: false, sheetName: null,
      },
    )));
  });

  router.register('GET', '/api/operations/metrics', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'operations.metrics');
    return metricsView(await deps.service.operationsMetrics(tenant, propertyFrom(ctx)));
  });

  router.register('POST', '/api/operations/assignments', async (ctx) => {
    const input = parsed(assignSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'operations.task.assign');

    if (!deps.writesPermitted) {
      return refusal(403, 'WRITES_DISABLED',
        'Operational writes are not enabled in this environment. Reads are unaffected.');
    }

    const tenant = requireTenant(ctx.auth, 'operations.task.assign');
    const actor = ctx.auth.userId ?? 'unknown';
    const requestHash = requestHashOf({
      action: 'operations.task.assign', entityId: input.value.taskRef, input: input.value,
    });

    const begun = await deps.store.begin({
      operationId: input.value.operationId,
      tenantId: tenant.tenantId,
      actorId: ctx.auth.userId ?? null,
      actorRole: ctx.auth.role,
      action: 'operations.task.assign',
      requestHash,
    });

    if (begun.outcome === 'verified') return begun.result as unknown;
    if (begun.outcome === 'in-flight') {
      return refusal(409, 'OPERATION_IN_FLIGHT',
        `Operation ${input.value.operationId} is already being applied.`);
    }
    if (begun.outcome === 'failed') {
      return refusal(409, 'OPERATION_FAILED_BEFORE',
        `Operation ${input.value.operationId} already failed (${begun.error ?? 'no reason recorded'}).`);
    }
    if (begun.outcome === 'mismatch') {
      return refusal(409, 'OPERATION_MISMATCH',
        `Operation ${input.value.operationId} was first submitted with a different payload. `
        + 'An operation id identifies one intent; mint a new id for a new intent.');
    }

    try {
      await deps.store.markApplying(input.value.operationId);
      const result = await deps.service.assign(tenant, {
        taskType: input.value.taskType,
        taskRef: input.value.taskRef,
        employeeId: input.value.employeeId,
        overrideReason: input.value.overrideReason ?? null,
      }, actor, { auth: ctx.auth, requestId: ctx.request.requestId ?? 'ops-assign' });

      const view = {
        ...assignmentView({
          assignment: result.assignment,
          employeeCode: null,
          displayName: result.nameToWrite,
          employeeStatus: null,
          sheetDiverged: false,
          sheetName: result.nameToWrite,
        }),
        /** Surfaced so the interface can confirm what was overridden, not bury it. */
        warnings: result.warnings,
      };

      await deps.store.complete(
        input.value.operationId, { type: 'OPS_ASSIGNMENT', id: result.assignment.id }, view,
      );
      await deps.audit.record({
        actor: ctx.auth,
        action: 'operations.task.assign.applied',
        entityType: 'OPS_ASSIGNMENT',
        entityId: result.assignment.id,
        result: 'ALLOW',
        requestId: ctx.request.requestId,
        /*
         * The operation, the task and whether an eligibility warning was overridden — and
         * no employee NAME. `redactMetadata` strips known PII keys, but a name placed under
         * an unknown key would survive it, and an audit trail that lists who was put on
         * which turnover is a staff-movement record nobody asked for. The employee id is
         * on the record itself, which is tenant-scoped and capability-gated.
         */
        metadata: {
          operationId: input.value.operationId,
          taskType: input.value.taskType,
          taskRef: input.value.taskRef,
          overridden: result.warnings.length > 0,
        },
      });
      return view;
    } catch (error) {
      // Persisted and browser-reachable; see lib/server/audit/reason.ts.
      const reason = safeReason(error);
      await deps.store.fail(
        input.value.operationId, { type: 'OPS_ASSIGNMENT', id: '' }, reason,
      );
      await deps.audit.record({
        actor: ctx.auth, action: 'operations.task.assign', entityType: 'OPS_ASSIGNMENT',
        result: 'ERROR', reason, requestId: ctx.request.requestId,
        metadata: { operationId: input.value.operationId },
      });
      return fromOperationsError(error);
    }
  });
}
