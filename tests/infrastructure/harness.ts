/**
 * A REAL DATABASE, FROM NOTHING, FOR EACH TEST FILE THAT WANTS ONE.
 *
 * Every database this hands out is created empty, has the Supabase platform objects put
 * under it, then has the repository's eight migrations applied through the same runner a
 * deploy would use. Nothing is pre-baked and no schema snapshot is trusted: if a migration
 * would fail on a clean database, every test in the suite fails to even start, which is
 * exactly the signal wanted.
 *
 * THE PART THAT MAKES THE RLS TESTS REAL — `as()`.
 *
 * PostgreSQL exempts superusers from RLS entirely, and exempts a table's OWNER from it
 * unless the table sets FORCE (none of ours do). The migrations run as the owner, so a test
 * that simply queried after migrating would bypass every policy and pass no matter what the
 * policies said. `as('authenticated', userId)` switches to a role that is neither, and sets
 * the same `request.jwt.claim.sub` GUC that PostgREST sets from a verified JWT — so
 * `auth.uid()` inside the UNMODIFIED policy returns what it will return in production.
 *
 * A test that forgets to call `as()` is testing the owner's view, which is why the
 * cross-tenant tests assert through `asTenantUser()` rather than the bare driver.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyMigrations, type MigrationFile, type SqlDriver,
} from '@/lib/server/db/migration-runner';
import {
  supabaseCompatSql, DEMO_AUTH_USERS, type CompatOptions,
} from '@/lib/server/db/supabase-compat';
import { resolveTestDatabase, redactConnectionString } from '@/lib/server/db/test-database';

export const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

/** The migrations as the repository holds them, in apply order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * `0002_demo_identities.sql` is not structural. Its own header says it belongs to the
 * demonstration project only and must never reach production, and it carries foreign keys
 * into `auth.users` that only exist once somebody has invited those four addresses through
 * the Supabase dashboard.
 *
 * It is named here rather than detected, so that adding another environment-scoped
 * migration is a deliberate act with a reason attached.
 */
export const SEED_MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({
  '0002_demo_identities.sql':
    'Demo-project only. Inserts four fictional logins and depends on auth.users rows that '
    + 'Supabase Auth creates when those addresses are invited.',
});

export function structuralMigrations(dir?: string): MigrationFile[] {
  return loadMigrations(dir).filter((m) => !(m.name in SEED_MIGRATIONS));
}

export interface TestDatabase extends SqlDriver {
  /** Which engine answered, for tests and reports that must not overstate what ran. */
  readonly engine: 'PGLITE' | 'POSTGRES';
  /** Run as a database role, optionally as a specific signed-in user. */
  as<T>(role: 'authenticated' | 'anon' | 'service_role', userId: string | null,
    body: (db: SqlDriver) => Promise<T>): Promise<T>;
  /** Rows, or the refusal, without the caller writing try/catch every time. */
  attempt(sql: string, params?: unknown[]): Promise<AttemptResult>;
  /**
   * The same, for a whole migration file. Separate because a multi-statement script cannot
   * go through the extended-query protocol that parameters require — passing one to
   * `attempt` fails on the protocol before the database ever judges the SQL, which would
   * look like a refusal and mean nothing.
   */
  attemptScript(sql: string): Promise<AttemptResult>;
  close(): Promise<void>;
}

export type AttemptResult =
  | { readonly outcome: 'ALLOWED'; readonly rows: Record<string, unknown>[] }
  | { readonly outcome: 'DENIED'; readonly message: string; readonly code: string | null };

/**
 * ALLOWED-with-zero-rows is NOT the same as DENIED, and conflating them would hide a real
 * regression: an UPDATE that RLS narrows to nothing succeeds and reports zero rows, whereas
 * a missing GRANT throws. Both are safe today; only one stays safe if a policy is added
 * carelessly. So the shape keeps them distinct and the tests assert on row counts.
 */
async function attemptOn(db: SqlDriver, sql: string, params?: unknown[]): Promise<AttemptResult> {
  try {
    const rows = await db.query<Record<string, unknown>>(sql, params);
    return { outcome: 'ALLOWED', rows };
  } catch (error) {
    return refusalOf(error);
  }
}

/** One shape for a refusal, so the two attempt paths cannot describe one differently. */
function refusalOf(error: unknown): AttemptResult {
  const first = error instanceof Error ? error.message.split(/\r?\n/)[0]! : String(error);
  return { outcome: 'DENIED', message: first, code: (error as { code?: string }).code ?? null };
}

