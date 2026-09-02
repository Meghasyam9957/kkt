import '@/lib/server/only';
/**
 * THE PEOPLE DOMAIN.
 *
 * Four facts, kept apart on purpose, because collapsing any two of them is how a payroll
 * system starts lying:
 *
 *   ATTENDANCE   somebody was at work        — observed, then approved by a person
 *   OBLIGATION   somebody is owed money      — a payroll line, produced by calculation
 *   SETTLEMENT   money actually moved        — a finance payment, and finance owns it
 *   EXPENSE      a cost was incurred         — the workbook's, and untouched by any of this
 *
 * A payroll run does not pay anybody. It produces obligations; money moves when finance
 * posts a payment against them. That is why `PayrollStatus` has no PAID value — see the
 * comment on it.
 *
 * DATA MINIMISATION runs through the whole file. There is no date of birth, no gender, no
 * national identifier, no bank account and no address, because nothing here needs them and
 * a field that exists is a field something eventually writes to.
 */
import type { Paise, CurrencyCode } from '@/lib/server/finance/money';

/* ------------------------------------------------------------------ *
 * Lifecycles
 * ------------------------------------------------------------------ */

export const EMPLOYMENT_STATUSES = [
  'ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'NOTICE_PERIOD', 'EXITED',
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'CASUAL';
export type EntityStatus = 'ACTIVE' | 'INACTIVE';

/**
 * What a day WAS. Six values, none overlapping.
 *
 * LATE and EARLY_EXIT are flags on the record rather than statuses, because somebody who
 * arrived late was still present — and making lateness a status quietly removes them from
 * every worked-day count that filters on PRESENT.
 */
export const ATTENDANCE_STATUSES = [
  'PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Which statuses put a person at work. Payroll counts these and nothing else. */
export function isWorkedStatus(status: AttendanceStatus): boolean {
  return status === 'PRESENT' || status === 'HALF_DAY';
}

/**
 * Raw facts, then a decision about them. Payroll consumes APPROVED and nothing else, so
 * nobody is paid on the strength of an unreviewed entry.
 */
export const APPROVAL_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> =
  Object.freeze({
    DRAFT: ['SUBMITTED'],
    SUBMITTED: ['APPROVED', 'REJECTED', 'DRAFT'],
    // Terminal. A change of mind about approved work is a new record, not an edit of the
    // one payroll may already have consumed.
    APPROVED: [],
    REJECTED: ['DRAFT'],
  });

/**
 * The payroll run's life. Four states, and the two that are missing are missing on purpose.
 *
 * REVIEW is not a state — it is what a person does while a run is CALCULATED, and a state
 * nothing transitions out of programmatically is a label pretending to be a workflow.
 *
 * PAID is not a state, and that omission is the finance integration. A PAID payroll status
 * would be a second answer to "has this been paid?", and it would be the wrong one the
 * moment one employee's transfer failed. Settlement is `finance_payments`, per line.
 */
export const PAYROLL_STATUSES = ['DRAFT', 'CALCULATED', 'APPROVED', 'POSTED'] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const PAYROLL_TRANSITIONS: Readonly<Record<PayrollStatus, readonly PayrollStatus[]>> =
  Object.freeze({
    // Recalculation is allowed and expected — attendance gets corrected.
    DRAFT: ['CALCULATED'],
    CALCULATED: ['CALCULATED', 'APPROVED', 'DRAFT'],
    APPROVED: ['POSTED', 'CALCULATED'],
    // Terminal. A posted run has produced obligations somebody may already have settled.
    POSTED: [],
  });

export type ComponentKind = 'EARNING' | 'DEDUCTION';

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

export interface Department {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly status: EntityStatus;
}

export interface Designation {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly status: EntityStatus;
}

export interface Employee {
  readonly id: string;
  readonly tenantId: string;
  /** Tenant-scoped and stable. Never the display name. */
  readonly employeeCode: string;
  readonly fullName: string;
  readonly preferredName: string | null;
  /** One operational contact. Not a contact database. */
  readonly contactRef: string | null;
  readonly email: string | null;
  readonly departmentId: string | null;
  readonly designationId: string | null;
  readonly employmentType: EmploymentType;
  readonly joiningDate: string;
  readonly confirmationDate: string | null;
  readonly exitDate: string | null;
  readonly status: EmploymentStatus;
  /** The workbook's own PropertyID, validated against the caller's own workbook. */
  readonly primaryPropertyId: string | null;
  readonly managerId: string | null;
  /** 0=Sunday … 6=Saturday. Null is "no fixed weekly off", which is not Sunday. */
  readonly weeklyOffDay: number | null;
  readonly notes: string | null;
  readonly createdAt: string;
}

export interface Shift {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly startTime: string;
  readonly endTime: string;
  /** Explicit, because 22:00 → 06:00 is an ordinary shift and not a negative interval. */
  readonly crossesMidnight: boolean;
  readonly graceMinutes: number;
  readonly status: EntityStatus;
}

export interface Holiday {
  readonly id: string;
  readonly tenantId: string;
  readonly holidayDate: string;
  readonly name: string;
  /** Null means the whole business. */
  readonly propertyId: string | null;
}

export interface AttendanceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly attendanceDate: string;
  readonly shiftId: string | null;
  readonly propertyId: string | null;
  readonly status: AttendanceStatus;
  readonly checkInAt: string | null;
  readonly checkOutAt: string | null;
  readonly late: boolean;
  readonly earlyExit: boolean;
  /** What a clock observed. Payable only through an APPROVED overtime record. */
  readonly overtimeMinutes: number;
  readonly source: string;
  readonly notes: string | null;
  readonly approval: ApprovalStatus;
  readonly approvedBy: string | null;
  readonly createdAt: string;
}

export interface LeaveType {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  /** A property of the type, not a hard-coded list. Whether casual leave is paid is policy. */
  readonly paid: boolean;
  readonly status: EntityStatus;
}

export interface LeaveEntitlement {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly yearStart: string;
  readonly allocatedHalfDays: number;
}

export interface LeaveRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly halfDays: number;
  readonly reason: string | null;
  readonly status: ApprovalStatus;
  readonly requestedBy: string | null;
  readonly approvedBy: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: string;
}

