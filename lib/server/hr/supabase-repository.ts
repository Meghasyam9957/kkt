import '@/lib/server/only';
/**
 * THE POSTGRES HR REPOSITORY — and why it is this boring.
 *
 * Same shape and same reasoning as `lib/server/finance/supabase-repository.ts`, for the
 * same reason: nothing in this project runs Postgres, so the only way to catch a lost
 * `.eq('tenant_id', …)` is to record the chain this file builds. That defect has already
 * shipped once here — `SupabaseAuditSink` dropped `tenant_id` from its insert while the
 * in-memory twin carried it and the whole suite stayed green.
 *
 *   1. NO LOGIC HERE. Every rule — approvals, period locks, payroll arithmetic, property
 *      validation — lives in `service.ts`, which the suite actually runs.
 *   2. ONE PLACE BUILDS A QUERY. `scoped`, `insertRow` and `updateRow` are the only ways
 *      this class touches the database, and all three apply the tenant themselves.
 *   3. THE CHAIN IS ASSERTABLE. `tests/hr-isolation.test.ts` replaces the client with a
 *      recorder and asserts the filter chain of every read and the column list of every
 *      insert.
 */
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import { paiseFromDatabase, DEFAULT_CURRENCY, type CurrencyCode } from '@/lib/server/finance/money';
import type {
  HrRepository, EmployeeInput, AttendanceInput, LeaveRequestInput, OvertimeInput,
  AdvanceInput, SalaryStructureInput, AttendanceFilter, LeaveFilter, OvertimeFilter,
  DateWindow, PayrollLineInput,
} from './repository';
import type {
  Department, Designation, Employee, Shift, Holiday, AttendanceRecord, LeaveType,
  LeaveEntitlement, LeaveRequest, OvertimeRecord, EmployeeAdvance, SalaryStructure,
  SalaryComponent, PayrollRun, PayrollLine, ApprovalStatus, EmploymentStatus, PayrollStatus,
} from './types';

const DEPARTMENTS = 'hr_departments';
const DESIGNATIONS = 'hr_designations';
const EMPLOYEES = 'hr_employees';
const SHIFTS = 'hr_shifts';
const HOLIDAYS = 'hr_holidays';
const ATTENDANCE = 'hr_attendance';
const LEAVE_TYPES = 'hr_leave_types';
const ENTITLEMENTS = 'hr_leave_entitlements';
const LEAVE_REQUESTS = 'hr_leave_requests';
const OVERTIME = 'hr_overtime';
const ADVANCES = 'hr_employee_advances';
const STRUCTURES = 'hr_salary_structures';
const COMPONENTS = 'hr_salary_components';
const RUNS = 'hr_payroll_runs';
const LINES = 'hr_payroll_lines';

export class SupabaseHrRepository implements HrRepository {
  constructor(private readonly client: any) {}

  /** EVERY read starts here, so every read carries the tenant before a caller adds anything. */
  private scoped(table: string, tenant: TenantContext): any {
    const { tenantId } = requireTenant(tenant, `SupabaseHrRepository.${table}`);
    return this.client.from(table).select('*').eq('tenant_id', tenantId);
  }

  /** EVERY write starts here, and the tenant is stamped from the context, never the input. */
  private async insertRow(
    table: string, tenant: TenantContext, row: Record<string, unknown>,
  ): Promise<any> {
    const { tenantId } = requireTenant(tenant, `SupabaseHrRepository.${table}`);
    const { data, error } = await this.client
      .from(table)
      // `tenant_id` LAST, so a caller-supplied one is overwritten rather than honoured.
      .insert({ ...row, tenant_id: tenantId })
      .select('*')
      .single();
    if (error) throw new Error(String(error.message ?? `${table} insert failed`));
    return data;
  }

  private async updateRow(
    table: string, tenant: TenantContext, id: string, patch: Record<string, unknown>,
  ): Promise<any | null> {
    const { tenantId } = requireTenant(tenant, `SupabaseHrRepository.${table}`);
    const { data, error } = await this.client
      .from(table)
      // Six tables in this schema carry no `updated_at`. Stamping one unconditionally made
      // every update to those tables fail against a real database with "column
      // updated_at does not exist" — invisible until M-INFRA-1 ran the migrations, because
      // the recorder harness asserts the query CHAIN and never meets a schema.
      .update(WITHOUT_UPDATED_AT.has(table)
        ? { ...patch }
        : { ...patch, updated_at: new Date().toISOString() })
      // Both predicates, always. `id` alone updates another tenant's row the moment an
      // identifier leaks.
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(String(error.message ?? `${table} update failed`));
    return data ?? null;
  }

