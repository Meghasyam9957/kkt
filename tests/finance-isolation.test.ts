/**
 * M-DATA-1 — FINANCE, ACROSS TWO TENANTS.
 *
 * The workbook made cross-tenant leakage structurally hard: one workbook per tenant means
 * another customer's rows are not in the file you opened, so `tests/tenant-isolation.test.ts`
 * could prove isolation by giving each tenant a different `InMemorySheetsClient`.
 *
 * That proof is not available here, and deliberately so. Every tenant's bills sit in ONE
 * table, and the only thing between customer A and customer B is a predicate. So this
 * suite gives both tenants ONE SHARED `InMemoryFinanceRepository` — the same object, the
 * same maps — and everything below is a claim about the predicate and nothing else. A
 * harness that handed each tenant its own repository would pass every case here while
 * proving only that two Maps are two Maps.
 *
 * The attacker: a fully-authenticated finance user in TENANT_A, holding every capability
 * their role allows, reaching for TENANT_B — by naming a tenant, presenting a real
 * identifier, attributing a cost to the other tenant's property, or replaying the other
 * tenant's operation id.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ApiRouter } from '@/lib/server/api/router';
import { API_ROUTES, assertWriteGovernance } from '@/lib/server/api/routes';
import { registerFinanceHandlers } from '@/lib/server/api/finance-handlers';
import { InMemoryAuthProvider, type TestUser } from '@/lib/server/auth/session';
import { AuditLogger, InMemoryAuditSink } from '@/lib/server/audit/logger';
import { InMemoryOperationStore } from '@/lib/server/ops/operation-store';
import { InMemoryFinanceRepository } from '@/lib/server/finance/repository';
import { SupabaseFinanceRepository } from '@/lib/server/finance/supabase-repository';
import { FinanceService } from '@/lib/server/finance/service';
import { CORPORATE, propertyAttribution, PAYMENT_TRANSITIONS } from '@/lib/server/finance/types';
import {
  paise, rupeesToPaise, addPaise, subtractPaise, sumPaise, MoneyError, paiseFromDatabase,
} from '@/lib/server/finance/money';
import { FINANCIAL_CAPABILITIES, capabilitiesFor, roleHasCapability } from '@/lib/shared/roles';
import { TENANT_A, TENANT_B, USERS } from './support/harness';
import { readSource as read, codeOf } from './support/source';

/* ------------------------------------------------------------------ *
 * The harness — one repository, two tenants
 * ------------------------------------------------------------------ */

const FINANCE_A: TestUser = {
  userId: 'u-fin-a', email: 'fin.a@example.test', role: 'ADMIN',
  tenantId: TENANT_A, token: 'tok-fin-a',
};
const APPROVER_A: TestUser = {
  userId: 'u-appr-a', email: 'appr.a@example.test', role: 'ADMIN',
  tenantId: TENANT_A, token: 'tok-appr-a',
};
const FINANCE_B: TestUser = {
  userId: 'u-fin-b', email: 'fin.b@example.test', role: 'ADMIN',
  tenantId: TENANT_B, token: 'tok-fin-b',
};

/** Each tenant's own workbook properties. B's list is disjoint from A's, on purpose. */
const PROPERTIES: Record<string, string[]> = {
  [TENANT_A]: ['HYD-501', 'HYD-502'],
  [TENANT_B]: ['BLR-101'],
};

interface Harness {
  router: ApiRouter;
  repo: InMemoryFinanceRepository;
  audit: InMemoryAuditSink;
  store: InMemoryOperationStore;
  request(token: string | null, method: string, path: string, body?: unknown):
    Promise<{ status: number; body: any }>;
}

function harness(options: { writesPermitted?: boolean } = {}): Harness {
  // ONE repository. Both tenants read and write the same maps; only the predicate separates
  // them, which is the only thing this suite is trying to prove.
  const repo = new InMemoryFinanceRepository();
  const audit = new InMemoryAuditSink();
  const auditService = new AuditLogger(audit);
  const store = new InMemoryOperationStore();

  const router = new ApiRouter({
    authProvider: new InMemoryAuthProvider([
      ...Object.values(USERS), FINANCE_A, APPROVER_A, FINANCE_B,
    ]),
    audit: auditService,
  });

  registerFinanceHandlers(router, async () => ({
    service: new FinanceService({
      repo,
      // The caller's OWN property list, exactly as production resolves it from the
      // caller's own workbook. There is no path here to another tenant's list.
      propertyIds: async (tenant) => PROPERTIES[tenant.tenantId] ?? [],
      audit: auditService,
    }),
    store,
    audit: auditService,
    writesPermitted: options.writesPermitted ?? true,
  }));

  return {
    router, repo, audit, store,
    async request(token, method, requestPath, body) {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      const [path, search = ''] = requestPath.split('?');
      const response = await router.dispatch({
        method, path: path!, headers, body,
        query: Object.fromEntries(new URLSearchParams(search)),
        requestId: `req-${randomUUID().slice(0, 8)}`,
      });
      return { status: response.status, body: response.body as any };
    },
  };
}

