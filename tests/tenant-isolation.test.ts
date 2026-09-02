/**
 * M-SAAS-1 — TWO TENANTS, TWO WORKBOOKS.
 *
 * M-SAAS-0 proved the system knows WHO is asking. It could not prove that the answer
 * differs, because both tenants resolved to the same configured workbook: every isolation
 * signal — separate provider instances, separate cache keys, separate invalidation
 * prefixes — reported "isolated" over a shared payload. `tests/tenant.test.ts` recorded
 * that as an explicit expectation so it would not be mistaken for done.
 *
 * This suite is the other half. Every case here gives TENANT_A and TENANT_B genuinely
 * different data and then tries to reach across, at the DATA LAYER rather than at the
 * interface — a UI that hides a link proves nothing about a repository that would serve
 * it.
 *
 * The attacker model throughout: a valid, fully-authenticated ADMIN in TENANT_A, holding
 * every capability their role allows, deliberately reaching for TENANT_B — by naming a
 * tenant, naming a workbook, presenting another tenant's identifiers, or replaying
 * another tenant's operation. None of it is a privilege-escalation story; all of it is a
 * caller using the product exactly as designed, against the wrong customer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { MissingTenantError } from '@/lib/server/tenant/context';
import {
  StaticTenantWorkbookRegistry, SupabaseTenantWorkbookRegistry,
  TenantWorkbookNotConfiguredError, TenantWorkbookSuspendedError,
  TenantRegistryUnavailableError, environmentBinding, workbookBinding,
} from '@/lib/server/tenant/workbook-registry';
import {
  resolveTenantDataSource, __resetTenantDataSourcesForTests,
} from '@/lib/server/tenant/data-source';
import { getDataProvider, __setDataProviderForTests, __resetReadCacheForTests } from '@/lib/data/providers';
import { ReadCache } from '@/lib/server/cache/read-cache';
import { IdAllocator, InMemorySequenceStore } from '@/lib/server/ids/allocator';
import { InMemoryOperationStore } from '@/lib/server/ops/operation-store';
import {
  AuditLogger, InMemoryAuditSink, SupabaseAuditSink, toAuditRecord,
} from '@/lib/server/audit/logger';
import type { AuthContext, TestUser } from '@/lib/server/auth/session';
import { TENANT_A, TENANT_B, USERS } from './support/harness';
import { createWriteHarness } from './support/write-harness';
import { useTenantWorkbooks, useTwoTenantWorkbooks, resetTenantWorkbooks } from './support/tenant-registry';
import { readSource as read, codeOf } from './support/source';

/** An ADMIN in TENANT_B. Every principal in USERS belongs to TENANT_A. */
const ADMIN_B: TestUser = {
  userId: 'u-admin-b', email: 'admin.b@example.test', role: 'ADMIN',
  tenantId: TENANT_B, token: 'tok-admin-b',
};

const actorIn = (tenantId: string, userId: string): AuthContext => ({
  userId, email: `${userId}@example.test`, role: 'ADMIN',
  tenantId, investorId: null, status: 'ACTIVE',
});

const contextFor = (tenantId: string) => ({
  tenantId, userId: 'u-x', role: 'ADMIN' as const,
});

/** A harness serving both tenants, each on its OWN in-memory workbook. */
function twoTenantHarness() {
  return createWriteHarness({}, {
    tenants: [TENANT_A, TENANT_B],
    users: [...Object.values(USERS), ADMIN_B],
  });
}

const expenseBody = (overrides: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  date: '2026-08-20',
  propertyId: 'HYD-501',
  expenseCategory: 'Variable Operating',
  expenseSubcategory: 'Electricity',
  description: 'Electricity bill for August',
  amount: 3200,
  paymentStatus: 'Paid',
  paidDate: '2026-08-20',
  ...overrides,
});

/** A booking on the real pipeline, in whichever tenant the token belongs to. */
const bookingBody = (overrides: Record<string, unknown> = {}) => ({
  operationId: randomUUID(), platform: 'Airbnb', propertyId: 'HYD-501',
  bookingDate: '2026-08-20', guestName: 'Priyanka Venkataraman', adults: 2, children: 1,
  checkInDate: '2026-09-01', checkOutDate: '2026-09-03', bookingStatus: 'Confirmed',
  ...overrides,
});

