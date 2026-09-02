/**
 * M-SAAS-0 — THE TENANT BOUNDARY.
 *
 * MAKAM is the product; Srivillu is the first customer. Until this milestone the
 * *deployment* was the tenant — one workbook id in an environment variable, one process,
 * one customer — which is not a boundary but the absence of one.
 *
 * This suite proves the boundary now exists, at each of the places the architecture audit
 * identified as a breach waiting for a second customer:
 *
 *   · the CACHE, whose workbook key was `identity: null` and therefore one key for
 *     everyone's entire dataset — the single most dangerous line in the codebase;
 *   · the PROVIDER, a module-level singleton that would have served whichever customer
 *     constructed it first to every customer after;
 *   · the ID SEQUENCES, one global number line on which two tenants both mint BK-2026-0001;
 *   · the OPERATION LEDGER, where a globally-unique operation id could replay one
 *     customer's stored result to another;
 *   · the AUDIT, which recorded who did what but never for whom.
 *
 * Two fictional tenants exist only here. Nothing observable to Srivillu changes: it is
 * tenant #1, and every one of its existing tests still passes unaltered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  requireTenant, isTenantId, MissingTenantError,
} from '@/lib/server/tenant/context';
import {
  ReadCache, buildCacheKey, CacheTenantError, CacheIdentityError,
} from '@/lib/server/cache/read-cache';
import {
  getDataProvider, __setDataProviderForTests, __resetReadCacheForTests,
} from '@/lib/data/providers';
import { GoogleSheetsDashboardDataProvider } from '@/lib/data/providers/sheets-provider';
import { IdAllocator, InMemorySequenceStore, scopeFor } from '@/lib/server/ids/allocator';
import { InMemoryOperationStore, requestHashOf } from '@/lib/server/ops/operation-store';
import { AuditLogger, InMemoryAuditSink, toAuditRecord } from '@/lib/server/audit/logger';
import {
  InMemoryAuthProvider, SupabaseAuthProvider, AuthorizationError,
} from '@/lib/server/auth/session';
import { getShellSession } from '@/lib/server/auth/shell-session';
import type { AuthContext } from '@/lib/server/auth/session';
import { TENANT_A, TENANT_B, USERS } from './support/harness';
import { createWriteHarness } from './support/write-harness';
import { readSource as read, codeOf } from './support/source';
import {
  useTenantWorkbooks, useEnvironmentTenant, useTwoTenantWorkbooks, resetTenantWorkbooks,
} from './support/tenant-registry';
import {
  TenantWorkbookNotConfiguredError, TenantWorkbookSuspendedError,
  StaticTenantWorkbookRegistry, environmentBinding, workbookBinding,
} from '@/lib/server/tenant/workbook-registry';

/** A demo environment with no Supabase, so the injected provider is the one consulted. */
const DEMO_ENV = { APP_ENV: 'demo' } as unknown as NodeJS.ProcessEnv;

/** A principal in each tenant. Nothing about them differs except whose data they may reach. */
const actorIn = (tenantId: string, userId: string): AuthContext => ({
  userId, email: `${userId}@example.test`, role: 'ADMIN',
  tenantId, investorId: null, status: 'ACTIVE',
});
const ACTOR_A = actorIn(TENANT_A, 'u-a');
const ACTOR_B = actorIn(TENANT_B, 'u-b');

const contextFor = (tenantId: string) =>
  requireTenant({ tenantId, userId: 'u-x', role: 'ADMIN' }, 'test');

beforeEach(() => {
  __setDataProviderForTests(null);
  __resetReadCacheForTests();
  // Since M-SAAS-1 a provider comes from the tenant workbook registry, so a suite that
  // exercises the real one must register its tenants. TENANT_A stands in for Srivillu on
  // the environment's workbook; TENANT_B is a second customer on its own.
  useTwoTenantWorkbooks(TENANT_A, TENANT_B);
});

/* ================================================================== *
 * 1 · THE CONTEXT — resolved from identity, immutable, fail-closed
 * ================================================================== */

