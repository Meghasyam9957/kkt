import '@/lib/server/only';
/**
 * FORECASTING — deterministic, no AI. The port of ARCHITECTURE §9.
 *
 * §9 fixes the methods; this module implements the first two horizons:
 *
 *   Occupancy  booking-on-hand (confirmed future nights) + rolling 3-month average of
 *              the residual pickup.                              Minimum: 2 complete months
 *   Revenue    forecast occupied nights × trailing ADR.          Minimum: 2 complete months
 *
 * Cash flow and seasonality are deliberately absent: cash flow needs the per-platform
 * payout lag from Settings, and seasonality is not applied below 12 months of history.
 * §9 orders these "in order of preference as history accumulates", so a horizon that
 * cannot yet be computed honestly is not computed at all.
 *
 * Every rule §9 states is enforced here rather than in the caller:
 *   - below the threshold the result is INSUFFICIENT_DATA and `value` is null — never a
 *     number, and never a zero standing in for "we don't know";
 *   - every estimate carries its method, its inputs and the month count behind it;
 *   - confidence is derived from stated inputs, not chosen.
 *
 * PURITY. No React, no network, no workbook, no environment, and no wall clock: the
 * as-of date arrives as an argument. The same inputs always produce the same output,
 * which is what makes a forecast auditable — and what stops this module joining the
 * class of probabilistic defects this codebase has already paid for once.
 */
import { monthPeriod, occupiedNights, type Period } from './kpi';
import type { MonthlyMetrics, ReservationRecord } from '@/lib/shared/domain';
import type { Serial } from '@/lib/shared/dates';

/** §9: "Below the threshold → render INSUFFICIENT DATA, never a number." */
export type ForecastStatus = 'SUFFICIENT' | 'INSUFFICIENT_DATA';

/** §9: "Confidence: HIGH / MEDIUM / LOW … a stated rule, not a vibe." */
export type ForecastConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type ForecastHorizon = 'occupancy' | 'revenue';

/**
 * Minimum complete, usable months before a horizon may be estimated. §9 states 2 for
 * occupancy, revenue and cash flow; §11 repeats it ("Requires ≥2 months of real data to
 * be meaningful"). Not configurable — a threshold a deployment could lower is not a
 * threshold.
 */
export const MINIMUM_USABLE_MONTHS = 2;

/** §9 applies a month-of-year index only at 12+ months. Used by the confidence rule as
 *  the boundary between "limited history" and "a full year behind the estimate". */
export const FULL_HISTORY_MONTHS = 12;

/** §9: the rolling window for residual pickup. */
export const PICKUP_WINDOW_MONTHS = 3;

/** What the estimate was computed from — §9 requires the inputs to travel with it. */
export interface ForecastInputs {
  /** Complete months with trading activity behind the estimate. */
  usableMonths: number;
  /** Months actually averaged (≤ PICKUP_WINDOW_MONTHS). */
  trailingMonthsUsed: number;
  /** Confirmed nights already on the books for the target month. */
  bookingOnHandNights: number;
  /** Nights expected on top of the books, from the rolling average. Never negative. */
  residualPickupNights: number;
  /** Share of the estimate already secured by confirmed bookings, 0..1. */
  bookingOnHandCoverage: number;
  /** Sellable nights in the target month (days × active units). */
  availableNights: number;
  /** Trailing ADR used by the revenue horizon; null for the occupancy horizon. */
  trailingAdr: number | null;
}

export interface ForecastEstimate {
  horizon: ForecastHorizon;
  monthKey: string;
  status: ForecastStatus;
  /** §9: "Every forecast is labelled ESTIMATE". Constant by design. */
  label: 'ESTIMATE';
  method: string;
  /** null whenever status is INSUFFICIENT_DATA. Never 0 as a stand-in. */
  value: number | null;
  unit: 'nights' | 'ratio' | 'currency';
  /** Occupancy also reports the implied ratio; null when insufficient. */
  occupancyPct: number | null;
  confidence: ForecastConfidence | null;
  inputs: ForecastInputs;
  /** Human-readable, present only when INSUFFICIENT_DATA. */
  reason: string | null;
}

/** §9: "Forecast vs actual is retained each month so accuracy becomes visible." */
export interface ForecastAccuracy {
  monthKey: string;
  horizon: ForecastHorizon;
  forecast: number;
  actual: number;
  /** actual − forecast. Positive means the month beat the estimate. */
  variance: number;
  /** variance ÷ forecast, or null when the forecast was zero. */
  variancePct: number | null;
}