beforeEach(() => {
  __setDataProviderForTests(null);
  __resetReadCacheForTests();
  __resetTenantDataSourcesForTests();
  useTwoTenantWorkbooks(TENANT_A, TENANT_B);
});
afterEach(() => { resetTenantWorkbooks(); __setDataProviderForTests(null); });

/* ================================================================== *
 * A · WORKBOOK SELECTION — nothing a caller sends participates
 * ================================================================== */

describe('isolation · workbook selection', () => {
  it('takes a tenant id and nothing else — there is no argument to poison', () => {
    const source = codeOf(read('lib/server/tenant/workbook-registry.ts'));
    const resolver = codeOf(read('lib/server/tenant/data-source.ts'));

    // No request-shaped input reaches either module. This is a structural claim, so it
    // is asserted structurally: the vocabulary simply does not appear.
    for (const forbidden of [
      'searchParams', 'req.', 'request.', 'headers(', 'cookies(', 'NEXT_PUBLIC',
    ]) {
      expect(source, `registry must not read ${forbidden}`).not.toContain(forbidden);
      expect(resolver, `resolver must not read ${forbidden}`).not.toContain(forbidden);
    }
    // The lookup signature accepts exactly one thing, and it is the tenant.
    expect(source).toMatch(/lookup\(tenantId: TenantId\): Promise<TenantWorkbookBinding>/);
  });

  it('refuses a malformed tenant rather than widening to a default', async () => {
    for (const bad of ['', '   ']) {
      await expect(resolveTenantDataSource(bad)).rejects.toThrow(MissingTenantError);
    }
    // A syntactically fine but unknown tenant is refused too — absence is not a default.
    await expect(resolveTenantDataSource('tenant-that-was-never-provisioned'))
      .rejects.toThrow(TenantWorkbookNotConfiguredError);
  });

  it('ignores a tenant and a workbook named in the query string', async () => {
    /*
     * THE REALISTIC ATTEMPT. The payload is perfectly valid, so nothing refuses it on
     * shape — the request is accepted and applied. The only question is WHERE, and the
     * query string is the part of a request that reaches a handler unvalidated.
     */
    const h = twoTenantHarness();
    const beforeB = await h.reposFor(TENANT_B).expenses.readAll();

    const response = await h.request(
      'admin', 'POST',
      `/api/expenses?tenant=${TENANT_B}&tenantId=${TENANT_B}&workbook=workbook-for-the-second-tenant`,
      expenseBody(),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const created = String(response.body.record.ExpenseID);

    // Applied to the caller's OWN tenant, and tenant B is byte-for-byte untouched.
    const inA = await h.reposFor(TENANT_A).expenses.readAll();
    expect(inA.some((e) => e.ExpenseID === created), 'A holds the write').toBe(true);
    expect(await h.reposFor(TENANT_B).expenses.readAll(), 'B must be untouched')
      .toEqual(beforeB);
  });

  it('refuses a tenant smuggled into the request body outright', async () => {
    // Defence in depth, and the layers are different: the query case above proves
    // SELECTION ignores the caller, while this proves the strict schema never lets a
    // tenant-shaped field into a payload at all.
    const h = twoTenantHarness();
    const beforeB = await h.reposFor(TENANT_B).expenses.readAll();

    const response = await h.request('admin', 'POST', '/api/expenses', {
      ...expenseBody(),
      tenantId: TENANT_B,
      workbookId: 'workbook-for-the-second-tenant',
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(await h.reposFor(TENANT_B).expenses.readAll()).toEqual(beforeB);
  });

  it('never lets a public environment variable choose a workbook', () => {
    // NEXT_PUBLIC_* is readable in a browser bundle, so anything it decided would be
    // decided by the client. The only one that exists is a boolean about live data.
    const next = read('next.config.mjs');
    const publicVars = [...next.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)].map((m) => m[0]);
    for (const name of publicVars) {
      expect(name).not.toMatch(/SHEET|WORKBOOK|TENANT|SUPABASE_SERVICE|CREDENTIAL/i);
    }
  });

  it('holds the workbook id server-side and never puts it on the session', () => {
    // ShellSession is serialised into the RSC payload, so anything on it reaches the
    // browser. The tenant id belongs there; the workbook it resolves to does not.
    const session = codeOf(read('lib/server/auth/shell-session.ts'));
    expect(session).not.toMatch(/workbook/i);
    expect(session).not.toMatch(/spreadsheetId/);
    expect(session).toContain('tenantId: string;');
  });
});

/* ================================================================== *
 * B · CROSS-TENANT READS
 * ================================================================== */

describe('isolation · cross-tenant reads', () => {
  it('gives each tenant its own workbook, so a write in one is invisible in the other', async () => {
    const h = twoTenantHarness();

    const created = await h.request('admin', 'POST', '/api/expenses', expenseBody());
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const expenseId = String(created.body.record.ExpenseID);

    const inA = await h.reposFor(TENANT_A).expenses.readAll();
    const inB = await h.reposFor(TENANT_B).expenses.readAll();
    expect(inA.some((e) => e.ExpenseID === expenseId), 'A holds its own write').toBe(true);
    expect(inB.some((e) => e.ExpenseID === expenseId), 'B never sees it').toBe(false);
  });

  it('does not let one tenant read the other reservations by identifier', async () => {
    const h = twoTenantHarness();

    // A booking that exists ONLY in tenant B's workbook.
    const madeInB = await h.requestAs(ADMIN_B.token, 'POST', '/api/reservations',
      bookingBody({ guestName: 'Confidential Wodehouse' }));
    expect(madeInB.status, JSON.stringify(madeInB.body)).toBe(200);
    const bookingId = String(madeInB.body.record.BookingID);

    // Tenant A's data layer has never heard of it, and neither has its guest name.
    const aRows = await h.reposFor(TENANT_A).reservations.readAll();
    expect(aRows.some((r) => r.BookingID === bookingId)).toBe(false);
    expect(aRows.some((r) => String(r.GuestName ?? '').includes('Wodehouse'))).toBe(false);
  });
});

/* ================================================================== *
 * C · CROSS-TENANT WRITES
 * ================================================================== */

describe('isolation · cross-tenant writes', () => {
  it('refuses to amend a booking that belongs to the other tenant', async () => {
    const h = twoTenantHarness();

    const madeInB = await h.requestAs(ADMIN_B.token, 'POST', '/api/reservations',
      bookingBody({ guestName: 'Bertram Wooster' }));
    expect(madeInB.status).toBe(200);
    const bookingId = String(madeInB.body.record.BookingID);
    const before = await h.reposFor(TENANT_B).reservations.readAll();

    /*
     * The IDOR attempt. A valid ADMIN in tenant A, a real identifier, a legitimate route
     * and a well-formed payload. The only thing wrong with it is whose booking it is.
     *
     * It fails because tenant A's workbook does not contain that row — which is the
     * structural answer this milestone buys. Before it, both tenants shared a workbook,
     * so the same request would have SUCCEEDED and amended another customer's booking.
     */
    const attempt = await h.request('admin', 'PATCH', `/api/reservations/${bookingId}`, {
      operationId: randomUUID(), guestName: 'Overwritten by tenant A',
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);

    const after = await h.reposFor(TENANT_B).reservations.readAll();
    expect(after).toEqual(before);
    expect(after.some((r) => r.GuestName === 'Overwritten by tenant A')).toBe(false);
  });

  it('resolves the write path repositories per tenant, and refuses an unregistered one', async () => {
    /*
     * `tenantRepositories` is what the API service composes into the mutation pipeline.
     * Reached only through a fully-built router otherwise, and a seam no test can reach
     * is a seam a regression can walk through — so it is exported and exercised here.
     *
     * TENANT_A alone is registered. A version that ignored its argument would answer for
     * TENANT_B out of A's binding; this asserts it refuses instead.
     */
    const { tenantRepositories } = await import('@/lib/server/api/service');
    useTenantWorkbooks([environmentBinding(TENANT_A)]);

    await expect(tenantRepositories(TENANT_A)).resolves.toBeTruthy();
    await expect(tenantRepositories(TENANT_B))
      .rejects.toThrow(TenantWorkbookNotConfiguredError);
  });

  it('refuses a write for a tenant with no registered workbook', async () => {
    const h = createWriteHarness({}, { tenants: [TENANT_A], users: [...Object.values(USERS), ADMIN_B] });
    // ADMIN_B authenticates perfectly well; there is simply nowhere to put their write.
    const response = await h.requestAs(ADMIN_B.token, 'POST', '/api/expenses', expenseBody());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(200);
  });
});

/* ================================================================== *
 * D · PROVIDER ISOLATION, INCLUDING CONCURRENTLY
 * ================================================================== */

describe('isolation · providers', () => {
  /*
   * A tenant bound to a NAMED workbook needs the deployment's Google credential — that
   * is the M-SAAS-1 split: workbook per tenant, credential per deployment. Fictional
   * values, built at runtime so no credential-shaped literal exists in the source tree.
   */
  const withoutCredentials = { ...process.env };
  beforeEach(() => {
    process.env.DEMO_GOOGLE_SHEET_ID = 'demo-spreadsheet-id';
    process.env.DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = Buffer
      .from(JSON.stringify({ client_email: 'demo@example.invalid' }), 'utf8')
      .toString('base64');
  });
  afterEach(() => { process.env = { ...withoutCredentials }; });

  it('resolves two tenants concurrently without swapping their sources', async () => {
    /*
     * The interleaving that a process-global provider would get wrong. The registry
     * below answers B slowly and A quickly, so the two resolutions genuinely overlap:
     * B asks first, A finishes first. A shared "current tenant" would hand one of them
     * the other's binding.
     */
    const slow = new StaticTenantWorkbookRegistry([
      workbookBinding(TENANT_A, 'workbook-a'),
      workbookBinding(TENANT_B, 'workbook-b'),
    ]);
    const delayed = {
      async lookup(tenantId: string) {
        await new Promise((r) => setTimeout(r, tenantId === TENANT_B ? 20 : 1));
        return slow.lookup(tenantId);
      },
    };
    useTenantWorkbooks([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import('@/lib/server/tenant/data-source')).__setTenantWorkbookRegistryForTests(delayed as any);

    const [b, a] = await Promise.all([
      resolveTenantDataSource(TENANT_B),
      resolveTenantDataSource(TENANT_A),
    ]);

    expect(a.tenantId).toBe(TENANT_A);
    expect(b.tenantId).toBe(TENANT_B);
    expect(a.binding.workbookId).toBe('workbook-a');
    expect(b.binding.workbookId).toBe('workbook-b');
  });

  it('caches a data source per tenant, and re-resolves when the binding changes', async () => {
    useTenantWorkbooks([workbookBinding(TENANT_A, 'workbook-a')]);
    const first = await resolveTenantDataSource(TENANT_A);
    expect((await resolveTenantDataSource(TENANT_A))).toBe(first);

    // Re-pointed at a different workbook: the cached source must not survive it.
    __resetTenantDataSourcesForTests();
    useTenantWorkbooks([workbookBinding(TENANT_A, 'workbook-a-moved')]);
    const second = await resolveTenantDataSource(TENANT_A);
    expect(second).not.toBe(first);
    expect(second.binding.workbookId).toBe('workbook-a-moved');
  });

  it('refuses a suspended tenant at the data layer, not merely in the interface', async () => {
    useTenantWorkbooks([
      { tenantId: TENANT_A, kind: 'GOOGLE_SHEETS', workbookId: 'wb-a', status: 'SUSPENDED' },
    ]);
    await expect(getDataProvider(contextFor(TENANT_A)))
      .rejects.toThrow(TenantWorkbookSuspendedError);
  });

  it('reports an unreachable control plane as unavailable, never as unconfigured', async () => {
    // The distinction matters operationally: one says "apply migration 0005", the other
    // says "provision this customer". Collapsing them sends an operator the wrong way.
    const registry = new SupabaseTenantWorkbookRegistry({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'relation "tenant_workbooks" does not exist' } }) }),
        }),
      }),
    });
    await expect(registry.lookup(TENANT_A)).rejects.toThrow(TenantRegistryUnavailableError);
  });
});

