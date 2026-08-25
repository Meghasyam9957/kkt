import '@/lib/server/only';
/**
 * FORECASTING — deterministic, no AI. The port of ARCHITECTURE §9.
 *
 * §9 fixes the methods; this module implements three of its four horizons:
 *
 *   Occupancy  booking-on-hand (confirmed future nights) + rolling 3-month average of
 *              the residual pickup.                              Minimum: 2 complete months
 *   Revenue    forecast occupied nights × trailing ADR
 *              (property-level).                                 Minimum: 2 complete months
 *   Cash flow  opening balance + expected payouts (per-platform lag from Settings)
 *              − scheduled rent/fixed costs
 *              − trailing variable-cost average.                 Minimum: 2 complete months
 *
 * Seasonality is deliberately absent. §9 applies a month-of-year index only at 12+ months
 * of history and states "otherwise not applied"; below that the estimates here are
 * month-of-year agnostic by construction, which is the documented behaviour and not an
 * omission. §9 orders these "in order of preference as history accumulates", so a method
 * that cannot yet be applied honestly is not applied at all.
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
import { OCCUPANCY_STATUSES } from '@/lib/shared/domain';
import type { MonthlyMetrics, ReservationRecord } from '@/lib/shared/domain';
import type { Serial } from '@/lib/shared/dates';

/** §9: "Below the threshold → render INSUFFICIENT DATA, never a number." */
export type ForecastStatus = 'SUFFICIENT' | 'INSUFFICIENT_DATA';

/** §9: "Confidence: HIGH / MEDIUM / LOW … a stated rule, not a vibe." */
export type ForecastConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * §9's confidence, and what could be evaluated of it.
 *
 * `level` is null while §9's rule cannot be applied in full — see `assessConfidence`. The
 * shape mirrors the `unavailable` idiom the KPI layer already uses for a business rule
 * management has not configured, so a screen renders this the same way it renders any
 * other figure it is not entitled to state.
 */
export interface ConfidenceAssessment {
  /** HIGH / MEDIUM / LOW, or null when the rule cannot be applied in full. */
  level: ForecastConfidence | null;
  /** Why no level is stated. Null only when one is. */
  unavailable: { reason: 'CONFIGURATION_REQUIRED' | 'INSUFFICIENT_DATA'; message: string } | null;
  /** §9 input 1 — complete usable months behind the estimate. */
  historyMonths: number;
  /** §9 input 2 — share of the estimate already confirmed, 0..1. */
  bookingOnHandCoverage: number;
  /** §9 input 3 — null while no boundary is configured, so it is never evaluated. */
  variance: number | null;
}

export type ForecastHorizon = 'occupancy' | 'revenue' | 'cashflow';

/**
 * Which set of bookings an estimate counted as its booking-on-hand.
 *
 *   current        the books as they stand — correct for a forecast of a future month
 *   reconstructed  the books as they stood at a past date, rebuilt from `BookingDate`
 *   unavailable    a past date whose books cannot be rebuilt, so NONE were counted
 *
 * The distinction is the whole difference between measuring §9's method and measuring a
 * degenerate version of it, so it travels with the estimate rather than being assumed.
 */
export type OnHandBasis = 'current' | 'reconstructed' | 'unavailable';

/**
 * Minimum complete, usable months before a horizon may be estimated. §9 states 2 for
 * occupancy, revenue and cash flow; §11 repeats it ("Requires ≥2 months of real data to
 * be meaningful"). Not configurable — a threshold a deployment could lower is not a
 * threshold.
 */
export const MINIMUM_USABLE_MONTHS = 2;

/**
 * §9 applies a month-of-year index only at 12+ months, and this is that boundary. It is
 * also the anchor §9's confidence rule would use for "a full year behind the estimate" —
 * see `assessConfidence`, which cannot state a level until the variance boundary exists.
 */
export const FULL_HISTORY_MONTHS = 12;

/** §9: the rolling window for residual pickup. */
export const PICKUP_WINDOW_MONTHS = 3;

/**
 * One unit's own trading, for one month — the shape `computeByProperty` already produces.
 *
 * §9 asks for a property-level ADR, and this is the only input that can supply one. The
 * portfolio series has already blended the units together; a blended rate cannot be taken
 * apart again afterwards, so the per-unit figures have to arrive intact.
 */