describe('tenant · the context', () => {
  it('refuses to exist without a tenant, rather than widening to all of them', () => {
    for (const bad of [undefined, null, '', '   ']) {
      expect(() => requireTenant({ tenantId: bad, userId: 'u', role: 'ADMIN' }, 'test'), String(bad))
        .toThrow(MissingTenantError);
    }
    // …and without an identity to attach it to.
    expect(() => requireTenant({ tenantId: TENANT_A, userId: '', role: 'ADMIN' }, 'test'))
      .toThrow(MissingTenantError);
    expect(isTenantId('')).toBe(false);
    expect(isTenantId(TENANT_A)).toBe(true);
  });

  it('is immutable once built', () => {
    const context = contextFor(TENANT_A);
    expect(Object.isFrozen(context)).toBe(true);
    // A context that could be edited after the guard checked it would not be a boundary.
    expect(() => {
      (context as { tenantId: string }).tenantId = TENANT_B;
    }).toThrow();
    expect(context.tenantId).toBe(TENANT_A);
  });

  it('comes from the authenticated account, never from anything a caller sent', async () => {
    const provider = new InMemoryAuthProvider([
      { userId: 'u-a', tenantId: TENANT_A, email: 'a@x.test', role: 'ADMIN', token: 'tok-a' },
      { userId: 'u-b', tenantId: TENANT_B, email: 'b@x.test', role: 'ADMIN', token: 'tok-b' },
      // A login with no membership. Production's resolver refuses it the same way.
      { userId: 'u-none', email: 'n@x.test', role: 'ADMIN', token: 'tok-none' },
    ]);

    expect((await provider.resolve('tok-a')).tenantId).toBe(TENANT_A);
    expect((await provider.resolve('tok-b')).tenantId).toBe(TENANT_B);
    // No membership means no data at all — not "everyone's".
    await expect(provider.resolve('tok-none')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('carries the tenant all the way onto the shell session', async () => {
    /*
     * The session is what every page and every handler reads. If the tenant were dropped
     * on the way from the auth context to the session, `requireTenant` would refuse
     * everything — which is at least fail-closed — but nothing would say WHY, and the
     * whole boundary would rest on a field nobody asserted.
     */
    const provider = new InMemoryAuthProvider([
      { userId: 'u-a', tenantId: TENANT_A, email: 'a@x.test', role: 'ADMIN', token: 'tok-a' },
    ]);
    const session = await getShellSession({
      provider, readToken: async () => 'tok-a', env: DEMO_ENV,
    });
    expect(session.tenantId).toBe(TENANT_A);
    // …and it is the tenant the guard then hands to the provider.
    expect(requireTenant(session, 'test').tenantId).toBe(TENANT_A);
  });

  it('MEMBERSHIP is the authority, and no membership means no access', async () => {
    /*
     * The live resolver, against a stubbed Supabase. `app_users.role` survives only as
     * the pre-migration fallback; the tenant comes from the membership row and there is
     * no default. A login with no membership must be refused outright — inventing one
     * would silently place a stranger inside somebody's customer account.
     */
    const account = { id: 'u-1', email: 'a@x.test', role: 'ADMIN', investor_id: null, status: 'ACTIVE' };

    const stub = (memberships: unknown[], error: unknown = null) => ({
      auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
      from: (table: string) => (table === 'app_users'
        ? { select: () => ({ eq: () => ({ single: async () => ({ data: account, error: null }) }) }) }
        : { select: () => ({ eq: () => ({ eq: async () => ({ data: memberships, error }) }) }) }),
    });

    const withClient = (memberships: unknown[], error: unknown = null) => {
      const provider = new SupabaseAuthProvider({ url: 'https://x.invalid', serviceRoleKey: 'k' });
      (provider as unknown as { client: unknown }).client = stub(memberships, error);
      return provider;
    };

    // One active membership: that tenant, and the role it carries.
    const ok = await withClient([{ tenant_id: TENANT_A, role: 'ADMIN', status: 'ACTIVE' }]).resolve('tok');
    expect(ok.tenantId).toBe(TENANT_A);

    // None: refused. Not "the default tenant", not the account row's own scope.
    await expect(withClient([]).resolve('tok')).rejects.toBeInstanceOf(AuthorizationError);

    // Several: refused rather than guessed. Choosing between customers is an explicit act.
    await expect(withClient([
      { tenant_id: TENANT_A, role: 'ADMIN', status: 'ACTIVE' },
      { tenant_id: TENANT_B, role: 'ADMIN', status: 'ACTIVE' },
    ]).resolve('tok')).rejects.toBeInstanceOf(AuthorizationError);

    // A membership whose role disagrees with the account is a broken provisioning state,
    // and is refused rather than resolved to whichever is more permissive.
    await expect(withClient([{ tenant_id: TENANT_A, role: 'SUPER_ADMIN', status: 'ACTIVE' }])
      .resolve('tok')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('is resolved in the auth layer, and nowhere reads one from a request', () => {
    /*
     * The rule that makes every other test here worth something: if a tenant could
     * arrive in a query string, a path or a header, the boundary would be a suggestion.
     */
    for (const file of [
      'lib/server/auth/page-guard.ts',
      'lib/data/providers/index.ts',
      'lib/server/cache/read-cache.ts',
      'lib/server/api/mutations.ts',
    ]) {
      const code = codeOf(read(file));
      expect(code, `${file} reads a tenant from the request`)
        .not.toMatch(/params\.tenant|query\.tenant|headers\[['"]?x-tenant|searchParams\.get\(['"]tenant/i);
    }
    // The live resolver keys the membership lookup on the VERIFIED user id.
    const session = codeOf(read('lib/server/auth/session.ts'));
    expect(session).toContain("from('memberships')");
    expect(session).toContain(".eq('user_id', userId)");
  });
});

/* ================================================================== *
 * 2 · THE CACHE — the breach that needed no attacker
 * ================================================================== */

describe('tenant · cache isolation', () => {
  it('gives two tenants two different keys for the same logical object', () => {
    const a = buildCacheKey({ tenant: TENANT_A, resource: 'workbook', identity: null, filters: { today: '2027-02-19' } });
    const b = buildCacheKey({ tenant: TENANT_B, resource: 'workbook', identity: null, filters: { today: '2027-02-19' } });
    expect(a).not.toBe(b);
    expect(a.startsWith(`tenant=${TENANT_A}|`)).toBe(true);
    expect(b.startsWith(`tenant=${TENANT_B}|`)).toBe(true);
  });

  it('never serves one tenant an entry another tenant stored', async () => {
    const cache = new ReadCache({ ttlMs: 60_000 });
    const a = await cache.get({ tenant: TENANT_A, resource: 'workbook', identity: null }, async () => 'A-DATA');
    const b = await cache.get({ tenant: TENANT_B, resource: 'workbook', identity: null }, async () => 'B-DATA');

    expect(a.value).toBe('A-DATA');
    expect(b.outcome).toBe('MISS');      // NOT a hit on A's entry
    expect(b.value).toBe('B-DATA');
    // And re-reading A still gets A.
    expect((await cache.get({ tenant: TENANT_A, resource: 'workbook', identity: null }, async () => 'X')).value)
      .toBe('A-DATA');
  });

  it('THROWS on a cache entry with no tenant, rather than sharing one', () => {
    for (const bad of [undefined, null, '', '  ']) {
      expect(() => buildCacheKey({ tenant: bad as never, resource: 'workbook', identity: null }), String(bad))
        .toThrow(CacheTenantError);
    }
    // The investor dimension is untouched: both rules apply, independently.
    expect(() => buildCacheKey({ tenant: TENANT_A, resource: 'investor.overview', identity: null }))
      .toThrow(CacheIdentityError);
    expect(buildCacheKey({ tenant: TENANT_A, resource: 'investor.overview', identity: 'INV-001' }))
      .toContain('identity=INV-001');
  });

  it('keeps BOTH dimensions: tenant and investor', () => {
    const keys = new Set([
      buildCacheKey({ tenant: TENANT_A, resource: 'investor.overview', identity: 'INV-001' }),
      buildCacheKey({ tenant: TENANT_A, resource: 'investor.overview', identity: 'INV-002' }),
      buildCacheKey({ tenant: TENANT_B, resource: 'investor.overview', identity: 'INV-001' }),
    ]);
    // Three distinct entries: same investor id in two tenants is two different people.
    expect(keys.size).toBe(3);
  });

  it('invalidates one tenant without flushing another', async () => {
    const cache = new ReadCache({ ttlMs: 60_000 });
    await cache.get({ tenant: TENANT_A, resource: 'workbook', identity: null }, async () => 1);
    await cache.get({ tenant: TENANT_B, resource: 'workbook', identity: null }, async () => 2);

    expect(cache.invalidate(`tenant=${TENANT_A}|`)).toBe(1);
    expect(cache.peek({ tenant: TENANT_B, resource: 'workbook', identity: null })).not.toBeNull();

    // The mutation pipeline invalidates by that prefix, so one customer's write cannot
    // flush — or be flushed by — another's.
    expect(codeOf(read('lib/server/api/mutations.ts')))
      .toContain('deps.cache.invalidate(`tenant=${tenantId}|`)');
  });
});

/* ================================================================== *
 * 3 · THE PROVIDER — no process-global data source
 * ================================================================== */

describe('tenant · provider isolation', () => {
  /*
   * A tenant bound to a NAMED workbook needs the deployment's Google credential to build
   * a client for it — that is the M-SAAS-1 split: workbook per tenant, credential per
   * deployment. These are fictional values built at runtime so no credential-shaped
   * literal exists in the source tree.
   */
  const withoutCredentials = { ...process.env };
  beforeEach(() => {
    process.env.DEMO_GOOGLE_SHEET_ID = 'demo-spreadsheet-id';
    process.env.DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = Buffer
      .from(JSON.stringify({ client_email: 'demo@example.invalid' }), 'utf8')
      .toString('base64');
  });
  afterEach(() => { process.env = { ...withoutCredentials }; resetTenantWorkbooks(); });

  it('refuses to hand out a provider without a tenant', async () => {
    await expect(getDataProvider(undefined as never)).rejects.toThrow(MissingTenantError);
    await expect(getDataProvider({ tenantId: '', userId: 'u', role: 'ADMIN' } as never))
      .rejects.toThrow(MissingTenantError);
  });

  it('refuses a tenant that is not in the workbook registry', async () => {
    /*
     * The fail-closed rule that makes the rest of this suite mean anything. An
     * unregistered tenant does NOT inherit the deployment's workbook, does not fall back
     * to the first tenant and does not get fixtures — it gets nothing, because the
     * alternative is serving one customer another customer's business records.
     */
    await expect(getDataProvider(contextFor('tenant-never-provisioned')))
      .rejects.toThrow(TenantWorkbookNotConfiguredError);
  });

  it('refuses a tenant whose data source is suspended', async () => {
    useTenantWorkbooks([
      { tenantId: TENANT_A, kind: 'GOOGLE_SHEETS', workbookId: 'wb-a', status: 'SUSPENDED' },
    ]);
    // Suspension is a deliberate instruction to stop serving a customer. Honouring it
    // only in the interface would leave the data path open.
    await expect(getDataProvider(contextFor(TENANT_A)))
      .rejects.toThrow(TenantWorkbookSuspendedError);
  });

  it('gives two tenants two different provider instances', async () => {
    const a = await getDataProvider(contextFor(TENANT_A));
    const b = await getDataProvider(contextFor(TENANT_B));
    expect(a).not.toBe(b);
    // …and the same tenant the same one, so this is a registry rather than a leak.
    expect(await getDataProvider(contextFor(TENANT_A))).toBe(a);
  });

  it('binds a live provider to one tenant at construction, and refuses without one', () => {
    expect(() => new GoogleSheetsDashboardDataProvider({
      tenantId: '', client: {} as never,
    })).toThrow(MissingTenantError);

    const provider = new GoogleSheetsDashboardDataProvider({
      tenantId: TENANT_A, client: {} as never,
    });
    expect(provider.tenantId).toBe(TENANT_A);
    // Fixed at construction: there is no setter to talk it into another customer.
    const descriptor = Object.getOwnPropertyDescriptor(provider, 'tenantId');
    expect(descriptor?.set).toBeUndefined();
  });

  it('holds no module-level provider that a second tenant could inherit', () => {
    const code = codeOf(read('lib/data/providers/index.ts'));
    // The old shape, in as many words: `let liveProvider ... = null`.
    expect(code).not.toMatch(/let\s+liveProvider/);
    // The registry is keyed by tenant, and the key is not optional.
    expect(code).toContain('Map<TenantId, CachedProvider>');
    expect(code).toMatch(/getDataProvider\(tenant: TenantContext\)/);
    // The workbook is resolved from the registry, never from the environment directly.
    expect(code).toContain('resolveTenantDataSource(tenant.tenantId)');
    expect(code).not.toContain('createLiveSheetsClient(resolved)');
  });

  it('reads the tenant into every cache key it builds', () => {
    const code = codeOf(read('lib/data/providers/sheets-provider.ts'));
    expect(code).toContain('tenant: this.tenantId');
    // No key is built from anything else.
    expect(code).not.toMatch(/\{\s*resource:\s*WORKBOOK_RESOURCE/);
  });
});

/* ================================================================== *
 * 4 · IDENTIFIERS — two customers, two number lines
 * ================================================================== */

describe('tenant · identifier isolation', () => {
  it('scopes a sequence to its tenant', () => {
    const a = scopeFor(TENANT_A, 'RESERVATIONS', 2026);
    const b = scopeFor(TENANT_B, 'RESERVATIONS', 2026);
    expect(a).not.toBe(b);
    expect(a).toBe(`tenant:${TENANT_A}:04_RESERVATIONS:BK:2026`);
    expect(() => scopeFor('', 'RESERVATIONS', 2026)).toThrow(MissingTenantError);
  });

  it('lets two tenants mint the same VISIBLE id without colliding on the sequence', async () => {
    const store = new InMemorySequenceStore();
    const allocator = new IdAllocator(store);

    const a = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor: ACTOR_A });
    const b = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor: ACTOR_B });

    /*
     * Both are BK-2026-0001, and that is CORRECT: each customer has their own number
     * line, exactly as two businesses both have an invoice #1. What matters is that they
     * came from different sequences — before this, the second caller would have received
     * 0002 from the first customer's counter.
     */
    expect(a.ids[0]).toBe(b.ids[0]);
    expect(a.scope).not.toBe(b.scope);

    // Advancing one leaves the other where it was.
    await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor: ACTOR_A });
    const bAgain = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor: ACTOR_B });
    expect(bAgain.ids[0]).toBe('BK-2026-0002');
  });

  it('refuses an allocation with no tenant rather than falling into a shared sequence', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore());
    await expect(allocator.allocate({ sheet: 'RESERVATIONS', year: 2026 }))
      .rejects.toBeInstanceOf(MissingTenantError);
  });
});

