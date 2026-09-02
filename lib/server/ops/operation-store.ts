import '@/lib/server/only';
/**
 * OPERATION STORE — idempotency state for every mutation.
 *
 * The client mints one `operationId` (UUID) per user INTENT — when the form opens, not
 * on click — and sends it with every submission and retry of that intent. This store
 * makes the pipeline's begin step atomic: however many identical requests arrive, in
 * whatever order, exactly one performs the business write.
 *
 * Outcomes of `begin`:
 *   inserted   — this caller is the winner; it proceeds to write.
 *   verified   — an earlier identical request finished; its stored result is replayed.
 *   in-flight  — an identical request is applying right now; the caller polls.
 *   failed     — the earlier attempt failed; a FRESH operation id is required. Silent
 *                auto-retry of a failed business write is how double entries happen,
 *                so a failure is never retried under the same intent automatically.
 *   mismatch   — same id, different payload: a bug or an attack, never a retry. Refused.
 *
 * Two implementations with identical semantics: Postgres (production/demo) and
 * in-memory (tests, and demo deployments with no Supabase configured). The in-memory
 * one serialises `begin` through a queue, standing in for the row lock Postgres takes —
 * the concurrency tests run against it and a deliberately broken control proves they
 * can detect a store that doesn't serialise.
 */
import { createHash } from 'crypto';

export type OperationStatus = 'PENDING' | 'APPLYING' | 'VERIFIED' | 'FAILED';
export type BeginOutcome = 'inserted' | 'verified' | 'in-flight' | 'failed' | 'mismatch';

export interface BeginResult {
  outcome: BeginOutcome;
  status: OperationStatus;
  /** Present when outcome = 'verified': the stored, already-redacted response body. */
  result?: unknown;
  /** Present when outcome = 'failed'. */
  error?: string;
}

export interface OperationRecord {
  operationId: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  status: OperationStatus;
  result?: unknown;
  error?: string;
}

export interface OperationStore {
  begin(input: {
    operationId: string;
    /**
     * WHOSE operation this is. An operation id is globally unique, so two tenants can
     * present the same one — and the answer must be refusal, never replay: Tenant B must
     * not receive Tenant A's stored result, nor be told its request was already applied.
     */
    tenantId: string;
    actorId: string | null;
    actorRole: string | null;
    action: string;
    requestHash: string;
  }): Promise<BeginResult>;
  markApplying(operationId: string): Promise<void>;
  complete(operationId: string, entity: { type?: string; id?: string }, result: unknown): Promise<void>;
  fail(operationId: string, entity: { type?: string; id?: string }, error: string): Promise<void>;
  /** Status polling — scoped by actor in the handler, not here. */
  get(operationId: string): Promise<OperationRecord | null>;
}

