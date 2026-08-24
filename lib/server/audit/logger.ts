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

/** Shapes an event into a stored record, redacting metadata on the way through. */
export function toAuditRecord(event: AuditEvent, now: () => Date = () => new Date()): AuditRecord {
  return {
    occurredAt: now().toISOString(),
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

export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  async write(record: AuditRecord): Promise<void> { this.records.push(record); }
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

/** Fans out to several sinks; one failing sink does not stop the others. */
export class CompositeAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}
  async write(record: AuditRecord): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.write(record)));
  }
}
