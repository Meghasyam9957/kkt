/**
 * FORECASTING (ARCHITECTURE §9) — deterministic behaviour, pinned.
 *
 * The rules under test are the ones §9 states: a 2-complete-usable-month minimum,
 * booking-on-hand plus rolling 3-month residual pickup for occupancy, nights × trailing
 * ADR for revenue, an ESTIMATE label on everything, a confidence level withheld while
 * §9's variance input has no rule, and — the one that matters most — no number at all
 * when the history cannot support one.
 *
 * Synthetic months are used where a case needs an exact usable-month count; the seeded
 * demonstration year is used where the point is that the real fixtures behave (its
 * dormant August and not-yet-traded March must not be counted as history).
 */
import { describe, it, expect } from 'vitest';
import {
  forecastOccupancy, forecastRevenue, forecastVsActual, usableHistory, assessConfidence,
  booksAsAt,
  MINIMUM_USABLE_MONTHS, FULL_HISTORY_MONTHS, PICKUP_WINDOW_MONTHS,
  propertyRateMix, forecastCashFlow,
  type OccupancyForecastRequest, type PropertyMonthMetrics, type CashFlowForecastRequest,
} from '@/lib/server/analytics/forecast';
import { monthPeriod, computeMonthlySeries, fyMonthKeysFor, activeUnitCount } from '@/lib/server/analytics/kpi';
import { buildDemoDataset, DEMO_QUIET_MONTHS } from '@/lib/data/demo/dataset';
import { isoToSerial } from '@/lib/shared/dates';
import type { MonthlyMetrics, ReservationRecord } from '@/lib/shared/domain';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const UNITS = 4;

/** A month with no activity unless the caller gives it some. */
function month(monthKey: string, over: Partial<MonthlyMetrics> = {}): MonthlyMetrics {
  const p = monthPeriod(monthKey);
  const days = p.end - p.start;
  return {
    monthKey, monthStart: p.start, monthEnd: p.end, daysInMonth: days,
    activeUnits: UNITS, availableNights: days * UNITS,
    occupiedNights: 0, occupancyPct: 0,
    roomRevenue: 0, cleaningRevenue: 0, otherRevenue: 0, grossRevenue: 0,
    discounts: 0, platformFees: 0, taxes: 0, netRevenue: 0,
    operatingExpenses: 0, operatingProfit: 0, operatingMarginPct: 0,
    adr: 0, revPar: 0,
    bookingsCount: 0, cancelledCount: 0, cancellationRatePct: 0, alos: 0,
    capexTotal: 0, reserveAmt: 0, mgmtFeeAmt: 0,
    carryForwardApplied: 0, carryForwardBalance: 0, distributableProfit: 0,
    investorPoolAmt: 0, distributionsPaid: 0,
    cashIn: 0, cashOut: 0, netCash: 0,
    ...over,
  };
}

/** A month that traded: `nights` sold at `adr`. */
const traded = (monthKey: string, nights: number, adr: number): MonthlyMetrics =>
  month(monthKey, {
    occupiedNights: nights, roomRevenue: nights * adr, grossRevenue: nights * adr, adr,
  });

/**
 * The three fields `occupiedNights` reads. The other 36 are irrelevant to forecasting
 * and constructing them would obscure what each case is actually about.
 */
const booking = (checkIn: string, checkOut: string, status = 'Confirmed'): ReservationRecord =>
  ({ BookingStatus: status, CheckInDate: isoToSerial(checkIn), CheckOutDate: isoToSerial(checkOut) }) as unknown as ReservationRecord;

/** As-of the first instant of `monthKey`, i.e. every earlier month is complete. */
const asOfStartOf = (monthKey: string) => monthPeriod(monthKey).start;

const request = (over: Partial<OccupancyForecastRequest>): OccupancyForecastRequest => ({
  series: [], reservations: [], monthKey: '2027-03', asOf: asOfStartOf('2027-03'),
  activeUnits: UNITS, ...over,
});

/* ================================================================== *
 * 1 · Sufficiency — §9's "never a number" rule
 * ================================================================== */

