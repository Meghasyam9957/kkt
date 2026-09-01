import '@/lib/server/only';
/**
 * KPI ENGINE — the single server-side source of every business number.
 *
 * Every function here is a direct port of a V1 workbook formula. The V1 formula is
 * quoted above each block so the two can be diff-read by a human, and `tests/parity.test.ts`
 * asserts the numbers agree with the workbook's own independent recomputation.
 *
 * Rules this file exists to enforce:
 *   - No business calculation may be duplicated in frontend code. This is the only copy.
 *   - Unset business rules produce ZERO plus a "configure me" signal — never a guess.
 *   - Nothing here reads or writes CFG_REPORT_MONTH (Decision D1); the period is a
 *     parameter, so concurrent users can view different months safely.
 */
import {
  edate, monthKeyOf, monthKeyToSerial, monthStart, daysInMonth, isNum, type Serial,
} from '@/lib/shared/dates';
import {
  OCCUPANCY_STATUSES, CANCELLED_STATUSES,
  type WorkbookData, type MonthlyMetrics, type PropertyPerformance, type PlatformPerformance,
  type InvestorWaterfall, type InvestorAllocation, type ReservationRecord, type RevenueRecord,
  type ExpenseRecord, type BusinessSettings, type DistributionRecord, type RentRecord,
} from '@/lib/shared/domain';

/** Half-open period [start, end) — exactly the `>= ms` / `< me` bounds V1 uses. */
export interface Period {
  start: Serial;
  end: Serial;
  label: string;
}

export function monthPeriod(monthKey: string): Period {
  const start = monthKeyToSerial(monthKey);
  return { start, end: edate(start, 1), label: monthKey };
}

export function fyPeriod(fyStart: Serial, months = 12): Period {
  const start = monthStart(fyStart);
  return { start, end: edate(start, months), label: `FY from ${monthKeyOf(start)}` };
}

/* ================================================================== *
 * Primitives shared by every metric
 * ================================================================== */

const inPeriod = (value: Serial | null, p: Period): boolean =>
  value !== null && value >= p.start && value < p.end;

const safeDiv = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

const isOccupancyStatus = (status: string): boolean =>
  (OCCUPANCY_STATUSES as readonly string[]).includes(status);

const isCancelledStatus = (status: string): boolean =>
  (CANCELLED_STATUSES as readonly string[]).includes(status);

/**
 * Does a stay span this day? THE half-open interval, in one place.
 *
 * Arrival day counts, departure day does not — so a same-day turnover is one unit-night,
 * not two, and back-to-back stays never both claim the changeover date. This is the same
 * bound `occupiedNights` applies across a period; it was open-coded in four places, one
 * of which had drifted by omitting the blank-date guard below.
 *
 * A blank date arrives as serial 0, not null, so `> 0` is load-bearing: without it an
 * unfinished booking occupies every day since the epoch.
 */
export function spansDay(checkIn: Serial | null, checkOut: Serial | null, day: Serial): boolean {
  if (checkIn === null || checkOut === null) return false;
  if (checkIn <= 0 || checkOut <= 0) return false;
  return checkIn <= day && day < checkOut;
}

/**
 * Does a REAL stay cover this day? The interval above, plus the domain's own definition
 * of a stay that happened (`OCCUPANCY_STATUSES`).
 *
 * A cancellation and a no-show are excluded by that set, so they occupy nothing — which
 * is the answer a calendar has to give: the unit is free.
 */
export function stayCoversDay(booking: ReservationRecord, day: Serial): boolean {
  return isOccupancyStatus(booking.BookingStatus)
    && spansDay(booking.CheckInDate, booking.CheckOutDate, day);
}

/**
 * V1: `=ARRAYFORMULA(IF(LEN(id)=0,,N(Gross)-N(Discount)-N(Tax)-N(PlatformFee)-N(OtherDeduction)))`
 * (05_REVENUE `NetRevenue`). Computed from raw inputs rather than read from the calc
 * column, so a row entered seconds ago is counted before the workbook has recalculated.
 */
export const revenueNet = (r: RevenueRecord): number =>
  r.GrossAmount - r.Discount - r.Tax - r.PlatformFee - r.OtherDeduction;

/** V1: 06_EXPENSES `TotalAmount` = `N(Amount)+N(Tax)`. */
export const expenseTotal = (e: ExpenseRecord): number => e.Amount + e.Tax;

