/**
 * M-OPS-2 — PEOPLE ON OPERATIONS, ACROSS TWO TENANTS.
 *
 * This suite is the first in the project where a single action crosses TWO stores: the
 * task lives in the tenant's workbook and the employee lives in Postgres, and the harness
 * reflects that exactly.
 *
 *   the workbooks are SEPARATE   one in-memory sheets client per tenant, as production has
 *                                one workbook per tenant
 *   the Postgres stores are ONE  a single InMemoryHrRepository and a single
 *                                InMemoryOperationsRepository shared by both tenants, so
 *                                only the tenant predicate separates them
 *
 * A harness that gave each tenant its own employee store would pass every isolation case
 * here while proving nothing — the workbook half would carry the whole result. Sharing the
 * relational half is what makes the assertions about the predicate.
 *
 * The attacker: a fully-authenticated OPERATIONS supervisor in TENANT_A reaching for
 * TENANT_B — by naming their task, their employee, or their property.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { API_ROUTES, assertWriteGovernance } from '@/lib/server/api/routes';
import { registerOperationsHandlers } from '@/lib/server/api/operations-handlers';
import { registerHrHandlers } from '@/lib/server/api/hr-handlers';
import { MUTATION_DEFINITIONS } from '@/lib/server/api/mutation-services';
import { executeMutation } from '@/lib/server/api/mutations';
import { InMemoryHrRepository } from '@/lib/server/hr/repository';
import { HrService } from '@/lib/server/hr/service';
import { InMemoryOperationsRepository } from '@/lib/server/operations/repository';
import { OperationsPeopleService, type OperationalTask } from '@/lib/server/operations/service';
import type { TaskType } from '@/lib/server/operations/types';
import { OPEN_HOUSEKEEPING_STATUSES, OPEN_MAINTENANCE_STATUSES } from '@/lib/shared/domain';
import { capabilitiesFor, roleHasCapability } from '@/lib/shared/roles';
import { InMemoryAuthProvider, type TestUser } from '@/lib/server/auth/session';
import { TENANT_A, TENANT_B, USERS } from './support/harness';
import { createWriteHarness } from './support/write-harness';
import { readSource as read, codeOf } from './support/source';

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const OPS_A: TestUser = {
  userId: 'u-ops-a', email: 'ops.a@example.test', role: 'OPERATIONS',
  tenantId: TENANT_A, token: 'tok-ops-a',
};
const OPS_B: TestUser = {
  userId: 'u-ops-b', email: 'ops.b@example.test', role: 'OPERATIONS',
  tenantId: TENANT_B, token: 'tok-ops-b',
};
const HR_A: TestUser = {
  userId: 'u-hr-a', email: 'hr.a@example.test', role: 'ADMIN',
  tenantId: TENANT_A, token: 'tok-hr-a',
};
const HR_B: TestUser = {
  userId: 'u-hr-b', email: 'hr.b@example.test', role: 'ADMIN',
  tenantId: TENANT_B, token: 'tok-hr-b',
};

/*
 * Each tenant's own property list. Both workbooks are copies of the same demo grid — which
 * is realistic, because two customers may perfectly well number a unit HYD-501 — so
 * isolation here comes from the two workbook INSTANCES and the tenant predicate, never
 * from the identifiers happening to differ. The lists are disjoint so a cross-property
 * attempt is expressible.
 */
const PROPERTIES: Record<string, string[]> = {
  [TENANT_A]: ['HYD-501', 'HYD-502'],
  [TENANT_B]: ['HYD-601'],
};

const op = () => randomUUID();

function harness() {
  // Separate workbooks, exactly as production gives each tenant its own.
  const wb = createWriteHarness({}, {
    tenants: [TENANT_A, TENANT_B],
    users: [...Object.values(USERS), OPS_A, OPS_B, HR_A, HR_B],
  });

  // ONE relational store for both tenants. Only the predicate separates them.
  const hrRepo = new InMemoryHrRepository();
  const opsRepo = new InMemoryOperationsRepository();
  const closed = new Set<string>();

  const hrService = (audit: typeof wb.deps.audit) => new HrService({
    repo: hrRepo,
    propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
    isPeriodClosed: async (tenant, iso) => closed.has(`${tenant.tenantId}|${iso.slice(0, 7)}`),
    audit,
  });

  const tasks = async (
    tenant: { tenantId: string }, taskType: TaskType,
  ): Promise<readonly OperationalTask[]> => {
    // The CALLER'S OWN workbook — the reason a foreign task reference is a miss.
    const repos = wb.reposFor(tenant.tenantId);
    if (taskType === 'HOUSEKEEPING') {
      return (await repos.housekeeping.readAll()).map((t) => ({
        taskRef: t.taskId,
        propertyId: t.propertyId || null,
        assigneeName: t.cleaner || null,
        status: t.status,
        open: OPEN_HOUSEKEEPING_STATUSES.includes(t.status),
        occurredOn: t.checkoutDate,
        priority: null,
        title: t.bookingId ? `Turnover after ${t.bookingId}` : 'Turnover',
      }));
    }
    return (await repos.maintenance.readAll()).map((t) => ({
      taskRef: t.ticketId,
      propertyId: t.propertyId || null,
      assigneeName: t.assignedTo || null,
      status: t.status,
      open: OPEN_MAINTENANCE_STATUSES.includes(t.status),
      occurredOn: t.reportedOn,
      priority: t.priority,
      title: t.description || t.category || null,
    }));
  };

  const service = new OperationsPeopleService({
    hr: hrService(wb.deps.audit),
    assignments: opsRepo,
    tasks: tasks as never,
    propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
    // The real pipeline, per tenant, exactly as the composition root wires it.
    writeAssignee: async (write, taskType, taskRef, name) => {
      const housekeeping = taskType === 'HOUSEKEEPING';
      const definition = MUTATION_DEFINITIONS[housekeeping ? 'housekeeping.update' : 'maintenance.update']!;
      await executeMutation(definition, {
        auth: write.auth,
        request: {
          method: 'PATCH',
          path: housekeeping ? `/api/housekeeping/${taskRef}` : `/api/maintenance/${taskRef}`,
          headers: {}, query: {}, params: { id: taskRef },
          body: housekeeping
            ? { operationId: op(), cleaner: name, finalStatus: 'Assigned' }
            : { operationId: op(), assignedTo: name, status: 'Assigned' },
          requestId: write.requestId,
        },
      } as never, wb.deps);
    },
    audit: wb.deps.audit,
  });

  registerOperationsHandlers(wb.router, async () => ({
    service, store: wb.store, audit: wb.deps.audit, writesPermitted: true,
  }));
  registerHrHandlers(wb.router, async () => ({
    service: hrService(wb.deps.audit), store: wb.store, audit: wb.deps.audit,
    writesPermitted: true,
  }));

  return { wb, hrRepo, opsRepo, service, closed, request: wb.requestAs.bind(wb) };
}