const CORPORATE_BODY = { kind: 'CORPORATE' as const };

/** Draft -> submitted -> approved by a colleague -> posted. The full, legal path. */
async function settle(harnessRef: Harness, paymentId: string): Promise<void> {
  for (const [token, step] of [
    [FINANCE_A.token, 'submit'], [APPROVER_A.token, 'approve'], [FINANCE_A.token, 'post'],
  ] as const) {
    const res = await harnessRef.request(
      token, 'POST', `/api/finance/payments/${paymentId}/${step}`, { operationId: randomUUID() },
    );
    expect(res.status, `${step}: ${JSON.stringify(res.body)}`).toBe(200);
  }
}

async function aVendor(h: Harness, token: string, name = 'Sri Balaji Electricals') {
  const res = await h.request(token, 'POST', '/api/finance/vendors', {
    operationId: randomUUID(), displayName: name,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.id as string;
}

async function aBill(h: Harness, token: string, vendorId: string, over: Record<string, unknown> = {}) {
  const res = await h.request(token, 'POST', '/api/finance/payables', {
    operationId: randomUUID(),
    vendorId,
    billReference: `INV-${randomUUID().slice(0, 6)}`,
    billDate: '2026-05-10',
    dueDate: '2026-06-10',
    attribution: CORPORATE_BODY,
    amountMinor: 2_000_000, // ₹20,000.00
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

let h: Harness;
beforeEach(() => { h = harness(); });

/* ================================================================== *
 * 1 · MONEY — exact, or refused
 * ================================================================== */

describe('finance · money', () => {
  it('adds and subtracts exactly where a float would drift', () => {
    // 0.1 + 0.2 !== 0.3 in rupees. In paise it is 10 + 20 === 30, and always will be.
    const total = addPaise(rupeesToPaise(0.1), rupeesToPaise(0.2));
    expect(total).toBe(30);
    expect(total).toBe(rupeesToPaise(0.3));

    // The case this exists for: a bill settled by two part payments is exactly settled.
    const bill = rupeesToPaise(20_000);
    const outstanding = subtractPaise(bill, sumPaise([rupeesToPaise(8_000), rupeesToPaise(12_000)]));
    expect(outstanding).toBe(0);
  });

  it('refuses precision it cannot store rather than rounding it away', () => {
    expect(() => rupeesToPaise(100.005)).toThrow(MoneyError);
    expect(() => paise(1.5)).toThrow(MoneyError);
    expect(() => paise(Number.NaN)).toThrow(MoneyError);
    expect(() => paise(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  it('reads a bigint column without letting a float back in', () => {
    // The driver hands back a string for bigint; Number() on it directly is where a float
    // would re-enter the domain.
    expect(paiseFromDatabase('250000', 'test')).toBe(250000);
    expect(() => paiseFromDatabase('25.5', 'test')).toThrow(MoneyError);
    expect(() => paiseFromDatabase(null, 'test')).toThrow(MoneyError);
  });
});

/* ================================================================== *
 * 2 · TENANT ISOLATION — the shared repository
 * ================================================================== */

describe('finance · tenant isolation', () => {
  it('does not show one tenant the other vendors, bills, receivables or payments', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token, 'A Electricals');
    await aBill(h, FINANCE_A.token, vendorA);
    await h.request(FINANCE_A.token, 'POST', '/api/finance/receivables', {
      operationId: randomUUID(), counterparty: 'A Guest', reference: 'AR-A-1',
      issuedDate: '2026-05-01', attribution: CORPORATE_BODY, amountMinor: 500_000,
    });
    await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-05-12', attribution: CORPORATE_BODY,
    });

    for (const path of ['vendors', 'payables', 'receivables', 'payments']) {
      const mine = await h.request(FINANCE_A.token, 'GET', `/api/finance/${path}`);
      const theirs = await h.request(FINANCE_B.token, 'GET', `/api/finance/${path}`);
      expect(mine.status, path).toBe(200);
      expect(theirs.status, path).toBe(200);
      expect(mine.body.length, `A must see its own ${path}`).toBeGreaterThan(0);
      expect(theirs.body, `B must see no ${path} of A's`).toEqual([]);
    }
  });

  it('reports a position of zero to a tenant with no finance records of its own', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    await aBill(h, FINANCE_A.token, vendorA);

    const a = await h.request(FINANCE_A.token, 'GET', '/api/finance/overview');
    const b = await h.request(FINANCE_B.token, 'GET', '/api/finance/overview');

    expect(a.body.payablesOutstanding.minor).toBe(2_000_000);
    // Zero because nobody owes B anything — a fact, not missing data.
    expect(b.body.payablesOutstanding.minor).toBe(0);
    expect(b.body.openBills).toBe(0);
  });
});

/* ================================================================== *
 * 3 · IDOR — a real identifier from the other tenant
 * ================================================================== */

describe('finance · identifiers from the other tenant', () => {
  it('answers "no such record" for every kind of identifier, never "not yours"', async () => {
    const vendorB = await aVendor(h, FINANCE_B.token, 'B Suppliers');
    const billB = await aBill(h, FINANCE_B.token, vendorB);
    const paymentB = await h.request(FINANCE_B.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-05-12', attribution: CORPORATE_BODY, billId: billB.id,
    });
    expect(paymentB.status).toBe(200);

    // A pays B's bill: the bill is simply not found, because the lookup carries A's tenant.
    const payTheirBill = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-05-12', attribution: CORPORATE_BODY, billId: billB.id,
    });
    expect(payTheirBill.status).toBe(404);
    expect(payTheirBill.body.error.code).toBe('NOT_FOUND');

    // A transitions B's payment: same answer, same code, no distinguishable difference.
    const approveTheirs = await h.request(
      FINANCE_A.token, 'POST', `/api/finance/payments/${paymentB.body.id}/approve`,
      { operationId: randomUUID() },
    );
    expect(approveTheirs.status).toBe(404);

    // A bills against B's vendor: not found, so B's vendor list is not enumerable either.
    const useTheirVendor = await h.request(FINANCE_A.token, 'POST', '/api/finance/payables', {
      operationId: randomUUID(), vendorId: vendorB, billReference: 'INV-X',
      billDate: '2026-05-10', attribution: CORPORATE_BODY, amountMinor: 100_000,
    });
    expect(useTheirVendor.status).toBe(404);

    // And the refusal for a genuinely nonexistent id is identical, so nothing is learned
    // by comparing the two. This is the property that closes the enumeration oracle.
    const nonexistent = await h.request(
      FINANCE_A.token, 'POST', `/api/finance/payments/${randomUUID()}/approve`,
      { operationId: randomUUID() },
    );
    expect(nonexistent.status).toBe(approveTheirs.status);
    expect(nonexistent.body.error.code).toBe(approveTheirs.body.error.code);
    expect(nonexistent.body.error.message).toBe(approveTheirs.body.error.message);
  });

  it('leaves the other tenant records untouched by a failed attempt', async () => {
    const vendorB = await aVendor(h, FINANCE_B.token, 'B Suppliers');
    const billB = await aBill(h, FINANCE_B.token, vendorB);
    const before = await h.request(FINANCE_B.token, 'GET', '/api/finance/payables');

    await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 999_999,
      paidOn: '2026-05-12', attribution: CORPORATE_BODY, billId: billB.id,
    });

    const after = await h.request(FINANCE_B.token, 'GET', '/api/finance/payables');
    expect(after.body).toEqual(before.body);
    expect(after.body[0].balance.settled.minor).toBe(0);
  });
});