/** V1's CAPEX line rule: a row with quantity 0 still costs one unit. One definition,
 *  used by the monthly series and by the CAPEX ledger view alike. */
export const capexLineTotal = (c: { Quantity: number; UnitCost: number }): number =>
  (c.Quantity === 0 ? 1 : c.Quantity) * c.UnitCost;

/** V1: 04_RESERVATIONS `Nights` = `IF(both dates, MAX(co-ci,0), )`. */
export const bookingNights = (b: ReservationRecord): number =>
  b.CheckInDate === null || b.CheckOutDate === null ? 0 : Math.max(b.CheckOutDate - b.CheckInDate, 0);

/** V1: `GrossBookingValue` = Room + Cleaning + ExtraGuest + Other − Discount. */
export const grossBookingValue = (b: ReservationRecord): number =>
  b.RoomRevenue + b.CleaningFee + b.ExtraGuestFee + b.OtherCharges - b.Discount;

/**
 * V1 `EstPlatformFee`: an entered fee counts only when > 0, otherwise the commission %
 * from Settings estimates it. An unconfigured commission estimates 0 — it never guesses.
 */
export function estimatedPlatformFee(b: ReservationRecord, settings: BusinessSettings): number {
  if (b.PlatformFee > 0) return b.PlatformFee;
  const commission = settings.platformCommission[b.Platform];
  return isNum(commission) ? grossBookingValue(b) * commission : 0;
}

/** V1 `ExpectedPayout` = GrossBookingValue − Taxes − EstPlatformFee − OtherDeductions. */
export const expectedPayout = (b: ReservationRecord, settings: BusinessSettings): number =>
  grossBookingValue(b) - b.Taxes - estimatedPlatformFee(b, settings) - b.OtherDeductions;

/**
 * Occupied nights via interval overlap against [p.start, p.end).
 *
 * V1: `SUM(IF((co>ms)*(ci<me)*okDated, IF(co<me,co,me)-IF(ci>ms,ci,ms), 0))`
 * where `okDated` additionally requires BOTH dates to be real — without that guard a
 * blank check-in (serial 0) counts as occupying from the period start.
 */
export function occupiedNights(bookings: ReservationRecord[], p: Period): number {
  let total = 0;
  for (const b of bookings) {
    if (!isOccupancyStatus(b.BookingStatus)) continue;
    const ci = b.CheckInDate;
    const co = b.CheckOutDate;
    if (ci === null || co === null || ci <= 0 || co <= 0) continue;
    if (co > p.start && ci < p.end) {
      total += Math.min(co, p.end) - Math.max(ci, p.start);
    }
  }
  return total;
}

/** V1: `COUNTIF(propID,"?*") - COUNTIFS(propID,"?*", propStatus,"Blocked")`. */
export function activeUnitCount(data: WorkbookData): number {
  return data.properties.filter((p) => p.PropertyID !== '' && p.PropertyStatus !== 'Blocked').length;
}

/* ================================================================== *
 * Monthly series — the port of the 99_CALC monthly block (rows 3..37)
 * ================================================================== */