  private static rows(result: { data: unknown; error: unknown }): any[] {
    if (result.error) {
      throw new Error(String((result.error as { message?: string }).message ?? 'query failed'));
    }
    return (result.data ?? []) as any[];
  }

  private async one(table: string, tenant: TenantContext, id: string): Promise<any | null> {
    const { data, error } = await this.scoped(table, tenant).eq('id', id).maybeSingle();
    if (error) throw new Error(String(error.message ?? `${table} read failed`));
    return data ?? null;
  }

  /* ---- masters ---- */

  async createDepartment(t: TenantContext, name: string): Promise<Department> {
    return toNamed(await this.insertRow(DEPARTMENTS, t, { name: name.trim() })) as Department;
  }

  async listDepartments(t: TenantContext): Promise<Department[]> {
    return SupabaseHrRepository.rows(await this.scoped(DEPARTMENTS, t).order('name'))
      .map(toNamed) as Department[];
  }

  async createDesignation(t: TenantContext, name: string): Promise<Designation> {
    return toNamed(await this.insertRow(DESIGNATIONS, t, { name: name.trim() })) as Designation;
  }

  async listDesignations(t: TenantContext): Promise<Designation[]> {
    return SupabaseHrRepository.rows(await this.scoped(DESIGNATIONS, t).order('name'))
      .map(toNamed) as Designation[];
  }

  async createShift(
    t: TenantContext, input: Omit<Shift, 'id' | 'tenantId' | 'status'>,
  ): Promise<Shift> {
    return toShift(await this.insertRow(SHIFTS, t, {
      name: input.name.trim(), start_time: input.startTime, end_time: input.endTime,
      crosses_midnight: input.crossesMidnight, grace_minutes: input.graceMinutes,
    }));
  }

  async listShifts(t: TenantContext): Promise<Shift[]> {
    return SupabaseHrRepository.rows(await this.scoped(SHIFTS, t).order('start_time')).map(toShift);
  }

  async getShift(t: TenantContext, id: string): Promise<Shift | null> {
    const row = await this.one(SHIFTS, t, id);
    return row ? toShift(row) : null;
  }

  async createHoliday(
    t: TenantContext, input: Omit<Holiday, 'id' | 'tenantId'>,
  ): Promise<Holiday> {
    return toHoliday(await this.insertRow(HOLIDAYS, t, {
      holiday_date: input.holidayDate, name: input.name.trim(), property_id: input.propertyId,
    }));
  }

  async listHolidays(t: TenantContext, window: DateWindow = {}): Promise<Holiday[]> {
    let query = this.scoped(HOLIDAYS, t);
    if (window.from) query = query.gte('holiday_date', window.from);
    if (window.to) query = query.lte('holiday_date', window.to);
    return SupabaseHrRepository.rows(await query.order('holiday_date')).map(toHoliday);
  }

  async createLeaveType(
    t: TenantContext, input: { code: string; name: string; paid: boolean },
  ): Promise<LeaveType> {
    return toLeaveType(await this.insertRow(LEAVE_TYPES, t, {
      code: input.code.trim().toUpperCase(), name: input.name.trim(), paid: input.paid,
    }));
  }

  async listLeaveTypes(t: TenantContext): Promise<LeaveType[]> {
    return SupabaseHrRepository.rows(await this.scoped(LEAVE_TYPES, t).order('code'))
      .map(toLeaveType);
  }

  async getLeaveType(t: TenantContext, id: string): Promise<LeaveType | null> {
    const row = await this.one(LEAVE_TYPES, t, id);
    return row ? toLeaveType(row) : null;
  }

  /* ---- employees ---- */