export interface PropertyMonthMetrics {
  propertyId: string;
  monthKey: string;
  /** Nights this unit sold that month. */
  occupiedNights: number;
  /** This unit's own room revenue ÷ occupied nights that month. */
  adr: number;
  /** Sellable nights for this unit that month — one unit, so the month's length. */
  availableNights: number;
}

/** How one unit contributed to the property-level rate, so the blend can be audited. */
export interface PropertyRateContribution {
  propertyId: string;
  /** Nights this unit is estimated to sell, by the same §9 method as the portfolio. */
  forecastNights: number;
  /** This unit's own trailing ADR. */
  trailingAdr: number;
  /** This unit's share of the estimated night mix, 0..1. */
  weight: number;
}

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
  /**
   * Which basis produced `trailingAdr`. §9 asks for property-level; 'portfolio' means no
   * per-unit history was supplied and the blended series rate stood in — reported rather
   * than hidden, because the two answer differently whenever the unit mix moves. Null on
   * the occupancy horizon, which uses no rate at all.
   */
  adrBasis: 'property' | 'portfolio' | null;
  /** The per-unit rates behind a property-level ADR. Empty on every other path. */
  propertyRates: PropertyRateContribution[];
  /** The cash-flow horizon's four §9 terms. Null on every other horizon. */
  cash: CashFlowInputs | null;
  /** Which books `bookingOnHandNights` was counted from. See `OnHandBasis`. */
  onHandBasis: OnHandBasis;
}

/**
 * §9's cash-flow terms, each from the register that owns it — kept separate from the
 * occupancy fields above because they are different quantities, and a reader who has to
 * work out which of them applies to the estimate in front of them will eventually get it
 * wrong.
 */
export interface CashFlowInputs {
  /** Cumulative net cash recorded before the month, the balance the ledger already shows. */
  openingBalance: number;
  /** Payouts expected to land in the month: check-out plus that platform's own lag. */
  expectedPayouts: number;
  /** Rent and fixed costs scheduled to fall due in the month, from the obligation register. */
  scheduledFixedCosts: number;
  /** Rolling 3-month average of variable operating spend. */
  trailingVariableCosts: number;
  /** Months that contributed to that average. */
  variableMonthsUsed: number;
  /** Projected movement: payouts less scheduled and averaged spend. Balance minus opening. */
  netMovement: number;
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
  confidence: ConfidenceAssessment;
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
  /**
   * Which books the re-estimate had. `unavailable` means it ran with no booking-on-hand
   * at all, so it measures the pickup basis alone and understates the real method — the
   * screen must say so rather than presenting the gap as the method's accuracy.
   */
  basis: OnHandBasis;
}

const safeDiv = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

/** Sellable nights in a month: its length × the units on sale. */
const availableNightsIn = (p: Period, activeUnits: number): number =>
  (p.end - p.start) * activeUnits;

interface NightsEstimate {
  bookingOnHandNights: number;
  residualPickupNights: number;
  forecastNights: number;
  trailingMonthsUsed: number;
  bookingOnHandCoverage: number;
}

/**
 * §9's occupancy arithmetic, in exactly one place: what is already on the books, plus the
 * shortfall against the level the recent months actually reached, capped at what is
 * sellable.
 *
 * The portfolio horizon and each unit's share of the property-level rate both run through
 * here, so a single unit is estimated by precisely the rule the portfolio is estimated by
 * — the alternative being two implementations of §9 that could quietly diverge.
 */
function estimateNights(
  windowNights: readonly number[],
  bookingOnHandNights: number,
  availableNights: number,
): NightsEstimate {
  const trailingAverageNights = safeDiv(
    windowNights.reduce((sum, n) => sum + n, 0),
    windowNights.length,
  );
  const residualPickupNights = Math.max(0, trailingAverageNights - bookingOnHandNights);
  // Never sell more nights than exist.
  const forecastNights = Math.min(availableNights, bookingOnHandNights + residualPickupNights);
  return {
    bookingOnHandNights,
    residualPickupNights,
    forecastNights,
    trailingMonthsUsed: windowNights.length,
    bookingOnHandCoverage: Math.min(1, safeDiv(bookingOnHandNights, forecastNights)),
  };
}

/**
 * Months that may be reasoned from.
 *
 * "Complete" is decided against the as-of date, not the calendar: a month still being
 * traded is not history. "Usable" reuses the predicate the Performance screen already
 * applies — a month with trading activity — so the two screens agree on what counts.
 * The demonstration year deliberately contains months that fail this (August dormant,
 * March not yet traded), and they are excluded rather than averaged in as zeros.
 */