/* ================================================================== *
 * E · THE REGISTRY'S OWN CONSTRAINTS
 * ================================================================== */

describe('isolation · the registry refuses unsafe configuration', () => {
  it('lets at most one tenant claim the environment workbook', () => {
    // Otherwise ENVIRONMENT decays into "everybody gets the deployment's workbook",
    // which is precisely the state this milestone removes.
    expect(() => new StaticTenantWorkbookRegistry([
      environmentBinding(TENANT_A), environmentBinding(TENANT_B),
    ])).toThrow(/at most one/i);
  });

  it('refuses to point two tenants at the same workbook', () => {
    expect(() => new StaticTenantWorkbookRegistry([
      workbookBinding(TENANT_A, 'same-workbook'),
      workbookBinding(TENANT_B, 'same-workbook'),
    ])).toThrow(/same workbook/i);
  });

  it('refuses a binding whose kind and workbook disagree', () => {
    expect(() => new StaticTenantWorkbookRegistry([
      { tenantId: TENANT_A, kind: 'GOOGLE_SHEETS', workbookId: '  ', status: 'ACTIVE' },
    ])).toThrow(/must name a workbook/i);
    expect(() => new StaticTenantWorkbookRegistry([
      { tenantId: TENANT_A, kind: 'ENVIRONMENT', workbookId: 'wb', status: 'ACTIVE' },
    ])).toThrow(/must not name a workbook/i);
  });

  it('states the same two constraints in SQL, so provisioning cannot bypass them', () => {
    const sql = read('supabase/migrations/0005_tenant_workbooks.sql');
    expect(sql).toMatch(/create unique index[\s\S]*?tenant_workbooks_single_environment[\s\S]*?where source = 'ENVIRONMENT'/);
    expect(sql).toMatch(/create unique index[\s\S]*?tenant_workbooks_ref_unique[\s\S]*?where workbook_ref is not null/);
    // Deny by default: the customer list is not readable from a browser role.
    expect(sql).toContain('alter table tenant_workbooks enable row level security');
    expect(sql).toContain('revoke all on tenant_workbooks from authenticated, anon');
    // Srivillu keeps the workbook it already has.
    expect(sql).toMatch(/insert into tenant_workbooks[\s\S]*?'ENVIRONMENT'[\s\S]*?slug = 'srivillu'/);
  });
});

