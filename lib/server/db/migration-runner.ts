import '@/lib/server/only';
/**
 * THE MIGRATION RUNNER.
 *
 * Before M-INFRA-1 the migrations were eight files nobody had ever executed. This is the
 * thing that executes them, records what it executed, and notices when the record and the
 * files stop agreeing.
 *
 * WHAT IT DELIBERATELY IS NOT: a schema-diffing engine, a rollback engine, or a second
 * migration mechanism competing with the Supabase CLI. If this repository ever adopts
 * `supabase db push`, the ledger below is still the truth about what ran, and the SQL is
 * unchanged — these are plain files applied in filename order, which is exactly what the
 * CLI does. Nothing here is a dialect only this runner understands.
 *
 * THREE PROPERTIES, each of which cost something to get right:
 *
 *   ORDER      Filenames sort lexicographically and that is the apply order. `0010` would
 *              sort before `0002`, so the zero-padding is load-bearing; `assertNaming`
 *              refuses a file that would break it rather than letting it run out of order.
 *
 *   STATE      Every applied migration is recorded with the SHA-256 of its bytes. That is
 *              what makes a re-run a no-op instead of a gamble, and it is what makes drift
 *              detectable at all.
 *
 *   ATOMICITY  Each migration runs inside its own transaction, and the ledger row is
 *              written in the SAME transaction. A migration cannot half-apply, and it can
 *              never be recorded as applied unless it actually applied. No migration in
 *              this repository uses CREATE INDEX CONCURRENTLY, which is the one thing that
 *              would forbid this; `assertTransactional` fails loudly if one ever does.
 */
import { createHash } from 'node:crypto';

/** The minimum a database driver must do. PGlite and node-postgres both satisfy it. */
export interface SqlDriver {
  /** Run one or more statements. Multi-statement SQL must be supported. */
  exec(sql: string): Promise<void>;
  /** Run a query and return rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export type DriftKind =
  /** The file changed after it was applied. The database no longer matches the repository. */
  | 'CHANGED'
  /** Applied against this database, but the file is gone from the repository. */
  | 'MISSING_FILE'
  /** In the repository, never applied here. Ordinary before a deploy; drift after one. */
  | 'PENDING';

export interface Drift {
  readonly name: string;
  readonly kind: DriftKind;
  readonly detail: string;
}

/**
 * The ledger. Created by the runner rather than by a migration, because a migration that
 * creates the migration ledger cannot be recorded in it.
 *
 * `checksum` is over the file's exact bytes. `applied_at` is timestamptz for the same
 * reason every other timestamp in this schema is: an instant is an instant, not a wall
 * clock reading in whichever timezone the deploying laptop happened to be set to.
 */
const LEDGER = `
create table if not exists schema_migrations (
  name        text        primary key,
  checksum    text        not null,
  applied_at  timestamptz not null default now()
);

-- Locked down for the same reason every other table in this schema is, and it is worth
-- saying why a metadata table needs it. On a hosted Supabase project the public schema
-- carries default grants to anon and authenticated so that PostgREST can reach new
-- tables; a table created here inherits them. Left alone, this ledger would be the one
-- object in the database a signed-in browser could read and rewrite -- and rewriting it
-- would make a migration that HAD run look pending, or one that had NOT look applied.
-- Deploy state is not browser data.
alter table schema_migrations enable row level security;
revoke all on schema_migrations from anon, authenticated;`;

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * A filename this runner will apply. Four digits, an underscore, a lowercase slug.
 *
 * The padding is not cosmetic: apply order IS filename order, so `10_x.sql` sorting before
 * `2_x.sql` would silently run a later migration first. Refusing the name is cheaper than
 * debugging that.
 */
const NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export function assertNaming(names: readonly string[]): void {
  const bad = names.filter((n) => !NAME_PATTERN.test(n));
  if (bad.length > 0) {
    throw new Error(
      `Migration filenames must be NNNN_lower_snake.sql so that filename order is apply `
      + `order. Refused: ${bad.join(', ')}`,
    );
  }
  const numbers = names.map((n) => n.slice(0, 4));
  const duplicated = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  if (duplicated.length > 0) {
    // Two files claiming the same ordinal have no defined order between them.
    throw new Error(`Two migrations share an ordinal: ${[...new Set(duplicated)].join(', ')}`);
  }
}

/**
 * Refuse SQL that cannot be wrapped in a transaction.
 *
 * Applying non-transactionally would mean a migration could half-apply and then be recorded
 * as applied, which is the one failure this runner exists to prevent. If a future migration
 * genuinely needs CONCURRENTLY, that is a deliberate change to this runner and to the
 * runbook — not something that should slip in unnoticed.
 */
export function assertTransactional(file: MigrationFile): void {
  // Comments are stripped first so the word inside a sentence of prose does not trip it.
  const code = file.sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\bconcurrently\b/i.test(code)) {
    throw new Error(
      `${file.name} uses CONCURRENTLY, which cannot run inside a transaction. This runner `
      + `applies every migration transactionally so that a failure leaves nothing behind. `
      + `Applying this needs a deliberate change to the runner and to the runbook.`,
    );
  }
}

