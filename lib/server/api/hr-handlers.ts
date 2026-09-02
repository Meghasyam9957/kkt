import '@/lib/server/only';
/**
 * HR HANDLERS — the HTTP edge of the people domain.
 *
 * The same five steps as the finance handlers, in the same order:
 *
 *   1. TENANT       `requireTenant(ctx.auth, …)` — from the guard's authenticated context
 *                   and nowhere else. No branch reads a tenant from the request.
 *   2. VALIDATE     zod, `.strict()`, so an unrecognised key is a 422 rather than an
 *                   ignored field. A `tenantId` or `employeeId` smuggled into a body it
 *                   does not belong in is refused BY NAME.
 *   3. IDEMPOTENCY  the same tenant-aware operation store the workbook and finance writes
 *                   use. A retried advance does not become two advances, and an operation
 *                   id from another tenant is a mismatch rather than a replay.
 *   4. APPLY        the service, which owns every rule.
 *   5. PROJECT      a role-safe view model. No database row reaches a client, and the
 *                   compensation projections are reachable only from compensation routes.
 *
 * MONEY CROSSES AS MINOR UNITS. `amountMinor: 250000` is ₹2,500.00 exactly.
 *
 * AUDIT CARRIES THE OPERATION AND THE ENTITY AND NOTHING ELSE. That rule matters more here
 * than anywhere: an HR payload contains salary figures and a person's name, and
 * `redactMetadata` does not strip numbers. A copy of a payroll payload in the audit log
 * would put pay in a table `audit.read` reaches.
 */
import { z } from 'zod';
import type { ApiRouter } from './router';
import { requireTenant, type TenantContext } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import { requestHashOf, type OperationStore } from '@/lib/server/ops/operation-store';
import type { HandlerContext } from '@/lib/server/auth/guard';
import type { HrService } from '@/lib/server/hr/service';
import { HrError } from '@/lib/server/hr/types';
import { paise } from '@/lib/server/finance/money';
import {
  employeeView, attendanceView, leaveRequestView, overtimeView, shiftView,
  advanceView, advanceBalanceView, salaryStructureView, payrollRunView, payrollLineView,
  workforceView, departmentView, designationView,
} from '@/lib/server/hr/projections';
import { safeReason } from '@/lib/server/audit/reason';

export interface HrHandlerDeps {
  service: HrService;
  store: OperationStore;
  audit: AuditService;
  writesPermitted: boolean;
}

/* ------------------------------------------------------------------ *
 * Input shapes
 * ------------------------------------------------------------------ */

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const MONTH_START = z.string().regex(/^\d{4}-\d{2}-01$/, 'a period is named by its first day');
const MINOR = z.number().int('amounts are whole paise').positive('an amount must be positive');
const operationId = z.string().uuid('an operation id is a uuid');
const UUID = z.string().uuid();

const namedSchema = z.object({ operationId, name: z.string().min(1).max(120) }).strict();

const shiftSchema = z.object({
  operationId,
  name: z.string().min(1).max(80),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  crossesMidnight: z.boolean(),
  graceMinutes: z.number().int().min(0).max(240).optional(),
}).strict();

const leaveTypeSchema = z.object({
  operationId, code: z.string().min(1).max(20), name: z.string().min(1).max(80),
  paid: z.boolean(),
}).strict();