describe('forecast · sufficiency gating', () => {
  it('documents the thresholds §9 states', () => {
    expect(MINIMUM_USABLE_MONTHS).toBe(2);
    expect(FULL_HISTORY_MONTHS).toBe(12);
    expect(PICKUP_WINDOW_MONTHS).toBe(3);
  });

  it('refuses with no history at all — null, not zero', () => {
    const out = forecastOccupancy(request({ series: [] }));
    expect(out.status).toBe('INSUFFICIENT_DATA');
    expect(out.value).toBeNull();
    expect(out.occupancyPct).toBeNull();
    expect(out.confidence.level).toBeNull();
    expect(out.confidence.unavailable?.reason).toBe('INSUFFICIENT_DATA');
    expect(out.label).toBe('ESTIMATE');
    expect(out.reason).toMatch(/0 complete months of trading history/);
  });

  it('refuses with one usable month', () => {
    const out = forecastOccupancy(request({ series: [traded('2027-01', 40, 4000)] }));
    expect(out.status).toBe('INSUFFICIENT_DATA');
    expect(out.value).toBeNull();
    expect(out.inputs.usableMonths).toBe(1);
    expect(out.reason).toMatch(/1 complete month of trading history/);
  });

  it('estimates at exactly two usable months — the documented boundary', () => {
    const out = forecastOccupancy(request({
      series: [traded('2026-12', 40, 4000), traded('2027-01', 44, 4000)],
    }));
    expect(out.status).toBe('SUFFICIENT');
    expect(out.value).not.toBeNull();
    expect(out.inputs.usableMonths).toBe(2);
  });

  it('never counts an incomplete month as history', () => {
    // Two traded months, but the second has not finished as of the boundary.
    const series = [traded('2026-12', 40, 4000), traded('2027-01', 44, 4000)];
    const midJanuary = isoToSerial('2027-01-20');
    expect(usableHistory(series, midJanuary).map((m) => m.monthKey)).toEqual(['2026-12']);
    expect(forecastOccupancy(request({ series, asOf: midJanuary })).status)
      .toBe('INSUFFICIENT_DATA');
  });

  it('excludes months with no trading activity from the count', () => {
    const series = [
      traded('2026-11', 40, 4000),
      month('2026-12'),                    // dormant — off-market, genuinely empty
      month('2027-01'),                    // not yet traded
    ];
    const out = forecastOccupancy(request({ series }));
    expect(out.inputs.usableMonths).toBe(1);
    expect(out.status).toBe('INSUFFICIENT_DATA');
  });

  it('counts a thin month as usable — thin is not the same as absent', () => {
    // A month that traded badly still tells you something; a month that did not trade
    // at all does not. This is the distinction the demo's Sep fixture exists to show.
    const series = [traded('2026-12', 40, 4000), traded('2027-01', 3, 2000)];
    expect(usableHistory(series, asOfStartOf('2027-03'))).toHaveLength(2);
    expect(forecastOccupancy(request({ series })).status).toBe('SUFFICIENT');
  });
});

/* ================================================================== *
 * 2 · The seeded demonstration year
 * ================================================================== */

describe('forecast · against the seeded demonstration year', () => {
  const dataset = buildDemoDataset('NORMAL_DAY');
  const series = computeMonthlySeries(dataset.workbook, fyMonthKeysFor(dataset.workbook));
  const asOf = isoToSerial(dataset.today);
  const units = activeUnitCount(dataset.workbook);

  it('excludes the dormant and not-yet-traded fixtures from usable history', () => {
    const usable = usableHistory(series, asOf).map((m) => m.monthKey);
    const dormant = series[DEMO_QUIET_MONTHS.dormant]!.monthKey;
    const notYetTraded = series[DEMO_QUIET_MONTHS.notYetTraded]!.monthKey;
    expect(usable, 'the dormant month must not count as history').not.toContain(dormant);
    expect(usable, 'a month that has not happened must not count').not.toContain(notYetTraded);
  });

  it('keeps the ramp-up and thin re-opening months, which did trade', () => {
    const usable = usableHistory(series, asOf).map((m) => m.monthKey);
    expect(usable).toContain(series[DEMO_QUIET_MONTHS.rampUp]!.monthKey);
    expect(usable).toContain(series[DEMO_QUIET_MONTHS.insufficientForForecast]!.monthKey);
  });

  it('produces an estimate for the month ahead, with its inputs attached', () => {
    const req = request({
      series, reservations: dataset.workbook.reservations, asOf, activeUnits: units,
      monthKey: series[DEMO_QUIET_MONTHS.notYetTraded]!.monthKey,
    });
    const occupancy = forecastOccupancy(req);
    expect(occupancy.status).toBe('SUFFICIENT');
    expect(occupancy.value).toBeGreaterThan(0);
    expect(occupancy.inputs.usableMonths).toBeGreaterThanOrEqual(MINIMUM_USABLE_MONTHS);
    expect(occupancy.inputs.trailingMonthsUsed).toBe(PICKUP_WINDOW_MONTHS);
    expect(occupancy.method).toMatch(/Booking-on-hand/);

    const revenue = forecastRevenue(req, occupancy);
    expect(revenue.status).toBe('SUFFICIENT');
    expect(revenue.inputs.trailingAdr).toBeGreaterThan(0);
    expect(revenue.value).toBeCloseTo(occupancy.value! * revenue.inputs.trailingAdr!, 6);
  });

  it('is deterministic — repeated execution returns identical output', () => {
    const req = request({
      series, reservations: dataset.workbook.reservations, asOf, activeUnits: units,
      monthKey: series[DEMO_QUIET_MONTHS.notYetTraded]!.monthKey,
    });
    const runs = Array.from({ length: 5 }, () => JSON.stringify(forecastRevenue(req)));
    expect(new Set(runs).size, 'the same inputs must always give the same forecast').toBe(1);
  });
});

/* ================================================================== *
 * 3 · Occupancy — booking-on-hand + residual pickup
 * ================================================================== */