/* ================================================================== *
 * F · CACHE AND IDENTIFIERS, ACROSS TWO REAL WORKBOOKS
 * ================================================================== */

describe('isolation · cache and identifiers', () => {
  it('does not let one tenant flush the other cache by writing', async () => {
    const h = twoTenantHarness();
    await h.cache.get({ tenant: TENANT_A, resource: 'workbook', identity: null }, async () => ({ a: 1 }));
    await h.cache.get({ tenant: TENANT_B, resource: 'workbook', identity: null }, async () => ({ b: 1 }));

    const written = await h.request('admin', 'POST', '/api/expenses', expenseBody());
    expect(written.status).toBe(200);

    // A's entry is stale and goes; B's is untouched by a write it had no part in.
    expect(h.cache.peek({ tenant: TENANT_A, resource: 'workbook', identity: null })).toBeNull();
    expect(h.cache.peek({ tenant: TENANT_B, resource: 'workbook', identity: null })).not.toBeNull();
  });

  it('seeds each tenant identifier floor from its OWN workbook', async () => {
    /*
     * The floor is seeded from the identifiers already in the sheet, so seeding tenant
     * B's sequence from tenant A's workbook would both collide and disclose: B's first
     * minted booking number would encode how many bookings A has.
     */
    const h = twoTenantHarness();
    const allocator = new IdAllocator(new InMemorySequenceStore(), new AuditLogger(new InMemoryAuditSink()));

    await allocator.seedFromExistingIds(TENANT_A, 'RESERVATIONS', 2026, ['BK-2026-0042']);
    const b = await allocator.allocate({
      sheet: 'RESERVATIONS', year: 2026, count: 1,
      idempotencyKey: randomUUID(), actor: actorIn(TENANT_B, 'u-b'),
    });

    // B starts at its own floor, not behind A's forty-two.
    expect(b.ids[0]).toBe('BK-2026-0001');
  });
});

