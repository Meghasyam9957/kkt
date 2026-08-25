/**
 * FORECASTING (ARCHITECTURE §9) — deterministic behaviour, pinned.
 *
 * The rules under test are the ones §9 states: a 2-complete-usable-month minimum,
 * booking-on-hand plus rolling 3-month residual pickup for occupancy, nights × trailing
 * ADR for revenue, an ESTIMATE label on everything, a stated confidence, and — the rule
 * that matters most — no number at all when the history cannot support one.
 *
 * Synthetic months are used where a case needs an exact usable-month count; the seeded
 * demonstration year is used where the point is that the real fixtures behave (its
 * dormant August and not-yet-traded March must not be counted as history).
 */
import { describe, it, expect } from 'vitest';
import {
  forecastOccupancy, forecastRevenue, forecastVsActual, usableHistory, classifyConfidence,
  MINIMUM_USABLE_MONTHS, FULL_HISTORY_MONTHS, PICKUP_WINDOW_MONTHS,
  type OccupancyForecastRequest,
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
    expect(out.confidence).toBeNull();
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
 * 5 · Confidence — a stated rule, pinned at its boundaries
 * ================================================================== */

describe('forecast · confidence', () => {
  it('is HIGH only with a full year behind it AND the month already on the books', () => {
    expect(classifyConfidence(FULL_HISTORY_MONTHS, 1)).toBe('HIGH');
    expect(classifyConfidence(FULL_HISTORY_MONTHS + 5, 1)).toBe('HIGH');
  });

  it('is LOW with limited history and nothing yet on the books', () => {
    expect(classifyConfidence(MINIMUM_USABLE_MONTHS, 0)).toBe('LOW');
    expect(classifyConfidence(FULL_HISTORY_MONTHS - 1, 0.99)).toBe('LOW');
  });

  it('is MEDIUM when exactly one of the two holds', () => {
    expect(classifyConfidence(FULL_HISTORY_MONTHS, 0)).toBe('MEDIUM');
    expect(classifyConfidence(MINIMUM_USABLE_MONTHS, 1)).toBe('MEDIUM');
  });

  it('is carried onto the revenue estimate it was derived from', () => {
    const req = request({ series: [traded('2026-12', 30, 4000), traded('2027-01', 30, 4000)] });
    const occupancy = forecastOccupancy(req);
    expect(forecastRevenue(req, occupancy).confidence).toBe(occupancy.confidence);
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
