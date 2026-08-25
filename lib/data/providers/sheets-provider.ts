import '@/lib/server/only';
/**
 * GOOGLE SHEETS DATA PROVIDER — the live source.
 *
 * It is deliberately thin. It fetches rows, hands them to `WorkbookViews` (the same
 * shaping layer the fixture provider uses, over the same KPI engine) and attaches
 * provenance. It contains no calculation, no shaping and no view logic, because any of
 * those would be a second implementation that could disagree with the demo.
 *
 * What it does own:
 *   - reading through the bounded server-side cache, so a page view is not a Sheets read;
 *   - honest freshness: after a failed fetch it serves the last good data, marked stale,
 *     with the error attached — it never presents old figures as current;
 *   - failing loudly when the workbook cannot be read at all, rather than degrading to
 *     something that looks like data.
 *
 * It never writes. The reporting month is a parameter here, never a cell — reading
 * CFG_REPORT_MONTH-dependent blocks would mean writing shared state (Decision D1).
 */
import {
  loadWorkbookData, loadOperationsData, loadRentRegister,
} from '@/lib/server/sheets/repositories';
import type { GoogleSheetsClient } from '@/lib/server/sheets/client';
import { ReadCache, configuredTtlMs, type CacheResult } from '@/lib/server/cache/read-cache';
import { WorkbookViews, type ViewSource } from '@/lib/data/views/workbook-views';
import type { MonthlyMetrics } from '@/lib/shared/domain';
import type {
  DashboardDataProvider, DashboardView, Envelope, ReportFilters, DataMeta, FreshnessState,
  ReservationRow, LedgerRow, CapexRow, CashFlowRow, PnlView, SettingsView, InvestorPreviewView,
  ForecastView,
} from './types';

/** The workbook is one cache entry; the views slice it. One read serves every screen. */
const WORKBOOK_RESOURCE = 'workbook';

export interface SheetsProviderOptions {
  client: GoogleSheetsClient;
  /** Shared across providers in a process. Defaults to a cache with the configured TTL. */
  cache?: ReadCache;
  now?: () => Date;
  /**
   * Civil timezone the operation runs in. "Today" on an operations board means today in
   * Hyderabad, not on whichever host the server happens to sit.
   */
  timeZone?: string;
}

export class GoogleSheetsDashboardDataProvider implements DashboardDataProvider {
  readonly kind = 'GOOGLE_SHEETS' as const;
  private readonly client: GoogleSheetsClient;
  private readonly cache: ReadCache;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private lastSuccessfulSyncAt: string | null = null;
  /**
   * The most recent fetch failure, cleared only by a fetch that succeeds. It outlives the
   * request that hit it on purpose: if the workbook is unreachable, every screen should
   * say so, not just the unlucky one that happened to trigger the read.
   */
  private lastError: Error | null = null;

  constructor(options: SheetsProviderOptions) {
    this.client = options.client;
    this.cache = options.cache ?? new ReadCache({ ttlMs: configuredTtlMs() });
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? 'Asia/Kolkata';
  }

  /* ---------------- source ---------------- */