export async function ensureLedger(db: SqlDriver): Promise<void> {
  await db.exec(LEDGER);
}

export async function readLedger(db: SqlDriver): Promise<AppliedMigration[]> {
  await ensureLedger(db);
  const rows = await db.query<{ name: string; checksum: string; applied_at: unknown }>(
    'select name, checksum, applied_at from schema_migrations order by name',
  );
  return rows.map((r) => ({
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at),
  }));
}

/**
 * Compare the repository against the database.
 *
 * Reported rather than repaired. A checksum mismatch can mean an edited migration or a
 * hand-run statement, and which of those it is changes what should be done about it — so
 * this states the disagreement and lets a person decide (the same stance `reconcile()`
 * takes in the operations domain).
 */
export function driftBetween(
  files: readonly MigrationFile[], applied: readonly AppliedMigration[],
): Drift[] {
  const byName = new Map(applied.map((a) => [a.name, a]));
  const drift: Drift[] = [];

  for (const file of files) {
    const record = byName.get(file.name);
    if (!record) {
      drift.push({
        name: file.name, kind: 'PENDING',
        detail: 'In the repository, not yet applied to this database.',
      });
      continue;
    }
    const now = checksumOf(file.sql);
    if (now !== record.checksum) {
      drift.push({
        name: file.name, kind: 'CHANGED',
        detail: `Applied as ${record.checksum.slice(0, 12)}…, file is now ${now.slice(0, 12)}…. `
          + 'The database no longer matches the repository. Write a follow-up migration; do '
          + 'not edit an applied one.',
      });
    }
  }

  for (const record of applied) {
    if (!files.some((f) => f.name === record.name)) {
      drift.push({
        name: record.name, kind: 'MISSING_FILE',
        detail: `Applied to this database on ${record.appliedAt} but no longer in the repository.`,
      });
    }
  }

  return drift;
}

export interface ApplyResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Apply everything not yet applied, in order, each in its own transaction.
 *
 * Refuses to start when an already-applied migration's bytes have changed: running the
 * remaining migrations on top of a database that no longer matches the repository produces
 * a schema nobody can reason about, and the failure would surface much later and much
 * further away.
 */
export async function applyMigrations(
  db: SqlDriver, files: readonly MigrationFile[],
): Promise<ApplyResult> {
  assertNaming(files.map((f) => f.name));
  for (const file of files) assertTransactional(file);

  const applied = await readLedger(db);
  const changed = driftBetween(files, applied).filter((d) => d.kind === 'CHANGED');
  if (changed.length > 0) {
    throw new Error(
      `Refusing to migrate: ${changed.length} already-applied migration(s) have been edited.\n`
      + changed.map((d) => `  ${d.name}: ${d.detail}`).join('\n'),
    );
  }

  const done = new Set(applied.map((a) => a.name));
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const justApplied: string[] = [];
  const skipped: string[] = [];

  for (const file of ordered) {
    if (done.has(file.name)) { skipped.push(file.name); continue; }
    await db.exec('begin');
    try {
      await db.exec(file.sql);
      // Recorded in the SAME transaction as the DDL: the ledger cannot claim a migration
      // that did not land, and cannot forget one that did.
      await db.query(
        'insert into schema_migrations (name, checksum) values ($1, $2)',
        [file.name, checksumOf(file.sql)],
      );
      await db.exec('commit');
      justApplied.push(file.name);
    } catch (error) {
      await db.exec('rollback').catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Migration ${file.name} failed and was rolled back. Nothing from it was applied, and `
        + `no migration after it was attempted.\n  ${reason}`,
      );
    }
  }

  return { applied: justApplied, skipped };
}
