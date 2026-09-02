import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { operationsServiceFor } from '@/lib/server/api/service';
import { assignmentContextForPage } from '@/lib/server/operations/page-assignment';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { AssignTaskButton } from './AssignTaskButton';
import { ensureDemoWorkforce } from '@/lib/server/operations/demo-workforce';

/**
 * URGENT WORK NOBODY OWNS.
 *
 * The one thing the Today board could not tell anybody. It already raises every Critical and
 * High ticket from the workbook — but urgency and ownership live in different stores, so
 * nothing until now could answer the question a supervisor actually has at 8am: *of the
 * urgent things, which has no one on it?*
 *
 * DELIBERATELY NARROW. Not an alert per unassigned task — most tasks are unassigned most of
 * the time and a board that says so is a board nobody reads. Not a second copy of the
 * workbook's urgent list either. Only the intersection, which is small by construction and
 * therefore worth putting at the top of a screen.
 *
 * NO ALERT STORE, AND THAT IS THE DESIGN. Every item here is derived on each render from the
 * same two reads, so:
 *
 *   a refresh cannot duplicate one — there is nothing to append to;
 *   assigning the ticket removes it, because it stops meeting the definition;
 *   resolving or closing the ticket removes it, for the same reason.
 *
 * The lifecycle §17 asks for is therefore OPEN and RESOLVED, and both are consequences of
 * the facts rather than states anybody has to remember to update. ACKNOWLEDGED is the one
 * state this cannot express, and it is deliberately not built: it would need a store whose
 * only purpose is to stop showing urgent work that still has no owner.
 */
export async function TodayUrgent({ property }: { property?: string }) {
  const access = await checkPageAccess('operations.staff.read');
  // Same stance as the staffing section: a viewer without the capability sees the board
  // they always saw, with no explanation demanded of them.
  if (!access.allowed) return null;

  await ensureDemoWorkforce();

  let urgent;
  try {
    urgent = await operationsServiceFor().unassignedUrgent(access.tenant, property);
  } catch {
    // A property this business does not operate, or a store that could not answer. The rest
    // of Today is unaffected, so this section says nothing rather than breaking the page.
    return null;
  }

  // Nothing urgent without an owner is genuinely good news, and a card saying so every
  // morning would be noise on the one screen that must stay scannable.
  if (urgent.length === 0) return null;

  const assignment = await assignmentContextForPage('MAINTENANCE', property);

  return (
    <Card>
      <CardHeader
        title="Urgent work with no owner"
        subtitle="Open, urgent, and nobody is on it. Assigning one removes it from here."
      />
      <CardBody>
        <ul className="sv-urgentlist">
          {urgent.map((task) => (
            <li key={task.key} className="sv-urgentlist__item">
              <div className="sv-urgentlist__head">
                <StatusPill tone={task.priority === 'Critical' ? 'bad' : 'warn'}>
                  {task.priority}
                </StatusPill>
                <span className="sv-urgentlist__title">{task.title}</span>
              </div>
              <p className="sv-kpi__note">
                {task.propertyId ?? 'No property recorded'} · {task.taskRef} ·{' '}
                {task.ageDays === 0
                  ? 'reported today'
                  : `waiting ${task.ageDays} ${task.ageDays === 1 ? 'day' : 'days'}`}
              </p>
              {assignment ? (
                <div className="sv-urgentlist__action">
                  <AssignTaskButton
                    taskType="MAINTENANCE" taskRef={task.taskRef} context={assignment}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