/* ================================================================== *
 * 4 · TENANT SPOOFING
 * ================================================================== */

describe('finance · a caller cannot name a tenant', () => {
  it('refuses a tenant smuggled into the body outright', async () => {
    for (const smuggled of [
      { tenantId: TENANT_B }, { tenant_id: TENANT_B }, { tenant: TENANT_B },
    ]) {
      const res = await h.request(FINANCE_A.token, 'POST', '/api/finance/vendors', {
        operationId: randomUUID(), displayName: 'Steered', ...smuggled,
      });
      // `.strict()` — an unrecognised key is a refusal, not a silently ignored field.
      expect(res.status, JSON.stringify(smuggled)).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION');
    }
  });

  it('ignores a tenant named in the query string, and applies the write to the caller', async () => {
    // The query string reaches a handler unvalidated, so this is the realistic attempt:
    // a perfectly valid payload that is accepted and applied. The only question is whose.
    const res = await h.request(
      FINANCE_A.token, 'POST',
      `/api/finance/vendors?tenant=${TENANT_B}&tenantId=${TENANT_B}`,
      { operationId: randomUUID(), displayName: 'Steered By Query' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const theirs = await h.request(FINANCE_B.token, 'GET', '/api/finance/vendors');
    expect(theirs.body).toEqual([]);
    const mine = await h.request(FINANCE_A.token, 'GET', '/api/finance/vendors');
    expect(mine.body.map((v: any) => v.displayName)).toContain('Steered By Query');
  });

  it('never returns a tenant id to a client', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    const bill = await aBill(h, FINANCE_A.token, vendorA);
    const listed = await h.request(FINANCE_A.token, 'GET', '/api/finance/payables');

    for (const payload of [bill, listed.body[0]]) {
      const serialised = JSON.stringify(payload);
      expect(serialised).not.toContain(TENANT_A);
      expect(serialised).not.toContain('tenantId');
      // Nor the actor fields — a client learns what a record is, not who touched it.
      expect(serialised).not.toContain('createdBy');
      expect(serialised).not.toContain('approvedBy');
    }
  });
});

/* ================================================================== *
 * 5 · PROPERTY SPOOFING
 * ================================================================== */

describe('finance · property attribution', () => {
  it('refuses a cost attributed to the other tenant property', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    const theirProperty = PROPERTIES[TENANT_B]![0]!;

    const res = await h.request(FINANCE_A.token, 'POST', '/api/finance/payables', {
      operationId: randomUUID(), vendorId: vendorA, billReference: 'INV-CROSS',
      billDate: '2026-05-10', amountMinor: 100_000,
      attribution: { kind: 'PROPERTY', propertyId: theirProperty },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNKNOWN_PROPERTY');

    // Identical to a property nobody has. The check never consults another tenant's
    // workbook, so it cannot distinguish the two even in principle.
    const invented = await h.request(FINANCE_A.token, 'POST', '/api/finance/payables', {
      operationId: randomUUID(), vendorId: vendorA, billReference: 'INV-NONE',
      billDate: '2026-05-10', amountMinor: 100_000,
      attribution: { kind: 'PROPERTY', propertyId: 'ZZZ-999' },
    });
    expect(invented.body.error.code).toBe(res.body.error.code);
  });

  it('accepts the caller own property, and corporate attribution without one', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    const own = await h.request(FINANCE_A.token, 'POST', '/api/finance/payables', {
      operationId: randomUUID(), vendorId: vendorA, billReference: 'INV-OWN',
      billDate: '2026-05-10', amountMinor: 100_000,
      attribution: { kind: 'PROPERTY', propertyId: 'HYD-501' },
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.attribution).toEqual({ kind: 'PROPERTY', propertyId: 'HYD-501' });

    // Corporate overhead belongs to no property, and is not forced onto one.
    const corporate = await aBill(h, FINANCE_A.token, vendorA, { billReference: 'INV-CORP' });
    expect(corporate.attribution).toEqual({ kind: 'CORPORATE', propertyId: null });
  });

  it('refuses a PROPERTY attribution with no property, and a CORPORATE one with', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    for (const attribution of [
      { kind: 'PROPERTY' },
      { kind: 'CORPORATE', propertyId: 'HYD-501' },
    ]) {
      const res = await h.request(FINANCE_A.token, 'POST', '/api/finance/payables', {
        operationId: randomUUID(), vendorId: vendorA, billReference: `INV-${randomUUID().slice(0, 5)}`,
        billDate: '2026-05-10', amountMinor: 100_000, attribution,
      });
      expect(res.status, JSON.stringify(attribution)).toBe(422);
    }
  });
});

/* ================================================================== *
 * 6 · BALANCES — arithmetic, never a stored flag
 * ================================================================== */

describe('finance · balances', () => {
  it('counts only POSTED payments toward settlement', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    const bill = await aBill(h, FINANCE_A.token, vendorA); // ₹20,000

    const payment = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 800_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY, billId: bill.id,
    });
    expect(payment.status).toBe(200);

    // A DRAFT payment has moved no money. Counting it would report a bill as part-paid
    // before anybody paid it.
    let payables = await h.request(FINANCE_A.token, 'GET', '/api/finance/payables');
    expect(payables.body[0].balance.settled.minor).toBe(0);
    expect(payables.body[0].balance.outstanding.minor).toBe(2_000_000);

    await settle(h, payment.body.id);

    payables = await h.request(FINANCE_A.token, 'GET', '/api/finance/payables');
    expect(payables.body[0].balance.settled.minor).toBe(800_000);
    expect(payables.body[0].balance.outstanding.minor).toBe(1_200_000);
    expect(payables.body[0].balance.overpaid).toBe(false);
  });

  it('surfaces an overpayment rather than clamping it to zero', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    const bill = await aBill(h, FINANCE_A.token, vendorA, { amountMinor: 100_000 });

    const payment = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 150_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY, billId: bill.id,
    });
    await settle(h, payment.body.id);

    const payables = await h.request(FINANCE_A.token, 'GET', '/api/finance/payables');
    // Negative outstanding, and a flag. Math.max(0, …) would hide the duplicate payment
    // or the mis-attached one that caused it.
    expect(payables.body[0].balance.outstanding.minor).toBe(-50_000);
    expect(payables.body[0].balance.overpaid).toBe(true);
  });

  it('refuses a payment whose direction contradicts what it settles', async () => {
    const vendorA = await aVendor(h, FINANCE_A.token);
    const bill = await aBill(h, FINANCE_A.token, vendorA);
    const res = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'INCOMING', amountMinor: 100_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY, billId: bill.id,
    });
    // A payable settled by money coming IN would silently invert the balance.
    expect(res.status).toBe(422);
  });
});

