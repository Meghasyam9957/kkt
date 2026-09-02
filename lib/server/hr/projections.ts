import '@/lib/server/only';
/**
 * WHAT A ROLE MAY SEE OF A PERSON.
 *
 * The split that matters in HR is not read-versus-write, it is PERSON versus PAY. Somebody
 * who may see that a colleague was late is not thereby somebody who may see what that
 * colleague earns, and the capability model says so: `hr.read` covers attendance, leave
 * and shifts; `hr.compensation.read` covers salary, advances and payroll.
 *
 * ONE STRUCTURAL PROPERTY DOES MOST OF THE WORK, and it is worth naming because it is
 * cheaper than any check: **the employee record carries no compensation field at all.**
 * Salary lives in `hr_salary_structures`, payroll in `hr_payroll_lines`, advances in
 * `hr_employee_advances` — so `employeeView` cannot leak pay even if somebody adds a field
 * to it carelessly, because there is no pay on the record it projects. A boundary drawn in
 * the schema needs no discipline to hold.
 *
 * Everything else follows `lib/data/views/role-projections.ts` and
 * `lib/server/finance/projections.ts`: fresh object literals, never a spread, with
 * compile-time `Disjoint` guards that refuse to build if a withheld field is ever added to
 * a projected type. A reviewer can miss a new field; a compiler cannot.
 */
import type {
  Employee, AttendanceRecord, LeaveRequest, LeaveBalance, OvertimeRecord,
  EmployeeAdvance, PayrollRun, PayrollLine, SalaryStructureWithComponents,
  Shift, Department, Designation,
} from './types';
import type { AdvanceBalanceSummary, WorkforceSummary } from './service';

/**
 * Fields that must never reach a browser payload.
 *
 * `tenantId` heads the list for the same reason it does in finance: a client that knows
 * its own tenant id gains nothing, and a client that learns another one has an identifier
 * to try. The actor fields follow — who approved a leave request is an internal audit
 * fact, and a payload that names it turns every list into a directory of who does what.
 */
export const HR_FIELDS_WITHHELD_FROM_CLIENTS = [
  'tenantId', 'createdBy', 'approvedBy', 'requestedBy', 'postedBy', 'structureId',
] as const;

export interface MoneyView { readonly minor: number; readonly currency: string }

function moneyView(minor: number, currency: string): MoneyView {
  return { minor, currency };
}

/* ------------------------------------------------------------------ *
 * Person — `hr.read`
 * ------------------------------------------------------------------ */

export interface EmployeeView {
  readonly id: string;
  readonly employeeCode: string;
  readonly fullName: string;
  readonly preferredName: string | null;
  /** One operational contact. Needed to reach the person on shift; not a contact database. */
  readonly contactRef: string | null;
  readonly email: string | null;
  readonly departmentId: string | null;
  readonly designationId: string | null;
  readonly employmentType: string;
  readonly joiningDate: string;
  readonly exitDate: string | null;
  readonly status: string;
  readonly primaryPropertyId: string | null;
  readonly managerId: string | null;
  readonly weeklyOffDay: number | null;
}

export function employeeView(employee: Employee): EmployeeView {
  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    preferredName: employee.preferredName,
    contactRef: employee.contactRef,
    email: employee.email,
    departmentId: employee.departmentId,
    designationId: employee.designationId,
    employmentType: employee.employmentType,
    joiningDate: employee.joiningDate,
    exitDate: employee.exitDate,
    status: employee.status,
    primaryPropertyId: employee.primaryPropertyId,
    managerId: employee.managerId,
    weeklyOffDay: employee.weeklyOffDay,
  };
}

/**
 * The roster view — who is on, where, and in what role.
 *
 * Narrower than `employeeView` on purpose: it drops the contact reference, the email and
 * the reporting line, because a staffing board answers "is this shift covered?" and
 * nothing on it needs to be a way of reaching people. It exists so a future operations
 * grant of `hr.read` has something correct to render rather than the full record.
 */
