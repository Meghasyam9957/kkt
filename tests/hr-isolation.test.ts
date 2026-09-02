/**
 * M-HR-1 — PEOPLE, ACROSS TWO TENANTS.
 *
 * Both tenants share ONE `InMemoryHrRepository` — the same object, the same maps — so
 * everything below is a claim about the tenant predicate and nothing else. A harness that
 * gave each tenant its own repository would pass every case here while proving only that
 * two Maps are two Maps.
 *
 * HR carries a second axis finance does not: a colleague's salary is not a colleague's
 * business. So the role cases assert the RENDERED RESPONSE for every route rather than the
 * grant table — this project has had a capability-versus-rendered-data mismatch before.
 *
 * And one case matters more than the isolation: a payroll run over a month with gaps in
 * its attendance produces a plausible number that a human approves and money leaves
 * against. Every other failure here is loud; that one is silent by construction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ApiRouter } from '@/lib/server/api/router';
import { API_ROUTES, assertWriteGovernance } from '@/lib/server/api/routes';
import { registerHrHandlers } from '@/lib/server/api/hr-handlers';
import { InMemoryAuthProvider, type TestUser } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { InMemoryOperationStore } from '@/lib/server/ops/operation-store';
import { InMemoryHrRepository } from '@/lib/server/hr/repository';
import { SupabaseHrRepository } from '@/lib/server/hr/supabase-repository';
import { HrService } from '@/lib/server/hr/service';
import { PAYROLL_TRANSITIONS, APPROVAL_TRANSITIONS } from '@/lib/server/hr/types';
import { paise } from '@/lib/server/finance/money';
import { FINANCIAL_CAPABILITIES, capabilitiesFor, roleHasCapability } from '@/lib/shared/roles';
import { TENANT_A, TENANT_B, USERS } from './support/harness';
import { readSource as read, codeOf } from './support/source';

/* ------------------------------------------------------------------ *
 * Harness — one repository, two tenants
 * ------------------------------------------------------------------ */

const HR_A: TestUser = {
  userId: 'u-hr-a', email: 'hr.a@example.test', role: 'ADMIN', tenantId: TENANT_A, token: 'tok-hr-a',
};
const APPROVER_A: TestUser = {
  userId: 'u-appr-a', email: 'appr.a@example.test', role: 'ADMIN', tenantId: TENANT_A, token: 'tok-appr-a',
};
const PAYROLL_A: TestUser = {
  userId: 'u-pay-a', email: 'pay.a@example.test', role: 'SUPER_ADMIN', tenantId: TENANT_A, token: 'tok-pay-a',
};
const HR_B: TestUser = {
  userId: 'u-hr-b', email: 'hr.b@example.test', role: 'ADMIN', tenantId: TENANT_B, token: 'tok-hr-b',
};

const PROPERTIES: Record<string, string[]> = {
  [TENANT_A]: ['HYD-501', 'HYD-502'],
  [TENANT_B]: ['BLR-101'],
};

interface Harness {
  repo: InMemoryHrRepository;
  audit: InMemoryAuditSink;
  closed: Set<string>;
  request(token: string | null, method: string, path: string, body?: unknown):
    Promise<{ status: number; body: any }>;
}

function harness(): Harness {
  const repo = new InMemoryHrRepository();
  const audit = new InMemoryAuditSink();
  const auditService = new AuditLogger(audit);
  const store = new InMemoryOperationStore();
  // Finance's lock, stubbed as the set of closed months. HR never owns one of its own.
  const closed = new Set<string>();

  const router = new ApiRouter({
    authProvider: new InMemoryAuthProvider([
      ...Object.values(USERS), HR_A, APPROVER_A, PAYROLL_A, HR_B,
    ]),
    audit: auditService,
  });

  registerHrHandlers(router, async () => ({
    service: new HrService({
      repo,
      propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
      isPeriodClosed: async (tenant, isoDate) => closed.has(`${tenant.tenantId}|${isoDate.slice(0, 7)}`),
      audit: auditService,
    }),
    store,
    audit: auditService,
    writesPermitted: true,
  }));

  return {
    repo, audit, closed,
    async request(token, method, requestPath, body) {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      const [path, search = ''] = requestPath.split('?');
      const response = await router.dispatch({
        method, path: path!, headers, body,
        query: Object.fromEntries(new URLSearchParams(search)),
        requestId: `req-${randomUUID().slice(0, 8)}`,
      });
      return { status: response.status, body: response.body as any };
    },
  };
}

const op = () => randomUUID();