/* ================================================================== *
 * 7 · LIFECYCLE
 * ================================================================== */

describe('finance · payment lifecycle', () => {
  it('refuses a transition that skips approval', async () => {
    const created = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY,
    });
    const res = await h.request(FINANCE_A.token, 'POST', `/api/finance/payments/${created.body.id}/post`,
      { operationId: randomUUID() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses approval by the person who raised the payment', async () => {
    const created = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY,
    });
    const submitted = await h.request(FINANCE_A.token, 'POST',
      `/api/finance/payments/${created.body.id}/submit`, { operationId: randomUUID() });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.status).toBe('PENDING_APPROVAL');

    const self = await h.request(FINANCE_A.token, 'POST',
      `/api/finance/payments/${created.body.id}/approve`, { operationId: randomUUID() });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_APPROVAL');

    // …and a colleague may.
    const other = await h.request(APPROVER_A.token, 'POST',
      `/api/finance/payments/${created.body.id}/approve`, { operationId: randomUUID() });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.status).toBe('APPROVED');
  });

  it('has no transition out of a final state, so a correction is a new record', () => {
    expect(PAYMENT_TRANSITIONS.VOIDED).toEqual([]);
    expect(PAYMENT_TRANSITIONS.REVERSED).toEqual([]);
    // POSTED is not final: it may be REVERSED, which appends rather than edits.
    expect(PAYMENT_TRANSITIONS.POSTED).toEqual(['REVERSED']);
  });

  it('offers no DELETE anywhere in the finance route family', () => {
    const finance = API_ROUTES.filter((r) => r.path.startsWith('/api/finance/'));
    expect(finance.length).toBeGreaterThan(0);
    expect(finance.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    // Every finance write is a POST: history is append-only.
    for (const route of finance.filter((r) => r.writesFinance)) {
      expect(route.method, route.path).toBe('POST');
    }
  });
});