const employeeSchema = z.object({
  operationId,
  employeeCode: z.string().min(1).max(40).optional(),
  fullName: z.string().min(1).max(160),
  preferredName: z.string().max(80).optional(),
  contactRef: z.string().max(120).optional(),
  email: z.string().email().max(160).optional(),
  departmentId: UUID.optional(),
  designationId: UUID.optional(),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'CASUAL']).optional(),
  joiningDate: ISO_DATE,
  primaryPropertyId: z.string().max(40).optional(),
  managerId: UUID.optional(),
  weeklyOffDay: z.number().int().min(0).max(6).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const statusSchema = z.object({
  operationId,
  status: z.enum(['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'NOTICE_PERIOD', 'EXITED']),
  exitDate: ISO_DATE.optional(),
}).strict();

const attendanceSchema = z.object({
  operationId,
  employeeId: UUID,
  attendanceDate: ISO_DATE,
  shiftId: UUID.optional(),
  propertyId: z.string().max(40).optional(),
  status: z.enum(['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF']),
  checkInAt: z.string().datetime().optional(),
  checkOutAt: z.string().datetime().optional(),
  late: z.boolean().optional(),
  earlyExit: z.boolean().optional(),
  overtimeMinutes: z.number().int().min(0).max(1440).optional(),
  notes: z.string().max(1000).optional(),
}).strict();

const leaveSchema = z.object({
  operationId,
  employeeId: UUID,
  leaveTypeId: UUID,
  startDate: ISO_DATE,
  endDate: ISO_DATE,
  halfDays: z.number().int().positive(),
  reason: z.string().max(1000).optional(),
}).strict();

const overtimeSchema = z.object({
  operationId,
  employeeId: UUID,
  overtimeDate: ISO_DATE,
  minutes: z.number().int().positive().max(1440),
  propertyId: z.string().max(40).optional(),
  reason: z.string().min(1).max(500),
  rateRef: z.string().max(60).optional(),
}).strict();

const advanceSchema = z.object({
  operationId,
  employeeId: UUID,
  issuedOn: ISO_DATE,
  amountMinor: MINOR,
  reason: z.string().min(1).max(500),
  notes: z.string().max(1000).optional(),
}).strict();

const salarySchema = z.object({
  operationId,
  employeeId: UUID,
  effectiveFrom: ISO_DATE,
  notes: z.string().max(1000).optional(),
  components: z.array(z.object({
    code: z.string().min(1).max(40),
    kind: z.enum(['EARNING', 'DEDUCTION']),
    amountMinor: MINOR,
  }).strict()).min(1),
}).strict();

const openPayrollSchema = z.object({ operationId, periodStart: MONTH_START }).strict();

const calculateSchema = z.object({
  operationId,
  recoveries: z.array(z.object({
    employeeId: UUID, amountMinor: z.number().int().min(0),
  }).strict()).optional(),
}).strict();

const approvePayrollSchema = z.object({
  operationId,
  /**
   * Approving a run whose period has days nobody recorded requires saying so, and the
   * acknowledgement is carried into the audit trail — a silent omission becomes a
   * deliberate, attributable act.
   */
  acknowledgeGaps: z.boolean().optional(),
}).strict();

const transitionSchema = z.object({ operationId }).strict();
const rejectSchema = z.object({ operationId, note: z.string().min(3).max(500) }).strict();

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

function fromHrError(error: unknown): Refusal {
  if (error instanceof HrError) return refusal(error.httpStatus, error.code, error.message);
  if (error instanceof Error && error.name === 'MoneyError') {
    return refusal(422, 'MONEY', error.message);
  }
  if (error instanceof Error && error.name === 'FinanceError') {
    // A period lock refusal arrives from the finance service; it is a real answer.
    return refusal(409, 'PERIOD_CLOSED', error.message);
  }
  throw error;
}

async function hrWrite<T>(
  deps: HrHandlerDeps,
  ctx: HandlerContext,
  action: string,
  entityType: string,
  body: { operationId: string } & Record<string, unknown>,
  apply: (tenant: TenantContext) => Promise<{ id: string; view: T }>,
): Promise<T | Refusal> {
  if (!deps.writesPermitted) {
    return refusal(403, 'WRITES_DISABLED',
      'HR writes are not enabled in this environment. Reads are unaffected.');
  }

  const tenant = requireTenant(ctx.auth, `hr:${action}`);
  const requestHash = requestHashOf({
    action, entityId: ctx.request.params?.id ?? null, input: body,
  });

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
    return refusal(409, 'OPERATION_IN_FLIGHT',
      `Operation ${body.operationId} is already being applied.`);
  }
  if (begun.outcome === 'failed') {
    return refusal(409, 'OPERATION_FAILED_BEFORE',
      `Operation ${body.operationId} already failed (${begun.error ?? 'no reason recorded'}).`);
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
       * THE OPERATION AND THE ENTITY, AND NOTHING ELSE — and here that is not merely
       * tidy. `redactMetadata` strips known PII keys but leaves numbers untouched, so a
       * payroll payload copied into the audit trail would put salary figures in a table
       * every `audit.read` holder can query. What happened is recoverable from the record
       * itself, which is tenant-scoped and capability-gated; a second copy is a second
       * place to leak it from.
       */
      metadata: { operationId: body.operationId },
    });
    return view;
  } catch (error) {
    // See finance-handlers: this string is persisted and browser-reachable.
    const reason = safeReason(error);
    await deps.store.fail(body.operationId, { type: entityType, id: '' }, reason);
    await deps.audit.record({
      actor: ctx.auth, action, entityType, result: 'ERROR', reason,
      requestId: ctx.request.requestId, metadata: { operationId: body.operationId },
    });
    return fromHrError(error);
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

function windowFrom(ctx: HandlerContext): { from?: string; to?: string } {
  const iso = (value: unknown): string | undefined =>
    (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
  const from = iso(ctx.request.query?.from);
  const to = iso(ctx.request.query?.to);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function employeeFilter(ctx: HandlerContext): { employeeId?: string } {
  const value = ctx.request.query?.employeeId;
  return typeof value === 'string' && value ? { employeeId: value } : {};
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export function registerHrHandlers(
  router: ApiRouter,
  depsFor: (tenant: TenantContext) => Promise<HrHandlerDeps>,
): void {
  const svc = async (ctx: HandlerContext, where: string) => {
    const tenant = requireTenant(ctx.auth, where);
    return { tenant, deps: await depsFor(tenant) };
  };

  /* ---- people reads ---- */

  router.register('GET', '/api/hr/overview', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.overview');
    const period = typeof ctx.request.query?.period === 'string'
      && /^\d{4}-\d{2}-01$/.test(ctx.request.query.period)
      ? ctx.request.query.period
      : `${new Date().toISOString().slice(0, 7)}-01`;
    const summary = await deps.service.workforceSummary(tenant, period);
    /*
     * The money halves are BUILT ONLY for a caller who may see compensation — not built
     * and then hidden. A payload carrying a figure the client is told not to render has
     * already disclosed it.
     */
    return workforceView(summary, {
      includeCompensation: ctx.auth.role === 'SUPER_ADMIN' || ctx.auth.role === 'ADMIN',
    });
  });

  router.register('GET', '/api/hr/employees', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.employees');
    return (await deps.service.listEmployees(tenant)).map(employeeView);
  });

  router.register('GET', '/api/hr/attendance', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.attendance');
    return (await deps.service.listAttendance(tenant, {
      ...windowFrom(ctx), ...employeeFilter(ctx),
    })).map(attendanceView);
  });

  router.register('GET', '/api/hr/leave', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.leave');
    return (await deps.service.listLeaveRequests(tenant, {
      ...windowFrom(ctx), ...employeeFilter(ctx),
    })).map(leaveRequestView);
  });

  router.register('GET', '/api/hr/overtime', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.overtime');
    return (await deps.service.listOvertime(tenant, {
      ...windowFrom(ctx), ...employeeFilter(ctx),
    })).map(overtimeView);
  });

  router.register('GET', '/api/hr/shifts', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.shifts');
    return (await deps.service.listShifts(tenant)).map(shiftView);
  });

  /* ---- compensation reads ---- */

  router.register('GET', '/api/hr/salary', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.salary');
    const employeeId = ctx.request.query?.employeeId;
    if (typeof employeeId !== 'string' || !employeeId) {
      return refusal(422, 'VALIDATION', 'Name the employee whose salary history to read.');
    }
    const structures = await deps.service.listSalaryStructures(tenant, employeeId);
    const detailed = await Promise.all(structures.map(
      (s) => deps.service.salaryEffectiveOn(tenant, employeeId, s.effectiveFrom),
    ));
    return detailed.filter(Boolean).map((s) => salaryStructureView(s!));
  });

  router.register('GET', '/api/hr/advances', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.advances');
    const employeeId = ctx.request.query?.employeeId;
    if (typeof employeeId === 'string' && employeeId) {
      const balance = await deps.service.advanceBalanceFor(tenant, employeeId);
      return {
        balance: advanceBalanceView(balance),
        advances: balance.advances.map(advanceView),
      };
    }
    return { balance: null, advances: (await deps.service.listAdvances(tenant)).map(advanceView) };
  });

  router.register('GET', '/api/hr/payroll', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.payroll');
    return (await deps.service.listPayrollRuns(tenant)).map(payrollRunView);
  });

  router.register('GET', '/api/hr/payroll/:id', async (ctx) => {
    const { tenant, deps } = await svc(ctx, 'hr.payrollRun');
    const id = ctx.request.params?.id ?? '';
    const runs = await deps.service.listPayrollRuns(tenant);
    const run = runs.find((r) => r.id === id);
    // Tenant-scoped list, so another tenant's run id is simply absent — the same answer
    // as a run that never existed.
    if (!run) return refusal(404, 'NOT_FOUND', 'No such payroll run.');
    return {
      run: payrollRunView(run),
      lines: (await deps.service.listPayrollLines(tenant, id)).map(payrollLineView),
    };
  });

  /* ---- master data ---- */

  router.register('POST', '/api/hr/departments', async (ctx) => {
    const input = parsed(namedSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.department.create');
    return hrWrite(deps, ctx, 'hr.department.create', 'HR_DEPARTMENT', input.value,
      async (tenant) => {
        const row = await deps.service.createDepartment(tenant, input.value.name);
        return { id: row.id, view: departmentView(row) };
      });
  });

  router.register('POST', '/api/hr/designations', async (ctx) => {
    const input = parsed(namedSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.designation.create');
    return hrWrite(deps, ctx, 'hr.designation.create', 'HR_DESIGNATION', input.value,
      async (tenant) => {
        const row = await deps.service.createDesignation(tenant, input.value.name);
        return { id: row.id, view: designationView(row) };
      });
  });

  router.register('POST', '/api/hr/shifts', async (ctx) => {
    const input = parsed(shiftSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.shift.create');
    return hrWrite(deps, ctx, 'hr.shift.create', 'HR_SHIFT', input.value, async (tenant) => {
      const row = await deps.service.createShift(tenant, {
        name: input.value.name,
        startTime: input.value.startTime,
        endTime: input.value.endTime,
        crossesMidnight: input.value.crossesMidnight,
        graceMinutes: input.value.graceMinutes ?? 0,
      });
      return { id: row.id, view: shiftView(row) };
    });
  });

  router.register('POST', '/api/hr/leave-types', async (ctx) => {
    const input = parsed(leaveTypeSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.leaveType.create');
    return hrWrite(deps, ctx, 'hr.leaveType.create', 'HR_LEAVE_TYPE', input.value,
      async (tenant) => {
        const row = await deps.service.createLeaveType(tenant, input.value);
        return { id: row.id, view: { id: row.id, code: row.code, name: row.name, paid: row.paid } };
      });
  });

  /* ---- people writes ---- */

  router.register('POST', '/api/hr/employees', async (ctx) => {
    const input = parsed(employeeSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.employee.create');
    return hrWrite(deps, ctx, 'hr.employee.create', 'HR_EMPLOYEE', input.value,
      async (tenant) => {
        const employee = await deps.service.createEmployee(tenant, {
          employeeCode: input.value.employeeCode,
          fullName: input.value.fullName,
          preferredName: input.value.preferredName ?? null,
          contactRef: input.value.contactRef ?? null,
          email: input.value.email ?? null,
          departmentId: input.value.departmentId ?? null,
          designationId: input.value.designationId ?? null,
          employmentType: input.value.employmentType,
          joiningDate: input.value.joiningDate,
          primaryPropertyId: input.value.primaryPropertyId ?? null,
          managerId: input.value.managerId ?? null,
          weeklyOffDay: input.value.weeklyOffDay ?? null,
          notes: input.value.notes ?? null,
        }, actorOf(ctx));
        return { id: employee.id, view: employeeView(employee) };
      });
  });

  router.register('POST', '/api/hr/employees/:id/status', async (ctx) => {
    const input = parsed(statusSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    const { deps } = await svc(ctx, 'hr.employee.status');
    return hrWrite(deps, ctx, 'hr.employee.status', 'HR_EMPLOYEE', input.value,
      async (tenant) => {
        const employee = await deps.service.setEmployeeStatus(
          tenant, id, input.value.status, input.value.exitDate ?? null,
        );
        return { id: employee.id, view: employeeView(employee) };
      });
  });

  router.register('POST', '/api/hr/attendance', async (ctx) => {
    const input = parsed(attendanceSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.attendance.record');
    return hrWrite(deps, ctx, 'hr.attendance.record', 'HR_ATTENDANCE', input.value,
      async (tenant) => {
        const record = await deps.service.recordAttendance(tenant, {
          employeeId: input.value.employeeId,
          attendanceDate: input.value.attendanceDate,
          shiftId: input.value.shiftId ?? null,
          propertyId: input.value.propertyId ?? null,
          status: input.value.status,
          checkInAt: input.value.checkInAt ?? null,
          checkOutAt: input.value.checkOutAt ?? null,
          late: input.value.late ?? false,
          earlyExit: input.value.earlyExit ?? false,
          overtimeMinutes: input.value.overtimeMinutes ?? 0,
          notes: input.value.notes ?? null,
        }, actorOf(ctx));
        return { id: record.id, view: attendanceView(record) };
      });
  });

  registerTransition(router, '/api/hr/attendance/:id/submit', 'hr.attendance.submit',
    'HR_ATTENDANCE', 'SUBMITTED', svc, (s, t, id, next, actor) =>
      s.transitionAttendance(t, id, next, actor).then(attendanceView));
  registerTransition(router, '/api/hr/attendance/:id/approve', 'hr.attendance.approve',
    'HR_ATTENDANCE', 'APPROVED', svc, (s, t, id, next, actor) =>
      s.transitionAttendance(t, id, next, actor).then(attendanceView));

  router.register('POST', '/api/hr/leave', async (ctx) => {
    const input = parsed(leaveSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.leave.request');
    return hrWrite(deps, ctx, 'hr.leave.request', 'HR_LEAVE', input.value, async (tenant) => {
      const request = await deps.service.createLeaveRequest(tenant, {
        employeeId: input.value.employeeId,
        leaveTypeId: input.value.leaveTypeId,
        startDate: input.value.startDate,
        endDate: input.value.endDate,
        halfDays: input.value.halfDays,
        reason: input.value.reason ?? null,
      }, actorOf(ctx));
      return { id: request.id, view: leaveRequestView(request) };
    });
  });

  registerTransition(router, '/api/hr/leave/:id/submit', 'hr.leave.submit',
    'HR_LEAVE', 'SUBMITTED', svc, (s, t, id, next, actor) =>
      s.transitionLeaveRequest(t, id, next, actor).then(leaveRequestView));
  registerTransition(router, '/api/hr/leave/:id/approve', 'hr.leave.approve',
    'HR_LEAVE', 'APPROVED', svc, (s, t, id, next, actor) =>
      s.transitionLeaveRequest(t, id, next, actor).then(leaveRequestView));

  router.register('POST', '/api/hr/leave/:id/reject', async (ctx) => {
    const input = parsed(rejectSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    const { deps } = await svc(ctx, 'hr.leave.reject');
    return hrWrite(deps, ctx, 'hr.leave.reject', 'HR_LEAVE', input.value, async (tenant) => {
      const request = await deps.service.transitionLeaveRequest(
        tenant, id, 'REJECTED', actorOf(ctx), input.value.note,
      );
      return { id: request.id, view: leaveRequestView(request) };
    });
  });

  router.register('POST', '/api/hr/overtime', async (ctx) => {
    const input = parsed(overtimeSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.overtime.record');
    return hrWrite(deps, ctx, 'hr.overtime.record', 'HR_OVERTIME', input.value,
      async (tenant) => {
        const record = await deps.service.createOvertime(tenant, {
          employeeId: input.value.employeeId,
          overtimeDate: input.value.overtimeDate,
          minutes: input.value.minutes,
          propertyId: input.value.propertyId ?? null,
          reason: input.value.reason,
          rateRef: input.value.rateRef ?? null,
        }, actorOf(ctx));
        return { id: record.id, view: overtimeView(record) };
      });
  });

  registerTransition(router, '/api/hr/overtime/:id/submit', 'hr.overtime.submit',
    'HR_OVERTIME', 'SUBMITTED', svc, (s, t, id, next, actor) =>
      s.transitionOvertime(t, id, next, actor).then(overtimeView));
  registerTransition(router, '/api/hr/overtime/:id/approve', 'hr.overtime.approve',
    'HR_OVERTIME', 'APPROVED', svc, (s, t, id, next, actor) =>
      s.transitionOvertime(t, id, next, actor).then(overtimeView));

  /* ---- compensation writes ---- */

  router.register('POST', '/api/hr/salary', async (ctx) => {
    const input = parsed(salarySchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.salary.create');
    return hrWrite(deps, ctx, 'hr.salary.create', 'HR_SALARY', input.value, async (tenant) => {
      const structure = await deps.service.createSalaryStructure(tenant, {
        employeeId: input.value.employeeId,
        effectiveFrom: input.value.effectiveFrom,
        notes: input.value.notes ?? null,
        components: input.value.components.map((c) => ({
          code: c.code, kind: c.kind, amount: paise(c.amountMinor, 'component'),
        })),
      }, actorOf(ctx));
      const detailed = await deps.service.salaryEffectiveOn(
        tenant, input.value.employeeId, input.value.effectiveFrom,
      );
      return { id: structure.id, view: salaryStructureView(detailed!) };
    });
  });

  router.register('POST', '/api/hr/advances', async (ctx) => {
    const input = parsed(advanceSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.advance.create');
    return hrWrite(deps, ctx, 'hr.advance.create', 'HR_ADVANCE', input.value, async (tenant) => {
      const advance = await deps.service.createAdvance(tenant, {
        employeeId: input.value.employeeId,
        issuedOn: input.value.issuedOn,
        amount: paise(input.value.amountMinor, 'advance'),
        reason: input.value.reason,
        notes: input.value.notes ?? null,
      }, actorOf(ctx));
      return { id: advance.id, view: advanceView(advance) };
    });
  });

  registerTransition(router, '/api/hr/advances/:id/submit', 'hr.advance.submit',
    'HR_ADVANCE', 'SUBMITTED', svc, (s, t, id, next, actor) =>
      s.transitionAdvance(t, id, next, actor).then(advanceView));
  registerTransition(router, '/api/hr/advances/:id/approve', 'hr.advance.approve',
    'HR_ADVANCE', 'APPROVED', svc, (s, t, id, next, actor) =>
      s.transitionAdvance(t, id, next, actor).then(advanceView));

  router.register('POST', '/api/hr/payroll', async (ctx) => {
    const input = parsed(openPayrollSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const { deps } = await svc(ctx, 'hr.payroll.open');
    return hrWrite(deps, ctx, 'hr.payroll.open', 'HR_PAYROLL', input.value, async (tenant) => {
      const run = await deps.service.openPayrollRun(tenant, input.value.periodStart, actorOf(ctx));
      return { id: run.id, view: payrollRunView(run) };
    });
  });

  router.register('POST', '/api/hr/payroll/:id/calculate', async (ctx) => {
    const input = parsed(calculateSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    const { deps } = await svc(ctx, 'hr.payroll.calculate');
    return hrWrite(deps, ctx, 'hr.payroll.calculate', 'HR_PAYROLL', input.value,
      async (tenant) => {
        const lines = await deps.service.calculatePayroll(tenant, id, {
          recoveries: input.value.recoveries,
        });
        return { id, view: { runId: id, lines: lines.map(payrollLineView) } };
      });
  });

  router.register('POST', '/api/hr/payroll/:id/approve', async (ctx) => {
    const input = parsed(approvePayrollSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    const { deps } = await svc(ctx, 'hr.payroll.approve');
    return hrWrite(deps, ctx, 'hr.payroll.approve', 'HR_PAYROLL', input.value,
      async (tenant) => {
        const run = await deps.service.transitionPayrollRun(
          tenant, id, 'APPROVED', actorOf(ctx),
          { acknowledgeGaps: input.value.acknowledgeGaps ?? false },
        );
        return { id: run.id, view: payrollRunView(run) };
      });
  });

  router.register('POST', '/api/hr/payroll/:id/post', async (ctx) => {
    const input = parsed(transitionSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    const { deps } = await svc(ctx, 'hr.payroll.post');
    return hrWrite(deps, ctx, 'hr.payroll.post', 'HR_PAYROLL', input.value, async (tenant) => {
      const run = await deps.service.transitionPayrollRun(tenant, id, 'POSTED', actorOf(ctx));
      return { id: run.id, view: payrollRunView(run) };
    });
  });
}

/** Every approval transition is the same five lines; written once. */
function registerTransition(
  router: ApiRouter,
  path: string,
  action: string,
  entityType: string,
  next: 'SUBMITTED' | 'APPROVED',
  svc: (ctx: HandlerContext, where: string) => Promise<{ tenant: TenantContext; deps: HrHandlerDeps }>,
  apply: (
    service: HrService, tenant: TenantContext, id: string,
    next: 'SUBMITTED' | 'APPROVED', actor: string,
  ) => Promise<unknown>,
): void {
  router.register('POST', path, async (ctx) => {
    const input = parsed(transitionSchema, ctx.request.body);
    if (!input.ok) return input.refusal;
    const id = ctx.request.params?.id ?? '';
    const { deps } = await svc(ctx, action);
    return hrWrite(deps, ctx, action, entityType, input.value, async (tenant) => ({
      id,
      view: await apply(deps.service, tenant, id, next, actorOf(ctx)),
    }));
  });
}

/** Who acted. From the authenticated context, never from the payload. */
function actorOf(ctx: HandlerContext): string {
  return ctx.auth.userId ?? 'unknown';
}
