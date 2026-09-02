import '@/lib/server/only';
/**
 * HR RULES — the layer a test can actually execute.
 *
 * Nothing in this project runs Postgres: no local database, no migration runner, no CI. A
 * rule expressed in SQL is a rule nothing verifies, so every rule that matters lives here,
 * in front of both repository implementations. The database's constraints are defence in
 * depth and are written as such; this is the boundary.
 *
 * THE PAYROLL ENGINE IS THE POINT OF THIS FILE, and what it refuses to do matters more
 * than what it does. It will not invent a loss-of-pay basis, an overtime multiplier, a
 * statutory deduction or an advance recovery schedule — every one of those is an unstated
 * policy, and a plausible wrong number on a payslip is worse than a missing one. What it
 * does instead is compute exactly what the recorded facts support, refuse to calculate
 * when the facts are incomplete, and record the gaps it found.
 *
 * ONE PERIOD LOCK. `finance_periods` governs payroll too, reached through the injected
 * `isPeriodClosed`. A second HR lock table is how a month comes to be closed in finance
 * and open in HR.
 */
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import {
  ZERO, sumPaise, subtractPaise, addPaise, paise, type Paise,
} from '@/lib/server/finance/money';
import {
  APPROVAL_TRANSITIONS, PAYROLL_TRANSITIONS, isWorkedStatus, notFound, refuse,
  type ApprovalStatus, type AttendanceRecord, type Employee, type EmployeeAdvance,
  type AdvanceWithBalance, type LeaveBalance, type LeaveRequest, type OvertimeRecord,
  type PayrollLine, type PayrollRun, type PayrollStatus, type SalaryStructure,
  type SalaryStructureWithComponents, type EmploymentStatus,
} from './types';
import type {
  HrRepository, EmployeeInput, AttendanceInput, LeaveRequestInput, OvertimeInput,
  AdvanceInput, SalaryStructureInput, AttendanceFilter, LeaveFilter, OvertimeFilter,
  PayrollLineInput,
} from './repository';

export interface HrServiceDeps {
  repo: HrRepository;
  /**
   * The property identifiers in THIS TENANT'S OWN workbook.
   *
   * Wired from `getDataProvider(tenant).getPropertyIds()`. That is what makes property
   * validation safe: the only list a caller can be checked against is their own, so a
   * refusal cannot reveal that another tenant has a property by that name.
   */
  propertyIds: (tenant: TenantContext) => Promise<readonly string[]>;
  /**
   * THE period lock — finance's, not a second one. Payroll and attendance are refused
   * inside a month finance has closed, and reopening is finance's privileged, audited act.
   */
  isPeriodClosed: (tenant: TenantContext, isoDate: string) => Promise<boolean>;
  audit: AuditService;
  now?: () => Date;
}

