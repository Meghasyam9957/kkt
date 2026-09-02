import '@/lib/server/only';
/**
 * HR PERSISTENCE — and why every method starts with a tenant.
 *
 * The same reasoning as `lib/server/finance/repository.ts`, and it applies harder here.
 * Every tenant's employees sit in ONE table, and the only thing between customer A and
 * customer B is a predicate somebody remembered to write. So it is not left to memory:
 * every method takes a `TenantContext` FIRST, and none has an overload that omits it. A
 * repository call that cannot say whose people it wants does not compile.
 *
 * HR adds a second axis finance does not have: **cross-EMPLOYEE** leakage inside one
 * tenant. A colleague's salary is not a colleague's business, and the day an employee
 * self-service role exists, "the caller's own record" becomes a scope in its own right.
 * That scope is not enforced here — it belongs in the service and the projection, where
 * the caller's identity is known — but the repository is shaped so it can be added without
 * reshaping anything: every read of a person's data takes an employee id explicitly.
 *
 * Two implementations, mirroring each other exactly. There is no local Postgres in this
 * project, no migration runner and no CI, so the in-memory twin is the only place these
 * semantics are ever executed, and the Supabase twin is verified by recording the query
 * chain it builds.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import type { Paise, CurrencyCode } from '@/lib/server/finance/money';
import { DEFAULT_CURRENCY } from '@/lib/server/finance/money';
import type {
  Department, Designation, Employee, Shift, Holiday, AttendanceRecord,
  LeaveType, LeaveEntitlement, LeaveRequest, OvertimeRecord, EmployeeAdvance,
  SalaryStructure, SalaryComponent, PayrollRun, PayrollLine,
  ApprovalStatus, AttendanceStatus, EmploymentStatus, EmploymentType, EntityStatus,
  ComponentKind, PayrollStatus,
} from './types';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface EmployeeInput {
  employeeCode: string;
  fullName: string;
  preferredName?: string | null;
  contactRef?: string | null;
  email?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
  employmentType?: EmploymentType;
  joiningDate: string;
  primaryPropertyId?: string | null;
  managerId?: string | null;
  weeklyOffDay?: number | null;
  notes?: string | null;
}

export interface AttendanceInput {
  employeeId: string;
  attendanceDate: string;
  shiftId?: string | null;
  propertyId?: string | null;
  status: AttendanceStatus;
  checkInAt?: string | null;
  checkOutAt?: string | null;
  late?: boolean;
  earlyExit?: boolean;
  overtimeMinutes?: number;
  source?: string;
  notes?: string | null;
}

export interface LeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  halfDays: number;
  reason?: string | null;
}

export interface OvertimeInput {
  employeeId: string;
  overtimeDate: string;
  minutes: number;
  propertyId?: string | null;
  reason: string;
  rateRef?: string | null;
}

export interface AdvanceInput {
  employeeId: string;
  issuedOn: string;
  amount: Paise;
  currency?: CurrencyCode;
  reason: string;
  notes?: string | null;
}

export interface SalaryComponentInput {
  code: string;
  kind: ComponentKind;
  amount: Paise;
}

export interface SalaryStructureInput {
  employeeId: string;
  effectiveFrom: string;
  currency?: CurrencyCode;
  notes?: string | null;
  components: readonly SalaryComponentInput[];
}

export interface PayrollLineInput {
  employeeId: string;
  structureId: string | null;
  gross: Paise;
  deductions: Paise;
  advanceRecovery: Paise;
  net: Paise;
  currency: CurrencyCode;
  payableDays: number;
  leaveDays: number;
  absentDays: number;
  unrecordedDays: number;
  overtimeMinutes: number;
  notes?: string | null;
}

export interface DateWindow { from?: string; to?: string }
export interface AttendanceFilter extends DateWindow {
  employeeId?: string;
  propertyId?: string;
  approval?: ApprovalStatus;
}
export interface LeaveFilter extends DateWindow {
  employeeId?: string;
  status?: ApprovalStatus;
}
export interface OvertimeFilter extends DateWindow {
  employeeId?: string;
  status?: ApprovalStatus;
}

/* ------------------------------------------------------------------ *
 * The interface
 * ------------------------------------------------------------------ */

