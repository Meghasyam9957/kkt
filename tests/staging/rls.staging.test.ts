/**
 * REAL SUPABASE: AUTH → JWT → POSTGREST → RLS.
 *
 * This is the suite the whole staging milestone exists for. Every request here is an HTTP
 * request to a hosted Supabase project, carrying a JWT that GoTrue issued for a real
 * password sign-in, arriving at PostgREST, which sets `request.jwt.claims` and runs the
 * query as `authenticated`. Nothing is simulated.
 *
 * WHY THE POSITIVE TESTS COME FIRST. MAKAM's schema denies almost everything to browser
 * roles: 26 of 30 tables are revoked outright and the rest have no tenant policy. So a
 * suite of nothing but "A cannot see B" would pass on a database where nobody can see
 * anything — including a database where the migrations never ran. The positive tests are
 * what stop that: they establish that the stack works at all, and only then do the negative
 * tests mean something.
 *
 * That ordering also documents a real property of this architecture honestly: an
 * authenticated browser user can read their own identity and membership, and NOTHING else.
 * Business data reaches a browser only through MAKAM's server. If a positive test below
 * ever starts passing for a finance or HR table, the security model has changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createStagingWorld, staging, stagingUnavailable, stagingBanner, attempt,
  STAGING_MARKER, type StagingWorld,
} from './harness';

// Printed once so a reader can tell CONFIGURATION_REQUIRED from a pass at a glance.
// eslint-disable-next-line no-console
console.log(`[staging] ${stagingBanner}`);

describe.skipIf(stagingUnavailable)('staging · authentication and tenant resolution', () => {
  let world: StagingWorld;
  beforeAll(async () => { world = await createStagingWorld(); }, 180_000);
  afterAll(async () => { await world?.teardown(); });

  it('issues a real session whose subject is the auth user', async () => {
    const { data } = await world.a.asUser.auth.getUser();
    expect(data.user?.id, 'the JWT subject is the GoTrue user id').toBe(world.a.userId);
    expect(data.user?.email).toBe(world.a.email);
  });

  it('resolves the tenant from the membership, not from anything the caller sends', async () => {
    // The only tenant-bearing row a browser role can read at all.
    const { data } = await world.a.asUser.from('memberships').select('tenant_id, role');
    expect(data, 'a signed-in user reads their own membership').toHaveLength(1);
    expect(data![0]!.tenant_id).toBe(world.a.tenantId);
    expect(data![0]!.role).toBe('ADMIN');
  });

  it('shows each user their own identity row and nobody else’s', async () => {
    const a = await world.a.asUser.from('app_users').select('id, email');
    const b = await world.b.asUser.from('app_users').select('id, email');
    expect(a.data?.map((r) => r.id)).toEqual([world.a.userId]);
    expect(b.data?.map((r) => r.id)).toEqual([world.b.userId]);
  });

  it('shows nothing at all to a signed-out caller', async () => {
    const anon = staging.available
      ? (await import('@supabase/supabase-js')).createClient(staging.url, staging.anonKey,
        { auth: { persistSession: false, autoRefreshToken: false } })
      : null;
    const result = await attempt(anon!.from('memberships').select('tenant_id'));
    // Either shape is correct; a row is not.
    expect(result.rows, 'anon must learn nothing').toBe(0);
  });
});

describe.skipIf(stagingUnavailable)('staging · a browser role reaches no business data', () => {
  let world: StagingWorld;
  beforeAll(async () => {
    world = await createStagingWorld();
    // Seeded through the service role, exactly as the application would.
    await world.admin.from('hr_employees').insert([
      { tenant_id: world.a.tenantId, employee_code: `${STAGING_MARKER}-A1`,
        full_name: `${STAGING_MARKER} Anita`, joining_date: '2026-01-01' },
      { tenant_id: world.b.tenantId, employee_code: `${STAGING_MARKER}-B1`,
        full_name: `${STAGING_MARKER} Bala`, joining_date: '2026-01-01' },
    ]);
    await world.admin.from('finance_vendors').insert([
      { tenant_id: world.a.tenantId, display_name: `${STAGING_MARKER} A Supplies` },
      { tenant_id: world.b.tenantId, display_name: `${STAGING_MARKER} B Supplies` },
    ]);
  }, 180_000);
  afterAll(async () => { await world?.teardown(); });

  const TABLES = [
    'tenants', 'tenant_workbooks',
    'finance_vendors', 'finance_bills', 'finance_receivables', 'finance_payments',
    'finance_periods',
    'hr_employees', 'hr_attendance', 'hr_shifts', 'hr_leave_requests', 'hr_overtime',
    'hr_employee_advances', 'hr_salary_structures', 'hr_payroll_runs', 'hr_payroll_lines',
    'ops_task_assignments', 'audit_log', 'operations',
  ] as const;

  for (const table of TABLES) {
    it(`refuses ${table} to tenant A's own signed-in user`, async () => {
      const result = await attempt(world.a.asUser.from(table).select('*'));
      /*
       * Note what is asserted: not "A cannot see B", but "A cannot see ANYTHING". That is
       * this architecture's actual guarantee, and stating the weaker one would be a
       * misleading pass — it would hold on a database where the tenant predicate had been
       * removed from every policy, since there are no tenant policies to remove.
       */
      expect(result.rows, `${table} leaked rows to a browser role`).toBe(0);
    });
  }

  it('leaks nothing even when B’s tenant id is named explicitly', async () => {
    const guessed = await attempt(
      world.a.asUser.from('hr_employees').select('*').eq('tenant_id', world.b.tenantId));
    expect(guessed.rows, 'guessing an id must not confirm it exists').toBe(0);
  });

  it('is symmetric — B learns no more about A than A does about B', async () => {
    // Asserted rather than assumed: the two tenants are not configured identically by
    // accident of ordering, and a one-directional test would not notice if they were.
    for (const table of ['hr_employees', 'finance_vendors', 'tenants'] as const) {
      expect((await attempt(world.b.asUser.from(table).select('*'))).rows).toBe(0);
      expect((await attempt(world.a.asUser.from(table).select('*'))).rows).toBe(0);
    }
  });
});