export function computeMonthlySeries(data: WorkbookData, monthKeys: string[]): MonthlyMetrics[] {
  const { settings } = data;
  const out: MonthlyMetrics[] = [];
  let carryForwardBalance = 0; // running unrecovered-loss balance (≤ 0), V1 row 37

  for (const monthKey of monthKeys) {
    const p = monthPeriod(monthKey);
    const days = daysInMonth(p.start);
    const activeUnits = activeUnitCount(data);
    const availableNights = days * activeUnits;

    const monthRevenue = data.revenue.filter((r) => inPeriod(r.Date, p));
    const monthExpenses = data.expenses.filter((e) => inPeriod(e.Date, p));

    // --- Revenue block ---------------------------------------------------
    // V1: RoomRevenue = SUMIFS(Gross, RevenueType,"Room", Date in month), etc.
    const roomRevenue = monthRevenue.filter((r) => r.RevenueType === 'Room')
      .reduce((s, r) => s + r.GrossAmount, 0);
    const cleaningRevenue = monthRevenue.filter((r) => r.RevenueType === 'Cleaning Fee')
      .reduce((s, r) => s + r.GrossAmount, 0);
    const allGross = monthRevenue.reduce((s, r) => s + r.GrossAmount, 0);
    const otherRevenue = allGross - roomRevenue - cleaningRevenue;
    const grossRevenue = roomRevenue + cleaningRevenue + otherRevenue;

    const discounts = monthRevenue.reduce((s, r) => s + r.Discount, 0);
    // V1 labels this "Platform fees + other deductions".
    const platformFees = monthRevenue.reduce((s, r) => s + r.PlatformFee + r.OtherDeduction, 0);
    const taxes = monthRevenue.reduce((s, r) => s + r.Tax, 0);
    const netRevenue = grossRevenue - discounts - platformFees - taxes;

    // --- Cost & profit ---------------------------------------------------
    // V1: SUMIFS(TotalAmount, ExpenseType,"Operating", Date in month).
    // A blank Type is EXCLUDED (matching the workbook) and flagged by V1 QA-31.
    const operatingExpenses = monthExpenses
      .filter((e) => e.ExpenseType === 'Operating')
      .reduce((s, e) => s + expenseTotal(e), 0);
    const operatingProfit = netRevenue - operatingExpenses;
    const operatingMarginPct = safeDiv(operatingProfit, netRevenue);

    // --- Stay metrics ----------------------------------------------------
    const occupied = occupiedNights(data.reservations, p);
    const occupancyPct = safeDiv(occupied, availableNights);
    const adr = safeDiv(roomRevenue, occupied);
    const revPar = safeDiv(roomRevenue, availableNights);

    const arrivals = data.reservations.filter((b) => inPeriod(b.CheckInDate, p));
    const bookingsCount = arrivals.filter((b) => isOccupancyStatus(b.BookingStatus)).length;
    const cancelledCount = arrivals.filter((b) => isCancelledStatus(b.BookingStatus)).length;
    const cancellationRatePct = safeDiv(cancelledCount, cancelledCount + bookingsCount);
    const nightsOfArrivals = arrivals
      .filter((b) => isOccupancyStatus(b.BookingStatus))
      .reduce((s, b) => s + bookingNights(b), 0);
    const alos = safeDiv(nightsOfArrivals, bookingsCount);

    const capexTotal = data.capex
      .filter((c) => inPeriod(c.Date, p))
      .reduce((s, c) => s + capexLineTotal(c), 0);

    // --- Distribution waterfall -----------------------------------------
    // V1: reserve/fee apply only when the rule ISNUMBER, and only to positive profit.
    const reserveAmt = isNum(settings.reservePct) ? Math.max(0, operatingProfit) * settings.reservePct : 0;
    const mgmtFeeAmt = isNum(settings.mgmtFeePct) ? Math.max(0, operatingProfit) * settings.mgmtFeePct : 0;
    const afterReserveAndFee = operatingProfit - reserveAmt - mgmtFeeAmt;

    // V1 rows 30/37: carry-forward consumes only the UNRECOVERED loss balance carried in
    // from the previous month — profits already distributed are never clawed back.
    const carryForwardEnabled = settings.lossTreatment === 'Carry forward';
    const carryForwardApplied = carryForwardEnabled
      ? Math.min(Math.max(0, afterReserveAndFee), Math.max(0, -carryForwardBalance))
      : 0;
    carryForwardBalance = carryForwardEnabled
      ? Math.min(0, afterReserveAndFee + carryForwardBalance)
      : 0;

    const distributableProfit = Math.max(0, operatingProfit - reserveAmt - mgmtFeeAmt - carryForwardApplied);
    const investorPoolAmt = isNum(settings.investorPoolPct)
      ? distributableProfit * settings.investorPoolPct
      : 0;

    const distributionsPaid = data.distributions
      .filter((d) => inPeriod(d.Period, p))
      .reduce((s, d) => s + d.PaidAmount, 0);

    const monthCash = data.cashflow.filter((c) => inPeriod(c.Date, p));
    const cashIn = monthCash.reduce((s, c) => s + c.MoneyIn, 0);
    const cashOut = monthCash.reduce((s, c) => s + c.MoneyOut, 0);

    out.push({
      monthKey, monthStart: p.start, monthEnd: p.end, daysInMonth: days,
      activeUnits, availableNights, occupiedNights: occupied, occupancyPct,
      roomRevenue, cleaningRevenue, otherRevenue, grossRevenue,
      discounts, platformFees, taxes, netRevenue,
      operatingExpenses, operatingProfit, operatingMarginPct,
      adr, revPar,
      bookingsCount, cancelledCount, cancellationRatePct, alos,
      capexTotal, reserveAmt, mgmtFeeAmt, carryForwardApplied, carryForwardBalance,
      distributableProfit, investorPoolAmt, distributionsPaid,
      cashIn, cashOut, netCash: cashIn - cashOut,
    });
  }
  return out;
}