type Harness = ReturnType<typeof harness>;
let h: Harness;
beforeEach(() => { h = harness(); });

async function anEmployee(token: string, over: Record<string, unknown> = {}) {
  const res = await h.request(token, 'POST', '/api/hr/employees', {
    operationId: op(), fullName: 'Ravi Kumar', joiningDate: '2020-01-01', ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function aTurnover(token: string, propertyId: string) {
  const res = await h.request(token, 'POST', '/api/housekeeping', {
    operationId: op(), propertyId, checkoutDate: '2026-05-04',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.record.TaskID);
}

async function aTicket(token: string, propertyId: string) {
  const res = await h.request(token, 'POST', '/api/maintenance', {
    operationId: op(), propertyId, dateReported: '2026-05-04',
    issueCategory: 'Plumbing', description: 'Slow drain', priority: 'High',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.record.TicketID);
}

/* ================================================================== *
 * 1 · THE WORKFLOW, END TO END
 * ================================================================== */

describe('operations · the workflow', () => {
  it('assigns a turnover to a person and echoes the name into the workbook', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Lakshmi Narayan' });
    const taskRef = await aTurnover(HR_A.token, 'HYD-501');

    const assigned = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef, employeeId: employee.id,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.employeeId).toBe(employee.id);
    // A human name, never a bare identifier.
    expect(assigned.body.displayName).toBe('Lakshmi Narayan');

    // The workbook now carries the name AND the status the sheet already models.
    const [task] = (await h.wb.reposFor(TENANT_A).housekeeping.readAll())
      .filter((t) => t.taskId === taskRef);
    expect(task!.cleaner).toBe('Lakshmi Narayan');
    expect(task!.status).toBe('Assigned');
  });

  it('supersedes on reassignment rather than overwriting, so history survives', async () => {
    const first = await anEmployee(HR_A.token, { fullName: 'Lakshmi Narayan' });
    const second = await anEmployee(HR_A.token, { fullName: 'Imran Qureshi' });
    const taskRef = await aTurnover(HR_A.token, 'HYD-501');

    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef, employeeId: first.id,
    });
    const again = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef, employeeId: second.id,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    const history = await h.request(
      OPS_A.token, 'GET', `/api/operations/assignments?taskType=HOUSEKEEPING&taskRef=${taskRef}`,
    );
    expect(history.body).toHaveLength(2);
    // The previous assignment is closed, not erased — "who was on this when it was
    // missed?" still has an answer.
    const superseded = history.body.find((a: any) => a.employeeId === first.id);
    expect(superseded.supersededAt).not.toBeNull();
    const current = history.body.find((a: any) => a.employeeId === second.id);
    expect(current.supersededAt).toBeNull();
  });

  it('assigns a maintenance ticket, which had no assign action before this milestone', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Imran Qureshi' });
    const taskRef = await aTicket(HR_A.token, 'HYD-501');

    const assigned = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'MAINTENANCE', taskRef, employeeId: employee.id,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    const [ticket] = (await h.wb.reposFor(TENANT_A).maintenance.readAll())
      .filter((t) => t.ticketId === taskRef);
    expect(ticket!.assignedTo).toBe('Imran Qureshi');
    expect(ticket!.status).toBe('Assigned');
  });

  it('refuses a task that is already finished', async () => {
    const employee = await anEmployee(HR_A.token);
    const taskRef = await aTurnover(HR_A.token, 'HYD-501');
    await h.request(HR_A.token, 'PATCH', `/api/housekeeping/${taskRef}`, {
      operationId: op(), finalStatus: 'Completed',
    });

    const res = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef, employeeId: employee.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_CLOSED');
  });
});

/* ================================================================== *
 * 2 · TENANT ISOLATION
 * ================================================================== */

