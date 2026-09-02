import '@/lib/server/only';
import { requireTenant } from '@/lib/server/tenant/context';
import type { TenantProviderFactory } from './routes';
/**
 * FORECAST API — the HTTP surface for ARCHITECTURE §7's `GET /api/forecast/{...}`.
 *
 * These handlers orchestrate; they do not calculate. Every figure comes from
 * `provider.getForecast`, which runs the §9 engine through the same shaping layer the
 * Forecast screen renders. There is therefore exactly one implementation of the
 * forecast, and the API cannot disagree with the screen — a second implementation in a
 * route handler is precisely how two truths get born.
 *
 * The horizon is not a parameter. §9 forecasts the month ahead of the one being traded,
 * derived from the data's own as-of date, so there is no month to choose and none is
 * accepted. `data.monthKey` states which month the estimate is for; a caller never has
 * to infer it.
 *
 * All three of §7's paths are served. Cash flow carries no forecast-vs-actual, because
 * its estimate is a projected closing BALANCE and the monthly series records movements;
 * an empty list is the truthful answer, not an oversight.
 */
import type { ApiRouter } from './router';
import type {
  DashboardDataProvider, Envelope, ForecastView, ReportFilters,
} from '@/lib/data/providers/types';
import type {
  ForecastEstimate, ForecastAccuracy, ForecastHorizon,
} from '@/lib/server/analytics/forecast';

export interface ForecastResponse {
  /** The month being estimated — always the month after the one being traded. */
  monthKey: string;
  /**
   * The §9 estimate, whole and unedited: label, method, inputs, month count, confidence,
   * and `value: null` with a reason when the history cannot support a number.
   */
  estimate: ForecastEstimate;
  /** §9's retained forecast-vs-actual for THIS horizon, oldest first. */
  accuracy: ForecastAccuracy[];
}

/**
 * No filter is accepted. The forecast month comes from the data, and a `?month=` that
 * appeared to move it while changing nothing would be a lie told politely.
 */
const NO_FILTERS: ReportFilters = { month: '', propertyId: null, platform: null };

/** Slice one horizon out of the view, keeping the provider's envelope shape (§7). */
export function forecastResponse(
  envelope: Envelope<ForecastView>,
  horizon: ForecastHorizon,
): Envelope<ForecastResponse> {
  const { data, meta } = envelope;
  const estimate = horizon === 'occupancy' ? data.occupancy
    : horizon === 'revenue' ? data.revenue
      : data.cashflow;
  return {
    data: {
      monthKey: data.monthKey,
      estimate,
      accuracy: data.accuracy.filter((a) => a.horizon === horizon),
    },
    meta,
  };
}

/**
 * Bind the forecast reads to the router. The provider is resolved per request, not
 * captured: the demonstration environment swaps datasets underneath, and a handler
 * holding one instance would keep answering from the dataset that was current when the
 * process started.
 */
export function registerForecastHandlers(
  router: ApiRouter,
  provider: TenantProviderFactory,
): void {
  // Every one resolves its provider from the caller's own tenant.
  router.register('GET', '/api/forecast/occupancy', async (ctx) =>
    forecastResponse(
      await provider(requireTenant(ctx.auth, 'forecast.occupancy')).getForecast(NO_FILTERS),
      'occupancy'));
  router.register('GET', '/api/forecast/revenue', async (ctx) =>
    forecastResponse(
      await provider(requireTenant(ctx.auth, 'forecast.revenue')).getForecast(NO_FILTERS),
      'revenue'));
  router.register('GET', '/api/forecast/cashflow', async (ctx) =>
    forecastResponse(
      await provider(requireTenant(ctx.auth, 'forecast.cashflow')).getForecast(NO_FILTERS),
      'cashflow'));
}