interface Opened { driver: SqlDriver; engine: 'PGLITE' | 'POSTGRES'; close: () => Promise<void> }

async function openPglite(): Promise<Opened> {
  // In-memory: it did not exist a moment ago and will not exist a moment later.
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  return {
    engine: 'PGLITE',
    driver: {
      exec: async (sql) => { await pg.exec(sql); },
      query: async <T,>(sql: string, params?: unknown[]) =>
        (await pg.query<T>(sql, params as unknown[] | undefined)).rows,
    },
    close: async () => { await pg.close(); },
  };
}

async function openPostgres(connectionString: string): Promise<Opened> {
  // Imported lazily so a developer machine never loads node-postgres at all.
  const { Client } = await import('pg');

  // A throwaway database per run. Roles are cluster-wide and the compat SQL creates them
  // idempotently, so parallel test files do not fight over them.
  const admin = new Client({ connectionString });
  await admin.connect();
  const name = `makam_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();

  return {
    engine: 'POSTGRES',
    driver: {
      exec: async (sql) => { await client.query(sql); },
      query: async <T,>(sql: string, params?: unknown[]) =>
        (await client.query(sql, params as unknown[] | undefined)).rows as T[],
    },
    close: async () => {
      await client.end();
      const dropper = new Client({ connectionString });
      await dropper.connect();
      await dropper.query(`drop database if exists ${name} with (force)`);
      await dropper.end();
    },
  };
}

export interface FreshOptions extends CompatOptions {
  /** Apply the demo seed migration too. Off by default: it is not structural. */
  readonly includeSeed?: boolean;
  /** Skip migrations entirely, for tests that drive the runner themselves. */
  readonly bare?: boolean;
  /**
   * Seed the four invited demo logins. Default true, because 0002 cannot run without them.
   * Set false to reproduce a database where nobody has been invited yet — which is what a
   * genuinely clean Supabase project looks like, and is the state in which 0002's foreign
   * keys are supposed to refuse it.
   */
  readonly withDemoAuthUsers?: boolean;
}

/**
 * A clean database with the platform objects and the migrations applied.
 *
 * Throws rather than falling back if the configured target is unsafe — a suite that
 * silently degraded to PGlite after refusing a production URL would report a pass that
 * nobody asked for.
 */
export async function freshDatabase(options: FreshOptions = {}): Promise<TestDatabase> {
  const target = resolveTestDatabase(process.env as NodeJS.ProcessEnv);
  const opened = target.kind === 'PGLITE'
    ? await openPglite()
    : await openPostgres(target.connectionString).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not open the test database at ${redactConnectionString(target.connectionString)}: ${reason}`,
      );
    });

  const { driver } = opened;
  await driver.exec(supabaseCompatSql(options));
  if (options.withDemoAuthUsers !== false) await driver.exec(DEMO_AUTH_USERS);

  if (!options.bare) {
    const files = options.includeSeed ? loadMigrations() : structuralMigrations();
    await applyMigrations(driver, files);
  }

  return {
    engine: opened.engine,
    exec: driver.exec,
    query: driver.query,
    attempt: (sql, params) => attemptOn(driver, sql, params),
    attemptScript: async (sql) => {
      try { await driver.exec(sql); return { outcome: 'ALLOWED', rows: [] }; }
      catch (error) { return refusalOf(error); }
    },
    async as(role, userId, body) {
      // `local` scopes both to the surrounding transaction, so one test's identity cannot
      // leak into the next through a shared connection.
      await driver.exec('begin');
      try {
        await driver.exec(`set local role ${role}`);
        if (userId) {
          await driver.query('select set_config($1, $2, true)',
            ['request.jwt.claim.sub', userId]);
        }
        return await body({
          exec: driver.exec,
          query: driver.query,
        });
      } finally {
        // Rolled back, not committed: an attack test must not leave its attempted writes
        // behind even in the cases where the database was willing to accept them.
        await driver.exec('rollback').catch(() => undefined);
      }
    },
    close: opened.close,
  };
}

/** Run one statement as a signed-in user of a tenant and report allowed/denied. */
export async function asTenantUser(
  db: TestDatabase, userId: string, sql: string, params?: unknown[],
): Promise<AttemptResult> {
  return db.as('authenticated', userId, (scoped) => attemptOn(scoped, sql, params));
}