  async createEmployee(
    t: TenantContext, input: EmployeeInput, actor: string,
  ): Promise<Employee> {
    return toEmployee(await this.insertRow(EMPLOYEES, t, {
      employee_code: input.employeeCode.trim(),
      full_name: input.fullName.trim(),
      preferred_name: input.preferredName?.trim() || null,
      contact_ref: input.contactRef?.trim() || null,
      email: input.email?.trim() || null,
      department_id: input.departmentId ?? null,
      designation_id: input.designationId ?? null,
      employment_type: input.employmentType ?? 'FULL_TIME',
      joining_date: input.joiningDate,
      primary_property_id: input.primaryPropertyId ?? null,
      manager_id: input.managerId ?? null,
      weekly_off_day: input.weeklyOffDay ?? null,
      notes: input.notes?.trim() || null,
      created_by: actor,
    }));
  }

  async listEmployees(t: TenantContext, status?: EmploymentStatus): Promise<Employee[]> {
    let query = this.scoped(EMPLOYEES, t);
    if (status) query = query.eq('status', status);
    return SupabaseHrRepository.rows(await query.order('employee_code')).map(toEmployee);
  }

  async getEmployee(t: TenantContext, id: string): Promise<Employee | null> {
    const row = await this.one(EMPLOYEES, t, id);
    return row ? toEmployee(row) : null;
  }

  async setEmployeeStatus(
    t: TenantContext, id: string, status: EmploymentStatus, exitDate: string | null,
  ): Promise<Employee | null> {
    const row = await this.updateRow(EMPLOYEES, t, id, { status, exit_date: exitDate });
    return row ? toEmployee(row) : null;
  }

  /* ---- attendance ---- */

  async recordAttendance(
    t: TenantContext, input: AttendanceInput, actor: string,
  ): Promise<AttendanceRecord> {
    return toAttendance(await this.insertRow(ATTENDANCE, t, {
      employee_id: input.employeeId,
      attendance_date: input.attendanceDate,
      shift_id: input.shiftId ?? null,
      property_id: input.propertyId ?? null,
      status: input.status,
      check_in_at: input.checkInAt ?? null,
      check_out_at: input.checkOutAt ?? null,
      late: input.late ?? false,
      early_exit: input.earlyExit ?? false,
      overtime_minutes: input.overtimeMinutes ?? 0,
      source: input.source ?? 'MANUAL',
      notes: input.notes?.trim() || null,
      created_by: actor,
    }));
  }

  async listAttendance(
    t: TenantContext, filter: AttendanceFilter = {},
  ): Promise<AttendanceRecord[]> {
    let query = this.scoped(ATTENDANCE, t);
    if (filter.employeeId) query = query.eq('employee_id', filter.employeeId);
    if (filter.propertyId) query = query.eq('property_id', filter.propertyId);
    if (filter.approval) query = query.eq('approval', filter.approval);
    if (filter.from) query = query.gte('attendance_date', filter.from);
    if (filter.to) query = query.lte('attendance_date', filter.to);
    return SupabaseHrRepository.rows(
      await query.order('attendance_date', { ascending: false }),
    ).map(toAttendance);
  }

  async getAttendance(t: TenantContext, id: string): Promise<AttendanceRecord | null> {
    const row = await this.one(ATTENDANCE, t, id);
    return row ? toAttendance(row) : null;
  }

  async transitionAttendance(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<AttendanceRecord | null> {
    const row = await this.updateRow(ATTENDANCE, t, id, attendanceApprovalPatch(next, actor));
    return row ? toAttendance(row) : null;
  }

  /* ---- leave ---- */

  async createEntitlement(
    t: TenantContext, input: Omit<LeaveEntitlement, 'id' | 'tenantId'>,
  ): Promise<LeaveEntitlement> {
    return toEntitlement(await this.insertRow(ENTITLEMENTS, t, {
      employee_id: input.employeeId, leave_type_id: input.leaveTypeId,
      year_start: input.yearStart, allocated_half_days: input.allocatedHalfDays,
    }));
  }

  async listEntitlements(t: TenantContext, employeeId: string): Promise<LeaveEntitlement[]> {
    return SupabaseHrRepository.rows(
      await this.scoped(ENTITLEMENTS, t).eq('employee_id', employeeId),
    ).map(toEntitlement);
  }

  async createLeaveRequest(
    t: TenantContext, input: LeaveRequestInput, actor: string,
  ): Promise<LeaveRequest> {
    return toLeaveRequest(await this.insertRow(LEAVE_REQUESTS, t, {
      employee_id: input.employeeId, leave_type_id: input.leaveTypeId,
      start_date: input.startDate, end_date: input.endDate, half_days: input.halfDays,
      reason: input.reason?.trim() || null, requested_by: actor,
    }));
  }

  async listLeaveRequests(t: TenantContext, filter: LeaveFilter = {}): Promise<LeaveRequest[]> {
    let query = this.scoped(LEAVE_REQUESTS, t);
    if (filter.employeeId) query = query.eq('employee_id', filter.employeeId);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.from) query = query.gte('start_date', filter.from);
    if (filter.to) query = query.lte('start_date', filter.to);
    return SupabaseHrRepository.rows(
      await query.order('start_date', { ascending: false }),
    ).map(toLeaveRequest);
  }