describe('forecast · occupancy', () => {
  const history = [traded('2026-11', 30, 4000), traded('2026-12', 30, 4000), traded('2027-01', 30, 4000)];

  it('adds the residual pickup when the month is not yet on the books', () => {
    const out = forecastOccupancy(request({ series: history, reservations: [] }));
    expect(out.inputs.bookingOnHandNights).toBe(0);
    expect(out.inputs.residualPickupNights).toBe(30);   // the rolling 3-month average
    expect(out.value).toBe(30);
    expect(out.inputs.bookingOnHandCoverage).toBe(0);
  });

  it('counts confirmed nights already on the books', () => {
    const out = forecastOccupancy(request({
      series: history,
      reservations: [booking('2027-03-01', '2027-03-11')],   // 10 nights
    }));
    expect(out.inputs.bookingOnHandNights).toBe(10);
    expect(out.inputs.residualPickupNights).toBe(20);        // 30 average − 10 on hand
    expect(out.value).toBe(30);
    expect(out.inputs.bookingOnHandCoverage).toBeCloseTo(10 / 30, 6);
  });

  it('never subtracts: a month booked beyond its recent norm keeps its real figure', () => {
    const out = forecastOccupancy(request({
      series: history,
      reservations: [booking('2027-03-01', '2027-03-21')],   // 20 nights... plus more
    }));
    expect(out.inputs.bookingOnHandNights).toBe(20);
    const heavier = forecastOccupancy(request({
      series: history,
      reservations: [booking('2027-03-01', '2027-03-31'), booking('2027-03-01', '2027-03-21')],
    }));
    expect(heavier.inputs.bookingOnHandNights).toBe(50);
    expect(heavier.inputs.residualPickupNights).toBe(0);
    expect(heavier.value).toBe(50);
    expect(heavier.inputs.bookingOnHandCoverage).toBe(1);
  });

  it('never forecasts more nights than the month can sell', () => {
    // 31 days × 4 units = 124 sellable nights; the books claim far more.
    const out = forecastOccupancy(request({
      series: [traded('2026-12', 400, 4000), traded('2027-01', 400, 4000)],
      reservations: Array.from({ length: 8 }, () => booking('2027-03-01', '2027-03-31')),
    }));
    expect(out.inputs.availableNights).toBe(124);
    expect(out.value).toBeLessThanOrEqual(124);
    expect(out.occupancyPct).toBeLessThanOrEqual(1);
  });

  it('reports a zero-occupancy history honestly rather than refusing', () => {
    // Months that traded (they had costs) but sold nothing: the estimate is a real 0.
    const series = [
      month('2026-12', { operatingExpenses: 5000 }),
      month('2027-01', { operatingExpenses: 5000 }),
    ];
    const out = forecastOccupancy(request({ series }));
    expect(out.status).toBe('SUFFICIENT');
    expect(out.value).toBe(0);
    expect(out.occupancyPct).toBe(0);
  });

  it('ignores cancellations and no-shows when reading the books', () => {
    const out = forecastOccupancy(request({
      series: history,
      reservations: [booking('2027-03-01', '2027-03-11', 'Cancelled'), booking('2027-03-01', '2027-03-06', 'No Show')],
    }));
    expect(out.inputs.bookingOnHandNights).toBe(0);
  });

  it('uses only the last three usable months for the rolling average', () => {
    const out = forecastOccupancy(request({
      series: [traded('2026-08', 120, 4000), ...history],   // an outlier long past
      reservations: [],
    }));
    expect(out.inputs.trailingMonthsUsed).toBe(3);
    expect(out.value, 'the outlier must be outside the window').toBe(30);
  });
});

/* ================================================================== *
 * 4 · Revenue — nights × trailing ADR
 * ================================================================== */

describe('forecast · revenue', () => {
  const history = [traded('2026-12', 30, 5000), traded('2027-01', 30, 3000)];

  it('multiplies forecast nights by the trailing ADR', () => {
    const req = request({ series: history, reservations: [] });
    const occupancy = forecastOccupancy(req);
    const revenue = forecastRevenue(req, occupancy);
    expect(revenue.inputs.trailingAdr).toBe(4000);          // mean of 5000 and 3000
    expect(revenue.value).toBe(occupancy.value! * 4000);
    expect(revenue.unit).toBe('currency');
    expect(revenue.method).toMatch(/trailing ADR/);
  });

  it('refuses whenever the occupancy horizon refused', () => {
    const revenue = forecastRevenue(request({ series: [traded('2027-01', 30, 4000)] }));
    expect(revenue.status).toBe('INSUFFICIENT_DATA');
    expect(revenue.value).toBeNull();
    expect(revenue.reason).not.toBeNull();
  });

  it('excludes months that sold nothing from the rate, rather than averaging in a zero', () => {
    const series = [
      traded('2026-12', 30, 4000),
      month('2027-01', { operatingExpenses: 5000 }),        // traded, sold nothing, ADR 0
    ];
    const revenue = forecastRevenue(request({ series }));
    expect(revenue.status).toBe('SUFFICIENT');
    expect(revenue.inputs.trailingAdr, 'a zero-ADR month must not halve the rate').toBe(4000);
  });

  it('yields zero revenue — not a refusal — when nothing ever sold', () => {
    const series = [
      month('2026-12', { operatingExpenses: 5000 }),
      month('2027-01', { operatingExpenses: 5000 }),
    ];
    const revenue = forecastRevenue(request({ series }));
    expect(revenue.status).toBe('SUFFICIENT');
    expect(revenue.inputs.trailingAdr).toBe(0);
    expect(revenue.value).toBe(0);
  });
});