export interface HrRepository {
  /* masters */
  createDepartment(t: TenantContext, name: string): Promise<Department>;
  listDepartments(t: TenantContext): Promise<Department[]>;
  createDesignation(t: TenantContext, name: string): Promise<Designation>;
  listDesignations(t: TenantContext): Promise<Designation[]>;
  createShift(t: TenantContext, input: Omit<Shift, 'id' | 'tenantId' | 'status'>): Promise<Shift>;
  listShifts(t: TenantContext): Promise<Shift[]>;
  getShift(t: TenantContext, id: string): Promise<Shift | null>;
  createHoliday(t: TenantContext, input: Omit<Holiday, 'id' | 'tenantId'>): Promise<Holiday>;
  listHolidays(t: TenantContext, window?: DateWindow): Promise<Holiday[]>;
  createLeaveType(t: TenantContext, input: { code: string; name: string; paid: boolean }): Promise<LeaveType>;
  listLeaveTypes(t: TenantContext): Promise<LeaveType[]>;
  getLeaveType(t: TenantContext, id: string): Promise<LeaveType | null>;

  /* employees */
  createEmployee(t: TenantContext, input: EmployeeInput, actor: string): Promise<Employee>;
  listEmployees(t: TenantContext, status?: EmploymentStatus): Promise<Employee[]>;
  getEmployee(t: TenantContext, id: string): Promise<Employee | null>;
  setEmployeeStatus(
    t: TenantContext, id: string, status: EmploymentStatus, exitDate: string | null,
  ): Promise<Employee | null>;