export function periodStartOf(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export class HrService {
  constructor(private readonly deps: HrServiceDeps) {}

  private clock(): Date { return this.deps.now?.() ?? new Date(); }

  /* ---------------------------------------------------------------- *
   * Shared guards
   * ---------------------------------------------------------------- */

  async assertPeriodOpen(tenant: TenantContext, isoDate: string): Promise<void> {
    if (await this.deps.isPeriodClosed(tenant, isoDate)) {
      throw refuse('PERIOD_CLOSED',
        `${isoDate.slice(0, 7)} is closed. A closed period does not accept new people or `
        + 'payroll movement dated inside it; reopen the period, with a reason, or date the '
        + 'entry in an open one.', 409);
    }
  }

  /**
   * Refuses a property that is not in the caller's workbook.
   *
   * Identical whether the property belongs to another tenant or does not exist at all —
   * the check never consults another tenant's data, so it cannot distinguish the two even
   * in principle.
   */
  async assertPropertyIsOwn(tenant: TenantContext, propertyId: string | null | undefined): Promise<void> {
    if (!propertyId) return;
    const owned = await this.deps.propertyIds(tenant);
    if (!owned.includes(propertyId)) {
      throw refuse('UNKNOWN_PROPERTY',
        `No property ${propertyId} in this workbook. A person can only be assigned to a `
        + 'property this business operates.');
    }
  }

  /** Resolves an employee through the tenant-scoped repository, or refuses identically. */
  private async requireEmployee(tenant: TenantContext, employeeId: string): Promise<Employee> {
    const employee = await this.deps.repo.getEmployee(tenant, employeeId);
    if (!employee) throw notFound('employee');
    return employee;
  }

  /* ---------------------------------------------------------------- *
   * Organisation master
   *
   * Thin pass-throughs, and deliberately so: a department is a name. The value of routing
   * them through the service is that no caller anywhere reaches a repository directly, so
   * there is one path to the data and one place a rule can later be added to it.
   * ---------------------------------------------------------------- */

  async createDepartment(tenant: TenantContext, name: string) {
    if (!name?.trim()) throw refuse('VALIDATION', 'A department needs a name.');
    const existing = await this.deps.repo.listDepartments(tenant);
    if (existing.some((d) => d.name.toLowerCase() === name.trim().toLowerCase())) {
      throw refuse('DUPLICATE_DEPARTMENT', `There is already a department called "${name.trim()}".`);
    }
    return this.deps.repo.createDepartment(tenant, name);
  }

  listDepartments(tenant: TenantContext) { return this.deps.repo.listDepartments(tenant); }

  async createDesignation(tenant: TenantContext, name: string) {
    if (!name?.trim()) throw refuse('VALIDATION', 'A designation needs a name.');
    const existing = await this.deps.repo.listDesignations(tenant);
    if (existing.some((d) => d.name.toLowerCase() === name.trim().toLowerCase())) {
      throw refuse('DUPLICATE_DESIGNATION', `There is already a designation called "${name.trim()}".`);
    }
    return this.deps.repo.createDesignation(tenant, name);
  }

  listDesignations(tenant: TenantContext) { return this.deps.repo.listDesignations(tenant); }

  /**
   * A shift, including an overnight one.
   *
   * 22:00 → 06:00 is ordinary in hospitality, so the flag and the times must agree: a
   * shift that claims not to cross midnight while ending before it starts would be a
   * zero-length day everything downstream computed from.
   */
  async createShift(
    tenant: TenantContext,
    input: { name: string; startTime: string; endTime: string; crossesMidnight: boolean; graceMinutes: number },
  ) {
    if (!input.name?.trim()) throw refuse('VALIDATION', 'A shift needs a name.');
    const overnight = input.endTime <= input.startTime;
    if (overnight !== input.crossesMidnight) {
      throw refuse('VALIDATION', input.crossesMidnight
        ? 'A shift marked as crossing midnight must end at or before the time it starts.'
        : `${input.startTime}–${input.endTime} ends before it begins, so it crosses midnight. `
          + 'Say so explicitly rather than leaving it to be inferred.');
    }
    return this.deps.repo.createShift(tenant, input);
  }

  listShifts(tenant: TenantContext) { return this.deps.repo.listShifts(tenant); }

  async createLeaveType(
    tenant: TenantContext, input: { code: string; name: string; paid: boolean },
  ) {
    if (!input.code?.trim() || !input.name?.trim()) {
      throw refuse('VALIDATION', 'A leave type needs a code and a name.');
    }
    const existing = await this.deps.repo.listLeaveTypes(tenant);
    if (existing.some((t) => t.code === input.code.trim().toUpperCase())) {
      throw refuse('DUPLICATE_LEAVE_TYPE', `Leave type ${input.code.trim().toUpperCase()} already exists.`);
    }
    return this.deps.repo.createLeaveType(tenant, input);
  }

  listLeaveTypes(tenant: TenantContext) { return this.deps.repo.listLeaveTypes(tenant); }

  listAdvances(tenant: TenantContext, employeeId?: string) {
    return this.deps.repo.listAdvances(tenant, employeeId);
  }

  createEntitlement(
    tenant: TenantContext,
    input: { employeeId: string; leaveTypeId: string; yearStart: string; allocatedHalfDays: number },
  ) {
    return this.deps.repo.createEntitlement(tenant, input);
  }

  /* ---------------------------------------------------------------- *
   * Employees
   * ---------------------------------------------------------------- */

  /**
   * A tenant-scoped, human-readable code — never the display name.
   *
   * Derived from the highest existing code IN THIS TENANT, so it cannot reveal another
   * customer's headcount. The unique index is the real guard: two concurrent creates could
   * both read the same maximum, and the second insert is refused rather than allowed to
   * duplicate. A retry then reads the new maximum and succeeds, which is why this is safe
   * without a transaction the in-memory twin could not model anyway.
   */
  private async nextEmployeeCode(tenant: TenantContext): Promise<string> {
    const existing = await this.deps.repo.listEmployees(tenant);
    let highest = 0;
    for (const employee of existing) {
      const match = /^EMP-(\d+)$/.exec(employee.employeeCode.trim().toUpperCase());
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    return `EMP-${String(highest + 1).padStart(4, '0')}`;
  }

  async createEmployee(
    tenant: TenantContext, input: Omit<EmployeeInput, 'employeeCode'> & { employeeCode?: string },
    actor: string,
  ): Promise<Employee> {
    if (!input.fullName?.trim()) throw refuse('VALIDATION', 'A person needs a name.');
    await this.assertPropertyIsOwn(tenant, input.primaryPropertyId);

    // Every reference resolved through the tenant-scoped repository, so a department,
    // designation or manager belonging to another business answers "no such record".
    if (input.departmentId) {
      const departments = await this.deps.repo.listDepartments(tenant);
      if (!departments.some((d) => d.id === input.departmentId)) throw notFound('department');
    }
    if (input.designationId) {
      const designations = await this.deps.repo.listDesignations(tenant);
      if (!designations.some((d) => d.id === input.designationId)) throw notFound('designation');
    }
    if (input.managerId) await this.requireEmployee(tenant, input.managerId);

    const code = input.employeeCode?.trim() || await this.nextEmployeeCode(tenant);
    const existing = await this.deps.repo.listEmployees(tenant);
    if (existing.some((e) => e.employeeCode.toLowerCase() === code.toLowerCase())) {
      throw refuse('DUPLICATE_CODE', `Employee code ${code} is already in use.`);
    }

    return this.deps.repo.createEmployee(tenant, { ...input, employeeCode: code }, actor);
  }

  listEmployees(tenant: TenantContext, status?: EmploymentStatus): Promise<Employee[]> {
    return this.deps.repo.listEmployees(tenant, status);
  }

  getEmployee(tenant: TenantContext, id: string): Promise<Employee | null> {
    return this.deps.repo.getEmployee(tenant, id);
  }

  /**
   * A status change, never a delete.
   *
   * History depends on people: an exited employee still owns last quarter's attendance and
   * payslips. EXITED requires a leaving date and every other status forbids one, so the
   * two can never disagree.
   */
  async setEmployeeStatus(
    tenant: TenantContext, id: string, status: EmploymentStatus, exitDate: string | null,
  ): Promise<Employee> {
    await this.requireEmployee(tenant, id);
    if (status === 'EXITED' && !exitDate) {
      throw refuse('VALIDATION', 'An employee who has left needs a leaving date.');
    }
    if (status !== 'EXITED' && exitDate) {
      throw refuse('VALIDATION', 'Only an EXITED employee carries a leaving date.');
    }
    const updated = await this.deps.repo.setEmployeeStatus(tenant, id, status, exitDate);
    if (!updated) throw notFound('employee');
    return updated;
  }

  /* ---------------------------------------------------------------- *
   * Attendance
   * ---------------------------------------------------------------- */

  async recordAttendance(
    tenant: TenantContext, input: AttendanceInput, actor: string,
  ): Promise<AttendanceRecord> {
    await this.requireEmployee(tenant, input.employeeId);
    await this.assertPropertyIsOwn(tenant, input.propertyId);
    await this.assertPeriodOpen(tenant, input.attendanceDate);

    if (input.shiftId && !await this.deps.repo.getShift(tenant, input.shiftId)) {
      throw notFound('shift');
    }
    if ((input.late || input.earlyExit) && !isWorkedStatus(input.status)) {
      // A flag only means something on a day somebody attended.
      throw refuse('VALIDATION',
        'Late and early-exit describe a day somebody worked, so they cannot be set on an '
        + `${input.status} day.`);
    }

    // The uniqueness rule, checked here as well as by the index: at most one record per
    // employee per date per shift, and at most one shiftless record per date.
    const sameDay = await this.deps.repo.listAttendance(tenant, {
      employeeId: input.employeeId, from: input.attendanceDate, to: input.attendanceDate,
    });
    const clash = sameDay.some((a) => (a.shiftId ?? null) === (input.shiftId ?? null));
    if (clash) {
      throw refuse('DUPLICATE_ATTENDANCE',
        `Attendance for ${input.attendanceDate} is already recorded`
        + `${input.shiftId ? ' for that shift' : ''}. Amend the existing record rather than `
        + 'adding a second one.', 409);
    }

    return this.deps.repo.recordAttendance(tenant, input, actor);
  }

  listAttendance(tenant: TenantContext, filter: AttendanceFilter = {}): Promise<AttendanceRecord[]> {
    return this.deps.repo.listAttendance(tenant, filter);
  }

  async transitionAttendance(
    tenant: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<AttendanceRecord> {
    const record = await this.deps.repo.getAttendance(tenant, id);
    if (!record) throw notFound('attendance record');
    assertApprovalTransition(record.approval, next, 'attendance record');
    // Approving is a change to what payroll will consume, so it is subject to the lock.
    await this.assertPeriodOpen(tenant, record.attendanceDate);
    const updated = await this.deps.repo.transitionAttendance(tenant, id, next, actor);
    if (!updated) throw notFound('attendance record');
    return updated;
  }

  /* ---------------------------------------------------------------- *
   * Leave
   * ---------------------------------------------------------------- */

  async createLeaveRequest(
    tenant: TenantContext, input: LeaveRequestInput, actor: string,
  ): Promise<LeaveRequest> {
    await this.requireEmployee(tenant, input.employeeId);
    if (!await this.deps.repo.getLeaveType(tenant, input.leaveTypeId)) throw notFound('leave type');
    if (input.endDate < input.startDate) {
      throw refuse('VALIDATION', 'Leave cannot end before it begins.');
    }
    if (input.halfDays <= 0) throw refuse('VALIDATION', 'Leave is at least half a day.');
    await this.assertPeriodOpen(tenant, input.startDate);

    // An overlapping request is a double count of the same absence, and it would be
    // deducted twice from a balance.
    const existing = await this.deps.repo.listLeaveRequests(tenant, { employeeId: input.employeeId });
    const overlaps = existing.filter((l) => l.status === 'SUBMITTED' || l.status === 'APPROVED')
      .some((l) => l.startDate <= input.endDate && l.endDate >= input.startDate);
    if (overlaps) {
      throw refuse('OVERLAPPING_LEAVE',
        'This employee already has leave requested or approved over those dates.', 409);
    }

    return this.deps.repo.createLeaveRequest(tenant, input, actor);
  }

  listLeaveRequests(tenant: TenantContext, filter: LeaveFilter = {}): Promise<LeaveRequest[]> {
    return this.deps.repo.listLeaveRequests(tenant, filter);
  }

  async transitionLeaveRequest(
    tenant: TenantContext, id: string, next: ApprovalStatus, actor: string, note?: string,
  ): Promise<LeaveRequest> {
    const request = await this.deps.repo.getLeaveRequest(tenant, id);
    if (!request) throw notFound('leave request');
    assertApprovalTransition(request.status, next, 'leave request');
    if (next === 'REJECTED' && !note?.trim()) {
      throw refuse('VALIDATION', 'A rejection records why, so the decision can be explained later.');
    }
    // Approving your own leave defeats the point of approval.
    if (next === 'APPROVED' && request.requestedBy && request.requestedBy === actor) {
      throw refuse('SELF_APPROVAL',
        'Leave must be approved by someone other than the person who requested it.', 409);
    }
    const updated = await this.deps.repo.transitionLeaveRequest(tenant, id, next, actor, note);
    if (!updated) throw notFound('leave request');
    return updated;
  }

  /**
   * available = allocated − approved taken.
   *
   * "Taken" is summed from approved requests and never stored, so a balance cannot drift
   * from the leave it is supposed to describe, and no editable magic number exists to be
   * quietly corrected. Accrual — earning leave monthly rather than receiving it annually —
   * is deliberately absent: that rule is policy nobody has stated.
   */
  async leaveBalances(
    tenant: TenantContext, employeeId: string, yearStart: string,
  ): Promise<LeaveBalance[]> {
    await this.requireEmployee(tenant, employeeId);
    const [types, entitlements, requests] = await Promise.all([
      this.deps.repo.listLeaveTypes(tenant),
      this.deps.repo.listEntitlements(tenant, employeeId),
      this.deps.repo.listLeaveRequests(tenant, { employeeId, status: 'APPROVED' }),
    ]);
    const yearEnd = `${Number(yearStart.slice(0, 4)) + 1}${yearStart.slice(4)}`;

    return entitlements
      .filter((e) => e.yearStart === yearStart)
      .map((entitlement) => {
        const taken = requests
          .filter((r) => r.leaveTypeId === entitlement.leaveTypeId)
          .filter((r) => r.startDate >= yearStart && r.startDate < yearEnd)
          .reduce((total, r) => total + r.halfDays, 0);
        const type = types.find((t) => t.id === entitlement.leaveTypeId);
        return Object.freeze({
          leaveTypeId: entitlement.leaveTypeId,
          leaveTypeCode: type?.code ?? 'UNKNOWN',
          allocatedHalfDays: entitlement.allocatedHalfDays,
          takenHalfDays: taken,
          availableHalfDays: entitlement.allocatedHalfDays - taken,
        });
      });
  }

  /* ---------------------------------------------------------------- *
   * Overtime
   * ---------------------------------------------------------------- */

  async createOvertime(
    tenant: TenantContext, input: OvertimeInput, actor: string,
  ): Promise<OvertimeRecord> {
    await this.requireEmployee(tenant, input.employeeId);
    await this.assertPropertyIsOwn(tenant, input.propertyId);
    await this.assertPeriodOpen(tenant, input.overtimeDate);
    if (input.minutes <= 0) throw refuse('VALIDATION', 'Overtime is a positive number of minutes.');
    if (!input.reason?.trim()) {
      throw refuse('VALIDATION', 'Overtime records why it was worked.');
    }
    return this.deps.repo.createOvertime(tenant, input, actor);
  }

  listOvertime(tenant: TenantContext, filter: OvertimeFilter = {}): Promise<OvertimeRecord[]> {
    return this.deps.repo.listOvertime(tenant, filter);
  }

  async transitionOvertime(
    tenant: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<OvertimeRecord> {
    const record = await this.deps.repo.getOvertime(tenant, id);
    if (!record) throw notFound('overtime record');
    assertApprovalTransition(record.status, next, 'overtime record');
    await this.assertPeriodOpen(tenant, record.overtimeDate);
    const updated = await this.deps.repo.transitionOvertime(tenant, id, next, actor);
    if (!updated) throw notFound('overtime record');
    return updated;
  }

  /* ---------------------------------------------------------------- *
   * Advances
   * ---------------------------------------------------------------- */

  async createAdvance(
    tenant: TenantContext, input: AdvanceInput, actor: string,
  ): Promise<EmployeeAdvance> {
    await this.requireEmployee(tenant, input.employeeId);
    await this.assertPeriodOpen(tenant, input.issuedOn);
    if (input.amount <= 0) throw refuse('VALIDATION', 'An advance is a positive amount.');
    if (!input.reason?.trim()) throw refuse('VALIDATION', 'An advance records why it was given.');
    return this.deps.repo.createAdvance(tenant, input, actor);
  }

  async transitionAdvance(
    tenant: TenantContext, id: string, next: ApprovalStatus, actor: string,
  ): Promise<EmployeeAdvance> {
    const advance = await this.deps.repo.getAdvance(tenant, id);
    if (!advance) throw notFound('advance');
    assertApprovalTransition(advance.status, next, 'advance');
    if (next === 'APPROVED' && advance.status === 'SUBMITTED') {
      await this.assertPeriodOpen(tenant, advance.issuedOn);
    }
    const updated = await this.deps.repo.transitionAdvance(tenant, id, next, actor);
    if (!updated) throw notFound('advance');
    return updated;
  }

  /**
   * What an employee still owes on their advances.
   *
   * Computed, never stored — the same rule finance applies to bills. Recovery is summed
   * from POSTED payroll runs, because a recovery on a run nobody posted has not happened.
   *
   * The balance is per EMPLOYEE, not per advance: a payroll deduction reduces what the
   * person owes overall rather than being earmarked to one advance, because earmarking
   * would need an instalment schedule nobody has specified.
   */
  async advanceBalanceFor(tenant: TenantContext, employeeId: string): Promise<AdvanceBalanceSummary> {
    const [advances, runs] = await Promise.all([
      this.deps.repo.listAdvances(tenant, employeeId),
      this.deps.repo.listPayrollRuns(tenant),
    ]);
    const approved = advances.filter((a) => a.status === 'APPROVED');
    const issued = sumPaise(approved.map((a) => a.amount));

    const postedRuns = runs.filter((r) => r.status === 'POSTED');
    const recoveries: Paise[] = [];
    for (const run of postedRuns) {
      const lines = await this.deps.repo.listPayrollLines(tenant, run.id);
      for (const line of lines) {
        if (line.employeeId === employeeId) recoveries.push(line.advanceRecovery);
      }
    }
    const recovered = sumPaise(recoveries);
    return Object.freeze({
      employeeId,
      issued,
      recovered,
      outstanding: subtractPaise(issued, recovered),
      advances: approved,
    });
  }

  /* ---------------------------------------------------------------- *
   * Salary — effective-dated, never overwritten
   * ---------------------------------------------------------------- */

  /**
   * A raise is a NEW ROW.
   *
   * The previous open-ended structure is closed the day before the new one begins, so the
   * history reads as a continuous sequence and "what were we paying in March?" always has
   * an answer. Overwriting `salary = 25000` with `salary = 28000` destroys exactly that.
   */
  async createSalaryStructure(
    tenant: TenantContext, input: SalaryStructureInput, actor: string,
  ): Promise<SalaryStructure> {
    await this.requireEmployee(tenant, input.employeeId);
    if (input.components.length === 0) {
      throw refuse('VALIDATION', 'A salary structure needs at least one component.');
    }
    if (!input.components.some((c) => c.kind === 'EARNING')) {
      throw refuse('VALIDATION', 'A salary structure needs at least one earning.');
    }
    await this.assertPeriodOpen(tenant, input.effectiveFrom);

    const existing = await this.deps.repo.listSalaryStructures(tenant, input.employeeId);
    if (existing.some((s) => s.effectiveFrom === input.effectiveFrom)) {
      throw refuse('DUPLICATE_STRUCTURE',
        `A salary structure already begins on ${input.effectiveFrom}.`, 409);
    }
    const later = existing.find((s) => s.effectiveFrom > input.effectiveFrom);
    if (later) {
      // Back-dating behind an existing structure would make two apply at once, and payroll
      // would have to guess which. Refused rather than resolved by a rule nobody chose.
      throw refuse('OUT_OF_ORDER_STRUCTURE',
        `A later structure already begins on ${later.effectiveFrom}. A back-dated change `
        + 'has to be made deliberately, not inferred.', 409);
    }

    const open = existing.find((s) => s.effectiveTo === null);
    if (open) {
      await this.deps.repo.closeSalaryStructure(tenant, open.id, dayBefore(input.effectiveFrom));
    }
    return this.deps.repo.createSalaryStructure(tenant, input, actor);
  }

  /** The structure in force on a date, with its components summed. */
  async salaryEffectiveOn(
    tenant: TenantContext, employeeId: string, isoDate: string,
  ): Promise<SalaryStructureWithComponents | null> {
    const structures = await this.deps.repo.listSalaryStructures(tenant, employeeId);
    const match = structures.find((s) => s.effectiveFrom <= isoDate
      && (s.effectiveTo === null || s.effectiveTo >= isoDate));
    if (!match) return null;
    const components = await this.deps.repo.listSalaryComponents(tenant, match.id);
    return Object.freeze({
      ...match,
      components,
      grossEarnings: sumPaise(components.filter((c) => c.kind === 'EARNING').map((c) => c.amount)),
      fixedDeductions: sumPaise(components.filter((c) => c.kind === 'DEDUCTION').map((c) => c.amount)),
    });
  }

  listSalaryStructures(tenant: TenantContext, employeeId: string): Promise<SalaryStructure[]> {
    return this.deps.repo.listSalaryStructures(tenant, employeeId);
  }

  /* ---------------------------------------------------------------- *
   * Payroll — the one calculation engine
   * ---------------------------------------------------------------- */

  async openPayrollRun(
    tenant: TenantContext, periodStart: string, actor: string,
  ): Promise<PayrollRun> {
    assertMonthStart(periodStart);
    await this.assertPeriodOpen(tenant, periodStart);
    const existing = await this.deps.repo.getPayrollRunForPeriod(tenant, periodStart);
    if (existing) {
      // A second run for the same month would produce a second set of obligations for the
      // same salaries, which is how somebody gets paid twice.
      throw refuse('RUN_EXISTS', `Payroll for ${periodStart.slice(0, 7)} already exists.`, 409);
    }
    return this.deps.repo.createPayrollRun(tenant, periodStart, actor);
  }

  /**
   * CALCULATE — and refuse rather than guess.
   *
   * What it computes exactly, from recorded facts:
   *   gross              the sum of EARNING components of the structure in force
   *   deductions         the sum of DEDUCTION components, plus nothing invented
   *   advance recovery   only what the caller explicitly asked to recover, capped at what
   *                      the employee actually owes
   *   day counts         from APPROVED attendance only
   *
   * What it deliberately does NOT compute, because each is an unstated policy:
   *   loss of pay for absence — the basis (gross ÷ 30? ÷ working days? ÷ calendar days?)
   *                             has never been decided, so absence is COUNTED and reported
   *                             on the line rather than silently priced
   *   an overtime rate        — minutes are carried; what a minute is worth is unstated
   *   PF / ESI / PT / TDS     — ordinary DEDUCTION components once somebody states the rule
   *
   * And what it refuses outright: a period containing attendance that nobody approved.
   * Payroll consuming unreviewed attendance is the failure this whole approval chain
   * exists to prevent, so the run stops and names the count.
   */
  async calculatePayroll(
    tenant: TenantContext,
    runId: string,
    options: { recoveries?: ReadonlyArray<{ employeeId: string; amountMinor: number }> } = {},
  ): Promise<PayrollLine[]> {
    const run = await this.requireRun(tenant, runId);
    assertPayrollTransition(run.status, 'CALCULATED');
    await this.assertPeriodOpen(tenant, run.periodStart);

    const periodEnd = lastDayOf(run.periodStart);
    const window = { from: run.periodStart, to: periodEnd };

    const pending = await this.deps.repo.listAttendance(tenant, { ...window, approval: 'SUBMITTED' });
    if (pending.length > 0) {
      throw refuse('ATTENDANCE_NOT_APPROVED',
        `${pending.length} attendance ${pending.length === 1 ? 'record is' : 'records are'} `
        + 'still awaiting approval for this period. Payroll does not consume unreviewed '
        + 'attendance.', 409);
    }

    const [employees, approvedAttendance, approvedOvertime] = await Promise.all([
      this.deps.repo.listEmployees(tenant),
      this.deps.repo.listAttendance(tenant, { ...window, approval: 'APPROVED' }),
      this.deps.repo.listOvertime(tenant, { ...window, status: 'APPROVED' }),
    ]);

    const recoveryFor = new Map(
      (options.recoveries ?? []).map((r) => [r.employeeId, paise(r.amountMinor, 'recovery')]),
    );

    const lines: PayrollLineInput[] = [];
    for (const employee of employees) {
      // Somebody who had not joined, or who had already left, is not on this payroll.
      if (employee.joiningDate > periodEnd) continue;
      if (employee.exitDate && employee.exitDate < run.periodStart) continue;

      const structure = await this.salaryEffectiveOn(tenant, employee.id, run.periodStart);
      const mine = approvedAttendance.filter((a) => a.employeeId === employee.id);

      const payableDays = mine.filter((a) => isWorkedStatus(a.status)).length;
      const leaveDays = mine.filter((a) => a.status === 'LEAVE').length;
      const absentDays = mine.filter((a) => a.status === 'ABSENT').length;
      /*
       * The honest field. A day with no record is NOT absence — nobody said the person was
       * away, they said nothing at all — so it is counted separately and reported. A
       * payslip built on invented attendance is worse than one that shows a gap.
       */
      const employedDays = countEmployedDays(run.periodStart, periodEnd, employee);
      const unrecordedDays = Math.max(0, employedDays - uniqueDates(mine).size);

      const overtimeMinutes = approvedOvertime
        .filter((o) => o.employeeId === employee.id)
        .reduce((total, o) => total + o.minutes, 0);

      const gross = structure?.grossEarnings ?? ZERO;
      const deductions = structure?.fixedDeductions ?? ZERO;

      const requested = recoveryFor.get(employee.id) ?? ZERO;
      const owed = (await this.advanceBalanceFor(tenant, employee.id)).outstanding;
      if (requested > owed) {
        throw refuse('RECOVERY_EXCEEDS_ADVANCE',
          `${employee.employeeCode} owes less than the recovery requested.`);
      }
      const recovery = requested;

      const net = subtractPaise(subtractPaise(gross, deductions), recovery);
      if (net < 0) {
        // A negative payslip is not a payslip. Refused rather than stored, because the
        // fix is a decision about the recovery, not a number this engine may choose.
        throw refuse('NEGATIVE_NET',
          `${employee.employeeCode} would have a negative net after deductions and advance `
          + 'recovery. Reduce the recovery for this period.');
      }

      lines.push({
        employeeId: employee.id,
        structureId: structure?.id ?? null,
        gross, deductions, advanceRecovery: recovery, net,
        currency: structure?.currency ?? 'INR',
        payableDays, leaveDays, absentDays, unrecordedDays, overtimeMinutes,
        // Stated on the line itself so nobody reads the figure without the caveat.
        notes: structure ? null : 'No salary structure in force for this period.',
      });
    }

    // Replaces, so recalculating produces one set of lines rather than two.
    const created = await this.deps.repo.replacePayrollLines(tenant, runId, lines);
    await this.deps.repo.transitionPayrollRun(tenant, runId, 'CALCULATED', 'system');
    return created;
  }

  async transitionPayrollRun(
    tenant: TenantContext, runId: string, next: PayrollStatus, actor: string,
    options: { acknowledgeGaps?: boolean } = {},
  ): Promise<PayrollRun> {
    const run = await this.requireRun(tenant, runId);
    assertPayrollTransition(run.status, next);
    await this.assertPeriodOpen(tenant, run.periodStart);

    if (next === 'APPROVED') {
      const lines = await this.deps.repo.listPayrollLines(tenant, runId);
      if (lines.length === 0) {
        throw refuse('NOTHING_TO_APPROVE', 'This run has no lines. Calculate it first.', 409);
      }
      if (run.createdBy && run.createdBy === actor) {
        throw refuse('SELF_APPROVAL',
          'Payroll must be approved by someone other than the person who opened the run.', 409);
      }

      /*
       * THE QUIETEST FAILURE IN THIS MILESTONE, refused rather than warned about.
       *
       * Payroll is the first thing this product computes whose output is a PAYMENT, from
       * data entered by hand that the rules deliberately permit to be incomplete — a day
       * with no attendance record is not an absence, it is a day nobody said anything
       * about. Every other failure here is loud. This one is silent by construction: the
       * PRESENT rows are counted, a plausible total comes out, an approver sees the total
       * and not the gap, and money leaves the business.
       *
       * So a run with gaps cannot be approved by default. It CAN be approved by someone
       * who says, on the record, that they know — `acknowledgeGaps` is carried into the
       * audit trail, which turns a silent omission into a deliberate, attributable act.
       * Calculating is always allowed: looking at the gaps is exactly what you want to do
       * before deciding.
       */
      const withGaps = lines.filter((l) => l.unrecordedDays > 0);
      if (withGaps.length > 0 && !options.acknowledgeGaps) {
        const worst = withGaps.reduce((a, b) => (b.unrecordedDays > a.unrecordedDays ? b : a));
        throw refuse('UNRECORDED_ATTENDANCE',
          `${withGaps.length} of ${lines.length} payroll ${lines.length === 1 ? 'line has' : 'lines have'} `
          + `days with no attendance recorded at all (up to ${worst.unrecordedDays} days). `
          + 'A day nobody recorded is not a day somebody was absent, so these figures rest on '
          + 'an assumption rather than a fact. Record the missing attendance, or approve '
          + 'explicitly acknowledging the gaps.', 409);
      }
    }
    if (next === 'POSTED' && run.status !== 'APPROVED') {
      // Belt and braces over the transition table: posting is what creates obligations
      // somebody will settle, so it may only follow an approval.
      throw refuse('APPROVAL_REQUIRED', 'Only an approved payroll run can be posted.', 409);
    }

    const updated = await this.deps.repo.transitionPayrollRun(tenant, runId, next, actor);
    if (!updated) throw notFound('payroll run');
    return updated;
  }

  listPayrollRuns(tenant: TenantContext): Promise<PayrollRun[]> {
    return this.deps.repo.listPayrollRuns(tenant);
  }

  listPayrollLines(tenant: TenantContext, runId: string): Promise<PayrollLine[]> {
    return this.deps.repo.listPayrollLines(tenant, runId);
  }

  private async requireRun(tenant: TenantContext, runId: string): Promise<PayrollRun> {
    const run = await this.deps.repo.getPayrollRun(tenant, runId);
    if (!run) throw notFound('payroll run');
    return run;
  }

  /* ---------------------------------------------------------------- *
   * Reporting
   * ---------------------------------------------------------------- */

  /**
   * Headcount, attendance and cost, computed once and on the server.
   *
   * `salaryCostByProperty` attributes a payroll line to the employee's PRIMARY property
   * and nowhere else. An employee who works across several properties has no defined cost
   * split, and inventing one would attribute salary on no authority — so their cost is
   * reported as unattributed rather than assigned to whichever property sorts first.
   */
  async workforceSummary(
    tenant: TenantContext, periodStart: string,
  ): Promise<WorkforceSummary> {
    requireTenant(tenant, 'workforceSummary');
    const periodEnd = lastDayOf(periodStart);
    const [employees, attendance, overtime, run] = await Promise.all([
      this.deps.repo.listEmployees(tenant),
      this.deps.repo.listAttendance(tenant, { from: periodStart, to: periodEnd, approval: 'APPROVED' }),
      this.deps.repo.listOvertime(tenant, { from: periodStart, to: periodEnd, status: 'APPROVED' }),
      this.deps.repo.getPayrollRunForPeriod(tenant, periodStart),
    ]);

    const active = employees.filter((e) => e.status !== 'EXITED');
    const byProperty = new Map<string, number>();
    for (const employee of active) {
      const key = employee.primaryPropertyId ?? UNATTRIBUTED;
      byProperty.set(key, (byProperty.get(key) ?? 0) + 1);
    }

    const lines = run ? await this.deps.repo.listPayrollLines(tenant, run.id) : [];
    const employeeProperty = new Map(employees.map((e) => [e.id, e.primaryPropertyId ?? UNATTRIBUTED]));
    const costByProperty = new Map<string, Paise>();
    for (const line of lines) {
      const key = employeeProperty.get(line.employeeId) ?? UNATTRIBUTED;
      costByProperty.set(key, addPaise(costByProperty.get(key) ?? ZERO, line.net));
    }

    return Object.freeze({
      headcount: active.length,
      onLeave: active.filter((e) => e.status === 'ON_LEAVE').length,
      exited: employees.filter((e) => e.status === 'EXITED').length,
      headcountByProperty: [...byProperty].map(([propertyId, count]) => ({ propertyId, count })),
      presentDays: attendance.filter((a) => isWorkedStatus(a.status)).length,
      absentDays: attendance.filter((a) => a.status === 'ABSENT').length,
      leaveDays: attendance.filter((a) => a.status === 'LEAVE').length,
      overtimeMinutes: overtime.reduce((total, o) => total + o.minutes, 0),
      payrollStatus: run?.status ?? null,
      payrollNet: sumPaise(lines.map((l) => l.net)),
      /** Payroll lines whose period had days nobody recorded attendance for. */
      linesWithGaps: lines.filter((l) => l.unrecordedDays > 0).length,
      salaryCostByProperty: [...costByProperty].map(([propertyId, cost]) => ({ propertyId, cost })),
    });
  }
}

/** The key a cost with no defined property split is reported under. Never a real property. */
export const UNATTRIBUTED = 'UNATTRIBUTED';

export interface AdvanceBalanceSummary {
  readonly employeeId: string;
  readonly issued: Paise;
  readonly recovered: Paise;
  readonly outstanding: Paise;
  readonly advances: readonly EmployeeAdvance[];
}

export interface WorkforceSummary {
  readonly headcount: number;
  readonly onLeave: number;
  readonly exited: number;
  readonly headcountByProperty: ReadonlyArray<{ propertyId: string; count: number }>;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly leaveDays: number;
  readonly overtimeMinutes: number;
  readonly payrollStatus: PayrollStatus | null;
  readonly payrollNet: Paise;
  readonly linesWithGaps: number;
  readonly salaryCostByProperty: ReadonlyArray<{ propertyId: string; cost: Paise }>;
}

/* ------------------------------------------------------------------ *
 * Shared refusals
 * ------------------------------------------------------------------ */

function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus, what: string): void {
  const allowed = APPROVAL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw refuse('ILLEGAL_TRANSITION',
      `A ${from} ${what} cannot become ${to}. `
      + (allowed.length === 0
        ? 'It is in a final state; a change is a new record, not an edit of one payroll may '
          + 'already have consumed.'
        : `From here it may become: ${allowed.join(', ')}.`),
      409);
  }
}

function assertPayrollTransition(from: PayrollStatus, to: PayrollStatus): void {
  const allowed = PAYROLL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw refuse('ILLEGAL_TRANSITION',
      `A ${from} payroll run cannot become ${to}. `
      + (allowed.length === 0
        ? 'A posted run has produced obligations somebody may already have settled.'
        : `From here it may become: ${allowed.join(', ')}.`),
      409);
  }
}

function assertMonthStart(periodStart: string): void {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) {
    throw refuse('VALIDATION', 'A payroll period is a calendar month, named by its first day.');
  }
}

/* ------------------------------------------------------------------ *
 * Dates — UTC throughout, so a timezone cannot move a payslip a month
 * ------------------------------------------------------------------ */

function lastDayOf(periodStart: string): string {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function uniqueDates(records: readonly AttendanceRecord[]): Set<string> {
  return new Set(records.map((r) => r.attendanceDate));
}

/** Days in the period the person was actually employed — not the whole month by default. */
function countEmployedDays(periodStart: string, periodEnd: string, employee: Employee): number {
  const from = employee.joiningDate > periodStart ? employee.joiningDate : periodStart;
  const to = employee.exitDate && employee.exitDate < periodEnd ? employee.exitDate : periodEnd;
  if (to < from) return 0;
  const ms = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Math.floor(ms / 86_400_000) + 1;
}
