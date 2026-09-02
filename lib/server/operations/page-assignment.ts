import '@/lib/server/only';
/**
 * THE ASSIGNMENT CONTEXT A QUEUE PAGE NEEDS, or nothing at all.
 *
 * Both operational queues want the same thing — who holds each task, and who could — and
 * both must behave identically for a viewer who is not entitled to it. Putting that in one
 * place means the housekeeping board and the maintenance board cannot drift into disagreeing
 * about who may see a roster.
 *
 * RETURNS UNDEFINED RATHER THAN THROWING, in two cases:
 *
 *   no capability   `housekeeping.read` and `maintenance.read` are not
 *                   `operations.staff.read`. A viewer holding the first but not the second
 *                   gets exactly the board they had before this feature existed — no
 *                   assign control, no roster, no explanation demanded of them.
 *
 *   it failed       the people domain is a different store from the workbook, and a queue
 *                   that a supervisor needs in order to work should not go blank because
 *                   the roster could not be read. The board still renders; the action is
 *                   simply not offered.
 *
 * Neither case is a security decision made here — the API refuses an unauthorised assignment
 * regardless of what any page chose to render. This only decides whether to OFFER it.
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { operationsServiceFor } from '@/lib/server/api/service';
import { assignmentContextFor, type AssignmentContext } from './assign-context';
import type { TaskType } from './types';
import { ensureDemoWorkforce } from '@/lib/server/operations/demo-workforce';

export async function assignmentContextForPage(
  taskType: TaskType, propertyId?: string,
): Promise<AssignmentContext | undefined> {
  const access = await checkPageAccess('operations.staff.read');
  if (!access.allowed) return undefined;

  // Demo only, once per process, and a no-op everywhere else.
  await ensureDemoWorkforce();

  try {
    return await assignmentContextFor(operationsServiceFor(), access.tenant, taskType, {
      propertyId: propertyId && propertyId.trim() !== '' ? propertyId : undefined,
    });
  } catch (error) {
    // The diagnostic belongs to the operator, not to the queue. Same stance the page helper
    // takes when a fetch fails: a human sentence on screen, the detail in the server log.
    console.error(`[operations] assignment context for ${taskType} failed:`, error);
    return undefined;
  }
}
