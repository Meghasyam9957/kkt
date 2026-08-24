/**
 * Shared test harness: a fully wired router with in-memory auth, audit and IDs, plus
 * the standard cast of users used across the RBAC, isolation and security suites.
 */
import { InMemoryAuthProvider, type TestUser } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { ApiRouter } from '@/lib/server/api/router';
import { InvestorService } from '@/lib/server/api/investor-service';
import { API_ROUTES } from '@/lib/server/api/routes';
import type { ApiRequest } from '@/lib/server/auth/guard';
import { distributionsMixed } from '../fixtures/scenarios';

export const USERS: Record<string, TestUser> = {
  superAdmin: { userId: 'u-super', email: 'super@srivillu.test', role: 'SUPER_ADMIN', token: 't-super' },
  admin:      { userId: 'u-admin', email: 'admin@srivillu.test', role: 'ADMIN',       token: 't-admin' },
  operations: { userId: 'u-ops',   email: 'ops@srivillu.test',   role: 'OPERATIONS',  token: 't-ops' },
  investorA:  { userId: 'u-inv-a', email: 'a@srivillu.test',     role: 'INVESTOR', investorId: 'INV-001', token: 't-inv-a' },
  investorB:  { userId: 'u-inv-b', email: 'b@srivillu.test',     role: 'INVESTOR', investorId: 'INV-002', token: 't-inv-b' },
  suspended:  { userId: 'u-susp',  email: 'susp@srivillu.test',  role: 'ADMIN', status: 'SUSPENDED', token: 't-susp' },
};

export interface Harness {
  router: ApiRouter;
  audit: InMemoryAuditSink;
  investorService: InvestorService;
  request(user: TestUser | null, method: string, path: string, extra?: Partial<ApiRequest>): Promise<{ status: number; body: any }>;
}

export function createHarness(): Harness {
  const data = distributionsMixed().data;
  const authProvider = new InMemoryAuthProvider(Object.values(USERS));
  const audit = new InMemoryAuditSink();
  const auditService = new AuditLogger(audit);
  const investorService = new InvestorService(data);

  const router = new ApiRouter({ authProvider, audit: auditService });

  // Investor-portal handlers. Each receives `ctx.investorId` from the session and passes
  // it to the service, which filters again at the query layer.
  router.register('GET', '/api/investor/overview', async (ctx) =>
    investorService.overview(requireScope(ctx.investorId), '2026-04'));
  router.register('GET', '/api/investor/distributions', async (ctx) =>
    investorService.distributions(requireScope(ctx.investorId), ['2026-04']));
  router.register('GET', '/api/investor/performance', async (ctx) =>
    investorService.performance(requireScope(ctx.investorId)));
  router.register('GET', '/api/investor/reports', async (ctx) =>
    investorService.reports(requireScope(ctx.investorId), ['2026-04']));

  // A representative management endpoint, so RBAC has something real to allow/deny.
  router.register('GET', '/api/investors', async () =>
    data.investors.map((i) => ({ investorId: i.InvestorID, name: i.InvestorName })));
  router.register('GET', '/api/properties', async () =>
    data.properties.map((p) => ({ propertyId: p.PropertyID, unit: p.Unit })));

  return {
    router,
    audit,
    investorService,
    async request(user, method, path, extra = {}) {
      const headers: Record<string, string | undefined> = { ...(extra.headers ?? {}) };
      if (user) headers.authorization = `Bearer ${user.token}`;
      const response = await router.dispatch({
        method, path, headers,
        query: extra.query ?? {},
        body: extra.body,
        params: extra.params ?? {},
        ip: extra.ip ?? '203.0.113.10',
        requestId: extra.requestId ?? 'req-test',
      });
      return { status: response.status, body: response.body as any };
    },
  };
}

function requireScope(investorId: string | undefined): string {
  if (!investorId) throw new Error('Investor scope missing — the guard should have supplied it');
  return investorId;
}

/** Every declared route, for exhaustive matrix tests. */
export const ALL_ROUTES = API_ROUTES;

/** Concrete path for a route pattern, substituting a sample id. */
export function samplePath(path: string): string {
  return path.replace(/:[^/]+/g, 'SAMPLE-1');
}