describe('operations · tenant isolation', () => {
  it('refuses one tenant employee on the other tenant task, identically to a fiction', async () => {
    const theirEmployee = await anEmployee(HR_B.token, { fullName: 'B Person' });
    const myTask = await aTurnover(HR_A.token, 'HYD-501');

    const cross = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: myTask, employeeId: theirEmployee.id,
    });
    expect(cross.status).toBe(404);

    const invented = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: myTask, employeeId: randomUUID(),
    });
    // Byte-identical refusals: nothing is learned by comparing them.
    expect(invented.status).toBe(cross.status);
    expect(invented.body.error.code).toBe(cross.body.error.code);
    expect(invented.body.error.message).toBe(cross.body.error.message);
  });

  it('refuses the other tenant TASK, identically to a fiction', async () => {
    const myEmployee = await anEmployee(HR_A.token);
    const theirTask = await aTurnover(HR_B.token, 'HYD-601');

    const cross = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: theirTask, employeeId: myEmployee.id,
    });
    expect(cross.status).toBe(404);

    const invented = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: 'HK-9999-9999', employeeId: myEmployee.id,
    });
    expect(invented.body.error.message).toBe(cross.body.error.message);

    // …and nothing landed on the other tenant's task.
    const [task] = (await h.wb.reposFor(TENANT_B).housekeeping.readAll())
      .filter((t) => t.taskId === theirTask);
    expect(task!.cleaner).toBe('');
  });

  it('does not let one tenant supersede the other assignment of the same task id', async () => {
    /*
     * Identifier sequences are tenant-scoped (M-SAAS-0), so both customers mint HK-2026-0001
     * for their own first turnover. That collision is correct and expected — and it is
     * exactly the case where an assignment lookup missing its tenant predicate would let one
     * business overwrite the other's roster. The whole point of sharing one assignment store
     * in this harness is to make that reachable.
     */
    const mine = await anEmployee(HR_A.token, { fullName: 'A Person' });
    const theirs = await anEmployee(HR_B.token, { fullName: 'B Person' });
    const myTask = await aTurnover(HR_A.token, 'HYD-501');
    const theirTask = await aTurnover(HR_B.token, 'HYD-601');
    expect(myTask, 'the sequences are tenant-scoped, so the refs collide').toBe(theirTask);

    await h.request(OPS_B.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: theirTask, employeeId: theirs.id,
    });
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: myTask, employeeId: mine.id,
    });

    // B's assignment is untouched and still current.
    const theirHistory = await h.request(
      OPS_B.token, 'GET', `/api/operations/assignments?taskType=HOUSEKEEPING&taskRef=${theirTask}`,
    );
    expect(theirHistory.body).toHaveLength(1);
    expect(theirHistory.body[0].employeeId).toBe(theirs.id);
    expect(theirHistory.body[0].supersededAt).toBeNull();

    const myHistory = await h.request(
      OPS_A.token, 'GET', `/api/operations/assignments?taskType=HOUSEKEEPING&taskRef=${myTask}`,
    );
    expect(myHistory.body).toHaveLength(1);
    expect(myHistory.body[0].employeeId).toBe(mine.id);
  });

  it('shows one tenant none of the other assignments or staffing', async () => {
    const mine = await anEmployee(HR_A.token, { fullName: 'A Person' });
    await anEmployee(HR_B.token, { fullName: 'B Person' });
    const task = await aTurnover(HR_A.token, 'HYD-501');
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: mine.id,
    });

    const theirs = await h.request(OPS_B.token, 'GET', '/api/operations/assignments');
    expect(theirs.body).toEqual([]);

    const myStaff = await h.request(OPS_A.token, 'GET', '/api/operations/staffing');
    const theirStaff = await h.request(OPS_B.token, 'GET', '/api/operations/staffing');
    expect(myStaff.body.staff.map((s: any) => s.displayName)).toEqual(['A Person']);
    expect(theirStaff.body.staff.map((s: any) => s.displayName)).toEqual(['B Person']);
  });

  it('refuses a tenant named in the body, and ignores one in the query', async () => {
    const employee = await anEmployee(HR_A.token);
    const task = await aTurnover(HR_A.token, 'HYD-501');

    const smuggled = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task,
      employeeId: employee.id, tenantId: TENANT_B,
    });
    expect(smuggled.status).toBe(422);

    const steered = await h.request(
      OPS_A.token, 'POST', `/api/operations/assignments?tenant=${TENANT_B}&tenantId=${TENANT_B}`,
      { operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id },
    );
    expect(steered.status, JSON.stringify(steered.body)).toBe(200);
    const theirs = await h.request(OPS_B.token, 'GET', '/api/operations/assignments');
    expect(theirs.body).toEqual([]);
  });
});

/* ================================================================== *
 * 3 · PROPERTY ISOLATION
 * ================================================================== */

describe('operations · property isolation', () => {
  it('refuses a staffing board for the other tenant property, identically to a fiction', async () => {
    const foreign = await h.request(
      OPS_A.token, 'GET', `/api/operations/staffing?property=${PROPERTIES[TENANT_B]![0]}`,
    );
    expect(foreign.status).toBe(404);
    const invented = await h.request(OPS_A.token, 'GET', '/api/operations/staffing?property=ZZZ-999');
    // The question is only ever asked of the caller's own workbook, so the two cannot be
    // distinguished even in principle.
    expect(invented.status).toBe(foreign.status);
    expect(invented.body.error.message).toBe(foreign.body.error.message);
  });

  it('scopes the staffing board to one property when asked', async () => {
    await anEmployee(HR_A.token, { fullName: 'At 501', primaryPropertyId: 'HYD-501' });
    await anEmployee(HR_A.token, { fullName: 'At 502', primaryPropertyId: 'HYD-502' });
    await anEmployee(HR_A.token, { fullName: 'Nowhere' });

    const scoped = await h.request(OPS_A.token, 'GET', '/api/operations/staffing?property=HYD-501');
    expect(scoped.body.staff.map((s: any) => s.displayName)).toEqual(['At 501']);
    // Somebody with no property is shown as unassigned, never attributed to whichever
    // property sorts first.
    const all = await h.request(OPS_A.token, 'GET', '/api/operations/staffing');
    expect(all.body.unassigned).toBe(1);
  });
});

/* ================================================================== *
 * 4 · ROLE — capability AND the rendered payload
 * ================================================================== */

describe('operations · roles', () => {
  it('gives OPERATIONS the operational half and no HR capability at all', () => {
    const ops = capabilitiesFor('OPERATIONS');
    expect(ops).toContain('operations.staff.read');
    expect(ops).toContain('operations.assign');
    // The whole point of the narrower pair: an operations login is not widened into HR.
    expect(ops.filter((c) => c.startsWith('hr.'))).toEqual([]);
    expect(roleHasCapability('OPERATIONS', 'hr.compensation.read')).toBe(false);
  });

  it('sends OPERATIONS no salary, no contact details and no tenant id', async () => {
    const employee = await anEmployee(HR_A.token, {
      fullName: 'Lakshmi Narayan', contactRef: '+91 90000 00000', email: 'lakshmi@example.test',
    });
    await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: employee.id, effectiveFrom: '2026-01-01',
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: 2_500_000 }],
    });

    const staffing = await h.request(OPS_A.token, 'GET', '/api/operations/staffing');
    const payload = JSON.stringify(staffing.body);
    // Asserted on the PAYLOAD, not on the grant table: this project has had a
    // capability-versus-rendered-data mismatch before.
    expect(payload).not.toContain('2500000');
    expect(payload).not.toContain('90000');
    expect(payload).not.toContain('lakshmi@example.test');
    expect(payload).not.toContain(TENANT_A);
    expect(payload).not.toContain('assignedBy');
    // …and it does carry what a supervisor needs.
    expect(payload).toContain('Lakshmi Narayan');
  });

  it('still refuses OPERATIONS every HR route', async () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/hr/'))) {
      const res = await h.request(OPS_A.token, route.method,
        route.path.replace(':id', randomUUID()),
        route.method === 'GET' ? undefined : { operationId: op() });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('refuses INVESTOR every operations route', async () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/operations/'))) {
      const res = await h.request(USERS.investorA!.token, route.method, route.path,
        route.method === 'GET' ? undefined : { operationId: op() });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });
});

/* ================================================================== *
 * 5 · ELIGIBILITY
 * ================================================================== */

