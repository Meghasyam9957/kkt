/**
 * FIXTURE PROVIDER.
 *
 * Supplies the demo workbook, then hands it to `WorkbookViews` — the same shaping layer
 * the Google Sheets provider uses, running the same KPI engine. This file therefore holds
 * no calculation and no shaping of its own: it is a *source*, nothing more.
 *
 * That is what makes the eventual switch to live data a non-event. A test asserts it
 * directly: both providers, given identical rows, return byte-identical views.
 */
import type {
  WorkbookData, MonthlyMetrics, OperationsData, RentRecord,
} from '@/lib/shared/domain';
import { WorkbookViews, minimizeGuestName, formatMonthLabel } from '@/lib/data/views/workbook-views';
import { buildDemoWorkbook, buildDemoOps } from '../fixtures/workbook';
import { edate } from '@/lib/shared/dates';
import type {
  DashboardDataProvider, DashboardView, Envelope, ReportFilters, DataMeta,
  ReservationRow, LedgerRow, CapexRow, CashFlowRow, PnlView, SettingsView, InvestorPreviewView,
  BookingDetailRow, CalendarView, AvailabilityQuery, AvailabilitySearchView,
  ForecastView,
} from './types';

export interface FixtureProviderOptions {
  /** Injected for deterministic tests. */
  now?: () => Date;
  /** Simulated latency, so skeleton states can be exercised in development. */
  latencyMs?: number;
  workbook?: WorkbookData;
  ops?: OperationsData;
  /** 08_RENT_FIXED_COSTS — feeds Pending Payables, as it does in 99_CALC. */
  rent?: readonly RentRecord[];
}

export class FixtureDashboardDataProvider implements DashboardDataProvider {
  readonly kind = 'FIXTURE' as const;
  private readonly views: WorkbookViews;
  private readonly now: () => Date;
  private readonly latencyMs: number;

  constructor(options: FixtureProviderOptions = {}) {
    this.views = new WorkbookViews({
      workbook: options.workbook ?? buildDemoWorkbook(),
      ops: options.ops ?? buildDemoOps(),
      rent: options.rent ?? [],
    });
    this.now = options.now ?? (() => new Date());
    this.latencyMs = options.latencyMs ?? 0;
  }

  /* ---------------- infrastructure ---------------- */

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private meta(period: string): DataMeta {
    const asOf = this.now().toISOString();
    return {
      source: 'FIXTURE',
      asOf,
      period,
      freshness: 'GOOD',
      demo: true,
      // Fixtures are generated on demand, so "last successful sync" is simply now. The
      // field exists on every envelope so the header renders the same way either way.
      lastSuccessfulSyncAt: asOf,
      ageSeconds: 0,
      cache: 'MISS',
    };
  }

  private wrap<T>(data: T, period: string): Envelope<T> {
    return { data, meta: this.meta(period) };
  }

  /* ---------------- views ---------------- */

  async getDashboard(filters: ReportFilters): Promise<Envelope<DashboardView>> {
    await this.delay();
    return this.wrap(this.views.dashboard(filters), this.views.resolveMonth(filters.month));
  }

  async getProperties(filters: ReportFilters) {
    await this.delay();
    return this.wrap(this.views.properties(filters), this.views.resolveMonth(filters.month));
  }

  async getReservations(filters: ReportFilters): Promise<Envelope<ReservationRow[]>> {
    await this.delay();
    return this.wrap(this.views.reservations(filters), this.views.resolveMonth(filters.month));
  }

  async getBookingDetail(bookingId: string): Promise<Envelope<BookingDetailRow | null>> {
    await this.delay();
    return this.wrap(this.views.bookingDetail(bookingId), this.views.resolveMonth(''));
  }

  async getCalendar(filters: ReportFilters): Promise<Envelope<CalendarView>> {
    await this.delay();
    return this.wrap(this.views.calendar(filters), this.views.resolveMonth(filters.month));
  }

  async getAvailability(query: AvailabilityQuery): Promise<Envelope<AvailabilitySearchView>> {
    await this.delay();
    return this.wrap(this.views.availability(query), this.views.resolveMonth(''));
  }

  async getRevenue(filters: ReportFilters): Promise<Envelope<LedgerRow[]>> {
    await this.delay();
    return this.wrap(this.views.revenue(filters), this.views.resolveMonth(filters.month));
  }

  async getExpenses(filters: ReportFilters): Promise<Envelope<LedgerRow[]>> {
    await this.delay();
    return this.wrap(this.views.expenses(filters), this.views.resolveMonth(filters.month));
  }

  async getCapex(filters: ReportFilters): Promise<Envelope<CapexRow[]>> {
    await this.delay();
    return this.wrap(this.views.capex(filters), this.views.resolveMonth(filters.month));
  }

  async getCashFlow(filters: ReportFilters): Promise<Envelope<CashFlowRow[]>> {
    await this.delay();
    return this.wrap(this.views.cashflow(filters), this.views.resolveMonth(filters.month));
  }

  async getPnl(filters: ReportFilters): Promise<Envelope<PnlView>> {
    await this.delay();
    return this.wrap(this.views.pnl(), this.views.resolveMonth(filters.month));
  }

  async getMonthlySeries(filters: ReportFilters): Promise<Envelope<MonthlyMetrics[]>> {
    await this.delay();
    return this.wrap(this.views.series(), this.views.resolveMonth(filters.month));
  }

  async getForecast(filters: ReportFilters): Promise<Envelope<ForecastView>> {
    await this.delay();
    return this.wrap(this.views.forecast(), this.views.resolveMonth(filters.month));
  }

  async getInvestorPreview(filters: ReportFilters): Promise<Envelope<InvestorPreviewView>> {
    await this.delay();
    return this.wrap(this.views.investorPreview(filters), this.views.resolveMonth(filters.month));
  }

  async getSettings(): Promise<Envelope<SettingsView>> {
    await this.delay();
    return this.wrap(this.views.settings(), this.views.settingsPeriod());
  }

  async getAvailableMonths(): Promise<string[]> {
    return this.views.monthsWithData();
  }

  async getPlatforms(): Promise<string[]> {
    return this.views.platforms();
  }

  async getOperations(filters: ReportFilters) {
    await this.delay();
    return this.wrap(this.views.operations(filters), this.views.resolveMonth(filters.month));
  }

  async getInvestorRegister() {
    await this.delay();
    return this.wrap(this.views.investorRegister(), this.views.currentMonth());
  }

  async getPropertyIds(): Promise<string[]> {
    return this.views.propertyIds();
  }

  async getPropertyDirectory() {
    return this.views.propertyDirectory();
  }

  async getSourceMeta(): Promise<DataMeta> {
    return this.meta(this.views.currentMonth());
  }
}

export { minimizeGuestName, formatMonthLabel, edate };