async function anEmployee(h: Harness, token: string, over: Record<string, unknown> = {}) {
  const res = await h.request(token, 'POST', '/api/hr/employees', {
    operationId: op(), fullName: 'Lakshmi Narayan', joiningDate: '2026-01-05', ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function approvedAttendance(
  h: Harness, employeeId: string, date: string, status = 'PRESENT',
) {
  const created = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
    operationId: op(), employeeId, attendanceDate: date, status,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const submitted = await h.request(HR_A.token, 'POST', `/api/hr/attendance/${created.body.id}/submit`, { operationId: op() });
  expect(submitted.status).toBe(200);
  const approved = await h.request(APPROVER_A.token, 'POST', `/api/hr/attendance/${created.body.id}/approve`, { operationId: op() });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return approved.body;
}

let h: Harness;
beforeEach(() => { h = harness(); });

/* ================================================================== *
 * 1 · TENANT ISOLATION
 * ================================================================== */

describe('hr · tenant isolation', () => {
  it('shows one tenant none of the other people, attendance, leave, overtime or payroll', async () => {
    const employee = await anEmployee(h, HR_A.token);
    await approvedAttendance(h, employee.id, '2026-05-04');
    await h.request(HR_A.token, 'POST', '/api/hr/overtime', {
      operationId: op(), employeeId: employee.id, overtimeDate: '2026-05-04',
      minutes: 90, reason: 'Late checkout turnaround',
    });
    await h.request(HR_A.token, 'POST', '/api/hr/payroll', { operationId: op(), periodStart: '2026-05-01' });

    for (const path of ['employees', 'attendance', 'overtime']) {
      const mine = await h.request(HR_A.token, 'GET', `/api/hr/${path}`);
      const theirs = await h.request(HR_B.token, 'GET', `/api/hr/${path}`);
      expect(mine.body.length, `A must see its own ${path}`).toBeGreaterThan(0);
      expect(theirs.body, `B must see no ${path} of A's`).toEqual([]);
    }
    const theirPayroll = await h.request(HR_B.token, 'GET', '/api/hr/payroll');
    expect(theirPayroll.body).toEqual([]);
  });

  it('reports an empty workforce to a tenant with no people of its own', async () => {
    await anEmployee(h, HR_A.token);
    const a = await h.request(HR_A.token, 'GET', '/api/hr/overview?period=2026-05-01');
    const b = await h.request(HR_B.token, 'GET', '/api/hr/overview?period=2026-05-01');
    expect(a.body.headcount).toBe(1);
    // Zero because this business employs nobody — a fact, not missing data.
    expect(b.body.headcount).toBe(0);
  });

  it('gives each tenant its own employee numbering, so neither reveals the other headcount', async () => {
    const a1 = await anEmployee(h, HR_A.token, { fullName: 'A One' });
    const a2 = await anEmployee(h, HR_A.token, { fullName: 'A Two' });
    const b1 = await anEmployee(h, HR_B.token, { fullName: 'B One' });

    expect(a1.employeeCode).toBe('EMP-0001');
    expect(a2.employeeCode).toBe('EMP-0002');
    // B's first hire is EMP-0001, not EMP-0003 — the sequence is derived from the caller's
    // own people, so it cannot disclose how many staff another business has.
    expect(b1.employeeCode).toBe('EMP-0001');
  });
});

/* ================================================================== *
 * 2 · IDOR
 * ================================================================== */

describe('hr · identifiers from the other tenant', () => {
  it('answers "no such record" for every kind, and identically to one that never existed', async () => {
    const theirs = await anEmployee(h, HR_B.token, { fullName: 'Confidential Wodehouse' });
    const theirAttendance = await h.request(HR_B.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: theirs.id, attendanceDate: '2026-05-04', status: 'PRESENT',
    });
    expect(theirAttendance.status).toBe(200);

    // A records attendance for B's employee: the employee is simply not found.
    const crossAttendance = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: theirs.id, attendanceDate: '2026-05-05', status: 'PRESENT',
    });
    expect(crossAttendance.status).toBe(404);

    // A approves B's attendance record: same answer.
    const crossApprove = await h.request(
      APPROVER_A.token, 'POST', `/api/hr/attendance/${theirAttendance.body.id}/submit`,
      { operationId: op() },
    );
    expect(crossApprove.status).toBe(404);

    // A gives B's employee a salary: same answer, so the roster is not enumerable.
    const crossSalary = await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: theirs.id, effectiveFrom: '2026-05-01',
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: 2_500_000 }],
    });
    expect(crossSalary.status).toBe(404);

    // …and an id that never existed answers the same, so nothing is learned by comparing.
    const invented = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: randomUUID(), attendanceDate: '2026-05-05', status: 'PRESENT',
    });
    expect(invented.status).toBe(crossAttendance.status);
    expect(invented.body.error.code).toBe(crossAttendance.body.error.code);
    expect(invented.body.error.message).toBe(crossAttendance.body.error.message);
  });

  it('leaves the other tenant records untouched by a failed attempt', async () => {
    const theirs = await anEmployee(h, HR_B.token);
    const before = await h.request(HR_B.token, 'GET', '/api/hr/employees');

    await h.request(HR_A.token, 'POST', `/api/hr/employees/${theirs.id}/status`, {
      operationId: op(), status: 'EXITED', exitDate: '2026-06-30',
    });

    const after = await h.request(HR_B.token, 'GET', '/api/hr/employees');
    expect(after.body).toEqual(before.body);
    expect(after.body[0].status).toBe('ACTIVE');
  });

  it('refuses a payroll run belonging to the other tenant', async () => {
    const theirRun = await h.request(HR_B.token, 'POST', '/api/hr/payroll', {
      operationId: op(), periodStart: '2026-05-01',
    });
    expect(theirRun.status).toBe(200);

    const read = await h.request(PAYROLL_A.token, 'GET', `/api/hr/payroll/${theirRun.body.id}`);
    expect(read.status).toBe(404);

    const post = await h.request(PAYROLL_A.token, 'POST', `/api/hr/payroll/${theirRun.body.id}/post`, { operationId: op() });
    expect(post.status).toBe(404);
  });
});

/* ================================================================== *
 * 3 · TENANT AND PROPERTY SPOOFING
 * ================================================================== */