/* ================================================================== *
 * G · OPERATIONS — no replay, and no read across
 * ================================================================== */

describe('isolation · operations', () => {
  it('does not let one tenant poll the other operation', async () => {
    const h = twoTenantHarness();

    const madeInB = await h.requestAs(ADMIN_B.token, 'POST', '/api/expenses', expenseBody());
    expect(madeInB.status).toBe(200);
    const operationId = String(madeInB.body.meta.operationId);

    // The operation exists, and its id is known. It still answers 404 to tenant A —
    // the same answer as "no such operation", so it is not a probe oracle either.
    const polled = await h.request('admin', 'GET', `/api/operations-log/${operationId}`);
    expect(polled.status).toBe(404);

    // …and the tenant it belongs to can still poll it.
    const own = await h.requestAs(ADMIN_B.token, 'GET', `/api/operations-log/${operationId}`);
    expect(own.status).toBe(200);
  });

  it('refuses a replayed operation id across tenants before comparing anything else', async () => {
    const store = new InMemoryOperationStore();
    const operationId = randomUUID();
    const requestHash = 'identical-hash';

    await store.begin({
      operationId, tenantId: TENANT_A, actorId: 'u-a', actorRole: 'ADMIN',
      action: 'expense.create', requestHash,
    });
    await store.complete(operationId, { type: '06_EXPENSES', id: 'EXP-1' }, { secret: 'A result' });

    // Same id, same hash — everything about this request matches except the tenant.
    const replay = await store.begin({
      operationId, tenantId: TENANT_B, actorId: 'u-b', actorRole: 'ADMIN',
      action: 'expense.create', requestHash,
    });

    expect(replay.outcome).toBe('mismatch');
    // Tenant A's stored result is not handed over, and B is not told it already applied.
    expect((replay as { result?: unknown }).result).toBeUndefined();
  });
});

