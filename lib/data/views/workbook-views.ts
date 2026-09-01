/**
 * WORKBOOK VIEWS — the shared shaping layer.
 *
 * Every screen's data is built here, from a `WorkbookData` + `OperationsData` pair. Both
 * providers — fixtures and Google Sheets — hand this class the same two structures and
 * get back the same view models.
 *
 * That is the mechanism behind "the pages must not change when the source switches":
 * there is exactly ONE implementation of what a dashboard is, so a difference between
 * demo and live can only ever be a difference in the underlying rows.
 *
 * This file performs no business calculation. Amounts come from
 * `lib/server/analytics/kpi.ts`; groupings come from the generated contract. What lives
 * here is selection, labelling and presentation state.
 */
import {
  computeMonthlySeries, computeByProperty, computeByPlatform, computeInvestorWaterfall,
  computeInvestorAllocations, monthPeriod, expectedPayout, bookingNights, grossBookingValue,
  revenueNet, expenseTotal, capexLineTotal, pendingReceivables, pendingPayables, fyMonthKeysFor,
  activeUnitCount,
} from '@/lib/server/analytics/kpi';
import {
  serialToIso, monthKeyOf, monthKeyToSerial, isoToSerial, edate, resolveBoardDate,
} from '@/lib/shared/dates';
import {
  forecastOccupancy, forecastRevenue, forecastCashFlow, forecastVsActual, usableHistory,
  MINIMUM_USABLE_MONTHS,
  type ForecastAccuracy, type PropertyMonthMetrics,
} from '@/lib/server/analytics/forecast';
import { BUSINESS_RULES, PNL as PNL_CONTRACT } from '@/lib/contract/contract.generated';
import {
  OPEN_MAINTENANCE_STATUSES, OPEN_HOUSEKEEPING_STATUSES, OCCUPANCY_STATUSES,
  type WorkbookData, type MonthlyMetrics, type OperationsData, type MaintenanceTicket,
  type ReservationRecord, type RentRecord,
} from '@/lib/shared/domain';
import type {
  DashboardView, ReportFilters, KpiValue, ReservationRow, LedgerRow, CapexRow, CashFlowRow,
  PnlView, PnlLine, SettingsView, InvestorPreviewView, OperationsToday, TrendPoint,
  PropertyBoardRow, UnitStatus, OperationsBoardView, UrgentItem, UrgentSeverity, BookingDetailRow,
  ArrivalRow, CleaningRow, MaintenanceRow, StockRow, GuestRequestRow, InvestorRegisterRow, ForecastView,
} from '@/lib/data/providers/types';

/** Most pressing first. Orders the maintenance queue. */
const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low'];

const CONFIG_REQUIRED = {
  reason: 'CONFIGURATION_REQUIRED' as const,
  message: 'Management rules not configured',
};