/**
 * FY totals: additive rows are summed, ratios are RECOMPUTED from their components.
 * (Summing a ratio column is the classic spreadsheet error; V1 avoids it and so must we.)
 */
export function computeFyTotals(series: MonthlyMetrics[]) {
  const sum = (pick: (m: MonthlyMetrics) => number) => series.reduce((s, m) => s + pick(m), 0);
  const occupiedNightsTotal = sum((m) => m.occupiedNights);
  const availableNightsTotal = sum((m) => m.availableNights);
  const roomRevenueTotal = sum((m) => m.roomRevenue);
  const netRevenueTotal = sum((m) => m.netRevenue);
  const operatingProfitTotal = sum((m) => m.operatingProfit);
  const bookingsTotal = sum((m) => m.bookingsCount);
  const cancelledTotal = sum((m) => m.cancelledCount);
  return {
    grossRevenue: sum((m) => m.grossRevenue),
    discounts: sum((m) => m.discounts),
    platformFees: sum((m) => m.platformFees),
    taxes: sum((m) => m.taxes),
    netRevenue: netRevenueTotal,
    operatingExpenses: sum((m) => m.operatingExpenses),
    operatingProfit: operatingProfitTotal,
    capexTotal: sum((m) => m.capexTotal),
    distributableProfit: sum((m) => m.distributableProfit),
    investorPoolAmt: sum((m) => m.investorPoolAmt),
    distributionsPaid: sum((m) => m.distributionsPaid),
    cashIn: sum((m) => m.cashIn),
    cashOut: sum((m) => m.cashOut),
    netCash: sum((m) => m.netCash),
    occupiedNights: occupiedNightsTotal,
    availableNights: availableNightsTotal,
    occupancyPct: safeDiv(occupiedNightsTotal, availableNightsTotal),
    operatingMarginPct: safeDiv(operatingProfitTotal, netRevenueTotal),
    adr: safeDiv(roomRevenueTotal, occupiedNightsTotal),
    revPar: safeDiv(roomRevenueTotal, availableNightsTotal),
    bookingsCount: bookingsTotal,
    cancelledCount: cancelledTotal,
    cancellationRatePct: safeDiv(cancelledTotal, cancelledTotal + bookingsTotal),
    alos: safeDiv(sum((m) => m.alos * m.bookingsCount), bookingsTotal),
  };
}

/* ================================================================== *
 * Per-property — port of the 99_CALC property block, but window-driven
 * instead of keyed to the shared report-month cell (Decision D1).
 * ================================================================== */

export function computeByProperty(
  data: WorkbookData,
  p: Period,
  filter?: { propertyId?: string },
): PropertyPerformance[] {
  const days = p.end - p.start;
  const properties = data.properties.filter(
    (prop) => prop.PropertyID !== '' && (!filter?.propertyId || prop.PropertyID === filter.propertyId),
  );

  return properties.map((prop) => {
    const id = prop.PropertyID;

    const netRevenue = data.revenue
      .filter((r) => r.PropertyID === id && inPeriod(r.Date, p))
      .reduce((s, r) => s + revenueNet(r), 0);

    // Direct costs only. COMMON/shared rows are excluded by construction because they
    // carry PropertyID = 'COMMON'; allocating them is an open management decision.
    const directOperatingExpenses = data.expenses
      .filter((e) => e.PropertyID === id && e.ExpenseType === 'Operating' && inPeriod(e.Date, p))
      .reduce((s, e) => s + expenseTotal(e), 0);

    const propertyBookings = data.reservations.filter((b) => b.PropertyID === id);
    const occupied = occupiedNights(propertyBookings, p);
    const roomRevenue = data.revenue
      .filter((r) => r.PropertyID === id && r.RevenueType === 'Room' && inPeriod(r.Date, p))
      .reduce((s, r) => s + r.GrossAmount, 0);

    return {
      propertyId: id,
      unit: prop.Unit,
      netRevenue,
      directOperatingExpenses,
      profit: netRevenue - directOperatingExpenses,
      occupiedNights: occupied,
      availableNights: days,
      occupancyPct: safeDiv(occupied, days),
      adr: safeDiv(roomRevenue, occupied),
      revPar: safeDiv(roomRevenue, days),
      bookings: propertyBookings.filter(
        (b) => inPeriod(b.CheckInDate, p) && isOccupancyStatus(b.BookingStatus),
      ).length,
    };
  });
}

