import '@/lib/server/only';
/**
 * WHAT AN OPERATIONS SUPERVISOR MAY SEE OF A PERSON.
 *
 * §20 of the brief is a list of seven things they need — name, code, department,
 * designation, shift, attendance status, assigned tasks — and six they must not: salary,
 * compensation, payroll, bank details, HR documents, sensitive fields.
 *
 * The withholding is structural rather than filtered. `StaffDay` never carried a pay field,
 * a contact reference or an email in the first place, so these projections cannot drop what
 * was never assembled — the same property that makes the HR employee record unable to leak
 * salary. The `Disjoint` guards below refuse to compile if that ever stops being true.
 *
 * Contact details are withheld deliberately even though they are not sensitive in the way
 * pay is. A staffing board answers "is tonight covered?", and nothing on it needs to be a
 * way of reaching people — which is exactly why `operations.staff.read` exists instead of
 * granting `hr.read`, whose `/api/hr/employees` carries both.
 */
import type {
  StaffingBoard, StaffDay, DepartmentCoverage,
  NamedEmployee, ReconciliationReport, TaskReconciliation, UnassignedUrgentTask,
} from './types';
import type { AssignmentView, OperationsMetrics } from './service';

export interface StaffDayView {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  readonly departmentId: string | null;
  readonly designationId: string | null;
  readonly propertyId: string | null;
  readonly shiftName: string | null;
  readonly shiftStart: string | null;
  readonly shiftEnd: string | null;
  /** So an overnight shift renders as 22:00–06:00 (next day) rather than a negative span. */
  readonly crossesMidnight: boolean;
  readonly status: string;
  readonly late: boolean;
  readonly earlyExit: boolean;
  readonly openTasks: number;
}

export interface CoverageView {
  readonly departmentId: string | null;
  readonly departmentName: string;
  readonly scheduled: number;
  readonly present: number;
  readonly absent: number;
  readonly onLeave: number;
  readonly weeklyOff: number;
  readonly notRecorded: number;
  readonly late: number;
  readonly gaps: number;
}

export interface StaffingBoardView {
  readonly date: string;
  readonly propertyId: string | null;
  readonly staff: readonly StaffDayView[];
  readonly coverage: readonly CoverageView[];
  readonly unassigned: number;
}

export function staffDayView(day: StaffDay): StaffDayView {
  return {
    employeeId: day.employeeId,
    employeeCode: day.employeeCode,
    displayName: day.displayName,
    departmentId: day.departmentId,
    designationId: day.designationId,
    propertyId: day.propertyId,
    shiftName: day.shiftName,
    shiftStart: day.shiftStart,
    shiftEnd: day.shiftEnd,
    crossesMidnight: day.crossesMidnight,
    status: day.status,
    late: day.late,
    earlyExit: day.earlyExit,
    openTasks: day.openTasks,
  };
}

function coverageView(row: DepartmentCoverage): CoverageView {
  return {
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    scheduled: row.scheduled,
    present: row.present,
    absent: row.absent,
    onLeave: row.onLeave,
    weeklyOff: row.weeklyOff,
    notRecorded: row.notRecorded,
    late: row.late,
    gaps: row.gaps,
  };
}

export function staffingView(board: StaffingBoard): StaffingBoardView {
  return {
    date: board.date,
    propertyId: board.propertyId,
    staff: board.staff.map(staffDayView),
    coverage: board.coverage.map(coverageView),
    unassigned: board.unassigned,
  };
}

export interface TaskAssignmentView {
  readonly id: string;
  readonly taskType: string;
  readonly taskRef: string;
  readonly employeeId: string;
  readonly employeeCode: string | null;
  /** A human name, never a bare identifier — §10. */
  readonly displayName: string | null;
  readonly propertyId: string | null;
  readonly assignedAt: string;
  readonly supersededAt: string | null;
  readonly overrideReason: string | null;
  /**
   * The workbook cell no longer matches what this application wrote — somebody edited the
   * sheet by hand. Surfaced rather than resolved: neither store is quietly preferred.
   */
  readonly sheetDiverged: boolean;
  readonly sheetName: string | null;
}

export function assignmentView(view: AssignmentView): TaskAssignmentView {
  return {
    id: view.assignment.id,
    taskType: view.assignment.taskType,
    taskRef: view.assignment.taskRef,
    employeeId: view.assignment.employeeId,
    employeeCode: view.employeeCode,
    displayName: view.displayName,
    propertyId: view.assignment.propertyId,
    assignedAt: view.assignment.assignedAt,
    supersededAt: view.assignment.supersededAt,
    overrideReason: view.assignment.overrideReason,
    sheetDiverged: view.sheetDiverged,
    sheetName: view.sheetName,
  };
}

export interface OperationsMetricsView {
  readonly housekeepingOpen: number;
  readonly housekeepingUnassigned: number;
  readonly maintenanceOpen: number;
  readonly maintenanceUnassigned: number;
  readonly assignedOpen: number;
}