  async getLeaveRequest(t: TenantContext, id: string): Promise<LeaveRequest | null> {
    const row = await this.one(LEAVE_REQUESTS, t, id);
    return row ? toLeaveRequest(row) : null;
  }

  async transitionLeaveRequest(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string, note?: string,
  ): Promise<LeaveRequest | null> {
    const row = await this.updateRow(LEAVE_REQUESTS, t, id, {
      ...approvalPatch(next, actor),
      ...(note !== undefined ? { decision_note: note } : {}),
    });
    return row ? toLeaveRequest(row) : null;
  }

  /* ---- overtime ---- */

  async createOvertime(
    t: TenantContext, input: OvertimeInput, actor: string,
  ): Promise<OvertimeRecord> {
    return toOvertime(await this.insertRow(OVERTIME, t, {
      employee_id: input.employeeId, overtime_date: input.overtimeDate, minutes: input.minutes,
      property_id: input.propertyId ?? null, reason: input.reason.trim(),
      rate_ref: input.rateRef?.trim() || null, created_by: actor,
    }));
  }

  async listOvertime(t: TenantContext, filter: OvertimeFilter = {}): Promise<OvertimeRecord[]> {
    let query = this.scoped(OVERTIME, t);
    if (filter.employeeId) query = query.eq('employee_id', filter.employeeId);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.from) query = query.gte('overtime_date', filter.from);
    if (filter.to) query = query.lte('overtime_date', filter.to);
    return SupabaseHrRepository.rows(
      await query.order('overtime_date', { ascending: false }),
    ).map(toOvertime);
  }

  async getOvertime(t: TenantContext, id: string): Promise<OvertimeRecord | null> {
    const row = await this.one(OVERTIME, t, id);
    return row ? toOvertime(row) : null;
  }

  async transitionOvertime(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<OvertimeRecord | null> {
    const row = await this.updateRow(OVERTIME, t, id, approvalPatch(next, actor));
    return row ? toOvertime(row) : null;
  }

  /* ---- advances ---- */

  async createAdvance(
    t: TenantContext, input: AdvanceInput, actor: string,
  ): Promise<EmployeeAdvance> {
    return toAdvance(await this.insertRow(ADVANCES, t, {
      employee_id: input.employeeId, issued_on: input.issuedOn,
      amount_minor: input.amount, currency: input.currency ?? DEFAULT_CURRENCY,
      reason: input.reason.trim(), notes: input.notes?.trim() || null, created_by: actor,
    }));
  }

  async listAdvances(t: TenantContext, employeeId?: string): Promise<EmployeeAdvance[]> {
    let query = this.scoped(ADVANCES, t);
    if (employeeId) query = query.eq('employee_id', employeeId);
    return SupabaseHrRepository.rows(
      await query.order('issued_on', { ascending: false }),
    ).map(toAdvance);
  }

  async getAdvance(t: TenantContext, id: string): Promise<EmployeeAdvance | null> {
    const row = await this.one(ADVANCES, t, id);
    return row ? toAdvance(row) : null;
  }

  async transitionAdvance(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<EmployeeAdvance | null> {
    const row = await this.updateRow(ADVANCES, t, id, approvalPatch(next, actor));
    return row ? toAdvance(row) : null;
  }

  /* ---- salary ---- */

  async createSalaryStructure(
    t: TenantContext, input: SalaryStructureInput, actor: string,
  ): Promise<SalaryStructure> {
    const { tenantId } = requireTenant(t, 'createSalaryStructure');
    const structure = toStructure(await this.insertRow(STRUCTURES, t, {
      employee_id: input.employeeId, effective_from: input.effectiveFrom,
      currency: input.currency ?? DEFAULT_CURRENCY, notes: input.notes?.trim() || null,
      created_by: actor,
    }));
    if (input.components.length > 0) {
      const { error } = await this.client.from(COMPONENTS).insert(
        input.components.map((c) => ({
          tenant_id: tenantId, structure_id: structure.id,
          code: c.code.trim().toUpperCase(), kind: c.kind, amount_minor: c.amount,
        })),
      );
      if (error) throw new Error(String(error.message ?? 'salary components insert failed'));
    }
    return structure;
  }

  async listSalaryStructures(t: TenantContext, employeeId: string): Promise<SalaryStructure[]> {
    return SupabaseHrRepository.rows(
      await this.scoped(STRUCTURES, t).eq('employee_id', employeeId)
        .order('effective_from', { ascending: false }),
    ).map(toStructure);
  }

  async listSalaryComponents(t: TenantContext, structureId: string): Promise<SalaryComponent[]> {
    return SupabaseHrRepository.rows(
      await this.scoped(COMPONENTS, t).eq('structure_id', structureId),
    ).map(toComponent);
  }

  async closeSalaryStructure(
    t: TenantContext, id: string, effectiveTo: string,
  ): Promise<SalaryStructure | null> {
    const row = await this.updateRow(STRUCTURES, t, id, { effective_to: effectiveTo });
    return row ? toStructure(row) : null;
  }

  /* ---- payroll ---- */

  async createPayrollRun(
    t: TenantContext, periodStart: string, actor: string,
  ): Promise<PayrollRun> {
    return toRun(await this.insertRow(RUNS, t, {
      period_start: periodStart, created_by: actor,
    }));
  }

  async listPayrollRuns(t: TenantContext): Promise<PayrollRun[]> {
    return SupabaseHrRepository.rows(
      await this.scoped(RUNS, t).order('period_start', { ascending: false }),
    ).map(toRun);
  }

  async getPayrollRun(t: TenantContext, id: string): Promise<PayrollRun | null> {
    const row = await this.one(RUNS, t, id);
    return row ? toRun(row) : null;
  }

  async getPayrollRunForPeriod(
    t: TenantContext, periodStart: string,
  ): Promise<PayrollRun | null> {
    const { data, error } = await this.scoped(RUNS, t)
      .eq('period_start', periodStart).maybeSingle();
    if (error) throw new Error(String(error.message ?? 'payroll run read failed'));
    return data ? toRun(data) : null;
  }

  async transitionPayrollRun(
    t: TenantContext, id: string, next: PayrollStatus, actor: string,
  ): Promise<PayrollRun | null> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: next };
    if (next === 'CALCULATED') patch.calculated_at = now;
    if (next === 'APPROVED') { patch.approved_by = actor; patch.approved_at = now; }
    if (next === 'POSTED') { patch.posted_by = actor; patch.posted_at = now; }
    const row = await this.updateRow(RUNS, t, id, patch);
    return row ? toRun(row) : null;
  }

  async replacePayrollLines(
    t: TenantContext, runId: string, lines: readonly PayrollLineInput[],
  ): Promise<PayrollLine[]> {
    const { tenantId } = requireTenant(t, 'replacePayrollLines');
    // Both predicates on the delete as well as the insert: a recalculation must not be
    // able to clear another tenant's lines even if a run id were guessed.
    const { error: deleteError } = await this.client
      .from(LINES).delete().eq('tenant_id', tenantId).eq('run_id', runId);
    if (deleteError) throw new Error(String(deleteError.message ?? 'payroll lines clear failed'));
    if (lines.length === 0) return [];

    const { data, error } = await this.client.from(LINES).insert(
      lines.map((l) => ({
        tenant_id: tenantId, run_id: runId, employee_id: l.employeeId,
        structure_id: l.structureId, gross_minor: l.gross, deductions_minor: l.deductions,
        advance_recovery_minor: l.advanceRecovery, net_minor: l.net, currency: l.currency,
        payable_days: l.payableDays, leave_days: l.leaveDays, absent_days: l.absentDays,
        unrecorded_days: l.unrecordedDays, overtime_minutes: l.overtimeMinutes,
        notes: l.notes ?? null,
      })),
    ).select('*');
    if (error) throw new Error(String(error.message ?? 'payroll lines insert failed'));
    return (data ?? []).map(toLine);
  }

  async listPayrollLines(t: TenantContext, runId: string): Promise<PayrollLine[]> {
    return SupabaseHrRepository.rows(
      await this.scoped(LINES, t).eq('run_id', runId),
    ).map(toLine);
  }

  async getPayrollLine(t: TenantContext, id: string): Promise<PayrollLine | null> {
    const row = await this.one(LINES, t, id);
    return row ? toLine(row) : null;
  }
}