/* ================================================================== *
 * 5 · Confidence — withheld, and why
 *
 * §9 derives confidence from three inputs: history length, VARIANCE and booking-on-hand
 * coverage. Nothing in this repository states a variance boundary, so §9's rule cannot be
 * applied in full and no HIGH/MEDIUM/LOW is published. These cases exist to stop that
 * silently changing: a level may only appear once a variance rule exists, and the two
 * evaluable inputs must keep travelling with the estimate in the meantime.
 * ================================================================== */

describe('forecast · confidence', () => {
  const twoMonths = () => request({
    series: [traded('2026-12', 30, 4000), traded('2027-01', 30, 4000)],
  });

  it('states no level while the variance rule is unconfigured', () => {
    const out = forecastOccupancy(twoMonths());
    expect(out.status).toBe('SUFFICIENT');
    expect(out.confidence.level).toBeNull();
    expect(out.confidence.unavailable?.reason).toBe('CONFIGURATION_REQUIRED');
    expect(out.confidence.unavailable?.message).toMatch(/variance/i);
  });

  it('never evaluates variance, because no boundary exists to evaluate it against', () => {
    expect(assessConfidence(FULL_HISTORY_MONTHS, 1).variance).toBeNull();
    expect(assessConfidence(MINIMUM_USABLE_MONTHS, 0).variance).toBeNull();
  });

  it('withholds the level even with a full year and the month fully on the books', () => {
    // This is the case that would have read HIGH. Two of §9's three inputs are at their
    // strongest and it is still not §9's answer, because the third was never consulted.
    const assessment = assessConfidence(FULL_HISTORY_MONTHS, 1);
    expect(assessment.level).toBeNull();
    expect(assessment.unavailable?.reason).toBe('CONFIGURATION_REQUIRED');
  });

  it('still reports the two inputs it can evaluate, so nothing is lost by withholding', () => {
    const out = forecastOccupancy(twoMonths());
    expect(out.confidence.historyMonths).toBe(2);
    expect(out.confidence.bookingOnHandCoverage).toBe(out.inputs.bookingOnHandCoverage);
  });

  it('distinguishes an unconfigured rule from an absence of history', () => {
    // Below the minimum the reason is the history, not the missing boundary — the two
    // must never be conflated, because only one of them is fixed by a management decision.
    const refused = forecastOccupancy(request({ series: [] }));
    expect(refused.confidence.level).toBeNull();
    expect(refused.confidence.unavailable?.reason).toBe('INSUFFICIENT_DATA');
    expect(refused.confidence.historyMonths).toBe(0);
  });

  it('is carried onto the revenue estimate it was derived from', () => {
    const req = twoMonths();
    const occupancy = forecastOccupancy(req);
    expect(forecastRevenue(req, occupancy).confidence).toEqual(occupancy.confidence);
  });

  it('keeps §9 anchors available for the rule that will replace this one', () => {
    // The two history anchors §9 does state stay in the module, so configuring variance is
    // a change to one function rather than a rediscovery of §9.
    expect(MINIMUM_USABLE_MONTHS).toBe(2);
    expect(FULL_HISTORY_MONTHS).toBe(12);
  });
});

/* ================================================================== *
 * 6 · Forecast vs actual
 * ================================================================== */

describe('forecast · forecast vs actual', () => {
  const history = [traded('2026-11', 30, 4000), traded('2026-12', 30, 4000), traded('2027-01', 30, 4000)];

  it('compares against the month once it is complete', () => {
    const req = request({ series: history, monthKey: '2027-02', asOf: asOfStartOf('2027-03') });
    const estimate = forecastOccupancy(req);
    const settled = [...history, traded('2027-02', 36, 4000)];

    const accuracy = forecastVsActual(estimate, settled, asOfStartOf('2027-03'));
    expect(accuracy).not.toBeNull();
    expect(accuracy!.forecast).toBe(30);
    expect(accuracy!.actual).toBe(36);
    expect(accuracy!.variance).toBe(6);
    expect(accuracy!.variancePct).toBeCloseTo(0.2, 6);
  });

  it('returns nothing while the month is still running', () => {
    const req = request({ series: history, monthKey: '2027-02', asOf: asOfStartOf('2027-03') });
    const estimate = forecastOccupancy(req);
    // Mid-February: the month exists but has not finished.
    expect(forecastVsActual(estimate, history, isoToSerial('2027-02-14'))).toBeNull();
  });

  it('returns nothing for an estimate that was never made', () => {
    const refused = forecastOccupancy(request({ series: [] }));
    expect(forecastVsActual(refused, history, asOfStartOf('2027-03'))).toBeNull();
  });
});