export function metricsView(metrics: OperationsMetrics): OperationsMetricsView {
  return {
    housekeepingOpen: metrics.housekeepingOpen,
    housekeepingUnassigned: metrics.housekeepingUnassigned,
    maintenanceOpen: metrics.maintenanceOpen,
    maintenanceUnassigned: metrics.maintenanceUnassigned,
    assignedOpen: metrics.assignedOpen,
  };
}

/* ------------------------------------------------------------------ *
 * Reconciliation and urgent work — M-OPS-3
 * ------------------------------------------------------------------ */

/**
 * A person, as a screen should name one.
 *
 * `employeeId` travels because the assign control has to submit something, and a name is not
 * an identifier — two people share one. It is a VALUE, never a label: nothing renders it,
 * and the reconciliation table shows `displayName` and `employeeCode`.
 */
export interface NamedEmployeeView {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
}

export interface ReconciliationRowView {
  readonly taskType: string;
  readonly taskRef: string;
  readonly propertyId: string | null;
  readonly occurredOn: string;
  readonly title: string | null;
  readonly status: string;
  readonly sheetName: string | null;
  readonly employee: NamedEmployeeView | null;
  readonly candidates: readonly NamedEmployeeView[];
  readonly recommendation: string;
}

export interface ReconciliationReportView {
  readonly summary: {
    readonly matched: number;
    readonly needsReview: number;
    readonly unlinked: number;
    readonly ambiguous: number;
    readonly total: number;
  };
  readonly rows: readonly ReconciliationRowView[];
}

export interface UnassignedUrgentView {
  readonly key: string;
  readonly taskType: string;
  readonly taskRef: string;
  readonly propertyId: string | null;
  readonly priority: string;
  readonly title: string;
  readonly reportedOn: string;
  readonly ageDays: number;
}

function namedView(employee: NamedEmployee): NamedEmployeeView {
  return {
    employeeId: employee.employeeId,
    employeeCode: employee.employeeCode,
    displayName: employee.displayName,
  };
}

/** Fresh literals, never a spread — the same rule the rest of this file follows. */
export function reconciliationRowView(row: TaskReconciliation): ReconciliationRowView {
  return {
    taskType: row.taskType,
    taskRef: row.taskRef,
    propertyId: row.propertyId,
    occurredOn: row.occurredOn,
    title: row.title,
    status: row.status,
    sheetName: row.sheetName,
    employee: row.employee ? namedView(row.employee) : null,
    candidates: row.candidates.map(namedView),
    recommendation: row.recommendation,
  };
}

export function reconciliationView(report: ReconciliationReport): ReconciliationReportView {
  return {
    summary: {
      matched: report.summary.matched,
      needsReview: report.summary.needsReview,
      unlinked: report.summary.unlinked,
      ambiguous: report.summary.ambiguous,
      total: report.summary.total,
    },
    rows: report.rows.map(reconciliationRowView),
  };
}

export function unassignedUrgentView(task: UnassignedUrgentTask): UnassignedUrgentView {
  return {
    key: task.key,
    taskType: task.taskType,
    taskRef: task.taskRef,
    propertyId: task.propertyId,
    priority: task.priority,
    title: task.title,
    reportedOn: task.reportedOn,
    ageDays: task.ageDays,
  };
}

/* ------------------------------------------------------------------ *
 * Compile-time guards
 * ------------------------------------------------------------------ */

/** `true` only when T carries no key from F. */
type Disjoint<T, F extends PropertyKey> = Extract<keyof T, F> extends never ? true : never;

/**
 * The six things §20 says an operations login must never receive, plus the tenant and the
 * actor fields every other domain withholds. These lines are what refuse to compile if one
 * is ever added to a projected type.
 */
type Withheld =
  | 'salary' | 'gross' | 'net' | 'deductions' | 'ctc' | 'wage' | 'compensation' | 'payroll'
  | 'bankAccount' | 'contactRef' | 'email' | 'tenantId' | 'assignedBy' | 'createdBy';

export const STAFF_DAY_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<StaffDayView, Withheld> = true;
export const STAFFING_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<StaffingBoardView, Withheld> = true;
export const COVERAGE_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<CoverageView, Withheld> = true;
export const ASSIGNMENT_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<TaskAssignmentView, Withheld> = true;
export const METRICS_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<OperationsMetricsView, Withheld> = true;
export const RECONCILIATION_ROW_CARRIES_NOTHING_WITHHELD:
  Disjoint<ReconciliationRowView, Withheld> = true;
export const NAMED_EMPLOYEE_CARRIES_NOTHING_WITHHELD:
  Disjoint<NamedEmployeeView, Withheld> = true;
export const URGENT_VIEW_CARRIES_NOTHING_WITHHELD:
  Disjoint<UnassignedUrgentView, Withheld> = true;
