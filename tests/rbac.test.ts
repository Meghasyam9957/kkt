/**
 * RBAC SUITE — every declared route × every role, exhaustively.
 *
 * The matrix is generated from the route registry, so a route added later is covered the
 * moment it is declared. Both directions are asserted: a role that should reach a route
 * must reach it, and a role that should not must be refused at the API layer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, USERS, ALL_ROUTES, samplePath, type Harness } from './support/harness';
import { ROLES, roleHasCapability, capabilitiesFor, type Role } from '@/lib/server/auth/roles';
import { canLoadRoute, rolesForRoute } from '@/lib/server/auth/guard';

interface MatrixRow {
  route: string; role: string; expected: 'ALLOW' | 'DENY'; actual: number; pass: boolean;
}
const matrix: MatrixRow[] = [];

let h: Harness;
beforeEach(() => { h = createHarness(); });

describe('RBAC · API-layer authorization matrix', () => {
  for (const route of ALL_ROUTES) {
    for (const role of ROLES) {
      const user = Object.values(USERS).find((u) => u.role === role && u.status !== 'SUSPENDED')!;
      // Investor-scoped routes additionally require an investor account: a management
      // role holds the capability but has no scope, so it is refused by design.
      const shouldAllow = roleHasCapability(role, route.capability)
        && (!route.investorScoped || role === 'INVESTOR');

      it(`${role} ${shouldAllow ? 'may' : 'may NOT'} ${route.method} ${route.path}`, async () => {
        const res = await h.request(user, route.method, samplePath(route.path));

        // 200 (implemented) and 501 (declared, not built) both mean authorization passed.
        const allowed = res.status === 200 || res.status === 501;
        const denied = res.status === 403;

        matrix.push({
          route: `${route.method} ${route.path}`, role,
          expected: shouldAllow ? 'ALLOW' : 'DENY', actual: res.status,
          pass: shouldAllow ? allowed : denied,
        });

        if (shouldAllow) {
          expect(allowed, `${role} should reach ${route.path} (got ${res.status})`).toBe(true);
        } else {
          expect(denied, `${role} must be refused ${route.path} (got ${res.status})`).toBe(true);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
      });
    }
  }
});

describe('RBAC · authentication', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await h.request(null, 'GET', '/api/properties');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged/unknown token', async () => {
    const res = await h.request(null, 'GET', '/api/properties', { headers: { authorization: 'Bearer forged-token' } });
    expect(res.status).toBe(401);
  });

  it('rejects a suspended account even with a valid token', async () => {
    const res = await h.request(USERS.suspended!, 'GET', '/api/properties');
    expect(res.status).toBe(403);
  });

  it('accepts the session cookie as well as the bearer header', async () => {
    const res = await h.request(null, 'GET', '/api/properties', {
      headers: { cookie: `sb-access-token=${USERS.admin!.token}; other=1` },
    });
    expect(res.status).toBe(200);
  });

  it('does not leak whether an endpoint exists when the caller is unauthorized', async () => {
    const res = await h.request(USERS.investorA!, 'GET', '/api/pnl');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/pnl|profit|capability/i);
  });

  it('returns 404 for an undeclared endpoint', async () => {
    const res = await h.request(USERS.admin!, 'GET', '/api/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('RBAC · role model invariants', () => {
  it('OPERATIONS holds no financial capability', () => {
    const ops = capabilitiesFor('OPERATIONS');
    for (const cap of ['pnl.read', 'revenue.read', 'expenses.read', 'cashflow.read',
      'capex.read', 'rent.read', 'investors.read.all', 'dashboard.financial.view'] as const) {
      expect(ops, `OPERATIONS must not hold ${cap}`).not.toContain(cap);
    }
  });

  it('INVESTOR holds exactly one capability: its own record', () => {
    expect(capabilitiesFor('INVESTOR')).toEqual(['investor.self.read']);
  });

  it('INVESTOR holds no capability that exposes guest PII or internal finance', () => {
    const investor = capabilitiesFor('INVESTOR');
    for (const cap of ['guests.read', 'reservations.read', 'expenses.read', 'pnl.read',
      'cashflow.read', 'investors.read.all'] as const) {
      expect(investor).not.toContain(cap);
    }
  });

  it('ADMIN cannot write settings — business rules stay in the workbook', () => {
    expect(roleHasCapability('ADMIN', 'settings.write')).toBe(false);
    expect(roleHasCapability('ADMIN', 'settings.read')).toBe(true);
    expect(roleHasCapability('SUPER_ADMIN', 'settings.write')).toBe(true);
  });

  it('only SUPER_ADMIN can manage users', () => {
    // User administration stays with SUPER_ADMIN alone: it is the capability that can
    // create other capabilities, so it does not get delegated.
    for (const role of ['ADMIN', 'OPERATIONS', 'INVESTOR'] as Role[]) {
      expect(roleHasCapability(role, 'users.manage'), role).toBe(false);
    }
    expect(roleHasCapability('SUPER_ADMIN', 'users.manage')).toBe(true);
  });

  it('the audit trail is readable by management only — never by OPERATIONS or INVESTOR', () => {
    // ADMIN gained audit.read in Phase 5A ("full internal read access"). Reading the log
    // is not writing it, and the log is redacted before any sink. The roles that must
    // never see it are the two whose own actions it records back to them.
    expect(roleHasCapability('ADMIN', 'audit.read')).toBe(true);
    expect(roleHasCapability('SUPER_ADMIN', 'audit.read')).toBe(true);
    for (const role of ['OPERATIONS', 'INVESTOR'] as Role[]) {
      expect(roleHasCapability(role, 'audit.read'), role).toBe(false);
    }
  });

  it('every route capability is granted to at least one role', () => {
    for (const route of ALL_ROUTES) {
      const holders = ROLES.filter((r) => roleHasCapability(r, route.capability));
      expect(holders.length, `${route.path} is unreachable by every role`).toBeGreaterThan(0);
    }
  });

  /*
   * WRITE GOVERNANCE (replaces the Phase 3 "no write API exists" marker, which the
   * approved Phase B brief superseded — with STRONGER rules, not weaker ones).
   */
  it('every non-GET route is a declared mutation with a write capability', () => {
    for (const route of ALL_ROUTES.filter((r) => r.method !== 'GET')) {
      expect(route.mutates, `${route.method} ${route.path} must declare mutates: true`).toBe(true);
      expect(route.capability.endsWith('.write'),
        `${route.path} must demand a .write capability (has ${route.capability})`).toBe(true);
      expect(route.investorScoped ?? false,
        `${route.path}: a mutation route must never be investor-scoped`).toBe(false);
    }
  });

  it('every route declaring mutates is a non-GET route', () => {
    for (const route of ALL_ROUTES.filter((r) => r.mutates)) {
      expect(route.method, `${route.path} mutates but is ${route.method}`).not.toBe('GET');
    }
  });

  it('no DELETE route exists — removal is a status transition, decided by a person', () => {
    expect(ALL_ROUTES.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('INVESTOR holds zero write capabilities', () => {
    const investor = capabilitiesFor('INVESTOR');
    for (const cap of investor) {
      expect(cap.endsWith('.write'), `INVESTOR must not hold ${cap}`).toBe(false);
    }
  });

  it('OPERATIONS holds only operational writers — never financial, investor or settings', () => {
    const ops = capabilitiesFor('OPERATIONS').filter((c) => c.endsWith('.write'));
    expect([...ops].sort()).toEqual(
      ['housekeeping.write', 'inventory.write', 'maintenance.write', 'reservations.write']);
  });
});

describe('RBAC · page-route guard (UI navigation layer)', () => {
  it('maps each portal prefix to its roles', () => {
    expect(rolesForRoute('/admin/pnl')).toContain('ADMIN');
    expect(rolesForRoute('/operations/today')).toContain('OPERATIONS');
    expect(rolesForRoute('/investor/overview')).toContain('INVESTOR');
    expect(rolesForRoute('/login')).toBeNull();
  });

  it('blocks direct URL navigation across portals', () => {
    expect(canLoadRoute('INVESTOR', '/admin/pnl')).toBe(false);
    expect(canLoadRoute('INVESTOR', '/operations/today')).toBe(false);
    expect(canLoadRoute('OPERATIONS', '/admin/revenue')).toBe(false);
    expect(canLoadRoute('OPERATIONS', '/investor/distributions')).toBe(false);
    expect(canLoadRoute('ADMIN', '/admin/pnl')).toBe(true);
  });

  it('uses longest-prefix matching so a nested route cannot be widened', () => {
    expect(canLoadRoute('OPERATIONS', '/admin')).toBe(false);
    expect(canLoadRoute('OPERATIONS', '/admin/settings')).toBe(false);
  });

  it('UI blocking is never the only control — the API refuses the same request', async () => {
    // Same target the navigation guard blocks, called directly as an API request.
    expect(canLoadRoute('OPERATIONS', '/admin/pnl')).toBe(false);
    const res = await h.request(USERS.operations!, 'GET', '/api/pnl');
    expect(res.status).toBe(403);
  });
});

describe('RBAC · matrix report', () => {
  it('writes the full matrix', () => {
    const failed = matrix.filter((m) => !m.pass);
    const dir = path.resolve(process.cwd(), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rbac-matrix.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      routes: ALL_ROUTES.length,
      roles: ROLES.length,
      combinations: matrix.length,
      allowed: matrix.filter((m) => m.expected === 'ALLOW').length,
      denied: matrix.filter((m) => m.expected === 'DENY').length,
      failed: failed.length,
      rows: matrix,
    }, null, 2));
    expect(failed).toEqual([]);
    expect(matrix.length).toBe(ALL_ROUTES.length * ROLES.length);
  });
});