/* ================================================================== *
 * 5 · IDEMPOTENCY — an operation belongs to one customer
 * ================================================================== */

describe('tenant · operation isolation', () => {
  it('refuses a cross-tenant replay, and reveals nothing about the other operation', async () => {
    const store = new InMemoryOperationStore();
    const operationId = randomUUID();
    const hash = requestHashOf({ action: 'expense.create', amount: 100 });

    const first = await store.begin({
      operationId, tenantId: TENANT_A, actorId: 'u-a', actorRole: 'ADMIN',
      action: 'expense.create', requestHash: hash,
    });
    expect(first.outcome).toBe('inserted');
    await store.complete(operationId, { type: 'EXPENSE', id: 'EXP-2026-0001' }, { secret: 'A-RESULT' });

    // Tenant B presents the SAME id and the SAME payload. It is refused as a mismatch —
    // not replayed, and not told the operation was already applied.
    const second = await store.begin({
      operationId, tenantId: TENANT_B, actorId: 'u-b', actorRole: 'ADMIN',
      action: 'expense.create', requestHash: hash,
    });
    expect(second.outcome).toBe('mismatch');
    expect(JSON.stringify(second)).not.toContain('A-RESULT');
    expect(JSON.stringify(second)).not.toContain('EXP-2026-0001');
  });

  it('still replays for the SAME tenant — the existing guarantee is intact', async () => {
    const store = new InMemoryOperationStore();
    const operationId = randomUUID();
    const hash = requestHashOf({ action: 'expense.create', amount: 100 });
    const args = {
      operationId, tenantId: TENANT_A, actorId: 'u-a', actorRole: 'ADMIN',
      action: 'expense.create', requestHash: hash,
    };

    await store.begin(args);
    await store.complete(operationId, { type: 'EXPENSE', id: 'EXP-1' }, { ok: true });
    const replay = await store.begin(args);
    expect(replay.outcome).toBe('verified');
    expect(replay.result).toEqual({ ok: true });
  });

  it('checks the tenant BEFORE the hash, so the order cannot leak a comparison', () => {
    const code = codeOf(read('lib/server/ops/operation-store.ts'));
    const tenantCheck = code.indexOf('existing.tenantId !== input.tenantId');
    const hashCheck = code.indexOf('existing.requestHash !== input.requestHash');
    expect(tenantCheck).toBeGreaterThan(-1);
    expect(tenantCheck).toBeLessThan(hashCheck);

    // The database function enforces the same order, for the same reason.
    const sql = read('supabase/migrations/0004_tenants.sql');
    expect(sql.indexOf('v_row.tenant_id is distinct from p_tenant'))
      .toBeLessThan(sql.indexOf('v_row.request_hash <> p_hash'));
  });
});