/* ================================================================== *
 * 8 · IDEMPOTENCY
 * ================================================================== */

describe('finance · idempotency', () => {
  it('does not turn a retried payment into two payments', async () => {
    const body = {
      operationId: randomUUID(), direction: 'OUTGOING' as const, amountMinor: 100_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY,
    };
    const first = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', body);
    const retry = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);

    const all = await h.request(FINANCE_A.token, 'GET', '/api/finance/payments');
    expect(all.body).toHaveLength(1);
  });

  it('survives two concurrent identical requests', async () => {
    const body = {
      operationId: randomUUID(), direction: 'OUTGOING' as const, amountMinor: 250_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY,
    };
    const [a, b] = await Promise.all([
      h.request(FINANCE_A.token, 'POST', '/api/finance/payments', body),
      h.request(FINANCE_A.token, 'POST', '/api/finance/payments', body),
    ]);
    // One wins and one is told the operation is in flight or replayed — never two rows.
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const all = await h.request(FINANCE_A.token, 'GET', '/api/finance/payments');
    expect(all.body).toHaveLength(1);
  });

  it('refuses the same operation id presented by the other tenant', async () => {
    const operationId = randomUUID();
    const body = {
      operationId, direction: 'OUTGOING' as const, amountMinor: 100_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY,
    };
    const mine = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', body);
    expect(mine.status).toBe(200);

    // Byte-identical payload, different tenant. The answer is refusal, not replay: B must
    // never receive A's stored result, nor be told its request was already applied.
    const theirs = await h.request(FINANCE_B.token, 'POST', '/api/finance/payments', body);
    expect(theirs.status).toBe(409);
    expect(theirs.body.error.code).toBe('OPERATION_MISMATCH');
    expect(JSON.stringify(theirs.body)).not.toContain(mine.body.id);

    const bPayments = await h.request(FINANCE_B.token, 'GET', '/api/finance/payments');
    expect(bPayments.body).toEqual([]);
  });
});