/* ================================================================== *
 * 7 · Property-level ADR — the granularity §9 names
 *
 * The rule is "forecast occupied nights x trailing ADR (property-level)". The case that
 * makes the granularity matter is a MIX SHIFT: the same portfolio night total, sold by a
 * different set of units than the recent past. A portfolio rate prices that month at last
 * quarter's mix and is wrong by the size of the shift.
 *
 * Numbers below are chosen so every figure can be checked by hand:
 *   HYD-A  20 nights/month at 6,000
 *   HYD-B  10 nights/month at 3,000
 *   portfolio  30 nights/month at 5,000  (150,000 / 30)
 * ================================================================== */

describe('forecast - property-level ADR', () => {
  const WINDOW = ['2026-12', '2027-01', '2027-02'];

  /** Portfolio months: 30 nights at a blended 5,000 (A: 20 at 6,000, B: 10 at 3,000). */
  const portfolio = WINDOW.map((m) => traded(m, 30, 5000));

  const unitMonth = (
    propertyId: string, monthKey: string, nights: number, adr: number,
  ): PropertyMonthMetrics => {
    const p = monthPeriod(monthKey);
    return { propertyId, monthKey, occupiedNights: nights, adr, availableNights: p.end - p.start };
  };

  const perUnit: PropertyMonthMetrics[] = WINDOW.flatMap((m) => [
    unitMonth('HYD-A', m, 20, 6000),
    unitMonth('HYD-B', m, 10, 3000),
  ]);

  const unitBooking = (propertyId: string, checkIn: string, checkOut: string): ReservationRecord =>
    ({
      PropertyID: propertyId, BookingStatus: 'Confirmed',
      CheckInDate: isoToSerial(checkIn), CheckOutDate: isoToSerial(checkOut),
    }) as unknown as ReservationRecord;

  /** March 2027, two units on sale, nothing yet on the books. */
  const steady = () => request({
    series: portfolio, propertyHistory: perUnit, activeUnits: 2,
    monthKey: '2027-03', asOf: asOfStartOf('2027-03'),
  });

  /**
   * The mix shifts: the cheap unit is heavily booked for March and the expensive one is
   * not. 25 nights confirmed on HYD-B, none on HYD-A.
   */
  const shifted = () => request({
    ...steady(),
    reservations: [unitBooking('HYD-B', '2027-03-01', '2027-03-26')],
  });

  it('reports that the rate came from the units, not from the portfolio', () => {
    const out = forecastRevenue(steady());
    expect(out.inputs.adrBasis).toBe('property');
    expect(out.method).toMatch(/property-level/i);
    expect(out.inputs.propertyRates.map((r) => r.propertyId)).toEqual(['HYD-A', 'HYD-B']);
  });

  it('weights each unit by the nights it is estimated to sell, summing to one', () => {
    const rates = forecastRevenue(steady()).inputs.propertyRates;
    // Nothing on the books, so each unit falls back to its own trailing level: 20 and 10.
    expect(rates.map((r) => r.forecastNights)).toEqual([20, 10]);
    expect(rates.map((r) => r.trailingAdr)).toEqual([6000, 3000]);
    expect(rates[0]!.weight).toBeCloseTo(2 / 3, 10);
    expect(rates[1]!.weight).toBeCloseTo(1 / 3, 10);
    expect(rates.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 10);
  });

  it('agrees with the portfolio rate while the mix is unchanged', () => {
    // (2/3 x 6000) + (1/3 x 3000) = 5000, which is what the blended series already says.
    expect(forecastRevenue(steady()).inputs.trailingAdr).toBeCloseTo(5000, 6);
  });

  it('diverges from the portfolio rate when the mix shifts - the point of the rule', () => {
    const out = forecastRevenue(shifted());
    // HYD-A: no books, trailing 20 -> 20 nights. HYD-B: 25 confirmed, above its trailing
    // 10, so no further pickup -> 25 nights. Weights 20/45 and 25/45.
    const rates = out.inputs.propertyRates;
    expect(rates.map((r) => r.forecastNights)).toEqual([20, 25]);
    expect(out.inputs.trailingAdr).toBeCloseTo((20 / 45) * 6000 + (25 / 45) * 3000, 6);
    // 4,333.33 against the portfolio's 5,000: the cheap unit is carrying the month, and a
    // blended rate would have overstated it by about 15%.
    expect(out.inputs.trailingAdr!).toBeLessThan(5000);
  });

  it('changes the rate and never the night total', () => {
    const occupancy = forecastOccupancy(shifted());
    const revenue = forecastRevenue(shifted(), occupancy);
    // Portfolio: trailing 30, 25 on the books, residual 5 -> 30 nights. Untouched by the mix.
    expect(occupancy.value).toBe(30);
    expect(revenue.value).toBeCloseTo(30 * revenue.inputs.trailingAdr!, 6);
    expect(revenue.inputs.bookingOnHandNights).toBe(occupancy.inputs.bookingOnHandNights);
  });

  it('falls back to the portfolio rate when no per-unit history is supplied, and says so', () => {
    const out = forecastRevenue(request({
      series: portfolio, activeUnits: 2, monthKey: '2027-03', asOf: asOfStartOf('2027-03'),
    }));
    expect(out.inputs.adrBasis).toBe('portfolio');
    expect(out.inputs.propertyRates).toEqual([]);
    expect(out.method).toMatch(/portfolio/i);
    expect(out.inputs.trailingAdr).toBe(5000);
  });

  it('leaves a unit with no rate out of the blend rather than entering it at zero', () => {
    // HYD-C is on sale and has bookings, but sold nothing in the window, so it has no
    // rate of its own. Its nights are priced at the blend of the units that did sell.
    const withDormant = request({
      series: portfolio, activeUnits: 3, monthKey: '2027-03', asOf: asOfStartOf('2027-03'),
      propertyHistory: [...perUnit, ...WINDOW.map((m) => unitMonth('HYD-C', m, 0, 0))],
      reservations: [unitBooking('HYD-C', '2027-03-01', '2027-03-11')],
    });
    const out = forecastRevenue(withDormant);

    expect(out.inputs.propertyRates.map((r) => r.propertyId)).toEqual(['HYD-A', 'HYD-B']);
    expect(out.inputs.trailingAdr).toBeCloseTo(5000, 6);
    expect(out.inputs.trailingAdr).not.toBe(0);
  });

  it('produces no mix at all when nothing in the window sold', () => {
    expect(propertyRateMix(
      request({
        series: portfolio, activeUnits: 2, monthKey: '2027-03', asOf: asOfStartOf('2027-03'),
        propertyHistory: WINDOW.flatMap((m) => [unitMonth('HYD-A', m, 0, 0), unitMonth('HYD-B', m, 0, 0)]),
      }),
      WINDOW,
    )).toEqual([]);
  });

  it('is deterministic across repeated execution', () => {
    const once = JSON.stringify(forecastRevenue(shifted()));
    for (let i = 0; i < 4; i++) expect(JSON.stringify(forecastRevenue(shifted()))).toBe(once);
  });

  it('still refuses entirely when the history is too short, per-unit data or not', () => {
    const out = forecastRevenue(request({
      series: [traded('2027-02', 30, 5000)], propertyHistory: perUnit, activeUnits: 2,
      monthKey: '2027-03', asOf: asOfStartOf('2027-03'),
    }));
    expect(out.status).toBe('INSUFFICIENT_DATA');
    expect(out.value).toBeNull();
    expect(out.inputs.adrBasis).toBeNull();
    expect(out.inputs.propertyRates).toEqual([]);
  });
});