/* ================================================================== *
 * 6 · AUDIT — every action belongs to a customer
 * ================================================================== */

describe('tenant · audit isolation', () => {
  it('records the tenant on every audited action', () => {
    const record = toAuditRecord({
      actor: ACTOR_A, action: 'expense.create', result: 'ALLOW',
    }, () => new Date('2026-04-01T10:00:00.000Z'));
    expect(record.tenantId).toBe(TENANT_A);
  });

  it('takes it from the ACTOR, so it cannot be supplied by the caller', () => {
    const code = codeOf(read('lib/server/audit/logger.ts'));
    expect(code).toContain('tenantId: event.actor?.tenantId ?? null');
    // The event has no tenant field of its own to override it with.
    expect(code).not.toMatch(/event\.tenantId/);
  });

  it('leaves an unauthenticated attempt with no tenant — unknown, never "any"', () => {
    const record = toAuditRecord({ actor: null, action: 'denied', result: 'DENY' });
    expect(record.tenantId).toBeNull();
  });

  it('writes a tenant on every real action through the pipeline', async () => {
    const h = createWriteHarness();
    const res = await h.request('admin', 'POST', '/api/expenses', {
      operationId: randomUUID(), date: '2026-08-20', propertyId: 'HYD-501',
      expenseCategory: 'Variable Operating', expenseSubcategory: 'Electricity',
      description: 'Tenant audit check', amount: 100,
      paymentStatus: 'Paid', paidDate: '2026-08-20',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const written = h.audit.records.filter((r) => r.actorId === USERS.admin!.userId);
    expect(written.length).toBeGreaterThan(0);
    for (const record of written) {
      expect(record.tenantId, record.action).toBe(TENANT_A);
    }
  });
});

/* ================================================================== *
 * 7 · WHAT IS AND IS NOT YET TRUE
 * ================================================================== */

describe('tenant · the boundary as it actually stands', () => {
  it('attributes the whole control plane to a tenant, in schema', () => {
    const sql = read('supabase/migrations/0004_tenants.sql');
    for (const clause of [
      'create table if not exists tenants',
      'create table if not exists memberships',
      'alter table audit_log add column if not exists tenant_id',
      'alter table operations add column if not exists tenant_id',
      'alter table operations alter column tenant_id set not null',
    ]) {
      expect(sql, clause).toContain(clause);
    }
    // Deny-by-default is preserved: nothing new is readable from a browser except a
    // user's own membership.
    expect(sql).toContain('revoke all on tenants from authenticated, anon');
    expect(sql).toContain('create policy memberships_self_read on memberships');
    // Exactly one tenant is created. A second customer is a commercial decision.
    expect((sql.match(/insert into tenants/g) ?? [])).toHaveLength(1);
  });

  it('migrates Srivillu without changing a visible identifier', () => {
    const sql = read('supabase/migrations/0004_tenants.sql');
    // Existing sequences are RENAMED, not reset: allocation continues from its floor.
    expect(sql).toMatch(/update id_sequences\s+set scope = 'tenant:'/);
    expect(sql).toContain("where scope not like 'tenant:%'");
    // Every existing user keeps the role they had.
    expect(sql).toMatch(/insert into memberships[\s\S]*select u\.id, t\.id, u\.role, u\.status/);
  });

  it('NOW scopes the data source itself — the M-SAAS-0 expectation, flipped', async () => {
    /*
     * M-SAAS-0 left this recorded as a deliberate gap: it established WHO was asking at
     * every layer but gave both tenants the same workbook, so an object-level check had
     * nothing to compare against. M-SAAS-1 is the milestone that closes it, and this is
     * the same case rewritten to assert the opposite.
     *
     * Registered here as two GOOGLE_SHEETS bindings so the workbook ids are visible in
     * the assertion — the environment binding is proved separately, in the isolation
     * suite, where it is the one that stands in for Srivillu.
     */
    useTenantWorkbooks([
      workbookBinding(TENANT_A, 'workbook-a'),
      workbookBinding(TENANT_B, 'workbook-b'),
    ]);
    const registry = new StaticTenantWorkbookRegistry([
      workbookBinding(TENANT_A, 'workbook-a'),
      workbookBinding(TENANT_B, 'workbook-b'),
    ]);

    const a = await registry.lookup(TENANT_A);
    const b = await registry.lookup(TENANT_B);
    expect(a.workbookId).toBe('workbook-a');
    expect(b.workbookId).toBe('workbook-b');
    // Two customers, two data sources. This is the sentence M-SAAS-0 could not write.
    expect(a.workbookId).not.toBe(b.workbookId);

    // …and the code no longer reaches past the registry to the environment.
    const code = codeOf(read('lib/data/providers/index.ts'));
    expect(code).not.toContain('createLiveSheetsClient(resolved)');
    expect(code).toContain('resolveTenantDataSource');
  });
});