/* ================================================================== *
 * 9 · ACCOUNTING PERIODS
 * ================================================================== */

describe('finance · accounting periods', () => {
  it('refuses money dated inside a closed month, and only for the tenant that closed it', async () => {
    const superAdmin = USERS.superAdmin!;
    const closed = await h.request(superAdmin.token, 'POST', '/api/finance/periods/close', {
      operationId: randomUUID(), periodStart: '2026-05-01',
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const refused = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PERIOD_CLOSED');

    // An open month is unaffected.
    const june = await h.request(FINANCE_A.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-06-20', attribution: CORPORATE_BODY,
    });
    expect(june.status).toBe(200);

    // A close is one tenant's decision. B's May is untouched by it.
    const bMay = await h.request(FINANCE_B.token, 'POST', '/api/finance/payments', {
      operationId: randomUUID(), direction: 'OUTGOING', amountMinor: 100_000,
      paidOn: '2026-05-20', attribution: CORPORATE_BODY,
    });
    expect(bMay.status, JSON.stringify(bMay.body)).toBe(200);
  });

  it('keeps closing and reopening above ADMIN, and records a reason', async () => {
    // ADMIN runs the ledger but does not close the books. Reopening a closed month is the
    // act that most needs a second pair of hands.
    expect(roleHasCapability('ADMIN', 'finance.period.manage')).toBe(false);
    expect(roleHasCapability('SUPER_ADMIN', 'finance.period.manage')).toBe(true);

    const denied = await h.request(FINANCE_A.token, 'POST', '/api/finance/periods/close', {
      operationId: randomUUID(), periodStart: '2026-05-01',
    });
    expect(denied.status).toBe(403);

    const superAdmin = USERS.superAdmin!;
    await h.request(superAdmin.token, 'POST', '/api/finance/periods/close', {
      operationId: randomUUID(), periodStart: '2026-05-01',
    });

    const noReason = await h.request(superAdmin.token, 'POST', '/api/finance/periods/reopen', {
      operationId: randomUUID(), periodStart: '2026-05-01',
    });
    expect(noReason.status).toBe(422);

    const reopened = await h.request(superAdmin.token, 'POST', '/api/finance/periods/reopen', {
      operationId: randomUUID(), periodStart: '2026-05-01', reason: 'Late vendor invoice received',
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.status).toBe('OPEN');
    expect(reopened.body.reopenReason).toBe('Late vendor invoice received');

    // …and it is audited, with the actor and the tenant.
    const record = h.audit.records.find((r) => r.action === 'finance.period.reopen.applied');
    expect(record).toBeTruthy();
    expect(record!.tenantId).toBe(TENANT_A);
    expect(record!.actorId).toBe(superAdmin.userId);
  });
});

/* ================================================================== *
 * 10 · ROLE — capability AND the data actually rendered
 * ================================================================== */

describe('finance · roles', () => {
  it('gives OPERATIONS and INVESTOR no finance capability at all', () => {
    for (const role of ['OPERATIONS', 'INVESTOR'] as const) {
      const held = capabilitiesFor(role).filter((c) => c.startsWith('finance.'));
      expect(held, `${role} must hold no finance capability`).toEqual([]);
    }
    // Listing them in FINANCIAL_CAPABILITIES is what makes the existing security suite
    // cover them; asserted here so that wiring cannot be quietly removed.
    for (const capability of ['finance.read', 'finance.write', 'finance.approve', 'finance.period.manage'] as const) {
      expect(FINANCIAL_CAPABILITIES).toContain(capability);
    }
  });

  it('refuses OPERATIONS the finance data itself, not merely the menu entry', async () => {
    // The prior project suffered a capability-vs-rendered-data mismatch. This asserts the
    // RESPONSE, not the grant table: every finance route, driven directly.
    const vendorA = await aVendor(h, FINANCE_A.token);
    await aBill(h, FINANCE_A.token, vendorA);

    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/finance/'))) {
      const path = route.path.replace(':id', randomUUID());
      const res = await h.request(USERS.operations!.token, route.method, path,
        route.method === 'GET' ? undefined : { operationId: randomUUID() });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      const serialised = JSON.stringify(res.body);
      expect(serialised, route.path).not.toContain('Sri Balaji');
      expect(serialised, route.path).not.toContain('2000000');
    }
  });

  it('refuses INVESTOR every finance route', async () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/finance/'))) {
      const res = await h.request(USERS.investorA!.token, route.method,
        route.path.replace(':id', randomUUID()),
        route.method === 'GET' ? undefined : { operationId: randomUUID() });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('refuses an unauthenticated caller before anything is validated', async () => {
    const res = await h.request(null, 'POST', '/api/finance/payments', { nonsense: true });
    expect(res.status).toBe(401);
  });
});

/* ================================================================== *
 * 11 · THE POSTGRES TWIN — the query chain nothing executes
 * ================================================================== */

describe('finance · the Postgres repository', () => {
  /**
   * Nothing in this project runs Postgres, so the only way to catch a lost
   * `.eq('tenant_id', …)` is to record the chain the repository builds. This is exactly
   * the defect that already shipped once: `SupabaseAuditSink` dropped `tenant_id` from
   * its insert while the in-memory twin carried it and the suite stayed green.
   */
  function recorder() {
    const calls: Array<{ table: string; op: string; filters: Array<[string, unknown]>; row?: any }> = [];
    const makeChain = (entry: { table: string; op: string; filters: Array<[string, unknown]>; row?: any }) => {
      const chain: any = {
        eq(column: string, value: unknown) { entry.filters.push([column, value]); return chain; },
        gte() { return chain; },
        lte() { return chain; },
        order() { return chain; },
        select() { return chain; },
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return chain;
    };
    const client = {
      from(table: string) {
        return {
          select() {
            const entry = { table, op: 'select', filters: [] as Array<[string, unknown]> };
            calls.push(entry); return makeChain(entry);
          },
          insert(row: any) {
            const entry = { table, op: 'insert', filters: [] as Array<[string, unknown]>, row };
            calls.push(entry); return makeChain(entry);
          },
          update(row: any) {
            const entry = { table, op: 'update', filters: [] as Array<[string, unknown]>, row };
            calls.push(entry); return makeChain(entry);
          },
          upsert(row: any) {
            const entry = { table, op: 'upsert', filters: [] as Array<[string, unknown]>, row };
            calls.push(entry); return makeChain(entry);
          },
        };
      },
    };
    return { client, calls };
  }

  const tenantA = { tenantId: TENANT_A, userId: 'u', role: 'ADMIN' as const };

  it('filters every single read by tenant', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseFinanceRepository(client);

    await repo.listVendors(tenantA);
    await repo.getVendor(tenantA, 'v-1');
    await repo.listBills(tenantA);
    await repo.getBill(tenantA, 'b-1');
    await repo.listReceivables(tenantA);
    await repo.getReceivable(tenantA, 'r-1');
    await repo.listPayments(tenantA);
    await repo.getPayment(tenantA, 'p-1');
    await repo.paymentsFor(tenantA, { billId: 'b-1' });
    await repo.paymentsFor(tenantA, { receivableId: 'r-1' });
    await repo.listPeriods(tenantA);
    await repo.getPeriod(tenantA, '2026-05-01');

    const reads = calls.filter((c) => c.op === 'select');
    expect(reads.length).toBe(12);
    for (const call of reads) {
      expect(
        call.filters.some(([column, value]) => column === 'tenant_id' && value === TENANT_A),
        `${call.table} read without a tenant predicate`,
      ).toBe(true);
    }
  });

  it('stamps the tenant on every insert, and cannot be told otherwise', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseFinanceRepository(client);

    await repo.createVendor(tenantA, { displayName: 'V' }, 'actor').catch(() => {});
    await repo.createBill(tenantA, {
      vendorId: 'v-1', billReference: 'INV-1', billDate: '2026-05-01',
      attribution: CORPORATE, amount: paise(100),
    }, 'actor').catch(() => {});
    await repo.createPayment(tenantA, {
      direction: 'OUTGOING', amount: paise(100), paidOn: '2026-05-01', attribution: CORPORATE,
    }, 'actor').catch(() => {});

    const inserts = calls.filter((c) => c.op === 'insert');
    expect(inserts.length).toBe(3);
    for (const call of inserts) {
      expect(call.row.tenant_id, `${call.table} insert without a tenant`).toBe(TENANT_A);
    }
  });

  it('carries BOTH predicates on every update, never the id alone', async () => {
    const { client, calls } = recorder();
    const repo = new SupabaseFinanceRepository(client);

    await repo.setVendorStatus(tenantA, 'v-1', 'INACTIVE');
    await repo.voidBill(tenantA, 'b-1', 'actor', 'duplicate');
    await repo.transitionPayment(tenantA, 'p-1', 'APPROVED', 'actor');

    const updates = calls.filter((c) => c.op === 'update');
    expect(updates.length).toBe(3);
    for (const call of updates) {
      const columns = call.filters.map(([c]) => c);
      // `id` alone would update another tenant's row the moment an identifier leaked.
      expect(columns, `${call.table} update`).toContain('tenant_id');
      expect(columns, `${call.table} update`).toContain('id');
    }
  });

  it('refuses to build any query without a tenant', async () => {
    const { client } = recorder();
    const repo = new SupabaseFinanceRepository(client);
    const noTenant = { tenantId: '', userId: 'u', role: 'ADMIN' as const };
    await expect(repo.listBills(noTenant as never)).rejects.toThrow();
    await expect(repo.getPayment(noTenant as never, 'p-1')).rejects.toThrow();
  });

  it('keeps the rules out of SQL, where no test could reach them', () => {
    const sql = read('supabase/migrations/0006_finance_foundation.sql');
    const flattened = sql.replace(/\s+/g, ' ');
    // Defence in depth is welcome; a workflow expressed only in SQL is not, because
    // nothing in this project executes it.
    expect(sql).not.toMatch(/create (or replace )?function/i);
    expect(sql).not.toMatch(/create trigger/i);
    // Deny by default, exactly as tenants and tenant_workbooks are.
    for (const table of ['finance_vendors', 'finance_bills', 'finance_receivables', 'finance_payments', 'finance_periods']) {
      // The SQL is column-aligned, so compare with runs of whitespace collapsed.
      expect(flattened).toContain(`alter table ${table} enable row level security`);
      expect(flattened).toContain(`revoke all on ${table} from authenticated, anon`);
    }
  });

  it('states the amended scope rule where a reader will find it', () => {
    const sql = read('supabase/migrations/0006_finance_foundation.sql');
    // 0001 declared "this database holds NO business data". This is the migration that
    // breaks it, and a rule broken silently is how architecture decays.
    expect(sql).toMatch(/SCOPE RULE IS AMENDED HERE/);
    expect(sql).toMatch(/finance_expenses|does not create/i);
  });
});

/* ================================================================== *
 * 12 · GOVERNANCE
 * ================================================================== */

describe('finance · route governance', () => {
  it('satisfies the write-governance contract for the whole registry', () => {
    assertWriteGovernance(API_ROUTES, (condition, message) => {
      expect(condition, message).toBe(true);
    });
  });

  it('declares every finance write, and none of them as a workbook mutation', () => {
    const finance = API_ROUTES.filter((r) => r.path.startsWith('/api/finance/'));
    for (const route of finance.filter((r) => r.method !== 'GET')) {
      expect(route.writesFinance, `${route.path} must declare writesFinance`).toBe(true);
      // A finance route has no sheet, no ID_RULES entry and no calc columns, so declaring
      // it a workbook mutation would put a false statement in the registry.
      expect(route.mutates, route.path).toBeUndefined();
      expect(route.nonMutating, route.path).toBeUndefined();
    }
  });

  it('never lets a finance route be investor-scoped', () => {
    for (const route of API_ROUTES.filter((r) => r.path.startsWith('/api/finance/'))) {
      expect(route.investorScoped, route.path).toBeFalsy();
    }
  });

  it('holds no money arithmetic in the handler layer', () => {
    // Money is added in one module. A handler that did arithmetic would be a second
    // place for a rounding rule to live.
    const handlers = codeOf(read('lib/server/api/finance-handlers.ts'));
    expect(handlers).not.toMatch(/amountMinor\s*[*/+-]\s/);
    expect(handlers).not.toMatch(/\*\s*100|\/\s*100/);
  });
});