/**
 * The books as they stood at a given date — or an honest refusal to guess.
 *
 * A forecast of a future month counts today's bookings, because those ARE its books. A
 * re-estimate of a month that has already happened must not: counting bookings taken
 * after the fact hands it the answer, and every past month then looks perfectly predicted.
 *
 * Reconstruction needs `BookingDate` on every booking that could matter. If even one is
 * missing, the set cannot be rebuilt — the missing one might be exactly the booking that
 * was on the books — so nothing is counted and the caller is told. A partial
 * reconstruction presented as a complete one is worse than none.
 *
 * One limit is worth stating plainly: this rebuilds which bookings EXISTED, not what
 * status each held at the time. `BookingStatus` records only today's state, so a booking
 * later cancelled is absent from a reconstruction that should have counted it. The
 * workbook does not version status, so this is a floor on the accuracy of any
 * reconstruction rather than something to be fixed here.
 */
export function booksAsAt(
  reservations: readonly ReservationRecord[],
  asAt: Serial | undefined,
): { bookings: readonly ReservationRecord[]; basis: OnHandBasis } {
  if (asAt === undefined) return { bookings: reservations, basis: 'current' };

  const couldCount = reservations.filter((b) =>
    (OCCUPANCY_STATUSES as readonly string[]).includes(b.BookingStatus));
  if (couldCount.some((b) => b.BookingDate === null || b.BookingDate === undefined)) {
    return { bookings: [], basis: 'unavailable' };
  }
  return {
    bookings: couldCount.filter((b) => (b.BookingDate as Serial) <= asAt),
    basis: 'reconstructed',
  };
}

export function usableHistory(series: readonly MonthlyMetrics[], asOf: Serial): MonthlyMetrics[] {
  return series.filter((m) =>
    m.monthEnd <= asOf && (m.grossRevenue > 0 || m.operatingExpenses > 0));
}

/**
 * §9's confidence rule — and why no level is stated.
 *
 * §9: "Confidence: HIGH / MEDIUM / LOW derived from history length, VARIANCE and
 * booking-on-hand coverage — a stated rule, not a vibe."
 *
 * Three inputs are named. Two can be evaluated here:
 *
 *   history length         §9 gives 2 (the minimum) and 12 (a full year)
 *   booking-on-hand cover  the share of the estimate already confirmed, 0..1
 *
 * The third cannot. Nothing in this repository states a variance boundary: §9 names the
 * input and stops, no `CFG_*` business rule carries one, and the only "variance" the
 * workbook does define — `PayoutVariance` against `CFG_PAYOUT_TOLERANCE` — is payout
 * reconciliation on a single booking, a different quantity in a different domain.
 * Borrowing it would be inventing a rule under cover of reusing one.
 *
 * So no level is stated. Publishing HIGH/MEDIUM/LOW from two of three inputs would put
 * §9's own words on a figure §9's own rule did not produce, and confidence is read by
 * management as a reason to act or wait — the last place false precision belongs. The
 * evaluable inputs still travel with the estimate, so nothing is hidden; what is withheld
 * is the label.
 *
 * This resolves the moment management states the boundary. That is a §13-class decision
 * ("questions only management can answer"), not a code change: the rule it lands in is
 * this function, and its two existing anchors — §9's 2 and 12 — are already here.
 */
export const VARIANCE_RULE_UNCONFIGURED = {
  reason: 'CONFIGURATION_REQUIRED' as const,
  message:
    'Confidence needs a variance boundary, which no business rule states. History length '
    + 'and booking-on-hand coverage are shown instead.',
};

