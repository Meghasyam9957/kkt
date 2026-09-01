import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { AvailabilitySearch } from '@/components/operations/AvailabilitySearch';
import { reservationFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';
import type { AvailabilitySearchView } from '@/lib/data/providers/types';

export const metadata = { title: 'Find a unit — MAKAM Home Stays' };

/**
 * The booking creation fields, fetched AFTER the capability check.
 *
 * A child of ReadOnlyPage rather than a call in the page body: the body runs before the
 * guard, and a refused visitor must not cause a read on their behalf.
 *
 * `withValues: false` is the same call the Bookings workspace makes — NO money fields, so
 * a role that may not read a booking's value does not author one either. The fields are
 * absent from the form, the payload and the browser rather than hidden.
 */
async function SearchBody({ view }: { view: AvailabilitySearchView }) {
  const provider = getDataProvider();
  const [propertyIds, platforms] = await Promise.all([
    provider.getPropertyIds(), provider.getPlatforms(),
  ]);

  return (
    <AvailabilitySearch
      view={view}
      bookingFields={reservationFields(propertyIds, platforms, { withValues: false })}
    />
  );
}

/**
 * FIND A UNIT — "I need a unit for these dates. Which ones are free?"
 *
 * The front desk's own question. The calendar answers it a month at a time; this answers
 * it a booking at a time, from the same bookings and the same half-open interval, so the
 * two can never disagree about who is in a unit.
 *
 * Guarded by `reservations.read` — the same capability as the Bookings workspace and the
 * calendar, because it is the same booking data seen a third way. INVESTOR holds it
 * nowhere near, so an investor is refused this screen exactly as they are refused the
 * register.
 *
 * NO FILTER BAR. The search panel IS the filter, and a month select beside a date range
 * is two controls for one question — the disagreement the calendar had to be rescued
 * from. The panel's own values are the URL, so a search is a link somebody can send.
 *
 * No projection branch and no money: the view model carries unit identity, capacity,
 * booking references and dates, and no financial field exists on it to withhold.
 */
export default async function AvailabilityPage({ searchParams }: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Find a unit"
      description="Search the dates a guest is asking for and see which units are free, which are held, and by whom."
      searchParams={params}
      showFilters={false}
      /*
       * The range goes straight to the view, untrusted. `resolveFilters` has nothing to
       * say about a stay range — it resolves a reporting month — and squeezing one into
       * the other is how the calendar's month control ended up moving the URL and
       * nothing else. `WorkbookViews.availability` validates every field and reports
       * what it rejected, in words, against the field that caused it.
       */
      fetcher={(provider) => provider.getAvailability({
        checkIn: params.checkin ?? null,
        checkOut: params.checkout ?? null,
        propertyId: params.property ?? null,
        guests: params.guests ?? null,
      })}
    >
      {(view) => <SearchBody view={view} />}
    </ReadOnlyPage>
  );
}
