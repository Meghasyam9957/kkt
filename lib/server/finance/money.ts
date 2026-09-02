import '@/lib/server/only';
/**
 * MONEY — one representation, one boundary, no floats.
 *
 * The workbook stores rupees as spreadsheet numbers, which are IEEE-754 doubles. That is
 * correct for a spreadsheet, where a human reads the cell and the workbook's own formulas
 * own the arithmetic. It is not correct for a payables ledger, where the question "is this
 * bill settled?" is answered by comparing two sums, and where `0.1 + 0.2 !== 0.3` is the
 * difference between a closed bill and a bill outstanding by a fraction of a paisa.
 *
 * So the finance domain stores INTEGER MINOR UNITS — paise — and never anything else.
 * Addition, subtraction and comparison are exact integer operations. Nothing in this
 * domain performs division of money without an explicitly named rounding rule, and there
 * is no such rule yet because there is no requirement that needs one (allocation across
 * properties is deferred; see docs/MDATA1_FINANCE_ARCHITECTURE.md).
 *
 * The hazard this module exists to close is the one the brief names exactly: ₹100, 100,
 * 100.00 and 10000 paise appearing in the same system without a boundary between them.
 * Here is that boundary. Rupees exist on ONE side of it — parsing operator input, and
 * comparing against a workbook figure — and paise on the other. A `Paise` value is branded
 * so a plain number cannot be passed where money is expected, and the compiler refuses the
 * mistake rather than a reviewer catching it.
 *
 * Safe range: paise are held in a JavaScript number, exact to 2^53. That is ₹90,071,992,547,409
 * — ninety thousand crore — which is beyond any figure this product will hold, and is
 * checked rather than assumed (`assertSafe`). Postgres stores the same value as `bigint`.
 */

/** An exact amount of money in minor units. Branded: a bare number is not money. */
export type Paise = number & { readonly __brand: 'Paise' };

/**
 * ISO-4217 currency. INR today, and the column exists so that stays a fact about the
 * data rather than an assumption in the code — an amount without a currency is a number,
 * not money.
 */
export type CurrencyCode = 'INR';
export const DEFAULT_CURRENCY: CurrencyCode = 'INR';

export interface Money {
  readonly amount: Paise;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  readonly httpStatus = 422;
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Beyond this, integer arithmetic stops being exact and the guarantee is gone. */
const MAX_PAISE = Number.MAX_SAFE_INTEGER;

function assertSafe(value: number, where: string): void {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${where}: not a finite amount. Refusing to store a non-number as money.`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `${where}: ${value} is not a whole number of paise. Money is stored in minor units; `
      + 'a fractional paisa means a conversion happened somewhere it should not have.',
    );
  }
  if (Math.abs(value) > MAX_PAISE) {
    throw new MoneyError(
      `${where}: ${value} paise exceeds the exact-integer range. Beyond this, addition `
      + 'silently loses precision, so it is refused rather than stored.',
    );
  }
}

/** Build money from minor units — the normal path, since that is how it is stored. */
export function paise(value: number, where = 'paise'): Paise {
  assertSafe(value, where);
  return value as Paise;
}

export const ZERO: Paise = 0 as Paise;

export function money(amount: number, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  return Object.freeze({ amount: paise(amount, 'money'), currency });
}

/* ------------------------------------------------------------------ *
 * The rupee boundary
 *
 * Two functions, and they are the ONLY two places rupees and paise meet. Everything else
 * in the finance domain works in paise and never sees a rupee.
 * ------------------------------------------------------------------ */

/**
 * Operator input, or a workbook figure, in rupees → exact paise.
 *
 * `Math.round` is correct here and is not a fudge: the input is a decimal rupee amount
 * with at most two places, and floating-point representation of e.g. 1234.56 is
 * 123455.99999999999 paise. Rounding to the nearest paisa recovers the number the person
 * typed. An input with MORE than two decimal places is refused rather than rounded — a
 * third decimal place means the caller believes in a precision this system does not have.
 */
export function rupeesToPaise(rupees: number, where = 'rupeesToPaise'): Paise {
  if (!Number.isFinite(rupees)) {
    throw new MoneyError(`${where}: ${rupees} is not a finite rupee amount.`);
  }
  const scaled = rupees * 100;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new MoneyError(
      `${where}: ₹${rupees} has more precision than a paisa. Money is recorded to two `
      + 'decimal places; a third would be silently discarded, so it is refused instead.',
    );
  }
  return paise(Math.round(scaled), where);
}

/**
 * Paise → rupees, for display and for comparison against a workbook figure.
 *
 * The result is a float, so it must not be added to anything or stored. It exists to be
 * formatted (`formatCurrency`) or compared with a tolerance. Naming it `…ForDisplay`
 * rather than `toRupees` is deliberate: the name is the warning.
 */
export function paiseToRupeesForDisplay(value: Paise): number {
  return value / 100;
}

/* ------------------------------------------------------------------ *
 * Exact arithmetic
 *
 * Every operation is integer, and every one is range-checked, so an overflow surfaces as
 * a refusal at the point it happens rather than as a wrong balance later.
 * ------------------------------------------------------------------ */

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b, 'addPaise');
}

export function subtractPaise(a: Paise, b: Paise): Paise {
  return paise(a - b, 'subtractPaise');
}

export function sumPaise(values: readonly Paise[]): Paise {
  let total = 0;
  for (const value of values) total += value;
  return paise(total, 'sumPaise');
}

/** Negative amounts are legitimate (a credit note, a reversal); zero is not "missing". */
export function isNegative(value: Paise): boolean { return value < 0; }
export function isZero(value: Paise): boolean { return value === 0; }

/**
 * Two amounts are comparable only in the same currency.
 *
 * With one currency configured this can never fail today. It is written anyway, because
 * the day a second currency exists the alternative is a silent addition of rupees to
 * something else, and that failure would be invisible in the total.
 */
export function assertSameCurrency(a: Money, b: Money, where: string): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `${where}: cannot combine ${a.currency} with ${b.currency}. `
      + 'Amounts in different currencies are not addable without a rate, and no rate '
      + 'source is configured.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * The database boundary
 * ------------------------------------------------------------------ */

/**
 * A `bigint` column arrives from postgres-js as a string (values may exceed 2^53 in
 * general, so the driver will not narrow them for us). Parsed here, and range-checked, so
 * a row that somehow holds an unsafe value is refused rather than read as a wrong number.
 */
export function paiseFromDatabase(value: unknown, where: string): Paise {
  if (typeof value === 'number') return paise(value, where);
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new MoneyError(`${where}: stored amount ${value} is outside the exact range.`);
    }
    return paise(asNumber, where);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return paise(Number(value.trim()), where);
  }
  throw new MoneyError(
    `${where}: expected minor units, received ${typeof value}. A money column that is not `
    + 'an integer has been written by something that does not go through this module.',
  );
}