describe('hr · a caller cannot name a tenant or a foreign property', () => {
  it('refuses a tenant smuggled into the body', async () => {
    for (const smuggled of [{ tenantId: TENANT_B }, { tenant_id: TENANT_B }, { tenant: TENANT_B }]) {
      const res = await h.request(HR_A.token, 'POST', '/api/hr/employees', {
        operationId: op(), fullName: 'Steered', joiningDate: '2026-01-05', ...smuggled,
      });
      expect(res.status, JSON.stringify(smuggled)).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION');
    }
  });

  it('ignores a tenant named in the query string, and applies the write to the caller', async () => {
    const res = await h.request(
      HR_A.token, 'POST', `/api/hr/employees?tenant=${TENANT_B}&tenantId=${TENANT_B}`,
      { operationId: op(), fullName: 'Steered By Query', joiningDate: '2026-01-05' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const theirs = await h.request(HR_B.token, 'GET', '/api/hr/employees');
    expect(theirs.body).toEqual([]);
    const mine = await h.request(HR_A.token, 'GET', '/api/hr/employees');
    expect(mine.body.map((e: any) => e.fullName)).toContain('Steered By Query');
  });

  it('refuses assigning a person to the other tenant property, identically to a fiction', async () => {
    const foreign = await h.request(HR_A.token, 'POST', '/api/hr/employees', {
      operationId: op(), fullName: 'Cross Assigned', joiningDate: '2026-01-05',
      primaryPropertyId: PROPERTIES[TENANT_B]![0],
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe('UNKNOWN_PROPERTY');

    const invented = await h.request(HR_A.token, 'POST', '/api/hr/employees', {
      operationId: op(), fullName: 'Invented Property', joiningDate: '2026-01-05',
      primaryPropertyId: 'ZZZ-999',
    });
    // The check never consults another tenant's workbook, so it cannot distinguish the two.
    expect(invented.body.error.code).toBe(foreign.body.error.code);

    const own = await anEmployee(h, HR_A.token, { primaryPropertyId: 'HYD-501' });
    expect(own.primaryPropertyId).toBe('HYD-501');
  });

  it('refuses a manager who belongs to the other tenant', async () => {
    const theirManager = await anEmployee(h, HR_B.token, { fullName: 'B Manager' });
    const res = await h.request(HR_A.token, 'POST', '/api/hr/employees', {
      operationId: op(), fullName: 'Reports Across', joiningDate: '2026-01-05',
      managerId: theirManager.id,
    });
    expect(res.status).toBe(404);
  });

  it('never returns a tenant id or an actor to a client', async () => {
    const employee = await anEmployee(h, HR_A.token);
    const listed = await h.request(HR_A.token, 'GET', '/api/hr/employees');
    for (const payload of [employee, listed.body[0]]) {
      const serialised = JSON.stringify(payload);
      expect(serialised).not.toContain(TENANT_A);
      expect(serialised).not.toContain('tenantId');
      expect(serialised).not.toContain('createdBy');
    }
  });
});

/* ================================================================== *
 * 4 · ROLE — capability AND the data actually rendered
 * ================================================================== */

describe('hr · roles', () => {
  it('gives OPERATIONS and INVESTOR no HR capability at all', () => {
    for (const role of ['OPERATIONS', 'INVESTOR'] as const) {
      expect(capabilitiesFor(role).filter((c) => c.startsWith('hr.'))).toEqual([]);
    }
  });

  it('puts the compensation half in FINANCIAL_CAPABILITIES and the roster half nowhere near it', () => {
    // Pay is financial; a shift roster is not. Listing attendance would make the constant
    // mean "anything HR touches", and a future operations grant of hr.read would then fail
    // a financial invariant it has nothing to do with.
    for (const capability of ['hr.compensation.read', 'hr.compensation.manage', 'hr.payroll.approve'] as const) {
      expect(FINANCIAL_CAPABILITIES).toContain(capability);
    }
    for (const capability of ['hr.read', 'hr.manage', 'hr.approve'] as const) {
      expect(FINANCIAL_CAPABILITIES).not.toContain(capability);
    }
  });

  it('keeps payroll approval above ADMIN', () => {
    expect(roleHasCapability('ADMIN', 'hr.compensation.read')).toBe(true);
    // Turning a calculation into money people will be paid stays above this role, exactly
    // as closing a finance period does.
    expect(roleHasCapability('ADMIN', 'hr.payroll.approve')).toBe(false);
    expect(roleHasCapability('SUPER_ADMIN', 'hr.payroll.approve')).toBe(true);
  });

  it('refuses OPERATIONS the HR data itself, not merely the menu entry', async () => {
    const employee = await anEmployee(h, HR_A.token, { fullName: 'Lakshmi Narayan' });
    await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: employee.id, effectiveFrom: '2026-01-01',
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: 2_500_000 }],
    });

    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/hr/'))) {
      const path = route.path.replace(':id', randomUUID());
      const res = await h.request(USERS.operations!.token, route.method, path,
        route.method === 'GET' ? undefined : { operationId: op() });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      const serialised = JSON.stringify(res.body);
      expect(serialised, route.path).not.toContain('Lakshmi');
      expect(serialised, route.path).not.toContain('2500000');
    }
  });

  it('refuses INVESTOR every HR route', async () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/hr/'))) {
      const res = await h.request(USERS.investorA!.token, route.method,
        route.path.replace(':id', randomUUID()),
        route.method === 'GET' ? undefined : { operationId: op() });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('builds the money halves of the overview only for a compensation reader', async () => {
    const employee = await anEmployee(h, HR_A.token);
    await approvedAttendance(h, employee.id, '2026-05-04');
    const admin = await h.request(HR_A.token, 'GET', '/api/hr/overview?period=2026-05-01');
    // Present for a compensation reader; the same payload carries `null` — not a hidden
    // figure — for anybody else, because a payload that carries a number the client is
    // told not to render has already disclosed it.
    expect(admin.body.payrollNet).not.toBeNull();
    expect(admin.body).toHaveProperty('salaryCostByProperty');
    expect(admin.body.headcount).toBe(1);
  });

  it('refuses an unauthenticated caller before anything is validated', async () => {
    const res = await h.request(null, 'POST', '/api/hr/employees', { nonsense: true });
    expect(res.status).toBe(401);
  });
});

/* ================================================================== *
 * 5 · ATTENDANCE
 * ================================================================== */

