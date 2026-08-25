import '@/lib/server/only';
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
  provider: () => DashboardDataProvider,
): void {
  const resolve = async (request: ApiRequest) => {
    const p = provider();
    return { p, filters: await filtersFrom(p, request) };
  };

  router.register('GET', '/api/analytics/dashboard', async (ctx) => {
    const { p, filters } = await resolve(ctx.request);
    return p.getDashboard(filters);
  });

  // §7: "12-month block: revenue, expenses, profit, occupancy, ADR, RevPAR". That is the
  // monthly series whole — every field of it, rather than a subset chosen here, because a
  // handler that picks columns becomes a second definition of what the block contains.
  router.register('GET', '/api/analytics/timeseries', async (ctx) => {
    const { p, filters } = await resolve(ctx.request);
    return p.getMonthlySeries(filters);
  });

  router.register('GET', '/api/analytics/by-property', async (ctx) => {
    const { p, filters } = await resolve(ctx.request);
    return p.getProperties(filters);
  });

  // Per-platform performance lives inside the dashboard view, computed once for the same
  // period. Recomputing it here would be the duplication this layer exists to prevent.
  router.register('GET', '/api/analytics/by-platform', async (ctx) => {
    const { p, filters } = await resolve(ctx.request);
    const { data, meta } = await p.getDashboard(filters);
    return { data: data.platforms, meta };
  });
}
