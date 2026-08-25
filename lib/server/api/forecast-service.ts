import '@/lib/server/only';
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
 * Cash flow (§7's third path) is deliberately not declared yet: it needs the per-platform
 * payout lag from Settings, and a route that cannot answer honestly is worse than one
 * that does not exist.
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
  return {
    data: {
      monthKey: data.monthKey,
      estimate: horizon === 'occupancy' ? data.occupancy : data.revenue,
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
  provider: () => DashboardDataProvider,
): void {
  router.register('GET', '/api/forecast/occupancy', async () =>
    forecastResponse(await provider().getForecast(NO_FILTERS), 'occupancy'));
  router.register('GET', '/api/forecast/revenue', async () =>
    forecastResponse(await provider().getForecast(NO_FILTERS), 'revenue'));
}