export interface OvertimeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly overtimeDate: string;
  readonly minutes: number;
  readonly propertyId: string | null;
  readonly reason: string;
  /** Names a salary component if a tenant configured one. No multiplier is assumed. */
  readonly rateRef: string | null;
  readonly status: ApprovalStatus;
  readonly approvedBy: string | null;
  readonly createdAt: string;
}

export interface EmployeeAdvance {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly issuedOn: string;
  readonly amount: Paise;
  readonly currency: CurrencyCode;
  readonly reason: string;
  readonly notes: string | null;
  readonly status: ApprovalStatus;
  readonly approvedBy: string | null;
  readonly createdAt: string;
}

export interface SalaryComponent {
  readonly id: string;
  readonly tenantId: string;
  readonly structureId: string;
  readonly code: string;
  readonly kind: ComponentKind;
  readonly amount: Paise;
}

export interface SalaryStructure {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly effectiveFrom: string;
  /** Null for the current structure. Set when the next one begins. */
  readonly effectiveTo: string | null;
  readonly currency: CurrencyCode;
  readonly notes: string | null;
  readonly createdAt: string;
}

export interface SalaryStructureWithComponents extends SalaryStructure {
  readonly components: readonly SalaryComponent[];
  readonly grossEarnings: Paise;
  readonly fixedDeductions: Paise;
}

export interface PayrollRun {
  readonly id: string;
  readonly tenantId: string;
  readonly periodStart: string;
  readonly status: PayrollStatus;
  readonly notes: string | null;
  readonly createdBy: string | null;
  readonly approvedBy: string | null;
  readonly postedBy: string | null;
  readonly postedAt: string | null;
  readonly createdAt: string;
}

/**
 * One employee's obligation for the period, with its inputs kept.
 *
 * `unrecordedDays` is the honest field: a period with gaps in its attendance produces a
 * line that SAYS so, rather than quietly treating an unrecorded day as worked or as
 * absent. A payslip built on invented attendance is worse than one that reports a gap.
 */
export interface PayrollLine {
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly employeeId: string;
  readonly structureId: string | null;
  readonly gross: Paise;
  readonly deductions: Paise;
  readonly advanceRecovery: Paise;
  readonly net: Paise;
  readonly currency: CurrencyCode;
  readonly payableDays: number;
  readonly leaveDays: number;
  readonly absentDays: number;
  readonly unrecordedDays: number;
  readonly overtimeMinutes: number;
  readonly notes: string | null;
}

/* ------------------------------------------------------------------ *
 * Derived
 * ------------------------------------------------------------------ */

/**
 * An advance with what is left on it.
 *
 * Computed, never stored — the same rule finance applies to bills and receivables. A
 * stored outstanding is a second opinion about a number the recoveries already answer.
 */
export interface AdvanceBalance {
  readonly amount: Paise;
  readonly recovered: Paise;
  readonly outstanding: Paise;
  readonly currency: CurrencyCode;
}

export interface AdvanceWithBalance extends EmployeeAdvance {
  readonly balance: AdvanceBalance;
}

/** Available = allocated − approved taken. "Taken" is summed, never stored. */
export interface LeaveBalance {
  readonly leaveTypeId: string;
  readonly leaveTypeCode: string;
  readonly allocatedHalfDays: number;
  readonly takenHalfDays: number;
  readonly availableHalfDays: number;
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

export class HrError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HrError';
  }
}

/**
 * Not found, or not yours — the SAME refusal.
 *
 * Deliberately identical in shape and wording to `lib/server/finance/types.ts`, and a test
 * asserts the two produce the same message for the same noun. A different answer for "no
 * such employee" and "that employee belongs to another business" is an existence oracle:
 * it lets one tenant enumerate another's identifiers by watching which ones answer
 * differently. Every lookup in this domain carries the tenant predicate, so a foreign id is
 * simply a miss.
 */
export function notFound(what: string): HrError {
  return new HrError(404, 'NOT_FOUND', `No such ${what}.`);
}

export function refuse(code: string, message: string, status = 422): HrError {
  return new HrError(status, code, message);
}