/** Canonical request hash: same payload in any key order → same hash. */
export function requestHashOf(payload: unknown): string {
  const canonical = JSON.stringify(sortKeys(payload));
  return createHash('sha256').update(canonical).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Postgres-backed store (production / demo with Supabase)
 * ------------------------------------------------------------------ */

export class PostgresOperationStore implements OperationStore {
  constructor(private readonly client: any) {}

  async begin(input: {
    operationId: string; tenantId: string; actorId: string | null; actorRole: string | null;
    action: string; requestHash: string;
  }): Promise<BeginResult> {
    // `begin_operation` compares the stored row's tenant before anything else and
    // reports a mismatch for another customer's id — see migration 0004.
    const { data, error } = await this.client.rpc('begin_operation', {
      p_id: input.operationId, p_tenant: input.tenantId,
      p_actor: input.actorId, p_role: input.actorRole,
      p_action: input.action, p_hash: input.requestHash,
    });
    if (error) throw new Error(`begin_operation failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('begin_operation returned no row');
    const outcome = String(row.outcome).replace('_', '-') as BeginOutcome;
    return {
      outcome,
      status: row.status as OperationStatus,
      ...(row.result !== null && row.result !== undefined ? { result: row.result } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
    };
  }

  private async setStatus(
    operationId: string, status: OperationStatus,
    entity: { type?: string; id?: string } = {}, result?: unknown, error?: string,
  ): Promise<void> {
    const { error: rpcError } = await this.client.rpc('set_operation_status', {
      p_id: operationId, p_status: status,
      p_entity_type: entity.type ?? null, p_entity_id: entity.id ?? null,
      p_result: result ?? null, p_error: error ?? null,
    });
    if (rpcError) throw new Error(`set_operation_status failed: ${rpcError.message}`);
  }

  markApplying(id: string) { return this.setStatus(id, 'APPLYING'); }
  complete(id: string, entity: { type?: string; id?: string }, result: unknown) {
    return this.setStatus(id, 'VERIFIED', entity, result);
  }
  fail(id: string, entity: { type?: string; id?: string }, error: string) {
    return this.setStatus(id, 'FAILED', entity, undefined, error);
  }

  async get(operationId: string): Promise<OperationRecord | null> {
    const { data, error } = await this.client
      .from('operations').select('*').eq('operation_id', operationId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      operationId: data.operation_id, actorId: data.actor_id, actorRole: data.actor_role,
      action: data.action, entityType: data.entity_type ?? undefined,
      entityId: data.entity_id ?? undefined, status: data.status,
      result: data.result ?? undefined, error: data.error ?? undefined,
    };
  }
}

/* ------------------------------------------------------------------ *
 * In-memory store (tests; demo without Supabase)
 * ------------------------------------------------------------------ */

interface StoredOperation extends OperationRecord { requestHash: string; tenantId: string }

export class InMemoryOperationStore implements OperationStore {
  private readonly rows = new Map<string, StoredOperation>();
  private queue: Promise<unknown> = Promise.resolve();

  /** Serialises begin(), standing in for the Postgres row lock. */
  private critical<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  constructor(private readonly latencyMs = 0) {}

  async begin(input: {
    operationId: string; tenantId: string; actorId: string | null; actorRole: string | null;
    action: string; requestHash: string;
  }): Promise<BeginResult> {
    return this.critical(async () => {
      if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
      const existing = this.rows.get(input.operationId);
      if (!existing) {
        this.rows.set(input.operationId, {
          operationId: input.operationId, tenantId: input.tenantId,
          actorId: input.actorId, actorRole: input.actorRole,
          action: input.action, requestHash: input.requestHash, status: 'PENDING',
        });
        return { outcome: 'inserted', status: 'PENDING' } as BeginResult;
      }
      /*
       * THE CROSS-TENANT GUARD, checked before the hash and before any stored result is
       * reachable. Another customer's operation id is a mismatch, full stop — the reply
       * reveals nothing about their operation: not its status, not its result, not
       * whether the hash would have matched. Mirrors `begin_operation` exactly, so a
       * suite passing here is testing the rule production enforces.
       */
      if (existing.tenantId !== input.tenantId) {
        return { outcome: 'mismatch', status: existing.status } as BeginResult;
      }
      if (existing.requestHash !== input.requestHash) {
        return { outcome: 'mismatch', status: existing.status } as BeginResult;
      }
      if (existing.status === 'VERIFIED') {
        return { outcome: 'verified', status: existing.status, result: existing.result } as BeginResult;
      }
      if (existing.status === 'FAILED') {
        return {
          outcome: 'failed', status: existing.status,
          ...(existing.error ? { error: existing.error } : {}),
        } as BeginResult;
      }
      return { outcome: 'in-flight', status: existing.status } as BeginResult;
    });
  }

  async markApplying(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.status = 'APPLYING';
  }

  async complete(id: string, entity: { type?: string; id?: string }, result: unknown): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = 'VERIFIED';
    if (entity.type) row.entityType = entity.type;
    if (entity.id) row.entityId = entity.id;
    row.result = result;
  }

  async fail(id: string, entity: { type?: string; id?: string }, error: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = 'FAILED';
    if (entity.type) row.entityType = entity.type;
    if (entity.id) row.entityId = entity.id;
    row.error = error;
  }

  async get(id: string): Promise<OperationRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const { requestHash: _omitted, ...record } = row;
    return { ...record };
  }
}

/**
 * DELIBERATELY BROKEN control — begin() without the critical section. Exists so the
 * concurrency tests can prove they DETECT a store that fails to serialise: run the
 * same parallel-duplicate test against this and more than one caller wins. Never used
 * outside tests.
 */
export class NaiveOperationStore extends InMemoryOperationStore {
  constructor(private readonly naiveLatencyMs = 1) { super(); }

  override async begin(input: {
    operationId: string; tenantId: string; actorId: string | null; actorRole: string | null;
    action: string; requestHash: string;
  }): Promise<BeginResult> {
    const existing = await this.get(input.operationId);          // read
    await new Promise((r) => setTimeout(r, this.naiveLatencyMs)); // …context switch…
    if (!existing) {
      // write — a concurrent caller that also read "nothing" also lands here.
      await super.begin(input);
      return { outcome: 'inserted', status: 'PENDING' };
    }
    return super.begin(input);
  }
}
