/**
 * THE REAL SUPABASE STAGING HARNESS.
 *
 * Everything in `tests/staging/` runs against an actual hosted Supabase project: real
 * GoTrue auth, real JWTs, real PostgREST, real RLS. Nothing here is stubbed, and nothing
 * here shares a line with the local PGlite harness in `tests/infrastructure/` — that one
 * proves the SCHEMA, this one proves the STACK, and conflating the two is the single
 * easiest way to claim more than was verified.
 *
 * IT DOES NOT RUN TODAY. No staging project is configured for this repository, so every
 * suite here reports CONFIGURATION_REQUIRED and skips. That is a legitimate third outcome,
 * distinct from pass and from fail, and it is reported as such rather than as a green tick.
 *
 * WHAT MAKES IT SAFE TO POINT AT SOMETHING REAL:
 *
 *   - It refuses to run at all unless four variables are set, one of which is an explicit
 *     human declaration that the project is disposable.
 *   - It refuses a host named in the deployment's production configuration, and no flag
 *     lifts that.
 *   - Every row it creates carries the `MAKAM-STAGING-` marker, and teardown deletes only
 *     rows carrying it. It never issues an unqualified DELETE against any table.
 *   - Passwords are generated in-process, used once, and never printed or persisted.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  resolveStaging, describeStaging, type StagingAvailability,
} from '@/lib/server/db/environment-target';

/** Stamped on everything this suite creates, and the only thing teardown will delete. */
export const STAGING_MARKER = 'MAKAM-STAGING';

export const staging: StagingAvailability = resolveStaging(process.env as NodeJS.ProcessEnv);

/**
 * What the runner prints once, so a reader can tell at a glance which of the three
 * outcomes they are looking at. Carries no key material — see `describeStaging`.
 */
export const stagingBanner = describeStaging(staging);

/**
 * `describe.skipIf(stagingUnavailable)` — the same shape `tests/parity.live.test.ts` uses
 * for its credential-gated suite, so an absent staging project reads in the output exactly
 * like the existing honest skips rather than like something new and alarming.
 */
export const stagingUnavailable = !staging.available;

/** A refusal is NOT the same as an absence, and must never skip quietly. */
export const stagingRefused = !staging.available && staging.reason === 'REFUSED';

export interface StagingTenant {
  readonly slug: string;
  readonly tenantId: string;
  readonly email: string;
  readonly userId: string;
  /** Signed in as this tenant's own user: anon key + a real JWT. RLS applies. */
  readonly asUser: SupabaseClient;
}

export interface StagingWorld {
  /** Service role. Bypasses RLS — used only to set up and tear down, never to assert. */
  readonly admin: SupabaseClient;
  readonly a: StagingTenant;
  readonly b: StagingTenant;
  readonly teardown: () => Promise<void>;
}

function adminClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    // A test process is not a browser and must not accumulate sessions between files.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A fresh signed-in user, through the real sign-in flow.
 *
 * Deliberately NOT `admin.auth.admin.generateLink` or a hand-minted JWT: the point of this
 * suite is that the token PostgREST receives is one GoTrue actually issued for a password
 * sign-in, because that is the token production will carry.
 */
async function signedInClient(
  url: string, anonKey: string, email: string, password: string,
): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    // The message, never the credential — this string can reach CI output.
    throw new Error(`Staging sign-in failed for ${email}: ${error.message}`);
  }
  return client;
}

/**
 * Two tenants, two users, two memberships — created through the real APIs and torn down
 * afterwards.
 *
 * The emails are obviously synthetic and land on `makam-staging.invalid`: `.invalid` is
 * reserved by RFC 2606 and can never be a real domain, so no message these accounts might
 * generate can reach a real person.
 */
export async function createStagingWorld(): Promise<StagingWorld> {
  if (!staging.available) {
    throw new Error(`Staging is not available: ${describeStaging(staging)}`);
  }
  const { url, anonKey, serviceRoleKey } = staging;
  const admin = adminClient(url, serviceRoleKey);
  const run = randomUUID().slice(0, 8);

  const made: { users: string[]; tenants: string[] } = { users: [], tenants: [] };

  const build = async (label: 'a' | 'b'): Promise<StagingTenant> => {
    const slug = `${STAGING_MARKER}-${label}-${run}`.toLowerCase();
    const email = `${slug}@makam-staging.invalid`;
    // 32 random bytes, used once, never printed, never written down.
    const password = randomBytes(32).toString('base64url');

    const created = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (created.error || !created.data.user) {
      throw new Error(`Could not create staging user: ${created.error?.message ?? 'no user'}`);
    }
    const userId = created.data.user.id;
    made.users.push(userId);

    const tenantId = randomUUID();
    made.tenants.push(tenantId);

    const tenant = await admin.from('tenants').insert({
      id: tenantId, slug, name: `${STAGING_MARKER} ${label.toUpperCase()} ${run}`,
    });
    if (tenant.error) throw new Error(`Could not create staging tenant: ${tenant.error.message}`);

    // app_users first: memberships references it, and 0001 requires an auth.users row,
    // which the admin API has just created.
    const appUser = await admin.from('app_users')
      .insert({ id: userId, email, role: 'ADMIN' });
    if (appUser.error) throw new Error(`Could not create app_user: ${appUser.error.message}`);

    const membership = await admin.from('memberships')
      .insert({ user_id: userId, tenant_id: tenantId, role: 'ADMIN' });
    if (membership.error) {
      throw new Error(`Could not create membership: ${membership.error.message}`);
    }

    return {
      slug, tenantId, email, userId,
      asUser: await signedInClient(url, anonKey, email, password),
    };
  };

  const a = await build('a');
  const b = await build('b');

  return {
    admin, a, b,
    async teardown() {
      /*
       * Ordered by dependency, and every delete is qualified by an id this run created.
       * There is deliberately no "delete everything in this table" anywhere in this file:
       * a staging project may hold other people's work, and a teardown that assumes
       * otherwise is the thing that destroys it.
       */
      const tenantIds = made.tenants;
      for (const table of [
        'ops_task_assignments', 'hr_attendance', 'hr_employees',
        'finance_bills', 'finance_vendors', 'audit_log', 'operations',
        'tenant_workbooks', 'memberships',
      ]) {
        await admin.from(table).delete().in('tenant_id', tenantIds);
      }
      for (const userId of made.users) {
        await admin.from('app_users').delete().eq('id', userId);
        await admin.auth.admin.deleteUser(userId);
      }
      await admin.from('tenants').delete().in('id', tenantIds);
    },
  };
}

/** A PostgREST outcome, in the shape the assertions want. */
export interface Attempt {
  readonly allowed: boolean;
  readonly rows: number;
  /** PostgREST error code, e.g. '42501' for insufficient privilege. Never a credential. */
  readonly code: string | null;
  readonly message: string | null;
}

/**
 * Run a PostgREST query and describe what happened, WITHOUT collapsing the two ways of
 * being safe into one.
 *
 * RLS refuses a read by returning an empty set, and refuses a write with an error. Both are
 * correct; only one throws. A test that asserted "it errored" would miss a regression that
 * turns a denial into a silent empty read, and a test that asserted "no rows" would miss one
 * that turns a refused write into an accepted one. So both are reported and the assertions
 * say which they expect.
 */
export async function attempt(
  query: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
): Promise<Attempt> {
  const { data, error } = await query;
  if (error) {
    return {
      allowed: false, rows: 0,
      code: error.code ?? null,
      message: error.message ?? null,
    };
  }
  return {
    allowed: true,
    rows: Array.isArray(data) ? data.length : (data == null ? 0 : 1),
    code: null, message: null,
  };
}