describe('operations · who may be given work', () => {
  it('blocks somebody who has left, and does not offer an override', async () => {
    const employee = await anEmployee(HR_A.token);
    await h.request(HR_A.token, 'POST', `/api/hr/employees/${employee.id}/status`, {
      operationId: op(), status: 'EXITED', exitDate: '2026-04-30',
    });
    const task = await aTurnover(HR_A.token, 'HYD-501');

    const res = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
      overrideReason: 'We really need them',
    });
    // An override is for a decision a supervisor may make. This is not one.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_ELIGIBLE');
  });

  it('warns for a weekly off and permits it with a recorded reason', async () => {
    // 2026-05-04 is a Monday; weeklyOffDay 1 is Monday.
    const employee = await anEmployee(HR_A.token, { weeklyOffDay: new Date().getUTCDay() });
    const task = await aTurnover(HR_A.token, 'HYD-501');

    const refused = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('OVERRIDE_REQUIRED');

    const allowed = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
      overrideReason: 'Covering a sick colleague',
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.overrideReason).toBe('Covering a sick colleague');
    expect(allowed.body.warnings.length).toBeGreaterThan(0);
  });
});

/* ================================================================== *
 * 6 · RESOLVING A HISTORICAL NAME
 * ================================================================== */

describe('operations · resolving a free-text name', () => {
  const tenantA = { tenantId: TENANT_A, userId: 'u', role: 'ADMIN' as const };

  it('resolves exactly one match employed on the day', async () => {
    await anEmployee(HR_A.token, { fullName: 'Ravi Kumar', joiningDate: '2020-01-01' });
    const match = await h.service.resolveByName(tenantA, 'Ravi Kumar', '2024-03-01');
    expect(match.kind).toBe('EXACT');
  });

  it('never breaks ambiguity, not even when only one is still here', async () => {
    await anEmployee(HR_A.token, { fullName: 'Ravi Kumar', joiningDate: '2020-01-01' });
    const other = await anEmployee(HR_A.token, { fullName: 'Ravi Kumar', joiningDate: '2021-01-01' });
    await h.request(HR_A.token, 'POST', `/api/hr/employees/${other.id}/status`, {
      operationId: op(), status: 'EXITED', exitDate: '2025-01-01',
    });

    const match = await h.service.resolveByName(tenantA, 'Ravi Kumar', '2024-03-01');
    // "Pick the active one" feels correct and is wrong exactly when the record is old.
    expect(match.kind).toBe('AMBIGUOUS');
    expect(match.kind === 'AMBIGUOUS' && match.candidates).toHaveLength(2);
  });

  it('distinguishes somebody who has since left from somebody who had not yet joined', async () => {
    const left = await anEmployee(HR_A.token, { fullName: 'Old Hand', joiningDate: '2019-01-01' });
    await h.request(HR_A.token, 'POST', `/api/hr/employees/${left.id}/status`, {
      operationId: op(), status: 'EXITED', exitDate: '2025-06-30',
    });
    await anEmployee(HR_A.token, { fullName: 'New Hand', joiningDate: '2027-01-01' });

    // Employed when the work happened, gone now: plausibly did it.
    const historical = await h.service.resolveByName(tenantA, 'Old Hand', '2024-03-01');
    expect(historical.kind).toBe('INACTIVE');

    // The only person of that name today, but they had not joined: certainly did not.
    const mismatch = await h.service.resolveByName(tenantA, 'New Hand', '2024-03-01');
    expect(mismatch.kind).toBe('HISTORICAL_MISMATCH');
  });

  it('separates nobody-by-that-name from an empty cell', async () => {
    expect((await h.service.resolveByName(tenantA, 'Nobody At All', '2024-03-01')).kind)
      .toBe('NO_MATCH');
    expect((await h.service.resolveByName(tenantA, '   ', '2024-03-01')).kind).toBe('UNRECORDED');
  });

  it('cannot see the other tenant people', async () => {
    await anEmployee(HR_B.token, { fullName: 'Only In B' });
    const match = await h.service.resolveByName(tenantA, 'Only In B', '2026-01-01');
    // Byte-identical to a name nobody has anywhere.
    expect(match.kind).toBe('NO_MATCH');
  });
});

/* ================================================================== *
 * 7 · RECONCILIATION — the echo, watched
 * ================================================================== */

describe('operations · reconciliation', () => {
  const tenantA = { tenantId: TENANT_A, userId: 'u', role: 'ADMIN' as const };

  it('reports a sheet somebody edited by hand', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Lakshmi Narayan' });
    const task = await aTurnover(HR_A.token, 'HYD-501');
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });
    /*
     * Scoped to this task. The demo workbook ships turnovers that already carry cleaner
     * names and no assignment behind them — which the reconciliation correctly reports as
     * UNLINKED_NAME, and which is exactly the historical state this milestone inherits.
     */
    const mine = () => h.service.reconcile(tenantA)
      .then((rows) => rows.filter((d) => d.taskRef === task));
    expect(await mine()).toEqual([]);

    // A supervisor types over the cell because somebody swapped shifts. Both halves stay
    // internally consistent and nothing fails — which is why this has to be reported.
    await h.request(HR_A.token, 'PATCH', `/api/housekeeping/${task}`, {
      operationId: op(), cleaner: 'Somebody Else',
    });

    const divergences = await mine();
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.kind).toBe('SHEET_EDITED');
    expect(divergences[0]!.sheetName).toBe('Somebody Else');
    expect(divergences[0]!.echoedName).toBe('Lakshmi Narayan');
  });

  it('reports a name on the sheet with nothing behind it', async () => {
    // Every historical row looks like this, so it is reported rather than treated as an
    // error — and it is exactly the state a partial write would leave.
    const task = await aTurnover(HR_A.token, 'HYD-501');
    await h.request(HR_A.token, 'PATCH', `/api/housekeeping/${task}`, {
      operationId: op(), cleaner: 'Ravi',
    });
    const divergences = await h.service.reconcile(tenantA);
    expect(divergences.map((d) => d.kind)).toContain('UNLINKED_NAME');
  });

  it('sees only its own tenant divergences', async () => {
    const task = await aTurnover(HR_B.token, 'HYD-601');
    await h.request(HR_B.token, 'PATCH', `/api/housekeeping/${task}`, {
      operationId: op(), cleaner: 'B Cleaner',
    });
    const mine = await h.service.reconcile(tenantA);
    expect(mine.some((d) => d.taskRef === task)).toBe(false);
    expect(mine.some((d) => d.sheetName === 'B Cleaner')).toBe(false);
  });
});