/* ================================================================== *
 * Per-platform — port of the 99_CALC platform block
 * ================================================================== */

export function computeByPlatform(
  data: WorkbookData,
  p: Period,
  filter?: { platform?: string; propertyId?: string },
): PlatformPerformance[] {
  const platforms = Object.keys(data.settings.platformCommission).filter(
    (name) => name !== '' && (!filter?.platform || name === filter.platform),
  );

  const matchesProperty = (rowProperty: string) => !filter?.propertyId || rowProperty === filter.propertyId;

  const rows = platforms.map((platform) => {
    const platformRevenue = data.revenue.filter(
      (r) => r.Platform === platform && inPeriod(r.Date, p) && matchesProperty(r.PropertyID),
    );
    return {
      platform,
      bookings: data.reservations.filter(
        (b) => b.Platform === platform && inPeriod(b.CheckInDate, p) &&
          isOccupancyStatus(b.BookingStatus) && matchesProperty(b.PropertyID),
      ).length,
      grossRevenue: platformRevenue.reduce((s, r) => s + r.GrossAmount, 0),
      feesAndDeductions: platformRevenue.reduce((s, r) => s + r.PlatformFee + r.OtherDeduction, 0),
      netRevenue: platformRevenue.reduce((s, r) => s + revenueNet(r), 0),
      shareOfNetRevenue: 0,
    };
  });

  const totalNet = rows.reduce((s, r) => s + r.netRevenue, 0);
  for (const row of rows) row.shareOfNetRevenue = safeDiv(row.netRevenue, totalNet);
  return rows;
}

/* ================================================================== *
 * Investor waterfall & allocations — port of 12_INVESTOR_DISTRIBUTIONS
 * ================================================================== */

const UNCONFIGURED_MESSAGE =
  'MANAGEMENT DECISION REQUIRED — set the investor pool % in 02_SETTINGS. ' +
  'The engine calculates ₹0 until then.';

export function computeInvestorWaterfall(data: WorkbookData, monthKey: string): InvestorWaterfall {
  // The waterfall must run the carry-forward chain from FY start, because the balance
  // arriving at this month depends on every prior month.
  const series = computeMonthlySeries(data, fyMonthKeysFor(data));
  const m = series.find((row) => row.monthKey === monthKey);
  const { settings } = data;
  const configured = isNum(settings.investorPoolPct);

  if (!m) {
    return {
      monthKey, grossRevenue: 0, discounts: 0, platformFees: 0, taxes: 0, netRevenue: 0,
      operatingExpenses: 0, operatingProfit: 0, reserve: 0, mgmtFee: 0, carryForwardApplied: 0,
      distributableProfit: 0, investorPoolPct: settings.investorPoolPct, investorPoolAmt: 0,
      operatorShare: 0, configured,
      configurationMessage: `Month ${monthKey} is outside the configured financial year.`,
    };
  }

  // Operator pool % is authoritative when set; the remainder is only a fallback.
  const operatorShare = isNum(settings.operatorPoolPct)
    ? m.distributableProfit * settings.operatorPoolPct
    : configured
      ? m.distributableProfit - m.investorPoolAmt
      : 0;

  return {
    monthKey,
    grossRevenue: m.grossRevenue,
    discounts: m.discounts,
    platformFees: m.platformFees,
    taxes: m.taxes,
    netRevenue: m.netRevenue,
    operatingExpenses: m.operatingExpenses,
    operatingProfit: m.operatingProfit,
    reserve: m.reserveAmt,
    mgmtFee: m.mgmtFeeAmt,
    carryForwardApplied: m.carryForwardApplied,
    distributableProfit: m.distributableProfit,
    investorPoolPct: settings.investorPoolPct,
    investorPoolAmt: m.investorPoolAmt,
    operatorShare,
    configured,
    configurationMessage: configured ? 'Business rules configured.' : UNCONFIGURED_MESSAGE,
  };
}

