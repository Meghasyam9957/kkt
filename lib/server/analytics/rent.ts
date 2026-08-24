import '@/lib/server/only';
/**
 * 08_RENT_FIXED_COSTS — port of V1's two calculated columns.
 *
 * The rent register is not a P&L source: rent reaches the P&L through 06_EXPENSES as
 * `Fixed Operating / Rent` rows. What the register owns is the *obligation* view — when
 * the next payment is due, and whether it is late. V1's `PendingPayables` KPI counts
 * OVERDUE rent, so without this port the web application understates what the business
 * owes.
 *
 * Ported field-for-field from `homestay-ops/src/06_money_out.gs` `build_08_RENT`. The
 * comments below quote the rules that formula encodes, because they are business rules
 * and not obvious from the arithmetic.
 */
import {
  serialToIso, isoToSerial, ymdToSerial, serialParts, monthStart, type Serial,
} from '@/lib/shared/dates';

export interface RentScheduleInput {
  recordId: string;
  dueDay: number;
  agreementStart: string;
  agreementEnd: string;
  lastPaidDate: string | null;
  /** The month the payment COVERS, not the month it was made in. */
  paidForMonth: string | null;
}

export interface RentSchedule {
  nextDueDate: string | null;
  paymentStatus: '' | 'Ended' | 'Paid ✓' | 'OVERDUE' | 'Due soon' | 'Upcoming';
}

/** V1 clamps the due day to 28 so February can never produce an invalid date. */
const clampDueDay = (dueDay: number): number => (dueDay > 28 ? 28 : dueDay);

const serialOrNull = (iso: string | null | undefined): Serial | null =>
  iso ? isoToSerial(iso) : null;

/**
 * The month a payment covers: `PaidForMonth` when given, else the month of
 * `LastPaidDate`. July's rent paid on 3 August must be recorded as covering 01-Jul, or it
 * would look like August's rent and silently skip a month.
 */
function coveredMonth(input: RentScheduleInput, today: Serial): Serial {
  const paidFor = serialOrNull(input.paidForMonth);
  if (paidFor !== null) return paidFor;
  const lastPaid = serialOrNull(input.lastPaidDate);
  if (lastPaid !== null) return lastPaid;
  return today;   // guarded below: the fallback never counts as a payment
}

export function computeRentSchedule(
  input: RentScheduleInput,
  today: Serial,
  rentDueDays: number,
): RentSchedule {
  if (input.recordId.trim() === '') return { nextDueDate: null, paymentStatus: '' };
  if (!input.dueDay) return { nextDueDate: null, paymentStatus: '' };

  const agreementEnd = serialOrNull(input.agreementEnd);
  const agreementOver = agreementEnd !== null && agreementEnd < today;
  if (agreementOver) return { nextDueDate: null, paymentStatus: 'Ended' };

  const day = clampDueDay(input.dueDay);
  const nowParts = serialParts(today);
  const dueThisMonth = ymdToSerial(nowParts.year, nowParts.month, day);

  const lastPaid = serialOrNull(input.lastPaidDate);
  const paidFor = serialOrNull(input.paidForMonth);
  const hasPayment = lastPaid !== null || paidFor !== null;

  let nextDue: Serial;
  if (hasPayment) {
    // The month after the last COVERED month.
    const covered = serialParts(coveredMonth(input, today));
    nextDue = ymdToSerial(covered.year, covered.month + 1, day);
  } else {
    const agreementStart = serialOrNull(input.agreementStart);
    if (agreementStart === null) {
      nextDue = dueThisMonth;
    } else {
      // Never paid yet: this month's due date, but never before the agreement starts.
      const startParts = serialParts(agreementStart);
      const dueAtStart = ymdToSerial(startParts.year, startParts.month, day);
      nextDue = dueThisMonth > dueAtStart ? dueThisMonth : dueAtStart;
    }
  }

  // Paid up when the covered month is the current month OR LATER — prepayment counts.
  const paidCurrent = hasPayment
    && monthStart(coveredMonth(input, today)) >= monthStart(today);

  const paymentStatus: RentSchedule['paymentStatus'] = paidCurrent
    ? 'Paid ✓'
    : nextDue < today
      ? 'OVERDUE'
      : nextDue - today <= rentDueDays
        ? 'Due soon'
        : 'Upcoming';

  return { nextDueDate: serialToIso(nextDue), paymentStatus };
}
