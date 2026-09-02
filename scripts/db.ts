/**
 * THE DATABASE COMMAND — rehearse, inspect, apply.
 *
 *   npm run db:check      Apply every migration to a brand-new in-memory PostgreSQL and
 *                         report the schema it produces. Needs no server, no Docker and no
 *                         credentials, so it runs anywhere and is what CI uses as its first
 *                         gate. This is the question "would a clean database accept these
 *                         migrations today?", answered in about ten seconds.
 *
 *   npm run db:status     Against DATABASE_URL: what has been applied, what is pending, and
 *                         where the repository and the database disagree. Reads only.
 *
 *   npm run db:migrate    Against DATABASE_URL: apply what is pending, in order, each in its
 *                         own transaction.
 *
 * ON NAMING THE TARGET. Every command prints the target before doing anything, with the
 * credentials stripped out. A migration tool that does not say out loud which database it is
 * about to change is one keystroke away from changing the wrong one — so `db:migrate`
 * additionally refuses a host that matches the deployment's own production configuration
 * unless `--confirm-production` is passed, and prints the host it is about to alter either
 * way.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigrations, driftBetween, readLedger, type MigrationFile, type SqlDriver,
} from '@/lib/server/db/migration-runner';
import { supabaseCompatSql } from '@/lib/server/db/supabase-compat';
import { hostnameOf, redactConnectionString } from '@/lib/server/db/test-database';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const SEED = new Set(['0002_demo_identities.sql']);

function load(includeSeed: boolean): MigrationFile[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => includeSeed || !SEED.has(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }));
}

async function openPglite(): Promise<{ db: SqlDriver; close: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  return {
    db: {
      exec: async (sql: string) => { await pg.exec(sql); },
      query: async <T,>(sql: string, params?: unknown[]) =>
        (await pg.query<T>(sql, params as unknown[] | undefined)).rows,
    },
    close: async () => { await pg.close(); },
  };
}

async function openPostgres(url: string): Promise<{ db: SqlDriver; close: () => Promise<void> }> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  return {
    db: {
      exec: async (sql: string) => { await client.query(sql); },
      query: async <T,>(sql: string, params?: unknown[]) =>
        (await client.query(sql, params as unknown[] | undefined)).rows as T[],
    },
    close: async () => { await client.end(); },
  };
}

function requireUrl(): string {
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (url === '') {
    console.error(
      'DATABASE_URL is not set, so there is no database to talk to.\n'
      + 'To rehearse the migrations without one, run: npm run db:check',
    );
    process.exit(2);
  }
  return url;
}

/** Refuse the production host unless the operator says so in the command itself. */
function guardProduction(url: string, argv: readonly string[]): void {
  const target = hostnameOf(url);
  for (const name of ['PRODUCTION_SUPABASE_URL', 'PRODUCTION_DATABASE_URL']) {
    const configured = (process.env[name] ?? '').trim();
    if (configured === '' || hostnameOf(configured) !== target) continue;
    if (!argv.includes('--confirm-production')) {
      console.error(
        `REFUSED. ${target} is the host configured in ${name} — this is production.\n`
        + 'Re-run with --confirm-production if that is genuinely what you intend, and take\n'
        + 'a snapshot first: these migrations are forward-only and there is no down path.',
      );
      process.exit(3);
    }
    console.warn(`\n!! APPLYING TO PRODUCTION (${target}), as explicitly confirmed.\n`);
  }
}

async function describeSchema(db: SqlDriver): Promise<void> {
  const tables = await db.query<{ n: number }>(
    `select count(*)::int n from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE'`);
  const policies = await db.query<{ n: number }>('select count(*)::int n from pg_policies');
  const rls = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
  const nullableTenant = await db.query<{ table_name: string }>(
    `select table_name from information_schema.columns
      where table_schema='public' and column_name='tenant_id' and is_nullable='YES'`);

  console.log(`\n  tables                ${tables[0]!.n}`);
  console.log(`  policies              ${policies[0]!.n}`);
  console.log(`  RLS disabled on       ${rls.length === 0 ? 'nothing' : rls.map((r) => r.relname).join(', ')}`);
  console.log(`  nullable tenant_id    ${nullableTenant.length === 0 ? 'none'
    : nullableTenant.map((r) => r.table_name).join(', ')} ${
    nullableTenant.every((r) => r.table_name === 'audit_log') ? '(documented)' : '(REVIEW)'}`);
}

async function main(): Promise<void> {
  const [command = 'check', ...argv] = process.argv.slice(2);

  if (command === 'check') {
    console.log('Target: a new in-memory PostgreSQL (PGlite). Nothing outside this process.');
    const { db, close } = await openPglite();
    try {
      // The platform objects a hosted Supabase project would already provide.
      await db.exec(supabaseCompatSql());
      const files = load(false);
      const result = await applyMigrations(db, files);
      console.log(`\nApplied ${result.applied.length} migration(s) to a clean database:`);
      for (const name of result.applied) console.log(`  ok  ${name}`);
      await describeSchema(db);
      console.log('\nClean-database rehearsal PASSED.');
    } finally { await close(); }
    return;
  }

  const url = requireUrl();
  console.log(`Target: ${redactConnectionString(url)}`);
  const { db, close } = await openPostgres(url);

  try {
    if (command === 'status') {
      const applied = await readLedger(db);
      const drift = driftBetween(load(false), applied);
      console.log(`\nApplied (${applied.length}):`);
      for (const row of applied) console.log(`  ${row.name}  ${row.appliedAt}`);
      if (drift.length === 0) { console.log('\nNo drift. The database matches the repository.'); return; }
      console.log(`\nDrift (${drift.length}):`);
      for (const d of drift) console.log(`  [${d.kind}] ${d.name}\n      ${d.detail}`);
      // PENDING alone is the ordinary state before a deploy, and is not a failure.
      if (drift.some((d) => d.kind !== 'PENDING')) process.exitCode = 1;
      return;
    }

    if (command === 'migrate') {
      guardProduction(url, argv);
      const result = await applyMigrations(db, load(argv.includes('--include-seed')));
      if (result.applied.length === 0) console.log('\nNothing pending. Already up to date.');
      else for (const name of result.applied) console.log(`  applied  ${name}`);
      await describeSchema(db);
      return;
    }

    console.error(`Unknown command '${command}'. Expected: check | status | migrate`);
    process.exitCode = 2;
  } finally { await close(); }
}

main().catch((error: unknown) => {
  // The message only; a stack from node-postgres can carry the connection string.
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
