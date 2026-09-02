import '@/lib/server/only';
/**
 * AUDIT LOG — who did what, when, and whether it was allowed.
 *
 * Two properties matter more than completeness:
 *   1. Denials are recorded as carefully as successes. An audit trail that only shows
 *      what worked cannot show an attack.
 *   2. Guest personal data never reaches it. Redaction happens here, before any sink,
 *      so no caller can opt out by forgetting.
 */
import type { AuthContext } from '@/lib/server/auth/session';
import { redactMetadata } from './redact';

export type AuditResult = 'ALLOW' | 'DENY' | 'ERROR';

export interface AuditEvent {
  actor: AuthContext | null;
  action: string;
  entityType?: string | undefined;
  entityId?: string | undefined;
  result: AuditResult;
  reason?: string | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface AuditRecord {
  occurredAt: string;
  /**
   * WHOSE record this is. Taken from the actor's resolved context, never from a caller.
   *
   * Null only when no tenant could be resolved at all — an unauthenticated attempt has
   * no membership and therefore no tenant. Null means "unknown", never "any": a future
   * tenant-scoped audit read filters on equality, so a null row belongs to nobody.
   */
  tenantId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  result: AuditResult;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

export interface AuditService {
  record(event: AuditEvent): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * READING the trail
 *
 * There is no audit read endpoint today: `GET /api/audit` is declared but has no
 * registered handler, so it authenticates, authorises, audits the attempt and returns
 * 501. This layer exists so that when one IS written it cannot be written unscoped.
 *
 * The interface deliberately offers exactly one read, and it takes a tenant. There is no
 * `readAll`, no optional tenant and no "leave it out for everything" — because the
 * natural first implementation of a tenant-admin audit screen is `select * from
 * audit_log`, and the natural second one, after somebody notices the pre-0005 rows have a
 * null tenant, is `where tenant_id = $t or tenant_id is null`. That second query is how a
 * tenant admin ends up reading every other tenant's actor emails and written cell values.
 * Neither is expressible against this interface.
 * ------------------------------------------------------------------ */

export interface AuditQuery {
  /** Narrow to one action, e.g. 'reservation.create.applied'. */
  action?: string;
  /** Most recent first; defaults to 100 and is clamped, so no caller can ask for the lot. */
  limit?: number;
}

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_AUDIT_LIMIT;
  return Math.max(1, Math.min(MAX_AUDIT_LIMIT, Math.floor(limit)));
}

export interface AuditReader {
  /**
   * The records belonging to ONE tenant.
   *
   * `tenantId` must come from the caller's resolved context — `ctx.auth.tenantId` — and
   * never from a query parameter, a path segment or a body field. Nothing in this module
   * can enforce where the argument came from; what it enforces is that there is no way to
   * ask without supplying one.
   */
  readForTenant(tenantId: string, query?: AuditQuery): Promise<AuditRecord[]>;
}

/** Shapes an event into a stored record, redacting metadata on the way through. */
export function toAuditRecord(event: AuditEvent, now: () => Date = () => new Date()): AuditRecord {
  return {
    occurredAt: now().toISOString(),
    tenantId: event.actor?.tenantId ?? null,
    actorId: event.actor?.userId ?? null,
    actorEmail: event.actor?.email ?? null,
    actorRole: event.actor?.role ?? null,
    action: event.action,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    result: event.result,
    reason: event.reason ?? null,
    requestId: event.requestId ?? null,
    ip: event.ip ?? null,
    userAgent: event.userAgent ?? null,
    metadata: redactMetadata(event.metadata ?? {}),
  };
}

export class AuditLogger implements AuditService {
  constructor(
    private readonly sink: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(event: AuditEvent): Promise<void> {
    const record = toAuditRecord(event, this.now);
    try {
      await this.sink.write(record);
    } catch (error) {
      // An audit sink failure must never take down the request it is describing, but it
      // must be loud: a silent audit gap is worse than a noisy one.
      console.error('[audit] sink write failed', {
        action: record.action, result: record.result, error: (error as Error).message,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Sinks
 * ------------------------------------------------------------------ */

export class InMemoryAuditSink implements AuditSink, AuditReader {
  readonly records: AuditRecord[] = [];
  async write(record: AuditRecord): Promise<void> { this.records.push(record); }

  /** Mirrors the Supabase reader's semantics, including that null tenant matches nobody. */
  async readForTenant(tenantId: string, query: AuditQuery = {}): Promise<AuditRecord[]> {
    return this.records
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => (query.action ? r.action === query.action : true))
      .slice(-clampLimit(query.limit))
      .reverse();
  }
  clear(): void { this.records.length = 0; }
  byAction(action: string): AuditRecord[] { return this.records.filter((r) => r.action === action); }
  denials(): AuditRecord[] { return this.records.filter((r) => r.result === 'DENY'); }
  last(): AuditRecord | undefined { return this.records[this.records.length - 1]; }
}

export class SupabaseAuditSink implements AuditSink {
  constructor(private readonly client: any) {}

  async write(record: AuditRecord): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      occurred_at: record.occurredAt,
      /*
       * WHOSE record this is.
       *
       * M-SAAS-0 added this column (migration 0004), added the field to `AuditRecord` and
       * populated it from the actor — and then this insert did not carry it, so every row
       * written since has been unattributed. The in-memory sink stored the whole record
       * object, so the suite could not see the difference; `tests/tenant.test.ts` now
       * asserts the column list of this insert directly.
       *
       * Null stays possible on purpose: an unauthenticated attempt has no membership and
       * therefore no tenant. It means "unknown", never "any" — a tenant-scoped read
       * filters on equality, so a null row belongs to nobody.
       */
      tenant_id: record.tenantId,
      actor_id: record.actorId,
      actor_email: record.actorEmail,
      actor_role: record.actorRole,
      action: record.action,
      entity_type: record.entityType,
      entity_id: record.entityId,
      result: record.result,
      reason: record.reason,
      request_id: record.requestId,
      ip: record.ip,
      user_agent: record.userAgent,
      metadata: record.metadata,
    });
    if (error) throw new Error(error.message);
  }
}

/**
 * The tenant-scoped audit read against Supabase.
 *
 * `.eq('tenant_id', tenantId)` is the whole control, and it is not optional: the method
 * cannot be called without a tenant, and no code path here builds a query without that
 * predicate. Rows whose tenant is null — every row written between migration 0004 and the
 * sink fix above, plus every unauthenticated attempt — match no tenant at all, which is
 * the correct reading of "no tenant could be resolved".
 */
export class SupabaseAuditReader implements AuditReader {
  constructor(private readonly client: any) {}

  async readForTenant(tenantId: string, query: AuditQuery = {}): Promise<AuditRecord[]> {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      // Fail closed. An empty tenant must never become an unfiltered query.
      throw new Error('An audit read needs a tenant. Refusing to read the trail unscoped.');
    }
    let request = this.client
      .from('audit_log')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('occurred_at', { ascending: false })
      .limit(clampLimit(query.limit));
    if (query.action) request = request.eq('action', query.action);

    const { data, error } = await request;
    if (error) throw new Error(String(error.message ?? 'audit read failed'));
    return (data ?? []).map(rowToAuditRecord);
  }
}

function rowToAuditRecord(row: any): AuditRecord {
  return {
    occurredAt: String(row.occurred_at),
    tenantId: row.tenant_id ?? null,
    actorId: row.actor_id ?? null,
    actorEmail: row.actor_email ?? null,
    actorRole: row.actor_role ?? null,
    action: String(row.action),
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    result: row.result as AuditResult,
    reason: row.reason ?? null,
    requestId: row.request_id ?? null,
    ip: row.ip ?? null,
    userAgent: row.user_agent ?? null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/** Fans out to several sinks; one failing sink does not stop the others. */
export class CompositeAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}
  async write(record: AuditRecord): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.write(record)));
  }
}