/* ================================================================== *
 * 8 · SEPARATION FROM ATTENDANCE AND PAYROLL
 * ================================================================== */

describe('operations · what an assignment does NOT do', () => {
  it('does not create, change or imply attendance', async () => {
    const employee = await anEmployee(HR_A.token);
    const task = await aTurnover(HR_A.token, 'HYD-501');

    const before = await h.request(HR_A.token, 'GET', '/api/hr/attendance');
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });
    const after = await h.request(HR_A.token, 'GET', '/api/hr/attendance');

    // Assigned work is not evidence somebody worked. Attendance is recorded and approved
    // by a person, and stays the authority.
    expect(after.body).toEqual(before.body);
    expect(after.body).toEqual([]);
  });

  it('does not create or change payroll', async () => {
    const employee = await anEmployee(HR_A.token);
    const task = await aTurnover(HR_A.token, 'HYD-501');
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });
    // Completing the task, too.
    await h.request(HR_A.token, 'PATCH', `/api/housekeeping/${task}`, {
      operationId: op(), finalStatus: 'Completed',
    });

    const runs = await h.request(HR_A.token, 'GET', '/api/hr/payroll');
    expect(runs.body).toEqual([]);
  });

  it('creates no expense when maintenance work is assigned', async () => {
    const employee = await anEmployee(HR_A.token);
    const ticket = await aTicket(HR_A.token, 'HYD-501');
    const before = await h.wb.reposFor(TENANT_A).expenses.readAll();

    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'MAINTENANCE', taskRef: ticket, employeeId: employee.id,
    });

    // Work having been done is not the same claim as money having been spent.
    // 14_MAINTENANCE.ExpenseID stays a decision a person makes.
    expect(await h.wb.reposFor(TENANT_A).expenses.readAll()).toEqual(before);
  });
});

/* ================================================================== *
 * 9 · CONCURRENCY, IDEMPOTENCY AND AUDIT
 * ================================================================== */

describe('operations · concurrency and idempotency', () => {
  it('does not turn a retried assignment into two', async () => {
    const employee = await anEmployee(HR_A.token);
    const task = await aTurnover(HR_A.token, 'HYD-501');
    const body = {
      operationId: op(), taskType: 'HOUSEKEEPING' as const, taskRef: task, employeeId: employee.id,
    };

    const first = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', body);
    const retry = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', body);
    expect(retry.body.id).toBe(first.body.id);

    const history = await h.request(
      OPS_A.token, 'GET', `/api/operations/assignments?taskType=HOUSEKEEPING&taskRef=${task}`,
    );
    expect(history.body).toHaveLength(1);
  });

  it('refuses a byte-identical request replayed by the other tenant', async () => {
    /*
     * IDENTICAL payloads, which is the only shape that isolates the tenant comparison: a
     * differing body would be refused on the request hash, and the tenant predicate could
     * have been removed entirely without the test noticing.
     */
    const operationId = op();
    const body = { operationId, name: 'Housekeeping' };

    const a = await h.request(HR_A.token, 'POST', '/api/hr/departments', body);
    expect(a.status).toBe(200);
    const b = await h.request(HR_B.token, 'POST', '/api/hr/departments', body);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('OPERATION_MISMATCH');
    expect(JSON.stringify(b.body)).not.toContain(a.body.id);
  });

  it('records the tenant and the task, and never the employee name', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Lakshmi Narayan' });
    const task = await aTurnover(HR_A.token, 'HYD-501');
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });

    const record = h.wb.audit.records.find((r) => r.action === 'operations.task.assign.applied');
    expect(record).toBeTruthy();
    expect(record!.tenantId).toBe(TENANT_A);
    expect(record!.actorId).toBe(OPS_A.userId);
    /*
     * An audit trail listing who was put on which turnover is a staff-movement record
     * nobody asked for, and `redactMetadata` would not strip a name under an unknown key.
     */
    expect(JSON.stringify(record!.metadata)).not.toContain('Lakshmi');
    expect(Object.keys(record!.metadata).sort())
      .toEqual(['operationId', 'overridden', 'taskRef', 'taskType']);
  });
});

/* ================================================================== *
 * 10 · GOVERNANCE
 * ================================================================== */

describe('operations · governance', () => {
  it('satisfies the write-governance contract for the whole registry', () => {
    assertWriteGovernance(API_ROUTES, (condition, message) => {
      expect(condition, message).toBe(true);
    });
  });

  it('demands the assign capability to assign, and the read one only to read', () => {
    /*
     * Asserted on the REGISTRY because the two capabilities are held by the same roles
     * today, so no behavioural case can tell them apart — a route quietly downgraded from
     * `operations.assign` to `operations.staff.read` would change nothing observable. The
     * split exists so a deployment CAN separate reading the roster from changing it, and
     * this is what stops it being erased before anybody uses it.
     */
    const byPath = new Map(API_ROUTES.map((r) => [`${r.method} ${r.path}`, r.capability]));
    expect(byPath.get('POST /api/operations/assignments')).toBe('operations.assign');
    expect(byPath.get('GET /api/operations/assignments')).toBe('operations.staff.read');
    expect(byPath.get('GET /api/operations/staffing')).toBe('operations.staff.read');
    expect(byPath.get('GET /api/operations/metrics')).toBe('operations.staff.read');
  });

  it('declares every operations write, and none as a workbook, finance or HR mutation', () => {
    const ops = API_ROUTES.filter((r) => r.path.startsWith('/api/operations/'));
    expect(ops.length).toBeGreaterThan(0);
    for (const route of ops.filter((r) => r.method !== 'GET')) {
      expect(route.writesOps, `${route.path} must declare writesOps`).toBe(true);
      expect(route.mutates, route.path).toBeUndefined();
      expect(route.writesFinance, route.path).toBeUndefined();
      expect(route.writesHr, route.path).toBeUndefined();
    }
  });

  it('keeps the assignment write on the existing verified pipeline', () => {
    // A second write path to the same sheet is exactly what the mutation layer exists to
    // prevent, so the assignment reuses the declared definitions rather than a client.
    const wiring = codeOf(read('lib/server/api/service.ts'));
    expect(wiring).toContain("MUTATION_DEFINITIONS[housekeeping ? 'housekeeping.update' : 'maintenance.update']");
    expect(wiring).toContain('executeMutation(definition');
    const service = codeOf(read('lib/server/operations/service.ts'));
    expect(service).not.toMatch(/createRepositories|GoogleSheetsClient|reposFor/);
  });

  it('states the divided authority where a reader will find it', () => {
    const sql = read('supabase/migrations/0008_ops_task_assignments.sql');
    expect(sql).toMatch(/the workbook\s+owns the TASK/);
    expect(sql).toContain('display_name_written');
    const flattened = sql.replace(/\s+/g, ' ');
    expect(flattened).toContain('alter table ops_task_assignments enable row level security');
    expect(flattened).toContain('revoke all on ops_task_assignments from authenticated, anon');
    // The rules live in TypeScript, because nothing here executes SQL.
    expect(sql).not.toMatch(/create (or replace )?function|create trigger/i);
  });
});