/* ------------------------------------------------------------------ *
 * Row → domain
 * ------------------------------------------------------------------ */

/**
 * Tables with no `updated_at` column.
 *
 * Written down here because `updateRow` has to know, and verified against the real schema
 * by tests/infrastructure/repository-schema.test.ts so this list cannot quietly drift away
 * from the migrations it describes.
 */
export const WITHOUT_UPDATED_AT: ReadonlySet<string> = new Set([
  'hr_holidays', 'hr_leave_types', 'hr_payroll_lines',
  'hr_salary_components', 'hr_salary_structures',
]);

/**
 * Leave, overtime and advances keep their approval in a column literally named `status`,
 * typed `hr_approval_status`. For those this is right.
 */
function approvalPatch(next: ApprovalStatus, actor: string): Record<string, unknown> {
  const now = new Date().toISOString();
  const key = next === 'APPROVED' ? { approved_by: actor, approved_at: now } : {};
  return { status: next, ...key };
}

/**
 * Attendance is the exception, and the reason is deliberate in the schema: an attendance
 * row has TWO independent facts. `status` is what happened that day (PRESENT, ABSENT,
 * HALF_DAY, LEAVE, HOLIDAY, WEEKLY_OFF) and `approval` is whether a supervisor has signed
 * it off (DRAFT, SUBMITTED, APPROVED, REJECTED). Migration 0007 separates them precisely so
 * that payroll consumes only approved facts without the approval overwriting the fact.
 *
 * Writing the approval into `status` therefore does not merely misfile it — 'APPROVED' is
 * not a value `hr_attendance_status` has, so the write is rejected outright and no
 * attendance can ever be approved. Which is what happened until M-INFRA-1.
 */