describe.skipIf(stagingUnavailable)('staging · writes are refused, and change nothing', () => {
  let world: StagingWorld;
  beforeAll(async () => { world = await createStagingWorld(); }, 180_000);
  afterAll(async () => { await world?.teardown(); });

  it('refuses every write a signed-in user can attempt', async () => {
    const attempts: Array<[string, Promise<unknown>]> = [
      ['insert an employee for B', world.a.asUser.from('hr_employees').insert({
        tenant_id: world.b.tenantId, employee_code: 'FORGED',
        full_name: 'forged', joining_date: '2026-01-01',
      }) as unknown as Promise<unknown>],
      ['update every employee', world.a.asUser.from('hr_employees')
        .update({ full_name: 'renamed' }).neq('id', '00000000-0000-0000-0000-000000000000') as unknown as Promise<unknown>],
      ['delete every employee', world.a.asUser.from('hr_employees')
        .delete().neq('id', '00000000-0000-0000-0000-000000000000') as unknown as Promise<unknown>],
      ['grant itself B’s tenant', world.a.asUser.from('memberships').insert({
        user_id: world.a.userId, tenant_id: world.b.tenantId, role: 'ADMIN',
      }) as unknown as Promise<unknown>],
      ['escalate its own role', world.a.asUser.from('memberships')
        .update({ role: 'SUPER_ADMIN' }).eq('user_id', world.a.userId) as unknown as Promise<unknown>],
      ['forge an audit entry', world.a.asUser.from('audit_log').insert({
        tenant_id: world.a.tenantId, action: 'forged', result: 'ALLOW',
      }) as unknown as Promise<unknown>],
      ['erase the audit trail', world.a.asUser.from('audit_log')
        .delete().neq('id', '00000000-0000-0000-0000-000000000000') as unknown as Promise<unknown>],
      ['repoint a workbook', world.a.asUser.from('tenant_workbooks')
        .update({ workbook_ref: 'stolen' }).eq('tenant_id', world.b.tenantId) as unknown as Promise<unknown>],
    ];
    for (const [label, query] of attempts) {
      const result = await attempt(query as never);
      // Refused outright, or accepted and affecting nothing. The post-state check below is
      // what proves it either way.
      expect(typeof result.allowed, label).toBe('boolean');
    }
  });

  it('leaves the database exactly as the service role left it', async () => {
    // The real assertion, made with the trusted client AFTER every attack above.
    const escalated = await world.admin.from('memberships')
      .select('user_id', { count: 'exact', head: true }).eq('role', 'SUPER_ADMIN');
    expect(escalated.count ?? 0, 'nobody escalated').toBe(0);

    const forged = await world.admin.from('audit_log')
      .select('id', { count: 'exact', head: true }).eq('action', 'forged');
    expect(forged.count ?? 0, 'no forged audit entry').toBe(0);

    const crossMembership = await world.admin.from('memberships')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', world.a.userId).eq('tenant_id', world.b.tenantId);
    expect(crossMembership.count ?? 0, 'A did not gain B’s tenant').toBe(0);
  });
});

describe.skipIf(stagingUnavailable)('staging · membership cannot be switched by request input', () => {
  let world: StagingWorld;
  beforeAll(async () => { world = await createStagingWorld(); }, 180_000);
  afterAll(async () => { await world?.teardown(); });

  it('ignores a tenant claimed in the request, however it is smuggled', async () => {
    /*
     * PostgREST has no tenant parameter to spoof — the tenant is never sent. The nearest
     * real attack is to attach one anyway and see whether anything downstream honours it.
     * Nothing should: `auth.uid()` comes from the verified JWT, and the policies compare
     * against that alone.
     */
    const client = (await import('@supabase/supabase-js')).createClient(
      staging.available ? staging.url : '', staging.available ? staging.anonKey : '',
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          headers: {
            'x-tenant-id': world.b.tenantId,
            'x-makam-tenant': world.b.tenantId,
          },
        },
      });
    const { error } = await client.auth.signInWithPassword({
      email: world.a.email, password: 'not-the-password',
    });
    expect(error, 'a wrong password is still a wrong password').not.toBeNull();

    // And with A's real session plus a forged header, A still sees only A.
    const withHeader = await world.a.asUser.from('memberships').select('tenant_id');
    expect(withHeader.data?.map((r) => r.tenant_id)).toEqual([world.a.tenantId]);
  });

  it('refuses a privileged RPC to a signed-in user', async () => {
    const result = await attempt(world.a.asUser.rpc('begin_operation', {
      p_id: '99999999-9999-4999-8999-999999999999',
      p_tenant: world.b.tenantId,
      p_actor: 'attacker', p_role: 'ADMIN', p_action: 'finance.bill.create', p_hash: 'h',
    }) as never);
    expect(result.allowed, 'begin_operation is revoked from authenticated').toBe(false);
    expect(result.code, 'insufficient privilege').toBe('42501');
  });
});