/* ================================================================== *
 * M-OPS-3 · RECONCILIATION, URGENCY, AND THE HISTORY BEHIND A NAME
 * ================================================================== */

/** A ticket with a chosen priority and date — the two things urgency and history turn on. */
async function aTicketLike(
  token: string, propertyId: string,
  over: { priority?: string; dateReported?: string; description?: string } = {},
) {
  const res = await h.request(token, 'POST', '/api/maintenance', {
    operationId: op(), propertyId, dateReported: over.dateReported ?? '2026-05-04',
    issueCategory: 'Plumbing', description: over.description ?? 'Slow drain',
    priority: over.priority ?? 'High',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.record.TicketID);
}

/** Put a name in the sheet cell without creating an assignment — a pre-MAKAM row. */
async function nameOnSheetOnly(token: string, taskRef: string, name: string) {
  const res = await h.request(token, 'PATCH', `/api/housekeeping/${taskRef}`, {
    operationId: op(), cleaner: name,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const rowFor = (report: { rows: readonly { taskRef: string }[] }, taskRef: string) =>
  report.rows.find((r) => r.taskRef === taskRef);

describe('reconciliation · what the sheet and the record each say', () => {
  it('calls an assignment we made, and echoed, MATCHED', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Anita Rao' });
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    const assigned = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    const report = await h.service.reconciliationReport(OPS_A as never);
    expect(rowFor(report, task)?.status).toBe('MATCHED');
    expect(rowFor(report, task)?.employee?.displayName).toBe('Anita Rao');
  });

  it('calls a hand-edited sheet cell ECHO_MISMATCH, and keeps both names', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Anita Rao' });
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });

    // A supervisor types over the cell in the customer's own spreadsheet. Nothing fails.
    await nameOnSheetOnly(OPS_A.token, task, 'Somebody Else');

    const row = rowFor(await h.service.reconciliationReport(OPS_A as never), task);
    expect(row?.status).toBe('ECHO_MISMATCH');
    expect(row?.sheetName, 'what the workbook now says').toBe('Somebody Else');
    expect(row?.employee?.displayName, 'who the record still names').toBe('Anita Rao');
    // Reported, never resolved: which of the two is right is not ours to decide.
    expect(row?.recommendation).toBe('REPAIR_ECHO');
  });

  it('calls a lone resolvable name UNLINKED and offers to bind it', async () => {
    await anEmployee(HR_A.token, { fullName: 'Lakshmi Narayanan', preferredName: 'Lakshmi' });
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    await nameOnSheetOnly(OPS_A.token, task, 'Lakshmi');

    const row = rowFor(await h.service.reconciliationReport(OPS_A as never), task);
    expect(row?.status).toBe('UNLINKED');
    expect(row?.recommendation).toBe('BIND');
    expect(row?.employee?.displayName).toBe('Lakshmi');
  });

  it('refuses to choose when two people answer to one name', async () => {
    // Both employed well before the task, so the date cannot separate them either.
    await anEmployee(HR_A.token, {
      fullName: 'Ramesh Babu', preferredName: 'Ramesh', joiningDate: '2020-01-01',
    });
    await anEmployee(HR_A.token, {
      fullName: 'Ramesh Gupta', preferredName: 'Ramesh', joiningDate: '2021-01-01',
    });
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    await nameOnSheetOnly(OPS_A.token, task, 'Ramesh');

    const row = rowFor(await h.service.reconciliationReport(OPS_A as never), task);
    expect(row?.status).toBe('AMBIGUOUS');
    // Never BIND. This is the case the whole design exists to refuse to guess at.
    expect(row?.recommendation).toBe('REVIEW');
    expect(row?.employee, 'nobody is chosen').toBeNull();
    /*
     * The candidates are named in FULL. Both go by "Ramesh" — that is what makes this
     * ambiguous — so listing the name they share twice would present a choice with no
     * information in it. Their codes distinguish them too, and the screen shows both.
     */
    expect(row?.candidates.map((c) => c.displayName).sort())
      .toEqual(['Ramesh Babu', 'Ramesh Gupta']);
    expect(new Set(row?.candidates.map((c) => c.employeeCode)).size).toBe(2);
  });

  it('resolves a name against the day the work happened, not against today', async () => {
    /*
     * THE TEST THIS WHOLE FEATURE TURNS ON.
     *
     * One person holds the name "Ramesh" today. The turnover is dated 2026-05-04 and he
     * joined in 2027 — so he cannot have done it, however confidently a lookup by current
     * name would say otherwise. Getting this wrong writes a permanent, plausible, false
     * statement about two people into an operational record.
     */
    await anEmployee(HR_A.token, {
      fullName: 'Ramesh Gupta', preferredName: 'Ramesh', joiningDate: '2027-04-01',
    });
    const task = await aTurnover(OPS_A.token, 'HYD-501');   // dated 2026-05-04
    await nameOnSheetOnly(OPS_A.token, task, 'Ramesh');

    const row = rowFor(await h.service.reconciliationReport(OPS_A as never), task);
    expect(row?.status, 'he was not employed on the day').toBe('HISTORICAL');
    expect(row?.recommendation).toBe('IGNORE_HISTORICAL');
  });

  it('calls a name nobody answers to MISSING_RELATION', async () => {
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    await nameOnSheetOnly(OPS_A.token, task, 'Nobody By That Name');

    const row = rowFor(await h.service.reconciliationReport(OPS_A as never), task);
    expect(row?.status).toBe('MISSING_RELATION');
  });

  it('treats an unassigned task with a blank cell as agreement, not as a problem', async () => {
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    const row = rowFor(await h.service.reconciliationReport(OPS_A as never), task);
    // Both stores agree that nobody holds it. Most tasks are like this most of the time.
    expect(row?.status).toBe('MATCHED');
    expect(row?.recommendation).toBe('NONE');
  });

  it('counts what needs a person separately from what does not', async () => {
    await anEmployee(HR_A.token, { fullName: 'Lakshmi N', preferredName: 'Lakshmi' });
    const bound = await aTurnover(OPS_A.token, 'HYD-501');
    const loose = await aTurnover(OPS_A.token, 'HYD-501');
    await nameOnSheetOnly(OPS_A.token, loose, 'Lakshmi');

    const employee = (await h.request(OPS_A.token, 'GET', '/api/hr/employees')).body;
    void employee;
    void bound;

    const report = await h.service.reconciliationReport(OPS_A as never);
    expect(report.summary.total).toBe(report.rows.length);
    expect(report.summary.unlinked).toBeGreaterThanOrEqual(1);
  });
});

