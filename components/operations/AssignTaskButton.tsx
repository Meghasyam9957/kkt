/**
 * ASSIGN / REASSIGN — the supervisor's action, on the row.
 *
 * Built entirely out of `RowActionButton`, which already runs the contract every other write
 * in this product runs: one operation id per opened intent, a visible APPLYING phase, no
 * optimistic state, and a failure that stays on screen with its code attached. Writing a
 * bespoke form here would have meant re-earning all of that, and getting one of them subtly
 * wrong.
 *
 * WHAT THE BROWSER SENDS: a task type, a task reference, an employee id, and optionally a
 * reason. WHAT IT DOES NOT SEND: a tenant, a property, or any claim about eligibility. Those
 * are resolved server-side against the caller's own stores, and a reference belonging to
 * somebody else is simply not found there.
 *
 * WHY THE UI DOES NOT ENFORCE ELIGIBILITY. The picker LABELS a person's shift and today's
 * attendance because that is what a supervisor chooses by — but it does not grey anyone out
 * and does not decide when a reason is required. `OperationsPeopleService.assign` does, and
 * a second copy of that rule in the browser is a second thing to keep in step. When the
 * server needs a reason it answers `409 OVERRIDE_REQUIRED` and says why, which the form
 * shows. The person then has the words in front of them, which is the right moment to ask.
 */
import { RowActionButton } from '@/components/mutations/actions';
import type { FieldSpec } from '@/components/mutations/MutationForm';
import type { AssignmentContext } from '@/lib/server/operations/assign-context';
import { Timeline } from '@/components/ui/Timeline';

/**
 * The clock reading from a stored instant.
 *
 * An assignment is read on the day it happens — "since 09:12" is what a supervisor needs,
 * and the date would be noise on every row. `Intl` with an explicit hour/minute keeps it
 * two digits in every locale the shell runs in.
 */
function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--:--';
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function AssignTaskButton({
  taskType, taskRef, context, disabled,
}: {
  taskType: 'HOUSEKEEPING' | 'MAINTENANCE';
  taskRef: string;
  context: AssignmentContext;
  /** A finished task needs no owner; the server refuses one anyway. */
  disabled?: boolean;
}) {
  const current = context.current[taskRef];
  const chain = context.history[taskRef] ?? [];

  if (disabled || !context.assignable) return null;

  const fields: FieldSpec[] = [
    {
      name: 'employeeId',
      label: current ? 'Reassign to' : 'Assign to',
      type: 'select',
      required: true,
      options: [...context.options],
      help: 'Shift and today’s attendance are shown to choose by. Availability is '
        + 'checked when you confirm.',
    },
    {
      name: 'overrideReason',
      label: 'Reason (if asked for)',
      type: 'textarea',
      help: 'Needed only when the person is on leave, on their weekly off, or working '
        + 'their notice. Confirm without it first — you will be told if it is required.',
    },
  ];

  return (
    <RowActionButton
      label={current ? 'Reassign' : 'Assign'}
      endpoint="/api/operations/assignments"
      method="POST"
      successTemplate="Assigned."
      fields={fields}
      confirmTitle={current ? `Reassign ${taskRef}` : `Assign ${taskRef}`}
      surface="drawer"
      // The type and the reference are the ACTION's, not the person's — nobody should have
      // to restate which task they just clicked.
      constants={{ taskType, taskRef }}
      context={<AssignmentDetail current={current} chain={chain} />}
    />
  );
}

/**
 * What is true about this task before anything is changed.
 *
 * Read-only, and nothing here is submitted. History is shown in the same panel as the action
 * because "who had this before" is exactly the question a reassignment raises, and sending
 * somebody to another screen to answer it is how a reassignment gets made twice.
 */
function AssignmentDetail({
  current, chain,
}: {
  current?: { displayName: string; assignedAt: string };
  chain: readonly { displayName: string; assignedAt: string; supersededAt: string | null }[];
}) {
  if (!current && chain.length === 0) {
    return <p className="sv-empty">Nobody holds this task yet.</p>;
  }

  return (
    <div className="sv-stack">
      {current ? (
        <p className="sv-kpi__note">
          Currently <strong>{current.displayName}</strong>, since {clockTime(current.assignedAt)}.
        </p>
      ) : (
        <p className="sv-kpi__note">Nobody holds this task now.</p>
      )}

      {chain.length > 1 ? (
        <div>
          <h4 className="sv-kpi__label">Assignment history</h4>
          <Timeline
            label={`Assignment history for this task`}
            stops={chain.map((entry) => ({
              id: `${entry.assignedAt}-${entry.displayName}`,
              time: clockTime(entry.assignedAt),
              title: entry.displayName,
              detail: entry.supersededAt
                ? `Handed over at ${clockTime(entry.supersededAt)}`
                : undefined,
              status: entry.supersededAt
                ? { tone: 'neutral' as const, label: 'superseded' }
                : { tone: 'good' as const, label: 'current' },
            }))}
          />
          {/* Nothing is ever removed from this chain — a reassignment supersedes. */}
          <p className="sv-kpi__note">Reassigning keeps this record and adds to it.</p>
        </div>
      ) : null}
    </div>
  );
}