export function computeInvestorAllocations(
  data: WorkbookData,
  monthKey: string,
  filter?: { investorId?: string },
): InvestorAllocation[] {
  const waterfall = computeInvestorWaterfall(data, monthKey);
  const period = monthPeriod(monthKey);

  const investors = data.investors.filter(
    (i) => i.InvestorID !== '' && (!filter?.investorId || i.InvestorID === filter.investorId),
  );

  return investors.map((investor) => {
    const calculatedDistribution = waterfall.investorPoolAmt * investor.ParticipationPct;
    const paidAmount = data.distributions
      .filter((d) => d.InvestorID === investor.InvestorID && inPeriod(d.Period, period))
      .reduce((s, d) => s + d.PaidAmount, 0);
    // V1 clamps pending at zero, so an overpayment never shows as negative.
    const pendingAmount = Math.max(0, calculatedDistribution - paidAmount);

    let status: InvestorAllocation['status'];
    if (!waterfall.configured) status = 'Not configured';
    else if (calculatedDistribution === 0) status = 'None';
    else if (paidAmount >= calculatedDistribution - 1) status = 'Paid';
    else if (paidAmount > 0) status = 'Partial';
    else status = 'Pending';

    return {
      monthKey,
      investorId: investor.InvestorID,
      investorName: investor.InvestorName,
      participationPct: investor.ParticipationPct,
      poolAmount: waterfall.investorPoolAmt,
      calculatedDistribution,
      paidAmount,
      pendingAmount,
      status,
    };
  });
}

/** Active investors must total 100% of the pool — mirrors the V1 `ShareCheck` column. */
export function investorShareCheck(data: WorkbookData): { total: number; ok: boolean } {
  const total = data.investors
    .filter((i) => i.Status === 'Active')
    .reduce((s, i) => s + i.ParticipationPct, 0);
  return { total, ok: Math.abs(total - 1) < 0.001 };
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

export function fyMonthKeysFor(data: WorkbookData, months = 12): string[] {
  const first = monthStart(data.settings.fyStart);
  return Array.from({ length: months }, (_, i) => monthKeyOf(edate(first, i)));
}

/**
 * `12_INVESTOR_DISTRIBUTIONS.PendingAmount`, recomputed from the allocation waterfall.
 *
 * The workbook owns that column as a formula; this is the engine's port of it. Used to
 * fill the column in fixtures, and compared against the workbook's own values by LIVE
 * parity.
 */
export function fillDistributionPending(data: WorkbookData): DistributionRecord[] {
  const byMonth = new Map<string, Map<string, number>>();
  return data.distributions.map((d) => {
    if (d.Period === null) return { ...d, PendingAmount: 0 };
    const key = monthKeyOf(d.Period);
    let allocations = byMonth.get(key);
    if (!allocations) {
      allocations = new Map(
        computeInvestorAllocations(data, key).map((a) => [a.investorId, a.pendingAmount]),
      );
      byMonth.set(key, allocations);
    }
    return { ...d, PendingAmount: allocations.get(d.InvestorID) ?? 0 };
  });
}

/** Sum of the pending-distribution column — 99_CALC `PendingInvestorDistributions`. */
export function pendingInvestorDistributions(data: WorkbookData): number {
  return data.distributions.reduce((s, d) => s + Math.max(0, d.PendingAmount), 0);
}

/**
 * Payables definition used by the dashboard KPI (mirrors 99_CALC `PendingPayables`).
 *
 * Three components, exactly as the workbook has it:
 *   1. expenses awaiting or part-way through payment,
 *   2. rent obligations already past their due date,
 *   3. investor distributions calculated but not yet paid.
 *
 * The rent register is not part of `WorkbookData` (it is not a P&L input), so it arrives
 * here explicitly. Omitting it understates what the business owes, which is why the
 * argument exists rather than defaulting silently.
 */
export function pendingPayables(
  data: WorkbookData,
  rent: readonly RentRecord[] = [],
): number {
  const fromExpenses = data.expenses
    .filter((e) => e.PaymentStatus === 'Pending' || e.PaymentStatus === 'Partial')
    .reduce((s, e) => s + expenseTotal(e), 0);
  const fromRent = rent
    .filter((r) => r.paymentStatus === 'OVERDUE')
    .reduce((s, r) => s + r.monthlyAmount, 0);
  return fromExpenses + fromRent + pendingInvestorDistributions(data);
}

/** Receivables definition used by the dashboard KPI (mirrors 99_CALC `PendingReceivables`). */
export function pendingReceivables(data: WorkbookData): number {
  const fromBookings = data.reservations
    .filter((b) => b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out')
    .reduce((s, b) => s + Math.max(0, expectedPayout(b, data.settings) - b.ActualPayout), 0);
  const fromNonBookingRevenue = data.revenue
    .filter((r) => r.BookingID === '' && r.PayoutStatus === 'Pending')
    .reduce((s, r) => s + revenueNet(r), 0);
  return fromBookings + fromNonBookingRevenue;
}