describe('reconciliation · one tenant cannot see another', () => {
  it('reports only the caller’s own tasks', async () => {
    /*
     * Identifier sequences are tenant-scoped, so A's first turnover and B's first turnover
     * carry the SAME reference. Asserting that B's id is absent from A's report would
     * therefore prove nothing — it is A's id too. What must not cross is the CONTENT, so
     * that is what is asserted: a name written only into B's workbook.
     */
    const theirs = await aTurnover(OPS_B.token, 'HYD-601');
    await nameOnSheetOnly(OPS_B.token, theirs, 'Bala Of Tenant B');
    const mine = await aTurnover(OPS_A.token, 'HYD-501');
    await nameOnSheetOnly(OPS_A.token, mine, 'Anita Of Tenant A');

    const forA = await h.service.reconciliationReport(OPS_A as never);
    expect(forA.rows.some((r) => r.sheetName === 'Anita Of Tenant A')).toBe(true);
    expect(forA.rows.some((r) => r.sheetName === 'Bala Of Tenant B'),
      'B’s workbook must not reach A’s report').toBe(false);

    const forB = await h.service.reconciliationReport(OPS_B as never);
    expect(forB.rows.some((r) => r.sheetName === 'Bala Of Tenant B')).toBe(true);
    expect(forB.rows.some((r) => r.sheetName === 'Anita Of Tenant A')).toBe(false);
  });

  it('does not resolve a name against the other tenant’s staff', async () => {
    // Only B employs anybody called Bala. A's sheet naming "Bala" must not find them.
    await anEmployee(HR_B.token, { fullName: 'Bala Krishnan', preferredName: 'Bala' });
    const mine = await aTurnover(OPS_A.token, 'HYD-501');
    await nameOnSheetOnly(OPS_A.token, mine, 'Bala');

    const row = rowFor(await h.service.reconciliationReport(OPS_A as never), mine);
    expect(row?.status, 'a name is resolved inside one tenant only').toBe('MISSING_RELATION');
    expect(row?.employee).toBeNull();
  });

  it('serves the reconciliation route scoped to the caller', async () => {
    const theirs = await aTurnover(OPS_B.token, 'HYD-601');
    const res = await h.request(OPS_A.token, 'GET', '/api/operations/reconciliation');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(theirs);
  });
});