export function assessConfidence(
  usableMonths: number,
  bookingOnHandCoverage: number,
): ConfidenceAssessment {
  if (usableMonths < MINIMUM_USABLE_MONTHS) {
    return {
      level: null,
      unavailable: {
        reason: 'INSUFFICIENT_DATA',
        message: `${usableMonths} complete month${usableMonths === 1 ? '' : 's'} of trading `
          + `history; ${MINIMUM_USABLE_MONTHS} are required.`,
      },
      historyMonths: usableMonths,
      bookingOnHandCoverage,
      variance: null,
    };
  }
  return {
    level: null,
    unavailable: VARIANCE_RULE_UNCONFIGURED,
    historyMonths: usableMonths,
    bookingOnHandCoverage,
    variance: null,
  };
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
    confidence: assessConfidence(usableMonths, 0),
    inputs: {
      usableMonths,
      trailingMonthsUsed: 0,
      bookingOnHandNights: 0,
      residualPickupNights: 0,
      bookingOnHandCoverage: 0,
      availableNights,
      trailingAdr: null,
      adrBasis: null,
      propertyRates: [],
      cash: null,
      // Nothing was consulted: below the minimum, no books are counted at all.
      onHandBasis: 'unavailable',
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
  /**
   * Count only bookings made on or before this date — set when re-estimating a month
   * that has already happened, so the estimate cannot see bookings taken afterwards.
   * Omitted for a real forecast, where today's books ARE the books.
   */
  onHandAsOf?: Serial;
  /**
   * Per-unit monthly history, oldest first, for §9's property-level ADR. Optional: when
   * it is absent the revenue horizon falls back to the portfolio rate and says so in
   * `method` and `inputs.adrBasis`, rather than presenting a blend it did not perform.
   */
  propertyHistory?: readonly PropertyMonthMetrics[];
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
  const books = booksAsAt(reservations, request.onHandAsOf);
  const bookingOnHandNights = occupiedNights([...books.bookings], period);

  const window = history.slice(-PICKUP_WINDOW_MONTHS);
  const nights = estimateNights(
    window.map((m) => m.occupiedNights),
    bookingOnHandNights,
    availableNights,
  );

  return {
    horizon: 'occupancy',
    monthKey,
    status: 'SUFFICIENT',
    label: 'ESTIMATE',
    method,
    value: nights.forecastNights,
    unit: 'nights',
    occupancyPct: safeDiv(nights.forecastNights, availableNights),
    confidence: assessConfidence(history.length, nights.bookingOnHandCoverage),
    inputs: {
      usableMonths: history.length,
      trailingMonthsUsed: nights.trailingMonthsUsed,
      bookingOnHandNights: nights.bookingOnHandNights,
      residualPickupNights: nights.residualPickupNights,
      bookingOnHandCoverage: nights.bookingOnHandCoverage,
      availableNights,
      trailingAdr: null,
      adrBasis: null,
      propertyRates: [],
      cash: null,
      onHandBasis: books.basis,
    },
    reason: null,
  };
}

/**
 * §9's "(property-level)" ADR.
 *
 * Each unit is estimated on its own history and its own confirmed bookings — the same
 * rule the portfolio runs — and its trailing ADR is then weighted by the share of the
 * night mix it represents. The portfolio's night TOTAL stays authoritative: this changes
 * the rate, never the volume, so the occupancy and revenue horizons still cannot disagree
 * about how many nights are expected.
 *
 * Why the granularity earns its keep: a portfolio ADR prices next month at last quarter's
 * unit mix. When the ₹6,000 two-bedroom is heavily booked and the ₹3,000 one-bedroom is
 * not, the blended rate understates the month — and it understates it again, in the other
 * direction, when the mix reverses.
 *
 * A unit that sold nothing in the window carries no rate of its own and is left out of
 * the blend rather than entered at zero; its nights are then priced at the blend of the
 * units that did sell, which is the nearest honest rate available for it.
 */
export function propertyRateMix(
  request: OccupancyForecastRequest,
  windowMonthKeys: readonly string[],
): PropertyRateContribution[] {
  const history = request.propertyHistory ?? [];
  if (history.length === 0) return [];

  const period = monthPeriod(request.monthKey);
  const wanted = new Set(windowMonthKeys);
  const propertyIds = [...new Set(history.map((m) => m.propertyId))].sort();

  const contributions = propertyIds.map((propertyId) => {
    const months = history.filter((m) => m.propertyId === propertyId && wanted.has(m.monthKey));
    const rated = months.filter((m) => m.occupiedNights > 0);
    const trailingAdr = safeDiv(rated.reduce((sum, m) => sum + m.adr, 0), rated.length);
    const onHand = occupiedNights(
      reservationsFor(request.reservations, propertyId),
      period,
    );
    // One property row is one unit, so its sellable nights are the month's length.
    const unitNights = months[0]?.availableNights ?? (period.end - period.start);
    const nights = estimateNights(months.map((m) => m.occupiedNights), onHand, unitNights);
    return { propertyId, forecastNights: nights.forecastNights, trailingAdr, weight: 0 };
  });

  const rated = contributions.filter((c) => c.forecastNights > 0 && c.trailingAdr > 0);
  const total = rated.reduce((sum, c) => sum + c.forecastNights, 0);
  if (total === 0) return [];
  return rated.map((c) => ({ ...c, weight: c.forecastNights / total }));
}

const reservationsFor = (
  reservations: readonly ReservationRecord[],
  propertyId: string,
): ReservationRecord[] => reservations.filter((b) => b.PropertyID === propertyId);

/**
 * §9 revenue: forecast occupied nights × trailing ADR.
 *
 * The nights come from the occupancy horizon rather than being recomputed, so the two
 * estimates can never disagree. ADR is the engine's own per-month ADR (room revenue ÷
 * occupied nights) averaged over the same rolling window — the arithmetic is not
 * duplicated here.
 *
 * §9 specifies ADR "(property-level)", and `propertyRateMix` supplies exactly that when
 * per-unit history is available: each unit's own trailing rate, weighted by the share of
 * the night mix that unit is estimated to sell. Without that history the portfolio rate
 * stands in, and `method` and `inputs.adrBasis` both say which one produced the number.
 */
export function forecastRevenue(
  request: OccupancyForecastRequest,
  occupancy: ForecastEstimate = forecastOccupancy(request),
): ForecastEstimate {
  const { series, monthKey, asOf } = request;
  const history = usableHistory(series, asOf);

  if (occupancy.status === 'INSUFFICIENT_DATA' || occupancy.value === null) {
    return insufficient(
      'revenue', monthKey,
      'Forecast occupied nights × trailing ADR', 'currency',
      history.length, occupancy.inputs.availableNights,
    );
  }

  const window = history.slice(-PICKUP_WINDOW_MONTHS);
  // Mean of the months' own ADRs. Months that sold nothing carry ADR 0 and would drag a
  // plain mean down, so only months that actually sold a night contribute a rate.
  const rated = window.filter((m) => m.occupiedNights > 0);
  const portfolioAdr = safeDiv(rated.reduce((sum, m) => sum + m.adr, 0), rated.length);

  const propertyRates = propertyRateMix(request, window.map((m) => m.monthKey));
  const propertyLevel = propertyRates.length > 0;
  const trailingAdr = propertyLevel
    ? propertyRates.reduce((sum, c) => sum + c.weight * c.trailingAdr, 0)
    : portfolioAdr;
  const method = propertyLevel
    ? 'Forecast occupied nights × trailing ADR (property-level, weighted by each unit’s estimated night mix)'
    : 'Forecast occupied nights × trailing ADR (portfolio — no per-unit history available)';

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
    inputs: {
      ...occupancy.inputs,
      trailingMonthsUsed: rated.length,
      trailingAdr,
      adrBasis: propertyLevel ? 'property' : 'portfolio',
      propertyRates,
      cash: null,
      // Inherited from `...occupancy.inputs` above: the revenue horizon takes its nights
      // from the occupancy estimate, so it was built on exactly the same books.
    },
    reason: null,
  };
}