const safeDiv = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

/** Sellable nights in a month: its length × the units on sale. */
const availableNightsIn = (p: Period, activeUnits: number): number =>
  (p.end - p.start) * activeUnits;

/**
 * Months that may be reasoned from.
 *
 * "Complete" is decided against the as-of date, not the calendar: a month still being
 * traded is not history. "Usable" reuses the predicate the Performance screen already
 * applies — a month with trading activity — so the two screens agree on what counts.
 * The demonstration year deliberately contains months that fail this (August dormant,
 * March not yet traded), and they are excluded rather than averaged in as zeros.
 */
export function usableHistory(series: readonly MonthlyMetrics[], asOf: Serial): MonthlyMetrics[] {
  return series.filter((m) =>
    m.monthEnd <= asOf && (m.grossRevenue > 0 || m.operatingExpenses > 0));
}

/**
 * §9's confidence rule, expressed only in numbers §9 itself states.
 *
 *   history length         2 (the minimum) and 12 (the point §9 trusts a full year)
 *   booking-on-hand cover  the share of the estimate already confirmed, 0..1
 *
 * §9 names a third input, variance, but states no boundary for it. Rather than invent a
 * coefficient nobody approved, variance is deliberately not consulted, and that omission
 * is reported rather than hidden. Adding it is a business decision, not a code change.
 *
 *   HIGH    a full year of history AND the month already fully on the books
 *   LOW     limited history AND the month not yet on the books
 *   MEDIUM  everything between
 */
export function classifyConfidence(
  usableMonths: number,
  bookingOnHandCoverage: number,
): ForecastConfidence {
  const fullHistory = usableMonths >= FULL_HISTORY_MONTHS;
  const fullyOnHand = bookingOnHandCoverage >= 1;
  if (fullHistory && fullyOnHand) return 'HIGH';
  if (!fullHistory && !fullyOnHand) return 'LOW';
  return 'MEDIUM';
}

function insufficient(
  horizon: ForecastHorizon,
  monthKey: string,
  method: string,
  unit: ForecastEstimate['unit'],
  usableMonths: number,
  availableNights: number,
): ForecastEstimate {
  return {
    horizon,
    monthKey,
    status: 'INSUFFICIENT_DATA',
    label: 'ESTIMATE',
    method,
    value: null,
    unit,
    occupancyPct: null,
    confidence: null,
    inputs: {
      usableMonths,
      trailingMonthsUsed: 0,
      bookingOnHandNights: 0,
      residualPickupNights: 0,
      bookingOnHandCoverage: 0,
      availableNights,
      trailingAdr: null,
    },
    reason:
      `${usableMonths} complete month${usableMonths === 1 ? '' : 's'} of trading history; ` +
      `${MINIMUM_USABLE_MONTHS} are required before this can be estimated.`,
  };
}

export interface OccupancyForecastRequest {
  /** The full monthly series, oldest first. */
  series: readonly MonthlyMetrics[];
  /** Every reservation; confirmed nights in the target month are the booking-on-hand. */
  reservations: readonly ReservationRecord[];
  /** The month being forecast, e.g. '2027-03'. */
  monthKey: string;
  /** Everything on or before this is history. Passed in — never read from the clock. */
  asOf: Serial;
  /** Units on sale, from `activeUnitCount`. */
  activeUnits: number;
}

/**
 * §9 occupancy: booking-on-hand + rolling 3-month average of the residual pickup.
 *
 * Booking-on-hand is read straight from the reservations that already exist — §9 calls
 * this "a genuine strength here: near-term occupancy is substantially known, not
 * predicted", and it is why this is not a trailing average.
 *
 * The residual pickup is the gap between what is on the books and the level the last
 * three usable months actually reached; it is never negative, so a month already booked
 * beyond its recent norm is reported at its real on-hand figure rather than dragged back
 * to the average. The workbook retains no historical on-hand snapshots, so the recent
 * actual level is the only honest basis available for that gap.
 */
