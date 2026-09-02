import '@/lib/server/only';
/**
 * PEOPLE ON OPERATIONAL WORK.
 *
 * The workbook already knows that a turnover is Assigned and that the cleaner is called
 * Ravi. What it cannot know is WHICH Ravi, WHO decided, WHEN, and WHO WAS ON IT BEFORE.
 * Those four facts are what this domain adds, and it adds nothing else — the task, its
 * status, its inspection and its cost link all stay where they already are.
 *
 * Two ideas carry most of the weight:
 *
 *   RESOLUTION   Turning a historical free-text name into an employee is a guess unless
 *                exactly one active person matches. `EmployeeMatch` makes the ambiguous
 *                and the absent cases first-class, so nothing is silently mapped to the
 *                wrong person because two people share a name.
 *
 *   ELIGIBILITY  Some states genuinely bar assignment and some merely deserve a question.
 *                Somebody who has left cannot be given work; somebody on their weekly off
 *                can be, deliberately, by a supervisor who says why. `Eligibility` keeps
 *                the two apart instead of collapsing them into one prohibition that gets
 *                worked around.
 */
import type { Employee } from '@/lib/server/hr/types';

/** Which workbook sheet the task lives in. The task itself is never copied here. */
export const TASK_TYPES = ['HOUSEKEEPING', 'MAINTENANCE'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * One assignment. Append-only: a reassignment supersedes rather than overwrites, so the
 * chain answers "who was on this turnover when it was missed?".
 */
export interface TaskAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly taskType: TaskType;
  /** The workbook's own TaskID or TicketID. */
  readonly taskRef: string;
  readonly employeeId: string;
  readonly propertyId: string | null;
  /**
   * The name written into the sheet at assignment. Compared on read, so a hand-edit of the
   * cell shows up as a disagreement rather than being silently preferred one way.
   */
  readonly displayNameWritten: string;
  readonly assignedBy: string | null;
  readonly assignedAt: string;
  readonly supersededAt: string | null;
  readonly supersededBy: string | null;
  readonly overrideReason: string | null;
}

/* ------------------------------------------------------------------ *
 * Resolving a name to a person
 * ------------------------------------------------------------------ */

/**
 * What a free-text name resolves to, AS OF THE DATE OF THE WORK.
 *
 * The as-of date is the whole difficulty. "Ravi" on a turnover from 2024 means the Ravi who
 * was employed in 2024 — not the Ravi hired last month who happens to be the only one on
 * file today. Those two are byte-identical to a name comparison and they are opposite
 * facts, so `HISTORICAL_MISMATCH` is a separate outcome from `INACTIVE` rather than folded
 * into it. Collapsing them is exactly how a 2024 turnover gets attributed, plausibly and
 * permanently, to a 2027 hire.
 *
 * `AMBIGUOUS` is never broken by recency, by status, or by "the only active one". Two
 * Ravis where one has left is the case MOST likely to be mis-mapped, because picking the
 * active one feels correct and is wrong precisely when the record is old.
 *
 * Nothing here writes, and nothing binds. An EXACT result is a suggestion for a person to
 * accept, not consent to attach one person's work to another's record.
 */
export type EmployeeMatch =
  /** Exactly one match, employed on the day, and active today. */
  | { readonly kind: 'EXACT'; readonly employee: Employee }
  /** Two or more after normalisation, whatever their statuses. A person must choose. */
  | { readonly kind: 'AMBIGUOUS'; readonly candidates: readonly Employee[] }
  /** One match, employed on the day, but not currently active. Fine for history. */
  | { readonly kind: 'INACTIVE'; readonly employee: Employee; readonly status: string }
  /** One match by name, but that person was not employed on the day in question. */
  | {
    readonly kind: 'HISTORICAL_MISMATCH';
    readonly employee: Employee;
    readonly asOf: string;
  }
  /** Nobody by that name: a contractor, somebody never entered, or a typo. */
  | { readonly kind: 'NO_MATCH'; readonly raw: string }
  /** The cell is empty. Nobody has been recorded, which is not the same as no match. */
  | { readonly kind: 'UNRECORDED' };

/* ------------------------------------------------------------------ *
 * Whether this person may take this work
 * ------------------------------------------------------------------ */

