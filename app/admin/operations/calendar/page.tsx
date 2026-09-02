import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { AvailabilityCalendar } from '@/components/operations/AvailabilityCalendar';
import { BookingDetailDrawer } from '@/components/operations/BookingDetailDrawer';
import { BookingActions } from '@/components/operations/BookingActions';
import { operationalBookingDetail } from '@/lib/data/views/role-projections';
import { getDataProvider } from '@/lib/data/providers';
import { requireTenantContext } from '@/lib/server/auth/page-guard';
import type { CalendarView } from '@/lib/data/providers/types';

export const metadata = { title: 'Availability — MAKAM Home Stays' };

/**
 * The booking detail for `?booking=`, fetched AFTER the capability check.
 *
 * A child of ReadOnlyPage rather than a call in the page body: the body runs before the
 * guard, and a refused visitor must not cause a read on their behalf.
 *
 * This is the SAME panel, the same projection and the same actions the Bookings workspace
 * opens. A calendar with its own booking detail would be a second detail system to keep
 * in step, and the first thing to drift would be what it discloses.
 */
async function CalendarBody({ view, params }: { view: CalendarView; params: SearchParams }) {
  const requested = typeof params.booking === 'string' ? params.booking.trim() : '';
  const detail = requested
    ? (await (await getDataProvider(await requireTenantContext())).getBookingDetail(requested)).data
    : null;
  const projected = detail ? operationalBookingDetail(detail) : null;

  return (
    <AvailabilityCalendar
      view={view}
      detail={requested ? (
        <BookingDetailDrawer
          detail={projected}
          requestedId={requested}
          actions={projected ? <BookingActions booking={projected} /> : undefined}
        />
      ) : undefined}
    />
  );
}

/**
 * AVAILABILITY — where can I place this booking?
 *
 * Read-only, and derived entirely from bookings that already exist: there is no calendar
 * state anywhere, so nothing here can disagree with the register. Occupancy comes from
 * the one half-open interval the engine uses, so a day this screen calls free is a day
 * the occupancy figures also count as free.
 *
 * Guarded by `reservations.read` — the same capability as the Bookings workspace, because
 * it is the same booking data seen another way. INVESTOR holds it nowhere near, so an
 * investor is refused this screen exactly as they are refused the register.
 *
 * No projection branch and no money: the view model carries booking identity, dates and
 * status, and no financial field exists on it to withhold.
 */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Availability"
      description="Every unit against every day of the month. Open a booking to act on it, or pick a free day to place one."
      searchParams={params}
      /*
       * No month control here: this screen has its own, and the filter bar's select
       * lists only months that carry revenue — so the two would disagree the moment a
       * reader stepped forward into a month with no bookings yet.
       */
      filters={['property', 'platform']}
      /*
       * The month goes past `resolveFilters` deliberately. That helper clamps to months
       * carrying revenue, which is right for a P&L and fatal here: stepping to next month
       * silently snapped back to this one, so the control moved the URL and nothing else.
       * The raw value is still untrusted — `WorkbookViews.calendar` validates it with
       * `resolveMonthKey`, which rejects "2027-13" and anything malformed.
       */
      fetcher={(provider, filters) => provider.getCalendar({
        ...filters, month: params.month ?? '',
      })}
    >
      {(view) => <CalendarBody view={view} params={params} />}
    </ReadOnlyPage>
  );
}
