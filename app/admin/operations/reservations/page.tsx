import { ReadOnlyPage, resolveFilters, type SearchParams } from '@/lib/shared/page-helpers';
import { BookingsWorkspace, type BookingScope } from '@/components/operations/BookingsWorkspace';
import { operationalReservationRows } from '@/lib/data/views/role-projections';
import { NewRecordButton } from '@/components/mutations/actions';
import {
  reservationFields, checkInFields, checkOutFields, cancelReservationFields,
} from '@/lib/server/api/form-fields';
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
      fields={reservationFields(propertyIds, platforms)}
      submitLabel="Create booking"
      successTemplate="{id} created — totals and payout are calculated by the workbook."
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
  const [units, board] = await Promise.all([
    provider.getPropertyDirectory(),
    provider.getOperations(filters),
  ]);

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
      checkInFields={checkInFields()}
      checkOutFields={checkOutFields()}
      cancelFields={cancelReservationFields()}
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
