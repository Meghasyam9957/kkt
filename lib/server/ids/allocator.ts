import '@/lib/server/only';
/**
 * ATOMIC ID ALLOCATION.
 *
 * Google Sheets cannot allocate identifiers safely: two concurrent requests both read the
 * same "highest existing id" and both mint the same one. Allocation therefore happens in
 * Postgres, where a single statement holding a row lock makes the increment atomic.
 *
 * Explicitly NOT `MAX(existing) + 1`. That pattern is a read-then-write race, and it also
 * silently reuses identifiers after a row is deleted.
 *
 * Guarantees:
 *   - concurrent-safe: allocation is one atomic statement, callers serialise
 *   - no duplicates: the sequence only ever moves forward
 *   - retry-safe: an idempotency key replays the same block instead of minting a new one
 *   - auditable: every allocation is recorded with its actor
 */
import { ID_RULES, SHEETS, type SheetKey } from '@/lib/contract/contract.generated';
import type { AuditService } from '@/lib/server/audit/logger';
import type { AuthContext } from '@/lib/server/auth/session';

export interface AllocationRequest {
  sheet: SheetKey;
  /** Calendar year for `{y}` prefixes. Defaults to the current year. */
  year?: number;
  count?: number;
  /** Same key ⇒ same identifiers. Required for any client-retryable path. */
  idempotencyKey?: string;
  actor?: AuthContext | null;
}

export interface AllocationResult {
  ids: string[];
  firstValue: number;
  scope: string;
  /** True when an earlier request with this idempotency key already allocated the block. */
  reused: boolean;
}

/** Low-level counter. The only operation that must be atomic. */
export interface SequenceStore {
  /** Atomically reserve `count` numbers and return the FIRST reserved value. */
  allocate(scope: string, count: number, idempotencyKey?: string, actorId?: string | null):
    Promise<{ firstValue: number; reused: boolean }>;
  /** Raise the floor without ever lowering it (cutover seeding). */
  seedFloor(scope: string, floor: number): Promise<number>;
  peek(scope: string): Promise<number>;
}

/* ------------------------------------------------------------------ *
 * ID formatting — mirrors the V1 conventions exactly
 * ------------------------------------------------------------------ */

export function scopeFor(sheet: SheetKey, year: number): string {
  const sheetName = SHEETS[sheet];
  const rule = ID_RULES[sheetName as keyof typeof ID_RULES];
  if (!rule) throw new Error(`No ID rule for ${sheetName} — check the V1 contract`);
  const yearScoped = rule.prefix.includes('{y}');
  // Non-year prefixes (INV-, AST-, RNT-…) share one lifetime scope.
  return yearScoped ? `${sheetName}:${rule.prefix.replace('-{y}-', '')}:${year}` : `${sheetName}:${rule.prefix}`;
}

export function formatId(sheet: SheetKey, year: number, value: number): string {
  const sheetName = SHEETS[sheet];
  const rule = ID_RULES[sheetName as keyof typeof ID_RULES];
  if (!rule) throw new Error(`No ID rule for ${sheetName} — check the V1 contract`);
  const prefix = rule.prefix.replace('{y}', String(year));
  return prefix + String(value).padStart(rule.pad, '0');
}