export function forecastOccupancy(request: OccupancyForecastRequest): ForecastEstimate {
  const { series, reservations, monthKey, asOf, activeUnits } = request;
  const period = monthPeriod(monthKey);
  const availableNights = availableNightsIn(period, activeUnits);
  const method =
    'Booking-on-hand (confirmed nights) plus the rolling 3-month average residual pickup';

  const history = usableHistory(series, asOf);
  if (history.length < MINIMUM_USABLE_MONTHS) {
    return insufficient('occupancy', monthKey, method, 'nights', history.length, availableNights);
  }

  // Nights already confirmed for the target month. `occupiedNights` counts exactly the
  // occupancy statuses the rest of the engine counts, so on-hand and actuals are the
  // same measurement taken at different times.
  const bookingOnHandNights = occupiedNights([...reservations], period);

  const window = history.slice(-PICKUP_WINDOW_MONTHS);
  const trailingAverageNights = safeDiv(
    window.reduce((sum, m) => sum + m.occupiedNights, 0),
    window.length,
  );

  const residualPickupNights = Math.max(0, trailingAverageNights - bookingOnHandNights);
  // Never sell more nights than exist.
  const forecastNights = Math.min(
    availableNights,
    bookingOnHandNights + residualPickupNights,
  );
  const bookingOnHandCoverage = Math.min(1, safeDiv(bookingOnHandNights, forecastNights));

  return {
    horizon: 'occupancy',
    monthKey,
    status: 'SUFFICIENT',
    label: 'ESTIMATE',
    method,
    value: forecastNights,
    unit: 'nights',
    occupancyPct: safeDiv(forecastNights, availableNights),
    confidence: classifyConfidence(history.length, bookingOnHandCoverage),
    inputs: {
      usableMonths: history.length,
      trailingMonthsUsed: window.length,
      bookingOnHandNights,
      residualPickupNights,
      bookingOnHandCoverage,
      availableNights,
      trailingAdr: null,
    },
    reason: null,
  };
}

/**
 * §9 revenue: forecast occupied nights × trailing ADR.
 *
 * The nights come from the occupancy horizon rather than being recomputed, so the two
 * estimates can never disagree. ADR is the engine's own per-month ADR (room revenue ÷
 * occupied nights) averaged over the same rolling window — the arithmetic is not
 * duplicated here.
 *
 * §9 specifies ADR "(property-level)". This milestone averages at portfolio level and
 * says so in `method`; per-property ADR is a refinement, not a different rule.
 */
export function forecastRevenue(
  request: OccupancyForecastRequest,
  occupancy: ForecastEstimate = forecastOccupancy(request),
): ForecastEstimate {
  const { series, monthKey, asOf } = request;
  const method = 'Forecast occupied nights × trailing ADR (portfolio)';
  const history = usableHistory(series, asOf);

  if (occupancy.status === 'INSUFFICIENT_DATA' || occupancy.value === null) {
    return insufficient(
      'revenue', monthKey, method, 'currency', history.length, occupancy.inputs.availableNights,
    );
  }

  const window = history.slice(-PICKUP_WINDOW_MONTHS);
  // Mean of the months' own ADRs. Months that sold nothing carry ADR 0 and would drag a
  // plain mean down, so only months that actually sold a night contribute a rate.
  const rated = window.filter((m) => m.occupiedNights > 0);
  const trailingAdr = safeDiv(rated.reduce((sum, m) => sum + m.adr, 0), rated.length);

  return {
    horizon: 'revenue',
    monthKey,
    status: 'SUFFICIENT',
    label: 'ESTIMATE',
    method,
    value: occupancy.value * trailingAdr,
    unit: 'currency',
    occupancyPct: occupancy.occupancyPct,
    confidence: occupancy.confidence,
    inputs: { ...occupancy.inputs, trailingMonthsUsed: rated.length, trailingAdr },
    reason: null,
  };
}

/**
 * §9: forecast vs actual, retained monthly.
 *
 * Compares an estimate against the month it was made for, once that month is complete
 * and usable. Returns null while the month is still running — an accuracy figure for a
 * half-finished month would flatter or damn the estimate for no reason.
 */
export function forecastVsActual(
  estimate: ForecastEstimate,
  series: readonly MonthlyMetrics[],
  asOf: Serial,
): ForecastAccuracy | null {
  if (estimate.status !== 'SUFFICIENT' || estimate.value === null) return null;

  const actualMonth = usableHistory(series, asOf).find((m) => m.monthKey === estimate.monthKey);
  if (!actualMonth) return null;

  const actual = estimate.horizon === 'occupancy'
    ? actualMonth.occupiedNights
    : actualMonth.roomRevenue;
  const variance = actual - estimate.value;

  return {
    monthKey: estimate.monthKey,
    horizon: estimate.horizon,
    forecast: estimate.value,
    actual,
    variance,
    variancePct: estimate.value === 0 ? null : variance / estimate.value,
  };
}
