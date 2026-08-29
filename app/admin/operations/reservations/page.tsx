import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { OpsReservationsTable } from '@/components/pages/OpsTables';
import { operationalReservationRows } from '@/lib/data/views/role-projections';
import { NewRecordButton } from '@/components/mutations/actions';
import { reservationFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';

export const metadata = { title: 'Reservations — Operations — Srivillu Home Stays' };

async function NewReservationAction() {
  const provider = getDataProvider();
  const [propertyIds, platforms] = await Promise.all([
    provider.getPropertyIds(), provider.getPlatforms(),
  ]);
  return (
    <NewRecordButton
      label="+ New Reservation"
      title="Create a reservation"
      endpoint="/api/reservations"
      fields={reservationFields(propertyIds, platforms)}
      submitLabel="Create booking"
      successTemplate="{id} created — totals and payout are calculated by the workbook."
      idField="BookingID"
      wide
    />
  );
}

export default async function OpsReservationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Reservations"
      description="Create bookings and run the stay lifecycle: check in, check out, cancel. Financial detail lives on the finance screens."
      searchParams={params}
      filters={['month', 'property', 'platform']}
      fetcher={(provider, f) => provider.getReservations(f)}
      actions={<NewReservationAction />}
    >
      {/* Projected for EVERY role: this screen is operational by design, so booking
          values and payout fields are stripped server-side before anything renders. */}
      {(rows) => <OpsReservationsTable rows={operationalReservationRows(rows)} />}
    </ReadOnlyPage>
  );
}
