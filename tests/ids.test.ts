/**
 * ATOMIC ID SUITE.
 *
 * The important test is the negative control: `NaiveSequenceStore` implements the
 * MAX+1 pattern the specification forbids, and the concurrency test must FAIL against it.
 * Without that, "no duplicates under concurrency" would only prove the test is weak.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  IdAllocator, InMemorySequenceStore, NaiveSequenceStore, formatId, parseIdValue, scopeFor,
} from '@/lib/server/ids/allocator';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { USERS, TENANT_A } from './support/harness';
import type { AuthContext } from '@/lib/server/auth/session';

const actor: AuthContext = {
  userId: USERS.admin!.userId, email: USERS.admin!.email, role: 'ADMIN',
  tenantId: USERS.admin!.tenantId!,
  investorId: null, status: 'ACTIVE',
};

const CONCURRENCY = 200;

describe('atomic ids · format matches the V1 conventions', () => {
  it('formats each transactional prefix exactly as V1 does', () => {
    expect(formatId('RESERVATIONS', 2026, 1)).toBe('BK-2026-0001');
    expect(formatId('RESERVATIONS', 2026, 42)).toBe('BK-2026-0042');
    expect(formatId('REVENUE', 2026, 7)).toBe('REV-2026-0007');
    expect(formatId('EXPENSES', 2026, 123)).toBe('EXP-2026-0123');
    expect(formatId('CAPEX', 2026, 5)).toBe('CAP-2026-0005');
    expect(formatId('MAINTENANCE', 2026, 3)).toBe('MNT-2026-0003');
    expect(formatId('HOUSEKEEPING', 2026, 9)).toBe('HK-2026-0009');
    expect(formatId('INVESTORS', 2026, 2)).toBe('INV-002');
  });

  it('round-trips an id back to its numeric value', () => {
    expect(parseIdValue('RESERVATIONS', 'BK-2026-0042')).toBe(42);
    expect(parseIdValue('INVESTORS', 'INV-003')).toBe(3);
    expect(parseIdValue('RESERVATIONS', 'not-an-id')).toBeNull();
  });

  it('scopes year-prefixed ids per year and lifetime ids globally', () => {
    expect(scopeFor(TENANT_A, 'RESERVATIONS', 2026)).not.toBe(scopeFor(TENANT_A, 'RESERVATIONS', 2027));
    expect(scopeFor(TENANT_A, 'INVESTORS', 2026)).toBe(scopeFor(TENANT_A, 'INVESTORS', 2027));
  });
});

describe('atomic ids · concurrency', () => {
  it('mints no duplicates under heavy concurrent allocation', async () => {
    const store = new InMemorySequenceStore(1);   // 1ms read→write window
    const allocator = new IdAllocator(store);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor })),
    );

    const ids = results.flatMap((r) => r.ids);
    expect(ids).toHaveLength(CONCURRENCY);
    expect(new Set(ids).size, 'duplicate identifiers were minted').toBe(CONCURRENCY);

    // Contiguous 1..N — no gaps and no reuse.
    const values = ids.map((id) => parseIdValue('RESERVATIONS', id)!).sort((a, b) => a - b);
    expect(values[0]).toBe(1);
    expect(values[values.length - 1]).toBe(CONCURRENCY);
  });

  it('NEGATIVE CONTROL: the MAX+1 pattern fails this same test', async () => {
    // Proves the concurrency test can actually detect a broken allocator. If this ever
    // starts passing, the test above has stopped being meaningful.
    const naive = new IdAllocator(new NaiveSequenceStore(1));
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => naive.allocate({ sheet: 'RESERVATIONS', year: 2026, actor })),
    );
    const ids = results.flatMap((r) => r.ids);
    expect(new Set(ids).size, 'MAX+1 unexpectedly produced no duplicates').toBeLessThan(CONCURRENCY);
  });

  it('allocates contiguous blocks without overlap', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore(1));
    const blocks = await Promise.all([
      allocator.allocate({ sheet: 'REVENUE', year: 2026, actor, count: 5 }),
      allocator.allocate({ sheet: 'REVENUE', year: 2026, actor, count: 5 }),
      allocator.allocate({ sheet: 'REVENUE', year: 2026, actor, count: 5 }),
    ]);
    const all = blocks.flatMap((b) => b.ids);
    expect(new Set(all).size).toBe(15);
    for (const block of blocks) {
      const values = block.ids.map((id) => parseIdValue('REVENUE', id)!);
      expect(values).toEqual([0, 1, 2, 3, 4].map((i) => block.firstValue + i));
    }
  });

  it('keeps separate scopes independent', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore());
    const a = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor });
    const b = await allocator.allocate({ sheet: 'REVENUE', year: 2026, actor });
    const c = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2027, actor });
    expect(a.ids[0]).toBe('BK-2026-0001');
    expect(b.ids[0]).toBe('REV-2026-0001');
    expect(c.ids[0]).toBe('BK-2027-0001');
  });
});

describe('atomic ids · retry safety', () => {
  it('replays the same ids for a repeated idempotency key', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore());
    const first = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, idempotencyKey: 'req-abc' });
    const retry = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, idempotencyKey: 'req-abc' });
    expect(retry.ids).toEqual(first.ids);
    expect(retry.reused).toBe(true);
    expect(first.reused).toBe(false);
  });

  it('concurrent retries of one key all receive the same block', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore(1));
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, idempotencyKey: 'same-key' })),
    );
    const distinct = new Set(results.map((r) => r.ids[0]));
    expect(distinct.size, 'a retried request minted more than one identifier').toBe(1);
  });

  it('rejects an idempotency key reused with different parameters', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore());
    await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, idempotencyKey: 'k', count: 1 });
    await expect(
      allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, idempotencyKey: 'k', count: 3 }),
    ).rejects.toThrow(/different parameters/i);
  });

  it('rejects a nonsensical count instead of silently allocating one', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore());
    for (const count of [0, -1, 1.5]) {
      await expect(allocator.allocate({ sheet: 'RESERVATIONS', count })).rejects.toThrow(/positive integer/i);
    }
  });
});

describe('atomic ids · workbook cutover safety', () => {
  it('seeds the sequence floor from ids already in the workbook', async () => {
    const store = new InMemorySequenceStore();
    const allocator = new IdAllocator(store);

    // The sheet already contains ids typed by hand or minted by V1's menu item.
    await allocator.seedFromExistingIds(TENANT_A, 'RESERVATIONS', 2026,
      ['BK-2026-0001', 'BK-2026-0007', 'BK-2026-0003', 'not-an-id', '']);

    const next = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor });
    expect(next.ids[0], 'allocation collided with an id already in the workbook').toBe('BK-2026-0008');
  });

  it('never lowers a sequence that has already advanced', async () => {
    const store = new InMemorySequenceStore();
    const allocator = new IdAllocator(store);
    await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, count: 50 });
    await allocator.seedFromExistingIds(TENANT_A, 'RESERVATIONS', 2026, ['BK-2026-0003']);
    const next = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor });
    expect(next.ids[0]).toBe('BK-2026-0051');
  });

  it('handles an empty workbook', async () => {
    const allocator = new IdAllocator(new InMemorySequenceStore());
    await allocator.seedFromExistingIds(TENANT_A, 'RESERVATIONS', 2026, []);
    const next = await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor });
    expect(next.ids[0]).toBe('BK-2026-0001');
  });
});

describe('atomic ids · auditability', () => {
  it('records every allocation with its actor', async () => {
    const sink = new InMemoryAuditSink();
    const allocator = new IdAllocator(new InMemorySequenceStore(), new AuditLogger(sink));
    await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, count: 2 });

    const record = sink.byAction('id.allocate')[0]!;
    expect(record.actorId).toBe('u-admin');
    expect(record.actorRole).toBe('ADMIN');
    expect(record.entityType).toBe('04_RESERVATIONS');
    expect(record.metadata.count).toBe(2);
    expect(record.metadata.ids).toEqual(['BK-2026-0001', 'BK-2026-0002']);
    expect(record.result).toBe('ALLOW');
  });

  it('marks a replayed allocation as reused so retries are visible in the trail', async () => {
    const sink = new InMemoryAuditSink();
    const allocator = new IdAllocator(new InMemorySequenceStore(), new AuditLogger(sink));
    await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, idempotencyKey: 'k' });
    await allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor, idempotencyKey: 'k' });
    const records = sink.byAction('id.allocate');
    expect(records[0]!.metadata.reused).toBe(false);
    expect(records[1]!.metadata.reused).toBe(true);
  });
});

describe('atomic ids · report', () => {
  it('writes the allocation summary', async () => {
    const store = new InMemorySequenceStore(1);
    const allocator = new IdAllocator(store);
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => allocator.allocate({ sheet: 'RESERVATIONS', year: 2026, actor })),
    );
    const ids = results.flatMap((r) => r.ids);

    const naive = new IdAllocator(new NaiveSequenceStore(1));
    const naiveIds = (await Promise.all(
      Array.from({ length: CONCURRENCY }, () => naive.allocate({ sheet: 'RESERVATIONS', year: 2026, actor })),
    )).flatMap((r) => r.ids);

    const dir = path.resolve(process.cwd(), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'atomic-ids.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      concurrentAllocations: CONCURRENCY,
      atomic: { minted: ids.length, distinct: new Set(ids).size, duplicates: ids.length - new Set(ids).size },
      negativeControlMaxPlusOne: {
        minted: naiveIds.length, distinct: new Set(naiveIds).size,
        duplicates: naiveIds.length - new Set(naiveIds).size,
        note: 'Deliberately broken. Duplicates here prove the concurrency test can detect failure.',
      },
    }, null, 2));

    expect(new Set(ids).size).toBe(CONCURRENCY);
    expect(new Set(naiveIds).size).toBeLessThan(CONCURRENCY);
  });
});