  /** Today's civil date where the properties actually are. */
  private today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(this.now());
  }

  /**
   * The whole workbook plus the operational sheets, in three batched round trips, behind
   * the cache. Every view is derived from this one payload, so a page render costs at
   * most one source read regardless of how many sections it draws.
   */
  private async source(refresh = false): Promise<CacheResult<ViewSource>> {
    const today = this.today();
    const result = await this.cache.get<ViewSource>(
      // `today` is part of the key: the operational board means something different
      // tomorrow, so yesterday's entry must not answer for it.
      { resource: WORKBOOK_RESOURCE, identity: null, filters: { today } },
      async () => {
        const [workbook, ops, rent] = await Promise.all([
          loadWorkbookData(this.client),
          loadOperationsData(this.client, today),
          loadRentRegister(this.client),
        ]);
        return { workbook, ops, rent };
      },
      { refresh },
    );
    if (result.error) {
      this.lastError = result.error;
    } else if (result.outcome !== 'HIT') {
      // Only an ACTUAL read clears the failure flag. A cache hit means nothing was
      // fetched, so it is no evidence that the source has come back — clearing here
      // would let the header quietly return to "Live" while the workbook is still down.
      this.lastError = null;
      this.lastSuccessfulSyncAt = result.storedAt.toISOString();
    }
    return result;
  }

  private async views(): Promise<{ views: WorkbookViews; result: CacheResult<ViewSource> }> {
    let result: CacheResult<ViewSource>;
    try {
      result = await this.source();
    } catch (error) {
      // No cached data and the source is unreachable. Say so plainly; never substitute
      // fixtures, and never leak a credential or a spreadsheet id into the message.
      throw new LiveDataUnavailableError(error);
    }
    return { views: new WorkbookViews(result.value), result };
  }

  /** Force a real read of the source, replacing anything cached. */
  async refresh(): Promise<void> {
    await this.source(true);
  }

  private meta(result: CacheResult<ViewSource>, period: string): DataMeta {
    const error = result.error ?? this.lastError;
    /*
     * Three states, and the middle one is the one that matters:
     *   GOOD  — within TTL and the source is confirmed reachable.
     *   STALE — either the payload is past its TTL, or the last fetch attempt failed.
     *           The figures may still be recent, but the source is not confirmed, so the
     *           header must not call them live.
     *   ERROR — past TTL AND failing. This is genuinely old data.
     */
    const freshness: FreshnessState = result.stale
      ? (error ? 'ERROR' : 'STALE')
      : (error ? 'STALE' : 'GOOD');
    return {
      source: 'GOOGLE_SHEETS',
      asOf: result.storedAt.toISOString(),
      period,
      freshness,
      demo: false,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      ageSeconds: Math.round(result.ageMs / 1000),
      cache: result.outcome,
      error: error ? describeError(error) : null,
    };
  }

  private wrap<T>(data: T, result: CacheResult<ViewSource>, period: string): Envelope<T> {
    return { data, meta: this.meta(result, period) };
  }

  /* ---------------- views ---------------- */

  async getDashboard(filters: ReportFilters): Promise<Envelope<DashboardView>> {
    const { views, result } = await this.views();
    return this.wrap(views.dashboard(filters), result, views.resolveMonth(filters.month));
  }

  async getProperties(filters: ReportFilters) {
    const { views, result } = await this.views();
    return this.wrap(views.properties(filters), result, views.resolveMonth(filters.month));
  }

  async getReservations(filters: ReportFilters): Promise<Envelope<ReservationRow[]>> {
    const { views, result } = await this.views();
    return this.wrap(views.reservations(filters), result, views.resolveMonth(filters.month));
  }

  async getRevenue(filters: ReportFilters): Promise<Envelope<LedgerRow[]>> {
    const { views, result } = await this.views();
    return this.wrap(views.revenue(filters), result, views.resolveMonth(filters.month));
  }

  async getExpenses(filters: ReportFilters): Promise<Envelope<LedgerRow[]>> {
    const { views, result } = await this.views();
    return this.wrap(views.expenses(filters), result, views.resolveMonth(filters.month));
  }

  async getCapex(filters: ReportFilters): Promise<Envelope<CapexRow[]>> {
    const { views, result } = await this.views();
    return this.wrap(views.capex(filters), result, views.resolveMonth(filters.month));
  }

  async getCashFlow(filters: ReportFilters): Promise<Envelope<CashFlowRow[]>> {
    const { views, result } = await this.views();
    return this.wrap(views.cashflow(filters), result, views.resolveMonth(filters.month));
  }

  async getPnl(filters: ReportFilters): Promise<Envelope<PnlView>> {
    const { views, result } = await this.views();
    return this.wrap(views.pnl(), result, views.resolveMonth(filters.month));
  }

  async getMonthlySeries(filters: ReportFilters): Promise<Envelope<MonthlyMetrics[]>> {
    const { views, result } = await this.views();
    return this.wrap(views.series(), result, views.resolveMonth(filters.month));
  }

  async getForecast(filters: ReportFilters): Promise<Envelope<ForecastView>> {
    const { views, result } = await this.views();
    return this.wrap(views.forecast(), result, views.resolveMonth(filters.month));
  }

  async getInvestorPreview(filters: ReportFilters): Promise<Envelope<InvestorPreviewView>> {
    const { views, result } = await this.views();
    return this.wrap(views.investorPreview(filters), result, views.resolveMonth(filters.month));
  }

  async getSettings(): Promise<Envelope<SettingsView>> {
    const { views, result } = await this.views();
    return this.wrap(views.settings(), result, views.settingsPeriod());
  }

  async getAvailableMonths(): Promise<string[]> {
    const { views } = await this.views();
    return views.monthsWithData();
  }

  async getPlatforms(): Promise<string[]> {
    const { views } = await this.views();
    return views.platforms();
  }

  async getOperations(filters: ReportFilters) {
    const { views, result } = await this.views();
    return this.wrap(views.operations(filters), result, views.resolveMonth(filters.month));
  }

  async getInvestorRegister() {
    const { views, result } = await this.views();
    return this.wrap(views.investorRegister(), result, views.currentMonth());
  }

  async getPropertyIds(): Promise<string[]> {
    const { views } = await this.views();
    return views.propertyIds();
  }

  /**
   * Header metadata. Never throws: if the workbook cannot be read and nothing is cached,
   * the shell must still render and say the source is unavailable — a failed header is
   * how an operator ends up staring at a blank page with no explanation.
   */
  async getSourceMeta(): Promise<DataMeta> {
    try {
      const result = await this.source();
      const views = new WorkbookViews(result.value);
      return this.meta(result, views.currentMonth());
    } catch (error) {
      return {
        source: 'GOOGLE_SHEETS',
        asOf: this.lastSuccessfulSyncAt ?? this.now().toISOString(),
        period: '',
        freshness: 'ERROR',
        demo: false,
        lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
        cache: 'MISS',
        error: describeError(error instanceof Error ? error : new Error(String(error))),
      };
    }
  }

  /** Diagnostics for the operations/system screens. Contains no business data. */
  stats() {
    return { ...this.cache.stats(), lastSuccessfulSyncAt: this.lastSuccessfulSyncAt };
  }
}

/**
 * The source is unreachable and nothing usable is cached.
 *
 * Deliberately a distinct type: a page can distinguish "we cannot reach the workbook"
 * from "the workbook says zero", and the message never carries the spreadsheet id, the
 * service-account address or anything else that would be unhelpful on a shared screen.
 */
export class LiveDataUnavailableError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Live data is unavailable: the Google Sheets workbook could not be read, and no recent data is cached.');
    this.name = 'LiveDataUnavailableError';
    this.cause = cause;
  }
}

/** Short, non-sensitive summary of a fetch failure, safe to render. */
function describeError(error: Error): string {
  const message = error.message ?? String(error);
  if (/permission|403/i.test(message)) return 'The workbook is not shared with the service account.';
  if (/not found|404/i.test(message)) return 'The configured spreadsheet could not be found.';
  if (/quota|429/i.test(message)) return 'Google Sheets rate limit reached; retrying shortly.';
  return 'The workbook could not be read on the last attempt.';
}
