import { ReadOnlyPage, resolveFilters, type SearchParams } from '@/lib/shared/page-helpers';
import { BookingsWorkspace, type BookingScope } from '@/components/operations/BookingsWorkspace';
import { BookingDetailDrawer } from '@/components/operations/BookingDetailDrawer';
import { BookingActions } from '@/components/operations/BookingActions';
import {
  operationalReservationRows, operationalBookingDetail,
} from '@/lib/data/views/role-projections';
import { NewRecordButton } from '@/components/mutations/actions';
import { reservationFields, checkInFields, checkOutFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';
import { formatMonthLong } from '@/lib/shared/format';
import type { ReservationRow } from '@/lib/data/providers/types';

export const metadata = { title: 'Bookings — MAKAM Home Stays' };

async function NewBookingAction() {
  const provider = getDataProvider();
  const [propertyIds, platforms] = await Promise.all([
    provider.getPropertyIds(), provider.getPlatforms(),
  ]);
  return (
    <NewRecordButton
      label="+ New Booking"
      title="Create a booking"
      endpoint="/api/reservations"
      /*
       * NO MONEY FIELDS on this surface. OPERATIONS holds no financial capability, so a
       * role that may not read a booking's value does not author one either; the fields
       * are absent from the form, the payload and the browser rather than hidden. Booking
       * money is entered on the finance view of the same register.
       */
      fields={reservationFields(propertyIds, platforms, { withValues: false })}
      submitLabel="Create booking"
      successTemplate="{id} created — the workbook calculates the rest."
      idField="BookingID"
      wide
    />
  );
}

/**
 * Everything the workspace needs beyond its rows, fetched AFTER the capability check.
 *
 * This is a child of ReadOnlyPage rather than a call in the page body on purpose: the
 * page body runs before the guard, and a refused visitor must not cause a read on their
 * behalf — the same rule ReadOnlyPage applies to the main fetch.
 *
 * The operational day comes from the operations board, which already owns that
 * resolution (a malformed ?date= falls back there, once, for every screen). Nothing here
 * re-derives it, so the workspace's label and its rows cannot disagree.
 */
async function WorkspaceLoader({ rows, scope, params }: {
  rows: ReservationRow[];
  scope: BookingScope;
  params: SearchParams;
}) {
  const provider = getDataProvider();
  const filters = await resolveFilters(params);
  const requested = typeof params.booking === 'string' ? params.booking.trim() : '';

  const [units, board, detail] = await Promise.all([
    provider.getPropertyDirectory(),
    provider.getOperations(filters),
    /*
     * Resolved IN PROCESS, like every other read on this screen — no new HTTP endpoint,
     * and no month scoping, so a pasted link to a stay from another period still opens.
     * The lookup only runs when the URL actually asks for one.
     */
    requested ? provider.getBookingDetail(requested) : Promise.resolve(null),
  ]);

  const projected = detail?.data ? operationalBookingDetail(detail.data) : null;

  return (
    <BookingsWorkspace
      /* Projected for EVERY role: booking values and payout fields are stripped on the
         server, so no financial field reaches this screen or its client bundle. */
      rows={operationalReservationRows(rows)}
      units={units}
      scope={scope}
      date={board.data.date}
      isOperationalDay={board.data.isOperationalDay}
      periodLabel={formatMonthLong(filters.month)}
      month={filters.month}
      checkInFields={checkInFields()}
      checkOutFields={checkOutFields()}
      detail={requested ? (
        <BookingDetailDrawer
          /* Projected on the SERVER, unconditionally, exactly as the list is: there is
             no configuration of this screen — no role, no flag — in which a payout
             figure reaches the browser. A capability branch here would be the moment
             "Admin can see it anyway" put money on an operations surface. */
          detail={projected}
          requestedId={requested}
          actions={projected ? <BookingActions booking={projected} /> : undefined}
        />
      ) : undefined}
    />
  );
}

/**
 * BOOKINGS — the canonical front-office booking workspace.
 *
 * Operational by design, so the rows are projected for every role rather than branching
 * on capability: there is no configuration of this screen in which a payout figure
 * exists. The financial view of the same bookings is the Booking Ledger, under Finance.
 */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const scope: BookingScope = params.scope === 'in-progress' ? 'in-progress' : 'month';

  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Bookings"
      description="Every booking, with the next step on each one. Search, narrow by status, and check guests in and out."
      searchParams={params}
      filters={['month', 'property', 'platform']}
      fetcher={(p, f) => p.getReservations(f)}
      actions={<NewBookingAction />}
    >
      {(rows) => <WorkspaceLoader rows={rows} scope={scope} params={params} />}
    </ReadOnlyPage>
  );
}