/** Parse a V1-style id back to its numeric suffix, or null if it does not match. */
export function parseIdValue(sheet: SheetKey, id: string): number | null {
  const sheetName = SHEETS[sheet];
  const rule = ID_RULES[sheetName as keyof typeof ID_RULES];
  if (!rule) return null;
  const pattern = new RegExp('^' + rule.prefix.replace('{y}', '(\\d{4})').replace(/[-]/g, '\\-') + '(\\d+)$');
  const match = pattern.exec(id.trim());
  if (!match) return null;
  const suffix = match[match.length - 1];
  const value = Number(suffix);
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * The allocator
 * ------------------------------------------------------------------ */

export class IdAllocator {
  constructor(
    private readonly store: SequenceStore,
    private readonly audit?: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async allocate(request: AllocationRequest): Promise<AllocationResult> {
    const count = request.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Allocation count must be a positive integer (got ${count})`);
    }
    const year = request.year ?? this.clock().getFullYear();
    const scope = scopeFor(request.sheet, year);

    const { firstValue, reused } = await this.store.allocate(
      scope, count, request.idempotencyKey, request.actor?.userId ?? null,
    );

    const ids = Array.from({ length: count }, (_, i) => formatId(request.sheet, year, firstValue + i));

    await this.audit?.record({
      actor: request.actor ?? null,
      action: 'id.allocate',
      entityType: SHEETS[request.sheet],
      entityId: ids[0] ?? undefined,
      result: 'ALLOW',
      metadata: { scope, count, firstValue, reused, ids },
    });

    return { ids, firstValue, scope, reused };
  }

  /**
   * Seed a scope's floor from the highest identifier already in the workbook.
   *
   * Required at cutover: the workbook may already contain ids typed by hand or minted by
   * V1's "Generate missing IDs" menu item. Without seeding, the database would start at 1
   * and mint identifiers that already exist in the sheet.
   */
  async seedFromExistingIds(sheet: SheetKey, year: number, existingIds: string[]): Promise<number> {
    const scope = scopeFor(sheet, year);
    const highest = existingIds.reduce((max, id) => {
      const value = parseIdValue(sheet, id);
      return value !== null && value > max ? value : max;
    }, 0);
    return this.store.seedFloor(scope, highest);
  }
}

/* ------------------------------------------------------------------ *
 * Postgres-backed store (production)
 * ------------------------------------------------------------------ */

export class PostgresSequenceStore implements SequenceStore {
  constructor(private readonly client: any) {}

  async allocate(scope: string, count: number, idempotencyKey?: string, actorId?: string | null) {
    const { data, error } = await this.client.rpc('allocate_ids', {
      p_scope: scope, p_count: count, p_key: idempotencyKey ?? null, p_actor: actorId ?? null,
    });
    if (error) throw new Error(`allocate_ids failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('allocate_ids returned no row');
    return { firstValue: Number(row.first_value), reused: Boolean(row.reused) };
  }

  async seedFloor(scope: string, floor: number): Promise<number> {
    const { data, error } = await this.client.rpc('seed_sequence_floor', { p_scope: scope, p_floor: floor });
    if (error) throw new Error(`seed_sequence_floor failed: ${error.message}`);
    return Number(data);
  }

  async peek(scope: string): Promise<number> {
    const { data, error } = await this.client.from('id_sequences').select('last_value').eq('scope', scope).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? Number(data.last_value) : 0;
  }
}

/* ------------------------------------------------------------------ *
 * In-memory store (tests, local development)
 * ------------------------------------------------------------------ */

/**
 * Models the Postgres semantics, including the critical section.
 *
 * `latencyMs` inserts an await between read and write. A read-then-write implementation
 * interleaves under that delay and mints duplicates; a properly serialised one does not.
 * The concurrency test uses it to prove the test can actually detect a broken allocator
 * (see NaiveSequenceStore).
 */
export class InMemorySequenceStore implements SequenceStore {
  private sequences = new Map<string, number>();
  private allocations = new Map<string, { scope: string; firstValue: number; count: number }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly latencyMs = 0) {}

  /** Serialises access, standing in for the row lock Postgres takes. */
  private critical<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async pause(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async allocate(scope: string, count: number, idempotencyKey?: string) {
    return this.critical(async () => {
      if (idempotencyKey) {
        const existing = this.allocations.get(idempotencyKey);
        if (existing) {
          if (existing.scope !== scope || existing.count !== count) {
            throw new Error(`Idempotency key ${idempotencyKey} reused with different parameters`);
          }
          return { firstValue: existing.firstValue, reused: true };
        }
      }
      const current = this.sequences.get(scope) ?? 0;
      await this.pause();                       // the window a racy implementation loses in
      const firstValue = current + 1;
      this.sequences.set(scope, current + count);
      if (idempotencyKey) this.allocations.set(idempotencyKey, { scope, firstValue, count });
      return { firstValue, reused: false };
    });
  }

  async seedFloor(scope: string, floor: number): Promise<number> {
    return this.critical(async () => {
      const next = Math.max(this.sequences.get(scope) ?? 0, Math.max(floor, 0));
      this.sequences.set(scope, next);
      return next;
    });
  }

  async peek(scope: string): Promise<number> {
    return this.sequences.get(scope) ?? 0;
  }
}

/**
 * DELIBERATELY BROKEN control implementation — `MAX + 1` with no critical section.
 *
 * Exists so the concurrency test can demonstrate that it detects duplicates. A passing
 * test that cannot fail proves nothing; this is the negative control that makes the
 * positive result meaningful. Never used outside tests.
 */
export class NaiveSequenceStore implements SequenceStore {
  private sequences = new Map<string, number>();
  constructor(private readonly latencyMs = 1) {}

  async allocate(scope: string, count: number) {
    const current = this.sequences.get(scope) ?? 0;              // read
    await new Promise((r) => setTimeout(r, this.latencyMs));     // …context switch…
    this.sequences.set(scope, current + count);                  // write — lost update here
    return { firstValue: current + 1, reused: false };
  }
  async seedFloor(scope: string, floor: number): Promise<number> {
    this.sequences.set(scope, Math.max(this.sequences.get(scope) ?? 0, floor));
    return this.sequences.get(scope)!;
  }
  async peek(scope: string): Promise<number> { return this.sequences.get(scope) ?? 0; }
}
