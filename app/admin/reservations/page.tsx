import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { FinancialReservationsTable } from '@/components/pages/RegisterTables';
import { OpsReservationsTable } from '@/components/pages/OpsTables';
import { operationalReservationRows } from '@/lib/data/views/role-projections';
import { roleSeesFinancialFigures } from '@/lib/shared/roles';
import { NewRecordButton } from '@/components/mutations/actions';
import { reservationFields } from '@/lib/server/api/form-fields';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { getDataProvider } from '@/lib/data/providers';

export const metadata = { title: 'Booking Ledger — MAKAM Home Stays' };

/**
 * Create a booking WITH its values.
 *
 * The operations workspace deliberately offers no money fields — a role holding no
 * financial capability does not author a booking's value. But `reservation.update`
 * accepts no rate or fee either, so booking money can only ever be entered at creation:
 * removing it from the operations form without providing it here would have made a
 * booking's value unenterable through the product entirely.
 *
 * So it lives where money lives. Gated on a financial capability, checked on the SERVER
 * — for anyone else this renders nothing at all, and the API guard checks again on
 * submit regardless of what the page chose to draw.
 */
async function NewValuedBookingAction() {
  const access = await checkPageAccess('revenue.read');
  if (!access.allowed) return null;

  const provider = getDataProvider();
  const [propertyIds, platforms] = await Promise.all([
    provider.getPropertyIds(), provider.getPlatforms(),
  ]);
  return (
    <NewRecordButton
      label="+ New Booking"
      title="Create a booking, with its value"
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
 * THE BOOKING LEDGER — the financial view of the bookings register.
 *
 * The same rows the Bookings workspace works with, read for what they are worth: gross
 * value, expected payout, payout status. The working screen is
 * /admin/operations/reservations; this one is under Finance and is where a booking's
 * value is entered.
 *
 * A role with no financial capability may still open it directly — the capability is
 * `reservations.read`, because the underlying rows are the same — and gets the
 * OPERATIONAL projection: booking values and payout fields are stripped on the server
 * before render, and the screen says where the money lives instead of showing it.
 */
export default async function BookingLedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Booking Ledger"
      description={(viewer) => roleSeesFinancialFigures(viewer.role)
        ? 'What each booking is worth: gross value, expected payout and where the money has got to. Guest names are minimised in this list view — contact details are never shown here.'
        : 'Bookings arriving in the selected month. Guest names are minimised in this list view — payouts and revenue live on the finance screens.'}
      searchParams={params}
      fetcher={(provider, filters) => provider.getReservations(filters)}
      actions={<NewValuedBookingAction />}
    >
      {(rows, envelope, viewer) => (roleSeesFinancialFigures(viewer.role)
        ? <FinancialReservationsTable rows={rows} period={envelope.meta.period} />
        : <OpsReservationsTable rows={operationalReservationRows(rows)} />)}
    </ReadOnlyPage>
  );
}