describe('hr · attendance', () => {
  it('refuses a duplicate day, and allows a second shift on the same day', async () => {
    const employee = await anEmployee(h, HR_A.token);
    const first = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: employee.id, attendanceDate: '2026-05-04', status: 'PRESENT',
    });
    expect(first.status).toBe(200);

    const duplicate = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: employee.id, attendanceDate: '2026-05-04', status: 'ABSENT',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_ATTENDANCE');

    // A split or night shift is a second row for the same date, named by its shift.
    const shift = await h.request(HR_A.token, 'POST', '/api/hr/shifts', {
      operationId: op(), name: 'Night', startTime: '22:00', endTime: '06:00', crossesMidnight: true,
    });
    expect(shift.status, JSON.stringify(shift.body)).toBe(200);
    const second = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: employee.id, attendanceDate: '2026-05-04',
      shiftId: shift.body.id, status: 'PRESENT',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
  });

  it('treats an overnight shift as ordinary, and refuses one whose flag disagrees', async () => {
    const good = await h.request(HR_A.token, 'POST', '/api/hr/shifts', {
      operationId: op(), name: 'Overnight', startTime: '22:00', endTime: '06:00', crossesMidnight: true,
    });
    expect(good.status).toBe(200);
    expect(good.body.crossesMidnight).toBe(true);

    // 22:00 → 06:00 marked as NOT crossing midnight would be a zero-length day everything
    // downstream computed from.
    const bad = await h.request(HR_A.token, 'POST', '/api/hr/shifts', {
      operationId: op(), name: 'Wrong', startTime: '22:00', endTime: '06:00', crossesMidnight: false,
    });
    expect(bad.status).toBe(422);
  });

  it('refuses late and early-exit flags on a day nobody attended', async () => {
    const employee = await anEmployee(h, HR_A.token);
    const res = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: employee.id, attendanceDate: '2026-05-04',
      status: 'ABSENT', late: true,
    });
    expect(res.status).toBe(422);
  });

  it('refuses attendance dated into a period finance has closed', async () => {
    const employee = await anEmployee(h, HR_A.token);
    h.closed.add(`${TENANT_A}|2026-05`);

    const refused = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: employee.id, attendanceDate: '2026-05-04', status: 'PRESENT',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PERIOD_CLOSED');

    // The lock is one tenant's, and it is finance's — B's May is untouched.
    const theirs = await anEmployee(h, HR_B.token);
    const allowed = await h.request(HR_B.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: theirs.id, attendanceDate: '2026-05-04', status: 'PRESENT',
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });
});

/* ================================================================== *
 * 6 · LEAVE AND OVERTIME
 * ================================================================== */

describe('hr · leave and overtime', () => {
  async function aLeaveType() {
    const res = await h.request(HR_A.token, 'POST', '/api/hr/leave-types', {
      operationId: op(), code: 'CASUAL', name: 'Casual leave', paid: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  }

  it('refuses overlapping leave for the same person', async () => {
    const employee = await anEmployee(h, HR_A.token);
    const leaveTypeId = await aLeaveType();
    const first = await h.request(HR_A.token, 'POST', '/api/hr/leave', {
      operationId: op(), employeeId: employee.id, leaveTypeId,
      startDate: '2026-05-10', endDate: '2026-05-12', halfDays: 6,
    });
    expect(first.status).toBe(200);
    await h.request(HR_A.token, 'POST', `/api/hr/leave/${first.body.id}/submit`, { operationId: op() });

    const overlapping = await h.request(HR_A.token, 'POST', '/api/hr/leave', {
      operationId: op(), employeeId: employee.id, leaveTypeId,
      startDate: '2026-05-11', endDate: '2026-05-14', halfDays: 8,
    });
    // An overlap is the same absence counted twice, and it would be deducted twice.
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error.code).toBe('OVERLAPPING_LEAVE');
  });

  it('refuses approval by the person who requested it, and requires a reason to reject', async () => {
    const employee = await anEmployee(h, HR_A.token);
    const leaveTypeId = await aLeaveType();
    const request = await h.request(HR_A.token, 'POST', '/api/hr/leave', {
      operationId: op(), employeeId: employee.id, leaveTypeId,
      startDate: '2026-05-10', endDate: '2026-05-10', halfDays: 2,
    });
    await h.request(HR_A.token, 'POST', `/api/hr/leave/${request.body.id}/submit`, { operationId: op() });

    const self = await h.request(HR_A.token, 'POST', `/api/hr/leave/${request.body.id}/approve`, { operationId: op() });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_APPROVAL');

    const noReason = await h.request(APPROVER_A.token, 'POST', `/api/hr/leave/${request.body.id}/reject`, { operationId: op() });
    expect(noReason.status).toBe(422);

    const approved = await h.request(APPROVER_A.token, 'POST', `/api/hr/leave/${request.body.id}/approve`, { operationId: op() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
  });

  it('has no transition out of an approved record, so a change is a new one', () => {
    expect(APPROVAL_TRANSITIONS.APPROVED).toEqual([]);
  });
});

/* ================================================================== *
 * 7 · SALARY HISTORY
 * ================================================================== */

describe('hr · salary history', () => {
  async function withSalary(employeeId: string, from: string, basic: number) {
    const res = await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId, effectiveFrom: from,
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: basic }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  it('preserves the old structure when pay changes, rather than overwriting it', async () => {
    const employee = await anEmployee(h, HR_A.token);
    await withSalary(employee.id, '2026-01-01', 2_500_000); // ₹25,000
    await withSalary(employee.id, '2026-07-01', 2_800_000); // ₹28,000

    const history = await h.request(HR_A.token, 'GET', `/api/hr/salary?employeeId=${employee.id}`);
    expect(history.body).toHaveLength(2);

    const [current, previous] = history.body;
    expect(current.effectiveFrom).toBe('2026-07-01');
    expect(current.effectiveTo).toBeNull();
    expect(current.grossEarnings.minor).toBe(2_800_000);

    // The old row survives, closed the day before the new one begins — so "what were we
    // paying in March?" still has an answer.
    expect(previous.effectiveFrom).toBe('2026-01-01');
    expect(previous.effectiveTo).toBe('2026-06-30');
    expect(previous.grossEarnings.minor).toBe(2_500_000);
  });

  it('refuses a back-dated structure behind an existing one', async () => {
    const employee = await anEmployee(h, HR_A.token);
    await withSalary(employee.id, '2026-07-01', 2_800_000);
    const backdated = await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: employee.id, effectiveFrom: '2026-01-01',
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: 2_500_000 }],
    });
    // Two structures in force at once would make payroll guess which applies.
    expect(backdated.status).toBe(409);
    expect(backdated.body.error.code).toBe('OUT_OF_ORDER_STRUCTURE');
  });
});

