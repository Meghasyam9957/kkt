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
      }));
    }
    return (await repos.maintenance.readAll()).map((t) => ({
      taskRef: t.ticketId,
      propertyId: t.propertyId || null,
      assigneeName: t.assignedTo || null,
      status: t.status,
      open: OPEN_MAINTENANCE_STATUSES.includes(t.status),
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