/* ================================================================== *
 * 8 · Cash flow — the four terms §9 names
 *
 * "opening balance + expected payouts (with per-platform lag from Settings)
 *  − scheduled rent/fixed costs − trailing variable-cost average"
 *
 * The engine receives the four terms already gathered; which register each comes from is
 * the view's job, asserted through the provider elsewhere. What is pinned here is the
 * arithmetic, the refusal, and the confidence rule.
 * ================================================================== */

describe('forecast · cash flow', () => {
  const history = [
    traded('2026-12', 30, 5000), traded('2027-01', 30, 5000), traded('2027-02', 30, 5000),
  ];

  const cash = (over: Partial<CashFlowForecastRequest> = {}): CashFlowForecastRequest => ({
    series: history,
    monthKey: '2027-03',
    asOf: asOfStartOf('2027-03'),
    openingBalance: 200_000,
    expectedPayouts: 150_000,
    scheduledFixedCosts: 90_000,
    variableCostsByMonth: { '2026-12': 40_000, '2027-01': 30_000, '2027-02': 50_000 },
    ...over,
  });

  it('projects the closing balance, which is the figure an operator acts on', () => {
    const out = forecastCashFlow(cash());
    // variable average = (40,000 + 30,000 + 50,000) / 3 = 40,000
    // movement = 150,000 − 90,000 − 40,000 = 20,000
    // closing  = 200,000 + 20,000 = 220,000
    expect(out.status).toBe('SUFFICIENT');
    expect(out.inputs.cash!.trailingVariableCosts).toBe(40_000);
    expect(out.inputs.cash!.netMovement).toBe(20_000);
    expect(out.value).toBe(220_000);
    expect(out.unit).toBe('currency');
    expect(out.label).toBe('ESTIMATE');
  });

  it('carries every term it used, so the number can be argued with', () => {
    const terms = forecastCashFlow(cash()).inputs.cash!;
    expect(terms.openingBalance).toBe(200_000);
    expect(terms.expectedPayouts).toBe(150_000);
    expect(terms.scheduledFixedCosts).toBe(90_000);
    expect(terms.variableMonthsUsed).toBe(3);
  });

  it('averages only the rolling window, not the whole history', () => {
    const longer = [traded('2026-10', 30, 5000), traded('2026-11', 30, 5000), ...history];
    const out = forecastCashFlow(cash({
      series: longer,
      // The two oldest months are wildly expensive and must not reach the average.
      variableCostsByMonth: {
        '2026-10': 900_000, '2026-11': 900_000,
        '2026-12': 40_000, '2027-01': 30_000, '2027-02': 50_000,
      },
    }));
    expect(out.inputs.cash!.trailingVariableCosts).toBe(40_000);
    expect(out.inputs.cash!.variableMonthsUsed).toBe(PICKUP_WINDOW_MONTHS);
  });

  it('treats a month with no recorded variable spend as zero, not as missing', () => {
    const out = forecastCashFlow(cash({ variableCostsByMonth: { '2027-02': 60_000 } }));
    // Two window months recorded nothing; the average is still over all three.
    expect(out.inputs.cash!.trailingVariableCosts).toBe(20_000);
  });

  it('reports a shortfall as a negative balance rather than clamping at zero', () => {
    const out = forecastCashFlow(cash({ openingBalance: 10_000, expectedPayouts: 0 }));
    // 10,000 + (0 − 90,000 − 40,000) = −120,000. A cash forecast that cannot go negative
    // is useless at precisely the moment it matters.
    expect(out.value).toBe(-120_000);
  });

  it('refuses below the two-month minimum — the same rule as every other horizon', () => {
    const out = forecastCashFlow(cash({ series: [traded('2027-02', 30, 5000)] }));
    expect(out.status).toBe('INSUFFICIENT_DATA');
    expect(out.value).toBeNull();
    expect(out.confidence.level).toBeNull();
    expect(out.inputs.cash).toBeNull();
    expect(out.reason).toMatch(/1 complete month of trading history/);
  });

  it('never turns an unavailable estimate into a zero balance', () => {
    const out = forecastCashFlow(cash({ series: [] }));
    expect(out.value).not.toBe(0);
    expect(out.value).toBeNull();
  });

  it('measures how much of the month is known rather than averaged', () => {
    // Everything contracted, nothing averaged: coverage 1.
    const known = forecastCashFlow(cash({ variableCostsByMonth: {} }));
    expect(known.inputs.bookingOnHandCoverage).toBe(1);
    expect(known.confidence.bookingOnHandCoverage).toBe(1);

    // Nothing contracted and everything averaged: coverage 0.
    const guessed = forecastCashFlow(cash({ expectedPayouts: 0, scheduledFixedCosts: 0 }));
    expect(guessed.inputs.bookingOnHandCoverage).toBe(0);
    expect(guessed.confidence.bookingOnHandCoverage).toBe(0);

    // Neither becomes a level: coverage is only one of §9's three inputs, and the
    // variance boundary that would complete the rule does not exist.
    expect(known.confidence.level).toBeNull();
    expect(guessed.confidence.level).toBeNull();
  });

  it('is deterministic across repeated execution', () => {
    const once = JSON.stringify(forecastCashFlow(cash()));
    for (let i = 0; i < 4; i++) expect(JSON.stringify(forecastCashFlow(cash()))).toBe(once);
  });

  it('produces no forecast-vs-actual, because a balance is not a movement', () => {
    const settled = [...history, traded('2027-03', 30, 5000)];
    const estimate = forecastCashFlow(cash());
    expect(forecastVsActual(estimate, settled, asOfStartOf('2027-04'))).toBeNull();
  });
});

