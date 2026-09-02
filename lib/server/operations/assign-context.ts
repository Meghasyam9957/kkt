import '@/lib/server/only';
/**
 * WHAT A QUEUE NEEDS IN ORDER TO OFFER "ASSIGN" ON EVERY ROW.
 *
 * Built ONCE per page render, not once per row. A housekeeping board with twenty turnovers
 * would otherwise ask for the staff roster twenty times to populate twenty identical
 * pickers, and each of those is a workbook read plus a database read.
 *
 * Everything here is assembled server-side and handed down as plain values. The browser
 * receives a list of people to choose from and the name currently on each task; it does not
 * receive — and could not use — anything about eligibility, tenancy or property ownership,
 * because none of those are its to decide. It submits an employee and a task; the server
 * resolves both against the caller's own stores and refuses if either is not theirs.
 */
import type { TenantContext } from '@/lib/server/tenant/context';
import type { OperationsPeopleService } from './service';
import type { TaskType } from './types';

/** One option in the employee picker. Matches the form layer's FieldOption shape. */
export interface StaffOption {
  readonly value: string;
  readonly label: string;
}

/** One entry in a task's assignment history, as a screen should show it. */
export interface AssignmentHistoryEntry {
  readonly displayName: string;
  readonly assignedAt: string;
  readonly supersededAt: string | null;
}

export interface AssignmentContext {
  /** Everyone who could be given work today, labelled with the context to choose by. */
  readonly options: readonly StaffOption[];
  /** taskRef → the name currently holding it. Absent means nobody does. */
  readonly current: Readonly<Record<string, AssignmentHistoryEntry>>;
  /** taskRef → the whole chain, newest first. Only present where there is one. */
  readonly history: Readonly<Record<string, readonly AssignmentHistoryEntry[]>>;
  /** False when the roster is empty, so a screen can say why it cannot offer the action. */
  readonly assignable: boolean;
}

/**
 * How a person reads in a picker.
 *
 * Name, code, and the two facts that change whether giving them this task is sensible: the
 * shift they are on and whether anyone has recorded them today. Deliberately informative
 * rather than authoritative — the server decides eligibility, and a label that implied
 * otherwise would be a second rule to keep in step with the first.
 *
 * NO PAY, NO CONTACT DETAIL. `StaffDay` has none to leak; this only chooses among what it
 * already carries.
 */
function labelFor(person: {
  displayName: string; employeeCode: string;
  shiftName: string | null; status: string; openTasks: number;
}): string {
  const parts = [`${person.displayName} (${person.employeeCode})`];
  if (person.shiftName) parts.push(person.shiftName);

  // Said in the words the staffing board uses, so one vocabulary describes a day.
  if (person.status === 'NOT_RECORDED') parts.push('not recorded today');
  else if (person.status === 'WEEKLY_OFF') parts.push('weekly off');
  else if (person.status === 'HALF_DAY') parts.push('half day');
  else parts.push(person.status.toLowerCase());

  if (person.openTasks > 0) {
    parts.push(`${person.openTasks} open`);
  }
  return parts.join(' · ');
}

/**
 * Assemble the page's assignment context.
 *
 * `propertyId` narrows the roster the way the filter bar narrows the board, so a supervisor
 * looking at one property is offered that property's people. It is validated by
 * `staffingBoard`, which refuses a property the caller does not own exactly as it refuses
 * one that does not exist.
 */
export async function assignmentContextFor(
  service: OperationsPeopleService,
  tenant: TenantContext,
  taskType: TaskType,
  options: { readonly propertyId?: string; readonly today?: string } = {},
): Promise<AssignmentContext> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  const [board, assignments] = await Promise.all([
    service.staffingBoard(tenant, today, options.propertyId),
    // Everything, not just the current rows: the history a task detail shows is the same
    // query, grouped. One read rather than one per task.
    service.list(tenant, { taskType }),
  ]);

  const history: Record<string, AssignmentHistoryEntry[]> = {};
  const current: Record<string, AssignmentHistoryEntry> = {};

  for (const row of assignments) {
    const entry: AssignmentHistoryEntry = Object.freeze({
      // The name AS WRITTEN at the time. A person renamed since should not silently rewrite
      // what the record says happened.
      displayName: row.displayNameWritten,
      assignedAt: row.assignedAt,
      supersededAt: row.supersededAt,
    });
    (history[row.taskRef] ??= []).push(entry);
    if (row.supersededAt === null) current[row.taskRef] = entry;
  }

  for (const chain of Object.values(history)) {
    // Newest first: what is true now, then how it got that way.
    chain.sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  }

  const staff = board.staff
    .filter((person) => person.status !== 'ABSENT')
    .map((person) => Object.freeze({ value: person.employeeId, label: labelFor(person) }));

  return Object.freeze({
    options: staff,
    current: Object.freeze(current),
    history: Object.freeze(history),
    assignable: staff.length > 0,
  });
}