/**
 * BLOCKED is a state the business has already decided about; WARN is one a supervisor may
 * decide about, on the record.
 *
 *   BLOCKED   EXITED    they do not work here
 *             SUSPENDED suspension is a deliberate instruction to stop giving them work
 *
 *   WARN      ON_LEAVE / NOTICE_PERIOD / approved leave today / weekly off
 *             All legitimate to override — a supervisor calling somebody in on their day
 *             off is ordinary hospitality — but never silently: an override records why.
 *
 * There is deliberately no rule about workload. "Too many tasks" is a judgement about a
 * shift nobody has defined a capacity for, and inventing a threshold would refuse real work
 * on no authority.
 */
export type Eligibility =
  | { readonly kind: 'OK' }
  | { readonly kind: 'WARN'; readonly reasons: readonly string[] }
  | { readonly kind: 'BLOCKED'; readonly reasons: readonly string[] };

export function isBlocked(eligibility: Eligibility): eligibility is { kind: 'BLOCKED'; reasons: readonly string[] } {
  return eligibility.kind === 'BLOCKED';
}

/* ------------------------------------------------------------------ *
 * Today's staffing
 * ------------------------------------------------------------------ */

/**
 * One person's working day, as an operations supervisor needs it.
 *
 * Carries no compensation of any kind, and cannot: it is assembled from the HR roster
 * projection and an attendance record, neither of which holds pay.
 */
export interface StaffDay {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  readonly designationId: string | null;
  readonly departmentId: string | null;
  readonly propertyId: string | null;
  /** The shift actually recorded for the day, when attendance names one. */
  readonly shiftName: string | null;
  readonly shiftStart: string | null;
  readonly shiftEnd: string | null;
  readonly crossesMidnight: boolean;
  /**
   * What the day IS. `NOT_RECORDED` is its own value rather than an absence, because a day
   * nobody has marked is not a day somebody was away — the same rule payroll follows.
   */
  readonly status: StaffDayStatus;
  readonly late: boolean;
  readonly earlyExit: boolean;
  /** Approved attendance only. A submitted-but-unapproved day still reads NOT_RECORDED. */
  readonly approved: boolean;
  readonly openTasks: number;
}

export const STAFF_DAY_STATUSES = [
  'PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'NOT_RECORDED',
] as const;
export type StaffDayStatus = (typeof STAFF_DAY_STATUSES)[number];

/** One department's coverage, which is the question a supervisor actually asks. */
export interface DepartmentCoverage {
  readonly departmentId: string | null;
  readonly departmentName: string;
  readonly scheduled: number;
  readonly present: number;
  readonly absent: number;
  readonly onLeave: number;
  readonly weeklyOff: number;
  readonly notRecorded: number;
  readonly late: number;
  /**
   * People expected today for whom nothing is recorded and no leave or day off explains
   * it. Named a GAP rather than an absence, because nobody has said they are absent.
   */
  readonly gaps: number;
}

/**
 * One disagreement between the workbook and the overlay.
 *
 * The highest risk in this milestone: the moment the application writes a name into
 * `13_HOUSEKEEPING.Cleaner` as an echo of a fact it holds elsewhere, the customer's
 * spreadsheet becomes a mutable copy of that fact — and it is their spreadsheet, which they
 * and V1's own menu edit. A supervisor typing "Ravi" over "Lakshmi Narayan" leaves both
 * halves internally consistent, both displayed confidently, and nothing failing.
 *
 * This is what turns that from a silent divergence into a reported one.
 */
export interface AssignmentDivergence {
  readonly taskType: TaskType;
  readonly taskRef: string;
  readonly kind: DivergenceKind;
  /** What the workbook says now. */
  readonly sheetName: string | null;
  /** What this application wrote when it assigned. */
  readonly echoedName: string | null;
  readonly employeeId: string | null;
}

export const DIVERGENCE_KINDS = [
  /** The sheet was edited to a different name after the assignment. */
  'SHEET_EDITED',
  /** An assignment exists but the sheet cell is empty — the echo never landed. */
  'ECHO_MISSING',
  /** A name is on the sheet with no assignment behind it: historical, or a direct edit. */
  'UNLINKED_NAME',
] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

export interface StaffingBoard {
  readonly date: string;
  readonly propertyId: string | null;
  readonly staff: readonly StaffDay[];
  readonly coverage: readonly DepartmentCoverage[];
  /** Employees with no property assignment. Shown as UNASSIGNED, never guessed at. */
  readonly unassigned: number;
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

export class OperationsError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OperationsError';
  }
}

/**
 * Not found, or not yours — the SAME refusal, in the same words the finance and HR domains
 * use. A different answer for the two is an existence oracle.
 */
export function notFound(what: string): OperationsError {
  return new OperationsError(404, 'NOT_FOUND', `No such ${what}.`);
}