  /* attendance */
  recordAttendance(t: TenantContext, input: AttendanceInput, actor: string): Promise<AttendanceRecord>;
  listAttendance(t: TenantContext, filter?: AttendanceFilter): Promise<AttendanceRecord[]>;
  getAttendance(t: TenantContext, id: string): Promise<AttendanceRecord | null>;
  transitionAttendance(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<AttendanceRecord | null>;

  /* leave */
  createEntitlement(
    t: TenantContext, input: Omit<LeaveEntitlement, 'id' | 'tenantId'>,
  ): Promise<LeaveEntitlement>;
  listEntitlements(t: TenantContext, employeeId: string): Promise<LeaveEntitlement[]>;
  createLeaveRequest(t: TenantContext, input: LeaveRequestInput, actor: string): Promise<LeaveRequest>;
  listLeaveRequests(t: TenantContext, filter?: LeaveFilter): Promise<LeaveRequest[]>;
  getLeaveRequest(t: TenantContext, id: string): Promise<LeaveRequest | null>;
  transitionLeaveRequest(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string, note?: string,
  ): Promise<LeaveRequest | null>;

  /* overtime */
  createOvertime(t: TenantContext, input: OvertimeInput, actor: string): Promise<OvertimeRecord>;
  listOvertime(t: TenantContext, filter?: OvertimeFilter): Promise<OvertimeRecord[]>;
  getOvertime(t: TenantContext, id: string): Promise<OvertimeRecord | null>;
  transitionOvertime(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<OvertimeRecord | null>;

  /* advances */
  createAdvance(t: TenantContext, input: AdvanceInput, actor: string): Promise<EmployeeAdvance>;
  listAdvances(t: TenantContext, employeeId?: string): Promise<EmployeeAdvance[]>;
  getAdvance(t: TenantContext, id: string): Promise<EmployeeAdvance | null>;
  transitionAdvance(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<EmployeeAdvance | null>;

  /* salary */
  createSalaryStructure(
    t: TenantContext, input: SalaryStructureInput, actor: string,
  ): Promise<SalaryStructure>;
  listSalaryStructures(t: TenantContext, employeeId: string): Promise<SalaryStructure[]>;
  listSalaryComponents(t: TenantContext, structureId: string): Promise<SalaryComponent[]>;
  /** Close the open-ended structure so a new one can begin. */
  closeSalaryStructure(t: TenantContext, id: string, effectiveTo: string): Promise<SalaryStructure | null>;

  /* payroll */
  createPayrollRun(t: TenantContext, periodStart: string, actor: string): Promise<PayrollRun>;
  listPayrollRuns(t: TenantContext): Promise<PayrollRun[]>;
  getPayrollRun(t: TenantContext, id: string): Promise<PayrollRun | null>;
  getPayrollRunForPeriod(t: TenantContext, periodStart: string): Promise<PayrollRun | null>;
  transitionPayrollRun(
    t: TenantContext, id: string, next: PayrollStatus, actor: string,
  ): Promise<PayrollRun | null>;
  /** Replaces every line of the run. Calculation is idempotent by construction. */
  replacePayrollLines(
    t: TenantContext, runId: string, lines: readonly PayrollLineInput[],
  ): Promise<PayrollLine[]>;
  listPayrollLines(t: TenantContext, runId: string): Promise<PayrollLine[]>;
  getPayrollLine(t: TenantContext, id: string): Promise<PayrollLine | null>;
}

/* ------------------------------------------------------------------ *
 * In-memory implementation
 * ------------------------------------------------------------------ */

interface Row { tenantId: string }

/**
 * Everything in memory, and every read filtered by tenant exactly as the SQL is.
 *
 * The maps are keyed by ID, exactly as a table is — NOT by tenant. Keying by tenant would
 * make isolation automatic and therefore untested: the suite would prove that a Map is a
 * Map. Keyed by id, a mutation that removes the predicate FAILS here, which is the only
 * reason this double is worth having.
 */
export class InMemoryHrRepository implements HrRepository {
  private readonly departments = new Map<string, Department>();
  private readonly designations = new Map<string, Designation>();
  private readonly employees = new Map<string, Employee>();
  private readonly shifts = new Map<string, Shift>();
  private readonly holidays = new Map<string, Holiday>();
  private readonly attendance = new Map<string, AttendanceRecord>();
  private readonly leaveTypes = new Map<string, LeaveType>();
  private readonly entitlements = new Map<string, LeaveEntitlement>();
  private readonly leaveRequests = new Map<string, LeaveRequest>();
  private readonly overtime = new Map<string, OvertimeRecord>();
  private readonly advances = new Map<string, EmployeeAdvance>();
  private readonly structures = new Map<string, SalaryStructure>();
  private readonly components = new Map<string, SalaryComponent>();
  private readonly runs = new Map<string, PayrollRun>();
  private readonly lines = new Map<string, PayrollLine>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** THE predicate. Everything below reads through it; nothing reads around it. */
  private mine<T extends Row>(tenant: TenantContext, rows: Iterable<T>): T[] {
    const { tenantId } = requireTenant(tenant, 'HrRepository');
    return [...rows].filter((row) => row.tenantId === tenantId);
  }

  private oneOf<T extends Row & { id: string }>(
    tenant: TenantContext, map: Map<string, T>, id: string,
  ): T | null {
    const { tenantId } = requireTenant(tenant, 'HrRepository');
    const row = map.get(id);
    // A foreign id is a miss — the same answer as an id that never existed, so nothing is
    // enumerable by comparing refusals.
    return row && row.tenantId === tenantId ? row : null;
  }

  private stamp(): string { return this.now().toISOString(); }
  private tid(tenant: TenantContext, where: string): string {
    return requireTenant(tenant, where).tenantId;
  }

  /* ---- masters ---- */

  async createDepartment(t: TenantContext, name: string): Promise<Department> {
    const row: Department = Object.freeze({
      id: randomUUID(), tenantId: this.tid(t, 'createDepartment'),
      name: name.trim(), status: 'ACTIVE' as const,
    });
    this.departments.set(row.id, row);
    return row;
  }

  async listDepartments(t: TenantContext): Promise<Department[]> {
    return this.mine(t, this.departments.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async createDesignation(t: TenantContext, name: string): Promise<Designation> {
    const row: Designation = Object.freeze({
      id: randomUUID(), tenantId: this.tid(t, 'createDesignation'),
      name: name.trim(), status: 'ACTIVE' as const,
    });
    this.designations.set(row.id, row);
    return row;
  }

  async listDesignations(t: TenantContext): Promise<Designation[]> {
    return this.mine(t, this.designations.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async createShift(
    t: TenantContext, input: Omit<Shift, 'id' | 'tenantId' | 'status'>,
  ): Promise<Shift> {
    const row: Shift = Object.freeze({
      id: randomUUID(), tenantId: this.tid(t, 'createShift'), status: 'ACTIVE' as const, ...input,
    });
    this.shifts.set(row.id, row);
    return row;
  }

  async listShifts(t: TenantContext): Promise<Shift[]> {
    return this.mine(t, this.shifts.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  async getShift(t: TenantContext, id: string): Promise<Shift | null> {
    return this.oneOf(t, this.shifts, id);
  }

  async createHoliday(
    t: TenantContext, input: Omit<Holiday, 'id' | 'tenantId'>,
  ): Promise<Holiday> {
    const row: Holiday = Object.freeze({
      id: randomUUID(), tenantId: this.tid(t, 'createHoliday'), ...input,
    });
    this.holidays.set(row.id, row);
    return row;
  }

  async listHolidays(t: TenantContext, window: DateWindow = {}): Promise<Holiday[]> {
    return this.mine(t, this.holidays.values())
      .filter((h) => within(h.holidayDate, window))
      .sort((a, b) => a.holidayDate.localeCompare(b.holidayDate));
  }

  async createLeaveType(
    t: TenantContext, input: { code: string; name: string; paid: boolean },
  ): Promise<LeaveType> {
    const row: LeaveType = Object.freeze({
      id: randomUUID(), tenantId: this.tid(t, 'createLeaveType'),
      code: input.code.trim().toUpperCase(), name: input.name.trim(),
      paid: input.paid, status: 'ACTIVE' as const,
    });
    this.leaveTypes.set(row.id, row);
    return row;
  }

  async listLeaveTypes(t: TenantContext): Promise<LeaveType[]> {
    return this.mine(t, this.leaveTypes.values()).sort((a, b) => a.code.localeCompare(b.code));
  }

  async getLeaveType(t: TenantContext, id: string): Promise<LeaveType | null> {
    return this.oneOf(t, this.leaveTypes, id);
  }

  /* ---- employees ---- */

  async createEmployee(
    t: TenantContext, input: EmployeeInput, actor: string,
  ): Promise<Employee> {
    void actor;
    const row: Employee = Object.freeze({
      id: randomUUID(),
      tenantId: this.tid(t, 'createEmployee'),
      employeeCode: input.employeeCode.trim(),
      fullName: input.fullName.trim(),
      preferredName: input.preferredName?.trim() || null,
      contactRef: input.contactRef?.trim() || null,
      email: input.email?.trim() || null,
      departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null,
      employmentType: input.employmentType ?? 'FULL_TIME',
      joiningDate: input.joiningDate,
      confirmationDate: null,
      exitDate: null,
      status: 'ACTIVE' as const,
      primaryPropertyId: input.primaryPropertyId ?? null,
      managerId: input.managerId ?? null,
      weeklyOffDay: input.weeklyOffDay ?? null,
      notes: input.notes?.trim() || null,
      createdAt: this.stamp(),
    });
    this.employees.set(row.id, row);
    return row;
  }

  async listEmployees(t: TenantContext, status?: EmploymentStatus): Promise<Employee[]> {
    return this.mine(t, this.employees.values())
      .filter((e) => (status ? e.status === status : true))
      .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
  }

  async getEmployee(t: TenantContext, id: string): Promise<Employee | null> {
    return this.oneOf(t, this.employees, id);
  }

  async setEmployeeStatus(
    t: TenantContext, id: string, status: EmploymentStatus, exitDate: string | null,
  ): Promise<Employee | null> {
    const existing = this.oneOf(t, this.employees, id);
    if (!existing) return null;
    const updated: Employee = Object.freeze({ ...existing, status, exitDate });
    this.employees.set(id, updated);
    return updated;
  }

  /* ---- attendance ---- */

  async recordAttendance(
    t: TenantContext, input: AttendanceInput, actor: string,
  ): Promise<AttendanceRecord> {
    const row: AttendanceRecord = Object.freeze({
      id: randomUUID(),
      tenantId: this.tid(t, 'recordAttendance'),
      employeeId: input.employeeId,
      attendanceDate: input.attendanceDate,
      shiftId: input.shiftId ?? null,
      propertyId: input.propertyId ?? null,
      status: input.status,
      checkInAt: input.checkInAt ?? null,
      checkOutAt: input.checkOutAt ?? null,
      late: input.late ?? false,
      earlyExit: input.earlyExit ?? false,
      overtimeMinutes: input.overtimeMinutes ?? 0,
      source: input.source ?? 'MANUAL',
      notes: input.notes?.trim() || null,
      approval: 'DRAFT' as const,
      approvedBy: null,
      createdAt: this.stamp(),
    });
    void actor;
    this.attendance.set(row.id, row);
    return row;
  }

  async listAttendance(
    t: TenantContext, filter: AttendanceFilter = {},
  ): Promise<AttendanceRecord[]> {
    return this.mine(t, this.attendance.values())
      .filter((a) => (filter.employeeId ? a.employeeId === filter.employeeId : true))
      .filter((a) => (filter.propertyId ? a.propertyId === filter.propertyId : true))
      .filter((a) => (filter.approval ? a.approval === filter.approval : true))
      .filter((a) => within(a.attendanceDate, filter))
      .sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate));
  }

  async getAttendance(t: TenantContext, id: string): Promise<AttendanceRecord | null> {
    return this.oneOf(t, this.attendance, id);
  }

  async transitionAttendance(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<AttendanceRecord | null> {
    const existing = this.oneOf(t, this.attendance, id);
    if (!existing) return null;
    const updated: AttendanceRecord = Object.freeze({
      ...existing, approval: next,
      approvedBy: next === 'APPROVED' ? actor : existing.approvedBy,
    });
    this.attendance.set(id, updated);
    return updated;
  }

  /* ---- leave ---- */

  async createEntitlement(
    t: TenantContext, input: Omit<LeaveEntitlement, 'id' | 'tenantId'>,
  ): Promise<LeaveEntitlement> {
    const row: LeaveEntitlement = Object.freeze({
      id: randomUUID(), tenantId: this.tid(t, 'createEntitlement'), ...input,
    });
    this.entitlements.set(row.id, row);
    return row;
  }

  async listEntitlements(t: TenantContext, employeeId: string): Promise<LeaveEntitlement[]> {
    return this.mine(t, this.entitlements.values()).filter((e) => e.employeeId === employeeId);
  }

  async createLeaveRequest(
    t: TenantContext, input: LeaveRequestInput, actor: string,
  ): Promise<LeaveRequest> {
    const row: LeaveRequest = Object.freeze({
      id: randomUUID(),
      tenantId: this.tid(t, 'createLeaveRequest'),
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      halfDays: input.halfDays,
      reason: input.reason?.trim() || null,
      status: 'DRAFT' as const,
      requestedBy: actor,
      approvedBy: null,
      decisionNote: null,
      createdAt: this.stamp(),
    });
    this.leaveRequests.set(row.id, row);
    return row;
  }

  async listLeaveRequests(t: TenantContext, filter: LeaveFilter = {}): Promise<LeaveRequest[]> {
    return this.mine(t, this.leaveRequests.values())
      .filter((l) => (filter.employeeId ? l.employeeId === filter.employeeId : true))
      .filter((l) => (filter.status ? l.status === filter.status : true))
      .filter((l) => within(l.startDate, filter))
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
  }

  async getLeaveRequest(t: TenantContext, id: string): Promise<LeaveRequest | null> {
    return this.oneOf(t, this.leaveRequests, id);
  }

  async transitionLeaveRequest(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string, note?: string,
  ): Promise<LeaveRequest | null> {
    const existing = this.oneOf(t, this.leaveRequests, id);
    if (!existing) return null;
    const updated: LeaveRequest = Object.freeze({
      ...existing, status: next,
      approvedBy: next === 'APPROVED' ? actor : existing.approvedBy,
      decisionNote: note ?? existing.decisionNote,
    });
    this.leaveRequests.set(id, updated);
    return updated;
  }

  /* ---- overtime ---- */

  async createOvertime(
    t: TenantContext, input: OvertimeInput, actor: string,
  ): Promise<OvertimeRecord> {
    void actor;
    const row: OvertimeRecord = Object.freeze({
      id: randomUUID(),
      tenantId: this.tid(t, 'createOvertime'),
      employeeId: input.employeeId,
      overtimeDate: input.overtimeDate,
      minutes: input.minutes,
      propertyId: input.propertyId ?? null,
      reason: input.reason.trim(),
      rateRef: input.rateRef?.trim() || null,
      status: 'DRAFT' as const,
      approvedBy: null,
      createdAt: this.stamp(),
    });
    this.overtime.set(row.id, row);
    return row;
  }

  async listOvertime(t: TenantContext, filter: OvertimeFilter = {}): Promise<OvertimeRecord[]> {
    return this.mine(t, this.overtime.values())
      .filter((o) => (filter.employeeId ? o.employeeId === filter.employeeId : true))
      .filter((o) => (filter.status ? o.status === filter.status : true))
      .filter((o) => within(o.overtimeDate, filter))
      .sort((a, b) => b.overtimeDate.localeCompare(a.overtimeDate));
  }

  async getOvertime(t: TenantContext, id: string): Promise<OvertimeRecord | null> {
    return this.oneOf(t, this.overtime, id);
  }

  async transitionOvertime(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<OvertimeRecord | null> {
    const existing = this.oneOf(t, this.overtime, id);
    if (!existing) return null;
    const updated: OvertimeRecord = Object.freeze({
      ...existing, status: next,
      approvedBy: next === 'APPROVED' ? actor : existing.approvedBy,
    });
    this.overtime.set(id, updated);
    return updated;
  }

  /* ---- advances ---- */

  async createAdvance(
    t: TenantContext, input: AdvanceInput, actor: string,
  ): Promise<EmployeeAdvance> {
    void actor;
    const row: EmployeeAdvance = Object.freeze({
      id: randomUUID(),
      tenantId: this.tid(t, 'createAdvance'),
      employeeId: input.employeeId,
      issuedOn: input.issuedOn,
      amount: input.amount,
      currency: input.currency ?? DEFAULT_CURRENCY,
      reason: input.reason.trim(),
      notes: input.notes?.trim() || null,
      status: 'DRAFT' as const,
      approvedBy: null,
      createdAt: this.stamp(),
    });
    this.advances.set(row.id, row);
    return row;
  }

  async listAdvances(t: TenantContext, employeeId?: string): Promise<EmployeeAdvance[]> {
    return this.mine(t, this.advances.values())
      .filter((a) => (employeeId ? a.employeeId === employeeId : true))
      .sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
  }

  async getAdvance(t: TenantContext, id: string): Promise<EmployeeAdvance | null> {
    return this.oneOf(t, this.advances, id);
  }

  async transitionAdvance(
    t: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<EmployeeAdvance | null> {
    const existing = this.oneOf(t, this.advances, id);
    if (!existing) return null;
    const updated: EmployeeAdvance = Object.freeze({
      ...existing, status: next,
      approvedBy: next === 'APPROVED' ? actor : existing.approvedBy,
    });
    this.advances.set(id, updated);
    return updated;
  }

  /* ---- salary ---- */

  async createSalaryStructure(
    t: TenantContext, input: SalaryStructureInput, actor: string,
  ): Promise<SalaryStructure> {
    void actor;
    const tenantId = this.tid(t, 'createSalaryStructure');
    const structure: SalaryStructure = Object.freeze({
      id: randomUUID(),
      tenantId,
      employeeId: input.employeeId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      currency: input.currency ?? DEFAULT_CURRENCY,
      notes: input.notes?.trim() || null,
      createdAt: this.stamp(),
    });
    this.structures.set(structure.id, structure);
    for (const component of input.components) {
      const row: SalaryComponent = Object.freeze({
        id: randomUUID(), tenantId, structureId: structure.id,
        code: component.code.trim().toUpperCase(), kind: component.kind, amount: component.amount,
      });
      this.components.set(row.id, row);
    }
    return structure;
  }

  async listSalaryStructures(t: TenantContext, employeeId: string): Promise<SalaryStructure[]> {
    return this.mine(t, this.structures.values())
      .filter((s) => s.employeeId === employeeId)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  }

  async listSalaryComponents(t: TenantContext, structureId: string): Promise<SalaryComponent[]> {
    return this.mine(t, this.components.values()).filter((c) => c.structureId === structureId);
  }

  async closeSalaryStructure(
    t: TenantContext, id: string, effectiveTo: string,
  ): Promise<SalaryStructure | null> {
    const existing = this.oneOf(t, this.structures, id);
    if (!existing) return null;
    const updated: SalaryStructure = Object.freeze({ ...existing, effectiveTo });
    this.structures.set(id, updated);
    return updated;
  }

  /* ---- payroll ---- */

  async createPayrollRun(
    t: TenantContext, periodStart: string, actor: string,
  ): Promise<PayrollRun> {
    const row: PayrollRun = Object.freeze({
      id: randomUUID(),
      tenantId: this.tid(t, 'createPayrollRun'),
      periodStart,
      status: 'DRAFT' as const,
      notes: null,
      createdBy: actor,
      approvedBy: null,
      postedBy: null,
      postedAt: null,
      createdAt: this.stamp(),
    });
    this.runs.set(row.id, row);
    return row;
  }

  async listPayrollRuns(t: TenantContext): Promise<PayrollRun[]> {
    return this.mine(t, this.runs.values())
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  }

  async getPayrollRun(t: TenantContext, id: string): Promise<PayrollRun | null> {
    return this.oneOf(t, this.runs, id);
  }

  async getPayrollRunForPeriod(
    t: TenantContext, periodStart: string,
  ): Promise<PayrollRun | null> {
    return this.mine(t, this.runs.values()).find((r) => r.periodStart === periodStart) ?? null;
  }

  async transitionPayrollRun(
    t: TenantContext, id: string, next: PayrollStatus, actor: string,
  ): Promise<PayrollRun | null> {
    const existing = this.oneOf(t, this.runs, id);
    if (!existing) return null;
    const updated: PayrollRun = Object.freeze({
      ...existing,
      status: next,
      approvedBy: next === 'APPROVED' ? actor : existing.approvedBy,
      postedBy: next === 'POSTED' ? actor : existing.postedBy,
      postedAt: next === 'POSTED' ? this.stamp() : existing.postedAt,
    });
    this.runs.set(id, updated);
    return updated;
  }

  async replacePayrollLines(
    t: TenantContext, runId: string, lines: readonly PayrollLineInput[],
  ): Promise<PayrollLine[]> {
    const tenantId = this.tid(t, 'replacePayrollLines');
    // Recalculation replaces, so running it twice produces one set of lines rather than
    // two. The tenant predicate is applied to the delete as well as the insert.
    for (const [id, line] of [...this.lines.entries()]) {
      if (line.tenantId === tenantId && line.runId === runId) this.lines.delete(id);
    }
    const created: PayrollLine[] = [];
    for (const input of lines) {
      const row: PayrollLine = Object.freeze({
        id: randomUUID(), tenantId, runId, ...input, notes: input.notes ?? null,
      });
      this.lines.set(row.id, row);
      created.push(row);
    }
    return created;
  }

  async listPayrollLines(t: TenantContext, runId: string): Promise<PayrollLine[]> {
    return this.mine(t, this.lines.values()).filter((l) => l.runId === runId);
  }

  async getPayrollLine(t: TenantContext, id: string): Promise<PayrollLine | null> {
    return this.oneOf(t, this.lines, id);
  }
}

function within(date: string, window: DateWindow): boolean {
  if (window.from && date < window.from) return false;
  if (window.to && date > window.to) return false;
  return true;
}