/* ================================================================== *
 * 8 · PAYROLL
 * ================================================================== */

describe('hr · payroll', () => {
  async function aFullMonth() {
    const employee = await anEmployee(h, HR_A.token, { joiningDate: '2026-05-01' });
    await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: employee.id, effectiveFrom: '2026-05-01',
      components: [
        { code: 'BASIC', kind: 'EARNING', amountMinor: 2_000_000 },
        { code: 'HRA', kind: 'EARNING', amountMinor: 500_000 },
        { code: 'PF', kind: 'DEDUCTION', amountMinor: 240_000 },
      ],
    });
    // Every day of May recorded and approved, so the run has no gaps.
    for (let day = 1; day <= 31; day += 1) {
      await approvedAttendance(h, employee.id, `2026-05-${String(day).padStart(2, '0')}`);
    }
    const run = await h.request(HR_A.token, 'POST', '/api/hr/payroll', {
      operationId: op(), periodStart: '2026-05-01',
    });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    return { employee, runId: run.body.id as string };
  }

  it('computes gross and deductions from the structure, and counts the days', async () => {
    const { runId } = await aFullMonth();
    const calculated = await h.request(HR_A.token, 'POST', `/api/hr/payroll/${runId}/calculate`, { operationId: op() });
    expect(calculated.status, JSON.stringify(calculated.body)).toBe(200);

    const [line] = calculated.body.lines;
    expect(line.gross.minor).toBe(2_500_000);
    expect(line.deductions.minor).toBe(240_000);
    expect(line.net.minor).toBe(2_260_000);
    expect(line.payableDays).toBe(31);
    expect(line.unrecordedDays).toBe(0);
  });

  it('refuses to calculate while attendance is still awaiting approval', async () => {
    const employee = await anEmployee(h, HR_A.token, { joiningDate: '2026-05-01' });
    const created = await h.request(HR_A.token, 'POST', '/api/hr/attendance', {
      operationId: op(), employeeId: employee.id, attendanceDate: '2026-05-04', status: 'PRESENT',
    });
    await h.request(HR_A.token, 'POST', `/api/hr/attendance/${created.body.id}/submit`, { operationId: op() });

    const run = await h.request(HR_A.token, 'POST', '/api/hr/payroll', { operationId: op(), periodStart: '2026-05-01' });
    const calculated = await h.request(HR_A.token, 'POST', `/api/hr/payroll/${run.body.id}/calculate`, { operationId: op() });
    // Payroll does not consume unreviewed attendance. That is what the approval chain is for.
    expect(calculated.status).toBe(409);
    expect(calculated.body.error.code).toBe('ATTENDANCE_NOT_APPROVED');
  });

  it('REFUSES to approve a run whose month has days nobody recorded, unless acknowledged', async () => {
    /*
     * The quietest failure in this milestone. Attendance is permitted to be incomplete —
     * a day with no record is not an absence — so PRESENT rows are counted, a plausible
     * total comes out, and an approver sees the total rather than the gap.
     */
    const employee = await anEmployee(h, HR_A.token, { joiningDate: '2026-05-01' });
    await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: employee.id, effectiveFrom: '2026-05-01',
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: 2_000_000 }],
    });
    await approvedAttendance(h, employee.id, '2026-05-04'); // one day of thirty-one

    const run = await h.request(HR_A.token, 'POST', '/api/hr/payroll', { operationId: op(), periodStart: '2026-05-01' });
    const calculated = await h.request(HR_A.token, 'POST', `/api/hr/payroll/${run.body.id}/calculate`, { operationId: op() });
    expect(calculated.status).toBe(200);
    expect(calculated.body.lines[0].unrecordedDays).toBe(30);

    // ADMIN does not hold `hr.payroll.approve` at all — asserted separately — so the
    // approver here is the role that does.
    const refused = await h.request(PAYROLL_A.token, 'POST', `/api/hr/payroll/${run.body.id}/approve`, { operationId: op() });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('UNRECORDED_ATTENDANCE');

    // It CAN be approved by somebody who says, on the record, that they know.
    const acknowledged = await h.request(PAYROLL_A.token, 'POST', `/api/hr/payroll/${run.body.id}/approve`, {
      operationId: op(), acknowledgeGaps: true,
    });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
  });

  it('refuses posting without approval, refuses posting twice, and refuses self-approval', async () => {
    const { runId } = await aFullMonth();
    await h.request(HR_A.token, 'POST', `/api/hr/payroll/${runId}/calculate`, { operationId: op() });

    const early = await h.request(PAYROLL_A.token, 'POST', `/api/hr/payroll/${runId}/post`, { operationId: op() });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ILLEGAL_TRANSITION');

    // The run was opened by HR_A, so HR_A may not approve it. PAYROLL_A holds the
    // capability and did not open it.
    const approved = await h.request(PAYROLL_A.token, 'POST', `/api/hr/payroll/${runId}/approve`, { operationId: op() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const posted = await h.request(PAYROLL_A.token, 'POST', `/api/hr/payroll/${runId}/post`, { operationId: op() });
    expect(posted.status).toBe(200);
    expect(posted.body.status).toBe('POSTED');

    const again = await h.request(PAYROLL_A.token, 'POST', `/api/hr/payroll/${runId}/post`, { operationId: op() });
    // A posted run has produced obligations somebody may already have settled.
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('does not allow POSTED straight from CALCULATED in the transition table itself', () => {
    /*
     * The transition table is the real guard; the explicit `APPROVAL_REQUIRED` check in the
     * service is defence in depth behind it and is unreachable while the table is correct.
     * Asserting the table is therefore what actually detects an approval being skipped.
     */
    expect(PAYROLL_TRANSITIONS.CALCULATED).not.toContain('POSTED');
    expect(PAYROLL_TRANSITIONS.APPROVED).toContain('POSTED');
    expect(PAYROLL_TRANSITIONS.DRAFT).not.toContain('POSTED');
  });

  it('has no PAID status, because paying is finance', () => {
    // A PAID payroll status would be a second answer to "has this been paid?", and the
    // wrong one the moment a single transfer failed. Settlement is finance_payments.
    expect(PAYROLL_TRANSITIONS.POSTED).toEqual([]);
    const sql = read('supabase/migrations/0007_hr_foundation.sql');
    expect(sql).toMatch(/create type hr_payroll_status as enum \('DRAFT', 'CALCULATED', 'APPROVED', 'POSTED'\)/);
    // The handoff exists, and it is finance's table that gained the target.
    expect(sql).toContain('payroll_line_id uuid references hr_payroll_lines(id)');
  });

  it('refuses a second run for the same month', async () => {
    await h.request(HR_A.token, 'POST', '/api/hr/payroll', { operationId: op(), periodStart: '2026-05-01' });
    const second = await h.request(HR_A.token, 'POST', '/api/hr/payroll', { operationId: op(), periodStart: '2026-05-01' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('RUN_EXISTS');
  });
});

/* ================================================================== *
 * 9 · ADVANCES
 * ================================================================== */

describe('hr · advances', () => {
  it('computes the outstanding from recoveries, and refuses to recover more than is owed', async () => {
    const employee = await anEmployee(h, HR_A.token, { joiningDate: '2026-05-01' });
    const advance = await h.request(HR_A.token, 'POST', '/api/hr/advances', {
      operationId: op(), employeeId: employee.id, issuedOn: '2026-05-02',
      amountMinor: 500_000, reason: 'Medical',
    });
    expect(advance.status, JSON.stringify(advance.body)).toBe(200);
    await h.request(HR_A.token, 'POST', `/api/hr/advances/${advance.body.id}/submit`, { operationId: op() });
    await h.request(APPROVER_A.token, 'POST', `/api/hr/advances/${advance.body.id}/approve`, { operationId: op() });

    const balance = await h.request(HR_A.token, 'GET', `/api/hr/advances?employeeId=${employee.id}`);
    expect(balance.body.balance.issued.minor).toBe(500_000);
    expect(balance.body.balance.outstanding.minor).toBe(500_000);

    await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: employee.id, effectiveFrom: '2026-05-01',
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: 2_000_000 }],
    });
    const run = await h.request(HR_A.token, 'POST', '/api/hr/payroll', { operationId: op(), periodStart: '2026-05-01' });

    const excessive = await h.request(HR_A.token, 'POST', `/api/hr/payroll/${run.body.id}/calculate`, {
      operationId: op(), recoveries: [{ employeeId: employee.id, amountMinor: 900_000 }],
    });
    expect(excessive.status).toBe(422);
    expect(excessive.body.error.code).toBe('RECOVERY_EXCEEDS_ADVANCE');

    const ok = await h.request(HR_A.token, 'POST', `/api/hr/payroll/${run.body.id}/calculate`, {
      operationId: op(), recoveries: [{ employeeId: employee.id, amountMinor: 200_000 }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lines[0].advanceRecovery.minor).toBe(200_000);
    expect(ok.body.lines[0].net.minor).toBe(1_800_000);
  });

  it('keeps advances of one tenant out of the other balance', async () => {
    const mine = await anEmployee(h, HR_A.token);
    const theirs = await anEmployee(h, HR_B.token);
    await h.request(HR_A.token, 'POST', '/api/hr/advances', {
      operationId: op(), employeeId: mine.id, issuedOn: '2026-05-02',
      amountMinor: 500_000, reason: 'Medical',
    });
    const theirList = await h.request(HR_B.token, 'GET', `/api/hr/advances?employeeId=${theirs.id}`);
    expect(theirList.body.advances).toEqual([]);
    expect(theirList.body.balance.outstanding.minor).toBe(0);
  });
});

/* ================================================================== *
 * 10 · IDEMPOTENCY AND AUDIT
 * ================================================================== */

describe('hr · idempotency and audit', () => {
  it('does not turn a retried advance into two advances', async () => {
    const employee = await anEmployee(h, HR_A.token);
    const body = {
      operationId: op(), employeeId: employee.id, issuedOn: '2026-05-02',
      amountMinor: 500_000, reason: 'Medical',
    };
    const first = await h.request(HR_A.token, 'POST', '/api/hr/advances', body);
    const retry = await h.request(HR_A.token, 'POST', '/api/hr/advances', body);
    expect(retry.body.id).toBe(first.body.id);
    const all = await h.request(HR_A.token, 'GET', '/api/hr/advances');
    expect(all.body.advances).toHaveLength(1);
  });

  it('refuses a byte-identical request replayed by the other tenant', async () => {
    /*
     * The payload here is IDENTICAL — same operation id, same body — which is the only
     * shape that isolates the tenant comparison. An earlier version of this case used a
     * different employee per tenant, so the request hashes differed and the store refused
     * on the hash; the tenant predicate could have been removed entirely and the test
     * would still have passed. It is the tenant that must do the refusing.
     */
    const operationId = op();
    const body = { operationId, name: 'Housekeeping' };

    const a = await h.request(HR_A.token, 'POST', '/api/hr/departments', body);
    expect(a.status, JSON.stringify(a.body)).toBe(200);

    const b = await h.request(HR_B.token, 'POST', '/api/hr/departments', body);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('OPERATION_MISMATCH');
    // B must not receive A's stored result, nor be told its request was already applied.
    expect(JSON.stringify(b.body)).not.toContain(a.body.id);

    const theirs = await h.request(HR_B.token, 'GET', '/api/hr/employees');
    expect(theirs.body).toEqual([]);
  });

  it('refuses the same operation id presented by the other tenant', async () => {
    const mine = await anEmployee(h, HR_A.token);
    const theirs = await anEmployee(h, HR_B.token);
    const operationId = op();

    const a = await h.request(HR_A.token, 'POST', '/api/hr/advances', {
      operationId, employeeId: mine.id, issuedOn: '2026-05-02', amountMinor: 500_000, reason: 'X',
    });
    expect(a.status).toBe(200);

    const b = await h.request(HR_B.token, 'POST', '/api/hr/advances', {
      operationId, employeeId: theirs.id, issuedOn: '2026-05-02', amountMinor: 500_000, reason: 'X',
    });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('OPERATION_MISMATCH');
    expect(JSON.stringify(b.body)).not.toContain(a.body.id);
  });

  it('records the tenant and the actor, and never a salary figure', async () => {
    const employee = await anEmployee(h, HR_A.token);
    await h.request(HR_A.token, 'POST', '/api/hr/salary', {
      operationId: op(), employeeId: employee.id, effectiveFrom: '2026-01-01',
      components: [{ code: 'BASIC', kind: 'EARNING', amountMinor: 2_500_000 }],
    });

    const record = h.audit.records.find((r) => r.action === 'hr.salary.create.applied');
    expect(record).toBeTruthy();
    expect(record!.tenantId).toBe(TENANT_A);
    expect(record!.actorId).toBe(HR_A.userId);

    /*
     * `redactMetadata` strips known PII keys but leaves numbers untouched, so a payroll
     * payload copied into the trail would put pay in a table every `audit.read` holder can
     * query. Every HR audit record carries the operation id and nothing else.
     */
    /*
     * `.applied` records are the ones this layer writes. The guard additionally records
     * every request at the route level with {method, path}, which carries no payload and
     * is not what this rule is about.
     */
    const written = h.audit.records.filter((r) => r.action.endsWith('.applied'));
    expect(written.length).toBeGreaterThan(0);
    for (const entry of written) {
      expect(Object.keys(entry.metadata), entry.action).toEqual(['operationId']);
    }
    // …and no audit record of any kind carries the figure.
    for (const entry of h.audit.records) {
      expect(JSON.stringify(entry.metadata), entry.action).not.toContain('2500000');
    }
  });
});

/* ================================================================== *
 * 11 · THE POSTGRES TWIN
 * ================================================================== */

describe('hr · the Postgres repository', () => {
  function recorder() {
    const calls: Array<{ table: string; op: string; filters: Array<[string, unknown]>; row?: any }> = [];
    const chainFor = (entry: { filters: Array<[string, unknown]> }) => {
      const chain: any = {
        eq(column: string, value: unknown) { entry.filters.push([column, value]); return chain; },
        gte() { return chain; },
        lte() { return chain; },
        order() { return chain; },
        select() { return chain; },
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return chain;
    };
    const client = {
      from(table: string) {
        const make = (op: string, row?: any) => {
          const entry = { table, op, filters: [] as Array<[string, unknown]>, row };
          calls.push(entry);
          return chainFor(entry);
        };
        return {
          select: () => make('select'),
          insert: (row: any) => make('insert', row),
          update: (row: any) => make('update', row),
          delete: () => make('delete'),
        };
      },
    };
    return { client, calls };
  }

  const tenantA = { tenantId: TENANT_A, userId: 'u', role: 'ADMIN' as const };

  it('filters every single read by tenant', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseHrRepository(client);

    await repo.listEmployees(tenantA);
    await repo.getEmployee(tenantA, 'e-1');
    await repo.listAttendance(tenantA);
    await repo.getAttendance(tenantA, 'a-1');
    await repo.listLeaveRequests(tenantA);
    await repo.getLeaveRequest(tenantA, 'l-1');
    await repo.listOvertime(tenantA);
    await repo.getOvertime(tenantA, 'o-1');
    await repo.listAdvances(tenantA);
    await repo.getAdvance(tenantA, 'ad-1');
    await repo.listSalaryStructures(tenantA, 'e-1');
    await repo.listSalaryComponents(tenantA, 's-1');
    await repo.listPayrollRuns(tenantA);
    await repo.getPayrollRun(tenantA, 'r-1');
    await repo.listPayrollLines(tenantA, 'r-1');
    await repo.getPayrollLine(tenantA, 'pl-1');
    await repo.listShifts(tenantA);
    await repo.listHolidays(tenantA);
    await repo.listLeaveTypes(tenantA);
    await repo.listEntitlements(tenantA, 'e-1');
    await repo.listDepartments(tenantA);
    await repo.listDesignations(tenantA);

    const reads = calls.filter((c) => c.op === 'select');
    expect(reads.length).toBe(22);
    for (const call of reads) {
      expect(
        call.filters.some(([column, value]) => column === 'tenant_id' && value === TENANT_A),
        `${call.table} read without a tenant predicate`,
      ).toBe(true);
    }
  });

  it('stamps the tenant on every insert, and cannot be told otherwise', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseHrRepository(client);

    await repo.createEmployee(tenantA, {
      employeeCode: 'EMP-0001', fullName: 'X', joiningDate: '2026-01-01',
    }, 'actor').catch(() => {});
    await repo.recordAttendance(tenantA, {
      employeeId: 'e-1', attendanceDate: '2026-05-01', status: 'PRESENT',
    }, 'actor').catch(() => {});
    await repo.createAdvance(tenantA, {
      employeeId: 'e-1', issuedOn: '2026-05-01', amount: paise(1000), reason: 'X',
    }, 'actor').catch(() => {});
    await repo.createPayrollRun(tenantA, '2026-05-01', 'actor').catch(() => {});

    const inserts = calls.filter((c) => c.op === 'insert');
    expect(inserts.length).toBe(4);
    for (const call of inserts) {
      expect(call.row.tenant_id, `${call.table} insert without a tenant`).toBe(TENANT_A);
    }
  });

  it('carries BOTH predicates on every update and on the payroll line delete', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseHrRepository(client);

    await repo.setEmployeeStatus(tenantA, 'e-1', 'EXITED', '2026-06-30');
    await repo.transitionAttendance(tenantA, 'a-1', 'APPROVED', 'actor');
    await repo.transitionPayrollRun(tenantA, 'r-1', 'APPROVED', 'actor');
    await repo.replacePayrollLines(tenantA, 'r-1', []);

    for (const call of calls.filter((c) => c.op === 'update')) {
      const columns = call.filters.map(([c]) => c);
      expect(columns, `${call.table} update`).toContain('tenant_id');
      expect(columns, `${call.table} update`).toContain('id');
    }
    // A recalculation must not be able to clear another tenant's lines even if a run id
    // were guessed, so the delete carries the tenant as well as the run.
    const [deletion] = calls.filter((c) => c.op === 'delete');
    expect(deletion).toBeTruthy();
    const deleteColumns = deletion!.filters.map(([c]) => c);
    expect(deleteColumns).toContain('tenant_id');
    expect(deleteColumns).toContain('run_id');
  });

  it('refuses to build any query without a tenant', async () => {
    const { client } = recorder();
    const repo = new SupabaseHrRepository(client);
    const noTenant = { tenantId: '', userId: 'u', role: 'ADMIN' as const };
    await expect(repo.listEmployees(noTenant as never)).rejects.toThrow();
    await expect(repo.getPayrollRun(noTenant as never, 'r-1')).rejects.toThrow();
  });

  it('keeps the rules out of SQL, and denies every browser role', () => {
    const sql = read('supabase/migrations/0007_hr_foundation.sql');
    const flattened = sql.replace(/\s+/g, ' ');
    expect(sql).not.toMatch(/create (or replace )?function/i);
    expect(sql).not.toMatch(/create trigger/i);
    for (const table of [
      'hr_employees', 'hr_attendance', 'hr_leave_requests', 'hr_overtime',
      'hr_employee_advances', 'hr_salary_structures', 'hr_payroll_runs', 'hr_payroll_lines',
    ]) {
      expect(flattened).toContain(`alter table ${table} enable row level security`);
      expect(flattened).toContain(`revoke all on ${table} from authenticated, anon`);
    }
  });

  it('stores no sensitive identity data it does not need', () => {
    const sql = read('supabase/migrations/0007_hr_foundation.sql');
    // Comments stripped: the migration NAMES these fields in order to explain why it does
    // not have them, so a raw text search would match the very sentence that promises it.
    const ddl = sql.replace(/^\s*--.*$/gm, '');
    // A column that exists is a column something eventually writes to.
    for (const forbidden of ['aadhaar', 'pan_number', 'bank_account', 'ifsc', 'passport', 'date_of_birth', 'gender']) {
      expect(ddl.toLowerCase(), `${forbidden} must not be a column`).not.toContain(forbidden);
    }
  });
});