function attendanceApprovalPatch(
  next: ApprovalStatus, actor: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const key = next === 'APPROVED' ? { approved_by: actor, approved_at: now } : {};
  return { approval: next, ...key };
}

function toNamed(row: any): Department | Designation {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    name: String(row.name), status: row.status,
  });
}

function toShift(row: any): Shift {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name),
    startTime: String(row.start_time), endTime: String(row.end_time),
    crossesMidnight: Boolean(row.crosses_midnight),
    graceMinutes: Number(row.grace_minutes ?? 0), status: row.status,
  });
}

function toHoliday(row: any): Holiday {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    holidayDate: String(row.holiday_date), name: String(row.name),
    propertyId: row.property_id ?? null,
  });
}

function toLeaveType(row: any): LeaveType {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id), code: String(row.code),
    name: String(row.name), paid: Boolean(row.paid), status: row.status,
  });
}

function toEmployee(row: any): Employee {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    employeeCode: String(row.employee_code),
    fullName: String(row.full_name),
    preferredName: row.preferred_name ?? null,
    contactRef: row.contact_ref ?? null,
    email: row.email ?? null,
    departmentId: row.department_id ?? null,
    designationId: row.designation_id ?? null,
    employmentType: row.employment_type,
    joiningDate: String(row.joining_date),
    confirmationDate: row.confirmation_date ?? null,
    exitDate: row.exit_date ?? null,
    status: row.status,
    primaryPropertyId: row.primary_property_id ?? null,
    managerId: row.manager_id ?? null,
    weeklyOffDay: row.weekly_off_day === null || row.weekly_off_day === undefined
      ? null : Number(row.weekly_off_day),
    notes: row.notes ?? null,
    createdAt: String(row.created_at),
  });
}