export interface RosterEmployeeView {
  readonly id: string;
  readonly employeeCode: string;
  readonly fullName: string;
  readonly designationId: string | null;
  readonly primaryPropertyId: string | null;
  readonly status: string;
}

export function rosterEmployeeView(employee: Employee): RosterEmployeeView {
  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    designationId: employee.designationId,
    primaryPropertyId: employee.primaryPropertyId,
    status: employee.status,
  };
}

export interface AttendanceView {
  readonly id: string;
  readonly employeeId: string;
  readonly attendanceDate: string;
  readonly shiftId: string | null;
  readonly propertyId: string | null;
  readonly status: string;
  readonly checkInAt: string | null;
  readonly checkOutAt: string | null;
  readonly late: boolean;
  readonly earlyExit: boolean;
  readonly overtimeMinutes: number;
  readonly approval: string;
  readonly notes: string | null;
}

export function attendanceView(record: AttendanceRecord): AttendanceView {
  return {
    id: record.id,
    employeeId: record.employeeId,
    attendanceDate: record.attendanceDate,
    shiftId: record.shiftId,
    propertyId: record.propertyId,
    status: record.status,
    checkInAt: record.checkInAt,
    checkOutAt: record.checkOutAt,
    late: record.late,
    earlyExit: record.earlyExit,
    overtimeMinutes: record.overtimeMinutes,
    approval: record.approval,
    notes: record.notes,
  };
}

export interface LeaveRequestView {
  readonly id: string;
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly halfDays: number;
  readonly reason: string | null;
  readonly status: string;
  readonly decisionNote: string | null;
}

export function leaveRequestView(request: LeaveRequest): LeaveRequestView {
  return {
    id: request.id,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    startDate: request.startDate,
    endDate: request.endDate,
    halfDays: request.halfDays,
    reason: request.reason,
    status: request.status,
    decisionNote: request.decisionNote,
  };
}

export interface LeaveBalanceView {
  readonly leaveTypeId: string;
  readonly leaveTypeCode: string;
  readonly allocatedHalfDays: number;
  readonly takenHalfDays: number;
  readonly availableHalfDays: number;
}

export function leaveBalanceView(balance: LeaveBalance): LeaveBalanceView {
  return {
    leaveTypeId: balance.leaveTypeId,
    leaveTypeCode: balance.leaveTypeCode,
    allocatedHalfDays: balance.allocatedHalfDays,
    takenHalfDays: balance.takenHalfDays,
    availableHalfDays: balance.availableHalfDays,
  };
}

export interface OvertimeView {
  readonly id: string;
  readonly employeeId: string;
  readonly overtimeDate: string;
  readonly minutes: number;
  readonly propertyId: string | null;
  readonly reason: string;
  readonly status: string;
}

export function overtimeView(record: OvertimeRecord): OvertimeView {
  return {
    id: record.id,
    employeeId: record.employeeId,
    overtimeDate: record.overtimeDate,
    minutes: record.minutes,
    propertyId: record.propertyId,
    reason: record.reason,
    status: record.status,
  };
}

export interface ShiftView {
  readonly id: string;
  readonly name: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly crossesMidnight: boolean;
  readonly graceMinutes: number;
  readonly status: string;
}

export function shiftView(shift: Shift): ShiftView {
  return {
    id: shift.id,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    crossesMidnight: shift.crossesMidnight,
    graceMinutes: shift.graceMinutes,
    status: shift.status,
  };
}

export interface NamedView { readonly id: string; readonly name: string; readonly status: string }

export function departmentView(row: Department): NamedView {
  return { id: row.id, name: row.name, status: row.status };
}

export function designationView(row: Designation): NamedView {
  return { id: row.id, name: row.name, status: row.status };
}

/* ------------------------------------------------------------------ *
 * Pay — `hr.compensation.read`
 *
 * Everything below carries money. Nothing below is reachable with `hr.read` alone, and
 * the route registry enforces that rather than these functions.
 * ------------------------------------------------------------------ */