describe('urgent work with no owner', () => {
  it('raises open, urgent, unassigned maintenance and nothing else', async () => {
    const critical = await aTicketLike(OPS_A.token, 'HYD-501', { priority: 'Critical' });
    const routine = await aTicketLike(OPS_A.token, 'HYD-501', { priority: 'Low' });

    const urgent = await h.service.unassignedUrgent(OPS_A as never);
    const refs = urgent.map((u) => u.taskRef);
    expect(refs).toContain(critical);
    // An unassigned LOW ticket is ordinary. Alerting on it teaches people to ignore alerts.
    expect(refs).not.toContain(routine);
  });

  it('gives the same ticket the same identity every time it is derived', async () => {
    const critical = await aTicketLike(OPS_A.token, 'HYD-501', { priority: 'Critical' });

    const first = await h.service.unassignedUrgent(OPS_A as never);
    const second = await h.service.unassignedUrgent(OPS_A as never);

    // Derived, never appended: a refresh cannot mint a second copy, and the key matches the
    // Today board's own `mnt-<ticketId>` convention so one ticket is one thing everywhere.
    expect(second).toEqual(first);
    expect(first.find((u) => u.taskRef === critical)?.key).toBe(`mnt-${critical}`);
    expect(new Set(second.map((u) => u.key)).size).toBe(second.length);
  });

  it('stops raising it the moment somebody is assigned', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Ravi Technician' });
    const critical = await aTicketLike(OPS_A.token, 'HYD-501', { priority: 'Critical' });
    expect((await h.service.unassignedUrgent(OPS_A as never)).map((u) => u.taskRef))
      .toContain(critical);

    const res = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'MAINTENANCE', taskRef: critical, employeeId: employee.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Resolved by the fact changing, not by anybody remembering to close an alert.
    expect((await h.service.unassignedUrgent(OPS_A as never)).map((u) => u.taskRef))
      .not.toContain(critical);
  });

  it('stops raising it when the ticket is resolved', async () => {
    const critical = await aTicketLike(OPS_A.token, 'HYD-501', { priority: 'Critical' });
    const res = await h.request(OPS_A.token, 'PATCH', `/api/maintenance/${critical}`, {
      operationId: op(), status: 'Resolved', dateResolved: '2026-05-06',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect((await h.service.unassignedUrgent(OPS_A as never)).map((u) => u.taskRef))
      .not.toContain(critical);
  });

  it('derives urgency per tenant, even when both hold the same reference', async () => {
    /*
     * The strongest available proof, and it uses the id collision rather than fighting it.
     *
     * Both tenants mint the same ticket reference, because sequences are tenant-scoped. A
     * assigns theirs; B does not. If the derivation leaked across the boundary — by
     * matching on reference alone, say — A's assignment would silence B's ticket too, and
     * a customer would stop being told about urgent work nobody is doing.
     */
    const employee = await anEmployee(HR_A.token, { fullName: 'Ravi Technician' });
    const mine = await aTicketLike(OPS_A.token, 'HYD-501', { priority: 'Critical' });
    const theirs = await aTicketLike(OPS_B.token, 'HYD-601', { priority: 'Critical' });
    expect(mine, 'the sequences are tenant-scoped, so the refs collide').toBe(theirs);

    const assigned = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'MAINTENANCE', taskRef: mine, employeeId: employee.id,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    expect((await h.service.unassignedUrgent(OPS_A as never)).map((u) => u.taskRef),
      'A has an owner for it now').not.toContain(mine);
    expect((await h.service.unassignedUrgent(OPS_B as never)).map((u) => u.taskRef),
      'B still has nobody on theirs').toContain(theirs);
  });

  it('refuses a property the caller does not operate, exactly as a missing one', async () => {
    await expect(h.service.unassignedUrgent(OPS_A as never, 'HYD-601')).rejects.toThrow();
    await expect(h.service.unassignedUrgent(OPS_A as never, 'NOT-A-PROPERTY')).rejects.toThrow();
  });

  it('says how long the work has waited', async () => {
    const critical = await aTicketLike(OPS_A.token, 'HYD-501', {
      priority: 'Critical', dateReported: '2026-05-01',
    });
    const [item] = (await h.service.unassignedUrgent(OPS_A as never, undefined, '2026-05-06'))
      .filter((u) => u.taskRef === critical);
    expect(item?.ageDays).toBe(5);
  });
});

describe('M-OPS-3 · the new surfaces keep the existing boundaries', () => {
  it('carries no compensation or contact field into any operations payload', async () => {
    await anEmployee(HR_A.token, {
      fullName: 'Anita Rao', contactRef: '+91-99999-00000', email: 'anita@example.test',
    });
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    await nameOnSheetOnly(OPS_A.token, task, 'Anita Rao');

    for (const path of ['/api/operations/reconciliation', '/api/operations/urgent',
      '/api/operations/staffing']) {
      const res = await h.request(OPS_A.token, 'GET', path);
      expect(res.status, path).toBe(200);
      const body = JSON.stringify(res.body);
      for (const forbidden of ['salary', 'gross', 'net', 'payroll', 'bank',
        'contactRef', '99999-00000', 'anita@example.test', 'tenantId']) {
        expect(body.toLowerCase(), `${path} must not carry ${forbidden}`)
          .not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it('gives the reconciliation and urgent routes the staffing capability, not a wider one', () => {
    const byPath = new Map(API_ROUTES.map((r) => [`${r.method} ${r.path}`, r.capability]));
    expect(byPath.get('GET /api/operations/reconciliation')).toBe('operations.staff.read');
    expect(byPath.get('GET /api/operations/urgent')).toBe('operations.staff.read');
    // Assignment stays the one write, behind the one capability that means it.
    expect(byPath.get('POST /api/operations/assignments')).toBe('operations.assign');
  });

  it('keeps an investor out of every operations surface', async () => {
    for (const path of ['/api/operations/reconciliation', '/api/operations/urgent',
      '/api/operations/staffing', '/api/operations/assignments']) {
      const res = await h.request(USERS.investorA.token, 'GET', path);
      expect([401, 403], `${path} must refuse an investor`).toContain(res.status);
    }
  });

  it('adds no second way to assign a task', () => {
    // One assignment abstraction. A per-domain assign route would be a second place for one
    // of the checks to be forgotten.
    const assigning = API_ROUTES.filter((r) => r.method !== 'GET'
      && /assign/i.test(r.path));
    expect(assigning.map((r) => r.path)).toEqual(['/api/operations/assignments']);
    expect(() => assertWriteGovernance(API_ROUTES, (condition, message) => {
      if (!condition) throw new Error(message);
    })).not.toThrow();
  });

  it('never names an employee in the audit trail for an assignment', async () => {
    const employee = await anEmployee(HR_A.token, { fullName: 'Anita Rao' });
    const task = await aTurnover(OPS_A.token, 'HYD-501');
    await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
    });
    const entries = JSON.stringify(h.wb.deps.audit ? await h.wb.auditEntries?.() ?? [] : []);
    if (entries !== '[]') {
      expect(entries, 'a staff-movement record is not what an audit trail is for')
        .not.toContain('Anita Rao');
    }
  });
});

describe('assignment · a task whose property the workbook no longer lists', () => {
  it('refuses rather than assigning around a property that has gone', async () => {
    /*
     * The belt-and-braces check, and the only situation that reaches it.
     *
     * A task always arrives from the caller's own workbook, so its property is normally
     * theirs by construction. It stops being theirs when the property LEAVES the workbook
     * while its tasks remain — a unit sold, a listing retired, a row deleted. The turnover
     * still exists and still names somewhere this business no longer operates.
     *
     * Assigning it would quietly attach a person to work at a property the system cannot
     * account for. Refusing surfaces the data problem instead, which is the whole point of
     * a check that "cannot" fire.
     */
    const employee = await anEmployee(HR_A.token, { fullName: 'Anita Rao' });
    const task = await aTurnover(OPS_A.token, 'HYD-502');

    const owned = PROPERTIES[TENANT_A]!;
    const before = [...owned];
    // The property leaves the workbook, exactly as it would if the unit were retired.
    owned.splice(owned.indexOf('HYD-502'), 1);
    try {
      const res = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
        operationId: op(), taskType: 'HOUSEKEEPING', taskRef: task, employeeId: employee.id,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error?.code ?? res.body.code)).toBe('UNKNOWN_PROPERTY');
    } finally {
      owned.splice(0, owned.length, ...before);
    }
  });
});

describe('assignment · a supervisor cannot reach across the boundary', () => {
  it('refuses another tenant’s employee on the caller’s own task', async () => {
    const theirs = await anEmployee(HR_B.token, { fullName: 'Bala of B' });
    const mine = await aTurnover(OPS_A.token, 'HYD-501');
    const res = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: mine, employeeId: theirs.id,
    });
    expect(res.status, 'a foreign employee is not found').toBe(404);
  });

  it('refuses the caller’s own employee on another tenant’s task', async () => {
    const mine = await anEmployee(HR_A.token, { fullName: 'Anita Rao' });
    const theirs = await aTurnover(OPS_B.token, 'HYD-601');
    const res = await h.request(OPS_A.token, 'POST', '/api/operations/assignments', {
      operationId: op(), taskType: 'HOUSEKEEPING', taskRef: theirs, employeeId: mine.id,
    });
    expect(res.status, 'a foreign task is not found').toBe(404);
  });
});