/* ================================================================== *
 * 9 · Seasonality — the method §9 withholds below 12 months
 *
 * §9: "Seasonality | month-of-year index | 12+ months — otherwise not applied."
 *
 * There is no seasonal code to test, and that is the point: below the threshold the
 * estimates must be month-of-year AGNOSTIC. These cases prove the absence is real rather
 * than assumed, so a seasonal adjustment cannot later be slipped in without failing here.
 * ================================================================== */

describe('forecast · seasonality gating', () => {
  it('documents the boundary §9 states', () => {
    expect(FULL_HISTORY_MONTHS).toBe(12);
  });

  it('applies no month-of-year adjustment: identical history, identical estimate', () => {
    // The same trailing shape, forecasting two very different calendar months. A seasonal
    // index would separate December from June. Below 12 months, nothing may.
    const forDecember = forecastOccupancy(request({
      series: [traded('2026-09', 30, 4000), traded('2026-10', 30, 4000), traded('2026-11', 30, 4000)],
      monthKey: '2026-12', asOf: asOfStartOf('2026-12'),
    }));
    const forJune = forecastOccupancy(request({
      series: [traded('2027-03', 30, 4000), traded('2027-04', 30, 4000), traded('2027-05', 30, 4000)],
      monthKey: '2027-06', asOf: asOfStartOf('2027-06'),
    }));

    expect(forDecember.value).toBe(forJune.value);
    expect(forDecember.inputs.residualPickupNights).toBe(forJune.inputs.residualPickupNights);
  });

  it('claims no seasonal input in anything it reports', () => {
    const out = forecastOccupancy(request({
      series: [traded('2026-12', 40, 4000), traded('2027-01', 44, 4000)],
    }));
    // The method string is the app's own account of what it did. It must not claim an
    // adjustment it did not make.
    expect(out.method).not.toMatch(/season|month-of-year|index/i);
    expect(Object.keys(out.inputs)).not.toContain('seasonalIndex');
  });

  it('still applies none once a full year exists, because permission is not implementation', () => {
    const year = Array.from({ length: 12 }, (_, i) =>
      traded(`2026-${String(i + 1).padStart(2, '0')}`, 30, 4000));
    const out = forecastOccupancy(request({
      series: year, monthKey: '2027-01', asOf: asOfStartOf('2027-01'),
    }));
    expect(out.inputs.usableMonths).toBe(FULL_HISTORY_MONTHS);
    expect(out.method).not.toMatch(/season/i);
  });
});