export interface SalaryComponentView {
  readonly code: string;
  readonly kind: string;
  readonly amount: MoneyView;
}

export interface SalaryStructureView {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly components: readonly SalaryComponentView[];
  readonly grossEarnings: MoneyView;
  readonly fixedDeductions: MoneyView;
}

export function salaryStructureView(structure: SalaryStructureWithComponents): SalaryStructureView {
  return {
    id: structure.id,
    employeeId: structure.employeeId,
    effectiveFrom: structure.effectiveFrom,
    effectiveTo: structure.effectiveTo,
    components: structure.components.map((c) => ({
      code: c.code, kind: c.kind, amount: moneyView(c.amount, structure.currency),
    })),
    grossEarnings: moneyView(structure.grossEarnings, structure.currency),
    fixedDeductions: moneyView(structure.fixedDeductions, structure.currency),
  };
}

export interface AdvanceView {
  readonly id: string;
  readonly employeeId: string;
  readonly issuedOn: string;
  readonly amount: MoneyView;
  readonly reason: string;
  readonly status: string;
}

export function advanceView(advance: EmployeeAdvance): AdvanceView {
  return {
    id: advance.id,
    employeeId: advance.employeeId,
    issuedOn: advance.issuedOn,
    amount: moneyView(advance.amount, advance.currency),
    reason: advance.reason,
    status: advance.status,
  };
}

export interface AdvanceBalanceView {
  readonly employeeId: string;
  readonly issued: MoneyView;
  readonly recovered: MoneyView;
  readonly outstanding: MoneyView;
}

export function advanceBalanceView(summary: AdvanceBalanceSummary, currency = 'INR'): AdvanceBalanceView {
  return {
    employeeId: summary.employeeId,
    issued: moneyView(summary.issued, currency),
    recovered: moneyView(summary.recovered, currency),
    outstanding: moneyView(summary.outstanding, currency),
  };
}

export interface PayrollRunView {
  readonly id: string;
  readonly periodStart: string;
  readonly status: string;
  readonly postedAt: string | null;
  readonly notes: string | null;
}

export function payrollRunView(run: PayrollRun): PayrollRunView {
  return {
    id: run.id,
    periodStart: run.periodStart,
    status: run.status,
    postedAt: run.postedAt,
    notes: run.notes,
  };
}

/**
 * A payslip line, with the counts that produced it.
 *
 * `unrecordedDays` crosses to the client deliberately. It is the field that stops a
 * plausible-looking total being approved over a month nobody finished recording, and a
 * number is only as trustworthy as the gaps beside it.
 */
export interface PayrollLineView {
  readonly id: string;
  readonly employeeId: string;
  readonly gross: MoneyView;
  readonly deductions: MoneyView;
  readonly advanceRecovery: MoneyView;
  readonly net: MoneyView;
  readonly payableDays: number;
  readonly leaveDays: number;
  readonly absentDays: number;
  readonly unrecordedDays: number;
  readonly overtimeMinutes: number;
  readonly notes: string | null;
}

export function payrollLineView(line: PayrollLine): PayrollLineView {
  return {
    id: line.id,
    employeeId: line.employeeId,
    gross: moneyView(line.gross, line.currency),
    deductions: moneyView(line.deductions, line.currency),
    advanceRecovery: moneyView(line.advanceRecovery, line.currency),
    net: moneyView(line.net, line.currency),
    payableDays: line.payableDays,
    leaveDays: line.leaveDays,
    absentDays: line.absentDays,
    unrecordedDays: line.unrecordedDays,
    overtimeMinutes: line.overtimeMinutes,
    notes: line.notes,
  };
}

/* ------------------------------------------------------------------ *
 * The workforce summary — split by what it discloses
 * ------------------------------------------------------------------ */