/* ================================================================== *
 * H · AUDIT
 * ================================================================== */

describe('isolation · audit', () => {
  it('writes the tenant into the durable row, not only into the object', async () => {
    /*
     * The defect this asserts against is exact: migration 0004 added
     * `audit_log.tenant_id`, `AuditRecord` carried the field, and the Supabase insert
     * listed thirteen columns without it — so every production row was unattributed
     * while the in-memory sink, which stores whole objects, showed the field present.
     */
    const inserted: Array<Record<string, unknown>> = [];
    const sink = new SupabaseAuditSink({
      from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }),
    });

    await sink.write(toAuditRecord({
      actor: actorIn(TENANT_A, 'u-a'), action: 'expense.create.applied', result: 'ALLOW',
    }));

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveProperty('tenant_id', TENANT_A);
  });

  it('reads one tenant trail, and an unauthenticated attempt belongs to nobody', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink);

    await logger.record({ actor: actorIn(TENANT_A, 'u-a'), action: 'expense.create', result: 'ALLOW' });
    await logger.record({ actor: actorIn(TENANT_B, 'u-b'), action: 'expense.create', result: 'ALLOW' });
    // No actor at all: a refused, unauthenticated request. Its tenant is unknown.
    await logger.record({ actor: null, action: 'expense.create', result: 'DENY' });

    const forA = await sink.readForTenant(TENANT_A);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.actorId).toBe('u-a');

    // The null-tenant row is in neither trail. "Unknown" must never widen to "any" —
    // that widening is exactly how a tenant-admin audit screen leaks every tenant.
    const forB = await sink.readForTenant(TENANT_B);
    expect(forB.map((r) => r.actorId)).toEqual(['u-b']);
    expect([...forA, ...forB].some((r) => r.tenantId === null)).toBe(false);
  });

  it('offers no way to read the trail without naming a tenant', () => {
    const code = codeOf(read('lib/server/audit/logger.ts'));
    // The interface has exactly one read and it takes a tenant. `readAll` would be the
    // natural first implementation of an audit screen, and it is not available.
    expect(code).toMatch(/readForTenant\(tenantId: string, query\?: AuditQuery\)/);
    expect(code).not.toMatch(/\breadAll\s*\(/);
    expect(code).toContain(".eq('tenant_id', tenantId)");
  });
});

/* ================================================================== *
 * I · MEMBERSHIP remains the authority
 * ================================================================== */

describe('isolation · membership', () => {
  function stubSupabase(memberships: Array<Record<string, unknown>>) {
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
      from(table: string) {
        if (table === 'app_users') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'user-1', email: 'a@example.test', role: 'ADMIN',
                    investor_id: null, status: 'ACTIVE',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({ eq: async () => ({ data: memberships, error: null }) }),
          }),
        };
      },
    };
  }

  it('takes the tenant from the membership row and from nothing else', async () => {
    const { SupabaseAuthProvider } = await import('@/lib/server/auth/session');
    const provider = new SupabaseAuthProvider({ url: 'https://x.invalid', serviceRoleKey: 'k' });
    (provider as unknown as { client: unknown }).client =
      stubSupabase([{ tenant_id: TENANT_B, role: 'ADMIN', status: 'ACTIVE' }]);

    // The token carries no tenant, and the query accepts none. The row decides.
    expect((await provider.resolve('any-token')).tenantId).toBe(TENANT_B);
  });

  it('refuses a login whose membership is not active', async () => {
    const { SupabaseAuthProvider, AuthorizationError } = await import('@/lib/server/auth/session');
    const provider = new SupabaseAuthProvider({ url: 'https://x.invalid', serviceRoleKey: 'k' });
    // The ACTIVE filter is applied in the query; an inactive membership returns no rows.
    (provider as unknown as { client: unknown }).client = stubSupabase([]);

    await expect(provider.resolve('any-token')).rejects.toBeInstanceOf(AuthorizationError);
  });
});