export function refuse(code: string, message: string, status = 422): OperationsError {
  return new OperationsError(status, code, message);
}

/* ------------------------------------------------------------------ *
 * Reconciliation — M-OPS-3 §10
 * ------------------------------------------------------------------ */

/**
 * WHAT THE SHEET AND THE OVERLAY SAY ABOUT ONE TASK, as a closed set of answers.
 *
 * M-OPS-2's `reconcile()` reported only the three ways they could DISAGREE, which was enough
 * to notice a problem and not enough to act on one: it could not say that a name was
 * bindable, that it was ambiguous, or that it belonged to somebody who had already left.
 * Those distinctions are the difference between a list of complaints and a work queue.
 *
 * Every status is machine-safe and mutually exclusive. Nothing here guesses: where the
 * evidence supports more than one person, the answer is AMBIGUOUS and a human decides.
 */
export const RECONCILIATION_STATUSES = [
  /** A current assignment exists and the sheet cell holds exactly the name we wrote. */
  'MATCHED',
  /** A current assignment exists; the sheet cell holds a DIFFERENT name. Hand-edited. */
  'ECHO_MISMATCH',
  /** A current assignment exists; the sheet cell is empty. The echo never landed. */
  'ECHO_MISSING',
  /** A name, no assignment, and it resolves to exactly one person employed that day. */
  'UNLINKED',
  /** A name, no assignment, and more than one employee answers to it. */
  'AMBIGUOUS',
  /** A name, no assignment, and the only match was not employed on the task's own date. */
  'HISTORICAL',
  /** A name, no assignment, and nobody on the books answers to it at all. */
  'MISSING_RELATION',
  /** An assignment whose task is no longer in the workbook. */
  'TASK_NOT_FOUND',
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/**
 * What a supervisor could reasonably do next.
 *
 * Advisory only. Nothing acts on a recommendation by itself, and BIND is offered solely
 * where exactly one employed-that-day person answers to the name — never for AMBIGUOUS,
 * which is the case this whole design exists to refuse to guess at.
 */
export const RECONCILIATION_ACTIONS = [
  'NONE', 'REVIEW', 'BIND', 'REPAIR_ECHO', 'IGNORE_HISTORICAL',
] as const;

export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

/** One employee, named the way a screen should name one. Never a bare identifier. */
export interface NamedEmployee {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
}

export interface TaskReconciliation {
  readonly taskType: TaskType;
  readonly taskRef: string;
  readonly propertyId: string | null;
  /** The task's own date, which is what the name was resolved as of. */
  readonly occurredOn: string;
  readonly title: string | null;
  readonly status: ReconciliationStatus;
  /** The name currently in the workbook cell. */
  readonly sheetName: string | null;
  /** The person the overlay says holds it, if any. Named, never a raw identifier. */
  readonly employee: NamedEmployee | null;
  /** For AMBIGUOUS: everyone the name could mean. A person picks, or nothing happens. */
  readonly candidates: readonly NamedEmployee[];
  readonly recommendation: ReconciliationAction;
}

export interface ReconciliationSummary {
  readonly matched: number;
  readonly needsReview: number;
  readonly unlinked: number;
  readonly ambiguous: number;
  readonly total: number;
}

export interface ReconciliationReport {
  readonly summary: ReconciliationSummary;
  readonly rows: readonly TaskReconciliation[];
}

/* ------------------------------------------------------------------ *
 * Unassigned urgent work — M-OPS-3 §14
 * ------------------------------------------------------------------ */

/**
 * Urgent maintenance that nobody owns.
 *
 * NOT a new alert engine, and not a second copy of the workbook's own urgent list. The
 * board already raises every Critical and High ticket from the sheet alone; what it cannot
 * know is whether one has an owner, because ownership lives in the overlay. This is exactly
 * that intersection and nothing more.
 *
 * `key` follows the board's existing convention (`mnt-<ticketId>`) so the same ticket has
 * one identity wherever it surfaces, and a page refresh cannot mint a second copy of it.
 */
export interface UnassignedUrgentTask {
  readonly key: string;
  readonly taskType: TaskType;
  readonly taskRef: string;
  readonly propertyId: string | null;
  /** The sheet's own vocabulary — 'Critical' | 'High' — never translated. */
  readonly priority: string;
  readonly title: string;
  readonly reportedOn: string;
  /** Whole days since it was reported, so a screen can show how long it has waited. */
  readonly ageDays: number;
}