export interface CashFlowForecastRequest {
  /** The full monthly series, oldest first. Decides sufficiency and the rolling window. */
  series: readonly MonthlyMetrics[];
  /** The month being forecast. */
  monthKey: string;
  /** Everything on or before this is history. Passed in — never read from the clock. */
  asOf: Serial;
  /**
   * Cumulative net cash recorded before the month. This is the convention the Cash Flow
   * screen already shows as its running balance — "cumulative from the start of the
   * ledger, not a restart at zero each month" — reused rather than redefined.
   */
  openingBalance: number;
  /** Payouts expected to land in the month, already lagged per platform by the caller. */
  expectedPayouts: number;
  /** Rent and fixed costs scheduled to fall due in the month. */
  scheduledFixedCosts: number;
  /** Variable operating spend by month key. The window months are selected here. */
  variableCostsByMonth: Readonly<Record<string, number>>;
}

/**
 * §9 cash flow: opening balance + expected payouts (per-platform lag from Settings)
 * − scheduled rent/fixed costs − trailing variable-cost average.
 *
 * The four terms come from four different registers, and each is taken from the one that
 * owns it: the cash ledger for the balance, the reservations plus the Settings lag for
 * the payouts, the rent obligation register for what falls due, and the expense ledger
 * for what varies. The split between the last two is the contract's own — 06_EXPENSES
 * categorises rows as `Fixed Operating` or not — so the fixed costs are counted once,
 * from the schedule, and never a second time through the average.
 *
 * `value` is the projected CLOSING balance, because that is the figure an operator acts
 * on: it answers "will there be enough to pay the rent", which a net movement does not.
 *
 * The result is deliberately CONSERVATIVE, and the reason should be understood before it
 * is read. §9's inflow is "expected payouts", which are payouts from bookings that
 * already exist. Nights the occupancy horizon expects to still be picked up are NOT
 * counted as cash: they are not booked, so their payout date is unknowable, and a cash
 * balance inflated by bookings nobody has made yet is the one error in this system that
 * could cause a real payment to be missed. The estimate therefore reads low whenever the
 * month ahead is lightly booked — which is exactly when caution is worth having.
 *
 * The horizon shares §9's 2-month minimum. It is the horizon where being wrong is most
 * expensive, so it refuses in exactly the same way as the others.
 */
