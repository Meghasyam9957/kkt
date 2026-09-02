import '@/lib/server/only';
/**
 * PEOPLE ON OPERATIONS — the rules, in the layer a test can execute.
 *
 * Three boundaries meet here and all three have to hold at once:
 *
 *   the TASK      lives in the tenant's Google workbook, reached only through that
 *                 tenant's provider — so a foreign task reference cannot be confirmed
 *                 to exist, let alone assigned
 *   the EMPLOYEE  lives in Postgres, reached only through the tenant-scoped HR repository
 *   the PROPERTY  lives in the tenant's workbook, and is checked against the caller's own
 *                 list exactly as finance and HR check it
 *
 * The interesting failure this design forecloses is a task id from one tenant paired with
 * an employee id from another. Both are resolved independently, each against the caller's
 * own store, before anything is written — so the pair is only ever formed from two things
 * the caller already owns.
 *
 * WHAT THIS SERVICE DOES NOT DO, on purpose:
 *
 *   it does not change attendance      Assigning work is not evidence somebody worked, and
 *                                      completing a task is not either. Attendance is
 *                                      recorded and approved by a person, and stays the
 *                                      authority for whether a day was worked.
 *   it does not touch payroll          A completed task changes no pay. Payroll consumes
 *                                      approved attendance and approved overtime, and
 *                                      nothing here writes either.
 *   it does not create an expense      14_MAINTENANCE.ExpenseID is the authoritative link
 *                                      to 06_EXPENSES and a person decides it. Work having
 *                                      been done is not the same claim as money having
 *                                      been spent.
 *   it does not own task status        Both lifecycles live in the workbook's own LISTS.
 */
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import type { AuditService } from '@/lib/server/audit/logger';
import type { HrService } from '@/lib/server/hr/service';
import type { Employee, AttendanceRecord, Shift } from '@/lib/server/hr/types';
import type { HandlerContext } from '@/lib/server/auth/guard';
import type { OperationsRepository, AssignmentFilter } from './repository';
import {
  notFound, refuse, TASK_TYPES,
  type AssignmentDivergence, type DepartmentCoverage, type Eligibility, type EmployeeMatch,
  type StaffDay, type StaffDayStatus, type StaffingBoard, type TaskAssignment, type TaskType,
} from './types';

/**
 * What the sheet write needs to run the existing verified mutation pipeline AS THE CALLER.
 *
 * Carried rather than reconstructed: that pipeline authenticates, audits and allocates ids
 * from the real request context, and handing it a synthesised one would put a workbook
 * write in the audit trail under an actor who never made it.
 */
export interface SheetWriteContext {
  readonly auth: HandlerContext['auth'];
  readonly requestId: string;
}

/** One operational task, as much of it as this service needs. Never a copy of the row. */
export interface OperationalTask {
  readonly taskRef: string;
  readonly propertyId: string | null;
  /** The name currently written in the sheet, so a divergence is detectable. */
  readonly assigneeName: string | null;
  readonly status: string;
  readonly open: boolean;
}

export interface OperationsServiceDeps {
  hr: HrService;
  assignments: OperationsRepository;
  /**
   * The tasks in THIS TENANT'S OWN workbook.
   *
   * Wired from that tenant's provider, so the only tasks a caller can name are their own —
   * which is what makes a foreign task reference a miss rather than a refusal.
   */
  tasks: (tenant: TenantContext, taskType: TaskType) => Promise<readonly OperationalTask[]>;
  /** The caller's own property identifiers, from their own workbook. */
  propertyIds: (tenant: TenantContext) => Promise<readonly string[]>;
  /**
   * Writes the assignee's NAME into the tenant's workbook — 13_HOUSEKEEPING.Cleaner or
   * 14_MAINTENANCE.AssignedTo — through the existing verified mutation pipeline.
   *
   * Injected rather than called directly so the ordering below is testable, and so this
   * service never reaches a sheets client of its own. The workbook keeps owning the name;
   * this domain owns which employee it refers to.
   */
  writeAssignee: (
    write: SheetWriteContext, taskType: TaskType, taskRef: string, name: string,
  ) => Promise<void>;
  audit: AuditService;
  now?: () => Date;
}

export class OperationsPeopleService {
  constructor(private readonly deps: OperationsServiceDeps) {}

