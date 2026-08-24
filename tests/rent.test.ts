/**
 * 08_RENT_FIXED_COSTS — the obligation engine.
 *
 * Ported from V1's `build_08_RENT` formulas. Every branch is exercised here because the
 * demonstration data only ever hits "Paid ✓": without these, the OVERDUE path — the one
 * that feeds Pending Payables — would ship unverified until a live workbook happened to
 * contain a late payment.
 *
 * LIVE parity compares this port against the workbook's own NextDueDate and
 * PaymentStatus columns, row by row. These tests fix the intent; that comparison proves
 * the port agrees with Google.
 */
import { describe, it, expect } from 'vitest';
import { computeRentSchedule, type RentScheduleInput } from '@/lib/server/analytics/rent';
import {
  pendingPayables, pendingInvestorDistributions, computeInvestorAllocations,
} from '@/lib/server/analytics/kpi';
import { isoToSerial } from '@/lib/shared/dates';
import { baseline } from './fixtures/scenarios';
import type { RentRecord } from '@/lib/shared/domain';

const TODAY = isoToSerial('2026-06-15');
const DUE_DAYS = 3;

function record(overrides: Partial<RentScheduleInput> = {}): RentScheduleInput {
  return {
    recordId: 'RNT-001',
    dueDay: 5,
    agreementStart: '2026-01-01',
    agreementEnd: '',
    lastPaidDate: null,
    paidForMonth: null,
    ...overrides,
  };
}
const run = (o: Partial<RentScheduleInput> = {}, today = TODAY) =>
  computeRentSchedule(record(o), today, DUE_DAYS);

describe('rent · which month a payment covers', () => {
  it('uses PaidForMonth, not the date the transfer happened', () => {
    // July's rent paid on 3 August covers July. Reading the transfer date instead would
    // look like August's rent and silently skip a month.
    const { nextDueDate } = run({ lastPaidDate: '2026-08-03', paidForMonth: '2026-07-01' });
    expect(nextDueDate).toBe('2026-08-05');
  });

  it('falls back to the month of LastPaidDate when PaidForMonth is blank', () => {
    expect(run({ lastPaidDate: '2026-05-05' }).nextDueDate).toBe('2026-06-05');
  });

  it('rolls December into January of the next year', () => {
    expect(run({ paidForMonth: '2026-12-01' }).nextDueDate).toBe('2027-01-05');
  });

  it('clamps a due day past the 28th so February can never be invalid', () => {
    expect(run({ dueDay: 31, paidForMonth: '2026-01-01' }).nextDueDate).toBe('2026-02-28');
  });
});

describe('rent · payment status', () => {
  it('is Paid ✓ when the covered month is the current month', () => {
    expect(run({ paidForMonth: '2026-06-01' }).paymentStatus).toBe('Paid ✓');
  });

  it('is Paid ✓ when rent is prepaid for a later month', () => {
    expect(run({ paidForMonth: '2026-09-01' }).paymentStatus).toBe('Paid ✓');
  });

  it('is OVERDUE once the next due date has passed', () => {
    // Paid for April, so May's payment was due on 5 May and today is 15 June.
    const { nextDueDate, paymentStatus } = run({ paidForMonth: '2026-04-01' });
    expect(nextDueDate).toBe('2026-05-05');
    expect(paymentStatus).toBe('OVERDUE');
  });

  it('is Due soon inside the configured window, and Upcoming outside it', () => {
    // Paid for May → next due 5 June. Two days out, then four.
    expect(run({ paidForMonth: '2026-05-01' }, isoToSerial('2026-06-03')).paymentStatus)
      .toBe('Due soon');
    expect(run({ paidForMonth: '2026-05-01' }, isoToSerial('2026-06-01')).paymentStatus)
      .toBe('Upcoming');
  });

  it('counts the window inclusively — exactly three days out is still Due soon', () => {
    expect(run({ paidForMonth: '2026-05-01' }, isoToSerial('2026-06-02')).paymentStatus)
      .toBe('Due soon');
  });

  it('being paid for the current month outranks the due window', () => {
    // Still May, and May is covered — the June due date is irrelevant until June.
    expect(run({ paidForMonth: '2026-05-01' }, isoToSerial('2026-05-26')).paymentStatus)
      .toBe('Paid ✓');
  });

  it('is Ended once the agreement is over, whatever the payment history', () => {
    expect(run({ agreementEnd: '2026-03-31', paidForMonth: '2026-01-01' }))
      .toEqual({ nextDueDate: null, paymentStatus: 'Ended' });
  });

  it('does not end an agreement whose end date is still in the future', () => {
    expect(run({ agreementEnd: '2027-01-01', paidForMonth: '2026-06-01' }).paymentStatus)
      .toBe('Paid ✓');
  });
});