function toAttendance(row: any): AttendanceRecord {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    employeeId: String(row.employee_id),
    attendanceDate: String(row.attendance_date),
    shiftId: row.shift_id ?? null,
    propertyId: row.property_id ?? null,
    status: row.status,
    checkInAt: row.check_in_at ?? null,
    checkOutAt: row.check_out_at ?? null,
    late: Boolean(row.late),
    earlyExit: Boolean(row.early_exit),
    overtimeMinutes: Number(row.overtime_minutes ?? 0),
    source: String(row.source ?? 'MANUAL'),
    notes: row.notes ?? null,
    approval: row.approval,
    approvedBy: row.approved_by ?? null,
    createdAt: String(row.created_at),
  });
}

function toEntitlement(row: any): LeaveEntitlement {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    employeeId: String(row.employee_id), leaveTypeId: String(row.leave_type_id),
    yearStart: String(row.year_start), allocatedHalfDays: Number(row.allocated_half_days),
  });
}

function toLeaveRequest(row: any): LeaveRequest {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    employeeId: String(row.employee_id), leaveTypeId: String(row.leave_type_id),
    startDate: String(row.start_date), endDate: String(row.end_date),
    halfDays: Number(row.half_days), reason: row.reason ?? null,
    status: row.status, requestedBy: row.requested_by ?? null,
    approvedBy: row.approved_by ?? null, decisionNote: row.decision_note ?? null,
    createdAt: String(row.created_at),
  });
}

function toOvertime(row: any): OvertimeRecord {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    employeeId: String(row.employee_id), overtimeDate: String(row.overtime_date),
    minutes: Number(row.minutes), propertyId: row.property_id ?? null,
    reason: String(row.reason), rateRef: row.rate_ref ?? null,
    status: row.status, approvedBy: row.approved_by ?? null,
    createdAt: String(row.created_at),
  });
}

function toAdvance(row: any): EmployeeAdvance {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    employeeId: String(row.employee_id), issuedOn: String(row.issued_on),
    amount: paiseFromDatabase(row.amount_minor, 'advance.amount'),
    currency: (row.currency ?? DEFAULT_CURRENCY) as CurrencyCode,
    reason: String(row.reason), notes: row.notes ?? null,
    status: row.status, approvedBy: row.approved_by ?? null,
    createdAt: String(row.created_at),
  });
}

function toStructure(row: any): SalaryStructure {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    employeeId: String(row.employee_id), effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ?? null,
    currency: (row.currency ?? DEFAULT_CURRENCY) as CurrencyCode,
    notes: row.notes ?? null, createdAt: String(row.created_at),
  });
}

function toComponent(row: any): SalaryComponent {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    structureId: String(row.structure_id), code: String(row.code), kind: row.kind,
    amount: paiseFromDatabase(row.amount_minor, 'component.amount'),
  });
}

function toRun(row: any): PayrollRun {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id),
    periodStart: String(row.period_start), status: row.status, notes: row.notes ?? null,
    createdBy: row.created_by ?? null, approvedBy: row.approved_by ?? null,
    postedBy: row.posted_by ?? null, postedAt: row.posted_at ?? null,
    createdAt: String(row.created_at),
  });
}

function toLine(row: any): PayrollLine {
  return Object.freeze({
    id: String(row.id), tenantId: String(row.tenant_id), runId: String(row.run_id),
    employeeId: String(row.employee_id), structureId: row.structure_id ?? null,
    gross: paiseFromDatabase(row.gross_minor, 'line.gross'),
    deductions: paiseFromDatabase(row.deductions_minor ?? 0, 'line.deductions'),
    advanceRecovery: paiseFromDatabase(row.advance_recovery_minor ?? 0, 'line.recovery'),
    net: paiseFromDatabase(row.net_minor, 'line.net'),
    currency: (row.currency ?? DEFAULT_CURRENCY) as CurrencyCode,
    payableDays: Number(row.payable_days ?? 0),
    leaveDays: Number(row.leave_days ?? 0),
    absentDays: Number(row.absent_days ?? 0),
    unrecordedDays: Number(row.unrecorded_days ?? 0),
    overtimeMinutes: Number(row.overtime_minutes ?? 0),
    notes: row.notes ?? null,
  });
}