  private today(): string {
    return (this.deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  }

  /* ---------------------------------------------------------------- *
   * Resolving a free-text name — §5
   * ---------------------------------------------------------------- */

  /**
   * What a historical `Cleaner = 'Ravi'` actually refers to, ON THE DAY OF THE WORK.
   *
   * A pure classifier: it never writes, never returns a bare id, and never guesses. Exact
   * comparison on the full and preferred name, normalised the same way the employee-code
   * index normalises — no fuzzy distance and no phonetics, because a near-match resolved
   * automatically is a wrong attribution nobody will ever notice.
   *
   * `asOf` is the turnover's checkout date or the ticket's report date, NOT today. That
   * distinction is the difference between `INACTIVE` — the only Ravi we had, who has since
   * left, and who plausibly did this work — and `HISTORICAL_MISMATCH` — the only Ravi we
   * have, who joined after this task existed, and who certainly did not.
   *
   * Exited people are candidates, because a turnover from March may well have been done by
   * somebody who has since left; excluding them would resolve historical work to the wrong
   * living person.
   */
  async resolveByName(
    tenant: TenantContext, name: string, asOf: string,
  ): Promise<EmployeeMatch> {
    const raw = name ?? '';
    const needle = raw.trim().toLowerCase();
    if (needle === '') return { kind: 'UNRECORDED' };

    const everybody = await this.deps.hr.listEmployees(tenant);
    const matches = everybody.filter((e) => e.fullName.trim().toLowerCase() === needle
      || (e.preferredName ?? '').trim().toLowerCase() === needle);

    if (matches.length === 0) return { kind: 'NO_MATCH', raw: raw.trim() };
    /*
     * Ambiguity stays ambiguity. Not "the active one", not "the most recent" — a person
     * chooses, or nothing is bound.
     */
    if (matches.length > 1) return { kind: 'AMBIGUOUS', candidates: matches };

    const employee = matches[0]!;
    const employedThen = employee.joiningDate <= asOf
      && (employee.exitDate === null || employee.exitDate >= asOf);
    if (!employedThen) return { kind: 'HISTORICAL_MISMATCH', employee, asOf };
    if (employee.status !== 'ACTIVE') {
      return { kind: 'INACTIVE', employee, status: employee.status };
    }
    return { kind: 'EXACT', employee };
  }

  /**
   * Where the workbook and the overlay disagree.
   *
   * Not polish. The moment this application echoes a name into the customer's spreadsheet,
   * that cell becomes a mutable copy of a fact held elsewhere — and it is their file, which
   * they and V1's own menu edit. A supervisor typing over the cell leaves both halves
   * internally consistent and nothing failing, which is the definition of a silent
   * divergence. This is what makes it a reported one.
   *
   * It resolves nothing and prefers neither store: it lists the disagreements for a person.
   */
  async reconcile(tenant: TenantContext): Promise<AssignmentDivergence[]> {
    requireTenant(tenant, 'operations.reconcile');
    const found: AssignmentDivergence[] = [];

    for (const taskType of TASK_TYPES) {
      const [tasks, assignments] = await Promise.all([
        this.deps.tasks(tenant, taskType),
        this.deps.assignments.list(tenant, { taskType, currentOnly: true }),
      ]);
      const byRef = new Map(assignments.map((a) => [a.taskRef, a]));

      for (const task of tasks) {
        const assignment = byRef.get(task.taskRef);
        const sheetName = (task.assigneeName ?? '').trim();

        if (!assignment) {
          // A name with nothing behind it. Every historical row looks like this, so it is
          // reported rather than treated as an error.
          if (sheetName !== '') {
            found.push(Object.freeze({
              taskType, taskRef: task.taskRef, kind: 'UNLINKED_NAME' as const,
              sheetName, echoedName: null, employeeId: null,
            }));
          }
          continue;
        }

        const echoed = assignment.displayNameWritten.trim();
        if (sheetName === '') {
          found.push(Object.freeze({
            taskType, taskRef: task.taskRef, kind: 'ECHO_MISSING' as const,
            sheetName: null, echoedName: echoed, employeeId: assignment.employeeId,
          }));
        } else if (sheetName !== echoed) {
          found.push(Object.freeze({
            taskType, taskRef: task.taskRef, kind: 'SHEET_EDITED' as const,
            sheetName, echoedName: echoed, employeeId: assignment.employeeId,
          }));
        }
      }
    }
    return found;
  }

  /* ---------------------------------------------------------------- *
   * Whether this person may take this work — §18
   * ---------------------------------------------------------------- */

  /**
   * BLOCKED is a decision the business already made; WARN is one a supervisor may make.
   *
   * Calling somebody in on their day off is ordinary hospitality, so it is permitted — but
   * never silently. Giving work to somebody who has left, or whose employment is suspended,
   * is not an override case: those states exist precisely to stop it.
   */
  async eligibilityOf(
    tenant: TenantContext, employee: Employee, isoDate: string,
  ): Promise<Eligibility> {
    if (employee.status === 'EXITED') {
      return { kind: 'BLOCKED', reasons: [`${employee.fullName} has left the business.`] };
    }
    if (employee.status === 'SUSPENDED') {
      return {
        kind: 'BLOCKED',
        reasons: [`${employee.fullName} is suspended, which is a deliberate instruction to stop assigning work.`],
      };
    }

    const reasons: string[] = [];
    if (employee.status === 'ON_LEAVE') reasons.push(`${employee.fullName} is marked as on leave.`);
    if (employee.status === 'NOTICE_PERIOD') reasons.push(`${employee.fullName} is working their notice.`);

    // A weekly off is a rest day, not a prohibition.
    const weekday = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
    if (employee.weeklyOffDay !== null && employee.weeklyOffDay === weekday) {
      reasons.push(`${isoDate} is ${employee.fullName}'s weekly off.`);
    }

    // Approved leave covering the day. Requested-but-unapproved leave is not a reason:
    // nobody has agreed to it yet.
    const leave = await this.deps.hr.listLeaveRequests(tenant, {
      employeeId: employee.id, status: 'APPROVED',
    });
    if (leave.some((l) => l.startDate <= isoDate && l.endDate >= isoDate)) {
      reasons.push(`${employee.fullName} has approved leave covering ${isoDate}.`);
    }

    return reasons.length === 0 ? { kind: 'OK' } : { kind: 'WARN', reasons };
  }

  /* ---------------------------------------------------------------- *
   * Assignment — §19
   * ---------------------------------------------------------------- */

  /**
   * Validates everything and records the assignment, returning the name to write into the
   * sheet.
   *
   * ORDER MATTERS, and the order is: resolve the employee, resolve the task, check the
   * property, check eligibility, then write. Every resolution goes through a store scoped
   * to the caller's own tenant, so a foreign identifier is a miss — the same answer as one
   * that never existed — and the pair (task, employee) can only ever be formed from two
   * things the caller already owns.
   */
  async assign(
    tenant: TenantContext,
    input: {
      taskType: TaskType; taskRef: string; employeeId: string;
      overrideReason?: string | null;
    },
    actor: string,
    write: SheetWriteContext,
  ): Promise<{ assignment: TaskAssignment; nameToWrite: string; warnings: readonly string[] }> {
    requireTenant(tenant, 'operations.assign');

    // The employee, through the tenant-scoped HR repository.
    const employee = await this.deps.hr.getEmployee(tenant, input.employeeId);
    if (!employee) throw notFound('employee');

    // The task, from the caller's OWN workbook. A foreign TaskID simply is not there.
    const task = await this.requireTask(tenant, input.taskType, input.taskRef);

    if (!task.open) {
      throw refuse('TASK_CLOSED',
        `${input.taskRef} is ${task.status.toLowerCase()} and no longer needs assigning.`, 409);
    }

    // The property, against the caller's own list. Belt and braces: the task came from
    // their workbook, so its property is theirs — but a task with a property the workbook
    // no longer lists is a data problem worth surfacing rather than assigning around.
    if (task.propertyId) {
      const owned = await this.deps.propertyIds(tenant);
      if (!owned.includes(task.propertyId)) {
        throw refuse('UNKNOWN_PROPERTY',
          `${input.taskRef} names a property this workbook does not list.`);
      }
    }

    const eligibility = await this.eligibilityOf(tenant, employee, this.today());
    if (eligibility.kind === 'BLOCKED') {
      throw refuse('EMPLOYEE_NOT_ELIGIBLE', eligibility.reasons.join(' '), 409);
    }
    if (eligibility.kind === 'WARN' && !input.overrideReason?.trim()) {
      // Permitted, but never silent. The supervisor says why, and it is recorded.
      throw refuse('OVERRIDE_REQUIRED',
        `${eligibility.reasons.join(' ')} Assigning anyway is a decision for a supervisor to `
        + 'record — supply a reason.', 409);
    }

    const nameToWrite = employee.preferredName?.trim() || employee.fullName;

    /*
     * THE SHEET FIRST, THEN THE OVERLAY, and the order is chosen for what happens when the
     * second write fails — because two stores cannot be written atomically.
     *
     *   sheet then overlay (this order): a failure leaves a NAME in the workbook with no
     *     employee reference. That is indistinguishable from every historical row, which
     *     `resolveByName` already handles honestly, and a retry repairs it — writing the
     *     same name into the same cell twice is the same state.
     *
     *   overlay then sheet: a failure would leave an assignment the partial unique index
     *     then refuses to replace, so the supervisor could not repair it without an
     *     administrator. Worse outcome, so not that order.
     *
     * The whole action sits inside the idempotency envelope, so a retry of the SAME
     * operation replays rather than rewriting.
     */
    await this.deps.writeAssignee(write, input.taskType, input.taskRef, nameToWrite);

    const assignment = await this.deps.assignments.assign(tenant, {
      taskType: input.taskType,
      taskRef: input.taskRef,
      employeeId: employee.id,
      propertyId: task.propertyId,
      displayNameWritten: nameToWrite,
      overrideReason: eligibility.kind === 'WARN' ? (input.overrideReason ?? null) : null,
    }, actor);

    if (!assignment) {
      // The partial unique index refused a second current assignment: somebody else
      // assigned this task between our read and our write.
      throw refuse('ALREADY_ASSIGNED',
        `${input.taskRef} was assigned by somebody else a moment ago. Reload and decide again.`,
        409);
    }

    return {
      assignment,
      nameToWrite,
      warnings: eligibility.kind === 'WARN' ? eligibility.reasons : [],
    };
  }

  private async requireTask(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<OperationalTask> {
    const tasks = await this.deps.tasks(tenant, taskType);
    const task = tasks.find((t) => t.taskRef === taskRef);
    if (!task) throw notFound(taskType === 'HOUSEKEEPING' ? 'housekeeping task' : 'maintenance ticket');
    return task;
  }

  /** The current assignment for one task, with a divergence flag. */
  async currentFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<AssignmentView | null> {
    const assignment = await this.deps.assignments.currentFor(tenant, taskType, taskRef);
    if (!assignment) return null;
    const employee = await this.deps.hr.getEmployee(tenant, assignment.employeeId);
    const task = (await this.deps.tasks(tenant, taskType)).find((t) => t.taskRef === taskRef);
    // `undefined` when the task itself is gone: nothing to compare against, so nothing is
    // claimed about agreement.
    return this.decorate(assignment, employee, task ? task.assigneeName : undefined);
  }

  async historyFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<AssignmentView[]> {
    const rows = await this.deps.assignments.historyFor(tenant, taskType, taskRef);
    // History is about who WAS on the task; the sheet only ever reflects the current
    // assignment, so comparing a superseded row against it would report a false divergence.
    return Promise.all(rows.map(async (row) => this.decorate(
      row, await this.deps.hr.getEmployee(tenant, row.employeeId), undefined,
    )));
  }

  list(tenant: TenantContext, filter: AssignmentFilter = {}): Promise<TaskAssignment[]> {
    return this.deps.assignments.list(tenant, filter);
  }

  /**
   * Attaches the employee to an assignment, and reports whether the sheet still agrees.
   *
   * `sheetDiverged` is true when the name currently in the workbook is not the name this
   * application wrote. Somebody typed over the cell, and neither store is quietly preferred
   * — the disagreement is surfaced so a person can settle it.
   */
  private decorate(
    assignment: TaskAssignment, employee: Employee | null,
    sheetName: string | null | undefined,
  ): AssignmentView {
    return Object.freeze({
      assignment,
      employeeCode: employee?.employeeCode ?? null,
      // A person who has since left still shows their name: the history is about who did
      // the work, not who is on the books today.
      displayName: employee ? (employee.preferredName?.trim() || employee.fullName) : null,
      employeeStatus: employee?.status ?? null,
      /*
       * `undefined` means the sheet was not consulted; `null` or blank means it WAS and the
       * cell is empty, which is itself a divergence — an assignment exists that the workbook
       * does not reflect. Either way neither store is quietly preferred: the disagreement is
       * reported so a person settles it.
       */
      sheetDiverged: sheetName !== undefined
        && (sheetName ?? '').trim() !== assignment.displayNameWritten.trim(),
      sheetName: sheetName ?? null,
    });
  }

  /* ---------------------------------------------------------------- *
   * Today's staffing — §6 to §9
   * ---------------------------------------------------------------- */

  /**
   * Who is working, where, on what shift, and where the gaps are.
   *
   * Attendance is read from HR and NOT recomputed: this assembles, it does not decide. Only
   * APPROVED attendance counts — a day somebody submitted but nobody reviewed is still
   * `NOT_RECORDED`, which is the same rule payroll follows and for the same reason.
   *
   * A day with no record is `NOT_RECORDED`, never `ABSENT`. Nobody said the person was
   * away; nobody said anything. `gaps` counts the people that is true of, and calling it a
   * gap rather than an absence is the whole point.
   */
  async staffingBoard(
    tenant: TenantContext, isoDate: string, propertyId?: string,
  ): Promise<StaffingBoard> {
    requireTenant(tenant, 'operations.staffing');

    if (propertyId) {
      const owned = await this.deps.propertyIds(tenant);
      // A property the caller does not own is refused identically to one that does not
      // exist — the question is only ever asked of their own workbook.
      if (!owned.includes(propertyId)) throw notFound('property');
    }

    const [employees, attendance, shifts, departments] = await Promise.all([
      this.deps.hr.listEmployees(tenant),
      this.deps.hr.listAttendance(tenant, { from: isoDate, to: isoDate, approval: 'APPROVED' }),
      this.deps.hr.listShifts(tenant),
      this.deps.hr.listDepartments(tenant),
    ]);

    const onTheBooks = employees.filter((e) => e.status !== 'EXITED');
    const inScope = propertyId
      ? onTheBooks.filter((e) => e.primaryPropertyId === propertyId)
      : onTheBooks;

    const shiftsById = new Map(shifts.map((s) => [s.id, s]));
    const attendanceByEmployee = new Map(attendance.map((a) => [a.employeeId, a]));
    const openByEmployee = await this.openTaskCounts(tenant);

    const staff: StaffDay[] = inScope.map((employee) => {
      const record = attendanceByEmployee.get(employee.id) ?? null;
      const shift = record?.shiftId ? shiftsById.get(record.shiftId) ?? null : null;
      return Object.freeze({
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        displayName: employee.preferredName?.trim() || employee.fullName,
        designationId: employee.designationId,
        departmentId: employee.departmentId,
        propertyId: employee.primaryPropertyId,
        shiftName: shift?.name ?? null,
        shiftStart: shift?.startTime ?? null,
        shiftEnd: shift?.endTime ?? null,
        // An overnight shift is ordinary, and the flag travels so the interface can say
        // "22:00–06:00 (next day)" rather than rendering it as a negative span.
        crossesMidnight: shift?.crossesMidnight ?? false,
        status: statusOf(record, employee.weeklyOffDay, isoDate),
        late: record?.late ?? false,
        earlyExit: record?.earlyExit ?? false,
        approved: record !== null,
        openTasks: openByEmployee.get(employee.id) ?? 0,
      });
    });

    return Object.freeze({
      date: isoDate,
      propertyId: propertyId ?? null,
      staff,
      coverage: coverageOf(staff, departments),
      // Never guessed at: somebody with no property assignment is shown as unassigned
      // rather than attributed to whichever property sorts first.
      unassigned: onTheBooks.filter((e) => e.primaryPropertyId === null).length,
    });
  }

  private async openTaskCounts(tenant: TenantContext): Promise<Map<string, number>> {
    const assignments = await this.deps.assignments.list(tenant, { currentOnly: true });
    const [housekeeping, maintenance] = await Promise.all([
      this.deps.tasks(tenant, 'HOUSEKEEPING'),
      this.deps.tasks(tenant, 'MAINTENANCE'),
    ]);
    const open = new Set([
      ...housekeeping.filter((t) => t.open).map((t) => `HOUSEKEEPING|${t.taskRef}`),
      ...maintenance.filter((t) => t.open).map((t) => `MAINTENANCE|${t.taskRef}`),
    ]);

    const counts = new Map<string, number>();
    for (const assignment of assignments) {
      if (!open.has(`${assignment.taskType}|${assignment.taskRef}`)) continue;
      counts.set(assignment.employeeId, (counts.get(assignment.employeeId) ?? 0) + 1);
    }
    return counts;
  }

  /* ---------------------------------------------------------------- *
   * Reporting — §25
   * ---------------------------------------------------------------- */

  /**
   * Operational counts, computed once and on the server.
   *
   * Deliberately no per-employee productivity score and no ranking: turning task counts
   * into a comparison between people is an appraisal, and whether this business appraises
   * on task volume is a decision nobody has made. Counts by property answer the operational
   * question — where is work piling up — without becoming one about individuals.
   */
  async operationsMetrics(
    tenant: TenantContext, propertyId?: string,
  ): Promise<OperationsMetrics> {
    requireTenant(tenant, 'operations.metrics');
    const [housekeeping, maintenance, assignments] = await Promise.all([
      this.deps.tasks(tenant, 'HOUSEKEEPING'),
      this.deps.tasks(tenant, 'MAINTENANCE'),
      this.deps.assignments.list(tenant, { currentOnly: true }),
    ]);

    const scope = (tasks: readonly OperationalTask[]) =>
      (propertyId ? tasks.filter((t) => t.propertyId === propertyId) : tasks);
    const hk = scope(housekeeping);
    const mt = scope(maintenance);
    const assignedRefs = new Set(assignments.map((a) => `${a.taskType}|${a.taskRef}`));

    const unassigned = (tasks: readonly OperationalTask[], type: TaskType) =>
      tasks.filter((t) => t.open && !assignedRefs.has(`${type}|${t.taskRef}`));

    return Object.freeze({
      housekeepingOpen: hk.filter((t) => t.open).length,
      housekeepingUnassigned: unassigned(hk, 'HOUSEKEEPING').length,
      maintenanceOpen: mt.filter((t) => t.open).length,
      maintenanceUnassigned: unassigned(mt, 'MAINTENANCE').length,
      assignedOpen: [...hk, ...mt].filter((t) => t.open).length
        - unassigned(hk, 'HOUSEKEEPING').length - unassigned(mt, 'MAINTENANCE').length,
    });
  }
}

export interface AssignmentView {
  readonly assignment: TaskAssignment;
  readonly employeeCode: string | null;
  readonly displayName: string | null;
  readonly employeeStatus: string | null;
  /** The workbook cell no longer matches what this application wrote. Surfaced, not hidden. */
  readonly sheetDiverged: boolean;
  readonly sheetName: string | null;
}

export interface OperationsMetrics {
  readonly housekeepingOpen: number;
  readonly housekeepingUnassigned: number;
  readonly maintenanceOpen: number;
  readonly maintenanceUnassigned: number;
  readonly assignedOpen: number;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function statusOf(
  record: AttendanceRecord | null, weeklyOffDay: number | null, isoDate: string,
): StaffDayStatus {
  // Approved attendance is the authority when it exists.
  if (record) return record.status;
  // Otherwise a weekly off explains the silence; nothing else does.
  const weekday = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  if (weeklyOffDay !== null && weeklyOffDay === weekday) return 'WEEKLY_OFF';
  return 'NOT_RECORDED';
}

function coverageOf(
  staff: readonly StaffDay[],
  departments: readonly { id: string; name: string }[],
): DepartmentCoverage[] {
  const names = new Map(departments.map((d) => [d.id, d.name]));
  const groups = new Map<string, StaffDay[]>();
  for (const person of staff) {
    const key = person.departmentId ?? '';
    const bucket = groups.get(key) ?? [];
    bucket.push(person);
    groups.set(key, bucket);
  }

  return [...groups.entries()].map(([key, people]) => Object.freeze({
    departmentId: key === '' ? null : key,
    departmentName: key === '' ? 'No department' : (names.get(key) ?? 'Unknown department'),
    scheduled: people.length,
    present: people.filter((p) => p.status === 'PRESENT' || p.status === 'HALF_DAY').length,
    absent: people.filter((p) => p.status === 'ABSENT').length,
    onLeave: people.filter((p) => p.status === 'LEAVE').length,
    weeklyOff: people.filter((p) => p.status === 'WEEKLY_OFF').length,
    notRecorded: people.filter((p) => p.status === 'NOT_RECORDED').length,
    late: people.filter((p) => p.late).length,
    // A gap is somebody expected today whose day nobody has recorded and whom no leave or
    // rest day explains. It is NOT an absence — nobody has said they are away.
    gaps: people.filter((p) => p.status === 'NOT_RECORDED').length,
  })).sort((a, b) => a.departmentName.localeCompare(b.departmentName));
}