export interface WorkforceView {
  readonly headcount: number;
  readonly onLeave: number;
  readonly exited: number;
  readonly headcountByProperty: ReadonlyArray<{ propertyId: string; count: number }>;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly leaveDays: number;
  readonly overtimeMinutes: number;
  readonly payrollStatus: string | null;
  /** Present only for a caller who may see compensation. */
  readonly payrollNet: MoneyView | null;
  readonly salaryCostByProperty: ReadonlyArray<{ propertyId: string; cost: MoneyView }> | null;
  readonly linesWithGaps: number;
}

/**
 * `includeCompensation` decides whether the money halves are present at ALL — they are not
 * rendered as null and then hidden, they are simply not built. A payload that carries a
 * figure the client is told not to show has already disclosed it.
 *
 * A caveat worth stating rather than engineering around: a per-property salary total over
 * a property with one employee IS that employee's pay. That is not a new disclosure here,
 * because the only capability that reaches this breakdown (`hr.compensation.read`) also
 * reaches the payroll lines themselves. It becomes a real one the day a role is given
 * aggregates without lines, and that role does not exist — see
 * docs/MHR1_HR_ARCHITECTURE.md §12.
 */
export function workforceView(
  summary: WorkforceSummary,
  options: { includeCompensation: boolean; currency?: string },
): WorkforceView {
  const currency = options.currency ?? 'INR';
  return {
    headcount: summary.headcount,
    onLeave: summary.onLeave,
    exited: summary.exited,
    headcountByProperty: summary.headcountByProperty.map((p) => ({ ...p })),
    presentDays: summary.presentDays,
    absentDays: summary.absentDays,
    leaveDays: summary.leaveDays,
    overtimeMinutes: summary.overtimeMinutes,
    payrollStatus: summary.payrollStatus,
    payrollNet: options.includeCompensation ? moneyView(summary.payrollNet, currency) : null,
    salaryCostByProperty: options.includeCompensation
      ? summary.salaryCostByProperty.map((p) => ({
        propertyId: p.propertyId, cost: moneyView(p.cost, currency),
      }))
      : null,
    linesWithGaps: summary.linesWithGaps,
  };
}

/* ------------------------------------------------------------------ *
 * Compile-time guards
 *
 * If a withheld field is ever added to one of these types, these are the lines that refuse
 * to compile. Exported so no lint rule ever tidies them away.
 * ------------------------------------------------------------------ */

/** `true` only when T carries no key from F. */
type Disjoint<T, F extends PropertyKey> = Extract<keyof T, F> extends never ? true : never;

type Withheld = (typeof HR_FIELDS_WITHHELD_FROM_CLIENTS)[number];

export const EMPLOYEE_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<EmployeeView, Withheld> = true;
export const ROSTER_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<RosterEmployeeView, Withheld> = true;
export const ATTENDANCE_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<AttendanceView, Withheld> = true;
export const LEAVE_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<LeaveRequestView, Withheld> = true;
export const OVERTIME_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<OvertimeView, Withheld> = true;
export const ADVANCE_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<AdvanceView, Withheld> = true;
export const SALARY_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<SalaryStructureView, Withheld> = true;
export const PAYROLL_RUN_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<PayrollRunView, Withheld> = true;
export const PAYROLL_LINE_VIEW_CARRIES_NOTHING_WITHHELD: Disjoint<PayrollLineView, Withheld> = true;

/**
 * The compensation guard, and the one that matters most.
 *
 * A person's record must carry no pay, so that the roster and employee views cannot leak
 * it however carelessly they are edited later. These fail to compile if a salary-shaped
 * field is ever added to either.
 */
type PayShaped = 'salary' | 'gross' | 'net' | 'deductions' | 'amount' | 'ctc' | 'wage';
export const EMPLOYEE_VIEW_CARRIES_NO_PAY: Disjoint<EmployeeView, PayShaped> = true;
export const ROSTER_VIEW_CARRIES_NO_PAY: Disjoint<RosterEmployeeView, PayShaped> = true;
export const ATTENDANCE_VIEW_CARRIES_NO_PAY: Disjoint<AttendanceView, PayShaped> = true;