describe('rent · never paid yet', () => {
  it('falls due this month once the agreement has started', () => {
    expect(run().nextDueDate).toBe('2026-06-05');
    expect(run().paymentStatus).toBe('OVERDUE');   // the 5th has passed
  });

  it('never falls due before the agreement starts', () => {
    const future = run({ agreementStart: '2026-11-01' });
    expect(future.nextDueDate).toBe('2026-11-05');
    expect(future.paymentStatus).toBe('Upcoming');
  });

  it('uses this month when there is no agreement start either', () => {
    expect(run({ agreementStart: '' }).nextDueDate).toBe('2026-06-05');
  });
});

describe('rent · rows that are not data', () => {
  it('returns nothing for a blank record id — a spare template row', () => {
    expect(run({ recordId: '' })).toEqual({ nextDueDate: null, paymentStatus: '' });
    expect(run({ recordId: '   ' })).toEqual({ nextDueDate: null, paymentStatus: '' });
  });

  it('returns nothing when no due day is recorded', () => {
    expect(run({ dueDay: 0 })).toEqual({ nextDueDate: null, paymentStatus: '' });
  });
});

describe('pending payables · all three components, as 99_CALC has it', () => {
  const rent = (paymentStatus: string, monthlyAmount: number): RentRecord => ({
    recordId: `RNT-${monthlyAmount}`, propertyId: 'HYD-501', costType: 'Rent',
    landlordVendor: 'Test Landlord', monthlyAmount, dueDay: 5,
    agreementStart: '2026-01-01', agreementEnd: '', escalationPct: 0,
    lastPaidDate: null, paidForMonth: null, nextDueDate: null, paymentStatus, notes: '',
  });

  it('counts unpaid and part-paid expenses', () => {
    const { data } = baseline();
    const expected = data.expenses
      .filter((e) => e.PaymentStatus === 'Pending' || e.PaymentStatus === 'Partial')
      .reduce((s, e) => s + e.Amount + e.Tax, 0);
    expect(pendingPayables(data)).toBeCloseTo(expected, 6);
  });

  it('adds rent that is OVERDUE, and only rent that is OVERDUE', () => {
    const { data } = baseline();
    const base = pendingPayables(data);
    const register = [
      rent('OVERDUE', 26_000),
      rent('Paid ✓', 18_000),
      rent('Due soon', 27_000),
      rent('Upcoming', 18_000),
      rent('Ended', 40_000),
    ];
    expect(pendingPayables(data, register)).toBeCloseTo(base + 26_000, 6);
  });

  it('adds investor distributions that are calculated but unpaid', () => {
    const { data } = baseline();
    const withPending = {
      ...data,
      distributions: [
        { Period: isoToSerial('2026-04-01'), InvestorID: 'INV-001', PaidAmount: 1000, PaidDate: null, PendingAmount: 4200 },
        { Period: isoToSerial('2026-04-01'), InvestorID: 'INV-002', PaidAmount: 3000, PaidDate: null, PendingAmount: 0 },
      ],
    };
    expect(pendingInvestorDistributions(withPending)).toBe(4200);
    expect(pendingPayables(withPending)).toBeCloseTo(pendingPayables(data) + 4200, 6);
  });

  it('never counts an overpayment as a negative payable', () => {
    const { data } = baseline();
    const overpaid = {
      ...data,
      distributions: [{
        Period: isoToSerial('2026-04-01'), InvestorID: 'INV-001',
        PaidAmount: 9999, PaidDate: null, PendingAmount: -500,
      }],
    };
    expect(pendingInvestorDistributions(overpaid)).toBe(0);
  });

  /**
   * DECISION REQUIRED — recorded, not resolved.
   *
   * Two definitions of "pending investor distributions" are live at once:
   *   · 99_CALC Q22 sums the register's PendingAmount column, across every period. That is
   *     the definition `pendingInvestorDistributions()` ports, and the one that feeds
   *     Pending Payables — because it is what the workbook computes.
   *   · the dashboard KPI sums unpaid ALLOCATIONS for the reporting month, which counts a
   *     period that has no register row yet.
   *
   * Which one the business means changes what Pending Payables says it owes. It is a
   * management call, so this test pins the current behaviour rather than picking a side —
   * if either definition moves, it fails and the question gets asked again.
   */
  it('counts only register rows, not allocations for a period with no row yet', () => {
    const { data } = baseline();
    const noRegisterRows = { ...data, distributions: [] };
    expect(pendingInvestorDistributions(noRegisterRows)).toBe(0);

    const allocationsExist = computeInvestorAllocations(noRegisterRows, '2026-04')
      .reduce((total, a) => total + a.pendingAmount, 0);
    expect(allocationsExist).toBeGreaterThan(0);   // …yet payables counts none of it
    expect(pendingPayables(noRegisterRows)).toBe(pendingPayables({ ...data, distributions: [] }));
  });

  it('defaults to no rent register rather than silently inventing one', () => {
    const { data } = baseline();
    expect(pendingPayables(data)).toBe(pendingPayables(data, []));
  });
});
