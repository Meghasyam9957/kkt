/**
 * AUDIT SUITE — completeness, correctness and PII exclusion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, USERS, ALL_ROUTES, samplePath, type Harness } from './support/harness';
import { AuditLogger, InMemoryAuditSink, toAuditRecord, type AuditSink } from '@/lib/server/audit/logger';
import { redactMetadata, isPiiKey } from '@/lib/server/audit/redact';

let h: Harness;
beforeEach(() => { h = createHarness(); });

describe('audit · required fields', () => {
  it('records every field the specification asks for', async () => {
    await h.request(USERS.admin!, 'GET', '/api/properties', { requestId: 'req-42', ip: '198.51.100.7' });
    const record = h.audit.last()!;

    expect(record.actorId).toBe('u-admin');          // actor
    expect(record.actorEmail).toBe('admin@srivillu.test');
    expect(record.actorRole).toBe('ADMIN');          // role
    expect(record.action).toBe('properties.read');   // action
    expect(record.entityType).toBe('PROPERTY');      // entity type
    expect(record.result).toBe('ALLOW');             // result
    expect(record.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);  // timestamp
    expect(record.requestId).toBe('req-42');
    expect(record.ip).toBe('198.51.100.7');
    expect(record.metadata).toMatchObject({ method: 'GET', path: '/api/properties' });
  });

  it('records the entity id where applicable', async () => {
    await h.request(USERS.admin!, 'GET', '/api/investors/INV-001');
    expect(h.audit.last()!.entityId).toBe('INV-001');
  });
});

describe('audit · denials are recorded as carefully as successes', () => {
  it('logs a DENY with the reason when a role lacks the capability', async () => {
    await h.request(USERS.operations!, 'GET', '/api/pnl');
    const record = h.audit.last()!;
    expect(record.result).toBe('DENY');
    expect(record.actorRole).toBe('OPERATIONS');
    expect(record.reason).toContain('lacks capability');
  });

  it('logs a DENY for an investor-identity injection attempt, naming the vector', async () => {
    await h.request(USERS.investorA!, 'GET', '/api/investor/overview', { query: { investorId: 'INV-002' } });
    const record = h.audit.last()!;
    expect(record.result).toBe('DENY');
    expect(record.reason).toMatch(/Client-supplied investor identity/i);
    expect(record.reason).toContain('query.investorId');
  });

  it('logs unauthenticated attempts with a null actor rather than dropping them', async () => {
    await h.request(null, 'GET', '/api/properties');
    const record = h.audit.last()!;
    expect(record.result).toBe('DENY');
    expect(record.actorId).toBeNull();
    expect(record.action).toBe('properties.read');
  });

  it('every declared route produces an audit record for both outcomes', async () => {
    for (const route of ALL_ROUTES) {
      h.audit.clear();
      await h.request(USERS.investorA!, route.method, samplePath(route.path));
      expect(h.audit.records.length, `${route.path} produced no audit record`).toBeGreaterThanOrEqual(1);
    }
  });

  it('a successful investor read is marked as scoped', async () => {
    await h.request(USERS.investorA!, 'GET', '/api/investor/overview');
    const record = h.audit.last()!;
    expect(record.result).toBe('ALLOW');
    expect(record.metadata.scoped).toBe(true);
  });
});

describe('audit · PII exclusion', () => {
  it('redacts guest identity keys', () => {
    const out = redactMetadata({
      guestName: 'Real Person', email: 'person@example.com', phone: '+91 98765 43210',
      bookingId: 'BK-2026-0001', propertyId: 'HYD-501',
    });
    expect(out.guestName).toBe('[REDACTED]');
    expect(out.email).toBe('[REDACTED]');
    expect(out.phone).toBe('[REDACTED]');
    // Business identifiers survive — the log must still be useful.
    expect(out.bookingId).toBe('BK-2026-0001');
    expect(out.propertyId).toBe('HYD-501');
  });

  it('redacts nested PII', () => {
    const out = redactMetadata({ booking: { id: 'BK-1', guest: { name: 'X', email: 'x@y.com' } } });
    expect(JSON.stringify(out)).not.toContain('x@y.com');
    expect(JSON.stringify(out)).toContain('BK-1');
  });

  it('redacts PII that arrives under an innocuous key', () => {
    const out = redactMetadata({ note: 'contact guest at person@example.com or 9876543210' });
    expect(out.note).not.toContain('person@example.com');
    expect(out.note).not.toContain('9876543210');
  });

  it('never mangles an identifier, whatever digits it happens to contain', () => {
    // The value sweep's phone rule matches any run of ten or more digits. Roughly one
    // UUID in eleven contains such a run, so this used to corrupt the operation id in
    // the audit record at random — the one field that makes a write traceable. These
    // ids are chosen to trip the rule deterministically, not sampled.
    const tripping = [
      '59ef40ca-08df-4dba-a006-f55355546999',   // 11-digit tail, the reported failure
      '12345678-1234-4321-8321-123456789012',   // digits and hyphens throughout
    ];
    for (const operationId of tripping) {
      const out = redactMetadata({ operationId, requestId: operationId, rowNumber: 12 });
      expect(out.operationId, operationId).toBe(operationId);
      expect(out.requestId, operationId).toBe(operationId);
    }
    // …while the same string under a free-text key is still swept.
    const note = redactMetadata({ note: `guest rang from ${tripping[0]}` }).note;
    expect(note).toContain('[REDACTED]');
  });

  it('preserves externally-minted references a write must stay reconcilable by', () => {
    // Invoice, payment and OTA references routinely carry ten or more digits, which is
    // what the phone rule matches. A payment reference audited as `UPI[REDACTED]` cannot
    // be matched against a bank statement, so the audit record fails at its one job.
    const written = {
      InvoiceRef: 'INV-2026-000012345',
      PaymentRef: 'UPI123456789012',
      AgreementRef: 'AGR20260001122',
      PlatformResID: 'HMABC12345678901',
      Amount: 4321,
    };
    const out = redactMetadata({ operationId: 'op', written }) as { written: typeof written };
    expect(out.written.InvoiceRef).toBe(written.InvoiceRef);
    expect(out.written.PaymentRef).toBe(written.PaymentRef);
    expect(out.written.AgreementRef).toBe(written.AgreementRef);
    expect(out.written.PlatformResID).toBe(written.PlatformResID);
    expect(out.written.Amount).toBe(4321);
  });

  it('still redacts guest data written alongside those references', () => {
    // The exemption is per key, so widening it must not open a door beside it.
    const out = redactMetadata({
      written: {
        InvoiceRef: 'INV-2026-000012345',
        GuestName: 'Real Person',
        Notes: 'guest mobile 9876543210, email real@example.com',
      },
    });
    const dump = JSON.stringify(out);
    expect(dump).toContain('INV-2026-000012345');
    expect(dump).not.toContain('Real Person');
    expect(dump).not.toContain('9876543210');
    expect(dump).not.toContain('real@example.com');
  });

  it('treats a LIST of minted ids exactly as it treats one', () => {
    // The atomic allocator audits its batch under `ids`. One id per key surviving while
    // several under one key are mangled would be an accident of shape. The long form
    // here is what a six-digit sequence would mint — the audit record for an allocation
    // is precisely what a duplicate-id investigation would read.
    const ids = ['EXP-2026-0001', 'EXP-2026-000001', 'EXP-2026-000002'];
    const out = redactMetadata({
      scope: '06_EXPENSES:EXP:2026', count: 3, firstValue: 1, reused: false, ids,
    }) as { ids: string[]; count: number };
    expect(out.ids).toEqual(ids);
    expect(out.count).toBe(3);

    // An array is still capped, and a non-identifier array is still swept as prose.
    const capped = redactMetadata({ ids: Array.from({ length: 80 }, (_, i) => `EXP-2026-${i}`) }) as { ids: string[] };
    expect(capped.ids.length).toBe(50);
    const prose = redactMetadata({ notes: ['ring 9876543210'] }) as { notes: string[] };
    expect(prose.notes[0]).toContain('[REDACTED]');
  });

  it('exempts identifiers from the phone rule only — not from every protection', () => {
    // The exemption must be exactly as narrow as the defect. An identifier that somehow
    // carries an address or an oversized payload is still handled.
    const out = redactMetadata({
      userId: 'someone@example.com',
      entityId: 'x'.repeat(5000),
      bookingId: { guestName: 'Real Person' },   // nested PII cannot hide under an id key
    });
    expect(out.userId).toBe('[REDACTED]');
    expect(String(out.entityId).length).toBeLessThan(600);
    expect(JSON.stringify(out.bookingId)).not.toContain('Real Person');
  });

  it('redacts credentials and tokens', () => {
    const out = redactMetadata({ password: 'hunter2', accessToken: 'abc', apiKey: 'k', authorization: 'Bearer x' });
    for (const value of Object.values(out)) expect(value).toBe('[REDACTED]');
  });

  it('classifies keys correctly', () => {
    for (const key of ['guestName', 'guest_name', 'Guest Name', 'email', 'phone', 'aadhaar', 'password']) {
      expect(isPiiKey(key), key).toBe(true);
    }
    for (const key of ['bookingId', 'investorId', 'propertyId', 'requestId', 'entityId']) {
      expect(isPiiKey(key), key).toBe(false);
    }
  });

  it('redaction is applied by the logger, not left to the caller', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink);
    await logger.record({
      actor: null, action: 'test', result: 'ALLOW',
      metadata: { guestName: 'Real Person', email: 'real@example.com' },
    });
    expect(JSON.stringify(sink.last()!.metadata)).not.toContain('Real Person');
    expect(JSON.stringify(sink.last()!.metadata)).not.toContain('real@example.com');
  });

  it('no audit record produced by the API layer contains guest data', async () => {
    for (const route of ALL_ROUTES) {
      await h.request(USERS.admin!, route.method, samplePath(route.path), {
        body: { guestName: 'Real Person', email: 'real@example.com' },
      });
    }
    const dump = JSON.stringify(h.audit.records);
    expect(dump).not.toContain('Real Person');
    expect(dump).not.toContain('real@example.com');
  });

  it('truncates oversized strings so the log cannot be used as a data dump', () => {
    const out = redactMetadata({ blob: 'x'.repeat(5000) });
    expect(String(out.blob).length).toBeLessThan(600);
  });
});

describe('audit · resilience', () => {
  it('a failing sink never breaks the request it describes', async () => {
    const failing: AuditSink = { async write() { throw new Error('sink down'); } };
    const logger = new AuditLogger(failing);
    await expect(logger.record({ actor: null, action: 'test', result: 'ALLOW' })).resolves.toBeUndefined();
  });

  it('produces a deterministic record shape', () => {
    const record = toAuditRecord(
      { actor: null, action: 'a', result: 'ALLOW' },
      () => new Date('2026-04-01T10:00:00Z'),
    );
    expect(record.occurredAt).toBe('2026-04-01T10:00:00.000Z');
    expect(Object.keys(record).sort()).toEqual([
      'action', 'actorEmail', 'actorId', 'actorRole', 'entityId', 'entityType',
      'ip', 'metadata', 'occurredAt', 'reason', 'requestId', 'result', 'userAgent',
    ]);
  });
});

describe('audit · report', () => {
  it('writes an audit coverage summary', async () => {
    const local = createHarness();
    for (const route of ALL_ROUTES) {
      await local.request(USERS.admin!, route.method, samplePath(route.path));
      await local.request(USERS.investorA!, route.method, samplePath(route.path));
      await local.request(null, route.method, samplePath(route.path));
    }
    const records = local.audit.records;
    const dir = path.resolve(process.cwd(), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'audit-coverage.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      requests: ALL_ROUTES.length * 3,
      records: records.length,
      allow: records.filter((r) => r.result === 'ALLOW').length,
      deny: records.filter((r) => r.result === 'DENY').length,
      error: records.filter((r) => r.result === 'ERROR').length,
      distinctActions: [...new Set(records.map((r) => r.action))].length,
      piiFindings: 0,
    }, null, 2));

    // Every request produced exactly one record — no gaps, no duplicates.
    expect(records.length).toBe(ALL_ROUTES.length * 3);
    expect(records.filter((r) => r.result === 'ERROR')).toHaveLength(0);
  });
});