/* ================================================================== *
 * 10 · The books as they stood — historical booking-on-hand
 *
 * §9's occupancy method is booking-on-hand PLUS residual pickup. A re-estimate of a past
 * month that counts no books at all is measuring the pickup half on its own, and will
 * understate the method it claims to be measuring. `booksAsAt` rebuilds the on-hand set
 * from `BookingDate` where the source records one — and refuses, visibly, where it does
 * not, rather than guessing or quietly using today's bookings.
 * ================================================================== */

describe('forecast · the books as they stood', () => {
  const dated = (
    checkIn: string, checkOut: string, bookedOn: string | null, status = 'Confirmed',
  ): ReservationRecord => ({
    BookingStatus: status,
    BookingDate: bookedOn === null ? null : isoToSerial(bookedOn),
    CheckInDate: isoToSerial(checkIn),
    CheckOutDate: isoToSerial(checkOut),
  }) as unknown as ReservationRecord;

  const march = () => [
    // Booked well before March: on the books at the start of the month.
    dated('2027-03-05', '2027-03-09', '2027-01-10'),
    // Booked during March: NOT on the books when the month began.
    dated('2027-03-20', '2027-03-25', '2027-03-18'),
  ];

  it('uses today’s books when no as-at date is given — a forecast’s books are today’s', () => {
    const out = booksAsAt(march(), undefined);
    expect(out.basis).toBe('current');
    expect(out.bookings).toHaveLength(2);
  });

  it('rebuilds the set that existed at a past date', () => {
    const out = booksAsAt(march(), monthPeriod('2027-03').start);
    expect(out.basis).toBe('reconstructed');
    expect(out.bookings).toHaveLength(1);
    expect(out.bookings[0]!.CheckInDate).toBe(isoToSerial('2027-03-05'));
  });

  it('refuses to rebuild when any booking that could count has no date', () => {
    // The missing one might be exactly the booking that was on the books, so a partial
    // reconstruction would be a confident guess. None are counted, and the caller is told.
    const out = booksAsAt([...march(), dated('2027-03-11', '2027-03-14', null)],
      monthPeriod('2027-03').start);
    expect(out.basis).toBe('unavailable');
    expect(out.bookings).toEqual([]);
  });

  it('is not blocked by an undated booking that could never have counted', () => {
    // Cancelled bookings are not occupancy, so their dates are irrelevant to the rebuild.
    const out = booksAsAt([...march(), dated('2027-03-11', '2027-03-14', null, 'Cancelled')],
      monthPeriod('2027-03').start);
    expect(out.basis).toBe('reconstructed');
    expect(out.bookings).toHaveLength(1);
  });

  it('re-estimates a past month from its own books, not from today’s', () => {
    const series = [
      traded('2026-12', 30, 4000), traded('2027-01', 30, 4000), traded('2027-02', 30, 4000),
    ];
    const req = {
      series, monthKey: '2027-03', asOf: asOfStartOf('2027-03'), activeUnits: UNITS,
      reservations: march(),
    };

    const asItStood = forecastOccupancy({ ...req, onHandAsOf: asOfStartOf('2027-03') });
    const withHindsight = forecastOccupancy(req);

    // 4 nights were on the books when March began; 9 are on them now. Counting today's
    // would hand the re-estimate 5 nights it could not have known about.
    expect(asItStood.inputs.onHandBasis).toBe('reconstructed');
    expect(asItStood.inputs.bookingOnHandNights).toBe(4);
    expect(withHindsight.inputs.onHandBasis).toBe('current');
    expect(withHindsight.inputs.bookingOnHandNights).toBe(9);
  });

  it('counts no books at all when the source records no booking dates', () => {
    const series = [traded('2026-12', 30, 4000), traded('2027-01', 30, 4000)];
    const out = forecastOccupancy({
      series, monthKey: '2027-03', asOf: asOfStartOf('2027-03'), activeUnits: UNITS,
      reservations: [dated('2027-03-05', '2027-03-09', null)],
      onHandAsOf: asOfStartOf('2027-03'),
    });

    expect(out.inputs.onHandBasis).toBe('unavailable');
    expect(out.inputs.bookingOnHandNights).toBe(0);
    // The estimate still stands — it is the pickup half alone, and it says so.
    expect(out.status).toBe('SUFFICIENT');
  });

  it('carries the basis onto the accuracy row, so a comparison states what it measured', () => {
    const series = [
      traded('2026-12', 30, 4000), traded('2027-01', 30, 4000), traded('2027-02', 30, 4000),
    ];
    const settled = [...series, traded('2027-03', 36, 4000)];
    const estimate = forecastOccupancy({
      series, monthKey: '2027-03', asOf: asOfStartOf('2027-03'), activeUnits: UNITS,
      reservations: march(), onHandAsOf: asOfStartOf('2027-03'),
    });

    const accuracy = forecastVsActual(estimate, settled, asOfStartOf('2027-04'));
    expect(accuracy!.basis).toBe('reconstructed');
  });
});