export function forecastCashFlow(request: CashFlowForecastRequest): ForecastEstimate {
  const {
    series, monthKey, asOf, openingBalance, expectedPayouts, scheduledFixedCosts,
    variableCostsByMonth,
  } = request;
  const method =
    'Opening balance + expected payouts (per-platform lag) − scheduled rent and fixed costs '
    + '− rolling 3-month average variable cost';

  const history = usableHistory(series, asOf);
  if (history.length < MINIMUM_USABLE_MONTHS) {
    return insufficient('cashflow', monthKey, method, 'currency', history.length, 0);
  }

  const window = history.slice(-PICKUP_WINDOW_MONTHS);
  const variable = window.map((m) => variableCostsByMonth[m.monthKey] ?? 0);
  const trailingVariableCosts = safeDiv(variable.reduce((sum, v) => sum + v, 0), variable.length);

  const netMovement = expectedPayouts - scheduledFixedCosts - trailingVariableCosts;

  /*
   * Confidence, on the same rule the other horizons use and with the same meaning: the
   * share of the estimate that is already known rather than averaged. Here the payouts
   * come from bookings that exist and the fixed costs from a signed obligation; only the
   * variable average is a projection. No new threshold is introduced — `classifyConfidence`
   * still applies §9's own 2 and 12.
   */
  const known = Math.abs(expectedPayouts) + Math.abs(scheduledFixedCosts);
  const coverage = safeDiv(known, known + Math.abs(trailingVariableCosts));

  return {
    horizon: 'cashflow',
    monthKey,
    status: 'SUFFICIENT',
    label: 'ESTIMATE',
    method,
    value: openingBalance + netMovement,
    unit: 'currency',
    occupancyPct: null,
    confidence: assessConfidence(history.length, coverage),
    inputs: {
      usableMonths: history.length,
      trailingMonthsUsed: variable.length,
      bookingOnHandNights: 0,
      residualPickupNights: 0,
      bookingOnHandCoverage: coverage,
      availableNights: 0,
      trailingAdr: null,
      adrBasis: null,
      propertyRates: [],
      cash: {
        openingBalance,
        expectedPayouts,
        scheduledFixedCosts,
        trailingVariableCosts,
        variableMonthsUsed: variable.length,
        netMovement,
      },
      // The cash horizon counts payouts, not nights; no books are read for it here.
      onHandBasis: 'unavailable',
    },
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

  /*
   * Cash flow is deliberately not compared, and it is worth being precise about which
   * half is missing, because it is not the half it first appears to be.
   *
   * The ACTUAL side is available: a month's closing balance is the cumulative net cash
   * through its end, the same convention `openingBalance` already uses, so
   * closing(M) === opening(M+1). Nothing stops that being computed.
   *
   * The FORECAST side is what is missing, and since `booksAsAt` exists the obstacle is no
   * longer that it cannot be built. Re-estimating a past month needs the payouts expected
   * AT THE TIME, and those follow from the bookings that existed then, which `BookingDate`
   * now supplies wherever the source records it. Every other term — opening balance, the
   * rent obligation window, the trailing variable average — is already dated.
   *
   * What is missing is data to validate it against. The generated demonstration set
   * records no booking dates, so a cash backtest built here could not be exercised before
   * being shown to anyone, and this is the horizon where a wrong number is most expensive.
   * It stays unbuilt until a source with booking dates exists to prove it. That is a
   * smaller and more specific blocker than the one recorded here previously.
   */
  if (estimate.horizon === 'cashflow') return null;

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
    basis: estimate.inputs.onHandBasis,
  };
}