/** Given name + last initial. List views never need more, so they never get more. */
export function minimizeGuestName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return 'Guest';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0)}.`;
}

export interface ViewSource {
  workbook: WorkbookData;
  ops: OperationsData;
  /**
   * 08_RENT_FIXED_COSTS. Not a P&L input, but 99_CALC counts OVERDUE rent in Pending
   * Payables, so the views need it to report the same figure the workbook reports.
   */
  rent?: readonly RentRecord[];
}

export class WorkbookViews {
  private readonly workbook: WorkbookData;
  private readonly ops: OperationsData;
  private readonly rent: readonly RentRecord[];
  private seriesCache: MonthlyMetrics[] | null = null;
  private propertyHistoryCache: PropertyMonthMetrics[] | null = null;

  constructor(source: ViewSource) {
    this.workbook = source.workbook;
    this.ops = source.ops;
    this.rent = source.rent ?? [];
  }

  /* ---------------- period helpers ---------------- */

  /** The full FY series, computed once — every view reads from it. */
  series(): MonthlyMetrics[] {
    if (!this.seriesCache) {
      this.seriesCache = computeMonthlySeries(this.workbook, fyMonthKeysFor(this.workbook));
    }
    return this.seriesCache;
  }

  /**
   * Per-unit monthly history for the financial year — §9's "(property-level)" ADR input.
   *
   * Built from `computeByProperty`, the same per-unit engine the property screens read,
   * so a unit's forecast rate and its reported rate are the same calculation. Blocked
   * units are excluded, matching the V1 rule `activeUnitCount` already applies: a unit
   * that is not on sale should neither add capacity nor lend its old rate to the mix.
   */
  private propertyHistory(): PropertyMonthMetrics[] {
    if (this.propertyHistoryCache) return this.propertyHistoryCache;
    const onSale = new Set(
      this.workbook.properties
        .filter((p) => p.PropertyID !== '' && p.PropertyStatus !== 'Blocked')
        .map((p) => p.PropertyID),
    );
    const out: PropertyMonthMetrics[] = [];
    for (const month of this.series()) {
      for (const unit of computeByProperty(this.workbook, monthPeriod(month.monthKey))) {
        if (!onSale.has(unit.propertyId)) continue;
        out.push({
          propertyId: unit.propertyId,
          monthKey: month.monthKey,
          occupiedNights: unit.occupiedNights,
          adr: unit.adr,
          availableNights: unit.availableNights,
        });
      }
    }
    this.propertyHistoryCache = out;
    return out;
  }

  /**
   * ARCHITECTURE §9's four cash-flow terms, each taken from the register that owns it.
   *
   * Opening balance — cumulative net cash recorded before the month. That is exactly the
   * running balance the Cash Flow screen already shows ("cumulative from the start of the
   * ledger, not a restart at zero each month"), reused rather than redefined.
   *
   * Expected payouts — the booking's own payout, landing at check-out plus that
   * platform's lag from 02_SETTINGS. The forecast month is always in the future, so
   * nothing landing in it can already sit inside the opening balance; there is no
   * double-count to avoid. A recorded ActualPayout wins over the estimate when one
   * exists, because a known figure beats a derived one.
   *
   * Scheduled fixed costs — the 08_RENT_FIXED_COSTS obligation register, for agreements
   * live in that month. `escalationPct` is NOT applied: the register states no escalation
   * anniversary, and inventing one would move real money on a guess.
   *
   * Variable costs — 06_EXPENSES operating rows that are not `Fixed Operating`. The
   * contract draws that line itself, which is what keeps the fixed costs counted once
   * from the schedule instead of a second time through the average.
   */
  private cashFlowTerms(monthKey: string): {
    openingBalance: number;
    expectedPayouts: number;
    scheduledFixedCosts: number;
    variableCostsByMonth: Record<string, number>;
  } {
    const period = monthPeriod(monthKey);
    const { settings } = this.workbook;

    const openingBalance = this.workbook.cashflow
      .filter((t) => t.Date !== null && t.Date < period.start)
      .reduce((sum, t) => sum + t.MoneyIn - t.MoneyOut, 0);

    const expectedPayouts = this.workbook.reservations
      .filter((b) => (OCCUPANCY_STATUSES as readonly string[]).includes(b.BookingStatus))
      .reduce((sum, b) => {
        const lag = settings.platformPayoutLagDays[b.Platform] ?? 0;
        const lands = b.PayoutDate ?? (b.CheckOutDate === null ? null : b.CheckOutDate + lag);
        if (lands === null || lands < period.start || lands >= period.end) return sum;
        return sum + (b.ActualPayout > 0 ? b.ActualPayout : expectedPayout(b, settings));
      }, 0);

    const monthStartIso = serialToIso(period.start);
    const monthEndIso = serialToIso(period.end - 1);
    const scheduledFixedCosts = this.rent
      .filter((r) => r.agreementStart <= monthEndIso && (!r.agreementEnd || r.agreementEnd >= monthStartIso))
      .reduce((sum, r) => sum + r.monthlyAmount, 0);

    const variableCostsByMonth: Record<string, number> = {};
    for (const e of this.workbook.expenses) {
      if (e.Date === null || e.ExpenseType !== 'Operating') continue;
      if (e.ExpenseCategory === 'Fixed Operating') continue;
      const key = monthKeyOf(e.Date);
      variableCostsByMonth[key] = (variableCostsByMonth[key] ?? 0) + expenseTotal(e);
    }

    return { openingBalance, expectedPayouts, scheduledFixedCosts, variableCostsByMonth };
  }

  /**
   * ARCHITECTURE §9 — the month ahead, estimated.
   *
   * "Today" comes from the operations data, never the clock, so the same workbook always
   * yields the same forecast. The horizon is the month after the one being traded.
   *
   * `accuracy` backtests the residual-pickup basis on BOTH horizons: each past month is
   * re-estimated from the months before it with the books deliberately excluded, because
   * this read model carries no booking date and so cannot reconstruct what was on the
   * books at the time. (04_RESERVATIONS does have a `BookingDate` column; `ReservationRecord`
   * does not read it. Reading it would allow a faithful reconstruction — the one real
   * enhancement available here.) Counting today's reservations instead would make every
   * settled month look perfectly predicted, which is flattery rather than measurement.
   *
   * WHY NOTHING IS STORED — §9 says forecast-vs-actual "is retained each month so accuracy
   * becomes visible over time". Read against the rest of the architecture, that is a
   * requirement about visibility, not about a database:
   *
   *   - the subject of the sentence is "forecast vs actual", the COMPARISON, and §11 lists
   *     the Phase 8 deliverable as exactly that — "deterministic service, sufficiency
   *     gating, forecast-vs-actual" — with no store and no capture job;
   *   - a retained forecast is a financial figure. §1.3 says Supabase must never hold
   *     "any KPI or financial figure as a source", D3 repeats it ("identity/audit/
   *     sequences/AI logs only — never business data"), and §1.3's own test settles it:
   *     wiping Supabase must lose "only identity and history";
   *   - the workbook cannot hold it either. §5.6 forbids writing to 19_ANALYTICS and
   *     forbids inserting sheets or columns, and none of the 22 sheets is a forecast sheet;
   *   - §10.1 declares exactly two scheduled functions — a daily summary and an hourly
   *     alert sweep. No monthly capture exists anywhere in the design.
   *
   * So both candidate homes are closed by name, and the deliverable §11 names is the
   * comparison. Re-deriving it satisfies the stated purpose — accuracy visible month after
   * month — and violates nothing. What it costs is fidelity to the forecast AS ISSUED,
   * which is stated on the screen rather than glossed over.
   */
  forecast(): ForecastView {
    const asOf = isoToSerial(this.ops.today);
    const series = this.series();
    const monthKey = monthKeyOf(edate(monthKeyToSerial(this.ops.today.slice(0, 7)), 1));
    const request = {
      series,
      reservations: this.workbook.reservations,
      monthKey,
      asOf,
      activeUnits: activeUnitCount(this.workbook),
      propertyHistory: this.propertyHistory(),
    };
    const occupancy = forecastOccupancy(request);

    const settled = usableHistory(series, asOf);
    const perUnit = this.propertyHistory();
    const accuracy: ForecastAccuracy[] = [];
    for (let i = MINIMUM_USABLE_MONTHS; i < settled.length; i++) {
      const month = settled[i]!;
      const earlier = new Set(settled.slice(0, i).map((m) => m.monthKey));
      const backtest = {
        series: settled.slice(0, i),
        // The real books, filtered to what existed before the month being re-estimated.
        // Where the source records no booking date the engine counts none and says so,
        // rather than either fabricating dates or silently using today's bookings.
        reservations: this.workbook.reservations,
        onHandAsOf: month.monthStart,
        monthKey: month.monthKey,
        asOf: month.monthStart,
        activeUnits: month.activeUnits,
        // The per-unit rates as they stood BEFORE the month being re-estimated. Handing
        // the backtest the whole history would let it price a month with a rate the
        // estimate could not have known, which is the same flattery as counting today's
        // bookings.
        propertyHistory: perUnit.filter((h) => earlier.has(h.monthKey)),
      };
      const occupancyBacktest = forecastOccupancy(backtest);
      const estimates = [occupancyBacktest, forecastRevenue(backtest, occupancyBacktest)];
      for (const estimate of estimates) {
        const compared = forecastVsActual(estimate, series, asOf);
        if (compared) accuracy.push(compared);
      }
    }

    const cashflow = forecastCashFlow({
      series, monthKey, asOf, ...this.cashFlowTerms(monthKey),
    });

    return { monthKey, occupancy, revenue: forecastRevenue(request, occupancy), cashflow, accuracy };
  }

  monthsWithData(): string[] {
    return this.series()
      .filter((m) => m.grossRevenue > 0 || m.operatingExpenses > 0)
      .map((m) => m.monthKey);
  }

  /**
   * The month the application should open on: the one containing "today", when that month
   * carries data, otherwise the most recent month that does.
   *
   * Opening on the last month with data would be wrong on the first of a new month — and
   * in the demo it would mean the headline described one month while the operational panel
   * described a day in another.
   */
  currentMonth(): string {
    const available = this.monthsWithData();
    const todaysMonth = this.ops.today.slice(0, 7);
    if (available.includes(todaysMonth)) return todaysMonth;
    return available[available.length - 1] ?? this.series()[0]?.monthKey ?? '';
  }

  /** Fall back to the current month — never to an empty screen. */
  resolveMonth(month: string): string {
    const available = this.monthsWithData();
    if (available.includes(month)) return month;
    return this.currentMonth();
  }

  platforms(): string[] {
    return Object.keys(this.workbook.settings.platformCommission);
  }

  propertyIds(): string[] {
    return this.workbook.properties.map((p) => p.PropertyID);
  }

  /** Identity only — ID and Unit name from the master, no performance fields. */
  propertyDirectory(): Array<{ id: string; name: string }> {
    return this.workbook.properties.map((p) => ({ id: p.PropertyID, name: p.Unit }));
  }

  /* ---------------- dashboard ---------------- */

  dashboard(filters: ReportFilters): DashboardView {
    const month = this.resolveMonth(filters.month);
    const series = this.series();
    const index = series.findIndex((m) => m.monthKey === month);
    const current = series[index]!;
    const previous = index > 0 ? series[index - 1] : undefined;
    const period = monthPeriod(month);

    const properties = this.buildBoard(
      computeByProperty(this.workbook, period,
        filters.propertyId ? { propertyId: filters.propertyId } : undefined));
    const platforms = computeByPlatform(this.workbook, period, {
      ...(filters.platform ? { platform: filters.platform } : {}),
      ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
    });

    return {
      kpis: this.buildKpis(current, previous),
      properties,
      platforms,
      today: this.buildToday(),
      trend: this.buildTrend(series),
      availableMonths: this.monthsWithData(),
    };
  }

  /** KPI assembly: labels, formats and comparisons only — values come from the engine. */
  private buildKpis(current: MonthlyMetrics, previous?: MonthlyMetrics): KpiValue[] {
    const change = (now: number, before?: number): number | null => {
      if (before === undefined || before === 0) return null;
      return (now - before) / Math.abs(before);
    };

    const openMaintenance = this.openMaintenanceTickets().length;
    const rulesConfigured = this.workbook.settings.investorPoolPct !== null;
    // Derived from the allocation engine once the rules exist. Before that it is not a
    // zero at all — it is a figure that cannot be calculated yet, and says so.
    const pendingDistributions = rulesConfigured
      ? computeInvestorAllocations(this.workbook, current.monthKey)
        .reduce((total, allocation) => total + allocation.pendingAmount, 0)
      : 0;

    return [
      { key: 'totalUnits', label: 'Total Units', value: current.activeUnits, format: 'number',
        hint: 'Active units, excluding blocked' },
      { key: 'occupiedUnits', label: 'Occupied Units', value: this.occupiedUnitCount(), format: 'number',
        hint: 'Checked in right now' },
      { key: 'availableUnits', label: 'Available Units', value: Math.max(0, current.activeUnits - this.occupiedUnitCount()), format: 'number' },
      { key: 'occupancy', label: 'Occupancy', value: current.occupancyPct, format: 'percent',
        previousValue: previous?.occupancyPct ?? null, changeRatio: change(current.occupancyPct, previous?.occupancyPct),
        higherIsBetter: true, hint: 'Occupied ÷ available nights' },
      { key: 'adr', label: 'ADR', value: current.adr, format: 'currency',
        previousValue: previous?.adr ?? null, changeRatio: change(current.adr, previous?.adr),
        higherIsBetter: true, hint: 'Average daily rate' },
      { key: 'revpar', label: 'RevPAR', value: current.revPar, format: 'currency',
        previousValue: previous?.revPar ?? null, changeRatio: change(current.revPar, previous?.revPar),
        higherIsBetter: true, hint: 'Revenue per available night' },
      { key: 'mtdRevenue', label: 'MTD Revenue', value: current.netRevenue, format: 'currency',
        previousValue: previous?.netRevenue ?? null, changeRatio: change(current.netRevenue, previous?.netRevenue),
        higherIsBetter: true, hint: 'Net of platform fees, discounts and taxes' },
      { key: 'mtdExpenses', label: 'MTD Expenses', value: current.operatingExpenses, format: 'currency',
        previousValue: previous?.operatingExpenses ?? null, changeRatio: change(current.operatingExpenses, previous?.operatingExpenses),
        higherIsBetter: false, hint: 'Operating only — CAPEX excluded' },
      { key: 'mtdProfit', label: 'MTD Operating Profit', value: current.operatingProfit, format: 'currency',
        previousValue: previous?.operatingProfit ?? null, changeRatio: change(current.operatingProfit, previous?.operatingProfit),
        higherIsBetter: true },
      { key: 'margin', label: 'Operating Margin', value: current.operatingMarginPct, format: 'percent',
        previousValue: previous?.operatingMarginPct ?? null, changeRatio: change(current.operatingMarginPct, previous?.operatingMarginPct),
        higherIsBetter: true },
      { key: 'receivables', label: 'Pending Receivables', value: pendingReceivables(this.workbook), format: 'currency',
        higherIsBetter: false, hint: 'All periods - payouts not yet received' },
      { key: 'payables', label: 'Pending Payables', value: this.pendingPayables(), format: 'currency',
        higherIsBetter: false, hint: 'Unpaid bills' },
      {
        key: 'investorDistributions', label: 'Pending Investor Distributions',
        value: pendingDistributions, format: 'currency', higherIsBetter: false,
        hint: 'Calculated allocation not yet paid',
        // Not a zero outcome — the commercial rules do not exist yet.
        ...(rulesConfigured ? {} : { unavailable: CONFIG_REQUIRED }),
      },
      { key: 'openMaintenance', label: 'Open Maintenance Tickets', value: openMaintenance, format: 'number',
        higherIsBetter: false },
      // The month's cash movement, from the engine's own series (cashIn − cashOut is
      // computed there, not here) — the Pulse row's sixth figure per the C1 brief.
      { key: 'netCash', label: 'MTD Net Cash', value: current.netCash, format: 'currency',
        ...(previous ? { previousValue: previous.netCash } : {}),
        changeRatio: change(current.netCash, previous?.netCash),
        higherIsBetter: true, hint: 'Cash in less cash out this month' },
    ];
  }

  /** Units with a stay covering "today". */
  private occupiedUnitCount(): number {
    const today = isoToSerial(this.ops.today);
    const occupied = new Set<string>();
    for (const b of this.workbook.reservations) {
      if (b.BookingStatus !== 'Checked In' && b.BookingStatus !== 'Checked Out') continue;
      if (b.CheckInDate === null || b.CheckOutDate === null) continue;
      if (b.CheckInDate <= today && today < b.CheckOutDate) occupied.add(b.PropertyID);
    }
    return occupied.size;
  }

  private pendingPayables(): number {
    return pendingPayables(this.workbook, this.rent);
  }

  private openMaintenanceTickets(): MaintenanceTicket[] {
    return this.ops.maintenance.filter((t) => OPEN_MAINTENANCE_STATUSES.includes(t.status));
  }

  /**
   * TODAY counters — every one derived from a record, none authored. A counter the source
   * genuinely cannot supply is listed in `unavailable` so the UI shows "not tracked"
   * rather than a zero that reads like a real business outcome.
   */
  /**
   * @param dateIso the day the MOVEMENT counts describe. Defaults to the operational day,
   *   which is what the dashboard asks for. The remaining counters are live queues and do
   *   not move with it — see OperationsBoardView.isOperationalDay.
   */
  private buildToday(dateIso: string = this.ops.today): OperationsToday {
    const today = isoToSerial(dateIso);
    const arrivals = this.workbook.reservations.filter((b) => b.CheckInDate === today
      && (b.BookingStatus === 'Confirmed' || b.BookingStatus === 'Checked In')).length;
    const departures = this.workbook.reservations.filter((b) => b.CheckOutDate === today
      && (b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out')).length;
    return {
      date: dateIso,
      checkIns: arrivals,
      checkOuts: departures,
      pendingCleaning: this.ops.housekeeping.filter((t) => OPEN_HOUSEKEEPING_STATUSES.includes(t.status)).length,
      openMaintenance: this.openMaintenanceTickets().length,
      lowStock: this.ops.inventory.filter((i) => i.currentStock <= i.minStock).length,
      guestRequests: this.ops.guestRequests.filter((r) => r.status !== 'Resolved').length,
      unavailable: this.ops.unavailableCounters,
    };
  }

  /**
   * Unit status board. Precedence mirrors the V1 99_CALC property block:
   * Blocked -> Maintenance (open critical/high ticket) -> Occupied -> Cleaning -> Available.
   */
  private buildBoard(performance: ReturnType<typeof computeByProperty>): PropertyBoardRow[] {
    const today = isoToSerial(this.ops.today);
    const openCleaning = ['Pending', 'Assigned', 'In Progress'];
    return performance.map((row) => {
      const master = this.workbook.properties.find((p) => p.PropertyID === row.propertyId);
      const urgentTicket = this.openMaintenanceTickets().find(
        (t) => t.propertyId === row.propertyId && (t.priority === 'Critical' || t.priority === 'High'));
      const stay = this.workbook.reservations.find((b) =>
        b.PropertyID === row.propertyId && b.CheckInDate !== null && b.CheckOutDate !== null
        && b.CheckInDate <= today && today < b.CheckOutDate
        && (b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out'));
      const cleaning = this.ops.housekeeping.find(
        (t) => t.propertyId === row.propertyId && openCleaning.includes(t.status));

      let status: UnitStatus = 'Available';
      let statusDetail: string | null = null;
      if (master?.PropertyStatus === 'Blocked') {
        status = 'Blocked';
        statusDetail = 'Blocked in the property master';
      } else if (urgentTicket) {
        status = 'Maintenance';
        statusDetail = urgentTicket.description;
      } else if (stay && stay.CheckOutDate !== null) {
        status = 'Occupied';
        statusDetail = 'Departs ' + serialToIso(stay.CheckOutDate);
      } else if (cleaning) {
        status = 'Cleaning';
        statusDetail = 'Turnover ' + cleaning.status.toLowerCase();
      }

      const digits = row.propertyId.replace(/[^0-9]/g, '');
      return {
        ...row,
        bhkType: master?.BHKType ?? '',
        floor: Number(digits.slice(0, 1)) || 0,
        bedrooms: master?.BHKType === '2 BHK' ? 2 : 1,
        maxGuests: master?.MaxGuests ?? 0,
        listingStatus: master?.ListingStatus ?? '',
        status,
        statusDetail,
      };
    });
  }

  private buildTrend(series: MonthlyMetrics[]): TrendPoint[] {
    return series
      .filter((m) => m.grossRevenue > 0 || m.operatingExpenses > 0)
      .map((m) => ({
        month: m.monthKey,
        label: formatMonthLabel(m.monthKey),
        netRevenue: m.netRevenue,
        operatingExpenses: m.operatingExpenses,
        operatingProfit: m.operatingProfit,
        occupancyPct: m.occupancyPct,
        adr: m.adr,
        revPar: m.revPar,
      }));
  }

  /* ---------------- list views ---------------- */

  /** Performance plus master detail and live status — one row per unit. */
  properties(filters: ReportFilters): PropertyBoardRow[] {
    return this.buildBoard(
      computeByProperty(this.workbook, monthPeriod(this.resolveMonth(filters.month)),
        filters.propertyId ? { propertyId: filters.propertyId } : undefined));
  }

  /** The investor master. Selection only — no calculation, no scoping by identity. */
  investorRegister(): InvestorRegisterRow[] {
    return this.workbook.investors.map((investor) => ({
      investorId: investor.InvestorID,
      investorName: investor.InvestorName,
      investmentAmount: investor.InvestmentAmount,
      participationPct: investor.ParticipationPct,
      status: investor.Status,
    }));
  }

  /* ---------------- operations board ---------------- */

  /**
   * The operational picture for today: what needs a person, and who is arriving or leaving.
   *
   * Deliberately carries **no financial figure of any kind**. Operations holds no financial
   * capability, and a board showing revenue beside a cleaning task both leaks it and invites
   * the wrong decision at the wrong moment.
   */
  operations(filters: ReportFilters): OperationsBoardView {
    /*
     * Two dates, deliberately distinct. `operational` is the source's own day and governs
     * everything that is LIVE (ticket age, the queues, unit status). `selected` is the day
     * the reader asked for and governs the MOVEMENTS, which are genuinely addressable by
     * booking date. Conflating them would present today's cleaning list as history.
     */
    const operational = isoToSerial(this.ops.today);
    const selectedIso = resolveBoardDate(filters.date, this.ops.today);
    const selected = isoToSerial(selectedIso);
    const property = filters.propertyId ?? null;
    const matches = (id: string) => !property || id === property;

    const stay = (booking: ReservationRecord): ArrivalRow => ({
      bookingId: booking.BookingID,
      propertyId: booking.PropertyID,
      guestDisplayName: minimizeGuestName(booking.GuestName),
      nights: bookingNights(booking),
      guests: booking.Adults + booking.Children,
      platform: booking.Platform,
      status: booking.BookingStatus,
      checkIn: booking.CheckInDate === null ? null : serialToIso(booking.CheckInDate),
      checkOut: booking.CheckOutDate === null ? null : serialToIso(booking.CheckOutDate),
    });

    const arrivals = this.workbook.reservations
      .filter((b) => b.CheckInDate === selected && matches(b.PropertyID))
      .filter((b) => b.BookingStatus === 'Confirmed' || b.BookingStatus === 'Checked In')
      .map(stay);

    const departures = this.workbook.reservations
      .filter((b) => b.CheckOutDate === selected && matches(b.PropertyID))
      .filter((b) => b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out')
      .map(stay);

    const cleaning = this.ops.housekeeping
      .filter((t) => OPEN_HOUSEKEEPING_STATUSES.includes(t.status) && matches(t.propertyId))
      .map<CleaningRow>((t) => ({
        taskId: t.taskId, propertyId: t.propertyId, checkoutDate: t.checkoutDate, status: t.status,
      }));

    const maintenance = this.openMaintenanceTickets()
      .filter((t) => matches(t.propertyId))
      .map<MaintenanceRow>((t) => ({
        ticketId: t.ticketId, propertyId: t.propertyId, category: t.category,
        description: t.description, priority: t.priority, status: t.status,
        reportedOn: t.reportedOn,
        // Age is measured from the real day, never from a browsed one.
        ageDays: t.reportedOn ? Math.max(0, operational - isoToSerial(t.reportedOn)) : 0,
      }))
      .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
        || b.ageDays - a.ageDays);

    const lowStock = this.ops.inventory
      .filter((i) => i.currentStock <= i.minStock && matches(i.propertyId))
      .map<StockRow>((i) => ({
        itemId: i.itemId, propertyId: i.propertyId, item: i.item, unit: i.unit,
        currentStock: i.currentStock, minStock: i.minStock,
        state: i.currentStock <= 0 ? 'Out of stock' : 'Low',
      }))
      .sort((a, b) => (a.currentStock / Math.max(1, a.minStock))
        - (b.currentStock / Math.max(1, b.minStock)));

    const stock = this.ops.inventory
      .filter((i) => matches(i.propertyId))
      .map<StockRow>((i) => ({
        itemId: i.itemId, propertyId: i.propertyId, item: i.item, unit: i.unit,
        currentStock: i.currentStock, minStock: i.minStock,
        state: i.currentStock <= 0 ? 'Out of stock' : i.currentStock <= i.minStock ? 'Low' : 'In stock',
      }))
      .sort((a, b) => a.item.localeCompare(b.item));

    const guestRequests = this.ops.guestRequests
      .filter((r) => r.status !== 'Resolved' && matches(r.propertyId))
      .map<GuestRequestRow>((r) => ({
        requestId: r.requestId, propertyId: r.propertyId, summary: r.summary,
        raisedOn: r.raisedOn, status: r.status,
      }));

    return {
      date: selectedIso,
      operationalDate: this.ops.today,
      isOperationalDay: selectedIso === this.ops.today,
      counters: this.buildToday(selectedIso),
      urgent: this.buildUrgent(maintenance, cleaning, lowStock, guestRequests, arrivals),
      arrivals,
      departures,
      cleaning,
      maintenance,
      lowStock,
      stock,
      guestRequests,
      units: this.properties(filters).map((row) => ({
        propertyId: row.propertyId, unit: row.unit,
        status: row.status, statusDetail: row.statusDetail,
      })),
    };
  }

  /**
   * What needs a person, most pressing first.
   *
   * Each entry says what happened AND what to do about it. A list that only names problems
   * leaves the reader to work out the response, which on a morning board is the wrong
   * division of labour.
   */
  private buildUrgent(
    maintenance: MaintenanceRow[],
    cleaning: CleaningRow[],
    lowStock: StockRow[],
    guestRequests: GuestRequestRow[],
    arrivals: ArrivalRow[],
  ): UrgentItem[] {
    const items: UrgentItem[] = [];

    for (const ticket of maintenance) {
      if (ticket.priority !== 'Critical' && ticket.priority !== 'High') continue;
      items.push({
        key: `mnt-${ticket.ticketId}`,
        severity: ticket.priority === 'Critical' ? 'critical' : 'high',
        propertyId: ticket.propertyId,
        title: `${ticket.priority} maintenance — ${ticket.description}`,
        action: ticket.priority === 'Critical'
          ? 'Take the unit off-market and get a technician on site today.'
          : 'Assign a technician and confirm the guest is not affected.',
        reference: ticket.ticketId,
      });
    }

    for (const task of cleaning) {
      if (task.status !== 'Failed Inspection') continue;
      items.push({
        key: `hk-${task.taskId}`,
        severity: 'high',
        propertyId: task.propertyId,
        title: 'Housekeeping failed inspection',
        action: 'Re-clean and re-inspect before the unit is sold again.',
        reference: task.taskId,
      });
    }

    for (const stock of lowStock) {
      if (stock.state !== 'Out of stock') continue;
      items.push({
        key: `inv-${stock.itemId}`,
        severity: 'high',
        propertyId: stock.propertyId,
        title: `Out of stock — ${stock.item}`,
        action: 'Reorder today; turnovers cannot be completed without it.',
        reference: stock.itemId,
      });
    }

    // An arrival still marked Confirmed needs someone to meet it.
    for (const arrival of arrivals) {
      if (arrival.status !== 'Confirmed') continue;
      items.push({
        key: `arr-${arrival.bookingId}`,
        severity: 'watch',
        propertyId: arrival.propertyId,
        title: `Arrival today — ${arrival.guestDisplayName}, ${arrival.nights} night${arrival.nights === 1 ? '' : 's'}`,
        action: 'Confirm the unit is ready and the guest has check-in instructions.',
        reference: arrival.bookingId,
      });
    }

    for (const request of guestRequests) {
      items.push({
        key: `req-${request.requestId}`,
        severity: 'watch',
        propertyId: request.propertyId,
        title: `Guest request — ${request.summary}`,
        action: 'Reply to the guest and close the request.',
        reference: request.requestId,
      });
    }

    const order: Record<UrgentSeverity, number> = { critical: 0, high: 1, watch: 2 };
    return items.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  /**
   * The reservations register, in one of two scopes.
   *
   * MONTH (default) selects bookings by ARRIVAL — check-in inside the reporting month.
   * That is what the register has always meant and what the finance ledger totals.
   *
   * IN-PROGRESS selects bookings whose stay COVERS the selected day, whenever they
   * arrived. The month scope structurally cannot answer "who is in the house right now",
   * because a guest who checked in on the 28th of last month has no check-in date in this
   * one — they are simply absent from the list while standing in the building.
   *
   * The span test is the half-open interval the engine already uses for occupancy
   * (`occupiedUnitCount`, `buildBoard`): check-in on or before the day, check-out strictly
   * after it, so a same-day turnover counts once rather than twice. The status set is
   * OCCUPANCY_STATUSES — the domain's own definition of a stay that really happened.
   * Neither rule is invented here; both are read from where they already live.
   */
  reservations(filters: ReportFilters): ReservationRow[] {
    const period = monthPeriod(this.resolveMonth(filters.month));
    // Resolved the same way the Today board resolves it, so a malformed or impossible
    // date falls back to the operational day instead of reaching this query.
    const selected = isoToSerial(resolveBoardDate(filters.date, this.ops.today));
    const inProgress = filters.scope === 'in-progress';

    const covers = (b: ReservationRecord): boolean =>
      b.CheckInDate !== null && b.CheckOutDate !== null
      && b.CheckInDate <= selected && selected < b.CheckOutDate
      && OCCUPANCY_STATUSES.includes(b.BookingStatus as (typeof OCCUPANCY_STATUSES)[number]);

    const arrivesInMonth = (b: ReservationRecord): boolean =>
      b.CheckInDate !== null && b.CheckInDate >= period.start && b.CheckInDate < period.end;

    return this.workbook.reservations
      .filter((b) => (inProgress ? covers(b) : arrivesInMonth(b)))
      .filter((b) => !filters.propertyId || b.PropertyID === filters.propertyId)
      .filter((b) => !filters.platform || b.Platform === filters.platform)
      .map<ReservationRow>((b) => {
        const expected = expectedPayout(b, this.workbook.settings);
        return {
          bookingId: b.BookingID,
          platform: b.Platform,
          propertyId: b.PropertyID,
          bookingStatus: b.BookingStatus,
          guestDisplayName: minimizeGuestName(b.GuestName),
          checkIn: b.CheckInDate === null ? null : serialToIso(b.CheckInDate),
          checkOut: b.CheckOutDate === null ? null : serialToIso(b.CheckOutDate),
          nights: bookingNights(b),
          grossValue: grossBookingValue(b),
          expectedPayout: expected,
          actualPayout: b.ActualPayout,
          payoutStatus: derivePayoutStatus(b.BookingStatus, expected, b.ActualPayout,
            this.workbook.settings.payoutToleranceInr),
        };
      })
      .sort((a, b) => (a.checkIn ?? '').localeCompare(b.checkIn ?? ''));
  }

  /**
   * ONE booking, in full. Not month-scoped: a detail link has to work from anywhere,
   * including a pasted URL for a stay that began in another period.
   *
   * Built from the SAME mapping the list uses, plus the front-office columns no
   * calculation depends on. `null` is used for every unrecorded field — a blank cell is
   * a check nobody made, and rendering it as "No" would assert something the workbook
   * does not say.
   */
  bookingDetail(bookingId: string): BookingDetailRow | null {
    const booking = this.workbook.reservations.find((b) => b.BookingID === bookingId);
    if (!booking) return null;

    const master = this.workbook.properties.find((p) => p.PropertyID === booking.PropertyID);
    const expected = expectedPayout(booking, this.workbook.settings);
    const flag = (value: boolean | undefined): boolean | null => value ?? null;
    const text = (value: string | undefined): string | null => (value && value.trim() !== '' ? value : null);

    return {
      bookingId: booking.BookingID,
      platform: booking.Platform,
      propertyId: booking.PropertyID,
      bookingStatus: booking.BookingStatus,
      guestDisplayName: minimizeGuestName(booking.GuestName),
      checkIn: booking.CheckInDate === null ? null : serialToIso(booking.CheckInDate),
      checkOut: booking.CheckOutDate === null ? null : serialToIso(booking.CheckOutDate),
      nights: bookingNights(booking),
      grossValue: grossBookingValue(booking),
      expectedPayout: expected,
      actualPayout: booking.ActualPayout,
      payoutStatus: derivePayoutStatus(booking.BookingStatus, expected, booking.ActualPayout,
        this.workbook.settings.payoutToleranceInr),

      unitName: master?.Unit ?? '',
      adults: booking.Adults,
      children: booking.Children,
      guests: booking.Adults + booking.Children,
      platformRef: booking.PlatformResID,
      bookedOn: booking.BookingDate === null ? null : serialToIso(booking.BookingDate),
      checkInTime: text(booking.CheckInTime),
      checkOutTime: text(booking.CheckOutTime),
      earlyCheckIn: flag(booking.EarlyCheckIn),
      lateCheckout: flag(booking.LateCheckout),
      guestVerification: text(booking.GuestVerification),
      damageReport: text(booking.DamageReport),
      maintenanceRequired: flag(booking.MaintenanceRequired),
      notes: text(booking.Notes),
    };
  }

  revenue(filters: ReportFilters): LedgerRow[] {
    const period = monthPeriod(this.resolveMonth(filters.month));
    return this.workbook.revenue
      .filter((r) => r.Date !== null && r.Date >= period.start && r.Date < period.end)
      .filter((r) => !filters.propertyId || r.PropertyID === filters.propertyId)
      .filter((r) => !filters.platform || r.Platform === filters.platform)
      .map<LedgerRow>((r) => ({
        id: r.RevenueID,
        date: r.Date === null ? null : serialToIso(r.Date),
        propertyId: r.PropertyID,
        category: r.RevenueType,
        platform: r.Platform,
        gross: r.GrossAmount,
        deductions: r.Discount + r.Tax + r.PlatformFee + r.OtherDeduction,
        net: revenueNet(r),
        status: r.PayoutStatus,
      }))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  }

  expenses(filters: ReportFilters): LedgerRow[] {
    const period = monthPeriod(this.resolveMonth(filters.month));
    return this.workbook.expenses
      .filter((e) => e.Date !== null && e.Date >= period.start && e.Date < period.end)
      .filter((e) => !filters.propertyId || e.PropertyID === filters.propertyId)
      .map<LedgerRow>((e) => ({
        id: e.ExpenseID,
        date: e.Date === null ? null : serialToIso(e.Date),
        propertyId: e.PropertyID,
        category: e.ExpenseCategory,
        subCategory: e.ExpenseSubcategory,
        gross: e.Amount,
        deductions: e.Tax,
        net: expenseTotal(e),
        status: e.PaymentStatus,
      }))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  }

  capex(filters: ReportFilters): CapexRow[] {
    const period = monthPeriod(this.resolveMonth(filters.month));
    return this.workbook.capex
      .filter((c) => c.Date !== null && c.Date >= period.start && c.Date < period.end)
      .filter((c) => !filters.propertyId || c.PropertyID === filters.propertyId)
      .map<CapexRow>((c) => ({
        id: c.CapexID,
        date: c.Date === null ? null : serialToIso(c.Date),
        propertyId: c.PropertyID,
        category: c.Category,
        item: c.Item ?? '',
        quantity: c.Quantity,
        unitCost: c.UnitCost,
        lineTotal: capexLineTotal(c),
        status: c.PaymentStatus ?? '',
      }))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  }

  cashflow(filters: ReportFilters): CashFlowRow[] {
    const period = monthPeriod(this.resolveMonth(filters.month));

    // Running balance is cumulative from the start of the ledger, so the opening balance
    // is everything before this period — not a restart at zero each month.
    const ordered = [...this.workbook.cashflow].sort((a, b) => (a.Date ?? 0) - (b.Date ?? 0));
    let balance = 0;
    const rows: CashFlowRow[] = [];
    for (const txn of ordered) {
      balance += txn.MoneyIn - txn.MoneyOut;
      if (txn.Date === null || txn.Date < period.start || txn.Date >= period.end) continue;
      if (filters.propertyId && txn.PropertyID !== filters.propertyId) continue;
      rows.push({
        txnId: txn.TxnID,
        date: serialToIso(txn.Date),
        type: txn.Type,
        propertyId: txn.PropertyID,
        moneyIn: txn.MoneyIn,
        moneyOut: txn.MoneyOut,
        runningBalance: balance,
        reconStatus: txn.ReconStatus,
      });
    }
    return rows.reverse();
  }

  pnl(): PnlView {
    const series = this.series().filter((m) => m.grossRevenue > 0 || m.operatingExpenses > 0);
    const months = series.map((m) => m.monthKey);

    const pick = (fn: (m: MonthlyMetrics) => number) => series.map(fn);
    const sum = (values: number[]) => values.reduce((t, v) => t + v, 0);
    const line = (key: string, label: string, values: number[], emphasis?: PnlLine['emphasis'],
      extra: Partial<PnlLine> = {}): PnlLine =>
      ({ key, label, values, total: sum(values), ...(emphasis ? { emphasis } : {}), ...extra });

    // Expense lines use the V1 P&L mapping from the generated contract — not a second
    // categorisation invented for the UI.
    const expenseLines = Object.entries(PNL_CONTRACT.expenseLines).map(([key, subs]) => {
      const values = series.map((m) => {
        const period = monthPeriod(m.monthKey);
        return this.workbook.expenses
          .filter((e) => e.ExpenseType === 'Operating'
            && e.Date !== null && e.Date >= period.start && e.Date < period.end
            && (subs as readonly string[]).includes(e.ExpenseSubcategory))
          .reduce((t, e) => t + expenseTotal(e), 0);
      });
      return line(key, humanizeKey(key), values);
    });

    const mappedTotals = series.map((_, i) => expenseLines.reduce((t, l) => t + (l.values[i] ?? 0), 0));
    const otherOperating = series.map((m, i) => m.operatingExpenses - (mappedTotals[i] ?? 0));

    const lines: PnlLine[] = [
      line('roomRevenue', 'Room Revenue', pick((m) => m.roomRevenue)),
      line('cleaningRevenue', 'Cleaning Revenue', pick((m) => m.cleaningRevenue)),
      line('otherRevenue', 'Other Revenue', pick((m) => m.otherRevenue)),
      line('grossRevenue', 'Gross Revenue', pick((m) => m.grossRevenue), 'subtotal'),
      line('discounts', 'Less: Discounts', pick((m) => -m.discounts)),
      line('platformFees', 'Less: Platform Fees', pick((m) => -m.platformFees)),
      line('taxes', 'Less: Taxes', pick((m) => -m.taxes)),
      line('netRevenue', 'Net Revenue', pick((m) => m.netRevenue), 'subtotal'),
      line('opexHeader', 'Operating Expenses', series.map(() => 0), 'section'),
      ...expenseLines,
      line('otherOperating', 'Other Operating', otherOperating),
      line('totalOpex', 'Total Operating Expenses', pick((m) => m.operatingExpenses), 'subtotal'),
      line('operatingProfit', 'Operating Profit', pick((m) => m.operatingProfit), 'total'),
      line('margin', 'Operating Margin', pick((m) => m.operatingMarginPct), undefined, { isPercent: true }),
      line('memoHeader', 'Memo — outside operating profit', series.map(() => 0), 'section'),
      line('capex', 'CAPEX / setup spend', pick((m) => m.capexTotal), undefined, { memo: true }),
      line('netCash', 'Net cash movement', pick((m) => m.netCash), undefined, { memo: true }),
    ];

    return { months, monthLabels: months.map(formatMonthLabel), lines };
  }

  investorPreview(filters: ReportFilters): InvestorPreviewView {
    const month = this.resolveMonth(filters.month);
    const waterfall = computeInvestorWaterfall(this.workbook, month);
    return {
      waterfall,
      allocations: computeInvestorAllocations(this.workbook, month),
      configured: waterfall.configured,
      configurationMessage: waterfall.configurationMessage,
    };
  }

  settings(): SettingsView {
    const s = this.workbook.settings;
    const ruleValue = (name: string): { value: string; configured: boolean } => {
      switch (name) {
        case 'CFG_INVESTOR_POOL_PCT': return pct(s.investorPoolPct);
        case 'CFG_OPERATOR_POOL_PCT': return pct(s.operatorPoolPct);
        case 'CFG_RESERVE_PCT': return pct(s.reservePct);
        case 'CFG_MGMT_FEE_PCT': return pct(s.mgmtFeePct);
        case 'CFG_LOSS_TREATMENT': return text(s.lossTreatment);
        case 'CFG_PROFIT_DEFINITION': return text(s.profitDefinition);
        default: return { value: 'TBD', configured: false };
      }
    };
    return {
      // Identity comes from the workbook's own CFG_* cells, not from a constant here.
      businessName: s.businessName,
      city: s.city,
      country: s.country,
      currency: s.currency,
      fyStart: serialToIso(s.fyStart),
      platforms: Object.entries(s.platformCommission).map(([name, commissionPct]) => ({
        name, commissionPct, payoutLagDays: s.platformPayoutLagDays[name] ?? 0,
      })),
      businessRules: BUSINESS_RULES.map((rule) => {
        const { value, configured } = ruleValue(rule.name);
        return { name: rule.name, label: rule.label, value, configured, recordedOnly: rule.recordedOnly };
      }),
    };
  }

  /** The period a settings payload describes — the FY it opens. */
  settingsPeriod(): string {
    return monthKeyOf(this.workbook.settings.fyStart);
  }
}

/* ------------------------------------------------------------------ *
 * Small shaping helpers (no business logic)
 * ------------------------------------------------------------------ */

const pct = (v: number | null) => v === null
  ? { value: 'TBD', configured: false }
  : { value: `${(v * 100).toFixed(1)}%`, configured: true };

const text = (v: string) => (!v || v === 'TBD')
  ? { value: 'TBD', configured: false }
  : { value: v, configured: true };

export function formatMonthLabel(monthKey: string): string {
  const serial = monthKeyToSerial(monthKey);
  const date = new Date(Date.UTC(2000, 0, 1));
  const [year, month] = monthKey.split('-');
  date.setUTCFullYear(Number(year), Number(month) - 1, 1);
  void serial;
  return date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace('Rent Line', 'Rent & Society Maintenance')
    .replace('Housekeeping Laundry', 'Housekeeping & Laundry')
    .replace('Repairs Maint', 'Repairs & Maintenance')
    .replace('Software Accounting', 'Software & Accounting')
    .replace('Payment Ota Fees', 'Payment & OTA Fees')
    .trim();
}

/** Mirrors the V1 PayoutStatus column semantics for display purposes. */
function derivePayoutStatus(status: string, expected: number, actual: number, tolerance: number): string {
  if (status === 'Cancelled' || status === 'No Show' || status === 'Inquiry') return '—';
  if (actual > 0 && actual >= expected - tolerance) return 'Received';
  if (actual > 0) return 'Partial';
  if (status === 'Checked Out') return 'Awaiting';
  return 'Pending';
}
