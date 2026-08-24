/**
 * DEMO WRITE → READ INTEGRATION — the Phase C foundation guarantee.
 *
 * One store: the mutation pipeline writes to the shared demo client; the read provider
 * derives every view from the same client through the SAME loaders the live Google
 * provider uses. These tests prove the loop the demo actually performs on stage:
 * record something → the ledger shows it → the KPI engine moves the dashboard.
 *
 * No figure is asserted against hand arithmetic: expectations compare BEFORE and AFTER
 * through the provider, so the KPI engine remains the only calculator.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApiRouter } from '@/lib/server/api/router';
import { API_ROUTES } from '@/lib/server/api/routes';
import { registerMutationHandlers } from '@/lib/server/api/mutation-services';
import type { MutationDependencies } from '@/lib/server/api/mutations';
import { InMemoryAuthProvider } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { IdAllocator, InMemorySequenceStore } from '@/lib/server/ids/allocator';
import { InMemoryOperationStore } from '@/lib/server/ops/operation-store';
import { createRepositories } from '@/lib/server/sheets/repositories';
import { ReadCache } from '@/lib/server/cache/read-cache';
import { getSharedDemoClient, __resetSharedDemoClient } from '@/lib/server/demo/live-store';
import { DemoGridProvider } from '@/lib/data/providers/demo-grid-provider';
import { USERS } from './support/harness';

function harness() {
  const client = getSharedDemoClient();
  const audit = new AuditLogger(new InMemoryAuditSink());
  const deps: MutationDependencies = {
    repos: createRepositories(client),
    store: new InMemoryOperationStore(),
    allocator: new IdAllocator(new InMemorySequenceStore(), audit),
    audit,
    cache: new ReadCache({ ttlMs: 60_000 }),
    writesPermitted: true,
  };
  const router = new ApiRouter({
    authProvider: new InMemoryAuthProvider(Object.values(USERS)), audit,
  });
  registerMutationHandlers(router, API_ROUTES, deps);
  const provider = new DemoGridProvider();

  return {
    provider,
    async post(userKey: keyof typeof USERS, path: string, body: unknown) {
      const res = await router.dispatch({
        method: 'POST', path, body,
        headers: { authorization: `Bearer ${USERS[userKey]!.token}` },
        query: {}, requestId: 'req-int',
      });
      return { status: res.status, body: res.body as any };
    },
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => { __resetSharedDemoClient(); h = harness(); });

describe('demo integration · one store for reads and writes', () => {
  it('a recorded expense appears in the ledger AND moves the monthly series', async () => {
    const months = await h.provider.getAvailableMonths();
    const month = months[months.length - 1]!;
    const before = await h.provider.getExpenses({ month });
    const seriesBefore = await h.provider.getMonthlySeries({ month });
    const rowBefore = seriesBefore.data.find((m) => m.monthKey === month)!;

    const res = await h.post('admin', '/api/expenses', {
      operationId: randomUUID(),
      date: `${month}-15`,
      propertyId: 'HYD-501',
      expenseCategory: 'Variable Operating',
      expenseSubcategory: 'Electricity',
      description: 'Integration test electricity bill',
      amount: 5000,
      paymentStatus: 'Paid',
      paidDate: `${month}-15`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body.record.ExpenseID as string;

    const after = await h.provider.getExpenses({ month });
    expect(after.data.length).toBe(before.data.length + 1);
    expect(after.data.some((r) => r.id === id)).toBe(true);

    const seriesAfter = await h.provider.getMonthlySeries({ month });
    const rowAfter = seriesAfter.data.find((m) => m.monthKey === month)!;
    expect(rowAfter.operatingExpenses).toBeGreaterThan(rowBefore.operatingExpenses);
    // The KPI engine, not this test, decides the exact figure — only the direction and
    // the fact of movement are asserted.
  });

  it('a created maintenance ticket appears on the operations board', async () => {
    const months = await h.provider.getAvailableMonths();
    const month = months[months.length - 1]!;
    const before = await h.provider.getOperations({ month });

    const res = await h.post('operations', '/api/maintenance', {
      operationId: randomUUID(),
      propertyId: 'HYD-502',
      dateReported: before.data.date,
      issueCategory: 'Electrical',
      description: 'Integration test: socket sparking',
      priority: 'Critical',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ticketId = res.body.record.TicketID as string;

    const after = await h.provider.getOperations({ month });
    expect(after.data.maintenance.some((t) => t.ticketId === ticketId)).toBe(true);
    expect(after.data.maintenance.length).toBe(before.data.maintenance.length + 1);
    // A Critical open ticket must surface in the urgent list too.
    expect(after.data.urgent.some((u) => u.title.includes('socket sparking'))).toBe(true);
  });

  it('a created reservation appears in the reservations view', async () => {
    const months = await h.provider.getAvailableMonths();
    const month = months[months.length - 1]!;
    const before = await h.provider.getReservations({ month });

    const res = await h.post('operations', '/api/reservations', {
      operationId: randomUUID(),
      platform: 'Direct',
      propertyId: 'HYD-601',
      bookingDate: `${month}-01`,
      guestName: 'Integration Guest',
      adults: 2, children: 0,
      checkInDate: `${month}-10`,
      checkOutDate: `${month}-12`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bookingId = res.body.record.BookingID as string;

    const after = await h.provider.getReservations({ month });
    expect(JSON.stringify(after.data)).toContain(bookingId);
    expect(after.data.length).toBe(before.data.length + 1);
  });

  it('a demo reset returns the store to its seed — web writes included, by design', async () => {
    const months = await h.provider.getAvailableMonths();
    const month = months[months.length - 1]!;
    const before = await h.provider.getExpenses({ month });

    const res = await h.post('admin', '/api/expenses', {
      operationId: randomUUID(), date: `${month}-15`, propertyId: 'HYD-501',
      expenseCategory: 'Variable Operating', expenseSubcategory: 'Electricity',
      description: 'To be wiped by the reset', amount: 100, paymentStatus: 'Paid',
    });
    expect(res.status).toBe(200);

    __resetSharedDemoClient();               // what a demo reset does to the store
    const fresh = new DemoGridProvider();
    const after = await fresh.getExpenses({ month });
    expect(after.data.length).toBe(before.data.length);
  });
});
