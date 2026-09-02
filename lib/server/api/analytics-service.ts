import '@/lib/server/only';
import { requireTenant } from '@/lib/server/tenant/context';
import type { TenantProviderFactory } from './routes';
import type { HandlerContext } from '@/lib/server/auth/guard';
/**
 * ANALYTICS API — the HTTP surface for ARCHITECTURE §7's `GET /api/analytics/*`.
 *
 * Same shape as the forecast handlers and for the same reason: these orchestrate, they do
 * not calculate. Every figure comes from the provider, which runs the KPI engine through
 * the shaping layer the screens render, so an API caller and an operator looking at the
 * dashboard are reading one computation and not two.
 *
 * §7's filter conventions apply here — `?month=YYYY-MM`, `?propertyId=`, `?platform=` —
 * because unlike the forecast, these endpoints genuinely describe a chosen period.
 *
 * A month that carries no data falls back to the most recent one that does, exactly as
 * the screens do. `meta.period` always states which month was actually served, so the
 * fallback is visible rather than silent; a caller that must have a specific month can
 * compare the two.
 */
import type { ApiRouter } from './router';
import type { ApiRequest } from '@/lib/server/auth/guard';
import type { DashboardDataProvider, ReportFilters } from '@/lib/data/providers/types';

/** Query values arrive as `string | string[] | undefined`; only a single value is meaningful. */
function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Resolve §7's query conventions into the filter shape the provider expects.
 *
 * The month is validated against the months that actually carry data rather than trusted,
 * so a caller cannot steer a report at a period the workbook has nothing for.
 */
export async function filtersFrom(
  provider: DashboardDataProvider,
  request: ApiRequest,
): Promise<ReportFilters> {
  const months = await provider.getAvailableMonths();
  const requested = single(request.query?.month);
  const month = requested && months.includes(requested)
    ? requested
    : months[months.length - 1] ?? '';
  return {
    month,
    propertyId: single(request.query?.propertyId),
    platform: single(request.query?.platform),
  };
}

/**
 * Bind the analytics reads to the router. As with the forecast handlers, the provider is
 * resolved per request rather than captured, so a demonstration dataset switch is
 * reflected immediately.
 */
export function registerAnalyticsHandlers(
  router: ApiRouter,
  provider: TenantProviderFactory,
): void {
  /*
   * The provider is resolved from the CALLER's tenant, on every request. There is no
   * shared instance and no ambient tenant: two customers hitting the same route reach
   * two different providers over two different cache keys.
   */
  const resolve = async (ctx: { request: ApiRequest; auth: HandlerContext['auth'] }) => {
    const p = provider(requireTenant(ctx.auth, 'analytics handler'));
    return { p, filters: await filtersFrom(p, ctx.request) };
  };

  router.register('GET', '/api/analytics/dashboard', async (ctx) => {
    const { p, filters } = await resolve(ctx);
    return p.getDashboard(filters);
  });

  // §7: "12-month block: revenue, expenses, profit, occupancy, ADR, RevPAR". That is the
  // monthly series whole — every field of it, rather than a subset chosen here, because a
  // handler that picks columns becomes a second definition of what the block contains.
  router.register('GET', '/api/analytics/timeseries', async (ctx) => {
    const { p, filters } = await resolve(ctx);
    return p.getMonthlySeries(filters);
  });

  router.register('GET', '/api/analytics/by-property', async (ctx) => {
    const { p, filters } = await resolve(ctx);
    return p.getProperties(filters);
  });

  // Per-platform performance lives inside the dashboard view, computed once for the same
  // period. Recomputing it here would be the duplication this layer exists to prevent.
  router.register('GET', '/api/analytics/by-platform', async (ctx) => {
    const { p, filters } = await resolve(ctx);
    const { data, meta } = await p.getDashboard(filters);
    return { data: data.platforms, meta };
  });

  /*
   * Alerts are the operations board's urgent list — the same objects the Today screen and
   * the dashboard already render, in the same severity order, computed once in
   * `WorkbookViews.buildUrgent`. Projecting them out of the board rather than rebuilding
   * them is what keeps the API, the board and the shell's alert count from disagreeing
   * about how many things need a person today.
   *
   * The date they describe is the operations day, which comes from the data rather than
   * the clock — so this endpoint is as deterministic as the board it mirrors.
   */
  router.register('GET', '/api/analytics/alerts', async (ctx) => {
    const { p, filters } = await resolve(ctx);
    const { data, meta } = await p.getOperations(filters);
    return { data: data.urgent, meta };
  });
}