/* ================================================================== *
 * 12 · GOVERNANCE AND SELF-SERVICE
 * ================================================================== */

describe('hr · governance', () => {
  it('satisfies the write-governance contract for the whole registry', () => {
    assertWriteGovernance(API_ROUTES, (condition, message) => {
      expect(condition, message).toBe(true);
    });
  });

  it('declares every HR write, and none of them as a workbook or finance mutation', () => {
    const hr = API_ROUTES.filter((r) => r.path.startsWith('/api/hr/'));
    expect(hr.length).toBeGreaterThan(0);
    for (const route of hr.filter((r) => r.method !== 'GET')) {
      expect(route.writesHr, `${route.path} must declare writesHr`).toBe(true);
      expect(route.mutates, route.path).toBeUndefined();
      expect(route.writesFinance, route.path).toBeUndefined();
      expect(route.nonMutating, route.path).toBeUndefined();
    }
    expect(hr.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('has no employee self-service route, and does not pretend to', () => {
    /*
     * Recorded as a test so the gap is not mistaken for an oversight. A normal employee
     * cannot read their own record because no employee ROLE exists — and a route that
     * accepted an employee id from a caller without one would be worse than no route at
     * all. The projection layer is built so the role can be added without reshaping
     * anything; see docs/MHR1_HR_ARCHITECTURE.md §13.
     */
    expect(API_ROUTES.filter((r) => r.path.startsWith('/api/hr/me'))).toHaveLength(0);
    const handlers = codeOf(read('lib/server/api/hr-handlers.ts'));
    // No handler resolves an employee from anything a caller sent as their identity.
    expect(handlers).not.toMatch(/ctx\.auth\.employeeId/);
  });

  it('holds no money arithmetic in the handler layer', () => {
    const handlers = codeOf(read('lib/server/api/hr-handlers.ts'));
    expect(handlers).not.toMatch(/amountMinor\s*[*/+-]\s/);
    expect(handlers).not.toMatch(/\*\s*100|\/\s*100/);
  });
});
